/**
 * Minimal Plaid client. Production from day one — the Trial plan returns real
 * bank data, so there is no sandbox phase.
 *
 * Sign conventions, which must not be "corrected" anywhere downstream:
 *   - balances.current on a credit account is POSITIVE when money is owed.
 *   - balances.current on a loan is the principal remaining, also positive.
 *   - transaction.amount is POSITIVE when money LEAVES the account. Purchases are
 *     positive; payments, deposits and refunds are negative.
 */

const PLAID_ENV = Deno.env.get('PLAID_ENV') ?? 'production'
const CLIENT_ID = Deno.env.get('PLAID_CLIENT_ID') ?? ''
const SECRET = Deno.env.get('PLAID_SECRET') ?? ''

const HOSTS: Record<string, string> = {
  production: 'https://production.plaid.com',
  sandbox: 'https://sandbox.plaid.com',
}

export const PLAID_HOST = HOSTS[PLAID_ENV] ?? HOSTS.production

export class PlaidError extends Error {
  constructor(
    public code: string,
    public type: string,
    message: string,
    public requestId?: string,
  ) {
    super(message)
    this.name = 'PlaidError'
  }
}

/**
 * One institution must not be able to hang the whole night.
 *
 * fetch has no default timeout, the nightly run walks every item in sequence, and
 * an Edge Function is killed by the platform when it runs too long — so a single
 * unresponsive bank took every item after it down with it, silently, with no
 * report written. 30s is generous for Plaid and far below the function ceiling.
 */
const REQUEST_TIMEOUT_MS = 30_000

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(`${PLAID_HOST}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PLAID-CLIENT-ID': CLIENT_ID,
        'PLAID-SECRET': SECRET,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new PlaidError(
        'REQUEST_TIMEOUT',
        'API_ERROR',
        `Plaid ${path} did not respond within ${REQUEST_TIMEOUT_MS / 1000}s`,
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }

  const json = await res.json().catch(() => ({}))

  if (!res.ok) {
    throw new PlaidError(
      json.error_code ?? 'HTTP_ERROR',
      json.error_type ?? 'UNKNOWN',
      json.error_message ?? `Plaid ${path} returned ${res.status}`,
      json.request_id,
    )
  }

  return json as T
}

export interface PlaidBalances {
  available: number | null
  current: number | null
  limit: number | null
  iso_currency_code: string | null
}

export interface PlaidAccount {
  account_id: string
  name: string
  official_name: string | null
  mask: string | null
  type: string
  subtype: string | null
  balances: PlaidBalances
}

export interface PlaidApr {
  apr_percentage: number
  apr_type: string
  balance_subject_to_apr: number | null
  interest_charge_amount: number | null
}

export interface PlaidCreditLiability {
  account_id: string
  aprs: PlaidApr[]
  is_overdue: boolean | null
  last_payment_amount: number | null
  last_payment_date: string | null
  last_statement_balance: number | null
  last_statement_issue_date: string | null
  minimum_payment_amount: number | null
  next_payment_due_date: string | null
}

export interface PlaidTransaction {
  transaction_id: string
  account_id: string
  amount: number
  date: string
  authorized_date: string | null
  name: string
  merchant_name: string | null
  pending: boolean
  pending_transaction_id: string | null
  personal_finance_category: { primary: string; detailed: string } | null
}

export function balanceGet(accessToken: string) {
  return call<{ accounts: PlaidAccount[] }>('/accounts/balance/get', {
    access_token: accessToken,
  })
}

export function liabilitiesGet(accessToken: string) {
  return call<{
    accounts: PlaidAccount[]
    liabilities: { credit: PlaidCreditLiability[] | null }
  }>('/liabilities/get', { access_token: accessToken })
}

export interface SyncPage {
  added: PlaidTransaction[]
  modified: PlaidTransaction[]
  removed: { transaction_id: string }[]
  next_cursor: string
  has_more: boolean
}

export function transactionsSyncPage(accessToken: string, cursor: string | null) {
  const body: Record<string, unknown> = { access_token: accessToken, count: 500 }
  // Omit cursor entirely on first sync — sending null is not the same as absent.
  if (cursor) body.cursor = cursor
  return call<SyncPage>('/transactions/sync', body)
}

/**
 * Drain /transactions/sync to completion.
 *
 * If the Item mutates mid-pagination Plaid returns
 * TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION; the documented recovery is to
 * discard what we have and restart from the ORIGINAL cursor, not the partial one.
 */
export async function transactionsSyncAll(
  accessToken: string,
  startCursor: string | null,
  maxRestarts = 3,
  /**
   * A hard stop on pagination. `has_more` is the institution's word for it, and a
   * bad cursor that never reports done would otherwise spin until the platform
   * kills the function — losing the whole night's run with nothing written. 500
   * pages at 500 rows is far more history than this household can have.
   */
  maxPages = 500,
): Promise<{ added: PlaidTransaction[]; modified: PlaidTransaction[]; removed: string[]; cursor: string }> {
  for (let attempt = 0; attempt <= maxRestarts; attempt++) {
    const added: PlaidTransaction[] = []
    const modified: PlaidTransaction[] = []
    const removed: string[] = []
    let cursor = startCursor
    let restart = false

    try {
      let pages = 0
      for (;;) {
        const page = await transactionsSyncPage(accessToken, cursor)
        added.push(...page.added)
        modified.push(...page.modified)
        removed.push(...page.removed.map((r) => r.transaction_id))
        cursor = page.next_cursor
        if (!page.has_more) break
        if (++pages >= maxPages) {
          throw new PlaidError(
            'TRANSACTIONS_SYNC_PAGE_LIMIT',
            'TRANSACTIONS_ERROR',
            `Stopped after ${maxPages} pages with has_more still set`,
          )
        }
      }
    } catch (err) {
      if (err instanceof PlaidError && err.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
        restart = true
      } else {
        throw err
      }
    }

    if (!restart) {
      return { added, modified, removed, cursor: cursor ?? '' }
    }
  }

  throw new PlaidError(
    'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
    'TRANSACTIONS_ERROR',
    'Item kept mutating during pagination; gave up after repeated restarts',
  )
}

/**
 * The APR to display for a card. Plaid returns several by type; the purchase APR
 * is the one that matters for a carried balance. aprs[] can legitimately be empty.
 */
export function purchaseApr(aprs: PlaidApr[] | null | undefined): number | null {
  if (!aprs || aprs.length === 0) return null

  const purchase = aprs.find((a) => a.apr_type?.toLowerCase() === 'purchase_apr')
  if (purchase && Number.isFinite(purchase.apr_percentage)) return purchase.apr_percentage

  // Fall back to the highest non-promotional rate.
  const ordinary = aprs.filter(
    (a) => !a.apr_type?.toLowerCase().includes('special') && Number.isFinite(a.apr_percentage),
  )
  if (ordinary.length === 0) return null

  return Math.max(...ordinary.map((a) => a.apr_percentage))
}
