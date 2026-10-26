// The auto-renew no-show penalty (volleyball: 3 consecutive auto-seated, never-confirmed no-shows
// pause auto-renew for 2 weeks). Three phases, each a fresh app:
//   • doorON  — a finished run archives under door mode: the assess marker is consumed, zero strikes;
//   • assess  — the full subject matrix: fresh ghost, third ghost (pause), a show (streak reset),
//               a manual check-in, a guest, a waitlisted ghost; once only;
//   • seat    — autoopen under a pinned clock seats normal and expired-pause renewers, skips an
//               active pause, lifts the expired one; only an operator can clear a penalty.
// The run nights are seeded AFTER boot, as the private suite did, so the assess runs on the tick
// the test drives rather than during boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN } from './helpers/app.mjs';
import { shiftDays, ymd } from '../fixtures/world.mjs';

const PID = 3, CAP = 21;   // volleyball's floor size (config)
const email = (n) => `${n}@test.local`;

// The volleyball run date the app itself will use right now: Friday (dow 5), rolling to next week
// once tonight's run has ended (21:00) -- programDefaultDate's rule.
function appVbRunDate() {
  const now = new Date();
  let add = (5 - now.getDay() + 7) % 7;
  if (add === 0 && now.getHours() >= 21) add = 7;
  const d = new Date(now); d.setDate(d.getDate() + add);
  return ymd(d);
}

async function penaltyApp(t, { mode, rd, testNow }) {
  const app = await startApp({ env: testNow ? { TEST_NOW: testNow } : {} });
  t.after(() => app.stop());
  const db = app.db();
  // ---- the night (port of the private penalty-seed) ----
  db.prepare('UPDATE program_membership SET auto_renew = 0, ar_strikes = 0, ar_strike_at = NULL, ar_paused_until = NULL WHERE program_id = ?').run(PID);
  for (const table of ['checkins', 'run_state', 'attendance', 'run_summary']) db.prepare(`DELETE FROM ${table} WHERE program_id = ? AND run_date = ?`).run(PID, rd);
  db.prepare("DELETE FROM app_settings WHERE key IN ('vb_arassess_done','vb_autoopen_done','vb_autoping_done','vb_autolock_done','vb_confirmsweep_done')").run();
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('pco_door_mode', ?)").run(mode === 'doorON' ? '1' : '0');
  const insA = db.prepare("INSERT INTO applicants (full_name, email, phone, experience, waiver_ok, status) VALUES (?,?,'000-000-0000','x',1,'approved')");
  const insM = db.prepare("INSERT OR IGNORE INTO program_membership (program_id, email, status, role) VALUES (?,?,'approved','approved')");
  const insC = db.prepare('INSERT INTO checkins (run_date, email, name, program_id, sort_order, auto_seated, confirmed_at) VALUES (?,?,?,?,?,?,?)');
  const setPM = db.prepare('UPDATE program_membership SET auto_renew = ?, ar_strikes = ?, ar_paused_until = ? WHERE program_id = ? AND email = ?');
  const mk = (n) => { insA.run(n, email(n)); insM.run(PID, email(n)); };
  const confirmed = '2026-01-01 00:00:00';
  if (mode !== 'seat') {
    mk('pen_ghost1');
    db.prepare('INSERT OR REPLACE INTO run_state (run_date, program_id, is_open, cancelled) VALUES (?,?,0,0)').run(rd, PID);
    let fillers, from;
    if (mode === 'doorON') {
      insC.run(rd, email('pen_ghost1'), 'Pen Ghost1', PID, 0, 1, null);   // the would-be false strike
      fillers = CAP - 1; from = 1;
    } else {
      for (const n of ['pen_ghost2', 'pen_show', 'pen_manual', 'pen_wait']) mk(n);
      setPM.run(0, 2, null, PID, email('pen_ghost2'));   // one ghost short of the pause
      setPM.run(0, 2, null, PID, email('pen_show'));     // same streak, but they show
      insC.run(rd, email('pen_ghost1'), 'Pen Ghost1', PID, 0, 1, null);
      insC.run(rd, email('pen_ghost2'), 'Pen Ghost2', PID, 1, 1, null);
      insC.run(rd, email('pen_show'), 'Pen Show', PID, 2, 1, confirmed);
      insC.run(rd, email('pen_manual'), 'Pen Manual', PID, 3, 0, null);   // manual check-in: never struck
      insC.run(rd, 'ghosty@guest.local', 'Ghosty (guest)', PID, 4, 1, null);
      fillers = CAP - 5; from = 5;
    }
    for (let i = 0; i < fillers; i++) { mk(`pen_fill${i}`); insC.run(rd, email(`pen_fill${i}`), `Pen Fill${i}`, PID, from + i, 0, confirmed); }
    if (mode === 'assess') insC.run(rd, email('pen_wait'), 'Pen Wait', PID, 99, 1, null);   // floor is full: waitlisted
  } else {
    for (const n of ['pen_normal', 'pen_pfut', 'pen_pexp']) mk(n);
    setPM.run(1, 0, null, PID, email('pen_normal'));
    setPM.run(1, 0, shiftDays(rd, 7), PID, email('pen_pfut'));    // pause outlives this run: skipped
    setPM.run(1, 0, shiftDays(rd, -7), PID, email('pen_pexp'));   // pause elapsed: lifted and seated
  }
  return {
    app, db,
    setting: (k) => db.prepare('SELECT value v FROM app_settings WHERE key = ?').get(k)?.v,
    pm: (n) => db.prepare('SELECT ar_strikes, ar_strike_at, ar_paused_until FROM program_membership WHERE program_id = ? AND email = ?').get(PID, email(n)),
    auditRows: (action) => db.prepare('SELECT target FROM audit_log WHERE action = ? ORDER BY id DESC').all(action),
    inAttendance: (e) => !!db.prepare('SELECT 1 x FROM attendance WHERE program_id = ? AND run_date = ? AND email = ?').get(PID, rd, e),
    onRun: (n) => !!db.prepare('SELECT 1 x FROM checkins WHERE program_id = ? AND run_date = ? AND email = ?').get(PID, rd, email(n)),
  };
}
const noStrike = (r) => !r || (r.ar_strikes === 0 && r.ar_paused_until == null);
const yesterday = () => shiftDays(ymd(new Date()), -1);

test('door mode: a finished run archives with zero strikes, and flipping it off later strikes nobody', async (t) => {
  const rd = yesterday();
  const { app, db, setting, pm, auditRows, inAttendance, onRun } = await penaltyApp(t, { mode: 'doorON', rd });
  await app.tick();
  assert.equal(setting('vb_arassess_done'), rd, 'the assess marker was consumed');
  assert.ok(noStrike(pm('pen_ghost1')), 'the auto-seated ghost was not struck');
  assert.equal(auditRows('vb:arpenalty').length, 0);
  assert.ok(inAttendance(email('pen_ghost1')), 'archived to attendance regardless');
  assert.ok(!onRun('pen_ghost1'), 'roster purged');
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('pco_door_mode', '0')").run();
  await app.tick();
  assert.ok(noStrike(pm('pen_ghost1')), 'no retroactive strike');
});

test('assess: strike, pause, reset, and every exemption -- once only', async (t) => {
  const rd = yesterday();
  const { app, setting, pm, auditRows, inAttendance, onRun, db } = await penaltyApp(t, { mode: 'assess', rd });
  await app.tick();
  assert.equal(setting('vb_arassess_done'), rd);
  const g1 = pm('pen_ghost1'), g2 = pm('pen_ghost2'), sh = pm('pen_show');
  assert.ok(g1.ar_strikes === 1 && !!g1.ar_strike_at && g1.ar_paused_until == null, 'a fresh ghost takes strike 1');
  assert.ok(g2.ar_strikes === 0 && g2.ar_paused_until === shiftDays(rd, 14), 'the third consecutive ghost is paused two weeks');
  assert.ok(sh.ar_strikes === 0 && sh.ar_paused_until == null, 'a confirmed show clears the streak');
  assert.ok(noStrike(pm('pen_manual')), 'a manual check-in is never struck');
  assert.equal(db.prepare('SELECT 1 x FROM program_membership WHERE program_id = ? AND email = ?').get(PID, 'ghosty@guest.local'), undefined, 'guests exempt');
  assert.ok(noStrike(pm('pen_wait')), 'a waitlisted ghost is not assessed');
  const ap = auditRows('vb:arpenalty');
  assert.deepEqual(ap.map((r) => r.target), [`${rd} struck=1 paused=1`]);
  assert.ok(inAttendance(email('pen_ghost1')) && inAttendance(email('pen_fill0')), 'the floor archived, ghosts included');
  assert.ok(!inAttendance('ghosty@guest.local'), 'the guest not archived');
  assert.ok(!onRun('pen_ghost1'), 'roster purged');
  await app.tick();
  assert.ok(pm('pen_ghost1').ar_strikes === 1 && auditRows('vb:arpenalty').length === 1, 'a second tick does not double-strike');
});

test('seat: autoopen seats renewers, honours an active pause, lifts an expired one; only an operator clears', async (t) => {
  const rd = appVbRunDate();
  const { app, db, pm, auditRows } = await penaltyApp(t, { mode: 'seat', rd, testNow: `${shiftDays(rd, -6)}T09:00:00` });
  await app.tick();
  assert.ok(db.prepare('SELECT is_open FROM run_state WHERE program_id = ? AND run_date = ?').get(PID, rd)?.is_open, 'autoopen opened the run');
  const seated = (n) => db.prepare('SELECT auto_seated FROM checkins WHERE program_id = ? AND run_date = ? AND email = ?').get(PID, rd, email(n));
  assert.ok(seated('pen_normal')?.auto_seated, 'a normal renewer is seated');
  assert.ok(seated('pen_pexp')?.auto_seated, 'an expired pause is seated again');
  assert.equal(seated('pen_pfut'), undefined, 'an active pause is not seated');
  assert.equal(pm('pen_pexp').ar_paused_until, null, 'the expired pause is lifted');
  assert.equal(pm('pen_pfut').ar_paused_until, shiftDays(rd, 7), 'the active pause is intact');
  assert.deepEqual(auditRows('vb:arlift').map((r) => r.target), ['1']);
  await app.post('/volleyball/penalty/clear', { email: email('pen_pfut') }, { as: email('pen_normal') });
  assert.equal(pm('pen_pfut').ar_paused_until, shiftDays(rd, 7), 'a member cannot clear a penalty');
  await app.post('/volleyball/penalty/clear', { email: email('pen_pfut') }, { as: ADMIN });
  const cleared = pm('pen_pfut');
  assert.ok(cleared.ar_strikes === 0 && cleared.ar_paused_until == null, 'an admin can');
  assert.ok(auditRows('vb:arclear').some((r) => r.target === email('pen_pfut')), 'audited by name');
});
