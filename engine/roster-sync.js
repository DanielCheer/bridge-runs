// engine/roster-sync.js — the weekly roster for runs whose sign-ups live in Planning Center
// Registrations (run_roster).
import db, { transact } from '../db.js';
import { pcoSignupRosterForDate } from '../pco.js';
import { audit } from '../lib/audit.js';
import { lc } from '../lib/email.js';
import { P } from './programs.js';
import { clearTeamAssignment } from './teams.js';

// This writes to run_roster, NOT to checkins. See the table comment in db.js: checkins is an
// economy (sweep, offers, penalties) that assumes a row can respond, and a synced registrant never
// opens this app. The first version of this wrote to checkins and the confirm sweep would have
// deleted the whole roster at 4:30 PM on run day.
//
// A sync is a full RECONCILE of its own source, not an append: someone who cancels in Planning
// Center after the first sync has to actually leave the list, or re-syncing courtside silently
// keeps a player who is not coming.
async function syncRunRosterFromPco(programId, rd, byEmail) {
  const cfg = P(programId).config;
  if (!cfg.pcoSignupPrefix) throw new Error('This run has no Planning Center signup configured.');
  const { signup, people } = await pcoSignupRosterForDate(cfg.pcoSignupPrefix, rd);
  if (!signup) return { signup: null, added: 0, removed: 0, kept: 0, skipped: 0, unresolved: 0 };
  // Only people actually holding a spot. A cancelled or waitlisted registration is not on the
  // roster, and showing them would have the operator building sides around someone who isn't there.
  const active = people.filter(x => x.active && !x.waitlisted);
  // Asked Planning Center and it did not answer. Excluded from the roster, never defaulted into
  // one: an error is not a fact about this person, and the operator is told the count so a re-sync
  // picks them up. Failing the whole sync instead would be worse courtside — the other fifteen
  // players would lose their teams because one lookup 500'd.
  const unresolved = active.filter(x => x.emailError && !x.email).length;
  const seen = new Set();
  const rows = [];
  for (const person of active) {
    if (person.emailError && !person.email) continue;
    // No address in PCO = no identity here. A synthetic one keyed on the PCO person id is STABLE
    // across syncs; a random one would mint a fresh phantom player every time the button is tapped.
    const email = lc(person.email || (person.pcoId ? `pco-${person.pcoId}@adv.local` : ''));
    if (!email || seen.has(email)) continue;   // one row per human, even if PCO lists them twice
    seen.add(email);
    rows.push({ email, name: person.name });
  }
  let added = 0, kept = 0, removed = 0;
  transact(() => {
    const before = new Set(db.prepare("SELECT email FROM run_roster WHERE program_id = ? AND run_date = ? AND source = 'pco'")
      .all(programId, rd).map(r => lc(r.email)));
    const ins = db.prepare(`INSERT INTO run_roster (program_id, run_date, email, name, source) VALUES (?,?,?,?,'pco')
      ON CONFLICT(program_id, run_date, email) DO UPDATE SET name = excluded.name, synced_at = datetime('now')`);
    for (const r of rows) { ins.run(programId, rd, r.email, r.name); before.has(r.email) ? kept++ : added++; }
    // Anyone this source put here who is no longer registered. Hand-added rows (source <> 'pco')
    // are never touched by a sync.
    const gone = [...before].filter(e => !seen.has(e));
    for (const e of gone) {
      db.prepare("DELETE FROM run_roster WHERE program_id = ? AND run_date = ? AND email = ? AND source = 'pco'").run(programId, rd, e);
      clearTeamAssignment(programId, rd, e);   // and off whichever side they were on
    }
    removed = gone.length;
  });
  audit(byEmail, 'admin', `${cfg.logTag || 'run'}:roster-sync`,
    `${rd} from "${signup.name}" — ${added} new, ${kept} unchanged, ${removed} no longer registered`);
  return { signup, added, removed, kept, skipped: people.length - active.length, unresolved };
}

export {
  syncRunRosterFromPco,
};
