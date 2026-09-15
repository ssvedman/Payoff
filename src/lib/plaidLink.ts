/**
 * Client for the `plaid-link` Edge Function.
 *
 * BUILD.md §2.5 originally said "no bank-linking UI". That was reversed so the
 * second household member can link her own accounts without being in the same
 * room. The reasons behind the original rule still stand, so they are enforced
 * here and in the UI rather than dropped:
 *
 *   - the item count is always visible, and the cap is hard
 *   - consuming an item needs an explicit, typed confirmation
 *   - only a signed-in household member can reach any of it (the function checks
 *     the JWT against household_members; RLS would return nothing regardless)
 *
 * Every call carries the user's own access token — never a service key, which
 * belongs nowhere near a browser.
 */

import { supabase } from './supabase'

const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/plaid-link`

export interface PlaidAccountSummary {
  account_id: string
  name: string
  official_name: string | null
  mask: string | null
  type: string
  subtype: string | null
  current: number | null
}

export interface LinkStatus {
  env: string
  itemsUsed: number
  itemCap: number
  items: { item_id: string; institution: string; status: string; last_synced: string | null }[]
  accounts: {
    id: string
    name: string
    kind: string
    plaid_account_id: string | null
    is_manual: boolean
    is_business: boolean
  }[]
}

async function call<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Not signed in.')

  let res: Response
  try {
    res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...body }),
    })
  } catch (e) {
    // fetch rejects with a bare "Failed to fetch" for anything below HTTP: a
    // blocked CORS response, DNS, or no connection. There is no status or body to
    // read, so say which of those it could be rather than repeat the browser's
    // own unhelpful wording.
    console.error('plaid-link request failed before any response', e)
    throw new Error(
      'Could not reach the server. Check your connection and try again — if it keeps failing, the bank-linking service needs attention.',
    )
  }

  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Your session is not allowed to link banks. Try signing out and back in.')
    }
    throw new Error(json.error ?? `Request failed (${res.status})`)
  }
  return json as T
}

export const linkStatus = () => call<LinkStatus>('status')

export const createLinkToken = () =>
  call<{ link_token: string; hosted_link_url: string | null; hostedSupported: boolean }>('create', {
    hosted: true,
  })

export const updateLinkToken = (itemId: string) =>
  call<{ link_token: string; hosted_link_url: string | null }>('update', { item_id: itemId })

export const pollLink = (linkToken: string) =>
  call<{ complete: boolean; public_token: string | null; institution: string | null }>('poll', {
    link_token: linkToken,
  })

export const exchangeLink = (publicToken: string, institution: string) =>
  call<{ item_id: string; institution: string }>('exchange', {
    public_token: publicToken,
    institution,
  })

export interface InstitutionHit {
  institution_id: string
  name: string
  products: string[]
  oauth: boolean
}

/** Costs nothing and consumes no item. Check before committing one. */
export const searchInstitutions = (query: string) =>
  call<{ query: string; institutions: InstitutionHit[] }>('institutions', { query })

export const itemAccounts = (itemId: string) =>
  call<{ item_id: string; accounts: PlaidAccountSummary[] }>('accounts', { item_id: itemId })

export const mapAccount = (accountId: string, plaidAccountId: string, institution?: string) =>
  call<{ mapped: string }>('map', {
    account_id: accountId,
    plaid_account_id: plaidAccountId,
    institution: institution?.trim(),
  })

export const createCheckingAccount = (
  name: string,
  plaidAccountId: string,
  opts: { isBusiness?: boolean; owner?: string; institution?: string } = {},
) =>
  call<{ created: unknown }>('create_checking', {
    name,
    plaid_account_id: plaidAccountId,
    is_business: opts.isBusiness ?? false,
    owner: opts.owner ?? 'joint',
    institution: opts.institution?.trim(),
  })
