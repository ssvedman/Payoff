import { useMemo, useState } from 'react'
import Bar from '../components/Bar'
import { useData, usePayoffPlan, useMonthTotals } from '../lib/data'
import { useNavigate } from 'react-router-dom'
import { money, accountLabel, parseDateOnly, relativeTime, rateLabel, dueLabel } from '../lib/format'
import { monthNumber, totalPlanMonths, projectedFinishDate } from '../lib/avalanche'
import { syncNow } from '../lib/plaidLink'

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/**
 * Sub-line under a debt name. The owner leads the name, so it is not repeated
 * here; what earns the space instead is when the thing is due.
 */
function subLine(d: { apr: number | null; kind: string; next_due_on: string | null }): string {
  return [rateLabel(d), dueLabel(d.next_due_on)].filter(Boolean).join(' · ')
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
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: 16 }}>Payoff</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="tiny muted"
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
  const navigate = useNavigate()
  /**
   * Cleared debts are collapsed by default. Nine struck-through rows pushed the
   * live queue below the fold, and the accounts that still need paying are the
   * reason the screen exists. They stay reachable — a cleared debt is the record
   * of the work done, not something to hide.
   */
  const [showCleared, setShowCleared] = useState(false)
  const { loading, error, debts, lastSyncedAt, progress, refresh } = useData()
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

  // Read the simulation rather than re-deriving a rule of thumb next to it. The
  // old test compared this month's payment against the bare balance, ignoring
  // the interest that will post before it clears — so it could print "on track
  // to clear this month" directly above the simulation's own "projected to clear
  // in 2 months", with the two disagreeing on screen at the same time.
  const clearsThisMonth = clearEvent?.month === 1
  const targetOutlook = !target
    ? null
    : clearsThisMonth
      ? 'on track to clear this month'
      : clearEvent
        ? `projected to clear in ${clearEvent.month} ${clearEvent.month === 1 ? 'month' : 'months'}`
        : 'no projected clearing month at the current payment'

  /**
   * Savings is measured against where the plan should have reached BY NOW, not
   * against the final figure. Against the final target a household saving exactly
   * what it promised every month still shows a nearly empty bar for years, which
   * reports failure at something being done correctly.
   *
   * Month N expects N-1 deposits, not N. monthNumber() returns 1 on the day the
   * plan starts, so multiplying by it counted the first month's deposit as
   * already overdue before a single day had passed — the plan opened reporting a
   * shortfall. The deposit for the month in progress is not late until the month
   * is over.
   */
  const pacedTarget = Math.min(
    Math.max(0, monthNo - 1) * plan.monthlySavings,
    plan.depositTarget,
  )
  const savingsPct = pacedTarget > 0 ? clamp01(plan.savingsBalance / pacedTarget) : 0
  const savingsAhead = plan.savingsBalance - pacedTarget

  const finish = projectedFinishDate(plan.sim.months)
  const finishLabel = finish.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  const clearedDebts = debts.filter((d) => d.balance <= 0 || d.cleared_at !== null)
  const activeDebts = debts.filter((d) => !(d.balance <= 0 || d.cleared_at !== null))
  const shownDebts = showCleared ? debts : activeDebts

  return (
    <div className="page">
      <Header syncedAt={lastSyncedAt} onRefresh={() => void refreshNow()} busy={syncing} note={syncNote} />

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

        {/* The simulation already computed all of this; none of it was ever shown.
            A finish date is the question the whole plan exists to answer, and the
            interest figure is what the ordering is FOR — putting the highest rate
            first is only worth doing if you can see what it saves. `stalled`
            means the payments do not cover the interest, which must never be
            reported as a date. */}
        <div className="tiny muted tnum" style={{ marginTop: 7, lineHeight: 1.6 }}>
          {plan.sim.stalled ? (
            <span style={{ color: 'var(--red)' }}>
              At the current payment the balances do not come down — the interest
              is larger than what is going to it.
            </span>
          ) : plan.sim.months > 0 ? (
            <>
              Clear by {finishLabel} · {money(plan.sim.totalInterest)} interest from here
            </>
          ) : (
            'Every account is clear.'
          )}
        </div>

        <button
          type="button"
          onClick={() => navigate('/history')}
          className="tiny muted"
          style={{
            background: 'none',
            border: 'none',
            padding: '6px 0 0',
            cursor: 'pointer',
            font: 'inherit',
            textDecoration: 'underline',
          }}
        >
          See how this has moved
        </button>
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
            {rateLabel(target)} · {money(plan.attackFund)} above the {money(targetMin)} minimum
            {dueLabel(target.next_due_on) ? ` · ${dueLabel(target.next_due_on)}` : ''}
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
        {shownDebts.length === 0 && (
          <div className="row">
            <div className="sm muted">
              {debts.length === 0 ? 'No accounts on record.' : 'Every account is clear.'}
            </div>
          </div>
        )}
        {shownDebts.map((d, i) => {
          const last = i === shownDebts.length - 1
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

          // Progress is measured against the highest balance ever recorded for
          // this account, not its opening figure: a card that was run up after
          // the plan started peaked above where it opened, and measuring from
          // the opening figure would report progress that has not happened.
          const p = progress[d.id]
          const showProgress = p !== undefined && p.peak_balance > 0 && p.paid_off > 0

          return (
            <div
              key={d.id}
              style={{
                ...rowStyle,
                padding: '12px 0',
                borderBottom: last ? 'none' : '1px solid var(--line)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                <div
                  className="dot"
                  style={
                    isTarget ? { background: 'var(--amber)' } : { border: '2px solid var(--line)' }
                  }
                  aria-hidden="true"
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {isTarget ? (
                    <div style={{ fontWeight: 700, fontSize: 14.5 }}>{accountLabel(d)}</div>
                  ) : (
                    <div className="sm">{accountLabel(d)}</div>
                  )}
                  <div className="tiny muted tnum">{subLine(d)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div
                    className="tnum"
                    style={{ fontWeight: isTarget ? 700 : 400, fontSize: isTarget ? 14.5 : 13.5 }}
                  >
                    {money(d.balance)}
                  </div>
                  {showProgress && (
                    <div className="tiny muted tnum" style={{ marginTop: 1 }}>
                      of {money(p.peak_balance)}
                    </div>
                  )}
                </div>
              </div>

              {showProgress && (
                <div style={{ marginTop: 8, marginLeft: 27 }}>
                  {/* Never amber — that is reserved for the current target, and a
                      progress bar on every row would spread it across the whole
                      queue. */}
                  <Bar pct={clamp01(p.pct_paid / 100)} color="var(--green)" />
                  <div className="tiny muted tnum" style={{ marginTop: 4 }}>
                    {money(p.paid_off)} paid · {p.pct_paid}%
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {clearedDebts.length > 0 && (
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
      )}

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
          {money(pacedTarget)} expected by now ·{' '}
          <span style={{ color: savingsAhead >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {savingsAhead >= 0 ? '+' : '−'}
            {money(Math.abs(savingsAhead))}
          </span>
        </div>
        <div className="tiny muted tnum" style={{ marginTop: 3 }}>
          {money(plan.savingsRemaining)} to the {money(plan.depositTarget)} deposit target
        </div>
      </div>
    </div>
  )
}
