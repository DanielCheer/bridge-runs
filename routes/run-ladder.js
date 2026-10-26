// routes/run-ladder.js — the ladder's request handlers (runLadder*, runHeadcountSet), mounted for
// every program by mountRunProgram and inline for pickleball; the ladder logic is engine/ladder.js.
import db, { transact } from '../db.js';
import { pcoConnected, pcoGroupRoster } from '../pco.js';
import { ladderPage } from '../views/index.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { lc } from '../lib/email.js';
import { runLabelFor } from '../lib/dates.js';
import { applicantByEmail } from '../engine/applicants.js';
import { P, programGate, programJoinedBy } from '../engine/programs.js';
import { unreadCount } from '../engine/messages.js';
import {
  ladderFrom, ladderCfg, ladderRunDate, ladderStandings, ladderNominations, ladderNomsOpen,
  ladderRoster, ladderCanLog, headcountSeason, ladderTag, ladderActor, LADDER_SCORE_MAX,
  ladderMintEmail, HEADCOUNT_MAX, ladderNomsKey, LADDER_NOTE_MAX,
} from '../engine/ladder.js';

// ---------- LADDER (2026-09-08): doubles results → season standings ----------
function runLadderGet(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), me = req.userEmail;
  if (!programJoinedBy(programId, me) && !g.canOperate) return res.redirect(p.paths.run);
  const rd = ladderRunDate(programId);
  const roster = ladderRoster(programId, rd);
  const from = ladderFrom(programId);
  const a = applicantByEmail(me), cc = p.unread(me, a ? a.id : 0);
  res.send(ladderPage({
    program: programId, theme: p.config.theme || '', emoji: p.emoji, sport: p.displayName,
    title: `${p.displayName} Ladder`, award: cfg.award || 'Sportsmanship',
    email: me, runDate: rd, dateLabel: runLabelFor(rd), seasonFrom: from,
    roster, standings: ladderStandings(programId, from), noms: ladderNominations(programId, from),
    canLog: ladderCanLog(programId, cfg, g, me, roster), canOperate: g.canOperate,
    canSync: !!(cfg.pcoGroup && pcoConnected()),
    nominationsOpen: ladderNomsOpen(programId, cfg),
    headcounts: headcountSeason(programId, from),
    headcountToday: (db.prepare('SELECT n FROM run_headcount WHERE program_id = ? AND run_date = ?').get(programId, rd) || {}).n,
    pointsTo: Number(cfg.pointsTo) || 11, basePath: p.paths.run,
    kioskUrl: g.canOperate && getSetting(`kiosk_token_${programId}`)
      ? `/kiosk/${programId}/ladder?k=${getSetting(`kiosk_token_${programId}`)}` : '',
    msg: String(req.query.msg || ''), err: String(req.query.err || ''),
    dmUnread: unreadCount(me), groupUnread: cc.group, groupMention: cc.gm,
  }));
}
// Record one game. Rejects anything the board could not honestly display: a player twice, someone
// who wasn't on tonight's roster, a non-integer or out-of-range score, or a "winner" who scored
// fewer points than the loser (the single most likely mis-tap at the court).
function runLadderLog(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`;
  const rd = ladderRunDate(programId);
  const roster = ladderRoster(programId, rd);
  if (!ladderCanLog(programId, cfg, g, req.userEmail, roster)) return res.redirect(back);
  const bad = (m) => res.redirect(`${back}?err=${encodeURIComponent(m)}`);
  const picked = ['w1', 'w2', 'l1', 'l2'].map(k => lc(String(req.body[k] || '').trim()));
  if (picked.some(e => !e)) return bad('Pick two winners and two losers.');
  if (new Set(picked).size !== 4) return bad('Nobody can play on both sides of the same game.');
  const known = new Set(roster.map(r => r.email));
  if (picked.some(e => !known.has(e))) return bad('Everyone in a game has to be on the roster — add them first.');
  const ws = Number(req.body.w_score), ls = Number(req.body.l_score);
  if (!Number.isInteger(ws) || !Number.isInteger(ls) || ws < 0 || ls < 0 || ws > LADDER_SCORE_MAX || ls > LADDER_SCORE_MAX) {
    return bad('Scores have to be whole numbers.');
  }
  if (ls >= ws) return bad("The winners' score has to be the higher one.");
  const [w1, w2] = [picked[0], picked[1]].sort();
  const [l1, l2] = [picked[2], picked[3]].sort();
  // Idempotency window. A POST with no idempotency key + a phone that double-fires the tap = two
  // identical rows, and nothing downstream can tell the phantom from a real rematch. The SAME four
  // people cannot genuinely replay the SAME scoreline within seconds — a game to 11 takes minutes —
  // so an exact repeat inside 20s is the double-tap, and it answers as the success it looks like.
  const dupe = db.prepare(`SELECT id FROM ladder_games
     WHERE program_id=? AND run_date=? AND w1=? AND w2=? AND l1=? AND l2=? AND w_score=? AND l_score=?
       AND created_at >= datetime('now', '-20 seconds')`).get(programId, rd, w1, w2, l1, l2, ws, ls);
  if (dupe) return res.redirect(`${back}?msg=${encodeURIComponent(`Logged ${ws}–${ls}.`)}`);
  db.prepare(`INSERT INTO ladder_games (program_id, run_date, w1, w2, l1, l2, w_score, l_score, logged_by)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(programId, rd, w1, w2, l1, l2, ws, ls, lc(req.userEmail));
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:log`, `${w1}+${w2} def ${l1}+${l2} ${ws}-${ls}`);
  res.redirect(`${back}?msg=${encodeURIComponent(`Logged ${ws}–${ls}.`)}`);
}
// Undo the last game of THIS run date. Scoped to the night on purpose: a mis-tap is corrected at
// the court, and nobody should be able to quietly rewrite an earlier week from tonight's screen.
function runLadderUndo(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`, rd = ladderRunDate(programId);
  const last = db.prepare(
    'SELECT * FROM ladder_games WHERE program_id = ? AND run_date = ? ORDER BY id DESC LIMIT 1').get(programId, rd);
  if (!last) return res.redirect(back);
  // A player-logger can take back their OWN last game; anything else is an operator call.
  if (!g.canOperate && lc(last.logged_by) !== lc(req.userEmail)) return res.redirect(back);
  db.prepare('DELETE FROM ladder_games WHERE id = ?').run(last.id);
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:undo`,
    `${last.w1}+${last.w2} def ${last.l1}+${last.l2} ${last.w_score}-${last.l_score}`);
  res.redirect(`${back}?msg=${encodeURIComponent('Game removed.')}`);
}
// Add a player to the ladder's own roster — the one-time typing that replaces re-entering names
// every week. An operator may attach a real member (their address, so the ladder and their profile
// are one identity) or just a name (synthetic @ladder.local). Re-adding a retired player revives
// them with their record intact.
function runLadderAdd(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`;
  if (!g.canOperate) return res.redirect(back);
  const bad = (m) => res.redirect(`${back}?err=${encodeURIComponent(m)}`);
  const name = String(req.body.name || '').trim().slice(0, 60);
  const typed = lc(String(req.body.email || '').trim());
  if (!name && !typed) return bad('Give the player a name.');
  // An address that belongs to a member links the two; anything else is ladder-only.
  const member = typed ? applicantByEmail(typed) : null;
  if (typed && !member && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(typed)) return bad("That doesn't look like an email address.");
  // Re-adding a name that is already on the roster REVIVES that player instead of minting a second
  // identity. Without this, "add Ann Ace" twice quietly splits one person's record in half — and
  // re-adding someone who was retired is exactly how a player comes back.
  // Re-adding a RETIRED player by name revives them (that is how someone comes back). But an ACTIVE
  // player with that name is a different question: two real people can share a name, and silently
  // folding them into one identity would merge two season records with no way back. Refuse, and say
  // how to tell them apart.
  const sameName = !typed && db.prepare(
    'SELECT email, retired_at FROM ladder_players WHERE program_id = ? AND lower(name) = lower(?)').get(programId, name);
  if (sameName && !sameName.retired_at) {
    return bad(`${name} is already on the roster. If this is a different person, add them with their email address.`);
  }
  const email = typed || (sameName ? sameName.email : ladderMintEmail(programId, name));
  const label = name || (member ? member.full_name : typed.split('@')[0]);
  const existing = db.prepare('SELECT * FROM ladder_players WHERE program_id = ? AND email = ?').get(programId, email);
  if (existing) {
    db.prepare('UPDATE ladder_players SET name = ?, retired_at = NULL WHERE program_id = ? AND email = ?').run(label, programId, email);
  } else {
    db.prepare('INSERT INTO ladder_players (program_id, email, name, added_by) VALUES (?,?,?,?)').run(programId, email, label, lc(req.userEmail));
  }
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:player-add`, email);
  res.redirect(`${back}?msg=${encodeURIComponent(`${label} added.`)}`);
}
// Pull the roster from the program's Planning Center group. This is the answer to "I don't want to
// type": Groups is readable with the church's ordinary member permissions, so the picker can fill
// itself. ADDITIVE ONLY — a person who left the PCO group is left alone rather than retired, because
// the group is a membership list and the ladder is a record of who plays; the two drift for good
// reasons (a guest who never joined, someone who left the group mid-season with games on the board).
async function runLadderSync(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`;
  if (!g.canOperate) return res.redirect(back);
  if (!cfg.pcoGroup) return res.redirect(`${back}?err=${encodeURIComponent('No Planning Center group is configured for this ladder.')}`);
  let people;
  try {
    people = await pcoGroupRoster(cfg.pcoGroup);
  } catch (e) {
    audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:sync-failed`, String(e.message).slice(0, 120));
    return res.redirect(`${back}?err=${encodeURIComponent('Planning Center: ' + String(e.message).slice(0, 90))}`);
  }
  const existing = new Set(db.prepare('SELECT email FROM ladder_players WHERE program_id = ?').all(programId).map(r => lc(r.email)));
  const ins = db.prepare(`INSERT INTO ladder_players (program_id, email, name, added_by) VALUES (?,?,?,?)
    ON CONFLICT(program_id, email) DO UPDATE SET
      name = CASE WHEN ladder_players.added_by LIKE 'pco:%' THEN excluded.name ELSE ladder_players.name END`);
  let added = 0, updated = 0, skipped = 0;
  transact(() => {
    for (const person of people) {
      if (!person.email) { skipped++; continue; }   // no address in PCO = no identity for the ladder
      if (existing.has(lc(person.email))) updated++; else added++;
      ins.run(programId, lc(person.email), person.name, `pco:group:${cfg.pcoGroup}`);
    }
  });
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:sync`, `+${added} new, ${updated} refreshed, ${skipped} skipped`);
  const msg = `Roster synced from Planning Center — ${added} added, ${updated} already on it` +
    (skipped ? `, ${skipped} skipped (no email in Planning Center)` : '') + '.';
  res.redirect(`${back}?msg=${encodeURIComponent(msg)}`);
}
function runHeadcountSet(programId, req, res) {
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`;
  if (!g.canOperate) return res.redirect(back);
  const rd = ladderRunDate(programId);
  const raw = String(req.body.n ?? '').trim();
  // Empty CLEARS the night — the way to undo a mis-typed count without leaving a wrong number up.
  if (raw === '') {
    db.prepare('DELETE FROM run_headcount WHERE program_id = ? AND run_date = ?').run(programId, rd);
    audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:headcount`, `${rd} cleared`);
    return res.redirect(`${back}?msg=${encodeURIComponent('Headcount cleared.')}`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > HEADCOUNT_MAX) {
    return res.redirect(`${back}?err=${encodeURIComponent('Headcount has to be a whole number.')}`);
  }
  db.prepare(`INSERT INTO run_headcount (program_id, run_date, n, noted_by) VALUES (?,?,?,?)
              ON CONFLICT(program_id, run_date) DO UPDATE SET n = excluded.n, noted_by = excluded.noted_by, at = datetime('now')`)
    .run(programId, rd, n, lc(req.userEmail));
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:headcount`, `${rd} = ${n}`);
  res.redirect(`${back}?msg=${encodeURIComponent(`${n} in the gym on ${runLabelFor(rd)} — logged.`)}`);
}
// Merge two roster rows that are the SAME human. The ladder is a second identity space — it holds
// people who have no app account — so the same person arrives twice as a matter of course: typed in
// as a walk-in one week ("Vincent"), then pulled from Planning Center the next ("Vincent Kua").
// Nothing upstream can prevent it, so the operator gets the repair rather than a duplicate that
// splits one person's record across two lines of the standings forever.
function runLadderMerge(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`;
  if (!g.canOperate) return res.redirect(back);
  const bad = (m) => res.redirect(`${back}?err=${encodeURIComponent(m)}`);
  const from = lc(String(req.body.from || '').trim()), into = lc(String(req.body.into || '').trim());
  if (!from || !into) return bad('Pick both players to merge.');
  if (from === into) return bad('Those are the same roster entry.');
  const rowFrom = db.prepare('SELECT * FROM ladder_players WHERE program_id = ? AND email = ?').get(programId, from);
  const rowInto = db.prepare('SELECT * FROM ladder_players WHERE program_id = ? AND email = ?').get(programId, into);
  if (!rowFrom || !rowInto) return bad('Both players have to be on this roster.');
  // A game with BOTH identities in it cannot be one person playing twice — it means a seat was
  // mis-picked on that night. Merging would silently collapse it into a corrupt 3-player row, so it
  // is refused with the nights named: the operator fixes those games, then merges.
  const clash = db.prepare(`SELECT DISTINCT run_date FROM ladder_games WHERE program_id = ?
      AND (w1=? OR w2=? OR l1=? OR l2=?)
      AND (w1=? OR w2=? OR l1=? OR l2=?)
      ORDER BY run_date`)
    .all(programId, from, from, from, from, into, into, into, into).map(r => r.run_date);
  if (clash.length) return bad(`${rowFrom.name} and ${rowInto.name} are both in the same game on ${clash.join(', ')} — fix those results first, then merge.`);
  transact(() => {
    for (const col of ['w1', 'w2', 'l1', 'l2'])
      db.prepare(`UPDATE ladder_games SET ${col} = ? WHERE program_id = ? AND ${col} = ?`).run(into, programId, from);
    // Nominations key on (program, night, voter): OR REPLACE drops the duplicate vote rather than
    // throwing and rolling the whole merge back.
    db.prepare('UPDATE OR REPLACE ladder_nominations SET email = ? WHERE program_id = ? AND email = ?').run(into, programId, from);
    db.prepare('UPDATE OR REPLACE ladder_nominations SET voter = ? WHERE program_id = ? AND voter = ?').run(into, programId, from);
    db.prepare('DELETE FROM ladder_players WHERE program_id = ? AND email = ?').run(programId, from);
    // A merge INTO a retired row would hide the surviving player: they just proved they still play.
    db.prepare('UPDATE ladder_players SET retired_at = NULL WHERE program_id = ? AND email = ?').run(programId, into);
  });
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:merge`, `${from} -> ${into}`);
  res.redirect(`${back}?msg=${encodeURIComponent(`${rowFrom.name} merged into ${rowInto.name} — one line on the board now.`)}`);
}
// Retire a player from the picker. Their games STAY — the standings are summed from results, and
// deleting a person would silently rewrite finished nights.
function runLadderRetire(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`;
  if (!g.canOperate) return res.redirect(back);
  const email = lc(String(req.body.email || '').trim());
  const row = db.prepare('SELECT * FROM ladder_players WHERE program_id = ? AND email = ?').get(programId, email);
  if (!row) return res.redirect(back);
  db.prepare("UPDATE ladder_players SET retired_at = datetime('now') WHERE program_id = ? AND email = ?").run(programId, email);
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:player-retire`, email);
  res.redirect(`${back}?msg=${encodeURIComponent(`${row.name} taken off the roster — their results stay.`)}`);
}
// Open or close award voting — the operator's one tap in the final weeks of the season. Writes the
// override ladder_noms_<pid>; clearing it would fall back to config, so both states are stored
// explicitly and the button always says what the next tap does.
function runLadderVoting(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`;
  if (!g.canOperate) return res.redirect(back);
  const open = String(req.body.open || '') === '1';
  setSetting(ladderNomsKey(programId), open ? '1' : '0');
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:voting`, open ? 'opened' : 'closed');
  res.redirect(`${back}?msg=${encodeURIComponent(open
    ? `${cfg.award || 'Sportsmanship'} voting is open — everyone gets one pick.`
    : 'Award voting closed.')}`);
}
// Nominate someone for the sportsmanship award. ANY member votes (that's the point of the award);
// one pick per person per night, replaceable.
function runLadderNominate(programId, req, res) {
  const cfg = ladderCfg(programId); if (!cfg) return res.status(404).send('Not found');
  const g = programGate(programId, req, res); if (!g) return;
  const p = P(programId), back = `${p.paths.run}/ladder`, me = lc(req.userEmail);
  if (!programJoinedBy(programId, me) && !g.canOperate) return res.redirect(p.paths.run);
  // Voting is a season-END event, not a running tally: the form is hidden while voting is closed,
  // and the handler refuses too — a hidden form is a UI state, not a permission.
  if (!ladderNomsOpen(programId, cfg)) return res.redirect(`${back}?err=${encodeURIComponent('Award voting opens at the end of the season.')}`);
  // A suspended member keeps their login but loses the floor; they do not get to publish a note on
  // the board either (the other member-level surfaces check this; this one did not).
  if (g.a && g.a.status !== 'approved' && !g.admin) return res.redirect(back);
  const rd = ladderRunDate(programId);
  const who = lc(String(req.body.email || '').trim());
  const roster = ladderRoster(programId, rd);
  if (!roster.some(r => r.email === who)) return res.redirect(`${back}?err=${encodeURIComponent('Pick someone who played tonight.')}`);
  if (who === me && !g.canOperate) return res.redirect(`${back}?err=${encodeURIComponent('Nominate someone else.')}`);
  const note = String(req.body.note || '').trim().slice(0, LADDER_NOTE_MAX);
  db.prepare(`INSERT OR REPLACE INTO ladder_nominations (program_id, run_date, email, voter, note)
              VALUES (?,?,?,?,?)`).run(programId, rd, who, me, note);
  audit(req.userEmail, ladderActor(g, req), `${ladderTag(programId)}:ladder:nominate`, who);
  res.redirect(`${back}?msg=${encodeURIComponent('Nomination in.')}`);
}

export {
  runLadderGet, runLadderLog, runLadderUndo, runLadderAdd, runLadderSync, runHeadcountSet,
  runLadderMerge, runLadderRetire, runLadderVoting, runLadderNominate,
};
