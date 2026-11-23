import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CloudLightning,
  Copy,
  Edit3,
  Eye,
  EyeOff,
  Globe2,
  Link2,
  LoaderCircle,
  Network,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server as ServerIcon,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Unlink,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react'
import { APIError, SLOW_TIMEOUT_MS, api, del, patch, post } from '../api'
import type {
  DnsAccount,
  NpsAuthMode,
  NpsBootstrapResponse,
  NpsBridgeInfo,
  NpsClientItem,
  NpsHostItem,
  NpsHostScheme,
  NpsManagedCertOption,
  NpsServerItem,
  NpsTunnelItem,
  NpsTunnelMode,
  SslVerifyMode,
} from '../types'
import { Badge, Empty, Modal, Segmented, Switch } from './ui'

type ConfirmRequest = {
  title: string
  message: string
  hint?: string
  confirmText?: string
  failText?: string
  run: () => Promise<void>
}

interface NpsViewProps {
  section: 'tunnels' | 'hosts'
  onSwitchSection: (next: 'tunnels' | 'hosts') => void
  onToast: (message: string, tone?: 'success' | 'error' | 'info') => void
  onConfirm: (req: ConfirmRequest) => void
  onGoCerts: () => void
  onGoDnsAccounts: () => void
  onChanged?: () => void
}

const SELECTED_SERVER_STORAGE_KEY = 'cdt_nps_selected_server_id'
const CLIENTS_PAGE_SIZE = 6
const TUNNELS_PAGE_SIZE = 10

function buildPageTokens(current: number, total: number): Array<number | 'ellipsis'> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }
  const pages = new Set<number>([1, total, current - 1, current, current + 1])
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b)
  const out: Array<number | 'ellipsis'> = []
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && sorted[i]! - sorted[i - 1]! > 1) out.push('ellipsis')
    out.push(sorted[i]!)
  }
  return out
}

const TUNNEL_MODE_OPTIONS: { value: NpsTunnelMode; label: string }[] = [
  { value: 'tcp', label: 'TCP 隧道' },
  { value: 'udp', label: 'UDP 隧道' },
  { value: 'socks5', label: 'SOCKS5 代理' },
  { value: 'httpProxy', label: 'HTTP 代理' },
  { value: 'secret', label: '私密代理 (Secret)' },
  { value: 'p2p', label: 'P2P 穿透' },
  { value: 'file', label: '文件服务' },
]

const TUNNEL_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: '全部协议' },
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
  { value: 'other', label: '其他协议' },
]

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let val = bytes
  let idx = 0
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024
    idx += 1
  }
  return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`
}

function formatTs(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function daysLeft(endTs?: number): number | null {
  if (!endTs || endTs <= 0) return null
  return Math.ceil((endTs - Date.now() / 1000) / 86400)
}

function tunnelModeBadge(mode: NpsTunnelMode): { label: string; tone: 'blue' | 'amber' | 'green' | 'gray' } {
  if (mode === 'tcp') return { label: 'TCP', tone: 'blue' }
  if (mode === 'udp') return { label: 'UDP', tone: 'amber' }
  if (mode === 'socks5') return { label: 'SOCKS5', tone: 'green' }
  if (mode === 'httpProxy') return { label: 'HTTP代理', tone: 'green' }
  if (mode === 'p2p') return { label: 'P2P', tone: 'blue' }
  if (mode === 'secret') return { label: 'SECRET', tone: 'gray' }
  return { label: mode.toUpperCase(), tone: 'gray' }
}

function buildNpcCommand(bridge: NpsBridgeInfo | null, baseUrl: string, verifyKey: string): string {
  let host = bridge?.ip?.trim() || ''
  if (!host) {
    try {
      host = new URL(baseUrl).hostname
    } catch {
      host = 'YOUR_NPS_HOST'
    }
  }
  const port = bridge?.bridgePort || 8024
  const type = bridge?.bridgeType || 'tcp'
  return `./npc -server=${host}:${port} -vkey=${verifyKey} -type=${type}`
}

function maskVkey(vkey: string): string {
  if (!vkey) return '—'
  if (vkey.length <= 8) return vkey
  return `${vkey.slice(0, 4)}••••${vkey.slice(-4)}`
}

export default function NpsView({
  section,
  onSwitchSection,
  onToast,
  onConfirm,
  onGoCerts,
  onGoDnsAccounts,
  onChanged,
}: NpsViewProps) {
  const [bootLoading, setBootLoading] = useState(true)
  const [servers, setServers] = useState<NpsServerItem[]>([])
  const [tencentAccounts, setTencentAccounts] = useState<DnsAccount[]>([])
  const [dnsAccounts, setDnsAccounts] = useState<DnsAccount[]>([])
  const [managedCerts, setManagedCerts] = useState<NpsManagedCertOption[]>([])
  const [selectedServerId, setSelectedServerId] = useState<number>(() => {
    const saved = Number(window.localStorage.getItem(SELECTED_SERVER_STORAGE_KEY) || 0)
    return Number.isFinite(saved) && saved > 0 ? saved : 0
  })

  const [dataLoading, setDataLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [clients, setClients] = useState<NpsClientItem[]>([])
  const [bridge, setBridge] = useState<NpsBridgeInfo | null>(null)
  const [tunnels, setTunnels] = useState<NpsTunnelItem[]>([])
  const [hosts, setHosts] = useState<NpsHostItem[]>([])

  // Filters & Pagination
  const [clientFilter, setClientFilter] = useState<number>(0)
  const [protoFilter, setProtoFilter] = useState<string>('all')
  const [searchText, setSearchText] = useState('')
  const [clientsPage, setClientsPage] = useState(1)
  const [tunnelsPage, setTunnelsPage] = useState(1)
  const [revealedVkeys, setRevealedVkeys] = useState<Record<number, boolean>>({})
  const [copiedKey, setCopiedKey] = useState('')
  const [busyKey, setBusyKey] = useState('')

  // Modals
  const [serverModal, setServerModal] = useState<{ open: boolean; editing: NpsServerItem | null }>({
    open: false,
    editing: null,
  })
  const [clientModal, setClientModal] = useState<{ open: boolean; editing: NpsClientItem | null }>({
    open: false,
    editing: null,
  })
  const [tunnelModal, setTunnelModal] = useState<{
    open: boolean
    editing: NpsTunnelItem | null
    defaultClientId?: number
  }>({ open: false, editing: null })
  const [hostModal, setHostModal] = useState<{
    open: boolean
    editing: NpsHostItem | null
    defaultClientId?: number
  }>({ open: false, editing: null })
  const [certModalHost, setCertModalHost] = useState<NpsHostItem | null>(null)

  const currentServer = useMemo(
    () => servers.find((s) => s.id === selectedServerId) ?? servers[0] ?? null,
    [servers, selectedServerId],
  )

  const copyText = useCallback(
    async (text: string, key: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text)
        setCopiedKey(key)
        onToast(`已复制${label}`, 'success')
        window.setTimeout(() => setCopiedKey((cur) => (cur === key ? '' : cur)), 1800)
      } catch {
        onToast('复制失败，请手动选中复制', 'error')
      }
    },
    [onToast],
  )

  const loadBootstrap = useCallback(async (preferredId?: number) => {
    setBootLoading(true)
    try {
      const res = await api<NpsBootstrapResponse>('/api/v1/nps/servers')
      setServers(res.servers)
      setTencentAccounts(res.tencent_accounts)
      setDnsAccounts(res.dns_accounts)
      setManagedCerts(res.managed_certs)
      setSelectedServerId((prev) => {
        const want = preferredId ?? prev
        if (want && res.servers.some((s) => s.id === want)) return want
        return res.servers[0]?.id ?? 0
      })
    } catch (err) {
      onToast(err instanceof Error ? err.message : '加载 NPS 配置失败', 'error')
    } finally {
      setBootLoading(false)
    }
  }, [onToast])

  const loadServerData = useCallback(async (serverId: number) => {
    if (!serverId) {
      setClients([])
      setTunnels([])
      setHosts([])
      setBridge(null)
      setLoadError('')
      return
    }
    setDataLoading(true)
    setLoadError('')
    try {
      const [clientsRes, tunnelsRes, hostsRes] = await Promise.all([
        api<{ total: number; items: NpsClientItem[]; bridge: NpsBridgeInfo }>(
          `/api/v1/nps/servers/${serverId}/clients`,
        ),
        api<{ total: number; items: NpsTunnelItem[] }>(
          `/api/v1/nps/servers/${serverId}/tunnels`,
        ),
        api<{ total: number; items: NpsHostItem[] }>(
          `/api/v1/nps/servers/${serverId}/hosts`,
        ),
      ])
      setClients(clientsRes.items)
      setBridge(clientsRes.bridge)
      setTunnels(tunnelsRes.items)
      setHosts(hostsRes.items)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '连接 NPS 服务器失败'
      setLoadError(msg)
    } finally {
      setDataLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadBootstrap()
  }, [loadBootstrap])

  useEffect(() => {
    setClientsPage(1)
    setTunnelsPage(1)
    if (currentServer) {
      window.localStorage.setItem(SELECTED_SERVER_STORAGE_KEY, String(currentServer.id))
      void loadServerData(currentServer.id)
    } else {
      setClients([])
      setTunnels([])
      setHosts([])
      setBridge(null)
      setLoadError('')
    }
  }, [currentServer?.id, loadServerData])

  useEffect(() => {
    setTunnelsPage(1)
  }, [clientFilter, protoFilter, searchText])

  const refreshAll = useCallback(async () => {
    await loadBootstrap(currentServer?.id)
    if (currentServer) {
      await loadServerData(currentServer.id)
    }
  }, [loadBootstrap, loadServerData, currentServer])

  // Computed metrics
  const clientNameMap = useMemo(() => {
    const m = new Map<number, NpsClientItem>()
    for (const c of clients) m.set(c.id, c)
    return m
  }, [clients])

  const stats = useMemo(() => {
    const onlineClients = clients.filter((c) => c.isConnect).length
    const tcpCount = tunnels.filter((t) => t.mode === 'tcp').length
    const udpCount = tunnels.filter((t) => t.mode === 'udp').length
    const hostsWithCert = hosts.filter((h) => h.hasCert).length
    const hostsAutoRenew = hosts.filter((h) => Boolean(h.certBinding)).length
    const hostsWithCdn = hosts.filter(
      (h) => (h.cdnBindings?.length ?? 0) > 0,
    ).length
    return {
      onlineClients,
      totalClients: clients.length,
      tcpCount,
      udpCount,
      totalTunnels: tunnels.length,
      totalHosts: hosts.length,
      hostsWithCert,
      hostsAutoRenew,
      hostsWithCdn,
    }
  }, [clients, tunnels, hosts])

  const filteredTunnels = useMemo(() => {
    const kw = searchText.trim().toLowerCase()
    return tunnels.filter((t) => {
      if (clientFilter > 0 && t.clientId !== clientFilter) return false
      if (protoFilter === 'tcp' && t.mode !== 'tcp') return false
      if (protoFilter === 'udp' && t.mode !== 'udp') return false
      if (protoFilter === 'other' && (t.mode === 'tcp' || t.mode === 'udp')) return false
      if (kw) {
        const cli = clientNameMap.get(t.clientId)
        const hay = `${t.id} ${t.mode} ${t.port} ${t.target} ${t.remark} ${t.clientRemark} ${cli?.remark ?? ''}`.toLowerCase()
        if (!hay.includes(kw)) return false
      }
      return true
    })
  }, [tunnels, clientFilter, protoFilter, searchText, clientNameMap])

  const clientsTotalPages = Math.max(1, Math.ceil(clients.length / CLIENTS_PAGE_SIZE))
  const safeClientsPage = Math.min(clientsPage, clientsTotalPages)
  const pagedClients = useMemo(
    () =>
      clients.slice(
        (safeClientsPage - 1) * CLIENTS_PAGE_SIZE,
        safeClientsPage * CLIENTS_PAGE_SIZE,
      ),
    [clients, safeClientsPage],
  )

  const tunnelsTotalPages = Math.max(1, Math.ceil(filteredTunnels.length / TUNNELS_PAGE_SIZE))
  const safeTunnelsPage = Math.min(tunnelsPage, tunnelsTotalPages)
  const pagedTunnels = useMemo(
    () =>
      filteredTunnels.slice(
        (safeTunnelsPage - 1) * TUNNELS_PAGE_SIZE,
        safeTunnelsPage * TUNNELS_PAGE_SIZE,
      ),
    [filteredTunnels, safeTunnelsPage],
  )

  const filteredHosts = useMemo(() => {
    const kw = searchText.trim().toLowerCase()
    return hosts.filter((h) => {
      if (clientFilter > 0 && h.clientId !== clientFilter) return false
      if (kw) {
        const cli = clientNameMap.get(h.clientId)
        const hay = `${h.id} ${h.host} ${h.target} ${h.remark} ${h.location} ${h.clientRemark} ${cli?.remark ?? ''}`.toLowerCase()
        if (!hay.includes(kw)) return false
      }
      return true
    })
  }, [hosts, clientFilter, searchText, clientNameMap])

  // Server actions
  const testCurrentServer = async () => {
    if (!currentServer) return
    setBusyKey('test-server')
    try {
      const res = await post<{ ok: true; client_count: number; bridge: NpsBridgeInfo }>(
        `/api/v1/nps/servers/${currentServer.id}/test`,
      )
      onToast(
        `连接成功：共 ${res.client_count} 个客户端（桥接 ${res.bridge.bridgeType.toUpperCase()} :${res.bridge.bridgePort}）`,
        'success',
      )
      await loadServerData(currentServer.id)
    } catch (err) {
      onToast(err instanceof Error ? err.message : '连接测试失败', 'error')
    } finally {
      setBusyKey('')
    }
  }

  const removeCurrentServer = () => {
    if (!currentServer) return
    onConfirm({
      title: `移除 NPS 服务器「${currentServer.label}」`,
      message: `将从面板移除「${currentServer.label}」（${currentServer.base_url}）及其证书自动同步绑定。`,
      hint: '仅移除面板连接，不会删除 NPS 服务端上的客户端、端口映射或域名配置。',
      confirmText: '确认移除',
      run: async () => {
        await del(`/api/v1/nps/servers/${currentServer.id}`)
        onToast(`已移除 NPS 服务器「${currentServer.label}」`, 'success')
        await loadBootstrap(0)
        onChanged?.()
      },
    })
  }

  // Client actions
  const toggleClientStatus = async (cli: NpsClientItem) => {
    if (!currentServer) return
    const key = `cli-status-${cli.id}`
    setBusyKey(key)
    try {
      await post(`/api/v1/nps/servers/${currentServer.id}/clients/${cli.id}/status`, {
        enabled: !cli.status,
      })
      onToast(cli.status ? `已禁用客户端 #${cli.id}` : `已启用客户端 #${cli.id}`, 'success')
      await loadServerData(currentServer.id)
    } catch (err) {
      onToast(err instanceof Error ? err.message : '切换客户端状态失败', 'error')
    } finally {
      setBusyKey('')
    }
  }

  const deleteClient = (cli: NpsClientItem) => {
    if (!currentServer) return
    onConfirm({
      title: `删除客户端「${cli.remark || `#${cli.id}`}」`,
      message: `确定从 NPS 删除客户端 #${cli.id} 吗？该客户端名下的端口映射和域名解析将一并失效。`,
      confirmText: '确认删除',
      run: async () => {
        await del(`/api/v1/nps/servers/${currentServer.id}/clients/${cli.id}`)
        onToast(`已删除客户端 #${cli.id}`, 'success')
        if (clientFilter === cli.id) setClientFilter(0)
        await loadServerData(currentServer.id)
      },
    })
  }

  // Tunnel actions
  const toggleTunnel = async (t: NpsTunnelItem) => {
    if (!currentServer) return
    const key = `tun-toggle-${t.id}`
    setBusyKey(key)
    try {
      await post(
        `/api/v1/nps/servers/${currentServer.id}/tunnels/${t.id}/${t.status ? 'stop' : 'start'}`,
      )
      onToast(t.status ? `已停止映射 :${t.port}` : `已启动映射 :${t.port}`, 'success')
      await loadServerData(currentServer.id)
    } catch (err) {
      onToast(err instanceof Error ? err.message : '操作失败', 'error')
    } finally {
      setBusyKey('')
    }
  }

  const deleteTunnel = (t: NpsTunnelItem) => {
    if (!currentServer) return
    onConfirm({
      title: `删除端口映射 ${t.mode.toUpperCase()} :${t.port}`,
      message: `确定删除转发规则「${t.remark || `${t.mode.toUpperCase()} :${t.port} → ${t.target}`}」吗？`,
      confirmText: '确认删除',
      run: async () => {
        await del(`/api/v1/nps/servers/${currentServer.id}/tunnels/${t.id}`)
        onToast(`已删除端口映射 #${t.id}`, 'success')
        await loadServerData(currentServer.id)
      },
    })
  }

  // Host actions
  const toggleHost = async (h: NpsHostItem) => {
    if (!currentServer) return
    const key = `host-toggle-${h.id}`
    setBusyKey(key)
    try {
      await post(
        `/api/v1/nps/servers/${currentServer.id}/hosts/${h.id}/${h.isClose ? 'start' : 'stop'}`,
      )
      onToast(h.isClose ? `已启用域名 ${h.host}` : `已停用域名 ${h.host}`, 'success')
      await loadServerData(currentServer.id)
    } catch (err) {
      onToast(err instanceof Error ? err.message : '操作失败', 'error')
    } finally {
      setBusyKey('')
    }
  }

  const deleteHost = (h: NpsHostItem) => {
    if (!currentServer) return
    onConfirm({
      title: `删除域名解析「${h.host}」`,
      message: `确定从 NPS 删除域名绑定 ${h.host}（→ ${h.target}）吗？关联的证书自动同步绑定也会一并清理。`,
      confirmText: '确认删除',
      run: async () => {
        await del(`/api/v1/nps/servers/${currentServer.id}/hosts/${h.id}`)
        onToast(`已删除域名解析 ${h.host}`, 'success')
        await loadServerData(currentServer.id)
      },
    })
  }

  const syncHostCertNow = async (h: NpsHostItem) => {
    if (!currentServer) return
    const key = `host-sync-${h.id}`
    setBusyKey(key)
    try {
      const res = await post<{ ok: true; result: { synced: boolean; detail: string } }>(
        `/api/v1/nps/servers/${currentServer.id}/hosts/${h.id}/cert/sync`,
        undefined,
        SLOW_TIMEOUT_MS,
      )
      onToast(res.result.detail, res.result.synced ? 'success' : 'info')
      await refreshAll()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '证书同步失败', 'error')
    } finally {
      setBusyKey('')
    }
  }

  const reconcileAllNpsCerts = async () => {
    setBusyKey('reconcile-nps-certs')
    try {
      const res = await post<{
        ok: true
        summary: { checked: number; synced: number; failed: number; cdnSynced: number; errors: string[] }
      }>('/api/v1/nps/certs/reconcile', undefined, SLOW_TIMEOUT_MS)
      const s = res.summary
      if (s.failed > 0) {
        onToast(`巡检 ${s.checked} 条：成功 ${s.synced}，失败 ${s.failed}（${s.errors[0] || ''}）`, 'error')
      } else {
        onToast(
          `已巡检 ${s.checked} 条绑定，补推 NPS ${s.synced} 条${s.cdnSynced > 0 ? `、同步 CDN ${s.cdnSynced} 条` : ''}`,
          'success',
        )
      }
      await refreshAll()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '证书同步巡检失败', 'error')
    } finally {
      setBusyKey('')
    }
  }

  const pageTitle = section === 'tunnels' ? 'NPS 端口映射' : 'NPS 域名解析'
  const pageSubtitle =
    section === 'tunnels'
      ? '对接 yisier/nps 管理穿透客户端，添加、启停与删除 TCP / UDP 等端口转发规则'
      : '管理 NPS 域名反向代理与 HTTPS 证书，联动腾讯云 SSL 自动申请、热替换、自动续期并同步 EdgeOne CDN'

  return (
    <div className="nps-root">
      <div className="page-head">
        <div>
          <h2>{pageTitle}</h2>
          <p>{pageSubtitle}</p>
        </div>

        <div className="page-actions nps-page-actions">
          {servers.length > 0 && (
            <>
              <select
                className="select nps-server-select"
                value={currentServer?.id ?? 0}
                onChange={(e) => {
                  const id = Number(e.target.value)
                  setSelectedServerId(id)
                  setClientFilter(0)
                }}
                aria-label="选择 NPS 服务器"
              >
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label} ({s.base_url.replace(/^https?:\/\//, '')})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn ghost sm"
                onClick={testCurrentServer}
                disabled={busyKey === 'test-server' || !currentServer}
                title="测试 NPS 服务端连通性"
              >
                {busyKey === 'test-server' ? <LoaderCircle size={13} className="spin" /> : <Zap size={13} />}
                测试
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => currentServer && setServerModal({ open: true, editing: currentServer })}
                disabled={!currentServer}
                title="编辑当前 NPS 服务器"
              >
                <Edit3 size={13} />
              </button>
              <button
                type="button"
                className="btn ghost sm danger"
                onClick={removeCurrentServer}
                disabled={!currentServer}
                title="从面板移除当前 NPS 服务器"
              >
                <Trash2 size={13} />
              </button>
            </>
          )}

          <button
            type="button"
            className="btn ghost sm"
            onClick={() => void refreshAll()}
            disabled={bootLoading || dataLoading}
          >
            <RefreshCw size={13} className={bootLoading || dataLoading ? 'spin' : ''} />
            刷新
          </button>

          <button
            type="button"
            className="btn primary sm"
            onClick={() => setServerModal({ open: true, editing: null })}
          >
            <Plus size={13} />
            添加 NPS 服务器
          </button>
        </div>
      </div>

      {bootLoading && servers.length === 0 ? (
        <div className="card nps-loading-card">
          <LoaderCircle size={18} className="spin" />
          <span>正在加载 NPS 配置…</span>
        </div>
      ) : !currentServer ? (
        <div className="card">
          <Empty
            icon={<Network size={28} />}
            title="尚未对接 NPS 服务器"
            children={
              <div className="nps-empty-body">
                <p>
                  支持原生对接 <code>yisier/nps</code> Web 管理接口。添加服务器后即可统一管理内网穿透客户端、
                  TCP/UDP 端口映射、域名反向代理，并联动腾讯云 SSL 实现证书自动申请、热替换、自动续期与 CDN 同步。
                </p>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => setServerModal({ open: true, editing: null })}
                >
                  <Plus size={14} /> 添加第一台 NPS 服务器
                </button>
              </div>
            }
          />
        </div>
      ) : (
        <>
          {loadError && (
            <div className="nps-error-banner">
              <div>
                <strong>连接 NPS 服务器「{currentServer.label}」失败</strong>
                <span>{loadError}</span>
              </div>
              <div className="nps-error-actions">
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setServerModal({ open: true, editing: currentServer })}
                >
                  检查配置
                </button>
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => void loadServerData(currentServer.id)}
                >
                  重试
                </button>
              </div>
            </div>
          )}

          {/* KPI Strip */}
          <div className="nps-kpi-strip">
            {section === 'tunnels' ? (
              <>
                <div className="nps-kpi-card">
                  <span className="nps-kpi-label">在线客户端</span>
                  <strong className="nps-kpi-val">
                    {stats.onlineClients}
                    <small> / {stats.totalClients}</small>
                  </strong>
                  <span className="nps-kpi-sub">
                    {bridge ? `桥接 ${bridge.bridgeType.toUpperCase()} :${bridge.bridgePort}` : currentServer.base_url}
                  </span>
                </div>
                <div className="nps-kpi-card">
                  <span className="nps-kpi-label">TCP 端口映射</span>
                  <strong className="nps-kpi-val">{stats.tcpCount}</strong>
                  <span className="nps-kpi-sub">常用 SSH / 数据库 / 业务端口</span>
                </div>
                <div className="nps-kpi-card">
                  <span className="nps-kpi-label">UDP 端口映射</span>
                  <strong className="nps-kpi-val">{stats.udpCount}</strong>
                  <span className="nps-kpi-sub">WireGuard / DNS / 游戏语音</span>
                </div>
                <div
                  className="nps-kpi-card clickable"
                  onClick={() => onSwitchSection('hosts')}
                  title="前往 NPS 域名解析与证书管理"
                >
                  <span className="nps-kpi-label">已绑定域名</span>
                  <strong className="nps-kpi-val">
                    {stats.totalHosts}
                    <small> ({stats.hostsAutoRenew} 自动续期)</small>
                  </strong>
                  <span className="nps-kpi-sub">点击前往管理域名与证书 →</span>
                </div>
              </>
            ) : (
              <>
                <div className="nps-kpi-card">
                  <span className="nps-kpi-label">域名解析总数</span>
                  <strong className="nps-kpi-val">{stats.totalHosts}</strong>
                  <span className="nps-kpi-sub">在线客户端 {stats.onlineClients} / {stats.totalClients}</span>
                </div>
                <div className="nps-kpi-card">
                  <span className="nps-kpi-label">已配置 HTTPS 证书</span>
                  <strong className="nps-kpi-val">
                    {stats.hostsWithCert}
                    <small> / {stats.totalHosts}</small>
                  </strong>
                  <span className="nps-kpi-sub">支持 PEM 热替换，无需重启 NPS</span>
                </div>
                <div className="nps-kpi-card">
                  <span className="nps-kpi-label">腾讯云自动续期</span>
                  <strong className="nps-kpi-val">{stats.hostsAutoRenew}</strong>
                  <span className="nps-kpi-sub">到期前 7 天自动续签并热更新</span>
                </div>
                <div className="nps-kpi-card">
                  <span className="nps-kpi-label">已同步 EdgeOne CDN</span>
                  <strong className="nps-kpi-val">{stats.hostsWithCdn}</strong>
                  <span className="nps-kpi-sub">证书更新时自动同步 CDN 边缘</span>
                </div>
              </>
            )}
          </div>

          {section === 'tunnels' ? (
            <>
              {/* Clients Section */}
              <section className="section nps-section">
                <div className="section-head">
                  <div className="nps-section-title">
                    <ServerIcon size={15} />
                    <h3>NPS 客户端</h3>
                    <span className="nps-count-pill">{clients.length}</span>
                    {clientFilter > 0 && (
                      <button
                        type="button"
                        className="nps-clear-chip"
                        onClick={() => setClientFilter(0)}
                      >
                        已筛选客户端 #{clientFilter} ×
                      </button>
                    )}
                  </div>
                  <div className="nps-head-actions">
                    <button
                      type="button"
                      className="btn primary sm"
                      onClick={() => setClientModal({ open: true, editing: null })}
                    >
                      <Plus size={13} /> 新增客户端
                    </button>
                  </div>
                </div>

                {clients.length === 0 ? (
                  <div className="card">
                    <Empty
                      icon={<ServerIcon size={24} />}
                      title="暂无 NPS 客户端"
                      children="点击右上角「新增客户端」生成 VerifyKey，然后在内网设备运行 npc 即可上线。"
                    />
                  </div>
                ) : (
                  <>
                    <div className="nps-client-grid">
                      {pagedClients.map((cli) => {
                      const isSelected = clientFilter === cli.id
                      const vkeyShown = Boolean(revealedVkeys[cli.id])
                      const npcCmd = buildNpcCommand(bridge, currentServer.base_url, cli.verifyKey)
                      const cliTunnelCount = tunnels.filter((t) => t.clientId === cli.id).length
                      const cliHostCount = hosts.filter((h) => h.clientId === cli.id).length

                      return (
                        <div
                          key={cli.id}
                          className={`card nps-client-card${isSelected ? ' selected' : ''}${!cli.status ? ' disabled' : ''}`}
                        >
                          <div className="nps-client-top">
                            <div
                              className="nps-client-title"
                              onClick={() => setClientFilter((cur) => (cur === cli.id ? 0 : cli.id))}
                              title="点击按此客户端筛选下方端口映射"
                            >
                              <span className="nps-client-id">#{cli.id}</span>
                              <strong>{cli.remark || `客户端 #${cli.id}`}</strong>
                            </div>
                            <div className="nps-client-badges">
                              {!cli.status ? (
                                <Badge tone="red">已禁用</Badge>
                              ) : cli.isConnect ? (
                                <Badge tone="green">
                                  <Wifi size={10} /> 在线
                                </Badge>
                              ) : (
                                <Badge tone="gray">
                                  <WifiOff size={10} /> 离线
                                </Badge>
                              )}
                            </div>
                          </div>

                          <div className="nps-vkey-row">
                            <span className="nps-vkey-label">密钥</span>
                            <code className="nps-vkey-code">
                              {vkeyShown ? cli.verifyKey : maskVkey(cli.verifyKey)}
                            </code>
                            <button
                              type="button"
                              className="btn ghost icon sm"
                              onClick={() =>
                                setRevealedVkeys((prev) => ({ ...prev, [cli.id]: !prev[cli.id] }))
                              }
                              title={vkeyShown ? '隐藏密钥' : '显示完整密钥'}
                            >
                              {vkeyShown ? <EyeOff size={12} /> : <Eye size={12} />}
                            </button>
                            <button
                              type="button"
                              className="btn ghost icon sm"
                              onClick={() => void copyText(cli.verifyKey, `vkey-${cli.id}`, 'VerifyKey')}
                              title="复制 VerifyKey"
                            >
                              {copiedKey === `vkey-${cli.id}` ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                            <button
                              type="button"
                              className="btn ghost sm nps-cmd-btn"
                              onClick={() => void copyText(npcCmd, `cmd-${cli.id}`, 'npc 启动命令')}
                              title={npcCmd}
                            >
                              {copiedKey === `cmd-${cli.id}` ? <Check size={12} /> : <Terminal size={12} />}
                              npc 命令
                            </button>
                          </div>

                          <div className="nps-client-stats">
                            <span>
                              地址：<b>{cli.addr || '未连接'}</b>
                            </span>
                            <span>
                              连接：<b>{cli.nowConn}</b>
                            </span>
                            <span>
                              端口：<b>{cliTunnelCount}</b> · 域名：<b>{cliHostCount}</b>
                            </span>
                            <span>
                              流量：<b>↓{formatBytes(cli.inletFlow)} / ↑{formatBytes(cli.exportFlow)}</b>
                            </span>
                          </div>

                          <div className="nps-client-foot">
                            <div className="nps-client-quick">
                              <button
                                type="button"
                                className="btn ghost sm"
                                onClick={() =>
                                  setTunnelModal({ open: true, editing: null, defaultClientId: cli.id })
                                }
                              >
                                <Plus size={12} /> 端口
                              </button>
                              <button
                                type="button"
                                className="btn ghost sm"
                                onClick={() =>
                                  setHostModal({ open: true, editing: null, defaultClientId: cli.id })
                                }
                              >
                                <Globe2 size={12} /> 域名
                              </button>
                            </div>
                            <div className="nps-client-ops">
                              <button
                                type="button"
                                className="btn ghost sm"
                                onClick={() => setClientModal({ open: true, editing: cli })}
                                title="编辑客户端"
                              >
                                <Edit3 size={12} />
                              </button>
                              <button
                                type="button"
                                className="btn ghost sm"
                                disabled={busyKey === `cli-status-${cli.id}`}
                                onClick={() => void toggleClientStatus(cli)}
                                title={cli.status ? '禁用客户端' : '启用客户端'}
                              >
                                {busyKey === `cli-status-${cli.id}` ? (
                                  <LoaderCircle size={12} className="spin" />
                                ) : cli.status ? (
                                  <Square size={12} />
                                ) : (
                                  <Play size={12} />
                                )}
                              </button>
                              <button
                                type="button"
                                className="btn ghost sm danger"
                                onClick={() => deleteClient(cli)}
                                title="删除客户端"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                    </div>
                    <NpsPager
                      label="NPS 客户端分页"
                      total={clients.length}
                      pageSize={CLIENTS_PAGE_SIZE}
                      page={safeClientsPage}
                      unit="个"
                      onChange={setClientsPage}
                    />
                  </>
                )}
              </section>

              {/* Tunnels Section */}
              <section className="section nps-section">
                <div className="section-head">
                  <div className="nps-section-title">
                    <Network size={15} />
                    <h3>端口映射规则</h3>
                    <span className="nps-count-pill">{filteredTunnels.length}</span>
                  </div>
                  <div className="nps-head-actions">
                    <button
                      type="button"
                      className="btn primary sm"
                      onClick={() =>
                        setTunnelModal({
                          open: true,
                          editing: null,
                          defaultClientId: clientFilter || clients[0]?.id,
                        })
                      }
                      disabled={clients.length === 0}
                    >
                      <Plus size={13} /> 添加端口映射
                    </button>
                  </div>
                </div>

                <div className="nps-filter-bar">
                  <Segmented
                    value={protoFilter}
                    options={TUNNEL_FILTER_OPTIONS}
                    onChange={setProtoFilter}
                  />
                  <div className="nps-search-wrap">
                    <Search size={13} />
                    <input
                      className="input nps-search-input"
                      placeholder="搜索端口 / 目标 / 备注…"
                      value={searchText}
                      onChange={(e) => setSearchText(e.target.value)}
                    />
                  </div>
                </div>

                {filteredTunnels.length === 0 ? (
                  <div className="card">
                    <Empty
                      icon={<Network size={24} />}
                      title="暂无匹配的端口映射"
                      children={
                        clients.length === 0
                          ? '请先新增至少一个 NPS 客户端，再为其添加 TCP / UDP 端口转发。'
                          : '点击「添加端口映射」即可创建 TCP、UDP、SOCKS5、HTTP 代理或 P2P 规则。'
                      }
                    />
                  </div>
                ) : (
                  <>
                    <div className="card nps-table-card">
                      <div className="nps-table-scroll">
                        <table className="nps-table">
                          <thead>
                            <tr>
                              <th>协议</th>
                              <th>服务端端口</th>
                              <th>内网目标</th>
                              <th>所属客户端</th>
                              <th>备注</th>
                              <th>流量</th>
                              <th>状态</th>
                              <th className="right">操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pagedTunnels.map((t) => {
                              const mb = tunnelModeBadge(t.mode)
                              const cli = clientNameMap.get(t.clientId)
                              const portLabel = t.port > 0 ? `${t.serverIp ? `${t.serverIp}:` : ':'}${t.port}` : '—'
                              const busy = busyKey === `tun-toggle-${t.id}`
                              return (
                                <tr key={t.id}>
                                  <td>
                                    <Badge tone={mb.tone} dot={false}>
                                      {mb.label}
                                    </Badge>
                                  </td>
                                  <td>
                                    <div className="nps-mono-cell">
                                      <code>{portLabel}</code>
                                      {t.port > 0 && (
                                        <button
                                          type="button"
                                          className="btn ghost icon sm"
                                          onClick={() =>
                                            void copyText(
                                              `${t.serverIp || bridge?.ip || ''}:${t.port}`,
                                              `port-${t.id}`,
                                              '监听地址',
                                            )
                                          }
                                          title="复制监听地址"
                                        >
                                          {copiedKey === `port-${t.id}` ? <Check size={11} /> : <Copy size={11} />}
                                        </button>
                                      )}
                                    </div>
                                  </td>
                                  <td>
                                    <code className="nps-target-code">
                                      {t.mode === 'file' ? t.localPath || '—' : t.target || '—'}
                                    </code>
                                    {t.localProxy && <span className="nps-mini-tag">本地代理</span>}
                                  </td>
                                  <td>
                                    <div className="nps-client-chip">
                                      <i className={`nps-dot ${cli?.isConnect ?? t.clientOnline ? 'on' : 'off'}`} />
                                      <span>{cli?.remark || t.clientRemark || `客户端 #${t.clientId}`}</span>
                                    </div>
                                  </td>
                                  <td className="nps-remark-cell">{t.remark || '—'}</td>
                                  <td className="nps-flow-cell">
                                    ↓{formatBytes(t.inletFlow)} / ↑{formatBytes(t.exportFlow)}
                                  </td>
                                  <td>
                                    {t.status ? (
                                      <Badge tone={t.runStatus ? 'green' : 'amber'}>
                                        {t.runStatus ? '运行中' : '已开启'}
                                      </Badge>
                                    ) : (
                                      <Badge tone="gray">已停止</Badge>
                                    )}
                                  </td>
                                  <td className="right">
                                    <div className="nps-row-actions">
                                      <button
                                        type="button"
                                        className="btn ghost sm"
                                        disabled={busy}
                                        onClick={() => void toggleTunnel(t)}
                                        title={t.status ? '停止' : '启动'}
                                      >
                                        {busy ? (
                                          <LoaderCircle size={12} className="spin" />
                                        ) : t.status ? (
                                          <Square size={12} />
                                        ) : (
                                          <Play size={12} />
                                        )}
                                      </button>
                                      <button
                                        type="button"
                                        className="btn ghost sm"
                                        onClick={() => setTunnelModal({ open: true, editing: t })}
                                        title="编辑"
                                      >
                                        <Edit3 size={12} />
                                      </button>
                                      <button
                                        type="button"
                                        className="btn ghost sm danger"
                                        onClick={() => deleteTunnel(t)}
                                        title="删除"
                                      >
                                        <Trash2 size={12} />
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <NpsPager
                      label="端口映射分页"
                      total={filteredTunnels.length}
                      pageSize={TUNNELS_PAGE_SIZE}
                      page={safeTunnelsPage}
                      unit="条"
                      onChange={setTunnelsPage}
                    />
                  </>
                )}
              </section>
            </>
          ) : (
            /* Hosts / Domain Resolution & SSL Automation View */
            <section className="section nps-section">
              <div className="section-head">
                <div className="nps-section-title">
                  <Link2 size={15} />
                  <h3>域名绑定与 HTTPS 证书联动</h3>
                  <span className="nps-count-pill">{filteredHosts.length}</span>
                </div>
                <div className="nps-head-actions">
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busyKey === 'reconcile-nps-certs'}
                    onClick={() => void reconcileAllNpsCerts()}
                    title="检查并补推所有未同步的腾讯云证书到 NPS 及 CDN"
                  >
                    {busyKey === 'reconcile-nps-certs' ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : (
                      <ShieldCheck size={13} />
                    )}
                    同步证书
                  </button>
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={clients.length === 0}
                    onClick={() =>
                      setHostModal({
                        open: true,
                        editing: null,
                        defaultClientId: clientFilter || clients[0]?.id,
                      })
                    }
                  >
                    <Plus size={13} /> 新增域名绑定
                  </button>
                </div>
              </div>

              <div className="nps-filter-bar">
                {clients.length > 0 && (
                  <select
                    className="select nps-client-filter"
                    value={clientFilter}
                    onChange={(e) => setClientFilter(Number(e.target.value))}
                    aria-label="按客户端筛选"
                  >
                    <option value={0}>全部客户端</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        #{c.id} {c.remark || `客户端 #${c.id}`}
                      </option>
                    ))}
                  </select>
                )}
                <div className="nps-search-wrap">
                  <Search size={13} />
                  <input
                    className="input nps-search-input"
                    placeholder="搜索域名 / 目标 / 备注…"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                  />
                </div>
              </div>

              {filteredHosts.length === 0 ? (
                <div className="card">
                  <Empty
                    icon={<Globe2 size={26} />}
                    title="暂无 NPS 域名解析"
                    children={
                      clients.length === 0
                        ? '请先在「端口映射」页面添加至少一个 NPS 客户端，再回来绑定域名与证书。'
                        : '点击「新增域名绑定」即可将公网域名反代至内网服务，并一键申请腾讯云免费 SSL 证书（自动替换、自动续期、同步 CDN）。'
                    }
                  />
                </div>
              ) : (
                <div className="nps-host-list">
                  {filteredHosts.map((h) => {
                    const cli = clientNameMap.get(h.clientId)
                    const binding = h.certBinding ?? null
                    const left = daysLeft(binding?.ssl_cert_end_ts)
                    const cdnList = h.cdnBindings ?? []
                    const isSyncing = busyKey === `host-sync-${h.id}`
                    const isToggling = busyKey === `host-toggle-${h.id}`

                    return (
                      <div key={h.id} className={`nps-host-card${h.isClose ? ' closed' : ''}`}>
                        <div className="nps-host-top">
                          <div className="nps-host-name-wrap">
                            <span className="nps-host-domain">{h.host}</span>
                            <button
                              type="button"
                              className="btn ghost icon sm"
                              onClick={() => void copyText(h.host, `host-${h.id}`, '域名')}
                              title="复制域名"
                            >
                              {copiedKey === `host-${h.id}` ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                            <Badge tone={h.isClose ? 'gray' : 'green'}>
                              {h.isClose ? '已停用' : '运行中'}
                            </Badge>
                            <Badge tone="blue" dot={false}>
                              {h.scheme === 'all' ? 'HTTP + HTTPS' : h.scheme.toUpperCase()}
                            </Badge>
                            {h.autoHttps && (
                              <Badge tone="green" dot={false}>
                                自动 HTTPS
                              </Badge>
                            )}
                            <span className="nps-client-chip">
                              <i className={`nps-dot ${cli?.isConnect ?? h.clientOnline ? 'on' : 'off'}`} />
                              {cli?.remark || h.clientRemark || `客户端 #${h.clientId}`}
                            </span>
                            {h.remark && <span className="nps-host-remark">· {h.remark}</span>}
                          </div>
                        </div>

                        <div className="nps-host-meta">
                          <div>
                            <span className="cert-meta-k">内网目标</span>
                            <span className="cert-meta-v mono">{h.target}</span>
                            {h.location && (
                              <span className="nps-meta-sub">路由：{h.location}</span>
                            )}
                          </div>

                          <div>
                            <span className="cert-meta-k">NPS 证书状态</span>
                            <span className="cert-meta-v">
                              {h.hasCert ? (
                                <Badge tone="green" dot={false}>
                                  {h.certMode === 'pem' ? '内联 PEM 已生效' : '路径证书已生效'}
                                </Badge>
                              ) : (
                                <Badge tone="gray" dot={false}>
                                  未配置证书
                                </Badge>
                              )}
                            </span>
                            {h.certPreview && (
                              <span className="nps-meta-sub mono">{h.certPreview}</span>
                            )}
                          </div>

                          <div>
                            <span className="cert-meta-k">腾讯 SSL 自动续期</span>
                            {binding ? (
                              <>
                                <span className="cert-meta-v">
                                  {binding.ssl_status === 'issued' ? (
                                    <Badge
                                      tone={left !== null && left <= 7 ? 'amber' : 'green'}
                                      dot={false}
                                    >
                                      已联动 · {binding.ssl_cert_current_id || binding.last_deployed_cert_id}
                                    </Badge>
                                  ) : binding.ssl_status === 'failed' ? (
                                    <Badge tone="red" dot={false}>
                                      审核失败
                                    </Badge>
                                  ) : (
                                    <Badge tone="blue" dot={false}>
                                      {binding.ssl_status_name || '验证签发中'}
                                    </Badge>
                                  )}
                                </span>
                                <span className="nps-meta-sub">
                                  {binding.ssl_cert_end_time
                                    ? `到期 ${binding.ssl_cert_end_time.slice(0, 10)}${left !== null ? `（剩 ${left} 天）` : ''}`
                                    : binding.last_deployed_at
                                      ? `上次推送 ${formatTs(binding.last_deployed_at)}`
                                      : '签发后将自动热写入 NPS'}
                                </span>
                                {binding.last_error && (
                                  <span className="nps-meta-err">{binding.last_error}</span>
                                )}
                              </>
                            ) : (
                              <span className="nps-meta-sub">未绑定腾讯云自动续期</span>
                            )}
                          </div>

                          <div>
                            <span className="cert-meta-k">CDN 同步联动</span>
                            {cdnList.length > 0 ? (
                              <>
                                <span className="cert-meta-v">
                                  <Badge tone="green" dot={false}>
                                    <CloudLightning size={11} /> EdgeOne 已同步 ({cdnList.length})
                                  </Badge>
                                </span>
                                <span className="nps-meta-sub">
                                  {cdnList.map((c) => c.zone_name || c.zone_id).join('、')}
                                  {cdnList[0]?.last_deployed_cert_id
                                    ? ` · ${cdnList[0].last_deployed_cert_id}`
                                    : ''}
                                </span>
                              </>
                            ) : binding?.sync_cdn ? (
                              <>
                                <span className="cert-meta-v">
                                  <Badge tone="blue" dot={false}>
                                    已开启 CDN 同步
                                  </Badge>
                                </span>
                                <span className="nps-meta-sub">检测到同名 EdgeOne CDN 时自动同步</span>
                              </>
                            ) : (
                              <span className="nps-meta-sub">未开启</span>
                            )}
                          </div>
                        </div>

                        <div className="nps-host-foot">
                          <span className="nps-host-flow">
                            流量：↓{formatBytes(h.inletFlow)} / ↑{formatBytes(h.exportFlow)}
                            {h.localProxy ? ' · 本地代理' : ''}
                          </span>
                          <div className="nps-host-actions">
                            <button
                              type="button"
                              className="btn primary sm"
                              onClick={() => setCertModalHost(h)}
                            >
                              <ShieldCheck size={13} />
                              {binding ? '证书联动设置' : '配置 / 申请证书'}
                            </button>
                            {binding && (
                              <button
                                type="button"
                                className="btn ghost sm"
                                disabled={isSyncing}
                                onClick={() => void syncHostCertNow(h)}
                                title="立即推送已签发的腾讯云证书到 NPS（并同步 CDN）"
                              >
                                {isSyncing ? (
                                  <LoaderCircle size={12} className="spin" />
                                ) : (
                                  <RefreshCw size={12} />
                                )}
                                立即同步
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn ghost sm"
                              onClick={() => setHostModal({ open: true, editing: h })}
                            >
                              <Edit3 size={12} /> 编辑
                            </button>
                            <button
                              type="button"
                              className="btn ghost sm"
                              disabled={isToggling}
                              onClick={() => void toggleHost(h)}
                            >
                              {isToggling ? (
                                <LoaderCircle size={12} className="spin" />
                              ) : h.isClose ? (
                                <Play size={12} />
                              ) : (
                                <Square size={12} />
                              )}
                              {h.isClose ? '启用' : '停用'}
                            </button>
                            <button
                              type="button"
                              className="btn ghost sm danger"
                              onClick={() => deleteHost(h)}
                            >
                              <Trash2 size={12} /> 删除
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {/* Add / Edit NPS Server Modal */}
      {serverModal.open && (
        <NpsServerModal
          editing={serverModal.editing}
          onClose={() => setServerModal({ open: false, editing: null })}
          onSaved={(newId, msg) => {
            setServerModal({ open: false, editing: null })
            onToast(msg, 'success')
            void loadBootstrap(newId)
            onChanged?.()
          }}
        />
      )}

      {/* Add / Edit NPS Client Modal */}
      {clientModal.open && currentServer && (
        <NpsClientModal
          serverId={currentServer.id}
          editing={clientModal.editing}
          onClose={() => setClientModal({ open: false, editing: null })}
          onSaved={(msg) => {
            setClientModal({ open: false, editing: null })
            onToast(msg, 'success')
            void loadServerData(currentServer.id)
          }}
        />
      )}

      {/* Add / Edit Port Tunnel Modal */}
      {tunnelModal.open && currentServer && (
        <NpsTunnelModal
          serverId={currentServer.id}
          clients={clients}
          editing={tunnelModal.editing}
          defaultClientId={tunnelModal.defaultClientId}
          onClose={() => setTunnelModal({ open: false, editing: null })}
          onSaved={(msg) => {
            setTunnelModal({ open: false, editing: null })
            onToast(msg, 'success')
            void loadServerData(currentServer.id)
          }}
        />
      )}

      {/* Add / Edit Domain Host Modal */}
      {hostModal.open && currentServer && (
        <NpsHostModal
          serverId={currentServer.id}
          clients={clients}
          tencentAccounts={tencentAccounts}
          dnsAccounts={dnsAccounts}
          managedCerts={managedCerts}
          editing={hostModal.editing}
          defaultClientId={hostModal.defaultClientId}
          onClose={() => setHostModal({ open: false, editing: null })}
          onSaved={(msg, tone = 'success') => {
            setHostModal({ open: false, editing: null })
            onToast(msg, tone)
            void refreshAll()
          }}
        />
      )}

      {/* Host Certificate & Tencent SSL / CDN Sync Modal */}
      {certModalHost && currentServer && (
        <NpsHostCertModal
          serverId={currentServer.id}
          host={certModalHost}
          tencentAccounts={tencentAccounts}
          dnsAccounts={dnsAccounts}
          managedCerts={managedCerts}
          onClose={() => setCertModalHost(null)}
          onGoCerts={() => {
            setCertModalHost(null)
            onGoCerts()
          }}
          onGoDnsAccounts={() => {
            setCertModalHost(null)
            onGoDnsAccounts()
          }}
          onSaved={(msg, tone = 'success') => {
            setCertModalHost(null)
            onToast(msg, tone)
            void refreshAll()
            onChanged?.()
          }}
        />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Sub-Modals                                                                 */
/* -------------------------------------------------------------------------- */

function NpsServerModal({
  editing,
  onClose,
  onSaved,
}: {
  editing: NpsServerItem | null
  onClose: () => void
  onSaved: (serverId: number, message: string) => void
}) {
  const [label, setLabel] = useState(editing?.label ?? '')
  const [baseUrl, setBaseUrl] = useState(editing?.base_url ?? '')
  const [authMode, setAuthMode] = useState<NpsAuthMode>(editing?.auth_mode ?? 'auth_key')
  const [authKey, setAuthKey] = useState('')
  const [username, setUsername] = useState(editing?.username ?? 'admin')
  const [password, setPassword] = useState('')
  const [remark, setRemark] = useState(editing?.remark ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setError('')
    if (!label.trim()) return setError('请填写服务器名称')
    if (!baseUrl.trim()) return setError('请填写 NPS Web 管理地址（如 https://nps.example.com）')
    if (!editing && authMode === 'auth_key' && !authKey.trim()) {
      return setError('请填写 nps.conf 中的 auth_key')
    }
    if (!editing && authMode === 'web_login' && (!username.trim() || !password)) {
      return setError('请填写 NPS 管理后台用户名和密码')
    }

    setSaving(true)
    try {
      if (editing) {
        const res = await patch<{ ok: true; server: NpsServerItem }>(
          `/api/v1/nps/servers/${editing.id}`,
          {
            label: label.trim(),
            base_url: baseUrl.trim(),
            auth_mode: authMode,
            auth_key: authKey.trim() || undefined,
            username: username.trim(),
            password: password || undefined,
            remark: remark.trim(),
          },
        )
        onSaved(res.server.id, `已更新 NPS 服务器「${res.server.label}」`)
      } else {
        const res = await post<{
          ok: true
          id: number
          server: NpsServerItem
          test?: { client_count: number } | null
          test_error?: string
        }>('/api/v1/nps/servers', {
          label: label.trim(),
          base_url: baseUrl.trim(),
          auth_mode: authMode,
          auth_key: authKey.trim(),
          username: username.trim(),
          password,
          remark: remark.trim(),
          test_after_save: true,
        })
        const tip = res.test
          ? `已添加「${res.server.label}」并连通（${res.test.client_count} 个客户端）`
          : res.test_error
            ? `已保存「${res.server.label}」，但连通测试失败：${res.test_error}`
            : `已添加 NPS 服务器「${res.server.label}」`
        onSaved(res.id, tip)
      }
    } catch (err) {
      setError(err instanceof APIError ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={editing ? `编辑 NPS 服务器 · ${editing.label}` : '添加 NPS 服务器 (yisier/nps)'}
      icon={<Network size={16} />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={saving}>
            {saving && <LoaderCircle size={13} className="spin" />}
            {editing ? '保存修改' : '添加并测试'}
          </button>
        </>
      }
    >
      <div className="nps-form">
        {error && <div className="form-err">{error}</div>}
        <div className="field">
          <label>服务器名称</label>
          <input
            className="input"
            placeholder="例如：香港主控 NPS"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div className="field">
          <label>NPS Web 管理地址</label>
          <input
            className="input"
            placeholder="https://nps.example.com 或 http://1.2.3.4:8080/nps"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <span className="hint">如配置了 web_base_url 子路径请一并带上，支持 HTTP 与 HTTPS。</span>
        </div>
        <div className="field">
          <label>认证方式</label>
          <Segmented
            value={authMode}
            options={[
              { value: 'auth_key', label: 'API auth_key（推荐）' },
              { value: 'web_login', label: 'Web 账号登录' },
            ]}
            onChange={setAuthMode}
          />
        </div>

        {authMode === 'auth_key' ? (
          <div className="field">
            <label>
              API auth_key
              {editing?.has_auth_key && (
                <span className="nps-field-badge">已配置 {editing.auth_key_preview}</span>
              )}
            </label>
            <input
              type="password"
              className="input"
              placeholder={editing?.has_auth_key ? '留空保持原密钥不变' : '填写 nps.conf 中的 auth_key'}
              value={authKey}
              onChange={(e) => setAuthKey(e.target.value)}
            />
            <span className="hint">
              对应 <code>conf/nps.conf</code> 中的 <code>auth_key</code> 配置项，服务端须开启{' '}
              <code>auth_crypt_key</code>/<code>auth_key</code>，免受图形验证码限制。
            </span>
          </div>
        ) : (
          <div className="grid-2">
            <div className="field">
              <label>Web 管理员用户名</label>
              <input
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Web 管理员密码</label>
              <input
                type="password"
                className="input"
                placeholder={editing?.has_password ? '留空保持原密码不变' : '输入密码'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>
        )}

        <div className="field">
          <label>备注（可选）</label>
          <input
            className="input"
            placeholder="所在机房或用途备注"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  )
}

function NpsClientModal({
  serverId,
  editing,
  onClose,
  onSaved,
}: {
  serverId: number
  editing: NpsClientItem | null
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const [remark, setRemark] = useState(editing?.remark ?? '')
  const [vkey, setVkey] = useState(editing?.verifyKey ?? '')
  const [compress, setCompress] = useState(editing ? editing.compress : true)
  const [crypt, setCrypt] = useState(editing ? editing.crypt : true)
  const [configConnAllow, setConfigConnAllow] = useState(editing ? editing.configConnAllow : true)
  const [rateLimit, setRateLimit] = useState(String(editing?.rateLimit ?? 0))
  const [flowLimit, setFlowLimit] = useState(String(editing?.flowLimit ?? 0))
  const [maxConn, setMaxConn] = useState(String(editing?.maxConn ?? 0))
  const [maxTunnelNum, setMaxTunnelNum] = useState(String(editing?.maxTunnelNum ?? 0))
  const [basicUser, setBasicUser] = useState(editing?.basicUser ?? '')
  const [basicPass, setBasicPass] = useState(editing?.basicPass ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setError('')
    setSaving(true)
    try {
      const payload = {
        remark: remark.trim(),
        vkey: vkey.trim() || undefined,
        compress,
        crypt,
        config_conn_allow: configConnAllow,
        rate_limit: Math.max(0, Number(rateLimit) || 0),
        flow_limit: Math.max(0, Number(flowLimit) || 0),
        max_conn: Math.max(0, Number(maxConn) || 0),
        max_tunnel_num: Math.max(0, Number(maxTunnelNum) || 0),
        basic_user: basicUser.trim(),
        basic_pass: basicPass,
      }
      if (editing) {
        await patch(`/api/v1/nps/servers/${serverId}/clients/${editing.id}`, payload)
        onSaved(`已更新客户端 #${editing.id}`)
      } else {
        const res = await post<{ ok: true; id: number }>(`/api/v1/nps/servers/${serverId}/clients`, payload)
        onSaved(`已创建 NPS 客户端 #${res.id}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存客户端失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={editing ? `编辑 NPS 客户端 #${editing.id}` : '新增 NPS 客户端'}
      icon={<ServerIcon size={16} />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={saving}>
            {saving && <LoaderCircle size={13} className="spin" />}
            {editing ? '保存修改' : '创建客户端'}
          </button>
        </>
      }
    >
      <div className="nps-form">
        {error && <div className="form-err">{error}</div>}
        <div className="grid-2">
          <div className="field">
            <label>备注名称</label>
            <input
              className="input"
              placeholder="例如：家里群晖 NAS"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
            />
          </div>
          <div className="field">
            <label>客户端验证密钥 (VerifyKey)</label>
            <input
              className="input"
              placeholder="留空由 NPS 自动随机生成"
              value={vkey}
              onChange={(e) => setVkey(e.target.value)}
            />
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label>带宽限制 (KB/s，0 不限)</label>
            <input
              type="number"
              min={0}
              className="input"
              value={rateLimit}
              onChange={(e) => setRateLimit(e.target.value)}
            />
          </div>
          <div className="field">
            <label>流量限额 (MB，0 不限)</label>
            <input
              type="number"
              min={0}
              className="input"
              value={flowLimit}
              onChange={(e) => setFlowLimit(e.target.value)}
            />
          </div>
          <div className="field">
            <label>最大连接数 (0 不限)</label>
            <input
              type="number"
              min={0}
              className="input"
              value={maxConn}
              onChange={(e) => setMaxConn(e.target.value)}
            />
          </div>
          <div className="field">
            <label>最大隧道数 (0 不限)</label>
            <input
              type="number"
              min={0}
              className="input"
              value={maxTunnelNum}
              onChange={(e) => setMaxTunnelNum(e.target.value)}
            />
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label>Basic Auth 用户名（可选）</label>
            <input
              className="input"
              placeholder="代理鉴权用户名"
              value={basicUser}
              onChange={(e) => setBasicUser(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Basic Auth 密码（可选）</label>
            <input
              type="password"
              className="input"
              placeholder="代理鉴权密码"
              value={basicPass}
              onChange={(e) => setBasicPass(e.target.value)}
            />
          </div>
        </div>

        <Switch checked={compress} onChange={setCompress} label="启用数据压缩" hint="降低隧道带宽占用" />
        <Switch checked={crypt} onChange={setCrypt} label="启用传输加密" hint="加密服务端与 npc 之间的隧道通信" />
        <Switch
          checked={configConnAllow}
          onChange={setConfigConnAllow}
          label="允许客户端通过配置文件连接"
          hint="允许 npc 使用 -config 方式接入"
        />
      </div>
    </Modal>
  )
}

function NpsTunnelModal({
  serverId,
  clients,
  editing,
  defaultClientId,
  onClose,
  onSaved,
}: {
  serverId: number
  clients: NpsClientItem[]
  editing: NpsTunnelItem | null
  defaultClientId?: number
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const [clientId, setClientId] = useState<number>(
    editing?.clientId ?? defaultClientId ?? clients[0]?.id ?? 0,
  )
  const [mode, setMode] = useState<NpsTunnelMode>(editing?.mode ?? 'tcp')
  const [port, setPort] = useState(editing ? String(editing.port) : '')
  const [target, setTarget] = useState(editing?.target ?? '')
  const [serverIp, setServerIp] = useState(editing?.serverIp ?? '')
  const [remark, setRemark] = useState(editing?.remark ?? '')
  const [localProxy, setLocalProxy] = useState(editing?.localProxy ?? false)
  const [password, setPassword] = useState(editing?.password ?? '')
  const [localPath, setLocalPath] = useState(editing?.localPath ?? '')
  const [stripPre, setStripPre] = useState(editing?.stripPre ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const needsTarget = mode === 'tcp' || mode === 'udp' || mode === 'secret' || mode === 'p2p'
  const needsPort = mode !== 'secret' && mode !== 'p2p'
  const needsPassword = mode === 'secret' || mode === 'p2p'

  const submit = async () => {
    setError('')
    if (!clientId) return setError('请选择所属 NPS 客户端')
    const portNum = port.trim() === '' ? 0 : Math.trunc(Number(port))
    if (needsPort && (!Number.isFinite(portNum) || portNum < 0 || portNum > 65535)) {
      return setError('服务端端口须为 0–65535 的整数（0 表示自动分配）')
    }
    if (needsTarget && !target.trim()) {
      return setError('请填写内网目标地址（例如 127.0.0.1:22）')
    }
    if (mode === 'file' && !localPath.trim()) {
      return setError('文件服务请填写客户端本地目录路径')
    }

    setSaving(true)
    try {
      const payload = {
        client_id: clientId,
        mode,
        port: needsPort ? portNum : 0,
        server_ip: serverIp.trim(),
        target: target.trim(),
        local_proxy: localProxy,
        remark: remark.trim(),
        password: password.trim(),
        local_path: localPath.trim(),
        strip_pre: stripPre.trim(),
      }
      if (editing) {
        await patch(`/api/v1/nps/servers/${serverId}/tunnels/${editing.id}`, payload)
        onSaved(`已更新端口映射 #${editing.id}`)
      } else {
        await post(`/api/v1/nps/servers/${serverId}/tunnels`, payload)
        onSaved(`已添加 ${mode.toUpperCase()} 端口映射${portNum ? ` :${portNum}` : ''}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存端口映射失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={editing ? `编辑端口映射 #${editing.id}` : '添加端口映射'}
      icon={<Network size={16} />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={saving}>
            {saving && <LoaderCircle size={13} className="spin" />}
            {editing ? '保存修改' : '确认添加'}
          </button>
        </>
      }
    >
      <div className="nps-form">
        {error && <div className="form-err">{error}</div>}
        <div className="grid-2">
          <div className="field">
            <label>所属客户端</label>
            <select
              className="select"
              value={clientId}
              onChange={(e) => setClientId(Number(e.target.value))}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.id} {c.remark || `客户端 #${c.id}`} {c.isConnect ? '(在线)' : '(离线)'}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>转发协议</label>
            <select
              className="select"
              value={mode}
              onChange={(e) => setMode(e.target.value as NpsTunnelMode)}
            >
              {TUNNEL_MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid-2">
          {needsPort && (
            <div className="field">
              <label>服务端监听端口</label>
              <input
                type="number"
                min={0}
                max={65535}
                className="input"
                placeholder="例如 2222（留空或 0 自动分配）"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </div>
          )}
          {needsTarget && (
            <div className="field">
              <label>内网目标 (IP:端口)</label>
              <input
                className="input"
                placeholder="例如 127.0.0.1:22 或 192.168.1.10:3389"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </div>
          )}
        </div>

        {needsPassword && (
          <div className="field">
            <label>唯一验证密钥 (Password)</label>
            <input
              className="input"
              placeholder="私密代理或 P2P 连接密钥（留空自动生成）"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        )}

        {mode === 'file' && (
          <div className="grid-2">
            <div className="field">
              <label>本地共享目录</label>
              <input
                className="input"
                placeholder="例如 /data/files"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
              />
            </div>
            <div className="field">
              <label>前缀路径（可选）</label>
              <input
                className="input"
                placeholder="例如 /static"
                value={stripPre}
                onChange={(e) => setStripPre(e.target.value)}
              />
            </div>
          </div>
        )}

        <div className="grid-2">
          <div className="field">
            <label>服务端绑定 IP（可选）</label>
            <input
              className="input"
              placeholder="默认监听全部网卡"
              value={serverIp}
              onChange={(e) => setServerIp(e.target.value)}
            />
          </div>
          <div className="field">
            <label>备注（可选）</label>
            <input
              className="input"
              placeholder="例如：NAS SSH 转发"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
            />
          </div>
        </div>

        {needsTarget && (
          <Switch
            checked={localProxy}
            onChange={setLocalProxy}
            label="服务端本地代理 (LocalProxy)"
            hint="转发目标位于 NPS 服务端本机时开启"
          />
        )}
      </div>
    </Modal>
  )
}

function NpsHostModal({
  serverId,
  clients,
  tencentAccounts,
  dnsAccounts,
  managedCerts,
  editing,
  defaultClientId,
  onClose,
  onSaved,
}: {
  serverId: number
  clients: NpsClientItem[]
  tencentAccounts: DnsAccount[]
  dnsAccounts: DnsAccount[]
  managedCerts: NpsManagedCertOption[]
  editing: NpsHostItem | null
  defaultClientId?: number
  onClose: () => void
  onSaved: (msg: string, tone?: 'success' | 'error' | 'info') => void
}) {
  const [clientId, setClientId] = useState<number>(
    editing?.clientId ?? defaultClientId ?? clients[0]?.id ?? 0,
  )
  const [host, setHost] = useState(editing?.host ?? '')
  const [target, setTarget] = useState(editing?.target ?? '')
  const [scheme, setScheme] = useState<NpsHostScheme>(editing?.scheme ?? 'all')
  const [autoHttps, setAutoHttps] = useState(editing ? editing.autoHttps : true)
  const [location, setLocation] = useState(editing?.location ?? '')
  const [remark, setRemark] = useState(editing?.remark ?? '')
  const [headerChange, setHeaderChange] = useState(editing?.headerChange ?? '')
  const [hostChange, setHostChange] = useState(editing?.hostChange ?? '')
  const [localProxy, setLocalProxy] = useState(editing?.localProxy ?? false)

  // Quick cert setup on create
  const [certAction, setCertAction] = useState<'none' | 'tencent_auto' | 'existing_ssl'>(
    !editing && tencentAccounts.length > 0 ? 'tencent_auto' : 'none',
  )
  const [tencentAccountId, setTencentAccountId] = useState<number>(tencentAccounts[0]?.id ?? 0)
  const [dnsVerifyMode, setDnsVerifyMode] = useState<'' | SslVerifyMode>('')
  const [dnsAccountId, setDnsAccountId] = useState<number>(0)
  const [sslCertId, setSslCertId] = useState<number>(0)
  const [syncCdn, setSyncCdn] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const sortedCerts = useMemo(() => {
    const clean = host.trim().toLowerCase()
    return [...managedCerts].sort((a, b) => {
      const am = clean && a.domain.toLowerCase() === clean ? 0 : 1
      const bm = clean && b.domain.toLowerCase() === clean ? 0 : 1
      return am - bm || b.cert_end_ts - a.cert_end_ts
    })
  }, [managedCerts, host])

  const submit = async () => {
    setError('')
    if (!clientId) return setError('请选择所属客户端')
    if (!host.trim() || !host.includes('.')) return setError('请输入有效的绑定域名')
    if (!target.trim()) return setError('请输入目标内网地址（例如 127.0.0.1:8080）')
    if (!editing && certAction === 'existing_ssl' && !sslCertId) {
      return setError('请选择一张面板托管证书')
    }

    setSaving(true)
    try {
      if (editing) {
        await patch(`/api/v1/nps/servers/${serverId}/hosts/${editing.id}`, {
          client_id: clientId,
          host: host.trim().toLowerCase(),
          target: target.trim(),
          scheme,
          auto_https: scheme === 'http' ? false : autoHttps,
          location: location.trim(),
          remark: remark.trim(),
          header_change: headerChange.trim(),
          host_change: hostChange.trim(),
          local_proxy: localProxy,
        })
        onSaved(`已更新域名解析 ${host.trim()}`)
      } else {
        const res = await post<{
          ok: true
          id: number
          cert_result?: { detail: string; deployedToNps: boolean } | null
          cert_error?: string
        }>(
          `/api/v1/nps/servers/${serverId}/hosts`,
          {
            client_id: clientId,
            host: host.trim().toLowerCase(),
            target: target.trim(),
            scheme,
            auto_https: scheme === 'http' ? false : autoHttps,
            location: location.trim(),
            remark: remark.trim(),
            header_change: headerChange.trim(),
            host_change: hostChange.trim(),
            local_proxy: localProxy,
            cert_action: certAction === 'none' ? '' : certAction,
            tencent_account_id: tencentAccountId || undefined,
            dns_verify_mode: dnsVerifyMode || undefined,
            dns_account_id: dnsAccountId || undefined,
            ssl_cert_id: certAction === 'existing_ssl' ? sslCertId : undefined,
            sync_cdn: syncCdn,
          },
          SLOW_TIMEOUT_MS,
        )
        if (res.cert_error) {
          onSaved(`域名 ${host.trim()} 已创建，但证书联动失败：${res.cert_error}`, 'info')
        } else if (res.cert_result) {
          onSaved(`域名 ${host.trim()} 已创建：${res.cert_result.detail}`, 'success')
        } else {
          onSaved(`已创建域名解析 ${host.trim()}`)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存域名解析失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      wide
      title={editing ? `编辑域名解析 · ${editing.host}` : '新增 NPS 域名解析'}
      icon={<Globe2 size={16} />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={saving}>
            {saving && <LoaderCircle size={13} className="spin" />}
            {editing ? '保存修改' : '确认创建'}
          </button>
        </>
      }
    >
      <div className="nps-form">
        {error && <div className="form-err">{error}</div>}
        <div className="grid-2">
          <div className="field">
            <label>所属客户端</label>
            <select
              className="select"
              value={clientId}
              onChange={(e) => setClientId(Number(e.target.value))}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.id} {c.remark || `客户端 #${c.id}`} {c.isConnect ? '(在线)' : '(离线)'}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>绑定域名</label>
            <input
              className="input"
              placeholder="例如 nas.example.com"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label>内网目标 (IP:端口)</label>
            <input
              className="input"
              placeholder="例如 127.0.0.1:5000"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </div>
          <div className="field">
            <label>监听协议</label>
            <Segmented
              value={scheme}
              options={[
                { value: 'all', label: 'HTTP + HTTPS' },
                { value: 'https', label: '仅 HTTPS' },
                { value: 'http', label: '仅 HTTP' },
              ]}
              onChange={setScheme}
            />
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label>URL 路由前缀（可选）</label>
            <input
              className="input"
              placeholder="默认全部路径，例如 /api"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </div>
          <div className="field">
            <label>备注（可选）</label>
            <input
              className="input"
              placeholder="例如：NAS 管理后台"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
            />
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label>修改请求 Host（可选）</label>
            <input
              className="input"
              placeholder="留空保持原 Host"
              value={hostChange}
              onChange={(e) => setHostChange(e.target.value)}
            />
          </div>
          <div className="field">
            <label>自定义 Header（可选）</label>
            <input
              className="input"
              placeholder="Key:Value，多行分隔"
              value={headerChange}
              onChange={(e) => setHeaderChange(e.target.value)}
            />
          </div>
        </div>

        {scheme !== 'http' && (
          <Switch
            checked={autoHttps}
            onChange={setAutoHttps}
            label="自动将 HTTP 重定向至 HTTPS (AutoHttps)"
            hint="访问 80 端口时自动 301 跳转 HTTPS"
          />
        )}
        <Switch
          checked={localProxy}
          onChange={setLocalProxy}
          label="服务端本地代理 (LocalProxy)"
          hint="目标服务运行在 NPS 服务端本机时开启"
        />

        {!editing && (
          <div className="nps-cert-inline-box">
            <div className="nps-cert-inline-head">
              <strong>
                <ShieldCheck size={14} /> 创建时同步配置 HTTPS 证书
              </strong>
              <Segmented
                value={certAction}
                options={[
                  { value: 'tencent_auto', label: '腾讯自动申请/续期' },
                  { value: 'existing_ssl', label: '绑定已有证书' },
                  { value: 'none', label: '暂不配置' },
                ]}
                onChange={setCertAction}
              />
            </div>

            {certAction === 'tencent_auto' && (
              <div className="nps-cert-inline-body">
                {tencentAccounts.length === 0 ? (
                  <p className="hint">尚未配置腾讯云账号，创建后可先去「DNS 域名解析」添加腾讯云账号再一键申请。</p>
                ) : (
                  <>
                    <div className="grid-2">
                      <div className="field">
                        <label>腾讯云 SSL 账号</label>
                        <select
                          className="select"
                          value={tencentAccountId}
                          onChange={(e) => setTencentAccountId(Number(e.target.value))}
                        >
                          {tencentAccounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.label} ({a.cred_id_preview})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label>DNS 自动验证方式</label>
                        <select
                          className="select"
                          value={dnsVerifyMode}
                          onChange={(e) => setDnsVerifyMode(e.target.value as '' | SslVerifyMode)}
                        >
                          <option value="">自动匹配 DNSPod / Cloudflare 账号（推荐）</option>
                          <option value="tencent_auto">腾讯云同账号 DNS_AUTO</option>
                          <option value="dns_account">手动指定云解析账号</option>
                        </select>
                      </div>
                    </div>
                    {dnsVerifyMode === 'dns_account' && (
                      <div className="field">
                        <label>指定 DNS 验证账号</label>
                        <select
                          className="select"
                          value={dnsAccountId}
                          onChange={(e) => setDnsAccountId(Number(e.target.value))}
                        >
                          <option value={0}>请选择 DNSPod 或 Cloudflare 账号</option>
                          {dnsAccounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              [{a.provider === 'cloudflare' ? 'Cloudflare' : '腾讯云'}] {a.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <Switch
                      checked={syncCdn}
                      onChange={setSyncCdn}
                      label="同时联动同步 EdgeOne CDN 证书"
                      hint="若该域名绑定了腾讯云 EdgeOne CDN，签发及到期自动续期时一并替换 CDN 边缘证书"
                    />
                  </>
                )}
              </div>
            )}

            {certAction === 'existing_ssl' && (
              <div className="nps-cert-inline-body">
                <div className="field">
                  <label>选择面板已托管证书</label>
                  <select
                    className="select"
                    value={sslCertId}
                    onChange={(e) => setSslCertId(Number(e.target.value))}
                  >
                    <option value={0}>请选择托管证书</option>
                    {sortedCerts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.domain} · {c.cert_id || c.pending_cert_id} ({c.status_name || c.status}
                        {c.cert_end_time ? `，至 ${c.cert_end_time.slice(0, 10)}` : ''})
                      </option>
                    ))}
                  </select>
                </div>
                <Switch
                  checked={syncCdn}
                  onChange={setSyncCdn}
                  label="同时联动同步 EdgeOne CDN 证书"
                  hint="证书推送和后续自动续期时同步更新对应 CDN 边缘证书"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

function NpsHostCertModal({
  serverId,
  host,
  tencentAccounts,
  dnsAccounts,
  managedCerts,
  onClose,
  onGoCerts,
  onGoDnsAccounts,
  onSaved,
}: {
  serverId: number
  host: NpsHostItem
  tencentAccounts: DnsAccount[]
  dnsAccounts: DnsAccount[]
  managedCerts: NpsManagedCertOption[]
  onClose: () => void
  onGoCerts: () => void
  onGoDnsAccounts: () => void
  onSaved: (msg: string, tone?: 'success' | 'error' | 'info') => void
}) {
  const existingBinding = host.certBinding ?? null
  const [mode, setMode] = useState<'tencent_auto' | 'existing_ssl' | 'manual'>(
    existingBinding ? 'existing_ssl' : 'tencent_auto',
  )
  const [tencentAccountId, setTencentAccountId] = useState<number>(tencentAccounts[0]?.id ?? 0)
  const [dnsVerifyMode, setDnsVerifyMode] = useState<'' | SslVerifyMode>('')
  const [dnsAccountId, setDnsAccountId] = useState<number>(0)
  const [renewBeforeDays, setRenewBeforeDays] = useState<number>(
    existingBinding?.ssl_renew_before_days || 7,
  )
  const [sslCertId, setSslCertId] = useState<number>(() => {
    if (existingBinding?.ssl_cert_id) return existingBinding.ssl_cert_id
    const exact = managedCerts.find(
      (c) => c.domain.toLowerCase() === host.host.toLowerCase(),
    )
    return exact?.id ?? 0
  })
  const [syncCdn, setSyncCdn] = useState<boolean>(existingBinding ? existingBinding.sync_cdn : true)
  const [autoHttps, setAutoHttps] = useState<boolean>(host.autoHttps || host.scheme !== 'http')
  const [certFilePath, setCertFilePath] = useState('')
  const [keyFilePath, setKeyFilePath] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const sortedCerts = useMemo(() => {
    const clean = host.host.toLowerCase()
    return [...managedCerts].sort((a, b) => {
      const am = a.domain.toLowerCase() === clean ? 0 : 1
      const bm = b.domain.toLowerCase() === clean ? 0 : 1
      return am - bm || b.cert_end_ts - a.cert_end_ts
    })
  }, [managedCerts, host.host])

  const submit = async () => {
    setError('')
    if (mode === 'existing_ssl' && !sslCertId) {
      return setError('请先选择一张面板托管证书')
    }
    if (mode === 'manual' && (!certFilePath.trim() || !keyFilePath.trim())) {
      return setError('请同时填写证书公钥（PEM 或路径）和私钥（PEM 或路径）')
    }
    setSaving(true)
    try {
      if (mode === 'tencent_auto' || mode === 'existing_ssl') {
        const res = await post<{ ok: true; result: { detail: string; deployedToNps: boolean } }>(
          `/api/v1/nps/servers/${serverId}/hosts/${host.id}/cert`,
          {
            mode,
            tencent_account_id: tencentAccountId || undefined,
            dns_verify_mode: dnsVerifyMode || undefined,
            dns_account_id: dnsAccountId || undefined,
            ssl_cert_id: mode === 'existing_ssl' ? sslCertId : undefined,
            sync_cdn: syncCdn,
            auto_https: autoHttps,
            renew_before_days: renewBeforeDays,
          },
          SLOW_TIMEOUT_MS,
        )
        onSaved(res.result.detail, res.result.deployedToNps ? 'success' : 'info')
      } else {
        await post(`/api/v1/nps/servers/${serverId}/hosts/${host.id}/cert`, {
          mode: 'manual',
          cert_file_path: certFilePath.trim(),
          key_file_path: keyFilePath.trim(),
          auto_https: autoHttps,
        })
        onSaved(`已更新 ${host.host} 的手动证书配置`, 'success')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '证书配置失败')
    } finally {
      setSaving(false)
    }
  }

  const clearCert = async () => {
    setError('')
    setSaving(true)
    try {
      await post(`/api/v1/nps/servers/${serverId}/hosts/${host.id}/cert`, { mode: 'clear' })
      onSaved(`已清空 ${host.host} 的证书并解除自动续期联动`, 'info')
    } catch (err) {
      setError(err instanceof Error ? err.message : '清空证书失败')
    } finally {
      setSaving(false)
    }
  }

  const detachBinding = async () => {
    if (!existingBinding) return
    setError('')
    setSaving(true)
    try {
      await del(`/api/v1/nps/bindings/${existingBinding.id}`)
      onSaved(`已解除 ${host.host} 的自动同步绑定（NPS 当前证书保留）`, 'info')
    } catch (err) {
      setError(err instanceof Error ? err.message : '解除绑定失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      wide
      title={`HTTPS 证书与自动续期联动 · ${host.host}`}
      icon={<ShieldCheck size={16} />}
      onClose={onClose}
      footer={
        <div className="nps-cert-modal-foot">
          <div className="nps-cert-foot-left">
            {host.hasCert && (
              <button
                type="button"
                className="btn ghost sm danger"
                disabled={saving}
                onClick={() => void clearCert()}
              >
                清空证书
              </button>
            )}
            {existingBinding && (
              <button
                type="button"
                className="btn ghost sm"
                disabled={saving}
                onClick={() => void detachBinding()}
              >
                <Unlink size={12} /> 仅解除联动
              </button>
            )}
          </div>
          <div className="nps-cert-foot-right">
            <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button type="button" className="btn primary" onClick={() => void submit()} disabled={saving}>
              {saving && <LoaderCircle size={13} className="spin" />}
              {mode === 'tencent_auto'
                ? '一键申请并部署'
                : mode === 'existing_ssl'
                  ? '绑定并热部署'
                  : '保存证书'}
            </button>
          </div>
        </div>
      }
    >
      <div className="nps-form">
        {error && <div className="form-err">{error}</div>}

        <div className="eo-cert-modal-note">
          <strong>自动热更新与 CDN 联动：</strong>
          <code>yisier/nps</code> 原生支持内联 PEM 证书并自动热重载 TLS，无需重启服务。联动腾讯云免费 443 SSL
          证书后，面板将自动完成 DNS 验证与验证记录清理，签发后立即写入 NPS；到期前自动续期并再次热替换，若同域名已绑定
          EdgeOne CDN 也会同步更新边缘证书。
        </div>

        <Segmented
          value={mode}
          options={[
            { value: 'tencent_auto', label: '一键申请/复用腾讯证书' },
            { value: 'existing_ssl', label: '绑定已有托管证书' },
            { value: 'manual', label: '手动 PEM / 文件路径' },
          ]}
          onChange={setMode}
        />

        {mode === 'tencent_auto' && (
          <>
            {tencentAccounts.length === 0 ? (
              <div className="nps-warn-box">
                <span>尚未配置腾讯云账号，无法自动申请免费证书。</span>
                <button type="button" className="btn primary sm" onClick={onGoDnsAccounts}>
                  前往添加腾讯云账号
                </button>
              </div>
            ) : (
              <>
                <div className="grid-2">
                  <div className="field">
                    <label>腾讯云 SSL 账号</label>
                    <select
                      className="select"
                      value={tencentAccountId}
                      onChange={(e) => setTencentAccountId(Number(e.target.value))}
                    >
                      {tencentAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label} ({a.cred_id_preview})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>提前自动续期天数</label>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      className="input"
                      value={renewBeforeDays}
                      onChange={(e) => setRenewBeforeDays(Math.max(1, Math.min(30, Number(e.target.value) || 7)))}
                    />
                  </div>
                </div>
                <div className="grid-2">
                  <div className="field">
                    <label>DNS 自动验证方式</label>
                    <select
                      className="select"
                      value={dnsVerifyMode}
                      onChange={(e) => setDnsVerifyMode(e.target.value as '' | SslVerifyMode)}
                    >
                      <option value="">自动匹配 DNSPod / Cloudflare（推荐）</option>
                      <option value="tencent_auto">腾讯云同账号 DNS_AUTO</option>
                      <option value="dns_account">指定云解析账号</option>
                    </select>
                  </div>
                  {dnsVerifyMode === 'dns_account' && (
                    <div className="field">
                      <label>选择 DNS 解析账号</label>
                      <select
                        className="select"
                        value={dnsAccountId}
                        onChange={(e) => setDnsAccountId(Number(e.target.value))}
                      >
                        <option value={0}>请选择账号</option>
                        {dnsAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            [{a.provider === 'cloudflare' ? 'Cloudflare' : '腾讯云'}] {a.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {mode === 'existing_ssl' && (
          <>
            <div className="field">
              <div className="nps-label-row">
                <label>选择面板已托管的腾讯云证书</label>
                <button type="button" className="btn ghost sm" onClick={onGoCerts}>
                  前往证书服务管理
                </button>
              </div>
              <select
                className="select"
                value={sslCertId}
                onChange={(e) => setSslCertId(Number(e.target.value))}
              >
                <option value={0}>请选择一张托管证书…</option>
                {sortedCerts.map((c) => {
                  const matchTag = c.domain.toLowerCase() === host.host.toLowerCase() ? '★ 域名匹配 · ' : ''
                  return (
                    <option key={c.id} value={c.id}>
                      {matchTag}
                      {c.domain} · {c.cert_id || c.pending_cert_id || `#${c.id}`} ({c.status_name || c.status}
                      {c.cert_end_time ? `，到期 ${c.cert_end_time.slice(0, 10)}` : ''})
                    </option>
                  )
                })}
              </select>
            </div>
          </>
        )}

        {mode === 'manual' && (
          <>
            <div className="field">
              <label>证书公钥内容 (PEM) 或 NPS 服务器本地路径</label>
              <textarea
                className="textarea mono"
                rows={5}
                placeholder={'-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n或 /etc/nps/certs/fullchain.pem'}
                value={certFilePath}
                onChange={(e) => setCertFilePath(e.target.value)}
              />
            </div>
            <div className="field">
              <label>证书私钥内容 (PEM) 或 NPS 服务器本地路径</label>
              <textarea
                className="textarea mono"
                rows={5}
                placeholder={'-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n或 /etc/nps/certs/privkey.pem'}
                value={keyFilePath}
                onChange={(e) => setKeyFilePath(e.target.value)}
              />
            </div>
          </>
        )}

        <Switch
          checked={autoHttps}
          onChange={setAutoHttps}
          label="开启自动跳转 HTTPS (AutoHttps)"
          hint="保存证书时同步确保协议包含 HTTPS，并开启 HTTP → HTTPS 自动跳转"
        />

        {mode !== 'manual' && (
          <Switch
            checked={syncCdn}
            onChange={setSyncCdn}
            label="同步更新 EdgeOne CDN 证书"
            hint="自动检测同腾讯云账号下是否存在同名 EdgeOne 加速域名，部署与每次续期均同步替换 CDN 证书"
          />
        )}
      </div>
    </Modal>
  )
}

function NpsPager({
  label,
  total,
  pageSize,
  page,
  unit,
  onChange,
}: {
  label: string
  total: number
  pageSize: number
  page: number
  unit: string
  onChange: (nextPage: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (totalPages <= 1) return null
  const start = (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)
  const tokens = buildPageTokens(page, totalPages)

  return (
    <div className="card certs-pager" style={{ marginTop: 0 }}>
      <div className="cloud-dns-pager" role="navigation" aria-label={label}>
        <span className="cloud-dns-pager-info">
          共 {total} {unit} · 第 {start}–{end} {unit}（{page} / {totalPages} 页）
        </span>
        <div className="cloud-dns-pager-controls">
          <button
            type="button"
            className="cloud-dns-page-btn"
            disabled={page <= 1}
            onClick={() => onChange(Math.max(1, page - 1))}
          >
            <ChevronLeft size={13} /> 上一页
          </button>
          {tokens.map((tok, idx) =>
            tok === 'ellipsis' ? (
              <span key={`e-${idx}`} className="cloud-dns-page-ellipsis">
                …
              </span>
            ) : (
              <button
                key={tok}
                type="button"
                className={`cloud-dns-page-btn${tok === page ? ' on' : ''}`}
                aria-current={tok === page ? 'page' : undefined}
                onClick={() => onChange(tok)}
              >
                {tok}
              </button>
            ),
          )}
          <button
            type="button"
            className="cloud-dns-page-btn"
            disabled={page >= totalPages}
            onClick={() => onChange(Math.min(totalPages, page + 1))}
          >
            下一页 <ChevronRight size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}

