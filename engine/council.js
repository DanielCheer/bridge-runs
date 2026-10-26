// engine/council.js — the council vote's consequence: recomputing an applicant's status from the
// votes, and releasing a rejected player's seats.
import db from '../db.js';
import { VOTE_THRESHOLD } from '../config.js';
import { approverEmails } from './applicants.js';
import { nextRunDate } from './basketball-calendar.js';
import { createOffer, offereeForFloorLeave } from './seating.js';
import { dropFromPickleball } from './run-engine.js';

// Symmetric threshold: VOTE_THRESHOLD approvals → approved,
// VOTE_THRESHOLD rejects → rejected, otherwise pending.
// Team members are auto-approved and never voted on.
function recomputeStatus(id) {
  const app = db.prepare('SELECT id,email,is_team,status FROM applicants WHERE id = ?').get(id);
  if (!app || app.is_team) return app?.status;
  const pool = approverEmails();
  const votes = db.prepare('SELECT voter_email,vote FROM votes WHERE applicant_id = ?').all(id)
    .filter(v => pool.has(v.voter_email.toLowerCase()));   // ignore votes from ex-approvers
  const approves = votes.filter(v => v.vote === 'approve').length;
  const rejects = votes.filter(v => v.vote === 'reject').length;
  let status = 'pending';
  if (rejects >= VOTE_THRESHOLD) status = 'rejected';
  else if (approves >= VOTE_THRESHOLD) status = 'approved';
  if (status !== app.status) {
    db.prepare('UPDATE applicants SET status = ? WHERE id = ?').run(status, id);
    if (status === 'rejected') {
      // Dropping a rejected player off the floor frees a slot — offer it onward (capture
      // the offeree BEFORE the delete) instead of silently auto-promoting the waitlist.
      const runDate = nextRunDate();
      const offeree = offereeForFloorLeave(runDate, app.email);
      db.prepare('DELETE FROM checkins WHERE email = ? AND program_id = 1').run(app.email); // basketball floor only; the cascade below handles every other program
      if (offeree) createOffer(runDate, offeree, null);
      dropFromPickleball(app.email);   // a rejected player leaves EVERY opt-in program's floor (P2-2)
    }
  }
  return status;
}

export {
  recomputeStatus,
};
