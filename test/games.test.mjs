// Game results on basketball's teams board, and the leaderboard they feed. In order: the score bar
// exists only where games are on; a result snapshots both sides and credits everyone; the board
// fingerprint refuses a stale lineup; every way a score can lie is refused; a double-fire writes
// one game; undo removes exactly one and is anchored against retries; only an operator logs, undoes
// or merges; standings rank by wins then differential and show synced players by NAME; a merge
// refuses two people from the same game; a deleted player leaves the board; the leaderboard is a
// member surface; hostile names render inert; a cancelled night can't be scored.
//
// Like the private suite, the night is a fixed in-season Wednesday with the clock pinned to it,
// seeded after boot: eight Planning Center registrants, four a side.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN } from './helpers/app.mjs';

const PID = 1, base = '/checkin', rd = '2026-09-23';
const MEMBER = 'games_member@test.local', PLAYER = 'games_player@test.local';
// The pco-* shapes are what the roster sync mints for a registrant with no email on file.
const ROSTER = [
  ['pco-9001@adv.local', 'Amos Side-One'], ['pco-9002@adv.local', 'Bez Side-One'],
  ['pco-9003@adv.local', 'Cai Side-One'], ['real-one@test.local', 'Dee Side-One'],
  ['pco-9005@adv.local', 'Eli Side-Two'], ['pco-9006@adv.local', 'Fen Side-Two'],
  ['pco-9007@adv.local', 'Gus Side-Two'], ['real-two@test.local', 'Hal Side-Two'],
];

let app, db;
before(async () => {
  app = await startApp({ env: { TEST_NOW: `${rd}T20:45:00` } });
  db = app.db();
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('season_start', '2026-09-01') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  for (const t of ['run_roster', 'team_assignments']) db.prepare(`DELETE FROM ${t} WHERE program_id = ?`).run(PID);
  db.prepare('DELETE FROM run_game_players WHERE game_id IN (SELECT id FROM run_games WHERE program_id = ?)').run(PID);
  db.prepare('DELETE FROM run_games WHERE program_id = ?').run(PID);
  const roster = db.prepare("INSERT INTO run_roster (program_id, run_date, email, name, source) VALUES (?,?,?,?,'pco')");
  const seat = db.prepare("INSERT INTO team_assignments (program_id, run_date, email, team_no, assigned_by) VALUES (?,?,?,?,'seed')");
  ROSTER.forEach(([e, n], i) => { roster.run(PID, rd, e, n); seat.run(PID, rd, e, i < 4 ? 1 : 2); });
  const person = db.prepare("INSERT INTO applicants (full_name, email, phone, experience, status) VALUES (?,?,'000-000-0000','rec','approved')");
  person.run('Games Member', MEMBER);   // not an operator, never played
  person.run('Games Player', PLAYER);   // has played this program before (archived attendance only)
  db.prepare('INSERT INTO attendance (run_date, email, name, program_id) VALUES (?,?,?,?)').run('2026-01-07', PLAYER, 'Games Player', PID);
});
after(async () => { await app?.stop(); });

const check = (name, cond, extra) => assert.ok(cond, extra ? `${name} -> ${extra}` : name);
const post = async (p, body = {}, as = ADMIN) => {
  const r = await app.post(p, body, { as });
  return { status: r.status, to: r.headers.get('location') || '' };
};
const text = async (p, as = ADMIN) => (await app.get(p, { as })).text();
const gamesRows = () => db.prepare('SELECT * FROM run_games WHERE program_id = ? ORDER BY id').all(PID);
const seatsOf = (gid) => db.prepare('SELECT email, side FROM run_game_players WHERE game_id = ? ORDER BY email').all(gid);
const seatCount = (e) => db.prepare('SELECT COUNT(*) c FROM run_game_players WHERE email = ?').get(e).c;
const wipe = () => { db.prepare('DELETE FROM run_game_players WHERE game_id IN (SELECT id FROM run_games WHERE program_id = ?)').run(PID); db.prepare('DELETE FROM run_games WHERE program_id = ?').run(PID); };
// The fingerprint the board just rendered, read the way a browser would.
const freshFp = async () => (await text(`${base}/teams`)).match(/name="fp" value="([^"]+)"/)?.[1] || '';
const logScore = async (s1, s2, as = ADMIN) => post(`${base}/game`, { s1, s2, fp: await freshFp() }, as);
const logGame = async (side, as = ADMIN) => post(`${base}/game`, { s1: side === 1 ? 21 : 17, s2: side === 1 ? 17 : 21, fp: await freshFp() }, as);
const erred = (r) => r.to.includes('err=');
const standings = (h) => [...h.matchAll(/class="ldnm"[^>]*>([^<]+)</g)].map((m) => m[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the board renders the score bar only where games are on', async () => {
  const h = await text(`${base}/teams`);
  check('score bar', h.includes('Final score'));
  check('both score inputs, required', /name="s1"[^>]*required/.test(h) && /name="s2"[^>]*required/.test(h));
  check('one log button, no winner buttons', h.includes('Log this game') && !h.includes('Side 1 won'));
  check('a fingerprint is embedded', /name="fp" value="[0-9a-f]{12}"/.test(h));
  check('pickleball (no games) has no score bar', !(await text('/pickleball/teams')).includes('Final score'));
});

test('a result snapshots both sides and credits everyone', async () => {
  wipe();
  const r = await logGame(1);
  const g = gamesRows();
  check('one game', g.length === 1, `got ${g.length}`);
  check('winner and score stored', g[0].win_side === 1 && g[0].w_score === 21 && g[0].l_score === 17);
  const s = seatsOf(g[0].id);
  check('all 8 snapshotted, 4 a side', s.length === 8 && s.filter((x) => x.side === 1).length === 4);
  check('synthetic pco addresses captured', s.some((x) => x.email.startsWith('pco-')));
  check('back to the board with a message', r.to.includes('/teams') && r.to.includes('msg='));
});

test('standings: records, names not slugs, a differential', async () => {
  const h = await text(`${base}/leaderboard`);
  check('renders', h.includes('Leaderboard'));
  check('1-0 and 0-1', h.includes('1&ndash;0') && h.includes('0&ndash;1'));
  const names = standings(h);
  check('names resolve', names.includes('Amos Side-One'), names.join('|'));
  check('no raw pco- slug', !names.some((n) => n.startsWith('pco-')), names.join('|'));
  check('a differential', /class="pd (up|down)"/.test(h));
});

test('a made-up fingerprint is refused and writes nothing', async () => {
  const before = gamesRows().length;
  check('refused', erred(await post(`${base}/game`, { s1: 21, s2: 17, fp: 'deadbeefcafe' })));
  check('nothing written', gamesRows().length === before);
});

test('every bad score is refused; a good one derives the winner', async () => {
  const before = gamesRows().length;
  for (const [s1, s2] of [['21', ''], ['', '21'], ['', ''], ['21', '21'], ['210', '3'], ['-2', '3'], ['abc', '3'], ['10.5', '3']])
    check(`refused: ${s1 || '(blank)'} - ${s2 || '(blank)'}`, erred(await logScore(s1, s2)));
  check('none wrote a game', gamesRows().length === before);
  const good = await logScore('17', '21');
  const last = gamesRows().at(-1);
  check('accepted', !erred(good) && gamesRows().length === before + 1, good.to);
  check('the winner is derived', last.win_side === 2);
  check('stored winner-first', last.w_score === 21 && last.l_score === 17);
});

test('a scored player with no margin shows 0, never a dash', async () => {
  const h = await text(`${base}/leaderboard`);
  const pds = [...h.matchAll(/class="pd[^"]*">([^<]+)</g)].map((m) => m[1]);
  check('0 shown', pds.includes('0'), pds.join('|'));
  check('no dash', !pds.includes('—'), pds.join('|'));
  check('the header states the ranking', h.includes('most wins first, then point differential'));
});

test('a double-fire writes one game and still answers success', async () => {
  wipe();
  const fp = await freshFp();
  await post(`${base}/game`, { s1: 21, s2: 17, fp });
  check('first written', gamesRows().length === 1);
  const b = await post(`${base}/game`, { s1: 21, s2: 17, fp });
  check('repeat suppressed', gamesRows().length === 1);
  check('repeat answers success', !erred(b), b.to);
});

test('undo removes exactly the last game and its players', async () => {
  const before = gamesRows();
  const lastId = before.at(-1).id;
  const r = await post(`${base}/game/undo`);
  const after = gamesRows();
  check('one removed', after.length === before.length - 1);
  check('the last one', !after.some((g) => g.id === lastId));
  check('its players too', seatsOf(lastId).length === 0);
  check('reports back', r.to.includes('msg='));
});

test('only an operator logs, undoes or merges', async () => {
  const before = gamesRows().length;
  await logGame(1, MEMBER);
  check('a member cannot log', gamesRows().length === before);
  await post(`${base}/game/undo`, {}, MEMBER);
  check('a member cannot undo', gamesRows().length === before);
  await logGame(2);
  check('(precondition) a seat to merge', seatCount('pco-9001@adv.local') === 1);
  await post(`${base}/game/merge`, { from: 'pco-9001@adv.local', into: 'real-one@test.local' }, MEMBER);
  check('a member cannot merge', seatCount('pco-9001@adv.local') === 1);
});

test('a half-cleared board is not a game', async () => {
  wipe();
  const saved = db.prepare('SELECT email, team_no FROM team_assignments WHERE program_id = ? AND run_date = ?').all(PID, rd);
  db.prepare('DELETE FROM team_assignments WHERE program_id = ? AND run_date = ? AND team_no = 2').run(PID, rd);
  check('a side below the minimum is refused', erred(await logGame(1)));
  check('nothing written', gamesRows().length === 0);
  check('the result bar is hidden', !(await text(`${base}/teams`)).includes('Who won that one?'));
  const re = db.prepare("INSERT INTO team_assignments (program_id, run_date, email, team_no, assigned_by) VALUES (?,?,?,?,'seed')");
  for (const s of saved) if (s.team_no === 2) re.run(PID, rd, s.email, 2);
});

test('merge: refused for two people on the same game; a genuine split identity merges', async () => {
  wipe();
  await logGame(1);
  check('same-game merge refused', erred(await post(`${base}/game/merge`, { from: 'pco-9001@adv.local', into: 'pco-9005@adv.local' })));
  check('neither touched', seatCount('pco-9001@adv.local') === 1);
  wipe();
  const g1 = db.prepare("INSERT INTO run_games (program_id, run_date, win_side, logged_by) VALUES (?,?,1,'t')").run(PID, rd).lastInsertRowid;
  db.prepare('INSERT INTO run_game_players (game_id, email, side) VALUES (?,?,1)').run(g1, 'split-old@adv.local');
  const g2 = db.prepare("INSERT INTO run_games (program_id, run_date, win_side, logged_by) VALUES (?,?,2,'t')").run(PID, rd).lastInsertRowid;
  db.prepare('INSERT INTO run_game_players (game_id, email, side) VALUES (?,?,2)').run(g2, 'split-new@adv.local');
  check('merges', !erred(await post(`${base}/game/merge`, { from: 'split-old@adv.local', into: 'split-new@adv.local' })));
  check('every game moved', seatCount('split-new@adv.local') === 2);
  check('the old address is gone', seatCount('split-old@adv.local') === 0);
});

test('undo is anchored: a retried undo does not eat a second game', async () => {
  wipe();
  await logScore('21', '17');
  await sleep(1100);
  await logScore('19', '21');
  check('(precondition) two games', gamesRows().length === 2);
  const id = (await text(`${base}/teams`)).match(/name="id" value="(\d+)"/)?.[1];
  check('the undo form carries the game id', !!id);
  await post(`${base}/game/undo`, { id });
  check('first undo removes one', gamesRows().length === 1);
  const again = await post(`${base}/game/undo`, { id });
  check('the retry removes nothing', gamesRows().length === 1);
  check('and says so', erred(again), again.to);
});

test('a real roster change invalidates the fingerprint', async () => {
  wipe();
  const stale = await freshFp();
  const victim = db.prepare('SELECT email FROM team_assignments WHERE program_id = ? AND run_date = ? AND team_no = 1 LIMIT 1').get(PID, rd).email;
  db.prepare('DELETE FROM team_assignments WHERE program_id = ? AND run_date = ? AND email = ?').run(PID, rd, victim);
  check('refused', erred(await post(`${base}/game`, { s1: 21, s2: 17, fp: stale })));
  check('nothing solidified', gamesRows().length === 0);
  db.prepare("INSERT INTO team_assignments (program_id, run_date, email, team_no, assigned_by) VALUES (?,?,?,1,'seed')").run(PID, rd, victim);
  const ok = await logScore('21', '17');
  check('a fresh fingerprint logs', !erred(ok) && gamesRows().length === 1);
});

test('a player who switches ends is credited on both, margins adding up', async () => {
  wipe();
  const one = 'pco-9001@adv.local';
  await logScore('21', '11');   // side 1 by 10
  await sleep(1100);
  db.prepare('UPDATE team_assignments SET team_no = 2 WHERE program_id = ? AND run_date = ? AND email = ?').run(PID, rd, one);
  await logScore('9', '21');    // side 2 by 12, same player
  const st = db.prepare(`SELECT SUM(CASE WHEN p.side = g.win_side THEN 1 ELSE 0 END) w,
      SUM(CASE WHEN p.side = g.win_side THEN g.w_score - g.l_score ELSE g.l_score - g.w_score END) pd
    FROM run_game_players p JOIN run_games g ON g.id = p.game_id WHERE g.program_id = ? AND p.email = ?`).get(PID, one);
  check('two wins', st.w === 2, JSON.stringify(st));
  check('+22 margin', st.pd === 22, JSON.stringify(st));
  db.prepare('UPDATE team_assignments SET team_no = 1 WHERE program_id = ? AND run_date = ? AND email = ?').run(PID, rd, one);
});

test('a hard-deleted player keeps the side count but leaves the board', async () => {
  wipe();
  await logScore('21', '17');
  const gid = gamesRows()[0].id;
  db.prepare("UPDATE run_game_players SET email = 'former-deadbeef@adv.local' WHERE game_id = ? AND email = 'pco-9002@adv.local'").run(gid);
  check('(precondition) the seat survives as a tombstone', seatsOf(gid).length === 8);
  const h = await text(`${base}/leaderboard`);
  const names = standings(h);
  check('not ranked', !names.some((n) => n.includes('former-')), names.join('|'));
  check('not a merge target', !h.includes('former-deadbeef'));
  check('the living seven remain', names.length === 7, `${names.length}`);
});

test('the leaderboard is a member surface: a stranger is refused, a player is let in', async () => {
  check('refused to a non-member', !(await text(`${base}/leaderboard`, MEMBER)).includes('class="ldnm"'));
  check('shown to someone who has played', (await text(`${base}/leaderboard`, PLAYER)).includes('class="ldnm"'));
});

test('games are dark where teams are not two-sided', async () => {
  for (const prog of ['/volleyball', '/demo']) {
    check(`POST ${prog}/game is 404`, (await post(`${prog}/game`, { s1: 21, s2: 17 })).status === 404);
    check(`GET ${prog}/leaderboard is 404`, (await app.get(`${prog}/leaderboard`, { as: ADMIN })).status === 404);
  }
});

test('a hostile name from Planning Center renders inert', async () => {
  wipe();
  const bad = '<img src=x onerror=alert(1)>';
  db.prepare('UPDATE run_roster SET name = ? WHERE program_id = ? AND run_date = ? AND email = ?').run(bad, PID, rd, 'pco-9003@adv.local');
  await logScore('21', '17');
  const h = await text(`${base}/leaderboard`);
  check('escaped on the leaderboard', !h.includes('<img src=x') && h.includes('&lt;img src=x'));
  check('escaped on the teams board', !(await text(`${base}/teams`)).includes('<img src=x'));
  db.prepare('UPDATE run_roster SET name = ? WHERE program_id = ? AND run_date = ? AND email = ?').run('Cai Side-One', PID, rd, 'pco-9003@adv.local');
});

test('a cancelled night cannot be scored, and says why', async () => {
  const count = () => db.prepare('SELECT COUNT(*) n FROM run_games WHERE program_id = ? AND run_date = ?').get(PID, rd).n;
  const before = count();
  db.prepare('INSERT INTO run_state (run_date, program_id, is_open, cancelled) VALUES (?,?,0,1) ON CONFLICT(run_date, program_id) DO UPDATE SET cancelled = 1').run(rd, PID);
  const r = await logScore(19, 12);   // distinct from the last game, so the duplicate window can't explain a refusal
  check('refused', count() === before, `${before} -> ${count()}`);
  check('says cancelled', /cancelled/i.test(decodeURIComponent(r.to)), r.to.slice(0, 120));
  db.prepare('UPDATE run_state SET cancelled = 0 WHERE run_date = ? AND program_id = ?').run(rd, PID);
  await logScore(19, 12);
  check('un-cancelled: the same game logs', count() === before + 1);
});
