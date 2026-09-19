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

interface Slice {
  key: string
  label: string
  spent: number
  target: number
  color: string
}

/**
 * A bucket's spend by budget line, as a pie with its legend beside it.
 *
 * The legend is the table view: every slice's name, amount, share and target is
 * written out, so nothing depends on reading an angle or telling two colours
 * apart. A line past its target shows its amount in red there, the same
 * deviation signal the bars above use.
 */
export default function LinePie({
  lines,
  unassigned,
  catchAllName,
}: {
  /** In the budget's sort order. */
  lines: Line[]
  unassigned: number
  catchAllName: string
}) {
  const [hover, setHover] = useState<string | null>(null)

  const isCatchAll = (l: Line) => l.line_name.trim().toLowerCase() === catchAllName
  const named = lines.filter((l) => !isCatchAll(l))
  const catchAll = lines.find(isCatchAll)

  const slices: Slice[] = named.slice(0, SLICE_COLORS.length).map((l, i) => ({
    key: l.id,
    label: l.line_name,
    spent: l.spent,
    target: l.monthly_target,
    color: SLICE_COLORS[i],
  }))

  // Lines past the palette fold into the neutral slice rather than getting a
  // generated colour nobody could tell apart. The label says so.
  const overflow = named.slice(SLICE_COLORS.length)
  const restSpent =
    (catchAll?.spent ?? 0) + overflow.reduce((s, l) => s + l.spent, 0) + unassigned
  const restTarget =
    (catchAll?.monthly_target ?? 0) + overflow.reduce((s, l) => s + l.monthly_target, 0)
  if (catchAll || overflow.length || Math.abs(unassigned) >= 0.01) {
    slices.push({
      key: 'rest',
      label:
        (catchAll?.line_name ?? 'Unassigned') +
        (overflow.length ? ` + ${overflow.map((l) => l.line_name).join(', ')}` : ''),
      spent: restSpent,
      target: restTarget,
      color: REST_COLOR,
    })
  }

  // A refund can leave a line net negative for the month. It has no area to
  // draw, so it is left out of the pie but still listed with its figure.
  const drawn = slices.filter((s) => s.spent > 0)
  const total = drawn.reduce((s, x) => s + x.spent, 0)

  if (total <= 0) {
    return <div className="sm muted">Nothing discretionary this month.</div>
  }

  const R = 80
  const C = 84
  const arcs: { slice: Slice; d: string }[] = []
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
    arcs.push({ slice: s, d })
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
        {arcs.map(({ slice, d }) => (
          <path
            key={slice.key}
            d={d}
            fill={slice.color}
            // The 2px page-coloured seam keeps adjacent slices apart without
            // relying on their colours differing.
            stroke="var(--bg)"
            strokeWidth={2}
            strokeLinejoin="round"
            opacity={hover && hover !== slice.key ? 0.35 : 1}
            onMouseEnter={() => setHover(slice.key)}
            onMouseLeave={() => setHover(null)}
          >
            <title>{`${slice.label}: ${money(slice.spent)} (${share(slice.spent)})`}</title>
          </path>
        ))}
      </svg>

      <table className="line-pie-legend">
        <tbody>
          {slices.map((s) => {
            const over = s.target > 0 && s.spent > s.target
            return (
              <tr
                key={s.key}
                onMouseEnter={() => setHover(s.key)}
                onMouseLeave={() => setHover(null)}
                style={{ opacity: hover && hover !== s.key ? 0.5 : 1 }}
              >
                <td style={{ width: 16 }}>
                  <span className="line-pie-swatch" style={{ background: s.color }} />
                </td>
                <td className="sm">{s.label}</td>
                <td className="tnum sm" style={{ textAlign: 'right' }}>
                  <span style={over ? { color: 'var(--red)', fontWeight: 700 } : undefined}>
                    {money(s.spent)}
                  </span>
                  <span className="tiny muted"> {share(s.spent)}</span>
                </td>
                <td className="tnum tiny muted" style={{ textAlign: 'right', width: 54 }}>
                  {s.target > 0 ? `of ${money(s.target)}` : ''}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
