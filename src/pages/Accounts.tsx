import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useData, type Account } from '../lib/data'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { isoDate, money, moneyCents, minimum, accountLabel, relativeTime, rateLabel, dueLabel, ownerLabel } from '../lib/format'

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

  /**
   * Debts are the payoff queue. Bank accounts are where money sits and is spent
   * from — they are not owed to anybody, so mixing them into one list invites
   * reading a chequing balance as part of what the household owes.
   */
  const isDebt = (a: Account) => a.kind === 'card' || a.kind === 'loan' || a.kind === 'tax'

  /**
   * "Connected" means a bank is actually attached — not merely that the account
   * was seeded with the intention of syncing one day. is_manual records intent; an
   * account with no plaid_account_id is showing a figure somebody typed, whatever
   * the intent was, and calling it synced implies a live balance that does not
   * exist.
   */
  const debtsConnected = useMemo(
    () => accounts.filter((a) => isDebt(a) && a.plaid_account_id).sort(byPayoffOrder),
    [accounts],
  )

  const debtsTyped = useMemo(
    () => accounts.filter((a) => isDebt(a) && !a.plaid_account_id).sort(byPayoffOrder),
    [accounts],
  )

  const banks = useMemo(
    () => accounts.filter((a) => !isDebt(a)).sort(byPayoffOrder),
    [accounts],
  )

  /** Every account whose balance is typed in, whatever kind it is. */
  const manual = useMemo(
    () => accounts.filter((a) => !a.plaid_account_id).sort(byPayoffOrder),
    [accounts],
  )

  /**
   * Re-seed on the VALUES, not the array identity.
   *
   * `manual` is a fresh array on every load, and the data layer reloads on a tab
   * focus or a token refresh — so keying on identity wiped whatever was half
   * typed the moment the app regained focus, which on a phone is every time the
   * banking app is checked for the figure being copied across. Keyed on the
   * balances themselves, the effect only fires when a balance actually changed.
   */
  const seedSig = useMemo(() => manual.map((a) => `${a.id}:${seedValue(a)}`).join('|'), [manual])

  useEffect(() => {
    const next: Record<string, string> = {}
    for (const a of manual) next[a.id] = seedValue(a)
    setSeed(next)
    // Keep anything already edited away from its seed; adopt the new figure only
    // where the field is untouched.
    setValues((prev) => {
      const merged = { ...next }
      for (const a of manual) {
        const was = prev[a.id]
        if (was !== undefined && was !== seed[a.id]) merged[a.id] = was
      }
      return merged
    })
    // seed is intentionally not a dependency: it is written by this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedSig])

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

  /** "Northbank \u20228802" — the issuer, plus the digits printed on the card. */
  const instMask = (a: Account) =>
    [a.institution, a.mask ? `\u2022\u2022${a.mask}` : ''].filter(Boolean).join(' ') || null

  /** "12.34% · min $100 · owner" — "payment plan" stands in where there is no rate. */
  /**
   * The owner now leads the account name, so it is not repeated here. The type
   * label leads instead: "Auto loan" answers the first question a reader has when
   * scanning a list of nine debts, which the rate alone does not. The issuing bank
   * follows it, because two "Credit card" rows are only tellable apart by who
   * issued them — and where even that is not enough (this household holds two
   * cards from one issuer sharing a nickname), the bank's own last four is.
   */
  function syncedSub(a: Account) {
    const parts = [a.type_label, instMask(a)]
    if (a.kind === 'card' || a.kind === 'loan' || a.kind === 'tax') {
      parts.push(rateLabel(a), `min ${minimum(a.minimum_payment)}`, dueLabel(a.next_due_on) ?? '')
    }
    return parts.filter(Boolean).join(' · ')
  }

  /** "12.34% · updated 3 days ago" — savings shows its deposit target instead of a rate. */
  function manualSub(a: Account) {
    const parts: (string | null)[] = [a.type_label, instMask(a)]
    if (a.kind === 'savings') {
      if (plan) parts.push(`target ${money(plan.deposit_target)}`)
    } else if (a.kind !== 'checking') {
      parts.push(rateLabel(a), `min ${minimum(a.minimum_payment)}`, dueLabel(a.next_due_on) ?? '')
    }
    parts.push(a.balanceUpdatedAt ? `updated ${relativeTime(a.balanceUpdatedAt)}` : 'no update yet')
    return parts.filter(Boolean).join(' · ')
  }

  const lastSavedBy = lastManual?.enteredBy ? memberNames[lastManual.enteredBy] : undefined

  // Skeletons are for the first load only. refresh() after a save flips `loading`
  // back on while the rows are still in hand, and swapping the whole page for
  // placeholders there would read as a fault rather than a save.
  const showSkeleton = loading && accounts.length === 0

  /** Read off the data, so the owner CHECK constraint is never guessed at. */
  const owners = useMemo(
    () => Array.from(new Set(accounts.map((a) => a.owner))).sort(),
    [accounts],
  )

  return (
    <div className="page">
      <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 4 }}>Accounts</div>
      <div className="tiny muted" style={{ marginBottom: 16 }}>
        Rates and minimums are fixed. Only balances move.
      </div>

      {/*
        ALWAYS the first action on the page.
        This panel used to appear only while a seeded debt was still waiting to be
        connected. Once each was either linked or marked typed-in it disappeared,
        and the only remaining route to /link was a ghost button below three
        tables and the save control — present in the build, invisible in practice,
        which is indistinguishable from missing to anyone trying to add an
        account. There is no nav entry for /link, so this IS the entry point.
      */}
      <div className="card-panel" style={{ marginBottom: 20 }}>
        <div className="sm" style={{ fontWeight: 700, marginBottom: 3 }}>
          Add an account
        </div>
        <div className="tiny muted" style={{ marginBottom: 11, lineHeight: 1.55 }}>
          {unlinkedCount > 0 ? (
            <>
              <span className="tnum">{unlinkedCount}</span>{' '}
              {unlinkedCount === 1 ? 'account is' : 'accounts are'} showing a figure
              entered by hand rather than a live one.
            </>
          ) : (
            'Two ways in, depending on whether a bank connection can reach it.'
          )}
        </div>

        {/*
          Two DISTINCT routes, each labelled with the case it is for.
          A prominent "Connect a bank" above a faint "add by hand" read as one
          real action and one afterthought, so the second was reported missing
          even while it was on screen. Store cards are the whole reason the second
          route exists — no aggregator reaches them — so it says so.
        */}
        <button className="btn" onClick={() => navigate('/link')}>
          Connect a bank
        </button>
        <div className="tiny muted" style={{ margin: '5px 0 13px', lineHeight: 1.5 }}>
          For a bank or card that can be signed into. Balances then update on
          their own.
        </div>

        <AddDebt owners={owners} onAdded={() => void refresh()} />
      </div>

      {error && (
        <div className="banner banner--red tiny" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      {showSkeleton ? (
        <>
          <div className="skeleton" style={{ width: 96, height: 10, marginBottom: 10 }} />
          <SkeletonRows count={4} />
          <div className="skeleton" style={{ width: 96, height: 10, margin: '20px 0 10px' }} />
          <SkeletonRows count={3} />
          <div className="skeleton" style={{ height: 46, marginTop: 16 }} />
        </>
      ) : (
        <>
          <div className="tiny muted" style={{ fontWeight: 700, marginBottom: 4 }}>
            DEBTS · CONNECTED
          </div>
          {debtsConnected.length === 0 ? (
            <div className="tiny muted" style={{ padding: '10px 0' }}>
              No debts are connected to a bank yet.
            </div>
          ) : (
            <table>
              <tbody>
                {debtsConnected.map((a) => {
                  const isClear = a.balance <= 0 || Boolean(a.cleared_at)
                  return (
                    <tr key={a.id}>
                      <td>
                        <div className="sm" style={{ fontWeight: 600 }}>
                          {accountLabel(a)}
                        </div>
                        <div className="tiny muted tnum">{syncedSub(a)}</div>
                        <EditTerms account={a} onSaved={refresh} />
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
            DEBTS · TYPED IN
          </div>
          {debtsTyped.length === 0 ? (
            <div className="tiny muted" style={{ padding: '10px 0' }}>
              Every debt is connected.
            </div>
          ) : (
            <table>
              <tbody>
                {debtsTyped.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="sm" style={{ fontWeight: 600 }}>
                        {accountLabel(a)}
                      </div>
                      <div className="tiny muted tnum">{manualSub(a)}</div>
                      <EditTerms account={a} onSaved={refresh} />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <input
                        className="tnum"
                        style={{ width: 104, padding: '7px 9px', fontSize: 13, textAlign: 'right' }}
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
          )}

          <div className="tiny muted" style={{ fontWeight: 700, margin: '20px 0 4px' }}>
            BANK ACCOUNTS
          </div>
          <div className="tiny muted" style={{ marginBottom: 6, lineHeight: 1.5 }}>
            Where money sits and is spent from. Not part of the payoff queue.
          </div>
          {banks.length === 0 ? (
            <div className="tiny muted" style={{ padding: '10px 0' }}>
              No bank accounts connected.
            </div>
          ) : (
            <table>
              <tbody>
                {banks.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="sm" style={{ fontWeight: 600 }}>
                        {accountLabel(a)}
                      </div>
                      <div className="tiny muted tnum">
                        {a.plaid_account_id ? syncedSub(a) : manualSub(a)}
                      </div>
                    </td>
                    {a.plaid_account_id ? (
                      <td className="tnum sm" style={{ textAlign: 'right' }}>
                        {moneyCents(a.balance)}
                      </td>
                    ) : (
                      <td style={{ textAlign: 'right' }}>
                        <input
                          className="tnum"
                          style={{ width: 104, padding: '7px 9px', fontSize: 13, textAlign: 'right' }}
                          inputMode="decimal"
                          aria-label={`${accountLabel(a)} balance`}
                          value={values[a.id] ?? ''}
                          onChange={(e) => setValue(a.id, e.target.value)}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {manual.length > 0 && (
            <>
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

/**
 * Add a debt no bank feed reaches.
 *
 * Store cards are the case this exists for: no aggregator covers them, so the
 * only way they enter the plan is by hand — and until now the only way an
 * account could be created at all was by linking a bank, which is precisely the
 * thing these cards do not support.
 *
 * The payoff position is not asked for. Avalanche order follows the rate, and
 * the database renumbers the whole queue on insert.
 */
function AddDebt({ owners, onAdded }: { owners: string[]; onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [owner, setOwner] = useState(owners[0] ?? 'joint')
  const [kind, setKind] = useState<'card' | 'loan' | 'tax'>('card')
  const [typeLabel, setTypeLabel] = useState('')
  const [institution, setInstitution] = useState('')
  const [balance, setBalance] = useState('')
  const [rate, setRate] = useState('')
  const [minimum, setMinimum] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const num = (v: string) => {
    const n = Number(v.replace(/[^0-9.-]/g, ''))
    return Number.isFinite(n) ? n : null
  }

  const balanceNum = num(balance)
  const canSave = name.trim().length > 0 && balanceNum !== null && balanceNum >= 0 && !busy

  async function save() {
    if (!canSave) return
    setBusy(true)
    setErr(null)
    const { error } = await supabase.rpc('add_manual_debt', {
      p_name: name.trim(),
      p_owner: owner,
      p_kind: kind,
      p_balance: balanceNum,
      p_apr: rate.trim() === '' ? null : num(rate),
      p_minimum: minimum.trim() === '' ? 0 : (num(minimum) ?? 0),
      p_type_label: typeLabel.trim() || null,
      p_institution: institution.trim() || null,
    })
    setBusy(false)
    if (error) {
      setErr(error.message)
      return
    }
    setName(''); setTypeLabel(''); setInstitution('')
    setBalance(''); setRate(''); setMinimum('')
    setOpen(false)
    onAdded()
  }

  const field = { width: '100%', padding: 10, fontSize: 14, marginTop: 4 } as const

  if (!open) {
    return (
      <>
        <button className="btn" onClick={() => setOpen(true)}>
          Add a store card or loan by hand
        </button>
        <div className="tiny muted" style={{ marginTop: 5, lineHeight: 1.5 }}>
          For anything no bank connection reaches — a store card, a private loan.
          Its balance is kept current by typing it in.
        </div>
      </>
    )
  }

  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <div className="tiny muted" style={{ marginBottom: 8, lineHeight: 1.5 }}>
        For a card or loan no bank connection reaches. Its balance is kept up to
        date by typing it in.
      </div>

      <label className="tiny muted">Name
        <input style={field} value={name} onChange={(e) => setName(e.target.value)}
          placeholder="What it is called" />
      </label>

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <label className="tiny muted" style={{ flex: 1 }}>Whose
          <select style={field} value={owner} onChange={(e) => setOwner(e.target.value)}>
            {owners.map((o) => (
              <option key={o} value={o}>{ownerLabel(o)}</option>
            ))}
          </select>
        </label>
        <label className="tiny muted" style={{ flex: 1 }}>Kind
          <select style={field} value={kind}
            onChange={(e) => setKind(e.target.value as 'card' | 'loan' | 'tax')}>
            <option value="card">Credit card</option>
            <option value="loan">Loan</option>
            <option value="tax">Tax payment plan</option>
          </select>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <label className="tiny muted" style={{ flex: 1 }}>Balance owed
          <input style={field} className="tnum" inputMode="decimal" value={balance}
            onChange={(e) => setBalance(e.target.value)} placeholder="0.00" />
        </label>
        <label className="tiny muted" style={{ flex: 1 }}>Rate %
          <input style={field} className="tnum" inputMode="decimal" value={rate}
            onChange={(e) => setRate(e.target.value)} placeholder="optional" />
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <label className="tiny muted" style={{ flex: 1 }}>Minimum payment
          <input style={field} className="tnum" inputMode="decimal" value={minimum}
            onChange={(e) => setMinimum(e.target.value)} placeholder="0.00" />
        </label>
        <label className="tiny muted" style={{ flex: 1 }}>Issuer
          <input style={field} value={institution}
            onChange={(e) => setInstitution(e.target.value)} placeholder="optional" />
        </label>
      </div>

      <label className="tiny muted" style={{ display: 'block', marginTop: 8 }}>Describe it
        <input style={field} value={typeLabel} onChange={(e) => setTypeLabel(e.target.value)}
          placeholder="Store credit card, auto loan…" />
      </label>

      {err && (
        <div className="tiny" style={{ color: 'var(--red)', marginTop: 8 }}>{err}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn" disabled={!canSave} onClick={() => void save()}>
          {busy ? 'Adding…' : 'Add it'}
        </button>
        <button className="btn ghost" onClick={() => { setOpen(false); setErr(null) }}>
          Cancel
        </button>
      </div>
      <div className="tiny muted" style={{ marginTop: 8, lineHeight: 1.5 }}>
        It slots into the payoff queue by rate — highest first — so nothing needs
        reordering by hand.
      </div>
    </div>
  )
}

/**
 * Change a debt's terms: rate, minimum payment, and the day it falls due.
 *
 * These could only be set when an account was created, or by the bank for a
 * connected card. Everything else was fixed at whatever it was seeded with — and
 * a rate that changes, a promotional period ending, a minimum that moves with the
 * balance, had no way in at all.
 *
 * The day of the month is asked for rather than a date, because that is what a
 * statement actually tells you and it stays true next month. The date itself is
 * rolled forward from it.
 */
function EditTerms({ account, onSaved }: { account: Account; onSaved: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [rate, setRate] = useState('')
  const [min, setMin] = useState('')
  const [dueDay, setDueDay] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Re-seed from the account each time it opens, so the fields show what is
  // currently on record rather than whatever was typed and abandoned last time.
  useEffect(() => {
    if (!open) return
    setRate(account.apr === null ? '' : String(account.apr))
    setMin(account.minimum_payment ? String(account.minimum_payment) : '')
    setDueDay(account.due_day === null || account.due_day === undefined ? '' : String(account.due_day))
    setErr(null)
  }, [open, account.apr, account.minimum_payment, account.due_day])

  const num = (v: string) => {
    const n = Number(v.replace(/[^0-9.]/g, ''))
    return Number.isFinite(n) ? n : null
  }

  async function save() {
    setBusy(true)
    setErr(null)
    const { error } = await supabase.rpc('update_debt_terms', {
      p_account_id: account.id,
      p_apr: rate.trim() === '' ? null : num(rate),
      p_minimum: min.trim() === '' ? null : num(min),
      p_due_day: dueDay.trim() === '' ? null : Math.round(num(dueDay) ?? 0),
      p_clear_apr: rate.trim() === '' && account.apr !== null,
      p_clear_due_day: dueDay.trim() === '' && !!account.due_day,
    })
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
        aria-label={`Edit the rate, minimum and due day for ${account.name}`}
        style={{
          background: 'none',
          border: 'none',
          padding: '2px 0 0',
          font: 'inherit',
          cursor: 'pointer',
          textDecoration: 'underline',
        }}
      >
        terms
      </button>
    )
  }

  const field = { width: '100%', padding: 8, fontSize: 13, marginTop: 3 } as const

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', gap: 7 }}>
        <label className="tiny muted" style={{ flex: 1 }}>
          Rate %
          <input
            style={field}
            className="tnum"
            inputMode="decimal"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="none"
          />
        </label>
        <label className="tiny muted" style={{ flex: 1 }}>
          Minimum
          <input
            style={field}
            className="tnum"
            inputMode="decimal"
            value={min}
            onChange={(e) => setMin(e.target.value)}
            placeholder="0.00"
          />
        </label>
        <label className="tiny muted" style={{ flex: 1 }}>
          Due day
          <input
            style={field}
            className="tnum"
            inputMode="numeric"
            value={dueDay}
            onChange={(e) => setDueDay(e.target.value)}
            placeholder="1–28"
          />
        </label>
      </div>

      <div className="tiny muted" style={{ marginTop: 6, lineHeight: 1.45 }}>
        {account.plaid_account_id
          ? 'This account is connected, so the bank overwrites the rate, minimum and due date each night. Anything set here holds only until it next reports.'
          : 'The day of the month, not a date — it rolls forward on its own. Changing the rate re-orders the payoff queue.'}
      </div>

      {err && (
        <div className="tiny" style={{ color: 'var(--red)', marginTop: 6 }}>
          {err}
        </div>
      )}

      <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
        <button className="btn" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save terms'}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}
