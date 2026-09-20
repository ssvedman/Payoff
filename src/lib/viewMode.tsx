import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from './auth'

export type ViewMode = 'personal' | 'business'

/**
 * Which half of the app is on screen.
 *
 * The mode is DERIVED FROM THE URL rather than held in state: /business is
 * business, everything else is personal. That way the back button, a refresh and
 * a shared link all agree with the control, and there is no second source of
 * truth to drift.
 *
 * localStorage only remembers the last choice, so a returning member lands where
 * they left off. It is keyed by user id because two people share this app on one
 * device and the mode is a personal preference, not household state. It is not a
 * DB column: a value fetched with the data batch arrives after first paint, so
 * the toggle would visibly flip from Personal to Business a moment after load.
 *
 * Every access is wrapped — Safari private mode throws on localStorage rather
 * than returning null, and a preference is never worth a blank app.
 */
const KEY = (userId: string) => `payoff.viewMode.${userId}`

function remembered(userId: string | null): ViewMode | null {
  if (!userId) return null
  try {
    const v = window.localStorage.getItem(KEY(userId))
    return v === 'business' || v === 'personal' ? v : null
  } catch {
    return null
  }
}

function remember(userId: string | null, mode: ViewMode) {
  if (!userId) return
  try {
    window.localStorage.setItem(KEY(userId), mode)
  } catch {
    /* preference only */
  }
}

interface ViewModeState {
  mode: ViewMode
  setMode: (m: ViewMode) => void
}

const ViewModeContext = createContext<ViewModeState | null>(null)

export function ViewModeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const userId = user?.id ?? null

  const mode: ViewMode = location.pathname === '/business' ? 'business' : 'personal'

  /**
   * What storage said when this member's session first rendered.
   *
   * Read during render, deliberately, rather than inside the restore effect
   * below. Effects run in declaration order within a commit, and the persist
   * effect writes the mode the landing URL implies — 'personal' for '/'. A read
   * performed inside the restore effect therefore always saw a value the persist
   * effect had just overwritten a microtask earlier, so the redirect could never
   * fire and the restore was dead code on every cold start.
   *
   * ViewModeProvider only mounts inside Protected, i.e. after auth resolves, so
   * userId is already set on the first render; the undefined check is what keeps
   * this to a single read even if it were not.
   */
  const startedWith = useRef<ViewMode | null | undefined>(undefined)
  if (startedWith.current === undefined && userId) {
    startedWith.current = remembered(userId)
  }

  /**
   * Restore the remembered mode once, on the first authenticated paint.
   *
   * Guarded three ways: once per mount (the ref), only from the default landing
   * path (so a shared or bookmarked link to any real page always wins), and only
   * to move TO business, since personal is already where '/' lands.
   *
   * The ref lives as long as the provider, and the provider is a layout route
   * that survives every navigation between pages — so tapping Home after this
   * has fired cannot bounce the member back to Business.
   */
  const restored = useRef(false)
  const awaitingRestore = useRef(false)
  useEffect(() => {
    if (restored.current || !userId) return
    restored.current = true
    if (location.pathname === '/' && startedWith.current === 'business') {
      awaitingRestore.current = true
      navigate('/business', { replace: true })
    }
  }, [userId, location.pathname, navigate])

  /**
   * Persist whatever mode the member is actually in, however they got there.
   *
   * Writing only inside setMode was not enough: leaving the Business page by
   * tapping Home in the nav is just as much a choice to be back on the personal
   * side, and it never reached storage. The remembered value then disagreed with
   * where they last were.
   *
   * The one commit this sits out is the one in which the restore redirect is in
   * flight: the URL still says '/' while we are on our way to /business, and
   * writing 'personal' there would undo the very preference being restored if
   * the tab were closed in between.
   */
  useEffect(() => {
    if (!userId) return
    if (awaitingRestore.current) {
      if (mode !== 'business') return
      awaitingRestore.current = false
    }
    remember(userId, mode)
  }, [userId, mode])

  const setMode = useCallback(
    (next: ViewMode) => {
      // Persistence is handled by the effect above, which also catches a mode
      // change made by plain navigation rather than by this control.
      if (next === mode) return
      if (next === 'business') {
        navigate('/business')
      } else {
        // Back to the household side. Home, not the previous page: the page they
        // were on may have been the business one itself.
        navigate('/')
      }
    },
    [mode, navigate],
  )

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode])
  return <ViewModeContext.Provider value={value}>{children}</ViewModeContext.Provider>
}

export function useViewMode(): ViewModeState {
  const ctx = useContext(ViewModeContext)
  if (!ctx) throw new Error('useViewMode must be used inside ViewModeProvider')
  return ctx
}
