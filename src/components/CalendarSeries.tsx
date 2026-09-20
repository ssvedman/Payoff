import { useState } from 'react'
import { cadenceLabel, type Series } from '../lib/cadence'
import { signedAmount } from '../lib/format'
import { ordinalDay } from './CalendarText'

/**
 * What the projection is built from, and the controls for correcting it.
 *
 * Desktop gets a real table — the four things worth comparing down a column are
 * the cadence, the next date, the amount and whether the series is late, and a
 * column of stacked sub-lines makes none of those comparable. A phone gets rows
 * with the amount flush right and the same facts folded into a sub-line.
 *
 * Both render from the same pieces, so the two views cannot drift into saying
 * different things about one series.
 */

interface Props {
  series: Series[]
  wide: boolean
  /** The key mid-write, so its controls can be disabled without freezing the page. */
  busyKey: string | null
  onDismiss: (s: Series) => void
  onSetDay: (s: Series, day: number) => void
  accountName: (id: string) => string
}

export default function CalendarSeries(props: Props) {
  const { series, wide } = props
  if (series.length === 0) {
    return <div className="sm muted">No series regular enough to put a date on.</div>
  }

  if (wide) {
    return (
      <table className="tbl">
        <thead>
          <tr>
            <th scope="col">Series</th>
            <th scope="col">Cadence</th>
            <th scope="col">Next</th>
            <th scope="col" className="num">
              Typical
            </th>
          </tr>
        </thead>
        <tbody>
          {series.map((s) => (
            <SeriesRow key={s.key} {...props} s={s} wide />
          ))}
        </tbody>
      </table>
    )
  }

  return (
    <div>
      {series.map((s) => (
        <SeriesRow key={s.key} {...props} s={s} wide={false} />
      ))}
    </div>
  )
}

function SeriesRow({
  s,
  wide,
  busyKey,
  onDismiss,
  onSetDay,
  accountName,
}: Props & { s: Series; wide: boolean }) {
  const busy = busyKey === s.key

  // A hand-marked series has no observations to report, and saying "0 observed"
  // next to a confident date would read as a measurement that came back empty.
  const marked = s.events.length === 0

  const meta = (
    <>
      <div className="tiny muted tnum">
        {s.direction === 'in' ? 'in' : 'out'}
        {!wide && ` · ${cadenceLabel(s)}`}
        {marked ? ' · marked by hand, not yet observed' : ` · ${s.events.length} observed`}
        {s.missedCycles > 0 && ` · ${s.missedCycles} cycle${s.missedCycles === 1 ? '' : 's'} missed`}
      </div>
      {/* This route went quiet, but the same budget line was paid another way
          since. Said out loud rather than silently folded together, because
          the two really are separate movements of money. */}
      {s.paidElsewhere && (
        <div className="tiny tnum is-good">
          paid {s.paidElsewhere.daysAgo} days ago from {accountName(s.paidElsewhere.accountId)}
        </div>
      )}
      <Controls s={s} busy={busy} onDismiss={onDismiss} onSetDay={onSetDay} />
    </>
  )

  const amount = (
    <span className="tnum" style={{ color: s.direction === 'in' ? 'var(--ink)' : 'var(--steel)' }}>
      {signedAmount(s.direction === 'in' ? s.medianAmount : -s.medianAmount)}
    </span>
  )

  /**
   * Days LATE, not days since the last payment. Those differ by a whole cycle: a
   * monthly bill last paid 46 days ago is 16 days late, and printing the larger
   * figure made an overdue rent look like it had been missed twice over.
   */
  const next = (
    <span className={`tnum ${s.overdue ? 'is-bad' : ''}`} style={s.overdue ? undefined : { color: 'var(--steel)' }}>
      {s.overdue
        ? `${Math.max(1, Math.round(s.daysSinceLast - (s.medianGap ?? 0)))} days late`
        : // The desktop table has a "Next" column to say what this date is. The
          // mobile rows have no header, so the word carries itself there, or the
          // date reads as the date the series was last seen.
          wide
          ? s.nextOn
          : `next ${s.nextOn}`}
    </span>
  )

  if (wide) {
    return (
      <tr>
        <td>
          <div className="sm" style={{ fontWeight: 600 }}>
            {s.label}
          </div>
          {meta}
        </td>
        <td className="muted">{cadenceLabel(s)}</td>
        <td>{next}</td>
        <td className="num">{amount}</td>
      </tr>
    )
  }

  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="sm"
          style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {s.label}
        </div>
        {meta}
      </div>
      <div style={{ textAlign: 'right', flex: '0 0 auto' }}>
        <div className="sm">{amount}</div>
        <div className="tiny">{next}</div>
      </div>
    </div>
  )
}

const linkButton = (busy: boolean): React.CSSProperties => ({
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  color: 'inherit',
  textDecoration: 'underline',
  cursor: busy ? 'default' : 'pointer',
  opacity: busy ? 0.5 : 1,
})

function Controls({
  s,
  busy,
  onDismiss,
  onSetDay,
}: {
  s: Series
  busy: boolean
  onDismiss: (s: Series) => void
  onSetDay: (s: Series, day: number) => void
}) {
  const [editingDay, setEditingDay] = useState(false)
  const [dayText, setDayText] = useState(String(s.statedDay ?? s.dayOfMonth ?? 1))

  return (
    <div className="tiny muted" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 3 }}>
      {/* The observed day is when the money POSTED, which for a bill paid on the
          1st is several days later. Only the person paying it knows the due
          date, so it can be stated — and it is labelled as stated. */}
      {s.kind === 'monthly' &&
        (editingDay ? (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            due on the
            <input
              inputMode="numeric"
              value={dayText}
              onChange={(e) => setDayText(e.target.value)}
              className="tnum"
              aria-label={`Day of the month ${s.label} is due`}
              style={{
                font: 'inherit',
                width: 44,
                padding: '2px 5px',
                border: '1px solid var(--line)',
                borderRadius: 'var(--r-control)',
                background: 'var(--white)',
                color: 'var(--ink)',
              }}
            />
            <button
              type="button"
              onClick={() => {
                const n = Number(dayText)
                if (Number.isInteger(n) && n >= 1 && n <= 31) {
                  onSetDay(s, n)
                  setEditingDay(false)
                }
              }}
              disabled={busy}
              style={linkButton(busy)}
            >
              save
            </button>
            <button type="button" onClick={() => setEditingDay(false)} style={linkButton(false)}>
              cancel
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => setEditingDay(true)} style={linkButton(false)}>
            {s.statedDay ? `due on the ${ordinalDay(s.statedDay)} (entered)` : 'set the day it is due'}
          </button>
        ))}

      {/* Dismissing records the last date seen, so a charge taken after it is
          reported rather than silently suppressed. Said here, once, because
          "no longer active" otherwise sounds like it means "hide this". */}
      <button
        type="button"
        onClick={() => onDismiss(s)}
        disabled={busy}
        style={linkButton(busy)}
        aria-label={`Mark ${s.label} as no longer active`}
      >
        {busy ? 'saving…' : 'no longer active'}
      </button>
    </div>
  )
}
