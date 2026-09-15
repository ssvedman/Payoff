/**
 * `check-alerts` — BUILD.md §6. Runs immediately after `sync`.
 *
 * Tone is not negotiable: this reports, it never advises.
 *   "Store card balance rose $68 since yesterday."
 *   Never "you shouldn't be using that card."
 *
 * Every alert respects notification_prefs, per user.
 */

import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') ?? ''
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:payoff@example.com'

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const pushConfigured = Boolean(VAPID_PUBLIC && VAPID_PRIVATE)
if (pushConfigured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE)
}

/** Current date parts in Eastern time — the household's timezone. */
function easternNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  const year = get('year')
  const month = get('month')
  const day = get('day')
  return {
    year,
    month,
    day,
    iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    monthStart: `${year}-${String(month).padStart(2, '0')}-01`,
    daysInMonth: new Date(year, month, 0).getDate(),
  }
}

const money = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n)

interface Alert {
  type: string
  title: string
  body: string
  /** Dedupe key — an alert already logged with this key is not resent. */
  dedupe: string
}

/**
 * Deliver to every subscription belonging to users who have this alert enabled.
 * A 404 or 410 from the push service means the subscription is dead; delete it.
 */
async function deliver(alert: Alert): Promise<number> {
  if (!pushConfigured) return 0

  const { data: prefs } = await admin
    .from('notification_prefs')
    .select('user_id, enabled')
    .eq('alert_type', alert.type)

  const prefByUser = new Map((prefs ?? []).map((p) => [p.user_id as string, p.enabled as boolean]))

  const { data: subs } = await admin.from('push_subscriptions').select('*')

  let sent = 0
  for (const sub of subs ?? []) {
    const userId = sub.user_id as string

    // monthly_summary is opt-in and defaults to off. Everything else defaults on.
    const fallback = alert.type !== 'monthly_summary'
    const enabled = prefByUser.has(userId) ? prefByUser.get(userId)! : fallback
    if (!enabled) continue

    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint as string,
          keys: { p256dh: sub.p256dh as string, auth: sub.auth_key as string },
        },
        JSON.stringify({
          title: alert.title,
          body: alert.body,
          // Unique per alert. Using the bare type would make three balance_up
          // notifications replace one another on the device.
          dedupe: alert.dedupe,
          tag: alert.type,
          url: './#/',
        }),
      )
      sent++
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) {
        await admin.from('push_subscriptions').delete().eq('endpoint', sub.endpoint as string)
      } else {
        console.error('push failed', status, (err as Error).message)
      }
    }
  }

  return sent
}

Deno.serve(async (req: Request) => {
  const cronHeader = req.headers.get('x-cron-secret')
  const authHeader = req.headers.get('Authorization') ?? ''
  const isCron = CRON_SECRET && cronHeader === CRON_SECRET
  const isService = authHeader === `Bearer ${SERVICE_KEY}`

  if (!isCron && !isService) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const now = easternNow()
  const alerts: Alert[] = []

  const [{ data: accounts }, { data: balances }, { data: plan }, { data: txns }, { data: lines }] =
    await Promise.all([
      admin.from('accounts').select('*').order('payoff_order'),
      admin.from('account_balance_current').select('*'),
      admin.from('plan_settings').select('*').eq('id', 1).maybeSingle(),
      admin.from('transactions').select('*').gte('posted_on', now.monthStart).lte('posted_on', now.iso),
      admin.from('budget_lines').select('*'),
    ])

  const balanceBy = new Map((balances ?? []).map((b) => [b.account_id as string, b]))
  const debts = (accounts ?? []).filter(
    (a) => a.kind === 'card' || a.kind === 'loan' || a.kind === 'tax',
  )

  const withBalance = debts.map((a) => {
    const b = balanceBy.get(a.id as string)
    return {
      ...a,
      balance: b ? Number(b.balance) : Number(a.opening_balance),
      prev: b && b.prev_balance !== null ? Number(b.prev_balance) : null,
    }
  })

  const target = withBalance.find((a) => a.balance > 0) ?? null

  // ---------- balance_up: a NON-TARGET account's balance rose ----------
  for (const a of withBalance) {
    if (target && a.id === target.id) continue
    if (a.prev === null) continue
    const delta = a.balance - a.prev
    if (delta > 0.005) {
      alerts.push({
        type: 'balance_up',
        title: 'Balance rose',
        body: `${a.name} balance rose ${money(delta)} since the previous reading.`,
        dedupe: `balance_up:${a.id}:${now.iso}`,
      })
    }
  }

  // ---------- attack_missing: nothing reached the target, past the 15th ----------
  if (target && now.day > 15 && plan) {
    const attackFund = Number(plan.attack_fund)
    const reached = (txns ?? [])
      .filter((t) => t.bucket === 'attack')
      .reduce((s, t) => s + Number(t.amount), 0)

    if (reached < attackFund) {
      alerts.push({
        type: 'attack_missing',
        title: 'Attack payment not seen',
        body: `${money(reached)} of the ${money(attackFund)} attack fund has reached ${target.name} this month.`,
        dedupe: `attack_missing:${now.year}-${now.month}`,
      })
    }
  }

  // ---------- optional_80: optional spend at 80% of target, once per month ----------
  const optionalTarget = (lines ?? [])
    .filter((l) => l.bucket === 'optional')
    .reduce((s, l) => s + Number(l.monthly_target), 0)

  const optionalSpent = (txns ?? [])
    .filter((t) => t.bucket === 'optional')
    .reduce((s, t) => s + Number(t.amount), 0)

  if (optionalTarget > 0 && optionalSpent >= optionalTarget * 0.8) {
    const pct = Math.round((optionalSpent / optionalTarget) * 100)
    alerts.push({
      type: 'optional_80',
      title: 'Optional bucket',
      body: `Optional spending is at ${pct}% of the ${money(optionalTarget)} monthly target, with ${now.daysInMonth - now.day} days left.`,
      dedupe: `optional_80:${now.year}-${now.month}`,
    })
  }

  // ---------- business_low: business checking below $500 ----------
  const business = (accounts ?? []).find((a) => a.is_business)
  if (business) {
    const b = balanceBy.get(business.id as string)
    const bal = b ? Number(b.balance) : null
    if (bal !== null && bal < 500) {
      alerts.push({
        type: 'business_low',
        title: 'Business account low',
        body: `${business.name} is at ${money(bal)}.`,
        dedupe: `business_low:${now.iso}`,
      })
    }
  }

  // ---------- balance_stale: a typed-in figure has gone unrefreshed ----------
  // Five debts cannot be reached by Plaid at all, so their balances are only ever
  // as good as the last time somebody typed one in — and every figure derived from
  // them, including the payoff projection and the headline total, is exactly that
  // stale without saying so. Nagging once a month per account rather than nightly:
  // a reminder that arrives every day is one that gets swiped away every day.
  const STALE_DAYS = 30
  for (const a of withBalance) {
    if (!a.is_manual) continue
    const b = balanceBy.get(a.id as string)
    const asOf = b?.as_of as string | undefined
    if (!asOf) continue
    const age = Math.round(
      (Date.parse(`${now.iso}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86400000,
    )
    if (age >= STALE_DAYS) {
      alerts.push({
        type: 'balance_stale',
        title: 'Balance needs updating',
        body: `${a.name} was last updated ${age} days ago. Anything worked out from it is that old too.`,
        dedupe: `balance_stale:${a.id}:${now.year}-${now.month}`,
      })
    }
  }

  // ---------- account_cleared: queued by sync ----------
  const { data: pendingCleared } = await admin
    .from('alert_log')
    .select('*')
    .in('alert_type', ['account_cleared', 'item_login_required'])
    .gte('sent_at', `${now.iso}T00:00:00Z`)

  for (const row of pendingCleared ?? []) {
    const payload = (row.payload ?? {}) as { title?: string; body?: string; pending?: boolean }
    if (!payload.pending) continue
    alerts.push({
      type: row.alert_type as string,
      title: payload.title ?? 'Payoff',
      body: payload.body ?? '',
      dedupe: `${row.alert_type}:${row.id}`,
    })
    await admin
      .from('alert_log')
      .update({ payload: { ...payload, pending: false } })
      .eq('id', row.id as number)
  }

  // ---------- monthly_summary: 1st of the month, opt-in ----------
  if (now.day === 1 && plan) {
    const owed = withBalance.filter((a) => a.balance > 0).reduce((s, a) => s + a.balance, 0)
    alerts.push({
      type: 'monthly_summary',
      title: 'Monthly summary',
      body: target
        ? `${money(owed)} owed across ${withBalance.filter((a) => a.balance > 0).length} accounts. Current target is ${target.name}.`
        : `${money(owed)} owed. Every account is clear.`,
      dedupe: `monthly_summary:${now.year}-${now.month}`,
    })
  }

  // ---------- deliver, skipping anything already sent ----------
  const { data: alreadySent } = await admin
    .from('alert_log')
    .select('payload')
    .gte('sent_at', `${now.year}-${String(now.month).padStart(2, '0')}-01T00:00:00Z`)

  const seen = new Set(
    (alreadySent ?? [])
      .map((r) => (r.payload as { dedupe?: string } | null)?.dedupe)
      .filter(Boolean) as string[],
  )

  const results: unknown[] = []
  for (const alert of alerts) {
    if (seen.has(alert.dedupe)) {
      results.push({ type: alert.type, skipped: 'already sent' })
      continue
    }

    const sent = await deliver(alert)
    await admin.from('alert_log').insert({
      alert_type: alert.type,
      payload: { title: alert.title, body: alert.body, dedupe: alert.dedupe, sent },
    })
    results.push({ type: alert.type, sent, body: alert.body })
  }

  return new Response(
    JSON.stringify({ asOf: now.iso, pushConfigured, evaluated: alerts.length, results }, null, 2),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
