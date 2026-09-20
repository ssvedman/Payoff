import { useEffect, useMemo, useState } from 'react'
import { directionOf, seriesKeyFor } from '../lib/cadence'
import { useRecurringOverrides, type ConfirmCadence } from '../lib/recurring'
import { moneyCents } from '../lib/format'
import type { Transaction } from '../lib/data'

/**
 * Mark one transaction as the start of a recurring obligation.
 *
 * Cadence detection needs three observations before it will put a date on
 * anything, and it is right to: two points describe a gap, not a rhythm. But
 * that leaves a real hole — a loan whose first payment has just been taken has
 * exactly one observation, and it will be two more months before the calendar
 * admits it exists. Every projected balance in between is overstated by the
 * payment it does not know about.
 *
 * So this is an assertion, not a measurement, and it is labelled as one
 * everywhere it surfaces. Once enough history accumulates the detected series
 * replaces it, because measured beats asserted.
 *
 * The key is built by seriesKeyFor() — the same function detectSeries() uses. A
 * second copy of that rule would drift, and a drifted key marks a series that
 * detection never produces: confirmed, then never seen again.
 */

const CADENCES: { value: ConfirmCadence; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
]

export default function MarkRecurring({
  transaction,
  onDone,
}: {
  transaction: Transaction
  onDone: () => void | Promise<void>
}) {
  const { overrides, confirm, remove } = useRecurringOverrides()

  const seriesKey = useMemo(() => seriesKeyFor(transaction), [transaction])
  const existing = useMemo(
    () => (seriesKey ? overrides.find((o) => o.seriesKey === seriesKey) ?? null : null),
    [overrides, seriesKey],
  )

  const [cadence, setCadence] = useState<ConfirmCadence>('monthly')
  const [amount, setAmount] = useState(String(Math.abs(transaction.amount).toFixed(2)))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Re-seed from the row whenever a different transaction is opened, so a figure
  // typed and abandoned on one row never reappears on another.
  useEffect(() => {
    setCadence('monthly')
    setAmount(String(Math.abs(transaction.amount).toFixed(2)))
    setErr(null)
  }, [transaction.id, transaction.amount])

  // A descriptor that normalises to nothing cannot be keyed, so it cannot be
  // tracked. Say so rather than offering a control that quietly does nothing.
  if (!seriesKey) {
    return (
      <div className="tiny muted" style={{ marginTop: 10 }}>
        This row has no descriptor steady enough to follow, so it cannot be
        tracked as recurring.
      </div>
    )
  }

  const direction = directionOf(transaction.amount)

  async function save() {
    const n = Number(amount)
    if (!Number.isFinite(n) || n <= 0) {
      setErr('Enter the expected amount in dollars.')
      return
    }
    setBusy(true)
    setErr(null)
    const e = await confirm({
      seriesKey: seriesKey as string,
      accountId: transaction.account_id,
      descriptor: transaction.merchant_name?.trim().toLowerCase() || transaction.name,
      label: transaction.merchant_name?.trim() || transaction.name,
      direction,
      cadence,
      expectedAmount: n,
      anchorOn: transaction.posted_on,
    })
    setBusy(false)
    if (e) {
      setErr(e)
      return
    }
    await onDone()
  }

  async function clear() {
    setBusy(true)
    setErr(null)
    const e = await remove(seriesKey as string)
    setBusy(false)
    if (e) {
      setErr(e)
      return
    }
    await onDone()
  }

  if (existing?.action === 'confirm') {
    return (
      <div className="tiny" style={{ marginTop: 10 }}>
        <span className="muted">
          Tracked as {existing.cadence} {direction === 'in' ? 'income' : 'outgoing'} of{' '}
          <span className="tnum">{moneyCents(existing.expectedAmount ?? 0)}</span> from{' '}
          <span className="tnum">{existing.anchorOn}</span>.
        </span>{' '}
        <button type="button" className="tiny muted" onClick={() => void clear()} disabled={busy} style={linkBtn(busy)}>
          {busy ? 'saving…' : 'stop tracking'}
        </button>
        {err && <div style={{ color: 'var(--red-tx)', marginTop: 4 }}>{err}</div>}
      </div>
    )
  }

  if (existing?.action === 'dismiss') {
    return (
      <div className="tiny muted" style={{ marginTop: 10 }}>
        This series is marked as no longer active, so it is being watched for a
        return rather than projected. Undo that on the calendar.
      </div>
    )
  }

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
      <div className="tiny muted" style={{ marginBottom: 6 }}>
        Track this as a recurring {direction === 'in' ? 'payment in' : 'payment out'}. Use
        it for an obligation that has too little history to work out on its own —
        a loan whose first payment has only just been taken. It is marked as
        entered by hand, and gives way to the real pattern once there is one.
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="tiny muted" style={{ display: 'block' }}>
          How often
          <select
            value={cadence}
            onChange={(e) => setCadence(e.target.value as ConfirmCadence)}
            style={field}
            aria-label="How often"
          >
            {CADENCES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="tiny muted" style={{ display: 'block' }}>
          Expected amount
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={{ ...field, width: 104 }}
            className="tnum"
            aria-label="Expected amount"
          />
        </label>

        <button type="button" className="btn" onClick={() => void save()} disabled={busy} style={{ width: 'auto' }}>
          {busy ? 'Saving…' : 'Track it'}
        </button>
      </div>

      <div className="tiny muted" style={{ marginTop: 6 }}>
        Counted from <span className="tnum">{transaction.posted_on}</span>, this row&rsquo;s date.
      </div>

      {err && (
        <div className="tiny" style={{ color: 'var(--red-tx)', marginTop: 6 }}>
          {err}
        </div>
      )}
    </div>
  )
}

const field: React.CSSProperties = {
  display: 'block',
  marginTop: 3,
  font: 'inherit',
  padding: '5px 7px',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-control)',
  background: 'var(--white)',
  color: 'var(--ink)',
}

const linkBtn = (busy: boolean): React.CSSProperties => ({
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  textDecoration: 'underline',
  cursor: busy ? 'default' : 'pointer',
  opacity: busy ? 0.5 : 1,
})
