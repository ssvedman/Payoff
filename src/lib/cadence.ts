/**
 * Working out, from history alone, when money is next expected to arrive or leave.
 *
 * This file is PURE on purpose: no supabase, no React, no reading the clock. The
 * caller passes rows and a `today`, and gets series back. That is what makes it
 * testable, and this is the one piece of the calendar where being subtly wrong is
 * expensive — a phantom inflow hides exactly the shortfall the page exists to find.
 *
 * Every threshold here is a guard against a specific way this went wrong on the
 * live data. They are written out as named constants rather than inlined so that
 * changing one is a deliberate act.
 */

import { isoDate, parseDateOnly } from './format'

/** How far back we look. Six months of a bi-weekly payroll is thirteen events. */
export const WINDOW_DAYS = 180

/**
 * Three events give two gaps, which is the least that can describe a cadence at
 * all. "Monthly Interest Paid" has exactly three (6/30, 7/31, 8/31) and is a real
 * monthly series, so the floor cannot be four.
 */
const MIN_EVENTS = 3

/**
 * How far the gaps may scatter around the median before we refuse to project.
 *
 * MAD, not standard deviation, and median, not mean. Payroll gaps here run
 * 14,14,14,14,14,13,14,15,14,14,14,14 — holiday shifts either side of a fortnight.
 * The mean of those with one cycle missed drifts to ~15.2 and fails any equality
 * test; the median is 14 and the MAD is 0, which absorbs both.
 */
const MAX_MAD_RATIO = 0.15

/**
 * At least this share of the per-cycle gaps must land within ON_BEAT of the
 * median for the series to count as a cadence.
 *
 * This is the guard that stops the business draw being projected. That series is
 * ~27 deposit days in 180 with gaps from 1 to 18 days; its median gap is about 3
 * and only ~42% of its gaps are anywhere near it. Projecting it at a ~3.5-day
 * median invents roughly $4,000 a month of inflow that is not a cadence at all —
 * which is more than enough to paper over every negative day on the grid. MAD
 * alone rejects it too, but only just, and "just" is not a margin worth trusting
 * on the one number that could hide a bounced payment.
 */
const MIN_ON_BEAT = 0.6
const ON_BEAT = 0.15

/**
 * A gap that is close to k times the median is treated as k−1 MISSED cycles, so
 * one skipped payroll does not reclassify a rock-solid fortnightly series as
 * irregular and delete it from the calendar.
 *
 * The repair is capped: if more than a quarter of the implied cycles have to be
 * invented to make the series look regular, the series is not regular. Without
 * this cap, splitting is a laundry — enough multiples of a small median will make
 * almost any scatter of deposits look like a metronome.
 */
const MULTIPLE_TOLERANCE = 0.15
const MAX_MISSED_SHARE = 0.25

/** Last event more than this many medians ago: the stream is late. */
const OVERDUE_FACTOR = 1.5

/**
 * Late enough that we stop projecting it forward at all. A series that ended must
 * age out; one that is merely late must still be reported, loudly, because a
 * missed payroll is the single most important thing this page could say.
 */
const STOPPED_FACTOR = 3
const STOPPED_MIN_DAYS = 30

/** Long enough to tell two employers apart, short enough to survive truncation. */
const DESCRIPTOR_MAX = 40
const LABEL_MAX = 44

const DAY_MS = 86_400_000

/** What detectSeries() needs from a transaction row. Deliberately structural. */
export interface CadenceEvent {
  account_id: string
  /** NULL for the largest income stream here — see normaliseDescriptor(). */
  merchant_name: string | null
  name: string
  /** Plaid's sign: POSITIVE is money OUT. Never flipped in storage. */
  amount: number
  /** A date-only column, YYYY-MM-DD. */
  posted_on: string
  pending: boolean
}

export type CadenceKind =
  | 'weekly'
  | 'fortnightly'
  | 'monthly'
  | 'every-n-days'
  /** Regular enough to name, not regular enough to put a date on. */
  | 'irregular'
  | 'once'

export type Direction = 'in' | 'out'

export interface SeriesEvent {
  /** YYYY-MM-DD. */
  date: string
  /** Magnitude, always positive. Direction is carried by the series. */
  amount: number
}

export interface Series {
  /** account_id | descriptor | direction. Stable across reloads. */
  key: string
  accountId: string
  direction: Direction
  /** What to call it on screen, cleaned of trace numbers. */
  label: string
  /** The normalised grouping key, kept for debugging a mis-grouped series. */
  descriptor: string
  /** One entry per DAY, same-day rows summed. See detectSeries(). */
  events: SeriesEvent[]
  firstOn: string
  lastOn: string
  daysSinceLast: number
  /** Median magnitude — never the mean; one bonus cheque should not move it. */
  medianAmount: number
  /** Median days between events, after missed cycles are repaired. Null if < 2 gaps. */
  medianGap: number | null
  madGap: number | null
  /** Share of per-cycle gaps landing within 15% of the median. */
  onBeat: number
  /** Cycles inferred to have been skipped. */
  missedCycles: number
  kind: CadenceKind
  /** Modal day of month. Monthly series only; may be 29–31. */
  dayOfMonth: number | null
  /** The next expected date, or null when we will not put a date on it. */
  nextOn: string | null
  overdue: boolean
  stopped: boolean
  /** Why there is no projected date, in plain words. Null when there is one. */
  note: string | null
}

/* ------------------------------------------------------------------ *
 * Descriptor normalisation
 * ------------------------------------------------------------------ */

/**
 * The ACH field markers a bank crams into one descriptor line. Everything after
 * the first of these is machine detail, not the name of who paid.
 */
const ACH_FIELD =
  /\b(?:co entry descr|entry descr|desc date|sec|ind id|ind name|orig id|disc|trace#|trn)\s*:/i

/**
 * Strip the parts of a descriptor that change on every single payment.
 *
 * This is the whole reason cadence detection works at all. ACH descriptors carry
 * DESC DATE, TRACE#, IND ID and TRN, so they are unique per payment: grouping on
 * the raw name gives n=1 for every deposit, every series classifies as "seen
 * once", and the calendar comes out empty while the data plainly contains a
 * fortnightly payroll.
 *
 * Case is preserved so the same function can clean a descriptor for DISPLAY.
 */
export function stripIds(s: string): string {
  return (
    s
      // "transaction#: 28520633992"
      .replace(/\btransaction\s*#\s*:?\s*\d+/gi, ' ')
      .replace(/\btrace\s*#\s*:?\s*\S+/gi, ' ')
      // "PPD ID: 3351604308", "ORIG ID:7010532275", "IND ID:2576857"
      .replace(/\b(?:ppd|ccd|web|tel|arc|ind|orig|batch)\s*id\s*:?\s*\S+/gi, ' ')
      // "REF: 260605…", "TRN: 2314423156GB", "IID: 2026…", "BREF: bb66cdc2-…"
      .replace(/\b(?:ref|trn|iid|bref|id)\s*:\s*\S+/gi, ' ')
      // "(...9677)" — the BNPL deposits' per-order suffix.
      .replace(/\(\s*\.{2,}\s*\d+\s*\)/g, ' ')
      // A trailing posting date: "ORLANDO FL 08/19".
      .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
      // Mixed letter-and-digit confirmation ids: "WFCT0ZYXZ6JL", "8N6EA3X43".
      .replace(/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{6,}\b/g, ' ')
      // Bare long numbers. Five digits, not four: the masked source account on
      // "Online Transfer from CHK ...0000" is four and is part of the identity —
      // money from the business checking is not the same series as money from
      // savings, and merging them would average two unrelated cadences.
      .replace(/\b\d{5,}\b/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/[\s,\-–—:;.*]+$/, '')
      .trim()
  )
}

/**
 * The grouping token for one descriptor.
 *
 * merchant_name is NULL for the biggest income stream in this household — "Lennar
 * Homes Payroll" lives entirely in transactions.name — so a key built on
 * merchant_name alone silently drops the largest thing on the calendar.
 */
export function normaliseDescriptor(name: string): string {
  const lower = name.toLowerCase().trim()

  // "ORIG CO NAME:ACMECO PMD CO ENTRY DESCR:PAYMENT SEC:CCD IND ID:…" — the
  // originator's name is the only stable part, and it sits between that marker
  // and the next field.
  const orig = /orig\s*co\s*name\s*:\s*(.*)$/i.exec(lower)
  if (orig) {
    let tail = orig[1]
    const cut = tail.search(ACH_FIELD)
    if (cut > 0) tail = tail.slice(0, cut)
    const cleaned = stripIds(tail)
    if (cleaned) return cleaned.slice(0, DESCRIPTOR_MAX)
  }

  return stripIds(lower).slice(0, DESCRIPTOR_MAX)
}

/* ------------------------------------------------------------------ *
 * Robust statistics
 * ------------------------------------------------------------------ */

/** Median of a non-empty list. Returns NaN for an empty one, which callers guard. */
export function median(xs: number[]): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Median absolute deviation from the median. Zero for a perfectly even series. */
export function mad(xs: number[], centre: number): number {
  if (xs.length === 0) return NaN
  return median(xs.map((x) => Math.abs(x - centre)))
}

/** Whole days between two date-only strings, positive when b is later. */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDateOnly(b).getTime() - parseDateOnly(a).getTime()) / DAY_MS)
}

/**
 * Turn raw gaps into PER-CYCLE gaps, treating a gap close to k medians as k−1
 * missed observations.
 *
 * The repaired gap contributes ONE observation of g/k, not k copies of the
 * median. Inserting k copies of the median is what an earlier version did, and it
 * drove the MAD to exactly zero for any series with a few multiples in it — the
 * synthetic values outvoted the real ones and a scatter of ad-hoc Zelle transfers
 * came out looking like clockwork.
 */
export function perCycleGaps(gaps: number[], m: number): { cycles: number[]; missed: number } {
  const cycles: number[] = []
  let missed = 0
  for (const g of gaps) {
    const k = Math.round(g / m)
    if (k >= 2 && Math.abs(g - k * m) <= MULTIPLE_TOLERANCE * k * m) {
      cycles.push(g / k)
      missed += k - 1
    } else {
      cycles.push(g)
    }
  }
  return { cycles, missed }
}

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

/** Modal value, ties broken by the larger — 30,31,31 is a month-end series. */
function mode(xs: number[]): number {
  const counts = new Map<number, number>()
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1)
  let best = xs[0]
  let bestN = 0
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && v > best)) {
      best = v
      bestN = n
    }
  }
  return best
}

/**
 * A date in month `monthIndex` on day `day`, clamped to the month's length.
 *
 * "Monthly Interest Paid" lands 6/30, 7/31 and 8/31, so its modal day is 31.
 * new Date(2026, 8, 31) is 1 October — JavaScript rolls an invalid day into the
 * next month without complaint, and the payment would be reported a day late, in
 * the wrong month, every short month of the year.
 */
export function clampedDay(year: number, monthIndex: number, day: number): Date {
  const len = new Date(year, monthIndex + 1, 0).getDate()
  return new Date(year, monthIndex, Math.min(day, len))
}

/**
 * The next occurrence strictly after `today`.
 *
 * Anchored on the LAST event, never the first. Stepping forward from the first
 * event accumulates every 13- and 15-day holiday shift into the projection, and
 * by month six the date is days out.
 */
function projectForward(lastOn: string, stepDays: number, today: Date): string {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const next = parseDateOnly(lastOn)
  // Guard: a zero or negative step would spin here forever.
  const step = Math.max(1, Math.round(stepDays))
  do {
    next.setDate(next.getDate() + step)
  } while (next.getTime() <= t.getTime())
  return isoDate(next)
}

/** The same, stepping whole months and clamping the day. */
function projectMonthly(lastOn: string, day: number, today: Date): string {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const from = parseDateOnly(lastOn)
  let y = from.getFullYear()
  let m = from.getMonth()
  let next = clampedDay(y, m, day)
  // The modal day may be EARLIER in the month than the last event landed (a
  // month-end series observed on the 30th of a 30-day month), so start from the
  // month after the last event and walk on until we are past today.
  while (next.getTime() <= Math.max(from.getTime(), t.getTime())) {
    m += 1
    if (m > 11) {
      m = 0
      y += 1
    }
    next = clampedDay(y, m, day)
  }
  return isoDate(next)
}

/* ------------------------------------------------------------------ *
 * Detection
 * ------------------------------------------------------------------ */

function kindFor(medianGap: number): CadenceKind {
  if (medianGap >= 6 && medianGap <= 8) return 'weekly'
  if (medianGap >= 12 && medianGap <= 16) return 'fortnightly'
  if (medianGap >= 27 && medianGap <= 32) return 'monthly'
  return 'every-n-days'
}

/** "every 14 days", "monthly on the 31st" — for a sub-line, never a headline. */
export function cadenceLabel(s: Series): string {
  switch (s.kind) {
    case 'weekly':
      return 'weekly'
    case 'fortnightly':
      return 'every 2 weeks'
    case 'monthly':
      return s.dayOfMonth ? `monthly, around the ${ordinal(s.dayOfMonth)}` : 'monthly'
    case 'every-n-days':
      return `every ${Math.round(s.medianGap ?? 0)} days`
    case 'once':
      return 'seen once'
    default:
      return 'no regular pattern'
  }
}

function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

export interface DetectOptions {
  today: Date
  windowDays?: number
  /** Only these accounts. Omit for all of them. */
  accountIds?: Set<string>
}

/**
 * Derive every recurring series in `events`.
 *
 * The SERIES KEY is (account_id, normalised descriptor, SIGN). All three matter:
 *
 *  - account, because the same employer pays into one account and is charged on
 *    another;
 *  - descriptor, normalised, because the raw ACH line is unique per payment;
 *  - sign, because "Steak 'n Shake" is inbound salary on one person's checking
 *    AND outbound restaurant spend on the business card, and on one household
 *    account it is both. Merging them nets a $1,063 deposit against a $1.07
 *    burger and reports neither.
 *
 * What the key deliberately does NOT include is the bucket. There is a live
 * merchant rule mapping "lennar" to `optional`, and two Lennar rows already carry
 * it. Keying on bucket === 'income' would let a relabelling in the budget screen
 * silently delete a payroll stream from the calendar. Direction is read off the
 * sign, which nobody can edit.
 */
export function detectSeries(events: CadenceEvent[], opts: DetectOptions): Series[] {
  const { today, windowDays = WINDOW_DAYS, accountIds } = opts

  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  from.setDate(from.getDate() - windowDays)
  const fromIso = isoDate(from)
  const todayIso = isoDate(today)

  /** date -> summed magnitude, per series. */
  const groups = new Map<
    string,
    { accountId: string; direction: Direction; names: string[]; merchant: string | null; byDay: Map<string, number> }
  >()

  for (const e of events) {
    // A pending row is not a second observation of the cadence: Plaid re-posts it
    // settled, sometimes on a different day and with a different id, which would
    // plant a phantom one-day gap in the middle of an otherwise even series.
    if (e.pending) continue
    if (e.amount === 0) continue
    if (accountIds && !accountIds.has(e.account_id)) continue
    if (e.posted_on < fromIso || e.posted_on > todayIso) continue

    const merchant = e.merchant_name?.trim() || null
    const descriptor = merchant ? merchant.toLowerCase() : normaliseDescriptor(e.name)
    if (!descriptor) continue

    // Plaid: positive is money OUT.
    const direction: Direction = e.amount < 0 ? 'in' : 'out'
    const key = `${e.account_id}|${descriptor}|${direction}`

    let g = groups.get(key)
    if (!g) {
      g = { accountId: e.account_id, direction, names: [], merchant, byDay: new Map() }
      groups.set(key, g)
    }
    g.names.push(e.name)
    // Same-day rows are ONE event. Three $200 transfers on the same morning are
    // one arrival of $600; counted separately they produce gaps of zero days,
    // which makes the median zero and the projection divide by it.
    g.byDay.set(e.posted_on, (g.byDay.get(e.posted_on) ?? 0) + Math.abs(e.amount))
  }

  const out: Series[] = []

  for (const [key, g] of groups) {
    const dates = [...g.byDay.keys()].sort()
    const seriesEvents: SeriesEvent[] = dates.map((d) => ({ date: d, amount: g.byDay.get(d) as number }))
    const firstOn = dates[0]
    const lastOn = dates[dates.length - 1]
    const daysSinceLast = daysBetween(lastOn, todayIso)

    // The shortest raw name is reliably the cleanest one ("Lennar Homes Payroll"
    // beside "LENNAR CORPORAT CR PAYMENT PPD ID: …"), and stripIds takes the
    // trace numbers off whatever is left.
    const shortest = [...g.names].sort((a, b) => a.length - b.length)[0] ?? ''
    const cleaned = stripIds(shortest)
    const label = (g.merchant ?? cleaned ?? shortest).slice(0, LABEL_MAX) || 'Unnamed'

    const base = {
      key,
      accountId: g.accountId,
      direction: g.direction,
      label,
      descriptor: key.split('|')[1],
      events: seriesEvents,
      firstOn,
      lastOn,
      daysSinceLast,
      medianAmount: median(seriesEvents.map((e) => e.amount)),
    }

    if (seriesEvents.length < MIN_EVENTS) {
      out.push({
        ...base,
        medianGap: null,
        madGap: null,
        onBeat: 0,
        missedCycles: 0,
        kind: seriesEvents.length === 1 ? 'once' : 'irregular',
        dayOfMonth: null,
        nextOn: null,
        overdue: false,
        stopped: false,
        note:
          seriesEvents.length === 1
            ? 'seen once — nothing to project from'
            : 'seen twice — not enough to call a cadence',
      })
      continue
    }

    const rawGaps: number[] = []
    for (let i = 1; i < dates.length; i++) rawGaps.push(daysBetween(dates[i - 1], dates[i]))

    // Two passes: a first median to recognise the multiples, then the real median
    // over the repaired per-cycle gaps.
    const m0 = median(rawGaps)
    const { cycles, missed } = perCycleGaps(rawGaps, m0)
    const m1 = median(cycles)
    const madGap = mad(cycles, m1)
    const onBeat = cycles.filter((g2) => Math.abs(g2 - m1) <= ON_BEAT * m1).length / cycles.length
    const missedShare = missed / (cycles.length + missed)

    const stats = {
      medianGap: m1,
      madGap,
      onBeat,
      missedCycles: missed,
    }

    let reject: string | null = null
    if (!(m1 > 0)) reject = 'no usable spacing between events'
    else if (missedShare > MAX_MISSED_SHARE)
      reject = `${Math.round(missedShare * 100)}% of cycles would have to be assumed missed`
    else if (onBeat < MIN_ON_BEAT)
      reject = `only ${Math.round(onBeat * 100)}% of gaps land near the ${Math.round(m1)}-day median`
    else if (madGap > MAX_MAD_RATIO * m1)
      reject = `gaps scatter ±${madGap.toFixed(1)} days around a ${Math.round(m1)}-day median`

    if (reject) {
      out.push({
        ...base,
        ...stats,
        kind: 'irregular',
        dayOfMonth: null,
        nextOn: null,
        overdue: false,
        stopped: false,
        note: reject,
      })
      continue
    }

    const kind = kindFor(m1)
    const dayOfMonth = kind === 'monthly' ? mode(dates.map((d) => parseDateOnly(d).getDate())) : null

    const stopped = daysSinceLast > Math.max(STOPPED_FACTOR * m1, STOPPED_MIN_DAYS)
    const overdue = !stopped && daysSinceLast > OVERDUE_FACTOR * m1

    const nextOn = stopped
      ? null
      : kind === 'monthly' && dayOfMonth
        ? projectMonthly(lastOn, dayOfMonth, today)
        : projectForward(lastOn, m1, today)

    out.push({
      ...base,
      ...stats,
      kind,
      dayOfMonth,
      nextOn,
      overdue,
      stopped,
      note: stopped ? `nothing since ${lastOn} — treated as ended` : null,
    })
  }

  // Biggest money first: what matters on this page is size, not alphabet.
  return out.sort((a, b) => b.medianAmount - a.medianAmount)
}
