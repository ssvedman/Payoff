import { useMemo } from 'react'
import TrendChart from '../components/TrendChart'
import { useBusinessMonths } from '../lib/businessMonths'
import { useData, useNetWorth } from '../lib/data'
import { type MonthBucket } from '../lib/business'
import { money, moneyCents, parseDateOnly, signedAmount } from '../lib/format'

/**
 * /business — what the business took in, what it spent, and what the household
 * drew out of it.
 *
 * WHY THIS PAGE EXISTS. The business funds roughly a third of household income
 * and had no screen at all. Its checking account runs close to empty every month
 * because whatever is left after costs is drawn out, so the first warning of a
 * quiet month would have been a payment bouncing rather than a figure on a chart.
 * This page makes that shape visible.
 *
 * It REPORTS. There is no advice here, no suggestion to move money, no
 * encouragement and no exclamation mark. "Business balance $412", never "you
 * should transfer money".
 *
 * Colour: amber appears nowhere — it means the current payoff target and nothing
 * else. Green is not used for a series either. Every chart colour below is
 * categorical and carries identity only; every figure is var(--ink) or
 * var(--steel) unless it is a stated deviation.
 *
 * Every number is computed from live rows. The build doc's figures for this
 * business disagree with the database, and the database wins.
 */

/**
 * Categorical series colours, in fixed order — the same five LinePie uses, so the
 * two charts on this app do not each invent a palette. Assigned by a series'
 * fixed place in its list, never by size, so a payer or a cost keeps its colour
 * as the ranking moves. Amber, green and red are absent by design: they already
 * mean the current target, on plan and off plan.
 */
const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#4a3aa7', '#c2185b']
const REST_COLOR = 'var(--steel)'

/** How many named categories get their own colour before the rest share grey. */
const COLOURED_CATEGORIES = 5

interface Series {
  key: string
  label: string
  color: string
}

interface StackRow {
  key: string
  label: string
  total: number
  parts: Record<string, number>
  partial?: boolean
}

/**
 * Stacked bars, one per month.
 *
 * Hand-rolled rather than pulled from a library, matching TrendChart's approach.
 * Note the text nodes: inside an SVG a figure renders in the browser's default
 * serif with proportional digits unless BOTH fontFamily="inherit" and the tnum
 * class are set on the node itself — inheriting from the page does not happen.
 */
function StackChart({
  rows,
  series,
  caption,
}: {
  rows: StackRow[]
  series: Series[]
  caption: string
}) {
  const W = 320
  const H = 154
  const PAD = { top: 10, right: 6, bottom: 26, left: 6 }
  const innerH = H - PAD.top - PAD.bottom
  const innerW = W - PAD.left - PAD.right

  const max = Math.max(...rows.map((r) => r.total), 0)
  if (rows.length === 0 || max <= 0) {
    return <div className="sm muted" style={{ padding: '18px 0' }}>{caption}</div>
  }

  const slot = innerW / rows.length
  const barW = Math.min(34, slot * 0.62)

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={`${caption}. ${rows
          .map((r) => `${r.label} ${money(r.total)}`)
          .join(', ')}.`}
        style={{ display: 'block' }}
      >
        {/* Hairline baseline only. No gridlines competing with the data. */}
        <line
          x1={PAD.left}
          y1={PAD.top + innerH}
          x2={W - PAD.right}
          y2={PAD.top + innerH}
          stroke="var(--line)"
          strokeWidth="1"
        />

        {rows.map((r, i) => {
          const cx = PAD.left + slot * i + slot / 2
          let y = PAD.top + innerH
          return (
            <g key={r.key}>
              {series.map((s) => {
                const v = r.parts[s.key] ?? 0
                if (v <= 0) return null
                const h = (v / max) * innerH
                y -= h
                return (
                  <rect
                    key={s.key}
                    x={cx - barW / 2}
                    y={y}
                    width={barW}
                    height={h}
                    fill={s.color}
                  >
                    <title>{`${r.label} · ${s.label}: ${money(v)}`}</title>
                  </rect>
                )
              })}
              <text
                x={cx}
                y={H - 14}
                fontSize="10"
                fill="var(--steel)"
                textAnchor="middle"
                fontFamily="inherit"
                className="tnum"
              >
                {r.label.slice(0, 3)}
              </text>
              {r.partial && (
                <text
                  x={cx}
                  y={H - 3}
                  fontSize="9"
                  fill="var(--steel)"
                  textAnchor="middle"
                  fontFamily="inherit"
                >
                  part
                </text>
              )}
            </g>
          )
        })}
      </svg>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 8 }}>
        {series.map((s) => (
          <span key={s.key} className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              aria-hidden="true"
              style={{ width: 10, height: 10, borderRadius: 3, background: s.color, display: 'block' }}
            />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * One bar per month above or below a zero line.
 *
 * Deliberately one neutral colour for both directions. The sign is carried by
 * which side of the axis the bar sits on, which is unambiguous; colouring a
 * negative month red would call it a deviation, and the business has no plan to
 * deviate from.
 */
function NetChart({ rows }: { rows: MonthBucket[] }) {
  const W = 320
  const H = 132
  const PAD = { top: 12, right: 6, bottom: 26, left: 6 }
  const innerH = H - PAD.top - PAD.bottom
  const innerW = W - PAD.left - PAD.right

  const max = Math.max(...rows.map((r) => Math.abs(r.net)), 1)
  const zeroY = PAD.top + innerH / 2
  const half = innerH / 2
  const slot = innerW / Math.max(rows.length, 1)
  const barW = Math.min(30, slot * 0.58)

  if (rows.length === 0) return <div className="sm muted">Nothing recorded yet.</div>

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      role="img"
      aria-label={`Money in less money out, by month. ${rows
        .map((r) => `${r.label} ${signedAmount(r.net, money)}`)
        .join(', ')}.`}
      style={{ display: 'block' }}
    >
      <line x1={PAD.left} y1={zeroY} x2={W - PAD.right} y2={zeroY} stroke="var(--line)" strokeWidth="1" />
      {rows.map((r, i) => {
        const cx = PAD.left + slot * i + slot / 2
        const h = (Math.abs(r.net) / max) * half
        // A month that moved almost nothing still needs to be visible as a mark
        // rather than disappearing into the axis.
        const drawn = Math.max(h, 1.5)
        return (
          <g key={r.key}>
            <rect
              x={cx - barW / 2}
              y={r.net >= 0 ? zeroY - drawn : zeroY}
              width={barW}
              height={drawn}
              fill={REST_COLOR}
            >
              <title>{`${r.longLabel}: ${signedAmount(r.net, moneyCents)}`}</title>
            </rect>
            <text
              x={cx}
              y={H - 10}
              fontSize="10"
              fill="var(--steel)"
              textAnchor="middle"
              fontFamily="inherit"
              className="tnum"
            >
              {r.label.slice(0, 3)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** A label/figure pair on its own line, the shape the rest of the app uses. */
function Line({
  label,
  value,
  note,
  strong,
}: {
  label: string
  value: string
  note?: string
  strong?: boolean
}) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
      <div className="sm" style={{ flex: 1 }}>
        {label}
        {note && <div className="tiny muted">{note}</div>}
      </div>
      <div className="tnum sm" style={strong ? { fontWeight: 700 } : undefined}>
        {value}
      </div>
    </div>
  )
}

export default function Business() {
  const { businessAccounts, loading: dataLoading, error: dataError } = useData()
  const { debtTotal } = useNetWorth()
  const view = useBusinessMonths()
  const summary = view.summary

  /**
   * The business's cash, and the business's debt, kept apart.
   *
   * `checking` in the shared provider is household-only now, so the 5star balance
   * has to come from businessAccounts — the same rule in reverse: business money
   * never enters household maths, and household screens never show this figure.
   */
  const cash = useMemo(
    () => businessAccounts.filter((a) => a.kind === 'checking' || a.kind === 'savings'),
    [businessAccounts],
  )
  const cards = useMemo(() => businessAccounts.filter((a) => a.kind === 'card'), [businessAccounts])

  const cashTotal = cash.reduce((s, a) => s + a.balance, 0)
  const cardTotal = cards.reduce((s, a) => s + Math.max(0, a.balance), 0)
  const cashAsOf = cash.map((a) => a.balanceAsOf).filter(Boolean).sort().pop() ?? null

  const thisMonth = useMemo(() => {
    if (!summary || summary.months.length === 0) return null
    const now = new Date()
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    return summary.months.find((m) => m.key === key) ?? null
  }, [summary])

  if (dataLoading || view.loading) {
    return (
      <div className="page">
        <div className="sect">Business</div>
        {/* The same shape the loaded page has — a headline panel, then a chart
            beside its figures — so the page does not reflow around the reader
            when the rows land. */}
        <div className="skeleton" style={{ height: 132, marginBottom: 20 }} aria-label="Loading" />
        <div className="dk-cols dk-cols--chart">
          <div className="skeleton" style={{ height: 132 }} aria-hidden="true" />
          <div className="skeleton" style={{ height: 132 }} aria-hidden="true" />
        </div>
      </div>
    )
  }

  const error = dataError ?? view.error
  if (error) {
    return (
      <div className="page">
        <div className="sect">Business</div>
        <div className="banner banner--red sm">Could not load the business record. {error}</div>
      </div>
    )
  }

  if (businessAccounts.length === 0 || !summary) {
    return (
      <div className="page">
        <div className="sect">Business</div>
        <div className="sm muted">No business accounts are linked.</div>
      </div>
    )
  }

  return (
    <div className="page">
      {/* ---------------------------------------------------------------- */}
      {/* Header                                                            */}
      {/* ---------------------------------------------------------------- */}
      <div className="card-panel" style={{ marginTop: 8 }}>
        <div className="caps">BUSINESS BALANCE</div>
        <div className="tnum" style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.15, marginTop: 2 }}>
          {moneyCents(cashTotal)}
        </div>
        <div className="tiny muted">
          {cash.map((a) => a.name).join(', ') || 'no cash account'}
          {cashAsOf && ` · as of ${parseDateOnly(cashAsOf).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}`}
        </div>

        {thisMonth ? (
          <div
            style={{
              display: 'flex',
              gap: 14,
              marginTop: 14,
              paddingTop: 12,
              borderTop: '1px solid var(--line)',
            }}
          >
            <div style={{ flex: 1 }}>
              <div className="caps">IN</div>
              <div className="tnum sm" style={{ fontWeight: 700 }}>{moneyCents(thisMonth.moneyIn)}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div className="caps">OUT</div>
              <div className="tnum sm" style={{ fontWeight: 700 }}>{moneyCents(thisMonth.moneyOut)}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div className="caps">NET</div>
              <div className="tnum sm" style={{ fontWeight: 700 }}>
                {signedAmount(thisMonth.net, moneyCents)}
              </div>
            </div>
          </div>
        ) : (
          <div className="tiny muted" style={{ marginTop: 12 }}>
            Nothing recorded on a business account this month.
          </div>
        )}
        {thisMonth && (
          <div className="tiny muted" style={{ marginTop: 8 }}>
            {thisMonth.longLabel} so far. The month is still running.
          </div>
        )}
      </div>

      {/*
        The one flag on this page. It states a fact and stops — no suggestion
        about what to do with it. Red because a balance below the floor is a
        deviation; the wording carries no judgement.
      */}
      {cashTotal < 500 && (
        <div className="banner banner--red sm tnum" style={{ marginTop: 12 }}>
          Business balance is {moneyCents(cashTotal)}, below $500.
        </div>
      )}

      {/*
        Said in words because no chart can say it. The Amazon Business card is a
        business debt AND one of the accounts in the household payoff queue,
        so the same balance appears on two screens. Without this line a reader who
        has seen both would reasonably conclude the household owes it twice.
      */}
      {cardTotal > 0 && (
        <div className="tiny muted" style={{ marginTop: 12 }}>
          <span className="tnum">{moneyCents(cardTotal)}</span> on the business card
          {cards.length > 1 ? 's' : ''} is also inside the household payoff queue and inside the{' '}
          <span className="tnum">{money(debtTotal)}</span> total debt. It is one balance shown in two
          places, not two debts.
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Month by month                                                    */}
      {/* ---------------------------------------------------------------- */}
      <div className="sect">Month by month</div>
      {/*
        Chart beside its own figures, at >=1024px. The left column is fixed at
        the chart's native drawing width: NetChart and StackChart both use a
        320-unit viewBox and centre themselves in whatever box they are given, so
        a wider column adds dead space rather than detail. Below 1024px this is
        an ordinary div and the chart sits above its table exactly as before.
      */}
      <div className="dk-cols dk-cols--chart">
      <NetChart rows={summary.months} />

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }}>
        <thead>
          <tr className="caps">
            <th style={{ textAlign: 'left', paddingBottom: 6 }}>Month</th>
            <th style={{ textAlign: 'right', paddingBottom: 6 }}>In</th>
            <th style={{ textAlign: 'right', paddingBottom: 6 }}>Out</th>
            <th style={{ textAlign: 'right', paddingBottom: 6 }}>Net</th>
          </tr>
        </thead>
        <tbody>
          {summary.months.map((m) => (
            <tr key={m.key} style={{ borderTop: '1px solid var(--line)' }}>
              <td className="sm" style={{ padding: '8px 0' }}>
                {m.label}
                {m.partial && <span className="tiny muted"> · part month</span>}
              </td>
              <td className="tnum sm" style={{ textAlign: 'right' }}>{money(m.moneyIn)}</td>
              <td className="tnum sm" style={{ textAlign: 'right' }}>{money(m.moneyOut)}</td>
              <td className="tnum sm" style={{ textAlign: 'right', fontWeight: 700 }}>
                {signedAmount(m.net, money)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {/*
        The finding this page was built for, stated as a measurement rather than
        as a claim: how many consecutive complete months landed within $500 of
        break-even, how wide that band actually was, and on how much throughput.
        Derived every render, so it stays true as months are added.
      */}
      {summary.breakEvenRun >= 3 && (
        <div className="sm" style={{ marginTop: 12 }}>
          The last <span className="tnum">{summary.breakEvenRun}</span> complete months each ended
          within <span className="tnum">{moneyCents(summary.breakEvenBand)}</span> of break-even, on
          an average <span className="tnum">{money(summary.runThroughput)}</span> a month coming in.
          <div className="tiny muted" style={{ marginTop: 4 }}>
            Costs and the draw together take close to whatever arrives, so the closing balance
            carries little from one month to the next.
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Revenue                                                           */}
      {/* ---------------------------------------------------------------- */}
      <div className="sect">Revenue, by payer</div>
      <div className="dk-cols dk-cols--chart">
      <StackChart
        caption="Revenue by month, split by payer"
        series={summary.payers
          .filter((p) => p.total > 0)
          .map((p, i) => ({ key: p.key, label: p.label, color: SERIES_COLORS[i] ?? REST_COLOR }))}
        rows={summary.months.map((m) => ({
          key: m.key,
          label: m.label,
          total: m.revenue,
          partial: m.partial,
          parts: m.revenueByPayer as unknown as Record<string, number>,
        }))}
      />

      <div style={{ marginTop: 10 }}>
        {summary.payers
          .filter((p) => p.total > 0)
          .map((p) => (
            <Line
              key={p.key}
              label={p.label}
              note={p.descriptor}
              value={money(p.total)}
            />
          ))}
        <Line label="Total revenue" value={money(summary.totals.revenue)} strong />
      </div>
      </div>

      {/*
        Stated because the chart cannot: money arriving on the business account is
        not all revenue. The household funds the business too, and those rows sit
        under the same TRANSFER_IN category as everything else.
      */}
      {summary.totals.fromHousehold > 0 && (
        <div className="tiny muted" style={{ marginTop: 8 }}>
          A further <span className="tnum">{moneyCents(summary.totals.fromHousehold)}</span> arrived
          from household accounts over this window. That is the household funding the business, so it
          is counted separately from revenue.
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Costs                                                             */}
      {/* ---------------------------------------------------------------- */}
      <div className="sect">Costs, by category</div>
      <div className="dk-cols dk-cols--chart">
      <StackChart
        caption="Costs by month, split by category"
        series={summary.categories
          .filter((c) => c.total > 0)
          .map((c, i) => ({
            key: i < COLOURED_CATEGORIES ? c.key : 'rest',
            label: i < COLOURED_CATEGORIES ? c.label : 'Everything else',
            color: i < COLOURED_CATEGORIES ? SERIES_COLORS[i] : REST_COLOR,
          }))
          // The tail shares one grey slice, so it appears once in the legend.
          .filter((s, i, all) => all.findIndex((x) => x.key === s.key) === i)}
        rows={summary.months.map((m) => {
          const parts: Record<string, number> = { rest: 0 }
          summary.categories
            .filter((c) => c.total > 0)
            .forEach((c, i) => {
              const v = m.costsByCategory[c.key] ?? 0
              if (i < COLOURED_CATEGORIES) parts[c.key] = v
              else parts.rest += v
            })
          return { key: m.key, label: m.label, total: m.costs, partial: m.partial, parts }
        })}
      />

      <div style={{ marginTop: 10 }}>
        {summary.categories
          .filter((c) => c.total > 0)
          .map((c) => (
            <Line key={c.key} label={c.label} value={money(c.total)} />
          ))}
        <Line label="Total costs" value={money(summary.totals.costs)} strong />
      </div>
      </div>

      {/*
        The reconciliation, stated. Seven named categories cover only part of this
        spend — Amazon, Walmart and Sam's between them run past anything but
        labour — so a chart of seven would understate costs by roughly a third.
        Every cost lands in exactly one category above, and this line is the proof
        rather than the promise.
      */}
      <div className="tiny muted" style={{ marginTop: 8 }}>
        {Math.abs(summary.categoryResidual) < 0.01 ? (
          <>
            The categories above add to{' '}
            <span className="tnum">{moneyCents(summary.totals.costs)}</span>, which is every cost in
            this window. Nothing is left out of the breakdown.
          </>
        ) : (
          <>
            The categories above add to{' '}
            <span className="tnum">
              {moneyCents(summary.totals.costs + summary.categoryResidual)}
            </span>{' '}
            against <span className="tnum">{moneyCents(summary.totals.costs)}</span> of costs — a
            difference of <span className="tnum">{moneyCents(summary.categoryResidual)}</span>.
          </>
        )}
        {summary.totals.refunds > 0 && (
          <>
            {' '}
            <span className="tnum">{moneyCents(summary.totals.refunds)}</span> of refunds came back
            and is counted as money in, not as a negative cost.
          </>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The draw                                                          */}
      {/* ---------------------------------------------------------------- */}
      <div className="sect">The draw</div>
      <div className="dk-cols dk-cols--chart">
      <StackChart
        caption="Business money reaching the household, by month"
        series={[{ key: 'draw', label: 'To the household', color: SERIES_COLORS[3] }]}
        rows={summary.months.map((m) => ({
          key: m.key,
          label: m.label,
          total: m.draw,
          partial: m.partial,
          parts: { draw: m.draw },
        }))}
      />

      <div style={{ marginTop: 10 }}>
        {summary.drawDestinations.map((d) => (
          <Line key={d.label} label={d.label} value={money(d.total)} />
        ))}
        <Line label="Total drawn" value={money(summary.totals.draw)} strong />
      </div>
      </div>

      {/*
        Two things a reader would otherwise get wrong, and both cost real money.
      */}
      <div className="tiny muted" style={{ marginTop: 8 }}>
        Counted from the business side only. Every transfer to household checking also appears on the
        household side as an arriving transfer already bucketed as income, and adding both legs would
        double the draw. The household side is also incomplete — money that paid a household card
        directly, or reached a person by Zelle, never touched household checking and would be missing
        from it entirely.
      </div>

      {summary.outside.length > 0 && (
        <div className="tiny muted" style={{ marginTop: 8 }}>
          {summary.outside.map((o) => (
            <div key={o.label} style={{ marginTop: 2 }}>
              {o.out > 0 && (
                <>
                  <span className="tnum">{moneyCents(o.out)}</span> went to {o.label}. Not counted as
                  a draw, because it did not reach an account this app tracks.{' '}
                </>
              )}
              {o.in > 0 && (
                <>
                  <span className="tnum">{moneyCents(o.in)}</span> came back from {o.label}, and is
                  not counted as revenue.
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Balance trend                                                     */}
      {/* ---------------------------------------------------------------- */}
      <div className="sect">Balance readings</div>
      <BalanceReadings readings={view.cashReadings} />

      <div className="tiny muted" style={{ marginTop: 14 }}>
        Business rows never enter a household budget bucket, and nothing on this page is part of the
        household's income, spending or payoff maths.
      </div>
    </div>
  )
}

/**
 * The balance history, said honestly.
 *
 * The business checking account has five readings, all inside four days, because
 * that is when it was linked. Drawing a line through them would look like a trend
 * and be nothing of the kind, and reconstructing the earlier months from
 * transactions would be inventing a record the bank never gave us. So: below a
 * fortnight of readings this lists what was actually recorded and says how many
 * there are; above it, the same trend line the rest of the app uses.
 */
function BalanceReadings({ readings }: { readings: { as_of: string; balance: number }[] }) {
  if (readings.length === 0) {
    return <div className="sm muted">No balance has been recorded for the business yet.</div>
  }

  const first = parseDateOnly(readings[0].as_of)
  const last = parseDateOnly(readings[readings.length - 1].as_of)
  const spanDays = Math.round((last.getTime() - first.getTime()) / 86400000)
  const fmtDay = (iso: string) =>
    parseDateOnly(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })

  const note = (
    <div className="tiny muted" style={{ marginBottom: 8 }}>
      <span className="tnum">{readings.length}</span>{' '}
      {readings.length === 1 ? 'reading' : 'readings'} since {fmtDay(readings[0].as_of)}
      {spanDays > 0 && (
        <>
          {' · '}
          <span className="tnum">{spanDays}</span> {spanDays === 1 ? 'day' : 'days'}
        </>
      )}
      . Nothing was recorded before the account was linked, and no earlier history is reconstructed
      here.
    </div>
  )

  // Too short a span to be a trend. Show the readings themselves.
  if (spanDays < 14 || readings.length < 8) {
    return (
      <div>
        {note}
        {readings.map((r) => (
          <div
            key={r.as_of}
            className="row sm"
            style={{ justifyContent: 'space-between', padding: '8px 0' }}
          >
            <span className="tnum muted">{fmtDay(r.as_of)}</span>
            <span className="tnum">{moneyCents(r.balance)}</span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div>
      {note}
      <TrendChart
        points={readings.map((r) => ({ date: r.as_of, value: r.balance }))}
        color="var(--steel)"
        format={moneyCents}
        label="Business cash balance"
        baseline="zero"
      />
    </div>
  )
}
