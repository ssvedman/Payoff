/**
 * `plaid-webhook` — Plaid tells us an item has new transactions; we pull them.
 *
 * Plaid checks most banks for new transactions one to four times a day. Polling
 * on our own schedule either misses those or wastes calls, so instead Plaid sends
 * SYNC_UPDATES_AVAILABLE when it has something and this starts a LIGHT sync of
 * that one item (see sync's `mode`): the transaction delta only, which the
 * Transactions subscription covers. No balance call is made here.
 *
 * Deployed with verify_jwt OFF: Plaid sends no Supabase JWT. Every request is
 * instead verified as Plaid's own (the Plaid-Verification JWT, below) before
 * anything runs, and even a forged one could only start a light sync of an item
 * we already hold.
 *
 * Items are pointed here by sync (existing items, once each) and by plaid-link
 * (new ones, at link time). Update-mode Link cannot change an item's webhook.
 */

import { createClient } from 'npm:@supabase/supabase-js@2'
import { PlaidError, webhookVerificationKeyGet } from '../sync/plaid.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** Plaid's own guidance: refuse a webhook signed more than five minutes ago. */
const MAX_AGE_SECONDS = 5 * 60

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }

const b64urlBytes = (s: string) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}
const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)))

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Equal-time compare, so the body hash cannot be guessed a byte at a time. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Keys by kid. Plaid rotates rarely; one fetch per key per warm instance. */
const keys = new Map<string, CryptoKey>()

/**
 * Kids Plaid refused. The endpoint is public, and without this anyone could make
 * it call Plaid once per request just by inventing a new kid each time.
 */
const refused = new Set<string>()

/** Plaid's kids are UUIDs. Anything else is not worth asking Plaid about. */
const KID_SHAPE = /^[0-9a-f-]{8,64}$/i

/**
 * Is this request really from Plaid, recent, and unaltered?
 *
 * The Plaid-Verification header is an ES256 JWT whose payload carries the
 * SHA-256 of the body. Verify the signature against Plaid's published key for
 * its kid, then the age, then the body hash.
 */
async function verified(req: Request, rawBody: string): Promise<boolean> {
  const jwt = req.headers.get('plaid-verification')
  if (!jwt) return false
  const parts = jwt.split('.')
  if (parts.length !== 3) return false
  const [h, p, sig] = parts

  let header: { alg?: string; kid?: string }
  let payload: { iat?: number; request_body_sha256?: string }
  try {
    header = b64urlJson(h)
    payload = b64urlJson(p)
  } catch {
    return false
  }
  // Only ES256. Accepting whatever alg the token names is the classic JWT hole.
  if (header.alg !== 'ES256' || !header.kid) return false
  if (!KID_SHAPE.test(header.kid) || refused.has(header.kid)) return false

  let key = keys.get(header.kid)
  if (!key) {
    try {
      const { key: jwk } = await webhookVerificationKeyGet(header.kid)
      key = await crypto.subtle.importKey(
        'jwk',
        { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      )
      keys.set(header.kid, key)
    } catch (err) {
      // Only Plaid's INVALID_* answer counts as a refusal. A timeout or outage says
      // nothing about the kid, and remembering it would reject Plaid's real
      // webhooks until this instance is recycled.
      if (err instanceof PlaidError && err.type.startsWith('INVALID') && refused.size < 1000) {
        refused.add(header.kid)
      }
      return false
    }
  }

  // A JWS ES256 signature is the raw 64-byte r||s, which is what WebCrypto takes.
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    b64urlBytes(sig),
    new TextEncoder().encode(`${h}.${p}`),
  )
  if (!ok) return false

  if (typeof payload.iat !== 'number' || Date.now() / 1000 - payload.iat > MAX_AGE_SECONDS) return false

  const bodyHash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody)))
  return sameString(bodyHash, String(payload.request_body_sha256 ?? ''))
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const rawBody = await req.text()
  if (!(await verified(req, rawBody))) {
    return new Response(JSON.stringify({ error: 'unverified' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let event: { webhook_type?: string; webhook_code?: string; item_id?: string }
  try {
    event = JSON.parse(rawBody)
  } catch {
    return new Response(JSON.stringify({ error: 'bad body' }), { status: 400 })
  }

  const itemId = event.item_id ?? ''
  const wanted = event.webhook_type === 'TRANSACTIONS' && event.webhook_code === 'SYNC_UPDATES_AVAILABLE'

  if (wanted && itemId) {
    const { data: item } = await admin.from('plaid_items').select('item_id').eq('item_id', itemId).maybeSingle()
    if (item) {
      // Answer Plaid now and sync after: a run takes far longer than Plaid waits
      // for a 200, and a timed-out webhook is retried, which would sync twice.
      EdgeRuntime.waitUntil(
        fetch(`${SUPABASE_URL}/functions/v1/sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-cron-secret': CRON_SECRET,
            Authorization: `Bearer ${SERVICE_KEY}`,
          },
          body: JSON.stringify({ mode: 'light', item_id: itemId, triggeredBy: 'webhook' }),
        }).catch((err) => console.error(`sync dispatch failed for ${itemId}: ${(err as Error).message}`)),
      )
    }
  }

  // Everything else (ITEM errors, acknowledgements, the historical-pull notices)
  // is acknowledged and left to the nightly run, which already handles a broken
  // item and notifies once.
  console.log(`${event.webhook_type}/${event.webhook_code} for ${itemId || 'no item'}${wanted ? ' → light sync' : ''}`)
  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
