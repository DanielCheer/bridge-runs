// Privacy: DMs are encrypted at rest (enc1:, never plaintext in the database), decrypt for both
// participants, show the privacy line, and legacy plaintext rows still read. And "friends going"
// on the hub only shows someone you follow mutually -- a one-way follow shows nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/app.mjs';
import { PERSONAS, PLAYERS, runDateFor, ymd } from '../fixtures/world.mjs';

const TEAM = PERSONAS.team, REG = PLAYERS[0];
let app, db;
before(async () => {
  app = await startApp({
    seed: (d) => {
      d.prepare("UPDATE applicants SET full_name = 'Terry Team' WHERE email = ?").run(TEAM);
      d.prepare("UPDATE applicants SET full_name = 'Reggie Reg' WHERE email = ?").run(REG);
      d.prepare('DELETE FROM messages').run();
      d.prepare('DELETE FROM social_edges WHERE from_email IN (?,?) OR to_email IN (?,?)').run(TEAM, REG, TEAM, REG);
    },
  });
  db = app.db();
});
after(async () => { await app?.stop(); });

const idOf = (e) => db.prepare('SELECT id FROM applicants WHERE email = ?').get(e).id;
const page = async (p, as) => (await app.get(p, { as })).text();
const SECRET_MSG = 'secret hello world 42';

test('a DM is stored as ciphertext, never plaintext', async () => {
  await app.post('/messages/' + idOf(REG), { body: SECRET_MSG }, { as: TEAM });
  const row = db.prepare('SELECT body FROM messages WHERE from_email = ? AND to_email = ? ORDER BY id DESC LIMIT 1').get(TEAM, REG);
  assert.ok(row, 'the DM was stored');
  assert.ok(row.body.startsWith('enc1:'));
  assert.ok(!row.body.includes('secret hello'));
});

test('both participants read it decrypted, with the privacy line', async () => {
  const sender = await page('/messages/' + idOf(REG), TEAM);
  assert.ok(sender.includes(SECRET_MSG));
  assert.ok(sender.includes('organizers don') && sender.includes('Private chat'));
  assert.ok((await page('/messages/' + idOf(TEAM), REG)).includes(SECRET_MSG));
});

test('legacy plaintext rows still read', async () => {
  db.prepare('INSERT INTO messages (from_email, to_email, body) VALUES (?,?,?)').run(TEAM, REG, 'legacy plain msg no marker');
  assert.ok((await page('/messages/' + idOf(REG), TEAM)).includes('legacy plain msg no marker'));
});

test('friends going: hidden for a one-way follow, shown for a mutual one', async () => {
  const rd = runDateFor(1, ymd(new Date()));
  db.prepare('INSERT INTO checkins (run_date, program_id, email, name) VALUES (?,1,?,?)').run(rd, REG, 'Reggie Reg');
  // The hub keys on the run date the app renders; if they differ the rest can't mean anything.
  const poll = await (await app.get('/poll?page=checkin', { as: TEAM })).json();
  assert.equal(String(poll.f).split(':')[0], rd, 'precondition: the hub shows the night we seeded');
  db.prepare("INSERT INTO social_edges (from_email, to_email, kind, status) VALUES (?,?,'follow','accepted')").run(TEAM, REG);
  assert.ok(!(await page('/runs', TEAM)).includes('Reggie is going'), 'one-way follow: hidden');
  db.prepare("INSERT INTO social_edges (from_email, to_email, kind, status) VALUES (?,?,'follow','accepted')").run(REG, TEAM);
  assert.ok((await page('/runs', TEAM)).includes('Reggie is going'), 'mutual follow: shown');
});
