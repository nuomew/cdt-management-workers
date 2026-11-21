import { useId, useState } from 'react'
import type { TrendPoint } from '../types'

/* ============================================================================
   1. 240-degree Precision Arc Gauge (Swiss Telemetry Console style)
   ========================================================================== */

type GaugeTone = 'emerald' | 'amber' | 'crimson'

function resolveTone(percent: number, explicit?: GaugeTone): GaugeTone {
  if (explicit) return explicit
  if (percent >= 90) return 'crimson'
  if (percent >= 75) return 'amber'
  return 'emerald'
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  }
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, endAngle)
  const end = polarToCartesian(cx, cy, r, startAngle)
  const sweep = endAngle - startAngle <= 180 ? '0' : '1'
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${sweep} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`
}

export function ArcGauge({
  percent,
  size = 188,
  stroke = 12,
  thresholdPercent,
  centerValue,
  centerLabel,
  subLabel,
  tone,
}: {
  percent: number
  size?: number
  stroke?: number
  thresholdPercent?: number
  centerValue?: string
  centerLabel?: string
  subLabel?: string
  tone?: GaugeTone
}) {
  const gradId = useId()
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  const resolved = resolveTone(clamped, tone)

  const cx = size / 2
  const cy = size / 2
  const radius = (size - stroke * 2 - 6) / 2
  const startAngle = -120
  const totalSweep = 240
  const endAngle = startAngle + totalSweep
  const valueAngle = startAngle + (totalSweep * clamped) / 100

  const trackPath = describeArc(cx, cy, radius, startAngle, endAngle)
  const valuePath =
    clamped > 0.2 ? describeArc(cx, cy, radius, startAngle, Math.max(startAngle + 1, valueAngle)) : ''
  const tip = polarToCartesian(cx, cy, radius, valueAngle)

  const thresholdMark =
    thresholdPercent && thresholdPercent > 0 && thresholdPercent < 100
      ? (() => {
          const ang = startAngle + (totalSweep * thresholdPercent) / 100
          const inner = polarToCartesian(cx, cy, radius - stroke * 0.65, ang)
          const outer = polarToCartesian(cx, cy, radius + stroke * 0.65, ang)
          return { inner, outer }
        })()
      : null

  const palette =
    resolved === 'crimson'
      ? { start: '#f97316', end: '#ef4444', glow: 'rgba(239, 68, 68, 0.36)' }
      : resolved === 'amber'
        ? { start: '#fbbf24', end: '#f59e0b', glow: 'rgba(245, 158, 11, 0.36)' }
        : { start: '#10b981', end: '#06b6d4', glow: 'rgba(16, 185, 129, 0.36)' }

  // Subtle tick marks along the outer perimeter for instrument feel.
  const ticks = [0, 25, 50, 75, 100].map((pct) => {
    const ang = startAngle + (totalSweep * pct) / 100
    const p1 = polarToCartesian(cx, cy, radius + stroke * 0.68, ang)
    const p2 = polarToCartesian(cx, cy, radius + stroke * 0.95, ang)
    return { pct, p1, p2 }
  })

  return (
    <div className={`arc-gauge tone-${resolved}`} style={{ width: size, height: size * 0.88 }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-label={`配额使用率 ${clamped.toFixed(1)}%`}
      >
        <defs>
          <linearGradient id={gradId} x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={palette.start} />
            <stop offset="100%" stopColor={palette.end} />
          </linearGradient>
        </defs>

        {ticks.map((t) => (
          <line
            key={t.pct}
            x1={t.p1.x}
            y1={t.p1.y}
            x2={t.p2.x}
            y2={t.p2.y}
            className="arc-gauge-tick"
            strokeWidth={1.25}
            strokeLinecap="round"
          />
        ))}

        <path
          d={trackPath}
          fill="none"
          className="arc-gauge-track"
          strokeWidth={stroke}
          strokeLinecap="round"
        />

        {valuePath && (
          <path
            d={valuePath}
            fill="none"
            stroke={`url(#${gradId})`}
            strokeWidth={stroke}
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 6px ${palette.glow})` }}
          />
        )}

        {thresholdMark && (
          <line
            x1={thresholdMark.inner.x}
            y1={thresholdMark.inner.y}
            x2={thresholdMark.outer.x}
            y2={thresholdMark.outer.y}
            className="arc-gauge-threshold"
            strokeWidth={2}
            strokeLinecap="round"
          />
        )}

        {clamped > 0.2 && (
          <circle
            cx={tip.x}
            cy={tip.y}
            r={Math.max(3, stroke * 0.38)}
            fill="#ffffff"
            stroke={palette.end}
            strokeWidth={2.5}
          />
        )}
      </svg>

      <div className="arc-gauge-center">
        <div className="arc-gauge-value">{centerValue ?? `${clamped.toFixed(1)}%`}</div>
        {centerLabel && <div className="arc-gauge-label">{centerLabel}</div>}
        {subLabel && <div className="arc-gauge-sub">{subLabel}</div>}
      </div>
    </div>
  )
}

/* ============================================================================
   2. Interactive Native SVG Trend Chart (Area Line / Bar + Daily / Cumulative)
   ========================================================================== */

export function TrendChart({
  data,
  mode = 'area',
  metric = 'daily',
  height = 230,
}: {
  data: TrendPoint[]
  mode?: 'area' | 'bar'
  metric?: 'daily' | 'cumulative'
  height?: number
}) {
  const gradId = useId()
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  if (!data || data.length === 0) {
    return (
      <div className="trend-empty" style={{ height }}>
        暂无流量采样历史，待后台巡检累计后自动绘制趋势
      </div>
    )
  }

  const W = 680
  const H = height
  const padL = 46
  const padR = 16
  const padT = 18
  const padB = 28
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const values = data.map((d) => (metric === 'cumulative' ? d.cumulative_gb : d.daily_gb))
  const rawMax = Math.max(...values, 0)
  const yMax = rawMax <= 0 ? 10 : rawMax * 1.18
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => ({
    ratio: r,
    value: yMax * r,
    y: padT + plotH * (1 - r),
  }))

  const count = data.length
  const stepX = count > 1 ? plotW / (count - 1) : plotW
  const barSlot = plotW / Math.max(count, 1)
  const barW = Math.min(34, Math.max(8, barSlot * 0.56))

  const xAt = (idx: number) =>
    mode === 'bar'
      ? padL + barSlot * idx + barSlot / 2
      : count === 1
        ? padL + plotW / 2
        : padL + stepX * idx
  const yAt = (val: number) => padT + plotH - (Math.max(0, val) / yMax) * plotH

  const points = data.map((d, idx) => ({
    ...d,
    val: values[idx] ?? 0,
    x: xAt(idx),
    y: yAt(values[idx] ?? 0),
  }))

  // Smooth monotone cubic path for area/line chart.
  const linePath = points
    .map((pt, i) => {
      if (i === 0) return `M ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`
      const prev = points[i - 1]!
      const cx = ((prev.x + pt.x) / 2).toFixed(1)
      return `C ${cx} ${prev.y.toFixed(1)}, ${cx} ${pt.y.toFixed(1)}, ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`
    })
    .join(' ')

  const areaPath =
    points.length > 0
      ? `${linePath} L ${points[points.length - 1]!.x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${points[0]!.x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`
      : ''

  const labelStep = count > 16 ? Math.ceil(count / 8) : count > 10 ? 2 : 1
  const activePt = hoverIdx !== null ? points[hoverIdx] ?? null : null

  return (
    <div className="trend-wrap" onMouseLeave={() => setHoverIdx(null)}>
      <svg
        className="trend-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="流量趋势图"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {yTicks.map((t) => (
          <g key={t.ratio}>
            <line
              x1={padL}
              y1={t.y}
              x2={W - padR}
              y2={t.y}
              className="trend-grid-line"
            />
            <text x={padL - 8} y={t.y + 3.5} textAnchor="end" className="trend-axis-text">
              {t.value >= 100 ? t.value.toFixed(0) : t.value.toFixed(1)}
            </text>
          </g>
        ))}

        {mode === 'area' ? (
          <>
            {areaPath && <path d={areaPath} fill={`url(#${gradId})`} />}
            {linePath && <path d={linePath} fill="none" className="trend-line" />}
            {points.map((pt, idx) => (
              <circle
                key={pt.date}
                cx={pt.x}
                cy={pt.y}
                r={hoverIdx === idx ? 5 : 3}
                className={`trend-dot${hoverIdx === idx ? ' active' : ''}`}
              />
            ))}
          </>
        ) : (
          points.map((pt, idx) => {
            const barH = Math.max(2, padT + plotH - pt.y)
            return (
              <rect
                key={pt.date}
                x={pt.x - barW / 2}
                y={pt.y}
                width={barW}
                height={barH}
                rx={4}
                className={`trend-bar${hoverIdx === idx ? ' active' : ''}`}
              />
            )
          })
        )}

        {activePt && (
          <line
            x1={activePt.x}
            y1={padT}
            x2={activePt.x}
            y2={padT + plotH}
            className="trend-cursor"
          />
        )}

        {points.map((pt, idx) => {
          const showLabel = idx === 0 || idx === count - 1 || idx % labelStep === 0
          return showLabel ? (
            <text
              key={`lbl-${pt.date}`}
              x={pt.x}
              y={H - 7}
              textAnchor="middle"
              className="trend-axis-text"
            >
              {pt.short_date}
            </text>
          ) : null
        })}

        {/* Transparent hit columns for smooth pointer hovering */}
        {points.map((pt, idx) => {
          const hitW = mode === 'bar' ? barSlot : Math.max(16, stepX)
          return (
            <rect
              key={`hit-${pt.date}`}
              x={Math.max(padL, pt.x - hitW / 2)}
              y={padT}
              width={hitW}
              height={plotH}
              fill="transparent"
              style={{ cursor: 'crosshair' }}
              onMouseEnter={() => setHoverIdx(idx)}
              onFocus={() => setHoverIdx(idx)}
            />
          )
        })}
      </svg>

      {activePt && (
        <div
          className="trend-tooltip"
          style={{
            left: `${Math.min(82, Math.max(16, (activePt.x / W) * 100))}%`,
          }}
        >
          <div className="trend-tooltip-date">{activePt.date}</div>
          <div className="trend-tooltip-row">
            <span>当日增量</span>
            <strong className="mono">{activePt.daily_gb.toFixed(2)} GB</strong>
          </div>
          <div className="trend-tooltip-row">
            <span>月累计</span>
            <strong className="mono">{activePt.cumulative_gb.toFixed(2)} GB</strong>
          </div>
        </div>
      )}
    </div>
  )
}
