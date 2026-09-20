import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Bar from '../components/Bar'
import { useData, useNetWorth, usePayoffPlan, useMonthTotals } from '../lib/data'
import {
  money,
  moneyCents,
  signedAmount,
  accountLabel,
  ownerLabel,
  parseDateOnly,
  relativeTime,
  rateLabel,
  dueStatus,
} from '../lib/format'
import {
  useFrozenPlan,
  planMonthNumber,
  rowAt,
  type FrozenPlan,
  type PlanProjectionsState,
} from '../lib/planVersion'
import { syncNow } from '../lib/plaidLink'

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** "February 2029" — how every frozen date is said on this page. */
const monthYear = (dateStr: string) =>
  parseDateOnly(dateStr).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

/** How many rows of the queue show before the "+ N more" line. */
const QUEUE_PREVIEW = 4

/**
 * Desktop gets a real table, the phone gets rows. There is no display utility
 * in index.css for this and index.css is the shell's, not this page's, so the
 * breakpoint is read here instead of being expressed in CSS.
 *
 * matchMedia is read in the initial state rather than only in the effect: a
 * first paint of phone rows that swaps to a table one frame later is a visible
 * jump on every load of a wide screen. The effect re-reads it anyway, because
 * the initial read happens before the effect on a resize between the two.
 */
const WIDE = '(min-width: 1024px)'

function useIsDesktop(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(WIDE).matches,
  )

  useEffect(() => {
    const mq = window.matchMedia(WIDE)
    const onChange = () => setWide(mq.matches)
    setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return wide
}

/**
 * Sub-line under a debt name in the queue: the rate, then whose debt it is.
 *
 * The owner used to lead the name via accountLabel(). In the redesign the
 * account's own name is the bold thing and the owner moves here beside the
 * rate, which is what the mockup shows — but the owner is still printed, and
 * deliberately so: two cards in this household carry the SAME nickname, and
 * without the owner the queue would show the same row twice.
 *
 * A due date joins the line only when it is urgent. Every debt carrying a grey
 * date turns the queue into a list to read rather than an order to work
 * through, and the Calendar page is where dates belong; what still earns space
 * here is a payment that is late or nearly late. Red for overdue or due within
 * two days, never amber, which means the current target and nothing else.
 */
function DebtSubLine({
  debt,
}: {
  debt: {
    apr: number | null
    kind: string
    owner: string
    next_due_on: string | null
    last_payment_on: string | null
    last_payment_amount: number | null
  }
}) {
  // dueStatus, not dueLabel: the due date on its own reports a bill as late for
  // having been paid on time, because the issuer only advances it when the next
  // statement cuts. A payment on or after the due date withdraws the claim.
  const { label, urgent } = dueStatus(debt)

  return (
    <span className="tiny muted tnum">
      {rateLabel(debt)} · {ownerLabel(debt.owner)}
      {label && urgent && (
        <>
          {' · '}
          <span className="is-bad" style={{ fontWeight: 700 }}>
            {label}
          </span>
        </>
      )}
    </span>
  )
}

/**
 * The freshness line doubles as the refresh control. Tapping it asks for a pull
 * now rather than waiting for the nightly one — the state it reports is also the
 * state you would want to change, so the two belong on the same word.
 */
function Header({
  syncedAt,
  onRefresh,
  busy,
  note,
}: {
  syncedAt: string | null
  onRefresh: () => void
  busy: boolean
  note: string | null
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      {/* The wordmark is hidden at >=1024px, where the sidebar carries the same
          word a couple of hundred pixels to the left. Hidden, not removed: on a
          phone there is no sidebar and this is the only place the app is named.
          The row's justification lives in CSS so the freshness link can take the
          full width once the wordmark goes. */}
      <div className="home-header">
        <span className="home-wordmark" style={{ fontWeight: 700, fontSize: 16 }}>
          Payoff
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="tiny muted tnum"
          aria-label="Check the banks for anything new"
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            font: 'inherit',
            cursor: busy ? 'default' : 'pointer',
            textDecoration: busy ? 'none' : 'underline',
          }}
        >
          {busy
            ? 'checking…'
            : syncedAt
              ? `synced ${relativeTime(syncedAt)}`
              : 'not synced yet'}
        </button>
      </div>
      {note && (
        <div className="tiny muted" style={{ textAlign: 'right', marginTop: 3 }}>
          {note}
        </div>
      )}
    </div>
  )
}

/**
 * Net worth, compact: everything owned less everything owed, and the three
 * lines it is made of.
 *
 * The full panel with equity per vehicle lives on Accounts. Home shows the
 * figure and its parts, because the mockup gives this half a column beside the
 * savings stat and an eight-row vehicle table would out-weigh the hero.
 *
 * On a phone the mockup drops to a tile of label and figure sitting beside the
 * savings one, and `compact` is that tile. The breakdown is not worth three
 * more rows between the hero and the queue: the queue is the reason the screen
 * exists, and the same reasoning keeps cleared accounts collapsed below it.
 *
 * Every figure comes from useNetWorth(), which sums the account rows by kind.
 * Nothing here may be re-derived from plan.totalOwed — that counts only debts
 * which are not cleared, and `cleared` is true the moment cleared_at is set even
 * with a balance still on the account. Such a debt would drop out of net worth
 * while the household still owed it.
 */
function NetWorthStat({ compact = false }: { compact?: boolean }) {
  const { assetsTotal, cashTotal, debtTotal, netWorth } = useNetWorth()
  const { assetsError } = useData()

  return (
    <div
      className="stat"
      style={compact ? { flex: 1, minWidth: 0, padding: '10px 11px' } : { marginBottom: 14 }}
    >
      <div className="caps">NET WORTH</div>

      {/*
        A failed assets read leaves the same empty array an empty table would, so
        net worth would compute as cash-minus-debt: −$116,090 instead of −$52,348,
        with no sign that $63,742 of vehicles simply never arrived. A banner over a
        confidently wrong figure is barely better than the figure alone — the
        reader takes the big number and skims the small type — so the figure itself
        is withheld, not annotated.

        signedAmount(), never signedMoney(). signedMoney exists for Plaid
        transaction amounts, where a POSITIVE number is money going OUT, so it
        flips every sign it is given and would print this as a positive net worth.
        U+2212 is a real minus sign, not a hyphen.

        Ink, not red, while the figure is negative. Red on this page means a
        deviation from the plan, and a household this far into a payoff is
        SUPPOSED to be worth less than nothing for years yet — the plan says so
        and every month it rises is the plan working. The minus sign already
        says which side of zero it is on.
      */}
      <div
        className="tnum"
        style={{
          fontSize: compact ? 17 : 23,
          fontWeight: 800,
          letterSpacing: '-.02em',
          margin: compact ? '2px 0 0' : '3px 0 1px',
          color: assetsError ? 'var(--steel)' : 'var(--ink)',
        }}
      >
        {assetsError ? '—' : signedAmount(netWorth)}
      </div>

      <div className="tiny muted">
        {assetsError
          ? 'Half of it did not load, so no figure is given.'
          : compact
            ? 'Owned less owed'
            : 'Owned less owed · rises as the debt falls'}
      </div>

      {/*
        To the cent, not to the dollar the mockup draws. Rounded to whole dollars
        these three lines stop visibly adding up to the figure above them — assets
        plus cash less debt lands two dollars out — and a balance sheet whose own
        arithmetic looks wrong on screen is not worth printing.

        Assets prints "unavailable", never $0.00: zero is a claim about what is
        owned, and it is the same false claim the withheld figure above exists to
        avoid. Cash and debt did load, so they are stated.
      */}
      {!compact && (
        <table className="tbl" style={{ marginTop: 8 }}>
          <tbody>
            <BreakdownRow
              label="Assets"
              value={assetsError ? 'unavailable' : moneyCents(assetsTotal)}
            />
            <BreakdownRow label="Cash" value={moneyCents(cashTotal)} />
            <BreakdownRow label="Debt" value={`−${moneyCents(debtTotal)}`} />
          </tbody>
        </table>
      )}
    </div>
  )
}

function BreakdownRow({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td className="tiny" style={{ padding: '5px 0' }}>
        {label}
      </td>
      <td className="tiny num" style={{ padding: '5px 0' }}>
        {value}
      </td>
    </tr>
  )
}

function HomeSkeleton() {
  const isDesktop = useIsDesktop()

  return (
    <div className="page">
      <div className="home-header" style={{ marginBottom: 14 }}>
        <span className="home-wordmark" style={{ fontWeight: 700, fontSize: 16 }}>
          Payoff
        </span>
        <div className="skeleton" style={{ width: 84, height: 9 }} aria-hidden="true" />
      </div>

      <div className="skeleton" style={{ width: 104, height: 9, marginBottom: 8 }} aria-hidden="true" />
      <div className="skeleton" style={{ width: 218, height: 44, marginBottom: 9 }} aria-hidden="true" />
      <div className="skeleton" style={{ width: 150, height: 9, margin: '5px 0 13px' }} aria-hidden="true" />
      <div className="skeleton" style={{ width: '100%', height: 7, marginBottom: 24 }} aria-hidden="true" />

      {/* The SAME two-column wrapper the loaded page uses. Without it the target
          panel runs the full 1100px here and then jumps into a half column the
          moment the data lands. */}
      <div className="g2" style={{ marginBottom: 16 }}>
        <div>
          <div className="skeleton" style={{ width: '100%', height: 124, marginBottom: 12 }} aria-hidden="true" />
          <div className="skeleton" style={{ width: '100%', height: 52 }} aria-hidden="true" />
        </div>
        {/* Two stacked panels on a desktop, the phone's pair of tiles beside
            each other below it. Same shapes the loaded page draws, so nothing
            under the queue moves when the data arrives. */}
        {isDesktop ? (
          <div>
            <div className="skeleton" style={{ width: '100%', height: 168, marginBottom: 14 }} aria-hidden="true" />
            <div className="skeleton" style={{ width: '100%', height: 92 }} aria-hidden="true" />
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="skeleton" style={{ flex: 1, height: 62 }} aria-hidden="true" />
            <div className="skeleton" style={{ flex: 1, height: 62 }} aria-hidden="true" />
          </div>
        )}
      </div>

      <div className="sect">The queue</div>
      <div aria-label="Loading the queue">
        {[0, 1, 2, 3].map((i) => (
          <div className="row" key={i}>
            <div className="skeleton dot" aria-hidden="true" />
            <div style={{ flex: 1 }}>
              <div className="skeleton" style={{ width: 124, height: 9, marginBottom: 6 }} aria-hidden="true" />
              <div className="skeleton" style={{ width: 86, height: 8 }} aria-hidden="true" />
            </div>
            <div className="skeleton" style={{ width: 58, height: 9 }} aria-hidden="true" />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Why a frozen figure is not on screen. Stated, never worked around.
 *
 * The page keeps rendering: every live figure — what is owed today, the target,
 * net worth, the queue — comes from the accounts and is unaffected. What goes
 * missing is the month number, the clear-by date and the clearing month against
 * each debt, and those say so rather than being computed here. Simulating them
 * as a stopgap is exactly how the frozen line unfreezes: the page would look
 * right and be wrong only in the way the table exists to prevent.
 */
function FrozenPlanNotice({ state }: { state: PlanProjectionsState }) {
  if (state.status === 'ready' || state.status === 'loading') return null

  return (
    <div className="banner banner--red" style={{ marginBottom: 16 }}>
      <div className="sm" style={{ fontWeight: 700, color: 'var(--red-tx)' }}>
        {state.status === 'missing'
          ? 'No plan has been generated'
          : 'The plan could not be read'}
      </div>
      <div className="tiny" style={{ color: 'var(--red-tx)', marginTop: 3 }}>
        {state.status === 'missing'
          ? 'There is no frozen plan version, so the month number, the clear-by date and each account’s clearing month are not stated. Balances below are live and unaffected.'
          : state.message}
      </div>
    </div>
  )
}

export default function Home() {
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()

  /**
   * The queue shows four rows and then a "+ N more" line, per the mockup. The
   * first four are the work in front of you; the rest is the shape of the thing,
   * which the line states as a count and a total without spending a screen on it.
   */
  const [showAllQueue, setShowAllQueue] = useState(false)

  /**
   * Cleared debts are collapsed by default. Struck-through rows pushed the
   * live queue below the fold, and the accounts that still need paying are the
   * reason the screen exists. They stay reachable — a cleared debt is the record
   * of the work done, not something to hide.
   */
  const [showCleared, setShowCleared] = useState(false)

  const { loading, error, debts, lastSyncedAt, progress, progressError, refresh } = useData()
  const [syncing, setSyncing] = useState(false)
  const [syncNote, setSyncNote] = useState<string | null>(null)

  async function refreshNow() {
    setSyncing(true)
    setSyncNote(null)
    const res = await syncNow()
    // Re-read regardless: a partial pull still moved something.
    await refresh()
    setSyncNote(res.message)
    setSyncing(false)
  }

  const plan = usePayoffPlan()
  const totals = useMonthTotals()

  /**
   * Every projected figure on this page. Read from plan_projections, never
   * simulated — see planVersion.ts. `usePayoffPlan()` still supplies what is
   * true today; only what is claimed about the future comes from here.
   */
  const planState = useFrozenPlan()
  const frozen: FrozenPlan | null = planState.status === 'ready' ? planState.frozen : null

  const target = plan?.target ?? null

  /** Facts that differ from the plan. Reported, never advised on. */
  const deviations = useMemo(() => {
    const out: string[] = []

    const optionalTarget = totals.bucketTarget('optional')
    const optionalSpent = totals.bucketSpent('optional')
    if (optionalTarget > 0) {
      const now = new Date()
      const dayOfMonth = now.getDate()
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
      const pace = optionalTarget * (dayOfMonth / daysInMonth)
      if (optionalSpent > pace) {
        // Pace, not just the total. "105% of the bucket" on the 8th of the month
        // and "105%" on the 28th are the same sentence describing two very
        // different months; the projection at today's rate is what separates
        // them. Still a report: what will happen if nothing changes, not advice.
        const projected = optionalSpent * (daysInMonth / dayOfMonth)
        out.push(
          `Optional bucket at ${Math.round((optionalSpent / optionalTarget) * 100)}% · pace says ${money(projected)} by month end`,
        )
      }
    }

    // CARDS only, and the same reasoning as the alert that reports this by push:
    // a rising balance is worth flagging because it means something was SPENT on
    // an account that should be dormant. A loan or a tax debt cannot be spent on.
    // Its balance moves because interest accrued, or because the debt came into
    // existence at all — and a consolidation loan appearing on the day it was
    // drawn was being reported here as a fifty-thousand-dollar deviation.
    //
    // This duplicates the test in check-alerts deliberately: one reports to the
    // screen, the other to a phone. They were fixed separately because they had
    // drifted apart, which is exactly the hazard of keeping two copies.
    for (const d of debts) {
      if (d.kind !== 'card') continue
      if (target && d.id === target.id) continue
      if (d.previousBalance === null) continue
      if (d.balance > d.previousBalance) {
        out.push(`${accountLabel(d)} balance rose ${money(d.balance - d.previousBalance)}`)
      }
    }

    return out
  }, [debts, target, totals])

  // Skeleton on the FIRST load only. `loading` flips back on for every refresh —
  // a tab focus, a token refresh, a save elsewhere — and swapping a screen full
  // of real figures for placeholders at those moments reads as the app breaking,
  // not as it working. Accounts already draws this distinction; Home did not.
  if (loading && debts.length === 0) return <HomeSkeleton />

  // Without plan settings there is nothing to derive. Report it rather than
  // holding the skeleton forever — the error banner below is unreachable
  // while plan is null.
  if (!plan) {
    return (
      <div className="page">
        <Header syncedAt={lastSyncedAt} onRefresh={() => void refreshNow()} busy={syncing} note={syncNote} />
        <div className="banner banner--red" style={{ marginBottom: 16 }}>
          <div className="sm" style={{ fontWeight: 700, color: 'var(--red-tx)' }}>
            {error ? 'Data did not load' : 'No plan settings on record'}
          </div>
          <div className="tiny" style={{ color: 'var(--red-tx)', marginTop: 3 }}>
            {error ?? 'The plan row is empty, so no figures can be derived.'}
          </div>
        </div>

        {/*
          The balance sheet survives a missing plan row. Net worth is derived
          from accounts and assets alone — it needs no attack fund, no start
          date and no projection — so having it vanish along with everything
          else whenever plan_settings fails to load hid figures that were
          sitting right there in hand.
        */}
        <NetWorthStat />
      </div>
    )
  }

  /**
   * Which month of the plan this is, and how many there are.
   *
   * Both come from the frozen version: the month number off its effective_from
   * and the total off the number of projection rows. Measuring the month from
   * plan_settings.plan_started_on while reading the total off the version would
   * let the numerator and the denominator come from two different start dates.
   */
  const monthNo = frozen ? planMonthNumber(frozen.version.effective_from) : null
  const monthTotal = frozen ? frozen.planMonths : null

  /**
   * "MONTH 4 OF 29", and what that line says once month 29 has been and gone.
   *
   * The month number keeps counting while the frozen plan does not, so a
   * version written for 29 months reads MONTH 31 OF 29 two months after its
   * last row. A denominator smaller than its numerator is the same nonsense as
   * the old "MONTH 3 OF 2", and the fix cannot be to stretch the total: that
   * total is a stored figure and stretching it to cover today is editing a
   * frozen projection. The overrun is stated instead, which is in any case the
   * fact worth knowing — the plan ran its course and the debt outlived it.
   */
  const monthLabel =
    monthNo === null || monthTotal === null
      ? 'TOTAL OWED'
      : monthNo <= monthTotal
        ? `MONTH ${monthNo} OF ${monthTotal}`
        : `MONTH ${monthNo} · THE PLAN RAN ${monthTotal}`

  /**
   * Where the frozen plan says the debt should be by now, against where it is.
   *
   * month_index 0 is the state the version was generated from, so the row for
   * today is monthNo − 1. Green when less is owed than the plan expected, red
   * when more: on plan and off plan, which is exactly what the two colours mean.
   * Nothing here changes the stored rows — this is a comparison, not a revision.
   */
  const monthRow =
    frozen && monthNo !== null ? rowAt(frozen.plan, monthNo - 1) : null
  const offPlan = monthRow ? plan.totalOwed - monthRow.projected_debt : null

  /**
   * Interest still to come under the plan: the whole plan's interest less what
   * it had accrued by this month. `planInterest` on its own is the figure for
   * all 29 months including the ones already paid, which is not what "from
   * here" means.
   */
  const interestAhead =
    frozen && monthRow ? Math.max(0, frozen.planInterest - monthRow.cumulative_interest) : null

  const targetMin = target ? target.minimum_payment : 0

  /**
   * How far the target has come, measured from the HIGHEST balance ever
   * recorded against it rather than from opening_balance.
   *
   * This is the basis usePayoffPlan uses for the headline, and it is here for
   * the reason recorded there: opening_balance is the figure keyed in when the
   * account was added, so a card run up after it started being tracked peaked
   * above its opening figure, and measuring from the opening figure reports
   * progress that has not happened — or, once the balance passes the opening
   * one, clamps to an empty bar on an account genuinely being paid down. The
   * queue used to carry this rule on every row; the redesign drops those bars,
   * so the target's is the last bar it applies to.
   *
   * opening_balance stays as the fallback for an account the progress view has
   * not returned a row for, so a slow read never divides by zero.
   */
  const targetPeak = target ? progress[target.id]?.peak_balance ?? target.opening_balance : 0
  const targetPaidPct =
    target && targetPeak > 0 ? clamp01((targetPeak - target.balance) / targetPeak) : 0

  /**
   * When each account clears, from the frozen milestones — the months in which
   * the stored plan has an account clearing, by the account's own name.
   *
   * Matched on `name` because that is what the generator wrote into
   * accounts_cleared, not the owner-first label the rest of the UI uses. Two
   * cards in this household share a nickname, so a name is not a key: if both
   * are ever open at once the earlier milestone wins for both rows. Fixing that
   * means the generator storing account ids, which is a change to a stored
   * projection and so to a new version, not to this lookup.
   *
   * An account opened since the version was generated is not in the plan at
   * all, so it has no clearing month. That is a fact about the plan being older
   * than the account, and the row says nothing rather than guessing.
   */
  const clearingMonth = (name: string) =>
    frozen ? frozen.milestones.find((m) => m.names.includes(name)) ?? null : null

  const targetMilestone = target ? clearingMonth(target.name) : null
  const targetOutlook = !frozen
    ? 'no plan generated, so no clearing month'
    : targetMilestone
      ? `clears month ${targetMilestone.month_index} · ${monthYear(targetMilestone.projected_on)}`
      : 'not in the frozen plan — opened after it was generated'

  /**
   * Savings is measured against where the plan should have reached BY NOW, not
   * against the final figure. Against the final target a household saving exactly
   * what it promised every month still shows a nearly empty bar for years, which
   * reports failure at something being done correctly.
   *
   * Month N expects N-1 deposits, not N. The month number returns 1 on the day
   * the plan starts, so multiplying by it counted the first month's deposit as
   * already overdue before a single day had passed — the plan opened reporting a
   * shortfall. The deposit for the month in progress is not late until the month
   * is over.
   *
   * With no frozen version there is no month number, so there is no "by now" to
   * measure against. The bar then runs against the deposit target and the pace
   * line says nothing, rather than a paced figure being invented from today.
   */
  const pacedTarget =
    monthNo === null
      ? null
      : Math.min(Math.max(0, monthNo - 1) * plan.monthlySavings, plan.depositTarget)
  /**
   * The bar runs against whatever the line beneath it names, and in month 1
   * that cannot be the paced figure. Month 1 expects no deposits, so the paced
   * target is zero and a bar drawn against zero is meaningless; until the first
   * deposit falls due the bar runs against the deposit target instead, and the
   * caption says so. The caption used to read "of $28,550" over a bar measured
   * against the pace, which is two different denominators in one sentence.
   */
  const paceKnown = pacedTarget !== null && pacedTarget > 0
  const savingsDenominator = paceKnown ? (pacedTarget as number) : plan.depositTarget
  const savingsPct = savingsDenominator > 0 ? clamp01(plan.savingsBalance / savingsDenominator) : 0
  const savingsAhead = pacedTarget === null ? null : plan.savingsBalance - pacedTarget

  const clearedDebts = debts.filter((d) => d.balance <= 0 || d.cleared_at !== null)
  const activeDebts = debts.filter((d) => !(d.balance <= 0 || d.cleared_at !== null))

  const shownActive = showAllQueue ? activeDebts : activeDebts.slice(0, QUEUE_PREVIEW)
  const restActive = activeDebts.slice(shownActive.length)
  const restTotal = restActive.reduce((s, d) => s + d.balance, 0)

  const queue = showCleared ? [...shownActive, ...clearedDebts] : shownActive

  /** One queue entry, resolved once so the table and the rows cannot disagree. */
  const entries = queue.map((d) => {
    const isCleared = d.balance <= 0 || d.cleared_at !== null
    const isTarget = !isCleared && target !== null && d.id === target.id

    // A cleared account is labelled by the plan month it cleared in, measured
    // from the same effective_from the projection uses.
    const clearedIn =
      isCleared && d.cleared_at && frozen
        ? planMonthNumber(frozen.version.effective_from, parseDateOnly(d.cleared_at))
        : null
    const milestone = isCleared ? null : clearingMonth(d.name)

    return {
      debt: d,
      isCleared,
      isTarget,
      when: isCleared
        ? clearedIn !== null
          ? `cleared month ${clearedIn}`
          : 'cleared'
        : milestone
          ? `month ${milestone.month_index}`
          : '',
    }
  })

  return (
    <div className="page">
      <Header syncedAt={lastSyncedAt} onRefresh={() => void refreshNow()} busy={syncing} note={syncNote} />

      {error && (
        <div className="banner banner--red" style={{ marginBottom: 16 }}>
          <div className="sm" style={{ fontWeight: 700, color: 'var(--red-tx)' }}>
            Data did not load
          </div>
          <div className="tiny" style={{ color: 'var(--red-tx)', marginTop: 3 }}>
            {error}
          </div>
        </div>
      )}

      <FrozenPlanNotice state={planState} />

      {/* ---- The hero: what is owed, which month of the plan, when it ends ---- */}

      <div className="caps tnum" style={{ marginBottom: 2 }}>
        {monthLabel}
      </div>

      {/* The page's one hero figure, and the only thing on it at this size.
          `.hero__figure` rather than a fixed 46px: the primitive is 38px on a
          phone and 46px only from 1024px up, and 46px puts a six-figure total hard
          against both edges of a 376px screen. It carries tabular numerals of
          its own, so no .tnum is needed beside it. */}
      <div className="hero__figure">{money(plan.totalOwed)}</div>

      <div className="sm muted" style={{ margin: '4px 0 11px' }}>
        {frozen
          ? `clear by ${monthYear(frozen.debtFreeOn)}`
          : 'no clear-by date until a plan is generated'}
      </div>

      {/* A failed progress read is not zero progress. Without this the bar
          silently reads "$159 cleared so far" against a true $28,827, because
          the fallback measures from opening_balance — right for one genuinely
          new account, wrong for every account at once. Say it is unknown. */}
      <Bar pct={progressError ? 0 : plan.progress} color="var(--green)" />

      {/*
        Everything qualifying the hero, as a quiet rule rather than a row of
        panels. What has been cleared, what leaves each month, and how today's
        balance sits against the frozen line.

        The monthly outlay stays constant as debts clear — a cleared minimum
        rolls into the next target rather than being kept — so it is a rate, not
        a running tally.
      */}
      <div className="rule tnum" style={{ marginBottom: 22 }}>
        {progressError ? 'Progress not loaded' : `${money(plan.cleared)} cleared so far`} ·{' '}
        {money(plan.monthlyOutlay)} a month, being {money(plan.minimumsTotal)} in minimums
        {plan.attackFund > 0 ? ` plus ${money(plan.attackFund)} attack` : ''}
        {monthRow && offPlan !== null && (
          <>
            <br />
            The plan has {money(monthRow.projected_debt)} owed by now, so{' '}
            {/* money() rounds to whole dollars, so a gap of a few cents would
                otherwise print "$0 more is owed" in the red that means a real
                deviation. Under a dollar apart is level, and says so. */}
            {Math.round(Math.abs(offPlan)) === 0 ? (
              <span className="is-good">the balance is level with it</span>
            ) : (
              <>
                <span className={offPlan > 0 ? 'is-bad' : 'is-good'}>
                  {money(Math.abs(offPlan))} {offPlan > 0 ? 'more' : 'less'}
                </span>{' '}
                is owed than it expected
              </>
            )}
            .{interestAhead !== null && ` ${money(interestAhead)} of interest still to come.`}
          </>
        )}
        <br />
        <button
          type="button"
          onClick={() => navigate('/progress')}
          className="tiny muted"
          style={{
            background: 'none',
            border: 'none',
            padding: '4px 0 0',
            cursor: 'pointer',
            font: 'inherit',
            textDecoration: 'underline',
          }}
        >
          See how this has moved
        </button>
      </div>

      {/* ---- Target and deviations, beside net worth and savings ---- */}

      <div className="g2" style={{ marginBottom: 18 }}>
        <div>
          {target ? (
            <div className="hero" style={{ marginBottom: 12 }}>
              {/* The only amber on the page. */}
              {/* --target: this hero IS the account being attacked, which is the one
                  thing in the app entitled to amber. */}
              <div className="hero__label hero__label--target">CURRENT TARGET</div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 12,
                  marginTop: 6,
                }}
              >
                <span style={{ fontSize: 17, fontWeight: 700 }}>{target.name}</span>
                <span className="tnum" style={{ fontSize: 17, fontWeight: 800 }}>
                  {money(target.balance)}
                </span>
              </div>

              <div className="tiny hero__note tnum" style={{ marginTop: 3 }}>
                {rateLabel(target)} · {ownerLabel(target.owner)} · {money(plan.attackFund)} above
                the {money(targetMin)} minimum
                {/* Same reason as DebtSubLine: the due date alone would call a
                    card paid on its due date overdue until the next statement. */}
                {dueStatus(target).label ? ` · ${dueStatus(target).label}` : ''}
              </div>

              {/* .hero .bar already recesses the track against the ink panel. */}
              <div style={{ marginTop: 10 }}>
                <Bar pct={targetPaidPct} color="var(--amber)" />
              </div>

              <div className="tiny hero__note tnum" style={{ marginTop: 5 }}>
                {targetOutlook}
              </div>
            </div>
          ) : (
            debts.length > 0 && (
              <div className="banner banner--green" style={{ marginBottom: 12 }}>
                <div className="sm" style={{ fontWeight: 700 }}>
                  Every account is clear.
                </div>
              </div>
            )
          )}

          {deviations.length > 0 && (
            <div className="banner banner--red">
              <div className="sm tnum" style={{ fontWeight: 700, color: 'var(--red-tx)' }}>
                {deviations.length === 1
                  ? '1 thing differs from the plan'
                  : `${deviations.length} things differ from the plan`}
              </div>
              <div className="tiny tnum" style={{ color: 'var(--red-tx)', marginTop: 3 }}>
                {deviations.join(' · ')}
              </div>
            </div>
          )}
        </div>

        {/*
          Net worth is the one figure on the screen that gets BETTER by going
          up, and the only place the truck being underwater is visible at all.

          On a phone the two stats become the mockup's pair of tiles side by
          side: label, figure, one line. The breakdown and the savings bar are
          the wide screen's, because three more rows of balance sheet between
          the hero and the queue push the queue off the screen, and the queue is
          what the page is for. The one line each tile keeps is the paced one —
          "pace, not totals" is a rule of the system, not of the desktop.
        */}
        <div style={isDesktop ? undefined : { display: 'flex', gap: 10 }}>
          <NetWorthStat compact={!isDesktop} />

          <div
            className="stat"
            style={isDesktop ? undefined : { flex: 1, minWidth: 0, padding: '10px 11px' }}
          >
            <div className="caps">SAVINGS</div>
            <div
              className="tnum"
              style={{
                fontSize: isDesktop ? 23 : 17,
                fontWeight: 800,
                letterSpacing: '-.02em',
                margin: isDesktop ? '3px 0 7px' : '2px 0 0',
              }}
            >
              {money(plan.savingsBalance)}
            </div>

            {!isDesktop && (
              <div className="tiny muted tnum">
                {savingsAhead !== null && paceKnown ? (
                  <>
                    <span className={savingsAhead >= 0 ? 'is-good' : 'is-bad'}>
                      {signedAmount(savingsAhead, money)}
                    </span>{' '}
                    against the pace
                  </>
                ) : (
                  `of ${money(plan.depositTarget)}`
                )}
              </div>
            )}

            {isDesktop && (
              <>
                {/* Green when the deposits are on plan, red when they are behind,
                    steel when there is no frozen plan to be on or behind — green
                    with nothing to measure against would be a claim, not a report.
                    Never amber: the savings bar is not the payoff target, and the
                    mockup's amber here would put a second amber thing on the page. */}
                <Bar
                  pct={savingsPct}
                  color={
                    savingsAhead === null
                      ? 'var(--steel)'
                      : savingsAhead >= 0
                        ? 'var(--green)'
                        : 'var(--red)'
                  }
                />

                {/* Names the figure the bar is actually drawn against, and nothing else. */}
                <div className="tiny muted tnum" style={{ marginTop: 5 }}>
                  {paceKnown
                    ? `of ${money(savingsDenominator)} expected by now`
                    : `of ${money(plan.depositTarget)} · ${money(plan.monthlySavings)} a month`}
                </div>

                <div className="rule tnum">
                  {savingsAhead !== null && paceKnown && (
                    <>
                      <span className={savingsAhead >= 0 ? 'is-good' : 'is-bad'}>
                        {signedAmount(savingsAhead, money)}
                      </span>{' '}
                      against the pace · {money(plan.monthlySavings)} a month
                      <br />
                    </>
                  )}
                  {savingsAhead !== null && !paceKnown && (
                    <>
                      No deposit is late yet · the first is due when this month ends
                      <br />
                    </>
                  )}
                  {money(plan.savingsRemaining)} still to go
                  {paceKnown ? `, of ${money(plan.depositTarget)}` : ''}.
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ---- The queue ---- */}

      <div className="sect">The queue</div>

      {entries.length === 0 ? (
        <div className="row">
          <span className="sm muted">
            {debts.length === 0 ? 'No accounts on record.' : 'Every account is clear.'}
          </span>
        </div>
      ) : isDesktop ? (
        <table className="tbl">
          <tbody>
            {entries.map(({ debt: d, isCleared, isTarget, when }) => (
              <tr key={d.id} style={{ opacity: isCleared ? 0.42 : isTarget ? 1 : 0.72 }}>
                <td style={{ width: 26 }}>
                  <QueueDot isTarget={isTarget} isCleared={isCleared} />
                </td>
                <td>
                  <span
                    style={{
                      fontWeight: isTarget ? 700 : 400,
                      textDecoration: isCleared ? 'line-through' : undefined,
                    }}
                  >
                    {d.name}
                  </span>{' '}
                  <DebtSubLine debt={d} />
                </td>
                <td className="num" style={{ fontWeight: isTarget ? 700 : 400 }}>
                  {money(d.balance)}
                </td>
                <td className="num tiny muted" style={{ width: 118 }}>
                  {when}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div>
          {entries.map(({ debt: d, isCleared, isTarget, when }) => (
            <div
              className="row"
              key={d.id}
              style={{ opacity: isCleared ? 0.42 : isTarget ? 1 : 0.72 }}
            >
              <QueueDot isTarget={isTarget} isCleared={isCleared} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  className="sm"
                  style={{
                    fontWeight: isTarget ? 700 : 400,
                    textDecoration: isCleared ? 'line-through' : undefined,
                  }}
                >
                  {d.name}
                </div>
                <div>
                  <DebtSubLine debt={d} />
                  {when && <span className="tiny muted tnum"> · {when}</span>}
                </div>
              </div>
              <div className="tnum sm" style={{ fontWeight: isTarget ? 700 : 400 }}>
                {money(d.balance)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* The rest of the queue as a count and a total. Expanding is a choice,
          not the default: four rows is the work in front of you. */}
      {activeDebts.length > QUEUE_PREVIEW && (
        <button
          type="button"
          className="tiny muted tnum"
          aria-expanded={showAllQueue}
          onClick={() => setShowAllQueue((v) => !v)}
          style={{
            background: 'none',
            border: 'none',
            padding: '9px 0 0',
            font: 'inherit',
            cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >
          {showAllQueue
            ? `Show the first ${QUEUE_PREVIEW}`
            : `+ ${restActive.length} more · ${money(restTotal)}`}
        </button>
      )}

      {clearedDebts.length > 0 && (
        <div>
          <button
            type="button"
            className="btn ghost"
            style={{ marginTop: 12, fontSize: 13 }}
            aria-expanded={showCleared}
            onClick={() => setShowCleared((v) => !v)}
          >
            {showCleared
              ? 'Hide cleared'
              : `Show ${clearedDebts.length} cleared ${clearedDebts.length === 1 ? 'account' : 'accounts'}`}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The queue's dot. Amber filled for the current target and nothing else; a
 * hollow outline for everything waiting; green with a tick for what is done.
 */
function QueueDot({ isTarget, isCleared }: { isTarget: boolean; isCleared: boolean }) {
  if (isCleared) {
    return (
      <span className="dot" style={{ background: 'var(--green)' }} aria-hidden="true">
        ✓
      </span>
    )
  }
  return (
    <span
      className="dot"
      style={isTarget ? { background: 'var(--amber)' } : { border: '2px solid var(--line)' }}
      aria-hidden="true"
    />
  )
}
