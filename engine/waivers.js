// engine/waivers.js — waivers: the club-wide attestation stamp and per-program waivers, including
// guardian consent for minors.
import db from '../db.js';
import { applicantByEmail, isMinor, ageFromDob } from './applicants.js';
import { P, PROGRAMS } from './programs.js';

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

export {
  stampWaiver, programWaiver, waiverSatisfied, waiverNeedsGuardian, waiverProgramFromReq,
  waiverGateUrl,
};
