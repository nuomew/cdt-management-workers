import { useState } from 'react'
import {
  AlertTriangle,
  CalendarClock,
  Cloud,
  Cpu,
  Disc3,
  GripVertical,
  Info,
  Layers,
  LayoutGrid,
  List,
  LoaderCircle,
  MapPin,
  Monitor,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Rocket,
  RotateCw,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
import { regionLabel } from '../regions'
import { clockText } from '../time'
import type { Billing, SwasServer } from '../types'
import { Badge, Empty, Meter, statusLabel, statusTone } from './ui'

type Props = {
  servers: SwasServer[]
  busyId: number | null
  billingId: number | null
  onAdd: () => void
  onProvision: () => void
  onEdit: (server: SwasServer) => void
  onDelete: (server: SwasServer) => void
  onRefresh: (server: SwasServer) => void
  onAction: (server: SwasServer, action: 'start' | 'stop') => void
  onReboot: (server: SwasServer) => void
  onDetail: (server: SwasServer) => void
  onVnc: (server: SwasServer) => void
  onReset: (server: SwasServer) => void
  onImages: (server: SwasServer) => void
  onRenew: (server: SwasServer) => void
  onOps: (server: SwasServer) => void
  onBilling: (server: SwasServer) => void
  onReorder: (orderedIds: number[]) => void
}

type ViewMode = 'card' | 'list'

function daysUntilExpire(iso?: string): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return Math.ceil((ms - Date.now()) / (86400 * 1000))
}

function expireShortText(iso?: string): { text: string; warn: boolean; expired: boolean } | null {
  if (!iso) return null
  const days = daysUntilExpire(iso)
  if (days === null) return null
  if (days <= 0) return { text: '已到期', warn: true, expired: true }
  if (days <= 7) return { text: `${days} 天后到期`, warn: true, expired: false }
  const datePart = iso.slice(0, 10)
  return { text: `${datePart} 到期`, warn: false, expired: false }
}

function specSummary(s: SwasServer): string {
  const parts: string[] = []
  if (s.cpu > 0 || s.memory_gb > 0) parts.push(`${s.cpu}C ${s.memory_gb}G`)
  if (s.disk_size_gb > 0) parts.push(`${s.disk_size_gb}G盘`)
  if (s.bandwidth_mbps > 0) parts.push(`${s.bandwidth_mbps}M`)
  return parts.join(' · ')
}

export default function SwasView({
  servers,
  busyId,
  billingId,
  onAdd,
  onProvision,
  onEdit,
  onDelete,
  onRefresh,
  onAction,
  onReboot,
  onDetail,
  onVnc,
  onReset,
  onImages,
  onRenew,
  onOps,
  onBilling,
  onReorder,
}: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('card')
  const [dragId, setDragId] = useState<number | null>(null)
  const [overId, setOverId] = useState<number | null>(null)

  function handleDrop(targetId: number) {
    if (dragId === null || dragId === targetId) {
      setDragId(null)
      setOverId(null)
      return
    }
    const next = [...servers]
    const from = next.findIndex((s) => s.id === dragId)
    const to = next.findIndex((s) => s.id === targetId)
    if (from < 0 || to < 0) return
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setDragId(null)
    setOverId(null)
    onReorder(next.map((s) => s.id))
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>轻量服务器</h1>
          <p>
            独立管理阿里云轻量应用服务器（SWAS）：支持套餐流量包监控、一键发现导入、包年包月询价开通与续费、防火墙规则、改密改名、快照与自定义镜像（含跨账号/ECS 共享）、VNC / Workbench 终端与重置系统。
          </p>
        </div>
        <div className="page-actions">
          {servers.length > 1 && (
            <div className="view-toggle" role="group" aria-label="视图切换">
              <button
                type="button"
                className={`btn sm${viewMode === 'card' ? ' primary' : ''}`}
                title="卡片视图"
                onClick={() => setViewMode('card')}
              >
                <LayoutGrid size={13} /> 卡片
              </button>
              <button
                type="button"
                className={`btn sm${viewMode === 'list' ? ' primary' : ''}`}
                title="列表视图"
                onClick={() => setViewMode('list')}
              >
                <List size={13} /> 列表
              </button>
            </div>
          )}
          <button type="button" className="btn" onClick={onProvision}>
            <Rocket size={14} /> 开通轻量
          </button>
          <button type="button" className="btn primary" onClick={onAdd}>
            <Plus size={14} /> 添加轻量
          </button>
        </div>
      </div>

      {servers.length === 0 ? (
        <div className="card">
          <Empty icon={<Cloud size={20} />} title="还没有轻量服务器">
            可点击右上角「开通轻量」直接询价新购包年包月套餐，或点「添加轻量」复用已有阿里云账号一键拉取导入已有轻量实例。
          </Empty>
        </div>
      ) : viewMode === 'list' ? (
        <SwasTable
          servers={servers}
          busyId={busyId}
          billingId={billingId}
          onEdit={onEdit}
          onDelete={onDelete}
          onRefresh={onRefresh}
          onAction={onAction}
          onReboot={onReboot}
          onDetail={onDetail}
          onVnc={onVnc}
          onReset={onReset}
          onImages={onImages}
          onRenew={onRenew}
          onOps={onOps}
          onBilling={onBilling}
        />
      ) : (
        <div className="server-grid">
          {servers.map((server) => {
            const running = server.instance_status === 'Running'
            const busy = busyId === server.id
            const hasInstance = Boolean(server.instance_id && server.region_id)
            const exp = expireShortText(server.expired_time)
            const spec = specSummary(server)
            const totalGb = server.traffic_total_gb ?? 0
            const usedGb = server.traffic_used_gb

            return (
              <div
                className={`card server-card${dragId === server.id ? ' dragging' : ''}${
                  overId === server.id ? ' drag-over' : ''
                }`}
                key={server.id}
                draggable
                onDragStart={(event) => {
                  setDragId(server.id)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', String(server.id))
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  if (overId !== server.id) setOverId(server.id)
                }}
                onDragLeave={() => {
                  if (overId === server.id) setOverId(null)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  handleDrop(server.id)
                }}
                onDragEnd={() => {
                  setDragId(null)
                  setOverId(null)
                }}
              >
                <div className="head">
                  <GripVertical size={13} className="drag-handle" aria-hidden />
                  <Badge tone={statusTone(server.instance_status)} pulse={running}>
                    {statusLabel(server.instance_status)}
                  </Badge>
                  <strong title={server.label}>{server.label}</strong>
                  <div className="actions">
                    <button
                      className="btn ghost icon sm"
                      title="刷新状态与流量包"
                      disabled={busy}
                      onClick={() => onRefresh(server)}
                    >
                      {busy ? (
                        <LoaderCircle size={13} className="spin" />
                      ) : (
                        <RefreshCw size={13} />
                      )}
                    </button>
                    <button className="btn ghost icon sm" title="编辑" onClick={() => onEdit(server)}>
                      <Pencil size={13} />
                    </button>
                    <button
                      className="btn ghost icon sm"
                      title="从面板移除（不销毁云端包年包月实例）"
                      onClick={() => onDelete(server)}
                    >
                      <Trash2 size={13} style={{ color: 'var(--red)' }} />
                    </button>
                  </div>
                </div>

                <div className="meta-line">
                  <code style={{ fontSize: 11 }}>{server.instance_id || '未填实例 ID'}</code>
                  {spec && (
                    <span className="site-tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <Cpu size={10} /> {spec}
                    </span>
                  )}
                </div>

                <div className="meta-line">
                  <span className="card-region" title={server.region_id}>
                    <MapPin size={11} />
                    {regionLabel(server.region_id)}
                  </span>
                  <span className={`site-tag ${server.site === 'international' ? 'intl' : ''}`}>
                    {server.site === 'international' ? '国际站' : '中国站'}
                  </span>
                  <span className="card-ip" title="公网 IP">
                    {server.public_ip || '无公网 IP'}
                  </span>
                </div>

                {totalGb > 0 ? (
                  <Meter
                    used={usedGb}
                    quota={totalGb}
                    threshold={Math.round(totalGb * 0.9)}
                  />
                ) : (
                  <div style={{ fontSize: 11.5, color: 'var(--muted-soft)' }}>
                    {server.bandwidth_mbps > 0
                      ? `${server.bandwidth_mbps}M无限制${usedGb && usedGb > 0 ? ` · 已用 ${usedGb.toFixed(1)} GB` : ''}`
                      : usedGb !== null
                        ? `不限流量${usedGb > 0 ? ` · 已用 ${usedGb.toFixed(1)} GB` : ''}`
                        : '点击右上角刷新同步套餐流量包'}
                  </div>
                )}

                {(server.traffic_overflow_gb ?? 0) > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--red)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <AlertTriangle size={11} /> 已超出流量包 {(server.traffic_overflow_gb ?? 0).toFixed(2)} GB
                  </div>
                )}

                <SwasCostRow
                  billing={server.billing}
                  busy={billingId === server.id}
                  onRefresh={() => onBilling(server)}
                />

                {server.remark && (
                  <div style={{ fontSize: 11.5, color: 'var(--muted-soft)' }}>{server.remark}</div>
                )}

                <div className="server-manage-bar">
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={!hasInstance}
                    title="查看套餐规格、网络、流量包与磁盘详情"
                    onClick={() => onDetail(server)}
                  >
                    <Info size={12} /> 详情
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={!hasInstance}
                    title="快照备份、自定义镜像制作及跨账号/ECS 镜像共享"
                    onClick={() => onImages(server)}
                  >
                    <Layers size={12} /> 镜像
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={!hasInstance}
                    title="打开内置全屏 VNC 远程控制台 / Workbench"
                    onClick={() => onVnc(server)}
                  >
                    <Monitor size={12} /> VNC
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={!hasInstance || !running || busy}
                    title={running ? '重启轻量实例' : '仅运行中的实例可重启'}
                    onClick={() => onReboot(server)}
                  >
                    <RotateCw size={12} /> 重启
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={!hasInstance}
                    title="查看到期时间、实时询价与包年包月续费"
                    onClick={() => onRenew(server)}
                  >
                    <CalendarClock size={12} /> 续费
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={!hasInstance}
                    title="改密、改名与防火墙端口规则管理"
                    onClick={() => onOps(server)}
                  >
                    <SlidersHorizontal size={12} /> 运维
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={!hasInstance || busy}
                    title="重置当前系统或更换系统/应用/自定义镜像"
                    onClick={() => onReset(server)}
                  >
                    <Disc3 size={12} /> 重装
                  </button>
                </div>

                <div className="card-foot">
                  <span
                    className="owner-tag free"
                    style={
                      exp?.warn
                        ? { color: exp.expired ? 'var(--red)' : 'var(--amber)' }
                        : undefined
                    }
                    title={server.expired_time || '包年包月轻量实例'}
                  >
                    {exp ? exp.text : server.image_name || '轻量应用服务器'}
                  </span>

                  <div className="foot-actions">
                    <button
                      className={`btn sm ${running ? 'danger' : 'primary'}`}
                      disabled={busy || !hasInstance}
                      onClick={() => onAction(server, running ? 'stop' : 'start')}
                    >
                      {busy ? (
                        <LoaderCircle size={12} className="spin" />
                      ) : running ? (
                        <PowerOff size={12} />
                      ) : (
                        <Power size={12} />
                      )}
                      {running ? '关机' : '开机'}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

function SwasTable({
  servers,
  busyId,
  billingId,
  onEdit,
  onDelete,
  onRefresh,
  onAction,
  onReboot,
  onDetail,
  onVnc,
  onReset,
  onImages,
  onRenew,
  onOps,
  onBilling,
}: {
  servers: SwasServer[]
  busyId: number | null
  billingId: number | null
  onEdit: (server: SwasServer) => void
  onDelete: (server: SwasServer) => void
  onRefresh: (server: SwasServer) => void
  onAction: (server: SwasServer, action: 'start' | 'stop') => void
  onReboot: (server: SwasServer) => void
  onDetail: (server: SwasServer) => void
  onVnc: (server: SwasServer) => void
  onReset: (server: SwasServer) => void
  onImages: (server: SwasServer) => void
  onRenew: (server: SwasServer) => void
  onOps: (server: SwasServer) => void
  onBilling: (server: SwasServer) => void
}) {
  return (
    <div className="card server-table-card">
      <table className="server-table">
        <colgroup>
          <col style={{ width: '13%' }} />
          <col style={{ width: '8%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '11%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '9%' }} />
          <col style={{ width: '9%' }} />
          <col style={{ width: '20%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>轻量服务器 / 实例 ID</th>
            <th>状态</th>
            <th>地域 / 站点</th>
            <th>公网 IP</th>
            <th>规格</th>
            <th>流量包</th>
            <th>本月 / 余额</th>
            <th>到期</th>
            <th style={{ textAlign: 'right' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {servers.map((server) => {
            const running = server.instance_status === 'Running'
            const busy = busyId === server.id
            const hasInstance = Boolean(server.instance_id && server.region_id)
            const exp = expireShortText(server.expired_time)
            return (
              <tr key={server.id}>
                <td data-label="轻量服务器">
                  <div className="server-table-title" title={server.label}>
                    {server.label}
                  </div>
                  <code className="server-table-sub" title={server.instance_id}>
                    {server.instance_id || '未填实例 ID'}
                  </code>
                </td>
                <td data-label="状态">
                  <Badge tone={statusTone(server.instance_status)} pulse={running}>
                    {statusLabel(server.instance_status)}
                  </Badge>
                </td>
                <td data-label="地域">
                  <div className="server-table-region">
                    <span className="server-table-cell">
                      <MapPin size={11} />
                      {regionLabel(server.region_id)}
                    </span>
                    <span className={`site-tag ${server.site === 'international' ? 'intl' : ''}`}>
                      {server.site === 'international' ? '国际' : '中国'}
                    </span>
                  </div>
                </td>
                <td data-label="公网 IP">
                  <span className="server-table-mono">{server.public_ip || '—'}</span>
                </td>
                <td data-label="规格">
                  <span className="server-table-mono">{specSummary(server) || '—'}</span>
                </td>
                <td data-label="流量包">
                  {server.traffic_total_gb ? (
                    <div className="server-table-meter">
                      <span className="server-table-mono">
                        {(server.traffic_used_gb ?? 0).toFixed(1)}
                      </span>
                      <span className="server-table-muted"> / {server.traffic_total_gb.toFixed(0)} GB</span>
                    </div>
                  ) : server.bandwidth_mbps > 0 ? (
                    <span className="server-table-mono">{server.bandwidth_mbps}M无限制</span>
                  ) : (
                    <span className="server-table-muted">—</span>
                  )}
                </td>
                <td className="server-table-cost" data-label="费用">
                  <SwasCostRow
                    billing={server.billing}
                    busy={billingId === server.id}
                    onRefresh={() => onBilling(server)}
                    compact
                  />
                </td>
                <td data-label="到期">
                  <span
                    className="server-table-mono"
                    style={
                      exp?.warn
                        ? { color: exp.expired ? 'var(--red)' : 'var(--amber)' }
                        : undefined
                    }
                  >
                    {exp ? exp.text : '—'}
                  </span>
                </td>
                <td data-label="操作">
                  <div className="server-table-actions">
                    <button
                      className="btn ghost icon sm"
                      title="详情与磁盘"
                      disabled={!hasInstance}
                      onClick={() => onDetail(server)}
                    >
                      <Info size={13} />
                    </button>
                    <button
                      className="btn ghost icon sm"
                      title="快照与自定义镜像共享"
                      disabled={!hasInstance}
                      onClick={() => onImages(server)}
                    >
                      <Layers size={13} />
                    </button>
                    <button
                      className="btn ghost icon sm"
                      title="续费管理"
                      disabled={!hasInstance}
                      onClick={() => onRenew(server)}
                    >
                      <CalendarClock size={13} />
                    </button>
                    <button
                      className="btn ghost icon sm"
                      title="运维（改密 / 改名 / 防火墙）"
                      disabled={!hasInstance}
                      onClick={() => onOps(server)}
                    >
                      <SlidersHorizontal size={13} />
                    </button>
                    <button
                      className="btn ghost icon sm"
                      title="VNC / Workbench"
                      disabled={!hasInstance}
                      onClick={() => onVnc(server)}
                    >
                      <Monitor size={13} />
                    </button>
                    <button
                      className="btn ghost icon sm"
                      title={running ? '重启实例' : '仅运行中的实例可重启'}
                      disabled={!hasInstance || !running || busy}
                      onClick={() => onReboot(server)}
                    >
                      <RotateCw size={13} />
                    </button>
                    <button
                      className="btn ghost icon sm"
                      title="重置系统"
                      disabled={!hasInstance || busy}
                      onClick={() => onReset(server)}
                    >
                      <Disc3 size={13} />
                    </button>
                    <button
                      className="btn ghost icon sm"
                      title="刷新状态"
                      disabled={busy}
                      onClick={() => onRefresh(server)}
                    >
                      {busy ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
                    </button>
                    <button className="btn ghost icon sm" title="编辑" onClick={() => onEdit(server)}>
                      <Pencil size={13} />
                    </button>
                    <button
                      className="btn ghost icon sm"
                      title="从面板移除"
                      onClick={() => onDelete(server)}
                    >
                      <Trash2 size={13} style={{ color: 'var(--red)' }} />
                    </button>
                    <button
                      className={`btn sm ${running ? 'danger' : 'primary'}`}
                      disabled={busy || !hasInstance}
                      onClick={() => onAction(server, running ? 'stop' : 'start')}
                    >
                      {busy ? (
                        <LoaderCircle size={12} className="spin" />
                      ) : running ? (
                        <PowerOff size={12} />
                      ) : (
                        <Power size={12} />
                      )}
                      {running ? '关机' : '开机'}
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  HKD: 'HK$',
  JPY: 'JP¥',
  EUR: '€',
}

function moneyText(amount: number | null, currency: string): string {
  if (amount === null || amount === undefined) return '—'
  const sign = CURRENCY_SYMBOL[currency] ?? `${currency} `
  return `${sign}${amount.toFixed(2)}`
}

function SwasCostRow({
  billing,
  busy,
  onRefresh,
  compact = false,
}: {
  billing?: Billing | null
  busy: boolean
  onRefresh: () => void
  compact?: boolean
}) {
  const cost = billing?.monthly_cost ?? null
  const balance = billing?.balance ?? null
  const currency = billing?.currency || 'CNY'
  const stale = Boolean(billing?.stale)
  const err = (billing?.error || '').trim()
  const updated = billing?.updated_at ? clockText(billing.updated_at) : ''
  const lowBalance = balance !== null && balance <= 10
  const tip = err
    ? `上次查询失败：${err}`
    : updated
      ? `最近更新 ${updated}（${billing?.cycle || '当月'}），点击立即刷新`
      : '点击立即查询本月消费与账号余额'

  return (
    <div className={`cost-row${compact ? ' compact' : ''}`} title={tip}>
      <span className="cost-item">
        <span className="cost-k">{compact ? '本月' : '本月费用'}</span>
        <span className={`cost-v${stale ? ' stale' : ''}`}>
          {stale ? '待更新' : moneyText(cost, currency)}
        </span>
      </span>
      <span className="cost-sep" aria-hidden>
        ·
      </span>
      <span className="cost-item">
        <span className="cost-k">余额</span>
        <span className={`cost-v${lowBalance ? ' warn' : ''}`}>
          {moneyText(balance, currency)}
        </span>
      </span>
      {err && (
        <span className="cost-err" title={err} aria-label={err}>
          <AlertTriangle size={11} />
        </span>
      )}
      <button
        type="button"
        className="cost-refresh"
        disabled={busy}
        title="立即刷新本月费用与余额"
        onClick={(event) => {
          event.stopPropagation()
          onRefresh()
        }}
      >
        {busy ? <LoaderCircle size={11} className="spin" /> : <RefreshCw size={11} />}
      </button>
    </div>
  )
}
