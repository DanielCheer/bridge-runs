// In-app program creation (self-serve, no deploy): an admin creates a program and its routes work
// in the same process; validation holds at the input boundary; hidden until published; the run
// works end to end; edit/delete protect the built-ins and history; host role and join modes;
// per-program kiosk tokens; scheduled announcements.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN } from './helpers/app.mjs';
import { PERSONAS, PLAYERS } from '../fixtures/world.mjs';

const MEMBER = PLAYERS[0], TEAM = PERSONAS.team;
let app, db;
before(async () => { app = await startApp(); db = app.db(); });
after(async () => { db?.close(); await app?.stop(); });

const check = (name, cond) => assert.ok(cond, name);
const get = (p, as) => app.get(p, { as });
const text = async (p, as) => (await get(p, as)).text();
const post = (p, as, body) => app.post(p, body, { as });
const progRow = (slug) => db.prepare('SELECT * FROM program WHERE slug = ?').get(slug);
// The ?msg= notice an admin route answers with (a 302 Location for fetch-style posts).
const msgOf = async (r) => {
  const loc = r.headers.get('location');
  if (loc) return decodeURIComponent(loc.split('msg=')[1] || '');
  const m = (await r.text()).match(/msg=([^"&]+)/);
  return m ? decodeURIComponent(m[1]) : '';
};
const memberRow = (slug, e) => db.prepare(
  'SELECT pm.status, pm.role FROM program_membership pm JOIN program p ON p.id = pm.program_id WHERE p.slug = ? AND pm.email = ?').get(slug, e);

const FORM = {
  name: 'Youth Basketball', slug: 'youth', emoji: '🧒',
  dow: '4', startHour: '17', endHour: '19',
  cap: '16', waitlist: '4', prereg: '0',
  approval: 'open', seating: 'instant', confirmMode: 'none',
  lockTime: '17:00', teamsCount: '2', teamsSize: '8', partySize: '4',
  theme: 'pk', autoRenew: '1',
};

test('authz: only an admin manages programs', async () => {
  check('a member cannot open the programs screen', (await get('/admin/programs', MEMBER)).status !== 200);
  await post('/admin/programs/create', MEMBER, FORM);
  check('a member cannot create a program', !progRow('youth'));
  const page = await text('/admin/programs', ADMIN);
  check('admin sees the built-ins listed', page.includes('Programs') && page.includes('ADV Basketball') && page.includes('Volleyball'));
});

let recycledId;
test('validation at the input boundary', async () => {
  const bad = async (over) => msgOf(await post('/admin/programs/create', ADMIN, { ...FORM, ...over }));
  check('a slug shadowing an app route', (await bad({ slug: 'admin' })).includes('already used by the app'));
  check('a slug colliding with a program', (await bad({ slug: 'volleyball' })).includes('already uses'));
  check('a malformed slug', (await bad({ slug: 'Youth Program!' })).includes('lowercase letters'));
  check('an empty name', (await bad({ name: '' })).includes('at least 2 characters'));
  check('an impossible floor size', (await bad({ cap: '0' })).includes('between 1 and 200'));
  check('end before start', (await bad({ startHour: '20', endHour: '18' })).includes('after the start time'));
  check("pickleball's settings namespace (pk)", (await bad({ slug: 'pk' })).includes('already used by the app'));
  check("volleyball's settings namespace (vb)", (await bad({ slug: 'vb' })).includes('already used by the app'));
  check('a name carrying markup', (await bad({ name: '<img src=x onerror=alert(1)>' })).includes('letters, numbers, spaces'));
  check('a quote-bearing name', (await bad({ name: `Youth's "Run"` })).includes('letters, numbers, spaces'));
  check('an icon containing markup', (await bad({ emoji: '<b>' })).includes('plain emoji'));
  check('a legitimate name with allowed punctuation is accepted', (await bad({ name: 'Jr. 3v3 Co-Ed / Youth+', slug: 'namecheck' })).includes('Created'));
  recycledId = progRow('namecheck').id;   // the next create REUSES this id
  await post('/admin/programs/delete', ADMIN, { id: String(recycledId) });
  check('nothing was left by the invalid attempts', !progRow('youth') && !progRow('admin') && !progRow('pk') && !progRow('vb') && !progRow('namecheck'));
});

let row, spec;
test('create: routes work in this process, no restart', async () => {
  await post('/admin/programs/create', ADMIN, FORM);
  row = progRow('youth');
  check('row created, hidden by default', !!row && row.active === 0 && row.id >= 4);
  spec = JSON.parse(row.config);
  check('spec stored from the form', spec.cap === 16 && spec.dow === 4 && spec.teams.count === 2 && spec.groupQueue.maxSize === 4 && spec.theme === 'pk');
  check('run page answers on the new slug', (await get('/youth', ADMIN)).status === 200);
  check('a reused id still mounts its routes', row.id === recycledId);
  check("the deleted program's old path stays dead", (await get('/namecheck', ADMIN)).status === 404);
  const runPage = await text('/youth', ADMIN);
  check('run page renders the name and its theme', runPage.includes('Youth Basketball') && /<body class="[^"]*\bpk\b/.test(runPage));
  check('chat mounted', (await get('/youth/chat', ADMIN)).status === 200);
  check('season board mounted', (await get('/youth/season', ADMIN)).status === 200);
  check('calendar file mounted', (await get('/youth/run.ics', ADMIN)).status === 200);
  check('no run date stored yet', !db.prepare("SELECT 1 FROM app_settings WHERE key = 'youth_run_date'").get());
});

test('hidden until published', async () => {
  check('hidden program 404s for a member', (await get('/youth', MEMBER)).status === 404);
  check('absent from the member hub', !(await text('/runs', MEMBER)).includes('Youth Basketball'));
  await post('/admin/programs/active', ADMIN, { id: String(row.id), on: '1' });
  check('published program on the hub', (await text('/runs', MEMBER)).includes('Youth Basketball'));
  check('reachable by a member', (await get('/youth', MEMBER)).status === 200);
});

test('the new run works end to end', async () => {
  await post('/youth/join-run', MEMBER);
  check('membership row', !!db.prepare('SELECT 1 FROM program_membership WHERE program_id = ? AND email = ?').get(row.id, MEMBER));
  await post('/youth/open', ADMIN);
  await post('/youth/join', MEMBER);
  check('checked in on the new roster', db.prepare('SELECT COUNT(*) n FROM checkins WHERE program_id = ? AND email = ?').get(row.id, MEMBER).n === 1);
  check('no row leaked into the built-in programs', !db.prepare('SELECT 1 FROM checkins WHERE program_id IN (1,2,3) AND email = ?').get(MEMBER));
  await post('/youth/chat', MEMBER, { body: 'first message in youth chat' });
  check('chat message in the new room', !!db.prepare('SELECT 1 FROM group_messages WHERE program_id = ? AND from_email = ?').get(row.id, MEMBER));
  check('scheduler tick runs clean', (await post('/admin/test/tick', ADMIN)).status === 200);
  check('teams panel present (2 x 8 from the form)', (await text('/youth', ADMIN)).includes('Team 1'));
});

test('edit, and the built-ins stay protected', async () => {
  await post('/admin/programs/edit', ADMIN, { ...FORM, id: String(row.id), cap: '24', name: 'Youth Hoops' });
  check('edit updated the spec and name', JSON.parse(progRow('youth').config).cap === 24 && progRow('youth').name === 'Youth Hoops');
  check('edited program still serves', (await get('/youth', ADMIN)).status === 200);
  check('a code-defined program cannot be edited here', (await msgOf(await post('/admin/programs/edit', ADMIN, { ...FORM, id: '1', slug: 'checkin' }))).includes('managed in code'));
  const del = await msgOf(await post('/admin/programs/delete', ADMIN, { id: '3' }));
  check('a code-defined program cannot be deleted here', del.includes('can’t be deleted') || del.includes('managed in code'));
  check('built-in run pages unaffected', (await get('/checkin', ADMIN)).status === 200
    && (await get('/pickleball', ADMIN)).status === 200 && (await get('/volleyball', ADMIN)).status === 200);
});

test('delete protects history', async () => {
  const used = await post('/admin/programs/delete', ADMIN, { id: String(row.id) });
  check('refused once the program has sign-ups/chat', (await msgOf(used)).includes('hide it instead') && !!progRow('youth'));
  await post('/admin/programs/create', ADMIN, { ...FORM, name: 'Scratch Run', slug: 'scratch', emoji: '🧪', teamsCount: '0', partySize: '0' });
  await post('/admin/programs/delete', ADMIN, { id: String(progRow('scratch').id) });
  check('an empty program deletes cleanly', !progRow('scratch'));
  check('and stops serving', (await get('/scratch', ADMIN)).status === 404);
  check('create/publish/edit/delete all audited', ['program:create', 'program:publish', 'program:edit', 'program:delete']
    .every((a) => !!db.prepare('SELECT 1 FROM audit_log WHERE action = ?').get(a)));
});

test('hardening: no orphans or leaked settings, a ladder blocks delete, a malformed spec stays inert', async () => {
  await post('/admin/programs/create', ADMIN, { ...FORM, name: 'Scratch Two', slug: 'scratch2', emoji: '🧪', teamsCount: '0', partySize: '0' });
  const s2 = progRow('scratch2').id;
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('scratch2_chat_seq', '7')").run();
  db.prepare('INSERT OR IGNORE INTO regular_optout (run_date, email, program_id) VALUES (?,?,?)').run('2030-01-01', MEMBER, s2);
  db.prepare('INSERT INTO ladder_games (program_id, run_date, w1, w2, l1, l2, w_score, l_score, logged_by) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(s2, '2030-01-01', 'a@l.local', 'b@l.local', 'c@l.local', 'd@l.local', 11, 4, ADMIN);
  db.prepare('INSERT OR IGNORE INTO ladder_players (program_id, email, name, added_by) VALUES (?,?,?,?)').run(s2, 'a@l.local', 'A', 'test');
  db.prepare('INSERT OR REPLACE INTO ladder_nominations (program_id, run_date, email, voter, note) VALUES (?,?,?,?,?)').run(s2, '2030-01-01', 'a@l.local', MEMBER, '');
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?,?)').run(`kiosk_token_${s2}`, 'projectortoken');
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?,?)').run(`ladder_noms_${s2}`, '1');
  const blocked = await post('/admin/programs/delete', ADMIN, { id: String(s2) });
  check('refused when the only history is a ladder season', (await msgOf(blocked)).includes('hide it instead') && !!progRow('scratch2'));
  db.prepare('DELETE FROM ladder_games WHERE program_id = ?').run(s2);
  await post('/admin/programs/delete', ADMIN, { id: String(s2) });
  check("the slug's settings namespace is cleared", !db.prepare("SELECT 1 FROM app_settings WHERE key = 'scratch2_chat_seq'").get());
  check('settings keyed by program id are cleared (kiosk token, voting flag)',
    !db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(`kiosk_token_${s2}`) && !db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(`ladder_noms_${s2}`));
  check('no program-scoped orphan rows', !db.prepare('SELECT 1 FROM regular_optout WHERE program_id = ?').get(s2)
    && !db.prepare('SELECT 1 FROM program_membership WHERE program_id = ?').get(s2)
    && !db.prepare('SELECT 1 FROM ladder_players WHERE program_id = ?').get(s2)
    && !db.prepare('SELECT 1 FROM ladder_nominations WHERE program_id = ?').get(s2));
  // A spec that parses but lacks numbers must not mount (a hand-edited row).
  db.prepare("INSERT INTO program (id, name, sport, slug, active, approval, config) VALUES (88, 'Broken', 'broken', 'broken', 1, 'open', ?)")
    .run(JSON.stringify({ displayName: 'Broken', emoji: '💥' }));
  await post('/admin/programs/active', ADMIN, { id: '88', on: '1' });   // any route that rebuilds the registry
  check('a malformed spec is not mounted', (await get('/broken', ADMIN)).status === 404);
  check('the hub still renders', (await get('/runs', MEMBER)).status === 200 && (await get('/runs', ADMIN)).status === 200);
  check('the tick survives the bad row', (await post('/admin/test/tick', ADMIN)).status === 200);
  db.prepare('DELETE FROM program WHERE id = 88').run();
});

let gid;
test('join modes and the per-program host role', async () => {
  await post('/admin/programs/create', ADMIN, { ...FORM, name: 'Gated Run', slug: 'gated', emoji: '🔒', joinMode: 'host', teamsCount: '0', partySize: '0' });
  gid = progRow('gated').id;
  await post('/admin/programs/active', ADMIN, { id: String(gid), on: '1' });
  await post('/gated/join-run', MEMBER);
  check('host mode: joining creates a pending request', memberRow('gated', MEMBER)?.status === 'pending');
  check('a pending request is not membership', (await text('/gated', MEMBER)).includes('Request sent'));
  check('request audited', !!db.prepare("SELECT 1 FROM audit_log WHERE action = 'program:join-requested'").get());
  check('the operator sees it on the run page', (await text('/gated', ADMIN)).includes('Join requests (1)'));
  await post('/gated/requests', ADMIN, { email: MEMBER, act: 'approve' });
  check('approval flips the row', memberRow('gated', MEMBER).status === 'approved');
  check('the member is in after approval', !(await text('/gated', MEMBER)).includes('Request sent'));
  await post('/gated/join-run', TEAM);
  await post('/gated/requests', ADMIN, { email: TEAM, act: 'decline' });
  check('decline removes the request', !memberRow('gated', TEAM));

  await post('/admin/programs/create', ADMIN, { ...FORM, name: 'Closed Run', slug: 'closed', emoji: '🚪', joinMode: 'invite', teamsCount: '0', partySize: '0' });
  await post('/admin/programs/active', ADMIN, { id: String(progRow('closed').id), on: '1' });
  await post('/closed/join-run', MEMBER);
  check('invite mode: self-join creates nothing', !memberRow('closed', MEMBER));
  check('invite mode: the page says so', (await text('/closed', MEMBER)).includes('invite only'));
  await post('/admin/programs/member', ADMIN, { id: String(progRow('closed').id), email: MEMBER, act: 'add' });
  check('admin add creates an approved membership', memberRow('closed', MEMBER)?.status === 'approved');

  await post('/admin/programs/member', ADMIN, { id: String(gid), email: MEMBER, act: 'host' });
  check('host role granted', memberRow('gated', MEMBER)?.role === 'host');
  await post('/gated/open', MEMBER);
  check('a host can open their own program', db.prepare('SELECT is_open FROM run_state WHERE program_id = ? ORDER BY run_date DESC LIMIT 1').get(gid)?.is_open === 1);
  const vbOpen = () => db.prepare('SELECT COALESCE(MAX(is_open), 0) o FROM run_state WHERE program_id = 3').get().o;
  const before = vbOpen();
  await post('/volleyball/open', MEMBER);
  check('the same host cannot operate another program', vbOpen() === before);
  check('a host is not an app admin', (await get('/admin/people', MEMBER)).status !== 200);
  await post('/gated/join-run', TEAM);
  await post('/gated/requests', MEMBER, { email: TEAM, act: 'approve' });
  check('a host can approve requests for their program', memberRow('gated', TEAM)?.status === 'approved');
  check('host grant key-audited', !!db.prepare("SELECT 1 FROM audit_key_events WHERE action = 'program:host-granted'").get());
});

test('kiosk: per-program tokens, PIN exit, demo admin-only, host rotation', async () => {
  check('refused without a token or admin session', (await get(`/kiosk/${gid}`, MEMBER)).status === 403);
  await post('/admin/kiosk', ADMIN);
  const tok = db.prepare('SELECT value v FROM app_settings WHERE key = ?').get(`kiosk_token_${gid}`)?.v;
  check('token minted per program', !!tok);
  check('global-era token retired', !db.prepare("SELECT value v FROM app_settings WHERE key = 'kiosk_token'").get());
  const kiosk = await get(`/kiosk/${gid}?k=${tok}`);
  check('the link works with no session', kiosk.status === 200);
  const k = await kiosk.text();
  check('shows the program', /Gated Run/.test(k));
  check('PIN-gated exit, no footer links', k.includes('id="kexit"') && !k.includes('legalfoot'));
  check('the demo has no token kiosk', (await get(`/kiosk/90?k=${tok}`)).status === 404);
  check('the demo kiosk opens for an admin session', (await get('/kiosk/90', ADMIN)).status === 200);
  check("one program's token does not open another's", (await get(`/kiosk/1?k=${tok}`)).status === 403);
  await post('/gated/kiosk-rotate', MEMBER);
  const tok2 = db.prepare('SELECT value v FROM app_settings WHERE key = ?').get(`kiosk_token_${gid}`)?.v;
  check('the host rotates their token', !!tok2 && tok2 !== tok);
  check('the old link dies', (await get(`/kiosk/${gid}?k=${tok}`)).status === 403);
  check('the new link works', (await get(`/kiosk/${gid}?k=${tok2}`)).status === 200);
  check('the host sees the kiosk controls', (await text('/gated', MEMBER)).includes('kiosk-rotate'));
  await post('/demo/kiosk-rotate', ADMIN);
  check('the demo cannot mint a token', !db.prepare("SELECT 1 FROM app_settings WHERE key = 'kiosk_token_90'").get());
  check('the demo run page offers no kiosk controls', !(await text('/demo', ADMIN)).includes('kiosk-rotate'));
});

test('scheduled announcements: pending, cancellable, fired by the tick as a fresh row', async () => {
  const d = new Date(Date.now() + 3600000), p = (n) => String(n).padStart(2, '0');
  const future = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  await post('/gated/announce', ADMIN, { body: 'Scheduled hello world', publish_at: future });
  const sched = db.prepare("SELECT id, pending FROM announcements WHERE body = 'Scheduled hello world'").get();
  check('stored as pending', sched?.pending === 1);
  const hostView = await text('/gated', MEMBER);
  check('the host sees it as Scheduled', hostView.includes('Scheduled hello world') && hostView.includes('annlog-state sched'));
  check('a pending post is never the live banner', !hostView.includes('annbanner'));
  const dup = new URLSearchParams([['body', 'Dup field sched'], ['publish_at', future], ['publish_at', '']]);
  await post('/gated/announce', ADMIN, dup);
  check('a duplicated schedule field still schedules', db.prepare("SELECT pending FROM announcements WHERE body = 'Dup field sched'").get()?.pending === 1);
  await post('/admin/test/tick', ADMIN);
  check('not due: still pending after a tick', db.prepare('SELECT pending FROM announcements WHERE id = ?').get(sched.id).pending === 1);
  await post('/gated/announce', ADMIN, { body: 'Cancel me', publish_at: future });
  const cxl = db.prepare("SELECT id FROM announcements WHERE body = 'Cancel me' AND pending = 1").get();
  await post('/gated/announce/cancel', MEMBER, { id: String(cxl.id) });
  check('the host can cancel before it fires', !db.prepare('SELECT 1 FROM announcements WHERE id = ?').get(cxl.id));
  db.prepare("UPDATE announcements SET publish_at = '2020-01-01T00:00' WHERE id = ?").run(sched.id);
  await post('/admin/test/tick', ADMIN);
  const fired = db.prepare("SELECT id, pending FROM announcements WHERE body = 'Scheduled hello world'").all();
  check('due: fired as a fresh row', fired.length === 1 && fired[0].pending === 0 && fired[0].id !== sched.id);
  check('now live on the run page', (await text('/gated', MEMBER)).includes('Scheduled hello world'));
  check('firing audited', !!db.prepare("SELECT 1 FROM audit_log WHERE action = 'announce:fired'").get());
});
