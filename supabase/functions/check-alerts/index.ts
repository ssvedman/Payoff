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
  /** For an alert queued by sync: the alert_log row to mark done once delivered. */
  pendingRowId?: number
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

  // Only household members. The subscription table's RLS is keyed on
  // user_id = auth.uid(), which stops one user reading another's row but says
  // nothing about whether they are still in the household — so removing someone
  // from household_members revoked their access to the app while their device
  // kept receiving balances and account names by push.
  const { data: members } = await admin.from('household_members').select('user_id')
  const memberIds = (members ?? []).map((m) => m.user_id as string)
  if (memberIds.length === 0) return 0

  const { data: subs } = await admin
    .from('push_subscriptions')
    .select('*')
    .in('user_id', memberIds)

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

  // Same transient rejection as sync guards against: a clock skew of a second or
  // two makes a valid service key look as though it were issued in the future.
  // Retry briefly before deciding the reads have genuinely failed.
  const readAll = () =>
    Promise.all([
      admin.from('accounts').select('*').order('payoff_order'),
      admin.from('account_balance_current').select('*'),
      admin.from('plan_settings').select('*').eq('id', 1).maybeSingle(),
      admin.from('transactions').select('*').gte('posted_on', now.monthStart).lte('posted_on', now.iso),
      admin.from('budget_lines').select('*'),
    ])

  let [accountsRes, balancesRes, planRes, txnsRes, linesRes] = await readAll()

  for (let attempt = 1; attempt <= 2; attempt++) {
    const firstErr =
      accountsRes.error ?? balancesRes.error ?? planRes.error ?? txnsRes.error ?? linesRes.error
    if (!firstErr) break
    await new Promise((r) => setTimeout(r, 1200 * attempt))
    ;[accountsRes, balancesRes, planRes, txnsRes, linesRes] = await readAll()
  }

  // postgrest-js resolves with {data: null, error} instead of rejecting. Every
  // alert here is an ABSENCE test — "no attack payment seen", "balance not
  // updated" — so a failed read looks exactly like the condition being alerted
  // on. A database blip would have pushed "Attack payment not seen" at a
  // household that had paid on time. Say nothing rather than say something false.
  const readErr =
    accountsRes.error ?? balancesRes.error ?? planRes.error ?? txnsRes.error ?? linesRes.error
  if (readErr) {
    return new Response(
      JSON.stringify({ error: `no alerts evaluated: ${readErr.message}` }, null, 2),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const accounts = accountsRes.data
  const balances = balancesRes.data
  const plan = planRes.data
  const lines = linesRes.data

  /**
   * HOUSEHOLD transactions only.
   *
   * A business account's spending is tracked and charted but is not household
   * money, so it belongs in no budget bucket. Every alert below that measures
   * spending against a target reads this, not the raw rows — otherwise
   * `optional_80` warns that the household is near its discretionary limit on
   * money the budget does not count and the /month page does not show.
   *
   * Mirrors the client: src/lib/data.tsx narrows `transactions` the same way.
   */
  const businessAccountIds = new Set(
    (accounts ?? []).filter((a) => a.is_business).map((a) => a.id as string),
  )
  const txns = (txnsRes.data ?? []).filter((t) => !businessAccountIds.has(t.account_id as string))

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

  /**
   * Cleared means the same thing here as it does in the app: nothing owed, OR a
   * clearing date on record. Testing only the balance let an account that had
   * been marked cleared by hand, but still showed a stale positive figure, be
   * picked as the target — and the target is what the attack_missing alert
   * watches, so the wrong one silently watches the wrong account.
   */
  const isCleared = (a: { balance: number; cleared_at: unknown }) =>
    a.balance <= 0 || a.cleared_at !== null

  const open = withBalance.filter((a) => !isCleared(a))
  const target = open[0] ?? null

  // ---------- balance_up: a NON-TARGET CARD's balance rose ----------
  //
  // Cards only. This alert exists to catch spending on an account that is
  // supposed to be dormant — that is its whole purpose, and its own setting says
  // so. A loan or a tax debt cannot be spent on: its balance moves because
  // interest accrued, or because the debt came into existence, and reporting
  // either as though somebody had gone shopping is simply wrong. An instalment
  // loan appearing at origination read as a fifty-thousand-dollar shopping trip.
  for (const a of withBalance) {
    if (a.kind !== 'card') continue
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
    // Only payments that actually named this target. Summing every 'attack' row
    // in the month counted payments made to the PREVIOUS target before it
    // cleared, so the month a target is paid off reports the attack fund as
    // already delivered to its successor and the alert never fires.
    const names = [target.name, ...((target.payment_aliases as string[] | null) ?? [])]
      .filter(Boolean)
      .map((n) => String(n).trim().toLowerCase())
      .filter((n) => n.length >= 4)

    const reached = (txns ?? [])
      .filter((t) => {
        if (t.bucket !== 'attack') return false
        const hay = `${t.name ?? ''} ${t.merchant_name ?? ''}`.toLowerCase()
        return names.some((n) => hay.includes(n))
      })
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
  // A business CHECKING account, as specified. The unfiltered find() picked
  // whichever flagged row came first, which is a business credit card sitting at
  // zero — so the alert read "Business account low: $0" about a card that is
  // paid off, which is the opposite of the thing worth knowing.
  const business = (accounts ?? []).find((a) => a.is_business && a.kind === 'checking')
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
  // A debt Plaid cannot reach is only ever as good as the last time somebody
  // typed a figure in, and everything derived from it is silently that old.
  // An account carrying a repayment SCHEDULE is exempt: its balance is
  // recomputed nightly from the contract, so there is nothing to nag about.
  const { data: scheduled } = await admin.from('debt_schedules').select('account_id')
  const hasSchedule = new Set((scheduled ?? []).map((s) => s.account_id as string))

  const STALE_DAYS = 30
  for (const a of withBalance) {
    // The reality gate, not the intent one. is_manual records what someone meant;
    // an unset plaid_account_id is what the account actually is. Several debts
    // the UI itself labels "not connected to a bank" carry is_manual = false, so
    // gating on intent skipped exactly the accounts this alert exists for.
    if (a.plaid_account_id) continue
    if (hasSchedule.has(a.id as string)) continue
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

  // ---------- account_dormant: a card unused long enough to be at risk ----------
  //
  // Issuers close cards that go unused, and a closed card removes its credit
  // limit from the total available — which raises utilisation across every other
  // card at once, without anybody having spent a penny. A paid-off card sitting
  // at zero is the most useful one to keep open and the easiest to forget.
  //
  // Only cards that are CONNECTED: judging dormancy needs a transaction feed, and
  // a hand-maintained card has none. Silence there means no data, not no use.
  //
  // Business cards included, deliberately: the budget ignores their spending but
  // an issuer closing one still costs the household its credit limit.
  const DORMANT_DAYS = 180

  const { data: lastActivity } = await admin
    .from('transactions')
    .select('account_id, posted_on')
    .order('posted_on', { ascending: false })

  const lastSeen = new Map<string, string>()
  for (const t of lastActivity ?? []) {
    const id = t.account_id as string
    if (!lastSeen.has(id)) lastSeen.set(id, t.posted_on as string)
  }

  for (const a of withBalance) {
    if (a.kind !== 'card') continue
    if (!a.plaid_account_id) continue

    const seen = lastSeen.get(a.id as string)
    const days = seen
      ? Math.round((Date.parse(`${now.iso}T00:00:00Z`) - Date.parse(`${seen}T00:00:00Z`)) / 86400000)
      : null

    if (days !== null && days >= DORMANT_DAYS) {
      alerts.push({
        type: 'account_dormant',
        title: 'Card has gone unused',
        body: `Nothing has been charged to ${a.name} in ${days} days. Issuers sometimes close an account after a long spell of no use, and a closed card takes its credit limit with it.`,
        dedupe: `account_dormant:${a.id}:${now.year}-${now.month}`,
      })
    }
  }

  // ---------- account_cleared: queued by sync ----------
  const { data: pendingCleared } = await admin
    .from('alert_log')
    .select('*')
    .in('alert_type', ['account_cleared', 'item_login_required'])
    // Seven days, not today. A row queued by sync is only picked up while this
    // window contains it, so a single failed dispatch — or a queue written just
    // before midnight Eastern, since sent_at is UTC — dropped the alert forever.
    // `pending` is the real guard against re-sending; the window is only a bound.
    .gte('sent_at', new Date(Date.now() - 7 * 86400000).toISOString())

  for (const row of pendingCleared ?? []) {
    const payload = (row.payload ?? {}) as { title?: string; body?: string; pending?: boolean }
    if (!payload.pending) continue
    // Carry the row id rather than clearing `pending` here. Clearing it at
    // collection time marked the alert done before a single delivery had been
    // attempted, so anything that went wrong in deliver() consumed the alert
    // silently — the one queued alert that matters, an account reaching zero,
    // was the easiest to lose.
    alerts.push({
      type: row.alert_type as string,
      title: payload.title ?? 'Payoff',
      body: payload.body ?? '',
      dedupe: `${row.alert_type}:${row.id}`,
      pendingRowId: row.id as number,
    })
  }

  // ---------- monthly_summary: 1st of the month, opt-in ----------
  if (now.day === 1 && plan) {
    const owed = open.reduce((s, a) => s + a.balance, 0)
    alerts.push({
      type: 'monthly_summary',
      title: 'Monthly summary',
      body: target
        ? `${money(owed)} owed across ${open.length} accounts. Current target is ${target.name}.`
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

    // Only now is the queued row done with. Retried on the next run otherwise.
    if (alert.pendingRowId !== undefined && sent > 0) {
      const { data: row } = await admin
        .from('alert_log')
        .select('payload')
        .eq('id', alert.pendingRowId)
        .maybeSingle()
      const payload = (row?.payload ?? {}) as Record<string, unknown>
      await admin
        .from('alert_log')
        .update({ payload: { ...payload, pending: false } })
        .eq('id', alert.pendingRowId)
    }

    // Record the dedupe key ONLY if something was actually delivered. Logging it
    // regardless meant the first run — before any device had registered, or while
    // VAPID was unset, or during a push outage — permanently suppressed that
    // alert: the key was burnt, and every later run skipped it as "already sent"
    // even though nobody was ever told. An alert nobody received has not been
    // sent, and the log should not claim otherwise.
    await admin.from('alert_log').insert({
      alert_type: alert.type,
      payload: {
        title: alert.title,
        body: alert.body,
        sent,
        // Absent when sent === 0, so the next run re-evaluates it.
        ...(sent > 0 ? { dedupe: alert.dedupe } : { undelivered: alert.dedupe }),
      },
    })
    results.push({ type: alert.type, sent, body: alert.body, retryable: sent === 0 })
  }

  return new Response(
    JSON.stringify({ asOf: now.iso, pushConfigured, evaluated: alerts.length, results }, null, 2),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
