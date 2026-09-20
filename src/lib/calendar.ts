/**
 * Everything /calendar needs, assembled in one place: what is due, what is
 * expected in, and where household checking is projected to sit on each day.
 *
 * The reason this page exists is on record. The checking accounts repeatedly ran
 * to single digits and the toll accounts went negative, which cost real money in
 * pay-by-plate rates and violation fees before anyone noticed. So the bar here is
 * not "a pretty month grid" — it is that a day which projects below zero is named
 * and that no figure on the page is invented. Where something cannot be known the
 * page says so; it never fills the hole with an estimate and it never advises.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase'
import { isCleared, useData, type Account } from './data'
import { namesBusinessAccount } from './categorize'
import { accountLabel, isoDate, MONTH_NAMES, parseDateOnly } from './format'
import {
  WINDOW_DAYS,
  clampedDay,
  detectSeries,
  type CadenceEvent,
  type Series,
} from './cadence'
import type { DebtScheduleRow } from './database.types'
import {
  applyOverrides,
  applyStatedDay,
  confirmedSeries,
  useRecurringOverrides,
  type Override,
  type Resurrected,
} from './recurring'

/** PostgREST hands numeric back as "31000.00". Coerce at the boundary, once. */
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0))

/** How far ahead the stepper and the projection go. */
export const HORIZON_MONTHS = 3

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export interface DuePayment {
  accountId: string
  label: string
  /** YYYY-MM-DD. */
  on: string
  /** Null when the account is open but neither a schedule nor a minimum says how much. */
  amount: number | null
  /**
   * schedule  — debt_schedules, the authoritative payment amount and day
   * issuer    — accounts.next_due_on as reported by the bank
   * due_day   — accounts.due_day, typed in here
   */
  source: 'schedule' | 'issuer' | 'due_day'
  /** The issuer's date was already paid, so it was rolled on a month. */
  rolledForward: boolean
}

export interface ExpectedFlow {
  seriesKey: string
  accountId: string
  accountLabel: string
  label: string
  on: string
  amount: number
  direction: 'in' | 'out'
  /** Counted in the running balance. False for savings and the PayPal wallet. */
  inBalance: boolean
  overdue: boolean
}

export interface DayCell {
  date: string
  day: number
  inMonth: boolean
  isToday: boolean
  due: DuePayment[]
  expected: ExpectedFlow[]
  /** Projected household checking at the END of this day. Null before the seed. */
  projected: number | null
  /** projected < 0. */
  negative: boolean
}

export interface SeedAccount {
  label: string
  balance: number
  asOf: string | null
}

export interface CalendarModel {
  loading: boolean
  error: string | null
  /** The history query succeeded and returned nothing — not the same as failing. */
  historyEmpty: boolean
  weeks: DayCell[][]
  monthLabel: string
  seedTotal: number
  seedAsOf: string | null
  seedAccounts: SeedAccount[]
  /** The seeded accounts do not all report the same as_of date. */
  seedAsOfDisagrees: boolean
  /** Rows replayed on top of the seed because they posted after it. */
  actualsApplied: number
  /** The first day anywhere in the horizon that projects below zero. */
  firstNegative: { date: string; balance: number; nextInflowOn: string | null } | null
  /** Those of them that fall in the month on screen. */
  negativeDays: DayCell[]
  /** Series we are willing to put a date on. */
  projectedSeries: Series[]
  /**
   * Dismissed as no longer active, and charged anyway since. The bill somebody
   * is sure they cancelled, still being taken.
   */
  resurrected: Resurrected[]
  /** Dismissed and quiet. Listed so a dismissal is never silently forgotten. */
  dismissedSeries: { series: Series | null; override: Override }[]
  /** Re-read the standing instructions after one is added or undone. */
  refreshOverrides: () => Promise<void>
  /** Projectable, but the last event is late — reported, NOT counted. See below. */
  overdueSeries: Series[]
  /** Regular outgoings that are already counted as a payment due. */
  suppressedSeries: Series[]
  /** Seen often enough to notice, not regular enough to date. */
  irregularSeries: Series[]
  /** Open debts with nothing on record to date a payment from. */
  unknownDue: { accountId: string; label: string }[]
  monthDue: number
  monthIn: number
  monthOut: number
}

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)
const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0)
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1)
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/* ------------------------------------------------------------------ *
 * Payments due
 * ------------------------------------------------------------------ */

export interface ScheduleLite {
  accountId: string
  paymentAmount: number
  paymentDay: number
  matchText: string | null
}

/**
 * Every payment due for one account inside a window.
 *
 * The fallback chain is debt_schedules, then next_due_on, then due_day, then
 * nothing — and "nothing known" is returned as no rows so the caller can report
 * it as UNKNOWN. It must never read as "no payment due": three of these accounts
 * are Plaid-fed cards with due_day null, and a blank day on a credit card is the
 * single most expensive thing this grid could imply.
 *
 * debt_schedules wins where a row exists. It carries the real payment amount and
 * day for the three largest obligations here — the personal loan $1,217.23 on the 9th, the motorcycle loan
 * $359.24 on the 6th, IRS $284.00 on the 3rd — and accounts.due_day is null on
 * every one of them, so ignoring the schedule mis-dates the three biggest
 * payments in the month.
 */
export function duePaymentsFor(
  account: Account,
  schedule: ScheduleLite | null,
  label: string,
  fromIso: string,
  toIso: string,
): DuePayment[] {
  const from = parseDateOnly(fromIso)
  const to = parseDateOnly(toIso)
  const out: DuePayment[] = []

  const push = (d: Date, amount: number | null, source: DuePayment['source'], rolled: boolean) => {
    const iso = isoDate(d)
    if (iso < fromIso || iso > toIso) return
    out.push({ accountId: account.id, label, on: iso, amount, source, rolledForward: rolled })
  }

  if (schedule) {
    // A standing instalment: the same day every month, for as long as the window
    // runs. Clamped, because payment_day could be 29–31 on a 28-day February.
    for (let m = startOfMonth(from); m <= to; m = addMonths(m, 1)) {
      push(clampedDay(m.getFullYear(), m.getMonth(), schedule.paymentDay), schedule.paymentAmount, 'schedule', false)
    }
    return out
  }

  const amount = account.minimum_payment > 0 ? account.minimum_payment : null

  if (account.next_due_on) {
    let base = parseDateOnly(account.next_due_on)
    let rolled = false

    /**
     * next_due_on GOES STALE. The one card says 2026-09-15 — four days in
     * the past — with last_payment_on 2026-09-15 and last_payment_amount $119.00,
     * exactly its minimum. That cycle is paid; the issuer simply has not published
     * the next one yet. Left alone it renders as a payment overdue today, on an
     * account that is current.
     */
    if (account.last_payment_on && account.last_payment_on >= account.next_due_on) {
      base = clampedDay(base.getFullYear(), base.getMonth() + 1, base.getDate())
      rolled = true
    }

    // The issuer states ONE date. Everything after it is this page continuing the
    // monthly pattern, which is why nothing is generated BEFORE it — inventing a
    // payment in a month the issuer has not spoken about would be a fabrication.
    const day = parseDateOnly(account.next_due_on).getDate()
    for (let d = base; d <= to; d = clampedDay(d.getFullYear(), d.getMonth() + 1, day)) {
      push(d, amount, 'issuer', rolled && isoDate(d) === isoDate(base))
    }
    return out
  }

  if (account.due_day) {
    for (let m = startOfMonth(from); m <= to; m = addMonths(m, 1)) {
      push(clampedDay(m.getFullYear(), m.getMonth(), account.due_day), amount, 'due_day', false)
    }
    return out
  }

  return out
}

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

interface HistoryState {
  rows: CadenceEvent[] | null
  loading: boolean
  error: string | null
}

/**
 * The trailing window of transactions the cadence detector reads.
 *
 * Two devices here are copied from monthView.tsx, because they are exactly the
 * pieces a second implementation gets subtly wrong:
 *
 *  - a sequence guard, so a slower earlier request cannot land last and paint
 *    stale rows under the current heading. Two loads overlap whenever a manual
 *    refresh lands on top of a focus refetch.
 *  - telling an EMPTY result apart from a FAILED one. "No income detected" and
 *    "the query broke" are not the same statement and only one of them is true;
 *    on this page the difference is between "nothing is expected" and "we do not
 *    know what is expected", which is the whole point of the page.
 */
/**
 * PostgREST caps a response at the project's max-rows, 1000 by default, and does
 * it SILENTLY — no error, just a short array. Six months of six accounts is
 * already 859 rows here, so the cap is one linked card away. A truncated window
 * does not fail loudly; it quietly shortens every series, which changes medians
 * and deletes cadences. Paging until a short page comes back is the only way to
 * know the window is whole.
 */
const PAGE = 1000

function useHistory(
  fromIso: string,
  toIso: string,
  accountIds: string[],
  /** False while the shared data layer is still loading the account list. */
  ready: boolean,
): HistoryState {
  const [state, setState] = useState<HistoryState>({ rows: null, loading: true, error: null })
  const seq = useRef(0)

  /** Stable across re-renders so the effect does not refire on array identity. */
  const idKey = accountIds.join(',')

  const load = useCallback(async () => {
    const mine = ++seq.current
    if (!idKey) {
      // No ids yet. While the account list is still loading that means "not
      // known", not "nothing" — but once it HAS loaded and there are still no
      // cash accounts, the answer really is an empty window, and holding
      // `loading` true forever would leave the page as a skeleton for good.
      setState({ rows: ready ? [] : null, loading: !ready, error: null })
      return
    }
    setState((s) => ({ ...s, loading: true, error: null }))

    const ids = idKey.split(',')
    const rows: CadenceEvent[] = []
    for (let page = 0; ; page++) {
      const { data, error } = await supabase
        .from('transactions')
        .select('account_id, merchant_name, name, amount, posted_on, pending, budget_line_id')
        .in('account_id', ids)
        .gte('posted_on', fromIso)
        .lte('posted_on', toIso)
        .order('posted_on', { ascending: true })
        .order('id', { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1)

      // Tapping the month stepper faster than the query returns meant an older
      // request could resolve last and paint a window that is no longer the one
      // on screen.
      if (mine !== seq.current) return

      if (error) {
        // A failed query must never render as "no income detected". An empty
        // window and a broken one are different statements and only one of them
        // is true; on this page the difference is between "nothing is expected"
        // and "we do not know what is expected".
        setState({ rows: null, loading: false, error: error.message })
        return
      }

      const batch = (data ?? []) as Record<string, unknown>[]
      for (const r of batch) {
        rows.push({
          account_id: r.account_id as string,
          merchant_name: (r.merchant_name as string | null) ?? null,
          name: (r.name as string) ?? '',
          amount: num(r.amount),
          posted_on: r.posted_on as string,
          pending: r.pending === true,
          // Carried through, not just selected. Leaving this off the mapped row
          // while it sat in the select list made every series budget-line-less,
          // so reconcileRoutes() bailed at its first guard and a rent paid from
          // the other account still reported as weeks overdue.
          budget_line_id: (r.budget_line_id as string | null) ?? null,
        })
      }
      if (batch.length < PAGE) break
      if (page > 40) break // 40k rows is not a household; stop rather than spin.
    }

    setState({ rows, loading: false, error: null })
  }, [fromIso, toIso, idKey, ready])

  useEffect(() => {
    void load()
  }, [load])

  return state
}

interface SchedulesState {
  byAccount: Map<string, ScheduleLite>
  loading: boolean
  error: string | null
}

/** debt_schedules is not in the shared data layer, so this page reads it itself. */
function useSchedules(): SchedulesState {
  const [state, setState] = useState<SchedulesState>({
    byAccount: new Map(),
    loading: true,
    error: null,
  })
  const seq = useRef(0)

  useEffect(() => {
    const mine = ++seq.current
    void (async () => {
      const { data, error } = await supabase
        .from('debt_schedules')
        .select('account_id, payment_amount, payment_day, match_text')
      if (mine !== seq.current) return
      if (error) {
        setState({ byAccount: new Map(), loading: false, error: error.message })
        return
      }
      const byAccount = new Map<string, ScheduleLite>()
      for (const r of (data ?? []) as Partial<DebtScheduleRow>[]) {
        if (!r.account_id) continue
        byAccount.set(r.account_id, {
          accountId: r.account_id,
          paymentAmount: num(r.payment_amount),
          paymentDay: Number(r.payment_day ?? 1),
          matchText: (r.match_text as string | null) ?? null,
        })
      }
      setState({ byAccount, loading: false, error: null })
    })()
  }, [])

  return state
}

/* ------------------------------------------------------------------ *
 * The month stepper
 * ------------------------------------------------------------------ */

export interface CalendarMonth {
  anchor: Date
  label: string
  goPrev: () => void
  goNext: () => void
  atFloor: boolean
  atCeiling: boolean
  thisMonth: boolean
}

/**
 * /calendar's own stepper.
 *
 * useMonthView() cannot be reused: it pages BACKWARDS from this month to the
 * oldest recorded transaction, which is the opposite direction. This page looks
 * forward, and it is floored at the current month because there is no past
 * balance line to draw — checking snapshots only start 2026-09-15 — and capped
 * three months out, past which a projection built from a 180-day window is
 * arithmetic rather than information.
 */
export function useCalendarMonth(now = new Date()): CalendarMonth {
  // Reduced to a DATE STRING first. `new Date()` as a default argument is a new
  // object on every render, so memoising on it memoises nothing — every derived
  // Date would be fresh each pass and every consumer downstream would recompute.
  // The day is what actually matters here, and the day is stable.
  const todayIso = isoDate(now)
  const floor = useMemo(() => startOfMonth(parseDateOnly(todayIso)), [todayIso])
  const ceiling = useMemo(() => addMonths(floor, HORIZON_MONTHS), [floor])
  const [anchor, setAnchor] = useState<Date>(floor)

  /**
   * Pull the anchor forward if the floor moves past it.
   *
   * `floor` was only ever an INITIAL value for the anchor, so an app left open
   * across midnight on the last of the month kept showing the old month — which
   * is now below the floor, so goPrev was disabled and there was no way back to
   * it either. The stale month reads as almost empty, because the projection is
   * seeded from balances dated to the day the page loaded.
   */
  useEffect(() => {
    setAnchor((d) => (d.getTime() < floor.getTime() ? floor : d))
  }, [floor])

  const atFloor = anchor.getTime() <= floor.getTime()
  const atCeiling = anchor.getTime() >= ceiling.getTime()

  return {
    anchor,
    label: `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`,
    goPrev: () => setAnchor((d) => (d.getTime() <= floor.getTime() ? d : addMonths(d, -1))),
    goNext: () => setAnchor((d) => (d.getTime() >= ceiling.getTime() ? d : addMonths(d, 1))),
    atFloor,
    atCeiling,
    thisMonth: atFloor,
  }
}

/* ------------------------------------------------------------------ *
 * The model
 * ------------------------------------------------------------------ */

/** Payment words, for deciding whether a bank name in a descriptor is a repayment. */
const PAYMENT_WORD = /\b(payment|pmt|pymt|pymnt|autopay|auto pay|bill pay|billpay|epay|ach|xfer|transfer)\b/

export function useCalendar(anchor: Date, now = new Date()): CalendarModel {
  const { accounts, checking, savingsAccounts, loading: dataLoading, error: dataError } = useData()
  const { overrides, refresh: refreshOverrides } = useRecurringOverrides()

  // The string first, then the Date from the string — see useCalendarMonth. A
  // Date derived straight from the default argument changes identity on every
  // render and drags the whole model's memo with it.
  const todayIso = isoDate(midnight(now))
  const todayMid = useMemo(() => parseDateOnly(todayIso), [todayIso])

  const historyFrom = useMemo(() => {
    const d = new Date(todayMid)
    d.setDate(d.getDate() - WINDOW_DAYS)
    return isoDate(d)
  }, [todayMid])

  /**
   * Every household cash account: the checking the balance is made of, plus
   * household savings, whose own recurring lines are worth seeing on the grid
   * even though they sit outside the checking total. Business accounts are never
   * in here — their money is not the household's and must not reach this page's
   * arithmetic at all.
   */
  const cashAccounts = useMemo(
    () => [...checking, ...savingsAccounts].filter((a) => !a.is_business),
    [checking, savingsAccounts],
  )
  const cashIds = useMemo(() => cashAccounts.map((a) => a.id).sort(), [cashAccounts])

  const history = useHistory(historyFrom, todayIso, cashIds, !dataLoading)
  const schedules = useSchedules()

  return useMemo<CalendarModel>(() => {
    const label = `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`
    const monthFrom = startOfMonth(anchor)
    const monthTo = endOfMonth(anchor)

    /**
     * Which accounts the running balance is made of.
     *
     * useData().checking is already household-only — the business's 5star was
     * removed from it, and seeding from it would have added $3,347.13 of the
     * business's money to the household's, which is roughly the size of the
     * shortfall this page exists to catch.
     *
     * PayPal is excluded on top of that, deliberately. It is stored with kind
     * `checking` but it is a WALLET, not a bank account: nothing on this grid can
     * be paid out of it — every payment here is an ACH debit or an autopay
     * against a bank account — so counting it as spendable cash would overstate
     * what is available to meet them. It happens to sit at $0.00 today, so the
     * choice changes no figure now; it is written down because the day it holds
     * $400 is the day it would quietly move a negative day off the grid. PayPal
     * still APPEARS on the calendar, its rows simply marked as outside the total.
     */
    const isWallet = (a: Account) => a.name.trim().toLowerCase() === 'paypal'
    const balanceAccounts = checking.filter((a) => !isWallet(a))
    const balanceIds = new Set(balanceAccounts.map((a) => a.id))

    const cashIdSet = new Set(cashIds)
    const nameOf = new Map(cashAccounts.map((a) => [a.id, accountLabel(a)]))

    const seedAccounts: SeedAccount[] = balanceAccounts.map((a) => ({
      label: nameOf.get(a.id) ?? a.name,
      balance: a.balance,
      asOf: a.balanceAsOf,
    }))
    const seedTotal = seedAccounts.reduce((s, a) => s + a.balance, 0)
    const asOfDates = [...new Set(seedAccounts.map((a) => a.asOf).filter(Boolean) as string[])]
    // Mixing snapshots taken on different days silently adds a day of one
    // account's spending to another's. If they disagree the page says so rather
    // than presenting one date as if it covered all of them.
    const seedAsOf = asOfDates.length > 0 ? asOfDates.slice().sort().pop() ?? null : null
    const seedAsOfDisagrees = asOfDates.length > 1

    /* ---------- cadence ---------- */

    const detected = history.rows
      ? detectSeries(history.rows, { today: todayMid, accountIds: cashIdSet })
      : []

    /**
     * A member's standing instructions, applied before anything is projected.
     *
     * A dismissed series drops out of the grid — unless it has been charged
     * since, in which case it comes straight back AND is reported as having come
     * back. Money that is actually leaving has to stay in the running balance;
     * understating what will leave is the error that costs money.
     *
     * A confirmed series is added for an obligation detection cannot infer yet,
     * and only where detection produced nothing — once there is real history,
     * the measured series is the better description than the asserted one.
     */
    const applied = applyOverrides(detected, overrides)
    // A member's stated day wins over the observed posting day — see
    // applyStatedDay(). The cadence and the amount stay measured.
    const series = applyStatedDay(
      [...applied.active, ...confirmedSeries(overrides, detected, todayMid)],
      overrides,
      todayMid,
    )

    /**
     * Regular outgoings that are ALREADY on the grid as a payment due.
     *
     * Without this, a card payment appears twice — once because the issuer states
     * a due date and a minimum, and again because the bank has been paying it on
     * the same day every month for six months. "CARD ONLINE PMT" at $200 a
     * month is exactly that: the same obligation as the one card's due
     * date, counted from the other side.
     *
     * Matching uses the account's own name, its payment_aliases (which exist for
     * precisely this — a descriptor that stands in for an account) and the bank's
     * mask. The INSTITUTION is a much blunter instrument — "Chase" and "Amazon"
     * name a dozen unrelated merchants — so it only counts when the descriptor
     * also carries a payment word. Cleared debts are left out of the matching
     * entirely: they raise no payment on this grid, so suppressing an outflow
     * against one would delete a real payment from the projection.
     */
    const openDebts = accounts.filter(
      (a) => a.kind !== 'checking' && a.kind !== 'savings' && !a.is_business && !isCleared(a),
    )
    const debtNames = openDebts.flatMap((a) => [a.name, ...(a.payment_aliases ?? [])]).map((s) => s.toLowerCase())
    const scheduleTexts = [...schedules.byAccount.values()]
      .map((s) => s.matchText)
      .filter((t): t is string => !!t)
      .map((t) => t.toLowerCase())
    const debtMasks = openDebts.map((a) => a.mask).filter((m): m is string => !!m)
    const debtInstitutions = [
      ...new Set(openDebts.map((a) => (a.institution ?? '').toLowerCase().trim()).filter(Boolean)),
    ]

    const repaysTrackedDebt = (s: Series): boolean => {
      if (s.direction !== 'out') return false
      const hay = `${s.label} ${s.descriptor}`.toLowerCase()
      if (namesBusinessAccount(hay, [...debtNames, ...scheduleTexts], debtMasks)) return true
      return PAYMENT_WORD.test(hay) && debtInstitutions.some((inst) => inst.length >= 4 && hay.includes(inst))
    }

    const datedSeries = series.filter((s) => s.nextOn !== null)
    const suppressedSeries = datedSeries.filter(repaysTrackedDebt)
    const suppressedKeys = new Set(suppressedSeries.map((s) => s.key))
    const countedSeries = datedSeries.filter((s) => !suppressedKeys.has(s.key))
    const overdueSeries = countedSeries.filter((s) => s.overdue)
    const irregularSeries = series.filter(
      (s) => s.nextOn === null && !s.stopped && s.events.length >= 3,
    )

    /* ---------- the projection horizon ---------- */

    const horizonTo = endOfMonth(addMonths(startOfMonth(todayMid), HORIZON_MONTHS))
    const horizonToIso = isoDate(horizonTo)
    // Nothing is projected before the seed: there is no balance history to draw
    // against — the checking snapshots only start 2026-09-15 — so the line begins
    // where the money is actually known and runs forward only.
    const projectFromIso = seedAsOf ?? todayIso

    /** Expected flows, keyed by date, over the whole horizon. */
    const flowsByDate = new Map<string, ExpectedFlow[]>()
    const addFlow = (f: ExpectedFlow) => {
      const list = flowsByDate.get(f.on) ?? []
      list.push(f)
      flowsByDate.set(f.on, list)
    }

    for (const s of countedSeries) {
      // Every occurrence inside the horizon, not just the next one: a fortnightly
      // payroll lands twice in most months and six times across the horizon.
      let cursor = s.nextOn as string
      let guard = 0
      while (cursor <= horizonToIso && guard++ < 200) {
        addFlow({
          seriesKey: s.key,
          accountId: s.accountId,
          accountLabel: nameOf.get(s.accountId) ?? '',
          label: s.label,
          on: cursor,
          amount: s.medianAmount,
          direction: s.direction,
          inBalance: balanceIds.has(s.accountId),
          overdue: s.overdue,
        })
        const next = stepFrom(cursor, s)
        if (!next || next <= cursor) break
        cursor = next
      }
    }

    /* ---------- payments due ---------- */

    const dueByDate = new Map<string, DuePayment[]>()
    const unknownDue: { accountId: string; label: string }[] = []
    // Due dates are generated from the start of the CURRENT month, so the month
    // on screen shows the ones already past as well as the ones to come. They
    // carry no weight in the balance, which only runs forward from the seed.
    const dueFromIso = isoDate(startOfMonth(todayMid))

    for (const a of accounts) {
      if (a.kind === 'checking' || a.kind === 'savings') continue
      // Business obligations never land on the household cash grid. Amazon
      // Business is due 2026-09-24 for $79.00 and belongs to the business.
      if (a.is_business) continue
      // next_due_on IS POPULATED ON CLEARED ACCOUNTS — PayPal Credit says
      // 2026-09-23 and both Quicksilvers say October, all with a zero minimum.
      // Unfiltered, the grid shows phantom payments on debts that are gone.
      if (isCleared(a)) continue

      const label = accountLabel(a)
      const schedule = schedules.byAccount.get(a.id) ?? null

      /**
       * due_day is NULL on every Plaid-fed card here, so the chain really does
       * run out. When it does the account goes on the UNKNOWN list — never
       * silently omitted, because an empty day on a credit card reads as "nothing
       * due" and that is the one misreading this page cannot afford.
       */
      if (!schedule && !a.next_due_on && !a.due_day) {
        unknownDue.push({ accountId: a.id, label })
        continue
      }

      for (const r of duePaymentsFor(a, schedule, label, dueFromIso, horizonToIso)) {
        const list = dueByDate.get(r.on) ?? []
        list.push(r)
        dueByDate.set(r.on, list)
      }
    }

    /* ---------- walk the balance forward ---------- */

    /**
     * Actuals first: rows that posted AFTER the snapshot was taken, replayed on
     * top of it.
     *
     * Pending rows are skipped. Plaid's balance for most issuers already includes
     * pending authorisations, so replaying them subtracts the same charge twice —
     * eight pending rows exist right now, and double-counting them would invent a
     * shortfall the page would then report as fact.
     */
    let actualsApplied = 0
    let running = seedTotal
    if (seedAsOf && history.rows) {
      for (const r of history.rows) {
        if (r.pending) continue
        if (!balanceIds.has(r.account_id)) continue
        if (r.posted_on <= seedAsOf) continue
        // Plaid sign: positive is money out.
        running -= r.amount
        actualsApplied++
      }
    }

    const balanceByDate = new Map<string, number>()
    const cursorDate = parseDateOnly(projectFromIso)
    balanceByDate.set(projectFromIso, running)

    for (let d = new Date(cursorDate); ; ) {
      d.setDate(d.getDate() + 1)
      const iso = isoDate(d)
      if (iso > horizonToIso) break

      for (const f of flowsByDate.get(iso) ?? []) {
        if (!f.inBalance) continue
        /**
         * A LATE stream is treated the way that cannot flatter the position.
         *
         * Money in that has not arrived is dropped: assuming a payroll will land
         * on schedule when it has already missed its slot is the optimistic
         * reading, and the optimistic reading is exactly what hides a negative
         * day. Money out that has not gone is KEPT, for the same reason in
         * reverse — the rent has not stopped being owed because the debit has not
         * appeared yet, and dropping it would quietly remove the largest outgoing
         * in the month from the very projection meant to catch a shortfall.
         *
         * The asymmetry is deliberate and is stated on the page, not hidden here.
         * Either way the series is listed and flagged as late, so nothing is
         * silently removed in either direction.
         */
        if (f.overdue && f.direction === 'in') continue
        running += f.direction === 'in' ? f.amount : -f.amount
      }
      for (const p of dueByDate.get(iso) ?? []) {
        // A household debt payment comes out of household checking. An amount we
        // do not know cannot be subtracted, so it is shown and not counted — the
        // row on the day says so.
        if (p.amount !== null) running -= p.amount
      }

      balanceByDate.set(iso, Math.round(running * 100) / 100)
    }

    /* ---------- the grid ---------- */

    const gridStart = new Date(monthFrom)
    gridStart.setDate(gridStart.getDate() - gridStart.getDay())
    const gridEnd = new Date(monthTo)
    gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()))

    const weeks: DayCell[][] = []
    let week: DayCell[] = []
    for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) {
      const iso = isoDate(d)
      const projected = balanceByDate.has(iso) ? (balanceByDate.get(iso) as number) : null
      week.push({
        date: iso,
        day: d.getDate(),
        inMonth: d.getMonth() === anchor.getMonth() && d.getFullYear() === anchor.getFullYear(),
        isToday: iso === todayIso,
        due: dueByDate.get(iso) ?? [],
        expected: flowsByDate.get(iso) ?? [],
        projected,
        negative: projected !== null && projected < 0,
      })
      if (week.length === 7) {
        weeks.push(week)
        week = []
      }
    }
    if (week.length > 0) weeks.push(week)

    /* ---------- the thing the page is for ---------- */

    const horizonDays = [...balanceByDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    const firstNegEntry = horizonDays.find(([, v]) => v < 0) ?? null
    const firstNegative = firstNegEntry
      ? {
          date: firstNegEntry[0],
          balance: firstNegEntry[1],
          nextInflowOn:
            horizonDays
              .filter(([iso]) => iso > firstNegEntry[0])
              .find(([iso]) =>
                (flowsByDate.get(iso) ?? []).some((f) => f.inBalance && f.direction === 'in' && !f.overdue),
              )?.[0] ?? null,
        }
      : null

    const monthCells = weeks.flat().filter((c) => c.inMonth)
    const negativeDays = monthCells.filter((c) => c.negative)

    let monthDue = 0
    let monthIn = 0
    let monthOut = 0
    for (const c of monthCells) {
      for (const p of c.due) monthDue += p.amount ?? 0
      for (const f of c.expected) {
        // The same rule the running balance applies, so the three headline
        // figures and the line they sit under cannot disagree.
        if (!f.inBalance) continue
        if (f.direction === 'in') {
          if (f.overdue) continue
          monthIn += f.amount
        } else {
          monthOut += f.amount
        }
      }
    }

    return {
      loading: dataLoading || history.loading || schedules.loading,
      error: dataError ?? history.error ?? schedules.error,
      historyEmpty: history.rows !== null && history.rows.length === 0,
      weeks,
      monthLabel: label,
      seedTotal,
      seedAsOf,
      seedAccounts,
      seedAsOfDisagrees,
      actualsApplied,
      firstNegative,
      negativeDays,
      projectedSeries: countedSeries,
      resurrected: applied.resurrected,
      refreshOverrides,
      dismissedSeries: applied.dismissed,
      overdueSeries,
      suppressedSeries,
      irregularSeries,
      unknownDue,
      monthDue: Math.round(monthDue * 100) / 100,
      monthIn: Math.round(monthIn * 100) / 100,
      monthOut: Math.round(monthOut * 100) / 100,
    }
  }, [
    accounts,
    anchor,
    cashAccounts,
    cashIds,
    checking,
    dataError,
    dataLoading,
    history.error,
    history.loading,
    history.rows,
    overrides,
    refreshOverrides,
    schedules.byAccount,
    schedules.error,
    schedules.loading,
    todayIso,
    todayMid,
  ])
}

/**
 * The occurrence after `iso` for a series.
 *
 * Monthly series step by CALENDAR month on their modal day, clamped to the
 * month's length — not by their median gap in days. "Monthly Interest Paid" lands
 * 6/30, 7/31 and 8/31, so its modal day is the 31st; stepping it by 31 days would
 * walk it off the end of every short month, and new Date(2026, 8, 31) rolls
 * silently into 1 October rather than failing.
 */
function stepFrom(iso: string, s: Series): string | null {
  const d = parseDateOnly(iso)
  if (s.kind === 'monthly' && s.dayOfMonth) {
    return isoDate(clampedDay(d.getFullYear(), d.getMonth() + 1, s.dayOfMonth))
  }
  if (!s.medianGap || s.medianGap < 1) return null
  d.setDate(d.getDate() + Math.round(s.medianGap))
  return isoDate(d)
}
