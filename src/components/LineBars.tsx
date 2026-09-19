import { money } from '../lib/format'

interface Line {
  id: string
  line_name: string
  monthly_target: number
  spent: number
}

/**
 * Where a bucket's money went, one bar per budget line, largest first.
 *
 * Every bar shares one scale — the largest of any line's spend or target — so
 * lengths compare across lines, not just against each line's own target. The
 * tick is that line's target. A bar is red only once its line has passed its
 * target, which is a deviation that has already happened; everything else is
 * steel. Amounts are written out beside each bar, so nothing is carried by
 * colour or length alone.
 */
export default function LineBars({
  lines,
  unassigned,
  unassignedNote,
}: {
  lines: Line[]
  unassigned: number
  unassignedNote: string
}) {
  if (lines.length === 0) {
    return <div className="sm muted">No budget lines here.</div>
  }

  const rows = [...lines].sort((a, b) => b.spent - a.spent || b.monthly_target - a.monthly_target)
  const scale = Math.max(1, ...rows.map((l) => Math.max(l.spent, l.monthly_target)), unassigned)
  const pct = (n: number) => `${(Math.max(0, n) / scale) * 100}%`

  return (
    <div>
      {rows.map((l) => {
        const over = l.spent > l.monthly_target
        return (
          <div
            key={l.id}
            className="line-bar"
            title={`${l.line_name}: ${money(l.spent)} of ${money(l.monthly_target)}`}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span className="sm">{l.line_name}</span>
              <span className="tnum sm">
                <span style={over ? { color: 'var(--red)', fontWeight: 700 } : undefined}>{money(l.spent)}</span>
                <span className="tiny muted"> of {money(l.monthly_target)}</span>
              </span>
            </div>
            <div className="line-bar-track">
              <span style={{ width: pct(l.spent), background: over ? 'var(--red)' : 'var(--steel)' }} />
              {l.monthly_target > 0 && <i aria-hidden="true" style={{ left: pct(l.monthly_target) }} />}
            </div>
          </div>
        )
      })}
      {Math.abs(unassigned) >= 0.01 && (
        <div className="line-bar">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="sm muted">{unassignedNote}</span>
            <span className="tnum sm muted">{money(unassigned)}</span>
          </div>
          <div className="line-bar-track">
            <span style={{ width: pct(unassigned), background: 'var(--line)' }} />
          </div>
        </div>
      )}
    </div>
  )
}
