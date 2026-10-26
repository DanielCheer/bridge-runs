// The runs hub's personal status badge ("Waitlisted · #N of M" / "You're in") and the same
// position on the run page; confirm is a toggle; guest priority -- a waitlisted guest takes a freed
// floor spot ahead of the waitlist, seated at once, with no offer to the real waitlister.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN } from './helpers/app.mjs';
import { PLAYERS } from '../fixtures/world.mjs';

const FILLER = PLAYERS[0], SUBJECT = PLAYERS[1];
let app, db, rd;
before(async () => {
  // Nobody auto-seats, so the floor holds exactly who the suite puts there.
  app = await startApp({ seed: (d) => d.prepare('UPDATE applicants SET is_team = 0, auto_renew = 0').run() });
  db = app.db();
  await app.post('/admin/settings', { run_cap: '1', waitlist_cap: '5', prereg_cap: '0' }, { as: ADMIN });   // a 1-seat floor
  rd = String((await (await app.get('/poll?page=checkin', { as: ADMIN })).json()).f).split(':')[0];
  db.prepare('DELETE FROM checkins WHERE program_id = 1 AND run_date = ?').run(rd);
  db.prepare('INSERT INTO checkins (run_date, email, name, program_id, sort_order) VALUES (?,?,?,1,0)').run(rd, FILLER, 'Filler F');
  db.prepare('INSERT INTO checkins (run_date, email, name, program_id, sort_order) VALUES (?,?,?,1,1)').run(rd, SUBJECT, 'Subject S');
  db.prepare('INSERT OR REPLACE INTO run_state (run_date, program_id, is_open, cancelled) VALUES (?,1,1,0)').run(rd);
});
after(async () => { await app?.stop(); });

const page = async (p, as) => (await app.get(p, { as })).text();

test('hub and run page show each viewer their own status', async () => {
  assert.ok((await page('/runs', SUBJECT)).includes('Waitlisted · #1 of 1'));
  assert.ok((await page('/runs', FILLER)).includes("You're in"));
  assert.ok((await page('/checkin', SUBJECT)).includes('#1 of 1'));
});

test('confirm is a toggle', async () => {
  const confirmedAt = () => db.prepare('SELECT confirmed_at c FROM checkins WHERE program_id = 1 AND run_date = ? AND email = ?').get(rd, FILLER)?.c;
  await app.post('/checkin/confirm', {}, { as: FILLER });
  assert.ok(confirmedAt(), 'confirmed');
  await app.post('/checkin/confirm', { un: '1' }, { as: FILLER });
  assert.equal(confirmedAt(), null, 'undone');
  assert.ok((await page('/checkin', FILLER)).includes("I'm coming"), 'the button is back');
});

test('guest priority: a waitlisted guest takes the freed spot; the waitlister gets no offer', async () => {
  await app.post('/checkin/guest', { name: 'Walkin Wally' }, { as: ADMIN });
  const guest = () => db.prepare("SELECT sort_order FROM checkins WHERE run_date = ? AND program_id = 1 AND email LIKE '%@guest.local'").get(rd);
  assert.ok(guest(), 'the guest joined the waitlist');
  await app.post('/checkin/remove', { email: FILLER }, { as: ADMIN });
  const top = db.prepare('SELECT MIN(sort_order) m FROM checkins WHERE run_date = ? AND program_id = 1').get(rd).m;
  assert.equal(guest().sort_order, top, 'the guest floated onto the 1-seat floor');
  assert.equal(db.prepare('SELECT offered_at FROM checkins WHERE run_date = ? AND program_id = 1 AND email = ?').get(rd, SUBJECT).offered_at, null);
  assert.ok(db.prepare("SELECT 1 x FROM audit_log WHERE action LIKE '%guest-priority-seat%'").get(), 'audited');
});
