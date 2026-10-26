// Crawl smoke: every page x every kind of viewer answers without a server error.
//
// The same page list and viewer states as the private golden-master crawler, on the synthetic
// world, with a live night on basketball and pickleball so the run pages render real rosters.
// This does not compare HTML (the golden master does that against real data, privately); it
// catches the crash class: a page that throws for one role or state.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/app.mjs';
import { PERSONAS, PLAYERS, MINOR, runDateFor, shiftDays, ymd } from '../fixtures/world.mjs';

let app, memberId;
before(async () => {
  const today = ymd(new Date());
  app = await startApp({
    seed: (db) => {
      // This week's basketball and pickleball nights: open, part of the floor checked in, a guest.
      // Seeded for the following week too: on the run day itself, once the run has ended, the app
      // has already rolled to next week, and the crawl should still see a live night.
      const ins = db.prepare('INSERT INTO checkins (run_date, email, name, program_id, sort_order, confirmed_at) VALUES (?,?,?,?,?,?)');
      const open = db.prepare('INSERT INTO run_state (run_date, program_id, is_open, cancelled) VALUES (?,?,1,0)');
      const name = (e) => db.prepare('SELECT full_name n FROM applicants WHERE email = ?').get(e).n;
      for (const week of [0, 7]) {
        const bb = shiftDays(runDateFor(1, today), week), pk = shiftDays(runDateFor(2, today), week);
        PLAYERS.slice(0, 6).forEach((e, i) => ins.run(bb, e, name(e), 1, i, i < 3 ? `${bb} 09:00:00` : null));
        ins.run(bb, 'friend@guest.local', 'Friend (guest)', 1, 6, null);
        open.run(bb, 1);
        PLAYERS.slice(0, 3).forEach((e, i) => ins.run(pk, e, name(e), 2, i, null));
        open.run(pk, 2);
      }
    },
  });
  const db = app.db();
  memberId = db.prepare('SELECT id FROM applicants WHERE email = ?').get(PLAYERS[0]).id;
  db.close();
});
after(async () => { await app?.stop(); });

const VIEWERS = [
  ['logged out', null],
  ['admin', PERSONAS.admin],
  ['team', PERSONAS.team],
  ['core', PERSONAS.core],
  ['council', PERSONAS.council],
  ['player', PLAYERS[0]],
  ['minor', MINOR],
  ['pending', PERSONAS.pending],
  ['rejected', PERSONAS.rejected],
  ['suspended', PERSONAS.suspended],
  ['signed cookie, no account', 'nobody@test.local'],
];

const pages = () => [
  '/', '/login', '/status', '/waiver', '/runs', '/checkin', '/chat', '/chat/locked',
  '/pickleball', '/pickleball/chat', '/volleyball', '/profile', '/season', '/pickleball/season',
  '/pickleball/banner', '/volleyball/season', '/volleyball/banner', '/volleyball/chat',
  '/messages', '/friends', '/admin', '/admin/people', '/admin/share', '/admin/export',
  `/u/${memberId}`, `/u/${memberId}/card`,
  '/poll?page=checkin', '/poll?page=pickleball', '/poll?page=chat', '/poll?page=pkchat',
  '/poll?page=volleyball', '/poll?page=vbchat',
  '/privacy', '/terms', '/conduct', '/waiver-qr.svg', '/healthz',
];

for (const [label, email] of VIEWERS) {
  test(`no page errors for: ${label}`, async () => {
    const errors = [];
    for (const p of pages()) {
      const r = await app.get(p, { as: email });
      await r.arrayBuffer();
      if (r.status >= 500) errors.push(`${p} -> ${r.status}`);
    }
    assert.deepEqual(errors, []);
  });
}

test('the crawl reached real pages, not just redirects', async () => {
  const r = await app.get('/checkin', { as: PLAYERS[0] });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('Casey Brooks'), 'tonight\'s roster renders on the check-in page');
  const admin = await app.get('/admin', { as: PERSONAS.admin });
  assert.equal(admin.status, 200);
  assert.ok((await admin.text()).includes('Pat Pending'), 'the pending applicant is on the review page');
});

test('the server logged no route errors during the crawl', () => {
  assert.doesNotMatch(app.log, /\[route-error\]|\[terminal\]|Unhandled/i);
});
