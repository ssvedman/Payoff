import { useMemo } from 'react'
import ProgressChart, { ProgressSparkline } from '../components/ProgressChart'
import ProgressClearingOrder, {
  useWideScreen,
  type ClearingGroup,
} from '../components/ProgressClearingOrder'
import { useData, useNetWorth, usePayoffPlan } from '../lib/data'
import {
  useFrozenPlan,
  planMonthNumber,
  rowAt,
  type FrozenPlan,
  type PlanProjectionsState,
} from '../lib/planVersion'
import {
  completedPlanMonths,
  monthsBetween,
  useProgressData,
  type SnapshotProvenance,
} from '../lib/progressData'
import {
  accountLabel,
  money,
  moneyCents,
  parseDateOnly,
  rateLabel,
  MONTH_NAMES,
} from '../lib/format'
import { round2 } from '../lib/avalanche'

/**
 * /progress — what the plan saves, against what doing nothing would cost, and
 * against what has actually been measured.
 *
 * The page reports three things and recommends none of them. There is no "you
 * should", no encouragement and no exclamation mark: the gap between the plan's
 * interest and the minimums-only interest is an argument that makes itself, and
 * dressing it up would only invite the reader to discount it.
 *
 * BOTH PROJECTED LINES ARE READ FROM plan_projections AND NEVER RECOMPUTED.
 * They were generated once from the 15 September 2026 state. simulate() is not
 * imported here and must not be: a live fallback is how a frozen line quietly
 * unfreezes, and it would be invisible — the chart would look right, and be
 * wrong only in the way that matters. When the rows are missing the page says
 * so and draws nothing.
 *
 * Everything else on the page is live: today's balances, today's net worth,
 * today's savings, and the interest that has actually posted.
 */

/** "15 September 2026" — built from parts, so no locale can render it 9/15. */
function longDate(iso: string): string {
  const d = parseDateOnly(iso)
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`
}

/** "15 September" — the same, where the year is already on screen. */
function dayMonth(iso: string): string {
  const d = parseDateOnly(iso)
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`
}

/** "Nov 26" — the clearing-order column. */
function shortMonth(iso: string): string {
  const d = parseDateOnly(iso)
  return `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${String(d.getFullYear()).slice(2)}`
}

/** "Feb 2029" — where a year in full is worth the four characters. */
function monthYear(iso: string): string {
  const d = parseDateOnly(iso)
  return `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`
}

export default function Progress() {
  const { debts, plan: planSettings, loading } = useData()
  const payoff = usePayoffPlan()
  const netWorthNow = useNetWorth()
  const planState = useFrozenPlan()
  const wide = useWideScreen()

  const frozen = planState.status === 'ready' ? planState.frozen : null
  /**
   * The first version, present only once the plan has been revised.
   *
   * Progress is where a revision has to be visible: this is the page that
   * claims a target, and a target that quietly moved is the one thing the
   * whole versioning scheme exists to prevent.
   */
  const original = planState.status === 'ready' ? planState.original : null

  /**
   * Interest is measured from the VERSION's effective_from, not from
   * plan_settings.plan_started_on.
   *
   * Every other "since" figure on this page is counted from the version:
   * completedPlanMonths indexes into the frozen counterfactual with it, and the
   * date printed beside the table is it. If the two dates ever diverge, and a
   * revision that moves the plan's start is exactly how they would, then
   * "interest charged" and "minimums only would have cost" would cover
   * different windows and the difference between them would be a subtraction of
   * two unrelated numbers. plan_settings is the fallback only for the moment
   * before the version has loaded.
   */
  const {
    loading: extrasLoading,
    error,
    actual,
    provenance,
    interest,
  } = useProgressData(
    debts,
    frozen?.version.effective_from ?? planSettings?.plan_started_on ?? null,
  )

  /**
   * The measured readings, moved onto the plan's month index.
   *
   * buildActualSeries counts months from the CURRENT calendar month, because
   * that is where the old live simulation put its balances[0]. The frozen rows
   * count from the version's effective_from. Plotting one against the other
   * without this translation would slide the whole actual line by however many
   * months have passed since the plan was written — a drift that grows, silently,
   * exactly one month at a time.
   */
  const actualPoints = useMemo(() => {
    if (!frozen) return []
    const startKey = frozen.version.effective_from.slice(0, 7)
    return actual.map((p) => ({
      monthIndex: monthsBetween(startKey, p.monthKey),
      total: p.total,
    }))
  }, [frozen, actual])

  /**
   * The clearing order, one entry per month in which something clears.
   *
   * The stored rows carry the bare account name, because that is what the
   * generator had. Two cards in this household share one nickname, so a name is
   * resolved to the app's owner-first label only when EXACTLY one live account
   * answers to it; otherwise the stored name stands. Guessing which Quicksilver
   * was meant would put someone else's card in the queue.
   *
   * The balance is what is owed on those accounts today, which is a live figure
   * sitting beside frozen months on purpose: the month the account clears is the
   * plan's promise, the balance is where it has actually got to. If any name in
   * a group cannot be matched the sum is dropped rather than printed short — a
   * partial total understates the row by exactly the account that went missing,
   * and does it without saying so.
   */
  const groups = useMemo<ClearingGroup[]>(() => {
    if (!frozen) return []

    const targetName = payoff?.target?.name ?? null
    const targetIsUnique =
      targetName !== null && debts.filter((d) => d.name === targetName).length === 1

    return frozen.milestones.map((ms, i) => {
      const names: string[] = []
      let balance: number | null = 0

      for (const stored of ms.names) {
        const matches = debts.filter((d) => d.name === stored)
        if (matches.length === 1) {
          names.push(accountLabel(matches[0]))
          if (balance !== null) balance = round2(balance + Math.max(0, matches[0].balance))
        } else {
          names.push(stored)
          balance = null
        }
      }

      return {
        n: i + 1,
        names,
        balance,
        monthIndex: ms.month_index,
        clears: shortMonth(ms.projected_on),
        isLast: ms.month_index === frozen.planMonths,
        isTarget: targetIsUnique && ms.names.includes(targetName as string),
      }
    })
  }, [frozen, debts, payoff])

  if (loading || extrasLoading || planState.status === 'loading') return <ProgressSkeleton />

  if (!frozen) {
    return (
      <div className="page">
        <Header frozen={null} />
        <NoPlan state={planState} />
      </div>
    )
  }

  /** Which month of the plan today is. Measured from the version, not settings. */
  const monthNow = planMonthNumber(frozen.version.effective_from)
  /** Whole months finished. The plan began on the 15th, so four days in is zero. */
  const elapsedMonths = completedPlanMonths(frozen.version.effective_from)

  /**
   * What the minimums-only run had accrued by the end of the last completed
   * month, read straight off the stored counterfactual.
   *
   * This used to be a second run of the minimums recurrence (noRollInterestSoFar),
   * checked against the simulation's own total because two computations of one
   * number can drift. The stored rows make that whole apparatus unnecessary:
   * there is now exactly one computation of this figure, it happened once, and
   * cumulative_interest at month N is it.
   */
  const minimumsSoFar = rowAt(frozen.minimums, elapsedMonths)?.cumulative_interest ?? 0

  /**
   * null means the transaction read failed, NOT that nothing was charged. The
   * two have to print differently: a zero here is a statement about the
   * household's accounts, and printing one we did not measure would be the page
   * inventing the most comfortable of the two possible answers.
   */
  const observed = interest === null ? null : interest.total
  const savedSoFar = observed === null ? null : round2(minimumsSoFar - observed)

  const startedOn = dayMonth(frozen.version.effective_from)
  const lastPlanRow = frozen.plan[frozen.plan.length - 1]

  /** The account the attack fund is pointed at, and the month it comes off. */
  const target = payoff?.target ?? null
  const targetMilestone =
    target && debts.filter((d) => d.name === target.name).length === 1
      ? (frozen.milestones.find((m) => m.names.includes(target.name)) ?? null)
      : null

  /** Net worth by month under the plan. Nulls are months the generator left blank. */
  const netWorthLine = frozen.plan
    .map((p) => p.projected_net_worth)
    .filter((v): v is number => v !== null)

  const savingsNow = payoff?.savingsBalance ?? 0
  const depositTarget = frozen.version.deposit_target
  const savingsPct =
    depositTarget > 0 ? Math.min(100, Math.max(0, (savingsNow / depositTarget) * 100)) : 0

  /**
   * Whether each stored run actually reaches nothing.
   *
   * The old page read `stalled` off the simulation it had just run. The
   * generator computes the same flag but does not store it, so it is derived
   * here from the rows instead: a run that cleared ends at zero, and a final
   * month still carrying debt is a run that hit the generator's ceiling because
   * at least one minimum payment does not cover its own interest. Saying "103
   * months" about a run like that turns "it never ends" into a date, which is
   * the single most flattering thing this page could get wrong.
   */
  const lastMinimumsRow = frozen.minimums[frozen.minimums.length - 1]
  const planStalled = lastPlanRow.projected_debt > 0.005
  const minimumsStalled = lastMinimumsRow.projected_debt > 0.005

  const netWorthCard = (
    <div className="stat">
      <div className="tiny muted" style={{ fontWeight: 700, letterSpacing: '.05em' }}>
        NET WORTH
      </div>
      <div
        className="tnum"
        style={{ fontSize: 22, fontWeight: 800, margin: '3px 0 1px', letterSpacing: '-.02em' }}
      >
        {money(netWorthNow.netWorth)}
      </div>
      {/*
        Everything owned less everything owed. The figure that goes UP: debt
        falling is the same story told from the only angle where the best
        possible outcome is an empty chart, and this one has somewhere to go.
      */}
      <div className="tiny muted tnum">
        {netWorthLine.length > 1
          ? `plan reaches ${money(netWorthLine[netWorthLine.length - 1])} by ${monthYear(frozen.debtFreeOn)}`
          : 'everything owned, less everything owed'}
      </div>
      <ProgressSparkline values={netWorthLine} />
    </div>
  )

  const savingsCard = (
    <div className="stat">
      <div className="tiny muted" style={{ fontWeight: 700, letterSpacing: '.05em' }}>
        SAVINGS
      </div>
      <div
        className="tnum"
        style={{ fontSize: 22, fontWeight: 800, margin: '3px 0 7px', letterSpacing: '-.02em' }}
      >
        {money(savingsNow)}
      </div>
      {/* Ink, not amber. Amber is the current payoff target and the deposit
          is not it, however much it also happens to be a thing aimed at. */}
      <div className="bar">
        <span style={{ width: `${savingsPct}%`, background: 'var(--ink)' }} />
      </div>
      <div className="tiny muted" style={{ marginTop: 5 }}>
        of <span className="tnum">{money(depositTarget)}</span> ·{' '}
        <span className="tnum">{money(frozen.version.monthly_savings)}</span> a month
      </div>
      <div className="tiny muted">
        pace says <span className="tnum">{money(lastPlanRow.projected_savings)}</span> by{' '}
        <span className="tnum">{monthYear(frozen.debtFreeOn)}</span>
      </div>
    </div>
  )

  const targetCard = (
    <div className="stat">
      <div className="tiny muted" style={{ fontWeight: 700, letterSpacing: '.05em' }}>
        NEXT TO CLEAR
      </div>
      {target ? (
        <>
          {/* Ink. There is no amber anywhere on Progress: the page names no
              target account as its subject, and the colour is reserved for
              where the money is actually going, which Home and Accounts say. */}
          <div style={{ fontSize: 15, fontWeight: 700, margin: '3px 0 1px' }}>
            {accountLabel(target)}
          </div>
          <div className="tnum" style={{ fontSize: 17, fontWeight: 700 }}>
            {moneyCents(target.balance)}
          </div>
          <div className="tiny muted tnum">
            {rateLabel(target)}
            {targetMilestone
              ? ` · month ${targetMilestone.month_index}, ${monthYear(targetMilestone.projected_on)}`
              : ' · not named in this plan version'}
          </div>
        </>
      ) : (
        <div className="sm muted" style={{ marginTop: 4 }}>
          Nothing is targeted: every debt is cleared.
        </div>
      )}
    </div>
  )

  return (
    <div className="page">
      <Header frozen={frozen} monthNow={monthNow} />

      {error && (
        <div className="banner banner--red tiny" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      {/* ---- the hero: what the plan saves ---- */}
      <div className="hero" style={{ marginBottom: 16 }}>
        <div className="hero__label">WHAT THE PLAN SAVES</div>
        <div className="hero__figure" style={{ marginTop: 5 }}>
          {money(frozen.interestSaved)}
        </div>
        <div className="sm hero__note" style={{ marginTop: 5 }}>
          in interest, and{' '}
          <b className="tnum" style={{ color: '#fff' }}>
            {frozen.monthsSaved} months
          </b>{' '}
          of your life
        </div>

        <div className="hero__split">
          <div>
            <div className="tiny hero__note">The plan</div>
            <div className="tnum" style={{ fontSize: 17, fontWeight: 700 }}>
              {moneyCents(frozen.planInterest)}
            </div>
            <div className="tiny hero__note tnum">{frozen.planMonths} months</div>
          </div>
          <div>
            <div className="tiny hero__note">Minimums only</div>
            <div className="tnum hero__note" style={{ fontSize: 17, fontWeight: 700 }}>
              {moneyCents(frozen.minimumsInterest)}
            </div>
            <div className="tiny hero__note tnum">{frozen.minimumsMonths} months</div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div className="tiny hero__note">Saved so far</div>
            <div className="tnum" style={{ fontSize: 17, fontWeight: 700 }}>
              {savedSoFar === null ? '—' : moneyCents(savedSoFar)}
            </div>
            <div className="tiny hero__note">
              {savedSoFar === null
                ? 'interest not readable'
                : elapsedMonths === 0
                  ? `first month closes ${dayMonth(frozen.plan[1]?.projected_on ?? frozen.version.effective_from)}`
                  : `over ${elapsedMonths} completed month${elapsedMonths === 1 ? '' : 's'}`}
            </div>
          </div>
        </div>
      </div>

      {/* ---- the chart ---- */}
      <div className="box" style={{ marginBottom: 15 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: 10,
            gap: 10,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700 }}>Total owed</div>
          {/*
            Every debt account, which is the basis BOTH other quantities in this
            box use: the frozen lines were generated from the whole debt list,
            and the measured line is built from snapshots of the whole debt list.
            usePayoffPlan's totalOwed counts only debts that are not cleared, and
            `cleared` is true whenever cleared_at is set even with a balance
            still on the account, so it would print a figure a few hundred
            dollars under the line drawn directly beneath it.
          */}
          <div className="tiny muted tnum">{money(netWorthNow.debtTotal)} today</div>
        </div>

        <ProgressChart
          plan={frozen.plan}
          originalPlan={original?.plan ?? null}
          minimums={frozen.minimums}
          actual={actualPoints}
          milestones={frozen.milestones}
          format={money}
        />

        {/*
          The freeze, stated on the chart rather than in a commit message. It is
          the one thing about this picture a reader cannot see: two lines that
          look like forecasts are in fact a record of a decision taken on a
          particular day, and that is what makes the third line mean anything.
        */}
        <div className="rule">
          Both projections were fixed on {longDate(frozen.version.effective_from)} from a
          baseline of <span className="tnum">{moneyCents(frozen.version.baseline_debt)}</span>{' '}
          and are never recalculated. The actual line is{' '}
          <span className="tnum">{actualPoints.length}</span>{' '}
          {actualPoints.length === 1 ? 'reading' : 'readings'} so far.
        </div>

        {/*
          A revision, named. Version 1 stays on the chart so the target that was
          originally set is still visible beside the one in force; without this
          the plan would appear to have always been where it now is, which is
          exactly the move the freeze exists to make impossible.

          The reason is the household's own words from the version row, so a
          revision has to be explained at the moment it is made rather than
          reconstructed later.
        */}
        {original && (
          <div className="rule">
            The plan was revised on {longDate(frozen.version.effective_from)}. Version{' '}
            <span className="tnum">{original.version.version}</span> cleared in{' '}
            <span className="tnum">{original.planMonths}</span> months against version{' '}
            <span className="tnum">{frozen.version.version}</span>&apos;s{' '}
            <span className="tnum">{frozen.planMonths}</span>, and is drawn faint behind
            it.
            {frozen.version.reason ? ` ${frozen.version.reason}` : ''}
          </div>
        )}

        {/*
          A run that does not finish, said plainly where the months are claimed.
          Both are drawn from the stored rows rather than from a flag, and both
          are silent in the ordinary case where each run reaches nothing.
        */}
        {minimumsStalled && (
          <div className="rule">
            Paying minimums only does not clear every account within{' '}
            <span className="tnum">{frozen.minimumsMonths}</span> months: at least one
            minimum does not cover its own interest, so that line ends with{' '}
            <span className="tnum">{moneyCents(lastMinimumsRow.projected_debt)}</span> still
            owed rather than at nothing.
          </div>
        )}
        {planStalled && (
          <div className="rule">
            The plan does not clear every account within{' '}
            <span className="tnum">{frozen.planMonths}</span> months either. It ends with{' '}
            <span className="tnum">{moneyCents(lastPlanRow.projected_debt)}</span> still
            owed, so the months above are the length of the stored run, not a date the
            debt goes.
          </div>
        )}

        <Provenance provenance={provenance} startedOn={startedOn} />
      </div>

      {/* ---- three figures that are not the hero ----
          Three across on a desktop. On a phone the mockup pairs net worth and
          savings and shows nothing else, so they go two up; the target card
          keeps its own full-width row underneath rather than being dropped,
          because it names the account the attack fund is pointed at, which the
          clearing order marks by weight rather than by colour. */}
      {wide ? (
        <div className="g3" style={{ marginBottom: 15 }}>
          {netWorthCard}
          {savingsCard}
          {targetCard}
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 10,
              marginBottom: 10,
            }}
          >
            {netWorthCard}
            {savingsCard}
          </div>
          <div style={{ marginBottom: 15 }}>{targetCard}</div>
        </>
      )}

      {/*
        What the projected net worth and savings lines assume, kept from the old
        page because both assumptions are still in the stored figures: the
        generator built projected_net_worth as assets plus other cash plus
        savings less debt, with the first two held flat. Each one is a place
        these two cards could quietly mislead, so each one is named.
      */}
      <div className="rule" style={{ marginTop: -4, marginBottom: 15 }}>
        Vehicle values in the projected line are held at what they were last valued
        at, so a figure years out is optimistic by whatever they depreciate.
        Current-account balances are held flat: they hover around a working balance
        rather than trend, and giving them one would put drift into every figure
        here. The savings line stops at the deposit target, because what happens to
        a deposit after it is saved is not on record.
      </div>

      {/* ---- the clearing order ---- */}
      <div className="box" style={{ marginBottom: 15 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Clearing order</div>
        {/*
          The count and the numbering are two different things, and saying so
          matters: twelve accounts clear across only eight months, so the chart
          carries eight dots, not twelve. Calling the dots "the accounts" would
          leave a reader counting 1 to 8 and wondering where four went.
        */}
        <div className="sm muted" style={{ marginBottom: 10 }}>
          <span className="tnum">{groups.reduce((s, g) => s + g.names.length, 0)}</span>{' '}
          accounts, <span className="tnum">{groups.length}</span> months where something
          clears. Months are counted from {startedOn}.
        </div>

        <ProgressClearingOrder groups={groups} />

        <div className="rule">
          The months are the plan's and do not move. The balances are today's
          readings, so a row whose balance has fallen since{' '}
          {longDate(frozen.version.effective_from)} is ahead of the month beside it.
        </div>
      </div>

      {/* ---- what has actually been charged ---- */}
      <div className="box">
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
          Interest since {startedOn}
        </div>
        <SinceFigures
          wide={wide}
          items={[
            {
              label: 'Interest charged',
              value: observed === null ? '—' : moneyCents(observed),
              note:
                interest === null
                  ? 'Not available: the transaction record could not be read.'
                  : interest.rows > 0
                    ? `${interest.rows} charge${interest.rows === 1 ? '' : 's'} on ${interest.accountsSeen} account${interest.accountsSeen === 1 ? '' : 's'}`
                    : `Nothing yet. The plan started ${startedOn} and no interest has posted since.`,
            },
            {
              label: 'Minimums only would have cost',
              value: moneyCents(minimumsSoFar),
              note:
                elapsedMonths === 0
                  ? 'Nothing yet: no whole month of the plan has passed.'
                  : `Read from the frozen counterfactual at month ${elapsedMonths}.`,
            },
            {
              label: 'Difference so far',
              value: savedSoFar === null ? '—' : moneyCents(savedSoFar),
              good: savedSoFar !== null && savedSoFar > 0,
              note:
                savedSoFar === null
                  ? 'Needs the charged figure above.'
                  : elapsedMonths === 0
                    ? 'Nothing yet: the first whole month of the plan has not finished.'
                    : 'A projected cost measured against an observed one.',
            },
          ]}
        />

        {/*
          The limitation, stated rather than papered over. Interest and finance
          charges appear on only a few of the debt accounts in the whole dataset —
          the rest either do not itemise them in the transaction feed or are not
          connected — so the charged figure is what was OBSERVED, not everything
          that accrued. The projections above do not share this problem: they were
          computed from APRs and balances, not from transactions.
        */}
        {interest && (
          <div className="rule">
            Interest charged counts rows named as interest or a finance charge on debt
            accounts. Across the whole record only{' '}
            <span className="tnum">{interest.accountsEverSeen}</span> of{' '}
            <span className="tnum">{interest.debtAccounts}</span> debt accounts itemise
            those charges at all, so this is interest observed, not all interest accrued.
            Interest earned on savings is excluded; it is money in, and it matches the
            same word.
          </div>
        )}
      </div>
    </div>
  )
}

/** The page title, the month of the plan, and which version is on screen. */
function Header({
  frozen,
  monthNow,
}: {
  frozen: FrozenPlan | null
  monthNow?: number
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 10,
        marginBottom: 14,
      }}
    >
      <div>
        <div className="ph">Progress</div>
        {frozen && (
          <div className="sm muted">
            month <span className="tnum">{monthNow}</span> of{' '}
            <span className="tnum">{frozen.planMonths}</span> · started{' '}
            {longDate(frozen.version.effective_from)}
          </div>
        )}
      </div>
      {frozen && (
        <span
          className="pill tnum"
          style={{ background: 'var(--card)', color: 'var(--steel)', cursor: 'default' }}
        >
          plan v{frozen.version.version}
        </span>
      )}
    </div>
  )
}

/**
 * What the page says when there is nothing frozen to draw.
 *
 * 'error' and 'missing' are kept apart on purpose. A failed read means the plan
 * may well exist and the page is simply blind to it; missing means no version
 * has been generated at all. Collapsing them into one message would have
 * somebody regenerating a plan to fix a network error, which is the one action
 * that destroys the thing being fixed.
 *
 * NEITHER BRANCH DRAWS A CHART. There is no live simulation to fall back to and
 * there must never be one.
 */
function NoPlan({ state }: { state: PlanProjectionsState }) {
  if (state.status === 'error') {
    return (
      <div className="box">
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
          The plan could not be read
        </div>
        <div className="sm muted" style={{ lineHeight: 1.6 }}>
          The stored projections did not load, so there is nothing to chart. The plan
          itself is unaffected: this is a read that failed, not a plan that is missing.
        </div>
        <div className="rule">{state.message}</div>
      </div>
    )
  }

  return (
    <div className="box">
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
        No plan version has been generated
      </div>
      <div className="sm muted" style={{ lineHeight: 1.6 }}>
        Both projection lines are read from stored rows rather than computed here, and
        no version has been written yet. There is no chart, because drawing one would
        mean simulating the plan from today's balances — and a plan simulated from
        today's balances moves whenever a balance moves, which is the one thing this
        page exists to prevent.
      </div>
    </div>
  )
}

/** One "since" figure: the number, and what the number means today. */
interface SinceItem {
  label: string
  value: string
  note: string
  /** Green only where the difference is a saving, which is being on plan. */
  good?: boolean
}

/**
 * The three "since" figures, as a real table on a desktop and as rows on a
 * phone.
 *
 * The same two columns either way, and the amount flush right in both. A
 * two-column table does survive 340px, but only by wrapping the note under the
 * figure it belongs beside, and a number that has drifted away from its label
 * is a number waiting to be read against the wrong one.
 */
function SinceFigures({ items, wide }: { items: SinceItem[]; wide: boolean }) {
  if (!wide) {
    return (
      <div>
        {items.map((it) => (
          <div className="row" key={it.label} style={{ alignItems: 'flex-start' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="sm" style={{ fontWeight: 600, display: 'block' }}>
                {it.label}
              </span>
              <span className="tiny muted" style={{ display: 'block', lineHeight: 1.5 }}>
                {it.note}
              </span>
            </span>
            <span
              className={`tnum sm ${it.good ? 'is-good' : ''}`}
              style={{ textAlign: 'right', fontWeight: it.good ? 700 : 400 }}
            >
              {it.value}
            </span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <table className="tbl">
      <tbody>
        {items.map((it) => (
          <tr key={it.label}>
            <td>
              <div className="sm" style={{ fontWeight: 600 }}>
                {it.label}
              </div>
              <div className="tiny muted" style={{ lineHeight: 1.5 }}>
                {it.note}
              </div>
            </td>
            <td
              className={`num sm ${it.good ? 'is-good' : ''}`}
              style={{ width: 110, verticalAlign: 'top', fontWeight: it.good ? 700 : 400 }}
            >
              {it.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * What the actual line is made of, in figures.
 *
 * Nothing here is rounded up into a claim. Five readings taken over five days is
 * five readings taken over five days, and an account with one number against it
 * has no history at all — saying so is the difference between a chart that
 * reports and a chart that flatters.
 */
function Provenance({
  provenance,
  startedOn,
}: {
  provenance: SnapshotProvenance | null
  startedOn: string
}) {
  if (!provenance || provenance.readings === 0) {
    return (
      <div className="rule">
        No balance readings have been recorded yet, so there is nothing measured to plot.
        The two projected lines are stored rows and are unaffected.
      </div>
    )
  }

  const { readings, days, firstAsOf, lastAsOf, accountsCovered, debtAccounts } = provenance

  return (
    <div className="rule">
      <span className="tnum">{readings}</span> balance readings across{' '}
      <span className="tnum">{accountsCovered}</span> of{' '}
      <span className="tnum">{debtAccounts}</span> debt accounts, taken on{' '}
      <span className="tnum">{days}</span> {days === 1 ? 'day' : 'days'} between{' '}
      <span className="tnum">{firstAsOf ? dayMonth(firstAsOf) : '—'}</span> and{' '}
      <span className="tnum">{lastAsOf ? dayMonth(lastAsOf) : '—'}</span>. The plan
      started {startedOn}.
      {provenance.thinAccounts > 0 && (
        <>
          {' '}
          <span className="tnum">{provenance.thinAccounts}</span> of those accounts have a
          single reading each, <span className="tnum">{money(provenance.thinTotal)}</span>{' '}
          between them — one number, no history.
        </>
      )}
      {provenance.reconstructed > 0 && (
        <>
          {' '}
          A further <span className="tnum">{provenance.reconstructed}</span> readings in the
          record are worked backwards from the transaction feed rather than read from a
          bank. They are left out of this line.
        </>
      )}
    </div>
  )
}

function ProgressSkeleton() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading progress">
      <div className="skeleton" style={{ width: 120, height: 20, marginBottom: 8 }} aria-hidden="true" />
      <div className="skeleton" style={{ width: 230, height: 10, marginBottom: 18 }} aria-hidden="true" />
      <div className="skeleton" style={{ height: 150, marginBottom: 16 }} aria-hidden="true" />
      <div className="skeleton" style={{ height: 250, marginBottom: 16 }} aria-hidden="true" />
      <div className="g3" style={{ marginBottom: 15 }}>
        <div className="skeleton" style={{ height: 96 }} aria-hidden="true" />
        <div className="skeleton" style={{ height: 96 }} aria-hidden="true" />
        <div className="skeleton" style={{ height: 96 }} aria-hidden="true" />
      </div>
      <div className="skeleton" style={{ height: 220 }} aria-hidden="true" />
    </div>
  )
}
