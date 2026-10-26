// server.js — The Bridge Adv Runs
import express from 'express';

import db from './db.js';
import { PORT, ADMIN_EMAILS_ENV, ENABLE_TEST_TICK } from './config.js';
import { startBackups } from './backup.js';
import { emailConfigured } from './mailer.js';
import { pcoTick, pcoDaily, pcoSetNotifier, pcoSetRosterProvider } from './pco.js';
import { requireAdmin, ADMINS, setSessionVersionLookup } from './auth.js';
import { pickleballPage, pkJoinPage } from './views.js';
import { getSetting } from './lib/settings.js';
import { pruneAuditLog } from './lib/audit.js';
import { sendPush, initPush } from './lib/push.js';
import { mountHttpBasics } from './lib/http.js';
import { schedNow } from './lib/dates.js';
import { refreshAvatarMap, pruneOldMedia } from './lib/media.js';
import { P, PROGRAMS } from './engine/programs.js';
import { reloadRunSettings, nextRunDate, CAP } from './engine/basketball-calendar.js';
import { fireScheduledAnnouncements } from './engine/announcements.js';
import { partitionFor, partitionRun } from './engine/seating.js';
import { ensureWeek } from './engine/basketball.js';
import { buildPrograms } from './engine/program-loader.js';
import { startScheduler } from './engine/scheduler.js';
import { registerTerminalError } from './routes/errors.js';
import { mountChat, mountPlayerSearch } from './routes/chat.js';
import { mountPendingPrograms, mountInlineRunRoutes } from './routes/run-routes.js';
import { demoWorld } from './lib/demo-world.js';
import { mountAssets, mountIntake, mountLegal, mountInvite } from './routes/public.js';
import { mountAuth, mountStatus } from './routes/auth.js';
import { mountDemoMode, mountDemoRunControls } from './routes/demo.js';
import { mountAnnouncements } from './routes/announcements.js';
import { mountPush } from './routes/push.js';
import { mountWaivers } from './routes/waivers.js';
import { mountRunsHub } from './routes/runs.js';
import {
  mountCheckin, mountRosterRedirect, mountCheckinActions, mountSeasonAndCalendar,
} from './routes/checkin.js';
import { mountPoll } from './routes/poll.js';
import { mountProfile, mountProfileSettings } from './routes/profile.js';
import { mountMessages } from './routes/messages.js';
import { mountFriends, mountFriendParties } from './routes/friends.js';
import { mountAdmin, mountAdminReports, mountNavLocalizer, mountPeopleRecords } from './routes/admin.js';
import { mountKiosk } from './routes/kiosk.js';
import { mountHealth } from './routes/health.js';
import { mountProgramsAdmin } from './routes/programs-admin.js';
import { mountPco } from './routes/pco.js';

// Demo mode (DEMO_MODE=1, docs/DEMO.md) seeds itself: a fresh, wiped database gets the synthetic
// world (fixtures/world.mjs) before any code below reads state. guard.js has already refused a
// database holding anyone outside the fixture domain, so this never writes into real data. The
// fixture module is loaded only in demo mode; production never imports it.
if (demoWorld && db.prepare('SELECT COUNT(*) n FROM applicants').get().n === 0) {
  const { today } = demoWorld.seedWorld(db);
  console.log(`[demo] seeded the synthetic world for ${today}`);
}

const app = express();
reloadRunSettings();

initPush();

mountHttpBasics(app);

mountAssets(app);
refreshAvatarMap(); // prime at boot so already-set photos render on the first request

mountIntake(app);

mountAuth(app);

mountDemoMode(app);

// ---------- DEMO MODE (DEMO_MODE=1, docs/DEMO.md) ----------
mountLegal(app);

mountInvite(app);

mountAnnouncements(app);

mountPush(app);

// ---------- INVITE LINK (self-serve pre-approval) ----------
mountStatus(app);

mountWaivers(app);

// ---------- CHECK-IN ----------
mountRunsHub(app);

mountCheckin(app);

mountPoll(app);

mountRosterRedirect(app);

mountProfile(app);

mountMessages(app);

// ---------- MESSAGES (in-app, host <-> players) ----------
mountPlayerSearch(app);

mountFriends(app);

// ---------- SOCIAL GRAPH (Phase 6: friends + block) ----------
mountChat(app);

mountCheckinActions(app);

mountAdmin(app);

// ---------- SESSIONS (S1) ----------
// Version lookup for auth.js: applicants row for members; an app_settings fallback covers admins
// with no applicant row (admin identity is the ADMINS env set, a row is optional).
const stmtSessVer = db.prepare('SELECT session_ver v FROM applicants WHERE email = ?');
setSessionVersionLookup((email) => {
  const row = stmtSessVer.get(String(email).toLowerCase());
  if (row) return row.v || 0;
  return Number(getSetting('sessver_' + String(email).toLowerCase()) || 0);
});

mountProfileSettings(app);

mountAdminReports(app);

mountKiosk(app);

mountHealth(app);

// ---------- HEALTH (S4) ----------
mountNavLocalizer(app);

mountProgramsAdmin(app);

mountPco(app);

// ---------- Planning Center sync (Phase 1) — admin console + webhook ----------
mountPeopleRecords(app);

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

mountSeasonAndCalendar(app);

mountInlineRunRoutes(app);

mountDemoRunControls(app);

// ---------- DEMO run controls (admin-only showcase) ----------
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

mountFriendParties(app);
// ---------- QUEUE-WITH-FRIENDS (Phase 6b: a party seats atomically) ----------
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
