import { Fragment, useEffect, useMemo, useState, useCallback, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import Recategorizer, { bucketStyle, type MoveNotice } from '../components/Recategorizer'
import MarkRecurring from '../components/MarkRecurring'
import MoveNoticeBar from '../components/MoveNoticeBar'
import GroupedActivity, { GROUPINGS, type GroupBy } from '../components/GroupedActivity'
import { useData, isBusinessTxn, type Transaction } from '../lib/data'
import { MonthNav, useMonthView } from '../lib/monthView'
import { accountDescriptor, dayHeading, parseDateOnly, signedMoney, MONTH_NAMES } from '../lib/format'
import {
  OWNER_CAVEAT,
  filterByOwner,
  ownerByAccount,
  ownerLabel,
  ownersPresent,
  txnOwner,
  type Owner,
  type OwnerFilter,
} from '../lib/owners'

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

/**
 * A filter chip.
 *
 * Ink when held down, outlined when not — the mockup's two states and nothing
 * else. Every control on this page that narrows or reveals rows wears this, so
 * "Show business" reads as one of the filters rather than as a separate kind of
 * switch: it is the same question asked about a different axis.
 */
function Chip({
  on,
  onClick,
  label,
  children,
}: {
  on: boolean
  onClick: () => void
  /** Spoken label, where the visible text is too terse to stand alone. */
  label?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="pill"
      aria-pressed={on}
      aria-label={label}
      onClick={onClick}
      style={
        on
          ? { background: 'var(--ink)', color: '#fff' }
          : { background: 'var(--white)', color: 'var(--steel)', border: '1px solid var(--line)' }
      }
    >
      {children}
    </button>
  )
}

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
   * budget on /spending excludes them entirely.
   *
   * So this page reads from `allTransactions`, not the household-narrowed
   * `transactions`, and hides the business rows by default so that what is
   * listed and what is budgeted agree. The rule beneath the table says so out
   * loud, with a count, because a silently shorter list is indistinguishable
   * from missing data — the same failure this app has already been bitten by.
   */
  const [showBusiness, setShowBusiness] = useState(false)

  /**
   * Which month is on screen, and its rows. Shared with /spending — see
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
   * Whose account the rows sit on.
   *
   * A SECOND axis, not more bucket chips: "Optional" and "Alex" are not
   * alternatives, and one row of pills holding both would say they were. It
   * narrows what the bucket chips and the business toggle have already
   * selected, never widens it — see `visible`.
   *
   * Note what this page does NOT do with it. Activity prints individual
   * charges and no total, so there is no denominator here to get wrong:
   * `budget_lines.monthly_target` is a household figure, and the moment a
   * person's name sits beside a total measured against it the sentence holds
   * two different denominators. Spending carries that comparison, with
   * ownerShare; the ledger stays a ledger and reports a row count instead.
   */
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('everyone')

  /** Derived, never hardcoded: a renamed or a third member needs no edit here. */
  const owners = useMemo(() => ownersPresent(accounts), [accounts])
  /** Built once. Every row asks this map whose account it is on. */
  const ownerOf = useMemo(() => ownerByAccount(accounts), [accounts])

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

  /**
   * The same descriptor with the owner taken off the front, for the desktop
   * table only, where Owner is a column of its own and "Sam" repeated in
   * the cell beside it reads as a stutter.
   *
   * The prefix is removed rather than the label rebuilt, so accountDescriptor
   * stays the single source of what an account is called and the two cannot
   * drift. On a phone there is no Owner column, so the sub-line keeps the full
   * owner-first descriptor it has always shown.
   */
  const withoutOwner = useCallback((label: string, owner: Owner | null) => {
    if (!owner) return label
    const prefix = `${ownerLabel(owner)} · `
    return label.startsWith(prefix) ? label.slice(prefix.length) : label
  }, [])

  useEffect(() => {
    setNotice(null)
  }, [filter, ownerFilter, anchor])

  /** The rows the chips select, before the business toggle has its say. */
  const selected = useMemo(
    () =>
      filter === 'review'
        ? (reviewRows ?? [])
        : filter === 'all'
          ? transactions
          : transactions.filter((t) => t.bucket === filter),
    [transactions, filter, reviewRows],
  )

  const visible = useMemo(() => {
    // Business exclusion FIRST, then the owner. The business accounts are in
    // one person's name, so narrowing to that person before the toggle had its
    // say would pull the business rows back into a household view through a
    // control that does not claim to do that. The toggle keeps its meaning and
    // the owner filter only narrows what survived it.
    const kept = showBusiness
      ? selected
      : selected.filter((t) => !isBusinessTxn(t, businessAccountIds))
    const mine = filterByOwner(kept, ownerFilter, ownerOf)
    return [...mine].sort((a, b) => (a.posted_on < b.posted_on ? 1 : a.posted_on > b.posted_on ? -1 : 0))
  }, [selected, showBusiness, businessAccountIds, ownerFilter, ownerOf])

  /**
   * How many the toggle is holding back, so the rule beneath can say it.
   *
   * Counted against the rows the owner filter selects, not the whole month: on
   * Sam the withheld business rows are none of his, and reporting the
   * household's count under his name would describe a list he is not looking
   * at. A count that does not match what the toggle would reveal is worse than
   * no count, because it reads as missing data.
   */
  const businessHidden = useMemo(
    () =>
      filterByOwner(
        selected.filter((t) => isBusinessTxn(t, businessAccountIds)),
        ownerFilter,
        ownerOf,
      ).length,
    [selected, businessAccountIds, ownerFilter, ownerOf],
  )

  const days = useMemo(() => {
    const groups: { date: string; rows: Transaction[] }[] = []
    for (const t of visible) {
      const last = groups[groups.length - 1]
      if (last && last.date === t.posted_on) last.rows.push(t)
      else groups.push({ date: t.posted_on, rows: [t] })
    }
    return groups
  }, [visible])

  /**
   * The business's own money.
   *
   * Offered whenever a business account exists — NOT only when the month on
   * screen happens to contain one of its rows. Tying it to the current view
   * meant the control vanished in a quiet month, which is exactly how a feature
   * becomes undiscoverable: absent and missing look identical.
   */
  const hasBusiness = businessAccountIds.size > 0

  /**
   * The caveat under the table, as one quiet rule rather than two.
   *
   * It carries both things a reader needs and cannot see: how many rows the
   * business toggle is withholding, and that a bucket change reaches further
   * than the row that was tapped. The second sentence names the default rather
   * than stating it as a law, because Recategorizer offers "just this one" and
   * copy that promised a merchant-wide rule every time would be wrong whenever
   * that option is taken.
   */
  /**
   * What an empty list MEANS, which is not always the same thing.
   *
   * "No rows for Alex in September" and "September could not be loaded" look
   * identical on screen unless the page says which, and this app has been
   * bitten by a short list reading as a working one. A failed read is reported
   * as a failure first; only then does the page claim there is nothing there.
   */
  const monthName = MONTH_NAMES[anchor.getMonth()]
  const whose = ownerFilter === 'everyone' ? null : ownerLabel(ownerFilter)
  const emptyNote = (() => {
    if (filter === 'review') {
      if (reviewErr) return `The review queue could not be loaded — ${reviewErr}`
      return whose ? `Nothing for ${whose} needs review.` : 'Nothing needs review.'
    }
    if (monthError) return `${monthName} could not be loaded — ${monthError}`
    // Both filters have to stay in the sentence, because either one can be what
    // emptied the list. "No rows for Alex in September" while the Optional chip
    // is held down is simply false: Alex can have a full month of rows and none
    // of them optional, and a message that names one filter blames it for what
    // the other did.
    if (filter === 'optional') {
      return whose
        ? `Nothing optional for ${whose} in ${monthName}.`
        : `Nothing optional in ${monthName}.`
    }
    if (whose) return `No rows for ${whose} in ${monthName}.`
    return `No transactions in ${monthName}.`
  })()

  // The count is a figure like any other, so it is tabular — the same treatment
  // the caveats on /progress give a bare number sitting inside a sentence.
  const businessNote = !hasBusiness ? null : showBusiness ? (
    <>Business rows are listed. They are still excluded from the budget.</>
  ) : businessHidden === 0 ? (
    <>No business rows here. They are always excluded from the budget.</>
  ) : (
    <>
      <span className="tnum">{businessHidden}</span> business{' '}
      {businessHidden === 1 ? 'row is' : 'rows are'} hidden.
    </>
  )

  return (
    <main className="page">
      {/* Title and chips share a baseline where there is room and stack where
          there is not, which is the difference between the two mockups without
          a media query — and this page owns no stylesheet of its own. */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 12,
        }}
      >
        <div>
          <h1 className="ph">Activity</h1>
          <div className="tiny muted">Tap a label to recategorise</div>
        </div>

        {/* Two rows, two questions. The first narrows by bucket, the second by
            person, and they are stacked rather than run together because side
            by side "Optional" and "Alex" read as alternatives when they are
            not: every combination of the two is a sensible view. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {FILTERS.map((f) => (
              <Chip key={f.key} on={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label}
              </Chip>
            ))}
            {hasBusiness && (
              <Chip
                on={showBusiness}
                onClick={() => setShowBusiness((v) => !v)}
                label={showBusiness ? 'Hide business rows' : 'Show business rows'}
              >
                Show business
              </Chip>
            )}
          </div>

          {/* Held down is ink, exactly like every other chip on this page.
              Amber is the payoff target and nothing else, and a person is not
              a target. An amber chip here would say the household was aiming
              at someone.

              The label says "account" rather than a bare "Whose", because that
              is the claim the data supports: the caveat under the list is the
              full version, but the control itself should not overstate it
              while it is being tapped. */}
          {owners.length > 1 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="tiny muted" style={{ marginRight: 2 }}>
                Whose account
              </span>
              <Chip
                on={ownerFilter === 'everyone'}
                onClick={() => setOwnerFilter('everyone')}
                label="Show rows for everyone"
              >
                Everyone
              </Chip>
              {owners.map((o) => (
                <Chip
                  key={o}
                  on={ownerFilter === o}
                  onClick={() => setOwnerFilter(o)}
                  label={`Show rows on ${ownerLabel(o)} accounts`}
                >
                  {ownerLabel(o)}
                </Chip>
              ))}
            </div>
          )}
        </div>
      </div>

      <MoveNoticeBar notice={notice} leftView={noticeLeftView} onDismiss={clearNotice} />

      {/* Month switcher. Forward is disabled at the current month — there is
          nothing recorded ahead of today, and an empty future month reads as a
          fault rather than as the calendar. Back is disabled at the oldest month
          on record, for the same reason in the other direction.

          Hidden entirely while the review queue is on: that filter reads across
          all time, so a month control would sit there implying it narrowed
          something and quietly contradicting what is on screen. */}
      {filter !== 'review' && <MonthNav view={view} bordered />}

      {/* How the same rows are read. Separate from the chips above, which decide
          WHICH rows: these are two different questions and collapsing them into
          one row of pills would imply picking one clears the other. Quieter than
          the chips, because the ledger is the answer nine times in ten. */}
      <div
        style={{
          display: 'flex',
          gap: 6,
          marginBottom: 14,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <span className="tiny muted" style={{ marginRight: 2 }}>
          Group by
        </span>
        {[{ key: null, label: 'Date' }, ...GROUPINGS].map((g) => (
          <Chip
            key={g.label}
            on={groupBy === g.key}
            onClick={() => setGroupBy(g.key as GroupBy | null)}
          >
            {g.label}
          </Chip>
        ))}
      </div>

      {error && (
        <div className="banner banner--red sm" style={{ marginBottom: 14, fontWeight: 600 }}>
          Activity could not be loaded.
        </div>
      )}

      {/* How much is on screen. With two filters stacked it stops being obvious
          how much either one took out, and a count makes a short list legible
          as a short list rather than as a page that half loaded. The empty case
          is carried by emptyNote below, which can say why it is empty. */}
      {visible.length > 0 && !loadingMonth && (
        <div className="tiny muted tnum" style={{ marginBottom: 8 }}>
          {visible.length} {visible.length === 1 ? 'row' : 'rows'}
          {whose ? ` on ${whose} accounts` : ''}
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
            {emptyNote}
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
          ONE table, six columns: date, merchant, account, owner, bucket, amount.
          It was a table per day, each row carrying three cells with the date
          above it and the account tucked under the merchant. At 1100px that is a
          card stack with borders; as a table the same facts line up in columns
          and the amounts read down a single edge.

          The date and account columns are hidden below 1024px, where the day
          heading row and the merchant's sub-line say the same thing in the space
          a phone has. Nothing is added or dropped — it moves, which is precisely
          the desktop table and the mobile row list the mockup draws, from one
          piece of markup rather than two that can drift apart.
        */
        <table className="tbl">
          <thead className="act-head">
            <tr>
              <th style={{ width: 76 }}>Date</th>
              <th>Merchant</th>
              <th style={{ width: 210 }}>Account</th>
              <th style={{ width: 84 }}>Owner</th>
              <th style={{ width: 92 }}>Bucket</th>
              <th className="r" style={{ width: 96 }}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {days.map((day, di) => (
              <Fragment key={day.date}>
                {/* A bare <div> sitting between table rows is hoisted clean out
                    of the table by every browser, so the day heading is a real
                    row spanning all six columns. It is hidden at desktop, where
                    the date column carries it. */}
                <tr className="act-daybreak">
                  <td
                    colSpan={6}
                    className="muted tnum"
                    style={{
                      fontWeight: 700,
                      // The size is stated here rather than taken from .tiny,
                      // which loses: `.tbl td` sets font-size on the element
                      // itself and outranks a bare class on the same <td>. With
                      // .tiny the heading rendered at the table's own 13px and
                      // read as a section title competing with the merchant
                      // names, rather than as the quiet date rule it is.
                      fontSize: 11.5,
                      letterSpacing: '.05em',
                      padding: di === 0 ? '0 0 4px' : '16px 0 4px',
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
                  const owner = txnOwner(t, ownerOf)
                  // The phone's sub-line keeps the owner-first descriptor; the
                  // desktop cell drops the owner, which now has its own column.
                  const sub = t.pending ? `${account} · pending` : account
                  const deskAccount = withoutOwner(account, owner)
                  const deskSub = t.pending ? `${deskAccount} · pending` : deskAccount
                  return (
                    <Fragment key={t.id}>
                      <tr>
                        <td className="act-date tiny muted tnum" style={{ whiteSpace: 'nowrap' }}>
                          {shortDate(t.posted_on)}
                        </td>
                        <td>
                          <div className="sm" style={{ fontWeight: 600 }}>
                            {t.name}
                          </div>
                          <div className="tiny muted act-sub">{sub}</div>
                        </td>
                        <td className="act-account tiny muted">{deskSub}</td>
                        {/* Desktop only, so a person can be read off the list
                            without filtering to them first.

                            It wears .act-account, which is not this column but
                            IS the switch that hides a column below 1024px and
                            restores it above. This page owns no stylesheet, so
                            borrowing that class is the alternative to a class
                            it cannot define. Neutral ink: green is cleared or
                            on plan and red is a deviation, and a person is
                            neither of those things.

                            An account that is not loaded shows an em dash
                            rather than a name, because txnOwner returns null
                            there and guessing would put a row in someone's
                            column that may not be theirs. */}
                        <td className="act-account tiny muted">
                          {owner ? ownerLabel(owner) : '—'}
                        </td>
                        {/* Shrink-to-content, and only on a phone. The header
                            row is display:none below 1024px, so its 92px width
                            drops out of the column calculation and this 1px
                            collapses the column onto the pill, which puts the
                            pill immediately left of the amount — the mobile
                            mockup's row. At desktop the visible <th> restores
                            the 92px column, because the used width of a column
                            is the widest width asked for, so the Bucket column
                            keeps its place in the table. */}
                        <td style={{ width: 1, whiteSpace: 'nowrap' }}>
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
                        {/* Money in is green, and only money in. Plaid signs a
                            charge POSITIVE, so the test reads inverted on
                            purpose: amount < 0 is a deposit. */}
                        {/* A width here, not only on the header: the header is
                            display:none on a phone, so without it the auto
                            table layout hands the amount column a share of the
                            slack and floats the bucket pill away from the
                            figure it belongs to. */}
                        <td
                          className="num"
                          style={{ width: 96, color: t.amount < 0 ? 'var(--green)' : undefined }}
                        >
                          {signedMoney(t.amount)}
                        </td>
                      </tr>

                      {open && (
                        // SIX, not three. Short of the full count the editor
                        // renders under-wide and the table sprouts a phantom
                        // column beside it.
                        <tr>
                          <td colSpan={6} style={{ paddingTop: 0 }}>
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
                            {/* Same expander, because it is the same question
                                asked twice: what IS this row. The bucket says
                                what kind of money it is; this says whether it
                                will happen again. */}
                            <MarkRecurring transaction={t} onDone={() => setOpenId(null)} />
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

      {/* A quiet rule under the thing it qualifies, never a grey block. It is
          rendered whatever the list is doing, including while it is empty: the
          count of withheld business rows is most worth stating exactly when the
          list looks shorter than expected. */}
      {/* Carried by every view that attributes rows to a person, and by no
          other: on "Everyone" nothing is being attributed, so the sentence
          would be a caveat about a claim the page is not making. Its own rule
          rather than a clause appended to the one below, because it qualifies
          the chips and the Owner column, not the relabelling. */}
      {whose && <div className="rule">{OWNER_CAVEAT}</div>}

      <div className="rule">
        {businessNote && <>{businessNote} </>}
        Changing a bucket makes a rule for that merchant and reapplies it across the month,
        unless you choose to change just this one.
      </div>
    </main>
  )
}
