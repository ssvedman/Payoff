/** Money and date formatting. Every figure renders with tabular numerals. */

const whole = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

const cents = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** $12,345 — headline and queue figures. */
export const money = (n: number) => whole.format(n)

/** $1,234.56 — account balances and transaction amounts. */
export const moneyCents = (n: number) => cents.format(n)

/**
 * Transaction amounts. Plaid is positive for money out, and we never flip the
 * sign in storage — so display negates for presentation only:
 * amount 25.00 (money out) renders as −$25.00, amount −25.00 (money in) as +$25.00.
 */
export const signedMoney = (amount: number) =>
  amount > 0 ? `−${cents.format(amount)}` : `+${cents.format(Math.abs(amount))}`

/**
 * Balance-sheet figures — net worth, per-vehicle equity — where a negative
 * number simply means less money and renders with a minus.
 *
 * This is the opposite of signedMoney(), which exists for Plaid transaction
 * amounts where a POSITIVE number is money going out. Passing equity to
 * signedMoney() flips every sign, and the truck at −$4,702.37 would render as
 * +$4,702.37 — an underwater vehicle reported as equity.
 */
export const signedAmount = (n: number, fmt: (v: number) => string = moneyCents) =>
  `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))}`

/** 12.5% · trailing zeros are trimmed, so 12.50 renders as "12.5%". */
export const apr = (n: number | null) => {
  if (n === null || n === undefined) return null
  return `${parseFloat(String(n))}%`
}

/** Minimum payment, whole dollars where exact: "min $100". */
export const minimum = (n: number) => whole.format(n)

export const ownerLabel = (owner: string) =>
  owner === 'joint' ? 'Joint' : owner.charAt(0).toUpperCase() + owner.slice(1)

/**
 * How an account is named everywhere in the UI: owner first, then the account.
 * "Alex · Store card", "Sam · Auto loan", "Joint · Tax plan".
 *
 * With two people sharing one queue, whose name is on a debt is the first thing
 * you need to know when reading it, so it leads rather than trailing in a
 * sub-line. One helper keeps the queue, the accounts list and the activity feed
 * from drifting apart.
 */
export const accountLabel = (a: { name: string; owner: string }) =>
  `${ownerLabel(a.owner)} \u00B7 ${a.name}`

/** What an account is called at the bank, as distinct from what it is called here. */
export interface AccountIdentity {
  name: string
  owner: string
  kind?: string | null
  institution?: string | null
  mask?: string | null
}

const KIND_WORD: Record<string, string> = {
  checking: 'checking',
  savings: 'savings',
  card: 'card',
  loan: 'loan',
  tax: 'tax plan',
}

/**
 * The same account, said well enough to go and find it.
 *
 * `accountLabel` gives the nickname the household filed it under, which is fine
 * beside a balance on the accounts list but useless under a transaction: two
 * cards here carry the SAME nickname, and another is a bare word naming neither
 * a bank nor a kind of account. This adds the institution, what sort of account
 * it is, and the bank's own last four — "Alex · Rewards · Northbank card ••4417".
 *
 * Each part is dropped when it would only repeat: an account already nicknamed
 * "Northbank checking" does not become "Northbank checking · Northbank
 * checking". The mask is the one part always worth keeping, because it is the
 * only piece guaranteed unique and it is what the bank prints.
 */
export function accountDescriptor(a: AccountIdentity): string {
  const parts = [ownerLabel(a.owner), a.name]

  const inst = (a.institution ?? '').trim()
  const kindWord = KIND_WORD[(a.kind ?? '').toLowerCase()] ?? ''
  const lowerName = a.name.toLowerCase()

  const wantInst = inst.length > 0 && !lowerName.includes(inst.toLowerCase())
  const wantKind = kindWord.length > 0 && !lowerName.includes(kindWord)

  const where = [wantInst ? inst : '', wantKind ? kindWord : ''].filter(Boolean).join(' ')
  const tail = [where, a.mask ? `\u2022\u2022${a.mask}` : ''].filter(Boolean).join(' ')
  if (tail) parts.push(tail)

  return parts.join(' \u00B7 ')
}

/** "3 days ago", "4h ago", "just now" — for last-synced and last-saved lines. */
export function relativeTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'never'
  const then = new Date(iso)
  const secs = Math.floor((now.getTime() - then.getTime()) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  return months === 1 ? 'a month ago' : `${months} months ago`
}

/** Local YYYY-MM-DD. Never use toISOString() — that shifts to UTC and can move the day. */
export function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parse a date-only column without UTC drift. */
export function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** TODAY / YESTERDAY / "Mon 12 Sept" — day group headers on /activity. */
export function dayHeading(dateStr: string, today = new Date()): string {
  const d = parseDateOnly(dateStr)
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const diff = Math.round((t.getTime() - d.getTime()) / 86400000)
  if (diff === 0) return 'TODAY'
  if (diff === 1) return 'YESTERDAY'
  return d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase()
}


/**
 * The rate line for a debt.
 *
 * A null APR is not the same fact on every kind of account. On the tax debt it
 * genuinely is a payment plan with no rate; on a CARD it means the issuer did not
 * report one this cycle — and printing "payment plan" against a credit card both
 * misdescribes it and quietly implies it is not accruing interest.
 */
export function rateLabel(a: { apr: number | null; kind: string }): string {
  if (a.apr !== null) return apr(a.apr) ?? ''
  return a.kind === 'tax' ? 'payment plan' : 'rate not reported'
}

/** How many days until a due date. Negative means past. Null when unknown. */
export function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return null
  const due = new Date(y, m - 1, d)
  const n = new Date()
  return Math.round(
    (due.getTime() - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / 86400000,
  )
}

export interface DueStatus {
  /** "due in 3 days", "due today", "5 days overdue", "paid $119 on 15 Sep". */
  label: string | null
  /** Overdue, or due within two days. The only thing that earns red. */
  urgent: boolean
  /** A payment is on record on or after the due date. */
  settled: boolean
}

/**
 * Whether a debt's next instalment is outstanding, and what to say about it.
 *
 * The due date ALONE cannot answer this. `next_due_on` is the date the issuer
 * last published, and it only advances when the next statement cuts, so an
 * account paid on its due date keeps that date for days or weeks afterwards.
 * Reading it on its own reports a bill as late for having been paid on time,
 * which is what a card paid on the 15th did: it read "5 days overdue" on the
 * 20th while being current.
 *
 * So a payment dated on or after the due date withdraws the late claim. Only
 * that claim: the payment is then stated with its amount and its date rather
 * than being summarised as "paid", because a part payment is also a payment on
 * record and this page is not entitled to decide whether it was enough. The
 * reader can see $119 against a $119 minimum and judge; they cannot see
 * anything at all if the line just says the bill is late.
 *
 * ISO dates compare correctly as strings, which is why they are not parsed
 * here: parsing both to Date and comparing would reintroduce the timezone
 * question these columns exist to avoid.
 *
 * A debt with no due date on record returns a null label and is never urgent.
 * Nothing known is not the same as nothing owed, and the callers say "terms"
 * rather than going quiet.
 */
export function dueStatus(debt: {
  next_due_on: string | null
  last_payment_on?: string | null
  last_payment_amount?: number | null
}): DueStatus {
  const due = debt.next_due_on
  if (!due) return { label: null, urgent: false, settled: false }

  const paid = debt.last_payment_on ?? null
  if (paid && paid >= due) {
    const amount =
      typeof debt.last_payment_amount === 'number' && debt.last_payment_amount > 0
        ? `${money(debt.last_payment_amount)} `
        : ''
    return {
      label: `paid ${amount}on ${shortDay(paid)}`,
      urgent: false,
      settled: true,
    }
  }

  const days = daysUntil(due)
  return {
    label: dueLabel(due),
    urgent: days !== null && days <= 2,
    settled: false,
  }
}

/** "15 Sep", for stating when something happened. */
function shortDay(iso: string): string {
  const [, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTH_NAMES[m - 1]?.slice(0, 3) ?? ''}`.trim()
}

/** "due in 3 days" / "due today" / "6 days overdue". Null when nothing is known. */
export function dueLabel(iso: string | null): string | null {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return null
  const due = new Date(y, m - 1, d)
  const today = new Date()
  const days = Math.round(
    (due.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86400000,
  )
  if (days === 0) return 'due today'
  if (days === 1) return 'due tomorrow'
  if (days > 0) return `due in ${days} days`
  if (days === -1) return '1 day overdue'
  return `${Math.abs(days)} days overdue`
}
