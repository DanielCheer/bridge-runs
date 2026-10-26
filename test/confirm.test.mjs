// The run-day confirm flow, driven by a pinned clock (TEST_NOW) and one scheduler tick per phase:
//   • 9 AM on run day: unconfirmed floor players get the confirm ping; nobody is removed yet;
//   • at the cutoff: unconfirmed floor players are removed and the next in line gets the spot
//     (an offer on basketball's offer-window model, an immediate slide on pickleball's simple one);
//     confirmed players and guests are never swept;
//   • moving a run date re-arms both the ping and the sweep for the new day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN } from './helpers/app.mjs';
import { PLAYERS, runDateFor, shiftDays, ymd } from '../fixtures/world.mjs';

const [CONF, UNCONF, WAITER] = PLAYERS;
const GUEST = 'someone@guest.local';

// One phase = a fresh app with the clock pinned at `at` on the program's run date, a roster of a
// confirmed + an unconfirmed floor player and a waitlister (+ a guest on basketball), check-in open,
// nobody auto-seating. Basketball's floor is shrunk to 3 so the waitlister really waits.
async function phase(t, { pid, time }) {
  const rd = runDateFor(pid, ymd(new Date()));
  const app = await startApp({
    env: { TEST_NOW: `${rd}T${time}` },
    seed: (db) => {
      db.prepare('UPDATE applicants SET is_team = 0, auto_renew = 0').run();
      db.prepare('UPDATE program_membership SET auto_renew = 0').run();
      const ins = db.prepare('INSERT INTO checkins (run_date, email, name, program_id, sort_order, confirmed_at) VALUES (?,?,?,?,?,?)');
      ins.run(rd, CONF, 'Conf Yes', pid, 0, `${rd} 08:00:00`);
      ins.run(rd, UNCONF, 'Conf No', pid, 1, null);
      if (pid === 1) ins.run(rd, GUEST, 'Guesty (guest)', pid, 2, null);
      ins.run(rd, WAITER, 'Conf Wait', pid, 99, null);
      db.prepare('INSERT OR REPLACE INTO run_state (run_date, program_id, is_open, cancelled) VALUES (?,?,1,0)').run(rd, pid);
      if (pid === 2) db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('pk_run_date', ?)").run(rd);
    },
  });
  t.after(() => app.stop());
  if (pid === 1) await app.post('/admin/settings', { run_cap: '3', waitlist_cap: '5', prereg_cap: '0' }, { as: ADMIN });
  const db = app.db();   // closed by app.stop()
  const tick = await app.tick();
  assert.equal(tick.status, 200);
  const row = (em) => db.prepare('SELECT email, confirmed_at, offered_at FROM checkins WHERE program_id = ? AND run_date = ? AND email = ?').get(pid, rd, em);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  return { app, db, rd, row, one };
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
  const { app, rd, row, one } = await phase(t, { pid: 2, time: '16:35:00' });
  assert.equal(row(UNCONF), undefined);
  assert.equal(row(WAITER), undefined, "pickleball's big floor put the third player on it too, so they are swept");
  assert.ok(row(CONF));
  assert.equal(one("SELECT target FROM audit_log WHERE action = 'pk:confirmsweep'")?.target, '2', 'sweep audited with its count');
  assert.equal(one('SELECT COUNT(*) n FROM checkins WHERE program_id = 2 AND offered_at IS NOT NULL').n, 0, 'simple model: no offers');

  const setting = (k) => one('SELECT value v FROM app_settings WHERE key = ?', k)?.v;
  assert.equal(setting('pk_confirmsweep_done'), rd, 'precondition: the sweep marker is set for the old date');
  const moved = shiftDays(rd, 2);   // Tuesday -> Thursday (rain-out)
  await app.post('/pickleball/date', { date: moved }, { as: ADMIN });
  assert.equal(setting('pk_run_date'), moved, 'date move applied');
  assert.equal(setting('pk_confirmsweep_done'), undefined, 'the move re-arms the sweep');
  assert.equal(setting('pk_autoping_done'), undefined, 'and the ping, so no sweep can run unpinged');
});
