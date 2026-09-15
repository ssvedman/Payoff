import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase, authRedirectTo } from './supabase'

interface AuthState {
  /** undefined = still resolving. null = definitively signed out. */
  session: Session | null | undefined
  user: User | null
  /** True only once the signed-in user is confirmed to be in household_members. */
  isMember: boolean
  memberName: string | null
  /** True while either the session or the membership check is outstanding. */
  loading: boolean
  signIn: (email: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [isMember, setIsMember] = useState(false)
  const [memberName, setMemberName] = useState<string | null>(null)
  const [memberChecked, setMemberChecked] = useState(false)

  useEffect(() => {
    let active = true

    // getSession() internally awaits the PKCE code exchange when the URL carries
    // ?code=..., so this resolves only after sign-in completes. Gating render on it
    // is what stops any content flashing before auth is known.
    supabase.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session ?? null)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!active) return
      setSession((prev) => {
        // Re-check membership only when the identity actually changes. A routine
        // TOKEN_REFRESHED carries the same user, and resetting memberChecked on it
        // unmounted the whole tree back to the loading placeholder and refetched
        // everything mid-interaction.
        const prevUser = prev?.user?.id ?? null
        const nextUser = next?.user?.id ?? null
        if (prevUser !== nextUser) setMemberChecked(false)
        return next ?? null
      })
    })

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  // Membership is a second gate beyond authentication. Signing in is not enough:
  // a user absent from household_members sees nothing, because every policy on
  // every table fails closed for them.
  useEffect(() => {
    let active = true

    if (session === undefined) return
    if (session === null) {
      setIsMember(false)
      setMemberName(null)
      setMemberChecked(true)
      return
    }

    supabase
      .from('household_members')
      .select('display_name')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!active) return
        setIsMember(Boolean(data))
        setMemberName(data?.display_name ?? null)
        setMemberChecked(true)
      })

    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, session === undefined])

  const value: AuthState = {
    session,
    user: session?.user ?? null,
    isMember,
    memberName,
    loading: session === undefined || !memberChecked,

    async signIn(email: string) {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: authRedirectTo,
          // Nobody else will ever sign up. This is a convenience guard only —
          // the server-side enforcement is "Allow new users to sign up" being
          // disabled in the Supabase dashboard.
          shouldCreateUser: false,
        },
      })
      return { error: error?.message ?? null }
    },

    async signOut() {
      await supabase.auth.signOut()
    },
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
