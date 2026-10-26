// guard.js — the startup contract between a test instance and production (docs/TESTING.md).
//
// Most cases run `import('./guard.js')` in a child rather than booting server.js: the env checks
// run at guard.js's top level, so the verdict is identical, and if the guard ever regressed, a bare
// import exits doing nothing instead of booting an app whose missing variable points at the live
// database or port 3000. Two cases boot the real server.js, chosen so that even a regressed guard
// would stay inside the temp directory; together with the import-order check they prove the guard
// runs before anything else on the real entry point.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, isolationEnv, seedFixture, openDb } from './helpers/app.mjs';

let work;
before(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-guard-')); });
after(() => { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

// Parent env minus anything app-related, then the given env.
const run = (args, env) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HARNESS|PORT|DB_PATH|BACKUP_|CHAT_|AVATARS_|BANNER_|PCO_|SMTP_|SESSION_|COOKIE_|ADMIN_|PUBLIC_URL|ENABLE_TEST_TICK|TEST_NOW|FORCE_HELD_RELEASED)/.test(k)));
  return spawnSync(process.execPath, args, { cwd: REPO, env: { ...clean, ...env }, encoding: 'utf8', timeout: 30_000 });
};
const importGuard = (env) => run(['--input-type=module', '-e', "await import('./guard.js')"], env);
const without = (key, extra = {}) => { const e = { ...isolationEnv(work, 39999), ...extra }; delete e[key]; return e; };

test('db.js imports guard.js before anything else', () => {
  const src = fs.readFileSync(path.join(REPO, 'db.js'), 'utf8');
  const firstImport = src.split('\n').find((l) => /^import\b/.test(l));
  assert.match(firstImport, /from '\.\/guard\.js'|import '\.\/guard\.js'/);
});

test('the full isolation environment passes', () => {
  const r = importGuard(isolationEnv(work, 39999));
  assert.equal(r.status, 0, r.stderr);
});

for (const key of ['PORT', 'DB_PATH', 'BACKUP_DIR', 'CHAT_MEDIA_DIR', 'AVATARS_DIR', 'BANNER_DIR', 'PCO_API_BASE']) {
  test(`HARNESS=1 without ${key} refuses to start and names it`, () => {
    const r = importGuard(without(key));
    assert.equal(r.status, 90);
    assert.match(r.stderr, /REFUSING TO START/);
    assert.match(r.stderr, new RegExp(`\\b${key}\\b`));
  });
}

test('HARNESS=1 on the public port 3000 is refused', () => {
  const r = importGuard({ ...isolationEnv(work, 3000) });
  assert.equal(r.status, 90);
  assert.match(r.stderr, /PORT=3000/);
});

test('a writable path inside the app directory is refused', () => {
  const r = importGuard({ ...isolationEnv(work, 39999), BACKUP_DIR: path.join(REPO, 'backups') });
  assert.equal(r.status, 90);
  assert.match(r.stderr, /BACKUP_DIR=.*inside the live app directory/);
});

test('the production Planning Center API is refused', () => {
  const r = importGuard({ ...isolationEnv(work, 39999), PCO_API_BASE: 'https://api.planningcenteronline.com' });
  assert.equal(r.status, 90);
  assert.match(r.stderr, /PCO_API_BASE points at production Planning Center/);
});

test('a non-loopback SMTP host is refused', () => {
  const r = importGuard({ ...isolationEnv(work, 39999), SMTP_HOST: 'smtp.example.com' });
  assert.equal(r.status, 90);
  assert.match(r.stderr, /SMTP_HOST="smtp\.example\.com" is not loopback/);
});

test('booting server.js with HARNESS=1 and no PCO_API_BASE refuses before serving', () => {
  const dir = fs.mkdtempSync(path.join(work, 'boot-'));
  const r = run(['server.js'], without('PCO_API_BASE', isolationEnv(dir, 39998)));
  assert.equal(r.status, 90);
  assert.match(r.stderr, /PCO_API_BASE is unset/);
  assert.equal(fs.existsSync(path.join(dir, 'app.db')), false, 'refused before the database file was opened');
});

test('a fixture carrying Planning Center credentials is refused after the database opens', () => {
  const dir = fs.mkdtempSync(path.join(work, 'dirty-'));
  const dbPath = seedFixture(dir);
  const db = openDb(dbPath);
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('pco_app_id', 'copied-from-somewhere')").run();
  db.close();
  const r = run(['server.js'], isolationEnv(dir, 39997));
  assert.equal(r.status, 90);
  assert.match(r.stderr, /Planning Center credential\/setting row/);
  assert.match(r.stderr, /node scripts\/sanitize-db\.mjs/);
});

test('production side: test-only seams on port 3000 are refused (import only, nothing binds)', () => {
  const r = importGuard({ PORT: '3000', TEST_NOW: '2026-01-01T12:00:00', COOKIE_INSECURE: '1' });
  assert.equal(r.status, 90);
  assert.match(r.stderr, /Test-only settings are present on the live port 3000: TEST_NOW, COOKIE_INSECURE/);
});

test('production side: a clean production environment passes', () => {
  const r = importGuard({ PORT: '3000' });
  assert.equal(r.status, 0, r.stderr);
});
