import { useCallback, useEffect, useMemo, useState } from 'react'
import CalendarFortnight from '../components/CalendarFortnight'
import CalendarNav from '../components/CalendarNav'
import CalendarSeries from '../components/CalendarSeries'
import { eventsOf, lowestOf, ordinalDay, shortDay } from '../components/CalendarText'
import MonthGrid from '../components/MonthGrid'
import { useCalendar, useCalendarMonth, type DayCell } from '../lib/calendar'
import { cadenceLabel } from '../lib/cadence'
import { dayHeading, isoDate, money, moneyCents, parseDateOnly } from '../lib/format'
import { useRecurringOverrides } from '../lib/recurring'
import { useData, usePayoffPlan } from '../lib/data'
import type { Series } from '../lib/cadence'

/**
 * /calendar — when money moves, and where household checking is projected to sit
 * on each day of it.
 *
 * WHY this page exists, written down so nobody softens it later: the checking
 * accounts repeatedly ran to single digits and the toll accounts went negative,
 * which cost real money in pay-by-plate rates and violation fees before anyone
 * noticed. So the page names every day the projection falls below zero and the
 * day it sits lowest, and says only that. It does not suggest moving money, it
 * does not encourage, and it does not congratulate. A report of the position is
 * the whole product.
 *
 * Equally important is what it refuses to claim. The projection counts scheduled
 * debt payments and income whose cadence is actually derivable from six months of
 * history. It does NOT count day-to-day variable spending, because there is no
 * honest figure for that — and a page that quietly assumed groceries were zero
 * would be reassuring and wrong, which on this particular screen is the most
 * expensive thing it could be. That limitation is printed on the page rather than
 * buried here.
 *
 * The layout splits at 1024px into two different views of the same month: a
 * seven-column grid on a desktop, a fortnight list on a phone. See useWideScreen.
 */

/**
 * Whether the desktop layout is on, read from the same 1024px breakpoint
 * index.css uses.
 *
 * A JS media query rather than a CSS one, because the rule on this page is not
 * "hide the grid on a phone" but "do not build it at all". A display:none grid is
 * still thirty-five cells of DOM for a screen reader to walk, and the two layouts
 * are genuinely different content — the grid carries the shape of the month, the
 * list carries the next fourteen days in full — rather than one layout at two
 * sizes.
 */
function useWideScreen(): boolean {
  const query = '(min-width: 1024px)'
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )

  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches)
    // Read once on mount as well: the width can have changed between the initial
    // state being computed and the listener being attached.
    setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return wide
}

export default function Calendar() {
  const wide = useWideScreen()
  const month = useCalendarMonth()
  const model = useCalendar(month.anchor)
  const [selected, setSelected] = useState<string | null>(null)

  /** Which row is mid-write, so its control can be disabled without freezing the page. */
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [overrideError, setOverrideError] = useState<string | null>(null)

  const { dismiss, remove, confirm } = useRecurringOverrides()
  const { accounts } = useData()

  /**
   * The account the avalanche is currently attacking.
   *
   * This is the only thing on the page allowed to be amber. usePayoffPlan()
   * returns null until the plan row lands, so the grid simply has no amber day
   * for a moment rather than guessing at one.
   */
  const plan = usePayoffPlan()
  const targetId = plan?.target?.id ?? null

  /** Account id to its display name, for saying where a payment actually went. */
  const accountName = useCallback(
    (id: string) => accounts.find((a) => a.id === id)?.name ?? 'another account',
    [accounts],
  )

  const todayIso = isoDate(new Date())

  /**
   * Mark a series as no longer active.
   *
   * `lastOn` is the boundary: anything charged after it is the charge somebody
   * believed they had stopped, and the page reports it rather than hiding it.
   */
  const dismissSeries = useCallback(
    async (s: Series) => {
      setBusyKey(s.key)
      setOverrideError(null)
      const err = await dismiss({
        seriesKey: s.key,
        accountId: s.accountId || null,
        descriptor: s.descriptor,
        label: s.label,
        direction: s.direction,
        lastOn: s.lastOn,
      })
      if (err) setOverrideError(err)
      else await model.refreshOverrides()
      setBusyKey(null)
    },
    [dismiss, model],
  )

  /**
   * Record the day a monthly obligation actually falls due.
   *
   * Stored as a 'confirm' override against the series key, which is stable: a
   * merged obligation is keyed on its budget line, not on whichever account
   * happened to pay it last.
   */
  const setSeriesDay = useCallback(
    async (s: Series, day: number) => {
      setBusyKey(s.key)
      setOverrideError(null)
      const today = new Date()
      const anchor = isoDate(new Date(today.getFullYear(), today.getMonth(), day))
      const err = await confirm({
        seriesKey: s.key,
        accountId: s.accountId || null,
        descriptor: s.descriptor,
        label: s.label,
        direction: s.direction,
        cadence: 'monthly',
        expectedAmount: s.medianAmount,
        anchorOn: anchor,
      })
      if (err) setOverrideError(err)
      else await model.refreshOverrides()
      setBusyKey(null)
    },
    [confirm, model],
  )

  /** Undo a dismissal — put the series back on the grid as if never dismissed. */
  const restoreSeries = useCallback(
    async (seriesKey: string) => {
      setBusyKey(seriesKey)
      setOverrideError(null)
      const err = await remove(seriesKey)
      if (err) setOverrideError(err)
      else await model.refreshOverrides()
      setBusyKey(null)
    },
    [remove, model],
  )

  const cells = useMemo(() => model.weeks.flat(), [model.weeks])
  const monthCells = useMemo(() => cells.filter((c) => c.inMonth), [cells])

  /**
   * The day the line comes closest to the floor.
   *
   * Not the same thing as the first day below zero, which the model already
   * reports across the whole three-month horizon. This is the tightest day of
   * the month ON SCREEN, which is what the header line and the grid's red cell
   * both name, and it exists whether or not anything goes negative.
   */
  const lowest = useMemo(() => lowestOf(monthCells), [monthCells])

  const selectedCell = useMemo(
    () => (selected ? cells.find((c) => c.date === selected) ?? null : null),
    [cells, selected],
  )

  if (model.loading) {
    return (
      <main className="page">
        <h1 className="ph">Calendar</h1>
        <div className="skeleton" style={{ width: '100%', height: 30, margin: '14px 0' }} aria-hidden="true" />
        <div
          className="skeleton"
          style={{ width: '100%', height: wide ? 380 : 260 }}
          aria-label="Loading the calendar"
        />
      </main>
    )
  }

  if (model.error) {
    return (
      <main className="page">
        <h1 className="ph">Calendar</h1>
        {/* A failed read is not an empty month. Saying "nothing due" here would
            be a statement of fact that nobody has checked. */}
        <div className="banner banner--red sm" style={{ marginTop: 14 }}>
          Could not load the calendar: {model.error}
        </div>
      </main>
    )
  }

  return (
    <main className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h1 className="ph">
          {wide ? model.monthLabel : model.monthLabel.split(' ')[0]}
          {/* A month ahead of this one has no settled figures in it at all, and
              a grid of dates looks the same whether it has happened or not. The
              old stepper carried this word under the month name; it has to stay
              somewhere now that the month name is the page title. */}
          {!month.thisMonth && (
            <span className="tiny muted" style={{ fontWeight: 500, marginLeft: 8 }}>
              projected
            </span>
          )}
        </h1>
        <CalendarNav month={month} wide={wide} />
      </div>

      {wide ? (
        <>
          <HeaderLine model={model} lowest={lowest} />

          <MonthGrid
            cells={cells}
            targetId={targetId}
            lowestDate={lowest?.date ?? null}
            selected={selected}
            onSelect={(d) => setSelected((cur) => (cur === d ? null : d))}
          />

          <GridRule model={model} />

          {selectedCell && (
            <DayDetail
              cell={selectedCell}
              targetId={targetId}
              todayIso={todayIso}
              onClose={() => setSelected(null)}
            />
          )}
        </>
      ) : (
        <div style={{ marginTop: 10 }}>
          <CalendarFortnight
            cells={cells}
            month={month}
            targetId={targetId}
            historyEmpty={model.historyEmpty}
            todayIso={todayIso}
          />
          <GridRule model={model} />
        </div>
      )}

      {/* ---------------- charges that came back ---------------- */}

      {/*
        The reason dismissing records a date rather than setting a flag.
        Somebody marked these as finished; they have been charged since. Red is
        right here — this IS a deviation, the one meaning red carries in this app.
        Stated as fact, with the dates and the amount. What to do about it is not
        this page's business.
      */}
      {model.resurrected.length > 0 && (
        <div className="banner banner--red sm" style={{ marginTop: 18 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            {model.resurrected.length === 1
              ? 'One charge marked as finished has been taken again'
              : `${model.resurrected.length} charges marked as finished have been taken again`}
          </div>
          {model.resurrected.map((r) => (
            <div key={r.series.key} className="tnum" style={{ marginTop: 3 }}>
              {r.series.label} — marked finished on {r.override.dismissedAfter}, charged{' '}
              {r.chargedOn.length === 1 ? 'once' : `${r.chargedOn.length} times`} since (
              {r.chargedOn.join(', ')}), {moneyCents(r.total)} in total.
            </div>
          ))}
          <div style={{ marginTop: 6 }}>
            They are counted in the projection again, because the money is leaving
            the account whatever the instruction said.
          </div>
        </div>
      )}

      {/*
        Where the line starts, beside what it runs into.

        On a phone these stack, and the seed comes after the fortnight list
        rather than before it: the list's own callout already states the
        projected balance at its lowest point, so the reader is not looking at
        a countdown from an unstated figure the way they were when the grid led.
      */}
      <div className="g2" style={{ marginTop: 18 }}>
        <SeedPanel model={model} />
        <HorizonPanel model={model} />
      </div>

      {/* ---------------- what the projection is built from ---------------- */}

      <div className="sect">Expected income and outgoings</div>
      <div className="sm muted" style={{ marginBottom: 8 }}>
        Derived from the last 180 days of transactions, keyed on the account, the
        statement descriptor and the direction of the money. A row marked by hand
        says so on its own line.
      </div>

      <CalendarSeries
        series={model.projectedSeries}
        wide={wide}
        busyKey={busyKey}
        onDismiss={dismissSeries}
        onSetDay={setSeriesDay}
        accountName={accountName}
      />

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

      {/* ---------------- dismissed ---------------- */}

      {/*
        Listed, never just gone. A dismissal is a claim that something stopped,
        and a claim nobody can see again is a claim nobody can check. Each row
        says the date it was dismissed after, which is the same date a later
        charge is measured against.
      */}
      {model.dismissedSeries.length > 0 && (
        <>
          <div className="sect">Marked as no longer active</div>
          <div className="sm muted" style={{ marginBottom: 8 }}>
            Left out of the projection. If any of them is charged again it returns
            to the list above and is reported at the top of this page.
          </div>
          <div>
            {model.dismissedSeries.map(({ series, override }) => (
              <div key={override.seriesKey} className="row" style={{ alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    className="sm"
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {override.label}
                  </div>
                  <div className="tiny muted tnum">
                    {override.direction === 'in' ? 'in' : 'out'} · nothing since{' '}
                    {override.dismissedAfter}
                    {series === null && ' · outside the 180-day window'}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flex: '0 0 auto' }}>
                  <button
                    type="button"
                    className="tiny muted"
                    onClick={() => void restoreSeries(override.seriesKey)}
                    disabled={busyKey === override.seriesKey}
                    style={{
                      appearance: 'none',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      font: 'inherit',
                      textDecoration: 'underline',
                      cursor: busyKey === override.seriesKey ? 'default' : 'pointer',
                      opacity: busyKey === override.seriesKey ? 0.5 : 1,
                    }}
                    aria-label={`Put ${override.label} back on the calendar`}
                  >
                    {busyKey === override.seriesKey ? 'saving…' : 'put back'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {overrideError && (
        <div className="banner banner--red tiny" style={{ marginTop: 10 }}>
          {overrideError}
        </div>
      )}

      <NotProjected model={model} wide={wide} />
    </main>
  )
}

/* ------------------------------------------------------------------ *
 * The header line
 * ------------------------------------------------------------------ */

/**
 * "$7,341 out · $9,062 in · lowest projected balance $38 on the 14th".
 *
 * The two money figures are the month's, not the fortnight's, and "out" adds
 * scheduled debt payments to detected recurring outgoings. Those two cannot
 * double-count: the model already suppresses any detected outflow it can match
 * to a tracked debt, which is the whole reason suppressedSeries exists.
 */
function HeaderLine({
  model,
  lowest,
}: {
  model: ReturnType<typeof useCalendar>
  lowest: DayCell | null
}) {
  const out = model.monthDue + model.monthOut

  return (
    <div className="sm muted" style={{ margin: '4px 0 13px' }}>
      <span className="tnum">{money(out)}</span> out · <span className="tnum">{money(model.monthIn)}</span>{' '}
      in
      {lowest !== null && (
        <>
          {' · '}
          lowest projected balance{' '}
          {/* Red only below zero. A tight month is worth stating in bold, but
              bold ink says "find this" where red would say "this went wrong",
              and a positive floor means the plan was kept. */}
          <b
            className="tnum"
            style={{
              color: (lowest.projected as number) < 0 ? 'var(--red-tx)' : 'var(--ink)',
            }}
          >
            {money(lowest.projected as number)} on the {ordinalDay(parseDateOnly(lowest.date).getDate())}
          </b>
        </>
      )}
    </div>
  )
}

/**
 * The caveats, as a quiet rule rather than a grey block.
 *
 * All three of these are things a reader would otherwise assume the grid had
 * counted, and the last one is the one that matters: a projection that silently
 * treated variable spending as zero would be reassuring and wrong.
 */
function GridRule({ model }: { model: ReturnType<typeof useCalendar> }) {
  return (
    <div className="rule">
      Income cadence is taken from the last 180 days of transactions, so a stream
      that has no regular pattern is listed below rather than dated here. The
      projected balance runs across household checking only — savings and the
      PayPal wallet appear on the grid but are not counted in it, and neither is
      any business account. Day-to-day variable spending is not counted at all,
      because there is no figure for it that would not be invented.
      {model.monthDue > 0 && (
        <>
          {' '}
          Of the money out this month, <span className="tnum">{money(model.monthDue)}</span> is
          scheduled debt payments and <span className="tnum">{money(model.monthOut)}</span> is
          recurring outgoings.
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Panels
 * ------------------------------------------------------------------ */

/** What the running balance counts down from. */
function SeedPanel({ model }: { model: ReturnType<typeof useCalendar> }) {
  return (
    <div className="box">
      <div className="caps">Projected from</div>
      <div className="tnum" style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-.02em', margin: '2px 0 6px' }}>
        {moneyCents(model.seedTotal)}
      </div>

      <table className="tbl">
        <tbody>
          {model.seedAccounts.map((a) => (
            <tr key={a.label}>
              <td className="muted">{a.label}</td>
              <td className="num">{moneyCents(a.balance)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="rule">
        <span className="tnum">{model.seedAccounts.length}</span> household checking{' '}
        {model.seedAccounts.length === 1 ? 'account' : 'accounts'}
        {model.seedAsOf ? (
          <>
            {' '}
            as of <span className="tnum">{model.seedAsOf}</span>
          </>
        ) : (
          ', date unknown'
        )}
        {/* PayPal is stored with kind `checking` but is a wallet, not a bank
            account, and nothing on this grid can be paid out of it. It is left
            out of the total and said so here rather than only in a comment. */}
        . The PayPal wallet is not counted as spendable cash.
        {model.actualsApplied > 0 && (
          <>
            {' '}
            <span className="tnum">{model.actualsApplied}</span> settled transactions posted after
            that snapshot have been applied on top of it. Pending rows are skipped — most issuers
            already include them in the balance.
          </>
        )}
      </div>

      {model.seedAsOfDisagrees && (
        <div className="tiny is-bad" style={{ marginTop: 8 }}>
          These balances were not all read on the same day, so the total mixes
          snapshots taken at different times.
        </div>
      )}
    </div>
  )
}

/**
 * The whole three-month horizon, as distinct from the month on screen.
 *
 * The header line names the tightest day of the month being looked at. This
 * names the first day ANYWHERE in the projection that falls below zero, which
 * may be two months away — so stepping through months does not require
 * remembering what an earlier month said.
 */
function HorizonPanel({ model }: { model: ReturnType<typeof useCalendar> }) {
  if (model.firstNegative) {
    const { date, balance, nextInflowOn } = model.firstNegative
    return (
      <div className="banner banner--red sm">
        <div style={{ fontWeight: 700 }}>
          Projected below zero on <span className="tnum">{shortDay(date)}</span>
        </div>
        <div className="tnum">{moneyCents(balance)} across household checking.</div>
        <div style={{ marginTop: 2 }}>
          {nextInflowOn ? (
            <>
              Next expected money in: <span className="tnum">{shortDay(nextInflowOn)}</span>.
            </>
          ) : (
            'No further money in is expected inside the projected window.'
          )}
        </div>
        {model.negativeDays.length > 0 && (
          <div className="tnum" style={{ marginTop: 6, fontWeight: 700 }}>
            {model.negativeDays.length} {model.negativeDays.length === 1 ? 'day' : 'days'} in{' '}
            {model.monthLabel} project below zero:{' '}
            {model.negativeDays.map((d) => shortDay(d.date)).join(', ')}.
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="box">
      <div className="caps">Next three months</div>
      <div className="sm" style={{ marginTop: 4 }}>
        No day projects below zero on what is counted here.
      </div>
      <div className="rule">
        Counted: scheduled debt payments, and income and outgoings whose cadence is
        derivable from history. Not counted: day-to-day variable spending.
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Days
 * ------------------------------------------------------------------ */

/** One day opened out, beneath the grid. Desktop only — the list is already this. */
function DayDetail({
  cell,
  targetId,
  todayIso,
  onClose,
}: {
  cell: DayCell
  targetId: string | null
  todayIso: string
  onClose: () => void
}) {
  const events = eventsOf(cell, targetId)

  return (
    <div className="box" style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div className="sm tnum" style={{ fontWeight: 700 }}>
          {dayHeading(cell.date, parseDateOnly(todayIso))}
        </div>
        <button
          type="button"
          className="pill"
          style={{ background: 'var(--neutral-bg)', color: 'var(--neutral-tx)' }}
          onClick={onClose}
        >
          Close
        </button>
      </div>

      {events.length === 0 ? (
        <div className="sm muted" style={{ marginTop: 6 }}>
          Nothing due and nothing expected.
        </div>
      ) : (
        <table className="tbl" style={{ marginTop: 6 }}>
          <tbody>
            {events.map((e) => (
              <tr key={e.key}>
                <td>
                  <div
                    className="sm"
                    style={{
                      fontWeight: e.isTarget ? 700 : 400,
                      color: e.isTarget ? 'var(--amber-tx)' : undefined,
                    }}
                  >
                    {e.label}
                  </div>
                  {/* Both, where both apply. Where a due date came FROM is a
                      provenance claim this app never drops, and the target flag
                      must not be the thing that quietly swallows it. The
                      fortnight row has no width for the pair and says only
                      "current target", as the mockup draws it. */}
                  <div className="tiny muted">
                    {[e.isTarget ? 'current target' : null, e.note].filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td className="num">
                  {e.amount === null ? (
                    // "Nothing known" must never read as "nothing due".
                    <span className="tiny muted">amount unknown</span>
                  ) : (
                    <span
                      className={e.direction === 'in' ? 'is-good' : undefined}
                      style={{ fontWeight: e.direction === 'in' ? 700 : 400 }}
                    >
                      {e.direction === 'in' ? '+' : '−'}
                      {moneyCents(e.amount)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {cell.projected !== null && (
        <div
          className="tnum sm"
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: '1px solid var(--line)',
            fontWeight: 700,
            color: cell.negative ? 'var(--red-tx)' : 'var(--ink)',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span className="tiny muted" style={{ fontWeight: 400 }}>
            Projected, end of day
          </span>
          <span>{moneyCents(cell.projected)}</span>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Not counted
 * ------------------------------------------------------------------ */

/**
 * What the projection deliberately leaves out.
 *
 * Every one of these is a thing a reader would otherwise assume was counted. A
 * series that vanishes without explanation is indistinguishable from a bug, and
 * the one that matters most — the business draw into the household account, 27
 * deposit days in 180 with gaps of 1 to 18 — is precisely the one that would look
 * like money if it were projected at its median gap.
 */
function NotProjected({ model, wide }: { model: ReturnType<typeof useCalendar>; wide: boolean }) {
  const { irregularSeries, suppressedSeries, unknownDue } = model
  if (irregularSeries.length === 0 && suppressedSeries.length === 0 && unknownDue.length === 0) return null

  const shown = irregularSeries.slice(0, 8)

  return (
    <>
      <div className="sect">Not counted in the projection</div>

      {unknownDue.length > 0 && (
        <div style={{ marginBottom: 12 }}>
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
        <div style={{ marginBottom: 12 }}>
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
            <span className="tnum">{shown.length}</span> largest of{' '}
            <span className="tnum">{irregularSeries.length}</span>.
          </div>

          {wide ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">Series</th>
                  <th scope="col">Why it has no date</th>
                  <th scope="col" className="num">
                    Typical
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.key}>
                    <td>
                      {s.label}
                      <div className="tiny muted tnum">
                        {s.direction === 'in' ? 'in' : 'out'} · {s.events.length} in 180 days
                      </div>
                    </td>
                    <td className="muted">{s.note}</td>
                    <td className="num">{moneyCents(s.medianAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div>
              {shown.map((s) => (
                <div key={s.key} className="row" style={{ alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="sm"
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {s.label}
                    </div>
                    <div className="tiny muted tnum">
                      {s.direction === 'in' ? 'in' : 'out'} · {s.events.length} in 180 days · {s.note}
                    </div>
                  </div>
                  <div className="sm tnum" style={{ flex: '0 0 auto', textAlign: 'right' }}>
                    {moneyCents(s.medianAmount)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
