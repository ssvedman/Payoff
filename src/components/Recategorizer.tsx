import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useData, type Transaction } from '../lib/data'
import { recategorize, vendorKeyFor, type Scope } from '../lib/recategorize'
import type { Bucket } from '../lib/database.types'

/**
 * The editor for one transaction's label — buckets, budget line, and how widely
 * the choice should apply.
 *
 * One component, used by /activity and by an opened bucket on /month, because
 * this is the rule that decides where money is counted and it must not exist in
 * two places. Two other pieces of logic in this app were duplicated across files
 * and drifted apart; both reported wrong figures until the copies were found.
 */

export const BUCKETS: { key: Bucket; label: string; bg: string; tx: string }[] = [
  { key: 'fixed', label: 'Fixed', bg: 'var(--neutral-bg)', tx: 'var(--neutral-tx)' },
  { key: 'optional', label: 'Optional', bg: 'var(--amber-bg)', tx: 'var(--amber-tx)' },
  { key: 'attack', label: 'Attack', bg: 'var(--green-bg)', tx: 'var(--green-tx)' },
  { key: 'savings', label: 'Savings', bg: 'var(--green-bg)', tx: 'var(--green-tx)' },
  { key: 'income', label: 'Income', bg: 'var(--green-bg)', tx: 'var(--green-tx)' },
  { key: 'transfer', label: 'Transfer', bg: 'var(--neutral-bg)', tx: 'var(--neutral-tx)' },
  { key: 'review', label: 'Review', bg: 'var(--red-bg)', tx: 'var(--red-tx)' },
]

export const bucketStyle = (b: Bucket) => BUCKETS.find((x) => x.key === b) ?? BUCKETS[6]

export default function Recategorizer({
  transaction,
  loaded,
  onDone,
}: {
  transaction: Transaction
  /** Rows already on screen, so a vendor rule corrects them in the same call. */
  loaded: Transaction[]
  onDone: () => void | Promise<void>
}) {
  const { budgetLines } = useData()
  const { user } = useAuth()

  /**
   * How far the choice reaches.
   *
   * Applying to the vendor is the useful default — correcting one coffee shop
   * should teach every future one. But it is wrong often enough to be worth
   * asking: a payment processor bills for a dozen unrelated sellers under its
   * own name, and a shop can be used for both business and personal. Previously
   * every correction wrote a rule with no way to say "just this one".
   */
  const [scope, setScope] = useState<Scope>('vendor')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // A fresh row is a fresh decision; do not carry the last one's scope over.
  useEffect(() => {
    setScope('vendor')
    setErr(null)
  }, [transaction.id])

  const vendorKey = vendorKeyFor(transaction)
  const canRule = vendorKey.length > 0

  const linesFor = (b: Bucket) => budgetLines.filter((l) => l.bucket === b)

  async function apply(bucket: Bucket, lineId?: string | null) {
    setBusy(true)
    setErr(null)
    try {
      await recategorize({
        transaction,
        bucket,
        lineId,
        scope: canRule ? scope : 'once',
        userId: user?.id ?? null,
        loaded,
      })
      await onDone()
    } catch (e) {
      console.error('Recategorization failed', e)
      setErr('That label did not save.')
    } finally {
      setBusy(false)
    }
  }

  const scopeBtn = (v: Scope, label: string, hint: string) => (
    <button
      type="button"
      onClick={() => setScope(v)}
      disabled={busy}
      title={hint}
      style={{
        flex: 1,
        padding: '6px 8px',
        fontSize: 12,
        lineHeight: 1.3,
        borderRadius: 'var(--r-control)',
        border: `1px solid ${scope === v ? 'var(--ink)' : 'var(--line)'}`,
        background: scope === v ? 'var(--ink)' : '#fff',
        color: scope === v ? '#fff' : 'var(--steel)',
        fontFamily: 'inherit',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )

  return (
    <div>
      {/* Scope FIRST: it changes what the buttons below will do, so it has to be
          decided before they are pressed, not explained afterwards. */}
      {canRule && (
        <div style={{ marginBottom: 9 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {scopeBtn('once', 'Just this one', 'Applies to this transaction only')}
            {scopeBtn('vendor', 'Everything from this merchant', 'Writes a rule')}
          </div>
          <div className="tiny muted" style={{ marginTop: 4, lineHeight: 1.45 }}>
            {scope === 'vendor' ? (
              <>
                Matches <span className="tnum">“{vendorKey}”</span> — future charges land
                here too.
              </>
            ) : (
              'Nothing is learned. Use this when the same name covers unrelated things.'
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {BUCKETS.map((b) => (
          <button
            key={b.key}
            type="button"
            className="pill"
            disabled={busy}
            onClick={() =>
              // A line belongs to exactly one bucket, so a real bucket change
              // clears it. Re-tapping the bucket it is already in leaves the
              // line untouched — `undefined` means "leave alone", not "clear".
              void apply(b.key, b.key === transaction.bucket ? undefined : null)
            }
            style={{
              background: b.bg,
              color: b.tx,
              opacity: busy ? 0.5 : 1,
              boxShadow: transaction.bucket === b.key ? 'inset 0 0 0 1px var(--ink)' : undefined,
            }}
          >
            {b.label}
          </button>
        ))}
      </div>

      {/* Which target it counts against. Only fixed and optional have lines; the
          other buckets are not budgeted, so nothing is offered for them. */}
      {linesFor(transaction.bucket).length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            alignItems: 'center',
            marginTop: 8,
            paddingTop: 8,
            borderTop: '1px solid var(--line)',
          }}
        >
          <span className="tiny muted" style={{ marginRight: 2 }}>
            Counts against
          </span>
          {linesFor(transaction.bucket).map((l) => (
            <button
              key={l.id}
              type="button"
              className="pill"
              disabled={busy}
              onClick={() => void apply(transaction.bucket, l.id)}
              style={{
                background: 'var(--neutral-bg)',
                color: 'var(--neutral-tx)',
                opacity: busy ? 0.5 : 1,
                boxShadow:
                  transaction.budget_line_id === l.id ? 'inset 0 0 0 1px var(--ink)' : undefined,
              }}
            >
              {l.line_name}
            </button>
          ))}
        </div>
      )}

      {err && (
        <div className="tiny" style={{ color: 'var(--red)', marginTop: 7 }}>
          {err}
        </div>
      )}
    </div>
  )
}
