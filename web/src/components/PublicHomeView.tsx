import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  ArrowRight,
  BarChart3,
  Cloud,
  Gauge,
  LoaderCircle,
  Lock,
  MapPin,
  Radio,
  RefreshCw,
  Server as ServerIcon,
  ShieldAlert,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react'
import { APIError, api } from '../api'
import { regionLabel } from '../regions'
import type { PublicHomePayload } from '../types'
import { ArcGauge, TrendChart } from './TelemetryCharts'
import { Badge, Meter, Segmented, statusLabel, statusTone } from './ui'

const AUTO_REFRESH_MS = 60_000

function formatGb(gb: number): string {
  if (!Number.isFinite(gb)) return '0.0'
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TB`
  return `${gb.toFixed(gb >= 100 ? 1 : 2)} GB`
}

function unlimitedSwasLabel(bandwidthMbps?: number): string {
  return bandwidthMbps && bandwidthMbps > 0 ? `${bandwidthMbps}M无限制` : '不限流量'
}

function unlimitedSwasPoolLabel(nodes: { kind: string; quota_gb: number; bandwidth_mbps?: number }[]): string {
  const bws = Array.from(
    new Set(
      nodes
        .filter((n) => n.kind === 'swas' && n.quota_gb <= 0 && (n.bandwidth_mbps ?? 0) > 0)
        .map((n) => n.bandwidth_mbps as number),
    ),
  )
  if (bws.length === 1) return `${bws[0]}M无限制`
  if (bws.length > 1) return `${bws.sort((a, b) => a - b).join('/')}M无限制`
  return '不限流量'
}

function DeltaChip({ pct, prefix }: { pct: number | null; prefix: string }) {
  if (pct === null) {
    return <span className="tele-delta flat">{prefix} 暂无基线</span>
  }
  if (Math.abs(pct) < 0.2) {
    return <span className="tele-delta flat">{prefix} 持平</span>
  }
  const up = pct > 0
  return (
    <span className={`tele-delta ${up ? 'up' : 'down'}`}>
      {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {prefix} {up ? '+' : ''}
      {pct.toFixed(1)}%
    </span>
  )
}

export default function PublicHomeView({
  authenticated,
  brand,
  version,
  onEnterAdmin,
  onDisabled,
}: {
  authenticated: boolean
  brand: string
  version: string
  onEnterAdmin: () => void
  onDisabled: () => void
}) {
  const [data, setData] = useState<PublicHomePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [nodeFilter, setNodeFilter] = useState<'all' | 'ecs' | 'swas'>('all')
  const [chartMode, setChartMode] = useState<'area' | 'bar'>('area')

  const load = useCallback(
    async (silent = false) => {
      if (silent) setRefreshing(true)
      else setLoading(true)
      setError('')
      try {
        const res = await api<PublicHomePayload>('/api/v1/public/home')
        setData(res)
      } catch (err) {
        if (err instanceof APIError && (err.status === 403 || err.status === 404)) {
          onDisabled()
          return
        }
        setError(err instanceof Error ? err.message : '加载实时状态失败')
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [onDisabled],
  )

  useEffect(() => {
    void load(false)
    const timer = window.setInterval(() => {
      void load(true)
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const summary = data?.summary
  const filteredNodes = (data?.nodes ?? []).filter((n) =>
    nodeFilter === 'all' ? true : n.kind === nodeFilter,
  )
  const maxRankUsed = Math.max(...(data?.ranking ?? []).map((r) => r.used_gb), 0.01)

  const ecsShare =
    summary && summary.total_used_gb > 0
      ? Math.min(100, (summary.ecs_used_gb / summary.total_used_gb) * 100)
      : 0
  const swasShare =
    summary && summary.total_used_gb > 0
      ? Math.min(100, (summary.swas_used_gb / summary.total_used_gb) * 100)
      : 0

  return (
    <div className="pub-shell">
      <header className="pub-topbar">
        <div className="pub-topbar-inner">
          <a href="/" className="pub-brand" onClick={(e) => e.preventDefault()}>
            <span className="pub-brand-mark">
              <Radio size={15} />
            </span>
            <span className="pub-brand-text">
              <strong>{data?.site_title || brand || 'CDT 云节点流量遥测'}</strong>
            </span>
          </a>

          <nav className="pub-nav" aria-label="公开页分区">
            <a href="#pub-overview">总览</a>
            <a href="#pub-nodes">节点矩阵</a>
            <a href="#pub-trend">流量趋势</a>
            <a href="#pub-ranking">用量排行</a>
          </nav>

          <div className="pub-top-actions">
            {summary && (
              <Badge
                tone={summary.online_nodes > 0 ? 'green' : 'gray'}
                pulse={summary.online_nodes > 0}
              >
                {summary.online_nodes}/{summary.total_nodes} 在线
              </Badge>
            )}
            <button
              type="button"
              className="btn ghost sm"
              disabled={refreshing || loading}
              onClick={() => void load(true)}
              title="刷新公开遥测数据"
            >
              {refreshing ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
              刷新
            </button>
            <button type="button" className="btn primary sm" onClick={onEnterAdmin}>
              {authenticated ? (
                <>
                  返回管理后台 <ArrowRight size={13} />
                </>
              ) : (
                <>
                  <Lock size={12} /> 管理后台
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="pub-main">
        {loading && !data ? (
          <div className="pub-loading">
            <div className="spinner" />
            <span>正在加载实时云节点状态与流量遥测…</span>
          </div>
        ) : error && !data ? (
          <div className="card card-pad pub-error">
            <TriangleAlert size={20} style={{ color: 'var(--red)' }} />
            <div>{error}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn sm" onClick={() => void load(false)}>
                重试
              </button>
              <button type="button" className="btn primary sm" onClick={onEnterAdmin}>
                前往管理后台
              </button>
            </div>
          </div>
        ) : data && summary ? (
          <>
            {/* Hero Telemetry Deck */}
            <section className="pub-hero" id="pub-overview">
              <div className="pub-hero-head">
                <div>
                  <h1>{data.site_title}</h1>
                  <p>{data.site_subtitle}</p>
                </div>
                <div className="pub-hero-meta">
                  <span className="pub-meta-pill">
                    <Activity size={12} /> 更新于 {data.updated_label} ({data.timezone})
                  </span>
                </div>
              </div>

              <div className="tele-deck">
                {/* Left: Master 240-deg Gauge + Dual Domain Split */}
                <div className="card tele-gauge-panel">
                  <div className="tele-panel-kicker">
                    <Gauge size={13} /> 全网月度流量配额池
                  </div>
                  <div className="tele-gauge-body">
                    <ArcGauge
                      percent={summary.total_percent}
                      size={204}
                      stroke={13}
                      centerValue={`${summary.total_percent.toFixed(1)}%`}
                      centerLabel="总配额已用"
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
                            <ServerIcon size={12} /> ECS CDT ({summary.ecs_online}/{summary.ecs_total})
                          </span>
                          <strong className="mono">
                            {formatGb(summary.ecs_used_gb)} / {formatGb(summary.ecs_quota_gb)}
                          </strong>
                        </div>
                        <div className="tele-split-track">
                          <div className="tele-split-bar ecs" style={{ width: `${ecsShare}%` }} />
                        </div>

                        <div className="tele-split-row" style={{ marginTop: 10 }}>
                          <span>
                            <Cloud size={12} /> 轻量流量包 ({summary.swas_online}/{summary.swas_total})
                          </span>
                          <strong className="mono">
                            {summary.swas_total > 0 && summary.swas_quota_gb <= 0
                              ? unlimitedSwasPoolLabel(data.nodes)
                              : `${formatGb(summary.swas_used_gb)} / ${formatGb(summary.swas_quota_gb)}`}
                          </strong>
                        </div>
                        <div className="tele-split-track">
                          <div className="tele-split-bar swas" style={{ width: `${swasShare}%` }} />
                        </div>
                      </div>

                      <div className="tele-forecast-bar">
                        <span>ECS 月底预测（余 {summary.remaining_days} 天）</span>
                        <strong className="mono">{formatGb(summary.projected_month_gb)}</strong>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right: 2x2 KPI Telemetry Matrix */}
                <div className="tele-kpi-quad">
                  <div className="card tele-kpi">
                    <div className="tele-kpi-head">
                      <span>节点在线率</span>
                      <Radio size={14} style={{ color: 'var(--green)' }} />
                    </div>
                    <div className="tele-kpi-val mono">
                      {summary.online_nodes}
                      <small> / {summary.total_nodes}</small>
                    </div>
                    <div className="tele-kpi-foot">
                      ECS {summary.ecs_online}/{summary.ecs_total} · 轻量 {summary.swas_online}/
                      {summary.swas_total}
                    </div>
                  </div>

                  <div className="card tele-kpi">
                    <div className="tele-kpi-head">
                      <span>今日新增流量</span>
                      <Activity size={14} style={{ color: 'var(--accent)' }} />
                    </div>
                    <div className="tele-kpi-val mono">{formatGb(summary.today_gb)}</div>
                    <div className="tele-kpi-foot">
                      <DeltaChip pct={summary.day_delta_pct} prefix="较昨日" />
                    </div>
                  </div>

                  <div className="card tele-kpi">
                    <div className="tele-kpi-head">
                      <span>昨日流量</span>
                      <BarChart3 size={14} style={{ color: 'var(--blue)' }} />
                    </div>
                    <div className="tele-kpi-val mono">{formatGb(summary.yesterday_gb)}</div>
                    <div className="tele-kpi-foot">
                      本月日均 <strong className="mono">{formatGb(summary.avg_daily_gb)}/天</strong>
                    </div>
                  </div>

                  <div className="card tele-kpi">
                    <div className="tele-kpi-head">
                      <span>本月 ECS 累计</span>
                      <Gauge size={14} style={{ color: 'var(--amber)' }} />
                    </div>
                    <div className="tele-kpi-val mono">{formatGb(summary.month_gb)}</div>
                    <div className="tele-kpi-foot">
                      <DeltaChip pct={summary.month_delta_pct} prefix="较上月" />
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Nodes Telemetry Matrix */}
            <section className="section" id="pub-nodes">
              <div className="section-head">
                <h2>节点状态矩阵</h2>
                <span>脱敏展示各节点实时在线状态与月度配额水位</span>
                <div className="section-actions">
                  <Segmented
                    value={nodeFilter}
                    options={[
                      { value: 'all', label: `全部 (${data.nodes.length})` },
                      { value: 'ecs', label: `ECS (${summary.ecs_total})` },
                      { value: 'swas', label: `轻量 (${summary.swas_total})` },
                    ]}
                    onChange={setNodeFilter}
                  />
                </div>
              </div>

              {filteredNodes.length === 0 ? (
                <div className="card card-pad tele-empty">当前分类下暂无纳管节点</div>
              ) : (
                <div className="tele-node-grid">
                  {filteredNodes.map((node, idx) => {
                    const unlimitedSwas = node.kind === 'swas' && node.quota_gb <= 0
                    return (
                      <div className={`card tele-node-card health-${node.health}`} key={`${node.kind}-${node.name}-${idx}`}>
                        <div className="tele-node-top">
                          <div className="tele-node-title">
                            <span className={`tele-kind-chip ${node.kind}`}>
                              {node.kind === 'ecs' ? 'ECS' : '轻量'}
                            </span>
                            <strong title={node.name}>{node.name}</strong>
                          </div>
                          <Badge tone={statusTone(node.status)} pulse={node.status === 'Running'}>
                            {statusLabel(node.status)}
                          </Badge>
                        </div>

                        <div className="tele-node-meta">
                          <span>
                            <MapPin size={11} /> {regionLabel(node.region_id)}
                          </span>
                          <span>{node.spec_summary}</span>
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
                              threshold={node.threshold_gb > 0 ? node.threshold_gb : node.quota_gb * 0.9}
                            />
                          )}
                        </div>

                        <div className="tele-node-foot">
                          <span>
                            {node.kind === 'ecs' ? (
                              <>今日 +{formatGb(node.today_gb)}</>
                            ) : unlimitedSwas ? (
                              <>带宽型不限流量</>
                            ) : (
                              <>套餐月流量包</>
                            )}
                          </span>
                          {node.threshold_gb > 0 && (
                            <span className="mono">阈值 {node.threshold_gb} GB</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            {/* Bottom Dual Panels: 7-Day Trend + Ranking Distribution */}
            <div className="tele-bottom-grid">
              <section className="section" id="pub-trend" style={{ marginTop: 0 }}>
                <div className="section-head">
                  <h2>近 7 天流量趋势</h2>
                  <span>ECS CDT 每日增量（GB）</span>
                  <div className="section-actions">
                    <Segmented
                      value={chartMode}
                      options={[
                        { value: 'area', label: '曲线' },
                        { value: 'bar', label: '柱状' },
                      ]}
                      onChange={setChartMode}
                    />
                  </div>
                </div>
                <div className="card card-pad">
                  <TrendChart data={data.trend} mode={chartMode} metric="daily" height={240} />
                </div>
              </section>

              <section className="section" id="pub-ranking" style={{ marginTop: 0 }}>
                <div className="section-head">
                  <h2>流量占用排行</h2>
                  <span>按本月消耗降序 TOP {data.ranking.length}</span>
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
                          <div className="tele-rank-row" key={`${item.kind}-${item.name}-${idx}`}>
                            <div className="tele-rank-head">
                              <span className={`tele-rank-idx top-${idx < 3 ? idx + 1 : 'n'}`}>
                                {idx + 1}
                              </span>
                              <span className={`tele-kind-chip ${item.kind}`}>
                                {item.kind === 'ecs' ? 'ECS' : '轻量'}
                              </span>
                              <strong className="tele-rank-name">{item.name}</strong>
                              <span className="tele-rank-region">{regionLabel(item.region_id)}</span>
                              <span className="tele-rank-val mono">
                                {unlimitedSwas ? unlimitedSwasLabel(item.bandwidth_mbps) : formatGb(item.used_gb)}
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
              </section>
            </div>
          </>
        ) : null}
      </main>

      <footer className="pub-footer">
        <span>
          {data?.brand || brand || 'CDT-Management'} · v{version || 'workers'}
        </span>
        <span>公开视图已隐藏 IP、实例 ID、账单及操作入口 · 每 60 秒自动更新</span>
      </footer>
    </div>
  )
}
