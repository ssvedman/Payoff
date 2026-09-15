# Payoff

A private household debt payoff and budget tracker for two people. One shared
plan, separate finances, one queue, debt avalanche.

Used by exactly two people. Nobody else will ever sign up.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vite + React 19 + TypeScript, hash routing |
| Hosting | GitHub Pages |
| Database | Supabase Postgres — RLS is the security model |
| Auth | Supabase Auth, magic link, PKCE |
| Server logic | Supabase Edge Functions (Deno) |
| Scheduling | pg_cron + pg_net |
| Bank data | Plaid, production |
| Notifications | Web Push (VAPID) + service worker |

No email notifications. No SMS. No analytics. No error reporting that ships
payloads off-box.

---

## Security model

The anon/publishable key is public and appears in the built bundle. It grants
nothing. Every table has RLS enabled and every policy is gated on
`is_household_member()`, which fails closed: a user who authenticates but is
absent from `household_members` sees zero rows everywhere.

- `plaid_items` has **no policy at all** — service role only.
- `audit_log` has select and insert policies but no update or delete, so history
  cannot be rewritten.
- Plaid access tokens live in **Supabase Vault**, never in a table. The only
  access path is `plaid_token_get/set/delete`, which are `SECURITY DEFINER` and
  granted to `service_role` alone.
- `account_balance_current` is a view declared `security_invoker = true`. Without
  that it would run as its owner and bypass RLS on `balance_snapshots`.

### Verifying RLS

RLS cannot be tested through a privileged SQL console — that connection bypasses
it. Test over HTTP with the publishable key and no session:

```bash
URL=https://<project>.supabase.co
KEY=<publishable key>

for t in accounts balance_snapshots transactions plaid_items audit_log; do
  echo -n "$t: "
  curl -s "$URL/rest/v1/$t?select=*" -H "apikey: $KEY"
done
```

Every one must return `[]`. An empty table would produce the same result, so
confirm the tables actually hold rows first — otherwise the check passes for the
wrong reason.

---

## Conventions that matter

**Plaid amounts are positive for money out.** Purchases are positive; payments,
deposits and refunds are negative. The sign is never flipped in storage.
`signedMoney()` negates for display only.

**Credit card balances are positive when owed.** `balances.current` on a credit
account is the amount owed; on a loan it is the principal remaining. Neither is
negated.

**Liabilities covers credit cards only.** `/liabilities/get` returns credit,
student and mortgage. Auto and personal loans return nothing, so those accounts
keep their seeded APR and minimum. The sync never writes a null over a seeded
value, nor a zero.

**Colour is semantic.** Amber means the current target and nothing else. Green
means cleared or on plan. Red means a deviation from plan.

**The app reports, it never advises.** "Store card balance rose $68 since
yesterday", not "you shouldn't use that card."

**Tabular numerals on every figure** — `className="tnum"`.

---

## Categorisation

Precedence, highest first:

1. Manual override on that transaction — never recomputed
2. Merchant rule — `match_text` found in lowercased name or merchant name
3. Account-based — a payment to a debt account is `attack`, a transfer to savings
   is `savings`, a deposit is `income`
4. Plaid category map
5. Fallback — `review`

Recategorising in `/activity` creates a `merchant_rules` row and re-applies it
across the current month.

The logic exists twice: `src/lib/categorise.ts` for the UI and
`supabase/functions/sync/categorise.ts` for the Edge Function, because Deno cannot
import from the Vite source tree. **Change both together.**

---

## Scheduling

pg_cron runs in UTC and has no timezone support. 04:00 ET is 08:00 UTC in summer
and 09:00 UTC in winter, so the job is scheduled at **both** and guarded on the
Eastern hour:

```sql
select private.invoke_edge_function('sync')
where extract(hour from (now() at time zone 'America/New_York')) = 4;
```

That fires exactly once a day year-round with no daylight-saving drift.

`check-alerts` is invoked by `sync` at the end of its run, not by a second cron
job: `pg_net` posts asynchronously and returns immediately, so two offset jobs
could not guarantee ordering.

**A nightly cron does not stop the free tier pausing.** Supabase counts API calls,
and once paused the cron stops permanently and cannot restart itself.
`.github/workflows/keepalive.yml` pings PostgREST weekly, which is what actually
keeps the project alive.

---

## Linking banks

There is no bank-linking UI. Accounts are a fixed set.

**The Plaid Trial plan allows exactly 10 items and removing one does not restore
the allowance.** Each institution is linked once, deliberately. Do not re-run the
link flow to test it. The institution list is in the local runbook, not here.

```bash
export SUPABASE_URL=https://<project>.supabase.co
node scripts/link.mjs status            # what is linked, items used
node scripts/link.mjs link "<institution>"  # consumes one item, permanently
node scripts/link.mjs accounts <item>   # list accounts on that item
node scripts/link.mjs map <uuid> <plaid_account_id>
```

Several large US banks are OAuth institutions. Plaid **Hosted Link** is used so
Plaid owns the OAuth round trip and no redirect URI needs registering — a
production `redirect_uri` must be HTTPS, contain no `#`, and be pre-registered,
and `http://localhost` is Sandbox-only.

---

## Local development

```bash
npm install
npm run dev        # http://localhost:5173/
npm run build
npx tsc -b --noEmit
```

`vite.config.ts` sets `base` to `/Payoff/` on build and `/` in dev, so the dev
server and the Pages deployment both work.

---

## Environment

**Frontend** (public by design, set as GitHub repository *variables*):

```
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_VAPID_PUBLIC_KEY
VITE_SITE_URL
```

**Edge Function secrets** (Supabase dashboard → Edge Functions → Secrets):

```
PLAID_CLIENT_ID
PLAID_SECRET
PLAID_ENV           production
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT       mailto:you@example.com
CRON_SECRET
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are **auto-injected** and cannot be
set manually — the `SUPABASE_` prefix is reserved.

`Build Docs/` and every `.env*` are gitignored. They hold real balances and
account details and must never reach a public repository.
