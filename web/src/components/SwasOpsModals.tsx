import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Calculator,
  CalendarClock,
  CheckCircle2,
  Cpu,
  ExternalLink,
  HardDrive,
  Info,
  KeyRound,
  LoaderCircle,
  Package,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Rocket,
  Search,
  Shield,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { SLOW_TIMEOUT_MS, api, del, post } from '../api'
import {
  DEFAULT_REGION,
  DEFAULT_TENCENT_REGION,
  GROUP_ORDER,
  regionLabel,
  regionsForProvider,
} from '../regions'
import type {
  PriceQuote,
  RenewalConsoleUrls,
  Server,
  SiteType,
  SwasFirewallRule,
  SwasImageItem,
  SwasInstanceDetail,
  SwasPlan,
  SwasProvider,
  SwasServer,
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

const ALIYUN_SWAS_PERIOD_OPTIONS = [
  { value: 1, label: '1 个月' },
  { value: 3, label: '3 个月' },
  { value: 6, label: '6 个月' },
  { value: 12, label: '1 年' },
  { value: 24, label: '2 年' },
  { value: 36, label: '3 年' },
]

const TENCENT_RENEW_PERIOD_OPTIONS = [
  { value: 1, label: '1 个月' },
  { value: 2, label: '2 个月' },
  { value: 3, label: '3 个月' },
  { value: 6, label: '6 个月' },
  { value: 12, label: '1 年' },
  { value: 24, label: '2 年' },
  { value: 36, label: '3 年' },
]

const TENCENT_PROVISION_PERIOD_OPTIONS = [
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

const SWAS_AUTORENEW_OPTIONS = [
  { value: 1, label: '每次续 1 个月' },
  { value: 3, label: '每次续 3 个月' },
  { value: 6, label: '每次续 6 个月' },
  { value: 12, label: '每次续 1 年' },
]

const TENCENT_RENEW_FLAG_OPTIONS = [
  { value: 'NOTIFY_AND_AUTO_RENEW', label: '通知并自动续费' },
  { value: 'NOTIFY_AND_MANUAL_RENEW', label: '通知不自动续费' },
  { value: 'DISABLE_NOTIFY_AND_MANUAL_RENEW', label: '不通知不自动续费' },
] as const

/* ============================================================================
   1. SWAS Renewal Modal (PrePaid real-time price quote + confirm pay)
   ========================================================================== */

export function SwasRenewModal({
  server,
  onClose,
  onToast,
  onUpdated,
}: {
  server: SwasServer
  onClose: () => void
  onToast: (message: string, tone?: 'success' | 'error' | 'info') => void
  onUpdated: () => void
}) {
  const isTencent = server.provider === 'tencent'
  const vendorName = isTencent ? '腾讯云' : '阿里云'
  const periodOptions = isTencent ? TENCENT_RENEW_PERIOD_OPTIONS : ALIYUN_SWAS_PERIOD_OPTIONS

  const [periodMonths, setPeriodMonths] = useState(1)
  const [expiredTime, setExpiredTime] = useState(server.expired_time || '')
  const [planId, setPlanId] = useState(server.plan_id || '')
  const [renewFlag, setRenewFlag] = useState('')
  const [consoleUrls, setConsoleUrls] = useState<RenewalConsoleUrls | null>(null)
  const [autoBusy, setAutoBusy] = useState(false)

  const [quote, setQuote] = useState<PriceQuote | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(true)
  const [quoteError, setQuoteError] = useState('')
  const [confirmPay, setConfirmPay] = useState(false)
  const [payBusy, setPayBusy] = useState(false)
  const [clientToken, setClientToken] = useState(() => makeClientToken('swas-renew'))

  const fetchPrice = useCallback(
    async (months: number) => {
      setQuoteLoading(true)
      setQuoteError('')
      setQuote(null)
      setConfirmPay(false)
      setClientToken(makeClientToken('swas-renew'))
      try {
        const res = await post<{
          quote: PriceQuote
          expired_time?: string
          plan_id?: string
          renew_flag?: string
          console_urls?: RenewalConsoleUrls
        }>(
          `/api/v1/swas/${server.id}/renewal/price`,
          { period_months: months },
          SLOW_TIMEOUT_MS,
        )
        setQuote(res.quote)
        if (res.expired_time) setExpiredTime(res.expired_time)
        if (res.plan_id) setPlanId(res.plan_id)
        if (res.renew_flag) setRenewFlag(res.renew_flag)
        if (res.console_urls) setConsoleUrls(res.console_urls)
      } catch (err) {
        setQuoteError(err instanceof Error ? err.message : '查询轻量续费价格失败')
      } finally {
        setQuoteLoading(false)
      }
    },
    [server.id],
  )

  useEffect(() => {
    void fetchPrice(periodMonths)
  }, [periodMonths, fetchPrice])

  async function handleRenewPay() {
    if (!quote || !confirmPay) return
    setPayBusy(true)
    setQuoteError('')
    try {
      const res = await post<{ ok: boolean; expired_time?: string; request_id?: string }>(
        `/api/v1/swas/${server.id}/renewal/pay`,
        {
          period_months: periodMonths,
          confirm_pay: true,
          client_token: clientToken,
        },
        SLOW_TIMEOUT_MS,
      )
      if (res.expired_time) setExpiredTime(res.expired_time)
      setConfirmPay(false)
      setClientToken(makeClientToken('swas-renew'))
      onToast(
        `轻量服务器续费 ${periodMonths} 个月成功${res.expired_time ? `，新到期时间 ${formatIsoTime(res.expired_time)}` : ''}`,
        'success',
      )
      onUpdated()
    } catch (err) {
      setQuoteError(err instanceof Error ? err.message : '提交轻量续费失败')
    } finally {
      setPayBusy(false)
    }
  }

  async function handleSaveAutoRenew(nextFlag: string) {
    setAutoBusy(true)
    try {
      await post(
        `/api/v1/swas/${server.id}/renewal/auto`,
        { renew_flag: nextFlag },
        SLOW_TIMEOUT_MS,
      )
      setRenewFlag(nextFlag)
      onToast('已更新腾讯云轻量自动续费策略', 'success')
      onUpdated()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '更新自动续费策略失败', 'error')
    } finally {
      setAutoBusy(false)
    }
  }

  return (
    <Modal
      wide
      title={`轻量续费 · ${server.label || server.instance_id}`}
      icon={<CalendarClock size={16} style={{ color: 'var(--accent)' }} />}
      onClose={() => !payBusy && onClose()}
      footer={
        <>
          <button
            type="button"
            className="btn ghost sm"
            disabled={quoteLoading || payBusy}
            onClick={() => void fetchPrice(periodMonths)}
          >
            {quoteLoading ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />} 重新询价
          </button>
          {consoleUrls?.renew_url && (
            <a
              className="btn ghost sm"
              href={consoleUrls.renew_url}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={12} /> 前往{vendorName}续费中心
            </a>
          )}
          <span className="spacer" />
          <button type="button" className="btn primary sm" disabled={payBusy} onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <div className="ops-stack">
        <div className="img-account-bar" style={{ marginBottom: 0 }}>
          <div className="img-account-meta">
            <span>
              <span className={`provider-tag ${isTencent ? 'tencent' : 'aliyun'}`}>{vendorName}</span>
            </span>
            <span>
              实例：<code className="mono">{server.instance_id}</code>
            </span>
            {planId && (
              <span>
                套餐：<code className="mono">{planId}</code>
              </span>
            )}
            <span>
              到期时间：<strong>{formatIsoTime(expiredTime)}</strong>
            </span>
          </div>
          <Badge tone="blue">包年包月</Badge>
        </div>

        <div className="ops-card">
          <div className="ops-card-head">
            <strong>选择续费时长（实时询价）</strong>
            <span className="hint" style={{ margin: 0 }}>
              扣款将从{vendorName}账户余额 / 信用额度自动扣除{isTencent ? '（自动抵扣可用代金券）' : ''}
            </span>
          </div>

          <div className="ops-period-grid">
            {periodOptions.map((opt) => (
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
              <span>正在向{vendorName}查询实时续费价格…</span>
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
                <span>实付续费金额</span>
                <strong>{formatPrice(quote.trade_price, quote.currency)}</strong>
              </div>
              {quote.rules.length > 0 && (
                <div className="price-quote-rules">{quote.rules.join('；')}</div>
              )}
            </div>
          ) : null}

          <label className="img-delete-force" style={{ marginTop: 0 }}>
            <input
              type="checkbox"
              checked={confirmPay}
              disabled={!quote || quoteLoading || payBusy}
              onChange={(event) => setConfirmPay(event.target.checked)}
            />
            <span>
              我已核对续费时长与实付金额
              {quote ? `（${formatPrice(quote.trade_price, quote.currency)}）` : ''}
              ，确认从{vendorName}账户扣费执行续费
            </span>
          </label>

          <div className="ops-card-foot">
            <span className="hint" style={{ margin: 0 }}>
              {isTencent
                ? '如需支付宝/微信扫码付款，可点左下角跳转腾讯云续费中心'
                : '自动续费策略可在新建开通时开启，或前往阿里云控制台调整'}
            </span>
            <button
              type="button"
              className="btn primary sm"
              disabled={!quote || !confirmPay || payBusy}
              onClick={() => void handleRenewPay()}
            >
              {payBusy ? <LoaderCircle size={12} className="spin" /> : <CheckCircle2 size={12} />}
              确认扣费续费
            </button>
          </div>
        </div>

        {isTencent && (
          <div className="ops-card">
            <div className="ops-card-head">
              <strong>自动续费策略</strong>
              {autoBusy && <LoaderCircle size={13} className="spin" />}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {TENCENT_RENEW_FLAG_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`ops-period-btn${renewFlag === opt.value ? ' active' : ''}`}
                  disabled={autoBusy}
                  onClick={() => void handleSaveAutoRenew(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="hint" style={{ margin: 0 }}>
              点击策略后将直接调用腾讯云 <code>ModifyInstancesRenewFlag</code> 生效。
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

/* ============================================================================
   2. SWAS Ops Modal (Rename / Reset Password + Firewall Rules Management)
   ========================================================================== */

type SwasOpsTab = 'attr' | 'firewall'
type SwasFwProto = 'TCP' | 'UDP' | 'TCP+UDP' | 'ICMP' | 'ALL'

const SWAS_OPS_TABS: { value: SwasOpsTab; label: string }[] = [
  { value: 'attr', label: '改密 / 改名' },
  { value: 'firewall', label: '防火墙端口' },
]

const FW_QUICK_PRESETS: {
  label: string
  protocol: 'TCP' | 'UDP' | 'TCP+UDP' | 'ICMP'
  port: string
  remark: string
}[] = [
  { label: 'SSH (22)', protocol: 'TCP', port: '22/22', remark: 'SSH' },
  { label: 'HTTP (80)', protocol: 'TCP', port: '80/80', remark: 'HTTP' },
  { label: 'HTTPS (443)', protocol: 'TCP', port: '443/443', remark: 'HTTPS' },
  { label: 'RDP (3389)', protocol: 'TCP', port: '3389/3389', remark: 'RDP' },
  { label: 'MySQL (3306)', protocol: 'TCP', port: '3306/3306', remark: 'MySQL' },
  { label: 'Ping (ICMP)', protocol: 'ICMP', port: '-1/-1', remark: 'ICMP Ping' },
]

export function SwasOpsModal({
  server,
  initialTab = 'attr',
  onClose,
  onToast,
  onUpdated,
}: {
  server: SwasServer
  initialTab?: SwasOpsTab
  onClose: () => void
  onToast: (message: string, tone?: 'success' | 'error' | 'info') => void
  onUpdated: () => void
}) {
  const isTencent = server.provider === 'tencent'
  const vendorName = isTencent ? '腾讯云' : '阿里云'

  const [tab, setTab] = useState<SwasOpsTab>(initialTab)
  const [detail, setDetail] = useState<SwasInstanceDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(true)
  const [detailError, setDetailError] = useState('')

  // Rename & password
  const [instanceName, setInstanceName] = useState('')
  const [syncLabel, setSyncLabel] = useState(true)
  const [userName, setUserName] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [rebootAfter, setRebootAfter] = useState(true)
  const [attrBusy, setAttrBusy] = useState(false)
  const [attrError, setAttrError] = useState('')

  // Firewall
  const [rules, setRules] = useState<SwasFirewallRule[]>([])
  const [fwLoading, setFwLoading] = useState(false)
  const [fwError, setFwError] = useState('')
  const [fwProtocol, setFwProtocol] = useState<SwasFwProto>('TCP')
  const [fwPort, setFwPort] = useState('22')
  const [fwCidr, setFwCidr] = useState('0.0.0.0/0')
  const [fwPolicy, setFwPolicy] = useState<'accept' | 'drop'>('accept')
  const [fwRemark, setFwRemark] = useState('')
  const [fwBusy, setFwBusy] = useState('')

  const loadDetail = useCallback(async () => {
    setDetailLoading(true)
    setDetailError('')
    try {
      const res = await api<{ detail: SwasInstanceDetail }>(
        `/api/v1/swas/${server.id}/detail`,
        { timeoutMs: SLOW_TIMEOUT_MS },
      )
      setDetail(res.detail)
      setInstanceName(res.detail.instance_name || '')
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : '加载轻量实例信息失败')
    } finally {
      setDetailLoading(false)
    }
  }, [server.id])

  const loadFirewall = useCallback(async () => {
    setFwLoading(true)
    setFwError('')
    try {
      const res = await api<{ rules: SwasFirewallRule[] }>(
        `/api/v1/swas/${server.id}/firewall`,
        { timeoutMs: SLOW_TIMEOUT_MS },
      )
      setRules(res.rules ?? [])
    } catch (err) {
      setFwError(err instanceof Error ? err.message : '加载防火墙规则失败')
    } finally {
      setFwLoading(false)
    }
  }, [server.id])

  useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  useEffect(() => {
    if (tab === 'firewall' && rules.length === 0 && !fwLoading) {
      void loadFirewall()
    }
  }, [tab, rules.length, fwLoading, loadFirewall])

  async function submitAttributes() {
    setAttrError('')
    const trimmedName = instanceName.trim()
    const nameChanged = Boolean(trimmedName && trimmedName !== (detail?.instance_name || ''))
    const pwdChanged = Boolean(password)

    if (!nameChanged && !pwdChanged) {
      setAttrError('未检测到修改项：请修改实例名称或输入新登录密码')
      return
    }
    if (nameChanged && (trimmedName.length < 2 || trimmedName.length > 50)) {
      setAttrError('轻量实例名称长度须为 2–50 个字符')
      return
    }
    if (pwdChanged) {
      if (password !== passwordConfirm) {
        setAttrError('两次输入的新密码不一致')
        return
      }
      if (password.length < 8 || password.length > 30) {
        setAttrError('登录密码长度须为 8–30 位，并同时含大小写字母、数字、特殊符号中至少三类')
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
        if (isTencent && userName.trim()) {
          payload['user_name'] = userName.trim()
        }
        if (!isTencent) {
          payload['reboot_after'] = rebootAfter
        }
      }
      const res = await post<{ ok: boolean; rebooted: boolean }>(
        `/api/v1/swas/${server.id}/attribute`,
        payload,
        SLOW_TIMEOUT_MS,
      )
      setPassword('')
      setPasswordConfirm('')
      onToast(
        pwdChanged
          ? isTencent
            ? '属性已更新，腾讯云将自动重启实例使新密码生效'
            : res.rebooted
              ? '属性已更新，并已自动重启实例使新密码生效'
              : '属性已更新（新密码需重启实例后生效）'
          : '轻量实例名称已更新',
        'success',
      )
      await loadDetail()
      onUpdated()
    } catch (err) {
      setAttrError(err instanceof Error ? err.message : '更新轻量实例属性失败')
    } finally {
      setAttrBusy(false)
    }
  }

  async function addFirewallRule(preset?: {
    protocol: 'TCP' | 'UDP' | 'TCP+UDP' | 'ICMP'
    port: string
    remark: string
  }) {
    const protocol: SwasFwProto = preset ? preset.protocol : fwProtocol
    const port = preset
      ? isTencent
        ? preset.protocol === 'ICMP'
          ? 'ALL'
          : preset.port.split('/')[0]
        : preset.port
      : protocol === 'ICMP' || protocol === 'ALL'
        ? isTencent
          ? 'ALL'
          : '-1/-1'
        : fwPort.trim()
    const cidr = preset ? '0.0.0.0/0' : fwCidr.trim() || '0.0.0.0/0'
    const remark = preset ? preset.remark : fwRemark.trim()
    const policy = preset ? 'accept' : isTencent ? fwPolicy : 'accept'

    if (protocol !== 'ICMP' && protocol !== 'ALL' && !port) {
      setFwError(
        isTencent
          ? '请填写端口（例如 22、80,443、8000-9000 或 ALL）'
          : '请填写端口号或端口范围（例如 80 或 8000/9000）',
      )
      return
    }

    setFwBusy('add')
    setFwError('')
    try {
      const res = await post<{ ok: boolean; rules: SwasFirewallRule[] }>(
        `/api/v1/swas/${server.id}/firewall`,
        {
          rule_protocol: protocol,
          port,
          source_cidr_ip: cidr,
          policy,
          remark,
        },
        SLOW_TIMEOUT_MS,
      )
      setRules(res.rules ?? [])
      if (!preset) setFwRemark('')
      onToast(`已添加防火墙规则（${protocol} ${port}${policy === 'drop' ? ' · 拒绝' : ''}）`, 'success')
    } catch (err) {
      setFwError(err instanceof Error ? err.message : '添加防火墙规则失败')
    } finally {
      setFwBusy('')
    }
  }

  async function toggleRule(rule: SwasFirewallRule) {
    const currentlyEnabled = rule.policy.toLowerCase() !== 'drop'
    const enable = !currentlyEnabled
    setFwBusy(`toggle:${rule.rule_id}`)
    setFwError('')
    try {
      const res = await post<{ ok: boolean; rules: SwasFirewallRule[] }>(
        `/api/v1/swas/${server.id}/firewall/${encodeURIComponent(rule.rule_id)}/toggle`,
        { enable },
        SLOW_TIMEOUT_MS,
      )
      setRules(res.rules ?? [])
      onToast(
        isTencent
          ? enable
            ? '已切换为放行（ACCEPT）'
            : '已切换为拒绝（DROP）'
          : enable
            ? '已启用防火墙规则'
            : '已禁用防火墙规则',
        'success',
      )
    } catch (err) {
      setFwError(err instanceof Error ? err.message : '切换防火墙规则状态失败')
    } finally {
      setFwBusy('')
    }
  }

  async function removeRule(ruleId: string) {
    setFwBusy(`del:${ruleId}`)
    setFwError('')
    try {
      const res = await del<{ ok: boolean; rules: SwasFirewallRule[] }>(
        `/api/v1/swas/${server.id}/firewall/${encodeURIComponent(ruleId)}`,
        SLOW_TIMEOUT_MS,
      )
      setRules(res.rules ?? [])
      onToast('已删除防火墙规则', 'success')
    } catch (err) {
      setFwError(err instanceof Error ? err.message : '删除防火墙规则失败')
    } finally {
      setFwBusy('')
    }
  }

  const portDisabled = fwProtocol === 'ICMP' || fwProtocol === 'ALL'

  return (
    <Modal
      wide
      title={`轻量运维 · ${server.label || server.instance_id}`}
      icon={<SlidersHorizontal size={16} style={{ color: 'var(--accent)' }} />}
      onClose={() => !attrBusy && onClose()}
      footer={
        <>
          <span className="hint" style={{ margin: 0 }}>
            <span className={`provider-tag ${isTencent ? 'tencent' : 'aliyun'}`} style={{ marginRight: 6 }}>
              {vendorName}
            </span>
            {regionLabel(server.region_id)} · <code className="mono">{server.instance_id}</code>
          </span>
          <span className="spacer" />
          <button type="button" className="btn primary sm" disabled={attrBusy} onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <div className="img-toolbar">
        <Segmented value={tab} options={SWAS_OPS_TABS} onChange={setTab} />
        <button
          type="button"
          className="btn ghost sm"
          disabled={detailLoading || fwLoading}
          onClick={() => (tab === 'firewall' ? void loadFirewall() : void loadDetail())}
        >
          {detailLoading || fwLoading ? (
            <LoaderCircle size={12} className="spin" />
          ) : (
            <RefreshCw size={12} />
          )}{' '}
          刷新
        </button>
      </div>

      {tab === 'attr' ? (
        <div className="ops-stack">
          {detailLoading ? (
            <div className="manage-center compact">
              <LoaderCircle size={15} className="spin" />
              <span>正在读取当前轻量实例属性…</span>
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
                  <strong>实例名称</strong>
                  <span className="hint" style={{ margin: 0 }}>
                    当前云端名称：{detail?.instance_name || '—'}
                  </span>
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="swas-attr-name">新实例名称（2–50 字符）</label>
                  <input
                    id="swas-attr-name"
                    className="input"
                    value={instanceName}
                    disabled={attrBusy}
                    onChange={(event) => setInstanceName(event.target.value)}
                    placeholder="输入云端新实例名称"
                  />
                </div>
                <label className="img-delete-force" style={{ marginTop: 0 }}>
                  <input
                    type="checkbox"
                    checked={syncLabel}
                    disabled={attrBusy}
                    onChange={(event) => setSyncLabel(event.target.checked)}
                  />
                  <span>同步更新本面板显示的服务器名称</span>
                </label>
              </div>

              <div className="ops-card">
                <div className="ops-card-head">
                  <strong>
                    <KeyRound size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                    重置登录密码（{isTencent ? 'root / ubuntu / Administrator' : 'root / Administrator'}）
                  </strong>
                  <span className="hint" style={{ margin: 0 }}>
                    留空则不修改密码
                  </span>
                </div>
                {isTencent && (
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor="swas-attr-user">目标用户名（可选）</label>
                    <input
                      id="swas-attr-user"
                      className="input mono"
                      value={userName}
                      disabled={attrBusy}
                      onChange={(event) => setUserName(event.target.value)}
                      placeholder="留空重置系统默认管理员（如 root / lighthouse / ubuntu / Administrator）"
                    />
                  </div>
                )}
                <div className="grid-2">
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor="swas-attr-pwd">新登录密码（8–30 位）</label>
                    <input
                      id="swas-attr-pwd"
                      type="password"
                      className="input"
                      value={password}
                      disabled={attrBusy}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="须含大小写字母、数字、符号中至少三类"
                      autoComplete="new-password"
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor="swas-attr-pwd2">确认新密码</label>
                    <input
                      id="swas-attr-pwd2"
                      type="password"
                      className="input"
                      value={passwordConfirm}
                      disabled={attrBusy}
                      onChange={(event) => setPasswordConfirm(event.target.value)}
                      placeholder="再次输入新密码"
                      autoComplete="new-password"
                    />
                  </div>
                </div>
                {isTencent ? (
                  <div className="hint" style={{ margin: 0 }}>
                    腾讯云重置登录密码时会自动执行关机、改密并重启实例，期间服务会短暂中断。
                  </div>
                ) : (
                  <label className="img-delete-force" style={{ marginTop: 0 }}>
                    <input
                      type="checkbox"
                      checked={rebootAfter}
                      disabled={attrBusy}
                      onChange={(event) => setRebootAfter(event.target.checked)}
                    />
                    <span>修改密码后自动重启运行中的实例（阿里云要求重启后新密码才生效）</span>
                  </label>
                )}

                {attrError && (
                  <div className="auth-error">
                    <TriangleAlert size={13} />
                    {attrError}
                  </div>
                )}

                <div className="ops-card-foot">
                  <span className="hint" style={{ margin: 0 }}>
                    密码仅直传{vendorName}接口，本系统不保存、不记录明文
                  </span>
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={attrBusy}
                    onClick={() => void submitAttributes()}
                  >
                    {attrBusy ? <LoaderCircle size={12} className="spin" /> : null}
                    保存属性修改
                  </button>
                </div>
              </div>

              <div className="img-notice info">
                <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  {vendorName}轻量应用服务器均为包年包月制，面板不直接销毁释放云端实例（到期不续费将按云厂商策略隔离回收）；若仅想停止面板管理，可在列表页点击「移除」按钮。
                </span>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="ops-stack">
          <div className="ops-card">
            <div className="ops-card-head">
              <strong>
                <Shield size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                快速放行常用端口
              </strong>
              <span className="hint" style={{ margin: 0 }}>
                默认放行源 IP 0.0.0.0/0
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {FW_QUICK_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.label}
                  className="btn sm"
                  disabled={Boolean(fwBusy)}
                  onClick={() => void addFirewallRule(p)}
                >
                  <Plus size={11} /> {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="ops-card">
            <div className="ops-card-head">
              <strong>添加自定义防火墙规则</strong>
            </div>
            <div className="grid-2">
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="swas-fw-proto">协议</label>
                <select
                  id="swas-fw-proto"
                  className="select"
                  value={fwProtocol}
                  disabled={Boolean(fwBusy)}
                  onChange={(event) => setFwProtocol(event.target.value as SwasFwProto)}
                >
                  <option value="TCP">TCP</option>
                  <option value="UDP">UDP</option>
                  <option value="TCP+UDP">TCP+UDP</option>
                  <option value="ICMP">ICMP</option>
                  {isTencent && <option value="ALL">ALL（全部协议）</option>}
                </select>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="swas-fw-port">端口 / 区间</label>
                <input
                  id="swas-fw-port"
                  className="input mono"
                  value={portDisabled ? (isTencent ? 'ALL' : '-1/-1') : fwPort}
                  disabled={Boolean(fwBusy) || portDisabled}
                  onChange={(event) => setFwPort(event.target.value)}
                  placeholder={isTencent ? '如 80、80,443、8000-9000 或 ALL' : '如 8080 或 8000/9000'}
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="swas-fw-cidr">源 IP / CIDR</label>
                <input
                  id="swas-fw-cidr"
                  className="input mono"
                  value={fwCidr}
                  disabled={Boolean(fwBusy)}
                  onChange={(event) => setFwCidr(event.target.value)}
                  placeholder="0.0.0.0/0 或 1.2.3.4/32"
                />
              </div>
              {isTencent ? (
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="swas-fw-policy">策略</label>
                  <select
                    id="swas-fw-policy"
                    className="select"
                    value={fwPolicy}
                    disabled={Boolean(fwBusy)}
                    onChange={(event) => setFwPolicy(event.target.value as 'accept' | 'drop')}
                  >
                    <option value="accept">放行（ACCEPT）</option>
                    <option value="drop">拒绝（DROP）</option>
                  </select>
                </div>
              ) : (
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="swas-fw-remark">备注（可选）</label>
                  <input
                    id="swas-fw-remark"
                    className="input"
                    value={fwRemark}
                    disabled={Boolean(fwBusy)}
                    onChange={(event) => setFwRemark(event.target.value)}
                    placeholder="例如面板服务端口"
                  />
                </div>
              )}
            </div>
            {isTencent && (
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="swas-fw-remark">备注（可选）</label>
                <input
                  id="swas-fw-remark"
                  className="input"
                  value={fwRemark}
                  disabled={Boolean(fwBusy)}
                  onChange={(event) => setFwRemark(event.target.value)}
                  placeholder="例如面板服务端口"
                />
              </div>
            )}
            <div className="ops-card-foot">
              <span className="hint" style={{ margin: 0 }}>
                {isTencent
                  ? '支持单端口（80）、逗号分隔（80,443）、区间（8000-9000）或 ALL'
                  : '支持单端口（80）或区间（8000/9000）'}
              </span>
              <button
                type="button"
                className="btn primary sm"
                disabled={Boolean(fwBusy)}
                onClick={() => void addFirewallRule()}
              >
                {fwBusy === 'add' ? <LoaderCircle size={12} className="spin" /> : <Plus size={12} />}
                添加规则
              </button>
            </div>
          </div>

          {fwError && (
            <div className="auth-error">
              <TriangleAlert size={13} />
              {fwError}
            </div>
          )}

          <div className="ops-card">
            <div className="ops-card-head">
              <strong>已有防火墙规则（{rules.length}）</strong>
            </div>
            {fwLoading ? (
              <div className="manage-center compact">
                <LoaderCircle size={15} className="spin" />
                <span>正在加载防火墙规则…</span>
              </div>
            ) : rules.length === 0 ? (
              <div className="hint" style={{ margin: 0 }}>
                当前实例暂无防火墙规则
              </div>
            ) : (
              <div className="disk-table-wrap">
                <table className="disk-table">
                  <thead>
                    <tr>
                      <th>协议</th>
                      <th>端口</th>
                      <th>源 IP / CIDR</th>
                      <th>{isTencent ? '策略' : '状态'}</th>
                      <th>备注</th>
                      <th style={{ textAlign: 'right' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((r) => {
                      const enabled = r.policy.toLowerCase() !== 'drop'
                      const toggling = fwBusy === `toggle:${r.rule_id}`
                      const deleting = fwBusy === `del:${r.rule_id}`
                      return (
                        <tr key={r.rule_id}>
                          <td className="mono">{r.rule_protocol}</td>
                          <td className="mono">{r.port}</td>
                          <td className="mono">{r.source_cidr_ip || '0.0.0.0/0'}</td>
                          <td>
                            <Badge tone={enabled ? 'green' : 'gray'}>
                              {isTencent ? (enabled ? '放行' : '拒绝') : enabled ? '已启用' : '已禁用'}
                            </Badge>
                          </td>
                          <td>{r.remark || '—'}</td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <button
                              type="button"
                              className="btn ghost sm"
                              disabled={Boolean(fwBusy)}
                              onClick={() => void toggleRule(r)}
                            >
                              {toggling ? (
                                <LoaderCircle size={11} className="spin" />
                              ) : enabled ? (
                                <PowerOff size={11} />
                              ) : (
                                <Power size={11} />
                              )}
                              {isTencent ? (enabled ? '拒绝' : '放行') : enabled ? '禁用' : '启用'}
                            </button>
                            <button
                              type="button"
                              className="btn ghost icon sm"
                              title="删除规则"
                              disabled={Boolean(fwBusy)}
                              onClick={() => void removeRule(r.rule_id)}
                            >
                              {deleting ? (
                                <LoaderCircle size={12} className="spin" />
                              ) : (
                                <Trash2 size={12} style={{ color: 'var(--red)' }} />
                              )}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

/* ============================================================================
   3. SWAS Provision New Instance Modal (Plans / Images / Price / Create)
   ========================================================================== */

type SwasProvImgType = 'system' | 'app' | 'custom'

export function SwasProvisionModal({
  ecsServers,
  swasServers,
  onClose,
  onProvisioned,
}: {
  ecsServers: Server[]
  swasServers: SwasServer[]
  onClose: () => void
  onProvisioned: (message: string) => void
}) {
  const [provider, setProvider] = useState<SwasProvider>('aliyun')
  const isTencent = provider === 'tencent'
  const vendorName = isTencent ? '腾讯云' : '阿里云'
  const idLabel = isTencent ? 'SecretId' : 'AccessKey ID'
  const secretLabel = isTencent ? 'SecretKey' : 'AccessKey Secret'

  const allReusable = useMemo(
    () => [
      ...swasServers.map((s) => {
        const prov: SwasProvider = s.provider === 'tencent' ? 'tencent' : 'aliyun'
        return {
          key: `swas:${s.id}`,
          provider: prov,
          label: `[${prov === 'tencent' ? '腾讯轻量' : '阿里轻量'}] ${s.label || s.instance_id}（${regionLabel(s.region_id)} · ${s.site === 'international' ? '国际站' : '中国站'}）`,
          site: s.site,
          region_id: s.region_id,
          source_swas_id: s.id,
          source_server_id: 0,
        }
      }),
      ...ecsServers.map((s) => ({
        key: `ecs:${s.id}`,
        provider: 'aliyun' as const,
        label: `[阿里云 ECS] ${s.label || s.instance_id}（${regionLabel(s.region_id)} · ${s.site === 'international' ? '国际站' : '中国站'}）`,
        site: s.site,
        region_id: s.region_id,
        source_swas_id: 0,
        source_server_id: s.id,
      })),
    ],
    [ecsServers, swasServers],
  )

  const reusableAccounts = useMemo(
    () => allReusable.filter((a) => a.provider === provider),
    [allReusable, provider],
  )

  const hasExisting = reusableAccounts.length > 0
  const [accountMode, setAccountMode] = useState<'existing' | 'new'>(
    hasExisting ? 'existing' : 'new',
  )
  const [reuseKey, setReuseKey] = useState<string>(reusableAccounts[0]?.key ?? '')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [accessKeySecret, setAccessKeySecret] = useState('')
  const [site, setSite] = useState<SiteType>(reusableAccounts[0]?.site ?? 'china')
  const [regionId, setRegionId] = useState<string>(
    reusableAccounts[0]?.region_id || DEFAULT_REGION,
  )

  const [imageType, setImageType] = useState<SwasProvImgType>('system')
  const [plans, setPlans] = useState<SwasPlan[]>([])
  const [images, setImages] = useState<SwasImageItem[]>([])
  const [loadingOpts, setLoadingOpts] = useState(false)
  const [optsError, setOptsError] = useState('')

  const [planId, setPlanId] = useState('')
  const [imageId, setImageId] = useState('')
  const [imageFilter, setImageFilter] = useState('')
  const [dataDiskSize, setDataDiskSize] = useState('0')
  const [periodMonths, setPeriodMonths] = useState(1)
  const [autoRenew, setAutoRenew] = useState(false)
  const [autoRenewPeriod, setAutoRenewPeriod] = useState(1)
  const [addToPanel, setAddToPanel] = useState(true)
  const [panelLabel, setPanelLabel] = useState('')

  const [quote, setQuote] = useState<PriceQuote | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState('')
  const [confirmPay, setConfirmPay] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [clientToken, setClientToken] = useState(() => makeClientToken('swas-create'))

  const periodOptions = isTencent ? TENCENT_PROVISION_PERIOD_OPTIONS : ALIYUN_SWAS_PERIOD_OPTIONS
  const regionOptions = useMemo(() => regionsForProvider(provider, site), [provider, site])
  const groupedRegions = useMemo(
    () =>
      GROUP_ORDER.map((group) => ({
        group,
        items: regionOptions.filter((r) => r.group === group),
      })).filter((g) => g.items.length > 0),
    [regionOptions],
  )

  const invalidateQuote = useCallback(() => {
    setQuote(null)
    setQuoteError('')
    setConfirmPay(false)
    setClientToken(makeClientToken('swas-create'))
  }, [])

  useEffect(() => {
    if (!regionOptions.some((r) => r.value === regionId)) {
      const fallback = provider === 'tencent' ? DEFAULT_TENCENT_REGION : DEFAULT_REGION
      setRegionId(
        regionOptions.some((r) => r.value === fallback)
          ? fallback
          : regionOptions[0]?.value || fallback,
      )
    }
  }, [regionOptions, regionId, provider])

  function handleChangeProvider(next: SwasProvider) {
    if (next === provider) return
    setProvider(next)
    setPlans([])
    setImages([])
    setPlanId('')
    setImageId('')
    setOptsError('')
    setSubmitError('')
    setPeriodMonths(1)
    setDataDiskSize('0')
    invalidateQuote()
    const matching = allReusable.filter((a) => a.provider === next)
    if (matching.length > 0) {
      setAccountMode('existing')
      setReuseKey(matching[0].key)
      setSite(matching[0].site)
      setRegionId(matching[0].region_id || (next === 'tencent' ? DEFAULT_TENCENT_REGION : DEFAULT_REGION))
    } else {
      setAccountMode('new')
      setReuseKey('')
      const fallback = next === 'tencent' ? DEFAULT_TENCENT_REGION : DEFAULT_REGION
      const nextRegions = regionsForProvider(next, site)
      setRegionId(
        nextRegions.some((r) => r.value === fallback)
          ? fallback
          : nextRegions[0]?.value || fallback,
      )
    }
  }

  const selectedReuse = reusableAccounts.find((a) => a.key === reuseKey)

  function handlePickReuse(nextKey: string) {
    setReuseKey(nextKey)
    const found = reusableAccounts.find((a) => a.key === nextKey)
    if (found) {
      setSite(found.site)
      if (found.region_id) setRegionId(found.region_id)
    }
    setPlans([])
    setImages([])
    invalidateQuote()
  }

  function buildCredPayload() {
    if (accountMode === 'existing' && selectedReuse) {
      return {
        provider,
        source_swas_id: selectedReuse.source_swas_id || undefined,
        source_server_id: selectedReuse.source_server_id || undefined,
        region_id: regionId,
        site,
      }
    }
    return {
      provider,
      access_key_id: accessKeyId.trim(),
      access_key_secret: accessKeySecret.trim(),
      region_id: regionId,
      site,
    }
  }

  const loadOptions = useCallback(async () => {
    if (accountMode === 'existing' && !selectedReuse) {
      setOptsError('请先选择一台已有服务器作为账号来源')
      return
    }
    if (accountMode === 'new' && (!accessKeyId.trim() || !accessKeySecret.trim())) {
      setOptsError(`请先填写 ${idLabel} 与 ${secretLabel}`)
      return
    }
    setLoadingOpts(true)
    setOptsError('')
    invalidateQuote()
    try {
      const res = await post<{
        region_id: string
        plans: SwasPlan[]
        images: SwasImageItem[]
      }>(
        '/api/v1/swas/provision/options',
        {
          ...buildCredPayload(),
          image_type: imageType,
        },
        SLOW_TIMEOUT_MS,
      )
      const nextPlans = res.plans ?? []
      const nextImages = res.images ?? []
      setPlans(nextPlans)
      setImages(nextImages)
      setPlanId((prev) =>
        prev && nextPlans.some((p) => p.plan_id === prev)
          ? prev
          : nextPlans[0]?.plan_id || '',
      )
      setImageId((prev) =>
        prev && nextImages.some((img) => img.image_id === prev)
          ? prev
          : nextImages[0]?.image_id || '',
      )
    } catch (err) {
      setPlans([])
      setImages([])
      setOptsError(err instanceof Error ? err.message : '加载轻量套餐与镜像失败')
    } finally {
      setLoadingOpts(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, accountMode, reuseKey, accessKeyId, accessKeySecret, regionId, site, imageType])

  useEffect(() => {
    if (accountMode === 'existing' && selectedReuse) {
      void loadOptions()
    }
  }, [provider, accountMode, selectedReuse, regionId, imageType, loadOptions])

  async function handleQueryPrice() {
    setQuoteError('')
    setSubmitError('')
    if (!planId) {
      setQuoteError('请先选择轻量服务器套餐')
      return
    }
    const diskGb = isTencent ? 0 : Math.max(0, Math.trunc(Number(dataDiskSize) || 0))
    if (!isTencent && diskGb > 0 && (diskGb % 20 !== 0 || diskGb > 16380)) {
      setQuoteError('附加数据盘容量须为 0 或 20 的整数倍（最大 16380 GB）')
      return
    }
    setQuoteLoading(true)
    setConfirmPay(false)
    setClientToken(makeClientToken('swas-create'))
    try {
      const res = await post<{ quote: PriceQuote }>(
        '/api/v1/swas/provision/price',
        {
          ...buildCredPayload(),
          plan_id: planId,
          period_months: periodMonths,
          data_disk_size: diskGb,
          auto_renew: autoRenew,
        },
        SLOW_TIMEOUT_MS,
      )
      setQuote(res.quote)
    } catch (err) {
      setQuote(null)
      setQuoteError(err instanceof Error ? err.message : '查询轻量套餐价格失败')
    } finally {
      setQuoteLoading(false)
    }
  }

  async function handleCreate() {
    setSubmitError('')
    if (!quote || !confirmPay) {
      setSubmitError('请先完成实时询价并勾选扣费确认')
      return
    }
    if (!planId || !imageId) {
      setSubmitError('请确认已选择套餐与镜像')
      return
    }
    const diskGb = isTencent ? 0 : Math.max(0, Math.trunc(Number(dataDiskSize) || 0))
    setSubmitting(true)
    try {
      const res = await post<{
        ok: boolean
        instance_id: string
        swas_id: number
      }>(
        '/api/v1/swas/provision/create',
        {
          ...buildCredPayload(),
          plan_id: planId,
          image_id: imageId,
          period_months: periodMonths,
          data_disk_size: diskGb,
          auto_renew: autoRenew,
          auto_renew_period: autoRenewPeriod,
          add_to_panel: addToPanel,
          panel_label: panelLabel.trim(),
          instance_name: panelLabel.trim(),
          confirm_pay: true,
          client_token: clientToken,
        },
        SLOW_TIMEOUT_MS,
      )
      onProvisioned(
        `新${vendorName}轻量服务器开通成功（${res.instance_id || '已下单'}）${res.swas_id ? '，已自动加入轻量列表' : ''}`,
      )
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '开通轻量服务器失败')
    } finally {
      setSubmitting(false)
    }
  }

  const filteredImages = useMemo(() => {
    const q = imageFilter.trim().toLowerCase()
    if (!q) return images
    return images.filter(
      (img) =>
        img.image_name.toLowerCase().includes(q) ||
        img.image_id.toLowerCase().includes(q) ||
        img.platform.toLowerCase().includes(q),
    )
  }, [images, imageFilter])

  const selectedPlan = plans.find((p) => p.plan_id === planId) ?? null

  return (
    <Modal
      wide
      title={`开通新${vendorName}轻量应用服务器`}
      icon={<Rocket size={16} style={{ color: 'var(--accent)' }} />}
      onClose={() => !submitting && onClose()}
      footer={
        <>
          <button
            type="button"
            className="btn ghost sm"
            disabled={quoteLoading || submitting || loadingOpts || !planId}
            onClick={() => void handleQueryPrice()}
          >
            {quoteLoading ? <LoaderCircle size={12} className="spin" /> : <Calculator size={12} />}
            立即询价
          </button>
          <span className="spacer" />
          <button type="button" className="btn ghost sm" disabled={submitting} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={!quote || !confirmPay || submitting}
            onClick={() => void handleCreate()}
          >
            {submitting ? <LoaderCircle size={12} className="spin" /> : <Rocket size={12} />}
            确认扣费开通
          </button>
        </>
      }
    >
      <div className="ops-stack">
        {/* 0. Provider Selection */}
        <div className="ops-card">
          <div className="ops-card-head">
            <strong>选择云厂商</strong>
            <Segmented
              value={provider}
              onChange={handleChangeProvider}
              options={[
                { value: 'aliyun', label: '阿里云轻量 (SWAS)' },
                { value: 'tencent', label: '腾讯云轻量 (Lighthouse)' },
              ]}
            />
          </div>
        </div>

        {/* 1. Account & Region */}
        <div className="ops-card">
          <div className="ops-card-head">
            <strong>1. 选择{vendorName}账号与目标地域</strong>
            <Segmented
              value={accountMode}
              options={[
                { value: 'existing', label: '复用面板已有账号' },
                { value: 'new', label: isTencent ? '填写新 SecretId / Key' : '填写新 AK / SK' },
              ]}
              onChange={(val) => {
                setAccountMode(val)
                setPlans([])
                setImages([])
                invalidateQuote()
              }}
            />
          </div>

          {accountMode === 'existing' ? (
            hasExisting ? (
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="swas-prov-src">账号来源服务器</label>
                <select
                  id="swas-prov-src"
                  className="select"
                  value={reuseKey}
                  onChange={(event) => handlePickReuse(event.target.value)}
                >
                  {reusableAccounts.map((acc) => (
                    <option key={acc.key} value={acc.key}>
                      {acc.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="hint" style={{ margin: 0 }}>
                当前面板还没有保存{vendorName}账号，请切换到「填写新{isTencent ? ' SecretId / Key' : ' AK / SK'}」。
              </div>
            )
          ) : (
            <div className="grid-2">
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="swas-prov-ak">{idLabel}</label>
                <input
                  id="swas-prov-ak"
                  className="input mono"
                  value={accessKeyId}
                  onChange={(event) => {
                    setAccessKeyId(event.target.value)
                    invalidateQuote()
                  }}
                  placeholder={isTencent ? 'AKID...' : 'LTAI...'}
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="swas-prov-sk">{secretLabel}</label>
                <input
                  id="swas-prov-sk"
                  type="password"
                  className="input mono"
                  value={accessKeySecret}
                  onChange={(event) => {
                    setAccessKeySecret(event.target.value)
                    invalidateQuote()
                  }}
                  placeholder="仅用于签名开通与加密入库"
                />
              </div>
            </div>
          )}

          <div className="ops-prov-region-row">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="swas-prov-site">账号站点</label>
              <select
                id="swas-prov-site"
                className="select"
                value={site}
                onChange={(event) => {
                  setSite(event.target.value as SiteType)
                  invalidateQuote()
                }}
              >
                <option value="china">
                  {isTencent ? '中国站（cloud.tencent.com）' : '中国站（aliyun.com）'}
                </option>
                <option value="international">
                  {isTencent ? '国际站（tencentcloud.com）' : '国际站（alibabacloud.com）'}
                </option>
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="swas-prov-region">开通地域</label>
              <select
                id="swas-prov-region"
                className="select"
                value={regionId}
                onChange={(event) => {
                  setRegionId(event.target.value)
                  invalidateQuote()
                }}
              >
                {groupedRegions.map((g) => (
                  <optgroup key={g.group} label={g.group}>
                    {g.items.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label} ({r.value})
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn sm primary"
              style={{ alignSelf: 'flex-end', height: 34 }}
              disabled={loadingOpts}
              onClick={() => void loadOptions()}
            >
              {loadingOpts ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />}
              加载套餐与镜像
            </button>
          </div>

          {optsError && (
            <div className="auth-error">
              <TriangleAlert size={13} />
              {optsError}
            </div>
          )}
        </div>

        {/* 2. Plans */}
        <div className="ops-card">
          <div className="ops-card-head">
            <strong>
              <Cpu size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
              2. 选择轻量套餐（{plans.length}）
            </strong>
            {selectedPlan && (
              <Badge tone="blue">
                {selectedPlan.core}C {selectedPlan.memory}G · {selectedPlan.bandwidth}M
              </Badge>
            )}
          </div>

          {loadingOpts ? (
            <div className="manage-center compact">
              <LoaderCircle size={15} className="spin" />
              <span>正在拉取 {regionLabel(regionId)} 在售轻量套餐…</span>
            </div>
          ) : plans.length === 0 ? (
            <div className="hint" style={{ margin: 0 }}>
              请点击上方「加载套餐与镜像」查询该地域在售套餐。
            </div>
          ) : (
            <div className="image-list" style={{ maxHeight: 185, marginTop: 0 }}>
              {plans.map((p) => {
                const active = p.plan_id === planId
                return (
                  <button
                    type="button"
                    key={p.plan_id}
                    className={`image-item${active ? ' selected' : ''}`}
                    onClick={() => {
                      setPlanId(p.plan_id)
                      invalidateQuote()
                    }}
                  >
                    <div className="image-item-meta" style={{ justifyContent: 'space-between', width: '100%' }}>
                      <strong style={{ color: 'var(--ink)' }}>
                        {p.core} vCPU · {p.memory} GiB · {p.disk_size}G {p.disk_type} ·{' '}
                        {p.bandwidth} Mbps
                      </strong>
                      <strong className="mono" style={{ color: 'var(--accent)' }}>
                        {p.origin_price > 0 ? `${formatPrice(p.origin_price, p.currency)}/月` : p.plan_type}
                      </strong>
                    </div>
                    <div className="image-item-meta">
                      <code className="mono">{p.plan_id}</code>
                      <span>{p.flow > 0 ? `流量包 ${p.flow} GB/月` : `${p.bandwidth}M无限制`}</span>
                      {p.isp_type && <span>{p.isp_type}</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* 3. Image & Data Disk */}
        <div className="ops-card">
          <div className="ops-card-head">
            <strong>
              <Package size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
              {isTencent ? '3. 选择系统 / 应用镜像' : '3. 选择镜像与附加数据盘'}
            </strong>
            <Segmented
              value={imageType}
              options={[
                { value: 'system', label: '系统镜像' },
                { value: 'app', label: '应用镜像' },
                { value: 'custom', label: '自定义镜像' },
              ]}
              onChange={(val) => {
                setImageType(val)
                invalidateQuote()
              }}
            />
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="swas-prov-img-search">
              <Search size={11} /> 镜像列表（{filteredImages.length}）
            </label>
            <input
              id="swas-prov-img-search"
              className="input"
              value={imageFilter}
              onChange={(event) => setImageFilter(event.target.value)}
              placeholder="搜索 Debian / Ubuntu / Docker / WordPress…"
              style={{ marginBottom: 6 }}
            />
            {filteredImages.length === 0 ? (
              <div className="hint" style={{ margin: 0 }}>
                {loadingOpts ? '正在加载镜像…' : '暂无可选镜像'}
              </div>
            ) : (
              <div className="image-list" style={{ maxHeight: 150, marginTop: 0 }}>
                {filteredImages.map((img) => {
                  const active = img.image_id === imageId
                  return (
                    <button
                      type="button"
                      key={img.image_id}
                      className={`image-item${active ? ' selected' : ''}`}
                      onClick={() => setImageId(img.image_id)}
                    >
                      <div className="image-item-name">{img.image_name || img.image_id}</div>
                      <div className="image-item-meta">
                        <code className="mono">{img.image_id}</code>
                        {img.platform && <span>{img.platform}</span>}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {isTencent ? (
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="swas-prov-label">实例与面板名称（可选）</label>
              <input
                id="swas-prov-label"
                className="input"
                value={panelLabel}
                onChange={(event) => setPanelLabel(event.target.value)}
                placeholder="留空则按实例 ID 自动命名"
              />
            </div>
          ) : (
            <div className="grid-2">
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="swas-prov-disk">
                  <HardDrive size={11} /> 附加数据盘容量（GB，可选）
                </label>
                <input
                  id="swas-prov-disk"
                  type="number"
                  min={0}
                  step={20}
                  className="input mono"
                  value={dataDiskSize}
                  onChange={(event) => {
                    setDataDiskSize(event.target.value)
                    invalidateQuote()
                  }}
                  placeholder="0（不挂载）或 20 的整数倍"
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="swas-prov-label">面板显示名称（可选）</label>
                <input
                  id="swas-prov-label"
                  className="input"
                  value={panelLabel}
                  onChange={(event) => setPanelLabel(event.target.value)}
                  placeholder="留空则按实例 ID 自动命名"
                />
              </div>
            </div>
          )}
        </div>

        {/* 4. Duration, Auto-Renew & Price Confirmation */}
        <div className="ops-card">
          <div className="ops-card-head">
            <strong>4. 购买时长与实时询价确认</strong>
            <Badge tone="blue">包年包月</Badge>
          </div>

          <div className="ops-period-grid">
            {periodOptions.map((opt) => (
              <button
                type="button"
                key={opt.value}
                className={`ops-period-btn${periodMonths === opt.value ? ' active' : ''}`}
                disabled={submitting}
                onClick={() => {
                  setPeriodMonths(opt.value)
                  invalidateQuote()
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="ops-auto-row">
            <label className="img-delete-force" style={{ marginTop: 0 }}>
              <input
                type="checkbox"
                checked={autoRenew}
                disabled={submitting}
                onChange={(event) => setAutoRenew(event.target.checked)}
              />
              <span>到期自动续费</span>
            </label>
            {autoRenew && !isTencent && (
              <select
                className="select"
                style={{ maxWidth: 170 }}
                value={String(autoRenewPeriod)}
                disabled={submitting}
                onChange={(event) => setAutoRenewPeriod(Number(event.target.value))}
              >
                {SWAS_AUTORENEW_OPTIONS.map((opt) => (
                  <option key={opt.value} value={String(opt.value)}>
                    {opt.label}
                  </option>
                ))}
              </select>
            )}
            <label className="img-delete-force" style={{ marginTop: 0 }}>
              <input
                type="checkbox"
                checked={addToPanel}
                disabled={submitting}
                onChange={(event) => setAddToPanel(event.target.checked)}
              />
              <span>开通后自动加入轻量服务器列表</span>
            </label>
          </div>

          {quoteLoading ? (
            <div className="manage-center compact">
              <LoaderCircle size={14} className="spin" />
              <span>正在向{vendorName}查询实时开通价格…</span>
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
                <span>实付金额（{periodMonths} 个月）</span>
                <strong>{formatPrice(quote.trade_price, quote.currency)}</strong>
              </div>
              {quote.rules.length > 0 && (
                <div className="price-quote-rules">{quote.rules.join('；')}</div>
              )}
            </div>
          ) : (
            <div className="hint" style={{ margin: 0 }}>
              请点击左下角「立即询价」查看{vendorName}实时价格，确认后再勾选扣费并开通。
            </div>
          )}

          <label className="img-delete-force" style={{ marginTop: 0 }}>
            <input
              type="checkbox"
              checked={confirmPay}
              disabled={!quote || quoteLoading || submitting}
              onChange={(event) => setConfirmPay(event.target.checked)}
            />
            <span>
              我已核对地域、套餐、镜像、时长及实付金额
              {quote ? `（${formatPrice(quote.trade_price, quote.currency)}）` : ''}
              ，确认从{vendorName}账户扣费开通
            </span>
          </label>

          {submitError && (
            <div className="auth-error">
              <TriangleAlert size={13} />
              {submitError}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
