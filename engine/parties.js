// engine/parties.js — parties: queue-with-friends groups for one night (signup_groups) and the
// persistent parties people build on the Friends tab, with the invariants that keep them
// consistent when someone blocks, leaves or declines.
import db from '../db.js';
import { lc } from '../lib/email.js';
import { PROGRAMS, programRunDate } from './programs.js';
import { groupQueueFeature } from './seating.js';

// Queue-with-friends (Phase 6b): drop a run's parties + their invites (the run is over/cancelled).
// checkins for that run are deleted by the caller, so their group_id pointers vanish with them.
function clearRunParties(programId, rd) {
  const ids = db.prepare('SELECT id FROM signup_groups WHERE program_id = ? AND run_date = ?').all(programId, rd).map(r => r.id);
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  // Atomic pair — a crash between the deletes would leave member-less group rows that the
  // one-party-per-person guards then read as a live party (P3-3, same idiom as runPartyCheckin).
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM signup_group_members WHERE group_id IN (${ph})`).run(...ids);
    db.prepare('DELETE FROM signup_groups WHERE program_id = ? AND run_date = ?').run(programId, rd);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// A party = buddies who queue for ONE run together and land together — packParties keeps them
// unsplit at partition time (floor-together or wait-together, never 2-on/1-off). Gated by
// config.features.groupQueue (volleyball only): every route below no-ops otherwise, so with the
// flag off no signup_group rows are written and every checkins.group_id stays NULL → seating is
// byte-identical to today. You may invite anyone you FOLLOW (follow-only model) and a blocked pair
// is never allowed into one party (the block invariant, enforced HERE at the mutation boundary; the seating code
// trusts it). group_id is set ONLY via the explicit party check-in (never a solo join), so a party
// never grows under seated members — it lands together in one action or waits together.
const stmtPartyByLeader = db.prepare('SELECT * FROM signup_groups WHERE program_id=? AND run_date=? AND leader_email=?');
const stmtPartyById     = db.prepare('SELECT * FROM signup_groups WHERE id=?');
const stmtMyParty = db.prepare(`SELECT g.* FROM signup_groups g WHERE g.program_id=? AND g.run_date=?
    AND (g.leader_email=? OR EXISTS (SELECT 1 FROM signup_group_members m
      WHERE m.group_id=g.id AND m.email=? AND m.status IN ('invited','joined')))
    ORDER BY CASE WHEN g.leader_email=? THEN 0
      WHEN EXISTS (SELECT 1 FROM signup_group_members m WHERE m.group_id=g.id AND m.email=? AND m.status='joined') THEN 1
      ELSE 2 END, g.id ASC LIMIT 1`);
const stmtPartyJoinedMembers = db.prepare("SELECT email FROM signup_group_members WHERE group_id=? AND status='joined'");
const stmtPartyActiveMembers = db.prepare("SELECT email FROM signup_group_members WHERE group_id=? AND status IN ('invited','joined')");
// The party `email` belongs to for this run (leads it, or is an invited/joined member).
function myParty(programId, rd, email) {
  email = lc(email);
  // Deterministic when the viewer touches more than one party this run: prefer the one they LEAD,
  // then one they've JOINED, then a pending INVITE — so leave/disband/check-in act on the party
  // they actually own, not an arbitrary inbound invite (P2-4).
  return stmtMyParty.get(programId, rd, email, email, email, email);
}
function partyJoinedEmails(groupId) { // leader (implicitly in) + accepted members
  const g = stmtPartyById.get(groupId); if (!g) return [];
  const m = stmtPartyJoinedMembers.all(groupId).map(r => r.email);
  return [lc(g.leader_email), ...m];
}
function partyAllEmails(groupId) { // leader + everyone still in play (for block checks + size cap)
  const g = stmtPartyById.get(groupId); if (!g) return [];
  const m = stmtPartyActiveMembers.all(groupId).map(r => r.email);
  return [lc(g.leader_email), ...m];
}
// Keep checkins.group_id in lockstep with a party's JOINED membership: stamp joined members who
// have a checkin, clear anyone no longer joined. Called after every membership change + check-in.
function resyncPartyGroupIds(groupId) {
  const g = stmtPartyById.get(groupId); if (!g) return;
  const joined = partyJoinedEmails(groupId);
  if (joined.length) {
    const ph = joined.map(() => '?').join(',');
    db.prepare(`UPDATE checkins SET group_id=? WHERE program_id=? AND run_date=? AND email IN (${ph})`).run(groupId, g.program_id, g.run_date, ...joined);
    db.prepare(`UPDATE checkins SET group_id=NULL WHERE group_id=? AND email NOT IN (${ph})`).run(groupId, ...joined);
  } else {
    db.prepare('UPDATE checkins SET group_id=NULL WHERE group_id=?').run(groupId);
  }
}
// Blocking someone must break any party they currently SHARE with the blocker (the block invariant
// is only enforced at invite/accept, so a block AFTER both joined would otherwise still seat them
// together — P2-1). For every active queue-with-friends run this week, drop the non-leader of the
// pair from any party containing both, then resync group_ids off the floor.
function dropSharedPartyMemberships(a, b) {
  a = lc(a); b = lc(b);
  if (!a || !b || a === b) return;
  for (const p of PROGRAMS.values()) {
    if (!groupQueueFeature(p.id)) continue;
    const rd = programRunDate(p.id);
    for (const party of db.prepare('SELECT id, leader_email FROM signup_groups WHERE program_id=? AND run_date=?').all(p.id, rd)) {
      const all = partyAllEmails(party.id);
      if (!(all.includes(a) && all.includes(b))) continue;
      const drop = lc(party.leader_email) === a ? b : a; // keep the leader of the pair; drop the other (always a member row)
      db.prepare('DELETE FROM signup_group_members WHERE group_id=? AND email=?').run(party.id, drop);
      resyncPartyGroupIds(party.id);
    }
  }
  // PERSISTENT party too (P2-1): a blocked pair must not stay in one party — else next week's
  // one-tap check-in re-seats them together (the block invariant only ran at invite/accept).
  // Same rule: keep the leader of the pair, drop the other's membership row.
  for (const pp of db.prepare(`SELECT p.id, p.leader_email FROM parties p WHERE
      (lower(p.leader_email) IN (?, ?) OR EXISTS (SELECT 1 FROM party_members m WHERE m.party_id = p.id AND m.email IN (?, ?)))`).all(a, b, a, b)) {
    const all = persistentPartyActive(pp);
    if (!(all.includes(a) && all.includes(b))) continue;
    const drop = lc(pp.leader_email) === a ? b : a;
    db.prepare('DELETE FROM party_members WHERE party_id=? AND email=?').run(pp.id, drop);
  }
}
// A member who leaves / is pulled off the floor drops out of their party too (status→declined), so
// a later "check in my group" can't silently re-seat them (P2-2). Leaders are left alone — they
// disband via the party panel. No-op unless the run has queue-with-friends on.
function setPartyDeclinedFor(programId, rd, email) {
  if (!groupQueueFeature(programId)) return;
  email = lc(email);
  const party = myParty(programId, rd, email);
  if (!party || lc(party.leader_email) === email) return;
  db.prepare("UPDATE signup_group_members SET status='declined' WHERE group_id=? AND email=?").run(party.id, email);
  resyncPartyGroupIds(party.id);
}
// Invite someone I follow into my party for this run (I lead it; created lazily). Follow-only +
// block invariant + party-size cap. Returns silently on any violation (swap re-renders the page).
// ---------- PERSISTENT PARTIES (Friends-tab layer) ----------
// A party is created ONCE on the Friends tab, invites/accepts happen there, and "Check in as
// party" on any group-queue run INSTANTIATES the per-run signup_groups machinery from it — so
// packParties atomic seating, party-aware team fill, dots, sweeps all work unchanged downstream.
// One party per person (as leader or joined member). Party check-in = "we're coming": every
// seated member gets confirmed_at (owner rule — no separate confirm step, sweep-shielded).
const stmtPartyLedBy = db.prepare('SELECT * FROM parties WHERE leader_email=?');
const stmtPartyRow = db.prepare('SELECT * FROM parties WHERE id=?');
const stmtPartyJoinedIn = db.prepare(`SELECT p.* FROM parties p JOIN party_members m ON m.party_id=p.id
    WHERE m.email=? AND m.status='joined' LIMIT 1`);
const stmtPartyInvitesFor = db.prepare(`SELECT m.party_id, p.leader_email, p.name FROM party_members m
    JOIN parties p ON p.id=m.party_id WHERE m.email=? AND m.status='invited'`);
const stmtPartyMemberRows = db.prepare('SELECT email, status FROM party_members WHERE party_id=? ORDER BY created_at');
const stmtPartyJoinedRows = db.prepare("SELECT email FROM party_members WHERE party_id=? AND status='joined' ORDER BY created_at");
const stmtRunCheckedIn = db.prepare('SELECT email FROM checkins WHERE program_id=? AND run_date=?');
function myPersistentParty(email) { email = lc(email); return stmtPartyLedBy.get(email) || stmtPartyJoinedIn.get(email); }
function persistentPartyEmails(p) { return [lc(p.leader_email), ...stmtPartyJoinedRows.all(p.id).map(r => lc(r.email))]; }          // leader + joined
function persistentPartyActive(p) { return [lc(p.leader_email), ...stmtPartyMemberRows.all(p.id).map(r => lc(r.email))]; }          // + invited (block/size checks)
// The cross-program size cap = the largest groupQueue maxSize any program allows (config-derived).
function partyCap() { let m = 0; for (const p of PROGRAMS.values()) { const g = groupQueueFeature(p.id); if (g) m = Math.max(m, g.maxSize || 4); } return m || 4; }

export {
  dropSharedPartyMemberships, clearRunParties, setPartyDeclinedFor, stmtPartyInvitesFor,
  stmtPartyMemberRows, myPersistentParty, partyCap, stmtPartyLedBy, persistentPartyActive,
  stmtPartyRow, stmtPartyByLeader, stmtPartyById, partyJoinedEmails, resyncPartyGroupIds,
  persistentPartyEmails, stmtRunCheckedIn,
};
