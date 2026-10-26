// lib/audit.js — the accountability trail (audit_log, plus audit_key_events for the subset kept
// forever) and the identity-free product metrics (metrics_events).
import db from '../db.js';

// Prepared once at module scope — node:sqlite has no statement cache, so re-preparing
// this INSERT on every audited action (every check-in, vote, edit…) is pure waste.
const stmtAudit = db.prepare('INSERT INTO audit_log (actor,actor_role,action,target) VALUES (?,?,?,?)');
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

// audit_log retention: db.js trims to the newest 5000 rows at boot, but a long-lived process
// (weeks between deploys) grows it unbounded in between. Trim on the same daily cadence as media.
function pruneAuditLog() {
  try {
    const { changes } = db.prepare('DELETE FROM audit_log WHERE id < (SELECT MAX(id) - 5000 FROM audit_log)').run();
    if (changes) console.log(`[audit-prune] trimmed ${changes} old audit_log row(s)`);
  } catch (e) { console.error(`[audit-prune] failed: ${e.message}`); }
}

export {
  audit, metric, pruneAuditLog,
};
