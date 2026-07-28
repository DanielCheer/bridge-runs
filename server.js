// server.js — The Bridge Adv Runs
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

import db, { rekeyEmailTx, transact } from './db.js';
import { startBackups } from './backup.js';
import { sendMagicLink, sendAnnouncement, sendSpotOffer, emailConfigured } from './mailer.js';
import webpush from 'web-push';
import {
  setSession, clearSession, currentUser, isAdmin,
  requireLogin, requireAdmin, makeRequireApprover, ADMINS,
} from './auth.js';
import {
  intakePage, loginPage, checkinPage, adminPage, statusPage, peoplePage, invitePage, sharePage, logoutPage, APP_JS,
  chatPage, chatOlderFragment, profilePage, profileTabPage, threadPage, claimResultPage, BUILD_VER, setAvatarMap, setProgramMeta,
  STICKERS, avatarUrlFor, mdToHtml, legalPage, bannerPage, confirmActionPage, seasonPage, profileCard, pickleballPage, runsPage, pkChatPage, pkJoinPage, waiverPage,
} from './views.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
// Run capacities. `let` (not const) because a host can edit them in-app (stored in
// app_settings, applied by reloadRunSettings() at startup + on save). The env values are
// the DEFAULTS/fallback. Every consumer reads these at request time, so a live edit takes
// effect on the next check-in with no restart. TOTAL_CAP is derived — recomputed on reload.
const CAP_ENV = Number(process.env.RUN_CAP || 15);
const WAITLIST_CAP_ENV = Number(process.env.WAITLIST_CAP || 5);
const PREREG_CAP_ENV = Number(process.env.PREREG_CAP || process.env.REGULAR_CAP || 10);
let CAP = CAP_ENV;
let WAITLIST_CAP = WAITLIST_CAP_ENV;
let TOTAL_CAP = CAP + WAITLIST_CAP;
const VOTE_THRESHOLD = Number(process.env.VOTE_THRESHOLD || 3); // approvals to get in / rejects to block
let PREREG_CAP = PREREG_CAP_ENV; // max team+regular pre-joining while closed; reserves the rest for normals
// Waitlist offer-and-confirm window. SINGLE source of truth, env-overridable so the
// owner can lower it (e.g. to 1h) without a code change — ms is derived from it.
const OFFER_WINDOW_HOURS = Number(process.env.OFFER_WINDOW_HOURS || 3);
const OFFER_WINDOW_MS = OFFER_WINDOW_HOURS * 60 * 60 * 1000;
const requireApprover = makeRequireApprover(db);

// Prepared once at module scope — node:sqlite has no statement cache, so re-preparing
// this INSERT on every audited action (every check-in, vote, edit…) is pure waste.
const stmtAudit = db.prepare('INSERT INTO audit_log (actor,actor_role,action,target) VALUES (?,?,?,?)');
const stmtAnnouncementExists = db.prepare('SELECT 1 FROM announcements WHERE id = ? AND program_id = 1');
function audit(actor, actorRole, action, target) {
  stmtAudit.run(actor, actorRole, action, target || '');
}

// ---- email validation ----
// The ONLY gate between a typed address and nodemailer's `to:`/`bcc:`. An `includes('@')`
// check is not enough: nodemailer parses `to:` as an RFC-5322 ADDRESS LIST, so a string like
// "a@b.com, victim@x.org, …" is a hundred recipients in one field — a relay that also sails
// past the per-address rate limit (which keys on the whole string, so every list is a fresh
// bucket). Quoted/grouped/commented forms are refused for the same reason: what we validate
// must be what the mailer sends. Local part therefore excludes the list/group/comment/quote
// metacharacters entirely, and the domain must be dotted labels (so `@guest.local`
// placeholders still pass). Lengths are the RFC-5321 maximums.
const EMAIL_RE = /^[^\s@,;:<>"'\\()[\]]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const isValidEmail = (e) => typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e);

// ---- in-memory rate limiter ----
// Guards the two unauthenticated POSTs (/login, /apply). /login fires a real
// Gmail send for any email typed in, so without this a loop could email-bomb an
// address and burn our ~500/day Gmail quota (locking out real sign-ins). Sliding
// window per key; buckets are plain Maps, fine for a single-process app at this
// scale. Pruned lazily on each hit so they don't grow unbounded.
const rlBuckets = new Map();
function rateLimited(bucket, key, limit, windowMs, now = Date.now()) {
  let m = rlBuckets.get(bucket);
  if (!m) { m = new Map(); rlBuckets.set(bucket, m); }
  const cutoff = now - windowMs;
  const hits = (m.get(key) || []).filter(t => t > cutoff);
  if (hits.length >= limit) { m.set(key, hits); return true; }
  hits.push(now);
  m.set(key, hits);
  return false;
}
// The lazy per-hit prune above only trims each key's timestamp array — it never
// removes the KEY itself, so a distinct email/IP that hits once leaves a permanent
// entry and rlBuckets grows unbounded over the process lifetime. Sweep every 15 min:
// drop keys whose newest hit is older than a generous window, then empty buckets.
setInterval(() => {
  const stale = Date.now() - 60 * 60 * 1000; // 1h ≥ every configured window
  for (const [bucket, m] of rlBuckets) {
    for (const [key, hits] of m) {
      if (!hits.length || hits[hits.length - 1] < stale) m.delete(key);
    }
    if (m.size === 0) rlBuckets.delete(bucket);
  }
}, 15 * 60 * 1000).unref(); // unref so the sweep never keeps the process alive
function clientIp(req) {
  // Behind ONE trusted proxy (Tailscale Funnel), the real client IP is the LAST hop the
  // proxy appended to X-Forwarded-For — NOT the first. Taking the first trusts a value the
  // client can inject (`X-Forwarded-For: 1.2.3.4`), letting an attacker rotate fake IPs past
  // the per-IP rate limits (the exact email-bomb / Gmail-quota-burn the limiter guards). The
  // last entry is the one Funnel set, so it can't be spoofed. Fall back to the socket peer.
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return (xff.length ? xff[xff.length - 1] : '') || req.socket.remoteAddress || 'unknown';
}

// Hot path (rendered on every check-in + polled in the check-in fingerprint), so
// the statement is prepared once at module scope rather than per call.
const stmtLatestAnnouncement = db.prepare(`SELECT a.*, COALESCE(ap.full_name, a.author) AS authorName
  FROM announcements a LEFT JOIN applicants ap ON ap.email = a.author
  WHERE a.archived = 0 AND a.program_id = 1 ORDER BY a.id DESC LIMIT 1`); // authorName resolves the poster's email → name
function latestAnnouncement() {
  // the live one players see — archived posts are history only
  return stmtLatestAnnouncement.get() || null;
}
function announcementHistory(limit = 40) {
  // newest first; includes the live one plus everything archived
  return db.prepare('SELECT * FROM announcements WHERE program_id = 1 ORDER BY id DESC LIMIT ?').all(limit);
}
// Broadcast audiences. approvedEmails() = every real approved player (used for PUSH,
// which is opt-in per device via a subscription row). announcementRecipients() is the
// same minus anyone who opted OUT of broadcast EMAIL — so an email opt-out can never
// mute push, by construction. Transactional mail (sign-in, invites, spot offers) uses
// neither and always sends.
function approvedEmails() {
  return db.prepare("SELECT email FROM applicants WHERE status = 'approved' AND email NOT LIKE '%@guest.local'")
    .all().map(r => r.email);
}
function announcementRecipients() {
  return db.prepare("SELECT email FROM applicants WHERE status = 'approved' AND email NOT LIKE '%@guest.local' AND COALESCE(email_optout,0) = 0")
    .all().map(r => r.email);
}
// Plain approved players with NO early access — the ones the "check-in is open" auto-
// notice is for. Core (is_regular), Team, and Host already have early access, so they're
// EXCLUDED from the queue-open ping. Push variant ignores email opt-out; email variant honors it.
function queueOpenPushEmails() {
  return db.prepare("SELECT email FROM applicants WHERE status = 'approved' AND email NOT LIKE '%@guest.local' AND is_regular = 0 AND is_team = 0 AND is_host = 0")
    .all().map(r => r.email);
}
function queueOpenEmailRecipients() {
  return db.prepare("SELECT email FROM applicants WHERE status = 'approved' AND email NOT LIKE '%@guest.local' AND is_regular = 0 AND is_team = 0 AND is_host = 0 AND COALESCE(email_optout,0) = 0")
    .all().map(r => r.email);
}

// ---- Web Push: load-or-generate the VAPID keypair (persisted in app_settings so it
// survives restarts + rides the db backup — never in .env) and a fire-and-forget send
// helper that prunes dead subscriptions on 404/410. ----
// Hoisted — settings sit on the hottest path (seasonStart/pkSeasonStart inside nextRunDate,
// chat_seq every /poll tick, bumpChatSeq on every send). node:sqlite has no stmt cache, so
// re-preparing per call recompiles the SQL each time; prepare once, reuse.
const stmtGetSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const stmtSetSetting = db.prepare('INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)');
const stmtDelSetting = db.prepare('DELETE FROM app_settings WHERE key = ?');
const getSetting = (k) => stmtGetSetting.get(k)?.value;
const setSetting = (k, v) => stmtSetSetting.run(k, String(v));
const delSetting = (k) => stmtDelSetting.run(k);
// Apply any host-saved capacity overrides (app_settings) over the env defaults. Called
// once at startup and again whenever the host saves settings, so live edits need no
// restart. A missing / non-positive stored value falls back to the env default.
function reloadRunSettings() {
  const g = (k, def) => { const v = getSetting(k); const n = Number(v); return (v != null && Number.isFinite(n) && n > 0) ? Math.floor(n) : def; };
  CAP = g('run_cap', CAP_ENV);
  WAITLIST_CAP = g('waitlist_cap', WAITLIST_CAP_ENV);
  PREREG_CAP = Math.min(g('prereg_cap', PREREG_CAP_ENV), CAP); // pre-reg can't exceed the floor
  TOTAL_CAP = CAP + WAITLIST_CAP;
}
reloadRunSettings();
let VAPID_PUBLIC = getSetting('vapid_public'), VAPID_PRIVATE = getSetting('vapid_private');
if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  const kp = webpush.generateVAPIDKeys();
  db.prepare('INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)').run('vapid_public', kp.publicKey);
  db.prepare('INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)').run('vapid_private', kp.privateKey);
  VAPID_PUBLIC = kp.publicKey; VAPID_PRIVATE = kp.privateKey;
  console.log('[push] generated + persisted VAPID keypair');
}
webpush.setVapidDetails('mailto:' + (process.env.SMTP_FROM || process.env.SMTP_USER || 'admin@localhost'), VAPID_PUBLIC, VAPID_PRIVATE);
function sendPush(emails, { title, body, url, tag, badge }) {
  try {
  const list = [...new Set((emails || []).map(e => String(e || '').toLowerCase()))].filter(Boolean);
  if (!list.length) return;
  const ph = list.map(() => '?').join(',');
  const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE email IN (${ph})`).all(...list);
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

// ---- Masthead notification bell: announcements panel + unread tracking ----
// The bell lists recent announcements (live + archived history) newest-first and
// shows an orange dot when the viewer has an unseen one. Unread is tracked per
// viewer in announcement_reads (last_seen_id high-water mark). All render text is
// esc()'d in views; author email is mapped to the poster's full_name for display.
// The viewer's panel list: recent announcements newest-first, EXCLUDING any this viewer
// has personally dismissed (swipe-to-clear). The dismiss is per-user — the row stays in
// `announcements` and in everyone else's panel; only this viewer's copy is hidden.
const stmtAnnPanel = db.prepare(`
    SELECT a.id, a.body, a.author, a.at,
           COALESCE(ap.full_name, a.author) AS authorName
    FROM announcements a
    LEFT JOIN applicants ap ON ap.email = a.author
    WHERE a.program_id = 1 AND a.id NOT IN (SELECT announcement_id FROM announcement_dismissals WHERE email = ?)
    ORDER BY a.id DESC LIMIT ?`); // hoisted — runs on every authed page render (node:sqlite has no stmt cache)
function announcementsForPanel(email, limit = 20) {
  return stmtAnnPanel.all(String(email || '').toLowerCase(), limit);
}
const stmtAnnLastSeen = db.prepare('SELECT last_seen_id FROM announcement_reads WHERE email = ?');
// Count of announcements newer than the viewer's last-seen id that they have NOT
// dismissed — dismissed ids never light the dot, so clearing the last unread one clears
// the bell. (A viewer who never opened the panel has last_seen_id 0 → any non-dismissed
// announcement counts.)
const stmtAnnUnreadCount = db.prepare(`
  SELECT COUNT(*) n FROM announcements a
  WHERE a.program_id = 1 AND a.id > ?
    AND a.id NOT IN (SELECT announcement_id FROM announcement_dismissals WHERE email = ?)`);
function announcementUnread(email) {
  if (!email) return false;
  const em = email.toLowerCase();
  const row = stmtAnnLastSeen.get(em);
  const lastSeen = row ? (row.last_seen_id || 0) : 0;
  return stmtAnnUnreadCount.get(lastSeen, em).n > 0;
}
// Upsert the viewer's last-seen id to the current MAX — clears their unread dot.
const stmtMarkAnnSeen = db.prepare(`
  INSERT INTO announcement_reads (email, last_seen_id, updated_at)
  VALUES (?, (SELECT COALESCE(MAX(id),0) FROM announcements WHERE program_id = 1), datetime('now'))
  ON CONFLICT(email) DO UPDATE SET
    last_seen_id = (SELECT COALESCE(MAX(id),0) FROM announcements WHERE program_id = 1),
    updated_at = datetime('now')`);
function markAnnouncementsSeen(email) {
  if (email) stmtMarkAnnSeen.run(email.toLowerCase());
}
// The masthead bell's render state for a viewer: their (non-dismissed) list + unread
// flag. Every viewer can swipe-to-clear their own rows, so no role gating here.
function annPanel(email) {
  return { items: announcementsForPanel(email, 20), unread: announcementUnread(email) };
}

// The people who vote: TEAM MEMBERS ONLY. Admins run the app but do not vote —
// approval decisions belong to the team (unanimous).
function approverEmails() {
  return new Set(
    db.prepare('SELECT email FROM applicants WHERE is_team = 1 AND is_host = 0').all()
      .map(r => r.email.toLowerCase()));
}

// Symmetric threshold: VOTE_THRESHOLD approvals → approved,
// VOTE_THRESHOLD rejects → rejected, otherwise pending.
// Team members are auto-approved and never voted on.
function recomputeStatus(id) {
  const app = db.prepare('SELECT id,email,is_team,status FROM applicants WHERE id = ?').get(id);
  if (!app || app.is_team) return app?.status;
  const pool = approverEmails();
  const votes = db.prepare('SELECT voter_email,vote FROM votes WHERE applicant_id = ?').all(id)
    .filter(v => pool.has(v.voter_email.toLowerCase()));   // ignore votes from ex-approvers
  const approves = votes.filter(v => v.vote === 'approve').length;
  const rejects = votes.filter(v => v.vote === 'reject').length;
  let status = 'pending';
  if (rejects >= VOTE_THRESHOLD) status = 'rejected';
  else if (approves >= VOTE_THRESHOLD) status = 'approved';
  if (status !== app.status) {
    db.prepare('UPDATE applicants SET status = ? WHERE id = ?').run(status, id);
    if (status === 'rejected') {
      // Dropping a rejected player off the floor frees a slot — offer it onward (capture
      // the offeree BEFORE the delete) instead of silently auto-promoting the waitlist.
      const runDate = nextRunDate();
      const offeree = offereeForFloorLeave(runDate, app.email);
      db.prepare('DELETE FROM checkins WHERE email = ? AND program_id = 1').run(app.email); // basketball floor only; dropFromPickleball handles pk
      if (offeree) createOffer(runDate, offeree, null);
      dropFromPickleball(app.email);   // a rejected player leaves BOTH programs' floors
    }
  }
  return status;
}

// Vote detail for the council UI. `pool` and `votes` are optional pre-loaded inputs:
// the /admin list renders this for every applicant, so it computes the approver pool
// ONCE and batch-loads all votes in a single query, passing them in to avoid an N+1
// (a pool query + a votes query per applicant). Called standalone → they self-load.
function voteInfo(id, viewerEmail, pool = approverEmails(),
                  votes = db.prepare('SELECT voter_email,vote FROM votes WHERE applicant_id = ?').all(id)) {
  const inPool = votes.filter(v => pool.has(v.voter_email.toLowerCase()));
  const approved = inPool.filter(v => v.vote === 'approve').map(v => v.voter_email.toLowerCase());
  const rejected = inPool.filter(v => v.vote === 'reject').map(v => v.voter_email.toLowerCase());
  const voted = new Set(inPool.map(v => v.voter_email.toLowerCase()));
  const waiting = [...pool].filter(e => !voted.has(e));
  const mine = votes.find(v => v.voter_email.toLowerCase() === viewerEmail.toLowerCase());
  return { poolSize: pool.size, threshold: VOTE_THRESHOLD, approved, rejected, waiting, myVote: mine?.vote || null };
}

app.disable('x-powered-by');
// gzip every text response (HTML/CSS/JS/JSON). ~75% wire cut on the frequent
// polling reloads. Placed before static so served assets are compressed too.
app.use(compression());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
// iOS FIX: a standalone (Home-Screen) PWA renders a BLANK page when a *native form*
// POST responds with a 302 redirect — a long-standing WebKit bug. For non-AJAX POSTs
// only, emit a 200 that redirects on the CLIENT (JS + meta-refresh) instead of a 302.
// AJAX POSTs (they send X-Requested-With: fetch — check-in actions, chat, etc.) keep
// the real 302 so their `.then(r => r.text())` handlers still follow it and swap in place.
app.use((req, res, next) => {
  if (req.method === 'POST' && (req.headers['x-requested-with'] || '') !== 'fetch') {
    res.redirect = (arg1, arg2) => {
      const dest = String(arg2 !== undefined ? arg2 : arg1);
      res.set('Cache-Control', 'no-store');
      // Defense-in-depth: %-encode "<> in the meta URL and < the JSON string so a
      // redirect target can never break out of the attribute OR the </script> boundary.
      const metaDest = dest.replace(/[<>"]/g, c => ({ '<': '%3C', '>': '%3E', '"': '%22' }[c]));
      res.status(200).type('html').send(
        `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${metaDest}">`
        + `<script>location.replace(${JSON.stringify(dest).replace(/</g, '\\u003C')})</script>`);
    };
  }
  next();
});
// Profile-photo storage. Defaults to public/avatars (served by the general static
// mount below); AVATARS_DIR lets a test/other env point it elsewhere. Mounted at
// /avatars BEFORE the public static so an override wins, yet a missing file falls
// through to the public mount (keeps the hand-placed daniel.jpg seed working even
// when AVATARS_DIR is a temp dir). Created on boot so the first upload never ENOENTs.
const AVATARS_DIR = process.env.AVATARS_DIR || path.join(__dirname, 'public', 'avatars');
fs.mkdirSync(AVATARS_DIR, { recursive: true });
app.use('/avatars', express.static(AVATARS_DIR, { maxAge: '365d', immutable: true })); // content-addressed name + ?v= bust → safe to pin
// Chat photo storage. Same override pattern as avatars: CHAT_MEDIA_DIR points it
// elsewhere in test/other envs and is mounted at /chat-media BEFORE the public static
// so an override wins, yet a missing file falls through. Created on boot so the first
// upload never ENOENTs. Stickers live in public/stickers and are served by the general
// public mount below (no per-file DB — validated by name against STICKERS on send).
const CHAT_MEDIA_DIR = process.env.CHAT_MEDIA_DIR || path.join(__dirname, 'public', 'chat-media');
fs.mkdirSync(CHAT_MEDIA_DIR, { recursive: true });
app.use('/chat-media', express.static(CHAT_MEDIA_DIR, { maxAge: '365d', immutable: true })); // <msgid>-<hex> names never rewritten → safe to pin
// The service worker must never be pinned by HTTP cache (it controls the whole app),
// so serve it no-cache from the same public dir, ahead of the 7-day static mount.
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
// The client engine (router/poll/swap/push/badges/logout — see APP_JS in views.js),
// extracted from an inline HEAD script so it caches once instead of re-shipping ~15KB per
// page. The URL carries ?v=BUILD_VER (tracks views.js/styles.css mtime), so any code change
// mints a fresh URL; the body is byte-identical for a given build → cache a year, immutable.
app.get('/app.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('application/javascript').send(APP_JS);
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', immutable: false }));

// Sliding session: any request carrying a valid cookie gets its ~10-year window
// pushed forward, so a player who keeps showing up never has to sign in again.
// Static assets are served above and never reach this.
app.use((req, res, next) => {
  const email = currentUser(req);
  if (email) setSession(res, email);
  next();
});

// PWA manifest — controls the icon + name when players "Add to Home Screen".
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').send(JSON.stringify({
    name: 'The Bridge Adv Runs',
    short_name: 'Bridge Runs',
    start_url: '/runs',
    scope: '/',
    display: 'standalone',
    background_color: '#22615A',
    theme_color: '#22615A',
    icons: [
      { src: '/icon-192.png?v=2', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }));
});

// ---- helpers ----
// The standing weekly run day: 0=Sun … 6=Sat. 3 = Wednesday. The whole basketball
// schedule (next run, overrides, auto open/lock) keys off this — change it here to
// move the standing run to another weekday.
const RUN_DOW = 3;
// Check-in auto-opens this many days before the run, at this hour (local). SINGLE source of
// truth: runStateSchedule fires off these AND the player-facing "registration opens…" copy is
// derived from them, so the two can never drift the way a hardcoded weekday does.
const OPEN_DAYS_BEFORE = 2, OPEN_H = 17;
// "T17:00:00" — the local-time suffix for an hour. Shared by both programs' schedules.
const hhLocal = h => `T${String(h).padStart(2, '0')}:00:00`;
// The date check-in opens for run `rd`.
const openDateFor = (rd) => shiftYmd(rd, -OPEN_DAYS_BEFORE);
function nextRunDefault(d = new Date()) {
  const r = new Date(d);
  const day = r.getDay();            // 0 Sun … 6 Sat
  const add = (RUN_DOW - day + 7) % 7;
  // Stays on the run day all day; at the following local midnight it rolls to next
  // week — so the queue resets at midnight and regulars can re-queue right away.
  r.setDate(r.getDate() + add);
  // Format from LOCAL components — NOT toISOString(), which is UTC. On Eastern,
  // an evening run's toISOString() already reads the NEXT calendar day in UTC and
  // would roll to next week mid-run, purging the current roster. The rollover must
  // happen at LOCAL midnight, so derive Y-M-D from the local date parts.
  const ymd = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return ymd(r); // YYYY-MM-DD (local)
}
function runLabelFor(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// --- Host-configurable run day ---------------------------------------------
// The run defaults to a weekly run day (RUN_DOW = Wednesday). A host can move the
// NEAREST run to ANY nearby date — earlier OR later than that Wednesday. An override
// REPLACES the default run day closest to the chosen date; it is keyed by that day
// (nearestRunDefault(chosen)) and stores the host-chosen actual run_date. nextRunDate()
// resolves the ACTUAL upcoming run date that EVERYTHING keys off (checkins, run_state,
// attendance, offers, admin).
//
// Because a run can move LATER (e.g. Wed→Thu), the run date can fall AFTER its key
// run day. So nextRunDate() cannot just look at this week's run day — it scans a
// 3-week window [thisRunDay-7, thisRunDay, thisRunDay+7], resolves each week's actual
// run date (override or the day itself), keeps those on-or-after today, and returns the
// soonest. The -7 arm is what keeps a Wed→Thu run resolving to the Thursday on the run
// day itself (when nextRunDefault has already flipped to next week), instead of leaking
// forward to next week. See ensureWeek() for the matching rollover.
const stmtRunOverride = db.prepare('SELECT run_date, run_time, run_end FROM run_overrides WHERE default_date = ?');
function runOverrideRow(fridayKey) { return stmtRunOverride.get(fridayKey) || null; }
function runOverrideFor(fridayKey) {
  const row = stmtRunOverride.get(fridayKey);
  return row ? row.run_date : null;
}
// The default-day KEY a run date is keyed under in run_overrides — the base of its cycle.
// Authoritative across FAR moves: read the override row whose run_date matches (its
// default_date IS the base), falling back to the nearest default day when the run sits on
// its default position (no override). Keying off the nearest default day to the DESTINATION
// instead is wrong once a move crosses the week-midpoint — it orphans the run's own override
// and un-suppresses the original default day. (This is basketball's analog of pickleball's
// pk_run_base fix — see /pickleball/date.)
const stmtOverrideByRunDate = db.prepare('SELECT default_date FROM run_overrides WHERE run_date = ? LIMIT 1');
function runBaseFor(runDate) {
  const ov = stmtOverrideByRunDate.get(runDate);
  return ov ? ov.default_date : nearestRunDefault(new Date(runDate + 'T12:00:00'));
}
// Default run window — 8:30 PM to 10:30 PM, server-local (Eastern). The host can override
// per week via run_overrides.run_time / run_end (HH:MM). NULL columns fall back here.
const DEFAULT_START = '20:30', DEFAULT_END = '22:30';
// The {start,end} HH:MM for the run on a given date — from that week's override (keyed
// by its nearest run day) or the defaults. Time-only overrides (run_date === default)
// still carry run_time/run_end, so this resolves them even when the day didn't move.
function runTimesFor(runDate) {
  const row = runOverrideRow(nearestRunDefault(new Date(runDate + 'T12:00:00')));
  return { start: (row && row.run_time) || DEFAULT_START, end: (row && row.run_end) || DEFAULT_END };
}
// "7 PM" / "7:30 PM" from HH:MM.
function fmtClockLabel(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM', h12 = ((h + 11) % 12) + 1;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ap}` : `${h12} ${ap}`;
}
// "7–10 PM" (drops the shared AM/PM on the start when it matches the end); the tip-off
// time alone as "7 PM". Used in the masthead + move announcement.
// "6–8 PM" from two HH:MM strings. Shared by both programs — basketball resolves its window
// from per-week overrides, pickleball derives it from PK_START_H/PK_END_H.
function fmtClockRange(start, end) {
  const s = fmtClockLabel(start), e = fmtClockLabel(end);
  const sap = s.slice(-2), eap = e.slice(-2);
  return sap === eap ? `${s.slice(0, -3)}–${e}` : `${s}–${e}`;
}
function runTimeRange(runDate) {
  const { start, end } = runTimesFor(runDate);
  return fmtClockRange(start, end);
}
function runStartLabel(runDate) { return fmtClockLabel(runTimesFor(runDate).start); }
// Shift a local YYYY-MM-DD by whole days (DST-safe: anchored at local noon so a ±1h
// DST shift never crosses a calendar day). Returns local YYYY-MM-DD.
function shiftYmd(ymdStr, days) {
  const r = new Date(ymdStr + 'T12:00:00');
  r.setDate(r.getDate() + days);
  return ymdLocal(r);
}
// The default run day (RUN_DOW) NEAREST a chosen date (ties → the earlier one). Every
// date is ≤3 days from the run day, so this is unambiguous. This is the override KEY:
// moving the run to D replaces the default run day closest to D.
function nearestRunDefault(d = new Date()) {
  const r = new Date(d);
  const fwd = (RUN_DOW - r.getDay() + 7) % 7;  // 0..6 days forward to the next run day
  const delta = fwd <= 3 ? fwd : fwd - 7;      // forward if ≤3, else the earlier (backward) run day
  r.setDate(r.getDate() + delta);
  return ymdLocal(r);
}
// Season opener (YYYY-MM-DD) or null. Before it, there are NO weekly runs — the next run
// is the first run day on/after the opener, and nothing auto-opens until ~2 days before it.
// This keeps the standing weekly schedule from conjuring phantom off-season runs.
function seasonStart() { const s = getSetting('season_start'); return (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : null; }
function nextRunDate(d = new Date()) {
  const today = ymdLocal(d);
  const opener = seasonStart();
  const preseason = opener && today < opener;
  // Pre-season: resolve the first run day on/after the opener (never earlier than it).
  const from = preseason ? new Date(opener + 'T12:00:00') : d;
  const lo = preseason ? opener : today;   // floor: no run before the opener (or before today, in-season)
  const F = nextRunDefault(from);
  const cands = [];
  for (const bf of [shiftYmd(F, -7), F, shiftYmd(F, 7)]) {  // last / this / next week's run day
    const rd = runOverrideFor(bf) || bf;                    // that week's actual run date
    if (rd >= lo) cands.push(rd);                           // only runs still upcoming (and in-season)
  }
  // F itself is always ≥ lo, so cands is non-empty unless F is overridden into the past —
  // in which case F+7 (never overridable into the past) still qualifies. Guarded with a
  // fallback to F regardless. YYYY-MM-DD compares lexicographically = chronologically.
  return cands.length ? cands.reduce((a, b) => (a < b ? a : b)) : F;
}
// Dynamic day labels — the whole app's "Friday" wording follows the actual run day.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_SHORT = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
function runWeekday(dateStr) { return WEEKDAYS[new Date(dateStr + 'T12:00:00').getDay()]; }
function runWeekdayShort(dateStr) { return WEEKDAYS_SHORT[new Date(dateStr + 'T12:00:00').getDay()]; }
// Local YYYY-MM-DD (matches nextRunDefault's local-parts formatting).
function ymdLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Runs on essentially every authenticated request (requirePlayer + several POSTs),
// so the statement is hoisted to module scope (node:sqlite has no stmt cache).
const stmtApplicantByEmail = db.prepare('SELECT * FROM applicants WHERE email = ?');
function applicantByEmail(email) {
  return stmtApplicantByEmail.get(email.toLowerCase());
}

// ---- Profile photos --------------------------------------------------------
// Upload → memory (never trust a client filename to disk). 10 MB pre-process cap
// so a malicious/huge upload can't exhaust memory or disk before we downscale it.
const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
}).single('photo');

// Magic-byte sniff: the ONLY thing we trust to decide "is this really an image?".
// MIME headers and extensions are attacker-controlled; the first bytes are not.
// iOS re-encodes HEIC → JPEG on an accept="image/*" pick, so we only need
// jpeg/png/webp here. Returns the format or null (reject).
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

// Magic-byte sniff for a recorded voice clip — same trust model as sniffImage (never
// the client MIME/extension). Recognises the three containers MediaRecorder emits:
// WebM/Matroska (EBML, Chrome/Android → 'webm'), MP4/M4A (…ftyp at byte 4, iOS Safari
// → 'm4a'), and Ogg (Firefox → 'ogg'). Returns the extension to store under, or null
// (reject). The returned ext is the ONLY thing trusted to build the filename, so a
// spoofed name/type can never traverse or mislabel the stored file.
function sniffAudio(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'webm'; // EBML (WebM/MKV)
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'm4a';  // ....ftyp (MP4/M4A)
  if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'ogg';  // OggS
  return null;
}

// Magic-byte sniff for a video clip — same trust model as sniffImage/sniffAudio (never
// the client MIME/extension). Recognises the containers a phone/browser produces on an
// accept="video/*" pick: MP4 and QuickTime/MOV both carry a '....ftyp' box at byte 4
// (the major brand at bytes 8–11 tells them apart — 'qt  ' = QuickTime → 'mov', anything
// else → 'mp4'), and WebM/Matroska starts with the EBML marker. Returns the extension to
// store under, or null (reject). The ext is the ONLY thing trusted to build the filename.
function sniffVideo(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'webm'; // EBML (WebM/MKV)
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {              // ....ftyp (MP4/MOV)
    return (buf[8] === 0x71 && buf[9] === 0x74) ? 'mov' : 'mp4';                               // 'qt' major brand → QuickTime
  }
  return null;
}

// Delete a stored avatar file. Names are ALWAYS server-derived (<id>-<hex>.jpg), so a
// separator/`..` means something is wrong — refuse rather than traverse out of the dir.
// The daniel.jpg seed is never in the DB, so it can never be passed here.
function safeUnlinkAvatar(fname) {
  if (!fname || typeof fname !== 'string') return;
  if (fname.includes('/') || fname.includes('\\') || fname.includes('..')) return;
  try { fs.unlinkSync(path.join(AVATARS_DIR, fname)); } catch { /* already gone — fine */ }
}

// ---- Chat media (photos on messages) --------------------------------------
// Same trust model as the profile-photo pipeline: multer buffers the file in memory
// (10 MB pre-cap so a huge upload can't exhaust memory/disk before we downscale),
// magic-byte sniff (never the client MIME/extension), then sharp resizes to a max
// 1600px long edge, bakes EXIF orientation, STRIPS metadata, and re-encodes to ~80%
// JPEG (≈100–300 KB). Stored under a SERVER-derived name (<msgid>-<hex>.jpg) — the
// client filename never touches disk, so no path traversal. Single field: `image`.
const uploadChatImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
}).single('image');

// Downscale + strip + re-encode a sniffed image buffer to a ~80% JPEG (≈100–300 KB).
// Runs BEFORE any DB insert, so a sharp failure (corrupt/decompression-bomb) rejects
// cleanly with no half-created message. Throws on a sharp error.
async function processChatImage(buf) {
  return sharp(buf, { failOn: 'error' })
    .rotate()                                          // bake EXIF orientation in…
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })              // …then re-encode (metadata stripped by default)
    .toBuffer();
}
// Write a processed jpeg under a SERVER-derived name keyed by the message id
// (<msgid>-<hex>.jpg). Returns the public /chat-media path stored on the message.
async function writeChatImage(jpegBuf, msgId) {
  const fname = `${msgId}-${crypto.randomBytes(6).toString('hex')}.jpg`;
  await fs.promises.writeFile(path.join(CHAT_MEDIA_DIR, fname), jpegBuf); // async so the disk write doesn't block the event loop
  return `/chat-media/${fname}`;
}

// Voice clips: multer buffers the upload in memory (8 MB pre-cap — an opus/aac voice
// note is ~4 KB/s, so 8 MB covers well past the 5-min ceiling while blocking a huge
// upload). Single field `audio`. We sniff magic bytes (sniffAudio), then store the raw
// container as-is under a SERVER-derived name (<msgid>-<hex>.<ext>) — no re-encode (no
// ffmpeg dep), and the client filename never touches disk. safeUnlinkChatImage already
// deletes ANY /chat-media/<name>, so voice files clean up on message/account delete too.
const uploadChatAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
}).single('audio');
async function writeChatAudio(buf, msgId, ext) {
  const fname = `${msgId}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  await fs.promises.writeFile(path.join(CHAT_MEDIA_DIR, fname), buf); // async — a big upload write must not stall the loop
  return `/chat-media/${fname}`;
}

// Video clips: like voice, stored raw (no re-encode / no ffmpeg dep) under a SERVER-
// derived name. The pre-cap is larger (video is ~10–30 MB/min off a phone) but bounded
// — CHAT_VIDEO_MAX_MB (default 40) tunes it, since the upload rides Daniel's home
// connection through Funnel. Single field `video`. safeUnlinkChatImage deletes ANY
// /chat-media/<name>, so video files clean up on message/account delete too.
const CHAT_VIDEO_MAX_MB = Number(process.env.CHAT_VIDEO_MAX_MB || 40);
const uploadChatVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHAT_VIDEO_MAX_MB * 1024 * 1024, files: 1 },
}).single('video');
async function writeChatVideo(buf, msgId, ext) {
  const fname = `${msgId}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  await fs.promises.writeFile(path.join(CHAT_MEDIA_DIR, fname), buf); // async — a 40MB video write must not block every other request
  return `/chat-media/${fname}`;
}

// ---- Check-in banner (host-uploaded, cropped in-app) ----------------------
// The 2:1 hero photo on the check-in page. A host uploads a photo and frames it in the
// browser (pan/zoom in a 2:1 window); the client sends the source-pixel crop rect and we
// sharp-crop to the final 2320×1160. BANNER_PATH is env-overridable (tests point elsewhere).
const BANNER_PATH = process.env.BANNER_PATH || path.join(__dirname, 'public', 'gym.jpg');
const uploadBanner = multer({ storage: multer.memoryStorage(), limits: { fileSize: 14 * 1024 * 1024, files: 1 } }).single('photo');
// Cache-bust token = the banner file's mtime, so an upload busts the <img> the moment it's
// saved (no restart, no manual version bump). Falls back to a constant if the file is absent.
function bannerVersion() {
  try { return String(Math.floor(fs.statSync(BANNER_PATH).mtimeMs)); } catch { return '0'; }
}
// Pickleball gets its OWN banner photo (pk-banner.jpg); until one is uploaded it falls back
// to the basketball court photo, so the page always shows something.
const PK_BANNER_PATH = process.env.PK_BANNER_PATH || path.join(__dirname, 'public', 'pk-banner.jpg');
function pkBannerHasOwn() { try { return fs.statSync(PK_BANNER_PATH).size > 0; } catch { return false; } }
function pkBannerSrc() { return pkBannerHasOwn() ? '/pk-banner.jpg' : '/gym.jpg'; }
function pkBannerVersion() { try { return String(Math.floor(fs.statSync(pkBannerHasOwn() ? PK_BANNER_PATH : BANNER_PATH).mtimeMs)); } catch { return '0'; } }

// Delete a stored chat photo by its public path. Only /chat-media/<safe-name> paths are
// touched — stickers (/stickers/*) and anything with a separator/`..` are refused, so a
// stray value can never traverse out of CHAT_MEDIA_DIR. Best-effort (already-gone = fine).
function safeUnlinkChatImage(imgPath) {
  if (!imgPath || typeof imgPath !== 'string') return;
  const prefix = '/chat-media/';
  if (!imgPath.startsWith(prefix)) return;             // stickers + external paths: nothing to delete
  const fname = imgPath.slice(prefix.length);
  if (!fname || fname.includes('/') || fname.includes('\\') || fname.includes('..')) return;
  try { fs.unlinkSync(path.join(CHAT_MEDIA_DIR, fname)); } catch { /* already gone — fine */ }
}

// Chat-media retention: keep photos/voice/video for 1 YEAR, then delete the files and null
// the media columns (the message row + any caption stay, so reply-chains/history are intact;
// a >1-year-old media-only bubble simply goes empty — nobody scrolls back that far in a run
// chat). Sticker images (/stickers/…) are shared SVGs, never pruned. Runs at boot + daily.
function pruneOldMedia() {
  try {
    let n = 0;
    const g = db.prepare("SELECT id, image, audio, video FROM group_messages WHERE created_at < datetime('now','-1 year') AND (audio IS NOT NULL OR video IS NOT NULL OR image LIKE '/chat-media/%')").all();
    const gclr = db.prepare("UPDATE group_messages SET audio = NULL, video = NULL, image = CASE WHEN image LIKE '/chat-media/%' THEN NULL ELSE image END WHERE id = ?");
    // group_messages now holds every program's room (program_id), so this one sweep covers
    // pickleball too — the old pk_group_messages twin is gone (Phase 2 merge). Age-based media
    // retention is program-agnostic, so no program_id filter is needed or wanted here.
    for (const r of g) { safeUnlinkChatImage(r.image); safeUnlinkChatImage(r.audio); safeUnlinkChatImage(r.video); gclr.run(r.id); n++; }
    const d = db.prepare("SELECT id, image FROM messages WHERE created_at < datetime('now','-1 year') AND image LIKE '/chat-media/%'").all();
    const dclr = db.prepare('UPDATE messages SET image = NULL WHERE id = ?');
    for (const r of d) { safeUnlinkChatImage(r.image); dclr.run(r.id); n++; }
    if (n) console.log(`[media-prune] cleared ${n} chat-media file(s) older than 1 year`);
  } catch (e) { console.error(`[media-prune] failed: ${e.message}`); }
}

// audit_log retention: db.js trims to the newest 5000 rows at boot, but a long-lived process
// (weeks between deploys) grows it unbounded in between. Trim on the same daily cadence as media.
function pruneAuditLog() {
  try {
    const { changes } = db.prepare('DELETE FROM audit_log WHERE id < (SELECT MAX(id) - 5000 FROM audit_log)').run();
    if (changes) console.log(`[audit-prune] trimmed ${changes} old audit_log row(s)`);
  } catch (e) { console.error(`[audit-prune] failed: ${e.message}`); }
}

// The valid sticker set (from views.js) → an image path, or null if unknown. A sticker
// send carries only a name; this is the ONLY thing trusted to build the path (no upload,
// no client-supplied path), so a bogus/traversal name can never become an image.
const STICKER_SET = new Set(STICKERS);
function stickerPath(name) {
  return STICKER_SET.has(String(name || '')) ? `/stickers/${name}.svg` : null;
}

// Rebuild the email→photo registry views.js reads (see setAvatarMap). Called at boot
// and after any avatar OR email mutation. v = file mtime ms (cache-buster). Small
// table, single process — a full rebuild is simplest and always consistent.
function refreshAvatarMap() {
  const m = new Map();
  for (const r of db.prepare("SELECT email, avatar FROM applicants WHERE avatar IS NOT NULL AND avatar != ''").all()) {
    let v = '1';
    try { v = String(Math.floor(fs.statSync(path.join(AVATARS_DIR, r.avatar)).mtimeMs)); } catch { /* file missing → default v */ }
    m.set(String(r.email).toLowerCase(), { file: r.avatar, v });
  }
  setAvatarMap(m);
}
refreshAvatarMap(); // prime at boot so already-set photos render on the first request

// --- attendance ("games attended") helpers -------------------------------
// The attendance table is the permanent log of who was on the FINAL floor each
// Friday; loadRun() archives into it right before its weekly checkins purge.
function runStartEpoch(runDate) { return new Date(runDate + 'T' + runTimesFor(runDate).start + ':00').getTime(); } // configured start, server-local (Eastern)
// Hoisted — attendanceStats runs on every profile page/card render (node:sqlite has no stmt cache).
const stmtAttTotal = db.prepare('SELECT COUNT(*) n FROM attendance WHERE email = ? AND program_id = 1');
const stmtAttSeason = db.prepare("SELECT COUNT(*) n FROM attendance WHERE email = ? AND program_id = 1 AND run_date >= strftime('%Y-01-01','now')");
const stmtAttDates = db.prepare('SELECT run_date FROM attendance WHERE email = ? AND program_id = 1 ORDER BY run_date ASC');
function attendanceStats(email) {
  const total = stmtAttTotal.get(email).n;
  const season = stmtAttSeason.get(email).n;
  const dates = stmtAttDates.all(email).map(r => r.run_date);
  const first = dates.length ? dates[0] : null;
  // Longest run of consecutive runs attended. Compare CALENDAR days (UTC-midnight floor,
  // DST-safe). Runs are ~weekly, but the host can MOVE a run, so a 4–10-day gap still
  // means "the very next run" (not a 7-day-exact match); >10 days means a run was missed.
  let streak = 0, cur = 0, prevUtc = null;
  for (const s of dates) {
    const utc = Date.parse(s + 'T00:00:00Z');
    const days = prevUtc != null ? Math.round((utc - prevUtc) / 86400000) : null;
    cur = (days !== null && days >= 4 && days <= 10) ? cur + 1 : 1;
    if (cur > streak) streak = cur;
    prevUtc = utc;
  }
  return { total, season, streak, first, dates };
}

// --- messaging (Phase 2) helpers -----------------------------------------
// Unread badge source: one COUNT per page load, served by idx_messages_to.
const stmtUnread = db.prepare('SELECT COUNT(*) n FROM messages WHERE to_email = ? AND read_at IS NULL');
function unreadCount(email) { return email ? stmtUnread.get(email).n : 0; }

// --- Unified Run Chat engine (Phase 3b) ------------------------------------------------------
// ONE program-parameterized engine serves every program's room: each hoisted statement binds
// program_id at call time, so a single prepared statement covers all programs. The public
// groupUnread / pkGroupUnread / loadGroupChat / loadPkGroupChat / markGroupRead / notifyMentions
// (…and pk twins) are THIN WRAPPERS below that pass the program id — so no call site changed.
// Reads P(programId) for the member roster source (apply=all-approved, opt-in=members) + mention
// push routing (paths.chat + config.mentionTag). P() is referenced at call time (safe here).
//
// Run Chat unread: group_messages newer than this viewer's read high-water mark (or ALL if they've
// never opened the room), excluding their own posts. One COUNT per page load, served by the PK.
const stmtChatUnread = db.prepare(`
  SELECT COUNT(*) n FROM group_messages
  WHERE program_id = ? AND id > COALESCE((SELECT last_read_id FROM group_reads WHERE email = ? AND program_id = ?), 0)
    AND from_email != ?`);
function chatUnreadFor(programId, email) { return email ? stmtChatUnread.get(programId, email, programId, email).n : 0; }
function groupUnread(email) { return chatUnreadFor(1, email); }

// Badge split: the Messages tab shows DM unread (unreadCount), the Roster tab
// shows group (Run Chat) unread (groupUnread). Every tab-bearing route feeds both
// into tabNav({ dm, group }).

// Load the Run Chat feed for rendering under the roster: last ~200 messages ASC in
// bulk + reactions map + reply-parent map + sender map (no N+1) + member count.
// Mirrors what the old /chat GET assembled; the caller marks-read separately.
// Bulk-hydrate a chronological (id ASC) slice of group messages: reactions,
// reply-parents, sender identities, and @-mention names — all no-N+1. Shared by
// loadGroupChat (latest page) and loadGroupChatOlder (a scroll-back page).
function hydrateGroupMessages(programId, me, msgs) {
  const reactions = new Map();  // message_id -> [{emoji,count,mine}]
  const parents = new Map();    // parent id -> {from_email, body}
  const senders = new Map();    // email -> {id, full_name, is_host}
  if (msgs.length) {
    const ids = msgs.map(m => m.id);
    const ph = ids.map(() => '?').join(',');
    for (const r of db.prepare(`
      SELECT group_message_id AS mid, emoji, COUNT(*) AS cnt,
             SUM(CASE WHEN from_email = ? THEN 1 ELSE 0 END) AS mine
      FROM group_reactions WHERE group_message_id IN (${ph})
      GROUP BY group_message_id, emoji ORDER BY group_message_id, emoji`).all(me, ...ids)) {
      if (!reactions.has(r.mid)) reactions.set(r.mid, []);
      reactions.get(r.mid).push({ emoji: r.emoji, count: r.cnt, mine: r.mine > 0 });
    }
    const replyIds = [...new Set(msgs.map(m => m.reply_to).filter(Boolean))];
    if (replyIds.length) {
      const ph2 = replyIds.map(() => '?').join(',');
      for (const pr of db.prepare(`SELECT id, from_email, body, image, audio, video FROM group_messages WHERE id IN (${ph2}) AND program_id = ?`).all(...replyIds, programId))
        parents.set(pr.id, pr);
    }
    const emails = [...new Set([...msgs.map(m => m.from_email), ...[...parents.values()].map(p => p.from_email)])];
    const ph3 = emails.map(() => '?').join(',');
    for (const s of db.prepare(`SELECT id, full_name, email, is_host FROM applicants WHERE email IN (${ph3})`).all(...emails))
      senders.set(s.email, s);
  }
  // Mention-name map: id -> full_name for every applicant @-tagged across the loaded
  // messages. Drives esc-safe linkify in chatFragment (match the escaped name in the
  // escaped body, wrap in <a class="mention">). One bulk query, no N+1.
  const mentionNames = new Map();
  const mentionIds = [...new Set(msgs.flatMap(m =>
    (m.mentions ? String(m.mentions).split(',') : []).map(Number).filter(Boolean)))];
  if (mentionIds.length) {
    const phm = mentionIds.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT id, full_name FROM applicants WHERE id IN (${phm})`).all(...mentionIds))
      mentionNames.set(r.id, r.full_name);
  }
  return { reactions, parents, senders, mentionNames };
}

// Hoisted — the chat re-render path (loadGroupChat) runs on every /chat page fetch, which every
// open client re-fetches on each fingerprint change (each message × each viewer on a busy night).
const stmtChatHasOlder = db.prepare('SELECT 1 FROM group_messages WHERE id < ? AND program_id = ? LIMIT 1');
const stmtChatMsgs = db.prepare('SELECT * FROM ( SELECT * FROM group_messages WHERE program_id = ? ORDER BY id DESC LIMIT 200 ) ORDER BY id ASC');
const stmtChatOlder = db.prepare('SELECT * FROM ( SELECT * FROM group_messages WHERE id < ? AND program_id = ? ORDER BY id DESC LIMIT 200 ) ORDER BY id ASC');
// Member roster: an APPLY program (basketball) lists every approved player; an OPT-IN program
// (pickleball) lists only those who joined it (program_membership). Same columns + sort either way.
const stmtChatMembersAll = db.prepare(`SELECT id, full_name, email, is_host, is_team, is_regular, avatar
    FROM applicants WHERE status = 'approved' AND email NOT LIKE '%@guest.local'
    ORDER BY is_host DESC, is_team DESC, is_regular DESC, full_name COLLATE NOCASE`);
const stmtChatMembersJoined = db.prepare(`SELECT a.id, a.full_name, a.email, a.is_host, a.is_team, a.is_regular, a.avatar
    FROM program_membership pm JOIN applicants a ON a.email = pm.email
    WHERE pm.program_id = ? AND a.status = 'approved' AND a.email NOT LIKE '%@guest.local'
    ORDER BY a.is_host DESC, a.is_team DESC, a.is_regular DESC, a.full_name COLLATE NOCASE`);
const stmtChatPinned = db.prepare('SELECT * FROM group_messages WHERE pinned_at IS NOT NULL AND program_id = ? ORDER BY pinned_at DESC LIMIT 5');
function chatMembersFor(programId) {
  const p = P(programId);
  return (p && p.config.access === 'opt-in') ? stmtChatMembersJoined.all(programId) : stmtChatMembersAll.all();
}
// True if at least one group message exists older than `id` in this program's room (drives the
// "Load earlier messages" button — shown only when there is more history).
function hasOlderChat(programId, id) { return id ? !!stmtChatHasOlder.get(id, programId) : false; }

function loadChat(programId, me) {
  const msgs = stmtChatMsgs.all(programId);
  const maps = hydrateGroupMessages(programId, me, msgs);
  // Member list = the SAME population the "N members" count uses (see chatMembersFor).
  // memberCount is derived from this list's length so the header count and the members
  // overlay can never disagree. Sorted host → team → core → regular, then name.
  const members = chatMembersFor(programId);
  // Pinned messages — newest pin first, capped. Hydrate their senders too (a pinned
  // message may be older than the loaded 200, so it needs its own sender lookup).
  const pinned = stmtChatPinned.all(programId);
  const pinnedNames = new Map();
  if (pinned.length) {
    const pe = [...new Set(pinned.map(p => p.from_email))];
    const ph = pe.map(() => '?').join(',');
    for (const s of db.prepare(`SELECT email, full_name FROM applicants WHERE email IN (${ph})`).all(...pe)) pinnedNames.set(s.email, s.full_name);
  }
  return { msgs, ...maps, members, memberCount: members.length, pinned, pinnedNames,
           hasOlder: msgs.length ? hasOlderChat(programId, msgs[0].id) : false };
}

// One page of scroll-back: the ≤200 messages immediately older than `beforeId`, chronological
// (id ASC), hydrated the same way. hasOlder reports whether yet more history remains above.
function loadChatOlder(programId, me, beforeId) {
  const msgs = stmtChatOlder.all(beforeId, programId);
  const maps = hydrateGroupMessages(programId, me, msgs);
  return { msgs, ...maps, hasOlder: msgs.length ? hasOlderChat(programId, msgs[0].id) : false };
}
function loadGroupChat(me) { return loadChat(1, me); }
function loadGroupChatOlder(me, beforeId) { return loadChatOlder(1, me, beforeId); }

// Validate a raw comma-separated mention-id string against the applicants table.
// Returns a canonical comma-separated string of the REAL ids (deduped, capped), or
// null when none are valid. Guards against a client posting bogus/foreign ids.
function validMentions(raw) {
  const ids = [...new Set(String(raw || '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0))].slice(0, 30);
  if (!ids.length) return null;
  const ph = ids.map(() => '?').join(',');
  const real = new Set(db.prepare(`SELECT id FROM applicants WHERE id IN (${ph})`).all(...ids).map(r => r.id));
  const valid = ids.filter(id => real.has(id));
  return valid.length ? valid.join(',') : null;
}
// Push a "you were mentioned" notification to each @-mentioned player (never the sender). No-op
// with no mentions / no subscriptions. Fired in the background. Routes to the mentioned program's
// chat (P(programId).paths.chat) with its own push-dedup tag (config.mentionTag).
function notifyChatMentions(programId, fromEmail, body, mentions) {
  if (!mentions) return;
  const ids = String(mentions).split(',').map(Number).filter(Boolean);
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT email FROM applicants WHERE id IN (${ph}) AND email NOT LIKE '%@guest.local'`).all(...ids);
  const from = String(fromEmail).toLowerCase();
  const emails = rows.map(r => r.email).filter(e => e.toLowerCase() !== from);
  if (!emails.length) return;
  const sender = applicantByEmail(fromEmail);
  const name = sender ? sender.full_name : 'Someone';
  const p = P(programId);
  setImmediate(() => sendPush(emails, { title: `${name} mentioned you`, body: (body || '').slice(0, 140), url: p.paths.chat, tag: p.config.mentionTag }));
}
function notifyMentions(fromEmail, body, mentions) { return notifyChatMentions(1, fromEmail, body, mentions); }

// DM push: buzz the recipient's phone — otherwise a host DM reaches nobody until they
// happen to open the app. Coalesced to at most 1 push / 2 min per sender→recipient pair
// so a rapid back-and-forth doesn't spam. Carries `badge` = the recipient's total unread
// (DM + Run Chat) so the service worker can set the home-screen icon badge while closed.
function notifyDM(sender, toEmail, preview) {
  if (!sender || !toEmail) return;
  if (rateLimited('dmpush', sender.email + '>' + toEmail, 1, 2 * 60 * 1000)) return;
  const badge = unreadCount(toEmail) + groupUnread(toEmail);
  setImmediate(() => sendPush([toEmail], {
    title: sender.full_name || 'New message',
    body: (preview || '').slice(0, 140),
    url: '/messages/' + sender.id,
    tag: 'dm-' + sender.id,
    badge,
  }));
}

// "You were mentioned" count: UNREAD group messages (newer than this viewer's read
// high-water mark, not their own) whose stored mentions include their applicant id.
// Reuses the group_reads high-water mark that groupUnread already scopes against.
const stmtChatMentions = db.prepare(`
    SELECT mentions FROM group_messages
    WHERE program_id = ? AND id > COALESCE((SELECT last_read_id FROM group_reads WHERE email = ? AND program_id = ?), 0)
      AND from_email != ? AND mentions IS NOT NULL AND mentions != ''`); // hoisted — runs on every /poll tick; PK range, not a scan
function chatMentionUnreadFor(programId, email, applicantId) {
  if (!email || !applicantId) return 0;
  const rows = stmtChatMentions.all(programId, email, programId, email);
  const idStr = String(applicantId);
  let n = 0;
  for (const r of rows) if (String(r.mentions).split(',').includes(idStr)) n++;
  return n;
}
function groupMentionUnread(email, applicantId) { return chatMentionUnreadFor(1, email, applicantId); }
// The viewer's applicant id (for mention scoping). NULL for admins with no row.
function applicantIdOf(email) {
  const a = applicantByEmail(email);
  return a ? a.id : 0;
}
// Bump this viewer's Run Chat read high-water mark to now (clears their group-unread) for a program.
const stmtMarkChatRead = db.prepare(`INSERT INTO group_reads (email, last_read_id, last_read_at, program_id)
              VALUES (?, (SELECT COALESCE(MAX(id),0) FROM group_messages WHERE program_id = ?), datetime('now'), ?)
              ON CONFLICT(email, program_id) DO UPDATE SET last_read_id = excluded.last_read_id, last_read_at = excluded.last_read_at`);
function markChatRead(programId, me) { stmtMarkChatRead.run(me, programId, programId); }
function markGroupRead(me) { return markChatRead(1, me); }

// --- Pickleball chat = the SAME unified engine, program 2. Thin wrappers keep the pk names the
// pickleball routes + page renders call; the old duplicated pk_ chat helpers are gone (unified above).
function pkGroupUnread(email) { return chatUnreadFor(2, email); }
function loadPkGroupChat(me) { return loadChat(2, me); }
function loadPkGroupChatOlder(me, beforeId) { return loadChatOlder(2, me, beforeId); }
function notifyPkMentions(fromEmail, body, mentions) { return notifyChatMentions(2, fromEmail, body, mentions); }
function pkGroupMentionUnread(email, applicantId) { return chatMentionUnreadFor(2, email, applicantId); }
function markPkGroupRead(me) { return markChatRead(2, me); }
// Chat gate = page gate + pickleball MEMBERSHIP. You must have opened the pickleball run
// (which joins you) to access its chat — being an approved basketball player isn't enough.
// pkIsMember/pkGate are hoisted function declarations, so this resolves despite ordering.
function pkChatGate(req, res, json) {
  const g = pkGate(req, res); if (!g) return null;         // pkGate already responded on failure
  if (!pkIsMember(req.userEmail)) {
    if (json) res.status(403).json({ err: 'notmember' });
    else res.redirect('/pickleball');                      // open the run first to join
    return null;
  }
  return g;
}

// ---------- PROGRAM REGISTRY ----------
// Every run (basketball, pickleball, …) is one entry in this in-memory map, hydrated at boot
// (buildPrograms(), defined below once the engine functions exist) from the `program` table
// + the per-program presentation/dispatch in PROGRAM_DEFS. This registry is the ONLY thing
// the cookie, unread counts, runs hub, /poll, and back-links read — no code hardcodes
// "program 1 vs 2" anymore, so a new run is a new registry entry, not a new `=== 2 ?` branch.
// Phase 1: each entry still dispatches to today's basketball / pickleball functions; a later
// phase folds the two DEFS into one config-driven engine. Insertion order = ascending id
// (deterministic hub / poll output). Each entry: { id, key, emoji, displayName, paths,
// seasonLabel, active():bool, unread(email,aid):{group,gm}, hubCard(req):{…dynamic card…} }.
const PROGRAMS = new Map();
const P = (id) => PROGRAMS.get(Number(id)) || PROGRAMS.get(1);   // unknown/stale id → the default run (basketball)

// Remember the last run the viewer opened, as its numeric program id (1 = basketball). A
// lightweight UNSIGNED preference cookie (not identity) — read only for run-aware tab routing.
function setRunCookie(req, res, program) {
  if (req.headers['x-prewarm'] === '1') return; // a router prewarm isn't a real visit — don't flip context
  try { res.cookie('bridge_run', String(program), { httpOnly: true, sameSite: 'lax', maxAge: 180 * 24 * 60 * 60 * 1000, path: '/' }); } catch {}
}
// The program the viewer is currently "in", from the cookie. Only honored when that program
// EXISTS and is LIVE — otherwise a stale / unpublished-since id would point the Chat tab at a
// route its gate now 404s. Defaults to program 1 (basketball, always live).
function runCookie(req) {
  const id = Number(req.cookies && req.cookies.bridge_run);
  const p = PROGRAMS.get(id);
  return (id > 1 && p && p.active()) ? id : 1;
}
// The chat unread counts for a given program — used on the neutral pages so the run-aware
// Chat tab badge matches the room it will open. Delegates to that program's dispatch.
function chatCountsFor(program, email, aid) {
  return P(program).unread(email, aid);
}

// The SINGLE authorization seam for messaging. Host-only in v1: a player may
// message the host; the host may message any approved, non-guest player. To open
// full DMs later, relax only the final return (+ add a people-picker) — no route
// or schema change. senderA is the sender's applicant row.
function canMessage(senderEmail, senderA, recip) {
  if (!recip || recip.status !== 'approved') return false;
  if (recip.email === senderEmail) return false;            // no messaging yourself
  if (/@guest\.local$/.test(recip.email)) return false;     // guest placeholders aren't accounts
  if (senderA && senderA.is_host) return true;              // host → anyone approved
  // Player-to-player DMs: any approved player may message any other approved player.
  return !!(senderA && (senderA.status === 'approved' || senderA.is_team));
}

// Reactions: the 6 standard tapbacks OR a single validated free emoji. Rejects any
// text/markup outright (both here AND esc()'d at render — defence in depth).
const STD_TAPBACKS = ['❤️', '👍', '👎', '😂', '‼️', '❓'];
function validEmoji(raw) {
  const e = String(raw || '').trim();
  if (!e) return null;
  if (STD_TAPBACKS.includes(e)) return e;                   // allowlist bypasses the heuristics
  if (Buffer.byteLength(e, 'utf8') > 16) return null;       // short: allows VS-16 / a skin modifier
  if ([...e].length > 8) return null;                       // codepoint cap (one emoji / short ZWJ seq)
  if (/[A-Za-z0-9<>"'`&\/\\]/.test(e)) return null;         // no ASCII text, no markup chars
  try {
    // all codepoints must be emoji-class (pictographic / modifier / flag / VS-16 / ZWJ)
    if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|️|‍)+$/u.test(e)) return null;
  } catch { return null; }                                  // no Unicode property support → reject
  return e;
}

// ---------- INTAKE (public application form → council votes) ----------
app.get('/', (req, res) => res.send(intakePage()));

app.post('/apply', (req, res) => {
  // Cap application spam per IP so nobody can flood the pending list.
  if (rateLimited('apply-ip', clientIp(req), 8, 10 * 60 * 1000)) {
    return res.send(intakePage({ error: 'Too many submissions from here — give it a few minutes and try again.' }));
  }
  const { full_name, phone, email, where_played, waiver_ok } = req.body;
  // levels can be a single string, an array, or undefined
  let levels = req.body.levels || [];
  if (typeof levels === 'string') levels = [levels];
  const otherText = (req.body.levels_other || '').trim();
  // replace bare "Other" with the typed value
  const experience = levels
    .map(l => (l === 'Other' && otherText) ? `Other: ${otherText}` : l)
    .filter(l => l && l !== 'Other')
    .join(', ');
  if (!full_name || !phone || !email || !experience) {
    return res.send(intakePage({ error: 'Please fill in name, phone, email, and at least one level.' }));
  }
  const em = String(email).trim().toLowerCase();
  // A stored address is later a nodemailer recipient (announcement BCC, spot offers), so it
  // has to survive the same gate as /login rather than entering the DB unchecked.
  if (!isValidEmail(em)) return res.send(intakePage({ error: 'That email doesn’t look right — check it and try again.' }));
  try {
    const existing = applicantByEmail(em);
    // Anyone with a player's email could otherwise rename/rehome them via the
    // public QR form. An already-cleared player (approved / team / host) is never
    // overwritten by a public re-application — send them to sign in instead.
    if (existing && (existing.status === 'approved' || existing.is_team || existing.is_host)) {
      return res.send(intakePage({ alreadyApproved: true }));
    }
    if (existing) {
      db.prepare(`UPDATE applicants SET full_name=?, phone=?, experience=?, where_played=?, waiver_ok=?
                  WHERE email=?`)
        .run(full_name.trim(), phone.trim(), experience, (where_played || '').trim(),
             waiver_ok ? 1 : 0, em);
    } else {
      db.prepare(`INSERT INTO applicants (full_name,email,phone,experience,where_played,waiver_ok)
                  VALUES (?,?,?,?,?,?)`)
        .run(full_name.trim(), em, phone.trim(), experience, (where_played || '').trim(),
             waiver_ok ? 1 : 0);
    }
    res.send(intakePage({ submitted: true }));
  } catch (e) {
    console.error(e);
    res.send(intakePage({ error: 'Something broke on our end. Try again.' }));
  }
});

// ---------- LOGIN (magic link) ----------
// Issue a fresh single-use magic sign-in link for an email: invalidate any older
// unused tokens (so a resend always leaves exactly one valid link), store the new
// one, and return the full /auth URL. Shared by the /login flow AND the invite
// claim flow (when an invite can't prove ownership of the submitted email, we send
// a link instead of silently signing them in).
// Returns { url, code }: a magic-link URL (for browser/desktop) AND a 6-digit code
// (for signing in INSIDE the installed app). Both live on the same row and are
// invalidated together — a resend always leaves exactly one valid credential pair.
function createLoginLink(req, email, next = '/checkin') {
  const token = crypto.randomBytes(24).toString('base64url');
  const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  const expires = Date.now() + 15 * 60 * 1000;
  db.prepare('UPDATE login_tokens SET used = 1 WHERE email = ? AND used = 0').run(email);
  db.prepare('INSERT INTO login_tokens (token,email,expires_at,code) VALUES (?,?,?,?)').run(token, email, expires, code);
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return { url: `${base}/auth?token=${token}&next=${encodeURIComponent(next)}`, code };
}
// Local-path guard for post-login redirects (blocks open-redirects like //evil.com).
function safeNextPath(next) {
  // Strict path allowlist: must start with a single "/" and contain ONLY URL-path-safe
  // characters. This blocks protocol-relative (`//evil`), backslash tricks, AND the
  // `"<>` that would otherwise let a crafted ?next= break out of the client-redirect shim.
  return (typeof next === 'string' && /^\/(?!\/)[A-Za-z0-9/_\-?=&.%#!:@~+]*$/.test(next)) ? next : '/runs';
}

app.get('/login', (req, res) => {
  if (currentUser(req)) return res.redirect(safeNextPath(req.query.next));
  res.send(loginPage({ next: req.query.next || '' }));
});

app.post('/login', async (req, res) => {
  const em = String(req.body.email || '').trim().toLowerCase();
  const next = req.body.next || '/runs';
  if (!isValidEmail(em)) return res.send(loginPage({ error: 'Enter a valid email.' }));

  // Throttle magic-link sends: at most 3 per address / 5 min (stops bombing one
  // inbox) and 20 per IP / 10 min (stops cycling through many addresses). Both
  // protect our Gmail daily quota.
  if (rateLimited('login-email', em, 3, 5 * 60 * 1000) ||
      rateLimited('login-ip', clientIp(req), 20, 10 * 60 * 1000)) {
    return res.send(loginPage({ next,
      error: 'You’ve requested a few links already — check your inbox (and spam), then wait a minute before trying again.' }));
  }

  // Requesting a new link invalidates any older unused ones for this email, so a
  // "resend" always leaves exactly one valid link + code.
  const { url: link, code } = createLoginLink(req, em, next);

  if (emailConfigured) {
    // Don't make the player wait on the email — respond instantly, then send on
    // the next tick so even nodemailer's synchronous MIME/TLS setup happens
    // AFTER the response is flushed. A failure is logged loudly here; the "check
    // your email" page tells them how to request a fresh link.
    res.send(loginPage({ sent: true, email: em, next }));
    setImmediate(() => {
      sendMagicLink(em, link, code).catch(err =>
        console.error(`[login] magic-link send FAILED for ${em}: ${err.message}`));
    });
    return;
  } else {
    // Dev mode: no SMTP configured — the "send" just returns the link + code to show.
    const result = await sendMagicLink(em, link, code);
    res.send(loginPage({ sent: true, email: em, next, devLink: result.dev ? link : '', devCode: result.dev ? code : '' }));
  }
});

// GET renders a confirm page that auto-submits — it does NOT consume the token, so an
// email security scanner's bare GET (Outlook SafeLinks etc.) can't burn the sign-in link
// + code before the person taps it. The POST does the actual single-use consume + sign-in.
app.get('/auth', (req, res) => {
  const { token, next } = req.query;
  const row = db.prepare('SELECT * FROM login_tokens WHERE token = ?').get(token || '');
  if (!row || row.used || row.expires_at < Date.now()) {
    return res.send(loginPage({ next: next || '',
      error: 'That link is expired or already used — enter your email to get a fresh one. Use the same email you applied with.' }));
  }
  return res.send(confirmActionPage({
    title: 'Signing in', heading: 'Tap to sign in', sub: 'One tap finishes signing you in to The Bridge Adv Runs.',
    action: '/auth', fields: { token, next: next || '' }, button: 'Sign in →',
  }));
});
app.post('/auth', (req, res) => {
  const { token, next } = req.body;
  const row = db.prepare('SELECT * FROM login_tokens WHERE token = ?').get(token || '');
  if (!row || row.used || row.expires_at < Date.now()) {
    return res.send(loginPage({ next: next || '',
      error: 'That link is expired or already used — enter your email to get a fresh one. Use the same email you applied with.' }));
  }
  db.prepare('UPDATE login_tokens SET used = 1 WHERE token = ?').run(token);
  setSession(res, row.email);
  res.redirect(safeNextPath(next));
});

// Sign in with the 6-digit code from the email — the path that works INSIDE the
// installed app (an emailed link would open Safari, a separate storage jar). Same
// single-use credential row as the magic link; brute force is capped by attempts +
// rate limits, and the error is identical for wrong/expired/no-code so membership
// and pending-code state never leak.
app.post('/login/code', (req, res) => {
  const em = String(req.body.email || '').trim().toLowerCase();
  const codeIn = String(req.body.code || '').replace(/\D/g, '');
  const next = req.body.next || '/runs';
  const fail = (msg) => res.send(loginPage({ sent: true, email: em, next, codeError: msg }));

  if (rateLimited('login-code', em, 10, 10 * 60 * 1000) ||
      rateLimited('login-code-ip', clientIp(req), 30, 10 * 60 * 1000))
    return fail('Too many tries — wait a few minutes, or request a fresh code.');
  if (codeIn.length !== 6) return fail('Enter the 6-digit code from your email.');

  const row = db.prepare('SELECT * FROM login_tokens WHERE email = ? AND used = 0 AND expires_at > ? ORDER BY rowid DESC LIMIT 1')
    .get(em, Date.now());
  const GENERIC = 'That code didn’t match or has expired — request a fresh one.';
  if (!row || !row.code) return fail(GENERIC);
  if (row.attempts >= 5) { db.prepare('UPDATE login_tokens SET used = 1 WHERE token = ?').run(row.token); return fail(GENERIC); }

  const a = Buffer.from(codeIn), b = Buffer.from(String(row.code));
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) { db.prepare('UPDATE login_tokens SET attempts = attempts + 1 WHERE token = ?').run(row.token); return fail(GENERIC); }

  db.prepare('UPDATE login_tokens SET used = 1 WHERE token = ?').run(row.token);
  setSession(res, em);
  res.redirect(safeNextPath(next));
});

// GET renders a confirm page only (no state change) so a prefetch / <img src>/CSRF
// GET can't sign anyone out; POST does the actual clear. The client-side handler in
// HEAD intercepts "Sign out" links and posts directly for a seamless one-tap flow.
app.get('/logout', (req, res) => { res.send(logoutPage()); });
app.post('/logout', (req, res) => { clearSession(res); res.redirect('/'); });

// ---------- LEGAL / POLICY PAGES (public) ----------
// Renders the source drafts in legal/*.md through the app shell. The .md files stay
// untouched as review copies (they carry an operator-only "DRAFT — have a lawyer review"
// note + [PLACEHOLDERS]); we strip that note and fill the placeholders at RENDER time, so
// the published page is clean while the file remains the reviewable source of truth.
const LEGAL_DOCS = {
  privacy: { file: 'privacy-policy.md', title: 'Privacy Policy' },
  terms: { file: 'terms-of-use.md', title: 'Terms of Use' },
  conduct: { file: 'code-of-conduct.md', title: 'Code of Conduct' },
};
function renderLegal(key) {
  const d = LEGAL_DOCS[key];
  if (!d) return null;
  let md;
  try { md = fs.readFileSync(path.join(__dirname, 'legal', d.file), 'utf8'); } catch { return null; }
  md = md.replace(/^\s*\*\*[^\n]*DRAFT[^\n]*\*\*\s*\n/, '');                 // drop the operator-only draft note
  md = md.replace(/\[DATE\]/g, 'July 9, 2026')
         .replace(/\[HOST NAME\]/g, 'Daniel')
         .replace(/\[NAME — e\.g\.,[^\]]*\]/g, 'Google (Gmail)')             // the email service sub-processor
         .replace(/\[NAME\]/g, 'Daniel')
         .replace(/\[EMAIL\/PHONE\]/g, 'danieljcheer@gmail.com')
         .replace(/\[EMAIL\]/g, 'danieljcheer@gmail.com')
         .replace(/,?\s*\[PHONE — optional\]/g, '');                         // optional → omit (with any leading comma)
  return legalPage(d.title, mdToHtml(md));
}
for (const key of Object.keys(LEGAL_DOCS)) {
  app.get('/' + key, (req, res) => {
    const html = renderLegal(key);
    if (html) res.send(html); else res.status(404).type('text').send('Not found');
  });
}

// ---------- INVITE LINK (self-serve pre-approval) ----------
// An admin creates a token — optionally with name/phone already filled in, or
// totally blank. The player opens the link, fills in whatever's missing, and
// is created as approved (with whatever role the admin picked) — no vote, no
// waiting on the admin to type in their contact info by hand.
app.get('/invite/:token', (req, res) => {
  const iv = db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);
  if (!iv) return res.send(invitePage({ invalid: true }));
  if (iv.used) return res.send(invitePage({ used: true }));
  res.send(invitePage({ token: iv.token, full_name: iv.full_name, phone: iv.phone, email: iv.email }));
});

app.post('/invite/:token', async (req, res) => {
  const iv = db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);
  if (!iv) return res.send(invitePage({ invalid: true }));
  if (iv.used) return res.send(invitePage({ used: true }));

  const full_name = (req.body.full_name || iv.full_name || '').trim();
  const phone = (req.body.phone || iv.phone || '').trim();
  const email = (req.body.email || iv.email || '').trim().toLowerCase();
  const waiverOk = req.body.waiver_ok ? 1 : 0;
  if (!full_name || !phone || !isValidEmail(email) || !waiverOk) {
    return res.send(invitePage({
      token: iv.token, full_name, phone, email,
      error: !waiverOk ? 'Please confirm the waiver to continue.' : 'Fill in your name, phone, and a valid email.',
    }));
  }

  // Ownership proof: a smooth instant-claim (auto sign-in) is ONLY granted when the
  // admin pre-filled an email on the invite AND the submitter kept/entered that exact
  // email. Anything else — no pre-filled email, or a submitted email that differs
  // (possibly matching a DIFFERENT existing player) — has NO proof the submitter owns
  // the address, so we never open a session as them. We still honor the invite
  // (approve + role, on the correct record) and email a one-tap sign-in link to the
  // submitted address to verify ownership before a session is established.
  const prefilled = (iv.email || '').trim().toLowerCase();
  const prefilledMatch = !!prefilled && prefilled === email;

  const isTeam = iv.role === 'team' ? 1 : 0;
  const isRegular = iv.role === 'regular' ? 1 : 0;
  const existing = applicantByEmail(email);
  if (existing) {
    if (prefilledMatch) {
      // Verified owner confirming their own pre-filled invite — safe to refresh
      // their name/phone from what they submitted. Persist the waiver they just attested
      // (the form requires the checkbox — see the !waiverOk reject above); a fresh-INSERT
      // claim already sets waiver_ok=1, and dropping it here left auto-seated team members
      // with no waiver on file.
      db.prepare('UPDATE applicants SET status=?, is_team=?, is_regular=?, full_name=?, phone=?, waiver_ok=1 WHERE email=?')
        .run('approved', isTeam, isRegular, full_name, phone, email);
    } else {
      // Unverified submitter (email doesn't match the invite's prefill → no ownership proof).
      // Only ever un-hold their status to approved; NEVER change roles here. Granting is_team/
      // is_regular would let anyone holding a role-carrying invite type a VICTIM's email and
      // promote that victim (e.g. into the Team voting pool) with no proof they own it. A real
      // role upgrade goes through the prefilled-match branch (verified) or /admin/people/edit.
      db.prepare("UPDATE applicants SET status = CASE WHEN status = 'rejected' THEN 'rejected' ELSE 'approved' END WHERE email = ?")
        .run(email);
    }
  } else if (prefilledMatch) {
    // Verified owner (admin pre-filled this exact email) — grant the role + waiver they attested.
    db.prepare(`INSERT INTO applicants (full_name,email,phone,experience,waiver_ok,status,is_team,is_regular)
                VALUES (?,?,?,?,1,'approved',?,?)`)
      .run(full_name, email, phone, 'Pre-approved (invite)', isTeam, isRegular);
  } else {
    // Unverified new email (submitter typed an address that doesn't match the invite's prefill) —
    // approve but grant NO role and NO waiver, matching the existing-row unverified branch above.
    // A role here would let a role-carrying invite seat a phantom team member (autoJoinTeam) for an
    // address the submitter never proved they own; an admin can grant the role later via edit.
    db.prepare(`INSERT INTO applicants (full_name,email,phone,experience,waiver_ok,status,is_team,is_regular)
                VALUES (?,?,?,?,0,'approved',0,0)`)
      .run(full_name, email, phone, 'Pre-approved (invite, unverified)');
  }
  db.prepare("UPDATE invites SET used = 1, used_at = datetime('now'), used_email = ? WHERE token = ?")
    .run(email, iv.token);
  // WIRING: a team invite creates an auto-renew team member — seat them on the
  // current run now (autoJoinTeam is rollover-gated in ensureWeek), so a claimed
  // team invite shows them seated the moment they land on check-in.
  if (isTeam) autoJoinTeam(nextRunDate());
  audit(iv.created_by, 'admin', `invite:claimed${iv.role ? ':' + iv.role : ''}${prefilledMatch ? '' : ':link'}`, `${full_name} <${email}>`);

  if (prefilledMatch) {
    // Pre-approved AND the address is proven (admin pre-filled it) — sign them in.
    setSession(res, email);
    return res.redirect('/runs');
  }

  // No ownership proof — send a one-tap sign-in link to the submitted email and
  // show a friendly "check your email" page. No session is set here.
  const { url: link, code } = createLoginLink(req, email);
  let devLink = '', devCode = '';
  if (emailConfigured) {
    setImmediate(() => {
      sendMagicLink(email, link, code).catch(err =>
        console.error(`[invite] sign-in link send FAILED for ${email}: ${err.message}`));
    });
  } else {
    try {
      const result = await sendMagicLink(email, link, code);
      if (result.dev) { devLink = link; devCode = code; }
    } catch (e) { console.error(`[invite] dev-mail send failed for ${email}: ${e.message}`); }
  }
  return res.send(invitePage({ checkEmail: true, email, devLink, devCode }));
});

// Post an announcement — admin or team. Shows to all approved players on check-in.
// Posting a new one archives the current live one (kept in history, not lost).
app.post('/announce', requireApprover, (req, res) => {
  const body = (req.body.body || '').trim().slice(0, 500);
  // Double-submit guard: a fast double-tap (the compose form isn't router-intercepted) would
  // otherwise insert two rows AND fire push + email twice (a real Gmail-quota hit). Skip a
  // repeat of the same body by the same author within 10s.
  const dup = body && db.prepare("SELECT 1 FROM announcements WHERE program_id = 1 AND body = ? AND author = ? AND at >= datetime('now','-10 seconds') LIMIT 1").get(body, req.userEmail);
  if (body && !dup) {
    db.prepare("UPDATE announcements SET archived = 1, archived_at = datetime('now') WHERE archived = 0 AND program_id = 1").run();
    db.prepare('INSERT INTO announcements (body,author) VALUES (?,?)').run(body, req.userEmail);
    audit(req.userEmail, req.actorRole, 'announce:post', body.slice(0, 60));

    // Push to every subscribed player (the app-native channel — always on, independent
    // of the email checkbox and the email opt-out). Excludes the poster.
    const me = req.userEmail.toLowerCase();
    setImmediate(() => sendPush(approvedEmails().filter(e => e.toLowerCase() !== me),
      { title: 'The Bridge Runs', body: body.slice(0, 140), url: '/checkin', tag: 'announce' }));

    // Optionally email every approved player who hasn't opted out of broadcast email.
    // Fired in the background so the redirect stays instant; failures are loud.
    if (req.body.email_everyone) {
      const author = req.userEmail;
      setImmediate(() => {
        try {
          const recipients = announcementRecipients();
          sendAnnouncement(recipients, body, author).catch(err =>
            console.error(`[announce] email send FAILED: ${err.message}`));
        } catch (err) {
          console.error(`[announce] email prep FAILED: ${err.message}`);
        }
      });
    }
  }
  res.redirect(req.body.from === 'admin' ? '/admin' : '/checkin');
});

// Clear the current announcement — admin or team. Archives it (keeps history) rather than deleting.
app.post('/announce/clear', requireApprover, (req, res) => {
  const active = latestAnnouncement();
  if (active) {
    db.prepare("UPDATE announcements SET archived = 1, archived_at = datetime('now') WHERE id = ?").run(active.id);
    audit(req.userEmail, req.actorRole, 'announce:clear', '');
  }
  res.redirect(req.body.from === 'admin' ? '/admin' : '/checkin');
});

// Mark the viewer's announcements as read — fired when the masthead bell panel opens
// (fetch, keep-alive). Any signed-in user can clear their own dot; lightly rate-limited
// (the panel-open is the only caller) to shrug off a rapid open/close loop. 204 = done.
app.post('/announcements/seen', requireLogin, (req, res) => {
  if (rateLimited('ann-seen', req.userEmail, 30, 60 * 1000)) return res.status(429).end();
  markAnnouncementsSeen(req.userEmail);
  res.status(204).end();
});

// Dismiss (swipe-to-clear) an announcement from the CALLER'S OWN panel — ANY signed-in
// viewer, NOT admin-gated. This is a PERSONAL hide: it records a per-user dismissal and
// never touches the `announcements` row, so the announcement stays live for everyone
// else. Idempotent (INSERT OR IGNORE); rate-limited to shrug off a rapid swipe loop. A
// fetch caller (X-Requested-With: fetch) gets 204; a no-JS form POST gets a 302 back.
app.post('/announcements/:id/dismiss', requireLogin, (req, res) => {
  if (rateLimited('ann-dismiss', req.userEmail, 60, 60 * 1000)) return res.status(429).end();
  const id = Number(req.params.id) || 0;
  // Only dismiss an announcement that EXISTS — the id is caller-supplied, and without this
  // the table takes an unbounded stream of junk ids (nothing prunes dismissals for
  // announcements that never existed).
  if (id && stmtAnnouncementExists.get(id)) {
    db.prepare('INSERT OR IGNORE INTO announcement_dismissals (email, announcement_id) VALUES (?, ?)')
      .run(req.userEmail.toLowerCase(), id);
  }
  const wantsJson = (req.headers['x-requested-with'] || '') === 'fetch';
  if (wantsJson) return res.status(204).end();
  // Bounce back to wherever they were, but only ever to a SAME-ORIGIN path — strip the
  // host/scheme off the Referer so a spoofed header can't funnel an off-site URL into the
  // redirect shim (the shim escapes it anyway, but keep this consistent with safeNextPath).
  let back = '/checkin';
  try { const u = new URL(req.get('referer')); back = (u.pathname || '/') + (u.search || ''); } catch {}
  res.redirect(back);
});

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

// Minimal status page for players who aren't approved (no check-in chrome).
app.get('/status', requireLogin, (req, res) => {
  const a = applicantByEmail(req.userEmail);
  const status = a?.status || 'none';
  if (isAdmin(req.userEmail) || status === 'approved') return res.redirect('/runs');
  res.send(statusPage({ email: req.userEmail, status }));
});

// One-time waiver gate — the join routes send a member here when waiver_ok is unset. They
// confirm they've signed, we flip waiver_ok, and they're returned to the run to check in.
app.get('/waiver', requireLogin, (req, res) => {
  const a = applicantByEmail(req.userEmail);
  const next = safeNextPath(req.query.next);
  if (a && a.waiver_ok) return res.redirect(next); // already signed → nothing to do
  res.send(waiverPage({ email: req.userEmail, next, err: req.query.err || '' }));
});
app.post('/waiver', requireLogin, (req, res) => {
  const a = applicantByEmail(req.userEmail);
  const next = safeNextPath(req.body.next);
  if (!a) return res.redirect('/status');
  if (!req.body.agree) return res.redirect('/waiver?next=' + encodeURIComponent(next) + '&err=' + encodeURIComponent('Please check the box to confirm you signed the waiver.'));
  db.prepare('UPDATE applicants SET waiver_ok = 1 WHERE email = ?').run(a.email);
  audit(req.userEmail, 'player', 'waiver:ack', '');
  res.redirect(next);
});

// ---------- CHECK-IN ----------
const stmtRunIsOpen = db.prepare('SELECT is_open FROM run_state WHERE run_date = ? AND program_id = 1');
function runIsOpen(runDate) {
  const row = stmtRunIsOpen.get(runDate); // hot path (every /checkin + /poll)
  return !!(row && row.is_open); // no row = never opened = closed
}
function setRunOpen(runDate, open) {
  db.prepare(`INSERT INTO run_state (run_date, is_open, program_id) VALUES (?, ?, 1)
              ON CONFLICT(run_date, program_id) DO UPDATE SET is_open = excluded.is_open`)
    .run(runDate, open ? 1 : 0);
}
// Run cancellation (per run_date). Cancelling closes the run too — a cancelled run can't
// be open for check-in. Un-cancelling leaves it CLOSED (the host re-opens deliberately).
const stmtRunCancelled = db.prepare('SELECT cancelled FROM run_state WHERE run_date = ? AND program_id = 1');
function runIsCancelled(runDate) {
  const row = stmtRunCancelled.get(runDate);
  return !!(row && row.cancelled);
}
function setRunCancelled(runDate, cancelled) {
  db.prepare(`INSERT INTO run_state (run_date, is_open, cancelled, program_id) VALUES (?, 0, ?, 1)
              ON CONFLICT(run_date, program_id) DO UPDATE SET cancelled = excluded.cancelled, is_open = CASE WHEN excluded.cancelled = 1 THEN 0 ELSE is_open END`)
    .run(runDate, cancelled ? 1 : 0);
}
// Roster LOCK: at run-day 2 PM the queue locks. Existing players can still drop and the
// waitlist still fills freed spots (offers/claims), but no NEW self-sign-ups — only a
// host/team +1. Time-derived (no state flag) so it auto-resets for next week's run.
function runIsLocked(runDate) {
  return Date.now() >= new Date(runDate + 'T14:00:00').getTime();
}

// Prepared once at startup (hot path), not per request.
const stmtRun = db.prepare(`
  SELECT c.*, COALESCE(a.status,'') AS pstatus,
         COALESCE(a.is_team,0) AS is_team, COALESCE(a.is_regular,0) AS is_regular,
         COALESCE(a.is_host,0) AS is_host, COALESCE(a.position,'') AS position,
         a.id AS applicant_id
  FROM checkins c LEFT JOIN applicants a ON a.email = c.email
  WHERE c.run_date = ? AND c.program_id = ? ORDER BY c.sort_order ASC, c.id ASC`);

// Archive the FINAL floor of past weeks into the permanent attendance log,
// right before loadRun() purges those checkins. "Final floor" = the first CAP
// rows by sort_order,id for each past run_date (waitlist rows, pos>CAP, are not
// credited). INSERT OR IGNORE + UNIQUE(run_date,email) makes it idempotent.
// `offered_at IS NULL` excludes a still-pending/unclaimed spot offer — a held offer that
// was never claimed must NOT earn an attendance credit (a claim clears offered_at, so
// claimed offerees ARE credited). Otherwise an offer that expired after rollover would
// permanently credit someone who never confirmed.
// Number ALL rows, then drop the offered ones — matching partitionRun, where a pending offer
// RESERVES its floor slot (floorCapForReal = CAP - offered.length). Filtering offered rows out
// BEFORE numbering (the old shape) collapses that reserved slot, so the first waitlister slides
// into it and earns a permanent attendance row for a run they spent on the bench. An unclaimed
// offer is still excluded from the insert — nobody played on it.
const stmtArchiveAttendance = db.prepare(`
  INSERT OR IGNORE INTO attendance (run_date, email, name)
  SELECT run_date, email, name FROM (
    SELECT run_date, email, name, offered_at,
           ROW_NUMBER() OVER (PARTITION BY run_date ORDER BY sort_order ASC, id ASC) AS pos
    FROM checkins WHERE run_date < ? AND program_id = 1
  ) WHERE pos <= ? AND offered_at IS NULL`);

// Hot-path lookups rendered on the check-in page (and reused by the join guard) —
// prepared once at module scope (node:sqlite has no statement cache).
const stmtOptedOut = db.prepare('SELECT 1 FROM regular_optout WHERE run_date = ? AND email = ? AND program_id = 1');
const stmtMyConfirmed = db.prepare('SELECT confirmed_at FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1'); // hoisted — hottest page
const stmtPreregCount = db.prepare(`SELECT COUNT(*) r FROM checkins c
    JOIN applicants ap ON ap.email = c.email
    WHERE c.run_date = ? AND c.program_id = 1 AND (ap.is_regular = 1 OR ap.is_team = 1)`);
const stmtHostCard = db.prepare("SELECT * FROM applicants WHERE is_host = 1 AND status = 'approved'");

// /poll fingerprint statements (P0-1) — read-only, hoisted. The poll route diffs a
// tiny fingerprint to decide when a page should re-fetch-and-patch (no full reload),
// and returns the live DM/group unread counts the client patches into tab badges.
const stmtPollChat = db.prepare('SELECT COALESCE(MAX(id),0) mx FROM group_messages WHERE program_id = 1'); // MAX on the PK is O(1); COUNT(*) was a full scan every poll tick
// A monotonic "chat structure changed" counter — bumped on delete/pin/unpin so those
// propagate to other clients' feeds without a COUNT(*) scan (deletes/pins don't move MAX(id)).
function bumpChatSeq() { setSetting('chat_seq', String((Number(getSetting('chat_seq')) || 0) + 1)); }
const stmtPollChatReact = db.prepare('SELECT COUNT(*) c, MAX(created_at) mx FROM group_reactions WHERE program_id = 1');
// Pickleball chat poll fingerprint (program 2 on the shared tables; own seq key in app_settings).
const stmtPollPkChat = db.prepare('SELECT COALESCE(MAX(id),0) mx FROM group_messages WHERE program_id = 2');
const stmtPollPkChatReact = db.prepare('SELECT COUNT(*) c, MAX(created_at) mx FROM group_reactions WHERE program_id = 2');
function bumpPkChatSeq() { setSetting('pk_chat_seq', String((Number(getSetting('pk_chat_seq')) || 0) + 1)); }
const stmtPollDM = db.prepare('SELECT MAX(id) mx, COUNT(*) c FROM messages WHERE from_email = ? OR to_email = ?');

// Held late-regulars are released onto the floor from 4pm on the RUN DAY onward — keyed
// to the actual run date so it stays correct when the host moves the run off Friday.
function heldReleased(runDate, d = new Date()) {
  if (process.env.FORCE_HELD_RELEASED === '1') return true; // test hook only
  return d.getTime() >= new Date(runDate + 'T16:00:00').getTime();
}

// Partition a run's check-ins into floor / offered-and-held / waitlist. Pure (no
// mutation, no side effects) so it's safe to call from drop handlers to decide who
// to offer BEFORE mutating. Ordering is the canonical sort_order,id from stmtRun.
//
//   HELD-SPOT ACCOUNTING: a waitlister with a pending offer (offered_at set) is NOT
//   a real floor player — but the spot is HELD for them: each pending offer consumes
//   one floor slot, so real players only fill (CAP − offered.length) slots and the
//   overflow stays on the waitlist. going/full therefore count real + held = taken.
//   Clearing the offer (on claim) drops offered.length by one, freeing the real slot
//   for that same person, so they slide onto the floor positionally with no overfill.
// Partition an OFFER-WINDOW run (basketball, and volleyball later) reading P(id).config for the
// caps + a program-scoped roster query. partitionRun keeps the program-1 (basketball) entry so its
// ~15 call sites are untouched; a future offer-window program partitions through the SAME code by
// passing its id — this is the reusable half of the engine (pickleball uses simplePartition).
function offerPartition(programId, runDate) {
  const cfg = P(programId).config;
  const rows = stmtRun.all(runDate, programId).map(r => ({
    ...r, tryout: r.pstatus === 'tryout', team: !!r.is_team, regular: !!r.is_regular,
    host: !!r.is_host,
    guest: /@guest\.local$/.test(r.email),
  }));
  const released = heldReleased(runDate);
  // Before Friday 4pm, held late-regulars are kept off the floor (waitlisted)
  // even if spots are open — those spots stay reserved for normals. After 4pm
  // they're treated like everyone else and can fill any remaining floor spots.
  const active = released ? rows : rows.filter(r => !r.held);
  const heldLate = released ? [] : rows.filter(r => r.held);
  const offered = active.filter(r => r.offered_at != null);   // held pending-claim spots
  const nonOffered = active.filter(r => r.offered_at == null);
  const floorCapForReal = Math.max(0, cfg.cap - offered.length);  // held spots reserve floor slots
  const floorReal = nonOffered.slice(0, floorCapForReal);
  const overflow = nonOffered.slice(floorCapForReal);
  const waitPlayers = [...overflow, ...heldLate].slice(0, cfg.waitlist);
  return { rows, active, offered, floorReal, overflow, heldLate, waitPlayers };
}
function partitionRun(runDate) { return offerPartition(1, runDate); }

// True if `email` currently occupies a floor slot (a real floor player OR a held
// offer) — i.e. removing them frees a floor slot that should be offered onward.
function occupiesFloorSlot(part, email) {
  return part.floorReal.some(p => p.email === email) || part.offered.some(p => p.email === email);
}

// The top waitlister eligible for an offer: first overflow player who has a real
// inbox (not a guest placeholder), isn't already offered, and isn't a pre-4pm
// held late-regular. Returns null if nobody's eligible.
function topOfferee(part, exclude = null) {
  return part.waitPlayers.find(p =>
    !p.guest && p.offered_at == null && !p.held && p.email !== exclude) || null;
}

// Mark a waitlister's freed floor spot as OFFERED + HELD: stamp offered_at/claim_token
// and email them a one-tap claim link. The `offered_at IS NULL` guard makes this
// idempotent and race-safe (a second concurrent trigger can't double-offer/double-email).
function createOffer(runDate, w, req, programId = 1) {
  const token = crypto.randomBytes(24).toString('base64url');
  const info = db.prepare(
    'UPDATE checkins SET offered_at = ?, claim_token = ? WHERE run_date = ? AND email = ? AND program_id = ? AND offered_at IS NULL')
    .run(Date.now(), token, runDate, w.email, programId);
  if (info.changes === 0) return; // already offered — don't email twice
  const base = process.env.PUBLIC_URL || (req ? `${req.protocol}://${req.get('host')}` : `http://localhost:${PORT}`);
  const link = `${base}${P(programId).paths.run}/claim/${token}`;
  audit('system', 'system', 'offer:send', w.email);
  // Don't block the response on the send (mirrors the magic-link / announce sends).
  // Spot offers are time-critical, so they always go by BOTH email (transactional —
  // ignores the email opt-out) AND push. Both point players at /checkin to claim.
  setImmediate(() => {
    sendSpotOffer(w.email, w.name, runLabelFor(runDate), link, OFFER_WINDOW_HOURS, runWeekday(runDate))
      .catch(err => console.error(`[offer] send FAILED for ${w.email}: ${err.message}`));
    sendPush([w.email], {
      title: 'A floor spot opened up',
      body: `Claim your spot for ${runLabelFor(runDate)} — expires in ${OFFER_WINDOW_HOURS}h.`,
      url: P(programId).paths.run, tag: 'offer',
    });
  });
}

// A floor occupant is leaving `runDate` — if they held a floor slot AND an eligible
// waitlister exists, OFFER that freed slot to the top waitlister (offer-and-confirm
// instead of silent auto-promotion). Call BEFORE deleting so the partition still
// sees the true waitlist order (otherwise the top waitlister would auto-promote into
// the floor slice and we'd offer the wrong person). Returns the offeree (or null);
// the caller deletes the leaver, then passes the offeree to createOffer.
function offereeForFloorLeave(runDate, leavingEmail, programId = 1) {
  const part = offerPartition(programId, runDate);
  if (!occupiesFloorSlot(part, leavingEmail)) return null;
  return topOfferee(part, leavingEmail);
}

// Lazy expiry (no cron): any pending offer past its window is EXPIRED — the person
// dropped from the waitlist (they didn't claim), their held spot freed, and the next
// eligible waitlister offered in their place. Idempotent; safe every request. Run
// this BEFORE computing who to offer/display so a stale hold never blocks the floor.
const stmtExpiredOffers = db.prepare(  // hoisted — runs on every /checkin + /runs GET and the 60s tick
  'SELECT * FROM checkins WHERE run_date = ? AND program_id = ? AND offered_at IS NOT NULL AND offered_at < ?');
function expireAndReoffer(runDate, req, programId = 1) {
  const cutoff = Date.now() - OFFER_WINDOW_MS;
  const expired = stmtExpiredOffers.all(runDate, programId, cutoff);
  for (const ex of expired) {
    // Capture the next offeree BEFORE dropping the expired hold, so the freed slot
    // offers the true top waitlister rather than one auto-promoted by the drop.
    const part = offerPartition(programId, runDate);
    const offeree = topOfferee(part, ex.email);
    db.prepare('DELETE FROM checkins WHERE id = ?').run(ex.id);
    audit('system', 'system', 'offer:expire', ex.email);
    if (offeree) createOffer(runDate, offeree, req, programId);
  }
}

// Weekly rollover work — archive last week's final floor into the permanent
// attendance log, purge the now-stale check-ins/opt-outs, and re-seat auto-renew
// team. GATED to fire only when the run_date actually changes (the Saturday-midnight
// rollover) via module-level lastRunDate, plus once at startup and from the 60s
// interval. Previously this ran on EVERY /checkin GET (every ~20s per phone),
// keeping the WAL permanently hot for work that is genuinely week-scoped.
const stmtPurgeCheckins = db.prepare('DELETE FROM checkins WHERE run_date < ? AND program_id = 1');
const stmtPurgeOptouts = db.prepare('DELETE FROM regular_optout WHERE run_date < ? AND program_id = 1');
const stmtPurgeRunState = db.prepare('DELETE FROM run_state WHERE run_date < ? AND program_id = 1');
// Prune a spent override only when BOTH its run_date AND its base Friday are past. The
// base-Friday guard is essential for a run moved EARLIER (e.g. Fri→Thu): after the Thu
// run passes but while its Friday is still today/upcoming, the override must be RETAINED
// so nextRunDate() keeps resolving that Friday to the (now-past, excluded) Thursday and
// falls through to next Friday — pruning on run_date alone would resurrect the Friday.
const stmtPurgeSpentOverrides = db.prepare('DELETE FROM run_overrides WHERE run_date < ? AND default_date < ?');
// Rollover is keyed off the ACTUAL upcoming run date (cur = nextRunDate()), NOT a fixed
// Friday. lastRunDate stores that actual date; the rollover fires exactly when cur
// advances — i.e. when the previous run has passed and a later one becomes soonest. This
// is correct whether the run was moved EARLIER or LATER than its Friday: e.g. a run moved
// to Saturday keeps cur on that Saturday through the run day and only advances the day
// AFTER, so the archive/purge fires after the run has happened, never during it.
//
// Why this cannot purge today's/current run: the purge cutoff is `run_date < cur`, and
// cur is the SOONEST run on-or-after today, so no run_date lies in [today, cur) — every
// current-or-future run is ≥ cur and is preserved; only strictly-past runs are purged.
// Why it cannot double-archive: attendance archiving is INSERT OR IGNORE on
// UNIQUE(run_date,email), and the whole body is gated to fire once per cur transition.
let lastRunDate = null;
function ensureWeek(runDate = nextRunDate()) {
  if (runDate === lastRunDate) return; // no-op until the soonest run date advances (rollover)
  // Archive/purge cutoff = TODAY, never `runDate` (cur). cur is the soonest UPCOMING run and is
  // always ≥ today; under normal weekly rollover today and cur select the same past runs. But if
  // cur JUMPS FORWARD past a future run that still has check-ins (e.g. a season-start gate is set,
  // or a run is moved weeks out), a cur-based cutoff would archive that FUTURE run's roster as
  // attendance and purge it — corrupting the season board + losing the roster. Cutting off at
  // today archives only runs that have actually ended.
  const t = ymdLocal();
  stmtArchiveAttendance.run(t, CAP);  // archive the final floor of every run that has ended
  stmtPurgeCheckins.run(t);           // then purge those now-past runs' checkins…
  stmtPurgeOptouts.run(t);            // …opt-outs…
  stmtPurgeRunState.run(t);           // …and stale open/closed state
  stmtPurgeSpentOverrides.run(t, t);  // drop fully-past overrides
  autoJoinTeam(runDate);              // re-seat auto-renew team onto the new run
  lastRunDate = runDate;
}

function loadRun(req) {
  const runDate = nextRunDate();
  ensureWeek(runDate); // rollover-gated archive/purge/auto-seat (no-op until the run date advances)
  // Offer expiry stays LAZY here (idle cost = one ≤20-row SELECT) so a stale hold
  // never blocks the floor on a real view; the 60s interval covers zero-viewer windows.
  expireAndReoffer(runDate, req);
  const part = partitionRun(runDate);
  return {
    runDate,
    inPlayers: part.floorReal,        // real, confirmed floor players
    offeredPlayers: part.offered,     // held pending-claim spots (count as taken, not "on the floor")
    waitPlayers: part.waitPlayers,
    totalCount: part.rows.length,
  };
}

// Shared gate for the player-facing pages (/checkin, /roster, /u/:id, /profile):
// only approved players (and admins, who run the check-in) get in; everyone else
// is bounced to their status page. Returns { a, viewerIsAdmin } or null (after
// redirecting). Identical behavior to the old inlined /checkin gate.
function requirePlayer(req, res) {
  const email = req.userEmail;
  const a = applicantByEmail(email);
  const viewerIsAdmin = isAdmin(email);
  const status = a?.status || 'none';
  if (!viewerIsAdmin && status !== 'approved') { res.redirect('/status'); return null; }
  return { a, viewerIsAdmin };
}

// A suspended player keeps their account + history but is muted: no check-in (blocked in
// /checkin/join) and no posting to chat/DMs. Callers use `if (mutedOut(gate, res, ...)) return;`
// AFTER the requirePlayer gate. JSON endpoints (voice/video) get a 403; form posts bounce
// back with ?err=suspended so the existing error strip explains it.
function mutedOut(gate, res, { json = false, back = '/chat' } = {}) {
  if (!gate || !gate.a || !gate.a.suspended) return false;
  if (json) res.status(403).json({ err: 'suspended' });
  else res.redirect(back + (back.includes('?') ? '&' : '?') + 'err=suspended');
  return true;
}

// Runs hub — the launcher that lists every run the viewer can join, then hands off to
// that run's own check-in page. Basketball is always listed; Pickleball appears for
// admins always and for members only once it's published (active) — preserving the
// hidden-until-live behaviour. Read-only aside from the no-op week rolls.
app.get('/runs', requireLogin, (req, res) => {
  const email = req.userEmail;
  // Any signed-in member can SEE the hub — non-approved viewers get an apply prompt on
  // tap (handled in the view) instead of being bounced away, so they can find the runs.
  const a = applicantByEmail(email);
  const viewerIsAdmin = isAdmin(email);
  const status = a?.status || 'none';
  const canJoin = viewerIsAdmin || status === 'approved';
  const runs = [];
  // Every registered run, in id order: live ones are always listed; a hidden run (not yet
  // published) shows to admins only, with a lock badge. Each card's dynamic fields come from
  // that program's own dispatch (basketball / pickleball engine today) — no hardcoded pushes.
  for (const p of PROGRAMS.values()) {
    if (!p.active() && !viewerIsAdmin) continue;
    runs.push({ key: p.key, emoji: p.emoji, name: p.displayName, href: p.paths.run, ...p.hubCard(req) });
  }

  const chatProgram = runCookie(req);
  const cc = chatCountsFor(chatProgram, email, a ? a.id : 0);
  res.send(runsPage({
    email, runs, canJoin, status,
    isAdmin: viewerIsAdmin,
    canOperate: viewerIsAdmin || !!(a && a.is_team),
    dmUnread: unreadCount(email),
    groupUnread: cc.group,
    groupMention: cc.gm,
    chatProgram,
    ann: annPanel(email),
  }));
});

// Run-day control payload for the check-in Operator-tools card — HOST or ADMIN only
// (team members can't move the run). Null for everyone else. Moved off the profile.
function runDayFor(req, gate) {
  const canSetRunDay = gate.viewerIsAdmin || !!(gate.a && gate.a.is_host);
  if (!canSetRunDay) return null;
  const rdRunDate = nextRunDate();
  const rdBase = runBaseFor(rdRunDate); // the default day THIS run is keyed under (survives far moves)
  const rdTimes = runTimesFor(rdRunDate);
  const today = ymdLocal();
  const opener = seasonStart();
  const preseason = !!opener && today < opener;   // season set + hasn't started → no live weekly run yet
  return {
    runDate: rdRunDate, weekday: runWeekday(rdRunDate), label: runLabelFor(rdRunDate),
    isOverride: !!runOverrideRow(rdBase), dateMoved: rdRunDate !== rdBase,
    start: rdTimes.start, end: rdTimes.end, timeLabel: runTimeRange(rdRunDate),
    defaultDate: rdBase, defaultLabel: runLabelFor(rdBase),
    today, maxDate: shiftYmd(today, 30), cancelled: runIsCancelled(rdRunDate),
    // Season opener (the season-start gate): before it, only the season control shows.
    season: opener || '', seasonWeekday: opener ? runWeekday(opener) : '', seasonLabel: opener ? runLabelFor(opener) : '',
    preseason, seasonMax: shiftYmd(today, 365),
  };
}
app.get('/checkin', requireLogin, (req, res) => {
  const email = req.userEmail;
  const gate = requirePlayer(req, res);
  if (!gate) return;
  setRunCookie(req, res, 1); // opening basketball → the neutral pages' Chat tab points at basketball
  const { a, viewerIsAdmin } = gate;
  const status = a?.status || 'none';
  const { runDate, inPlayers, offeredPlayers, waitPlayers, totalCount } = loadRun(req);

  // A held offer counts as a taken floor slot (real players + pending offers = going).
  const going = inPlayers.length + offeredPlayers.length;
  const myOfferedRow = offeredPlayers.find(p => p.email === email);
  let myState = 'out';
  if (inPlayers.some(p => p.email === email)) myState = 'in';
  else if (myOfferedRow) myState = 'offered';
  else if (waitPlayers.some(p => p.email === email)) myState = 'waitlist';
  const myWaitPos = myState === 'waitlist'
    ? waitPlayers.findIndex(p => p.email === email) + 1 : 0;
  // The current player's pending offer (for the claim banner + button), if any.
  const myOffer = myOfferedRow
    ? { token: myOfferedRow.claim_token, expiresAt: (myOfferedRow.offered_at || 0) + OFFER_WINDOW_MS }
    : null;

  const iAmTeam = !!(a && a.is_team);
  const iAmRegular = !!(a && a.is_regular);
  const iAutoRenew = !!(a && a.auto_renew);
  const canOperate = viewerIsAdmin || iAmTeam;
  const iOptedOut = !!stmtOptedOut.get(runDate, email);
  const isOpen = runIsOpen(runDate);
  const canSeeCount = isOpen || canOperate || iAmRegular;
  const canSeeRoster = canOperate || iAmRegular || isOpen;
  // pre-registration cap reached (team + regulars) — only relevant while closed
  const preregCount = stmtPreregCount.get(runDate).r;
  const regularSlotsFull = !isOpen && iAmRegular && !iAmTeam && preregCount >= PREREG_CAP && myState === 'out';
  const myConfirmed = myState === 'in' && !!(stmtMyConfirmed.get(runDate, email)?.confirmed_at);

  res.send(checkinPage({
    email, status,
    runLabel: runLabelFor(runDate), runDate,
    hours: runTimeRange(runDate),
    startLabel: runStartLabel(runDate),
    // When check-in actually auto-opens, derived from the schedule — the copy used to hardcode
    // "Wednesday night" + "opens it manually", both wrong since the move to a Wednesday run.
    openDay: runWeekday(openDateFor(runDate)),
    openTime: fmtClockLabel(`${OPEN_H}:00`),
    tipoff: runStartEpoch(runDate),
    cap: CAP, waitlistCap: WAITLIST_CAP,
    going,
    waiting: waitPlayers.length,
    full: going >= CAP,
    runFull: totalCount >= TOTAL_CAP,
    isOpen, canSeeCount,
    regularSlotsFull,
    myState, myWaitPos, myOffer, offerWindowHours: OFFER_WINDOW_HOURS,
    iAmTeam, iAmRegular, iOptedOut, iAutoRenew,
    viewerIsAdmin, canOperate, canSeeRoster,
    suspended: !!(a && a.suspended), suspendReason: (a && a.suspend_reason) || '',
    myConfirmed, msg: req.query.msg || '', bannerVer: bannerVersion(),
    cancelled: runIsCancelled(runDate),
    locked: runIsLocked(runDate),
    announcement: latestAnnouncement(),
    // roster goes to anyone who can see it; controls only to operators
    inPlayers: canSeeRoster ? inPlayers : [],
    offeredPlayers: canSeeRoster ? offeredPlayers : [],
    waitPlayers: canSeeRoster ? waitPlayers : [],
    // the current host (if one is set) → "Meet your host" card
    host: stmtHostCard.get() || null,
    // Operator run-day + cancel controls (HOST/ADMIN only) — moved here from the profile.
    runDay: runDayFor(req, gate),
    rdMsg: req.query.rdset ? String(req.query.rdset) : (req.query.rderr || ''),
    dmUnread: unreadCount(email),
    groupUnread: groupUnread(email),
    groupMention: groupMentionUnread(email, a ? a.id : 0),
    ann: annPanel(email),
  }));
});

// ---------- POLL (read-only fingerprint for the surgical poll-and-patch clients) ----------
// A tiny JSON heartbeat the check-in / chat / profile pages hit every 10s to decide
// whether to re-fetch-and-patch a region, instead of a full-page reload. It does
// ZERO writes: never marks-read, never expires offers, and calls only the no-op
// ensureWeek() (which writes only when the run date advances). Mark-read stays on the
// real page GETs; offer-expiry stays on loadRun + the 60s interval.
app.get('/poll', requireLogin, (req, res) => {
  const email = req.userEmail;
  const page = req.query.page;
  let f = '';
  if (page === 'checkin') {
    const runDate = nextRunDate();
    ensureWeek(runDate); // no-op until the run date advances; deliberately NO expireAndReoffer (that writes)
    const part = partitionRun(runDate);
    // Canonical sort order + per-row offered(o)/held(h) flags → catches join, leave,
    // promote/reorder at equal counts, offer-sent, and hold-state changes. Plus the
    // held-release boundary, the live announcement id, and the cancelled flag — cancelling
    // a CLOSED, empty run changes nothing else in here (is_open stays 0, the roster delete
    // is a no-op), so without `cancelled` open clients never swap in the "Run cancelled"
    // banner. Pickleball's fingerprint already carries it.
    const order = part.rows.map(r => `${r.id}${r.offered_at != null ? 'o' : ''}${r.held ? 'h' : ''}${r.confirmed_at ? 'c' : ''}`).join(',');
    const ann = latestAnnouncement();
    f = `${runDate}:${runIsOpen(runDate) ? 1 : 0}:${runIsCancelled(runDate) ? 1 : 0}:${heldReleased(runDate) ? 1 : 0}:${order}:${ann ? ann.id : 0}`;
  } else if (page === 'chat') {
    const g = stmtPollChat.get(), rx = stmtPollChatReact.get();
    f = `${g.mx || 0}:${getSetting('chat_seq') || 0}:${rx.c || 0}:${rx.mx || ''}`;
  } else if (page === 'pkchat') {
    const g = stmtPollPkChat.get(), rx = stmtPollPkChatReact.get();
    f = `${g.mx || 0}:${getSetting('pk_chat_seq') || 0}:${rx.c || 0}:${rx.mx || ''}`;
  } else if (page === 'pickleball') {
    const rd = pkRunDate(), part = pkPartition(rd);
    const order = part.rows.map(r => `${r.id}${r.confirmed_at ? 'c' : ''}`).join(',');
    const a = latestPkAnnouncement();
    f = `${rd}:${pkIsOpen(rd) ? 1 : 0}:${pkIsCancelled(rd) ? 1 : 0}:${order}:${a ? a.id : 0}`;
  } else if (page === 'profile') {
    const m = stmtPollDM.get(email, email);
    f = `${m.mx || 0}:${m.c || 0}`;
  }
  const aid = applicantIdOf(email);
  // Program-keyed chat unread map: the client reads data-chat-program off the Chat tab / hero
  // and looks up its counts here, so the badges work for any number of runs. Only LIVE programs
  // contribute (a hidden run shows no badge — matches the old pkOn gate). The old scalar fields
  // (group/gm/pkgroup/pkgm) are DUAL-EMITTED for one release so a stale cached client keeps
  // working until its next 10s poll force-reloads it on the BUILD_VER bump.
  const chats = {};
  for (const p of PROGRAMS.values()) { if (!p.active()) continue; const u = p.unread(email, aid); chats[p.id] = { u: u.group, m: u.gm }; }
  const c1 = chats[1] || { u: 0, m: 0 }, c2 = chats[2] || { u: 0, m: 0 };
  res.json({ f, dm: unreadCount(email), chats,
    group: c1.u, gm: c1.m, pkgroup: c2.u, pkgm: c2.m,          // legacy — dual-emit for stale clients (drop next release)
    ann: announcementUnread(email) ? 1 : 0, v: BUILD_VER });
});

// ---------- ROSTER (removed) ----------
// The dedicated Roster tab/page is gone: the full floor list now lives in the
// who's-going overlay on /checkin (with operator remove/bump controls), and the
// Run Chat is its own /chat tab. Old bookmarks/links land on check-in.
app.get('/roster', requireLogin, (req, res) => res.redirect('/checkin'));

// ---------- PROFILE (view another player) ----------
// Compact profile card fragment for the who's-going quick-look popup (fetched by pvOpen).
app.get('/u/:id/card', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  const p = db.prepare('SELECT * FROM applicants WHERE id = ?').get(Number(req.params.id) || 0);
  if (!p || (p.status !== 'approved' && !gate.viewerIsAdmin)) return res.status(404).send('');
  const canContact = gate.viewerIsAdmin || !!(gate.a && gate.a.is_team);
  res.send(profileCard({ p, stats: attendanceStats(p.email), canContact, isSelf: p.email === req.userEmail }));
});

app.get('/u/:id', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  const p = db.prepare('SELECT * FROM applicants WHERE id = ?').get(Number(req.params.id) || 0);
  if (!p || (p.status !== 'approved' && !gate.viewerIsAdmin)) return res.redirect('/checkin');
  // OWNER RULE: operators (admin/team) see full name + phone; regular players don't.
  const canContact = gate.viewerIsAdmin || !!(gate.a && gate.a.is_team);
  res.send(profilePage({
    p, stats: attendanceStats(p.email), isSelf: p.email === req.userEmail, canContact,
    runDate: nextRunDate(),
    hours: runTimeRange(nextRunDate()),
    back: P(runCookie(req)).paths.chat, // Back returns to the run you came from (its own chat room)
    dmUnread: unreadCount(req.userEmail), groupUnread: groupUnread(req.userEmail),
    groupMention: groupMentionUnread(req.userEmail, gate.a ? gate.a.id : 0),
    ann: annPanel(req.userEmail),
  }));
});

// ---------- PROFILE (own editable tab) ----------
const POSITIONS = ['', 'PG', 'SG', 'SF', 'PF', 'C'];
app.get('/profile', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  const a = gate.a;
  if (!a) return res.redirect('/status'); // admins with no applicant row have nothing to edit
  // Operator announcement history lives here now (moved off the check-in page).
  const canOperate = gate.viewerIsAdmin || !!a.is_team;
  // Host DM inbox lives on the host's own profile tab now (no Messages tab). Only
  // the host loads/sees it; players get no inbox here.
  const iAmHost = !!a.is_host;
  // Run-day + Cancel-run controls now live on the check-in page's Operator-tools card
  // (moved off the profile), so nothing run-day-related is computed here anymore.
  // Photo upload/remove outcome → view notice. ok/removed = success; err:<code> maps
  // to a friendly message in the view. Codes come from the /profile/photo route below.
  const photoMsg = req.query.photo ? String(req.query.photo)
    : (req.query.photoerr ? 'err:' + String(req.query.photoerr) : '');
  const chatProgram = runCookie(req);
  const cc = chatCountsFor(chatProgram, a.email, a.id);
  res.send(profileTabPage({ a, stats: attendanceStats(a.email), saved: req.query.saved === '1', error: '',
    dmUnread: unreadCount(a.email), groupUnread: cc.group, groupMention: cc.gm, chatProgram, canOperate, announcementLog: canOperate ? announcementHistory() : [],
    iAmHost, threads: loadInbox(a.email), photoMsg, ann: annPanel(a.email) }));
});

// ---------- PROFILE PHOTO (upload / remove) ----------
// Tap the avatar → Photos picker → auto-submits here. multer buffers the file in
// memory (10 MB cap); we sniff MAGIC BYTES (not the client MIME/extension), then
// sharp square-cover-crops to 512×512, applies EXIF orientation, STRIPS metadata,
// and re-encodes to ~80% JPEG (≈40–90 KB). Stored under a SERVER-derived name
// (<id>-<hex>.jpg) — the user's filename never touches disk, so no path traversal.
// The previous file is deleted on replace. Rate-limited via the shared limiter.
app.post('/profile/photo', requireLogin, (req, res) => {
  uploadAvatar(req, res, async (err) => {
    const a = applicantByEmail(req.userEmail);
    if (!a) return res.redirect('/status');
    if (rateLimited('avatar', req.userEmail, 10, 10 * 60 * 1000))
      return res.redirect('/profile?photoerr=slow');
    if (err) {
      const code = (err && err.code === 'LIMIT_FILE_SIZE') ? 'big' : 'bad';
      return res.redirect('/profile?photoerr=' + code);
    }
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.redirect('/profile?photoerr=none');
    if (!sniffImage(file.buffer)) return res.redirect('/profile?photoerr=type'); // magic-byte gate
    try {
      const out = await sharp(file.buffer, { failOn: 'error' })
        .rotate()                                        // bake EXIF orientation in…
        .resize(512, 512, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 80, mozjpeg: true })            // …then re-encode (metadata stripped by default)
        .toBuffer();
      const fname = `${a.id}-${crypto.randomBytes(6).toString('hex')}.jpg`;
      await fs.promises.writeFile(path.join(AVATARS_DIR, fname), out); // async write off the event loop
      // Re-read the CURRENT avatar right before the swap (post-await): `a` was fetched before the
      // sharp/writeFile awaits, so two concurrent uploads would both see the original and both
      // delete IT — orphaning the first upload's file. Reading it here chains the unlink to
      // whatever was current when this upload takes over.
      const prev = db.prepare('SELECT avatar FROM applicants WHERE id = ?').get(a.id)?.avatar;
      db.prepare('UPDATE applicants SET avatar = ? WHERE id = ?').run(fname, a.id);
      if (prev && prev !== fname) safeUnlinkAvatar(prev); // drop the old file on replace
      refreshAvatarMap();
      audit(req.userEmail, 'player', 'profile:photo', a.email);
      return res.redirect('/profile?photo=ok');
    } catch (e) {
      console.error(`[avatar] process failed for ${a.email}: ${e.message}`);
      return res.redirect('/profile?photoerr=proc');
    }
  });
});

// Revert to the initials disc: clear applicants.avatar + delete the file.
app.post('/profile/photo/remove', requireLogin, (req, res) => {
  const a = applicantByEmail(req.userEmail);
  if (!a) return res.redirect('/status');
  if (rateLimited('avatar', req.userEmail, 10, 10 * 60 * 1000)) return res.redirect('/profile?photoerr=slow');
  const prev = a.avatar;
  if (prev) {
    db.prepare('UPDATE applicants SET avatar = NULL WHERE id = ?').run(a.id);
    safeUnlinkAvatar(prev);
    refreshAvatarMap();
    audit(req.userEmail, 'player', 'profile:photo:remove', a.email);
  }
  res.redirect('/profile?photo=removed');
});

app.post('/profile', requireLogin, (req, res) => {
  const a = applicantByEmail(req.userEmail);
  if (!a) return res.redirect('/status');
  const full_name = (req.body.full_name || '').trim().slice(0, 60);
  const phone = (req.body.phone || '').trim().slice(0, 30);
  const email = (req.body.email || '').trim().toLowerCase();
  // position is now multi-select (checkboxes): array, single string, or absent
  let posInput = req.body.position || [];
  if (typeof posInput === 'string') posInput = [posInput];
  const position = [...new Set(posInput.filter(p => POSITIONS.includes(p) && p))].join(',');
  // Email opt-out — an unchecked checkbox doesn't POST, so absent = opted OUT.
  const email_optout = req.body.email_announce ? 0 : 1;
  const stats = attendanceStats(a.email);
  // Full prop set so a validation error re-renders the WHOLE profile tab (bell, host inbox,
  // run-day control, announcement history) — not a stripped-down page. Reused by every error branch.
  const iAmHost = !!a.is_host, canOperate = isAdmin(req.userEmail) || !!a.is_team;
  const errProps = {
    a, stats, dmUnread: unreadCount(a.email), groupUnread: groupUnread(a.email), groupMention: groupMentionUnread(a.email, a.id),
    canOperate, iAmHost, announcementLog: canOperate ? announcementHistory() : [], threads: loadInbox(a.email), ann: annPanel(a.email),
  };
  if (!full_name || !phone || !isValidEmail(email))
    return res.send(profileTabPage({ ...errProps, error: 'Name, phone, and a valid email are required.' }));
  if (email !== a.email && db.prepare('SELECT 1 FROM applicants WHERE email = ? AND id != ?').get(email, a.id))
    return res.send(profileTabPage({ ...errProps, error: 'That email is already in use by another player.' }));
  // Never let a self-service email change grant admin. Admin identity is the
  // ADMINS env set keyed by email, so changing INTO an admin address = takeover.
  if (email !== a.email && ADMINS.includes(email))
    return res.send(profileTabPage({ ...errProps, error: 'That email can’t be used. Pick another.' }));
  // The identity row and its rekey cascade commit together or not at all — committing the
  // applicants row first would leave every history row (checkins, votes, DMs, chat, push subs)
  // stranded on the old address if the cascade failed, orphaning the account.
  try {
    transact(() => {
      db.prepare('UPDATE applicants SET full_name=?, phone=?, email=?, position=?, email_optout=? WHERE id=?')
        .run(full_name, phone, email, position, email_optout, a.id);
      // Carry EVERY per-user row (checkins, attendance, votes, DMs, Run Chat, reads, push
      // subs, opt-outs…) onto the new address. rekeyEmailTx in db.js is the single source
      // of truth for the cascade.
      if (email !== a.email) rekeyEmailTx(a.email, email);
      // Name can change without the email changing — sync the denormalised name across the
      // person's check-in rows in every program (checkins is program-generic; one update covers all).
      db.prepare('UPDATE checkins SET name=? WHERE email=?').run(full_name, email);
    });
  } catch (e) {
    console.error(`[profile] identity edit FAILED for ${a.email}: ${e.message}`);
    return res.send(profileTabPage({ ...errProps, error: 'Couldn’t save that — your details are unchanged. Try again.' }));
  }
  audit(req.userEmail, 'player', 'profile:edit', email);
  if (email !== a.email) { setSession(res, email); refreshAvatarMap(); } // cookie IS the email — re-sign it; re-key the avatar map
  res.redirect('/profile?saved=1');
});

// ---------- MESSAGES (in-app, host <-> players) ----------
// Threads: requireLogin + requirePlayer + require an applicant row. Sender identity
// comes ONLY from req.userEmail — a body from_email is never trusted, so "message as
// someone else" is impossible.

// Inbox loader — grouped threads, newest first. One grouped query + two bulk lookups
// (counterparts, last-message snippets); no per-row queries. Consumed by the host's
// profile tab (the DM inbox lives there now — there is no standalone Messages tab).
function loadInbox(me) {
  const rows = db.prepare(`
    SELECT CASE WHEN from_email = ? THEN to_email ELSE from_email END AS other,
           MAX(id) AS last_id,
           SUM(CASE WHEN to_email = ? AND read_at IS NULL THEN 1 ELSE 0 END) AS unread
    FROM messages WHERE from_email = ? OR to_email = ?
    GROUP BY other ORDER BY last_id DESC`).all(me, me, me, me);
  if (!rows.length) return [];
  const others = rows.map(r => r.other);
  const ph = others.map(() => '?').join(',');
  const people = new Map();
  for (const a of db.prepare(
    `SELECT id, full_name, email, is_host, is_team, is_regular, status FROM applicants WHERE email IN (${ph})`).all(...others))
    people.set(a.email, a);
  const lastIds = rows.map(r => r.last_id);
  const ph2 = lastIds.map(() => '?').join(',');
  const snips = new Map();
  for (const m of db.prepare(`SELECT id, from_email, body, image, created_at FROM messages WHERE id IN (${ph2})`).all(...lastIds))
    snips.set(m.id, m);
  return rows.map(r => {
    const last = snips.get(r.last_id) || null;
    return { other: r.other, person: people.get(r.other) || null, unread: r.unread, last, fromMe: !!last && last.from_email === me };
  });
}

// The Messages tab is gone — host DMs live on the host's /profile. Old links land there.
app.get('/messages', requireLogin, (req, res) => res.redirect('/profile'));

// React — must precede POST /messages/:id so "react" is never captured as :id.
// Gate: sender must be a participant of the target message's pair. Identity from
// req.userEmail. Toggle off on re-tap of the same emoji; replace otherwise.
app.post('/messages/react', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  if (!gate.a) return res.redirect('/status');
  if (mutedOut(gate, res, { back: '/messages' })) return; // suspended = muted
  const me = req.userEmail;
  const messageId = Number(req.body.message_id) || 0;
  const msg = db.prepare('SELECT id, from_email, to_email FROM messages WHERE id = ?').get(messageId);
  if (!msg || (msg.from_email !== me && msg.to_email !== me)) return res.redirect('/messages');
  const other = msg.from_email === me ? msg.to_email : msg.from_email;
  const back = () => {
    const op = db.prepare('SELECT id FROM applicants WHERE email = ?').get(other);
    return res.redirect(op ? '/messages/' + op.id : '/messages');
  };
  const emoji = validEmoji(req.body.emoji);
  if (!emoji) return back();
  if (rateLimited('msg-react', me, 40, 10 * 60 * 1000)) return back();
  const existing = db.prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND from_email = ?').get(messageId, me);
  if (existing && existing.emoji === emoji) {
    db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND from_email = ?').run(messageId, me);
  } else {
    db.prepare(`INSERT INTO message_reactions (message_id, from_email, emoji) VALUES (?,?,?)
                ON CONFLICT(message_id, from_email) DO UPDATE SET emoji = excluded.emoji, created_at = datetime('now')`)
      .run(messageId, me, emoji);
  }
  return back();
});

// Thread — load counterpart, gate (canMessage OR pre-existing history, so a demoted
// host's past threads stay readable), mark-read (the ONLY read event; GET side-effect
// is intentional), then 3 bulk SELECTs → Maps (messages / reactions / reply parents).
app.get('/messages/:id', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  if (!gate.a) return res.redirect('/status');
  const me = req.userEmail, a = gate.a;
  const p = db.prepare('SELECT * FROM applicants WHERE id = ?').get(Number(req.params.id) || 0);
  if (!p) return res.redirect('/messages');
  const hasHistory = !!db.prepare(
    'SELECT 1 FROM messages WHERE (from_email=? AND to_email=?) OR (from_email=? AND to_email=?) LIMIT 1')
    .get(me, p.email, p.email, me);
  const canPost = canMessage(me, a, p);
  if (!canPost && !hasHistory) return res.redirect('/messages');
  db.prepare("UPDATE messages SET read_at = datetime('now') WHERE to_email = ? AND from_email = ? AND read_at IS NULL")
    .run(me, p.email);
  const msgs = db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages WHERE (from_email=? AND to_email=?) OR (from_email=? AND to_email=?)
      ORDER BY id DESC LIMIT 500
    ) ORDER BY id ASC`).all(me, p.email, p.email, me);
  const reactions = new Map();  // message_id -> [{emoji,count,mine}]
  const parents = new Map();    // parent id -> {from_email, body, image}
  if (msgs.length) {
    const ids = msgs.map(m => m.id);
    const ph = ids.map(() => '?').join(',');
    for (const r of db.prepare(`
      SELECT message_id, emoji, COUNT(*) AS cnt,
             SUM(CASE WHEN from_email = ? THEN 1 ELSE 0 END) AS mine
      FROM message_reactions WHERE message_id IN (${ph})
      GROUP BY message_id, emoji ORDER BY message_id, emoji`).all(me, ...ids)) {
      if (!reactions.has(r.message_id)) reactions.set(r.message_id, []);
      reactions.get(r.message_id).push({ emoji: r.emoji, count: r.cnt, mine: r.mine > 0 });
    }
    const replyIds = [...new Set(msgs.map(m => m.reply_to).filter(Boolean))];
    if (replyIds.length) {
      const ph3 = replyIds.map(() => '?').join(',');
      for (const pr of db.prepare(`SELECT id, from_email, body, image FROM messages WHERE id IN (${ph3})`).all(...replyIds))
        parents.set(pr.id, pr);
    }
  }
  res.send(threadPage({ me, p, msgs, reactions, parents, canPost, unread: unreadCount(me), err: req.query.err || '' }));
});

// Send — canMessage required (even a readable legacy thread can't be posted to once
// you no longer qualify). Accepts text, an OPTIONAL photo (multipart `image`), or a
// `sticker` name; body trimmed/capped; reply_to validated to this pair or dropped. A
// message may carry body, image, or both; neither → no-op. Same media pipeline as /chat.
app.post('/messages/:id', requireLogin, (req, res) => {
  uploadChatImage(req, res, async (err) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    if (!gate.a) return res.redirect('/status');
    if (mutedOut(gate, res, { back: '/messages/' + (Number(req.params.id) || 0) })) return; // suspended = muted
    const me = req.userEmail, a = gate.a;
    const p = db.prepare('SELECT * FROM applicants WHERE id = ?').get(Number(req.params.id) || 0);
    if (!p || !canMessage(me, a, p)) return res.redirect('/messages');
    const dest = '/messages/' + p.id;
    if (err) return res.redirect(dest + '?err=' + (err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad'));
    const body = (req.body.body || '').trim().slice(0, 1000);
    const file = req.file;
    const sticker = stickerPath(req.body.sticker);
    let replyTo = Number(req.body.reply_to) || 0;
    if (replyTo) {
      const par = db.prepare(
        'SELECT id FROM messages WHERE id = ? AND ((from_email=? AND to_email=?) OR (from_email=? AND to_email=?))')
        .get(replyTo, me, p.email, p.email, me);
      if (!par) replyTo = 0;
    }

    // Sticker send (no upload): image = validated sticker path, no body.
    if (sticker) {
      if (rateLimited('msg-media', me, 20, 10 * 60 * 1000)) return res.redirect(dest + '?err=slow');
      db.prepare('INSERT INTO messages (from_email, to_email, body, reply_to, image) VALUES (?,?,?,?,?)')
        .run(me, p.email, '', replyTo || null, sticker);
      notifyDM(a, p.email, 'Sticker 🏀');
      return res.redirect(dest);
    }
    // Photo send (optional caption): sniff → process → insert → write → set image.
    if (file && file.buffer && file.buffer.length) {
      if (rateLimited('msg-media', me, 15, 10 * 60 * 1000)) return res.redirect(dest + '?err=slow');
      if (!sniffImage(file.buffer)) return res.redirect(dest + '?err=type'); // magic-byte gate
      let msgId = 0;
      try {
        const jpeg = await processChatImage(file.buffer);                    // process BEFORE insert
        const info = db.prepare('INSERT INTO messages (from_email, to_email, body, reply_to) VALUES (?,?,?,?)')
          .run(me, p.email, body, replyTo || null);
        msgId = info.lastInsertRowid;
        const imgPath = await writeChatImage(jpeg, msgId);
        db.prepare('UPDATE messages SET image = ? WHERE id = ?').run(imgPath, msgId);
      } catch (e) {
        if (msgId) db.prepare('DELETE FROM messages WHERE id = ?').run(msgId); // no half-sent (caption-only) row
        console.error(`[dm] image process failed for ${me}: ${e.message}`);
        return res.redirect(dest + '?err=bad');
      }
      notifyDM(a, p.email, body ? '📷 ' + body : '📷 Photo');
      return res.redirect(dest);
    }
    // Text-only (unchanged): bounce a rate-limit notice rather than silently dropping.
    if (!body) return res.redirect(dest);
    if (rateLimited('msg-send', me, 20, 10 * 60 * 1000)) return res.redirect(dest + '?err=slow');
    db.prepare('INSERT INTO messages (from_email, to_email, body, reply_to) VALUES (?,?,?,?)')
      .run(me, p.email, body, replyTo || null);
    notifyDM(a, p.email, body);
    res.redirect(dest);
  });
});

// ---------- PLAYER SEARCH (Run Chat @-mention autocomplete) ----------
// Powers the @-mention dropdown in the Run Chat composer. Gated to approved players +
// admins (requirePlayer) and rate-limited. Searches ALL applicants by name (owner:
// "anyone in the database"), prefix matches ranked first, top 8. Returns esc-safe JSON
// [{id, name, avatar}] — name/avatar are data-only (client renders via textContent).
app.get('/players/search', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  if (rateLimited('players-search', req.userEmail, 40, 60 * 1000)) return res.status(429).json([]);
  const q = String(req.query.q || '').trim().slice(0, 60);
  // Escape LIKE wildcards so a literal % / _ / \ in the query can't widen the match.
  const like = q.replace(/[\\%_]/g, c => '\\' + c);
  const rows = db.prepare(`
    SELECT id, full_name, email, avatar FROM applicants
    WHERE full_name LIKE ? ESCAPE '\\'
    ORDER BY (CASE WHEN full_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END), full_name COLLATE NOCASE
    LIMIT 8`).all('%' + like + '%', like + '%');
  res.json(rows.map(r => ({ id: r.id, name: r.full_name, avatar: avatarUrlFor(r.email) || '' })));
});

// ---------- RUN CHAT (single shared room for ALL approved players) ----------
// Coexists with the 1:1 host DMs above — separate tables, separate routes. All
// four routes: requireLogin + requirePlayer (approved players + admins). Sender
// identity comes ONLY from req.userEmail; a body from_email is never trusted.

// The room — its own full page (the Chat tab). Last ~200 messages ASC in bulk +
// reactions map + reply-parent map + sender map (no N+1). Opening the room UPSERTs
// the viewer's read high-water mark (mark-read on GET), so the Chat tab badge reads
// 0 group-unread while you're here. The err flag (rate-limit notice) is carried in.
app.get('/chat', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  setRunCookie(req, res, 1); // reading basketball chat → neutral pages' Chat tab points back at basketball
  const { a, viewerIsAdmin } = gate;
  const me = req.userEmail;
  const chatData = loadGroupChat(me);
  const isMod = viewerIsAdmin || !!(a && a.is_host);
  const canPin = isMod || !!(a && a.is_team);   // team + admin/host can pin
  // A router PREWARM (pointerdown) must NOT clear unread — only a real landing does, via the
  // /chat/seen beacon. A normal full-page load (no prewarm header) still marks read here.
  if (req.headers['x-prewarm'] !== '1') markGroupRead(me);
  res.send(chatPage({
    me,
    chat: { me, ...chatData, isMod, canPin, err: req.query.err || '' },
    runDate: nextRunDate(),
    hours: runTimeRange(nextRunDate()),
    dmUnread: unreadCount(me),
    groupUnread: 0,   // just marked read
    groupMention: 0,  // mentions cleared on open too
    ann: annPanel(me),
  }));
});

// Mark Run Chat read — fired as a beacon by the client router when it actually LANDS on
// /chat (a router prewarm skips the mark-read so a mere pointerdown/scroll can't clear the
// unread badge). No body; requireLogin + player gate, then move the read high-water mark.
app.post('/chat/seen', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  markGroupRead(req.userEmail);
  res.status(204).end();
});

// Scroll-back: return an HTML fragment of the 200 messages older than ?before=<id>
// (the oldest message currently shown) for the client to PREPEND. Read-only — no
// mark-read side effect (you're browsing history, not catching up on the latest).
app.get('/chat/older', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  const { a, viewerIsAdmin } = gate;
  const me = req.userEmail;
  const before = parseInt(req.query.before, 10);
  if (!Number.isInteger(before) || before <= 0) return res.status(400).send('');
  const data = loadGroupChatOlder(me, before);
  const isMod = viewerIsAdmin || !!(a && a.is_host);
  const canPin = isMod || !!(a && a.is_team);
  res.send(chatOlderFragment({ me, ...data, isMod, canPin }));
});

// Send — text, an OPTIONAL photo (multipart `image`), or a `sticker` name. reply_to
// validated to a real group message or dropped. Identity from req.userEmail. A message
// may carry body, image, or both; neither → no-op. multer parses multipart; for a plain
// urlencoded/fetch text send it just calls through (req.file undefined).
app.post('/chat', requireLogin, (req, res) => {
  uploadChatImage(req, res, async (err) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    if (mutedOut(gate, res, { back: '/chat' })) return; // suspended = muted
    const me = req.userEmail;
    if (err) return res.redirect('/chat?err=' + (err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad'));
    const body = (req.body.body || '').trim().slice(0, 1000);
    const file = req.file;
    const sticker = stickerPath(req.body.sticker);
    let replyTo = Number(req.body.reply_to) || 0;
    if (replyTo && !db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = 1').get(replyTo)) replyTo = 0;
    // @-mentions: validate the hidden comma-separated ids against real applicants.
    // Only meaningful when there's a body to carry the "@Name" text (stickers have none).
    const mentions = body ? validMentions(req.body.mentions) : null;

    // Sticker send (no upload): image = validated sticker path, no body.
    if (sticker) {
      if (rateLimited('chat-media', me, 20, 10 * 60 * 1000)) return res.redirect('/chat?err=slow');
      db.prepare('INSERT INTO group_messages (from_email, body, reply_to, image) VALUES (?,?,?,?)')
        .run(me, '', replyTo || null, sticker);
      return res.redirect('/chat');
    }
    // Photo send (optional caption in body): sniff → process → insert → write → set image.
    if (file && file.buffer && file.buffer.length) {
      if (rateLimited('chat-media', me, 15, 10 * 60 * 1000)) return res.redirect('/chat?err=slow');
      if (!sniffImage(file.buffer)) return res.redirect('/chat?err=type'); // magic-byte gate
      let msgId = 0;
      try {
        const jpeg = await processChatImage(file.buffer);                  // process BEFORE insert
        const info = db.prepare('INSERT INTO group_messages (from_email, body, reply_to, mentions) VALUES (?,?,?,?)')
          .run(me, body, replyTo || null, mentions);
        msgId = info.lastInsertRowid;
        const imgPath = await writeChatImage(jpeg, msgId);
        db.prepare('UPDATE group_messages SET image = ? WHERE id = ?').run(imgPath, msgId);
        notifyMentions(me, body, mentions);
      } catch (e) {
        if (msgId) db.prepare('DELETE FROM group_messages WHERE id = ?').run(msgId); // no half-sent (caption-only) row
        console.error(`[chat] image process failed for ${me}: ${e.message}`);
        return res.redirect('/chat?err=bad');
      }
      return res.redirect('/chat');
    }
    // Text-only (unchanged): neither body, image, nor sticker → no-op insert.
    if (!body) return res.redirect('/chat');
    if (rateLimited('chat-send', me, 30, 10 * 60 * 1000)) return res.redirect('/chat?err=slow');
    db.prepare('INSERT INTO group_messages (from_email, body, reply_to, mentions) VALUES (?,?,?,?)')
      .run(me, body, replyTo || null, mentions);
    notifyMentions(me, body, mentions);
    res.redirect('/chat');
  });
});

// React — 6 tapbacks or a single validated free emoji (same rules as DMs). Toggle
// off on re-tap of the same emoji; replace otherwise, via the UNIQUE constraint.
app.post('/chat/react', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  if (mutedOut(gate, res, { back: '/chat' })) return; // suspended = muted
  const me = req.userEmail;
  const messageId = Number(req.body.message_id) || 0;
  if (!db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = 1').get(messageId)) return res.redirect('/chat');
  const emoji = validEmoji(req.body.emoji);
  if (!emoji) return res.redirect('/chat');
  if (rateLimited('chat-react', me, 40, 10 * 60 * 1000)) return res.redirect('/chat');
  const existing = db.prepare('SELECT emoji FROM group_reactions WHERE group_message_id = ? AND from_email = ?').get(messageId, me);
  if (existing && existing.emoji === emoji) {
    db.prepare('DELETE FROM group_reactions WHERE group_message_id = ? AND from_email = ?').run(messageId, me);
  } else {
    db.prepare(`INSERT INTO group_reactions (group_message_id, from_email, emoji) VALUES (?,?,?)
                ON CONFLICT(group_message_id, from_email) DO UPDATE SET emoji = excluded.emoji, created_at = datetime('now')`)
      .run(messageId, me, emoji);
  }
  res.redirect('/chat');
});

// Delete — host or admin may delete ANY message; a player may delete their OWN.
// Reactions cascade via the FK; the explicit delete makes it independent of the
// runtime pragma. A dangling reply_to on a child renders the graceful stub.
app.post('/chat/delete', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  const me = req.userEmail, a = gate.a;
  const messageId = Number(req.body.message_id) || 0;
  const msg = db.prepare('SELECT id, from_email, image, audio, video FROM group_messages WHERE id = ? AND program_id = 1').get(messageId);
  if (!msg) return res.redirect('/chat');
  const isMod = gate.viewerIsAdmin || !!(a && a.is_host);
  if (!isMod && msg.from_email !== me) return res.redirect('/chat');
  db.prepare('DELETE FROM group_reactions WHERE group_message_id = ?').run(messageId);
  db.prepare('DELETE FROM group_messages WHERE id = ?').run(messageId);
  bumpChatSeq(); // propagate the delete to other clients' poll (MAX(id) may not move)
  // Drop any stored media file (best-effort; stickers/external paths are a no-op).
  safeUnlinkChatImage(msg.image); safeUnlinkChatImage(msg.audio); safeUnlinkChatImage(msg.video);
  res.redirect('/chat');
});

// Pin / unpin a Run Chat message — team, host, or admin only. Toggles pinned_at.
app.post('/chat/pin', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  if (mutedOut(gate, res, { back: '/chat' })) return; // suspended = muted
  const a = gate.a;
  const canPin = gate.viewerIsAdmin || !!(a && (a.is_host || a.is_team));
  if (!canPin) return res.redirect('/chat');
  const messageId = Number(req.body.message_id) || 0;
  const msg = db.prepare('SELECT id, pinned_at FROM group_messages WHERE id = ? AND program_id = 1').get(messageId);
  if (!msg) return res.redirect('/chat');
  if (msg.pinned_at) db.prepare('UPDATE group_messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?').run(messageId);
  else db.prepare("UPDATE group_messages SET pinned_at = datetime('now'), pinned_by = ? WHERE id = ?").run(req.userEmail, messageId);
  bumpChatSeq(); // pin/unpin now propagates to other clients' feeds via the poll fingerprint (P2-10)
  res.redirect('/chat');
});

// Voice message — a recorded audio clip (multipart field `audio`, optional reply_to +
// dur). Always a fetch send (MediaRecorder blob), so this replies in JSON, not a
// redirect; the client refreshes the thread on success. multer buffers → sniffAudio
// magic-byte gate → store raw container → set audio/audio_dur on a new message.
app.post('/chat/voice', requireLogin, (req, res) => {
  uploadChatAudio(req, res, async (err) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    if (mutedOut(gate, res, { json: true })) return; // suspended = muted
    const me = req.userEmail;
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ err: err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad' });
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ err: 'empty' });
    const ext = sniffAudio(file.buffer);                          // magic-byte gate (never client MIME)
    if (!ext) return res.status(415).json({ err: 'type' });
    if (rateLimited('chat-media', me, 15, 10 * 60 * 1000)) return res.status(429).json({ err: 'slow' });
    let dur = Math.round(Number(req.body.dur) || 0);              // client-reported; cosmetic only
    if (!(dur > 0)) dur = 0;
    if (dur > 300) dur = 300;
    let replyTo = Number(req.body.reply_to) || 0;
    if (replyTo && !db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = 1').get(replyTo)) replyTo = 0;
    const info = db.prepare('INSERT INTO group_messages (from_email, body, reply_to) VALUES (?,?,?)')
      .run(me, '', replyTo || null);
    const id = info.lastInsertRowid;
    try {
      const apath = await writeChatAudio(file.buffer, id, ext);
      db.prepare('UPDATE group_messages SET audio = ?, audio_dur = ? WHERE id = ?').run(apath, dur, id);
    } catch (e) {
      db.prepare('DELETE FROM group_messages WHERE id = ?').run(id); // no ghost row on disk failure
      console.error(`[chat] voice write failed for ${me}: ${e.message}`);
      return res.status(500).json({ err: 'bad' });
    }
    res.json({ ok: 1 });
  });
});

// Video message — a picked/recorded clip (multipart field `video`, optional reply_to +
// dur). Fetch send like voice, so it replies in JSON. multer buffers → sniffVideo magic-
// byte gate → store the raw container → set video/video_dur on a new message. Shares the
// 'chat-media' rate-limit bucket with photos/voice.
app.post('/chat/video', requireLogin, (req, res) => {
  uploadChatVideo(req, res, async (err) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    if (mutedOut(gate, res, { json: true })) return; // suspended = muted
    const me = req.userEmail;
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ err: err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad' });
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ err: 'empty' });
    const ext = sniffVideo(file.buffer);                          // magic-byte gate (never client MIME)
    if (!ext) return res.status(415).json({ err: 'type' });
    if (rateLimited('chat-media', me, 15, 10 * 60 * 1000)) return res.status(429).json({ err: 'slow' });
    let dur = Math.round(Number(req.body.dur) || 0);              // client-reported; cosmetic only
    if (!(dur > 0)) dur = 0;
    if (dur > 3600) dur = 3600;
    let replyTo = Number(req.body.reply_to) || 0;
    if (replyTo && !db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = 1').get(replyTo)) replyTo = 0;
    const info = db.prepare('INSERT INTO group_messages (from_email, body, reply_to) VALUES (?,?,?)')
      .run(me, '', replyTo || null);
    const id = info.lastInsertRowid;
    try {
      const vpath = await writeChatVideo(file.buffer, id, ext);
      db.prepare('UPDATE group_messages SET video = ?, video_dur = ? WHERE id = ?').run(vpath, dur, id);
    } catch (e) {
      db.prepare('DELETE FROM group_messages WHERE id = ?').run(id); // no ghost row on disk failure
      console.error(`[chat] video write failed for ${me}: ${e.message}`);
      return res.status(500).json({ err: 'bad' });
    }
    res.json({ ok: 1 });
  });
});

// ---------- PICKLEBALL CHAT (isolated mirror of /chat*, on pk_group_* tables) ----------
// Gated by pkGate: approved members + admins, 404 while the run is hidden. Reuses the
// shared media pipeline (same /chat-media dir) and the base-pathed chat view.
app.get('/pickleball/chat', requireLogin, (req, res) => {
  const g = pkChatGate(req, res); if (!g) return;
  setRunCookie(req, res, 2);
  const me = req.userEmail;
  const chatData = loadPkGroupChat(me);
  const isMod = g.admin || !!(g.a && g.a.is_host);
  const canPin = isMod || !!(g.a && g.a.is_team);
  if (req.headers['x-prewarm'] !== '1') markPkGroupRead(me);
  res.send(pkChatPage({
    me,
    chat: { me, ...chatData, isMod, canPin, err: req.query.err || '' },
    runDate: pkRunDate(),
    dmUnread: unreadCount(me),
    pkGroupUnread: 0, pkGroupMention: 0,
    ann: null, // no basketball announcement bell on a pickleball surface (matches the pk check-in page)
  }));
});
app.post('/pickleball/chat/seen', requireLogin, (req, res) => {
  const g = pkChatGate(req, res); if (!g) return;
  markPkGroupRead(req.userEmail);
  res.status(204).end();
});
app.get('/pickleball/chat/older', requireLogin, (req, res) => {
  const g = pkChatGate(req, res); if (!g) return;
  const me = req.userEmail;
  const before = parseInt(req.query.before, 10);
  if (!Number.isInteger(before) || before <= 0) return res.status(400).send('');
  const data = loadPkGroupChatOlder(me, before);
  const isMod = g.admin || !!(g.a && g.a.is_host);
  const canPin = isMod || !!(g.a && g.a.is_team);
  res.send(chatOlderFragment({ me, ...data, isMod, canPin, base: '/pickleball/chat' }));
});
app.post('/pickleball/chat', requireLogin, (req, res) => {
  uploadChatImage(req, res, async (err) => {
    const g = pkChatGate(req, res); if (!g) return;
    if (mutedOut(g, res, { back: '/pickleball/chat' })) return;
    const me = req.userEmail;
    if (err) return res.redirect('/pickleball/chat?err=' + (err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad'));
    const body = (req.body.body || '').trim().slice(0, 1000);
    const file = req.file;
    const sticker = stickerPath(req.body.sticker);
    let replyTo = Number(req.body.reply_to) || 0;
    if (replyTo && !db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = 2').get(replyTo)) replyTo = 0;
    const mentions = body ? validMentions(req.body.mentions) : null;
    if (sticker) {
      if (rateLimited('pkchat-media', me, 20, 10 * 60 * 1000)) return res.redirect('/pickleball/chat?err=slow');
      db.prepare('INSERT INTO group_messages (from_email, body, reply_to, image, program_id) VALUES (?,?,?,?,2)')
        .run(me, '', replyTo || null, sticker);
      return res.redirect('/pickleball/chat');
    }
    if (file && file.buffer && file.buffer.length) {
      if (rateLimited('pkchat-media', me, 15, 10 * 60 * 1000)) return res.redirect('/pickleball/chat?err=slow');
      if (!sniffImage(file.buffer)) return res.redirect('/pickleball/chat?err=type');
      let msgId = 0;
      try {
        const jpeg = await processChatImage(file.buffer);
        const info = db.prepare('INSERT INTO group_messages (from_email, body, reply_to, mentions, program_id) VALUES (?,?,?,?,2)')
          .run(me, body, replyTo || null, mentions);
        msgId = info.lastInsertRowid;
        const imgPath = await writeChatImage(jpeg, msgId);
        db.prepare('UPDATE group_messages SET image = ? WHERE id = ?').run(imgPath, msgId);
        notifyPkMentions(me, body, mentions);
      } catch (e) {
        if (msgId) db.prepare('DELETE FROM group_messages WHERE id = ?').run(msgId);
        console.error(`[pkchat] image process failed for ${me}: ${e.message}`);
        return res.redirect('/pickleball/chat?err=bad');
      }
      return res.redirect('/pickleball/chat');
    }
    if (!body) return res.redirect('/pickleball/chat');
    if (rateLimited('pkchat-send', me, 30, 10 * 60 * 1000)) return res.redirect('/pickleball/chat?err=slow');
    db.prepare('INSERT INTO group_messages (from_email, body, reply_to, mentions, program_id) VALUES (?,?,?,?,2)')
      .run(me, body, replyTo || null, mentions);
    notifyPkMentions(me, body, mentions);
    res.redirect('/pickleball/chat');
  });
});
app.post('/pickleball/chat/react', requireLogin, (req, res) => {
  const g = pkChatGate(req, res); if (!g) return;
  if (mutedOut(g, res, { back: '/pickleball/chat' })) return;
  const me = req.userEmail;
  const messageId = Number(req.body.message_id) || 0;
  if (!db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = 2').get(messageId)) return res.redirect('/pickleball/chat');
  const emoji = validEmoji(req.body.emoji);
  if (!emoji) return res.redirect('/pickleball/chat');
  if (rateLimited('pkchat-react', me, 40, 10 * 60 * 1000)) return res.redirect('/pickleball/chat');
  const existing = db.prepare('SELECT emoji FROM group_reactions WHERE group_message_id = ? AND from_email = ?').get(messageId, me);
  if (existing && existing.emoji === emoji) {
    db.prepare('DELETE FROM group_reactions WHERE group_message_id = ? AND from_email = ?').run(messageId, me);
  } else {
    db.prepare(`INSERT INTO group_reactions (group_message_id, from_email, emoji, program_id) VALUES (?,?,?,2)
                ON CONFLICT(group_message_id, from_email) DO UPDATE SET emoji = excluded.emoji, created_at = datetime('now')`)
      .run(messageId, me, emoji);
  }
  res.redirect('/pickleball/chat');
});
app.post('/pickleball/chat/delete', requireLogin, (req, res) => {
  const g = pkChatGate(req, res); if (!g) return;
  const me = req.userEmail;
  const messageId = Number(req.body.message_id) || 0;
  const msg = db.prepare('SELECT id, from_email, image, audio, video FROM group_messages WHERE id = ? AND program_id = 2').get(messageId);
  if (!msg) return res.redirect('/pickleball/chat');
  const isMod = g.admin || !!(g.a && g.a.is_host);
  if (!isMod && msg.from_email !== me) return res.redirect('/pickleball/chat');
  db.prepare('DELETE FROM group_reactions WHERE group_message_id = ?').run(messageId);
  db.prepare('DELETE FROM group_messages WHERE id = ?').run(messageId);
  bumpPkChatSeq();
  safeUnlinkChatImage(msg.image); safeUnlinkChatImage(msg.audio); safeUnlinkChatImage(msg.video);
  res.redirect('/pickleball/chat');
});
app.post('/pickleball/chat/pin', requireLogin, (req, res) => {
  const g = pkChatGate(req, res); if (!g) return;
  if (mutedOut(g, res, { back: '/pickleball/chat' })) return;
  const canPin = g.admin || !!(g.a && (g.a.is_host || g.a.is_team));
  if (!canPin) return res.redirect('/pickleball/chat');
  const messageId = Number(req.body.message_id) || 0;
  const msg = db.prepare('SELECT id, pinned_at FROM group_messages WHERE id = ? AND program_id = 2').get(messageId);
  if (!msg) return res.redirect('/pickleball/chat');
  if (msg.pinned_at) db.prepare('UPDATE group_messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?').run(messageId);
  else db.prepare("UPDATE group_messages SET pinned_at = datetime('now'), pinned_by = ? WHERE id = ?").run(req.userEmail, messageId);
  bumpPkChatSeq();
  res.redirect('/pickleball/chat');
});
app.post('/pickleball/chat/voice', requireLogin, (req, res) => {
  uploadChatAudio(req, res, async (err) => {
    const g = pkChatGate(req, res, true); if (!g) return;
    if (mutedOut(g, res, { json: true })) return;
    const me = req.userEmail;
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ err: err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad' });
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ err: 'empty' });
    const ext = sniffAudio(file.buffer);
    if (!ext) return res.status(415).json({ err: 'type' });
    if (rateLimited('pkchat-media', me, 15, 10 * 60 * 1000)) return res.status(429).json({ err: 'slow' });
    let dur = Math.round(Number(req.body.dur) || 0);
    if (!(dur > 0)) dur = 0;
    if (dur > 300) dur = 300;
    let replyTo = Number(req.body.reply_to) || 0;
    if (replyTo && !db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = 2').get(replyTo)) replyTo = 0;
    const info = db.prepare('INSERT INTO group_messages (from_email, body, reply_to, program_id) VALUES (?,?,?,2)')
      .run(me, '', replyTo || null);
    const id = info.lastInsertRowid;
    try {
      const apath = await writeChatAudio(file.buffer, id, ext);
      db.prepare('UPDATE group_messages SET audio = ?, audio_dur = ? WHERE id = ?').run(apath, dur, id);
    } catch (e) {
      db.prepare('DELETE FROM group_messages WHERE id = ?').run(id);
      console.error(`[pkchat] voice write failed for ${me}: ${e.message}`);
      return res.status(500).json({ err: 'bad' });
    }
    res.json({ ok: 1 });
  });
});
app.post('/pickleball/chat/video', requireLogin, (req, res) => {
  uploadChatVideo(req, res, async (err) => {
    const g = pkChatGate(req, res, true); if (!g) return;
    if (mutedOut(g, res, { json: true })) return;
    const me = req.userEmail;
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ err: err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad' });
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ err: 'empty' });
    const ext = sniffVideo(file.buffer);
    if (!ext) return res.status(415).json({ err: 'type' });
    if (rateLimited('pkchat-media', me, 15, 10 * 60 * 1000)) return res.status(429).json({ err: 'slow' });
    let dur = Math.round(Number(req.body.dur) || 0);
    if (!(dur > 0)) dur = 0;
    if (dur > 3600) dur = 3600;
    let replyTo = Number(req.body.reply_to) || 0;
    if (replyTo && !db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = 2').get(replyTo)) replyTo = 0;
    const info = db.prepare('INSERT INTO group_messages (from_email, body, reply_to, program_id) VALUES (?,?,?,2)')
      .run(me, '', replyTo || null);
    const id = info.lastInsertRowid;
    try {
      const vpath = await writeChatVideo(file.buffer, id, ext);
      db.prepare('UPDATE group_messages SET video = ?, video_dur = ? WHERE id = ?').run(vpath, dur, id);
    } catch (e) {
      db.prepare('DELETE FROM group_messages WHERE id = ?').run(id);
      console.error(`[pkchat] video write failed for ${me}: ${e.message}`);
      return res.status(500).json({ err: 'bad' });
    }
    res.json({ ok: 1 });
  });
});

app.post('/checkin/join', requireLogin, (req, res) => {
  const email = req.userEmail;
  const a = applicantByEmail(email);
  if (!a || a.status !== 'approved') return res.redirect('/checkin');
  if (a.suspended) return res.redirect('/checkin'); // suspended → can't check in (page shows why)
  if (!a.waiver_ok) return res.redirect('/waiver?next=/checkin'); // one-time waiver before first join
  const runDate = nextRunDate();
  if (runIsCancelled(runDate)) return res.redirect('/checkin'); // run cancelled → no check-in (page shows why)
  if (runIsLocked(runDate)) return res.redirect('/checkin'); // locked at 2 PM → no new self-joins (drops/waitlist still churn; host adds a +1)
  // Pre-access: regulars and team can join while the run is still closed.
  const hasPreAccess = !!(a.is_regular || a.is_team);
  const runOpen = runIsOpen(runDate);
  if (!runOpen && !hasPreAccess) return res.redirect('/checkin');
  const already = db.prepare('SELECT 1 FROM checkins WHERE run_date=? AND email=? AND program_id = 1').get(runDate, email);
  // Pre-register cap: while CLOSED, team + regulars can hold at most PREREG_CAP
  // spots, so at least (floor − cap) survive for normals once you open.
  if (!runOpen && a.is_regular && !a.is_team && !already) {
    const { r } = stmtPreregCount.get(runDate);
    if (r >= PREREG_CAP) return res.redirect('/checkin'); // early spots full; opens to all later
  }
  // Hard cap: 15 floor + 5 waitlist. Past that, nobody new joins.
  if (!already) {
    const { n } = db.prepare('SELECT COUNT(*) n FROM checkins WHERE run_date=? AND program_id = 1').get(runDate);
    if (n >= TOTAL_CAP) return res.redirect('/checkin'); // run + waitlist full
  }
  try {
    // A regular who joins AFTER the run opens is "late" — held on the waitlist
    // until Friday 4pm so the open-phase floor spots stay reserved for normals.
    const isLateRegular = runOpen && a.is_regular && !a.is_team && !already;
    db.prepare('INSERT OR IGNORE INTO checkins (run_date,email,name,held) VALUES (?,?,?,?)')
      .run(runDate, email, a.full_name, isLateRegular ? 1 : 0);
  } catch (e) { console.error(e); }
  res.redirect('/checkin');
});

// Claim a held waitlist offer via its one-time link (works signed-out: the token IS
// the proof of address, same trust model as a magic link). SYNCHRONOUS lookup→check→
// convert with no await between, so two concurrent taps can't double-claim — the
// first clears the token, the second finds nothing and gets the friendly expired page.
// GET renders a confirm page (does NOT claim) so a mail-scanner's bare GET can't auto-claim
// the offered spot on the player's behalf. POST does the atomic claim (still race-safe — the
// synchronous read→check→clear can't double-claim). Expiry is owned by loadRun's reoffer.
app.get('/checkin/claim/:token', (req, res) => {
  const token = req.params.token || '';
  const row = db.prepare('SELECT * FROM checkins WHERE claim_token = ?').get(token);
  if (!row || row.offered_at == null || row.offered_at < Date.now() - OFFER_WINDOW_MS) {
    return res.send(claimResultPage({ ok: false }));
  }
  return res.send(confirmActionPage({
    title: 'Claim your spot', heading: 'A spot opened up', sub: `You've got a floor spot for ${runLabelFor(row.run_date)} — one tap locks it in.`,
    action: '/checkin/claim/' + token, fields: {}, button: 'Claim my spot →',
  }));
});
app.post('/checkin/claim/:token', (req, res) => {
  const token = req.params.token || '';
  const row = db.prepare('SELECT * FROM checkins WHERE claim_token = ?').get(token);
  if (!row || row.offered_at == null || row.offered_at < Date.now() - OFFER_WINDOW_MS) {
    return res.send(claimResultPage({ ok: false }));
  }
  // Convert the held offer into a real floor spot (clear the hold → they slide onto
  // the floor positionally) and sign them in.
  db.prepare('UPDATE checkins SET offered_at = NULL, claim_token = NULL WHERE id = ?').run(row.id);
  audit(row.email, 'player', 'offer:claim', row.email);
  setSession(res, row.email);
  return res.send(claimResultPage({ ok: true, runLabel: runLabelFor(row.run_date), runDate: row.run_date, startLabel: runStartLabel(row.run_date) }));
});

app.post('/checkin/leave', requireLogin, (req, res) => {
  const runDate = nextRunDate();
  // If they held a floor slot, offer it to the top waitlister (offer-and-confirm)
  // instead of silently auto-promoting. Capture the offeree BEFORE deleting.
  const offeree = offereeForFloorLeave(runDate, req.userEmail);
  db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1').run(runDate, req.userEmail);
  if (offeree) createOffer(runDate, offeree, req);
  res.redirect('/checkin');
});

// Team member toggles their persistent auto-renew (guaranteed weekly spot).
app.post('/checkin/autorenew', requireLogin, (req, res) => {
  const a = applicantByEmail(req.userEmail);
  if (a && a.is_team) {
    const on = req.body.on === '1';
    // No waiver, no seat: autoJoinTeam now filters waiver_ok, so turning auto-renew ON without a
    // waiver would silently never seat them while the hero shows "Sit out" as if they were on the
    // floor. Route them to sign the one-time waiver first (mirrors /pickleball/autorenew).
    if (on && !a.waiver_ok) return res.redirect('/waiver?next=/checkin');
    db.prepare('UPDATE applicants SET auto_renew = ? WHERE id = ?').run(on ? 1 : 0, a.id);
    const runDate = nextRunDate();
    if (!on) {
      // opting out of the held-seat system — drop the current auto-spot too. If that
      // spot was on the floor, offer the freed slot to the top waitlister.
      const offeree = offereeForFloorLeave(runDate, req.userEmail);
      db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1').run(runDate, req.userEmail);
      if (offeree) createOffer(runDate, offeree, req);
    } else {
      // WIRING: turning auto-renew back ON re-seats them now (autoJoinTeam is
      // rollover-gated in ensureWeek), so this response page shows them seated.
      autoJoinTeam(runDate);
    }
    audit(req.userEmail, 'team', 'auto-renew:' + (on ? 'on' : 'off'), req.userEmail);
  }
  res.redirect('/checkin');
});

// --- admin-only game controls ---
app.post('/checkin/guest', requireApprover, (req, res) => {
  const runDate = nextRunDate();
  if (runIsCancelled(runDate)) return res.redirect('/checkin'); // no adding guests onto a cancelled run (mirrors /pickleball/guest)
  const name = (req.body.name || '').trim().slice(0, 60);
  if (name) {
    // Double-tap guard: a native form re-post within seconds must not add a 2nd identical guest.
    const dup = db.prepare("SELECT 1 FROM checkins WHERE run_date=? AND name=? AND program_id = 1 AND created_at > datetime('now','-5 seconds')").get(runDate, name + ' (guest)');
    if (dup) return res.redirect('/checkin');
    const { n } = db.prepare('SELECT COUNT(*) n FROM checkins WHERE run_date=? AND program_id = 1').get(runDate);
    if (n < TOTAL_CAP) {
      const email = `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@guest.local`;
      db.prepare('INSERT INTO checkins (run_date,email,name) VALUES (?,?,?)').run(runDate, email, name + ' (guest)');
      audit(req.userEmail, req.actorRole, 'checkin:guest-add', name);
    }
  }
  res.redirect('/checkin');
});
app.post('/checkin/remove', requireApprover, (req, res) => {
  const runDate = nextRunDate();
  const target = String(req.body.email || '').toLowerCase();
  // Removing a floor occupant frees a slot → offer it onward (capture before delete).
  const offeree = offereeForFloorLeave(runDate, target);
  db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1').run(runDate, target);
  if (offeree) createOffer(runDate, offeree, req);
  audit(req.userEmail, req.actorRole, 'checkin:remove', target);
  res.redirect('/checkin');
});

app.post('/checkin/promote', requireApprover, (req, res) => {
  const runDate = nextRunDate();
  const email = String(req.body.email || '').toLowerCase();
  // float this player above everyone currently checked in → they slot into the run,
  // bumping the last person in the run down to the top of the waitlist if it was full
  const { m } = db.prepare('SELECT MIN(sort_order) m FROM checkins WHERE run_date = ? AND program_id = 1').get(runDate);
  const newOrder = (m ?? 0) - 1;
  // Promote finalizes the player onto the floor THROUGH any pending offer: clear the
  // hold so they settle as a real floor player instead of lingering as "⏳ Claiming"
  // (offered_at set → partitionRun would keep counting them as a held offer, not
  // seated, so the bump would appear to do nothing). No-op when they had no offer.
  db.prepare('UPDATE checkins SET sort_order = ?, offered_at = NULL, claim_token = NULL WHERE run_date = ? AND email = ? AND program_id = 1')
    .run(newOrder, runDate, email);
  audit(req.userEmail, req.actorRole, 'checkin:promote', email);
  res.redirect('/checkin');
});

// Basketball's auto-renew team seating, now on the unified engine (Phase 3c). Keeps its
// root-cause guard — never re-seat a cancelled run (floor cleared) or a locked one (past 2 PM,
// roster set) so no caller (optin/autorenew/open/rollover) re-populates — then delegates to
// seatRenewers, which reads P(1).config.autoRenew.from='team': only the org team
// (applicants.is_team, approved, auto_renew, waiver_ok, not-suspended, not-opted-out this week)
// is seated, TOP priority via negative sort_order, trimmed to cap+waitlist. NO non-team fill
// (basketball auto-renews only the team; "no waiver, no play" preserved by the shared engine).
function autoJoinTeam(runDate) {
  if (runIsCancelled(runDate) || runIsLocked(runDate)) return;
  seatRenewers(1, runDate);
}

app.post('/checkin/open', requireApprover, (req, res) => {
  const runDate = nextRunDate();
  if (runIsCancelled(runDate)) return res.redirect('/checkin'); // must un-cancel before opening
  setRunOpen(runDate, true);
  autoJoinTeam(runDate); // team is dropped onto the floor the moment you open
  audit(req.userEmail, req.actorRole, 'run:open', runDate);
  res.redirect('/checkin');
});
app.post('/checkin/close', requireApprover, (req, res) => {
  const runDate = nextRunDate();
  setRunOpen(runDate, false);
  audit(req.userEmail, req.actorRole, 'run:close', runDate);
  res.redirect('/checkin');
});

// Cancel / un-cancel THIS week's run (host or admin). Cancelling closes it (setRunCancelled)
// and pushes a game-day "run cancelled" notice to players; un-cancelling leaves it closed for
// the host to re-open deliberately. Per run_date, so next week is unaffected. No-op guarded.
app.post('/admin/run/cancel', requireLogin, (req, res) => {
  const email = req.userEmail;
  const a = applicantByEmail(email);
  const admin = isAdmin(email);
  const host = !!(a && a.is_host);
  if (!admin && !host) return res.status(403).send('Only the host or an admin can cancel the run.');
  const runDate = nextRunDate();
  const cancel = req.body.on === '1';
  if (cancel === runIsCancelled(runDate)) return res.redirect('/checkin'); // no state change → no push spam
  setRunCancelled(runDate, cancel);
  if (cancel) db.prepare('DELETE FROM checkins WHERE run_date = ? AND program_id = 1').run(runDate); // clear the floor — a cancelled run has nobody on it
  audit(email, admin ? 'admin' : 'host', cancel ? 'run:cancel' : 'run:uncancel', runDate);
  if (cancel) {
    // Game-day notification: push only (no email storm) — the check-in banner carries it in-app.
    setImmediate(() => sendPush(approvedEmails(), {
      title: 'Run cancelled',
      body: `This week's run — ${runWeekday(runDate)}, ${runLabelFor(runDate)} — is cancelled. No run this week.`,
      url: '/checkin', tag: 'announce',
    }));
  }
  res.redirect('/checkin?rdset=1');
});

// The run-day confirm/release ping is now AUTOMATIC at the 2 PM lock (see autoRunState) —
// the old manual /checkin/confirmping route + host button were removed.

// A floor player confirms they're coming (run-day ping response). Idempotent.
app.post('/checkin/confirm', requireLogin, (req, res) => {
  const runDate = nextRunDate();
  // Only real floor players confirm — a waitlister shouldn't pre-mark ✓ and slide on later.
  const part = partitionRun(runDate);
  if (part.floorReal.some(p => p.email === req.userEmail)) {
    db.prepare("UPDATE checkins SET confirmed_at = datetime('now') WHERE run_date = ? AND email = ? AND program_id = 1 AND confirmed_at IS NULL")
      .run(runDate, req.userEmail);
  }
  res.redirect('/checkin');
});

// A regular clears (or restores) their own auto-seat for this week.
app.post('/checkin/optout', requireLogin, (req, res) => {
  const runDate = nextRunDate();
  db.prepare('INSERT OR IGNORE INTO regular_optout (run_date,email) VALUES (?,?)')
    .run(runDate, req.userEmail);
  // Sitting out frees their spot — if it was a floor slot, offer it onward.
  const offeree = offereeForFloorLeave(runDate, req.userEmail);
  db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1').run(runDate, req.userEmail);
  if (offeree) createOffer(runDate, offeree, req);
  res.redirect('/checkin');
});
app.post('/checkin/optin', requireLogin, (req, res) => {
  const runDate = nextRunDate();
  const me = applicantByEmail(req.userEmail);
  if (me && me.suspended) return res.redirect('/checkin'); // suspended → can't re-seat (matches /checkin/join)
  if (me && !me.waiver_ok) return res.redirect('/waiver?next=/checkin'); // one-time waiver before seating
  if (runIsCancelled(runDate) || runIsLocked(runDate)) return res.redirect('/checkin'); // cancelled/locked → no re-seat (matches /checkin/join)
  db.prepare('DELETE FROM regular_optout WHERE run_date = ? AND email = ? AND program_id = 1').run(runDate, req.userEmail);
  // WIRING (autoJoinTeam is now rollover-gated in ensureWeek, not per-view): a team
  // member with auto-renew opting back in — even while CLOSED — must be re-seated
  // here so this POST's response page shows them on the floor immediately.
  autoJoinTeam(runDate);
  // if the run is already open, put them back on the floor now
  if (runIsOpen(runDate)) {
    const a = applicantByEmail(req.userEmail);
    if (a && a.status === 'approved') {
      // Same hard cap as /checkin/join. Without it this seats row #21, which waitPlayers
      // slices off — an invisible ghost that still counts toward runFull.
      const already = db.prepare('SELECT 1 FROM checkins WHERE run_date=? AND email=? AND program_id = 1').get(runDate, req.userEmail);
      const { n } = db.prepare('SELECT COUNT(*) n FROM checkins WHERE run_date=? AND program_id = 1').get(runDate);
      if (already || n < TOTAL_CAP) {
        db.prepare('INSERT OR IGNORE INTO checkins (run_date,email,name) VALUES (?,?,?)')
          .run(runDate, req.userEmail, a.full_name);
      }
    }
  }
  res.redirect('/checkin');
});

// ---------- ADMIN / COUNCIL ----------
app.get('/admin', requireApprover, (req, res) => {
  const order = `CASE status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END`;
  const allRows = db.prepare(`SELECT * FROM applicants ORDER BY ${order}, created_at DESC`).all();
  const viewerIsAdmin = isAdmin(req.userEmail);
  // Filter tabs: all | pending | approved | rejected
  const valid = ['all', 'pending', 'approved', 'rejected'];
  const filter = valid.includes(req.query.status) ? req.query.status : 'all';
  const counts = {
    all: allRows.length,
    pending: allRows.filter(a => a.status === 'pending').length,
    approved: allRows.filter(a => a.status === 'approved').length,
    rejected: allRows.filter(a => a.status === 'rejected').length,
  };
  const filtered = filter === 'all' ? allRows : allRows.filter(a => a.status === filter);
  // Batch the vote lookups: compute the approver pool once and pull EVERY relevant
  // vote in a single IN-query, grouped by applicant, instead of two queries per row.
  const pool = approverEmails();
  const nonTeamIds = filtered.filter(a => !a.is_team).map(a => a.id);
  const votesByApplicant = new Map();
  if (nonTeamIds.length) {
    const ph = nonTeamIds.map(() => '?').join(',');
    for (const v of db.prepare(`SELECT applicant_id, voter_email, vote FROM votes WHERE applicant_id IN (${ph})`).all(...nonTeamIds)) {
      if (!votesByApplicant.has(v.applicant_id)) votesByApplicant.set(v.applicant_id, []);
      votesByApplicant.get(v.applicant_id).push(v);
    }
  }
  const applicants = filtered.map(a => ({
    ...a,
    vote: a.is_team ? null : voteInfo(a.id, req.userEmail, pool, votesByApplicant.get(a.id) || []),
  }));
  const runDate = nextRunDate();
  const checkedInCount = db.prepare('SELECT COUNT(*) n FROM checkins WHERE run_date = ? AND program_id = 1').get(runDate).n;
  const log = viewerIsAdmin
    ? db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 40').all() : [];
  // The voting pool ("The Council"): team members. Shown to all operators as a
  // roster, and (admin-only) their names back the who-voted lines below.
  const teamMembers = db.prepare(
    'SELECT full_name, email, is_host FROM applicants WHERE is_team = 1 AND is_host = 0 ORDER BY full_name ASC').all();
  res.send(adminPage({
    applicants, runLabel: runLabelFor(runDate), runDate, hours: runTimeRange(runDate), checkedInCount, cap: CAP,
    waitlistCap: WAITLIST_CAP, preregCap: PREREG_CAP,
    viewerIsAdmin, viewerIsTeam: req.actorRole === 'team',
    viewerIsHost: !!(db.prepare('SELECT is_host FROM applicants WHERE email = ?').get(String(req.userEmail).toLowerCase())?.is_host),
    viewerEmail: req.userEmail, log, msg: req.query.msg || '',
    filter, counts, teamMembers, ann: annPanel(req.userEmail),
    dmUnread: unreadCount(req.userEmail), groupUnread: groupUnread(req.userEmail), groupMention: groupMentionUnread(req.userEmail, applicantIdOf(req.userEmail)),
  }));
});

// Host-editable run capacities (admin). Stored in app_settings, applied immediately via
// reloadRunSettings() — no restart. Clamped to sane bounds; blank/garbage falls back.
app.post('/admin/settings', requireAdmin, (req, res) => {
  const clamp = (v, lo, hi, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
  setSetting('run_cap', clamp(req.body.run_cap, 1, 100, CAP));
  setSetting('waitlist_cap', clamp(req.body.waitlist_cap, 0, 100, WAITLIST_CAP));
  setSetting('prereg_cap', clamp(req.body.prereg_cap, 0, 100, PREREG_CAP));
  reloadRunSettings();
  audit(req.userEmail, 'admin', 'settings:caps', `cap=${CAP} wl=${WAITLIST_CAP} prereg=${PREREG_CAP}`);
  res.redirect('/admin?msg=' + encodeURIComponent('Run settings saved'));
});

// Check-in banner tool (operators). GET renders the pick + pan/zoom cropper; POST takes the
// photo + the source-pixel crop rect the browser computed and writes the final 2320×1160 JPEG.
app.get('/admin/banner', requireApprover, (req, res) => {
  res.send(bannerPage({ err: req.query.err || '', bannerVer: bannerVersion() }));
});
app.post('/admin/banner', requireApprover, (req, res) => {
  uploadBanner(req, res, async (err) => {
    if (err) return res.redirect('/admin/banner?err=' + (err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad'));
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.redirect('/admin/banner?err=empty');
    if (!sniffImage(file.buffer)) return res.redirect('/admin/banner?err=type'); // magic-byte gate
    try {
      // The browser cropper works in EXIF-ORIENTED pixels (what it displays), so compute the
      // oriented dimensions to clamp against, then rotate() before extract so coords line up.
      const m = await sharp(file.buffer).metadata();
      const oriented = (m.orientation || 1) >= 5;
      const W = oriented ? m.height : m.width, H = oriented ? m.width : m.height;
      let left = Math.round(Number(req.body.cx)), top = Math.round(Number(req.body.cy));
      let width = Math.round(Number(req.body.cw)), height = Math.round(Number(req.body.ch));
      if (!(W > 0 && H > 0 && width > 0 && height > 0)) return res.redirect('/admin/banner?err=crop');
      left = Math.max(0, Math.min(left, W - 1)); top = Math.max(0, Math.min(top, H - 1));
      width = Math.max(1, Math.min(width, W - left)); height = Math.max(1, Math.min(height, H - top));
      const out = await sharp(file.buffer, { failOn: 'error' }).rotate()
        .extract({ left, top, width, height })
        .resize(2320, 1160, { fit: 'fill' }) // 2:1 banner — matches .gymbanner/.cropframe CSS
        .jpeg({ quality: 84, mozjpeg: true }).toBuffer();
      await fs.promises.writeFile(BANNER_PATH, out); // async write off the event loop
      audit(req.userEmail, req.actorRole, 'banner:update', `${width}x${height}`);
      return res.redirect('/checkin');
    } catch (e) {
      console.error(`[banner] crop failed for ${req.userEmail}: ${e.message}`);
      return res.redirect('/admin/banner?err=bad');
    }
  });
});
// Pickleball banner change — same cropper as basketball, writes pk-banner.jpg.
app.get('/pickleball/banner', requireAdmin, (req, res) => {
  res.send(bannerPage({ err: req.query.err || '', bannerVer: pkBannerVersion(), action: '/pickleball/banner', imgSrc: pkBannerSrc(), back: '/pickleball', bodyClass: 'pk' }));
});
app.post('/pickleball/banner', requireAdmin, (req, res) => {
  uploadBanner(req, res, async (err) => {
    if (err) return res.redirect('/pickleball/banner?err=' + (err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad'));
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.redirect('/pickleball/banner?err=empty');
    if (!sniffImage(file.buffer)) return res.redirect('/pickleball/banner?err=type');
    try {
      const m = await sharp(file.buffer).metadata();
      const oriented = (m.orientation || 1) >= 5;
      const W = oriented ? m.height : m.width, H = oriented ? m.width : m.height;
      let left = Math.round(Number(req.body.cx)), top = Math.round(Number(req.body.cy));
      let width = Math.round(Number(req.body.cw)), height = Math.round(Number(req.body.ch));
      if (!(W > 0 && H > 0 && width > 0 && height > 0)) return res.redirect('/pickleball/banner?err=crop');
      left = Math.max(0, Math.min(left, W - 1)); top = Math.max(0, Math.min(top, H - 1));
      width = Math.max(1, Math.min(width, W - left)); height = Math.max(1, Math.min(height, H - top));
      const out = await sharp(file.buffer, { failOn: 'error' }).rotate()
        .extract({ left, top, width, height })
        .resize(2320, 1160, { fit: 'fill' })
        .jpeg({ quality: 84, mozjpeg: true }).toBuffer();
      await fs.promises.writeFile(PK_BANNER_PATH, out);
      audit(req.userEmail, req.actorRole, 'pk:banner:update', `${width}x${height}`);
      return res.redirect('/pickleball');
    } catch (e) {
      console.error(`[pk-banner] crop failed for ${req.userEmail}: ${e.message}`);
      return res.redirect('/pickleball/banner?err=bad');
    }
  });
});

// An approver casts (or changes) their vote. Unanimous approve → approved;
// any reject → rejected. Recomputed live.
app.post('/admin/vote', requireApprover, (req, res) => {
  const { id, vote } = req.body;
  // Only team members vote. Admins run the app but don't get a vote.
  if (req.actorRole !== 'team') return res.status(403).send('Only team members vote on applicants.');
  const voter = db.prepare('SELECT is_host FROM applicants WHERE email = ?').get(String(req.userEmail).toLowerCase());
  if (voter && voter.is_host) return res.status(403).send('The host has oversight, not a vote.');
  if (!['approve', 'reject'].includes(vote)) return res.redirect('/admin');
  const a = db.prepare('SELECT email, is_team FROM applicants WHERE id = ?').get(id);
  if (!a || a.is_team) return res.redirect('/admin'); // team aren't voted on
  if (a.email === req.userEmail) return res.status(403).send("You can't vote on your own application.");
  db.prepare(`INSERT INTO votes (applicant_id,voter_email,vote) VALUES (?,?,?)
              ON CONFLICT(applicant_id,voter_email) DO UPDATE SET vote=excluded.vote, at=datetime('now')`)
    .run(id, req.userEmail.toLowerCase(), vote);
  recomputeStatus(id);
  audit(req.userEmail, req.actorRole, 'vote:' + vote, a.email);
  res.redirect('/admin');
});

// Admin-only: wipe an applicant's votes and send them back to pending (re-vote).
app.post('/admin/reset', requireAdmin, (req, res) => {
  const { id } = req.body;
  const a = db.prepare('SELECT email, is_team FROM applicants WHERE id = ?').get(id);
  if (a) {
    db.prepare('DELETE FROM votes WHERE applicant_id = ?').run(id);
    db.prepare("UPDATE applicants SET status = 'pending' WHERE id = ? AND is_team = 0").run(id);
    // Back to pending → requirePlayer bounces them, so they can no longer leave check-in and would
    // freeze their floor spot. Free it (offer onward) like reject/suspend/delete do. Team members
    // aren't sent to pending (is_team guard above), so leave their spot alone.
    if (!a.is_team) {
      const runDate = nextRunDate();
      const offeree = offereeForFloorLeave(runDate, a.email);
      db.prepare('DELETE FROM checkins WHERE email = ? AND program_id = 1').run(a.email); // basketball floor only (reset doesn't touch pk)
      if (offeree) createOffer(runDate, offeree, req);
    }
    audit(req.userEmail, 'admin', 'reset', a.email);
  }
  res.redirect('/admin');
});

app.post('/admin/role', requireAdmin, (req, res) => {
  const { id, role, on } = req.body; // role: 'team' | 'regular'
  const turnOn = on === '1';
  const a = db.prepare('SELECT status, email FROM applicants WHERE id = ?').get(id);
  if (!a) return res.redirect('/admin');
  if (role === 'team') {
    // Making someone team AUTO-APPROVES them (they skip the vote).
    if (turnOn) {
      db.prepare("UPDATE applicants SET is_team = 1, status = 'approved' WHERE id = ?").run(id);
      // WIRING: a newly-minted team member (auto_renew defaults on) is seated on the
      // current run immediately — autoJoinTeam is rollover-gated in ensureWeek now.
      autoJoinTeam(nextRunDate());
    } else {
      db.prepare('UPDATE applicants SET is_team = 0 WHERE id = ?').run(id);
    }
    audit(req.userEmail, 'admin', `role:team:${turnOn ? 'on' : 'off'}`, a.email);
  } else if (role === 'regular') {
    // Making someone Core (regular) AUTO-APPROVES them, same as team — one-click
    // approve-and-flag. Turning Core off only clears the flag, never un-approves.
    if (turnOn) {
      db.prepare("UPDATE applicants SET is_regular = 1, status = 'approved' WHERE id = ?").run(id);
    } else {
      db.prepare('UPDATE applicants SET is_regular = 0 WHERE id = ?').run(id);
    }
    audit(req.userEmail, 'admin', `role:regular:${turnOn ? 'on' : 'off'}`, a.email);
  } else if (role === 'host') {
    // Host — THE organizer of the night. Single-host invariant: turning one on
    // clears any existing host first. Only an approved player can be host.
    if (a.status === 'approved') {
      if (turnOn) db.prepare('UPDATE applicants SET is_host = 0 WHERE is_host = 1').run();
      db.prepare('UPDATE applicants SET is_host = ? WHERE id = ?').run(turnOn ? 1 : 0, id);
      audit(req.userEmail, 'admin', `role:host:${turnOn ? 'on' : 'off'}`, a.email);
    }
  }
  res.redirect('/admin');
});

// ---------- RUN DAY (host-configurable) ----------
// Move a given week's run to a different weekday. HOST or ADMIN only (team members,
// who vote on applicants, do NOT get to move the run) — so this can't use
// requireApprover. The chosen date is validated (not past, within 30 days), keyed
// to that date's default Friday, and upserted as an override (or the override is
// cleared when the host picks the default Friday itself). The CURRENT week's live
// rows (checkins / run_state / opt-outs) are migrated old→new run date atomically so
// nothing is orphaned. On a real change we auto-post an announcement (same insert +
// archive-current path as /announce) and optionally email everyone (default ON,
// matching the announce UX). Synchronous throughout for race-safety.
app.post('/admin/rundate', requireLogin, (req, res) => {
  const email = req.userEmail;
  const a = applicantByEmail(email);
  const admin = isAdmin(email);
  const host = !!(a && a.is_host);
  if (!admin && !host) return res.status(403).send('Only the host or an admin can set the run day.');
  const actorRole = admin ? 'admin' : 'host';
  // Pre-season the weekly run doesn't exist yet — the form is hidden, but reject a stale-tab /
  // direct POST so it can't create a dead override AND blast a phantom "the run is now …"
  // announcement + push to every member. Set the season via the Season control instead.
  { const opener = seasonStart(); if (opener && ymdLocal() < opener) return res.redirect('/checkin?rderr=preseason'); }

  const raw = String(req.body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || isNaN(new Date(raw + 'T12:00:00')))
    return res.redirect('/checkin?rderr=bad');
  const today = ymdLocal();
  if (raw < today) return res.redirect('/checkin?rderr=past');
  const maxDate = new Date(); maxDate.setDate(maxDate.getDate() + 30);
  if (raw > ymdLocal(maxDate)) return res.redirect('/checkin?rderr=range');

  // Optional start/end time (HH:MM). Blank/absent → DEFAULT_START–DEFAULT_END. End must
  // be after start. A time that differs from default is stored even when the DAY didn't
  // move (a time-only override), so the row must persist in that case too.
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const rawStart = String(req.body.start || '').trim();
  const rawEnd = String(req.body.end || '').trim();
  if (rawStart && !TIME_RE.test(rawStart)) return res.redirect('/checkin?rderr=time');
  if (rawEnd && !TIME_RE.test(rawEnd)) return res.redirect('/checkin?rderr=time');
  const start = rawStart || DEFAULT_START;
  const end = rawEnd || DEFAULT_END;
  if (end <= start) return res.redirect('/checkin?rderr=time');

  // Key the override by the base of the CYCLE BEING MOVED — the default day the current
  // upcoming run is keyed under — NOT the default day nearest the chosen destination. The
  // date picker only ever edits the current upcoming run (it's pre-filled with it), so
  // oldRunDate IS the run being moved. Keying off the destination breaks the moment a move
  // (or re-move) crosses the week-midpoint: it strands the run's own override AND creates a
  // second one under the adjacent week's key. runBaseFor recovers the true base across far
  // moves. (Mirrors pickleball's pk_run_base fix — see /pickleball/date.)
  const oldRunDate = nextRunDate();  // the live upcoming run date BEFORE the change = the run being moved
  const base = runBaseFor(oldRunDate);
  const timeCustom = start !== DEFAULT_START || end !== DEFAULT_END;
  const dateMoved = raw !== base;
  const storeTime = timeCustom ? start : null;   // NULL cols = "use defaults"
  const storeEnd = timeCustom ? end : null;

  // Setting/re-confirming the run day REVIVES a cancelled run (re-scheduling = you're
  // committing to run again) — done BEFORE the no-op guard so re-submitting the SAME date
  // still un-cancels. The check-in page reflects it immediately.
  if (runIsCancelled(raw)) { setRunCancelled(raw, false); audit(email, actorRole, 'run:uncancel-via-rundate', raw); }

  // No-op guard: if the stored state already matches this request, skip the write +
  // announcement (re-submitting the same day/time must not spam everyone).
  const curRow = runOverrideRow(base);
  const same = (!dateMoved && !timeCustom)
    ? !curRow
    : (curRow && curRow.run_date === raw && (curRow.run_time || null) === storeTime && (curRow.run_end || null) === storeEnd);
  if (same) return res.redirect('/checkin?rdset=1');

  if (!dateMoved && !timeCustom) {
    db.prepare('DELETE FROM run_overrides WHERE default_date = ?').run(base);   // full reset
  } else {
    db.prepare(`INSERT INTO run_overrides (default_date, run_date, run_time, run_end) VALUES (?, ?, ?, ?)
                   ON CONFLICT(default_date) DO UPDATE SET run_date = excluded.run_date,
                     run_time = excluded.run_time, run_end = excluded.run_end, created_at = datetime('now')`)
      .run(base, raw, storeTime, storeEnd);
  }
  const newRunDate = nextRunDate();  // the live upcoming run date AFTER the change

  // Migrate the live cycle's rows only if the UPCOMING run date actually changed. Moving
  // a FUTURE week's run leaves the current cycle untouched → oldRunDate === newRunDate →
  // no migration. ensureWeek keys off nextRunDate too, but lastRunDate already equals the
  // (unchanged-or-just-migrated) current run date, so this never trips a spurious rollover;
  // the migration below is the only thing that moves rows, keeping check-in / waitlist /
  // offer state coherent. newRunDate === the chosen date whenever the current cycle moves.
  if (oldRunDate !== newRunDate) {
    db.exec('BEGIN');
    try {
      const st = stmtRunIsOpen.get(oldRunDate);
      if (st) { setRunOpen(newRunDate, st.is_open); db.prepare('DELETE FROM run_state WHERE run_date = ? AND program_id = 1').run(oldRunDate); }
      // Carry the once-per-run auto-open marker to the new date — otherwise moving a run the
      // host already closed re-arms auto-open under the new (unmarked) date key.
      if (getSetting('autoopen_done') === oldRunDate) setSetting('autoopen_done', newRunDate);
      // The auto-CLOSE/confirm-ping marker only carries if the new date's 2 PM lock has ALREADY
      // passed; if the new run day is still ahead, RESET it so the new day still auto-locks +
      // pings (carrying it blindly would skip the confirm ping when moving a run to a later day).
      if (getSetting('autoclose_done') === oldRunDate) {
        const newClose = new Date(newRunDate + 'T14:00:00').getTime();
        if (Date.now() >= newClose) setSetting('autoclose_done', newRunDate);
        else db.prepare("DELETE FROM app_settings WHERE key = 'autoclose_done'").run();
      }
      db.prepare('UPDATE checkins SET run_date = ? WHERE run_date = ? AND program_id = 1').run(newRunDate, oldRunDate);
      db.prepare('UPDATE regular_optout SET run_date = ? WHERE run_date = ? AND program_id = 1').run(newRunDate, oldRunDate);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); console.error(`[rundate] migration FAILED: ${e.message}`); throw e; }
  }

  // Announce the change to players (archives the current live announcement, like
  // /announce) + optionally email everyone (default ON — matches the compose UX).
  // Reference the CHOSEN date (or the reset-to Friday), which is the run that moved —
  // NOT newRunDate, which for a future-week move is the unchanged current run.
  const reset = !dateMoved && !timeCustom;
  const annDate = reset ? base : raw;
  const wd = runWeekday(annDate), lbl = runLabelFor(annDate);
  const timeLbl = runTimeRange(annDate);   // reflects the just-stored (or default) window
  const annBody = reset
    ? `📅 Update — the run is back to its usual ${wd}, ${lbl} (${timeLbl}).`
    : `📅 Heads up — the run is now ${wd}, ${lbl} (${timeLbl}).`;
  db.prepare("UPDATE announcements SET archived = 1, archived_at = datetime('now') WHERE archived = 0 AND program_id = 1").run();
  db.prepare('INSERT INTO announcements (body,author) VALUES (?,?)').run(annBody, email);
  audit(email, actorRole, 'rundate:set', `${base} -> ${reset ? 'default' : raw} ${storeTime || DEFAULT_START}-${storeEnd || DEFAULT_END}`);

  // Push the run-day/time change to every subscribed player (independent of email).
  const meLc = String(email).toLowerCase();
  setImmediate(() => sendPush(approvedEmails().filter(e => e.toLowerCase() !== meLc),
    { title: 'Run day update', body: annBody.replace(/^📅\s*/, ''), url: '/checkin', tag: 'announce' }));

  if (req.body.email_everyone) {
    setImmediate(() => {
      try {
        const recipients = announcementRecipients();
        sendAnnouncement(recipients, annBody, email).catch(err =>
          console.error(`[rundate] announcement email FAILED: ${err.message}`));
      } catch (err) { console.error(`[rundate] announcement email prep FAILED: ${err.message}`); }
    });
  }
  res.redirect('/checkin?rdset=1');
});

// Season-start gate control (HOST/ADMIN) — sets/clears app_settings 'season_start'. Before
// the opener there are no weekly runs and nothing auto-opens; clearing it resumes the weekly
// schedule immediately. Silent (no announcement/push) — the operator sends their own season
// kickoff message; this is config, not a player-facing event.
app.post('/admin/season', requireLogin, (req, res) => {
  const email = req.userEmail;
  const a = applicantByEmail(email);
  const admin = isAdmin(email);
  const host = !!(a && a.is_host);
  if (!admin && !host) return res.status(403).send('Only the host or an admin can set the season.');
  const actorRole = admin ? 'admin' : 'host';
  const raw = String(req.body.season || '').trim();
  if (!raw) {   // clear → runs resume every week
    db.prepare("DELETE FROM app_settings WHERE key = 'season_start'").run();
    audit(email, actorRole, 'season:clear', '');
    return res.redirect('/checkin?rdset=seasonoff');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || isNaN(new Date(raw + 'T12:00:00'))) return res.redirect('/checkin?rderr=seasonbad');
  const today = ymdLocal();
  if (raw < today) return res.redirect('/checkin?rderr=seasonpast');
  const maxD = new Date(); maxD.setFullYear(maxD.getFullYear() + 1);
  if (raw > ymdLocal(maxD)) return res.redirect('/checkin?rderr=seasonrange');
  setSetting('season_start', raw);
  // Clear any rosters for runs between now and the opener. The season gate makes nextRunDate
  // jump to the opener, so these future runs become unreachable (no auto-open/ping, off the
  // check-in page). Left in place, the NEXT rollover (in September) would archive an abandoned
  // FUTURE roster into `attendance` as a run that never happened — permanent phantom season-board
  // credits. Only strictly-future runs (run_date > today); a run happening today archives
  // normally tonight. Past runs are the rollover's job. (ensureWeek's cutoff=today fix stopped
  // the immediate-jump archive; this stops the delayed one.)
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM checkins WHERE run_date > ? AND run_date < ? AND program_id = 1').run(today, raw);
    db.prepare('DELETE FROM regular_optout WHERE run_date > ? AND run_date < ? AND program_id = 1').run(today, raw);
    db.prepare('DELETE FROM run_state WHERE run_date > ? AND run_date < ? AND program_id = 1').run(today, raw);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); console.error(`[season] roster cleanup FAILED: ${e.message}`); throw e; }
  audit(email, actorRole, 'season:set', raw);
  res.redirect('/checkin?rdset=season');
});

// Share page — a big scannable QR + tap-able link for the application form,
// to show/hand out at the Monday rec runs. QR is generated live from PUBLIC_URL
// so it never points at a stale address.
app.get('/admin/share', requireAdmin, async (req, res, next) => {
  try {
    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const applyUrl = base + '/';
    const [applyQr, loginQr] = await Promise.all([
      QRCode.toString(applyUrl, { type: 'svg', margin: 1, color: { dark: '#183B38', light: '#ffffff' } }),
      QRCode.toString(base + '/login', { type: 'svg', margin: 1, color: { dark: '#183B38', light: '#ffffff' } }),
    ]);
    res.send(sharePage({ applyUrl, applyQr, signInUrl: base + '/login', loginQr, ann: annPanel(req.userEmail), dmUnread: unreadCount(req.userEmail), groupUnread: groupUnread(req.userEmail), groupMention: groupMentionUnread(req.userEmail, applicantIdOf(req.userEmail)) }));
  } catch (e) { next(e); } // QR failure must not take the process down (Express 4 won't catch async throws)
});

// ---------- PEOPLE MANAGEMENT (admin-only) ----------
app.get('/admin/people', requireAdmin, (req, res) => {
  const q = (req.query.q || '').trim();
  let people;
  if (q) {
    const like = `%${q}%`;
    people = db.prepare(
      `SELECT * FROM applicants WHERE full_name LIKE ? OR email LIKE ? OR phone LIKE ?
       ORDER BY full_name COLLATE NOCASE`).all(like, like, like);
  } else {
    people = db.prepare('SELECT * FROM applicants ORDER BY full_name COLLATE NOCASE').all();
  }
  const approvedPhones = db.prepare(
    "SELECT full_name, phone FROM applicants WHERE status='approved' ORDER BY full_name COLLATE NOCASE").all();
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const signInUrl = base + '/login';
  const invites = db.prepare('SELECT * FROM invites WHERE used = 0 ORDER BY created_at DESC').all()
    .map(iv => ({ ...iv, link: `${base}/invite/${iv.token}` }));
  const newInviteLink = req.query.invite ? `${base}/invite/${req.query.invite}` : '';
  res.send(peoplePage({ people, q, approvedPhones, signInUrl, invites, newInviteLink, msg: req.query.msg || '', ann: annPanel(req.userEmail), dmUnread: unreadCount(req.userEmail), groupUnread: groupUnread(req.userEmail), groupMention: groupMentionUnread(req.userEmail, applicantIdOf(req.userEmail)) }));
});

// Roster CSV export (admin-only) — offline backup / spreadsheet analysis of the people
// list. One row per applicant; role is derived from the flags. RFC-4180 quoting, UTF-8
// BOM so Excel reads accented names correctly. Content-Disposition → browser downloads.
app.get('/admin/people/export.csv', requireAdmin, (req, res) => {
  const rows = db.prepare(
    `SELECT full_name, email, phone, status, is_team, is_regular, is_host, position,
            waiver_ok, email_optout, created_at
     FROM applicants ORDER BY full_name COLLATE NOCASE ASC`).all();
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                 // neutralize spreadsheet formula injection (a name like =HYPERLINK(...))
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const roleOf = (a) => a.is_host ? 'Host' : a.is_team ? 'Team' : a.is_regular ? 'Core' : '';
  const lines = [['Name', 'Email', 'Phone', 'Status', 'Role', 'Position', 'Waiver', 'Email opt-out', 'Applied'].join(',')];
  for (const a of rows) lines.push([
    a.full_name, a.email, a.phone, a.status, roleOf(a), a.position,
    a.waiver_ok ? 'yes' : 'no', a.email_optout ? 'yes' : 'no', a.created_at,
  ].map(cell).join(','));
  audit(req.userEmail, 'admin', 'people:export', String(rows.length));
  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Disposition', `attachment; filename="bridge-people-${stamp}.csv"`);
  res.type('text/csv').send('\uFEFF' + lines.join('\r\n')); // BOM = Excel reads UTF-8
});

// One form, two outcomes. Admin gives whatever they know (any/all of
// name/phone/email) plus a role. If that's enough to identify or fully create
// the person, they're approved immediately — no link needed. Otherwise a
// one-time invite link is created, pre-filled with whatever was given, so the
// player fills in the rest themselves.
app.post('/admin/people/invite', requireAdmin, (req, res) => {
  const full_name = (req.body.full_name || '').trim();
  const phone = (req.body.phone || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const role = req.body.role === 'team' ? 'team' : req.body.role === 'regular' ? 'regular' : '';
  const isTeam = role === 'team' ? 1 : 0;
  const isRegular = role === 'regular' ? 1 : 0;
  const roleLabel = role === 'team' ? ' as Team' : role === 'regular' ? ' as Core' : ' as approved';

  // The one remaining entry point that didn't validate the address — a malformed/list email
  // here would land straight in `applicants` and become a nodemailer bcc entry (the exact
  // shape EMAIL_RE guards elsewhere). Validate before create-or-invite.
  if (email && !isValidEmail(email))
    return res.redirect('/admin/people?msg=' + encodeURIComponent('That email did not look valid — double-check it and try again.'));

  if (email) {
    const existing = applicantByEmail(email);
    if (existing) {
      // Known email — approve immediately, no link needed. Only touch
      // status/role here; use Edit for contact-info changes.
      if (role) {
        db.prepare("UPDATE applicants SET status='approved', is_team=?, is_regular=? WHERE email=?")
          .run(isTeam, isRegular, email);
      } else {
        db.prepare("UPDATE applicants SET status='approved' WHERE email=?").run(email);
      }
      audit(req.userEmail, 'admin', `people:approve-existing${role ? ':' + role : ''}`, email);
      return res.redirect('/admin/people?msg=' + encodeURIComponent('That email existed — approved them' + (role ? roleLabel : '')));
    }
    if (full_name && phone) {
      // Everything needed for a full record — create approved right now.
      db.prepare(`INSERT INTO applicants (full_name,email,phone,experience,waiver_ok,status,is_team,is_regular)
                  VALUES (?,?,?,?,0,'approved',?,?)`).run(full_name, email, phone, 'Pre-approved', isTeam, isRegular);
      audit(req.userEmail, 'admin', `people:add-approved${role ? ':' + role : ''}`, email);
      return res.redirect('/admin/people?msg=' + encodeURIComponent('Added ' + full_name + roleLabel));
    }
  }

  // Missing something — generate a one-time link pre-filled with whatever was
  // given; the player fills in the rest and lands signed in.
  const token = crypto.randomBytes(18).toString('base64url');
  db.prepare('INSERT INTO invites (token,full_name,phone,email,role,created_by) VALUES (?,?,?,?,?,?)')
    .run(token, full_name, phone, email, role, req.userEmail);
  audit(req.userEmail, 'admin', 'invite:create', full_name || email || '(blank)');
  res.redirect('/admin/people?invite=' + token);
});

app.post('/admin/people/invite/revoke', requireAdmin, (req, res) => {
  const { token } = req.body;
  const iv = db.prepare('SELECT * FROM invites WHERE token = ? AND used = 0').get(token || '');
  if (iv) {
    db.prepare('DELETE FROM invites WHERE token = ?').run(token);
    audit(req.userEmail, 'admin', 'invite:revoke', iv.full_name || token.slice(0, 8));
  }
  res.redirect('/admin/people');
});

app.post('/admin/people/edit', requireAdmin, (req, res) => {
  const { id } = req.body;
  const full_name = (req.body.full_name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const phone = (req.body.phone || '').trim();
  const cur = db.prepare('SELECT email FROM applicants WHERE id = ?').get(id);
  if (!cur) return res.redirect('/admin/people');
  // Validate before writing — a blank name/phone or an invalid email would otherwise be
  // saved AND (if email changed) rekey every per-user row onto '' via rekeyEmailTx. Mirrors
  // the self-service /profile validation.
  if (!full_name || !phone || !isValidEmail(email))
    return res.redirect('/admin/people?msg=' + encodeURIComponent('Name, phone, and a valid email are required.'));
  // if email changed, make sure it doesn't collide
  if (email !== cur.email) {
    const clash = db.prepare('SELECT 1 FROM applicants WHERE email = ? AND id != ?').get(email, id);
    if (clash) return res.redirect('/admin/people?msg=That+email+is+already+in+use');
    // Never rekey a player onto an admin address — admin identity is the ADMINS
    // env set keyed by email, so this would silently grant them admin.
    if (ADMINS.includes(email)) return res.redirect('/admin/people?msg=' + encodeURIComponent('That email is reserved and can’t be assigned.'));
  }
  // Identity row + rekey cascade commit together or not at all — see the same guard on
  // /profile. A partial commit strands the player's history on the old address.
  try {
    transact(() => {
      db.prepare('UPDATE applicants SET full_name=?, email=?, phone=? WHERE id=?')
        .run(full_name, email, phone, id);
      // Carry EVERY per-user row to the new address (single source of truth: rekeyEmailTx in db.js).
      if (email !== cur.email) rekeyEmailTx(cur.email, email);
      // keep the denormalised check-in name in sync across every program (name can change without email)
      db.prepare('UPDATE checkins SET name=? WHERE email=?').run(full_name, email);
    });
  } catch (e) {
    console.error(`[admin] identity edit FAILED for ${cur.email}: ${e.message}`);
    return res.redirect('/admin/people?msg=' + encodeURIComponent('Couldn’t save that — nothing was changed.'));
  }
  if (email !== cur.email) refreshAvatarMap(); // avatar file follows the id; re-key its email in the map
  audit(req.userEmail, 'admin', 'people:edit', email);
  res.redirect('/admin/people?msg=Saved');
});

// Suspend / unsuspend a person (admin). Suspended = keeps account + history but can't
// check in or post (see /checkin/join + mutedOut). Suspending also drops any current
// check-in, offering a freed floor slot onward — a muted player shouldn't hold a spot.
app.post('/admin/people/suspend', requireAdmin, (req, res) => {
  const id = Number(req.body.id) || 0;
  const on = req.body.on === '1';
  const reason = (req.body.reason || '').trim().slice(0, 300);
  const cur = db.prepare('SELECT email FROM applicants WHERE id = ?').get(id);
  if (!cur) return res.redirect('/admin/people');
  db.prepare('UPDATE applicants SET suspended = ?, suspend_reason = ? WHERE id = ?')
    .run(on ? 1 : 0, on ? (reason || null) : null, id);
  if (on) {
    const runDate = nextRunDate();
    const offeree = offereeForFloorLeave(runDate, cur.email);
    db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1').run(runDate, cur.email);
    if (offeree) createOffer(runDate, offeree, req);
    // Suspension has to clear BOTH programs' floors. pkGate only blocks NEW pickleball
    // actions, so without this a suspended player keeps their seat all week and the
    // waitlist never promotes behind them.
    dropFromPickleball(cur.email);
  }
  audit(req.userEmail, 'admin', on ? 'people:suspend' : 'people:unsuspend', cur.email);
  res.redirect('/admin/people?msg=' + encodeURIComponent(on ? 'Suspended' : 'Unsuspended'));
});

app.post('/admin/people/delete', requireAdmin, (req, res) => {
  const { id } = req.body;
  const a = db.prepare('SELECT email, full_name, avatar FROM applicants WHERE id = ?').get(id);
  if (a) {
    // If they held a floor spot for the current run, offer it onward (capture before delete).
    const runDate = nextRunDate();
    const offeree = offereeForFloorLeave(runDate, a.email);
    db.prepare('DELETE FROM applicants WHERE id = ?').run(id);
    if (a.avatar) safeUnlinkAvatar(a.avatar); // delete their photo file on hard-delete
    db.prepare('DELETE FROM checkins WHERE email = ?').run(a.email);
    if (offeree) createOffer(runDate, offeree, req);
    db.prepare('DELETE FROM votes WHERE applicant_id = ?').run(id);      // votes cast ON them
    db.prepare('DELETE FROM votes WHERE voter_email = ?').run(a.email);  // and votes they cast — else a
    // same-email re-registration made team would resurrect years-old approve/reject tallies.
    // hard-delete is the ONLY path that removes attendance history. checkins (above) and
    // attendance are program-generic now, so one delete per table clears every program.
    db.prepare('DELETE FROM attendance WHERE email = ?').run(a.email);
    // Best-effort: delete any chat photo FILES this person uploaded (DM + group) before
    // dropping the rows. Keyed by message id in the DB, so we collect the image paths
    // first, then unlink. Stickers (/stickers/*) are shared assets → safeUnlinkChatImage
    // no-ops on them, so only real /chat-media uploads are removed.
    for (const r of db.prepare('SELECT image FROM messages WHERE (from_email = ? OR to_email = ?) AND image IS NOT NULL').all(a.email, a.email))
      safeUnlinkChatImage(r.image);
    // group messages can also carry voice/video uploads — clean all three media files
    // group_messages spans every program now, so this one sweep collects pickleball media too.
    for (const r of db.prepare('SELECT image, audio, video FROM group_messages WHERE from_email = ?').all(a.email)) {
      safeUnlinkChatImage(r.image); safeUnlinkChatImage(r.audio); safeUnlinkChatImage(r.video);
    }
    // purge messaging: their own reactions everywhere, reactions on their messages,
    // then their messages (both directions). Ordered so no orphaned rows survive,
    // independent of the FK cascade.
    db.prepare('DELETE FROM message_reactions WHERE from_email = ?').run(a.email);
    db.prepare('DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE from_email = ? OR to_email = ?)').run(a.email, a.email);
    db.prepare('DELETE FROM messages WHERE from_email = ? OR to_email = ?').run(a.email, a.email);
    // purge Run Chat: their own reactions everywhere, reactions on their messages,
    // their messages, and their read marker. Ordered so no orphan rows survive.
    db.prepare('DELETE FROM group_reactions WHERE from_email = ?').run(a.email);
    db.prepare('DELETE FROM group_reactions WHERE group_message_id IN (SELECT id FROM group_messages WHERE from_email = ?)').run(a.email);
    db.prepare('DELETE FROM group_messages WHERE from_email = ?').run(a.email);
    db.prepare('DELETE FROM group_reads WHERE email = ?').run(a.email);  // (email,program_id) PK → clears every program's marker
    db.prepare('DELETE FROM program_membership WHERE email = ?').run(a.email); // drop all per-program memberships
    db.prepare('DELETE FROM push_subscriptions WHERE email = ?').run(a.email);
    // Per-week sit-outs + announcement read/dismiss markers. These outlived the delete, which
    // both leaked rows forever and left a live PK-collision trap for anyone later rekeyed ONTO
    // this address (see rekeyEmailTx). Any unused sign-in link is revoked too — a delete the
    // admin just performed shouldn't leave a working magic link in an inbox.
    db.prepare('DELETE FROM regular_optout WHERE email = ?').run(a.email);  // program-generic → clears every program's sit-outs
    db.prepare('DELETE FROM announcement_reads WHERE email = ?').run(a.email);
    db.prepare('DELETE FROM announcement_dismissals WHERE email = ?').run(a.email);
    db.prepare('DELETE FROM login_tokens WHERE email = ?').run(a.email);
    refreshAvatarMap(); // drop them from the email→photo registry
    audit(req.userEmail, 'admin', 'people:delete', a.email);
  }
  res.redirect('/admin/people?msg=Deleted');
});

// Rollover + offer-expiry must fire even with ZERO viewers: the poll-and-patch
// clients no longer guarantee a periodic full-page /checkin GET to piggyback
// loadRun on. Prime lastRunDate at startup, then every 60s run the (gated) weekly
// rollover and drop/cascade any expired holds. req=null → createOffer's link falls
// back to PUBLIC_URL (kept set in .env), so offer emails carry the real Funnel URL.
// Auto open/close the check-in queue, keyed to the ACTUAL run day so it stays correct
// when the host moves the run. Opens at 5 PM TWO DAYS BEFORE the run (Mon for a Wed
// run), locks + auto-pings at 2 PM ON the run day. Each fires ONCE per cycle (a per-run
// flag), never fights a manual host toggle, and the OPEN ping goes ONLY to no-early-access
// regulars (Core/Team/Host already have early access).
function runStateSchedule() {
  const rd = nextRunDate();
  const closeAt = new Date(rd + 'T14:00:00').getTime();            // run day 2 PM — queue locks + auto-ping
  const openAt = new Date(openDateFor(rd) + hhLocal(OPEN_H)).getTime();
  return { rd, openAt, closeAt };
}
function autoRunState() {
  const { rd, openAt, closeAt } = runStateSchedule();
  const now = Date.now();
  // Auto-CLOSE + auto-PING at run-day 2 PM (once). Respects a host who already closed.
  // The queue locks here (runIsLocked); the floor is pinged to confirm/release.
  if (now >= closeAt) {
    if (getSetting('autoclose_done') !== rd) {
      setSetting('autoclose_done', rd);
      if (runIsOpen(rd)) { setRunOpen(rd, false); audit('system', 'system', 'run:autoclose', rd); console.log(`[autoclose] locked check-in for ${rd}`); }
      // Auto-ping every unconfirmed floor player to confirm or release (replaces the old manual button).
      if (!runIsCancelled(rd)) {
        const targets = partitionRun(rd).floorReal.filter(p => !p.guest && !p.confirmed_at).map(p => p.email);
        if (targets.length) setImmediate(() => sendPush(targets, {
          title: 'Confirm your spot for tonight',
          body: `You're on the floor for ${runLabelFor(rd)}. Tap to confirm you're coming — or Sit out to release your spot to the waitlist.`,
          url: '/checkin', tag: 'confirm',
        }));
        audit('system', 'system', 'confirm:autoping', String(targets.length));
        console.log(`[autoping] pinged ${targets.length} unconfirmed floor player(s) for ${rd}`);
      }
    }
    return;
  }
  // Auto-OPEN at Wednesday 5 PM (once), only before the close time.
  if (now >= openAt && getSetting('autoopen_done') !== rd) {
    setSetting('autoopen_done', rd);
    if (!runIsOpen(rd) && !runIsCancelled(rd)) { // never auto-open a cancelled run
      setRunOpen(rd, true); audit('system', 'system', 'run:autoopen', rd);
      const body = `Check-in is open for ${runWeekday(rd)}, ${runLabelFor(rd)} (${runTimeRange(rd)}) — grab your spot 🏀`;
      setImmediate(() => {
        sendPush(queueOpenPushEmails(), { title: 'Check-in is open', body, url: '/checkin', tag: 'queueopen' });
        if (emailConfigured) { const r = queueOpenEmailRecipients(); if (r.length) sendAnnouncement(r, body, 'system').catch(e => console.error(`[autoopen] email FAILED: ${e.message}`)); }
      });
      console.log(`[autoopen] opened check-in for ${rd}`);
    }
  }
}
// The boot-time weekly rollover runs BELOW, after buildPrograms() — ensureWeek → autoJoinTeam →
// seatRenewers reads P(1).config, so the PROGRAMS registry must be hydrated first. This 60s
// interval is safe as-is: it first fires ~60s in, long after buildPrograms() has run.
setInterval(() => {
  try {
    // Each program runs its own per-tick work via its registry tick() — program-generic, so a new
    // run is picked up with zero scheduler code change. id order (basketball, then pickleball)
    // preserves the original call sequence, and one try/catch keeps the original error semantics.
    for (const p of PROGRAMS.values()) p.tick();
  } catch (e) { console.error(`[interval] rollover/expiry FAILED: ${e.message}`); }
}, 60000).unref();

// This week's run as a calendar file (.ics). Floating local time; reflects the host's
// per-week day/time override. Cancelled → STATUS:CANCELLED so an already-added event clears.
app.get('/run.ics', requireLogin, (req, res) => {
  const rd = nextRunDate();
  const { start, end } = runTimesFor(rd);
  const dt = (hhmm) => rd.replace(/-/g, '') + 'T' + String(hhmm).replace(':', '') + '00';
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Bridge Adv Runs//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:bridge-run-${rd}@bridge`, `DTSTAMP:${ymdLocal().replace(/-/g, '')}T000000`,
    `DTSTART:${dt(start)}`, `DTEND:${dt(end)}`,
    'SUMMARY:Bridge Adv Runs — Basketball', 'LOCATION:The Bridge · Markham',
    runIsCancelled(rd) ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="bridge-run-${rd}.ics"`);
  res.send(ics);
});

// Season board — most runs this calendar year. Top list + the viewer's own rank; gentle
// by design (never spotlights the bottom). Approved players + admins only.
app.get('/season', requireLogin, (req, res) => {
  const a = applicantByEmail(req.userEmail);
  if (!a || (a.status !== 'approved' && !isAdmin(req.userEmail))) return res.redirect('/status');
  const rows = db.prepare(`SELECT at.email, COUNT(*) n, ap.full_name FROM attendance at
    LEFT JOIN applicants ap ON ap.email = at.email
    WHERE at.program_id = 1 AND at.run_date >= strftime('%Y-01-01','now') AND at.email NOT LIKE '%@guest.local'
    GROUP BY at.email ORDER BY n DESC, at.email ASC`).all();
  const named = rows.map((r, i) => ({ rank: i + 1, name: r.full_name || 'Member', n: r.n, me: r.email.toLowerCase() === req.userEmail.toLowerCase() }));
  res.send(seasonPage({ rows: named, email: a.email, dmUnread: unreadCount(a.email), groupUnread: groupUnread(a.email), groupMention: groupMentionUnread(a.email, a.id), ann: annPanel(a.email) }));
});

// ---------- PICKLEBALL (separate, hidden run — ISOLATED pk_* tables, no basketball impact) ----------
const PK_CAP = Number(process.env.PK_CAP || 20), PK_WAIT = Number(process.env.PK_WAIT || 4);
// Hoisted like their basketball twins (stmtRunIsOpen / stmtRun / stmtLatestAnnouncement) —
// node:sqlite has NO statement cache, so these re-compiled SQL on EVERY /poll tick for every
// signed-in viewer (pkProgramActive also runs on every /runs and /profile render).
const stmtPkActive = db.prepare('SELECT active FROM program WHERE id = 2');
const stmtPkIsOpen = db.prepare('SELECT is_open FROM run_state WHERE run_date = ? AND program_id = 2');
const stmtPkIsCancelled = db.prepare('SELECT cancelled FROM run_state WHERE run_date = ? AND program_id = 2');
const stmtPkRoster = db.prepare(`
    SELECT c.email, c.name, c.sort_order, c.id, c.confirmed_at,
           a.id AS applicant_id, a.is_host, a.is_team, a.is_regular
    FROM checkins c LEFT JOIN applicants a ON a.email = c.email
    WHERE c.run_date = ? AND c.program_id = ? ORDER BY c.sort_order ASC, c.id ASC`);
const stmtLatestPkAnnouncement = db.prepare('SELECT id, body, author, at AS created_at FROM announcements WHERE program_id = 2 AND COALESCE(archived,0) = 0 ORDER BY id DESC LIMIT 1');
function pkProgramActive() { const r = stmtPkActive.get(); return !!(r && r.active); }
// Pickleball's standing day = Tuesday (PK_DOW=2), DECOUPLED from basketball so moving the
// basketball run (RUN_DOW) never drags pickleball's date along. Weekly auto-schedule:
// check-in reopens right after the run ends (PK_END_H), the roster locks at start
// (PK_START_H), and the floor gets a confirm ping the night before (PK_PING_H, day before).
const PK_DOW = 2, PK_START_H = 18, PK_END_H = 20, PK_PING_H = 20, PK_PING_DOW_OFFSET = 1, PK_LOCK = '17:30';
// Season opener (YYYY-MM-DD) or null — same gate shape as basketball's seasonStart().
function pkSeasonStart() { const s = getSetting('pk_season_start'); return (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : null; }
// "6–8 PM" / "6 PM" — derived from the schedule constants, never written as a literal, so the
// masthead, the runs hub and the banner caption can't drift from the real hours.
const pkTimeRange = () => fmtClockRange(`${PK_START_H}:00`, `${PK_END_H}:00`);
const pkStartLabel = () => fmtClockLabel(`${PK_START_H}:00`);
// The standing weekday (dow) NEAREST a chosen date — the Tuesday a moved run replaces.
function pkNearestDow(dateStr, dow) {
  const r = new Date(dateStr + 'T12:00:00');
  const fwd = (dow - r.getDay() + 7) % 7;
  r.setDate(r.getDate() + (fwd <= 3 ? fwd : fwd - 7));
  return ymdLocal(r);
}
// The next standing Tuesday, local. Rolls to next week once the current run has ENDED
// (>= PK_END_H on run day) so check-in reopens the same night. Season-gated: pre-season it
// resolves to the first Tuesday on/after the opener (no phantom off-season runs).
function pkDefaultDate() {
  const now = new Date();
  let add = (PK_DOW - now.getDay() + 7) % 7;
  if (add === 0 && now.getHours() >= PK_END_H) add = 7;   // run's over tonight → next week
  const r = new Date(now); r.setDate(r.getDate() + add);
  let d = ymdLocal(r);
  // Skip a standing Tuesday whose run was MOVED to another day this week (pk_run_base) — else
  // once the moved run passes, this would resurrect that Tuesday as a phantom run (open+ping).
  const skip = getSetting('pk_run_base');
  if (skip && d === skip) { const s = new Date(d + 'T12:00:00'); s.setDate(s.getDate() + 7); d = ymdLocal(s); }
  const opener = pkSeasonStart();
  if (opener && d < opener) {   // pre-season → first standing day on/after the opener
    const o = new Date(opener + 'T12:00:00'); o.setDate(o.getDate() + ((PK_DOW - o.getDay() + 7) % 7));
    d = ymdLocal(o);
  }
  return d;
}
function pkRunDate() { return getSetting('pk_run_date') || pkDefaultDate(); } // manual per-week override; else the weekly standing Tuesday
function pkIsOpen(rd) { const r = stmtPkIsOpen.get(rd); return !!(r && r.is_open); }
function pkIsCancelled(rd) { const r = stmtPkIsCancelled.get(rd); return !!(r && r.cancelled); }
function pkSetState(rd, field, val) { db.prepare(`INSERT INTO run_state (run_date, ${field}, program_id) VALUES (?, ?, 2) ON CONFLICT(run_date, program_id) DO UPDATE SET ${field} = excluded.${field}`).run(rd, val ? 1 : 0); }
// Partition a SIMPLE (no offer-window) run's roster into floor / waitlist by sort order — the
// immediate first-come model (pickleball). Reads P(id).config.cap for the floor size; program-
// scoped roster query. pkPartition keeps the program-2 entry so its call sites are unchanged.
function simplePartition(programId, rd) {
  // Join applicants so the roster rows can open a profile popup + show role badges
  // (guests have no applicant row → applicant_id null → non-tappable, matches basketball).
  const rows = stmtPkRoster.all(rd, programId);
  const cap = P(programId).config.cap;
  return { floor: rows.slice(0, cap), wait: rows.slice(cap), rows };
}
function pkPartition(rd) { return simplePartition(2, rd); }
// Pickleball run start epoch — the run date at 6 PM local. Drives the countdown banner
// AND the auto-lock time (check-in closes at start).
function pkStartEpoch(rd) { return rd ? new Date(rd + `T${String(PK_START_H).padStart(2, '0')}:00:00`).getTime() : 0; }
// Latest LIVE pickleball announcement (program 2 rows in the shared announcements table; retracted ones archived).
function latestPkAnnouncement() { return stmtLatestPkAnnouncement.get() || null; }
// Pickleball MEMBERSHIP: you become a pickleball member by opening the run (GET /pickleball) —
// tracked in program_membership (program 2). Chat access, the members list, and the push
// audience all read from this, so being an approved BASKETBALL player alone doesn't grant it.
function pkJoinMembership(email) {
  if (!email || /@guest\.local$/.test(email)) return;
  db.prepare("INSERT OR IGNORE INTO program_membership (program_id, email, status, role) VALUES (2, ?, 'approved', 'approved')").run(email);
}
function pkIsMember(email) {
  if (!email) return false;
  if (isAdmin(email)) return true; // admins operate the run — always members
  return !!db.prepare('SELECT 1 FROM program_membership WHERE program_id = 2 AND email = ?').get(email);
}
// Push/announce audience = actual pickleball members (approved, non-guest). Not the whole club.
function pkMemberEmails() {
  return db.prepare(`SELECT pm.email FROM program_membership pm JOIN applicants a ON a.email = pm.email
    WHERE pm.program_id = 2 AND a.status = 'approved' AND a.email NOT LIKE '%@guest.local'`).all().map(r => r.email);
}
// Email audience = pickleball members who haven't opted out of announcement emails.
function pkEmailRecipients() {
  return db.prepare(`SELECT pm.email FROM program_membership pm JOIN applicants a ON a.email = pm.email
    WHERE pm.program_id = 2 AND a.status = 'approved' AND a.email NOT LIKE '%@guest.local' AND COALESCE(a.email_optout,0) = 0`).all().map(r => r.email);
}
// ---------- UNIFIED SEATING ENGINE (Phase 3c) ----------
// Seat a program's auto-renew members onto the floor for run `rd` (idempotent). ONE engine for
// every run — it reads P(id).config for the caps + the auto-renew ELIGIBILITY MODEL, so a new run
// is a config row, not cloned code. Two sources (config.autoRenew.from):
//   'members' — any opt-in member with program_membership.auto_renew (pickleball/volleyball). The
//               shared org team (applicants.is_team) is seated FIRST, then non-team members fill.
//   'team'    — only the org team auto-renews (basketball); auto_renew lives on applicants; NO
//               non-team fill. (Basketball wires here at its own cutover — pickleball switches first.)
// Team float above the floor via negative sort_order; a hard cap+waitlist trim drops the lowest
// (necessarily non-team) if team priority pushed anyone past. waiver_ok + not-suspended + this-week
// opt-out gate EVERY seat path — the auto-seat waiver hole, closed once, must not reopen generically.
function seatRenewers(programId, rd) {
  if (!rd) return 0;
  const cfg = P(programId).config, total = cfg.cap + cfg.waitlist;
  const insTeam = db.prepare('INSERT OR IGNORE INTO checkins (run_date, email, name, sort_order, program_id) VALUES (?,?,?,?,?)');
  const insR = db.prepare('INSERT OR IGNORE INTO checkins (run_date, email, name, program_id) VALUES (?,?,?,?)');
  let team = [], nonTeam = [];
  if (cfg.autoRenew.from === 'members') {
    const renewers = db.prepare(`SELECT pm.email, a.full_name, COALESCE(a.is_team,0) AS is_team
      FROM program_membership pm JOIN applicants a ON a.email = pm.email
      WHERE pm.program_id = ? AND pm.auto_renew = 1 AND a.status = 'approved' AND a.email NOT LIKE '%@guest.local'
        AND COALESCE(a.suspended,0) = 0 AND COALESCE(a.waiver_ok,0) = 1
        AND NOT EXISTS (SELECT 1 FROM regular_optout o WHERE o.run_date = ? AND o.email = pm.email AND o.program_id = ?)
      ORDER BY a.id`).all(programId, rd, programId);
    team = renewers.filter(r => r.is_team); nonTeam = renewers.filter(r => !r.is_team);
  } else { // 'team' — only the org team auto-renews (basketball); opt-out checked per-row (matches autoJoinTeam)
    const optedOut = db.prepare('SELECT 1 FROM regular_optout WHERE run_date = ? AND email = ? AND program_id = ?');
    team = db.prepare(`SELECT email, full_name FROM applicants
      WHERE is_team = 1 AND status = 'approved' AND auto_renew = 1 AND COALESCE(suspended,0) = 0 AND COALESCE(waiver_ok,0) = 1`)
      .all().filter(t => !optedOut.get(rd, t.email, programId));
  }
  let added = 0;
  // Team first, top priority — negative sort_order so they float above any first-come joiners.
  let { m } = db.prepare('SELECT MIN(sort_order) m FROM checkins WHERE run_date = ? AND program_id = ?').get(rd, programId);
  let order = (m ?? 0);
  for (const r of team) { order -= 1; if (insTeam.run(rd, r.email, r.full_name, order, programId).changes > 0) added++; }
  // Non-team renewers fill the remaining room up to cap + waitlist ('members' only; team-source leaves this empty).
  let room = total - db.prepare('SELECT COUNT(*) n FROM checkins WHERE run_date = ? AND program_id = ?').get(rd, programId).n;
  for (const r of nonTeam) { if (room <= 0) break; if (insR.run(rd, r.email, r.full_name, programId).changes > 0) { room--; added++; } }
  // Hard total cap: team priority may have pushed non-team past cap+wait — trim the lowest.
  const rows = db.prepare('SELECT id FROM checkins WHERE run_date = ? AND program_id = ? ORDER BY sort_order ASC, id ASC').all(rd, programId);
  if (rows.length > total) { const del = db.prepare('DELETE FROM checkins WHERE id = ?'); for (const r of rows.slice(total)) del.run(r.id); }
  return added;
}
// Shared by the scheduled auto-open AND the manual "Open check-in". Pickleball is on the unified
// seating engine (Phase 3c); basketball's autoJoinTeam converges at its own cutover.
function pkSeatRenewers(rd) { return seatRenewers(2, rd); }
// When a FLOOR player leaves, the next waitlister silently crosses onto the floor (pkPartition
// re-slices by order — pickleball has no offer/claim window, it's immediate first-come). Push
// that person so they actually know a spot opened. CALL THIS BEFORE deleting the leaver, passing
// their email — returns nothing, just notifies the promoted waitlister (if any, non-guest).
function pkNotifyPromotion(rd, leavingEmail) {
  const part = pkPartition(rd);
  if (!part.floor.some(p => p.email === leavingEmail)) return; // leaver was on the waitlist → no floor spot frees
  const next = part.wait[0];                                   // first waitlister → promoted once the leaver goes
  if (!next || /@guest\.local$/.test(next.email)) return;
  setImmediate(() => sendPush([next.email], { title: "You're in for pickleball 🥒", body: `A spot opened — you're on the floor for ${runWeekday(rd)}, ${runLabelFor(rd)} pickleball.`, url: '/pickleball', tag: 'pkpromo' }));
  audit('system', 'system', 'pk:promote', next.email);
}
// Pull someone off the pickleball floor for THIS cycle, promoting the waitlist behind them —
// the pickleball twin of the checkins delete + offer-onward that suspend/reject already do for
// basketball. Notify first: once the row is gone, pkNotifyPromotion can't tell a floor leaver
// from a waitlist leaver. Safe to call for someone who isn't on the roster (no-op).
function dropFromPickleball(email) {
  if (!email) return;
  const rd = pkRunDate();
  pkNotifyPromotion(rd, email);
  db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 2').run(rd, email);
}
// Weekly auto open/lock/ping for pickleball (runs on the shared 60s interval), keyed to the
// standing Tuesday (pkRunDate). Check-in OPENS the moment the prior run ends (PK_END_H the
// previous Tuesday) so members re-queue the same night, the floor gets a CONFIRM PING the
// night before (PK_PING_H, day before), and the roster LOCKS 30 min before start (PK_LOCK). Each
// fires once per cycle (app_settings markers keyed to rd). Season-gated + membership-scoped
// (only opt-in pickleball members are pushed — never the whole club). Skipped while hidden
// or cancelled. Manual open/close/date still work anytime.
function pkAutoRunState() {
  if (!pkProgramActive()) return;
  const rd = pkRunDate();
  if (!rd || pkIsCancelled(rd)) return;
  const opener = pkSeasonStart();
  if (opener && rd < opener) return;   // never fire before the season opener (pkRunDate is gated, this is belt-and-suspenders)
  const now = Date.now();
  const hh = hhLocal;
  const openAt = new Date(shiftYmd(rd, -7) + hh(PK_END_H)).getTime();          // prior run's end (prev Tue 9 PM) → reopen
  const pingAt = new Date(shiftYmd(rd, -PK_PING_DOW_OFFSET) + hh(PK_PING_H)).getTime(); // night before (Mon 8 PM)
  const lockAt = new Date(rd + 'T' + PK_LOCK + ':00').getTime();                // roster locks 30 min before start (Tue 5:30 PM)
  // OPEN (once) — from the prior run's end through lock.
  if (now >= openAt && now < lockAt && getSetting('pk_autoopen_done') !== rd) {
    setSetting('pk_autoopen_done', rd);
    if (!pkIsOpen(rd)) {
      pkSetState(rd, 'is_open', 1);
      const added = pkSeatRenewers(rd);
      audit('system', 'system', 'pk:autoopen', `${rd} +${added} auto`);
      setImmediate(() => sendPush(pkMemberEmails(), { title: 'Pickleball check-in is open', body: `Check-in is open for ${runWeekday(rd)}, ${runLabelFor(rd)} pickleball — grab your spot 🥒`, url: '/pickleball', tag: 'pkqueueopen' }));
      console.log(`[pk-autoopen] opened pickleball check-in for ${rd} (auto-added ${added})`);
    }
  }
  // CONFIRM PING (once) — the night before, ping unconfirmed floor to confirm or drop.
  if (now >= pingAt && now < lockAt && getSetting('pk_autoping_done') !== rd) {
    setSetting('pk_autoping_done', rd);
    if (pkIsOpen(rd) && !pkIsCancelled(rd)) {
      const floor = pkPartition(rd).floor.filter(p => !/@guest\.local$/.test(p.email) && !p.confirmed_at).map(p => p.email);
      if (floor.length) {
        setImmediate(() => sendPush(floor, { title: 'Confirm your pickleball spot', body: `You're on the floor for ${runWeekday(rd)} pickleball. Tap to confirm — or leave to free your spot.`, url: '/pickleball', tag: 'pkconfirm' }));
        audit('system', 'system', 'pk:autoping', String(floor.length));
        console.log(`[pk-autoping] pinged ${floor.length} unconfirmed pickleball floor player(s) for ${rd}`);
      }
    }
  }
  // LOCK (once) — at run start.
  if (now >= lockAt && getSetting('pk_autolock_done') !== rd) {
    setSetting('pk_autolock_done', rd);
    if (pkIsOpen(rd)) { pkSetState(rd, 'is_open', 0); audit('system', 'system', 'pk:autolock', rd); }
  }
}
// Access gate: approved players + admins. HIDDEN while program 2 is inactive → admins only.
function pkGate(req, res) {
  const a = applicantByEmail(req.userEmail);
  const admin = isAdmin(req.userEmail);
  if (!admin && (!a || a.status !== 'approved')) { res.redirect('/status'); return null; } // row-less admins allowed (matches requirePlayer)
  if (!pkProgramActive() && !admin) { res.status(404).send('Not found'); return null; } // hidden from everyone but admins
  return { a, admin, canOperate: admin }; // pickleball operator = admin for now (Daniel)
}
// Hoisted — pkEnsureWeek runs on every /runs + /pickleball GET, /pickleball/join, and the 60s tick.
const stmtPkPastDates = db.prepare('SELECT DISTINCT run_date FROM checkins WHERE program_id = 2 AND run_date <= ?');
const stmtPkArchiveIns = db.prepare('INSERT OR IGNORE INTO attendance (run_date, email, name, program_id) VALUES (?,?,?,2)');
const stmtPkDelCheckinsByDate = db.prepare('DELETE FROM checkins WHERE run_date = ? AND program_id = 2');
const stmtPkDelStateByDate = db.prepare('DELETE FROM run_state WHERE run_date = ? AND program_id = 2');
const stmtPkFloorForArchive = db.prepare('SELECT email, name FROM checkins WHERE run_date = ? AND program_id = 2 ORDER BY sort_order ASC, id ASC LIMIT ?');
const stmtPkSweepState = db.prepare('DELETE FROM run_state WHERE run_date < ? AND program_id = 2');
const stmtPkSweepOptout = db.prepare('DELETE FROM regular_optout WHERE run_date < ? AND program_id = 2');
// Lazy rollover (mirrors basketball's ensureWeek): once an EXPLICIT pk_run_date passes, archive
// the floor into attendance (program 2), purge past rows, and revert to the default (next basketball date).
function pkEnsureWeek() {
  const today = ymdLocal();
  const now = new Date();
  // A run counts as OVER once its end time (PK_END_H) passes on run day — so today's run is
  // archived that same night and the cycle rolls forward, letting check-in reopen at 8 PM.
  const endedToday = now.getHours() >= PK_END_H ? today : null;
  const isPast = rd => rd < today || rd === endedToday;
  // Archive + purge ANY finished pickleball run so the floor is recorded to attendance (program 2)
  // and stale rows never accumulate.
  const pastDates = stmtPkPastDates.all(today).map(r => r.run_date).filter(isPast);
  for (const rd of pastDates) {
    const floor = stmtPkFloorForArchive.all(rd, PK_CAP);
    for (const p of floor) if (!/@guest\.local$/.test(p.email)) stmtPkArchiveIns.run(rd, p.email, p.name);
    stmtPkDelCheckinsByDate.run(rd); stmtPkDelStateByDate.run(rd);
  }
  // Sweep stale run_state for past runs that had NO check-ins (a zero-join or cancelled week
  // never appears in pastDates above, so its is_open/cancelled row would leak forever).
  stmtPkSweepState.run(today);
  stmtPkSweepOptout.run(today);   // sit-outs are per-week → clear past ones so renewal resumes
  // Clear a passed explicit override back to the weekly standing day.
  const set = getSetting('pk_run_date');
  if (set && isPast(set)) delSetting('pk_run_date');
  // Clear a consumed standing-Tuesday skip once that Tuesday is itself past (see /pickleball/date).
  const base = getSetting('pk_run_base');
  if (base && base < today) delSetting('pk_run_base');
}
app.get('/pickleball', requireLogin, (req, res) => {
  const g = pkGate(req, res); if (!g) return;
  // Not a member yet (and not an admin, who operates it) → show a JOIN PROMPT instead of the
  // run. Membership is opt-in: you choose to join pickleball, separate from basketball approval.
  if (!pkIsMember(req.userEmail)) {
    const me = req.userEmail, mid = applicantIdOf(me);
    return res.send(pkJoinPage({ email: me, runDate: pkRunDate(), runLabel: runLabelFor(pkRunDate()),
      dmUnread: unreadCount(me), groupUnread: groupUnread(me), groupMention: groupMentionUnread(me, mid), ann: null }));
  }
  setRunCookie(req, res, 2); // a member opened pickleball → the neutral pages' Chat tab points here
  if (req.headers['x-prewarm'] !== '1') pkJoinMembership(req.userEmail); // ensure operators/host appear in the member list too (no-op for existing members)
  pkEnsureWeek();
  const rd = pkRunDate(), part = pkPartition(rd);
  const mine = part.rows.find(p => p.email === req.userEmail);
  const myState = mine ? (part.floor.indexOf(mine) >= 0 ? 'in' : 'waitlist') : 'out';
  const myWaitPos = myState === 'waitlist' ? part.wait.findIndex(p => p.email === req.userEmail) + 1 : 0;
  const myConfirmed = myState === 'in' && !!(mine && mine.confirmed_at);
  const iAutoRenew = !!(db.prepare('SELECT auto_renew FROM program_membership WHERE program_id = 2 AND email = ?').get(req.userEmail)?.auto_renew);
  const pkOpener = pkSeasonStart(), pkPre = !!pkOpener && ymdLocal() < pkOpener;
  res.send(pickleballPage({
    email: req.userEmail, runDate: rd, runLabel: runLabelFor(rd), isOpen: pkIsOpen(rd), cancelled: pkIsCancelled(rd),
    hours: pkTimeRange(), startLabel: pkStartLabel(),   // masthead + caption, derived like basketball's
    cap: PK_CAP, waitlistCap: PK_WAIT, going: part.floor.length, waiting: part.wait.length,
    canOperate: g.canOperate, isAdmin: g.admin, myState, myWaitPos, floorPlayers: part.floor, waitPlayers: part.wait, hidden: !pkProgramActive(),
    myConfirmed, iAutoRenew,
    bannerSrc: pkBannerSrc(), bannerVer: pkBannerVersion(),
    tipoff: pkStartEpoch(rd), announcement: latestPkAnnouncement(),
    season: pkOpener || '', seasonWeekday: pkOpener ? runWeekday(pkOpener) : '', seasonLabel: pkOpener ? runLabelFor(pkOpener) : '',
    preseason: pkPre, today: ymdLocal(), seasonMax: shiftYmd(ymdLocal(), 365),
    pkMsg: req.query.pkset ? String(req.query.pkset) : (req.query.pkerr || ''),
    dmUnread: unreadCount(req.userEmail), groupUnread: pkGroupUnread(req.userEmail), groupMention: pkGroupMentionUnread(req.userEmail, g.a ? g.a.id : 0), ann: null,
  }));
});
// Pickleball season-start gate control (operator = admin) — mirrors /admin/season. Sets/clears
// app_settings 'pk_season_start'; before it, no weekly pickleball runs and nothing auto-fires.
app.post('/pickleball/season', requireLogin, (req, res) => {
  const g = pkGate(req, res); if (!g) return;
  if (!g.canOperate) return res.redirect('/pickleball');
  const raw = String(req.body.season || '').trim();
  if (!raw) { db.prepare("DELETE FROM app_settings WHERE key = 'pk_season_start'").run(); audit(req.userEmail, 'admin', 'pk:season-clear', ''); return res.redirect('/pickleball?pkset=seasonoff'); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || isNaN(new Date(raw + 'T12:00:00'))) return res.redirect('/pickleball?pkerr=seasonbad');
  const today = ymdLocal();
  if (raw < today) return res.redirect('/pickleball?pkerr=seasonpast');
  const maxD = new Date(); maxD.setFullYear(maxD.getFullYear() + 1);
  if (raw > ymdLocal(maxD)) return res.redirect('/pickleball?pkerr=seasonrange');
  setSetting('pk_season_start', raw);
  // Clear rosters/state for pk runs between now and the opener — the pk twin of /admin/season's
  // cleanup. pk check-in auto-reopens + auto-seats renewers within a minute of each run ending,
  // so next Tuesday's roster is almost always populated; left in place, the next rollover archives
  // that stranded roster into attendance as phantom season-board credits. Only future runs.
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM checkins WHERE run_date > ? AND run_date < ? AND program_id = 2').run(today, raw);
    db.prepare('DELETE FROM regular_optout WHERE run_date > ? AND run_date < ? AND program_id = 2').run(today, raw);
    db.prepare('DELETE FROM run_state WHERE run_date > ? AND run_date < ? AND program_id = 2').run(today, raw);
    // A stale explicit pk_run_date/base pointing into the gap would still render as "next run"
    // (pkRunDate's override branch is NOT season-gated) — clear it when it falls before the opener.
    const setRd = getSetting('pk_run_date'); if (setRd && setRd < raw) delSetting('pk_run_date');
    const setBase = getSetting('pk_run_base'); if (setBase && setBase < raw) delSetting('pk_run_base');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); console.error(`[pk-season] roster cleanup FAILED: ${e.message}`); throw e; }
  audit(req.userEmail, 'admin', 'pk:season-set', raw);
  res.redirect('/pickleball?pkset=season');
});
// Join the pickleball RUN (membership) — the opt-in from the join prompt. Distinct from the
// per-week check-in below. Adds a program_membership row, then lands on the run.
app.post('/pickleball/join-run', requireLogin, (req, res) => {
  const g = pkGate(req, res); if (!g) return;
  pkJoinMembership(req.userEmail);
  setRunCookie(req, res, 2);
  res.redirect('/pickleball');
});
// "I'm coming" confirm — a floor player marks they're showing up (mirrors basketball).
app.post('/pickleball/confirm', requireLogin, (req, res) => {
  const g = pkGate(req, res); if (!g) return;
  const rd = pkRunDate(), part = pkPartition(rd);
  if (part.floor.some(p => p.email === req.userEmail)) {
    db.prepare("UPDATE checkins SET confirmed_at = datetime('now') WHERE run_date = ? AND email = ? AND program_id = 2 AND confirmed_at IS NULL").run(rd, req.userEmail);
  }
  res.redirect('/pickleball');
});
// Auto-renew toggle — a member opts their spot in/out of the weekly auto-add (self-service).
app.post('/pickleball/autorenew', requireLogin, (req, res) => {
  const g = pkGate(req, res); if (!g) return;
  if (!pkIsMember(req.userEmail)) return res.redirect('/pickleball');
  const on = req.body.on === '1' ? 1 : 0;
  if (on && (!g.a || !g.a.waiver_ok)) return res.redirect('/waiver?next=/pickleball'); // can't auto-seat without the waiver
  db.prepare('UPDATE program_membership SET auto_renew = ? WHERE program_id = 2 AND email = ?').run(on, req.userEmail);
  res.redirect('/pickleball');
});
// Pickleball season board — most pickleball runs this year, from attendance (program 2). Member-gated.
app.get('/pickleball/season', requireLogin, (req, res) => {
  const g = pkChatGate(req, res); if (!g) return; // members only (same bar as the chat)
  const me = req.userEmail;
  const rows = db.prepare(`SELECT at.email, COUNT(*) n, ap.full_name FROM attendance at
    LEFT JOIN applicants ap ON ap.email = at.email
    WHERE at.program_id = 2 AND at.run_date >= strftime('%Y-01-01','now') AND at.email NOT LIKE '%@guest.local'
    GROUP BY at.email ORDER BY n DESC, at.email ASC`).all();
  const named = rows.map((r, i) => ({ rank: i + 1, name: r.full_name || 'Member', n: r.n, me: r.email.toLowerCase() === me.toLowerCase() }));
  const a = applicantByEmail(me);
  res.send(seasonPage({
    rows: named, email: me, program: 2,
    title: 'Pickleball Season', subtitle: 'Most pickleball runs this calendar year 🥒',
    emptyMsg: 'No pickleball runs logged yet this season — get out there 🥒',
    dmUnread: unreadCount(me), groupUnread: pkGroupUnread(me), groupMention: pkGroupMentionUnread(me, a ? a.id : 0), ann: null,
  }));
});
// Add the pickleball run to a calendar (.ics). Floating local time; 6–8 PM.
app.get('/pickleball/run.ics', requireLogin, (req, res) => {
  const g = pkGate(req, res); if (!g) return;
  const rd = pkRunDate();
  const dt = (hhmm) => rd.replace(/-/g, '') + 'T' + hhmm + '00';
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Bridge Adv Runs//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:bridge-pk-${rd}@bridge`, `DTSTAMP:${ymdLocal().replace(/-/g, '')}T000000`,
    `DTSTART:${dt(String(PK_START_H).padStart(2, '0') + '00')}`, `DTEND:${dt(String(PK_END_H).padStart(2, '0') + '00')}`,
    'SUMMARY:The Bridge — Pickleball', 'LOCATION:The Bridge · Markham',
    pkIsCancelled(rd) ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="bridge-pickleball-${rd}.ics"`);
  res.send(ics);
});
app.post('/pickleball/join', requireLogin, (req, res) => {
  const g = pkGate(req, res); if (!g) return;
  if (!g.a || g.a.suspended) return res.redirect('/pickleball'); // need a profile to join; suspended can't (matches basketball)
  if (!g.a.waiver_ok) return res.redirect('/waiver?next=/pickleball'); // one-time waiver before first join
  pkEnsureWeek();
  const rd = pkRunDate();
  if (pkIsCancelled(rd) || !pkIsOpen(rd)) return res.redirect('/pickleball');
  const { rows } = pkPartition(rd);
  if (rows.length >= PK_CAP + PK_WAIT && !rows.find(p => p.email === req.userEmail)) return res.redirect('/pickleball'); // full
  // Taking a seat makes you a pickleball member — the same "opening the run joins you" rule the
  // GET /pickleball page applies. A direct POST skips that GET, so without this an approved
  // basketball player could seat themselves as a ghost: on the floor but absent from the member
  // list, chat audience, and check-in-open pushes. Idempotent + guest-safe.
  pkJoinMembership(req.userEmail);
  db.prepare('DELETE FROM regular_optout WHERE run_date = ? AND email = ? AND program_id = 2').run(rd, req.userEmail); // re-joining clears any sit-out
  db.prepare('INSERT OR IGNORE INTO checkins (run_date, email, name, program_id) VALUES (?,?,?,2)').run(rd, req.userEmail, g.a.full_name);
  res.redirect('/pickleball');
});
app.post('/pickleball/leave', requireLogin, (req, res) => {
  const g = pkGate(req, res); if (!g) return;
  const rd = pkRunDate();
  pkNotifyPromotion(rd, req.userEmail); // tell the next waitlister they're in (before the row goes)
  // Record a sit-out for THIS week so an auto-renew member who leaves isn't re-seated by a
  // later pkSeatRenewers (manual re-open) — mirrors basketball's regular_optout. Cleared when
  // they re-join, and purged on weekly rollover, so their standing renewal resumes next week.
  db.prepare('INSERT OR IGNORE INTO regular_optout (run_date, email, program_id) VALUES (?, ?, 2)').run(rd, req.userEmail);
  db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 2').run(rd, req.userEmail);
  res.redirect('/pickleball');
});
app.post('/pickleball/open', requireLogin, (req, res) => { const g = pkGate(req, res); if (!g || !g.canOperate) return res.redirect('/pickleball'); const rd = pkRunDate(); if (pkIsCancelled(rd)) return res.redirect('/pickleball'); /* un-cancel first — matches /checkin/open */ pkSetState(rd, 'is_open', 1); pkSeatRenewers(rd); res.redirect('/pickleball'); });
app.post('/pickleball/close', requireLogin, (req, res) => { const g = pkGate(req, res); if (!g || !g.canOperate) return res.redirect('/pickleball'); pkSetState(pkRunDate(), 'is_open', 0); res.redirect('/pickleball'); });
app.post('/pickleball/cancel', requireLogin, (req, res) => {
  const g = pkGate(req, res); if (!g || !g.canOperate) return res.redirect('/pickleball');
  const rd = pkRunDate(), on = req.body.on !== '0';
  pkSetState(rd, 'cancelled', on); if (on) { pkSetState(rd, 'is_open', 0); db.prepare('DELETE FROM checkins WHERE run_date = ? AND program_id = 2').run(rd); }
  res.redirect('/pickleball');
});
app.post('/pickleball/date', requireLogin, (req, res) => {
  const g = pkGate(req, res); if (!g || !g.canOperate) return res.redirect('/pickleball');
  const d = String(req.body.date || '').trim();
  const oldRd = pkRunDate();
  if (!d) {   // clear → back to the weekly standing Tuesday
    // Clearing the explicit date must MIGRATE any seated roster back onto the reverted
    // standing Tuesday, in ONE txn with the settings clear — exactly like basketball's
    // /admin/rundate reset (server.js ~3305/3321). Without this the roster is stranded on
    // the abandoned explicit date, and once that date passes pkEnsureWeek archives it into
    // `attendance` as a run that never happened (permanent phantom season-board credit).
    db.exec('BEGIN');
    try {
      db.prepare("DELETE FROM app_settings WHERE key IN ('pk_run_date','pk_run_base')").run();
      const newRd = pkDefaultDate();   // the reverted standing Tuesday (settings now cleared)
      if (newRd !== oldRd) {
        db.prepare('UPDATE checkins SET run_date = ? WHERE run_date = ? AND program_id = 2').run(newRd, oldRd);
        db.prepare('UPDATE OR IGNORE regular_optout SET run_date = ? WHERE run_date = ? AND program_id = 2').run(newRd, oldRd);
        const st = db.prepare('SELECT is_open, cancelled FROM run_state WHERE run_date = ? AND program_id = 2').get(oldRd);
        if (st) {
          db.prepare("INSERT INTO run_state (run_date, is_open, cancelled, program_id) VALUES (?,?,?,2) ON CONFLICT(run_date, program_id) DO UPDATE SET is_open = excluded.is_open, cancelled = excluded.cancelled").run(newRd, st.is_open, st.cancelled);
          db.prepare('DELETE FROM run_state WHERE run_date = ? AND program_id = 2').run(oldRd);
        }
        for (const k of ['pk_autoopen_done', 'pk_autoping_done', 'pk_autolock_done']) if (getSetting(k) === oldRd) setSetting(k, newRd);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); console.error(`[pk-date] clear FAILED: ${e.message}`); throw e; }
    return res.redirect('/pickleball?pkset=date');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(d + 'T12:00:00'))) return res.redirect('/pickleball?pkerr=datebad');
  const today = ymdLocal();
  if (d < today || (d === today && new Date().getHours() >= PK_END_H)) return res.redirect('/pickleball?pkerr=datepast'); // no past / already-ended today
  const maxD = new Date(); maxD.setDate(maxD.getDate() + 60);
  if (d > ymdLocal(maxD)) return res.redirect('/pickleball?pkerr=daterange');
  if (d !== oldRd) {
    // Migrate the roster + state + once-per-cycle markers old→new (like basketball's /admin/rundate),
    // and record the standing Tuesday this move consumes so it isn't resurrected as a phantom run.
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE checkins SET run_date = ? WHERE run_date = ? AND program_id = 2').run(d, oldRd);
      db.prepare('UPDATE OR IGNORE regular_optout SET run_date = ? WHERE run_date = ? AND program_id = 2').run(d, oldRd);
      const st = db.prepare('SELECT is_open, cancelled FROM run_state WHERE run_date = ? AND program_id = 2').get(oldRd);
      if (st) {
        db.prepare("INSERT INTO run_state (run_date, is_open, cancelled, program_id) VALUES (?,?,?,2) ON CONFLICT(run_date, program_id) DO UPDATE SET is_open = excluded.is_open, cancelled = excluded.cancelled").run(d, st.is_open, st.cancelled);
        db.prepare('DELETE FROM run_state WHERE run_date = ? AND program_id = 2').run(oldRd);
      }
      for (const k of ['pk_autoopen_done', 'pk_autoping_done', 'pk_autolock_done']) if (getSetting(k) === oldRd) setSetting(k, d);
      setSetting('pk_run_date', d);
      // The consumed standing Tuesday is the base of the cycle being MOVED — never the Tuesday
      // nearest the destination. Keying off `d` breaks whenever the run moves to a day AFTER its
      // Tuesday (e.g. Tue 09-08 → Sat 09-12 resolves to 09-15), which marks the NEXT week's run
      // consumed and silently deletes it. Once moved, the base is already recorded — keep it.
      setSetting('pk_run_base', getSetting('pk_run_base') || pkNearestDow(oldRd, PK_DOW));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); console.error(`[pk-date] move FAILED: ${e.message}`); throw e; }
  }
  res.redirect('/pickleball?pkset=date');
});
app.post('/pickleball/guest', requireLogin, (req, res) => {
  const g = pkGate(req, res); if (!g || !g.canOperate) return res.redirect('/pickleball');
  const rd = pkRunDate(); if (pkIsCancelled(rd)) return res.redirect('/pickleball');
  const name = (req.body.name || '').trim().slice(0, 60);
  if (name) {
    // Double-tap guard, same as basketball's /checkin/guest: each guest gets a fresh random
    // @guest.local email, so there's no UNIQUE to catch a re-post — two taps would silently
    // eat two floor spots.
    if (db.prepare("SELECT 1 FROM checkins WHERE run_date=? AND name=? AND program_id = 2 AND created_at > datetime('now','-5 seconds')").get(rd, name + ' (guest)'))
      return res.redirect('/pickleball');
    const { rows } = pkPartition(rd);
    if (rows.length < PK_CAP + PK_WAIT) {
      const em = `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@guest.local`;
      db.prepare('INSERT INTO checkins (run_date, email, name, program_id) VALUES (?,?,?,2)').run(rd, em, name + ' (guest)');
    }
  }
  res.redirect('/pickleball');
});
app.post('/pickleball/remove', requireLogin, (req, res) => { const g = pkGate(req, res); if (!g || !g.canOperate) return res.redirect('/pickleball'); const rd = pkRunDate(), em = String(req.body.email || '').toLowerCase(); pkNotifyPromotion(rd, em); db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 2').run(rd, em); res.redirect('/pickleball'); });
app.post('/pickleball/bump', requireLogin, (req, res) => { const g = pkGate(req, res); if (!g || !g.canOperate) return res.redirect('/pickleball'); const rd = pkRunDate(); if (pkIsCancelled(rd)) return res.redirect('/pickleball'); const row = db.prepare('SELECT MIN(sort_order) m FROM checkins WHERE run_date = ? AND program_id = 2').get(rd); db.prepare('UPDATE checkins SET sort_order = ? WHERE run_date = ? AND email = ? AND program_id = 2').run(((row && row.m) || 0) - 1, rd, String(req.body.email || '').toLowerCase()); res.redirect('/pickleball'); });
app.post('/pickleball/publish', requireAdmin, (req, res) => { db.prepare('UPDATE program SET active = ? WHERE id = 2').run(req.body.on === '0' ? 0 : 1); audit(req.userEmail, 'admin', req.body.on === '0' ? 'pk:hide' : 'pk:publish', ''); res.redirect('/pickleball'); });
// Post a pickleball announcement — operator only. Stored in announcements (program 2)
// table, pushed to pickleball members' phones (and emailed if SMTP is set), separate from
// basketball announcements. Shown as a banner on the pickleball page.
app.post('/pickleball/announce', requireLogin, (req, res) => {
  const g = pkGate(req, res); if (!g || !g.canOperate) return res.redirect('/pickleball');
  const body = (req.body.body || '').trim().slice(0, 1000);
  if (!body) return res.redirect('/pickleball');
  if (rateLimited('pk-announce', req.userEmail, 6, 10 * 60 * 1000)) return res.redirect('/pickleball');
  const author = (g.a && g.a.full_name) || req.userEmail;
  // Same-body/same-author within 10s = a double-tap, not a second announcement. The 6-per-10-min
  // rate limit is far too coarse to catch it, and each duplicate costs every member a second
  // push AND a second email blast. Mirrors basketball's /announce guard.
  if (db.prepare("SELECT 1 FROM announcements WHERE program_id = 2 AND body = ? AND author = ? AND at >= datetime('now','-10 seconds') LIMIT 1").get(body, author))
    return res.redirect('/pickleball');
  db.prepare('INSERT INTO announcements (body, author, program_id) VALUES (?,?,2)').run(body, author);
  audit(req.userEmail, 'admin', 'pk:announce', body.slice(0, 60));
  // Push is the always-on app-native channel (every pk member's phone), independent of email.
  setImmediate(() => sendPush(pkMemberEmails(), { title: 'Pickleball announcement', body: body.slice(0, 140), url: '/pickleball', tag: 'pkann' }));
  // Email is OPT-IN per post (default off) — the operator ticks "Also email everyone", exactly
  // like basketball's /announce. Recipients still honour the per-player email opt-out.
  if (req.body.email_everyone && emailConfigured) {
    setImmediate(() => {
      try { const r = pkEmailRecipients(); if (r.length) sendAnnouncement(r, body, author).catch(e => console.error(`[pk-announce] email FAILED: ${e.message}`)); }
      catch (e) { console.error(`[pk-announce] email prep FAILED: ${e.message}`); }
    });
  }
  res.redirect('/pickleball');
});
// Retract the current pickleball announcement — operator only. Archives it so it stops
// showing on the page (no new push/email; the original notification already went out).
app.post('/pickleball/announce/retract', requireLogin, (req, res) => {
  const g = pkGate(req, res); if (!g || !g.canOperate) return res.redirect('/pickleball');
  const cur = latestPkAnnouncement();
  if (cur) { db.prepare('UPDATE announcements SET archived = 1 WHERE id = ? AND program_id = 2').run(cur.id); audit(req.userEmail, 'admin', 'pk:announce:retract', String(cur.id)); }
  res.redirect('/pickleball');
});

// Terminal error handler — a sync throw (or a forwarded async reject via next(e)) in any route
// lands here with a 500 instead of a hung socket. Must be the LAST app.use (4-arg signature).
app.use((err, req, res, next) => {
  console.error(`[route-error] ${req.method} ${req.originalUrl}: ${(err && err.stack) || err}`);
  if (res.headersSent) return next(err);
  res.status(500).send('Something went wrong on our end. Please try again in a moment.');
});
// Last resort: a stray unhandled promise rejection must NOT exit the process (Node's default),
// which would drop check-in for everyone mid-run. Log it and keep serving.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', (reason && reason.stack) || reason);
});
// Symmetric backstop for a stray synchronous throw that escapes a callback (e.g. inside a
// setImmediate push/email task) — log loudly and keep serving rather than exiting mid-run.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', (err && err.stack) || err);
});

// ---------- PROGRAM REGISTRY HYDRATION ----------
// Per-program presentation + engine dispatch. Phase 1: each entry still routes to today's
// basketball / pickleball functions — the registry exists so nothing hardcodes "1 vs 2". A
// later phase folds these two DEFS into a single config-driven engine (config_json /
// program_settings land with that schema work, when there's a real consumer + editor).
const PROGRAM_DEFS = {
  1: {
    key: 'basketball', emoji: '🏀', displayName: 'Basketball', alwaysActive: true,
    paths: { run: '/checkin', chat: '/chat', season: '/season' }, seasonLabel: 'Season board',
    // Per-program config (Phase 3a foundation): the single source the unified engine will read
    // so a new run = a config row, not cloned code. Capacities are HOST-EDITABLE at runtime
    // (app_settings via reloadRunSettings), so they're getters — a snapshot would go stale on the
    // next Council settings save. Nothing consumes this yet (0-diff); the engine merge wires it in.
    config: {
      get cap() { return CAP; }, get waitlist() { return WAITLIST_CAP; }, get prereg() { return PREREG_CAP; },
      dow: RUN_DOW, start: DEFAULT_START, end: DEFAULT_END,          // Wed 8:30–10:30 PM
      openDaysBefore: OPEN_DAYS_BEFORE, openHour: OPEN_H, lockTime: '14:00',
      theme: 'default', access: 'apply', approval: 'council',
      tiers: ['team', 'core', 'host'], offerWindow: true,
      autoRenew: { from: 'team' },   // only the org team (applicants.is_team) auto-renews; no non-team fill
      mentionTag: 'mention', chatSeqKey: 'chat_seq',   // push-dedup tag + app_settings key for this room
      features: { teams: false, groupQueue: false },
    },
    unread: (email, aid) => ({ group: groupUnread(email), gm: groupMentionUnread(email, aid) }),
    hubCard: (req) => {
      const bb = loadRun(req);
      return {
        runDate: bb.runDate, dateLabel: runLabelFor(bb.runDate), timeLabel: runTimeRange(bb.runDate),
        going: bb.inPlayers.length + bb.offeredPlayers.length, cap: CAP,
        status: runIsCancelled(bb.runDate) ? 'cancelled' : (runIsOpen(bb.runDate) ? 'open' : 'closed'),
        hidden: false,
      };
    },
    // Per-tick work for the 60s scheduler loop: rollover + offer-expiry + auto open/close.
    tick: () => { const rd = nextRunDate(); ensureWeek(rd); expireAndReoffer(rd, null); autoRunState(); },
  },
  2: {
    key: 'pickleball', emoji: '🥒', displayName: 'Pickleball',
    paths: { run: '/pickleball', chat: '/pickleball/chat', season: '/pickleball/season' }, seasonLabel: 'Pickleball season',
    // Pickleball config: fixed cap/waitlist (not host-editable today), own Tue schedule, teal 'pk'
    // theme, opt-in access, team-only tier (no core). Matches today's PK_* constants exactly.
    config: {
      cap: PK_CAP, waitlist: PK_WAIT, prereg: 0,
      dow: PK_DOW, startHour: PK_START_H, endHour: PK_END_H,         // Tue 6–8 PM
      pingHour: PK_PING_H, pingDowOffset: PK_PING_DOW_OFFSET, lockTime: PK_LOCK,
      theme: 'pk', access: 'opt-in', approval: 'invite',
      tiers: ['team', 'host'], offerWindow: false,
      autoRenew: { from: 'members' },   // any opt-in member (program_membership.auto_renew) renews; team seated first, then non-team fill
      mentionTag: 'pkmention', chatSeqKey: 'pk_chat_seq',
      features: { teams: false, groupQueue: false },
    },
    unread: (email, aid) => ({ group: pkGroupUnread(email), gm: pkGroupMentionUnread(email, aid) }),
    hubCard: () => {
      pkEnsureWeek();
      const rd = pkRunDate(), part = pkPartition(rd);
      return {
        runDate: rd, dateLabel: runLabelFor(rd), timeLabel: pkTimeRange(),
        going: part.floor.length, cap: PK_CAP,
        status: pkIsCancelled(rd) ? 'cancelled' : (pkIsOpen(rd) ? 'open' : 'closed'),
        hidden: !pkProgramActive(),
      };
    },
    // Pickleball has no offer window, so its tick is just rollover + auto open/ping/lock.
    tick: () => { pkEnsureWeek(); pkAutoRunState(); },
  },
};
const stmtProgActiveById = db.prepare('SELECT active FROM program WHERE id = ?');
function buildPrograms() {
  PROGRAMS.clear();
  for (const row of db.prepare('SELECT * FROM program ORDER BY id').all()) {
    const def = PROGRAM_DEFS[row.id];
    if (!def) continue; // only runs with a known engine are mounted this phase (Phase 3 generalizes)
    PROGRAMS.set(row.id, {
      id: row.id, key: def.key, emoji: def.emoji, displayName: def.displayName,
      paths: def.paths, seasonLabel: def.seasonLabel, config: def.config,
      active: def.alwaysActive ? (() => true) : (() => !!(stmtProgActiveById.get(row.id) || {}).active),
      unread: def.unread, hubCard: def.hubCard, tick: def.tick,
    });
  }
  // Hand the view layer the presentation subset so it renders run-aware links (Chat tab href,
  // season link) without hardcoding paths — the server is the single source of program truth.
  const meta = {};
  for (const [id, p] of PROGRAMS) meta[id] = { chat: p.paths.chat, season: p.paths.season, seasonLabel: p.seasonLabel };
  setProgramMeta(meta);
}
buildPrograms();
// Boot-time weekly rollover (archive/purge/auto-seat) — MUST run after buildPrograms() so the
// unified engine's P(id).config is hydrated (ensureWeek → autoJoinTeam → seatRenewers reads it).
ensureWeek(nextRunDate());

app.listen(PORT, () => {
  console.log(`\nThe Bridge Adv Runs → http://localhost:${PORT}`);
  console.log(`Cap: ${CAP} · Email: ${emailConfigured ? 'SMTP configured' : 'DEV MODE (links print here)'}`);
  console.log(`Admin emails: ${process.env.ADMIN_EMAILS || '(none set — set ADMIN_EMAILS!)'}\n`);
  startBackups(); // snapshot the DB now + once a day
  pruneOldMedia(); pruneAuditLog();
  setInterval(() => { pruneOldMedia(); pruneAuditLog(); }, 24 * 60 * 60 * 1000).unref(); // media (1yr) + audit_log (5000) retention, boot + daily
});
