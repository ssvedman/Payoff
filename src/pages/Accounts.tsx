import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { isCleared, useData, useNetWorth, usePayoffPlan, type Account, type Asset } from '../lib/data'
import AccountsAssets from '../components/AccountsAssets'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import type { AssetRow } from '../lib/database.types'
import {
  isoDate,
  money,
  moneyCents,
  minimum,
  accountLabel,
  relativeTime,
  rateLabel,
  dueLabel,
  ownerLabel,
  parseDateOnly,
  signedAmount,
} from '../lib/format'

/**
 * /accounts. Grouped by what things ARE, not by whether Plaid can reach them.
 *
 * Debts are the payoff queue. Cash is where money sits and is spent from. Assets
 * are what is owned. A synced balance shows what moved, and when, since the
 * previous reading; a
 * typed-in one carries an inline input, and every inline edit on the page,
 * balances and valuations alike, is written by the single Save changes button.
 *
 * Rates, minimums and payoff order are seeded; only balances move. The one
 * exception is EditTerms, which exists because a rate really does change and a
 * promotional period really does end, and there was otherwise no way in.
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

/**
 * The same, for a valuation.
 *
 * toFixed, never a truthiness test on the number. A vehicle written down to 0.00
 * is a real figure on record, and the old per-row editor seeded with
 * `value ? String(value) : ''`, which opened blank on it: saving without
 * retyping looked like a no-op while actually refusing to save, and the only way
 * to see the stored 0 was to close the field again.
 */
const assetSeedValue = (a: Asset) => a.estimated_value.toFixed(2)

/** Accepts "1234.56", "$1,234.56", " 1234 ". Rejects anything not a finite number >= 0. */
function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '')
  if (cleaned === '') return null
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100) / 100
}

/**
 * The Updated column is 86px wide, so the age of a figure is said in as few
 * characters as it can be said in: "today", "6d", "4mo".
 *
 * "manual" is what a balance with no recorded update says: the figure typed in
 * when the plan was seeded and not touched since. It is not the same fact as
 * "0 days old" and must not render as "today".
 */
function shortAge(iso: string | null): string {
  if (!iso) return 'manual'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (days <= 0) return 'today'
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(days / 365)}y`
}

/**
 * What moved since the previous reading of this balance.
 *
 * Only meaningful on a debt, and the direction decides the colour: a balance
 * that ROSE is a deviation from the plan and is red; one that fell is progress
 * and is green. Amber is never either of those. It belongs to the target alone.
 *
 * Returns null when there is only one reading on record, which is not the same
 * as "nothing moved" and must not render as a $0 change.
 *
 * The movement is DATED, not described in relative words. "since yesterday"
 * is wrong on a typed-in account, which is updated about monthly, and "since
 * the last reading" is true but tells the reader nothing they can check. The
 * date of the previous reading is accurate in both cases, so that is what it
 * says. If the view has no previous date the clause is dropped rather than
 * guessed at.
 */
function movement(a: Account): { short: string; words: string; tone: 'is-bad' | 'is-good' } | null {
  if (a.previousBalance === null) return null
  const delta = a.balance - a.previousBalance
  if (Math.abs(delta) < 0.005) return null
  const since = a.previousBalanceAsOf
    ? ` since ${parseDateOnly(a.previousBalanceAsOf).toLocaleDateString('en-US', {
        day: 'numeric',
        month: 'short',
      })}`
    : ''
  return {
    short: signedAmount(delta, money),
    words: `${delta > 0 ? 'rose' : 'fell'} ${money(Math.abs(delta))}${since}`,
    tone: delta > 0 ? 'is-bad' : 'is-good',
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The amber pill. The current target, and the only amber anywhere on this page. */
const AMBER_PILL = { background: 'var(--amber-bg)', color: 'var(--amber-tx)' } as const

/**
 * The business pill, deliberately neutral.
 *
 * A business account's balance and history are tracked exactly like any other,
 * but none of its spending reaches a budget bucket and none of its income counts
 * as household income. An exclusion nobody can see is indistinguishable from a
 * bug, so it is stated on the account, quietly, because it is a fact about the
 * account and not a warning about it.
 */
const BUSINESS_PILL = { background: 'var(--card)', color: 'var(--steel)' } as const

export default function Accounts() {
  const navigate = useNavigate()

  const { loading, error, accounts, assets, memberNames, lastSyncedAt, refresh } = useData()
  const { assetsTotal, cashTotal, debtTotal, netWorth } = useNetWorth()
  const payoff = usePayoffPlan()
  const { user } = useAuth()

  /** The debt being attacked. The only row on the page that carries amber. */
  const targetId = payoff?.target?.id ?? null

  const [values, setValues] = useState<Record<string, string>>({})
  const [seed, setSeed] = useState<Record<string, string>>({})
  const [assetValues, setAssetValues] = useState<Record<string, string>>({})
  const [assetSeed, setAssetSeed] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [showCleared, setShowCleared] = useState(false)
  const [showAllDebts, setShowAllDebts] = useState(false)
  const [tab, setTab] = useState<'debts' | 'cash' | 'assets'>('debts')

  /**
   * Debts are the payoff queue. Cash accounts are where money sits and is spent
   * from — they are not owed to anybody, so mixing them into one list invites
   * reading a chequing balance as part of what the household owes.
   */
  const isDebt = (a: Account) => a.kind === 'card' || a.kind === 'loan' || a.kind === 'tax'

  const allDebts = useMemo(
    () => accounts.filter((a) => isDebt(a)).sort(byPayoffOrder),
    [accounts],
  )

  /**
   * Cleared debts collapse into a count rather than filling rows in the queue.
   *
   * Nine open debts and four zeroes read as thirteen problems. The four are kept
   * one click away because a cleared account is still an account, and a reader
   * checking whether something really did go to zero should not have to take the
   * page's word for it.
   */
  const openDebts = useMemo(() => allDebts.filter((a) => !isCleared(a)), [allDebts])
  const clearedDebts = useMemo(() => allDebts.filter((a) => isCleared(a)), [allDebts])

  const cash = useMemo(
    () => accounts.filter((a) => !isDebt(a)).sort(byPayoffOrder),
    [accounts],
  )

  /**
   * "Connected" means a bank is actually attached — not merely that the account
   * was seeded with the intention of syncing one day. is_manual records intent; an
   * account with no plaid_account_id is showing a figure somebody typed, whatever
   * the intent was, and calling it synced implies a live balance that does not
   * exist.
   */
  const isTyped = (a: Account) => !a.plaid_account_id

  /** Every account whose balance is typed in, whatever kind it is. */
  const manual = useMemo(
    () => accounts.filter(isTyped).sort(byPayoffOrder),
    [accounts],
  )

  /** Debts still showing the figure typed in at plan start rather than a live one. */
  const unlinkedCount = accounts.filter(
    (a) => !a.plaid_account_id && !a.is_manual && ['card', 'loan', 'tax'].includes(a.kind),
  ).length

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

  /** Assets seed the same way and for the same reason: a refresh must not eat a half-typed valuation. */
  const assetSig = useMemo(
    () => assets.map((a) => `${a.id}:${assetSeedValue(a)}`).join('|'),
    [assets],
  )

  useEffect(() => {
    const next: Record<string, string> = {}
    for (const a of assets) next[a.id] = assetSeedValue(a)
    setAssetSeed(next)
    setAssetValues((prev) => {
      const merged = { ...next }
      for (const a of assets) {
        const was = prev[a.id]
        if (was !== undefined && was !== assetSeed[a.id]) merged[a.id] = was
      }
      return merged
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetSig])

  const changed = manual.filter((a) => (values[a.id] ?? '') !== (seed[a.id] ?? ''))
  const changedAssets = assets.filter((a) => (assetValues[a.id] ?? '') !== (assetSeed[a.id] ?? ''))
  const dirty = changed.length + changedAssets.length
  const canSave = dirty > 0 && !saving && Boolean(user)

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

  function setAssetValue(id: string, v: string) {
    setProblem(null)
    setAssetValues((prev) => ({ ...prev, [id]: v }))
  }

  /**
   * One button, two kinds of write, and they are genuinely different writes.
   *
   * A typed-in ACCOUNT balance becomes a row in balance_snapshots, because the
   * history of a balance is the whole basis of "what moved" and of every chart.
   * An ASSET has no snapshot table: its valuation is a column on the row, and the
   * figure and the date it was valued on are written together, never separately.
   * A number somebody refreshed today wearing a valuation date from March is
   * worse than a stale number honestly dated, because that date is the only thing
   * telling a reader how much to trust the figure beside it.
   *
   * They used to be two controls, Save balances here and a per-row disclosure
   * on each vehicle, which meant an edited valuation sat in a field under a button
   * that could never save it. One button now collects both; the two write paths
   * below are unchanged.
   */
  async function save() {
    if (!user || dirty === 0) return

    const invalid = [
      ...changed.filter((a) => parseAmount(values[a.id] ?? '') === null),
      ...changedAssets.filter((a) => parseAmount(assetValues[a.id] ?? '') === null),
    ]
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

    if (changed.length > 0) {
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
    }

    for (const a of changedAssets) {
      // Both columns in ONE update. Two writes could leave the figure changed and
      // the date not, which is the exact state the date column exists to prevent.
      // A plain update with a partial row needs no cast — only insert and upsert
      // resolve to `never` under the current supabase-js typings.
      const patch: Partial<AssetRow> = {
        estimated_value: parseAmount(assetValues[a.id] ?? '') as number,
        valued_on: asOf,
      }
      const { error: assetError } = await supabase.from('assets').update(patch).eq('id', a.id)
      if (assetError) {
        setProblem(assetError.message)
        setSaving(false)
        return
      }
    }

    await refresh()
    setSaving(false)
  }

  /**
   * What the bank calls this account, where the household's nickname is not
   * enough to find it.
   *
   * Two cards here carry the SAME nickname, so a row identified by name alone is
   * not identified at all. The issuer is dropped when the name already carries
   * it, which is why this is not simply institution plus mask: "Chase Amazon"
   * must not read "Chase Amazon Chase ••0000". The mask is the part always worth
   * keeping, because it is the only piece guaranteed unique and it is what the
   * bank prints. Returns null when there is nothing to add.
   */
  const bankTail = (a: Account) => {
    const inst = (a.institution ?? '').trim()
    const wantInst = inst.length > 0 && !a.name.toLowerCase().includes(inst.toLowerCase())
    return [wantInst ? inst : '', a.mask ? `••${a.mask}` : ''].filter(Boolean).join(' ') || null
  }

  /**
   * The phone's sub-line. On desktop the rate, the owner and the minimum each
   * have a column; on a 376px row they do not, so they stack under the name:
   * the same facts, said in one line instead of five cells.
   */
  function mobileSub(a: Account) {
    const parts: (string | null)[] = []
    if (isDebt(a)) {
      parts.push(rateLabel(a), `min ${minimum(a.minimum_payment)}`, bankTail(a))
    } else {
      parts.push(a.type_label, bankTail(a))
    }
    parts.push(isTyped(a) ? 'typed in' : ownerLabel(a.owner))
    return parts.filter(Boolean).join(' · ')
  }

  const lastSavedBy = lastManual?.enteredBy ? memberNames[lastManual.enteredBy] : undefined

  // Skeletons are for the first load only. refresh() after a save flips `loading`
  // back on while the rows are still in hand, and swapping the whole page for
  // placeholders there would read as a fault rather than a save.
  const showSkeleton = loading && accounts.length === 0

  /** Whether anything on the page belongs to the business. is_business, never owner. */
  const hasBusiness = accounts.some((a) => a.is_business)

  /** Read off the data, so the owner CHECK constraint is never guessed at. */
  const owners = useMemo(
    () => Array.from(new Set(accounts.map((a) => a.owner))).sort(),
    [accounts],
  )

  /** The inline balance field, identical wherever a typed-in figure is edited. */
  function balanceInput(a: Account, width: number) {
    return (
      <input
        className="b tnum"
        style={{ width }}
        inputMode="decimal"
        aria-label={`${accountLabel(a)} balance`}
        value={values[a.id] ?? ''}
        onChange={(e) => setValue(a.id, e.target.value)}
      />
    )
  }

  /** One row of the desktop Debts table. */
  function debtRow(a: Account) {
    const isTarget = a.id === targetId
    const cleared = isCleared(a)
    const moved = movement(a)

    return (
      <tr key={a.id}>
        <td>
          <span style={{ fontWeight: isTarget ? 700 : 500 }}>{a.name}</span>{' '}
          {isTarget && (
            <span className="pill" style={AMBER_PILL}>
              target
            </span>
          )}
          {a.is_business && (
            <span className="pill" style={BUSINESS_PILL}>
              business
            </span>
          )}
          {/* The bank's own name for it, where the nickname alone does not
              identify the row. Quiet, because it is only ever read when two
              names collide. */}
          {bankTail(a) && <span className="tiny muted tnum"> {bankTail(a)}</span>}
          <div>
            <EditTerms account={a} onSaved={refresh} />
          </div>
        </td>
        <td className="muted">{ownerLabel(a.owner)}</td>
        <td className="tnum">{rateLabel(a)}</td>
        <td className="num">{minimum(a.minimum_payment)}</td>
        <td className="num">
          {cleared ? (
            <span className="is-good">cleared</span>
          ) : isTyped(a) ? (
            balanceInput(a, 104)
          ) : (
            <span style={{ fontWeight: isTarget ? 700 : 400 }}>{moneyCents(a.balance)}</span>
          )}
        </td>
        <td className={`num tiny ${moved ? moved.tone : 'muted'}`}>
          {moved ? moved.short : shortAge(a.balanceUpdatedAt)}
        </td>
      </tr>
    )
  }

  /** One row of the desktop Cash table. Cash has no queue position and no rate. */
  function cashRow(a: Account) {
    return (
      <tr key={a.id}>
        <td>
          {a.name}{' '}
          {/* "Chase ••0000". Two chequing accounts at one bank are told apart by
              the last four and by nothing else. */}
          {bankTail(a) && <span className="tiny muted tnum">{bankTail(a)} </span>}
          <span className="tiny muted">{ownerLabel(a.owner)}</span>{' '}
          {a.kind === 'savings' && (
            <span
              className="pill"
              style={{ background: 'var(--green-bg)', color: 'var(--green-tx)' }}
            >
              house fund
            </span>
          )}
          {a.is_business && (
            <span className="pill" style={BUSINESS_PILL}>
              business
            </span>
          )}
        </td>
        <td className="num">
          {isTyped(a) ? balanceInput(a, 104) : moneyCents(a.balance)}
        </td>
      </tr>
    )
  }

  /** One phone row: name and facts on the left, the figure or its field flush right. */
  function mobileRow(a: Account) {
    const isTarget = a.id === targetId
    const cleared = isDebt(a) && isCleared(a)
    const moved = isDebt(a) ? movement(a) : null

    return (
      <div className="row" key={a.id}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="sm" style={{ fontWeight: isTarget ? 700 : 600 }}>
            {a.name}{' '}
            {isTarget && (
              <span className="pill" style={AMBER_PILL}>
                target
              </span>
            )}
            {a.kind === 'savings' && (
              <span
                className="pill"
                style={{ background: 'var(--green-bg)', color: 'var(--green-tx)' }}
              >
                house fund
              </span>
            )}
          </div>
          <div className="tiny muted tnum">{mobileSub(a)}</div>
          {moved && <div className={`tiny tnum ${moved.tone}`}>{moved.words}</div>}
          {/* Muted, not amber: amber is the target and nothing else, and this is
              a fact about where the money belongs rather than a target. */}
          {a.is_business && (
            <div className="tiny muted">{'business — outside the budget'}</div>
          )}
          {isDebt(a) && <EditTerms account={a} onSaved={refresh} />}
        </div>
        {cleared ? (
          <div className="tnum sm is-good">cleared</div>
        ) : isTyped(a) ? (
          balanceInput(a, 96)
        ) : (
          <div className="tnum sm" style={{ fontWeight: isTarget ? 700 : 500 }}>
            {money(a.balance)}
          </div>
        )}
      </div>
    )
  }

  /**
   * The save control, rendered once per layout.
   *
   * Desktop puts the button and the last-saved line on one row; the phone gives
   * the button the full width. Both drive the same handler and the same dirty
   * state, so there is never a question of which one saved.
   */
  function saveBlock(wide: boolean) {
    if (manual.length === 0 && assets.length === 0) return null
    return (
      <>
        <div
          style={{
            display: 'flex',
            gap: 9,
            marginTop: 14,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <button
            className="btn"
            style={wide ? { width: 'auto' } : undefined}
            disabled={!canSave}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          {lastManual?.balanceUpdatedAt && (
            <span className="tiny muted tnum">
              Last saved {relativeTime(lastManual.balanceUpdatedAt)}
              {lastSavedBy ? ` by ${lastSavedBy}` : ''}
            </span>
          )}
        </div>
        {problem && (
          <div className="tiny is-bad" style={{ marginTop: 9 }}>
            {problem}
          </div>
        )}
      </>
    )
  }

  /** The phone's debt list is capped; the rest is one line saying how much it hides. */
  const MOBILE_CAP = 7
  const mobileDebts = showAllDebts ? openDebts : openDebts.slice(0, MOBILE_CAP)
  const mobileHidden = openDebts.slice(mobileDebts.length)
  const hiddenTotal = mobileHidden.reduce((s, a) => s + a.balance, 0)

  return (
    <div className="page">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 12,
          marginBottom: 13,
        }}
      >
        <div>
          <h1 className="ph">Accounts</h1>
          <div className="sm muted tnum">
            {[plural(allDebts.length, 'debt'), `${cash.length} cash`, plural(assets.length, 'asset')].join(
              ' · ',
            )}
          </div>
        </div>
        <div className="tiny muted" style={{ whiteSpace: 'nowrap' }}>
          {lastSyncedAt ? `synced ${relativeTime(lastSyncedAt)}` : 'not synced yet'}
        </div>
      </div>

      {/* OWED, OWNED, NET. Plain ink on all three: red is a deviation from plan,
          and a household that set out owing more than it owns is not deviating
          from anything by reporting so.

          The phone drops OWNED and keeps the two figures it cannot derive from
          the rows below. Three stacked cards would push the first debt off the
          screen, and what is owned is the sum of the Cash and Assets filters. */}
      <div className="acct-sub-wide">
        <div className="g3" style={{ marginBottom: 15 }}>
          <Stat label="OWED" figure={money(debtTotal)} />
          <Stat label="OWNED" figure={money(assetsTotal + cashTotal)} />
          <Stat label="NET" figure={signedAmount(netWorth, money)} />
        </div>
      </div>
      {/* The inner div carries the flex, never .acct-sub-mobile itself: an inline
          display would outrank the media query that hides it on a desktop. */}
      <div className="acct-sub-mobile">
        <div style={{ display: 'flex', gap: 9, marginBottom: 12 }}>
          <Stat label="OWED" figure={money(debtTotal)} grow />
          <Stat label="NET" figure={signedAmount(netWorth, money)} grow />
        </div>
      </div>

      {/* A quiet rule, not a grey block, and only where there IS a business
          account to qualify.

          These figures come from useNetWorth(), which counts the business on
          BOTH sides: its cash is in what is owned and its card is in what is
          owed. That is deliberate — counting the card but not the cash would
          overstate what the household owes — but it is invisible in three
          totals, and an inclusion nobody can see reads as a bug the first time
          somebody adds the two tables up by hand. The net worth panel states
          the same fact for the same reason.

          Note this says nothing about budget buckets. Business spending never
          reaches one, and nothing on this page computes a bucket. */}
      {hasBusiness && (
        <div className="rule" style={{ marginTop: 0, marginBottom: 15 }}>
          These figures count the business on both sides: its cash is in what is
          owned, its card in what is owed. Its spending stays out of the budget.
        </div>
      )}

      {/*
        ALWAYS above the tables.
        This used to appear only while a seeded debt was still waiting to be
        connected. Once each was either linked or marked typed-in it disappeared,
        and the only remaining route to /link was a ghost button below the tables
        and the save control — present in the build, invisible in practice, which
        is indistinguishable from missing to anyone trying to add an account.
        There is no nav entry for /link, so this IS the entry point.
      */}
      <AddAccount
        owners={owners}
        unlinkedCount={unlinkedCount}
        onLink={() => navigate('/link')}
        onAdded={() => void refresh()}
      />

      {error && (
        <div className="banner banner--red tiny" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      {showSkeleton ? (
        <>
          <div className="skeleton" style={{ width: 96, height: 10, marginBottom: 10 }} />
          <SkeletonRows count={8} />
          <div className="skeleton" style={{ width: 96, height: 10, margin: '20px 0 10px' }} />
          <SkeletonRows count={4} />
          <div className="skeleton" style={{ height: 46, marginTop: 16 }} />
        </>
      ) : (
        <>
          {/*
            The two layouts, switched in CSS rather than in JavaScript.

            .acct-sub-wide and .acct-sub-mobile are index.css's existing pair for
            exactly this page: the first appears only at >=1024px, the second only
            below it. A matchMedia hook would decide the same thing in JS and
            flicker through the wrong layout on first paint. Both trees are bound
            to the same values/assetValues state, so whichever one is on screen is
            editing the same figures.
          */}
          <div className="acct-sub-wide">
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Debts</div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Account</th>
                  <th style={{ width: 74 }}>Owner</th>
                  <th style={{ width: 70 }}>Rate</th>
                  <th className="num" style={{ width: 78 }}>
                    Minimum
                  </th>
                  <th className="num" style={{ width: 118 }}>
                    Balance
                  </th>
                  <th className="num" style={{ width: 82 }}>
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody>
                {openDebts.length === 0 && clearedDebts.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="tiny muted">
                      No debts on record.
                    </td>
                  </tr>
                ) : (
                  <>
                    {openDebts.map(debtRow)}
                    {showCleared && clearedDebts.map(debtRow)}
                  </>
                )}
              </tbody>
            </table>

            {clearedDebts.length > 0 && (
              <button
                type="button"
                className="tiny muted tnum"
                onClick={() => setShowCleared((v) => !v)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '6px 0 0',
                  font: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {showCleared ? '− hide' : '+'} {clearedDebts.length} cleared or zero
              </button>
            )}

            <div className="g2" style={{ marginTop: 15 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Cash</div>
                {cash.length === 0 ? (
                  <div className="tiny muted" style={{ padding: '10px 0' }}>
                    No cash accounts on record.
                  </div>
                ) : (
                  <table className="tbl">
                    <tbody>{cash.map(cashRow)}</tbody>
                  </table>
                )}
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Assets</div>
                <AccountsAssets
                  variant="table"
                  values={assetValues}
                  onChange={setAssetValue}
                />
              </div>
            </div>

            {saveBlock(true)}
          </div>

          <div className="acct-sub-mobile">
            {/* Three filters rather than three stacked sections: a phone scrolls
                past what it is not being asked about, and a debt queue read
                through four vehicles is not a queue. */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
              {(['debts', 'cash', 'assets'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className="pill"
                  onClick={() => setTab(t)}
                  style={
                    tab === t
                      ? { background: 'var(--ink)', color: '#fff', textTransform: 'capitalize' }
                      : {
                          background: 'var(--white)',
                          color: 'var(--steel)',
                          border: '1px solid var(--line)',
                          textTransform: 'capitalize',
                        }
                  }
                >
                  {t}
                </button>
              ))}
            </div>

            {tab === 'debts' && (
              <>
                {mobileDebts.map(mobileRow)}
                {showCleared && clearedDebts.map(mobileRow)}
                {mobileHidden.length > 0 && (
                  <button
                    type="button"
                    className="tiny muted tnum"
                    onClick={() => setShowAllDebts(true)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: '7px 0 0',
                      font: 'inherit',
                      cursor: 'pointer',
                    }}
                  >
                    + {mobileHidden.length} more {'·'} {money(hiddenTotal)}
                  </button>
                )}
                {clearedDebts.length > 0 && (
                  <button
                    type="button"
                    className="tiny muted"
                    onClick={() => setShowCleared((v) => !v)}
                    style={{
                      display: 'block',
                      background: 'none',
                      border: 'none',
                      padding: '7px 0 0',
                      font: 'inherit',
                      cursor: 'pointer',
                    }}
                  >
                    {showCleared ? '− hide' : '+'} {clearedDebts.length} cleared or zero
                  </button>
                )}
              </>
            )}

            {tab === 'cash' && cash.map(mobileRow)}

            {tab === 'assets' && (
              <AccountsAssets variant="rows" values={assetValues} onChange={setAssetValue} />
            )}

            {saveBlock(false)}
          </div>
        </>
      )}
    </div>
  )
}

/** One of the three figures across the top. The label is smaller than the figure. */
function Stat({ label, figure, grow }: { label: string; figure: string; grow?: boolean }) {
  return (
    <div className="stat" style={grow ? { flex: 1, padding: '10px 11px' } : undefined}>
      <div className="tiny muted" style={{ fontWeight: 700 }}>
        {label}
      </div>
      <div className="tnum" style={{ fontSize: grow ? 16 : 20, fontWeight: 800, marginTop: 2 }}>
        {figure}
      </div>
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
 * The two ways an account gets onto this page, behind one disclosure.
 *
 * Collapsed by default because adding an account is rare and reading the
 * balances is the daily act. It stays ABOVE the tables, because the last
 * time it sat below them it was reported missing while it was on screen.
 *
 * Two DISTINCT routes, each labelled with the case it is for. A prominent
 * "Connect a bank" above a faint "add by hand" read as one real action and one
 * afterthought. Store cards are the whole reason the second route exists — no
 * aggregator reaches them — so it says so.
 */
function AddAccount({
  owners,
  unlinkedCount,
  onLink,
  onAdded,
}: {
  owners: string[]
  unlinkedCount: number
  onLink: () => void
  onAdded: () => void
}) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <div style={{ marginBottom: 15 }}>
        <button
          type="button"
          className="tiny muted"
          onClick={() => setOpen(true)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            font: 'inherit',
            cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >
          Add an account
        </button>
        {unlinkedCount > 0 && (
          <span className="tiny muted tnum">
            {' · '}
            {unlinkedCount} {unlinkedCount === 1 ? 'debt shows' : 'debts show'} a figure entered by
            hand rather than a live one
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="card-panel dk-panel-cap" style={{ marginBottom: 20 }}>
      <div className="sm" style={{ fontWeight: 700, marginBottom: 3 }}>
        Add an account
      </div>
      <div className="tiny muted" style={{ marginBottom: 11, lineHeight: 1.55 }}>
        Two ways in, depending on whether a bank connection can reach it.
      </div>

      <button className="btn" onClick={onLink}>
        Connect a bank
      </button>
      <div className="tiny muted" style={{ margin: '5px 0 13px', lineHeight: 1.5 }}>
        For a bank or card that can be signed into. Balances then update on their own.
      </div>

      <AddDebt owners={owners} onAdded={onAdded} />

      <button
        type="button"
        className="tiny muted"
        onClick={() => setOpen(false)}
        style={{
          background: 'none',
          border: 'none',
          padding: '10px 0 0',
          font: 'inherit',
          cursor: 'pointer',
          textDecoration: 'underline',
        }}
      >
        Close
      </button>
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
        <div className="tiny is-bad" style={{ marginTop: 8 }}>{err}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn" disabled={!canSave} onClick={() => void save()}>
          {busy ? 'Adding…' : 'Add it'}
        </button>
        <button className="btn ghost" onClick={() => { setOpen(false); setErr(null) }}>
          Cancel
        </button>
      </div>
      {/* A caveat about what the form above does, so it is a rule: a thin left
          border under the thing it qualifies, never a filled block. */}
      <div className="rule">
        It slots into the payoff queue by rate, highest first, so nothing needs
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
        className="tiny muted tnum"
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
        {/* The due date has no column of its own in the new table, so the control
            that sets it carries it, and a debt with nothing on record says so
            rather than going quiet. */}
        {dueLabel(account.next_due_on) ?? 'terms'}
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

      {/* The same caveat the old panel carried, now as a rule. On a connected
          account the nightly Plaid write is authoritative, so anything typed
          here is temporary, and a field that silently reverts overnight is worse
          than one that says it will. */}
      <div className="rule">
        {account.plaid_account_id
          ? 'This account is connected, so the bank overwrites the rate, minimum and due date each night. Anything set here holds only until it next reports.'
          : 'The day of the month, not a date. It rolls forward on its own, and changing the rate re-orders the payoff queue.'}
      </div>

      {err && (
        <div className="tiny is-bad" style={{ marginTop: 6 }}>
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
