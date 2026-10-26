// Pickleball's doubles ladder: dark where not enabled; a roster typed once; only an operator logs
// (log:'operator'); every mis-tap that would lie to the board is refused; wins rank and point
// differential breaks ties; double-taps write once; undo removes exactly the last game; award
// voting is closed until opened and leaks no emails; nominations replace, never stack; turnout
// headcounts overwrite; duplicate identities merge safely; a retired player keeps their history;
// the wall board needs the kiosk token. Then the night-identity regression: after the run has
// ended, games, nominations and undo still belong to TONIGHT, not next week.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN } from './helpers/app.mjs';
import { runDateFor, ymd } from '../fixtures/world.mjs';

const pid = 2, base = '/pickleball', MEMBER = 'ladder_member@test.local', TOKEN = 'laddertoken123';
const RD = runDateFor(pid, ymd(new Date()));

// Port of the private ladder-seed, run after boot: a pickleball member who is not an operator, an
// approved non-member, a clean board, the night recorded, a kiosk token, no season gate. `pin`
// pins pk_run_date; the night-identity phase leaves it unpinned (the path production takes) and
// opens award voting.
async function ladderApp({ pin, env } = {}) {
  const app = await startApp({ env });
  const db = app.db();
  const insA = db.prepare("INSERT OR IGNORE INTO applicants (full_name, email, phone, experience, waiver_ok, status) VALUES (?,?,'000-000-0000','x',1,'approved')");
  insA.run('Ladder Member', MEMBER);
  insA.run('Ladder Outsider', 'ladder_out@test.local');
  db.prepare("INSERT OR IGNORE INTO program_membership (program_id, email, status, role) VALUES (?,?,'approved','approved')").run(pid, MEMBER);
  for (const tbl of ['ladder_games', 'ladder_players', 'ladder_nominations']) db.prepare(`DELETE FROM ${tbl} WHERE program_id = ?`).run(pid);
  const set = db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?,?)');
  if (pin) set.run('pk_run_date', RD); else db.prepare("DELETE FROM app_settings WHERE key = 'pk_run_date'").run();
  set.run(`kiosk_token_${pid}`, TOKEN);
  if (!pin) set.run(`ladder_noms_${pid}`, '1');
  db.prepare("DELETE FROM app_settings WHERE key IN ('pk_season_start', 'season_start')").run();
  const post = async (p, body = {}, as = ADMIN) => {
    const r = await app.post(p, body, { as });
    return { status: r.status, to: r.headers.get('location') || '' };
  };
  const emailOf = (name) => db.prepare('SELECT email FROM ladder_players WHERE program_id = ? AND name = ?').get(pid, name)?.email;
  const log = (w1, w2, l1, l2, ws, ls, as = ADMIN) => post(`${base}/ladder/log`, { w1, w2, l1, l2, w_score: ws, l_score: ls }, as);
  return { app, db, post, emailOf, log };
}
const check = (name, cond) => assert.ok(cond, name);
// A successful write answers with a confirmation; an invalid one carries ?err=; a refused one
// bounces quietly back to the ladder.
const ok = (r) => r.status === 302 && r.to.includes('msg=');
const erred = (r) => r.to.includes('err=');
const bounced = (r) => /\/ladder(\?|$)/.test(r.to) && !r.to.includes('msg=');

describe('the ladder', () => {
  let L, ann, ben, cal, dee, eli;
  const games = () => L.db.prepare('SELECT * FROM ladder_games WHERE program_id = ? ORDER BY id').all(pid);
  const players = () => L.db.prepare('SELECT * FROM ladder_players WHERE program_id = ? AND retired_at IS NULL ORDER BY name').all(pid);
  const noms = () => L.db.prepare('SELECT * FROM ladder_nominations WHERE program_id = ?').all(pid);
  const text = async (p, as = ADMIN) => (await L.app.get(p, { as })).text();
  before(async () => { L = await ladderApp({ pin: true }); });
  after(async () => { await L?.app.stop(); });

  test('dark for a program without the feature', async () => {
    assert.equal((await L.app.get('/volleyball/ladder', { as: ADMIN })).status, 404);
  });

  test('the roster: typed once, kept, operator-only, and Planning Center sync gated', async () => {
    for (const n of ['Ann Ace', 'Ben Bank', 'Cal Chop', 'Dee Dink', 'Eli Edge']) await L.post(`${base}/ladder/player`, { name: n });
    check('five players', players().length === 5);
    check('synthetic @ladder.local identities', players().every((p) => /@ladder\.local$/.test(p.email)));
    await L.post(`${base}/ladder/player`, { name: 'Ann Ace' });
    check('no duplicate on re-add', players().length === 5);
    check('a non-operator cannot add', bounced(await L.post(`${base}/ladder/player`, { name: 'Sneaky Sam' }, MEMBER)) && players().length === 5);
    [ann, ben, cal, dee, eli] = ['Ann Ace', 'Ben Bank', 'Cal Chop', 'Dee Dink', 'Eli Edge'].map(L.emailOf);
    // No Planning Center credentials exist in a test world: this exercises the gate and the
    // failure path only. A test that reached Planning Center would write to a real directory.
    check('a non-operator cannot sync', bounced(await L.post(`${base}/ladder/sync`, {}, MEMBER)));
    check('sync with no connection fails loudly', erred(await L.post(`${base}/ladder/sync`)));
    check('and leaves the roster alone', players().length === 5);
  });

  test('only an operator logs; every lie is refused', async () => {
    check('a member cannot log', bounced(await L.log(ann, ben, cal, dee, 11, 5, MEMBER)) && games().length === 0);
    for (const [why, args] of [
      ['a player on both sides', [ann, ben, ann, dee, 11, 3]],
      ['someone not on the roster', [ann, ben, cal, 'ghost@ladder.local', 11, 3]],
      ['a winner who scored fewer', [ann, ben, cal, dee, 4, 11]],
      ['a tie', [ann, ben, cal, dee, 11, 11]],
      ['a non-numeric score', [ann, ben, cal, dee, 'eleven', 3]],
      ['an out-of-range score', [ann, ben, cal, dee, 500, 3]],
    ]) check(`refuses ${why}`, erred(await L.log(...args)) && games().length === 0);
  });

  test('the board: wins first, point differential breaks ties; writes answer cleanly; double-taps write once', async () => {
    await L.log(ann, ben, cal, dee, 11, 2);   // A+B +9
    await L.log(ann, ben, cal, dee, 11, 3);   // A+B +8
    await L.log(cal, dee, ann, ben, 11, 9);   // C+D +2
    await L.log(cal, dee, eli, ann, 11, 4);   // C+D +7
    await L.log(eli, ann, cal, dee, 11, 8);   // E+A +3
    check('five games', games().length === 5);
    check('a successful log answers with a confirmation, not a 500', ok(await L.log(ann, ben, cal, dee, 11, 1)));
    await L.post(`${base}/ladder/undo`);
    const n0 = games().length;
    await L.log(ann, ben, cal, dee, 11, 7);
    const twice = await L.log(ann, ben, cal, dee, 11, 7);
    check('a double-tap records one game and still answers success', games().length === n0 + 1 && ok(twice));
    await L.post(`${base}/ladder/undo`);
    check('a genuine rematch is still loggable', ok(await L.log(ann, ben, cal, dee, 11, 6)) && games().length === n0 + 1);
    await L.post(`${base}/ladder/undo`);
    check('a roster add answers cleanly', ok(await L.post(`${base}/ladder/player`, { name: 'Temp Sub' })));
    check('so does a retire', ok(await L.post(`${base}/ladder/retire`, { email: L.emailOf('Temp Sub') })));
    // Ann 3-2 (+11) · Ben 2-1 (+15) · Cal 2-3 (-11) · Eli 1-1 (-4)
    const page = await text(`${base}/ladder`);
    const board = page.split('Last games')[0];
    const order = ['Ann Ace', 'Ben Bank', 'Cal Chop', 'Eli Edge'].map((n) => board.indexOf(n));
    check('everyone on the board', order.every((i) => i > -1));
    check('most wins leads', order[0] < order[1]);
    check('differential breaks a tie on wins', order[1] < order[2]);
    check('the tiebreak rule is published', /wins, then point differential/i.test(page));
    check('a record is rendered', board.includes('3&ndash;2') || board.includes('3–2'));
    check('pairings only in the games log', !board.includes('Ann Ace + Ben Bank') && page.includes('Ann Ace + Ben Bank'));
  });

  test('one name per person; no truncation claim while everyone fits', async () => {
    const page = await text(`${base}/ladder`);
    L.db.prepare('INSERT OR IGNORE INTO ladder_players (program_id, email, name, added_by) VALUES (?,?,?,?)').run(pid, MEMBER, 'Roster Spelling', 'test');
    const p2 = await text(`${base}/ladder`);
    check('the profile name wins everywhere', p2.includes('Ladder Member') && !p2.includes('Roster Spelling'));
    L.db.prepare('DELETE FROM ladder_players WHERE program_id = ? AND email = ?').run(pid, MEMBER);
    check('no "Show the other" claim', !/Show the other/.test(page));
  });

  test('undo: operator-only, exactly the last game', async () => {
    const last = games().at(-1);
    check('a member cannot undo', bounced(await L.post(`${base}/ladder/undo`, {}, MEMBER)) && games().length === 5);
    await L.post(`${base}/ladder/undo`);
    check('exactly the last one', games().length === 4 && !games().some((g) => g.id === last.id));
    await L.log(eli, ann, cal, dee, 11, 8);
  });

  test('award voting is closed until an operator opens it, and leaks no emails', async () => {
    const page = await text(`${base}/ladder`, MEMBER);
    check('no nominate form while closed', !page.includes('/ladder/nominate'));
    check('no roster email in the page', !page.includes(ann) && !page.includes(ben));
    check('a nomination posted anyway is refused', erred(await L.post(`${base}/ladder/nominate`, { email: ann }, MEMBER)) && noms().length === 0);
    const isOpen = () => L.db.prepare('SELECT value v FROM app_settings WHERE key = ?').get(`ladder_noms_${pid}`)?.v === '1';
    check('a member cannot open voting', bounced(await L.post(`${base}/ladder/voting`, { open: '1' }, MEMBER)) && !isOpen());
    check('an operator opens it, no restart', ok(await L.post(`${base}/ladder/voting`, { open: '1' })) && isOpen());
  });

  test('nominations: any member, one per voter per night, roster-only, kept when voting closes', async () => {
    check('answers cleanly', ok(await L.post(`${base}/ladder/nominate`, { email: ann, note: 'coached the new guys' }, MEMBER)));
    check('a member can nominate', noms().length === 1);
    await L.post(`${base}/ladder/nominate`, { email: ben }, MEMBER);
    check('a second pick replaces the first', noms().length === 1 && noms()[0].email === ben);
    check('not someone off the roster', erred(await L.post(`${base}/ladder/nominate`, { email: 'ghost@ladder.local' }, MEMBER)) && noms().length === 1);
    check('shows on the board', (await text(`${base}/ladder`)).includes('Ben Bank'));
    await L.post(`${base}/ladder/voting`, { open: '0' });
    const after = await text(`${base}/ladder`);
    check('closing hides the form but keeps the result', !after.includes('/ladder/nominate') && after.includes('Ben Bank'));
    await L.post(`${base}/ladder/voting`, { open: '1' });
  });

  test('turnout headcount: operator-only, overwrites, validated, clearable', async () => {
    const hc = () => L.db.prepare('SELECT * FROM run_headcount WHERE program_id = ?').all(pid);
    check('a member cannot log turnout', bounced(await L.post(`${base}/headcount`, { n: '12' }, MEMBER)) && hc().length === 0);
    check('an operator logs it', ok(await L.post(`${base}/headcount`, { n: '12' })) && hc().length === 1 && hc()[0].n === 12);
    const night = hc()[0].run_date;
    await L.post(`${base}/headcount`, { n: '14' });
    check('a correction overwrites the night', hc().length === 1 && hc()[0].n === 14 && hc()[0].run_date === night);
    check('non-numeric refused', erred(await L.post(`${base}/headcount`, { n: 'twelve' })) && hc()[0].n === 14);
    check('out of range refused', erred(await L.post(`${base}/headcount`, { n: '1200' })) && hc()[0].n === 14);
    check('shown with its average', /14/.test(await text(`${base}/ladder`)) && /average over 1 night/.test(await text(`${base}/ladder`)));
    check('operator-only on the page', !/\/headcount/.test(await text(`${base}/ladder`, MEMBER)));
    check('an empty value clears the night', ok(await L.post(`${base}/headcount`, { n: '' })) && hc().length === 0);
    await L.post(`${base}/headcount`, { n: '12' });
  });

  test('merging a duplicate identity: operator-only, never into itself or onto both sides, games carried', async () => {
    await L.post(`${base}/ladder/player`, { name: 'Dupe Guy' });
    const dupe = L.emailOf('Dupe Guy');
    await L.log(dupe, ann, cal, dee, 11, 5);
    const night = L.db.prepare('SELECT run_date FROM ladder_games WHERE program_id = ? ORDER BY id DESC LIMIT 1').get(pid).run_date;
    const before = games().length;
    check('a member cannot merge', bounced(await L.post(`${base}/ladder/merge`, { from: dupe, into: ben }, MEMBER)) && !!L.emailOf('Dupe Guy'));
    check('not into itself', erred(await L.post(`${base}/ladder/merge`, { from: dupe, into: dupe })) && !!L.emailOf('Dupe Guy'));
    const clash = await L.post(`${base}/ladder/merge`, { from: dupe, into: ann });
    check('not onto both sides of a game, naming the night', erred(clash) && decodeURIComponent(clash.to).includes(night) && !!L.emailOf('Dupe Guy'));
    const merged = await L.post(`${base}/ladder/merge`, { from: dupe, into: ben });
    const seats = (e) => L.db.prepare('SELECT COUNT(*) c FROM ladder_games WHERE program_id = ? AND (w1 = ? OR w2 = ? OR l1 = ? OR l2 = ?)').get(pid, e, e, e, e).c;
    check('the duplicate is gone', ok(merged) && !L.emailOf('Dupe Guy'));
    check('its games moved, not deleted', games().length === before && seats(ben) >= 1);
    check('no seat points at the old identity', seats(dupe) === 0);
    await L.post(`${base}/ladder/undo`);
  });

  test('a retired player leaves the picker but keeps their history', async () => {
    const before = games().length;
    await L.post(`${base}/ladder/retire`, { email: eli });
    check('off the picker', !players().some((p) => p.email === eli));
    check('games kept', games().length === before);
    check('still in the standings', (await text(`${base}/ladder`)).includes('Eli Edge'));
  });

  test('the wall board: kiosk token only, no controls, self-refreshing', async () => {
    check('refused without a token', (await L.app.get(`/kiosk/${pid}/ladder`)).status === 403);
    check('refused with a wrong one', (await L.app.get(`/kiosk/${pid}/ladder?k=wrongtoken`)).status === 403);
    const r = await L.app.get(`/kiosk/${pid}/ladder?k=${TOKEN}`);
    const body = await r.text();
    check('opens with the token, no sign-in', r.status === 200 && body.includes('Ann Ace'));
    check('no controls', !body.includes('/ladder/log') && !body.includes('Log it'));
    check('refreshes itself', body.includes('location.reload'));
  });
});

test('night identity: after the run has ended, games, nominations and undo still belong to tonight', async (t) => {
  // The clock is after pickleball's end and no run date is pinned: exactly production at 9 PM.
  const L = await ladderApp({ pin: false, env: { TEST_NOW: `${RD}T21:05:00` } });
  t.after(() => L.app.stop());
  for (const n of ['Night One', 'Night Two', 'Night Three', 'Night Four']) await L.post(`${base}/ladder/player`, { name: n });
  const e = L.emailOf;
  const r = await L.log(e('Night One'), e('Night Two'), e('Night Three'), e('Night Four'), 11, 6);
  const g = L.db.prepare('SELECT * FROM ladder_games WHERE program_id = ? ORDER BY id DESC LIMIT 1').get(pid);
  check('the game is stamped tonight, not next week', g?.run_date === RD);
  check('and answered cleanly', ok(r));
  await L.post(`${base}/ladder/nominate`, { email: e('Night One') }, MEMBER);
  const nom = L.db.prepare('SELECT * FROM ladder_nominations WHERE program_id = ? ORDER BY rowid DESC LIMIT 1').get(pid);
  check('the nomination is stamped tonight', nom?.run_date === RD);
  const count = () => L.db.prepare('SELECT COUNT(*) c FROM ladder_games WHERE program_id = ?').get(pid).c;
  const before = count();
  await L.post(`${base}/ladder/undo`);
  check('undo removes the game just played', count() === before - 1);
});
