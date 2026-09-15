import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useData } from '../lib/data'
import { money, moneyCents, accountLabel } from '../lib/format'
import TrendChart, { type TrendPoint } from '../components/TrendChart'

/**
 * /history — how the balances have actually moved, week by week.
 *
 * Two separate charts rather than one with two y-scales. Total owed sits around
 * six figures and savings around two; sharing an axis would invent a relationship
 * that is not in the data.
 *
 * Per-account history is nine series, far past the point where distinct colors
 * stay tellable apart, so it is small multiples — one sparkline per account in a
 * table — instead of a nine-line spaghetti chart.
 *
 * Amber appears nowhere here. It means the current target and nothing else.
 */

interface WeekRow {
  week_start: string
  total_owed: number | string | null
  savings: number | string | null
  open_debts: number | null
  /** False when total_owed is missing an account rather than short one. */
  fully_covered: boolean
  debts_covered: number
  debts_total: number
}

interface AccountWeekRow {
  week_start: string
  account_id: string
  balance: number | string | null
  covered: boolean
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0))

export default function History() {
  const navigate = useNavigate()
  const { accounts, loading: accountsLoading } = useData()

  const [weeks, setWeeks] = useState<WeekRow[] | null>(null)
  const [perAccount, setPerAccount] = useState<AccountWeekRow[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      const [totals, accts] = await Promise.all([
        supabase.from('debt_history_weekly').select('*').order('week_start'),
        supabase
          .from('account_balance_weekly')
          .select('week_start, account_id, balance, covered')
          .order('week_start'),
      ])
      if (!active) return
      if (totals.error) {
        setError(totals.error.message)
        setWeeks([])
        return
      }
      setWeeks((totals.data ?? []) as unknown as WeekRow[])
      setPerAccount((accts.data ?? []) as unknown as AccountWeekRow[])
    })()
    return () => {
      active = false
    }
  }, [])

  /**
   * Only weeks where every debt has a reading. A week missing an account is not a
   * week the total fell — plotting it would draw a cliff out of absent data, and
   * downward is the direction a reader is least likely to question.
   */
  const covered = useMemo(() => (weeks ?? []).filter((w) => w.fully_covered), [weeks])

  const owedSeries: TrendPoint[] = useMemo(
    () => covered.map((w) => ({ date: w.week_start, value: num(w.total_owed) })),
    [covered],
  )

  const savingsSeries: TrendPoint[] = useMemo(
    () => (weeks ?? []).filter((w) => w.savings !== null).map((w) => ({ date: w.week_start, value: num(w.savings) })),
    [weeks],
  )

  const byAccount = useMemo(() => {
    const map = new Map<string, TrendPoint[]>()
    for (const r of perAccount) {
      // An uncovered week has no balance, not a zero one.
      if (!r.covered || r.balance === null) continue
      const list = map.get(r.account_id) ?? []
      list.push({ date: r.week_start, value: num(r.balance) })
      map.set(r.account_id, list)
    }
    return map
  }, [perAccount])

  const first = owedSeries[0]
  const last = owedSeries[owedSeries.length - 1]
  const change = first && last ? last.value - first.value : 0
  const weeksTracked = owedSeries.length
  /**
   * The elapsed span, not the number of readings. Those are the same only while
   * no week is missing — and weeks ARE missing now, since only fully covered
   * ones are plotted. Counting rows would report "over 3 weeks" for a change
   * that actually took three months.
   */
  const weeksSpanned =
    first && last
      ? Math.max(1, Math.round((Date.parse(last.date) - Date.parse(first.date)) / 604800000))
      : 0

  if (weeks === null || accountsLoading) {
    return (
      <div className="page" aria-busy="true" aria-label="Loading history">
        <div className="skeleton" style={{ width: 120, height: 20, marginBottom: 10 }} />
        <div className="skeleton" style={{ width: 170, height: 12, marginBottom: 22 }} />
        <div className="skeleton" style={{ height: 132, marginBottom: 24 }} />
        <div className="skeleton" style={{ height: 132 }} />
      </div>
    )
  }

  const debts = accounts
    .filter((a) => ['card', 'loan', 'tax'].includes(a.kind))
    .sort((a, b) => a.payoff_order - b.payoff_order)

  return (
    <div className="page">
      <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 4 }}>History</div>
      <div className="tiny muted" style={{ marginBottom: 12 }}>
        One reading per week, taken from the last balance recorded in that week.
      </div>

      {/* Say plainly where the line comes from. Most of it is not yet observation:
          the banks hand over a fixed window of transactions at connection and
          nothing before it, so the earlier weeks are worked backwards from what
          was spent and paid. Readings taken since connecting are real. */}
      <div className="card-panel tiny muted" style={{ marginBottom: 18, lineHeight: 1.6 }}>
        Weeks before the accounts were connected are worked backwards from the
        transaction record, not read from the bank. They are close, not exact —
        an account with no transactions of its own and no payments visible from a
        connected account is held flat, because nothing witnesses what it did.
        Readings taken since connecting are real, and every new week added from
        here is a measurement.
      </div>

      {error && (
        <div className="banner banner--red tiny" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* With a single week there is no trend to draw, and a flat line would imply
          a steadiness nobody has observed. Say what is true instead. */}
      {weeksTracked <= 1 ? (
        <div className="card-panel" style={{ marginBottom: 22 }}>
          <div className="sm" style={{ fontWeight: 700, marginBottom: 3 }}>
            Not enough history yet
          </div>
          <div className="tiny muted" style={{ lineHeight: 1.6 }}>
            {weeksTracked === 0
              ? 'No balances have been recorded yet.'
              : 'One week recorded so far. A second reading arrives with the next nightly update, and the charts start from there.'}
          </div>
        </div>
      ) : null}

      {/* ---- total owed ---- */}
      <div className="sect" style={{ marginTop: 0 }}>Total owed</div>
      <div className="tnum" style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.02em' }}>
        {last ? money(last.value) : '—'}
      </div>
      <div className="tiny muted" style={{ marginBottom: 8 }}>
        {weeksTracked > 1 ? (
          <>
            <span className="tnum" style={{ color: change <= 0 ? 'var(--green)' : 'var(--red)' }}>
              {change <= 0 ? '−' : '+'}
              {money(Math.abs(change))}
            </span>{' '}
            over {weeksSpanned} {weeksSpanned === 1 ? 'week' : 'weeks'}
          </>
        ) : (
          'first reading'
        )}
      </div>
      <TrendChart
        points={owedSeries}
        color="var(--ink)"
        format={money}
        label="Total owed, weekly"
        baseline="fit"
      />

      {/* ---- savings ---- */}
      <div className="sect">Savings</div>
      <div className="tnum" style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>
        {savingsSeries.length ? moneyCents(savingsSeries[savingsSeries.length - 1].value) : '—'}
      </div>
      <TrendChart
        points={savingsSeries}
        color="var(--green)"
        format={moneyCents}
        label="Savings balance, weekly"
        height={104}
        baseline="zero"
      />

      {/* ---- per account, as small multiples ---- */}
      <div className="sect">By account</div>
      <div className="tiny muted" style={{ marginBottom: 8, lineHeight: 1.5 }}>
        Each debt on its own scale, so a small balance moving is as visible as a large one.
      </div>
      <table>
        <tbody>
          {debts.map((a) => {
            const series = byAccount.get(a.id) ?? []
            const latest = series[series.length - 1]
            const start = series[0]
            const delta = latest && start ? latest.value - start.value : 0
            return (
              <tr key={a.id}>
                <td style={{ width: '42%' }}>
                  <div className="sm" style={{ fontWeight: 600 }}>
                    {accountLabel(a)}
                  </div>
                  <div className="tnum tiny muted">{moneyCents(a.balance)}</div>
                </td>
                <td style={{ paddingLeft: 8 }}>
                  {series.length > 1 ? (
                    <Sparkline points={series} down={delta <= 0} />
                  ) : (
                    <span className="tiny muted">no history yet</span>
                  )}
                </td>
                <td className="tnum tiny" style={{ textAlign: 'right', width: 62 }}>
                  {series.length > 1 ? (
                    <span style={{ color: delta <= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {delta <= 0 ? '−' : '+'}
                      {money(Math.abs(delta))}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <button className="btn ghost" style={{ marginTop: 20 }} onClick={() => navigate('/')}>
        Back
      </button>
    </div>
  )
}

/**
 * A bare trend line for one account. No axes, no labels — it sits in a table row
 * where the figures beside it carry the numbers, and its only job is direction.
 */
function Sparkline({ points, down }: { points: TrendPoint[]; down: boolean }) {
  const W = 88
  const H = 24
  const values = points.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * (W - 2) + 1
      const y = H - 2 - ((p.value - min) / span) * (H - 4)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true" style={{ display: 'block' }}>
      <path
        d={d}
        fill="none"
        stroke={down ? 'var(--green)' : 'var(--red)'}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
