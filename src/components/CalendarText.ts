import type { DayCell } from '../lib/calendar'
import { parseDateOnly } from '../lib/format'

/**
 * The small pieces of wording /calendar's two layouts have in common.
 *
 * The month grid and the fortnight list are different content, not one layout at
 * two sizes — but they name the same events, and a day that reads "a store card"
 * in a cell and "Kay" in a row is the kind of drift that makes two views of one
 * month look like two different months. So the naming lives here, once.
 */

/** 1st, 2nd, 3rd, 4th … — for "lowest projected balance $38 on the 14th". */
export function ordinalDay(n: number): string {
  const s2 = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s2[(v - 20) % 10] ?? s2[v] ?? s2[0])
}

/** "Fri 25 Sep" — short enough for a list row. */
export function shortDay(iso: string): string {
  return parseDateOnly(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

/** "FRI" — the weekday above the date in the fortnight list's left column. */
export function weekdayCaps(iso: string): string {
  return parseDateOnly(iso).toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()
}

/**
 * An account label cut down to what a calendar cell can hold.
 *
 * accountLabel() renders "Joint · IRS 2025", which is right beside a balance and
 * far too long for a cell that is about 140px wide on a desktop grid. The owner
 * is the part that goes: on a grid of dated payments, WHICH debt is being paid
 * is the fact, and whose name is on it is already on the Accounts page. The full
 * label stays on the cell's title attribute, so nothing is actually lost.
 */
export function shortLabel(label: string, max = 14): string {
  const dot = label.lastIndexOf('·')
  const tail = dot >= 0 ? label.slice(dot + 1).trim() : label.trim()
  return tail.length > max ? `${tail.slice(0, max - 1)}…` : tail
}

/**
 * One thing happening on one day, however the model happened to derive it.
 *
 * A payment due (from a schedule, the issuer, or a typed-in due day) and an
 * expected flow (from six months of observed cadence) are different kinds of
 * claim, and the note on each row says which — but on the grid and in the list
 * they are both just money moving on a date, so they render through one shape.
 */
export interface CalendarEvent {
  key: string
  /** The full label, for the title attribute and for the fortnight row. */
  label: string
  /** Cut down to fit a grid cell. */
  short: string
  /** Magnitude in dollars. Null when a payment is owed but the amount is not known. */
  amount: number | null
  direction: 'in' | 'out'
  /** The current payoff target's payment — the only amber thing on this page. */
  isTarget: boolean
  /** Shown, but not counted in the running balance (savings, the PayPal wallet). */
  outsideBalance: boolean
  /** Late against its own cycle. */
  overdue: boolean
  /** The row's sub-line. Null when there is nothing worth adding. */
  note: string | null
}

/**
 * Everything on one day, payments due first and expected flows after.
 *
 * `targetId` is the account the avalanche is currently attacking. It is passed in
 * rather than read here because amber carries exactly one meaning in this app and
 * the page that owns the colour should be the page that decides where it lands.
 */
export function eventsOf(cell: DayCell, targetId: string | null): CalendarEvent[] {
  const out: CalendarEvent[] = []

  cell.due.forEach((p, i) => {
    const source =
      p.source === 'schedule'
        ? 'payment schedule'
        : p.source === 'issuer'
          ? 'due date from the issuer'
          : 'due day on record'
    out.push({
      key: `due-${p.accountId}-${i}`,
      label: p.label,
      short: shortLabel(p.label),
      amount: p.amount,
      direction: 'out',
      isTarget: targetId !== null && p.accountId === targetId,
      outsideBalance: false,
      overdue: false,
      note: p.rolledForward
        ? `${source} · rolled on a month, the stated cycle is already paid`
        : source,
    })
  })

  cell.expected.forEach((f, i) => {
    const marks: string[] = [f.accountLabel]
    if (!f.inBalance) marks.push('outside the checking total')
    // The asymmetry is stated on every row that carries it: late money in is
    // dropped from the running balance, late money out is still counted, because
    // neither half of that rule may be the one that flatters the position.
    if (f.overdue) marks.push(f.direction === 'in' ? 'late, not counted' : 'late, still counted')
    out.push({
      key: `flow-${f.seriesKey}-${i}`,
      label: f.label,
      short: shortLabel(f.label),
      amount: f.amount,
      direction: f.direction,
      isTarget: false,
      outsideBalance: !f.inBalance,
      overdue: f.overdue,
      note: marks.filter(Boolean).join(' · ') || null,
    })
  })

  return out
}

/** The cell with the lowest projected balance, or null when nothing is projected. */
export function lowestOf(cells: DayCell[]): DayCell | null {
  let best: DayCell | null = null
  for (const c of cells) {
    if (c.projected === null) continue
    if (best === null || c.projected < (best.projected as number)) best = c
  }
  return best
}
