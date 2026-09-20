import { Fragment, useEffect, useMemo, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import Recategorizer, { bucketStyle, type MoveNotice } from '../components/Recategorizer'
import MoveNoticeBar from '../components/MoveNoticeBar'
import GroupedActivity, { GROUPINGS, type GroupBy } from '../components/GroupedActivity'
import { useData, isBusinessTxn, type Transaction } from '../lib/data'
import { MonthNav, useMonthView } from '../lib/monthView'
import { accountDescriptor, dayHeading, parseDateOnly, signedMoney, MONTH_NAMES } from '../lib/format'

type Filter = 'all' | 'review' | 'optional'

/** "19 Sep" — the date column, which only appears where there is room for it. */
function shortDate(iso: string): string {
  return parseDateOnly(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })
}

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
    businessAccountIds,
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
   * Which month is on screen, and its rows. Shared with /month — see
   * useMonthView(), which owns the fetch, the floor at the oldest recorded
   * month and the guard against a slow request painting the wrong month.
   */
  const view = useMonthView()
  const { anchor, thisMonth, error: monthError } = view
  /** The ledger shows everything the banks reported, business included. */
  const transactions = view.allTransactions
  const loadingMonth = !thisMonth && view.loading

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
      <MonthNav view={view} bordered />
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
            await view.refresh()
            if (filter === 'review') await loadReview()
          }}
        />
      ) : (
        /*
          ONE table, five columns: date, merchant, account, label, amount.
          It was a table per day, each row carrying three cells with the date
          above it and the account tucked under the merchant. At 1100px that is a
          card stack with borders; as a table the same facts line up in columns
          and the amounts read down a single edge.

          The date and account columns are hidden below 1024px, where the day
          heading row and the merchant's sub-line say the same thing in the space
          a phone has. Nothing is added or dropped — it moves.
        */
        <table>
          <thead className="act-head">
            <tr className="caps">
              <th>Date</th>
              <th>Merchant</th>
              <th>Account</th>
              <th className="r">Label</th>
              <th className="r">Amount</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day, di) => (
              <Fragment key={day.date}>
                {/* A bare <div> sitting between table rows is hoisted clean out
                    of the table by every browser, so the day heading is a real
                    row spanning all five columns. It is hidden at desktop, where
                    the date column carries it. */}
                <tr className="act-daybreak">
                  <td
                    colSpan={5}
                    className="tiny muted tnum"
                    style={{
                      fontWeight: 700,
                      padding: di === 0 ? '0 0 6px' : '16px 0 6px',
                      borderBottom: 'none',
                    }}
                  >
                    {dayHeading(day.date)}
                  </td>
                </tr>

                {day.rows.map((t) => {
                  const pill = bucketStyle(t.bucket)
                  const open = openId === t.id
                  const account = accountName(t.account_id)
                  const sub = t.pending ? `${account} · pending` : account
                  return (
                    <Fragment key={t.id}>
                      <tr>
                        <td className="act-date tiny muted tnum" style={{ width: 76, whiteSpace: 'nowrap' }}>
                          {shortDate(t.posted_on)}
                        </td>
                        <td>
                          <div className="sm" style={{ fontWeight: 600 }}>
                            {t.name}
                          </div>
                          <div className="tiny muted act-sub">{sub}</div>
                        </td>
                        <td className="act-account tiny muted">{sub}</td>
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
                        // FIVE, not three. At three the editor renders under-wide
                        // and the table sprouts a phantom sixth column beside it.
                        <tr>
                          <td colSpan={5} style={{ paddingTop: 0 }}>
                            <Recategorizer
                              transaction={t}
                              loaded={transactions}
                              onDone={async (n) => {
                                setOpenId(null)
                                setNotice(n ?? null)
                                await view.refresh()
                                if (filter === 'review') await loadReview()
                              }}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
