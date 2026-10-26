// engine/applicants.js — people: account lookups, age and the under-18 rule, the approved
// population, and the council's approver pool and vote tally.
import db from '../db.js';
import { VOTE_THRESHOLD } from '../config.js';
import { schedNow } from '../lib/dates.js';

// Broadcast audiences. approvedEmails() = every real approved player (used for PUSH,
// which is opt-in per device via a subscription row). announcementRecipients() is the
// same minus anyone who opted OUT of broadcast EMAIL — so an email opt-out can never
// mute push, by construction. Transactional mail (sign-in, invites, spot offers) uses
// neither and always sends.
function approvedEmails() {
  return db.prepare("SELECT email FROM applicants WHERE status = 'approved' AND email NOT LIKE '%@guest.local'")
    .all().map(r => r.email);
}

// The people who vote: TEAM MEMBERS ONLY. Admins run the app but do not vote —
// approval decisions belong to the team (unanimous).
function approverEmails() {
  // The voting pool = explicit council members (owner rule 2026-08-06: council is its own role,
  // separate from team/host/admin; the migration seeded it from team-minus-host so nobody lost
  // their vote on the flip).
  return new Set(
    db.prepare('SELECT email FROM applicants WHERE is_council = 1').all()
      .map(r => r.email.toLowerCase()));
}

// Vote detail for the council UI. `pool` and `votes` are optional pre-loaded inputs:
// the /admin list renders this for every applicant, so it computes the approver pool
// ONCE and batch-loads all votes in a single query, passing them in to avoid an N+1
// (a pool query + a votes query per applicant). Called standalone → they self-load.
function voteInfo(id, viewerEmail, pool = approverEmails(),
                  votes = db.prepare('SELECT voter_email,vote FROM votes WHERE applicant_id = ?').all(id)) {
  const inPool = votes.filter(v => pool.has(v.voter_email.toLowerCase()));
  const approved = inPool.filter(v => v.vote === 'approve').map(v => v.voter_email.toLowerCase());
  const rejected = inPool.filter(v => v.vote === 'reject').map(v => v.voter_email.toLowerCase());
  const voted = new Set(inPool.map(v => v.voter_email.toLowerCase()));
  const waiting = [...pool].filter(e => !voted.has(e));
  const mine = votes.find(v => v.voter_email.toLowerCase() === viewerEmail.toLowerCase());
  return { poolSize: pool.size, threshold: VOTE_THRESHOLD, approved, rejected, waiting, myVote: mine?.vote || null };
}
// Runs on essentially every authenticated request (requirePlayer + several POSTs),
// so the statement is hoisted to module scope (node:sqlite has no stmt cache).
const stmtApplicantByEmail = db.prepare('SELECT * FROM applicants WHERE email = ?');
function applicantByEmail(email) {
  return stmtApplicantByEmail.get(email.toLowerCase());
}
// The viewer's applicant id (for mention scoping). NULL for admins with no row.
function applicantIdOf(email) {
  const a = applicantByEmail(email);
  return a ? a.id : 0;
}

// The SINGLE authorization seam for messaging. Host-only in v1: a player may
// message the host; the host may message any approved, non-guest player. To open
// full DMs later, relax only the final return (+ add a people-picker) — no route
// or schema change. senderA is the sender's applicant row.
// Age from a 'YYYY-MM-DD' dob against the (test-aware) current date. Null if absent/malformed.
function ageFromDob(dob) {
  if (typeof dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const b = new Date(dob + 'T00:00:00'); if (isNaN(b.getTime())) return null;
  const now = new Date(schedNow());
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age;
}
// Safeguarding: a KNOWN minor (dob on file, age < 18) may not use 1:1 direct messages, in either
// direction. Unknown dob → NOT treated as a minor (new signups/invites capture it; legacy members
// can add it in their profile). Group run-chat is monitored/public and is unaffected.
function isMinor(a) { const age = a ? ageFromDob(a.dob) : null; return age != null && age < 18; }

// Shared by the profile popup, full profile, DM thread + DM send (hot member paths). node:sqlite
// has no stmt cache, so hoist this once instead of re-preparing the same SQL on every call.
const stmtApplicantById = db.prepare('SELECT * FROM applicants WHERE id = ?');

export {
  approverEmails, isMinor, applicantByEmail, approvedEmails, ageFromDob, applicantIdOf,
  stmtApplicantById, voteInfo,
};
