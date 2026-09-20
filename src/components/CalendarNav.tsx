import type { CalendarMonth } from '../lib/calendar'
import { MONTH_NAMES } from '../lib/format'

/**
 * The month stepper for /calendar, sitting to the right of the page title.
 *
 * MonthNav from monthView.tsx is deliberately not reused. That one pages
 * BACKWARDS, from this month to the oldest recorded transaction, and disables
 * itself at "this month" — which is the exact opposite of what this page needs.
 * Here the floor is the current month, because there is no past balance line to
 * draw (checking snapshots only start 2026-09-15, so there is nothing to
 * back-test a projection against), and the ceiling is three months out, past
 * which a projection built from a 180-day window is arithmetic rather than
 * information.
 *
 * Both ends still say why they stop, in the button's title, rather than
 * presenting a dead control with no explanation.
 *
 * On a desktop the two neighbouring months are named — "‹ September · November ›"
 * — because there is room to say where the arrows go. On a phone there is not,
 * so they are bare chevrons.
 */
export default function CalendarNav({ month, wide }: { month: CalendarMonth; wide: boolean }) {
  const prev = MONTH_NAMES[(month.anchor.getMonth() + 11) % 12]
  const next = MONTH_NAMES[(month.anchor.getMonth() + 1) % 12]

  return (
    <div className="tiny muted" style={{ display: 'flex', alignItems: 'baseline', gap: 4, flex: '0 0 auto' }}>
      <Step
        label={wide ? `‹ ${prev}` : '‹'}
        aria="Previous month"
        disabled={month.atFloor}
        title={month.atFloor ? 'Nothing is projected before this month' : `Go to ${prev}`}
        onClick={month.goPrev}
      />
      {wide && <span aria-hidden="true">&nbsp;·&nbsp;</span>}
      <Step
        label={wide ? `${next} ›` : '›'}
        aria="Next month"
        disabled={month.atCeiling}
        title={month.atCeiling ? 'Three months is as far ahead as this projects' : `Go to ${next}`}
        onClick={month.goNext}
      />
    </div>
  )
}

function Step({
  label,
  aria,
  disabled,
  title,
  onClick,
}: {
  label: string
  aria: string
  disabled: boolean
  title: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={aria}
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        appearance: 'none',
        background: 'none',
        border: 'none',
        padding: '4px 2px',
        font: 'inherit',
        color: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.35 : 1,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}
