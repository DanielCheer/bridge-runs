// Door mode: when the organization's Check-Ins station is the attendance of record, the in-app
// confirm machinery is off. In every phase: door mode ON -> tick -> the ping/sweep must not fire and
// the "I'm coming" UI is gone; then door mode OFF -> tick -> it fires normally in the same boot (a
// live toggle, no restart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDayApp, CONFIRMED, UNCONFIRMED, GUEST } from './helpers/run-day.mjs';

async function doorNight(t, opts) {
  const night = await runDayApp(t, opts);
  const door = (on) => night.db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('pco_door_mode', ?)").run(on ? '1' : '0');
  const onFloor = (email) => !!night.db.prepare('SELECT 1 x FROM checkins WHERE program_id = ? AND run_date = ? AND email = ?').get(opts.pid, night.rd, email);
  const page = async (p) => (await night.app.get(p, { as: UNCONFIRMED })).text();
  return { ...night, door, onFloor, page };
}

test('9 AM: door mode suppresses the confirm ping; turning it off lets it fire', async (t) => {
  const { app, rd, setting, door, onFloor } = await doorNight(t, { pid: 1, time: '09:05:00' });
  door(true); await app.tick();
  assert.notEqual(setting('autoping_done'), rd, 'door on: no ping');
  door(false); await app.tick();
  assert.equal(setting('autoping_done'), rd, 'door off: the ping fires the same day');
  assert.ok(onFloor(UNCONFIRMED) && onFloor(CONFIRMED), 'nobody removed either way');
});

test('basketball cutoff: door mode hides the CTA and keeps everyone; off, the sweep runs', async (t) => {
  const { app, rd, setting, door, onFloor, page } = await doorNight(t, { pid: 1, time: '19:05:00' });
  door(true);
  const on = await page('/checkin');
  assert.ok(!on.includes("I'm coming") && !on.includes('Confirm by'), 'no confirm CTA');
  await app.tick();
  assert.notEqual(setting('confirmsweep_done'), rd, 'no sweep');
  assert.ok(onFloor(UNCONFIRMED), 'the unconfirmed player stays');
  door(false);
  const off = await page('/checkin');
  assert.ok(off.includes("I'm coming") || off.includes('You didn’t confirm') || off.includes('Confirm by'), 'the CTA is back');
  await app.tick();
  assert.equal(setting('confirmsweep_done'), rd, 'the sweep fires');
  assert.ok(!onFloor(UNCONFIRMED), 'unconfirmed released');
  assert.ok(onFloor(CONFIRMED), 'confirmed untouched');
  assert.ok(onFloor(GUEST), 'guest exempt');
});

test('pickleball cutoff (the generic engine): same contract', async (t) => {
  const { app, rd, setting, door, onFloor, page } = await doorNight(t, { pid: 2, time: '16:35:00' });
  door(true);
  assert.ok(!(await page('/pickleball')).includes("I'm coming"), 'no confirm CTA');
  await app.tick();
  assert.notEqual(setting('pk_confirmsweep_done'), rd, 'no sweep');
  assert.ok(onFloor(UNCONFIRMED), 'the unconfirmed player stays');
  door(false); await app.tick();
  assert.equal(setting('pk_confirmsweep_done'), rd, 'the sweep fires');
  assert.ok(!onFloor(UNCONFIRMED), 'unconfirmed released');
  assert.ok(onFloor(CONFIRMED), 'confirmed untouched');
});
