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
