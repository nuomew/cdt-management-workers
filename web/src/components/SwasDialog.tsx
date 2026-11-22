import { useEffect, useMemo, useState } from 'react'
import { Check, Globe, LoaderCircle, Search, TriangleAlert } from 'lucide-react'
import { SLOW_TIMEOUT_MS, post } from '../api'
import {
  DEFAULT_REGION,
  DEFAULT_TENCENT_REGION,
  GROUP_ORDER,
  regionLabel,
  regionsForProvider,
} from '../regions'
import type { Server, SiteType, SwasInstanceDetail, SwasProvider, SwasServer } from '../types'
import { Badge, Modal, Segmented, statusLabel, statusTone } from './ui'

type Props = {
  server: SwasServer | null
  ecsServers: Server[]
  swasServers: SwasServer[]
  onClose: () => void
  onSaved: (message: string) => void
}

type AccountSourceMode = 'reuse' | 'manual'

type ReusableAccount = {
  key: string
  provider: SwasProvider
  label: string
  site: SiteType
  region_id: string
  source_server_id: number
  source_swas_id: number
}

export default function SwasDialog({
  server,
  ecsServers,
  swasServers,
  onClose,
  onSaved,
}: Props) {
  const isEdit = Boolean(server?.id)
  const [provider, setProvider] = useState<SwasProvider>(
    server?.provider === 'tencent' ? 'tencent' : 'aliyun',
  )

  const allReusable = useMemo<ReusableAccount[]>(
    () => [
      ...ecsServers.map((s) => ({
        key: `ecs:${s.id}`,
        provider: 'aliyun' as const,
        label: `[阿里云 ECS] ${s.label} (${regionLabel(s.region_id)})`,
        site: s.site,
        region_id: s.region_id,
        source_server_id: s.id,
        source_swas_id: 0,
      })),
      ...swasServers
        .filter((s) => s.id !== server?.id)
        .map((s) => {
          const prov: SwasProvider = s.provider === 'tencent' ? 'tencent' : 'aliyun'
          return {
            key: `swas:${s.id}`,
            provider: prov,
            label: `[${prov === 'tencent' ? '腾讯云轻量' : '阿里云轻量'}] ${s.label} (${regionLabel(s.region_id)})`,
            site: s.site,
            region_id: s.region_id,
            source_server_id: 0,
            source_swas_id: s.id,
          }
        }),
    ],
    [ecsServers, swasServers, server?.id],
  )

  const reusableAccounts = useMemo(
    () => allReusable.filter((a) => a.provider === provider),
    [allReusable, provider],
  )

  const [sourceMode, setSourceMode] = useState<AccountSourceMode>(
    !isEdit && reusableAccounts.length > 0 ? 'reuse' : 'manual',
  )
  const [reuseKey, setReuseKey] = useState<string>(reusableAccounts[0]?.key ?? '')
  const [label, setLabel] = useState(server?.label ?? '')
  const [site, setSite] = useState<SiteType>(
    server?.site ?? reusableAccounts[0]?.site ?? 'china',
  )
  const [regionId, setRegionId] = useState(
    server?.region_id ||
      reusableAccounts[0]?.region_id ||
      (provider === 'tencent' ? DEFAULT_TENCENT_REGION : DEFAULT_REGION),
  )
  const [accessKeyId, setAccessKeyId] = useState(server?.access_key_id ?? '')
  const [accessKeySecret, setAccessKeySecret] = useState('')
  const [instanceId, setInstanceId] = useState(server?.instance_id ?? '')
  const [remark, setRemark] = useState(server?.remark ?? '')

  const [discovering, setDiscovering] = useState<'single' | 'all' | null>(null)
  const [discovered, setDiscovered] = useState<SwasInstanceDetail[]>([])
  const [discoverError, setDiscoverError] = useState('')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const regionOptions = useMemo(() => regionsForProvider(provider, site), [provider, site])
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
    setDiscovered([])
    setDiscoverError('')
    setError('')
    const matching = allReusable.filter((a) => a.provider === next)
    if (!isEdit && matching.length > 0) {
      setSourceMode('reuse')
      setReuseKey(matching[0].key)
      setSite(matching[0].site)
      setRegionId(matching[0].region_id || (next === 'tencent' ? DEFAULT_TENCENT_REGION : DEFAULT_REGION))
    } else {
      setSourceMode('manual')
      setReuseKey('')
      const nextFallback = next === 'tencent' ? DEFAULT_TENCENT_REGION : DEFAULT_REGION
      const nextRegions = regionsForProvider(next, site)
      setRegionId(
        nextRegions.some((r) => r.value === nextFallback)
          ? nextFallback
          : nextRegions[0]?.value || nextFallback,
      )
    }
  }

  const selectedReuse = reusableAccounts.find((a) => a.key === reuseKey)

  function handleChangeReuse(nextKey: string) {
    setReuseKey(nextKey)
    const found = reusableAccounts.find((a) => a.key === nextKey)
    if (found) {
      setSite(found.site)
      if (found.region_id) setRegionId(found.region_id)
    }
    setDiscovered([])
    setDiscoverError('')
  }

  const isTencent = provider === 'tencent'
  const idLabel = isTencent ? 'SecretId' : 'AccessKey ID'
  const secretLabel = isTencent ? 'SecretKey' : 'AccessKey Secret'

  async function handleDiscover(scanAll = false) {
    setDiscoverError('')
    setDiscovered([])
    const payload: Record<string, unknown> = {
      provider,
      region_id: regionId,
      site,
      scan_all_regions: scanAll && isTencent,
    }
    if (!isEdit && sourceMode === 'reuse' && selectedReuse) {
      if (selectedReuse.source_swas_id) payload['source_swas_id'] = selectedReuse.source_swas_id
      else payload['source_server_id'] = selectedReuse.source_server_id
    } else if (isEdit && server?.id && !accessKeySecret.trim()) {
      payload['source_swas_id'] = server.id
    } else {
      if (!accessKeyId.trim() || !accessKeySecret.trim()) {
        setDiscoverError(`请先填写完整的 ${idLabel} 与 ${secretLabel}`)
        return
      }
      payload['access_key_id'] = accessKeyId.trim()
      payload['access_key_secret'] = accessKeySecret.trim()
    }

    setDiscovering(scanAll ? 'all' : 'single')
    try {
      const res = await post<{ items: SwasInstanceDetail[] }>(
        '/api/v1/swas/discover',
        payload,
        SLOW_TIMEOUT_MS,
      )
      setDiscovered(res.items ?? [])
      if ((res.items ?? []).length === 0) {
        setDiscoverError(
          scanAll
            ? '全地域扫描未查询到腾讯云轻量应用服务器实例'
            : `地域 ${regionLabel(regionId)} 下未查询到${isTencent ? '腾讯云' : '阿里云'}轻量应用服务器实例`,
        )
      }
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : '拉取轻量实例失败')
    } finally {
      setDiscovering(null)
    }
  }

  function pickInstance(inst: SwasInstanceDetail) {
    setInstanceId(inst.instance_id)
    if (inst.region_id) {
      setRegionId(inst.region_id)
    }
    if (!label.trim()) {
      setLabel(inst.instance_name || `${isTencent ? '腾讯轻量' : '轻量'}-${inst.instance_id.slice(-6)}`)
    }
    if (!remark.trim() && inst.cpu > 0) {
      setRemark(`${inst.cpu}C ${inst.memory_gb}G · ${inst.bandwidth_mbps}M · ${inst.image_name || ''}`.trim())
    }
  }

  async function handleSave() {
    setError('')
    if (!instanceId.trim()) {
      setError('请填写或点选轻量服务器实例 ID')
      return
    }
    const payload: Record<string, unknown> = {
      id: server?.id || 0,
      provider,
      label: label.trim() || `${isTencent ? '腾讯轻量' : '轻量'}-${instanceId.trim().slice(-6)}`,
      region_id: regionId,
      site,
      instance_id: instanceId.trim(),
      remark: remark.trim(),
    }
    if (!isEdit && sourceMode === 'reuse' && selectedReuse) {
      if (selectedReuse.source_swas_id) payload['source_swas_id'] = selectedReuse.source_swas_id
      else payload['source_server_id'] = selectedReuse.source_server_id
    } else {
      if (!isEdit && (!accessKeyId.trim() || !accessKeySecret.trim())) {
        setError(`请填写 ${idLabel} 与 ${secretLabel}`)
        return
      }
      if (accessKeyId.trim()) payload['access_key_id'] = accessKeyId.trim()
      if (accessKeySecret.trim()) payload['access_key_secret'] = accessKeySecret.trim()
    }

    setSaving(true)
    try {
      await post('/api/v1/swas', payload, SLOW_TIMEOUT_MS)
      onSaved(isEdit ? '轻量服务器配置已更新' : '轻量服务器已添加并完成同步')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const groupedRegions = GROUP_ORDER.map((group) => ({
    group,
    items: regionOptions.filter((r) => r.group === group),
  })).filter((g) => g.items.length > 0)

  return (
    <Modal
      onClose={onClose}
      title={isEdit ? `编辑轻量服务器 · ${server?.label}` : '添加轻量服务器'}
      wide
      footer={
        <>
          <button type="button" className="btn ghost sm" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={saving}
            onClick={() => void handleSave()}
          >
            {saving && <LoaderCircle size={13} className="spin" />}
            {isEdit ? '保存更改' : '添加并同步'}
          </button>
        </>
      }
    >
      <div className="ops-stack">
        <div className="ops-card">
          <div className="ops-card-head">
            <strong>云厂商</strong>
            {isEdit ? (
              <span className={`provider-tag ${provider}`}>
                {isTencent ? '腾讯云轻量 (Lighthouse)' : '阿里云轻量 (SWAS)'}
              </span>
            ) : (
              <Segmented
                value={provider}
                onChange={handleChangeProvider}
                options={[
                  { value: 'aliyun', label: '阿里云轻量 (SWAS)' },
                  { value: 'tencent', label: '腾讯云轻量 (Lighthouse)' },
                ]}
              />
            )}
          </div>
          {isTencent && !isEdit && (
            <div style={{ fontSize: 11.5, color: 'var(--muted-soft)', marginTop: 4 }}>
              密钥可在腾讯云「访问管理 CAM → API 密钥管理」获取，建议子账号仅授予 <code>QcloudLighthouseFullAccess</code>（如需查询余额可追加 <code>QcloudFinanceReadOnlyAccess</code>）。
            </div>
          )}
        </div>

        {!isEdit && reusableAccounts.length > 0 && (
          <div className="ops-card">
            <div className="ops-card-head">
              <strong>{isTencent ? '腾讯云账号来源' : '阿里云账号来源'}</strong>
              <Segmented
                value={sourceMode}
                onChange={(v) => {
                  setSourceMode(v)
                  setDiscovered([])
                  setDiscoverError('')
                }}
                options={[
                  { value: 'reuse', label: '复用已有账号' },
                  { value: 'manual', label: `填写新 ${idLabel}` },
                ]}
              />
            </div>
            {sourceMode === 'reuse' && (
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="swas-dlg-reuse">选择来源账号</label>
                <select
                  id="swas-dlg-reuse"
                  className="select"
                  value={reuseKey}
                  onChange={(e) => handleChangeReuse(e.target.value)}
                >
                  {reusableAccounts.map((acc) => (
                    <option key={acc.key} value={acc.key}>
                      {acc.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {(isEdit || sourceMode === 'manual') && (
          <div className="grid-2">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="swas-dlg-ak">{idLabel}</label>
              <input
                id="swas-dlg-ak"
                className="input mono"
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
                placeholder={isTencent ? 'AKID...' : 'LTAI...'}
                autoComplete="off"
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="swas-dlg-sk">
                {isEdit ? `${secretLabel}（留空保持不变）` : secretLabel}
              </label>
              <input
                id="swas-dlg-sk"
                type="password"
                className="input mono"
                value={accessKeySecret}
                onChange={(e) => setAccessKeySecret(e.target.value)}
                placeholder={isEdit ? server?.access_key_masked || '已加密保存' : `输入 ${secretLabel}`}
                autoComplete="new-password"
              />
            </div>
          </div>
        )}

        <div className="ops-prov-region-row">
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{isTencent ? '腾讯云站点' : '阿里云站点'}</label>
            <Segmented
              value={site}
              onChange={(v) => setSite(v)}
              options={[
                { value: 'china', label: '中国站' },
                { value: 'international', label: '国际站' },
              ]}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="swas-dlg-region">地域</label>
            <select
              id="swas-dlg-region"
              className="select"
              value={regionId}
              onChange={(e) => setRegionId(e.target.value)}
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
          <div style={{ display: 'flex', gap: 6, alignSelf: 'flex-end' }}>
            <button
              type="button"
              className="btn sm primary"
              style={{ height: 34 }}
              disabled={discovering !== null}
              onClick={() => void handleDiscover(false)}
            >
              {discovering === 'single' ? <LoaderCircle size={13} className="spin" /> : <Search size={13} />}
              拉取实例
            </button>
            {isTencent && (
              <button
                type="button"
                className="btn sm"
                style={{ height: 34 }}
                disabled={discovering !== null}
                title="自动扫描所有可用地域中的腾讯云轻量实例"
                onClick={() => void handleDiscover(true)}
              >
                {discovering === 'all' ? <LoaderCircle size={13} className="spin" /> : <Globe size={13} />}
                扫全地域
              </button>
            )}
          </div>
        </div>

        {discoverError && (
          <div className="auth-error">
            <TriangleAlert size={14} /> {discoverError}
          </div>
        )}

        {discovered.length > 0 && (
          <div className="ops-card">
            <div className="ops-card-head">
              <strong>已查询到 {discovered.length} 台轻量实例（点击选用）</strong>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
              {discovered.map((inst) => {
                const picked = instanceId.trim() === inst.instance_id
                return (
                  <button
                    key={`${inst.region_id}:${inst.instance_id}`}
                    type="button"
                    className="btn ghost sm"
                    style={{
                      justifyContent: 'space-between',
                      padding: '8px 10px',
                      height: 'auto',
                      textAlign: 'left',
                      border: picked ? '1px solid var(--accent)' : '1px solid var(--border)',
                    }}
                    onClick={() => pickInstance(inst)}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <Badge tone={statusTone(inst.status)}>{statusLabel(inst.status)}</Badge>
                        <strong>{inst.instance_name || inst.instance_id}</strong>
                        <code className="mono" style={{ fontSize: 11 }}>{inst.instance_id}</code>
                        {inst.region_id && (
                          <span className="site-tag">{regionLabel(inst.region_id)}</span>
                        )}
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--muted-soft)' }}>
                        {inst.cpu}C {inst.memory_gb}G · {inst.disk_size_gb}G盘 ·{' '}
                        {inst.traffic && inst.traffic.total_gb > 0
                          ? `${inst.bandwidth_mbps}M · ${inst.traffic.used_gb}/${inst.traffic.total_gb} GB`
                          : `${inst.bandwidth_mbps}M无限制`}{' '}
                        · 公网 {inst.public_ip || '无'} · {inst.image_name || inst.os_type}
                      </span>
                    </div>
                    {picked && <Check size={14} style={{ color: 'var(--accent)' }} />}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="grid-2">
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="swas-dlg-id">轻量实例 ID</label>
            <input
              id="swas-dlg-id"
              className="input mono"
              value={instanceId}
              onChange={(e) => setInstanceId(e.target.value)}
              placeholder={isTencent ? 'lhins-...（点击上方拉取自动填入）' : '点击上方「拉取实例」自动填入或手填'}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="swas-dlg-label">显示名称</label>
            <input
              id="swas-dlg-label"
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={isTencent ? '例如：广州锐驰-01' : '例如：香港轻量-01'}
            />
          </div>
        </div>

        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="swas-dlg-remark">备注（可选）</label>
          <input
            id="swas-dlg-remark"
            className="input"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            placeholder="用途或套餐说明"
          />
        </div>

        {error && (
          <div className="auth-error">
            <TriangleAlert size={14} /> {error}
          </div>
        )}
      </div>
    </Modal>
  )
}
