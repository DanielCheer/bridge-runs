// routes/demo.js — the demo: the public demo mode (DEMO_MODE=1: persona sign-in, the scheduled and
// organizer reset; docs/DEMO.md) and the admin showcase controls for demo program 90 (seed the
// floor, end/start the queue, clear).
import { DEMO_MODE } from '../guard.js';
import { DEMO_RESET_HOURS, DEMO_RESET_COOLDOWN_MS } from '../config.js';
import { isAdmin, requireAdmin } from '../auth.js';
import { loginPage, setDemoMode, demoResetPage, demoProfileCard } from '../views/index.js';
import { signIn } from '../lib/sign-in.js';
import { demoWorld } from '../lib/demo-world.js';
import db from '../db.js';
import { getSetting, setSetting, delSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { ymdLocal } from '../lib/dates.js';
import { isMinor } from '../engine/applicants.js';
import { P, programDefaultDate } from '../engine/programs.js';
import { clearRunParties } from '../engine/parties.js';
import { DEMO_PID, DEMO_NAMES, seedDemoRun } from '../engine/demo-run.js';

export function mountDemoMode(app) {
  // The public demo: a persona picker on /login, a strip on every page, and a clean world on a
  // timer. Resetting is a process exit: scripts/run-demo.mjs wipes the database and upload folders
  // and starts a fresh server, so "reset" can never leave a half-cleared world behind.
  if (DEMO_MODE) {
    const PERSONAS = demoWorld.DEMO_PERSONAS;
    const personaEmail = new Map(PERSONAS.map(p => [p.key, p.email]));
    const organizer = PERSONAS.find(p => p.key === 'organizer');
    if (!isAdmin(organizer.email))
      throw new Error(`[demo] ADMIN_EMAILS must include the organizer persona (${organizer.email}) — scripts/run-demo.mjs sets it`);
    const RESET_HOURS = DEMO_RESET_HOURS;
    // One reset per minute: each reset restarts the process, so a minimum uptime IS the rate limit
    // (an in-memory limiter would be wiped by the very reset it limits).
    const RESET_COOLDOWN_MS = DEMO_RESET_COOLDOWN_MS;
    if (!(RESET_HOURS > 0) || !(RESET_COOLDOWN_MS >= 0))
      throw new Error('[demo] DEMO_RESET_HOURS must be > 0 and DEMO_RESET_COOLDOWN_S >= 0');
    setDemoMode(true, { personas: PERSONAS, resetHours: RESET_HOURS });

    const exitForReset = (why) => {
      console.log(`[demo] ${why} — exiting so the supervisor restarts on a clean world`);
      process.exit(0);
    };
    setTimeout(() => exitForReset(`scheduled reset after ${RESET_HOURS} h`), RESET_HOURS * 3600_000);

    // Sign in as a fixture persona. Only the keys in DEMO_PERSONAS map to an account; /status then
    // routes by account state (approved or admin → /runs, pending → its status page).
    app.post('/demo/login', (req, res) => {
      const email = personaEmail.get(String(req.body.persona || ''));
      if (!email) return res.status(400).send(loginPage({ error: 'Pick one of the demo people.' }));
      signIn(res, email, 'demo persona');
      res.redirect('/status');
    });

    let resetting = false;
    app.get('/demo/reset', requireAdmin, (req, res) => res.send(demoResetPage()));
    app.post('/demo/reset', requireAdmin, (req, res) => {
      if (resetting || process.uptime() * 1000 < RESET_COOLDOWN_MS)
        return res.status(429).send('The demo was reset less than a minute ago. Try again shortly.');
      resetting = true;
      res.on('finish', () => setTimeout(() => exitForReset(`reset requested by ${req.userEmail}`), 100));
      res.send(demoResetPage({ resetting: true }));
    });
  }
}

export function mountDemoRunControls(app) {
  // Seed/reset: a fresh FULL floor + FULL waitlist of synthetic players, run open. Idempotent
  // (clears program-90 rows first) so it doubles as the reset button.
  app.post('/admin/demo/seed', requireAdmin, (req, res) => {
    const { total, rd } = seedDemoRun(req.userEmail);
    audit(req.userEmail, 'admin', 'demo:seed', `${total} players on ${rd}`);
    res.redirect(P(DEMO_PID).paths.run);
  });
  // END QUEUE — simulate the run finishing: the roster is cleared and check-in closes (what the
  // weekly rollover + autolock do for a live program; the static demo never schedules, so it's a
  // button). Chat is kept so the room still looks alive between cycles.
  app.post('/admin/demo/endqueue', requireAdmin, (req, res) => {
    const pid = DEMO_PID, cfg = P(pid).config;
    const rd = getSetting(cfg.keys.runDate);
    if (rd) {
      db.prepare('DELETE FROM checkins WHERE program_id = ?').run(pid);
      db.prepare('DELETE FROM team_assignments WHERE program_id = ?').run(pid);   // teams + parties end with the run
      clearRunParties(pid, rd);
      db.prepare('INSERT OR REPLACE INTO run_state (run_date, program_id, is_open, cancelled) VALUES (?,?,0,0)').run(rd, pid);
    }
    audit(req.userEmail, 'admin', 'demo:endqueue', rd || '');
    res.redirect(P(pid).paths.run);
  });
  // START QUEUE — simulate next week's queue opening: check-in opens and the AUTO-RENEWERS instantly
  // claim their guaranteed spots (auto_seated=1 rows — the same observable result seatRenewers
  // produces for a live program's members; demo players are synthetic so they can't flow through the
  // real membership join). 5 of 8 spots auto-fill, leaving room to show live joins/offers on top.
  app.post('/admin/demo/startqueue', requireAdmin, (req, res) => {
    const pid = DEMO_PID, cfg = P(pid).config;
    let rd = getSetting(cfg.keys.runDate);
    if (!rd || rd < ymdLocal()) rd = programDefaultDate(pid);
    setSetting(cfg.keys.runDate, rd);
    db.prepare('INSERT OR REPLACE INTO run_state (run_date, program_id, is_open, cancelled) VALUES (?,?,1,0)').run(rd, pid);
    const AUTO_RENEWERS = 5; // the subset with auto-renew ON
    const ins = db.prepare('INSERT OR IGNORE INTO checkins (run_date, email, name, program_id, sort_order, auto_seated) VALUES (?,?,?,?,?,1)');
    for (let i = 0; i < AUTO_RENEWERS; i++) ins.run(rd, `demo-${i + 1}@demo.local`, DEMO_NAMES[i], pid, i);
    audit(req.userEmail, 'admin', 'demo:startqueue', `${rd} +${AUTO_RENEWERS} auto`);
    res.redirect(P(pid).paths.run);
  });
  // Synthetic profile card for a DEMO player — roster names are tappable like live (profile, role,
  // stats, a client-side Follow toggle) but nothing persists: demo players have no accounts by
  // design. Admin-only, same as every demo surface.
  app.get('/demo/u/:i/card', requireAdmin, (req, res) => {
    const i = Number(req.params.i) || 0;
    const row = db.prepare('SELECT name, dob FROM checkins WHERE program_id = ? AND email = ?').get(DEMO_PID, `demo-${i}@demo.local`);
    if (!row) return res.status(404).send('');
    res.send(demoProfileCard({ name: row.name, idx: i, minor: isMinor(row) }));
  });
  // Tear the demo down — remove every synthetic row + its run state so nothing lingers.
  app.post('/admin/demo/clear', requireAdmin, (req, res) => {
    const pid = DEMO_PID, cfg = P(pid).config;
    const rdCur = getSetting(cfg.keys.runDate);
    db.prepare('DELETE FROM checkins WHERE program_id = ?').run(pid);
    db.prepare('DELETE FROM run_state WHERE program_id = ?').run(pid);
    db.prepare('DELETE FROM attendance WHERE program_id = ?').run(pid);
    db.prepare('DELETE FROM group_messages WHERE program_id = ?').run(pid);   // clear the bot chatter too
    db.prepare('DELETE FROM team_assignments WHERE program_id = ?').run(pid); // teams + parties too
    if (rdCur) clearRunParties(pid, rdCur);
    delSetting(cfg.keys.runDate);
    audit(req.userEmail, 'admin', 'demo:clear', '');
    res.redirect(P(pid).paths.run);
  });
}
