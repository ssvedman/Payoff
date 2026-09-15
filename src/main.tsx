import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { supabase } from './lib/supabase'

/**
 * Consume an implicit-flow session out of the URL fragment before React mounts.
 *
 * The client is configured flowType: 'pkce', which keeps magic links clear of the
 * fragment that HashRouter owns. But PKCE does not cover every path into the app:
 * an INVITE link, a recovery link and email-change confirmations all go through
 * GoTrue's /verify endpoint, which redirects back with the session in the
 * fragment — `#access_token=...&refresh_token=...&type=invite`.
 *
 * HashRouter then sees that as a route, finds nothing, and the user lands on the
 * sign-in page having just been authenticated. The server records a successful
 * login; the browser ends up with no session. That is precisely what happened to
 * the second household member on her invite.
 *
 * So: if the fragment carries tokens, hand them to supabase-js, clear the
 * fragment, and only then mount the router. Anything else — including a normal
 * `#/route` — is left completely alone.
 */
async function consumeImplicitSession(): Promise<void> {
  const raw = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash

  if (!raw.includes('access_token=') && !raw.includes('error_description=')) return

  const params = new URLSearchParams(raw)
  const access_token = params.get('access_token')
  const refresh_token = params.get('refresh_token')

  try {
    if (access_token && refresh_token) {
      const { error } = await supabase.auth.setSession({ access_token, refresh_token })
      if (error) console.error('Could not establish the session from the link', error)
    } else if (params.get('error_description')) {
      console.error('Auth link returned an error:', params.get('error_description'))
    }
  } catch (e) {
    console.error('Failed while reading the session from the link', e)
  } finally {
    // Replace rather than push, so Back does not return to a spent token, and
    // land on the app root so HashRouter has a route it recognises.
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}#/`)
  }
}

void consumeImplicitSession().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
