// engine/ladder.js — the doubles ladder: which night a program's routes act on (runNightFor),
// roster and display names, logged results into season standings, sportsmanship nominations,
// and the headcount record.
import crypto from 'crypto';
import db from '../db.js';
import { getSetting } from '../lib/settings.js';
import { lc } from '../lib/email.js';
import { ymdLocal, schedNow } from '../lib/dates.js';
import { P, programRunDate, memberOf } from './programs.js';
import { nextRunDate } from './basketball-calendar.js';

// Program-generic and feature-flagged (config.features.ladder). Everything below is a no-op for a
// program without the flag, and its routes 404 — a run that doesn't keep score never grows a board.
//
// The roster is NOT typed anywhere: the picker is tonight's CHECK-IN list (checkins while the run
// is live, attendance once it archives), so the people who tapped in are exactly the people who can
// be logged. Identity is the email throughout; names are resolved for display only.
// Audit actor role. requireLogin routes never get req.actorRole (only the admin/approver gates set
// it), and audit() binds it straight into SQLite — passing undefined throws mid-write. Same idiom
// the other run handlers use, extended with 'player' for the member-level action (nominate).
const ladderActor = (g, req) => req.actorRole || (g.admin ? 'admin' : (g.canOperate ? 'host' : 'player'));
const ladderTag = (programId) => P(programId).config.logTag || P(programId).key || 'run';
const ladderCfg = (programId) => (P(programId).config.features || {}).ladder || null;
// Basketball derives its run date from nextRunDate(); every generic program stores its own. Same
// split the kiosk route makes — one helper so a ladder on program 1 can never read the wrong night.
// THE NIGHT THE LADDER IS SCORING — deliberately NOT the check-in date.
// programRunDate rolls forward to next week the moment the run's end hour passes, which is right
// for check-in (sign-ups reopen that evening) and WRONG for scoring: a game logged at 8:05, or the
// sportsmanship vote taken while people pack up, belongs to the night that just finished. Reusing
// the check-in date stamped those onto NEXT week, made "undo the last game of tonight" a silent
// no-op after the final whistle, and left next week's first undo deleting this week's game.
// (Audit 2026-09-08 — pickleball ends at 20:00, so the bug opened exactly at the buzzer.)
// Rule: if today is a run day for this program, today IS the night. Otherwise use the scheduled
// date, which is what a mid-week look at the board should show.
function runNightFor(programId) {
  // Basketball predates the generic engine and keeps its date in nextRunDate(); every other program
  // stores its own. Getting this wrong doesn't error, it silently reads the WRONG NIGHT — which is
  // how teams and results end up on next week.
  const scheduled = Number(programId) === 1 ? nextRunDate() : programRunDate(programId);
  const today = ymdLocal(new Date(schedNow()));
  if (scheduled === today) return today;                 // run day, before the end hour
  const dow = (P(programId).config || {}).dow;
  const todayIsRunDay = dow != null && new Date(`${today}T12:00:00`).getDay() === Number(dow);
  return todayIsRunDay ? today : scheduled;
}
const ladderRunDate = runNightFor;   // the ladder's original name; same night, one implementation
// Is award voting open? The award is a season-END event, so the config default is closed — but
// opening it must NOT need a code edit and a restart on the last night of the season. The operator
// toggle writes ladder_noms_<pid>; absent, the program's config decides. Same shape as every other
// host-configurable setting in the app: config is the default, app_settings is the override.
const ladderNomsKey = (programId) => `ladder_noms_${Number(programId)}`;
function ladderNomsOpen(programId, cfg) {
  const v = getSetting(ladderNomsKey(programId));
  if (v === '1') return true;
  if (v === '0') return false;
  return (cfg || ladderCfg(programId) || {}).nominations !== false;
}
const LADDER_SCORE_MAX = 99;      // a typo like 111 is a mis-tap, not a game
const LADDER_NOTE_MAX = 140;      // one line under a name on the board

// The season the standings cover: the program's own season-start gate (the same app_settings key
// the season board reads) or, before one is set, the calendar year. Derived — never stored — so
// moving the season start re-cuts the board instead of leaving a stale copy behind.
function ladderFrom(programId) {
  const key = (P(programId).config.keys || {}).seasonStart || 'season_start';
  const s = getSetting(key);
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : `${ymdLocal(new Date(schedNow())).slice(0, 4)}-01-01`;
}
// Display names for a set of emails, best source first: the member's own profile, then the name the
// run recorded (guests have no applicant row), then the address. One query per source, not per
// player — a 20-person night must not become 20 round trips.
function ladderNames(programId, emails) {
  const out = new Map();
  const list = [...new Set(emails.map(lc).filter(Boolean))];
  if (!list.length) return out;
  const marks = list.map(() => '?').join(',');
  // The Planning Center roster first, and lowest priority. For a synced registrant it is the only
  // name the app ever sees (their address is a synthetic pco-<id>@adv.local), so without this pass
  // the leaderboard is a wall of slugs. Oldest first so the most recent sync's spelling wins.
  for (const r of db.prepare(`SELECT email, name FROM run_roster WHERE program_id = ? AND email IN (${marks}) ORDER BY synced_at ASC`).all(programId, ...list)) {
    if (r.name) out.set(lc(r.email), r.name);
  }
  // The ladder's own roster next — for a ladder-only player it is the ONLY source of a name, and
  // without it the board renders raw addresses. Everything after it overrides on purpose.
  for (const r of db.prepare(`SELECT email, name FROM ladder_players WHERE program_id = ? AND email IN (${marks})`).all(programId, ...list)) {
    if (r.name) out.set(lc(r.email), r.name);
  }
  for (const r of db.prepare(`SELECT email, name FROM attendance WHERE program_id = ? AND email IN (${marks})`).all(programId, ...list)) {
    if (r.name) out.set(lc(r.email), r.name);
  }
  for (const r of db.prepare(`SELECT email, name FROM checkins WHERE program_id = ? AND email IN (${marks})`).all(programId, ...list)) {
    if (r.name) out.set(lc(r.email), r.name);
  }
  for (const r of db.prepare(`SELECT email, full_name FROM applicants WHERE email IN (${marks})`).all(...list)) {
    if (r.full_name) out.set(lc(r.email), r.full_name);   // profile wins: it's the one the member edits
  }
  for (const e of list) if (!out.has(e)) out.set(e, e.split('@')[0]);
  return out;
}
// Who the picker offers. THE ROSTER IS NOT DERIVABLE for a run the church signs up in Planning
// Center: PCO Check-Ins needs a Check-Ins grant this account doesn't have, and this app's own
// checkins/attendance stay empty while nobody signs up here. So ladder_players is the durable
// source — typed once, kept for the season — and everything the app DOES know is unioned on top:
//   · ladder_players (not retired)          the entered roster
//   · checkins for this run date            in-app sign-ups, when the run uses them
//   · attendance for this run date          the same list once the night archives
//   · anyone already in a game tonight      so an undo-and-relog always has its players
// `here` marks the last two: the people the app can prove are at tonight's run, sorted first.
function ladderRoster(programId, rd) {
  const seen = new Map();
  const add = (email, name, here) => {
    const e = lc(email); if (!e) return;
    const cur = seen.get(e);
    if (cur) { if (here) cur.here = true; if (name && !cur.name) cur.name = name; return; }
    seen.set(e, { email: e, name: name || '', here: !!here });
  };
  for (const r of db.prepare('SELECT email, name FROM ladder_players WHERE program_id = ? AND retired_at IS NULL').all(programId)) add(r.email, r.name, false);
  for (const r of db.prepare('SELECT email, name FROM checkins WHERE program_id = ? AND run_date = ?').all(programId, rd)) add(r.email, r.name, true);
  for (const r of db.prepare('SELECT email, name FROM attendance WHERE program_id = ? AND run_date = ?').all(programId, rd)) add(r.email, r.name, true);
  for (const g of db.prepare('SELECT w1,w2,l1,l2 FROM ladder_games WHERE program_id = ? AND run_date = ?').all(programId, rd)) {
    for (const e of [g.w1, g.w2, g.l1, g.l2]) add(e, '', true);
  }
  // ONE name per person, from ONE resolver. The picker used to take the first name it happened to
  // read (the roster row) while the board took ladderNames (where the member's own profile wins), so
  // the same person could sit in the picker as "Daniel Cheer" and on the projector as "daniel".
  // ladderNames is the single source of a display name; the row name is only its fallback.
  const names = ladderNames(programId, [...seen.keys()]);
  return [...seen.values()]
    .map(p => ({ ...p, name: names.get(p.email) || p.name || p.email }))
    .sort((a, b) => (b.here - a.here) || a.name.localeCompare(b.name));
}
// A ladder-only player gets a synthetic address in the app's existing @*.local family, so every
// query, export and rekey treats them like anyone else while nothing can ever push them into the
// church's directory. Collisions get a numeric suffix — two Daniels are two players.
function ladderMintEmail(programId, name) {
  const base = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'player';
  const taken = (e) => !!db.prepare('SELECT 1 FROM ladder_players WHERE program_id = ? AND email = ?').get(programId, e);
  let e = `${base}@ladder.local`;
  for (let n = 2; taken(e) && n < 100; n++) e = `${base}-${n}@ladder.local`;
  return e;
}
// The board itself. Wins first, then POINT DIFFERENTIAL, then win rate, then name — the owner's
// rule (2026-09-08): "wins then differential". PD is summed from the stored scores every time, so
// an undone game leaves nothing behind.
function ladderStandings(programId, from) {
  const games = db.prepare(
    'SELECT * FROM ladder_games WHERE program_id = ? AND run_date >= ? ORDER BY id DESC').all(programId, from);
  const names = ladderNames(programId, games.flatMap(g => [g.w1, g.w2, g.l1, g.l2]));
  const nm = (e) => names.get(lc(e)) || lc(e);
  // ONE standings table: the PERSON. Partners rotate all night at an open gym, so a per-pairing
  // table was twenty duos with one game each — noise on a projector, and it split a player's record
  // across every partner they had. (Owner, 2026-09-08: "the only thing that matters is individual
  // points".) Pairs are still shown in the games log below, where they're a fact about the game
  // rather than a standings line of their own.
  const players = new Map(), nights = new Set();
  const seat = (key, label) => {
    let row = players.get(key);
    if (!row) { row = { key, label, w: 0, l: 0, pf: 0, pa: 0 }; players.set(key, row); }
    return row;
  };
  const duoLabel = (a, b) => [nm(a), nm(b)].sort((x, y) => x.localeCompare(y));
  for (const g of games) {
    nights.add(g.run_date);
    for (const e of [g.w1, g.w2]) { const p = seat(lc(e), nm(e)); p.w++; p.pf += g.w_score; p.pa += g.l_score; }
    for (const e of [g.l1, g.l2]) { const p = seat(lc(e), nm(e)); p.l++; p.pf += g.l_score; p.pa += g.w_score; }
  }
  const rank = (a, b) => {
    if (b.w !== a.w) return b.w - a.w;
    const da = a.pf - a.pa, dbb = b.pf - b.pa;
    if (dbb !== da) return dbb - da;
    const ra = a.w / (a.w + a.l || 1), rb = b.w / (b.w + b.l || 1);
    if (rb !== ra) return rb - ra;
    return String(a.label).localeCompare(String(b.label));
  };
  const fin = (r) => ({ ...r, pd: r.pf - r.pa, played: r.w + r.l });
  return {
    from,
    players: [...players.values()].map(fin).sort(rank),
    nights: nights.size,
    games: games.map(g => ({
      id: g.id, runDate: g.run_date, at: g.created_at,
      winners: duoLabel(g.w1, g.w2), losers: duoLabel(g.l1, g.l2),
      ws: g.w_score, ls: g.l_score,
    })),
  };
}
// Sportsmanship award tally — one nomination per voter per night, so the count IS the number of
// people who named them (never one enthusiastic voter ten times).
function ladderNominations(programId, from) {
  const rows = db.prepare(
    `SELECT email, note, at FROM ladder_nominations
      WHERE program_id = ? AND run_date >= ? ORDER BY at DESC`).all(programId, from);
  const names = ladderNames(programId, rows.map(r => r.email));
  const tally = new Map();
  for (const r of rows) {
    const e = lc(r.email);
    let row = tally.get(e);
    if (!row) { row = { email: e, name: names.get(e) || e, n: 0, note: '' }; tally.set(e, row); }
    row.n++;
    if (!row.note && r.note) row.note = r.note;   // the most recent reason, not a wall of them
  }
  return [...tally.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}
// Who may record a result: operators always; every member on tonight's roster when the program's
// config says features.ladder.log === 'players'.
function ladderCanLog(programId, cfg, gate, email, roster) {
  if (gate.canOperate) return true;
  if (cfg.log !== 'players') return false;
  // Being on tonight's roster is not enough: a guest or a lapsed member can appear there. Writing to
  // the program's record requires membership OF the program, same bar as nominate.
  if (!memberOf(programId, email)) return false;
  return roster.some(p => p.email === lc(email));
}
// Headcount for a night. Program-generic (any run can use it, ladder or not) — the ladder page is
// simply where the operator already is at 8 PM. Reads back the whole season so the number has a
// denominator: a single "12" is trivia, "12, 9, 14 over three nights" is a decision.
const HEADCOUNT_MAX = 500;                    // a typo like 1200 is a mis-tap, not a gym
function headcountSeason(programId, from) {
  return db.prepare(
    'SELECT run_date, n FROM run_headcount WHERE program_id = ? AND run_date >= ? ORDER BY run_date DESC')
    .all(programId, from);
}
// PII purge for a hard-deleted person, called from the people-delete cascade.
//
// The tension: a hard delete must leave no trace of the person, but a ladder GAME is a SHARED
// record — three other people's results sit in the same row, and deleting it would silently rewrite
// their standings (the same reason retire never deletes). So their seats are rekeyed onto a
// per-person tombstone that carries no address and no name, and everyone else's history survives
// untouched. Their roster row and their votes (cast and received) are deleted outright.
function purgeLadderIdentity(email) {
  const e = lc(email);
  if (!e) return;
  const seats = db.prepare(
    'SELECT DISTINCT program_id FROM ladder_games WHERE w1=? OR w2=? OR l1=? OR l2=?').all(e, e, e, e);
  if (seats.length) {
    // One tombstone per PERSON, not per delete-of-the-same-address and not shared between people:
    // a shared address would merge two deleted players into one duo on the board.
    const tomb = `former-${crypto.randomBytes(4).toString('hex')}@ladder.local`;
    for (const col of ['w1', 'w2', 'l1', 'l2'])
      db.prepare(`UPDATE ladder_games SET ${col} = ? WHERE ${col} = ?`).run(tomb, e);
    for (const { program_id } of seats)
      db.prepare(`INSERT OR IGNORE INTO ladder_players (program_id, email, name, added_by, retired_at)
                  VALUES (?,?,?,?,datetime('now'))`).run(program_id, tomb, 'Former player', 'system:delete');
  }
  db.prepare('DELETE FROM ladder_players WHERE email = ?').run(e);
  db.prepare('DELETE FROM ladder_nominations WHERE email = ? OR voter = ?').run(e, e);
}
// A run moved AFTER games were logged: results are keyed by the night's date, so leaving them on the
// old date empties tonight's board and makes "undo the last game" a silent no-op — the same class of
// bug the ladderRunDate fix closed, reached from the other direction. Nominations carry a
// (program, run_date, voter) PK, so UPDATE OR REPLACE drops a vote already cast on the destination
// date instead of throwing and rolling the whole move back.
function migrateLadderNight(programId, oldRd, newRd) {
  if (!oldRd || !newRd || oldRd === newRd) return;
  db.prepare('UPDATE ladder_games SET run_date = ? WHERE run_date = ? AND program_id = ?').run(newRd, oldRd, programId);
  db.prepare('UPDATE OR REPLACE ladder_nominations SET run_date = ? WHERE run_date = ? AND program_id = ?').run(newRd, oldRd, programId);
}

export {
  ladderCfg, ladderRunDate, ladderFrom, ladderStandings, ladderNominations, ladderNomsKey,
  purgeLadderIdentity, runNightFor, ladderNames, ladderTag, ladderNomsOpen, ladderRoster, ladderCanLog,
  headcountSeason, ladderActor, LADDER_SCORE_MAX, ladderMintEmail, HEADCOUNT_MAX, LADDER_NOTE_MAX,
  migrateLadderNight,
};
