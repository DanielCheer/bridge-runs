// The live demo run (program 90): seed builds a synthetic floor + waitlist, the REAL offer engine
// fires when a floor player is removed, the claim slides the offered player on, the teams showcase
// is party-aware, the chat shows every message type, end/start queue cycles auto-renew, and clear
// wipes it -- all without touching applicants or any other program's rows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN } from './helpers/app.mjs';
import { PLAYERS, runDateFor, ymd } from '../fixtures/world.mjs';

let app, db;
before(async () => {
  // A real program with people on its night, so "the demo left real programs untouched" compares
  // against something.
  app = await startApp({
    seed: (d) => {
      const rd = runDateFor(1, ymd(new Date()));
      const ins = d.prepare('INSERT INTO checkins (run_date, email, name, program_id, sort_order) VALUES (?,?,?,1,?)');
      PLAYERS.slice(0, 3).forEach((e, i) => ins.run(rd, e, `Player ${i + 1}`, i));
    },
  });
  db = app.db();
});
after(async () => { db?.close(); await app?.stop(); });

const one = (sql, ...a) => db.prepare(sql).get(...a);
const cnt = (sql, ...a) => one(sql, ...a).n;
const text = async (p) => (await app.get(p, { as: ADMIN })).text();
const post = (p, body) => app.post(p, body, { as: ADMIN });
const realCheckins = () => cnt('SELECT COUNT(*) n FROM checkins WHERE program_id IN (1,2,3)');

let realBefore, page;

test('seed builds a full floor + waitlist of synthetic players, run open', async () => {
  realBefore = realCheckins();
  assert.ok(realBefore >= 3, `real-program check-ins before the demo: ${realBefore}`);
  await post('/admin/demo/seed');
  assert.equal(cnt('SELECT COUNT(*) n FROM checkins WHERE program_id = 90'), 14);
  const rd = one('SELECT DISTINCT run_date FROM checkins WHERE program_id = 90').run_date;
  assert.equal(one('SELECT is_open FROM run_state WHERE program_id = 90 AND run_date = ?', rd).is_open, 1);
  assert.equal(cnt("SELECT COUNT(*) n FROM checkins WHERE program_id = 90 AND email NOT LIKE '%@demo.local'"), 0, 'every demo player is @demo.local');
  assert.ok(cnt('SELECT COUNT(*) n FROM group_messages WHERE program_id = 90') > 0, 'bot chatter seeded');
  assert.ok((await text('/demo/chat')).includes('Andre'), 'chat names a bot by its roster name, not an email');
});

test('isolation: no demo applicants, real programs untouched', () => {
  assert.equal(cnt("SELECT COUNT(*) n FROM applicants WHERE email LIKE '%@demo.local'"), 0);
  assert.equal(realCheckins(), realBefore);
});

test('the demo page renders the control strip, the minor marker, and no role badges', async () => {
  page = await text('/demo');
  assert.ok(page.includes('Demo mode') && page.includes('Marcus B.'));
  assert.ok(page.includes('class="minast"'), 'the minor is marked with the red asterisk');
  assert.ok(!page.includes('bdg reg') && !page.includes('bdg team'), 'roles stay off the roster');
});

test('teams showcase: the party-aware auto-fill ran at seed', () => {
  const teamOf = (i) => one('SELECT team_no FROM team_assignments WHERE program_id = 90 AND email = ?', `demo-${i}@demo.local`)?.team_no;
  assert.equal(cnt('SELECT COUNT(*) n FROM team_assignments WHERE program_id = 90'), 12);
  assert.ok([1, 2, 3, 4].every((i) => teamOf(i) === 1), 'Team 1 = one whole party');
  assert.ok([5, 6, 7, 8].every((i) => teamOf(i) === 2), 'Team 2 = two different groups');
  assert.ok([9, 10, 11, 12].every((i) => teamOf(i) === 3), 'Team 3 = individuals');
  assert.equal(cnt('SELECT COUNT(*) n FROM signup_groups WHERE program_id = 90'), 3);
  assert.ok(page.includes('pdot pd1') && page.includes('pdot pd2') && page.includes('pdot pd3'), 'three party colours');
  assert.equal((page.match(/class="pdot /g) || []).length, 8, 'one dot per party member, none for solos');
});

let offered;
test('removing a floor player fires a real offer to the top waitlister', async () => {
  await post('/demo/remove', { email: 'demo-1@demo.local' });
  offered = one('SELECT email, claim_token FROM checkins WHERE program_id = 90 AND offered_at IS NOT NULL');
  assert.equal(offered?.email, 'demo-13@demo.local');
  assert.ok(offered.claim_token.length > 10);
});

test('claiming the offer slides the player onto the floor', async () => {
  await post('/demo/claim/' + encodeURIComponent(offered.claim_token));
  const claimed = one("SELECT offered_at, claim_token FROM checkins WHERE program_id = 90 AND email = 'demo-13@demo.local'");
  assert.equal(claimed.offered_at, null);
  assert.equal(claimed.claim_token, null);
  assert.equal(cnt('SELECT COUNT(*) n FROM checkins WHERE program_id = 90'), 13);
  assert.equal(cnt('SELECT COUNT(*) n FROM checkins WHERE program_id = 90 AND offered_at IS NOT NULL'), 0);
});

test('demo profiles are tappable and carry badges', async () => {
  assert.ok(page.includes('pvOpenDemo(1)'));
  const card2 = await text('/demo/u/2/card');
  assert.ok(card2.includes('bdg team') && card2.includes('Jordan'), 'team badge on the card');
  assert.ok(card2.includes('Follow'));
  assert.ok((await text('/demo/u/4/card')).includes('bdg minor'), 'the minor carries the Minor tag');
  assert.ok((page.match(/pvOpenDemo\(/g) || []).length > 14, 'team panel names are tappable too');
  assert.equal((page.match(/· FULL/g) || []).length, 3, 'full teams are marked');
});

test('chat showcase: every message type is seeded and rendered', async () => {
  for (const [what, sql] of [
    ['photo', "image = '/gym.jpg'"], ['sticker', "image LIKE '/stickers/%'"],
    ['voice', "audio = '/demo-media/voice.m4a'"], ['video', "video = '/demo-media/clip.mp4'"],
    ['reply', 'reply_to IS NOT NULL'], ['pin', 'pinned_at IS NOT NULL'],
  ]) assert.ok(one(`SELECT 1 x FROM group_messages WHERE program_id = 90 AND ${sql}`), what);
  const chat = await text('/demo/chat');
  for (const s of ['/gym.jpg', '/stickers/', '/demo-media/voice.m4a', '/demo-media/clip.mp4']) assert.ok(chat.includes(s), s);
});

test('end queue then start queue: auto-renewers reclaim their spots, idempotently', async () => {
  await post('/admin/demo/endqueue');
  assert.equal(cnt('SELECT COUNT(*) n FROM checkins WHERE program_id = 90'), 0);
  assert.equal(one('SELECT is_open FROM run_state WHERE program_id = 90').is_open, 0);
  await post('/admin/demo/startqueue');
  assert.equal(one('SELECT is_open FROM run_state WHERE program_id = 90').is_open, 1);
  assert.equal(cnt('SELECT COUNT(*) n FROM checkins WHERE program_id = 90 AND auto_seated = 1'), 5);
  assert.equal(cnt('SELECT COUNT(*) n FROM checkins WHERE program_id = 90'), 5);
  await post('/admin/demo/startqueue');
  assert.equal(cnt('SELECT COUNT(*) n FROM checkins WHERE program_id = 90'), 5, 're-posting adds no duplicates');
});

test('clear removes everything demo-related and nothing else', async () => {
  await post('/admin/demo/clear');
  assert.equal(cnt('SELECT COUNT(*) n FROM checkins WHERE program_id = 90'), 0);
  assert.equal(cnt('SELECT COUNT(*) n FROM run_state WHERE program_id = 90'), 0);
  assert.equal(cnt('SELECT COUNT(*) n FROM group_messages WHERE program_id = 90'), 0);
  assert.equal(realCheckins(), realBefore);
});
