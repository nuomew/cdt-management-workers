import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CalendarClock,
  Camera,
  Check,
  Copy,
  Disc3,
  ExternalLink,
  HardDrive,
  Info,
  KeyRound,
  Layers,
  LoaderCircle,
  Monitor,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  SlidersHorizontal,
  Terminal,
  Trash2,
  TriangleAlert,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react'
import { SLOW_TIMEOUT_MS, api, del, post } from '../api'
import { regionLabel } from '../regions'
import type {
  Server,
  SwasCustomImage,
  SwasDisk,
  SwasImageItem,
  SwasInstanceDetail,
  SwasServer,
  SwasShareAccount,
  SwasSnapshot,
} from '../types'
import { Badge, Modal, Segmented, statusLabel, statusTone } from './ui'

const DISK_CATEGORY_LABELS: Record<string, string> = {
  ESSD: 'ESSD 云盘',
  SSD: 'SSD 云盘',
  CLOUD_EFFICIENCY: '高效云盘',
  cloud_essd: 'ESSD 云盘',
  cloud_ssd: 'SSD 云盘',
  cloud_efficiency: '高效云盘',
}

const BUSINESS_STATUS_LABELS: Record<string, string> = {
  Normal: '正常',
  Expired: '已到期',
  Overdue: '欠费停服',
  Deleted: '已释放',
}

function formatIso(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

function isExpiringSoon(iso?: string): boolean {
  if (!iso) return false
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return false
  const diffDays = (ms - Date.now()) / (24 * 3600 * 1000)
  return diffDays <= 14
}

function makeClientToken(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function defaultTimestampName(prefix: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${prefix}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/* ============================================================================
   1. SWAS Instance Detail Modal (Basic / Network & Traffic / Mounted Disks)
   ========================================================================== */

export function SwasDetailModal({
  server,
  onClose,
  onOpenVnc,
  onOpenReset,
  onOpenImages,
  onOpenRenew,
  onOpenOps,
}: {
  server: SwasServer
  onClose: () => void
  onOpenVnc: (server: SwasServer) => void
  onOpenReset: (server: SwasServer) => void
  onOpenImages: (server: SwasServer) => void
  onOpenRenew: (server: SwasServer) => void
  onOpenOps: (server: SwasServer) => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<SwasInstanceDetail | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api<{ detail: SwasInstanceDetail }>(
        `/api/v1/swas/${server.id}/detail`,
        { timeoutMs: SLOW_TIMEOUT_MS },
      )
      setDetail(res.detail)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载轻量服务器详情失败')
    } finally {
      setLoading(false)
    }
  }, [server.id])

  useEffect(() => {
    void load()
  }, [load])

  const expiring = isExpiringSoon(detail?.expired_time)
  const traffic = detail?.traffic

  return (
    <Modal
      wide
      title={`轻量实例详情 · ${server.label || server.instance_id}`}
      icon={<Info size={16} style={{ color: 'var(--accent)' }} />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost sm" disabled={loading} onClick={() => void load()}>
            {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} 刷新
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              onClose()
              onOpenRenew(server)
            }}
          >
            <CalendarClock size={13} /> 续费
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              onClose()
              onOpenOps(server)
            }}
          >
            <SlidersHorizontal size={13} /> 运维
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              onClose()
              onOpenImages(server)
            }}
          >
            <Layers size={13} /> 镜像/快照
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              onClose()
              onOpenVnc(server)
            }}
          >
            <Monitor size={13} /> VNC
          </button>
          <button
            type="button"
            className="btn sm danger"
            onClick={() => {
              onClose()
              onOpenReset(server)
            }}
          >
            <Disc3 size={13} /> 重置系统
          </button>
          <button type="button" className="btn primary sm" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      {loading && !detail ? (
        <div className="manage-center">
          <LoaderCircle size={20} className="spin" />
          <span>正在从阿里云拉取轻量服务器详情、流量包与磁盘列表…</span>
        </div>
      ) : error ? (
        <div className="auth-error">
          <TriangleAlert size={14} />
          {error}
        </div>
      ) : detail ? (
        <div className="detail-grid">
          <div className="detail-panel">
            <div className="detail-panel-head">基本信息</div>
            <div className="detail-rows">
              <div className="detail-row">
                <span>实例 ID</span>
                <code className="mono">{detail.instance_id}</code>
              </div>
              <div className="detail-row">
                <span>实例名称</span>
                <span>{detail.instance_name || '—'}</span>
              </div>
              <div className="detail-row">
                <span>当前状态</span>
                <Badge tone={statusTone(detail.status)} pulse={detail.status === 'Running'}>
                  {statusLabel(detail.status)}
                </Badge>
              </div>
              <div className="detail-row">
                <span>业务状态</span>
                <span>{BUSINESS_STATUS_LABELS[detail.business_status] ?? (detail.business_status || '正常')}</span>
              </div>
              <div className="detail-row">
                <span>套餐规格</span>
                <code className="mono">{detail.plan_id || '—'}</code>
              </div>
              <div className="detail-row">
                <span>计算配置</span>
                <span>
                  {detail.cpu > 0 ? `${detail.cpu} vCPU` : '—'} /{' '}
                  {detail.memory_gb > 0 ? `${detail.memory_gb} GiB` : '—'}
                </span>
              </div>
              <div className="detail-row">
                <span>系统 / 镜像</span>
                <span>
                  {detail.image_name || detail.os_type || '—'}
                  {detail.image_version ? ` (${detail.image_version})` : ''}
                </span>
              </div>
              <div className="detail-row">
                <span>创建时间</span>
                <span>{formatIso(detail.creation_time)}</span>
              </div>
              <div className="detail-row">
                <span>到期时间</span>
                <span className={expiring ? 'text-danger' : ''}>
                  {formatIso(detail.expired_time)}
                  {expiring ? '（注意到期）' : ''}
                </span>
              </div>
            </div>
          </div>

          <div className="detail-panel">
            <div className="detail-panel-head">网络与流量包</div>
            <div className="detail-rows">
              <div className="detail-row">
                <span>所属地域</span>
                <span>
                  {regionLabel(detail.region_id)} · <code className="mono">{detail.region_id}</code>
                </span>
              </div>
              <div className="detail-row">
                <span>公网 IP</span>
                <code className="mono">{detail.public_ip || '—'}</code>
              </div>
              <div className="detail-row">
                <span>内网 IP</span>
                <code className="mono">{detail.inner_ip || '—'}</code>
              </div>
              <div className="detail-row">
                <span>峰值带宽</span>
                <span>{detail.bandwidth_mbps > 0 ? `${detail.bandwidth_mbps} Mbps` : '—'}</span>
              </div>
              <div className="detail-row">
                <span>月度流量包</span>
                <span className="mono">
                  {traffic && traffic.total_gb > 0
                    ? `${traffic.used_gb.toFixed(2)} / ${traffic.total_gb.toFixed(0)} GiB`
                    : detail.flow_gb > 0
                      ? `套餐含 ${detail.flow_gb} GB/月`
                      : '不限流量 / 无流量包'}
                </span>
              </div>
              {traffic && traffic.total_gb > 0 && (
                <div className="detail-row">
                  <span>剩余流量</span>
                  <span className="mono">{traffic.remaining_gb.toFixed(2)} GiB</span>
                </div>
              )}
              {traffic && traffic.overflow_gb > 0 && (
                <div className="detail-row">
                  <span>超额流量</span>
                  <span className="mono text-danger">{traffic.overflow_gb.toFixed(2)} GiB</span>
                </div>
              )}
              <div className="detail-row">
                <span>DDoS 状态</span>
                <span>{detail.ddos_status || 'normal'}</span>
              </div>
              <div className="detail-row">
                <span>计费模式</span>
                <span>包年包月（{detail.charge_type || 'PrePaid'}）</span>
              </div>
            </div>
          </div>

          <div className="detail-panel span-2">
            <div className="detail-panel-head">
              <HardDrive size={13} /> 挂载磁盘（{detail.disks.length}）
            </div>
            {detail.disks.length === 0 ? (
              <div className="hint" style={{ padding: '10px 14px' }}>
                暂无磁盘数据
              </div>
            ) : (
              <div className="disk-table-wrap">
                <table className="disk-table">
                  <thead>
                    <tr>
                      <th>磁盘 ID</th>
                      <th>角色</th>
                      <th>容量</th>
                      <th>类型</th>
                      <th>状态</th>
                      <th>创建时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.disks.map((disk: SwasDisk) => (
                      <tr key={disk.disk_id}>
                        <td className="mono">{disk.disk_id}</td>
                        <td>{disk.disk_type.toLowerCase() === 'system' ? '系统盘' : '数据盘'}</td>
                        <td className="mono">{disk.size} GiB</td>
                        <td>{DISK_CATEGORY_LABELS[disk.category] ?? (disk.category || '—')}</td>
                        <td>{disk.status || '—'}</td>
                        <td>{formatIso(disk.creation_time)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

/* ============================================================================
   2. SWAS Fullscreen VNC Overlay + VNC Password Update + Workbench Jump
   ========================================================================== */

export function SwasVncOverlay({
  server,
  onClose,
  onToast,
}: {
  server: SwasServer
  onClose: () => void
  onToast: (message: string, tone?: 'success' | 'error' | 'info') => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [iframeSrc, setIframeSrc] = useState('')
  const [consoleUrl, setConsoleUrl] = useState('')

  const [pwdOpen, setPwdOpen] = useState(false)
  const [vncPassword, setVncPassword] = useState('')
  const [pwdBusy, setPwdBusy] = useState(false)
  const [wbBusy, setWbBusy] = useState(false)

  const connect = useCallback(async () => {
    setLoading(true)
    setError('')
    setIframeSrc('')
    try {
      const res = await post<{
        vnc_url: string
        console_url: string
        instance_id: string
        os_type?: string
        image_name?: string
      }>(`/api/v1/swas/${server.id}/vnc`, undefined, SLOW_TIMEOUT_MS)
      setConsoleUrl(res.console_url || '')
      const isWindows =
        (res.os_type || '').toLowerCase() === 'windows' ||
        (res.image_name || '').toLowerCase().includes('windows')
      // Aliyun SWAS DescribeInstanceVncUrl returns an already percent-encoded
      // wss%3A%2F%2F... URL; only encode when raw wss:// is returned.
      const encodedVncUrl = res.vnc_url.includes('://')
        ? encodeURIComponent(res.vnc_url)
        : res.vnc_url
      const fullUrl =
        'https://g.alicdn.com/aliyun/ecs-console-vnc2/0.0.8/index.html?vncUrl=' +
        encodedVncUrl +
        '&instanceId=' +
        encodeURIComponent(res.instance_id) +
        '&isWindows=' +
        String(isWindows)
      setIframeSrc(fullUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取轻量 VNC 连接地址失败')
      setLoading(false)
    }
  }, [server.id])

  useEffect(() => {
    void connect()
  }, [connect])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pwdOpen) onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose, pwdOpen])

  async function submitVncPassword() {
    const pwd = vncPassword.trim()
    if (!/^[A-Za-z0-9]{6}$/.test(pwd)) {
      onToast('VNC 密码必须是 6 位英文字母或数字组合', 'error')
      return
    }
    setPwdBusy(true)
    try {
      await post(`/api/v1/swas/${server.id}/vnc-password`, { vnc_password: pwd }, SLOW_TIMEOUT_MS)
      setVncPassword('')
      setPwdOpen(false)
      onToast('VNC 连接密码已修改，可重新连接生效', 'success')
    } catch (err) {
      onToast(err instanceof Error ? err.message : '修改 VNC 密码失败', 'error')
    } finally {
      setPwdBusy(false)
    }
  }

  async function openWorkbench() {
    setWbBusy(true)
    try {
      const res = await post<{ redirect_url: string }>(
        `/api/v1/swas/${server.id}/workbench`,
        {},
        SLOW_TIMEOUT_MS,
      )
      if (!res.redirect_url) {
        onToast('未返回 Workbench 跳转链接', 'error')
        return
      }
      window.open(res.redirect_url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      onToast(err instanceof Error ? err.message : '获取 Workbench 登录链接失败', 'error')
    } finally {
      setWbBusy(false)
    }
  }

  return (
    <div className="vnc-overlay" role="dialog" aria-modal="true" aria-label="轻量服务器 VNC 终端">
      <div className="vnc-bar">
        <div className="vnc-bar-info">
          <Monitor size={15} style={{ color: 'var(--accent)' }} />
          <strong>{server.label || server.instance_id}</strong>
          <code className="mono">{server.instance_id}</code>
        </div>
        <div className="vnc-bar-actions">
          {pwdOpen ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input
                type="password"
                className="input mono"
                style={{ width: 140, height: 28, fontSize: 12 }}
                maxLength={6}
                placeholder="6位字母/数字"
                value={vncPassword}
                disabled={pwdBusy}
                onChange={(event) => setVncPassword(event.target.value)}
              />
              <button
                type="button"
                className="btn primary sm"
                disabled={pwdBusy}
                onClick={() => void submitVncPassword()}
              >
                {pwdBusy ? <LoaderCircle size={12} className="spin" /> : '保存'}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                disabled={pwdBusy}
                onClick={() => {
                  setPwdOpen(false)
                  setVncPassword('')
                }}
              >
                取消
              </button>
            </div>
          ) : (
            <button type="button" className="btn ghost sm" onClick={() => setPwdOpen(true)}>
              <KeyRound size={12} /> 改 VNC 密码
            </button>
          )}
          <button
            type="button"
            className="btn ghost sm"
            disabled={wbBusy}
            onClick={() => void openWorkbench()}
            title="使用阿里云 Workbench 在新窗口免密/SSH 登录"
          >
            {wbBusy ? <LoaderCircle size={12} className="spin" /> : <Terminal size={12} />} Workbench
          </button>
          <button type="button" className="btn ghost sm" onClick={() => void connect()}>
            <RefreshCw size={12} /> 重新连接
          </button>
          {consoleUrl && (
            <a
              className="btn ghost sm"
              href={consoleUrl}
              target="_blank"
              rel="noreferrer"
              title="若内置终端无法加载，可跳转到阿里云轻量控制台打开"
            >
              <ExternalLink size={12} /> 阿里云控制台
            </a>
          )}
          <button type="button" className="btn sm danger" onClick={onClose}>
            <X size={13} /> 关闭
          </button>
        </div>
      </div>

      <div className="vnc-stage">
        {iframeSrc && (
          <iframe
            className="vnc-frame"
            src={iframeSrc}
            title={`SWAS VNC ${server.instance_id}`}
            onLoad={() => window.setTimeout(() => setLoading(false), 400)}
          />
        )}
        {(loading || error) && (
          <div className="vnc-mask">
            {error ? (
              <>
                <TriangleAlert size={22} style={{ color: 'var(--red)' }} />
                <div className="vnc-mask-err">{error}</div>
                <button type="button" className="btn primary sm" onClick={() => void connect()}>
                  重新连接
                </button>
              </>
            ) : (
              <>
                <LoaderCircle size={22} className="spin" />
                <span>正在建立轻量服务器 VNC 远程连接…</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/* ============================================================================
   3. SWAS Reset System / Change Image Modal
   ========================================================================== */

type ResetMode = 'same' | 'change'
type SwasImageCategory = 'system' | 'app' | 'custom'
type ResetAuthMode = 'keep' | 'password' | 'keypair'

const RESET_MODE_OPTIONS: { value: ResetMode; label: string }[] = [
  { value: 'same', label: '重置当前系统' },
  { value: 'change', label: '更换其他镜像' },
]

const SWAS_IMAGE_CATS: { value: SwasImageCategory; label: string }[] = [
  { value: 'system', label: '系统镜像' },
  { value: 'app', label: '应用镜像' },
  { value: 'custom', label: '自定义镜像' },
]

const RESET_AUTH_OPTIONS: { value: ResetAuthMode; label: string }[] = [
  { value: 'password', label: '设置新密码' },
  { value: 'keypair', label: 'SSH 密钥对' },
  { value: 'keep', label: '保持默认' },
]

export function SwasResetModal({
  server,
  onClose,
  onCompleted,
}: {
  server: SwasServer
  onClose: () => void
  onCompleted: (message: string) => void
}) {
  const [mode, setMode] = useState<ResetMode>('change')
  const [category, setCategory] = useState<SwasImageCategory>('system')
  const [keyword, setKeyword] = useState('')
  const [images, setImages] = useState<SwasImageItem[]>([])
  const [loadingImages, setLoadingImages] = useState(false)
  const [imageError, setImageError] = useState('')
  const [selectedImage, setSelectedImage] = useState<SwasImageItem | null>(null)

  const [authMode, setAuthMode] = useState<ResetAuthMode>('password')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [keyPairName, setKeyPairName] = useState('')
  const [keyPairs, setKeyPairs] = useState<string[]>([])

  const [ackDanger, setAckDanger] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [clientToken] = useState(() => makeClientToken('swas-reset'))

  const loadImages = useCallback(async () => {
    setLoadingImages(true)
    setImageError('')
    try {
      const res = await api<{ images: SwasImageItem[] }>(
        `/api/v1/swas/${server.id}/images?type=${category}`,
        { timeoutMs: SLOW_TIMEOUT_MS },
      )
      setImages(res.images ?? [])
    } catch (err) {
      setImages([])
      setImageError(err instanceof Error ? err.message : '加载轻量镜像列表失败')
    } finally {
      setLoadingImages(false)
    }
  }, [server.id, category])

  useEffect(() => {
    if (mode === 'change') {
      void loadImages()
    }
  }, [mode, loadImages])

  useEffect(() => {
    void api<{ key_pairs: string[] }>(`/api/v1/swas/${server.id}/keypairs`)
      .then((res) => setKeyPairs(res.key_pairs ?? []))
      .catch(() => setKeyPairs([]))
  }, [server.id])

  const filteredImages = images.filter((img) => {
    const q = keyword.trim().toLowerCase()
    if (!q) return true
    return (
      img.image_name.toLowerCase().includes(q) ||
      img.image_id.toLowerCase().includes(q) ||
      img.platform.toLowerCase().includes(q) ||
      img.description.toLowerCase().includes(q)
    )
  })

  async function submitReset() {
    setError('')
    if (mode === 'change' && !selectedImage) {
      setError('请先从列表中选择目标镜像')
      return
    }
    if (authMode === 'password') {
      if (!password) {
        setError('请输入新登录密码')
        return
      }
      if (password !== passwordConfirm) {
        setError('两次输入的密码不一致')
        return
      }
      if (password.length < 8 || password.length > 30) {
        setError('密码长度须为 8–30 位（须同时含大小写字母、数字、符号中的至少三类）')
        return
      }
    } else if (authMode === 'keypair' && !keyPairName.trim()) {
      setError('请选择或输入 SSH 密钥对名称')
      return
    }
    if (!ackDanger) {
      setError('请先勾选确认清空系统盘数据')
      return
    }

    setSubmitting(true)
    try {
      await post(
        `/api/v1/swas/${server.id}/reset`,
        {
          image_id: mode === 'change' ? selectedImage?.image_id || '' : '',
          password: authMode === 'password' ? password : '',
          key_pair_name: authMode === 'keypair' ? keyPairName.trim() : '',
          client_token: clientToken,
        },
        SLOW_TIMEOUT_MS,
      )
      onCompleted(
        mode === 'change' && selectedImage
          ? `已提交重装任务（目标镜像：${selectedImage.image_name}），请稍候刷新状态`
          : '已提交重置当前系统任务，请稍候刷新状态',
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交重置系统失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      wide
      title={`重置系统 / 更换镜像 · ${server.label || server.instance_id}`}
      icon={<Disc3 size={16} style={{ color: 'var(--red)' }} />}
      onClose={() => !submitting && onClose()}
      footer={
        <>
          <span className="foot-note">
            {mode === 'same'
              ? `重置当前系统：${server.image_name || server.os_type || '原系统'}`
              : selectedImage
                ? `已选镜像：${selectedImage.image_name}`
                : '请选择目标镜像'}
          </span>
          <span className="spacer" />
          <button type="button" className="btn" disabled={submitting} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={submitting || !ackDanger || (mode === 'change' && !selectedImage)}
            onClick={() => void submitReset()}
          >
            {submitting ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}
            确认重置系统
          </button>
        </>
      }
    >
      <div className="reinstall-warn">
        <TriangleAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        <div>
          <strong>高风险操作：</strong>重置系统将<strong>彻底清空原系统盘所有数据</strong>，数据盘不受影响。阿里云轻量服务器重置过程约需 1–3 分钟，期间实例会短暂离线并自动重启。
        </div>
      </div>

      <div className="reinstall-filters">
        <div className="field">
          <label>重置方式</label>
          <Segmented
            value={mode}
            options={RESET_MODE_OPTIONS}
            onChange={(val) => {
              setMode(val)
              setError('')
            }}
          />
        </div>
        {mode === 'change' && (
          <div className="field">
            <label>镜像类型</label>
            <Segmented
              value={category}
              options={SWAS_IMAGE_CATS}
              onChange={(val) => {
                setCategory(val)
                setSelectedImage(null)
              }}
            />
          </div>
        )}
      </div>

      {mode === 'change' && (
        <div className="field">
          <label htmlFor="swas-reset-search">
            <Search size={12} /> 选择镜像（{filteredImages.length}）
          </label>
          <input
            id="swas-reset-search"
            className="input"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索 Debian / Ubuntu / CentOS / Docker / WordPress / 镜像 ID…"
          />
          {loadingImages ? (
            <div className="manage-center compact">
              <LoaderCircle size={15} className="spin" />
              <span>正在加载 {regionLabel(server.region_id)} 可用轻量镜像…</span>
            </div>
          ) : imageError ? (
            <div className="auth-error" style={{ marginTop: 8 }}>
              <TriangleAlert size={14} />
              {imageError}
            </div>
          ) : filteredImages.length === 0 ? (
            <div className="hint" style={{ marginTop: 8 }}>
              暂无匹配镜像，请切换镜像类型或搜索词。
            </div>
          ) : (
            <div className="image-list" role="listbox" aria-label="轻量可用镜像列表">
              {filteredImages.map((img) => {
                const active = selectedImage?.image_id === img.image_id
                return (
                  <button
                    type="button"
                    key={img.image_id}
                    className={`image-item${active ? ' selected' : ''}`}
                    onClick={() => setSelectedImage(img)}
                  >
                    <div className="image-item-name">{img.image_name || img.image_id}</div>
                    <div className="image-item-meta">
                      <code className="mono">{img.image_id}</code>
                      {img.platform && <span>{img.platform}</span>}
                      {img.description && <span>{img.description}</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      <div className="field">
        <label>
          <KeyRound size={12} /> 重置后登录凭证
        </label>
        <Segmented value={authMode} options={RESET_AUTH_OPTIONS} onChange={setAuthMode} />
      </div>

      {authMode === 'password' && (
        <div className="grid-2">
          <div className="field">
            <label htmlFor="swas-reset-pwd">新登录密码（8–30 位）</label>
            <input
              id="swas-reset-pwd"
              type="password"
              className="input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="含大小写字母、数字、符号中三类"
              autoComplete="new-password"
            />
          </div>
          <div className="field">
            <label htmlFor="swas-reset-pwd2">确认新密码</label>
            <input
              id="swas-reset-pwd2"
              type="password"
              className="input"
              value={passwordConfirm}
              onChange={(event) => setPasswordConfirm(event.target.value)}
              placeholder="再次输入密码"
              autoComplete="new-password"
            />
          </div>
        </div>
      )}

      {authMode === 'keypair' && (
        <div className="field">
          <label htmlFor="swas-reset-kp">SSH 密钥对名称（仅 Linux 镜像生效）</label>
          {keyPairs.length > 0 ? (
            <select
              id="swas-reset-kp"
              className="select"
              value={keyPairName}
              onChange={(event) => setKeyPairName(event.target.value)}
            >
              <option value="">请选择密钥对</option>
              {keyPairs.map((kp) => (
                <option key={kp} value={kp}>
                  {kp}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="swas-reset-kp"
              className="input mono"
              value={keyPairName}
              onChange={(event) => setKeyPairName(event.target.value)}
              placeholder="输入轻量控制台已创建的密钥对名称"
            />
          )}
        </div>
      )}

      <label className="img-delete-force" style={{ marginTop: 4 }}>
        <input
          type="checkbox"
          checked={ackDanger}
          disabled={submitting}
          onChange={(event) => setAckDanger(event.target.checked)}
        />
        <span>我已备份重要数据，确认清空系统盘并执行重置</span>
      </label>

      {error && (
        <div className="auth-error" style={{ marginTop: 10 }}>
          <TriangleAlert size={14} />
          {error}
        </div>
      )}
    </Modal>
  )
}

/* ============================================================================
   4. SWAS Snapshots & Custom Images Modal (Cross-Account Share + Share to ECS)
   ========================================================================== */

type SwasImgTab = 'images' | 'snapshots'

const SWAS_IMG_TABS: { value: SwasImgTab; label: string }[] = [
  { value: 'images', label: '自定义镜像' },
  { value: 'snapshots', label: '磁盘快照' },
]

function snapshotStatusBadge(status: string, progress?: string): {
  tone: 'green' | 'amber' | 'red' | 'gray'
  label: string
} {
  const s = status.toLowerCase()
  if (s === 'accomplished' || s === 'available') return { tone: 'green', label: '可用' }
  if (s === 'progressing' || s === 'creating') {
    return { tone: 'amber', label: progress ? `创建中 ${progress}` : '创建中' }
  }
  if (s === 'failed') return { tone: 'red', label: '失败' }
  return { tone: 'gray', label: status || '未知' }
}

export function SwasImagesModal({
  server,
  ecsServers,
  swasServers,
  onClose,
  onToast,
}: {
  server: SwasServer
  ecsServers: Server[]
  swasServers: SwasServer[]
  onClose: () => void
  onToast: (message: string, tone?: 'success' | 'error' | 'info') => void
}) {
  const [tab, setTab] = useState<SwasImgTab>('images')
  const [accountId, setAccountId] = useState('')
  const [accountLoading, setAccountLoading] = useState(true)
  const [copiedUid, setCopiedUid] = useState(false)

  // Snapshots state
  const [disks, setDisks] = useState<SwasDisk[]>([])
  const [snapshots, setSnapshots] = useState<SwasSnapshot[]>([])
  const [snapLoading, setSnapLoading] = useState(false)
  const [snapError, setSnapError] = useState('')
  const [snapCreateOpen, setSnapCreateOpen] = useState(false)
  const [snapDiskId, setSnapDiskId] = useState('')
  const [snapName, setSnapName] = useState(() => defaultTimestampName('snap'))
  const [snapBusy, setSnapBusy] = useState('')

  // Custom images state
  const [images, setImages] = useState<SwasCustomImage[]>([])
  const [imgLoading, setImgLoading] = useState(true)
  const [imgError, setImgError] = useState('')
  const [imgCreateOpen, setImgCreateOpen] = useState(false)
  const [imgName, setImgName] = useState(() => defaultTimestampName('swas-img'))
  const [imgDesc, setImgDesc] = useState('')
  const [imgSysSnapId, setImgSysSnapId] = useState('')
  const [imgDataSnapId, setImgDataSnapId] = useState('')
  const [imgBusy, setImgBusy] = useState('')

  // Cross-account share panel
  const [expandedImageId, setExpandedImageId] = useState<string | null>(null)
  const [sharesByImage, setSharesByImage] = useState<Record<string, SwasShareAccount[]>>({})
  const [sharesLoading, setSharesLoading] = useState(false)
  const [sharesError, setSharesError] = useState('')
  const [shareBusyKey, setShareBusyKey] = useState('')
  const [targetPickKey, setTargetPickKey] = useState('')
  const [manualUid, setManualUid] = useState('')

  const shareTargets = [
    ...swasServers
      .filter((s) => s.id !== server.id)
      .map((s) => ({
        key: `swas:${s.id}`,
        label: `[轻量] ${s.label || s.instance_id}（${s.region_id === server.region_id ? '同地域' : regionLabel(s.region_id)}）`,
        target_swas_id: s.id,
        target_server_id: 0,
      })),
    ...ecsServers.map((s) => ({
      key: `ecs:${s.id}`,
      label: `[ECS] ${s.label || s.instance_id}（${s.region_id === server.region_id ? '同地域' : regionLabel(s.region_id)}）`,
      target_swas_id: 0,
      target_server_id: s.id,
    })),
  ]

  const loadAccountId = useCallback(async () => {
    setAccountLoading(true)
    try {
      const res = await api<{ account_id: string }>(`/api/v1/swas/${server.id}/account-id`)
      setAccountId(res.account_id || '')
    } catch {
      setAccountId('')
    } finally {
      setAccountLoading(false)
    }
  }, [server.id])

  const loadSnapshots = useCallback(async () => {
    setSnapLoading(true)
    setSnapError('')
    try {
      const res = await api<{ disks: SwasDisk[]; snapshots: SwasSnapshot[] }>(
        `/api/v1/swas/${server.id}/snapshots`,
        { timeoutMs: SLOW_TIMEOUT_MS },
      )
      const nextDisks = res.disks ?? []
      const nextSnaps = res.snapshots ?? []
      setDisks(nextDisks)
      setSnapshots(nextSnaps)
      if (!snapDiskId && nextDisks.length > 0) {
        const sys = nextDisks.find((d) => d.disk_type.toLowerCase() === 'system') ?? nextDisks[0]
        if (sys) setSnapDiskId(sys.disk_id)
      }
      if (!imgSysSnapId) {
        const firstSysSnap = nextSnaps.find((s) => s.source_disk_type.toLowerCase() === 'system')
        if (firstSysSnap) setImgSysSnapId(firstSysSnap.snapshot_id)
      }
    } catch (err) {
      setSnapError(err instanceof Error ? err.message : '加载快照列表失败')
    } finally {
      setSnapLoading(false)
    }
  }, [server.id, snapDiskId, imgSysSnapId])

  const loadCustomImages = useCallback(async () => {
    setImgLoading(true)
    setImgError('')
    try {
      const res = await api<{ images: SwasCustomImage[] }>(
        `/api/v1/swas/${server.id}/custom-images`,
        { timeoutMs: SLOW_TIMEOUT_MS },
      )
      setImages(res.images ?? [])
    } catch (err) {
      setImgError(err instanceof Error ? err.message : '加载自定义镜像列表失败')
    } finally {
      setImgLoading(false)
    }
  }, [server.id])

  useEffect(() => {
    void loadAccountId()
    void loadCustomImages()
    void loadSnapshots()
  }, [loadAccountId, loadCustomImages, loadSnapshots])

  const loadShares = useCallback(
    async (imageId: string) => {
      setSharesLoading(true)
      setSharesError('')
      try {
        const res = await api<{ accounts: SwasShareAccount[] }>(
          `/api/v1/swas/${server.id}/custom-images/${encodeURIComponent(imageId)}/shares`,
          { timeoutMs: SLOW_TIMEOUT_MS },
        )
        setSharesByImage((prev) => ({ ...prev, [imageId]: res.accounts ?? [] }))
      } catch (err) {
        setSharesError(err instanceof Error ? err.message : '读取跨账号共享列表失败')
      } finally {
        setSharesLoading(false)
      }
    },
    [server.id],
  )

  async function copyAccountId() {
    if (!accountId) return
    try {
      await navigator.clipboard.writeText(accountId)
      setCopiedUid(true)
      onToast('已复制阿里云主账号 UID', 'success')
      window.setTimeout(() => setCopiedUid(false), 1800)
    } catch {
      onToast('复制失败，请手动选中复制', 'info')
    }
  }

  async function submitCreateSnapshot() {
    const name = snapName.trim()
    if (!snapDiskId) {
      setSnapError('请选择要创建快照的磁盘')
      return
    }
    if (name.length < 2 || name.length > 50) {
      setSnapError('快照名称长度须为 2–50 个字符')
      return
    }
    setSnapBusy('create')
    setSnapError('')
    try {
      const res = await post<{ ok: boolean; snapshot_id: string }>(
        `/api/v1/swas/${server.id}/snapshots`,
        { disk_id: snapDiskId, snapshot_name: name },
        SLOW_TIMEOUT_MS,
      )
      onToast(`快照创建已提交（${res.snapshot_id}）`, 'success')
      setSnapCreateOpen(false)
      setSnapName(defaultTimestampName('snap'))
      await loadSnapshots()
    } catch (err) {
      setSnapError(err instanceof Error ? err.message : '创建快照失败')
    } finally {
      setSnapBusy('')
    }
  }

  async function handleDeleteSnapshot(snapshotId: string) {
    setSnapBusy(`del:${snapshotId}`)
    setSnapError('')
    try {
      await del(`/api/v1/swas/${server.id}/snapshots/${encodeURIComponent(snapshotId)}`, SLOW_TIMEOUT_MS)
      setSnapshots((prev) => prev.filter((s) => s.snapshot_id !== snapshotId))
      onToast(`已删除快照 ${snapshotId}`, 'success')
    } catch (err) {
      setSnapError(err instanceof Error ? err.message : '删除快照失败')
    } finally {
      setSnapBusy('')
    }
  }

  async function submitCreateCustomImage() {
    const name = imgName.trim()
    if (name.length < 2 || name.length > 128) {
      setImgError('自定义镜像名称长度须为 2–128 个字符')
      return
    }
    if (!imgSysSnapId) {
      setImgError('请先选择一个系统盘快照（轻量制作镜像需基于已有系统盘快照）')
      return
    }
    setImgBusy('create')
    setImgError('')
    try {
      const res = await post<{ ok: boolean; image_id: string }>(
        `/api/v1/swas/${server.id}/custom-images`,
        {
          image_name: name,
          system_snapshot_id: imgSysSnapId,
          data_snapshot_id: imgDataSnapId || undefined,
          description: imgDesc.trim() || undefined,
        },
        SLOW_TIMEOUT_MS,
      )
      onToast(`自定义镜像已提交创建（${res.image_id}）`, 'success')
      setImgCreateOpen(false)
      setImgName(defaultTimestampName('swas-img'))
      setImgDesc('')
      await loadCustomImages()
    } catch (err) {
      setImgError(err instanceof Error ? err.message : '创建自定义镜像失败')
    } finally {
      setImgBusy('')
    }
  }

  async function handleToggleShareEcs(img: SwasCustomImage) {
    const nextShare = !img.in_share_ecs
    setImgBusy(`ecs:${img.image_id}`)
    setImgError('')
    try {
      await post(
        `/api/v1/swas/${server.id}/custom-images/${encodeURIComponent(img.image_id)}/share-ecs`,
        { share: nextShare },
        SLOW_TIMEOUT_MS,
      )
      setImages((prev) =>
        prev.map((item) =>
          item.image_id === img.image_id ? { ...item, in_share_ecs: nextShare } : item,
        ),
      )
      onToast(
        nextShare ? '已共享该轻量镜像到同账号同地域 ECS' : '已取消共享到 ECS',
        'success',
      )
    } catch (err) {
      setImgError(err instanceof Error ? err.message : '切换 ECS 共享失败')
    } finally {
      setImgBusy('')
    }
  }

  async function handleDeleteCustomImage(imageId: string) {
    setImgBusy(`del:${imageId}`)
    setImgError('')
    try {
      await del(
        `/api/v1/swas/${server.id}/custom-images/${encodeURIComponent(imageId)}`,
        SLOW_TIMEOUT_MS,
      )
      setImages((prev) => prev.filter((item) => item.image_id !== imageId))
      if (expandedImageId === imageId) setExpandedImageId(null)
      onToast(`已删除自定义镜像 ${imageId}`, 'success')
    } catch (err) {
      setImgError(err instanceof Error ? err.message : '删除自定义镜像失败')
    } finally {
      setImgBusy('')
    }
  }

  function toggleSharePanel(imageId: string) {
    if (expandedImageId === imageId) {
      setExpandedImageId(null)
      setSharesError('')
      return
    }
    setExpandedImageId(imageId)
    setSharesError('')
    setTargetPickKey(shareTargets[0]?.key ?? '')
    setManualUid('')
    void loadShares(imageId)
  }

  async function applyCrossShare(
    imageId: string,
    busyKey: string,
    payload: {
      action: 'add' | 'remove'
      account_id?: string
      target_swas_id?: number
      target_server_id?: number
    },
    successMsg: string,
  ) {
    setShareBusyKey(busyKey)
    setSharesError('')
    try {
      const res = await post<{ ok: boolean; account_id: string; accounts: SwasShareAccount[] }>(
        `/api/v1/swas/${server.id}/custom-images/${encodeURIComponent(imageId)}/shares`,
        payload,
        SLOW_TIMEOUT_MS,
      )
      const next = res.accounts ?? []
      setSharesByImage((prev) => ({ ...prev, [imageId]: next }))
      setImages((prev) =>
        prev.map((item) =>
          item.image_id === imageId ? { ...item, in_share_user: next.length > 0 } : item,
        ),
      )
      if (payload.action === 'add' && payload.account_id) setManualUid('')
      onToast(successMsg, 'success')
    } catch (err) {
      setSharesError(err instanceof Error ? err.message : '更新跨账号共享失败')
    } finally {
      setShareBusyKey('')
    }
  }

  const systemSnapshots = snapshots.filter((s) => s.source_disk_type.toLowerCase() === 'system')
  const dataSnapshots = snapshots.filter((s) => s.source_disk_type.toLowerCase() === 'data')
  const listRef = useRef<HTMLDivElement>(null)

  return (
    <Modal
      wide
      title={`快照与镜像共享 · ${server.label || server.instance_id}`}
      icon={<Layers size={16} style={{ color: 'var(--accent)' }} />}
      onClose={onClose}
      footer={
        <>
          <span className="hint" style={{ margin: 0 }}>
            轻量自定义镜像需先创建系统盘快照，支持共享给同账号 ECS 及其他阿里云主账号
          </span>
          <span className="spacer" />
          <button type="button" className="btn primary sm" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <div className="img-account-bar">
        <div className="img-account-meta">
          <span>
            当前地域：<strong>{regionLabel(server.region_id)}</strong>{' '}
            <code className="mono">{server.region_id}</code>
          </span>
          <span>
            主账号 UID：
            {accountLoading ? (
              <LoaderCircle size={12} className="spin" style={{ verticalAlign: 'middle' }} />
            ) : accountId ? (
              <code className="mono">{accountId}</code>
            ) : (
              <span className="hint">暂不可用</span>
            )}
          </span>
        </div>
        {accountId && (
          <button type="button" className="btn ghost sm" onClick={() => void copyAccountId()}>
            {copiedUid ? <Check size={12} /> : <Copy size={12} />}
            {copiedUid ? '已复制 UID' : '复制 UID'}
          </button>
        )}
      </div>

      <div className="img-toolbar">
        <Segmented value={tab} options={SWAS_IMG_TABS} onChange={setTab} />
        <div className="img-toolbar-actions">
          <button
            type="button"
            className="btn ghost sm"
            disabled={tab === 'images' ? imgLoading : snapLoading}
            onClick={() => (tab === 'images' ? void loadCustomImages() : void loadSnapshots())}
          >
            {(tab === 'images' ? imgLoading : snapLoading) ? (
              <LoaderCircle size={12} className="spin" />
            ) : (
              <RefreshCw size={12} />
            )}{' '}
            刷新
          </button>
          {tab === 'images' ? (
            <button
              type="button"
              className={`btn sm${imgCreateOpen ? '' : ' primary'}`}
              onClick={() => {
                setImgError('')
                if (!imgCreateOpen) setImgName(defaultTimestampName('swas-img'))
                setImgCreateOpen((prev) => !prev)
              }}
            >
              <Plus size={12} /> {imgCreateOpen ? '收起表单' : '从快照制作镜像'}
            </button>
          ) : (
            <button
              type="button"
              className={`btn sm${snapCreateOpen ? '' : ' primary'}`}
              onClick={() => {
                setSnapError('')
                if (!snapCreateOpen) setSnapName(defaultTimestampName('snap'))
                setSnapCreateOpen((prev) => !prev)
              }}
            >
              <Camera size={12} /> {snapCreateOpen ? '收起表单' : '创建磁盘快照'}
            </button>
          )}
        </div>
      </div>

      <div ref={listRef}>
        {tab === 'images' ? (
          <>
            {imgCreateOpen && (
              <div className="img-create-box">
                <div className="img-create-head">
                  <span>基于系统盘快照制作自定义镜像</span>
                  <span className="hint" style={{ margin: 0 }}>
                    {systemSnapshots.length === 0
                      ? '当前尚无系统盘快照，请先切到「磁盘快照」创建'
                      : `已发现 ${systemSnapshots.length} 个系统盘快照`}
                  </span>
                </div>
                <div className="grid-2">
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor="swas-img-name">镜像名称（必填）</label>
                    <input
                      id="swas-img-name"
                      className="input"
                      value={imgName}
                      disabled={Boolean(imgBusy)}
                      onChange={(event) => setImgName(event.target.value)}
                      placeholder="例如 swas-prod-20261120"
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor="swas-img-sys-snap">系统盘快照（必填）</label>
                    <select
                      id="swas-img-sys-snap"
                      className="select"
                      value={imgSysSnapId}
                      disabled={Boolean(imgBusy) || systemSnapshots.length === 0}
                      onChange={(event) => setImgSysSnapId(event.target.value)}
                    >
                      {systemSnapshots.length === 0 ? (
                        <option value="">请先创建系统盘快照</option>
                      ) : (
                        systemSnapshots.map((s) => (
                          <option key={s.snapshot_id} value={s.snapshot_id}>
                            {s.snapshot_name || s.snapshot_id} ({s.snapshot_id})
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                </div>
                <div className="grid-2" style={{ marginTop: 10 }}>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor="swas-img-data-snap">数据盘快照（可选）</label>
                    <select
                      id="swas-img-data-snap"
                      className="select"
                      value={imgDataSnapId}
                      disabled={Boolean(imgBusy)}
                      onChange={(event) => setImgDataSnapId(event.target.value)}
                    >
                      <option value="">不附加数据盘快照</option>
                      {dataSnapshots.map((s) => (
                        <option key={s.snapshot_id} value={s.snapshot_id}>
                          {s.snapshot_name || s.snapshot_id} ({s.snapshot_id})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor="swas-img-desc">镜像描述（可选）</label>
                    <input
                      id="swas-img-desc"
                      className="input"
                      value={imgDesc}
                      disabled={Boolean(imgBusy)}
                      onChange={(event) => setImgDesc(event.target.value)}
                      placeholder="备注环境、应用或用途"
                    />
                  </div>
                </div>
                <div className="img-create-actions">
                  {systemSnapshots.length === 0 && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        setTab('snapshots')
                        setSnapCreateOpen(true)
                      }}
                    >
                      <Camera size={12} /> 前往创建快照
                    </button>
                  )}
                  <span className="spacer" />
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={Boolean(imgBusy)}
                    onClick={() => setImgCreateOpen(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={Boolean(imgBusy) || !imgSysSnapId}
                    onClick={() => void submitCreateCustomImage()}
                  >
                    {imgBusy === 'create' ? <LoaderCircle size={12} className="spin" /> : <Plus size={12} />}
                    创建自定义镜像
                  </button>
                </div>
              </div>
            )}

            {imgError && (
              <div className="auth-error" style={{ marginBottom: 10 }}>
                <TriangleAlert size={14} />
                {imgError}
              </div>
            )}

            {imgLoading ? (
              <div className="manage-center">
                <LoaderCircle size={20} className="spin" />
                <span>正在加载轻量自定义镜像…</span>
              </div>
            ) : images.length === 0 ? (
              <div className="manage-center">
                <Layers size={20} style={{ opacity: 0.45 }} />
                <span>
                  当前地域暂无轻量自定义镜像。可先在「磁盘快照」中创建系统盘快照，再一键制作自定义镜像。
                </span>
              </div>
            ) : (
              <div className="img-cards">
                {images.map((img) => {
                  const st = snapshotStatusBadge(img.status)
                  const expanded = expandedImageId === img.image_id
                  const shares = sharesByImage[img.image_id] ?? []
                  return (
                    <div className={`img-card${expanded ? ' expanded' : ''}`} key={img.image_id}>
                      <div className="img-card-head">
                        <div className="img-card-main">
                          <div className="img-card-title">
                            <strong>{img.name || img.image_id}</strong>
                            <Badge tone={st.tone}>{st.label}</Badge>
                            {img.in_share_ecs && <Badge tone="blue">已共享至 ECS</Badge>}
                            {img.in_share_user && <Badge tone="green">已跨账号共享</Badge>}
                          </div>
                          <div className="img-card-meta">
                            <code className="mono">{img.image_id}</code>
                            {img.os_type && <span>{img.os_type}</span>}
                            {img.required_system_disk_size > 0 && (
                              <span>系统盘 {img.required_system_disk_size} GiB</span>
                            )}
                            {img.system_snapshot_id && (
                              <span>快照 {img.system_snapshot_id}</span>
                            )}
                            {img.creation_time && <span>创建于 {formatIso(img.creation_time)}</span>}
                          </div>
                          {img.description && <div className="img-card-desc">{img.description}</div>}
                        </div>

                        <div className="img-card-actions">
                          <button
                            type="button"
                            className={`btn sm${img.in_share_ecs ? '' : ' ghost'}`}
                            disabled={Boolean(imgBusy)}
                            title={
                              img.in_share_ecs
                                ? '取消共享到同账号同地域的 ECS 服务'
                                : '将轻量自定义镜像共享到同账号同地域的 ECS 使用'
                            }
                            onClick={() => void handleToggleShareEcs(img)}
                          >
                            {imgBusy === `ecs:${img.image_id}` ? (
                              <LoaderCircle size={12} className="spin" />
                            ) : (
                              <Share2 size={12} />
                            )}
                            {img.in_share_ecs ? '取消 ECS 共享' : '共享到 ECS'}
                          </button>
                          <button
                            type="button"
                            className={`btn sm${expanded ? ' primary' : ''}`}
                            onClick={() => toggleSharePanel(img.image_id)}
                          >
                            <UserPlus size={12} /> {expanded ? '收起共享' : '跨账号共享'}
                          </button>
                          <button
                            type="button"
                            className="btn ghost icon sm"
                            title="删除自定义镜像"
                            disabled={Boolean(imgBusy)}
                            onClick={() => void handleDeleteCustomImage(img.image_id)}
                          >
                            {imgBusy === `del:${img.image_id}` ? (
                              <LoaderCircle size={13} className="spin" />
                            ) : (
                              <Trash2 size={13} style={{ color: 'var(--red)' }} />
                            )}
                          </button>
                        </div>
                      </div>

                      {expanded && (
                        <div className="img-share-box">
                          <div className="img-share-section-title">
                            <span>已共享阿里云账号（{shares.length}）</span>
                            <button
                              type="button"
                              className="btn ghost sm"
                              disabled={sharesLoading}
                              onClick={() => void loadShares(img.image_id)}
                            >
                              {sharesLoading ? (
                                <LoaderCircle size={11} className="spin" />
                              ) : (
                                <RefreshCw size={11} />
                              )}{' '}
                              刷新
                            </button>
                          </div>

                          {sharesError && (
                            <div className="auth-error" style={{ marginBottom: 8 }}>
                              <TriangleAlert size={13} />
                              {sharesError}
                            </div>
                          )}

                          {sharesLoading ? (
                            <div className="manage-center compact">
                              <LoaderCircle size={14} className="spin" />
                              <span>正在读取跨账号共享列表…</span>
                            </div>
                          ) : shares.length === 0 ? (
                            <div className="hint" style={{ margin: 0 }}>
                              尚未共享给其他阿里云账号。可在下方选择面板中的服务器或输入对方主账号 UID 添加。
                            </div>
                          ) : (
                            <div className="img-share-list">
                              {shares.map((acc) => {
                                const removing = shareBusyKey === `rm:${img.image_id}:${acc.user_id}`
                                return (
                                  <div className="img-share-row" key={acc.user_id}>
                                    <div className="img-share-row-info">
                                      <code className="mono">{acc.user_id}</code>
                                      {acc.shared_time && (
                                        <span className="img-share-time">
                                          共享于 {formatIso(acc.shared_time)}
                                        </span>
                                      )}
                                    </div>
                                    <button
                                      type="button"
                                      className="btn danger sm"
                                      disabled={Boolean(shareBusyKey)}
                                      onClick={() =>
                                        void applyCrossShare(
                                          img.image_id,
                                          `rm:${img.image_id}:${acc.user_id}`,
                                          { action: 'remove', account_id: acc.user_id },
                                          `已取消对账号 ${acc.user_id} 的镜像共享`,
                                        )
                                      }
                                    >
                                      {removing ? (
                                        <LoaderCircle size={12} className="spin" />
                                      ) : (
                                        <UserMinus size={12} />
                                      )}
                                      取消共享
                                    </button>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          <div className="img-share-controls">
                            <div className="img-share-panel">
                              <label htmlFor={`swas-share-srv-${img.image_id}`}>
                                方式一：共享给面板中另一台服务器所属账号
                              </label>
                              {shareTargets.length === 0 ? (
                                <div className="hint" style={{ margin: 0 }}>
                                  面板中暂无其他服务器，请使用右侧 UID 手动共享。
                                </div>
                              ) : (
                                <div className="img-share-inline">
                                  <select
                                    id={`swas-share-srv-${img.image_id}`}
                                    className="select"
                                    value={targetPickKey}
                                    disabled={Boolean(shareBusyKey)}
                                    onChange={(event) => setTargetPickKey(event.target.value)}
                                  >
                                    {shareTargets.map((t) => (
                                      <option key={t.key} value={t.key}>
                                        {t.label}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    className="btn primary sm"
                                    disabled={!targetPickKey || Boolean(shareBusyKey)}
                                    onClick={() => {
                                      const picked = shareTargets.find((t) => t.key === targetPickKey)
                                      if (!picked) return
                                      void applyCrossShare(
                                        img.image_id,
                                        `add-srv:${img.image_id}`,
                                        {
                                          action: 'add',
                                          target_swas_id: picked.target_swas_id || undefined,
                                          target_server_id: picked.target_server_id || undefined,
                                        },
                                        `已共享给 ${picked.label}`,
                                      )
                                    }}
                                  >
                                    {shareBusyKey === `add-srv:${img.image_id}` ? (
                                      <LoaderCircle size={12} className="spin" />
                                    ) : (
                                      <UserPlus size={12} />
                                    )}
                                    添加共享
                                  </button>
                                </div>
                              )}
                            </div>

                            <div className="img-share-panel">
                              <label htmlFor={`swas-share-uid-${img.image_id}`}>
                                方式二：输入目标阿里云主账号 UID
                              </label>
                              <div className="img-share-inline">
                                <input
                                  id={`swas-share-uid-${img.image_id}`}
                                  className="input mono"
                                  value={manualUid}
                                  disabled={Boolean(shareBusyKey)}
                                  onChange={(event) => setManualUid(event.target.value)}
                                  placeholder="纯数字主账号 UID，如 1234567890123456"
                                />
                                <button
                                  type="button"
                                  className="btn primary sm"
                                  disabled={!manualUid.trim() || Boolean(shareBusyKey)}
                                  onClick={() => {
                                    const uid = manualUid.trim()
                                    if (!/^\d{6,24}$/.test(uid)) {
                                      setSharesError('请输入 6–24 位纯数字阿里云主账号 UID')
                                      return
                                    }
                                    void applyCrossShare(
                                      img.image_id,
                                      `add-uid:${img.image_id}`,
                                      { action: 'add', account_id: uid },
                                      `已共享给账号 ${uid}`,
                                    )
                                  }}
                                >
                                  {shareBusyKey === `add-uid:${img.image_id}` ? (
                                    <LoaderCircle size={12} className="spin" />
                                  ) : (
                                    <UserPlus size={12} />
                                  )}
                                  添加 UID
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        ) : (
          <>
            {snapCreateOpen && (
              <div className="img-create-box">
                <div className="img-create-head">
                  <span>为实例 {server.instance_id} 的磁盘创建快照</span>
                  <span className="hint" style={{ margin: 0 }}>
                    系统盘快照可用于制作轻量自定义镜像与跨账号共享
                  </span>
                </div>
                <div className="grid-2">
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor="swas-snap-disk">选择磁盘</label>
                    <select
                      id="swas-snap-disk"
                      className="select"
                      value={snapDiskId}
                      disabled={Boolean(snapBusy) || disks.length === 0}
                      onChange={(event) => setSnapDiskId(event.target.value)}
                    >
                      {disks.length === 0 ? (
                        <option value="">暂无磁盘</option>
                      ) : (
                        disks.map((d) => (
                          <option key={d.disk_id} value={d.disk_id}>
                            {d.disk_type.toLowerCase() === 'system' ? '系统盘' : '数据盘'} ·{' '}
                            {d.size} GiB ({d.disk_id})
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor="swas-snap-name">快照名称（2–50 字符）</label>
                    <input
                      id="swas-snap-name"
                      className="input"
                      value={snapName}
                      disabled={Boolean(snapBusy)}
                      onChange={(event) => setSnapName(event.target.value)}
                      placeholder="例如 snap-20261120"
                    />
                  </div>
                </div>
                <div className="img-create-actions">
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={Boolean(snapBusy)}
                    onClick={() => setSnapCreateOpen(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={Boolean(snapBusy) || !snapDiskId}
                    onClick={() => void submitCreateSnapshot()}
                  >
                    {snapBusy === 'create' ? <LoaderCircle size={12} className="spin" /> : <Camera size={12} />}
                    开始创建快照
                  </button>
                </div>
              </div>
            )}

            {snapError && (
              <div className="auth-error" style={{ marginBottom: 10 }}>
                <TriangleAlert size={14} />
                {snapError}
              </div>
            )}

            {snapLoading ? (
              <div className="manage-center">
                <LoaderCircle size={20} className="spin" />
                <span>正在加载轻量磁盘快照…</span>
              </div>
            ) : snapshots.length === 0 ? (
              <div className="manage-center">
                <Camera size={20} style={{ opacity: 0.45 }} />
                <span>当前实例暂无磁盘快照，点击上方「创建磁盘快照」即可备份系统盘或数据盘。</span>
              </div>
            ) : (
              <div className="img-cards">
                {snapshots.map((snap) => {
                  const st = snapshotStatusBadge(snap.status, snap.progress)
                  const isSystem = snap.source_disk_type.toLowerCase() === 'system'
                  return (
                    <div className="img-card" key={snap.snapshot_id}>
                      <div className="img-card-head">
                        <div className="img-card-main">
                          <div className="img-card-title">
                            <strong>{snap.snapshot_name || snap.snapshot_id}</strong>
                            <Badge tone={st.tone}>{st.label}</Badge>
                            <Badge tone={isSystem ? 'blue' : 'gray'}>
                              {isSystem ? '系统盘快照' : '数据盘快照'}
                            </Badge>
                          </div>
                          <div className="img-card-meta">
                            <code className="mono">{snap.snapshot_id}</code>
                            {snap.source_disk_id && <span>源盘 {snap.source_disk_id}</span>}
                            {snap.creation_time && <span>创建于 {formatIso(snap.creation_time)}</span>}
                          </div>
                        </div>
                        <div className="img-card-actions">
                          {isSystem && (
                            <button
                              type="button"
                              className="btn sm"
                              onClick={() => {
                                setImgSysSnapId(snap.snapshot_id)
                                setImgName(defaultTimestampName('swas-img'))
                                setImgCreateOpen(true)
                                setTab('images')
                              }}
                            >
                              <Layers size={12} /> 制作镜像
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn ghost icon sm"
                            title="删除快照"
                            disabled={Boolean(snapBusy)}
                            onClick={() => void handleDeleteSnapshot(snap.snapshot_id)}
                          >
                            {snapBusy === `del:${snap.snapshot_id}` ? (
                              <LoaderCircle size={13} className="spin" />
                            ) : (
                              <Trash2 size={13} style={{ color: 'var(--red)' }} />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
