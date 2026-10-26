// The program-generic run-chat mutation paths (post / react / pin / delete) on pickleball and
// volleyball, and the membership gate that keeps a non-member from posting.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN } from './helpers/app.mjs';
import { PERSONAS, PLAYERS } from '../fixtures/world.mjs';

const PK_MEMBER = PLAYERS[0];   // an approved pickleball member, not team
let app, db;
before(async () => { app = await startApp(); db = app.db(); });
after(async () => { db?.close(); await app?.stop(); });

const msgByBody = (pid, body) => db.prepare('SELECT id, pinned_at, from_email FROM group_messages WHERE program_id = ? AND body = ?').get(pid, body);
const reactCount = (mid, pid) => db.prepare('SELECT COUNT(*) n FROM group_reactions WHERE group_message_id = ? AND program_id = ?').get(mid, pid).n;

for (const [label, pid, base, poster] of [['pickleball', 2, '/pickleball', PK_MEMBER], ['volleyball', 3, '/volleyball', ADMIN]]) {
  test(`${label}: post, react, pin, delete (with cascade)`, async () => {
    const body = `${label}_hello_${pid}`;
    await app.post(`${base}/chat`, { body }, { as: poster });
    const m = msgByBody(pid, body);
    assert.ok(m, 'the post inserted a row in this program');
    assert.equal(m.from_email, poster);
    await app.post(`${base}/chat/react`, { message_id: m.id, emoji: '👍' }, { as: ADMIN });
    assert.equal(reactCount(m.id, pid), 1, 'reaction recorded');
    await app.post(`${base}/chat/pin`, { message_id: m.id }, { as: ADMIN });
    assert.ok(msgByBody(pid, body).pinned_at, 'pinned');
    await app.post(`${base}/chat/delete`, { message_id: m.id }, { as: poster });
    assert.equal(msgByBody(pid, body), undefined, 'deleted');
    assert.equal(reactCount(m.id, pid), 0, 'its reactions went with it');
  });
}

test('a non-member cannot post into a program room', async () => {
  await app.post('/volleyball/chat', { body: 'vb_gate_blocked' }, { as: PERSONAS.pending });
  assert.equal(msgByBody(3, 'vb_gate_blocked'), undefined);
  await app.post('/pickleball/chat', { body: 'pk_gate_blocked' }, { as: PERSONAS.pending });
  assert.equal(msgByBody(2, 'pk_gate_blocked'), undefined);
  // A member of one program is still not a member of another: player01 plays pickleball, not volleyball.
  await app.post('/volleyball/chat', { body: 'vb_wrong_program' }, { as: PK_MEMBER });
  assert.equal(msgByBody(3, 'vb_wrong_program'), undefined);
});
