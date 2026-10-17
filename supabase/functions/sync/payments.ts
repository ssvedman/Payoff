/**
 * The last payment made on each debt, read from the transactions we hold.
 *
 * `last_payment_on` used to come only from /liabilities/get, which has two gaps:
 *
 *   - It lags. One card's autopay posted on its due date while the issuer's
 *     last_payment_date still said the month before, so it read "1 day overdue"
 *     while paid.
 *   - It never covers a manual account. A store card paid two days after its
 *     due date read as overdue for as long as nobody typed anything.
 *
 * Both payments were already in the transaction feed. This finds them:
 *
 *   - A connected debt: a credit on the debt itself (negative amount) that reads
 *     as a payment — Plaid's payment or transfer-in category, or a payment word
 *     in the descriptor. The categories alone are not enough: issuers file
 *     "Payment Thank You" under INCOME_CONTRACTOR and LOAN_DISBURSEMENTS.
 *   - A manual debt: money out of a household account whose descriptor names
 *     the debt or one of its payment_aliases. A descriptor naming two manual
 *     debts proves neither and is skipped.
 *
 * Pending rows are left out: a pending payment can still vanish, and a paid
 * claim that later turns false is worse than a late one that clears a day on.
 *
 * Only ever moves the date FORWARD. An older figure from the issuer, or a
 * smaller window here, must not undo a newer payment already on record.
 */

// deno-lint-ignore no-explicit-any
type Admin = any

export interface DebtForPayments {
  id: string
  name: string
  kind: string
  plaid_account_id: string | null
  is_manual: boolean
  is_business: boolean
  payment_aliases: string[] | null
  last_payment_on: string | null
}

const PAYMENT_WORDS = /\b(payment|pmt|pymt|pymnt|autopay|auto pay)\b/i

/** How far back to look. Two cycles covers a missed night and a slow post. */
const WINDOW_DAYS = 75

function isPaymentCredit(name: string, category: string | null): boolean {
  const primary = (category ?? '').toUpperCase()
  if (primary.startsWith('LOAN_PAYMENTS') || primary.startsWith('TRANSFER_IN')) return true
  return PAYMENT_WORDS.test(name)
}

/** LIKE treats % and _ as wildcards; an alias must match only itself. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

const namesOf = (a: DebtForPayments) =>
  [a.name, ...(a.payment_aliases ?? [])]
    .map((n) => String(n ?? '').trim().toLowerCase())
    .filter((n) => n.length >= 4)

export async function recordLastPayments(
  admin: Admin,
  accounts: DebtForPayments[],
  isDebtKind: (k: string) => boolean,
  asOf: string,
): Promise<{ updated: string[]; errors: string[] }> {
  const updated: string[] = []
  const errors: string[] = []

  const since = new Date(`${asOf}T12:00:00Z`)
  since.setUTCDate(since.getUTCDate() - WINDOW_DAYS)
  const sinceIso = since.toISOString().slice(0, 10)

  const debts = accounts.filter((a) => isDebtKind(a.kind))
  const householdIds = accounts.filter((a) => !isDebtKind(a.kind) && !a.is_business).map((a) => a.id)
  const manualDebts = debts.filter((d) => d.is_manual || !d.plaid_account_id)

  for (const debt of debts) {
    let found: { posted_on: string; amount: number }[] = []

    if (debt.plaid_account_id && !debt.is_manual) {
      const { data, error } = await admin
        .from('transactions')
        .select('posted_on, amount, name, plaid_category')
        .eq('account_id', debt.id)
        .eq('pending', false)
        .lt('amount', 0)
        .gte('posted_on', sinceIso)
      if (error) {
        errors.push(`last payment unread for ${debt.name}: ${error.message}`)
        continue
      }
      found = (data ?? [])
        .filter((t: { name: string; plaid_category: string | null }) => isPaymentCredit(t.name, t.plaid_category))
        .map((t: { posted_on: string; amount: number | string }) => ({ posted_on: t.posted_on, amount: -Number(t.amount) }))
    } else {
      const mine = namesOf(debt)
      if (!mine.length || !householdIds.length) continue
      const others = manualDebts.filter((d) => d.id !== debt.id).flatMap(namesOf)
      const rows = new Map<string, { posted_on: string; amount: number; name: string }>()

      for (const n of mine) {
        const { data, error } = await admin
          .from('transactions')
          .select('id, posted_on, amount, name')
          .in('account_id', householdIds)
          .eq('pending', false)
          .gt('amount', 0)
          .gte('posted_on', sinceIso)
          .ilike('name', `%${likeEscape(n)}%`)
        if (error) {
          errors.push(`last payment unread for ${debt.name}: ${error.message}`)
          continue
        }
        for (const t of data ?? []) rows.set(String(t.id), t)
      }

      found = [...rows.values()]
        .filter((t) => {
          const hay = String(t.name ?? '').toLowerCase()
          return !others.some((o) => hay.includes(o))
        })
        .map((t) => ({ posted_on: t.posted_on, amount: Number(t.amount) }))
    }

    if (!found.length) continue

    const latest = found.reduce((m, t) => (t.posted_on > m ? t.posted_on : m), found[0].posted_on)
    if (debt.last_payment_on && latest <= debt.last_payment_on) continue

    // Two payments on one day are one payment as far as "was it paid" goes.
    const amount = Math.round(found.filter((t) => t.posted_on === latest).reduce((s, t) => s + t.amount, 0) * 100) / 100

    const { error } = await admin
      .from('accounts')
      .update({ last_payment_on: latest, last_payment_amount: amount })
      .eq('id', debt.id)
    if (error) errors.push(`last payment write failed for ${debt.name}: ${error.message}`)
    else {
      debt.last_payment_on = latest
      updated.push(`${debt.name}: ${latest}`)
    }
  }

  return { updated, errors }
}
