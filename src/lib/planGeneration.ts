/**
 * Building a plan version — the rows that get frozen.
 *
 * This is the ONLY place a stored projection is computed. It is pure: state in,
 * rows out, no clock and no I/O, so the one-shot that generated version 1 and
 * whatever generates version 2 cannot drift apart into two slightly different
 * plans that both claim to be the plan.
 *
 * It is deliberately NOT wired into the app's render path. The Progress page
 * reads `plan_projections`; nothing on a page may call this. A generator that
 * anything can reach on load is how the frozen line quietly unfreezes.
 *
 * What is assumed is stated in progressProjections.ts and holds here unchanged:
 * cash and assets are held flat, and the do-nothing counterfactual makes no
 * savings deposit because the deposit is part of the plan it is not following.
 */

import {
  round2,
  simulate,
  simulateMinimumsOnly,
  type SimDebt,
  type SimResult,
} from './avalanche'
import { projectSavings, flatLine, at } from './progressProjections'

export type Scenario = 'plan' | 'minimums_only'

/** The state a plan version is generated FROM. Every figure is as at `effectiveFrom`. */
export interface PlanInput {
  /** The date the plan starts. Month 0 is this state; month n is n months later. */
  effectiveFrom: string
  attackFund: number
  monthlySavings: number
  depositTarget: number
  /** The savings balance being grown. Projected, not held flat. */
  openingSavings: number
  /**
   * Every other cash balance, held flat — the full cash total LESS
   * `openingSavings`, so month 0 lands on the same net worth the pages show
   * rather than double-counting the savings account.
   */
  otherCash: number
  assets: number
  /**
   * Every debt, cleared ones included at a zero balance. simulate() derives its
   * constant monthly pool from the minimums of whatever it is given, so
   * dropping cleared accounts would shrink the pool by their minimums and make
   * the projection longer the more had been paid off.
   */
  debts: SimDebt[]
}

export interface ProjectionRow {
  scenario: Scenario
  month_index: number
  projected_on: string
  projected_debt: number
  cumulative_interest: number
  projected_savings: number
  projected_net_worth: number
  accounts_cleared: string[] | null
}

export interface GeneratedPlan {
  version: {
    effective_from: string
    attack_fund: number
    monthly_savings: number
    deposit_target: number
    baseline_debt: number
  }
  rows: ProjectionRow[]
  /** Everything the Progress hero states, computed once here. */
  summary: {
    planMonths: number
    planInterest: number
    minimumsMonths: number
    minimumsInterest: number
    /** What the plan saves: the gap in interest. */
    interestSaved: number
    /** And the gap in months. */
    monthsSaved: number
    planStalled: boolean
    minimumsStalled: boolean
  }
}

/**
 * `date` shifted by n calendar months, as YYYY-MM-DD.
 *
 * Day-of-month is pinned to the plan's start day and clamped to the length of
 * the target month, so a plan starting on the 31st does not skip February.
 * Built from the parts rather than a Date so it cannot pick up a timezone: this
 * string is written to a `date` column and read back as a label.
 */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const target = new Date(Date.UTC(y, m - 1 + n, 1))
  const year = target.getUTCFullYear()
  const month = target.getUTCMonth()
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const day = Math.min(d, lastDay)
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Account names that cleared in each month, keyed by 1-based month index. */
function clearedByMonth(sim: SimResult): Map<number, string[]> {
  const out = new Map<number, string[]>()
  for (const e of sim.events) {
    const names = out.get(e.month) ?? []
    names.push(e.name)
    out.set(e.month, names)
  }
  return out
}

/**
 * One scenario's rows, month 0 (the starting state) through the month it ends.
 *
 * Each scenario runs to its OWN length rather than a shared horizon. The plan
 * finishes long before minimums-only does, and padding it with flat zeroes to
 * match would store months the plan does not have.
 */
function rowsFor(
  scenario: Scenario,
  sim: SimResult,
  savings: number[],
  input: PlanInput,
): ProjectionRow[] {
  const cleared = clearedByMonth(sim)
  const rows: ProjectionRow[] = []

  for (let m = 0; m <= sim.months; m++) {
    const debt = at(sim.balances, m)
    const saved = at(savings, m)
    const names = cleared.get(m) ?? null

    rows.push({
      scenario,
      month_index: m,
      projected_on: addMonths(input.effectiveFrom, m),
      projected_debt: debt,
      cumulative_interest: at(sim.cumulativeInterest, m),
      projected_savings: saved,
      projected_net_worth: round2(input.assets + input.otherCash + saved - debt),
      accounts_cleared: names && names.length > 0 ? names : null,
    })
  }

  return rows
}

/**
 * Run the avalanche once and return everything a plan version stores.
 *
 * Call this exactly once per version. Calling it again with a later state
 * produces a DIFFERENT plan — which is a revision, and belongs in a new version
 * row, not on top of an existing one.
 */
export function generatePlan(input: PlanInput): GeneratedPlan {
  const plan = simulate(input.debts, input.attackFund)
  const minimums = simulateMinimumsOnly(input.debts)

  // The plan makes the monthly deposit; the counterfactual does not, because
  // the deposit is part of the plan it is not following.
  const planSavings = projectSavings(
    input.openingSavings,
    input.monthlySavings,
    input.depositTarget,
    plan.months,
  )
  const minimumsSavings = flatLine(input.openingSavings, minimums.months)

  return {
    version: {
      effective_from: input.effectiveFrom,
      attack_fund: input.attackFund,
      monthly_savings: input.monthlySavings,
      deposit_target: input.depositTarget,
      baseline_debt: plan.balances[0],
    },
    rows: [
      ...rowsFor('plan', plan, planSavings, input),
      ...rowsFor('minimums_only', minimums, minimumsSavings, input),
    ],
    summary: {
      planMonths: plan.months,
      planInterest: plan.totalInterest,
      minimumsMonths: minimums.months,
      minimumsInterest: minimums.totalInterest,
      interestSaved: round2(minimums.totalInterest - plan.totalInterest),
      monthsSaved: minimums.months - plan.months,
      planStalled: plan.stalled,
      minimumsStalled: minimums.stalled,
    },
  }
}
