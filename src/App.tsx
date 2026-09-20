import { HashRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { DataProvider } from './lib/data'
import BottomNav from './components/BottomNav'
import Sidebar from './components/Sidebar'
import Loading from './components/Loading'

import SignIn from './pages/SignIn'
import Home from './pages/Home'
import Spending from './pages/Spending'
import Activity from './pages/Activity'
import Accounts from './pages/Accounts'
import Settings from './pages/Settings'
import LinkBank from './pages/LinkBank'
import More from './pages/More'
import Progress from './pages/Progress'
import Calendar from './pages/Calendar'
import Business from './pages/Business'

/**
 * Non-negotiable #1: nothing renders before authentication.
 *
 * While the session is resolving we show a contentless placeholder — not the app
 * shell, and never any figure, date or name. An authenticated user who is not in
 * household_members is treated as signed out for routing purposes and told so on
 * the sign-in screen; every RLS policy would return nothing for them anyway.
 */
function Protected() {
  const { session, isMember, loading } = useAuth()
  const location = useLocation()

  if (loading) return <Loading />
  if (!session || !isMember) {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />
  }

  // One layout route rather than a wrapper per page. Wrapping each route
  // separately remounted DataProvider on every navigation, refetching the whole
  // dataset just to move from Home to Month — and it would reset the view mode
  // with it.
  return (
    <DataProvider>
      <Sidebar />
      <div className="shell">
        <Outlet />
      </div>
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

      <Route element={<Protected />}>
        <Route path="/"         element={<Home />} />
        <Route path="/spending" element={<Spending />} />
        <Route path="/progress" element={<Progress />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/business" element={<Business />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/more"     element={<More />} />
        <Route path="/link"     element={<LinkBank />} />

        {/* Month and History merged into Spending, which is the same page for
            any month. Both old paths are kept as redirects rather than dropped:
            they are in browser history and on at least one home screen, and a
            bookmark that silently lands on Home reads as the page being gone. */}
        <Route path="/month"   element={<Navigate to="/spending" replace />} />
        <Route path="/history" element={<Navigate to="/spending" replace />} />
      </Route>

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
