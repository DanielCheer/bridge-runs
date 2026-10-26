// fixtures/world.mjs — the synthetic world every in-repo test (and the demo) starts from.
//
// Everyone here is fictional and lives at @test.local; phones are 000-000-0000. Nothing is copied
// from a real database, so nothing here can reach a real person. The world is DETERMINISTIC for a
// given `today`: run dates, season openers and created_at stamps are all derived from it, so two
// seeds on the same day produce identical databases.
//
// The database must already carry the app's schema (scripts/seed-fixture.mjs creates it by
// importing db.js, the same path the app boots through), so this file only inserts rows.
//
// Shape:
//   • personas — an organizer (ADMIN_EMAILS), the org team, a core regular, a council voter,
//     twelve players (one a minor), and one each of pending / rejected / suspended;
//   • programs 1 (basketball, Wednesdays), 2 (pickleball, Tuesdays), 3 (volleyball, Fridays),
//     all published, each with a season opener five weeks back so there is real history;
//   • history — attendance + run_summary for every past run night, game results on the
//     basketball teams board, a pickleball doubles ladder;
//   • social — group chat in every program (text, reply, mention, reaction, pin, sticker, photo,
//     voice note, video — the media are bundled files under public/), a DM thread, announcements,
//     friendships and a standing party.
// The CURRENT run night of every program is left empty (no check-ins, check-in closed): each test
// sets up the night it is about, instead of inheriting a roster it didn't ask for.

export const PHONE = '000-000-0000';
export const MINOR_DOB = '2010-03-15';

export const PERSONAS = {
  admin: 'admin@test.local',
  team: 'team@test.local',
  core: 'core@test.local',
  council: 'council@test.local',
  pending: 'pending@test.local',
  rejected: 'rejected@test.local',
  suspended: 'suspended@test.local',
};
export const PLAYERS = Array.from({ length: 12 }, (_, i) => `player${String(i + 1).padStart(2, '0')}@test.local`);
export const MINOR = PLAYERS[6];   // player07 carries MINOR_DOB

// The public demo's persona picker (DEMO_MODE=1, docs/DEMO.md): one account per kind of viewer.
// This list IS the allowlist POST /demo/login signs into; nothing else can be picked.
export const DEMO_PERSONAS = [
  { key: 'organizer', label: 'Organizer', who: 'Admin: reviews applicants, runs the night, sees analytics', email: PERSONAS.admin },
  { key: 'team', label: 'Team member', who: 'Runs the teams board and approves people', email: PERSONAS.team },
  { key: 'council', label: 'Council voter', who: 'Votes on who gets in', email: PERSONAS.council },
  { key: 'core', label: 'Core player', who: 'A regular with early access', email: PERSONAS.core },
  { key: 'player', label: 'Regular player', who: 'Joins runs, chats, has friends and a party', email: PLAYERS[0] },
  { key: 'pending', label: 'Pending applicant', who: 'Applied, waiting on the council', email: PERSONAS.pending },
];

const PLAYER_NAMES = ['Jordan Avery', 'Casey Brooks', 'Riley Chen', 'Taylor Dunn', 'Morgan Ellis', 'Jamie Fox',
  'Quinn Garcia', 'Drew Hayes', 'Skyler Ito', 'Reese Jensen', 'Parker Kim', 'Rowan Lee'];

// The three standing programs, by id. dow = the run weekday (0 Sun … 6 Sat); seasonKey = the
// app_settings key holding that program's season opener (see PROGRAM_DEFS in server.js).
export const PROGRAMS = {
  1: { dow: 3, seasonKey: 'season_start' },      // basketball, Wednesdays
  2: { dow: 2, seasonKey: 'pk_season_start' },   // pickleball, Tuesdays
  3: { dow: 5, seasonKey: 'vb_season_start' },   // volleyball, Fridays
};
const HISTORY_WEEKS = 5;

// ---------- dates (local, YYYY-MM-DD, parsed at noon so DST can't shift a day) ----------
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const atNoon = (s) => new Date(s + 'T12:00:00');
export const shiftDays = (s, n) => { const d = atNoon(s); d.setDate(d.getDate() + n); return ymd(d); };
const toYmd = (today) => (today instanceof Date ? ymd(today) : String(today || ymd(new Date())));

// The season opener the world writes for a program: its run weekday on or before
// (today − HISTORY_WEEKS weeks), so there are HISTORY_WEEKS past nights of history.
export function seasonStartFor(programId, today) {
  const { dow } = PROGRAMS[programId];
  const d = atNoon(shiftDays(toYmd(today), -7 * HISTORY_WEEKS));
  d.setDate(d.getDate() - ((d.getDay() - dow + 7) % 7));
  return ymd(d);
}

// THE run date a test should use for a program — the same derivation as the private harness's
// harness_run_date(): from the season opener or today (whichever is later) roll forward to the
// run weekday. mode 'future' starts from tomorrow, so "today" is never the run day.
// Caveat shared with the app's own clock: on the run day itself, after the run's END time, the app
// has already rolled to next week (programDefaultDate). Tests that care pin the night themselves.
export function runDateFor(programId, today, mode = 'today') {
  const { dow } = PROGRAMS[programId];
  const t = toYmd(today);
  const floor = mode === 'future' ? shiftDays(t, 1) : t;
  const opener = seasonStartFor(programId, t);
  const d = atNoon(opener > floor ? opener : floor);
  while (d.getDay() !== dow) d.setDate(d.getDate() + 1);
  return ymd(d);
}

// Past run nights of a program: opener, opener+7, … strictly before today.
export function pastRunDates(programId, today) {
  const t = toYmd(today), out = [];
  for (let d = seasonStartFor(programId, t); d < t; d = shiftDays(d, 7)) out.push(d);
  return out;
}

export function seedWorld(db, { today } = {}) {
  const t = toYmd(today);
  // A fixed, distinct created_at per row keeps every "ORDER BY created_at" deterministic
  // (datetime('now') is second-resolution, so rows seeded in the same second would tie).
  const stampBase = shiftDays(seasonStartFor(1, t), -30);
  let seq = 0;
  const stamp = (date = stampBase) => {
    const s = seq++;
    return `${date} ${pad(12 + Math.floor(s / 3600) % 12)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  };

  db.exec('BEGIN');
  try {
    // ---------- people ----------
    const insA = db.prepare(`INSERT INTO applicants
      (full_name, email, phone, experience, where_played, waiver_ok, waiver_at, status, is_team, is_regular, is_council,
       suspended, suspend_reason, dob, position, auto_renew, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const person = (name, email, o = {}) => insA.run(
      name, email, PHONE, o.experience || 'Rec league, pickup most weeks', o.where || 'Community centre',
      o.waiver === false ? 0 : 1, o.waiver === false ? null : stamp(), o.status || 'approved',
      o.team ? 1 : 0, o.core ? 1 : 0, o.council ? 1 : 0,
      o.suspended ? 1 : 0, o.suspended ? 'Missed three confirmed nights' : null,
      o.dob || '1998-06-01', o.position || '', o.team ? 1 : 0, stamp());
    person('Avery Admin', PERSONAS.admin, { position: 'PG' });
    person('Toni Team', PERSONAS.team, { team: true, position: 'SG' });
    person('Cory Core', PERSONAS.core, { core: true, position: 'SF' });
    person('Chris Council', PERSONAS.council, { council: true, position: 'PF' });
    PLAYERS.forEach((email, i) => person(PLAYER_NAMES[i], email, {
      dob: email === MINOR ? MINOR_DOB : `199${i % 10}-0${1 + (i % 9)}-1${i % 10}`,
      position: ['PG', 'SG', 'SF', 'PF', 'C'][i % 5],
    }));
    person('Pat Pending', PERSONAS.pending, { status: 'pending', waiver: false, experience: 'High school varsity' });
    person('Robin Rejected', PERSONAS.rejected, { status: 'rejected' });
    person('Sam Suspended', PERSONAS.suspended, { suspended: true });
    const idOf = (email) => db.prepare('SELECT id FROM applicants WHERE email = ?').get(email).id;

    // The council has started voting on the pending applicant.
    db.prepare('INSERT INTO votes (applicant_id, voter_email, vote, at, program_id) VALUES (?,?,?,?,1)')
      .run(idOf(PERSONAS.pending), PERSONAS.council, 'approve', stamp());

    // ---------- programs ----------
    for (const [pid, { seasonKey }] of Object.entries(PROGRAMS)) {
      db.prepare('UPDATE program SET active = 1 WHERE id = ?').run(Number(pid));
      db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(seasonKey, seasonStartFor(Number(pid), t));
    }
    // Opt-in programs (2, 3) need membership; basketball is drop-in. The team runs every program.
    const insM = db.prepare(`INSERT INTO program_membership (program_id, email, status, role, joined_at, auto_renew)
      VALUES (?,?,'approved',?,?,?)`);
    const PK_MEMBERS = PLAYERS.slice(0, 8), VB_MEMBERS = PLAYERS.slice(4, 12);
    insM.run(2, PERSONAS.team, 'team', stamp(), 1);
    insM.run(3, PERSONAS.team, 'team', stamp(), 1);
    for (const e of PK_MEMBERS) insM.run(2, e, 'approved', stamp(), 0);
    for (const e of VB_MEMBERS) insM.run(3, e, 'approved', stamp(), 0);

    // ---------- history: who played, and the per-night aggregates ----------
    const ROSTER = {
      1: [PERSONAS.team, PERSONAS.core, PERSONAS.council, ...PLAYERS.slice(0, 10)],
      2: [PERSONAS.team, ...PK_MEMBERS],
      3: [PERSONAS.team, ...VB_MEMBERS],
    };
    const nameOf = (email) => db.prepare('SELECT full_name n FROM applicants WHERE email = ?').get(email).n;
    const insAtt = db.prepare('INSERT INTO attendance (run_date, email, name, recorded_at, program_id) VALUES (?,?,?,?,?)');
    const insSum = db.prepare(`INSERT INTO run_summary (run_date, program_id, floor_n, wait_n, guest_n, cap, cancelled,
      opened_at, first_checkin_at, filled_at, offers_sent, offers_claimed, offers_expired, created_at)
      VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,?)`);
    for (const pid of [1, 2, 3]) {
      pastRunDates(pid, t).forEach((rd, week) => {
        // Rotate one or two people out each week so attendance counts differ per person.
        const roster = ROSTER[pid].filter((_, i) => (i + week) % 6 !== 0);
        for (const e of roster) insAtt.run(rd, e, nameOf(e), `${rd} 23:00:00`, pid);
        const opened = `${shiftDays(rd, -1)} 13:00:00`;
        insSum.run(rd, pid, roster.length, week % 3, week % 2, pid === 1 ? 15 : pid === 2 ? 20 : 21,
          opened, `${shiftDays(rd, -1)} 13:01:00`, pid === 1 ? `${shiftDays(rd, -1)} 13:${pad(10 + week)}:00` : null,
          pid === 1 ? week % 3 : 0, pid === 1 ? Math.max(0, (week % 3) - 1) : 0, 0, `${rd} 23:00:00`);
      });
    }

    // Basketball games on the teams board for the two most recent nights: four a side.
    const insTeam = db.prepare('INSERT INTO team_assignments (program_id, run_date, email, team_no, assigned_by, created_at) VALUES (1,?,?,?,?,?)');
    const insGame = db.prepare('INSERT INTO run_games (program_id, run_date, win_side, w_score, l_score, logged_by, created_at) VALUES (1,?,?,?,?,?,?)');
    const insGP = db.prepare('INSERT INTO run_game_players (game_id, email, side) VALUES (?,?,?)');
    for (const rd of pastRunDates(1, t).slice(-2)) {
      const sides = { 1: PLAYERS.slice(0, 4), 2: PLAYERS.slice(4, 8) };
      for (const [side, emails] of Object.entries(sides)) for (const e of emails) insTeam.run(rd, e, Number(side), PERSONAS.team, `${rd} 20:20:00`);
      [[1, 21, 17], [2, 21, 19], [1, 15, 11]].forEach(([win, ws, ls], g) => {
        const gid = insGame.run(rd, win, ws, ls, PERSONAS.team, `${rd} 2${g}:45:00`).lastInsertRowid;
        for (const [side, emails] of Object.entries(sides)) for (const e of emails) insGP.run(gid, e, Number(side));
      });
    }

    // Pickleball doubles ladder: four regulars, a few results over the season.
    const LADDER = PK_MEMBERS.slice(0, 4);
    const insLP = db.prepare('INSERT INTO ladder_players (program_id, email, name, added_by, created_at) VALUES (2,?,?,?,?)');
    for (const e of LADDER) insLP.run(e, nameOf(e), PERSONAS.team, stamp());
    const pair = (a, b) => [a, b].map((x) => x.toLowerCase()).sort();
    const insLG = db.prepare('INSERT INTO ladder_games (program_id, run_date, w1, w2, l1, l2, w_score, l_score, logged_by, created_at) VALUES (2,?,?,?,?,?,?,?,?,?)');
    pastRunDates(2, t).slice(-3).forEach((rd, i) => {
      const [w, l] = i % 2 ? [pair(LADDER[2], LADDER[3]), pair(LADDER[0], LADDER[1])] : [pair(LADDER[0], LADDER[1]), pair(LADDER[2], LADDER[3])];
      insLG.run(rd, w[0], w[1], l[0], l[1], 11, 7 + i, PERSONAS.team, `${rd} 19:30:00`);
    });

    // ---------- chat: every message type the room can render ----------
    const insG = db.prepare(`INSERT INTO group_messages (from_email, body, reply_to, image, mentions, audio, audio_dur, video, video_dur,
      pinned_at, pinned_by, created_at, program_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const msg = (pid, from, body, o = {}) => Number(insG.run(from, body, o.reply ?? null, o.image ?? null, o.mentions ?? null,
      o.audio ?? null, o.audio ? 3 : null, o.video ?? null, o.video ? 3 : null,
      o.pinned ? `${shiftDays(t, -2)} 18:00:00` : null, o.pinned ? PERSONAS.admin : null, o.at, pid).lastInsertRowid);
    const chatDay = shiftDays(t, -2);
    let minute = 0;
    const at = () => `${chatDay} 17:${pad(minute++)}:00`;
    const hello = msg(1, PLAYERS[0], 'who is running this week?', { at: at() });
    msg(1, PLAYERS[1], 'me and two friends, we are in', { at: at(), reply: hello });
    msg(1, PERSONAS.team, `@${nameOf(PLAYERS[2]).split(' ')[0]} bring the spare ball`, { at: at(), mentions: String(idOf(PLAYERS[2])) });
    msg(1, PLAYERS[2], 'last week was a movie', { at: at(), image: '/gym.jpg' });
    msg(1, PLAYERS[3], '', { at: at(), image: '/stickers/gameon.svg' });
    msg(1, PLAYERS[4], '', { at: at(), audio: '/demo-media/voice.m4a' });
    msg(1, PLAYERS[5], '', { at: at(), video: '/demo-media/clip.mp4' });
    msg(1, PERSONAS.admin, 'Doors open 8:15. First 15 on the floor, everyone else waitlists.', { at: at(), pinned: true });
    db.prepare('INSERT INTO group_reactions (group_message_id, from_email, emoji, created_at, program_id) VALUES (?,?,?,?,1)')
      .run(hello, PERSONAS.core, '🔥', at());
    const pkHello = msg(2, PK_MEMBERS[0], 'courts 1 and 2 are ours from 6:15', { at: at() });
    msg(2, PK_MEMBERS[1], 'see you there', { at: at(), reply: pkHello });
    msg(3, VB_MEMBERS[0], 'anyone want to set for us on Friday?', { at: at() });

    // A direct-message thread between a player and the organizer. Bodies are stored as plaintext,
    // which the app reads as legacy rows (new DMs are encrypted at rest by server.js).
    const insDM = db.prepare('INSERT INTO messages (from_email, to_email, body, created_at, read_at) VALUES (?,?,?,?,?)');
    insDM.run(PLAYERS[0], PERSONAS.admin, 'Hey, can I bring a friend next week?', `${chatDay} 18:00:00`, `${chatDay} 18:05:00`);
    insDM.run(PERSONAS.admin, PLAYERS[0], 'Sure, have them apply first so the council can approve them.', `${chatDay} 18:06:00`, null);

    // ---------- announcements: one live per program, one already archived ----------
    const insAnn = db.prepare('INSERT INTO announcements (body, author, at, archived, archived_at, program_id) VALUES (?,?,?,?,?,?)');
    insAnn.run('Gym is closed for the holiday weekend.', PERSONAS.admin, `${shiftDays(t, -14)} 12:00:00`, 1, `${shiftDays(t, -7)} 12:00:00`, 1);
    insAnn.run('Bring a light and a dark jersey this week.', PERSONAS.admin, `${shiftDays(t, -3)} 12:00:00`, 0, null, 1);
    insAnn.run('New nets on courts 1 and 2.', PERSONAS.team, `${shiftDays(t, -4)} 12:00:00`, 0, null, 2);

    // ---------- friends + a standing party ----------
    const insEdge = db.prepare("INSERT INTO social_edges (from_email, to_email, kind, status, created_at) VALUES (?,?,'friend',?,?)");
    insEdge.run(PLAYERS[0], PLAYERS[1], 'accepted', stamp());
    insEdge.run(PLAYERS[0], PLAYERS[2], 'accepted', stamp());
    insEdge.run(PLAYERS[3], PLAYERS[0], 'requested', stamp());
    const party = db.prepare('INSERT INTO parties (name, leader_email, created_at) VALUES (?,?,?)')
      .run('Tuesday crew', PLAYERS[0], stamp()).lastInsertRowid;
    const insPM = db.prepare('INSERT INTO party_members (party_id, email, status, created_at) VALUES (?,?,?,?)');
    insPM.run(party, PLAYERS[1], 'joined', stamp());
    insPM.run(party, PLAYERS[2], 'invited', stamp());

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { today: t, personas: PERSONAS, players: PLAYERS };
}
