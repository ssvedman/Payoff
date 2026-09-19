/**
 * Categorization — BUILD.md §5.
 *
 * MIRROR OF supabase/functions/sync/categorize.ts. Deno cannot import from the
 * Vite src tree, so that file is a deliberate duplicate of this one. If you change
 * the precedence chain in one place, change it in the other.
 *
 *   1. Manual override on that transaction — never recomputed
 *   2. Funding leg — a bank row that only funds a purchase another connected
 *      feed already records at merchant level
 *   3. Merchant rule — match_text found in lowercased name or merchant_name
 *   4. Account-based — a payment to the target account is attack, a minimum to any
 *      other debt is fixed, a transfer to savings is savings, a deposit is income
 *   5. Plaid category map
 *   6. Fallback — review
 */

import type { Bucket } from './database.types'

export type { Bucket }

const PFC_PRIMARIES = [
  'INCOME',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'LOAN_PAYMENTS',
  'LOAN_DISBURSEMENTS',
  'BANK_FEES',
  'ENTERTAINMENT',
  'FOOD_AND_DRINK',
  'GENERAL_MERCHANDISE',
  'HOME_IMPROVEMENT',
  'MEDICAL',
  'PERSONAL_CARE',
  'GENERAL_SERVICES',
  'GOVERNMENT_AND_NON_PROFIT',
  'TRANSPORTATION',
  'TRAVEL',
  'RENT_AND_UTILITIES',
  'OTHER',
]

/** GENERAL_SERVICES_INSURANCE belongs to GENERAL_SERVICES. Longest prefix wins. */
export function primaryOf(detailed: string | null | undefined): string | null {
  if (!detailed) return null
  const up = detailed.toUpperCase()
  let best: string | null = null
  for (const p of PFC_PRIMARIES) {
    if ((up === p || up.startsWith(p + '_')) && (!best || p.length > best.length)) best = p
  }
  return best
}

export function bucketFromPlaidCategory(detailed: string | null | undefined): Bucket | null {
  if (!detailed) return null
  const d = detailed.toUpperCase()

  if (d === 'FOOD_AND_DRINK_GROCERIES') return 'fixed'
  if (d === 'TRANSPORTATION_GAS') return 'fixed'
  if (d === 'GENERAL_SERVICES_INSURANCE') return 'fixed'
  // Pet food is a standing household cost, not a discretionary purchase, so it
  // sits with groceries rather than with the rest of GENERAL_MERCHANDISE.
  if (d === 'GENERAL_MERCHANDISE_PET_SUPPLIES') return 'fixed'

  switch (primaryOf(d)) {
    case 'INCOME':
      return 'income'
    case 'TRANSFER_IN':
    case 'TRANSFER_OUT':
      return 'transfer'
    // Borrowed money arriving is not income. Left unmapped it fell to review, but
    // anything that later routed it to income would report a loan drawdown as
    // earnings and wreck the month view — a large loan drawdown would otherwise
    // dwarf a month of real income.
    case 'LOAN_DISBURSEMENTS':
      return 'transfer'
    // A payment to a debt we do not track is still a non-discretionary
    // obligation, so it belongs in fixed rather than review. Payments to debts we
    // DO track never reach here — step 3 has already sent them to attack (the
    // current target) or fixed (a minimum).
    case 'LOAN_PAYMENTS':
      return 'fixed'
    case 'RENT_AND_UTILITIES':
    case 'MEDICAL':
      return 'fixed'
    case 'FOOD_AND_DRINK':
    case 'ENTERTAINMENT':
    case 'GENERAL_MERCHANDISE':
    case 'PERSONAL_CARE':
      return 'optional'
    default:
      return null
  }
}

/**
 * Payment processors whose OWN feed we may also hold.
 *
 * A purchase routed through one of these lands twice: once on the processor's
 * account, naming the real merchant, and once on the bank account that funded
 * it, naming the processor. Both are true records of the same money, and
 * counting both inflated this household's spending — a $19.28 subscription was
 * counted at $38.56 every month for five months, and a $99.99 one at $199.97.
 *
 * `funding` must match ONLY the purchase-funding descriptor. A top-up moving
 * money into the processor's balance, and a repayment of the processor's credit
 * card, are different events that are NOT mirrored as purchases — matching them
 * here would erase real spending. For PayPal that means requiring the word
 * "purchase"/"payment" or the `PP*`/`PAYPAL *` prefix, and never firing on
 * "PAYPAL INST XFER".
 */
const PROCESSORS: { institution: string; funding: RegExp }[] = [
  { institution: 'paypal', funding: /\bpaypal\b[^a-z]{0,3}(purchase|payment)\b|(^|[\s*])pp\*|\bpaypal\s*\*/ },
]

/**
 * Is this bank row merely the funding leg of a purchase another feed records?
 *
 * Only true when that other feed is actually connected — `heldInstitutions` is
 * the guard. Disconnect PayPal and this stops firing, so the bank row becomes
 * the only record again and counts, rather than the spending silently vanishing.
 */
export function fundingLegFor(haystack: string, heldInstitutions: string[]): string | null {
  const held = heldInstitutions.map((i) => i.trim().toLowerCase())
  for (const p of PROCESSORS) {
    if (!held.includes(p.institution)) continue
    if (p.funding.test(haystack)) return p.institution
  }
  return null
}

export interface RuleLike {
  match_text: string
  bucket: string
  /** Optional budget line the rule also pins. */
  budget_line_id?: string | null
}

export function matchRule(
  name: string,
  merchantName: string | null | undefined,
  rules: RuleLike[],
): RuleLike | null {
  const haystack = `${name ?? ''} ${merchantName ?? ''}`.toLowerCase()
  const sorted = [...rules].sort((a, b) => b.match_text.length - a.match_text.length)
  for (const r of sorted) {
    const needle = r.match_text.trim().toLowerCase()
    if (needle && haystack.includes(needle)) return r
  }
  return null
}

/**
 * Does this descriptor name one of our accounts?
 *
 * Substring matching alone is too eager — a shop whose name matches a card's
 * name is not a payment to that card, and a dealership service invoice is not a
 * payment to the vehicle loan. Require the descriptor to also look like a payment
 * before an account-name hit counts.
 */
function namesAccount(haystack: string, accountName: string): boolean {
  const n = accountName.trim().toLowerCase()
  if (n.length < 4) return false
  return haystack.includes(n)
}

/**
 * Does this descriptor name a business account of ours?
 *
 * Two ways a bank identifies the other side of an internal transfer, and both
 * are needed: the account's last four ("Online Transfer from CHK ...1234") and
 * the legal name the business pays under, which shares no word with whatever the
 * account is nicknamed here. The names come from payment_aliases, which exists
 * for exactly this — a descriptor that stands in for an account.
 *
 * The mask is matched only where a bank actually writes one: after an ellipsis,
 * an x, a star, a hash, or "ending in". Four bare digits are far too weak on
 * their own — a transaction reference number would match one constantly.
 */
export function namesBusinessAccount(
  haystack: string,
  names: string[],
  masks: string[],
): boolean {
  for (const n of names) {
    const needle = n.trim().toLowerCase()
    if (needle.length >= 4 && haystack.includes(needle)) return true
  }
  for (const m of masks) {
    // Digits only, so this can never be turned into a pattern by stored data.
    if (!/^\d{3,6}$/.test(m)) continue
    // Not followed by another digit, so a mask does not match inside a longer run.
    if (new RegExp(`(?:\\.{2,}|[x*#]|ending in\\s*)\\s*${m}(?!\\d)`).test(haystack)) return true
  }
  return false
}

const PAYMENT_WORDS = /\b(payment|pmt|pymt|pymnt|autopay|auto pay|bill pay|billpay|epay|ach|xfer|transfer)\b/

function looksLikePayment(haystack: string, plaidCategory: string | null): boolean {
  const primary = primaryOf(plaidCategory)
  if (primary === 'LOAN_PAYMENTS') return true
  if (primary === 'TRANSFER_OUT' || primary === 'TRANSFER_IN') return true
  // An instalment to the IRS is a payment against a tracked tax debt, but Plaid
  // files it under GOVERNMENT_AND_NON_PROFIT and the descriptor
  // ("ORIG CO NAME:IRS ...") carries no payment word at all.
  if ((plaidCategory ?? '').toUpperCase() === 'GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT') return true
  return PAYMENT_WORDS.test(haystack)
}

export interface CategorizeArgs {
  name: string
  merchantName: string | null
  plaidCategory: string | null
  /** Positive = money out, exactly as Plaid reports it. Never sign-flipped. */
  amount: number
  /** The kind of the account this transaction sits on. */
  accountKind: string
  /**
   * Names and aliases of the account this row sits ON. Needed because some
   * issuers report a payment to a card from the PAYER's side — a positive amount
   * on the card itself — and that row is the mirror of the bank's outflow, not a
   * second obligation.
   */
  accountNames?: string[]
  /**
   * Lowercase institutions we hold a connected account for. Enables the
   * funding-leg step; empty disables it.
   */
  heldInstitutions?: string[]
  /** Whether the account this row sits on is itself the business's. */
  accountIsBusiness?: boolean
  /** Names and aliases of our business accounts, lowercased. */
  businessNames?: string[]
  /** Last-four masks of our business accounts. */
  businessMasks?: string[]
  /**
   * The account currently being attacked — lowest payoff_order still owing —
   * as its name plus any payment_aliases. Only payments to THIS account count
   * toward the attack fund. It is a list because a bank's statement descriptor
   * rarely contains the friendly name an account is filed under here, so the
   * aliases carry the descriptors that stand in for it.
   */
  targetNames: string[]
  /** Names AND aliases of all our debt accounts, for spotting minimum payments. */
  debtNames: string[]
  savingsNames: string[]
  rules: RuleLike[]
  existingBucketSource?: string | null
  existingBucket?: Bucket | null
}

export function categorize(a: CategorizeArgs): { bucket: Bucket; source: 'auto' | 'rule' | 'manual' } {
  // 1. A manual override is never recomputed.
  if (a.existingBucketSource === 'manual' && a.existingBucket) {
    return { bucket: a.existingBucket, source: 'manual' }
  }

  const haystack = `${a.name ?? ''} ${a.merchantName ?? ''}`.toLowerCase()

  // 2. Funding leg — BEFORE merchant rules, and deliberately so.
  //
  // A rule says "charges from this merchant are optional". It does not say
  // "count this merchant twice". Ruling the processor feed's Discord row to
  // optional also caught the bank's "PAYPAL PURCHASE DISCORD" leg, so the more
  // carefully the household labelled its spending, the more it double-counted.
  // Only a manual override on this exact row outranks this.
  if (a.amount > 0 && fundingLegFor(haystack, a.heldInstitutions ?? [])) {
    return { bucket: 'transfer', source: 'auto' }
  }

  // 3. Merchant rule.
  const rule = matchRule(a.name, a.merchantName, a.rules)
  if (rule) return { bucket: rule.bucket as Bucket, source: 'rule' }

  // 4. Account-based.
  const isDebtAccount = a.accountKind === 'card' || a.accountKind === 'loan' || a.accountKind === 'tax'

  if (isDebtAccount) {
    // Money arriving on a debt account is usually the mirror image of the payment
    // that left checking. Counting both would double-count, so the card side is a
    // transfer. But a REFUND is also money in and is not a payment — letting it
    // fall through to the category map keeps a returned purchase in the bucket the
    // purchase was in, so the refund cancels it out instead of vanishing.
    if (a.amount < 0 && looksLikePayment(haystack, a.plaidCategory)) {
      return { bucket: 'transfer', source: 'auto' }
    }

    // The same mirror, reported with the opposite sign.
    //
    // Money in is the usual shape, but one issuer here reports a payment to its
    // own card as a POSITIVE row on that card, categorized as a credit-card
    // payment and naming the card itself. Read as a charge, thirteen of those
    // were counted as fixed spending that never left any checking account. The
    // descriptor must name THIS account — a payment from this card to a
    // different debt names the other one and is a genuine outflow.
    if (
      a.amount > 0 &&
      primaryOf(a.plaidCategory) === 'LOAN_PAYMENTS' &&
      (a.accountNames ?? []).some((n) => namesAccount(haystack, n))
    ) {
      return { bucket: 'transfer', source: 'auto' }
    }
  } else if (a.amount > 0) {
    // On a spending account, an outflow that looks like a payment to one of our
    // own debts is either the attack payment or an ordinary minimum.
    if (looksLikePayment(haystack, a.plaidCategory)) {
      // Only the CURRENT TARGET receives the attack fund. plan_settings.attack_fund
      // is the surplus ABOVE the minimums, and the nine minimums are budgeted under
      // the 'fixed' line "Debt minimums" — so bucketing every debt payment as
      // 'attack' would both inflate the attack total past its target (silencing the
      // attack_missing alert, the one alert whose job is to catch a missed payment)
      // and leave the fixed line permanently unfillable.
      if (a.targetNames.some((n) => namesAccount(haystack, n))) {
        return { bucket: 'attack', source: 'auto' }
      }
      if (a.debtNames.some((n) => namesAccount(haystack, n))) {
        return { bucket: 'fixed', source: 'auto' }
      }
    }

    // A transfer into the savings account.
    //
    // The name test alone could never fire: a bank descriptor reads
    // "Online Transfer to SAV ...0000", never the friendly name the account is
    // filed under here, so the bucket was unreachable and the savings row on
    // /month sat at zero for good. Plaid's own category is the reliable signal.
    // The accountKind guard keeps money leaving the savings account out of it.
    if (
      a.accountKind !== 'savings' &&
      (a.plaidCategory ?? '').toUpperCase() === 'TRANSFER_OUT_SAVINGS'
    ) {
      return { bucket: 'savings', source: 'auto' }
    }
    if (a.savingsNames.some((n) => namesAccount(haystack, n))) {
      return { bucket: 'savings', source: 'auto' }
    }
  } else if (a.amount < 0) {
    /**
     * Money arriving from the business is the household's draw on it.
     *
     * The bank calls it an internal transfer, and left at that it was counted as
     * neither income nor anything else — so a household drawing its living from
     * its own company showed months of spending against almost no income. It is
     * the business paying the people who run it, which is exactly what income is.
     *
     * ANY household account, not just checking. Restricting it to checking was
     * an assumption about where a draw lands, and it was wrong: a standing
     * monthly contribution to the bills account arrives in a SAVINGS account and
     * is no less income for that. Where the money lands is a choice about what
     * to do with it, not evidence of what it is.
     *
     * A debt account cannot reach here — the branch above takes every row on one
     * — and that is correct rather than incidental: money arriving on a card is
     * the mirror of a payment, and calling it income would invent money.
     *
     * The reverse direction is the household putting money INTO the business.
     * That is positive, never reaches this branch, and stays a transfer rather
     * than becoming negative income.
     */
    if (
      !a.accountIsBusiness &&
      namesBusinessAccount(haystack, a.businessNames ?? [], a.businessMasks ?? [])
    ) {
      return { bucket: 'income', source: 'auto' }
    }

    // A deposit is income.
    if (primaryOf(a.plaidCategory) === 'INCOME') {
      return { bucket: 'income', source: 'auto' }
    }
  }

  // 5. Plaid category map.
  const mapped = bucketFromPlaidCategory(a.plaidCategory)
  if (mapped) return { bucket: mapped, source: 'auto' }

  // 6. Fallback.
  return { bucket: 'review', source: 'auto' }
}

/**
 * The match_text a recategorization should learn from a transaction.
 * Prefers the merchant name, which is stabler than the raw descriptor.
 */
export function ruleTextFor(t: { name: string; merchant_name?: string | null }): string {
  const base = (t.merchant_name ?? t.name ?? '').trim().toLowerCase()
  return base.slice(0, 60)
}
