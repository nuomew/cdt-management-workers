import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  CloudLightning,
  Copy,
  Flame,
  Globe2,
  LoaderCircle,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Unlink,
  X,
} from 'lucide-react'
import { SLOW_TIMEOUT_MS, api, del, post, put } from '../api'
import { timeAgo } from '../time'
import type {
  DnsAccount,
  EdgeOneAnalyticsResponse,
  EdgeOneAutoCertActionResult,
  EdgeOneAutoCertCheckSummary,
  EdgeOneAutoCertConfig,
  EdgeOneDomain,
  EdgeOneManagedCertOption,
  EdgeOneSite,
  EdgeOneTaskItem,
  EdgeOneZone,
} from '../types'
import { Badge, Empty, Modal, Segmented, Switch } from './ui'

type ToastFn = (message: string, tone?: 'success' | 'error' | 'info') => void

type Props = {
  onToast: ToastFn
  onGoDnsAccounts?: () => void
  onGoCerts?: () => void
}

type WorkTab = 'domains' | 'cache' | 'analytics'
type CacheActionKind = 'purge_url' | 'purge_prefix' | 'purge_host' | 'purge_all' | 'prefetch'

const DOMAINS_PAGE_SIZE = 10
const SITE_STORAGE_KEY = 'cdt_edgeone_site'

type DomainFormState = {
  mode: 'create' | 'edit'
  domainName: string
  origin: string
  backupOrigin: string
  hostHeader: string
  originProtocol: 'FOLLOW' | 'HTTP' | 'HTTPS'
  httpOriginPort: number
  httpsOriginPort: number
  ipv6Status: 'follow' | 'on' | 'off'
}

type CertModalState = {
  domain: EdgeOneDomain
  mode: 'sslcert' | 'eofreecert' | 'none'
  certSource: 'auto_apply' | 'managed' | 'manual'
  sslCertId: number
  manualCertId: string
  autoSync: boolean
  autoVerifyMode: 'auto' | 'dns_account' | 'tencent_auto'
  autoDnsAccountId: number
}

function parseCertExpireDays(d: EdgeOneDomain): {
  expireTime: string
  daysLeft: number | null
  certId: string
} {
  let bestMs = 0
  let bestTime = ''
  let bestCertId = ''
  for (const c of d.certificates) {
    const raw = (c.expireTime || '').trim()
    let ms = 0
    if (raw) {
      const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
        ? `${raw.replace(' ', 'T')}+08:00`
        : raw
      const parsed = Date.parse(normalized)
      if (Number.isFinite(parsed)) ms = parsed
    }
    if (!bestCertId && c.certId) {
      bestCertId = c.certId
      bestMs = ms
      bestTime = raw
    } else if (ms > bestMs) {
      bestMs = ms
      bestTime = raw
      if (c.certId) bestCertId = c.certId
    }
  }
  if (!bestMs) return { expireTime: bestTime, daysLeft: null, certId: bestCertId }
  const daysLeft = Math.ceil((bestMs - Date.now()) / 86_400_000)
  return { expireTime: bestTime, daysLeft, certId: bestCertId }
}

function areaLabel(area: string): string {
  if (area === 'mainland') return '中国大陆'
  if (area === 'overseas') return '全球（不含中国大陆）'
  if (area === 'global') return '全球'
  return area || '-'
}

function zoneTypeLabel(type: string): string {
  if (type === 'full') return 'NS 接入'
  if (type === 'partial') return 'CNAME 接入'
  if (type === 'dnsPodAccess') return 'DNSPod 托管'
  if (type === 'partialComposite') return '无域名接入'
  return type || '-'
}

function domainStatusBadge(status: string): {
  tone: 'green' | 'amber' | 'blue' | 'gray' | 'red'
  text: string
  pulse?: boolean
} {
  if (status === 'online') return { tone: 'green', text: '已启用' }
  if (status === 'offline') return { tone: 'gray', text: '已停用' }
  if (status === 'process') return { tone: 'blue', text: '部署中', pulse: true }
  if (status === 'forbidden' || status === 'banned') return { tone: 'red', text: '已封禁' }
  return { tone: 'amber', text: status || '未知' }
}

function taskStatusBadge(status: string): {
  tone: 'green' | 'blue' | 'red' | 'amber' | 'gray'
  text: string
} {
  if (status === 'success') return { tone: 'green', text: '已完成' }
  if (status === 'processing') return { tone: 'blue', text: '执行中' }
  if (status === 'failed' || status === 'invalid') return { tone: 'red', text: '失败' }
  if (status === 'timeout') return { tone: 'amber', text: '超时' }
  if (status === 'canceled') return { tone: 'gray', text: '已取消' }
  return { tone: 'gray', text: status || '-' }
}

function taskTypeLabel(type: string): string {
  if (type === 'purge_url') return 'URL 刷新'
  if (type === 'purge_prefix') return '目录刷新'
  if (type === 'purge_host') return '主机名刷新'
  if (type === 'purge_all') return '整站刷新'
  if (type === 'purge_cache_tag') return 'CacheTag'
  if (type === 'prefetch_url') return 'URL 预热'
  return type || '-'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let idx = 0
  let val = bytes
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024
    idx += 1
  }
  return `${val >= 100 ? val.toFixed(1) : val.toFixed(2)} ${units[idx]}`
}

function formatBps(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '0 bps'
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps']
  let idx = 0
  let val = bps
  while (val >= 1000 && idx < units.length - 1) {
    val /= 1000
    idx += 1
  }
  return `${val >= 100 ? val.toFixed(1) : val.toFixed(2)} ${units[idx]}`
}

function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  return Math.round(n).toLocaleString()
}

function formatShortTime(tsSec: number, range: '24h' | '7d'): string {
  const d = new Date(tsSec * 1000)
  const pad = (v: number) => String(v).padStart(2, '0')
  if (range === '7d') {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`
  }
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Lightweight responsive SVG area-line chart for EdgeOne L7 metrics. */
function EdgeOneMetricChart({
  title,
  points,
  color,
  formatVal,
  range,
}: {
  title: string
  points: { timestamp: number; value: number }[]
  color: string
  formatVal: (v: number) => string
  range: '24h' | '7d'
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const width = 560
  const height = 164
  const padL = 10
  const padR = 10
  const padT = 14
  const padB = 26
  const innerW = width - padL - padR
  const innerH = height - padT - padB

  const maxVal = useMemo(() => {
    let m = 0
    for (const p of points) if (p.value > m) m = p.value
    return m > 0 ? m * 1.12 : 1
  }, [points])

  if (points.length === 0) {
    return (
      <div className="card eo-chart-card">
        <div className="eo-chart-head">
          <strong>{title}</strong>
        </div>
        <div className="cloud-dns-empty-sm">当前时间窗口暂无数据</div>
      </div>
    )
  }

  const coords = points.map((p, idx) => {
    const x =
      points.length === 1
        ? padL + innerW / 2
        : padL + (idx / (points.length - 1)) * innerW
    const y = padT + innerH - (p.value / maxVal) * innerH
    return { x, y, ...p }
  })

  const lineD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
  const areaD = `${lineD} L${coords[coords.length - 1].x.toFixed(1)},${(padT + innerH).toFixed(1)} L${coords[0].x.toFixed(1)},${(padT + innerH).toFixed(1)} Z`
  const active = hoverIdx !== null && coords[hoverIdx] ? coords[hoverIdx] : coords[coords.length - 1]
  const gradId = `eo-grad-${title.replace(/[^a-zA-Z0-9]/g, '')}`

  return (
    <div className="card eo-chart-card">
      <div className="eo-chart-head">
        <strong>{title}</strong>
        <span className="eo-chart-readout mono">
          {formatShortTime(active.timestamp, range)} · <b>{formatVal(active.value)}</b>
        </span>
      </div>
      <svg
        className="eo-chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((ratio) => {
          const y = padT + innerH * ratio
          return (
            <line
              key={ratio}
              x1={padL}
              x2={width - padR}
              y1={y}
              y2={y}
              stroke="var(--line)"
              strokeDasharray="3 3"
              strokeWidth="1"
            />
          )
        })}
        <path d={areaD} fill={`url(#${gradId})`} />
        <path d={lineD} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {hoverIdx !== null && coords[hoverIdx] && (
          <>
            <line
              x1={coords[hoverIdx].x}
              x2={coords[hoverIdx].x}
              y1={padT}
              y2={padT + innerH}
              stroke={color}
              strokeOpacity="0.4"
              strokeWidth="1"
            />
            <circle cx={coords[hoverIdx].x} cy={coords[hoverIdx].y} r="3.5" fill={color} />
          </>
        )}
        <text x={padL} y={height - 6} fontSize="10" fill="var(--muted-soft)">
          {formatShortTime(points[0].timestamp, range)}
        </text>
        <text
          x={width - padR}
          y={height - 6}
          fontSize="10"
          fill="var(--muted-soft)"
          textAnchor="end"
        >
          {formatShortTime(points[points.length - 1].timestamp, range)}
        </text>
        {coords.map((c, idx) => {
          const sliceW = innerW / Math.max(1, coords.length)
          return (
            <rect
              key={c.timestamp}
              x={Math.max(padL, c.x - sliceW / 2)}
              y={padT}
              width={sliceW}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(idx)}
            />
          )
        })}
      </svg>
    </div>
  )
}

export default function EdgeOneView({ onToast, onGoDnsAccounts, onGoCerts }: Props) {
  const [accounts, setAccounts] = useState<DnsAccount[]>([])
  const [dnsAccounts, setDnsAccounts] = useState<DnsAccount[]>([])
  const [managedCerts, setManagedCerts] = useState<EdgeOneManagedCertOption[]>([])
  const [autoCert, setAutoCert] = useState<EdgeOneAutoCertConfig>({ enabled: true, days: 7 })
  const [savingAutoCert, setSavingAutoCert] = useState(false)
  const [checkingAutoCert, setCheckingAutoCert] = useState(false)
  const [selectedAccountId, setSelectedAccountId] = useState<number>(0)
  const [site, setSite] = useState<EdgeOneSite>(() => {
    try {
      return localStorage.getItem(SITE_STORAGE_KEY) === 'intl' ? 'intl' : 'cn'
    } catch {
      return 'cn'
    }
  })

  const [loadingBoot, setLoadingBoot] = useState(true)
  const [zones, setZones] = useState<EdgeOneZone[]>([])
  const [loadingZones, setLoadingZones] = useState(false)
  const [zonesError, setZonesError] = useState('')
  const [selectedZoneId, setSelectedZoneId] = useState('')
  const [zoneKeyword, setZoneKeyword] = useState('')

  const [workTab, setWorkTab] = useState<WorkTab>('domains')

  // Domains state
  const [domains, setDomains] = useState<EdgeOneDomain[]>([])
  const [loadingDomains, setLoadingDomains] = useState(false)
  const [domainsError, setDomainsError] = useState('')
  const [domainKeyword, setDomainKeyword] = useState('')
  const [domainPage, setDomainPage] = useState(1)
  const [busyDomain, setBusyDomain] = useState('')

  // Domain create/edit & delete modals
  const [domainModal, setDomainModal] = useState<DomainFormState | null>(null)
  const [savingDomain, setSavingDomain] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<EdgeOneDomain | null>(null)
  const [deletingDomain, setDeletingDomain] = useState(false)

  // Cert deployment modal
  const [certModal, setCertModal] = useState<CertModalState | null>(null)
  const [savingCert, setSavingCert] = useState(false)

  // Cache purge & prefetch state
  const [cacheAction, setCacheAction] = useState<CacheActionKind>('purge_url')
  const [purgeMethod, setPurgeMethod] = useState<'invalidate' | 'delete'>('invalidate')
  const [cacheTargetsText, setCacheTargetsText] = useState('')
  const [submittingCache, setSubmittingCache] = useState(false)
  const [taskKind, setTaskKind] = useState<'purge' | 'prefetch'>('purge')
  const [tasks, setTasks] = useState<EdgeOneTaskItem[]>([])
  const [loadingTasks, setLoadingTasks] = useState(false)

  // Analytics state
  const [analyticsRange, setAnalyticsRange] = useState<'24h' | '7d'>('24h')
  const [analyticsDomain, setAnalyticsDomain] = useState('')
  const [analytics, setAnalytics] = useState<EdgeOneAnalyticsResponse | null>(null)
  const [loadingAnalytics, setLoadingAnalytics] = useState(false)
  const [analyticsError, setAnalyticsError] = useState('')

  const selectedZone = useMemo(
    () => zones.find((z) => z.zoneId === selectedZoneId) ?? null,
    [zones, selectedZoneId],
  )

  const changeSite = (next: EdgeOneSite) => {
    setSite(next)
    try {
      localStorage.setItem(SITE_STORAGE_KEY, next)
    } catch {
      // ignore storage errors
    }
  }

  const loadBootstrap = useCallback(async () => {
    setLoadingBoot(true)
    try {
      const res = await api<{
        accounts: DnsAccount[]
        dns_accounts?: DnsAccount[]
        auto_cert?: EdgeOneAutoCertConfig
        managed_certs: EdgeOneManagedCertOption[]
      }>('/api/v1/edgeone/accounts')
      const list = res.accounts ?? []
      setAccounts(list)
      setDnsAccounts(res.dns_accounts ?? list)
      if (res.auto_cert) setAutoCert(res.auto_cert)
      setManagedCerts(res.managed_certs ?? [])
      setSelectedAccountId((prev) => {
        if (prev && list.some((a) => a.id === prev)) return prev
        return list[0]?.id ?? 0
      })
    } catch (err) {
      onToast(err instanceof Error ? err.message : '加载腾讯云账号失败', 'error')
    } finally {
      setLoadingBoot(false)
    }
  }, [onToast])

  useEffect(() => {
    void loadBootstrap()
  }, [loadBootstrap])

  const loadZones = useCallback(async () => {
    if (!selectedAccountId) {
      setZones([])
      setSelectedZoneId('')
      return
    }
    setLoadingZones(true)
    setZonesError('')
    try {
      const res = await api<{ items: EdgeOneZone[] }>(
        `/api/v1/edgeone/zones?account_id=${selectedAccountId}&site=${site}`,
        { timeoutMs: SLOW_TIMEOUT_MS },
      )
      const list = res.items ?? []
      setZones(list)
      setSelectedZoneId((prev) => {
        if (prev && list.some((z) => z.zoneId === prev)) return prev
        return list[0]?.zoneId ?? ''
      })
    } catch (err) {
      setZones([])
      setSelectedZoneId('')
      setZonesError(err instanceof Error ? err.message : '读取 EdgeOne 站点失败')
    } finally {
      setLoadingZones(false)
    }
  }, [selectedAccountId, site])

  useEffect(() => {
    void loadZones()
  }, [loadZones])

  const pendingDeletesRef = useRef<Set<string>>(new Set())

  const loadDomains = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = Boolean(opts?.silent)
      if (!selectedAccountId || !selectedZoneId) {
        setDomains([])
        pendingDeletesRef.current = new Set()
        return
      }
      if (!silent) {
        setLoadingDomains(true)
        setDomainsError('')
      }
      try {
        const res = await api<{ items: EdgeOneDomain[] }>(
          `/api/v1/edgeone/zones/${encodeURIComponent(selectedZoneId)}/domains?account_id=${selectedAccountId}&site=${site}`,
          { timeoutMs: SLOW_TIMEOUT_MS },
        )
        const nextItems = res.items ?? []
        const presentNames = new Set(nextItems.map((d) => d.domainName.toLowerCase()))
        if (silent && pendingDeletesRef.current.size > 0) {
          for (const prevDomain of pendingDeletesRef.current) {
            if (!presentNames.has(prevDomain)) {
              onToast(`加速域名 ${prevDomain} 已在后台完成停用并删除`, 'success')
            }
          }
        }
        pendingDeletesRef.current = new Set(
          nextItems.filter((d) => Boolean(d.pendingDelete)).map((d) => d.domainName.toLowerCase()),
        )
        setDomains(nextItems)
      } catch (err) {
        if (!silent) {
          setDomains([])
          setDomainsError(err instanceof Error ? err.message : '加载加速域名失败')
        }
      } finally {
        if (!silent) setLoadingDomains(false)
      }
    },
    [onToast, selectedAccountId, selectedZoneId, site],
  )

  useEffect(() => {
    setDomainPage(1)
    setAnalyticsDomain('')
    pendingDeletesRef.current = new Set()
    void loadDomains()
  }, [loadDomains])

  const hasPendingDelete = useMemo(
    () => domains.some((d) => Boolean(d.pendingDelete)),
    [domains],
  )

  useEffect(() => {
    if (!hasPendingDelete) return
    const timer = window.setInterval(() => {
      void loadDomains({ silent: true })
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [hasPendingDelete, loadDomains])

  const loadTasks = useCallback(async () => {
    if (!selectedAccountId || !selectedZoneId) {
      setTasks([])
      return
    }
    setLoadingTasks(true)
    try {
      const res = await api<{ items: EdgeOneTaskItem[] }>(
        `/api/v1/edgeone/zones/${encodeURIComponent(selectedZoneId)}/tasks?account_id=${selectedAccountId}&site=${site}&kind=${taskKind}`,
        { timeoutMs: SLOW_TIMEOUT_MS },
      )
      setTasks(res.items ?? [])
    } catch (err) {
      onToast(err instanceof Error ? err.message : '查询任务历史失败', 'error')
    } finally {
      setLoadingTasks(false)
    }
  }, [selectedAccountId, selectedZoneId, site, taskKind, onToast])

  useEffect(() => {
    if (workTab === 'cache') {
      void loadTasks()
    }
  }, [workTab, loadTasks])

  const loadAnalytics = useCallback(async () => {
    if (!selectedAccountId || !selectedZoneId) {
      setAnalytics(null)
      return
    }
    setLoadingAnalytics(true)
    setAnalyticsError('')
    try {
      const domainParam = analyticsDomain ? `&domain=${encodeURIComponent(analyticsDomain)}` : ''
      const res = await api<EdgeOneAnalyticsResponse>(
        `/api/v1/edgeone/zones/${encodeURIComponent(selectedZoneId)}/analytics?account_id=${selectedAccountId}&site=${site}&range=${analyticsRange}${domainParam}`,
        { timeoutMs: SLOW_TIMEOUT_MS },
      )
      setAnalytics(res)
    } catch (err) {
      setAnalytics(null)
      setAnalyticsError(err instanceof Error ? err.message : '加载流量统计失败')
    } finally {
      setLoadingAnalytics(false)
    }
  }, [selectedAccountId, selectedZoneId, site, analyticsRange, analyticsDomain])

  useEffect(() => {
    if (workTab === 'analytics') {
      void loadAnalytics()
    }
  }, [workTab, loadAnalytics])

  const filteredZones = useMemo(() => {
    const kw = zoneKeyword.trim().toLowerCase()
    if (!kw) return zones
    return zones.filter(
      (z) => z.zoneName.toLowerCase().includes(kw) || z.zoneId.toLowerCase().includes(kw),
    )
  }, [zones, zoneKeyword])

  const filteredDomains = useMemo(() => {
    const kw = domainKeyword.trim().toLowerCase()
    if (!kw) return domains
    return domains.filter(
      (d) =>
        d.domainName.toLowerCase().includes(kw) ||
        d.origin.toLowerCase().includes(kw) ||
        d.cname.toLowerCase().includes(kw),
    )
  }, [domains, domainKeyword])

  const totalPages = Math.max(1, Math.ceil(filteredDomains.length / DOMAINS_PAGE_SIZE))
  const safePage = Math.min(domainPage, totalPages)
  const pagedDomains = useMemo(() => {
    const start = (safePage - 1) * DOMAINS_PAGE_SIZE
    return filteredDomains.slice(start, start + DOMAINS_PAGE_SIZE)
  }, [filteredDomains, safePage])

  const pageTokens = useMemo<(number | 'ellipsis')[]>(() => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1)
    }
    const items: (number | 'ellipsis')[] = [1]
    const left = Math.max(2, safePage - 1)
    const right = Math.min(totalPages - 1, safePage + 1)
    if (left > 2) items.push('ellipsis')
    for (let p = left; p <= right; p += 1) items.push(p)
    if (right < totalPages - 1) items.push('ellipsis')
    items.push(totalPages)
    return items
  }, [safePage, totalPages])

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text)
      onToast(`已复制 ${label}`, 'success')
    } catch {
      onToast('复制失败，请手动选中复制', 'error')
    }
  }

  function openCreateDomainModal() {
    setDomainModal({
      mode: 'create',
      domainName: selectedZone ? `cdn.${selectedZone.zoneName}` : '',
      origin: '',
      backupOrigin: '',
      hostHeader: '',
      originProtocol: 'FOLLOW',
      httpOriginPort: 80,
      httpsOriginPort: 443,
      ipv6Status: 'follow',
    })
  }

  function openEditDomainModal(d: EdgeOneDomain) {
    setDomainModal({
      mode: 'edit',
      domainName: d.domainName,
      origin: d.origin,
      backupOrigin: d.backupOrigin || '',
      hostHeader: d.hostHeader || '',
      originProtocol: d.originProtocol || 'FOLLOW',
      httpOriginPort: d.httpOriginPort || 80,
      httpsOriginPort: d.httpsOriginPort || 443,
      ipv6Status: d.ipv6Status === 'on' || d.ipv6Status === 'off' ? d.ipv6Status : 'follow',
    })
  }

  async function saveDomainModal() {
    if (!domainModal || !selectedAccountId || !selectedZoneId) return
    if (!domainModal.domainName.trim() || !domainModal.origin.trim()) {
      onToast('请填写加速域名和源站地址', 'error')
      return
    }
    setSavingDomain(true)
    try {
      const payload = {
        account_id: selectedAccountId,
        site,
        domain_name: domainModal.domainName.trim().toLowerCase(),
        origin: domainModal.origin.trim(),
        origin_type: 'IP_DOMAIN',
        backup_origin: domainModal.backupOrigin.trim(),
        host_header: domainModal.hostHeader.trim(),
        origin_protocol: domainModal.originProtocol,
        http_origin_port: Number(domainModal.httpOriginPort) || 80,
        https_origin_port: Number(domainModal.httpsOriginPort) || 443,
        ipv6_status: domainModal.ipv6Status,
      }
      if (domainModal.mode === 'create') {
        await post(
          `/api/v1/edgeone/zones/${encodeURIComponent(selectedZoneId)}/domains`,
          payload,
          SLOW_TIMEOUT_MS,
        )
        onToast(`加速域名 ${payload.domain_name} 已添加`, 'success')
      } else {
        await put(
          `/api/v1/edgeone/zones/${encodeURIComponent(selectedZoneId)}/domains/${encodeURIComponent(domainModal.domainName)}`,
          payload,
          SLOW_TIMEOUT_MS,
        )
        onToast(`源站配置已保存：${domainModal.domainName}`, 'success')
      }
      setDomainModal(null)
      await loadDomains()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '保存加速域名失败', 'error')
    } finally {
      setSavingDomain(false)
    }
  }

  async function toggleDomainStatus(d: EdgeOneDomain) {
    if (!selectedAccountId || !selectedZoneId) return
    const nextStatus: 'online' | 'offline' = d.domainStatus === 'online' ? 'offline' : 'online'
    setBusyDomain(d.domainName)
    try {
      await post(
        `/api/v1/edgeone/zones/${encodeURIComponent(selectedZoneId)}/domains/${encodeURIComponent(d.domainName)}/status`,
        { account_id: selectedAccountId, site, status: nextStatus },
        SLOW_TIMEOUT_MS,
      )
      onToast(
        `${d.domainName} 已${nextStatus === 'online' ? '启用' : '停用'}`,
        'success',
      )
      await loadDomains()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '切换域名状态失败', 'error')
    } finally {
      setBusyDomain('')
    }
  }

  async function confirmDeleteDomain() {
    if (!deleteTarget || !selectedAccountId || !selectedZoneId) return
    setDeletingDomain(true)
    try {
      const res = await del<{ ok: boolean; mode?: 'deleted' | 'queued'; message?: string }>(
        `/api/v1/edgeone/zones/${encodeURIComponent(selectedZoneId)}/domains/${encodeURIComponent(deleteTarget.domainName)}?account_id=${selectedAccountId}&site=${site}`,
        SLOW_TIMEOUT_MS,
      )
      if (res?.mode === 'queued') {
        onToast(
          res.message || `已提交后台处理：正在自动停用 ${deleteTarget.domainName}，完成后将自动删除`,
          'info',
        )
      } else {
        onToast(res?.message || `加速域名 ${deleteTarget.domainName} 已删除`, 'success')
      }
      setDeleteTarget(null)
      await loadDomains({ silent: res?.mode === 'queued' })
    } catch (err) {
      onToast(err instanceof Error ? err.message : '删除加速域名失败', 'error')
    } finally {
      setDeletingDomain(false)
    }
  }

  async function cancelPendingDelete(domainName: string) {
    if (!selectedAccountId || !selectedZoneId) return
    setBusyDomain(domainName)
    try {
      await del(
        `/api/v1/edgeone/zones/${encodeURIComponent(selectedZoneId)}/domains/${encodeURIComponent(domainName)}/pending-delete?account_id=${selectedAccountId}&site=${site}`,
      )
      onToast(`已取消 ${domainName} 的后台删除任务`, 'info')
      await loadDomains({ silent: true })
    } catch (err) {
      onToast(err instanceof Error ? err.message : '取消后台删除失败', 'error')
    } finally {
      setBusyDomain('')
    }
  }

  async function toggleAutoCertEnabled(nextEnabled: boolean) {
    setSavingAutoCert(true)
    try {
      const res = await post<{ ok: boolean; auto_cert: EdgeOneAutoCertConfig }>(
        '/api/v1/edgeone/auto-cert/config',
        { enabled: nextEnabled, days: autoCert.days },
      )
      setAutoCert(res.auto_cert)
      onToast(
        nextEnabled
          ? `已开启：CDN 域名证书到期 ≤ ${res.auto_cert.days} 天自动申请并替换`
          : '已关闭 CDN 临期证书自动巡检',
        'success',
      )
    } catch (err) {
      onToast(err instanceof Error ? err.message : '更新自动申请策略失败', 'error')
    } finally {
      setSavingAutoCert(false)
    }
  }

  async function runAutoCertCheck() {
    if (!selectedAccountId || !selectedZoneId) return
    setCheckingAutoCert(true)
    try {
      const res = await post<{ ok: boolean; summary: EdgeOneAutoCertCheckSummary }>(
        '/api/v1/edgeone/auto-cert/check',
        {
          account_id: selectedAccountId,
          site,
          zone_id: selectedZoneId,
        },
        SLOW_TIMEOUT_MS,
      )
      const s = res.summary
      if (s.errors.length > 0 && s.replaced === 0 && s.applied === 0 && s.renewed === 0) {
        onToast(`检测完成但有异常：${s.errors[0]}`, 'error')
      } else if (s.replaced > 0 || s.applied > 0 || s.renewed > 0 || s.pending > 0) {
        const parts: string[] = []
        if (s.replaced > 0) parts.push(`已替换 ${s.replaced} 个`)
        if (s.applied > 0) parts.push(`已申请 ${s.applied} 个`)
        if (s.renewed > 0) parts.push(`已续签 ${s.renewed} 个`)
        if (s.pending > 0) parts.push(`待签发 ${s.pending} 个`)
        onToast(`巡检 ${s.scannedDomains} 个域名：${parts.join('，')}`, 'success')
      } else {
        onToast(
          `已检测 ${s.scannedDomains} 个域名，暂无到期 ≤ ${s.days} 天的临期证书`,
          'info',
        )
      }
      await Promise.all([loadDomains(), loadBootstrap()])
    } catch (err) {
      onToast(err instanceof Error ? err.message : '检测临期证书失败', 'error')
    } finally {
      setCheckingAutoCert(false)
    }
  }

  async function quickAutoApplyCert(d: EdgeOneDomain) {
    if (!selectedAccountId || !selectedZoneId) return
    const exp = parseCertExpireDays(d)
    setBusyDomain(d.domainName)
    try {
      const res = await post<{ ok: boolean; result: EdgeOneAutoCertActionResult }>(
        `/api/v1/edgeone/zones/${encodeURIComponent(selectedZoneId)}/cert/auto-apply`,
        {
          account_id: selectedAccountId,
          site,
          zone_name: selectedZone?.zoneName ?? '',
          domain: d.domainName,
          old_cert_id: exp.certId,
          old_cert_mode: d.certMode,
        },
        SLOW_TIMEOUT_MS,
      )
      onToast(res.result.detail || `已提交 ${d.domainName} 自动申请与替换`, res.result.action === 'skipped' ? 'info' : 'success')
      await Promise.all([loadDomains(), loadBootstrap()])
    } catch (err) {
      onToast(err instanceof Error ? err.message : '自动申请并替换证书失败', 'error')
    } finally {
      setBusyDomain('')
    }
  }

  function openCertModal(d: EdgeOneDomain) {
    const issuedCerts = managedCerts.filter((c) => c.status === 'issued' && c.cert_id)
    const exactMatch =
      (d.certBinding && issuedCerts.find((c) => c.id === d.certBinding?.ssl_cert_id)) ||
      issuedCerts.find((c) => c.domain.toLowerCase() === d.domainName.toLowerCase())
    const fallbackCert = exactMatch || issuedCerts[0]
    const exp = parseCertExpireDays(d)
    const expiringNow = exp.daysLeft !== null && exp.daysLeft <= autoCert.days
    const currentMode =
      d.certMode === 'sslcert' || d.certMode === 'eofreecert' || d.certMode === 'none'
        ? d.certMode
        : 'sslcert'
    const defaultSource: CertModalState['certSource'] =
      !d.domainName.startsWith('*.') && (!exactMatch || expiringNow)
        ? 'auto_apply'
        : fallbackCert
          ? 'managed'
          : 'manual'
    setCertModal({
      domain: d,
      mode: currentMode === 'none' ? 'sslcert' : currentMode,
      certSource: defaultSource,
      sslCertId: fallbackCert?.id ?? 0,
      manualCertId: d.certificates[0]?.certId ?? '',
      autoSync: d.certBinding ? true : Boolean(fallbackCert),
      autoVerifyMode: 'auto',
      autoDnsAccountId: dnsAccounts[0]?.id ?? selectedAccountId,
    })
  }

  async function saveCertModal() {
    if (!certModal || !selectedAccountId || !selectedZoneId) return
    if (certModal.mode === 'sslcert') {
      if (certModal.certSource === 'auto_apply') {
        if (certModal.domain.domainName.startsWith('*.')) {
          onToast('腾讯云免费 DV 证书暂不支持泛域名，请选择已有证书或 EdgeOne 免费证书', 'error')
          return
        }
        setSavingCert(true)
        try {
          const exp = parseCertExpireDays(certModal.domain)
          const res = await post<{ ok: boolean; result: EdgeOneAutoCertActionResult }>(
            `/api/v1/edgeone/zones/${encodeURIComponent(selectedZoneId)}/cert/auto-apply`,
            {
              account_id: selectedAccountId,
              site,
              zone_name: selectedZone?.zoneName ?? '',
              domain: certModal.domain.domainName,
              old_cert_id: exp.certId,
              old_cert_mode: certModal.domain.certMode,
              dns_verify_mode:
                certModal.autoVerifyMode === 'auto' ? '' : certModal.autoVerifyMode,
              dns_account_id:
                certModal.autoVerifyMode === 'dns_account' ? certModal.autoDnsAccountId : 0,
            },
            SLOW_TIMEOUT_MS,
          )
          onToast(res.result.detail || '已发起自动申请并绑定替换', 'success')
          setCertModal(null)
          await Promise.all([loadDomains(), loadBootstrap()])
        } catch (err) {
          onToast(err instanceof Error ? err.message : '自动申请并替换证书失败', 'error')
        } finally {
          setSavingCert(false)
        }
        return
      }
      if (certModal.certSource === 'managed' && !certModal.sslCertId) {
        onToast('请选择一张已签发的面板托管证书', 'error')
        return
      }
      if (certModal.certSource === 'manual' && !certModal.manualCertId.trim()) {
        onToast('请输入腾讯云 SSL 证书 ID', 'error')
        return
      }
    }
    setSavingCert(true)
    try {
      await post(
        `/api/v1/edgeone/zones/${encodeURIComponent(selectedZoneId)}/cert`,
        {
          account_id: selectedAccountId,
          site,
          zone_name: selectedZone?.zoneName ?? '',
          domain: certModal.domain.domainName,
          mode: certModal.mode,
          ssl_cert_id:
            certModal.mode === 'sslcert' && certModal.certSource === 'managed'
              ? certModal.sslCertId
              : 0,
          cert_id:
            certModal.mode === 'sslcert' && certModal.certSource === 'manual'
              ? certModal.manualCertId.trim()
              : '',
          auto_sync: certModal.mode === 'sslcert' && certModal.certSource === 'managed' && certModal.autoSync,
        },
        SLOW_TIMEOUT_MS,
      )
      onToast(`已更新 ${certModal.domain.domainName} 的 HTTPS 证书配置`, 'success')
      setCertModal(null)
      await loadDomains()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '配置 HTTPS 证书失败', 'error')
    } finally {
      setSavingCert(false)
    }
  }

  async function unbindAutoSync(bindingId: number, domainName: string) {
    setBusyDomain(domainName)
    try {
      await del(`/api/v1/edgeone/bindings/${bindingId}`)
      onToast(`已取消 ${domainName} 的续签自动同步`, 'info')
      await loadDomains()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '取消联动失败', 'error')
    } finally {
      setBusyDomain('')
    }
  }

  async function quickPurgeHost(domainName: string) {
    if (!selectedAccountId || !selectedZoneId) return
    setBusyDomain(domainName)
    try {
      const res = await post<{ ok: boolean; job_id: string }>(
        `/api/v1/edgeone/zones/${encodeURIComponent(selectedZoneId)}/purge`,
        {
          account_id: selectedAccountId,
          site,
          type: 'purge_host',
          method: 'invalidate',
          targets: [domainName],
        },
        SLOW_TIMEOUT_MS,
      )
      onToast(`已提交 ${domainName} 全域名缓存刷新（任务 ${res.job_id || '已排队'}）`, 'success')
    } catch (err) {
      onToast(err instanceof Error ? err.message : '刷新缓存失败', 'error')
    } finally {
      setBusyDomain('')
    }
  }

  async function submitCacheTask() {
    if (!selectedAccountId || !selectedZoneId) return
    const lines = cacheTargetsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (cacheAction !== 'purge_all' && lines.length === 0) {
      onToast('请每行输入一条目标 URL / 目录 / 主机名', 'error')
      return
    }
    setSubmittingCache(true)
    try {
      if (cacheAction === 'prefetch') {
        const res = await post<{ ok: boolean; job_id: string; failed_list: { target: string; message: string }[] }>(
          `/api/v1/edgeone/zones/${encodeURIComponent(selectedZoneId)}/prefetch`,
          { account_id: selectedAccountId, site, targets: lines },
          SLOW_TIMEOUT_MS,
        )
        const failNote = res.failed_list?.length ? `（${res.failed_list.length} 条失败）` : ''
        onToast(`URL 预热任务已提交（ID: ${res.job_id || '-'}）${failNote}`, 'success')
        setTaskKind('prefetch')
      } else {
        const res = await post<{ ok: boolean; job_id: string; failed_list: { target: string; message: string }[] }>(
          `/api/v1/edgeone/zones/${encodeURIComponent(selectedZoneId)}/purge`,
          {
            account_id: selectedAccountId,
            site,
            type: cacheAction,
            method: purgeMethod,
            targets: lines,
          },
          SLOW_TIMEOUT_MS,
        )
        const failNote = res.failed_list?.length ? `（${res.failed_list.length} 条失败）` : ''
        onToast(`缓存刷新任务已提交（ID: ${res.job_id || '-'}）${failNote}`, 'success')
        setTaskKind('purge')
      }
      setCacheTargetsText('')
      await loadTasks()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '提交缓存任务失败', 'error')
    } finally {
      setSubmittingCache(false)
    }
  }

  const issuedManagedCerts = useMemo(
    () => managedCerts.filter((c) => c.status === 'issued' && c.cert_id),
    [managedCerts],
  )

  return (
    <>
      <div className="page-head">
        <div>
          <h1>CDN服务</h1>
          <p>管理腾讯云 EdgeOne 加速域名、回源源站、缓存与流量，证书到期自动申请替换。</p>
        </div>
        <div className="page-actions eo-page-actions">
          {accounts.length > 0 && (
            <select
              className="select eo-acct-select"
              aria-label="选择腾讯云账号"
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(Number(e.target.value))}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  腾讯云 · {a.label}
                </option>
              ))}
            </select>
          )}
          <Segmented<EdgeOneSite>
            value={site}
            options={[
              { value: 'cn', label: '国内站' },
              { value: 'intl', label: '国际站' },
            ]}
            onChange={(v) => changeSite(v)}
          />
          <button
            type="button"
            className="btn sm"
            disabled={loadingZones || loadingDomains}
            onClick={() => {
              void loadBootstrap()
              void loadZones()
            }}
          >
            <RefreshCw size={13} className={loadingZones ? 'spin' : ''} /> 刷新
          </button>
        </div>
      </div>

      {loadingBoot ? (
        <div className="card cloud-dns-loading">
          <LoaderCircle size={16} className="spin" /> 正在加载腾讯云 EdgeOne 账号…
        </div>
      ) : accounts.length === 0 ? (
        <div className="card">
          <Empty icon={<CloudLightning size={24} />} title="尚未接入腾讯云账号">
            CDN服务复用「域名解析」中已添加的腾讯云 API 密钥（SecretId / SecretKey），支持管理国内站与国际站腾讯云 EdgeOne（TEO）。
            {onGoDnsAccounts && (
              <div style={{ marginTop: 12 }}>
                <button type="button" className="btn primary sm" onClick={onGoDnsAccounts}>
                  <Globe2 size={13} /> 前往「域名解析」添加腾讯云账号
                </button>
              </div>
            )}
          </Empty>
        </div>
      ) : (
        <div className="cloud-dns-workspace">
          {/* 左侧：EdgeOne 站点列表 */}
          <aside className="card cloud-dns-domains">
            <div className="cloud-dns-panel-head">
              <strong>EdgeOne 站点</strong>
              <span className="muted-xs">{zones.length} 个</span>
            </div>
            <div className="cloud-dns-search eo-zone-search">
              <Search size={13} />
              <input
                className="input"
                value={zoneKeyword}
                onChange={(e) => setZoneKeyword(e.target.value)}
                placeholder="筛选站点名 / ZoneId…"
              />
            </div>

            {loadingZones ? (
              <div className="cloud-dns-loading">
                <LoaderCircle size={15} className="spin" /> 正在获取站点…
              </div>
            ) : zonesError ? (
              <div className="cloud-dns-error">{zonesError}</div>
            ) : filteredZones.length === 0 ? (
              <div className="cloud-dns-empty-sm">
                当前{site === 'intl' ? '国际站' : '国内站'}下暂无已绑定域名的 EdgeOne 站点，可尝试切换右上角「国内站 / 国际站」。
              </div>
            ) : (
              <div className="cloud-dns-domain-list">
                {filteredZones.map((z) => {
                  const active = z.zoneId === selectedZoneId
                  const ok = z.activeStatus === 'active' && !z.paused
                  return (
                    <button
                      key={z.zoneId}
                      type="button"
                      className={`cloud-dns-domain-item${active ? ' is-active' : ''}`}
                      onClick={() => setSelectedZoneId(z.zoneId)}
                    >
                      <div className="cloud-dns-domain-name">{z.zoneName}</div>
                      <div className="cloud-dns-domain-meta">
                        <span>{zoneTypeLabel(z.type)}</span>
                        <span>{ok ? areaLabel(z.area) : z.paused ? '已暂停' : z.activeStatus}</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </aside>

          {/* 右侧：站点加速域名 / 缓存刷新与预热 / 流量统计 */}
          <section className="card cloud-dns-records">
            {!selectedZone ? (
              <Empty icon={<CloudLightning size={22} />} title="请先在左侧选择一个 EdgeOne 站点">
                选中站点后可管理加速域名、回源源站、HTTPS 证书联动、缓存清理预热及流量带宽统计。
              </Empty>
            ) : (
              <>
                <div className="eo-zone-banner">
                  <div className="eo-zone-title">
                    <CloudLightning size={16} style={{ color: 'var(--accent)' }} />
                    <strong>{selectedZone.zoneName}</strong>
                    <Badge tone={selectedZone.paused ? 'amber' : selectedZone.activeStatus === 'active' ? 'green' : 'blue'}>
                      {selectedZone.paused ? '已暂停' : selectedZone.activeStatus === 'active' ? '运行中' : selectedZone.activeStatus}
                    </Badge>
                    <Badge tone="gray" dot={false}>
                      {zoneTypeLabel(selectedZone.type)}
                    </Badge>
                    <Badge tone="gray" dot={false}>
                      {areaLabel(selectedZone.area)}
                    </Badge>
                  </div>
                  <span className="muted-xs mono">{selectedZone.zoneId}</span>
                </div>

                <div className="tabs eo-subtabs">
                  <button
                    type="button"
                    className={workTab === 'domains' ? 'on' : ''}
                    onClick={() => setWorkTab('domains')}
                  >
                    加速域名 ({domains.length})
                  </button>
                  <button
                    type="button"
                    className={workTab === 'cache' ? 'on' : ''}
                    onClick={() => setWorkTab('cache')}
                  >
                    缓存刷新与预热
                  </button>
                  <button
                    type="button"
                    className={workTab === 'analytics' ? 'on' : ''}
                    onClick={() => setWorkTab('analytics')}
                  >
                    流量与带宽统计
                  </button>
                </div>

                {/* Tab 1: 加速域名管理 */}
                {workTab === 'domains' && (
                  <>
                    <div className="eo-autocert-bar">
                      <div className="eo-autocert-left">
                        <Switch
                          checked={autoCert.enabled}
                          disabled={savingAutoCert}
                          onChange={(v) => void toggleAutoCertEnabled(v)}
                          label={`证书到期 ≤ ${autoCert.days} 天自动申请并替换`}
                          hint={`巡检已启用的加速域名，证书剩余不足 ${autoCert.days} 天或已过期时自动复用/申请免费 SSL 证书并替换边缘证书`}
                        />
                      </div>
                      <div className="eo-autocert-right">
                        <button
                          type="button"
                          className="btn sm"
                          disabled={checkingAutoCert || loadingDomains}
                          onClick={() => void runAutoCertCheck()}
                        >
                          {checkingAutoCert ? (
                            <LoaderCircle size={12} className="spin" />
                          ) : (
                            <Sparkles size={12} />
                          )}{' '}
                          立即检测临期证书
                        </button>
                      </div>
                    </div>

                    <div className="cloud-dns-records-bar">
                      <div className="cloud-dns-search eo-domain-search">
                        <Search size={13} />
                        <input
                          className="input"
                          value={domainKeyword}
                          onChange={(e) => {
                            setDomainKeyword(e.target.value)
                            setDomainPage(1)
                          }}
                          placeholder="搜索加速域名、源站或 CNAME…"
                        />
                      </div>
                      <div className="cloud-dns-records-tools">
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={loadingDomains}
                          onClick={() => void loadDomains()}
                        >
                          <RefreshCw size={13} className={loadingDomains ? 'spin' : ''} /> 刷新
                        </button>
                        <button type="button" className="btn primary sm" onClick={openCreateDomainModal}>
                          <Plus size={13} /> 添加加速域名
                        </button>
                      </div>
                    </div>

                    {loadingDomains ? (
                      <div className="cloud-dns-loading">
                        <LoaderCircle size={15} className="spin" /> 正在加载加速域名列表…
                      </div>
                    ) : domainsError ? (
                      <div className="cloud-dns-error">{domainsError}</div>
                    ) : filteredDomains.length === 0 ? (
                      <div className="cloud-dns-empty-sm">
                        当前站点还没有加速域名，点击右上角「添加加速域名」接入业务。
                      </div>
                    ) : (
                      <>
                        <div className="eo-domain-list">
                          {pagedDomains.map((d) => {
                            const st = domainStatusBadge(d.domainStatus)
                            const pendingDel = d.pendingDelete ?? null
                            const isPendingDelete = Boolean(pendingDel)
                            const isBusy = busyDomain === d.domainName
                            const isLocked = isBusy || isPendingDelete
                            const exp = parseCertExpireDays(d)
                            const isWildcard = d.domainName.startsWith('*.')
                            const isExpired = exp.daysLeft !== null && exp.daysLeft <= 0
                            const isExpiringSoon =
                              exp.daysLeft !== null && exp.daysLeft > 0 && exp.daysLeft <= autoCert.days
                            const isCertPending = Boolean(
                              d.certBinding &&
                                (d.certBinding.ssl_pending_cert_id ||
                                  d.certBinding.ssl_status === 'pending_dns' ||
                                  d.certBinding.ssl_status === 'verifying'),
                            )
                            const showQuickReplace =
                              !isPendingDelete &&
                              !isWildcard &&
                              (isExpired || isExpiringSoon || (d.certMode === 'sslcert' && !exp.certId))
                            return (
                              <div key={d.domainName} className="eo-domain-card">
                                <div className="eo-domain-top">
                                  <div className="eo-domain-name-wrap">
                                    <span className="eo-domain-name">{d.domainName}</span>
                                    <Badge tone={st.tone} pulse={st.pulse}>
                                      {st.text}
                                    </Badge>
                                    {pendingDel && (
                                      <span
                                        title={
                                          pendingDel.last_error
                                            ? `后台自动重试中（上次提示：${pendingDel.last_error}）`
                                            : '正在后台自动停用，待 EdgeOne 停用完成后将自动删除'
                                        }
                                      >
                                        <Badge tone="amber" pulse>
                                          {pendingDel.state === 'deleting'
                                            ? '后台删除中…'
                                            : '后台停用中 · 完成后自动删除'}
                                        </Badge>
                                      </span>
                                    )}
                                    {d.certMode === 'sslcert' ? (
                                      <Badge tone="green" dot={false}>
                                        <ShieldCheck size={11} style={{ marginRight: 3 }} />
                                        SSL {exp.certId || '已配置'}
                                      </Badge>
                                    ) : d.certMode === 'eofreecert' ? (
                                      <Badge tone="blue" dot={false}>
                                        EdgeOne 免费证书
                                      </Badge>
                                    ) : (
                                      <Badge tone="gray" dot={false}>
                                        未配置 HTTPS
                                      </Badge>
                                    )}
                                    {isExpired ? (
                                      <Badge tone="red" dot={false}>
                                        证书已过期
                                      </Badge>
                                    ) : isExpiringSoon ? (
                                      <Badge tone="amber" dot={false}>
                                        剩余 {exp.daysLeft} 天
                                      </Badge>
                                    ) : null}
                                    {isCertPending ? (
                                      <Badge tone="blue" pulse>
                                        新证签发中 · 自动替换
                                      </Badge>
                                    ) : d.certBinding ? (
                                      <Badge tone="green" dot={false}>
                                        <Sparkles size={11} style={{ marginRight: 3 }} />
                                        续签自动同步
                                      </Badge>
                                    ) : null}
                                  </div>
                                </div>

                                <div className="eo-domain-meta">
                                  <div>
                                    <span className="cert-meta-k">CNAME 接入地址</span>
                                    <span className="cert-meta-v mono eo-copy-row">
                                      <span className="eo-ellipsis" title={d.cname || ''}>
                                        {d.cname || '-'}
                                      </span>
                                      {d.cname && (
                                        <button
                                          type="button"
                                          className="btn ghost icon sm"
                                          title="复制 CNAME"
                                          onClick={() => void copyText(d.cname, 'CNAME')}
                                        >
                                          <Copy size={11} />
                                        </button>
                                      )}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="cert-meta-k">源站地址</span>
                                    <span className="cert-meta-v mono eo-ellipsis" title={d.origin || ''}>
                                      {d.origin || '-'}
                                      {d.backupOrigin ? `（备：${d.backupOrigin}）` : ''}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="cert-meta-k">回源协议 / 端口</span>
                                    <span className="cert-meta-v mono" style={{ whiteSpace: 'nowrap' }}>
                                      {d.originProtocol} · {d.httpOriginPort} / {d.httpsOriginPort}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="cert-meta-k">证书到期 / 联动</span>
                                    <span className="cert-meta-v">
                                      {d.certBinding ? (
                                        <span className="eo-binding-inline">
                                          <span className="eo-ellipsis">
                                            {isCertPending
                                              ? `审核中（${d.certBinding.ssl_pending_cert_id || d.certBinding.ssl_cert_current_id}）`
                                              : exp.expireTime
                                                ? `${exp.expireTime.slice(0, 10)}${exp.daysLeft !== null ? ` · 剩 ${Math.max(0, exp.daysLeft)} 天` : ''}`
                                                : d.certBinding.last_deployed_at
                                                  ? `${timeAgo(d.certBinding.last_deployed_at)}已同步`
                                                  : '已开启自动续签'}
                                          </span>
                                          <button
                                            type="button"
                                            className="btn ghost icon sm"
                                            title="取消续签自动同步"
                                            disabled={isLocked}
                                            onClick={() => void unbindAutoSync(d.certBinding!.id, d.domainName)}
                                          >
                                            <Unlink size={11} />
                                          </button>
                                        </span>
                                      ) : exp.expireTime ? (
                                        `${exp.expireTime.slice(0, 10)}${
                                          exp.daysLeft !== null
                                            ? exp.daysLeft <= 0
                                              ? ' · 已过期'
                                              : ` · 剩 ${exp.daysLeft} 天`
                                            : ''
                                        }`
                                      ) : (
                                        '未配置证书'
                                      )}
                                    </span>
                                  </div>
                                </div>

                                <div className="eo-domain-foot">
                                  <span className="muted-xs">
                                    {pendingDel
                                      ? pendingDel.last_error
                                        ? `后台删除自动重试中（${pendingDel.last_error}）`
                                        : '后台自动停用中：待 EdgeOne 停用部署完成后将自动删除（可离开页面，无需等待）'
                                      : d.certBinding
                                        ? `已绑定托管证书，到期前 ${autoCert.days} 天自动续签同步`
                                        : autoCert.enabled && !isWildcard && d.certMode !== 'none'
                                          ? `巡检保护中：到期 ≤ ${autoCert.days} 天自动申请替换`
                                          : isWildcard
                                            ? '泛域名需手动配置或使用 EdgeOne 免费证书'
                                            : '点击「证书」可一键自动申请并开启续签同步'}
                                  </span>

                                  <div className="eo-domain-actions">
                                    {showQuickReplace && (
                                      <button
                                        type="button"
                                        className="btn primary sm"
                                        disabled={isLocked}
                                        onClick={() => void quickAutoApplyCert(d)}
                                      >
                                        {isBusy ? (
                                          <LoaderCircle size={12} className="spin" />
                                        ) : (
                                          <Sparkles size={12} />
                                        )}{' '}
                                        自动申请替换
                                      </button>
                                    )}
                                    {pendingDel ? (
                                      <button
                                        type="button"
                                        className="btn ghost sm"
                                        disabled={isBusy}
                                        onClick={() => void cancelPendingDelete(d.domainName)}
                                        title="取消后台自动删除任务"
                                      >
                                        {isBusy ? (
                                          <LoaderCircle size={12} className="spin" />
                                        ) : (
                                          <X size={12} />
                                        )}{' '}
                                        取消删除
                                      </button>
                                    ) : (
                                      <>
                                        <button
                                          type="button"
                                          className="btn ghost sm"
                                          disabled={isLocked}
                                          onClick={() => void toggleDomainStatus(d)}
                                        >
                                          <Power size={12} /> {d.domainStatus === 'online' ? '停用' : '启用'}
                                        </button>
                                        <button
                                          type="button"
                                          className="btn ghost sm"
                                          disabled={isLocked}
                                          onClick={() => openEditDomainModal(d)}
                                        >
                                          <Pencil size={12} /> 源站
                                        </button>
                                        <button
                                          type="button"
                                          className="btn ghost sm"
                                          disabled={isLocked}
                                          onClick={() => openCertModal(d)}
                                        >
                                          <ShieldCheck size={12} /> 证书
                                        </button>
                                        <button
                                          type="button"
                                          className="btn ghost sm"
                                          disabled={isLocked}
                                          onClick={() => void quickPurgeHost(d.domainName)}
                                        >
                                          <Flame size={12} /> 刷新缓存
                                        </button>
                                        <button
                                          type="button"
                                          className="btn ghost icon sm"
                                          title="删除加速域名"
                                          disabled={isLocked}
                                          onClick={() => setDeleteTarget(d)}
                                        >
                                          <Trash2 size={13} />
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>

                        {totalPages > 1 && (
                          <div className="cloud-dns-pager" role="navigation" aria-label="加速域名分页">
                            <span className="cloud-dns-pager-info">
                              共 {filteredDomains.length} 个 · 第 {(safePage - 1) * DOMAINS_PAGE_SIZE + 1}–
                              {Math.min(safePage * DOMAINS_PAGE_SIZE, filteredDomains.length)} 个（{safePage} / {totalPages} 页）
                            </span>
                            <div className="cloud-dns-pager-controls">
                              <button
                                type="button"
                                className="cloud-dns-page-btn"
                                disabled={safePage <= 1}
                                onClick={() => setDomainPage(Math.max(1, safePage - 1))}
                              >
                                <ChevronLeft size={13} /> 上一页
                              </button>
                              {pageTokens.map((tok, idx) =>
                                tok === 'ellipsis' ? (
                                  <span key={`e-${idx}`} className="cloud-dns-page-ellipsis">
                                    …
                                  </span>
                                ) : (
                                  <button
                                    key={tok}
                                    type="button"
                                    className={`cloud-dns-page-btn${tok === safePage ? ' on' : ''}`}
                                    aria-current={tok === safePage ? 'page' : undefined}
                                    onClick={() => setDomainPage(tok)}
                                  >
                                    {tok}
                                  </button>
                                ),
                              )}
                              <button
                                type="button"
                                className="cloud-dns-page-btn"
                                disabled={safePage >= totalPages}
                                onClick={() => setDomainPage(Math.min(totalPages, safePage + 1))}
                              >
                                下一页 <ChevronRight size={13} />
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}

                {/* Tab 2: 缓存刷新与预热 */}
                {workTab === 'cache' && (
                  <div className="eo-cache-wrap">
                    <div className="eo-cache-form">
                      <div className="eo-cache-toolbar">
                        <Segmented<CacheActionKind>
                          value={cacheAction}
                          options={[
                            { value: 'purge_url', label: 'URL 刷新' },
                            { value: 'purge_prefix', label: '目录刷新' },
                            { value: 'purge_host', label: '主机名刷新' },
                            { value: 'purge_all', label: '整站刷新' },
                            { value: 'prefetch', label: 'URL 预热' },
                          ]}
                          onChange={(v) => setCacheAction(v)}
                        />
                        {(cacheAction === 'purge_prefix' ||
                          cacheAction === 'purge_host' ||
                          cacheAction === 'purge_all') && (
                          <Segmented<'invalidate' | 'delete'>
                            value={purgeMethod}
                            options={[
                              { value: 'invalidate', label: '标记过期（推荐）' },
                              { value: 'delete', label: '直接删除节点缓存' },
                            ]}
                            onChange={(v) => setPurgeMethod(v)}
                          />
                        )}
                      </div>

                      {cacheAction === 'purge_all' ? (
                        <div className="notice amber">
                          <span>
                            将清理站点 <b>{selectedZone.zoneName}</b> 下的全部节点缓存，可能短时增加源站回源压力。
                          </span>
                        </div>
                      ) : (
                        <div className="field">
                          <div className="eo-target-head">
                            <label>
                              {cacheAction === 'purge_url'
                                ? '要刷新的 URL 列表（每行一条，需带 http:// 或 https://）'
                                : cacheAction === 'purge_prefix'
                                  ? '要刷新的目录前缀（每行一条，以 / 结尾，如 https://cdn.example.com/static/）'
                                  : cacheAction === 'purge_host'
                                    ? '要刷新的加速域名（每行一个主机名，如 cdn.example.com）'
                                    : '要预热到边缘节点的完整 URL（每行一条）'}
                            </label>
                            {domains.length > 0 && (
                              <div className="eo-quick-chips">
                                {domains.slice(0, 4).map((d) => (
                                  <button
                                    key={d.domainName}
                                    type="button"
                                    className="eo-chip"
                                    onClick={() => {
                                      const line =
                                        cacheAction === 'purge_host'
                                          ? d.domainName
                                          : cacheAction === 'purge_prefix'
                                            ? `https://${d.domainName}/`
                                            : `https://${d.domainName}/index.html`
                                      setCacheTargetsText((prev) =>
                                        prev.trim() ? `${prev.trim()}\n${line}` : line,
                                      )
                                    }}
                                  >
                                    + {d.domainName}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                          <textarea
                            className="textarea mono"
                            rows={4}
                            value={cacheTargetsText}
                            onChange={(e) => setCacheTargetsText(e.target.value)}
                            placeholder={
                              cacheAction === 'purge_host'
                                ? `cdn.${selectedZone.zoneName}`
                                : cacheAction === 'purge_prefix'
                                  ? `https://cdn.${selectedZone.zoneName}/assets/`
                                  : `https://cdn.${selectedZone.zoneName}/index.html`
                            }
                          />
                        </div>
                      )}

                      <div>
                        <button
                          type="button"
                          className="btn primary sm"
                          disabled={submittingCache}
                          onClick={() => void submitCacheTask()}
                        >
                          {submittingCache ? (
                            <LoaderCircle size={13} className="spin" />
                          ) : (
                            <Flame size={13} />
                          )}{' '}
                          {cacheAction === 'prefetch' ? '提交预热任务' : '立即提交缓存清理'}
                        </button>
                      </div>
                    </div>

                    <div className="eo-task-section">
                      <div className="eo-task-head">
                        <Segmented<'purge' | 'prefetch'>
                          value={taskKind}
                          options={[
                            { value: 'purge', label: '刷新历史（近 7 天）' },
                            { value: 'prefetch', label: '预热历史（近 7 天）' },
                          ]}
                          onChange={(v) => setTaskKind(v)}
                        />
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={loadingTasks}
                          onClick={() => void loadTasks()}
                        >
                          <RefreshCw size={12} className={loadingTasks ? 'spin' : ''} /> 刷新记录
                        </button>
                      </div>

                      {loadingTasks ? (
                        <div className="cloud-dns-loading">
                          <LoaderCircle size={14} className="spin" /> 正在查询近 7 天任务记录…
                        </div>
                      ) : tasks.length === 0 ? (
                        <div className="cloud-dns-empty-sm">近 7 天暂无该类型的缓存任务记录。</div>
                      ) : (
                        <div className="cloud-dns-table-wrap">
                          <table className="cloud-dns-table">
                            <thead>
                              <tr>
                                <th>类型</th>
                                <th>目标资源</th>
                                <th>状态</th>
                                <th>任务 ID</th>
                                <th>创建时间</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tasks.map((t, idx) => {
                                const b = taskStatusBadge(t.status)
                                return (
                                  <tr key={`${t.jobId}-${idx}`}>
                                    <td>
                                      <Badge tone="gray" dot={false}>
                                        {taskTypeLabel(t.type)}
                                      </Badge>
                                    </td>
                                    <td className="mono eo-task-target">{t.target || '-'}</td>
                                    <td>
                                      <Badge tone={b.tone}>{b.text}</Badge>
                                    </td>
                                    <td className="mono muted-xs">{t.jobId}</td>
                                    <td className="mono muted-xs">
                                      {t.createTime ? t.createTime.replace('T', ' ').slice(0, 19) : '-'}
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

                {/* Tab 3: 流量与带宽统计 */}
                {workTab === 'analytics' && (
                  <div className="eo-analytics-wrap">
                    <div className="eo-analytics-bar">
                      <Segmented<'24h' | '7d'>
                        value={analyticsRange}
                        options={[
                          { value: '24h', label: '近 24 小时' },
                          { value: '7d', label: '近 7 天' },
                        ]}
                        onChange={(v) => setAnalyticsRange(v)}
                      />
                      <select
                        className="select eo-domain-filter"
                        value={analyticsDomain}
                        onChange={(e) => setAnalyticsDomain(e.target.value)}
                      >
                        <option value="">全站点汇总</option>
                        {domains.map((d) => (
                          <option key={d.domainName} value={d.domainName}>
                            {d.domainName}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={loadingAnalytics}
                        onClick={() => void loadAnalytics()}
                      >
                        <RefreshCw size={12} className={loadingAnalytics ? 'spin' : ''} /> 刷新统计
                      </button>
                    </div>

                    {loadingAnalytics ? (
                      <div className="cloud-dns-loading">
                        <LoaderCircle size={15} className="spin" /> 正在查询 EdgeOne L7 统计数据…
                      </div>
                    ) : analyticsError ? (
                      <div className="cloud-dns-error">{analyticsError}</div>
                    ) : analytics ? (
                      <>
                        <div className="certs-kpi-grid">
                          <div className="card certs-kpi">
                            <span>总访问流量</span>
                            <strong>{formatBytes(analytics.summary.totalFluxBytes)}</strong>
                          </div>
                          <div className="card certs-kpi">
                            <span>峰值响应带宽</span>
                            <strong className="tone-blue">
                              {formatBps(analytics.summary.peakBandwidthBps)}
                            </strong>
                          </div>
                          <div className="card certs-kpi">
                            <span>总请求数</span>
                            <strong className="tone-green">
                              {formatCount(analytics.summary.totalRequests)}
                            </strong>
                          </div>
                          <div className="card certs-kpi">
                            <span>平均响应耗时</span>
                            <strong>{analytics.summary.avgResponseTimeMs} ms</strong>
                          </div>
                        </div>

                        <div className="eo-charts-grid">
                          <EdgeOneMetricChart
                            title="L7 访问流量趋势"
                            points={analytics.series.map((p) => ({
                              timestamp: p.timestamp,
                              value: p.flux,
                            }))}
                            color="var(--accent)"
                            formatVal={formatBytes}
                            range={analytics.range}
                          />
                          <EdgeOneMetricChart
                            title="L7 响应带宽趋势"
                            points={analytics.series.map((p) => ({
                              timestamp: p.timestamp,
                              value: p.bandwidth,
                            }))}
                            color="var(--blue)"
                            formatVal={formatBps}
                            range={analytics.range}
                          />
                          <EdgeOneMetricChart
                            title="L7 请求数趋势"
                            points={analytics.series.map((p) => ({
                              timestamp: p.timestamp,
                              value: p.requests,
                            }))}
                            color="var(--green)"
                            formatVal={formatCount}
                            range={analytics.range}
                          />
                        </div>
                        <div className="muted-xs" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <Activity size={12} /> 腾讯云 EdgeOne 时序指标约有 10 分钟数据延迟，已自动取稳定窗口展示。
                        </div>
                      </>
                    ) : null}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}

      {/* 添加 / 编辑加速域名弹窗 */}
      {domainModal && (
        <Modal
          title={domainModal.mode === 'create' ? '添加 EdgeOne 加速域名' : `编辑源站 · ${domainModal.domainName}`}
          icon={<CloudLightning size={16} style={{ color: 'var(--accent)' }} />}
          wide
          onClose={() => !savingDomain && setDomainModal(null)}
          footer={
            <>
              <button
                type="button"
                className="btn ghost"
                disabled={savingDomain}
                onClick={() => setDomainModal(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={savingDomain}
                onClick={() => void saveDomainModal()}
              >
                {savingDomain && <LoaderCircle size={13} className="spin" />}{' '}
                {domainModal.mode === 'create' ? '创建加速域名' : '保存源站配置'}
              </button>
            </>
          }
        >
          <div className="form-stack">
            <div className="field">
              <label>加速域名</label>
              <input
                className="input mono"
                disabled={domainModal.mode === 'edit'}
                value={domainModal.domainName}
                onChange={(e) => setDomainModal({ ...domainModal, domainName: e.target.value })}
                placeholder={selectedZone ? `cdn.${selectedZone.zoneName}` : 'cdn.example.com'}
              />
            </div>

            <div className="grid-2">
              <div className="field">
                <label>主源站（公网 IP 或源站域名）</label>
                <input
                  className="input mono"
                  value={domainModal.origin}
                  onChange={(e) => setDomainModal({ ...domainModal, origin: e.target.value })}
                  placeholder="例如 1.2.3.4 或 origin.example.com"
                />
              </div>
              <div className="field">
                <label>备用源站（可选）</label>
                <input
                  className="input mono"
                  value={domainModal.backupOrigin}
                  onChange={(e) => setDomainModal({ ...domainModal, backupOrigin: e.target.value })}
                  placeholder="留空则不配置"
                />
              </div>
            </div>

            <div className="grid-2">
              <div className="field">
                <label>回源 Host 头（可选）</label>
                <input
                  className="input mono"
                  value={domainModal.hostHeader}
                  onChange={(e) => setDomainModal({ ...domainModal, hostHeader: e.target.value })}
                  placeholder="默认跟随加速域名"
                />
              </div>
              <div className="field">
                <label>IPv6 访问</label>
                <Segmented<'follow' | 'on' | 'off'>
                  value={domainModal.ipv6Status}
                  options={[
                    { value: 'follow', label: '跟随站点' },
                    { value: 'on', label: '开启' },
                    { value: 'off', label: '关闭' },
                  ]}
                  onChange={(v) => setDomainModal({ ...domainModal, ipv6Status: v })}
                />
              </div>
            </div>

            <div className="field">
              <label>回源协议</label>
              <Segmented<'FOLLOW' | 'HTTP' | 'HTTPS'>
                value={domainModal.originProtocol}
                options={[
                  { value: 'FOLLOW', label: '协议跟随 (FOLLOW)' },
                  { value: 'HTTP', label: 'HTTP' },
                  { value: 'HTTPS', label: 'HTTPS' },
                ]}
                onChange={(v) => setDomainModal({ ...domainModal, originProtocol: v })}
              />
            </div>

            <div className="grid-2">
              {(domainModal.originProtocol === 'FOLLOW' || domainModal.originProtocol === 'HTTP') && (
                <div className="field">
                  <label>HTTP 回源端口</label>
                  <input
                    type="number"
                    className="input mono"
                    min={1}
                    max={65535}
                    value={domainModal.httpOriginPort}
                    onChange={(e) =>
                      setDomainModal({ ...domainModal, httpOriginPort: Number(e.target.value) || 80 })
                    }
                  />
                </div>
              )}
              {(domainModal.originProtocol === 'FOLLOW' || domainModal.originProtocol === 'HTTPS') && (
                <div className="field">
                  <label>HTTPS 回源端口</label>
                  <input
                    type="number"
                    className="input mono"
                    min={1}
                    max={65535}
                    value={domainModal.httpsOriginPort}
                    onChange={(e) =>
                      setDomainModal({ ...domainModal, httpsOriginPort: Number(e.target.value) || 443 })
                    }
                  />
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* 配置 HTTPS 证书与续签联动弹窗 */}
      {certModal && (
        <Modal
          title={`HTTPS 证书配置 · ${certModal.domain.domainName}`}
          icon={<ShieldCheck size={16} style={{ color: 'var(--accent)' }} />}
          wide
          onClose={() => !savingCert && setCertModal(null)}
          footer={
            <>
              <button
                type="button"
                className="btn ghost"
                disabled={savingCert}
                onClick={() => setCertModal(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={savingCert}
                onClick={() => void saveCertModal()}
              >
                {savingCert && <LoaderCircle size={13} className="spin" />}{' '}
                {certModal.mode === 'sslcert' && certModal.certSource === 'auto_apply'
                  ? '立即自动申请并替换'
                  : '应用证书配置'}
              </button>
            </>
          }
        >
          <div className="form-stack">
            <div className="field">
              <label>证书部署模式</label>
              <Segmented<'sslcert' | 'eofreecert' | 'none'>
                value={certModal.mode}
                options={[
                  { value: 'sslcert', label: '腾讯云 SSL 托管证书' },
                  { value: 'eofreecert', label: 'EdgeOne 免费证书' },
                  { value: 'none', label: '关闭 HTTPS' },
                ]}
                onChange={(v) => setCertModal({ ...certModal, mode: v })}
              />
            </div>

            {certModal.mode === 'sslcert' && (
              <>
                <div className="field">
                  <label>证书来源</label>
                  <Segmented<'auto_apply' | 'managed' | 'manual'>
                    value={certModal.certSource}
                    options={[
                      { value: 'auto_apply', label: '自动申请并替换' },
                      { value: 'managed', label: `面板证书 (${issuedManagedCerts.length})` },
                      { value: 'manual', label: '手动 CertId' },
                    ]}
                    onChange={(v) => setCertModal({ ...certModal, certSource: v })}
                  />
                </div>

                {certModal.certSource === 'auto_apply' ? (
                  <>
                    <div className="eo-cert-modal-note">
                      将优先复用同账号下有效期大于 {autoCert.days} 天的已有证书；若无可用新证，则自动向腾讯云申请免费 443 DV 证书、自动完成 DNS 验证，并在签发后自动部署替换此 EdgeOne 加速域名，之后到期前 {autoCert.days} 天继续自动续签并替换。
                    </div>

                    <div className="field">
                      <label>DNS 自动验证方式</label>
                      <Segmented<'auto' | 'dns_account' | 'tencent_auto'>
                        value={certModal.autoVerifyMode}
                        options={[
                          { value: 'auto', label: '自动匹配解析账号（推荐）' },
                          { value: 'dns_account', label: '指定云解析账号' },
                          { value: 'tencent_auto', label: '腾讯云同账号 DNS_AUTO' },
                        ]}
                        onChange={(v) => setCertModal({ ...certModal, autoVerifyMode: v })}
                      />
                    </div>

                    {certModal.autoVerifyMode === 'dns_account' && (
                      <div className="field">
                        <label>用于自动写入验证记录的 DNS 账号</label>
                        <select
                          className="select"
                          value={certModal.autoDnsAccountId}
                          onChange={(e) =>
                            setCertModal({
                              ...certModal,
                              autoDnsAccountId: Number(e.target.value),
                            })
                          }
                        >
                          {dnsAccounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.provider === 'cloudflare' ? 'Cloudflare' : '腾讯云 DNSPod'} · {a.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </>
                ) : certModal.certSource === 'managed' ? (
                  <>
                    <div className="field">
                      <label>选择已签发证书</label>
                      {issuedManagedCerts.length === 0 ? (
                        <div className="notice amber">
                          <span>
                            面板「证书服务」中还没有已签发证书，可直接切换到「自动申请并替换」一键申请。
                            {onGoCerts && (
                              <button
                                type="button"
                                className="btn ghost sm"
                                style={{ marginLeft: 8 }}
                                onClick={() => {
                                  setCertModal(null)
                                  onGoCerts()
                                }}
                              >
                                前往证书服务
                              </button>
                            )}
                          </span>
                        </div>
                      ) : (
                        <select
                          className="select"
                          value={certModal.sslCertId}
                          onChange={(e) =>
                            setCertModal({ ...certModal, sslCertId: Number(e.target.value) })
                          }
                        >
                          {issuedManagedCerts.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.domain} · {c.cert_id}
                              {c.cert_end_time ? `（至 ${c.cert_end_time.slice(0, 10)}）` : ''}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>

                    <Switch
                      checked={certModal.autoSync}
                      onChange={(v) => setCertModal({ ...certModal, autoSync: v })}
                      label={`证书到期前 ${autoCert.days} 天自动续签后，自动同步部署到此 EdgeOne 加速域名`}
                      hint="开启后，当「证书服务」自动续签签发新证书时，后台会自动调用 EdgeOne ModifyHostsCertificate 替换边缘证书"
                    />
                  </>
                ) : (
                  <div className="field">
                    <label>腾讯云 SSL 证书 ID（CertId）</label>
                    <input
                      className="input mono"
                      value={certModal.manualCertId}
                      onChange={(e) => setCertModal({ ...certModal, manualCertId: e.target.value })}
                      placeholder="例如 cZJPpfZj"
                    />
                    <div className="hint">须为当前同腾讯云账号下已签发的 SSL 证书 ID。</div>
                  </div>
                )}
              </>
            )}

            {certModal.mode === 'eofreecert' && (
              <div className="hint">
                将使用 EdgeOne 平台自动申请并托管的免费边缘证书（需确保域名已完成 CNAME/NS 接入与归属权验证）。若到期前 {autoCert.days} 天仍未自动续期，开启自动申请策略后后台也会兜底自动申请替换。
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* 删除确认弹窗 */}
      {deleteTarget && (
        <Modal
          title="删除加速域名"
          icon={<Trash2 size={16} style={{ color: 'var(--red)' }} />}
          onClose={() => !deletingDomain && setDeleteTarget(null)}
          footer={
            <>
              <button
                type="button"
                className="btn ghost"
                disabled={deletingDomain}
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={deletingDomain}
                onClick={() => void confirmDeleteDomain()}
              >
                {deletingDomain && <LoaderCircle size={13} className="spin" />}{' '}
                {deleteTarget.domainStatus === 'offline' ? '确认删除' : '后台停用并删除'}
              </button>
            </>
          }
        >
          <p>
            确定要从腾讯云 EdgeOne 站点 <b>{selectedZone?.zoneName}</b> 中删除加速域名{' '}
            <code className="mono">{deleteTarget.domainName}</code> 吗？
            {deleteTarget.domainStatus === 'offline'
              ? '该域名已处于停用状态，确认后将立即删除。'
              : '该域名当前尚未停用，确认后系统将在后台自动停用，待停用部署完成后自动删除（提交后无需停留在当前页面等待）。'}
          </p>
        </Modal>
      )}
    </>
  )
}
