// lib/push.js — Web Push: the VAPID keypair (generated once, persisted in app_settings) and
// sendPush(), a fire-and-forget fan-out to every device a person subscribed.
import db from '../db.js';
import { PUSH_CONTACT_EMAIL } from '../config.js';
import webpush from 'web-push';
import { getSetting } from './settings.js';
import { metric } from './audit.js';

// ---- Web Push: load-or-generate the VAPID keypair (persisted in app_settings so it
// survives restarts + rides the db backup — never in .env) and a fire-and-forget send
// helper that prunes dead subscriptions on 404/410. ----
// Loaded by initPush() at boot rather than at import, so the keypair is read (or generated) after
// the demo world is seeded, at the same point in the boot sequence as before the split.
let VAPID_PUBLIC, VAPID_PRIVATE;
function sendPush(emails, { title, body, url, tag, badge }) {
  try {
  const list = [...new Set((emails || []).map(e => String(e || '').toLowerCase()))].filter(Boolean);
  if (!list.length) return;
  const ph = list.map(() => '?').join(',');
  const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE email IN (${ph})`).all(...list);
  if (subs.length) metric('push_send', { n: subs.length, meta: tag || '' });   // devices targeted, by tag — no identities
  const payload = JSON.stringify({ title, body, url, tag, badge });
  for (const s of subs) {
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
      .catch((err) => {
        if (err.statusCode === 404 || err.statusCode === 410)
          db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        else console.error(`[push] send failed (${err.statusCode || err.message})`);
      });
  }
  } catch (e) { console.error(`[push] sendPush failed: ${e.message}`); } // runs in setImmediate — must never throw uncaught
}

export function initPush() {
  VAPID_PUBLIC = getSetting('vapid_public'); VAPID_PRIVATE = getSetting('vapid_private');
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    const kp = webpush.generateVAPIDKeys();
    db.prepare('INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)').run('vapid_public', kp.publicKey);
    db.prepare('INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)').run('vapid_private', kp.privateKey);
    VAPID_PUBLIC = kp.publicKey; VAPID_PRIVATE = kp.privateKey;
    console.log('[push] generated + persisted VAPID keypair');
  }
  webpush.setVapidDetails('mailto:' + PUSH_CONTACT_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
}

export {
  sendPush, VAPID_PUBLIC,
};
