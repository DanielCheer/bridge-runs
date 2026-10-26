// engine/basketball.js — program 1's weekly engine: loading the run (expiring and re-offering
// spots), the weekly rollover into the attendance log, seating the team, and the scheduler step
// (auto open, run-day ping, lock, confirm sweep).
import db from '../db.js';
import { sendAnnouncement, emailConfigured } from '../mailer.js';
import { pcoPushFields } from '../pco.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { sendPush } from '../lib/push.js';
import { ymdLocal, fmtClockLabel, schedNow, runLabelFor, runWeekday } from '../lib/dates.js';
import { P, effectiveConfirmCutoff } from './programs.js';
import {
  nextRunDate, CAP, runIsCancelled, runIsLocked, runTimeRange, runIsOpen, setRunOpen, runTimesFor,
  runStateSchedule,
} from './basketball-calendar.js';
import { queueOpenPushEmails, queueOpenEmailRecipients } from './announcements.js';
import {
  writeRunSummary, partitionRun, expireAndReoffer, createOffer, offereeForFloorLeave, waitlistOrderFor,
  pingWaitlistShift, stmtDelCheckinRow,
} from './seating.js';
import { clearTeamAssignment } from './teams.js';
import { seatRenewers, liftExpiredPauses, assessRenewPenalties } from './renewals.js';

// Archive the FINAL floor of past weeks into the permanent attendance log,
// right before loadRun() purges those checkins. "Final floor" = the first CAP
// rows by sort_order,id for each past run_date (waitlist rows, pos>CAP, are not
// credited). INSERT OR IGNORE + UNIQUE(run_date,email) makes it idempotent.
// `offered_at IS NULL` excludes a still-pending/unclaimed spot offer — a held offer that
// was never claimed must NOT earn an attendance credit (a claim clears offered_at, so
// claimed offerees ARE credited). Otherwise an offer that expired after rollover would
// permanently credit someone who never confirmed.
// Number ALL rows, then drop the offered ones — matching partitionRun, where a pending offer
// RESERVES its floor slot (floorCapForReal = CAP - offered.length). Filtering offered rows out
// BEFORE numbering (the old shape) collapses that reserved slot, so the first waitlister slides
// into it and earns a permanent attendance row for a run they spent on the bench. An unclaimed
// offer is still excluded from the insert — nobody played on it.
const stmtArchiveAttendance = db.prepare(`
  INSERT OR IGNORE INTO attendance (run_date, email, name)
  SELECT run_date, email, name FROM (
    SELECT run_date, email, name, offered_at,
           ROW_NUMBER() OVER (PARTITION BY run_date ORDER BY sort_order ASC, id ASC) AS pos
    FROM checkins WHERE run_date < ? AND program_id = 1
  ) WHERE pos <= ? AND offered_at IS NULL`);

// Weekly rollover work — archive last week's final floor into the permanent
// attendance log, purge the now-stale check-ins/opt-outs, and re-seat auto-renew
// team. GATED to fire only when the run_date actually changes (the Saturday-midnight
// rollover) via module-level lastRunDate, plus once at startup and from the 60s
// interval. Previously this ran on EVERY /checkin GET (every ~20s per phone),
// keeping the WAL permanently hot for work that is genuinely week-scoped.
const stmtPurgeCheckins = db.prepare('DELETE FROM checkins WHERE run_date < ? AND program_id = 1');
const stmtPurgeOptouts = db.prepare('DELETE FROM regular_optout WHERE run_date < ? AND program_id = 1');
const stmtPurgeRunState = db.prepare('DELETE FROM run_state WHERE run_date < ? AND program_id = 1');
// Prune a spent override only when BOTH its run_date AND its base Friday are past. The
// base-Friday guard is essential for a run moved EARLIER (e.g. Fri→Thu): after the Thu
// run passes but while its Friday is still today/upcoming, the override must be RETAINED
// so nextRunDate() keeps resolving that Friday to the (now-past, excluded) Thursday and
// falls through to next Friday — pruning on run_date alone would resurrect the Friday.
const stmtPurgeSpentOverrides = db.prepare('DELETE FROM run_overrides WHERE run_date < ? AND default_date < ?');
// Rollover is keyed off the ACTUAL upcoming run date (cur = nextRunDate()), NOT a fixed
// Friday. lastRunDate stores that actual date; the rollover fires exactly when cur
// advances — i.e. when the previous run has passed and a later one becomes soonest. This
// is correct whether the run was moved EARLIER or LATER than its Friday: e.g. a run moved
// to Saturday keeps cur on that Saturday through the run day and only advances the day
// AFTER, so the archive/purge fires after the run has happened, never during it.
//
// Why this cannot purge today's/current run: the purge cutoff is `run_date < cur`, and
// cur is the SOONEST run on-or-after today, so no run_date lies in [today, cur) — every
// current-or-future run is ≥ cur and is preserved; only strictly-past runs are purged.
// Why it cannot double-archive: attendance archiving is INSERT OR IGNORE on
// UNIQUE(run_date,email), and the whole body is gated to fire once per cur transition.
let lastRunDate = null;
function ensureWeek(runDate = nextRunDate()) {
  if (runDate === lastRunDate) return; // no-op until the soonest run date advances (rollover)
  // Archive/purge cutoff = TODAY, never `runDate` (cur). cur is the soonest UPCOMING run and is
  // always ≥ today; under normal weekly rollover today and cur select the same past runs. But if
  // cur JUMPS FORWARD past a future run that still has check-ins (e.g. a season-start gate is set,
  // or a run is moved weeks out), a cur-based cutoff would archive that FUTURE run's roster as
  // attendance and purge it — corrupting the season board + losing the roster. Cutting off at
  // today archives only runs that have actually ended.
  const t = ymdLocal();
  // Metrics layer: one summary row per ended run, written while its checkins/run_state still
  // exist. UNION picks up cancelled/zero-join weeks that have a state row but no checkins.
  for (const r of db.prepare(`SELECT run_date FROM checkins WHERE run_date < ? AND program_id = 1
    UNION SELECT run_date FROM run_state WHERE run_date < ? AND program_id = 1`).all(t, t)) writeRunSummary(1, r.run_date);
  stmtArchiveAttendance.run(t, CAP);  // archive the final floor of every run that has ended
  // Attendance just changed for everyone who played → refresh their PCO People custom fields.
  // Fire-and-forget: a PCO outage must never stall the weekly rollover, and the 60s tick's slow
  // drain picks up anyone missed (signature-diffed, so it re-pushes only what actually changed).
  pcoPushFields(50).catch(e => console.error(`[pco] profile-field push after rollover FAILED: ${e.message}`));
  stmtPurgeCheckins.run(t);           // then purge those now-past runs' checkins…
  stmtPurgeOptouts.run(t);            // …opt-outs…
  stmtPurgeRunState.run(t);           // …and stale open/closed state
  stmtPurgeSpentOverrides.run(t, t);  // drop fully-past overrides
  autoJoinTeam(runDate);              // re-seat auto-renew team onto the new run
  lastRunDate = runDate;
}

function loadRun(req) {
  const runDate = nextRunDate();
  ensureWeek(runDate); // rollover-gated archive/purge/auto-seat (no-op until the run date advances)
  // Offer expiry stays LAZY here (idle cost = one ≤20-row SELECT) so a stale hold
  // never blocks the floor on a real view; the 60s interval covers zero-viewer windows.
  expireAndReoffer(runDate, req);
  const part = partitionRun(runDate);
  return {
    runDate,
    inPlayers: part.floorReal,        // real, confirmed floor players
    offeredPlayers: part.offered,     // held pending-claim spots (count as taken, not "on the floor")
    waitPlayers: part.waitPlayers,
    totalCount: part.rows.length,
    part, // full partition — shared with the /runs hub-card badge (myRunStatusFor) so it isn't recomputed
  };
}

// Basketball's auto-renew team seating, now on the unified engine (Phase 3c). Keeps its
// root-cause guard — never re-seat a cancelled run (floor cleared) or a locked one (past 2 PM,
// roster set) so no caller (optin/autorenew/open/rollover) re-populates — then delegates to
// seatRenewers, which reads P(1).config.autoRenew.from='team': only the org team
// (applicants.is_team, approved, auto_renew, waiver_ok, not-suspended, not-opted-out this week)
// is seated, TOP priority via negative sort_order, trimmed to cap+waitlist. NO non-team fill
// (basketball auto-renews only the team; "no waiver, no play" preserved by the shared engine).
function autoJoinTeam(runDate) {
  if (runIsCancelled(runDate) || runIsLocked(runDate)) return;
  liftExpiredPauses(1);              // clear elapsed auto-renew pauses before re-seating (dark w/o P(1).config.autoRenewPenalty)
  seatRenewers(1, runDate);
}
function autoRunState() {
  const { rd, openAt, closeAt } = runStateSchedule();
  const now = schedNow();   // == Date.now() in prod; honours the TEST_NOW seam like the generic engine
  // Confirm cutoff (config.confirmCutoff, absolute 'HH:MM'): unconfirmed floor spots are
  // RELEASED to the waitlist at this time on run day (owner rule — 4:30 PM). Door mode
  // (effectiveConfirmCutoff → null) disables the whole confirm concept: no ping, no sweep —
  // Infinity keeps the sweep's `now >= cutoffAt` permanently false, and the ping gates on bbCutoff.
  const bbCutoff = effectiveConfirmCutoff(P(1).config.confirmCutoff);
  const cutoffAt = bbCutoff ? new Date(rd + 'T' + bbCutoff + ':00').getTime() : Infinity;
  const cutoffLabel = bbCutoff ? fmtClockLabel(bbCutoff) : '';
  // RUN-DAY 9 AM CONFIRM PING (once) — push every unconfirmed floor player, deadline spelled out.
  // Fires any time from 9 AM up to the cutoff (a late boot still pings; past the cutoff the sweep
  // is the message).
  if (bbCutoff && now >= new Date(rd + 'T09:00:00').getTime() && now < cutoffAt
      && getSetting('autoping_done') !== rd && !runIsCancelled(rd)) {
    setSetting('autoping_done', rd);
    const targets = partitionRun(rd).floorReal.filter(p => !p.guest && !p.confirmed_at).map(p => p.email);
    if (targets.length) setImmediate(() => sendPush(targets, {
      title: 'Confirm your spot for tonight',
      body: `You're on the floor for ${runLabelFor(rd)}. Confirm by ${cutoffLabel} — unconfirmed spots go to the waitlist.`,
      url: '/checkin', tag: 'confirm',
    }));
    audit('system', 'system', 'confirm:autoping', String(targets.length));
    console.log(`[autoping] pinged ${targets.length} unconfirmed floor player(s) for ${rd}`);
  }
  // Auto-CLOSE at run-day 2 PM (once). Respects a host who already closed. The queue locks here.
  if (now >= closeAt) {
    if (getSetting('autoclose_done') !== rd) {
      setSetting('autoclose_done', rd);
      if (runIsOpen(rd)) { setRunOpen(rd, false); audit('system', 'system', 'run:autoclose', rd); console.log(`[autoclose] locked check-in for ${rd}`); }
    }
    // CONFIRM-OR-RELEASE (once, at the cutoff): every unconfirmed floor player is removed and
    // each freed spot is offered onward to the top waitlister (the same claim loop as any drop).
    // Guests exempt — an operator vouched them in and they have no account to confirm from.
    if (now >= cutoffAt && getSetting('confirmsweep_done') !== rd && !runIsCancelled(rd)) {
      setSetting('confirmsweep_done', rd);
      const wlBefore = waitlistOrderFor(1, rd);   // F4 snapshot — the sweep shifts the whole list at once
      const drop = partitionRun(rd).floorReal.filter(p => !p.guest && !p.confirmed_at);
      for (const p of drop) {
        const offeree = offereeForFloorLeave(rd, p.email);
        stmtDelCheckinRow.run(rd, p.email, 1);
        clearTeamAssignment(1, rd, p.email);
        if (offeree) createOffer(rd, offeree, null, 1);
      }
      if (drop.length) {
        setImmediate(() => pingWaitlistShift(1, rd, wlBefore));   // F4 (generic sweep pings via removeFromRun)
        setImmediate(() => sendPush(drop.map(p => p.email), {
          title: 'Your spot was released',
          body: `You didn't confirm for ${runLabelFor(rd)} by ${cutoffLabel}, so your spot went to the next in line.`,
          url: '/checkin', tag: 'confirm',
        }));
        audit('system', 'system', 'confirm:sweep', String(drop.length));
        console.log(`[confirmsweep] released ${drop.length} unconfirmed spot(s) for ${rd}`);
      }
    }
    // PENALTY ASSESS (once, after the run ENDS) — strike auto-seated no-shows. DARK until
    // P(1).config.autoRenewPenalty is set (assessRenewPenalties no-ops without it); judge at the run's
    // END (host-set run_end), not the 2 PM lock — confirms come in right up to game time. Lives inside
    // this now>=closeAt block because it `return`s below (any code after the return never runs post-2PM).
    if (P(1).config.autoRenewPenalty) {
      const assessAt = new Date(rd + 'T' + runTimesFor(rd).end + ':00').getTime();
      if (now >= assessAt && getSetting('arassess_done') !== rd) {
        setSetting('arassess_done', rd);
        assessRenewPenalties(1, rd);
      }
    }
    return;
  }
  // Auto-OPEN at Wednesday 5 PM (once), only before the close time.
  if (now >= openAt && getSetting('autoopen_done') !== rd) {
    setSetting('autoopen_done', rd);
    if (!runIsOpen(rd) && !runIsCancelled(rd)) { // never auto-open a cancelled run
      setRunOpen(rd, true); audit('system', 'system', 'run:autoopen', rd);
      const body = `Check-in is open for ${runWeekday(rd)}, ${runLabelFor(rd)} (${runTimeRange(rd)}) — grab your spot 🏀`;
      setImmediate(() => {
        sendPush(queueOpenPushEmails(), { title: 'Check-in is open', body, url: '/checkin', tag: 'queueopen' });
        if (emailConfigured) { const r = queueOpenEmailRecipients(); if (r.length) sendAnnouncement(r, body, 'system').catch(e => console.error(`[autoopen] email FAILED: ${e.message}`)); }
      });
      console.log(`[autoopen] opened check-in for ${rd}`);
    }
  }
}

export {
  autoJoinTeam, loadRun, ensureWeek, autoRunState,
};
