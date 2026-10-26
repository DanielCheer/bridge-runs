// server.js — The Bridge Adv Runs
import express from 'express';

import db from './db.js';
import { PORT, PUBLIC_URL, ADMIN_EMAILS_ENV, ENABLE_TEST_TICK } from './config.js';
import { startBackups } from './backup.js';
import { emailConfigured } from './mailer.js';
import {
  pcoTick, pcoDaily, pcoStatus, pcoConnect, pcoDisconnect, pcoSetAutocreate, pcoRunInitialLink,
  pcoCreateBridgeOnly, pcoHandleWebhook, pcoReconcile, pcoVerifyPasses, pcoBarcodeRows,
  pcoVerifyWaivers, pcoSetWaiverForm, pcoSaveOAuthApp, pcoOAuthStartUrl, pcoOAuthCallback,
  pcoOAuthConfigured, pcoSetNotifier, pcoFieldsPending, pcoSetRosterProvider, pcoPushFields,
  pcoSetAttendanceFields, pcoSetWaiverFields,
} from './pco.js';
import { requireAdmin, ADMINS, setSessionVersionLookup } from './auth.js';
import { pickleballPage, pkJoinPage, pcoAdminPage } from './views.js';
import { getSetting, setSetting, delSetting } from './lib/settings.js';
import { audit, pruneAuditLog } from './lib/audit.js';
import { sendPush, initPush } from './lib/push.js';
import { mountHttpBasics } from './lib/http.js';
import { schedNow } from './lib/dates.js';
import { csvCell } from './lib/csv.js';
import { refreshAvatarMap, pruneOldMedia } from './lib/media.js';
import { P, PROGRAMS, programRunDate } from './engine/programs.js';
import { reloadRunSettings, nextRunDate, CAP } from './engine/basketball-calendar.js';
import { fireScheduledAnnouncements } from './engine/announcements.js';
import { partitionFor, partitionRun } from './engine/seating.js';
import { migrateConfirmMarkers } from './engine/run-engine.js';
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
