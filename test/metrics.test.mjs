// The metrics layer end to end: run_summary written by the boot-time archive (from a past night
// seeded before boot), live event capture (join, push tap, install beacon, push send), the
// opened_at fill-speed anchor, the daily last-seen touch, and the surfaces that read it all
// (analytics, run history + CSV, the People page's last-active chip).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN } from './helpers/app.mjs';
import { PLAYERS, shiftDays, ymd } from '../fixtures/world.mjs';

const REG = PLAYERS[0];
// The most recent Wednesday strictly before today: a genuinely past basketball night.
const rd = (() => { const d = new Date(); do { d.setDate(d.getDate() - 1); } while (d.getDay() !== 3); return ymd(d); })();
let app, db;
before(async () => {
  app = await startApp({
    seed: (d) => {
      // The world already has history for this night; replace it with the night under test.
      for (const t of ['attendance', 'run_summary', 'checkins', 'run_state']) d.prepare(`DELETE FROM ${t} WHERE run_date = ? AND program_id = 1`).run(rd);
      d.prepare('UPDATE applicants SET is_team = 0, auto_renew = 0').run();
      const insA = d.prepare("INSERT INTO applicants (full_name, email, phone, experience, waiver_ok, status) VALUES (?,?,'000-000-0000','x',1,'approved')");
      const insC = d.prepare('INSERT INTO checkins (run_date, email, name, program_id, sort_order, created_at) VALUES (?,?,?,1,?,?)');
      for (let i = 0; i < 16; i++) {   // 16 members staggered by the minute: 15 on the floor, 1 waiting
        insA.run(`Metric Fixture ${i}`, `mfix${i}@test.local`);
        insC.run(rd, `mfix${i}@test.local`, `Metric Fixture ${i}`, i, `${rd} 17:${String(i + 1).padStart(2, '0')}:00`);
      }
      insC.run(rd, 'mguest@guest.local', 'Guesty (guest)', 99, `${rd} 17:30:00`);
      d.prepare('INSERT INTO run_state (run_date, program_id, is_open, cancelled, opened_at) VALUES (?,1,1,0,?)').run(rd, `${rd} 17:00:00`);
      const insM = d.prepare('INSERT INTO metrics_events (kind, program_id, run_date, n, meta) VALUES (?,1,?,1,?)');
      insM.run('offer_send', rd, ''); insM.run('offer_send', rd, ''); insM.run('offer_claim', rd, 'mins=42');
    },
  });
  db = app.db();
});
after(async () => { await app?.stop(); });

const mCount = (kind, extra = '', ...p) => db.prepare(`SELECT COUNT(*) n FROM metrics_events WHERE kind = ?${extra}`).get(kind, ...p).n;
const page = async (p, as) => (await app.get(p, { as })).text();

test('the boot-time archive summarized the past night before purging it', () => {
  const rs = db.prepare('SELECT * FROM run_summary WHERE run_date = ? AND program_id = 1').get(rd);
  assert.ok(rs, 'summary row exists');
  assert.equal(rs.floor_n, 15, 'floor (cap-limited, non-guest)');
  assert.equal(rs.wait_n, 1, 'unmet demand');
  assert.equal(rs.guest_n, 1, 'guest counted separately');
  assert.equal(rs.opened_at, `${rd} 17:00:00`, 'opened_at carried over from run_state');
  assert.equal(rs.first_checkin_at, `${rd} 17:01:00`);
  assert.equal(rs.filled_at, `${rd} 17:15:00`, 'floor-full = the 15th check-in');
  assert.deepEqual([rs.offers_sent, rs.offers_claimed, rs.offers_expired], [2, 1, 0], 'offer funnel rolled in');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM attendance WHERE run_date = ? AND program_id = 1').get(rd).n, 15, 'attendance archived alongside');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM checkins WHERE run_date = ?').get(rd).n, 0, 'check-ins purged');
});

let frd;
test('live capture: the open anchor and identity-free join events', async () => {
  // A future night (a run today would hit the 2 PM run-day join lock): opener two days out.
  const opener = shiftDays(ymd(new Date()), 2);
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('season_start', ?)").run(opener);
  frd = (() => { const d = new Date(opener + 'T12:00:00'); while (d.getDay() !== 3) d.setDate(d.getDate() + 1); return ymd(d); })();
  await app.post('/checkin/open', {}, { as: ADMIN });
  const st = db.prepare('SELECT is_open, opened_at FROM run_state WHERE run_date = ? AND program_id = 1').get(frd);
  assert.ok(st?.is_open && st.opened_at, 'opening stamps opened_at');
  await app.post('/checkin/open', {}, { as: ADMIN });
  assert.equal(db.prepare('SELECT opened_at o FROM run_state WHERE run_date = ? AND program_id = 1').get(frd).o, st.opened_at, 're-open keeps the anchor');
  const before = mCount('checkin_join');
  await app.post('/checkin/join', {}, { as: REG });
  assert.ok(mCount('checkin_join', ' AND run_date = ? AND program_id = 1', frd) >= 1, 'a join event');
  await app.post('/checkin/join', {}, { as: REG });
  assert.equal(mCount('checkin_join'), before + 1, 'a repeat join is not double-counted');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM metrics_events WHERE meta LIKE '%@%'").get().n, 0, 'no identities in the table');
});

test('engagement: push tap-through, last seen, install beacon (signed-in only)', async () => {
  await app.get('/checkin?from=push', { as: REG });
  assert.ok(mCount('push_tap') >= 1);
  assert.ok(db.prepare('SELECT last_seen_at l FROM applicants WHERE email = ?').get(REG).l, 'last_seen_at touched');
  const before = mCount('pwa_install');
  await app.post('/metrics/install', {}, { as: REG });
  assert.equal(mCount('pwa_install'), before + 1);
  await app.post('/metrics/install', {});
  assert.equal(mCount('pwa_install'), before + 1, 'anonymous beacon ignored');
});

test('a push batch records its device count', async () => {
  // A loopback black-hole subscription: the send goes nowhere, but the batch is counted.
  db.prepare('INSERT OR IGNORE INTO push_subscriptions (email, endpoint, p256dh, auth) VALUES (?,?,?,?)')
    .run(REG, 'http://127.0.0.1:9/dead-metrics-fixture', 'BOguX0I6cOMU5eLZL1lQ1R-yAGSjrtmUKcJYzKXVEbcO_qkCYWlAGE1ZBEkw3EJmqxLKk1rNXUvUsoMnOZnc2Wk', 'dGVzdC1hdXRoLXNlY3JldA');
  await app.post('/announce', { body: 'Metrics layer smoke announcement' }, { as: ADMIN });
  await new Promise((r) => setTimeout(r, 400));   // sendPush runs in setImmediate
  assert.ok(mCount('push_send') >= 1);
  db.prepare('DELETE FROM checkins WHERE run_date = ?').run(frd);
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint LIKE '%dead-metrics-fixture%'").run();
});

test('the surfaces read it: analytics, run history, CSV, opens by kind, last-active chip', async () => {
  const an = await page('/admin/analytics', ADMIN);
  assert.ok(an.includes('Engagement pulse') && an.includes('this week'));
  assert.ok(an.includes('waitlisted') && an.includes('floor fills in'));
  const histR = await app.get('/admin/history', { as: ADMIN });
  const hist = await histR.text();
  assert.ok(histR.status === 200 && hist.includes('Run history') && hist.includes(rd));
  assert.ok(hist.includes('15 min'), 'fill time from the UTC pair');
  assert.ok(hist.includes('2 → 1 claimed'), 'offer funnel');
  assert.notEqual((await app.get('/admin/history', { as: REG })).status, 200, 'admin-only');
  const csv = await page('/admin/history.csv', ADMIN);
  assert.ok(csv.includes('Program,Run date') && csv.includes(rd));
  await app.get('/checkin?from=push&tag=offer', { as: REG });
  assert.ok(db.prepare("SELECT 1 x FROM metrics_events WHERE kind = 'push_tap' AND meta LIKE 'offer|%'").get(), 'the tap records its kind');
  await app.get('/checkin?from=push&tag=' + encodeURIComponent('x@evil.com'), { as: REG });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM metrics_events WHERE meta LIKE '%@%'").get().n, 0, 'a hostile tag is stripped');
  const an2 = await page('/admin/analytics', ADMIN);
  assert.ok(an2.includes('By kind (30d)') && an2.includes('Spot offers'));
  assert.ok((await page('/admin/people', ADMIN)).includes('active today'));
});
