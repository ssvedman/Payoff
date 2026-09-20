import type { DayCell } from '../lib/calendar'
import { money } from '../lib/format'

/**
 * The month as a seven-column grid.
 *
 * At 376px a cell is about 46px wide, which is room for a day number, a marker
 * and one short figure — and nothing else. So the grid carries the SHAPE of the
 * month (which days have money moving, and where the running balance sits) and
 * the detail lives in the list beneath it, where a full account name fits. A cell
 * that tried to hold "Owner · Card $214.00" would truncate it into
 * something unreadable, and a truncated account name on a payment grid is worse
 * than no name at all.
 *
 * Colour, per the house rule: amber is the current payoff target and appears
 * nowhere on this page. Red is a deviation — here, a day the projection puts
 * household checking below zero, which is the fact this page was built to
 * surface. Everything else is ink or steel.
 */

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

interface Props {
  weeks: DayCell[][]
  selected: string | null
  onSelect: (date: string) => void
}

export default function MonthGrid({ weeks, selected, onSelect }: Props) {
  return (
    <div>
      <div
        className="caps"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', textAlign: 'center', marginBottom: 4 }}
      >
        {WEEKDAYS.map((d, i) => (
          <div key={i} aria-hidden="true">
            {d}
          </div>
        ))}
      </div>

      <div
        role="grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 1,
          background: 'var(--line)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-card)',
          overflow: 'hidden',
        }}
      >
        {weeks.flat().map((cell) => (
          <Cell key={cell.date} cell={cell} selected={selected === cell.date} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}

function Cell({
  cell,
  selected,
  onSelect,
}: {
  cell: DayCell
  selected: boolean
  onSelect: (date: string) => void
}) {
  const hasDue = cell.due.length > 0
  const hasIn = cell.expected.some((e) => e.direction === 'in')
  const hasOut = cell.expected.some((e) => e.direction === 'out')
  const anything = hasDue || hasIn || hasOut

  return (
    <button
      type="button"
      role="gridcell"
      onClick={() => onSelect(cell.date)}
      aria-label={`${cell.date}${anything ? ', has activity' : ''}${cell.negative ? ', projected below zero' : ''}`}
      aria-pressed={selected}
      style={{
        // Not .btn: this is a grid cell, and .btn is full-width with its own
        // padding and border radius.
        appearance: 'none',
        border: 'none',
        font: 'inherit',
        textAlign: 'left',
        cursor: anything || cell.projected !== null ? 'pointer' : 'default',
        padding: '5px 5px 4px',
        minHeight: 60,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: 2,
        background: selected
          ? 'var(--neutral-bg)'
          : cell.negative
            ? 'var(--red-bg)'
            : cell.inMonth
              ? 'var(--white)'
              : 'var(--card)',
        opacity: cell.inMonth ? 1 : 0.55,
        outline: cell.isToday ? '2px solid var(--ink)' : 'none',
        outlineOffset: '-2px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
        <span
          className="tiny tnum"
          style={{ fontWeight: cell.isToday ? 700 : 500, color: cell.inMonth ? 'var(--ink)' : 'var(--steel)' }}
        >
          {cell.day}
        </span>
        <span className="tiny" aria-hidden="true" style={{ letterSpacing: '-0.5px', lineHeight: 1 }}>
          {hasIn && <span style={{ color: 'var(--ink)' }}>▲</span>}
          {(hasOut || hasDue) && <span style={{ color: 'var(--steel)' }}>▼</span>}
        </span>
      </div>

      {/* The running figure, whole dollars — cents do not fit and do not help at
          this size. The list below carries them to the penny. */}
      {cell.projected !== null && (
        <span
          className="tiny tnum"
          style={{
            color: cell.negative ? 'var(--red-tx)' : 'var(--steel)',
            fontWeight: cell.negative ? 700 : 400,
            whiteSpace: 'nowrap',
          }}
        >
          {money(cell.projected)}
        </span>
      )}
    </button>
  )
}
