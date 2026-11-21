import { useCallback, useEffect, useState } from 'react'
import {
  CalendarClock,
  CheckCircle2,
  Copy,
  ExternalLink,
  Flame,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Shield,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Wallet,
} from 'lucide-react'
import { SLOW_TIMEOUT_MS, api, del, post } from '../api'
import { regionLabel } from '../regions'
import type {
  AutoRenewInfo,
  InstanceDetail,
  PriceQuote,
  RenewalBalance,
  RenewalState,
  SecurityGroupDetail,
  Server,
} from '../types'
import { Badge, Modal, Segmented } from './ui'

const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  HKD: 'HK$',
  JPY: 'JP¥',
  EUR: '€',
}

function formatPrice(amount: number, currency: string): string {
  const sign = CURRENCY_SYMBOL[currency] ?? `${currency} `
  return `${sign}${amount.toFixed(2)}`
}

function formatIsoTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

function makeClientToken(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/* ============================================================================
   1. 包年包月续费与自动续费管理弹窗
   ========================================================================== */

const RENEW_MONTH_OPTIONS = [
  { value: 1, label: '1 个月' },
  { value: 2, label: '2 个月' },
  { value: 3, label: '3 个月' },
  { value: 6, label: '6 个月' },
  { value: 12, label: '1 年' },
  { value: 24, label: '2 年' },
  { value: 36, label: '3 年' },
  { value: 48, label: '4 年' },
  { value: 60, label: '5 年' },
]

const AUTORENEW_STATUS_OPTIONS: { value: 'AutoRenewal' | 'Normal' | 'NotRenewal'; label: string }[] = [
  { value: 'AutoRenewal', label: '自动续费' },
  { value: 'Normal', label: '手动续费' },
  { value: 'NotRenewal', label: '到期不续费' },
]

const AUTORENEW_DURATION_OPTIONS = [
  { value: 1, label: '每次 1 个月' },
  { value: 2, label: '每次 2 个月' },
  { value: 3, label: '每次 3 个月' },
  { value: 6, label: '每次 6 个月' },
  { value: 12, label: '每次 1 年' },
]

export function ServerRenewModal({
  server,
  onClose,
  onToast,
  onUpdated,
}: {
  server: Server
  onClose: () => void
  onToast: (message: string, tone?: 'success' | 'error' | 'info') => void
  onUpdated?: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [state, setState] = useState<RenewalState | null>(null)

  // Manual renewal state
  const [periodMonths, setPeriodMonths] = useState(1)
  const [quote, setQuote] = useState<PriceQuote | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState('')
  const [confirmPay, setConfirmPay] = useState(false)
  const [payBusy, setPayBusy] = useState(false)
  const [clientToken, setClientToken] = useState(() => makeClientToken('renew'))
  const [lastOrder, setLastOrder] = useState<{
    order_id: string
    period_label: string
    orders_url: string
  } | null>(null)

  // Auto-renewal settings
  const [autoStatus, setAutoStatus] = useState<'AutoRenewal' | 'Normal' | 'NotRenewal'>('Normal')
  const [autoDuration, setAutoDuration] = useState(1)
  const [autoBusy, setAutoBusy] = useState(false)
  const [autoError, setAutoError] = useState('')

  const copyText = useCallback(
    async (text: string, successMsg: string) => {
      try {
        await navigator.clipboard.writeText(text)
        onToast(successMsg, 'success')
      } catch {
        onToast(`复制失败，请手动复制：${text}`, 'info')
      }
    },
    [onToast],
  )

  const loadState = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api<RenewalState>(`/api/v1/servers/${server.id}/renewal`)
      setState(res)
      if (res.auto_renew) {
        const st = res.auto_renew.renewal_status
        setAutoStatus(st === 'AutoRenewal' || st === 'NotRenewal' ? st : 'Normal')
        if (res.auto_renew.period_unit === 'Year' && res.auto_renew.duration > 0) {
          setAutoDuration(res.auto_renew.duration * 12)
        } else if (res.auto_renew.duration > 0) {
          setAutoDuration(res.auto_renew.duration)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载续费信息失败')
    } finally {
      setLoading(false)
    }
  }, [server.id])

  const fetchPrice = useCallback(
    async (months: number) => {
      setQuoteLoading(true)
      setQuoteError('')
      setQuote(null)
      setConfirmPay(false)
      setClientToken(makeClientToken('renew'))
      try {
        const res = await post<{ quote: PriceQuote }>(
          `/api/v1/servers/${server.id}/renewal/price`,
          { period_months: months },
          SLOW_TIMEOUT_MS,
        )
        setQuote(res.quote)
      } catch (err) {
        setQuoteError(err instanceof Error ? err.message : '查询续费价格失败')
      } finally {
        setQuoteLoading(false)
      }
    },
    [server.id],
  )

  useEffect(() => {
    void loadState()
  }, [loadState])

  useEffect(() => {
    if (state?.supported) {
      void fetchPrice(periodMonths)
    }
  }, [state?.supported, periodMonths, fetchPrice])

  const periodLabel =
    periodMonths >= 12 && periodMonths % 12 === 0
      ? `${periodMonths / 12} 年`
      : `${periodMonths} 个月`
  const balance = state?.balance ?? null
  const sameCurrency =
    balance != null &&
    quote != null &&
    balance.currency.toUpperCase() === quote.currency.toUpperCase()
  const shortfall =
    sameCurrency && balance && quote && balance.amount < quote.trade_price
      ? Number((quote.trade_price - balance.amount).toFixed(2))
      : 0

  async function handleRenewPay() {
    if (!quote || !confirmPay) return
    setPayBusy(true)
    setQuoteError('')
    try {
      const res = await post<{
        ok: boolean
        order_id: string
        expired_time: string
        balance?: RenewalBalance | null
        orders_url?: string
      }>(
        `/api/v1/servers/${server.id}/renewal/pay`,
        {
          period_months: periodMonths,
          confirm_pay: true,
          client_token: clientToken,
        },
        SLOW_TIMEOUT_MS,
      )
      onToast(
        `续费下单成功${res.order_id ? `（订单 ${res.order_id}）` : ''}`,
        'success',
      )
      setLastOrder({
        order_id: res.order_id || '',
        period_label: periodLabel,
        orders_url: res.orders_url || state?.console_urls?.orders_url || '',
      })
      setConfirmPay(false)
      setClientToken(makeClientToken('renew'))
      setState((prev) =>
        prev
          ? {
              ...prev,
              expired_time: res.expired_time || prev.expired_time,
              balance: res.balance !== undefined ? res.balance : prev.balance,
            }
          : prev,
      )
      if (!res.expired_time) {
        void loadState()
      }
      onUpdated?.()
    } catch (err) {
      setQuoteError(err instanceof Error ? err.message : '续费失败')
    } finally {
      setPayBusy(false)
    }
  }

  async function handleSaveAutoRenew() {
    setAutoBusy(true)
    setAutoError('')
    try {
      const isYear = autoDuration >= 12 && autoDuration % 12 === 0
      const res = await post<{ ok: boolean; auto_renew: AutoRenewInfo | null }>(
        `/api/v1/servers/${server.id}/renewal/auto`,
        {
          renewal_status: autoStatus,
          duration: isYear ? autoDuration / 12 : autoDuration,
          period_unit: isYear ? 'Year' : 'Month',
        },
        SLOW_TIMEOUT_MS,
      )
      if (res.auto_renew) {
        setState((prev) => (prev ? { ...prev, auto_renew: res.auto_renew } : prev))
      }
      onToast('自动续费设置已更新', 'success')
      onUpdated?.()
    } catch (err) {
      setAutoError(err instanceof Error ? err.message : '更新自动续费设置失败')
    } finally {
      setAutoBusy(false)
    }
  }

  return (
    <Modal
      wide
      title={`续费管理 · ${server.label || server.instance_id}`}
      icon={<CalendarClock size={16} style={{ color: 'var(--accent)' }} />}
      onClose={() => !payBusy && !autoBusy && onClose()}
      footer={
        <>
          <button
            type="button"
            className="btn ghost sm"
            disabled={loading || payBusy || autoBusy}
            onClick={() => void loadState()}
          >
            {loading ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />} 刷新状态
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn primary sm"
            disabled={payBusy || autoBusy}
            onClick={onClose}
          >
            关闭
          </button>
        </>
      }
    >
      {loading ? (
        <div className="manage-center">
          <LoaderCircle size={20} className="spin" />
          <span>正在读取实例计费与到期信息…</span>
        </div>
      ) : error ? (
        <div className="auth-error">
          <TriangleAlert size={14} />
          {error}
        </div>
      ) : !state ? null : !state.supported ? (
        <div className="ops-section">
          <div className="img-notice info">
            <CalendarClock size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <strong>{state.instance_charge_type === 'PostPaid' ? '按量付费实例' : state.instance_charge_type}</strong>
              <div>{state.reason}</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="ops-stack">
          <div className="img-account-bar" style={{ marginBottom: 0 }}>
            <div className="img-account-meta">
              <span>
                实例：<code className="mono">{state.instance_id}</code>
              </span>
              <span>
                计费：<Badge tone="blue">包年包月</Badge>
              </span>
              <span>
                到期时间：<strong>{formatIsoTime(state.expired_time)}</strong>
              </span>
              {balance && (
                <span>
                  账户余额：<strong>{formatPrice(balance.amount, balance.currency)}</strong>
                </span>
              )}
            </div>
            {state.auto_renew && (
              <Badge
                tone={
                  state.auto_renew.renewal_status === 'AutoRenewal'
                    ? 'green'
                    : state.auto_renew.renewal_status === 'NotRenewal'
                      ? 'red'
                      : 'gray'
                }
              >
                {state.auto_renew.renewal_status === 'AutoRenewal'
                  ? `已开启自动续费（${state.auto_renew.duration} ${state.auto_renew.period_unit === 'Year' ? '年' : '个月'}）`
                  : state.auto_renew.renewal_status === 'NotRenewal'
                    ? '已设为到期不续费'
                    : '未开启自动续费'}
              </Badge>
            )}
          </div>

          {/* 手动续费（先询价再二次确认） */}
          <div className="ops-card">
            <div className="ops-card-head">
              <strong>手动续费（实时询价）</strong>
              <span className="hint" style={{ margin: 0 }}>
                API 续费直扣阿里云账户余额 / 信用额度；扫码支付请前往官方收银台
              </span>
            </div>
            <div className="ops-period-grid">
              {RENEW_MONTH_OPTIONS.map((opt) => (
                <button
                  type="button"
                  key={opt.value}
                  className={`ops-period-btn${periodMonths === opt.value ? ' active' : ''}`}
                  disabled={payBusy}
                  onClick={() => setPeriodMonths(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {quoteLoading ? (
              <div className="manage-center compact">
                <LoaderCircle size={14} className="spin" />
                <span>正在向阿里云查询实时续费价格…</span>
              </div>
            ) : quoteError ? (
              <div className="auth-error">
                <TriangleAlert size={13} />
                {quoteError}
              </div>
            ) : quote ? (
              <div className="price-quote-box">
                <div className="price-quote-row">
                  <span>原价</span>
                  <span>{formatPrice(quote.original_price, quote.currency)}</span>
                </div>
                {quote.discount_price > 0 && (
                  <div className="price-quote-row">
                    <span>优惠减免</span>
                    <span className="price-discount">
                      -{formatPrice(quote.discount_price, quote.currency)}
                    </span>
                  </div>
                )}
                <div className="price-quote-row total">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    实付续费金额
                    {quote.estimated && <Badge tone="blue">参考估算</Badge>}
                  </span>
                  <strong>{formatPrice(quote.trade_price, quote.currency)}</strong>
                </div>
                {balance && sameCurrency && (
                  <div className={`price-quote-balance${shortfall > 0 ? ' warn' : ' ok'}`}>
                    <Wallet size={12} style={{ flexShrink: 0 }} />
                    {shortfall > 0 ? (
                      <span>
                        当前账户余额 {formatPrice(balance.amount, balance.currency)}，差额{' '}
                        <strong>{formatPrice(shortfall, balance.currency)}</strong>
                        （若无代金券/信用额度，建议前往阿里云收银台支付或先充值）
                      </span>
                    ) : (
                      <span>
                        当前账户余额 {formatPrice(balance.amount, balance.currency)}，余额充足可直接扣费续费
                      </span>
                    )}
                  </div>
                )}
                {quote.rules.length > 0 && (
                  <div className="price-quote-rules">{quote.rules.join('；')}</div>
                )}
                {quote.note && <div className="price-quote-rules">{quote.note}</div>}
              </div>
            ) : null}

            {lastOrder && (
              <div className="renew-order-ok">
                <CheckCircle2 size={14} style={{ flexShrink: 0 }} />
                <div className="renew-order-ok-body">
                  <span>
                    已提交 <strong>{lastOrder.period_label}</strong> 续费订单
                    {lastOrder.order_id ? (
                      <>
                        ：<code className="mono">{lastOrder.order_id}</code>
                      </>
                    ) : null}
                  </span>
                </div>
                <div className="renew-pay-links">
                  {lastOrder.order_id && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => void copyText(lastOrder.order_id, '已复制订单号')}
                    >
                      <Copy size={12} /> 复制单号
                    </button>
                  )}
                  {lastOrder.orders_url && (
                    <a
                      className="btn ghost sm"
                      href={lastOrder.orders_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={12} /> 订单中心
                    </a>
                  )}
                </div>
              </div>
            )}

            <label className="img-delete-force" style={{ marginTop: 0 }}>
              <input
                type="checkbox"
                checked={confirmPay}
                disabled={!quote || quoteLoading || payBusy}
                onChange={(event) => setConfirmPay(event.target.checked)}
              />
              <span>
                我已核对以上续费时长（{periodLabel}）与金额
                {quote
                  ? `（${quote.estimated ? '约 ' : ''}${formatPrice(quote.trade_price, quote.currency)}）`
                  : ''}
                ，确认从阿里云账户余额 / 信用额度直接扣费续费
              </span>
            </label>

            <div className="ops-card-foot">
              <button
                type="button"
                className="btn ghost sm"
                disabled={quoteLoading || payBusy}
                onClick={() => void fetchPrice(periodMonths)}
              >
                <RefreshCw size={12} /> 重新询价
              </button>
              <button
                type="button"
                className="btn primary sm"
                disabled={!quote || !confirmPay || payBusy}
                onClick={() => void handleRenewPay()}
              >
                {payBusy ? <LoaderCircle size={12} className="spin" /> : <CheckCircle2 size={12} />}
                确认余额扣费续费
              </button>
            </div>

            {state.console_urls && (
              <div className="renew-pay-bar">
                <span className="renew-pay-note">
                  需要支付宝 / 微信扫码付款？阿里云 ECS 续费 API 不支持直接生成待支付付款码，可跳转官方收银台完成支付：
                </span>
                <div className="renew-pay-links">
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() =>
                      void copyText(
                        state.instance_id,
                        '已复制实例 ID，可在阿里云续费页面粘贴搜索',
                      )
                    }
                  >
                    <Copy size={12} /> 复制实例 ID
                  </button>
                  <a
                    className="btn ghost sm"
                    href={state.console_urls.renew_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={12} /> 阿里云续费收银台
                  </a>
                  <a
                    className="btn ghost sm"
                    href={state.console_urls.recharge_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Wallet size={12} /> 账户充值
                  </a>
                  <a
                    className="btn ghost sm"
                    href={state.console_urls.orders_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={12} /> 我的订单
                  </a>
                </div>
              </div>
            )}
          </div>

          {/* 自动续费设置 */}
          <div className="ops-card">
            <div className="ops-card-head">
              <strong>自动续费策略</strong>
              <span className="hint" style={{ margin: 0 }}>
                阿里云在实例到期前第 9 天自动扣费续期
              </span>
            </div>
            <div className="ops-auto-row">
              <Segmented
                value={autoStatus}
                options={AUTORENEW_STATUS_OPTIONS}
                onChange={setAutoStatus}
              />
              {autoStatus === 'AutoRenewal' && (
                <select
                  className="select"
                  value={String(autoDuration)}
                  disabled={autoBusy}
                  onChange={(event) => setAutoDuration(Number(event.target.value))}
                  style={{ maxWidth: 160 }}
                >
                  {AUTORENEW_DURATION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={String(opt.value)}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="btn sm primary"
                disabled={autoBusy}
                onClick={() => void handleSaveAutoRenew()}
              >
                {autoBusy ? <LoaderCircle size={12} className="spin" /> : null}
                保存策略
              </button>
            </div>
            {autoError && (
              <div className="auth-error">
                <TriangleAlert size={13} />
                {autoError}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

/* ============================================================================
   2. 服务器高级运维弹窗（改密/改名、安全组端口、释放云端实例）
   ========================================================================== */

type OpsTab = 'attr' | 'sg' | 'release'

const OPS_TABS: { value: OpsTab; label: string }[] = [
  { value: 'attr', label: '改密 / 改名' },
  { value: 'sg', label: '安全组端口' },
  { value: 'release', label: '释放实例' },
]

const SG_QUICK_PRESETS: {
  label: string
  protocol: 'TCP' | 'UDP' | 'ICMP' | 'ALL'
  portRange: string
  desc: string
}[] = [
  { label: 'SSH (22)', protocol: 'TCP', portRange: '22/22', desc: 'SSH' },
  { label: 'HTTP (80)', protocol: 'TCP', portRange: '80/80', desc: 'HTTP' },
  { label: 'HTTPS (443)', protocol: 'TCP', portRange: '443/443', desc: 'HTTPS' },
  { label: 'RDP (3389)', protocol: 'TCP', portRange: '3389/3389', desc: 'RDP' },
  { label: 'Ping (ICMP)', protocol: 'ICMP', portRange: '-1/-1', desc: 'ICMP Ping' },
  { label: '全部 TCP', protocol: 'TCP', portRange: '1/65535', desc: 'All TCP' },
]

export function ServerOpsModal({
  server,
  initialTab = 'attr',
  onClose,
  onToast,
  onUpdated,
}: {
  server: Server
  initialTab?: OpsTab
  onClose: () => void
  onToast: (message: string, tone?: 'success' | 'error' | 'info') => void
  onUpdated: () => void
}) {
  const [tab, setTab] = useState<OpsTab>(initialTab)
  const [detail, setDetail] = useState<InstanceDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(true)
  const [detailError, setDetailError] = useState('')

  // Tab 1: Modify attributes
  const [instanceName, setInstanceName] = useState('')
  const [syncLabel, setSyncLabel] = useState(true)
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [rebootAfter, setRebootAfter] = useState(true)
  const [delProtection, setDelProtection] = useState<boolean | null>(null)
  const [attrBusy, setAttrBusy] = useState(false)
  const [attrError, setAttrError] = useState('')

  // Tab 2: Security group rules
  const [sgList, setSgList] = useState<SecurityGroupDetail[]>([])
  const [sgLoading, setSgLoading] = useState(false)
  const [sgError, setSgError] = useState('')
  const [selectedSgId, setSelectedSgId] = useState('')
  const [sgDirFilter, setSgDirFilter] = useState<'ingress' | 'egress'>('ingress')
  const [ruleProtocol, setRuleProtocol] = useState<'TCP' | 'UDP' | 'ICMP' | 'ALL'>('TCP')
  const [rulePort, setRulePort] = useState('22')
  const [ruleCidr, setRuleCidr] = useState('0.0.0.0/0')
  const [rulePolicy, setRulePolicy] = useState<'accept' | 'drop'>('accept')
  const [rulePriority, setRulePriority] = useState('1')
  const [ruleDesc, setRuleDesc] = useState('')
  const [sgBusy, setSgBusy] = useState('')

  // Tab 3: Release instance
  const [confirmInstanceId, setConfirmInstanceId] = useState('')
  const [releaseForce, setReleaseForce] = useState(true)
  const [releaseRemovePanel, setReleaseRemovePanel] = useState(true)
  const [releaseAck, setReleaseAck] = useState(false)
  const [releaseBusy, setReleaseBusy] = useState(false)
  const [releaseError, setReleaseError] = useState('')

  const loadDetail = useCallback(async () => {
    setDetailLoading(true)
    setDetailError('')
    try {
      const res = await api<{ detail: InstanceDetail }>(`/api/v1/servers/${server.id}/detail`)
      setDetail(res.detail)
      setInstanceName(res.detail.instance_name || '')
      setDelProtection(Boolean(res.detail.deletion_protection))
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : '加载实例详情失败')
    } finally {
      setDetailLoading(false)
    }
  }, [server.id])

  const loadSecurityGroups = useCallback(async () => {
    setSgLoading(true)
    setSgError('')
    try {
      const res = await api<{ security_groups: SecurityGroupDetail[] }>(
        `/api/v1/servers/${server.id}/security-groups`,
        { timeoutMs: SLOW_TIMEOUT_MS },
      )
      const list = res.security_groups ?? []
      setSgList(list)
      setSelectedSgId((prev) =>
        prev && list.some((s) => s.security_group_id === prev)
          ? prev
          : list[0]?.security_group_id || '',
      )
    } catch (err) {
      setSgError(err instanceof Error ? err.message : '加载安全组规则失败')
    } finally {
      setSgLoading(false)
    }
  }, [server.id])

  useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  useEffect(() => {
    if (tab === 'sg' && sgList.length === 0 && !sgLoading) {
      void loadSecurityGroups()
    }
  }, [tab, sgList.length, sgLoading, loadSecurityGroups])

  async function submitAttributes() {
    setAttrError('')
    const trimmedName = instanceName.trim()
    const nameChanged = Boolean(trimmedName && trimmedName !== (detail?.instance_name || ''))
    const pwdChanged = Boolean(password)
    const protChanged =
      delProtection !== null &&
      detail !== null &&
      delProtection !== Boolean(detail.deletion_protection)

    if (!nameChanged && !pwdChanged && !protChanged) {
      setAttrError('未检测到修改项：请修改实例名、输入新密码或调整释放保护')
      return
    }
    if (pwdChanged) {
      if (password !== passwordConfirm) {
        setAttrError('两次输入的新密码不一致')
        return
      }
      if (password.length < 8 || password.length > 30) {
        setAttrError('密码长度需为 8–30 位，并含大小写字母、数字、特殊符号中的三类')
        return
      }
    }

    setAttrBusy(true)
    try {
      const payload: Record<string, unknown> = {}
      if (nameChanged) {
        payload['instance_name'] = trimmedName
        payload['sync_label'] = syncLabel
      }
      if (pwdChanged) {
        payload['password'] = password
        payload['reboot_after'] = rebootAfter
      }
      if (protChanged) {
        payload['deletion_protection'] = delProtection
      }
      const res = await post<{ ok: boolean; rebooted: boolean }>(
        `/api/v1/servers/${server.id}/attribute`,
        payload,
        SLOW_TIMEOUT_MS,
      )
      setPassword('')
      setPasswordConfirm('')
      onToast(
        pwdChanged
          ? res.rebooted
            ? '属性已更新，并已触发实例重启使新密码生效'
            : '属性已更新（新密码需通过面板/阿里云控制台重启实例后生效）'
          : '实例属性已更新',
        'success',
      )
      await loadDetail()
      onUpdated()
    } catch (err) {
      setAttrError(err instanceof Error ? err.message : '修改实例属性失败')
    } finally {
      setAttrBusy(false)
    }
  }

  async function addSecurityRule(opts?: {
    protocol: 'TCP' | 'UDP' | 'ICMP' | 'ALL'
    portRange: string
    desc: string
  }) {
    if (!selectedSgId) return
    const protocol = opts ? opts.protocol : ruleProtocol
    const port = opts ? opts.portRange : protocol === 'ICMP' || protocol === 'ALL' ? '-1/-1' : rulePort
    const cidr = opts ? '0.0.0.0/0' : ruleCidr.trim() || '0.0.0.0/0'
    const policy = opts ? 'accept' : rulePolicy
    const priority = opts ? 1 : Math.min(100, Math.max(1, Number(rulePriority) || 1))
    const description = opts ? opts.desc : ruleDesc.trim()

    setSgBusy('add')
    setSgError('')
    try {
      const res = await post<{ ok: boolean; security_group: SecurityGroupDetail }>(
        `/api/v1/servers/${server.id}/security-groups/${encodeURIComponent(selectedSgId)}/rules`,
        {
          direction: sgDirFilter,
          ip_protocol: protocol,
          port_range: port,
          cidr_ip: cidr,
          policy,
          priority,
          description,
        },
        SLOW_TIMEOUT_MS,
      )
      setSgList((prev) =>
        prev.map((sg) =>
          sg.security_group_id === selectedSgId ? res.security_group : sg,
        ),
      )
      if (!opts) setRuleDesc('')
      onToast(`已添加安全组规则（${protocol} ${port}）`, 'success')
    } catch (err) {
      setSgError(err instanceof Error ? err.message : '添加安全组规则失败')
    } finally {
      setSgBusy('')
    }
  }

  async function deleteSecurityRule(ruleId: string, direction: 'ingress' | 'egress') {
    if (!selectedSgId || !ruleId) return
    setSgBusy(`del:${ruleId}`)
    setSgError('')
    try {
      const res = await del<{ ok: boolean; security_group: SecurityGroupDetail }>(
        `/api/v1/servers/${server.id}/security-groups/${encodeURIComponent(selectedSgId)}/rules/${encodeURIComponent(ruleId)}?direction=${direction}`,
        SLOW_TIMEOUT_MS,
      )
      setSgList((prev) =>
        prev.map((sg) =>
          sg.security_group_id === selectedSgId ? res.security_group : sg,
        ),
      )
      onToast('已删除安全组规则', 'success')
    } catch (err) {
      setSgError(err instanceof Error ? err.message : '删除安全组规则失败')
    } finally {
      setSgBusy('')
    }
  }

  async function submitRelease() {
    setReleaseError('')
    if (confirmInstanceId.trim() !== server.instance_id) {
      setReleaseError(`请完整输入实例 ID「${server.instance_id}」以确认`)
      return
    }
    if (!releaseAck) {
      setReleaseError('请先勾选不可恢复风险确认')
      return
    }
    setReleaseBusy(true)
    try {
      await post<{ ok: boolean; removed_from_panel: boolean }>(
        `/api/v1/servers/${server.id}/release`,
        {
          confirm_instance_id: confirmInstanceId.trim(),
          force: releaseForce,
          terminate_subscription: detail?.instance_charge_type === 'PrePaid',
          remove_from_panel: releaseRemovePanel,
        },
        SLOW_TIMEOUT_MS,
      )
      onToast(
        releaseRemovePanel
          ? `已释放云端实例 ${server.instance_id} 并从本面板移除`
          : `已向阿里云提交释放指令（${server.instance_id}）`,
        'success',
      )
      onUpdated()
      onClose()
    } catch (err) {
      setReleaseError(err instanceof Error ? err.message : '释放实例失败')
    } finally {
      setReleaseBusy(false)
    }
  }

  const activeSg = sgList.find((sg) => sg.security_group_id === selectedSgId) ?? null
  const filteredRules = (activeSg?.rules ?? []).filter((r) => r.direction === sgDirFilter)
  const isPrePaid = detail?.instance_charge_type === 'PrePaid'
  const isManagedActive = Boolean(server.managed?.active)

  return (
    <Modal
      wide
      title={`实例运维 · ${server.label || server.instance_id}`}
      icon={<SlidersHorizontal size={16} style={{ color: 'var(--accent)' }} />}
      onClose={() => !attrBusy && !releaseBusy && onClose()}
      footer={
        <>
          <span className="hint" style={{ margin: 0 }}>
            {regionLabel(server.region_id)} · <code className="mono">{server.instance_id}</code>
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn primary sm"
            disabled={attrBusy || releaseBusy}
            onClick={onClose}
          >
            关闭
          </button>
        </>
      }
    >
      <div className="img-toolbar">
        <Segmented value={tab} options={OPS_TABS} onChange={setTab} />
        <button
          type="button"
          className="btn ghost sm"
          disabled={detailLoading || sgLoading}
          onClick={() => {
            if (tab === 'sg') {
              void loadSecurityGroups()
            } else {
              void loadDetail()
            }
          }}
        >
          {detailLoading || sgLoading ? (
            <LoaderCircle size={12} className="spin" />
          ) : (
            <RefreshCw size={12} />
          )}{' '}
          刷新
        </button>
      </div>

      {tab === 'attr' && (
        <div className="ops-stack">
          {detailLoading ? (
            <div className="manage-center compact">
              <LoaderCircle size={15} className="spin" />
              <span>正在读取当前实例属性…</span>
            </div>
          ) : detailError ? (
            <div className="auth-error">
              <TriangleAlert size={13} />
              {detailError}
            </div>
          ) : (
            <>
              <div className="ops-card">
                <div className="ops-card-head">
                  <strong>修改实例名称</strong>
                </div>
                <div className="field" style={{ marginBottom: 6 }}>
                  <label htmlFor="ops-inst-name">阿里云实例名称</label>
                  <input
                    id="ops-inst-name"
                    className="input"
                    value={instanceName}
                    disabled={attrBusy}
                    onChange={(event) => setInstanceName(event.target.value)}
                    placeholder="2–128 位，字母或中文开头"
                  />
                </div>
                <label className="img-delete-force" style={{ marginTop: 0 }}>
                  <input
                    type="checkbox"
                    checked={syncLabel}
                    disabled={attrBusy}
                    onChange={(event) => setSyncLabel(event.target.checked)}
                  />
                  <span>同时将本面板里的服务器显示名称更新为一致</span>
                </label>
              </div>

              <div className="ops-card">
                <div className="ops-card-head">
                  <strong>
                    <KeyRound size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                    重置实例登录密码
                  </strong>
                  <span className="hint" style={{ margin: 0 }}>
                    留空则不修改密码
                  </span>
                </div>
                <div className="grid-2">
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor="ops-pwd">新密码（8–30 位）</label>
                    <input
                      id="ops-pwd"
                      type="password"
                      className="input"
                      value={password}
                      disabled={attrBusy}
                      autoComplete="new-password"
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="大小写字母/数字/符号至少三类"
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor="ops-pwd2">确认新密码</label>
                    <input
                      id="ops-pwd2"
                      type="password"
                      className="input"
                      value={passwordConfirm}
                      disabled={attrBusy}
                      autoComplete="new-password"
                      onChange={(event) => setPasswordConfirm(event.target.value)}
                      placeholder="再次输入新密码"
                    />
                  </div>
                </div>
                <label className="img-delete-force" style={{ marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={rebootAfter}
                    disabled={attrBusy}
                    onChange={(event) => setRebootAfter(event.target.checked)}
                  />
                  <span>修改密码后立即通过阿里云 API 重启运行中的实例（新密码仅在控制台/API 重启后生效）</span>
                </label>
              </div>

              {detail?.instance_charge_type === 'PostPaid' && delProtection !== null && (
                <div className="ops-card">
                  <div className="ops-card-head">
                    <strong>按量实例释放保护</strong>
                  </div>
                  <label className="img-delete-force" style={{ marginTop: 0 }}>
                    <input
                      type="checkbox"
                      checked={delProtection}
                      disabled={attrBusy}
                      onChange={(event) => setDelProtection(event.target.checked)}
                    />
                    <span>开启释放保护（开启后无法通过控制台或 API 误删实例）</span>
                  </label>
                </div>
              )}

              {attrError && (
                <div className="auth-error">
                  <TriangleAlert size={13} />
                  {attrError}
                </div>
              )}

              <div className="ops-card-foot">
                <button
                  type="button"
                  className="btn primary sm"
                  disabled={attrBusy}
                  onClick={() => void submitAttributes()}
                >
                  {attrBusy ? <LoaderCircle size={12} className="spin" /> : null}
                  保存实例属性
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'sg' && (
        <div className="ops-stack">
          {sgLoading ? (
            <div className="manage-center">
              <LoaderCircle size={18} className="spin" />
              <span>正在读取实例安全组规则…</span>
            </div>
          ) : sgList.length === 0 ? (
            <div className="manage-center">
              <Shield size={18} style={{ opacity: 0.45 }} />
              <span>{sgError || '未查询到该实例关联的安全组。'}</span>
            </div>
          ) : (
            <>
              <div className="ops-sg-bar">
                <select
                  className="select"
                  value={selectedSgId}
                  onChange={(event) => setSelectedSgId(event.target.value)}
                  style={{ maxWidth: 320 }}
                >
                  {sgList.map((sg) => (
                    <option key={sg.security_group_id} value={sg.security_group_id}>
                      {sg.security_group_name || sg.security_group_id}（{sg.security_group_id}）
                    </option>
                  ))}
                </select>
                <Segmented
                  value={sgDirFilter}
                  options={[
                    { value: 'ingress', label: '入方向（外部访问本机）' },
                    { value: 'egress', label: '出方向（本机访问外部）' },
                  ]}
                  onChange={setSgDirFilter}
                />
              </div>

              {sgDirFilter === 'ingress' && (
                <div className="ops-preset-bar">
                  <span className="hint" style={{ margin: 0 }}>
                    一键放行（0.0.0.0/0）：
                  </span>
                  {SG_QUICK_PRESETS.map((preset) => (
                    <button
                      type="button"
                      key={preset.label}
                      className="btn ghost sm"
                      disabled={Boolean(sgBusy)}
                      onClick={() => void addSecurityRule(preset)}
                    >
                      <Plus size={11} /> {preset.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="ops-card">
                <div className="ops-card-head">
                  <strong>新增{sgDirFilter === 'ingress' ? '入方向' : '出方向'}规则</strong>
                </div>
                <div className="ops-sg-form">
                  <select
                    className="select"
                    value={ruleProtocol}
                    disabled={Boolean(sgBusy)}
                    onChange={(event) =>
                      setRuleProtocol(event.target.value as 'TCP' | 'UDP' | 'ICMP' | 'ALL')
                    }
                  >
                    <option value="TCP">TCP</option>
                    <option value="UDP">UDP</option>
                    <option value="ICMP">ICMP</option>
                    <option value="ALL">ALL</option>
                  </select>
                  <input
                    className="input mono"
                    value={ruleProtocol === 'ICMP' || ruleProtocol === 'ALL' ? '-1/-1' : rulePort}
                    disabled={Boolean(sgBusy) || ruleProtocol === 'ICMP' || ruleProtocol === 'ALL'}
                    onChange={(event) => setRulePort(event.target.value)}
                    placeholder="端口，如 22 或 8000/9000"
                  />
                  <input
                    className="input mono"
                    value={ruleCidr}
                    disabled={Boolean(sgBusy)}
                    onChange={(event) => setRuleCidr(event.target.value)}
                    placeholder="0.0.0.0/0"
                  />
                  <select
                    className="select"
                    value={rulePolicy}
                    disabled={Boolean(sgBusy)}
                    onChange={(event) => setRulePolicy(event.target.value as 'accept' | 'drop')}
                  >
                    <option value="accept">允许</option>
                    <option value="drop">拒绝</option>
                  </select>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={100}
                    value={rulePriority}
                    disabled={Boolean(sgBusy)}
                    onChange={(event) => setRulePriority(event.target.value)}
                    title="优先级 1–100（越小越优先）"
                  />
                  <input
                    className="input"
                    value={ruleDesc}
                    disabled={Boolean(sgBusy)}
                    onChange={(event) => setRuleDesc(event.target.value)}
                    placeholder="备注（可选）"
                  />
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={Boolean(sgBusy)}
                    onClick={() => void addSecurityRule()}
                  >
                    {sgBusy === 'add' ? <LoaderCircle size={12} className="spin" /> : <Plus size={12} />}
                    添加
                  </button>
                </div>
              </div>

              {sgError && (
                <div className="auth-error">
                  <TriangleAlert size={13} />
                  {sgError}
                </div>
              )}

              <div className="disk-table-wrap ops-sg-table-wrap">
                <table className="disk-table">
                  <thead>
                    <tr>
                      <th>策略</th>
                      <th>协议</th>
                      <th>端口范围</th>
                      <th>{sgDirFilter === 'ingress' ? '授权来源' : '目标网段'}</th>
                      <th>优先级</th>
                      <th>备注</th>
                      <th style={{ textAlign: 'right' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRules.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)' }}>
                          当前方向暂无规则
                        </td>
                      </tr>
                    ) : (
                      filteredRules.map((rule) => {
                        const deletingThis = sgBusy === `del:${rule.rule_id}`
                        const isAccept = rule.policy.toLowerCase() === 'accept'
                        return (
                          <tr key={rule.rule_id || `${rule.ip_protocol}-${rule.port_range}-${rule.source_cidr_ip}-${rule.priority}`}>
                            <td>
                              <Badge tone={isAccept ? 'green' : 'red'} dot={false}>
                                {isAccept ? '允许' : '拒绝'}
                              </Badge>
                            </td>
                            <td className="mono">{rule.ip_protocol}</td>
                            <td className="mono">{rule.port_range}</td>
                            <td className="mono">
                              {sgDirFilter === 'ingress'
                                ? rule.source_cidr_ip || '—'
                                : rule.dest_cidr_ip || '—'}
                            </td>
                            <td>{rule.priority}</td>
                            <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {rule.description || '—'}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <button
                                type="button"
                                className="btn ghost icon sm"
                                title={rule.rule_id ? '删除该规则' : '缺少规则 ID，无法删除'}
                                disabled={!rule.rule_id || Boolean(sgBusy)}
                                onClick={() => void deleteSecurityRule(rule.rule_id, rule.direction)}
                              >
                                {deletingThis ? (
                                  <LoaderCircle size={12} className="spin" />
                                ) : (
                                  <Trash2 size={12} style={{ color: 'var(--red)' }} />
                                )}
                              </button>
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'release' && (
        <div className="ops-stack">
          <div className="reinstall-warn" style={{ marginBottom: 0 }}>
            <Flame size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <strong>高危不可逆操作：永久释放（销毁）阿里云 ECS 实例</strong>
              <div>
                释放后实例及随实例释放的云盘、公网 IP 将被阿里云永久回收，所有数据无法找回。
              </div>
            </div>
          </div>

          {detailLoading ? (
            <div className="manage-center compact">
              <LoaderCircle size={15} className="spin" />
              <span>正在检查实例状态与释放保护…</span>
            </div>
          ) : (
            <div className="ops-card">
              <div className="detail-rows" style={{ padding: 0 }}>
                <div className="detail-row">
                  <span>实例 ID</span>
                  <code className="mono">{server.instance_id}</code>
                </div>
                <div className="detail-row">
                  <span>付费方式</span>
                  <span>
                    {detail?.instance_charge_type === 'PrePaid'
                      ? '包年包月（未到期无法直接释放）'
                      : detail?.instance_charge_type === 'PostPaid'
                        ? '按量付费（支持立即释放）'
                        : detail?.instance_charge_type || '未知'}
                  </span>
                </div>
                <div className="detail-row">
                  <span>释放保护</span>
                  <span>
                    {detail?.deletion_protection ? (
                      <Badge tone="amber">已开启（请先在「改密 / 改名」中关闭）</Badge>
                    ) : (
                      <Badge tone="gray">未开启</Badge>
                    )}
                  </span>
                </div>
              </div>

              {isManagedActive && (
                <div className="auth-error">
                  <TriangleAlert size={13} />
                  这台服务器当前正被「{server.managed?.name}」托管，请先暂停或移出托管后再释放。
                </div>
              )}

              {isPrePaid && (
                <div className="img-notice">
                  <TriangleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    包年包月实例仅在已到期后支持通过 API 释放；未到期需前往阿里云费用中心办理退订。
                  </span>
                </div>
              )}

              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="release-confirm-id">
                  请输入完整实例 ID（<code className="mono">{server.instance_id}</code>）以确认释放
                </label>
                <input
                  id="release-confirm-id"
                  className="input mono"
                  value={confirmInstanceId}
                  disabled={releaseBusy || isManagedActive}
                  onChange={(event) => setConfirmInstanceId(event.target.value)}
                  placeholder={server.instance_id}
                />
              </div>

              <label className="img-delete-force" style={{ marginTop: 0 }}>
                <input
                  type="checkbox"
                  checked={releaseForce}
                  disabled={releaseBusy}
                  onChange={(event) => setReleaseForce(event.target.checked)}
                />
                <span>强制释放运行中的实例（若未先停机需勾选此项）</span>
              </label>

              <label className="img-delete-force" style={{ marginTop: 0 }}>
                <input
                  type="checkbox"
                  checked={releaseRemovePanel}
                  disabled={releaseBusy}
                  onChange={(event) => setReleaseRemovePanel(event.target.checked)}
                />
                <span>释放成功后同时从本面板服务器列表中移除</span>
              </label>

              <label className="img-delete-force" style={{ marginTop: 0 }}>
                <input
                  type="checkbox"
                  checked={releaseAck}
                  disabled={releaseBusy}
                  onChange={(event) => setReleaseAck(event.target.checked)}
                />
                <span>我已确认数据无需保留，知晓销毁后不可恢复</span>
              </label>

              {releaseError && (
                <div className="auth-error">
                  <TriangleAlert size={13} />
                  {releaseError}
                </div>
              )}

              <div className="ops-card-foot">
                <button
                  type="button"
                  className="btn danger sm"
                  disabled={
                    releaseBusy ||
                    isManagedActive ||
                    Boolean(detail?.deletion_protection) ||
                    confirmInstanceId.trim() !== server.instance_id ||
                    !releaseAck
                  }
                  onClick={() => void submitRelease()}
                >
                  {releaseBusy ? <LoaderCircle size={12} className="spin" /> : <Flame size={12} />}
                  确认永久释放云端实例
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
