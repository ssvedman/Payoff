import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase'
import { isBusinessTxn, useData, type Transaction } from './data'
import { isoDate, MONTH_NAMES } from './format'

/**
 * Paging back through months, shared by /activity and /month.
 *
 * The shared data layer loads the CURRENT month only, because that is what the
 * home screen reports on. Anything older is fetched here. This lived inside
 * /activity until /month needed it too, and the pieces that make it correct —
 * the floor at the oldest recorded month, the guard against a slow request
 * painting the wrong month, telling an empty month apart from a failed one —
 * are exactly the pieces a second copy would get subtly wrong.
 */
export interface MonthView {
  /** First day of the month on screen. */
  anchor: Date
  goPrev: () => void
  goNext: () => void
  /** The anchor is the current calendar month. */
  thisMonth: boolean
  /** Nothing is recorded before this month, so there is nowhere further back. */
  atEarliest: boolean
  /** The month's HOUSEHOLD transactions — business already excluded. */
  transactions: Transaction[]
  /** The month's transactions including the business's. The ledger view only. */
  allTransactions: Transaction[]
  loading: boolean
  error: string | null
  /** Reload the month on screen — after a row is relabelled, say. */
  refresh: () => void
  /** "September 2026", for a heading. */
  label: string
}

export function useMonthView(): MonthView {
  const {
    transactions: currentHousehold,
    allTransactions: currentAll,
    accounts,
    loading: dataLoading,
    refresh: refreshCurrent,
  } = useData()

  const [anchor, setAnchor] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [pastTxns, setPastTxns] = useState<Transaction[] | null>(null)
  const [loadingMonth, setLoadingMonth] = useState(false)
  const [monthError, setMonthError] = useState<string | null>(null)

  /**
   * The oldest month there is anything to show.
   *
   * Plaid only hands over a fixed window at link time, so the record starts
   * where the first item's window started and nothing exists before it. Paging
   * back into those months returns "No transactions", which reads as a fault
   * rather than as the edge of the record. Read it from the data rather than
   * hard-coding a date: every nightly sync appends, so the floor moves back on
   * its own as older items are linked, and never forward.
   */
  const [earliest, setEarliest] = useState<Date | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      const { data } = await supabase
        .from('transactions')
        .select('posted_on')
        .order('posted_on', { ascending: true })
        .limit(1)
      if (!active) return
      const iso = (data ?? [])[0]?.posted_on
      if (!iso) return
      const [y, m] = String(iso).split('-').map(Number)
      setEarliest(new Date(y, m - 1, 1))
    })()
    return () => {
      active = false
    }
  }, [])

  const thisMonth = useMemo(() => {
    const n = new Date()
    return anchor.getFullYear() === n.getFullYear() && anchor.getMonth() === n.getMonth()
  }, [anchor])

  const atEarliest = useMemo(
    () =>
      earliest !== null &&
      anchor.getFullYear() === earliest.getFullYear() &&
      anchor.getMonth() === earliest.getMonth(),
    [anchor, earliest],
  )

  const monthBounds = useMemo(() => {
    const from = isoDate(new Date(anchor.getFullYear(), anchor.getMonth(), 1))
    const to = isoDate(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0))
    return { from, to }
  }, [anchor])

  /** Guards against a slower earlier month landing after a newer one. */
  const monthSeq = useRef(0)

  const loadMonth = useCallback(async () => {
    if (thisMonth) {
      setPastTxns(null)
      setMonthError(null)
      return
    }
    const seq = ++monthSeq.current
    setLoadingMonth(true)
    setMonthError(null)

    const { data, error: qErr } = await supabase
      .from('transactions')
      .select('*')
      .gte('posted_on', monthBounds.from)
      .lte('posted_on', monthBounds.to)
      .order('posted_on', { ascending: false })

    // Tapping back through months faster than they load meant an older request
    // could resolve last and paint the wrong month's rows under the right
    // month's heading.
    if (seq !== monthSeq.current) return

    // A failed query used to render as "No transactions in August" — an empty
    // month and a broken one are not the same statement, and only one of them
    // is true.
    if (qErr) {
      setMonthError(qErr.message)
      setPastTxns([])
      setLoadingMonth(false)
      return
    }

    setPastTxns(
      (data ?? []).map((t) => ({ ...(t as unknown as Transaction), amount: Number(t.amount) })),
    )
    setLoadingMonth(false)
  }, [thisMonth, monthBounds])

  useEffect(() => {
    void loadMonth()
  }, [loadMonth])

  const businessAccountIds = useMemo(
    () => new Set(accounts.filter((a) => a.is_business).map((a) => a.id)),
    [accounts],
  )

  /**
   * An older month is narrowed to the household here, the same way the provider
   * narrows the current one — so a caller never has to remember which month it
   * is looking at before trusting a total.
   */
  const allTransactions = thisMonth ? currentAll : (pastTxns ?? [])
  const transactions = useMemo(
    () =>
      thisMonth
        ? currentHousehold
        : allTransactions.filter((t) => !isBusinessTxn(t, businessAccountIds)),
    [thisMonth, currentHousehold, allTransactions, businessAccountIds],
  )

  return {
    anchor,
    goPrev: () => setAnchor((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1)),
    goNext: () => setAnchor((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1)),
    thisMonth,
    atEarliest,
    transactions,
    allTransactions,
    loading: thisMonth ? dataLoading : loadingMonth,
    refresh: () => (thisMonth ? refreshCurrent() : void loadMonth()),
    error: monthError,
    label: `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`,
  }
}

/** The ‹ September 2026 › control. One markup, so the two pages match. */
export function MonthNav({
  view,
  bordered,
  /** /month names the month in its own heading, so the control would say it twice. */
  showLabel = true,
}: {
  view: MonthView
  bordered?: boolean
  showLabel?: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
        ...(bordered ? { borderBottom: '1px solid var(--line)', paddingBottom: 10 } : null),
      }}
    >
      <button
        type="button"
        className="btn ghost"
        style={{ width: 'auto', padding: '6px 12px', fontSize: 13, opacity: view.atEarliest ? 0.35 : 1 }}
        aria-label="Previous month"
        disabled={view.atEarliest}
        onClick={view.goPrev}
      >
        ‹
      </button>
      <div className="sm tnum" style={{ fontWeight: 700 }}>
        {showLabel ? view.label : ''}
      </div>
      <button
        type="button"
        className="btn ghost"
        style={{ width: 'auto', padding: '6px 12px', fontSize: 13, opacity: view.thisMonth ? 0.35 : 1 }}
        aria-label="Next month"
        disabled={view.thisMonth}
        onClick={view.goNext}
      >
        ›
      </button>
    </div>
  )
}
