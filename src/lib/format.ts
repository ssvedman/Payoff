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
