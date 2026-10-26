// routes/run-teams.js — the teams board, game results and leaderboard handlers (and the Planning
// Center roster sync the board runs), mounted for every program by mountRunProgram and inline for
// basketball; the logic is engine/teams.js.
import db, { transact } from '../db.js';
import { pcoConnected } from '../pco.js';
import { teamsBoardPage, leaderboardPage } from '../views/index.js';
import { audit } from '../lib/audit.js';
import { lc } from '../lib/email.js';
import { runLabelFor } from '../lib/dates.js';
import { applicantByEmail } from '../engine/applicants.js';
import { P, programGate, programRunDate, runCancelledFor, programJoinedBy } from '../engine/programs.js';
import { unreadCount } from '../engine/messages.js';
import { runNightFor, ladderTag, ladderFrom } from '../engine/ladder.js';
import {
  teamsFeature, teamsOpen, assignTeam, teamFloor, clearTeamAssignment, teamsBoardData, GAME_MIN_SIDE,
  gamesOn, gameSidesNow, gameFingerprint, gamesTonight, teamsRosterFor, clearRunTeams, GAME_SCORE_MAX,
  runGamesStandings, teamFillCore,
} from '../engine/teams.js';
import { syncRunRosterFromPco } from '../engine/roster-sync.js';

// ---------- WEEKLY ROSTER SYNC (Planning Center Registrations -> run_roster) ----------
function runRosterSync(programId, req, res) {
  const cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return;
  const back = `${P(programId).paths.run}/teams`;
  if (!g.canOperate) return res.redirect(P(programId).paths.run);
  const rd = runNightFor(programId);
  syncRunRosterFromPco(programId, rd, req.userEmail).then((r) => {
    if (!r.signup) return res.redirect(`${back}?err=${encodeURIComponent(`No Planning Center signup found for ${runLabelFor(rd)}.`)}`);
    const bits = [`${r.added + r.kept} registered`];
    if (r.added) bits.push(`${r.added} new`);
    if (r.removed) bits.push(`${r.removed} cancelled, removed`);
    if (r.skipped) bits.push(`${r.skipped} cancelled or waitlisted in PCO`);
    if (r.unresolved) bits.push(`${r.unresolved} Planning Center would not answer for — sync again to add them`);
    res.redirect(`${back}?msg=${encodeURIComponent(`${r.signup.name} — ${bits.join(' · ')}.`)}`);
  }).catch((e) => {
    audit(req.userEmail, 'admin', `${cfg.logTag || 'run'}:roster-sync-failed`, String(e.message).slice(0, 120));
    res.redirect(`${back}?err=${encodeURIComponent(String(e.message).slice(0, 140))}`);
  });
}
// ---------- RUN TEAMS (Phase 5) — program-generic, config-driven (config.features.teams) ----------
// A floor player self-joins / switches a team (only once teams are open + they're on the floor).
function runTeamJoin(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return;
  const t = teamsFeature(programId); if (!t) return res.redirect(base);
  const rd = programRunDate(programId);
  if (!teamsOpen(programId, rd) || !t.selfServe) return res.redirect(base);
  if (teamFloor(programId, rd).some(p => p.email === req.userEmail)) assignTeam(programId, rd, req.userEmail, req.body.team, '');
  res.redirect(base);
}
function runTeamLeave(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return;
  clearTeamAssignment(programId, programRunDate(programId), req.userEmail);
  res.redirect(base);
}
// ---------- THE TEAMS BOARD (operator surface, built for a phone at courtside) ----------
function runTeamsBoard(programId, req, res) {
  const t = teamsFeature(programId); if (!t) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId);
  if (!g.canOperate) return res.redirect(p.paths.run);
  const d = teamsBoardData(programId);
  const a = applicantByEmail(req.userEmail), cc = p.unread(req.userEmail, a ? a.id : 0);
  res.send(teamsBoardPage({
    program: programId, theme: p.config.theme || '', emoji: p.emoji, sport: p.displayName,
    email: req.userEmail, runDate: d.rd, dateLabel: runLabelFor(d.rd),
    sides: d.sides, bench: d.bench, basePath: p.paths.run,
    canSync: !!(p.config.pcoSignupPrefix && pcoConnected()),
    // The fingerprint is what the sides looked like when this page rendered. The POST recomputes
    // it and refuses on a mismatch, so a stale tab cannot solidify a game whose rosters have moved.
    ...(gamesOn(programId)
      ? { games: true, gameMinSide: GAME_MIN_SIDE, tonight: gamesTonight(programId, d.rd), fp: gameFingerprint(d.rd, gameSidesNow(programId, d.rd)) }
      : {}),
    msg: String(req.query.msg || ''), err: String(req.query.err || ''),
    dmUnread: unreadCount(req.userEmail), groupUnread: cc.group, groupMention: cc.gm,
  }));
}
// ONE TAP = the other side. The whole point of the board.
function runTeamSwap(programId, req, res) {
  const t = teamsFeature(programId); if (!t) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/teams`;
  if (!g.canOperate) return res.redirect(p.paths.run);
  const rd = runNightFor(programId);
  const email = lc(String(req.body.email || '').trim());
  if (!teamsRosterFor(programId, rd).some(x => x.email === email)) return res.redirect(back);
  const cur = (db.prepare('SELECT team_no FROM team_assignments WHERE program_id = ? AND run_date = ? AND email = ?')
    .get(programId, rd, email) || {}).team_no;
  // IDEMPOTENCY. The tap says "move them off the side I can see them on". A double-tap on gym wifi,
  // a browser resubmit, or a second operator working from a stale board would otherwise toggle them
  // straight back and look like the tap never landed. If they have already moved, do nothing.
  const from = String(req.body.from ?? '');
  if (from !== '' && String(cur ?? '') !== from) return res.redirect(back);
  // From a side -> the other side. From the bench -> whichever side is shorter (so a tap on the
  // bench always does the sensible thing without the operator having to look at the counts).
  let target;
  if (cur >= 1 && cur <= t.count) target = (Number(cur) % t.count) + 1;
  else {
    const counts = db.prepare('SELECT team_no, COUNT(*) c FROM team_assignments WHERE program_id = ? AND run_date = ? GROUP BY team_no').all(programId, rd);
    const size = (n) => (counts.find(r => Number(r.team_no) === n) || {}).c || 0;
    target = 1; for (let n = 2; n <= t.count; n++) if (size(n) < size(target)) target = n;
  }
  if (!assignTeam(programId, rd, email, target, lc(req.userEmail)))
    return res.redirect(`${back}?err=${encodeURIComponent(`Side ${target} is full.`)}`);
  res.redirect(back);
}
// Off the sides entirely — sitting out, subbed, gone home. Their floor seat is untouched.
function runTeamBench(programId, req, res) {
  const t = teamsFeature(programId); if (!t) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/teams`;
  if (!g.canOperate) return res.redirect(p.paths.run);
  clearTeamAssignment(programId, runNightFor(programId), lc(String(req.body.email || '').trim()));
  res.redirect(back);
}
// Wipe the sides and start again — faster than benching thirteen people one at a time.
function runTeamsClear(programId, req, res) {
  const t = teamsFeature(programId); if (!t) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/teams`;
  if (!g.canOperate) return res.redirect(p.paths.run);
  const rd = runNightFor(programId);
  clearRunTeams(programId, rd);
  audit(req.userEmail, 'admin', `${p.config.logTag || 'run'}:teams-clear`, rd);
  res.redirect(`${back}?msg=${encodeURIComponent('Sides cleared.')}`);
}
// Operator: assign/move any floor player, or unassign (team 0/blank).
function runTeamAssign(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  if (!teamsFeature(programId)) return res.redirect(base);
  const rd = programRunDate(programId), em = String(req.body.email || '').toLowerCase(), n = String(req.body.team || '');
  if (n === '0' || n === '') clearTeamAssignment(programId, rd, em);
  // Floor check mirrors runTeamJoin: without it an arbitrary email seats, holds a chair in
  // assignTeam's size guard, then silently vanishes on the next render's self-heal — a phantom
  // assignment. (Clearing above stays unconditional: clearing a stale row is always safe.)
  else if (teamFloor(programId, rd).some((p) => lc(p.email) === em)) assignTeam(programId, rd, em, n, req.userEmail);
  res.redirect(base);
}
// Solidify the game showing on the board. One tap; the score is a second, optional one.
function runGameLog(programId, req, res) {
  if (!gamesOn(programId)) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/teams`;
  if (!g.canOperate) return res.redirect(p.paths.run);
  const fail = (m) => res.redirect(`${back}?err=${encodeURIComponent(m)}`);

  const rd = runNightFor(programId);                 // recomputed here, never trusted from the form
  // A cancelled night did not happen, so nothing can be recorded against it. Every other write on
  // a run guards this (runOpen, runJoin, runGuest); the games path shipped without it, which would
  // let a stale teams board still open in a tab log a result onto a night the gym was closed — and
  // that result would then rank on the standings for a game nobody played.
  if (runCancelledFor(programId, rd)) return fail('This run is cancelled — no games can be logged for it.');
  const sides = gameSidesNow(programId, rd);
  if (sides.some(s => s.length < GAME_MIN_SIDE))
    return fail(`Both sides need at least ${GAME_MIN_SIDE} players before a game can be logged.`);
  if (String(req.body.fp || '') !== gameFingerprint(rd, sides))
    return fail('The sides changed since this screen loaded — it just refreshed, tap again.');

  // The score IS the result. This run logs one straight after every game, so there is no separate
  // "who won" to ask: two numbers already say it. Deriving the winner rather than collecting it
  // also removes the one way the two answers could disagree — a tap on Side 1 filed against a
  // 17-21 scoreline, which would be a silently wrong result, the worst thing this can produce.
  const raw1 = String(req.body.s1 ?? '').trim(), raw2 = String(req.body.s2 ?? '').trim();
  if (raw1 === '' || raw2 === '') return fail('Enter both scores.');
  const n1 = Number(raw1), n2 = Number(raw2);
  if (![n1, n2].every(n => Number.isInteger(n) && n >= 0 && n <= GAME_SCORE_MAX))
    return fail(`Scores must be whole numbers between 0 and ${GAME_SCORE_MAX}.`);
  if (n1 === n2) return fail('A game cannot end level — check the score.');
  const win = n1 > n2 ? 1 : 2;
  const ws = Math.max(n1, n2), ls = Math.min(n1, n2);

  // Gym wifi double-fire. A real game takes minutes, so the identical result logged again within
  // seconds is a resubmit — answer as though it worked and write nothing.
  const last = db.prepare("SELECT id FROM run_games WHERE program_id = ? AND run_date = ? AND win_side = ? AND w_score IS ? AND l_score IS ? AND created_at >= datetime('now','-20 seconds') ORDER BY id DESC LIMIT 1").get(programId, rd, win, ws, ls);
  if (last) {
    const prev = db.prepare('SELECT email, side FROM run_game_players WHERE game_id = ?').all(last.id);
    const same = prev.length === sides.flat().length
      && prev.every(r => (sides[r.side - 1] || []).includes(lc(r.email)));
    if (same) return res.redirect(`${back}?msg=${encodeURIComponent('Already logged.')}`);
  }

  transact(() => {
    const info = db.prepare('INSERT INTO run_games (program_id, run_date, win_side, w_score, l_score, logged_by) VALUES (?,?,?,?,?,?)')
      .run(programId, rd, win, ws, ls, lc(req.userEmail));
    const ins = db.prepare('INSERT INTO run_game_players (game_id, email, side) VALUES (?,?,?)');
    sides.forEach((s, i) => s.forEach(em => ins.run(info.lastInsertRowid, em, i + 1)));
  });
  audit(req.userEmail, 'admin', `${ladderTag(programId)}:game:log`,
    `${rd} side${win} ${sides.map(s => s.length).join('v')}${ws == null ? '' : ` ${ws}-${ls}`}`);
  res.redirect(`${back}?msg=${encodeURIComponent(`Side ${win} won${ws == null ? '' : ` ${ws}-${ls}`}.`)}`);
}
// Undo the last game of TONIGHT — the mis-tap fix. Older nights are settled history; correcting
// one is a merge/relog conversation, not a button on a phone mid-run.
function runGameUndo(programId, req, res) {
  if (!gamesOn(programId)) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/teams`;
  if (!g.canOperate) return res.redirect(p.paths.run);
  const rd = runNightFor(programId);
  const last = db.prepare('SELECT * FROM run_games WHERE program_id = ? AND run_date = ? ORDER BY id DESC LIMIT 1').get(programId, rd);
  if (!last) return res.redirect(`${back}?err=${encodeURIComponent('Nothing logged tonight.')}`);
  // Anchored to the game the operator could SEE, exactly like the log path's fingerprint. A POST
  // retried on a stalled socket, or a second tap through the confirm because nothing appeared to
  // happen, would otherwise delete the NEXT game down as well — destroying a correct result, which
  // is worse than any wrong one this feature can record.
  const want = String(req.body.id || '');
  if (want && want !== String(last.id))
    return res.redirect(`${back}?err=${encodeURIComponent('That game was already removed — nothing else was touched.')}`);
  transact(() => {
    db.prepare('DELETE FROM run_game_players WHERE game_id = ?').run(last.id);
    db.prepare('DELETE FROM run_games WHERE id = ?').run(last.id);
  });
  audit(req.userEmail, 'admin', `${ladderTag(programId)}:game:undo`, `${rd} side${last.win_side} (game ${last.id})`);
  res.redirect(`${back}?msg=${encodeURIComponent('Last game removed.')}`);
}
// The leaderboard. Members can read it; only operators see the merge tool.
// "Member" here is programJoinedBy, NOT memberOf. memberOf is a program_membership lookup, and a
// DROP-IN program never writes those rows — the live database carries zero for program 1 while
// programs 2/3/4 have them — so memberOf(1, …) was true for admins and nobody else, and this gate
// silently bounced every ordinary player off their own standings. programJoinedBy is the resolver
// that already knows the difference: membership for an opt-in run, "on the org team / has ever
// checked in or attended" for a drop-in one. (Open question for the owner: a Planning-Center
// registrant who has never checked in lives in run_roster and is still bounced. Counting
// run_roster would fix that, but the same predicate gates CHAT — widening it is a product call.)
function runLeaderboard(programId, req, res) {
  if (!gamesOn(programId)) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId);
  // Same bar as the pickleball ladder page: this run's members and its operators, nobody else.
  // It carries every player's name and record, and any address a name failed to resolve to.
  if (!programJoinedBy(programId, req.userEmail) && !g.canOperate) return res.redirect(p.paths.run);
  const from = ladderFrom(programId);
  const st = runGamesStandings(programId, from);
  const rd = runNightFor(programId);
  const a = applicantByEmail(req.userEmail), cc = p.unread(req.userEmail, a ? a.id : 0);
  res.send(leaderboardPage({
    program: programId, theme: p.config.theme || '', emoji: p.emoji, sport: p.displayName,
    email: req.userEmail, basePath: p.paths.run, canOperate: !!g.canOperate,
    from, players: st.players, nights: st.nights, games: st.games,
    recent: gamesTonight(programId, rd), dateLabel: runLabelFor(rd),
    msg: String(req.query.msg || ''), err: String(req.query.err || ''),
    dmUnread: unreadCount(req.userEmail), groupUnread: cc.group, groupMention: cc.gm,
  }));
}
// Two rows, one human. The roster sync keys identity on email, so the week a Planning Center
// record gains a real address the same player starts a second column. Refuses when both were on
// the SAME game, because that is not one person.
function runGameMerge(programId, req, res) {
  if (!gamesOn(programId)) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/leaderboard`;
  if (!g.canOperate) return res.redirect(p.paths.run);
  const from = lc(String(req.body.from || '').trim()), into = lc(String(req.body.into || '').trim());
  if (!from || !into || from === into) return res.redirect(`${back}?err=${encodeURIComponent('Pick two different players.')}`);
  const clash = db.prepare('SELECT g.run_date d FROM run_game_players p JOIN run_games g ON g.id = p.game_id WHERE g.program_id = ? AND p.email IN (?, ?) GROUP BY p.game_id HAVING COUNT(*) = 2 LIMIT 3').all(programId, from, into);
  if (clash.length) return res.redirect(`${back}?err=${encodeURIComponent(
    `Those two were on the same game (${[...new Set(clash.map(c => c.d))].join(', ')}), so they are not the same person.`)}`);
  transact(() => {
    db.prepare('UPDATE run_game_players SET email = ? WHERE email = ? AND game_id IN (SELECT id FROM run_games WHERE program_id = ?)')
      .run(into, from, programId);
  });
  audit(req.userEmail, 'admin', `${ladderTag(programId)}:game:merge`, `${from} -> ${into}`);
  res.redirect(`${back}?msg=${encodeURIComponent('Merged.')}`);
}
function runTeamFill(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  if (!teamsFeature(programId)) return res.redirect(base);
  teamFillCore(programId, programRunDate(programId), req.userEmail);
  res.redirect(base);
}

export {
  runRosterSync, runTeamJoin, runTeamLeave, runTeamsBoard, runTeamSwap, runTeamBench, runTeamsClear,
  runTeamAssign, runGameLog, runGameUndo, runLeaderboard, runGameMerge, runTeamFill,
};
