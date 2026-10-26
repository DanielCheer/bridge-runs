// The security and polish fixes (portfolio P3), one test block per fix. Each test is written to
// fail on the code before its fix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import webpush from 'web-push';
import sharp from 'sharp';
import { startApp, ADMIN, REPO, openDb, openSealedSetting } from './helpers/app.mjs';
import { PERSONAS } from '../fixtures/world.mjs';

let app, db;
before(async () => { app = await startApp(); db = app.db(); });
after(async () => { await app?.stop(); });

const one = (sql, ...a) => db.prepare(sql).get(...a);

// ---------- /apply never rewrites an existing applicant ----------
test('/apply never overwrites an existing pending or rejected row', async () => {
  for (const email of [PERSONAS.pending, PERSONAS.rejected]) {
    const before = one('SELECT full_name, phone, dob, experience FROM applicants WHERE email = ?', email);
    const r = await app.post('/apply', {
      full_name: 'Someone Else', phone: '999-999-9999', email, dob: '1990-01-01',
      levels: 'High school', waiver_ok: '1',
    });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /already applied/i, 'the page says this email already applied');
    assert.match(html, /action="\/apply"/, 'the intake form is re-rendered');
    const after = one('SELECT full_name, phone, dob, experience FROM applicants WHERE email = ?', email);
    assert.deepEqual(after, before, `${email}: the row is untouched`);
  }
});

test('/apply still creates a brand-new applicant', async () => {
  const r = await app.post('/apply', {
    full_name: 'New Person', phone: '000-000-0000', email: 'brandnew@test.local', dob: '1995-05-05',
    levels: 'High school', waiver_ok: '1',
  });
  assert.match(await r.text(), /Application received/);
  assert.equal(one('SELECT status FROM applicants WHERE email = ?', 'brandnew@test.local')?.status, 'pending');
});

// ---------- join refusals say why (?joinerr=) ----------
const loc = (r) => r.headers.get('location');
test('basketball join refusals redirect with a reason the page explains', async () => {
  assert.equal(loc(await app.post('/checkin/join', {}, { as: PERSONAS.suspended })), '/checkin?joinerr=suspended');
  assert.equal(loc(await app.post('/checkin/join', {}, { as: PERSONAS.pending })), '/checkin?joinerr=notapproved');
  await app.post('/admin/run/cancel', { on: '1' }, { as: ADMIN });
  try {
    assert.equal(loc(await app.post('/checkin/join', {}, { as: 'player01@test.local' })), '/checkin?joinerr=cancelled');
    const html = await (await app.get('/checkin?joinerr=cancelled', { as: 'player01@test.local' })).text();
    assert.match(html, /This week's run is cancelled, so check-in is off\./);
  } finally {
    await app.post('/admin/run/cancel', { on: '0' }, { as: ADMIN });
  }
  const plain = await (await app.get('/checkin?joinerr=%3Cb%3Ex', { as: 'player01@test.local' })).text();
  assert.ok(!plain.includes('<b>x') && !plain.includes('&lt;b&gt;x'), 'an unknown code renders nothing');
});

test('generic run join refusals redirect with a reason the page explains', async () => {
  await app.post('/pickleball/cancel', { on: '1' }, { as: ADMIN });
  try {
    assert.equal(loc(await app.post('/pickleball/join', {}, { as: 'player01@test.local' })), '/pickleball?joinerr=cancelled');
    const html = await (await app.get('/pickleball?joinerr=cancelled', { as: 'player01@test.local' })).text();
    assert.match(html, /This week's run is cancelled, so check-in is off\./);
  } finally {
    await app.post('/pickleball/cancel', { on: '0' }, { as: ADMIN });
  }
});

// ---------- secrets in app_settings are sealed at rest ----------
const rawSetting = (k) => one('SELECT value v FROM app_settings WHERE key = ?', k)?.v;
test('the VAPID private key the app generates is stored sealed; the public key is not', async () => {
  assert.match(rawSetting('vapid_private'), /^enc1:/);
  assert.match(openSealedSetting(rawSetting('vapid_private')), /^[A-Za-z0-9_-]{40,}$/);
  const { key } = await (await app.get('/push/key', { as: 'player01@test.local' })).json();
  assert.equal(key, rawSetting('vapid_public'));
});

test('the webhook secret is sealed, and the webhook still verifies with it', async () => {
  await app.post('/admin/pco/webhook', { webhook_secret: 'hook-secret-1' }, { as: ADMIN });
  assert.match(rawSetting('pco_webhook_secret'), /^enc1:/);
  assert.equal(openSealedSetting(rawSetting('pco_webhook_secret')), 'hook-secret-1');
  const body = JSON.stringify({ data: [] });
  const send = (sec) => fetch(app.baseURL + '/pco/webhook', { method: 'POST', body, headers: {
    'Content-Type': 'application/json', 'X-PCO-Webhooks-Authenticity': crypto.createHmac('sha256', sec).update(body).digest('hex') } });
  assert.equal((await send('hook-secret-1')).status, 200, 'signed with the stored secret: accepted');
  assert.equal((await send('wrong')).status, 401, 'signed with anything else: refused');
});

test('a legacy plaintext secret is read through and rewritten sealed', async () => {
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('pco_webhook_secret', 'legacy-plain')").run();
  assert.match(await (await app.get('/admin/pco', { as: ADMIN })).text(), /Webhook/);   // the console reads it
  assert.match(rawSetting('pco_webhook_secret'), /^enc1:/);
  assert.equal(openSealedSetting(rawSetting('pco_webhook_secret')), 'legacy-plain');
  db.prepare("DELETE FROM app_settings WHERE key = 'pco_webhook_secret'").run();
});

test('a legacy plaintext VAPID keypair is kept (not regenerated) and sealed at boot', async () => {
  const kp = webpush.generateVAPIDKeys();
  const legacy = await startApp({ seed: (d) => {
    const put = d.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
    put.run('vapid_public', kp.publicKey); put.run('vapid_private', kp.privateKey);
  } });
  try {
    const d = legacy.db();
    try {
      const get = (k) => d.prepare('SELECT value v FROM app_settings WHERE key = ?').get(k)?.v;
      assert.equal(get('vapid_public'), kp.publicKey);
      assert.match(get('vapid_private'), /^enc1:/);
      assert.equal(openSealedSetting(get('vapid_private')), kp.privateKey);
    } finally { d.close(); }
  } finally { await legacy.stop(); }
});

// ---------- /admin/export/db is encrypted ----------
test('the database download is the encrypted backup container, and it restores', async () => {
  const r = await app.get('/admin/export/db', { as: ADMIN });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') || '', /filename="bridge-backup-\d{4}-\d{2}-\d{2}\.db\.enc"/);
  const body = Buffer.from(await r.arrayBuffer());
  assert.equal(body.subarray(0, 6).toString(), 'BRENC1', 'starts with the backup magic header');
  assert.ok(!body.includes(Buffer.from('SQLite format 3')), 'no plaintext SQLite inside');
  const enc = path.join(app.work, 'export.db.enc'), out = path.join(app.work, 'export-restored.db');
  fs.writeFileSync(enc, body);
  const res = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'restore-backup.mjs'), enc, out, path.join(app.work, 'backup.key')], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const restored = openDb(out);
  try {
    assert.equal(restored.prepare('SELECT COUNT(*) n FROM applicants').get().n, one('SELECT COUNT(*) n FROM applicants').n);
  } finally { restored.close(); }
  assert.deepEqual(fs.readdirSync(path.join(app.work, 'backups')).filter((f) => f.startsWith('export-')), [], 'no temp file left behind');
});

// ---------- /chat-media needs a signed-in user; upload names carry 128 random bits ----------
test('/chat-media answers 403 signed out and serves the file signed in', async () => {
  fs.writeFileSync(path.join(app.work, 'media', '1-probe.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal((await app.get('/chat-media/1-probe.jpg')).status, 403);
  const r = await app.get('/chat-media/1-probe.jpg', { as: 'player01@test.local' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control') || '', /^private\b/);
});

test('/avatars stays public (the kiosk renders avatars without a cookie)', async () => {
  fs.writeFileSync(path.join(app.work, 'avatars', '1-probe.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal((await app.get('/avatars/1-probe.jpg')).status, 200);
});

const tinyJpeg = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#E4611F' } }).jpeg().toBuffer();
const upload = async (p, field, as) => {
  const form = new FormData();
  form.set(field, new Blob([await tinyJpeg()], { type: 'image/jpeg' }), 'x.jpg');
  return fetch(app.baseURL + p, { method: 'POST', redirect: 'manual', body: form, headers: { Cookie: app.cookieFor(as), 'X-Requested-With': 'fetch' } });
};
test('new chat photos and avatars are named <id>-<32 hex>', async () => {
  const who = 'player02@test.local';
  await upload('/profile/photo', 'photo', who);
  assert.match(one('SELECT avatar FROM applicants WHERE email = ?', who).avatar, /^\d+-[0-9a-f]{32}\.jpg$/);
  await upload('/pickleball/chat', 'image', who);
  const img = one("SELECT image FROM group_messages WHERE from_email = ? AND image LIKE '/chat-media/%' ORDER BY id DESC", who)?.image;
  assert.match(img || '', /^\/chat-media\/\d+-[0-9a-f]{32}\.jpg$/);
});

// ---------- Content-Security-Policy (the subset that holds without a nonce refactor) ----------
test('every response carries the CSP subset', async () => {
  const want = "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
  for (const p of ['/login', '/', '/healthz', '/styles.css']) {
    assert.equal((await app.get(p)).headers.get('content-security-policy'), want, p);
  }
  assert.equal((await app.get('/runs', { as: 'player01@test.local' })).headers.get('content-security-policy'), want);
});

// ---------- backup failures alert the admins and show on /admin ----------
const waitFor = async (fn, what, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn(); if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const settingIn = (d, k) => d.prepare('SELECT value v FROM app_settings WHERE key = ?').get(k)?.v;

test('a backup directory that is a file: the app boots, records the error, and /admin says so', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-bkfile-'));
  const file = path.join(work, 'not-a-dir');
  fs.writeFileSync(file, 'x');
  const bad = await startApp({ env: { BACKUP_DIR: file } });
  try {
    const d = bad.db();
    try {
      await waitFor(() => settingIn(d, 'last_backup_error'), 'last_backup_error');
      assert.equal(settingIn(d, 'last_backup_at'), undefined);
      assert.ok(d.prepare("SELECT 1 FROM audit_log WHERE action = 'backup:failed'").get(), 'the failure is audited');
    } finally { d.close(); }
    const html = await (await bad.get('/admin', { as: ADMIN })).text();
    assert.match(html, /Database backups are failing\./);
    assert.match(html, /Last good backup: never/);
  } finally { await bad.stop(); fs.rmSync(work, { recursive: true, force: true }); }
});

test('a backup that starts failing mid-run pushes the admins once; the next success clears it', async () => {
  const live = await startApp({ env: { BACKUP_EVERY_HOURS: String(1 / 3600) } });   // a snapshot every second
  const d = live.db();
  try {
    await waitFor(() => settingIn(d, 'last_backup_at'), 'the boot snapshot');
    assert.match(await (await live.get('/admin', { as: ADMIN })).text(), /Last database backup: <b>Today<\/b>/);
    assert.doesNotMatch(await (await live.get('/admin', { as: 'team@test.local' })).text(), /Last database backup/, 'admins only');
    // An admin device (added after boot: the guard refuses subscriptions in a fixture). The push
    // itself can't be delivered here; sendPush records push_send with its tag before it sends.
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    d.prepare('INSERT INTO push_subscriptions (email, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)')
      .run(ADMIN, 'https://127.0.0.1:9/backup-test', ecdh.getPublicKey().toString('base64url'), crypto.randomBytes(16).toString('base64url'));
    const dir = path.join(live.work, 'backups');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.writeFileSync(dir, 'now a file');
    await waitFor(() => settingIn(d, 'last_backup_error'), 'the failure to be recorded');
    await new Promise((r) => setTimeout(r, 2500));   // two more failing runs
    const pushes = d.prepare("SELECT COUNT(*) n FROM metrics_events WHERE kind = 'push_send' AND meta = 'backupfail'").get().n;
    assert.equal(pushes, 1, 'pushed once, on the transition, not on every failing run');
    assert.match(await (await live.get('/admin', { as: ADMIN })).text(), /Database backups are failing\..*Last good backup: Today/s);
    fs.rmSync(dir, { force: true });
    fs.mkdirSync(dir);
    await waitFor(() => !settingIn(d, 'last_backup_error'), 'the next success to clear the error');
    assert.doesNotMatch(await (await live.get('/admin', { as: ADMIN })).text(), /backups are failing/);
  } finally {
    d.prepare('DELETE FROM push_subscriptions').run();
    d.close();
    await live.stop();
  }
});

// ---------- policy pages are rendered once, at boot ----------
test('policy pages come from LEGAL_DIR, rendered at boot, not re-read per request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-legal-'));
  for (const f of fs.readdirSync(path.join(REPO, 'legal'))) {
    fs.copyFileSync(path.join(REPO, 'legal', f), path.join(dir, f));
  }
  fs.appendFileSync(path.join(dir, 'privacy-policy.md'), '\n\nBoot marker 4f1c.\n');
  const legal = await startApp({ env: { LEGAL_DIR: dir } });
  try {
    const first = await (await legal.get('/privacy')).text();
    assert.match(first, /Boot marker 4f1c\./, 'served from LEGAL_DIR');
    fs.writeFileSync(path.join(dir, 'privacy-policy.md'), 'Changed after boot.');
    fs.rmSync(path.join(dir, 'terms-of-use.md'));
    assert.equal(await (await legal.get('/privacy')).text(), first, 'an edit after boot is not picked up');
    assert.equal((await legal.get('/terms')).status, 200, 'a file removed after boot still serves the cached page');
  } finally { await legal.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- req.ip under TRUST_PROXY keys the per-IP rate limits ----------
// /apply allows 8 submissions per client address per 10 minutes, checked before anything else.
const applyFrom = (a, xff) => a.post('/apply', {}, { headers: { 'X-Forwarded-For': xff } });
const limited = async (r) => /Too many submissions/.test(await r.text());

test('one trusted hop (default): the key is the last X-Forwarded-For entry, so a spoofed first entry does not rotate it', async () => {
  for (let i = 0; i < 8; i++) assert.ok(!(await limited(await applyFrom(app, `10.0.0.${i}, 203.0.113.7`))), `request ${i + 1} allowed`);
  assert.ok(await limited(await applyFrom(app, '10.9.9.9, 203.0.113.7')), 'the 9th from the same proxy-seen address is limited');
  assert.ok(!(await limited(await applyFrom(app, '10.0.0.1, 203.0.113.8'))), 'a different client address has its own bucket');
});

test('TRUST_PROXY=2: the key is the entry the outer of two trusted hops saw', async () => {
  const two = await startApp({ env: { TRUST_PROXY: '2' } });
  try {
    for (let i = 0; i < 8; i++) assert.ok(!(await limited(await applyFrom(two, `198.51.100.1, 203.0.113.${i}`))), `request ${i + 1} allowed`);
    assert.ok(await limited(await applyFrom(two, '198.51.100.1, 203.0.113.99')), 'same client behind any edge: limited');
    assert.ok(!(await limited(await applyFrom(two, '198.51.100.2, 203.0.113.0'))), 'another client through the same edge: its own bucket');
  } finally { await two.stop(); }
});

// ---------- accessibility: zoom allowed, a real keyboard focus ring ----------
test('pages allow pinch-zoom and the stylesheet has a global focus-visible ring', async () => {
  for (const p of ['/', '/login']) {
    const html = await (await app.get(p)).text();
    const vp = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] || '';
    assert.ok(vp.includes('width=device-width'), p);
    assert.ok(!/user-scalable=no|maximum-scale=1\b/.test(vp), `${p}: zoom is not disabled (${vp})`);
  }
  const css = await (await app.get('/styles.css')).text();
  assert.match(css, /(^|\n):focus-visible\{outline:3px solid var\(--orange-deep\);outline-offset:2px\}/);
  assert.match(css, /input,textarea,select\{font-size:16px\}/, 'the 16px field floor that prevents iOS focus zoom stays');
});

// ---------- no hand-seeded avatar ----------
test('AVATAR_SEED_EMAIL is gone: a player without an uploaded photo shows initials', async () => {
  const seeded = await startApp({ env: { AVATAR_SEED_EMAIL: 'player05@test.local' } });
  try {
    const d = seeded.db();
    let id; try { id = d.prepare('SELECT id FROM applicants WHERE email = ?').get('player05@test.local').id; } finally { d.close(); }
    const html = await (await seeded.get('/u/' + id, { as: 'player01@test.local' })).text();
    assert.ok(!html.includes('daniel.jpg'), 'no special-cased photo');
  } finally { await seeded.stop(); }
});
