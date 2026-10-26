// server.js — The Bridge Adv Runs
import express from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';

import db, { rekeyEmailTx, transact } from './db.js';
import { DEMO_MODE } from './guard.js';
import {
  APP_ROOT, PORT, PUBLIC_URL, OFFER_WINDOW_HOURS, AVATARS_DIR, CHAT_MEDIA_DIR, EXPORT_TMP_DIR,
  ADMIN_EMAILS_ENV, LEGAL_ENV, LEGAL, DEMO_RESET_HOURS, DEMO_RESET_COOLDOWN_MS, ENABLE_TEST_TICK,
} from './config.js';
import { startBackups } from './backup.js';
import { sendMagicLink, sendAnnouncement, emailConfigured } from './mailer.js';
import {
  pcoTick, pcoDaily, pcoStatus, pcoConnect, pcoDisconnect, pcoSetAutocreate, pcoRunInitialLink,
  pcoCreateBridgeOnly, pcoQueuePatch, pcoHandleWebhook, pcoReconcile, pcoKioskArrivals,
  pcoVerifyPasses, pcoBarcodeRows, pcoVerifyWaivers, pcoSetWaiverForm, pcoSaveOAuthApp,
  pcoOAuthStartUrl, pcoOAuthCallback, pcoOAuthConfigured, pcoSetNotifier, pcoFieldsPending,
  pcoSetRosterProvider, pcoPushFields, pcoSetAttendanceFields, pcoSetWaiverFields,
} from './pco.js';
import {
  setSession, clearSession, currentUser, isAdmin, requireLogin, requireAdmin, ADMINS,
  setSessionVersionLookup,
} from './auth.js';
import {
  intakePage, loginPage, checkinPage, adminPage, statusPage, peoplePage, invitePage, sharePage,
  exportPage, logoutPage, APP_JS, profilePage, profileTabPage, threadPage, claimResultPage, BUILD_VER,
  mdToHtml, legalPage, bannerPage, confirmActionPage, seasonPage, profileCard, demoProfileCard,
  pickleballPage, runsPage, pkJoinPage, pastRunPage, waiverPage, friendsPage, friendsSearchFragment,
  pcoAdminPage, programsAdminPage, kioskPage, analyticsPage, auditViewerPage, runHistoryPage,
  ladderBoardPage, WAIVER_URL, setDemoMode, demoResetPage,
} from './views.js';
import { getSetting, setSetting, delSetting } from './lib/settings.js';
import { audit, metric, pruneAuditLog } from './lib/audit.js';
import { isValidEmail, lc } from './lib/email.js';
import { rateLimited } from './lib/rate-limit.js';
import { sendPush, VAPID_PUBLIC, initPush } from './lib/push.js';
import { clientIp, safeNextPath, mountHttpBasics } from './lib/http.js';
import { createLoginLink, signIn } from './lib/sign-in.js';
import { ymdLocal, fmtClockRange, fmtClockLabel, schedNow, runLabelFor, runWeekday } from './lib/dates.js';
import { csvCell } from './lib/csv.js';
import { dmDec, dmEnc } from './lib/dm-crypto.js';
import {
  BANNER_PATH, refreshAvatarMap, bannerVersion, uploadAvatar, sniffImage, safeUnlinkAvatar,
  uploadChatImage, processChatImage, writeChatImage, stickerPath, safeUnlinkChatImage, uploadBanner,
  writeFileAtomic, pruneOldMedia,
} from './lib/media.js';
import {
  approverEmails, isMinor, applicantByEmail, approvedEmails, ageFromDob, applicantIdOf,
  stmtApplicantById, voteInfo,
} from './engine/applicants.js';
import {
  P, PROGRAMS, programRunDate, runOpenFor, runCancelledFor, effectiveConfirmCutoff, setRunCookie,
  pkRunDate, pkIsOpen, pkIsCancelled, runCookie, programActive, startHHMM, endHHMM,
  joinProgramMembership, programDefaultDate,
} from './engine/programs.js';
import {
  reloadRunSettings, nextRunDate, CAP, WAITLIST_CAP, TOTAL_CAP, PREREG_CAP, OPEN_H, openDateFor,
  runTimeRange, runStartLabel, runStartEpoch, runIsOpen, runIsCancelled, runIsLocked, runDayFor,
  setRunOpen, setRunCancelled, runOverrideRow, runBaseFor, DEFAULT_START, DEFAULT_END, seasonStart,
  stmtRunIsOpen, runTimesFor,
} from './engine/basketball-calendar.js';
import {
  announcementRecipients, parseScheduleAt, fmtScheduleAt, armScheduleTimer, latestAnnouncement,
  markAnnouncementsSeen, latestAnnouncementFor, annPanel, announcementUnread, latestPkAnnouncement,
  announcementHistory, fireScheduledAnnouncements,
} from './engine/announcements.js';
import {
  stampWaiver, programWaiver, waiverSatisfied, waiverNeedsGuardian, waiverProgramFromReq,
} from './engine/waivers.js';
import {
  createOffer, offereeForFloorLeave, heldReleased, partitionFor, partitionRun, OFFER_WINDOW_MS,
  pkPartition, waitlistOrderFor, pingWaitlistShift, stmtConfirmSet, stmtConfirmClear,
} from './engine/seating.js';
import {
  clearRunParties, stmtPartyInvitesFor, stmtPartyMemberRows, myPersistentParty, partyCap,
  stmtPartyLedBy, persistentPartyActive, stmtPartyRow,
} from './engine/parties.js';
import {
  friendsGamesFor, canMessage, blockedPair, iBlocked, isFollowing, relationshipTo, friendsOf,
  followersOf, friendReqIncomingCount, stmtBlockedByMe, followingOf, peopleByEmails, searchResultsFor,
  friendRequest, friendAccept, friendDecline, friendRemove, doBlock, doUnblock, doFollow, doUnfollow,
} from './engine/social.js';
import {
  groupUnread, chatProgramFor, chatCountsFor, groupMentionUnread, stmtPollChat, stmtPollChatReact,
  stmtPollPkChat, stmtPollPkChatReact, chatPollFingerprint, validEmoji,
} from './engine/chat.js';
import { unreadCount, loadInbox, notifyDM } from './engine/messages.js';
import {
  ladderCfg, ladderRunDate, ladderFrom, ladderStandings, ladderNominations, ladderNomsKey,
  purgeLadderIdentity,
} from './engine/ladder.js';
import { migrateGamesNight, purgeGameIdentity, teamFillCore } from './engine/teams.js';
import {
  dropFromPickleball, ensureWeekFor, migrateConfirmMarkers, applySeasonStart,
} from './engine/run-engine.js';
import { autoJoinTeam, loadRun, ensureWeek } from './engine/basketball.js';
import { PROGRAM_THEMES, slugIsReserved, buildPrograms } from './engine/program-loader.js';
import { recomputeStatus } from './engine/council.js';
import { startScheduler } from './engine/scheduler.js';
import { requireApprover, requirePlayer, mutedOut, requireCouncil } from './routes/guards.js';
import { registerTerminalError } from './routes/errors.js';
import { mountChat, mountPlayerSearch } from './routes/chat.js';
import {
  runBannerGet, runBannerPost, mountPendingPrograms, MOUNTED_PROGRAMS, mountInlineRunRoutes,
} from './routes/run-routes.js';

// Demo mode (DEMO_MODE=1, docs/DEMO.md) seeds itself: a fresh, wiped database gets the synthetic
// world (fixtures/world.mjs) before any code below reads state. guard.js has already refused a
// database holding anyone outside the fixture domain, so this never writes into real data. The
// fixture module is loaded only in demo mode; production never imports it.
const demoWorld = DEMO_MODE ? await import('./fixtures/world.mjs') : null;
if (demoWorld && db.prepare('SELECT COUNT(*) n FROM applicants').get().n === 0) {
  const { today } = demoWorld.seedWorld(db);
  console.log(`[demo] seeded the synthetic world for ${today}`);
}

const app = express();
const stmtAnnouncementExists = db.prepare('SELECT 1 FROM announcements WHERE id = ? AND program_id = 1');
reloadRunSettings();

initPush();

mountHttpBasics(app);
// Profile-photo storage. Defaults to public/avatars (served by the general static
// mount below); AVATARS_DIR lets a test/other env point it elsewhere. Mounted at
// /avatars BEFORE the public static so an override wins, yet a missing file falls
// through to the public mount (keeps the hand-placed daniel.jpg seed working even
// when AVATARS_DIR is a temp dir). Created on boot so the first upload never ENOENTs.
app.use('/avatars', express.static(AVATARS_DIR, { maxAge: '365d', immutable: true })); // content-addressed name + ?v= bust → safe to pin
// Chat photo storage. Same override pattern as avatars: CHAT_MEDIA_DIR points it
// elsewhere in test/other envs and is mounted at /chat-media BEFORE the public static
// so an override wins, yet a missing file falls through. Created on boot so the first
// upload never ENOENTs. Stickers live in public/stickers and are served by the general
// public mount below (no per-file DB — validated by name against STICKERS on send).
app.use('/chat-media', express.static(CHAT_MEDIA_DIR, { maxAge: '365d', immutable: true })); // <msgid>-<hex> names never rewritten → safe to pin
// The service worker must never be pinned by HTTP cache (it controls the whole app),
// so serve it no-cache from the same public dir, ahead of the 7-day static mount.
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(APP_ROOT, 'public', 'sw.js'));
});
// The client engine (router/poll/swap/push/badges/logout — see APP_JS in views.js),
// extracted from an inline HEAD script so it caches once instead of re-shipping ~15KB per
// page. The URL carries ?v=BUILD_VER (tracks views.js/styles.css mtime), so any code change
// mints a fresh URL; the body is byte-identical for a given build → cache a year, immutable.
app.get('/app.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('application/javascript').send(APP_JS);
});
// The waiver QR is generated from WAIVER_URL instead of being shipped as an image, so the code
// people scan always encodes the same link printed beside it, and no organization's real form is
// baked into the repo. WAIVER_URL is fixed for the life of the process, so the SVG is rendered
// once, on first request, and reused. No WAIVER_URL → no QR (views render no section) → 404.
let waiverQrSvg = null;
app.get('/waiver-qr.svg', async (req, res, next) => {
  if (!WAIVER_URL) return next();
  try {
    waiverQrSvg ??= await QRCode.toString(WAIVER_URL, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
    res.set('Cache-Control', 'public, max-age=604800').type('image/svg+xml').send(waiverQrSvg);
  } catch (e) { next(e); } // QR failure must not take the process down (Express 4 won't catch async throws)
});
app.use(express.static(path.join(APP_ROOT, 'public'), { maxAge: '7d', immutable: false }));

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
refreshAvatarMap(); // prime at boot so already-set photos render on the first request
// --- attendance ("games attended") helpers -------------------------------
// The attendance table is the permanent log of who was on the FINAL floor each
// Friday; loadRun() archives into it right before its weekly checkins purge.
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

// ---------- DEMO MODE (DEMO_MODE=1, docs/DEMO.md) ----------
// The public demo: a persona picker on /login, a strip on every page, and a clean world on a
// timer. Resetting is a process exit: scripts/run-demo.mjs wipes the database and upload folders
// and starts a fresh server, so "reset" can never leave a half-cleared world behind.
if (DEMO_MODE) {
  const PERSONAS = demoWorld.DEMO_PERSONAS;
  const personaEmail = new Map(PERSONAS.map(p => [p.key, p.email]));
  const organizer = PERSONAS.find(p => p.key === 'organizer');
  if (!isAdmin(organizer.email))
    throw new Error(`[demo] ADMIN_EMAILS must include the organizer persona (${organizer.email}) — scripts/run-demo.mjs sets it`);
  const RESET_HOURS = DEMO_RESET_HOURS;
  // One reset per minute: each reset restarts the process, so a minimum uptime IS the rate limit
  // (an in-memory limiter would be wiped by the very reset it limits).
  const RESET_COOLDOWN_MS = DEMO_RESET_COOLDOWN_MS;
  if (!(RESET_HOURS > 0) || !(RESET_COOLDOWN_MS >= 0))
    throw new Error('[demo] DEMO_RESET_HOURS must be > 0 and DEMO_RESET_COOLDOWN_S >= 0');
  setDemoMode(true, { personas: PERSONAS, resetHours: RESET_HOURS });

  const exitForReset = (why) => {
    console.log(`[demo] ${why} — exiting so the supervisor restarts on a clean world`);
    process.exit(0);
  };
  setTimeout(() => exitForReset(`scheduled reset after ${RESET_HOURS} h`), RESET_HOURS * 3600_000);

  // Sign in as a fixture persona. Only the keys in DEMO_PERSONAS map to an account; /status then
  // routes by account state (approved or admin → /runs, pending → its status page).
  app.post('/demo/login', (req, res) => {
    const email = personaEmail.get(String(req.body.persona || ''));
    if (!email) return res.status(400).send(loginPage({ error: 'Pick one of the demo people.' }));
    signIn(res, email, 'demo persona');
    res.redirect('/status');
  });

  let resetting = false;
  app.get('/demo/reset', requireAdmin, (req, res) => res.send(demoResetPage()));
  app.post('/demo/reset', requireAdmin, (req, res) => {
    if (resetting || process.uptime() * 1000 < RESET_COOLDOWN_MS)
      return res.status(429).send('The demo was reset less than a minute ago. Try again shortly.');
    resetting = true;
    res.on('finish', () => setTimeout(() => exitForReset(`reset requested by ${req.userEmail}`), 100));
    res.send(demoResetPage({ resetting: true }));
  });
}

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
// Who the policies name as the operator/contact: LEGAL (config.js). Unset → the [PLACEHOLDER]
// stays visible on the page (honest about missing config) rather than a made-up value.
for (const [key, env] of Object.entries(LEGAL_ENV)) {
  if (!LEGAL[key]) console.warn(`[legal] ${env} unset — policy pages will show the placeholder`);
}
function renderLegal(key) {
  const d = LEGAL_DOCS[key];
  if (!d) return null;
  let md;
  try { md = fs.readFileSync(path.join(APP_ROOT, 'legal', d.file), 'utf8'); } catch { return null; }
  md = md.replace(/^\s*\*\*[^\n]*DRAFT[^\n]*\*\*\s*\n/, '');                 // drop the operator-only draft note
  md = md.replace(/\[DATE\]/g, LEGAL.date || '$&')                          // '$&' = leave the token as-is
         .replace(/\[HOST NAME\]/g, LEGAL.name || '$&')
         .replace(/\[NAME — e\.g\.,[^\]]*\]/g, 'Google (Gmail)')             // the email service sub-processor
         .replace(/\[NAME\]/g, LEGAL.name || '$&')
         .replace(/\[EMAIL\/PHONE\]/g, LEGAL.email || '$&')
         .replace(/\[EMAIL\]/g, LEGAL.email || '$&')
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
    return res.redirect('/checkin?msg=' + encodeURIComponent(`Scheduled for ${fmtScheduleAt(schedAt)}.`));
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
// Hot-path lookups rendered on the check-in page (and reused by the join guard) —
// prepared once at module scope (node:sqlite has no statement cache).
const stmtOptedOut = db.prepare('SELECT 1 FROM regular_optout WHERE run_date = ? AND email = ? AND program_id = 1');
const stmtMyConfirmed = db.prepare('SELECT confirmed_at FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1'); // hoisted — hottest page
const stmtPreregCount = db.prepare(`SELECT COUNT(*) r FROM checkins c
    JOIN applicants ap ON ap.email = c.email
    WHERE c.run_date = ? AND c.program_id = 1 AND (ap.is_regular = 1 OR ap.is_team = 1)`);
const stmtHostCard = db.prepare("SELECT * FROM applicants WHERE is_host = 1 AND status = 'approved'");
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

// ---------- MESSAGES (in-app, host <-> players) ----------
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

mountPlayerSearch(app);

// ---------- SOCIAL GRAPH (Phase 6: friends + block) ----------
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

mountChat(app);

// ---------- PICKLEBALL CHAT — delegates to the generic runChat* handlers (program 2) ----------
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
    const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
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
  const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
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
function parseProgramForm(body, { existingSlug = null, app } = {}) {
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
    if (slugIsReserved(slug, app)) return { error: `“/${slug}” is already used by the app — pick a different web address.` };
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
  const parsed = parseProgramForm(req.body, { app: req.app });
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
  mountPendingPrograms(app);     // routes live immediately — no restart
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
  const parsed = parseProgramForm(req.body, { existingSlug: row.slug, app: req.app });
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
  mountPendingPrograms(app);
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
  const base = (PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
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

startScheduler();

// Test-only: synchronously run every program's scheduler tick (rollover + auto open/ping/lock).
// Mounted ONLY when ENABLE_TEST_TICK=1 so it can never exist in prod — lets the harness drive the
// clock phases (paired with TEST_NOW) without waiting for the 60s interval. Precedent: FORCE_HELD_RELEASED.
if (ENABLE_TEST_TICK) {
  app.post('/admin/test/tick', requireAdmin, async (req, res) => {
    for (const p of PROGRAMS.values()) p.tick();
    try { fireScheduledAnnouncements(); } catch (e) { console.error(e.message); }
    await pcoTick();                                  // awaited so the harness can assert right after
    if (req.body && req.body.pcodaily) await pcoDaily(); // opt-in: also run the nightly delta poll
    res.json({ ok: true, now: schedNow() });
  });
  // Test-only: the live Express stack, one layer per line in registration order, so a refactor that
  // moves routes between files can prove the mounted set, its order and each route's middleware
  // chain are unchanged (test/routes.test.mjs compares it to test/snapshots/routes.txt).
  app.get('/admin/test/routes', requireAdmin, (req, res) => {
    const name = (fn) => (fn && fn.name) || '<anonymous>';
    const lines = [];
    for (const layer of app._router.stack) {
      if (layer.route) {
        const chain = layer.route.stack.map((l) => name(l.handle)).join(' ');
        lines.push(`${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}  [${chain}]`);
      } else {
        lines.push(`USE ${layer.regexp.fast_slash ? '/' : layer.regexp.source} ${name(layer.handle)}`);
      }
    }
    res.type('text/plain').send(lines.join('\n') + '\n');
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

mountInlineRunRoutes(app);

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

// ---------- QUEUE-WITH-FRIENDS (Phase 6b: a party seats atomically) ----------
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
mountPendingPrograms(app);

registerTerminalError(app);
// Boot-time weekly rollover (archive/purge/auto-seat) — MUST run after buildPrograms() so the
// unified engine's P(id).config is hydrated (ensureWeek → autoJoinTeam → seatRenewers reads it).
ensureWeek(nextRunDate());

app.listen(PORT, () => {
  console.log(`\nThe Bridge Adv Runs → http://localhost:${PORT}`);
  console.log(`Cap: ${CAP} · Email: ${emailConfigured ? 'SMTP configured' : 'DEV MODE (links print here)'}`);
  console.log(`Admin emails: ${ADMIN_EMAILS_ENV || '(none set — set ADMIN_EMAILS!)'}\n`);
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
