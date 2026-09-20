import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useData } from '../lib/data'
import { MONTH_NAMES, money, moneyCents, parseDateOnly, relativeTime } from '../lib/format'
import { linkStatus, syncNow } from '../lib/plaidLink'
import { useFrozenPlan } from '../lib/planVersion'
import { supabase } from '../lib/supabase'
import type { AlertType } from '../lib/database.types'

/**
 * Settings: notification preferences, the frozen plan as it was generated,
 * who is in the household, and the state of the data behind every other page.
 *
 * Two columns on desktop, one on a phone. Notifications sit on the left because
 * they are the only thing here anybody changes often; everything on the right is
 * read-mostly.
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
    type: 'balance_stale',
    title: 'A typed-in balance is old',
    subtitle: 'Once a month, per account, after 30 days',
    defaultOn: true,
  },
  {
    type: 'account_dormant',
    title: 'A card has gone unused',
    subtitle: 'Unused cards get closed, and that raises utilization',
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

/**
 * The mockup's small ghost button, used on desktop. `.btn` is full width at
 * 15px by default, which is the phone's treatment, so the phone is given the
 * class alone and only the desktop overrides it.
 */
const GHOST_SMALL: React.CSSProperties = { width: 'auto', padding: '8px 13px', fontSize: 12 }

const PILL_STYLE: React.CSSProperties = { background: 'var(--card)', color: 'var(--steel)' }

const counts = new Intl.NumberFormat('en-US')

/**
 * Desktop draws each section as a bordered card with a 13px heading; the phone
 * draws a caps label over bare rows. There is no display utility in index.css
 * for that and index.css belongs to the shell rather than to this page, so the
 * breakpoint is read here.
 *
 * matchMedia is read in the initial state and not only in the effect: a first
 * paint of the phone's bare sections that grows card borders one frame later is
 * a visible jump on every load of a wide screen.
 */
const WIDE = '(min-width: 1024px)'

function useIsDesktop(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(WIDE).matches,
  )

  useEffect(() => {
    const mq = window.matchMedia(WIDE)
    const onChange = () => setWide(mq.matches)
    setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return wide
}

/** One section of the page: a card on desktop, a labelled run of rows on a phone. */
function Section({
  title,
  pill,
  desktop,
  children,
}: {
  title: string
  /** The version badge, on the plan section only. */
  pill?: string
  desktop: boolean
  children: React.ReactNode
}) {
  const badge = pill ? (
    <span className="pill" style={PILL_STYLE}>
      {pill}
    </span>
  ) : null

  if (!desktop) {
    return (
      <section>
        <div
          className="caps"
          style={{ marginBottom: 2, display: 'flex', gap: 6, alignItems: 'center' }}
        >
          {title.toUpperCase()}
          {badge}
        </div>
        {children}
      </section>
    )
  }

  return (
    <div className="box">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div>
        {badge}
      </div>
      {children}
    </div>
  )
}

/** "15 Sep 2026", the mockup's date form, built without a locale surprise. */
function dayMonthYear(iso: string): string {
  const d = parseDateOnly(iso)
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`
}

/** "Feb 2029". */
function monthYear(iso: string): string {
  const d = parseDateOnly(iso)
  return `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`
}

export default function Settings() {
  const { user, signOut } = useAuth()
  const { loading, error, plan, prefs, memberNames, lastSyncedAt, refresh } = useData()
  const desktop = useIsDesktop()

  // The plan figures come from the VERSION, never from plan_settings: the
  // version row is what the projections were actually generated from, and
  // plan_settings can be edited afterwards. Showing the settings row beside a
  // frozen chart is how the two quietly disagree with nobody noticing.
  const frozen = useFrozenPlan()

  // ---- push subscription, per device ----
  const [subscribed, setSubscribed] = useState<boolean | null>(null)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)
  const [deviceCount, setDeviceCount] = useState<number | null>(null)

  /**
   * How many devices this user has subscribed.
   *
   * Own rows only, and not by choice: the policy on push_subscriptions is
   * `user_id = auth.uid()`, so one member cannot read the other's. The line
   * below says "your devices" for that reason, because "2 devices" would read
   * as a household total it is not.
   */
  const refreshDevices = useCallback(async () => {
    if (!user) return
    const { data, error: readError } = await supabase
      .from('push_subscriptions')
      .select('endpoint')
      .eq('user_id', user.id)
    if (readError) {
      console.error(readError)
      return
    }
    setDeviceCount((data ?? []).length)
  }, [user])

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
          // The healed row is a device that was not in the count read on mount,
          // so the footer would sit one short until the next reload.
          await refreshDevices()
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
  }, [user, refresh, refreshDevices])

  useEffect(() => {
    void refreshDevices()
  }, [refreshDevices])

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
      await refreshDevices()
    } catch (e) {
      console.error(e)
      setPushError('Notifications could not be turned on for this device.')
    } finally {
      setPushBusy(false)
    }
  }, [user, refreshDevices])

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
      await refreshDevices()
    } catch (e) {
      console.error(e)
      setPushError('Notifications could not be turned off for this device.')
    } finally {
      setPushBusy(false)
    }
  }, [endpoint, refreshDevices])

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

  // ---- the data behind every other page ----
  const [banks, setBanks] = useState<{ used: number; cap: number; broken: number } | null>(null)
  const [txnCount, setTxnCount] = useState<number | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncNote, setSyncNote] = useState<string | null>(null)

  const loadFacts = useCallback(async () => {
    // itemsUsed comes from Plaid's own view of the item, not from counting rows
    // here: the trial allowance is consumed permanently, so items ever used and
    // items currently linked are different numbers and only one of them is the
    // one that runs out.
    try {
      const status = await linkStatus()
      setBanks({
        used: status.itemsUsed,
        cap: status.itemCap,
        broken: status.items.filter((i) => i.status !== 'ok').length,
      })
    } catch (e) {
      console.error(e)
      setBanks(null)
    }

    // head + exact: the count of every transaction ever stored, without
    // transferring a single row. useData holds this month's only.
    //
    // This deliberately counts business rows too. It reports the size of the
    // store, which is a fact about the sync, and it feeds no bucket total:
    // household figures are filtered on is_business in data.tsx and nothing
    // here is added to them.
    const { count, error: countError } = await supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
    if (countError) {
      console.error(countError)
      return
    }
    setTxnCount(count ?? null)
  }, [])

  useEffect(() => {
    void loadFacts()
  }, [loadFacts])

  const runSync = useCallback(async () => {
    setSyncBusy(true)
    setSyncNote(null)
    const result = await syncNow()
    setSyncNote(result.message)
    if (result.ok) {
      await refresh()
      await loadFacts()
    }
    setSyncBusy(false)
  }, [refresh, loadFacts])

  // Green is "on plan" — push is live on this device. Every other state is
  // stated plainly and in steel: amber belongs to the current target and nothing
  // else (BUILD.md §8), and nothing here has deviated from the plan.
  const pushOn = PUSH_SUPPORTED && subscribed === true

  const version = frozen.status === 'ready' ? frozen.frozen.version : null

  // plan_settings is what a NEW version would be generated from. When it has
  // drifted from the version on screen, say so rather than showing one number
  // and charting the other.
  const drifted =
    version !== null &&
    plan !== null &&
    (plan.attack_fund !== version.attack_fund ||
      plan.monthly_savings !== version.monthly_savings ||
      plan.deposit_target !== version.deposit_target)

  // "version 1" does not fit beside a caps label at 376px, so the phone gets
  // the short form the mockup uses.
  const versionPill = !version
    ? undefined
    : desktop
      ? `version ${version.version}`
      : `v${version.version}`

  const memberIds = Object.keys(memberNames)


  return (
    <main className="page">
      <h1 className="ph">Settings</h1>
      <div className="sm muted" style={{ margin: '4px 0 14px' }}>
        {desktop
          ? `Signed in as ${user?.email ?? 'no email on this session'}`
          : (user?.email ?? 'no email on this session')}
      </div>

      {error && (
        <div className="tiny" style={{ color: 'var(--red)', marginBottom: 12 }}>
          Settings could not be loaded. {error}
        </div>
      )}

      <div className="g2">
        {/* ---------------- Notifications ---------------- */}
        <Section title="Notifications" desktop={desktop}>
          {loading || !enabledMap
            ? ALERTS.map((alert) => (
                <div className="row" key={alert.type} style={{ padding: '7px 0' }}>
                  <div style={{ flex: 1 }}>
                    <div className="skeleton" style={{ width: 152, height: 11, marginBottom: 6 }} />
                    {desktop && <div className="skeleton" style={{ width: 112, height: 9 }} />}
                  </div>
                  <div className="skeleton" style={{ width: 38, height: 22, borderRadius: 11 }} />
                </div>
              ))
            : ALERTS.map((alert) => {
                const on = enabledMap[alert.type]
                return (
                  <div className="row" key={alert.type} style={{ padding: '7px 0' }}>
                    <div style={{ flex: 1 }}>
                      <div
                        className={alert.titleHasFigure ? 'sm tnum' : 'sm'}
                        style={{ fontWeight: 600 }}
                      >
                        {alert.title}
                      </div>
                      {/* The phone drops the descriptions, as the mockup does: eight
                          of them is about 110px of secondary text above the fold on a
                          376px screen, and the switch is the thing being come for. */}
                      {desktop && (
                        <div className={alert.subtitleHasFigure ? 'tiny muted tnum' : 'tiny muted'}>
                          {alert.subtitle}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className={on ? 'tog' : 'tog off'}
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

          {/* Push is per device, not per person: turning it on here says nothing
              about the phone in the other pocket. */}
          <div className="row" style={{ padding: '10px 0 0', borderBottom: 'none' }}>
            <div style={{ flex: 1 }}>
              <div className="sm" style={{ fontWeight: 600 }}>
                This device
              </div>
              {!PUSH_SUPPORTED ? (
                <div className="tiny muted">
                  This browser has no push support, so nothing can be delivered here.
                </div>
              ) : subscribed === null ? (
                <div className="skeleton" style={{ width: 132, height: 9, marginTop: 4 }} />
              ) : subscribed ? (
                <div className="tiny is-good">Subscribed. Alerts arrive as push.</div>
              ) : (
                <div className="tiny muted">
                  {VAPID_PUBLIC_KEY
                    ? 'Not subscribed. This app sends no email.'
                    : 'Push is not configured yet.'}
                </div>
              )}
            </div>
            {PUSH_SUPPORTED && subscribed !== null && (
              <button
                type="button"
                className="btn ghost"
                style={{ ...GHOST_SMALL, flex: '0 0 auto' }}
                onClick={() => void (pushOn ? disablePush() : enablePush())}
                disabled={pushBusy || (!pushOn && !VAPID_PUBLIC_KEY)}
              >
                {pushOn ? 'Turn off' : 'Turn on'}
              </button>
            )}
          </div>

          {pushError && (
            <div className="tiny" style={{ color: 'var(--red)', marginTop: 8 }}>
              {pushError}
            </div>
          )}

          <div className="rule">
            {deviceCount === null ? (
              'Push is enabled per device.'
            ) : (
              <>
                Push enabled on <span className="tnum">{deviceCount}</span> of your devices.
              </>
            )}{' '}
            Each member's subscriptions are readable only by them, so this counts yours alone.
          </div>
        </Section>

        {/* ---------------- The plan, the household, the data ---------------- */}
        <div style={{ display: 'grid', gap: desktop ? 14 : 18, alignContent: 'start' }}>
          <Section
            title="The plan"
            desktop={desktop}
            pill={versionPill}
          >
            {frozen.status === 'loading' &&
              [0, 1, 2, 3, 4].map((i) => (
                <div className="row" key={i} style={{ padding: '9px 0' }}>
                  <div className="skeleton" style={{ width: 108, height: 11, flex: 1 }} />
                  <div className="skeleton" style={{ width: 74, height: 11 }} />
                </div>
              ))}

            {frozen.status === 'error' && (
              <div className="tiny" style={{ color: 'var(--red)' }}>
                The plan version could not be read, so nothing here is shown. {frozen.message}
              </div>
            )}

            {/* No version means no frozen figures, and none are invented from the
                live balances instead. plan_settings is shown below under its own
                name, because it is what a version would be generated FROM, and
                not a plan that exists. */}
            {frozen.status === 'missing' && (
              <>
                <div className="sm">No plan version has been generated.</div>
                <div className="tiny muted" style={{ marginTop: 4 }}>
                  Progress says the same rather than drawing a line from today's balances.
                </div>
                {plan && (
                  <table className="tbl" style={{ marginTop: 10 }}>
                    <tbody>
                      <tr>
                        <td>Attack fund</td>
                        <td className="num">{moneyCents(plan.attack_fund)}</td>
                      </tr>
                      <tr>
                        <td>Monthly savings</td>
                        <td className="num">{moneyCents(plan.monthly_savings)}</td>
                      </tr>
                      <tr>
                        <td>Deposit target</td>
                        <td className="num">{money(plan.deposit_target)}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
                <div className="rule">
                  These are the settings a version would be generated from. They are not
                  projections, and no chart is drawn from them.
                </div>
              </>
            )}

            {frozen.status === 'ready' && version && (
              <>
                <table className="tbl">
                  <tbody>
                    <tr>
                      <td>Attack fund</td>
                      <td className="num">{moneyCents(version.attack_fund)}</td>
                    </tr>
                    <tr>
                      <td>Monthly savings</td>
                      <td className="num">{moneyCents(version.monthly_savings)}</td>
                    </tr>
                    <tr>
                      <td>Deposit target</td>
                      <td className="num">{money(version.deposit_target)}</td>
                    </tr>
                    {/* The phone drops the start date, as the mockup does. It is
                        the one line here that never changes and never needs
                        acting on. */}
                    {desktop && (
                      <tr>
                        <td>Started</td>
                        <td className="num">{dayMonthYear(version.effective_from)}</td>
                      </tr>
                    )}
                    <tr>
                      <td>Debt free</td>
                      <td className="num">
                        {desktop ? (
                          <>
                            month {frozen.frozen.planMonths} &middot;{' '}
                            {monthYear(frozen.frozen.debtFreeOn)}
                          </>
                        ) : (
                          monthYear(frozen.frozen.debtFreeOn)
                        )}
                      </td>
                    </tr>
                  </tbody>
                </table>

                {drifted && plan && (
                  <div className="rule">
                    plan_settings now reads{' '}
                    <span className="tnum">{moneyCents(plan.attack_fund)}</span> attack,{' '}
                    <span className="tnum">{moneyCents(plan.monthly_savings)}</span> savings and{' '}
                    <span className="tnum">{money(plan.deposit_target)}</span> deposit target. The
                    figures above are the ones version{' '}
                    <span className="tnum">{version.version}</span> was generated from, and they
                    are what Progress charts.
                  </div>
                )}

                <button
                  type="button"
                  className="btn ghost"
                  style={desktop ? { ...GHOST_SMALL, marginTop: 10 } : { marginTop: 10 }}
                  disabled
                  title="Generating a version is service-role work. The edge function does not exist yet."
                >
                  Revise the plan
                </button>

                {/* Deliberately dead, and deliberately not hidden.
                    Members hold SELECT and nothing else on plan_versions and
                    plan_projections, so a client-side insert would be rejected
                    by RLS, and a button that fails silently is worse than one
                    that says what it is waiting for. */}
                <div className="rule">
                  Revising creates version <span className="tnum">{version.version + 1}</span> and
                  keeps version <span className="tnum">{version.version}</span>, so the original
                  target stays visible on Progress. Projections are never edited in place.
                  Generating a version is service-role work and that edge function is not built
                  yet, so this button does nothing for now.
                </div>
              </>
            )}
          </Section>

          {/* ---------------- Household ---------------- */}
          <Section title="Household" desktop={desktop}>
            {loading ? (
              <div className="row" style={{ padding: '6px 0', borderBottom: 'none' }}>
                <div className="skeleton" style={{ width: 120, height: 11 }} />
              </div>
            ) : memberIds.length === 0 ? (
              <div className="sm muted">No members are readable on this session.</div>
            ) : (
              memberIds.map((id, i) => {
                const isYou = id === user?.id
                return (
                  <div
                    className="row"
                    key={id}
                    style={{
                      padding: '6px 0',
                      borderBottom: i === memberIds.length - 1 ? 'none' : undefined,
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div className="sm" style={{ fontWeight: 600 }}>
                        {memberNames[id]}
                      </div>
                      {/* Only your own row can carry an email or a push state.
                          household_members holds a display name and nothing more,
                          auth.users is not readable from the browser, and the
                          policy on push_subscriptions is user_id = auth.uid(). */}
                      <div className="tiny muted">
                        {isYou
                          ? `${desktop ? `${user?.email ?? 'no email on this session'} · ` : ''}${
                              pushOn ? 'push on for this device' : 'push off for this device'
                            }`
                          : 'email and push status are private to each member'}
                      </div>
                    </div>
                    {isYou && <span className="tiny muted">you</span>}
                  </div>
                )
              })
            )}
          </Section>

          {/* ---------------- Data ---------------- */}
          <Section title="Data" desktop={desktop}>
            <table className="tbl">
              <tbody>
                <tr>
                  <td>Banks linked</td>
                  <td className="num">
                    {banks ? (
                      `${banks.used} of ${banks.cap}`
                    ) : (
                      <span className="muted">not read</span>
                    )}
                  </td>
                </tr>
                {banks && banks.broken > 0 && (
                  <tr>
                    <td>Stopped updating</td>
                    <td className="num is-bad">
                      {banks.broken === 1 ? '1 connection' : `${banks.broken} connections`}
                    </td>
                  </tr>
                )}
                <tr>
                  <td>Last sync</td>
                  <td className="num">{relativeTime(lastSyncedAt)}</td>
                </tr>
                <tr>
                  <td>Transactions</td>
                  <td className="num">
                    {txnCount === null ? (
                      <span className="muted">not read</span>
                    ) : (
                      counts.format(txnCount)
                    )}
                  </td>
                </tr>
              </tbody>
            </table>

            {/* Side by side on desktop; stacked and full width on a phone, where
                the mockup gives Sign out the whole width. */}
            <div
              style={{
                display: 'flex',
                gap: 8,
                marginTop: 10,
                flexDirection: desktop ? 'row' : 'column',
              }}
            >
              <button
                type="button"
                className="btn ghost"
                style={desktop ? GHOST_SMALL : undefined}
                onClick={() => void runSync()}
                disabled={syncBusy}
              >
                {syncBusy ? 'Syncing…' : 'Sync now'}
              </button>
              <button
                type="button"
                className="btn ghost"
                style={desktop ? GHOST_SMALL : undefined}
                onClick={() => void signOut()}
              >
                Sign out
              </button>
            </div>

            {syncNote && (
              <div className="tiny muted" style={{ marginTop: 8 }}>
                {syncNote}
              </div>
            )}

            {/* The cap is Plaid's own figure and is not restated when it could not
                be read: a hardcoded 10 here would outlive the trial it describes. */}
            <div className="rule">
              {banks ? (
                <>
                  The trial plan allows <span className="tnum">{banks.cap}</span> connections in
                  total, and removing one does not return the allowance.
                </>
              ) : (
                'A connection spends the trial allowance permanently, and removing one does not return it.'
              )}{' '}
              A sync also runs nightly at 4am.
            </div>
          </Section>
        </div>
      </div>
    </main>
  )
}
