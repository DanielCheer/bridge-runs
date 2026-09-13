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
import {
  pcoTick, pcoDaily, pcoStatus, pcoConnect, pcoDisconnect, pcoSetAutocreate,
  pcoRunInitialLink, pcoCreateBridgeOnly, pcoQueuePatch, pcoHandleWebhook,
  pcoReconcile, pcoKioskArrivals, pcoVerifyPasses, pcoBarcodeRows, pcoVerifyWaivers, pcoSetWaiverForm,
  pcoSaveOAuthApp, pcoOAuthStartUrl, pcoOAuthCallback, pcoOAuthConfigured, pcoSetNotifier, pcoFieldsPending,
  pcoSetRosterProvider,
  pcoPushFields, pcoSetAttendanceFields, pcoSetWaiverFields, pcoSetProgramLabels,
  pcoGroupRoster, pcoConnected, pcoSignupRosterForDate,
} from './pco.js';
import webpush from 'web-push';
import {
  setSession, clearSession, currentUser, isAdmin,
  requireLogin, requireAdmin, makeRequireApprover, makeRequireCouncil, ADMINS, setSessionVersionLookup,
} from './auth.js';
import {
  intakePage, loginPage, checkinPage, adminPage, statusPage, peoplePage, invitePage, sharePage, exportPage, logoutPage, APP_JS,
  chatPage, chatOlderFragment, profilePage, profileTabPage, threadPage, claimResultPage, BUILD_VER, setAvatarMap, setProgramMeta,
  STICKERS, avatarUrlFor, mdToHtml, legalPage, bannerPage, confirmActionPage, seasonPage, profileCard, demoProfileCard, pickleballPage, runPage, runsPage, pkJoinPage, runJoinPage, pastRunPage, waiverPage,
  friendsPage, friendsSearchFragment, chatLockedPage, runChatPage, pcoAdminPage, programsAdminPage, kioskPage, analyticsPage, auditViewerPage, runHistoryPage,
  ladderPage, ladderBoardPage, teamsBoardPage, leaderboardPage,
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
const requireCouncil = makeRequireCouncil(db);   // /admin + /admin/vote only — the council's one surface

// Prepared once at module scope — node:sqlite has no statement cache, so re-preparing
// this INSERT on every audited action (every check-in, vote, edit…) is pure waste.
const stmtAudit = db.prepare('INSERT INTO audit_log (actor,actor_role,action,target) VALUES (?,?,?,?)');
const stmtAnnouncementExists = db.prepare('SELECT 1 FROM announcements WHERE id = ? AND program_id = 1');
function audit(actor, actorRole, action, target) {
  stmtAudit.run(actor, actorRole, action, target || '');
  // KEY events also land in the never-pruned table: audit_log keeps only the newest 5000 rows, so
  // the legally-interesting subset (waiver attestations/verifications, role grants, sign-out-all,
  // admin logins, PCO connects) would otherwise age out while the state it explains lives on.
  if (KEY_EVENT_RE.test(action)) stmtAuditKey.run(actor, actorRole, action, target || '');
}
const KEY_EVENT_RE = /^(waiver:|people:waiver|admin:role|role:|people:approve|people:delete|people:suspend|invite:claimed|session:|pco:connected|pco:oauth-connected|pco:disconnected|kiosk:token-rotated|program:(create|delete|host-granted|host-revoked|request-approved|request-declined|member-added|member-removed))/;   // role: = team/Pillar/host/council toggles — who holds power is exactly what S6 keeps forever
const stmtAuditKey = db.prepare('INSERT INTO audit_key_events (actor,actor_role,action,target) VALUES (?,?,?,?)');
// ---- metrics layer (2026-08-03): append-only product events, identity-free ----
// One insert per event, never on a hot read path, and NEVER an email in the row — kinds, counts
// and run keys only. A metrics failure must never break the action it measures: fail-loud to the
// console, swallow the throw. (Not audit(): these are product stats, not an accountability trail.)
const stmtMetric = db.prepare('INSERT INTO metrics_events (kind, program_id, run_date, n, meta) VALUES (?,?,?,?,?)');
function metric(kind, { programId = null, runDate = null, n = 1, meta = '' } = {}) {
  try { stmtMetric.run(kind, programId, runDate, n, String(meta).slice(0, 120)); }
  catch (e) { console.error(`[metrics] ${kind} write failed: ${e.message}`); }
}

// Sign-in wrapper for the REAL login sites (magic link, code, invite claim, offer-claim sign-in) —
// NOT the per-request cookie refresh or the profile email re-sign. An admin account signing in
// anywhere pings that admin's own devices: with sessions this long-lived, "someone else logged in
// as me" must be visible in seconds, not discovered by accident.
function signIn(res, email, how) {
  setSession(res, email);
  if (isAdmin(email)) {
    audit(email, 'admin', 'session:admin-login', how);
    setImmediate(() => sendPush([String(email).toLowerCase()], {
      title: 'Admin sign-in',
      body: `Your admin account just signed in (${how}). Wasn't you? Profile → Sign out everywhere.`,
      url: '/profile', tag: 'adminlogin',
    }));
  }
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
  WHERE a.archived = 0 AND COALESCE(a.pending,0) = 0 AND a.program_id = 1 ORDER BY a.id DESC LIMIT 1`); // authorName resolves the poster's email → name
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
// Door check-in mode (the PCO Check-Ins hybrid): the physical door tap IS the confirmation, so
// the in-app "✓ I'm coming" step disappears everywhere — no run-day ping, no confirm-or-release
// sweep, no button (views key off confirmBy === ''). One admin toggle on /admin/pco, read LIVE
// at every site through effectiveConfirmCutoff(), so flipping it needs no restart or config edit.
const doorMode = () => getSetting('pco_door_mode') === '1';
const effectiveConfirmCutoff = (cutoff) => (doorMode() ? null : (cutoff || null));
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
    WHERE a.program_id = 1 AND COALESCE(a.pending,0) = 0 AND a.id NOT IN (SELECT announcement_id FROM announcement_dismissals WHERE email = ?)
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
  WHERE a.program_id = 1 AND COALESCE(a.pending,0) = 0 AND a.id > ?
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
  VALUES (?, (SELECT COALESCE(MAX(id),0) FROM announcements WHERE program_id = 1 AND COALESCE(pending,0) = 0), datetime('now'))
  ON CONFLICT(email) DO UPDATE SET
    last_seen_id = (SELECT COALESCE(MAX(id),0) FROM announcements WHERE program_id = 1 AND COALESCE(pending,0) = 0),
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
  // The voting pool = explicit council members (owner rule 2026-08-06: council is its own role,
  // separate from team/host/admin; the migration seeded it from team-minus-host so nobody lost
  // their vote on the flip).
  return new Set(
    db.prepare('SELECT email FROM applicants WHERE is_council = 1').all()
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
      db.prepare('DELETE FROM checkins WHERE email = ? AND program_id = 1').run(app.email); // basketball floor only; the cascade below handles every other program
      if (offeree) createOffer(runDate, offeree, null);
      dropFromPickleball(app.email);   // a rejected player leaves EVERY opt-in program's floor (P2-2)
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
// One proxy hop in front of us (Tailscale Funnel terminates TLS). This makes req.protocol/req.ip
// reflect the real client, which the rate-limit bucketing and Secure-cookie semantics assume.
app.set('trust proxy', 1);
// Security headers (S2). No CSP yet — the app's inline scripts/handlers would need a full nonce
// refactor, and a hollow 'unsafe-inline' policy is a false badge; do it properly or not at all.
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');                        // nothing here belongs in an iframe (clickjacking)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');  // mic: voice notes
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');       // 180d; https-only (harness runs plain http)
  next();
});
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
// Piggybacked engagement pulse (metrics layer): the SAME resolved identity feeds two throttled
// touches — last_seen_at at most once per LOCAL day per account (in-memory day map; a restart
// costs one extra write per user), and a push_tap row when the SW-appended ?from=push marker
// arrives. No other request writes anything — /poll's zero-write contract holds after the first
// touch of the day.
const lastSeenDay = new Map();
const stmtTouchSeen = db.prepare("UPDATE applicants SET last_seen_at = datetime('now','localtime') WHERE email = ?");
app.use((req, res, next) => {
  const email = currentUser(req);
  if (email) {
    setSession(res, email);
    const d = ymdLocal();
    if (lastSeenDay.get(email) !== d) {
      lastSeenDay.set(email, d);
      try { stmtTouchSeen.run(email); } catch (e) { console.error(`[metrics] last-seen touch failed: ${e.message}`); }
    }
    if (req.query.from === 'push' && !rateLimited('push_tap', email, 40, 24 * 3600 * 1000)) {
      // meta = "tag|path" when the SW passed the notification tag (charset-stripped: our tags are
      // plain slugs; a hostile ?tag= can't smuggle an identity into the identity-free table).
      const tg = String(req.query.tag || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
      metric('push_tap', { meta: (tg ? tg + '|' : '') + String(req.path).slice(0, 78) });   // P3-5 cap: real taps are a handful/day
    }
  }
  next();
});

// PWA install beacon (metrics layer): the client fires navigator.sendBeacon here on the
// `appinstalled` event — the only way the server ever learns an install happened. Signed-in
// only (beacons carry same-origin cookies) so an anonymous crawler can't inflate the count;
// no identity is stored, just the fact.
app.post('/metrics/install', (req, res) => {
  const who = currentUser(req);
  // P3-5: a member re-installs at most a couple of times ever — 3/day per account keeps a
  // hostile beacon loop from inflating the count or growing metrics_events unbounded.
  if (who && !rateLimited('metric_install', who, 3, 24 * 3600 * 1000)) metric('pwa_install');
  res.status(204).end();
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
// Test seam: override "now" for the auto-scheduler so its clock phases (auto open/ping/lock) are
// drivable in tests. Unset in prod → real Date.now(). Precedent: FORCE_HELD_RELEASED.
const TEST_NOW = (process.env.TEST_NOW && !isNaN(new Date(process.env.TEST_NOW).getTime())) ? new Date(process.env.TEST_NOW).getTime() : null;
function schedNow() { return TEST_NOW != null ? TEST_NOW : Date.now(); }
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];  // dow → standing-day label
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
// Confirm-or-release cutoff lives in EACH program's config as an absolute 'HH:MM'
// (config.confirmCutoff, e.g. '16:30') — change it there, never here. The run-day 9 AM ping
// and the run-page note both derive their copy from it.
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
// sharp-crop to the final 2320×1102 (40:19). BANNER_PATH is env-overridable (tests point elsewhere).
// ONE root for every program's banner file. Previously each program hardcoded its own path into
// `public/`, so volleyball's and any in-app-created program's banner had NO env override at all —
// a test that uploaded a banner would overwrite an image the LIVE server serves immediately. Now
// there is a single writable location for the guard to verify and for the harness to redirect.
const BANNER_DIR = process.env.BANNER_DIR || path.join(__dirname, 'public');
fs.mkdirSync(BANNER_DIR, { recursive: true });   // a redirected banner dir may not exist yet (matches AVATARS_DIR/CHAT_MEDIA_DIR)
const bannerFile = (name) => path.join(BANNER_DIR, name);
const BANNER_PATH = process.env.BANNER_PATH || bannerFile('gym.jpg');
const uploadBanner = multer({ storage: multer.memoryStorage(), limits: { fileSize: 14 * 1024 * 1024, files: 1 } }).single('photo');
// Cache-bust token = the banner file's mtime, so an upload busts the <img> the moment it's
// saved (no restart, no manual version bump). Falls back to a constant if the file is absent.
function bannerVersion() {
  try { return String(Math.floor(fs.statSync(BANNER_PATH).mtimeMs)); } catch { return '0'; }
}
// Pickleball gets its OWN banner photo (pk-banner.jpg); until one is uploaded it falls back
// to the basketball court photo, so the page always shows something.
const PK_BANNER_PATH = process.env.PK_BANNER_PATH || bannerFile('pk-banner.jpg');
// Banner (own uploaded photo else the shared gym.jpg) — program-generic; the file path + public URL
// come from config.bannerPath/bannerPublic. pk* names stay wrappers.
function bannerHasOwnFor(programId) { try { return fs.statSync(P(programId).config.bannerPath).size > 0; } catch { return false; } }
function bannerSrcFor(programId) { return bannerHasOwnFor(programId) ? P(programId).config.bannerPublic : '/gym.jpg'; }
function bannerVersionFor(programId) { const cfg = P(programId).config; try { return String(Math.floor(fs.statSync(bannerHasOwnFor(programId) ? cfg.bannerPath : BANNER_PATH).mtimeMs)); } catch { return '0'; } }
function pkBannerHasOwn() { return bannerHasOwnFor(2); }
function pkBannerSrc() { return bannerSrcFor(2); }
function pkBannerVersion() { return bannerVersionFor(2); }
// Write a file ATOMICALLY: full write to a temp path, then rename over the target. rename is atomic
// on one filesystem, so a concurrent reader (a poll/prewarm hitting the banner mid-upload) always
// sees the OLD or the NEW file in full — never a half-written image that could get served + cached.
async function writeFileAtomic(dest, buf) {
  const tmp = `${dest}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, buf);
  try { await fs.promises.rename(tmp, dest); }
  catch (e) { try { await fs.promises.unlink(tmp); } catch {} throw e; }
}

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
const stmtHubPast = db.prepare('SELECT run_date, program_id FROM attendance WHERE email = ? ORDER BY run_date DESC LIMIT 12'); // runs-hub "Past games" list
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
    // Fallback for a sender with no applicant row (the demo run's synthetic @demo.local players):
    // resolve the display name from this program's check-in roster so chat shows a name, not an email.
    // No-op for real programs — every real chatter has an applicant row — so it's byte-identical there.
    const unresolved = emails.filter(e => !senders.has(e));
    if (unresolved.length) {
      const phc = unresolved.map(() => '?').join(',');
      for (const c of db.prepare(`SELECT DISTINCT email, name FROM checkins WHERE program_id = ? AND email IN (${phc})`).all(programId, ...unresolved))
        if (!senders.has(c.email)) senders.set(c.email, { id: 0, full_name: c.name, is_host: 0 });
    }
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
const stmtChatMembersAll = db.prepare(`SELECT id, full_name, email, is_host, is_team, is_regular, avatar, dob
    FROM applicants WHERE status = 'approved' AND email NOT LIKE '%@guest.local'
    ORDER BY is_host DESC, is_team DESC, is_regular DESC, full_name COLLATE NOCASE`);
const stmtChatMembersJoined = db.prepare(`SELECT a.id, a.full_name, a.email, a.is_host, a.is_team, a.is_regular, a.avatar, a.dob
    FROM program_membership pm JOIN applicants a ON a.email = pm.email
    WHERE pm.program_id = ? AND a.status = 'approved' AND a.email NOT LIKE '%@guest.local'
    ORDER BY a.is_host DESC, a.is_team DESC, a.is_regular DESC, a.full_name COLLATE NOCASE`);
const stmtChatPinned = db.prepare('SELECT * FROM group_messages WHERE pinned_at IS NOT NULL AND program_id = ? ORDER BY pinned_at DESC LIMIT 5');
function chatMembersFor(programId) {
  const p = P(programId);
  const rows = (p && p.config.access === 'opt-in') ? stmtChatMembersJoined.all(programId) : stmtChatMembersAll.all();
  return rows.map(r => ({ ...r, minor: isMinor(r) }));   // red asterisk in the member sheet (awareness)
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
// Opt-in chat pushes (owner ask 2026-08-05): by DEFAULT ordinary chat messages never buzz —
// only announcements / spot offers / @mentions / DMs do. A member flips "every chat message"
// ON from their Profile (applicants.chat_push). One stable tag per program collapses a busy
// room into a single updating notification instead of a stack; mentioned users are excluded
// here because notifyChatMentions already pinged them louder.
function notifyChatOptIns(programId, fromEmail, preview, mentions = null) {
  const optIns = db.prepare('SELECT email FROM applicants WHERE COALESCE(chat_push,0) = 1 AND COALESCE(suspended,0) = 0').all().map((r) => r.email.toLowerCase());
  if (!optIns.length) return;
  const from = String(fromEmail).toLowerCase();
  const mentioned = new Set();
  const ids = String(mentions || '').split(',').map(Number).filter(Boolean);
  if (ids.length) for (const r of db.prepare(`SELECT email FROM applicants WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)) mentioned.add(r.email.toLowerCase());
  const optSet = new Set(optIns);
  const members = programId === 1 ? approvedEmails() : programMemberEmails(programId);
  const emails = members.filter((e) => { const lc = e.toLowerCase(); return lc !== from && optSet.has(lc) && !mentioned.has(lc); });
  if (!emails.length) return;
  const sender = applicantByEmail(fromEmail);
  const p = P(programId);
  setImmediate(() => sendPush(emails, {
    title: `${sender ? sender.full_name : 'Someone'} · ${p.displayName} chat`,
    body: (preview || '').slice(0, 140),
    url: p.paths.chat, tag: `${p.config.logTag || 'run'}chatmsg`,
  }));
}

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

// --- Pickleball unread counts on the unified chat engine (program 2), still used by the inline
// pickleball season board. The pk chat ROUTES delegate to the generic runChat* handlers now, so the
// old load/older/notify/markRead pk wrappers were removed as dead after that extraction (P3-8).
function pkGroupUnread(email) { return chatUnreadFor(2, email); }
function pkGroupMentionUnread(email, applicantId) { return chatMentionUnreadFor(2, email, applicantId); }
// Chat gate = page gate + pickleball MEMBERSHIP. You must have opened the pickleball run
// (which joins you) to access its chat — being an approved basketball player isn't enough.
// pkIsMember/pkGate are hoisted function declarations, so this resolves despite ordering.
// Chat gate (program-generic) = page gate (login + approved + 404 while hidden) + run MEMBERSHIP.
// You must have opened the run (which joins you) to reach its chat — being approved elsewhere isn't
// enough. pkChatGate is a thin wrapper; a new run gets its chat gate for free.
function runChatGate(programId, req, res, json) {
  const g = programGate(programId, req, res); if (!g) return null; // programGate already responded on failure
  if (!memberOf(programId, req.userEmail)) {
    if (json) res.status(403).json({ err: 'notmember' });
    else res.redirect(P(programId).paths.run);             // open the run first to join
    return null;
  }
  return g;
}
function pkChatGate(req, res, json) { return runChatGate(2, req, res, json); }

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
// Has the viewer JOINED this run? Drives the run-aware Chat tab: it only unlocks + points at a run
// the viewer actually belongs to. Opt-in runs (pickleball/volleyball) → membership. A drop-in run
// (basketball) has no explicit join step, so "joined" = you're on the org team, an admin, or you've
// checked in at least once (a current OR archived check-in). Admins belong to every run (they run them).
const stmtEverCheckedInProg = db.prepare('SELECT 1 FROM checkins WHERE program_id = ? AND email = ? LIMIT 1');
const stmtEverAttendedProg  = db.prepare('SELECT 1 FROM attendance WHERE program_id = ? AND email = ? LIMIT 1');
function programJoinedBy(programId, email) {
  if (!email) return false;
  if (isAdmin(email)) return true;
  const a = applicantByEmail(email);
  if (!a || a.status !== 'approved') return false;   // rejected/pending/no-row → joined to nothing, even if old
                                                     // attendance survives (P3-1: don't unlock a chat the gate bounces)
  if (P(programId).config.access === 'opt-in') return memberOf(programId, email);
  if (a.is_team) return true;
  return !!stmtEverCheckedInProg.get(programId, email) || !!stmtEverAttendedProg.get(programId, email);
}
// The program whose chat the Chat tab should open on a run-agnostic page (runs hub, profile,
// friends, a join prompt). Returns 0 when the viewer has joined NO active run → the tab renders
// LOCKED (grey + a "join a run first" prompt) instead of silently defaulting to basketball, which
// is an approved-players-only run. Prefers the last-opened run (cookie) when it's one they've
// joined; else their lowest-id joined run.
function chatProgramFor(req) {
  const email = req.userEmail;
  const joined = [...PROGRAMS.values()].filter(p => p.active() && programJoinedBy(p.id, email));
  if (!joined.length) return 0;
  const ck = Number(req.cookies && req.cookies.bridge_run);
  return (joined.find(p => p.id === ck) || joined[0]).id;
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
// Age from a 'YYYY-MM-DD' dob against the (test-aware) current date. Null if absent/malformed.
function ageFromDob(dob) {
  if (typeof dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const b = new Date(dob + 'T00:00:00'); if (isNaN(b.getTime())) return null;
  const now = new Date(schedNow());
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age;
}
// Safeguarding: a KNOWN minor (dob on file, age < 18) may not use 1:1 direct messages, in either
// direction. Unknown dob → NOT treated as a minor (new signups/invites capture it; legacy members
// can add it in their profile). Group run-chat is monitored/public and is unaffected.
function isMinor(a) { const age = a ? ageFromDob(a.dob) : null; return age != null && age < 18; }

function canMessage(senderEmail, senderA, recip) {
  if (!recip || recip.status !== 'approved') return false;
  if (recip.email === senderEmail) return false;            // no messaging yourself
  if (/@guest\.local$/.test(recip.email)) return false;     // guest placeholders aren't accounts
  if (blockedPair(senderEmail, recip.email)) return false;  // a blocked pair (either direction) can't DM (Phase 6)
  if (isAdmin(senderEmail)) return true;                    // admin → any approved member, incl. a minor (safeguarding oversight; works even for a row-less admin)
  if (isMinor(senderA)) return false;                       // a known minor can't use 1:1 DMs at all (safeguarding)
  if (isMinor(recip)) return false;                         // and NO non-admin may DM a known minor (adults 18+ included)
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
  const dob = String(req.body.dob || '').trim();
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
  // DOB is required (drives the under-18 DM safeguarding rule). Reject missing / malformed / absurd.
  const applicantAge = ageFromDob(dob);
  if (applicantAge == null || applicantAge < 5 || applicantAge > 110) {
    return res.send(intakePage({ error: 'Please enter a valid date of birth.' }));
  }
  try {
    const existing = applicantByEmail(em);
    // Anyone with a player's email could otherwise rename/rehome them via the
    // public QR form. An already-cleared player (approved / team / host) is never
    // overwritten by a public re-application — send them to sign in instead.
    if (existing && (existing.status === 'approved' || existing.is_team || existing.is_host)) {
      return res.send(intakePage({ alreadyApproved: true }));
    }
    if (existing) {
      db.prepare(`UPDATE applicants SET full_name=?, phone=?, experience=?, where_played=?, waiver_ok=?, dob=?
                  WHERE email=?`)
        .run(full_name.trim(), phone.trim(), experience, (where_played || '').trim(),
             waiver_ok ? 1 : 0, dob, em);
    } else {
      db.prepare(`INSERT INTO applicants (full_name,email,phone,experience,where_played,waiver_ok,dob)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(full_name.trim(), em, phone.trim(), experience, (where_played || '').trim(),
             waiver_ok ? 1 : 0, dob);
    }
    if (waiver_ok) stampWaiver(em);   // permanent attestation date (the form's box is required)
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
  // `msg` is a benign notice (e.g. "signed out on every device") — rendered via the page's
  // error slot, which is escaped in the view.
  res.send(loginPage({ next: req.query.next || '', error: String(req.query.msg || '') }));
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
  signIn(res, row.email, 'magic link');
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
  signIn(res, em, 'sign-in code');
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
  const dob = String(req.body.dob || '').trim();
  const inviteAge = ageFromDob(dob);
  const dobBad = inviteAge == null || inviteAge < 5 || inviteAge > 110;
  if (!full_name || !phone || !isValidEmail(email) || !waiverOk || dobBad) {
    return res.send(invitePage({
      token: iv.token, full_name, phone, email, dob,
      error: !waiverOk ? 'Please confirm the waiver to continue.'
        : dobBad ? 'Please enter a valid date of birth.'
        : 'Fill in your name, phone, and a valid email.',
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
  // Record the invitee's DOB (drives the under-18 DM rule). KEEP-FIRST-SET (COALESCE): an already-set
  // DOB is never overwritten here — otherwise a known minor holding an invite link could re-claim it
  // with a fake adult DOB and unlock 1:1 DMs, defeating the set-once rule /profile enforces.
  db.prepare('UPDATE applicants SET dob = COALESCE(dob, ?) WHERE email = ?').run(dob, email);
  // Permanent attestation date for the two branches that grant the waiver (verified claim, either
  // existing-row or fresh-INSERT). The unverified branches grant no waiver, so they get no date.
  if (prefilledMatch) stampWaiver(email);
  db.prepare("UPDATE invites SET used = 1, used_at = datetime('now'), used_email = ? WHERE token = ?")
    .run(email, iv.token);
  // WIRING: a team invite creates an auto-renew team member — seat them on the
  // current run now (autoJoinTeam is rollover-gated in ensureWeek), so a claimed
  // team invite shows them seated the moment they land on check-in.
  if (isTeam) autoJoinTeam(nextRunDate());
  audit(iv.created_by, 'admin', `invite:claimed${iv.role ? ':' + iv.role : ''}${prefilledMatch ? '' : ':link'}`, `${full_name} <${email}>`);

  if (prefilledMatch) {
    // Pre-approved AND the address is proven (admin pre-filled it) — sign them in.
    signIn(res, email, 'invite claim');
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
  // F8: a future publish_at stores the post as PENDING — invisible everywhere, no push, no
  // archive-the-previous — until the tick fires it at that local time, exactly like posting live.
  const schedAt = parseScheduleAt(req.body.publish_at);
  if (body && !dup && schedAt) {
    db.prepare('INSERT INTO announcements (body, author, pending, publish_at, sched_email) VALUES (?,?,1,?,?)')
      .run(body, req.userEmail, schedAt, req.body.email_everyone ? 1 : 0);
    audit(req.userEmail, req.actorRole, 'announce:scheduled', `${schedAt} ${body.slice(0, 40)}`);
    armScheduleTimer();
    return res.redirect('/checkin?msg=' + encodeURIComponent(`Scheduled for ${fmtWhen(schedAt.replace('T', ' '))}.`));
  }
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

// Cancel a SCHEDULED announcement before it fires (P2-4: the F8 state machine's missing exit —
// without this the only way to stop a mis-scheduled post was DB surgery). Pending-only delete:
// a fired/live post can never be deleted through here, only cleared via /announce/clear.
app.post('/announce/cancel', requireApprover, (req, res) => {
  const id = Number(req.body.id);
  if (Number.isInteger(id) && id > 0) {
    const r = db.prepare('DELETE FROM announcements WHERE id = ? AND pending = 1 AND program_id = 1').run(id);
    if (r.changes) audit(req.userEmail, req.actorRole, 'announce:cancel-scheduled', String(id));
    armScheduleTimer();
  }
  res.redirect('/profile');
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

// The permanent waiver record. EVERY path that sets waiver_ok routes through here so the date is
// captured once, in one place — the sign-up form, an invite claim, and the /waiver gate. Idempotent
// (`waiver_at IS NULL`): re-confirming never rewrites the original attestation date, and a member
// who was already cleared before this column existed keeps a NULL date rather than a forged one.
// 'localtime': this is a DATE people read ("signed July 15"), and an attestation after 8 PM
// Eastern stamped in UTC records the NEXT day — off-by-one on a quasi-legal record.
const stmtStampWaiver = db.prepare(
  "UPDATE applicants SET waiver_ok = 1, waiver_at = COALESCE(waiver_at, datetime('now','localtime')) WHERE email = ?");
function stampWaiver(email) { if (email) stmtStampWaiver.run(String(email).toLowerCase()); }

// ---------- PER-PROGRAM WAIVERS (F6 youth pack) ----------
// A program whose config carries waiver:{key} requires ITS OWN signed waiver (a waiver_records
// row for that key) instead of the club-wide applicants.waiver_ok — a youth program's consent
// document is not the adult pickup waiver. waiverSatisfied is the ONE seam every seat-granting
// path reads; for a program without config.waiver it reduces exactly to the old waiver_ok check.
// guardianUnder (config.waiver.guardianUnder = 18): a minor's record also needs a guardian's
// consent attestation before it satisfies — adults are untouched by it.
const stmtWaiverRec = db.prepare('SELECT * FROM waiver_records WHERE waiver_key = ? AND email = ?');
function programWaiver(programId) { return P(programId).config.waiver || null; }
function waiverSatisfied(programId, email) {
  email = String(email || '').toLowerCase();
  const a = applicantByEmail(email);
  const w = programWaiver(programId);
  if (!w) return !!(a && a.waiver_ok);
  const rec = stmtWaiverRec.get(w.key, email);
  if (!rec) return false;
  // An organizer who has SEEN the signed document has seen the whole document — for a youth
  // waiver that includes the guardian's signature, so verified_at satisfies outright (parity
  // with the global model, where admin verification sets waiver_ok itself).
  if (rec.verified_at) return true;
  if (!rec.attested_at) return false;
  if (waiverNeedsGuardian(w, a) && !rec.guardian_consent_at) return false;
  return true;
}
// Where a join route sends someone who still owes this program's waiver.
function waiverGateUrl(programId, next) {
  const p = programWaiver(programId) ? `&p=${programId}` : '';
  return `/waiver?next=${encodeURIComponent(next)}${p}`;
}
// Does THIS program's waiver need a guardian's consent for THIS member? (Minors only; adults and
// guardian-less programs → false.)
function waiverNeedsGuardian(w, a) {
  return !!(w && w.guardianUnder && a && isMinor(a) && ageFromDob(a.dob) < w.guardianUnder);
}
// Resolve the ?p= param to a program that actually HAS its own waiver — anything else falls back
// to the global flow rather than trusting a crafted id.
function waiverProgramFromReq(req, source) {
  const pid = Number((source || {}).p) || 0;
  return pid && PROGRAMS.has(pid) && programWaiver(pid) ? pid : null;
}

// One-time waiver gate — the join routes send a member here when their waiver is unset. They
// confirm they've signed, we record it, and they're returned to the run to check in. With ?p=
// the gate is a PROGRAM's own waiver (waiver_records row); without it, the club-wide flag.
app.get('/waiver', requireLogin, (req, res) => {
  const a = applicantByEmail(req.userEmail);
  const next = safeNextPath(req.query.next);
  const pid = waiverProgramFromReq(req, req.query);
  if (pid ? waiverSatisfied(pid, req.userEmail) : (a && a.waiver_ok)) return res.redirect(next); // already signed → nothing to do
  res.send(waiverPage({
    email: req.userEmail, next, err: req.query.err || '',
    programId: pid, programName: pid ? P(pid).displayName : '',
    // Guardian consent block renders only when THIS program requires it for THIS (minor) member.
    guardian: waiverNeedsGuardian(pid ? programWaiver(pid) : null, a),
  }));
});
app.post('/waiver', requireLogin, (req, res) => {
  const a = applicantByEmail(req.userEmail);
  const next = safeNextPath(req.body.next);
  if (!a) return res.redirect('/status');
  const pid = waiverProgramFromReq(req, req.body);
  const back = (msg) => res.redirect(`/waiver?next=${encodeURIComponent(next)}${pid ? `&p=${pid}` : ''}&err=${encodeURIComponent(msg)}`);
  if (!req.body.agree) return back('Please check the box to confirm you signed the waiver.');
  if (!pid) {   // club-wide flow — unchanged
    stampWaiver(a.email);
    audit(req.userEmail, 'player', 'waiver:ack', '');
    return res.redirect(next);
  }
  const w = programWaiver(pid);
  const needsGuardian = waiverNeedsGuardian(w, a);
  let g = { name: '', phone: '', email: '' };
  if (needsGuardian) {   // guardian consent (F6): the guardian fills their details + attests
    g = {
      name: String(req.body.guardian_name || '').trim().slice(0, 60),
      phone: String(req.body.guardian_phone || '').trim().slice(0, 30),
      email: String(req.body.guardian_email || '').trim().toLowerCase(),
    };
    if (!req.body.guardian_agree) return back('A parent or guardian needs to check the consent box.');
    if (!g.name || !g.phone || !isValidEmail(g.email)) return back('Guardian name, phone, and a valid email are required.');
    if (g.email === String(a.email).toLowerCase()) return back('The guardian email must be the parent or guardian’s own address, not the player’s.');
  }
  // Idempotent like stampWaiver: first attestation dates stick; a re-confirm never rewrites them.
  db.prepare(`INSERT INTO waiver_records (waiver_key, email, attested_at, guardian_name, guardian_phone, guardian_email, guardian_consent_at)
      VALUES (?, ?, datetime('now','localtime'), ?, ?, ?, CASE WHEN ? THEN datetime('now','localtime') END)
    ON CONFLICT(waiver_key, email) DO UPDATE SET
      attested_at = COALESCE(attested_at, excluded.attested_at),
      guardian_name = CASE WHEN excluded.guardian_name != '' THEN excluded.guardian_name ELSE guardian_name END,
      guardian_phone = CASE WHEN excluded.guardian_phone != '' THEN excluded.guardian_phone ELSE guardian_phone END,
      guardian_email = CASE WHEN excluded.guardian_email != '' THEN excluded.guardian_email ELSE guardian_email END,
      guardian_consent_at = COALESCE(guardian_consent_at, excluded.guardian_consent_at)`)
    .run(w.key, String(a.email).toLowerCase(), g.name || null, g.phone || null, g.email || null, needsGuardian ? 1 : 0);
  // The applicants guardian columns are the person-level contact record (one guardian per player,
  // shown on the admin People card) — stamped from the first program that collects them.
  if (needsGuardian) {
    db.prepare(`UPDATE applicants SET guardian_name = COALESCE(NULLIF(guardian_name,''), ?),
        guardian_phone = COALESCE(NULLIF(guardian_phone,''), ?),
        guardian_email = COALESCE(NULLIF(guardian_email,''), ?) WHERE email = ?`)
      .run(g.name, g.phone, g.email, a.email);
  }
  audit(req.userEmail, 'player', 'waiver:ack', `${w.key}${needsGuardian ? ':guardian' : ''}`);
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
  // First open stamps the fill-speed anchor (metrics layer); a later re-open never resets it.
  if (open) db.prepare("UPDATE run_state SET opened_at = datetime('now') WHERE run_date = ? AND program_id = 1 AND opened_at IS NULL").run(runDate); // UTC — must match checkins.created_at for fill-speed math (P1-2)
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
         a.id AS applicant_id, COALESCE(a.dob, c.dob) AS eff_dob
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
function bumpChatSeqFor(programId) { const k = P(programId).config.chatSeqKey; setSetting(k, String((Number(getSetting(k)) || 0) + 1)); }
// Program-generic poll fingerprints (basketball id=1 + pickleball id=2 keep their own hoisted
// statements/branches above; these serve every OTHER run — e.g. volleyball — so a new run gets
// live-refresh from the registry, no new /poll branch). Statements bind program_id at call (node:
// sqlite has no statement cache, so re-preparing per tick would be the scan these hoists avoid).
const stmtPollChatMaxG = db.prepare('SELECT COALESCE(MAX(id),0) mx FROM group_messages WHERE program_id = ?');
const stmtPollChatReactG = db.prepare('SELECT COUNT(*) c, MAX(created_at) mx FROM group_reactions WHERE program_id = ?');
function chatPollFingerprint(programId) {
  const g = stmtPollChatMaxG.get(programId), rx = stmtPollChatReactG.get(programId);
  return `${g.mx || 0}:${getSetting(P(programId).config.chatSeqKey) || 0}:${rx.c || 0}:${rx.mx || ''}`;
}
function runPollFingerprint(programId) {
  const cfg = P(programId).config, rd = programRunDate(programId);
  ensureWeekFor(programId); // no-op until the date advances; never writes offers
  const part = partitionFor(programId, rd), rows = part.rows || [];
  // Offer-window runs carry offered/held flags + the held-release boundary; simple runs don't.
  const order = cfg.offerWindow
    ? rows.map(r => `${r.id}${r.offered_at != null ? 'o' : ''}${r.held ? 'h' : ''}${r.confirmed_at ? 'c' : ''}`).join(',')
    : rows.map(r => `${r.id}${r.confirmed_at ? 'c' : ''}`).join(',');
  const held = cfg.offerWindow ? `${heldReleased(rd) ? 1 : 0}:` : '';
  const ann = latestAnnouncementFor(programId);
  return `${rd}:${runOpenFor(programId, rd) ? 1 : 0}:${runCancelledFor(programId, rd) ? 1 : 0}:${held}${order}:${ann ? ann.id : 0}`;
}
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
// config.features.groupQueue → {maxSize} | falsy. The read pattern mirrors teamsFeature.
function groupQueueFeature(programId) { const f = P(programId).config.features; return (f && f.groupQueue) || null; }
// Party-atomic floor packing (Phase 6b, queue-with-friends). Splits an ordered roster slice into
// floor + waitlist so a PARTY (checkins sharing a group_id) is never split: a party boards only if
// it fits ENTIRELY in the remaining floor capacity, else the whole party waits and we skip ahead to
// fill the gap with smaller units behind it. Solos are size-1 units → when NOTHING has a group_id
// this is byte-identical to `list.slice(0, capacity)` (proven), so the solo path never changes.
function packParties(list, capacity) {
  const byGroup = new Map();
  const units = [];                       // {rows, anchor} — solo/party units
  list.forEach((r, i) => {
    if (r.group_id == null) { units.push({ rows: [r], anchor: i }); }
    else if (byGroup.has(r.group_id)) { const u = byGroup.get(r.group_id); u.rows.push(r); u.anchor = i; } // anchor = LATEST member's roster position (P1-2)
    else { const u = { rows: [r], anchor: i }; byGroup.set(r.group_id, u); units.push(u); }
  });
  // A party is placed at its LATEST member's position, never its earliest — so a member's early
  // (e.g. solo) check-in can't drag the whole party onto the floor ahead of the queue and bump a
  // seated player (P1-2). `list` is pre-sorted, so for all-solos every anchor == its own index →
  // this stable sort is a no-op and packParties still reduces to list.slice(0, capacity).
  units.sort((a, b) => a.anchor - b.anchor);
  const floor = [], wait = [];
  let remaining = capacity;
  for (const u of units) {
    if (u.rows.length <= remaining) { floor.push(...u.rows); remaining -= u.rows.length; }
    else wait.push(...u.rows);
  }
  return { floor, wait };
}
function offerPartition(programId, runDate) {
  const cfg = P(programId).config;
  const rows = stmtRun.all(runDate, programId).map(r => ({
    ...r, tryout: r.pstatus === 'tryout', team: !!r.is_team, regular: !!r.is_regular,
    host: !!r.is_host,
    guest: /@guest\.local$/.test(r.email),
    minor: isMinor({ dob: r.eff_dob }),   // red safeguarding chip on the roster (real DOB, or a demo checkin DOB)
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
  // Party-atomic split when groupQueue is on; otherwise the exact solo slice (reduction-proof).
  let floorReal, overflow;
  if (groupQueueFeature(programId)) {
    ({ floor: floorReal, wait: overflow } = packParties(nonOffered, floorCapForReal));
  } else {
    floorReal = nonOffered.slice(0, floorCapForReal);
    overflow = nonOffered.slice(floorCapForReal);
  }
  const waitPlayers = [...overflow, ...heldLate].slice(0, cfg.waitlist);
  return { rows, active, offered, floorReal, overflow, heldLate, waitPlayers };
}
// Select the partition model from config: offer-window programs (basketball, and volleyball later)
// use the held/offered/floorReal accounting; immediate programs (pickleball) use the simple slice.
// This is the ONE seam a new program flips via config.offerWindow — no per-program branch elsewhere.
function partitionFor(programId, rd) {
  return P(programId).config.offerWindow ? offerPartition(programId, rd) : simplePartition(programId, rd);
}
function partitionRun(runDate) { return partitionFor(1, runDate); }

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

// GUEST PRIORITY (owner rule): a waitlisted GUEST takes any freed floor spot ahead of the
// waitlist. Guests can't do the email claim loop (no inbox), so they're seated IMMEDIATELY —
// floated to the top exactly like an operator Bump (MIN(sort_order)-1; a plain positional swap
// can lose to lower row-ids at the same sort_order). Returns true if a guest took the spot.
// Callers skip the offer / promotion-notify for that spot when this returns true.
const stmtMinSortByRun = db.prepare('SELECT MIN(sort_order) m FROM checkins WHERE run_date = ? AND program_id = ?');
const stmtFloatGuest = db.prepare('UPDATE checkins SET sort_order = ?, held = 0 WHERE run_date = ? AND email = ? AND program_id = ?');
const stmtDelCheckinRow = db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = ?');
const stmtConfirmSet = db.prepare("UPDATE checkins SET confirmed_at = datetime('now') WHERE run_date = ? AND email = ? AND program_id = ? AND confirmed_at IS NULL");
const stmtConfirmClear = db.prepare('UPDATE checkins SET confirmed_at = NULL WHERE run_date = ? AND email = ? AND program_id = ?');
const stmtPmAutoRenew = db.prepare('SELECT auto_renew FROM program_membership WHERE program_id = ? AND email = ?');
function seatWaitingGuest(programId, rd) {
  const cfg = P(programId).config;
  const part = partitionFor(programId, rd);
  const wait = cfg.offerWindow ? part.waitPlayers : part.wait;
  const g = wait.find(p => /@guest\.local$/.test(p.email));
  if (!g) return false;
  const { m } = stmtMinSortByRun.get(rd, programId);
  stmtFloatGuest.run((m ?? 0) - 1, rd, g.email, programId);
  audit('system', 'system', `${cfg.logTag || 'run'}:guest-priority-seat`, g.email);
  return true;
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
  if (!P(programId).config.static) metric('offer_send', { programId, runDate });   // durable funnel count (demo excluded) — audit_log ages out at 5000 rows
  // A STATIC/demo program's players are synthetic (@demo.local) — the offer row + claim token are
  // still created (so the money-moment shows on the roster and the claim button works), but never
  // send a real email/push to a fake address.
  if (P(programId).config.static) return;
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
  if (seatWaitingGuest(programId, runDate)) return null;   // guest priority: the spot is already filled — no offer
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
  if (!expired.length) return;
  const wlBefore = waitlistOrderFor(programId, runDate);   // F4 (P3-2): expiry is the MOST common shift
  for (const ex of expired) {
    // Capture the next offeree BEFORE dropping the expired hold, so the freed slot
    // offers the true top waitlister rather than one auto-promoted by the drop.
    // Guest priority: a waitlisted guest takes the expired hold's spot instead.
    const part = offerPartition(programId, runDate);
    const offeree = seatWaitingGuest(programId, runDate) ? null : topOfferee(part, ex.email);
    db.prepare('DELETE FROM checkins WHERE id = ?').run(ex.id);
    audit('system', 'system', 'offer:expire', ex.email);
    if (!P(programId).config.static) metric('offer_expire', { programId, runDate });
    if (offeree) createOffer(runDate, offeree, req, programId);
  }
  setImmediate(() => pingWaitlistShift(programId, runDate, wlBefore));   // F4 (P3-2)
}

// ---- run_summary writer (metrics layer) — call at archive time, BEFORE the purge ----
// Everything here reads state that is deleted moments later (checkins timing + waitlist order,
// run_state.opened_at/cancelled); offer counts come from metrics_events, which is already
// durable, so a re-run can't double-count. INSERT OR IGNORE on PK(run_date, program_id) makes
// the whole write idempotent. A metrics failure must never stall the rollover: fail-loud to the
// console, swallow the throw. floor_n matches the attendance archive (non-guests); filled_at is
// the cap-th non-guest check-in — the "floor full" moment measured from opened_at.
function writeRunSummary(programId, rd) {
  try {
    const cfg = P(programId).config;
    if (cfg.static) return;   // the demo program has no real weeks
    const part = partitionFor(programId, rd);
    const floor = (cfg.offerWindow ? part.floorReal : part.floor) || [];
    const wait = (part.wait || part.waitPlayers || []);
    const isGuest = (p) => /@guest\.local$/.test(p.email || '');
    const floorN = floor.filter((p) => !isGuest(p)).length;
    const guestN = floor.filter(isGuest).length + wait.filter(isGuest).length;
    const waitN = wait.filter((p) => !isGuest(p)).length;
    // Occupancy timeline INCLUDES guests (P3-8): guests occupy floor slots, so a 3-guest night
    // still records filled_at when total occupancy reaches cap. floor_n/wait_n/guest_n keep the
    // member-vs-guest split; this timeline answers "when was the floor full", whoever filled it.
    const times = db.prepare('SELECT created_at FROM checkins WHERE run_date = ? AND program_id = ? ORDER BY created_at ASC')
      .all(rd, programId).map((r) => r.created_at);
    const st = db.prepare('SELECT opened_at, cancelled FROM run_state WHERE run_date = ? AND program_id = ?').get(rd, programId);
    const oc = (k) => db.prepare('SELECT COALESCE(SUM(n),0) s FROM metrics_events WHERE kind = ? AND run_date = ? AND program_id = ?').get(k, rd, programId).s;
    db.prepare(`INSERT OR IGNORE INTO run_summary
      (run_date, program_id, floor_n, wait_n, guest_n, cap, cancelled, opened_at, first_checkin_at, filled_at, offers_sent, offers_claimed, offers_expired)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(rd, programId, floorN, waitN, guestN, cfg.cap ?? null, (st && st.cancelled) ? 1 : 0, (st && st.opened_at) || null,
        times[0] || null, (cfg.cap && times.length >= cfg.cap) ? times[cfg.cap - 1] : null,
        oc('offer_send'), oc('offer_claim'), oc('offer_expire'));
  } catch (e) { console.error(`[metrics] run_summary write failed for ${programId}/${rd}: ${e.message}`); }
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
  // Metrics layer: one summary row per ended run, written while its checkins/run_state still
  // exist. UNION picks up cancelled/zero-join weeks that have a state row but no checkins.
  for (const r of db.prepare(`SELECT run_date FROM checkins WHERE run_date < ? AND program_id = 1
    UNION SELECT run_date FROM run_state WHERE run_date < ? AND program_id = 1`).all(t, t)) writeRunSummary(1, r.run_date);
  stmtArchiveAttendance.run(t, CAP);  // archive the final floor of every run that has ended
  // Attendance just changed for everyone who played → refresh their PCO People custom fields.
  // Fire-and-forget: a PCO outage must never stall the weekly rollover, and the 60s tick's slow
  // drain picks up anyone missed (signature-diffed, so it re-pushes only what actually changed).
  pcoPushFields(50).catch(e => console.error(`[pco] profile-field push after rollover FAILED: ${e.message}`));
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
    part, // full partition — shared with the /runs hub-card badge (myRunStatusFor) so it isn't recomputed
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
// The viewer's own status for a run, for the hub card's personal badge (Javelin-style):
// 'in' (on the floor), 'offered' (holding a pending offer), or 'waitlist' (with position #pos of total).
// Returns null when they're not signed up — the card then shows no personal badge. Reuses the same
// partition the run page uses, so the badge and the run page never disagree.
function myRunStatusFor(programId, rd, email, part) {
  if (!email || !rd) return null;
  const cfg = P(programId).config;
  part = part || partitionFor(programId, rd);   // reuse the hub card's partition when passed — avoids a 2nd partition per program per /runs

  const me = String(email).toLowerCase();
  const floor = cfg.offerWindow ? part.floorReal : part.floor;
  const wait = cfg.offerWindow ? part.waitPlayers : part.wait;
  const offered = cfg.offerWindow ? part.offered : [];
  if (floor.some(x => String(x.email).toLowerCase() === me)) return { state: 'in' };
  if (offered.some(x => String(x.email).toLowerCase() === me)) return { state: 'offered' };
  const i = wait.findIndex(x => String(x.email).toLowerCase() === me);
  if (i >= 0) return { state: 'waitlist', pos: i + 1, total: wait.length };
  return null;
}

app.get('/runs', requireLogin, (req, res) => {
  const email = req.userEmail;
  // Any signed-in member can SEE the hub — non-approved viewers get an apply prompt on
  // tap (handled in the view) instead of being bounced away, so they can find the runs.
  const a = applicantByEmail(email);
  const viewerIsAdmin = isAdmin(email);
  const status = a?.status || 'none';
  const canJoin = viewerIsAdmin || status === 'approved';
  const runs = [];
  // Which people the viewer FOLLOWS are already checked in — keyed by program|run-date so each
  // card can show "Alex, Sam +2 going" (Javelin-style social proof). Same visibility as the
  // /friends "friends' games" list, computed once here.
  const fgMap = new Map(friendsGamesFor(email).map(g => [g.programId + '|' + g.runDate, g.friends]));
  // Every registered run, in id order: live ones are always listed; a hidden run (not yet
  // published) shows to admins only, with a lock badge. Each card's dynamic fields come from
  // that program's own dispatch (basketball / pickleball engine today) — no hardcoded pushes.
  for (const p of PROGRAMS.values()) {
    if (!p.active() && !viewerIsAdmin) continue;
    // Per-program isolation: the hub is the app's home page, so one program whose card computation
    // throws must cost that CARD, never everyone's /runs. (In-app program creation means a card can
    // now come from admin-entered config, not just code.)
    try {
      const { part, ...hub } = p.hubCard(req); // `part` = the program's already-computed partition; strip it so it never leaks into view props
      const card = { key: p.key, emoji: p.emoji, name: p.displayName, href: p.paths.run, ...hub };
      card.friendsGoing = fgMap.get(p.id + '|' + card.runDate) || [];
      card.mine = a ? myRunStatusFor(p.id, card.runDate, email, part) : null; // reuses the hub card's partition (no 2nd partition)
      runs.push(card);
    } catch (e) { console.error(`[runs] hub card for program ${p.id} (${p.key}) FAILED: ${e.message}`); }
  }

  // ---- Home-screen redesign: "Welcome, {name}", a current-week calendar strip with a dot on
  // each day that has a run, and a Past-games list (the member's recent attended runs). ----
  const firstName = ((a?.full_name || email).trim().split(/\s+/)[0]) || 'there';
  const pastRuns = a ? stmtHubPast.all(email)
    .filter(r => PROGRAMS.has(r.program_id))
    .map(r => ({ name: PROGRAMS.get(r.program_id).displayName, emoji: PROGRAMS.get(r.program_id).emoji, runDate: r.run_date, programId: r.program_id, key: PROGRAMS.get(r.program_id).key })) : [];

  const chatProgram = chatProgramFor(req);
  const cc = chatCountsFor(chatProgram || 1, email, a ? a.id : 0);
  res.send(runsPage({
    email, runs, canJoin, status,
    firstName, pastRuns,
    isAdmin: viewerIsAdmin,
    canOperate: viewerIsAdmin || !!(a && a.is_team),
    needsWaiver: !!(a && !a.waiver_ok), // tour ends on a "sign your waiver" step for players who haven't
    needsDob: !!(a && !a.dob), // legacy members (pre-DOB signup) — nudge them to add it so the age gate applies
    dmUnread: unreadCount(email),
    groupUnread: cc.group,
    groupMention: cc.gm,
    chatProgram,
    ann: annPanel(email),
  }));
});

// Past run — read-only "who went" roster from the attendance archive. Opens from the hub's
// Past tab exactly like a live run card, but it's done: no actions, just the list. Approved
// members + admins only (same visibility bar as a live who's-going sheet).
const stmtPastRoster = db.prepare(`SELECT t.name, t.email, a.id AS applicant_id, a.dob
    FROM attendance t LEFT JOIN applicants a ON a.email = t.email
    WHERE t.program_id = ? AND t.run_date = ? ORDER BY t.name COLLATE NOCASE`);
app.get('/runs/past/:pid/:date', requireLogin, (req, res) => {
  const email = req.userEmail;
  const a = applicantByEmail(email);
  const admin = isAdmin(email);
  if (!admin && (!a || a.status !== 'approved')) return res.redirect('/status');
  const pid = Number(req.params.pid), rd = String(req.params.date);
  const p = PROGRAMS.get(pid);
  if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(rd)) return res.redirect('/runs');
  if (p.config.static && !admin) return res.redirect('/runs');   // demo archive is admin-only
  const rows = stmtPastRoster.all(pid, rd).map(r => ({ ...r, minor: isMinor(r) }));
  const chatProgram = chatProgramFor(req);
  const cc = chatCountsFor(chatProgram || 1, email, a ? a.id : 0);
  res.send(pastRunPage({
    name: p.displayName, emoji: p.emoji, runDate: rd, rows,
    dmUnread: unreadCount(email), groupUnread: cc.group, groupMention: cc.gm, chatProgram,
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
  // Basketball is apply-to-join. Someone without the role who hasn't applied yet gets the SIGNUP
  // FORM (not a dead-end status page); someone who already applied (pending/rejected) sees their
  // status. Approved players + admins fall through to the roster.
  const meApp = applicantByEmail(email);
  const meStatus = meApp?.status || 'none';
  if (!isAdmin(email) && meStatus !== 'approved')
    return meStatus === 'none' ? res.send(intakePage()) : res.redirect('/status');
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
    // Kiosk link parity with the generic run pages — per-program token, operator-mintable.
    kioskUrl: (canOperate && getSetting('kiosk_token_1')) ? `/kiosk/1?k=${getSetting('kiosk_token_1')}` : '',
    myState, myWaitPos, myOffer, offerWindowHours: OFFER_WINDOW_HOURS,
    iAmTeam, iAmCouncil: !!(a && a.is_council), iAmRegular, iOptedOut, iAutoRenew,
    viewerIsAdmin, canOperate, canSeeRoster,
    suspended: !!(a && a.suspended), suspendReason: (a && a.suspend_reason) || '',
    myConfirmed, confirmBy: effectiveConfirmCutoff(P(1).config.confirmCutoff) ? fmtClockLabel(P(1).config.confirmCutoff) : '', msg: req.query.msg || '', bannerVer: bannerVersion(),
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
  } else {
    // Every OTHER run (e.g. volleyball) — keyed by its own slug (prog.key, the run page's pollKey)
    // or logTag+"chat" (the chat page's pollPage). Basketball(1)/pickleball(2) are handled by the
    // literal branches above. A hidden run's fingerprint is withheld from non-admins (matches its
    // page gate) so it isn't leaked before publish.
    for (const p of PROGRAMS.values()) {
      if (p.id < 3 || !(p.active() || isAdmin(email))) continue;
      if (page === p.key) { f = runPollFingerprint(p.id); break; }
      if (page === `${p.config.logTag}chat`) { f = chatPollFingerprint(p.id); break; }
    }
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

// Shared by the profile popup, full profile, DM thread + DM send (hot member paths). node:sqlite
// has no stmt cache, so hoist this once instead of re-preparing the same SQL on every call.
const stmtApplicantById = db.prepare('SELECT * FROM applicants WHERE id = ?');

// ---------- PROFILE (view another player) ----------
// Compact profile card fragment for the who's-going quick-look popup (fetched by pvOpen).
app.get('/u/:id/card', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  const p = stmtApplicantById.get(Number(req.params.id) || 0);
  if (!p || (p.status !== 'approved' && !gate.viewerIsAdmin)) return res.status(404).send('');
  const canContact = gate.viewerIsAdmin || !!(gate.a && gate.a.is_team);
  const canDM = canMessage(req.userEmail, gate.a, p);   // hide Message when the server would block it (block / minor)
  const myBlock = iBlocked(req.userEmail, p.email);   // only MY OWN block renders Unblock — a reverse block must not show a phantom row
  res.send(profileCard({ p, stats: attendanceStats(p.email), canDM, isSelf: p.email === req.userEmail, minor: isMinor(p), showRoles: gate.viewerIsAdmin, following: isFollowing(req.userEmail, p.email), blocked: myBlock, restricted: blockedPair(req.userEmail, p.email) && !myBlock }));
});

app.get('/u/:id', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  const p = stmtApplicantById.get(Number(req.params.id) || 0);
  if (!p || (p.status !== 'approved' && !gate.viewerIsAdmin)) return res.redirect('/checkin');
  // OWNER RULE: operators (admin/team) see full name + phone; regular players don't.
  const canContact = gate.viewerIsAdmin || !!(gate.a && gate.a.is_team);
  const chatProgram = chatProgramFor(req);
  const cc = chatCountsFor(chatProgram || 1, req.userEmail, gate.a ? gate.a.id : 0);
  res.send(profilePage({
    p, stats: attendanceStats(p.email), isSelf: p.email === req.userEmail, canContact,
    canDM: canMessage(req.userEmail, gate.a, p), // hide Message when the server would block it (block / minor)
    rel: relationshipTo(req.userEmail, p.email), // friend/block affordance state
    following: isFollowing(req.userEmail, p.email), // one-way follow affordance
    runDate: nextRunDate(),
    hours: runTimeRange(nextRunDate()),
    back: P(runCookie(req)).paths.chat, // Back returns to the run you came from (its own chat room)
    dmUnread: unreadCount(req.userEmail), groupUnread: cc.group,
    groupMention: cc.gm, chatProgram, // Chat tab reflects the run they've joined (or locks if none)
    ann: annPanel(req.userEmail),
    minor: isMinor(p), // red safeguarding badge on the profile (visible to every viewer)
    showRoles: gate.viewerIsAdmin, // role badges are admin-eyes-only
  }));
});

// ---------- PROFILE (own editable tab) ----------
// Positions are PER-PROGRAM config now (config.positions = [[code,label],…]) so a new sport
// declares its own set in the wizard instead of editing a hardcoded list (F6). The save whitelist
// is the union across ALL programs (hidden ones included — hiding a program must not strip its
// members' stored picks on the next profile save) plus the legacy codes that predate the config.
const LEGACY_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C', 'S', 'OH', 'MB', 'OPP', 'L', 'DS'];
function positionWhitelist() {
  const set = new Set(LEGACY_POSITIONS);
  for (const p of PROGRAMS.values()) for (const [code] of (p.config.positions || [])) set.add(code);
  return set;
}
// Profile picker groups: one chip row per program that declares positions. Hidden programs keep
// their group visible (pre-F6 the two sport rows always showed, vb hidden or not — same UI, and a
// member's picks for a program that later publishes are already in place).
function positionGroups() {
  const groups = [];
  for (const p of PROGRAMS.values()) {
    if (!p.config.positions || !p.config.positions.length || p.config.static) continue;
    groups.push({ label: p.displayName, chips: p.config.positions });
  }
  return groups;
}
app.get('/profile', requireLogin, async (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  const a = gate.a;
  if (!a) return res.redirect('/status'); // admins with no applicant row have nothing to edit
  // Door check-in pass (Phase 2b): renders ONLY from a VERIFIED code (pco_pass_code is written
  // by the read-back, never assumed) and only while the admin has passes switched on.
  let passQr = '';
  if (getSetting('pco_pass_enabled') === '1' && a.pco_pass_code) {
    try { passQr = await QRCode.toString(a.pco_pass_code, { type: 'svg', margin: 1, color: { dark: '#183B38', light: '#ffffff' } }); }
    catch (e) { console.error(`[pco] pass QR failed for ${a.email}: ${e.message}`); }
  }
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
  const chatProgram = chatProgramFor(req);
  const cc = chatCountsFor(chatProgram || 1, a.email, a.id);
  res.send(profileTabPage({ a, stats: attendanceStats(a.email), saved: req.query.saved === '1', error: '', passQr, passCode: a.pco_pass_code || '',
    dmUnread: unreadCount(a.email), groupUnread: cc.group, groupMention: cc.gm, chatProgram, canOperate, announcementLog: canOperate ? announcementHistory() : [],
    friendCount: friendsOf(a.email).length, friendReqIn: friendReqIncomingCount(a.email), followerCount: followersOf(a.email).length, // Friends entry-point summary
    iAmHost, threads: loadInbox(a.email), photoMsg, ann: annPanel(a.email), minor: isMinor(a), showRoles: gate.viewerIsAdmin,
    positionGroups: positionGroups() }));
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
  const posOk = positionWhitelist();
  const position = [...new Set(posInput.filter(p => p && posOk.has(p)))].join(',');
  // Email opt-out — an unchecked checkbox doesn't POST, so absent = opted OUT.
  const email_optout = req.body.email_announce ? 0 : 1;
  // DOB: SET-ONCE by the member (add it if legacy/missing); an already-set dob can only be changed by
  // an admin — otherwise a minor could self-edit to adult and unlock DMs. Blank on edit = leave as-is.
  const dobIn = String(req.body.dob || '').trim();
  let dobToSave = a.dob || null;
  const stats = attendanceStats(a.email);
  // Full prop set so a validation error re-renders the WHOLE profile tab (bell, host inbox,
  // run-day control, announcement history) — not a stripped-down page. Reused by every error branch.
  const iAmHost = !!a.is_host, canOperate = isAdmin(req.userEmail) || !!a.is_team;
  const errProps = {
    a, stats, dmUnread: unreadCount(a.email), groupUnread: groupUnread(a.email), groupMention: groupMentionUnread(a.email, a.id),
    canOperate, iAmHost, announcementLog: canOperate ? announcementHistory() : [], threads: loadInbox(a.email), ann: annPanel(a.email),
    chatProgram: chatProgramFor(req), // keep the run-aware Chat tab correct on a validation re-render too
    minor: isMinor(a), // red safeguarding badge (dob is set-once, so unchanged on an error re-render)
    positionGroups: positionGroups(),
  };
  if (!full_name || !phone || !isValidEmail(email))
    return res.send(profileTabPage({ ...errProps, error: 'Name, phone, and a valid email are required.' }));
  if (email !== a.email && db.prepare('SELECT 1 FROM applicants WHERE email = ? AND id != ?').get(email, a.id))
    return res.send(profileTabPage({ ...errProps, error: 'That email is already in use by another player.' }));
  // Never let a self-service email change grant admin. Admin identity is the
  // ADMINS env set keyed by email, so changing INTO an admin address = takeover.
  if (email !== a.email && ADMINS.includes(email))
    return res.send(profileTabPage({ ...errProps, error: 'That email can’t be used. Pick another.' }));
  if (!a.dob && dobIn) {   // settable only when currently empty
    const age = ageFromDob(dobIn);
    if (age == null || age < 5 || age > 110) return res.send(profileTabPage({ ...errProps, error: 'That date of birth doesn’t look right.' }));
    dobToSave = dobIn;
  }
  // The identity row and its rekey cascade commit together or not at all — committing the
  // applicants row first would leave every history row (checkins, votes, DMs, chat, push subs)
  // stranded on the old address if the cascade failed, orphaning the account.
  try {
    transact(() => {
      db.prepare('UPDATE applicants SET full_name=?, phone=?, email=?, position=?, email_optout=?, dob=? WHERE id=?')
        .run(full_name, phone, email, position, email_optout, dobToSave, a.id);
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
  pcoQueuePatch(email, { full_name, phone });   // mirror the edit into PCO People (outbox; inert unless connected)
  if (email !== a.email) { setSession(res, email); refreshAvatarMap(); } // cookie IS the email — re-sign it; re-key the avatar map
  res.redirect('/profile?saved=1');
});

// ---------- DM at-rest encryption ----------
// Direct-message bodies are encrypted at rest (AES-256-GCM) so a leaked DB file / off-site
// backup does not spill people's private conversations in plaintext. The key is derived from
// SESSION_SECRET (already mandatory + fail-loud in auth.js) via HKDF — no new secret to manage,
// and no key material sits inside the DB it protects. Legacy plaintext rows (pre-encryption)
// stay readable: dmDec passes through anything without the `enc1:` marker, and empty bodies
// (sticker/photo-only rows) are never encrypted. This is at-rest privacy, NOT end-to-end: the
// host process can derive the key, so there is no admin-facing surface that reads DMs (that is
// deliberate), but the operator is not cryptographically locked out — see SECURITY-OVERVIEW.
const DM_KEY = crypto.hkdfSync('sha256',
  Buffer.from(process.env.SESSION_SECRET || 'CHANGE_ME_dev_secret_do_not_ship'),
  Buffer.from('bridge-dm-atrest'), Buffer.from('dm-body-v1'), 32);
function dmEnc(text) {
  if (!text) return text || '';                    // '' / null → store as-is (no empty ciphertext)
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(DM_KEY), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'enc1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function dmDec(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('enc1:')) return stored; // legacy plaintext / non-string
  try {
    const buf = Buffer.from(stored.slice(5), 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(DM_KEY), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return ''; }                             // tamper / wrong key → empty, never crash the thread
}

// ---------- MESSAGES (in-app, host <-> players) ----------
// Threads: requireLogin + requirePlayer + require an applicant row. Sender identity
// comes ONLY from req.userEmail — a body from_email is never trusted, so "message as
// someone else" is impossible.

// Inbox loader — grouped threads, newest first. One grouped query + two bulk lookups
// (counterparts, last-message snippets); no per-row queries. Consumed by the host's
// profile tab (the DM inbox lives there now — there is no standalone Messages tab).
const stmtInboxThreads = db.prepare(`
    SELECT CASE WHEN from_email = ? THEN to_email ELSE from_email END AS other,
           MAX(id) AS last_id,
           SUM(CASE WHEN to_email = ? AND read_at IS NULL THEN 1 ELSE 0 END) AS unread
    FROM messages WHERE from_email = ? OR to_email = ?
    GROUP BY other ORDER BY last_id DESC`);
function loadInbox(me) {
  const rows = stmtInboxThreads.all(me, me, me, me);
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
  for (const m of db.prepare(`SELECT id, from_email, body, image, created_at FROM messages WHERE id IN (${ph2})`).all(...lastIds)) {
    m.body = dmDec(m.body);                          // decrypt at-rest DM body for the preview snippet
    snips.set(m.id, m);
  }
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
const stmtDmHasHistory = db.prepare('SELECT 1 FROM messages WHERE (from_email=? AND to_email=?) OR (from_email=? AND to_email=?) LIMIT 1');
const stmtDmMarkRead = db.prepare("UPDATE messages SET read_at = datetime('now') WHERE to_email = ? AND from_email = ? AND read_at IS NULL");
const stmtDmThread = db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages WHERE (from_email=? AND to_email=?) OR (from_email=? AND to_email=?)
      ORDER BY id DESC LIMIT 500
    ) ORDER BY id ASC`);
app.get('/messages/:id', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  if (!gate.a) return res.redirect('/status');
  const me = req.userEmail, a = gate.a;
  const p = stmtApplicantById.get(Number(req.params.id) || 0);
  if (!p) return res.redirect('/messages');
  const hasHistory = !!stmtDmHasHistory.get(me, p.email, p.email, me);
  const canPost = canMessage(me, a, p);
  if (!canPost && !hasHistory) return res.redirect('/messages');
  stmtDmMarkRead.run(me, p.email);   // intentional GET side-effect (mark thread read) — compile-site moved, execution unchanged
  const msgs = stmtDmThread.all(me, p.email, p.email, me);
  for (const m of msgs) m.body = dmDec(m.body);        // decrypt at-rest DM bodies for the thread render
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
      for (const pr of db.prepare(`SELECT id, from_email, body, image FROM messages WHERE id IN (${ph3})`).all(...replyIds)) {
        pr.body = dmDec(pr.body);                     // decrypt reply-parent preview body
        parents.set(pr.id, pr);
      }
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
    const p = stmtApplicantById.get(Number(req.params.id) || 0);
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
          .run(me, p.email, dmEnc(body), replyTo || null);                   // body encrypted at rest
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
      .run(me, p.email, dmEnc(body), replyTo || null);                       // body encrypted at rest
    notifyDM(a, p.email, body);
    res.redirect(dest);
  });
});

// ---------- PLAYER SEARCH (Run Chat @-mention autocomplete) ----------
// Powers the @-mention dropdown in the Run Chat composer. Gated to approved players +
// admins (requirePlayer) and rate-limited. Searches ALL applicants by name (owner:
// "anyone in the database"), prefix matches ranked first, top 8. Returns esc-safe JSON
// [{id, name, avatar}] — name/avatar are data-only (client renders via textContent).
const stmtMentionSearch = db.prepare(`
    SELECT id, full_name, email, avatar FROM applicants
    WHERE full_name LIKE ? ESCAPE '\\' AND status = 'approved' AND email NOT LIKE '%@guest.local'
    ORDER BY (CASE WHEN full_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END), full_name COLLATE NOCASE
    LIMIT 8`);
app.get('/players/search', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  if (rateLimited('players-search', req.userEmail, 40, 60 * 1000)) return res.status(429).json([]);
  const q = String(req.query.q || '').trim().slice(0, 60);
  // Escape LIKE wildcards so a literal % / _ / \ in the query can't widen the match.
  const like = q.replace(/[\\%_]/g, c => '\\' + c);
  const rows = stmtMentionSearch.all('%' + like + '%', like + '%');
  res.json(rows.map(r => ({ id: r.id, name: r.full_name, avatar: avatarUrlFor(r.email) || '' })));
});

// ---------- SOCIAL GRAPH (Phase 6: friends + block) ----------
// UNIVERSAL, person-to-person (see `social_edges` in db.js — a directed edge table keyed on
// two emails). Friends power queue-with-friends + "view friends' games"; block is the safety
// valve consumed as a seating/team invariant (Phase 6b). This layer is program-agnostic: a
// friendship is one edge for the whole platform, not one per run.
//
// IDOR model: every mutating route takes a TARGET applicant id in the POST body, resolves it
// to that person's email SERVER-SIDE (the client never sends an email), and mutates ONLY the
// logged-in user's own edges — req.userEmail is the sole identity, so a forged body can never
// act as, or on behalf of, another person.
const lc = e => String(e || '').trim().toLowerCase();
// Hoisted reads (relationshipTo runs on every profile view; the list reads on /friends).
const stmtFriendEdge  = db.prepare(`SELECT from_email,to_email,status FROM social_edges WHERE kind='friend' AND ((from_email=? AND to_email=?) OR (from_email=? AND to_email=?)) LIMIT 1`);
const stmtAreFriends  = db.prepare(`SELECT 1 FROM social_edges WHERE kind='friend' AND status='accepted' AND ((from_email=? AND to_email=?) OR (from_email=? AND to_email=?)) LIMIT 1`);
const stmtBlockAny    = db.prepare(`SELECT 1 FROM social_edges WHERE kind='block' AND ((from_email=? AND to_email=?) OR (from_email=? AND to_email=?)) LIMIT 1`);
const stmtBlockDir    = db.prepare(`SELECT 1 FROM social_edges WHERE kind='block' AND from_email=? AND to_email=? LIMIT 1`);
const stmtFriendsOf   = db.prepare(`SELECT CASE WHEN from_email=? THEN to_email ELSE from_email END AS email FROM social_edges WHERE kind='friend' AND status='accepted' AND (from_email=? OR to_email=?)`);
const stmtReqIncoming = db.prepare(`SELECT from_email AS email, created_at FROM social_edges WHERE kind='friend' AND status='requested' AND to_email=? ORDER BY created_at DESC`);
const stmtReqOutgoing = db.prepare(`SELECT to_email   AS email, created_at FROM social_edges WHERE kind='friend' AND status='requested' AND from_email=? ORDER BY created_at DESC`);
const stmtBlockedByMe = db.prepare(`SELECT to_email   AS email, created_at FROM social_edges WHERE kind='block' AND from_email=? ORDER BY created_at DESC`);
// Follow (one-way, Javelin-style: "X started following you — follow back"). No accept step.
const stmtIsFollowing = db.prepare(`SELECT 1 FROM social_edges WHERE kind='follow' AND from_email=? AND to_email=? LIMIT 1`);
const stmtFollowersOf = db.prepare(`SELECT from_email AS email, created_at FROM social_edges WHERE kind='follow' AND to_email=? ORDER BY created_at DESC`);
const stmtFollowingOf = db.prepare(`SELECT to_email   AS email, created_at FROM social_edges WHERE kind='follow' AND from_email=? ORDER BY created_at DESC`);

const areFriends  = (a, b) => (a = lc(a), b = lc(b), !!stmtAreFriends.get(a, b, b, a));
const blockedPair = (a, b) => (a = lc(a), b = lc(b), !!stmtBlockAny.get(a, b, b, a)); // block in EITHER direction (Phase 6b invariant)
const iBlocked    = (a, b) => !!stmtBlockDir.get(lc(a), lc(b));                        // directed: did `a` block `b`?
const friendsOf   = me => (me = lc(me), stmtFriendsOf.all(me, me, me).map(r => r.email));
const isFollowing = (a, b) => !!stmtIsFollowing.get(lc(a), lc(b));                     // directed: does `a` follow `b`?
const followersOf = me => stmtFollowersOf.all(lc(me)).map(r => r.email);               // who follows me
const followingOf = me => stmtFollowingOf.all(lc(me)).map(r => r.email);               // who I follow
// "Friends" = we follow EACH OTHER (mutual). This is the consent boundary for seeing someone's
// game attendance — a one-way follow is NOT enough, so you never broadcast where you'll be to
// someone who hasn't followed you back.
const mutualFollowsOf = me => { const back = new Set(followersOf(me).map(e => lc(e))); return followingOf(me).filter(e => back.has(lc(e))); };
const friendReqIncomingCount = me => stmtReqIncoming.all(lc(me)).length;

// `me` is always req.userEmail (never a body field). Handlers are no-ops on bad/foreign input.
function friendRequest(me, them) {
  me = lc(me); them = lc(them);
  if (!them || me === them || blockedPair(me, them)) return;
  const e = stmtFriendEdge.get(me, them, them, me);
  if (e) {
    // If THEY already requested ME, my "request" accepts theirs (the natural mutual handshake).
    if (e.status === 'requested' && e.from_email === them)
      db.prepare(`UPDATE social_edges SET status='accepted', updated_at=datetime('now') WHERE kind='friend' AND from_email=? AND to_email=?`).run(them, me);
    return; // already friends, or I already asked → idempotent no-op
  }
  db.prepare(`INSERT INTO social_edges(from_email,to_email,kind,status) VALUES (?,?,'friend','requested')`).run(me, them);
}
function friendAccept(me, them) { // only the request's TARGET (to_email = me) can accept it
  me = lc(me); them = lc(them);
  db.prepare(`UPDATE social_edges SET status='accepted', updated_at=datetime('now')
              WHERE kind='friend' AND status='requested' AND from_email=? AND to_email=?`).run(them, me);
}
function friendDecline(me, them) { // decline an incoming request OR rescind my own outgoing one
  me = lc(me); them = lc(them);
  db.prepare(`DELETE FROM social_edges WHERE kind='friend' AND status='requested'
              AND ((from_email=? AND to_email=?) OR (from_email=? AND to_email=?))`).run(me, them, them, me);
}
function friendRemove(me, them) { // either party unfriends; drops the accepted edge either way
  me = lc(me); them = lc(them);
  db.prepare(`DELETE FROM social_edges WHERE kind='friend'
              AND ((from_email=? AND to_email=?) OR (from_email=? AND to_email=?))`).run(me, them, them, me);
}
function doBlock(me, them) { // one-way; auto-removes any friendship AND any follow in EITHER direction
  me = lc(me); them = lc(them);
  if (!them || me === them) return;
  db.prepare(`DELETE FROM social_edges WHERE kind IN ('friend','follow')
              AND ((from_email=? AND to_email=?) OR (from_email=? AND to_email=?))`).run(me, them, them, me);
  db.prepare(`INSERT OR IGNORE INTO social_edges(from_email,to_email,kind,status) VALUES (?,?,'block','accepted')`).run(me, them);
  dropSharedPartyMemberships(me, them); // block invariant also holds for parties already formed (P2-1)
}
function doUnblock(me, them) { // only the blocker (from_email) can lift their own block
  me = lc(me); them = lc(them);
  db.prepare(`DELETE FROM social_edges WHERE kind='block' AND from_email=? AND to_email=?`).run(me, them);
}
function doFollow(me, them) { // one-way, immediate (no accept); barred across a block either way
  me = lc(me); them = lc(them);
  if (!them || me === them || blockedPair(me, them)) return;
  db.prepare(`INSERT OR IGNORE INTO social_edges(from_email,to_email,kind,status) VALUES (?,?,'follow','accepted')`).run(me, them);
}
function doUnfollow(me, them) {
  me = lc(me); them = lc(them);
  db.prepare(`DELETE FROM social_edges WHERE kind='follow' AND from_email=? AND to_email=?`).run(me, them);
}
// Relationship of `me` toward `other` for button rendering.
function relationshipTo(me, other) {
  me = lc(me); other = lc(other);
  if (!other || me === other) return 'self';
  if (iBlocked(me, other)) return 'blocked';       // I blocked them
  if (iBlocked(other, me)) return 'blocked_by';    // they blocked me (hide friend affordances)
  const e = stmtFriendEdge.get(me, other, other, me);
  if (!e) return 'none';
  if (e.status === 'accepted') return 'friends';
  return e.from_email === me ? 'outgoing' : 'incoming';
}
// Bulk email → applicants row (id/name/avatar/status/badges), for turning edge lists into UI.
function peopleByEmails(emails) {
  const uniq = [...new Set((emails || []).map(lc))].filter(Boolean);
  const m = new Map();
  if (!uniq.length) return m;
  const ph = uniq.map(() => '?').join(',');
  for (const r of db.prepare(
    `SELECT id, full_name, email, avatar, status, is_host, is_team, is_regular, dob FROM applicants WHERE email IN (${ph})`).all(...uniq))
    m.set(lc(r.email), r);
  return m;
}
// "Friends' Games" — upcoming runs (ACTIVE programs only) where an accepted friend of `me` is on
// the roster. Grouped per (program, run_date) with the friends going + a Join link to that run.
function friendsGamesFor(me) {
  const fr = mutualFollowsOf(me); // FRIENDS = mutual follow — you see someone's games only if you follow each other
  if (!fr.length) return [];
  const today = ymdLocal(new Date(schedNow()));
  const ph = fr.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT c.program_id AS pid, c.run_date AS rd, c.email, c.name
      FROM checkins c JOIN program p ON p.id = c.program_id
     WHERE p.active = 1 AND c.run_date >= ? AND c.email IN (${ph})
     ORDER BY c.run_date, c.program_id, c.name COLLATE NOCASE`).all(today, ...fr);
  const groups = new Map();
  for (const r of rows) {
    const k = r.pid + '|' + r.rd;
    if (!groups.has(k)) groups.set(k, { programId: r.pid, runDate: r.rd, friends: [] });
    groups.get(k).friends.push({ email: r.email, name: r.name });
  }
  return [...groups.values()].map(g => ({
    ...g,
    programName: P(g.programId).displayName || P(g.programId).config?.name || 'Run',
    emoji: P(g.programId).emoji || '',
    href: P(g.programId).paths.run,
  }));
}

// Directory search → renderable rows {id,name,email,following,blocked} (approved non-guest, not me).
// Shared by the /friends page + the /friends/search typeahead fragment.
const stmtDirectorySearch = db.prepare(`
    SELECT id, full_name, email, status FROM applicants
    WHERE (full_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\') AND email <> ?
    ORDER BY (CASE WHEN full_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END), full_name COLLATE NOCASE
    LIMIT 25`);
function searchResultsFor(me, q) {
  q = String(q || '').trim().slice(0, 60);
  if (!q) return [];
  const like = q.replace(/[\\%_]/g, c => '\\' + c);
  const rows = stmtDirectorySearch.all('%' + like + '%', '%' + like + '%', lc(me), like + '%');
  return rows.filter(r => r.status === 'approved' && !/@guest\.local$/.test(r.email))
    .map(r => ({ id: r.id, name: r.full_name, email: r.email, following: isFollowing(me, r.email), blocked: blockedPair(me, r.email) }));
}

// Friends home — FOLLOW-only (mutual friend-requests dropped as redundant): live search +
// following + followers (follow-back) + games (people you follow) + blocked.
app.get('/friends', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  if (!gate.a) return res.redirect('/status');
  const me = req.userEmail;
  const q = String(req.query.q || '').trim().slice(0, 60);
  const blk = stmtBlockedByMe.all(lc(me));
  const flwrs = followersOf(me);           // people who follow me
  const flwng = followingOf(me);           // people I follow
  const followingSet = new Set(flwng.map(lc));
  const dir = peopleByEmails([...blk.map(r => r.email), ...flwrs, ...flwng]);
  const shape = email => { const p = dir.get(lc(email)); return p ? { id: p.id, name: p.full_name, email: p.email } : null; };
  const blocked  = blk.map(r => shape(r.email)).filter(Boolean);
  const followers = flwrs.map(e => { const p = shape(e); return p ? { ...p, followsBack: followingSet.has(lc(e)) } : null; })
    .filter(p => p && !iBlocked(me, p.email)); // "Follow back" vs "Following ✓"; hide any I've blocked
  const following = flwng.map(shape).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const chatProgram = chatProgramFor(req);
  const cc = chatCountsFor(chatProgram || 1, gate.a.email, gate.a.id);
  res.send(friendsPage({
    q, results: searchResultsFor(me, q), blocked, followers, following, games: friendsGamesFor(me),
    party: friendsPartyDataFor(me),
    dmUnread: unreadCount(gate.a.email), groupUnread: cc.group, groupMention: cc.gm,
    chatProgram, ann: annPanel(gate.a.email),
  }));
});
// Typeahead fragment for the live search box (returns just the result rows).
app.get('/friends/search', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res);
  if (!gate) return;
  if (!gate.a) return res.status(403).send('');
  if (rateLimited('friends-search', req.userEmail, 60, 60 * 1000)) return res.send('');
  res.send(friendsSearchFragment(searchResultsFor(req.userEmail, req.query.q)));
});

// Friend/block mutations. Shared wrapper: gate → resolve target id→email → run handler → swap
// back to the page the form was on (safeNextPath guards the redirect; defaults to /friends).
function socialRoute(fn) {
  return (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    if (!gate.a) return res.redirect('/status');
    const back = (typeof req.body.back === 'string' && req.body.back) ? safeNextPath(req.body.back) : '/friends';
    const t = db.prepare('SELECT email, status FROM applicants WHERE id = ?').get(Number(req.body.id) || 0);
    if (t && t.email) fn(req.userEmail, t.email, t);
    res.redirect(back);
  };
}
app.post('/friends/request', requireLogin, socialRoute((me, them, t) => {
  if (t.status !== 'approved' || /@guest\.local$/.test(them)) return;        // only friend real approved members
  if (!rateLimited('friend-req', me, 30, 10 * 60 * 1000)) friendRequest(me, them);
}));
app.post('/friends/accept',  requireLogin, socialRoute((me, them) => friendAccept(me, them)));
app.post('/friends/decline', requireLogin, socialRoute((me, them) => friendDecline(me, them)));
app.post('/friends/remove',  requireLogin, socialRoute((me, them) => friendRemove(me, them)));
app.post('/friends/block',   requireLogin, socialRoute((me, them) => doBlock(me, them)));
app.post('/friends/unblock', requireLogin, socialRoute((me, them) => doUnblock(me, them)));
app.post('/friends/follow',  requireLogin, socialRoute((me, them, t) => {
  if (t.status !== 'approved' || /@guest\.local$/.test(them)) return;
  if (!rateLimited('friend-follow', me, 60, 10 * 60 * 1000)) doFollow(me, them);
}));
app.post('/friends/unfollow', requireLogin, socialRoute((me, them) => doUnfollow(me, them)));

// ---------- RUN CHAT (single shared room for ALL approved players) ----------
// Coexists with the 1:1 host DMs above — separate tables, separate routes. All
// four routes: requireLogin + requirePlayer (approved players + admins). Sender
// identity comes ONLY from req.userEmail; a body from_email is never trusted.

// Chat is LOCKED until you've joined a run. The run-aware Chat tab points here for a viewer who
// belongs to no run; it explains why + links to the runs hub. Self-correcting: if they HAVE
// joined a run (e.g. just did), bounce straight to that run's chat rather than show the lock.
app.get('/chat/locked', requireLogin, (req, res) => {
  const pid = chatProgramFor(req);
  if (pid) return res.redirect(P(pid).paths.chat);
  res.send(chatLockedPage({ email: req.userEmail, dmUnread: unreadCount(req.userEmail) }));
});

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
      notifyChatOptIns(1, me, '💬 Sticker');
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
        notifyChatOptIns(1, me, body || '📷 Photo', mentions);
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
    notifyChatOptIns(1, me, body, mentions);
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
      notifyChatOptIns(1, me, '🎤 Voice note');
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
      notifyChatOptIns(1, me, '🎬 Video');
    } catch (e) {
      db.prepare('DELETE FROM group_messages WHERE id = ?').run(id); // no ghost row on disk failure
      console.error(`[chat] video write failed for ${me}: ${e.message}`);
      return res.status(500).json({ err: 'bad' });
    }
    res.json({ ok: 1 });
  });
});

// ---------- RUN CHAT (program-generic) ----------
// An opt-in run's own room on the UNIFIED group_messages tables (keyed by program_id) — the same
// media pipeline (/chat-media) + base-pathed chat view as basketball. Extracted from the pickleball
// chat routes so a new run gets its whole chat surface from mountRunProgram. Basketball keeps its
// own inline /chat (the hub run). Gate = programGate + membership; 404 while the run is hidden.
// Copy/theme/base/rate-limit-bucket/seq-key all come from the registry — no per-program branch.
function runChatGet(programId, req, res) {
  const g = runChatGate(programId, req, res); if (!g) return;
  setRunCookie(req, res, programId);
  const me = req.userEmail, p = P(programId);
  const chatData = loadChat(programId, me);
  const isMod = g.admin || !!(g.a && g.a.is_host);
  const canPin = isMod || !!(g.a && g.a.is_team);
  if (req.headers['x-prewarm'] !== '1') markChatRead(programId, me);
  res.send(runChatPage({
    me, chat: { me, ...chatData, isMod, canPin, err: req.query.err || '' },
    program: programId, theme: p.config.theme, sport: p.displayName, sportEmoji: p.emoji,
    base: p.paths.chat, pollPage: `${p.config.logTag}chat`,
    dmUnread: unreadCount(me), groupUnread: 0, groupMention: 0, ann: null,
  }));
}
function runChatSeen(programId, req, res) {
  const g = runChatGate(programId, req, res); if (!g) return;
  markChatRead(programId, req.userEmail);
  res.status(204).end();
}
function runChatOlder(programId, req, res) {
  const g = runChatGate(programId, req, res); if (!g) return;
  const me = req.userEmail;
  const before = parseInt(req.query.before, 10);
  if (!Number.isInteger(before) || before <= 0) return res.status(400).send('');
  const data = loadChatOlder(programId, me, before);
  const isMod = g.admin || !!(g.a && g.a.is_host);
  const canPin = isMod || !!(g.a && g.a.is_team);
  res.send(chatOlderFragment({ me, ...data, isMod, canPin, base: P(programId).paths.chat }));
}
function runChatPost(programId, req, res) {
  const cb = P(programId).paths.chat, cfg = P(programId).config;
  uploadChatImage(req, res, async (err) => {
    const g = runChatGate(programId, req, res); if (!g) return;
    if (mutedOut(g, res, { back: cb })) return;
    const me = req.userEmail;
    if (err) return res.redirect(`${cb}?err=` + (err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad'));
    const body = (req.body.body || '').trim().slice(0, 1000);
    const file = req.file;
    const sticker = stickerPath(req.body.sticker);
    let replyTo = Number(req.body.reply_to) || 0;
    if (replyTo && !db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = ?').get(replyTo, programId)) replyTo = 0;
    const mentions = body ? validMentions(req.body.mentions) : null;
    if (sticker) {
      if (rateLimited(`${cfg.logTag}chat-media`, me, 20, 10 * 60 * 1000)) return res.redirect(`${cb}?err=slow`);
      db.prepare('INSERT INTO group_messages (from_email, body, reply_to, image, program_id) VALUES (?,?,?,?,?)')
        .run(me, '', replyTo || null, sticker, programId);
      notifyChatOptIns(programId, me, '💬 Sticker');
      return res.redirect(cb);
    }
    if (file && file.buffer && file.buffer.length) {
      if (rateLimited(`${cfg.logTag}chat-media`, me, 15, 10 * 60 * 1000)) return res.redirect(`${cb}?err=slow`);
      if (!sniffImage(file.buffer)) return res.redirect(`${cb}?err=type`);
      let msgId = 0;
      try {
        const jpeg = await processChatImage(file.buffer);
        const info = db.prepare('INSERT INTO group_messages (from_email, body, reply_to, mentions, program_id) VALUES (?,?,?,?,?)')
          .run(me, body, replyTo || null, mentions, programId);
        msgId = info.lastInsertRowid;
        const imgPath = await writeChatImage(jpeg, msgId);
        db.prepare('UPDATE group_messages SET image = ? WHERE id = ?').run(imgPath, msgId);
        notifyChatMentions(programId, me, body, mentions);
        notifyChatOptIns(programId, me, body || '📷 Photo', mentions);
      } catch (e) {
        if (msgId) db.prepare('DELETE FROM group_messages WHERE id = ?').run(msgId);
        console.error(`[${cfg.logTag}chat] image process failed for ${me}: ${e.message}`);
        return res.redirect(`${cb}?err=bad`);
      }
      return res.redirect(cb);
    }
    if (!body) return res.redirect(cb);
    if (rateLimited(`${cfg.logTag}chat-send`, me, 30, 10 * 60 * 1000)) return res.redirect(`${cb}?err=slow`);
    db.prepare('INSERT INTO group_messages (from_email, body, reply_to, mentions, program_id) VALUES (?,?,?,?,?)')
      .run(me, body, replyTo || null, mentions, programId);
    notifyChatMentions(programId, me, body, mentions);
    notifyChatOptIns(programId, me, body, mentions);
    res.redirect(cb);
  });
}
function runChatReact(programId, req, res) {
  const cb = P(programId).paths.chat, cfg = P(programId).config;
  const g = runChatGate(programId, req, res); if (!g) return;
  if (mutedOut(g, res, { back: cb })) return;
  const me = req.userEmail;
  const messageId = Number(req.body.message_id) || 0;
  if (!db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = ?').get(messageId, programId)) return res.redirect(cb);
  const emoji = validEmoji(req.body.emoji);
  if (!emoji) return res.redirect(cb);
  if (rateLimited(`${cfg.logTag}chat-react`, me, 40, 10 * 60 * 1000)) return res.redirect(cb);
  const existing = db.prepare('SELECT emoji FROM group_reactions WHERE group_message_id = ? AND from_email = ?').get(messageId, me);
  if (existing && existing.emoji === emoji) {
    db.prepare('DELETE FROM group_reactions WHERE group_message_id = ? AND from_email = ?').run(messageId, me);
  } else {
    db.prepare(`INSERT INTO group_reactions (group_message_id, from_email, emoji, program_id) VALUES (?,?,?,?)
                ON CONFLICT(group_message_id, from_email) DO UPDATE SET emoji = excluded.emoji, created_at = datetime('now')`)
      .run(messageId, me, emoji, programId);
  }
  res.redirect(cb);
}
function runChatDelete(programId, req, res) {
  const cb = P(programId).paths.chat;
  const g = runChatGate(programId, req, res); if (!g) return;
  const me = req.userEmail;
  const messageId = Number(req.body.message_id) || 0;
  const msg = db.prepare('SELECT id, from_email, image, audio, video FROM group_messages WHERE id = ? AND program_id = ?').get(messageId, programId);
  if (!msg) return res.redirect(cb);
  const isMod = g.admin || !!(g.a && g.a.is_host);
  if (!isMod && msg.from_email !== me) return res.redirect(cb);
  db.prepare('DELETE FROM group_reactions WHERE group_message_id = ?').run(messageId);
  db.prepare('DELETE FROM group_messages WHERE id = ?').run(messageId);
  bumpChatSeqFor(programId);
  safeUnlinkChatImage(msg.image); safeUnlinkChatImage(msg.audio); safeUnlinkChatImage(msg.video);
  res.redirect(cb);
}
function runChatPin(programId, req, res) {
  const cb = P(programId).paths.chat;
  const g = runChatGate(programId, req, res); if (!g) return;
  if (mutedOut(g, res, { back: cb })) return;
  const canPin = g.admin || !!(g.a && (g.a.is_host || g.a.is_team));
  if (!canPin) return res.redirect(cb);
  const messageId = Number(req.body.message_id) || 0;
  const msg = db.prepare('SELECT id, pinned_at FROM group_messages WHERE id = ? AND program_id = ?').get(messageId, programId);
  if (!msg) return res.redirect(cb);
  if (msg.pinned_at) db.prepare('UPDATE group_messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?').run(messageId);
  else db.prepare("UPDATE group_messages SET pinned_at = datetime('now'), pinned_by = ? WHERE id = ?").run(req.userEmail, messageId);
  bumpChatSeqFor(programId);
  res.redirect(cb);
}
function runChatVoice(programId, req, res) {
  const cfg = P(programId).config;
  uploadChatAudio(req, res, async (err) => {
    const g = runChatGate(programId, req, res, true); if (!g) return;
    if (mutedOut(g, res, { json: true })) return;
    const me = req.userEmail;
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ err: err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad' });
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ err: 'empty' });
    const ext = sniffAudio(file.buffer);
    if (!ext) return res.status(415).json({ err: 'type' });
    if (rateLimited(`${cfg.logTag}chat-media`, me, 15, 10 * 60 * 1000)) return res.status(429).json({ err: 'slow' });
    let dur = Math.round(Number(req.body.dur) || 0);
    if (!(dur > 0)) dur = 0;
    if (dur > 300) dur = 300;
    let replyTo = Number(req.body.reply_to) || 0;
    if (replyTo && !db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = ?').get(replyTo, programId)) replyTo = 0;
    const info = db.prepare('INSERT INTO group_messages (from_email, body, reply_to, program_id) VALUES (?,?,?,?)')
      .run(me, '', replyTo || null, programId);
    const id = info.lastInsertRowid;
    try {
      const apath = await writeChatAudio(file.buffer, id, ext);
      db.prepare('UPDATE group_messages SET audio = ?, audio_dur = ? WHERE id = ?').run(apath, dur, id);
      notifyChatOptIns(programId, me, '🎤 Voice note');
    } catch (e) {
      db.prepare('DELETE FROM group_messages WHERE id = ?').run(id);
      console.error(`[${cfg.logTag}chat] voice write failed for ${me}: ${e.message}`);
      return res.status(500).json({ err: 'bad' });
    }
    res.json({ ok: 1 });
  });
}
function runChatVideo(programId, req, res) {
  const cfg = P(programId).config;
  uploadChatVideo(req, res, async (err) => {
    const g = runChatGate(programId, req, res, true); if (!g) return;
    if (mutedOut(g, res, { json: true })) return;
    const me = req.userEmail;
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ err: err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad' });
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ err: 'empty' });
    const ext = sniffVideo(file.buffer);
    if (!ext) return res.status(415).json({ err: 'type' });
    if (rateLimited(`${cfg.logTag}chat-media`, me, 15, 10 * 60 * 1000)) return res.status(429).json({ err: 'slow' });
    let dur = Math.round(Number(req.body.dur) || 0);
    if (!(dur > 0)) dur = 0;
    if (dur > 3600) dur = 3600;
    let replyTo = Number(req.body.reply_to) || 0;
    if (replyTo && !db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = ?').get(replyTo, programId)) replyTo = 0;
    const info = db.prepare('INSERT INTO group_messages (from_email, body, reply_to, program_id) VALUES (?,?,?,?)')
      .run(me, '', replyTo || null, programId);
    const id = info.lastInsertRowid;
    try {
      const vpath = await writeChatVideo(file.buffer, id, ext);
      db.prepare('UPDATE group_messages SET video = ?, video_dur = ? WHERE id = ?').run(vpath, dur, id);
      notifyChatOptIns(programId, me, '🎬 Video');
    } catch (e) {
      db.prepare('DELETE FROM group_messages WHERE id = ?').run(id);
      console.error(`[${cfg.logTag}chat] video write failed for ${me}: ${e.message}`);
      return res.status(500).json({ err: 'bad' });
    }
    res.json({ ok: 1 });
  });
}
// ---------- PICKLEBALL CHAT — delegates to the generic runChat* handlers (program 2) ----------
app.get('/pickleball/chat', requireLogin, (req, res) => runChatGet(2, req, res));
app.post('/pickleball/chat/seen', requireLogin, (req, res) => runChatSeen(2, req, res));
app.get('/pickleball/chat/older', requireLogin, (req, res) => runChatOlder(2, req, res));
app.post('/pickleball/chat', requireLogin, (req, res) => runChatPost(2, req, res));
app.post('/pickleball/chat/react', requireLogin, (req, res) => runChatReact(2, req, res));
app.post('/pickleball/chat/delete', requireLogin, (req, res) => runChatDelete(2, req, res));
app.post('/pickleball/chat/pin', requireLogin, (req, res) => runChatPin(2, req, res));
app.post('/pickleball/chat/voice', requireLogin, (req, res) => runChatVoice(2, req, res));
app.post('/pickleball/chat/video', requireLogin, (req, res) => runChatVideo(2, req, res));

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
    // Joining ON run day IS confirming (same reasoning as claim=confirm) — otherwise a held
    // late-regular released at 4 PM would be swept "unconfirmed" at 4:30 with zero warning.
    const ins = db.prepare("INSERT OR IGNORE INTO checkins (run_date,email,name,held,confirmed_at) VALUES (?,?,?,?, CASE WHEN ? = 1 THEN datetime('now') END)")
      .run(runDate, email, a.full_name, isLateRegular ? 1 : 0, runDate === ymdLocal() ? 1 : 0);
    if (ins.changes) metric('checkin_join', { programId: 1, runDate });   // self check-ins were the one common action with no durable trace
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
  // the floor positionally) and sign them in. Claiming IS confirming (they tapped "claim
  // my spot") — the ✓ also shields them from the run-day confirm-or-release sweep.
  db.prepare("UPDATE checkins SET offered_at = NULL, claim_token = NULL, confirmed_at = datetime('now') WHERE id = ?").run(row.id);
  audit(row.email, 'player', 'offer:claim', row.email);
  metric('offer_claim', { programId: 1, runDate: row.run_date, meta: `mins=${Math.round((Date.now() - row.offered_at) / 60000)}` });
  signIn(res, row.email, 'spot claim');
  return res.send(claimResultPage({ ok: true, runLabel: runLabelFor(row.run_date), runDate: row.run_date, startLabel: runStartLabel(row.run_date) }));
});

app.post('/checkin/leave', requireLogin, (req, res) => {
  const runDate = nextRunDate();
  // If they held a floor slot, offer it to the top waitlister (offer-and-confirm)
  // instead of silently auto-promoting. Capture the offeree BEFORE deleting.
  const wlBefore = waitlistOrderFor(1, runDate);   // F4
  const offeree = offereeForFloorLeave(runDate, req.userEmail);
  db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1').run(runDate, req.userEmail);
  if (offeree) createOffer(runDate, offeree, req);
  setImmediate(() => pingWaitlistShift(1, runDate, wlBefore));
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
      const wlBefore = waitlistOrderFor(1, runDate);   // F4 (P3-2)
      const offeree = offereeForFloorLeave(runDate, req.userEmail);
      db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1').run(runDate, req.userEmail);
      if (offeree) createOffer(runDate, offeree, req);
      setImmediate(() => pingWaitlistShift(1, runDate, wlBefore));
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
  const wlBefore = waitlistOrderFor(1, runDate);   // F4 snapshot — an operator removal shifts the list too
  // Removing a floor occupant frees a slot → offer it onward (capture before delete).
  const offeree = offereeForFloorLeave(runDate, target);
  db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1').run(runDate, target);
  if (offeree) createOffer(runDate, offeree, req);
  audit(req.userEmail, req.actorRole, 'checkin:remove', target);
  setImmediate(() => pingWaitlistShift(1, runDate, wlBefore));   // F4
  res.redirect('/checkin');
});

app.post('/checkin/promote', requireApprover, (req, res) => {
  const runDate = nextRunDate();
  const email = String(req.body.email || '').toLowerCase();
  const wlBefore = waitlistOrderFor(1, runDate);   // F4 snapshot — promoting a waitlister shifts those behind up
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
  setImmediate(() => pingWaitlistShift(1, runDate, wlBefore));   // F4: improvements only — a bump-down never pings
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
  liftExpiredPauses(1);              // clear elapsed auto-renew pauses before re-seating (dark w/o P(1).config.autoRenewPenalty)
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
// Basketball's kiosk-link mint/rotate — parity with the generic runKioskRotate (basketball still
// renders the legacy checkinPage, which the per-program kiosk controls never reached). Same token
// key the /kiosk/:pid route reads; rotating kills only basketball's screens.
app.post('/checkin/kiosk-rotate', requireApprover, (req, res) => {
  setSetting('kiosk_token_1', crypto.randomBytes(12).toString('base64url'));
  audit(req.userEmail, req.actorRole, 'kiosk:token-rotated', 'program 1');
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
  // Un-cancelling past the confirm cutoff must NOT arm an instant unpinged sweep — stamp/re-arm
  // the ping+sweep markers by the same rule as a date move.
  if (!cancel) migrateConfirmMarkers(runDate, effectiveConfirmCutoff(P(1).config.confirmCutoff), 'autoping_done', 'confirmsweep_done');
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

// A floor player confirms they're coming (run-day ping response) — or UNDOES it (un=1, the
// confirmed pill is a toggle: plans change). Idempotent both ways.
app.post('/checkin/confirm', requireLogin, (req, res) => {
  const runDate = nextRunDate();
  // Only real floor players confirm — a waitlister shouldn't pre-mark ✓ and slide on later.
  const part = partitionRun(runDate);
  if (part.floorReal.some(p => p.email === req.userEmail)) {
    if (req.body.un === '1') stmtConfirmClear.run(runDate, req.userEmail, 1);
    else stmtConfirmSet.run(runDate, req.userEmail, 1);
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
app.get('/admin', requireCouncil, (req, res) => {
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
  // The voting pool ("The Council"): explicit is_council members — its own role now, separate
  // from team/host/admin. Shown to all viewers of this page; (admin-only) names back the
  // who-voted lines below.
  const teamMembers = db.prepare(
    'SELECT full_name, email, is_host FROM applicants WHERE is_council = 1 ORDER BY full_name ASC').all();
  res.send(adminPage({
    applicants, runLabel: runLabelFor(runDate), runDate, hours: runTimeRange(runDate), checkedInCount, cap: CAP,
    waitlistCap: WAITLIST_CAP, preregCap: PREREG_CAP,
    viewerIsAdmin, viewerIsTeam: req.actorRole === 'team',
    viewerCanVote: pool.has(String(req.userEmail).toLowerCase()),   // council flag, not team/host inference
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
// photo + the source-pixel crop rect the browser computed and writes the final 2320×1102 JPEG.
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
        .resize(2320, 1102, { fit: 'fill' }) // 40:19 banner — matches .gymbanner/.cropframe CSS
        .jpeg({ quality: 84, mozjpeg: true }).toBuffer();
      await writeFileAtomic(BANNER_PATH, out); // atomic (temp+rename) so a read mid-upload never gets a partial
      audit(req.userEmail, req.actorRole, 'banner:update', `${width}x${height}`);
      return res.redirect('/checkin');
    } catch (e) {
      console.error(`[banner] crop failed for ${req.userEmail}: ${e.message}`);
      return res.redirect('/admin/banner?err=bad');
    }
  });
});
// Run banner change (program-generic) — same cropper as basketball, but writes each run's OWN
// banner file (config.bannerPath) + redirects to its own base path. Pickleball delegates here;
// volleyball (+ any future run) gets it via mountRunProgram. Basketball keeps its own /admin/banner
// (a different route on the shared gym.jpg), so it stays inline.
function runBannerGet(programId, req, res) {
  const b = P(programId).paths.run, cfg = P(programId).config;
  res.send(bannerPage({ err: req.query.err || '', bannerVer: bannerVersionFor(programId), action: `${b}/banner`, imgSrc: bannerSrcFor(programId), back: b, bodyClass: cfg.theme }));
}
function runBannerPost(programId, req, res) {
  const b = P(programId).paths.run, cfg = P(programId).config;
  uploadBanner(req, res, async (err) => {
    if (err) return res.redirect(`${b}/banner?err=` + (err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad'));
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.redirect(`${b}/banner?err=empty`);
    if (!sniffImage(file.buffer)) return res.redirect(`${b}/banner?err=type`);
    try {
      const m = await sharp(file.buffer).metadata();
      const oriented = (m.orientation || 1) >= 5;
      const W = oriented ? m.height : m.width, H = oriented ? m.width : m.height;
      let left = Math.round(Number(req.body.cx)), top = Math.round(Number(req.body.cy));
      let width = Math.round(Number(req.body.cw)), height = Math.round(Number(req.body.ch));
      if (!(W > 0 && H > 0 && width > 0 && height > 0)) return res.redirect(`${b}/banner?err=crop`);
      left = Math.max(0, Math.min(left, W - 1)); top = Math.max(0, Math.min(top, H - 1));
      width = Math.max(1, Math.min(width, W - left)); height = Math.max(1, Math.min(height, H - top));
      const out = await sharp(file.buffer, { failOn: 'error' }).rotate()
        .extract({ left, top, width, height })
        .resize(2320, 1102, { fit: 'fill' })
        .jpeg({ quality: 84, mozjpeg: true }).toBuffer();
      await writeFileAtomic(cfg.bannerPath, out); // atomic (temp+rename) so a read mid-upload never gets a partial
      audit(req.userEmail, req.actorRole, `${cfg.logTag}:banner:update`, `${width}x${height}`);
      return res.redirect(b);
    } catch (e) {
      console.error(`[${cfg.logTag}-banner] crop failed for ${req.userEmail}: ${e.message}`);
      return res.redirect(`${b}/banner?err=bad`);
    }
  });
}
// Pickleball banner — delegates to the generic handler (writes pk-banner.jpg).
app.get('/pickleball/banner', requireAdmin, (req, res) => runBannerGet(2, req, res));
app.post('/pickleball/banner', requireAdmin, (req, res) => runBannerPost(2, req, res));

// A council member casts (or changes) their vote. Recomputed live.
app.post('/admin/vote', requireCouncil, (req, res) => {
  const { id, vote } = req.body;
  // Only the COUNCIL votes (applicants.is_council — the same pool recomputeStatus counts).
  // Admins run the app but don't get a vote; team/host membership no longer implies one.
  const voter = db.prepare('SELECT is_council FROM applicants WHERE email = ?').get(String(req.userEmail).toLowerCase());
  if (!voter || !voter.is_council) return res.status(403).send('Only council members vote on applicants.');
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
  const { id, role, on } = req.body; // role: 'team' | 'regular' | 'host' | 'council'
  const turnOn = on === '1';
  const a = db.prepare('SELECT status, email FROM applicants WHERE id = ?').get(id);
  if (!a) return res.redirect('/admin');
  if (role === 'council') {
    // Council = a vote on Adv Basketball applicants, NOTHING else (no operator tools, no
    // auto-seat, no admin). Pure flag — no status side-effect; grant it to approved people.
    db.prepare('UPDATE applicants SET is_council = ? WHERE id = ?').run(turnOn ? 1 : 0, id);
    audit(req.userEmail, 'admin', `role:council:${turnOn ? 'on' : 'off'}`, a.email);
  } else if (role === 'team') {
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
  if (runIsCancelled(raw)) { setRunCancelled(raw, false); migrateConfirmMarkers(raw, effectiveConfirmCutoff(P(1).config.confirmCutoff), 'autoping_done', 'confirmsweep_done'); audit(email, actorRole, 'run:uncancel-via-rundate', raw); }

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
      // Confirm ping + sweep markers follow the same rule — never let the moved day sweep unpinged.
      migrateConfirmMarkers(newRunDate, effectiveConfirmCutoff(P(1).config.confirmCutoff), 'autoping_done', 'confirmsweep_done');
      db.prepare('UPDATE checkins SET run_date = ? WHERE run_date = ? AND program_id = 1').run(newRunDate, oldRunDate);
      db.prepare('UPDATE regular_optout SET run_date = ? WHERE run_date = ? AND program_id = 1').run(newRunDate, oldRunDate);
      // The night-scoped tables the teams board runs on. They were missing here: moving a run left
      // the Planning Center roster and both sides stranded on the old date, so the board rendered
      // blank until someone re-synced, and any games logged that night dropped off the leaderboard
      // while Undo silently no-opped on a date that no longer had them.
      // OR REPLACE, not a plain UPDATE: both PKs are (program_id, run_date, email), so a row
      // already sitting on the TARGET date collides. That is not hypothetical — moves made before
      // this carry existed stranded rows on exactly those dates, so the first move after the fix
      // is the most likely one to hit it. Colliding target rows lose; the moving night wins.
      db.prepare('UPDATE OR REPLACE run_roster SET run_date = ? WHERE run_date = ? AND program_id = 1').run(newRunDate, oldRunDate);
      db.prepare('UPDATE OR REPLACE team_assignments SET run_date = ? WHERE run_date = ? AND program_id = 1').run(newRunDate, oldRunDate);
      migrateGamesNight(1, oldRunDate, newRunDate);
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
    const like = `%${q.replace(/[\\%_]/g, c => '\\' + c)}%`; // escape wildcards (consistency w/ public searches)
    people = db.prepare(
      `SELECT * FROM applicants WHERE full_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
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
  // Per-program waivers (F6): which programs have their own, and every signed record grouped by
  // email — the person card shows each program's state with a verify affordance. Empty until a
  // program opts in, so this section renders nothing today.
  const waiverProgs = [...PROGRAMS.values()].filter(p => p.config.waiver)
    .map(p => ({ key: p.config.waiver.key, label: p.displayName }));
  const waiverRecs = {};
  if (waiverProgs.length) for (const r of db.prepare('SELECT * FROM waiver_records').all()) (waiverRecs[r.email] = waiverRecs[r.email] || []).push(r);
  res.send(peoplePage({ people, q, approvedPhones, signInUrl, invites, newInviteLink, msg: req.query.msg || '', ann: annPanel(req.userEmail), dmUnread: unreadCount(req.userEmail), groupUnread: groupUnread(req.userEmail), groupMention: groupMentionUnread(req.userEmail, applicantIdOf(req.userEmail)), waiverProgs, waiverRecs }));
});

// Organizer confirms a PROGRAM's waiver document they have actually seen (F6 twin of
// /admin/people/waiver): upserts the record with verified_at/verified_by — sighting the signed
// document (guardian signature included, for youth waivers) satisfies the program's gate outright.
app.post('/admin/people/waiver-record', requireAdmin, (req, res) => {
  const a = db.prepare('SELECT email, full_name FROM applicants WHERE id = ?').get(req.body.id);
  if (!a) return res.redirect('/admin/people?msg=' + encodeURIComponent('No such person.'));
  const key = String(req.body.key || '');
  const prog = [...PROGRAMS.values()].find(p => p.config.waiver && p.config.waiver.key === key);
  if (!prog) return res.redirect('/admin/people?msg=' + encodeURIComponent('No program uses that waiver.'));
  const em = String(a.email).toLowerCase();
  if (req.body.on === '0') {
    db.prepare('UPDATE waiver_records SET verified_at = NULL, verified_by = NULL WHERE waiver_key = ? AND email = ?').run(key, em);
    audit(req.userEmail, 'admin', 'people:waiver-record-unverify', `${key}:${em}`);
    return res.redirect('/admin/people?msg=' + encodeURIComponent(`Cleared the ${prog.displayName} confirmation for ${a.full_name} — their own attestation stands.`));
  }
  db.prepare(`INSERT INTO waiver_records (waiver_key, email, verified_at, verified_by)
      VALUES (?, ?, datetime('now','localtime'), ?)
    ON CONFLICT(waiver_key, email) DO UPDATE SET verified_at = excluded.verified_at, verified_by = excluded.verified_by`)
    .run(key, em, req.userEmail);
  audit(req.userEmail, 'admin', 'people:waiver-record-verified', `${key}:${em}`);
  res.redirect('/admin/people?msg=' + encodeURIComponent(`${a.full_name}'s ${prog.displayName} waiver is confirmed on file.`));
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
  const roleOf = (a) => [a.is_host ? 'Host' : a.is_team ? 'Team' : a.is_regular ? 'Core' : '', a.is_council ? 'Council' : ''].filter(Boolean).join('+');
  const lines = [['Name', 'Email', 'Phone', 'Status', 'Role', 'Position', 'Waiver', 'Waiver date', 'Email opt-out', 'Applied'].join(',')];
  for (const a of rows) lines.push([
    a.full_name, a.email, a.phone, a.status, roleOf(a), a.position,
    a.waiver_ok ? 'yes' : 'no', a.waiver_at || (a.waiver_ok ? 'not recorded' : ''),
    a.email_optout ? 'yes' : 'no', a.created_at,
  ].map(cell).join(','));
  audit(req.userEmail, 'admin', 'people:export', String(rows.length));
  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Disposition', `attachment; filename="bridge-people-${stamp}.csv"`);
  res.type('text/csv').send('\uFEFF' + lines.join('\r\n')); // BOM = Excel reads UTF-8
});

// RFC-4180 CSV cell with spreadsheet-formula-injection neutralized (shared by the exports).
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                    // a name like =HYPERLINK(...) can't run as a formula
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// Export hub (admin-only): attendance CSV per run + a full DB backup. The CSV is the Google-
// Sheets / Planning-Center import path (paste or File\u2192Import); the .db is an offline backup.
app.get('/admin/export', requireAdmin, (req, res) => {
  const programs = [...PROGRAMS.values()].filter(p => !P(p.id).config.static).map(p => ({   // demo (static) isn't a records source
    id: p.id, key: p.key, name: p.displayName, emoji: p.emoji, active: p.active(),
    count: db.prepare('SELECT COUNT(*) n FROM attendance WHERE program_id = ?').get(p.id).n,
  }));
  res.send(exportPage({ programs, dmUnread: unreadCount(req.userEmail),
    groupUnread: groupUnread(req.userEmail), groupMention: groupMentionUnread(req.userEmail, applicantIdOf(req.userEmail)),
    ann: annPanel(req.userEmail) }));
});
// Per-program attendance CSV (run_date, name, email, program). Archived attendance only \u2014
// the live floor isn't logged until the weekly rollover, matching the season board.
app.get('/admin/export/attendance.csv', requireAdmin, (req, res) => {
  const pid = Number(req.query.program) || 0;
  if (!PROGRAMS.has(pid) || P(pid).config.static) return res.status(404).send('Unknown run');  // demo isn't a records source
  const prog = P(pid);
  const rows = db.prepare(`SELECT run_date, name, email FROM attendance
     WHERE program_id = ? ORDER BY run_date DESC, name COLLATE NOCASE ASC`).all(pid);
  const lines = [['Run date', 'Name', 'Email', 'Program'].join(',')];
  for (const a of rows) lines.push([a.run_date, a.name, a.email, prog.displayName].map(csvCell).join(','));
  audit(req.userEmail, 'admin', 'attendance:export', `${prog.key}:${rows.length}`);
  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Disposition', `attachment; filename="bridge-attendance-${prog.key}-${stamp}.csv"`);
  res.type('text/csv').send('\uFEFF' + lines.join('\r\n'));
});
// Full DB backup (admin-only). Streams a transactionally-consistent VACUUM INTO snapshot (never
// the live WAL'd file) written to a UNIQUE transient path \u2014 so it never collides with the
// scheduled backupNow() (whose second-precision filenames would clash) and has none of its side
// effects. Deleted after the response. Contains ALL data (chat, DMs, contacts) \u2192 requireAdmin +
// audited; the page warns to store it securely.
const EXPORT_TMP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
app.get('/admin/export/db', requireAdmin, (req, res, next) => {
  let tmp;
  try {
    fs.mkdirSync(EXPORT_TMP_DIR, { recursive: true });
    tmp = path.join(EXPORT_TMP_DIR, `export-${process.pid}-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); // consistent copy regardless of WAL state
  } catch (e) {
    console.error(`[export:db] snapshot FAILED for ${req.userEmail}: ${e.message}`);
    return res.status(500).send('Export failed \u2014 check the server log.');
  }
  audit(req.userEmail, 'admin', 'db:export', '');
  const stamp = new Date().toISOString().slice(0, 10);
  res.download(tmp, `bridge-backup-${stamp}.db`, (err) => {
    fs.unlink(tmp, () => {}); // best-effort cleanup of the transient snapshot
    if (err && !res.headersSent) next(err);
  });
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
  const dob = String(req.body.dob || '').trim();   // admin may set/correct/clear (blank = clear)
  const cur = db.prepare('SELECT email FROM applicants WHERE id = ?').get(id);
  if (!cur) return res.redirect('/admin/people');
  if (dob) { const age = ageFromDob(dob); if (age == null || age < 5 || age > 110) return res.redirect('/admin/people?msg=' + encodeURIComponent('That date of birth doesn’t look right.')); }
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
      db.prepare('UPDATE applicants SET full_name=?, email=?, phone=?, dob=? WHERE id=?')
        .run(full_name, email, phone, dob || null, id);
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
  pcoQueuePatch(email, { full_name, phone });   // mirror the edit into PCO People (outbox; inert unless connected)
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

// ---------- SESSIONS (S1) ----------
// Version lookup for auth.js: applicants row for members; an app_settings fallback covers admins
// with no applicant row (admin identity is the ADMINS env set, a row is optional).
const stmtSessVer = db.prepare('SELECT session_ver v FROM applicants WHERE email = ?');
setSessionVersionLookup((email) => {
  const row = stmtSessVer.get(String(email).toLowerCase());
  if (row) return row.v || 0;
  return Number(getSetting('sessver_' + String(email).toLowerCase()) || 0);
});
// "Sign out everywhere": bump the version → every cookie ever issued for this account dies at its
// next request, including on a lost/stolen device. Key-event audited (S6) — a revocation is
// exactly the record someone asks about later.
// Opt-in "every chat message" pushes (2026-08-05). Default OFF = the standing posture
// (announcements / offers / mentions / DMs only). Per person, all programs.
app.post('/profile/chatpush', requireLogin, (req, res) => {
  db.prepare('UPDATE applicants SET chat_push = ? WHERE email = ?')
    .run(req.body.on === '1' ? 1 : 0, req.userEmail);
  res.redirect('/profile');
});
app.post('/profile/logoutall', requireLogin, (req, res) => {
  const email = req.userEmail.toLowerCase();
  const r = db.prepare('UPDATE applicants SET session_ver = session_ver + 1 WHERE email = ?').run(email);
  if (!r.changes) setSetting('sessver_' + email, Number(getSetting('sessver_' + email) || 0) + 1);
  audit(email, 'player', 'session:signout-all', '');
  clearSession(res);
  res.redirect('/login?msg=' + encodeURIComponent('Signed out on every device. Sign in again below.'));
});

// ---------- ANALYTICS (F5) ----------
// The church-facing question isn't "who came Tuesday" (rosters answer that) — it's trend, reach and
// stickiness: is the run growing, how many are NEW, do people come back. Computed straight from the
// permanent attendance log; per-RUN buckets (not calendar weeks) because a run is the natural unit.
// Friendly names for notification kinds in the pulse breakdown. Tags carry program ids
// (wlmove2, gatedann) — match by family, fall back to the raw tag.
function pushKindLabel(tag) {
  if (!tag) return 'Untagged';
  if (tag === 'offer') return 'Spot offers';
  if (tag === 'announce' || /ann$/.test(tag)) return 'Announcements';
  if (tag === 'confirm') return 'Confirm reminders';
  if (/^wlmove/.test(tag)) return 'Waitlist moves';
  if (tag === 'adminlogin') return 'Admin sign-in alerts';
  if (/^joinreq/.test(tag)) return 'Join requests';
  if (/mention/.test(tag)) return 'Chat mentions';
  return tag;
}
app.get('/admin/analytics', requireAdmin, (req, res) => {
  // Engagement pulse (metrics layer): actives from last_seen_at, notification volume + taps and
  // installs from metrics_events. Display-ready strings computed HERE so the view stays dumb.
  // Per-kind open rates: sends carry the tag in meta; taps carry "tag|path" since the SW started
  // passing &tag= (older tap rows are bare paths and stay out of the per-kind split).
  const kindAgg = new Map();
  for (const r of db.prepare("SELECT meta, COALESCE(SUM(n),0) s FROM metrics_events WHERE kind='push_send' AND at >= datetime('now','localtime','-30 days') GROUP BY meta").all()) {
    const k = pushKindLabel(r.meta); const a = kindAgg.get(k) || { sent: 0, opened: 0 }; a.sent += r.s; kindAgg.set(k, a);
  }
  for (const r of db.prepare("SELECT meta FROM metrics_events WHERE kind='push_tap' AND at >= datetime('now','localtime','-30 days')").all()) {
    const bar = String(r.meta || '').indexOf('|'); if (bar <= 0) continue;
    const k = pushKindLabel(r.meta.slice(0, bar)); const a = kindAgg.get(k) || { sent: 0, opened: 0 }; a.opened++; kindAgg.set(k, a);
  }
  const kinds = [...kindAgg.entries()].map(([label, v]) => ({ label, ...v })).sort((x, y) => y.sent - x.sent);
  const pulse = {
    kinds,
    wau: db.prepare("SELECT COUNT(*) n FROM applicants WHERE last_seen_at >= datetime('now','localtime','-7 days')").get().n,
    mau: db.prepare("SELECT COUNT(*) n FROM applicants WHERE last_seen_at >= datetime('now','localtime','-30 days')").get().n,
    pushes30: db.prepare("SELECT COALESCE(SUM(n),0) s FROM metrics_events WHERE kind='push_send' AND at >= datetime('now','localtime','-30 days')").get().s,
    taps30: db.prepare("SELECT COUNT(*) n FROM metrics_events WHERE kind='push_tap' AND at >= datetime('now','localtime','-30 days')").get().n,
    installs: db.prepare("SELECT COUNT(*) n FROM metrics_events WHERE kind='pwa_install'").get().n,
  };
  const cards = [];
  for (const p of PROGRAMS.values()) {
    if (p.id === 90) continue;
    const runs = db.prepare(`
      SELECT a.run_date, COUNT(*) n,
             SUM(CASE WHEN f.first = a.run_date THEN 1 ELSE 0 END) newcomers
      FROM attendance a
      JOIN (SELECT email, MIN(run_date) first FROM attendance WHERE program_id = ? GROUP BY email) f
        ON f.email = a.email
      WHERE a.program_id = ? AND a.email NOT LIKE '%@guest.local'
      GROUP BY a.run_date ORDER BY a.run_date DESC LIMIT 12`).all(p.id, p.id).reverse();
    if (!runs.length) continue;   // nothing to chart yet — the card would just be zeros
    const last4 = db.prepare('SELECT DISTINCT run_date FROM attendance WHERE program_id = ? ORDER BY run_date DESC LIMIT 4').all(p.id).map(r => r.run_date);
    const retained = last4.length < 4 ? null : db.prepare(`
      SELECT COUNT(*) n FROM (
        SELECT email FROM attendance WHERE program_id = ? AND run_date IN (${last4.map(() => '?').join(',')})
        GROUP BY email HAVING COUNT(DISTINCT run_date) >= 3)`).get(p.id, ...last4).n;
    const yr = db.prepare(`
      SELECT COUNT(*) total, COUNT(DISTINCT email) uniques
      FROM attendance WHERE program_id = ? AND run_date >= strftime('%Y-01-01','now') AND email NOT LIKE '%@guest.local'`).get(p.id);
    // Demand + fill-speed from run_summary (metrics layer) — appears once summaries exist.
    const rs = db.prepare(`SELECT COUNT(*) runs, AVG(wait_n) avgWait,
        SUM(offers_sent) osent, SUM(offers_claimed) oclaim,
        AVG(CASE WHEN opened_at IS NOT NULL AND filled_at IS NOT NULL
            THEN (julianday(filled_at) - julianday(opened_at)) * 1440 END) fillMins
      FROM run_summary WHERE program_id = ? AND cancelled = 0`).get(p.id);
    const demand = rs && rs.runs ? {
      runs: rs.runs,
      avgWait: (rs.avgWait ?? 0).toFixed(1),
      fillMins: rs.fillMins != null ? String(Math.round(rs.fillMins)) : null,
      claimPct: rs.osent ? String(Math.round((rs.oclaim / rs.osent) * 100)) : null,
    } : null;
    cards.push({ name: p.displayName, emoji: p.emoji, runs, retained, total: yr.total, uniques: yr.uniques, demand,
      active4: last4.length < 4 ? null : db.prepare(`SELECT COUNT(DISTINCT email) n FROM attendance WHERE program_id = ? AND run_date IN (${last4.map(() => '?').join(',')})`).get(p.id, ...last4).n });
  }
  res.send(analyticsPage({ cards, pulse }));
});

// ---------- AUDIT VIEWER (S6 follow-up) — the permanent record, readable ----------
// audit_key_events is the never-pruned legal record (waiver verifications, role grants, admin
// sign-ins). These are its only read surfaces; nothing here can write to the table. Filters are
// whitelisted + bound — free text only ever reaches a LIKE parameter.
function keyEventQuery(req) {
  const q = String(req.query.q || '').trim().slice(0, 200);
  const action = String(req.query.action || '').trim().slice(0, 80);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = dateRe.test(String(req.query.from || '')) ? String(req.query.from) : '';
  const to = dateRe.test(String(req.query.to || '')) ? String(req.query.to) : '';
  const where = [], params = [];
  if (q) { where.push('(actor LIKE ? OR target LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (action) { where.push('action = ?'); params.push(action); }
  if (from) { where.push('at >= ?'); params.push(from + ' 00:00:00'); }
  if (to) { where.push('at <= ?'); params.push(to + ' 23:59:59'); }
  return { q, action, from, to, sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}
app.get('/admin/audit', requireAdmin, (req, res) => {
  const f = keyEventQuery(req);
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const total = db.prepare('SELECT COUNT(*) n FROM audit_key_events' + f.sql).get(...f.params).n;
  const rows = db.prepare('SELECT * FROM audit_key_events' + f.sql + ' ORDER BY id DESC LIMIT 101 OFFSET ?').all(...f.params, page * 100);
  const actions = db.prepare('SELECT DISTINCT action FROM audit_key_events ORDER BY action').all().map((r) => r.action);
  res.send(auditViewerPage({ rows: rows.slice(0, 100), hasMore: rows.length > 100, page, total, actions, q: f.q, action: f.action, from: f.from, to: f.to }));
});
// ---------- RUN HISTORY — the run_summary browser (proposal #1) ----------
// Per-run receipts of the numbers the archive keeps: demand, fill speed, offer outcomes.
// Read-only; CSV carries every row for spreadsheets/pitches.
app.get('/admin/history', requireAdmin, (req, res) => {
  const sections = [];
  for (const p of PROGRAMS.values()) {
    if (p.config.static) continue;
    const rows = db.prepare(`SELECT *, CASE WHEN opened_at IS NOT NULL AND filled_at IS NOT NULL
        THEN CAST(ROUND((julianday(filled_at) - julianday(opened_at)) * 1440) AS INTEGER) END fill_mins
      FROM run_summary WHERE program_id = ? ORDER BY run_date DESC LIMIT 200`).all(p.id);
    if (rows.length) sections.push({ name: p.displayName, emoji: p.emoji, rows });
  }
  res.send(runHistoryPage({ sections }));
});
app.get('/admin/history.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM run_summary ORDER BY run_date DESC').all();
  const nameOf = (pid) => (PROGRAMS.get(pid) || { displayName: `program ${pid}` }).displayName;
  const lines = ['Program,Run date,Floor,Waitlisted,Guests,Cap,Cancelled,Check-in opened,First check-in,Floor full,Offers sent,Offers claimed,Offers expired',
    ...rows.map((r) => [nameOf(r.program_id), r.run_date, r.floor_n, r.wait_n, r.guest_n, r.cap, r.cancelled ? 'yes' : '', r.opened_at, r.first_checkin_at, r.filled_at, r.offers_sent, r.offers_claimed, r.offers_expired].map(csvCell).join(','))];
  res.setHeader('Content-Disposition', 'attachment; filename="run-history.csv"');
  res.type('text/csv').send('﻿' + lines.join('\r\n'));
});

app.get('/admin/audit.csv', requireAdmin, (req, res) => {
  const f = keyEventQuery(req);
  const rows = db.prepare('SELECT at, actor, actor_role, action, target FROM audit_key_events' + f.sql + ' ORDER BY id DESC').all(...f.params);
  const lines = ['When,Actor,Role,Action,Target', ...rows.map((r) => [r.at, r.actor, r.actor_role, r.action, r.target].map(csvCell).join(','))];
  res.setHeader('Content-Disposition', 'attachment; filename="key-events.csv"');
  res.type('text/csv').send('\uFEFF' + lines.join('\r\n')); // BOM = Excel reads UTF-8
});

// ---------- SCHEDULED ANNOUNCEMENTS (F8) ----------
// 'YYYY-MM-DDTHH:MM' from a datetime-local input, kept in LOCAL time (all scheduling in this app
// is local — cutoffs, pings, waiver dates). Returns the normalized string only if it parses and is
// in the future; anything else means "post now".
function parseScheduleAt(v) {
  // A duplicated form field arrives as an ARRAY under express.urlencoded — String() would mangle
  // it, fail the regex, and silently convert "scheduled" into "post now" (the P1 that shipped F8
  // broken). Take the first non-empty value so a stray duplicate can never flip the meaning.
  if (Array.isArray(v)) v = v.find((x) => String(x || '').trim()) || '';
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return null;
  const t = new Date(s + ':00').getTime();
  return Number.isFinite(t) && t > schedNow() ? s : null;
}
const localNowMinute = () => {
  const d = new Date(schedNow());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
// Fire due posts (60s tick). AT the moment it fires it becomes an ordinary live announcement:
// archive the program's previous live post, flip pending off, push — and email if that was ticked
// when it was scheduled.
// Precise firing (owner request 2026-08-04: "send the instant of the scheduled time"): a single
// armed timeout targets the NEXT due publish_at exactly, so a 7:00 post fires AT 7:00, not at
// the first 60s tick after it. The tick still calls fireScheduledAnnouncements as the safety net
// (a lost timer — crash, clock jump — costs at most the old minute of lag, never the post).
// Re-armed on boot, on schedule, on cancel, and after every fire. Under TEST_NOW the timer never
// arms AT ALL: it computes its delay from the real clock while the due check reads the test clock,
// so a pinned-past TEST_NOW would arm 0ms → fire → nothing due → re-arm 0ms, a hot spin. The
// harness fires through /admin/test/tick instead — which is the documented design.
let schedFireTimer = null;
function armScheduleTimer() {
  if (TEST_NOW != null) return;
  if (schedFireTimer) { clearTimeout(schedFireTimer); schedFireTimer = null; }
  const next = db.prepare('SELECT MIN(publish_at) m FROM announcements WHERE pending = 1').get().m;
  if (!next) return;
  const ms = new Date(next + ':00').getTime() - Date.now();   // publish_at is minute-granular local
  schedFireTimer = setTimeout(() => {
    schedFireTimer = null;
    try { fireScheduledAnnouncements(); } catch (e) { console.error(`[announce] timed fire failed: ${e.message}`); armScheduleTimer(); }
  }, Math.max(0, Math.min(ms + 250, 2147000000)));   // +250ms lands just past the minute boundary; clamp ≈24d re-arms itself
  schedFireTimer.unref();   // the 60s tick (also unref'd) is the delivery guarantee; never pin the event loop
}
function fireScheduledAnnouncements() {
  const due = db.prepare(
    "SELECT id, program_id, body, author, sched_email FROM announcements WHERE pending = 1 AND publish_at <= ? ORDER BY publish_at, id").all(localNowMinute());
  // ORDER BY publish_at (not id): on a catch-up batch (downtime, same-minute posts) the
  // LAST-firing post stays live — that must be the latest-scheduled one, not the highest id.
  for (const a of due) {
    // Fire = INSERT a FRESH row + drop the pending one: the unread-bell dot is `id > last_seen_id`
    // and the panel orders by id DESC, so flipping pending=0 in place kept the OLD id — no dot,
    // wrong order, for anyone who'd seen a later post meanwhile. Archive+insert+delete commit as
    // ONE transaction: a mid-fire throw (transient SQLITE_BUSY) must not leave the fresh row live
    // with the pending row intact, or the next tick fires it AGAIN (duplicate rows + push).
    try {
      db.exec('BEGIN');
      db.prepare("UPDATE announcements SET archived = 1, archived_at = datetime('now') WHERE archived = 0 AND COALESCE(pending,0) = 0 AND program_id = ?").run(a.program_id);
      db.prepare('INSERT INTO announcements (body, author, program_id) VALUES (?,?,?)').run(a.body, a.author, a.program_id);
      db.prepare('DELETE FROM announcements WHERE id = ?').run(a.id);
      audit('system', 'system', 'announce:fired', `${a.program_id}:${a.body.slice(0, 40)}`);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} console.error(`[announce] fire failed for #${a.id}: ${e.message}`); continue; }
    const isBball = a.program_id === 1;
    const url = isBball ? '/checkin' : P(a.program_id)?.paths.run;
    if (!url) continue;   // program deleted since scheduling — row fired into history, nobody pushed
    const title = isBball ? 'The Bridge Runs' : P(a.program_id).config.copy.annTitle;
    const targets = isBball ? approvedEmails() : programMemberEmails(a.program_id);
    setImmediate(() => sendPush(targets.filter(e => e.toLowerCase() !== String(a.author).toLowerCase()),
      { title, body: a.body.slice(0, 140), url, tag: isBball ? 'announce' : `${P(a.program_id).config.logTag}ann` }));
    if (a.sched_email && emailConfigured) {
      const recipients = isBball ? announcementRecipients() : programEmailRecipients(a.program_id);
      setImmediate(() => { try { if (recipients.length) sendAnnouncement(recipients, a.body, a.author).catch(e => console.error(`[sched-announce] email FAILED: ${e.message}`)); } catch (e) { console.error(`[sched-announce] ${e.message}`); } });
    }
  }
  armScheduleTimer();   // next pending post gets its own precise timer
}

// ---------- KIOSK (F7) ----------
// A big-screen live roster for the gym door (TV/laptop): floor + waitlist, refreshing itself.
// Auth: an admin session works directly; for a shared screen with no login, an admin mints a
// kiosk link carrying a token (`?k=`), revocable by regenerating. Read-only by construction.
// The one gate every screen-on-the-wall route passes through — door roster, ladder board, and any
// future one. It lives here ONCE: a second copy of a token comparison is a second place to get the
// timing-safe compare, the legacy-token fallback or the hidden-program rule subtly wrong.
// Returns null (having answered the request) when the caller must stop.
function kioskGate(req, res) {
  const pid = Number(req.params.pid);
  if (!PROGRAMS.has(pid)) { res.status(404).send('Not found'); return null; }
  const admin = isAdmin(currentUser(req));
  // The static DEMO kiosk is ADMIN-SESSION-ONLY (owner ask 2026-08-05: show the door screen on
  // the synthetic roster while demoing). No demo token exists or can ever mint (runKioskRotate's
  // static guard), so there is no shareable demo link; everyone else 404s like any hidden program.
  if (pid === 90 && !admin) { res.status(404).send('Not found'); return null; }
  // Timing-safe token compare (P3-3) — an early-exit === leaks prefix-match timing. Length guard
  // first: timingSafeEqual throws on unequal lengths. Per-program tokens (proposal #3) so one
  // program's leaked link is revocable alone; the legacy global token keeps old screens working.
  const tok = String(req.query.k || '');
  const tokEq = (want) => !!want && tok.length === want.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(want));
  // Legacy global token only while NO per-program token exists: minting a program's own link
  // then self-retires the global for THAT program, so "screens on the old link stop working"
  // (the rotate confirm) is actually true (2026-08-05 audit P3-3).
  const perProg = String(getSetting(`kiosk_token_${pid}`) || '');
  const tokenOk = tokEq(perProg) || (!perProg && tokEq(String(getSetting('kiosk_token') || '')));
  if (!tokenOk && !admin) { res.status(403).send('Kiosk link required.'); return null; }
  // A token must not expose an UNPUBLISHED program's roster (P3-3): hidden = admins only.
  if (!programActive(pid) && !admin) { res.status(404).send('Not found'); return null; }
  return { pid, admin };
}
// The ladder on the wall: same revocable link as the door screen, no login, read-only by
// construction (nothing here writes, and the page carries no controls). Self-refreshing so a
// projector left on all night follows the standings as games land.
app.get('/kiosk/:pid/ladder', (req, res) => {
  const k = kioskGate(req, res); if (!k) return;
  const cfg = ladderCfg(k.pid); if (!cfg) return res.status(404).send('Not found');
  const p = P(k.pid), from = ladderFrom(k.pid);
  res.send(ladderBoardPage({
    sport: p.displayName, emoji: p.emoji, theme: p.config.theme || '',
    award: cfg.award || 'Sportsmanship',
    dateLabel: runLabelFor(ladderRunDate(k.pid)),
    standings: ladderStandings(k.pid, from), noms: ladderNominations(k.pid, from),
  }));
});
app.get('/kiosk/:pid', (req, res) => {
  const k = kioskGate(req, res); if (!k) return;
  const pid = k.pid;
  const rd = pid === 1 ? nextRunDate() : programRunDate(pid);
  const part = partitionFor(pid, rd);
  const floor = (P(pid).config.offerWindow ? part.floorReal : part.floor) || [];
  const wait = (part.wait || part.waitPlayers || []);
  // Door arrivals (PCO Phase 2b): today's station taps, from pco.js's viewer-driven cache.
  // Roster membership is decided HERE (pco.js only maps taps → linked emails) — a tap from
  // someone with no spot tonight is a walk-in, whether or not their account is linked.
  const arr = pcoKioskArrivals(rd, ymdLocal(new Date(schedNow())));
  const tappedIn = (p) => !!(arr && arr.arrived.has(lc(p.email || '')));
  const fl = floor.map(p => ({ name: p.name || p.email, email: p.email || '', confirmed: !!p.confirmed_at, arrived: tappedIn(p) }));
  const wl = wait.map(p => ({ name: p.name || p.email, email: p.email || '', arrived: tappedIn(p) }));
  let door = null;
  if (arr) {
    const rostered = new Set([...floor, ...wait].map(p => lc(p.email || '')));
    let walkIns = arr.unlinkedTaps;
    for (const e of arr.arrived) if (!rostered.has(e)) walkIns++;
    door = { live: arr.live, arrived: fl.concat(wl).filter(p => p.arrived).length, walkIns };
  }
  res.send(kioskPage({
    sport: P(pid).displayName, emoji: P(pid).emoji, theme: P(pid).config.theme || '',
    runDate: rd, dateLabel: runLabelFor(rd), cap: P(pid).config.cap,
    floor: fl, wait: wl, door,
    cancelled: runCancelledFor(pid, rd),
  }));
});
// Admin: mint/rotate kiosk tokens — per program now (proposal #3). With a pid, rotate ONE
// program's token; without, mint fresh tokens for every real program AND rotate the legacy
// global away so "refresh" means what it says.
app.post('/admin/kiosk', requireAdmin, (req, res) => {
  const pid = Number(req.body.pid);
  if (Number.isInteger(pid) && PROGRAMS.has(pid) && !P(pid).config.static) {
    setSetting(`kiosk_token_${pid}`, crypto.randomBytes(12).toString('base64url'));
    audit(req.userEmail, 'admin', 'kiosk:token-rotated', `program ${pid}`);
    return res.redirect('/admin/programs?msg=' + encodeURIComponent(`${P(pid).displayName} kiosk link refreshed — its old screens stop working.`));
  }
  for (const p of PROGRAMS.values()) if (!p.config.static) setSetting(`kiosk_token_${p.id}`, crypto.randomBytes(12).toString('base64url'));
  delSetting('kiosk_token');   // the global-era token dies with a full refresh
  audit(req.userEmail, 'admin', 'kiosk:token-rotated', 'all programs');
  res.redirect('/admin/programs?msg=' + encodeURIComponent('Kiosk links refreshed for every program — old screens stop working, grab new links from the cards.'));
});

// ---------- HEALTH (S4) ----------
// For the uptime monitor: cheap, unauthenticated, and it actually exercises the DB — a hung
// SQLite handle should page the owner, not just a dead port. Returns no data beyond up/degraded.
app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.type('text/plain').send('ok');
  } catch (e) {
    console.error(`[healthz] DB check failed: ${e.message}`);
    res.status(503).type('text/plain').send('degraded');
  }
});

// ---------- BOTTOM-NAV LOCALIZER (admin) ----------
// The floating-nav bug only occurs in the installed iOS PWA, which nothing local can reproduce.
// Six fixes were written for it without one measurement from the failing device. An admin
// long-presses the masthead while the bug is on screen; this stores exactly what the device
// reported. docs/NAV-LOCALIZER.md maps a capture to a single mechanism — read, then fix.
// Admin-gated both ways: a member's long-press writes nothing (and shows nothing).
const stmtGeoInsert = db.prepare('INSERT INTO geo_reports (actor, server_ver, payload) VALUES (?,?,?)');
app.post('/debug/geo', requireAdmin, express.raw({ type: '*/*', limit: '256kb' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {});
  try { JSON.parse(raw); } catch { return res.status(400).end(); }   // store only valid JSON
  // The server stamps its OWN build, so client/server version skew is computed from a trusted side.
  const info = stmtGeoInsert.run(req.userEmail, String(BUILD_VER), raw);
  audit(req.userEmail, 'admin', 'debug:geo-capture', String(info.lastInsertRowid));
  res.status(204).end();
});
app.get('/debug/geo', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, at, actor, server_ver, payload FROM geo_reports ORDER BY id DESC LIMIT 20').all();
  res.type('application/json').send(JSON.stringify(
    rows.map(r => ({ ...r, payload: (() => { try { return JSON.parse(r.payload); } catch { return r.payload; } })() })), null, 2));
});

// ---------- PROGRAMS (admin) — create a new run/program from the app, no deploy ----------
// The church's answer to "can we add a youth program ourselves?": this writes a `program` row +
// JSON spec, rebuilds the registry, and mounts the routes live. Code-defined programs (basketball,
// pickleball, volleyball, demo) are read-only here — they can be published/hidden but never edited
// or deleted through this screen, so the live runs can't be reconfigured by accident.
const PROGRAM_CODE_IDS = new Set([1, 2, 3, 90]);
const DEMO_PROGRAM_ID = 90;
function programAdminRows() {
  return db.prepare('SELECT * FROM program ORDER BY id').all().map(row => {
    const p = PROGRAMS.get(row.id);
    let spec = null; try { spec = JSON.parse(row.config || 'null'); } catch {}
    const counts = db.prepare('SELECT (SELECT COUNT(*) FROM checkins WHERE program_id=?) c, (SELECT COUNT(*) FROM attendance WHERE program_id=?) a, (SELECT COUNT(*) FROM group_messages WHERE program_id=?) m, (SELECT COUNT(*) FROM program_membership WHERE program_id=?) mem').get(row.id, row.id, row.id, row.id);
    // NB: basketball's hand-written config predates the generic shape — it has NO `keys` object
    // (its setting names are inline) and carries start/end as 'HH:MM' strings rather than
    // startHour/endHour. Read defensively so this screen renders every program, old shape or new.
    const cfg = p ? p.config : null;
    const hour = (v) => (Number.isFinite(v) ? v : null);
    return {
      id: row.id, name: p ? p.displayName : row.name, slug: row.slug, active: !!row.active, approval: row.approval,
      editable: !PROGRAM_CODE_IDS.has(row.id), builtIn: PROGRAM_CODE_IDS.has(row.id),
      mounted: !!p, emoji: p ? p.emoji : (spec && spec.emoji) || '',
      runPath: p ? p.paths.run : (row.slug ? '/' + row.slug : ''),
      cap: cfg ? cfg.cap : null, dow: cfg && Number.isFinite(cfg.dow) ? cfg.dow : null,
      // One ready-to-print label, built here because server.js owns the clock formatter: the
      // generic shape carries whole hours, basketball carries 'HH:MM' strings — both render.
      timeLabel: !cfg ? ''
        : Number.isFinite(cfg.startHour) && Number.isFinite(cfg.endHour)
          ? fmtClockRange(startHHMM(cfg), endHHMM(cfg))
          : (cfg.start && cfg.end ? fmtClockRange(cfg.start, cfg.end) : ''),
      startHour: cfg ? hour(cfg.startHour) : null, endHour: cfg ? hour(cfg.endHour) : null,
      theme: cfg ? cfg.theme : '', spec,
      hasData: counts.c > 0 || counts.a > 0 || counts.m > 0, members: counts.mem,
      runDate: cfg ? (cfg.keys ? (getSetting(cfg.keys.runDate) || '') : nextRunDate()) : '',
      seasonStart: cfg && cfg.keys ? (getSetting(cfg.keys.seasonStart) || '') : '',   // wizard edit form field (F6 follow-up)
      // Per-program kiosk link (proposal #3): its own token, falling back to the global-era one.
      kioskUrl: (() => { const t = getSetting(`kiosk_token_${row.id}`) || getSetting('kiosk_token'); return t ? `/kiosk/${row.id}?k=${t}` : ''; })(),
    };
  });
}
// Validate + normalize the wizard's input into the stored spec. Returns {spec, name, slug, approval}
// or {error}. Everything the engine needs is either validated here or derived in defFromRow.
function parseProgramForm(body, { existingSlug = null } = {}) {
  const name = String(body.name || '').trim().slice(0, 40);
  if (name.length < 2) return { error: 'Give the program a name (at least 2 characters).' };
  // The name is a DISPLAY string that reaches page headings, aria-labels, placeholders and push
  // copy. Restrict it to characters a program name actually needs — letters (any language),
  // digits, spaces, and . - / + — so no markup or quote character can ever be stored. The views
  // escape it too; this is the input contract that makes the stored value safe by construction.
  if (!/^[\p{L}\p{N} .\-/+]{2,40}$/u.test(name))
    return { error: 'The program name can use letters, numbers, spaces and . - / + only.' };
  const emoji = String(body.emoji || '🏅').trim().slice(0, 4) || '🏅';
  if (/[<>"'`&\\]/.test(emoji)) return { error: 'Pick a plain emoji for the icon.' };
  const slug = String(body.slug || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,20}$/.test(slug)) return { error: 'The web address can only use lowercase letters, numbers and dashes (2–21 characters, starting with a letter).' };
  if (slug !== existingSlug) {
    // Program-collision FIRST: a mounted program's routes also make its slug "reserved", and
    // "another program already uses this" is the message that tells the admin what to actually do.
    if (db.prepare('SELECT 1 FROM program WHERE slug = ?').get(slug)) return { error: `Another program already uses “/${slug}”.` };
    if (slugIsReserved(slug)) return { error: `“/${slug}” is already used by the app — pick a different web address.` };
  }
  const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
  const cap = int(body.cap, 0), waitlist = int(body.waitlist, 0), prereg = int(body.prereg, 0);
  if (cap < 1 || cap > 200) return { error: 'Floor size must be between 1 and 200.' };
  if (waitlist < 0 || waitlist > 50) return { error: 'Waitlist size must be between 0 and 50.' };
  if (prereg < 0 || prereg > cap) return { error: 'Early-access spots can’t exceed the floor size.' };
  const dow = int(body.dow, -1);
  if (dow < 0 || dow > 6) return { error: 'Pick which day of the week the run happens.' };
  const startHour = int(body.startHour, -1), endHour = int(body.endHour, -1);
  if (startHour < 0 || startHour > 23) return { error: 'Pick a valid start time.' };
  if (endHour <= startHour || endHour > 24) return { error: 'The end time has to be after the start time.' };
  const hhmm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
  const lockTime = hhmm(body.lockTime) ? String(body.lockTime) : `${String(startHour).padStart(2, '0')}:00`;
  const confirmMode = String(body.confirmMode || 'none');
  let confirmCutoff = null;
  if (confirmMode === 'cutoff') {
    if (!hhmm(body.confirmCutoff)) return { error: 'Give the confirm deadline as a time like 16:30.' };
    confirmCutoff = String(body.confirmCutoff);
  }
  const teamsCount = int(body.teamsCount, 0), teamsSize = int(body.teamsSize, 0);
  if (teamsCount < 0 || teamsCount > 12) return { error: 'Teams: pick between 0 and 12.' };
  if (teamsCount > 0 && (teamsSize < 1 || teamsSize > 30)) return { error: 'Team size must be between 1 and 30.' };
  const partySize = int(body.partySize, 0);
  if (partySize < 0 || partySize > 12) return { error: 'Group sign-up size must be between 0 and 12.' };
  // joinMode is ENFORCED now (F3: runJoinRun + memberOf + the request flow), so the picker is
  // honest again. The legacy `approval` column stays 'open' — joinMode in the spec is the authority.
  const joinMode = ['open', 'invite', 'host'].includes(body.joinMode) ? body.joinMode : 'open';
  const approval = 'open';
  // Positions (F6): one per line, "CODE Label" (e.g. "GK Goalkeeper"). Codes are what get stored
  // on profiles; labels are the chip captions. Empty = this program has no position picker.
  const positions = String(body.positions || '').split(/\r?\n/)
    .map(l => l.trim()).filter(Boolean).slice(0, 16)
    .map(l => { const sp = l.search(/\s/); return sp < 0 ? [l, ''] : [l.slice(0, sp), l.slice(sp + 1).trim()]; })
    .map(([c, l]) => [c.toUpperCase().slice(0, 6), l.slice(0, 24)])
    .filter(([c]) => /^[A-Z0-9]+$/.test(c));
  const spec = {
    displayName: name, emoji, joinMode,
    cap, waitlist, prereg,
    dow, startHour, endHour,
    lockTime, confirmCutoff,
    pingHour: 9, pingDowOffset: 0, openOffsetDays: -7,
    theme: PROGRAM_THEMES.includes(body.theme) ? body.theme : 'default',
    offerWindow: body.seating === 'offer',
    autoRenew: body.autoRenew === '1',
    teams: teamsCount > 0 ? { count: teamsCount, size: teamsSize } : null,
    groupQueue: partySize > 1 ? { maxSize: partySize } : null,
    positions: positions.length ? positions : null,
    // Own waiver + guardian consent (F6 youth pack). Guardian consent implies an own waiver —
    // the consent attestation lives ON the program's waiver record. waiverKey is stamped by the
    // create route (frozen at the creation-time slug) so renames never orphan signed records.
    waiver: (body.waiverMode === 'own' || body.waiverGuardian === '1')
      ? { own: true, guardian: body.waiverGuardian === '1' } : null,
  };
  return { spec, name, slug, approval };
}
app.get('/admin/programs', requireAdmin, (req, res) => {
  res.send(programsAdminPage({ rows: programAdminRows(), msg: req.query.msg || '', form: req.query.form === '1', themes: PROGRAM_THEMES, kioskToken: getSetting('kiosk_token') || '' }));
});
app.post('/admin/programs/create', requireAdmin, (req, res) => {
  const parsed = parseProgramForm(req.body);
  if (parsed.error) return res.redirect('/admin/programs?form=1&msg=' + encodeURIComponent(parsed.error));
  if (parsed.spec.waiver) parsed.spec.waiverKey = parsed.slug;   // frozen forever — renames must not orphan signed waiver records (F6)
  // ids 4..89 are the in-app range (90 is the demo showcase, reserved).
  const maxRow = db.prepare('SELECT MAX(id) m FROM program WHERE id < ?').get(DEMO_PROGRAM_ID);
  const id = Math.max(4, (maxRow.m || 3) + 1);
  if (id >= DEMO_PROGRAM_ID) return res.redirect('/admin/programs?msg=' + encodeURIComponent('Program limit reached — archive an old program first.'));
  try {
    db.prepare('INSERT INTO program (id,name,sport,slug,active,approval,config) VALUES (?,?,?,?,0,?,?)')
      .run(id, parsed.name, parsed.slug, parsed.slug, parsed.approval, JSON.stringify(parsed.spec));
  } catch (e) {
    return res.redirect('/admin/programs?form=1&msg=' + encodeURIComponent('Couldn’t create that program: ' + e.message.slice(0, 100)));
  }
  buildPrograms();            // registry + view meta + PCO sport labels
  mountPendingPrograms();     // routes live immediately — no restart
  // Season start from the form (F6 follow-up) — after buildPrograms so P(id) exists. Invalid dates
  // don't block creation; the program lands and the message says what to fix.
  const season = applySeasonStart(id, req.body.seasonStart);
  audit(req.userEmail, 'admin', 'program:create', `${id}:${parsed.slug}`);
  res.redirect('/admin/programs?msg=' + encodeURIComponent(`Created ${parsed.name}.` +
    (season.err ? ' The season date didn’t look right (not past, within a year) — set it in its Settings.' : '') +
    ` It's hidden — publish it when it's ready.`));
});
app.post('/admin/programs/edit', requireAdmin, (req, res) => {
  const id = Number(req.body.id);
  const row = db.prepare('SELECT * FROM program WHERE id = ?').get(id);
  if (!row) return res.redirect('/admin/programs?msg=' + encodeURIComponent('No such program.'));
  if (PROGRAM_CODE_IDS.has(id)) return res.redirect('/admin/programs?msg=' + encodeURIComponent('Basketball, pickleball, volleyball and the demo are managed in code — they can be published or hidden here, not edited.'));
  const parsed = parseProgramForm(req.body, { existingSlug: row.slug });
  if (parsed.error) return res.redirect('/admin/programs?msg=' + encodeURIComponent(parsed.error));
  // Waiver key survives every edit (F6): carry the creation-time stamp; a program that ENABLES
  // its own waiver later gets stamped with its current slug from that moment on.
  if (parsed.spec.waiver) {
    let oldKey = null;
    try { oldKey = (JSON.parse(row.config || '{}') || {}).waiverKey || null; } catch {}
    parsed.spec.waiverKey = oldKey || row.slug;
  }
  transact(() => {
    db.prepare('UPDATE program SET name=?, sport=?, slug=?, approval=?, config=? WHERE id=?')
      .run(parsed.name, parsed.slug, parsed.slug, parsed.approval, JSON.stringify(parsed.spec), id);
    // A slug rename moves the program's ENTIRE app_settings namespace (run date, season start,
    // scheduler markers, chat sequence — all keyed <slug>_*). Without this carry, the renamed
    // program silently loses its run date and re-fires open/lock/sweep once, and the old rows
    // leak forever.
    if (parsed.slug !== row.slug) {
      for (const suf of ['run_date', 'run_base', 'season_start', 'autoopen_done', 'autoping_done',
                         'autolock_done', 'arassess_done', 'confirmsweep_done', 'chat_seq']) {
        const v = getSetting(`${row.slug}_${suf}`);
        if (v != null) { setSetting(`${parsed.slug}_${suf}`, v); }
        delSetting(`${row.slug}_${suf}`);
      }
    }
  });
  buildPrograms();
  // A slug change means new paths: mount the new ones (the old routes stay registered but their
  // program is gone from the registry, so they 404 through the normal gate — never a stale run).
  MOUNTED_PROGRAMS.delete(id);
  mountPendingPrograms();
  // Season start rides the same form (F6 follow-up): unchanged is a no-op; blanking clears the gate.
  const season = applySeasonStart(id, req.body.seasonStart);
  audit(req.userEmail, 'admin', 'program:edit', `${id}:${parsed.slug}`);
  res.redirect('/admin/programs?msg=' + encodeURIComponent(season.err
    ? 'Saved — but the season date didn’t look right (not past, within a year), so it wasn’t changed.'
    : 'Saved'));
});
// F2/F3: per-program member management (admin). Hosts approve REQUESTS on the run page; roles and
// invite-mode additions are an admin action here, so host-granting stays with the org owner.
app.post('/admin/programs/member', requireAdmin, (req, res) => {
  const id = Number(req.body.id);
  const email = String(req.body.email || '').trim().toLowerCase();
  const act = String(req.body.act || '');
  if (!PROGRAMS.has(id) || id === 90) return res.redirect('/admin/programs?msg=' + encodeURIComponent('No such program.'));
  if (!isValidEmail(email)) return res.redirect('/admin/programs?msg=' + encodeURIComponent('That email doesn’t look valid.'));
  const a = applicantByEmail(email);
  const back = (m) => res.redirect('/admin/programs?msg=' + encodeURIComponent(m));
  if (act === 'add' || act === 'host') {
    if (!a || a.status !== 'approved') return back('They need an approved app account first (People & invites).');
    joinProgramMembership(id, email);   // approved membership (no-op if already a member)
    db.prepare("UPDATE program_membership SET status = 'approved', role = ? WHERE program_id = ? AND email = ?")
      .run(act === 'host' ? 'host' : 'approved', id, email);
    audit(req.userEmail, 'admin', act === 'host' ? 'program:host-granted' : 'program:member-added', `${id}:${email}`);
    if (act === 'host') setImmediate(() => sendPush([email], {
      title: `You're a host — ${P(id).displayName}`,
      body: 'You can open/close check-in, post announcements, add guests and approve join requests for this run.',
      url: P(id).paths.run, tag: `host${id}`,
    }));
    return back(act === 'host' ? `${a.full_name} is now a host of ${P(id).displayName}.` : `${a.full_name} added to ${P(id).displayName}.`);
  }
  if (act === 'unhost') {
    db.prepare("UPDATE program_membership SET role = 'approved' WHERE program_id = ? AND email = ? AND role = 'host'").run(id, email);
    audit(req.userEmail, 'admin', 'program:host-revoked', `${id}:${email}`);
    return back('Host role removed (they stay a member).');
  }
  if (act === 'remove') {
    db.prepare('DELETE FROM program_membership WHERE program_id = ? AND email = ?').run(id, email);
    audit(req.userEmail, 'admin', 'program:member-removed', `${id}:${email}`);
    return back('Removed from the program (their app account is untouched).');
  }
  back('Unknown action.');
});
app.post('/admin/programs/active', requireAdmin, (req, res) => {
  const id = Number(req.body.id), on = req.body.on === '1';
  const row = db.prepare('SELECT * FROM program WHERE id = ?').get(id);
  if (!row) return res.redirect('/admin/programs?msg=' + encodeURIComponent('No such program.'));
  if (id === 1) return res.redirect('/admin/programs?msg=' + encodeURIComponent('The basketball run is always live.'));
  db.prepare('UPDATE program SET active=? WHERE id=?').run(on ? 1 : 0, id);
  buildPrograms();
  audit(req.userEmail, 'admin', on ? 'program:publish' : 'program:hide', `${id}:${row.slug}`);
  res.redirect('/admin/programs?msg=' + encodeURIComponent(on
    ? `${row.name} is live — every approved member can see it now.`
    : `${row.name} is hidden again (admins only).`));
});
app.post('/admin/programs/delete', requireAdmin, (req, res) => {
  const id = Number(req.body.id);
  const row = db.prepare('SELECT * FROM program WHERE id = ?').get(id);
  if (!row) return res.redirect('/admin/programs?msg=' + encodeURIComponent('No such program.'));
  if (PROGRAM_CODE_IDS.has(id)) return res.redirect('/admin/programs?msg=' + encodeURIComponent('That program is managed in code and can’t be deleted here.'));
  // Never silently destroy history: a program that has ANY rosters, attendance or chat can only be
  // hidden. Delete is for a mis-created program, and even then it's an explicit empty-only path.
  // The ladder counts as history. A run whose ATTENDANCE lives in Planning Center and whose only
  // record here is the board (exactly pickleball's shape) has zero checkins and zero attendance —
  // without this term the guard called a whole season "empty" and offered to delete it.
  const used = db.prepare(`SELECT (SELECT COUNT(*) FROM checkins WHERE program_id=?) c, (SELECT COUNT(*) FROM attendance WHERE program_id=?) a,
                                  (SELECT COUNT(*) FROM group_messages WHERE program_id=?) m, (SELECT COUNT(*) FROM ladder_games WHERE program_id=?) l,
                                  (SELECT COUNT(*) FROM run_headcount WHERE program_id=?) h`).get(id, id, id, id, id);
  if (used.c || used.a || used.m || used.l || used.h)
    return res.redirect('/admin/programs?msg=' + encodeURIComponent(`${row.name} already has sign-ups, attendance, chat or ladder history — hide it instead of deleting, so the records survive.`));
  // Every program_id-scoped table, so a later program can't inherit orphans if this id is reused.
  // (P2-3: run_summary + metrics_events joined this list when the metrics layer shipped — ids ARE
  // reused, and INSERT OR IGNORE on run_summary's PK would silently keep a dead program's rows in
  // a new program's demand card.)
  const cfg = (PROGRAMS.get(id) || {}).config || {};
  transact(() => {
    for (const t of ['program_membership', 'run_state', 'run_overrides', 'announcements', 'group_reads',
                     'regular_optout', 'team_assignments', 'group_reactions', 'votes', 'run_summary', 'metrics_events',
                     'ladder_games', 'ladder_players', 'ladder_nominations', 'run_headcount',
                     'run_roster', 'run_games'])
      db.prepare(`DELETE FROM ${t} WHERE program_id=?`).run(id);
    // run_game_players has no program_id of its own — reach it through the games just deleted, or
    // a reused id inherits orphaned seats pointing at game rows that no longer exist.
    db.prepare('DELETE FROM run_game_players WHERE game_id NOT IN (SELECT id FROM run_games)').run();
    // Announcement dismissals key by announcement id — sweep rows orphaned by the announcements delete.
    db.prepare('DELETE FROM announcement_dismissals WHERE announcement_id NOT IN (SELECT id FROM announcements)').run();
    // Parties for this run are keyed by group, not program_id — reach them through their run rows.
    const groups = db.prepare('SELECT id FROM signup_groups WHERE program_id=?').all(id).map(r => r.id);
    if (groups.length) {
      const ph = groups.map(() => '?').join(',');
      db.prepare(`DELETE FROM signup_group_members WHERE group_id IN (${ph})`).run(...groups);
      db.prepare('DELETE FROM signup_groups WHERE program_id=?').run(id);
    }
    // Its own waiver records (F6) — keyed by the frozen waiver key, not program_id. Delete is the
    // empty-only path, but a signed record CAN exist for a program nobody ever checked into; those
    // attestations die with the program (guardian contact details included — they're PII).
    if (cfg.waiver && cfg.waiver.key) db.prepare('DELETE FROM waiver_records WHERE waiver_key=?').run(cfg.waiver.key);
    db.prepare('DELETE FROM program WHERE id=?').run(id);
  });
  // Its whole app_settings namespace: the scheduler keys AND chatSeqKey, which lives beside
  // `keys` rather than inside it (a keys-only loop leaked <slug>_chat_seq on every delete).
  for (const k of Object.values(cfg.keys || {})) delSetting(k);
  if (cfg.chatSeqKey) delSetting(cfg.chatSeqKey);
  // Keys built from the program ID rather than its slug, so they are not in cfg.keys. The kiosk
  // token matters most: ids ARE reused, and a surviving token would leave an old wall-board link
  // (already on a projector, already texted around) opening the NEXT program that takes this id.
  delSetting(`kiosk_token_${id}`);
  delSetting(ladderNomsKey(id));
  buildPrograms();
  MOUNTED_PROGRAMS.delete(id);
  audit(req.userEmail, 'admin', 'program:delete', `${id}:${row.slug}`);
  res.redirect('/admin/programs?msg=' + encodeURIComponent(`${row.name} was removed.`));
});

// ---------- Planning Center sync (Phase 1) — admin console + webhook ----------
// Every state-changing route is ADMIN-gated. The webhook is public by necessity but HMAC-verified
// inside pcoHandleWebhook against the stored authenticity secret (raw body needed for the
// signature, hence the inline express.raw — the global urlencoded parser skips JSON bodies).
app.get('/admin/pco', requireAdmin, (req, res) => {
  // redirectUri is shown so an admin can paste it into the PCO application — it must match exactly.
  res.send(pcoAdminPage({ s: { ...pcoStatus(), redirectUri: pcoRedirectUri(req) }, msg: req.query.msg || '' }));
});
app.post('/admin/pco/connect', requireAdmin, async (req, res) => {
  const appId = String(req.body.app_id || '').trim(), secret = String(req.body.secret || '').trim();
  if (!appId || !secret)
    return res.redirect('/admin/pco?msg=' + encodeURIComponent('Both the application ID and secret are required.'));
  const r = await pcoConnect(appId, secret, !!req.body.autocreate, String(req.body.webhook_secret || '').trim());
  audit(req.userEmail, 'admin', r.ok ? 'pco:connect' : 'pco:connect-failed', appId.slice(0, 8) + '…');
  res.redirect('/admin/pco?msg=' + encodeURIComponent(r.ok ? `Connected to ${r.org}.` : `Couldn’t connect: ${r.error}`));
});
// ---- OAuth: the church authorizes this app from Planning Center's own screen ----
// The redirect URI must match what was registered on the PCO application EXACTLY, so it is derived
// from PUBLIC_URL (the Funnel/production origin) rather than the request host — a request arriving
// on localhost must not mint a localhost redirect that PCO would reject.
function pcoRedirectUri(req) {
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return base + '/admin/pco/oauth/callback';
}
app.post('/admin/pco/oauth/app', requireAdmin, (req, res) => {
  const id = String(req.body.client_id || '').trim(), secret = String(req.body.client_secret || '').trim();
  if (!id || !secret)
    return res.redirect('/admin/pco?msg=' + encodeURIComponent('Both the application (client) ID and secret are required.'));
  pcoSaveOAuthApp(id, secret);
  audit(req.userEmail, 'admin', 'pco:oauth-app-saved', id.slice(0, 8) + '…');
  res.redirect('/admin/pco?msg=' + encodeURIComponent('Saved. Now press “Connect Planning Center”.'));
});
app.get('/admin/pco/oauth/start', requireAdmin, (req, res) => {
  if (!pcoOAuthConfigured())
    return res.redirect('/admin/pco?msg=' + encodeURIComponent('Add the application ID and secret first.'));
  res.redirect(pcoOAuthStartUrl(pcoRedirectUri(req)));
});
app.get('/admin/pco/oauth/callback', requireAdmin, async (req, res) => {
  // PCO reports a user-declined consent as ?error= — surface it plainly instead of a state mismatch.
  if (req.query.error)
    return res.redirect('/admin/pco?msg=' + encodeURIComponent('Planning Center reported: ' + String(req.query.error).slice(0, 80)));
  const r = await pcoOAuthCallback(String(req.query.code || ''), String(req.query.state || ''));
  audit(req.userEmail, 'admin', r.ok ? 'pco:oauth-connected' : 'pco:oauth-failed', r.ok ? r.org : (r.error || '').slice(0, 80));
  res.redirect('/admin/pco?msg=' + encodeURIComponent(r.ok ? `Connected to ${r.org} — no secret changed hands.` : `Couldn’t connect: ${r.error}`));
});
// Webhook signing secret — its own form, because it used to be reachable ONLY through the PAT
// connect form, which left webhook verification unusable for a church connected via OAuth.
app.post('/admin/pco/webhook', requireAdmin, (req, res) => {
  const secret = String(req.body.webhook_secret || '').trim();
  if (secret) setSetting('pco_webhook_secret', secret); else delSetting('pco_webhook_secret');
  audit(req.userEmail, 'admin', secret ? 'pco:webhook-secret-set' : 'pco:webhook-secret-cleared', '');
  res.redirect('/admin/pco?msg=' + encodeURIComponent(secret
    ? 'Webhook secret saved — Planning Center changes will arrive instantly.'
    : 'Webhook secret cleared — inbound changes arrive on the daily sync.'));
});
app.post('/admin/pco/disconnect', requireAdmin, (req, res) => {
  pcoDisconnect();
  audit(req.userEmail, 'admin', 'pco:disconnect', '');
  res.redirect('/admin/pco?msg=' + encodeURIComponent('Disconnected.'));
});
app.post('/admin/pco/link', requireAdmin, async (req, res) => {
  try {
    const r = await pcoRunInitialLink();
    res.redirect('/admin/pco?msg=' + encodeURIComponent(
      `Matched ${r.matched} · ${r.bridgeOnly.length} Bridge-only · ${r.pcoOnly} PCO-only.`));
  } catch (e) {
    res.redirect('/admin/pco?msg=' + encodeURIComponent('Match failed: ' + e.message.slice(0, 120)));
  }
});
app.post('/admin/pco/create', requireAdmin, async (req, res) => {
  try {
    const r = await pcoCreateBridgeOnly();
    res.redirect('/admin/pco?msg=' + encodeURIComponent(
      `Created ${r.created} in People` + (r.linked ? ` (${r.linked} already existed — linked)` : '') + '.'));
  } catch (e) {
    res.redirect('/admin/pco?msg=' + encodeURIComponent('Create failed: ' + e.message.slice(0, 120)));
  }
});
app.post('/admin/pco/auto', requireAdmin, (req, res) => {
  pcoSetAutocreate(req.body.on === '1');
  audit(req.userEmail, 'admin', 'pco:autocreate:' + (req.body.on === '1' ? 'on' : 'off'), '');
  res.redirect('/admin/pco');
});
// Phase 2 — People custom fields. Waiver status is the set worth publishing when the church's own
// Check-Ins station holds attendance (the hybrid); attendance fields matter while Bridge is the
// attendance record. Independent toggles so a church can run either, both, or neither.
app.post('/admin/pco/waiver', requireAdmin, (req, res) => {
  const on = req.body.on === '1';
  pcoSetWaiverFields(on);
  audit(req.userEmail, 'admin', 'pco:waiver-fields:' + (on ? 'on' : 'off'), '');
  res.redirect('/admin/pco?msg=' + encodeURIComponent(on
    ? 'Waiver fields ON — each member’s People profile now shows whether their waiver is on file, and when they confirmed it.'
    : 'Waiver fields OFF — the values already in People stay as they are; nothing further is written.'));
});
// Verify attestations against the church's own waiver form (read-only against PCO).
app.post('/admin/pco/waiver/form', requireAdmin, (req, res) => {
  const id = String(req.body.form_id || '').trim();
  if (id && !/^\d{1,12}$/.test(id))
    return res.redirect('/admin/pco?msg=' + encodeURIComponent('The form ID is the number in the form’s Planning Center URL.'));
  pcoSetWaiverForm(id);
  audit(req.userEmail, 'admin', id ? 'pco:waiver-form-set' : 'pco:waiver-form-cleared', id);
  res.redirect('/admin/pco?msg=' + encodeURIComponent(id ? 'Waiver form saved.' : 'Waiver form cleared.'));
});
app.post('/admin/pco/waiver/verify', requireAdmin, async (req, res) => {
  try {
    const r = await pcoVerifyWaivers();
    res.redirect('/admin/pco?msg=' + encodeURIComponent(
      `Verified ${r.verified} member${r.verified === 1 ? '' : 's'} against the waiver form · ${r.missing.length} with no submission found.`));
  } catch (e) {
    res.redirect('/admin/pco?msg=' + encodeURIComponent('Verify failed: ' + e.message.slice(0, 120)));
  }
});
app.post('/admin/pco/attendance', requireAdmin, (req, res) => {
  const on = req.body.on === '1';
  pcoSetAttendanceFields(on);
  audit(req.userEmail, 'admin', 'pco:attendance-fields:' + (on ? 'on' : 'off'), '');
  res.redirect('/admin/pco?msg=' + encodeURIComponent(on
    ? 'Attendance fields ON — each player’s People profile now carries their YA Sports numbers.'
    : 'Attendance fields OFF — existing values stay in People, nothing further is written.'));
});
app.post('/admin/pco/attendance/push', requireAdmin, async (req, res) => {
  try {
    // Bounded per press: each person costs up to ~6 paced requests, so an unbounded first-enable
    // (every linked member pending) would hold the request open for minutes. The 60s tick keeps
    // draining the rest — pressing again is optional, not required.
    const n = await pcoPushFields(25);
    const left = pcoFieldsPending();
    res.redirect('/admin/pco?msg=' + encodeURIComponent(n
      ? `Updated ${n} profile${n === 1 ? '' : 's'} in People.` + (left ? ` ${left} still queued — they update automatically.` : '')
      : 'Everyone in People is already up to date.'));
  } catch (e) {
    res.redirect('/admin/pco?msg=' + encodeURIComponent('Push failed: ' + e.message.slice(0, 120)));
  }
});
app.post('/admin/pco/poll', requireAdmin, async (req, res) => {
  try { await pcoDaily(); res.redirect('/admin/pco?msg=' + encodeURIComponent('Synced with People.')); }
  catch (e) { res.redirect('/admin/pco?msg=' + encodeURIComponent('Sync failed: ' + e.message.slice(0, 120))); }
});
app.post('/pco/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const r = pcoHandleWebhook(req.body, req.get('x-pco-webhooks-authenticity'));
  res.status(r.code).end();
});

// ---- Phase 2b: door mode + Check-Ins reconciliation + door passes ----
// Door mode: the PCO station tap replaces the in-app "✓ I'm coming" step — every confirm surface
// (ping / sweep / button) reads this live through effectiveConfirmCutoff(). Flip, no restart.
app.post('/admin/pco/doormode', requireAdmin, (req, res) => {
  setSetting('pco_door_mode', req.body.on === '1' ? '1' : '0');
  // Turning door mode OFF mid-cycle re-arms the confirm machinery for the CURRENT run date —
  // through the same marker-migration used by date moves and un-cancels. Without this, a flip
  // after the cutoff (station broke at 5:30, cutoff was 4:30) lets the next 60s tick see an
  // unstamped sweep marker and drop EVERY unconfirmed floor player, none of whom ever had a
  // confirm button on screen while door mode was on. Past-cutoff → markers stamped (no late
  // sweep, no late ping); before the cutoff → left armed so the normal flow resumes.
  if (req.body.on !== '1') {
    migrateConfirmMarkers(nextRunDate(), P(1).config.confirmCutoff, 'autoping_done', 'confirmsweep_done');
    for (const p of PROGRAMS.values()) {
      const k = p.config.keys;
      if (k && k.confirmsweep) migrateConfirmMarkers(programRunDate(p.id), p.config.confirmCutoff, k.autoping, k.confirmsweep);
    }
  }
  audit(req.userEmail, 'admin', 'pco:doormode:' + (req.body.on === '1' ? 'on' : 'off'), '');
  res.redirect('/admin/pco?msg=' + encodeURIComponent(req.body.on === '1'
    ? 'Door mode ON — the ✓ I’m-coming step is hidden and the confirm sweep is off.'
    : 'Door mode OFF — the in-app confirm step is back.'));
});
app.post('/admin/pco/event', requireAdmin, (req, res) => {
  const id = String(req.body.event_id || '').trim();
  if (!/^\d{1,12}$/.test(id)) return res.redirect('/admin/pco?msg=' + encodeURIComponent('Event ID should be the number from the Check-Ins event URL.'));
  setSetting('pco_checkins_event', id);
  audit(req.userEmail, 'admin', 'pco:event-set', id);
  res.redirect('/admin/pco?msg=' + encodeURIComponent('Check-Ins event saved.'));
});
// Kiosk arrivals: door screens overlay today's station taps on the roster (read-only, cached
// in pco.js). Inert without creds + a saved Check-Ins event — the toggle just flips the setting.
app.post('/admin/pco/kioskarrivals', requireAdmin, (req, res) => {
  setSetting('pco_kiosk_arrivals', req.body.on === '1' ? '1' : '0');
  audit(req.userEmail, 'admin', 'pco:kioskarrivals:' + (req.body.on === '1' ? 'on' : 'off'), '');
  res.redirect('/admin/pco?msg=' + encodeURIComponent(req.body.on === '1'
    ? 'Kiosk screens now show who’s tapped in at the door.'
    : 'Kiosk screens back to roster only.'));
});
app.post('/admin/pco/reconcile', requireAdmin, async (req, res) => {
  const date = String(req.body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.redirect('/admin/pco?msg=' + encodeURIComponent('Pick the run date to reconcile.'));
  try {
    const r = await pcoReconcile(date);
    res.redirect('/admin/pco?msg=' + encodeURIComponent(`Reconciled ${date}: ${r.ok} ✓ · ${r.noShows.length} no-show(s) · ${r.walkIns.length} walk-in(s).`));
  } catch (e) {
    res.redirect('/admin/pco?msg=' + encodeURIComponent('Reconcile failed: ' + e.message.slice(0, 120)));
  }
});
app.post('/admin/pco/passes', requireAdmin, (req, res) => {
  setSetting('pco_pass_enabled', req.body.on === '1' ? '1' : '0');
  audit(req.userEmail, 'admin', 'pco:passes:' + (req.body.on === '1' ? 'on' : 'off'), '');
  res.redirect('/admin/pco');
});
app.post('/admin/pco/passes/verify', requireAdmin, async (req, res) => {
  try {
    const r = await pcoVerifyPasses();
    res.redirect('/admin/pco?msg=' + encodeURIComponent(
      `Passes verified: ${r.withPass} working · ${r.missing.length} still need the CSV import.`
      + (r.more ? ' More left to check — press again.' : '')));
  } catch (e) {
    res.redirect('/admin/pco?msg=' + encodeURIComponent('Verify failed: ' + e.message.slice(0, 120)));
  }
});
// People-importer CSV that links a Bridge barcode to every member missing a pass. Import in PCO
// People (Barcode column is officially supported; existing barcodes are never overwritten).
app.get('/admin/pco/barcodes.csv', requireAdmin, (req, res) => {
  const rows = pcoBarcodeRows();
  const lines = [['First Name', 'Last Name', 'Email', 'Barcode'].join(',')];
  for (const r of rows) lines.push([csvCell(r.first), csvCell(r.last), csvCell(r.email), csvCell(r.barcode)].join(','));
  audit(req.userEmail, 'admin', 'pco:barcodes-csv', String(rows.length));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pco-barcodes.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

// Admin confirms a waiver they have actually SEEN (a physical copy, or the church's own records).
// This is a different claim from the member's self-report: the member attests they signed, an admin
// attests they've seen it — so it writes waiver_verified_at (the same column the PCO form check
// uses) and names the admin in the audit log. It never invents a SIGNING date: an optional
// "signed on" is recorded when the admin knows it, otherwise only the verification date exists.
app.post('/admin/people/waiver', requireAdmin, (req, res) => {
  const a = db.prepare('SELECT email, full_name FROM applicants WHERE id = ?').get(req.body.id);
  if (!a) return res.redirect('/admin/people?msg=' + encodeURIComponent('No such person.'));
  if (req.body.on === '0') {
    db.prepare('UPDATE applicants SET waiver_verified_at = NULL WHERE email = ?').run(a.email);
    audit(req.userEmail, 'admin', 'people:waiver-unverify', a.email);
    return res.redirect('/admin/people?msg=' + encodeURIComponent(`Cleared the confirmation for ${a.full_name} — their own attestation stands.`));
  }
  const signedOn = String(req.body.signed_on || '').trim();
  if (signedOn && !/^\d{4}-\d{2}-\d{2}$/.test(signedOn))
    return res.redirect('/admin/people?msg=' + encodeURIComponent('Use a date like 2026-07-15, or leave it blank.'));
  // A date the organizer supplies is AUTHORITATIVE — they've seen the signed document, so it
  // corrects a self-report's "when I ticked the box" timestamp (which is not a signing date at
  // all). No date given → whatever is on record stands. Either way the audit row carries the date,
  // so the correction is traceable.
  // The audit row carries the PRIOR attestation date: an admin-supplied date OVERWRITES it, and
  // without the before-value the correction's provenance vanishes once anyone asks "what changed".
  const prior = db.prepare('SELECT waiver_at FROM applicants WHERE email = ?').get(a.email)?.waiver_at || 'none';
  db.prepare(`UPDATE applicants SET waiver_ok = 1,
                waiver_at = COALESCE(?, waiver_at),
                waiver_verified_at = datetime('now','localtime') WHERE email = ?`)
    .run(signedOn || null, a.email);
  audit(req.userEmail, 'admin', 'people:waiver-verified' + (signedOn ? `:signed-${signedOn}:was-${prior}` : ''), a.email);
  res.redirect('/admin/people?msg=' + encodeURIComponent(`${a.full_name}'s waiver is confirmed on file.`));
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
    db.prepare('DELETE FROM pco_outbox WHERE email = ?').run(a.email);   // pending PCO writes die with the account (the PCO person is never deleted)
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
    db.prepare('DELETE FROM team_assignments WHERE email = ?').run(a.email); // and any run-team assignments
    db.prepare('DELETE FROM announcement_reads WHERE email = ?').run(a.email);
    db.prepare('DELETE FROM announcement_dismissals WHERE email = ?').run(a.email);
    db.prepare('DELETE FROM login_tokens WHERE email = ?').run(a.email);
    db.prepare('DELETE FROM waiver_records WHERE email = ?').run(a.email);   // per-program waivers (F6) — guardian contact details are PII, gone on hard-delete
    // The ladder is a SECOND identity space (it holds people who never had an app account), so it
    // is not reached by any of the email-keyed sweeps above. Without this the deleted person stayed
    // in the picker and kept their name on the public wall board.
    purgeLadderIdentity(a.email);
    // Same reasoning for the run roster + game results: a synced registrant is a THIRD identity
    // space (they may never have had an app account at all). Their seats are tombstoned rather
    // than deleted, so the games they played still show the right number of players a side.
    purgeGameIdentity(a.email);
    // Social graph (Phase 6): drop every edge touching this person, in BOTH directions, so a
    // same-email re-registration can't inherit stale friendships/blocks (mirrors the votes purge).
    db.prepare('DELETE FROM social_edges WHERE from_email = ? OR to_email = ?').run(a.email, a.email);
    // Queue-with-friends (Phase 6b): drop their party memberships, and dissolve any party they LED
    // — clearing the group pointer off every remaining member's checkin so none dangle.
    db.prepare('DELETE FROM signup_group_members WHERE email = ?').run(a.email);
    const ledGroups = db.prepare('SELECT id FROM signup_groups WHERE leader_email = ?').all(a.email).map(r => r.id);
    if (ledGroups.length) {
      const gph = ledGroups.map(() => '?').join(',');
      db.prepare(`UPDATE checkins SET group_id = NULL WHERE group_id IN (${gph})`).run(...ledGroups);
      db.prepare(`DELETE FROM signup_group_members WHERE group_id IN (${gph})`).run(...ledGroups);
      db.prepare('DELETE FROM signup_groups WHERE leader_email = ?').run(a.email);
    }
    // Persistent parties (Friends-tab layer): same shape — drop memberships, dissolve led parties.
    db.prepare('DELETE FROM party_members WHERE email = ?').run(a.email);
    const ledParties = db.prepare('SELECT id FROM parties WHERE leader_email = ?').all(a.email).map(r => r.id);
    if (ledParties.length) {
      db.prepare(`DELETE FROM party_members WHERE party_id IN (${ledParties.map(() => '?').join(',')})`).run(...ledParties);
      db.prepare('DELETE FROM parties WHERE leader_email = ?').run(a.email);
    }
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
  const now = schedNow();   // == Date.now() in prod; honours the TEST_NOW seam like the generic engine
  // Confirm cutoff (config.confirmCutoff, absolute 'HH:MM'): unconfirmed floor spots are
  // RELEASED to the waitlist at this time on run day (owner rule — 4:30 PM). Door mode
  // (effectiveConfirmCutoff → null) disables the whole confirm concept: no ping, no sweep —
  // Infinity keeps the sweep's `now >= cutoffAt` permanently false, and the ping gates on bbCutoff.
  const bbCutoff = effectiveConfirmCutoff(P(1).config.confirmCutoff);
  const cutoffAt = bbCutoff ? new Date(rd + 'T' + bbCutoff + ':00').getTime() : Infinity;
  const cutoffLabel = bbCutoff ? fmtClockLabel(bbCutoff) : '';
  // RUN-DAY 9 AM CONFIRM PING (once) — push every unconfirmed floor player, deadline spelled out.
  // Fires any time from 9 AM up to the cutoff (a late boot still pings; past the cutoff the sweep
  // is the message).
  if (bbCutoff && now >= new Date(rd + 'T09:00:00').getTime() && now < cutoffAt
      && getSetting('autoping_done') !== rd && !runIsCancelled(rd)) {
    setSetting('autoping_done', rd);
    const targets = partitionRun(rd).floorReal.filter(p => !p.guest && !p.confirmed_at).map(p => p.email);
    if (targets.length) setImmediate(() => sendPush(targets, {
      title: 'Confirm your spot for tonight',
      body: `You're on the floor for ${runLabelFor(rd)}. Confirm by ${cutoffLabel} — unconfirmed spots go to the waitlist.`,
      url: '/checkin', tag: 'confirm',
    }));
    audit('system', 'system', 'confirm:autoping', String(targets.length));
    console.log(`[autoping] pinged ${targets.length} unconfirmed floor player(s) for ${rd}`);
  }
  // Auto-CLOSE at run-day 2 PM (once). Respects a host who already closed. The queue locks here.
  if (now >= closeAt) {
    if (getSetting('autoclose_done') !== rd) {
      setSetting('autoclose_done', rd);
      if (runIsOpen(rd)) { setRunOpen(rd, false); audit('system', 'system', 'run:autoclose', rd); console.log(`[autoclose] locked check-in for ${rd}`); }
    }
    // CONFIRM-OR-RELEASE (once, at the cutoff): every unconfirmed floor player is removed and
    // each freed spot is offered onward to the top waitlister (the same claim loop as any drop).
    // Guests exempt — an operator vouched them in and they have no account to confirm from.
    if (now >= cutoffAt && getSetting('confirmsweep_done') !== rd && !runIsCancelled(rd)) {
      setSetting('confirmsweep_done', rd);
      const wlBefore = waitlistOrderFor(1, rd);   // F4 snapshot — the sweep shifts the whole list at once
      const drop = partitionRun(rd).floorReal.filter(p => !p.guest && !p.confirmed_at);
      for (const p of drop) {
        const offeree = offereeForFloorLeave(rd, p.email);
        stmtDelCheckinRow.run(rd, p.email, 1);
        clearTeamAssignment(1, rd, p.email);
        if (offeree) createOffer(rd, offeree, null, 1);
      }
      if (drop.length) {
        setImmediate(() => pingWaitlistShift(1, rd, wlBefore));   // F4 (generic sweep pings via removeFromRun)
        setImmediate(() => sendPush(drop.map(p => p.email), {
          title: 'Your spot was released',
          body: `You didn't confirm for ${runLabelFor(rd)} by ${cutoffLabel}, so your spot went to the next in line.`,
          url: '/checkin', tag: 'confirm',
        }));
        audit('system', 'system', 'confirm:sweep', String(drop.length));
        console.log(`[confirmsweep] released ${drop.length} unconfirmed spot(s) for ${rd}`);
      }
    }
    // PENALTY ASSESS (once, after the run ENDS) — strike auto-seated no-shows. DARK until
    // P(1).config.autoRenewPenalty is set (assessRenewPenalties no-ops without it); judge at the run's
    // END (host-set run_end), not the 2 PM lock — confirms come in right up to game time. Lives inside
    // this now>=closeAt block because it `return`s below (any code after the return never runs post-2PM).
    if (P(1).config.autoRenewPenalty) {
      const assessAt = new Date(rd + 'T' + runTimesFor(rd).end + ':00').getTime();
      if (now >= assessAt && getSetting('arassess_done') !== rd) {
        setSetting('arassess_done', rd);
        assessRenewPenalties(1, rd);
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
    // preserves the original call sequence. Each program is isolated: with in-app program creation
    // a single bad program must not starve every other run's rollover/expiry every 60 s.
    for (const p of PROGRAMS.values()) {
      try { p.tick(); } catch (e) { console.error(`[interval] program ${p.id} (${p.key}) tick FAILED: ${e.message}`); }
    }
  } catch (e) { console.error(`[interval] rollover/expiry FAILED: ${e.message}`); }
  try { fireScheduledAnnouncements(); } catch (e) { console.error(`[sched-announce] tick FAILED: ${e.message}`); }
  // PCO People sync: drain the outbox + reconcile unlinked members. Async and fully
  // self-contained (own error handling, inert without credentials) — fire and forget.
  pcoTick().catch(e => console.error('[pco] tick rejected:', e.message));
}, 60000).unref();
armScheduleTimer();   // precise firing for any pending post that survived a restart

// Test-only: synchronously run every program's scheduler tick (rollover + auto open/ping/lock).
// Mounted ONLY when ENABLE_TEST_TICK=1 so it can never exist in prod — lets the harness drive the
// clock phases (paired with TEST_NOW) without waiting for the 60s interval. Precedent: FORCE_HELD_RELEASED.
if (process.env.ENABLE_TEST_TICK === '1') {
  app.post('/admin/test/tick', requireAdmin, async (req, res) => {
    for (const p of PROGRAMS.values()) p.tick();
    try { fireScheduledAnnouncements(); } catch (e) { console.error(e.message); }
    await pcoTick();                                  // awaited so the harness can assert right after
    if (req.body && req.body.pcodaily) await pcoDaily(); // opt-in: also run the nightly delta poll
    res.json({ ok: true, now: schedNow() });
  });
}

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
const stmtRunOpenById = db.prepare('SELECT is_open FROM run_state WHERE run_date = ? AND program_id = ?');
const stmtRunCancelledById = db.prepare('SELECT cancelled FROM run_state WHERE run_date = ? AND program_id = ?');
const stmtPkRoster = db.prepare(`
    SELECT c.email, c.name, c.sort_order, c.id, c.confirmed_at, c.auto_seated, c.group_id,
           a.id AS applicant_id, a.is_host, a.is_team, a.is_regular, COALESCE(a.dob, c.dob) AS eff_dob
    FROM checkins c LEFT JOIN applicants a ON a.email = c.email
    WHERE c.run_date = ? AND c.program_id = ? ORDER BY c.sort_order ASC, c.id ASC`);
const stmtLatestAnnouncementById = db.prepare('SELECT id, body, author, at AS created_at FROM announcements WHERE program_id = ? AND COALESCE(archived,0) = 0 AND COALESCE(pending,0) = 0 ORDER BY id DESC LIMIT 1');
function programActive(programId) { const r = stmtProgActiveById.get(programId); return !!(r && r.active); }
function pkProgramActive() { return programActive(2); }
// Pickleball's standing day = Tuesday (PK_DOW=2), DECOUPLED from basketball so moving the
// basketball run (RUN_DOW) never drags pickleball's date along. Weekly auto-schedule:
// check-in reopens right after the run ends (PK_END_H), the roster locks at start
// (PK_START_H), and the floor gets a confirm ping the night before (PK_PING_H, day before).
const PK_DOW = 2, PK_START_H = 18, PK_START_M = 15, PK_END_H = 20, PK_END_M = 15,
      PK_PING_H = 9, PK_PING_DOW_OFFSET = 0, PK_LOCK = '17:30';   // Tue 6:15-8:15 PM; confirm ping RUN-DAY 9 AM (owner rule)
// Season opener (YYYY-MM-DD) or null — program-generic; the key comes from config.keys.seasonStart.
function programSeasonStart(programId) { const s = getSetting(P(programId).config.keys.seasonStart); return (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : null; }
function pkSeasonStart() { return programSeasonStart(2); }
// "6–8 PM" / "6 PM" — derived from the schedule constants, never written as a literal, so the
// masthead, the runs hub and the banner caption can't drift from the real hours.
// The standing weekday (dow) NEAREST a chosen date — the Tuesday a moved run replaces.
function pkNearestDow(dateStr, dow) {
  const r = new Date(dateStr + 'T12:00:00');
  const fwd = (dow - r.getDay() + 7) % 7;
  r.setDate(r.getDate() + (fwd <= 3 ? fwd : fwd - 7));
  return ymdLocal(r);
}
// ---------- A PROGRAM'S CLOCK — ONE derivation, which everything else reads ----------
// startMin/endMin arrived with pickleball's move to 6:15–8:15. They are absent on every
// admin-created program, and `Number(x) || 0` reproduces the old whole-hour behaviour exactly
// there. These helpers exist because the first pass at :15 walked only programDefaultDate, and
// EIGHT other consumers kept deriving the clock from startHour/endHour alone — so the app rolled
// the night at 8:15 while archiving the run, reopening check-in, stamping the .ics and printing
// the time as though it ended at 8:00. One accessor, or the next time-change splits them again.
const startMinOf = (cfg) => Number(cfg.startMin) || 0;
const endMinOf = (cfg) => Number(cfg.endMin) || 0;
const clockHHMM = (h, m) => String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
const startHHMM = (cfg) => clockHHMM(cfg.startHour, startMinOf(cfg));
const endHHMM = (cfg) => clockHHMM(cfg.endHour, endMinOf(cfg));
const endMinutesOf = (cfg) => (cfg.endHour * 60) + endMinOf(cfg);
const minutesOfDay = (d) => (d.getHours() * 60) + d.getMinutes();
// The next standing run day (config.dow), local. Rolls to next week once the current run has ENDED
// (>= config.endHour on run day) so check-in reopens the same night. Season-gated: pre-season it
// resolves to the first standing day on/after the opener (no phantom off-season runs). Program-
// generic — the standing day, end hour, base-skip key and season key all come from config.
function programDefaultDate(programId) {
  const cfg = P(programId).config, dow = cfg.dow;
  const now = new Date();
  let add = (dow - now.getDay() + 7) % 7;
  // Minutes, not whole hours: a run that ends at :15 would otherwise roll to next week at :00
  // while it was still being played.
  if (add === 0 && minutesOfDay(now) >= endMinutesOf(cfg)) add = 7;   // run's over tonight → next week
  const r = new Date(now); r.setDate(r.getDate() + add);
  let d = ymdLocal(r);
  // Skip a standing day whose run was MOVED to another day this week (runBase key) — else once the
  // moved run passes, this would resurrect that day as a phantom run (open+ping).
  const skip = getSetting(cfg.keys.runBase);
  if (skip && d === skip) { const s = new Date(d + 'T12:00:00'); s.setDate(s.getDate() + 7); d = ymdLocal(s); }
  const opener = programSeasonStart(programId);
  if (opener && d < opener) {   // pre-season → first standing day on/after the opener
    const o = new Date(opener + 'T12:00:00'); o.setDate(o.getDate() + ((dow - o.getDay() + 7) % 7));
    d = ymdLocal(o);
  }
  return d;
}
function pkDefaultDate() { return programDefaultDate(2); }
// Manual per-week override (config.keys.runDate) else the weekly standing day.
function programRunDate(programId) { return getSetting(P(programId).config.keys.runDate) || programDefaultDate(programId); }
function pkRunDate() { return programRunDate(2); }
// Run-state read/write — program-generic (bind program_id); the pk* names stay thin wrappers.
function runOpenFor(programId, rd) { const r = stmtRunOpenById.get(rd, programId); return !!(r && r.is_open); }
function runCancelledFor(programId, rd) { const r = stmtRunCancelledById.get(rd, programId); return !!(r && r.cancelled); }
function setRunStateFor(programId, rd, field, val) {
  db.prepare(`INSERT INTO run_state (run_date, ${field}, program_id) VALUES (?, ?, ?) ON CONFLICT(run_date, program_id) DO UPDATE SET ${field} = excluded.${field}`).run(rd, val ? 1 : 0, programId);
  // First open stamps the fill-speed anchor (metrics layer, same rule as basketball's setRunOpen).
  if (field === 'is_open' && val) db.prepare("UPDATE run_state SET opened_at = datetime('now') WHERE run_date = ? AND program_id = ? AND opened_at IS NULL").run(rd, programId); // UTC — matches checkins.created_at (P1-2)
}
function pkIsOpen(rd) { return runOpenFor(2, rd); }
function pkIsCancelled(rd) { return runCancelledFor(2, rd); }
function pkSetState(rd, field, val) { return setRunStateFor(2, rd, field, val); }
// Partition a SIMPLE (no offer-window) run's roster into floor / waitlist by sort order — the
// immediate first-come model (pickleball). Reads P(id).config.cap for the floor size; program-
// scoped roster query. pkPartition keeps the program-2 entry so its call sites are unchanged.
function simplePartition(programId, rd) {
  // Join applicants so the roster rows can open a profile popup + show role badges
  // (guests have no applicant row → applicant_id null → non-tappable, matches basketball).
  const rows = stmtPkRoster.all(rd, programId).map(r => ({ ...r, minor: isMinor({ dob: r.eff_dob }) })); // red safeguarding chip on the roster
  const cap = P(programId).config.cap;
  // Queue-with-friends (volleyball): keep a party (shared group_id) atomic — it boards only if it
  // fits entirely in the remaining floor, else the whole party waits and smaller units behind it
  // fill the gap. group_id is NULL for everyone when groupQueue is off (pickleball) → packParties
  // is byte-identical to the plain slice (the reduction-proof), so pk is untouched.
  if (groupQueueFeature(programId)) {
    const { floor, wait } = packParties(rows, cap);
    return { floor, wait, rows };
  }
  return { floor: rows.slice(0, cap), wait: rows.slice(cap), rows };
}
function pkPartition(rd) { return partitionFor(2, rd); }
// ---------- WEEKLY ROSTER SYNC (Planning Center Registrations -> run_roster) ----------
// This writes to run_roster, NOT to checkins. See the table comment in db.js: checkins is an
// economy (sweep, offers, penalties) that assumes a row can respond, and a synced registrant never
// opens this app. The first version of this wrote to checkins and the confirm sweep would have
// deleted the whole roster at 4:30 PM on run day.
//
// A sync is a full RECONCILE of its own source, not an append: someone who cancels in Planning
// Center after the first sync has to actually leave the list, or re-syncing courtside silently
// keeps a player who is not coming.
async function syncRunRosterFromPco(programId, rd, byEmail) {
  const cfg = P(programId).config;
  if (!cfg.pcoSignupPrefix) throw new Error('This run has no Planning Center signup configured.');
  const { signup, people } = await pcoSignupRosterForDate(cfg.pcoSignupPrefix, rd);
  if (!signup) return { signup: null, added: 0, removed: 0, kept: 0, skipped: 0 };
  // Only people actually holding a spot. A cancelled or waitlisted registration is not on the
  // roster, and showing them would have the operator building sides around someone who isn't there.
  const active = people.filter(x => x.active && !x.waitlisted);
  const seen = new Set();
  const rows = [];
  for (const person of active) {
    // No address in PCO = no identity here. A synthetic one keyed on the PCO person id is STABLE
    // across syncs; a random one would mint a fresh phantom player every time the button is tapped.
    const email = lc(person.email || (person.pcoId ? `pco-${person.pcoId}@adv.local` : ''));
    if (!email || seen.has(email)) continue;   // one row per human, even if PCO lists them twice
    seen.add(email);
    rows.push({ email, name: person.name });
  }
  let added = 0, kept = 0, removed = 0;
  transact(() => {
    const before = new Set(db.prepare("SELECT email FROM run_roster WHERE program_id = ? AND run_date = ? AND source = 'pco'")
      .all(programId, rd).map(r => lc(r.email)));
    const ins = db.prepare(`INSERT INTO run_roster (program_id, run_date, email, name, source) VALUES (?,?,?,?,'pco')
      ON CONFLICT(program_id, run_date, email) DO UPDATE SET name = excluded.name, synced_at = datetime('now')`);
    for (const r of rows) { ins.run(programId, rd, r.email, r.name); before.has(r.email) ? kept++ : added++; }
    // Anyone this source put here who is no longer registered. Hand-added rows (source <> 'pco')
    // are never touched by a sync.
    const gone = [...before].filter(e => !seen.has(e));
    for (const e of gone) {
      db.prepare("DELETE FROM run_roster WHERE program_id = ? AND run_date = ? AND email = ? AND source = 'pco'").run(programId, rd, e);
      clearTeamAssignment(programId, rd, e);   // and off whichever side they were on
    }
    removed = gone.length;
  });
  audit(byEmail, 'admin', `${cfg.logTag || 'run'}:roster-sync`,
    `${rd} from "${signup.name}" — ${added} new, ${kept} unchanged, ${removed} no longer registered`);
  return { signup, added, removed, kept, skipped: people.length - active.length };
}
function runRosterSync(programId, req, res) {
  const cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return;
  const back = `${P(programId).paths.run}/teams`;
  if (!g.canOperate) return res.redirect(P(programId).paths.run);
  const rd = runNightFor(programId);
  syncRunRosterFromPco(programId, rd, req.userEmail).then((r) => {
    if (!r.signup) return res.redirect(`${back}?err=${encodeURIComponent(`No Planning Center signup found for ${runLabelFor(rd)}.`)}`);
    const bits = [`${r.added + r.kept} registered`];
    if (r.added) bits.push(`${r.added} new`);
    if (r.removed) bits.push(`${r.removed} cancelled, removed`);
    if (r.skipped) bits.push(`${r.skipped} cancelled or waitlisted in PCO`);
    res.redirect(`${back}?msg=${encodeURIComponent(`${r.signup.name} — ${bits.join(' · ')}.`)}`);
  }).catch((e) => {
    audit(req.userEmail, 'admin', `${cfg.logTag || 'run'}:roster-sync-failed`, String(e.message).slice(0, 120));
    res.redirect(`${back}?err=${encodeURIComponent(String(e.message).slice(0, 140))}`);
  });
}
// Who the teams board arranges. A run whose sign-ups live in Planning Center uses its synced
// roster; every other program uses the app's own floor, exactly as the teams feature always has.
function teamsRosterFor(programId, rd) {
  if (P(programId).config.pcoSignupPrefix) {
    return db.prepare('SELECT email, name FROM run_roster WHERE program_id = ? AND run_date = ? ORDER BY name COLLATE NOCASE')
      .all(programId, rd).map(r => ({ email: lc(r.email), name: r.name }));
  }
  return teamFloor(programId, rd).map(p => ({ email: lc(p.email), name: p.name || p.email.split('@')[0] }));
}
// ---------- RUN TEAMS (Phase 5) — program-generic, config-driven (config.features.teams) ----------
// Numbered teams (1..count) players join after the roster locks; count/size come from config so the
// SAME code serves casual pickup, a tournament bracket, or a standing league later. Dark unless a
// program sets config.features.teams. program_id + run_date scoped like every run table. These two
// clears run beside EVERY roster delete (a player off the floor can't stay on a team); no-ops while
// the table is empty. The join/assign routes + the teams panel land next.
function clearTeamAssignment(programId, rd, email) { db.prepare('DELETE FROM team_assignments WHERE program_id = ? AND run_date = ? AND email = ?').run(programId, rd, email); }
function clearRunTeams(programId, rd) { db.prepare('DELETE FROM team_assignments WHERE program_id = ? AND run_date = ?').run(programId, rd); }
// Queue-with-friends (Phase 6b): drop a run's parties + their invites (the run is over/cancelled).
// checkins for that run are deleted by the caller, so their group_id pointers vanish with them.
function clearRunParties(programId, rd) {
  const ids = db.prepare('SELECT id FROM signup_groups WHERE program_id = ? AND run_date = ?').all(programId, rd).map(r => r.id);
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  // Atomic pair — a crash between the deletes would leave member-less group rows that the
  // one-party-per-person guards then read as a live party (P3-3, same idiom as runPartyCheckin).
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM signup_group_members WHERE group_id IN (${ph})`).run(...ids);
    db.prepare('DELETE FROM signup_groups WHERE program_id = ? AND run_date = ?').run(programId, rd);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const stmtRunTeams = db.prepare('SELECT email, team_no, assigned_by FROM team_assignments WHERE program_id = ? AND run_date = ? ORDER BY team_no ASC, created_at ASC');
function runTeamsFor(programId, rd, part = null) {
  const rows = stmtRunTeams.all(programId, rd);
  if (!rows.length) return rows;
  // Team seats are FLOOR seats. Every REMOVAL path clears the assignment, but a floor→waitlist
  // slide (offer churn, operator bump, waitlist cycling) is not a removal — it left the slider
  // holding a team seat from the waitlist, so teams read "full" while a floor player had no seat
  // (2026-08-04: demo-12 waitlisted with a Team 3 chair, Andre unassigned). Self-heal at the one
  // read chokepoint: non-floor assignments are dropped, not displayed. Callers that already
  // hold the partition pass it in — the run-page render was computing it twice.
  part = part || partitionFor(programId, rd);
  const floor = new Set((((P(programId).config.offerWindow ? part.floorReal : part.floor)) || []).map((p) => lc(p.email)));
  const stale = rows.filter((r) => !floor.has(lc(r.email)));
  for (const s of stale) clearTeamAssignment(programId, rd, s.email);
  return rows.filter((r) => floor.has(lc(r.email)));
}
function teamsFeature(programId) { const f = P(programId).config.features; return (f && f.teams) || null; }  // {count,size,opensAt,selfServe} or null
// Teams open once the roster LOCKS (config.features.teams.opensAt='lock' → lockTime), so teams form
// off the FINAL roster. schedNow() honours the TEST_NOW seam.
function teamsOpen(programId, rd) {
  if (!teamsFeature(programId)) return false;
  if (P(programId).config.static) return true;   // the static demo never reaches its lock — teams always open there
  return schedNow() >= new Date(rd + 'T' + P(programId).config.lockTime + ':00').getTime();
}
// Assign/move `email` to team `n` (1..count) with a SIZE GUARD — the INSERT OR REPLACE only lands if
// team n currently holds < size OTHER players. Race-safe: one synchronous statement, no read-then-write
// gap. Returns true if seated. by='' = self-served, else the operator's email.
function assignTeam(programId, rd, email, teamNo, by = '') {
  const t = teamsFeature(programId); if (!t) return false;
  const n = Number(teamNo); if (!(n >= 1 && n <= t.count)) return false;
  return db.prepare(`INSERT OR REPLACE INTO team_assignments (program_id, run_date, email, team_no, assigned_by)
    SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM team_assignments WHERE program_id = ? AND run_date = ? AND team_no = ? AND email <> ?) < ?`)
    .run(programId, rd, email, n, by, programId, rd, n, email, t.size).changes > 0;
}
// The set of floor players eligible for a team — INCLUDING guests (2026-08-04: a guest added
// after close was invisible to the whole teams area and could never get a chair, though they
// physically play). Guests have no session, so self-join stays members-only by construction;
// operators assign them and auto-fill balances them like anyone on the floor.
function teamFloor(programId, rd, part = null) {
  const cfg = P(programId).config; part = part || partitionFor(programId, rd);
  return (cfg.offerWindow ? part.floorReal : part.floor);
}
// A floor player self-joins / switches a team (only once teams are open + they're on the floor).
function runTeamJoin(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return;
  const t = teamsFeature(programId); if (!t) return res.redirect(base);
  const rd = programRunDate(programId);
  if (!teamsOpen(programId, rd) || !t.selfServe) return res.redirect(base);
  if (teamFloor(programId, rd).some(p => p.email === req.userEmail)) assignTeam(programId, rd, req.userEmail, req.body.team, '');
  res.redirect(base);
}
function runTeamLeave(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return;
  clearTeamAssignment(programId, programRunDate(programId), req.userEmail);
  res.redirect(base);
}
// ---------- THE TEAMS BOARD (operator surface, built for a phone at courtside) ----------
// Sides shift all night, so the whole design target is ONE TAP per change. With exactly two teams a
// tap needs no destination: tapping a player on a side moves them to the OTHER side. Bench is a
// separate small control, and a benched player taps back onto whichever side is shorter.
//
// Deliberately NOT gated on teamsOpen(): that gate exists so PLAYERS can't self-pick before the
// roster locks. Whoever is running the night arranges sides whenever they like.
function teamsBoardData(programId) {
  const rd = runNightFor(programId);
  const t = teamsFeature(programId);
  const roster = teamsRosterFor(programId, rd);
  // Read assignments straight from the table. runTeamsFor()'s self-heal drops anyone not on the
  // app's FLOOR — correct for a run that checks in here, wrong for one whose roster is synced,
  // where it would wipe every side on the next page load.
  const here = new Set(roster.map(r => r.email));
  const seats = new Map(db.prepare('SELECT email, team_no FROM team_assignments WHERE program_id = ? AND run_date = ?')
    .all(programId, rd).map(r => [lc(r.email), r.team_no]));
  const sides = Array.from({ length: t ? t.count : 0 }, () => []);
  const bench = [];
  for (const pl of roster) {
    const n = seats.get(pl.email);
    if (n >= 1 && n <= sides.length) sides[n - 1].push(pl); else bench.push(pl);
  }
  // A side assignment for someone no longer on the roster is dead weight; drop it so the counts
  // shown on the board are the counts on the floor.
  for (const [email] of seats) if (!here.has(email)) clearTeamAssignment(programId, rd, email);
  return { rd, sides, bench, count: t ? t.count : 0 };
}
function runTeamsBoard(programId, req, res) {
  const t = teamsFeature(programId); if (!t) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId);
  if (!g.canOperate) return res.redirect(p.paths.run);
  const d = teamsBoardData(programId);
  const a = applicantByEmail(req.userEmail), cc = p.unread(req.userEmail, a ? a.id : 0);
  res.send(teamsBoardPage({
    program: programId, theme: p.config.theme || '', emoji: p.emoji, sport: p.displayName,
    email: req.userEmail, runDate: d.rd, dateLabel: runLabelFor(d.rd),
    sides: d.sides, bench: d.bench, basePath: p.paths.run,
    canSync: !!(p.config.pcoSignupPrefix && pcoConnected()),
    // The fingerprint is what the sides looked like when this page rendered. The POST recomputes
    // it and refuses on a mismatch, so a stale tab cannot solidify a game whose rosters have moved.
    ...(gamesOn(programId)
      ? { games: true, gameMinSide: GAME_MIN_SIDE, tonight: gamesTonight(programId, d.rd), fp: gameFingerprint(d.rd, gameSidesNow(programId, d.rd)) }
      : {}),
    msg: String(req.query.msg || ''), err: String(req.query.err || ''),
    dmUnread: unreadCount(req.userEmail), groupUnread: cc.group, groupMention: cc.gm,
  }));
}
// ONE TAP = the other side. The whole point of the board.
function runTeamSwap(programId, req, res) {
  const t = teamsFeature(programId); if (!t) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/teams`;
  if (!g.canOperate) return res.redirect(p.paths.run);
  const rd = runNightFor(programId);
  const email = lc(String(req.body.email || '').trim());
  if (!teamsRosterFor(programId, rd).some(x => x.email === email)) return res.redirect(back);
  const cur = (db.prepare('SELECT team_no FROM team_assignments WHERE program_id = ? AND run_date = ? AND email = ?')
    .get(programId, rd, email) || {}).team_no;
  // IDEMPOTENCY. The tap says "move them off the side I can see them on". A double-tap on gym wifi,
  // a browser resubmit, or a second operator working from a stale board would otherwise toggle them
  // straight back and look like the tap never landed. If they have already moved, do nothing.
  const from = String(req.body.from ?? '');
  if (from !== '' && String(cur ?? '') !== from) return res.redirect(back);
  // From a side -> the other side. From the bench -> whichever side is shorter (so a tap on the
  // bench always does the sensible thing without the operator having to look at the counts).
  let target;
  if (cur >= 1 && cur <= t.count) target = (Number(cur) % t.count) + 1;
  else {
    const counts = db.prepare('SELECT team_no, COUNT(*) c FROM team_assignments WHERE program_id = ? AND run_date = ? GROUP BY team_no').all(programId, rd);
    const size = (n) => (counts.find(r => Number(r.team_no) === n) || {}).c || 0;
    target = 1; for (let n = 2; n <= t.count; n++) if (size(n) < size(target)) target = n;
  }
  if (!assignTeam(programId, rd, email, target, lc(req.userEmail)))
    return res.redirect(`${back}?err=${encodeURIComponent(`Side ${target} is full.`)}`);
  res.redirect(back);
}
// Off the sides entirely — sitting out, subbed, gone home. Their floor seat is untouched.
function runTeamBench(programId, req, res) {
  const t = teamsFeature(programId); if (!t) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/teams`;
  if (!g.canOperate) return res.redirect(p.paths.run);
  clearTeamAssignment(programId, runNightFor(programId), lc(String(req.body.email || '').trim()));
  res.redirect(back);
}
// Wipe the sides and start again — faster than benching thirteen people one at a time.
function runTeamsClear(programId, req, res) {
  const t = teamsFeature(programId); if (!t) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/teams`;
  if (!g.canOperate) return res.redirect(p.paths.run);
  const rd = runNightFor(programId);
  clearRunTeams(programId, rd);
  audit(req.userEmail, 'admin', `${p.config.logTag || 'run'}:teams-clear`, rd);
  res.redirect(`${back}?msg=${encodeURIComponent('Sides cleared.')}`);
}
// Operator: assign/move any floor player, or unassign (team 0/blank).
function runTeamAssign(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  if (!teamsFeature(programId)) return res.redirect(base);
  const rd = programRunDate(programId), em = String(req.body.email || '').toLowerCase(), n = String(req.body.team || '');
  if (n === '0' || n === '') clearTeamAssignment(programId, rd, em);
  // Floor check mirrors runTeamJoin: without it an arbitrary email seats, holds a chair in
  // assignTeam's size guard, then silently vanishes on the next render's self-heal — a phantom
  // assignment. (Clearing above stays unconditional: clearing a stale row is always safe.)
  else if (teamFloor(programId, rd).some((p) => lc(p.email) === em)) assignTeam(programId, rd, em, n, req.userEmail);
  res.redirect(base);
}
// ---------------------------------------------------------------------------
// Game results (teams board) + the leaderboard they feed.
//
// A game exists only once someone says who won. There is no start, no clock, no in-progress
// state: on a winners-stay court the sides reform constantly, so the arrangement showing on the
// board when the result is tapped IS the game that just finished. The one human contract is
// "tap the winner before you re-mix", and the tonight-strip + one-tap Undo make a violation
// visible and reversible rather than pretending code can prevent it.
const GAME_MIN_SIDE = 3;     // below this the board is half-cleared, not a game
const GAME_SCORE_MAX = 99;
const gamesOn = (programId) => { const t = teamsFeature(programId); return !!(t && t.games && t.count === 2); };
// Seats left behind by a hard-deleted person: kept so side counts stay right, never shown.
const isTombstone = (email) => /^former-[0-9a-f]+@/.test(String(email || '').toLowerCase());

// The sides as they stand, READ ONLY. Deliberately not runTeamsFor(): its floor self-heal drops
// anyone who is not on this app's floor, which is every Planning Center registrant — it would
// both wipe the live sides and snapshot an empty game. Deliberately not teamsBoardData() either,
// because that clears dead-weight assignments, and a POST that logs a result must not mutate the
// board it is reading.
function gameSidesNow(programId, rd) {
  const t = teamsFeature(programId);
  const roster = teamsRosterFor(programId, rd);
  const here = new Set(roster.map(r => lc(r.email)));
  const sides = Array.from({ length: t ? t.count : 0 }, () => []);
  for (const r of db.prepare('SELECT email, team_no FROM team_assignments WHERE program_id = ? AND run_date = ?').all(programId, rd)) {
    const em = lc(r.email), n = Number(r.team_no);
    if (here.has(em) && n >= 1 && n <= sides.length) sides[n - 1].push(em);
  }
  return sides.map(s => s.sort());
}
// What the operator could see when the page rendered. A stale tab (last week's, a second phone,
// the board left open past midnight) must REFUSE rather than solidify a game whose rosters have
// since changed — the same doctrine as runTeamSwap's `from` anchor, widened to the whole board.
function gameFingerprint(rd, sides) {
  const body = rd + '|' + sides.map((s, i) => (i + 1) + ':' + s.join(',')).join('|');
  return crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
}
// Tonight's games, newest first, with the rosters that were solidified with them.
function gamesTonight(programId, rd) {
  const rows = db.prepare('SELECT * FROM run_games WHERE program_id = ? AND run_date = ? ORDER BY id DESC').all(programId, rd);
  if (!rows.length) return [];
  const seats = db.prepare('SELECT p.game_id, p.email, p.side FROM run_game_players p JOIN run_games g ON g.id = p.game_id WHERE g.program_id = ? AND g.run_date = ?').all(programId, rd);
  const names = ladderNames(programId, seats.filter(s => !isTombstone(s.email)).map(s => s.email));
  const byGame = new Map();
  for (const s of seats) {
    if (!byGame.has(s.game_id)) byGame.set(s.game_id, [[], []]);
    const side = byGame.get(s.game_id)[s.side - 1];
    // A tombstoned seat is kept so the side counts stay honest, but it must never render as an
    // address. ladderNames cannot resolve it (there is no person left to resolve), so the raw
    // former-<hex>@adv.local would otherwise show up in the games list — the one place the
    // standings filter does not reach.
    if (side) side.push(isTombstone(s.email) ? 'Former player' : (names.get(lc(s.email)) || s.email));
  }
  return rows.map(r => {
    const sides = byGame.get(r.id) || [[], []];
    return {
      id: r.id, win: r.win_side, ws: r.w_score, ls: r.l_score, at: r.created_at,
      sides: sides.map(s => s.slice().sort()), counts: sides.map(s => s.length),
    };
  });
}
// Standings summed from the game rows on every read — never stored, so an Undo is simply correct
// rather than needing a compensating write.
function runGamesStandings(programId, from) {
  const rows = db.prepare('SELECT p.email, p.side, g.win_side, g.w_score, g.l_score, g.run_date FROM run_game_players p JOIN run_games g ON g.id = p.game_id WHERE g.program_id = ? AND g.run_date >= ? ORDER BY g.id DESC').all(programId, from);
  const players = new Map();
  const nights = new Set();
  for (const r of rows) {
    const em = lc(r.email);
    if (!players.has(em)) players.set(em, { email: em, w: 0, l: 0, scored: 0, pf: 0, pa: 0 });
    const p = players.get(em);
    const won = Number(r.side) === Number(r.win_side);
    if (won) p.w++; else p.l++;
    // Point differential exists ONLY for games somebody actually scored. A missing score is not a
    // zero-point game, so it contributes nothing rather than dragging a differential toward zero.
    if (r.w_score != null && r.l_score != null) {
      p.scored++;
      p.pf += won ? r.w_score : r.l_score;
      p.pa += won ? r.l_score : r.w_score;
    }
    nights.add(r.run_date);
  }
  // A hard-deleted person's seats were rekeyed to former-<hex>@adv.local so the games they played
  // still show the right number a side. They must not appear ON the board though: the whole point
  // of the delete was that they are gone, and an unresolvable address would rank as a raw slug.
  for (const em of [...players.keys()]) if (isTombstone(em)) players.delete(em);
  const names = ladderNames(programId, [...players.keys()]);
  const fin = (p) => ({ ...p, label: names.get(p.email) || p.email, pd: p.pf - p.pa, played: p.w + p.l });
  // Wins, then point differential, then win ratio, then name — the same chain as the pickleball
  // ladder. Differential can rank this high because every game carries a score: the run logs one
  // straight after each game, so it is complete data rather than the scored subset it would be if
  // the score were optional. (The NULL handling above stays regardless, so a game logged before
  // the score was required contributes no margin rather than a phantom zero.)
  const rank = (a, b) => {
    if (b.w !== a.w) return b.w - a.w;
    if (b.pd !== a.pd) return b.pd - a.pd;
    const ra = a.w / (a.played || 1), rb = b.w / (b.played || 1);
    if (rb !== ra) return rb - ra;
    return String(a.label).localeCompare(String(b.label));
  };
  const gameCount = db.prepare('SELECT COUNT(*) c FROM run_games WHERE program_id = ? AND run_date >= ?').get(programId, from).c;
  return { from, players: [...players.values()].map(fin).sort(rank), nights: nights.size, games: gameCount };
}
// Solidify the game showing on the board. One tap; the score is a second, optional one.
function runGameLog(programId, req, res) {
  if (!gamesOn(programId)) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/teams`;
  if (!g.canOperate) return res.redirect(p.paths.run);
  const fail = (m) => res.redirect(`${back}?err=${encodeURIComponent(m)}`);

  const rd = runNightFor(programId);                 // recomputed here, never trusted from the form
  const sides = gameSidesNow(programId, rd);
  if (sides.some(s => s.length < GAME_MIN_SIDE))
    return fail(`Both sides need at least ${GAME_MIN_SIDE} players before a game can be logged.`);
  if (String(req.body.fp || '') !== gameFingerprint(rd, sides))
    return fail('The sides changed since this screen loaded — it just refreshed, tap again.');

  // The score IS the result. This run logs one straight after every game, so there is no separate
  // "who won" to ask: two numbers already say it. Deriving the winner rather than collecting it
  // also removes the one way the two answers could disagree — a tap on Side 1 filed against a
  // 17-21 scoreline, which would be a silently wrong result, the worst thing this can produce.
  const raw1 = String(req.body.s1 ?? '').trim(), raw2 = String(req.body.s2 ?? '').trim();
  if (raw1 === '' || raw2 === '') return fail('Enter both scores.');
  const n1 = Number(raw1), n2 = Number(raw2);
  if (![n1, n2].every(n => Number.isInteger(n) && n >= 0 && n <= GAME_SCORE_MAX))
    return fail(`Scores must be whole numbers between 0 and ${GAME_SCORE_MAX}.`);
  if (n1 === n2) return fail('A game cannot end level — check the score.');
  const win = n1 > n2 ? 1 : 2;
  const ws = Math.max(n1, n2), ls = Math.min(n1, n2);

  // Gym wifi double-fire. A real game takes minutes, so the identical result logged again within
  // seconds is a resubmit — answer as though it worked and write nothing.
  const last = db.prepare("SELECT id FROM run_games WHERE program_id = ? AND run_date = ? AND win_side = ? AND w_score IS ? AND l_score IS ? AND created_at >= datetime('now','-20 seconds') ORDER BY id DESC LIMIT 1").get(programId, rd, win, ws, ls);
  if (last) {
    const prev = db.prepare('SELECT email, side FROM run_game_players WHERE game_id = ?').all(last.id);
    const same = prev.length === sides.flat().length
      && prev.every(r => (sides[r.side - 1] || []).includes(lc(r.email)));
    if (same) return res.redirect(`${back}?msg=${encodeURIComponent('Already logged.')}`);
  }

  transact(() => {
    const info = db.prepare('INSERT INTO run_games (program_id, run_date, win_side, w_score, l_score, logged_by) VALUES (?,?,?,?,?,?)')
      .run(programId, rd, win, ws, ls, lc(req.userEmail));
    const ins = db.prepare('INSERT INTO run_game_players (game_id, email, side) VALUES (?,?,?)');
    sides.forEach((s, i) => s.forEach(em => ins.run(info.lastInsertRowid, em, i + 1)));
  });
  audit(req.userEmail, 'admin', `${ladderTag(programId)}:game:log`,
    `${rd} side${win} ${sides.map(s => s.length).join('v')}${ws == null ? '' : ` ${ws}-${ls}`}`);
  res.redirect(`${back}?msg=${encodeURIComponent(`Side ${win} won${ws == null ? '' : ` ${ws}-${ls}`}.`)}`);
}
// Undo the last game of TONIGHT — the mis-tap fix. Older nights are settled history; correcting
// one is a merge/relog conversation, not a button on a phone mid-run.
function runGameUndo(programId, req, res) {
  if (!gamesOn(programId)) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/teams`;
  if (!g.canOperate) return res.redirect(p.paths.run);
  const rd = runNightFor(programId);
  const last = db.prepare('SELECT * FROM run_games WHERE program_id = ? AND run_date = ? ORDER BY id DESC LIMIT 1').get(programId, rd);
  if (!last) return res.redirect(`${back}?err=${encodeURIComponent('Nothing logged tonight.')}`);
  // Anchored to the game the operator could SEE, exactly like the log path's fingerprint. A POST
  // retried on a stalled socket, or a second tap through the confirm because nothing appeared to
  // happen, would otherwise delete the NEXT game down as well — destroying a correct result, which
  // is worse than any wrong one this feature can record.
  const want = String(req.body.id || '');
  if (want && want !== String(last.id))
    return res.redirect(`${back}?err=${encodeURIComponent('That game was already removed — nothing else was touched.')}`);
  transact(() => {
    db.prepare('DELETE FROM run_game_players WHERE game_id = ?').run(last.id);
    db.prepare('DELETE FROM run_games WHERE id = ?').run(last.id);
  });
  audit(req.userEmail, 'admin', `${ladderTag(programId)}:game:undo`, `${rd} side${last.win_side} (game ${last.id})`);
  res.redirect(`${back}?msg=${encodeURIComponent('Last game removed.')}`);
}
// The leaderboard. Members can read it; only operators see the merge tool.
// "Member" here is programJoinedBy, NOT memberOf. memberOf is a program_membership lookup, and a
// DROP-IN program never writes those rows — the live database carries zero for program 1 while
// programs 2/3/4 have them — so memberOf(1, …) was true for admins and nobody else, and this gate
// silently bounced every ordinary player off their own standings. programJoinedBy is the resolver
// that already knows the difference: membership for an opt-in run, "on the org team / has ever
// checked in or attended" for a drop-in one. (Open question for the owner: a Planning-Center
// registrant who has never checked in lives in run_roster and is still bounced. Counting
// run_roster would fix that, but the same predicate gates CHAT — widening it is a product call.)
function runLeaderboard(programId, req, res) {
  if (!gamesOn(programId)) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId);
  // Same bar as the pickleball ladder page: this run's members and its operators, nobody else.
  // It carries every player's name and record, and any address a name failed to resolve to.
  if (!programJoinedBy(programId, req.userEmail) && !g.canOperate) return res.redirect(p.paths.run);
  const from = ladderFrom(programId);
  const st = runGamesStandings(programId, from);
  const rd = runNightFor(programId);
  const a = applicantByEmail(req.userEmail), cc = p.unread(req.userEmail, a ? a.id : 0);
  res.send(leaderboardPage({
    program: programId, theme: p.config.theme || '', emoji: p.emoji, sport: p.displayName,
    email: req.userEmail, basePath: p.paths.run, canOperate: !!g.canOperate,
    from, players: st.players, nights: st.nights, games: st.games,
    recent: gamesTonight(programId, rd), dateLabel: runLabelFor(rd),
    msg: String(req.query.msg || ''), err: String(req.query.err || ''),
    dmUnread: unreadCount(req.userEmail), groupUnread: cc.group, groupMention: cc.gm,
  }));
}
// Two rows, one human. The roster sync keys identity on email, so the week a Planning Center
// record gains a real address the same player starts a second column. Refuses when both were on
// the SAME game, because that is not one person.
function runGameMerge(programId, req, res) {
  if (!gamesOn(programId)) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/leaderboard`;
  if (!g.canOperate) return res.redirect(p.paths.run);
  const from = lc(String(req.body.from || '').trim()), into = lc(String(req.body.into || '').trim());
  if (!from || !into || from === into) return res.redirect(`${back}?err=${encodeURIComponent('Pick two different players.')}`);
  const clash = db.prepare('SELECT g.run_date d FROM run_game_players p JOIN run_games g ON g.id = p.game_id WHERE g.program_id = ? AND p.email IN (?, ?) GROUP BY p.game_id HAVING COUNT(*) = 2 LIMIT 3').all(programId, from, into);
  if (clash.length) return res.redirect(`${back}?err=${encodeURIComponent(
    `Those two were on the same game (${[...new Set(clash.map(c => c.d))].join(', ')}), so they are not the same person.`)}`);
  transact(() => {
    db.prepare('UPDATE run_game_players SET email = ? WHERE email = ? AND game_id IN (SELECT id FROM run_games WHERE program_id = ?)')
      .run(into, from, programId);
  });
  audit(req.userEmail, 'admin', `${ladderTag(programId)}:game:merge`, `${from} -> ${into}`);
  res.redirect(`${back}?msg=${encodeURIComponent('Merged.')}`);
}
// A moved run date carries its games with it, or the night's results vanish from the board and
// Undo silently no-ops on a date that no longer has any games.
function migrateGamesNight(programId, oldRd, newRd) {
  if (!oldRd || !newRd || oldRd === newRd) return;
  db.prepare('UPDATE run_games SET run_date = ? WHERE program_id = ? AND run_date = ?').run(newRd, programId, oldRd);
}
// A hard-deleted person must not take everyone else's results with them. Their seats are rekeyed
// to a tombstone so the games they were in still have the right number of players on each side.
function purgeGameIdentity(email) {
  const em = lc(String(email || '').trim()); if (!em) return;
  const seats = db.prepare('SELECT 1 FROM run_game_players WHERE email = ? LIMIT 1').get(em);
  db.prepare('DELETE FROM run_roster WHERE email = ?').run(em);
  if (!seats) return;
  const tomb = `former-${crypto.randomBytes(4).toString('hex')}@adv.local`;
  db.prepare('UPDATE run_game_players SET email = ? WHERE email = ?').run(tomb, em);
}
// Operator/admin: forgive a member's auto-renew penalty — clear strikes + lift any pause. The safety
// valve for a false strike or a member with a good reason. Program-generic; works for any run that
// enabled config.autoRenewPenalty (harmless no-op otherwise — state stays empty).
function runPenaltyClear(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const em = String(req.body.email || '').toLowerCase();
  if (em) {
    stmtPmEnsureRow.run(programId, em);
    db.prepare('UPDATE program_membership SET ar_strikes = 0, ar_paused_until = NULL WHERE program_id = ? AND email = ?').run(programId, em);
    audit(req.userEmail, req.actorRole || (g.admin ? 'admin' : 'host'), `${P(programId).config.logTag || 'run'}:arclear`, em);  // row-less admin has no actorRole
  }
  res.redirect(base);
}
// Operator: round-robin the UNASSIGNED floor players into the emptiest teams so a run never starts half-formed.
// Auto-fill core — PARTY-AWARE: a party (shared checkins.group_id) places as one BLOCK on the
// first team with room for all of it (friends who queued together play together); solo players
// then balance onto the least-filled team. An oversize party that fits nowhere whole falls back
// to per-player balancing (teams must still fill). Shared by the route + the demo seed.
function teamFillCore(programId, rd, by) {
  const t = teamsFeature(programId); if (!t) return;
  const counts = {}; for (let i = 1; i <= t.count; i++) counts[i] = 0;
  const assigned = new Set();
  const part = partitionFor(programId, rd);   // shared by the heal + the floor scan below
  for (const r of runTeamsFor(programId, rd, part)) { counts[r.team_no] = (counts[r.team_no] || 0) + 1; assigned.add(r.email); }
  // Units in floor order: parties as blocks, solos as singletons.
  const floor = teamFloor(programId, rd, part).filter(p => !assigned.has(p.email));
  const units = [], byGroup = new Map();
  for (const p of floor) {
    if (p.group_id) {
      if (!byGroup.has(p.group_id)) { const u = []; byGroup.set(p.group_id, u); units.push(u); }
      byGroup.get(p.group_id).push(p);
    } else units.push([p]);
  }
  for (const unit of units) {
    let teamN = 0;
    if (unit.length > 1) for (let i = 1; i <= t.count; i++) if (t.size - counts[i] >= unit.length) { teamN = i; break; }   // party → first team the WHOLE block fits
    if (teamN) {
      for (const p of unit) if (assignTeam(programId, rd, p.email, teamN, by)) counts[teamN]++;
    } else {
      for (const p of unit) {   // solo (or nowhere-whole party) → least-filled team
        let n = 0; for (let i = 1; i <= t.count; i++) if (counts[i] < t.size && (n === 0 || counts[i] < counts[n])) n = i;
        if (n && assignTeam(programId, rd, p.email, n, by)) counts[n]++;
      }
    }
  }
}
function runTeamFill(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  if (!teamsFeature(programId)) return res.redirect(base);
  teamFillCore(programId, programRunDate(programId), req.userEmail);
  res.redirect(base);
}
// Pickleball run start epoch — the run date at 6 PM local. Drives the countdown banner
// AND the auto-lock time (check-in closes at start).
function startEpochFor(programId, rd) { return rd ? new Date(rd + 'T' + startHHMM(P(programId).config) + ':00').getTime() : 0; }
function timeRangeFor(programId) { const cfg = P(programId).config; return fmtClockRange(startHHMM(cfg), endHHMM(cfg)); }
function startLabelFor(programId) { return fmtClockLabel(startHHMM(P(programId).config)); }
function pkStartEpoch(rd) { return startEpochFor(2, rd); }
// Latest LIVE pickleball announcement (program 2 rows in the shared announcements table; retracted ones archived).
function latestAnnouncementFor(programId) { return stmtLatestAnnouncementById.get(programId) || null; }
function latestPkAnnouncement() { return latestAnnouncementFor(2); }
// ---------- PROGRAM MEMBERSHIP + AUDIENCE (program-generic) ----------
// Opt-in programs (pickleball, volleyball) track membership in program_membership; chat access, the
// members list, and the push/email audiences all read from it. One set of helpers keyed by program
// id; the pk* names below stay thin wrappers so call sites are untouched (a new program reuses them
// by passing its id).
// status: 'approved' (open join) or 'pending' (host-approve mode — a REQUEST, not a membership;
// memberOf filters on approved, so pending grants nothing until a host says yes).
function joinProgramMembership(programId, email, status = 'approved') {
  if (!email || /@guest\.local$/.test(email)) return;
  db.prepare('INSERT OR IGNORE INTO program_membership (program_id, email, status, role) VALUES (?, ?, ?, ?)')
    .run(programId, email, status, 'approved');
}
// F2: program HOSTS — members whose program_membership.role='host' operate THEIR program (open/
// close/announce/guests/requests) without being global admins. One row per program; grant/revoke
// on /admin/programs.
const stmtIsProgHost = db.prepare("SELECT 1 FROM program_membership WHERE program_id = ? AND email = ? AND role = 'host' AND status = 'approved'");
function isProgramHost(programId, email) { return !!(email && stmtIsProgHost.get(programId, String(email).toLowerCase())); }
const stmtProgHosts = db.prepare("SELECT email FROM program_membership WHERE program_id = ? AND role = 'host' AND status = 'approved'");
function programHostEmails(programId) {
  const hosts = stmtProgHosts.all(programId).map(r => r.email);
  return [...new Set([...hosts, ...ADMINS])];   // admins always hear requests too
}
const stmtIsMember = db.prepare("SELECT 1 FROM program_membership WHERE program_id = ? AND email = ? AND status = 'approved'"); // hoisted — runs per neutral-page render (chatProgramFor) + every chat gate (P3-6)
function memberOf(programId, email) {
  if (!email) return false;
  if (isAdmin(email)) return true; // admins operate the run — always members
  return !!stmtIsMember.get(programId, email);
}
// Push/announce audience = actual members (approved, non-guest). Not the whole club.
function programMemberEmails(programId) {
  return db.prepare(`SELECT pm.email FROM program_membership pm JOIN applicants a ON a.email = pm.email
    WHERE pm.program_id = ? AND a.status = 'approved' AND a.email NOT LIKE '%@guest.local'`).all(programId).map(r => r.email);
}
// Email audience = members who haven't opted out of announcement emails.
function programEmailRecipients(programId) {
  return db.prepare(`SELECT pm.email FROM program_membership pm JOIN applicants a ON a.email = pm.email
    WHERE pm.program_id = ? AND a.status = 'approved' AND a.email NOT LIKE '%@guest.local' AND COALESCE(a.email_optout,0) = 0`).all(programId).map(r => r.email);
}
// You become a pickleball member by opening the run (GET /pickleball) — being an approved
// BASKETBALL player alone doesn't grant it.
function pkJoinMembership(email) { return joinProgramMembership(2, email); }
function pkIsMember(email) { return memberOf(2, email); }
function pkMemberEmails() { return programMemberEmails(2); }
function pkEmailRecipients() { return programEmailRecipients(2); }
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
  const cfg = P(programId).config, total = cfg.cap + cfg.waitlist, today = ymdLocal(new Date(schedNow()));  // schedNow so the auto-renew pause window honours the TEST_NOW seam (== real time in prod)
  const insTeam = db.prepare('INSERT OR IGNORE INTO checkins (run_date, email, name, sort_order, program_id, auto_seated) VALUES (?,?,?,?,?,1)');
  const insR = db.prepare('INSERT OR IGNORE INTO checkins (run_date, email, name, program_id, auto_seated) VALUES (?,?,?,?,1)');
  let team = [], nonTeam = [];
  if (cfg.autoRenew.from === 'members') {
    // Waiver filtering happens in JS via waiverSatisfied — a program with its OWN waiver (F6)
    // must not seat someone who only holds the club-wide flag, and vice versa. For global-waiver
    // programs the seam reads a.waiver_ok, so the outcome is identical to the old SQL filter.
    const renewers = db.prepare(`SELECT pm.email, a.full_name, COALESCE(a.is_team,0) AS is_team
      FROM program_membership pm JOIN applicants a ON a.email = pm.email
      WHERE pm.program_id = ? AND pm.auto_renew = 1 AND a.status = 'approved' AND a.email NOT LIKE '%@guest.local'
        AND COALESCE(a.suspended,0) = 0
        AND NOT EXISTS (SELECT 1 FROM regular_optout o WHERE o.run_date = ? AND o.email = pm.email AND o.program_id = ?)
        AND (pm.ar_paused_until IS NULL OR pm.ar_paused_until <= ?)
      ORDER BY a.id`).all(programId, rd, programId, today)
      .filter(r => waiverSatisfied(programId, r.email));
    team = renewers.filter(r => r.is_team); nonTeam = renewers.filter(r => !r.is_team);
  } else { // 'team' — only the org team auto-renews (basketball); opt-out checked per-row (matches autoJoinTeam)
    const optedOut = db.prepare('SELECT 1 FROM regular_optout WHERE run_date = ? AND email = ? AND program_id = ?');
    // Paused auto-renewers (Phase 5.5) are skipped too — a repeat no-show loses the guarantee until the
    // pause lifts (state on program_membership; NULL/absent for everyone until the penalty is enabled).
    team = db.prepare(`SELECT a.email, a.full_name FROM applicants a
      LEFT JOIN program_membership pm ON pm.program_id = ? AND pm.email = a.email
      WHERE a.is_team = 1 AND a.status = 'approved' AND a.auto_renew = 1 AND COALESCE(a.suspended,0) = 0 AND COALESCE(a.waiver_ok,0) = 1
        AND (pm.ar_paused_until IS NULL OR pm.ar_paused_until <= ?)`)
      .all(programId, today).filter(t => !optedOut.get(rd, t.email, programId));
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
// ---------- AUTO-RENEW PENALTY (Phase 5.5) ----------
// A member with auto-renew ON is GUARANTEED a weekly seat (seatRenewers auto-seats them). If they
// then GHOST it — auto-seated, still on the floor when the run ends, never confirmed and never sat
// out — they burned a spot a waitlister could have had. config.autoRenewPenalty = { strikes, pauseWeeks }:
// `strikes` consecutive ghosts pause their auto-renew for `pauseWeeks` run-weeks (they can still check
// in by hand). A confirmed show clears the streak; opting out or sitting out early is NOT a strike —
// that's the polite path we WANT. State lives on program_membership for EVERY program: basketball's
// team auto-renew flag is on applicants, but its penalty STATE is lazily rowed into program_membership
// here, so ONE engine serves both autoRenew.from sources. Feature-flagged — no autoRenewPenalty on a
// program's config → assess/lift no-op and nothing is ever written (dark until a program opts in).
const stmtPmEnsureRow = db.prepare("INSERT OR IGNORE INTO program_membership (program_id, email, status, role) VALUES (?, ?, 'approved', 'approved')");
const stmtPmStrikeState = db.prepare('SELECT ar_strikes FROM program_membership WHERE program_id = ? AND email = ?');
const stmtPmSetStrikes = db.prepare("UPDATE program_membership SET ar_strikes = ?, ar_strike_at = datetime('now') WHERE program_id = ? AND email = ?");
const stmtPmPauseAR = db.prepare("UPDATE program_membership SET ar_strikes = 0, ar_paused_until = ?, ar_strike_at = datetime('now') WHERE program_id = ? AND email = ?");
const stmtPmResetStrikes = db.prepare('UPDATE program_membership SET ar_strikes = 0 WHERE program_id = ? AND email = ? AND ar_strikes > 0');
const stmtPmPausedFloor = db.prepare('SELECT email, ar_strikes, ar_paused_until FROM program_membership WHERE program_id = ? AND (ar_strikes > 0 OR ar_paused_until IS NOT NULL)');
// Assess ONE finished run's auto-seated floor for no-shows (call once, after the run ends). Strikes
// the ghosts, pauses repeat offenders, clears the streak for anyone who confirmed. Program-generic.
function assessRenewPenalties(programId, rd) {
  const cfg = P(programId).config, pen = cfg.autoRenewPenalty;
  if (!pen || !rd) return;
  // Door mode: there IS no in-app confirm, so "auto-seated and never confirmed" describes the
  // entire floor — assessing it would false-strike every renewer, every week. The penalty goes
  // DORMANT with the confirm flow (2026-08-05, flipped with the owner's door-mode decision);
  // it comes back the day arrival (the PCO door tap) becomes the show/no-show source.
  if (doorMode()) return;
  const part = partitionFor(programId, rd);
  const floor = cfg.offerWindow ? part.floorReal : part.floor;
  const struck = [], paused = [];
  for (const p of floor) {
    if (/@guest\.local$/.test(p.email) || !p.auto_seated) continue;   // only the auto-renew GUARANTEE is policed
    if (p.confirmed_at) { stmtPmResetStrikes.run(programId, p.email); continue; }  // showed → streak cleared
    stmtPmEnsureRow.run(programId, p.email);                            // lazy row (basketball team members may lack one)
    const next = ((stmtPmStrikeState.get(programId, p.email) || {}).ar_strikes || 0) + 1;
    if (next >= pen.strikes) { const until = shiftYmd(rd, pen.pauseWeeks * 7); stmtPmPauseAR.run(until, programId, p.email); paused.push({ email: p.email, until }); }
    else { stmtPmSetStrikes.run(next, programId, p.email); struck.push({ email: p.email, n: next }); }
  }
  if (!struck.length && !paused.length) return;
  const sport = P(programId).displayName, runUrl = P(programId).paths.run, tag = cfg.logTag || 'run';
  for (const s of struck) setImmediate(() => sendPush([s.email], { title: `${sport}: auto-renew strike ${s.n} of ${pen.strikes}`, body: `You were auto-added but didn't confirm or sit out. ${pen.strikes - s.n} more no-show${pen.strikes - s.n === 1 ? '' : 's'} and your weekly auto-renew pauses — tap Sit out early if you can't make it.`, url: runUrl, tag: `${tag}arstrike` }));
  for (const s of paused) setImmediate(() => sendPush([s.email], { title: `${sport}: auto-renew paused`, body: `After repeated no-shows your weekly auto-renew is paused until ${runLabelFor(s.until)}. You can still check in by hand anytime.`, url: runUrl, tag: `${tag}arpause` }));
  audit('system', 'system', `${tag}:arpenalty`, `${rd} struck=${struck.length} paused=${paused.length}`);
}
// Lift expired pauses for a program (call at the weekly open). Clears ar_paused_until once it's in the
// past and tells the member their auto-renew is back. seatRenewers already re-seats them (its filter
// admits ar_paused_until <= today); this tidies the flag + notifies. No-op without the feature.
function liftExpiredPauses(programId) {
  const cfg = P(programId).config;
  if (!cfg.autoRenewPenalty) return;
  const today = ymdLocal(new Date(schedNow()));   // schedNow so the pause window honours TEST_NOW (== real time in prod)
  const lifted = db.prepare('SELECT email FROM program_membership WHERE program_id = ? AND ar_paused_until IS NOT NULL AND ar_paused_until <= ?').all(programId, today);
  if (!lifted.length) return;
  db.prepare('UPDATE program_membership SET ar_paused_until = NULL WHERE program_id = ? AND ar_paused_until IS NOT NULL AND ar_paused_until <= ?').run(programId, today);
  const sport = P(programId).displayName, runUrl = P(programId).paths.run;
  for (const r of lifted) setImmediate(() => sendPush([r.email], { title: `${sport}: auto-renew is back on`, body: `Your weekly auto-renew is active again — you'll be auto-added to the next run.`, url: runUrl, tag: `${cfg.logTag || 'run'}arlift` }));
  audit('system', 'system', `${cfg.logTag || 'run'}:arlift`, String(lifted.length));
}
// Penalty state for a program's floor, keyed by email → { ar_strikes, ar_paused_until } — for the
// operator roster badge (only auto-seated ghosts ever have state). {} when the feature's off.
function penaltyStateFor(programId) {
  if (!P(programId).config.autoRenewPenalty) return {};
  const out = {};
  for (const r of stmtPmPausedFloor.all(programId)) out[r.email] = { strikes: r.ar_strikes, until: r.ar_paused_until };
  return out;
}
// Shared by the scheduled auto-open AND the manual "Open check-in". Pickleball is on the unified
// seating engine (Phase 3c); basketball's autoJoinTeam converges at its own cutover.
function pkSeatRenewers(rd) { return seatRenewers(2, rd); }
// When a FLOOR player leaves, the next waitlister silently crosses onto the floor (pkPartition
// re-slices by order — pickleball has no offer/claim window, it's immediate first-come). Push
// that person so they actually know a spot opened. CALL THIS BEFORE deleting the leaver, passing
// their email — returns nothing, just notifies the promoted waitlister (if any, non-guest).
// Simple-program promotion: notify the first waitlister that a floor spot just freed. Program-
// generic (copy/paths from config); only used by non-offer-window programs (offer-window ones send
// a held offer via createOffer instead). pkNotifyPromotion stays a wrapper.
function notifyPromotionFor(programId, rd, leavingEmail) {
  const cfg = P(programId).config, lv = lc(leavingEmail);
  const part = partitionFor(programId, rd);                      // called for SIMPLE programs, so part.floor is the shape
  if (!part.floor.some(p => lc(p.email) === lv)) return;         // leaver wasn't on the floor → no spot frees
  const oldSet = new Set(part.floor.map(p => lc(p.email)));
  // Recompute the floor as it will be AFTER the leaver's row is deleted (the caller deletes next).
  // Under queue-with-friends a waiting PARTY that still doesn't fit the one freed seat is skipped and
  // a solo behind it is seated instead — so the real promotee(s) come from a partition diff, not
  // wait[0] (P2-2). For a solo run this is exactly the old wait[0].
  const remaining = part.rows.filter(p => lc(p.email) !== lv);
  const newFloor = groupQueueFeature(programId) ? packParties(remaining, cfg.cap).floor : remaining.slice(0, cfg.cap);
  const promoted = newFloor.filter(p => !oldSet.has(lc(p.email)) && !/@guest\.local$/.test(p.email));
  if (!promoted.length) return;
  setImmediate(() => sendPush(promoted.map(p => p.email), { title: cfg.copy.promoTitle, body: cfg.copy.promoBody(rd), url: P(programId).paths.run, tag: `${cfg.logTag}promo` }));
  for (const p of promoted) audit('system', 'system', `${cfg.logTag}:promote`, p.email);
}
function pkNotifyPromotion(rd, leavingEmail) { return notifyPromotionFor(2, rd, leavingEmail); }
// Pull someone off the pickleball floor for THIS cycle, promoting the waitlist behind them —
// the pickleball twin of the checkins delete + offer-onward that suspend/reject already do for
// basketball. Notify first: once the row is gone, pkNotifyPromotion can't tell a floor leaver
// from a waitlist leaver. Safe to call for someone who isn't on the roster (no-op).
function dropFromPickleball(email) {   // kept as an alias — see dropFromAllOptInPrograms
  return dropFromAllOptInPrograms(email);
}
// Suspend/reject cascade, PROGRAM-AGNOSTIC (P2-2): the old dropFromPickleball was hardcoded to
// program 2 — written when there were two programs — so a suspended player kept their volleyball
// or mounted-program seat and silently blocked that waitlist (registry extension without the
// consumer walk). removeFromRun already does the whole per-program job correctly: offer-vs-notify
// on the freed spot, team + party cleanup, F4 waitlist pings. Basketball (program 1) stays with
// the callers' inline handling; static programs have synthetic rosters.
function dropFromAllOptInPrograms(email) {
  if (!email) return;
  for (const p of PROGRAMS.values()) {
    if (p.id === 1 || p.config.static) continue;
    try { removeFromRun(p.id, programRunDate(p.id), lc(email)); }
    catch (e) { console.error(`[cascade] drop from program ${p.id} failed for suspend/reject: ${e.message}`); }
  }
}

// Confirm-flow markers when a run's EFFECTIVE DAY changes (date move / uncancel past the window):
// the 9 AM ping is load-bearing for the confirm-or-release sweep — a day must NEVER sweep players
// it never pinged. If the (new) day's cutoff has already passed, STAMP both markers (that day's
// window is over: no ping, no sweep); otherwise RE-ARM both (delete) so the day pings at 9 AM and
// sweeps at its own cutoff. Mirrors /admin/rundate's long-standing autoclose carry rule.
function migrateConfirmMarkers(newRd, confirmCutoff, pingKey, sweepKey) {
  if (!confirmCutoff) return;
  const past = schedNow() >= new Date(newRd + 'T' + confirmCutoff + ':00').getTime();
  for (const k of [pingKey, sweepKey]) {
    if (!k) continue;
    if (past) setSetting(k, newRd);
    else db.prepare('DELETE FROM app_settings WHERE key = ?').run(k);
  }
}
// Weekly auto open/ping/lock for an opt-in run (runs on the shared 60s interval), keyed to the
// program's run date. Check-in OPENS the moment the prior run ends (config.endHour, openOffsetDays
// before run day) so members re-queue the same night, the floor gets a CONFIRM PING the night
// before (config.pingHour / pingDowOffset), and the roster LOCKS at config.lockTime. Each fires
// once per cycle (app_settings markers config.keys.auto*). Season-gated + membership-scoped (only
// members are pushed — never the whole club). Skipped while hidden or cancelled. Manual open/close/
// date still work anytime. Program-generic — pkAutoRunState is a thin wrapper.
function autoRunStateFor(programId) {
  const cfg = P(programId).config;
  if (!programActive(programId)) return;
  const rd = programRunDate(programId);
  if (!rd || runCancelledFor(programId, rd)) return;
  const opener = programSeasonStart(programId);
  if (opener && rd < opener) return;   // never fire before the season opener (run date is gated, this is belt-and-suspenders)
  const now = schedNow();
  const hh = hhLocal;
  const openAt = new Date(shiftYmd(rd, cfg.openOffsetDays) + 'T' + endHHMM(cfg) + ':00').getTime();   // prior run's end → reopen
  const pingAt = new Date(shiftYmd(rd, -cfg.pingDowOffset) + hh(cfg.pingHour)).getTime();       // run-day 9 AM (offset 0 / hour 9 in config)
  const lockAt = new Date(rd + 'T' + cfg.lockTime + ':00').getTime();                           // roster locks before start
  const runUrl = P(programId).paths.run;
  // OPEN (once) — from the prior run's end through lock.
  if (now >= openAt && now < lockAt && getSetting(cfg.keys.autoopen) !== rd) {
    setSetting(cfg.keys.autoopen, rd);
    if (!runOpenFor(programId, rd)) {
      setRunStateFor(programId, rd, 'is_open', 1);
      liftExpiredPauses(programId);            // a paused auto-renewer whose window elapsed rejoins the guarantee
      const added = seatRenewers(programId, rd);
      audit('system', 'system', `${cfg.logTag}:autoopen`, `${rd} +${added} auto`);
      setImmediate(() => sendPush(programMemberEmails(programId), { title: cfg.copy.openTitle, body: cfg.copy.openBody(rd), url: runUrl, tag: `${cfg.logTag}queueopen` }));
      console.log(`[${cfg.logTag}-autoopen] opened ${cfg.logTag} check-in for ${rd} (auto-added ${added})`);
    }
  }
  // Confirm cutoff (config.confirmCutoff, absolute 'HH:MM' on run day): unconfirmed floor spots
  // are RELEASED to the next in line (owner rule). Absent = no sweep for this program. Door mode
  // (effectiveConfirmCutoff → null) also kills the confirm PING — the door tap is the confirmation.
  const genCutoff = effectiveConfirmCutoff(cfg.confirmCutoff);
  const cutoffAt = genCutoff ? new Date(rd + 'T' + genCutoff + ':00').getTime() : null;
  const cutoffLabel = cutoffAt ? fmtClockLabel(genCutoff) : '';
  // CONFIRM PING (once) — run-day morning (config.pingHour), deadline spelled out. Stops firing
  // once the cutoff has passed (the sweep is the message then).
  if (!doorMode() && now >= pingAt && now < (cutoffAt || lockAt) && getSetting(cfg.keys.autoping) !== rd) {
    setSetting(cfg.keys.autoping, rd);
    if (runOpenFor(programId, rd) && !runCancelledFor(programId, rd)) {
      const part = partitionFor(programId, rd);
      const floorRows = cfg.offerWindow ? part.floorReal : part.floor;
      const floor = floorRows.filter(p => !/@guest\.local$/.test(p.email) && !p.confirmed_at).map(p => p.email);
      if (floor.length) {
        const body = cfg.copy.confirmBody(rd) + (cutoffLabel ? ` Confirm by ${cutoffLabel} — unconfirmed spots go to the waitlist.` : '');
        setImmediate(() => sendPush(floor, { title: cfg.copy.confirmTitle, body, url: runUrl, tag: `${cfg.logTag}confirm` }));
        audit('system', 'system', `${cfg.logTag}:autoping`, String(floor.length));
        console.log(`[${cfg.logTag}-autoping] pinged ${floor.length} unconfirmed ${cfg.logTag} floor player(s) for ${rd}`);
      }
    }
  }
  // CONFIRM-OR-RELEASE (once, at the cutoff): every unconfirmed floor player is removed via the
  // same path as an operator Remove — simple programs auto-slide the next waitlister up (with the
  // promotion push), offer-window programs offer the freed spot. Guests exempt (operator-vouched,
  // no account to confirm from).
  if (cutoffAt && cfg.keys.confirmsweep && now >= cutoffAt
      && getSetting(cfg.keys.confirmsweep) !== rd && !runCancelledFor(programId, rd)) {
    setSetting(cfg.keys.confirmsweep, rd);
    const part = partitionFor(programId, rd);
    const floorRows = cfg.offerWindow ? part.floorReal : part.floor;
    const drop = floorRows.filter(p => !/@guest\.local$/.test(p.email) && !p.confirmed_at);
    for (const p of drop) removeFromRun(programId, rd, String(p.email).toLowerCase(), null);
    if (drop.length) {
      setImmediate(() => sendPush(drop.map(p => p.email), {
        title: 'Your spot was released',
        body: `You didn't confirm for ${runLabelFor(rd)} by ${cutoffLabel}, so your spot went to the next in line.`,
        url: runUrl, tag: `${cfg.logTag}confirm`,
      }));
      audit('system', 'system', `${cfg.logTag}:confirmsweep`, String(drop.length));
      console.log(`[${cfg.logTag}-confirmsweep] released ${drop.length} unconfirmed spot(s) for ${rd}`);
    }
  }
  // LOCK (once) — at run start.
  if (now >= lockAt && getSetting(cfg.keys.autolock) !== rd) {
    setSetting(cfg.keys.autolock, rd);
    if (runOpenFor(programId, rd)) { setRunStateFor(programId, rd, 'is_open', 0); audit('system', 'system', `${cfg.logTag}:autolock`, rd); }
  }
  // (Penalty assess moved to ensureWeekFor's archive loop — a `now >= rd@endHour` check here was
  // provably unreachable: programDefaultDate rolls rd to next week at that same endHour instant.)
}
function pkAutoRunState() { return autoRunStateFor(2); }
// Access gate for an opt-in run (pickleball, volleyball): approved players + admins in; a hidden
// program 404s for everyone but admins. Operator = admin for now. programGate is program-generic;
// pkGate stays a thin wrapper so call sites are untouched.
function programGate(programId, req, res) {
  const a = applicantByEmail(req.userEmail);
  const admin = isAdmin(req.userEmail);
  if (!admin && (!a || a.status !== 'approved')) { res.redirect('/status'); return null; } // row-less admins allowed (matches requirePlayer)
  // Hidden programs stay reachable for their HOST too (P3-9): hiding a program mid-season must
  // not lock the person who runs it out of rosters/requests/history until an admin re-publishes.
  if (!programActive(programId) && !admin && !isProgramHost(programId, req.userEmail)) { res.status(404).send('Not found'); return null; }
  // canOperate: global admins, or THIS program's host (F2). Host power is per-program by
  // construction — the row carries the program_id, so a youth host can't touch volleyball.
  return { a, admin, canOperate: admin || isProgramHost(programId, req.userEmail) };
}
function pkGate(req, res) { return programGate(2, req, res); }
// Hoisted rollover statements — program-generic (bind program_id at call). ensureWeekFor runs on
// every /runs + opt-in-run GET, on join, and the 60s tick.
const stmtRollPastDates = db.prepare('SELECT DISTINCT run_date FROM checkins WHERE program_id = ? AND run_date <= ?');
const stmtRollArchiveIns = db.prepare('INSERT OR IGNORE INTO attendance (run_date, email, name, program_id) VALUES (?,?,?,?)');
const stmtRollDelCheckinsByDate = db.prepare('DELETE FROM checkins WHERE run_date = ? AND program_id = ?');
const stmtRollDelStateByDate = db.prepare('DELETE FROM run_state WHERE run_date = ? AND program_id = ?');
const stmtRollSweepState = db.prepare('DELETE FROM run_state WHERE run_date < ? AND program_id = ?');
const stmtRollSweepOptout = db.prepare('DELETE FROM regular_optout WHERE run_date < ? AND program_id = ?');
// Lazy rollover for an opt-in run (mirrors basketball's ensureWeek): once a finished run passes,
// archive its floor into attendance, purge past rows, and clear a spent explicit date back to the
// weekly standing day. Program-generic — cap, end hour and the date keys come from config;
// pkEnsureWeek is a thin wrapper.
const lastRolledFor = new Map(); // programId → last gate string that ran the rollover
function ensureWeekFor(programId) {
  const cfg = P(programId).config;
  // A STATIC program (the demo run) has no weekly lifecycle: never roll the date, archive to
  // attendance, or purge — its seeded roster stays exactly as the operator left it until they
  // reset/clear it. Guarding here covers every caller (render, poll, join, tick).
  if (cfg.static) return;
  const today = ymdLocal();
  const now = new Date();
  // A run counts as OVER once its end time passes on run day — so today's run is
  // archived that same night and the cycle rolls forward, letting check-in reopen that evening.
  const endedToday = minutesOfDay(now) >= endMinutesOf(cfg) ? today : null;
  // Gate the archive/purge/sweep work like basketball's ensureWeek (P3-5): re-run only when the run
  // advances OR a run has just ended today — NOT on every /poll tick + /runs render (this is called
  // from runPollFingerprint, genericHubCard, runGetPage, runJoin and the 60s tick).
  const gate = `${programRunDate(programId)}|${endedToday ? 1 : 0}`;
  if (lastRolledFor.get(programId) === gate) return;
  lastRolledFor.set(programId, gate);
  const isPast = rd => rd < today || rd === endedToday;
  // Archive + purge ANY finished run so the floor is recorded to attendance and stale rows never accumulate.
  const pastDates = stmtRollPastDates.all(programId, today).map(r => r.run_date).filter(isPast);
  for (const rd of pastDates) {
    // Archive the ACTUAL floor from the partition, not a positional first-cap slice (P2-5): for an
    // offer-window run that excludes held/unclaimed offers (a spot offered-but-never-claimed is a
    // no-show, not attendance), and for a queue-with-friends run it respects packParties' atomic
    // placement (a party that WAITED isn't credited just because a member sits early in sort order).
    const part = partitionFor(programId, rd);
    const floor = cfg.offerWindow ? part.floorReal : part.floor;
    // PENALTY ASSESS (once) — strike this run's auto-seated ghosts NOW, while the roster still
    // exists. This is the ONLY place the generic engine can judge a finished run: programDefaultDate
    // rolls the run date to next week at endHour — the exact moment a clock check `now >= rd@endHour`
    // would first hold — so an autoRunStateFor branch could never fire with a current rd (it sat
    // unreachable from Phase 5.5 until 2026-08-05). Archive-time is also crash-safe: a run that
    // ends while the server is down is assessed at the next boot's catch-up, roster intact. The
    // marker keeps it once-per-run if a crash lands between the strike writes and the purge below.
    if (cfg.autoRenewPenalty && getSetting(cfg.keys.arassess) !== rd) {
      setSetting(cfg.keys.arassess, rd);
      assessRenewPenalties(programId, rd);
    }
    writeRunSummary(programId, rd);   // metrics layer: before the purge erases the evidence
    for (const p of floor) if (!/@guest\.local$/.test(p.email)) stmtRollArchiveIns.run(rd, p.email, p.name, programId);
    stmtRollDelCheckinsByDate.run(rd, programId); stmtRollDelStateByDate.run(rd, programId);
    clearRunTeams(programId, rd);   // archived run → drop its team assignments
    clearRunParties(programId, rd); // and its queue-with-friends parties (Phase 6b)
  }
  // Sweep stale run_state for past runs that had NO check-ins (a zero-join or cancelled week never
  // appears in pastDates above, so its is_open/cancelled row would leak forever).
  // Metrics layer first: those zero-join/cancelled weeks still get their summary row (zeros +
  // the cancelled flag) before the state that proves they happened is swept.
  for (const r of db.prepare('SELECT run_date FROM run_state WHERE program_id = ? AND run_date < ?').all(programId, today)) writeRunSummary(programId, r.run_date);
  stmtRollSweepState.run(today, programId);
  stmtRollSweepOptout.run(today, programId);   // sit-outs are per-week → clear past ones so renewal resumes
  // Parties for past runs that never reached check-in (invited-only, no checkins → not in pastDates) also leak; sweep them.
  db.prepare('DELETE FROM signup_group_members WHERE group_id IN (SELECT id FROM signup_groups WHERE program_id = ? AND run_date < ?)').run(programId, today);
  db.prepare('DELETE FROM signup_groups WHERE program_id = ? AND run_date < ?').run(programId, today);
  // Clear a passed explicit override back to the weekly standing day.
  const set = getSetting(cfg.keys.runDate);
  if (set && isPast(set)) delSetting(cfg.keys.runDate);
  // Clear a consumed standing-day skip once that day is itself past (see /pickleball/date).
  const base = getSetting(cfg.keys.runBase);
  if (base && base < today) delSetting(cfg.keys.runBase);
}
function pkEnsureWeek() { return ensureWeekFor(2); }

// ---------- GENERIC RUN-ROUTE HANDLERS (opt-in programs) ----------
// Each handler body is program-generic (programId + P(id).paths/config); the inline /pickleball/*
// routes below call them with 2 (byte-identical), and mountRunProgram registers them for a 3rd
// program under its own paths. Basketball keeps its own /checkin/* routes (migrate post-freeze).
function runOpen(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const rd = programRunDate(programId); if (runCancelledFor(programId, rd)) return res.redirect(base);
  setRunStateFor(programId, rd, 'is_open', 1);
  // Don't re-seat auto-renewers past the confirm cutoff — a manual re-open after the 4:30 sweep
  // would silently restore the exact players the sweep just released.
  const cfg = P(programId).config;
  const openCutoff = effectiveConfirmCutoff(cfg.confirmCutoff);   // door mode: cutoff gone → renewers always seat
  if (!openCutoff || schedNow() < new Date(rd + 'T' + openCutoff + ':00').getTime()) seatRenewers(programId, rd);
  res.redirect(base);
}
function runClose(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  setRunStateFor(programId, programRunDate(programId), 'is_open', 0); res.redirect(base);
}
function runConfirm(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return;
  const rd = programRunDate(programId), part = partitionFor(programId, rd);
  const floor = P(programId).config.offerWindow ? part.floorReal : part.floor;
  if (floor.some(p => p.email === req.userEmail)) {
    if (req.body.un === '1') stmtConfirmClear.run(rd, req.userEmail, programId);   // the confirmed pill is a toggle — undo clears the ✓
    else stmtConfirmSet.run(rd, req.userEmail, programId);
  }
  res.redirect(base);
}
function runAutorenew(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return;
  if (!memberOf(programId, req.userEmail)) return res.redirect(base);
  const on = req.body.on === '1' ? 1 : 0;
  if (on && (!g.a || !waiverSatisfied(programId, g.a.email))) return res.redirect(waiverGateUrl(programId, base)); // can't auto-seat without the waiver (program-scoped when config.waiver is set — F6)
  db.prepare('UPDATE program_membership SET auto_renew = ? WHERE program_id = ? AND email = ?').run(on, programId, req.userEmail);
  res.redirect(base);
}
// F3: joinMode is ENFORCED here — 'open' (anyone approved joins, the historic behaviour and the
// default), 'invite' (organizers add members; self-join refused), 'host' (self-join creates a
// REQUEST; hosts get a push and approve on the run page). Built-in programs carry no joinMode →
// 'open', exactly their live behaviour.
function runJoinRun(programId, req, res) {
  const g = programGate(programId, req, res); if (!g) return;
  const base = P(programId).paths.run;
  const mode = P(programId).config.joinMode || 'open';
  if (memberOf(programId, req.userEmail)) { setRunCookie(req, res, programId); return res.redirect(base); }
  if (mode === 'invite') return res.redirect(base);   // the join page already explains invite-only; no state change
  if (mode === 'host') {
    const existing = db.prepare('SELECT status FROM program_membership WHERE program_id = ? AND email = ?').get(programId, req.userEmail);
    if (!existing) {
      // P3-10: a decline deletes the row, so an immediate re-request re-pushes every host +
      // admin — 3/day per person per program keeps that a nudge, not a siren.
      if (rateLimited('joinreq', `${req.userEmail}|${programId}`, 3, 24 * 3600 * 1000)) return res.redirect(base);
      joinProgramMembership(programId, req.userEmail, 'pending');
      audit(req.userEmail, 'player', 'program:join-requested', `${programId}`);
      const who = (g.a && g.a.full_name) || req.userEmail;
      setImmediate(() => sendPush(programHostEmails(programId), {
        title: `${P(programId).displayName}: join request`,
        body: `${who} asked to join. Approve or decline on the run page.`,
        url: base, tag: `joinreq${programId}`,
      }));
    }
    return res.redirect(base);   // page shows "request sent" for pending members
  }
  joinProgramMembership(programId, req.userEmail);
  setRunCookie(req, res, programId);
  res.redirect(base);
}
// Hosts/admins act on pending requests from the run page.
function runRequests(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const email = String(req.body.email || '').toLowerCase();
  const row = db.prepare("SELECT 1 FROM program_membership WHERE program_id = ? AND email = ? AND status = 'pending'").get(programId, email);
  if (!row) return res.redirect(base);
  if (req.body.act === 'approve') {
    db.prepare("UPDATE program_membership SET status = 'approved' WHERE program_id = ? AND email = ?").run(programId, email);
    audit(req.userEmail, g.admin ? 'admin' : 'host', 'program:request-approved', `${programId}:${email}`);
    setImmediate(() => sendPush([email], {
      title: `You're in — ${P(programId).displayName}`,
      body: 'Your request to join was approved. Check-in and chat are open to you now.',
      url: base, tag: `joinok${programId}`,
    }));
  } else {
    db.prepare('DELETE FROM program_membership WHERE program_id = ? AND email = ?').run(programId, email);
    audit(req.userEmail, g.admin ? 'admin' : 'host', 'program:request-declined', `${programId}:${email}`);
  }
  res.redirect(base);
}
function runBump(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const rd = programRunDate(programId); if (runCancelledFor(programId, rd)) return res.redirect(base);
  const wlBefore = waitlistOrderFor(programId, rd);   // F4 (P3-2): bumping a waitlister up shifts those behind (bball twin pings)
  const row = db.prepare('SELECT MIN(sort_order) m FROM checkins WHERE run_date = ? AND program_id = ?').get(rd, programId);
  db.prepare('UPDATE checkins SET sort_order = ? WHERE run_date = ? AND email = ? AND program_id = ?').run(((row && row.m) || 0) - 1, rd, String(req.body.email || '').toLowerCase(), programId);
  setImmediate(() => pingWaitlistShift(programId, rd, wlBefore));
  res.redirect(base);
}
function runJoin(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return;
  if (!g.a || g.a.suspended) return res.redirect(base); // need a profile to join; suspended can't
  if (!waiverSatisfied(programId, g.a.email)) return res.redirect(waiverGateUrl(programId, base)); // one-time waiver before first join (program-scoped when config.waiver is set — F6)
  ensureWeekFor(programId);
  const rd = programRunDate(programId);
  if (runCancelledFor(programId, rd) || !runOpenFor(programId, rd)) return res.redirect(base);
  const { rows } = partitionFor(programId, rd);
  if (rows.length >= cfg.cap + cfg.waitlist && !rows.find(p => p.email === req.userEmail)) return res.redirect(base); // full
  // F3 enforcement (P2-1): a direct POST here must not bypass the program's join mode — it
  // previously enrolled ANY approved club player, invite-only or not (and let a pending
  // requester self-approve). Non-members of a non-open program go back to the join prompt,
  // which explains / requests properly. Open mode keeps the auto-enroll below.
  if (!memberOf(programId, req.userEmail) && (cfg.joinMode || 'open') !== 'open') return res.redirect(base);
  // Taking a seat makes you a member — a direct POST skips the GET that would enroll you, so
  // without this an approved player could seat as a ghost (on the floor, absent from the member
  // list / chat audience / push). Idempotent + guest-safe.
  joinProgramMembership(programId, req.userEmail);
  db.prepare('DELETE FROM regular_optout WHERE run_date = ? AND email = ? AND program_id = ?').run(rd, req.userEmail, programId); // re-joining clears any sit-out
  // Joining ON run day IS confirming (claim=confirm reasoning) — a same-day joiner must not be
  // swept "unconfirmed" at the cutoff they signed up within.
  const ins = db.prepare("INSERT OR IGNORE INTO checkins (run_date, email, name, program_id, confirmed_at) VALUES (?,?,?,?, CASE WHEN ? = 1 THEN datetime('now') END)")
    .run(rd, req.userEmail, g.a.full_name, programId, rd === ymdLocal() ? 1 : 0);
  if (ins.changes && !cfg.static) metric('checkin_join', { programId, runDate: rd });   // demo excluded (P3-7), like offer_*
  res.redirect(base);
}
function runCancel(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const rd = programRunDate(programId), on = req.body.on !== '0';
  const cfg = P(programId).config;
  setRunStateFor(programId, rd, 'cancelled', on);
  if (on) { setRunStateFor(programId, rd, 'is_open', 0); db.prepare('DELETE FROM checkins WHERE run_date = ? AND program_id = ?').run(rd, programId); clearRunTeams(programId, rd); clearRunParties(programId, rd); }
  // Un-cancelling past the confirm cutoff must NOT arm an instant unpinged sweep (same rule as a date move).
  else migrateConfirmMarkers(rd, effectiveConfirmCutoff(cfg.confirmCutoff), cfg.keys.autoping, cfg.keys.confirmsweep);
  res.redirect(base);
}
function runPublish(programId, req, res) {
  const cfg = P(programId).config;
  db.prepare('UPDATE program SET active = ? WHERE id = ?').run(req.body.on === '0' ? 0 : 1, programId);
  audit(req.userEmail, 'admin', req.body.on === '0' ? `${cfg.logTag}:hide` : `${cfg.logTag}:publish`, '');
  res.redirect(P(programId).paths.run);
}
// A member leaves the run (self sit-out). Offer-window programs offer the freed floor spot onward
// (capture the offeree BEFORE the delete); simple programs notify the first waitlister. Records a
// per-week sit-out so an auto-renew member isn't re-seated on a later open.
function runLeave(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return;
  const rd = programRunDate(programId);
  const wlBefore = waitlistOrderFor(programId, rd);   // F4 snapshot — self-leave shifts everyone behind up
  const offeree = cfg.offerWindow ? offereeForFloorLeave(rd, req.userEmail, programId) : null;   // guest priority handled inside
  if (!cfg.offerWindow) {
    // Simple model: guest priority first (owner rule), then the member promotion push.
    const onFloor = partitionFor(programId, rd).floor.some(p => lc(p.email) === lc(req.userEmail));
    if (onFloor && !seatWaitingGuest(programId, rd)) notifyPromotionFor(programId, rd, req.userEmail);
  }
  db.prepare('INSERT OR IGNORE INTO regular_optout (run_date, email, program_id) VALUES (?, ?, ?)').run(rd, req.userEmail, programId);
  stmtDelCheckinRow.run(rd, req.userEmail, programId);
  clearTeamAssignment(programId, rd, req.userEmail);   // off the floor → off any team
  setPartyDeclinedFor(programId, rd, req.userEmail);   // and out of any party so a group check-in can't re-seat them (P2-2)
  if (offeree) createOffer(rd, offeree, req, programId);
  setImmediate(() => pingWaitlistShift(programId, rd, wlBefore));   // F4: after the dust settles
  res.redirect(base);
}
// Operator pulls someone off the floor for THIS cycle (no sit-out recorded — an operator action,
// not the player opting out). Same offer-vs-notify split as runLeave.
// Take ONE player off a run's roster + hand their spot onward — the single removal path shared
// by the operator Remove button and the confirm-or-release sweep. Offer-window programs offer
// the freed spot (claim link); simple programs auto-slide the next waitlister up (with the
// promotion push). req may be null (scheduler) — createOffer falls back to PUBLIC_URL.
// F4: tell waitlisters when they MOVE UP. The #1 who reaches the floor already gets the promo
// push; this covers everyone behind them who shuffled forward (top 5 only — "#9 → #8" is noise).
// Snapshot the order before the mutation, compare after, push the improvements.
function waitlistOrderFor(programId, rd) {
  // partitionFor is program-generic; offer-window programs expose waitPlayers, simple ones wait.
  const part = partitionFor(programId, rd);
  return (part.wait || part.waitPlayers || []).map(p => lc(p.email)).filter(e => !/@guest\.local$/.test(e));
}
function pingWaitlistShift(programId, rd, before) {
  try {
    const after = waitlistOrderFor(programId, rd);
    for (let i = 0; i < Math.min(after.length, 5); i++) {
      const was = before.indexOf(after[i]);
      if (was > i) {   // strictly closer to the floor than before
        const pos = i + 1;
        sendPush([after[i]], {
          title: `You're #${pos} on the waitlist`,
          body: `You moved up for ${runWeekday(rd)}'s ${P(programId).displayName.toLowerCase()} — ${pos === 1 ? 'next spot that opens is yours' : 'getting close'}.`,
          url: P(programId).paths.run, tag: `wlmove${programId}`,   // same tag collapses repeat moves
        });
      }
    }
  } catch (e) { console.error(`[wlmove] ping failed: ${e.message}`); }
}
function removeFromRun(programId, rd, em, req = null) {
  const cfg = P(programId).config;
  const before = waitlistOrderFor(programId, rd);   // F4 snapshot
  const offeree = cfg.offerWindow ? offereeForFloorLeave(rd, em, programId) : null;   // guest priority handled inside
  if (!cfg.offerWindow) {
    // Simple model: only a FLOOR leaver frees a spot. Guest priority — a waitlisted guest is
    // floated into the freed spot (no member promotion happened, so skip the promo push).
    const onFloor = partitionFor(programId, rd).floor.some(p => lc(p.email) === lc(em));
    if (onFloor && !seatWaitingGuest(programId, rd)) notifyPromotionFor(programId, rd, em);
  }
  stmtDelCheckinRow.run(rd, em, programId);
  clearTeamAssignment(programId, rd, em);   // off the floor → off any team
  setPartyDeclinedFor(programId, rd, em);   // and out of any party so a group check-in can't re-seat them (P2-2)
  if (offeree) createOffer(rd, offeree, req, programId);
  setImmediate(() => pingWaitlistShift(programId, rd, before));   // F4: after the dust settles
}
function runRemove(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  removeFromRun(programId, programRunDate(programId), String(req.body.email || '').toLowerCase(), req);
  res.redirect(base);
}
// Generic offer-claim for offerWindow programs mounted via mountRunProgram — the piece that
// completes the auto-offer → confirm → promote money-moment for any program (not just basketball's
// inline /checkin/claim). Mirrors that route but PROGRAM-SCOPED: GET renders a confirm page (a
// mail-scanner's bare GET can't auto-claim), POST does the atomic, race-safe claim (read→check→
// clear; the first tap clears the token, a second finds nothing). A STATIC/demo claim just slides
// the synthetic player onto the floor and returns to the roster — it never mints a session.
function runClaimGet(programId, req, res) {
  const base = P(programId).paths.run;
  const token = req.params.token || '';
  const row = db.prepare('SELECT * FROM checkins WHERE claim_token = ? AND program_id = ?').get(token, programId);
  if (!row || row.offered_at == null || row.offered_at < Date.now() - OFFER_WINDOW_MS) return res.send(claimResultPage({ ok: false }));
  return res.send(confirmActionPage({
    title: 'Claim your spot', heading: 'A spot opened up',
    sub: `You've got a floor spot for ${runLabelFor(row.run_date)} — one tap locks it in.`,
    action: `${base}/claim/${token}`, fields: {}, button: 'Claim my spot →',
  }));
}
function runClaimPost(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const token = req.params.token || '';
  const row = db.prepare('SELECT * FROM checkins WHERE claim_token = ? AND program_id = ?').get(token, programId);
  if (!row || row.offered_at == null || row.offered_at < Date.now() - OFFER_WINDOW_MS) {
    return cfg.static ? res.redirect(base) : res.send(claimResultPage({ ok: false }));
  }
  db.prepare("UPDATE checkins SET offered_at = NULL, claim_token = NULL, confirmed_at = datetime('now') WHERE id = ?").run(row.id);   // claiming IS confirming
  audit(row.email, 'player', 'offer:claim', row.email);
  if (!cfg.static) metric('offer_claim', { programId, runDate: row.run_date, meta: `mins=${Math.round((Date.now() - row.offered_at) / 60000)}` });
  if (cfg.static) return res.redirect(base);        // demo: synthetic player slides onto the floor
  signIn(res, row.email, 'spot claim');                        // real program: sign the claimer in
  return res.send(claimResultPage({ ok: true, runLabel: runLabelFor(row.run_date), runDate: row.run_date, startLabel: startLabelFor(programId) }));
}
function runIcs(programId, req, res) {
  const cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return;
  const rd = programRunDate(programId);
  const dt = (hhmm) => rd.replace(/-/g, '') + 'T' + hhmm + '00';
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Bridge Adv Runs//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:bridge-${cfg.logTag}-${rd}@bridge`, `DTSTAMP:${ymdLocal().replace(/-/g, '')}T000000`,
    `DTSTART:${dt(startHHMM(cfg).replace(':', ''))}`, `DTEND:${dt(endHHMM(cfg).replace(':', ''))}`,
    `SUMMARY:The Bridge — ${P(programId).displayName}`, 'LOCATION:The Bridge · Markham',
    runCancelledFor(programId, rd) ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="bridge-${P(programId).key}-${rd}.ics"`);
  res.send(ics);
}
function runAnnounce(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const body = (req.body.body || '').trim().slice(0, 1000);
  if (!body) return res.redirect(base);
  if (rateLimited(`${cfg.logTag}-announce`, req.userEmail, 6, 10 * 60 * 1000)) return res.redirect(base);
  const author = (g.a && g.a.full_name) || req.userEmail;
  // Same-body/same-author within 10s = a double-tap, not a second announcement (the 6-per-10-min
  // limit is far too coarse to catch it, and each dup costs every member a push + email).
  if (db.prepare("SELECT 1 FROM announcements WHERE program_id = ? AND body = ? AND author = ? AND at >= datetime('now','-10 seconds') LIMIT 1").get(programId, body, author))
    return res.redirect(base);
  const schedAt = parseScheduleAt(req.body.publish_at);   // F8 — see /announce
  if (schedAt) {
    db.prepare('INSERT INTO announcements (body, author, program_id, pending, publish_at, sched_email) VALUES (?,?,?,1,?,?)')
      .run(body, author, programId, schedAt, req.body.email_everyone ? 1 : 0);
    audit(req.userEmail, g.admin ? 'admin' : 'host', `${cfg.logTag}:announce-scheduled`, `${schedAt} ${body.slice(0, 40)}`);
    armScheduleTimer();
    return res.redirect(base);
  }
  db.prepare('INSERT INTO announcements (body, author, program_id) VALUES (?,?,?)').run(body, author, programId);
  audit(req.userEmail, g.admin ? 'admin' : 'host', `${cfg.logTag}:announce`, body.slice(0, 60));
  setImmediate(() => sendPush(programMemberEmails(programId), { title: cfg.copy.annTitle, body: body.slice(0, 140), url: base, tag: `${cfg.logTag}ann` }));
  if (req.body.email_everyone && emailConfigured) {
    setImmediate(() => {
      try { const r = programEmailRecipients(programId); if (r.length) sendAnnouncement(r, body, author).catch(e => console.error(`[${cfg.logTag}-announce] email FAILED: ${e.message}`)); }
      catch (e) { console.error(`[${cfg.logTag}-announce] email prep FAILED: ${e.message}`); }
    });
  }
  res.redirect(base);
}
function runAnnounceRetract(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const cur = latestAnnouncementFor(programId);
  if (cur) { db.prepare('UPDATE announcements SET archived = 1 WHERE id = ? AND program_id = ?').run(cur.id, programId); audit(req.userEmail, g.admin ? 'admin' : 'host', `${cfg.logTag}:announce:retract`, String(cur.id)); }
  res.redirect(base);
}
// Kiosk link for the people who actually run the door (proposal #3): canOperate mints/rotates
// THEIR program's token from the run page — no admin round-trip, revocable per program.
function runKioskRotate(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  // The demo program has no kiosk (/kiosk/:pid refuses 90 by design) — minting a token for it
  // built a door the room refuses (2026-08-04 bug: 'Not found' on tap). No static tokens, ever.
  if (P(programId).config.static) return res.redirect(base);
  setSetting(`kiosk_token_${programId}`, crypto.randomBytes(12).toString('base64url'));
  audit(req.userEmail, g.admin ? 'admin' : 'host', 'kiosk:token-rotated', `program ${programId}`);
  res.redirect(base);
}
// Cancel a SCHEDULED post before it fires (P2-4 twin of /announce/cancel) — pending-only delete.
function runAnnounceCancel(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const id = Number(req.body.id);
  if (Number.isInteger(id) && id > 0) {
    const r = db.prepare('DELETE FROM announcements WHERE id = ? AND pending = 1 AND program_id = ?').run(id, programId);
    if (r.changes) audit(req.userEmail, g.admin ? 'admin' : 'host', `${cfg.logTag}:announce:cancel-scheduled`, String(id));
    armScheduleTimer();
  }
  res.redirect(base);
}
// Season-start gate control (operator). Sets/clears the season opener; before it, no weekly runs
// and nothing auto-fires. Clears rosters/state stranded in the gap (else the next rollover archives
// them as phantom season-board credits). Query flags stay pkset/pkerr (the GET run page reads them).
// Core shared by the run-page control AND the programs wizard (F6 follow-up): validate, write the
// gate, clean the gap. '' clears the gate. Returns { ok: 'set'|'cleared'|'unchanged' } or { err }.
function applySeasonStart(programId, raw) {
  const cfg = P(programId).config;
  raw = String(raw || '').trim();
  const cur = getSetting(cfg.keys.seasonStart) || '';
  if (raw === cur) return { ok: 'unchanged' };
  if (!raw) { db.prepare('DELETE FROM app_settings WHERE key = ?').run(cfg.keys.seasonStart); return { ok: 'cleared' }; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || isNaN(new Date(raw + 'T12:00:00'))) return { err: 'seasonbad' };
  const today = ymdLocal();
  if (raw < today) return { err: 'seasonpast' };
  const maxD = new Date(); maxD.setFullYear(maxD.getFullYear() + 1);
  if (raw > ymdLocal(maxD)) return { err: 'seasonrange' };
  db.exec('BEGIN');
  try {
    setSetting(cfg.keys.seasonStart, raw);   // inside the txn (P3-7): a rollback of the gap-cleanup must not leave
                                             // the season set while stranded rosters survive → phantom attendance
    db.prepare('DELETE FROM checkins WHERE run_date > ? AND run_date < ? AND program_id = ?').run(today, raw, programId);
    db.prepare('DELETE FROM regular_optout WHERE run_date > ? AND run_date < ? AND program_id = ?').run(today, raw, programId);
    db.prepare('DELETE FROM run_state WHERE run_date > ? AND run_date < ? AND program_id = ?').run(today, raw, programId);
    db.prepare('DELETE FROM team_assignments WHERE run_date > ? AND run_date < ? AND program_id = ?').run(today, raw, programId);
    const setRd = getSetting(cfg.keys.runDate); if (setRd && setRd < raw) delSetting(cfg.keys.runDate);
    const setBase = getSetting(cfg.keys.runBase); if (setBase && setBase < raw) delSetting(cfg.keys.runBase);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); console.error(`[${cfg.logTag}-season] roster cleanup FAILED: ${e.message}`); throw e; }
  return { ok: 'set' };
}
function runSeasonSet(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return;
  if (!g.canOperate) return res.redirect(base);
  const raw = String(req.body.season || '').trim();
  const r = applySeasonStart(programId, raw);
  if (r.err) return res.redirect(base + '?pkerr=' + r.err);
  if (r.ok === 'unchanged') return res.redirect(base + (raw ? '?pkset=season' : '?pkset=seasonoff'));
  if (r.ok === 'cleared') { audit(req.userEmail, g.admin ? 'admin' : 'host', `${cfg.logTag}:season-clear`, ''); return res.redirect(base + '?pkset=seasonoff'); }
  audit(req.userEmail, g.admin ? 'admin' : 'host', `${cfg.logTag}:season-set`, raw);
  res.redirect(base + '?pkset=season');
}
// Season board (GET) — most runs this calendar year from attendance, member-gated (same bar as the
// run's chat). Program-generic: the copy (title/subtitle/emptyMsg) + theme all derive from the
// registry, so a new run needs no season handler — mountRunProgram registers this for it.
function runGetSeason(programId, req, res) {
  const g = programGate(programId, req, res); if (!g) return; // login + approved + 404 while hidden
  const me = req.userEmail, p = P(programId);
  if (!memberOf(programId, me)) return res.redirect(p.paths.run); // members only — open the run to join first
  const rows = db.prepare(`SELECT at.email, COUNT(*) n, ap.full_name FROM attendance at
    LEFT JOIN applicants ap ON ap.email = at.email
    WHERE at.program_id = ? AND at.run_date >= strftime('%Y-01-01','now') AND at.email NOT LIKE '%@guest.local'
    GROUP BY at.email ORDER BY n DESC, at.email ASC`).all(programId);
  const named = rows.map((r, i) => ({ rank: i + 1, name: r.full_name || 'Member', n: r.n, me: r.email.toLowerCase() === me.toLowerCase() }));
  const a = applicantByEmail(me), cc = p.unread(me, a ? a.id : 0);
  res.send(seasonPage({
    rows: named, email: me, program: programId, theme: p.config.theme,
    title: `${p.displayName} Season`, subtitle: `Most ${p.key} runs this calendar year ${p.emoji}`,
    emptyMsg: `No ${p.key} runs logged yet this season — get out there ${p.emoji}`,
    dmUnread: unreadCount(me), groupUnread: cc.group, groupMention: cc.gm, ann: null,
  }));
}
// ---------- LADDER (2026-09-08): doubles results → season standings ----------
// Program-generic and feature-flagged (config.features.ladder). Everything below is a no-op for a
// program without the flag, and its routes 404 — a run that doesn't keep score never grows a board.
//
// The roster is NOT typed anywhere: the picker is tonight's CHECK-IN list (checkins while the run
// is live, attendance once it archives), so the people who tapped in are exactly the people who can
// be logged. Identity is the email throughout; names are resolved for display only.
// Audit actor role. requireLogin routes never get req.actorRole (only the admin/approver gates set
// it), and audit() binds it straight into SQLite — passing undefined throws mid-write. Same idiom
// the other run handlers use, extended with 'player' for the member-level action (nominate).
const ladderActor = (g, req) => req.actorRole || (g.admin ? 'admin' : (g.canOperate ? 'host' : 'player'));
const ladderTag = (programId) => P(programId).config.logTag || P(programId).key || 'run';
const ladderCfg = (programId) => (P(programId).config.features || {}).ladder || null;
// Basketball derives its run date from nextRunDate(); every generic program stores its own. Same
// split the kiosk route makes — one helper so a ladder on program 1 can never read the wrong night.
// THE NIGHT THE LADDER IS SCORING — deliberately NOT the check-in date.
// programRunDate rolls forward to next week the moment the run's end hour passes, which is right
// for check-in (sign-ups reopen that evening) and WRONG for scoring: a game logged at 8:05, or the
// sportsmanship vote taken while people pack up, belongs to the night that just finished. Reusing
// the check-in date stamped those onto NEXT week, made "undo the last game of tonight" a silent
// no-op after the final whistle, and left next week's first undo deleting this week's game.
// (Audit 2026-09-08 — pickleball ends at 20:00, so the bug opened exactly at the buzzer.)
// Rule: if today is a run day for this program, today IS the night. Otherwise use the scheduled
// date, which is what a mid-week look at the board should show.
function runNightFor(programId) {
  // Basketball predates the generic engine and keeps its date in nextRunDate(); every other program
  // stores its own. Getting this wrong doesn't error, it silently reads the WRONG NIGHT — which is
  // how teams and results end up on next week.
  const scheduled = Number(programId) === 1 ? nextRunDate() : programRunDate(programId);
  const today = ymdLocal(new Date(schedNow()));
  if (scheduled === today) return today;                 // run day, before the end hour
  const dow = (P(programId).config || {}).dow;
  const todayIsRunDay = dow != null && new Date(`${today}T12:00:00`).getDay() === Number(dow);
  return todayIsRunDay ? today : scheduled;
}
const ladderRunDate = runNightFor;   // the ladder's original name; same night, one implementation
// Is award voting open? The award is a season-END event, so the config default is closed — but
// opening it must NOT need a code edit and a restart on the last night of the season. The operator
// toggle writes ladder_noms_<pid>; absent, the program's config decides. Same shape as every other
// host-configurable setting in the app: config is the default, app_settings is the override.
const ladderNomsKey = (programId) => `ladder_noms_${Number(programId)}`;
function ladderNomsOpen(programId, cfg) {
  const v = getSetting(ladderNomsKey(programId));
  if (v === '1') return true;
  if (v === '0') return false;
  return (cfg || ladderCfg(programId) || {}).nominations !== false;
}
const LADDER_SCORE_MAX = 99;      // a typo like 111 is a mis-tap, not a game
const LADDER_NOTE_MAX = 140;      // one line under a name on the board

// The season the standings cover: the program's own season-start gate (the same app_settings key
// the season board reads) or, before one is set, the calendar year. Derived — never stored — so
// moving the season start re-cuts the board instead of leaving a stale copy behind.
function ladderFrom(programId) {
  const key = (P(programId).config.keys || {}).seasonStart || 'season_start';
  const s = getSetting(key);
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : `${ymdLocal(new Date(schedNow())).slice(0, 4)}-01-01`;
}
// Display names for a set of emails, best source first: the member's own profile, then the name the
// run recorded (guests have no applicant row), then the address. One query per source, not per
// player — a 20-person night must not become 20 round trips.
function ladderNames(programId, emails) {
  const out = new Map();
  const list = [...new Set(emails.map(lc).filter(Boolean))];
  if (!list.length) return out;
  const marks = list.map(() => '?').join(',');
  // The Planning Center roster first, and lowest priority. For a synced registrant it is the only
  // name the app ever sees (their address is a synthetic pco-<id>@adv.local), so without this pass
  // the leaderboard is a wall of slugs. Oldest first so the most recent sync's spelling wins.
  for (const r of db.prepare(`SELECT email, name FROM run_roster WHERE program_id = ? AND email IN (${marks}) ORDER BY synced_at ASC`).all(programId, ...list)) {
    if (r.name) out.set(lc(r.email), r.name);
  }
  // The ladder's own roster next — for a ladder-only player it is the ONLY source of a name, and
  // without it the board renders raw addresses. Everything after it overrides on purpose.
  for (const r of db.prepare(`SELECT email, name FROM ladder_players WHERE program_id = ? AND email IN (${marks})`).all(programId, ...list)) {
    if (r.name) out.set(lc(r.email), r.name);
  }
  for (const r of db.prepare(`SELECT email, name FROM attendance WHERE program_id = ? AND email IN (${marks})`).all(programId, ...list)) {
    if (r.name) out.set(lc(r.email), r.name);
  }
  for (const r of db.prepare(`SELECT email, name FROM checkins WHERE program_id = ? AND email IN (${marks})`).all(programId, ...list)) {
    if (r.name) out.set(lc(r.email), r.name);
  }
  for (const r of db.prepare(`SELECT email, full_name FROM applicants WHERE email IN (${marks})`).all(...list)) {
    if (r.full_name) out.set(lc(r.email), r.full_name);   // profile wins: it's the one the member edits
  }
  for (const e of list) if (!out.has(e)) out.set(e, e.split('@')[0]);
  return out;
}
// Who the picker offers. THE ROSTER IS NOT DERIVABLE for a run the church signs up in Planning
// Center: PCO Check-Ins needs a Check-Ins grant this account doesn't have, and this app's own
// checkins/attendance stay empty while nobody signs up here. So ladder_players is the durable
// source — typed once, kept for the season — and everything the app DOES know is unioned on top:
//   · ladder_players (not retired)          the entered roster
//   · checkins for this run date            in-app sign-ups, when the run uses them
//   · attendance for this run date          the same list once the night archives
//   · anyone already in a game tonight      so an undo-and-relog always has its players
// `here` marks the last two: the people the app can prove are at tonight's run, sorted first.
function ladderRoster(programId, rd) {
  const seen = new Map();
  const add = (email, name, here) => {
    const e = lc(email); if (!e) return;
    const cur = seen.get(e);
    if (cur) { if (here) cur.here = true; if (name && !cur.name) cur.name = name; return; }
    seen.set(e, { email: e, name: name || '', here: !!here });
  };
  for (const r of db.prepare('SELECT email, name FROM ladder_players WHERE program_id = ? AND retired_at IS NULL').all(programId)) add(r.email, r.name, false);
  for (const r of db.prepare('SELECT email, name FROM checkins WHERE program_id = ? AND run_date = ?').all(programId, rd)) add(r.email, r.name, true);
  for (const r of db.prepare('SELECT email, name FROM attendance WHERE program_id = ? AND run_date = ?').all(programId, rd)) add(r.email, r.name, true);
  for (const g of db.prepare('SELECT w1,w2,l1,l2 FROM ladder_games WHERE program_id = ? AND run_date = ?').all(programId, rd)) {
    for (const e of [g.w1, g.w2, g.l1, g.l2]) add(e, '', true);
  }
  // ONE name per person, from ONE resolver. The picker used to take the first name it happened to
  // read (the roster row) while the board took ladderNames (where the member's own profile wins), so
  // the same person could sit in the picker as "Daniel Cheer" and on the projector as "daniel".
  // ladderNames is the single source of a display name; the row name is only its fallback.
  const names = ladderNames(programId, [...seen.keys()]);
  return [...seen.values()]
    .map(p => ({ ...p, name: names.get(p.email) || p.name || p.email }))
    .sort((a, b) => (b.here - a.here) || a.name.localeCompare(b.name));
}
// A ladder-only player gets a synthetic address in the app's existing @*.local family, so every
// query, export and rekey treats them like anyone else while nothing can ever push them into the
// church's directory. Collisions get a numeric suffix — two Daniels are two players.
function ladderMintEmail(programId, name) {
  const base = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'player';
  const taken = (e) => !!db.prepare('SELECT 1 FROM ladder_players WHERE program_id = ? AND email = ?').get(programId, e);
  let e = `${base}@ladder.local`;
  for (let n = 2; taken(e) && n < 100; n++) e = `${base}-${n}@ladder.local`;
  return e;
}
// The board itself. Wins first, then POINT DIFFERENTIAL, then win rate, then name — the owner's
// rule (2026-09-08): "wins then differential". PD is summed from the stored scores every time, so
// an undone game leaves nothing behind.
function ladderStandings(programId, from) {
  const games = db.prepare(
    'SELECT * FROM ladder_games WHERE program_id = ? AND run_date >= ? ORDER BY id DESC').all(programId, from);
  const names = ladderNames(programId, games.flatMap(g => [g.w1, g.w2, g.l1, g.l2]));
  const nm = (e) => names.get(lc(e)) || lc(e);
  // ONE standings table: the PERSON. Partners rotate all night at an open gym, so a per-pairing
  // table was twenty duos with one game each — noise on a projector, and it split a player's record
  // across every partner they had. (Owner, 2026-09-08: "the only thing that matters is individual
  // points".) Pairs are still shown in the games log below, where they're a fact about the game
  // rather than a standings line of their own.
  const players = new Map(), nights = new Set();
  const seat = (key, label) => {
    let row = players.get(key);
    if (!row) { row = { key, label, w: 0, l: 0, pf: 0, pa: 0 }; players.set(key, row); }
    return row;
  };
  const duoLabel = (a, b) => [nm(a), nm(b)].sort((x, y) => x.localeCompare(y));
  for (const g of games) {
    nights.add(g.run_date);
    for (const e of [g.w1, g.w2]) { const p = seat(lc(e), nm(e)); p.w++; p.pf += g.w_score; p.pa += g.l_score; }
    for (const e of [g.l1, g.l2]) { const p = seat(lc(e), nm(e)); p.l++; p.pf += g.l_score; p.pa += g.w_score; }
  }
  const rank = (a, b) => {
    if (b.w !== a.w) return b.w - a.w;
    const da = a.pf - a.pa, dbb = b.pf - b.pa;
    if (dbb !== da) return dbb - da;
    const ra = a.w / (a.w + a.l || 1), rb = b.w / (b.w + b.l || 1);
    if (rb !== ra) return rb - ra;
    return String(a.label).localeCompare(String(b.label));
  };
  const fin = (r) => ({ ...r, pd: r.pf - r.pa, played: r.w + r.l });
  return {
    from,
    players: [...players.values()].map(fin).sort(rank),
    nights: nights.size,
    games: games.map(g => ({
      id: g.id, runDate: g.run_date, at: g.created_at,
      winners: duoLabel(g.w1, g.w2), losers: duoLabel(g.l1, g.l2),
      ws: g.w_score, ls: g.l_score,
    })),
  };
}
// Sportsmanship award tally — one nomination per voter per night, so the count IS the number of
// people who named them (never one enthusiastic voter ten times).
function ladderNominations(programId, from) {
  const rows = db.prepare(
    `SELECT email, note, at FROM ladder_nominations
      WHERE program_id = ? AND run_date >= ? ORDER BY at DESC`).all(programId, from);
  const names = ladderNames(programId, rows.map(r => r.email));
  const tally = new Map();
  for (const r of rows) {
    const e = lc(r.email);
    let row = tally.get(e);
    if (!row) { row = { email: e, name: names.get(e) || e, n: 0, note: '' }; tally.set(e, row); }
    row.n++;
    if (!row.note && r.note) row.note = r.note;   // the most recent reason, not a wall of them
  }
  return [...tally.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}
// Who may record a result: operators always; every member on tonight's roster when the program's
// config says features.ladder.log === 'players'.
function ladderCanLog(programId, cfg, gate, email, roster) {
  if (gate.canOperate) return true;
  if (cfg.log !== 'players') return false;
  // Being on tonight's roster is not enough: a guest or a lapsed member can appear there. Writing to
  // the program's record requires membership OF the program, same bar as nominate.
  if (!memberOf(programId, email)) return false;
  return roster.some(p => p.email === lc(email));
}
function runLadderGet(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), me = req.userEmail;
  if (!programJoinedBy(programId, me) && !g.canOperate) return res.redirect(p.paths.run);
  const rd = ladderRunDate(programId);
  const roster = ladderRoster(programId, rd);
  const from = ladderFrom(programId);
  const a = applicantByEmail(me), cc = p.unread(me, a ? a.id : 0);
  res.send(ladderPage({
    program: programId, theme: p.config.theme || '', emoji: p.emoji, sport: p.displayName,
    title: `${p.displayName} Ladder`, award: cfg.award || 'Sportsmanship',
    email: me, runDate: rd, dateLabel: runLabelFor(rd), seasonFrom: from,
    roster, standings: ladderStandings(programId, from), noms: ladderNominations(programId, from),
    canLog: ladderCanLog(programId, cfg, g, me, roster), canOperate: g.canOperate,
    canSync: !!(cfg.pcoGroup && pcoConnected()),
    nominationsOpen: ladderNomsOpen(programId, cfg),
    headcounts: headcountSeason(programId, from),
    headcountToday: (db.prepare('SELECT n FROM run_headcount WHERE program_id = ? AND run_date = ?').get(programId, rd) || {}).n,
    pointsTo: Number(cfg.pointsTo) || 11, basePath: p.paths.run,
    kioskUrl: g.canOperate && getSetting(`kiosk_token_${programId}`)
      ? `/kiosk/${programId}/ladder?k=${getSetting(`kiosk_token_${programId}`)}` : '',
    msg: String(req.query.msg || ''), err: String(req.query.err || ''),
    dmUnread: unreadCount(me), groupUnread: cc.group, groupMention: cc.gm,
  }));
}
// Record one game. Rejects anything the board could not honestly display: a player twice, someone
// who wasn't on tonight's roster, a non-integer or out-of-range score, or a "winner" who scored
// fewer points than the loser (the single most likely mis-tap at the court).
function runLadderLog(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`;
  const rd = ladderRunDate(programId);
  const roster = ladderRoster(programId, rd);
  if (!ladderCanLog(programId, cfg, g, req.userEmail, roster)) return res.redirect(back);
  const bad = (m) => res.redirect(`${back}?err=${encodeURIComponent(m)}`);
  const picked = ['w1', 'w2', 'l1', 'l2'].map(k => lc(String(req.body[k] || '').trim()));
  if (picked.some(e => !e)) return bad('Pick two winners and two losers.');
  if (new Set(picked).size !== 4) return bad('Nobody can play on both sides of the same game.');
  const known = new Set(roster.map(r => r.email));
  if (picked.some(e => !known.has(e))) return bad('Everyone in a game has to be on the roster — add them first.');
  const ws = Number(req.body.w_score), ls = Number(req.body.l_score);
  if (!Number.isInteger(ws) || !Number.isInteger(ls) || ws < 0 || ls < 0 || ws > LADDER_SCORE_MAX || ls > LADDER_SCORE_MAX) {
    return bad('Scores have to be whole numbers.');
  }
  if (ls >= ws) return bad("The winners' score has to be the higher one.");
  const [w1, w2] = [picked[0], picked[1]].sort();
  const [l1, l2] = [picked[2], picked[3]].sort();
  // Idempotency window. A POST with no idempotency key + a phone that double-fires the tap = two
  // identical rows, and nothing downstream can tell the phantom from a real rematch. The SAME four
  // people cannot genuinely replay the SAME scoreline within seconds — a game to 11 takes minutes —
  // so an exact repeat inside 20s is the double-tap, and it answers as the success it looks like.
  const dupe = db.prepare(`SELECT id FROM ladder_games
     WHERE program_id=? AND run_date=? AND w1=? AND w2=? AND l1=? AND l2=? AND w_score=? AND l_score=?
       AND created_at >= datetime('now', '-20 seconds')`).get(programId, rd, w1, w2, l1, l2, ws, ls);
  if (dupe) return res.redirect(`${back}?msg=${encodeURIComponent(`Logged ${ws}–${ls}.`)}`);
  db.prepare(`INSERT INTO ladder_games (program_id, run_date, w1, w2, l1, l2, w_score, l_score, logged_by)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(programId, rd, w1, w2, l1, l2, ws, ls, lc(req.userEmail));
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:log`, `${w1}+${w2} def ${l1}+${l2} ${ws}-${ls}`);
  res.redirect(`${back}?msg=${encodeURIComponent(`Logged ${ws}–${ls}.`)}`);
}
// Undo the last game of THIS run date. Scoped to the night on purpose: a mis-tap is corrected at
// the court, and nobody should be able to quietly rewrite an earlier week from tonight's screen.
function runLadderUndo(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`, rd = ladderRunDate(programId);
  const last = db.prepare(
    'SELECT * FROM ladder_games WHERE program_id = ? AND run_date = ? ORDER BY id DESC LIMIT 1').get(programId, rd);
  if (!last) return res.redirect(back);
  // A player-logger can take back their OWN last game; anything else is an operator call.
  if (!g.canOperate && lc(last.logged_by) !== lc(req.userEmail)) return res.redirect(back);
  db.prepare('DELETE FROM ladder_games WHERE id = ?').run(last.id);
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:undo`,
    `${last.w1}+${last.w2} def ${last.l1}+${last.l2} ${last.w_score}-${last.l_score}`);
  res.redirect(`${back}?msg=${encodeURIComponent('Game removed.')}`);
}
// Add a player to the ladder's own roster — the one-time typing that replaces re-entering names
// every week. An operator may attach a real member (their address, so the ladder and their profile
// are one identity) or just a name (synthetic @ladder.local). Re-adding a retired player revives
// them with their record intact.
function runLadderAdd(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`;
  if (!g.canOperate) return res.redirect(back);
  const bad = (m) => res.redirect(`${back}?err=${encodeURIComponent(m)}`);
  const name = String(req.body.name || '').trim().slice(0, 60);
  const typed = lc(String(req.body.email || '').trim());
  if (!name && !typed) return bad('Give the player a name.');
  // An address that belongs to a member links the two; anything else is ladder-only.
  const member = typed ? applicantByEmail(typed) : null;
  if (typed && !member && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(typed)) return bad("That doesn't look like an email address.");
  // Re-adding a name that is already on the roster REVIVES that player instead of minting a second
  // identity. Without this, "add Ann Ace" twice quietly splits one person's record in half — and
  // re-adding someone who was retired is exactly how a player comes back.
  // Re-adding a RETIRED player by name revives them (that is how someone comes back). But an ACTIVE
  // player with that name is a different question: two real people can share a name, and silently
  // folding them into one identity would merge two season records with no way back. Refuse, and say
  // how to tell them apart.
  const sameName = !typed && db.prepare(
    'SELECT email, retired_at FROM ladder_players WHERE program_id = ? AND lower(name) = lower(?)').get(programId, name);
  if (sameName && !sameName.retired_at) {
    return bad(`${name} is already on the roster. If this is a different person, add them with their email address.`);
  }
  const email = typed || (sameName ? sameName.email : ladderMintEmail(programId, name));
  const label = name || (member ? member.full_name : typed.split('@')[0]);
  const existing = db.prepare('SELECT * FROM ladder_players WHERE program_id = ? AND email = ?').get(programId, email);
  if (existing) {
    db.prepare('UPDATE ladder_players SET name = ?, retired_at = NULL WHERE program_id = ? AND email = ?').run(label, programId, email);
  } else {
    db.prepare('INSERT INTO ladder_players (program_id, email, name, added_by) VALUES (?,?,?,?)').run(programId, email, label, lc(req.userEmail));
  }
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:player-add`, email);
  res.redirect(`${back}?msg=${encodeURIComponent(`${label} added.`)}`);
}
// Pull the roster from the program's Planning Center group. This is the answer to "I don't want to
// type": Groups is readable with the church's ordinary member permissions, so the picker can fill
// itself. ADDITIVE ONLY — a person who left the PCO group is left alone rather than retired, because
// the group is a membership list and the ladder is a record of who plays; the two drift for good
// reasons (a guest who never joined, someone who left the group mid-season with games on the board).
async function runLadderSync(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`;
  if (!g.canOperate) return res.redirect(back);
  if (!cfg.pcoGroup) return res.redirect(`${back}?err=${encodeURIComponent('No Planning Center group is configured for this ladder.')}`);
  let people;
  try {
    people = await pcoGroupRoster(cfg.pcoGroup);
  } catch (e) {
    audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:sync-failed`, String(e.message).slice(0, 120));
    return res.redirect(`${back}?err=${encodeURIComponent('Planning Center: ' + String(e.message).slice(0, 90))}`);
  }
  const existing = new Set(db.prepare('SELECT email FROM ladder_players WHERE program_id = ?').all(programId).map(r => lc(r.email)));
  const ins = db.prepare(`INSERT INTO ladder_players (program_id, email, name, added_by) VALUES (?,?,?,?)
    ON CONFLICT(program_id, email) DO UPDATE SET
      name = CASE WHEN ladder_players.added_by LIKE 'pco:%' THEN excluded.name ELSE ladder_players.name END`);
  let added = 0, updated = 0, skipped = 0;
  transact(() => {
    for (const person of people) {
      if (!person.email) { skipped++; continue; }   // no address in PCO = no identity for the ladder
      if (existing.has(lc(person.email))) updated++; else added++;
      ins.run(programId, lc(person.email), person.name, `pco:group:${cfg.pcoGroup}`);
    }
  });
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:sync`, `+${added} new, ${updated} refreshed, ${skipped} skipped`);
  const msg = `Roster synced from Planning Center — ${added} added, ${updated} already on it` +
    (skipped ? `, ${skipped} skipped (no email in Planning Center)` : '') + '.';
  res.redirect(`${back}?msg=${encodeURIComponent(msg)}`);
}
// Headcount for a night. Program-generic (any run can use it, ladder or not) — the ladder page is
// simply where the operator already is at 8 PM. Reads back the whole season so the number has a
// denominator: a single "12" is trivia, "12, 9, 14 over three nights" is a decision.
const HEADCOUNT_MAX = 500;                    // a typo like 1200 is a mis-tap, not a gym
function headcountSeason(programId, from) {
  return db.prepare(
    'SELECT run_date, n FROM run_headcount WHERE program_id = ? AND run_date >= ? ORDER BY run_date DESC')
    .all(programId, from);
}
function runHeadcountSet(programId, req, res) {
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`;
  if (!g.canOperate) return res.redirect(back);
  const rd = ladderRunDate(programId);
  const raw = String(req.body.n ?? '').trim();
  // Empty CLEARS the night — the way to undo a mis-typed count without leaving a wrong number up.
  if (raw === '') {
    db.prepare('DELETE FROM run_headcount WHERE program_id = ? AND run_date = ?').run(programId, rd);
    audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:headcount`, `${rd} cleared`);
    return res.redirect(`${back}?msg=${encodeURIComponent('Headcount cleared.')}`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > HEADCOUNT_MAX) {
    return res.redirect(`${back}?err=${encodeURIComponent('Headcount has to be a whole number.')}`);
  }
  db.prepare(`INSERT INTO run_headcount (program_id, run_date, n, noted_by) VALUES (?,?,?,?)
              ON CONFLICT(program_id, run_date) DO UPDATE SET n = excluded.n, noted_by = excluded.noted_by, at = datetime('now')`)
    .run(programId, rd, n, lc(req.userEmail));
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:headcount`, `${rd} = ${n}`);
  res.redirect(`${back}?msg=${encodeURIComponent(`${n} in the gym on ${runLabelFor(rd)} — logged.`)}`);
}
// Merge two roster rows that are the SAME human. The ladder is a second identity space — it holds
// people who have no app account — so the same person arrives twice as a matter of course: typed in
// as a walk-in one week ("Vincent"), then pulled from Planning Center the next ("Vincent Kua").
// Nothing upstream can prevent it, so the operator gets the repair rather than a duplicate that
// splits one person's record across two lines of the standings forever.
function runLadderMerge(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`;
  if (!g.canOperate) return res.redirect(back);
  const bad = (m) => res.redirect(`${back}?err=${encodeURIComponent(m)}`);
  const from = lc(String(req.body.from || '').trim()), into = lc(String(req.body.into || '').trim());
  if (!from || !into) return bad('Pick both players to merge.');
  if (from === into) return bad('Those are the same roster entry.');
  const rowFrom = db.prepare('SELECT * FROM ladder_players WHERE program_id = ? AND email = ?').get(programId, from);
  const rowInto = db.prepare('SELECT * FROM ladder_players WHERE program_id = ? AND email = ?').get(programId, into);
  if (!rowFrom || !rowInto) return bad('Both players have to be on this roster.');
  // A game with BOTH identities in it cannot be one person playing twice — it means a seat was
  // mis-picked on that night. Merging would silently collapse it into a corrupt 3-player row, so it
  // is refused with the nights named: the operator fixes those games, then merges.
  const clash = db.prepare(`SELECT DISTINCT run_date FROM ladder_games WHERE program_id = ?
      AND (w1=? OR w2=? OR l1=? OR l2=?)
      AND (w1=? OR w2=? OR l1=? OR l2=?)
      ORDER BY run_date`)
    .all(programId, from, from, from, from, into, into, into, into).map(r => r.run_date);
  if (clash.length) return bad(`${rowFrom.name} and ${rowInto.name} are both in the same game on ${clash.join(', ')} — fix those results first, then merge.`);
  transact(() => {
    for (const col of ['w1', 'w2', 'l1', 'l2'])
      db.prepare(`UPDATE ladder_games SET ${col} = ? WHERE program_id = ? AND ${col} = ?`).run(into, programId, from);
    // Nominations key on (program, night, voter): OR REPLACE drops the duplicate vote rather than
    // throwing and rolling the whole merge back.
    db.prepare('UPDATE OR REPLACE ladder_nominations SET email = ? WHERE program_id = ? AND email = ?').run(into, programId, from);
    db.prepare('UPDATE OR REPLACE ladder_nominations SET voter = ? WHERE program_id = ? AND voter = ?').run(into, programId, from);
    db.prepare('DELETE FROM ladder_players WHERE program_id = ? AND email = ?').run(programId, from);
    // A merge INTO a retired row would hide the surviving player: they just proved they still play.
    db.prepare('UPDATE ladder_players SET retired_at = NULL WHERE program_id = ? AND email = ?').run(programId, into);
  });
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:merge`, `${from} -> ${into}`);
  res.redirect(`${back}?msg=${encodeURIComponent(`${rowFrom.name} merged into ${rowInto.name} — one line on the board now.`)}`);
}
// PII purge for a hard-deleted person, called from the people-delete cascade.
//
// The tension: a hard delete must leave no trace of the person, but a ladder GAME is a SHARED
// record — three other people's results sit in the same row, and deleting it would silently rewrite
// their standings (the same reason retire never deletes). So their seats are rekeyed onto a
// per-person tombstone that carries no address and no name, and everyone else's history survives
// untouched. Their roster row and their votes (cast and received) are deleted outright.
function purgeLadderIdentity(email) {
  const e = lc(email);
  if (!e) return;
  const seats = db.prepare(
    'SELECT DISTINCT program_id FROM ladder_games WHERE w1=? OR w2=? OR l1=? OR l2=?').all(e, e, e, e);
  if (seats.length) {
    // One tombstone per PERSON, not per delete-of-the-same-address and not shared between people:
    // a shared address would merge two deleted players into one duo on the board.
    const tomb = `former-${crypto.randomBytes(4).toString('hex')}@ladder.local`;
    for (const col of ['w1', 'w2', 'l1', 'l2'])
      db.prepare(`UPDATE ladder_games SET ${col} = ? WHERE ${col} = ?`).run(tomb, e);
    for (const { program_id } of seats)
      db.prepare(`INSERT OR IGNORE INTO ladder_players (program_id, email, name, added_by, retired_at)
                  VALUES (?,?,?,?,datetime('now'))`).run(program_id, tomb, 'Former player', 'system:delete');
  }
  db.prepare('DELETE FROM ladder_players WHERE email = ?').run(e);
  db.prepare('DELETE FROM ladder_nominations WHERE email = ? OR voter = ?').run(e, e);
}
// Retire a player from the picker. Their games STAY — the standings are summed from results, and
// deleting a person would silently rewrite finished nights.
function runLadderRetire(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`;
  if (!g.canOperate) return res.redirect(back);
  const email = lc(String(req.body.email || '').trim());
  const row = db.prepare('SELECT * FROM ladder_players WHERE program_id = ? AND email = ?').get(programId, email);
  if (!row) return res.redirect(back);
  db.prepare("UPDATE ladder_players SET retired_at = datetime('now') WHERE program_id = ? AND email = ?").run(programId, email);
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:player-retire`, email);
  res.redirect(`${back}?msg=${encodeURIComponent(`${row.name} taken off the roster — their results stay.`)}`);
}
// Open or close award voting — the operator's one tap in the final weeks of the season. Writes the
// override ladder_noms_<pid>; clearing it would fall back to config, so both states are stored
// explicitly and the button always says what the next tap does.
function runLadderVoting(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`;
  if (!g.canOperate) return res.redirect(back);
  const open = String(req.body.open || '') === '1';
  setSetting(ladderNomsKey(programId), open ? '1' : '0');
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:voting`, open ? 'opened' : 'closed');
  res.redirect(`${back}?msg=${encodeURIComponent(open
    ? `${cfg.award || 'Sportsmanship'} voting is open — everyone gets one pick.`
    : 'Award voting closed.')}`);
}
// Nominate someone for the sportsmanship award. ANY member votes (that's the point of the award);
// one pick per person per night, replaceable.
function runLadderNominate(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`, me = lc(req.userEmail);
  if (!programJoinedBy(programId, me) && !g.canOperate) return res.redirect(p.paths.run);
  // Voting is a season-END event, not a running tally: the form is hidden while voting is closed,
  // and the handler refuses too — a hidden form is a UI state, not a permission.
  if (!ladderNomsOpen(programId, cfg)) return res.redirect(`${back}?err=${encodeURIComponent('Award voting opens at the end of the season.')}`);
  // A suspended member keeps their login but loses the floor; they do not get to publish a note on
  // the board either (the other member-level surfaces check this; this one did not).
  if (g.a && g.a.status !== 'approved' && !g.admin) return res.redirect(back);
  const rd = ladderRunDate(programId);
  const who = lc(String(req.body.email || '').trim());
  const roster = ladderRoster(programId, rd);
  if (!roster.some(r => r.email === who)) return res.redirect(`${back}?err=${encodeURIComponent('Pick someone who played tonight.')}`);
  if (who === me && !g.canOperate) return res.redirect(`${back}?err=${encodeURIComponent('Nominate someone else.')}`);
  const note = String(req.body.note || '').trim().slice(0, LADDER_NOTE_MAX);
  db.prepare(`INSERT OR REPLACE INTO ladder_nominations (program_id, run_date, email, voter, note)
              VALUES (?,?,?,?,?)`).run(programId, rd, who, me, note);
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:nominate`, who);
  res.redirect(`${back}?msg=${encodeURIComponent('Nomination in.')}`);
}
// A run moved AFTER games were logged: results are keyed by the night's date, so leaving them on the
// old date empties tonight's board and makes "undo the last game" a silent no-op — the same class of
// bug the ladderRunDate fix closed, reached from the other direction. Nominations carry a
// (program, run_date, voter) PK, so UPDATE OR REPLACE drops a vote already cast on the destination
// date instead of throwing and rolling the whole move back.
function migrateLadderNight(programId, oldRd, newRd) {
  if (!oldRd || !newRd || oldRd === newRd) return;
  db.prepare('UPDATE ladder_games SET run_date = ? WHERE run_date = ? AND program_id = ?').run(newRd, oldRd, programId);
  db.prepare('UPDATE OR REPLACE ladder_nominations SET run_date = ? WHERE run_date = ? AND program_id = ?').run(newRd, oldRd, programId);
}
// Operator moves this week's run to another date, or clears back to the standing day. Migrates the
// roster + state + once-per-cycle markers to the new date (else it's stranded → phantom attendance),
// and records the consumed standing day as the base of the cycle being MOVED (see the comment below).
function runDate(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const d = String(req.body.date || '').trim();
  const oldRd = programRunDate(programId);
  // autoping is NOT blind-carried — it pairs with the confirm sweep (migrateConfirmMarkers below):
  // carrying it while the sweep marker re-arms would sweep the moved day UNPINGED (P1).
  const markerKeys = [cfg.keys.autoopen, cfg.keys.autolock];
  if (!d) {   // clear → back to the weekly standing day
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM app_settings WHERE key IN (?, ?)').run(cfg.keys.runDate, cfg.keys.runBase);
      const newRd = programDefaultDate(programId);   // the reverted standing day (settings now cleared)
      if (newRd !== oldRd) {
        db.prepare('UPDATE checkins SET run_date = ? WHERE run_date = ? AND program_id = ?').run(newRd, oldRd, programId);
        db.prepare('UPDATE OR IGNORE regular_optout SET run_date = ? WHERE run_date = ? AND program_id = ?').run(newRd, oldRd, programId);
        db.prepare('UPDATE signup_groups SET run_date = ? WHERE run_date = ? AND program_id = ?').run(newRd, oldRd, programId); // parties follow the run (Phase 6b)
        migrateLadderNight(programId, oldRd, newRd);   // tonight's results follow the night
        const st = db.prepare('SELECT is_open, cancelled FROM run_state WHERE run_date = ? AND program_id = ?').get(oldRd, programId);
        if (st) {
          db.prepare("INSERT INTO run_state (run_date, is_open, cancelled, program_id) VALUES (?,?,?,?) ON CONFLICT(run_date, program_id) DO UPDATE SET is_open = excluded.is_open, cancelled = excluded.cancelled").run(newRd, st.is_open, st.cancelled, programId);
          db.prepare('DELETE FROM run_state WHERE run_date = ? AND program_id = ?').run(oldRd, programId);
        }
        for (const k of markerKeys) if (getSetting(k) === oldRd) setSetting(k, newRd);
        migrateConfirmMarkers(newRd, effectiveConfirmCutoff(cfg.confirmCutoff), cfg.keys.autoping, cfg.keys.confirmsweep);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); console.error(`[${cfg.logTag}-date] clear FAILED: ${e.message}`); throw e; }
    return res.redirect(base + '?pkset=date');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(d + 'T12:00:00'))) return res.redirect(base + '?pkerr=datebad');
  const today = ymdLocal();
  if (d < today || (d === today && minutesOfDay(new Date()) >= endMinutesOf(cfg))) return res.redirect(base + '?pkerr=datepast'); // no past / already-ended today
  const maxD = new Date(); maxD.setDate(maxD.getDate() + 60);
  if (d > ymdLocal(maxD)) return res.redirect(base + '?pkerr=daterange');
  if (d !== oldRd) {
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE checkins SET run_date = ? WHERE run_date = ? AND program_id = ?').run(d, oldRd, programId);
      db.prepare('UPDATE OR IGNORE regular_optout SET run_date = ? WHERE run_date = ? AND program_id = ?').run(d, oldRd, programId);
      db.prepare('UPDATE signup_groups SET run_date = ? WHERE run_date = ? AND program_id = ?').run(d, oldRd, programId); // parties follow the run (Phase 6b)
      migrateLadderNight(programId, oldRd, d);   // tonight's results follow the night
      const st = db.prepare('SELECT is_open, cancelled FROM run_state WHERE run_date = ? AND program_id = ?').get(oldRd, programId);
      if (st) {
        db.prepare("INSERT INTO run_state (run_date, is_open, cancelled, program_id) VALUES (?,?,?,?) ON CONFLICT(run_date, program_id) DO UPDATE SET is_open = excluded.is_open, cancelled = excluded.cancelled").run(d, st.is_open, st.cancelled, programId);
        db.prepare('DELETE FROM run_state WHERE run_date = ? AND program_id = ?').run(oldRd, programId);
      }
      for (const k of markerKeys) if (getSetting(k) === oldRd) setSetting(k, d);
      migrateConfirmMarkers(d, effectiveConfirmCutoff(cfg.confirmCutoff), cfg.keys.autoping, cfg.keys.confirmsweep);
      setSetting(cfg.keys.runDate, d);
      // The consumed standing day is the base of the cycle being MOVED — never the day nearest the
      // destination. Keying off `d` breaks when the run moves to a day AFTER its standing day (marks
      // the NEXT week's run consumed → silently deleted). Once moved, the base is recorded — keep it.
      setSetting(cfg.keys.runBase, getSetting(cfg.keys.runBase) || pkNearestDow(oldRd, cfg.dow));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); console.error(`[${cfg.logTag}-date] move FAILED: ${e.message}`); throw e; }
  }
  res.redirect(base + '?pkset=date');
}
function runGuest(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const rd = programRunDate(programId); if (runCancelledFor(programId, rd)) return res.redirect(base);
  const name = (req.body.name || '').trim().slice(0, 60);
  if (name) {
    // Double-tap guard: each guest gets a fresh random @guest.local email, so there's no UNIQUE to
    // catch a re-post — two taps would silently eat two floor spots.
    if (db.prepare("SELECT 1 FROM checkins WHERE run_date=? AND name=? AND program_id = ? AND created_at > datetime('now','-5 seconds')").get(rd, name + ' (guest)', programId))
      return res.redirect(base);
    const { rows } = partitionFor(programId, rd);
    if (rows.length < cfg.cap + cfg.waitlist) {
      const em = `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@guest.local`;
      db.prepare('INSERT INTO checkins (run_date, email, name, program_id) VALUES (?,?,?,?)').run(rd, em, name + ' (guest)', programId);
    }
  }
  res.redirect(base);
}
// The run page (GET). Non-members see the join prompt; members see the roster + controls. Offer-
// window programs use the offer partition shape (floorReal / offered / waitPlayers) so held offers
// render; simple programs use floor / wait. All presentation values come from config + the registry.
function runGetPage(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config, prog = P(programId);
  const g = programGate(programId, req, res); if (!g) return;
  if (!memberOf(programId, req.userEmail)) {   // not a member yet → opt-in join prompt (Chat tab reflects joined runs, or locks)
    const me = req.userEmail, mid = applicantIdOf(me);
    const cp = chatProgramFor(req), cc = chatCountsFor(cp || 1, me, mid);
    // joinMode drives the prompt: open → Join button; invite → explanation, no button;
    // host → Request button, or "request sent" once a pending row exists.
    const requested = !!db.prepare("SELECT 1 FROM program_membership WHERE program_id = ? AND email = ? AND status = 'pending'").get(programId, me);
    return res.send(runJoinPage({ email: me, runDate: programRunDate(programId), runLabel: runLabelFor(programRunDate(programId)),
      dmUnread: unreadCount(me), groupUnread: cc.group, groupMention: cc.gm, chatProgram: cp, ann: null,
      runBase: base, theme: cfg.theme, sport: prog.displayName, sportEmoji: prog.emoji,
      joinMode: cfg.joinMode || 'open', requested }));
  }
  setRunCookie(req, res, programId);
  if (req.headers['x-prewarm'] !== '1') joinProgramMembership(programId, req.userEmail); // operators/host appear in the member list too
  ensureWeekFor(programId);
  const rd = programRunDate(programId), part = partitionFor(programId, rd);
  const floor = cfg.offerWindow ? part.floorReal : part.floor;
  const wait = cfg.offerWindow ? part.waitPlayers : part.wait;
  const offered = cfg.offerWindow ? part.offered : [];
  const mine = part.rows.find(p => p.email === req.userEmail);
  const myState = mine ? (floor.indexOf(mine) >= 0 ? 'in' : 'waitlist') : 'out';
  const myWaitPos = myState === 'waitlist' ? wait.findIndex(p => p.email === req.userEmail) + 1 : 0;
  const myConfirmed = myState === 'in' && !!(mine && mine.confirmed_at);
  const iAutoRenew = !!(stmtPmAutoRenew.get(programId, req.userEmail)?.auto_renew);
  const opener = programSeasonStart(programId), pre = !!opener && ymdLocal() < opener;
  res.send(runPage({
    email: req.userEmail, runDate: rd, runLabel: runLabelFor(rd), isOpen: runOpenFor(programId, rd), cancelled: runCancelledFor(programId, rd),
    hours: timeRangeFor(programId), startLabel: startLabelFor(programId),
    cap: cfg.cap, waitlistCap: cfg.waitlist, going: floor.length + offered.length, waiting: wait.length,
    canOperate: g.canOperate, isAdmin: g.admin, myState, myWaitPos, floorPlayers: floor, offeredPlayers: offered, waitPlayers: wait, hidden: !programActive(programId),
    myConfirmed, iAutoRenew,
    // F3: operators see + act on pending join requests right on the run page.
    pendingRequests: g.canOperate ? db.prepare(
      `SELECT pm.email, COALESCE(a.full_name, pm.email) AS name FROM program_membership pm
       LEFT JOIN applicants a ON a.email = pm.email
       WHERE pm.program_id = ? AND pm.status = 'pending' ORDER BY pm.joined_at`).all(programId) : [],
    confirmBy: effectiveConfirmCutoff(cfg.confirmCutoff) ? fmtClockLabel(cfg.confirmCutoff) : '',
    bannerSrc: bannerSrcFor(programId), bannerVer: bannerVersionFor(programId),
    tipoff: startEpochFor(programId, rd), announcement: latestAnnouncementFor(programId),
    // F8 management surface (P2-4): operators see + can cancel scheduled posts for THIS program.
    schedAnns: g.canOperate ? db.prepare(
      'SELECT id, body, publish_at FROM announcements WHERE program_id = ? AND pending = 1 ORDER BY publish_at').all(programId) : [],
    // Kiosk link for the door crew (proposal #3) — per-program token, host-mintable.
    // Never for the static demo program: /kiosk/:pid refuses 90 by design.
    kioskUrl: (g.canOperate && !cfg.static && getSetting(`kiosk_token_${programId}`)) ? `/kiosk/${programId}?k=${getSetting(`kiosk_token_${programId}`)}` : '',
    kioskable: g.canOperate && !cfg.static,
    season: opener || '', seasonWeekday: opener ? runWeekday(opener) : '', seasonLabel: opener ? runLabelFor(opener) : '',
    preseason: pre, today: ymdLocal(), seasonMax: shiftYmd(ymdLocal(), 365),
    pkMsg: req.query.pkset ? String(req.query.pkset) : (req.query.pkerr || ''),
    dmUnread: unreadCount(req.userEmail), groupUnread: chatUnreadFor(programId, req.userEmail), groupMention: chatMentionUnreadFor(programId, req.userEmail, g.a ? g.a.id : 0), ann: annPanel(req.userEmail),
    runBase: base, programId, theme: cfg.theme, sport: prog.displayName, sportEmoji: prog.emoji, dayName: DAY_NAMES[cfg.dow], pollKey: prog.key,
    teamsCfg: teamsFeature(programId), teamRows: teamsFeature(programId) ? runTeamsFor(programId, rd, part) : [], teamsOpen: teamsFeature(programId) ? teamsOpen(programId, rd) : false,
    penaltyState: g.canOperate ? penaltyStateFor(programId) : {},   // operator-only: {email: {strikes, until}} for the roster badge + forgive button
    partyData: cfg.static ? null : partyPanelFor(programId, rd, req.userEmail),   // queue-with-friends card (null unless groupQueue; the STATIC demo must never surface the admin's REAL party)
    partyMsg: req.query.partyfull ? 'full' : (req.query.partybig ? 'big' : ''),   // party check-in outcome notice (P3-4: the redirect params were silent)
    demoMode: !!cfg.static,                                         // demo run → control strip + per-offer claim button (operator only)
  }));
}

app.get('/pickleball', requireLogin, (req, res) => runGetPage(2, req, res));
// Pickleball season-start gate control (operator = admin) — mirrors /admin/season. Sets/clears
// app_settings 'pk_season_start'; before it, no weekly pickleball runs and nothing auto-fires.
app.post('/pickleball/season', requireLogin, (req, res) => runSeasonSet(2, req, res));
// Join the pickleball RUN (membership) — the opt-in from the join prompt. Distinct from the
// per-week check-in below. Adds a program_membership row, then lands on the run.
app.post('/pickleball/join-run', requireLogin, (req, res) => runJoinRun(2, req, res));
// "I'm coming" confirm — a floor player marks they're showing up (mirrors basketball).
app.post('/pickleball/confirm', requireLogin, (req, res) => runConfirm(2, req, res));
// Auto-renew toggle — a member opts their spot in/out of the weekly auto-add (self-service).
app.post('/pickleball/autorenew', requireLogin, (req, res) => runAutorenew(2, req, res));
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
    rows: named, email: me, program: 2, theme: 'pk',
    title: 'Pickleball Season', subtitle: 'Most pickleball runs this calendar year 🥒',
    emptyMsg: 'No pickleball runs logged yet this season — get out there 🥒',
    dmUnread: unreadCount(me), groupUnread: pkGroupUnread(me), groupMention: pkGroupMentionUnread(me, a ? a.id : 0), ann: null,
  }));
});
// Add the pickleball run to a calendar (.ics). Floating local time; 6–8 PM.
app.get('/pickleball/run.ics', requireLogin, (req, res) => runIcs(2, req, res));
app.post('/pickleball/join', requireLogin, (req, res) => runJoin(2, req, res));
app.post('/pickleball/leave', requireLogin, (req, res) => runLeave(2, req, res));
app.post('/pickleball/open', requireLogin, (req, res) => runOpen(2, req, res));
app.post('/pickleball/close', requireLogin, (req, res) => runClose(2, req, res));
app.post('/pickleball/cancel', requireLogin, (req, res) => runCancel(2, req, res));
app.post('/pickleball/date', requireLogin, (req, res) => runDate(2, req, res));
app.post('/pickleball/guest', requireLogin, (req, res) => runGuest(2, req, res));
app.post('/pickleball/remove', requireLogin, (req, res) => runRemove(2, req, res));
app.post('/pickleball/bump', requireLogin, (req, res) => runBump(2, req, res));
app.post('/pickleball/publish', requireAdmin, (req, res) => runPublish(2, req, res));
// Post a pickleball announcement — operator only. Stored in announcements (program 2)
// table, pushed to pickleball members' phones (and emailed if SMTP is set), separate from
// basketball announcements. Shown as a banner on the pickleball page.
app.post('/pickleball/announce', requireLogin, (req, res) => runAnnounce(2, req, res));
// Retract the current pickleball announcement — operator only. Archives it so it stops
// showing on the page (no new push/email; the original notification already went out).
app.post('/pickleball/announce/retract', requireLogin, (req, res) => runAnnounceRetract(2, req, res));
app.post('/pickleball/announce/cancel', requireLogin, (req, res) => runAnnounceCancel(2, req, res));
app.post('/pickleball/kiosk-rotate', requireLogin, (req, res) => runKioskRotate(2, req, res));
// Teams board for the advanced run — its roster comes from Planning Center, so the sync lives here
// too. Basketball's routes are written out rather than mounted by mountRunProgram (id < 3).
app.get('/checkin/teams', requireLogin, (req, res) => runTeamsBoard(1, req, res));
app.post('/checkin/roster-sync', requireLogin, (req, res) => runRosterSync(1, req, res));
app.post('/checkin/team/swap', requireLogin, (req, res) => runTeamSwap(1, req, res));
app.post('/checkin/team/bench', requireLogin, (req, res) => runTeamBench(1, req, res));
app.post('/checkin/teams/clear', requireLogin, (req, res) => runTeamsClear(1, req, res));
app.post('/checkin/game', requireLogin, (req, res) => runGameLog(1, req, res));
app.post('/checkin/game/undo', requireLogin, (req, res) => runGameUndo(1, req, res));
app.post('/checkin/game/merge', requireLogin, (req, res) => runGameMerge(1, req, res));
app.get('/checkin/leaderboard', requireLogin, (req, res) => runLeaderboard(1, req, res));
// Ladder — the season board the court screen shows. Same handlers mountRunProgram registers for
// every other program; pickleball just has its routes written out like the rest of its block.
app.get('/pickleball/ladder', requireLogin, (req, res) => runLadderGet(2, req, res));
app.post('/pickleball/ladder/log', requireLogin, (req, res) => runLadderLog(2, req, res));
app.post('/pickleball/ladder/undo', requireLogin, (req, res) => runLadderUndo(2, req, res));
app.post('/pickleball/ladder/nominate', requireLogin, (req, res) => runLadderNominate(2, req, res));
app.post('/pickleball/ladder/voting', requireLogin, (req, res) => runLadderVoting(2, req, res));
app.post('/pickleball/ladder/merge', requireLogin, (req, res) => runLadderMerge(2, req, res));
app.post('/pickleball/headcount', requireLogin, (req, res) => runHeadcountSet(2, req, res));
app.post('/pickleball/ladder/player', requireLogin, (req, res) => runLadderAdd(2, req, res));
app.post('/pickleball/ladder/retire', requireLogin, (req, res) => runLadderRetire(2, req, res));
app.post('/pickleball/ladder/sync', requireLogin, (req, res) => runLadderSync(2, req, res));

// ---------- DEMO run controls (admin-only showcase) ----------
// Seed/reset/clear the synthetic demo roster (program 90). All rows are @demo.local checkins-only
// (no applicant rows) confined to program_id=90, so nothing here can touch live data.
const DEMO_PID = 90;
const DEMO_NAMES = ['Marcus B.', 'Jordan T.', 'Andre W.', 'Tyler R.', 'Chris O.', 'Devin M.', 'Malik S.',
  'Isaiah H.', 'Xavier P.', 'Cameron D.', 'Trey L.', 'Josh N.', 'Elijah G.', 'Nate F.'];
// Bot chatter seeded into the demo run's chat so it looks alive during a demo (sender name resolves
// from the demo roster via the checkins fallback in hydrateGroupMessages). [demo-player-index, line].
const DEMO_CHAT = [
  [2, 'yo who’s running tonight? 🏀'],
  [5, 'me + a couple friends, we’re in'],
  [1, 'waitlist moved fast last week 😅'],
  [9, 'first time coming out — how’s the run?'],
  [3, 'competitive but chill, you’ll love it 🙌'],
  [7, 'save me a spot on the floor 🙏'],
  [4, 'anyone got a ball pump? mine died'],
  [11, 'see everyone at 7 🔥'],
];
// Seed/reset: a fresh FULL floor + FULL waitlist of synthetic players, run open. Idempotent
// (clears program-90 rows first) so it doubles as the reset button.
app.post('/admin/demo/seed', requireAdmin, (req, res) => {
  const pid = DEMO_PID, cfg = P(pid).config;
  // Never reuse a PAST rehearsal's stored date (static programs never roll it) — recompute if stale
  // so the demo always seeds on an upcoming date, not last week's.
  let rd = getSetting(cfg.keys.runDate);
  if (!rd || rd < ymdLocal()) rd = programDefaultDate(pid);
  setSetting(cfg.keys.runDate, rd);
  db.prepare('DELETE FROM checkins WHERE program_id = ?').run(pid);
  db.prepare('INSERT OR REPLACE INTO run_state (run_date, program_id, is_open, cancelled) VALUES (?,?,1,0)').run(rd, pid);
  const total = Math.min(cfg.cap + cfg.waitlist, DEMO_NAMES.length);
  const ins = db.prepare('INSERT INTO checkins (run_date, email, name, program_id, sort_order) VALUES (?,?,?,?,?)');
  for (let i = 0; i < total; i++) ins.run(rd, `demo-${i + 1}@demo.local`, DEMO_NAMES[i], pid, i);
  // ~60% of the floor shows a green ✓ (a realistic mix of confirmed / not-yet-confirmed).
  db.prepare("UPDATE checkins SET confirmed_at = datetime('now') WHERE program_id = ? AND run_date = ? AND sort_order < ?")
    .run(pid, rd, Math.floor(cfg.cap * 0.6));
  // One floor player carries a minor DOB → showcases the red "Minor" safeguarding badge on the roster.
  // (Demo players are checkins-only, so the DOB lives on the checkin row itself, not an applicant.)
  db.prepare("UPDATE checkins SET dob = '2010-03-15' WHERE program_id = ? AND run_date = ? AND sort_order = 3").run(pid, rd);
  // Seed the demo CHAT with bot chatter so the room looks alive (cleared on reset/clear below).
  // Beyond text it showcases EVERY message type: a photo (with caption), a sticker, a voice note,
  // a video, a threaded reply, and a pinned message — the media are tiny bundled static assets
  // (public/demo-media/*, referenced by path exactly like /stickers/*), so nothing is uploaded/orphaned.
  db.prepare('DELETE FROM group_messages WHERE program_id = ?').run(pid);
  const insMsg = db.prepare('INSERT INTO group_messages (from_email, body, program_id) VALUES (?,?,?)');
  const em = (i) => `demo-${i + 1}@demo.local`;
  const msgIds = [];
  for (const [i, line] of DEMO_CHAT) if (i < total) msgIds.push(insMsg.run(em(i), line, pid).lastInsertRowid);
  // reply — threads the 5th text line onto the 4th ("first time coming out" → welcome)
  db.prepare('INSERT INTO group_messages (from_email, body, reply_to, program_id) VALUES (?,?,?,?)')
    .run(em(6), 'bring water, we run games back to back 💧', msgIds[3], pid);
  // photo with a caption (bundled gym shot)
  db.prepare('INSERT INTO group_messages (from_email, body, image, program_id) VALUES (?,?,?,?)')
    .run(em(0), 'last week was a movie 🔥', '/gym.jpg', pid);
  // sticker
  db.prepare('INSERT INTO group_messages (from_email, body, image, program_id) VALUES (?,?,?,?)')
    .run(em(5), '', '/stickers/gameon.svg', pid);
  // voice note (3s bundled clip)
  db.prepare('INSERT INTO group_messages (from_email, body, audio, audio_dur, program_id) VALUES (?,?,?,?,?)')
    .run(em(2), '', '/demo-media/voice.m4a', 3, pid);
  // video (3s bundled clip, native player)
  db.prepare('INSERT INTO group_messages (from_email, body, video, video_dur, program_id) VALUES (?,?,?,?,?)')
    .run(em(8), '', '/demo-media/clip.mp4', 3, pid);
  // pinned message (shows in the pinned bar at the top of the room)
  db.prepare("INSERT INTO group_messages (from_email, body, pinned_at, pinned_by, program_id) VALUES (?,?,datetime('now'),?,?)")
    .run(em(1), '📌 Doors open 6:45 — first 12 on the floor, everyone else waitlists. Bring both jersey colours.', req.userEmail, pid);
  // PARTIES (queue-with-friends showcase): party A = demo-1..4 (a whole team's worth), party B =
  // demo-5,6 and party C = demo-7,8 (two pairs), demo-9..12 solo. Then the REAL party-aware
  // auto-fill runs → Team 1 = one full party, Team 2 = two different groups, Team 3 = individuals.
  clearRunParties(pid, rd);
  db.prepare('DELETE FROM team_assignments WHERE program_id = ?').run(pid);
  const insParty = db.prepare('INSERT INTO signup_groups (program_id, run_date, leader_email) VALUES (?,?,?)');
  const insPartyM = db.prepare("INSERT INTO signup_group_members (group_id, email, status) VALUES (?,?,'joined')");
  const setGid = db.prepare('UPDATE checkins SET group_id = ? WHERE program_id = ? AND run_date = ? AND email = ?');
  const mkParty = (idx) => { // idx = 0-based demo indices; first is leader
    const gid = insParty.run(pid, rd, em(idx[0])).lastInsertRowid;
    for (const i of idx.slice(1)) insPartyM.run(gid, em(i));
    for (const i of idx) setGid.run(gid, pid, rd, em(i));
  };
  mkParty([0, 1, 2, 3]);   // A — fills Team 1 whole
  mkParty([4, 5]);         // B ┐
  mkParty([6, 7]);         // C ┘ together = Team 2
  teamFillCore(pid, rd, req.userEmail);   // the real party-aware auto-fill (demo-9..12 → Team 3)
  audit(req.userEmail, 'admin', 'demo:seed', `${total} players on ${rd}`);
  res.redirect(P(pid).paths.run);
});
// END QUEUE — simulate the run finishing: the roster is cleared and check-in closes (what the
// weekly rollover + autolock do for a live program; the static demo never schedules, so it's a
// button). Chat is kept so the room still looks alive between cycles.
app.post('/admin/demo/endqueue', requireAdmin, (req, res) => {
  const pid = DEMO_PID, cfg = P(pid).config;
  const rd = getSetting(cfg.keys.runDate);
  if (rd) {
    db.prepare('DELETE FROM checkins WHERE program_id = ?').run(pid);
    db.prepare('DELETE FROM team_assignments WHERE program_id = ?').run(pid);   // teams + parties end with the run
    clearRunParties(pid, rd);
    db.prepare('INSERT OR REPLACE INTO run_state (run_date, program_id, is_open, cancelled) VALUES (?,?,0,0)').run(rd, pid);
  }
  audit(req.userEmail, 'admin', 'demo:endqueue', rd || '');
  res.redirect(P(pid).paths.run);
});
// START QUEUE — simulate next week's queue opening: check-in opens and the AUTO-RENEWERS instantly
// claim their guaranteed spots (auto_seated=1 rows — the same observable result seatRenewers
// produces for a live program's members; demo players are synthetic so they can't flow through the
// real membership join). 5 of 8 spots auto-fill, leaving room to show live joins/offers on top.
app.post('/admin/demo/startqueue', requireAdmin, (req, res) => {
  const pid = DEMO_PID, cfg = P(pid).config;
  let rd = getSetting(cfg.keys.runDate);
  if (!rd || rd < ymdLocal()) rd = programDefaultDate(pid);
  setSetting(cfg.keys.runDate, rd);
  db.prepare('INSERT OR REPLACE INTO run_state (run_date, program_id, is_open, cancelled) VALUES (?,?,1,0)').run(rd, pid);
  const AUTO_RENEWERS = 5; // the subset with auto-renew ON
  const ins = db.prepare('INSERT OR IGNORE INTO checkins (run_date, email, name, program_id, sort_order, auto_seated) VALUES (?,?,?,?,?,1)');
  for (let i = 0; i < AUTO_RENEWERS; i++) ins.run(rd, `demo-${i + 1}@demo.local`, DEMO_NAMES[i], pid, i);
  audit(req.userEmail, 'admin', 'demo:startqueue', `${rd} +${AUTO_RENEWERS} auto`);
  res.redirect(P(pid).paths.run);
});
// Synthetic profile card for a DEMO player — roster names are tappable like live (profile, role,
// stats, a client-side Follow toggle) but nothing persists: demo players have no accounts by
// design. Admin-only, same as every demo surface.
app.get('/demo/u/:i/card', requireAdmin, (req, res) => {
  const i = Number(req.params.i) || 0;
  const row = db.prepare('SELECT name, dob FROM checkins WHERE program_id = ? AND email = ?').get(DEMO_PID, `demo-${i}@demo.local`);
  if (!row) return res.status(404).send('');
  res.send(demoProfileCard({ name: row.name, idx: i, minor: isMinor(row) }));
});
// Tear the demo down — remove every synthetic row + its run state so nothing lingers.
app.post('/admin/demo/clear', requireAdmin, (req, res) => {
  const pid = DEMO_PID, cfg = P(pid).config;
  const rdCur = getSetting(cfg.keys.runDate);
  db.prepare('DELETE FROM checkins WHERE program_id = ?').run(pid);
  db.prepare('DELETE FROM run_state WHERE program_id = ?').run(pid);
  db.prepare('DELETE FROM attendance WHERE program_id = ?').run(pid);
  db.prepare('DELETE FROM group_messages WHERE program_id = ?').run(pid);   // clear the bot chatter too
  db.prepare('DELETE FROM team_assignments WHERE program_id = ?').run(pid); // teams + parties too
  if (rdCur) clearRunParties(pid, rdCur);
  delSetting(cfg.keys.runDate);
  audit(req.userEmail, 'admin', 'demo:clear', '');
  res.redirect(P(pid).paths.run);
});

// NB: the terminal 4-arg error handler is registered LAST — after mountRunProgram (see just before
// app.listen) — so a throw in ANY route (incl. the config-mounted volleyball routes) lands there
// with a friendly 500 instead of falling through to Express's default handler (which would leak a
// stack trace in dev mode). Express matches middleware in registration order, hence the placement.
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
// Generic registry closures for an OPT-IN program (pickleball, volleyball) — so a program's DEFS
// entry is pure config, not cloned unread/hubCard/tick logic. Basketball keeps its own (it uses
// host-editable caps + per-week time overrides). Each returns a closure that reads P(id) at call time.
function genericUnread(programId) {
  return (email, aid) => ({ group: chatUnreadFor(programId, email), gm: chatMentionUnreadFor(programId, email, aid) });
}
function genericHubCard(programId) {
  return () => {
    ensureWeekFor(programId);
    const cfg = P(programId).config;
    const rd = programRunDate(programId), part = partitionFor(programId, rd);
    const floor = cfg.offerWindow ? part.floorReal : part.floor;
    return {
      runDate: rd, dateLabel: runLabelFor(rd), timeLabel: fmtClockRange(startHHMM(cfg), endHHMM(cfg)),
      going: floor.length + (cfg.offerWindow ? part.offered.length : 0), cap: cfg.cap, // count held offers so the hub card matches the run page (no 8→7 dip mid-offer)
      status: runCancelledFor(programId, rd) ? 'cancelled' : (runOpenFor(programId, rd) ? 'open' : 'closed'),
      hidden: !programActive(programId),
      part, // the partition this card already computed — reused by myRunStatusFor on /runs (stripped before view props)
    };
  };
}
function genericTick(programId) {
  return () => {
    ensureWeekFor(programId);
    const rd = programRunDate(programId);
    if (P(programId).config.offerWindow) expireAndReoffer(rd, null, programId);   // queue programs re-offer freed spots
    autoRunStateFor(programId);
  };
}
const PROGRAM_DEFS = {
  1: {
    key: 'basketball', emoji: '🏀', displayName: 'ADV Basketball', alwaysActive: true,
    paths: { run: '/checkin', chat: '/chat', season: '/season' }, seasonLabel: 'Season board',
    // Per-program config (Phase 3a foundation): the single source the unified engine will read
    // so a new run = a config row, not cloned code. Capacities are HOST-EDITABLE at runtime
    // (app_settings via reloadRunSettings), so they're getters — a snapshot would go stale on the
    // next Council settings save. Nothing consumes this yet (0-diff); the engine merge wires it in.
    config: {
      get cap() { return CAP; }, get waitlist() { return WAITLIST_CAP; }, get prereg() { return PREREG_CAP; },
      dow: RUN_DOW, start: DEFAULT_START, end: DEFAULT_END,          // Wed 8:30–10:30 PM
      openDaysBefore: OPEN_DAYS_BEFORE, openHour: OPEN_H, lockTime: '14:00',
      confirmCutoff: '16:30',   // unconfirmed floor released at 4:30 PM run day (owner-set; must be ≥ lockTime — the sweep runs inside the post-lock branch)
      theme: 'default', access: 'apply', approval: 'council',
      tiers: ['team', 'core', 'host'], offerWindow: true,
      autoRenew: { from: 'team' },   // only the org team (applicants.is_team) auto-renews; no non-team fill
      positions: [['PG', 'Point'], ['SG', 'Shoot'], ['SF', 'Small F'], ['PF', 'Power F'], ['C', 'Center']],   // profile picker chips (F6: per-program)
      // autoRenewPenalty: { strikes: 3, pauseWeeks: 2 },   // DARK — add to police team no-shows (autoRunState assess + seatRenewers skip already wired; marker app_settings 'arassess_done')
      mentionTag: 'mention', chatSeqKey: 'chat_seq',   // push-dedup tag + app_settings key for this room
      // TWO sides, because that is what a full-court run is. `size` is deliberately loose (cap is 15,
      // so 10 a side never legitimately fills): the size guard exists to stop a mis-tap stacking one
      // team, and a guard that fights the operator mid-night is worse than no guard.
      // selfServe:false — sides are called by whoever is running the night, not self-picked.
      // games:true turns on result logging from the teams board + the leaderboard it feeds.
      features: { teams: { count: 2, size: 10, opensAt: 'lock', selfServe: false, games: true }, groupQueue: false },
      // This run signs up in Planning Center, not here, so its floor is synced in. Prefix only
      // NARROWS the candidate signups; pcoSignupRosterForDate matches on the event date.
      // Matches the weekly runs only. Andrew renamed these in Planning Center on 2026-09-10 to
      // "YA Basketball - Advanced Run (Wed Sep 23)" so other staff can tell the events apart.
      // The "(Wed" is load-bearing: the crew signup is "YA Basketball - Advanced Run (Team)" and
      // without it that would match too, and resolve as a second signup on every run date.
      pcoSignupPrefix: 'YA Basketball - Advanced Run (Wed',
    },
    unread: (email, aid) => ({ group: groupUnread(email), gm: groupMentionUnread(email, aid) }),
    hubCard: (req) => {
      const bb = loadRun(req);
      return {
        runDate: bb.runDate, dateLabel: runLabelFor(bb.runDate), timeLabel: runTimeRange(bb.runDate),
        going: bb.inPlayers.length + bb.offeredPlayers.length, cap: CAP,
        status: runIsCancelled(bb.runDate) ? 'cancelled' : (runIsOpen(bb.runDate) ? 'open' : 'closed'),
        hidden: false,
        part: bb.part, // reuse loadRun's partition for the /runs badge (myRunStatusFor) — post-expireAndReoffer, exactly what a 2nd partition would see
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
      dow: PK_DOW, startHour: PK_START_H, startMin: PK_START_M, endHour: PK_END_H, endMin: PK_END_M,   // Tue 6:15–8:15 PM
      pingHour: PK_PING_H, pingDowOffset: PK_PING_DOW_OFFSET, lockTime: PK_LOCK,
      confirmCutoff: '16:30',   // unconfirmed floor released at 4:30 PM run day (absolute, owner-set)
      keys: { runDate: 'pk_run_date', runBase: 'pk_run_base', seasonStart: 'pk_season_start',
              autoopen: 'pk_autoopen_done', autoping: 'pk_autoping_done', autolock: 'pk_autolock_done', arassess: 'pk_arassess_done', confirmsweep: 'pk_confirmsweep_done' },  // app_settings keys
      logTag: 'pk', openOffsetDays: -7,   // audit/push/log prefix; reopen openOffsetDays before run day at endHour
      copy: {
        openTitle: 'Pickleball check-in is open',
        openBody: (rd) => `Check-in is open for ${runWeekday(rd)}, ${runLabelFor(rd)} pickleball — grab your spot 🥒`,
        confirmTitle: 'Confirm your pickleball spot',
        confirmBody: (rd) => `You're on the floor for ${runWeekday(rd)} pickleball. Tap to confirm — or leave to free your spot.`,
        promoTitle: "You're in for pickleball 🥒",
        promoBody: (rd) => `A spot opened — you're on the floor for ${runWeekday(rd)}, ${runLabelFor(rd)} pickleball.`,
        annTitle: 'Pickleball announcement',
      },
      theme: 'pk', access: 'opt-in', approval: 'invite',
      bannerPath: PK_BANNER_PATH, bannerPublic: '/pk-banner.jpg',   // own banner file + its public URL (fallback /gym.jpg)
      tiers: ['team', 'host'], offerWindow: false,
      autoRenew: { from: 'members' },   // any opt-in member (program_membership.auto_renew) renews; team seated first, then non-team fill
      // autoRenewPenalty: { strikes: 3, pauseWeeks: 2 },   // DARK — add to enable no-show strikes (engine + keys.arassess ready)
      mentionTag: 'pkmention', chatSeqKey: 'pk_chat_seq',
      // groupQueue ON: parties can check into pickleball ("a party can join any run"). Simple
      // model + packParties reduction-proof — with no group_ids the roster is byte-identical.
      // ladder ON: doubles results logged at the court feed a season board (owner 2026-09-08).
      // `log` decides who may record a game — 'operator' (host/admin) or 'players' (any member on
      // tonight's roster); `pointsTo` only prefills the winners' score box. Absent/false = the
      // whole feature is dark for that program, routes included.
      features: { teams: false, groupQueue: { maxSize: 4 },
        // pcoGroup: the Church Center group whose membership IS the ladder roster. With it set,
        // the operator can pull the roster instead of typing it (Groups is readable on a plain
        // People-viewer token; Check-Ins is not). Absent = the roster is entered by hand.
        // nominations: CLOSED until the end of the season (owner 2026-09-08) — the award is voted
        // once, in the final weeks, not accumulated all season. Flip to true to open voting.
        ladder: { pointsTo: 11, log: 'operator', award: 'Iron Sharpens Iron', nominations: false, pcoGroup: 3185612 } },
    },
    unread: genericUnread(2),
    hubCard: genericHubCard(2),
    tick: genericTick(2),
  },
  // Volleyball — the Phase-4 acceptance test: adding a program is PURE CONFIG (this block + a
  // program row + a CSS theme). Ships HIDDEN (program.active=0); publish = flip active + set the
  // season start in September. Cap 21 (3×7), waitlist 6, opt-in, org-team tier only. Day/time are
  // PLACEHOLDER (Fri ~6–9 PM) — config, finalize before publish. Uses the generic engine end-to-end;
  // routes are registered by mountRunProgram.
  // SIMPLE seating model (offerWindow:false, like pickleball): a freed floor spot promotes the top
  // waitlister IMMEDIATELY — no 3h email-offer/claim window. Chosen over the offer model because the
  // offer-window claim route + offer UI were never wired for vb AND offers fought the queue-with-
  // friends parties (a single freed seat can't be offered to a multi-person party). groupQueue stays
  // ON: packParties (in simplePartition) keeps a party atomic on the floor.
  3: {
    key: 'volleyball', emoji: '🏐', displayName: 'Volleyball',
    paths: { run: '/volleyball', chat: '/volleyball/chat', season: '/volleyball/season' }, seasonLabel: 'Volleyball season',
    config: {
      cap: 21, waitlist: 6, prereg: 0,
      dow: 5, startHour: 18, endHour: 21,          // Fri 6–9 PM (PLACEHOLDER — owner to finalize 6:30–9:30)
      pingHour: 9, pingDowOffset: 0, lockTime: '18:00',    // confirm ping RUN-DAY 9 AM (owner rule), roster locks 6 PM
      confirmCutoff: '16:30',                              // unconfirmed floor released at 4:30 PM run day (absolute, owner-set)
      keys: { runDate: 'vb_run_date', runBase: 'vb_run_base', seasonStart: 'vb_season_start',
              autoopen: 'vb_autoopen_done', autoping: 'vb_autoping_done', autolock: 'vb_autolock_done', arassess: 'vb_arassess_done', confirmsweep: 'vb_confirmsweep_done' },
      logTag: 'vb', openOffsetDays: -7,
      copy: {
        openTitle: 'Volleyball check-in is open',
        openBody: (rd) => `Check-in is open for ${runWeekday(rd)}, ${runLabelFor(rd)} volleyball — grab your spot 🏐`,
        confirmTitle: 'Confirm your volleyball spot',
        confirmBody: (rd) => `You're on the floor for ${runWeekday(rd)} volleyball. Tap to confirm — or leave to free your spot.`,
        promoTitle: "You're in for volleyball 🏐",
        promoBody: (rd) => `A spot opened — you're on the floor for ${runWeekday(rd)}, ${runLabelFor(rd)} volleyball.`,
        annTitle: 'Volleyball announcement',
      },
      theme: 'vb', access: 'opt-in', approval: 'invite',
      bannerPath: bannerFile('vb-banner.jpg'), bannerPublic: '/vb-banner.jpg',
      tiers: ['team', 'host'], offerWindow: false,   // SIMPLE model — immediate waitlist promotion (see block comment)
      autoRenew: { from: 'members' },
      autoRenewPenalty: { strikes: 3, pauseWeeks: 2 },   // ENABLED: 3 consecutive no-shows (auto-seated, never confirmed) → auto-renew pauses 2 weeks. Tunable.
      positions: [['S', 'Setter'], ['OH', 'Outside'], ['MB', 'Middle'], ['OPP', 'Opp'], ['L', 'Libero'], ['DS', 'Def']],   // profile picker chips (F6: per-program)
      mentionTag: 'vbmention', chatSeqKey: 'vb_chat_seq',
      features: { teams: { count: 3, size: 7, opensAt: 'lock', selfServe: true }, groupQueue: { maxSize: 4 } },  // 3×7 teams; queue-with-friends parties up to 4 (Phase 6b)
    },
    unread: genericUnread(3),
    hubCard: genericHubCard(3),
    tick: genericTick(3),
  },
  // DEMO — a live, fully-interactive showcase run that reuses the REAL engine (offerWindow: true, so
  // the auto-offer → confirm → promote money-moment is genuine, not mocked). Two things keep it safe:
  //   • static: true — no weekly rollover / archive / auto-open (ensureWeekFor + the tick no-op), so a
  //     seeded roster stays put and nothing ever lands in attendance/season/exports.
  //   • players are synthetic checkins-only rows (@demo.local, no applicant rows) in program_id=90 —
  //     invisible to friend search, people admin, push, and every other live surface.
  // Ships inactive (program.active=0): only an admin sees/operates it (programGate allows admins on
  // hidden programs). Seed/reset/clear + the money-moment run from the demo control strip on /demo.
  90: {
    key: 'demo', emoji: '🎬', displayName: 'DEMO — Live Waitlist',
    paths: { run: '/demo', chat: '/demo/chat', season: '/demo/season' }, seasonLabel: 'Demo season',
    config: {
      cap: 12, waitlist: 6, prereg: 0,             // 12 floor = 3 teams of 4 (party + two-groups + individuals showcase)
      dow: 3, startHour: 19, endHour: 21,          // cosmetic (static — never scheduled): Wed 7–9 PM
      pingHour: 18, pingDowOffset: 1, lockTime: '18:00',
      keys: { runDate: 'demo_run_date', runBase: 'demo_run_base', seasonStart: 'demo_season_start',
              autoopen: 'demo_autoopen_done', autoping: 'demo_autoping_done', autolock: 'demo_autolock_done', arassess: 'demo_arassess_done' },
      logTag: 'demo', openOffsetDays: -7,
      copy: {
        openTitle: 'Demo check-in is open',
        openBody: (rd) => `Demo check-in is open for ${runLabelFor(rd)}.`,
        confirmTitle: 'Confirm your demo spot',
        confirmBody: (rd) => `You're on the floor for the ${runLabelFor(rd)} demo run.`,
        promoTitle: "You're in (demo)",
        promoBody: (rd) => `A spot opened — you're on the floor for the ${runLabelFor(rd)} demo run.`,
        annTitle: 'Demo announcement',
      },
      theme: 'default', access: 'opt-in', approval: 'invite',
      tiers: ['team', 'host'], offerWindow: true, static: true,   // REAL offer money-moment, but frozen lifecycle
      autoRenew: { from: 'members' },
      mentionTag: 'demomention', chatSeqKey: 'demo_chat_seq',
      // Teams + queue-with-friends ON for the showcase: 3 teams of 4 (a full party / two groups /
      // individuals) + party-atomic seating — the same generic features volleyball uses.
      features: { teams: { count: 3, size: 4, opensAt: 'lock', selfServe: true }, groupQueue: { maxSize: 4 } },
    },
    unread: genericUnread(90),
    hubCard: genericHubCard(90),
    tick: () => {},   // static — the 60s scheduler does no work for the demo
  },
};
// ---------- QUEUE-WITH-FRIENDS (Phase 6b: a party seats atomically) ----------
// A party = buddies who queue for ONE run together and land together — packParties keeps them
// unsplit at partition time (floor-together or wait-together, never 2-on/1-off). Gated by
// config.features.groupQueue (volleyball only): every route below no-ops otherwise, so with the
// flag off no signup_group rows are written and every checkins.group_id stays NULL → seating is
// byte-identical to today. You may invite anyone you FOLLOW (follow-only model) and a blocked pair
// is never allowed into one party (the block invariant, enforced HERE at the mutation boundary; the seating code
// trusts it). group_id is set ONLY via the explicit party check-in (never a solo join), so a party
// never grows under seated members — it lands together in one action or waits together.
const stmtPartyByLeader = db.prepare('SELECT * FROM signup_groups WHERE program_id=? AND run_date=? AND leader_email=?');
const stmtPartyById     = db.prepare('SELECT * FROM signup_groups WHERE id=?');
const stmtMyParty = db.prepare(`SELECT g.* FROM signup_groups g WHERE g.program_id=? AND g.run_date=?
    AND (g.leader_email=? OR EXISTS (SELECT 1 FROM signup_group_members m
      WHERE m.group_id=g.id AND m.email=? AND m.status IN ('invited','joined')))
    ORDER BY CASE WHEN g.leader_email=? THEN 0
      WHEN EXISTS (SELECT 1 FROM signup_group_members m WHERE m.group_id=g.id AND m.email=? AND m.status='joined') THEN 1
      ELSE 2 END, g.id ASC LIMIT 1`);
const stmtPartyJoinedMembers = db.prepare("SELECT email FROM signup_group_members WHERE group_id=? AND status='joined'");
const stmtPartyActiveMembers = db.prepare("SELECT email FROM signup_group_members WHERE group_id=? AND status IN ('invited','joined')");
// The party `email` belongs to for this run (leads it, or is an invited/joined member).
function myParty(programId, rd, email) {
  email = lc(email);
  // Deterministic when the viewer touches more than one party this run: prefer the one they LEAD,
  // then one they've JOINED, then a pending INVITE — so leave/disband/check-in act on the party
  // they actually own, not an arbitrary inbound invite (P2-4).
  return stmtMyParty.get(programId, rd, email, email, email, email);
}
function partyJoinedEmails(groupId) { // leader (implicitly in) + accepted members
  const g = stmtPartyById.get(groupId); if (!g) return [];
  const m = stmtPartyJoinedMembers.all(groupId).map(r => r.email);
  return [lc(g.leader_email), ...m];
}
function partyAllEmails(groupId) { // leader + everyone still in play (for block checks + size cap)
  const g = stmtPartyById.get(groupId); if (!g) return [];
  const m = stmtPartyActiveMembers.all(groupId).map(r => r.email);
  return [lc(g.leader_email), ...m];
}
// Keep checkins.group_id in lockstep with a party's JOINED membership: stamp joined members who
// have a checkin, clear anyone no longer joined. Called after every membership change + check-in.
function resyncPartyGroupIds(groupId) {
  const g = stmtPartyById.get(groupId); if (!g) return;
  const joined = partyJoinedEmails(groupId);
  if (joined.length) {
    const ph = joined.map(() => '?').join(',');
    db.prepare(`UPDATE checkins SET group_id=? WHERE program_id=? AND run_date=? AND email IN (${ph})`).run(groupId, g.program_id, g.run_date, ...joined);
    db.prepare(`UPDATE checkins SET group_id=NULL WHERE group_id=? AND email NOT IN (${ph})`).run(groupId, ...joined);
  } else {
    db.prepare('UPDATE checkins SET group_id=NULL WHERE group_id=?').run(groupId);
  }
}
// Blocking someone must break any party they currently SHARE with the blocker (the block invariant
// is only enforced at invite/accept, so a block AFTER both joined would otherwise still seat them
// together — P2-1). For every active queue-with-friends run this week, drop the non-leader of the
// pair from any party containing both, then resync group_ids off the floor.
function dropSharedPartyMemberships(a, b) {
  a = lc(a); b = lc(b);
  if (!a || !b || a === b) return;
  for (const p of PROGRAMS.values()) {
    if (!groupQueueFeature(p.id)) continue;
    const rd = programRunDate(p.id);
    for (const party of db.prepare('SELECT id, leader_email FROM signup_groups WHERE program_id=? AND run_date=?').all(p.id, rd)) {
      const all = partyAllEmails(party.id);
      if (!(all.includes(a) && all.includes(b))) continue;
      const drop = lc(party.leader_email) === a ? b : a; // keep the leader of the pair; drop the other (always a member row)
      db.prepare('DELETE FROM signup_group_members WHERE group_id=? AND email=?').run(party.id, drop);
      resyncPartyGroupIds(party.id);
    }
  }
  // PERSISTENT party too (P2-1): a blocked pair must not stay in one party — else next week's
  // one-tap check-in re-seats them together (the block invariant only ran at invite/accept).
  // Same rule: keep the leader of the pair, drop the other's membership row.
  for (const pp of db.prepare(`SELECT p.id, p.leader_email FROM parties p WHERE
      (lower(p.leader_email) IN (?, ?) OR EXISTS (SELECT 1 FROM party_members m WHERE m.party_id = p.id AND m.email IN (?, ?)))`).all(a, b, a, b)) {
    const all = persistentPartyActive(pp);
    if (!(all.includes(a) && all.includes(b))) continue;
    const drop = lc(pp.leader_email) === a ? b : a;
    db.prepare('DELETE FROM party_members WHERE party_id=? AND email=?').run(pp.id, drop);
  }
}
// A member who leaves / is pulled off the floor drops out of their party too (status→declined), so
// a later "check in my group" can't silently re-seat them (P2-2). Leaders are left alone — they
// disband via the party panel. No-op unless the run has queue-with-friends on.
function setPartyDeclinedFor(programId, rd, email) {
  if (!groupQueueFeature(programId)) return;
  email = lc(email);
  const party = myParty(programId, rd, email);
  if (!party || lc(party.leader_email) === email) return;
  db.prepare("UPDATE signup_group_members SET status='declined' WHERE group_id=? AND email=?").run(party.id, email);
  resyncPartyGroupIds(party.id);
}
// Invite someone I follow into my party for this run (I lead it; created lazily). Follow-only +
// block invariant + party-size cap. Returns silently on any violation (swap re-renders the page).
// ---------- PERSISTENT PARTIES (Friends-tab layer) ----------
// A party is created ONCE on the Friends tab, invites/accepts happen there, and "Check in as
// party" on any group-queue run INSTANTIATES the per-run signup_groups machinery from it — so
// packParties atomic seating, party-aware team fill, dots, sweeps all work unchanged downstream.
// One party per person (as leader or joined member). Party check-in = "we're coming": every
// seated member gets confirmed_at (owner rule — no separate confirm step, sweep-shielded).
const stmtPartyLedBy = db.prepare('SELECT * FROM parties WHERE leader_email=?');
const stmtPartyRow = db.prepare('SELECT * FROM parties WHERE id=?');
const stmtPartyJoinedIn = db.prepare(`SELECT p.* FROM parties p JOIN party_members m ON m.party_id=p.id
    WHERE m.email=? AND m.status='joined' LIMIT 1`);
const stmtPartyInvitesFor = db.prepare(`SELECT m.party_id, p.leader_email, p.name FROM party_members m
    JOIN parties p ON p.id=m.party_id WHERE m.email=? AND m.status='invited'`);
const stmtPartyMemberRows = db.prepare('SELECT email, status FROM party_members WHERE party_id=? ORDER BY created_at');
const stmtPartyJoinedRows = db.prepare("SELECT email FROM party_members WHERE party_id=? AND status='joined' ORDER BY created_at");
const stmtRunCheckedIn = db.prepare('SELECT email FROM checkins WHERE program_id=? AND run_date=?');
function myPersistentParty(email) { email = lc(email); return stmtPartyLedBy.get(email) || stmtPartyJoinedIn.get(email); }
function persistentPartyEmails(p) { return [lc(p.leader_email), ...stmtPartyJoinedRows.all(p.id).map(r => lc(r.email))]; }          // leader + joined
function persistentPartyActive(p) { return [lc(p.leader_email), ...stmtPartyMemberRows.all(p.id).map(r => lc(r.email))]; }          // + invited (block/size checks)
// The cross-program size cap = the largest groupQueue maxSize any program allows (config-derived).
function partyCap() { let m = 0; for (const p of PROGRAMS.values()) { const g = groupQueueFeature(p.id); if (g) m = Math.max(m, g.maxSize || 4); } return m || 4; }

// Friends-tab party data: my party (members + statuses), invites to me, and (leader-only) who I
// can still invite — people I FOLLOW, minus blocked pairs and people already committed elsewhere.
function friendsPartyDataFor(me) {
  me = lc(me);
  const maxSize = partyCap();
  const p = myPersistentParty(me);
  // Invites only render while uncommitted — once in a party, accept would refuse anyway (one
  // party per person), so showing them is a dead button.
  const invites = p ? [] : stmtPartyInvitesFor.all(me).map(r => {
    const ldr = peopleByEmails([r.leader_email]).get(lc(r.leader_email));
    return { partyId: r.party_id, name: r.name || '', leaderName: ldr?.full_name || r.leader_email };
  });
  let party = null, invitable = [];
  if (p) {
    const rows = [{ email: lc(p.leader_email), status: 'leader' }, ...stmtPartyMemberRows.all(p.id).map(m => ({ email: lc(m.email), status: m.status }))];
    const dir = peopleByEmails(rows.map(r => r.email));
    party = {
      id: p.id, name: p.name || '', isLeader: lc(p.leader_email) === me,
      members: rows.map(m => { const a = dir.get(m.email); return { id: a?.id || 0, name: a?.full_name || m.email, minor: isMinor(a), status: m.status }; }),
    };
    if (party.isLeader && rows.length < maxSize) {
      const inP = new Set(rows.map(r => r.email));
      invitable = [...peopleByEmails(followingOf(me)).values()]
        .filter(x => x.status === 'approved' && !/@guest\.local$/.test(x.email) && !inP.has(lc(x.email)) && !blockedPair(me, x.email) && !myPersistentParty(x.email))
        .map(x => ({ id: x.id, name: x.full_name })).sort((a, b) => a.name.localeCompare(b.name));
    }
  }
  return { maxSize, party, invites, invitable };
}

// Friends-tab party routes. Every mutation keys on req.userEmail (IDOR-safe: the party is resolved
// via leader_email=me or the (party_id, me) member row; invitees resolve from applicant id server-
// side). Violations redirect silently back to /friends (socialRoute pattern); forms are .swapform.
app.post('/friends/party/create', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res); if (!gate) return;
  if (!gate.a) return res.redirect('/friends');
  const me = lc(req.userEmail);
  if (!myPersistentParty(me)) {   // one party per person
    const name = String(req.body.name || '').trim().slice(0, 40);
    db.prepare('INSERT INTO parties (name, leader_email) VALUES (?,?)').run(name, me);
    audit(me, 'player', 'party:create', name);
  }
  res.redirect('/friends');
});
app.post('/friends/party/invite', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res); if (!gate) return;
  if (!gate.a) return res.redirect('/friends');
  const me = lc(req.userEmail);
  if (rateLimited('party-invite', me, 30, 10 * 60 * 1000)) return res.redirect('/friends');
  const p = stmtPartyLedBy.get(me); if (!p) return res.redirect('/friends');   // the leader invites
  const t = stmtApplicantById.get(Number(req.body.id) || 0);
  if (!t || t.status !== 'approved' || /@guest\.local$/.test(t.email)) return res.redirect('/friends');
  const them = lc(t.email);
  if (them === me || !isFollowing(me, them) || blockedPair(me, them)) return res.redirect('/friends');   // invite people you follow
  if (myPersistentParty(them)) return res.redirect('/friends');                                          // they're committed elsewhere
  const active = persistentPartyActive(p);
  if (active.some(e => e !== them && blockedPair(them, e))) return res.redirect('/friends');             // block invariant
  if (active.length >= partyCap()) return res.redirect('/friends');                                      // size cap
  db.prepare("INSERT OR IGNORE INTO party_members (party_id, email, status) VALUES (?,?,'invited')").run(p.id, them);
  res.redirect('/friends');
});
app.post('/friends/party/accept', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res); if (!gate) return;
  if (!gate.a) return res.redirect('/friends');
  const me = lc(req.userEmail), pid = Number(req.body.party) || 0;
  const inv = db.prepare("SELECT 1 FROM party_members WHERE party_id=? AND email=? AND status='invited'").get(pid, me);
  if (!inv || myPersistentParty(me)) return res.redirect('/friends');   // must hold the invite; one party per person
  const row = stmtPartyRow.get(pid); if (!row) return res.redirect('/friends');
  if (persistentPartyActive(row).some(e => e !== me && blockedPair(me, e))) return res.redirect('/friends');   // block invariant
  db.prepare("UPDATE party_members SET status='joined' WHERE party_id=? AND email=?").run(pid, me);
  res.redirect('/friends');
});
app.post('/friends/party/decline', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res); if (!gate) return;
  if (!gate.a) return res.redirect('/friends');
  const me = lc(req.userEmail), pid = Number(req.body.party) || 0;
  db.prepare("DELETE FROM party_members WHERE party_id=? AND email=? AND status='invited'").run(pid, me);   // decline = delete → re-invitable
  res.redirect('/friends');
});
// Leader revokes an invite / removes a member — otherwise a stale invite pins a party slot
// forever (P3-3). Leader-only; target resolved server-side from the applicant id.
app.post('/friends/party/remove', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res); if (!gate) return;
  const me = lc(req.userEmail);
  const p = stmtPartyLedBy.get(me); if (!p) return res.redirect('/friends');
  const t = stmtApplicantById.get(Number(req.body.id) || 0);
  if (t && lc(t.email) !== me) db.prepare('DELETE FROM party_members WHERE party_id=? AND email=?').run(p.id, lc(t.email));
  res.redirect('/friends');
});
app.post('/friends/party/leave', requireLogin, (req, res) => {
  const gate = requirePlayer(req, res); if (!gate) return;
  if (!gate.a) return res.redirect('/friends');
  const me = lc(req.userEmail);
  const p = myPersistentParty(me); if (!p) return res.redirect('/friends');
  if (lc(p.leader_email) === me) {   // leader → disband. Already-seated checkins stay (they're in for this week).
    db.prepare('DELETE FROM party_members WHERE party_id=?').run(p.id);
    db.prepare('DELETE FROM parties WHERE id=?').run(p.id);
    audit(me, 'player', 'party:disband', String(p.id));
  } else {
    db.prepare('DELETE FROM party_members WHERE party_id=? AND email=?').run(p.id, me);
  }
  res.redirect('/friends');
});

// Check the WHOLE party in together (atomic: all fit in the roster or none are added). Any JOINED
// member can trigger it ("if they check in with the party they are assumed to be coming"). The
// persistent party is INSTANTIATED as this run's signup_group; packParties seats them as one.
function runPartyCheckin(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g || !g.a) return res.redirect(base);
  const gq = groupQueueFeature(programId); if (!gq) return res.redirect(base);
  ensureWeekFor(programId);
  const rd = programRunDate(programId);
  if (runCancelledFor(programId, rd) || !runOpenFor(programId, rd)) return res.redirect(base);
  const me = lc(req.userEmail);
  const p = myPersistentParty(me);
  if (!p) return res.redirect(base);
  const emails = persistentPartyEmails(p);
  if (!emails.includes(me)) return res.redirect(base);                            // invited-but-not-joined can't seat the party
  if (emails.length > (gq.maxSize || 4)) return res.redirect(base + '?partybig=1'); // party exceeds THIS run's group cap
  // Per-run declined members (operator-removed this run, P2-2) must NOT be re-seated by a re-tap.
  const runGroup = stmtPartyByLeader.get(programId, rd, lc(p.leader_email));
  const declined = new Set(runGroup
    ? db.prepare("SELECT email FROM signup_group_members WHERE group_id=? AND status='declined'").all(runGroup.id).map(r => lc(r.email))
    : []);
  const seatable = emails.filter(e => !declined.has(e)).map(e => applicantByEmail(e))
    .filter(a => a && a.status === 'approved' && waiverSatisfied(programId, a.email) && !a.suspended && !/@guest\.local$/.test(a.email))
    // Belt-and-suspenders on the block invariant (P2-1): never seat someone alongside a party
    // member either of them has blocked, even if a stale membership survived.
    .filter(a => !emails.some(e => e !== lc(a.email) && blockedPair(a.email, e)))
    // F3 enforcement (P2-1 twin): a party check-in must not smuggle NON-MEMBERS into an
    // invite-only / request-to-join program — the leader's tap was auto-enrolling them below.
    // Open mode keeps the auto-enroll; others seat existing members only.
    .filter(a => (cfg.joinMode || 'open') === 'open' || memberOf(programId, lc(a.email)));
  const optRow = db.prepare('SELECT 1 FROM regular_optout WHERE run_date=? AND email=? AND program_id=?');
  const { rows } = partitionFor(programId, rd);
  const already = new Set(rows.map(r => lc(r.email)));
  // Skip members already checked in, and RESPECT a member's sit-out (regular_optout) — except for
  // me, the tapper, who is actively opting back in (P2-2).
  const toAdd = seatable.filter(a => !already.has(lc(a.email)) && (lc(a.email) === me || !optRow.get(rd, a.email, programId)));
  if (rows.length + toAdd.length > cfg.cap + cfg.waitlist) return res.redirect(base + '?partyfull=1'); // atomic: whole party or none
  db.exec('BEGIN'); // whole party seats or none — a mid-loop throw must not leave a PARTIAL party (P3-3)
  try {
    // Instantiate (or reuse) this run's signup_group from the persistent party.
    let run = runGroup;
    if (!run) {
      const info = db.prepare('INSERT INTO signup_groups (program_id, run_date, leader_email) VALUES (?,?,?)').run(programId, rd, lc(p.leader_email));
      run = stmtPartyById.get(info.lastInsertRowid);
    }
    for (const e of emails) if (e !== lc(p.leader_email)) {
      db.prepare(`INSERT INTO signup_group_members (group_id, email, status) VALUES (?,?,'joined')
        ON CONFLICT(group_id, email) DO UPDATE SET status = CASE WHEN status='declined' THEN status ELSE 'joined' END`).run(run.id, e);
    }
    for (const a of toAdd) {
      joinProgramMembership(programId, a.email);
      if (lc(a.email) === me) db.prepare('DELETE FROM regular_optout WHERE run_date=? AND email=? AND program_id=?').run(rd, a.email, programId); // tapper opts back in
      db.prepare("INSERT OR IGNORE INTO checkins (run_date, email, name, program_id, group_id, confirmed_at) VALUES (?,?,?,?,?,datetime('now'))")
        .run(rd, a.email, a.full_name, programId, run.id);
    }
    resyncPartyGroupIds(run.id);
    // Party check-in = "we're coming" (owner rule): confirm pre-existing solo checkins of the
    // party's joined members too, so nobody in the party is swept at the cutoff.
    const joined = partyJoinedEmails(run.id).filter(e => !declined.has(e));
    if (joined.length) db.prepare(`UPDATE checkins SET confirmed_at = datetime('now')
      WHERE program_id=? AND run_date=? AND confirmed_at IS NULL AND email IN (${joined.map(() => '?').join(',')})`).run(programId, rd, ...joined);
    db.exec('COMMIT');
    audit(me, 'player', `${cfg.logTag}:partycheckin`, `${run.id} +${toAdd.length}`);
  } catch (e) { db.exec('ROLLBACK'); console.error(`[${cfg.logTag}-party] group check-in FAILED: ${e.message}`); }
  res.redirect(base);
}

// Run-page party card data (null unless groupQueue is on → bball stays byte-identical). The card
// is a simple status + one-tap check-in; creating/managing the party lives on the Friends tab.
function partyPanelFor(programId, rd, email) {
  const gq = groupQueueFeature(programId); if (!gq) return null;
  email = lc(email);
  const maxSize = gq.maxSize || 4;
  const p = myPersistentParty(email);
  if (!p) return { maxSize, party: null };   // renders the "create one on the Friends tab" hint
  const emails = persistentPartyEmails(p);
  const checkedIn = new Set(stmtRunCheckedIn.all(programId, rd).map(r => lc(r.email)));
  const dir = peopleByEmails(emails);
  return {
    maxSize,
    party: {
      name: p.name || '', isLeader: lc(p.leader_email) === email, tooBig: emails.length > maxSize,
      members: emails.map(em => { const a = dir.get(em); return { id: a?.id || 0, name: a?.full_name || em, minor: isMinor(a), checkedIn: checkedIn.has(em) }; }),
    },
  };
}

const stmtProgActiveById = db.prepare('SELECT active FROM program WHERE id = ?');
// Register a program's full run-route set from config (paths + the generic runXxx handlers).
// Basketball (/checkin/*) and pickleball (/pickleball/*) keep their inline routes for now; other
// programs (volleyball, …) get theirs here. The terminal error handler is registered AFTER this
// mount (just before app.listen), so an uncaught throw in a mounted route lands there with a
// friendly 500 (no stack-trace leak) — same as the inline routes.
function mountRunProgram(app, program) {
  const b = program.paths.run, id = program.id;
  // Express can't UNMOUNT routes, but an in-app program can be deleted or re-slugged at runtime —
  // so every path this function registers gets one prefix guard that 404s the moment `b` stops
  // being this program's live path. Without it, a stale route reaches a handler that assumes
  // P(id) exists and throws a 500. One guard per program beats a check inside 30 handlers.
  app.use(b, (req, res, next) => {
    const live = PROGRAMS.get(id);
    if (live && live.paths.run === b) return next();
    return res.status(404).send('Not found');
  });
  app.get(b, requireLogin, (req, res) => runGetPage(id, req, res));
  app.get(`${b}/run.ics`, requireLogin, (req, res) => runIcs(id, req, res));
  app.post(`${b}/join-run`, requireLogin, (req, res) => runJoinRun(id, req, res));
  app.post(`${b}/requests`, requireLogin, (req, res) => runRequests(id, req, res));   // host/admin approve-decline (F3)
  app.post(`${b}/join`, requireLogin, (req, res) => runJoin(id, req, res));
  app.post(`${b}/leave`, requireLogin, (req, res) => runLeave(id, req, res));
  app.post(`${b}/confirm`, requireLogin, (req, res) => runConfirm(id, req, res));
  // Offer-claim (token-based, no login — matches basketball's inline claim). No-op for simple
  // programs (they never create offers); the money-moment for any offerWindow program.
  app.get(`${b}/claim/:token`, (req, res) => runClaimGet(id, req, res));
  app.post(`${b}/claim/:token`, (req, res) => runClaimPost(id, req, res));
  app.post(`${b}/autorenew`, requireLogin, (req, res) => runAutorenew(id, req, res));
  app.post(`${b}/open`, requireLogin, (req, res) => runOpen(id, req, res));
  app.post(`${b}/close`, requireLogin, (req, res) => runClose(id, req, res));
  app.post(`${b}/cancel`, requireLogin, (req, res) => runCancel(id, req, res));
  app.post(`${b}/date`, requireLogin, (req, res) => runDate(id, req, res));
  app.post(`${b}/remove`, requireLogin, (req, res) => runRemove(id, req, res));
  app.post(`${b}/bump`, requireLogin, (req, res) => runBump(id, req, res));
  app.post(`${b}/guest`, requireLogin, (req, res) => runGuest(id, req, res));
  app.get(`${b}/season`, requireLogin, (req, res) => runGetSeason(id, req, res));
  app.post(`${b}/season`, requireLogin, (req, res) => runSeasonSet(id, req, res));
  // Ladder (registered for every program; the handlers 404 unless config.features.ladder is on).
  app.get(`${b}/ladder`, requireLogin, (req, res) => runLadderGet(id, req, res));
  app.post(`${b}/ladder/log`, requireLogin, (req, res) => runLadderLog(id, req, res));
  app.post(`${b}/ladder/undo`, requireLogin, (req, res) => runLadderUndo(id, req, res));
  app.post(`${b}/ladder/nominate`, requireLogin, (req, res) => runLadderNominate(id, req, res));
  app.post(`${b}/ladder/voting`, requireLogin, (req, res) => runLadderVoting(id, req, res));
  app.post(`${b}/ladder/merge`, requireLogin, (req, res) => runLadderMerge(id, req, res));
  app.post(`${b}/headcount`, requireLogin, (req, res) => runHeadcountSet(id, req, res));
  app.post(`${b}/ladder/player`, requireLogin, (req, res) => runLadderAdd(id, req, res));
  app.post(`${b}/ladder/retire`, requireLogin, (req, res) => runLadderRetire(id, req, res));
  app.post(`${b}/ladder/sync`, requireLogin, (req, res) => runLadderSync(id, req, res));
  app.get(`${b}/banner`, requireAdmin, (req, res) => runBannerGet(id, req, res));
  app.post(`${b}/banner`, requireAdmin, (req, res) => runBannerPost(id, req, res));
  // Run chat (own room on the unified group_messages tables) — GET + seen/older + post/react/delete/pin/voice/video.
  app.get(`${b}/chat`, requireLogin, (req, res) => runChatGet(id, req, res));
  app.post(`${b}/chat/seen`, requireLogin, (req, res) => runChatSeen(id, req, res));
  app.get(`${b}/chat/older`, requireLogin, (req, res) => runChatOlder(id, req, res));
  app.post(`${b}/chat`, requireLogin, (req, res) => runChatPost(id, req, res));
  app.post(`${b}/chat/react`, requireLogin, (req, res) => runChatReact(id, req, res));
  app.post(`${b}/chat/delete`, requireLogin, (req, res) => runChatDelete(id, req, res));
  app.post(`${b}/chat/pin`, requireLogin, (req, res) => runChatPin(id, req, res));
  app.post(`${b}/chat/voice`, requireLogin, (req, res) => runChatVoice(id, req, res));
  app.post(`${b}/chat/video`, requireLogin, (req, res) => runChatVideo(id, req, res));
  app.post(`${b}/announce`, requireLogin, (req, res) => runAnnounce(id, req, res));
  app.post(`${b}/announce/retract`, requireLogin, (req, res) => runAnnounceRetract(id, req, res));
  app.post(`${b}/announce/cancel`, requireLogin, (req, res) => runAnnounceCancel(id, req, res));
  app.post(`${b}/kiosk-rotate`, requireLogin, (req, res) => runKioskRotate(id, req, res));
  app.post(`${b}/publish`, requireAdmin, (req, res) => runPublish(id, req, res));
  // Teams-in-a-run (registered for every program; the handlers no-op unless config.features.teams).
  app.post(`${b}/team/join`, requireLogin, (req, res) => runTeamJoin(id, req, res));
  app.post(`${b}/team/leave`, requireLogin, (req, res) => runTeamLeave(id, req, res));
  app.post(`${b}/team/assign`, requireLogin, (req, res) => runTeamAssign(id, req, res));
  app.post(`${b}/team/fill`, requireLogin, (req, res) => runTeamFill(id, req, res));
  app.get(`${b}/teams`, requireLogin, (req, res) => runTeamsBoard(id, req, res));
  app.post(`${b}/team/swap`, requireLogin, (req, res) => runTeamSwap(id, req, res));
  app.post(`${b}/team/bench`, requireLogin, (req, res) => runTeamBench(id, req, res));
  app.post(`${b}/teams/clear`, requireLogin, (req, res) => runTeamsClear(id, req, res));
  // Game results + leaderboard (registered for every program; 404 unless features.teams.games).
  app.post(`${b}/game`, requireLogin, (req, res) => runGameLog(id, req, res));
  app.post(`${b}/game/undo`, requireLogin, (req, res) => runGameUndo(id, req, res));
  app.post(`${b}/game/merge`, requireLogin, (req, res) => runGameMerge(id, req, res));
  app.get(`${b}/leaderboard`, requireLogin, (req, res) => runLeaderboard(id, req, res));
  app.post(`${b}/roster-sync`, requireLogin, (req, res) => runRosterSync(id, req, res));
  app.post(`${b}/penalty/clear`, requireLogin, (req, res) => runPenaltyClear(id, req, res));  // operator: forgive an auto-renew strike/pause
  // Queue-with-friends (registered for every program; the handlers no-op unless config.features.groupQueue).
  // Parties are created/managed on the FRIENDS tab now (/friends/party/*); the run keeps only
  // the one-tap group check-in (any joined member seats the whole party — assumed coming).
  app.post(`${b}/party/checkin`, requireLogin, (req, res) => runPartyCheckin(id, req, res));
}
// ---------- DB-DEFINED PROGRAMS (created in-app, no deploy) ----------
// A church admin fills in the "New program" wizard → one `program` row with a JSON spec → this
// builds the same shape PROGRAM_DEFS hand-writes, so the generic engine (routes, scheduler, chat,
// season, teams, parties, hub card, exports, PCO labels) picks it up with zero new code. Only the
// genuinely arbitrary choices are stored; everything formulaic is DERIVED here — which is exactly
// why hand-writing them was never real engineering work:
//   paths    /<slug>, /<slug>/chat, /<slug>/season
//   keys     <slug>_run_date, <slug>_autoopen_done, … (the app_settings namespace)
//   copy     push/announcement strings, from the display name + emoji
//   banner   public/prog-<slug>-banner.jpg (falls back to the shared gym photo until one is uploaded)
const PROGRAM_THEMES = ['default', 'pk', 'vb'];   // curated, known-legible skins (see styles.css)
function derivedCopy(name, emoji) {
  const low = name.toLowerCase();
  return {
    openTitle: `${name} check-in is open`,
    openBody: (rd) => `Check-in is open for ${runWeekday(rd)}, ${runLabelFor(rd)} ${low} — grab your spot ${emoji}`,
    confirmTitle: `Confirm your ${low} spot`,
    confirmBody: (rd) => `You're on the floor for ${runWeekday(rd)} ${low}. Tap to confirm — or leave to free your spot.`,
    promoTitle: `You're in for ${low} ${emoji}`,
    promoBody: (rd) => `A spot opened — you're on the floor for ${runWeekday(rd)}, ${runLabelFor(rd)} ${low}.`,
    annTitle: `${name} announcement`,
  };
}
function defFromRow(row) {
  let spec;
  try { spec = JSON.parse(row.config || 'null'); } catch { spec = null; }
  if (!spec || !row.slug) return null;
  // A spec that PARSES but is missing numbers would build a program whose scheduler computes an
  // Invalid Date (dow NaN) and whose hub card throws — a 500 on /runs for every member. Only a
  // complete spec becomes a program; an incomplete one stays inert (and visibly unmounted on the
  // admin screen). Reachable only by hand-editing the DB — the wizard validates — but the blast
  // radius is all-users, so the contract is enforced here rather than assumed.
  for (const n of ['cap', 'waitlist', 'dow', 'startHour', 'endHour']) {
    if (!Number.isFinite(spec[n])) { console.error(`[program] id=${row.id} spec missing ${n} — not mounted`); return null; }
  }
  const slug = row.slug, name = spec.displayName || row.name, emoji = spec.emoji || '🏅';
  const k = (s) => `${slug}_${s}`;
  const features = {};
  if (spec.teams && spec.teams.count > 0) features.teams = { count: spec.teams.count, size: spec.teams.size, opensAt: 'lock', selfServe: true };
  if (spec.groupQueue && spec.groupQueue.maxSize > 1) features.groupQueue = { maxSize: spec.groupQueue.maxSize };
  return {
    key: slug, emoji, displayName: name,
    paths: { run: `/${slug}`, chat: `/${slug}/chat`, season: `/${slug}/season` },
    seasonLabel: `${name} season`,
    config: {
      cap: spec.cap, waitlist: spec.waitlist, prereg: spec.prereg || 0,
      dow: spec.dow, startHour: spec.startHour, endHour: spec.endHour,
      pingHour: spec.pingHour == null ? 9 : spec.pingHour, pingDowOffset: spec.pingDowOffset == null ? 0 : spec.pingDowOffset,
      lockTime: spec.lockTime, confirmCutoff: spec.confirmCutoff || null,
      keys: {
        runDate: k('run_date'), runBase: k('run_base'), seasonStart: k('season_start'),
        autoopen: k('autoopen_done'), autoping: k('autoping_done'), autolock: k('autolock_done'),
        arassess: k('arassess_done'), confirmsweep: k('confirmsweep_done'),
      },
      logTag: slug, openOffsetDays: spec.openOffsetDays == null ? -7 : spec.openOffsetDays,
      copy: derivedCopy(name, emoji),
      theme: PROGRAM_THEMES.includes(spec.theme) ? spec.theme : 'default',
      access: 'opt-in', approval: row.approval,
      joinMode: ['open', 'invite', 'host'].includes(spec.joinMode) ? spec.joinMode : 'open',
      bannerPath: bannerFile(`prog-${slug}-banner.jpg`), bannerPublic: `/prog-${slug}-banner.jpg`,
      tiers: ['team', 'host'], offerWindow: !!spec.offerWindow,
      autoRenew: spec.autoRenew ? { from: 'members' } : null,
      mentionTag: `${slug}mention`, chatSeqKey: k('chat_seq'),
      // Positions (F6): shape-guarded like the numeric contract above — a hand-edited spec must
      // not let a non-[code,label] entry reach the profile renderer.
      positions: Array.isArray(spec.positions)
        ? spec.positions.filter(x => Array.isArray(x) && typeof x[0] === 'string' && x[0]).map(x => [x[0], String(x[1] || '')])
        : null,
      // Own waiver (F6): the key is frozen at creation (spec.waiverKey) so slug renames don't
      // orphan signed records; a legacy spec without the stamp falls back to the current slug.
      waiver: spec.waiver && spec.waiver.own
        ? { key: spec.waiverKey || slug, guardianUnder: spec.waiver.guardian ? 18 : 0 }
        : null,
      features,
    },
    unread: genericUnread(row.id), hubCard: genericHubCard(row.id), tick: genericTick(row.id),
  };
}
// A program's own routes live under /<slug>, so a slug must never shadow an app route or a real
// file in public/. Computed from the LIVE router stack rather than a hand-kept list — a list would
// silently rot the next time a route is added.
function slugIsReserved(slug) {
  if (fs.existsSync(path.join(__dirname, 'public', slug))) return true;
  // A slug also becomes a NAMESPACE: defFromRow derives `<slug>_run_date`, `<slug>_chat_seq`,
  // `<slug>mention` and the rate-limit bucket from it. The code programs' namespaces do NOT match
  // their slugs (pickleball's slug is 'pickleball' but its keys are `pk_*`), so a program created
  // with slug 'pk' would silently SHARE pickleball's run date, open/lock/sweep markers, chat
  // fingerprint and push tag. Reserve every live namespace token, not just route paths.
  for (const p of PROGRAMS.values()) {
    const cfg = p.config;
    if (cfg.logTag && cfg.logTag === slug) return true;
    if (cfg.mentionTag && cfg.mentionTag === `${slug}mention`) return true;
    if (cfg.chatSeqKey && cfg.chatSeqKey === `${slug}_chat_seq`) return true;
    for (const key of Object.values(cfg.keys || {})) {
      if (typeof key === 'string' && key.startsWith(`${slug}_`)) return true;
    }
  }
  const stack = (app._router && app._router.stack) || [];
  for (const layer of stack) {
    const raw = layer.route && layer.route.path;
    for (const p of (Array.isArray(raw) ? raw : [raw])) {
      if (typeof p === 'string' && p.startsWith('/') && p.split('/')[1] === slug) return true;
    }
  }
  return false;
}

function buildPrograms() {
  PROGRAMS.clear();
  for (const row of db.prepare('SELECT * FROM program ORDER BY id').all()) {
    // Code-defined programs (1/2/3/90) always win by id — their behaviour is frozen. Everything
    // else is built from the row's JSON spec, so an in-app creation needs no deploy.
    const def = PROGRAM_DEFS[row.id] || defFromRow(row);
    if (!def) continue; // a row with neither an engine nor a valid spec is inert, never a crash
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
  // ladder: the path only when that program keeps score, '' otherwise — so a view can offer the
  // link without knowing anything about the feature flag.
  for (const [id, p] of PROGRAMS) meta[id] = { chat: p.paths.chat, season: p.paths.season, seasonLabel: p.seasonLabel,
    ladder: ((p.config.features || {}).ladder ? `${p.paths.run}/ladder` : ''),
    teams: ((p.config.features || {}).teams ? `${p.paths.run}/teams` : '') };
  setProgramMeta(meta);
  // Same idea for the PCO sync: it labels the "sports played" custom field from the registry, so
  // adding a program needs no edit in pco.js. Built from the program KEY (the canonical sport
  // name — 'basketball', 'volleyball'), not displayName: display names carry branding prefixes
  // ("ADV Basketball") that don't belong in a church-facing sport list. Demo is filtered out on
  // the sync side by program id.
  const labels = {};
  for (const [id, p] of PROGRAMS) labels[id] = p.key.charAt(0).toUpperCase() + p.key.slice(1);
  pcoSetProgramLabels(labels);
}
buildPrograms();
// Config guard (fail loud at boot, not silently at 2 PM): BASKETBALL's inline confirm sweep runs
// inside the post-lock branch (autoRunState), so a confirmCutoff EARLIER than its 14:00 lock would
// silently fire at lock time instead of the configured hour. Generic programs sweep independently
// of their lock (vb legitimately locks at 18:00 with a 16:30 cutoff) — only program 1 is coupled.
{
  const c = P(1).config;
  if (c.confirmCutoff && c.lockTime && c.confirmCutoff < c.lockTime)
    throw new Error(`[config] basketball: confirmCutoff (${c.confirmCutoff}) must be >= lockTime (${c.lockTime}) — the inline sweep runs post-lock`);
}
// Register run routes for programs beyond basketball (/checkin/*) + pickleball (/pickleball/*),
// which keep their inline routes — e.g. volleyball via the config-driven factory. After
// buildPrograms() so P(id) is hydrated (mountRunProgram reads program.paths.run).
// Mounting is idempotent + incremental: a program CREATED at runtime gets its routes without a
// restart. Express matches layers in registration order, so normal requests reach routes added
// later — but an error middleware only catches throws from layers registered BEFORE it. Runtime
// mounts therefore re-append the terminal handler (see terminalError), or a throw in a
// brand-new program's route would fall through to Express's stack-trace-leaking default.
const MOUNTED_PROGRAMS = new Set();
function mountPendingPrograms() {
  let mounted = 0;
  for (const p of PROGRAMS.values()) {
    if (p.id >= 3 && !MOUNTED_PROGRAMS.has(p.id)) { mountRunProgram(app, p); MOUNTED_PROGRAMS.add(p.id); mounted++; }
  }
  // Boot registers the handler once, just below; only later mounts need a fresh trailing copy.
  if (mounted && TERMINAL_REGISTERED) app.use(terminalError);
  return mounted;
}
// Terminal error handler — registered LAST (after every inline + mounted route) so a sync throw
// (or a forwarded async reject via next(e)) in ANY route lands here with a friendly 500 instead of
// a hung socket OR Express's stack-trace-leaking default handler. Must be the last app.use (4-arg).
function terminalError(err, req, res, next) {
  console.error(`[route-error] ${req.method} ${req.originalUrl}: ${(err && err.stack) || err}`);
  if (res.headersSent) return next(err);
  res.status(500).send('Something went wrong on our end. Please try again in a moment.');
}
let TERMINAL_REGISTERED = false;
mountPendingPrograms();
app.use(terminalError);
TERMINAL_REGISTERED = true;
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
  // PCO daily delta poll — the inbound path when no webhook is registered, AND the thing that keeps
  // an OAuth grant alive. Two facts make the second part load-bearing: PCO honours a refresh token
  // for 90 days from when its access token was issued, and a refresh only happens INSIDE an API
  // call. The 60s tick makes no call when there's nothing to sync, so a quiet off-season could
  // otherwise let the grant lapse and force the church to re-authorize. One call a day keeps the
  // chain rolling with a ~89-day margin. No-ops entirely when not connected.
  // A paused PCO connection stops the keep-alive, and the refresh window is finite — so admins are
  // pushed the moment it breaks rather than discovering it on a screen weeks later.
  pcoSetNotifier((title, body) => sendPush(ADMINS, { title, body, url: '/admin/pco', tag: 'pcoauth' }));
  // Reconcile roster: FLOOR players only, per program partition, demo excluded. Injected because
  // "who counts as expected" is program logic — pco.js's own fallback would count waitlisters (who
  // correctly stayed home) and other programs sharing the date as no-shows in a church-visible report.
  pcoSetRosterProvider((rd) => {
    const out = [];
    for (const { p: pid } of db.prepare('SELECT DISTINCT program_id p FROM checkins WHERE run_date = ?').all(rd)) {
      if (pid === 90 || !PROGRAMS.has(pid)) continue;
      const part = pid === 1 ? partitionRun(rd) : partitionFor(pid, rd);
      const floor = (P(pid).config.offerWindow ? part.floorReal : part.floor) || [];
      for (const f of floor) {
        const em = String(f.email || '').toLowerCase();
        if (!/@(guest|demo)\.local$/.test(em)) out.push({ email: em, name: f.name || em });
      }
    }
    return out;
  });
  const pcoDailyRun = () => pcoDaily().catch(e => console.error(`[pco] daily sync FAILED: ${e.message}`));
  pcoDailyRun();
  setInterval(pcoDailyRun, 24 * 60 * 60 * 1000).unref();
});
