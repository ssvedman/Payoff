import { useState, type FormEvent } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'

/**
 * Non-negotiable #1: the app name and an email field, and nothing else.
 * No totals, no dates, no names, no hint of what the app holds. This is the
 * only page an unauthenticated person can ever reach.
 */

// Factual, and identical for every failure: a message that varies by cause would
// reveal whether the address is registered.
const GENERIC_ERROR = 'No sign-in link was sent to that address.'

const wordmark = {
  fontSize: 34,
  fontWeight: 800,
  letterSpacing: '-.03em',
  marginBottom: 34,
} as const

export default function SignIn() {
  const { session, isMember, signIn, signOut } = useAuth()

  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  // Set by AuthCallback when a magic-link code exchange did not produce a session.
  const location = useLocation()
  const notice = (location.state as { notice?: string } | null)?.notice ?? null

  // Authenticated, but absent from household_members. Say only that.
  if (session && !isMember) {
    return (
      <div className="page page--centered">
        <div style={wordmark}>Payoff</div>
        <div className="sm" style={{ marginBottom: 18, lineHeight: 1.6 }}>
          This account has no access.
        </div>
        <button type="button" className="btn ghost" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    )
  }

  if (sentTo) {
    return (
      <div className="page page--centered">
        <div style={wordmark}>Payoff</div>
        <div className="sm" style={{ marginBottom: 6, lineHeight: 1.6 }}>
          If {sentTo} has access, a sign-in link is on its way.
        </div>
        <div className="tiny muted tnum" style={{ marginBottom: 18, lineHeight: 1.6 }}>
          It expires in 15 minutes.
        </div>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            setSentTo(null)
            setFailed(false)
          }}
        >
          Use a different address
        </button>
      </div>
    )
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const address = email.trim()
    if (!address || sending) return

    setSending(true)
    setFailed(false)

    const { error } = await signIn(address)

    setSending(false)

    if (error) {
      // A transport failure is not an account oracle — it happens identically for
      // every address — so it is safe, and honest, to surface it.
      if (/fetch|network|timeout|failed to send/i.test(error)) {
        setFailed(true)
        return
      }

      // Otherwise show the SAME confirmation whether or not the address is registered.
      //
      // Distinguishing the two outcomes turns this public page into an account
      // oracle: with shouldCreateUser false, an unknown address errors ("signups
      // not allowed") while a known one succeeds, so a visible failure state would
      // confirm which addresses belong to the household. The raw message goes to
      // the console and nowhere else.
      console.error('sign-in failed:', error)
    }

    setSentTo(address)
  }

  return (
    <div className="page page--centered">
      <div style={wordmark}>Payoff</div>

      <form onSubmit={onSubmit}>
        <label
          className="sm"
          htmlFor="signin-email"
          style={{ display: 'block', marginBottom: 7, fontWeight: 600 }}
        >
          Email
        </label>
        <input
          id="signin-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          inputMode="email"
          required
          autoFocus
          disabled={sending}
          style={{ marginBottom: 14 }}
        />
        <button type="submit" className="btn" disabled={sending}>
          {sending ? 'Sending…' : 'Send sign-in link'}
        </button>
      </form>

      {notice === 'exchange-failed' && (
        <div className="tiny muted" style={{ marginTop: 12, lineHeight: 1.6 }}>
          That sign-in link could not be completed. Links must be opened in your
          browser — opening one inside another app's built-in viewer will not work.
        </div>
      )}

      <div role="status" aria-live="polite">
        {failed && (
          <div className="tiny" style={{ color: 'var(--red-tx)', marginTop: 12, lineHeight: 1.6 }}>
            {GENERIC_ERROR}
          </div>
        )}
      </div>

      <div className="tiny muted tnum" style={{ marginTop: 16, lineHeight: 1.6 }}>
        You'll get a link by email. It expires in 15 minutes.
      </div>
    </div>
  )
}
