import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  flatLine,
  projectNetWorth,
  projectSavings,
  sharedHorizon,
} from '../lib/progressProjections'
import ProjectionChart, {
  ACTUAL_COLOR,
  type Milestone,
} from '../components/ProjectionChart'
import { useData, useNetWorth, usePayoffPlan } from '../lib/data'
import {
  completedPlanMonths,
  noRollInterestSoFar,
  useProgressData,
  type SnapshotProvenance,
} from '../lib/progressData'
import { accountLabel, money, moneyCents, parseDateOnly, MONTH_NAMES } from '../lib/format'
import { projectedFinishDate, round2 } from '../lib/avalanche'

/**
 * /progress — the plan against the alternative, and against what has actually
 * been measured.
 *
 * The page reports three things and recommends none of them. There is no "you
 * should", no encouragement and no exclamation mark: the gap between $21,153.77
 * and $57,373.37 is an argument that makes itself, and dressing it up would only
 * invite the reader to discount it.
 *
 * The honest shape of this page today is lopsided, and deliberately so. The plan
 * is four days old, so every "so far" figure on it is zero and the measured line
 * is a single dot. The projections carry the page; the observations say how
 * little they are. When the observations grow, they take over on their own.
 */

/** "15 September" — built from parts, so no locale can render it 9/15. */
function dayMonth(iso: string): string {
  const d = parseDateOnly(iso)
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`
}

/** "Nov 2026" — the calendar month a milestone lands in. */
function monthLabel(monthsAhead: number): string {
  return projectedFinishDate(monthsAhead).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  })
}

export default function Progress() {
  const { debts, plan: planSettings, loading, accounts, savingsAccounts } = useData()
  const payoff = usePayoffPlan()
  const netWorthNow = useNetWorth()

  /**
   * The cash side of net worth, defined EXACTLY as useNetWorth() defines it —
   * every checking and savings account, the business's included.
   *
   * Not `checking` from the provider, which is household-only by design for the
   * calendar's cash projection. Using that here would have put −$55,695 on this
   * page against −$52,348 on the home screen: the same quantity, two screens,
   * two answers, differing by the business balance.
   */
  const cashAccounts = useMemo(
    () => accounts.filter((a) => a.kind === 'checking' || a.kind === 'savings'),
    [accounts],
  )

  const {
    loading: extrasLoading,
    error,
    actual,
    actualSavings,
    actualCash,
    provenance,
    interest,
  } = useProgressData(
    debts,
    planSettings?.plan_started_on ?? null,
    cashAccounts,
    savingsAccounts,
  )

  const monthlySavings = planSettings?.monthly_savings ?? 0
  const depositTarget = planSettings?.deposit_target ?? 0

  /**
   * Savings and net worth over the same month index as the debt runs.
   *
   * Built from the SAME sim.balances and noRollSim.balances the debt chart
   * draws, so the three charts cannot disagree about what month it is or about
   * what is owed in it.
   */
  const projections = useMemo(() => {
    if (!payoff) return null
    const months = sharedHorizon(payoff.sim.balances, payoff.noRollSim.balances)

    const savingsNow = savingsAccounts.reduce((sum, a) => sum + a.balance, 0)
    // The rest of the cash, held flat. Taken as the whole cash total less the
    // savings being projected, so month 0 lands on exactly the figure the home
    // screen shows rather than near it.
    const checkingNow = netWorthNow.cashTotal - savingsNow

    const savingsPlan = projectSavings(savingsNow, monthlySavings, depositTarget, months)
    const savingsNothing = flatLine(savingsNow, months)

    return {
      months,
      savingsPlan,
      savingsNothing,
      netWorthPlan: projectNetWorth(
        netWorthNow.assetsTotal,
        checkingNow,
        savingsPlan,
        payoff.sim.balances,
        months,
      ),
      netWorthNothing: projectNetWorth(
        netWorthNow.assetsTotal,
        checkingNow,
        savingsNothing,
        payoff.noRollSim.balances,
        months,
      ),
    }
  }, [
    payoff,
    savingsAccounts,
    monthlySavings,
    depositTarget,
    netWorthNow.assetsTotal,
    netWorthNow.cashTotal,
  ])

  /**
   * The measured lines.
   *
   * Net worth per month is assets plus measured cash less measured debt. Assets
   * carry one valuation each, so they are held at it rather than given a history
   * nobody recorded — the same assumption the projection makes, stated on screen.
   * A month appears only where BOTH the cash and debt sides have full coverage;
   * a net worth built from a complete debt total and half the cash would move for
   * a reason that is not real.
   */
  const actualNetWorth = useMemo(() => {
    const cashBy = new Map(actualCash.map((p) => [p.monthKey, p.total]))
    return actual
      .filter((d) => cashBy.has(d.monthKey))
      .map((d) => ({
        monthIndex: d.monthIndex,
        total: round2(netWorthNow.assetsTotal + (cashBy.get(d.monthKey) as number) - d.total),
      }))
  }, [actual, actualCash, netWorthNow.assetsTotal])

  const savingsPlan = projections?.savingsPlan ?? []
  const savingsNothing = projections?.savingsNothing ?? []
  const netWorthPlan = projections?.netWorthPlan ?? []
  const netWorthNothing = projections?.netWorthNothing ?? []

  const actualSavingsPoints = useMemo(
    () => actualSavings.map((p) => ({ monthIndex: p.monthIndex, total: p.total })),
    [actualSavings],
  )

  /**
   * Clearing events grouped by month, with the account named the way the rest of
   * the app names it — owner first. SimResult carries the bare account name, and
   * two cards in this household share one nickname.
   */
  const milestones = useMemo<Milestone[]>(() => {
    if (!payoff) return []
    const byMonth = new Map<number, string[]>()
    for (const e of payoff.sim.events) {
      const acct = debts.find((d) => d.id === e.id)
      byMonth.set(e.month, [...(byMonth.get(e.month) ?? []), acct ? accountLabel(acct) : e.name])
    }
    return [...byMonth.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([month, names]) => ({ month, names }))
  }, [payoff, debts])

  /** Whole months of the plan that have finished. Zero, on day four. */
  const elapsedMonths = planSettings ? completedPlanMonths(planSettings.plan_started_on) : 0

  /**
   * What the no-roll run would have accrued over those completed months. null
   * means the two computations of that number disagreed and it is not safe to
   * print — see noRollInterestSoFar.
   */
  const noRollSoFar = useMemo(
    () => (payoff ? noRollInterestSoFar(debts, payoff.noRollSim, elapsedMonths) : null),
    [payoff, debts, elapsedMonths],
  )

  if (loading || extrasLoading) return <ProgressSkeleton />

  /**
   * No plan row means no attack fund, no pool and therefore no projection. The
   * measured balances alone would draw one line going nowhere, which is not this
   * page — say what is missing instead of rendering a chart with one series.
   */
  if (!payoff || !planSettings) {
    return (
      <div className="page">
        <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 4 }}>Progress</div>
        <div className="card-panel sm muted" style={{ marginTop: 16, lineHeight: 1.6 }}>
          No plan has been set up yet. The projection needs an attack fund and a start
          date, both of which live in Settings.
        </div>
        <HistoryLink />
      </div>
    )
  }

  const { sim, noRollSim } = payoff
  /**
   * null means the transaction read failed, NOT that nothing was charged. The
   * two have to print differently: a zero here is a statement about the
   * household's accounts, and printing one we did not measure would be the page
   * inventing the most comfortable of the two possible answers.
   */
  const observed = interest === null ? null : interest.total
  const savedSoFar =
    noRollSoFar === null || observed === null ? null : round2(noRollSoFar - observed)
  const projectedSaving = round2(noRollSim.totalInterest - sim.totalInterest)
  const startedOn = dayMonth(planSettings.plan_started_on)

  return (
    <div className="page">
      <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 4 }}>Progress</div>
      <div className="tiny muted" style={{ marginBottom: 14 }}>
        Total owed by month: what has been measured, what the plan projects, and what
        paying every minimum and nothing more would project.
      </div>

      {error && (
        <div className="banner banner--red tiny" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/*
        The chart and its two summary lines on the left, the clearing order on
        the right. ProjectionChart MEASURES this column and matches its viewBox
        to it, so it fills the track at 1:1 rather than drawing at a fixed width
        centred in dead space. 360px is therefore a chosen size, not an
        accommodation: past it, 103 months of x axis buys resolution no one can
        use, and the clearing order beside it wants the room more. Below 1024px
        this is an ordinary div and the chart takes the page width.
      */}
      <div className="sect">Total debt</div>

      <div className="dk-cols dk-cols--chart">
      <div>
      <ProjectionChart
        plan={sim.balances}
        noRoll={noRollSim.balances}
        actual={actual.map((a) => ({ monthIndex: a.monthIndex, total: a.total }))}
        milestones={milestones}
        format={money}
      />

      {/* The two runs in one line each, so the chart does not have to carry them. */}
      <table style={{ marginTop: 14 }}>
        <tbody>
          <tr>
            <td className="sm" style={{ fontWeight: 600 }}>
              The plan
            </td>
            <td className="tnum sm" style={{ textAlign: 'right' }}>
              {sim.months} months · {moneyCents(sim.totalInterest)} interest
            </td>
          </tr>
          <tr>
            <td className="sm muted" style={{ fontWeight: 600 }}>
              Doing nothing
            </td>
            <td className="tnum sm muted" style={{ textAlign: 'right' }}>
              {noRollSim.months} months · {moneyCents(noRollSim.totalInterest)} interest
            </td>
          </tr>
        </tbody>
      </table>
      {noRollSim.stalled && (
        <div className="tiny muted" style={{ marginTop: 6, lineHeight: 1.5 }}>
          Paying minimums only does not clear every account within{' '}
          <span className="tnum">{noRollSim.months}</span> months: at least one minimum
          does not cover its own interest.
        </div>
      )}

      </div>

      <div>
      {/* ---- milestones ---- */}
      <div className="sect">Clearing order</div>
      <div className="tiny muted" style={{ marginBottom: 8, lineHeight: 1.5 }}>
        {/*
          The count and the numbering are two different things, and saying so
          matters: twelve accounts clear across only eight months, so the chart
          carries eight markers, not twelve. Calling the markers "the accounts"
          would leave a reader counting 1 to 8 and wondering where four went.
        */}
        <span className="tnum">{sim.events.length}</span> accounts clear under the plan,
        across <span className="tnum">{milestones.length}</span> months. Each row below is
        one month and carries that month's number on the chart. Months are counted from
        this one.
      </div>
      <table>
        <tbody>
          {milestones.map((ms, i) => (
            <tr key={ms.month}>
              <td style={{ width: 28 }}>
                <span className="dot tnum" style={{ background: 'var(--ink)' }}>
                  {i + 1}
                </span>
              </td>
              <td>
                {ms.names.map((n) => (
                  <div className="sm" key={n} style={{ fontWeight: 600 }}>
                    {n}
                  </div>
                ))}
              </td>
              <td className="tnum tiny muted" style={{ textAlign: 'right', width: 96 }}>
                month {ms.month} · {monthLabel(ms.month)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      </div>
      </div>

      {/* Where the line came from, beside what it cost. Both are prose-and-figures
          panels of similar length, so they pair evenly. */}
      <div className="dk-cols dk-cols--even">
      <div>
      {/* ---- where the measured line comes from ---- */}
      <div className="sect">The measured line</div>
      <Provenance provenance={provenance} startedOn={startedOn} />
      </div>

      <div>
      {/* ---- net worth ---- */}

      {/*
        The figure that goes UP. Debt falling is the same story told from the
        only angle where the best possible outcome is an empty chart; this one
        has somewhere to go. It rises from two directions at once — debt falling
        and savings accumulating — which is why it earns its own axes rather
        than being inferred from the one above.
      */}
      <div className="sect">Net worth</div>
      <div className="sm muted" style={{ marginBottom: 8 }}>
        Everything owned, less everything owed. Negative today, and rising.
      </div>

      <ProjectionChart
        plan={netWorthPlan}
        noRoll={netWorthNothing}
        actual={actualNetWorth}
        milestones={[]}
        format={money}
        title="Net worth"
        planLabel={`under the plan it reaches ${money(netWorthPlan[netWorthPlan.length - 1] ?? 0)}`}
        noRollLabel={`paying minimums only it reaches ${money(netWorthNothing[netWorthNothing.length - 1] ?? 0)}`}
      />

      {/* The assumptions, on the chart rather than in a commit message. Each one
          is a place this could quietly mislead, so each one is named. */}
      <div className="card-panel tiny muted" style={{ marginTop: 10, lineHeight: 1.6 }}>
        Vehicle values are held at what they were last valued at, so a figure
        years out is optimistic by whatever they depreciate. Current-account
        balances are held flat — they hover around a working balance rather than
        trend, and giving them one would put drift into every figure here.
        Savings is projected separately, below.
      </div>

      {/* ---- savings ---- */}

      <div className="sect" style={{ marginTop: 18 }}>
        Savings
      </div>
      <div className="sm muted" style={{ marginBottom: 8 }}>
        {depositTarget > 0
          ? `Deposit of ${money(monthlySavings)} a month toward ${money(depositTarget)}.`
          : `Deposit of ${money(monthlySavings)} a month.`}
      </div>

      <ProjectionChart
        plan={savingsPlan}
        noRoll={savingsNothing}
        actual={actualSavingsPoints}
        milestones={[]}
        format={money}
        title="Savings"
        planLabel={`under the plan it reaches ${money(savingsPlan[savingsPlan.length - 1] ?? 0)}`}
        noRollLabel="without the plan it stays where it is"
      />

      <div className="card-panel tiny muted" style={{ marginTop: 10, lineHeight: 1.6 }}>
        The monthly deposit is part of the plan, so the line that does not follow
        the plan does not make it — it sits where the balance is today.
        {depositTarget > 0 &&
          ' Once the target is reached the line holds there: what happens to a deposit after it is saved is not on record, and either guess would be invented.'}
      </div>

      {/* ---- interest ---- */}
      <div className="sect" style={{ marginTop: 18 }}>
        Interest
      </div>

      <div className="card-panel" style={{ marginBottom: 12 }}>
        <div className="caps" style={{ marginBottom: 10 }}>
          PROJECTED, WHOLE PLAN
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 12 }}>
          <div>
            <div className="tiny muted">The plan</div>
            <div className="tnum" style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em' }}>
              {moneyCents(sim.totalInterest)}
            </div>
          </div>
          <div>
            <div className="tiny muted">Doing nothing</div>
            <div
              className="tnum muted"
              style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em' }}
            >
              {moneyCents(noRollSim.totalInterest)}
            </div>
          </div>
        </div>
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
          <div className="tiny muted">Difference over {sim.months} months</div>
          <div className="tnum" style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.02em' }}>
            {moneyCents(projectedSaving)}
          </div>
        </div>
      </div>

      <div className="caps" style={{ margin: '16px 0 4px' }}>
        SINCE {startedOn.toUpperCase()}
      </div>

      <table>
        <tbody>
          <SoFarRow
            label="Interest charged"
            value={observed === null ? '—' : moneyCents(observed)}
            note={
              interest === null
                ? 'Not available: the transaction record could not be read.'
                : interest.rows > 0
                  ? `${interest.rows} charge${interest.rows === 1 ? '' : 's'} on ${interest.accountsSeen} account${interest.accountsSeen === 1 ? '' : 's'}`
                  : `Nothing yet — the plan started ${startedOn} and no interest has posted since.`
            }
          />
          <SoFarRow
            label="Doing nothing would have cost"
            value={noRollSoFar === null ? '—' : moneyCents(noRollSoFar)}
            note={
              noRollSoFar === null
                ? 'Not available: two computations of this figure disagreed.'
                : elapsedMonths === 0
                  ? 'Nothing yet — no whole month of the plan has passed.'
                  : `Simulated over ${elapsedMonths} completed month${elapsedMonths === 1 ? '' : 's'}.`
            }
          />
          <SoFarRow
            label="Difference so far"
            value={savedSoFar === null ? '—' : moneyCents(savedSoFar)}
            note={
              savedSoFar === null
                ? 'Needs both figures above.'
                : elapsedMonths === 0
                  ? 'Nothing yet — the first whole month of the plan has not finished.'
                  : 'A simulated cost measured against an observed one.'
            }
          />
        </tbody>
      </table>

      {/*
        The limitation, stated rather than papered over. Interest and finance
        charges appear on only a few of the debt accounts in the whole dataset —
        the rest either do not itemise them in the transaction feed or are not
        connected — so the charged figure is what was OBSERVED, not everything
        that accrued. The projections above do not share this problem: they are
        computed from APRs and balances, not from transactions.
      */}
      {interest && (
        <div className="card-panel tiny muted" style={{ marginTop: 12, lineHeight: 1.6 }}>
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

      <HistoryLink />
    </div>
  )
}

/** One "so far" figure: the number, and what the number means today. */
function SoFarRow({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <tr>
      <td>
        <div className="sm" style={{ fontWeight: 600 }}>
          {label}
        </div>
        <div className="tiny muted" style={{ lineHeight: 1.5 }}>
          {note}
        </div>
      </td>
      <td className="tnum sm" style={{ textAlign: 'right', width: 96, verticalAlign: 'top' }}>
        {value}
      </td>
    </tr>
  )
}

/**
 * What the blue line is made of, in figures.
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
      <div className="card-panel tiny muted" style={{ lineHeight: 1.6 }}>
        No balance readings have been recorded yet, so there is nothing measured to plot.
        The two projected lines are computed from today's balances and rates.
      </div>
    )
  }

  const { readings, days, firstAsOf, lastAsOf, accountsCovered, debtAccounts } = provenance

  return (
    <div className="card-panel tiny muted" style={{ lineHeight: 1.6 }}>
      <span className="tnum">{readings}</span> balance readings across{' '}
      <span className="tnum">{accountsCovered}</span> of{' '}
      <span className="tnum">{debtAccounts}</span> debt accounts, taken on{' '}
      <span className="tnum">{days}</span> {days === 1 ? 'day' : 'days'} between{' '}
      <span className="tnum">{firstAsOf ? dayMonth(firstAsOf) : '—'}</span> and{' '}
      <span className="tnum">{lastAsOf ? dayMonth(lastAsOf) : '—'}</span>. The plan started{' '}
      {startedOn}.
      {provenance.thinAccounts > 0 && (
        <>
          {' '}
          <span className="tnum">{provenance.thinAccounts}</span> of those accounts have a
          single reading each,{' '}
          <span className="tnum" style={{ color: ACTUAL_COLOR }}>
            {money(provenance.thinTotal)}
          </span>{' '}
          between them — one number, no history.
        </>
      )}
      {provenance.reconstructed > 0 && (
        <>
          {' '}
          A further <span className="tnum">{provenance.reconstructed}</span> readings in the
          record are worked backwards from the transaction feed rather than read from a
          bank. They are charted on History and left out of this line.
        </>
      )}
    </div>
  )
}

/**
 * History has no entry in the phone's bottom bar — seven glyphs is what fits —
 * so its only ways in are Home and here. This page is its natural home: someone
 * looking at a projection is the person who wants the readings behind it.
 */
function HistoryLink() {
  return (
    <Link
      to="/history"
      className="card-panel"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        marginTop: 22,
        color: 'inherit',
        textDecoration: 'none',
      }}
    >
      <span className="dot" style={{ background: 'var(--ink)' }} aria-hidden="true">
        ◪
      </span>
      <span style={{ flex: 1 }}>
        <span className="sm" style={{ fontWeight: 600, display: 'block' }}>
          History
        </span>
        <span className="tiny muted">Every balance reading, week by week.</span>
      </span>
      <span className="muted" aria-hidden="true">
        ›
      </span>
    </Link>
  )
}

function ProgressSkeleton() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading progress">
      <div className="skeleton" style={{ width: 110, height: 20, marginBottom: 8 }} aria-hidden="true" />
      <div className="skeleton" style={{ width: 230, height: 10, marginBottom: 20 }} aria-hidden="true" />
      {/* The same two columns the loaded page uses, so the chart does not draw
          across the full width and then shrink into its own column. */}
      <div className="dk-cols dk-cols--chart">
        <div>
          <div className="skeleton" style={{ height: 210, marginBottom: 12 }} aria-hidden="true" />
          <div className="skeleton" style={{ width: 200, height: 10 }} aria-hidden="true" />
        </div>
        <div>
          <div className="skeleton" style={{ width: 90, height: 12, marginBottom: 12 }} aria-hidden="true" />
          <div className="skeleton" style={{ height: 180 }} aria-hidden="true" />
        </div>
      </div>
      <div className="dk-cols dk-cols--even" style={{ marginTop: 24 }}>
        <div className="skeleton" style={{ height: 120 }} aria-hidden="true" />
        <div className="skeleton" style={{ height: 150 }} aria-hidden="true" />
      </div>
    </div>
  )
}
