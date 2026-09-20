/**
 * Reading the frozen plan.
 *
 * The Progress chart used to simulate both projection lines from CURRENT
 * balances on every render, so "the plan" moved whenever a balance moved. A
 * target that shifts to meet you cannot be missed.
 *
 * Both lines are now generated once (scripts/generate-plan-version.mjs), stored
 * in plan_projections, and read from here. Only the actual line changes.
 *
 * THERE IS NO FALLBACK, AND ADDING ONE WOULD UNDO THE POINT OF THE TABLE.
 * When no version has been generated, this returns status 'missing' and the
 * page says so. It does not quietly run the avalanche instead — a silent
 * fallback is how the frozen line unfreezes, and it would be invisible: the
 * chart would look right, and be wrong only in the way that matters.
 *
 * `simulate()` is still exported from avalanche.ts because the generator needs
 * it. It is no longer reachable from any page, which is deliberate: the freeze
 * is structural, not a rule anyone has to remember.
 */

import { useMemo } from 'react'
import { useData } from './data'
import { round2 } from './avalanche'

export type Scenario = 'plan' | 'minimums_only'

export interface PlanVersion {
  id: string
  version: number
  effective_from: string
  attack_fund: number
  monthly_savings: number
  deposit_target: number
  baseline_debt: number
  reason: string | null
  is_current: boolean
  created_at: string
}

export interface PlanProjection {
  plan_version_id: string
  scenario: Scenario
  /** 0 is the starting state; n is n calendar months after effective_from. */
  month_index: number
  projected_on: string
  projected_debt: number
  cumulative_interest: number
  projected_savings: number
  projected_net_worth: number | null
  /** Names of the accounts that cleared in this month, or null if none did. */
  accounts_cleared: string[] | null
}

/** One month where at least one account cleared — the chart's milestone dots. */
export interface Milestone {
  month_index: number
  projected_on: string
  names: string[]
}

export interface FrozenPlan {
  version: PlanVersion
  /** Month 0 through the month the last debt clears. */
  plan: PlanProjection[]
  /** Month 0 through the month the last debt clears paying minimums only. */
  minimums: PlanProjection[]
  milestones: Milestone[]
  /** Months the plan takes. */
  planMonths: number
  /** Months doing nothing takes. */
  minimumsMonths: number
  planInterest: number
  minimumsInterest: number
  /** What the plan saves, in interest — the Progress hero. */
  interestSaved: number
  /** And in months. */
  monthsSaved: number
  /** The month the last debt clears, as YYYY-MM-DD. */
  debtFreeOn: string
}

export type PlanProjectionsState =
  | { status: 'loading' }
  /** The read failed. Distinct from 'missing': the plan may well exist. */
  | { status: 'error'; message: string }
  /** No version has been generated. The page says so; it does not simulate. */
  | { status: 'missing' }
  | {
      status: 'ready'
      /** The version in force now. */
      frozen: FrozenPlan
      /**
       * The FIRST version, when the current one is not it.
       *
       * This is what makes a revision read as a decision that was taken rather
       * than as the target having always been where you are. Null until a
       * second version exists, which is also why it has to be built before the
       * first revision and not after: the moment it is needed is the moment it
       * would otherwise be discovered missing.
       */
      original: FrozenPlan | null
    }

const byMonth = (a: PlanProjection, b: PlanProjection) => a.month_index - b.month_index

/**
 * Assemble one version's stored rows.
 *
 * Rows are scoped by plan_version_id, not merely by scenario. Every version's
 * projections live in one table, so filtering on scenario alone would splice
 * version 1's months together with version 2's the moment a second version
 * existed, and produce a line that belongs to neither. It would look like a
 * plan, which is what makes it dangerous.
 */
function assemble(version: PlanVersion, rows: PlanProjection[]): FrozenPlan | null {
  const mine = rows.filter((p) => p.plan_version_id === version.id)
  const plan = mine.filter((p) => p.scenario === 'plan').sort(byMonth)
  const minimums = mine.filter((p) => p.scenario === 'minimums_only').sort(byMonth)

  // A version row with no projection rows is a half-written version, not a
  // plan. Treat it as absent rather than drawing a chart with one point.
  if (plan.length === 0 || minimums.length === 0) return null

  const lastPlan = plan[plan.length - 1]
  const lastMinimums = minimums[minimums.length - 1]

  const milestones: Milestone[] = plan
    .filter((p) => p.accounts_cleared && p.accounts_cleared.length > 0)
    .map((p) => ({
      month_index: p.month_index,
      projected_on: p.projected_on,
      names: p.accounts_cleared as string[],
    }))

  return {
    version,
    plan,
    minimums,
    milestones,
    planMonths: lastPlan.month_index,
    minimumsMonths: lastMinimums.month_index,
    planInterest: lastPlan.cumulative_interest,
    minimumsInterest: lastMinimums.cumulative_interest,
    interestSaved: round2(lastMinimums.cumulative_interest - lastPlan.cumulative_interest),
    monthsSaved: lastMinimums.month_index - lastPlan.month_index,
    debtFreeOn: lastPlan.projected_on,
  }
}

/**
 * The current plan version and its stored projections, plus the original when
 * the plan has been revised.
 *
 * Every figure here is read from the table. Nothing is recomputed from
 * balances, so these numbers are the same today as the day the version was
 * generated, which is the only way the actual line can be compared against
 * anything.
 */
export function useFrozenPlan(): PlanProjectionsState {
  const { loading, planVersions, planProjections, planProjectionsError } = useData()

  return useMemo<PlanProjectionsState>(() => {
    if (planProjectionsError) return { status: 'error', message: planProjectionsError }
    if (loading) return { status: 'loading' }

    const current = planVersions.find((v) => v.is_current) ?? null
    if (!current) return { status: 'missing' }

    const frozen = assemble(current, planProjections)
    if (!frozen) return { status: 'missing' }

    // The first version ever generated, and only when it is not the one in
    // force. Chosen by lowest version number rather than by date, because the
    // number is what the app calls it everywhere else.
    const first = [...planVersions].sort((a, b) => a.version - b.version)[0] ?? null
    const original =
      first && first.id !== current.id ? assemble(first, planProjections) : null

    return { status: 'ready', frozen, original }
  }, [loading, planVersions, planProjections, planProjectionsError])
}

/**
 * Which month of the plan today is, 1-based: the month the plan started is
 * month 1. Counts calendar months elapsed, not 30-day blocks.
 *
 * Measured from the VERSION's effective_from rather than plan_settings, so the
 * month number and the projection it indexes into cannot come from two
 * different start dates.
 */
export function planMonthNumber(effectiveFrom: string, today = new Date()): number {
  const [y, m] = effectiveFrom.split('-').map(Number)
  const elapsed = (today.getFullYear() - y) * 12 + (today.getMonth() - (m - 1))
  return Math.max(1, elapsed + 1)
}

/** The projection row for a given month, or the last one once the plan ends. */
export function rowAt(rows: PlanProjection[], monthIndex: number): PlanProjection | null {
  if (rows.length === 0) return null
  return rows.find((r) => r.month_index === monthIndex) ?? rows[rows.length - 1]
}
