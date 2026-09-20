import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useData } from '../lib/data'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { money, moneyCents, ownerLabel, relativeTime } from '../lib/format'
import {
  createLinkToken,
  exchangeLink,
  itemAccounts,
  linkStatus,
  mapAccount,
  createCheckingAccount,
  pollLink,
  syncNow,
  type LinkStatus,
  type PlaidAccountSummary,
} from '../lib/plaidLink'
import { suggestAll, compatibleKinds, type Suggestion, type SeededAccount } from '../lib/suggestMapping'

/**
 * Link a bank.
 *
 * BUILD.md §2.5 said there would be no linking UI, to keep Plaid items scarce and
 * leave nothing to misclick. That was reversed so the other household member can
 * link her own accounts remotely — but the reasoning was sound, so the guardrails
 * survive the reversal:
 *
 *   - the remaining item allowance is shown before anything is started
 *   - an item is only consumed after a typed confirmation
 *   - mapping is computed in advance; nothing has to be copied or typed
 *   - the matcher declines to guess between similar accounts rather than risk
 *     putting an auto loan where a credit card belongs
 */

type Phase = 'idle' | 'confirm' | 'waiting' | 'discovering' | 'mapping' | 'saving' | 'done'

const CAP_WARNING_AT = 8

export default function LinkBank() {
  const navigate = useNavigate()
  const { accounts, refresh } = useData()
  const { memberName } = useAuth()

  const [status, setStatus] = useState<LinkStatus | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)

  const [institution, setInstitution] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [hostedUrl, setHostedUrl] = useState<string | null>(null)
  const [linkToken, setLinkToken] = useState<string | null>(null)

  const [itemId, setItemId] = useState<string | null>(null)
  const [found, setFound] = useState<PlaidAccountSummary[]>([])
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [savedSummary, setSavedSummary] = useState<string[]>([])

  const pollTimer = useRef<number | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await linkStatus())
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current)
    }
  }, [loadStatus])

  const seeded: SeededAccount[] = useMemo(
    () =>
      accounts.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        plaid_account_id: a.plaid_account_id,
        is_manual: a.is_manual,
        opening_balance: a.opening_balance,
        balance: a.balance,
      })),
    [accounts],
  )

  const suggestions = useMemo(
    () => (found.length ? suggestAll(found, seeded) : new Map<string, Suggestion>()),
    [found, seeded],
  )

  /**
   * Pre-select every confident suggestion so confirming is one tap — but seed
   * each row ONCE. `accounts` gets a new identity on every background refetch,
   * which rebuilt `suggestions` and threw away choices already made, mid-review,
   * with no visible cause. Only fill in rows that have no value yet.
   */
  useEffect(() => {
    if (!found.length) return
    setChoices((prev) => {
      const next = { ...prev }
      for (const a of found) {
        if (next[a.account_id] !== undefined) continue
        const s = suggestions.get(a.account_id)
        if (s?.kind === 'map') next[a.account_id] = s.seededId
        else if (s?.kind === 'create_checking') {
          // Seed the option that matches what the bank says this is.
          next[a.account_id] = newOptionsFor(a)[0]?.value ?? ''
        }
        else next[a.account_id] = ''
      }
      return next
    })
  }, [found, suggestions])

  const remaining = status ? status.itemCap - status.itemsUsed : null

  async function beginLink() {
    setError(null)
    if (!institution.trim()) {
      setError('Name the bank first, so the connection is labeled.')
      return
    }
    if (confirmText.trim().toLowerCase() !== institution.trim().toLowerCase()) {
      setError('Type the bank name again to confirm.')
      return
    }

    try {
      setPhase('waiting')
      const created = await createLinkToken()
      if (!created.hosted_link_url) {
        setError('Plaid did not return a link page. Nothing was used.')
        setPhase('idle')
        return
      }
      setHostedUrl(created.hosted_link_url)
      setLinkToken(created.link_token)
      window.open(created.hosted_link_url, '_blank', 'noopener')
      startPolling(created.link_token)
    } catch (e) {
      setError((e as Error).message)
      setPhase('idle')
    }
  }

  function startPolling(token: string) {
    if (pollTimer.current) window.clearInterval(pollTimer.current)
    const started = Date.now()

    pollTimer.current = window.setInterval(async () => {
      // Fifteen minutes matches the link token's life; after that it cannot complete.
      if (Date.now() - started > 15 * 60 * 1000) {
        window.clearInterval(pollTimer.current!)
        setError('That took too long. If you finished signing in, tap "I finished signing in".')
        return
      }
      try {
        const res = await pollLink(token)
        if (res.complete && res.public_token) {
          window.clearInterval(pollTimer.current!)
          await finishLink(res.public_token, res.institution ?? institution)
        }
      } catch {
        /* transient — keep polling */
      }
    }, 4000)
  }

  async function finishLink(publicToken: string, inst: string) {
    try {
      setPhase('discovering')
      const ex = await exchangeLink(publicToken, inst.trim())
      setItemId(ex.item_id)
      const acc = await itemAccounts(ex.item_id)
      setFound(acc.accounts)
      setPhase('mapping')
      await loadStatus()
    } catch (e) {
      setError((e as Error).message)
      setPhase('idle')
    }
  }

  /**
   * Re-open the mapping step for a connection that already exists.
   *
   * Linking ran one way only: a bank was connected, its accounts were offered
   * once, and if that step was not finished there was no route back to it. The
   * connection had already been spent, so it sat there feeding nothing, with the
   * screen offering only to connect ANOTHER bank.
   *
   * It is also the way to pick up an account that was not ticked the first time,
   * or one opened at a bank since. Reading the accounts on a connection costs
   * nothing and consumes no allowance.
   */
  async function reviewItem(existingItemId: string) {
    setError(null)
    setPhase('discovering')
    try {
      setItemId(existingItemId)
      // Carry the bank's name off the connection. The field that normally holds
      // it is only filled while connecting a NEW bank, so re-entering mapping
      // without this left every account mapped with no issuer recorded.
      const known = status?.items.find((i) => i.item_id === existingItemId)
      if (known?.institution) setInstitution(known.institution)
      const acc = await itemAccounts(existingItemId)
      setFound(acc.accounts)
      setChoices({})
      setPhase('mapping')
    } catch (e) {
      setError((e as Error).message)
      setPhase('idle')
    }
  }

  /** Manual fallback if the automatic poll missed the completion. */
  async function checkNow() {
    if (!linkToken) return
    setError(null)
    try {
      const res = await pollLink(linkToken)
      if (res.complete && res.public_token) {
        if (pollTimer.current) window.clearInterval(pollTimer.current)
        await finishLink(res.public_token, res.institution ?? institution)
      } else {
        setError('Not finished yet. Complete the bank sign-in in the other tab, then tap again.')
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function saveMappings() {
    // Each seeded row can hold exactly one Plaid account — plaid_account_id is a
    // single column. Two rows pointing at the same one is not a conflict the
    // database reports; the second write simply wins and the first account is
    // silently left untracked, which looks identical to having linked it.
    const picked = found
      .map((a) => choices[a.account_id])
      .filter((c) => c && !c.startsWith('__'))
    const dupes = picked.filter((c, i) => picked.indexOf(c) !== i)
    if (dupes.length > 0) {
      const name = accounts.find((a) => a.id === dupes[0])?.name ?? 'the same account'
      setError(
        `Two of these are matched to ${name}. Each one needs its own row, or only the last would be kept.`,
      )
      return
    }

    setPhase('saving')
    setError(null)
    const done: string[] = []
    try {
      for (const a of found) {
        const choice = choices[a.account_id]
        if (!choice) continue
        // Attribute a new account to whoever is doing the linking rather than
        // assuming; the owner falls back to joint if that is not a known value.
        const owner = memberName ? memberName.trim().toLowerCase() : undefined
        const label = a.official_name || a.name

        if (choice === '__new_card__' || choice === '__new_card_business__') {
          // A new CARD is a debt: it belongs in the payoff queue, ordered by rate
          // like every other one. Creating it as a checking row — the only thing
          // this flow could previously do — filed a card as somewhere money is
          // spent FROM, which is the opposite of what it is.
          //
          // The rate and minimum are left unset on purpose. Plaid reports both
          // for a card through liabilities on the next run, and a guess here
          // would be a figure nobody could trace.
          const { data: newId, error: rpcErr } = await supabase.rpc('add_manual_debt', {
            p_name: label,
            p_owner: owner ?? 'joint',
            p_kind: 'card',
            p_balance: a.current ?? 0,
            p_apr: null,
            p_minimum: 0,
            p_type_label: choice === '__new_card_business__' ? 'Business credit card' : 'Credit card',
            p_institution: institution.trim() || null,
          })
          if (rpcErr) throw new Error(rpcErr.message)
          await mapAccount(newId as string, a.account_id, institution.trim())
          done.push(`${a.name} added as a credit card`)
        } else if (choice === '__new_loan__') {
          const { data: newId, error: rpcErr } = await supabase.rpc('add_manual_debt', {
            p_name: label,
            p_owner: owner ?? 'joint',
            p_kind: 'loan',
            p_balance: a.current ?? 0,
            p_apr: null,
            p_minimum: 0,
            p_type_label: 'Loan',
            p_institution: institution.trim() || null,
          })
          if (rpcErr) throw new Error(rpcErr.message)
          await mapAccount(newId as string, a.account_id, institution.trim())
          done.push(`${a.name} added as a loan`)
        } else if (choice.startsWith('__new_checking') || choice === '__new_savings__') {
          await createCheckingAccount(label, a.account_id, {
            owner,
            institution: institution.trim(),
            isBusiness: choice === '__new_checking_business__',
            kind: choice === '__new_savings__' ? 'savings' : 'checking',
          })
          done.push(
            `${a.name} added as a ${choice === '__new_savings__' ? 'savings' : 'checking'} account`,
          )
        } else {
          await mapAccount(choice, a.account_id, institution.trim())
          const s = accounts.find((x) => x.id === choice)
          done.push(`${a.name} linked to ${s ? s.name : 'account'}`)
        }
      }
      setSavedSummary(done)

      // Pull from the connection straight away. Nothing flows from a newly
      // mapped account until a sync runs, so until the nightly job came round it
      // held no cursor, showed no balances, and the connection still described
      // itself as needing to be set up — after it had just been set up.
      await syncNow()

      await refresh()
      await loadStatus()
      setPhase('done')
    } catch (e) {
      setError((e as Error).message)
      setPhase('mapping')
    }
  }

  /**
   * The "create something new" options for one Plaid account, named for what the
   * bank says it is rather than for where money goes.
   */
  function newOptionsFor(a: PlaidAccountSummary): { value: string; label: string }[] {
    const kinds = compatibleKinds(a)
    if (kinds.includes('card')) {
      return [
        { value: '__new_card__', label: 'Add as a new credit card' },
        { value: '__new_card_business__', label: 'Add as a new business credit card' },
      ]
    }
    if (kinds.includes('savings')) {
      return [{ value: '__new_savings__', label: 'Add as a savings account' }]
    }
    if (kinds.includes('checking')) {
      return [
        { value: '__new_checking__', label: 'Add as a checking account' },
        { value: '__new_checking_business__', label: 'Add as a business checking account' },
      ]
    }
    if (kinds.includes('loan')) {
      return [{ value: '__new_loan__', label: 'Add as a new loan' }]
    }
    return []
  }

  const unmappedDebts = accounts.filter(
    (a) => !a.plaid_account_id && !a.is_manual && ['card', 'loan', 'tax'].includes(a.kind),
  )

  return (
    // page--narrow: a wizard is a single column by nature. Widening it would
    // only put more distance between a step and the one after it.
    <div className="page page--narrow">
      <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 4 }}>Link a bank</div>
      <div className="tiny muted" style={{ marginBottom: 16 }}>
        Sign in to your bank through Plaid. Payoff never sees your bank password.
      </div>

      {error && (
        <div className="banner banner--red" style={{ marginBottom: 16 }}>
          <div className="sm" style={{ fontWeight: 700 }}>{error}</div>
        </div>
      )}

      {/* ---- allowance ---- */}
      {status && (
        <div
          className={
            remaining !== null && status.itemsUsed >= CAP_WARNING_AT
              ? 'banner banner--red'
              : 'card-panel'
          }
          style={{ marginBottom: 20 }}
        >
          <div className="sm" style={{ fontWeight: 700 }}>
            <span className="tnum">{status.itemsUsed}</span> of{' '}
            <span className="tnum">{status.itemCap}</span> bank connections used
          </div>
          <div className="tiny muted" style={{ marginTop: 3, lineHeight: 1.5 }}>
            Each bank you connect uses one permanently. Removing a connection does not
            give it back, so connect each bank once.
          </div>
          {/*
            Every connection, each with a way back into its accounts.
            A bare list of names was all this used to be, which left a connection
            that had been made but never finished with no route to finishing it —
            the allowance spent, nothing flowing, and the page offering only to
            connect another bank. This is also how an account that was not ticked
            the first time gets picked up. It costs no allowance.
          */}
          {status.items.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {status.items.map((i) => {
                const live = i.cursor !== null
                return (
                  <div
                    key={i.item_id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '7px 0',
                      borderTop: '1px solid var(--line)',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div className="sm" style={{ fontWeight: 600 }}>{i.institution}</div>
                      <div className="tiny muted">
                        {i.status !== 'ok'
                          ? 'needs signing in again'
                          : live
                            ? i.last_synced
                              ? `updating · synced ${relativeTime(i.last_synced)}`
                              : 'updating'
                            : 'connected, but no accounts set up yet'}
                      </div>
                    </div>
                    <button
                      className="btn ghost"
                      style={{ width: 'auto', padding: '6px 11px', fontSize: 13, flexShrink: 0 }}
                      disabled={phase !== 'idle'}
                      onClick={() => void reviewItem(i.item_id)}
                    >
                      {live ? 'Accounts' : 'Set up'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {/* A connection can go stale — a password change, an expired consent —
              and from then on it silently stops updating. sync records that as
              status 'login_required', but nothing in the app has ever shown it,
              so the only symptom was a balance that quietly stopped moving while
              the screen still said "Connected". Reconnecting costs no allowance:
              it reuses the existing item rather than consuming a new one. */}
          {status.items.some((i) => i.status !== 'ok') && (
            <div className="banner banner--red tiny" style={{ marginTop: 10, lineHeight: 1.5 }}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>
                {status.items.filter((i) => i.status !== 'ok').length === 1
                  ? 'One connection has stopped updating'
                  : 'Some connections have stopped updating'}
              </div>
              {status.items
                .filter((i) => i.status !== 'ok')
                .map((i) => (
                  <div key={i.item_id}>
                    {i.institution} —{' '}
                    {i.status === 'login_required'
                      ? 'needs signing in again'
                      : 'last sync failed'}
                    . Its balances are frozen at the last reading.
                  </div>
                ))}
              <div style={{ marginTop: 6 }}>
                Reconnecting one of these does not use up another connection.
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---- what still needs connecting ---- */}
      {phase === 'idle' && unmappedDebts.length > 0 && (
        <>
          <div className="tiny muted" style={{ fontWeight: 700, marginBottom: 4 }}>
            STILL WAITING FOR A CONNECTION
          </div>
          <table style={{ marginBottom: 20 }}>
            <tbody>
              {unmappedDebts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div className="sm" style={{ fontWeight: 600 }}>
                      {ownerLabel(a.owner)} · {a.name}
                    </div>
                  </td>
                  <td className="tnum sm muted" style={{ textAlign: 'right' }}>
                    {moneyCents(a.balance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* ---- start ---- */}
      {phase === 'idle' && (
        <>
          <label className="sm" style={{ display: 'block', marginBottom: 7, fontWeight: 600 }}>
            Which bank?
          </label>
          <input
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
            placeholder="Your bank"
            style={{ marginBottom: 12 }}
          />
          <label className="sm" style={{ display: 'block', marginBottom: 7, fontWeight: 600 }}>
            Type it again to confirm
          </label>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="Your bank"
            style={{ marginBottom: 14 }}
          />
          <button className="btn" onClick={beginLink} disabled={!institution.trim()}>
            Open my bank sign-in
          </button>
          <div className="tiny muted" style={{ marginTop: 9, lineHeight: 1.6 }}>
            This opens Plaid in a new tab. Come back here when you are done — this page
            picks it up on its own.
          </div>
        </>
      )}

      {/* ---- waiting ---- */}
      {phase === 'waiting' && (
        <>
          <div className="banner banner--neutral" style={{ marginBottom: 16 }}>
            <div className="sm" style={{ fontWeight: 700 }}>Waiting for your bank sign-in</div>
            <div className="tiny" style={{ marginTop: 3, lineHeight: 1.5 }}>
              Finish signing in on the Plaid tab. Leave this page open — it checks every
              few seconds and continues by itself.
            </div>
          </div>
          {hostedUrl && (
            <button
              className="btn ghost"
              style={{ marginBottom: 10 }}
              onClick={() => window.open(hostedUrl, '_blank', 'noopener')}
            >
              Reopen the bank sign-in
            </button>
          )}
          <button className="btn ghost" onClick={checkNow}>
            I finished signing in
          </button>
        </>
      )}

      {phase === 'discovering' && (
        <div className="sm muted">Reading the accounts your bank shared…</div>
      )}

      {/* ---- mapping ---- */}
      {phase === 'mapping' && (
        <>
          <div className="sect" style={{ marginTop: 0 }}>Match them up</div>
          <div className="tiny muted" style={{ marginBottom: 12, lineHeight: 1.6 }}>
            These are already filled in where the match is obvious. Check them, change
            anything that looks wrong, then save.
          </div>

          {found.map((a) => {
            const s = suggestions.get(a.account_id)
            const uncertain = s?.kind === 'skip'
            return (
              <div
                key={a.account_id}
                style={{
                  borderTop: '1px solid var(--line)',
                  paddingTop: 12,
                  marginBottom: 12,
                }}
              >
                <div className="sm" style={{ fontWeight: 600 }}>
                  {a.name}
                  {a.mask ? <span className="muted tnum"> ••{a.mask}</span> : null}
                </div>
                <div className="tiny muted tnum" style={{ marginBottom: 7 }}>
                  {a.subtype ?? a.type}
                  {a.current !== null ? ` · ${moneyCents(a.current)}` : ''}
                </div>

                <select
                  value={choices[a.account_id] ?? ''}
                  onChange={(e) =>
                    setChoices((c) => ({ ...c, [a.account_id]: e.target.value }))
                  }
                  style={{
                    width: '100%',
                    padding: 10,
                    border: `1px solid ${uncertain ? 'var(--red)' : 'var(--line)'}`,
                    borderRadius: 'var(--r-control)',
                    fontFamily: 'inherit',
                    fontSize: 14,
                    background: '#fff',
                    color: 'var(--ink)',
                  }}
                >
                  <option value="">Don't track this account</option>

                  {/*
                    What this account could BECOME, named for what it actually is.
                    "Spending account" covered a checking account, a savings
                    account and a credit card alike, and created a checking row
                    for all three — so the only way to add a new card was to file
                    it as somewhere money is spent FROM, which is the opposite of
                    what it is.
                  */}
                  {newOptionsFor(a).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}

                  {/*
                    Existing rows of a COMPATIBLE kind only. Every unmapped row
                    used to be offered, so a credit card could be matched to a tax
                    payment plan or an auto loan — a mapping that can never be
                    right, sitting in the list as though it were a reasonable
                    choice.
                  */}
                  {accounts
                    .filter((x) => !x.plaid_account_id && compatibleKinds(a).includes(x.kind))
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {ownerLabel(x.owner)} · {x.name}
                        {x.kind === 'savings' ? '' : ` (${money(x.opening_balance)})`}
                      </option>
                    ))}
                </select>

                <div
                  className="tiny"
                  style={{ marginTop: 5, color: uncertain ? 'var(--red-tx)' : 'var(--steel)' }}
                >
                  {s?.reason}
                </div>
              </div>
            )
          })}

          <button className="btn" style={{ marginTop: 8 }} onClick={saveMappings}>
            Save
          </button>
        </>
      )}

      {phase === 'saving' && <div className="sm muted">Saving…</div>}

      {/* ---- done ---- */}
      {phase === 'done' && (
        <>
          <div className="banner banner--green" style={{ marginBottom: 16 }}>
            <div className="sm" style={{ fontWeight: 700 }}>{institution || 'Bank'} connected</div>
            <div className="tiny" style={{ marginTop: 3, lineHeight: 1.6 }}>
              Balances and transactions arrive with tonight's update, or sooner if
              someone runs one.
            </div>
          </div>
          {savedSummary.length > 0 && (
            <ul className="tiny muted" style={{ paddingLeft: 18, marginBottom: 18, lineHeight: 1.8 }}>
              {savedSummary.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
          <button
            className="btn"
            onClick={() => {
              setPhase('idle')
              setInstitution('')
              setConfirmText('')
              setFound([])
              setItemId(null)
              setHostedUrl(null)
              setLinkToken(null)
              setSavedSummary([])
            }}
          >
            Connect another bank
          </button>
          <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => navigate('/accounts')}>
            Back to accounts
          </button>
        </>
      )}

      {itemId && phase === 'mapping' && (
        <div className="tiny muted" style={{ marginTop: 14 }}>
          Connection saved. Matching accounts does not use another connection, so you can
          change these safely.
        </div>
      )}
    </div>
  )
}
