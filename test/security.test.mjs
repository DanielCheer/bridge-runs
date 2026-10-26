// The security and polish fixes (portfolio P3), one test block per fix. Each test is written to
// fail on the code before its fix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/app.mjs';
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
