// Session versioning + revocation, security headers, /healthz, and the never-pruned key-event
// audit with its admin viewer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, SESSION_SECRET, ADMIN } from './helpers/app.mjs';

const REG = 'player01@test.local';
const mac = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
const legacyCookie = (e) => `bridge_session=${e}.${mac(e)}`;                       // pre-versioning format
const verCookie = (e, v) => `bridge_session=${e}|${v}.${mac(`${e}|${v}`)}`;        // "email|version"

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.stop(); });

const status = async (p, cookie) => (await app.get(p, { as: cookie })).status;
const keyEvent = (action, actor) => {
  const db = app.db();
  try { return !!db.prepare('SELECT 1 FROM audit_key_events WHERE action = ? AND actor = ?').get(action, actor); } finally { db.close(); }
};
const sessionVer = (email) => {
  const db = app.db();
  try { return db.prepare('SELECT session_ver v FROM applicants WHERE email = ?').get(email).v; } finally { db.close(); }
};

test('/healthz answers ok', async () => {
  const r = await app.get('/healthz');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok');
});

test('security headers on a real page', async () => {
  const h = (await app.get('/login')).headers;
  assert.equal(h.get('x-frame-options'), 'DENY');
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.match(h.get('referrer-policy') || '', /strict-origin/);
  assert.match(h.get('permissions-policy') || '', /camera=\(\)/);
  assert.equal(h.get('strict-transport-security'), null, 'no HSTS over plain http');
  assert.equal(h.get('x-powered-by'), null);
});

test('cookie formats: legacy and current-version cookies work; future or tampered versions do not', async () => {
  assert.equal(await status('/runs', legacyCookie(REG)), 200, 'legacy cookie valid while session_ver is 0');
  assert.equal(await status('/runs', verCookie(REG, 0)), 200, 'versioned cookie at the current version');
  assert.equal(await status('/runs', verCookie(REG, 3)), 302, 'a cookie minted at a future version is rejected');
  assert.equal(await status('/runs', `bridge_session=${REG}|1.${mac(`${REG}|0`)}`), 302, 'the version is inside the signature');
});

test('sign out everywhere bumps the version and kills every older cookie', async () => {
  const r = await app.post('/profile/logoutall', {}, { as: verCookie(REG, 0) });
  assert.ok(r.status === 302 || r.status === 200, `logout-all answered ${r.status}`);
  assert.equal(sessionVer(REG), 1);
  assert.equal(await status('/runs', legacyCookie(REG)), 302, 'legacy cookie is dead');
  assert.equal(await status('/runs', verCookie(REG, 0)), 302, 'old versioned cookie is dead');
  assert.equal(await status('/runs', verCookie(REG, 1)), 200, 'a cookie at the new version works');
  assert.ok(keyEvent('session:signout-all', REG), 'recorded as a key event');
});

test('an admin revocation is versioned and key-audited too', async () => {
  await app.post('/profile/logoutall', {}, { as: legacyCookie(ADMIN) });
  assert.ok(sessionVer(ADMIN) >= 1);
  assert.ok(keyEvent('session:signout-all', ADMIN));
});

test('the permanent record is admin-only, filterable, escaped and exportable', async () => {
  const nonAdmin = await app.get('/admin/audit', { as: verCookie(REG, 1) });
  assert.ok(nonAdmin.status !== 200 || !(await nonAdmin.text()).includes('Key events'), 'a member cannot open it');

  const page = await app.get('/admin/audit', { as: ADMIN });   // cookieFor reads the admin's current version
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.includes('Key events') && html.includes('Permanent record'));
  assert.ok(html.includes('session:signout-all'));

  const filtered = await (await app.get('/admin/audit?q=' + encodeURIComponent(REG), { as: ADMIN })).text();
  assert.ok(filtered.includes(REG) && filtered.includes('session:signout-all'), 'person filter');
  assert.ok((await (await app.get('/admin/audit?action=no-such-action', { as: ADMIN })).text()).includes('Nothing matches'), 'honest empty state');
  const reflected = await (await app.get('/admin/audit?q=' + encodeURIComponent('<img x>'), { as: ADMIN })).text();
  assert.ok(!reflected.includes('<img x>') && reflected.includes('&lt;img'), 'filter text is escaped');

  const csv = await (await app.get('/admin/audit.csv?q=' + encodeURIComponent(REG), { as: ADMIN })).text();
  assert.ok(csv.includes('When,Actor,Role,Action,Target') && csv.includes(REG) && csv.includes('session:signout-all'));
  assert.notEqual((await app.get('/admin/audit.csv', { as: verCookie(REG, 1) })).status, 200, 'CSV is admin-only');
});
