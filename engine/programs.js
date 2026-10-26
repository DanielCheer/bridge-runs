// engine/programs.js — the program registry (PROGRAMS, P), each program's clock (run date, open
// and cancelled state, start/end times), membership and hosts, the access gate, banners, and the
// door-mode confirm switch. Hydrated at boot by buildPrograms() (engine/program-loader.js).
import fs from 'fs';
import db from '../db.js';
import { isAdmin, ADMINS } from '../auth.js';
import { getSetting } from '../lib/settings.js';
import { ymdLocal, fmtClockRange, fmtClockLabel } from '../lib/dates.js';
import { BANNER_PATH } from '../lib/media.js';
import { applicantByEmail } from './applicants.js';

// Door check-in mode (the PCO Check-Ins hybrid): the physical door tap IS the confirmation, so
// the in-app "✓ I'm coming" step disappears everywhere — no run-day ping, no confirm-or-release
// sweep, no button (views key off confirmBy === ''). One admin toggle on /admin/pco, read LIVE
// at every site through effectiveConfirmCutoff(), so flipping it needs no restart or config edit.
const doorMode = () => getSetting('pco_door_mode') === '1';
const effectiveConfirmCutoff = (cutoff) => (doorMode() ? null : (cutoff || null));
// Banner (own uploaded photo else the shared gym.jpg) — program-generic; the file path + public URL
// come from config.bannerPath/bannerPublic. pk* names stay wrappers.
function bannerHasOwnFor(programId) { try { return fs.statSync(P(programId).config.bannerPath).size > 0; } catch { return false; } }
function bannerSrcFor(programId) { return bannerHasOwnFor(programId) ? P(programId).config.bannerPublic : '/gym.jpg'; }
function bannerVersionFor(programId) { const cfg = P(programId).config; try { return String(Math.floor(fs.statSync(bannerHasOwnFor(programId) ? cfg.bannerPath : BANNER_PATH).mtimeMs)); } catch { return '0'; } }
function pkBannerHasOwn() { return bannerHasOwnFor(2); }
function pkBannerSrc() { return bannerSrcFor(2); }
function pkBannerVersion() { return bannerVersionFor(2); }

// ---------- PROGRAM REGISTRY ----------
// Every run (basketball, pickleball, …) is one entry in this in-memory map, hydrated at boot
// (buildPrograms(), defined below once the engine functions exist) from the `program` table
// + the per-program presentation/dispatch in PROGRAM_DEFS. This registry is the ONLY thing
// the cookie, unread counts, runs hub, /poll, and back-links read — no code hardcodes
// "program 1 vs 2" anymore, so a new run is a new registry entry, not a new `=== 2 ?` branch.
// Phase 1: each entry still dispatches to today's basketball / pickleball functions; a later
// phase folds the two DEFS into one config-driven engine. Insertion order = ascending id
// (deterministic hub / poll output). Each entry: { id, key, emoji, displayName, paths,
// seasonLabel, active():bool, unread(email,aid):{group,gm}, hubCard(req):{…dynamic card…} }.
const PROGRAMS = new Map();
const P = (id) => PROGRAMS.get(Number(id)) || PROGRAMS.get(1);   // unknown/stale id → the default run (basketball)

// Remember the last run the viewer opened, as its numeric program id (1 = basketball). A
// lightweight UNSIGNED preference cookie (not identity) — read only for run-aware tab routing.
function setRunCookie(req, res, program) {
  if (req.headers['x-prewarm'] === '1') return; // a router prewarm isn't a real visit — don't flip context
  try { res.cookie('bridge_run', String(program), { httpOnly: true, sameSite: 'lax', maxAge: 180 * 24 * 60 * 60 * 1000, path: '/' }); } catch {}
}
// The program the viewer is currently "in", from the cookie. Only honored when that program
// EXISTS and is LIVE — otherwise a stale / unpublished-since id would point the Chat tab at a
// route its gate now 404s. Defaults to program 1 (basketball, always live).
function runCookie(req) {
  const id = Number(req.cookies && req.cookies.bridge_run);
  const p = PROGRAMS.get(id);
  return (id > 1 && p && p.active()) ? id : 1;
}
// Has the viewer JOINED this run? Drives the run-aware Chat tab: it only unlocks + points at a run
// the viewer actually belongs to. Opt-in runs (pickleball/volleyball) → membership. A drop-in run
// (basketball) has no explicit join step, so "joined" = you're on the org team, an admin, or you've
// checked in at least once (a current OR archived check-in). Admins belong to every run (they run them).
const stmtEverCheckedInProg = db.prepare('SELECT 1 FROM checkins WHERE program_id = ? AND email = ? LIMIT 1');
const stmtEverAttendedProg  = db.prepare('SELECT 1 FROM attendance WHERE program_id = ? AND email = ? LIMIT 1');
function programJoinedBy(programId, email) {
  if (!email) return false;
  if (isAdmin(email)) return true;
  const a = applicantByEmail(email);
  if (!a || a.status !== 'approved') return false;   // rejected/pending/no-row → joined to nothing, even if old
                                                     // attendance survives (P3-1: don't unlock a chat the gate bounces)
  if (P(programId).config.access === 'opt-in') return memberOf(programId, email);
  if (a.is_team) return true;
  return !!stmtEverCheckedInProg.get(programId, email) || !!stmtEverAttendedProg.get(programId, email);
}

// ---- per-program run state ----
// Hoisted like their basketball twins (stmtRunIsOpen / stmtRun / stmtLatestAnnouncement) —
// node:sqlite has NO statement cache, so these re-compiled SQL on EVERY /poll tick for every
// signed-in viewer (pkProgramActive also runs on every /runs and /profile render).
const stmtRunOpenById = db.prepare('SELECT is_open FROM run_state WHERE run_date = ? AND program_id = ?');
const stmtRunCancelledById = db.prepare('SELECT cancelled FROM run_state WHERE run_date = ? AND program_id = ?');
function programActive(programId) { const r = stmtProgActiveById.get(programId); return !!(r && r.active); }
function pkProgramActive() { return programActive(2); }
// Season opener (YYYY-MM-DD) or null — program-generic; the key comes from config.keys.seasonStart.
function programSeasonStart(programId) { const s = getSetting(P(programId).config.keys.seasonStart); return (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : null; }
function pkSeasonStart() { return programSeasonStart(2); }
// "6–8 PM" / "6 PM" — derived from the schedule constants, never written as a literal, so the
// masthead, the runs hub and the banner caption can't drift from the real hours.
// The standing weekday (dow) NEAREST a chosen date — the Tuesday a moved run replaces.
function pkNearestDow(dateStr, dow) {
  const r = new Date(dateStr + 'T12:00:00');
  const fwd = (dow - r.getDay() + 7) % 7;
  r.setDate(r.getDate() + (fwd <= 3 ? fwd : fwd - 7));
  return ymdLocal(r);
}
// ---------- A PROGRAM'S CLOCK — ONE derivation, which everything else reads ----------
// startMin/endMin arrived with pickleball's move to 6:15–8:15. They are absent on every
// admin-created program, and `Number(x) || 0` reproduces the old whole-hour behaviour exactly
// there. These helpers exist because the first pass at :15 walked only programDefaultDate, and
// EIGHT other consumers kept deriving the clock from startHour/endHour alone — so the app rolled
// the night at 8:15 while archiving the run, reopening check-in, stamping the .ics and printing
// the time as though it ended at 8:00. One accessor, or the next time-change splits them again.
const startMinOf = (cfg) => Number(cfg.startMin) || 0;
const endMinOf = (cfg) => Number(cfg.endMin) || 0;
const clockHHMM = (h, m) => String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
const startHHMM = (cfg) => clockHHMM(cfg.startHour, startMinOf(cfg));
const endHHMM = (cfg) => clockHHMM(cfg.endHour, endMinOf(cfg));
const endMinutesOf = (cfg) => (cfg.endHour * 60) + endMinOf(cfg);
const minutesOfDay = (d) => (d.getHours() * 60) + d.getMinutes();
// The next standing run day (config.dow), local. Rolls to next week once the current run has ENDED
// (>= config.endHour on run day) so check-in reopens the same night. Season-gated: pre-season it
// resolves to the first standing day on/after the opener (no phantom off-season runs). Program-
// generic — the standing day, end hour, base-skip key and season key all come from config.
function programDefaultDate(programId) {
  const cfg = P(programId).config, dow = cfg.dow;
  const now = new Date();
  let add = (dow - now.getDay() + 7) % 7;
  // Minutes, not whole hours: a run that ends at :15 would otherwise roll to next week at :00
  // while it was still being played.
  if (add === 0 && minutesOfDay(now) >= endMinutesOf(cfg)) add = 7;   // run's over tonight → next week
  const r = new Date(now); r.setDate(r.getDate() + add);
  let d = ymdLocal(r);
  // Skip a standing day whose run was MOVED to another day this week (runBase key) — else once the
  // moved run passes, this would resurrect that day as a phantom run (open+ping).
  const skip = getSetting(cfg.keys.runBase);
  if (skip && d === skip) { const s = new Date(d + 'T12:00:00'); s.setDate(s.getDate() + 7); d = ymdLocal(s); }
  const opener = programSeasonStart(programId);
  if (opener && d < opener) {   // pre-season → first standing day on/after the opener
    const o = new Date(opener + 'T12:00:00'); o.setDate(o.getDate() + ((dow - o.getDay() + 7) % 7));
    d = ymdLocal(o);
  }
  return d;
}
function pkDefaultDate() { return programDefaultDate(2); }
// Manual per-week override (config.keys.runDate) else the weekly standing day.
function programRunDate(programId) { return getSetting(P(programId).config.keys.runDate) || programDefaultDate(programId); }
function pkRunDate() { return programRunDate(2); }
// Run-state read/write — program-generic (bind program_id); the pk* names stay thin wrappers.
function runOpenFor(programId, rd) { const r = stmtRunOpenById.get(rd, programId); return !!(r && r.is_open); }
function runCancelledFor(programId, rd) { const r = stmtRunCancelledById.get(rd, programId); return !!(r && r.cancelled); }
function setRunStateFor(programId, rd, field, val) {
  db.prepare(`INSERT INTO run_state (run_date, ${field}, program_id) VALUES (?, ?, ?) ON CONFLICT(run_date, program_id) DO UPDATE SET ${field} = excluded.${field}`).run(rd, val ? 1 : 0, programId);
  // First open stamps the fill-speed anchor (metrics layer, same rule as basketball's setRunOpen).
  if (field === 'is_open' && val) db.prepare("UPDATE run_state SET opened_at = datetime('now') WHERE run_date = ? AND program_id = ? AND opened_at IS NULL").run(rd, programId); // UTC — matches checkins.created_at (P1-2)
}
function pkIsOpen(rd) { return runOpenFor(2, rd); }
function pkIsCancelled(rd) { return runCancelledFor(2, rd); }
function pkSetState(rd, field, val) { return setRunStateFor(2, rd, field, val); }
// Pickleball run start epoch — the run date at 6 PM local. Drives the countdown banner
// AND the auto-lock time (check-in closes at start).
function startEpochFor(programId, rd) { return rd ? new Date(rd + 'T' + startHHMM(P(programId).config) + ':00').getTime() : 0; }
function timeRangeFor(programId) { const cfg = P(programId).config; return fmtClockRange(startHHMM(cfg), endHHMM(cfg)); }
function startLabelFor(programId) { return fmtClockLabel(startHHMM(P(programId).config)); }
function pkStartEpoch(rd) { return startEpochFor(2, rd); }
// ---------- PROGRAM MEMBERSHIP + AUDIENCE (program-generic) ----------
// Opt-in programs (pickleball, volleyball) track membership in program_membership; chat access, the
// members list, and the push/email audiences all read from it. One set of helpers keyed by program
// id; the pk* names below stay thin wrappers so call sites are untouched (a new program reuses them
// by passing its id).
// status: 'approved' (open join) or 'pending' (host-approve mode — a REQUEST, not a membership;
// memberOf filters on approved, so pending grants nothing until a host says yes).
function joinProgramMembership(programId, email, status = 'approved') {
  if (!email || /@guest\.local$/.test(email)) return;
  db.prepare('INSERT OR IGNORE INTO program_membership (program_id, email, status, role) VALUES (?, ?, ?, ?)')
    .run(programId, email, status, 'approved');
}
// F2: program HOSTS — members whose program_membership.role='host' operate THEIR program (open/
// close/announce/guests/requests) without being global admins. One row per program; grant/revoke
// on /admin/programs.
const stmtIsProgHost = db.prepare("SELECT 1 FROM program_membership WHERE program_id = ? AND email = ? AND role = 'host' AND status = 'approved'");
function isProgramHost(programId, email) { return !!(email && stmtIsProgHost.get(programId, String(email).toLowerCase())); }
const stmtProgHosts = db.prepare("SELECT email FROM program_membership WHERE program_id = ? AND role = 'host' AND status = 'approved'");
function programHostEmails(programId) {
  const hosts = stmtProgHosts.all(programId).map(r => r.email);
  return [...new Set([...hosts, ...ADMINS])];   // admins always hear requests too
}
const stmtIsMember = db.prepare("SELECT 1 FROM program_membership WHERE program_id = ? AND email = ? AND status = 'approved'"); // hoisted — runs per neutral-page render (chatProgramFor) + every chat gate (P3-6)
function memberOf(programId, email) {
  if (!email) return false;
  if (isAdmin(email)) return true; // admins operate the run — always members
  return !!stmtIsMember.get(programId, email);
}
// Push/announce audience = actual members (approved, non-guest). Not the whole club.
function programMemberEmails(programId) {
  return db.prepare(`SELECT pm.email FROM program_membership pm JOIN applicants a ON a.email = pm.email
    WHERE pm.program_id = ? AND a.status = 'approved' AND a.email NOT LIKE '%@guest.local'`).all(programId).map(r => r.email);
}
// Email audience = members who haven't opted out of announcement emails.
function programEmailRecipients(programId) {
  return db.prepare(`SELECT pm.email FROM program_membership pm JOIN applicants a ON a.email = pm.email
    WHERE pm.program_id = ? AND a.status = 'approved' AND a.email NOT LIKE '%@guest.local' AND COALESCE(a.email_optout,0) = 0`).all(programId).map(r => r.email);
}
// You become a pickleball member by opening the run (GET /pickleball) — being an approved
// BASKETBALL player alone doesn't grant it.
function pkJoinMembership(email) { return joinProgramMembership(2, email); }
function pkIsMember(email) { return memberOf(2, email); }
function pkMemberEmails() { return programMemberEmails(2); }
function pkEmailRecipients() { return programEmailRecipients(2); }
// Access gate for an opt-in run (pickleball, volleyball): approved players + admins in; a hidden
// program 404s for everyone but admins. Operator = admin for now. programGate is program-generic;
// pkGate stays a thin wrapper so call sites are untouched.
function programGate(programId, req, res) {
  const a = applicantByEmail(req.userEmail);
  const admin = isAdmin(req.userEmail);
  if (!admin && (!a || a.status !== 'approved')) { res.redirect('/status'); return null; } // row-less admins allowed (matches requirePlayer)
  // Hidden programs stay reachable for their HOST too (P3-9): hiding a program mid-season must
  // not lock the person who runs it out of rosters/requests/history until an admin re-publishes.
  if (!programActive(programId) && !admin && !isProgramHost(programId, req.userEmail)) { res.status(404).send('Not found'); return null; }
  // canOperate: global admins, or THIS program's host (F2). Host power is per-program by
  // construction — the row carries the program_id, so a youth host can't touch volleyball.
  return { a, admin, canOperate: admin || isProgramHost(programId, req.userEmail) };
}
function pkGate(req, res) { return programGate(2, req, res); }

const stmtProgActiveById = db.prepare('SELECT active FROM program WHERE id = ?');

export {
  P, programMemberEmails, memberOf, programGate, PROGRAMS, programJoinedBy, programRunDate, runOpenFor,
  runCancelledFor, effectiveConfirmCutoff, setRunCookie, pkRunDate, pkIsOpen, pkIsCancelled, runCookie,
  bannerSrcFor, bannerVersionFor, programEmailRecipients, programActive, startHHMM, endHHMM,
  joinProgramMembership, doorMode, programSeasonStart, setRunStateFor, endMinutesOf, minutesOfDay,
  programHostEmails, startLabelFor, pkNearestDow, programDefaultDate, startEpochFor, timeRangeFor,
  stmtProgActiveById,
};
