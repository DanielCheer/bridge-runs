// test/helpers/run-day.mjs — a run night on its own app, with the clock pinned, for the suites
// about what the scheduler does on run day (confirm ping, cutoff sweep, door mode).
import { startApp, ADMIN } from './app.mjs';
import { PLAYERS, runDateFor, ymd } from '../../fixtures/world.mjs';

export const [CONFIRMED, UNCONFIRMED, WAITER] = PLAYERS;
export const GUEST = 'someone@guest.local';

// A fresh app with TEST_NOW pinned at `time` on program `pid`'s run date, and that night's roster:
// a confirmed and an unconfirmed floor player and a waitlister (+ a guest on basketball), check-in
// open, nobody auto-seating. Basketball's floor is shrunk to 3 so the waitlister really waits.
// Registers its own teardown on the node:test context `t`.
export async function runDayApp(t, { pid, time }) {
  const rd = runDateFor(pid, ymd(new Date()));
  const app = await startApp({
    env: { TEST_NOW: `${rd}T${time}` },
    seed: (db) => {
      db.prepare('UPDATE applicants SET is_team = 0, auto_renew = 0').run();
      db.prepare('UPDATE program_membership SET auto_renew = 0').run();
      const ins = db.prepare('INSERT INTO checkins (run_date, email, name, program_id, sort_order, confirmed_at) VALUES (?,?,?,?,?,?)');
      ins.run(rd, CONFIRMED, 'Conf Yes', pid, 0, `${rd} 08:00:00`);
      ins.run(rd, UNCONFIRMED, 'Conf No', pid, 1, null);
      if (pid === 1) ins.run(rd, GUEST, 'Guesty (guest)', pid, 2, null);
      ins.run(rd, WAITER, 'Conf Wait', pid, 99, null);
      db.prepare('INSERT OR REPLACE INTO run_state (run_date, program_id, is_open, cancelled) VALUES (?,?,1,0)').run(rd, pid);
      if (pid === 2) db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('pk_run_date', ?)").run(rd);
    },
  });
  t.after(() => app.stop());
  if (pid === 1) await app.post('/admin/settings', { run_cap: '3', waitlist_cap: '5', prereg_cap: '0' }, { as: ADMIN });
  const db = app.db();   // closed by app.stop()
  return {
    app, db, rd,
    row: (email) => db.prepare('SELECT email, confirmed_at, offered_at FROM checkins WHERE program_id = ? AND run_date = ? AND email = ?').get(pid, rd, email),
    one: (sql, ...a) => db.prepare(sql).get(...a),
    setting: (k) => db.prepare('SELECT value v FROM app_settings WHERE key = ?').get(k)?.v,
  };
}
