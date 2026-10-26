// routes/waivers.js — the waiver gate: show a program's waiver (or the club-wide one) and record
// the attestation, with guardian consent for minors.
import db from '../db.js';
import { requireLogin } from '../auth.js';
import { waiverPage } from '../views.js';
import { audit } from '../lib/audit.js';
import { isValidEmail } from '../lib/email.js';
import { safeNextPath } from '../lib/http.js';
import { applicantByEmail } from '../engine/applicants.js';
import { P } from '../engine/programs.js';
import {
  programWaiver, waiverSatisfied, waiverNeedsGuardian, waiverProgramFromReq, stampWaiver,
} from '../engine/waivers.js';

export function mountWaivers(app) {
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
}
