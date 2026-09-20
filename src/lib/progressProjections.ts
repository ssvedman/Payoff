/**
 * What the plan does to the things the debt chart cannot show on its own.
 *
 * Total debt falling is only one side of the story, and on its own it is the
 * least encouraging side: it starts large and ends at nothing, so the best it
 * can ever look is empty. Savings and net worth are the figures that go UP, and
 * net worth is the only one that answers "are we actually further ahead".
 *
 * Pure: arrays in, arrays out, no clock and no I/O. Every projection here runs
 * over the same month index as SimResult.balances, so month n on one chart is
 * month n on all of them.
 *
 * What is ASSUMED is listed here rather than buried, because each assumption is
 * a place this could quietly mislead:
 *
 *   Cash is held flat. Current accounts hover around a working balance rather
 *   than trending, and inventing a trend for them would put drift into every
 *   net worth figure. Savings is the account that is supposed to grow, and it
 *   is projected separately.
 *
 *   Assets are held flat. Vehicles depreciate, and four of the five figures on
 *   the balance sheet are vehicles — so net worth in two years is optimistic by
 *   whatever they lose. Modelling that needs a depreciation curve nobody here
 *   has, and a made-up curve would be worse than a stated assumption. The page
 *   says so on the chart.
 *
 *   "Doing nothing" saves nothing. The monthly deposit is part of the plan, so
 *   the counterfactual that does not follow the plan does not make it.
 */

import { round2 } from './avalanche'

/** Balance at month n. Past the end of a run the debt is gone, not missing. */
export const at = (values: number[], n: number): number =>
  n < values.length ? values[n] : 0

/**
 * Savings month by month.
 *
 * Grows by the monthly deposit until it reaches the stated target, then holds.
 * Holding is the least-invented option: what happens to a deposit once it is
 * saved — spent on the thing it was for, or kept — is a decision nobody has
 * recorded, and either guess would be fiction. `target` of 0 or less means no
 * target, and it simply keeps growing.
 */
export function projectSavings(
  opening: number,
  monthly: number,
  target: number,
  months: number,
): number[] {
  const out: number[] = [round2(opening)]
  let balance = opening
  for (let m = 1; m <= months; m++) {
    balance = balance + monthly
    if (target > 0 && balance > target) balance = target
    out.push(round2(balance))
  }
  return out
}

/** No deliberate saving: the balance simply sits where it is. */
export function flatLine(value: number, months: number): number[] {
  return Array.from({ length: months + 1 }, () => round2(value))
}

/**
 * Net worth month by month: what is owned less what is owed.
 *
 * Negative today and rising. The rise comes from two places at once — debt
 * falling and savings accumulating — which is exactly why it is worth drawing
 * separately from either.
 */
export function projectNetWorth(
  assets: number,
  cash: number,
  savings: number[],
  debt: number[],
  months: number,
): number[] {
  const out: number[] = []
  for (let m = 0; m <= months; m++) {
    out.push(round2(assets + cash + at(savings, m) - at(debt, m)))
  }
  return out
}

/**
 * The month index both projections share.
 *
 * The longer of the two runs, so the charts keep a common x-axis: a plan that
 * finishes at month 29 and a do-nothing that runs to 103 must not both stretch
 * to the right-hand edge, or they would appear to take the same time.
 */
export function sharedHorizon(plan: number[], noRoll: number[]): number {
  return Math.max(plan.length, noRoll.length) - 1
}
