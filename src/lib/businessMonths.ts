import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase'
import { useData } from './data'
import { isoDate } from './format'
import {
  buildContext,
  summarise,
  type BizTxn,
  type BusinessPayer,
  type BusinessSummary,
} from './business'

/**
 * The Business page's own read.
 *
 * The shared data provider deliberately fetches the CURRENT month only — that is
 * what the home screen reports on, and widening it would slow every page down for
 * one. This page needs half a year to say anything at all about whether the
 * business is holding its own, so it makes its own query and nothing here goes
 * into data.tsx.
 *
 * Scoped to `is_business` accounts by id. That is the only definition of business
 * money there is and should be: whose money a row is follows from the account it
 * sits on, never from a per-row flag someone could flip by relabelling a bucket.
 */

/** How far back to read. Eight months so six full ones always survive the window. */
const MONTHS_BACK = 8

export interface BalanceReading {
  as_of: string
  balance: number
  source: string
}

export interface BusinessMonthsView {
  loading: boolean
  error: string | null
  summary: BusinessSummary | null
  /**
   * Balance readings for the business's cash account, oldest first.
   *
   * Only what was actually recorded. 5star has five rows, all inside four days,
   * because it was linked on the 15th — the page says so rather than drawing a
   * confident line, and no history is reconstructed to fill the gap.
   */
  cashReadings: BalanceReading[]
  /** The oldest business transaction on record anywhere, window or not. */
  earliestOnRecord: string | null
  refresh: () => void
}

/** First day of the month `back` months before today, as YYYY-MM-DD. */
function windowStart(back: number, now = new Date()): string {
  return isoDate(new Date(now.getFullYear(), now.getMonth() - back, 1))
}

export function useBusinessMonths(): BusinessMonthsView {
  const { businessAccounts, accounts, memberNames, loading: dataLoading } = useData()

  const [txns, setTxns] = useState<BizTxn[] | null>(null)
  const [cashReadings, setCashReadings] = useState<BalanceReading[]>([])
  const [earliestOnRecord, setEarliestOnRecord] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /**
   * The ids, as a stable string.
   *
   * businessAccounts is a fresh array on every provider render, so keying the
   * fetch callback on it refetched the whole window on each one. The ids are what
   * actually decides the query.
   */
  const idKey = useMemo(
    () => businessAccounts.map((a) => a.id).sort().join(','),
    [businessAccounts],
  )
  const ids = useMemo(() => (idKey ? idKey.split(',') : []), [idKey])

  /** Guards against a slower earlier request landing after a newer one. */
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    if (ids.length === 0) {
      // Not an error and not an empty business — the accounts simply have not
      // arrived yet. Staying in `loading` avoids a flash of "nothing recorded".
      setTxns(null)
      setCashReadings([])
      setLoading(dataLoading)
      return
    }

    const seq = ++seqRef.current
    setLoading(true)
    setError(null)

    const from = windowStart(MONTHS_BACK)

    const [txnRes, snapRes, earliestRes] = await Promise.all([
      supabase
        .from('transactions')
        .select('id, account_id, posted_on, name, merchant_name, amount, plaid_category')
        .in('account_id', ids)
        .gte('posted_on', from)
        .order('posted_on', { ascending: true }),
      // Bounded by the same window as the transactions beside it. Unbounded,
      // this read the entire snapshot history for all three business accounts —
      // 224 rows today, growing by three a day, against PostgREST's silent
      // 1000-row cap. Ordered ascending, the rows it would eventually drop are
      // the newest ones, so the balance trend would quietly stop updating while
      // still looking complete.
      supabase
        .from('balance_snapshots')
        .select('account_id, as_of, balance, source')
        .in('account_id', ids)
        .gte('as_of', from)
        .order('as_of', { ascending: true }),
      supabase
        .from('transactions')
        .select('posted_on')
        .in('account_id', ids)
        .order('posted_on', { ascending: true })
        .limit(1),
    ])

    if (seq !== seqRef.current) return

    // An empty window and a failed read are not the same statement, and only one
    // of them is true. Saying "nothing recorded" over a broken query would report
    // a business with no revenue.
    if (txnRes.error) {
      setError(txnRes.error.message)
      setTxns([])
      setLoading(false)
      return
    }

    // PostgREST serialises numeric as a STRING — "31000.00". Coerced at the
    // boundary, once, or every sum downstream concatenates instead of adding.
    setTxns(
      (txnRes.data ?? []).map((r: Record<string, unknown>) => ({
        id: r.id as string,
        account_id: r.account_id as string,
        posted_on: r.posted_on as string,
        name: (r.name as string) ?? '',
        merchant_name: (r.merchant_name as string | null) ?? null,
        amount: Number(r.amount ?? 0),
        plaid_category: (r.plaid_category as string | null) ?? null,
      })),
    )

    // The trend is the business's CASH. A card's balance is a debt and moves the
    // opposite way, so plotting both on one axis would invent a relationship.
    const cashIds = new Set(
      businessAccounts.filter((a) => a.kind === 'checking' || a.kind === 'savings').map((a) => a.id),
    )
    setCashReadings(
      (snapRes.data ?? [])
        .filter((r: Record<string, unknown>) => cashIds.has(r.account_id as string))
        .map((r: Record<string, unknown>) => ({
          as_of: r.as_of as string,
          balance: Number(r.balance ?? 0),
          source: (r.source as string) ?? 'plaid',
        })),
    )

    setEarliestOnRecord(
      ((earliestRes.data ?? [])[0] as { posted_on?: string } | undefined)?.posted_on ?? null,
    )
    setLoading(false)
  }, [ids, businessAccounts, dataLoading])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * The clients, read from business_payers rather than written into source —
   * this repository is public and a client relationship is not ours to publish.
   * A failed read leaves the list empty, which reports every deposit as "Other"
   * rather than inventing a payer.
   */
  const [payers, setPayers] = useState<BusinessPayer[]>([])

  useEffect(() => {
    let active = true
    void (async () => {
      const res = await supabase
        .from('business_payers')
        .select('id, match_text, label, sort_order')
        .order('sort_order')
      if (!active || res.error) return
      setPayers(
        (res.data ?? []).map((r: Record<string, unknown>) => ({
          key: r.id as string,
          needle: String(r.match_text ?? '').toLowerCase(),
          label: String(r.label ?? ''),
        })),
      )
    })()
    return () => {
      active = false
    }
  }, [])

  const ctx = useMemo(
    () => buildContext(accounts, memberNames, payers),
    [accounts, memberNames, payers],
  )

  const summary = useMemo(
    () => (txns === null ? null : summarise(txns, ctx, earliestOnRecord)),
    [txns, ctx, earliestOnRecord],
  )

  return {
    loading: loading || dataLoading,
    error,
    summary,
    cashReadings,
    earliestOnRecord,
    refresh: () => void load(),
  }
}
