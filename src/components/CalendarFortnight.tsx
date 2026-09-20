import type { CalendarMonth, DayCell } from '../lib/calendar'
import { isoDate, money, parseDateOnly, signedAmount } from '../lib/format'
import { eventsOf, lowestOf, ordinalDay, shortDay, weekdayCaps } from './CalendarText'

/**
 * The next fortnight as a list. MOBILE ONLY.
 *
 * A 7x5 grid on a phone is unreadable — 46px of width per cell is a day number
 * and nothing else — so the phone gets different content rather than the same
 * content shrunk. A list can say what the grid cannot at that size: the payee in
 * full, whether the money is coming or going, and the amount flush right where a
 * column of figures can actually be compared.
 *
 * Fourteen days rather than the month, because the reason to open this on a
 * phone is "what is about to happen", and a month of rows is a scroll nobody
 * finishes.
 */

/** How many days the list covers. */
const SPAN = 14

interface Props {
  /** Every cell the model built for the anchor month, in date order. */
  cells: DayCell[]
  month: CalendarMonth
  targetId: string | null
  /** The history query succeeded and came back empty — not the same as failing. */
  historyEmpty: boolean
  todayIso: string
}

interface ListRow {
  key: string
  date: string
  /** The date column only prints on the first row of each day. */
  leads: boolean
  label: string
  note: string | null
  /** Rendered flush right. */
  amount: string
  tone: 'plain' | 'in' | 'target' | 'lowest'
  /**
   * Only meaningful on a 'lowest' row: whether that day actually goes below
   * zero. Red is the deviation colour, and the lowest day of a month that
   * never dips is not a deviation, so the tone alone cannot decide the tint.
   */
  belowZero?: boolean
}

export default function CalendarFortnight({ cells, month, targetId, historyEmpty, todayIso }: Props) {
  const inMonth = cells.filter((c) => c.inMonth)
  if (inMonth.length === 0) return null

  /**
   * Where the fortnight starts.
   *
   * On the current month it starts TODAY — a list headed "next 14 days" that
   * opens on the 1st when it is the 20th is a list of things that already
   * happened. Stepping forward a month there is no "today" inside it, so it
   * starts at the 1st and the heading changes to say so.
   */
  const windowStart = month.thisMonth ? todayIso : inMonth[0].date

  const wanted = parseDateOnly(windowStart)
  wanted.setDate(wanted.getDate() + SPAN - 1)
  const wantedEnd = isoDate(wanted)

  /**
   * The model only builds cells for the month on screen plus the few days of
   * padding its grid needs, so a fortnight starting late in the month runs off
   * the end of what has been computed. The list stops where the data stops and
   * says so, rather than implying the remaining days are empty.
   */
  const lastAvailable = cells[cells.length - 1].date
  const windowEnd = wantedEnd <= lastAvailable ? wantedEnd : lastAvailable
  const clipped = windowEnd < wantedEnd

  const windowCells = cells.filter((c) => c.date >= windowStart && c.date <= windowEnd)
  const lowest = lowestOf(windowCells)

  /** The first money in after the tightest day, which is what the wait is for. */
  const nextInflowOn =
    lowest === null
      ? null
      : (cells.find(
          (c) =>
            c.date > lowest.date &&
            c.expected.some((f) => f.inBalance && f.direction === 'in' && !f.overdue),
        )?.date ?? null)

  const rows: ListRow[] = []
  for (const cell of windowCells) {
    const events = eventsOf(cell, targetId)
    const isLowest = lowest !== null && cell.date === lowest.date
    /**
     * Every day below zero gets its own row, not just the deepest one.
     *
     * A fortnight can dip below zero on the 9th, recover on payday, and dip
     * further on the 23rd. If only the deeper day were called out the 9th would
     * read as an ordinary day with a couple of bills on it, which is precisely
     * the miss this page was built to prevent.
     */
    const marked = isLowest || cell.negative
    if (events.length === 0 && !marked) continue

    let leads = true

    if (marked) {
      rows.push({
        key: `${cell.date}-low`,
        date: cell.date,
        leads,
        label: cell.negative
          ? 'Projected below zero'
          : 'Lowest projected balance',
        note: 'household checking, end of day',
        amount: money(cell.projected as number),
        tone: 'lowest',
        belowZero: cell.negative,
      })
      leads = false
    }

    for (const e of events) {
      rows.push({
        key: `${cell.date}-${e.key}`,
        date: cell.date,
        leads,
        label: e.label,
        note: e.isTarget ? 'current target' : e.note,
        amount:
          e.amount === null
            ? 'amount unknown'
            : signedAmount(e.direction === 'in' ? e.amount : -e.amount, money),
        tone: e.isTarget ? 'target' : e.direction === 'in' ? 'in' : 'plain',
      })
      leads = false
    }
  }

  return (
    <div>
      <div className="sm muted" style={{ marginBottom: 11 }}>
        {month.thisMonth ? `Next ${SPAN} days` : `${month.label.split(' ')[0]}, the first ${SPAN} days`}
      </div>

      {lowest !== null && (
        <Callout
          date={lowest.date}
          balance={lowest.projected as number}
          nextInflowOn={nextInflowOn}
        />
      )}

      {rows.length === 0 ? (
        <div className="sm muted">
          {historyEmpty
            ? 'No transaction history in the last 180 days, so no cadence could be derived.'
            : 'Nothing due and nothing expected in this window.'}
        </div>
      ) : (
        <div>
          {rows.map((r) => (
            <Row key={r.key} row={r} />
          ))}
        </div>
      )}

      {clipped && (
        <div className="rule">
          This list stops on <span className="tnum">{shortDay(windowEnd)}</span>, where the month on
          screen runs out. Step forward a month for what follows it.
        </div>
      )}
    </div>
  )
}

/**
 * The tightest day in the fortnight, stated at the top.
 *
 * Red ONLY when the projection goes below zero, which is a deviation. A low
 * but positive day is stated in ink instead: the accounts repeatedly ran to
 * single digits and the toll accounts went negative, which cost real money in
 * pay-by-plate rates and violation fees, so the tightest day is worth putting
 * above everything else either way. Tight is not the same as wrong, though,
 * and spending the deviation colour on a day the plan was kept leaves nothing
 * louder for the day it is not.
 *
 * It reports the position and stops. It does not suggest moving money.
 */
function Callout({
  date,
  balance,
  nextInflowOn,
}: {
  date: string
  balance: number
  nextInflowOn: string | null
}) {
  const below = balance < 0
  const day = parseDateOnly(date).getDate()

  return (
    <div
      className={below ? 'banner banner--red' : 'banner'}
      style={
        below
          ? { marginBottom: 12 }
          : {
              marginBottom: 12,
              background: 'var(--card)',
              border: '1px solid var(--line)',
            }
      }
    >
      <div className="sm" style={{ fontWeight: 700 }}>
        {below ? 'Below zero on the ' : 'Tightest on the '}
        <span className="tnum">{ordinalDay(day)}</span>
      </div>
      <div className="tiny">
        Projected balance <span className="tnum">{money(balance)}</span>
        {nextInflowOn ? (
          <>
            {' '}
            before the next money in on <span className="tnum">{shortDay(nextInflowOn)}</span>
          </>
        ) : (
          ', with no further money in expected inside the projected window'
        )}
      </div>
    </div>
  )
}

function Row({ row }: { row: ListRow }) {
  // 'lowest' is tinted neutral unless the day is actually below zero. Red is
  // the deviation colour and a positive floor is not a deviation; amber stays
  // the current target's row and nothing else.
  const belowZero = row.tone === 'lowest' && row.belowZero === true
  const tinted = row.tone === 'lowest' || row.tone === 'target'
  const ink = belowZero
    ? 'var(--red-tx)'
    : row.tone === 'target'
      ? 'var(--amber-tx)'
      : undefined

  return (
    <div
      className="row"
      style={
        tinted
          ? {
              alignItems: 'flex-start',
              background: belowZero
                ? 'var(--red-bg)'
                : row.tone === 'target'
                  ? 'var(--amber-bg)'
                  : 'var(--card)',
              // Bled past the page gutter so the tint reads as a band rather than
              // as a box floating inside the list.
              margin: '0 -6px',
              padding: '10px 6px',
              borderRadius: 5,
              borderBottom: 'none',
            }
          : { alignItems: 'flex-start' }
      }
    >
      <div style={{ width: 30, flex: '0 0 auto' }}>
        {row.leads && (
          <>
            <div className="tiny" style={{ fontWeight: 700, color: ink ?? 'var(--steel)' }}>
              {weekdayCaps(row.date)}
            </div>
            <div className="tnum" style={{ fontSize: 14, fontWeight: 800, color: ink }}>
              {parseDateOnly(row.date).getDate()}
            </div>
          </>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="sm"
          style={{
            fontWeight: tinted ? 700 : 600,
            color: ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {row.label}
        </div>
        {row.note && (
          <div className="tiny muted" style={{ color: ink ? ink : undefined }}>
            {row.note}
          </div>
        )}
      </div>

      <div
        className="tnum sm"
        style={{
          flex: '0 0 auto',
          textAlign: 'right',
          whiteSpace: 'nowrap',
          fontWeight: tinted || row.tone === 'in' ? 700 : 400,
          color: ink ?? (row.tone === 'in' ? 'var(--green)' : undefined),
        }}
      >
        {row.amount}
      </div>
    </div>
  )
}
