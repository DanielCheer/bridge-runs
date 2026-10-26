// The youth pack and the council role, on the real surfaces: the program wizard creates a youth
// program (its own positions, its own waiver with guardian consent); a joiner with only the
// club-wide waiver is gated to the program's; a minor needs a guardian's consent; an organizer's
// verification satisfies outright; auto-seating honours the program waiver; the council is its own
// role (votes, nothing else); editing the program sets/clears its season gate, and the waiver key
// survives a slug rename.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN } from './helpers/app.mjs';

const YT = (n) => `yt_${n}@test.local`;
let app, db, PID;
before(async () => {
  app = await startApp({
    seed: (d) => {
      const ins = d.prepare(`INSERT INTO applicants (full_name, email, phone, experience, waiver_ok, status, dob, is_team, is_council)
        VALUES (?,?,'000-000-0000','x',?,?,?,?,?)`);
      ins.run('YT Adult', YT('adult'), 1, 'approved', '1990-01-01', 0, 0);       // holds the club-wide waiver only
      ins.run('YT Minor', YT('minor'), 0, 'approved', '2012-01-01', 0, 0);       // needs guardian consent
      ins.run('YT NoRec', YT('norec'), 1, 'approved', '1990-01-01', 0, 0);       // club-wide waiver, no program record
      ins.run('YT Renew', YT('renew'), 0, 'approved', '1990-01-01', 0, 0);       // no waiver anywhere: organizer verifies
      ins.run('YT Council', YT('council'), 1, 'approved', '1990-01-01', 0, 1);   // council, not team or admin
      ins.run('YT TeamGuy', YT('teamguy'), 1, 'approved', '1990-01-01', 1, 0);   // team, not council: no vote
      ins.run('YT Pending', YT('pending'), 1, 'pending', '1990-01-01', 0, 0);    // the applicant the council votes on
    },
  });
  db = app.db();
});
after(async () => { await app?.stop(); });

const post = (p, as, body = {}) => app.post(p, body, { as });
const redirTo = (r) => r.headers.get('location') || '';
const rec = (key, e) => db.prepare('SELECT * FROM waiver_records WHERE waiver_key = ? AND email = ?').get(key, e);
const onRun = (e) => db.prepare('SELECT auto_seated FROM checkins WHERE program_id = ? AND email = ?').get(PID, e);
const WIZARD = {
  name: 'Youth Test', slug: 'youthtest', emoji: '🧒', dow: '3', startHour: '17', endHour: '19',
  cap: '5', waitlist: '3', prereg: '0', joinMode: 'open', seating: 'instant', confirmMode: 'none',
  confirmCutoff: '', lockTime: '17:00', teamsCount: '0', teamsSize: '0', partySize: '0',
  theme: 'default', autoRenew: '1', waiverMode: 'own', waiverGuardian: '1',
};

test('the wizard creates a youth program with positions, its own waiver and guardian consent', async () => {
  await post('/admin/programs/create', ADMIN, { ...WIZARD, positions: 'GK Goalie\nDF Defender\nzz! bad line', seasonStart: '' });
  const row = db.prepare('SELECT id, config FROM program WHERE slug = ?').get('youthtest');
  assert.ok(row);
  PID = row.id;
  const spec = JSON.parse(row.config);
  assert.ok(spec.positions.length === 2 && spec.positions[0][0] === 'GK' && spec.positions[1][1] === 'Defender', 'two valid position lines, junk dropped');
  assert.ok(spec.waiver.own === true && spec.waiver.guardian === true);
  assert.equal(spec.waiverKey, 'youthtest', 'waiver key frozen at the creation slug');
  await post('/admin/programs/active', ADMIN, { id: String(PID), on: '1' });
  await post('/youthtest/open', ADMIN);
  assert.ok(db.prepare('SELECT 1 x FROM run_state WHERE program_id = ? AND is_open = 1').get(PID), 'published and open');
});

test("the program's positions reach the profile picker and save", async () => {
  const prof = await (await app.get('/profile', { as: YT('adult') })).text();
  assert.ok(prof.includes('Youth Test') && prof.includes('GK'));
  await post('/profile', YT('adult'), { full_name: 'YT Adult', phone: '000-000-0000', email: YT('adult'), position: 'GK', email_announce: '1' });
  assert.equal(db.prepare('SELECT position FROM applicants WHERE email = ?').get(YT('adult')).position, 'GK');
});

test("the program's waiver is separate from the club-wide one", async () => {
  const r = await post('/youthtest/join', YT('adult'));
  assert.match(redirTo(r), new RegExp(`/waiver\\?next=.*&p=${PID}`), 'gated to the program waiver');
  assert.equal(onRun(YT('adult')), undefined);
  const gate = await (await app.get(`/waiver?next=%2Fyouthtest&p=${PID}`, { as: YT('adult') })).text();
  assert.ok(!gate.includes('guardian_name'), 'no guardian fields for an adult');
  await post('/waiver', YT('adult'), { next: '/youthtest', p: String(PID), agree: '1' });
  const a = rec('youthtest', YT('adult'));
  assert.ok(a?.attested_at && !a.guardian_consent_at);
  await post('/youthtest/join', YT('adult'));
  assert.ok(onRun(YT('adult')), 'signed: seated');
});

test("a minor needs a guardian's consent, from someone other than the player", async () => {
  assert.ok(redirTo(await post('/youthtest/join', YT('minor'))).includes(`p=${PID}`));
  const gate = await (await app.get(`/waiver?next=%2Fyouthtest&p=${PID}`, { as: YT('minor') })).text();
  assert.ok(gate.includes('guardian_name') && gate.includes('parent or guardian'));
  assert.ok(redirTo(await post('/waiver', YT('minor'), { next: '/youthtest', p: String(PID), agree: '1' })).includes('err='), 'no guardian: refused');
  assert.equal(rec('youthtest', YT('minor')), undefined);
  const g = { next: '/youthtest', p: String(PID), agree: '1', guardian_agree: '1', guardian_name: 'Guardian Mom', guardian_phone: '000-000-0000' };
  assert.ok(redirTo(await post('/waiver', YT('minor'), { ...g, guardian_email: YT('minor') })).includes('err='), "the player's own email is refused");
  assert.equal(rec('youthtest', YT('minor')), undefined);
  await post('/waiver', YT('minor'), { ...g, guardian_email: 'mom@test.local' });
  const m = rec('youthtest', YT('minor'));
  assert.ok(m?.attested_at && m.guardian_consent_at && m.guardian_name === 'Guardian Mom');
  await post('/youthtest/join', YT('minor'));
  assert.ok(onRun(YT('minor')));
});

// POST /waiver also stamps the guardian onto applicants.guardian_name/_phone/_email (shown on the
// People card). Those columns were once missing from a fresh database's schema, so the guardian's
// form ended in a 500 after the waiver record was written; this guards against that coming back.
test('the guardian is also stamped on the person record', () => {
  const cols = db.prepare('PRAGMA table_info(applicants)').all().map((c) => c.name);
  assert.ok(cols.includes('guardian_name'), 'applicants.guardian_name exists');
  const person = db.prepare('SELECT guardian_name, guardian_email FROM applicants WHERE email = ?').get(YT('minor'));
  assert.deepEqual({ ...person }, { guardian_name: 'Guardian Mom', guardian_email: 'mom@test.local' });
  assert.doesNotMatch(app.log, /\[route-error\] POST \/waiver/);
});

test("an organizer's verification satisfies the waiver outright", async () => {
  const id = db.prepare('SELECT id FROM applicants WHERE email = ?').get(YT('renew')).id;
  await post('/admin/people/waiver-record', ADMIN, { id: String(id), key: 'youthtest', on: '1' });
  const v = rec('youthtest', YT('renew'));
  assert.ok(v?.verified_at && v.verified_by === ADMIN && !v.attested_at);
  await post('/youthtest/join', YT('renew'));
  assert.ok(onRun(YT('renew')), 'joins with no waiver detour');
});

test('auto-seating honours the program waiver, not the club-wide flag', async () => {
  db.prepare('UPDATE program_membership SET auto_renew = 1 WHERE program_id = ? AND email = ?').run(PID, YT('adult'));
  db.prepare("INSERT OR IGNORE INTO program_membership (program_id, email, status, role, auto_renew) VALUES (?,?,'approved','approved',1)").run(PID, YT('norec'));
  db.prepare('DELETE FROM checkins WHERE program_id = ?').run(PID);
  await post('/youthtest/open', ADMIN);   // a manual open runs the auto-seat
  assert.ok(onRun(YT('adult'))?.auto_seated, 'a renewer with the program waiver is seated');
  assert.equal(onRun(YT('norec')), undefined, 'one with only the club-wide waiver is not');
});

test('the council is its own role: it votes, and nothing else', async () => {
  const council = await app.get('/admin', { as: YT('council') });
  const html = council.status === 200 ? await council.text() : '';
  assert.ok(html.includes('Council review') && html.includes('/admin/vote'), 'the council screen with vote buttons');
  assert.equal((await app.get('/admin', { as: YT('adult') })).status, 403, 'a regular member is refused');
  assert.equal((await app.get('/admin/banner', { as: YT('council') })).status, 403, 'no other operator surface');
  const pend = db.prepare('SELECT id FROM applicants WHERE email = ?').get(YT('pending')).id;
  await post('/admin/vote', YT('council'), { id: String(pend), vote: 'approve' });
  assert.ok(db.prepare('SELECT 1 x FROM votes WHERE applicant_id = ? AND voter_email = ?').get(pend, YT('council')), 'council vote recorded');
  const team = await post('/admin/vote', YT('teamguy'), { id: String(pend), vote: 'approve' });
  assert.equal(team.status, 403, 'team without the council flag cannot vote');
  assert.equal(db.prepare('SELECT 1 x FROM votes WHERE applicant_id = ? AND voter_email = ?').get(pend, YT('teamguy')), undefined);
  assert.equal((await post('/admin/vote', ADMIN, { id: String(pend), vote: 'approve' })).status, 403, 'nor can an admin who is not on the council');
});

test('editing: the season gate sets and clears; the waiver key survives a slug rename', async () => {
  const edit = { ...WIZARD, id: String(PID), positions: 'GK Goalie\nDF Defender' };
  const d = new Date(); d.setDate(d.getDate() + 60);
  const future = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const gate = () => db.prepare("SELECT value v FROM app_settings WHERE key = 'youthtest_season_start'").get()?.v;
  await post('/admin/programs/edit', ADMIN, { ...edit, seasonStart: future });
  assert.equal(gate(), future);
  await post('/admin/programs/edit', ADMIN, { ...edit, seasonStart: '' });
  assert.equal(gate(), undefined);
  await post('/admin/programs/edit', ADMIN, { ...edit, slug: 'ytx', seasonStart: '' });
  assert.equal(JSON.parse(db.prepare('SELECT config FROM program WHERE id = ?').get(PID).config).waiverKey, 'youthtest');
  const to = redirTo(await post('/ytx/join', YT('adult')));
  assert.ok(to.endsWith('/ytx') && !to.includes('/waiver'), `signed records still satisfy after the rename (went to ${to})`);
});
