import { useEffect, useId, useMemo, useState } from 'react'

/**
 * A single-series trend line with an area fill, hover crosshair and tooltip.
 *
 * One series per chart, deliberately. Total owed sits around six figures and
 * savings around two — plotting both on one pair of axes would invent a
 * relationship that is not in the data, so they get separate charts rather than a
 * second y-scale.
 *
 * Because there is only ever one series here, color is not carrying identity: the
 * caller passes a single stroke. Amber is never used — it means the current target
 * and nothing else.
 */

export interface TrendPoint {
  /** ISO date of the week start. */
  date: string
  value: number
}

interface Props {
  points: TrendPoint[]
  /** Stroke color. Never amber. */
  color: string
  /** Formats a value for the tooltip and the end label. */
  format: (n: number) => string
  /** Describes the series for screen readers, since there is no legend. */
  label: string
  height?: number
  /** Lower bound. Money charts read better from zero; omit to fit the data. */
  baseline?: 'zero' | 'fit'
}

const PAD = { top: 14, right: 14, bottom: 22, left: 14 }

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function TrendChart({
  points,
  color,
  format,
  label,
  height = 132,
  baseline = 'fit',
}: Props) {
  const gradientId = useId()
  /**
   * The wrapper as an element in state, not a ref: when the series arrives late
   * the component's first render returns the "no history" line, which has no
   * wrapper at all. A ref would have been read as null once, on a mount that
   * rendered nothing to measure, and never looked at again.
   */
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<number | null>(null)

  /**
   * The drawing width is MEASURED, never assumed.
   *
   * viewBox="0 0 320 H" with width="100%" and the default preserveAspectRatio
   * scales by min(available / 320, availableHeight / H). The height attribute
   * pins the second term at 1, so in any column wider than 320px the chart drew
   * at its native 320 and sat centred in several hundred pixels of dead space —
   * and the pointer handler, which maps clientX across the rendered rect, then
   * reported the wrong month under the cursor.
   *
   * preserveAspectRatio="none" would fill the box, at the cost of horizontally
   * smearing every stroke and every label. Matching the viewBox to the real
   * width keeps the scale at exactly 1:1 instead.
   */
  const [W, setW] = useState(320)

  useEffect(() => {
    if (!wrap) return
    const apply = (w: number) => {
      if (w > 0) setW(Math.round(w))
    }
    apply(wrap.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) apply(e.contentRect.width)
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [wrap])

  const H = height
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom

  const geom = useMemo(() => {
    if (points.length === 0) return null

    const values = points.map((p) => p.value)
    const rawMin = baseline === 'zero' ? 0 : Math.min(...values)
    const rawMax = Math.max(...values)

    // A flat series would divide by zero and draw a line along the top edge.
    // Give it a band so it renders as what it is: unchanged.
    const span = rawMax - rawMin
    const min = span === 0 ? rawMin - Math.max(1, Math.abs(rawMin) * 0.02) : rawMin
    const max = span === 0 ? rawMax + Math.max(1, Math.abs(rawMax) * 0.02) : rawMax

    const x = (i: number) =>
      points.length === 1
        ? PAD.left + innerW / 2
        : PAD.left + (i / (points.length - 1)) * innerW
    const y = (v: number) => PAD.top + innerH - ((v - min) / (max - min)) * innerH

    const coords = points.map((p, i) => ({ x: x(i), y: y(p.value), ...p }))
    const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x},${c.y}`).join(' ')
    const area = `${line} L${coords[coords.length - 1].x},${PAD.top + innerH} L${coords[0].x},${PAD.top + innerH} Z`

    return { coords, line, area, min, max }
  }, [points, baseline, innerW, innerH])

  if (!geom) {
    return (
      <div className="sm muted" style={{ padding: '18px 0' }}>
        No history yet.
      </div>
    )
  }

  const { coords, line, area } = geom
  const last = coords[coords.length - 1]
  const active = hover === null ? null : coords[hover]

  function onMove(e: React.PointerEvent) {
    const el = wrap
    if (!el || coords.length === 0) return
    const rect = el.getBoundingClientRect()
    // Map the pointer into viewBox space, then to the nearest point. The hit
    // target is the whole column, far larger than the 8px marker.
    const vx = ((e.clientX - rect.left) / rect.width) * W
    let nearest = 0
    let best = Infinity
    coords.forEach((c, i) => {
      const d = Math.abs(c.x - vx)
      if (d < best) {
        best = d
        nearest = i
      }
    })
    setHover(nearest)
  }

  return (
    <div ref={setWrap} style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={`${label}. ${points.length} weekly readings, latest ${format(last.value)}.`}
        style={{ display: 'block', touchAction: 'pan-y' }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.16" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Hairline baseline only — no gridlines competing with the data, never dashed. */}
        <line
          x1={PAD.left}
          y1={PAD.top + innerH}
          x2={W - PAD.right}
          y2={PAD.top + innerH}
          stroke="var(--line)"
          strokeWidth="1"
        />

        {coords.length > 1 && <path d={area} fill={`url(#${gradientId})`} />}

        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Crosshair on hover. */}
        {active && (
          <line
            x1={active.x}
            y1={PAD.top}
            x2={active.x}
            y2={PAD.top + innerH}
            stroke="var(--steel)"
            strokeWidth="1"
            opacity="0.5"
          />
        )}

        {/* The latest reading is always marked and labelled; intermediate points
            are not, so the chart never becomes a wall of numbers. */}
        <circle cx={last.x} cy={last.y} r="4" fill={color} stroke="var(--white)" strokeWidth="2" />

        {active && active !== last && (
          <circle
            cx={active.x}
            cy={active.y}
            r="4"
            fill={color}
            stroke="var(--white)"
            strokeWidth="2"
          />
        )}

        <text
          x={PAD.left}
          y={H - 6}
          className="tnum"
          fontSize="10"
          fill="var(--steel)"
          fontFamily="inherit"
        >
          {shortDate(coords[0].date)}
        </text>
        {coords.length > 1 && (
          <text
            x={W - PAD.right}
            y={H - 6}
            className="tnum"
            fontSize="10"
            fill="var(--steel)"
            textAnchor="end"
            fontFamily="inherit"
          >
            {shortDate(last.date)}
          </text>
        )}
      </svg>

      {active && (
        <div
          role="status"
          className="tiny"
          style={{
            position: 'absolute',
            top: 0,
            left: `${Math.min(Math.max((active.x / W) * 100, 12), 88)}%`,
            transform: 'translateX(-50%)',
            background: 'var(--ink)',
            color: '#fff',
            padding: '4px 8px',
            borderRadius: 'var(--r-control)',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          <span className="tnum">{format(active.value)}</span>
          <span style={{ opacity: 0.7 }}> · {shortDate(active.date)}</span>
        </div>
      )}
    </div>
  )
}
