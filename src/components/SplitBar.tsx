import { money } from '../lib/format'

/**
 * Two people's share of one bucket, as a single bar whose dividing line moves.
 *
 * A tick marks the halfway point, so which side of it the division sits on says
 * who has spent more without anyone doing arithmetic. It reports; it does not
 * judge — neither side is coloured as good or bad, and amber stays reserved for
 * the current target.
 */
export default function SplitBar({
  left,
  right,
}: {
  left: { label: string; amount: number }
  right: { label: string; amount: number }
}) {
  const l = Math.max(0, left.amount)
  const r = Math.max(0, right.amount)
  const total = l + r
  // An empty month sits on the midpoint rather than claiming a lopsided split.
  const share = total > 0 ? l / total : 0.5
  const pct = (n: number) => `${Math.round(n * 100)}%`

  return (
    <div
      role="img"
      aria-label={`${left.label} ${money(l)}, ${right.label} ${money(r)}`}
      style={{ marginTop: 10 }}
    >
      <div className="tnum tiny" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span>
          {left.label} <span className="muted">{money(l)}{total > 0 && ` · ${pct(share)}`}</span>
        </span>
        <span>
          <span className="muted">{total > 0 && `${pct(1 - share)} · `}{money(r)}</span> {right.label}
        </span>
      </div>
      <div className="split-bar">
        <span style={{ width: `${share * 100}%`, background: 'var(--neutral-tx)' }} />
        <span style={{ flex: 1, background: 'var(--steel)' }} />
        <i aria-hidden="true" />
      </div>
    </div>
  )
}
