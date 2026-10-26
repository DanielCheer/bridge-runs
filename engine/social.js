// engine/social.js — the social graph (social_edges): friends, follows and blocks, the who-can-
// message-whom rule, directory search, and the friends'-games list.
import db from '../db.js';
import { isAdmin } from '../auth.js';
import { lc } from '../lib/email.js';
import { ymdLocal, schedNow } from '../lib/dates.js';
import { isMinor } from './applicants.js';
import { P } from './programs.js';
import { dropSharedPartyMemberships } from './parties.js';

function canMessage(senderEmail, senderA, recip) {
  if (!recip || recip.status !== 'approved') return false;
  if (recip.email === senderEmail) return false;            // no messaging yourself
  if (/@guest\.local$/.test(recip.email)) return false;     // guest placeholders aren't accounts
  if (blockedPair(senderEmail, recip.email)) return false;  // a blocked pair (either direction) can't DM (Phase 6)
  if (isAdmin(senderEmail)) return true;                    // admin → any approved member, incl. a minor (safeguarding oversight; works even for a row-less admin)
  if (isMinor(senderA)) return false;                       // a known minor can't use 1:1 DMs at all (safeguarding)
  if (isMinor(recip)) return false;                         // and NO non-admin may DM a known minor (adults 18+ included)
  if (senderA && senderA.is_host) return true;              // host → anyone approved
  // Player-to-player DMs: any approved player may message any other approved player.
  return !!(senderA && (senderA.status === 'approved' || senderA.is_team));
}

// UNIVERSAL, person-to-person (see `social_edges` in db.js — a directed edge table keyed on
// two emails). Friends power queue-with-friends + "view friends' games"; block is the safety
// valve consumed as a seating/team invariant (Phase 6b). This layer is program-agnostic: a
// friendship is one edge for the whole platform, not one per run.
//
// IDOR model: every mutating route takes a TARGET applicant id in the POST body, resolves it
// to that person's email SERVER-SIDE (the client never sends an email), and mutates ONLY the
// logged-in user's own edges — req.userEmail is the sole identity, so a forged body can never
// act as, or on behalf of, another person.
// Hoisted reads (relationshipTo runs on every profile view; the list reads on /friends).
const stmtFriendEdge  = db.prepare(`SELECT from_email,to_email,status FROM social_edges WHERE kind='friend' AND ((from_email=? AND to_email=?) OR (from_email=? AND to_email=?)) LIMIT 1`);
const stmtAreFriends  = db.prepare(`SELECT 1 FROM social_edges WHERE kind='friend' AND status='accepted' AND ((from_email=? AND to_email=?) OR (from_email=? AND to_email=?)) LIMIT 1`);
const stmtBlockAny    = db.prepare(`SELECT 1 FROM social_edges WHERE kind='block' AND ((from_email=? AND to_email=?) OR (from_email=? AND to_email=?)) LIMIT 1`);
const stmtBlockDir    = db.prepare(`SELECT 1 FROM social_edges WHERE kind='block' AND from_email=? AND to_email=? LIMIT 1`);
const stmtFriendsOf   = db.prepare(`SELECT CASE WHEN from_email=? THEN to_email ELSE from_email END AS email FROM social_edges WHERE kind='friend' AND status='accepted' AND (from_email=? OR to_email=?)`);
const stmtReqIncoming = db.prepare(`SELECT from_email AS email, created_at FROM social_edges WHERE kind='friend' AND status='requested' AND to_email=? ORDER BY created_at DESC`);
const stmtReqOutgoing = db.prepare(`SELECT to_email   AS email, created_at FROM social_edges WHERE kind='friend' AND status='requested' AND from_email=? ORDER BY created_at DESC`);
const stmtBlockedByMe = db.prepare(`SELECT to_email   AS email, created_at FROM social_edges WHERE kind='block' AND from_email=? ORDER BY created_at DESC`);
// Follow (one-way, Javelin-style: "X started following you — follow back"). No accept step.
const stmtIsFollowing = db.prepare(`SELECT 1 FROM social_edges WHERE kind='follow' AND from_email=? AND to_email=? LIMIT 1`);
const stmtFollowersOf = db.prepare(`SELECT from_email AS email, created_at FROM social_edges WHERE kind='follow' AND to_email=? ORDER BY created_at DESC`);
const stmtFollowingOf = db.prepare(`SELECT to_email   AS email, created_at FROM social_edges WHERE kind='follow' AND from_email=? ORDER BY created_at DESC`);

const areFriends  = (a, b) => (a = lc(a), b = lc(b), !!stmtAreFriends.get(a, b, b, a));
const blockedPair = (a, b) => (a = lc(a), b = lc(b), !!stmtBlockAny.get(a, b, b, a)); // block in EITHER direction (Phase 6b invariant)
const iBlocked    = (a, b) => !!stmtBlockDir.get(lc(a), lc(b));                        // directed: did `a` block `b`?
const friendsOf   = me => (me = lc(me), stmtFriendsOf.all(me, me, me).map(r => r.email));
const isFollowing = (a, b) => !!stmtIsFollowing.get(lc(a), lc(b));                     // directed: does `a` follow `b`?
const followersOf = me => stmtFollowersOf.all(lc(me)).map(r => r.email);               // who follows me
const followingOf = me => stmtFollowingOf.all(lc(me)).map(r => r.email);               // who I follow
// "Friends" = we follow EACH OTHER (mutual). This is the consent boundary for seeing someone's
// game attendance — a one-way follow is NOT enough, so you never broadcast where you'll be to
// someone who hasn't followed you back.
const mutualFollowsOf = me => { const back = new Set(followersOf(me).map(e => lc(e))); return followingOf(me).filter(e => back.has(lc(e))); };
const friendReqIncomingCount = me => stmtReqIncoming.all(lc(me)).length;

// `me` is always req.userEmail (never a body field). Handlers are no-ops on bad/foreign input.
function friendRequest(me, them) {
  me = lc(me); them = lc(them);
  if (!them || me === them || blockedPair(me, them)) return;
  const e = stmtFriendEdge.get(me, them, them, me);
  if (e) {
    // If THEY already requested ME, my "request" accepts theirs (the natural mutual handshake).
    if (e.status === 'requested' && e.from_email === them)
      db.prepare(`UPDATE social_edges SET status='accepted', updated_at=datetime('now') WHERE kind='friend' AND from_email=? AND to_email=?`).run(them, me);
    return; // already friends, or I already asked → idempotent no-op
  }
  db.prepare(`INSERT INTO social_edges(from_email,to_email,kind,status) VALUES (?,?,'friend','requested')`).run(me, them);
}
function friendAccept(me, them) { // only the request's TARGET (to_email = me) can accept it
  me = lc(me); them = lc(them);
  db.prepare(`UPDATE social_edges SET status='accepted', updated_at=datetime('now')
              WHERE kind='friend' AND status='requested' AND from_email=? AND to_email=?`).run(them, me);
}
function friendDecline(me, them) { // decline an incoming request OR rescind my own outgoing one
  me = lc(me); them = lc(them);
  db.prepare(`DELETE FROM social_edges WHERE kind='friend' AND status='requested'
              AND ((from_email=? AND to_email=?) OR (from_email=? AND to_email=?))`).run(me, them, them, me);
}
function friendRemove(me, them) { // either party unfriends; drops the accepted edge either way
  me = lc(me); them = lc(them);
  db.prepare(`DELETE FROM social_edges WHERE kind='friend'
              AND ((from_email=? AND to_email=?) OR (from_email=? AND to_email=?))`).run(me, them, them, me);
}
function doBlock(me, them) { // one-way; auto-removes any friendship AND any follow in EITHER direction
  me = lc(me); them = lc(them);
  if (!them || me === them) return;
  db.prepare(`DELETE FROM social_edges WHERE kind IN ('friend','follow')
              AND ((from_email=? AND to_email=?) OR (from_email=? AND to_email=?))`).run(me, them, them, me);
  db.prepare(`INSERT OR IGNORE INTO social_edges(from_email,to_email,kind,status) VALUES (?,?,'block','accepted')`).run(me, them);
  dropSharedPartyMemberships(me, them); // block invariant also holds for parties already formed (P2-1)
}
function doUnblock(me, them) { // only the blocker (from_email) can lift their own block
  me = lc(me); them = lc(them);
  db.prepare(`DELETE FROM social_edges WHERE kind='block' AND from_email=? AND to_email=?`).run(me, them);
}
function doFollow(me, them) { // one-way, immediate (no accept); barred across a block either way
  me = lc(me); them = lc(them);
  if (!them || me === them || blockedPair(me, them)) return;
  db.prepare(`INSERT OR IGNORE INTO social_edges(from_email,to_email,kind,status) VALUES (?,?,'follow','accepted')`).run(me, them);
}
function doUnfollow(me, them) {
  me = lc(me); them = lc(them);
  db.prepare(`DELETE FROM social_edges WHERE kind='follow' AND from_email=? AND to_email=?`).run(me, them);
}
// Relationship of `me` toward `other` for button rendering.
function relationshipTo(me, other) {
  me = lc(me); other = lc(other);
  if (!other || me === other) return 'self';
  if (iBlocked(me, other)) return 'blocked';       // I blocked them
  if (iBlocked(other, me)) return 'blocked_by';    // they blocked me (hide friend affordances)
  const e = stmtFriendEdge.get(me, other, other, me);
  if (!e) return 'none';
  if (e.status === 'accepted') return 'friends';
  return e.from_email === me ? 'outgoing' : 'incoming';
}
// Bulk email → applicants row (id/name/avatar/status/badges), for turning edge lists into UI.
function peopleByEmails(emails) {
  const uniq = [...new Set((emails || []).map(lc))].filter(Boolean);
  const m = new Map();
  if (!uniq.length) return m;
  const ph = uniq.map(() => '?').join(',');
  for (const r of db.prepare(
    `SELECT id, full_name, email, avatar, status, is_host, is_team, is_regular, dob FROM applicants WHERE email IN (${ph})`).all(...uniq))
    m.set(lc(r.email), r);
  return m;
}
// "Friends' Games" — upcoming runs (ACTIVE programs only) where an accepted friend of `me` is on
// the roster. Grouped per (program, run_date) with the friends going + a Join link to that run.
function friendsGamesFor(me) {
  const fr = mutualFollowsOf(me); // FRIENDS = mutual follow — you see someone's games only if you follow each other
  if (!fr.length) return [];
  const today = ymdLocal(new Date(schedNow()));
  const ph = fr.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT c.program_id AS pid, c.run_date AS rd, c.email, c.name
      FROM checkins c JOIN program p ON p.id = c.program_id
     WHERE p.active = 1 AND c.run_date >= ? AND c.email IN (${ph})
     ORDER BY c.run_date, c.program_id, c.name COLLATE NOCASE`).all(today, ...fr);
  const groups = new Map();
  for (const r of rows) {
    const k = r.pid + '|' + r.rd;
    if (!groups.has(k)) groups.set(k, { programId: r.pid, runDate: r.rd, friends: [] });
    groups.get(k).friends.push({ email: r.email, name: r.name });
  }
  return [...groups.values()].map(g => ({
    ...g,
    programName: P(g.programId).displayName || P(g.programId).config?.name || 'Run',
    emoji: P(g.programId).emoji || '',
    href: P(g.programId).paths.run,
  }));
}

// Directory search → renderable rows {id,name,email,following,blocked} (approved non-guest, not me).
// Shared by the /friends page + the /friends/search typeahead fragment.
const stmtDirectorySearch = db.prepare(`
    SELECT id, full_name, email, status FROM applicants
    WHERE (full_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\') AND email <> ?
    ORDER BY (CASE WHEN full_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END), full_name COLLATE NOCASE
    LIMIT 25`);
function searchResultsFor(me, q) {
  q = String(q || '').trim().slice(0, 60);
  if (!q) return [];
  const like = q.replace(/[\\%_]/g, c => '\\' + c);
  const rows = stmtDirectorySearch.all('%' + like + '%', '%' + like + '%', lc(me), like + '%');
  return rows.filter(r => r.status === 'approved' && !/@guest\.local$/.test(r.email))
    .map(r => ({ id: r.id, name: r.full_name, email: r.email, following: isFollowing(me, r.email), blocked: blockedPair(me, r.email) }));
}

export {
  friendsGamesFor, canMessage, blockedPair, iBlocked, isFollowing, relationshipTo, friendsOf,
  followersOf, friendReqIncomingCount, stmtBlockedByMe, followingOf, peopleByEmails, searchResultsFor,
  friendRequest, friendAccept, friendDecline, friendRemove, doBlock, doUnblock, doFollow, doUnfollow,
};
