/**
 * The Progress tab's own data.
 *
 * Two questions this answers that nothing else in the app does:
 *   1. What has the debt ACTUALLY done, month by month, as measured?
 *   2. What interest has actually been charged since the plan began?
 *
 * Both answers are currently very small, and that is the point. The plan started
 * on 15 September and today is the 19th; four days of a twenty-nine month plan
 * produce almost no observation at all. Everything here is built to say that
 * plainly rather than to fill the space with something that looks like history.
 */

import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'
import { isCleared, type Account } from './data'
import { parseDateOnly } from './format'
import { round2, type SimDebt, type SimResult } from './avalanche'
import type { SnapshotSource } from './database.types'

/** PostgREST serialises numeric as the string "31000.00". Coerce at the boundary. */
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0))

/** Snapshot rows as we actually need them. */
interface SnapshotRow {
  account_id: string
  balance: number | string | null
  as_of: string
  created_at: string
  source: SnapshotSource
}

/**
 * A snapshot the bank reported or a person typed in — as opposed to one worked
 * backwards from the transaction record.
 *
 * Only these are plotted as "actual". The derived rows reach back to September
 * 2024 and would draw two years of confident-looking line out of arithmetic
 * rather than observation; History already charts them and says in so many words
 * where they come from. Reconstruction is not measurement, and a page whose
 * whole argument is "this is what really happened" cannot blur the two.
 */
const MEASURED_SOURCES: SnapshotSource[] = ['plaid', 'manual']

const isMeasured = (source: SnapshotSource): boolean => MEASURED_SOURCES.includes(source)

/** One calendar month of measured debt. */
export interface ActualPoint {
  /** YYYY-MM. */
  monthKey: string
  /**
   * Months from the CURRENT calendar month, which is where both simulations put
   * their balances[0]. 0 is this month; an earlier month is negative.
   */
  monthIndex: number
  /** Total owed across every debt account at the end of that month. */
  total: number
  /** How many debt accounts had a reading by then. */
  accountsCovered: number
}

/** What the actual line is made of, said in figures rather than adjectives. */
export interface SnapshotProvenance {
  /** Measured rows on debt accounts. */
  readings: number
  /** Distinct dates those readings were taken on. */
  days: number
  firstAsOf: string | null
  lastAsOf: string | null
  /** Debt accounts with at least one measured reading. */
  accountsCovered: number
  debtAccounts: number
  /** Debt accounts sitting on a single reading — one number, no history at all. */
  thinAccounts: number
  /** What those single-reading accounts add up to. */
  thinTotal: number
  /** Reconstructed rows in the table, deliberately left out of the line. */
  reconstructed: number
}

/** Interest actually charged, as distinct from interest actually accrued. */
export interface ObservedInterest {
  /** Sum of interest and finance-charge rows posted since the plan began. */
  total: number
  rows: number
  /** Debt accounts that have reported interest since the plan began. */
  accountsSeen: number
  /** Debt accounts that report interest at all, over the whole dataset. */
  accountsEverSeen: number
  debtAccounts: number
  /** The date the window opens: plan_started_on. */
  since: string | null
}

/** YYYY-MM for a date-only column. String-sliced, so no timezone can move it. */
const monthKeyOf = (isoDay: string): string => isoDay.slice(0, 7)

/** YYYY-MM for a Date, in local time. */
const monthKeyOfDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

/** Whole months from `from` to `to`, both YYYY-MM. Negative when `to` is earlier. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  return (ty - fy) * 12 + (tm - fm)
}

/** The month after `key`, as YYYY-MM. */
function nextMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

/**
 * Whole months of the plan completed. The plan started on the 15th, so a month is
 * not complete until the 15th comes round again — 19 September is four days in,
 * which is zero completed months, not "most of one".
 */
export function completedPlanMonths(planStartedOn: string, today = new Date()): number {
  const start = parseDateOnly(planStartedOn)
  let n = (today.getFullYear() - start.getFullYear()) * 12 + (today.getMonth() - start.getMonth())
  if (today.getDate() < start.getDate()) n -= 1
  return Math.max(0, n)
}

/**
 * Monthly debt totals from measured snapshots.
 *
 * Per account, per month, the rule is the one account_balance_weekly already
 * uses: the latest row with as_of on or before the end of the month, breaking a
 * tie on created_at descending. the truck carries six rows dated within one week and
 * a correction typed in afterwards has to win over the reading it corrects.
 *
 * Balances carry forward. An account with no reading this month has not gone to
 * zero, it has simply not been read, and subtracting it would draw a cliff out of
 * missing data — downward being the direction a reader is least likely to
 * question. A month is only returned once EVERY debt account has a reading by
 * then, for the same reason.
 */
export function buildActualSeries(
  rows: SnapshotRow[],
  debtIds: Set<string>,
  today = new Date(),
): ActualPoint[] {
  const mine = rows
    .filter((r) => debtIds.has(r.account_id) && isMeasured(r.source))
    // Ascending, so replaying them in order leaves the latest row per account in
    // the map — the same row "ORDER BY as_of DESC, created_at DESC LIMIT 1" picks.
    .sort((a, b) => a.as_of.localeCompare(b.as_of) || a.created_at.localeCompare(b.created_at))

  if (mine.length === 0) return []

  const nowKey = monthKeyOfDate(today)
  const latest = new Map<string, number>()
  const points: ActualPoint[] = []

  let cursor = 0
  for (let key = monthKeyOf(mine[0].as_of); monthsBetween(key, nowKey) >= 0; key = nextMonthKey(key)) {
    while (cursor < mine.length && monthKeyOf(mine[cursor].as_of) <= key) {
      latest.set(mine[cursor].account_id, num(mine[cursor].balance))
      cursor++
    }

    if (latest.size < debtIds.size) continue

    let total = 0
    for (const v of latest.values()) total += v

    points.push({
      monthKey: key,
      monthIndex: monthsBetween(nowKey, key),
      total: round2(total),
      accountsCovered: latest.size,
    })
  }

  return points
}

/** Everything the provenance note states, computed from the same rows. */
export function describeSnapshots(
  rows: SnapshotRow[],
  debts: Account[],
  reconstructed: number,
): SnapshotProvenance {
  const debtIds = new Set(debts.map((d) => d.id))
  const measured = rows.filter((r) => debtIds.has(r.account_id) && isMeasured(r.source))

  const perAccount = new Map<string, number>()
  for (const r of measured) perAccount.set(r.account_id, (perAccount.get(r.account_id) ?? 0) + 1)

  const days = new Set(measured.map((r) => r.as_of))
  const dates = [...days].sort()

  const thin = debts.filter((d) => (perAccount.get(d.id) ?? 0) === 1)

  return {
    readings: measured.length,
    days: days.size,
    firstAsOf: dates[0] ?? null,
    lastAsOf: dates[dates.length - 1] ?? null,
    accountsCovered: perAccount.size,
    debtAccounts: debts.length,
    thinAccounts: thin.length,
    thinTotal: round2(thin.reduce((s, d) => s + d.balance, 0)),
    reconstructed,
  }
}

/**
 * Interest the no-roll counterfactual would have accrued over its first `months`
 * months — the figure the observed interest is measured against.
 *
 * SimResult carries only the run total, and a "so far" figure needs the split by
 * month, so the recurrence is run again here over the same debts. It is the
 * recurrence from simulateMinimumsOnly and nothing else: accrue apr/12, pay the
 * account's own minimum, redirect nothing.
 *
 * Running it twice is a chance for the two to drift apart, so the whole run is
 * totalled and checked against noRollSim.totalInterest before any prefix of it is
 * returned. A mismatch returns null and the page reports the figure as
 * unavailable, which is the only honest thing to print when two computations of
 * the same number disagree.
 */
export function noRollInterestSoFar(
  debts: Account[],
  noRollSim: SimResult,
  months: number,
): number | null {
  const simDebts: SimDebt[] = debts.map((d) => ({
    id: d.id,
    name: d.name,
    apr: d.apr,
    minimumPayment: d.minimum_payment,
    payoffOrder: d.payoff_order,
    balance: isCleared(d) ? 0 : d.balance,
  }))

  let open = simDebts.filter((d) => d.balance > 0).map((d) => ({ ...d }))
  const byMonth: number[] = []
  let total = 0

  for (let m = 0; m < noRollSim.months && open.length > 0; m++) {
    let accrued = 0
    for (const d of open) {
      const interest = round2(d.balance * ((d.apr ?? 0) / 100 / 12))
      d.balance = round2(d.balance + interest)
      accrued = round2(accrued + interest)
      total = round2(total + interest)
      const pay = Math.min(d.minimumPayment, d.balance)
      d.balance = round2(d.balance - pay)
    }
    byMonth.push(accrued)
    open = open.filter((d) => d.balance > 0)
  }

  if (Math.abs(total - noRollSim.totalInterest) > 0.01) return null

  return round2(byMonth.slice(0, months).reduce((s, n) => s + n, 0))
}

interface ProgressData {
  loading: boolean
  error: string | null
  actual: ActualPoint[]
  provenance: SnapshotProvenance | null
  interest: ObservedInterest | null
}

/**
 * PostgREST `or` filter for the rows a lender calls interest.
 *
 * Four different wordings appear across the connected banks — "INTEREST
 * CHARGE:PURCHASES", "Interest Charge On Purchases", "PURCHASE INTEREST CHARGE"
 * and "Purchase Finance Charge" — so this matches on the two words that survive
 * all of them rather than on any one lender's phrasing. `*` is PostgREST's
 * wildcard; `%` in a filter string has to be percent-encoded and quietly matches
 * nothing when it is not.
 */
const INTEREST_FILTER = [
  'name.ilike.*interest*',
  'name.ilike.*finance charge*',
  'merchant_name.ilike.*interest*',
  'merchant_name.ilike.*finance charge*',
].join(',')

/**
 * Deliberately BELOW Supabase's default db-max-rows of 1000.
 *
 * The loop's only signal that it has reached the end is a page shorter than the
 * window it asked for. At exactly 1000 that signal is borrowed from the server's
 * cap rather than owned: if the cap is ever lowered, every page comes back short
 * on the first request, the loop stops, and the silent-truncation bug this
 * paging exists to fix returns — with the paging code still present and still
 * looking correct. A smaller window keeps the two numbers independent.
 */
const PAGE = 500

/**
 * Every measured snapshot, a page at a time.
 *
 * PostgREST caps a response at 1000 rows by default and says nothing when it
 * does. A nightly Plaid reading on twenty-three accounts reaches that cap in
 * about six weeks — and because these come back ascending by as_of, the rows
 * dropped would be the NEWEST ones: the measured line would quietly stop moving
 * while every balance beside it carried on. So ask for pages until one comes
 * back short.
 */
async function fetchMeasuredSnapshots(): Promise<{ data: SnapshotRow[]; error: string | null }> {
  const all: SnapshotRow[] = []
  for (let from = 0; ; from += PAGE) {
    const res = await supabase
      .from('balance_snapshots')
      .select('account_id, balance, as_of, created_at, source')
      .in('source', MEASURED_SOURCES)
      // A TOTAL order, which is what .range() paging actually requires — every
      // row's sort key unique. (as_of, created_at) is not one: a sync writes
      // every account in a single batch, so they share both. 95 of the 101
      // measured rows on record today sit in such a tie and the largest is ten
      // rows wide. Each page is a separate statement, the planner picks a
      // different sort per page (top-N heapsort while limit+offset is small,
      // quicksort above it) and neither is stable, so tied rows at a page
      // boundary come back on two pages or on none. account_id closes it:
      // (as_of, created_at, account_id) is unique across the whole table.
      // Latent only while the measured set stays under 1000 rows — which the
      // comment above puts at about six weeks of nightly readings.
      .order('as_of')
      .order('created_at')
      .order('account_id')
      .range(from, from + PAGE - 1)

    if (res.error) return { data: all, error: res.error.message }

    const rows = (res.data ?? []) as unknown as SnapshotRow[]
    all.push(...rows)
    if (rows.length < PAGE) return { data: all, error: null }
  }
}

/**
 * Snapshots and interest transactions for the Progress tab.
 *
 * Kept out of DataProvider: this is one page's data, it is not needed to render
 * anything else, and a failure here must not blank the app.
 */
export function useProgressData(debts: Account[], planStartedOn: string | null): ProgressData {
  const [rows, setRows] = useState<SnapshotRow[] | null>(null)
  const [totalSnapshots, setTotalSnapshots] = useState(0)
  const [interestRows, setInterestRows] = useState<
    { account_id: string; amount: number | string | null }[] | null
  >(null)
  const [everRows, setEverRows] = useState<{ account_id: string }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * The interest reads are tracked separately from the snapshot read because a
   * failure means something different here.
   *
   * A short snapshot read still draws a shorter line. A failed transaction read
   * returns an empty array, and an empty array of interest charges is
   * indistinguishable from no interest having been charged — so the page would
   * print "$0.00 — nothing yet, and no interest has posted since", which is a
   * confident factual claim manufactured out of a network error. This page
   * reports; it does not fill a gap with the most flattering reading of it.
   */
  const [interestFailed, setInterestFailed] = useState(false)

  useEffect(() => {
    let active = true

    void (async () => {
      const [snaps, allCount, since, ever] = await Promise.all([
        fetchMeasuredSnapshots(),
        // Counted, not fetched: the reconstructed rows are only ever quoted as a
        // number in the provenance note, and there are over a thousand of them.
        // A head count of the whole table minus the measured rows gives that
        // number without dragging the rows themselves over the wire.
        supabase.from('balance_snapshots').select('id', { count: 'exact', head: true }),
        planStartedOn
          ? supabase
              .from('transactions')
              .select('account_id, amount')
              .gte('posted_on', planStartedOn)
              .or(INTEREST_FILTER)
          : Promise.resolve({ data: [], error: null, count: null }),
        supabase.from('transactions').select('account_id').or(INTEREST_FILTER),
      ])

      if (!active) return

      // A partial read still carries real readings, so keep what came back and
      // say what failed rather than blanking the line.
      const failures = [
        snaps.error,
        allCount.error?.message ?? null,
        since.error?.message ?? null,
        ever.error?.message ?? null,
      ].filter((m): m is string => m !== null)

      setError(failures.length > 0 ? `Some of this page could not be loaded: ${failures[0]}` : null)
      setRows(snaps.data)

      setInterestFailed(since.error !== null || ever.error !== null)
      setTotalSnapshots(allCount.count ?? 0)
      setInterestRows(
        (since.data ?? []) as unknown as { account_id: string; amount: number | string | null }[],
      )
      setEverRows((ever.data ?? []) as unknown as { account_id: string }[])
    })()

    return () => {
      active = false
    }
  }, [planStartedOn])

  return useMemo(() => {
    if (rows === null) {
      return { loading: true, error, actual: [], provenance: null, interest: null }
    }

    const debtIds = new Set(debts.map((d) => d.id))

    /**
     * Only debt accounts, and only money going OUT.
     *
     * Both filters are load-bearing. The savings account posts "Monthly Interest
     * Paid" every month — interest EARNED, stored negative as income — and it
     * matches the same word. Counting it would net real interest charges against
     * three cents of savings interest and call the result interest paid.
     */
    const charges = (interestRows ?? []).filter(
      (r) => debtIds.has(r.account_id) && num(r.amount) > 0,
    )
    const everCharged = new Set(
      (everRows ?? []).map((r) => r.account_id).filter((id) => debtIds.has(id)),
    )

    return {
      loading: false,
      error,
      actual: buildActualSeries(rows, debtIds),
      provenance: describeSnapshots(rows, debts, Math.max(0, totalSnapshots - rows.length)),
      // null, not a zeroed-out object: the page has to be able to tell "no
      // interest was charged" from "we could not find out".
      interest: interestFailed ? null : {
        total: round2(charges.reduce((s, r) => s + num(r.amount), 0)),
        rows: charges.length,
        accountsSeen: new Set(charges.map((r) => r.account_id)).size,
        accountsEverSeen: everCharged.size,
        debtAccounts: debts.length,
        since: planStartedOn,
      },
    }
  }, [rows, totalSnapshots, interestRows, everRows, debts, planStartedOn, error, interestFailed])
}
