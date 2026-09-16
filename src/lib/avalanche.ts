/**
 * Debt avalanche simulation — BUILD.md §7 "Projected finish".
 *
 * Every spare dollar goes to the highest-rate open account regardless of whose
 * name is on it. When one clears, its payment rolls into the next: the total
 * monthly outlay stays constant, so a cleared account's minimum is automatically
 * freed and lands on the new target.
 *
 * Runs client-side from current balances. Pure functions, no I/O.
 */

export interface SimDebt {
  id: string
  name: string
  /** Annual percentage rate. null (tax, savings) is treated as 0% — the IRS plan accrues nothing here. */
  apr: number | null
  minimumPayment: number
  payoffOrder: number
  balance: number
}

export interface PayoffEvent {
  id: string
  name: string
  /** 1-based month index within the simulation at which the balance reached zero. */
  month: number
}

export interface SimResult {
  /** Months to clear every debt. 0 when nothing is owed. */
  months: number
  /** Total interest accrued across the run. */
  totalInterest: number
  /** When each account clears, in the order they clear. */
  events: PayoffEvent[]
  /** True when the plan does not converge — the pool cannot outpace interest. */
  stalled: boolean
}

/** Guard against a non-converging plan producing an infinite loop. */
const MAX_MONTHS = 600

export const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * The fixed monthly outlay: every open debt's minimum plus the attack fund.
 * Held constant across the run so cleared minimums roll forward.
 */
export function monthlyPool(debts: SimDebt[], attackFund: number): number {
  return round2(debts.reduce((sum, d) => sum + d.minimumPayment, 0) + attackFund)
}

/** Ascending payoff_order — 1 is attacked first. */
export function inAvalancheOrder<T extends { payoffOrder: number }>(debts: T[]): T[] {
  return [...debts].sort((a, b) => a.payoffOrder - b.payoffOrder)
}

/**
 * The account currently being attacked: lowest payoff_order with a balance
 * still owing. Returns null once everything is clear.
 */
export function currentTarget<T extends { payoffOrder: number; balance: number }>(
  debts: T[],
): T | null {
  return inAvalancheOrder(debts).find((d) => d.balance > 0) ?? null
}

/**
 * Run the avalanche to completion.
 *
 * Each month: accrue interest, pay every open debt its minimum, then throw
 * everything left at the target in payoff order — overflow cascades to the next
 * account in the same month rather than being wasted.
 */
export function simulate(debts: SimDebt[], attackFund: number): SimResult {
  const pool = monthlyPool(debts, attackFund)

  // Work on copies; never mutate the caller's rows.
  let open = inAvalancheOrder(debts)
    .filter((d) => d.balance > 0)
    .map((d) => ({ ...d }))

  if (open.length === 0) {
    return { months: 0, totalInterest: 0, events: [], stalled: false }
  }

  const events: PayoffEvent[] = []
  let totalInterest = 0
  let month = 0

  while (open.length > 0 && month < MAX_MONTHS) {
    month++

    // 1. Interest accrues on the outstanding balance.
    for (const d of open) {
      const rate = (d.apr ?? 0) / 100 / 12
      const interest = round2(d.balance * rate)
      d.balance = round2(d.balance + interest)
      totalInterest = round2(totalInterest + interest)
    }

    let remaining = pool

    // 2. Minimums first, on every open debt.
    for (const d of open) {
      if (remaining <= 0) break
      const pay = Math.min(d.minimumPayment, d.balance, remaining)
      d.balance = round2(d.balance - pay)
      remaining = round2(remaining - pay)
    }

    // 3. Everything left goes at the target, cascading through payoff order.
    for (const d of open) {
      if (remaining <= 0) break
      const pay = Math.min(d.balance, remaining)
      d.balance = round2(d.balance - pay)
      remaining = round2(remaining - pay)
    }

    // 4. Record and retire anything that cleared.
    const cleared = open.filter((d) => d.balance <= 0)
    for (const d of cleared) events.push({ id: d.id, name: d.name, month })
    open = open.filter((d) => d.balance > 0)
  }

  return {
    months: month,
    totalInterest: round2(totalInterest),
    events,
    stalled: open.length > 0,
  }
}

/**
 * Month N of the plan, 1-based: the month the plan started is month 1.
 * Counts calendar months elapsed, not 30-day blocks.
 */
export function monthNumber(planStartedOn: string, today = new Date()): number {
  const [y, m] = planStartedOn.split('-').map(Number)
  const elapsed = (today.getFullYear() - y) * 12 + (today.getMonth() - (m - 1))
  return Math.max(1, elapsed + 1)
}

/**
 * Total months in the plan: months already elapsed plus months still projected.
 * Month 3 of 27 means 2 gone and 25 to run.
 */
export function totalPlanMonths(
  planStartedOn: string,
  projectedRemaining: number,
  today = new Date(),
): number {
  return monthNumber(planStartedOn, today) - 1 + projectedRemaining
}

/** Calendar month in which the last debt clears. */
export function projectedFinishDate(monthsRemaining: number, today = new Date()): Date {
  return new Date(today.getFullYear(), today.getMonth() + monthsRemaining, 1)
}
