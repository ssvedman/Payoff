import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { isoDate } from '../lib/format'
import type { Asset } from '../lib/data'
import type { AssetRow } from '../lib/database.types'

/**
 * Change what a vehicle is reckoned to be worth.
 *
 * A valuation goes stale on its own — mileage accrues whether or not anybody
 * updates the row — so this is the one field on an asset that has to be editable
 * from the screen that reports it. Structured exactly like EditTerms on this
 * page: a disclosure that seeds itself on open, saves once, and says what went
 * wrong in place rather than throwing the row away.
 *
 * The date is written WITH the figure, never separately. A number somebody
 * refreshed today wearing a valuation date from March is worse than a stale
 * number honestly dated, because the date column is the only thing telling a
 * reader how much to trust the figure beside it.
 */
export default function EditAsset({
  asset,
  onSaved,
}: {
  asset: Asset
  onSaved: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Re-seed from the asset each time it opens, so the field shows what is
  // currently on record rather than whatever was typed and abandoned last time.
  // Number.isFinite, not a truthiness test: a vehicle written down to 0.00 is a
  // real figure on record, and `0 ? … : ''` opened the field blank on it — so
  // saving without retyping would have looked like a no-op while actually
  // refusing to save, and the only way to see the stored 0 was to close again.
  useEffect(() => {
    if (!open) return
    setValue(Number.isFinite(asset.estimated_value) ? String(asset.estimated_value) : '')
    setErr(null)
  }, [open, asset.estimated_value])

  /** Accepts "31000", "$31,000.00", " 31000 ". Null when it is not a number of dollars. */
  const num = (v: string) => {
    const cleaned = v.replace(/[$,\s]/g, '')
    if (cleaned === '') return null
    const n = Number(cleaned)
    if (!Number.isFinite(n) || n < 0) return null
    return Math.round(n * 100) / 100
  }

  const parsed = num(value)

  async function save() {
    if (parsed === null) {
      setErr('That is not a number of dollars.')
      return
    }

    setBusy(true)
    setErr(null)

    // Both columns in ONE update. Two writes could leave the figure changed and
    // the date not, which is the exact state the date column exists to prevent.
    // A plain update with a partial row needs no cast — only insert and upsert
    // resolve to `never` under the current supabase-js typings (see
    // recategorize.ts, and the upsert in Accounts' save()).
    const patch: Partial<AssetRow> = {
      estimated_value: parsed,
      valued_on: isoDate(new Date()),
    }
    const { error } = await supabase.from('assets').update(patch).eq('id', asset.id)

    setBusy(false)
    if (error) {
      setErr(error.message)
      return
    }
    setOpen(false)
    await onSaved()
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="tiny muted"
        aria-label={`Edit the estimated value of the ${asset.name}`}
        style={{
          background: 'none',
          border: 'none',
          padding: '2px 0 0',
          font: 'inherit',
          cursor: 'pointer',
          textDecoration: 'underline',
        }}
      >
        value
      </button>
    )
  }

  const field = { width: '100%', padding: 8, fontSize: 13, marginTop: 3 } as const

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
      <label className="tiny muted" style={{ display: 'block' }}>
        Estimated value
        <input
          style={field}
          className="tnum"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0.00"
        />
      </label>

      <div className="tiny muted" style={{ marginTop: 6, lineHeight: 1.45 }}>
        Saving stamps it with today's date. Equity is this figure less whatever is
        still owed on the loan it secures.
      </div>

      {err && (
        <div className="tiny" style={{ color: 'var(--red)', marginTop: 6 }}>
          {err}
        </div>
      )}

      <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
        <button className="btn" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save value'}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}
