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
  // Neutral, like Fixed and Transfer. The mockup drew this pill amber, which
  // contradicts the rule the same mockup states: amber is the current payoff
  // target and nothing else. A bucket label is not a target, and this pill
  // appears on two pages at once, so it was the largest single dilution of the
  // one colour the app reserves.
  { key: 'optional', label: 'Optional', bg: 'var(--neutral-bg)', tx: 'var(--neutral-tx)' },
  { key: 'attack', label: 'Attack', bg: 'var(--green-bg)', tx: 'var(--green-tx)' },
  { key: 'savings', label: 'Savings', bg: 'var(--green-bg)', tx: 'var(--green-tx)' },
  { key: 'income', label: 'Income', bg: 'var(--green-bg)', tx: 'var(--green-tx)' },
  { key: 'transfer', label: 'Transfer', bg: 'var(--neutral-bg)', tx: 'var(--neutral-tx)' },
  { key: 'review', label: 'Review', bg: 'var(--red-bg)', tx: 'var(--red-tx)' },
]

export const bucketStyle = (b: Bucket) => BUCKETS.find((x) => x.key === b) ?? BUCKETS[6]

export const bucketLabel = (b: Bucket) => bucketStyle(b).label

/** A finished edit, described well enough for the page to say where it went. */
export interface MoveNotice {
  name: string
  /** Set only when the bucket actually changed — i.e. when it may have left the view. */
  from: Bucket | null
  to: Bucket
  lineName: string | null
  alsoUpdated: number
}

export default function Recategorizer({
  transaction,
  loaded,
  onDone,
}: {
  transaction: Transaction
  /** Rows already on screen, so a vendor rule corrects them in the same call. */
  loaded: Transaction[]
  /**
   * `notice` describes the edit. Pages that filter by bucket MUST show it: a row
   * that no longer matches the open filter vanishes on refresh, and silence
   * reads as deletion.
   */
  onDone: (notice?: MoveNotice) => void | Promise<void>
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

  /**
   * EVERY budget line, not just the ones belonging to the bucket currently set.
   *
   * A line belongs to exactly one bucket, so choosing a line already decides the
   * bucket — asking for the bucket first was redundant, and worse, it hid the
   * line being looked for. A superstore charge sitting in optional could not be
   * assigned to a grocery budget at all without first pressing Fixed, which also
   * cleared the line, so the two-step was invisible and the category looked
   * missing entirely.
   *
   * Picking a line now sets both.
   */
  const allLines = budgetLines

  async function apply(bucket: Bucket, lineId?: string | null) {
    setBusy(true)
    setErr(null)
    try {
      const result = await recategorize({
        transaction,
        bucket,
        lineId,
        scope: canRule ? scope : 'once',
        userId: user?.id ?? null,
        loaded,
      })
      const lineId2 = lineId === undefined ? transaction.budget_line_id : lineId
      await onDone({
        name: transaction.merchant_name || transaction.name,
        from: result.from,
        to: result.to,
        lineName: budgetLines.find((l) => l.id === lineId2)?.line_name ?? null,
        alsoUpdated: result.alsoUpdated,
      })
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
          other buckets are not budgeted, so a line simply moves it to one. */}
      {allLines.length > 0 && (
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
          {allLines.map((l) => {
            const chosen = transaction.budget_line_id === l.id
            // A line from the other bucket is shown in that bucket's colour, so
            // it is obvious that picking it moves the transaction as well.
            const other = l.bucket !== transaction.bucket
            const palette = bucketStyle(l.bucket as Bucket)
            return (
              <button
                key={l.id}
                type="button"
                className="pill"
                disabled={busy}
                onClick={() => void apply(l.bucket as Bucket, l.id)}
                title={other ? `Moves this to ${l.bucket}` : undefined}
                style={{
                  background: other ? palette.bg : 'var(--neutral-bg)',
                  color: other ? palette.tx : 'var(--neutral-tx)',
                  opacity: busy ? 0.5 : 1,
                  boxShadow: chosen ? 'inset 0 0 0 1px var(--ink)' : undefined,
                }}
              >
                {l.line_name}
              </button>
            )
          })}
        </div>
      )}
      <div className="tiny muted" style={{ marginTop: 6, lineHeight: 1.45 }}>
        A category belongs to one bucket, so choosing one sets both.
      </div>

      {err && (
        <div className="tiny" style={{ color: 'var(--red)', marginTop: 7 }}>
          {err}
        </div>
      )}
    </div>
  )
}
