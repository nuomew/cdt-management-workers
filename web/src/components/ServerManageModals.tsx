import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  Disc3,
  ExternalLink,
  HardDrive,
  Info,
  KeyRound,
  LoaderCircle,
  Monitor,
  RefreshCw,
  RotateCcw,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react'
import { SLOW_TIMEOUT_MS, api, post } from '../api'
import { regionLabel } from '../regions'
import type {
  EcsImage,
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
}: {
  server: Server
  onClose: () => void
  onOpenVnc: (server: Server) => void
  onOpenReinstall: (server: Server) => void
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
                  <div className="image-item-name">{img.os_name || img.image_id}</div>
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
