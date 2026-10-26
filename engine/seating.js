// engine/seating.js — the unified seating engine: who is on the floor, offered a spot, or waiting
// (partitionFor), party packing, the waitlist offer-and-claim cycle (createOffer, expiry,
// re-offer), seating a waiting guest, waitlist-shift pings, and the run summary written at
// rollover.
import crypto from 'crypto';
import db from '../db.js';
import { OFFER_WINDOW_HOURS, FORCE_HELD_RELEASED, PORT, PUBLIC_URL } from '../config.js';
import { sendSpotOffer } from '../mailer.js';
import { audit, metric } from '../lib/audit.js';
import { lc } from '../lib/email.js';
import { sendPush } from '../lib/push.js';
import { runLabelFor, runWeekday } from '../lib/dates.js';
import { isMinor } from './applicants.js';
import { P } from './programs.js';

const OFFER_WINDOW_MS = OFFER_WINDOW_HOURS * 60 * 60 * 1000;

// Prepared once at startup (hot path), not per request.
const stmtRun = db.prepare(`
  SELECT c.*, COALESCE(a.status,'') AS pstatus,
         COALESCE(a.is_team,0) AS is_team, COALESCE(a.is_regular,0) AS is_regular,
         COALESCE(a.is_host,0) AS is_host, COALESCE(a.position,'') AS position,
         a.id AS applicant_id, COALESCE(a.dob, c.dob) AS eff_dob
  FROM checkins c LEFT JOIN applicants a ON a.email = c.email
  WHERE c.run_date = ? AND c.program_id = ? ORDER BY c.sort_order ASC, c.id ASC`);

// Held late-regulars are released onto the floor from 4pm on the RUN DAY onward — keyed
// to the actual run date so it stays correct when the host moves the run off Friday.
function heldReleased(runDate, d = new Date()) {
  if (FORCE_HELD_RELEASED) return true; // test hook only
  return d.getTime() >= new Date(runDate + 'T16:00:00').getTime();
}

// Partition a run's check-ins into floor / offered-and-held / waitlist. Pure (no
// mutation, no side effects) so it's safe to call from drop handlers to decide who
// to offer BEFORE mutating. Ordering is the canonical sort_order,id from stmtRun.
//
//   HELD-SPOT ACCOUNTING: a waitlister with a pending offer (offered_at set) is NOT
//   a real floor player — but the spot is HELD for them: each pending offer consumes
//   one floor slot, so real players only fill (CAP − offered.length) slots and the
//   overflow stays on the waitlist. going/full therefore count real + held = taken.
//   Clearing the offer (on claim) drops offered.length by one, freeing the real slot
//   for that same person, so they slide onto the floor positionally with no overfill.
// Partition an OFFER-WINDOW run (basketball, and volleyball later) reading P(id).config for the
// caps + a program-scoped roster query. partitionRun keeps the program-1 (basketball) entry so its
// ~15 call sites are untouched; a future offer-window program partitions through the SAME code by
// passing its id — this is the reusable half of the engine (pickleball uses simplePartition).
// config.features.groupQueue → {maxSize} | falsy. The read pattern mirrors teamsFeature.
function groupQueueFeature(programId) { const f = P(programId).config.features; return (f && f.groupQueue) || null; }
// Party-atomic floor packing (Phase 6b, queue-with-friends). Splits an ordered roster slice into
// floor + waitlist so a PARTY (checkins sharing a group_id) is never split: a party boards only if
// it fits ENTIRELY in the remaining floor capacity, else the whole party waits and we skip ahead to
// fill the gap with smaller units behind it. Solos are size-1 units → when NOTHING has a group_id
// this is byte-identical to `list.slice(0, capacity)` (proven), so the solo path never changes.
function packParties(list, capacity) {
  const byGroup = new Map();
  const units = [];                       // {rows, anchor} — solo/party units
  list.forEach((r, i) => {
    if (r.group_id == null) { units.push({ rows: [r], anchor: i }); }
    else if (byGroup.has(r.group_id)) { const u = byGroup.get(r.group_id); u.rows.push(r); u.anchor = i; } // anchor = LATEST member's roster position (P1-2)
    else { const u = { rows: [r], anchor: i }; byGroup.set(r.group_id, u); units.push(u); }
  });
  // A party is placed at its LATEST member's position, never its earliest — so a member's early
  // (e.g. solo) check-in can't drag the whole party onto the floor ahead of the queue and bump a
  // seated player (P1-2). `list` is pre-sorted, so for all-solos every anchor == its own index →
  // this stable sort is a no-op and packParties still reduces to list.slice(0, capacity).
  units.sort((a, b) => a.anchor - b.anchor);
  const floor = [], wait = [];
  let remaining = capacity;
  for (const u of units) {
    if (u.rows.length <= remaining) { floor.push(...u.rows); remaining -= u.rows.length; }
    else wait.push(...u.rows);
  }
  return { floor, wait };
}
function offerPartition(programId, runDate) {
  const cfg = P(programId).config;
  const rows = stmtRun.all(runDate, programId).map(r => ({
    ...r, tryout: r.pstatus === 'tryout', team: !!r.is_team, regular: !!r.is_regular,
    host: !!r.is_host,
    guest: /@guest\.local$/.test(r.email),
    minor: isMinor({ dob: r.eff_dob }),   // red safeguarding chip on the roster (real DOB, or a demo checkin DOB)
  }));
  const released = heldReleased(runDate);
  // Before Friday 4pm, held late-regulars are kept off the floor (waitlisted)
  // even if spots are open — those spots stay reserved for normals. After 4pm
  // they're treated like everyone else and can fill any remaining floor spots.
  const active = released ? rows : rows.filter(r => !r.held);
  const heldLate = released ? [] : rows.filter(r => r.held);
  const offered = active.filter(r => r.offered_at != null);   // held pending-claim spots
  const nonOffered = active.filter(r => r.offered_at == null);
  const floorCapForReal = Math.max(0, cfg.cap - offered.length);  // held spots reserve floor slots
  // Party-atomic split when groupQueue is on; otherwise the exact solo slice (reduction-proof).
  let floorReal, overflow;
  if (groupQueueFeature(programId)) {
    ({ floor: floorReal, wait: overflow } = packParties(nonOffered, floorCapForReal));
  } else {
    floorReal = nonOffered.slice(0, floorCapForReal);
    overflow = nonOffered.slice(floorCapForReal);
  }
  const waitPlayers = [...overflow, ...heldLate].slice(0, cfg.waitlist);
  return { rows, active, offered, floorReal, overflow, heldLate, waitPlayers };
}
// Select the partition model from config: offer-window programs (basketball, and volleyball later)
// use the held/offered/floorReal accounting; immediate programs (pickleball) use the simple slice.
// This is the ONE seam a new program flips via config.offerWindow — no per-program branch elsewhere.
function partitionFor(programId, rd) {
  return P(programId).config.offerWindow ? offerPartition(programId, rd) : simplePartition(programId, rd);
}
function partitionRun(runDate) { return partitionFor(1, runDate); }

// True if `email` currently occupies a floor slot (a real floor player OR a held
// offer) — i.e. removing them frees a floor slot that should be offered onward.
function occupiesFloorSlot(part, email) {
  return part.floorReal.some(p => p.email === email) || part.offered.some(p => p.email === email);
}

// The top waitlister eligible for an offer: first overflow player who has a real
// inbox (not a guest placeholder), isn't already offered, and isn't a pre-4pm
// held late-regular. Returns null if nobody's eligible.
function topOfferee(part, exclude = null) {
  return part.waitPlayers.find(p =>
    !p.guest && p.offered_at == null && !p.held && p.email !== exclude) || null;
}

// GUEST PRIORITY (owner rule): a waitlisted GUEST takes any freed floor spot ahead of the
// waitlist. Guests can't do the email claim loop (no inbox), so they're seated IMMEDIATELY —
// floated to the top exactly like an operator Bump (MIN(sort_order)-1; a plain positional swap
// can lose to lower row-ids at the same sort_order). Returns true if a guest took the spot.
// Callers skip the offer / promotion-notify for that spot when this returns true.
const stmtMinSortByRun = db.prepare('SELECT MIN(sort_order) m FROM checkins WHERE run_date = ? AND program_id = ?');
const stmtFloatGuest = db.prepare('UPDATE checkins SET sort_order = ?, held = 0 WHERE run_date = ? AND email = ? AND program_id = ?');
const stmtDelCheckinRow = db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = ?');
const stmtConfirmSet = db.prepare("UPDATE checkins SET confirmed_at = datetime('now') WHERE run_date = ? AND email = ? AND program_id = ? AND confirmed_at IS NULL");
const stmtConfirmClear = db.prepare('UPDATE checkins SET confirmed_at = NULL WHERE run_date = ? AND email = ? AND program_id = ?');
const stmtPmAutoRenew = db.prepare('SELECT auto_renew FROM program_membership WHERE program_id = ? AND email = ?');
function seatWaitingGuest(programId, rd) {
  const cfg = P(programId).config;
  const part = partitionFor(programId, rd);
  const wait = cfg.offerWindow ? part.waitPlayers : part.wait;
  const g = wait.find(p => /@guest\.local$/.test(p.email));
  if (!g) return false;
  const { m } = stmtMinSortByRun.get(rd, programId);
  stmtFloatGuest.run((m ?? 0) - 1, rd, g.email, programId);
  audit('system', 'system', `${cfg.logTag || 'run'}:guest-priority-seat`, g.email);
  return true;
}

// Mark a waitlister's freed floor spot as OFFERED + HELD: stamp offered_at/claim_token
// and email them a one-tap claim link. The `offered_at IS NULL` guard makes this
// idempotent and race-safe (a second concurrent trigger can't double-offer/double-email).
function createOffer(runDate, w, req, programId = 1) {
  const token = crypto.randomBytes(24).toString('base64url');
  const info = db.prepare(
    'UPDATE checkins SET offered_at = ?, claim_token = ? WHERE run_date = ? AND email = ? AND program_id = ? AND offered_at IS NULL')
    .run(Date.now(), token, runDate, w.email, programId);
  if (info.changes === 0) return; // already offered — don't email twice
  const base = PUBLIC_URL || (req ? `${req.protocol}://${req.get('host')}` : `http://localhost:${PORT}`);
  const link = `${base}${P(programId).paths.run}/claim/${token}`;
  audit('system', 'system', 'offer:send', w.email);
  if (!P(programId).config.static) metric('offer_send', { programId, runDate });   // durable funnel count (demo excluded) — audit_log ages out at 5000 rows
  // A STATIC/demo program's players are synthetic (@demo.local) — the offer row + claim token are
  // still created (so the money-moment shows on the roster and the claim button works), but never
  // send a real email/push to a fake address.
  if (P(programId).config.static) return;
  // Don't block the response on the send (mirrors the magic-link / announce sends).
  // Spot offers are time-critical, so they always go by BOTH email (transactional —
  // ignores the email opt-out) AND push. Both point players at /checkin to claim.
  setImmediate(() => {
    sendSpotOffer(w.email, w.name, runLabelFor(runDate), link, OFFER_WINDOW_HOURS, runWeekday(runDate))
      .catch(err => console.error(`[offer] send FAILED for ${w.email}: ${err.message}`));
    sendPush([w.email], {
      title: 'A floor spot opened up',
      body: `Claim your spot for ${runLabelFor(runDate)} — expires in ${OFFER_WINDOW_HOURS}h.`,
      url: P(programId).paths.run, tag: 'offer',
    });
  });
}

// A floor occupant is leaving `runDate` — if they held a floor slot AND an eligible
// waitlister exists, OFFER that freed slot to the top waitlister (offer-and-confirm
// instead of silent auto-promotion). Call BEFORE deleting so the partition still
// sees the true waitlist order (otherwise the top waitlister would auto-promote into
// the floor slice and we'd offer the wrong person). Returns the offeree (or null);
// the caller deletes the leaver, then passes the offeree to createOffer.
function offereeForFloorLeave(runDate, leavingEmail, programId = 1) {
  const part = offerPartition(programId, runDate);
  if (!occupiesFloorSlot(part, leavingEmail)) return null;
  if (seatWaitingGuest(programId, runDate)) return null;   // guest priority: the spot is already filled — no offer
  return topOfferee(part, leavingEmail);
}

// Lazy expiry (no cron): any pending offer past its window is EXPIRED — the person
// dropped from the waitlist (they didn't claim), their held spot freed, and the next
// eligible waitlister offered in their place. Idempotent; safe every request. Run
// this BEFORE computing who to offer/display so a stale hold never blocks the floor.
const stmtExpiredOffers = db.prepare(  // hoisted — runs on every /checkin + /runs GET and the 60s tick
  'SELECT * FROM checkins WHERE run_date = ? AND program_id = ? AND offered_at IS NOT NULL AND offered_at < ?');
function expireAndReoffer(runDate, req, programId = 1) {
  const cutoff = Date.now() - OFFER_WINDOW_MS;
  const expired = stmtExpiredOffers.all(runDate, programId, cutoff);
  if (!expired.length) return;
  const wlBefore = waitlistOrderFor(programId, runDate);   // F4 (P3-2): expiry is the MOST common shift
  for (const ex of expired) {
    // Capture the next offeree BEFORE dropping the expired hold, so the freed slot
    // offers the true top waitlister rather than one auto-promoted by the drop.
    // Guest priority: a waitlisted guest takes the expired hold's spot instead.
    const part = offerPartition(programId, runDate);
    const offeree = seatWaitingGuest(programId, runDate) ? null : topOfferee(part, ex.email);
    db.prepare('DELETE FROM checkins WHERE id = ?').run(ex.id);
    audit('system', 'system', 'offer:expire', ex.email);
    if (!P(programId).config.static) metric('offer_expire', { programId, runDate });
    if (offeree) createOffer(runDate, offeree, req, programId);
  }
  setImmediate(() => pingWaitlistShift(programId, runDate, wlBefore));   // F4 (P3-2)
}

// ---- run_summary writer (metrics layer) — call at archive time, BEFORE the purge ----
// Everything here reads state that is deleted moments later (checkins timing + waitlist order,
// run_state.opened_at/cancelled); offer counts come from metrics_events, which is already
// durable, so a re-run can't double-count. INSERT OR IGNORE on PK(run_date, program_id) makes
// the whole write idempotent. A metrics failure must never stall the rollover: fail-loud to the
// console, swallow the throw. floor_n matches the attendance archive (non-guests); filled_at is
// the cap-th non-guest check-in — the "floor full" moment measured from opened_at.
function writeRunSummary(programId, rd) {
  try {
    const cfg = P(programId).config;
    if (cfg.static) return;   // the demo program has no real weeks
    const part = partitionFor(programId, rd);
    const floor = (cfg.offerWindow ? part.floorReal : part.floor) || [];
    const wait = (part.wait || part.waitPlayers || []);
    const isGuest = (p) => /@guest\.local$/.test(p.email || '');
    const floorN = floor.filter((p) => !isGuest(p)).length;
    const guestN = floor.filter(isGuest).length + wait.filter(isGuest).length;
    const waitN = wait.filter((p) => !isGuest(p)).length;
    // Occupancy timeline INCLUDES guests (P3-8): guests occupy floor slots, so a 3-guest night
    // still records filled_at when total occupancy reaches cap. floor_n/wait_n/guest_n keep the
    // member-vs-guest split; this timeline answers "when was the floor full", whoever filled it.
    const times = db.prepare('SELECT created_at FROM checkins WHERE run_date = ? AND program_id = ? ORDER BY created_at ASC')
      .all(rd, programId).map((r) => r.created_at);
    const st = db.prepare('SELECT opened_at, cancelled FROM run_state WHERE run_date = ? AND program_id = ?').get(rd, programId);
    const oc = (k) => db.prepare('SELECT COALESCE(SUM(n),0) s FROM metrics_events WHERE kind = ? AND run_date = ? AND program_id = ?').get(k, rd, programId).s;
    db.prepare(`INSERT OR IGNORE INTO run_summary
      (run_date, program_id, floor_n, wait_n, guest_n, cap, cancelled, opened_at, first_checkin_at, filled_at, offers_sent, offers_claimed, offers_expired)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(rd, programId, floorN, waitN, guestN, cfg.cap ?? null, (st && st.cancelled) ? 1 : 0, (st && st.opened_at) || null,
        times[0] || null, (cfg.cap && times.length >= cfg.cap) ? times[cfg.cap - 1] : null,
        oc('offer_send'), oc('offer_claim'), oc('offer_expire'));
  } catch (e) { console.error(`[metrics] run_summary write failed for ${programId}/${rd}: ${e.message}`); }
}

const stmtPkRoster = db.prepare(`
    SELECT c.email, c.name, c.sort_order, c.id, c.confirmed_at, c.auto_seated, c.group_id,
           a.id AS applicant_id, a.is_host, a.is_team, a.is_regular, COALESCE(a.dob, c.dob) AS eff_dob
    FROM checkins c LEFT JOIN applicants a ON a.email = c.email
    WHERE c.run_date = ? AND c.program_id = ? ORDER BY c.sort_order ASC, c.id ASC`);
// Partition a SIMPLE (no offer-window) run's roster into floor / waitlist by sort order — the
// immediate first-come model (pickleball). Reads P(id).config.cap for the floor size; program-
// scoped roster query. pkPartition keeps the program-2 entry so its call sites are unchanged.
function simplePartition(programId, rd) {
  // Join applicants so the roster rows can open a profile popup + show role badges
  // (guests have no applicant row → applicant_id null → non-tappable, matches basketball).
  const rows = stmtPkRoster.all(rd, programId).map(r => ({ ...r, minor: isMinor({ dob: r.eff_dob }) })); // red safeguarding chip on the roster
  const cap = P(programId).config.cap;
  // Queue-with-friends (volleyball): keep a party (shared group_id) atomic — it boards only if it
  // fits entirely in the remaining floor, else the whole party waits and smaller units behind it
  // fill the gap. group_id is NULL for everyone when groupQueue is off (pickleball) → packParties
  // is byte-identical to the plain slice (the reduction-proof), so pk is untouched.
  if (groupQueueFeature(programId)) {
    const { floor, wait } = packParties(rows, cap);
    return { floor, wait, rows };
  }
  return { floor: rows.slice(0, cap), wait: rows.slice(cap), rows };
}
function pkPartition(rd) { return partitionFor(2, rd); }
// When a FLOOR player leaves, the next waitlister silently crosses onto the floor (pkPartition
// re-slices by order — pickleball has no offer/claim window, it's immediate first-come). Push
// that person so they actually know a spot opened. CALL THIS BEFORE deleting the leaver, passing
// their email — returns nothing, just notifies the promoted waitlister (if any, non-guest).
// Simple-program promotion: notify the first waitlister that a floor spot just freed. Program-
// generic (copy/paths from config); only used by non-offer-window programs (offer-window ones send
// a held offer via createOffer instead). pkNotifyPromotion stays a wrapper.
function notifyPromotionFor(programId, rd, leavingEmail) {
  const cfg = P(programId).config, lv = lc(leavingEmail);
  const part = partitionFor(programId, rd);                      // called for SIMPLE programs, so part.floor is the shape
  if (!part.floor.some(p => lc(p.email) === lv)) return;         // leaver wasn't on the floor → no spot frees
  const oldSet = new Set(part.floor.map(p => lc(p.email)));
  // Recompute the floor as it will be AFTER the leaver's row is deleted (the caller deletes next).
  // Under queue-with-friends a waiting PARTY that still doesn't fit the one freed seat is skipped and
  // a solo behind it is seated instead — so the real promotee(s) come from a partition diff, not
  // wait[0] (P2-2). For a solo run this is exactly the old wait[0].
  const remaining = part.rows.filter(p => lc(p.email) !== lv);
  const newFloor = groupQueueFeature(programId) ? packParties(remaining, cfg.cap).floor : remaining.slice(0, cfg.cap);
  const promoted = newFloor.filter(p => !oldSet.has(lc(p.email)) && !/@guest\.local$/.test(p.email));
  if (!promoted.length) return;
  setImmediate(() => sendPush(promoted.map(p => p.email), { title: cfg.copy.promoTitle, body: cfg.copy.promoBody(rd), url: P(programId).paths.run, tag: `${cfg.logTag}promo` }));
  for (const p of promoted) audit('system', 'system', `${cfg.logTag}:promote`, p.email);
}
function pkNotifyPromotion(rd, leavingEmail) { return notifyPromotionFor(2, rd, leavingEmail); }
// Operator pulls someone off the floor for THIS cycle (no sit-out recorded — an operator action,
// not the player opting out). Same offer-vs-notify split as runLeave.
// Take ONE player off a run's roster + hand their spot onward — the single removal path shared
// by the operator Remove button and the confirm-or-release sweep. Offer-window programs offer
// the freed spot (claim link); simple programs auto-slide the next waitlister up (with the
// promotion push). req may be null (scheduler) — createOffer falls back to PUBLIC_URL.
// F4: tell waitlisters when they MOVE UP. The #1 who reaches the floor already gets the promo
// push; this covers everyone behind them who shuffled forward (top 5 only — "#9 → #8" is noise).
// Snapshot the order before the mutation, compare after, push the improvements.
function waitlistOrderFor(programId, rd) {
  // partitionFor is program-generic; offer-window programs expose waitPlayers, simple ones wait.
  const part = partitionFor(programId, rd);
  return (part.wait || part.waitPlayers || []).map(p => lc(p.email)).filter(e => !/@guest\.local$/.test(e));
}
function pingWaitlistShift(programId, rd, before) {
  try {
    const after = waitlistOrderFor(programId, rd);
    for (let i = 0; i < Math.min(after.length, 5); i++) {
      const was = before.indexOf(after[i]);
      if (was > i) {   // strictly closer to the floor than before
        const pos = i + 1;
        sendPush([after[i]], {
          title: `You're #${pos} on the waitlist`,
          body: `You moved up for ${runWeekday(rd)}'s ${P(programId).displayName.toLowerCase()} — ${pos === 1 ? 'next spot that opens is yours' : 'getting close'}.`,
          url: P(programId).paths.run, tag: `wlmove${programId}`,   // same tag collapses repeat moves
        });
      }
    }
  } catch (e) { console.error(`[wlmove] ping failed: ${e.message}`); }
}

export {
  createOffer, offereeForFloorLeave, heldReleased, partitionFor, writeRunSummary, partitionRun,
  expireAndReoffer, OFFER_WINDOW_MS, pkPartition, waitlistOrderFor, pingWaitlistShift, stmtConfirmSet,
  stmtConfirmClear, stmtDelCheckinRow, seatWaitingGuest, notifyPromotionFor, stmtPmAutoRenew,
  groupQueueFeature,
};
