// engine/teams.js — run teams and games: team assignment and party-aware auto-fill, the teams
// board data, logged game results, tonight's games and the season standings.
import crypto from 'crypto';
import db from '../db.js';
import { lc } from '../lib/email.js';
import { schedNow } from '../lib/dates.js';
import { P } from './programs.js';
import { partitionFor } from './seating.js';
import { runNightFor, ladderNames } from './ladder.js';

// Who the teams board arranges. A run whose sign-ups live in Planning Center uses its synced
// roster; every other program uses the app's own floor, exactly as the teams feature always has.
function teamsRosterFor(programId, rd) {
  if (P(programId).config.pcoSignupPrefix) {
    return db.prepare('SELECT email, name FROM run_roster WHERE program_id = ? AND run_date = ? ORDER BY name COLLATE NOCASE')
      .all(programId, rd).map(r => ({ email: lc(r.email), name: r.name }));
  }
  return teamFloor(programId, rd).map(p => ({ email: lc(p.email), name: p.name || p.email.split('@')[0] }));
}
// Numbered teams (1..count) players join after the roster locks; count/size come from config so the
// SAME code serves casual pickup, a tournament bracket, or a standing league later. Dark unless a
// program sets config.features.teams. program_id + run_date scoped like every run table. These two
// clears run beside EVERY roster delete (a player off the floor can't stay on a team); no-ops while
// the table is empty. The join/assign routes + the teams panel land next.
function clearTeamAssignment(programId, rd, email) { db.prepare('DELETE FROM team_assignments WHERE program_id = ? AND run_date = ? AND email = ?').run(programId, rd, email); }
function clearRunTeams(programId, rd) { db.prepare('DELETE FROM team_assignments WHERE program_id = ? AND run_date = ?').run(programId, rd); }
const stmtRunTeams = db.prepare('SELECT email, team_no, assigned_by FROM team_assignments WHERE program_id = ? AND run_date = ? ORDER BY team_no ASC, created_at ASC');
function runTeamsFor(programId, rd, part = null) {
  const rows = stmtRunTeams.all(programId, rd);
  if (!rows.length) return rows;
  // Team seats are FLOOR seats. Every REMOVAL path clears the assignment, but a floor→waitlist
  // slide (offer churn, operator bump, waitlist cycling) is not a removal — it left the slider
  // holding a team seat from the waitlist, so teams read "full" while a floor player had no seat
  // (2026-08-04: demo-12 waitlisted with a Team 3 chair, Andre unassigned). Self-heal at the one
  // read chokepoint: non-floor assignments are dropped, not displayed. Callers that already
  // hold the partition pass it in — the run-page render was computing it twice.
  part = part || partitionFor(programId, rd);
  const floor = new Set((((P(programId).config.offerWindow ? part.floorReal : part.floor)) || []).map((p) => lc(p.email)));
  const stale = rows.filter((r) => !floor.has(lc(r.email)));
  for (const s of stale) clearTeamAssignment(programId, rd, s.email);
  return rows.filter((r) => floor.has(lc(r.email)));
}
function teamsFeature(programId) { const f = P(programId).config.features; return (f && f.teams) || null; }  // {count,size,opensAt,selfServe} or null
// Teams open once the roster LOCKS (config.features.teams.opensAt='lock' → lockTime), so teams form
// off the FINAL roster. schedNow() honours the TEST_NOW seam.
function teamsOpen(programId, rd) {
  if (!teamsFeature(programId)) return false;
  if (P(programId).config.static) return true;   // the static demo never reaches its lock — teams always open there
  return schedNow() >= new Date(rd + 'T' + P(programId).config.lockTime + ':00').getTime();
}
// Assign/move `email` to team `n` (1..count) with a SIZE GUARD — the INSERT OR REPLACE only lands if
// team n currently holds < size OTHER players. Race-safe: one synchronous statement, no read-then-write
// gap. Returns true if seated. by='' = self-served, else the operator's email.
function assignTeam(programId, rd, email, teamNo, by = '') {
  const t = teamsFeature(programId); if (!t) return false;
  const n = Number(teamNo); if (!(n >= 1 && n <= t.count)) return false;
  return db.prepare(`INSERT OR REPLACE INTO team_assignments (program_id, run_date, email, team_no, assigned_by)
    SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM team_assignments WHERE program_id = ? AND run_date = ? AND team_no = ? AND email <> ?) < ?`)
    .run(programId, rd, email, n, by, programId, rd, n, email, t.size).changes > 0;
}
// The set of floor players eligible for a team — INCLUDING guests (2026-08-04: a guest added
// after close was invisible to the whole teams area and could never get a chair, though they
// physically play). Guests have no session, so self-join stays members-only by construction;
// operators assign them and auto-fill balances them like anyone on the floor.
function teamFloor(programId, rd, part = null) {
  const cfg = P(programId).config; part = part || partitionFor(programId, rd);
  return (cfg.offerWindow ? part.floorReal : part.floor);
}
// Sides shift all night, so the whole design target is ONE TAP per change. With exactly two teams a
// tap needs no destination: tapping a player on a side moves them to the OTHER side. Bench is a
// separate small control, and a benched player taps back onto whichever side is shorter.
//
// Deliberately NOT gated on teamsOpen(): that gate exists so PLAYERS can't self-pick before the
// roster locks. Whoever is running the night arranges sides whenever they like.
function teamsBoardData(programId) {
  const rd = runNightFor(programId);
  const t = teamsFeature(programId);
  const roster = teamsRosterFor(programId, rd);
  // Read assignments straight from the table. runTeamsFor()'s self-heal drops anyone not on the
  // app's FLOOR — correct for a run that checks in here, wrong for one whose roster is synced,
  // where it would wipe every side on the next page load.
  const here = new Set(roster.map(r => r.email));
  const seats = new Map(db.prepare('SELECT email, team_no FROM team_assignments WHERE program_id = ? AND run_date = ?')
    .all(programId, rd).map(r => [lc(r.email), r.team_no]));
  const sides = Array.from({ length: t ? t.count : 0 }, () => []);
  const bench = [];
  for (const pl of roster) {
    const n = seats.get(pl.email);
    if (n >= 1 && n <= sides.length) sides[n - 1].push(pl); else bench.push(pl);
  }
  // A side assignment for someone no longer on the roster is dead weight; drop it so the counts
  // shown on the board are the counts on the floor.
  for (const [email] of seats) if (!here.has(email)) clearTeamAssignment(programId, rd, email);
  return { rd, sides, bench, count: t ? t.count : 0 };
}
// Game results (teams board) + the leaderboard they feed.
//
// A game exists only once someone says who won. There is no start, no clock, no in-progress
// state: on a winners-stay court the sides reform constantly, so the arrangement showing on the
// board when the result is tapped IS the game that just finished. The one human contract is
// "tap the winner before you re-mix", and the tonight-strip + one-tap Undo make a violation
// visible and reversible rather than pretending code can prevent it.
const GAME_MIN_SIDE = 3;     // below this the board is half-cleared, not a game
const GAME_SCORE_MAX = 99;
const gamesOn = (programId) => { const t = teamsFeature(programId); return !!(t && t.games && t.count === 2); };
// Seats left behind by a hard-deleted person: kept so side counts stay right, never shown.
const isTombstone = (email) => /^former-[0-9a-f]+@/.test(String(email || '').toLowerCase());

// The sides as they stand, READ ONLY. Deliberately not runTeamsFor(): its floor self-heal drops
// anyone who is not on this app's floor, which is every Planning Center registrant — it would
// both wipe the live sides and snapshot an empty game. Deliberately not teamsBoardData() either,
// because that clears dead-weight assignments, and a POST that logs a result must not mutate the
// board it is reading.
function gameSidesNow(programId, rd) {
  const t = teamsFeature(programId);
  const roster = teamsRosterFor(programId, rd);
  const here = new Set(roster.map(r => lc(r.email)));
  const sides = Array.from({ length: t ? t.count : 0 }, () => []);
  for (const r of db.prepare('SELECT email, team_no FROM team_assignments WHERE program_id = ? AND run_date = ?').all(programId, rd)) {
    const em = lc(r.email), n = Number(r.team_no);
    if (here.has(em) && n >= 1 && n <= sides.length) sides[n - 1].push(em);
  }
  return sides.map(s => s.sort());
}
// What the operator could see when the page rendered. A stale tab (last week's, a second phone,
// the board left open past midnight) must REFUSE rather than solidify a game whose rosters have
// since changed — the same doctrine as runTeamSwap's `from` anchor, widened to the whole board.
function gameFingerprint(rd, sides) {
  const body = rd + '|' + sides.map((s, i) => (i + 1) + ':' + s.join(',')).join('|');
  return crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
}
// Tonight's games, newest first, with the rosters that were solidified with them.
function gamesTonight(programId, rd) {
  const rows = db.prepare('SELECT * FROM run_games WHERE program_id = ? AND run_date = ? ORDER BY id DESC').all(programId, rd);
  if (!rows.length) return [];
  const seats = db.prepare('SELECT p.game_id, p.email, p.side FROM run_game_players p JOIN run_games g ON g.id = p.game_id WHERE g.program_id = ? AND g.run_date = ?').all(programId, rd);
  const names = ladderNames(programId, seats.filter(s => !isTombstone(s.email)).map(s => s.email));
  const byGame = new Map();
  for (const s of seats) {
    if (!byGame.has(s.game_id)) byGame.set(s.game_id, [[], []]);
    const side = byGame.get(s.game_id)[s.side - 1];
    // A tombstoned seat is kept so the side counts stay honest, but it must never render as an
    // address. ladderNames cannot resolve it (there is no person left to resolve), so the raw
    // former-<hex>@adv.local would otherwise show up in the games list — the one place the
    // standings filter does not reach.
    if (side) side.push(isTombstone(s.email) ? 'Former player' : (names.get(lc(s.email)) || s.email));
  }
  return rows.map(r => {
    const sides = byGame.get(r.id) || [[], []];
    return {
      id: r.id, win: r.win_side, ws: r.w_score, ls: r.l_score, at: r.created_at,
      sides: sides.map(s => s.slice().sort()), counts: sides.map(s => s.length),
    };
  });
}
// Standings summed from the game rows on every read — never stored, so an Undo is simply correct
// rather than needing a compensating write.
function runGamesStandings(programId, from) {
  const rows = db.prepare('SELECT p.email, p.side, g.win_side, g.w_score, g.l_score, g.run_date FROM run_game_players p JOIN run_games g ON g.id = p.game_id WHERE g.program_id = ? AND g.run_date >= ? ORDER BY g.id DESC').all(programId, from);
  const players = new Map();
  const nights = new Set();
  for (const r of rows) {
    const em = lc(r.email);
    if (!players.has(em)) players.set(em, { email: em, w: 0, l: 0, scored: 0, pf: 0, pa: 0 });
    const p = players.get(em);
    const won = Number(r.side) === Number(r.win_side);
    if (won) p.w++; else p.l++;
    // Point differential exists ONLY for games somebody actually scored. A missing score is not a
    // zero-point game, so it contributes nothing rather than dragging a differential toward zero.
    if (r.w_score != null && r.l_score != null) {
      p.scored++;
      p.pf += won ? r.w_score : r.l_score;
      p.pa += won ? r.l_score : r.w_score;
    }
    nights.add(r.run_date);
  }
  // A hard-deleted person's seats were rekeyed to former-<hex>@adv.local so the games they played
  // still show the right number a side. They must not appear ON the board though: the whole point
  // of the delete was that they are gone, and an unresolvable address would rank as a raw slug.
  for (const em of [...players.keys()]) if (isTombstone(em)) players.delete(em);
  const names = ladderNames(programId, [...players.keys()]);
  const fin = (p) => ({ ...p, label: names.get(p.email) || p.email, pd: p.pf - p.pa, played: p.w + p.l });
  // Wins, then point differential, then win ratio, then name — the same chain as the pickleball
  // ladder. Differential can rank this high because every game carries a score: the run logs one
  // straight after each game, so it is complete data rather than the scored subset it would be if
  // the score were optional. (The NULL handling above stays regardless, so a game logged before
  // the score was required contributes no margin rather than a phantom zero.)
  const rank = (a, b) => {
    if (b.w !== a.w) return b.w - a.w;
    if (b.pd !== a.pd) return b.pd - a.pd;
    const ra = a.w / (a.played || 1), rb = b.w / (b.played || 1);
    if (rb !== ra) return rb - ra;
    return String(a.label).localeCompare(String(b.label));
  };
  const gameCount = db.prepare('SELECT COUNT(*) c FROM run_games WHERE program_id = ? AND run_date >= ?').get(programId, from).c;
  return { from, players: [...players.values()].map(fin).sort(rank), nights: nights.size, games: gameCount };
}
// A moved run date carries its games with it, or the night's results vanish from the board and
// Undo silently no-ops on a date that no longer has any games.
function migrateGamesNight(programId, oldRd, newRd) {
  if (!oldRd || !newRd || oldRd === newRd) return;
  db.prepare('UPDATE run_games SET run_date = ? WHERE program_id = ? AND run_date = ?').run(newRd, programId, oldRd);
}
// A hard-deleted person must not take everyone else's results with them. Their seats are rekeyed
// to a tombstone so the games they were in still have the right number of players on each side.
function purgeGameIdentity(email) {
  const em = lc(String(email || '').trim()); if (!em) return;
  const seats = db.prepare('SELECT 1 FROM run_game_players WHERE email = ? LIMIT 1').get(em);
  db.prepare('DELETE FROM run_roster WHERE email = ?').run(em);
  if (!seats) return;
  const tomb = `former-${crypto.randomBytes(4).toString('hex')}@adv.local`;
  db.prepare('UPDATE run_game_players SET email = ? WHERE email = ?').run(tomb, em);
}
// Operator: round-robin the UNASSIGNED floor players into the emptiest teams so a run never starts half-formed.
// Auto-fill core — PARTY-AWARE: a party (shared checkins.group_id) places as one BLOCK on the
// first team with room for all of it (friends who queued together play together); solo players
// then balance onto the least-filled team. An oversize party that fits nowhere whole falls back
// to per-player balancing (teams must still fill). Shared by the route + the demo seed.
function teamFillCore(programId, rd, by) {
  const t = teamsFeature(programId); if (!t) return;
  const counts = {}; for (let i = 1; i <= t.count; i++) counts[i] = 0;
  const assigned = new Set();
  const part = partitionFor(programId, rd);   // shared by the heal + the floor scan below
  for (const r of runTeamsFor(programId, rd, part)) { counts[r.team_no] = (counts[r.team_no] || 0) + 1; assigned.add(r.email); }
  // Units in floor order: parties as blocks, solos as singletons.
  const floor = teamFloor(programId, rd, part).filter(p => !assigned.has(p.email));
  const units = [], byGroup = new Map();
  for (const p of floor) {
    if (p.group_id) {
      if (!byGroup.has(p.group_id)) { const u = []; byGroup.set(p.group_id, u); units.push(u); }
      byGroup.get(p.group_id).push(p);
    } else units.push([p]);
  }
  for (const unit of units) {
    let teamN = 0;
    if (unit.length > 1) for (let i = 1; i <= t.count; i++) if (t.size - counts[i] >= unit.length) { teamN = i; break; }   // party → first team the WHOLE block fits
    if (teamN) {
      for (const p of unit) if (assignTeam(programId, rd, p.email, teamN, by)) counts[teamN]++;
    } else {
      for (const p of unit) {   // solo (or nowhere-whole party) → least-filled team
        let n = 0; for (let i = 1; i <= t.count; i++) if (counts[i] < t.size && (n === 0 || counts[i] < counts[n])) n = i;
        if (n && assignTeam(programId, rd, p.email, n, by)) counts[n]++;
      }
    }
  }
}

export {
  migrateGamesNight, purgeGameIdentity, clearTeamAssignment, teamsFeature, teamsOpen, assignTeam,
  teamFloor, teamsBoardData, GAME_MIN_SIDE, gamesOn, gameSidesNow, gameFingerprint, gamesTonight,
  teamsRosterFor, clearRunTeams, GAME_SCORE_MAX, runGamesStandings, teamFillCore, runTeamsFor,
};
