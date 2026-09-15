/**
 * `plaid-link` — the one-time linking helper. BUILD.md §5.
 *
 * BUILD.md §2.5 originally said there would be NO bank-linking UI. That was
 * reversed so the second household member can link her own accounts remotely;
 * /link in the app and scripts/link.mjs both drive this function.
 *
 * The Trial plan allows exactly 10 items and removing one does not restore the
 * allowance, so every action here is explicit and one institution at a time.
 * Access tokens go straight into Vault and are never returned to the caller.
 */

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PLAID_ENV = Deno.env.get('PLAID_ENV') ?? 'production'
const CLIENT_ID = Deno.env.get('PLAID_CLIENT_ID') ?? ''
const SECRET = Deno.env.get('PLAID_SECRET') ?? ''

const HOST = PLAID_ENV === 'sandbox' ? 'https://sandbox.plaid.com' : 'https://production.plaid.com'

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/**
 * CORS must be on EVERY response, not just the preflight.
 *
 * The browser sends the preflight, gets an allow, then blocks the actual response
 * because it carries no Access-Control-Allow-Origin — surfacing as a bare
 * "Failed to fetch" with no status and no body to diagnose from.
 *
 * apikey belongs in the allowed headers too: supabase-js style clients send it
 * alongside Authorization, and a header missing from the allow-list fails the
 * preflight on its own.
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, content-type, apikey, x-client-info, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })

async function plaid(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${HOST}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': CLIENT_ID,
      'PLAID-SECRET': SECRET,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(
      `${data.error_code ?? res.status}: ${data.error_message ?? 'Plaid request failed'}`,
    )
  }
  return data
}

/**
 * Is this token a genuine service-role key?
 *
 * Comparing it to SUPABASE_SERVICE_ROLE_KEY with === is not enough. The platform
 * injects the LEGACY service_role JWT into that variable, while the dashboard now
 * issues keys in the newer `sb_secret_…` format — so a perfectly valid secret key
 * fails a string comparison and the operator gets an unexplained "unauthorized".
 *
 * Instead, judge the token by what it can DO. plaid_token_get is SECURITY DEFINER
 * with EXECUTE granted to service_role alone, so anon and authenticated both get
 * 42501. A table probe would NOT work here: RLS returns an empty result rather
 * than an error for anon, which reads as success.
 */
async function isServiceKey(token: string): Promise<boolean> {
  if (SERVICE_KEY && token === SERVICE_KEY) return true

  try {
    const probe = createClient(SUPABASE_URL, token, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { error } = await probe.rpc('plaid_token_get', { p_item_id: '__auth_probe__' })
    // Success (null token returned) means the caller may execute a service-role
    // only function. A permission error means it may not.
    return !error
  } catch {
    return false
  }
}

/**
 * Only a signed-in household member may link a bank — or the operator running
 * scripts/link.mjs with the service role key, since linking is a deliberate
 * one-time act performed from a terminal rather than from the app.
 */
async function requireMember(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return false

  if (await isServiceKey(token)) return true

  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) return false

  const { data: member } = await admin
    .from('household_members')
    .select('user_id')
    .eq('user_id', data.user.id)
    .maybeSingle()

  return Boolean(member)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS })
  }

  if (!(await requireMember(req))) return json({ error: 'unauthorized' }, 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'expected a JSON body' }, 400)
  }

  const action = body.action as string

  try {
    switch (action) {
      /**
       * Hosted Link: Plaid serves the page and owns the OAuth round trip, so we
       * register no redirect URI of our own. That matters because several large
       * US banks use OAuth, and a production redirect_uri must be HTTPS, contain
       * no '#', and be pre-registered — http://localhost is Sandbox-only.
       */
      case 'create': {
        const useHosted = body.hosted !== false
        const payload: Record<string, unknown> = {
          client_name: 'Payoff',
          language: 'en',
          country_codes: ['US'],
          user: { client_user_id: 'payoff-household' },
          // `balance` is NOT a valid product value — it initialises automatically
          // alongside any other product.
          //
          // liabilities must go in optional_products, NOT products. Anything in
          // `products` is a hard requirement: Plaid then only permits selecting
          // accounts that support it, and shows "No liability accounts" otherwise.
          // That blocks every institution whose accounts are auto loans, personal
          // loans or plain checking — which is most of this household's. In
          // optional_products it is extracted where available (the credit cards)
          // and silently skipped everywhere else, which is exactly the documented
          // behavior: auto and personal loans return nothing and keep their
          // seeded APR and minimum.
          products: ['transactions'],
          optional_products: ['liabilities'],
          // 730 is Plaid's maximum. It only applies at link time and cannot be
          // widened later, so ask for everything up front — the six months the
          // first items were created with is all those items will ever have, and
          // nothing before it can be recovered. Supabase keeps what arrives
          // permanently (sync deletes only on Plaid's explicit removed[]), so the
          // record only ever grows from here.
          transactions: { days_requested: 730 },
        }
        if (useHosted) payload.hosted_link = {}

        const res = await plaid('/link/token/create', payload)
        return json({
          link_token: res.link_token,
          hosted_link_url: res.hosted_link_url ?? null,
          expiration: res.expiration,
          hostedSupported: Boolean(res.hosted_link_url),
        })
      }

      /**
       * Update mode — reopen account selection on an EXISTING item.
       *
       * This does NOT consume one of the ten items: it modifies the item already
       * linked. Use it when an institution returned fewer accounts than expected,
       * which normally means they were not ticked during the first selection.
       *
       * In update mode `products` must be omitted entirely; the item keeps the
       * products it was created with.
       */
      case 'update': {
        const itemId = body.item_id as string
        if (!itemId) return json({ error: 'item_id is required' }, 400)

        const { data: token, error } = await admin.rpc('plaid_token_get', { p_item_id: itemId })
        if (error || !token) return json({ error: 'no token in vault for that item' }, 404)

        const res = await plaid('/link/token/create', {
          client_name: 'Payoff',
          language: 'en',
          country_codes: ['US'],
          user: { client_user_id: 'payoff-household' },
          access_token: token,
          update: { account_selection_enabled: true },
          hosted_link: {},
        })

        return json({
          link_token: res.link_token,
          hosted_link_url: res.hosted_link_url ?? null,
          expiration: res.expiration,
          hostedSupported: Boolean(res.hosted_link_url),
        })
      }

      /** Exchange the public token, store the access token in Vault only. */
      case 'exchange': {
        const publicToken = body.public_token as string
        // Trim: the name is typed by hand and a stray space rides through into
        // every screen that lists connections.
        const institution = ((body.institution as string) ?? 'unknown').trim() || 'unknown'
        if (!publicToken) return json({ error: 'public_token is required' }, 400)

        const res = await plaid('/item/public_token/exchange', { public_token: publicToken })
        const itemId = res.item_id as string

        // Vault first. If this fails we must not record an item we cannot use.
        const { error: vaultErr } = await admin.rpc('plaid_token_set', {
          p_item_id: itemId,
          p_token: res.access_token,
        })
        if (vaultErr) throw new Error(`vault write failed: ${vaultErr.message}`)

        const { error: itemErr } = await admin
          .from('plaid_items')
          .upsert({ item_id: itemId, institution, status: 'ok' }, { onConflict: 'item_id' })
        if (itemErr) throw new Error(itemErr.message)

        return json({ item_id: itemId, institution, stored: 'vault' })
      }

      /**
       * Read back the accounts on a linked item so they can be mapped onto our
       * fixed set. Returns no token and no balances beyond what mapping needs.
       */
      case 'accounts': {
        const itemId = body.item_id as string
        if (!itemId) return json({ error: 'item_id is required' }, 400)

        const { data: token, error } = await admin.rpc('plaid_token_get', { p_item_id: itemId })
        if (error || !token) return json({ error: 'no token in vault for that item' }, 404)

        const res = await plaid('/accounts/get', { access_token: token })
        return json({
          item_id: itemId,
          accounts: (res.accounts ?? []).map((a: Record<string, unknown>) => ({
            account_id: a.account_id,
            name: a.name,
            official_name: a.official_name,
            mask: a.mask,
            type: a.type,
            subtype: a.subtype,
            current: (a.balances as Record<string, unknown>)?.current ?? null,
          })),
        })
      }

      /**
       * Search Plaid's institution directory BEFORE spending an item.
       *
       * The Trial plan allows ten items and removing one does not give it back,
       * so the expensive mistake is starting a link against a bank Plaid cannot
       * reach — the item is consumed the moment the bank login succeeds, before
       * anyone finds out no compatible account will be offered.
       *
       * This call consumes nothing. It also answers the question that actually
       * bites: store cards are listed under the RETAIL BRAND, not the bank that
       * issues them, so searching the issuer's name returns nothing and the card
       * looks unreachable when it is not.
       */
      case 'institutions': {
        const query = ((body.query as string) ?? '').trim()
        if (query.length < 2) return json({ error: 'query must be at least 2 characters' }, 400)

        const res = await plaid('/institutions/search', {
          query,
          products: ['transactions'],
          country_codes: ['US'],
          options: { include_optional_metadata: true },
        })

        return json({
          query,
          institutions: (res.institutions ?? []).slice(0, 10).map(
            (i: Record<string, unknown>) => ({
              institution_id: i.institution_id,
              name: i.name,
              products: i.products,
              // OAuth banks hand the login to the bank's own page. Worth knowing
              // before starting, because the flow looks different.
              oauth: i.oauth ?? false,
            }),
          ),
        })
      }

      /** Map a Plaid account_id onto one of our seeded account rows. */
      case 'map': {
        const accountId = body.account_id as string
        const plaidAccountId = body.plaid_account_id as string
        // The issuing bank is displayed beside the type label. Only overwrite it
        // when the caller actually names one, so re-mapping never blanks a value
        // that was entered by hand.
        const institution = ((body.institution as string) ?? '').trim()
        if (!accountId || !plaidAccountId) {
          return json({ error: 'account_id and plaid_account_id are required' }, 400)
        }

        const { error } = await admin
          .from('accounts')
          .update({
            plaid_account_id: plaidAccountId,
            is_manual: false,
            ...(institution ? { institution } : {}),
          })
          .eq('id', accountId)
        if (error) throw new Error(error.message)

        return json({ mapped: accountId, to: plaidAccountId })
      }

      /** Create a checking account row for a spending account Plaid found. */
      case 'create_checking': {
        const name = body.name as string
        const plaidAccountId = body.plaid_account_id as string
        const isBusiness = Boolean(body.is_business)
        const institution = ((body.institution as string) ?? '').trim() || null

        // owner is CHECK-constrained. Accept only a value the constraint allows,
        // otherwise fall back rather than failing the whole link flow at the last
        // step. The valid set is read from the column so no name is hard-coded.
        const requested = ((body.owner as string) ?? '').trim().toLowerCase()
        const { data: ownerRows } = await admin.from('accounts').select('owner')
        const known = new Set((ownerRows ?? []).map((r) => String(r.owner)))
        const owner = known.has(requested) ? requested : 'joint'
        if (!name || !plaidAccountId) {
          return json({ error: 'name and plaid_account_id are required' }, 400)
        }

        // The upsert conflicts on plaid_account_id, which is the same column
        // `map` writes onto a DEBT row. Choosing "add as a spending account" for
        // an id already mapped to a card would rewrite that row in place with
        // checking defaults — erasing its APR, its minimum payment and its place
        // in the payoff queue, silently, with the balance left behind. Look
        // first and refuse.
        const { data: owns } = await admin
          .from('accounts')
          .select('id, name, kind')
          .eq('plaid_account_id', plaidAccountId)
          .maybeSingle()

        if (owns && owns.kind !== 'checking') {
          return json(
            {
              error: `That account is already linked to "${owns.name}". Unlink it there first — adding it as a spending account would overwrite its rate, minimum and payoff position.`,
            },
            409,
          )
        }

        const { data, error } = await admin
          .from('accounts')
          .upsert(
            {
              name,
              owner,
              kind: 'checking',
              apr: null,
              minimum_payment: 0,
              payoff_order: 98,
              opening_balance: 0,
              plaid_account_id: plaidAccountId,
              is_manual: false,
              is_business: isBusiness,
              institution,
            },
            { onConflict: 'plaid_account_id' },
          )
          .select()
          .maybeSingle()

        if (error) throw new Error(error.message)
        return json({ created: data })
      }

      /**
       * Read back a Hosted Link session. Plaid records the completed session
       * against the link_token, so the public_token can be retrieved rather than
       * copied by hand — which matters because the ITEM IS CREATED the moment the
       * bank login completes, before any paste. If the operator closes the tab at
       * that point the allowance is spent with nothing stored, and the Trial plan
       * never gives it back.
       */
      case 'poll': {
        const linkToken = body.link_token as string
        if (!linkToken) return json({ error: 'link_token is required' }, 400)

        const res = await plaid('/link/token/get', { link_token: linkToken })
        const sessions = (res.link_sessions ?? []) as Record<string, unknown>[]
        const latest = sessions[sessions.length - 1]
        const results = (latest?.results ?? {}) as Record<string, unknown>
        const itemAdd = (results.item_add_results ?? []) as Record<string, unknown>[]

        return json({
          complete: itemAdd.length > 0,
          public_token: (itemAdd[0]?.public_token as string) ?? null,
          institution:
            ((latest?.on_success as Record<string, unknown>)?.institution as Record<string, unknown>)
              ?.name ?? null,
          sessions: sessions.length,
        })
      }

      case 'status': {
        const { data: items } = await admin
          .from('plaid_items')
          .select('item_id, institution, status, last_synced, cursor')
        const { data: accounts } = await admin
          .from('accounts')
          .select('id, name, kind, plaid_account_id, is_manual, is_business')
          .order('payoff_order')

        return json({
          env: PLAID_ENV,
          itemsUsed: items?.length ?? 0,
          itemCap: 10,
          items: (items ?? []).map((i) => ({ ...i, cursor: i.cursor ? 'set' : null })),
          accounts,
        })
      }

      default:
        return json({ error: `unknown action: ${action}` }, 400)
    }
  } catch (err) {
    console.error(action, err)
    return json({ error: (err as Error).message }, 500)
  }
})
