// routes/checkin.js — basketball's run (program 1, under /checkin): the run page, the player and
// host actions (join, leave, auto-renew, guests, promote, open/close, confirm, opt out/in), the
// offer claim link, cancelling a run, the season board and the .ics calendar file.
import db from '../db.js';
import { OFFER_WINDOW_HOURS } from '../config.js';
import { isAdmin, requireLogin } from '../auth.js';
import { intakePage, checkinPage, claimResultPage, confirmActionPage, seasonPage } from '../views.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { fmtClockLabel, runLabelFor, runWeekday, ymdLocal } from '../lib/dates.js';
import { bannerVersion } from '../lib/media.js';
import { applicantByEmail, approvedEmails } from '../engine/applicants.js';
import { P, effectiveConfirmCutoff, setRunCookie } from '../engine/programs.js';
import {
  CAP, WAITLIST_CAP, TOTAL_CAP, PREREG_CAP, OPEN_H, openDateFor, runTimeRange, runStartLabel,
  runStartEpoch, runIsOpen, runIsCancelled, runIsLocked, runDayFor, nextRunDate, setRunOpen,
  setRunCancelled, runTimesFor,
} from '../engine/basketball-calendar.js';
import { latestAnnouncement, annPanel } from '../engine/announcements.js';
import {
  OFFER_WINDOW_MS, createOffer, offereeForFloorLeave, waitlistOrderFor, pingWaitlistShift,
  partitionRun, stmtConfirmSet, stmtConfirmClear,
} from '../engine/seating.js';
import { groupUnread, groupMentionUnread } from '../engine/chat.js';
import { unreadCount } from '../engine/messages.js';
import { loadRun, autoJoinTeam } from '../engine/basketball.js';
import { requirePlayer, requireApprover } from './guards.js';
import crypto from 'crypto';
import { metric, audit } from '../lib/audit.js';
import { sendPush } from '../lib/push.js';
import { signIn } from '../lib/sign-in.js';
import { migrateConfirmMarkers } from '../engine/run-engine.js';

// Hot-path lookups rendered on the check-in page (and reused by the join guard) —
// prepared once at module scope (node:sqlite has no statement cache).
const stmtOptedOut = db.prepare('SELECT 1 FROM regular_optout WHERE run_date = ? AND email = ? AND program_id = 1');
const stmtMyConfirmed = db.prepare('SELECT confirmed_at FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1'); // hoisted — hottest page
const stmtPreregCount = db.prepare(`SELECT COUNT(*) r FROM checkins c
    JOIN applicants ap ON ap.email = c.email
    WHERE c.run_date = ? AND c.program_id = 1 AND (ap.is_regular = 1 OR ap.is_team = 1)`);
const stmtHostCard = db.prepare("SELECT * FROM applicants WHERE is_host = 1 AND status = 'approved'");

export function mountCheckin(app) {
  app.get('/checkin', requireLogin, (req, res) => {
    const email = req.userEmail;
    // Basketball is apply-to-join. Someone without the role who hasn't applied yet gets the SIGNUP
    // FORM (not a dead-end status page); someone who already applied (pending/rejected) sees their
    // status. Approved players + admins fall through to the roster.
    const meApp = applicantByEmail(email);
    const meStatus = meApp?.status || 'none';
    if (!isAdmin(email) && meStatus !== 'approved')
      return meStatus === 'none' ? res.send(intakePage()) : res.redirect('/status');
    const gate = requirePlayer(req, res);
    if (!gate) return;
    setRunCookie(req, res, 1); // opening basketball → the neutral pages' Chat tab points at basketball
    const { a, viewerIsAdmin } = gate;
    const status = a?.status || 'none';
    const { runDate, inPlayers, offeredPlayers, waitPlayers, totalCount } = loadRun(req);

    // A held offer counts as a taken floor slot (real players + pending offers = going).
    const going = inPlayers.length + offeredPlayers.length;
    const myOfferedRow = offeredPlayers.find(p => p.email === email);
    let myState = 'out';
    if (inPlayers.some(p => p.email === email)) myState = 'in';
    else if (myOfferedRow) myState = 'offered';
    else if (waitPlayers.some(p => p.email === email)) myState = 'waitlist';
    const myWaitPos = myState === 'waitlist'
      ? waitPlayers.findIndex(p => p.email === email) + 1 : 0;
    // The current player's pending offer (for the claim banner + button), if any.
    const myOffer = myOfferedRow
      ? { token: myOfferedRow.claim_token, expiresAt: (myOfferedRow.offered_at || 0) + OFFER_WINDOW_MS }
      : null;

    const iAmTeam = !!(a && a.is_team);
    const iAmRegular = !!(a && a.is_regular);
    const iAutoRenew = !!(a && a.auto_renew);
    const canOperate = viewerIsAdmin || iAmTeam;
    const iOptedOut = !!stmtOptedOut.get(runDate, email);
    const isOpen = runIsOpen(runDate);
    const canSeeCount = isOpen || canOperate || iAmRegular;
    const canSeeRoster = canOperate || iAmRegular || isOpen;
    // pre-registration cap reached (team + regulars) — only relevant while closed
    const preregCount = stmtPreregCount.get(runDate).r;
    const regularSlotsFull = !isOpen && iAmRegular && !iAmTeam && preregCount >= PREREG_CAP && myState === 'out';
    const myConfirmed = myState === 'in' && !!(stmtMyConfirmed.get(runDate, email)?.confirmed_at);

    res.send(checkinPage({
      email, status,
      runLabel: runLabelFor(runDate), runDate,
      hours: runTimeRange(runDate),
      startLabel: runStartLabel(runDate),
      // When check-in actually auto-opens, derived from the schedule — the copy used to hardcode
      // "Wednesday night" + "opens it manually", both wrong since the move to a Wednesday run.
      openDay: runWeekday(openDateFor(runDate)),
      openTime: fmtClockLabel(`${OPEN_H}:00`),
      tipoff: runStartEpoch(runDate),
      cap: CAP, waitlistCap: WAITLIST_CAP,
      going,
      waiting: waitPlayers.length,
      full: going >= CAP,
      runFull: totalCount >= TOTAL_CAP,
      isOpen, canSeeCount,
      regularSlotsFull,
      // Kiosk link parity with the generic run pages — per-program token, operator-mintable.
      kioskUrl: (canOperate && getSetting('kiosk_token_1')) ? `/kiosk/1?k=${getSetting('kiosk_token_1')}` : '',
      myState, myWaitPos, myOffer, offerWindowHours: OFFER_WINDOW_HOURS,
      iAmTeam, iAmCouncil: !!(a && a.is_council), iAmRegular, iOptedOut, iAutoRenew,
      viewerIsAdmin, canOperate, canSeeRoster,
      suspended: !!(a && a.suspended), suspendReason: (a && a.suspend_reason) || '',
      myConfirmed, confirmBy: effectiveConfirmCutoff(P(1).config.confirmCutoff) ? fmtClockLabel(P(1).config.confirmCutoff) : '', msg: req.query.msg || '', bannerVer: bannerVersion(),
      cancelled: runIsCancelled(runDate),
      locked: runIsLocked(runDate),
      announcement: latestAnnouncement(),
      // roster goes to anyone who can see it; controls only to operators
      inPlayers: canSeeRoster ? inPlayers : [],
      offeredPlayers: canSeeRoster ? offeredPlayers : [],
      waitPlayers: canSeeRoster ? waitPlayers : [],
      // the current host (if one is set) → "Meet your host" card
      host: stmtHostCard.get() || null,
      // Operator run-day + cancel controls (HOST/ADMIN only) — moved here from the profile.
      runDay: runDayFor(req, gate),
      rdMsg: req.query.rdset ? String(req.query.rdset) : (req.query.rderr || ''),
      dmUnread: unreadCount(email),
      groupUnread: groupUnread(email),
      groupMention: groupMentionUnread(email, a ? a.id : 0),
      ann: annPanel(email),
    }));
  });
}

export function mountRosterRedirect(app) {
  // ---------- ROSTER (removed) ----------
  // The dedicated Roster tab/page is gone: the full floor list now lives in the
  // who's-going overlay on /checkin (with operator remove/bump controls), and the
  // Run Chat is its own /chat tab. Old bookmarks/links land on check-in.
  app.get('/roster', requireLogin, (req, res) => res.redirect('/checkin'));
}

export function mountCheckinActions(app) {
  // ---------- PICKLEBALL CHAT — delegates to the generic runChat* handlers (program 2) ----------
  app.post('/checkin/join', requireLogin, (req, res) => {
    const email = req.userEmail;
    const a = applicantByEmail(email);
    if (!a || a.status !== 'approved') return res.redirect('/checkin');
    if (a.suspended) return res.redirect('/checkin'); // suspended → can't check in (page shows why)
    if (!a.waiver_ok) return res.redirect('/waiver?next=/checkin'); // one-time waiver before first join
    const runDate = nextRunDate();
    if (runIsCancelled(runDate)) return res.redirect('/checkin'); // run cancelled → no check-in (page shows why)
    if (runIsLocked(runDate)) return res.redirect('/checkin'); // locked at 2 PM → no new self-joins (drops/waitlist still churn; host adds a +1)
    // Pre-access: regulars and team can join while the run is still closed.
    const hasPreAccess = !!(a.is_regular || a.is_team);
    const runOpen = runIsOpen(runDate);
    if (!runOpen && !hasPreAccess) return res.redirect('/checkin');
    const already = db.prepare('SELECT 1 FROM checkins WHERE run_date=? AND email=? AND program_id = 1').get(runDate, email);
    // Pre-register cap: while CLOSED, team + regulars can hold at most PREREG_CAP
    // spots, so at least (floor − cap) survive for normals once you open.
    if (!runOpen && a.is_regular && !a.is_team && !already) {
      const { r } = stmtPreregCount.get(runDate);
      if (r >= PREREG_CAP) return res.redirect('/checkin'); // early spots full; opens to all later
    }
    // Hard cap: 15 floor + 5 waitlist. Past that, nobody new joins.
    if (!already) {
      const { n } = db.prepare('SELECT COUNT(*) n FROM checkins WHERE run_date=? AND program_id = 1').get(runDate);
      if (n >= TOTAL_CAP) return res.redirect('/checkin'); // run + waitlist full
    }
    try {
      // A regular who joins AFTER the run opens is "late" — held on the waitlist
      // until Friday 4pm so the open-phase floor spots stay reserved for normals.
      const isLateRegular = runOpen && a.is_regular && !a.is_team && !already;
      // Joining ON run day IS confirming (same reasoning as claim=confirm) — otherwise a held
      // late-regular released at 4 PM would be swept "unconfirmed" at 4:30 with zero warning.
      const ins = db.prepare("INSERT OR IGNORE INTO checkins (run_date,email,name,held,confirmed_at) VALUES (?,?,?,?, CASE WHEN ? = 1 THEN datetime('now') END)")
        .run(runDate, email, a.full_name, isLateRegular ? 1 : 0, runDate === ymdLocal() ? 1 : 0);
      if (ins.changes) metric('checkin_join', { programId: 1, runDate });   // self check-ins were the one common action with no durable trace
    } catch (e) { console.error(e); }
    res.redirect('/checkin');
  });

  // Claim a held waitlist offer via its one-time link (works signed-out: the token IS
  // the proof of address, same trust model as a magic link). SYNCHRONOUS lookup→check→
  // convert with no await between, so two concurrent taps can't double-claim — the
  // first clears the token, the second finds nothing and gets the friendly expired page.
  // GET renders a confirm page (does NOT claim) so a mail-scanner's bare GET can't auto-claim
  // the offered spot on the player's behalf. POST does the atomic claim (still race-safe — the
  // synchronous read→check→clear can't double-claim). Expiry is owned by loadRun's reoffer.
  app.get('/checkin/claim/:token', (req, res) => {
    const token = req.params.token || '';
    const row = db.prepare('SELECT * FROM checkins WHERE claim_token = ?').get(token);
    if (!row || row.offered_at == null || row.offered_at < Date.now() - OFFER_WINDOW_MS) {
      return res.send(claimResultPage({ ok: false }));
    }
    return res.send(confirmActionPage({
      title: 'Claim your spot', heading: 'A spot opened up', sub: `You've got a floor spot for ${runLabelFor(row.run_date)} — one tap locks it in.`,
      action: '/checkin/claim/' + token, fields: {}, button: 'Claim my spot →',
    }));
  });
  app.post('/checkin/claim/:token', (req, res) => {
    const token = req.params.token || '';
    const row = db.prepare('SELECT * FROM checkins WHERE claim_token = ?').get(token);
    if (!row || row.offered_at == null || row.offered_at < Date.now() - OFFER_WINDOW_MS) {
      return res.send(claimResultPage({ ok: false }));
    }
    // Convert the held offer into a real floor spot (clear the hold → they slide onto
    // the floor positionally) and sign them in. Claiming IS confirming (they tapped "claim
    // my spot") — the ✓ also shields them from the run-day confirm-or-release sweep.
    db.prepare("UPDATE checkins SET offered_at = NULL, claim_token = NULL, confirmed_at = datetime('now') WHERE id = ?").run(row.id);
    audit(row.email, 'player', 'offer:claim', row.email);
    metric('offer_claim', { programId: 1, runDate: row.run_date, meta: `mins=${Math.round((Date.now() - row.offered_at) / 60000)}` });
    signIn(res, row.email, 'spot claim');
    return res.send(claimResultPage({ ok: true, runLabel: runLabelFor(row.run_date), runDate: row.run_date, startLabel: runStartLabel(row.run_date) }));
  });

  app.post('/checkin/leave', requireLogin, (req, res) => {
    const runDate = nextRunDate();
    // If they held a floor slot, offer it to the top waitlister (offer-and-confirm)
    // instead of silently auto-promoting. Capture the offeree BEFORE deleting.
    const wlBefore = waitlistOrderFor(1, runDate);   // F4
    const offeree = offereeForFloorLeave(runDate, req.userEmail);
    db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1').run(runDate, req.userEmail);
    if (offeree) createOffer(runDate, offeree, req);
    setImmediate(() => pingWaitlistShift(1, runDate, wlBefore));
    res.redirect('/checkin');
  });

  // Team member toggles their persistent auto-renew (guaranteed weekly spot).
  app.post('/checkin/autorenew', requireLogin, (req, res) => {
    const a = applicantByEmail(req.userEmail);
    if (a && a.is_team) {
      const on = req.body.on === '1';
      // No waiver, no seat: autoJoinTeam now filters waiver_ok, so turning auto-renew ON without a
      // waiver would silently never seat them while the hero shows "Sit out" as if they were on the
      // floor. Route them to sign the one-time waiver first (mirrors /pickleball/autorenew).
      if (on && !a.waiver_ok) return res.redirect('/waiver?next=/checkin');
      db.prepare('UPDATE applicants SET auto_renew = ? WHERE id = ?').run(on ? 1 : 0, a.id);
      const runDate = nextRunDate();
      if (!on) {
        // opting out of the held-seat system — drop the current auto-spot too. If that
        // spot was on the floor, offer the freed slot to the top waitlister.
        const wlBefore = waitlistOrderFor(1, runDate);   // F4 (P3-2)
        const offeree = offereeForFloorLeave(runDate, req.userEmail);
        db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1').run(runDate, req.userEmail);
        if (offeree) createOffer(runDate, offeree, req);
        setImmediate(() => pingWaitlistShift(1, runDate, wlBefore));
      } else {
        // WIRING: turning auto-renew back ON re-seats them now (autoJoinTeam is
        // rollover-gated in ensureWeek), so this response page shows them seated.
        autoJoinTeam(runDate);
      }
      audit(req.userEmail, 'team', 'auto-renew:' + (on ? 'on' : 'off'), req.userEmail);
    }
    res.redirect('/checkin');
  });

  // --- admin-only game controls ---
  app.post('/checkin/guest', requireApprover, (req, res) => {
    const runDate = nextRunDate();
    if (runIsCancelled(runDate)) return res.redirect('/checkin'); // no adding guests onto a cancelled run (mirrors /pickleball/guest)
    const name = (req.body.name || '').trim().slice(0, 60);
    if (name) {
      // Double-tap guard: a native form re-post within seconds must not add a 2nd identical guest.
      const dup = db.prepare("SELECT 1 FROM checkins WHERE run_date=? AND name=? AND program_id = 1 AND created_at > datetime('now','-5 seconds')").get(runDate, name + ' (guest)');
      if (dup) return res.redirect('/checkin');
      const { n } = db.prepare('SELECT COUNT(*) n FROM checkins WHERE run_date=? AND program_id = 1').get(runDate);
      if (n < TOTAL_CAP) {
        const email = `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@guest.local`;
        db.prepare('INSERT INTO checkins (run_date,email,name) VALUES (?,?,?)').run(runDate, email, name + ' (guest)');
        audit(req.userEmail, req.actorRole, 'checkin:guest-add', name);
      }
    }
    res.redirect('/checkin');
  });
  app.post('/checkin/remove', requireApprover, (req, res) => {
    const runDate = nextRunDate();
    const target = String(req.body.email || '').toLowerCase();
    const wlBefore = waitlistOrderFor(1, runDate);   // F4 snapshot — an operator removal shifts the list too
    // Removing a floor occupant frees a slot → offer it onward (capture before delete).
    const offeree = offereeForFloorLeave(runDate, target);
    db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1').run(runDate, target);
    if (offeree) createOffer(runDate, offeree, req);
    audit(req.userEmail, req.actorRole, 'checkin:remove', target);
    setImmediate(() => pingWaitlistShift(1, runDate, wlBefore));   // F4
    res.redirect('/checkin');
  });

  app.post('/checkin/promote', requireApprover, (req, res) => {
    const runDate = nextRunDate();
    const email = String(req.body.email || '').toLowerCase();
    const wlBefore = waitlistOrderFor(1, runDate);   // F4 snapshot — promoting a waitlister shifts those behind up
    // float this player above everyone currently checked in → they slot into the run,
    // bumping the last person in the run down to the top of the waitlist if it was full
    const { m } = db.prepare('SELECT MIN(sort_order) m FROM checkins WHERE run_date = ? AND program_id = 1').get(runDate);
    const newOrder = (m ?? 0) - 1;
    // Promote finalizes the player onto the floor THROUGH any pending offer: clear the
    // hold so they settle as a real floor player instead of lingering as "⏳ Claiming"
    // (offered_at set → partitionRun would keep counting them as a held offer, not
    // seated, so the bump would appear to do nothing). No-op when they had no offer.
    db.prepare('UPDATE checkins SET sort_order = ?, offered_at = NULL, claim_token = NULL WHERE run_date = ? AND email = ? AND program_id = 1')
      .run(newOrder, runDate, email);
    audit(req.userEmail, req.actorRole, 'checkin:promote', email);
    setImmediate(() => pingWaitlistShift(1, runDate, wlBefore));   // F4: improvements only — a bump-down never pings
    res.redirect('/checkin');
  });

  app.post('/checkin/open', requireApprover, (req, res) => {
    const runDate = nextRunDate();
    if (runIsCancelled(runDate)) return res.redirect('/checkin'); // must un-cancel before opening
    setRunOpen(runDate, true);
    autoJoinTeam(runDate); // team is dropped onto the floor the moment you open
    audit(req.userEmail, req.actorRole, 'run:open', runDate);
    res.redirect('/checkin');
  });
  app.post('/checkin/close', requireApprover, (req, res) => {
    const runDate = nextRunDate();
    setRunOpen(runDate, false);
    audit(req.userEmail, req.actorRole, 'run:close', runDate);
    res.redirect('/checkin');
  });
  // Basketball's kiosk-link mint/rotate — parity with the generic runKioskRotate (basketball still
  // renders the legacy checkinPage, which the per-program kiosk controls never reached). Same token
  // key the /kiosk/:pid route reads; rotating kills only basketball's screens.
  app.post('/checkin/kiosk-rotate', requireApprover, (req, res) => {
    setSetting('kiosk_token_1', crypto.randomBytes(12).toString('base64url'));
    audit(req.userEmail, req.actorRole, 'kiosk:token-rotated', 'program 1');
    res.redirect('/checkin');
  });

  // Cancel / un-cancel THIS week's run (host or admin). Cancelling closes it (setRunCancelled)
  // and pushes a game-day "run cancelled" notice to players; un-cancelling leaves it closed for
  // the host to re-open deliberately. Per run_date, so next week is unaffected. No-op guarded.
  app.post('/admin/run/cancel', requireLogin, (req, res) => {
    const email = req.userEmail;
    const a = applicantByEmail(email);
    const admin = isAdmin(email);
    const host = !!(a && a.is_host);
    if (!admin && !host) return res.status(403).send('Only the host or an admin can cancel the run.');
    const runDate = nextRunDate();
    const cancel = req.body.on === '1';
    if (cancel === runIsCancelled(runDate)) return res.redirect('/checkin'); // no state change → no push spam
    setRunCancelled(runDate, cancel);
    if (cancel) db.prepare('DELETE FROM checkins WHERE run_date = ? AND program_id = 1').run(runDate); // clear the floor — a cancelled run has nobody on it
    // Un-cancelling past the confirm cutoff must NOT arm an instant unpinged sweep — stamp/re-arm
    // the ping+sweep markers by the same rule as a date move.
    if (!cancel) migrateConfirmMarkers(runDate, effectiveConfirmCutoff(P(1).config.confirmCutoff), 'autoping_done', 'confirmsweep_done');
    audit(email, admin ? 'admin' : 'host', cancel ? 'run:cancel' : 'run:uncancel', runDate);
    if (cancel) {
      // Game-day notification: push only (no email storm) — the check-in banner carries it in-app.
      setImmediate(() => sendPush(approvedEmails(), {
        title: 'Run cancelled',
        body: `This week's run — ${runWeekday(runDate)}, ${runLabelFor(runDate)} — is cancelled. No run this week.`,
        url: '/checkin', tag: 'announce',
      }));
    }
    res.redirect('/checkin?rdset=1');
  });

  // The run-day confirm/release ping is now AUTOMATIC at the 2 PM lock (see autoRunState) —
  // the old manual /checkin/confirmping route + host button were removed.

  // A floor player confirms they're coming (run-day ping response) — or UNDOES it (un=1, the
  // confirmed pill is a toggle: plans change). Idempotent both ways.
  app.post('/checkin/confirm', requireLogin, (req, res) => {
    const runDate = nextRunDate();
    // Only real floor players confirm — a waitlister shouldn't pre-mark ✓ and slide on later.
    const part = partitionRun(runDate);
    if (part.floorReal.some(p => p.email === req.userEmail)) {
      if (req.body.un === '1') stmtConfirmClear.run(runDate, req.userEmail, 1);
      else stmtConfirmSet.run(runDate, req.userEmail, 1);
    }
    res.redirect('/checkin');
  });

  // A regular clears (or restores) their own auto-seat for this week.
  app.post('/checkin/optout', requireLogin, (req, res) => {
    const runDate = nextRunDate();
    db.prepare('INSERT OR IGNORE INTO regular_optout (run_date,email) VALUES (?,?)')
      .run(runDate, req.userEmail);
    // Sitting out frees their spot — if it was a floor slot, offer it onward.
    const offeree = offereeForFloorLeave(runDate, req.userEmail);
    db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1').run(runDate, req.userEmail);
    if (offeree) createOffer(runDate, offeree, req);
    res.redirect('/checkin');
  });
  app.post('/checkin/optin', requireLogin, (req, res) => {
    const runDate = nextRunDate();
    const me = applicantByEmail(req.userEmail);
    if (me && me.suspended) return res.redirect('/checkin'); // suspended → can't re-seat (matches /checkin/join)
    if (me && !me.waiver_ok) return res.redirect('/waiver?next=/checkin'); // one-time waiver before seating
    if (runIsCancelled(runDate) || runIsLocked(runDate)) return res.redirect('/checkin'); // cancelled/locked → no re-seat (matches /checkin/join)
    db.prepare('DELETE FROM regular_optout WHERE run_date = ? AND email = ? AND program_id = 1').run(runDate, req.userEmail);
    // WIRING (autoJoinTeam is now rollover-gated in ensureWeek, not per-view): a team
    // member with auto-renew opting back in — even while CLOSED — must be re-seated
    // here so this POST's response page shows them on the floor immediately.
    autoJoinTeam(runDate);
    // if the run is already open, put them back on the floor now
    if (runIsOpen(runDate)) {
      const a = applicantByEmail(req.userEmail);
      if (a && a.status === 'approved') {
        // Same hard cap as /checkin/join. Without it this seats row #21, which waitPlayers
        // slices off — an invisible ghost that still counts toward runFull.
        const already = db.prepare('SELECT 1 FROM checkins WHERE run_date=? AND email=? AND program_id = 1').get(runDate, req.userEmail);
        const { n } = db.prepare('SELECT COUNT(*) n FROM checkins WHERE run_date=? AND program_id = 1').get(runDate);
        if (already || n < TOTAL_CAP) {
          db.prepare('INSERT OR IGNORE INTO checkins (run_date,email,name) VALUES (?,?,?)')
            .run(runDate, req.userEmail, a.full_name);
        }
      }
    }
    res.redirect('/checkin');
  });
}

export function mountSeasonAndCalendar(app) {
  // This week's run as a calendar file (.ics). Floating local time; reflects the host's
  // per-week day/time override. Cancelled → STATUS:CANCELLED so an already-added event clears.
  app.get('/run.ics', requireLogin, (req, res) => {
    const rd = nextRunDate();
    const { start, end } = runTimesFor(rd);
    const dt = (hhmm) => rd.replace(/-/g, '') + 'T' + String(hhmm).replace(':', '') + '00';
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Bridge Adv Runs//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', `UID:bridge-run-${rd}@bridge`, `DTSTAMP:${ymdLocal().replace(/-/g, '')}T000000`,
      `DTSTART:${dt(start)}`, `DTEND:${dt(end)}`,
      'SUMMARY:Bridge Adv Runs — Basketball', 'LOCATION:The Bridge · Markham',
      runIsCancelled(rd) ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="bridge-run-${rd}.ics"`);
    res.send(ics);
  });

  // Season board — most runs this calendar year. Top list + the viewer's own rank; gentle
  // by design (never spotlights the bottom). Approved players + admins only.
  app.get('/season', requireLogin, (req, res) => {
    const a = applicantByEmail(req.userEmail);
    if (!a || (a.status !== 'approved' && !isAdmin(req.userEmail))) return res.redirect('/status');
    const rows = db.prepare(`SELECT at.email, COUNT(*) n, ap.full_name FROM attendance at
    LEFT JOIN applicants ap ON ap.email = at.email
    WHERE at.program_id = 1 AND at.run_date >= strftime('%Y-01-01','now') AND at.email NOT LIKE '%@guest.local'
    GROUP BY at.email ORDER BY n DESC, at.email ASC`).all();
    const named = rows.map((r, i) => ({ rank: i + 1, name: r.full_name || 'Member', n: r.n, me: r.email.toLowerCase() === req.userEmail.toLowerCase() }));
    res.send(seasonPage({ rows: named, email: a.email, dmUnread: unreadCount(a.email), groupUnread: groupUnread(a.email), groupMention: groupMentionUnread(a.email, a.id), ann: annPanel(a.email) }));
  });
}

export {
  stmtPreregCount,
};
