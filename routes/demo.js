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
import { teamFillCore } from '../engine/teams.js';

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

// Seed/reset/clear the synthetic demo roster (program 90). All rows are @demo.local checkins-only
// (no applicant rows) confined to program_id=90, so nothing here can touch live data.
const DEMO_PID = 90;
const DEMO_NAMES = ['Marcus B.', 'Jordan T.', 'Andre W.', 'Tyler R.', 'Chris O.', 'Devin M.', 'Malik S.',
  'Isaiah H.', 'Xavier P.', 'Cameron D.', 'Trey L.', 'Josh N.', 'Elijah G.', 'Nate F.'];
// Bot chatter seeded into the demo run's chat so it looks alive during a demo (sender name resolves
// from the demo roster via the checkins fallback in hydrateGroupMessages). [demo-player-index, line].
const DEMO_CHAT = [
  [2, 'yo who’s running tonight? 🏀'],
  [5, 'me + a couple friends, we’re in'],
  [1, 'waitlist moved fast last week 😅'],
  [9, 'first time coming out — how’s the run?'],
  [3, 'competitive but chill, you’ll love it 🙌'],
  [7, 'save me a spot on the floor 🙏'],
  [4, 'anyone got a ball pump? mine died'],
  [11, 'see everyone at 7 🔥'],
];

export function mountDemoRunControls(app) {
  // Seed/reset: a fresh FULL floor + FULL waitlist of synthetic players, run open. Idempotent
  // (clears program-90 rows first) so it doubles as the reset button.
  app.post('/admin/demo/seed', requireAdmin, (req, res) => {
    const pid = DEMO_PID, cfg = P(pid).config;
    // Never reuse a PAST rehearsal's stored date (static programs never roll it) — recompute if stale
    // so the demo always seeds on an upcoming date, not last week's.
    let rd = getSetting(cfg.keys.runDate);
    if (!rd || rd < ymdLocal()) rd = programDefaultDate(pid);
    setSetting(cfg.keys.runDate, rd);
    db.prepare('DELETE FROM checkins WHERE program_id = ?').run(pid);
    db.prepare('INSERT OR REPLACE INTO run_state (run_date, program_id, is_open, cancelled) VALUES (?,?,1,0)').run(rd, pid);
    const total = Math.min(cfg.cap + cfg.waitlist, DEMO_NAMES.length);
    const ins = db.prepare('INSERT INTO checkins (run_date, email, name, program_id, sort_order) VALUES (?,?,?,?,?)');
    for (let i = 0; i < total; i++) ins.run(rd, `demo-${i + 1}@demo.local`, DEMO_NAMES[i], pid, i);
    // ~60% of the floor shows a green ✓ (a realistic mix of confirmed / not-yet-confirmed).
    db.prepare("UPDATE checkins SET confirmed_at = datetime('now') WHERE program_id = ? AND run_date = ? AND sort_order < ?")
      .run(pid, rd, Math.floor(cfg.cap * 0.6));
    // One floor player carries a minor DOB → showcases the red "Minor" safeguarding badge on the roster.
    // (Demo players are checkins-only, so the DOB lives on the checkin row itself, not an applicant.)
    db.prepare("UPDATE checkins SET dob = '2010-03-15' WHERE program_id = ? AND run_date = ? AND sort_order = 3").run(pid, rd);
    // Seed the demo CHAT with bot chatter so the room looks alive (cleared on reset/clear below).
    // Beyond text it showcases EVERY message type: a photo (with caption), a sticker, a voice note,
    // a video, a threaded reply, and a pinned message — the media are tiny bundled static assets
    // (public/demo-media/*, referenced by path exactly like /stickers/*), so nothing is uploaded/orphaned.
    db.prepare('DELETE FROM group_messages WHERE program_id = ?').run(pid);
    const insMsg = db.prepare('INSERT INTO group_messages (from_email, body, program_id) VALUES (?,?,?)');
    const em = (i) => `demo-${i + 1}@demo.local`;
    const msgIds = [];
    for (const [i, line] of DEMO_CHAT) if (i < total) msgIds.push(insMsg.run(em(i), line, pid).lastInsertRowid);
    // reply — threads the 5th text line onto the 4th ("first time coming out" → welcome)
    db.prepare('INSERT INTO group_messages (from_email, body, reply_to, program_id) VALUES (?,?,?,?)')
      .run(em(6), 'bring water, we run games back to back 💧', msgIds[3], pid);
    // photo with a caption (bundled gym shot)
    db.prepare('INSERT INTO group_messages (from_email, body, image, program_id) VALUES (?,?,?,?)')
      .run(em(0), 'last week was a movie 🔥', '/gym.jpg', pid);
    // sticker
    db.prepare('INSERT INTO group_messages (from_email, body, image, program_id) VALUES (?,?,?,?)')
      .run(em(5), '', '/stickers/gameon.svg', pid);
    // voice note (3s bundled clip)
    db.prepare('INSERT INTO group_messages (from_email, body, audio, audio_dur, program_id) VALUES (?,?,?,?,?)')
      .run(em(2), '', '/demo-media/voice.m4a', 3, pid);
    // video (3s bundled clip, native player)
    db.prepare('INSERT INTO group_messages (from_email, body, video, video_dur, program_id) VALUES (?,?,?,?,?)')
      .run(em(8), '', '/demo-media/clip.mp4', 3, pid);
    // pinned message (shows in the pinned bar at the top of the room)
    db.prepare("INSERT INTO group_messages (from_email, body, pinned_at, pinned_by, program_id) VALUES (?,?,datetime('now'),?,?)")
      .run(em(1), '📌 Doors open 6:45 — first 12 on the floor, everyone else waitlists. Bring both jersey colours.', req.userEmail, pid);
    // PARTIES (queue-with-friends showcase): party A = demo-1..4 (a whole team's worth), party B =
    // demo-5,6 and party C = demo-7,8 (two pairs), demo-9..12 solo. Then the REAL party-aware
    // auto-fill runs → Team 1 = one full party, Team 2 = two different groups, Team 3 = individuals.
    clearRunParties(pid, rd);
    db.prepare('DELETE FROM team_assignments WHERE program_id = ?').run(pid);
    const insParty = db.prepare('INSERT INTO signup_groups (program_id, run_date, leader_email) VALUES (?,?,?)');
    const insPartyM = db.prepare("INSERT INTO signup_group_members (group_id, email, status) VALUES (?,?,'joined')");
    const setGid = db.prepare('UPDATE checkins SET group_id = ? WHERE program_id = ? AND run_date = ? AND email = ?');
    const mkParty = (idx) => { // idx = 0-based demo indices; first is leader
      const gid = insParty.run(pid, rd, em(idx[0])).lastInsertRowid;
      for (const i of idx.slice(1)) insPartyM.run(gid, em(i));
      for (const i of idx) setGid.run(gid, pid, rd, em(i));
    };
    mkParty([0, 1, 2, 3]);   // A — fills Team 1 whole
    mkParty([4, 5]);         // B ┐
    mkParty([6, 7]);         // C ┘ together = Team 2
    teamFillCore(pid, rd, req.userEmail);   // the real party-aware auto-fill (demo-9..12 → Team 3)
    audit(req.userEmail, 'admin', 'demo:seed', `${total} players on ${rd}`);
    res.redirect(P(pid).paths.run);
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
