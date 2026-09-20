/**
 * Business classification — pure. No I/O, no React, no Supabase client.
 *
 * The business funds roughly a third of what the household lives on and has
 * until now been invisible: the provider strips every business row out of
 * `transactions` so it can never reach a household bucket, and nothing else
 * looked at it. This module is the other half of that decision — it reads the
 * business's own rows and says what each one IS, in the business's terms.
 *
 * Nothing here consults `transactions.bucket`. The categoriser stamps HOUSEHOLD
 * bucket semantics on business rows and gets them wrong in exactly the ways that
 * matter: business-to-household transfers carry `savings`, the insurance premium
 * carries `fixed`, and 24 Walmart rows totalling $1,580.55 are filed as household
 * spending. Those labels are right for the household budget, which is why they
 * exist, and wrong for a profit-and-loss.
 *
 * Amounts follow Plaid throughout and are NEVER sign-flipped in storage:
 * POSITIVE is money going out, NEGATIVE is money coming in.
 */

import { namesBusinessAccount, primaryOf } from './categorize'
import { round2 } from './avalanche'
import { MONTH_NAMES, parseDateOnly } from './format'

/** The shape this module needs from a transaction. Kept minimal so it stays pure. */
export interface BizTxn {
  id: string
  account_id: string
  posted_on: string
  name: string
  merchant_name: string | null
  amount: number
  plaid_category: string | null
}

/** The shape this module needs from an account. */
export interface BizAccountRef {
  id: string
  name: string
  owner: string
  kind: string
  mask: string | null
  payment_aliases: string[]
  is_business: boolean
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface BizContext {
  /** The business's own accounts, by id. */
  accounts: Map<string, BizAccountRef>
  /** Last-four masks of the business's own accounts. */
  businessMasks: string[]
  /**
   * Whether the business holds a card of its own. Without one, a credit-card
   * payment leaving business checking cannot be an internal transfer — it is a
   * payment to somebody else's card, and therefore a cost.
   */
  hasBusinessCard: boolean
  /** Household accounts — the other side of every draw. */
  household: BizAccountRef[]
  /**
   * The household members' display names, lowercased. The Zelle draw names a
   * PERSON, not an account, so no account-based test can reach it — see
   * classify(). Read from household_members so no first name is written here.
   */
  householdPeople: { key: string; label: string }[]
  /**
   * The clients, read from business_payers. Empty is legal and simply means every
   * deposit reports as Other — which is honest, where inventing a payer is not.
   */
  payers: BusinessPayer[]
}

export function buildContext(
  accounts: BizAccountRef[],
  memberNames: Record<string, string>,
  payers: BusinessPayer[] = [],
): BizContext {
  const business = accounts.filter((a) => a.is_business)
  const household = accounts.filter((a) => !a.is_business)

  return {
    accounts: new Map(business.map((a) => [a.id, a])),
    businessMasks: business.map((a) => a.mask).filter((m): m is string => !!m),
    hasBusinessCard: business.some((a) => a.kind === 'card'),
    household,
    householdPeople: Object.values(memberNames)
      // Under four characters the substring test in namesHousehold() is too weak
      // to be worth running, and the existing guard in categorize.ts draws the
      // same line for account names.
      .filter((n) => n.trim().length >= 4)
      .map((n) => ({ key: n.trim().toLowerCase(), label: n.trim() })),
    payers,
  }
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

export type FlowKind =
  /** A client paying the business. */
  | 'revenue'
  /** The household putting money INTO the business. Not revenue. */
  | 'household-in'
  /** Money arriving from an account that is not tracked in this app. */
  | 'outside-in'
  /** A cost reversed — a returned purchase, a points credit. */
  | 'refund'
  /** The mirror of a payment, recorded on the business card that received it. */
  | 'card-credit'
  /** A real cost of running the business. */
  | 'cost'
  /** Business money reaching the household. */
  | 'draw'
  /** Money leaving to an account that is not tracked in this app. */
  | 'outside-out'
  /** One business account paying another. Nets to zero across the business. */
  | 'internal'

/**
 * A payer's id from business_payers, or 'other' for anything unmatched.
 *
 * Deliberately a plain string rather than a union of client names: the union
 * would put them in source, and this repository is public.
 */
export type PayerKey = string

/** A client, as business_payers records them. */
export interface BusinessPayer {
  key: string
  /** Lowercased ACH descriptor fragment to match on. */
  needle: string
  label: string
}

/** The bucket every unmatched deposit falls to. Reported, never dropped. */
export const OTHER_PAYER: PayerKey = 'other'

export type CostCategory =
  | 'labour'
  | 'insurance'
  | 'tax'
  | 'software'
  | 'violations'
  | 'tolls'
  | 'fuel'
  | 'supplies'
  | 'meals'
  | 'fees'
  | 'other'

export interface Flow {
  kind: FlowKind
  /** Set on 'revenue'. */
  payer?: PayerKey
  /** Set on 'cost'. */
  category?: CostCategory
  /** Set on 'draw', 'outside-in' and 'outside-out' — where the money went or came from. */
  destination?: string
}

// ---------------------------------------------------------------------------
// Payers
// ---------------------------------------------------------------------------

/**
 * The clients' names appear NOWHERE in the transaction data, and they are not
 * written here either.
 *
 * Their descriptors are raw ACH company names that share no word with the
 * trading names, so searching for a client's actual name returns nothing and
 * every deposit would fall to Other — which would then be the largest revenue
 * category on a chart whose whole subject is who pays this business. The
 * fragments that DO match live in the business_payers table, for the same reason
 * the household members' names are not enumerated in database.types.ts and the
 * business's own name is read from payment_aliases: this repository is public
 * and a client relationship is not ours to publish.
 *
 * Matching is anchored on "orig co name:" so a token cannot fire on something
 * incidental, such as a company name quoted in a memo field.
 */
const PAYER_ANCHOR = 'orig co name:'

/**
 * Which client paid.
 *
 * NEVER derived from plaid_category. Plaid files the SAME payer under three
 * different income subtypes — one client's rows arrive as INCOME_SALARY,
 * INCOME_OTHER and INCOME_CONTRACTOR alike — so a payer read off the category
 * would split one client into three and merge two into one. The category is used
 * only to confirm
 * that an unrecognised deposit is income at all.
 *
 * And note what is NOT tested here: every one of these deposits also carries
 * "IND NAME:5Star.5655", the RECEIVING business. Any rule keyed on the business's
 * own name or on its payment alias matches every payer equally and tells you
 * nothing.
 */
function payerOf(haystack: string, payers: BusinessPayer[]): PayerKey {
  for (const p of payers) {
    const needle = p.needle.startsWith(PAYER_ANCHOR) ? p.needle : PAYER_ANCHOR + p.needle
    if (haystack.includes(needle)) return p.key
  }
  return OTHER_PAYER
}

// ---------------------------------------------------------------------------
// Internal transfer descriptors
// ---------------------------------------------------------------------------

/**
 * "Online Transfer to CHK ...0000", "Online Transfer from SAV ...0000".
 *
 * Captures the direction and the last four, so the destination can be looked up
 * rather than guessed. The whole point of parsing the mask out is that a mask we
 * do not recognise must be REPORTED as unrecognised — see classify(). An
 * else-branch that swallowed it would have counted $2,000 of transfers to
 * "SAV ...4677", an account that is not one of ours, as part of the household's
 * draw.
 */
const ONLINE_TRANSFER = /online transfer (to|from)\s+[a-z]{2,4}\s*\.{2,}\s*(\d{3,6})/

/**
 * Which household account, if any, this descriptor names.
 *
 * Reuses namesBusinessAccount() from categorize.ts rather than reimplementing the
 * match. Its body is generic — "does this descriptor name one of these accounts"
 * — so pointing it at the HOUSEHOLD's aliases and masks detects a
 * business-to-household payment. The part that must not be rewritten is the mask
 * guard: it only accepts a last four after "...", x, *, # or "ending in", because
 * four bare digits match an ACH trace number constantly, and every deposit
 * descriptor in this data carries "TRACE#:051000017282430".
 *
 * Asked one account at a time so the answer is WHICH account, not merely whether.
 * The draw is worth reporting by destination: $1,025.00 of it went to a household
 * credit card, not to household checking, and a yes/no test would have hidden
 * that.
 *
 * Only payment_aliases are passed as names, never the account's nickname. One
 * household checking account is literally called "Checking" and another "PayPal",
 * and matching those as substrings against a bank descriptor would fire on
 * wording that has nothing to do with the account. An alias exists for precisely
 * this job — one card carries "payment to chase card ending in 0000", which
 * is the descriptor verbatim.
 */
function householdAccountFor(haystack: string, ctx: BizContext): BizAccountRef | null {
  for (const a of ctx.household) {
    const names = a.payment_aliases ?? []
    const masks = a.mask ? [a.mask] : []
    if (namesBusinessAccount(haystack, names, masks)) return a
  }
  return null
}

function householdByMask(mask: string, ctx: BizContext): BizAccountRef | null {
  return ctx.household.find((a) => a.mask === mask) ?? null
}

/**
 * Does this descriptor name the BUSINESS itself?
 *
 * The discriminator for a payee both sides use. The IRS receives the business's
 * own payroll tax AND the household's instalment agreement out of the same
 * account, under the same "ORIG CO NAME:IRS" descriptor and the same
 * GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT category — so the payee cannot say whose
 * debt is being paid and neither can Plaid. What separates them is the ACH
 * individual name: the payroll tax carries "IND NAME:THE BUSINESS'S OWN NAME",
 * the instalment carries the person's name.
 *
 * Read from the business account's own payment_aliases rather than written here,
 * for the same reason the household member names are: a company name typed into
 * this file is a rule that silently stops working when the alias is edited.
 */
function namesOwnBusiness(haystack: string, ctx: BizContext): boolean {
  for (const a of ctx.accounts.values()) {
    if (namesBusinessAccount(haystack, a.payment_aliases ?? [], a.mask ? [a.mask] : [])) return true
  }
  return false
}

function drawLabel(a: BizAccountRef): string {
  const who = a.owner === 'joint' ? 'Joint' : a.owner.charAt(0).toUpperCase() + a.owner.slice(1)
  return `${who} · ${a.name}`
}

// ---------------------------------------------------------------------------
// Cost categories
// ---------------------------------------------------------------------------

export const COST_LABEL: Record<CostCategory, string> = {
  labour: 'Labour',
  insurance: 'Insurance',
  tax: 'Tax',
  software: 'Software',
  violations: 'Toll violations',
  tolls: 'Tolls',
  fuel: 'Fuel',
  supplies: 'Supplies & retail',
  meals: 'Meals',
  fees: 'Bank & card fees',
  other: 'Everything else',
}

/**
 * The order categories are listed and coloured in. Largest first is tempting and
 * wrong: a category would change colour from one month to the next as the ranking
 * moved. This order is fixed.
 */
export const COST_ORDER: CostCategory[] = [
  'labour',
  'insurance',
  'tax',
  'supplies',
  'tolls',
  'violations',
  'software',
  'fuel',
  'meals',
  'fees',
  'other',
]

/**
 * What kind of cost this is.
 *
 * Order matters, and each early rule exists because the obvious later one is
 * wrong about it. `other` is a REAL category, not a rounding bin: Amazon, Walmart
 * and Sam's alone run past $7,700 over the window, more than tolls, fuel, software
 * and fees combined, so a chart of only the seven named categories would understate
 * costs by roughly a third. Every cost lands in exactly one of these, which is what
 * makes the reconciliation in summarise() hold.
 */
function costCategoryOf(haystack: string, plaidCategory: string | null): CostCategory {
  const pc = (plaidCategory ?? '').toUpperCase()
  const primary = primaryOf(pc)

  // Toll VIOLATIONS, before tolls.
  //
  // "CFX VES WEBSITE" is the Central Florida Expressway's Violation Enforcement
  // System — a penalty, not a toll — and Plaid files it under
  // TRANSPORTATION_TOLLS alongside the genuine E-Pass top-ups. A second penalty
  // stream, "NIC*-LEECNTYBOCC VIOLAT", sits under GOVERNMENT_AND_NON_PROFIT
  // instead. Folded into tolls these vanish into a plausible-looking line, and
  // unnoticed penalties are exactly the cost this page exists to surface.
  if (haystack.includes('cfx ves') || /\bviolat/.test(haystack)) return 'violations'

  if (pc === 'TRANSPORTATION_TOLLS') return 'tolls'
  if (pc === 'TRANSPORTATION_GAS') return 'fuel'

  // "VSP*HYPHEN SOLUTIONS" is BUILDER SOFTWARE. Plaid files it MEDICAL_EYE_CARE
  // because VSP reads as Vision Service Plan — so left on the category map a
  // pressure-washing company reports monthly medical spending and its only
  // software line disappears.
  //
  // Matched on "vsp*" with the star, NOT on a bare "vsp". A bare match also
  // catches "Zelle payment to Yanelis JPM99c9vspps" — the letters happen to fall
  // inside a Zelle reference — which would move $1,360.00 of labour into software
  // in a single month.
  if (haystack.includes('vsp*') || haystack.includes('hyphen solutions')) return 'software'
  if (haystack.includes('adobe')) return 'software'

  if (pc === 'GENERAL_SERVICES_INSURANCE') return 'insurance'

  // Tax. The IRS instalment carries no payment word at all, and the state's
  // descriptor names the department rather than the tax. "co name:irs" is
  // anchored because a bare "irs" is three letters inside a great many words.
  //
  // Everything reaching here is the BUSINESS's own tax, and only because the draw
  // test above already took the household's share out. Both survivors name the
  // business — "IND NAME:the business's own name" on the state row, "IND NAME:5
  // STAR CLEANING & PRES" on the federal payroll rows.
  //
  // Do not be tempted to drop the draw test on the grounds that Plaid files these
  // under GOVERNMENT_AND_NON_PROFIT rather than LOAN_PAYMENTS. That was the
  // original reasoning and it was wrong: the household's instalment agreement is
  // paid from this account under exactly this category, so the category cannot
  // separate whose tax it is and the ACH individual name is what does.
  if (pc === 'GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT') return 'tax'
  if (haystack.includes('co name:irs') || haystack.includes('dept revenue')) return 'tax'

  // Labour. Everything reaching here with this category has already failed the
  // household-person test in classify(), so it is a payment to a crew member.
  if (pc === 'TRANSFER_OUT_TRANSFER_OUT_FROM_APPS') return 'labour'

  if (primary === 'BANK_FEES') return 'fees'
  if (primary === 'GENERAL_MERCHANDISE' || primary === 'HOME_IMPROVEMENT') return 'supplies'
  if (primary === 'FOOD_AND_DRINK') return 'meals'

  return 'other'
}

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

/**
 * What one business row is.
 *
 * Every row returns exactly one flow, so the month totals below add up by
 * construction rather than by each caller remembering what to leave out.
 */
export function classify(t: BizTxn, ctx: BizContext): Flow {
  const account = ctx.accounts.get(t.account_id)
  const haystack = `${t.name ?? ''} ${t.merchant_name ?? ''}`.toLowerCase()
  const onCard = account?.kind === 'card'
  const transfer = ONLINE_TRANSFER.exec(haystack)

  // ---- Money IN -----------------------------------------------------------
  if (t.amount < 0) {
    if (onCard) {
      // Money arriving on a card is normally the mirror of the payment that left
      // the checking account, and counting both would double it. A REFUND is also
      // money in and is not a payment — the "Amazon Pay With Points Credit" that
      // cancels its own charge — so it stays a refund and offsets the cost.
      const primary = primaryOf(t.plaid_category)
      if (primary === 'LOAN_PAYMENTS' || primary === 'TRANSFER_IN') {
        return { kind: 'card-credit' }
      }
      return { kind: 'refund' }
    }

    // A client payment. Checked before the transfer shapes because it is the one
    // thing on this page that has to be right.
    const payer = payerOf(haystack, ctx.payers)
    if (payer !== 'other') return { kind: 'revenue', payer }

    // Inbound on the business checking account is NOT all revenue.
    //
    // "Online Transfer from CHK ...0000" and "Online Transfer from SAV ...0000"
    // are the HOUSEHOLD funding the business — $9,856.00 over the window, and
    // $2,485.00 of it in a single April transfer. Counted as revenue they
    // overstate April by about $2,500 and invert the break-even story the page
    // exists to tell.
    if (transfer) {
      const mask = transfer[2]
      const hh = householdByMask(mask, ctx)
      if (hh) return { kind: 'household-in', destination: drawLabel(hh) }
      if (ctx.businessMasks.includes(mask)) return { kind: 'internal' }
      return { kind: 'outside-in', destination: `an account ending ${mask}, not tracked here` }
    }

    // plaid_category is used HERE and only here: to confirm that an unrecognised
    // deposit is income at all. It never decides who paid.
    if (primaryOf(t.plaid_category) === 'INCOME') return { kind: 'revenue', payer: 'other' }

    // Anything else arriving is a cost coming back — a returned purchase.
    return { kind: 'refund' }
  }

  // ---- Money OUT ----------------------------------------------------------

  // An internal-transfer descriptor, routed by the mask it names.
  if (transfer) {
    const mask = transfer[2]
    const hh = householdByMask(mask, ctx)
    if (hh) return { kind: 'draw', destination: drawLabel(hh) }
    if (ctx.businessMasks.includes(mask)) return { kind: 'internal' }
    // NOT a draw, and deliberately not swallowed by an else-branch either.
    // "Online Transfer to SAV ...4677" names a mask that belongs to none of our
    // accounts. Three rows, $2,000.00. Counting it as a draw overstates what the
    // household received; dropping it silently loses $2,000 of the business's
    // money with nothing on screen to say so.
    return { kind: 'outside-out', destination: `an account ending ${mask}, not tracked here` }
  }

  // Business money paying a HOUSEHOLD debt directly is a draw, whatever Plaid
  // files the row under. $1,025.00 went straight to the household's one card
  // card across three rows and never touched household checking — which is the
  // reason the draw can never be computed from the household side.
  //
  // The tax category has to be tested here alongside LOAN_PAYMENTS, because the
  // household's IRS instalment agreement is being paid out of the business
  // account: three rows, $868.00 ($300.00, then $284.00 twice, which is that
  // agreement's payment_amount to the cent on its payment_day). Left to fall
  // through, they were reported as a cost of running the business — so the page
  // both overstated business tax by $868.00 and understated the draw by the same,
  // while the household's payoff page counted the very debt they were paying off.
  //
  // Guarded by namesOwnBusiness() because the SAME payee takes the business's own
  // payroll tax, $4,236.00 across two rows under an identical descriptor and
  // category. Without the guard those become a draw and the error simply reverses.
  // The guard is a no-op for the LOAN_PAYMENTS rows — none of the card payments
  // names the business — so it is applied to both rather than bolted onto one.
  if (
    primaryOf(t.plaid_category) === 'LOAN_PAYMENTS' ||
    (t.plaid_category ?? '').toUpperCase() === 'GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT'
  ) {
    const hh = householdAccountFor(haystack, ctx)
    if (hh && !namesOwnBusiness(haystack, ctx)) return { kind: 'draw', destination: drawLabel(hh) }
  }

  if (primaryOf(t.plaid_category) === 'LOAN_PAYMENTS') {
    // It may be the business paying its own card. These five rows
    // ($393.00) line up to the cent and to the day with the "Autopay Payment"
    // credits on the Amazon Business card, so they are the funding leg of an
    // internal payment, not a cost and not a draw. Identified by what the
    // descriptor does NOT name rather than by the issuer's name in it, because
    // the descriptor reads "AMERICAN EXPRESS" while the card is with U.S. Bank.
    //
    // Narrowed to CREDIT_CARD_PAYMENT, and only when the business actually holds
    // a card. Accepting the whole LOAN_PAYMENTS primary swallowed a $196.02
    // payment to a debt collector (LOAN_PAYMENTS_OTHER_PAYMENT) as an internal
    // transfer — which both erased a real cost and left the internal legs
    // unbalanced, so the one figure that should always net to zero did not.
    if (
      !onCard &&
      (t.plaid_category ?? '').toUpperCase() === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' &&
      ctx.hasBusinessCard
    ) {
      return { kind: 'internal' }
    }
  }

  // The Zelle draw and Zelle labour share ONE plaid_category
  // (TRANSFER_OUT_TRANSFER_OUT_FROM_APPS), so the category cannot separate them.
  //
  // No account test can either: "Zelle payment to A PERSON 30278244437" names a
  // person, not an account, and the trailing digits are a Zelle reference that the
  // mask guard correctly refuses to match. The household members' own display
  // names are the only signal in the row, and they come from household_members
  // rather than being written here.
  //
  // Scoped to app transfers ON PURPOSE. The business's card-payment descriptor
  // carries "IND NAME:A PERSON'S NAME", so an unscoped name test would reclassify
  // every one of those internal payments as a draw.
  if ((t.plaid_category ?? '').toUpperCase() === 'TRANSFER_OUT_TRANSFER_OUT_FROM_APPS') {
    const person = ctx.householdPeople.find((p) => haystack.includes(p.key))
    if (person) return { kind: 'draw', destination: person.label }
  }

  return { kind: 'cost', category: costCategoryOf(haystack, t.plaid_category) }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface MonthBucket {
  /** '2026-04'. */
  key: string
  /** 'April'. */
  label: string
  /** 'April 2026'. */
  longLabel: string
  revenue: number
  revenueByPayer: Record<PayerKey, number>
  costs: number
  costsByCategory: Record<CostCategory, number>
  draw: number
  fromHousehold: number
  fromOutside: number
  toOutside: number
  refunds: number
  /** The business paying its own card, and the mirror credit on it. */
  internalOut: number
  internalIn: number
  moneyIn: number
  moneyOut: number
  /** moneyIn − moneyOut. Negative means the accounts fell over the month. */
  net: number
  /** True when the record itself starts part-way through this month. */
  partial: boolean
}

export interface NamedTotal<K extends string> {
  key: K
  label: string
  total: number
}

export interface BusinessSummary {
  months: MonthBucket[]
  payers: (NamedTotal<PayerKey> & { descriptor: string })[]
  categories: NamedTotal<CostCategory>[]
  /** Where the draw landed, largest first. */
  drawDestinations: { label: string; total: number }[]
  /**
   * Accounts this app does not track that the business moved money with.
   *
   * `out` and `in` are kept apart rather than netted. Money leaving for an
   * unknown account and money arriving from one are different facts, and a single
   * net figure would read as one movement that never happened.
   */
  outside: { label: string; out: number; in: number }[]
  totals: {
    revenue: number
    costs: number
    draw: number
    fromHousehold: number
    fromOutside: number
    toOutside: number
    refunds: number
    internalOut: number
    internalIn: number
    moneyIn: number
    moneyOut: number
    net: number
  }
  /**
   * Category totals minus total costs. Zero when the breakdown accounts for every
   * cost, which is the claim the page makes in words. Kept as a number rather than
   * a boolean so a drift shows its size.
   */
  categoryResidual: number
  /** Months whose net sits inside `breakEvenBand`, counted from the latest backwards. */
  breakEvenRun: number
  /** The largest absolute net across that run. */
  breakEvenBand: number
  /** Mean money-in across the run's months. */
  runThroughput: number
}

const emptyPayers = (payers: BusinessPayer[]): Record<PayerKey, number> =>
  Object.fromEntries([...payers.map((p) => [p.key, 0]), [OTHER_PAYER, 0]]) as Record<
    PayerKey,
    number
  >

const emptyCategories = (): Record<CostCategory, number> =>
  Object.fromEntries(COST_ORDER.map((c) => [c, 0])) as Record<CostCategory, number>

/**
 * A month key straight off the ISO string.
 *
 * posted_on is a DATE column, so 'YYYY-MM-DD'.slice(0, 7) is exact and cannot
 * drift. parseDateOnly() is used for the LABEL, where a Date is genuinely needed
 * — never new Date(posted_on), which parses as UTC and can land on the previous
 * day, and so on the previous month for anything posted on the 1st.
 */
const monthKeyOf = (postedOn: string) => postedOn.slice(0, 7)

function monthLabels(key: string): { label: string; longLabel: string } {
  const d = parseDateOnly(`${key}-01`)
  return {
    label: MONTH_NAMES[d.getMonth()],
    longLabel: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`,
  }
}

/**
 * Everything the Business page reports, from one pass over the rows.
 *
 * `earliestOnRecord` is the oldest business transaction that exists anywhere, not
 * just inside the window — it is how the first month knows to call itself partial
 * rather than reporting three weeks of trading as a full month beside five whole
 * ones.
 */
export function summarise(
  txns: BizTxn[],
  ctx: BizContext,
  earliestOnRecord: string | null,
): BusinessSummary {
  const byMonth = new Map<string, MonthBucket>()
  const payers = emptyPayers(ctx.payers)
  const categories = emptyCategories()
  const drawDest = new Map<string, number>()
  const outsideDest = new Map<string, { out: number; in: number }>()
  const outsideFor = (label: string) => {
    let e = outsideDest.get(label)
    if (!e) {
      e = { out: 0, in: 0 }
      outsideDest.set(label, e)
    }
    return e
  }

  const bucketFor = (key: string): MonthBucket => {
    let m = byMonth.get(key)
    if (!m) {
      m = {
        key,
        ...monthLabels(key),
        revenue: 0,
        revenueByPayer: emptyPayers(ctx.payers),
        costs: 0,
        costsByCategory: emptyCategories(),
        draw: 0,
        fromHousehold: 0,
        fromOutside: 0,
        toOutside: 0,
        refunds: 0,
        internalOut: 0,
        internalIn: 0,
        moneyIn: 0,
        moneyOut: 0,
        net: 0,
        partial: earliestOnRecord !== null && monthKeyOf(earliestOnRecord) === key,
      }
      byMonth.set(key, m)
    }
    return m
  }

  for (const t of txns) {
    const m = bucketFor(monthKeyOf(t.posted_on))
    const flow = classify(t, ctx)
    // Money in is negative in storage; every figure below is reported positive.
    const inward = -t.amount
    const outward = t.amount

    switch (flow.kind) {
      case 'revenue': {
        const p = flow.payer ?? OTHER_PAYER
        m.revenue += inward
        m.revenueByPayer[p] += inward
        payers[p] += inward
        break
      }
      case 'household-in':
        m.fromHousehold += inward
        break
      case 'outside-in':
        m.fromOutside += inward
        outsideFor(flow.destination ?? 'an account not tracked here').in += inward
        break
      case 'refund':
        m.refunds += inward
        break
      case 'card-credit':
        m.internalIn += inward
        break
      case 'cost': {
        const c = flow.category ?? 'other'
        m.costs += outward
        m.costsByCategory[c] += outward
        categories[c] += outward
        break
      }
      case 'draw': {
        const d = flow.destination ?? 'the household'
        m.draw += outward
        drawDest.set(d, (drawDest.get(d) ?? 0) + outward)
        break
      }
      case 'outside-out':
        m.toOutside += outward
        outsideFor(flow.destination ?? 'an account not tracked here').out += outward
        break
      case 'internal':
        if (outward > 0) m.internalOut += outward
        else m.internalIn += inward
        break
    }
  }

  const months = [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key))

  for (const m of months) {
    m.moneyIn = round2(m.revenue + m.fromHousehold + m.fromOutside + m.refunds + m.internalIn)
    m.moneyOut = round2(m.costs + m.draw + m.toOutside + m.internalOut)
    m.net = round2(m.moneyIn - m.moneyOut)
    m.revenue = round2(m.revenue)
    m.costs = round2(m.costs)
    m.draw = round2(m.draw)
    m.fromHousehold = round2(m.fromHousehold)
    m.refunds = round2(m.refunds)
  }

  const sum = (pick: (m: MonthBucket) => number) => round2(months.reduce((s, m) => s + pick(m), 0))

  const totals = {
    revenue: sum((m) => m.revenue),
    costs: sum((m) => m.costs),
    draw: sum((m) => m.draw),
    fromHousehold: sum((m) => m.fromHousehold),
    fromOutside: sum((m) => m.fromOutside),
    toOutside: sum((m) => m.toOutside),
    refunds: sum((m) => m.refunds),
    internalOut: sum((m) => m.internalOut),
    internalIn: sum((m) => m.internalIn),
    moneyIn: sum((m) => m.moneyIn),
    moneyOut: sum((m) => m.moneyOut),
    net: sum((m) => m.net),
  }

  /**
   * How many whole months, counting back from the latest complete one, land
   * within a band of break-even — and how wide that band has to be.
   *
   * Computed rather than asserted. The claim the page makes is that the account
   * is drained to whatever remains each month, and a figure the code derives
   * stays true when next month's rows arrive; a sentence with a number typed into
   * it does not. Partial months are excluded: three weeks of trading is not a
   * month that came close to break-even, it is three weeks.
   */
  const whole = months.filter((m) => !m.partial && !isCurrentMonth(m.key))
  let breakEvenRun = 0
  let breakEvenBand = 0
  let runIn = 0
  const BAND = 500
  for (let i = whole.length - 1; i >= 0; i--) {
    if (Math.abs(whole[i].net) > BAND) break
    breakEvenRun += 1
    breakEvenBand = Math.max(breakEvenBand, Math.abs(whole[i].net))
    runIn += whole[i].moneyIn
  }

  return {
    months,
    // Clients in their recorded order, then Other. Label and descriptor both
    // come off the row, so nothing here names a client.
    payers: [
      ...ctx.payers.map((p) => ({
        key: p.key,
        label: p.label,
        descriptor: p.needle,
        total: round2(payers[p.key] ?? 0),
      })),
      {
        key: OTHER_PAYER,
        label: 'Other payers',
        descriptor: 'no matching ACH company name',
        total: round2(payers[OTHER_PAYER] ?? 0),
      },
    ],
    categories: COST_ORDER.map((k) => ({ key: k, label: COST_LABEL[k], total: round2(categories[k]) })),
    drawDestinations: [...drawDest.entries()]
      .map(([label, total]) => ({ label, total: round2(total) }))
      .sort((a, b) => b.total - a.total),
    outside: [...outsideDest.entries()]
      .map(([label, v]) => ({ label, out: round2(v.out), in: round2(v.in) }))
      .sort((a, b) => b.out - a.out),
    totals,
    categoryResidual: round2(
      COST_ORDER.reduce((s, k) => s + categories[k], 0) - totals.costs,
    ),
    breakEvenRun,
    breakEvenBand: round2(breakEvenBand),
    runThroughput: breakEvenRun > 0 ? round2(runIn / breakEvenRun) : 0,
  }
}

/** The month on screen is still running, so its net is not a month's net yet. */
function isCurrentMonth(key: string, now = new Date()): boolean {
  return key === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export { isCurrentMonth, monthKeyOf }
