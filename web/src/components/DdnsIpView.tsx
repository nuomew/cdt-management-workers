import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Edit3,
  Globe2,
  KeyRound,
  LoaderCircle,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Square,
  Terminal,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { APIError, SLOW_TIMEOUT_MS, api, del, patch, post } from '../api'
import type {
  CloudDnsDomain,
  DdnsIpMonitorItem,
  DdnsIpMonitorsResponse,
  DnsAccount,
} from '../types'
import { Badge, Empty, Modal, Segmented, Switch } from './ui'
import DdnsSshOverlay from './DdnsSshOverlay'

type ConfirmRequest = {
  title: string
  message: string
  hint?: string
  confirmText?: string
  failText?: string
  run: () => Promise<void>
}

interface DdnsIpViewProps {
  onToast: (message: string, tone?: 'success' | 'error' | 'info') => void
  onConfirm: (req: ConfirmRequest) => void
  onGoDnsAccounts: () => void
  onChanged?: () => void
}

const MONITORS_PAGE_SIZE = 3

const INTERVAL_PRESETS = [
  { value: '30', label: '30 秒' },
  { value: '60', label: '60 秒' },
  { value: '180', label: '3 分钟' },
  { value: '300', label: '5 分钟' },
]

const DNSPOD_LINE_OPTIONS = ['默认', '电信', '联通', '移动', '教育网', '境外']

function buildPageTokens(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, idx) => idx + 1)
  }
  const pages = new Set<number>([1, total, current, current - 1, current + 1])
  if (current <= 3) {
    pages.add(2)
    pages.add(3)
    pages.add(4)
  } else if (current >= total - 2) {
    pages.add(total - 1)
    pages.add(total - 2)
    pages.add(total - 3)
  }
  const sorted = Array.from(pages)
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b)
  const result: (number | 'ellipsis')[] = []
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
      result.push('ellipsis')
    }
    result.push(sorted[i])
  }
  return result
}

function formatTime(ts: number): string {
  if (!ts) return '尚未上报'
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function relativeAgo(ts: number): string {
  if (!ts) return '尚未上报'
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  if (diff < 60) return `${diff} 秒前`
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return `${Math.floor(diff / 86400)} 天前`
}

function previewFqdn(subRaw: string, rootRaw: string): string {
  const root = rootRaw.trim().toLowerCase().replace(/\.+$/, '')
  if (!root) return ''
  let sub = subRaw.trim().toLowerCase().replace(/\.+$/, '')
  if (!sub || sub === '@' || sub === root) return root
  if (sub.endsWith(`.${root}`)) {
    sub = sub.slice(0, -(root.length + 1))
  }
  return sub ? `${sub}.${root}` : root
}

function buildWindowsInstallCmd(item: DdnsIpMonitorItem): string {
  const mins = Math.max(1, Math.round(item.interval_seconds / 60))
  const taskName = `CDT-DDNS-IP-${item.id}`
  const psBody =
    `$ip=(Invoke-RestMethod -Uri 'https://api4.ipify.org' -TimeoutSec 10).Trim(); ` +
    `function m($h){try{$c=New-Object Net.Sockets.TcpClient;$sw=[Diagnostics.Stopwatch]::StartNew();if($c.BeginConnect($h,80,$null,$null).AsyncWaitHandle.WaitOne(2500,$false)){$c.EndConnect($null);$sw.Stop();$c.Close();return [math]::Round($sw.Elapsed.TotalMilliseconds,1)}$c.Close()}catch{}return -1}; ` +
    `$ct=m 'gd-ct-v4.ip.zstaticcdn.com';$cu=m 'gd-cu-v4.ip.zstaticcdn.com';$cm=m 'gd-cm-v4.ip.zstaticcdn.com'; ` +
    `Invoke-RestMethod -Uri ('${item.report_url}&host='+$env:COMPUTERNAME+'&ip='+$ip+'&ct='+$ct+'&cu='+$cu+'&cm='+$cm) -TimeoutSec 15`
  const actionArg = `-NoProfile -WindowStyle Hidden -Command "${psBody}"`
  return (
    `schtasks /Create /F /TN "${taskName}" /SC MINUTE /MO ${mins} ` +
    `/TR "powershell.exe ${actionArg.replace(/"/g, '\\"')}" && ` +
    `powershell.exe -NoProfile -Command "${psBody}"`
  )
}

function formatLatencyChip(ms: number | null): { text: string; tone: 'good' | 'mid' | 'bad' | 'idle' } {
  if (ms === null || ms === undefined) return { text: '--', tone: 'idle' }
  if (ms < 0) return { text: '超时', tone: 'bad' }
  const val = ms >= 100 ? `${Math.round(ms)}ms` : `${Math.round(ms * 10) / 10}ms`
  if (ms < 80) return { text: val, tone: 'good' }
  if (ms < 180) return { text: val, tone: 'mid' }
  return { text: val, tone: 'bad' }
}

function maskCommandToken(cmd: string, token: string): string {
  if (!token || token.length < 12) return cmd
  const masked = `${token.slice(0, 6)}••••${token.slice(-4)}`
  return cmd.split(token).join(masked)
}

export default function DdnsIpView({
  onToast,
  onConfirm,
  onGoDnsAccounts,
  onChanged,
}: DdnsIpViewProps) {
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<DdnsIpMonitorItem[]>([])
  const [dnsAccounts, setDnsAccounts] = useState<DnsAccount[]>([])
  const [searchText, setSearchText] = useState('')
  const [page, setPage] = useState(1)
  const [copiedKey, setCopiedKey] = useState('')
  const [busyKey, setBusyKey] = useState('')

  const [editModal, setEditModal] = useState<{ open: boolean; editing: DdnsIpMonitorItem | null }>({
    open: false,
    editing: null,
  })
  const [installModalItem, setInstallModalItem] = useState<DdnsIpMonitorItem | null>(null)
  const [sshItem, setSshItem] = useState<DdnsIpMonitorItem | null>(null)

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

  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api<DdnsIpMonitorsResponse>('/api/v1/ddns-ip/monitors')
      setItems(res.items)
      setDnsAccounts(res.dns_accounts)
      setInstallModalItem((prev) =>
        prev ? res.items.find((x) => x.id === prev.id) ?? null : null,
      )
      setSshItem((prev) =>
        prev ? res.items.find((x) => x.id === prev.id) ?? prev : null,
      )
    } catch (err) {
      onToast(err instanceof Error ? err.message : '加载 DDNS IP 列表失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [onToast])

  useEffect(() => {
    void loadList()
  }, [loadList])

  const stats = useMemo(() => {
    const online = items.filter((i) => i.online && i.enabled).length
    const synced = items.filter(
      (i) => i.enabled && Boolean(i.resolved_ip) && i.last_status !== 'error',
    ).length
    const attention = items.filter(
      (i) => i.last_status === 'error' || (i.enabled && !i.last_seen_at),
    ).length
    return { total: items.length, online, synced, attention }
  }, [items])

  const filteredItems = useMemo(() => {
    const kw = searchText.trim().toLowerCase()
    if (!kw) return items
    return items.filter((it) =>
      `${it.fqdn} ${it.label} ${it.current_ip} ${it.resolved_ip} ${it.hostname} ${it.account_label} ${it.remark}`
        .toLowerCase()
        .includes(kw),
    )
  }, [items, searchText])

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / MONITORS_PAGE_SIZE))
  const safePage = Math.min(page, totalPages)

  useEffect(() => {
    setPage(1)
  }, [searchText])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const pagedItems = useMemo(
    () =>
      filteredItems.slice(
        (safePage - 1) * MONITORS_PAGE_SIZE,
        safePage * MONITORS_PAGE_SIZE,
      ),
    [filteredItems, safePage],
  )

  const toggleEnabled = async (it: DdnsIpMonitorItem) => {
    const key = `toggle-${it.id}`
    setBusyKey(key)
    try {
      await patch(`/api/v1/ddns-ip/monitors/${it.id}`, { enabled: !it.enabled })
      onToast(it.enabled ? `已暂停 ${it.fqdn} 的自动更新` : `已恢复 ${it.fqdn} 的自动更新`, 'success')
      await loadList()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '切换状态失败', 'error')
    } finally {
      setBusyKey('')
    }
  }

  const syncNow = async (it: DdnsIpMonitorItem) => {
    const key = `sync-${it.id}`
    setBusyKey(key)
    try {
      const res = await post<{ ok: true; result: { message: string } }>(
        `/api/v1/ddns-ip/monitors/${it.id}/sync`,
        undefined,
        SLOW_TIMEOUT_MS,
      )
      onToast(res.result.message, 'success')
      await loadList()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '同步解析失败', 'error')
    } finally {
      setBusyKey('')
    }
  }

  const probeLatency = async (it: DdnsIpMonitorItem) => {
    const key = `probe-${it.id}`
    setBusyKey(key)
    try {
      const res = await post<{
        ok: true
        probe: { message: string; ct_ms: number | null; cu_ms: number | null; cm_ms: number | null }
        item: DdnsIpMonitorItem
      }>(`/api/v1/ddns-ip/monitors/${it.id}/probe`, undefined, SLOW_TIMEOUT_MS)
      setItems((prev) => prev.map((x) => (x.id === it.id ? res.item : x)))
      const hasValid = [res.probe.ct_ms, res.probe.cu_ms, res.probe.cm_ms].some(
        (v) => v !== null && v >= 0,
      )
      onToast(res.probe.message, hasValid ? 'success' : 'info')
    } catch (err) {
      onToast(err instanceof Error ? err.message : '三网延迟探测失败', 'error')
    } finally {
      setBusyKey('')
    }
  }

  const rotateToken = (it: DdnsIpMonitorItem) => {
    onConfirm({
      title: `重置「${it.fqdn}」的上报密钥`,
      message: `重置后，原目标服务器上安装的定时任务将立即失效，需要重新运行新的一键安装命令。`,
      confirmText: '确认重置',
      run: async () => {
        const res = await post<{ ok: true; item: DdnsIpMonitorItem }>(
          `/api/v1/ddns-ip/monitors/${it.id}/rotate-token`,
        )
        onToast('已生成新的上报密钥，请更新目标服务器脚本', 'success')
        await loadList()
        setInstallModalItem(res.item)
      },
    })
  }

  const removeItem = (it: DdnsIpMonitorItem) => {
    onConfirm({
      title: `删除 DDNS IP 绑定「${it.fqdn}」`,
      message: `确定移除 ${it.fqdn} 的动态 IPv4 监控绑定吗？`,
      hint: '仅移除面板监控任务，云端现有 A 记录将保留。如需彻底清理服务器定时任务，请先执行卸载命令。',
      confirmText: '确认删除',
      run: async () => {
        await del(`/api/v1/ddns-ip/monitors/${it.id}`)
        onToast(`已删除 ${it.fqdn} 的 DDNS IP 绑定`, 'success')
        await loadList()
        onChanged?.()
      },
    })
  }

  return (
    <div className="nps-root">
      <div className="page-head">
        <div>
          <h2>DDNS IP</h2>
          <p>监控服务器动态公网 IPv4，选择云解析域名并输入前缀绑定，公网 IP 变动时自动解析到最新 IP</p>
        </div>

        <div className="page-actions nps-page-actions">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => void loadList()}
            disabled={loading}
          >
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
            刷新
          </button>
          <button
            type="button"
            className="btn primary sm"
            onClick={() => setEditModal({ open: true, editing: null })}
          >
            <Plus size={13} />
            新增 DDNS 绑定
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="nps-kpi-strip">
        <div className="nps-kpi-card">
          <span className="nps-kpi-label">绑定域名总数</span>
          <strong className="nps-kpi-val">{stats.total}</strong>
          <span className="nps-kpi-sub">支持腾讯云 DNSPod 与 Cloudflare</span>
        </div>
        <div className="nps-kpi-card">
          <span className="nps-kpi-label">在线监控节点</span>
          <strong className="nps-kpi-val">
            {stats.online}
            <small> / {stats.total}</small>
          </strong>
          <span className="nps-kpi-sub">按上报间隔自动判定心跳在线</span>
        </div>
        <div className="nps-kpi-card">
          <span className="nps-kpi-label">解析已同步</span>
          <strong className="nps-kpi-val">{stats.synced}</strong>
          <span className="nps-kpi-sub">IPv4 变动时自动更新 A 记录</span>
        </div>
        <div className="nps-kpi-card">
          <span className="nps-kpi-label">待上报 / 异常</span>
          <strong className="nps-kpi-val">{stats.attention}</strong>
          <span className="nps-kpi-sub">复制一键安装命令到服务器即生效</span>
        </div>
      </div>

      {loading && items.length === 0 ? (
        <div className="card nps-loading-card">
          <LoaderCircle size={18} className="spin" />
          <span>正在加载 DDNS IP 监控列表…</span>
        </div>
      ) : dnsAccounts.length === 0 && items.length === 0 ? (
        <div className="card">
          <Empty
            icon={<Globe2 size={28} />}
            title="尚未配置云解析账号"
            children={
              <div className="nps-empty-body">
                <p>
                  DDNS IP 会自动复用面板中已绑定的腾讯云 DNSPod 或 Cloudflare 账号来读取根域名并自动更新
                  A 记录。请先添加至少一个云解析账号。
                </p>
                <button type="button" className="btn primary" onClick={onGoDnsAccounts}>
                  前往「DNS → 域名解析」添加账号
                </button>
              </div>
            }
          />
        </div>
      ) : (
        <section className="section nps-section">
          <div className="section-head">
            <div className="nps-section-title">
              <Radio size={15} />
              <h3>动态公网 IPv4 监控列表</h3>
              <span className="nps-count-pill">{filteredItems.length}</span>
            </div>
            <div className="nps-head-actions">
              <button
                type="button"
                className="btn primary sm"
                onClick={() => setEditModal({ open: true, editing: null })}
              >
                <Plus size={13} /> 新增绑定
              </button>
            </div>
          </div>

          {items.length > 0 && (
            <div className="nps-filter-bar">
              <div className="nps-search-wrap">
                <Search size={13} />
                <input
                  className="input nps-search-input"
                  placeholder="搜索域名 / 节点 / IP / 备注…"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                />
              </div>
            </div>
          )}

          {filteredItems.length === 0 ? (
            <div className="card">
              <Empty
                icon={<Radio size={26} />}
                title={items.length === 0 ? '暂无 DDNS IP 绑定' : '没有匹配的监控记录'}
                children={
                  items.length === 0 ? (
                    <div className="nps-empty-body">
                      <p>
                        选择根域名并输入解析前缀完成绑定，面板将立即生成类似 NPS 的一键安装命令，复制到目标服务器执行后即可持续监控动态公网
                        IPv4 并在变动时自动更新 DNS。
                      </p>
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() => setEditModal({ open: true, editing: null })}
                      >
                        <Plus size={14} /> 创建第一条 DDNS IP 绑定
                      </button>
                    </div>
                  ) : (
                    '请调整搜索关键词重试。'
                  )
                }
              />
            </div>
          ) : (
            <>
            <div className="nps-host-list">
              {pagedItems.map((it) => {
                const isToggling = busyKey === `toggle-${it.id}`
                const isSyncing = busyKey === `sync-${it.id}`
                const isProbing = busyKey === `probe-${it.id}`
                const ct = formatLatencyChip(it.latency_ct_ms)
                const cu = formatLatencyChip(it.latency_cu_ms)
                const cm = formatLatencyChip(it.latency_cm_ms)
                const latencyTip = it.latency_updated_at
                  ? `国内三网延迟（${it.latency_source === 'probe' ? '国内探针测速' : '服务器自动回报'} · 更新于 ${formatTime(it.latency_updated_at)}）`
                  : '尚未获取到国内三网延迟：可点击「测延迟」即时探测，或重新执行一键安装命令开启服务器自动回报'
                return (
                  <div
                    key={it.id}
                    className={`nps-host-card${!it.enabled ? ' closed' : ''}`}
                  >
                    <div className="nps-host-top">
                      <div className="nps-host-name-wrap">
                        <span className="nps-host-domain">{it.fqdn}</span>
                        <button
                          type="button"
                          className="btn ghost icon sm"
                          onClick={() => void copyText(it.fqdn, `fqdn-${it.id}`, '绑定域名')}
                          title="复制域名"
                        >
                          {copiedKey === `fqdn-${it.id}` ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                        {!it.enabled ? (
                          <Badge tone="gray">已暂停</Badge>
                        ) : it.online ? (
                          <span className="badge ddns-ip-status-online">
                            <i className="dot" />
                            <Wifi size={10} /> 监控在线
                          </span>
                        ) : (
                          <span className="badge ddns-ip-status-offline">
                            <i className="dot" />
                            <WifiOff size={10} /> {it.last_seen_at > 0 ? '监控离线' : '监控离线 · 待上报'}
                          </span>
                        )}
                        <Badge
                          tone={it.account_provider === 'cloudflare' ? 'amber' : 'blue'}
                          dot={false}
                        >
                          {it.account_provider === 'cloudflare' ? 'Cloudflare' : '腾讯云 DNSPod'} ·{' '}
                          {it.account_label}
                        </Badge>
                        {it.account_provider === 'cloudflare' && it.proxied && (
                          <Badge tone="amber" dot={false}>
                            Proxied
                          </Badge>
                        )}
                        {it.label && <span className="nps-host-remark">· {it.label}</span>}
                      </div>

                      {/* China 3-ISP (Telecom / Unicom / Mobile) latency badges */}
                      <div className="ddns-ip-latency-bar" title={latencyTip}>
                        <span className={`ddns-ip-lat-chip ${ct.tone}`}>
                          <i className="ddns-ip-lat-dot" />
                          <span className="ddns-ip-lat-isp">电信</span>
                          <span className="ddns-ip-lat-val">{ct.text}</span>
                        </span>
                        <span className={`ddns-ip-lat-chip ${cu.tone}`}>
                          <i className="ddns-ip-lat-dot" />
                          <span className="ddns-ip-lat-isp">联通</span>
                          <span className="ddns-ip-lat-val">{cu.text}</span>
                        </span>
                        <span className={`ddns-ip-lat-chip ${cm.tone}`}>
                          <i className="ddns-ip-lat-dot" />
                          <span className="ddns-ip-lat-isp">移动</span>
                          <span className="ddns-ip-lat-val">{cm.text}</span>
                        </span>
                        <button
                          type="button"
                          className="btn ghost sm ddns-ip-probe-btn"
                          disabled={isProbing}
                          onClick={() => void probeLatency(it)}
                          title="立即检测国内电信 / 联通 / 移动三网到该服务器的延迟"
                        >
                          {isProbing ? (
                            <LoaderCircle size={11} className="spin" />
                          ) : (
                            <Activity size={11} />
                          )}
                          {isProbing ? '测速中' : '测延迟'}
                        </button>
                      </div>
                    </div>

                    <div className="nps-host-meta">
                      <div>
                        <span className="cert-meta-k">监控公网 IPv4</span>
                        <span className="cert-meta-v mono ddns-ip-val-row">
                          <span>{it.current_ip || '等待上报…'}</span>
                          {it.current_ip && (
                            <button
                              type="button"
                              className="btn ghost icon sm"
                              onClick={() => void copyText(it.current_ip, `curip-${it.id}`, '公网 IPv4')}
                              title="复制公网 IPv4"
                            >
                              {copiedKey === `curip-${it.id}` ? <Check size={11} /> : <Copy size={11} />}
                            </button>
                          )}
                        </span>
                        <span className="nps-meta-sub">
                          心跳：{it.last_seen_at ? relativeAgo(it.last_seen_at) : '未收到上报'}
                        </span>
                      </div>

                      <div>
                        <span className="cert-meta-k">云解析 A 记录</span>
                        <span className="cert-meta-v mono">
                          {it.resolved_ip || '尚未写入'}
                        </span>
                        <span className="nps-meta-sub">
                          TTL {it.account_provider === 'cloudflare' && it.ttl === 1 ? '自动' : `${it.ttl}s`}
                          {it.last_changed_at ? ` · 变更 ${relativeAgo(it.last_changed_at)}` : ''}
                        </span>
                      </div>

                      <div>
                        <span className="cert-meta-k">检测频率与主机</span>
                        <span className="cert-meta-v">每 {it.interval_seconds} 秒检测</span>
                        <span className="nps-meta-sub">
                          {it.hostname ? `主机：${it.hostname}` : '运行一键安装后自动回报主机名'}
                        </span>
                      </div>

                      <div>
                        <span className="cert-meta-k">同步状态</span>
                        <span className="cert-meta-v">
                          {it.last_status === 'error' ? (
                            <Badge tone="red" dot={false}>
                              更新失败
                            </Badge>
                          ) : it.last_status === 'synced' || it.last_status === 'unchanged' ? (
                            <Badge tone="green" dot={false}>
                              已同步最新 IP
                            </Badge>
                          ) : it.last_status === 'disabled' ? (
                            <Badge tone="gray" dot={false}>
                              已暂停
                            </Badge>
                          ) : (
                            <Badge tone="blue" dot={false}>
                              待接入服务器
                            </Badge>
                          )}
                        </span>
                        {it.last_error ? (
                          <span className="nps-meta-err">{it.last_error}</span>
                        ) : (
                          <span className="nps-meta-sub">
                            {it.last_seen_at ? `上次检查 ${formatTime(it.last_seen_at)}` : '请在目标服务器运行下方安装命令'}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* One-click install command bar (NPS-like UX) */}
                    <div className="ddns-ip-cmd-bar">
                      <span className="ddns-ip-cmd-tag">
                        <Terminal size={12} /> 一键安装
                      </span>
                      <code className="ddns-ip-cmd-code" title={maskCommandToken(it.install_cmd, it.token)}>
                        {maskCommandToken(it.install_cmd, it.token)}
                      </code>
                      <button
                        type="button"
                        className="btn ghost sm ddns-ip-copy-btn"
                        onClick={() => void copyText(it.install_cmd, `inst-${it.id}`, 'Linux 一键安装命令')}
                      >
                        {copiedKey === `inst-${it.id}` ? <Check size={12} /> : <Copy size={12} />}
                        复制命令
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm ddns-ip-copy-btn"
                        onClick={() => setInstallModalItem(it)}
                      >
                        全部命令
                      </button>
                    </div>

                    <div className="nps-host-foot">
                      <span className="nps-host-flow">
                        记录前缀：{it.sub_domain} · 根域名：{it.root_domain}
                        {it.remark ? ` · ${it.remark}` : ''}
                      </span>
                      <div className="nps-host-actions">
                        <button
                          type="button"
                          className="btn primary sm"
                          onClick={() => setSshItem(it)}
                          title="打开浏览器 SSH 远程终端连接到该服务器"
                        >
                          <Terminal size={12} /> 远程终端
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={isSyncing || !it.current_ip}
                          onClick={() => void syncNow(it)}
                          title={it.current_ip ? '立即将当前监控 IPv4 强制写入云解析' : '尚未收到服务器 IPv4 上报'}
                        >
                          {isSyncing ? (
                            <LoaderCircle size={12} className="spin" />
                          ) : (
                            <RefreshCw size={12} />
                          )}
                          强制同步
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => setEditModal({ open: true, editing: it })}
                        >
                          <Edit3 size={12} /> 编辑
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={isToggling}
                          onClick={() => void toggleEnabled(it)}
                        >
                          {isToggling ? (
                            <LoaderCircle size={12} className="spin" />
                          ) : it.enabled ? (
                            <Square size={12} />
                          ) : (
                            <Play size={12} />
                          )}
                          {it.enabled ? '暂停' : '启用'}
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm danger"
                          onClick={() => removeItem(it)}
                        >
                          <Trash2 size={12} /> 删除
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            {totalPages > 1 && (
              <div className="card certs-pager" style={{ marginTop: 0 }}>
                <div className="cloud-dns-pager" role="navigation" aria-label="DDNS IP 监控列表分页">
                  <span className="cloud-dns-pager-info">
                    共 {filteredItems.length} 条 · 第 {(safePage - 1) * MONITORS_PAGE_SIZE + 1}–
                    {Math.min(safePage * MONITORS_PAGE_SIZE, filteredItems.length)} 条（{safePage} /{' '}
                    {totalPages} 页）
                  </span>
                  <div className="cloud-dns-pager-controls">
                    <button
                      type="button"
                      className="cloud-dns-page-btn"
                      disabled={safePage <= 1}
                      onClick={() => setPage(Math.max(1, safePage - 1))}
                    >
                      <ChevronLeft size={13} /> 上一页
                    </button>
                    {buildPageTokens(safePage, totalPages).map((tok, idx) =>
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
                          onClick={() => setPage(tok)}
                        >
                          {tok}
                        </button>
                      ),
                    )}
                    <button
                      type="button"
                      className="cloud-dns-page-btn"
                      disabled={safePage >= totalPages}
                      onClick={() => setPage(Math.min(totalPages, safePage + 1))}
                    >
                      下一页 <ChevronRight size={13} />
                    </button>
                  </div>
                </div>
              </div>
            )}
            </>
          )}
        </section>
      )}

      {/* Create / Edit Binding Modal */}
      {editModal.open && (
        <DdnsIpFormModal
          dnsAccounts={dnsAccounts}
          editing={editModal.editing}
          onClose={() => setEditModal({ open: false, editing: null })}
          onGoDnsAccounts={() => {
            setEditModal({ open: false, editing: null })
            onGoDnsAccounts()
          }}
          onSaved={(savedItem, isNew) => {
            setEditModal({ open: false, editing: null })
            onToast(
              isNew
                ? `已绑定 ${savedItem.fqdn}，复制一键安装命令到服务器即可开始自动监控`
                : `已保存 ${savedItem.fqdn} 的 DDNS IP 配置`,
              'success',
            )
            void loadList()
            onChanged?.()
            if (isNew) {
              setInstallModalItem(savedItem)
            }
          }}
        />
      )}

      {/* One-Click Install / Uninstall Commands Modal */}
      {installModalItem && (
        <DdnsIpInstallModal
          item={installModalItem}
          copiedKey={copiedKey}
          onCopy={copyText}
          onRotateToken={() => rotateToken(installModalItem)}
          onClose={() => setInstallModalItem(null)}
        />
      )}

      {/* Full-Screen Web SSH Remote Terminal Overlay */}
      {sshItem && (
        <DdnsSshOverlay
          monitor={sshItem}
          onToast={onToast}
          onMonitorUpdated={(updated) => {
            setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
            setSshItem(updated)
          }}
          onClose={() => setSshItem(null)}
        />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Create / Edit DDNS IP Binding Modal                                        */
/* -------------------------------------------------------------------------- */

function DdnsIpFormModal({
  dnsAccounts,
  editing,
  onClose,
  onGoDnsAccounts,
  onSaved,
}: {
  dnsAccounts: DnsAccount[]
  editing: DdnsIpMonitorItem | null
  onClose: () => void
  onGoDnsAccounts: () => void
  onSaved: (item: DdnsIpMonitorItem, isNew: boolean) => void
}) {
  const [accountId, setAccountId] = useState<number>(
    editing?.dns_account_id ?? dnsAccounts[0]?.id ?? 0,
  )
  const [domains, setDomains] = useState<CloudDnsDomain[]>([])
  const [domainsLoading, setDomainsLoading] = useState(false)
  const [domainsError, setDomainsError] = useState('')

  const [rootDomain, setRootDomain] = useState(editing?.root_domain ?? '')
  const [zoneId, setZoneId] = useState(editing?.zone_id ?? '')
  const [subDomain, setSubDomain] = useState(
    editing ? (editing.sub_domain === '@' ? '' : editing.sub_domain) : '',
  )
  const [label, setLabel] = useState(editing?.label ?? '')
  const [intervalSec, setIntervalSec] = useState<string>(String(editing?.interval_seconds ?? 60))
  const [ttl, setTtl] = useState<string>(String(editing?.ttl ?? 600))
  const [proxied, setProxied] = useState<boolean>(editing?.proxied ?? false)
  const [line, setLine] = useState<string>(editing?.line || '默认')
  const [remark, setRemark] = useState(editing?.remark ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const currentAccount = useMemo(
    () => dnsAccounts.find((a) => a.id === accountId) ?? null,
    [dnsAccounts, accountId],
  )

  useEffect(() => {
    if (!accountId) {
      setDomains([])
      return
    }
    let cancelled = false
    setDomainsLoading(true)
    setDomainsError('')
    api<{ items: CloudDnsDomain[] }>(`/api/v1/dns-accounts/${accountId}/domains`)
      .then((res) => {
        if (cancelled) return
        setDomains(res.items)
        // Auto-select matching or first root domain when switching account
        setRootDomain((prev) => {
          const hit = res.items.find((d) => d.name.toLowerCase() === prev.toLowerCase())
          if (hit) {
            setZoneId(hit.id)
            return hit.name
          }
          if (res.items[0]) {
            setZoneId(res.items[0].id)
            return res.items[0].name
          }
          return prev
        })
      })
      .catch((err) => {
        if (cancelled) return
        setDomains([])
        setDomainsError(err instanceof Error ? err.message : '加载该账号域名列表失败')
      })
      .finally(() => {
        if (!cancelled) setDomainsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [accountId])

  useEffect(() => {
    if (!editing && currentAccount) {
      setTtl(currentAccount.provider === 'cloudflare' ? '1' : '600')
    }
  }, [currentAccount?.id, currentAccount?.provider, editing])

  const fullDomainPreview = useMemo(
    () => previewFqdn(subDomain || '@', rootDomain),
    [subDomain, rootDomain],
  )

  const submit = async () => {
    setError('')
    if (!accountId) return setError('请先选择一个云解析账号')
    if (!rootDomain.trim()) return setError('请选择要绑定的根域名')
    const intervalNum = Math.max(30, Math.min(3600, Math.trunc(Number(intervalSec) || 60)))
    const ttlNum = Math.max(1, Math.min(86400, Math.trunc(Number(ttl) || 600)))

    setSaving(true)
    try {
      const payload = {
        label: label.trim(),
        dns_account_id: accountId,
        root_domain: rootDomain.trim().toLowerCase(),
        zone_id: zoneId.trim(),
        sub_domain: subDomain.trim() || '@',
        ttl: ttlNum,
        proxied: currentAccount?.provider === 'cloudflare' ? proxied : false,
        line: currentAccount?.provider === 'tencent' ? line : '',
        interval_seconds: intervalNum,
        remark: remark.trim(),
      }
      if (editing) {
        const res = await patch<{ ok: true; item: DdnsIpMonitorItem }>(
          `/api/v1/ddns-ip/monitors/${editing.id}`,
          payload,
        )
        onSaved(res.item, false)
      } else {
        const res = await post<{ ok: true; item: DdnsIpMonitorItem }>(
          '/api/v1/ddns-ip/monitors',
          payload,
        )
        onSaved(res.item, true)
      }
    } catch (err) {
      setError(err instanceof APIError ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      wide
      title={editing ? `编辑 DDNS IP 绑定 · ${editing.fqdn}` : '新增 DDNS IP 动态公网 IPv4 绑定'}
      icon={<Radio size={16} />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void submit()}
            disabled={saving || dnsAccounts.length === 0}
          >
            {saving && <LoaderCircle size={13} className="spin" />}
            {editing ? '保存修改' : '绑定并生成安装命令'}
          </button>
        </>
      }
    >
      <div className="nps-form">
        {error && <div className="form-err">{error}</div>}

        {dnsAccounts.length === 0 ? (
          <div className="nps-warn-box">
            <span>尚未添加云解析账号，无法选择域名。</span>
            <button type="button" className="btn primary sm" onClick={onGoDnsAccounts}>
              前往添加云解析账号
            </button>
          </div>
        ) : (
          <>
            <div className="grid-2">
              <div className="field">
                <label>云解析账号</label>
                <select
                  className="select"
                  value={accountId}
                  onChange={(e) => {
                    setAccountId(Number(e.target.value))
                    setZoneId('')
                  }}
                >
                  {dnsAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      [{a.provider === 'cloudflare' ? 'Cloudflare' : '腾讯云 DNSPod'}] {a.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>
                  选择根域名
                  {domainsLoading && <LoaderCircle size={12} className="spin" />}
                </label>
                {domains.length > 0 ? (
                  <select
                    className="select"
                    value={rootDomain}
                    onChange={(e) => {
                      const next = e.target.value
                      setRootDomain(next)
                      const found = domains.find((d) => d.name === next)
                      setZoneId(found?.id ?? '')
                    }}
                  >
                    {domains.map((d) => (
                      <option key={d.id || d.name} value={d.name}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="input"
                    placeholder={domainsLoading ? '正在加载域名列表…' : '输入或选择根域名，例如 example.com'}
                    value={rootDomain}
                    onChange={(e) => {
                      setRootDomain(e.target.value)
                      setZoneId('')
                    }}
                  />
                )}
                {domainsError && <span className="nps-meta-err">{domainsError}</span>}
              </div>
            </div>

            <div className="field">
              <label>输入解析前缀</label>
              <div className="ddns-ip-domain-compose">
                <input
                  className="input mono"
                  placeholder="例如 home、nas、hk（留空或填 @ 表示根域名）"
                  value={subDomain}
                  onChange={(e) => setSubDomain(e.target.value)}
                />
                <span className="ddns-ip-domain-suffix">.{rootDomain || 'example.com'}</span>
              </div>
              {fullDomainPreview && (
                <div className="ddns-ip-preview-bar">
                  <span>最终绑定域名：</span>
                  <code>{fullDomainPreview}</code>
                  <Badge tone="blue" dot={false}>
                    A 记录 (IPv4)
                  </Badge>
                </div>
              )}
            </div>

            <div className="grid-2">
              <div className="field">
                <label>节点名称（可选）</label>
                <input
                  className="input"
                  placeholder="例如：家里宽带 / 香港动态拨号机"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
              <div className="field">
                <label>IP 检测上报间隔</label>
                <Segmented
                  value={
                    INTERVAL_PRESETS.some((p) => p.value === intervalSec) ? intervalSec : '60'
                  }
                  options={INTERVAL_PRESETS}
                  onChange={setIntervalSec}
                />
              </div>
            </div>

            <div className="grid-2">
              <div className="field">
                <label>
                  TTL（秒
                  {currentAccount?.provider === 'cloudflare' ? '，填 1 表示自动' : '，默认 600'}）
                </label>
                <input
                  type="number"
                  min={1}
                  max={86400}
                  className="input"
                  value={ttl}
                  onChange={(e) => setTtl(e.target.value)}
                />
              </div>
              {currentAccount?.provider === 'tencent' ? (
                <div className="field">
                  <label>解析线路（DNSPod）</label>
                  <select className="select" value={line} onChange={(e) => setLine(e.target.value)}>
                    {DNSPOD_LINE_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="field">
                  <label>备注（可选）</label>
                  <input
                    className="input"
                    placeholder="用途说明"
                    value={remark}
                    onChange={(e) => setRemark(e.target.value)}
                  />
                </div>
              )}
            </div>

            {currentAccount?.provider === 'cloudflare' && (
              <Switch
                checked={proxied}
                onChange={setProxied}
                label="开启 Cloudflare 代理（小黄云）"
                hint="开启后经由 Cloudflare CDN 转发流量；直连 SSH / RDP / 非标准端口请保持关闭"
              />
            )}

            {currentAccount?.provider === 'tencent' && (
              <div className="field">
                <label>备注（可选）</label>
                <input
                  className="input"
                  placeholder="用途说明"
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                />
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */
/* One-Click Install Commands Modal                                           */
/* -------------------------------------------------------------------------- */

function DdnsIpInstallModal({
  item,
  copiedKey,
  onCopy,
  onRotateToken,
  onClose,
}: {
  item: DdnsIpMonitorItem
  copiedKey: string
  onCopy: (text: string, key: string, label: string) => Promise<void>
  onRotateToken: () => void
  onClose: () => void
}) {
  const winCmd = useMemo(() => buildWindowsInstallCmd(item), [item])

  return (
    <Modal
      wide
      title={`一键安装与监控命令 · ${item.fqdn}`}
      icon={<Terminal size={16} />}
      onClose={onClose}
      footer={
        <div className="nps-cert-modal-foot">
          <div className="nps-cert-foot-left">
            <button type="button" className="btn ghost sm danger" onClick={onRotateToken}>
              <KeyRound size={12} /> 重置上报密钥
            </button>
          </div>
          <div className="nps-cert-foot-right">
            <button type="button" className="btn primary" onClick={onClose}>
              完成
            </button>
          </div>
        </div>
      }
    >
      <div className="nps-form">
        <div className="eo-cert-modal-note">
          <strong>工作原理：</strong>在需要监控动态公网 IPv4 的服务器上执行下方一键命令后，脚本会自动创建后台定时任务（优先{' '}
          <code>systemd timer</code> 每 {item.interval_seconds} 秒检测，无 systemd 时自动写入 <code>crontab</code>
          ），实时获取公网 IPv4 并上报到本面板。当公网 IP 未变动时零云解析 API 消耗；一旦变动即自动更新{' '}
          <code>{item.fqdn}</code> 的 <code>A</code> 记录。
        </div>

        <div className="ddns-ip-cmd-card">
          <div className="ddns-ip-cmd-card-head">
            <strong>1. Linux 一键安装命令（推荐，Debian / Ubuntu / CentOS / Alpine / OpenWrt）</strong>
            <button
              type="button"
              className="btn primary sm"
              onClick={() => void onCopy(item.install_cmd, `m-inst-${item.id}`, 'Linux 一键安装命令')}
            >
              {copiedKey === `m-inst-${item.id}` ? <Check size={12} /> : <Copy size={12} />}
              复制安装命令
            </button>
          </div>
          <pre className="ddns-ip-pre">{item.install_cmd}</pre>
        </div>

        <div className="ddns-ip-cmd-card">
          <div className="ddns-ip-cmd-card-head">
            <strong>2. 单次立即上报命令（适合手动测试或自行加入 NAS / 路由器计划任务）</strong>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void onCopy(item.report_cmd, `m-rep-${item.id}`, '单次上报命令')}
            >
              {copiedKey === `m-rep-${item.id}` ? <Check size={12} /> : <Copy size={12} />}
              复制
            </button>
          </div>
          <pre className="ddns-ip-pre">{item.report_cmd}</pre>
        </div>

        <div className="ddns-ip-cmd-card">
          <div className="ddns-ip-cmd-card-head">
            <strong>3. Windows PowerShell 计划任务一键命令（以管理员身份运行）</strong>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void onCopy(winCmd, `m-win-${item.id}`, 'Windows 计划任务命令')}
            >
              {copiedKey === `m-win-${item.id}` ? <Check size={12} /> : <Copy size={12} />}
              复制
            </button>
          </div>
          <pre className="ddns-ip-pre">{winCmd}</pre>
        </div>

        <div className="ddns-ip-cmd-card">
          <div className="ddns-ip-cmd-card-head">
            <strong>4. Linux 一键卸载命令</strong>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void onCopy(item.uninstall_cmd, `m-uninst-${item.id}`, 'Linux 卸载命令')}
            >
              {copiedKey === `m-uninst-${item.id}` ? <Check size={12} /> : <Copy size={12} />}
              复制
            </button>
          </div>
          <pre className="ddns-ip-pre">{item.uninstall_cmd}</pre>
        </div>
      </div>
    </Modal>
  )
}
