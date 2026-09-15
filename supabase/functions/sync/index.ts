/**
 * `sync` — nightly Plaid pull. BUILD.md §5.
 *
 * For each linked Plaid item:
 *   /accounts/balance/get   → a balance snapshot for every mapped account
 *   /liabilities/get        → APR, minimum payment and due date, CREDIT CARDS ONLY
 *   /transactions/sync      → cursor-based transaction delta
 *
 * Invoked by pg_cron at 04:00 ET, and callable by a household member for a manual
 * refresh. verify_jwt is off because pg_cron sends no user JWT; authorization is
 * enforced in-function, below.
 */

import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  balanceGet,
  liabilitiesGet,
  transactionsSyncAll,
  purchaseApr,
  PlaidError,
  type PlaidAccount,
} from './plaid.ts'
import { categorize, type Bucket, type RuleLike } from './categorize.ts'

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
// They cannot be set as custom secrets — the name prefix SUPABASE_ is reserved.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const today = () => {
  // Snapshots are dated in Eastern time, which is where the household lives.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

interface AccountRow {
  id: string
  name: string
  kind: string
  apr: number | null
  minimum_payment: number
  plaid_account_id: string | null
  is_manual: boolean
  cleared_at: string | null
  is_business: boolean
}

/**
 * Callers: pg_cron with the shared CRON_SECRET, or a signed-in household member.
 * Anything else is rejected before a single Plaid call is made.
 */
async function authorize(req: Request): Promise<{ ok: boolean; who: string }> {
  const cronHeader = req.headers.get('x-cron-secret')
  if (CRON_SECRET && cronHeader && cronHeader === CRON_SECRET) {
    return { ok: true, who: 'cron' }
  }

  const auth = req.headers.get('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return { ok: false, who: 'anonymous' }

  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) return { ok: false, who: 'anonymous' }

  const { data: member } = await admin
    .from('household_members')
    .select('user_id')
    .eq('user_id', data.user.id)
    .maybeSingle()

  return { ok: Boolean(member), who: data.user.id }
}

async function notify(alertType: string, title: string, body: string) {
  // check-alerts owns delivery. sync only records what happened so the follow-on
  // run can turn it into a push without re-deriving it.
  await admin.from('alert_log').insert({
    alert_type: alertType,
    payload: { title, body, pending: true },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 })
  }

  const auth = await authorize(req)
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const asOf = today()
  const report = {
    asOf,
    items: [] as unknown[],
    snapshots: 0,
    transactionsUpserted: 0,
    transactionsRemoved: 0,
    liabilitiesUpdated: 0,
    cleared: [] as string[],
    errors: [] as string[],
  }

  const [{ data: itemRows }, { data: accountRows }, { data: ruleRows }] = await Promise.all([
    admin.from('plaid_items').select('*'),
    admin.from('accounts').select('*'),
    admin.from('merchant_rules').select('match_text, bucket'),
  ])

  const accounts = (accountRows ?? []) as AccountRow[]
  const rules = (ruleRows ?? []) as RuleLike[]
  const byPlaidId = new Map(accounts.filter((a) => a.plaid_account_id).map((a) => [a.plaid_account_id!, a]))

  const debtAccounts = accounts.filter(
    (a) => a.kind === 'card' || a.kind === 'loan' || a.kind === 'tax',
  )
  const debtNames = debtAccounts.map((a) => a.name.toLowerCase())
  const savingsNames = accounts.filter((a) => a.kind === 'savings').map((a) => a.name.toLowerCase())

  // The current target: lowest payoff_order still owing. Only payments to this
  // account count toward the attack fund; payments to the others are minimums.
  const { data: currentBalances } = await admin.from('account_balance_current').select('*')
  const balanceById = new Map(
    (currentBalances ?? []).map((b: Record<string, unknown>) => [b.account_id as string, Number(b.balance)]),
  )
  const targetName =
    [...debtAccounts]
      .sort((x, y) => (x as unknown as { payoff_order: number }).payoff_order - (y as unknown as { payoff_order: number }).payoff_order)
      .find((a) => !a.cleared_at && (balanceById.get(a.id) ?? Infinity) > 0)?.name ?? null

  for (const item of itemRows ?? []) {
    const itemId = item.item_id as string
    const itemReport: Record<string, unknown> = { itemId, institution: item.institution }

    try {
      const { data: token, error: tokenErr } = await admin.rpc('plaid_token_get', {
        p_item_id: itemId,
      })
      if (tokenErr || !token) throw new Error(`no access token in vault for ${itemId}`)

      // ---------- balances ----------
      const { accounts: plaidAccounts } = await balanceGet(token as string)
      const snapshots: Record<string, unknown>[] = []

      for (const pa of plaidAccounts as PlaidAccount[]) {
        const acct = byPlaidId.get(pa.account_id)
        if (!acct || acct.is_manual) continue

        const current = pa.balances.current
        if (current === null || current === undefined) continue

        // No sign flip. A credit balance owed is already positive, and a loan's
        // current balance is the principal remaining.
        snapshots.push({
          account_id: acct.id,
          balance: current,
          as_of: asOf,
          source: 'plaid',
        })

        if (current <= 0 && !acct.cleared_at) {
          await admin.from('accounts').update({ cleared_at: asOf }).eq('id', acct.id)
          report.cleared.push(acct.name)
          await notify('account_cleared', 'Account cleared', `${acct.name} reached zero.`)
        }
      }

      if (snapshots.length) {
        const { error } = await admin
          .from('balance_snapshots')
          .upsert(snapshots, { onConflict: 'account_id,as_of,source' })
        if (error) throw error
        report.snapshots += snapshots.length
      }
      itemReport.snapshots = snapshots.length

      // ---------- liabilities: CREDIT CARDS ONLY ----------
      // /liabilities/get covers credit, student and mortgage. Auto and personal
      // loans return nothing, so those accounts keep their seeded APR and minimum.
      // Never write a null over a seeded value.
      try {
        const liab = await liabilitiesGet(token as string)
        for (const credit of liab.liabilities?.credit ?? []) {
          const acct = byPlaidId.get(credit.account_id)
          if (!acct) continue

          // Only ever write a POSITIVE value over a seeded one. Plaid reports 0 for
          // a card with nothing due this cycle, and a 0 minimum_payment would drop
          // that account out of the avalanche pool entirely — the same class of
          // damage as the null-overwrite the spec warns about, just harder to spot.
          const patch: Record<string, unknown> = {}
          const rate = purchaseApr(credit.aprs)
          if (rate !== null && rate > 0) patch.apr = rate
          if (
            typeof credit.minimum_payment_amount === 'number' &&
            credit.minimum_payment_amount > 0
          ) {
            patch.minimum_payment = credit.minimum_payment_amount
          }

          if (Object.keys(patch).length) {
            await admin.from('accounts').update(patch).eq('id', acct.id)
            report.liabilitiesUpdated++
          }
        }
      } catch (err) {
        // A missing liabilities product must not abort the whole item.
        if (err instanceof PlaidError && err.code === 'PRODUCTS_NOT_SUPPORTED') {
          itemReport.liabilities = 'not supported for this institution'
        } else {
          itemReport.liabilities = `skipped: ${(err as Error).message}`
        }
      }

      // ---------- transactions ----------
      const delta = await transactionsSyncAll(token as string, (item.cursor as string | null) ?? null)

      const incoming = [...delta.added, ...delta.modified].filter((t) => byPlaidId.has(t.account_id))

      if (incoming.length) {
        // A manual override is never recomputed, so read what we already hold.
        const ids = incoming.map((t) => t.transaction_id)
        const existing = new Map<string, { bucket: string; bucket_source: string }>()
        for (let i = 0; i < ids.length; i += 200) {
          const { data, error } = await admin
            .from('transactions')
            .select('plaid_transaction_id, bucket, bucket_source')
            .in('plaid_transaction_id', ids.slice(i, i + 200))
          // Swallowing this would make every manual override look absent and get
          // silently recomputed — "a manual override is never recomputed" is a
          // stated non-negotiable, so a failed read must abort the item instead.
          if (error) throw new Error(`prior-bucket lookup failed: ${error.message}`)
          for (const row of data ?? []) {
            existing.set(row.plaid_transaction_id as string, {
              bucket: row.bucket as string,
              bucket_source: row.bucket_source as string,
            })
          }
        }

        const rows = incoming.map((t) => {
          const acct = byPlaidId.get(t.account_id)!
          const prior = existing.get(t.transaction_id)
          const detailed = t.personal_finance_category?.detailed ?? null

          const { bucket, source } = categorize({
            name: t.name,
            merchantName: t.merchant_name,
            plaidCategory: detailed,
            amount: t.amount,
            accountKind: acct.kind,
            targetName,
            debtNames,
            savingsNames,
            rules,
            existingBucketSource: prior?.bucket_source,
            existingBucket: prior?.bucket as Bucket | undefined,
          })

          return {
            plaid_transaction_id: t.transaction_id,
            account_id: acct.id,
            posted_on: t.date,
            name: t.name,
            merchant_name: t.merchant_name,
            // Positive for money out, exactly as Plaid reports it.
            amount: t.amount,
            plaid_category: detailed,
            bucket,
            bucket_source: source,
            pending: t.pending,
          }
        })

        for (let i = 0; i < rows.length; i += 200) {
          const { error } = await admin
            .from('transactions')
            .upsert(rows.slice(i, i + 200), { onConflict: 'plaid_transaction_id' })
          if (error) throw error
        }
        report.transactionsUpserted += rows.length
      }

      // Pending transactions are replaced, not updated — removed[] must be honoured
      // or the ledger keeps rows the bank has retracted.
      if (delta.removed.length) {
        for (let i = 0; i < delta.removed.length; i += 200) {
          const { error } = await admin
            .from('transactions')
            .delete()
            .in('plaid_transaction_id', delta.removed.slice(i, i + 200))
          // Throw BEFORE the cursor advances. A swallowed failure here would leave
          // a retracted transaction in the ledger permanently, because the next
          // sync starts past it and Plaid never reports it again.
          if (error) throw new Error(`removed[] delete failed: ${error.message}`)
        }
        report.transactionsRemoved += delta.removed.length
      }

      await admin
        .from('plaid_items')
        .update({ cursor: delta.cursor, status: 'ok', last_synced: new Date().toISOString() })
        .eq('item_id', itemId)

      itemReport.transactions = { added: delta.added.length, modified: delta.modified.length, removed: delta.removed.length }
      itemReport.status = 'ok'
    } catch (err) {
      const e = err as Error
      const code = err instanceof PlaidError ? err.code : 'ERROR'

      // ITEM_LOGIN_REQUIRED means the bank needs re-authentication. Mark it stale
      // and notify once — never retry in a loop.
      if (code === 'ITEM_LOGIN_REQUIRED') {
        // Notify only on the transition into the stale state. Without this check
        // the same alert fires every night until someone re-links.
        const alreadyStale = item.status === 'login_required'
        await admin.from('plaid_items').update({ status: 'login_required' }).eq('item_id', itemId)
        if (!alreadyStale) {
          await notify(
            'item_login_required',
            'Bank connection needs attention',
            `${item.institution} needs to be reconnected before it can sync again.`,
          )
        }
      } else {
        await admin.from('plaid_items').update({ status: 'error' }).eq('item_id', itemId)
      }

      itemReport.status = code
      itemReport.error = e.message
      report.errors.push(`${item.institution}: ${code}`)
    }

    report.items.push(itemReport)
  }

  // check-alerts runs after sync. pg_net is fire-and-forget so two offset cron
  // jobs could not guarantee ordering — chaining here does.
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/check-alerts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': CRON_SECRET,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ triggeredBy: 'sync', asOf }),
    })
  } catch (err) {
    report.errors.push(`check-alerts dispatch failed: ${(err as Error).message}`)
  }

  return new Response(JSON.stringify(report, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  })
})
