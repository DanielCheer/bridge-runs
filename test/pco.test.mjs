// Planning Center sync, end to end against a local mock of the PCO API (test/helpers/pco-mock.mjs):
// authz; PAT connect/reject/disconnect; initial link with duplicates and a report; creating
// Bridge-only members; the reconcile scan (autocreate off/on); synthetic identities never synced;
// the outbox (patch drain, 429 backoff, 5xx outage that burns no attempts, per-row 4xx
// dead-letter, 401 pause + reconnect); webhooks (signed, forged, destroyed); the delta poll; rekey
// carrying the link; door mode; waivers (self-reported, organizer-verified, verified from the
// church's form) and their People fields; attendance custom fields; Check-Ins reconciliation;
// door passes; the OAuth grant lifecycle and its hardening (single-flight refresh, PKCE, 403
// isolation, concurrent starts, token 429, org change); kiosk arrivals; the weekly roster sync.
//
// One app + one mock for the whole file: the sections build on each other in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, ADMIN } from './helpers/app.mjs';
import { startPcoMock } from './helpers/pco-mock.mjs';
import { PERSONAS, PLAYERS } from '../fixtures/world.mjs';

const TEAM = PERSONAS.team, REG = PLAYERS[0], SUSP = PERSONAS.suspended;
const REG2 = 'player01-moved@test.local';
const NEWBIE = 'newbie@test.local';

let app, mock, db;
before(async () => {
  mock = await startPcoMock({
    // One person who matches a Bridge member, one PCO-only, one duplicate-email pair.
    congregation: [
      ['Toni', 'Team', [TEAM], { phone: '111-222' }],
      ['Pico', 'Only', ['pco_only@test.local']],
      ['Dupe', 'One', ['dupe@test.local']],
      ['Dupe', 'Two', ['dupe@test.local']],
    ],
  });
  app = await startApp({
    env: { PCO_API_BASE: mock.url, PCO_RETRY_BASE_MS: '10', PCO_PACE_MS: '0', PCO_KIOSK_POLL_MS: '25' },
    // A deterministic population: only the team, one player and the suspended account stay
    // approved, so every count below is exact.
    seed: (d) => d.prepare('UPDATE applicants SET status = ? WHERE email NOT IN (?,?,?)').run('pending', TEAM, REG, SUSP),
  });
  db = app.db();
});
after(async () => { await app?.stop(); await mock?.close(); });

const check = (name, cond) => assert.ok(cond, name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, as, body) => app.post(p, body, { as });
const get = async (p, as = ADMIN) => (await app.get(p, { as })).text();
const raw = (p, as = ADMIN) => app.get(p, { as });
const tick = (body) => post('/admin/test/tick', ADMIN, body);
const mockCall = (p, b) => fetch(mock.url + p, b ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) } : undefined).then((r) => r.json());
const mockState = () => mockCall('/__mock/state');
const mockLogLen = async () => (await mockState()).log.length;
const mockPeople = async () => (await mockState()).people;
const pcoIdOf = (e) => db.prepare('SELECT pco_id p FROM applicants WHERE email = ?').get(e)?.p;
const setting = (k) => db.prepare('SELECT value v FROM app_settings WHERE key = ?').get(k)?.v;
const audited = (like) => !!db.prepare('SELECT 1 FROM audit_log WHERE action LIKE ?').get(like);
const outboxOpen = () => db.prepare('SELECT COUNT(*) n FROM pco_outbox WHERE done_at IS NULL').get().n;
const pcoModeIsPat = () => !!setting('pco_app_id') && !setting('pco_oauth_access');
// The ?msg= notice a route answers with: the Location of a 302 (GET routes, fetch-style POSTs),
// else the redirect-shim body.
const msgOf = async (r) => {
  const loc = r.headers.get('location');
  if (loc) return decodeURIComponent(loc.split('msg=')[1] || '');
  const m = (await r.text()).match(/msg=([^"&]+)/);
  return m ? decodeURIComponent(m[1]) : '';
};
const stateOf = async () => new URL((await raw('/admin/pco/oauth/start')).headers.get('location')).searchParams.get('state');
const connectPat = (extra = {}) => post('/admin/pco/connect', ADMIN, { app_id: 'testapp', secret: 'testsecret', ...extra });

test('the fixture database is push-deaf (nothing real can be paged)', () => {
  assert.equal(db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n, 0);
});

test('authz and initial state', async () => {
  const page = await raw('/admin/pco', TEAM);
  check('a non-admin cannot open /admin/pco', page.status !== 200 || !(await page.text()).includes('PLANNING CENTER'));
  check('"Not connected" before setup', (await get('/admin/pco')).includes('Not connected'));
});

test('connect: bad credentials rejected and not stored; good ones land', async () => {
  await post('/admin/pco/connect', ADMIN, { app_id: 'testapp', secret: 'WRONG' });
  check('bad credentials: not connected, creds cleared', !setting('pco_app_id') && (await get('/admin/pco')).includes('Not connected'));
  await connectPat({ webhook_secret: 'whsec' });
  check('good credentials: connected, org named', (await get('/admin/pco')).includes('Mock Community Church'));
  check('connect audited', audited('pco:connected'));
});

test('initial link: match by email, report the split, flag PCO-side duplicates', async () => {
  await post('/admin/pco/link', ADMIN);
  check('the matching member is linked', !!pcoIdOf(TEAM));
  const rep = JSON.parse(setting('pco_report') || '{}');
  check('1 matched', rep.matched === 1);
  check('bridge-only lists the unmatched members', (rep.bridgeOnly || []).includes(REG) && (rep.bridgeOnly || []).includes(SUSP));
  check('PCO-only counted, nothing imported', rep.pcoOnly === 3 && !db.prepare("SELECT 1 FROM applicants WHERE email = 'pco_only@test.local'").get());
  check('duplicate PCO emails flagged', (rep.dupes || []).includes('dupe@test.local'));
});

test('create the Bridge-only members in PCO', async () => {
  const before = (await mockPeople()).length;
  await post('/admin/pco/create', ADMIN);
  check('created and linked', !!pcoIdOf(REG) && !!pcoIdOf(SUSP));
  check('PCO grew by exactly two', (await mockPeople()).length === before + 2);
  const p = (await mockPeople()).find((x) => x.id === pcoIdOf(REG));
  check('the created person carries email and phone', p && p.emails.includes(REG) && p.phones.length === 1);
  check('report drained to zero Bridge-only', (JSON.parse(setting('pco_report')).bridgeOnly || []).length === 0);
});

test('reconcile scan: autocreate off links but never creates; on creates', async () => {
  db.prepare("INSERT INTO applicants (full_name, email, phone, experience, waiver_ok, status) VALUES ('New Guy', ?, '000-000-0000', 'x', 1, 'approved')").run(NEWBIE);
  await tick();
  check('autocreate off: not pushed to PCO', !pcoIdOf(NEWBIE));
  await post('/admin/pco/auto', ADMIN, { on: '1' });
  await tick();
  check('autocreate on: the tick created and linked them', !!pcoIdOf(NEWBIE));
});

test('synthetic identities never reach the church directory', async () => {
  db.prepare("INSERT INTO applicants (full_name, email, phone, experience, waiver_ok, status) VALUES ('Walk In', 'walkin@guest.local', '', 'x', 1, 'approved')").run();
  const before = (await mockPeople()).length;
  await tick();
  check('@guest.local excluded', !pcoIdOf('walkin@guest.local') && (await mockPeople()).length === before);
});

test('outbox: a profile edit is queued and drained to PCO', async () => {
  await post('/profile', REG, { full_name: 'Reggie Renamed', phone: '999-888', email: REG });
  check('the edit queued a patch', outboxOpen() >= 1);
  await tick();
  const p = (await mockPeople()).find((x) => x.id === pcoIdOf(REG));
  check('PCO name updated', p && p.first_name === 'Reggie' && p.last_name === 'Renamed');
  check('PCO phone updated', p && p.phones[0].number === '999-888');
  check('outbox row closed', outboxOpen() === 0);
});

test('outbox: a 429 arms a global backoff honouring Retry-After, then delivers', async () => {
  await mockCall('/__mock/fail', { status: 429, times: 1 });
  await post('/profile', REG, { full_name: 'Reggie Backoff', phone: '999-888', email: REG });
  await tick();
  check('backoff armed, row open, no attempts burned', outboxOpen() === 1 && Number(setting('pco_backoff_until')) > Date.now() - 5000);
  await sleep(1200);   // the mock's Retry-After is 1 s
  await tick();
  check('delivered after the backoff', outboxOpen() === 0 && (await mockPeople()).find((x) => x.id === pcoIdOf(REG)).first_name === 'Reggie');
});

test('outbox: a 5xx outage burns no attempts; a per-row 4xx dead-letters loudly', async () => {
  await post('/profile', REG, { full_name: 'Reggie Outage', phone: '999-888', email: REG });
  await mockCall('/__mock/fail', { status: 500, times: 3 });
  for (let i = 0; i < 3; i++) { await tick(); await sleep(60); }
  const row = db.prepare('SELECT attempts FROM pco_outbox WHERE done_at IS NULL ORDER BY id DESC LIMIT 1').get();
  check("an outage does not burn the row's attempts", !!row && row.attempts === 0);
  await tick();
  check('the queued edit survives the outage and delivers', outboxOpen() === 0);
  await mockCall('/__mock/fail', { status: 422, times: 8 });
  await post('/profile', REG, { full_name: 'Reggie Doomed', phone: '999-888', email: REG });
  for (let i = 0; i < 6; i++) { await tick(); await sleep(80); }
  const dead = db.prepare("SELECT * FROM pco_outbox WHERE done_at IS NOT NULL AND last_error LIKE '%422%' ORDER BY id DESC LIMIT 1").get();
  check('a per-row 4xx exhausts its attempts and dead-letters', !!dead && dead.attempts >= 5);
  check('dead-letter audited', audited('pco:outbox-dead%'));
  // Reset the mock (clears the leftover fail queue) and re-link everyone against it.
  await mockCall('/__mock/reset');
  db.prepare('UPDATE applicants SET pco_id = NULL').run();
  await post('/admin/pco/link', ADMIN);
  await post('/admin/pco/create', ADMIN);
});

test('a 401 pauses the sync with a banner; reconnecting resumes it', async () => {
  await mockCall('/__mock/fail', { status: 401, times: 1 });
  await post('/profile', REG, { full_name: 'Reggie Paused', phone: '999-888', email: REG });
  await tick();
  check('auth-error state', setting('pco_error') === 'auth');
  check('reconnect banner shown', (await get('/admin/pco')).includes('sync is paused'));
  const quiet = await mockLogLen();
  await tick();
  check('a paused sync makes no API calls', (await mockLogLen()) === quiet);
  await connectPat({ webhook_secret: 'whsec' });
  await tick();
  check('reconnect resumes and drains', setting('pco_error') == null && outboxOpen() === 0);
});

let teamId;
test('webhook: signed update applied, forged signature refused, destroyed only marks', async () => {
  teamId = pcoIdOf(TEAM);
  const hook = (name, person) => JSON.stringify({ data: [{ attributes: { name, payload: JSON.stringify({ data: person }) } }] });
  const sign = (body, sec) => crypto.createHmac('sha256', sec).update(body).digest('hex');
  const send = (body, sec) => fetch(app.baseURL + '/pco/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PCO-Webhooks-Authenticity': sign(body, sec) }, body });
  const upd = hook('people.v2.events.person.updated', { type: 'Person', id: teamId, attributes: { first_name: 'Hooked', last_name: 'Team', birthdate: '2010-06-15' } });
  const ok = await send(upd, 'whsec');
  const row = db.prepare('SELECT full_name, dob FROM applicants WHERE email = ?').get(TEAM);
  check('signed webhook applied (PCO wins: name + birthdate)', ok.status === 200 && row.full_name === 'Hooked Team' && row.dob === '2010-06-15');
  check('a forged signature gets 401', (await send(upd, 'FORGED')).status === 401);
  await send(hook('people.v2.events.person.destroyed', { type: 'Person', id: teamId }), 'whsec');
  check('person.destroyed is audited and the Bridge account kept', audited('pco:person-destroyed%') && !!db.prepare('SELECT 1 FROM applicants WHERE email = ?').get(TEAM));
});

test('the delta poll picks up PCO-side edits', async () => {
  await mockCall('/__mock/touch', { id: teamId, attrs: { first_name: 'Polly', last_name: 'Team' } });
  await tick({ pcodaily: '1' });
  check('renamed from PCO', db.prepare('SELECT full_name n FROM applicants WHERE email = ?').get(TEAM).n === 'Polly Team');
});

test('an email rekey carries the PCO link', async () => {
  const link = pcoIdOf(REG);
  await post('/profile', REG, { full_name: 'Reggie Moved', phone: '999-888', email: REG2 });
  check('the link moved with the email', pcoIdOf(REG2) === link && !pcoIdOf(REG));
});

test('door mode toggle', async () => {
  await post('/admin/pco/doormode', ADMIN, { on: '1' });
  check('on: stored and shown', setting('pco_door_mode') === '1' && (await get('/admin/pco')).includes('Door mode is ON'));
  await post('/admin/pco/doormode', ADMIN, { on: '0' });
  check('off: in-app confirm restored', setting('pco_door_mode') === '0');
});

const fieldValue = async (email, defName) => {
  const st = await mockCall('/__mock/fields');
  const def = st.defs.find((d) => d.name === defName);
  return st.data.find((f) => f.personId === String(pcoIdOf(email)) && f.defId === def?.id)?.value;
};
const waiverRow = (e) => db.prepare('SELECT waiver_ok, waiver_at, waiver_verified_at FROM applicants WHERE email = ?').get(e);

test('waivers: a permanent self-reported date, published to People', async () => {
  db.prepare('UPDATE applicants SET waiver_ok = 0, waiver_at = NULL, waiver_verified_at = NULL WHERE email IN (?,?)').run(TEAM, REG2);
  await post('/waiver', REG2, { agree: '1', next: '/runs' });
  const w = waiverRow(REG2);
  check('confirming stamps a date', w.waiver_ok === 1 && !!w.waiver_at);
  check('self-reported is not verified', w.waiver_verified_at == null);
  await post('/waiver', REG2, { agree: '1', next: '/runs' });
  check('re-confirming never rewrites the date', waiverRow(REG2).waiver_at === w.waiver_at);
  await post('/admin/pco/waiver', ADMIN, { on: '1' });
  await post('/admin/pco/attendance/push', ADMIN);
  check('published as self-reported', (await fieldValue(REG2, 'YA Sports — waiver on file')) === 'Yes (self-reported)');
  check('no waiver publishes No', (await fieldValue(TEAM, 'YA Sports — waiver on file')) === 'No');
  check('the date is published', (await fieldValue(REG2, 'YA Sports — waiver confirmed')) === String(w.waiver_at).slice(0, 10));
});

test('waivers: an organizer can verify one they have seen; a non-admin cannot', async () => {
  const id = db.prepare('SELECT id FROM applicants WHERE email = ?').get(REG2).id;
  await post('/admin/people/waiver', TEAM, { id: String(id), on: '1' });
  check('a non-admin cannot confirm a waiver', waiverRow(REG2).waiver_verified_at == null);
  await post('/admin/people/waiver', ADMIN, { id: String(id), on: '1', signed_on: '2026-02-10' });
  const w = waiverRow(REG2);
  check('verification recorded', !!w.waiver_verified_at);
  check('the known signing date kept', w.waiver_at === '2026-02-10');
  check('audited against that admin', !!db.prepare("SELECT 1 FROM audit_log WHERE action LIKE 'people:waiver-verified%' AND actor = ? AND target = ?").get(ADMIN, REG2));
  await post('/admin/pco/attendance/push', ADMIN);
  check('published as verified, dated by the signing date', (await fieldValue(REG2, 'YA Sports — waiver on file')) === 'Yes (verified)'
    && (await fieldValue(REG2, 'YA Sports — waiver confirmed')) === '2026-02-10');
  await post('/admin/people/waiver', ADMIN, { id: String(id), on: '0' });
  check('undo clears verification, keeps their own attestation', waiverRow(REG2).waiver_verified_at == null && waiverRow(REG2).waiver_ok === 1);
});

test("waivers: the church's form submissions verify members", async () => {
  await post('/admin/pco/waiver/form', ADMIN, { form_id: '55' });
  check('form id saved', setting('pco_waiver_form') === '55');
  await mockCall('/__mock/formsub', { formId: '55', personId: pcoIdOf(TEAM), created_at: '2026-03-04T09:00:00Z' });
  await mockCall('/__mock/formsub', { formId: '55', personId: null });   // anonymous, unmatchable
  await post('/admin/pco/waiver/verify', ADMIN);
  const w = waiverRow(TEAM);
  check('a submission verifies and clears to play', w.waiver_ok === 1 && w.waiver_verified_at === '2026-03-04');
  check('the signed date is backfilled', w.waiver_at === '2026-03-04');
  check('no submission stays unverified', waiverRow(REG2).waiver_verified_at == null);
  const rep = JSON.parse(setting('pco_waiver_report') || '{}');
  check('report: verified, missing, unmatched', rep.verified === 1 && rep.missing.includes(REG2) && rep.unmatched === 1);
  check('verification audited', audited('pco:waivers-verified%'));
  await post('/admin/pco/attendance/push', ADMIN);
  check('republished as verified', (await fieldValue(TEAM, 'YA Sports — waiver on file')) === 'Yes (verified)');
  check('console shows the split', (await get('/admin/pco')).includes('verified ·'));
  await post('/admin/pco/waiver', ADMIN, { on: '0' });
});

test('attendance custom fields: inert until on, text fallback, signature-diffed, demo excluded', async () => {
  const fields = () => mockCall('/__mock/fields');
  db.prepare('DELETE FROM attendance').run();
  const ins = db.prepare('INSERT INTO attendance (run_date, email, name, program_id) VALUES (?,?,?,?)');
  ins.run('2026-06-03', TEAM, 'Polly Team', 1);
  ins.run('2026-06-10', TEAM, 'Polly Team', 1);
  ins.run('2026-06-09', TEAM, 'Polly Team', 3);    // volleyball: two sports
  ins.run('2026-07-01', TEAM, 'Polly Team', 90);   // the demo program never counts
  const names = ['YA Sports — games attended', 'YA Sports — last attended', 'YA Sports — sports played'];
  await post('/admin/pco/attendance/push', ADMIN);
  check('inert while the toggle is off', !(await fields()).defs.some((d) => names.includes(d.name)));
  await post('/admin/pco/attendance', ADMIN, { on: '1' });
  await mockCall('/__mock/rejecttype', { type: 'date' });
  await post('/admin/pco/attendance/push', ADMIN);
  const st = await fields();
  check('three definitions created', names.every((n) => st.defs.some((d) => d.name === n)));
  check('a rejected data_type falls back to text', st.defs.find((d) => d.name === 'YA Sports — last attended')?.data_type === 'string');
  check('games attended (demo excluded)', (await fieldValue(TEAM, 'YA Sports — games attended')) === '3');
  check('last attended', (await fieldValue(TEAM, 'YA Sports — last attended')) === '2026-06-10');
  check('sports played', (await fieldValue(TEAM, 'YA Sports — sports played')) === 'Basketball, Volleyball');
  const wrote = (await fields()).data.length;
  await post('/admin/pco/attendance/push', ADMIN);
  check('unchanged stats are not re-pushed', (await fields()).data.length === wrote);
  ins.run('2026-06-17', TEAM, 'Polly Team', 1);
  await post('/admin/pco/attendance/push', ADMIN);
  check('a new game PATCHes the existing value', (await fieldValue(TEAM, 'YA Sports — games attended')) === '4' && (await fields()).data.length === wrote);
  check('audited', audited('pco:profile-fields-pushed'));
});

test('Check-Ins reconciliation: tapped, no-show, walk-in (including a late-evening local tap)', async () => {
  const today = new Date().toISOString().slice(0, 10);
  await post('/admin/pco/event', ADMIN, { event_id: '77' });
  check('event id saved', setting('pco_checkins_event') === '77');
  db.prepare('DELETE FROM checkins WHERE run_date = ?').run(today);
  db.prepare('INSERT INTO checkins (run_date, email, name, program_id, sort_order) VALUES (?,?,?,1,0)').run(today, TEAM, 'Polly Team');
  db.prepare('INSERT INTO checkins (run_date, email, name, program_id, sort_order) VALUES (?,?,?,1,1)').run(today, REG2, 'Reggie Moved');
  const stranger = (await mockPeople()).find((p) => p.emails.includes('pco_only@test.local')).id;
  await mockCall('/__mock/checkin', { personId: pcoIdOf(TEAM), eventId: '77', created_at: today + 'T19:05:00Z' });
  await mockCall('/__mock/checkin', { personId: stranger, eventId: '77', created_at: new Date(today + 'T20:30:00').toISOString() });
  await post('/admin/pco/reconcile', ADMIN, { date: today });
  const rep = JSON.parse(setting('pco_checkins_report') || '{}');
  check('tapped + signed up counted', rep.ok === 1);
  check('roster without a tap is a no-show', (rep.noShows || []).length === 1 && rep.noShows[0].includes('Reggie'));
  check('a tap without a signup is a walk-in', (rep.walkIns || []).length === 1 && rep.walkIns[0].includes(stranger));
  check('audited', audited('pco:reconcile%'));
});

test('door passes: CSV, import, verify, profile QR', async () => {
  await post('/admin/pco/passes', ADMIN, { on: '1' });
  const csv = await get('/admin/pco/barcodes.csv');
  check('CSV lists members missing a pass', csv.includes(REG2) && csv.includes('BR' + pcoIdOf(REG2)));
  check('no profile QR before verification', !(await get('/profile', REG2)).includes('Door check-in pass'));
  await mockCall('/__mock/pass', { personId: pcoIdOf(REG2), code: 'BR' + pcoIdOf(REG2) });
  await post('/admin/pco/passes/verify', ADMIN);
  check('verify stored the code', db.prepare('SELECT pco_pass_code c FROM applicants WHERE email = ?').get(REG2)?.c === 'BR' + pcoIdOf(REG2));
  const prof = await get('/profile', REG2);
  check('the profile shows the door-pass QR', prof.includes('Door check-in pass') && prof.includes('<svg'));
  check('the report lists who still needs the import', (JSON.parse(setting('pco_pass_report')).missing || []).includes(TEAM));
  check('a verified member is no longer exported', !(await get('/admin/pco/barcodes.csv')).includes(REG2));
});

test('disconnect: settings cleared, the tick makes no calls', async () => {
  await post('/admin/pco/disconnect', ADMIN);
  const before = await mockLogLen();
  await tick();
  check('disconnected and quiet', !setting('pco_app_id') && (await mockLogLen()) === before);
});

test('OAuth: state check, code exchange, Bearer use, refresh rotation, revoked grant pauses', async () => {
  check('blocked until the application is saved', (await msgOf(await raw('/admin/pco/oauth/start'))).includes('application ID and secret first'));
  await post('/admin/pco/oauth/app', ADMIN, { client_id: 'cid-test', client_secret: 'csecret-test' });
  check('application saved', setting('pco_oauth_client_id') === 'cid-test');
  const authUrl = (await raw('/admin/pco/oauth/start')).headers.get('location') || '';
  check("start redirects to PCO's authorize screen with client id, scope and state",
    authUrl.startsWith(mock.url + '/oauth/authorize') && authUrl.includes('client_id=cid-test')
    && authUrl.includes('scope=people+check_ins') && /state=[A-Za-z0-9_-]{10,}/.test(authUrl));
  check('a forged callback state is refused', (await msgOf(await raw('/admin/pco/oauth/callback?code=good-code&state=WRONG'))).includes('didn’t match'));
  check('nothing connected by it', !setting('pco_oauth_access'));
  check('a bad code is reported, not stored', (await msgOf(await raw(`/admin/pco/oauth/callback?code=nope&state=${await stateOf()}`))).includes('Couldn’t connect') && !setting('pco_oauth_access'));
  const ok = await msgOf(await raw(`/admin/pco/oauth/callback?code=good-code&state=${await stateOf()}`));
  check('a valid authorization connects and names the org', ok.includes('Mock Community Church') && ok.includes('no secret changed hands'));
  check('tokens stored with an expiry', !!setting('pco_oauth_access') && !!setting('pco_oauth_refresh') && Number(setting('pco_oauth_expires')) > Date.now());
  check('the PAT is not in use', !setting('pco_app_id'));
  check('console reports church-authorized mode', (await get('/admin/pco')).includes('authorized by the church'));
  await post('/admin/pco/link', ADMIN);
  check('a real API call succeeds with the OAuth token', !!JSON.parse(setting('pco_report') || '{}').matched);
  const issued = (await mockState()).oauthIssued;
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('pco_oauth_expires', ?)").run(String(Date.now() + 5000));
  await post('/admin/pco/poll', ADMIN);
  check('a token near expiry is refreshed', (await mockState()).oauthIssued === issued + 1);
  check('the rotated refresh token replaced the old one', setting('pco_oauth_refresh') !== 'ref-1');
  await mockCall('/__mock/oauth/revoke', {});
  await tick();
  check('a revoked grant flips to auth-error', setting('pco_error') === 'auth');
  check('the reconnect banner shows for OAuth too', (await get('/admin/pco')).includes('sync is paused'));
  check('OAuth connect and failure audited', audited('pco:oauth-connected') && audited('pco:auth-failed%'));
});

test('OAuth: the daily poll is the keep-alive, refreshing even when idle', async () => {
  await raw(`/admin/pco/oauth/callback?code=good-code&state=${await stateOf()}`);
  await post('/admin/pco/attendance/push', ADMIN);
  // Tick until the app stops making calls: that is "genuinely idle".
  let prev = -1, calls = await mockLogLen();
  for (let i = 0; i < 15 && calls !== prev; i++) { prev = calls; await tick(); calls = await mockLogLen(); }
  await tick();
  check('an idle tick makes no API calls', (await mockLogLen()) === calls);
  const issued = (await mockState()).oauthIssued;
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('pco_oauth_expires', ?)").run(String(Date.now() + 5000));
  await tick({ pcodaily: '1' });
  check('the daily poll calls PCO and refreshes the token', (await mockState()).oauthIssued === issued + 1 && (await mockLogLen()) > calls);
});

test('OAuth hardening: single-flight refresh, PKCE, 403 isolation, concurrent starts, token 429, org change', async () => {
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('pco_oauth_expires', ?)").run(String(Date.now() + 5000));
  const before = await mockState();
  await Promise.all([post('/admin/pco/poll', ADMIN), post('/admin/pco/link', ADMIN), tick(), post('/admin/pco/attendance/push', ADMIN)]);
  const afterRace = await mockState();
  check('concurrent operations trigger exactly one refresh', afterRace.oauthIssued === before.oauthIssued + 1);
  check('no rotated-away refresh token was replayed', afterRace.refreshReuse === 0);
  check('the connection survived the burst', setting('pco_error') == null && !!setting('pco_oauth_access'));

  const pkceStart = (await raw('/admin/pco/oauth/start')).headers.get('location');
  await fetch(pkceStart);   // let the mock observe the authorize parameters
  const seen = (await mockState()).pkce;
  check('authorize carries an S256 code_challenge', !!seen && seen.method === 'S256' && (seen.challenge || '').length > 20);
  await raw(`/admin/pco/oauth/callback?code=good-code&state=${new URL(pkceStart).searchParams.get('state')}`);
  check('the exchange presents the code_verifier', !!(await mockState()).pkce.verifier);

  await mockCall('/__mock/forbid', { prefix: '/check-ins', times: 5 });
  await post('/admin/pco/waiver', ADMIN, { on: '1' });
  check('a 403 on Check-Ins reports a permission problem', /permission|denied/i.test(await msgOf(await post('/admin/pco/passes/verify', ADMIN))));
  check('and does not pause the People sync', setting('pco_error') == null);
  await tick();
  check('the sync keeps working', setting('pco_error') == null);
  await mockCall('/__mock/forbid', { prefix: '/__never-matches', times: 1 });   // disarm leftovers

  const s1 = await stateOf(), s2 = await stateOf();
  check('the first of two pending authorizations completes', (await msgOf(await raw(`/admin/pco/oauth/callback?code=good-code&state=${s1}`))).includes('Connected'));
  check('the second completes too', (await msgOf(await raw(`/admin/pco/oauth/callback?code=good-code&state=${s2}`))).includes('Connected'));

  await raw(`/admin/pco/oauth/callback?code=rate-code&state=${await stateOf()}`);
  check('a 429 on the token endpoint arms a backoff, not an auth failure', Number(setting('pco_backoff_until')) > Date.now() && setting('pco_error') == null);
  check('admin paths honour the backoff too', /wait|shortly/i.test(await msgOf(await post('/admin/pco/link', ADMIN))));
  db.prepare("DELETE FROM app_settings WHERE key = 'pco_backoff_until'").run();

  const fieldIds = setting('pco_field_ids');
  await mockCall('/__mock/org', { id: '77' });
  await raw(`/admin/pco/oauth/callback?code=good-code&state=${await stateOf()}`);
  check("reconnecting a different org clears the old org's cached field ids", !!fieldIds && !setting('pco_field_ids'));
  check('the org change is audited', audited('pco:org-changed%'));
  await mockCall('/__mock/org', { id: '1' });

  await post('/admin/pco/webhook', ADMIN, { webhook_secret: 'standalone-secret' });
  check('the webhook secret is settable in OAuth mode', setting('pco_webhook_secret') === 'standalone-secret');
  await post('/admin/pco/disconnect', ADMIN);
  check('disconnect clears the grant, keeps the registered application', !setting('pco_oauth_access') && !setting('pco_oauth_refresh') && setting('pco_oauth_client_id') === 'cid-test');
});

test('a failed OAuth attempt does not poison a working PAT; Connect & test validates the PAT given', async () => {
  await connectPat();
  check('PAT restored', pcoModeIsPat());
  await raw(`/admin/pco/oauth/callback?code=nope&state=${await stateOf()}`);
  check('the PAT stays unpaused', setting('pco_error') == null && pcoModeIsPat());
  await tick();
  check('and keeps syncing', setting('pco_error') == null);
  await post('/admin/pco/connect', ADMIN, { app_id: 'testapp', secret: 'WRONG-SECRET' });
  check('a bad PAT is rejected even with an OAuth app registered', !setting('pco_app_id'));
});

test("kiosk arrivals: today's station taps overlay the door screen", async () => {
  await connectPat();
  await post('/admin/pco/event', ADMIN, { event_id: '77' });
  // Local dates throughout: the run-day gate compares local dates. Scheduler markers are stamped
  // first so a real 60 s tick can't sweep this roster mid-test.
  const ymdL = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const lt = ymdL(new Date());
  const shiftL = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymdL(d); };
  for (const k of ['autoping_done', 'autoclose_done', 'confirmsweep_done', 'autoopen_done'])
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?,?)').run(k, lt);
  db.prepare('DELETE FROM checkins WHERE run_date = ?').run(lt);
  db.prepare('INSERT INTO checkins (run_date, email, name, program_id, sort_order) VALUES (?,?,?,1,0)').run(lt, TEAM, 'Polly Team');
  db.prepare('INSERT INTO checkins (run_date, email, name, program_id, sort_order) VALUES (?,?,?,1,1)').run(lt, REG2, 'Reggie Moved');
  await mockCall('/__mock/checkin', { personId: pcoIdOf(TEAM), eventId: '77', created_at: new Date().toISOString() });
  const walker = (await mockCall('/__mock/seed', { first: 'Walk', last: 'In', emails: ['walkin_stranger@pco.local'] })).id;
  await mockCall('/__mock/checkin', { personId: walker, eventId: '77', created_at: new Date().toISOString() });

  await post('/admin/pco/kioskarrivals', ADMIN, { on: '1' });
  check('toggle stored and audited', setting('pco_kiosk_arrivals') === '1' && audited('pco:kioskarrivals:on'));
  check('console shows it', (await get('/admin/pco')).includes('Kiosk arrivals are ON'));

  const seasonWas = setting('season_start');
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('season_start', ?)").run(shiftL(lt, 30));
  const tapCalls = async () => (await mockState()).log.filter((l) => l.path.includes('/check_ins')).length;
  const before = await tapCalls();
  await get('/kiosk/1'); await sleep(150); await get('/kiosk/1'); await sleep(150);
  check('a future run date never polls Check-Ins', (await tapCalls()) === before);

  db.prepare("DELETE FROM app_settings WHERE key = 'season_start'").run();
  const wed1 = (() => { const d = new Date(lt + 'T12:00:00'); while (d.getDay() !== 3) d.setDate(d.getDate() + 1); return ymdL(d); })();
  const wed2 = shiftL(wed1, 7);
  for (const w of [wed1, wed2]) db.prepare('INSERT OR REPLACE INTO run_overrides (default_date, run_date) VALUES (?,?)').run(w, lt);

  const k1 = await get('/kiosk/1');
  check('first look on run day: "starting…", never an unread zero', k1.includes('door sync starting…') && !k1.includes('in the building'));
  await sleep(400);
  const k2 = await get('/kiosk/1');
  check('a tapped floor player is IN', k2.includes('Polly Team <span class="kin">IN</span>'));
  check('an untapped one is not', !k2.includes('Reggie Moved <span class="kin">'));
  check('the tally counts roster arrivals only', k2.includes('1 in the building') && !k2.includes('2 in the building'));
  check('a tap without a spot is a walk-in', /\+\d+ walk-in/.test(k2));
  await mockCall('/__mock/checkin', { personId: pcoIdOf(REG2), eventId: '77', created_at: new Date().toISOString() });
  await sleep(50);
  await get('/kiosk/1');
  await sleep(400);
  const k3 = await get('/kiosk/1');
  check('a fresh tap flips the row within one poll', k3.includes('Reggie Moved <span class="kin">IN</span>') && k3.includes('2 in the building'));
  await post('/admin/pco/kioskarrivals', ADMIN, { on: '0' });
  const k4 = await get('/kiosk/1');
  check('toggle off: roster only', !k4.includes('<span class="kin">') && !k4.includes('in the building'));

  if (seasonWas != null) db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('season_start', ?)").run(seasonWas);
  for (const w of [wed1, wed2]) db.prepare('DELETE FROM run_overrides WHERE default_date = ?').run(w);
  db.prepare('DELETE FROM checkins WHERE run_date = ?').run(lt);
  for (const k of ['autoping_done', 'autoclose_done', 'confirmsweep_done', 'autoopen_done']) db.prepare('DELETE FROM app_settings WHERE key = ?').run(k);
});

test('weekly roster sync from Registrations: populate, reconcile, authz, errors are not identities', async () => {
  await connectPat({ webhook_secret: 'whsec' });
  // A fortnight-plus of daily signup times, so the fixture matches whichever night the app picks;
  // 16:00Z is midday locally under either DST offset.
  const times = [];
  const d0 = new Date(); d0.setHours(12, 0, 0, 0);
  for (let i = 0; i < 21; i++) {
    const x = new Date(d0); x.setDate(d0.getDate() + i);
    times.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}T16:00:00Z`);
  }
  const seed = async (first, last, emails) => (await mockCall('/__mock/seed', { first, last, emails })).id;
  const a = await seed('Rosta', 'Active', ['rosta_active@test.local']);
  const b = await seed('Rostb', 'Noemail', []);
  const c = await seed('Rostc', 'Cancelled', ['rostc_cancelled@test.local']);
  const w = await seed('Rostd', 'Waitlisted', ['rostd_wait@test.local']);
  const signup = (await mockCall('/__mock/signup', {
    name: 'YA Basketball - Advanced Run (Wed Sep 23)', times,
    attendees: [{ personId: a }, { personId: b }, { personId: c, active: false, canceled: true }, { personId: w, waitlisted: true }],
  })).id;
  const rows = () => db.prepare("SELECT email, name FROM run_roster WHERE program_id = 1 AND source = 'pco' ORDER BY email").all();

  await post('/checkin/roster-sync', ADMIN);
  let rs = rows();
  check('the sync populates run_roster at all', rs.length === 2);
  check('an active registrant with an email lands', rs.some((r) => r.email === 'rosta_active@test.local'));
  check('no PCO email: the stable synthetic address', rs.some((r) => r.email === `pco-${b}@adv.local`));
  check('a cancelled registrant is not on it', !rs.some((r) => r.email === 'rostc_cancelled@test.local'));
  check('a waitlisted registrant is not on it', !rs.some((r) => r.email === 'rostd_wait@test.local'));

  await mockCall('/__mock/signup/attendees', { id: signup, attendees: [{ personId: a }] });
  await post('/checkin/roster-sync', ADMIN);
  rs = rows();
  check('a re-sync removes someone who cancelled', rs.length === 1 && rs[0].email === 'rosta_active@test.local');

  await mockCall('/__mock/signup/attendees', { id: signup, attendees: [{ personId: a }, { personId: c }] });
  await post('/checkin/roster-sync', REG);   // REG's address moved to REG2 above: no account, no operator
  check('a non-operator cannot sync', rows().length === 1);
  await post('/checkin/roster-sync', ADMIN);
  check('an operator can', rows().length === 2);

  db.prepare("DELETE FROM run_roster WHERE program_id = 1 AND source = 'pco'").run();
  await mockCall('/__mock/forbid', { prefix: '/people/v2/people/', times: 1 });   // 403 the first email lookup only
  const msg = await msgOf(await post('/checkin/roster-sync', ADMIN));
  const after = rows();
  check('a failed lookup mints no phantom identity', !after.some((r) => r.email.startsWith('pco-')));
  check('the unresolved person is left off, not guessed', after.length === 1);
  check('the operator is told', /would not answer for/.test(msg));
  await post('/checkin/roster-sync', ADMIN);
  check('the re-sync adds them once PCO answers', rows().length === 2);
});
