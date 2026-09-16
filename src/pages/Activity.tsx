import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import Recategorizer, { bucketStyle, type MoveNotice } from '../components/Recategorizer'
import MoveNoticeBar from '../components/MoveNoticeBar'
import GroupedActivity, { GROUPINGS, type GroupBy } from '../components/GroupedActivity'
import { useData, isBusinessTxn, type Transaction } from '../lib/data'
import { accountDescriptor, dayHeading, isoDate, signedMoney, MONTH_NAMES } from '../lib/format'

type Filter = 'all' | 'review' | 'optional'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'review', label: 'Needs review' },
  { key: 'optional', label: 'Optional' },
]

export default function Activity() {
  const {
    loading,
    error,
    accounts,
    allTransactions: currentMonthTxns,
    businessAccountIds,
    refresh,
  } = useData()

  /**
   * Whether the business's own spending is in the list.
   *
   * Activity is the ledger, and the ledger holds everything the banks reported —
   * business rows included, because they are still tracked, still charted and
   * still count toward a balance. What they are NOT is household spending: the
   * budget on /month excludes them entirely.
   *
   * So this page reads from `allTransactions`, not the household-narrowed
   * `transactions`, and hides the business rows by default so that what is
   * listed and what is budgeted agree. The control below says so out loud, with
   * a count, because a silently shorter list is indistinguishable from missing
   * data — the same failure this app has already been bitten by.
   */
  const [showBusiness, setShowBusiness] = useState(false)

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
  /**
   * Whether the rows are read as a ledger or rolled up.
   *
   * A day-by-day list answers "what happened", which is the wrong question when
   * something looks off — a pattern spread over forty-five unremarkable charges
   * is invisible in it. Grouping puts the largest thing first.
   */
  const [groupBy, setGroupBy] = useState<GroupBy | null>(null)

  const [openId, setOpenId] = useState<string | null>(null)

  /**
   * The last relabel, so the page can say where the row went.
   *
   * Every chip except "All" is a bucket filter, so a bucket change usually
   * removes the row from what is on screen. Reported as a disappearance.
   */
  const [notice, setNotice] = useState<MoveNotice | null>(null)
  const clearNotice = useCallback(() => setNotice(null), [])

  // A relabel that lands outside the chip currently held down is gone from view.
  const noticeLeftView =
    notice !== null &&
    notice.from !== null &&
    filter !== 'all' &&
    (filter === 'review' ? notice.to !== 'review' : notice.to !== filter)

  const accountName = useMemo(() => {
    // Owner-first, matching the queue and the accounts list.
    const byId = new Map(accounts.map((a) => [a.id, accountDescriptor(a)]))
    return (id: string) => byId.get(id) ?? 'Unlinked account'
  }, [accounts])

  useEffect(() => {
    setNotice(null)
  }, [filter, anchor])

  const visible = useMemo(() => {
    const rows =
      filter === 'review'
        ? (reviewRows ?? [])
        : filter === 'all'
          ? transactions
          : transactions.filter((t) => t.bucket === filter)
    const kept = showBusiness
      ? rows
      : rows.filter((t) => !isBusinessTxn(t, businessAccountIds))
    return [...kept].sort((a, b) => (a.posted_on < b.posted_on ? 1 : a.posted_on > b.posted_on ? -1 : 0))
  }, [transactions, filter, reviewRows, showBusiness, businessAccountIds])

  /** How many the toggle is holding back, so the control can say it. */
  const businessHidden = useMemo(() => {
    const rows =
      filter === 'review'
        ? (reviewRows ?? [])
        : filter === 'all'
          ? transactions
          : transactions.filter((t) => t.bucket === filter)
    return rows.filter((t) => isBusinessTxn(t, businessAccountIds)).length
  }, [transactions, filter, reviewRows, businessAccountIds])

  const days = useMemo(() => {
    const groups: { date: string; rows: Transaction[] }[] = []
    for (const t of visible) {
      const last = groups[groups.length - 1]
      if (last && last.date === t.posted_on) last.rows.push(t)
      else groups.push({ date: t.posted_on, rows: [t] })
    }
    return groups
  }, [visible])

  return (
    <div className="page">
      <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 4 }}>Activity</div>
      <div className="tiny muted" style={{ marginBottom: 14 }}>
        Tap a label to change it. You choose whether it applies to that one
        transaction or to everything from the same merchant.
      </div>

      <MoveNoticeBar notice={notice} leftView={noticeLeftView} onDismiss={clearNotice} />

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

      {/* How the same rows are read. Separate from the filter above, which
          decides WHICH rows: these are two different questions and collapsing
          them into one row of pills would imply picking one clears the other. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="tiny muted" style={{ marginRight: 2 }}>Group by</span>
        {[{ key: null, label: 'Date' }, ...GROUPINGS].map((g) => {
          const on = groupBy === g.key
          return (
            <button
              key={g.label}
              type="button"
              className="pill"
              aria-pressed={on}
              onClick={() => setGroupBy(g.key as GroupBy | null)}
              style={
                on
                  ? { background: 'var(--ink)', color: '#fff' }
                  : { background: 'var(--white)', color: 'var(--steel)', border: '1px solid var(--line)' }
              }
            >
              {g.label}
            </button>
          )
        })}
      </div>

      {/* The business's own money.
          Present whenever a business account exists — NOT only when the month on
          screen happens to contain one of its rows. Tying it to the current view
          meant the control vanished in a quiet month, which is exactly how a
          feature becomes undiscoverable: absent and missing look identical. */}
      {businessAccountIds.size > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 16,
            paddingBottom: 12,
            borderBottom: '1px solid var(--line)',
          }}
        >
          <button
            type="button"
            className="pill"
            aria-pressed={showBusiness}
            onClick={() => setShowBusiness((v) => !v)}
            style={
              showBusiness
                ? { background: 'var(--ink)', color: '#fff' }
                : { background: 'var(--white)', color: 'var(--steel)', border: '1px solid var(--line)' }
            }
          >
            {showBusiness ? 'Hide business' : 'Show business'}
          </button>
          <span className="tiny muted" style={{ lineHeight: 1.4 }}>
            {showBusiness
              ? 'Business rows are listed. They are still excluded from the budget.'
              : businessHidden === 0
                ? 'No business rows here. They are always excluded from the budget.'
                : `${businessHidden} business ${businessHidden === 1 ? 'row is' : 'rows are'} hidden.`}
          </span>
        </div>
      )}

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
      ) : groupBy ? (
        <GroupedActivity
          rows={visible}
          groupBy={groupBy}
          onChanged={async (n) => {
            setNotice(n ?? null)
            await refresh()
            await loadMonth()
            if (filter === 'review') await loadReview()
          }}
        />
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
                            onClick={() => setOpenId(open ? null : t.id)}
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
                            <Recategorizer
                              transaction={t}
                              loaded={transactions}
                              onDone={async (n) => {
                                setOpenId(null)
                                setNotice(n ?? null)
                                await refresh()
                                await loadMonth()
                                if (filter === 'review') await loadReview()
                              }}
                            />
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
