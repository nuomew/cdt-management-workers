import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Calculator,
  CheckCircle2,
  Cpu,
  KeyRound,
  LoaderCircle,
  Network,
  RefreshCw,
  Rocket,
  Search,
  TriangleAlert,
  Wrench,
} from 'lucide-react'
import { SLOW_TIMEOUT_MS, post } from '../api'
import { DEFAULT_REGION, GROUP_ORDER, regionLabel, regionsFor } from '../regions'
import type {
  PriceQuote,
  ProvisionOptions,
  Server,
  SiteType,
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
  return `${sign}${amount.toFixed(amount < 1 ? 3 : 2)}`
}

function makeClientToken(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const PREPAID_MONTH_OPTIONS = [
  { value: 1, label: '1 个月' },
  { value: 3, label: '3 个月' },
  { value: 6, label: '6 个月' },
  { value: 12, label: '1 年' },
  { value: 24, label: '2 年' },
  { value: 36, label: '3 年' },
]

const DISK_CATEGORIES = [
  { value: 'cloud_essd', label: 'ESSD 云盘（推荐）' },
  { value: 'cloud_essd_entry', label: 'ESSD Entry 云盘（仅 e / u1）' },
  { value: 'cloud_efficiency', label: '高效云盘' },
  { value: 'cloud_ssd', label: 'SSD 云盘' },
  { value: 'cloud_auto', label: 'ESSD AutoPL 云盘' },
]

export function ServerProvisionModal({
  servers,
  defaultThresholdPercent,
  onClose,
  onProvisioned,
  onToast,
}: {
  servers: Server[]
  defaultThresholdPercent: number
  onClose: () => void
  onProvisioned: (message: string) => void
  onToast: (message: string, tone?: 'success' | 'error' | 'info') => void
}) {
  const hasExisting = servers.length > 0
  const [accountMode, setAccountMode] = useState<'existing' | 'new'>(
    hasExisting ? 'existing' : 'new',
  )
  const [sourceServerId, setSourceServerId] = useState<string>(
    servers[0] ? String(servers[0].id) : '',
  )
  const [accessKeyId, setAccessKeyId] = useState('')
  const [accessKeySecret, setAccessKeySecret] = useState('')
  const [site, setSite] = useState<SiteType>(servers[0]?.site ?? 'china')
  const [regionId, setRegionId] = useState<string>(servers[0]?.region_id || DEFAULT_REGION)

  // Billing & spec config
  const [chargeType, setChargeType] = useState<'PostPaid' | 'PrePaid'>('PostPaid')
  const [periodMonths, setPeriodMonths] = useState(1)
  const [autoRenew, setAutoRenew] = useState(false)
  const [imageOwner, setImageOwner] = useState<'system' | 'self' | 'others'>('system')

  // Loaded regional resources
  const [options, setOptions] = useState<ProvisionOptions | null>(null)
  const [loadingOpts, setLoadingOpts] = useState(false)
  const [optsError, setOptsError] = useState('')
  const [initNetBusy, setInitNetBusy] = useState(false)

  // Selected resources
  const [zoneId, setZoneId] = useState('')
  const [instanceType, setInstanceType] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [imageId, setImageId] = useState('')
  const [imageFilter, setImageFilter] = useState('')
  const [vswitchId, setVswitchId] = useState('')
  const [securityGroupId, setSecurityGroupId] = useState('')
  const [diskCategory, setDiskCategory] = useState('cloud_essd')
  const [diskSize, setDiskSize] = useState('40')
  const [netChargeType, setNetChargeType] = useState<'PayByTraffic' | 'PayByBandwidth'>('PayByTraffic')
  const [bandwidthOut, setBandwidthOut] = useState('100')

  // Auth & naming & panel registration
  const [authMode, setAuthMode] = useState<'password' | 'keypair' | 'inherit'>('password')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [keyPairName, setKeyPairName] = useState('')
  const [instanceName, setInstanceName] = useState('')
  const [addToPanel, setAddToPanel] = useState(true)
  const [panelLabel, setPanelLabel] = useState('')
  const [quotaGb, setQuotaGb] = useState('200')

  // Price preview & confirmation
  const [quote, setQuote] = useState<PriceQuote | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState('')
  const [confirmPay, setConfirmPay] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [clientToken, setClientToken] = useState(() => makeClientToken('run'))

  const regionOptions = useMemo(() => regionsFor(site), [site])
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
    setClientToken(makeClientToken('run'))
  }, [])

  // Keep region valid when switching site
  useEffect(() => {
    if (!regionOptions.some((r) => r.value === regionId)) {
      setRegionId(regionOptions[0]?.value || DEFAULT_REGION)
    }
  }, [regionOptions, regionId])

  // Sync default site/region when picking another existing server
  function handlePickExistingServer(idStr: string) {
    setSourceServerId(idStr)
    const found = servers.find((s) => String(s.id) === idStr)
    if (found) {
      setSite(found.site)
      if (found.region_id) setRegionId(found.region_id)
    }
    setOptions(null)
    invalidateQuote()
  }

  function buildCredPayload() {
    if (accountMode === 'existing') {
      return {
        source_server_id: Number(sourceServerId) || 0,
        region_id: regionId,
        site,
      }
    }
    return {
      access_key_id: accessKeyId.trim(),
      access_key_secret: accessKeySecret.trim(),
      region_id: regionId,
      site,
    }
  }

  const loadRegionOptions = useCallback(
    async (overrideOwner?: 'system' | 'self' | 'others') => {
      const creds = buildCredPayload()
      if (accountMode === 'existing' && !creds.source_server_id) {
        setOptsError('请先选择一台已有服务器作为阿里云账号来源')
        return
      }
      if (accountMode === 'new' && (!accessKeyId.trim() || !accessKeySecret.trim())) {
        setOptsError('请先填写 AccessKey ID 与 AccessKey Secret')
        return
      }
      setLoadingOpts(true)
      setOptsError('')
      invalidateQuote()
      try {
        const res = await post<ProvisionOptions>(
          '/api/v1/aliyun/provision/options',
          {
            ...creds,
            charge_type: chargeType,
            image_owner: overrideOwner ?? imageOwner,
          },
          SLOW_TIMEOUT_MS,
        )
        setOptions(res)
        const nextZone =
          zoneId && res.zones.includes(zoneId)
            ? zoneId
            : res.vswitches[0]?.zone_id || res.zones[0] || ''
        setZoneId(nextZone)

        const zoneTypes = nextZone
          ? res.instance_types.filter((t) => t.zones.includes(nextZone))
          : res.instance_types
        const chosenType =
          instanceType && zoneTypes.some((t) => t.instance_type === instanceType)
            ? instanceType
            : zoneTypes[0]?.instance_type || res.instance_types[0]?.instance_type || ''
        setInstanceType(chosenType)

        const zoneVsws = nextZone
          ? res.vswitches.filter((v) => v.zone_id === nextZone)
          : res.vswitches
        const pickedVsw = zoneVsws[0] ?? res.vswitches[0] ?? null
        setVswitchId(pickedVsw?.vswitch_id || '')

        const matchingSgs = pickedVsw
          ? res.security_groups.filter((sg) => sg.vpc_id === pickedVsw.vpc_id)
          : res.security_groups
        setSecurityGroupId(matchingSgs[0]?.security_group_id || res.security_groups[0]?.security_group_id || '')

        setImageId((prev) =>
          prev && res.images.some((img) => img.image_id === prev)
            ? prev
            : res.images[0]?.image_id || '',
        )
        if (res.key_pairs.length > 0 && !keyPairName) {
          setKeyPairName(res.key_pairs[0] || '')
        }
      } catch (err) {
        setOptions(null)
        setOptsError(err instanceof Error ? err.message : '加载地域资源失败')
      } finally {
        setLoadingOpts(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountMode, sourceServerId, accessKeyId, accessKeySecret, regionId, site, chargeType, imageOwner],
  )

  // Auto-load once when reusing an existing server account
  useEffect(() => {
    if (accountMode === 'existing' && sourceServerId) {
      void loadRegionOptions()
    }
    // Only auto-trigger when account source, region, charge type or image tab changes
  }, [accountMode, sourceServerId, regionId, chargeType, imageOwner, loadRegionOptions])

  // Cascade VSwitch + SecurityGroup when switching zone
  function handleZoneChange(nextZone: string) {
    setZoneId(nextZone)
    invalidateQuote()
    if (!options) return
    const zoneVsws = options.vswitches.filter((v) => v.zone_id === nextZone)
    const nextVsw = zoneVsws[0] ?? null
    setVswitchId(nextVsw?.vswitch_id || '')
    if (nextVsw) {
      const sgs = options.security_groups.filter((sg) => sg.vpc_id === nextVsw.vpc_id)
      setSecurityGroupId(sgs[0]?.security_group_id || '')
    }
    const zoneTypes = options.instance_types.filter((t) => t.zones.includes(nextZone))
    if (zoneTypes.length > 0 && !zoneTypes.some((t) => t.instance_type === instanceType)) {
      setInstanceType(zoneTypes[0]?.instance_type || '')
    }
  }

  function handleVSwitchChange(nextVswId: string) {
    setVswitchId(nextVswId)
    if (!options) return
    const vsw = options.vswitches.find((v) => v.vswitch_id === nextVswId)
    if (vsw) {
      if (vsw.zone_id && vsw.zone_id !== zoneId) setZoneId(vsw.zone_id)
      const sgs = options.security_groups.filter((sg) => sg.vpc_id === vsw.vpc_id)
      if (!sgs.some((sg) => sg.security_group_id === securityGroupId)) {
        setSecurityGroupId(sgs[0]?.security_group_id || '')
      }
    }
  }

  async function handleInitDefaultNetwork() {
    const targetZone = zoneId || options?.zones[0] || ''
    if (!targetZone) {
      setOptsError('请先选择可用区')
      return
    }
    setInitNetBusy(true)
    setOptsError('')
    try {
      const res = await post<{
        ok: boolean
        created: { vswitch_id: string; security_group_id: string; vpc_id: string }
        vswitches: ProvisionOptions['vswitches']
        security_groups: ProvisionOptions['security_groups']
      }>(
        '/api/v1/aliyun/provision/init-network',
        { ...buildCredPayload(), zone_id: targetZone },
        SLOW_TIMEOUT_MS,
      )
      setOptions((prev) =>
        prev
          ? {
              ...prev,
              vswitches: res.vswitches,
              security_groups: res.security_groups,
            }
          : prev,
      )
      setVswitchId(res.created.vswitch_id)
      setSecurityGroupId(res.created.security_group_id)
      onToast('已初始化默认网络与安全组（默认放行 SSH 22 端口）', 'success')
    } catch (err) {
      setOptsError(err instanceof Error ? err.message : '初始化默认网络失败')
    } finally {
      setInitNetBusy(false)
    }
  }

  async function handleQueryPrice() {
    setQuoteError('')
    setSubmitError('')
    if (!instanceType.trim()) {
      setQuoteError('请先选择或输入实例规格')
      return
    }
    setQuoteLoading(true)
    setConfirmPay(false)
    setClientToken(makeClientToken('run'))
    try {
      const res = await post<{ quote: PriceQuote }>(
        '/api/v1/aliyun/provision/price',
        {
          ...buildCredPayload(),
          instance_type: instanceType.trim(),
          image_id: imageId,
          charge_type: chargeType,
          period_months: periodMonths,
          system_disk_category: diskCategory,
          system_disk_size: Number(diskSize) || 40,
          internet_charge_type: netChargeType,
          internet_max_bandwidth_out: Number(bandwidthOut) || 0,
        },
        SLOW_TIMEOUT_MS,
      )
      setQuote(res.quote)
    } catch (err) {
      setQuote(null)
      setQuoteError(err instanceof Error ? err.message : '查询价格失败')
    } finally {
      setQuoteLoading(false)
    }
  }

  async function handleCreate() {
    setSubmitError('')
    if (!quote || !confirmPay) {
      setSubmitError('请先完成询价并勾选扣费确认')
      return
    }
    if (!instanceType.trim() || !imageId || !vswitchId || !securityGroupId) {
      setSubmitError('请确认实例规格、镜像、交换机与安全组均已选择')
      return
    }
    if (authMode === 'password') {
      if (!password) {
        setSubmitError('请设置实例登录密码')
        return
      }
      if (password !== passwordConfirm) {
        setSubmitError('两次输入的密码不一致')
        return
      }
    } else if (authMode === 'keypair' && !keyPairName.trim()) {
      setSubmitError('请选择或输入 SSH 密钥对名称')
      return
    }

    const qGb = Number(quotaGb) || 200
    const thresholdGb = Math.max(1, Math.min(qGb, Math.round((qGb * defaultThresholdPercent) / 100)))

    setSubmitting(true)
    try {
      const res = await post<{
        ok: boolean
        instance_id: string
        order_id: string
        server_id: number
      }>(
        '/api/v1/aliyun/provision/create',
        {
          ...buildCredPayload(),
          zone_id: zoneId,
          instance_type: instanceType.trim(),
          image_id: imageId,
          vswitch_id: vswitchId,
          security_group_id: securityGroupId,
          instance_name: instanceName.trim(),
          charge_type: chargeType,
          period_months: periodMonths,
          auto_renew: chargeType === 'PrePaid' ? autoRenew : false,
          system_disk_category: diskCategory,
          system_disk_size: Number(diskSize) || 40,
          internet_charge_type: netChargeType,
          internet_max_bandwidth_out: Number(bandwidthOut) || 0,
          auth_mode: authMode,
          password: authMode === 'password' ? password : '',
          key_pair_name: authMode === 'keypair' ? keyPairName.trim() : '',
          add_to_panel: addToPanel,
          panel_label: panelLabel.trim() || instanceName.trim(),
          quota_gb: qGb,
          threshold_gb: thresholdGb,
          confirm_pay: true,
          client_token: clientToken,
        },
        SLOW_TIMEOUT_MS,
      )
      onProvisioned(
        `新实例开通成功（${res.instance_id || res.order_id}）${res.server_id ? '，已自动加入服务器列表' : ''}`,
      )
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '开通实例失败')
    } finally {
      setSubmitting(false)
    }
  }

  const filteredTypes = useMemo(() => {
    const list = options?.instance_types ?? []
    const zoneScoped = zoneId ? list.filter((t) => t.zones.includes(zoneId)) : list
    const base = zoneScoped.length > 0 ? zoneScoped : list
    const q = typeFilter.trim().toLowerCase()
    if (!q) return base
    return base.filter(
      (t) =>
        t.instance_type.toLowerCase().includes(q) ||
        `${t.cpu}c${t.memory_gb}g`.includes(q) ||
        t.family.toLowerCase().includes(q),
    )
  }, [options, zoneId, typeFilter])

  const filteredImages = useMemo(() => {
    const list = options?.images ?? []
    const q = imageFilter.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (img) =>
        (img.image_name || '').toLowerCase().includes(q) ||
        img.os_name.toLowerCase().includes(q) ||
        img.image_id.toLowerCase().includes(q),
    )
  }, [options, imageFilter])

  const selectedVsw = options?.vswitches.find((v) => v.vswitch_id === vswitchId) ?? null
  const matchingSgs = useMemo(() => {
    const list = options?.security_groups ?? []
    if (!selectedVsw) return list
    const sameVpc = list.filter((sg) => sg.vpc_id === selectedVsw.vpc_id)
    return sameVpc.length > 0 ? sameVpc : list
  }, [options, selectedVsw])

  const zoneVswitches = useMemo(() => {
    const list = options?.vswitches ?? []
    if (!zoneId) return list
    const inZone = list.filter((v) => v.zone_id === zoneId)
    return inZone.length > 0 ? inZone : list
  }, [options, zoneId])

  const needsNetworkInit = Boolean(
    options &&
      (zoneVswitches.length === 0 ||
        (zoneId && !options.vswitches.some((v) => v.zone_id === zoneId)) ||
        matchingSgs.length === 0),
  )

  return (
    <Modal
      wide
      title="开通新阿里云 ECS 实例"
      icon={<Rocket size={16} style={{ color: 'var(--accent)' }} />}
      onClose={() => !submitting && onClose()}
      footer={
        <>
          <button
            type="button"
            className="btn ghost sm"
            disabled={quoteLoading || submitting || loadingOpts}
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
        {/* 1. 账号与地域 */}
        <div className="ops-card">
          <div className="ops-card-head">
            <strong>1. 选择阿里云账号与目标地域</strong>
            <Segmented
              value={accountMode}
              options={[
                { value: 'existing', label: '复用已有服务器账号' },
                { value: 'new', label: '填写新 AK / SK' },
              ]}
              onChange={(val) => {
                setAccountMode(val)
                setOptions(null)
                invalidateQuote()
              }}
            />
          </div>

          {accountMode === 'existing' ? (
            hasExisting ? (
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="prov-src-srv">账号来源服务器</label>
                <select
                  id="prov-src-srv"
                  className="select"
                  value={sourceServerId}
                  onChange={(event) => handlePickExistingServer(event.target.value)}
                >
                  {servers.map((srv) => (
                    <option key={srv.id} value={String(srv.id)}>
                      {srv.label || srv.instance_id}（{regionLabel(srv.region_id)} ·{' '}
                      {srv.site === 'international' ? '国际站' : '中国站'}）
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="hint" style={{ margin: 0 }}>
                当前面板还没有已保存的服务器，请切换到「填写新 AK / SK」。
              </div>
            )
          ) : (
            <div className="grid-2">
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="prov-ak">AccessKey ID</label>
                <input
                  id="prov-ak"
                  className="input mono"
                  value={accessKeyId}
                  onChange={(event) => {
                    setAccessKeyId(event.target.value)
                    invalidateQuote()
                  }}
                  placeholder="LTAI..."
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="prov-sk">AccessKey Secret</label>
                <input
                  id="prov-sk"
                  type="password"
                  className="input mono"
                  value={accessKeySecret}
                  onChange={(event) => {
                    setAccessKeySecret(event.target.value)
                    invalidateQuote()
                  }}
                  placeholder="仅本次用于签名开通与加密入库"
                />
              </div>
            </div>
          )}

          <div className="ops-prov-region-row">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="prov-site">账号站点</label>
              <select
                id="prov-site"
                className="select"
                value={site}
                onChange={(event) => {
                  setSite(event.target.value as SiteType)
                  invalidateQuote()
                }}
              >
                <option value="china">中国站（aliyun.com）</option>
                <option value="international">国际站（alibabacloud.com）</option>
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="prov-region">开通地域</label>
              <select
                id="prov-region"
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
              onClick={() => void loadRegionOptions()}
            >
              {loadingOpts ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />}
              拉取地域库存
            </button>
          </div>

          {optsError && (
            <div className="auth-error">
              <TriangleAlert size={13} />
              {optsError}
            </div>
          )}
        </div>

        {/* 2. 计费方式、可用区与实例规格 */}
        <div className="ops-card">
          <div className="ops-card-head">
            <strong>
              <Cpu size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
              2. 计费模式与实例规格
            </strong>
            <Segmented
              value={chargeType}
              options={[
                { value: 'PostPaid', label: '按量付费（CDT 推荐）' },
                { value: 'PrePaid', label: '包年包月' },
              ]}
              onChange={(val) => {
                setChargeType(val)
                invalidateQuote()
              }}
            />
          </div>

          {chargeType === 'PrePaid' && (
            <div className="ops-auto-row">
              <div className="ops-period-grid" style={{ flex: 1 }}>
                {PREPAID_MONTH_OPTIONS.map((opt) => (
                  <button
                    type="button"
                    key={opt.value}
                    className={`ops-period-btn${periodMonths === opt.value ? ' active' : ''}`}
                    onClick={() => {
                      setPeriodMonths(opt.value)
                      invalidateQuote()
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <label className="img-delete-force" style={{ marginTop: 0 }}>
                <input
                  type="checkbox"
                  checked={autoRenew}
                  onChange={(event) => setAutoRenew(event.target.checked)}
                />
                <span>到期自动续费</span>
              </label>
            </div>
          )}

          <div className="grid-2">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="prov-zone">可用区</label>
              <select
                id="prov-zone"
                className="select"
                value={zoneId}
                disabled={!options || loadingOpts}
                onChange={(event) => handleZoneChange(event.target.value)}
              >
                {options?.zones.length ? (
                  options.zones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))
                ) : (
                  <option value="">请先拉取地域库存</option>
                )}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="prov-type-input">实例规格（支持下拉选或手动输入）</label>
              <input
                id="prov-type-input"
                className="input mono"
                value={instanceType}
                onChange={(event) => {
                  setInstanceType(event.target.value)
                  invalidateQuote()
                }}
                placeholder="例如 ecs.e-c1m1.large"
              />
            </div>
          </div>

          {options && options.instance_types.length > 0 && (
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="prov-type-filter">
                <Search size={11} /> 当前在售规格（{filteredTypes.length}）
              </label>
              <input
                id="prov-type-filter"
                className="input"
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
                placeholder="搜索规格，例如 e-c1m1 / 2c2g / t6 / c7…"
                style={{ marginBottom: 6 }}
              />
              <div className="image-list" style={{ maxHeight: 140, marginTop: 0 }}>
                {filteredTypes.slice(0, 60).map((t) => {
                  const active = instanceType === t.instance_type
                  return (
                    <button
                      type="button"
                      key={t.instance_type}
                      className={`image-item${active ? ' selected' : ''}`}
                      onClick={() => {
                        setInstanceType(t.instance_type)
                        invalidateQuote()
                      }}
                    >
                      <div className="image-item-meta" style={{ justifyContent: 'space-between', width: '100%' }}>
                        <code className="mono" style={{ fontWeight: 600, color: 'var(--ink)' }}>
                          {t.instance_type}
                        </code>
                        <span>
                          {t.cpu > 0 ? `${t.cpu} vCPU · ${t.memory_gb} GiB` : t.family}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* 3. 系统镜像、存储与网络 */}
        <div className="ops-card">
          <div className="ops-card-head">
            <strong>
              <Network size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
              3. 镜像、系统盘与网络配置
            </strong>
            <Segmented
              value={imageOwner}
              options={[
                { value: 'system', label: '公共镜像' },
                { value: 'self', label: '自定义镜像' },
                { value: 'others', label: '共享给我的' },
              ]}
              onChange={(val) => {
                setImageOwner(val)
                invalidateQuote()
              }}
            />
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="prov-img-search">
              系统镜像（{filteredImages.length}）
            </label>
            <input
              id="prov-img-search"
              className="input"
              value={imageFilter}
              onChange={(event) => setImageFilter(event.target.value)}
              placeholder="搜索 Debian / Ubuntu / 自定义镜像名 / 镜像 ID…"
              style={{ marginBottom: 6 }}
            />
            {filteredImages.length > 0 ? (
              <div className="image-list" style={{ maxHeight: 140, marginTop: 0 }}>
                {filteredImages.map((img) => {
                  const active = imageId === img.image_id
                  return (
                    <button
                      type="button"
                      key={img.image_id}
                      className={`image-item${active ? ' selected' : ''}`}
                      onClick={() => {
                        setImageId(img.image_id)
                        invalidateQuote()
                      }}
                    >
                      <div className="image-item-name">
                        {img.owner_alias !== 'system' && img.image_name
                          ? `${img.image_name}${img.os_name ? ` · ${img.os_name}` : ''}`
                          : img.os_name || img.image_name || img.image_id}
                      </div>
                      <div className="image-item-meta">
                        <code className="mono">{img.image_id}</code>
                        {img.architecture && <span>{img.architecture}</span>}
                        {img.size > 0 && <span>{img.size} GiB</span>}
                      </div>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="hint" style={{ margin: 0 }}>
                {loadingOpts ? '正在加载镜像…' : '当前分类暂无可选镜像，请先拉取地域库存或切换镜像分类。'}
              </div>
            )}
          </div>

          <div className="grid-2">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="prov-disk-cat">系统盘类型</label>
              <select
                id="prov-disk-cat"
                className="select"
                value={diskCategory}
                onChange={(event) => {
                  setDiskCategory(event.target.value)
                  invalidateQuote()
                }}
              >
                {DISK_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="prov-disk-size">系统盘容量（GiB）</label>
              <input
                id="prov-disk-size"
                type="number"
                min={20}
                max={2048}
                className="input"
                value={diskSize}
                onChange={(event) => {
                  setDiskSize(event.target.value)
                  invalidateQuote()
                }}
              />
            </div>
          </div>

          <div className="grid-2">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="prov-net-charge">公网带宽计费</label>
              <select
                id="prov-net-charge"
                className="select"
                value={netChargeType}
                onChange={(event) => {
                  setNetChargeType(event.target.value as 'PayByTraffic' | 'PayByBandwidth')
                  invalidateQuote()
                }}
              >
                <option value="PayByTraffic">按使用流量（CDT 推荐）</option>
                <option value="PayByBandwidth">按固定带宽</option>
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="prov-bw">公网出带宽峰值（Mbps，0 表示不分配公网 IP）</label>
              <input
                id="prov-bw"
                type="number"
                min={0}
                max={200}
                className="input"
                value={bandwidthOut}
                onChange={(event) => {
                  setBandwidthOut(event.target.value)
                  invalidateQuote()
                }}
              />
            </div>
          </div>

          <div className="grid-2">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="prov-vsw">虚拟交换机（VSwitch）</label>
              <select
                id="prov-vsw"
                className="select"
                value={vswitchId}
                disabled={!options}
                onChange={(event) => handleVSwitchChange(event.target.value)}
              >
                {zoneVswitches.length > 0 ? (
                  zoneVswitches.map((v) => (
                    <option key={v.vswitch_id} value={v.vswitch_id}>
                      {v.vswitch_name || v.vswitch_id}（{v.zone_id} · {v.cidr_block}）
                    </option>
                  ))
                ) : (
                  <option value="">当前可用区暂无交换机</option>
                )}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="prov-sg">安全组</label>
              <select
                id="prov-sg"
                className="select"
                value={securityGroupId}
                disabled={!options}
                onChange={(event) => setSecurityGroupId(event.target.value)}
              >
                {matchingSgs.length > 0 ? (
                  matchingSgs.map((sg) => (
                    <option key={sg.security_group_id} value={sg.security_group_id}>
                      {sg.security_group_name || sg.security_group_id}（{sg.security_group_id}）
                    </option>
                  ))
                ) : (
                  <option value="">当前 VPC 暂无安全组</option>
                )}
              </select>
            </div>
          </div>

          {needsNetworkInit && (
            <div className="img-notice" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <span>当前可用区缺少默认 VPC 交换机或安全组，可一键自动初始化（默认放行 SSH 22 端口）。</span>
              <button
                type="button"
                className="btn sm primary"
                disabled={initNetBusy}
                onClick={() => void handleInitDefaultNetwork()}
              >
                {initNetBusy ? <LoaderCircle size={12} className="spin" /> : <Wrench size={12} />}
                初始化默认网络
              </button>
            </div>
          )}
        </div>

        {/* 4. 登录凭证与自动入面板 */}
        <div className="ops-card">
          <div className="ops-card-head">
            <strong>
              <KeyRound size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
              4. 登录凭证与入库设置
            </strong>
            <Segmented
              value={authMode}
              options={[
                { value: 'password', label: '设置密码' },
                { value: 'keypair', label: 'SSH 密钥对' },
                { value: 'inherit', label: '沿用镜像预设密码' },
              ]}
              onChange={setAuthMode}
            />
          </div>

          {authMode === 'password' ? (
            <div className="grid-2">
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="prov-pwd">登录密码（8–30 位）</label>
                <input
                  id="prov-pwd"
                  type="password"
                  className="input"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="大小写字母/数字/符号至少三类"
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="prov-pwd2">确认密码</label>
                <input
                  id="prov-pwd2"
                  type="password"
                  className="input"
                  autoComplete="new-password"
                  value={passwordConfirm}
                  onChange={(event) => setPasswordConfirm(event.target.value)}
                  placeholder="再次输入密码"
                />
              </div>
            </div>
          ) : authMode === 'keypair' ? (
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="prov-kp">SSH 密钥对名称</label>
              {options && options.key_pairs.length > 0 ? (
                <select
                  id="prov-kp"
                  className="select"
                  value={keyPairName}
                  onChange={(event) => setKeyPairName(event.target.value)}
                >
                  <option value="">请选择密钥对</option>
                  {options.key_pairs.map((kp) => (
                    <option key={kp} value={kp}>
                      {kp}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="prov-kp"
                  className="input mono"
                  value={keyPairName}
                  onChange={(event) => setKeyPairName(event.target.value)}
                  placeholder="输入该地域已有的 SSH 密钥对名称"
                />
              )}
            </div>
          ) : (
            <div className="hint" style={{ margin: 0 }}>
              适合自定义镜像或跨账号共享镜像，开通后沿用镜像中已预设的系统密码。
            </div>
          )}

          <div className="grid-2">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="prov-name">阿里云实例名称（可选）</label>
              <input
                id="prov-name"
                className="input"
                value={instanceName}
                onChange={(event) => setInstanceName(event.target.value)}
                placeholder="例如 hk-cdt-node01"
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="prov-panel-label">本面板显示名称（可选）</label>
              <input
                id="prov-panel-label"
                className="input"
                value={panelLabel}
                disabled={!addToPanel}
                onChange={(event) => setPanelLabel(event.target.value)}
                placeholder="留空默认使用实例名称"
              />
            </div>
          </div>

          <div className="ops-auto-row">
            <label className="img-delete-force" style={{ marginTop: 0, flex: 1 }}>
              <input
                type="checkbox"
                checked={addToPanel}
                onChange={(event) => setAddToPanel(event.target.checked)}
              />
              <span>开通成功后自动将新实例加入本面板服务器列表（CDT 配额：</span>
            </label>
            <input
              className="input"
              type="number"
              min={1}
              value={quotaGb}
              disabled={!addToPanel}
              onChange={(event) => setQuotaGb(event.target.value)}
              style={{ width: 90 }}
              title="CDT 月流量配额（GB）"
            />
            <span className="hint" style={{ margin: 0 }}>GB）</span>
          </div>
        </div>

        {/* 5. 询价预览与扣费确认 */}
        <div className="ops-card">
          <div className="ops-card-head">
            <strong>5. 实时询价与防误扣费确认</strong>
            {quote && (
              <Badge tone="green">
                <CheckCircle2 size={11} /> 已询价
              </Badge>
            )}
          </div>

          {quoteLoading ? (
            <div className="manage-center compact">
              <LoaderCircle size={14} className="spin" />
              <span>正在向阿里云查询实时配置价格…</span>
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
                <span>
                  {quote.price_unit === 'Hour'
                    ? '按量预估单价（不含按流量产生的公网流量费）'
                    : `包年包月应付总额（${quote.price_unit === 'Year' ? `${quote.period} 年` : `${quote.period} 个月`}）`}
                </span>
                <strong>
                  {formatPrice(quote.trade_price, quote.currency)}
                  {quote.price_unit === 'Hour' ? ' / 小时' : ''}
                </strong>
              </div>
              {quote.rules.length > 0 && (
                <div className="price-quote-rules">{quote.rules.join('；')}</div>
              )}
            </div>
          ) : (
            <div className="hint" style={{ margin: 0 }}>
              请点击下方「立即询价」获取阿里云实时价格；任意配置变更后需重新询价才可开通。
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
              我已仔细核对地域（{regionLabel(regionId)}）、规格（{instanceType || '未选'}）及上方实时价格，确认在阿里云扣费开通此实例
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
