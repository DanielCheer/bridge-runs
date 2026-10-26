// routes/push.js — Web Push subscriptions: the public VAPID key, subscribe and unsubscribe.
import express from 'express';
import db from '../db.js';
import { requireLogin } from '../auth.js';
import { rateLimited } from '../lib/rate-limit.js';
import { VAPID_PUBLIC } from '../lib/push.js';

export function mountPush(app) {
  // ---- Web Push subscription endpoints. Subscription objects are nested JSON, so parse
  // JSON per-route (the app otherwise only mounts urlencoded). The subscription row IS the
  // opt-in state — subscribing = on, unsubscribing = off — so there's no separate flag. ----
  app.get('/push/key', requireLogin, (req, res) => res.json({ key: VAPID_PUBLIC }));
  app.post('/push/subscribe', requireLogin, express.json(), (req, res) => {
    if (rateLimited('push-sub', req.userEmail, 15, 60 * 1000)) return res.status(429).end();
    const s = req.body || {};
    const endpoint = String(s.endpoint || '');
    const p256dh = s.keys && String(s.keys.p256dh || '');
    const auth = s.keys && String(s.keys.auth || '');
    if (!endpoint.startsWith('https://') || !p256dh || !auth) return res.status(400).end();
    db.prepare(`INSERT INTO push_subscriptions (email, endpoint, p256dh, auth) VALUES (?,?,?,?)
              ON CONFLICT(endpoint) DO UPDATE SET email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(req.userEmail.toLowerCase(), endpoint, p256dh, auth);
    res.status(204).end();
  });
  app.post('/push/unsubscribe', requireLogin, express.json(), (req, res) => {
    const endpoint = String((req.body && req.body.endpoint) || '');
    if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND email = ?')
      .run(endpoint, req.userEmail.toLowerCase());
    res.status(204).end();
  });
}
