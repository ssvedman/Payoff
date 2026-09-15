import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useData } from '../lib/data'
import { money, moneyCents } from '../lib/format'
import { supabase } from '../lib/supabase'
import type { AlertType } from '../lib/database.types'

/**
 * Settings — push subscription for this device, notification toggles,
 * read-only plan values, sign out.
 *
 * The mockup carries an iOS "Add to Home Screen" notice. Both users are on
 * Android, where no install step is required, so that block manages the push
 * subscription for this device instead.
 */

interface Alert {
  type: AlertType
  title: string
  subtitle: string
  /** Applied when the user has no stored row for this alert yet. */
  defaultOn: boolean
  /** The label or the subtitle contains a figure, so it needs tabular numerals. */
  titleHasFigure?: boolean
  subtitleHasFigure?: boolean
}

const ALERTS: Alert[] = [
  {
    type: 'balance_up',
    title: 'A balance went up',
    subtitle: 'Spending on a dormant account',
    defaultOn: true,
  },
  {
    type: 'attack_missing',
    title: 'Attack payment missing',
    subtitle: 'Nothing reached the target by the 15th',
    defaultOn: true,
    subtitleHasFigure: true,
  },
  {
    type: 'optional_80',
    title: 'Optional bucket at 80%',
    subtitle: 'Early warning, once per month',
    defaultOn: true,
    titleHasFigure: true,
  },
  {
    type: 'business_low',
    title: 'Business account low',
    subtitle: 'Below $500',
    defaultOn: true,
    subtitleHasFigure: true,
  },
  {
    type: 'account_cleared',
    title: 'An account cleared',
    subtitle: 'The good one',
    defaultOn: true,
  },
  {
    type: 'monthly_summary',
    title: 'Monthly summary',
    subtitle: 'First of the month',
    defaultOn: false,
  },
]

const VAPID_PUBLIC_KEY: string = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? ''

const PUSH_SUPPORTED =
  typeof window !== 'undefined' &&
  'Notification' in window &&
  'PushManager' in window &&
  'serviceWorker' in navigator

/** VAPID keys ship as URL-safe base64; PushManager wants the raw bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(normalized)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

const CAPS_STYLE = { fontWeight: 700, margin: '22px 0 4px' } as const

const GHOST_STYLE = { width: 'auto', padding: '8px 14px', fontSize: 13 } as const

/** Sits on the neutral notice — plain ghost, steel on line. */
const NOTICE_BUTTON_STYLE = { ...GHOST_STYLE, marginTop: 10 } as const

/** Sits on the green notice, so it borrows green-tx rather than steel. */
const GREEN_BUTTON_STYLE = {
  ...NOTICE_BUTTON_STYLE,
  color: 'var(--green-tx)',
  borderColor: 'rgba(28,74,57,.25)',
} as const

export default function Settings() {
  const { user, signOut } = useAuth()
  const { loading, error, plan, prefs, refresh } = useData()

  // ---- push subscription, per device ----
  const [subscribed, setSubscribed] = useState<boolean | null>(null)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    async function check() {
      if (!PUSH_SUPPORTED || !user) {
        if (active) setSubscribed(false)
        return
      }
      try {
        if (Notification.permission !== 'granted') {
          if (active) setSubscribed(false)
          return
        }
        const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
        const subscription = await registration?.pushManager.getSubscription()
        if (!subscription) {
          if (active) setSubscribed(false)
          return
        }
        const { data, error: rowError } = await supabase
          .from('push_subscriptions')
          .select('endpoint')
          .eq('user_id', user.id)
          .eq('endpoint', subscription.endpoint)
          .maybeSingle()
        if (rowError) throw rowError
        if (!active) return

        // Self-heal a rotated endpoint. Chrome can replace a subscription without
        // asking, and a service worker cannot write to Supabase — it holds no
        // session. If the browser has a live subscription we have no row for, store
        // it now; otherwise push stays silently dead until someone happens to open
        // this page and notice the switch had turned itself off.
        if (!data) {
          const json = subscription.toJSON()
          const { error: healError } = await supabase.from('push_subscriptions').upsert(
            {
              user_id: user.id,
              endpoint: subscription.endpoint,
              p256dh: json.keys?.p256dh ?? '',
              auth_key: json.keys?.auth ?? '',
            } as never,
            { onConflict: 'endpoint' },
          )
          if (healError) throw healError
          await refresh()
        }

        setEndpoint(subscription.endpoint)
        setSubscribed(true)
      } catch (e) {
        console.error(e)
        if (active) setSubscribed(false)
      }
    }

    void check()
    return () => {
      active = false
    }
  }, [user, refresh])

  const enablePush = useCallback(async () => {
    if (!user) return
    setPushBusy(true)
    setPushError(null)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setSubscribed(false)
        setPushError('Permission was not granted on this device.')
        return
      }

      const registration = await navigator.serviceWorker.register(
        `${import.meta.env.BASE_URL}sw.js`,
        { scope: import.meta.env.BASE_URL },
      )
      const existing = await registration.pushManager.getSubscription()
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        }))

      const keys = subscription.toJSON().keys
      if (!keys?.p256dh || !keys.auth) throw new Error('Subscription returned no keys')

      const row = {
        user_id: user.id,
        endpoint: subscription.endpoint,
        p256dh: keys.p256dh,
        auth_key: keys.auth,
      }

      const { error: upsertError } = await supabase
        .from('push_subscriptions')
        .upsert(row as never, { onConflict: 'endpoint' })
      if (upsertError) throw upsertError

      setEndpoint(subscription.endpoint)
      setSubscribed(true)
    } catch (e) {
      console.error(e)
      setPushError('Notifications could not be turned on for this device.')
    } finally {
      setPushBusy(false)
    }
  }, [user])

  const disablePush = useCallback(async () => {
    setPushBusy(true)
    setPushError(null)
    try {
      const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
      const subscription = await registration?.pushManager.getSubscription()
      const target = subscription?.endpoint ?? endpoint
      if (subscription) await subscription.unsubscribe()
      if (target) {
        const { error: deleteError } = await supabase
          .from('push_subscriptions')
          .delete()
          .eq('endpoint', target)
        if (deleteError) throw deleteError
      }
      setEndpoint(null)
      setSubscribed(false)
    } catch (e) {
      console.error(e)
      setPushError('Notifications could not be turned off for this device.')
    } finally {
      setPushBusy(false)
    }
  }, [endpoint])

  // ---- notification preferences ----
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean> | null>(null)
  const [prefError, setPrefError] = useState<string | null>(null)

  useEffect(() => {
    if (loading) return
    const next: Record<string, boolean> = {}
    for (const alert of ALERTS) {
      const row = prefs.find((p) => p.alert_type === alert.type)
      next[alert.type] = row ? row.enabled : alert.defaultOn
    }
    setEnabledMap(next)
  }, [loading, prefs])

  const toggleAlert = useCallback(
    async (alertType: AlertType, nextValue: boolean) => {
      if (!user) return
      setPrefError(null)
      setEnabledMap((m) => (m ? { ...m, [alertType]: nextValue } : m))

      const row = { user_id: user.id, alert_type: alertType, enabled: nextValue }
      const { error: upsertError } = await supabase
        .from('notification_prefs')
        .upsert(row as never, { onConflict: 'user_id,alert_type' })

      if (upsertError) {
        console.error(upsertError)
        // Revert just this toggle. Calling refresh() here would flip the whole page
        // back to loading, dissolving the notification list and the plan values into
        // skeletons for a failure that affects exactly one switch.
        setEnabledMap((m) => (m ? { ...m, [alertType]: !nextValue } : m))
        setPrefError('That setting was not saved.')
      }
    },
    [user],
  )

  const planRows: { label: string; value: string | null }[] = [
    { label: 'Attack fund', value: plan ? moneyCents(plan.attack_fund) : null },
    { label: 'Monthly savings', value: plan ? moneyCents(plan.monthly_savings) : null },
    { label: 'Deposit target', value: plan ? money(plan.deposit_target) : null },
  ]

  // Green is "on plan" — push is live on this device. Every other state is a
  // neutral notice: amber belongs to the current target and nothing else
  // (BUILD.md §8), and nothing here has deviated from the plan.
  const pushOn = PUSH_SUPPORTED && subscribed === true

  return (
    <div className="page">
      <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 16 }}>Settings</div>

      {/* Push enablement, this device only */}
      <div
        className={pushOn ? 'banner banner--green' : 'banner'}
        style={pushOn ? { marginBottom: 20 } : { marginBottom: 20, background: 'var(--card)' }}
      >
        {!PUSH_SUPPORTED ? (
          <>
            <div className="sm" style={{ fontWeight: 700, marginBottom: 3 }}>
              Notifications are not available in this browser
            </div>
            <div className="tiny muted">
              This browser has no push support, so nothing can be delivered here.
            </div>
          </>
        ) : subscribed === null ? (
          <>
            <div className="skeleton" style={{ width: 186, height: 11, marginBottom: 7 }} />
            <div className="skeleton" style={{ width: 132, height: 9 }} />
          </>
        ) : subscribed ? (
          <>
            <div className="sm" style={{ fontWeight: 700, marginBottom: 3 }}>
              Notifications on for this device
            </div>
            <div className="tiny">Alerts arrive as push. This app sends no email.</div>
            <button
              type="button"
              className="btn ghost"
              style={GREEN_BUTTON_STYLE}
              onClick={() => void disablePush()}
              disabled={pushBusy}
            >
              Turn off on this device
            </button>
          </>
        ) : (
          <>
            <div className="sm" style={{ fontWeight: 700, marginBottom: 3 }}>
              Notifications are off for this device
            </div>
            <div className="tiny muted">
              {VAPID_PUBLIC_KEY
                ? 'Each device is subscribed separately.'
                : 'Push is not configured yet.'}
            </div>
            <button
              type="button"
              className="btn ghost"
              style={NOTICE_BUTTON_STYLE}
              onClick={() => void enablePush()}
              disabled={pushBusy || !VAPID_PUBLIC_KEY}
            >
              Turn on
            </button>
          </>
        )}

        {pushError && (
          <div className="tiny" style={{ color: 'var(--red)', marginTop: 8 }}>
            {pushError}
          </div>
        )}
      </div>

      {error && (
        <div className="tiny" style={{ color: 'var(--red)', marginBottom: 12 }}>
          Settings could not be loaded. {error}
        </div>
      )}

      <div className="tiny muted" style={{ fontWeight: 700, marginBottom: 4 }}>
        NOTIFICATIONS
      </div>

      {loading || !enabledMap
        ? ALERTS.map((alert) => (
            <div className="row" key={alert.type}>
              <div style={{ flex: 1 }}>
                <div className="skeleton" style={{ width: 152, height: 11, marginBottom: 6 }} />
                <div className="skeleton" style={{ width: 112, height: 9 }} />
              </div>
              <div className="skeleton" style={{ width: 40, height: 23, borderRadius: 12 }} />
            </div>
          ))
        : ALERTS.map((alert) => {
            const on = enabledMap[alert.type]
            return (
              <div className="row" key={alert.type}>
                <div style={{ flex: 1 }}>
                  <div className={alert.titleHasFigure ? 'sm tnum' : 'sm'} style={{ fontWeight: 600 }}>
                    {alert.title}
                  </div>
                  <div className={alert.subtitleHasFigure ? 'tiny muted tnum' : 'tiny muted'}>
                    {alert.subtitle}
                  </div>
                </div>
                <button
                  type="button"
                  className={on ? 'toggle' : 'toggle off'}
                  aria-label={`${alert.title} notifications`}
                  aria-pressed={on}
                  onClick={() => void toggleAlert(alert.type, !on)}
                />
              </div>
            )
          })}

      {prefError && (
        <div className="tiny" style={{ color: 'var(--red)', marginTop: 8 }}>
          {prefError}
        </div>
      )}

      <div className="tiny muted" style={CAPS_STYLE}>
        PLAN
      </div>

      {planRows.map((row) => (
        <div className="row" key={row.label}>
          <div style={{ flex: 1 }}>
            <div className="sm" style={{ fontWeight: 600 }}>
              {row.label}
            </div>
          </div>
          {loading ? (
            <div className="skeleton" style={{ width: 74, height: 11 }} />
          ) : row.value ? (
            <div className="tnum sm">{row.value}</div>
          ) : (
            <div className="sm muted">Not set</div>
          )}
        </div>
      ))}

      <div className="tiny muted" style={CAPS_STYLE}>
        ACCOUNT
      </div>

      <div className="row" style={{ borderBottom: 'none' }}>
        <div style={{ flex: 1 }}>
          <div className="sm" style={{ fontWeight: 600 }}>
            Signed in
          </div>
          <div className="tiny muted">{user?.email ?? 'No email on this session'}</div>
        </div>
        <button
          type="button"
          className="btn ghost"
          style={GHOST_STYLE}
          onClick={() => void signOut()}
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
