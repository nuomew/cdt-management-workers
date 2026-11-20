import { useState } from 'react'
import {
  Check,
  Globe2,
  KeyRound,
  LoaderCircle,
  MapPin,
  Radar,
  Search,
  Server,
  TriangleAlert,
} from 'lucide-react'
import { SLOW_TIMEOUT_MS, post } from '../api'
import { DEFAULT_REGION, GROUP_ORDER, regionLabel, regionsFor } from '../regions'
import type { DiscoveredInstance, Server as ServerType, SiteType, StopMode } from '../types'
import { Badge, Modal, Segmented, statusLabel, statusTone } from './ui'
import ConfirmDialog from './ConfirmDialog'

const SITE_OPTIONS: { value: SiteType; label: string }[] = [
  { value: 'china', label: '中国站' },
  { value: 'international', label: '国际站' },
]

const STOP_MODE_OPTIONS: { value: StopMode; label: string }[] = [
  { value: 'StopCharging', label: '节省停机' },
  { value: 'Stop', label: '普通停机' },
]

function groupedRegions(site: SiteType) {
  const allowed = regionsFor(site)
  return GROUP_ORDER.map((group) => ({
    group,
    items: allowed.filter((region) => region.group === group),
  })).filter((entry) => entry.items.length > 0)
}

function formatMemGb(memoryMb: number): string {
  if (!memoryMb) return ''
  const gb = memoryMb / 1024
  return Number.isInteger(gb) ? `${gb}G` : `${gb.toFixed(1)}G`
}

type Props = {
  server: ServerType | null
  defaultThresholdPercent?: number
  onClose: () => void
  onSaved: (message: string) => void
}

export default function ServerDialog({
  server,
  defaultThresholdPercent = 90,
  onClose,
  onSaved,
}: Props) {
  const editing = Boolean(server && server.id)
  const [form, setForm] = useState(() => ({
    id: server?.id ?? 0,
    label: server?.label ?? '',
    access_key_id: '',
    access_key_secret: '',
    site: (server?.site ?? 'china') as SiteType,
    region_id: server?.region_id ?? DEFAULT_REGION,
    instance_id: server?.instance_id ?? '',
    quota_gb: server?.quota_gb ?? 200,
    threshold_gb: server?.threshold_gb ?? Math.round((200 * defaultThresholdPercent) / 100),
    stop_mode: (server?.stop_mode ?? 'StopCharging') as StopMode,
    remark: server?.remark ?? '',
  }))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  // 自动获取实例列表状态
  const [discovering, setDiscovering] = useState<'region' | 'all' | null>(null)
  const [discovered, setDiscovered] = useState<DiscoveredInstance[] | null>(null)
  const [discoverHint, setDiscoverHint] = useState('')
  const [autoLabel, setAutoLabel] = useState('')

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function changeSite(site: SiteType) {
    setForm((current) => {
      const stillValid = regionsFor(site).some((region) => region.value === current.region_id)
      return { ...current, site, region_id: stillValid ? current.region_id : DEFAULT_REGION }
    })
  }

  function applyDiscovered(inst: DiscoveredInstance) {
    const suggestedLabel = inst.instance_name || `${regionLabel(inst.region_id)}-${inst.instance_id.slice(-4)}`
    setForm((current) => {
      const shouldFillLabel = !current.label.trim() || (autoLabel && current.label === autoLabel)
      return {
        ...current,
        instance_id: inst.instance_id,
        region_id: inst.region_id || current.region_id,
        label: shouldFillLabel ? suggestedLabel : current.label,
      }
    })
    setAutoLabel(suggestedLabel)
  }

  async function discover(scanAll: boolean) {
    setError('')
    setDiscoverHint('')
    const hasManualCreds = Boolean(form.access_key_id.trim() && form.access_key_secret.trim())
    if (!editing && !hasManualCreds) {
      setError('请先填写 AccessKey ID 与 AccessKey Secret 再获取实例')
      return
    }
    setDiscovering(scanAll ? 'all' : 'region')
    try {
      const res = await post<{ items: DiscoveredInstance[]; scanned_regions: number }>(
        '/api/v1/aliyun/instances',
        {
          server_id: editing ? form.id : 0,
          access_key_id: form.access_key_id.trim(),
          access_key_secret: form.access_key_secret.trim(),
          site: form.site,
          region_id: form.region_id,
          scan_all: scanAll,
        },
        scanAll ? SLOW_TIMEOUT_MS : undefined,
      )
      const items = res.items ?? []
      setDiscovered(items)
      if (items.length === 0) {
        setDiscoverHint(
          scanAll
            ? `已扫描 ${res.scanned_regions} 个地域，未找到 ECS 实例（请检查站点类型或 RAM 权限）`
            : `当前地域「${regionLabel(form.region_id)}」未找到 ECS 实例，可点「全地域扫描」查找`,
        )
      } else {
        setDiscoverHint(
          scanAll
            ? `已扫描 ${res.scanned_regions} 个地域，共找到 ${items.length} 台实例，点击即可填入`
            : `在「${regionLabel(form.region_id)}」找到 ${items.length} 台实例，点击即可填入`,
        )
        if (items.length === 1 && !form.instance_id.trim()) {
          applyDiscovered(items[0])
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取实例列表失败')
    } finally {
      setDiscovering(null)
    }
  }

  // 存量数据里地域可能与站点不匹配（比如早期都是中国站），这里补一个选项免得下拉框显示空白
  const regionKnown = regionsFor(form.site).some((region) => region.value === form.region_id)

  async function save() {
    setError('')
    if (!editing && (!form.access_key_id.trim() || !form.access_key_secret.trim())) {
      setError('新建服务器必须填写 AccessKey ID 与 Secret')
      return
    }
    // 数值框 min 属性对「onClick 保存」不生效，清空会变成 Number('')=0 静默提交，
    // 必须在提交前拦住，别把配额/阈值写成 0 污染换班引擎判定。
    const quota = Number(form.quota_gb)
    const threshold = Number(form.threshold_gb)
    if (!Number.isFinite(quota) || quota <= 0) {
      setError('总配额必须是大于 0 的数字')
      return
    }
    if (!Number.isFinite(threshold) || threshold <= 0) {
      setError('限流阈值必须是大于 0 的数字')
      return
    }
    if (threshold > quota) {
      setError('限流阈值不能超过总配额')
      return
    }
    // 从节省停机改成普通停机要二次确认：这一改动会让每次关机都开始计规格费，
    // 用户多半只是想看看有什么区别，一句提示比事后看账单便宜。
    if (form.stop_mode === 'Stop' && (server?.stop_mode ?? 'StopCharging') !== 'Stop') {
      setConfirmStop(true)
      return
    }
    await submit()
  }

  async function submit() {
    setBusy(true)
    try {
      await post('/api/v1/servers', { ...form, access_key_id: form.access_key_id.trim() })
      onSaved(editing ? '服务器已更新' : '服务器已添加')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={editing ? '编辑服务器' : '添加服务器'}
      icon={<Server size={16} style={{ color: 'var(--accent)' }} />}
      onClose={onClose}
      footer={
        <>
          <span className="foot-note">Secret 用加密主密钥加密后存入 D1 数据库</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            保存
          </button>
        </>
      }
    >
      <div className="field">
        <label>
          <Globe2 size={12} /> 站点类型
        </label>
        <Segmented value={form.site} options={SITE_OPTIONS} onChange={changeSite} />
        <div className="hint">
          中国站对应 aliyun.com 账号，国际站对应 alibabacloud.com 账号。ECS 与 CDT
          接口两边相同，仅费用类接口地址不同；国际站不提供中国大陆地域。
        </div>
      </div>

      <div className="field">
        <label htmlFor="ak">
          <KeyRound size={12} /> AccessKey ID {!editing && <span className="req">*</span>}
        </label>
        <input
          id="ak"
          className="input mono"
          value={form.access_key_id}
          onChange={(event) => update('access_key_id', event.target.value)}
          placeholder={editing ? server?.access_key_masked || '留空不修改' : 'LTAI5t…'}
          autoComplete="off"
        />
      </div>

      <div className="field">
        <label htmlFor="sk">
          <KeyRound size={12} /> AccessKey Secret {!editing && <span className="req">*</span>}
        </label>
        <input
          id="sk"
          className="input mono"
          type="password"
          value={form.access_key_secret}
          onChange={(event) => update('access_key_secret', event.target.value)}
          placeholder={editing ? '留空不修改' : '填写 AccessKey Secret'}
          autoComplete="new-password"
        />
        <div className="hint">
          填完 AK/SK 后可直接点下方按钮自动读取账号下的 ECS 实例 ID 与地域，无需手动复制。
        </div>
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="region">
            <MapPin size={12} /> 地域
          </label>
          <select
            id="region"
            className="select"
            value={form.region_id}
            onChange={(event) => update('region_id', event.target.value)}
          >
            {groupedRegions(form.site).map((entry) => (
              <optgroup key={entry.group} label={entry.group}>
                {entry.items.map((region) => (
                  <option key={region.value} value={region.value}>
                    {region.label}（{region.value}）
                  </option>
                ))}
              </optgroup>
            ))}
            {!regionKnown && <option value={form.region_id}>{form.region_id}（不在当前站点列表）</option>}
          </select>
        </div>
        <div className="field">
          <label htmlFor="label">别名</label>
          <input
            id="label"
            className="input"
            value={form.label}
            onChange={(event) => update('label', event.target.value)}
            placeholder="例如 香港-1号（选实例可自动填）"
          />
        </div>
      </div>

      <div className="field">
        <div className="field-head-row">
          <label htmlFor="instance">实例 ID</label>
          <div className="discover-actions">
            <button
              type="button"
              className="btn ghost sm"
              disabled={discovering !== null}
              onClick={() => void discover(false)}
              title="查询上方所选地域中的 ECS 实例"
            >
              {discovering === 'region' ? (
                <LoaderCircle size={12} className="spin" />
              ) : (
                <Search size={12} />
              )}
              获取当前地域实例
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={discovering !== null}
              onClick={() => void discover(true)}
              title="不确定地域时自动扫描当前站点下全部地域"
            >
              {discovering === 'all' ? (
                <LoaderCircle size={12} className="spin" />
              ) : (
                <Radar size={12} />
              )}
              全地域扫描
            </button>
          </div>
        </div>
        <input
          id="instance"
          className="input mono"
          value={form.instance_id}
          onChange={(event) => update('instance_id', event.target.value)}
          placeholder="点击上方按钮自动获取，或手动填入 i-j6cxxxxxxxxxxxxxxxx"
        />
        {discoverHint && <div className="hint">{discoverHint}</div>}
        {discovered && discovered.length > 0 && (
          <div className="discover-list" role="listbox" aria-label="发现的 ECS 实例">
            {discovered.map((inst) => {
              const selected = form.instance_id === inst.instance_id
              const spec = [
                inst.cpu ? `${inst.cpu}C` : '',
                formatMemGb(inst.memory),
                inst.instance_type,
              ]
                .filter(Boolean)
                .join(' · ')
              return (
                <button
                  type="button"
                  key={`${inst.region_id}-${inst.instance_id}`}
                  className={`discover-item${selected ? ' selected' : ''}`}
                  onClick={() => applyDiscovered(inst)}
                >
                  <div className="discover-item-top">
                    <span className="discover-item-title">
                      {selected && <Check size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
                      <strong>{inst.instance_name || inst.instance_id}</strong>
                    </span>
                    <Badge tone={statusTone(inst.status)} dot={false}>
                      {statusLabel(inst.status, inst.stopped_mode)}
                    </Badge>
                  </div>
                  <div className="discover-item-meta">
                    <code className="mono">{inst.instance_id}</code>
                    <span>{regionLabel(inst.region_id)}</span>
                    {inst.public_ip && <span className="mono">{inst.public_ip}</span>}
                    {spec && <span>{spec}</span>}
                  </div>
                  {inst.os_name && <div className="discover-item-os">{inst.os_name}</div>}
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="quota">总配额（GB）</label>
          <input
            id="quota"
            className="input"
            type="number"
            min={1}
            value={form.quota_gb}
            onChange={(event) => update('quota_gb', Number(event.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="threshold">限流阈值（GB）</label>
          <input
            id="threshold"
            className="input"
            type="number"
            min={1}
            value={form.threshold_gb}
            onChange={(event) => update('threshold_gb', Number(event.target.value))}
          />
          <div className="hint">达到该值即触发换班；找不到没超的成员（含状态读不到）则全局熔断停机。</div>
        </div>
      </div>

      <div className="field">
        <label>停机模式</label>
        <Segmented value={form.stop_mode} options={STOP_MODE_OPTIONS} onChange={(value) => update('stop_mode', value)} />
        <div className="hint">
          保活、换班休班、超限与手动关机的所有停机动作都按这里执行。普通停机仍按规格收费；
          本地盘 / 包年包月 / GPU 等规格不支持节省停机，会自动退化为普通停机。
        </div>
      </div>

      <div className="field">
        <label htmlFor="remark">备注</label>
        <input
          id="remark"
          className="input"
          value={form.remark}
          onChange={(event) => update('remark', event.target.value)}
          placeholder="可选"
        />
      </div>

      {error && (
        <div className="auth-error">
          <TriangleAlert size={14} />
          {error}
        </div>
      )}

      {confirmStop && (
        <ConfirmDialog
          title="改成普通停机？"
          message={`「${form.label || '这台实例'}」之后每次关机都会按实例规格计费。`}
          hint="只有「到点必须开得起来」或「IP 不能变、又不走 DDNS」时才建议这样；只想让它停机省钱就用节省停机。"
          confirmText="仍要改成普通停机"
          onCancel={() => setConfirmStop(false)}
          onConfirm={() => {
            setConfirmStop(false)
            void submit()
          }}
        />
      )}
    </Modal>
  )
}
