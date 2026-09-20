import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !key) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY')
}

/**
 * flowType MUST be 'pkce'.
 *
 * The supabase-js default is 'implicit', which returns the session in the URL
 * *fragment*. HashRouter also owns the fragment, so the two collide: GoTrue builds
 * the implicit redirect by string-concatenating `redirectURL + '#' + params`, and a
 * redirectTo containing `#/...` yields a double-hash URL where auth-js parses the
 * first key as "/...#access_token" instead of "access_token". Detection returns
 * false and the user is silently never signed in.
 *
 * PKCE only ever sets the query string, so the URL is
 * `https://host/Payoff/?code=XXX#/auth/callback` — auth-js reads `code` from
 * searchParams, which HashRouter never touches, and cleans up with
 * history.replaceState (no hashchange, so react-router stays in sync).
 */
export const supabase = createClient<Database>(url, key, {
  auth: {
    flowType: 'pkce',
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
  },
})

/**
 * Where the magic link comes back to. Must be on the Supabase redirect allowlist.
 *
 * `||`, not `??`. Vite replaces an unset VITE_SITE_URL with the empty string,
 * which is not nullish — `??` would keep it and produce the bare string
 * "#/auth/callback" as the redirect. The build succeeds, and then GoTrue rejects
 * every sign-in link as off-allowlist with nothing to explain why.
 */
const siteUrl =
  import.meta.env.VITE_SITE_URL || window.location.origin + import.meta.env.BASE_URL

export const authRedirectTo = `${siteUrl.endsWith('/') ? siteUrl : siteUrl + '/'}#/auth/callback`

/**
 * PostgREST returns at most 1000 rows per request and says nothing when it
 * truncates — no error, no flag, just a short array that looks like the whole
 * answer.
 *
 * This bit History: account_balance_weekly holds 2,415 rows ordered by week
 * ascending, so the page received weeks from September 2024 to July 2025 and
 * silently dropped the most recent fourteen months. Every per-account change
 * column was then computed across the truncated span — the personal loan, which
 * actually rose $50,000, printed a $0 change in green.
 *
 * Any read that could exceed 1000 rows goes through here. It pages explicitly
 * with .range() until a short page proves the end, and it SURFACES the error
 * rather than collapsing a failed read into an empty array — an empty array and
 * a failed request mean very different things, and only one of them should be
 * rendered as "no history yet".
 *
 * CALLER'S OBLIGATION: `build` must impose a TOTAL order — enough .order()
 * columns to make every row's sort key unique. Each page is a separate
 * statement, Postgres does not promise a tie order under LIMIT/OFFSET, and it
 * demonstrably varies: the same query picks top-N heapsort while limit+offset
 * is below the row count and quicksort above it, and neither is stable. Rows
 * tied on the sort key at a page boundary then land on two pages or on none.
 * Ordering by a date alone is the usual way to get this wrong.
 */
/**
 * Deliberately BELOW Supabase's default db-max-rows of 1000.
 *
 * The loop's only signal that it has reached the end is a page shorter than the
 * window it asked for. At exactly 1000 that signal is borrowed from the server's
 * cap rather than owned: if the cap is ever lowered, every page comes back short
 * on the first request, the loop stops, and the silent-truncation bug this
 * paging exists to fix returns — with the paging code still present and still
 * looking correct. A smaller window keeps the two numbers independent.
 */
const PAGE = 500

export async function selectAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = PAGE,
): Promise<{ data: T[]; error: string | null }> {
  const out: T[] = []

  // A non-positive window never advances and never comes back short, so the
  // loop below would spin forever issuing requests.
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    return { data: out, error: `selectAllPages: pageSize must be a positive integer, got ${pageSize}` }
  }

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1)
    if (error) return { data: out, error: error.message }

    const rows = data ?? []
    out.push(...rows)

    // A page shorter than the window is the only proof there is nothing after
    // it. An exactly-full last page costs one extra empty request, which is the
    // cheap side of the trade.
    if (rows.length < pageSize) return { data: out, error: null }
  }
}
