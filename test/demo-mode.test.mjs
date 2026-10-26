// DEMO_MODE=1 — the public demo (docs/DEMO.md): the guard's isolation contract applies to it,
// the app seeds the synthetic world on a fresh database, /login offers fixture personas only,
// the demo strip appears only in demo mode, and only the organizer can reset (a clean exit that
// scripts/run-demo.mjs turns into a wiped, reseeded restart).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, startApp, isolationEnv } from './helpers/app.mjs';
import { DEMO_PERSONAS, PERSONAS } from '../fixtures/world.mjs';
import { withoutAppEnv } from '../scripts/app-env.mjs';

// A demo instance, not a harness one: HARNESS off, DEMO_MODE on, the same isolated paths.
const DEMO = { HARNESS: '', DEMO_MODE: '1' };

let demo, plain, work;
before(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-demo-guard-'));
  // `demo` boots on an EMPTY location, so the app seeds the world itself, exactly as in a real
  // demo; `plain` is an ordinary instance for the "off by default" checks.
  [demo, plain] = await Promise.all([startApp({ fixture: false, env: DEMO }), startApp()]);
});
after(async () => {
  await Promise.all([demo?.stop(), plain?.stop()]);
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------- the guard ----------
const importGuard = (env) => {
  return spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./guard.js')"], { cwd: REPO, env: { ...withoutAppEnv(process.env), ...env }, encoding: 'utf8', timeout: 30_000 });
};
const demoEnv = (extra = {}) => ({ ...isolationEnv(work, 39990), ...DEMO, ...extra });

test('a full demo environment passes the guard', () => {
  const r = importGuard(demoEnv());
  assert.equal(r.status, 0, r.stderr);
});

test('DEMO_MODE without DB_PATH refuses to start and names it', () => {
  const env = demoEnv(); delete env.DB_PATH;
  const r = importGuard(env);
  assert.equal(r.status, 90);
  assert.match(r.stderr, /REFUSING TO START — DEMO_MODE=1 isolation/);
  assert.match(r.stderr, /\bDB_PATH is unset\b/);
});

test("DEMO_MODE pointed at the app directory's bridge.db is refused", () => {
  const r = importGuard(demoEnv({ DB_PATH: path.join(REPO, 'bridge.db') }));
  assert.equal(r.status, 90);
  assert.match(r.stderr, /DB_PATH=.*bridge\.db" resolves inside the live app directory/);
});

test('DEMO_MODE with the live backups or the production backup key is refused', () => {
  const r = importGuard(demoEnv({ BACKUP_DIR: path.join(REPO, 'backups'), BACKUP_KEY_FILE: path.join(REPO, 'backup.key') }));
  assert.equal(r.status, 90);
  assert.match(r.stderr, /BACKUP_DIR=.*inside the live app directory/);
  assert.match(r.stderr, /BACKUP_KEY_FILE=.*inside the live app directory/);
});

test('a demo on a database holding real (non-fixture) people refuses after it opens', () => {
  // A copy of a real database OUTSIDE the app directory passes every path check; the people in
  // it are what give it away.
  const dir = fs.mkdtempSync(path.join(work, 'copy-'));
  const env = { ...isolationEnv(dir, 39991), ...DEMO };
  const seedRun = spawnSync(process.execPath, ['scripts/seed-fixture.mjs', '--db', env.DB_PATH], { cwd: REPO, env: { ...process.env, ...isolationEnv(dir, 0) }, encoding: 'utf8' });
  assert.equal(seedRun.status, 0, seedRun.stderr);
  const ins = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { DatabaseSync } from 'node:sqlite'; new DatabaseSync(${JSON.stringify(env.DB_PATH)}).prepare("INSERT INTO applicants (full_name, email, phone, experience, where_played, status) VALUES ('Real Person','someone@gmail.com','1','x','x','approved')").run();`],
  { encoding: 'utf8' });
  assert.equal(ins.status, 0, ins.stderr);
  const r = spawnSync(process.execPath, ['server.js'], { cwd: REPO, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 90);
  assert.match(r.stderr, /1 applicant\(s\) outside @test\.local in the demo database/);
});

// ---------- the running demo ----------
const cookieFrom = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
const loginAs = async (persona) => {
  const r = await demo.post('/demo/login', { persona });
  assert.equal(r.status, 302, `persona ${persona}`);
  assert.equal(r.headers.get('location'), '/status');
  const cookie = cookieFrom(r);
  assert.match(cookie, /^bridge_session=/);
  return cookie;
};

test('a fresh demo database is seeded with the synthetic world', () => {
  const db = demo.db();
  try {
    const emails = db.prepare('SELECT email FROM applicants').all().map((r) => r.email);
    assert.ok(emails.length > 10);
    for (const p of DEMO_PERSONAS) assert.ok(emails.includes(p.email), `${p.key} persona exists`);
    assert.ok(emails.every((e) => e.endsWith('@test.local')));
  } finally { db.close(); }
  assert.match(demo.log, /\[demo\] seeded the synthetic world/);
});

test('/login shows every persona and still offers the email sign-in', async () => {
  const html = await (await demo.get('/login')).text();
  assert.match(html, /action="\/demo\/login"/);
  for (const p of DEMO_PERSONAS) assert.ok(html.includes(`value="${p.key}"`), `picker offers ${p.key}`);
  assert.ok(!html.includes('@test.local'), 'the picker never prints persona emails');
  assert.match(html, /action="\/login"/);
});

test('the email sign-in shows the code on screen (no SMTP in the demo)', async () => {
  const html = await (await demo.post('/login', { email: PERSONAS.core })).text();
  assert.match(html, /DEV MODE code: <b>\d{6}<\/b>/);
});

test('the organizer persona is an admin', async () => {
  const as = await loginAs('organizer');
  assert.equal((await demo.get('/status', { as })).headers.get('location'), '/runs');
  assert.equal((await demo.get('/admin', { as })).status, 200);
});

test('a regular player gets in, but not into /admin', async () => {
  const as = await loginAs('player');
  assert.equal((await demo.get('/runs', { as })).status, 200);
  assert.equal((await demo.get('/admin', { as })).status, 403);
});

test('the council voter reaches the council screen', async () => {
  const as = await loginAs('council');
  assert.equal((await demo.get('/admin', { as })).status, 200);
});

test('the pending applicant lands on the status page', async () => {
  const as = await loginAs('pending');
  const r = await demo.get('/status', { as });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Application in review/);
});

test('an unknown persona is refused and signs nobody in', async () => {
  for (const persona of ['', 'admin@test.local', 'nobody']) {
    const r = await demo.post('/demo/login', { persona });
    assert.equal(r.status, 400);
    assert.equal(r.headers.get('set-cookie'), null);
  }
});

test('the demo strip is on every page in demo mode and on none otherwise', async () => {
  for (const p of ['/', '/login', '/privacy']) {
    assert.match(await (await demo.get(p)).text(), /class="demo-strip"[^>]*>Demo — fictional data, resets every 6 hours/);
    assert.doesNotMatch(await (await plain.get(p)).text(), /demo-strip|\/demo\/login/);
  }
  assert.match(await (await demo.get('/login')).text(), /href="https:\/\/github\.com\/DanielCheer\/bridge-runs"/);
});

test('outside demo mode the demo routes do not exist', async () => {
  assert.equal((await plain.post('/demo/login', { persona: 'organizer' })).status, 404);
  assert.equal((await plain.post('/demo/reset', {}, { as: PERSONAS.admin })).status, 404);
});

test('only the organizer can reset, and not within a minute of the last reset', async () => {
  for (const persona of ['team', 'player', 'pending']) {
    const as = await loginAs(persona);
    assert.equal((await demo.post('/demo/reset', {}, { as })).status, 403, persona);
  }
  assert.equal((await demo.post('/demo/reset', {})).status, 403, 'signed out');
  // This instance booted seconds ago, i.e. "was just reset": the cooldown refuses.
  const admin = await loginAs('organizer');
  assert.equal((await demo.post('/demo/reset', {}, { as: admin })).status, 429);
  assert.equal(await Promise.race([demo.exited, new Promise((r) => setTimeout(() => r('alive'), 300))]), 'alive', 'still running');
});

test("the organizer's reset is a clean exit (the supervisor restarts on a wiped world)", async () => {
  const app = await startApp({ fixture: false, env: { ...DEMO, DEMO_RESET_COOLDOWN_S: '0' } });
  try {
    const login = await app.post('/demo/login', { persona: 'organizer' });
    const as = cookieFrom(login);
    assert.equal((await app.get('/demo/reset', { as })).status, 200, 'the confirm page');
    const r = await app.post('/demo/reset', {}, { as });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Resetting the demo/);
    assert.equal(await app.exited, 0);
    assert.match(app.log, /\[demo\] reset requested by admin@test\.local/);
  } finally { await app.stop(); }
});

// ---------- the supervisor (scripts/run-demo.mjs) ----------
test('run-demo.mjs refuses to wipe a folder it did not create', () => {
  const dir = fs.mkdtempSync(path.join(work, 'foreign-'));
  fs.writeFileSync(path.join(dir, 'keep-me.txt'), 'not the demo\'s');
  const r = spawnSync(process.execPath, ['scripts/run-demo.mjs', '--data', dir, '--port', '39992'], { cwd: REPO, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not empty and was not created by run-demo\.mjs/);
  assert.ok(fs.existsSync(path.join(dir, 'keep-me.txt')));
});

test('run-demo.mjs: a reset wipes what visitors posted and reseeds a clean world', async () => {
  const { freePort } = await import('./helpers/app.mjs');
  const port = await freePort();
  const dir = path.join(work, 'supervised');
  const env = withoutAppEnv(process.env);
  const sup = (await import('node:child_process')).spawn(process.execPath, ['scripts/run-demo.mjs', '--data', dir, '--port', String(port)],
    { cwd: REPO, env: { ...env, DEMO_RESET_COOLDOWN_S: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  sup.stdout.on('data', (d) => { log += d; });
  sup.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const up = async () => {
    for (const end = Date.now() + 30_000; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
      try { if ((await fetch(base + '/healthz')).ok) return; } catch {}
    }
    throw new Error('demo not healthy:\n' + log);
  };
  const organizer = async () => cookieFrom(await fetch(base + '/demo/login', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' }, body: 'persona=organizer' }));
  const chat = async (as) => (await (await fetch(base + '/chat', { headers: { Cookie: as } })).text());
  try {
    await up();
    let as = await organizer();
    const form = new FormData(); form.set('body', 'a visitor was here 7f3a');
    const posted = await fetch(base + '/chat', { method: 'POST', redirect: 'manual', headers: { Cookie: as, 'X-Requested-With': 'fetch' }, body: form });
    assert.ok(posted.status < 400, `chat post: ${posted.status}`);
    assert.match(await chat(as), /a visitor was here 7f3a/);

    assert.equal((await fetch(base + '/demo/reset', { method: 'POST', headers: { Cookie: as, 'X-Requested-With': 'fetch' } })).status, 200);
    for (const end = Date.now() + 15_000; !/reset: wiping the world/.test(log) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
    await up();
    assert.equal((await fetch(base + '/runs', { redirect: 'manual', headers: { Cookie: as } })).status, 302, 'the old session died with the reset');
    as = await organizer();
    const after = await chat(as);
    assert.doesNotMatch(after, /a visitor was here 7f3a/);
    assert.match(after, /who is running this week\?/, 'the seeded chat is back');
    assert.match(log, /reset: wiping the world and starting again/);
  } finally {
    sup.kill();
    await new Promise((r) => (sup.exitCode === null ? sup.once('exit', r) : r()));
  }
});
