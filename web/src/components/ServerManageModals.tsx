import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  CheckCircle2,
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
  Trash2,
  TriangleAlert,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react'
import { SLOW_TIMEOUT_MS, api, del, post } from '../api'
import { regionLabel } from '../regions'
import type {
  EcsImage,
  ImageShareAccount,
  InstanceDetail,
  InstanceDisk,
  ReinstallPhase,
  Server,
} from '../types'
import { Badge, Modal, Segmented, statusLabel, statusTone } from './ui'

const CHARGE_LABELS: Record<string, string> = {
  PrePaid: '包年包月',
  PostPaid: '按量付费',
  Subscription: '包年包月',
  PayAsYouGo: '按量付费',
  PayByBandwidth: '按固定带宽',
  PayByTraffic: '按使用流量',
}

const DISK_CATEGORY_LABELS: Record<string, string> = {
  cloud: '普通云盘',
  cloud_efficiency: '高效云盘',
  cloud_ssd: 'SSD 云盘',
  cloud_essd: 'ESSD 云盘',
  cloud_auto: 'ESSD AutoPL',
  ephemeral_ssd: '本地 SSD 盘',
}

const DISK_STATUS_LABELS: Record<string, string> = {
  In_use: '使用中',
  Available: '待挂载',
  Attaching: '挂载中',
  Detaching: '卸载中',
  Creating: '创建中',
  ReIniting: '初始化中',
}

function formatCharge(type?: string): string {
  if (!type) return '—'
  return CHARGE_LABELS[type] ?? type
}

function formatMemory(memoryMb: number): string {
  if (!memoryMb) return '—'
  const gb = memoryMb / 1024
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GiB`
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
  return diffDays >= 0 && diffDays <= 30
}

/* ============================================================================
   1. 实例详情弹窗（基本信息 / 网络信息 / 磁盘信息）
   ========================================================================== */

export function ServerDetailModal({
  server,
  onClose,
  onOpenVnc,
  onOpenReinstall,
  onOpenImages,
}: {
  server: Server
  onClose: () => void
  onOpenVnc: (server: Server) => void
  onOpenReinstall: (server: Server) => void
  onOpenImages?: (server: Server) => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<InstanceDetail | null>(null)
  const [disks, setDisks] = useState<InstanceDisk[]>([])
  const [diskError, setDiskError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api<{
        detail: InstanceDetail
        disks: InstanceDisk[]
        disk_error?: string
      }>(`/api/v1/servers/${server.id}/detail`)
      setDetail(res.detail)
      setDisks(res.disks ?? [])
      setDiskError(res.disk_error ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载实例详情失败')
    } finally {
      setLoading(false)
    }
  }, [server.id])

  useEffect(() => {
    void load()
  }, [load])

  const expiring = isExpiringSoon(detail?.expired_time)

  return (
    <Modal
      wide
      title={`实例详情 · ${server.label || server.instance_id}`}
      icon={<Info size={16} style={{ color: 'var(--accent)' }} />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost sm" disabled={loading} onClick={() => void load()}>
            {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} 刷新
          </button>
          <span className="spacer" />
          {onOpenImages && (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                onClose()
                onOpenImages(server)
              }}
            >
              <Layers size={13} /> 镜像管理
            </button>
          )}
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              onClose()
              onOpenVnc(server)
            }}
          >
            <Monitor size={13} /> VNC 终端
          </button>
          <button
            type="button"
            className="btn sm danger"
            onClick={() => {
              onClose()
              onOpenReinstall(server)
            }}
          >
            <Disc3 size={13} /> 重装系统
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
          <span>正在从阿里云拉取实例与磁盘详情…</span>
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
                  {statusLabel(detail.status, detail.stopped_mode)}
                </Badge>
              </div>
              <div className="detail-row">
                <span>实例规格</span>
                <code className="mono">{detail.instance_type || '—'}</code>
              </div>
              <div className="detail-row">
                <span>计算资源</span>
                <span>
                  {detail.cpu ? `${detail.cpu} vCPU` : '—'} / {formatMemory(detail.memory)}
                </span>
              </div>
              <div className="detail-row">
                <span>操作系统</span>
                <span>{detail.os_name || detail.os_type || '—'}</span>
              </div>
              <div className="detail-row">
                <span>付费类型</span>
                <span>{formatCharge(detail.instance_charge_type)}</span>
              </div>
              <div className="detail-row">
                <span>创建时间</span>
                <span>{formatIso(detail.creation_time)}</span>
              </div>
              <div className="detail-row">
                <span>到期时间</span>
                <span className={expiring ? 'text-danger' : ''}>
                  {detail.expired_time ? formatIso(detail.expired_time) : '按量无到期'}
                  {expiring ? '（即将到期）' : ''}
                </span>
              </div>
            </div>
          </div>

          <div className="detail-panel">
            <div className="detail-panel-head">网络信息</div>
            <div className="detail-rows">
              <div className="detail-row">
                <span>地域 / 可用区</span>
                <span>
                  {regionLabel(detail.region_id)}
                  {detail.zone_id ? ` · ${detail.zone_id}` : ''}
                </span>
              </div>
              <div className="detail-row">
                <span>公网 IP</span>
                <code className="mono">
                  {detail.public_ips.length ? detail.public_ips.join(', ') : '—'}
                </code>
              </div>
              <div className="detail-row">
                <span>内网 IP</span>
                <code className="mono">
                  {detail.private_ips.length ? detail.private_ips.join(', ') : '—'}
                </code>
              </div>
              <div className="detail-row">
                <span>公网带宽</span>
                <span>
                  {detail.internet_max_bandwidth_out} Mbps（{formatCharge(detail.internet_charge_type)}）
                </span>
              </div>
              <div className="detail-row">
                <span>网络类型</span>
                <span>{detail.network_type || '—'}</span>
              </div>
              <div className="detail-row">
                <span>VPC ID</span>
                <code className="mono">{detail.vpc_id || '—'}</code>
              </div>
              <div className="detail-row">
                <span>交换机 ID</span>
                <code className="mono">{detail.vswitch_id || '—'}</code>
              </div>
              <div className="detail-row">
                <span>安全组</span>
                <code className="mono">
                  {detail.security_group_ids.length ? detail.security_group_ids.join(', ') : '—'}
                </code>
              </div>
            </div>
          </div>

          <div className="detail-panel span-2">
            <div className="detail-panel-head">
              <HardDrive size={13} /> 磁盘信息（{disks.length}）
            </div>
            {diskError ? (
              <div className="hint" style={{ padding: '10px 14px' }}>
                磁盘列表读取失败：{diskError}
              </div>
            ) : disks.length === 0 ? (
              <div className="hint" style={{ padding: '10px 14px' }}>
                暂无挂载磁盘数据
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
                    {disks.map((disk) => (
                      <tr key={disk.disk_id}>
                        <td className="mono">{disk.disk_id}</td>
                        <td>{disk.type === 'system' ? '系统盘' : '数据盘'}</td>
                        <td className="mono">{disk.size} GiB</td>
                        <td>{DISK_CATEGORY_LABELS[disk.category] ?? (disk.category || '—')}</td>
                        <td>{DISK_STATUS_LABELS[disk.status] ?? (disk.status || '—')}</td>
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
   2. 全屏内置 VNC 远程连接（通过阿里云官方 VNC 前端嵌入 iframe）
   ========================================================================== */

export function ServerVncOverlay({
  server,
  onClose,
}: {
  server: Server
  onClose: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [iframeSrc, setIframeSrc] = useState('')
  const [consoleUrl, setConsoleUrl] = useState('')

  const connect = useCallback(async () => {
    setLoading(true)
    setError('')
    setIframeSrc('')
    try {
      const res = await post<{
        vnc_url: string
        console_url: string
        instance_id: string
        os_name?: string
        os_type?: string
      }>(`/api/v1/servers/${server.id}/vnc`)
      setConsoleUrl(res.console_url || '')
      const isWindows =
        (res.os_type || '').toLowerCase() === 'windows' ||
        (res.os_name || '').toLowerCase().includes('windows')
      const fullUrl =
        'https://g.alicdn.com/aliyun/ecs-console-vnc2/0.0.8/index.html?vncUrl=' +
        encodeURIComponent(res.vnc_url) +
        '&instanceId=' +
        encodeURIComponent(res.instance_id) +
        '&isWindows=' +
        String(isWindows)
      setIframeSrc(fullUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取 VNC 连接地址失败')
      setLoading(false)
    }
  }, [server.id])

  useEffect(() => {
    void connect()
  }, [connect])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div className="vnc-overlay" role="dialog" aria-modal="true" aria-label="VNC 远程终端">
      <div className="vnc-bar">
        <div className="vnc-bar-info">
          <Monitor size={15} style={{ color: 'var(--accent)' }} />
          <strong>{server.label || server.instance_id}</strong>
          <code className="mono">{server.instance_id}</code>
        </div>
        <div className="vnc-bar-actions">
          <button type="button" className="btn ghost sm" onClick={() => void connect()}>
            <RefreshCw size={12} /> 重新连接
          </button>
          {consoleUrl && (
            <a
              className="btn ghost sm"
              href={consoleUrl}
              target="_blank"
              rel="noreferrer"
              title="若内置终端无法加载，可跳转到阿里云控制台打开"
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
            title={`VNC ${server.instance_id}`}
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
                <span>正在建立 VNC 远程连接…</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/* ============================================================================
   3. 重装系统弹窗（镜像筛选 + 密码/密钥对 + 三阶段自动轮询进度）
   ========================================================================== */

type ImageOwner = 'system' | 'self' | 'others' | 'marketplace'
type OsFilter = '' | 'linux' | 'windows'
type AuthMode = 'password' | 'keypair'

const OWNER_OPTIONS: { value: ImageOwner; label: string }[] = [
  { value: 'system', label: '公共镜像' },
  { value: 'self', label: '自定义' },
  { value: 'others', label: '共享' },
  { value: 'marketplace', label: '市场' },
]

const OS_OPTIONS: { value: OsFilter; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'linux', label: 'Linux' },
  { value: 'windows', label: 'Windows' },
]

const AUTH_OPTIONS: { value: AuthMode; label: string }[] = [
  { value: 'password', label: '设置新密码' },
  { value: 'keypair', label: 'SSH 密钥对' },
]

export function ServerReinstallModal({
  server,
  onClose,
  onCompleted,
}: {
  server: Server
  onClose: () => void
  onCompleted: () => void
}) {
  const [owner, setOwner] = useState<ImageOwner>('system')
  const [osFilter, setOsFilter] = useState<OsFilter>('linux')
  const [keyword, setKeyword] = useState('')
  const [images, setImages] = useState<EcsImage[]>([])
  const [loadingImages, setLoadingImages] = useState(true)
  const [imageError, setImageError] = useState('')
  const [selectedImage, setSelectedImage] = useState<EcsImage | null>(null)

  const [authMode, setAuthMode] = useState<AuthMode>('password')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [keyPairName, setKeyPairName] = useState('')
  const [keyPairs, setKeyPairs] = useState<string[]>([])
  const [diskSize, setDiskSize] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // 重装进度状态机
  const [phase, setPhase] = useState<ReinstallPhase | null>(null)
  const [progressMsg, setProgressMsg] = useState('')
  const timerRef = useRef<number | null>(null)
  const taskParamsRef = useRef<{
    image_id: string
    password: string
    key_pair_name: string
    system_disk_size: number
  } | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => () => clearTimer(), [clearTimer])

  const loadImages = useCallback(async () => {
    setLoadingImages(true)
    setImageError('')
    try {
      const qs = new URLSearchParams({ owner })
      if (osFilter) qs.set('ostype', osFilter)
      const res = await api<{ items: EcsImage[] }>(
        `/api/v1/servers/${server.id}/images?${qs.toString()}`,
      )
      setImages(res.items ?? [])
    } catch (err) {
      setImageError(err instanceof Error ? err.message : '加载镜像列表失败')
      setImages([])
    } finally {
      setLoadingImages(false)
    }
  }, [server.id, owner, osFilter])

  useEffect(() => {
    void loadImages()
  }, [loadImages])

  useEffect(() => {
    void api<{ items: string[] }>(`/api/v1/servers/${server.id}/keypairs`)
      .then((res) => setKeyPairs(res.items ?? []))
      .catch(() => setKeyPairs([]))
  }, [server.id])

  const pollProgress = useCallback(
    (currentPhase: ReinstallPhase) => {
      clearTimer()
      const params = taskParamsRef.current
      if (!params) return
      timerRef.current = window.setTimeout(() => {
        void post<{ status: ReinstallPhase; message?: string }>(
          `/api/v1/servers/${server.id}/reinstall-progress`,
          { ...params, phase: currentPhase },
          SLOW_TIMEOUT_MS,
        )
          .then((res) => {
            const next = res.status || currentPhase
            setPhase(next)
            setProgressMsg(res.message || '')
            if (next === 'completed') {
              onCompleted()
            } else if (next !== 'error') {
              pollProgress(next)
            }
          })
          .catch((err) => {
            setPhase('error')
            setProgressMsg(err instanceof Error ? err.message : '轮询重装进度失败')
          })
      }, 5000)
    },
    [clearTimer, onCompleted, server.id],
  )

  async function submitReinstall() {
    setError('')
    if (!selectedImage) {
      setError('请先选择目标镜像')
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
        setError('密码长度需为 8–30 位（阿里云要求同时含大小写字母、数字、特殊符号中的三类）')
        return
      }
    } else if (!keyPairName.trim()) {
      setError('请选择或输入 SSH 密钥对名称')
      return
    }

    const parsedDiskSize = diskSize.trim() ? parseInt(diskSize.trim(), 10) : 0
    if (diskSize.trim() && (!Number.isFinite(parsedDiskSize) || parsedDiskSize < 20)) {
      setError('系统盘容量留空则保持不变，填写时不能小于 20 GiB')
      return
    }

    const payload = {
      image_id: selectedImage.image_id,
      password: authMode === 'password' ? password : '',
      key_pair_name: authMode === 'keypair' ? keyPairName.trim() : '',
      system_disk_size: parsedDiskSize > 0 ? parsedDiskSize : 0,
    }

    setSubmitting(true)
    try {
      const res = await post<{ status: ReinstallPhase; message?: string }>(
        `/api/v1/servers/${server.id}/reinstall`,
        payload,
        SLOW_TIMEOUT_MS,
      )
      taskParamsRef.current = payload
      const nextPhase = res.status || 'reinstalling'
      setPhase(nextPhase)
      setProgressMsg(res.message || '重装任务已提交…')
      pollProgress(nextPhase)
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交重装失败')
    } finally {
      setSubmitting(false)
    }
  }

  const filteredImages = images.filter((img) => {
    const q = keyword.trim().toLowerCase()
    if (!q) return true
    return (
      (img.image_name || '').toLowerCase().includes(q) ||
      img.os_name.toLowerCase().includes(q) ||
      img.image_id.toLowerCase().includes(q) ||
      img.description.toLowerCase().includes(q)
    )
  })

  // 处于重装进度阶段
  if (phase !== null) {
    const stepState = (step: 1 | 2 | 3) => {
      if (phase === 'completed') return 'done'
      if (phase === 'stopping') return step === 1 ? 'active' : ''
      if (phase === 'reinstalling') return step === 1 ? 'done' : step === 2 ? 'active' : ''
      if (phase === 'starting') return step < 3 ? 'done' : 'active'
      return ''
    }
    return (
      <Modal
        title={`重装系统进度 · ${server.label || server.instance_id}`}
        icon={<Disc3 size={16} style={{ color: 'var(--accent)' }} />}
        onClose={() => {
          clearTimer()
          onClose()
        }}
        footer={
          <>
            <span className="foot-note">
              {phase === 'completed'
                ? '系统重装已完成并启动'
                : phase === 'error'
                  ? '可在阿里云控制台查看实例状态'
                  : '每 5 秒自动查询阿里云进度，请勿关闭窗口'}
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="btn primary sm"
              onClick={() => {
                clearTimer()
                onClose()
              }}
            >
              {phase === 'completed' || phase === 'error' ? '关闭' : '后台继续'}
            </button>
          </>
        }
      >
        <div className="reinstall-progress">
          <div className="reinstall-icon">
            {phase === 'completed' ? (
              <CheckCircle2 size={32} style={{ color: 'var(--green)' }} />
            ) : phase === 'error' ? (
              <TriangleAlert size={32} style={{ color: 'var(--red)' }} />
            ) : (
              <LoaderCircle size={32} className="spin" style={{ color: 'var(--accent)' }} />
            )}
          </div>
          <div className="reinstall-msg">{progressMsg}</div>
          <div className="reinstall-steps">
            <div className={`reinstall-step ${stepState(1)}`}>1. 停止实例</div>
            <div className={`reinstall-step ${stepState(2)}`}>2. 更换系统盘</div>
            <div className={`reinstall-step ${stepState(3)}`}>3. 自动开机</div>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      wide
      title={`重装系统 · ${server.label || server.instance_id}`}
      icon={<Disc3 size={16} style={{ color: 'var(--red)' }} />}
      onClose={onClose}
      footer={
        <>
          <span className="foot-note">
            {selectedImage ? `已选镜像：${selectedImage.os_name}` : '请先从列表选择一个镜像'}
          </span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={submitting || !selectedImage}
            onClick={() => void submitReinstall()}
          >
            {submitting ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}
            确认重装系统
          </button>
        </>
      }
    >
      <div className="reinstall-warn">
        <TriangleAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        <div>
          <strong>高风险操作：</strong>重装系统（更换系统盘）将<strong>彻底清空原系统盘所有数据</strong>，数据盘不受影响。若实例正在运行，系统会自动先普通停机、更换系统盘并重新开机。
        </div>
      </div>

      <div className="reinstall-filters">
        <div className="field">
          <label>镜像来源</label>
          <Segmented value={owner} options={OWNER_OPTIONS} onChange={setOwner} />
        </div>
        <div className="field">
          <label>操作系统</label>
          <Segmented value={osFilter} options={OS_OPTIONS} onChange={setOsFilter} />
        </div>
      </div>

      <div className="field">
        <label htmlFor="img-search">
          <Search size={12} /> 筛选镜像（{filteredImages.length}）
        </label>
        <input
          id="img-search"
          className="input"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索 Debian / Ubuntu / CentOS / Windows / 镜像 ID…"
        />
        {loadingImages ? (
          <div className="manage-center compact">
            <LoaderCircle size={15} className="spin" />
            <span>正在加载 {regionLabel(server.region_id)} 可用镜像…</span>
          </div>
        ) : imageError ? (
          <div className="auth-error" style={{ marginTop: 8 }}>
            <TriangleAlert size={14} />
            {imageError}
          </div>
        ) : filteredImages.length === 0 ? (
          <div className="hint" style={{ marginTop: 8 }}>
            没有匹配的镜像，请调整筛选条件。
          </div>
        ) : (
          <div className="image-list" role="listbox" aria-label="可用镜像列表">
            {filteredImages.map((img) => {
              const active = selectedImage?.image_id === img.image_id
              return (
                <button
                  type="button"
                  key={img.image_id}
                  className={`image-item${active ? ' selected' : ''}`}
                  onClick={() => setSelectedImage(img)}
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
        )}
      </div>

      <div className="field">
        <label>
          <KeyRound size={12} /> 登录凭证
        </label>
        <Segmented value={authMode} options={AUTH_OPTIONS} onChange={setAuthMode} />
      </div>

      {authMode === 'password' ? (
        <div className="grid-2">
          <div className="field">
            <label htmlFor="reinstall-pwd">新登录密码（8–30 位）</label>
            <input
              id="reinstall-pwd"
              type="password"
              className="input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="含大小写字母、数字、符号中三类"
              autoComplete="new-password"
            />
          </div>
          <div className="field">
            <label htmlFor="reinstall-pwd2">确认新密码</label>
            <input
              id="reinstall-pwd2"
              type="password"
              className="input"
              value={passwordConfirm}
              onChange={(event) => setPasswordConfirm(event.target.value)}
              placeholder="再次输入密码"
              autoComplete="new-password"
            />
          </div>
        </div>
      ) : (
        <div className="field">
          <label htmlFor="reinstall-kp">SSH 密钥对名称（仅 Linux 生效）</label>
          {keyPairs.length > 0 ? (
            <select
              id="reinstall-kp"
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
              id="reinstall-kp"
              className="input mono"
              value={keyPairName}
              onChange={(event) => setKeyPairName(event.target.value)}
              placeholder="输入阿里云已创建的 SSH 密钥对名称"
            />
          )}
        </div>
      )}

      <div className="field">
        <label htmlFor="reinstall-disk">系统盘容量（GiB，可选）</label>
        <input
          id="reinstall-disk"
          className="input"
          type="number"
          min={20}
          value={diskSize}
          onChange={(event) => setDiskSize(event.target.value)}
          placeholder="留空保持当前系统盘容量不变（不能小于原容量）"
        />
      </div>

      {error && (
        <div className="auth-error">
          <TriangleAlert size={14} />
          {error}
        </div>
      )}
    </Modal>
  )
}

/* ============================================================================
   4. 镜像管理与跨账号共享（制作镜像 / 删除镜像 / 共享给 B 服务器或 UID / 取消共享）
   ========================================================================== */

type ImageTab = 'self' | 'others'

const IMAGE_TABS: { value: ImageTab; label: string }[] = [
  { value: 'self', label: '自定义镜像' },
  { value: 'others', label: '共享给我的' },
]

function defaultImageName(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `img-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

function imageStatusBadge(
  status?: string,
  progress?: string,
): { tone: 'green' | 'amber' | 'blue' | 'red' | 'gray'; label: string } {
  switch (status) {
    case 'Available':
      return { tone: 'green', label: '可用' }
    case 'Creating':
      return { tone: 'amber', label: progress ? `创建中 ${progress}` : '创建中' }
    case 'Waiting':
      return { tone: 'blue', label: '排队中' }
    case 'CreateFailed':
      return { tone: 'red', label: '创建失败' }
    case 'UnAvailable':
      return { tone: 'red', label: '不可用' }
    default:
      return { tone: 'gray', label: status || '未知' }
  }
}

export function ServerImagesModal({
  server,
  servers,
  onClose,
  onToast,
}: {
  server: Server
  servers: Server[]
  onClose: () => void
  onToast: (message: string, tone?: 'success' | 'error' | 'info') => void
}) {
  const [tab, setTab] = useState<ImageTab>('self')
  const [accountId, setAccountId] = useState('')
  const [accountLoading, setAccountLoading] = useState(true)
  const [accountError, setAccountError] = useState('')
  const [copiedUid, setCopiedUid] = useState(false)

  const [images, setImages] = useState<EcsImage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 制作当前实例镜像
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState(defaultImageName)
  const [createDesc, setCreateDesc] = useState('')
  const [createError, setCreateError] = useState('')
  const [creating, setCreating] = useState(false)

  // 内联共享管理面板
  const [expandedImageId, setExpandedImageId] = useState<string | null>(null)
  const [sharesByImage, setSharesByImage] = useState<Record<string, ImageShareAccount[]>>({})
  const [sharesLoading, setSharesLoading] = useState(false)
  const [sharesError, setSharesError] = useState('')
  const [shareBusyKey, setShareBusyKey] = useState('')
  const [shareWarning, setShareWarning] = useState('')
  const [targetServerId, setTargetServerId] = useState('')
  const [manualUids, setManualUids] = useState('')

  // 删除镜像确认
  const [deleteTarget, setDeleteTarget] = useState<EcsImage | null>(null)
  const [deleteForce, setDeleteForce] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const listSeqRef = useRef(0)

  const otherServers = servers
    .filter((item) => item.id !== server.id)
    .sort((a, b) => {
      const aSame = a.region_id === server.region_id ? 0 : 1
      const bSame = b.region_id === server.region_id ? 0 : 1
      return aSame - bSame || a.id - b.id
    })

  const loadAccountId = useCallback(async () => {
    setAccountLoading(true)
    setAccountError('')
    try {
      const res = await api<{ account_id: string }>(`/api/v1/servers/${server.id}/account-id`)
      setAccountId(res.account_id || '')
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : '获取阿里云账号 UID 失败')
    } finally {
      setAccountLoading(false)
    }
  }, [server.id])

  const loadImages = useCallback(
    async (owner: ImageTab) => {
      const seq = ++listSeqRef.current
      setLoading(true)
      setError('')
      try {
        const res = await api<{ items: EcsImage[] }>(
          `/api/v1/servers/${server.id}/images?owner=${owner}&all_status=1`,
          { timeoutMs: SLOW_TIMEOUT_MS },
        )
        if (seq !== listSeqRef.current) return
        setImages(res.items ?? [])
      } catch (err) {
        if (seq !== listSeqRef.current) return
        setImages([])
        setError(err instanceof Error ? err.message : '加载镜像列表失败')
      } finally {
        if (seq === listSeqRef.current) setLoading(false)
      }
    },
    [server.id],
  )

  useEffect(() => {
    void loadAccountId()
  }, [loadAccountId])

  useEffect(() => {
    setExpandedImageId(null)
    setSharesError('')
    setShareWarning('')
    void loadImages(tab)
  }, [tab, loadImages])

  const loadShares = useCallback(
    async (imageId: string) => {
      setSharesLoading(true)
      setSharesError('')
      try {
        const res = await api<{ items: ImageShareAccount[] }>(
          `/api/v1/servers/${server.id}/images/${encodeURIComponent(imageId)}/shares`,
          { timeoutMs: SLOW_TIMEOUT_MS },
        )
        setSharesByImage((prev) => ({ ...prev, [imageId]: res.items ?? [] }))
      } catch (err) {
        setSharesError(err instanceof Error ? err.message : '加载镜像共享列表失败')
      } finally {
        setSharesLoading(false)
      }
    },
    [server.id],
  )

  function toggleSharePanel(imageId: string) {
    if (expandedImageId === imageId) {
      setExpandedImageId(null)
      setSharesError('')
      setShareWarning('')
      return
    }
    setExpandedImageId(imageId)
    setSharesError('')
    setShareWarning('')
    setTargetServerId(otherServers[0] ? String(otherServers[0].id) : '')
    setManualUids('')
    void loadShares(imageId)
  }

  async function copyAccountId() {
    if (!accountId) return
    try {
      await navigator.clipboard.writeText(accountId)
      setCopiedUid(true)
      onToast('已复制阿里云主账号 UID', 'success')
      window.setTimeout(() => setCopiedUid(false), 1800)
    } catch {
      onToast('复制失败，请手动选中 UID 复制', 'info')
    }
  }

  async function submitCreateImage() {
    const name = createName.trim()
    const desc = createDesc.trim()
    setCreateError('')
    if (name.length < 2 || name.length > 128) {
      setCreateError('镜像名称长度需为 2–128 个字符')
      return
    }
    if (/^https?:\/\//i.test(name)) {
      setCreateError('镜像名称不能以 http:// 或 https:// 开头')
      return
    }
    if (!/^[A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5:_-]*$/.test(name)) {
      setCreateError('镜像名称须以字母或中文开头，只能包含中英文、数字、冒号(:)、下划线(_)或短划线(-)')
      return
    }
    setCreating(true)
    try {
      const res = await post<{ image_id: string }>(
        `/api/v1/servers/${server.id}/images`,
        { image_name: name, description: desc },
        SLOW_TIMEOUT_MS,
      )
      onToast(`镜像创建任务已提交（${res.image_id}），制作完成后即可共享`, 'success')
      setCreateOpen(false)
      setCreateName(defaultImageName())
      setCreateDesc('')
      if (tab !== 'self') {
        setTab('self')
      } else {
        void loadImages('self')
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '创建镜像失败')
    } finally {
      setCreating(false)
    }
  }

  async function applyShareChange(
    imageId: string,
    busyKey: string,
    payload: { action: 'add' | 'remove'; target_server_id?: number; accounts?: string[] },
    successMessage: string,
  ) {
    setShareBusyKey(busyKey)
    setSharesError('')
    setShareWarning('')
    try {
      const res = await post<{
        ok: boolean
        shares: ImageShareAccount[]
        cross_region_warning?: string
      }>(
        `/api/v1/servers/${server.id}/images/${encodeURIComponent(imageId)}/shares`,
        payload,
        SLOW_TIMEOUT_MS,
      )
      const nextShares = res.shares ?? []
      setSharesByImage((prev) => ({ ...prev, [imageId]: nextShares }))
      setImages((prev) =>
        prev.map((img) =>
          img.image_id === imageId ? { ...img, is_self_shared: nextShares.length > 0 } : img,
        ),
      )
      if (res.cross_region_warning) {
        setShareWarning(res.cross_region_warning)
        onToast(res.cross_region_warning, 'info')
      } else {
        onToast(successMessage, 'success')
      }
      if (payload.action === 'add' && payload.accounts) {
        setManualUids('')
      }
    } catch (err) {
      setSharesError(err instanceof Error ? err.message : '更新镜像共享权限失败')
    } finally {
      setShareBusyKey('')
    }
  }

  function handleShareToServer(imageId: string) {
    const id = Number(targetServerId)
    if (!Number.isInteger(id) || id <= 0) {
      setSharesError('请先选择要共享给哪台服务器')
      return
    }
    const target = otherServers.find((item) => item.id === id)
    const label = target ? target.label || target.instance_id : `#${id}`
    void applyShareChange(
      imageId,
      `add-server:${imageId}`,
      { action: 'add', target_server_id: id },
      `已将镜像共享给「${label}」所在账号`,
    )
  }

  function handleShareToManualUids(imageId: string) {
    const parsed = Array.from(
      new Set(
        manualUids
          .split(/[\s,，、;；]+/)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    )
    if (parsed.length === 0) {
      setSharesError('请输入至少一个阿里云主账号 UID')
      return
    }
    if (parsed.length > 10) {
      setSharesError('阿里云单次最多添加 10 个共享账号，请分批操作')
      return
    }
    const invalidUid = parsed.find((uid) => !/^\d{6,32}$/.test(uid))
    if (invalidUid) {
      setSharesError(`UID「${invalidUid}」格式不正确，应为纯数字主账号 UID`)
      return
    }
    void applyShareChange(
      imageId,
      `add-uid:${imageId}`,
      { action: 'add', accounts: parsed },
      `已添加 ${parsed.length} 个共享账号`,
    )
  }

  async function confirmDeleteImage() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await del<{ ok: boolean }>(
        `/api/v1/servers/${server.id}/images/${encodeURIComponent(deleteTarget.image_id)}?force=${deleteForce ? '1' : '0'}`,
        SLOW_TIMEOUT_MS,
      )
      const deletedId = deleteTarget.image_id
      setImages((prev) => prev.filter((item) => item.image_id !== deletedId))
      if (expandedImageId === deletedId) setExpandedImageId(null)
      setDeleteTarget(null)
      setDeleteForce(false)
      onToast(`已删除镜像 ${deletedId}`, 'success')
    } catch (err) {
      onToast(err instanceof Error ? err.message : '删除镜像失败', 'error')
    } finally {
      setDeleting(false)
    }
  }

  const selectedTargetServer = otherServers.find((item) => String(item.id) === targetServerId) ?? null

  return (
    <>
      <Modal
        wide
        title={`镜像管理与共享 · ${server.label || server.instance_id}`}
        icon={<Layers size={16} style={{ color: 'var(--accent)' }} />}
        onClose={onClose}
        footer={
          <>
            <span className="hint" style={{ margin: 0 }}>
              自定义镜像支持跨账号共享（同地域生效）与随时取消共享
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
              当前主账号 UID：
              {accountLoading ? (
                <LoaderCircle size={12} className="spin" style={{ verticalAlign: 'middle' }} />
              ) : accountId ? (
                <code className="mono">{accountId}</code>
              ) : (
                <span className="text-danger">{accountError || '获取失败'}</span>
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
          <Segmented value={tab} options={IMAGE_TABS} onChange={setTab} />
          <div className="img-toolbar-actions">
            <button
              type="button"
              className="btn ghost sm"
              disabled={loading}
              onClick={() => void loadImages(tab)}
            >
              {loading ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />} 刷新
            </button>
            <button
              type="button"
              className={`btn sm${createOpen ? '' : ' primary'}`}
              onClick={() => {
                setCreateError('')
                if (!createOpen) setCreateName(defaultImageName())
                setCreateOpen((prev) => !prev)
              }}
            >
              <Plus size={12} /> {createOpen ? '收起制作表单' : '制作当前实例镜像'}
            </button>
          </div>
        </div>

        {createOpen && (
          <div className="img-create-box">
            <div className="img-create-head">
              <span>从实例 {server.instance_id} 制作自定义镜像</span>
              <span className="hint" style={{ margin: 0 }}>
                制作期间实例无需停机（建议先停止写入重要数据）
              </span>
            </div>
            <div className="grid-2">
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="create-img-name">镜像名称（必填）</label>
                <input
                  id="create-img-name"
                  className="input"
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  placeholder="例如 prod-hk-20261120"
                  disabled={creating}
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="create-img-desc">镜像描述（可选）</label>
                <input
                  id="create-img-desc"
                  className="input"
                  value={createDesc}
                  onChange={(event) => setCreateDesc(event.target.value)}
                  placeholder="备注用途或版本信息"
                  disabled={creating}
                />
              </div>
            </div>
            {createError && (
              <div className="auth-error" style={{ marginTop: 8 }}>
                <TriangleAlert size={13} />
                {createError}
              </div>
            )}
            <div className="img-create-actions">
              <button
                type="button"
                className="btn ghost sm"
                disabled={creating}
                onClick={() => setCreateOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn primary sm"
                disabled={creating}
                onClick={() => void submitCreateImage()}
              >
                {creating ? <LoaderCircle size={12} className="spin" /> : <Plus size={12} />}
                开始制作
              </button>
            </div>
          </div>
        )}

        {tab === 'others' && (
          <div className="img-notice info" style={{ marginBottom: 12 }}>
            <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              以下为其他阿里云账号共享给当前账号（{regionLabel(server.region_id)}）的镜像，可直接在当前服务器的「重装系统 → 共享」中选择使用。
            </span>
          </div>
        )}

        {loading ? (
          <div className="manage-center">
            <LoaderCircle size={20} className="spin" />
            <span>正在加载{tab === 'self' ? '自定义镜像' : '共享给我的镜像'}…</span>
          </div>
        ) : error ? (
          <div className="auth-error">
            <TriangleAlert size={14} />
            {error}
          </div>
        ) : images.length === 0 ? (
          <div className="manage-center">
            <Layers size={20} style={{ opacity: 0.45 }} />
            <span>
              {tab === 'self'
                ? `当前地域（${regionLabel(server.region_id)}）暂无自定义镜像，点击上方「制作当前实例镜像」即可创建。`
                : `当前地域（${regionLabel(server.region_id)}）暂无其他账号共享给你的镜像。`}
            </span>
          </div>
        ) : (
          <div className="img-cards">
            {images.map((img) => {
              const st = imageStatusBadge(img.status, img.progress)
              const expanded = tab === 'self' && expandedImageId === img.image_id
              const shares = sharesByImage[img.image_id] ?? []
              const canShare = !img.status || img.status === 'Available'
              return (
                <div className={`img-card${expanded ? ' expanded' : ''}`} key={img.image_id}>
                  <div className="img-card-head">
                    <div className="img-card-main">
                      <div className="img-card-title">
                        <strong>{img.image_name || img.os_name || img.image_id}</strong>
                        {img.status && <Badge tone={st.tone}>{st.label}</Badge>}
                        {tab === 'self' && img.is_self_shared && <Badge tone="blue">已共享</Badge>}
                      </div>
                      <div className="img-card-meta">
                        <code className="mono">{img.image_id}</code>
                        {img.os_name && <span>{img.os_name}</span>}
                        {img.architecture && <span>{img.architecture}</span>}
                        {img.size > 0 && <span>{img.size} GiB</span>}
                        {img.creation_time && <span>创建于 {formatIso(img.creation_time)}</span>}
                      </div>
                      {img.description && <div className="img-card-desc">{img.description}</div>}
                    </div>

                    {tab === 'self' && (
                      <div className="img-card-actions">
                        <button
                          type="button"
                          className={`btn sm${expanded ? ' primary' : ''}`}
                          onClick={() => toggleSharePanel(img.image_id)}
                        >
                          <Share2 size={12} /> {expanded ? '收起共享' : '共享管理'}
                        </button>
                        <button
                          type="button"
                          className="btn ghost icon sm"
                          title="删除自定义镜像"
                          onClick={() => {
                            setDeleteTarget(img)
                            setDeleteForce(Boolean(img.is_self_shared))
                          }}
                        >
                          <Trash2 size={13} style={{ color: 'var(--red)' }} />
                        </button>
                      </div>
                    )}
                  </div>

                  {expanded && (
                    <div className="img-share-box">
                      <div className="img-share-section-title">
                        <span>已共享账号（{shares.length}）</span>
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
                          刷新共享
                        </button>
                      </div>

                      {sharesLoading ? (
                        <div className="manage-center compact">
                          <LoaderCircle size={14} className="spin" />
                          <span>正在读取阿里云共享权限…</span>
                        </div>
                      ) : shares.length === 0 ? (
                        <div className="hint" style={{ margin: 0 }}>
                          当前尚未共享给任何其他阿里云账号。可在下方直接选择 B 服务器或输入对方主账号 UID 添加共享。
                        </div>
                      ) : (
                        <div className="img-share-list">
                          {shares.map((item) => {
                            const removing = shareBusyKey === `remove:${img.image_id}:${item.aliyun_id}`
                            return (
                              <div className="img-share-row" key={item.aliyun_id}>
                                <div className="img-share-row-info">
                                  <code className="mono">{item.aliyun_id}</code>
                                  {item.matched_servers.map((srv) => (
                                    <span
                                      className="img-share-chip"
                                      key={srv.id}
                                      title={`${srv.label} · ${regionLabel(srv.region_id)}`}
                                    >
                                      {srv.label}
                                    </span>
                                  ))}
                                  {item.shared_time && (
                                    <span className="img-share-time">
                                      共享于 {formatIso(item.shared_time)}
                                    </span>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  className="btn danger sm"
                                  disabled={Boolean(shareBusyKey)}
                                  onClick={() =>
                                    void applyShareChange(
                                      img.image_id,
                                      `remove:${img.image_id}:${item.aliyun_id}`,
                                      { action: 'remove', accounts: [item.aliyun_id] },
                                      `已取消对账号 ${item.aliyun_id} 的共享`,
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

                      {!canShare && (
                        <div className="img-notice">
                          <TriangleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                          <span>该镜像尚未就绪（状态：{st.label}），等待状态变为「可用」后即可添加共享。</span>
                        </div>
                      )}

                      <div className="img-share-controls">
                        <div className="img-share-panel">
                          <label htmlFor={`share-srv-${img.image_id}`}>
                            方式一：直接共享给面板中的 B 服务器
                          </label>
                          {otherServers.length === 0 ? (
                            <div className="hint" style={{ margin: 0 }}>
                              面板中暂无其他服务器，请先添加 B 服务器或使用右侧 UID 手动共享。
                            </div>
                          ) : (
                            <>
                              <div className="img-share-inline">
                                <select
                                  id={`share-srv-${img.image_id}`}
                                  className="select"
                                  value={targetServerId}
                                  disabled={!canShare || Boolean(shareBusyKey)}
                                  onChange={(event) => setTargetServerId(event.target.value)}
                                >
                                  {otherServers.map((item) => {
                                    const sameRegion = item.region_id === server.region_id
                                    return (
                                      <option key={item.id} value={String(item.id)}>
                                        {item.label || item.instance_id}（
                                        {sameRegion ? '同地域' : `跨地域·${regionLabel(item.region_id)}`}）
                                      </option>
                                    )
                                  })}
                                </select>
                                <button
                                  type="button"
                                  className="btn primary sm"
                                  disabled={!canShare || !targetServerId || Boolean(shareBusyKey)}
                                  onClick={() => handleShareToServer(img.image_id)}
                                >
                                  {shareBusyKey === `add-server:${img.image_id}` ? (
                                    <LoaderCircle size={12} className="spin" />
                                  ) : (
                                    <UserPlus size={12} />
                                  )}
                                  共享给它
                                </button>
                              </div>
                              {selectedTargetServer &&
                                selectedTargetServer.region_id !== server.region_id && (
                                  <div className="hint" style={{ margin: 0, color: 'var(--amber)' }}>
                                    提示：该服务器在 {regionLabel(selectedTargetServer.region_id)}，阿里云共享镜像仅在源地域（{regionLabel(server.region_id)}）生效。
                                  </div>
                                )}
                            </>
                          )}
                        </div>

                        <div className="img-share-panel">
                          <label htmlFor={`share-uid-${img.image_id}`}>
                            方式二：输入阿里云主账号 UID（支持多个）
                          </label>
                          <div className="img-share-inline">
                            <input
                              id={`share-uid-${img.image_id}`}
                              className="input mono"
                              value={manualUids}
                              disabled={!canShare || Boolean(shareBusyKey)}
                              onChange={(event) => setManualUids(event.target.value)}
                              placeholder="16 位 UID，多个用逗号或空格分隔"
                            />
                            <button
                              type="button"
                              className="btn primary sm"
                              disabled={!canShare || !manualUids.trim() || Boolean(shareBusyKey)}
                              onClick={() => handleShareToManualUids(img.image_id)}
                            >
                              {shareBusyKey === `add-uid:${img.image_id}` ? (
                                <LoaderCircle size={12} className="spin" />
                              ) : (
                                <UserPlus size={12} />
                              )}
                              添加共享
                            </button>
                          </div>
                        </div>
                      </div>

                      {shareWarning && (
                        <div className="img-notice">
                          <TriangleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                          <span>{shareWarning}</span>
                        </div>
                      )}

                      {sharesError && (
                        <div className="auth-error">
                          <TriangleAlert size={13} />
                          {sharesError}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Modal>

      {deleteTarget && (
        <Modal
          title="确认删除自定义镜像"
          icon={<TriangleAlert size={14} style={{ color: 'var(--red)' }} />}
          onClose={() => !deleting && setDeleteTarget(null)}
          footer={
            <>
              <button
                type="button"
                className="btn ghost"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={deleting}
                onClick={() => void confirmDeleteImage()}
              >
                {deleting ? '删除中…' : '确认删除'}
              </button>
            </>
          }
        >
          <div className="confirm-body">
            <p className="confirm-text">
              确定要删除自定义镜像「{deleteTarget.image_name || deleteTarget.image_id}」
              （<code className="mono">{deleteTarget.image_id}</code>）吗？
            </p>
            <p className="confirm-hint">
              删除后无法恢复；若已共享给其他账号，对方也将无法再使用该镜像创建或重装实例。
            </p>
            <label className="img-delete-force">
              <input
                type="checkbox"
                checked={deleteForce}
                disabled={deleting}
                onChange={(event) => setDeleteForce(event.target.checked)}
              />
              <span>强制删除（当镜像仍存在共享关系或被实例引用时勾选）</span>
            </label>
          </div>
        </Modal>
      )}
    </>
  )
}
