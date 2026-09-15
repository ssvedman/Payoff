import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useData, type Account } from '../lib/data'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { apr, isoDate, money, moneyCents, minimum, accountLabel, relativeTime } from '../lib/format'

/**
 * /accounts — BUILD.md §7.
 *
 * Synced accounts are read-only. Manual accounts carry an inline input and one
 * save button. Non-negotiable #5: there is no bank-linking UI here, and never
 * will be — the nine debts plus savings are seeded once.
 *
 * Rates, minimums and payoff order are fixed in the seed. Only balances move.
 */

const byPayoffOrder = (a: Account, b: Account) => a.payoff_order - b.payoff_order

/** One row of balance_snapshots, exactly as §3 defines it for a typed-in balance. */
interface SnapshotInsert {
  account_id: string
  balance: number
  as_of: string
  source: 'manual'
  entered_by: string
}

/** The stored balance as the input renders it, so "dirty" is a plain string compare. */
const seedValue = (a: Account) => a.balance.toFixed(2)

/** Accepts "1234.56", "$1,234.56", " 1234 ". Rejects anything not a finite number >= 0. */
function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '')
  if (cleaned === '') return null
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100) / 100
}

export default function Accounts() {
  const navigate = useNavigate()

  const { loading, error, accounts, plan, memberNames, refresh } = useData()

  /** Debts still showing the figure typed in at plan start rather than a live one. */
  const unlinkedCount = accounts.filter(
    (a) => !a.plaid_account_id && !a.is_manual && ['card', 'loan', 'tax'].includes(a.kind),
  ).length
  const { user } = useAuth()

  const [values, setValues] = useState<Record<string, string>>({})
  const [seed, setSeed] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const synced = useMemo(
    // "Synced" means a bank is actually attached — not merely that the account was
    // seeded with the intention of syncing one day. is_manual records intent; an
    // account with no plaid_account_id is showing a figure somebody typed,
    // whatever the intent was, and listing it as synced implies a live balance
    // that does not exist.
    () => accounts.filter((a) => a.plaid_account_id).sort(byPayoffOrder),
    [accounts],
  )

  const manual = useMemo(
    () => accounts.filter((a) => !a.plaid_account_id).sort(byPayoffOrder),
    [accounts],
  )

  // Re-seed only when the underlying rows change identity — on first load and
  // after refresh(). Typing never changes `accounts`, so nothing in progress is
  // clobbered mid-edit.
  useEffect(() => {
    const next: Record<string, string> = {}
    for (const a of manual) next[a.id] = seedValue(a)
    setSeed(next)
    setValues(next)
  }, [manual])

  const changed = manual.filter((a) => (values[a.id] ?? '') !== (seed[a.id] ?? ''))
  const canSave = changed.length > 0 && !saving && Boolean(user)

  /**
   * The most recent typed-in balance. Scoped to manual accounts: the seed writes
   * source='manual' rows for the synced accounts too, and those are not saves
   * anyone made from this screen.
   */
  const lastManual = useMemo(() => {
    return accounts
      .filter((a) => !a.plaid_account_id && a.balanceSource === 'manual' && a.balanceUpdatedAt)
      .sort((a, b) => ((a.balanceUpdatedAt ?? '') < (b.balanceUpdatedAt ?? '') ? 1 : -1))[0]
  }, [accounts])

  function setValue(id: string, v: string) {
    setProblem(null)
    setValues((prev) => ({ ...prev, [id]: v }))
  }

  async function save() {
    if (!user || changed.length === 0) return

    const invalid = changed.filter((a) => parseAmount(values[a.id] ?? '') === null)
    if (invalid.length > 0) {
      const names = invalid.map((a) => a.name).join(', ')
      setProblem(
        invalid.length === 1
          ? `${names} is not a number of dollars.`
          : `${names} are not numbers of dollars.`,
      )
      return
    }

    setProblem(null)
    setSaving(true)

    const asOf = isoDate(new Date())
    const rows: SnapshotInsert[] = changed.map((a) => ({
      account_id: a.id,
      balance: parseAmount(values[a.id] ?? '') as number,
      as_of: asOf,
      source: 'manual' as const,
      entered_by: user.id,
    }))

    // Saving twice in one day updates the day's snapshot rather than colliding
    // with the (account_id, as_of, source) unique constraint.
    // The cast is only to satisfy the generated schema's insert generic, which
    // resolves to never for every table under the current supabase-js typings.
    // SnapshotInsert above is the real, checked shape of what goes over the wire.
    const { error: saveError } = await supabase
      .from('balance_snapshots')
      .upsert(rows as unknown as never[], { onConflict: 'account_id,as_of,source' })

    if (saveError) {
      setProblem(saveError.message)
      setSaving(false)
      return
    }

    await refresh()
    setSaving(false)
  }

  /** "12.34% · min $100 · owner" — "payment plan" stands in where there is no rate. */
  /** The owner now leads the account name, so it is not repeated here. */
  function syncedSub(a: Account) {
    return `${apr(a.apr) ?? 'payment plan'} · min ${minimum(a.minimum_payment)}`
  }

  /** "12.34% · updated 3 days ago" — savings shows its deposit target instead of a rate. */
  function manualSub(a: Account) {
    const parts: string[] = []
    if (a.kind === 'savings') {
      if (plan) parts.push(`target ${money(plan.deposit_target)}`)
    } else {
      parts.push(apr(a.apr) ?? 'payment plan')
    }
    parts.push(a.balanceUpdatedAt ? `updated ${relativeTime(a.balanceUpdatedAt)}` : 'no update yet')
    return parts.join(' · ')
  }

  const lastSavedBy = lastManual?.enteredBy ? memberNames[lastManual.enteredBy] : undefined

  // Skeletons are for the first load only. refresh() after a save flips `loading`
  // back on while the rows are still in hand, and swapping the whole page for
  // placeholders there would read as a fault rather than a save.
  const showSkeleton = loading && accounts.length === 0

  return (
    <div className="page">
      <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 4 }}>Accounts</div>
      <div className="tiny muted" style={{ marginBottom: 16 }}>
        Rates and minimums are fixed. Only balances move.
      </div>

      {unlinkedCount > 0 && (
        <div className="card-panel" style={{ marginBottom: 20 }}>
          <div className="sm" style={{ fontWeight: 700, marginBottom: 3 }}>
            <span className="tnum">{unlinkedCount}</span>{' '}
            {unlinkedCount === 1 ? 'account is' : 'accounts are'} not connected to a bank
          </div>
          <div className="tiny muted" style={{ marginBottom: 10, lineHeight: 1.5 }}>
            Their balances are the figures entered when the plan started, not live ones.
          </div>
          <button className="btn" onClick={() => navigate('/link')}>
            Connect a bank
          </button>
        </div>
      )}

      {error && (
        <div className="banner banner--red tiny" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      {showSkeleton ? (
        <>
          <div className="tiny muted" style={{ fontWeight: 700, marginBottom: 4 }}>
            SYNCED
          </div>
          <SkeletonRows count={7} />
          <div className="tiny muted" style={{ fontWeight: 700, margin: '20px 0 4px' }}>
            TYPED IN
          </div>
          <SkeletonRows count={3} />
          <div className="skeleton" style={{ height: 46, marginTop: 16 }} />
        </>
      ) : (
        <>
          <div className="tiny muted" style={{ fontWeight: 700, marginBottom: 4 }}>
            SYNCED
          </div>
          {synced.length === 0 ? (
            <div className="tiny muted" style={{ padding: '10px 0' }}>
              No synced accounts.
            </div>
          ) : (
            <table>
              <tbody>
                {synced.map((a) => {
                  // Only a debt clears. Green marks a cleared debt; a checking or
                  // savings account sitting at zero is just a balance.
                  const isDebt = a.kind !== 'savings' && a.kind !== 'checking'
                  const isClear = isDebt && (a.balance <= 0 || Boolean(a.cleared_at))
                  return (
                    <tr key={a.id}>
                      <td>
                        <div className="sm" style={{ fontWeight: 600 }}>
                          {accountLabel(a)}
                        </div>
                        <div className="tiny muted tnum">{syncedSub(a)}</div>
                      </td>
                      <td
                        className="tnum sm"
                        style={{ textAlign: 'right', color: isClear ? 'var(--green)' : undefined }}
                      >
                        {isClear ? 'cleared' : moneyCents(a.balance)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          <div className="tiny muted" style={{ fontWeight: 700, margin: '20px 0 4px' }}>
            TYPED IN
          </div>
          {manual.length === 0 ? (
            <div className="tiny muted" style={{ padding: '10px 0' }}>
              No typed-in accounts.
            </div>
          ) : (
            <>
              <table>
                <tbody>
                  {manual.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div className="sm" style={{ fontWeight: 600 }}>
                          {accountLabel(a)}
                        </div>
                        <div className="tiny muted tnum">{manualSub(a)}</div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <input
                          className="tnum"
                          style={{
                            width: 104,
                            padding: '7px 9px',
                            fontSize: 13,
                            textAlign: 'right',
                          }}
                          inputMode="decimal"
                          aria-label={`${accountLabel(a)} balance`}
                          value={values[a.id] ?? ''}
                          onChange={(e) => setValue(a.id, e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <button
                className="btn"
                style={{ marginTop: 16 }}
                disabled={!canSave}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save balances'}
              </button>

              {problem && (
                <div
                  className="tiny"
                  style={{ color: 'var(--red)', marginTop: 9, textAlign: 'center' }}
                >
                  {problem}
                </div>
              )}

              {lastManual?.balanceUpdatedAt && (
                <div className="tiny muted tnum" style={{ marginTop: 9, textAlign: 'center' }}>
                  Last saved {relativeTime(lastManual.balanceUpdatedAt)}
                  {lastSavedBy ? ` by ${lastSavedBy}` : ''}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            padding: '12px 0',
            borderBottom: i === count - 1 ? 'none' : '1px solid var(--line)',
          }}
        >
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ height: 11, width: '44%', marginBottom: 6 }} />
            <div className="skeleton" style={{ height: 9, width: '62%' }} />
          </div>
          <div className="skeleton" style={{ height: 13, width: 78 }} />
        </div>
      ))}
    </div>
  )
}
