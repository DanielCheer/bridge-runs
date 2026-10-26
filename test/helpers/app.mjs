// test/helpers/app.mjs — boot the REAL app (node server.js) on a throwaway world, for one test file.
//
//   const app = await startApp();            // seeded synthetic world, free port, isolated dirs
//   const r = await app.get('/runs', { as: 'player01@test.local' });
//   await app.stop();
//
// Every run gets its own temp directory (database, backups, backup key, media, avatars, banners)
// and its own port, so test files can run in parallel. The child gets the same isolation
// environment the guard (guard.js) demands of any test instance; nothing points at the repo's
// bridge.db, backups/, backup.key or public/ uploads, and no outward channel is reachable.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { withoutAppEnv } from '../../scripts/app-env.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SESSION_SECRET = 'test';
export const ADMIN = 'admin@test.local';

// A free TCP port on loopback (the OS picks; released immediately for the child to bind).
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// The isolation environment for a test instance rooted at `work` on `port`. Exported so the guard
// test can remove one variable at a time.
export function isolationEnv(work, port) {
  return {
    HARNESS: '1',
    PORT: String(port),
    DB_PATH: path.join(work, 'app.db'),
    BACKUP_DIR: path.join(work, 'backups'),
    BACKUP_KEY_FILE: path.join(work, 'backup.key'),
    CHAT_MEDIA_DIR: path.join(work, 'media'),
    AVATARS_DIR: path.join(work, 'avatars'),
    BANNER_DIR: path.join(work, 'banners'),
    PCO_API_BASE: 'http://127.0.0.1:1',
    PCO_PACE_MS: '0',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '2',
    SESSION_SECRET,
    COOKIE_INSECURE: '1',
    ADMIN_EMAILS: ADMIN,
    PUBLIC_URL: `http://localhost:${port}`,
    ENABLE_TEST_TICK: '1',
  };
}

// The parent environment minus anything app-related, so a developer's exported SMTP/PCO/etc.
// variables can never leak into a test instance. Only the variables named above (plus `env`) reach it.
function baseEnv() {
  return withoutAppEnv(process.env);
}

// Build a fresh world database at <work>/app.db through scripts/seed-fixture.mjs (a child, because
// db.js opens DB_PATH at import time and must see the test environment).
export function seedFixture(work, { today } = {}) {
  const dbPath = path.join(work, 'app.db');
  const args = [path.join(REPO, 'scripts', 'seed-fixture.mjs'), '--db', dbPath];
  if (today) args.push('--today', today);
  try {
    execFileSync(process.execPath, args, { cwd: REPO, env: { ...baseEnv(), ...isolationEnv(work, 0) }, stdio: 'pipe' });
  } catch (e) {
    throw new Error(`seed-fixture failed:\n${e.stderr?.toString() || e.message}`, { cause: e });
  }
  return dbPath;
}

// Sign a session cookie exactly as auth.js does: "email|version" + HMAC-SHA256 (base64url).
export function signCookie(email, version = 0, secret = SESSION_SECRET) {
  const v = `${String(email).toLowerCase()}|${version}`;
  return `bridge_session=${v}.${crypto.createHmac('sha256', secret).update(v).digest('base64url')}`;
}

// `fixture: false` boots on an empty location instead of the seeded world (the app creates the
// database itself), for suites about what the app does on a first boot.
export async function startApp({ env = {}, today, seed, fixture = true, keep = false } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  const port = await freePort();
  const dbPath = fixture ? seedFixture(work, { today }) : path.join(work, 'app.db');
  if (seed) { const db = openDb(dbPath); try { await seed(db); } finally { db.close(); } }

  const childEnv = { ...baseEnv(), ...isolationEnv(work, port), ...env };
  const child = spawn(process.execPath, ['server.js'], { cwd: REPO, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  // A server must never outlive its test run. If a suite throws before stop() is reached (a failed
  // hook, a typo), the child and its pipes would otherwise hold the runner open forever with a
  // server still listening. They are unref'd so they can't keep the runner alive on their own, and
  // the runner's exit takes the child with it.
  const killOnExit = () => { if (child.exitCode === null) child.kill(); };
  process.once('exit', killOnExit);
  child.unref();
  child.stdout.unref?.();
  child.stderr.unref?.();

  const baseURL = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`app exited (${child.exitCode}) before it was healthy:\n${log}`);
    try { if ((await fetch(baseURL + '/healthz')).status === 200) break; } catch {}
    if (Date.now() > deadline) { child.kill(); throw new Error(`app not healthy within 30s:\n${log}`); }
    await new Promise((r) => setTimeout(r, 100));
  }

  // The cookie for `email` at its CURRENT session version (applicants row, else the settings
  // fallback the app uses for admins without a row), so it survives a "sign out everywhere".
  // Connections a test opens with app.db() are tracked so stop() can close any still open: on
  // Windows an open SQLite handle locks the file and the temp directory can't be removed.
  const openConns = new Set();
  const db = () => {
    const d = openDb(dbPath);
    const close = d.close.bind(d);
    d.close = () => { openConns.delete(d); close(); };
    openConns.add(d);
    return d;
  };
  const versionOf = (email) => {
    const d = db();
    try {
      const e = String(email).toLowerCase();
      const row = d.prepare('SELECT session_ver v FROM applicants WHERE email = ?').get(e);
      if (row) return row.v || 0;
      return Number(d.prepare('SELECT value v FROM app_settings WHERE key = ?').get('sessver_' + e)?.v || 0);
    } finally { d.close(); }
  };
  const cookieFor = (email, version) => signCookie(email, version ?? versionOf(email));
  const headersFor = (as, extra = {}) => {
    const h = { ...extra };
    if (as) h.Cookie = as.startsWith('bridge_session=') ? as : cookieFor(as);
    return h;
  };

  return {
    baseURL, port, work, dbPath,
    exited,   // resolves with the exit code when the server process ends
    get log() { return log; },
    cookieFor,
    db,
    // GET without following redirects: a test asserts the 302 itself.
    get: (p, { as, headers } = {}) => fetch(baseURL + p, { redirect: 'manual', headers: headersFor(as, headers) }),
    // A form POST (urlencoded). `fetch: true` sends X-Requested-With: fetch, which gets a real 302
    // instead of the iOS client-side redirect page.
    post: (p, body = {}, { as, headers, fetch: isFetch = true } = {}) => fetch(baseURL + p, {
      method: 'POST', redirect: 'manual',
      headers: headersFor(as, { 'Content-Type': 'application/x-www-form-urlencoded', ...(isFetch ? { 'X-Requested-With': 'fetch' } : {}), ...headers }),
      body: body instanceof URLSearchParams ? body.toString() : new URLSearchParams(body).toString(),
    }),
    // Run every program's scheduler tick now (ENABLE_TEST_TICK seam), as the admin.
    tick: async () => {
      const r = await fetch(baseURL + '/admin/test/tick', { method: 'POST', redirect: 'manual', headers: headersFor(ADMIN, { 'X-Requested-With': 'fetch' }) });
      if (r.status >= 400) throw new Error(`tick failed: HTTP ${r.status}`);
      return r;
    },
    stop: async () => {
      for (const d of [...openConns]) d.close();
      process.removeListener('exit', killOnExit);
      if (child.exitCode === null) { child.kill(); await exited; }
      if (!keep) fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export function openDb(dbPath) {
  const d = new DatabaseSync(dbPath);
  d.exec('PRAGMA busy_timeout = 4000');
  return d;
}

// Decrypt a secret stored in app_settings ('enc1:' + base64(iv | tag | ciphertext), AES-256-GCM,
// key = HKDF-SHA256(SESSION_SECRET, salt 'bridge-settings-atrest', info 'settings-v1')). Written
// here from the documented format rather than imported from lib/, so a test checks what is on
// disk independently of the app's own code. Throws on anything that isn't a sealed value.
export function openSealedSetting(stored, secret = SESSION_SECRET) {
  if (typeof stored !== 'string' || !stored.startsWith('enc1:')) throw new Error(`not a sealed value: ${stored}`);
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from('bridge-settings-atrest'), Buffer.from('settings-v1'), 32));
  const buf = Buffer.from(stored.slice(5), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
