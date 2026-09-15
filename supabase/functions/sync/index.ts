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
import { categorize, matchRule as matchedRule, type Bucket, type RuleLike } from './categorize.ts'

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
  payoff_order: number
  /** Statement descriptors that stand in for this account's name. */
  payment_aliases: string[] | null
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
    reopened: [] as string[],
    target: null as string | null,
    errors: [] as string[],
  }

  /**
   * Read the whole picture, retrying a transient failure before giving up.
   *
   * The platform intermittently rejects a perfectly good service key with
   * "JWT issued at future" — a clock skew of a second or two between whatever
   * mints the token and whatever validates it. The abort below is right to
   * refuse to continue on a failed read, but refusing on the FIRST failure made
   * every run a coin flip: two of the last five manual syncs died this way with
   * nothing wrong at either end.
   *
   * A short backoff clears it. Anything still failing after three attempts is
   * not a blip, and the abort stands.
   */
  const readAll = () =>
    Promise.all([
      admin.from('plaid_items').select('*'),
      admin.from('accounts').select('*'),
      admin.from('merchant_rules').select('match_text, bucket, budget_line_id'),
      admin.from('budget_line_rules').select('plaid_prefix, budget_line_id'),
    ])

  let [itemsRes, accountsRes, rulesRes, lineRulesRes] = await readAll()

  for (let attempt = 1; attempt <= 2; attempt++) {
    const firstErr = itemsRes.error ?? accountsRes.error ?? rulesRes.error ?? lineRulesRes.error
    if (!firstErr) break
    report.errors.push(`read attempt ${attempt} failed, retrying: ${firstErr.message}`)
    await new Promise((r) => setTimeout(r, 1200 * attempt))
    ;[itemsRes, accountsRes, rulesRes, lineRulesRes] = await readAll()
  }

  // postgrest-js resolves with {data: null, error} rather than rejecting, so a
  // failed read here used to sail straight through: `accounts` came back empty,
  // every transaction looked like it belonged to an unmapped account, nothing was
  // written — and the cursor still advanced past all of it. Plaid never re-emits
  // a transaction the cursor has passed, so a transient database blip silently
  // destroyed history. Refuse to run at all instead.
  const readErr = itemsRes.error ?? accountsRes.error ?? rulesRes.error ?? lineRulesRes.error
  if (readErr) {
    return new Response(
      JSON.stringify({ error: `aborted before touching Plaid: ${readErr.message}` }, null, 2),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const itemRows = itemsRes.data
  const accountRows = accountsRes.data
  const ruleRows = rulesRes.data
  const lineRuleRows = lineRulesRes.data

  /**
   * Which budget line a Plaid category counts against. Longest matching prefix
   * wins, so a detailed category beats a broad one. A merchant rule overrides it.
   */
  const lineRules = ((lineRuleRows ?? []) as { plaid_prefix: string; budget_line_id: string }[])
    .slice()
    .sort((a, b) => b.plaid_prefix.length - a.plaid_prefix.length)

  const lineForCategory = (detailed: string | null): string | null => {
    if (!detailed) return null
    const up = detailed.toUpperCase()
    for (const r of lineRules) {
      if (up === r.plaid_prefix || up.startsWith(r.plaid_prefix)) return r.budget_line_id
    }
    return null
  }

  const accounts = (accountRows ?? []) as AccountRow[]
  const rules = (ruleRows ?? []) as RuleLike[]
  const byPlaidId = new Map(accounts.filter((a) => a.plaid_account_id).map((a) => [a.plaid_account_id!, a]))

  /** One definition, so the balance loop and the queue cannot drift apart. */
  const isDebtKind = (k: string) => k === 'card' || k === 'loan' || k === 'tax'

  const debtAccounts = accounts.filter((a) => isDebtKind(a.kind))
  /** An account's name plus every descriptor known to stand in for it. */
  const namesOf = (a: AccountRow) =>
    [a.name, ...(a.payment_aliases ?? [])]
      .filter(Boolean)
      .map((n) => String(n).toLowerCase())

  const debtNames = debtAccounts.flatMap(namesOf)
  const savingsNames = accounts.filter((a) => a.kind === 'savings').flatMap(namesOf)

  /**
   * The current target: lowest payoff_order still owing.
   *
   * Deliberately NOT computed yet. Deriving it here would read the balances left
   * by the PREVIOUS run, so on the night a target is finally paid off every
   * payment to its successor would be filed as an ordinary minimum — and nothing
   * ever re-categorizes a stored row, so that misfiling is permanent. The run is
   * therefore split in two: every balance is written first, the target is derived
   * from the result, and only then are transactions categorized.
   */
  const deriveTarget = async () => {
    const { data: fresh } = await admin.from('account_balance_current').select('*')
    const byId = new Map(
      (fresh ?? []).map((b: Record<string, unknown>) => [b.account_id as string, Number(b.balance)]),
    )
    // cleared_at is read off the in-memory rows, which pass 1 keeps current.
    const t =
      [...debtAccounts]
        .sort((x, y) => x.payoff_order - y.payoff_order)
        .find((a) => !a.cleared_at && (byId.get(a.id) ?? Infinity) > 0) ?? null
    return { target: t, names: t ? namesOf(t) : [] }
  }

  /** Shared by both passes, so an item fails the same way whichever one hit it. */
  async function handleItemError(
    item: Record<string, unknown>,
    itemReport: Record<string, unknown>,
    err: unknown,
  ) {
    const itemId = item.item_id as string
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

  const reportByItem = new Map<string, Record<string, unknown>>()

  // ================= PASS 1: balances, liabilities, cleared_at =================
  for (const item of itemRows ?? []) {
    const itemId = item.item_id as string
    const itemReport: Record<string, unknown> = { itemId, institution: item.institution }
    reportByItem.set(itemId, itemReport)
    report.items.push(itemReport)

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

        // Only a DEBT can clear. byPlaidId holds every mapped account, so this
        // branch used to stamp cleared_at on a checking or savings account the
        // moment it hit zero and push "Account cleared" about a current account
        // running empty — the opposite of good news.
        if (isDebtKind(acct.kind)) {
          if (current <= 0 && !acct.cleared_at) {
            await admin.from('accounts').update({ cleared_at: asOf }).eq('id', acct.id)
            acct.cleared_at = asOf
            report.cleared.push(acct.name)
            await notify('account_cleared', 'Account cleared', `${acct.name} reached zero.`)
          } else if (current > 0 && acct.cleared_at) {
            // Release the latch. cleared_at was only ever set, never reset, and
            // isCleared() treats any non-null value as cleared forever — so a card
            // paid to zero and then used again dropped out of Total owed, counted
            // as already repaid, and was handed to the simulation as a zero
            // balance it would never pay off. The household was told it owed less
            // than it did, permanently.
            await admin.from('accounts').update({ cleared_at: null }).eq('id', acct.id)
            acct.cleared_at = null
            report.reopened.push(acct.name)
            await notify(
              'balance_up',
              'Account no longer clear',
              `${acct.name} has a balance again: ${current.toFixed(2)}.`,
            )
          }
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

          // When it is due, and what was last paid. The spec asked for these from
          // the start; they were being read off the response and discarded, so
          // nine debts had nine due dates and the app knew none of them.
          //
          // A null here means "the issuer did not say this cycle", not "there is
          // no due date" — so, as with the rate, never write a null over a value
          // that is already known.
          if (credit.next_payment_due_date) patch.next_due_on = credit.next_payment_due_date
          if (credit.last_payment_date) patch.last_payment_on = credit.last_payment_date
          if (typeof credit.last_payment_amount === 'number') {
            patch.last_payment_amount = credit.last_payment_amount
          }
          if (typeof credit.last_statement_balance === 'number') {
            patch.last_statement_balance = credit.last_statement_balance
          }

          if (Object.keys(patch).length) {
            const { error: liabErr } = await admin.from('accounts').update(patch).eq('id', acct.id)
            // Counting an unchecked write as a success reported an APR refresh
            // that never happened.
            if (liabErr) {
              report.errors.push(`liability write failed for ${acct.name}: ${liabErr.message}`)
            } else {
              report.liabilitiesUpdated++
            }
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

      itemReport.balancesDone = true
    } catch (err) {
      await handleItemError(item, itemReport, err)
    }
  }

  // Every balance for every item is now written, so the queue reflects tonight's
  // reality rather than last night's. Derive the target from THAT.
  const { target: targetAccount, names: targetNames } = await deriveTarget()
  report.target = targetAccount ? targetAccount.name : null

  // ===================== PASS 2: transactions and cursor ======================
  for (const item of itemRows ?? []) {
    const itemId = item.item_id as string
    const itemReport = reportByItem.get(itemId)!

    // An item that failed pass 1 has already been marked and notified about;
    // draining its cursor now would burn history against a broken connection.
    if (!itemReport.balancesDone) continue

    try {
      const { data: token, error: tokenErr } = await admin.rpc('plaid_token_get', {
        p_item_id: itemId,
      })
      if (tokenErr || !token) throw new Error(`no access token in vault for ${itemId}`)

      // ---------- transactions ----------
      const delta = await transactionsSyncAll(token as string, (item.cursor as string | null) ?? null)

      const incoming = [...delta.added, ...delta.modified].filter((t) => byPlaidId.has(t.account_id))

      if (incoming.length) {
        // A manual override is never recomputed, so read what we already hold.
        const ids = incoming.map((t) => t.transaction_id)
        const existing = new Map<string, { bucket: string; bucket_source: string; budget_line_id: string | null }>()
        for (let i = 0; i < ids.length; i += 200) {
          const { data, error } = await admin
            .from('transactions')
            .select('plaid_transaction_id, bucket, bucket_source, budget_line_id')
            .in('plaid_transaction_id', ids.slice(i, i + 200))
          // Swallowing this would make every manual override look absent and get
          // silently recomputed — "a manual override is never recomputed" is a
          // stated non-negotiable, so a failed read must abort the item instead.
          if (error) throw new Error(`prior-bucket lookup failed: ${error.message}`)
          for (const row of data ?? []) {
            existing.set(row.plaid_transaction_id as string, {
              bucket: row.bucket as string,
              bucket_source: row.bucket_source as string,
              budget_line_id: (row.budget_line_id as string | null) ?? null,
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
            targetNames,
            debtNames,
            savingsNames,
            rules,
            existingBucketSource: prior?.bucket_source,
            existingBucket: prior?.bucket as Bucket | undefined,
          })

          // A hand-set line is never recomputed, exactly like a manual bucket.
          // Otherwise a merchant rule decides, then the category map.
          const ruleLine = matchedRule(t.name, t.merchant_name, rules)?.budget_line_id ?? null
          const budgetLineId =
            prior?.bucket_source === 'manual'
              ? prior.budget_line_id
              : ruleLine ?? lineForCategory(detailed)

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
            budget_line_id: budgetLineId,
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

      // Advancing the cursor is irreversible: Plaid never re-emits a transaction
      // the cursor has passed, and the window requested at link time cannot be
      // widened afterwards. An item whose accounts have not been mapped yet would
      // otherwise have its entire history drained into `incoming`, filtered away
      // to nothing, and burnt — which is exactly what happens when a bank is
      // linked one day and its accounts mapped the next, with the nightly run in
      // between. Hold the cursor until there is somewhere to put the data.
      // Does THIS item have anything mapped? Asking whether any account anywhere
      // is mapped would always be true and defeat the guard. Ask the delta, which
      // names the accounts the item actually has.
      const seenOnItem = new Set([...delta.added, ...delta.modified].map((t) => t.account_id))
      const holdCursor = seenOnItem.size > 0 && ![...seenOnItem].some((id) => byPlaidId.has(id))

      if (holdCursor) {
        itemReport.cursor = 'held — nothing on this item is mapped yet, so its history is kept for a later run'
        await admin
          .from('plaid_items')
          .update({ status: 'ok', last_synced: new Date().toISOString() })
          .eq('item_id', itemId)
      } else {
        await admin
          .from('plaid_items')
          .update({ cursor: delta.cursor, status: 'ok', last_synced: new Date().toISOString() })
          .eq('item_id', itemId)
      }

      itemReport.transactions = { added: delta.added.length, modified: delta.modified.length, removed: delta.removed.length }
      itemReport.status = 'ok'
    } catch (err) {
      await handleItemError(item, itemReport, err)
    }
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
