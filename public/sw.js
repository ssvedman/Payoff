/* Payoff service worker — push notifications only.
   No caching: the app must always reflect live balances, never a stale snapshot. */

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = { title: 'Payoff', body: event.data ? event.data.text() : '' }
  }

  const title = payload.title || 'Payoff'
  const options = {
    body: payload.body || '',
    // Notifications sharing a tag REPLACE one another. Three dormant cards whose
    // balances rose would collapse into a single visible alert, hiding two of the
    // three facts the notification exists to report. check-alerts sends a distinct
    // dedupe key per alert, so use that and fall back to something unique.
    tag: payload.dedupe || payload.tag || `payoff-${Date.now()}`,
    renotify: true,
    data: { url: payload.url || './#/' },
    timestamp: Date.now(),
  }

  // Only reference an icon that actually exists in the build; a 404 here renders
  // the generic browser glyph and no status-bar badge.
  if (payload.icon) {
    options.icon = payload.icon
    options.badge = payload.icon
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || './#/', self.location.href).href

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          client.navigate(target)
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})

/*
 * Chrome can rotate a push subscription. A service worker cannot write to Supabase
 * (it holds no session), and re-subscribing here has no applicationServerKey to
 * offer, so there is nothing useful to do at this point. The recovery that works:
 * check-alerts deletes any endpoint that returns 404/410, and the app re-upserts
 * the current subscription every time /settings mounts.
 *
 * Deliberately not handling pushsubscriptionchange — a handler that silently
 * swallowed its own failure looked like recovery while doing nothing.
 */
