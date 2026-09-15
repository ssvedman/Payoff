/**
 * Categorization — BUILD.md §5.
 *
 * MIRROR OF src/lib/categorize.ts. Deno cannot import from the Vite src tree, so
 * this is a deliberate duplicate. If you change the precedence chain in one
 * place, change it in the other.
 *
 *   1. Manual override on that transaction — never recomputed
 *   2. Merchant rule — match_text found in lowercased name or merchant_name
 *   3. Account-based — a payment to the target account is attack, a minimum to any
 *      other debt is fixed, a transfer to savings is savings, a deposit is income
 *   4. Plaid category map
 *   5. Fallback — review
 */

export type Bucket =
  | 'fixed'
  | 'optional'
  | 'attack'
  | 'savings'
  | 'income'
  | 'transfer'
  | 'review'

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

  // 2. Merchant rule.
  const rule = matchRule(a.name, a.merchantName, a.rules)
  if (rule) return { bucket: rule.bucket as Bucket, source: 'rule' }

  // 3. Account-based.
  const haystack = `${a.name ?? ''} ${a.merchantName ?? ''}`.toLowerCase()
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
  } else if (a.amount < 0 && primaryOf(a.plaidCategory) === 'INCOME') {
    // A deposit is income.
    return { bucket: 'income', source: 'auto' }
  }

  // 4. Plaid category map.
  const mapped = bucketFromPlaidCategory(a.plaidCategory)
  if (mapped) return { bucket: mapped, source: 'auto' }

  // 5. Fallback.
  return { bucket: 'review', source: 'auto' }
}
