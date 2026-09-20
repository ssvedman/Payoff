import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Bar from '../components/Bar'
import SpendingBucketRows from '../components/SpendingBucketRows'
import SpendingSixMonths from '../components/SpendingSixMonths'
import { useMonthView } from '../lib/monthView'
import { isBusinessTxn, useData, useMonthTotalsFor, type Transaction } from '../lib/data'
import { money, MONTH_NAMES, accountDescriptor } from '../lib/format'
import {
  OWNER_CAVEAT,
  filterByOwner,
  ownerByAccount,
  ownerLabel,
  ownerShare,
  ownersPresent,
  spendByOwner,
  type OwnerFilter,
} from '../lib/owners'

/**
 * /spending — one month of household money, with arrows through time.
 *
 * This is the old /month and /history as a single page. They were two ideas of
 * the same thing: "this month" and "the other months". The page is now
 * identical whichever month is on screen, and the six-month chart is the only
 * piece of /history that was about spending rather than balances.
 *
 * PACE IS THE POINT. "$1,044 of $1,117" says nothing on day 22 — the same
 * figure is a good month or a bad one depending on how much of the month is
 * left. Every judgement here is made against pace, and the totals are shown
 * beside it rather than instead of it.
 *
 * Everything is driven by the month's transactions. A month with none
 * legitimately reads $0, and the page says that plainly rather than implying
 * something went wrong.
 *
 * Colour: amber is the current target and appears nowhere on this screen. Green
 * is on plan, red is a deviation from plan, steel is everything else. A figure
 * that is merely incomplete part-way through the month is steel, not red —
 * nothing has deviated yet.
 *
 * WHO THE MONEY BELONGS TO narrows EVERYTHING on the page except the targets.
 *
 * The first attempt narrowed only the detail tables and left the four bars and
 * the rows behind them household-wide, on the reasoning that a target does not
 * divide. That reasoning is right and the conclusion was wrong: the page then
 * looked filtered and was not, and opening a bucket under one person's chip
 * listed everybody's charges. A filter that appears to narrow everything and
 * quietly does not is the worst of the available failures, because the figure
 * it leaves on screen is exactly as authoritative-looking as the right one.
 *
 * So the bars, their rows and the tables all follow the chip, and the TARGET is
 * what gets withdrawn instead: no target, no pace and no "met" reading while a
 * person is selected, because every one of those is a household judgement and
 * there is no per-person budget anywhere in the data to make them from. Each
 * bar becomes a share of what the household actually spent in that bucket,
 * which is a true sentence with its own denominator. The six-month history
 * stays household, because it reports months rather than people.
 *
 * The filter is a SEPARATE axis from the business exclusion below, and applies
 * after it. The business accounts are in one person's name, so narrowing to
 * that person must not pull business rows back into a household view: the rows
 * arrive already narrowed to the household, and the owner filter only ever
 * removes more.
 *
 * Business money never reaches any figure here. The rows arrive already
 * narrowed to the household, by the account's is_business flag rather than by
 * whose name is on it, so every total is household money by construction rather
 * than by each sum remembering to exclude it.
 */

const CATCH_ALL = 'everything else'

/**
 * The day after which the attack payment being absent counts as a deviation
 * rather than as a month still in progress — BUILD.md §6, `attack_missing`.
 */
const ATTACK_DUE_DAY = 15

/** Whole-dollar difference, never negative. */
const gap = (a: number, b: number) => Math.max(0, a - b)

/**
 * The wide layout, read once and kept in sync.
 *
 * Almost everything on this page is the same markup at both widths and the
 * stacking is done in CSS. Two things genuinely differ in CONTENT rather than
 * in arrangement: the month arrows name their months where there is room for
 * them, and the pace line drops to its short form where there is not. Initial
 * state is read synchronously, so the first paint is already correct and
 * nothing flickers.
 */
function useWideScreen(): boolean {
  const query = '(min-width: 1024px)'
  const [wide, setWide] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setWide(mq.matches)
    mq.addEventListener('change', onChange)
    // The width can have changed between the initial read and this effect.
    onChange()
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return wide
}

export default function Spending() {
  const { error: dataError, budgetLines, plan, accounts, businessAccountIds } = useData()
  // The month on screen, which is not always the current one. Its rows are
  // already narrowed to the household, exactly as the provider narrows this
  // month's, so every total below is household money by construction.
  const view = useMonthView()
  const { transactions, allTransactions, refresh } = view
  const loading = view.loading
  const error = dataError ?? view.error
  const totals = useMonthTotalsFor(transactions, budgetLines)
  const wide = useWideScreen()

  /**
   * Which bucket is opened up.
   *
   * A bar says a bucket is at 155% of its target and stops there — the one
   * question it provokes is "on what?", and answering it meant leaving for
   * /activity, filtering, and reading back a figure that was no longer on
   * screen. Opening it in place keeps the total next to the things that make
   * it up.
   */
  const [openBucket, setOpenBucket] = useState<string | null>(null)

  /**
   * Whose spending is being read, which is whose ACCOUNT it sits on.
   *
   * 'everyone' is the unfiltered page and is the default, because the household
   * total is the question this page exists to answer. The people come from the
   * accounts themselves, so their names never enter the repository and a third
   * member needs no code change here.
   */
  const [ownerChip, setOwnerChip] = useState<OwnerFilter>('everyone')
  const owners = useMemo(() => ownersPresent(accounts), [accounts])
  const ownerOf = useMemo(() => ownerByAccount(accounts), [accounts])
  /**
   * A chip held down for an owner who is no longer in the data — an account
   * closed or renamed while the page is open — would filter every row away and
   * read as a month with no spending in it. Fall back to the whole household
   * rather than showing an empty page that looks like a fault.
   */
  const ownerFilter: OwnerFilter =
    ownerChip === 'everyone' || owners.includes(ownerChip) ? ownerChip : 'everyone'
  const filtered = ownerFilter !== 'everyone'

  const nameOf = useMemo(() => {
    const byId = new Map(accounts.map((a) => [a.id, accountDescriptor(a)]))
    return (id: string) => byId.get(id) ?? 'Unlinked account'
  }, [accounts])

  /**
   * This month's rows, split by bucket, newest first.
   *
   * Ordered by the date the charge posted rather than by size. These lists feed
   * the detail tables, and a ledger reads in time order: sorting by amount put
   * the month's largest charge at the top of every list regardless of when it
   * happened, which answers a question nobody was asking of a list of
   * transactions. Aggregations further down still rank by size, where largest
   * first IS the question.
   */
  const rowsIn = useMemo(() => {
    const groups = new Map<string, Transaction[]>()
    for (const t of transactions) {
      const list = groups.get(t.bucket) ?? []
      list.push(t)
      groups.set(t.bucket, list)
    }
    for (const list of groups.values())
      list.sort((a, b) =>
        a.posted_on === b.posted_on ? b.amount - a.amount : a.posted_on < b.posted_on ? 1 : -1,
      )
    return groups
  }, [transactions])

  /**
   * The same rows as `rowsIn`, narrowed to the selected person.
   *
   * The bucket bars and the rows behind them used to read `rowsIn` directly, so
   * holding down a person's chip changed the detail tables on the right and
   * left the whole left-hand column exactly as it was. Opening a bucket then
   * listed everybody's transactions under that person's name, which is worse
   * than not filtering at all: the page looked filtered and was not.
   *
   * Household figures are still computed from `rowsIn`, because a target, a
   * pace and an attack-fund obligation belong to the household and do not
   * divide. This map decides what is SHOWN, not what is judged.
   */
  const rowsInView = useMemo(() => {
    if (!filtered) return rowsIn
    const out = new Map<string, Transaction[]>()
    for (const [bucket, list] of rowsIn) {
      out.set(bucket, filterByOwner(list, ownerFilter, ownerOf))
    }
    return out
  }, [rowsIn, filtered, ownerFilter, ownerOf])

  /** What the person on screen spent in one bucket. The household's when unfiltered. */
  const shownIn = useCallback(
    (bucket: string) => (rowsInView.get(bucket) ?? []).reduce((sum, t) => sum + t.amount, 0),
    [rowsInView],
  )

  /** The month's discretionary rows, which are the only ones split by person. */
  const optionalRows = useMemo(() => rowsIn.get('optional') ?? [], [rowsIn])

  /**
   * The rows the detail tables are built from.
   *
   * `transactions` is already household money, so the business exclusion has
   * had its say before this line and the owner filter can only remove more. The
   * bars above are deliberately NOT built from this.
   */
  const detailRows = useMemo(
    () => filterByOwner(transactions, ownerFilter, ownerOf),
    [transactions, ownerFilter, ownerOf],
  )

  /**
   * One person's optional spend against what the household actually spent.
   *
   * This is the honest denominator. The bucket's target is not available to it,
   * by design: see the note at the top of this file and in lib/owners.
   */
  const share = useMemo(
    () => ownerShare(optionalRows, ownerFilter, ownerOf),
    [optionalRows, ownerFilter, ownerOf],
  )

  /**
   * Optional spend per person, for the unfiltered view.
   *
   * This is the part that is useful without touching the filter at all: it
   * answers "who spent it" in one glance rather than three chip presses. Rows on
   * an account that is not loaded are left out of the split rather than being
   * attributed to anyone, so `listed` can be short of the bucket and the
   * remainder is shown as its own row rather than silently rounding the shares up.
   */
  const byPerson = useMemo(() => {
    const rows = spendByOwner(optionalRows, ownerOf)
    return { rows, listed: rows.reduce((sum, r) => sum + r.total, 0) }
  }, [optionalRows, ownerOf])

  const today = new Date()
  const anchor = view.anchor
  const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate()
  /**
   * How far through the month on screen we are.
   *
   * A month that has already ended is finished, not part-way through: pace is
   * the whole target, nothing is "remaining", and a shortfall is a fact rather
   * than a month still running. Reading today's date for an earlier month would
   * judge all of August against 19/31 of its budget.
   */
  const day = view.thisMonth ? today.getDate() : daysInMonth
  const daysLeft = daysInMonth - day
  // daysInMonth is 28–31, so this never divides by zero and is always > 0.
  const elapsed = day / daysInMonth

  const attackTarget = plan?.attack_fund ?? 0
  const savingsTarget = plan?.monthly_savings ?? 0

  const optionalSpent = totals.bucketSpent('optional')
  const optionalTarget = totals.bucketTarget('optional')
  const fixedSpent = totals.bucketSpent('fixed')
  const fixedTarget = totals.bucketTarget('fixed')

  /**
   * What each bar DRAWS. Equal to the household figure until a person is
   * selected, at which point it is that person's share of it.
   *
   * Kept separate from the household figures above rather than replacing them,
   * because the two are asked different questions: these are shown, those are
   * judged. Pace, the target comparison and the attack-fund obligation all stay
   * on the household figures, and are withdrawn from the screen rather than
   * recomputed per person when a chip is held down.
   */
  const optionalShown = shownIn('optional')
  const fixedShown = shownIn('fixed')
  const attackSpent = totals.bucketSpent('attack')
  const savingsSpent = totals.bucketSpent('savings')
  const attackShown = shownIn('attack')
  const savingsShown = shownIn('savings')

  const spentTotal = fixedSpent + optionalSpent + attackSpent + savingsSpent
  const income = totals.income

  /**
   * Per-line spend, read from each transaction's budget_line_id — set by the
   * categoriser from the Plaid category, or pinned by a merchant rule when
   * someone corrects one in /activity. Optional spend with no line yet collects
   * in the catch-all, so the lines always sum to the bucket.
   *
   * Built from `detailRows`, so with a person's chip held down these lines sum
   * to that person's share and not to the bar above them. That is the whole
   * point of the rule printed under the bars.
   */
  const linesIn = useMemo(() => {
    const build = (bucket: 'optional' | 'fixed') => {
      const lines = budgetLines.filter((l) => l.bucket === bucket)
      const spent = new Map<string, number>(lines.map((l) => [l.id, 0]))
      const catchAll = lines.find((l) => l.line_name.trim().toLowerCase() === CATCH_ALL)

      for (const t of detailRows) {
        if (t.bucket !== bucket) continue
        // A transaction now carries its line explicitly. Anything not yet
        // assigned — a merchant no rule covers — collects in the catch-all
        // rather than being dropped, so the lines always sum to the bucket.
        // An id that is not an OPTIONAL line — a row filed against a fixed line
        // and later re-bucketed, say — must still land somewhere, or the rows
        // below sum to less than the bar above them and the comment's promise
        // is broken.
        const lineId =
          t.budget_line_id && spent.has(t.budget_line_id) ? t.budget_line_id : catchAll?.id
        // FIXED has no catch-all, so an unassigned fixed charge has nowhere to
        // go. It is counted in `unassigned` below rather than dropped, because a
        // row of lines that quietly sums to less than the bar above it is worse
        // than one that admits what it could not place.
        if (!lineId) continue
        spent.set(lineId, (spent.get(lineId) ?? 0) + t.amount)
      }

      const placed = lines
        .map((l) => ({ ...l, spent: spent.get(l.id) ?? 0 }))
        // A line with nothing on it is kept in the household view and dropped
        // from a person's. Unfiltered, a $0 line still says something: its
        // variance column reads the full target as unspent. Filtered, that
        // column is gone (see the table below), so the row carries no figure at
        // all and the table becomes a list of the HOUSEHOLD's budget lines
        // printed under one person's name — the table saying whose it is in its
        // heading and then not being theirs. Dropping them is also what makes
        // "Nothing discretionary under Sam this month" reachable: with the
        // lines always listed it could never be, and a person with no
        // discretionary spending read as a budget rather than as an absence.
        .filter((l) => !filtered || l.spent !== 0)
        // Largest first. A line's variance is what the reader is scanning for,
        // and the lines carrying the most money are where it matters most.
        .sort((a, b) => b.spent - a.spent)
      const totalPlaced = placed.reduce((sum, l) => sum + l.spent, 0)
      const bucketTotal = detailRows
        .filter((t) => t.bucket === bucket)
        .reduce((sum, t) => sum + t.amount, 0)

      return { lines: placed, unassigned: Math.round((bucketTotal - totalPlaced) * 100) / 100 }
    }

    return { optional: build('optional'), fixed: build('fixed') }
  }, [budgetLines, detailRows, filtered])

  /**
   * The largest things in the optional bucket, by merchant.
   *
   * Grouped rather than listed one charge at a time: nine Amazon orders of $24
   * are one $212 habit, and as nine rows they are invisible beside a single
   * $164 flight. The count says how many charges are behind the figure.
   */
  const biggestItems = useMemo(() => {
    const byMerchant = new Map<string, { label: string; amount: number; count: number }>()
    for (const t of detailRows) {
      if (t.bucket !== 'optional') continue
      const label = t.merchant_name ?? t.name
      const key = label.trim().toLowerCase()
      const row = byMerchant.get(key) ?? { label, amount: 0, count: 0 }
      row.amount += t.amount
      row.count += 1
      byMerchant.set(key, row)
    }
    return [...byMerchant.values()].sort((a, b) => b.amount - a.amount).slice(0, 3)
  }, [detailRows])

  // First load only — see the note on Home. A background refetch must not
  // replace figures already on screen with placeholders.
  if (loading && budgetLines.length === 0) {
    return (
      <div className="page" aria-busy="true" aria-label="Loading spending">
        <div className="skeleton" style={{ width: 168, height: 22, marginBottom: 9 }} aria-hidden="true" />
        <div className="skeleton" style={{ width: 232, height: 12, marginBottom: 22 }} aria-hidden="true" />
        {/* The same two-column wrapper the loaded page uses, so the bars do not
            shrink from full width into a half column the moment the data lands. */}
        <div className="g2">
          <div>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={{ marginBottom: 17 }} aria-hidden="true">
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
                  <div className="skeleton" style={{ width: 84, height: 12 }} />
                  <div className="skeleton" style={{ width: 96, height: 12 }} />
                </div>
                <div className="skeleton" style={{ height: 7, borderRadius: 4 }} />
              </div>
            ))}
          </div>
          <div className="skeleton" style={{ height: 264 }} aria-hidden="true" />
        </div>
      </div>
    )
  }

  const monthTitle = (
    <h1 className="ph">
      {view.label}
    </h1>
  )

  if (error) {
    return (
      <div className="page">
        {monthTitle}
        <div className="sm muted" style={{ marginTop: 6 }}>
          This month could not be loaded. {error}
        </div>
      </div>
    )
  }

  // Optional is judged against pace, so an on-track month reads on plan all the
  // way. BUILD.md §7 defines the deviation as the optional bucket running over
  // target pace. `offPace` and "projected over target" are the same test:
  // spent/elapsed > target is spent > target × elapsed.
  const pace = optionalTarget * elapsed
  /**
   * With no optional lines budgeted there is no target, and therefore nothing to
   * deviate from. Left ungated, every dollar of optional spend read as a
   * deviation against a target of zero and the whole bucket painted red.
   */
  const hasTarget = optionalTarget > 0
  const overTarget = hasTarget && optionalSpent > optionalTarget
  const offPace = hasTarget && optionalSpent > pace
  // Projected month-end optional spend at the current rate. elapsed is always > 0.
  const projectedOptional = optionalSpent / elapsed

  const attackMet = attackTarget > 0 && attackSpent >= attackTarget
  const savingsMet = savingsTarget > 0 && savingsSpent >= savingsTarget

  /**
   * What the four targets commit, against what the budget says comes in.
   *
   * The old /month page ended in a plan-versus-actual panel whose first row was
   * exactly this. The redesign drops the panel and the statement had nowhere
   * else to go — no other page in the app reports income at all — so it is kept
   * here as a rule under the bars it qualifies. It is worth keeping: an attack
   * fund set above what is left after fixed, optional and savings is a plan the
   * budget cannot fund, and nothing else on screen would say so.
   *
   * Measured against the BUDGETED income line, never against the income
   * recorded so far. Part-way through a month only some of the pay has landed,
   * so comparing a whole month's commitment against what has arrived reads
   * short every month until payday. With no income line budgeted there is
   * nothing to compare against and the line is not drawn at all.
   */
  const committed = fixedTarget + optionalTarget + attackTarget + savingsTarget
  const budgetedIncome = totals.bucketTarget('income')

  const hasTransactions = transactions.length > 0
  /**
   * How much of the month's activity the budget deliberately ignores.
   *
   * Counted against the same rows the tables it sits under are counted against.
   * The business accounts are in one person's name, so the household figure —
   * `allTransactions.length - transactions.length` — printed under a table
   * headed with the OTHER person's name says that some of their transactions
   * are hidden, when none of them are. Narrowing the count to the selected
   * owner does not surface a single business row: the exclusion has already
   * happened, and this only reports how many of it were theirs.
   */
  const businessRows = allTransactions.filter((t) => isBusinessTxn(t, businessAccountIds))
  const businessExcluded = filterByOwner(businessRows, ownerFilter, ownerOf).length

  const neutral = !hasTransactions || !hasTarget
  const optionalColor = neutral ? 'var(--steel)' : offPace ? 'var(--red)' : 'var(--green)'
  const optionalClass = neutral ? 'muted' : offPace ? 'is-bad' : 'is-good'

  /**
   * The line under the Optional bar, which is the reason this page exists.
   *
   * A running total cannot be judged without knowing how much of the month is
   * left, so the remainder and the projection are stated together. A finished
   * month has no pace — it has a result.
   */
  const paceLine = (() => {
    if (!hasTransactions) return 'Nothing recorded this month.'
    if (!hasTarget) return `${money(optionalSpent)} spent. No optional target is budgeted.`
    const remainder = overTarget
      ? `${money(optionalSpent - optionalTarget)} over`
      : `${money(optionalTarget - optionalSpent)} left`
    if (!view.thisMonth) {
      return `${remainder} against the ${money(optionalTarget)} target, month complete`
    }
    if (daysLeft === 0) return `${remainder} on the last day of the month`
    const projection = `pace says ${money(projectedOptional)} by month end`
    if (!wide) return projection
    return `${remainder} with ${daysLeft === 1 ? '1 day' : `${daysLeft} days`} to go — ${projection}`
  })()

  /** "+$34" in red, "−$92" in green, "on" when the line landed on its target. */
  const variance = (spent: number, target: number): ReactNode => {
    const v = spent - target
    // Rounded, not raw: the figures beside it are whole dollars, so a 40-cent
    // difference printing as "+$0" in red reads as a deviation that is not one.
    if (Math.abs(v) < 0.5) return <span className="tiny muted">on</span>
    return (
      <span className={`tiny ${v > 0 ? 'is-bad' : 'is-good'}`}>
        {v > 0 ? '+' : '−'}
        {money(Math.abs(v))}
      </span>
    )
  }

  /**
   * What a narrowed table is called. " · Sam" rather than a word like
   * "filtered", so the heading says whose figures are underneath it at the same
   * moment the reader meets them, instead of relying on a chip further up.
   */
  const ownerSuffix = filtered ? ` · ${ownerLabel(ownerFilter)}` : ''

  /**
   * One person's slice of the household's optional spend.
   *
   * Steel, never green or red: a person is not a plan and cannot deviate from
   * one. The denominator is what was SPENT, which is the only figure a share of
   * a person means anything against.
   */
  const shareOfOptional = (n: number) =>
    optionalSpent > 0 ? `${Math.round((n / optionalSpent) * 100)}%` : ''

  /**
   * Optional spend on an account that is not loaded, so it belongs to nobody on
   * screen. Shown rather than absorbed: the people's figures adding up to less
   * than the bucket is a fact about the data, and hiding it would make the
   * percentages look complete when they are not.
   *
   * Tested on its magnitude, not its sign. A refund on an unloaded account
   * makes the remainder negative, and dropping the row then leaves the named
   * people's percentages summing to more than 100% with nothing on screen
   * saying why. Same test as the unassigned rows in the by-line tables.
   */
  const unattributed = Math.round((optionalSpent - byPerson.listed) * 100) / 100

  const prev = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1)
  const next = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1)

  /**
   * The six-month chart, placed by width rather than by CSS order.
   *
   * On a wide screen it belongs under the bars in the left column, where the
   * mockup puts it. On a phone the mockup's order is buckets, then the by-line
   * table, then the caveat — a run of history is context, and it should not sit
   * between a bucket and the lines that explain it. Left in the left column it
   * would land in the middle of the single-column stack, so it is rendered at
   * the foot instead. Crossing 1024px remounts it and refetches the five
   * earlier months, which is the cost of not having a CSS primitive for this.
   */
  const sixMonths = (
    <SpendingSixMonths
      anchor={anchor}
      businessAccountIds={businessAccountIds}
      target={optionalTarget}
      currentSpent={optionalSpent}
      currentRecorded={hasTransactions}
      inProgress={view.thisMonth}
    />
  )

  return (
    <div className="page">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div style={{ minWidth: 0 }}>
          {monthTitle}
          <div className="sm muted tnum">
            {view.thisMonth
              ? wide
                ? `day ${day} of ${daysInMonth}`
                : `day ${day}`
              : 'month complete'}
            {' · '}
            {income > 0
              ? wide
                ? `${money(spentTotal)} spent of ${money(income)} in`
                : `${money(spentTotal)} of ${money(income)}`
              : `${money(spentTotal)} spent`}
          </div>
        </div>

        {/* Arrows name their months where there is room, so a step back is a
            decision rather than a guess. On a phone they are bare chevrons. */}
        <nav
          className="tiny muted"
          aria-label="Month"
          style={{ display: 'flex', alignItems: 'baseline', gap: 8, flex: '0 0 auto' }}
        >
          <MonthStep
            label={wide ? `‹ ${MONTH_NAMES[prev.getMonth()]}` : '‹'}
            title={`${MONTH_NAMES[prev.getMonth()]} ${prev.getFullYear()}`}
            disabled={view.atEarliest}
            onClick={view.goPrev}
          />
          {wide && <span aria-hidden="true">{'·'}</span>}
          <MonthStep
            label={wide ? `${MONTH_NAMES[next.getMonth()]} ›` : '›'}
            title={`${MONTH_NAMES[next.getMonth()]} ${next.getFullYear()}`}
            disabled={view.thisMonth}
            onClick={view.goNext}
          />
        </nav>
      </div>

      {/*
        Whose money. Ink when held down, outlined when not, exactly like the
        chips on /activity: one chip vocabulary across the app, and nothing
        amber, because amber is the current payoff target and an owner is not a
        target of any kind. Drawn only where there is more than one owner to
        choose between, since a lone chip narrows nothing.
      */}
      {owners.length > 1 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            alignItems: 'center',
            marginBottom: 14,
          }}
        >
          <span className="tiny muted" style={{ marginRight: 2 }}>
            Whose
          </span>
          <OwnerChip on={!filtered} onClick={() => setOwnerChip('everyone')}>
            Everyone
          </OwnerChip>
          {owners.map((o) => (
            <OwnerChip key={o} on={ownerFilter === o} onClick={() => setOwnerChip(o)}>
              {ownerLabel(o)}
            </OwnerChip>
          ))}
        </div>
      )}

      {/*
        The four bucket bars on the left and the detail of the bucket that can
        go wrong on the right, so a bar and the lines that make it up are on
        screen together instead of a scroll apart. Below 1024px this is one
        column and the order is buckets, history, then detail.
      */}
      <div className="g2">
        <div>
          {/* Optional */}
          <div style={{ marginBottom: 16 }}>
            <BucketHeader
              label="Optional"
              count={(rowsInView.get('optional') ?? []).length}
              open={openBucket === 'optional'}
              onToggle={() => setOpenBucket((c) => (c === 'optional' ? null : 'optional'))}
              right={
                /* Filtered, the target comes off: it is the household's and
                   does not divide, so "$604 / $1,117" under one person's name
                   would put two denominators in one sentence. The share line
                   beneath supplies the honest one. */
                filtered ? (
                  <span className="tnum muted" style={{ fontWeight: 700 }}>
                    {money(optionalShown)}
                  </span>
                ) : (
                  <span className={`tnum ${optionalClass}`} style={{ fontWeight: 700 }}>
                    {money(optionalSpent)} / {money(optionalTarget)}
                  </span>
                )
              }
            />
            <Bar
              pct={
                filtered
                  ? optionalSpent > 0
                    ? optionalShown / optionalSpent
                    : 0
                  : optionalTarget > 0
                    ? optionalSpent / optionalTarget
                    : 0
              }
              color={filtered ? 'var(--steel)' : optionalColor}
            />
            {/* tnum, like every other figure: the pace line carries two of the
                loudest numbers on the page and they must line up with the
                total directly above them. */}
            {/* Pace projects HOUSEHOLD spending against a household target, so
                it says nothing about one person and is withdrawn rather than
                recomputed when a chip is held down. */}
            {!filtered && (
              <div className={`tnum tiny ${optionalClass}`} style={{ marginTop: 4 }}>
                {paceLine}
              </div>
            )}
            {/* The one per-person figure beside a bar, and it carries its own
                denominator. "$604 of the $1,044 spent" is true; "$604 of
                $1,117" would measure one person against a target the whole
                household shares. Steel, because a share is not a deviation.
                The whole-household split lives in the by-person table, which
                is where it is read without pressing anything. */}
            {hasTransactions && filtered && (
              <div className="tnum tiny muted" style={{ marginTop: 3 }}>
                {ownerLabel(ownerFilter)} {money(share.owed)} of the {money(share.whole)} spent
              </div>
            )}
            {openBucket === 'optional' && (
              <SpendingBucketRows
                rows={rowsInView.get('optional') ?? []}
                nameOf={nameOf}
                emptyNote="Nothing discretionary this month."
                onChanged={refresh}
              />
            )}
          </div>

          {/* Fixed. Steel, always: the committed bills are not a target anyone
              is trying to beat, and a bar that turns red for being 89% paid on
              day 22 would be reporting a deviation that has not happened. */}
          <div style={{ marginBottom: 16 }}>
            <BucketHeader
              label="Fixed"
              count={(rowsInView.get('fixed') ?? []).length}
              open={openBucket === 'fixed'}
              onToggle={() => setOpenBucket((c) => (c === 'fixed' ? null : 'fixed'))}
              right={
                <span className="tnum muted">
                  {filtered
                    ? `${money(fixedShown)} of ${money(fixedSpent)}`
                    : `${money(fixedSpent)} / ${money(fixedTarget)}`}
                </span>
              }
            />
            <Bar
              pct={
                filtered
                  ? fixedSpent > 0
                    ? fixedShown / fixedSpent
                    : 0
                  : fixedTarget > 0
                    ? fixedSpent / fixedTarget
                    : 0
              }
              color="var(--steel)"
            />
            {openBucket === 'fixed' && (
              <SpendingBucketRows
                rows={rowsInView.get('fixed') ?? []}
                nameOf={nameOf}
                emptyNote="Nothing committed has gone out yet this month."
                onChanged={refresh}
              />
            )}
          </div>

          {/* Attack fund */}
          <div style={{ marginBottom: 16 }}>
            <BucketHeader
              label="Attack fund"
              count={(rowsInView.get('attack') ?? []).length}
              open={openBucket === 'attack'}
              onToggle={() => setOpenBucket((c) => (c === 'attack' ? null : 'attack'))}
              right={
                <span
                  className={attackMet ? 'tnum is-good' : 'tnum muted'}
                  style={attackMet ? { fontWeight: 700 } : undefined}
                >
                  {filtered
                    ? `${money(attackShown)} of ${money(attackSpent)}`
                    : `${money(attackSpent)} sent`}
                </span>
              }
            />
            {/* Filtered, the bar is a share of what the household sent and the
                green "met" reading comes off: the attack fund is one household
                obligation, and no individual is on the hook for a portion of
                it that anyone has written down. */}
            <Bar
              pct={
                filtered
                  ? attackSpent > 0
                    ? attackShown / attackSpent
                    : 0
                  : attackTarget > 0
                    ? attackSpent / attackTarget
                    : 0
              }
              color={!filtered && attackMet ? 'var(--green)' : 'var(--steel)'}
            />
            {!filtered && hasTransactions && !attackMet && attackTarget > 0 && (
              <div
                className={`tnum tiny ${day > ATTACK_DUE_DAY ? 'is-bad' : 'muted'}`}
                style={{ marginTop: 4 }}
              >
                {money(gap(attackTarget, attackSpent))} short of {money(attackTarget)}
                {day > ATTACK_DUE_DAY ? `, due by day ${ATTACK_DUE_DAY}` : ''}
              </div>
            )}
            {openBucket === 'attack' && (
              <SpendingBucketRows
                rows={rowsInView.get('attack') ?? []}
                nameOf={nameOf}
                emptyNote="Nothing has reached the current target this month."
                onChanged={refresh}
              />
            )}
          </div>

          {/* Savings */}
          <div style={{ marginBottom: 16 }}>
            <BucketHeader
              label="Savings"
              count={(rowsInView.get('savings') ?? []).length}
              open={openBucket === 'savings'}
              onToggle={() => setOpenBucket((c) => (c === 'savings' ? null : 'savings'))}
              right={
                <span
                  className={!filtered && savingsMet ? 'tnum is-good' : 'tnum muted'}
                  style={!filtered && savingsMet ? { fontWeight: 700 } : undefined}
                >
                  {filtered
                    ? `${money(savingsShown)} of ${money(savingsSpent)}`
                    : `${money(savingsSpent)} sent`}
                </span>
              }
            />
            {/* Same as the attack fund: the monthly deposit is one household
                commitment, so a person's share of it is worth showing and a
                per-person "met" is not a thing that exists. */}
            <Bar
              pct={
                filtered
                  ? savingsSpent > 0
                    ? savingsShown / savingsSpent
                    : 0
                  : savingsTarget > 0
                    ? savingsSpent / savingsTarget
                    : 0
              }
              color={!filtered && savingsMet ? 'var(--green)' : 'var(--steel)'}
            />
            {!filtered && hasTransactions && !savingsMet && savingsTarget > 0 && (
              <div className="tnum tiny muted" style={{ marginTop: 4 }}>
                {money(gap(savingsTarget, savingsSpent))} short of {money(savingsTarget)}
              </div>
            )}
            {openBucket === 'savings' && (
              <SpendingBucketRows
                rows={rowsInView.get('savings') ?? []}
                nameOf={nameOf}
                emptyNote="Nothing has moved to savings this month."
                onChanged={refresh}
              />
            )}
          </div>

          {/* What the chip did NOT narrow, said where the unnarrowed figures
              are. Without this the four bars, the pace line and the income
              arithmetic all sit under a person's name while reporting the
              household, which is the one way this feature can lie. */}
          {/* What "whose" means, in the column where a person's name is first
              put against a figure. The share line under the Optional bar is the
              only attributed number outside the right-hand tables, and it had
              nothing near it saying the attribution is by ACCOUNT: the caveat
              was at the foot of the other column, which below 1024px is a whole
              screen further down a single stack. Two copies in a filtered view,
              one per column, rather than one copy a reader meets after the
              claim it qualifies. */}
          {filtered && <div className="rule">{OWNER_CAVEAT}</div>}

          {filtered && (
            <div className="rule">
              The bars, the rows behind them and the tables all show{' '}
              {ownerLabel(ownerFilter)}
              {"'s"} spending, stated as a share of what the household spent. Targets are
              budgeted for the household and there is no per-person one, so no target, pace
              or met figure is shown while a person is selected. The six-month history stays
              household, since it reports months rather than people.
            </div>
          )}

          {/* The budget's own arithmetic, stated under the four bars it is
              about. Only for the current month: budget lines carry one target
              and no history, so saying this beneath August's bars would report
              today's budget as though it had been August's. */}
          {view.thisMonth && budgetedIncome > 0 && committed > 0 && (
            <div className="rule tnum">
              {committed > budgetedIncome ? (
                <>
                  The four targets commit {money(committed)} against the {money(budgetedIncome)} the
                  budget says comes in,{' '}
                  <span className="is-bad">{money(committed - budgetedIncome)} more than it funds</span>.
                </>
              ) : (
                `The four targets commit ${money(committed)} of the ${money(budgetedIncome)} the budget says comes in, leaving ${money(budgetedIncome - committed)}.`
              )}
            </div>
          )}

          {wide && sixMonths}
        </div>

        <div>
          <div className="box">
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
              Optional, by line{ownerSuffix}
            </div>
            {linesIn.optional.lines.length === 0 && linesIn.optional.unassigned === 0 ? (
              <div className="tiny muted">
                {filtered
                  ? `Nothing discretionary under ${ownerLabel(ownerFilter)} this month.`
                  : 'Nothing discretionary this month.'}
              </div>
            ) : (
              <table className="tbl">
                <tbody>
                  {linesIn.optional.lines.map((l) => (
                    <tr key={l.id}>
                      <td>{l.line_name}</td>
                      <td className="num">{money(l.spent)}</td>
                      {/* No variance while a person is selected. A line's target
                          is the household's, so "$120, −$380" against one
                          person's groceries would report a saving that nobody
                          made. The column is dropped rather than blanked out
                          per row, so no empty gutter implies a missing figure. */}
                      {!filtered && (
                        <td className="num" style={{ width: 54 }}>
                          {variance(l.spent, l.monthly_target)}
                        </td>
                      )}
                    </tr>
                  ))}
                  {Math.abs(linesIn.optional.unassigned) >= 0.01 && (
                    <tr>
                      <td className="muted">Not assigned to a line</td>
                      <td className="num">{money(linesIn.optional.unassigned)}</td>
                      {!filtered && <td className="num" />}
                    </tr>
                  )}
                </tbody>
              </table>
            )}

            {/*
              Who spent it, without needing the filter at all. This is the
              answer the chips exist to give, given in one glance and for
              everybody at once, so the chips are for following a figure up
              rather than for finding it.

              Only in the unfiltered view: with one person selected this would
              be a one-row table repeating the line under the bar.
            */}
            {!filtered && byPerson.rows.length > 0 && (
              <>
                <div style={{ fontSize: 13, fontWeight: 700, margin: '16px 0 6px' }}>
                  Optional, by person
                </div>
                {wide ? (
                  <table className="tbl">
                    <tbody>
                      {byPerson.rows.map((r) => (
                        <tr key={r.owner}>
                          <td>{ownerLabel(r.owner)}</td>
                          <td className="num">{money(r.total)}</td>
                          <td className="num" style={{ width: 54 }}>
                            <span className="tiny muted">{shareOfOptional(r.total)}</span>
                          </td>
                        </tr>
                      ))}
                      {Math.abs(unattributed) >= 0.01 && (
                        <tr>
                          <td className="muted">Account not loaded</td>
                          <td className="num">{money(unattributed)}</td>
                          <td className="num">
                            <span className="tiny muted">{shareOfOptional(unattributed)}</span>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                ) : (
                  <div>
                    {byPerson.rows.map((r) => (
                      <div className="row" key={r.owner}>
                        <span style={{ flex: 1, minWidth: 0 }}>{ownerLabel(r.owner)}</span>
                        <span className="tnum">{money(r.total)}</span>
                        <span className="tnum tiny muted" style={{ width: 38, textAlign: 'right' }}>
                          {shareOfOptional(r.total)}
                        </span>
                      </div>
                    ))}
                    {Math.abs(unattributed) >= 0.01 && (
                      <div className="row">
                        <span className="muted" style={{ flex: 1, minWidth: 0 }}>
                          Account not loaded
                        </span>
                        <span className="tnum">{money(unattributed)}</span>
                        <span className="tnum tiny muted" style={{ width: 38, textAlign: 'right' }}>
                          {shareOfOptional(unattributed)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                <div className="rule">{OWNER_CAVEAT}</div>
              </>
            )}

            <div style={{ fontSize: 13, fontWeight: 700, margin: '16px 0 6px' }}>
              Biggest single items{ownerSuffix}
            </div>
            {biggestItems.length === 0 ? (
              <div className="tiny muted">
                {filtered
                  ? `Nothing discretionary under ${ownerLabel(ownerFilter)} this month.`
                  : 'Nothing discretionary this month.'}
              </div>
            ) : (
              <table className="tbl">
                <tbody>
                  {biggestItems.map((b) => (
                    <tr key={b.label}>
                      <td>
                        {b.label}
                        {b.count > 1 && <span className="tiny muted"> {'×'}{b.count}</span>}
                      </td>
                      <td className="num">{money(b.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Said plainly, because a figure that quietly disagrees with the
                bank reads as a fault. The rows are still on Activity, behind
                its own show-business control. */}
            <div className="rule">
              Business spending is not counted here.
              {businessExcluded > 0
                ? ` ${businessExcluded} ${businessExcluded === 1 ? 'transaction' : 'transactions'}${
                    filtered ? ` of ${ownerLabel(ownerFilter)}'s` : ''
                  } hidden.`
                : filtered
                  ? ` None of ${ownerLabel(ownerFilter)}'s this month.`
                  : ' None this month.'}
            </div>
          </div>

          {/*
            Fixed had no breakdown at all for a long time — ten lines and more
            than seven thousand a month behind a single bar. A grocery budget you
            cannot see is a grocery budget you cannot keep.
          */}
          <div className="box" style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
              Fixed, by line{ownerSuffix}
            </div>
            {linesIn.fixed.lines.length === 0 && linesIn.fixed.unassigned === 0 ? (
              <div className="tiny muted">
                {filtered
                  ? `Nothing committed has gone out under ${ownerLabel(ownerFilter)} this month.`
                  : 'Nothing committed has gone out yet this month.'}
              </div>
            ) : (
              <table className="tbl">
                <tbody>
                  {linesIn.fixed.lines.map((l) => (
                    <tr key={l.id}>
                      <td>{l.line_name}</td>
                      <td className="num">{money(l.spent)}</td>
                      {/* Dropped while filtered, for the same reason as the
                          optional table: the target belongs to the household
                          and the figure beside it would not. */}
                      {!filtered && (
                        <td className="num" style={{ width: 54 }}>
                          {variance(l.spent, l.monthly_target)}
                        </td>
                      )}
                    </tr>
                  ))}
                  {Math.abs(linesIn.fixed.unassigned) >= 0.01 && (
                    <tr>
                      <td className="muted">Not assigned to a line</td>
                      <td className="num">{money(linesIn.fixed.unassigned)}</td>
                      {!filtered && <td className="num" />}
                    </tr>
                  )}
                </tbody>
              </table>
            )}
            {/* A fixed line is a bill, so it is only over or under once the
                month has run. Part-way through, "−$240" on the mortgage means
                it has not gone out yet. Only worth saying where the variance
                column is drawn at all. */}
            {view.thisMonth && !filtered && (
              <div className="rule">
                A fixed line reads under until its bill goes out. The variance is only a
                deviation once the month has ended.
              </div>
            )}
          </div>

          {/* Carried once at the foot of this column, under every table the
              chip narrowed, rather than repeated under each of the three: the
              same two sentences printed three times within a scroll stop being
              read. The left column carries its own copy for its own attributed
              figure. The string comes from lib/owners, so this page and
              /activity cannot describe the limitation two different ways. */}
          {filtered && <div className="rule">{OWNER_CAVEAT}</div>}
        </div>

        {!wide && sixMonths}
      </div>
    </div>
  )
}

/**
 * One owner chip.
 *
 * Ink when held down, outlined when not, which is the same two states /activity
 * gives its filter chips. Deliberately not amber: amber is the current payoff
 * target and nothing else in this app, and an owner is a way of reading the
 * month rather than something being aimed at. Kept local for the same reason
 * /activity keeps its own — this page owns no stylesheet, and the chip is four
 * lines of style over a shared `.pill`.
 */
function OwnerChip({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="pill"
      aria-pressed={on}
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

/** One arrow in the month nav. Bare text, so the figures stay the loudest thing. */
function MonthStep({
  label,
  title,
  disabled,
  onClick,
}: {
  label: string
  title: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      style={{
        background: 'none',
        border: 'none',
        padding: '2px 0',
        font: 'inherit',
        color: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.35 : 1,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

/** A bucket's heading, which is also the control that opens it. */
function BucketHeader({
  label,
  right,
  count,
  open,
  onToggle,
}: {
  label: string
  right: ReactNode
  count: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      style={{
        width: '100%',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 10,
        marginBottom: 5,
        background: 'none',
        border: 'none',
        padding: 0,
        // `font` is a shorthand and resets size, so it goes FIRST: declared
        // after fontSize it would silently drop the bucket label back to body
        // size.
        font: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
        textAlign: 'left',
        color: 'inherit',
      }}
    >
      <span style={{ fontWeight: 700 }}>
        {label}
        <span className="tiny muted" style={{ fontWeight: 400 }}>
          {' '}
          {open ? '▴' : '▾'}
          {count > 0 ? ` ${count}` : ''}
        </span>
      </span>
      {right}
    </button>
  )
}
