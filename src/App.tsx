import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { DataProvider } from './lib/data'
import BottomNav from './components/BottomNav'
import Loading from './components/Loading'

import SignIn from './pages/SignIn'
import Home from './pages/Home'
import Month from './pages/Month'
import Activity from './pages/Activity'
import Accounts from './pages/Accounts'
import Settings from './pages/Settings'
import LinkBank from './pages/LinkBank'

/**
 * Non-negotiable #1: nothing renders before authentication.
 *
 * While the session is resolving we show a contentless placeholder — not the app
 * shell, and never any figure, date or name. An authenticated user who is not in
 * household_members is treated as signed out for routing purposes and told so on
 * the sign-in screen; every RLS policy would return nothing for them anyway.
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, isMember, loading } = useAuth()
  const location = useLocation()

  if (loading) return <Loading />
  if (!session || !isMember) {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />
  }

  return (
    <DataProvider>
      {children}
      <BottomNav />
    </DataProvider>
  )
}

/** Signed-in users never see /signin. */
function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { session, isMember, loading } = useAuth()
  if (loading) return <Loading />
  if (session && isMember) return <Navigate to="/" replace />
  return <>{children}</>
}

/**
 * PKCE returns to `/Payoff/?code=...#/auth/callback`. supabase-js consumes the
 * `code` query parameter before this renders; all that is left is to send the
 * user onward once the session resolves.
 */
function AuthCallback() {
  const { session, isMember, loading } = useAuth()
  if (loading) return <Loading />
  if (session && isMember) return <Navigate to="/" replace />

  // Landing here without a session means the code exchange failed — most often an
  // in-app webview (tapping the link inside the Gmail app) that has none of the
  // PKCE verifier the browser stored. Say so, rather than returning a blank form
  // that looks like an expired link.
  return (
    <Navigate
      to="/signin"
      replace
      state={{ notice: session ? 'no-access' : 'exchange-failed' }}
    />
  )
}

function Shell() {
  return (
    <Routes>
      <Route path="/signin" element={<RedirectIfAuthed><SignIn /></RedirectIfAuthed>} />
      <Route path="/auth/callback" element={<AuthCallback />} />

      <Route path="/"         element={<RequireAuth><Home /></RequireAuth>} />
      <Route path="/month"    element={<RequireAuth><Month /></RequireAuth>} />
      <Route path="/activity" element={<RequireAuth><Activity /></RequireAuth>} />
      <Route path="/accounts" element={<RequireAuth><Accounts /></RequireAuth>} />
      <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
      <Route path="/link"     element={<RequireAuth><LinkBank /></RequireAuth>} />

      {/* Catch-all: the auth *error* redirect can still clobber the fragment, so
          anything unrecognised goes home rather than rendering a blank screen. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <div className="app">
          <Shell />
        </div>
      </HashRouter>
    </AuthProvider>
  )
}
