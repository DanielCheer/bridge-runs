// routes/pco.js — Planning Center: the admin console (connect by token or OAuth, link, create,
// webhook, waivers, attendance, door mode, kiosk arrivals, reconcile, passes) and the inbound
// webhook. The sync itself is pco.js.
import express from 'express';
import { PUBLIC_URL } from '../config.js';
import {
  pcoStatus, pcoConnect, pcoSaveOAuthApp, pcoOAuthStartUrl, pcoOAuthConfigured, pcoOAuthCallback,
  pcoDisconnect, pcoRunInitialLink, pcoCreateBridgeOnly, pcoSetAutocreate, pcoSetWaiverFields,
  pcoSetWaiverForm, pcoVerifyWaivers, pcoSetAttendanceFields, pcoFieldsPending, pcoPushFields,
  pcoDaily, pcoHandleWebhook, pcoReconcile, pcoVerifyPasses, pcoBarcodeRows,
} from '../pco.js';
import { requireAdmin } from '../auth.js';
import { pcoAdminPage } from '../views/index.js';
import { setSetting, delSetting, setSecret } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { csvCell } from '../lib/csv.js';
import { P, PROGRAMS, programRunDate } from '../engine/programs.js';
import { nextRunDate } from '../engine/basketball-calendar.js';
import { migrateConfirmMarkers } from '../engine/run-engine.js';

// ---- OAuth: the church authorizes this app from Planning Center's own screen ----
// The redirect URI must match what was registered on the PCO application EXACTLY, so it is derived
// from PUBLIC_URL (the Funnel/production origin) rather than the request host — a request arriving
// on localhost must not mint a localhost redirect that PCO would reject.
function pcoRedirectUri(req) {
  const base = (PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return base + '/admin/pco/oauth/callback';
}

export function mountPco(app) {
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
    if (secret) setSecret('pco_webhook_secret', secret); else delSetting('pco_webhook_secret');
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
}
