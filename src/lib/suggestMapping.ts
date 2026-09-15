/**
 * Work out, without being asked, which seeded account each Plaid account is.
 *
 * The point is that nobody has to copy a UUID. Every suggestion is pre-selected
 * and confirmable in one tap, and anything the matcher is not confident about is
 * left explicitly unset rather than guessed — mapping an auto loan onto a credit
 * card row would corrupt the avalanche order, which is far worse than asking.
 */

import type { PlaidAccountSummary } from './plaidLink'

export interface SeededAccount {
  id: string
  name: string
  kind: string
  plaid_account_id: string | null
  is_manual: boolean
  opening_balance?: number
}

export type Suggestion =
  | { kind: 'map'; seededId: string; confidence: number; reason: string }
  | { kind: 'create_checking'; suggestedName: string; reason: string }
  | { kind: 'skip'; reason: string }

/** Plaid type/subtype -> the account kinds it could plausibly be. */
function compatibleKinds(a: PlaidAccountSummary): string[] {
  const type = (a.type ?? '').toLowerCase()
  const sub = (a.subtype ?? '').toLowerCase()

  if (type === 'credit') return ['card']
  if (type === 'loan') return ['loan', 'tax']
  if (type === 'depository') return sub === 'savings' ? ['savings'] : ['checking']
  return []
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

const STOPWORDS = new Set(['the', 'a', 'card', 'loan', 'account', 'bank', 'credit', 'personal'])

function nameScore(plaidName: string, seededName: string): number {
  const at = new Set(norm(plaidName).split(' ').filter((w) => w.length > 2 && !STOPWORDS.has(w)))
  const bt = new Set(norm(seededName).split(' ').filter((w) => w.length > 2 && !STOPWORDS.has(w)))
  if (at.size === 0 || bt.size === 0) return 0
  let hits = 0
  for (const w of at) if (bt.has(w)) hits++
  return hits / Math.min(at.size, bt.size)
}

/**
 * How close is the live balance to what was seeded? Seeded figures are a snapshot
 * from the plan's start date, so this is a strong hint rather than proof —
 * balances drift. Within 2% is near-certain, within 25% is suggestive.
 */
function balanceScore(current: number | null, seeded: number | undefined): number {
  if (current === null || current === undefined || !seeded || seeded <= 0) return 0
  const diff = Math.abs(Math.abs(current) - seeded) / seeded
  if (diff <= 0.02) return 1
  if (diff <= 0.1) return 0.7
  if (diff <= 0.25) return 0.4
  return 0
}

/**
 * Suggest a mapping for one Plaid account.
 *
 * `taken` holds seeded ids already claimed by earlier accounts in this batch, so
 * two Plaid accounts can never both be assigned to the same row.
 */
export function suggestFor(
  plaidAccount: PlaidAccountSummary,
  seeded: SeededAccount[],
  taken: Set<string>,
): Suggestion {
  const kinds = compatibleKinds(plaidAccount)

  if (kinds.length === 0) {
    return { kind: 'skip', reason: `Unrecognized account type "${plaidAccount.type}".` }
  }

  // A chequing account is a spending source, not a debt — it gets created rather
  // than mapped onto anything in the payoff queue.
  if (kinds.includes('checking')) {
    return {
      kind: 'create_checking',
      suggestedName: plaidAccount.official_name || plaidAccount.name,
      reason: 'Spending account — tracked for transactions, not part of the payoff queue.',
    }
  }

  const candidates = seeded
    .filter((s) => !s.plaid_account_id && !taken.has(s.id) && kinds.includes(s.kind))
    .map((s) => {
      const n = nameScore(plaidAccount.name + ' ' + (plaidAccount.official_name ?? ''), s.name)
      const b = balanceScore(plaidAccount.current, s.opening_balance)
      // Balance is weighted higher than the name: bank descriptors rarely resemble
      // the friendly names, but the figures line up.
      return { s, score: n * 0.45 + b * 0.55, n, b }
    })
    .sort((x, y) => y.score - x.score)

  if (candidates.length === 0) {
    const kindLabel = kinds.join(' or ')
    return { kind: 'skip', reason: `No unmapped ${kindLabel} account left to match.` }
  }

  const best = candidates[0]
  const runnerUp = candidates[1]

  // Refuse to guess when two rows are nearly as plausible as each other. This is
  // the common case of a credit card and an auto loan held at the same bank.
  if (runnerUp && best.score - runnerUp.score < 0.15) {
    return {
      kind: 'skip',
      reason: `Could be ${best.s.name} or ${runnerUp.s.name} — pick one rather than let me guess.`,
    }
  }

  if (best.score < 0.35) {
    return { kind: 'skip', reason: 'No confident match — choose the account yourself.' }
  }

  const why: string[] = []
  if (best.b >= 0.7) why.push('balance matches')
  else if (best.b > 0) why.push('balance is close')
  if (best.n > 0.4) why.push('name matches')
  if (why.length === 0) why.push('only candidate of this type')

  return {
    kind: 'map',
    seededId: best.s.id,
    confidence: Math.min(1, best.score),
    reason: why.join(', '),
  }
}

/** Suggest mappings for a whole item, without double-assigning a seeded row. */
export function suggestAll(
  plaidAccounts: PlaidAccountSummary[],
  seeded: SeededAccount[],
): Map<string, Suggestion> {
  const out = new Map<string, Suggestion>()
  const taken = new Set<string>()

  // Highest-confidence assignments first, so a strong match claims its row before
  // a weaker one can take it.
  const scored = plaidAccounts
    .map((a) => ({ a, s: suggestFor(a, seeded, taken) }))
    .sort((x, y) => (y.s.kind === 'map' ? y.s.confidence : 0) - (x.s.kind === 'map' ? x.s.confidence : 0))

  for (const { a } of scored) {
    const s = suggestFor(a, seeded, taken)
    if (s.kind === 'map') taken.add(s.seededId)
    out.set(a.account_id, s)
  }

  return out
}
