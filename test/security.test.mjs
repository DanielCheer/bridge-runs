// The security and polish fixes (portfolio P3), one test block per fix. Each test is written to
// fail on the code before its fix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { startApp, ADMIN, openSealedSetting } from './helpers/app.mjs';
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
