import type { CalendarMonth } from '../lib/calendar'

/**
 * The ‹ October 2026 › control for /calendar.
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
 * Both ends say why they stop, in the button's title, rather than presenting a
 * dead control with no explanation.
 */
export default function CalendarNav({ month }: { month: CalendarMonth }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        marginBottom: 12,
        borderBottom: '1px solid var(--line)',
        paddingBottom: 10,
      }}
    >
      <button
        type="button"
        className="btn ghost"
        style={{ width: 'auto', padding: '6px 12px', fontSize: 13, opacity: month.atFloor ? 0.35 : 1 }}
        aria-label="Previous month"
        title={month.atFloor ? 'Nothing is projected before this month' : 'Previous month'}
        disabled={month.atFloor}
        onClick={month.goPrev}
      >
        ‹
      </button>

      <div style={{ textAlign: 'center', lineHeight: 1.25 }}>
        <div className="sm tnum" style={{ fontWeight: 700 }}>
          {month.label}
        </div>
        {!month.thisMonth && (
          <div className="tiny muted">projected</div>
        )}
      </div>

      <button
        type="button"
        className="btn ghost"
        style={{ width: 'auto', padding: '6px 12px', fontSize: 13, opacity: month.atCeiling ? 0.35 : 1 }}
        aria-label="Next month"
        title={month.atCeiling ? 'Three months is as far ahead as this projects' : 'Next month'}
        disabled={month.atCeiling}
        onClick={month.goNext}
      >
        ›
      </button>
    </div>
  )
}
