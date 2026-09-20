import { useMemo, useState } from 'react'
import CalendarNav from '../components/CalendarNav'
import MonthGrid from '../components/MonthGrid'
import { useCalendar, useCalendarMonth, type DayCell, type DuePayment, type ExpectedFlow } from '../lib/calendar'
import { cadenceLabel, type Series } from '../lib/cadence'
import { dayHeading, isoDate, money, moneyCents, parseDateOnly, signedAmount } from '../lib/format'

/**
 * /calendar — when money moves, and where household checking is projected to sit
 * on each day of it.
 *
 * WHY this page exists, written down so nobody softens it later: the checking
 * accounts repeatedly ran to single digits and the toll accounts went negative,
 * which cost real money in pay-by-plate rates and violation fees before anyone
 * noticed. So the page names any day the projection falls below zero, and says
 * only that. It does not suggest moving money, it does not encourage, and it does
 * not congratulate. A report of the position is the whole product.
 *
 * Equally important is what it refuses to claim. The projection counts scheduled
 * debt payments and income whose cadence is actually derivable from six months of
 * history. It does NOT count day-to-day variable spending, because there is no
 * honest figure for that — and a page that quietly assumed groceries were zero
 * would be reassuring and wrong, which on this particular screen is the most
 * expensive thing it could be. That limitation is printed on the page rather than
 * buried here.
 */

/** "Fri 25 Sep" — short enough for a list row. */
function shortDay(iso: string): string {
  return parseDateOnly(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

export default function Calendar() {
  const month = useCalendarMonth()
  const model = useCalendar(month.anchor)
  const [selected, setSelected] = useState<string | null>(null)

  const todayIso = isoDate(new Date())

  /** Every day in the month with anything on it, in order. */
  const busyDays = useMemo(
    () => model.weeks.flat().filter((c) => c.inMonth && (c.due.length > 0 || c.expected.length > 0)),
    [model.weeks],
  )

  const selectedCell = useMemo(
    () => (selected ? model.weeks.flat().find((c) => c.date === selected) ?? null : null),
    [model.weeks, selected],
  )

  if (model.loading) {
    return (
      <div className="page">
        <div className="sect">Calendar</div>
        <div className="skeleton" style={{ width: '100%', height: 44, marginBottom: 14 }} aria-hidden="true" />
        {/* Two columns here too: the grid is the tallest thing on the page and
            must not jump from full width into half of it when the data lands. */}
        <div className="dk-cols dk-cols--even">
          <div className="skeleton" style={{ width: '100%', height: 200 }} aria-hidden="true" />
          <div className="skeleton" style={{ width: '100%', height: 300 }} aria-label="Loading the calendar" />
        </div>
      </div>
    )
  }

  if (model.error) {
    return (
      <div className="page">
        <div className="sect">Calendar</div>
        {/* A failed read is not an empty month. Saying "nothing due" here would
            be a statement of fact that nobody has checked. */}
        <div className="banner banner--red sm">Could not load the calendar: {model.error}</div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="sect">Calendar</div>

      <CalendarNav month={month} />

      {/*
        What the projection is seeded from and what it says on the left; the
        month itself on the right. On a phone these stack in exactly this order,
        which is why the seed panel leads: the grid means nothing until you know
        what balance it is counting down from.
      */}
      <div className="dk-cols dk-cols--even">
      <div>
      <SeedLine model={model} />

      <ShortfallLine model={model} />
      </div>

      <div>
      <MonthGrid
        weeks={model.weeks}
        selected={selected}
        onSelect={(d) => setSelected((cur) => (cur === d ? null : d))}
      />

      <MonthTotals model={model} />

      {/* The whole-horizon banner names the FIRST day below zero, which may be
          three months away. This says what the month on screen does, so stepping
          to December does not require remembering what the banner said. */}
      {model.negativeDays.length > 0 && (
        <div className="tiny" style={{ color: 'var(--red-tx)', marginTop: 8, fontWeight: 700 }}>
          <span className="tnum">{model.negativeDays.length}</span>{' '}
          {model.negativeDays.length === 1 ? 'day' : 'days'} in {model.monthLabel} project below
          zero:{' '}
          <span className="tnum">{model.negativeDays.map((d) => shortDay(d.date)).join(', ')}</span>.
        </div>
      )}

      {selectedCell && <DayDetail cell={selectedCell} todayIso={todayIso} onClose={() => setSelected(null)} />}
      </div>
      </div>

      {/* The month as a list, beside the series the list is derived from. */}
      <div className="dk-cols dk-cols--even">
      <div>
      {/* ---------------- the month, day by day ---------------- */}

      <div className="sect">{model.monthLabel} in order</div>
      {busyDays.length === 0 ? (
        <div className="sm muted" style={{ paddingBottom: 6 }}>
          {model.historyEmpty
            ? 'No transaction history in the last 180 days, so no cadence could be derived.'
            : 'Nothing due and nothing expected this month.'}
        </div>
      ) : (
        <div style={{ borderTop: '2px solid var(--ink)' }}>
          {busyDays.map((cell) => (
            <DayRow key={cell.date} cell={cell} todayIso={todayIso} />
          ))}
        </div>
      )}

      </div>

      <div>
      {/* ---------------- what the projection is built from ---------------- */}

      <div className="sect">Expected income and outgoings</div>
      <div className="sm muted" style={{ marginBottom: 8 }}>
        Derived from the last 180 days of transactions, keyed on the account, the
        statement descriptor and the direction of the money. Nothing here is typed in.
      </div>

      {model.projectedSeries.length === 0 ? (
        <div className="sm muted">No series regular enough to put a date on.</div>
      ) : (
        <div style={{ borderTop: '2px solid var(--ink)' }}>
          {model.projectedSeries.map((s) => (
            <SeriesRow key={s.key} s={s} />
          ))}
        </div>
      )}

      {model.overdueSeries.length > 0 && (
        <div className="banner banner--red sm" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            {model.overdueSeries.length === 1
              ? 'One series is late against its own cycle'
              : `${model.overdueSeries.length} series are late against their own cycles`}
          </div>
          {model.overdueSeries.map((s) => (
            <div key={s.key} className="tnum" style={{ marginTop: 2 }}>
              {s.direction === 'in' ? '▲' : '▼'} {s.label} — {moneyCents(s.medianAmount)}, last on{' '}
              {s.lastOn}, {s.daysSinceLast} days ago against a {Math.round(s.medianGap ?? 0)}-day cycle.
            </div>
          ))}
          {/* The asymmetry is stated, not hidden: each half is the choice that
              cannot make the position look better than it is. */}
          <div style={{ marginTop: 6 }}>
            Late money in is left out of the running balance. Late money out is still
            counted — it has not stopped being owed.
          </div>
        </div>
      )}

      <NotProjected model={model} />
      </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Panels
 * ------------------------------------------------------------------ */

function SeedLine({ model }: { model: ReturnType<typeof useCalendar> }) {
  return (
    <div className="card-panel" style={{ marginBottom: 12 }}>
      <div className="caps">Projected from</div>
      <div className="tnum" style={{ fontSize: 22, fontWeight: 700, margin: '2px 0 4px' }}>
        {moneyCents(model.seedTotal)}
      </div>
      <div className="tiny muted">
        <span className="tnum">{model.seedAccounts.length}</span> household checking{' '}
        {model.seedAccounts.length === 1 ? 'account' : 'accounts'}
        {model.seedAsOf ? <> as of <span className="tnum">{model.seedAsOf}</span></> : ', date unknown'}
        {/* PayPal is stored with kind `checking` but is a wallet, not a bank
            account, and nothing on this grid can be paid out of it. It is left
            out of the total and said so here rather than only in a comment. */}
        . The PayPal wallet is not counted as spendable cash.
      </div>

      <div style={{ marginTop: 8 }}>
        {model.seedAccounts.map((a) => (
          <div key={a.label} className="tiny" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span className="muted">{a.label}</span>
            <span className="tnum">{moneyCents(a.balance)}</span>
          </div>
        ))}
      </div>

      {model.seedAsOfDisagrees && (
        <div className="tiny" style={{ color: 'var(--red-tx)', marginTop: 8 }}>
          These balances were not all read on the same day, so the total mixes
          snapshots taken at different times.
        </div>
      )}

      {model.actualsApplied > 0 && (
        <div className="tiny muted" style={{ marginTop: 6 }}>
          <span className="tnum">{model.actualsApplied}</span> settled transactions posted after that
          snapshot have been applied on top of it. Pending rows are skipped — most issuers already
          include them in the balance.
        </div>
      )}
    </div>
  )
}

/** The fact this page was built to state. Red, because it is a deviation. */
function ShortfallLine({ model }: { model: ReturnType<typeof useCalendar> }) {
  if (model.firstNegative) {
    const { date, balance, nextInflowOn } = model.firstNegative
    return (
      <div className="banner banner--red sm" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 700 }}>
          Projected below zero on <span className="tnum">{shortDay(date)}</span>
        </div>
        <div className="tnum">
          {moneyCents(balance)} across household checking.
        </div>
        <div style={{ marginTop: 2 }}>
          {nextInflowOn ? (
            <>
              Next expected money in: <span className="tnum">{shortDay(nextInflowOn)}</span>.
            </>
          ) : (
            'No further money in is expected inside the projected window.'
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="sm muted" style={{ marginBottom: 12 }}>
      No day in the next three months projects below zero on what is counted here:
      scheduled debt payments, and income and outgoings whose cadence is derivable
      from history. Day-to-day variable spending is not counted, because there is
      no figure for it that would not be invented.
    </div>
  )
}

function MonthTotals({ model }: { model: ReturnType<typeof useCalendar> }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 10,
        marginTop: 12,
      }}
    >
      {[
        { k: 'Payments due', v: model.monthDue },
        { k: 'Expected in', v: model.monthIn },
        { k: 'Expected out', v: model.monthOut },
      ].map(({ k, v }) => (
        <div key={k}>
          <div className="caps">{k}</div>
          <div className="tnum sm" style={{ fontWeight: 700 }}>
            {money(v)}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Days
 * ------------------------------------------------------------------ */

function DayDetail({
  cell,
  todayIso,
  onClose,
}: {
  cell: DayCell
  todayIso: string
  onClose: () => void
}) {
  return (
    <div className="card-panel" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div className="sm tnum" style={{ fontWeight: 700 }}>
          {dayHeading(cell.date, parseDateOnly(todayIso))}
        </div>
        <button type="button" className="pill" style={{ background: 'var(--neutral-bg)', color: 'var(--neutral-tx)' }} onClick={onClose}>
          Close
        </button>
      </div>

      {cell.due.length === 0 && cell.expected.length === 0 && (
        <div className="sm muted" style={{ marginTop: 6 }}>
          Nothing due and nothing expected.
        </div>
      )}

      <DayLines cell={cell} />

      {cell.projected !== null && (
        <div
          className="tnum sm"
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: '1px solid var(--line)',
            fontWeight: 700,
            color: cell.negative ? 'var(--red-tx)' : 'var(--ink)',
          }}
        >
          {moneyCents(cell.projected)}
          <span className="tiny muted" style={{ fontWeight: 400 }}> projected, end of day</span>
        </div>
      )}
    </div>
  )
}

function DayRow({ cell, todayIso }: { cell: DayCell; todayIso: string }) {
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div style={{ width: 62, flex: '0 0 auto' }}>
        <div className="tiny caps tnum" style={{ color: cell.date === todayIso ? 'var(--ink)' : 'var(--steel)' }}>
          {shortDay(cell.date)}
        </div>
        {cell.projected !== null && (
          <div
            className="tiny tnum"
            style={{ color: cell.negative ? 'var(--red-tx)' : 'var(--steel)', fontWeight: cell.negative ? 700 : 400 }}
          >
            {money(cell.projected)}
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <DayLines cell={cell} />
      </div>
    </div>
  )
}

function DayLines({ cell }: { cell: DayCell }) {
  return (
    <>
      {cell.due.map((p, i) => (
        <DueLine key={`${p.accountId}-${i}`} p={p} />
      ))}
      {cell.expected.map((f, i) => (
        <FlowLine key={`${f.seriesKey}-${i}`} f={f} />
      ))}
    </>
  )
}

function DueLine({ p }: { p: DuePayment }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 3 }}>
      <div style={{ minWidth: 0 }}>
        <div className="sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.label}
        </div>
        <div className="tiny muted">
          {p.source === 'schedule'
            ? 'payment schedule'
            : p.source === 'issuer'
              ? 'due date from the issuer'
              : 'due day on record'}
          {p.rolledForward && ' · rolled on a month, the stated cycle is already paid'}
        </div>
      </div>
      <div className="sm tnum" style={{ whiteSpace: 'nowrap', color: 'var(--steel)' }}>
        {p.amount === null ? (
          // "Nothing known" must never read as "nothing due".
          <span className="tiny">amount unknown</span>
        ) : (
          signedAmount(-p.amount)
        )}
      </div>
    </div>
  )
}

function FlowLine({ f }: { f: ExpectedFlow }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 3 }}>
      <div style={{ minWidth: 0 }}>
        <div className="sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {f.label}
        </div>
        <div className="tiny muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {f.accountLabel}
          {!f.inBalance && ' · outside the checking total'}
          {f.overdue && (f.direction === 'in' ? ' · late, not counted' : ' · late, still counted')}
        </div>
      </div>
      <div
        className="sm tnum"
        style={{
          whiteSpace: 'nowrap',
          color: f.overdue ? 'var(--red-tx)' : f.direction === 'in' ? 'var(--ink)' : 'var(--steel)',
          opacity: f.inBalance ? 1 : 0.6,
        }}
      >
        {signedAmount(f.direction === 'in' ? f.amount : -f.amount)}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Series
 * ------------------------------------------------------------------ */

function SeriesRow({ s }: { s: Series }) {
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {s.label}
        </div>
        <div className="tiny muted tnum">
          {s.direction === 'in' ? 'in' : 'out'} · {cadenceLabel(s)} · {s.events.length} observed
          {s.missedCycles > 0 && ` · ${s.missedCycles} cycle${s.missedCycles === 1 ? '' : 's'} missed`}
        </div>
      </div>
      <div style={{ textAlign: 'right', flex: '0 0 auto' }}>
        <div className="sm tnum" style={{ color: s.direction === 'in' ? 'var(--ink)' : 'var(--steel)' }}>
          {signedAmount(s.direction === 'in' ? s.medianAmount : -s.medianAmount)}
        </div>
        <div className="tiny tnum" style={{ color: s.overdue ? 'var(--red-tx)' : 'var(--steel)' }}>
          {s.overdue ? `${s.daysSinceLast} days late` : `next ${s.nextOn}`}
        </div>
      </div>
    </div>
  )
}

/**
 * What the projection deliberately leaves out.
 *
 * Every one of these is a thing a reader would otherwise assume was counted. A
 * series that vanishes without explanation is indistinguishable from a bug, and
 * the one that matters most — the business draw into the household account, 27
 * deposit days in 180 with gaps of 1 to 18 — is precisely the one that would look
 * like money if it were projected at its median gap.
 */
function NotProjected({ model }: { model: ReturnType<typeof useCalendar> }) {
  const { irregularSeries, suppressedSeries, unknownDue } = model
  if (irregularSeries.length === 0 && suppressedSeries.length === 0 && unknownDue.length === 0) return null

  return (
    <>
      <div className="sect">Not counted in the projection</div>

      {unknownDue.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div className="caps" style={{ marginBottom: 4 }}>
            Due date not known
          </div>
          {unknownDue.map((u) => (
            <div key={u.accountId} className="sm">
              {u.label}
              <span className="tiny muted"> — no schedule, no issuer date, no due day on record</span>
            </div>
          ))}
        </div>
      )}

      {suppressedSeries.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div className="caps" style={{ marginBottom: 4 }}>
            Already counted as a payment due
          </div>
          {suppressedSeries.map((s) => (
            <div key={s.key} className="sm">
              {s.label}
              <span className="tiny muted tnum">
                {' '}
                — {cadenceLabel(s)}, {moneyCents(s.medianAmount)}, matched to a tracked debt
              </span>
            </div>
          ))}
        </div>
      )}

      {irregularSeries.length > 0 && (
        <div>
          <div className="caps" style={{ marginBottom: 4 }}>
            No regular pattern
          </div>
          <div className="tiny muted" style={{ marginBottom: 6 }}>
            Seen often enough to name, not evenly enough to date. Showing the{' '}
            <span className="tnum">{Math.min(8, irregularSeries.length)}</span> largest of{' '}
            <span className="tnum">{irregularSeries.length}</span>.
          </div>
          {irregularSeries.slice(0, 8).map((s) => (
            <div key={s.key} className="sm" style={{ marginTop: 2 }}>
              <span style={{ display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
                {s.label}
              </span>
              <div className="tiny muted tnum">
                {s.direction === 'in' ? 'in' : 'out'} · {s.events.length} in 180 days ·{' '}
                {moneyCents(s.medianAmount)} typical · {s.note}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
