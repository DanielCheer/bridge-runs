// routes/runs.js — the runs hub (/runs): every program's card with the member's status in it, and
// the past-run rosters (/runs/past/:pid/:date).
import db from '../db.js';
import { isAdmin, requireLogin } from '../auth.js';
import { runsPage, pastRunPage } from '../views/index.js';
import { applicantByEmail, isMinor } from '../engine/applicants.js';
import { P, PROGRAMS } from '../engine/programs.js';
import { annPanel } from '../engine/announcements.js';
import { partitionFor } from '../engine/seating.js';
import { friendsGamesFor } from '../engine/social.js';
import { chatProgramFor, chatCountsFor } from '../engine/chat.js';
import { unreadCount } from '../engine/messages.js';

const stmtHubPast = db.prepare('SELECT run_date, program_id FROM attendance WHERE email = ? ORDER BY run_date DESC LIMIT 12'); // runs-hub "Past games" list

// Runs hub — the launcher that lists every run the viewer can join, then hands off to
// that run's own check-in page. Basketball is always listed; Pickleball appears for
// admins always and for members only once it's published (active) — preserving the
// hidden-until-live behaviour. Read-only aside from the no-op week rolls.
// The viewer's own status for a run, for the hub card's personal badge (Javelin-style):
// 'in' (on the floor), 'offered' (holding a pending offer), or 'waitlist' (with position #pos of total).
// Returns null when they're not signed up — the card then shows no personal badge. Reuses the same
// partition the run page uses, so the badge and the run page never disagree.
function myRunStatusFor(programId, rd, email, part) {
  if (!email || !rd) return null;
  const cfg = P(programId).config;
  part = part || partitionFor(programId, rd);   // reuse the hub card's partition when passed — avoids a 2nd partition per program per /runs

  const me = String(email).toLowerCase();
  const floor = cfg.offerWindow ? part.floorReal : part.floor;
  const wait = cfg.offerWindow ? part.waitPlayers : part.wait;
  const offered = cfg.offerWindow ? part.offered : [];
  if (floor.some(x => String(x.email).toLowerCase() === me)) return { state: 'in' };
  if (offered.some(x => String(x.email).toLowerCase() === me)) return { state: 'offered' };
  const i = wait.findIndex(x => String(x.email).toLowerCase() === me);
  if (i >= 0) return { state: 'waitlist', pos: i + 1, total: wait.length };
  return null;
}

// Past run — read-only "who went" roster from the attendance archive. Opens from the hub's
// Past tab exactly like a live run card, but it's done: no actions, just the list. Approved
// members + admins only (same visibility bar as a live who's-going sheet).
const stmtPastRoster = db.prepare(`SELECT t.name, t.email, a.id AS applicant_id, a.dob
    FROM attendance t LEFT JOIN applicants a ON a.email = t.email
    WHERE t.program_id = ? AND t.run_date = ? ORDER BY t.name COLLATE NOCASE`);

export function mountRunsHub(app) {
  app.get('/runs', requireLogin, (req, res) => {
    const email = req.userEmail;
    // Any signed-in member can SEE the hub — non-approved viewers get an apply prompt on
    // tap (handled in the view) instead of being bounced away, so they can find the runs.
    const a = applicantByEmail(email);
    const viewerIsAdmin = isAdmin(email);
    const status = a?.status || 'none';
    const canJoin = viewerIsAdmin || status === 'approved';
    const runs = [];
    // Which people the viewer FOLLOWS are already checked in — keyed by program|run-date so each
    // card can show "Alex, Sam +2 going" (Javelin-style social proof). Same visibility as the
    // /friends "friends' games" list, computed once here.
    const fgMap = new Map(friendsGamesFor(email).map(g => [g.programId + '|' + g.runDate, g.friends]));
    // Every registered run, in id order: live ones are always listed; a hidden run (not yet
    // published) shows to admins only, with a lock badge. Each card's dynamic fields come from
    // that program's own dispatch (basketball / pickleball engine today) — no hardcoded pushes.
    for (const p of PROGRAMS.values()) {
      if (!p.active() && !viewerIsAdmin) continue;
      // Per-program isolation: the hub is the app's home page, so one program whose card computation
      // throws must cost that CARD, never everyone's /runs. (In-app program creation means a card can
      // now come from admin-entered config, not just code.)
      try {
        const { part, ...hub } = p.hubCard(req); // `part` = the program's already-computed partition; strip it so it never leaks into view props
        const card = { key: p.key, emoji: p.emoji, name: p.displayName, href: p.paths.run, ...hub };
        card.friendsGoing = fgMap.get(p.id + '|' + card.runDate) || [];
        card.mine = a ? myRunStatusFor(p.id, card.runDate, email, part) : null; // reuses the hub card's partition (no 2nd partition)
        runs.push(card);
      } catch (e) { console.error(`[runs] hub card for program ${p.id} (${p.key}) FAILED: ${e.message}`); }
    }

    // ---- Home-screen redesign: "Welcome, {name}", a current-week calendar strip with a dot on
    // each day that has a run, and a Past-games list (the member's recent attended runs). ----
    const firstName = ((a?.full_name || email).trim().split(/\s+/)[0]) || 'there';
    const pastRuns = a ? stmtHubPast.all(email)
      .filter(r => PROGRAMS.has(r.program_id))
      .map(r => ({ name: PROGRAMS.get(r.program_id).displayName, emoji: PROGRAMS.get(r.program_id).emoji, runDate: r.run_date, programId: r.program_id, key: PROGRAMS.get(r.program_id).key })) : [];

    const chatProgram = chatProgramFor(req);
    const cc = chatCountsFor(chatProgram || 1, email, a ? a.id : 0);
    res.send(runsPage({
      email, runs, canJoin, status,
      firstName, pastRuns,
      isAdmin: viewerIsAdmin,
      canOperate: viewerIsAdmin || !!(a && a.is_team),
      needsWaiver: !!(a && !a.waiver_ok), // tour ends on a "sign your waiver" step for players who haven't
      needsDob: !!(a && !a.dob), // legacy members (pre-DOB signup) — nudge them to add it so the age gate applies
      dmUnread: unreadCount(email),
      groupUnread: cc.group,
      groupMention: cc.gm,
      chatProgram,
      ann: annPanel(email),
    }));
  });
  app.get('/runs/past/:pid/:date', requireLogin, (req, res) => {
    const email = req.userEmail;
    const a = applicantByEmail(email);
    const admin = isAdmin(email);
    if (!admin && (!a || a.status !== 'approved')) return res.redirect('/status');
    const pid = Number(req.params.pid), rd = String(req.params.date);
    const p = PROGRAMS.get(pid);
    if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(rd)) return res.redirect('/runs');
    if (p.config.static && !admin) return res.redirect('/runs');   // demo archive is admin-only
    const rows = stmtPastRoster.all(pid, rd).map(r => ({ ...r, minor: isMinor(r) }));
    const chatProgram = chatProgramFor(req);
    const cc = chatCountsFor(chatProgram || 1, email, a ? a.id : 0);
    res.send(pastRunPage({
      name: p.displayName, emoji: p.emoji, runDate: rd, rows,
      dmUnread: unreadCount(email), groupUnread: cc.group, groupMention: cc.gm, chatProgram,
      ann: annPanel(email),
    }));
  });
}
