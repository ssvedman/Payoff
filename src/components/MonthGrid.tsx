import type { DayCell } from '../lib/calendar'
import { isoDate, money, parseDateOnly } from '../lib/format'
import { eventsOf, shortLabel } from './CalendarText'

/**
 * The month as a real seven-column table. DESKTOP ONLY.
 *
 * Nothing renders this below 1024px and nothing should: a 7x5 grid at 376px
 * gives a cell about 46px wide, which is room for a day number and nothing else,
 * and a grid of day numbers is not a calendar. The phone gets the fortnight list
 * instead, which is different content rather than the same content shrunk.
 *
 * With a desktop column to work in a cell holds what it could never hold on a
 * phone: the payments due that day by name, expected income, and the running
 * projected balance. That is the whole reason the split exists.
 *
 * Colour, per the house rule:
 *   amber  — the current payoff target's payment day, and nothing else, ever.
 *   red    — any day the projection puts household checking below zero, which is
 *            a deviation in the strict sense the rest of the app uses, PLUS the
 *            day the line sits lowest, with the figure stated. The second one is
 *            the fact the page was built to surface: the accounts repeatedly ran
 *            to single digits before anyone noticed, and a month whose floor is
 *            $38 has no negative day to mark.
 *   green  — money arriving.
 * Everything else is ink or steel.
 *
 * Marking EVERY negative day rather than only the lowest one is deliberate. A
 * month can dip below zero on the 9th, recover, and dip further on the 23rd; if
 * only the deeper day were red the 9th would look like an ordinary day, which is
 * exactly the miss this page exists to prevent.
 */

/** Monday first, as the mockup draws it. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** 0 for Monday through 6 for Sunday, from JS's Sunday-first getDay(). */
const mondayIndex = (d: Date) => (d.getDay() + 6) % 7

interface Props {
  /** Every cell the model built for this month, in date order. */
  cells: DayCell[]
  /** The account the avalanche is attacking, or null while the plan loads. */
  targetId: string | null
  /** The date of the lowest projected balance in this month. */
  lowestDate: string | null
  selected: string | null
  onSelect: (date: string) => void
}

export default function MonthGrid({ cells, targetId, lowestDate, selected, onSelect }: Props) {
  const inMonth = cells.filter((c) => c.inMonth)
  if (inMonth.length === 0) return null

  /**
   * Re-grouped into Monday-first weeks.
   *
   * useCalendar() builds its grid Sunday-first, and it is not this component's
   * place to change the model — so the flat cells are re-chunked here instead.
   * The two windows do not line up: a month beginning on a Sunday gives the
   * model a window starting that Sunday while this one starts six days earlier,
   * so there can be up to six leading dates with no cell behind them (and up to
   * one trailing). A missing date renders as a blank out-of-month placeholder
   * rather than being skipped, because a week row with six cells in it would
   * shear the whole column alignment. Those days always belong to a neighbouring
   * month, so a blank is the truthful rendering anyway.
   */
  const byDate = new Map(cells.map((c) => [c.date, c]))
  const first = parseDateOnly(inMonth[0].date)
  const last = parseDateOnly(inMonth[inMonth.length - 1].date)
  const start = new Date(first)
  start.setDate(start.getDate() - mondayIndex(first))
  const end = new Date(last)
  end.setDate(end.getDate() + (6 - mondayIndex(last)))

  const weeks: DayCell[][] = []
  let week: DayCell[] = []
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = isoDate(d)
    week.push(
      byDate.get(iso) ?? {
        date: iso,
        day: d.getDate(),
        inMonth: false,
        isToday: false,
        due: [],
        expected: [],
        projected: null,
        negative: false,
      },
    )
    if (week.length === 7) {
      weeks.push(week)
      week = []
    }
  }
  if (week.length > 0) weeks.push(week)

  return (
    // tbl--plain because these headings are weekday names, not column labels:
    // .tbl th uppercases its content, and the mockup draws "Mon Tue Wed", while
    // "MON TUE WED" across seven columns reads as shouting.
    <table className="tbl tbl--plain" style={{ tableLayout: 'fixed' }}>
      <thead>
        <tr>
          {WEEKDAYS.map((d) => (
            <th key={d} scope="col">
              {d}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((w) => (
          <tr key={w[0].date}>
            {w.map((cell) => (
              <Cell
                key={cell.date}
                cell={cell}
                targetId={targetId}
                isLowest={cell.date === lowestDate}
                selected={selected === cell.date}
                onSelect={onSelect}
              />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Cell({
  cell,
  targetId,
  isLowest,
  selected,
  onSelect,
}: {
  cell: DayCell
  targetId: string | null
  isLowest: boolean
  selected: boolean
  onSelect: (date: string) => void
}) {
  const events = eventsOf(cell, targetId)
  const hasTarget = events.some((e) => e.isTarget)

  /**
   * Red means the projection goes BELOW ZERO, and nothing else.
   *
   * The lowest day of the month used to be red too. It is not a deviation: a
   * month whose floor is $38 is tight, and tight is an observation rather than
   * something having gone wrong. Painting it red spent the deviation colour on
   * a day the plan was being kept, and left nothing louder for the day it is
   * not. The lowest day is still marked, in bold ink with its figure stated.
   *
   * Red still outranks amber where both land on the same date. Both are true,
   * but only one is the fact this page exists to state, and the target's
   * payment is named in the cell either way.
   */
  const red = cell.inMonth && cell.negative
  const lowestPositive = cell.inMonth && isLowest && !cell.negative

  const background = !cell.inMonth
    ? 'transparent'
    : selected
      ? 'var(--neutral-bg)'
      : red
        ? 'var(--red-bg)'
        : hasTarget
          ? 'var(--amber-bg)'
          : 'transparent'

  const dayColour = !cell.inMonth
    ? 'var(--steel)'
    : red
      ? 'var(--red-tx)'
      : hasTarget
        ? 'var(--amber-tx)'
        : 'var(--ink)'

  // The lowest positive day carries weight rather than colour: ink, bolder
  // than its neighbours, with an outline so it is findable at a glance on a
  // grid where nothing else is tinted.
  const lowestOutline = lowestPositive ? '1.5px solid var(--steel)' : undefined

  const label = [
    cell.date,
    events.length > 0 ? `${events.length} item${events.length === 1 ? '' : 's'}` : '',
    cell.projected !== null ? `projected ${money(cell.projected)}` : '',
    // Said in words as well as in colour: a red background is invisible to a
    // screen reader, and below zero is the single most important thing a cell
    // on this grid can be.
    cell.negative ? 'projected below zero' : '',
    isLowest ? 'lowest projected balance this month' : '',
    hasTarget ? 'current target' : '',
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <td
      style={{
        background,
        padding: 0,
        verticalAlign: 'top',
        height: 78,
        // Today outranks the lowest-day marker where they coincide: which day
        // it is now is the more useful of the two, and the lowest day still
        // states its figure in bold beneath.
        outline: cell.isToday ? '2px solid var(--ink)' : lowestOutline ?? 'none',
        outlineOffset: '-2px',
      }}
    >
      <button
        type="button"
        onClick={() => onSelect(cell.date)}
        aria-label={label}
        aria-pressed={selected}
        title={events.map((e) => e.label).join(', ') || undefined}
        style={{
          // Not .btn: that is a full-width ink button with its own padding. This
          // is the whole cell made clickable so the day detail can open beneath.
          appearance: 'none',
          background: 'none',
          border: 'none',
          font: 'inherit',
          textAlign: 'left',
          width: '100%',
          height: '100%',
          // A table cell's height is a minimum rather than a size, so height:100%
          // on the button inside it can collapse to its content. The floor keeps
          // every cell clickable across its whole face.
          minHeight: 66,
          padding: '6px 7px',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          cursor: 'pointer',
          opacity: cell.inMonth ? 1 : 0.45,
        }}
      >
        <span
          className="tiny tnum"
          style={{ fontWeight: cell.isToday || cell.inMonth ? 700 : 500, color: dayColour }}
        >
          {cell.day}
        </span>

        {/* Three is what fits at 78px. A fourth would push the running balance
            out of the cell, and the balance is the one line that has to be on
            every day for the row to read as a line at all. */}
        {events.slice(0, 3).map((e) => (
          <EventLine key={e.key} event={e} />
        ))}
        {events.length > 3 && (
          <span className="tiny muted tnum">+{events.length - 3} more</span>
        )}

        <span style={{ flex: 1 }} />

        {cell.projected !== null && (
          <span
            className="tnum"
            style={{
              fontSize: 10.5,
              whiteSpace: 'nowrap',
              // Red only below zero. The lowest positive day is bold ink:
              // tight is worth finding, but it is not a deviation.
              color: red ? 'var(--red-tx)' : lowestPositive ? 'var(--ink)' : 'var(--steel)',
              fontWeight: red || lowestPositive ? 700 : 400,
            }}
          >
            {/* The lowest day says what the figure IS, because a bare number in a
                marked cell reads as an amount due rather than as what is left. */}
            {isLowest ? `bal ${money(cell.projected)}` : money(cell.projected)}
          </span>
        )}
      </button>
    </td>
  )
}

function EventLine({ event }: { event: ReturnType<typeof eventsOf>[number] }) {
  if (event.direction === 'in') {
    // Income carries its amount and not its name: the name is the payroll
    // descriptor, which is longer than the cell and less informative than the
    // figure. It is on the cell's title and in the fortnight list in full.
    return (
      <span className="tiny tnum" style={{ color: 'var(--green)', whiteSpace: 'nowrap' }}>
        +{money(event.amount ?? 0)}
      </span>
    )
  }

  return (
    <span
      className="tiny"
      style={{
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        color: event.isTarget ? 'var(--amber-tx)' : event.overdue ? 'var(--red-tx)' : 'var(--ink)',
        fontWeight: event.isTarget ? 700 : 400,
        opacity: event.outsideBalance ? 0.6 : 1,
      }}
    >
      {shortLabel(event.label)}{' '}
      <span className="tnum">
        {/* "Nothing known" must never render as "nothing due". */}
        {event.amount === null ? '?' : money(event.amount)}
      </span>
    </span>
  )
}
