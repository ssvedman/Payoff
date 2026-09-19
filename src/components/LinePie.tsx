import { useState } from 'react'
import { money } from '../lib/format'

interface Line {
  id: string
  line_name: string
  monthly_target: number
  spent: number
}

/**
 * Categorical slice colours, in fixed order, assigned by a line's place in the
 * budget's own sort order — never by how much it has spent, so a line keeps its
 * colour from one day to the next as the ranking shifts.
 *
 * Amber, green and red are not here: on this app they already mean the current
 * target, on plan, and off plan, and a slice wearing one would say something it
 * does not mean. These five pass the palette validator against --bg with every
 * pair compared, since in a pie any slice can sit beside any other. Orange and
 * aqua fall under 3:1 against the page, which is why every slice is also named
 * in the legend with its amount.
 */
const SLICE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#4a3aa7', '#c2185b']

/** The catch-all, and any line beyond the palette, share the app's neutral. */
const REST_COLOR = 'var(--steel)'
const REST_KEY = 'rest'

interface Row {
  key: string
  label: string
  spent: number
  target: number
  color: string
  /** Which slice of the pie this row is drawn in — its own, or the shared grey one. */
  slice: string
}

/**
 * A bucket's spend by budget line, as a pie with its legend beside it.
 *
 * The legend is the table view and lists every line on its own row, including
 * the ones that share the grey slice — so nothing depends on reading an angle or
 * telling two colours apart, and folding a line into grey never hides its
 * figure. A line past its target shows its amount in red, the same deviation
 * signal used elsewhere on the page.
 */
export default function LinePie({
  lines,
  unassigned,
  unassignedNote,
  catchAllName,
  emptyNote,
}: {
  /** In the budget's sort order. */
  lines: Line[]
  unassigned: number
  unassignedNote: string
  /** Lowercased name of the bucket's catch-all line, if it has one. */
  catchAllName?: string
  emptyNote: string
}) {
  const [hover, setHover] = useState<string | null>(null)

  const isCatchAll = (l: Line) =>
    catchAllName !== undefined && l.line_name.trim().toLowerCase() === catchAllName
  const named = lines.filter((l) => !isCatchAll(l))

  // Lines past the palette share the neutral slice rather than getting a
  // generated colour nobody could tell apart.
  const rows: Row[] = named.map((l, i) => {
    const color = SLICE_COLORS[i] ?? REST_COLOR
    return {
      key: l.id,
      label: l.line_name,
      spent: l.spent,
      target: l.monthly_target,
      color,
      slice: i < SLICE_COLORS.length ? l.id : REST_KEY,
    }
  })
  for (const l of lines.filter(isCatchAll)) {
    rows.push({ key: l.id, label: l.line_name, spent: l.spent, target: l.monthly_target, color: REST_COLOR, slice: REST_KEY })
  }
  if (Math.abs(unassigned) >= 0.01) {
    rows.push({ key: 'unassigned', label: unassignedNote, spent: unassigned, target: 0, color: REST_COLOR, slice: REST_KEY })
  }

  // A refund can leave a line net negative for the month. It has no area to
  // draw, so it is left out of the pie but still listed with its figure.
  const sliceSpend = new Map<string, number>()
  for (const r of rows) {
    if (r.spent > 0) sliceSpend.set(r.slice, (sliceSpend.get(r.slice) ?? 0) + r.spent)
  }
  // Coloured slices in budget order, grey last so it closes the circle.
  const drawn = [...sliceSpend.entries()]
    .sort(([a], [b]) => (a === REST_KEY ? 1 : 0) - (b === REST_KEY ? 1 : 0))
    .map(([key, spent]) => ({
      key,
      spent,
      color: key === REST_KEY ? REST_COLOR : rows.find((r) => r.key === key)!.color,
      label:
        key === REST_KEY
          ? rows.filter((r) => r.slice === REST_KEY && r.spent > 0).map((r) => r.label).join(', ')
          : rows.find((r) => r.key === key)!.label,
    }))
  const total = drawn.reduce((s, x) => s + x.spent, 0)

  if (total <= 0) {
    return <div className="sm muted">{emptyNote}</div>
  }

  const R = 80
  const C = 84
  const arcs: { key: string; label: string; spent: number; color: string; d: string }[] = []
  let angle = -Math.PI / 2
  for (const s of drawn) {
    const sweep = (s.spent / total) * Math.PI * 2
    const end = angle + sweep
    const d =
      drawn.length === 1
        ? // A single slice is a full circle; an arc from a point to itself draws nothing.
          `M ${C} ${C - R} A ${R} ${R} 0 1 1 ${C - 0.01} ${C - R} Z`
        : `M ${C} ${C} L ${C + R * Math.cos(angle)} ${C + R * Math.sin(angle)} A ${R} ${R} 0 ${
            sweep > Math.PI ? 1 : 0
          } 1 ${C + R * Math.cos(end)} ${C + R * Math.sin(end)} Z`
    arcs.push({ ...s, d })
    angle = end
  }

  const share = (n: number) => `${Math.round((Math.max(0, n) / total) * 100)}%`

  return (
    <div className="line-pie">
      <svg
        viewBox={`0 0 ${C * 2} ${C * 2}`}
        width={C * 2}
        height={C * 2}
        role="img"
        aria-label={drawn.map((s) => `${s.label} ${money(s.spent)}`).join(', ')}
      >
        {arcs.map((a) => (
          <path
            key={a.key}
            d={a.d}
            fill={a.color}
            // The 2px page-coloured seam keeps adjacent slices apart without
            // relying on their colours differing.
            stroke="var(--bg)"
            strokeWidth={2}
            strokeLinejoin="round"
            opacity={hover && hover !== a.key ? 0.35 : 1}
            onMouseEnter={() => setHover(a.key)}
            onMouseLeave={() => setHover(null)}
          >
            <title>{`${a.label}: ${money(a.spent)} (${share(a.spent)})`}</title>
          </path>
        ))}
      </svg>

      <table className="line-pie-legend">
        <tbody>
          {rows.map((r) => {
            const over = r.target > 0 && r.spent > r.target
            return (
              <tr
                key={r.key}
                onMouseEnter={() => setHover(r.slice)}
                onMouseLeave={() => setHover(null)}
                style={{ opacity: hover && hover !== r.slice ? 0.5 : 1 }}
              >
                <td style={{ width: 16 }}>
                  <span className="line-pie-swatch" style={{ background: r.color }} />
                </td>
                <td className="sm">{r.label}</td>
                <td className="tnum sm" style={{ textAlign: 'right' }}>
                  <span style={over ? { color: 'var(--red)', fontWeight: 700 } : undefined}>
                    {money(r.spent)}
                  </span>
                  <span className="tiny muted"> {share(r.spent)}</span>
                </td>
                <td className="tnum tiny muted" style={{ textAlign: 'right', width: 54 }}>
                  {r.target > 0 ? `of ${money(r.target)}` : ''}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
