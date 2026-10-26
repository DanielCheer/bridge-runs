// routes/run-routes.js — the generic run routes. Every program's run page and actions are
// handled by the runXxx(programId, req, res) functions here (the teams/games handlers are in
// routes/run-teams.js, the ladder's in routes/run-ladder.js); mountRunProgram(app, p) wires them
// under a program's own path, and mountPendingPrograms(app) mounts every program that is not yet
// mounted (at boot and after one is created in the app). Basketball (/checkin) and pickleball
// (/pickleball) predate the factory and keep their inline routes: mountInlineRunRoutes(app).
import crypto from 'crypto';
import sharp from 'sharp';
import db from '../db.js';
import { sendAnnouncement, emailConfigured } from '../mailer.js';
import { requireLogin, requireAdmin } from '../auth.js';
import {
  bannerPage, claimResultPage, confirmActionPage, seasonPage, runPage, runJoinPage,
} from '../views/index.js';
import { setSetting, getSetting } from '../lib/settings.js';
import { audit, metric } from '../lib/audit.js';
import { lc } from '../lib/email.js';
import { rateLimited } from '../lib/rate-limit.js';
import { sendPush } from '../lib/push.js';
import { signIn } from '../lib/sign-in.js';
import {
  runLabelFor, schedNow, ymdLocal, shiftYmd, fmtClockLabel, runWeekday, DAY_NAMES,
} from '../lib/dates.js';
import { sniffImage, uploadBanner, writeFileAtomic } from '../lib/media.js';
import { applicantByEmail, applicantIdOf, isMinor } from '../engine/applicants.js';
import {
  P, bannerSrcFor, bannerVersionFor, programGate, programRunDate, runCancelledFor,
  effectiveConfirmCutoff, setRunStateFor, memberOf, setRunCookie, joinProgramMembership,
  programHostEmails, runOpenFor, startLabelFor, startHHMM, endHHMM, programMemberEmails,
  programEmailRecipients, endMinutesOf, minutesOfDay, pkNearestDow, programDefaultDate, programActive,
  programSeasonStart, startEpochFor, timeRangeFor, PROGRAMS,
} from '../engine/programs.js';
import {
  parseScheduleAt, armScheduleTimer, latestAnnouncementFor, annPanel,
} from '../engine/announcements.js';
import { waiverSatisfied, waiverGateUrl } from '../engine/waivers.js';
import {
  partitionFor, stmtConfirmSet, stmtConfirmClear, waitlistOrderFor, pingWaitlistShift, createOffer,
  offereeForFloorLeave, stmtDelCheckinRow, seatWaitingGuest, notifyPromotionFor, OFFER_WINDOW_MS,
  stmtPmAutoRenew, groupQueueFeature,
} from '../engine/seating.js';
import {
  clearRunParties, setPartyDeclinedFor, myPersistentParty, stmtPartyByLeader, stmtPartyById,
  partyJoinedEmails, resyncPartyGroupIds, persistentPartyEmails, stmtRunCheckedIn,
} from '../engine/parties.js';
import { blockedPair, peopleByEmails } from '../engine/social.js';
import {
  chatProgramFor, chatCountsFor, chatUnreadFor, chatMentionUnreadFor, pkGroupUnread,
  pkGroupMentionUnread, pkChatGate,
} from '../engine/chat.js';
import { unreadCount } from '../engine/messages.js';
import { migrateLadderNight } from '../engine/ladder.js';
import { teamsFeature, teamsOpen, clearTeamAssignment, clearRunTeams, runTeamsFor } from '../engine/teams.js';
import { stmtPmEnsureRow, seatRenewers, penaltyStateFor } from '../engine/renewals.js';
import {
  ensureWeekFor, migrateConfirmMarkers, removeFromRun, applySeasonStart,
} from '../engine/run-engine.js';
import { terminalError, TERMINAL_REGISTERED } from './errors.js';
import {
  runChatGet, runChatSeen, runChatOlder, runChatPost, runChatReact, runChatDelete, runChatPin,
  runChatVoice, runChatVideo,
} from './chat.js';
import {
  runLadderGet, runLadderLog, runLadderUndo, runLadderAdd, runLadderSync, runHeadcountSet,
  runLadderMerge, runLadderRetire, runLadderVoting, runLadderNominate,
} from './run-ladder.js';
import {
  runRosterSync, runTeamJoin, runTeamLeave, runTeamsBoard, runTeamSwap, runTeamBench, runTeamsClear,
  runTeamAssign, runGameLog, runGameUndo, runLeaderboard, runGameMerge, runTeamFill,
} from './run-teams.js';

// Run banner change (program-generic) — same cropper as basketball, but writes each run's OWN
// banner file (config.bannerPath) + redirects to its own base path. Pickleball delegates here;
// volleyball (+ any future run) gets it via mountRunProgram. Basketball keeps its own /admin/banner
// (a different route on the shared gym.jpg), so it stays inline.
function runBannerGet(programId, req, res) {
  const b = P(programId).paths.run, cfg = P(programId).config;
  res.send(bannerPage({ err: req.query.err || '', bannerVer: bannerVersionFor(programId), action: `${b}/banner`, imgSrc: bannerSrcFor(programId), back: b, bodyClass: cfg.theme }));
}
function runBannerPost(programId, req, res) {
  const b = P(programId).paths.run, cfg = P(programId).config;
  uploadBanner(req, res, async (err) => {
    if (err) return res.redirect(`${b}/banner?err=` + (err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad'));
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.redirect(`${b}/banner?err=empty`);
    if (!sniffImage(file.buffer)) return res.redirect(`${b}/banner?err=type`);
    try {
      const m = await sharp(file.buffer).metadata();
      const oriented = (m.orientation || 1) >= 5;
      const W = oriented ? m.height : m.width, H = oriented ? m.width : m.height;
      let left = Math.round(Number(req.body.cx)), top = Math.round(Number(req.body.cy));
      let width = Math.round(Number(req.body.cw)), height = Math.round(Number(req.body.ch));
      if (!(W > 0 && H > 0 && width > 0 && height > 0)) return res.redirect(`${b}/banner?err=crop`);
      left = Math.max(0, Math.min(left, W - 1)); top = Math.max(0, Math.min(top, H - 1));
      width = Math.max(1, Math.min(width, W - left)); height = Math.max(1, Math.min(height, H - top));
      const out = await sharp(file.buffer, { failOn: 'error' }).rotate()
        .extract({ left, top, width, height })
        .resize(2320, 1102, { fit: 'fill' })
        .jpeg({ quality: 84, mozjpeg: true }).toBuffer();
      await writeFileAtomic(cfg.bannerPath, out); // atomic (temp+rename) so a read mid-upload never gets a partial
      audit(req.userEmail, req.actorRole, `${cfg.logTag}:banner:update`, `${width}x${height}`);
      return res.redirect(b);
    } catch (e) {
      console.error(`[${cfg.logTag}-banner] crop failed for ${req.userEmail}: ${e.message}`);
      return res.redirect(`${b}/banner?err=bad`);
    }
  });
}
// Operator/admin: forgive a member's auto-renew penalty — clear strikes + lift any pause. The safety
// valve for a false strike or a member with a good reason. Program-generic; works for any run that
// enabled config.autoRenewPenalty (harmless no-op otherwise — state stays empty).
function runPenaltyClear(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const em = String(req.body.email || '').toLowerCase();
  if (em) {
    stmtPmEnsureRow.run(programId, em);
    db.prepare('UPDATE program_membership SET ar_strikes = 0, ar_paused_until = NULL WHERE program_id = ? AND email = ?').run(programId, em);
    audit(req.userEmail, req.actorRole || (g.admin ? 'admin' : 'host'), `${P(programId).config.logTag || 'run'}:arclear`, em);  // row-less admin has no actorRole
  }
  res.redirect(base);
}

// ---------- GENERIC RUN-ROUTE HANDLERS (opt-in programs) ----------
// Each handler body is program-generic (programId + P(id).paths/config); the inline /pickleball/*
// routes below call them with 2 (byte-identical), and mountRunProgram registers them for a 3rd
// program under its own paths. Basketball keeps its own /checkin/* routes (migrate post-freeze).
function runOpen(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const rd = programRunDate(programId); if (runCancelledFor(programId, rd)) return res.redirect(base);
  setRunStateFor(programId, rd, 'is_open', 1);
  // Don't re-seat auto-renewers past the confirm cutoff — a manual re-open after the 4:30 sweep
  // would silently restore the exact players the sweep just released.
  const cfg = P(programId).config;
  const openCutoff = effectiveConfirmCutoff(cfg.confirmCutoff);   // door mode: cutoff gone → renewers always seat
  if (!openCutoff || schedNow() < new Date(rd + 'T' + openCutoff + ':00').getTime()) seatRenewers(programId, rd);
  res.redirect(base);
}
function runClose(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  setRunStateFor(programId, programRunDate(programId), 'is_open', 0); res.redirect(base);
}
function runConfirm(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return;
  const rd = programRunDate(programId), part = partitionFor(programId, rd);
  const floor = P(programId).config.offerWindow ? part.floorReal : part.floor;
  if (floor.some(p => p.email === req.userEmail)) {
    if (req.body.un === '1') stmtConfirmClear.run(rd, req.userEmail, programId);   // the confirmed pill is a toggle — undo clears the ✓
    else stmtConfirmSet.run(rd, req.userEmail, programId);
  }
  res.redirect(base);
}
function runAutorenew(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return;
  if (!memberOf(programId, req.userEmail)) return res.redirect(base);
  const on = req.body.on === '1' ? 1 : 0;
  if (on && (!g.a || !waiverSatisfied(programId, g.a.email))) return res.redirect(waiverGateUrl(programId, base)); // can't auto-seat without the waiver (program-scoped when config.waiver is set — F6)
  db.prepare('UPDATE program_membership SET auto_renew = ? WHERE program_id = ? AND email = ?').run(on, programId, req.userEmail);
  res.redirect(base);
}
// F3: joinMode is ENFORCED here — 'open' (anyone approved joins, the historic behaviour and the
// default), 'invite' (organizers add members; self-join refused), 'host' (self-join creates a
// REQUEST; hosts get a push and approve on the run page). Built-in programs carry no joinMode →
// 'open', exactly their live behaviour.
function runJoinRun(programId, req, res) {
  const g = programGate(programId, req, res); if (!g) return;
  const base = P(programId).paths.run;
  const mode = P(programId).config.joinMode || 'open';
  if (memberOf(programId, req.userEmail)) { setRunCookie(req, res, programId); return res.redirect(base); }
  if (mode === 'invite') return res.redirect(base);   // the join page already explains invite-only; no state change
  if (mode === 'host') {
    const existing = db.prepare('SELECT status FROM program_membership WHERE program_id = ? AND email = ?').get(programId, req.userEmail);
    if (!existing) {
      // P3-10: a decline deletes the row, so an immediate re-request re-pushes every host +
      // admin — 3/day per person per program keeps that a nudge, not a siren.
      if (rateLimited('joinreq', `${req.userEmail}|${programId}`, 3, 24 * 3600 * 1000)) return res.redirect(base);
      joinProgramMembership(programId, req.userEmail, 'pending');
      audit(req.userEmail, 'player', 'program:join-requested', `${programId}`);
      const who = (g.a && g.a.full_name) || req.userEmail;
      setImmediate(() => sendPush(programHostEmails(programId), {
        title: `${P(programId).displayName}: join request`,
        body: `${who} asked to join. Approve or decline on the run page.`,
        url: base, tag: `joinreq${programId}`,
      }));
    }
    return res.redirect(base);   // page shows "request sent" for pending members
  }
  joinProgramMembership(programId, req.userEmail);
  setRunCookie(req, res, programId);
  res.redirect(base);
}
// Hosts/admins act on pending requests from the run page.
function runRequests(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const email = String(req.body.email || '').toLowerCase();
  const row = db.prepare("SELECT 1 FROM program_membership WHERE program_id = ? AND email = ? AND status = 'pending'").get(programId, email);
  if (!row) return res.redirect(base);
  if (req.body.act === 'approve') {
    db.prepare("UPDATE program_membership SET status = 'approved' WHERE program_id = ? AND email = ?").run(programId, email);
    audit(req.userEmail, g.admin ? 'admin' : 'host', 'program:request-approved', `${programId}:${email}`);
    setImmediate(() => sendPush([email], {
      title: `You're in — ${P(programId).displayName}`,
      body: 'Your request to join was approved. Check-in and chat are open to you now.',
      url: base, tag: `joinok${programId}`,
    }));
  } else {
    db.prepare('DELETE FROM program_membership WHERE program_id = ? AND email = ?').run(programId, email);
    audit(req.userEmail, g.admin ? 'admin' : 'host', 'program:request-declined', `${programId}:${email}`);
  }
  res.redirect(base);
}
function runBump(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const rd = programRunDate(programId); if (runCancelledFor(programId, rd)) return res.redirect(base);
  const wlBefore = waitlistOrderFor(programId, rd);   // F4 (P3-2): bumping a waitlister up shifts those behind (bball twin pings)
  const row = db.prepare('SELECT MIN(sort_order) m FROM checkins WHERE run_date = ? AND program_id = ?').get(rd, programId);
  db.prepare('UPDATE checkins SET sort_order = ? WHERE run_date = ? AND email = ? AND program_id = ?').run(((row && row.m) || 0) - 1, rd, String(req.body.email || '').toLowerCase(), programId);
  setImmediate(() => pingWaitlistShift(programId, rd, wlBefore));
  res.redirect(base);
}
function runJoin(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return;
  // Every refusal redirects with ?joinerr=<reason>, which the run page turns into one line.
  if (!g.a) return res.redirect(base + '?joinerr=notapproved');   // need a profile to join
  if (g.a.suspended) return res.redirect(base + '?joinerr=suspended');
  if (!waiverSatisfied(programId, g.a.email)) return res.redirect(waiverGateUrl(programId, base)); // one-time waiver before first join (program-scoped when config.waiver is set — F6)
  ensureWeekFor(programId);
  const rd = programRunDate(programId);
  if (runCancelledFor(programId, rd)) return res.redirect(base + '?joinerr=cancelled');
  if (!runOpenFor(programId, rd)) return res.redirect(base + '?joinerr=closed');
  const { rows } = partitionFor(programId, rd);
  if (rows.length >= cfg.cap + cfg.waitlist && !rows.find(p => p.email === req.userEmail)) return res.redirect(base + '?joinerr=full');
  // F3 enforcement (P2-1): a direct POST here must not bypass the program's join mode — it
  // previously enrolled ANY approved club player, invite-only or not (and let a pending
  // requester self-approve). Non-members of a non-open program go back to the join prompt,
  // which explains / requests properly. Open mode keeps the auto-enroll below.
  if (!memberOf(programId, req.userEmail) && (cfg.joinMode || 'open') !== 'open') return res.redirect(base + '?joinerr=notapproved');
  // Taking a seat makes you a member — a direct POST skips the GET that would enroll you, so
  // without this an approved player could seat as a ghost (on the floor, absent from the member
  // list / chat audience / push). Idempotent + guest-safe.
  joinProgramMembership(programId, req.userEmail);
  db.prepare('DELETE FROM regular_optout WHERE run_date = ? AND email = ? AND program_id = ?').run(rd, req.userEmail, programId); // re-joining clears any sit-out
  // Joining ON run day IS confirming (claim=confirm reasoning) — a same-day joiner must not be
  // swept "unconfirmed" at the cutoff they signed up within.
  const ins = db.prepare("INSERT OR IGNORE INTO checkins (run_date, email, name, program_id, confirmed_at) VALUES (?,?,?,?, CASE WHEN ? = 1 THEN datetime('now') END)")
    .run(rd, req.userEmail, g.a.full_name, programId, rd === ymdLocal() ? 1 : 0);
  if (ins.changes && !cfg.static) metric('checkin_join', { programId, runDate: rd });   // demo excluded (P3-7), like offer_*
  res.redirect(base);
}
function runCancel(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const rd = programRunDate(programId), on = req.body.on !== '0';
  const cfg = P(programId).config;
  setRunStateFor(programId, rd, 'cancelled', on);
  if (on) { setRunStateFor(programId, rd, 'is_open', 0); db.prepare('DELETE FROM checkins WHERE run_date = ? AND program_id = ?').run(rd, programId); clearRunTeams(programId, rd); clearRunParties(programId, rd); }
  // Un-cancelling past the confirm cutoff must NOT arm an instant unpinged sweep (same rule as a date move).
  else migrateConfirmMarkers(rd, effectiveConfirmCutoff(cfg.confirmCutoff), cfg.keys.autoping, cfg.keys.confirmsweep);
  res.redirect(base);
}
function runPublish(programId, req, res) {
  const cfg = P(programId).config;
  db.prepare('UPDATE program SET active = ? WHERE id = ?').run(req.body.on === '0' ? 0 : 1, programId);
  audit(req.userEmail, 'admin', req.body.on === '0' ? `${cfg.logTag}:hide` : `${cfg.logTag}:publish`, '');
  res.redirect(P(programId).paths.run);
}
// A member leaves the run (self sit-out). Offer-window programs offer the freed floor spot onward
// (capture the offeree BEFORE the delete); simple programs notify the first waitlister. Records a
// per-week sit-out so an auto-renew member isn't re-seated on a later open.
function runLeave(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return;
  const rd = programRunDate(programId);
  const wlBefore = waitlistOrderFor(programId, rd);   // F4 snapshot — self-leave shifts everyone behind up
  const offeree = cfg.offerWindow ? offereeForFloorLeave(rd, req.userEmail, programId) : null;   // guest priority handled inside
  if (!cfg.offerWindow) {
    // Simple model: guest priority first (owner rule), then the member promotion push.
    const onFloor = partitionFor(programId, rd).floor.some(p => lc(p.email) === lc(req.userEmail));
    if (onFloor && !seatWaitingGuest(programId, rd)) notifyPromotionFor(programId, rd, req.userEmail);
  }
  db.prepare('INSERT OR IGNORE INTO regular_optout (run_date, email, program_id) VALUES (?, ?, ?)').run(rd, req.userEmail, programId);
  stmtDelCheckinRow.run(rd, req.userEmail, programId);
  clearTeamAssignment(programId, rd, req.userEmail);   // off the floor → off any team
  setPartyDeclinedFor(programId, rd, req.userEmail);   // and out of any party so a group check-in can't re-seat them (P2-2)
  if (offeree) createOffer(rd, offeree, req, programId);
  setImmediate(() => pingWaitlistShift(programId, rd, wlBefore));   // F4: after the dust settles
  res.redirect(base);
}
function runRemove(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  removeFromRun(programId, programRunDate(programId), String(req.body.email || '').toLowerCase(), req);
  res.redirect(base);
}
// Generic offer-claim for offerWindow programs mounted via mountRunProgram — the piece that
// completes the auto-offer → confirm → promote money-moment for any program (not just basketball's
// inline /checkin/claim). Mirrors that route but PROGRAM-SCOPED: GET renders a confirm page (a
// mail-scanner's bare GET can't auto-claim), POST does the atomic, race-safe claim (read→check→
// clear; the first tap clears the token, a second finds nothing). A STATIC/demo claim just slides
// the synthetic player onto the floor and returns to the roster — it never mints a session.
function runClaimGet(programId, req, res) {
  const base = P(programId).paths.run;
  const token = req.params.token || '';
  const row = db.prepare('SELECT * FROM checkins WHERE claim_token = ? AND program_id = ?').get(token, programId);
  if (!row || row.offered_at == null || row.offered_at < Date.now() - OFFER_WINDOW_MS) return res.send(claimResultPage({ ok: false }));
  return res.send(confirmActionPage({
    title: 'Claim your spot', heading: 'A spot opened up',
    sub: `You've got a floor spot for ${runLabelFor(row.run_date)} — one tap locks it in.`,
    action: `${base}/claim/${token}`, fields: {}, button: 'Claim my spot →',
  }));
}
function runClaimPost(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const token = req.params.token || '';
  const row = db.prepare('SELECT * FROM checkins WHERE claim_token = ? AND program_id = ?').get(token, programId);
  if (!row || row.offered_at == null || row.offered_at < Date.now() - OFFER_WINDOW_MS) {
    return cfg.static ? res.redirect(base) : res.send(claimResultPage({ ok: false }));
  }
  db.prepare("UPDATE checkins SET offered_at = NULL, claim_token = NULL, confirmed_at = datetime('now') WHERE id = ?").run(row.id);   // claiming IS confirming
  audit(row.email, 'player', 'offer:claim', row.email);
  if (!cfg.static) metric('offer_claim', { programId, runDate: row.run_date, meta: `mins=${Math.round((Date.now() - row.offered_at) / 60000)}` });
  if (cfg.static) return res.redirect(base);        // demo: synthetic player slides onto the floor
  signIn(res, row.email, 'spot claim');                        // real program: sign the claimer in
  return res.send(claimResultPage({ ok: true, runLabel: runLabelFor(row.run_date), runDate: row.run_date, startLabel: startLabelFor(programId) }));
}
function runIcs(programId, req, res) {
  const cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return;
  const rd = programRunDate(programId);
  const dt = (hhmm) => rd.replace(/-/g, '') + 'T' + hhmm + '00';
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Bridge Adv Runs//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:bridge-${cfg.logTag}-${rd}@bridge`, `DTSTAMP:${ymdLocal().replace(/-/g, '')}T000000`,
    `DTSTART:${dt(startHHMM(cfg).replace(':', ''))}`, `DTEND:${dt(endHHMM(cfg).replace(':', ''))}`,
    `SUMMARY:The Bridge — ${P(programId).displayName}`, 'LOCATION:The Bridge · Markham',
    runCancelledFor(programId, rd) ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="bridge-${P(programId).key}-${rd}.ics"`);
  res.send(ics);
}
function runAnnounce(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const body = (req.body.body || '').trim().slice(0, 1000);
  if (!body) return res.redirect(base);
  if (rateLimited(`${cfg.logTag}-announce`, req.userEmail, 6, 10 * 60 * 1000)) return res.redirect(base);
  const author = (g.a && g.a.full_name) || req.userEmail;
  // Same-body/same-author within 10s = a double-tap, not a second announcement (the 6-per-10-min
  // limit is far too coarse to catch it, and each dup costs every member a push + email).
  if (db.prepare("SELECT 1 FROM announcements WHERE program_id = ? AND body = ? AND author = ? AND at >= datetime('now','-10 seconds') LIMIT 1").get(programId, body, author))
    return res.redirect(base);
  const schedAt = parseScheduleAt(req.body.publish_at);   // F8 — see /announce
  if (schedAt) {
    db.prepare('INSERT INTO announcements (body, author, program_id, pending, publish_at, sched_email) VALUES (?,?,?,1,?,?)')
      .run(body, author, programId, schedAt, req.body.email_everyone ? 1 : 0);
    audit(req.userEmail, g.admin ? 'admin' : 'host', `${cfg.logTag}:announce-scheduled`, `${schedAt} ${body.slice(0, 40)}`);
    armScheduleTimer();
    return res.redirect(base);
  }
  db.prepare('INSERT INTO announcements (body, author, program_id) VALUES (?,?,?)').run(body, author, programId);
  audit(req.userEmail, g.admin ? 'admin' : 'host', `${cfg.logTag}:announce`, body.slice(0, 60));
  setImmediate(() => sendPush(programMemberEmails(programId), { title: cfg.copy.annTitle, body: body.slice(0, 140), url: base, tag: `${cfg.logTag}ann` }));
  if (req.body.email_everyone && emailConfigured) {
    setImmediate(() => {
      try { const r = programEmailRecipients(programId); if (r.length) sendAnnouncement(r, body, author).catch(e => console.error(`[${cfg.logTag}-announce] email FAILED: ${e.message}`)); }
      catch (e) { console.error(`[${cfg.logTag}-announce] email prep FAILED: ${e.message}`); }
    });
  }
  res.redirect(base);
}
function runAnnounceRetract(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const cur = latestAnnouncementFor(programId);
  if (cur) { db.prepare('UPDATE announcements SET archived = 1 WHERE id = ? AND program_id = ?').run(cur.id, programId); audit(req.userEmail, g.admin ? 'admin' : 'host', `${cfg.logTag}:announce:retract`, String(cur.id)); }
  res.redirect(base);
}
// Kiosk link for the people who actually run the door (proposal #3): canOperate mints/rotates
// THEIR program's token from the run page — no admin round-trip, revocable per program.
function runKioskRotate(programId, req, res) {
  const base = P(programId).paths.run;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  // The demo program has no kiosk (/kiosk/:pid refuses 90 by design) — minting a token for it
  // built a door the room refuses (2026-08-04 bug: 'Not found' on tap). No static tokens, ever.
  if (P(programId).config.static) return res.redirect(base);
  setSetting(`kiosk_token_${programId}`, crypto.randomBytes(12).toString('base64url'));
  audit(req.userEmail, g.admin ? 'admin' : 'host', 'kiosk:token-rotated', `program ${programId}`);
  res.redirect(base);
}
// Cancel a SCHEDULED post before it fires (P2-4 twin of /announce/cancel) — pending-only delete.
function runAnnounceCancel(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const id = Number(req.body.id);
  if (Number.isInteger(id) && id > 0) {
    const r = db.prepare('DELETE FROM announcements WHERE id = ? AND pending = 1 AND program_id = ?').run(id, programId);
    if (r.changes) audit(req.userEmail, g.admin ? 'admin' : 'host', `${cfg.logTag}:announce:cancel-scheduled`, String(id));
    armScheduleTimer();
  }
  res.redirect(base);
}
function runSeasonSet(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return;
  if (!g.canOperate) return res.redirect(base);
  const raw = String(req.body.season || '').trim();
  const r = applySeasonStart(programId, raw);
  if (r.err) return res.redirect(base + '?pkerr=' + r.err);
  if (r.ok === 'unchanged') return res.redirect(base + (raw ? '?pkset=season' : '?pkset=seasonoff'));
  if (r.ok === 'cleared') { audit(req.userEmail, g.admin ? 'admin' : 'host', `${cfg.logTag}:season-clear`, ''); return res.redirect(base + '?pkset=seasonoff'); }
  audit(req.userEmail, g.admin ? 'admin' : 'host', `${cfg.logTag}:season-set`, raw);
  res.redirect(base + '?pkset=season');
}
// Season board (GET) — most runs this calendar year from attendance, member-gated (same bar as the
// run's chat). Program-generic: the copy (title/subtitle/emptyMsg) + theme all derive from the
// registry, so a new run needs no season handler — mountRunProgram registers this for it.
function runGetSeason(programId, req, res) {
  const g = programGate(programId, req, res); if (!g) return; // login + approved + 404 while hidden
  const me = req.userEmail, p = P(programId);
  if (!memberOf(programId, me)) return res.redirect(p.paths.run); // members only — open the run to join first
  const rows = db.prepare(`SELECT at.email, COUNT(*) n, ap.full_name FROM attendance at
    LEFT JOIN applicants ap ON ap.email = at.email
    WHERE at.program_id = ? AND at.run_date >= strftime('%Y-01-01','now') AND at.email NOT LIKE '%@guest.local'
    GROUP BY at.email ORDER BY n DESC, at.email ASC`).all(programId);
  const named = rows.map((r, i) => ({ rank: i + 1, name: r.full_name || 'Member', n: r.n, me: r.email.toLowerCase() === me.toLowerCase() }));
  const a = applicantByEmail(me), cc = p.unread(me, a ? a.id : 0);
  res.send(seasonPage({
    rows: named, email: me, program: programId, theme: p.config.theme,
    title: `${p.displayName} Season`, subtitle: `Most ${p.key} runs this calendar year ${p.emoji}`,
    emptyMsg: `No ${p.key} runs logged yet this season — get out there ${p.emoji}`,
    dmUnread: unreadCount(me), groupUnread: cc.group, groupMention: cc.gm, ann: null,
  }));
}
// Operator moves this week's run to another date, or clears back to the standing day. Migrates the
// roster + state + once-per-cycle markers to the new date (else it's stranded → phantom attendance),
// and records the consumed standing day as the base of the cycle being MOVED (see the comment below).
function runDate(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const d = String(req.body.date || '').trim();
  const oldRd = programRunDate(programId);
  // autoping is NOT blind-carried — it pairs with the confirm sweep (migrateConfirmMarkers below):
  // carrying it while the sweep marker re-arms would sweep the moved day UNPINGED (P1).
  const markerKeys = [cfg.keys.autoopen, cfg.keys.autolock];
  if (!d) {   // clear → back to the weekly standing day
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM app_settings WHERE key IN (?, ?)').run(cfg.keys.runDate, cfg.keys.runBase);
      const newRd = programDefaultDate(programId);   // the reverted standing day (settings now cleared)
      if (newRd !== oldRd) {
        db.prepare('UPDATE checkins SET run_date = ? WHERE run_date = ? AND program_id = ?').run(newRd, oldRd, programId);
        db.prepare('UPDATE OR IGNORE regular_optout SET run_date = ? WHERE run_date = ? AND program_id = ?').run(newRd, oldRd, programId);
        db.prepare('UPDATE signup_groups SET run_date = ? WHERE run_date = ? AND program_id = ?').run(newRd, oldRd, programId); // parties follow the run (Phase 6b)
        migrateLadderNight(programId, oldRd, newRd);   // tonight's results follow the night
        const st = db.prepare('SELECT is_open, cancelled FROM run_state WHERE run_date = ? AND program_id = ?').get(oldRd, programId);
        if (st) {
          db.prepare("INSERT INTO run_state (run_date, is_open, cancelled, program_id) VALUES (?,?,?,?) ON CONFLICT(run_date, program_id) DO UPDATE SET is_open = excluded.is_open, cancelled = excluded.cancelled").run(newRd, st.is_open, st.cancelled, programId);
          db.prepare('DELETE FROM run_state WHERE run_date = ? AND program_id = ?').run(oldRd, programId);
        }
        for (const k of markerKeys) if (getSetting(k) === oldRd) setSetting(k, newRd);
        migrateConfirmMarkers(newRd, effectiveConfirmCutoff(cfg.confirmCutoff), cfg.keys.autoping, cfg.keys.confirmsweep);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); console.error(`[${cfg.logTag}-date] clear FAILED: ${e.message}`); throw e; }
    return res.redirect(base + '?pkset=date');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(d + 'T12:00:00'))) return res.redirect(base + '?pkerr=datebad');
  const today = ymdLocal();
  if (d < today || (d === today && minutesOfDay(new Date()) >= endMinutesOf(cfg))) return res.redirect(base + '?pkerr=datepast'); // no past / already-ended today
  const maxD = new Date(); maxD.setDate(maxD.getDate() + 60);
  if (d > ymdLocal(maxD)) return res.redirect(base + '?pkerr=daterange');
  if (d !== oldRd) {
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE checkins SET run_date = ? WHERE run_date = ? AND program_id = ?').run(d, oldRd, programId);
      db.prepare('UPDATE OR IGNORE regular_optout SET run_date = ? WHERE run_date = ? AND program_id = ?').run(d, oldRd, programId);
      db.prepare('UPDATE signup_groups SET run_date = ? WHERE run_date = ? AND program_id = ?').run(d, oldRd, programId); // parties follow the run (Phase 6b)
      migrateLadderNight(programId, oldRd, d);   // tonight's results follow the night
      const st = db.prepare('SELECT is_open, cancelled FROM run_state WHERE run_date = ? AND program_id = ?').get(oldRd, programId);
      if (st) {
        db.prepare("INSERT INTO run_state (run_date, is_open, cancelled, program_id) VALUES (?,?,?,?) ON CONFLICT(run_date, program_id) DO UPDATE SET is_open = excluded.is_open, cancelled = excluded.cancelled").run(d, st.is_open, st.cancelled, programId);
        db.prepare('DELETE FROM run_state WHERE run_date = ? AND program_id = ?').run(oldRd, programId);
      }
      for (const k of markerKeys) if (getSetting(k) === oldRd) setSetting(k, d);
      migrateConfirmMarkers(d, effectiveConfirmCutoff(cfg.confirmCutoff), cfg.keys.autoping, cfg.keys.confirmsweep);
      setSetting(cfg.keys.runDate, d);
      // The consumed standing day is the base of the cycle being MOVED — never the day nearest the
      // destination. Keying off `d` breaks when the run moves to a day AFTER its standing day (marks
      // the NEXT week's run consumed → silently deleted). Once moved, the base is recorded — keep it.
      setSetting(cfg.keys.runBase, getSetting(cfg.keys.runBase) || pkNearestDow(oldRd, cfg.dow));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); console.error(`[${cfg.logTag}-date] move FAILED: ${e.message}`); throw e; }
  }
  res.redirect(base + '?pkset=date');
}
function runGuest(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g) return; if (!g.canOperate) return res.redirect(base);
  const rd = programRunDate(programId); if (runCancelledFor(programId, rd)) return res.redirect(base);
  const name = (req.body.name || '').trim().slice(0, 60);
  if (name) {
    // Double-tap guard: each guest gets a fresh random @guest.local email, so there's no UNIQUE to
    // catch a re-post — two taps would silently eat two floor spots.
    if (db.prepare("SELECT 1 FROM checkins WHERE run_date=? AND name=? AND program_id = ? AND created_at > datetime('now','-5 seconds')").get(rd, name + ' (guest)', programId))
      return res.redirect(base);
    const { rows } = partitionFor(programId, rd);
    if (rows.length < cfg.cap + cfg.waitlist) {
      const em = `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@guest.local`;
      db.prepare('INSERT INTO checkins (run_date, email, name, program_id) VALUES (?,?,?,?)').run(rd, em, name + ' (guest)', programId);
    }
  }
  res.redirect(base);
}
// The run page (GET). Non-members see the join prompt; members see the roster + controls. Offer-
// window programs use the offer partition shape (floorReal / offered / waitPlayers) so held offers
// render; simple programs use floor / wait. All presentation values come from config + the registry.
function runGetPage(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config, prog = P(programId);
  const g = programGate(programId, req, res); if (!g) return;
  if (!memberOf(programId, req.userEmail)) {   // not a member yet → opt-in join prompt (Chat tab reflects joined runs, or locks)
    const me = req.userEmail, mid = applicantIdOf(me);
    const cp = chatProgramFor(req), cc = chatCountsFor(cp || 1, me, mid);
    // joinMode drives the prompt: open → Join button; invite → explanation, no button;
    // host → Request button, or "request sent" once a pending row exists.
    const requested = !!db.prepare("SELECT 1 FROM program_membership WHERE program_id = ? AND email = ? AND status = 'pending'").get(programId, me);
    return res.send(runJoinPage({ email: me, runDate: programRunDate(programId), runLabel: runLabelFor(programRunDate(programId)),
      dmUnread: unreadCount(me), groupUnread: cc.group, groupMention: cc.gm, chatProgram: cp, ann: null,
      runBase: base, theme: cfg.theme, sport: prog.displayName, sportEmoji: prog.emoji,
      joinMode: cfg.joinMode || 'open', requested }));
  }
  setRunCookie(req, res, programId);
  if (req.headers['x-prewarm'] !== '1') joinProgramMembership(programId, req.userEmail); // operators/host appear in the member list too
  ensureWeekFor(programId);
  const rd = programRunDate(programId), part = partitionFor(programId, rd);
  const floor = cfg.offerWindow ? part.floorReal : part.floor;
  const wait = cfg.offerWindow ? part.waitPlayers : part.wait;
  const offered = cfg.offerWindow ? part.offered : [];
  const mine = part.rows.find(p => p.email === req.userEmail);
  const myState = mine ? (floor.indexOf(mine) >= 0 ? 'in' : 'waitlist') : 'out';
  const myWaitPos = myState === 'waitlist' ? wait.findIndex(p => p.email === req.userEmail) + 1 : 0;
  const myConfirmed = myState === 'in' && !!(mine && mine.confirmed_at);
  const iAutoRenew = !!(stmtPmAutoRenew.get(programId, req.userEmail)?.auto_renew);
  const opener = programSeasonStart(programId), pre = !!opener && ymdLocal() < opener;
  res.send(runPage({
    email: req.userEmail, runDate: rd, runLabel: runLabelFor(rd), isOpen: runOpenFor(programId, rd), cancelled: runCancelledFor(programId, rd),
    hours: timeRangeFor(programId), startLabel: startLabelFor(programId),
    cap: cfg.cap, waitlistCap: cfg.waitlist, going: floor.length + offered.length, waiting: wait.length,
    canOperate: g.canOperate, isAdmin: g.admin, myState, myWaitPos, floorPlayers: floor, offeredPlayers: offered, waitPlayers: wait, hidden: !programActive(programId),
    myConfirmed, iAutoRenew,
    // F3: operators see + act on pending join requests right on the run page.
    pendingRequests: g.canOperate ? db.prepare(
      `SELECT pm.email, COALESCE(a.full_name, pm.email) AS name FROM program_membership pm
       LEFT JOIN applicants a ON a.email = pm.email
       WHERE pm.program_id = ? AND pm.status = 'pending' ORDER BY pm.joined_at`).all(programId) : [],
    confirmBy: effectiveConfirmCutoff(cfg.confirmCutoff) ? fmtClockLabel(cfg.confirmCutoff) : '',
    bannerSrc: bannerSrcFor(programId), bannerVer: bannerVersionFor(programId),
    tipoff: startEpochFor(programId, rd), announcement: latestAnnouncementFor(programId),
    // F8 management surface (P2-4): operators see + can cancel scheduled posts for THIS program.
    schedAnns: g.canOperate ? db.prepare(
      'SELECT id, body, publish_at FROM announcements WHERE program_id = ? AND pending = 1 ORDER BY publish_at').all(programId) : [],
    // Kiosk link for the door crew (proposal #3) — per-program token, host-mintable.
    // Never for the static demo program: /kiosk/:pid refuses 90 by design.
    kioskUrl: (g.canOperate && !cfg.static && getSetting(`kiosk_token_${programId}`)) ? `/kiosk/${programId}?k=${getSetting(`kiosk_token_${programId}`)}` : '',
    kioskable: g.canOperate && !cfg.static,
    season: opener || '', seasonWeekday: opener ? runWeekday(opener) : '', seasonLabel: opener ? runLabelFor(opener) : '',
    preseason: pre, today: ymdLocal(), seasonMax: shiftYmd(ymdLocal(), 365),
    pkMsg: req.query.pkset ? String(req.query.pkset) : (req.query.pkerr || ''),
    joinErr: String(req.query.joinerr || ''),
    dmUnread: unreadCount(req.userEmail), groupUnread: chatUnreadFor(programId, req.userEmail), groupMention: chatMentionUnreadFor(programId, req.userEmail, g.a ? g.a.id : 0), ann: annPanel(req.userEmail),
    runBase: base, programId, theme: cfg.theme, sport: prog.displayName, sportEmoji: prog.emoji, dayName: DAY_NAMES[cfg.dow], pollKey: prog.key,
    teamsCfg: teamsFeature(programId), teamRows: teamsFeature(programId) ? runTeamsFor(programId, rd, part) : [], teamsOpen: teamsFeature(programId) ? teamsOpen(programId, rd) : false,
    penaltyState: g.canOperate ? penaltyStateFor(programId) : {},   // operator-only: {email: {strikes, until}} for the roster badge + forgive button
    partyData: cfg.static ? null : partyPanelFor(programId, rd, req.userEmail),   // queue-with-friends card (null unless groupQueue; the STATIC demo must never surface the admin's REAL party)
    partyMsg: req.query.partyfull ? 'full' : (req.query.partybig ? 'big' : ''),   // party check-in outcome notice (P3-4: the redirect params were silent)
    demoMode: !!cfg.static,                                         // demo run → control strip + per-offer claim button (operator only)
  }));
}

// Check the WHOLE party in together (atomic: all fit in the roster or none are added). Any JOINED
// member can trigger it ("if they check in with the party they are assumed to be coming"). The
// persistent party is INSTANTIATED as this run's signup_group; packParties seats them as one.
function runPartyCheckin(programId, req, res) {
  const base = P(programId).paths.run, cfg = P(programId).config;
  const g = programGate(programId, req, res); if (!g || !g.a) return res.redirect(base);
  const gq = groupQueueFeature(programId); if (!gq) return res.redirect(base);
  ensureWeekFor(programId);
  const rd = programRunDate(programId);
  if (runCancelledFor(programId, rd) || !runOpenFor(programId, rd)) return res.redirect(base);
  const me = lc(req.userEmail);
  const p = myPersistentParty(me);
  if (!p) return res.redirect(base);
  const emails = persistentPartyEmails(p);
  if (!emails.includes(me)) return res.redirect(base);                            // invited-but-not-joined can't seat the party
  if (emails.length > (gq.maxSize || 4)) return res.redirect(base + '?partybig=1'); // party exceeds THIS run's group cap
  // Per-run declined members (operator-removed this run, P2-2) must NOT be re-seated by a re-tap.
  const runGroup = stmtPartyByLeader.get(programId, rd, lc(p.leader_email));
  const declined = new Set(runGroup
    ? db.prepare("SELECT email FROM signup_group_members WHERE group_id=? AND status='declined'").all(runGroup.id).map(r => lc(r.email))
    : []);
  const seatable = emails.filter(e => !declined.has(e)).map(e => applicantByEmail(e))
    .filter(a => a && a.status === 'approved' && waiverSatisfied(programId, a.email) && !a.suspended && !/@guest\.local$/.test(a.email))
    // Belt-and-suspenders on the block invariant (P2-1): never seat someone alongside a party
    // member either of them has blocked, even if a stale membership survived.
    .filter(a => !emails.some(e => e !== lc(a.email) && blockedPair(a.email, e)))
    // F3 enforcement (P2-1 twin): a party check-in must not smuggle NON-MEMBERS into an
    // invite-only / request-to-join program — the leader's tap was auto-enrolling them below.
    // Open mode keeps the auto-enroll; others seat existing members only.
    .filter(a => (cfg.joinMode || 'open') === 'open' || memberOf(programId, lc(a.email)));
  const optRow = db.prepare('SELECT 1 FROM regular_optout WHERE run_date=? AND email=? AND program_id=?');
  const { rows } = partitionFor(programId, rd);
  const already = new Set(rows.map(r => lc(r.email)));
  // Skip members already checked in, and RESPECT a member's sit-out (regular_optout) — except for
  // me, the tapper, who is actively opting back in (P2-2).
  const toAdd = seatable.filter(a => !already.has(lc(a.email)) && (lc(a.email) === me || !optRow.get(rd, a.email, programId)));
  if (rows.length + toAdd.length > cfg.cap + cfg.waitlist) return res.redirect(base + '?partyfull=1'); // atomic: whole party or none
  db.exec('BEGIN'); // whole party seats or none — a mid-loop throw must not leave a PARTIAL party (P3-3)
  try {
    // Instantiate (or reuse) this run's signup_group from the persistent party.
    let run = runGroup;
    if (!run) {
      const info = db.prepare('INSERT INTO signup_groups (program_id, run_date, leader_email) VALUES (?,?,?)').run(programId, rd, lc(p.leader_email));
      run = stmtPartyById.get(info.lastInsertRowid);
    }
    for (const e of emails) if (e !== lc(p.leader_email)) {
      db.prepare(`INSERT INTO signup_group_members (group_id, email, status) VALUES (?,?,'joined')
        ON CONFLICT(group_id, email) DO UPDATE SET status = CASE WHEN status='declined' THEN status ELSE 'joined' END`).run(run.id, e);
    }
    for (const a of toAdd) {
      joinProgramMembership(programId, a.email);
      if (lc(a.email) === me) db.prepare('DELETE FROM regular_optout WHERE run_date=? AND email=? AND program_id=?').run(rd, a.email, programId); // tapper opts back in
      db.prepare("INSERT OR IGNORE INTO checkins (run_date, email, name, program_id, group_id, confirmed_at) VALUES (?,?,?,?,?,datetime('now'))")
        .run(rd, a.email, a.full_name, programId, run.id);
    }
    resyncPartyGroupIds(run.id);
    // Party check-in = "we're coming" (owner rule): confirm pre-existing solo checkins of the
    // party's joined members too, so nobody in the party is swept at the cutoff.
    const joined = partyJoinedEmails(run.id).filter(e => !declined.has(e));
    if (joined.length) db.prepare(`UPDATE checkins SET confirmed_at = datetime('now')
      WHERE program_id=? AND run_date=? AND confirmed_at IS NULL AND email IN (${joined.map(() => '?').join(',')})`).run(programId, rd, ...joined);
    db.exec('COMMIT');
    audit(me, 'player', `${cfg.logTag}:partycheckin`, `${run.id} +${toAdd.length}`);
  } catch (e) { db.exec('ROLLBACK'); console.error(`[${cfg.logTag}-party] group check-in FAILED: ${e.message}`); }
  res.redirect(base);
}

// Run-page party card data (null unless groupQueue is on → bball stays byte-identical). The card
// is a simple status + one-tap check-in; creating/managing the party lives on the Friends tab.
function partyPanelFor(programId, rd, email) {
  const gq = groupQueueFeature(programId); if (!gq) return null;
  email = lc(email);
  const maxSize = gq.maxSize || 4;
  const p = myPersistentParty(email);
  if (!p) return { maxSize, party: null };   // renders the "create one on the Friends tab" hint
  const emails = persistentPartyEmails(p);
  const checkedIn = new Set(stmtRunCheckedIn.all(programId, rd).map(r => lc(r.email)));
  const dir = peopleByEmails(emails);
  return {
    maxSize,
    party: {
      name: p.name || '', isLeader: lc(p.leader_email) === email, tooBig: emails.length > maxSize,
      members: emails.map(em => { const a = dir.get(em); return { id: a?.id || 0, name: a?.full_name || em, minor: isMinor(a), checkedIn: checkedIn.has(em) }; }),
    },
  };
}
// Register a program's full run-route set from config (paths + the generic runXxx handlers).
// Basketball (/checkin/*) and pickleball (/pickleball/*) keep their inline routes for now; other
// programs (volleyball, …) get theirs here. The terminal error handler is registered AFTER this
// mount (just before app.listen), so an uncaught throw in a mounted route lands there with a
// friendly 500 (no stack-trace leak) — same as the inline routes.
function mountRunProgram(app, program) {
  const b = program.paths.run, id = program.id;
  // Express can't UNMOUNT routes, but an in-app program can be deleted or re-slugged at runtime —
  // so every path this function registers gets one prefix guard that 404s the moment `b` stops
  // being this program's live path. Without it, a stale route reaches a handler that assumes
  // P(id) exists and throws a 500. One guard per program beats a check inside 30 handlers.
  app.use(b, (req, res, next) => {
    const live = PROGRAMS.get(id);
    if (live && live.paths.run === b) return next();
    return res.status(404).send('Not found');
  });
  app.get(b, requireLogin, (req, res) => runGetPage(id, req, res));
  app.get(`${b}/run.ics`, requireLogin, (req, res) => runIcs(id, req, res));
  app.post(`${b}/join-run`, requireLogin, (req, res) => runJoinRun(id, req, res));
  app.post(`${b}/requests`, requireLogin, (req, res) => runRequests(id, req, res));   // host/admin approve-decline (F3)
  app.post(`${b}/join`, requireLogin, (req, res) => runJoin(id, req, res));
  app.post(`${b}/leave`, requireLogin, (req, res) => runLeave(id, req, res));
  app.post(`${b}/confirm`, requireLogin, (req, res) => runConfirm(id, req, res));
  // Offer-claim (token-based, no login — matches basketball's inline claim). No-op for simple
  // programs (they never create offers); the money-moment for any offerWindow program.
  app.get(`${b}/claim/:token`, (req, res) => runClaimGet(id, req, res));
  app.post(`${b}/claim/:token`, (req, res) => runClaimPost(id, req, res));
  app.post(`${b}/autorenew`, requireLogin, (req, res) => runAutorenew(id, req, res));
  app.post(`${b}/open`, requireLogin, (req, res) => runOpen(id, req, res));
  app.post(`${b}/close`, requireLogin, (req, res) => runClose(id, req, res));
  app.post(`${b}/cancel`, requireLogin, (req, res) => runCancel(id, req, res));
  app.post(`${b}/date`, requireLogin, (req, res) => runDate(id, req, res));
  app.post(`${b}/remove`, requireLogin, (req, res) => runRemove(id, req, res));
  app.post(`${b}/bump`, requireLogin, (req, res) => runBump(id, req, res));
  app.post(`${b}/guest`, requireLogin, (req, res) => runGuest(id, req, res));
  app.get(`${b}/season`, requireLogin, (req, res) => runGetSeason(id, req, res));
  app.post(`${b}/season`, requireLogin, (req, res) => runSeasonSet(id, req, res));
  // Ladder (registered for every program; the handlers 404 unless config.features.ladder is on).
  app.get(`${b}/ladder`, requireLogin, (req, res) => runLadderGet(id, req, res));
  app.post(`${b}/ladder/log`, requireLogin, (req, res) => runLadderLog(id, req, res));
  app.post(`${b}/ladder/undo`, requireLogin, (req, res) => runLadderUndo(id, req, res));
  app.post(`${b}/ladder/nominate`, requireLogin, (req, res) => runLadderNominate(id, req, res));
  app.post(`${b}/ladder/voting`, requireLogin, (req, res) => runLadderVoting(id, req, res));
  app.post(`${b}/ladder/merge`, requireLogin, (req, res) => runLadderMerge(id, req, res));
  app.post(`${b}/headcount`, requireLogin, (req, res) => runHeadcountSet(id, req, res));
  app.post(`${b}/ladder/player`, requireLogin, (req, res) => runLadderAdd(id, req, res));
  app.post(`${b}/ladder/retire`, requireLogin, (req, res) => runLadderRetire(id, req, res));
  app.post(`${b}/ladder/sync`, requireLogin, (req, res) => runLadderSync(id, req, res));
  app.get(`${b}/banner`, requireAdmin, (req, res) => runBannerGet(id, req, res));
  app.post(`${b}/banner`, requireAdmin, (req, res) => runBannerPost(id, req, res));
  // Run chat (own room on the unified group_messages tables) — GET + seen/older + post/react/delete/pin/voice/video.
  app.get(`${b}/chat`, requireLogin, (req, res) => runChatGet(id, req, res));
  app.post(`${b}/chat/seen`, requireLogin, (req, res) => runChatSeen(id, req, res));
  app.get(`${b}/chat/older`, requireLogin, (req, res) => runChatOlder(id, req, res));
  app.post(`${b}/chat`, requireLogin, (req, res) => runChatPost(id, req, res));
  app.post(`${b}/chat/react`, requireLogin, (req, res) => runChatReact(id, req, res));
  app.post(`${b}/chat/delete`, requireLogin, (req, res) => runChatDelete(id, req, res));
  app.post(`${b}/chat/pin`, requireLogin, (req, res) => runChatPin(id, req, res));
  app.post(`${b}/chat/voice`, requireLogin, (req, res) => runChatVoice(id, req, res));
  app.post(`${b}/chat/video`, requireLogin, (req, res) => runChatVideo(id, req, res));
  app.post(`${b}/announce`, requireLogin, (req, res) => runAnnounce(id, req, res));
  app.post(`${b}/announce/retract`, requireLogin, (req, res) => runAnnounceRetract(id, req, res));
  app.post(`${b}/announce/cancel`, requireLogin, (req, res) => runAnnounceCancel(id, req, res));
  app.post(`${b}/kiosk-rotate`, requireLogin, (req, res) => runKioskRotate(id, req, res));
  app.post(`${b}/publish`, requireAdmin, (req, res) => runPublish(id, req, res));
  // Teams-in-a-run (registered for every program; the handlers no-op unless config.features.teams).
  app.post(`${b}/team/join`, requireLogin, (req, res) => runTeamJoin(id, req, res));
  app.post(`${b}/team/leave`, requireLogin, (req, res) => runTeamLeave(id, req, res));
  app.post(`${b}/team/assign`, requireLogin, (req, res) => runTeamAssign(id, req, res));
  app.post(`${b}/team/fill`, requireLogin, (req, res) => runTeamFill(id, req, res));
  app.get(`${b}/teams`, requireLogin, (req, res) => runTeamsBoard(id, req, res));
  app.post(`${b}/team/swap`, requireLogin, (req, res) => runTeamSwap(id, req, res));
  app.post(`${b}/team/bench`, requireLogin, (req, res) => runTeamBench(id, req, res));
  app.post(`${b}/teams/clear`, requireLogin, (req, res) => runTeamsClear(id, req, res));
  // Game results + leaderboard (registered for every program; 404 unless features.teams.games).
  app.post(`${b}/game`, requireLogin, (req, res) => runGameLog(id, req, res));
  app.post(`${b}/game/undo`, requireLogin, (req, res) => runGameUndo(id, req, res));
  app.post(`${b}/game/merge`, requireLogin, (req, res) => runGameMerge(id, req, res));
  app.get(`${b}/leaderboard`, requireLogin, (req, res) => runLeaderboard(id, req, res));
  app.post(`${b}/roster-sync`, requireLogin, (req, res) => runRosterSync(id, req, res));
  app.post(`${b}/penalty/clear`, requireLogin, (req, res) => runPenaltyClear(id, req, res));  // operator: forgive an auto-renew strike/pause
  // Queue-with-friends (registered for every program; the handlers no-op unless config.features.groupQueue).
  // Parties are created/managed on the FRIENDS tab now (/friends/party/*); the run keeps only
  // the one-tap group check-in (any joined member seats the whole party — assumed coming).
  app.post(`${b}/party/checkin`, requireLogin, (req, res) => runPartyCheckin(id, req, res));
}
// Register run routes for programs beyond basketball (/checkin/*) + pickleball (/pickleball/*),
// which keep their inline routes — e.g. volleyball via the config-driven factory. After
// buildPrograms() so P(id) is hydrated (mountRunProgram reads program.paths.run).
// Mounting is idempotent + incremental: a program CREATED at runtime gets its routes without a
// restart. Express matches layers in registration order, so normal requests reach routes added
// later — but an error middleware only catches throws from layers registered BEFORE it. Runtime
// mounts therefore re-append the terminal handler (see terminalError), or a throw in a
// brand-new program's route would fall through to Express's stack-trace-leaking default.
const MOUNTED_PROGRAMS = new Set();
function mountPendingPrograms(app) {
  let mounted = 0;
  for (const p of PROGRAMS.values()) {
    if (p.id >= 3 && !MOUNTED_PROGRAMS.has(p.id)) { mountRunProgram(app, p); MOUNTED_PROGRAMS.add(p.id); mounted++; }
  }
  // Boot registers the handler once, just below; only later mounts need a fresh trailing copy.
  if (mounted && TERMINAL_REGISTERED) app.use(terminalError);
  return mounted;
}

export function mountInlineRunRoutes(app) {
  app.get('/pickleball', requireLogin, (req, res) => runGetPage(2, req, res));
  // Pickleball season-start gate control (operator = admin) — mirrors /admin/season. Sets/clears
  // app_settings 'pk_season_start'; before it, no weekly pickleball runs and nothing auto-fires.
  app.post('/pickleball/season', requireLogin, (req, res) => runSeasonSet(2, req, res));
  // Join the pickleball RUN (membership) — the opt-in from the join prompt. Distinct from the
  // per-week check-in below. Adds a program_membership row, then lands on the run.
  app.post('/pickleball/join-run', requireLogin, (req, res) => runJoinRun(2, req, res));
  // "I'm coming" confirm — a floor player marks they're showing up (mirrors basketball).
  app.post('/pickleball/confirm', requireLogin, (req, res) => runConfirm(2, req, res));
  // Auto-renew toggle — a member opts their spot in/out of the weekly auto-add (self-service).
  app.post('/pickleball/autorenew', requireLogin, (req, res) => runAutorenew(2, req, res));
  // Pickleball season board — most pickleball runs this year, from attendance (program 2). Member-gated.
  app.get('/pickleball/season', requireLogin, (req, res) => {
    const g = pkChatGate(req, res); if (!g) return; // members only (same bar as the chat)
    const me = req.userEmail;
    const rows = db.prepare(`SELECT at.email, COUNT(*) n, ap.full_name FROM attendance at
    LEFT JOIN applicants ap ON ap.email = at.email
    WHERE at.program_id = 2 AND at.run_date >= strftime('%Y-01-01','now') AND at.email NOT LIKE '%@guest.local'
    GROUP BY at.email ORDER BY n DESC, at.email ASC`).all();
    const named = rows.map((r, i) => ({ rank: i + 1, name: r.full_name || 'Member', n: r.n, me: r.email.toLowerCase() === me.toLowerCase() }));
    const a = applicantByEmail(me);
    res.send(seasonPage({
      rows: named, email: me, program: 2, theme: 'pk',
      title: 'Pickleball Season', subtitle: 'Most pickleball runs this calendar year 🥒',
      emptyMsg: 'No pickleball runs logged yet this season — get out there 🥒',
      dmUnread: unreadCount(me), groupUnread: pkGroupUnread(me), groupMention: pkGroupMentionUnread(me, a ? a.id : 0), ann: null,
    }));
  });
  // Add the pickleball run to a calendar (.ics). Floating local time; 6–8 PM.
  app.get('/pickleball/run.ics', requireLogin, (req, res) => runIcs(2, req, res));
  app.post('/pickleball/join', requireLogin, (req, res) => runJoin(2, req, res));
  app.post('/pickleball/leave', requireLogin, (req, res) => runLeave(2, req, res));
  app.post('/pickleball/open', requireLogin, (req, res) => runOpen(2, req, res));
  app.post('/pickleball/close', requireLogin, (req, res) => runClose(2, req, res));
  app.post('/pickleball/cancel', requireLogin, (req, res) => runCancel(2, req, res));
  app.post('/pickleball/date', requireLogin, (req, res) => runDate(2, req, res));
  app.post('/pickleball/guest', requireLogin, (req, res) => runGuest(2, req, res));
  app.post('/pickleball/remove', requireLogin, (req, res) => runRemove(2, req, res));
  app.post('/pickleball/bump', requireLogin, (req, res) => runBump(2, req, res));
  app.post('/pickleball/publish', requireAdmin, (req, res) => runPublish(2, req, res));
  // Post a pickleball announcement — operator only. Stored in announcements (program 2)
  // table, pushed to pickleball members' phones (and emailed if SMTP is set), separate from
  // basketball announcements. Shown as a banner on the pickleball page.
  app.post('/pickleball/announce', requireLogin, (req, res) => runAnnounce(2, req, res));
  // Retract the current pickleball announcement — operator only. Archives it so it stops
  // showing on the page (no new push/email; the original notification already went out).
  app.post('/pickleball/announce/retract', requireLogin, (req, res) => runAnnounceRetract(2, req, res));
  app.post('/pickleball/announce/cancel', requireLogin, (req, res) => runAnnounceCancel(2, req, res));
  app.post('/pickleball/kiosk-rotate', requireLogin, (req, res) => runKioskRotate(2, req, res));
  // Teams board for the advanced run — its roster comes from Planning Center, so the sync lives here
  // too. Basketball's routes are written out rather than mounted by mountRunProgram (id < 3).
  app.get('/checkin/teams', requireLogin, (req, res) => runTeamsBoard(1, req, res));
  app.post('/checkin/roster-sync', requireLogin, (req, res) => runRosterSync(1, req, res));
  app.post('/checkin/team/swap', requireLogin, (req, res) => runTeamSwap(1, req, res));
  app.post('/checkin/team/bench', requireLogin, (req, res) => runTeamBench(1, req, res));
  app.post('/checkin/teams/clear', requireLogin, (req, res) => runTeamsClear(1, req, res));
  app.post('/checkin/game', requireLogin, (req, res) => runGameLog(1, req, res));
  app.post('/checkin/game/undo', requireLogin, (req, res) => runGameUndo(1, req, res));
  app.post('/checkin/game/merge', requireLogin, (req, res) => runGameMerge(1, req, res));
  app.get('/checkin/leaderboard', requireLogin, (req, res) => runLeaderboard(1, req, res));
  // Ladder — the season board the court screen shows. Same handlers mountRunProgram registers for
  // every other program; pickleball just has its routes written out like the rest of its block.
  app.get('/pickleball/ladder', requireLogin, (req, res) => runLadderGet(2, req, res));
  app.post('/pickleball/ladder/log', requireLogin, (req, res) => runLadderLog(2, req, res));
  app.post('/pickleball/ladder/undo', requireLogin, (req, res) => runLadderUndo(2, req, res));
  app.post('/pickleball/ladder/nominate', requireLogin, (req, res) => runLadderNominate(2, req, res));
  app.post('/pickleball/ladder/voting', requireLogin, (req, res) => runLadderVoting(2, req, res));
  app.post('/pickleball/ladder/merge', requireLogin, (req, res) => runLadderMerge(2, req, res));
  app.post('/pickleball/headcount', requireLogin, (req, res) => runHeadcountSet(2, req, res));
  app.post('/pickleball/ladder/player', requireLogin, (req, res) => runLadderAdd(2, req, res));
  app.post('/pickleball/ladder/retire', requireLogin, (req, res) => runLadderRetire(2, req, res));
  app.post('/pickleball/ladder/sync', requireLogin, (req, res) => runLadderSync(2, req, res));
}

export {
  runBannerGet, runBannerPost, mountPendingPrograms, MOUNTED_PROGRAMS,
};
