// engine/run-engine.js — the program-generic weekly engine: each program's scheduler step (auto
// open, run-day ping, lock, confirm sweep), the weekly rollover (archive, purge, re-seat), removing
// a player from a run with the offer it triggers, and season-start changes.
import db from '../db.js';
import { setSetting, getSetting, delSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { lc } from '../lib/email.js';
import { sendPush } from '../lib/push.js';
import { schedNow, shiftYmd, fmtClockLabel, runLabelFor, hhLocal, ymdLocal } from '../lib/dates.js';
import {
  PROGRAMS, programRunDate, P, programMemberEmails, runOpenFor, runCancelledFor,
  effectiveConfirmCutoff, programActive, endHHMM, doorMode, programSeasonStart, setRunStateFor,
  endMinutesOf, minutesOfDay,
} from './programs.js';
import {
  partitionFor, writeRunSummary, createOffer, offereeForFloorLeave, waitlistOrderFor,
  pingWaitlistShift, stmtDelCheckinRow, seatWaitingGuest, notifyPromotionFor,
} from './seating.js';
import { clearRunParties, setPartyDeclinedFor } from './parties.js';
import { clearRunTeams, clearTeamAssignment } from './teams.js';
import { seatRenewers, liftExpiredPauses, assessRenewPenalties } from './renewals.js';

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

export {
  dropFromPickleball, ensureWeekFor, migrateConfirmMarkers, applySeasonStart, removeFromRun,
  autoRunStateFor,
};
