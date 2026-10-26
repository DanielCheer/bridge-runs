// The run-day confirm flow, driven by a pinned clock (TEST_NOW) and one scheduler tick per phase:
//   • 9 AM on run day: unconfirmed floor players get the confirm ping; nobody is removed yet;
//   • at the cutoff: unconfirmed floor players are removed and the next in line gets the spot
//     (an offer on basketball's offer-window model, an immediate slide on pickleball's simple one);
//     confirmed players and guests are never swept;
//   • moving a run date re-arms both the ping and the sweep for the new day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN } from './helpers/app.mjs';
import { runDayApp, CONFIRMED as CONF, UNCONFIRMED as UNCONF, WAITER, GUEST } from './helpers/run-day.mjs';
import { shiftDays } from '../fixtures/world.mjs';

// One phase = a fresh run-day app at `time`, then one scheduler tick.
async function phase(t, opts) {
  const night = await runDayApp(t, opts);
  assert.equal((await night.app.tick()).status, 200);
  return night;
}

test('9 AM on run day: the confirm ping goes out and nobody is removed', async (t) => {
  const { row, one } = await phase(t, { pid: 1, time: '09:05:00' });
  assert.ok(one("SELECT 1 x FROM audit_log WHERE action = 'confirm:autoping'"), 'ping audited');
  assert.ok(row(UNCONF), 'the unconfirmed player is still on the roster');
  assert.equal(one("SELECT 1 x FROM audit_log WHERE action LIKE '%confirm:sweep%' OR action LIKE '%confirmsweep%'"), undefined, 'no sweep yet');
});

test('basketball cutoff: unconfirmed removed, the spot offered, confirmed and guest kept', async (t) => {
  const { row, one } = await phase(t, { pid: 1, time: '19:05:00' });
  assert.equal(row(UNCONF), undefined, 'unconfirmed floor player removed');
  assert.ok(row(CONF), 'confirmed player kept');
  assert.ok(row(GUEST), 'guest kept (no account to confirm from)');
  assert.notEqual(row(WAITER)?.offered_at ?? null, null, 'the freed spot is offered to the top waitlister');
  assert.ok(one("SELECT 1 x FROM audit_log WHERE action = 'confirm:sweep'"), 'sweep audited');
  assert.equal(one('SELECT COUNT(*) n FROM push_subscriptions').n, 0, 'nothing real can be notified');
});

test('pickleball cutoff: both unconfirmed swept, no offer holds; a date move re-arms ping and sweep', async (t) => {
  const { app, rd, row, one, setting } = await phase(t, { pid: 2, time: '16:35:00' });
  assert.equal(row(UNCONF), undefined);
  assert.equal(row(WAITER), undefined, "pickleball's big floor put the third player on it too, so they are swept");
  assert.ok(row(CONF));
  assert.equal(one("SELECT target FROM audit_log WHERE action = 'pk:confirmsweep'")?.target, '2', 'sweep audited with its count');
  assert.equal(one('SELECT COUNT(*) n FROM checkins WHERE program_id = 2 AND offered_at IS NOT NULL').n, 0, 'simple model: no offers');

  assert.equal(setting('pk_confirmsweep_done'), rd, 'precondition: the sweep marker is set for the old date');
  const moved = shiftDays(rd, 2);   // Tuesday -> Thursday (rain-out)
  await app.post('/pickleball/date', { date: moved }, { as: ADMIN });
  assert.equal(setting('pk_run_date'), moved, 'date move applied');
  assert.equal(setting('pk_confirmsweep_done'), undefined, 'the move re-arms the sweep');
  assert.equal(setting('pk_autoping_done'), undefined, 'and the ping, so no sweep can run unpinged');
});
