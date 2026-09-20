/**
 * Filtering by who a transaction belongs to.
 *
 * WHAT THIS CAN AND CANNOT SAY
 *
 * There is no per-transaction record of who tapped the card, and there should
 * not be one: a person re-labelling a bucket must not be able to reassign
 * whose spending a charge was. What the data holds is `accounts.owner`, so
 * every figure here is "spending on an account in this person's name", which
 * is a different claim and a weaker one.
 *
 * It is weakest on the joint accounts, where the owner is `joint` and the
 * question has no answer at all. Those rows are their own bucket rather than
 * being split, guessed at, or quietly dropped: a household where one person
 * pays the bills from the joint account would otherwise look like the other
 * person spends everything.
 *
 * The pages state this. A filter that silently means something narrower than
 * its label is worse than no filter, because the number it produces looks
 * exactly as authoritative as the one it replaced.
 *
 * BUDGET TARGETS ARE HOUSEHOLD-WIDE AND DO NOT DIVIDE.
 *
 * `budget_lines.monthly_target` is set for the household. There is no per
 * person target and inventing one by halving would be fiction. So a filtered
 * view may report what one person spent, but it must NOT report that against
 * the household target: "$604 of $1,117" with a person's name on it is two
 * different denominators in one sentence. `ownerShare` exists to give the
 * honest version, which is a share of what was actually spent.
 */

import type { Account, Transaction } from './data'

/** `owner` as it is stored. 'joint' is a real value, not a missing one. */
export type Owner = string

/** 'everyone' is the unfiltered view, not a person. */
export type OwnerFilter = 'everyone' | Owner

/**
 * The owners actually present in the data, in a stable order.
 *
 * Derived rather than hardcoded so a third member, or a renamed one, needs no
 * code change. `joint` sorts last because it is the residue rather than a
 * person, and reading it between two names implies it is one.
 */
export function ownersPresent(accounts: Account[]): Owner[] {
  const seen = new Set<Owner>()
  for (const a of accounts) if (a.owner) seen.add(a.owner)
  return [...seen].sort((a, b) => {
    if (a === 'joint') return 1
    if (b === 'joint') return -1
    return a.localeCompare(b)
  })
}

/** "alex" as "Alex". The column stores lowercase; nothing displays it that way. */
export function ownerLabel(owner: Owner): string {
  if (owner === 'joint') return 'Joint'
  return owner.charAt(0).toUpperCase() + owner.slice(1)
}

/** Account id to owner, for deciding a transaction without re-scanning accounts. */
export function ownerByAccount(accounts: Account[]): Map<string, Owner> {
  return new Map(accounts.map((a) => [a.id, a.owner]))
}

/**
 * Whose account this row sits on, or null when the account is not loaded.
 *
 * null is returned rather than defaulting to any person: an unattributable row
 * must not silently land in someone's total.
 */
export function txnOwner(
  t: Pick<Transaction, 'account_id'>,
  owners: Map<string, Owner>,
): Owner | null {
  return owners.get(t.account_id) ?? null
}

/**
 * Narrow rows to one owner. 'everyone' passes everything through unchanged.
 *
 * A row whose account is not loaded is dropped from a filtered view and kept
 * in the unfiltered one, so the totals of the per-person views can be less
 * than the whole and never more.
 */
export function filterByOwner<T extends Pick<Transaction, 'account_id'>>(
  rows: T[],
  owner: OwnerFilter,
  owners: Map<string, Owner>,
): T[] {
  if (owner === 'everyone') return rows
  return rows.filter((t) => txnOwner(t, owners) === owner)
}

/**
 * What one owner's spending is a share OF.
 *
 * Returns the owner's total and the total across everyone on the same rows, so
 * a page can say "$604 of the $1,044 spent" — a true sentence — instead of
 * "$604 of $1,117", which measures one person against a target the whole
 * household shares.
 *
 * Money out is positive in `transactions`, matching useMonthTotals.
 */
export function ownerShare(
  rows: Transaction[],
  owner: OwnerFilter,
  owners: Map<string, Owner>,
): { owed: number; whole: number; pct: number } {
  const whole = rows.reduce((s, t) => s + t.amount, 0)
  const owed =
    owner === 'everyone'
      ? whole
      : filterByOwner(rows, owner, owners).reduce((s, t) => s + t.amount, 0)
  return { owed, whole, pct: whole > 0 ? owed / whole : 0 }
}

/**
 * Spend per owner across a set of rows, largest first.
 *
 * Rows on an account that is not loaded are left out entirely rather than
 * grouped under a blank name, and the caller can spot that by comparing the
 * sum against its own total.
 */
export function spendByOwner(
  rows: Transaction[],
  owners: Map<string, Owner>,
): { owner: Owner; total: number }[] {
  const totals = new Map<Owner, number>()
  for (const t of rows) {
    const o = txnOwner(t, owners)
    if (!o) continue
    totals.set(o, (totals.get(o) ?? 0) + t.amount)
  }
  return [...totals.entries()]
    .map(([owner, total]) => ({ owner, total }))
    .sort((a, b) => b.total - a.total)
}

/**
 * The sentence every filtered view carries.
 *
 * One string in one place, so Activity and Spending cannot describe the same
 * limitation two different ways, and so it cannot be softened on one page.
 */
export const OWNER_CAVEAT =
  'Whose spending this is comes from the account the charge sits on, not from who made it. ' +
  'Joint accounts are listed on their own rather than split between people.'
