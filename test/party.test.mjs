// Persistent parties (the Friends tab) and the per-run seating they drive on volleyball: create,
// follow-gated invites, accept; "check in as party" seats everyone atomically and confirmed, from
// any joined member; a member who left this run isn't resurrected; blocking breaks both the run
// party and the persistent one; only the leader removes; one party per person; an invited-but-
// not-joined member can't seat the party.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/app.mjs';
import { PLAYERS } from '../fixtures/world.mjs';

// Three volleyball members (the fixture's volleyball roster is player05..12).
const [LEAD, M1, M2] = [PLAYERS[4], PLAYERS[5], PLAYERS[7]];
let app, db, RD;
before(async () => {
  app = await startApp({
    seed: (d) => {
      const follow = d.prepare("INSERT OR IGNORE INTO social_edges (from_email, to_email, kind, status) VALUES (?,?,'follow','accepted')");
      for (const [a, b] of [[LEAD, M1], [LEAD, M2], [M2, M1]]) follow.run(a, b);
    },
  });
  db = app.db();
  RD = String((await (await app.get('/poll?page=volleyball', { as: LEAD })).json()).f).split(':')[0];
});
after(async () => { await app?.stop(); });

const post = (p, as, body = {}) => app.post(p, body, { as });
const idOf = (e) => db.prepare('SELECT id FROM applicants WHERE email = ?').get(e).id;
const partyLedBy = (e) => db.prepare('SELECT * FROM parties WHERE leader_email = ?').get(e);
const pmStatus = (pid, e) => db.prepare('SELECT status FROM party_members WHERE party_id = ? AND email = ?').get(pid, e)?.status;
const runGroupOf = (e) => db.prepare('SELECT id FROM signup_groups WHERE program_id = 3 AND run_date = ? AND leader_email = ?').get(RD, e);
const gidOnFloor = (e) => db.prepare('SELECT group_id FROM checkins WHERE program_id = 3 AND run_date = ? AND email = ?').get(RD, e)?.group_id;
const confAt = (e) => db.prepare('SELECT confirmed_at c FROM checkins WHERE program_id = 3 AND run_date = ? AND email = ?').get(RD, e)?.c;
const runMemberStatus = (gid, e) => db.prepare('SELECT status FROM signup_group_members WHERE group_id = ? AND email = ?').get(gid, e)?.status;
const resetAll = () => {
  db.prepare('DELETE FROM party_members').run();
  db.prepare('DELETE FROM parties').run();
  db.prepare('DELETE FROM signup_group_members WHERE group_id IN (SELECT id FROM signup_groups WHERE program_id = 3 AND run_date = ?)').run(RD);
  db.prepare('DELETE FROM signup_groups WHERE program_id = 3 AND run_date = ?').run(RD);
  db.prepare('DELETE FROM checkins WHERE program_id = 3 AND run_date = ?').run(RD);
  db.prepare('DELETE FROM regular_optout WHERE program_id = 3 AND run_date = ?').run(RD);
  db.prepare('INSERT OR REPLACE INTO run_state (run_date, program_id, is_open, cancelled) VALUES (?,3,1,0)').run(RD);
};

let pA, rg;
test('Friends tab: create, follow-gated invite picker, invite, accept', async () => {
  resetAll();
  await post('/friends/party/create', LEAD, { name: 'The Squad' });
  pA = partyLedBy(LEAD);
  assert.equal(pA?.name, 'The Squad');
  const html = await (await app.get('/friends', { as: LEAD })).text();
  const nameOf = (e) => db.prepare('SELECT full_name n FROM applicants WHERE email = ?').get(e).n;
  assert.ok(html.includes(nameOf(M1)) && html.includes(nameOf(M2)), 'the picker lists people you follow');
  await post('/friends/party/invite', LEAD, { id: idOf(M1) });
  await post('/friends/party/invite', LEAD, { id: idOf(M2) });
  assert.ok(pmStatus(pA.id, M1) === 'invited' && pmStatus(pA.id, M2) === 'invited');
  await post('/friends/party/accept', M1, { party: pA.id });
  await post('/friends/party/accept', M2, { party: pA.id });
  assert.ok(pmStatus(pA.id, M1) === 'joined' && pmStatus(pA.id, M2) === 'joined');
});

test('check in as party: atomic, all confirmed, triggered by a non-leader member', async () => {
  await post('/volleyball/party/checkin', M1);
  const g = gidOnFloor(LEAD);
  assert.ok(g && g === gidOnFloor(M1) && g === gidOnFloor(M2), 'all three on the floor under one group');
  assert.ok(confAt(LEAD) && confAt(M1) && confAt(M2), 'everyone confirmed');
});

test("a member who leaves this run isn't resurrected by a re-tap, and stays in the party", async () => {
  rg = runGroupOf(LEAD);
  await post('/volleyball/leave', M1);
  assert.ok(gidOnFloor(M1) == null && runMemberStatus(rg.id, M1) === 'declined');
  await post('/volleyball/party/checkin', LEAD);
  assert.equal(gidOnFloor(M1), undefined, 'not re-seated');
  assert.equal(pmStatus(pA.id, M1), 'joined', 'only this run was declined');
});

test('blocking breaks the run party and the persistent party', async () => {
  assert.equal(gidOnFloor(M2), rg.id, 'precondition: M2 is in the run party');
  await post('/friends/block', LEAD, { id: idOf(M2) });
  assert.ok(runMemberStatus(rg.id, M2) == null && gidOnFloor(M2) == null, 'dropped from the run party');
  assert.equal(pmStatus(pA.id, M2), undefined, 'dropped from the persistent party');
  db.prepare("DELETE FROM social_edges WHERE kind = 'block' AND from_email = ?").run(LEAD);
});

test('only the leader can remove a member or revoke an invite', async () => {
  db.prepare("INSERT OR IGNORE INTO social_edges (from_email, to_email, kind, status) VALUES (?,?,'follow','accepted')").run(LEAD, M2);   // the block removed the follow
  await post('/friends/party/invite', LEAD, { id: idOf(M2) });
  assert.equal(pmStatus(pA.id, M2), 'invited');
  await post('/friends/party/remove', LEAD, { id: idOf(M2) });
  assert.equal(pmStatus(pA.id, M2), undefined, 'the leader revoked it');
  await post('/friends/party/remove', M1, { id: idOf(M1) });
  assert.equal(pmStatus(pA.id, M1), 'joined', 'a non-leader cannot');
});

test('one party per person', async () => {
  resetAll();
  await post('/friends/party/create', LEAD);
  const p1 = partyLedBy(LEAD);
  await post('/friends/party/invite', LEAD, { id: idOf(M1) });
  await post('/friends/party/accept', M1, { party: p1.id });
  await post('/friends/party/create', M2);
  const p2 = partyLedBy(M2);
  await post('/friends/party/invite', M2, { id: idOf(M1) });
  assert.equal(pmStatus(p2.id, M1), undefined, 'inviting a committed person is refused');
  db.prepare("INSERT OR IGNORE INTO party_members (party_id, email, status) VALUES (?,?,'invited')").run(p2.id, M1);   // force one anyway
  await post('/friends/party/accept', M1, { party: p2.id });
  assert.ok(pmStatus(p1.id, M1) === 'joined' && pmStatus(p2.id, M1) === 'invited', 'a second accept is refused');
  await post('/friends/party/create', LEAD, { name: 'Dupe' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM parties WHERE leader_email = ?').get(LEAD).n, 1, 'a second create is refused');
});

test('an invited-but-not-joined member cannot seat the party', async () => {
  resetAll();
  await post('/friends/party/create', LEAD);
  await post('/friends/party/invite', LEAD, { id: idOf(M1) });
  await post('/volleyball/party/checkin', M1);
  assert.ok(gidOnFloor(LEAD) == null && gidOnFloor(M1) == null);
});
