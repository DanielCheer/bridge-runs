// routes/guards.js — request guards shared by the route modules: the approver and council
// middleware (built from auth.js's factories), requirePlayer (an approved member, else a redirect)
// and mutedOut (a muted member's refusal).
import db from '../db.js';
import { makeRequireApprover, makeRequireCouncil, isAdmin } from '../auth.js';
import { applicantByEmail } from '../engine/applicants.js';

const requireApprover = makeRequireApprover(db);
const requireCouncil = makeRequireCouncil(db);   // /admin + /admin/vote only — the council's one surface

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

export {
  requireApprover, requirePlayer, mutedOut, requireCouncil,
};
