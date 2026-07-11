/* The Bridge Adv Runs — service worker.
   Deliberately conservative so it can never "brick" the live PWA or fight the app's
   own auto-update (which reloads when BUILD_VER changes):
     • navigations + styles.css + manifest → NETWORK-FIRST (always fresh online; cached
       shell / offline card only when the network is down),
     • immutable icons → cache-first (instant, they never change),
     • everything else (avatars, chat media, /poll, APIs) → passthrough, never cached.
   Bump CACHE to invalidate old entries. */
const CACHE = 'bridge-static-v1';
const ICONS = ['/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/favicon.ico'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ICONS).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const OFFLINE_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#F8F5EF;color:#20211c;display:flex;min-height:100vh;
margin:0;align-items:center;justify-content:center;text-align:center;padding:24px}div{max-width:280px}
b{font-size:20px;display:block;margin-bottom:8px}p{color:#8a8474;line-height:1.5}</style></head>
<body><div><b>You're offline</b><p>The Bridge Runs needs a connection. Check your Wi-Fi or data and try again.</p></div></body></html>`;

function isIcon(p) { return ICONS.indexOf(p) >= 0; }
function freshFirst(p) { return p === '/styles.css' || p === '/manifest.webmanifest'; }

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== location.origin) return;

  // Navigations: network-first, fall back to the offline card.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() =>
      new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
    return;
  }
  // Immutable icons: cache-first (with a quiet background refresh).
  if (isIcon(url.pathname)) {
    e.respondWith(caches.match(req).then((cached) => {
      const net = fetch(req).then((r) => {
        if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
        return r;
      }).catch(() => cached);
      return cached || net;
    }));
    return;
  }
  // CSS + manifest: network-first so a deploy's new styles/manifest always win; cache
  // fallback only when offline.
  if (freshFirst(url.pathname)) {
    e.respondWith(fetch(req).then((r) => {
      if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
      return r;
    }).catch(() => caches.match(req)));
    return;
  }
  // Everything else (avatars, chat media, /poll, JSON) → straight to network, uncached.
});

// ---- Web Push ----
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: (e.data && e.data.text()) || '' }; }
  const title = d.title || 'The Bridge Runs';
  const opts = {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || undefined,          // same tag collapses/replaces rather than stacking
    renotify: !!d.tag,
    data: { url: d.url || '/checkin' },
  };
  e.waitUntil((async () => {
    await self.registration.showNotification(title, opts);
    // Set the home-screen app-icon badge to the recipient's total unread — carried in the
    // payload so the icon updates even while the app is closed (the in-app poll only runs
    // when it's open). Progressive: silently no-ops where setAppBadge is unsupported.
    if (typeof d.badge === 'number' && self.navigator && navigator.setAppBadge) {
      try { d.badge > 0 ? await navigator.setAppBadge(d.badge) : (navigator.clearAppBadge && await navigator.clearAppBadge()); } catch (_) {}
    }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/checkin';
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { await c.navigate(target); } catch (_) {} return c.focus(); }
    }
    return clients.openWindow(target);
  })());
});
