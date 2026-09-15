import { useMemo } from 'react'
import Bar from '../components/Bar'
import { useData, useMonthTotals } from '../lib/data'
import { money, MONTH_NAMES } from '../lib/format'

/**
 * /month — bucket progress for the current calendar month, the optional bucket
 * broken down by budget line, and a factual comparison against the plan.
 *
 * Everything here is driven by this month's transactions. The seeded database has
 * none yet, so every figure legitimately reads $0 — the page states that plainly
 * rather than implying anything went wrong.
 *
 * Color rules (BUILD.md §8): amber is the current target and appears nowhere on
 * this screen. Green is on plan, red is a deviation from plan, steel is everything
 * else. A figure that is merely incomplete part-way through the month is steel,
 * not red — nothing has deviated yet.
 */

const CATCH_ALL = 'everything else'

/**
 * The day after which the attack payment being absent counts as a deviation
 * rather than as a month still in progress — BUILD.md §6, `attack_missing`.
 */
const ATTACK_DUE_DAY = 15

/** Whole-dollar difference, never negative. */
const gap = (a: number, b: number) => Math.max(0, a - b)

export default function Month() {
  const { loading, error, transactions, budgetLines, plan } = useData()
  const totals = useMonthTotals()

  const today = new Date()
  const day = today.getDate()
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  const daysLeft = daysInMonth - day
  // daysInMonth is 28–31, so this never divides by zero and is always > 0.
  const elapsed = day / daysInMonth

  const attackTarget = plan?.attack_fund ?? 0
  const savingsTarget = plan?.monthly_savings ?? 0

  const optionalSpent = totals.bucketSpent('optional')
  const optionalTarget = totals.bucketTarget('optional')
  const fixedSpent = totals.bucketSpent('fixed')
  const fixedTarget = totals.bucketTarget('fixed')
  const attackSpent = totals.bucketSpent('attack')
  const savingsSpent = totals.bucketSpent('savings')

  const spentTotal = fixedSpent + optionalSpent + attackSpent + savingsSpent
  const income = totals.income

  /**
   * Per-line optional spend, read from each transaction's budget_line_id — set by
   * the categoriser from the Plaid category, or pinned by a merchant rule when
   * someone corrects one in /activity. Optional spend with no line yet collects in
   * the catch-all, so the lines always sum to the bucket.
   */
  const optionalLines = useMemo(() => {
    const lines = budgetLines.filter((l) => l.bucket === 'optional')
    const spent = new Map<string, number>(lines.map((l) => [l.id, 0]))
    const catchAll = lines.find((l) => l.line_name.trim().toLowerCase() === CATCH_ALL)

    for (const t of transactions) {
      if (t.bucket !== 'optional') continue
      // A transaction now carries its line explicitly. Anything not yet assigned
      // — a merchant no rule covers — collects in the catch-all rather than being
      // dropped, so the lines always sum to the bucket.
      // An id that is not an OPTIONAL line — a row filed against a fixed line and
      // later re-bucketed, say — must still land somewhere, or the rows below sum
      // to less than the bar above them and the comment's promise is broken.
      const lineId =
        t.budget_line_id && spent.has(t.budget_line_id) ? t.budget_line_id : catchAll?.id
      if (!lineId) continue
      spent.set(lineId, (spent.get(lineId) ?? 0) + t.amount)
    }

    return lines.map((l) => ({ ...l, spent: spent.get(l.id) ?? 0 }))
  }, [budgetLines, transactions])

  // First load only — see the note on Home. A background refetch must not replace
  // figures already on screen with placeholders.
  if (loading && budgetLines.length === 0) {
    return (
      <div className="page" aria-busy="true" aria-label="Loading this month">
        <div
          className="skeleton"
          style={{ width: 132, height: 20, marginBottom: 10 }}
          aria-hidden="true"
        />
        <div
          className="skeleton"
          style={{ width: 168, height: 12, marginBottom: 24 }}
          aria-hidden="true"
        />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ marginBottom: 17 }} aria-hidden="true">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: 7,
              }}
            >
              <div className="skeleton" style={{ width: 84, height: 12 }} />
              <div className="skeleton" style={{ width: 96, height: 12 }} />
            </div>
            <div className="skeleton" style={{ height: 7, borderRadius: 4 }} />
          </div>
        ))}
        <div
          className="skeleton"
          style={{ width: 120, height: 12, margin: '26px 0 14px' }}
          aria-hidden="true"
        />
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="skeleton"
            style={{ height: 12, marginBottom: 18, width: `${92 - i * 6}%` }}
            aria-hidden="true"
          />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="page">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 20 }}>{MONTH_NAMES[today.getMonth()]}</span>
          <span className="tnum tiny muted">
            day {day} of {daysInMonth}
          </span>
        </div>
        <div className="sm muted">This month could not be loaded. {error}</div>
      </div>
    )
  }

  // Optional is judged against pace, so an on-track month reads neutral all the way.
  // BUILD.md §7 defines the deviation as the optional bucket running over target pace.
  const pace = optionalTarget * elapsed
  const overTarget = optionalSpent > optionalTarget
  const offPace = optionalSpent > pace
  const optionalColor = offPace ? 'var(--red)' : 'var(--steel)'

  const attackMet = attackTarget > 0 && attackSpent >= attackTarget
  const savingsMet = savingsTarget > 0 && savingsSpent >= savingsTarget

  // Projected month-end optional spend at the current rate. elapsed is always > 0.
  const projectedOptional = optionalSpent / elapsed

  // The planned monthly outlay income has to cover.
  const plannedOutlay = fixedTarget + optionalTarget + attackTarget + savingsTarget
  const hasTransactions = transactions.length > 0
  const monthComplete = daysLeft === 0

  /**
   * The right-hand note on a plan row. Green when the figure meets the plan, red
   * when falling short is a deviation at this point in the month, steel while the
   * month still has time to run.
   */
  const verdict = (met: boolean, shortText: string, isDeviation: boolean) => {
    if (!hasTransactions) return <span className="tnum tiny muted">nothing recorded</span>
    if (met) {
      return (
        <span className="tnum tiny" style={{ color: 'var(--green)' }}>
          on plan
        </span>
      )
    }
    return (
      <span
        className={isDeviation ? 'tnum tiny' : 'tnum tiny muted'}
        style={isDeviation ? { color: 'var(--red)' } : undefined}
      >
        {shortText}
      </span>
    )
  }

  const cell = { border: 'none', padding: '4px 0' } as const
  const cellRight = { ...cell, textAlign: 'right' as const }

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 20 }}>{MONTH_NAMES[today.getMonth()]}</span>
        <span className="tnum tiny muted">
          day {day} of {daysInMonth}
        </span>
      </div>

      <div className="tnum sm muted" style={{ marginBottom: 20 }}>
        {income > 0 ? `${money(spentTotal)} spent of ${money(income)} in` : `${money(spentTotal)} spent`}
      </div>

      {/* Optional */}
      <div style={{ marginBottom: 17 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 5 }}>
          <span style={{ fontWeight: 600 }}>Optional</span>
          <span
            className={offPace ? 'tnum' : 'tnum muted'}
            style={offPace ? { color: 'var(--red)', fontWeight: 700 } : undefined}
          >
            {money(optionalSpent)} / {money(optionalTarget)}
          </span>
        </div>
        <Bar pct={optionalTarget > 0 ? optionalSpent / optionalTarget : 0} color={optionalColor} />
        <div className="tnum tiny muted" style={{ marginTop: 4 }}>
          {overTarget
            ? `${money(optionalSpent - optionalTarget)} over, ${daysLeft} days remaining`
            : `${money(optionalTarget - optionalSpent)} left, ${daysLeft} days remaining`}
        </div>
      </div>

      {/* Fixed */}
      <div style={{ marginBottom: 17 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 5 }}>
          <span style={{ fontWeight: 600 }}>Fixed</span>
          <span className="tnum muted">
            {money(fixedSpent)} / {money(fixedTarget)}
          </span>
        </div>
        <Bar pct={fixedTarget > 0 ? fixedSpent / fixedTarget : 0} color="var(--steel)" />
      </div>

      {/* Attack fund */}
      <div style={{ marginBottom: 17 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 5 }}>
          <span style={{ fontWeight: 600 }}>Attack fund</span>
          <span
            className={attackMet ? 'tnum' : 'tnum muted'}
            style={attackMet ? { color: 'var(--green)', fontWeight: 700 } : undefined}
          >
            {money(attackSpent)} sent
          </span>
        </div>
        <Bar
          pct={attackTarget > 0 ? attackSpent / attackTarget : 0}
          color={attackMet ? 'var(--green)' : 'var(--steel)'}
        />
        {hasTransactions && !attackMet && attackTarget > 0 && (
          <div className="tnum tiny muted" style={{ marginTop: 4 }}>
            {money(gap(attackTarget, attackSpent))} short of {money(attackTarget)}
          </div>
        )}
      </div>

      {/* Savings */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 5 }}>
          <span style={{ fontWeight: 600 }}>Savings</span>
          <span
            className={savingsMet ? 'tnum' : 'tnum muted'}
            style={savingsMet ? { color: 'var(--green)', fontWeight: 700 } : undefined}
          >
            {money(savingsSpent)} sent
          </span>
        </div>
        <Bar
          pct={savingsTarget > 0 ? savingsSpent / savingsTarget : 0}
          color={savingsMet ? 'var(--green)' : 'var(--steel)'}
        />
        {hasTransactions && !savingsMet && savingsTarget > 0 && (
          <div className="tnum tiny muted" style={{ marginTop: 4 }}>
            {money(gap(savingsTarget, savingsSpent))} short of {money(savingsTarget)}
          </div>
        )}
      </div>

      <div className="sect">Optional, by line</div>
      {optionalLines.length === 0 ? (
        <div className="sm muted">No optional budget lines.</div>
      ) : (
        <table>
          <tbody>
            {optionalLines.map((l) => (
              <tr key={l.id}>
                <td className="sm">{l.line_name}</td>
                <td className="tnum sm" style={{ textAlign: 'right' }}>
                  {money(l.spent)}
                </td>
                <td className="tnum tiny muted" style={{ textAlign: 'right', width: 54 }}>
                  of {money(l.monthly_target)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!hasTransactions && (
        <div className="tiny muted" style={{ marginTop: 8 }}>
          No transactions recorded this month.
        </div>
      )}

      <div className="sect">Compared with the plan</div>
      <div className="card-panel">
        <table style={{ margin: 0 }}>
          <tbody>
            <tr>
              <td className="sm" style={cell}>
                Income
              </td>
              <td className="tnum sm" style={cellRight}>
                {money(income)}
              </td>
              <td style={cellRight}>
                {verdict(
                  income >= plannedOutlay,
                  `${money(gap(plannedOutlay, income))} short`,
                  monthComplete,
                )}
              </td>
            </tr>
            <tr>
              <td className="sm" style={cell}>
                Attack fund
              </td>
              <td className="tnum sm" style={cellRight}>
                {money(attackSpent)}
              </td>
              <td style={cellRight}>
                {verdict(
                  attackSpent >= attackTarget,
                  `${money(gap(attackTarget, attackSpent))} short`,
                  day > ATTACK_DUE_DAY,
                )}
              </td>
            </tr>
            <tr>
              <td className="sm" style={cell}>
                Optional
              </td>
              <td className="tnum sm" style={cellRight}>
                {money(optionalSpent)}
              </td>
              <td style={cellRight}>
                {verdict(
                  !offPace,
                  `+${money(projectedOptional - optionalTarget)} projected`,
                  true,
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
