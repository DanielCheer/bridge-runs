// engine/basketball-calendar.js — program 1 (basketball, the original run): its capacities
// (env defaults overridden in-app), its standing weekly day with per-week host overrides, its
// season gate, and its open/cancelled/locked state.
import db from '../db.js';
import { CAP_ENV, WAITLIST_CAP_ENV, PREREG_CAP_ENV } from '../config.js';
import { getSetting } from '../lib/settings.js';
import {
  shiftYmd, fmtClockRange, fmtClockLabel, ymdLocal, runLabelFor, runWeekday, hhLocal,
} from '../lib/dates.js';

// Run capacities. `let` (not const) because a host can edit them in-app (stored in
// app_settings, applied by reloadRunSettings() at startup + on save). The env values are
// the DEFAULTS/fallback. Every consumer reads these at request time, so a live edit takes
// effect on the next check-in with no restart. TOTAL_CAP is derived — recomputed on reload.
let CAP = CAP_ENV;
let WAITLIST_CAP = WAITLIST_CAP_ENV;
let TOTAL_CAP = CAP + WAITLIST_CAP;
let PREREG_CAP = PREREG_CAP_ENV; // max team+regular pre-joining while closed; reserves the rest for normals
// Apply any host-saved capacity overrides (app_settings) over the env defaults. Called
// once at startup and again whenever the host saves settings, so live edits need no
// restart. A missing / non-positive stored value falls back to the env default.
function reloadRunSettings() {
  const g = (k, def) => { const v = getSetting(k); const n = Number(v); return (v != null && Number.isFinite(n) && n > 0) ? Math.floor(n) : def; };
  CAP = g('run_cap', CAP_ENV);
  WAITLIST_CAP = g('waitlist_cap', WAITLIST_CAP_ENV);
  PREREG_CAP = Math.min(g('prereg_cap', PREREG_CAP_ENV), CAP); // pre-reg can't exceed the floor
  TOTAL_CAP = CAP + WAITLIST_CAP;
}

// ---- helpers ----
// The standing weekly run day: 0=Sun … 6=Sat. 3 = Wednesday. The whole basketball
// schedule (next run, overrides, auto open/lock) keys off this — change it here to
// move the standing run to another weekday.
const RUN_DOW = 3;
// Check-in auto-opens this many days before the run, at this hour (local). SINGLE source of
// truth: runStateSchedule fires off these AND the player-facing "registration opens…" copy is
// derived from them, so the two can never drift the way a hardcoded weekday does.
const OPEN_DAYS_BEFORE = 2, OPEN_H = 17;
// The date check-in opens for run `rd`.
const openDateFor = (rd) => shiftYmd(rd, -OPEN_DAYS_BEFORE);
function nextRunDefault(d = new Date()) {
  const r = new Date(d);
  const day = r.getDay();            // 0 Sun … 6 Sat
  const add = (RUN_DOW - day + 7) % 7;
  // Stays on the run day all day; at the following local midnight it rolls to next
  // week — so the queue resets at midnight and regulars can re-queue right away.
  r.setDate(r.getDate() + add);
  // Format from LOCAL components — NOT toISOString(), which is UTC. On Eastern,
  // an evening run's toISOString() already reads the NEXT calendar day in UTC and
  // would roll to next week mid-run, purging the current roster. The rollover must
  // happen at LOCAL midnight, so derive Y-M-D from the local date parts.
  const ymd = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return ymd(r); // YYYY-MM-DD (local)
}

// --- Host-configurable run day ---------------------------------------------
// The run defaults to a weekly run day (RUN_DOW = Wednesday). A host can move the
// NEAREST run to ANY nearby date — earlier OR later than that Wednesday. An override
// REPLACES the default run day closest to the chosen date; it is keyed by that day
// (nearestRunDefault(chosen)) and stores the host-chosen actual run_date. nextRunDate()
// resolves the ACTUAL upcoming run date that EVERYTHING keys off (checkins, run_state,
// attendance, offers, admin).
//
// Because a run can move LATER (e.g. Wed→Thu), the run date can fall AFTER its key
// run day. So nextRunDate() cannot just look at this week's run day — it scans a
// 3-week window [thisRunDay-7, thisRunDay, thisRunDay+7], resolves each week's actual
// run date (override or the day itself), keeps those on-or-after today, and returns the
// soonest. The -7 arm is what keeps a Wed→Thu run resolving to the Thursday on the run
// day itself (when nextRunDefault has already flipped to next week), instead of leaking
// forward to next week. See ensureWeek() for the matching rollover.
const stmtRunOverride = db.prepare('SELECT run_date, run_time, run_end FROM run_overrides WHERE default_date = ?');
function runOverrideRow(fridayKey) { return stmtRunOverride.get(fridayKey) || null; }
function runOverrideFor(fridayKey) {
  const row = stmtRunOverride.get(fridayKey);
  return row ? row.run_date : null;
}
// The default-day KEY a run date is keyed under in run_overrides — the base of its cycle.
// Authoritative across FAR moves: read the override row whose run_date matches (its
// default_date IS the base), falling back to the nearest default day when the run sits on
// its default position (no override). Keying off the nearest default day to the DESTINATION
// instead is wrong once a move crosses the week-midpoint — it orphans the run's own override
// and un-suppresses the original default day. (This is basketball's analog of pickleball's
// pk_run_base fix — see /pickleball/date.)
const stmtOverrideByRunDate = db.prepare('SELECT default_date FROM run_overrides WHERE run_date = ? LIMIT 1');
function runBaseFor(runDate) {
  const ov = stmtOverrideByRunDate.get(runDate);
  return ov ? ov.default_date : nearestRunDefault(new Date(runDate + 'T12:00:00'));
}
// Default run window — 8:30 PM to 10:30 PM, server-local (Eastern). The host can override
// per week via run_overrides.run_time / run_end (HH:MM). NULL columns fall back here.
const DEFAULT_START = '20:30', DEFAULT_END = '22:30';
// Confirm-or-release cutoff lives in EACH program's config as an absolute 'HH:MM'
// (config.confirmCutoff, e.g. '16:30') — change it there, never here. The run-day 9 AM ping
// and the run-page note both derive their copy from it.
// The {start,end} HH:MM for the run on a given date — from that week's override (keyed
// by its nearest run day) or the defaults. Time-only overrides (run_date === default)
// still carry run_time/run_end, so this resolves them even when the day didn't move.
function runTimesFor(runDate) {
  const row = runOverrideRow(nearestRunDefault(new Date(runDate + 'T12:00:00')));
  return { start: (row && row.run_time) || DEFAULT_START, end: (row && row.run_end) || DEFAULT_END };
}
function runTimeRange(runDate) {
  const { start, end } = runTimesFor(runDate);
  return fmtClockRange(start, end);
}
function runStartLabel(runDate) { return fmtClockLabel(runTimesFor(runDate).start); }
// The default run day (RUN_DOW) NEAREST a chosen date (ties → the earlier one). Every
// date is ≤3 days from the run day, so this is unambiguous. This is the override KEY:
// moving the run to D replaces the default run day closest to D.
function nearestRunDefault(d = new Date()) {
  const r = new Date(d);
  const fwd = (RUN_DOW - r.getDay() + 7) % 7;  // 0..6 days forward to the next run day
  const delta = fwd <= 3 ? fwd : fwd - 7;      // forward if ≤3, else the earlier (backward) run day
  r.setDate(r.getDate() + delta);
  return ymdLocal(r);
}
// Season opener (YYYY-MM-DD) or null. Before it, there are NO weekly runs — the next run
// is the first run day on/after the opener, and nothing auto-opens until ~2 days before it.
// This keeps the standing weekly schedule from conjuring phantom off-season runs.
function seasonStart() { const s = getSetting('season_start'); return (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : null; }
function nextRunDate(d = new Date()) {
  const today = ymdLocal(d);
  const opener = seasonStart();
  const preseason = opener && today < opener;
  // Pre-season: resolve the first run day on/after the opener (never earlier than it).
  const from = preseason ? new Date(opener + 'T12:00:00') : d;
  const lo = preseason ? opener : today;   // floor: no run before the opener (or before today, in-season)
  const F = nextRunDefault(from);
  const cands = [];
  for (const bf of [shiftYmd(F, -7), F, shiftYmd(F, 7)]) {  // last / this / next week's run day
    const rd = runOverrideFor(bf) || bf;                    // that week's actual run date
    if (rd >= lo) cands.push(rd);                           // only runs still upcoming (and in-season)
  }
  // F itself is always ≥ lo, so cands is non-empty unless F is overridden into the past —
  // in which case F+7 (never overridable into the past) still qualifies. Guarded with a
  // fallback to F regardless. YYYY-MM-DD compares lexicographically = chronologically.
  return cands.length ? cands.reduce((a, b) => (a < b ? a : b)) : F;
}

function runStartEpoch(runDate) { return new Date(runDate + 'T' + runTimesFor(runDate).start + ':00').getTime(); } // configured start, server-local (Eastern)

// ---- open / cancelled / locked state ----
const stmtRunIsOpen = db.prepare('SELECT is_open FROM run_state WHERE run_date = ? AND program_id = 1');
function runIsOpen(runDate) {
  const row = stmtRunIsOpen.get(runDate); // hot path (every /checkin + /poll)
  return !!(row && row.is_open); // no row = never opened = closed
}
function setRunOpen(runDate, open) {
  db.prepare(`INSERT INTO run_state (run_date, is_open, program_id) VALUES (?, ?, 1)
              ON CONFLICT(run_date, program_id) DO UPDATE SET is_open = excluded.is_open`)
    .run(runDate, open ? 1 : 0);
  // First open stamps the fill-speed anchor (metrics layer); a later re-open never resets it.
  if (open) db.prepare("UPDATE run_state SET opened_at = datetime('now') WHERE run_date = ? AND program_id = 1 AND opened_at IS NULL").run(runDate); // UTC — must match checkins.created_at for fill-speed math (P1-2)
}
// Run cancellation (per run_date). Cancelling closes the run too — a cancelled run can't
// be open for check-in. Un-cancelling leaves it CLOSED (the host re-opens deliberately).
const stmtRunCancelled = db.prepare('SELECT cancelled FROM run_state WHERE run_date = ? AND program_id = 1');
function runIsCancelled(runDate) {
  const row = stmtRunCancelled.get(runDate);
  return !!(row && row.cancelled);
}
function setRunCancelled(runDate, cancelled) {
  db.prepare(`INSERT INTO run_state (run_date, is_open, cancelled, program_id) VALUES (?, 0, ?, 1)
              ON CONFLICT(run_date, program_id) DO UPDATE SET cancelled = excluded.cancelled, is_open = CASE WHEN excluded.cancelled = 1 THEN 0 ELSE is_open END`)
    .run(runDate, cancelled ? 1 : 0);
}
// Roster LOCK: at run-day 2 PM the queue locks. Existing players can still drop and the
// waitlist still fills freed spots (offers/claims), but no NEW self-sign-ups — only a
// host/team +1. Time-derived (no state flag) so it auto-resets for next week's run.
function runIsLocked(runDate) {
  return Date.now() >= new Date(runDate + 'T14:00:00').getTime();
}

// Run-day control payload for the check-in Operator-tools card — HOST or ADMIN only
// (team members can't move the run). Null for everyone else. Moved off the profile.
function runDayFor(req, gate) {
  const canSetRunDay = gate.viewerIsAdmin || !!(gate.a && gate.a.is_host);
  if (!canSetRunDay) return null;
  const rdRunDate = nextRunDate();
  const rdBase = runBaseFor(rdRunDate); // the default day THIS run is keyed under (survives far moves)
  const rdTimes = runTimesFor(rdRunDate);
  const today = ymdLocal();
  const opener = seasonStart();
  const preseason = !!opener && today < opener;   // season set + hasn't started → no live weekly run yet
  return {
    runDate: rdRunDate, weekday: runWeekday(rdRunDate), label: runLabelFor(rdRunDate),
    isOverride: !!runOverrideRow(rdBase), dateMoved: rdRunDate !== rdBase,
    start: rdTimes.start, end: rdTimes.end, timeLabel: runTimeRange(rdRunDate),
    defaultDate: rdBase, defaultLabel: runLabelFor(rdBase),
    today, maxDate: shiftYmd(today, 30), cancelled: runIsCancelled(rdRunDate),
    // Season opener (the season-start gate): before it, only the season control shows.
    season: opener || '', seasonWeekday: opener ? runWeekday(opener) : '', seasonLabel: opener ? runLabelFor(opener) : '',
    preseason, seasonMax: shiftYmd(today, 365),
  };
}

// Rollover + offer-expiry must fire even with ZERO viewers: the poll-and-patch
// clients no longer guarantee a periodic full-page /checkin GET to piggyback
// loadRun on. Prime lastRunDate at startup, then every 60s run the (gated) weekly
// rollover and drop/cascade any expired holds. req=null → createOffer's link falls
// back to PUBLIC_URL (kept set in .env), so offer emails carry the real Funnel URL.
// Auto open/close the check-in queue, keyed to the ACTUAL run day so it stays correct
// when the host moves the run. Opens at 5 PM TWO DAYS BEFORE the run (Mon for a Wed
// run), locks + auto-pings at 2 PM ON the run day. Each fires ONCE per cycle (a per-run
// flag), never fights a manual host toggle, and the OPEN ping goes ONLY to no-early-access
// regulars (Core/Team/Host already have early access).
function runStateSchedule() {
  const rd = nextRunDate();
  const closeAt = new Date(rd + 'T14:00:00').getTime();            // run day 2 PM — queue locks + auto-ping
  const openAt = new Date(openDateFor(rd) + hhLocal(OPEN_H)).getTime();
  return { rd, openAt, closeAt };
}

export {
  reloadRunSettings, nextRunDate, CAP, WAITLIST_CAP, TOTAL_CAP, PREREG_CAP, OPEN_H, openDateFor,
  runTimeRange, runStartLabel, runStartEpoch, runIsOpen, runIsCancelled, runIsLocked, runDayFor,
  setRunOpen, setRunCancelled, runOverrideRow, runBaseFor, DEFAULT_START, DEFAULT_END, seasonStart,
  stmtRunIsOpen, runTimesFor, runStateSchedule, RUN_DOW, OPEN_DAYS_BEFORE,
};
