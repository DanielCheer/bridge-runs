// The under-18 safeguarding rule: a known minor can't use 1:1 DMs in either direction and no
// non-admin may DM them; an admin may (oversight); adult-to-adult DMs work; the Message button and
// the red Minor badge follow the rule on profiles; role badges are admin-eyes-only; /apply requires
// and stores a DOB; an admin-corrected DOB moves the gate; a member without a DOB is nudged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN } from './helpers/app.mjs';
import { PERSONAS, PLAYERS, MINOR } from '../fixtures/world.mjs';

const ADULT = PERSONAS.team, ADULT2 = PLAYERS[1];
let app, db;
before(async () => {
  app = await startApp({ seed: (d) => d.prepare('DELETE FROM messages').run() });
  db = app.db();
});
after(async () => { await app?.stop(); });

const one = (sql, ...a) => db.prepare(sql).get(...a);
const idOf = (e) => one('SELECT id FROM applicants WHERE email = ?', e)?.id;
const dm = (from, to, body) => app.post('/messages/' + idOf(to), { body }, { as: from });
const sent = (from, to) => !!one('SELECT 1 x FROM messages WHERE from_email = ? AND to_email = ?', from, to);
const page = async (p, as) => (await app.get(p, { as })).text();

test('adult to adult: allowed', async () => {
  await dm(ADULT, ADULT2, 'hey adult');
  assert.ok(sent(ADULT, ADULT2));
});

test('adult to minor and minor to adult: blocked; a minor cannot open a thread', async () => {
  await dm(ADULT, MINOR, 'should not send');
  assert.equal(one('SELECT 1 x FROM messages WHERE to_email = ?', MINOR), undefined);
  await dm(MINOR, ADULT, 'should not send either');
  assert.equal(one('SELECT 1 x FROM messages WHERE from_email = ?', MINOR), undefined);
  assert.equal((await app.get('/messages/' + idOf(ADULT), { as: MINOR })).status, 302);
});

test("profiles: the Message button and the Minor badge follow the rule; roles are admin-only", async () => {
  const minId = idOf(MINOR), ad2Id = idOf(ADULT2);
  const uMinor = await page('/u/' + minId, ADULT), uAdult = await page('/u/' + ad2Id, ADULT);
  assert.ok(!uMinor.includes(`href="/messages/${minId}"`), 'no Message button on a minor');
  assert.ok(uAdult.includes(`href="/messages/${ad2Id}"`), 'Message button on an adult');
  assert.ok(uMinor.includes('class="bdg minor"'), 'Minor badge on the minor');
  assert.ok(!uAdult.includes('class="bdg minor"'), 'no Minor badge on an adult');
  assert.ok((await page(`/u/${minId}/card`, ADULT)).includes('class="bdg minor"'), 'Minor badge on the card too');
  assert.ok(!uAdult.includes('bdg reg') && !uAdult.includes('bdg team') && !uAdult.includes('bdg host'), 'no role badge for a non-admin viewer');
  const asAdmin = await page('/u/' + idOf(ADULT), ADMIN);
  assert.ok(asAdmin.includes('bdg team'), 'an admin sees the role badge');
});

test('admin exception: an admin may DM a minor, and sees the button', async () => {
  db.prepare('DELETE FROM messages').run();
  await dm(ADMIN, MINOR, 'admin can reach a minor');
  assert.ok(sent(ADMIN, MINOR));
  assert.ok((await page('/u/' + idOf(MINOR), ADMIN)).includes(`href="/messages/${idOf(MINOR)}"`));
});

test('/apply requires a date of birth and stores it', async () => {
  const apply = (o) => app.post('/apply', { full_name: 'Applicant', phone: '000-000-0000', levels: 'High school', waiver_ok: '1', ...o });
  await apply({ email: 'nodob@test.local' });
  assert.equal(idOf('nodob@test.local'), undefined, 'rejected without a DOB');
  await apply({ email: 'kidapply@test.local', full_name: 'Kid Applicant', dob: '2013-02-02' });
  assert.equal(one('SELECT dob FROM applicants WHERE email = ?', 'kidapply@test.local')?.dob, '2013-02-02');
});

test('an admin-corrected DOB moves the gate', async () => {
  const id = idOf(ADULT2);
  await app.post('/admin/people/edit', { id, full_name: 'Casey Brooks', phone: '000-000-0000', email: ADULT2, dob: '2011-05-05' }, { as: ADMIN });
  assert.equal(one('SELECT dob FROM applicants WHERE id = ?', id).dob, '2011-05-05');
  db.prepare('DELETE FROM messages').run();
  await dm(ADULT, ADULT2, 'now blocked');
  assert.equal(one('SELECT 1 x FROM messages WHERE to_email = ?', ADULT2), undefined);
});

test('a member with no DOB is nudged on the hub', async () => {
  db.prepare('UPDATE applicants SET dob = NULL WHERE email = ?').run(ADULT);
  assert.ok((await page('/runs', ADULT)).includes('Add your date of birth'));
});
