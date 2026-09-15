import { useMemo } from 'react'
import Bar from '../components/Bar'
import { useData, usePayoffPlan, useMonthTotals } from '../lib/data'
import { apr, money, accountLabel, parseDateOnly, relativeTime } from '../lib/format'
import { monthNumber, totalPlanMonths } from '../lib/avalanche'

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** Sub-line under a debt name: rate and owner, or the IRS payment plan. */
/** The owner now leads the account name, so it is not repeated here. */
function rateLine(rate: number | null): string {
  return rate === null ? 'payment plan' : `${apr(rate)}`
}

function Header({ syncedAt }: { syncedAt: string | null }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 18,
      }}
    >
      <span style={{ fontWeight: 700, fontSize: 16 }}>Payoff</span>
      <span className="tiny muted">
        {syncedAt ? `synced ${relativeTime(syncedAt)}` : 'not synced yet'}
      </span>
    </div>
  )
}

function HomeSkeleton() {
  return (
    <div className="page">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 18,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 16 }}>Payoff</span>
        <div className="skeleton" style={{ width: 84, height: 9 }} aria-hidden="true" />
      </div>

      <div className="skeleton" style={{ width: 104, height: 9, marginBottom: 8 }} aria-hidden="true" />
      <div className="skeleton" style={{ width: 218, height: 40, marginBottom: 9 }} aria-hidden="true" />
      <div className="skeleton" style={{ width: 150, height: 9, margin: '5px 0 13px' }} aria-hidden="true" />
      <div className="skeleton" style={{ width: '100%', height: 7, marginBottom: 20 }} aria-hidden="true" />

      <div className="skeleton" style={{ width: '100%', height: 132, marginBottom: 20 }} aria-hidden="true" />

      <div className="sect">Queue</div>
      <div style={{ borderTop: '2px solid var(--ink)' }} aria-label="Loading the queue">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
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

      <div className="skeleton" style={{ width: '100%', height: 84, marginTop: 20 }} aria-hidden="true" />
    </div>
  )
}

export default function Home() {
  const { loading, error, debts, lastSyncedAt } = useData()
  const plan = usePayoffPlan()
  const totals = useMonthTotals()

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
        out.push(`Optional bucket at ${Math.round((optionalSpent / optionalTarget) * 100)}%`)
      }
    }

    for (const d of debts) {
      if (target && d.id === target.id) continue
      if (d.previousBalance === null) continue
      if (d.balance > d.previousBalance) {
        out.push(`${accountLabel(d)} balance rose ${money(d.balance - d.previousBalance)}`)
      }
    }

    return out
  }, [debts, target, totals])

  if (loading) return <HomeSkeleton />

  // Without plan settings there is nothing to derive. Report it rather than
  // holding the skeleton forever — the error banner below is unreachable
  // while plan is null.
  if (!plan) {
    return (
      <div className="page">
        <Header syncedAt={lastSyncedAt} />
        <div className="banner banner--red">
          <div className="sm" style={{ fontWeight: 700, color: 'var(--red-tx)' }}>
            {error ? 'Data did not load' : 'No plan settings on record'}
          </div>
          <div className="tiny" style={{ color: 'var(--red-tx)', marginTop: 3 }}>
            {error ?? 'The plan row is empty, so no figures can be derived.'}
          </div>
        </div>
      </div>
    )
  }

  const monthNo = monthNumber(plan.planStartedOn)
  // Never fewer total months than the month already reached: with nothing owed
  // the simulation returns 0 months, which would read "MONTH 3 OF 2".
  const monthTotal = Math.max(monthNo, totalPlanMonths(plan.planStartedOn, plan.sim.months))

  const targetMin = target ? target.minimum_payment : 0
  const targetPaidPct = target
    ? clamp01(
        target.opening_balance > 0
          ? (target.opening_balance - target.balance) / target.opening_balance
          : 0,
      )
    : 0

  const clearEvent = target ? plan.sim.events.find((e) => e.id === target.id) ?? null : null
  const clearsThisMonth = target ? plan.attackFund + targetMin >= target.balance : false
  const targetOutlook = !target
    ? null
    : clearsThisMonth
      ? 'on track to clear this month'
      : clearEvent
        ? `projected to clear in ${clearEvent.month} ${clearEvent.month === 1 ? 'month' : 'months'}`
        : 'no projected clearing month at the current payment'

  const savingsPct = plan.depositTarget > 0 ? clamp01(plan.savingsBalance / plan.depositTarget) : 0

  return (
    <div className="page">
      <Header syncedAt={lastSyncedAt} />

      {error && (
        <div className="banner banner--red" style={{ marginBottom: 18 }}>
          <div className="sm" style={{ fontWeight: 700, color: 'var(--red-tx)' }}>
            Data did not load
          </div>
          <div className="tiny" style={{ color: 'var(--red-tx)', marginTop: 3 }}>
            {error}
          </div>
        </div>
      )}

      <div
        className="tiny muted tnum"
        style={{ fontWeight: 700, letterSpacing: '.05em', marginBottom: 3 }}
      >
        MONTH {monthNo} OF {monthTotal}
      </div>

      <div
        className="tnum"
        style={{ fontSize: 46, fontWeight: 800, letterSpacing: '-.03em', lineHeight: 1.05 }}
      >
        {money(plan.totalOwed)}
      </div>

      <div className="sm muted tnum" style={{ margin: '5px 0 13px' }}>
        {money(plan.cleared)} cleared so far
      </div>

      <div style={{ marginBottom: 20 }}>
        <Bar pct={plan.progress} color="var(--green)" />
      </div>

      {target ? (
        <div className="target-card" style={{ marginBottom: 20 }}>
          <div
            className="tiny"
            style={{
              color: 'var(--amber)',
              fontWeight: 700,
              letterSpacing: '.06em',
              fontSize: 11.5,
              marginBottom: 7,
            }}
          >
            CURRENT TARGET
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 19, fontWeight: 700 }}>{accountLabel(target)}</span>
            <span className="tnum" style={{ fontSize: 19, fontWeight: 800 }}>
              {money(target.balance)}
            </span>
          </div>

          <div className="tnum" style={{ fontSize: 13, color: '#9DA9B8', marginTop: 4 }}>
            {target.apr === null ? 'payment plan' : apr(target.apr)} · {money(plan.attackFund)} above
            the {money(targetMin)} minimum
          </div>

          <div style={{ marginTop: 11 }}>
            <Bar pct={targetPaidPct} color="var(--amber)" track="#2B3644" />
          </div>

          <div className="tiny tnum" style={{ color: '#9DA9B8', marginTop: 6 }}>
            {targetOutlook}
          </div>
        </div>
      ) : (
        debts.length > 0 && (
          <div className="banner banner--green" style={{ marginBottom: 20 }}>
            <div className="sm" style={{ fontWeight: 700 }}>
              Every account is clear.
            </div>
          </div>
        )
      )}

      {deviations.length > 0 && (
        <div className="banner banner--red" style={{ marginBottom: 18 }}>
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

      <div className="sect">Queue</div>
      <div style={{ borderTop: '2px solid var(--ink)' }}>
        {debts.length === 0 && (
          <div className="row">
            <div className="sm muted">No accounts on record.</div>
          </div>
        )}
        {debts.map((d, i) => {
          const last = i === debts.length - 1
          const isCleared = d.balance <= 0 || d.cleared_at !== null
          const isTarget = !isCleared && target !== null && d.id === target.id
          const rowStyle = {
            opacity: isCleared ? 0.42 : isTarget ? 1 : 0.68,
            ...(last ? { borderBottom: 'none' } : null),
          }

          if (isCleared) {
            // The mockup labels a cleared account by the plan month it cleared in.
            const clearedMonth = d.cleared_at
              ? monthNumber(plan.planStartedOn, parseDateOnly(d.cleared_at))
              : null
            return (
              <div className="row" key={d.id} style={rowStyle}>
                <div className="dot" style={{ background: 'var(--green)' }} aria-hidden="true">
                  ✓
                </div>
                <div style={{ flex: 1 }}>
                  <div className="sm" style={{ textDecoration: 'line-through' }}>
                    {accountLabel(d)}
                  </div>
                </div>
                {clearedMonth !== null && (
                  <div className="tiny muted tnum">month {clearedMonth}</div>
                )}
              </div>
            )
          }

          return (
            <div className="row" key={d.id} style={rowStyle}>
              <div
                className="dot"
                style={
                  isTarget ? { background: 'var(--amber)' } : { border: '2px solid var(--line)' }
                }
                aria-hidden="true"
              />
              <div style={{ flex: 1 }}>
                {isTarget ? (
                  <div style={{ fontWeight: 700, fontSize: 14.5 }}>{accountLabel(d)}</div>
                ) : (
                  <div className="sm">{accountLabel(d)}</div>
                )}
                <div className="tiny muted tnum">{rateLine(d.apr)}</div>
              </div>
              {isTarget ? (
                <div className="tnum" style={{ fontWeight: 700, fontSize: 14.5 }}>
                  {money(d.balance)}
                </div>
              ) : (
                <div className="tnum sm">{money(d.balance)}</div>
              )}
            </div>
          )
        })}
      </div>

      <div className="card-panel" style={{ marginTop: 20 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: 8,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 14.5 }}>Shared savings</span>
          <span className="tnum" style={{ fontWeight: 800, fontSize: 17 }}>
            {money(plan.savingsBalance)}
          </span>
        </div>
        <Bar pct={savingsPct} color="var(--green)" />
        <div className="tiny muted tnum" style={{ marginTop: 6 }}>
          {money(plan.savingsRemaining)} to the deposit target
        </div>
      </div>
    </div>
  )
}
