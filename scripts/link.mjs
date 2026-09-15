#!/usr/bin/env node
/**
 * One-time Plaid linking script. BUILD.md §5.
 *
 * Accounts are a fixed set, so linking is a deliberate terminal operation run
 * once per institution and then never again.
 *
 *   THE TRIAL PLAN ALLOWS EXACTLY 10 ITEMS AND REMOVING ONE DOES NOT RESTORE THE
 *   ALLOWANCE. The institutions to link are listed in the local runbook, one link
 *   each. Do not run `link` repeatedly to "test" — every completed link consumes
 *   an item permanently.
 *
 * Usage:
 *   export SUPABASE_URL=https://snyxssbzuxybzntkqocs.supabase.co
 *   export SUPABASE_SERVICE_ROLE_KEY=...        # paste at the prompt, never store
 *
 *   node scripts/link.mjs status                # what is linked, items used
 *   node scripts/link.mjs link "<bank>"         # opens Hosted Link, waits, stores
 *   node scripts/link.mjs accounts <item_id>    # list accounts on an item
 *   node scripts/link.mjs map <account_uuid> <plaid_account_id>
 *   node scripts/link.mjs checking "<name>" <plaid_account_id> [--business]
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout, env, argv, exit } from 'node:process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The project URL is not a secret and already lives in .env — don't make the
 *  operator export it by hand just to run a one-time script. */
function urlFromEnvFile() {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    for (const f of ['.env', '.env.example']) {
      const text = readFileSync(join(root, f), 'utf8')
      const m = text.match(/^VITE_SUPABASE_URL=(.+)$/m)
      if (m && m[1].trim()) return m[1].trim()
    }
  } catch {
    /* fall through */
  }
  return null
}

const SUPABASE_URL = env.SUPABASE_URL || urlFromEnvFile()
let SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL) {
  console.error('\n  SUPABASE_URL is not set and could not be read from .env.')
  console.error('  Set it explicitly:\n')
  console.error('    export SUPABASE_URL=https://<project-ref>.supabase.co\n')
  exit(1)
}

const rl = createInterface({ input: stdin, output: stdout })

async function call(action, body = {}) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/plaid-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({ action, ...body }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401) {
      console.error(`
  ${action} failed: unauthorized.

  The key you pasted is not a service role key. In Supabase go to
  Project Settings -> API Keys and copy EITHER:

    - a Secret key   (starts "sb_secret_",  click Reveal), or
    - the legacy service_role key (a long JWT starting "eyJ")

  NOT the publishable key ("sb_publishable_") and NOT the anon key —
  those grant nothing here, which is exactly why this failed.
`)
    } else {
      console.error(`\n  ${action} failed: ${data.error ?? res.status}\n`)
    }
    exit(1)
  }
  return data
}

function table(rows, cols) {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)))
  const line = (cells) => '  ' + cells.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ')
  console.log(line(cols))
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '))
  for (const r of rows) console.log(line(cols.map((c) => r[c])))
}

async function cmdStatus() {
  const s = await call('status')
  console.log(`\n  Plaid environment : ${s.env}`)
  console.log(`  Items used        : ${s.itemsUsed} of ${s.itemCap}`)

  if (s.items.length) {
    console.log('\n  LINKED ITEMS')
    table(s.items, ['institution', 'item_id', 'status', 'cursor', 'last_synced'])
  } else {
    console.log('\n  No institutions linked yet.')
  }

  console.log('\n  ACCOUNTS')
  table(
    s.accounts.map((a) => ({
      name: a.name,
      kind: a.kind,
      source: a.is_manual ? 'typed in' : a.plaid_account_id ? 'synced' : 'UNMAPPED',
      plaid_account_id: a.plaid_account_id ?? '',
      id: a.id,
    })),
    ['name', 'kind', 'source', 'plaid_account_id', 'id'],
  )
  console.log()
}

async function cmdLink(institution) {
  if (!institution) {
    console.error('  Name the institution, e.g. node scripts/link.mjs link "<bank>"')
    exit(1)
  }

  const s = await call('status')
  console.log(`\n  ${s.itemsUsed} of ${s.itemCap} Plaid items are already used.`)
  console.log(`  Linking "${institution}" will consume one more, permanently.`)
  console.log('  Removing an item later does NOT restore the allowance.\n')

  const ok = await rl.question(`  Type the institution name again to confirm: `)
  if (ok.trim() !== institution.trim()) {
    console.log('\n  Did not match. No item was consumed.\n')
    exit(0)
  }

  const created = await call('create', { hosted: true })

  if (!created.hosted_link_url) {
    console.log('\n  Hosted Link is not available on this Plaid plan.')
    console.log('  A link_token was issued but it needs a Plaid Link frontend:\n')
    console.log(`     ${created.link_token}\n`)
    console.log('  No item was consumed — an item is only created once a bank login')
    console.log('  completes. Stop here and reconsider rather than burning one.\n')
    exit(1)
  }

  console.log('\n  Open this URL and complete the bank login:\n')
  console.log(`     ${created.hosted_link_url}\n`)
  console.log('  Plaid hosts this page and handles the OAuth round trip, so no')
  console.log('  redirect URI needs registering, even for OAuth banks.\n')
  console.log('  IMPORTANT: the Plaid item is created the moment the bank login')
  console.log('  completes — before anything is stored here. Do not close this')
  console.log('  script until it reports success, or the item is spent with no')
  console.log('  access token saved, and the Trial plan will not give it back.\n')

  // Poll Plaid for the completed session rather than asking for a paste. The
  // session is recorded against the link_token, so a dropped clipboard no longer
  // strands a consumed item.
  const deadline = Date.now() + 15 * 60 * 1000
  let publicToken = null

  process.stdout.write('  Waiting for the bank login to complete')
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000))
    process.stdout.write('.')
    let poll
    try {
      poll = await call('poll', { link_token: created.link_token })
    } catch {
      continue
    }
    if (poll.complete && poll.public_token) {
      publicToken = poll.public_token
      console.log('\n\n  Bank login completed.')
      break
    }
  }

  if (!publicToken) {
    console.log('\n\n  Timed out waiting for the session.')
    console.log('  If you DID finish the bank login, an item has been consumed and the')
    console.log('  access token was not stored. Recover it before linking anything else:\n')
    console.log(`     node scripts/link.mjs resume ${created.link_token} "${institution}"\n`)
    exit(1)
  }

  const res = await call('exchange', {
    public_token: publicToken,
    institution: institution.trim(),
  })

  console.log(`\n  Linked. item_id ${res.item_id}`)
  console.log('  Access token written to Supabase Vault. It is not in any table.\n')
  console.log(`  Next: node scripts/link.mjs accounts ${res.item_id}\n`)
}

/**
 * Recover a Hosted Link session whose item was created but never stored — the
 * failure mode that otherwise silently costs one of the ten items.
 */
async function cmdResume(linkToken, institution) {
  if (!linkToken) {
    console.error('  Usage: resume <link_token> "<institution>"')
    exit(1)
  }
  const poll = await call('poll', { link_token: linkToken })
  if (!poll.complete || !poll.public_token) {
    console.log('\n  That session has no completed item. Nothing to recover.\n')
    exit(0)
  }
  const res = await call('exchange', {
    public_token: poll.public_token,
    institution: (institution || poll.institution || 'unknown').trim(),
  })
  console.log(`\n  Recovered. item_id ${res.item_id}, token stored in Vault.\n`)
}


/**
 * Pre-flight. Creates a link TOKEN, which is free — a Plaid item is only created
 * when a bank login actually completes. So this proves PLAID_CLIENT_ID and
 * PLAID_SECRET are valid production credentials, and whether Hosted Link is
 * available on the plan, without consuming any of the ten items.
 */
async function cmdCheck() {
  const s = await call('status')
  console.log(`\n  Plaid environment : ${s.env}`)
  console.log(`  Items used        : ${s.itemsUsed} of ${s.itemCap}`)
  console.log('\n  Asking Plaid for a link token (consumes nothing)...')

  const created = await call('create', { hosted: true })

  console.log('\n  Plaid accepted the credentials — PLAID_CLIENT_ID and PLAID_SECRET are valid.')
  console.log(`  Hosted Link available : ${created.hostedSupported ? 'yes' : 'NO'}`)
  console.log(`  Token expires         : ${created.expiration ?? 'unknown'}`)

  if (!created.hostedSupported) {
    console.log('\n  Hosted Link is NOT available on this plan. Stop and reconsider')
    console.log('  before running `link`, which would need a Plaid Link frontend.\n')
    exit(1)
  }

  const after = await call('status')
  console.log(`\n  Items used after the check: ${after.itemsUsed} of ${after.itemCap}  (unchanged)`)
  console.log('\n  Safe to proceed:  node scripts/link.mjs link "<institution>"\n')
}


/**
 * Re-open account selection on an item that is already linked, to add accounts
 * that were not ticked the first time. This does NOT consume one of the ten
 * items — the existing item is modified in place.
 */
async function cmdUpdate(itemId) {
  if (!itemId) {
    console.error('  Usage: update <item_id>')
    exit(1)
  }

  const before = await call('status')
  console.log(`\n  Items used: ${before.itemsUsed} of ${before.itemCap}`)
  console.log('  Update mode modifies the existing item — it consumes nothing.\n')

  const res = await call('update', { item_id: itemId })
  if (!res.hosted_link_url) {
    console.error('  Plaid did not return a hosted link URL for update mode.\n')
    exit(1)
  }

  console.log('  Open this URL and tick the accounts that are missing:\n')
  console.log(`     ${res.hosted_link_url}\n`)
  console.log('  When you are done, re-run:')
  console.log(`     node scripts/link.mjs accounts ${itemId}\n`)
  console.log('  No exchange step is needed — the existing access token keeps working.\n')
}

async function cmdAccounts(itemId) {
  if (!itemId) {
    console.error('  Give an item_id.')
    exit(1)
  }
  const res = await call('accounts', { item_id: itemId })
  console.log(`\n  ACCOUNTS ON ${itemId}\n`)
  table(res.accounts, ['name', 'mask', 'type', 'subtype', 'current', 'account_id'])
  console.log('\n  Map each one onto a seeded row:')
  console.log('     node scripts/link.mjs map <account_uuid> <plaid_account_id>')
  console.log('  Or create a checking row for a spending account:')
  console.log('     node scripts/link.mjs checking "Business checking" <plaid_account_id> --business\n')
}

async function cmdMap(accountId, plaidAccountId) {
  if (!accountId || !plaidAccountId) {
    console.error('  Usage: map <account_uuid> <plaid_account_id>')
    exit(1)
  }
  const res = await call('map', { account_id: accountId, plaid_account_id: plaidAccountId })
  console.log(`\n  Mapped ${res.mapped} -> ${res.to}\n`)
}

async function cmdChecking(name, plaidAccountId, flag) {
  if (!name || !plaidAccountId) {
    console.error('  Usage: checking "<name>" <plaid_account_id> [--business]')
    exit(1)
  }
  const res = await call('create_checking', {
    name,
    plaid_account_id: plaidAccountId,
    is_business: flag === '--business',
  })
  console.log(`\n  Created checking account:`, res.created?.name ?? name, '\n')
}

const [, , cmd, ...args] = argv

if (!SERVICE_KEY) {
  // Without a TTY, readline never resolves and node reports an unsettled
  // top-level await, which says nothing useful. Fail with instructions instead.
  if (!stdin.isTTY) {
    console.error(`
  This script needs an interactive terminal to ask for the service role key,
  and stdin here is not a TTY.

  Open Terminal.app and run it there:

      cd ${process.cwd()}
      node scripts/link.mjs ${argv.slice(2).join(' ') || 'status'}

  It will prompt for the key, which is never written to disk. Avoid putting the
  key on a command line or in an export — that records it in your shell history.
`)
    rl.close()
    exit(1)
  }
  SERVICE_KEY = (await rl.question('  Supabase service role key (not stored anywhere): ')).trim()
}

try {
  switch (cmd) {
    case 'status':
      await cmdStatus()
      break
    case 'check':
      await cmdCheck()
      break
    case 'link':
      await cmdLink(args[0])
      break
    case 'resume':
      await cmdResume(args[0], args[1])
      break
    case 'update':
      await cmdUpdate(args[0])
      break
    case 'accounts':
      await cmdAccounts(args[0])
      break
    case 'map':
      await cmdMap(args[0], args[1])
      break
    case 'checking':
      await cmdChecking(args[0], args[1], args[2])
      break
    default:
      console.log(`
  Payoff — one-time Plaid linking

    status                                  what is linked, and items used
    check                                   verify Plaid credentials, consumes nothing
    link "<institution>"                    link one institution (consumes an item)
    resume <link_token> "<inst>"            recover a completed session that was not stored
    accounts <item_id>                      list accounts on a linked item
    update <item_id>                        add missing accounts, consumes nothing
    map <account_uuid> <plaid_account_id>   attach a Plaid account to a seeded row
    checking "<name>" <id> [--business]     create a checking row for a spending account

  Institutions to link are in the local runbook. One link each, deliberately.
`)
  }
} finally {
  rl.close()
}
