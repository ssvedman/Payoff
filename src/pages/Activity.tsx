import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useData, type Transaction } from '../lib/data'
import { ruleTextFor } from '../lib/categorize'
import { accountLabel, dayHeading, isoDate, signedMoney, MONTH_NAMES } from '../lib/format'
import type { Bucket, MerchantRuleRow, TransactionRow } from '../lib/database.types'

/** Pill colors per BUILD.md §8. Amber is "Optional" only, exactly as mockups.html shows. */
const BUCKETS: { key: Bucket; label: string; bg: string; tx: string }[] = [
  { key: 'fixed', label: 'Fixed', bg: 'var(--neutral-bg)', tx: 'var(--neutral-tx)' },
  { key: 'optional', label: 'Optional', bg: 'var(--amber-bg)', tx: 'var(--amber-tx)' },
  { key: 'attack', label: 'Attack', bg: 'var(--green-bg)', tx: 'var(--green-tx)' },
  { key: 'savings', label: 'Savings', bg: 'var(--green-bg)', tx: 'var(--green-tx)' },
  { key: 'income', label: 'Income', bg: 'var(--green-bg)', tx: 'var(--green-tx)' },
  { key: 'transfer', label: 'Transfer', bg: 'var(--neutral-bg)', tx: 'var(--neutral-tx)' },
  { key: 'review', label: 'Review', bg: 'var(--red-bg)', tx: 'var(--red-tx)' },
]

const bucketStyle = (b: Bucket) => BUCKETS.find((x) => x.key === b) ?? BUCKETS[6]

type Filter = 'all' | 'review' | 'optional'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'review', label: 'Needs review' },
  { key: 'optional', label: 'Optional' },
]

/** Same haystack the categorization chain uses: raw descriptor plus merchant name. */
const matchesRuleText = (t: Transaction, text: string) =>
  `${t.name ?? ''} ${t.merchant_name ?? ''}`.toLowerCase().includes(text)

export default function Activity() {
  const { loading, error, accounts, transactions: currentMonthTxns, refresh, budgetLines } = useData()

  /**
   * Which month is on screen. The shared data layer loads the current month only,
   * because that is what the home and month screens report on — so anything older
   * is fetched here. Defaults to the month being viewed.
   */
  const [anchor, setAnchor] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [pastTxns, setPastTxns] = useState<Transaction[] | null>(null)
  const [loadingMonth, setLoadingMonth] = useState(false)

  /**
   * The oldest month there is anything to show.
   *
   * Plaid only hands over a fixed window at link time, so the record starts where
   * the first item's window started and nothing exists before it. Paging back into
   * those months returns "No transactions", which reads as a fault rather than as
   * the edge of the record. Read it from the data rather than hard-coding a date:
   * every nightly sync appends, so the floor moves back on its own as older items
   * are linked, and never forward — rows are only ever deleted on Plaid's explicit
   * removed[] (a pending charge superseded by its posted twin), never by ageing.
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

  /** At the oldest recorded month, so there is nothing further back to show. */
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

  const [monthError, setMonthError] = useState<string | null>(null)
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

  /** The current month comes from the shared loader; older months from here. */
  const transactions = thisMonth ? currentMonthTxns : (pastTxns ?? [])
  const { user } = useAuth()

  const [filter, setFilter] = useState<Filter>('all')

  /**
   * Needs review is a QUEUE, not a view of a month.
   *
   * It was filtered by the month on screen like everything else, so a row that
   * arrived in a month nobody happened to be looking at simply never appeared —
   * and the queue read as empty while items sat in it. Connecting a bank that
   * hands over two years of history made that acute: everything older than the
   * current month was invisible the moment it landed.
   *
   * So this filter reads across all time. The month control does not apply to
   * it and is hidden while it is on.
   */
  const [reviewRows, setReviewRows] = useState<Transaction[] | null>(null)
  const [reviewErr, setReviewErr] = useState<string | null>(null)

  const loadReview = useCallback(async () => {
    const { data, error: qErr } = await supabase
      .from('transactions')
      .select('*')
      .eq('bucket', 'review')
      .order('posted_on', { ascending: false })

    if (qErr) {
      setReviewErr(qErr.message)
      setReviewRows([])
      return
    }
    setReviewErr(null)
    setReviewRows(
      (data ?? []).map((t) => ({ ...(t as unknown as Transaction), amount: Number(t.amount) })),
    )
  }, [])

  useEffect(() => {
    if (filter !== 'review') return
    void loadReview()
  }, [filter, loadReview])
  const [openId, setOpenId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const accountName = useMemo(() => {
    // Owner-first, matching the queue and the accounts list.
    const byId = new Map(accounts.map((a) => [a.id, accountLabel(a)]))
    return (id: string) => byId.get(id) ?? 'Unlinked account'
  }, [accounts])

  const visible = useMemo(() => {
    const rows =
      filter === 'review'
        ? (reviewRows ?? [])
        : filter === 'all'
          ? transactions
          : transactions.filter((t) => t.bucket === filter)
    return [...rows].sort((a, b) => (a.posted_on < b.posted_on ? 1 : a.posted_on > b.posted_on ? -1 : 0))
  }, [transactions, filter, reviewRows])

  const days = useMemo(() => {
    const groups: { date: string; rows: Transaction[] }[] = []
    for (const t of visible) {
      const last = groups[groups.length - 1]
      if (last && last.date === t.posted_on) last.rows.push(t)
      else groups.push({ date: t.posted_on, rows: [t] })
    }
    return groups
  }, [visible])


  /** The budget lines belonging to a bucket. Only fixed and optional have any. */
  const linesFor = useCallback(
    (bucket: string) =>
      budgetLines
        .filter((l) => l.bucket === bucket)
        .sort((a, b) => a.sort_order - b.sort_order),
    [budgetLines],
  )

  /**
   * `lineId` is deliberately three-valued:
   *   undefined — leave the budget line exactly as it is
   *   null      — clear it
   *   a string  — set it
   *
   * The distinction matters. An earlier version wrote `lineId ?? null`, so simply
   * re-tapping the bucket a transaction was already in silently erased its line —
   * changing a label destroyed data the user never touched.
   */
  async function choose(t: Transaction, chosen: Bucket, lineId?: string | null) {
    setSaving(true)
    setSaveError(null)
    try {
      const text = ruleTextFor(t)

      // a. The merchant rule, so the choice sticks for that merchant.
      // Every payload below is checked against the generated Insert/Update shapes —
      // no casts, so a renamed column fails the build rather than the write.
      if (text) {
        const rule: Partial<MerchantRuleRow> = {
          match_text: text,
          bucket: chosen,
          // A rule pins the line as well, so correcting one coffee shop teaches
          // every future one rather than just this row. Left untouched when no
          // line was part of this choice.
          ...(lineId === undefined ? {} : { budget_line_id: lineId }),
          created_by: user?.id ?? null,
        }
        const { error: ruleError } = await supabase
          .from('merchant_rules')
          .upsert(rule, { onConflict: 'match_text' })
        if (ruleError) throw ruleError
      }

      // b. This transaction, marked manual so nothing recomputes it.
      const manual: Partial<TransactionRow> = {
        bucket: chosen,
        bucket_source: 'manual',
        ...(lineId === undefined ? {} : { budget_line_id: lineId }),
      }
      const { error: txError } = await supabase
        .from('transactions')
        .update(manual)
        .eq('id', t.id)
      if (txError) throw txError

      // c. The rest of the loaded month, in one call. Manual overrides are left alone.
      const ids = text
        ? transactions
            .filter((o) => o.id !== t.id && o.bucket_source !== 'manual' && matchesRuleText(o, text))
            .map((o) => o.id)
        : []
      if (ids.length > 0) {
        const byRule: Partial<TransactionRow> = {
          bucket: chosen,
          bucket_source: 'rule',
          ...(lineId === undefined ? {} : { budget_line_id: lineId }),
        }
        const { error: bulkError } = await supabase
          .from('transactions')
          .update(byRule)
          .in('id', ids)
        if (bulkError) throw bulkError
      }

      // d. Re-read whichever month is on screen — and the review queue too, if
      // that is what is being worked through. Without this a row kept its place
      // in the queue after being categorised, so the list never got shorter and
      // there was no way to tell what was left.
      await refresh()
      await loadMonth()
      if (filter === 'review') await loadReview()
      setOpenId(null)
    } catch (e) {
      console.error('Recategorization failed', e)
      setSaveError('That label did not save.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 4 }}>Activity</div>
      <div className="tiny muted" style={{ marginBottom: 14 }}>
        Tap a label to recategorize. It sticks for that merchant.
      </div>

      {/* Month switcher. Forward is disabled at the current month — there is
          nothing recorded ahead of today, and an empty future month reads as a
          fault rather than as the calendar. Back is disabled at the oldest month
          on record, for the same reason in the other direction.

          Hidden entirely while the review queue is on: that filter reads across
          all time, so a month control would sit there implying it narrowed
          something and quietly contradicting what is on screen. */}
      {filter !== 'review' && (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
          borderBottom: '1px solid var(--line)',
          paddingBottom: 10,
        }}
      >
        <button
          type="button"
          className="btn ghost"
          style={{ width: 'auto', padding: '6px 12px', fontSize: 13, opacity: atEarliest ? 0.35 : 1 }}
          aria-label="Previous month"
          disabled={atEarliest}
          onClick={() => setAnchor((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
        >
          ‹
        </button>
        <div className="sm tnum" style={{ fontWeight: 700 }}>
          {MONTH_NAMES[anchor.getMonth()]} {anchor.getFullYear()}
        </div>
        <button
          type="button"
          className="btn ghost"
          style={{ width: 'auto', padding: '6px 12px', fontSize: 13, opacity: thisMonth ? 0.35 : 1 }}
          aria-label="Next month"
          disabled={thisMonth}
          onClick={() => setAnchor((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
        >
          ›
        </button>
      </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => {
          const on = filter === f.key
          return (
            <button
              key={f.key}
              type="button"
              className="pill"
              aria-pressed={on}
              onClick={() => setFilter(f.key)}
              style={
                on
                  ? { background: 'var(--ink)', color: '#fff' }
                  : { background: 'var(--white)', color: 'var(--steel)', border: '1px solid var(--line)' }
              }
            >
              {f.label}
            </button>
          )
        })}
      </div>

      {error && (
        <div className="banner banner--red sm" style={{ marginBottom: 14, fontWeight: 600 }}>
          Activity could not be loaded.
        </div>
      )}

      {/*
        The skeleton is for the first load only. `refresh()` after a
        recategorization flips `loading` back on, and swapping a list the user is
        looking at for skeletons reads as a fault. Rows already on screen stay put.
      */}
      {loading && transactions.length === 0 ? (
        <div>
          <div className="skeleton" style={{ width: 62, height: 9, marginBottom: 12 }} />
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                padding: '12px 0',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <div style={{ flex: 1 }}>
                <div className="skeleton" style={{ width: '44%', height: 10, marginBottom: 6 }} />
                <div className="skeleton" style={{ width: '28%', height: 8 }} />
              </div>
              <div className="skeleton" style={{ width: 54, height: 15, borderRadius: 11 }} />
              <div className="skeleton" style={{ width: 56, height: 10 }} />
            </div>
          ))}
        </div>
      ) : loadingMonth ? (
        <div className="sm muted" style={{ textAlign: 'center', padding: '34px 0' }}>
          Loading {MONTH_NAMES[anchor.getMonth()]}…
        </div>
      ) : days.length === 0 ? (
        // Nothing loaded is not the same as nothing there: when the read failed the
        // message above already states that, and claiming an empty month would be wrong.
        error ? null : (
          <div className="sm muted" style={{ textAlign: 'center', padding: '34px 0' }}>
            {filter === 'review'
              ? reviewErr
                ? `The review queue could not be loaded — ${reviewErr}`
                : 'Nothing needs review.'
              : filter === 'all'
                ? monthError
                  ? `${MONTH_NAMES[anchor.getMonth()]} could not be loaded — ${monthError}`
                  : `No transactions in ${MONTH_NAMES[anchor.getMonth()]}.`
                : 'Nothing in this filter.'}
          </div>
        )
      ) : (
        days.map((day, di) => (
          <div key={day.date}>
            <div
              className="tiny muted tnum"
              style={{ fontWeight: 700, margin: di === 0 ? '0 0 6px' : '16px 0 6px' }}
            >
              {dayHeading(day.date)}
            </div>
            <table>
              <tbody>
                {day.rows.map((t) => {
                  const pill = bucketStyle(t.bucket)
                  const open = openId === t.id
                  const sub = t.pending ? `${accountName(t.account_id)} · pending` : accountName(t.account_id)
                  // Empty only when the row has neither a merchant name nor a descriptor,
                  // in which case no rule is written and the change is this row alone.
                  const ruleText = ruleTextFor(t)
                  return (
                    <Fragment key={t.id}>
                      <tr>
                        <td>
                          <div className="sm" style={{ fontWeight: 600 }}>
                            {t.name}
                          </div>
                          <div className="tiny muted">{sub}</div>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className="pill"
                            aria-expanded={open}
                            aria-label={`${t.name} is labelled ${pill.label}. Change label.`}
                            onClick={() => {
                              setSaveError(null)
                              setOpenId(open ? null : t.id)
                            }}
                            style={{ background: pill.bg, color: pill.tx }}
                          >
                            {pill.label}
                          </button>
                        </td>
                        <td
                          className="tnum sm"
                          style={{
                            textAlign: 'right',
                            width: 64,
                            color: t.amount < 0 ? 'var(--green)' : undefined,
                          }}
                        >
                          {signedMoney(t.amount)}
                        </td>
                      </tr>

                      {open && (
                        <tr>
                          <td colSpan={3} style={{ paddingTop: 0 }}>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                              {BUCKETS.map((b) => (
                                <button
                                  key={b.key}
                                  type="button"
                                  className="pill"
                                  disabled={saving}
                                  onClick={() =>
                                    // A line belongs to exactly one bucket, so a real
                                    // bucket change clears it. Re-tapping the bucket it
                                    // is already in leaves the line untouched.
                                    void choose(t, b.key, b.key === t.bucket ? undefined : null)
                                  }
                                  style={{
                                    background: b.bg,
                                    color: b.tx,
                                    opacity: saving ? 0.5 : 1,
                                    boxShadow: t.bucket === b.key ? 'inset 0 0 0 1px var(--ink)' : undefined,
                                  }}
                                >
                                  {b.label}
                                </button>
                              ))}
                            </div>

                            {/* Which target it counts against. Only fixed and
                                optional have lines; the other buckets are not
                                budgeted, so nothing is offered for them. */}
                            {linesFor(t.bucket).length > 0 && (
                              <div
                                style={{
                                  display: 'flex',
                                  gap: 6,
                                  flexWrap: 'wrap',
                                  alignItems: 'center',
                                  marginTop: 8,
                                  paddingTop: 8,
                                  borderTop: '1px solid var(--line)',
                                }}
                              >
                                <span className="tiny muted" style={{ marginRight: 2 }}>
                                  Counts against
                                </span>
                                {linesFor(t.bucket).map((l) => {
                                  const on = t.budget_line_id === l.id
                                  return (
                                    <button
                                      key={l.id}
                                      type="button"
                                      className="pill"
                                      disabled={saving}
                                      onClick={() => void choose(t, t.bucket, on ? null : l.id)}
                                      style={{
                                        background: on ? 'var(--ink)' : 'var(--white)',
                                        color: on ? '#fff' : 'var(--steel)',
                                        border: on ? 'none' : '1px solid var(--line)',
                                        opacity: saving ? 0.5 : 1,
                                      }}
                                    >
                                      {l.line_name}
                                    </button>
                                  )
                                })}
                              </div>
                            )}

                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                              {/* Reported beside the buckets, where the tap happened —
                                  a message at the top of a long list is never seen. */}
                              <span
                                className={saveError ? 'tiny' : 'tiny muted'}
                                role="status"
                                style={saveError ? { color: 'var(--red)' } : undefined}
                              >
                                {saving
                                  ? 'Saving'
                                  : saveError
                                    ? saveError
                                    : ruleText
                                      ? `Applies to ${t.merchant_name ?? t.name} this month.`
                                      : 'Applies to this transaction.'}
                              </span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  )
}
