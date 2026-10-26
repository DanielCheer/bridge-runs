// engine/demo-run.js — demo program 90's showcase: a full floor and waitlist of synthetic players,
// bot chatter with every message type, parties and the party-aware team fill. seedDemoRun() is
// what the organizer's Seed button runs, and what a fresh demo world runs at boot.
import db from '../db.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { ymdLocal } from '../lib/dates.js';
import { P, programDefaultDate } from './programs.js';
import { clearRunParties } from './parties.js';
import { teamFillCore } from './teams.js';

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

// Seed/reset: a fresh FULL floor + FULL waitlist of synthetic players, run open, chat, parties and
// teams. Idempotent (clears program-90 rows first) so it doubles as the reset button. `actorEmail`
// pins the welcome message and runs the team fill. Returns { total, rd } for the caller's audit.
function seedDemoRun(actorEmail) {
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
    .run(em(1), '📌 Doors open 6:45 — first 12 on the floor, everyone else waitlists. Bring both jersey colours.', actorEmail, pid);
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
  teamFillCore(pid, rd, actorEmail);   // the real party-aware auto-fill (demo-9..12 → Team 3)
  return { total, rd };
}

export {
  DEMO_PID, DEMO_NAMES, seedDemoRun,
};
