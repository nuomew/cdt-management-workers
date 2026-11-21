import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  BarChart3,
  Clock,
  Cloud,
  ExternalLink,
  Gauge,
  LoaderCircle,
  MapPin,
  RefreshCw,
  Server as ServerIcon,
  ShieldAlert,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Wallet,
} from 'lucide-react'
import { api } from '../api'
import { regionLabel } from '../regions'
import type { AdminDashboardPayload, AdminNodeMetric } from '../types'
import { ArcGauge, TrendChart } from './TelemetryCharts'
import { Badge, Meter, Segmented, statusLabel, statusTone } from './ui'

const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  HKD: 'HK$',
  JPY: 'JP¥',
  EUR: '€',
}

function formatMoney(amount: number, currency: string): string {
  const sym = CURRENCY_SYMBOL[currency] ?? `${currency} `
  return `${sym}${amount.toFixed(2)}`
}

function formatGb(gb: number): string {
  if (!Number.isFinite(gb)) return '0.0'
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TB`
  return `${gb.toFixed(gb >= 100 ? 1 : 2)} GB`
}

function unlimitedSwasLabel(bandwidthMbps?: number): string {
  return bandwidthMbps && bandwidthMbps > 0 ? `${bandwidthMbps}M无限制` : '不限流量'
}

function unlimitedSwasPoolLabel(nodes: { quota_gb: number; bandwidth_mbps?: number }[]): string {
  const bws = Array.from(
    new Set(
      nodes
        .filter((n) => n.quota_gb <= 0 && (n.bandwidth_mbps ?? 0) > 0)
        .map((n) => n.bandwidth_mbps as number),
    ),
  )
  if (bws.length === 1) return `${bws[0]}M无限制`
  if (bws.length > 1) return `${bws.sort((a, b) => a - b).join('/')}M无限制`
  return '不限流量'
}

function DeltaTag({ pct, label }: { pct: number | null; label: string }) {
  if (pct === null) {
    return <span className="tele-delta flat">{label} 暂无基线</span>
  }
  if (Math.abs(pct) < 0.2) {
    return <span className="tele-delta flat">{label} 持平</span>
  }
  const up = pct > 0
  return (
    <span className={`tele-delta ${up ? 'up' : 'down'}`}>
      {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {label} {up ? '+' : ''}
      {pct.toFixed(1)}%
    </span>
  )
}

export default function TelemetryDashboardView({
  onNavigate,
  onOpenPublicHome,
  publicHomeEnabled,
}: {
  onNavigate: (view: 'servers' | 'swas') => void
  onOpenPublicHome: () => void
  publicHomeEnabled: boolean
}) {
  const [days, setDays] = useState<7 | 14 | 30>(7)
  const [serverId, setServerId] = useState<number>(0)
  const [chartMode, setChartMode] = useState<'area' | 'bar'>('bar')
  const [chartMetric, setChartMetric] = useState<'daily' | 'cumulative'>('daily')
  const [nodeTab, setNodeTab] = useState<'ecs' | 'swas'>('ecs')

  const [data, setData] = useState<AdminDashboardPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const qs = new URLSearchParams({ days: String(days) })
      if (serverId > 0) qs.set('server_id', String(serverId))
      const res = await api<AdminDashboardPayload>(`/api/v1/dashboard/analytics?${qs.toString()}`)
      setData(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载仪表盘分析数据失败')
    } finally {
      setLoading(false)
    }
  }, [days, serverId])

  useEffect(() => {
    void load()
  }, [load])

  const summary = data?.summary
  const ecsShare =
    summary && summary.total_used_gb > 0
      ? Math.min(100, (summary.ecs_used_gb / summary.total_used_gb) * 100)
      : 0
  const swasShare =
    summary && summary.total_used_gb > 0
      ? Math.min(100, (summary.swas_used_gb / summary.total_used_gb) * 100)
      : 0
  const maxRankUsed = Math.max(...(data?.ranking ?? []).map((r) => r.used_gb), 0.01)

  const activeNodes: AdminNodeMetric[] =
    nodeTab === 'ecs' ? (data?.ecs_nodes ?? []) : (data?.swas_nodes ?? [])

  return (
    <>
      <div className="page-head">
        <div>
          <h1>仪表盘</h1>
          <p>
            全网 ECS CDT 与轻量服务器流量全景分析、日/月环比、月底消耗预测与阈值触顶预警
            {data ? ` · 更新于 ${data.updated_label}` : ''}
          </p>
        </div>
        <div className="page-actions">
          <Segmented
            value={String(days)}
            options={[
              { value: '7', label: '7 天' },
              { value: '14', label: '14 天' },
              { value: '30', label: '30 天' },
            ]}
            onChange={(val) => setDays(Number(val) as 7 | 14 | 30)}
          />
          {data && data.filter_servers.length > 0 && (
            <select
              className="select tele-filter-select"
              aria-label="按 ECS 服务器筛选"
              value={String(serverId)}
              onChange={(event) => setServerId(Number(event.target.value))}
            >
              <option value="0">全部节点</option>
              {data.filter_servers.map((srv) => (
                <option key={srv.id} value={String(srv.id)}>
                  {srv.label}（{regionLabel(srv.region_id)}）
                </option>
              ))}
            </select>
          )}
          {publicHomeEnabled && (
            <button
              type="button"
              className="btn sm"
              onClick={onOpenPublicHome}
              title="打开免登录公开首页"
            >
              <ExternalLink size={13} /> 公开首页
            </button>
          )}
          <button type="button" className="btn primary sm" disabled={loading} onClick={() => void load()}>
            {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
            刷新
          </button>
        </div>
      </div>

      {error && (
        <div className="auth-error" style={{ marginBottom: 16 }}>
          <TriangleAlert size={14} />
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="card card-pad manage-center">
          <LoaderCircle size={20} className="spin" />
          <span>正在聚合全网流量采样与预测数据…</span>
        </div>
      ) : data && summary ? (
        <>
          {/* 4-Column Executive KPI Row */}
          <div className="tele-admin-kpis">
            <div className="card tele-kpi">
              <div className="tele-kpi-head">
                <span>在线节点 / 总数</span>
                <Activity size={14} style={{ color: 'var(--green)' }} />
              </div>
              <div className="tele-kpi-val mono">
                {summary.online_nodes}
                <small> / {summary.total_nodes}</small>
              </div>
              <div className="tele-kpi-foot">
                ECS {summary.ecs_online}/{summary.ecs_total}
                {serverId === 0 ? ` · 轻量 ${summary.swas_online}/${summary.swas_total}` : '（单节点聚焦）'}
              </div>
            </div>

            <div className="card tele-kpi">
              <div className="tele-kpi-head">
                <span>今日新增流量</span>
                <BarChart3 size={14} style={{ color: 'var(--accent)' }} />
              </div>
              <div className="tele-kpi-val mono">{formatGb(summary.today_gb)}</div>
              <div className="tele-kpi-foot">
                <DeltaTag pct={summary.day_delta_pct} label="较昨日" />
                <span className="mono" style={{ color: 'var(--muted-soft)' }}>
                  昨 {formatGb(summary.yesterday_gb)}
                </span>
              </div>
            </div>

            <div className="card tele-kpi">
              <div className="tele-kpi-head">
                <span>本月 ECS 累计 / 预测</span>
                <Gauge size={14} style={{ color: 'var(--blue)' }} />
              </div>
              <div className="tele-kpi-val mono">{formatGb(summary.month_gb)}</div>
              <div className="tele-kpi-foot">
                <DeltaTag pct={summary.month_delta_pct} label="较上月" />
                <span className="mono" title={`本月还剩 ${summary.remaining_days} 天`}>
                  月底预计 {formatGb(summary.projected_month_gb)}
                </span>
              </div>
            </div>

            <div className="card tele-kpi">
              <div className="tele-kpi-head">
                <span>本月云账单（已去重）</span>
                <Wallet size={14} style={{ color: 'var(--amber)' }} />
              </div>
              {summary.costs.length > 0 ? (
                <>
                  <div className="tele-kpi-val mono">
                    {formatMoney(summary.costs[0]!.monthly_cost, summary.costs[0]!.currency)}
                  </div>
                  <div className="tele-kpi-foot">
                    <span>
                      余额 {formatMoney(summary.costs[0]!.balance, summary.costs[0]!.currency)}
                    </span>
                    {summary.costs.length > 1 && (
                      <span>+{summary.costs.length - 1} 种币种</span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="tele-kpi-val mono">—</div>
                  <div className="tele-kpi-foot">待刷新账单或未启用 BSS 查询</div>
                </>
              )}
            </div>
          </div>

          {/* Center Dual Deck: Quota Health Panoramic Gauge + Interactive Trend Chart */}
          <div className="tele-admin-main-grid">
            <div className="card tele-gauge-panel">
              <div className="tele-panel-kicker">
                <Gauge size={13} /> 配额水位与健康分桶
              </div>
              <div className="tele-gauge-body">
                <ArcGauge
                  percent={summary.total_percent}
                  size={196}
                  stroke={12}
                  centerValue={`${summary.total_percent.toFixed(1)}%`}
                  centerLabel="总体配额"
                  subLabel={`${formatGb(summary.total_used_gb)} / ${formatGb(summary.total_quota_gb)}`}
                />
                <div className="tele-gauge-aside">
                  <div className="tele-health-pills">
                    <span className="tele-pill safe">
                      <ShieldCheck size={12} /> 正常 {data.health.safe}
                    </span>
                    <span className="tele-pill warn">
                      <TriangleAlert size={12} /> 预警 {data.health.warning}
                    </span>
                    <span className="tele-pill crit">
                      <ShieldAlert size={12} /> 超限 {data.health.critical}
                    </span>
                    <span className="tele-pill muted">停机 {data.health.stopped}</span>
                  </div>

                  <div className="tele-split">
                    <div className="tele-split-row">
                      <span>
                        <ServerIcon size={12} /> ECS CDT 流量
                      </span>
                      <strong className="mono">
                        {formatGb(summary.ecs_used_gb)} / {formatGb(summary.ecs_quota_gb)}
                      </strong>
                    </div>
                    <div className="tele-split-track">
                      <div className="tele-split-bar ecs" style={{ width: `${ecsShare}%` }} />
                    </div>

                    {serverId === 0 && (
                      <>
                        <div className="tele-split-row" style={{ marginTop: 10 }}>
                          <span>
                            <Cloud size={12} /> 轻量月流量包
                          </span>
                          <strong className="mono">
                            {summary.swas_total > 0 && summary.swas_quota_gb <= 0
                              ? unlimitedSwasPoolLabel(data.swas_nodes)
                              : `${formatGb(summary.swas_used_gb)} / ${formatGb(summary.swas_quota_gb)}`}
                          </strong>
                        </div>
                        <div className="tele-split-track">
                          <div className="tele-split-bar swas" style={{ width: `${swasShare}%` }} />
                        </div>
                      </>
                    )}
                  </div>

                  <div className="tele-forecast-bar">
                    <span>
                      <Clock size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                      日均 {formatGb(summary.avg_daily_gb)}/天 · 余 {summary.remaining_days} 天
                    </span>
                    <strong className="mono">预测 {formatGb(summary.projected_month_gb)}</strong>
                  </div>
                </div>
              </div>
            </div>

            <div className="card card-pad tele-chart-card">
              <div className="tele-chart-head">
                <div>
                  <strong>近 {data.days} 天流量趋势</strong>
                  <span>
                    {chartMetric === 'daily' ? '每日新增流量（GB）' : '本月累计水位（GB）'}
                    {serverId > 0 ? ' · 单节点' : ' · 全 ECS 汇总'}
                  </span>
                </div>
                <div className="tele-chart-controls">
                  <Segmented
                    value={chartMetric}
                    options={[
                      { value: 'daily', label: '日增量' },
                      { value: 'cumulative', label: '累计' },
                    ]}
                    onChange={setChartMetric}
                  />
                  <Segmented
                    value={chartMode}
                    options={[
                      { value: 'bar', label: '柱状' },
                      { value: 'area', label: '曲线' },
                    ]}
                    onChange={setChartMode}
                  />
                </div>
              </div>
              <TrendChart data={data.trend} mode={chartMode} metric={chartMetric} height={240} />
            </div>
          </div>

          {/* Node Gauges & Threshold Countdown */}
          <div className="section">
            <div className="section-head">
              <h2>节点精细遥测与触顶预警</h2>
              <span>按当前日均流速推算每台节点预计触及停机阈值的剩余天数</span>
              <div className="section-actions">
                <Segmented
                  value={nodeTab}
                  options={[
                    { value: 'ecs', label: `ECS (${data.ecs_nodes.length})` },
                    { value: 'swas', label: `轻量 (${data.swas_nodes.length})` },
                  ]}
                  onChange={setNodeTab}
                />
              </div>
            </div>

            {activeNodes.length === 0 ? (
              <div className="card card-pad tele-empty">
                当前分类暂无节点，可前往
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ marginLeft: 6 }}
                  onClick={() => onNavigate(nodeTab === 'ecs' ? 'servers' : 'swas')}
                >
                  {nodeTab === 'ecs' ? '服务器管理' : '轻量服务器管理'}
                </button>
              </div>
            ) : (
              <div className="tele-node-grid">
                {activeNodes.map((node) => {
                  const unlimitedSwas = node.kind === 'swas' && node.quota_gb <= 0
                  const warnDays = node.days_to_threshold
                  const warnTone =
                    warnDays === 0
                      ? 'red'
                      : warnDays !== null && warnDays <= 5
                        ? 'amber'
                        : 'green'
                  return (
                    <button
                      type="button"
                      key={`${node.kind}-${node.id}`}
                      className={`card tele-node-card clickable health-${node.health}`}
                      onClick={() => onNavigate(node.kind === 'ecs' ? 'servers' : 'swas')}
                      title="点击前往该分类管理页面"
                    >
                      <div className="tele-node-top">
                        <div className="tele-node-title">
                          <span className={`tele-kind-chip ${node.kind}`}>
                            {node.kind === 'ecs' ? 'ECS' : '轻量'}
                          </span>
                          <strong title={node.label}>{node.label}</strong>
                        </div>
                        <Badge tone={statusTone(node.status)} pulse={node.status === 'Running'}>
                          {statusLabel(node.status)}
                        </Badge>
                      </div>

                      <div className="tele-node-meta">
                        <span>
                          <MapPin size={11} /> {regionLabel(node.region_id)}
                        </span>
                        <code className="mono">{node.public_ip || node.instance_id}</code>
                      </div>

                      <div className="tele-node-meter">
                        <div className="tele-node-nums">
                          <strong className="mono">
                            {unlimitedSwas ? unlimitedSwasLabel(node.bandwidth_mbps) : formatGb(node.used_gb)}
                          </strong>
                          <span className="mono">
                            {node.quota_gb > 0
                              ? `/ ${formatGb(node.quota_gb)} (${node.percent.toFixed(1)}%)`
                              : unlimitedSwas
                                ? '不限流量'
                                : '无固定配额'}
                          </span>
                        </div>
                        {node.quota_gb > 0 && (
                          <Meter
                            used={node.used_gb}
                            quota={node.quota_gb}
                            threshold={
                              node.threshold_gb > 0 ? node.threshold_gb : node.quota_gb * 0.9
                            }
                          />
                        )}
                      </div>

                      <div className="tele-node-foot">
                        <span>
                          {node.kind === 'ecs'
                            ? `今日 +${formatGb(node.today_gb)} · 日均 ${formatGb(node.avg_daily_gb)}`
                            : `${node.spec_summary}${node.expired_time ? ` · 到期 ${node.expired_time.slice(0, 10)}` : ''}`}
                        </span>
                        {node.kind === 'ecs' && warnDays !== null && (
                          <Badge tone={warnTone} dot={false}>
                            {warnDays === 0 ? '已达阈值' : `约 ${warnDays} 天触顶`}
                          </Badge>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Ranking TOP 12 */}
          <div className="section">
            <div className="section-head">
              <h2>全网流量消耗排行</h2>
              <span>本月已用流量占比分布（TOP {data.ranking.length}）</span>
            </div>
            <div className="card card-pad">
              {data.ranking.length === 0 ? (
                <div className="tele-empty">暂无节点流量数据</div>
              ) : (
                <div className="tele-rank-list">
                  {data.ranking.map((item, idx) => {
                    const unlimitedSwas = item.kind === 'swas' && item.quota_gb <= 0
                    const widthPct = Math.max(4, (item.used_gb / maxRankUsed) * 100)
                    return (
                      <div className="tele-rank-row" key={`${item.kind}-${item.id}`}>
                        <div className="tele-rank-head">
                          <span className={`tele-rank-idx top-${idx < 3 ? idx + 1 : 'n'}`}>
                            {idx + 1}
                          </span>
                          <span className={`tele-kind-chip ${item.kind}`}>
                            {item.kind === 'ecs' ? 'ECS' : '轻量'}
                          </span>
                          <strong className="tele-rank-name">{item.name}</strong>
                          <span className="tele-rank-region">{regionLabel(item.region_id)}</span>
                          {item.kind === 'ecs' && (
                            <span className="tele-rank-today mono">
                              今日 +{formatGb(item.today_gb)}
                            </span>
                          )}
                          <span className="tele-rank-val mono">
                            {unlimitedSwas ? (
                              unlimitedSwasLabel(item.bandwidth_mbps)
                            ) : (
                              <>
                                {formatGb(item.used_gb)}
                                {item.quota_gb > 0 ? ` (${item.percent.toFixed(1)}%)` : ''}
                              </>
                            )}
                          </span>
                        </div>
                        <div className="tele-rank-track">
                          <div
                            className={`tele-rank-fill ${item.kind}`}
                            style={{ width: `${widthPct}%` }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}
    </>
  )
}
