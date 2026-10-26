// engine/renewals.js — auto-renew: seating renewers when a run opens, and the no-show penalty
// (strikes, pause, lift) that keeps a renewed seat honest.
import db from '../db.js';
import { audit } from '../lib/audit.js';
import { sendPush } from '../lib/push.js';
import { ymdLocal, schedNow, shiftYmd, runLabelFor } from '../lib/dates.js';
import { P, doorMode } from './programs.js';
import { waiverSatisfied } from './waivers.js';
import { partitionFor } from './seating.js';

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
  let team, nonTeam = [];
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

export {
  seatRenewers, liftExpiredPauses, assessRenewPenalties, stmtPmEnsureRow, penaltyStateFor,
};
