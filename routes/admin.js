// routes/admin.js — the organizer and council surfaces: /admin (applications and votes), run
// settings and the basketball run day, banners, roles, people management and invites, exports,
// analytics, the audit viewer and run history, the nav localizer, and waiver records/deletion.
import crypto from 'crypto';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import db, { rekeyEmailTx, transact } from '../db.js';
import { PUBLIC_URL, EXPORT_TMP_DIR } from '../config.js';
import { sendAnnouncement } from '../mailer.js';
import { pcoQueuePatch } from '../pco.js';
import { isAdmin, requireAdmin, requireLogin, ADMINS } from '../auth.js';
import {
  adminPage, bannerPage, sharePage, peoplePage, exportPage, analyticsPage, auditViewerPage,
  runHistoryPage, BUILD_VER,
} from '../views.js';
import { setSetting, getSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { isValidEmail } from '../lib/email.js';
import { sendPush } from '../lib/push.js';
import { runLabelFor, ymdLocal, runWeekday } from '../lib/dates.js';
import { csvCell } from '../lib/csv.js';
import {
  bannerVersion, BANNER_PATH, sniffImage, uploadBanner, writeFileAtomic, refreshAvatarMap,
  safeUnlinkAvatar, safeUnlinkChatImage,
} from '../lib/media.js';
import {
  approverEmails, applicantIdOf, voteInfo, applicantByEmail, approvedEmails, ageFromDob,
} from '../engine/applicants.js';
import { P, effectiveConfirmCutoff, PROGRAMS } from '../engine/programs.js';
import {
  nextRunDate, CAP, WAITLIST_CAP, PREREG_CAP, runTimeRange, reloadRunSettings, runIsCancelled,
  setRunOpen, setRunCancelled, runOverrideRow, runBaseFor, DEFAULT_START, DEFAULT_END, seasonStart,
  stmtRunIsOpen,
} from '../engine/basketball-calendar.js';
import { annPanel, announcementRecipients } from '../engine/announcements.js';
import { createOffer, offereeForFloorLeave } from '../engine/seating.js';
import { groupUnread, groupMentionUnread } from '../engine/chat.js';
import { unreadCount } from '../engine/messages.js';
import { migrateGamesNight, purgeGameIdentity } from '../engine/teams.js';
import { migrateConfirmMarkers, dropFromPickleball } from '../engine/run-engine.js';
import { autoJoinTeam } from '../engine/basketball.js';
import { recomputeStatus } from '../engine/council.js';
import { requireCouncil, requireApprover } from './guards.js';
import { runBannerGet, runBannerPost } from './run-routes.js';
import express from 'express';
import { purgeLadderIdentity } from '../engine/ladder.js';

export function mountAdmin(app) {
  // ---------- ADMIN / COUNCIL ----------
  app.get('/admin', requireCouncil, (req, res) => {
    const order = `CASE status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END`;
    const allRows = db.prepare(`SELECT * FROM applicants ORDER BY ${order}, created_at DESC`).all();
    const viewerIsAdmin = isAdmin(req.userEmail);
    // Filter tabs: all | pending | approved | rejected
    const valid = ['all', 'pending', 'approved', 'rejected'];
    const filter = valid.includes(req.query.status) ? req.query.status : 'all';
    const counts = {
      all: allRows.length,
      pending: allRows.filter(a => a.status === 'pending').length,
      approved: allRows.filter(a => a.status === 'approved').length,
      rejected: allRows.filter(a => a.status === 'rejected').length,
    };
    const filtered = filter === 'all' ? allRows : allRows.filter(a => a.status === filter);
    // Batch the vote lookups: compute the approver pool once and pull EVERY relevant
    // vote in a single IN-query, grouped by applicant, instead of two queries per row.
    const pool = approverEmails();
    const nonTeamIds = filtered.filter(a => !a.is_team).map(a => a.id);
    const votesByApplicant = new Map();
    if (nonTeamIds.length) {
      const ph = nonTeamIds.map(() => '?').join(',');
      for (const v of db.prepare(`SELECT applicant_id, voter_email, vote FROM votes WHERE applicant_id IN (${ph})`).all(...nonTeamIds)) {
        if (!votesByApplicant.has(v.applicant_id)) votesByApplicant.set(v.applicant_id, []);
        votesByApplicant.get(v.applicant_id).push(v);
      }
    }
    const applicants = filtered.map(a => ({
      ...a,
      vote: a.is_team ? null : voteInfo(a.id, req.userEmail, pool, votesByApplicant.get(a.id) || []),
    }));
    const runDate = nextRunDate();
    const checkedInCount = db.prepare('SELECT COUNT(*) n FROM checkins WHERE run_date = ? AND program_id = 1').get(runDate).n;
    const log = viewerIsAdmin
      ? db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 40').all() : [];
    // The voting pool ("The Council"): explicit is_council members — its own role now, separate
    // from team/host/admin. Shown to all viewers of this page; (admin-only) names back the
    // who-voted lines below.
    const teamMembers = db.prepare(
      'SELECT full_name, email, is_host FROM applicants WHERE is_council = 1 ORDER BY full_name ASC').all();
    res.send(adminPage({
      applicants, runLabel: runLabelFor(runDate), runDate, hours: runTimeRange(runDate), checkedInCount, cap: CAP,
      waitlistCap: WAITLIST_CAP, preregCap: PREREG_CAP,
      viewerIsAdmin, viewerIsTeam: req.actorRole === 'team',
      viewerCanVote: pool.has(String(req.userEmail).toLowerCase()),   // council flag, not team/host inference
      viewerIsHost: !!(db.prepare('SELECT is_host FROM applicants WHERE email = ?').get(String(req.userEmail).toLowerCase())?.is_host),
      viewerEmail: req.userEmail, log, msg: req.query.msg || '',
      filter, counts, teamMembers, ann: annPanel(req.userEmail),
      dmUnread: unreadCount(req.userEmail), groupUnread: groupUnread(req.userEmail), groupMention: groupMentionUnread(req.userEmail, applicantIdOf(req.userEmail)),
    }));
  });

  // Host-editable run capacities (admin). Stored in app_settings, applied immediately via
  // reloadRunSettings() — no restart. Clamped to sane bounds; blank/garbage falls back.
  app.post('/admin/settings', requireAdmin, (req, res) => {
    const clamp = (v, lo, hi, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
    setSetting('run_cap', clamp(req.body.run_cap, 1, 100, CAP));
    setSetting('waitlist_cap', clamp(req.body.waitlist_cap, 0, 100, WAITLIST_CAP));
    setSetting('prereg_cap', clamp(req.body.prereg_cap, 0, 100, PREREG_CAP));
    reloadRunSettings();
    audit(req.userEmail, 'admin', 'settings:caps', `cap=${CAP} wl=${WAITLIST_CAP} prereg=${PREREG_CAP}`);
    res.redirect('/admin?msg=' + encodeURIComponent('Run settings saved'));
  });

  // Check-in banner tool (operators). GET renders the pick + pan/zoom cropper; POST takes the
  // photo + the source-pixel crop rect the browser computed and writes the final 2320×1102 JPEG.
  app.get('/admin/banner', requireApprover, (req, res) => {
    res.send(bannerPage({ err: req.query.err || '', bannerVer: bannerVersion() }));
  });
  app.post('/admin/banner', requireApprover, (req, res) => {
    uploadBanner(req, res, async (err) => {
      if (err) return res.redirect('/admin/banner?err=' + (err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad'));
      const file = req.file;
      if (!file || !file.buffer || !file.buffer.length) return res.redirect('/admin/banner?err=empty');
      if (!sniffImage(file.buffer)) return res.redirect('/admin/banner?err=type'); // magic-byte gate
      try {
        // The browser cropper works in EXIF-ORIENTED pixels (what it displays), so compute the
        // oriented dimensions to clamp against, then rotate() before extract so coords line up.
        const m = await sharp(file.buffer).metadata();
        const oriented = (m.orientation || 1) >= 5;
        const W = oriented ? m.height : m.width, H = oriented ? m.width : m.height;
        let left = Math.round(Number(req.body.cx)), top = Math.round(Number(req.body.cy));
        let width = Math.round(Number(req.body.cw)), height = Math.round(Number(req.body.ch));
        if (!(W > 0 && H > 0 && width > 0 && height > 0)) return res.redirect('/admin/banner?err=crop');
        left = Math.max(0, Math.min(left, W - 1)); top = Math.max(0, Math.min(top, H - 1));
        width = Math.max(1, Math.min(width, W - left)); height = Math.max(1, Math.min(height, H - top));
        const out = await sharp(file.buffer, { failOn: 'error' }).rotate()
          .extract({ left, top, width, height })
          .resize(2320, 1102, { fit: 'fill' }) // 40:19 banner — matches .gymbanner/.cropframe CSS
          .jpeg({ quality: 84, mozjpeg: true }).toBuffer();
        await writeFileAtomic(BANNER_PATH, out); // atomic (temp+rename) so a read mid-upload never gets a partial
        audit(req.userEmail, req.actorRole, 'banner:update', `${width}x${height}`);
        return res.redirect('/checkin');
      } catch (e) {
        console.error(`[banner] crop failed for ${req.userEmail}: ${e.message}`);
        return res.redirect('/admin/banner?err=bad');
      }
    });
  });
  // Pickleball banner — delegates to the generic handler (writes pk-banner.jpg).
  app.get('/pickleball/banner', requireAdmin, (req, res) => runBannerGet(2, req, res));
  app.post('/pickleball/banner', requireAdmin, (req, res) => runBannerPost(2, req, res));

  // A council member casts (or changes) their vote. Recomputed live.
  app.post('/admin/vote', requireCouncil, (req, res) => {
    const { id, vote } = req.body;
    // Only the COUNCIL votes (applicants.is_council — the same pool recomputeStatus counts).
    // Admins run the app but don't get a vote; team/host membership no longer implies one.
    const voter = db.prepare('SELECT is_council FROM applicants WHERE email = ?').get(String(req.userEmail).toLowerCase());
    if (!voter || !voter.is_council) return res.status(403).send('Only council members vote on applicants.');
    if (!['approve', 'reject'].includes(vote)) return res.redirect('/admin');
    const a = db.prepare('SELECT email, is_team FROM applicants WHERE id = ?').get(id);
    if (!a || a.is_team) return res.redirect('/admin'); // team aren't voted on
    if (a.email === req.userEmail) return res.status(403).send("You can't vote on your own application.");
    db.prepare(`INSERT INTO votes (applicant_id,voter_email,vote) VALUES (?,?,?)
              ON CONFLICT(applicant_id,voter_email) DO UPDATE SET vote=excluded.vote, at=datetime('now')`)
      .run(id, req.userEmail.toLowerCase(), vote);
    recomputeStatus(id);
    audit(req.userEmail, req.actorRole, 'vote:' + vote, a.email);
    res.redirect('/admin');
  });

  // Admin-only: wipe an applicant's votes and send them back to pending (re-vote).
  app.post('/admin/reset', requireAdmin, (req, res) => {
    const { id } = req.body;
    const a = db.prepare('SELECT email, is_team FROM applicants WHERE id = ?').get(id);
    if (a) {
      db.prepare('DELETE FROM votes WHERE applicant_id = ?').run(id);
      db.prepare("UPDATE applicants SET status = 'pending' WHERE id = ? AND is_team = 0").run(id);
      // Back to pending → requirePlayer bounces them, so they can no longer leave check-in and would
      // freeze their floor spot. Free it (offer onward) like reject/suspend/delete do. Team members
      // aren't sent to pending (is_team guard above), so leave their spot alone.
      if (!a.is_team) {
        const runDate = nextRunDate();
        const offeree = offereeForFloorLeave(runDate, a.email);
        db.prepare('DELETE FROM checkins WHERE email = ? AND program_id = 1').run(a.email); // basketball floor only (reset doesn't touch pk)
        if (offeree) createOffer(runDate, offeree, req);
      }
      audit(req.userEmail, 'admin', 'reset', a.email);
    }
    res.redirect('/admin');
  });

  app.post('/admin/role', requireAdmin, (req, res) => {
    const { id, role, on } = req.body; // role: 'team' | 'regular' | 'host' | 'council'
    const turnOn = on === '1';
    const a = db.prepare('SELECT status, email FROM applicants WHERE id = ?').get(id);
    if (!a) return res.redirect('/admin');
    if (role === 'council') {
      // Council = a vote on Adv Basketball applicants, NOTHING else (no operator tools, no
      // auto-seat, no admin). Pure flag — no status side-effect; grant it to approved people.
      db.prepare('UPDATE applicants SET is_council = ? WHERE id = ?').run(turnOn ? 1 : 0, id);
      audit(req.userEmail, 'admin', `role:council:${turnOn ? 'on' : 'off'}`, a.email);
    } else if (role === 'team') {
      // Making someone team AUTO-APPROVES them (they skip the vote).
      if (turnOn) {
        db.prepare("UPDATE applicants SET is_team = 1, status = 'approved' WHERE id = ?").run(id);
        // WIRING: a newly-minted team member (auto_renew defaults on) is seated on the
        // current run immediately — autoJoinTeam is rollover-gated in ensureWeek now.
        autoJoinTeam(nextRunDate());
      } else {
        db.prepare('UPDATE applicants SET is_team = 0 WHERE id = ?').run(id);
      }
      audit(req.userEmail, 'admin', `role:team:${turnOn ? 'on' : 'off'}`, a.email);
    } else if (role === 'regular') {
      // Making someone Core (regular) AUTO-APPROVES them, same as team — one-click
      // approve-and-flag. Turning Core off only clears the flag, never un-approves.
      if (turnOn) {
        db.prepare("UPDATE applicants SET is_regular = 1, status = 'approved' WHERE id = ?").run(id);
      } else {
        db.prepare('UPDATE applicants SET is_regular = 0 WHERE id = ?').run(id);
      }
      audit(req.userEmail, 'admin', `role:regular:${turnOn ? 'on' : 'off'}`, a.email);
    } else if (role === 'host') {
      // Host — THE organizer of the night. Single-host invariant: turning one on
      // clears any existing host first. Only an approved player can be host.
      if (a.status === 'approved') {
        if (turnOn) db.prepare('UPDATE applicants SET is_host = 0 WHERE is_host = 1').run();
        db.prepare('UPDATE applicants SET is_host = ? WHERE id = ?').run(turnOn ? 1 : 0, id);
        audit(req.userEmail, 'admin', `role:host:${turnOn ? 'on' : 'off'}`, a.email);
      }
    }
    res.redirect('/admin');
  });

  // ---------- RUN DAY (host-configurable) ----------
  // Move a given week's run to a different weekday. HOST or ADMIN only (team members,
  // who vote on applicants, do NOT get to move the run) — so this can't use
  // requireApprover. The chosen date is validated (not past, within 30 days), keyed
  // to that date's default Friday, and upserted as an override (or the override is
  // cleared when the host picks the default Friday itself). The CURRENT week's live
  // rows (checkins / run_state / opt-outs) are migrated old→new run date atomically so
  // nothing is orphaned. On a real change we auto-post an announcement (same insert +
  // archive-current path as /announce) and optionally email everyone (default ON,
  // matching the announce UX). Synchronous throughout for race-safety.
  app.post('/admin/rundate', requireLogin, (req, res) => {
    const email = req.userEmail;
    const a = applicantByEmail(email);
    const admin = isAdmin(email);
    const host = !!(a && a.is_host);
    if (!admin && !host) return res.status(403).send('Only the host or an admin can set the run day.');
    const actorRole = admin ? 'admin' : 'host';
    // Pre-season the weekly run doesn't exist yet — the form is hidden, but reject a stale-tab /
    // direct POST so it can't create a dead override AND blast a phantom "the run is now …"
    // announcement + push to every member. Set the season via the Season control instead.
    { const opener = seasonStart(); if (opener && ymdLocal() < opener) return res.redirect('/checkin?rderr=preseason'); }

    const raw = String(req.body.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || isNaN(new Date(raw + 'T12:00:00')))
      return res.redirect('/checkin?rderr=bad');
    const today = ymdLocal();
    if (raw < today) return res.redirect('/checkin?rderr=past');
    const maxDate = new Date(); maxDate.setDate(maxDate.getDate() + 30);
    if (raw > ymdLocal(maxDate)) return res.redirect('/checkin?rderr=range');

    // Optional start/end time (HH:MM). Blank/absent → DEFAULT_START–DEFAULT_END. End must
    // be after start. A time that differs from default is stored even when the DAY didn't
    // move (a time-only override), so the row must persist in that case too.
    const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
    const rawStart = String(req.body.start || '').trim();
    const rawEnd = String(req.body.end || '').trim();
    if (rawStart && !TIME_RE.test(rawStart)) return res.redirect('/checkin?rderr=time');
    if (rawEnd && !TIME_RE.test(rawEnd)) return res.redirect('/checkin?rderr=time');
    const start = rawStart || DEFAULT_START;
    const end = rawEnd || DEFAULT_END;
    if (end <= start) return res.redirect('/checkin?rderr=time');

    // Key the override by the base of the CYCLE BEING MOVED — the default day the current
    // upcoming run is keyed under — NOT the default day nearest the chosen destination. The
    // date picker only ever edits the current upcoming run (it's pre-filled with it), so
    // oldRunDate IS the run being moved. Keying off the destination breaks the moment a move
    // (or re-move) crosses the week-midpoint: it strands the run's own override AND creates a
    // second one under the adjacent week's key. runBaseFor recovers the true base across far
    // moves. (Mirrors pickleball's pk_run_base fix — see /pickleball/date.)
    const oldRunDate = nextRunDate();  // the live upcoming run date BEFORE the change = the run being moved
    const base = runBaseFor(oldRunDate);
    const timeCustom = start !== DEFAULT_START || end !== DEFAULT_END;
    const dateMoved = raw !== base;
    const storeTime = timeCustom ? start : null;   // NULL cols = "use defaults"
    const storeEnd = timeCustom ? end : null;

    // Setting/re-confirming the run day REVIVES a cancelled run (re-scheduling = you're
    // committing to run again) — done BEFORE the no-op guard so re-submitting the SAME date
    // still un-cancels. The check-in page reflects it immediately.
    if (runIsCancelled(raw)) { setRunCancelled(raw, false); migrateConfirmMarkers(raw, effectiveConfirmCutoff(P(1).config.confirmCutoff), 'autoping_done', 'confirmsweep_done'); audit(email, actorRole, 'run:uncancel-via-rundate', raw); }

    // No-op guard: if the stored state already matches this request, skip the write +
    // announcement (re-submitting the same day/time must not spam everyone).
    const curRow = runOverrideRow(base);
    const same = (!dateMoved && !timeCustom)
      ? !curRow
      : (curRow && curRow.run_date === raw && (curRow.run_time || null) === storeTime && (curRow.run_end || null) === storeEnd);
    if (same) return res.redirect('/checkin?rdset=1');

    if (!dateMoved && !timeCustom) {
      db.prepare('DELETE FROM run_overrides WHERE default_date = ?').run(base);   // full reset
    } else {
      db.prepare(`INSERT INTO run_overrides (default_date, run_date, run_time, run_end) VALUES (?, ?, ?, ?)
                   ON CONFLICT(default_date) DO UPDATE SET run_date = excluded.run_date,
                     run_time = excluded.run_time, run_end = excluded.run_end, created_at = datetime('now')`)
        .run(base, raw, storeTime, storeEnd);
    }
    const newRunDate = nextRunDate();  // the live upcoming run date AFTER the change

    // Migrate the live cycle's rows only if the UPCOMING run date actually changed. Moving
    // a FUTURE week's run leaves the current cycle untouched → oldRunDate === newRunDate →
    // no migration. ensureWeek keys off nextRunDate too, but lastRunDate already equals the
    // (unchanged-or-just-migrated) current run date, so this never trips a spurious rollover;
    // the migration below is the only thing that moves rows, keeping check-in / waitlist /
    // offer state coherent. newRunDate === the chosen date whenever the current cycle moves.
    if (oldRunDate !== newRunDate) {
      db.exec('BEGIN');
      try {
        const st = stmtRunIsOpen.get(oldRunDate);
        if (st) { setRunOpen(newRunDate, st.is_open); db.prepare('DELETE FROM run_state WHERE run_date = ? AND program_id = 1').run(oldRunDate); }
        // Carry the once-per-run auto-open marker to the new date — otherwise moving a run the
        // host already closed re-arms auto-open under the new (unmarked) date key.
        if (getSetting('autoopen_done') === oldRunDate) setSetting('autoopen_done', newRunDate);
        // The auto-CLOSE/confirm-ping marker only carries if the new date's 2 PM lock has ALREADY
        // passed; if the new run day is still ahead, RESET it so the new day still auto-locks +
        // pings (carrying it blindly would skip the confirm ping when moving a run to a later day).
        if (getSetting('autoclose_done') === oldRunDate) {
          const newClose = new Date(newRunDate + 'T14:00:00').getTime();
          if (Date.now() >= newClose) setSetting('autoclose_done', newRunDate);
          else db.prepare("DELETE FROM app_settings WHERE key = 'autoclose_done'").run();
        }
        // Confirm ping + sweep markers follow the same rule — never let the moved day sweep unpinged.
        migrateConfirmMarkers(newRunDate, effectiveConfirmCutoff(P(1).config.confirmCutoff), 'autoping_done', 'confirmsweep_done');
        db.prepare('UPDATE checkins SET run_date = ? WHERE run_date = ? AND program_id = 1').run(newRunDate, oldRunDate);
        db.prepare('UPDATE regular_optout SET run_date = ? WHERE run_date = ? AND program_id = 1').run(newRunDate, oldRunDate);
        // The night-scoped tables the teams board runs on. They were missing here: moving a run left
        // the Planning Center roster and both sides stranded on the old date, so the board rendered
        // blank until someone re-synced, and any games logged that night dropped off the leaderboard
        // while Undo silently no-opped on a date that no longer had them.
        // OR REPLACE, not a plain UPDATE: both PKs are (program_id, run_date, email), so a row
        // already sitting on the TARGET date collides. That is not hypothetical — moves made before
        // this carry existed stranded rows on exactly those dates, so the first move after the fix
        // is the most likely one to hit it. Colliding target rows lose; the moving night wins.
        db.prepare('UPDATE OR REPLACE run_roster SET run_date = ? WHERE run_date = ? AND program_id = 1').run(newRunDate, oldRunDate);
        db.prepare('UPDATE OR REPLACE team_assignments SET run_date = ? WHERE run_date = ? AND program_id = 1').run(newRunDate, oldRunDate);
        migrateGamesNight(1, oldRunDate, newRunDate);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); console.error(`[rundate] migration FAILED: ${e.message}`); throw e; }
    }

    // Announce the change to players (archives the current live announcement, like
    // /announce) + optionally email everyone (default ON — matches the compose UX).
    // Reference the CHOSEN date (or the reset-to Friday), which is the run that moved —
    // NOT newRunDate, which for a future-week move is the unchanged current run.
    const reset = !dateMoved && !timeCustom;
    const annDate = reset ? base : raw;
    const wd = runWeekday(annDate), lbl = runLabelFor(annDate);
    const timeLbl = runTimeRange(annDate);   // reflects the just-stored (or default) window
    const annBody = reset
      ? `📅 Update — the run is back to its usual ${wd}, ${lbl} (${timeLbl}).`
      : `📅 Heads up — the run is now ${wd}, ${lbl} (${timeLbl}).`;
    db.prepare("UPDATE announcements SET archived = 1, archived_at = datetime('now') WHERE archived = 0 AND program_id = 1").run();
    db.prepare('INSERT INTO announcements (body,author) VALUES (?,?)').run(annBody, email);
    audit(email, actorRole, 'rundate:set', `${base} -> ${reset ? 'default' : raw} ${storeTime || DEFAULT_START}-${storeEnd || DEFAULT_END}`);

    // Push the run-day/time change to every subscribed player (independent of email).
    const meLc = String(email).toLowerCase();
    setImmediate(() => sendPush(approvedEmails().filter(e => e.toLowerCase() !== meLc),
      { title: 'Run day update', body: annBody.replace(/^📅\s*/, ''), url: '/checkin', tag: 'announce' }));

    if (req.body.email_everyone) {
      setImmediate(() => {
        try {
          const recipients = announcementRecipients();
          sendAnnouncement(recipients, annBody, email).catch(err =>
            console.error(`[rundate] announcement email FAILED: ${err.message}`));
        } catch (err) { console.error(`[rundate] announcement email prep FAILED: ${err.message}`); }
      });
    }
    res.redirect('/checkin?rdset=1');
  });

  // Season-start gate control (HOST/ADMIN) — sets/clears app_settings 'season_start'. Before
  // the opener there are no weekly runs and nothing auto-opens; clearing it resumes the weekly
  // schedule immediately. Silent (no announcement/push) — the operator sends their own season
  // kickoff message; this is config, not a player-facing event.
  app.post('/admin/season', requireLogin, (req, res) => {
    const email = req.userEmail;
    const a = applicantByEmail(email);
    const admin = isAdmin(email);
    const host = !!(a && a.is_host);
    if (!admin && !host) return res.status(403).send('Only the host or an admin can set the season.');
    const actorRole = admin ? 'admin' : 'host';
    const raw = String(req.body.season || '').trim();
    if (!raw) {   // clear → runs resume every week
      db.prepare("DELETE FROM app_settings WHERE key = 'season_start'").run();
      audit(email, actorRole, 'season:clear', '');
      return res.redirect('/checkin?rdset=seasonoff');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || isNaN(new Date(raw + 'T12:00:00'))) return res.redirect('/checkin?rderr=seasonbad');
    const today = ymdLocal();
    if (raw < today) return res.redirect('/checkin?rderr=seasonpast');
    const maxD = new Date(); maxD.setFullYear(maxD.getFullYear() + 1);
    if (raw > ymdLocal(maxD)) return res.redirect('/checkin?rderr=seasonrange');
    setSetting('season_start', raw);
    // Clear any rosters for runs between now and the opener. The season gate makes nextRunDate
    // jump to the opener, so these future runs become unreachable (no auto-open/ping, off the
    // check-in page). Left in place, the NEXT rollover (in September) would archive an abandoned
    // FUTURE roster into `attendance` as a run that never happened — permanent phantom season-board
    // credits. Only strictly-future runs (run_date > today); a run happening today archives
    // normally tonight. Past runs are the rollover's job. (ensureWeek's cutoff=today fix stopped
    // the immediate-jump archive; this stops the delayed one.)
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM checkins WHERE run_date > ? AND run_date < ? AND program_id = 1').run(today, raw);
      db.prepare('DELETE FROM regular_optout WHERE run_date > ? AND run_date < ? AND program_id = 1').run(today, raw);
      db.prepare('DELETE FROM run_state WHERE run_date > ? AND run_date < ? AND program_id = 1').run(today, raw);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); console.error(`[season] roster cleanup FAILED: ${e.message}`); throw e; }
    audit(email, actorRole, 'season:set', raw);
    res.redirect('/checkin?rdset=season');
  });

  // Share page — a big scannable QR + tap-able link for the application form,
  // to show/hand out at the Monday rec runs. QR is generated live from PUBLIC_URL
  // so it never points at a stale address.
  app.get('/admin/share', requireAdmin, async (req, res, next) => {
    try {
      const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
      const applyUrl = base + '/';
      const [applyQr, loginQr] = await Promise.all([
        QRCode.toString(applyUrl, { type: 'svg', margin: 1, color: { dark: '#183B38', light: '#ffffff' } }),
        QRCode.toString(base + '/login', { type: 'svg', margin: 1, color: { dark: '#183B38', light: '#ffffff' } }),
      ]);
      res.send(sharePage({ applyUrl, applyQr, signInUrl: base + '/login', loginQr, ann: annPanel(req.userEmail), dmUnread: unreadCount(req.userEmail), groupUnread: groupUnread(req.userEmail), groupMention: groupMentionUnread(req.userEmail, applicantIdOf(req.userEmail)) }));
    } catch (e) { next(e); } // QR failure must not take the process down (Express 4 won't catch async throws)
  });

  // ---------- PEOPLE MANAGEMENT (admin-only) ----------
  app.get('/admin/people', requireAdmin, (req, res) => {
    const q = (req.query.q || '').trim();
    let people;
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, c => '\\' + c)}%`; // escape wildcards (consistency w/ public searches)
      people = db.prepare(
        `SELECT * FROM applicants WHERE full_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
       ORDER BY full_name COLLATE NOCASE`).all(like, like, like);
    } else {
      people = db.prepare('SELECT * FROM applicants ORDER BY full_name COLLATE NOCASE').all();
    }
    const approvedPhones = db.prepare(
      "SELECT full_name, phone FROM applicants WHERE status='approved' ORDER BY full_name COLLATE NOCASE").all();
    const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const signInUrl = base + '/login';
    const invites = db.prepare('SELECT * FROM invites WHERE used = 0 ORDER BY created_at DESC').all()
      .map(iv => ({ ...iv, link: `${base}/invite/${iv.token}` }));
    const newInviteLink = req.query.invite ? `${base}/invite/${req.query.invite}` : '';
    // Per-program waivers (F6): which programs have their own, and every signed record grouped by
    // email — the person card shows each program's state with a verify affordance. Empty until a
    // program opts in, so this section renders nothing today.
    const waiverProgs = [...PROGRAMS.values()].filter(p => p.config.waiver)
      .map(p => ({ key: p.config.waiver.key, label: p.displayName }));
    const waiverRecs = {};
    if (waiverProgs.length) for (const r of db.prepare('SELECT * FROM waiver_records').all()) (waiverRecs[r.email] = waiverRecs[r.email] || []).push(r);
    res.send(peoplePage({ people, q, approvedPhones, signInUrl, invites, newInviteLink, msg: req.query.msg || '', ann: annPanel(req.userEmail), dmUnread: unreadCount(req.userEmail), groupUnread: groupUnread(req.userEmail), groupMention: groupMentionUnread(req.userEmail, applicantIdOf(req.userEmail)), waiverProgs, waiverRecs }));
  });

  // Organizer confirms a PROGRAM's waiver document they have actually seen (F6 twin of
  // /admin/people/waiver): upserts the record with verified_at/verified_by — sighting the signed
  // document (guardian signature included, for youth waivers) satisfies the program's gate outright.
  app.post('/admin/people/waiver-record', requireAdmin, (req, res) => {
    const a = db.prepare('SELECT email, full_name FROM applicants WHERE id = ?').get(req.body.id);
    if (!a) return res.redirect('/admin/people?msg=' + encodeURIComponent('No such person.'));
    const key = String(req.body.key || '');
    const prog = [...PROGRAMS.values()].find(p => p.config.waiver && p.config.waiver.key === key);
    if (!prog) return res.redirect('/admin/people?msg=' + encodeURIComponent('No program uses that waiver.'));
    const em = String(a.email).toLowerCase();
    if (req.body.on === '0') {
      db.prepare('UPDATE waiver_records SET verified_at = NULL, verified_by = NULL WHERE waiver_key = ? AND email = ?').run(key, em);
      audit(req.userEmail, 'admin', 'people:waiver-record-unverify', `${key}:${em}`);
      return res.redirect('/admin/people?msg=' + encodeURIComponent(`Cleared the ${prog.displayName} confirmation for ${a.full_name} — their own attestation stands.`));
    }
    db.prepare(`INSERT INTO waiver_records (waiver_key, email, verified_at, verified_by)
      VALUES (?, ?, datetime('now','localtime'), ?)
    ON CONFLICT(waiver_key, email) DO UPDATE SET verified_at = excluded.verified_at, verified_by = excluded.verified_by`)
      .run(key, em, req.userEmail);
    audit(req.userEmail, 'admin', 'people:waiver-record-verified', `${key}:${em}`);
    res.redirect('/admin/people?msg=' + encodeURIComponent(`${a.full_name}'s ${prog.displayName} waiver is confirmed on file.`));
  });

  // Roster CSV export (admin-only) — offline backup / spreadsheet analysis of the people
  // list. One row per applicant; role is derived from the flags. RFC-4180 quoting, UTF-8
  // BOM so Excel reads accented names correctly. Content-Disposition → browser downloads.
  app.get('/admin/people/export.csv', requireAdmin, (req, res) => {
    const rows = db.prepare(
      `SELECT full_name, email, phone, status, is_team, is_regular, is_host, position,
            waiver_ok, email_optout, created_at
     FROM applicants ORDER BY full_name COLLATE NOCASE ASC`).all();
    const cell = (v) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                 // neutralize spreadsheet formula injection (a name like =HYPERLINK(...))
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const roleOf = (a) => [a.is_host ? 'Host' : a.is_team ? 'Team' : a.is_regular ? 'Core' : '', a.is_council ? 'Council' : ''].filter(Boolean).join('+');
    const lines = [['Name', 'Email', 'Phone', 'Status', 'Role', 'Position', 'Waiver', 'Waiver date', 'Email opt-out', 'Applied'].join(',')];
    for (const a of rows) lines.push([
      a.full_name, a.email, a.phone, a.status, roleOf(a), a.position,
      a.waiver_ok ? 'yes' : 'no', a.waiver_at || (a.waiver_ok ? 'not recorded' : ''),
      a.email_optout ? 'yes' : 'no', a.created_at,
    ].map(cell).join(','));
    audit(req.userEmail, 'admin', 'people:export', String(rows.length));
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Disposition', `attachment; filename="bridge-people-${stamp}.csv"`);
    res.type('text/csv').send('\uFEFF' + lines.join('\r\n')); // BOM = Excel reads UTF-8
  });
  // Export hub (admin-only): attendance CSV per run + a full DB backup. The CSV is the Google-
  // Sheets / Planning-Center import path (paste or File\u2192Import); the .db is an offline backup.
  app.get('/admin/export', requireAdmin, (req, res) => {
    const programs = [...PROGRAMS.values()].filter(p => !P(p.id).config.static).map(p => ({   // demo (static) isn't a records source
      id: p.id, key: p.key, name: p.displayName, emoji: p.emoji, active: p.active(),
      count: db.prepare('SELECT COUNT(*) n FROM attendance WHERE program_id = ?').get(p.id).n,
    }));
    res.send(exportPage({ programs, dmUnread: unreadCount(req.userEmail),
      groupUnread: groupUnread(req.userEmail), groupMention: groupMentionUnread(req.userEmail, applicantIdOf(req.userEmail)),
      ann: annPanel(req.userEmail) }));
  });
  // Per-program attendance CSV (run_date, name, email, program). Archived attendance only \u2014
  // the live floor isn't logged until the weekly rollover, matching the season board.
  app.get('/admin/export/attendance.csv', requireAdmin, (req, res) => {
    const pid = Number(req.query.program) || 0;
    if (!PROGRAMS.has(pid) || P(pid).config.static) return res.status(404).send('Unknown run');  // demo isn't a records source
    const prog = P(pid);
    const rows = db.prepare(`SELECT run_date, name, email FROM attendance
     WHERE program_id = ? ORDER BY run_date DESC, name COLLATE NOCASE ASC`).all(pid);
    const lines = [['Run date', 'Name', 'Email', 'Program'].join(',')];
    for (const a of rows) lines.push([a.run_date, a.name, a.email, prog.displayName].map(csvCell).join(','));
    audit(req.userEmail, 'admin', 'attendance:export', `${prog.key}:${rows.length}`);
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Disposition', `attachment; filename="bridge-attendance-${prog.key}-${stamp}.csv"`);
    res.type('text/csv').send('\uFEFF' + lines.join('\r\n'));
  });
  // Full DB backup (admin-only). Streams a transactionally-consistent VACUUM INTO snapshot (never
  // the live WAL'd file) written to a UNIQUE transient path \u2014 so it never collides with the
  // scheduled backupNow() (whose second-precision filenames would clash) and has none of its side
  // effects. Deleted after the response. Contains ALL data (chat, DMs, contacts) \u2192 requireAdmin +
  // audited; the page warns to store it securely.
  app.get('/admin/export/db', requireAdmin, (req, res, next) => {
    let tmp;
    try {
      fs.mkdirSync(EXPORT_TMP_DIR, { recursive: true });
      tmp = path.join(EXPORT_TMP_DIR, `export-${process.pid}-${Date.now()}.db`);
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); // consistent copy regardless of WAL state
    } catch (e) {
      console.error(`[export:db] snapshot FAILED for ${req.userEmail}: ${e.message}`);
      return res.status(500).send('Export failed \u2014 check the server log.');
    }
    audit(req.userEmail, 'admin', 'db:export', '');
    const stamp = new Date().toISOString().slice(0, 10);
    res.download(tmp, `bridge-backup-${stamp}.db`, (err) => {
      fs.unlink(tmp, () => {}); // best-effort cleanup of the transient snapshot
      if (err && !res.headersSent) next(err);
    });
  });

  // One form, two outcomes. Admin gives whatever they know (any/all of
  // name/phone/email) plus a role. If that's enough to identify or fully create
  // the person, they're approved immediately — no link needed. Otherwise a
  // one-time invite link is created, pre-filled with whatever was given, so the
  // player fills in the rest themselves.
  app.post('/admin/people/invite', requireAdmin, (req, res) => {
    const full_name = (req.body.full_name || '').trim();
    const phone = (req.body.phone || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const role = req.body.role === 'team' ? 'team' : req.body.role === 'regular' ? 'regular' : '';
    const isTeam = role === 'team' ? 1 : 0;
    const isRegular = role === 'regular' ? 1 : 0;
    const roleLabel = role === 'team' ? ' as Team' : role === 'regular' ? ' as Core' : ' as approved';

    // The one remaining entry point that didn't validate the address — a malformed/list email
    // here would land straight in `applicants` and become a nodemailer bcc entry (the exact
    // shape EMAIL_RE guards elsewhere). Validate before create-or-invite.
    if (email && !isValidEmail(email))
      return res.redirect('/admin/people?msg=' + encodeURIComponent('That email did not look valid — double-check it and try again.'));

    if (email) {
      const existing = applicantByEmail(email);
      if (existing) {
        // Known email — approve immediately, no link needed. Only touch
        // status/role here; use Edit for contact-info changes.
        if (role) {
          db.prepare("UPDATE applicants SET status='approved', is_team=?, is_regular=? WHERE email=?")
            .run(isTeam, isRegular, email);
        } else {
          db.prepare("UPDATE applicants SET status='approved' WHERE email=?").run(email);
        }
        audit(req.userEmail, 'admin', `people:approve-existing${role ? ':' + role : ''}`, email);
        return res.redirect('/admin/people?msg=' + encodeURIComponent('That email existed — approved them' + (role ? roleLabel : '')));
      }
      if (full_name && phone) {
        // Everything needed for a full record — create approved right now.
        db.prepare(`INSERT INTO applicants (full_name,email,phone,experience,waiver_ok,status,is_team,is_regular)
                  VALUES (?,?,?,?,0,'approved',?,?)`).run(full_name, email, phone, 'Pre-approved', isTeam, isRegular);
        audit(req.userEmail, 'admin', `people:add-approved${role ? ':' + role : ''}`, email);
        return res.redirect('/admin/people?msg=' + encodeURIComponent('Added ' + full_name + roleLabel));
      }
    }

    // Missing something — generate a one-time link pre-filled with whatever was
    // given; the player fills in the rest and lands signed in.
    const token = crypto.randomBytes(18).toString('base64url');
    db.prepare('INSERT INTO invites (token,full_name,phone,email,role,created_by) VALUES (?,?,?,?,?,?)')
      .run(token, full_name, phone, email, role, req.userEmail);
    audit(req.userEmail, 'admin', 'invite:create', full_name || email || '(blank)');
    res.redirect('/admin/people?invite=' + token);
  });

  app.post('/admin/people/invite/revoke', requireAdmin, (req, res) => {
    const { token } = req.body;
    const iv = db.prepare('SELECT * FROM invites WHERE token = ? AND used = 0').get(token || '');
    if (iv) {
      db.prepare('DELETE FROM invites WHERE token = ?').run(token);
      audit(req.userEmail, 'admin', 'invite:revoke', iv.full_name || token.slice(0, 8));
    }
    res.redirect('/admin/people');
  });

  app.post('/admin/people/edit', requireAdmin, (req, res) => {
    const { id } = req.body;
    const full_name = (req.body.full_name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const phone = (req.body.phone || '').trim();
    const dob = String(req.body.dob || '').trim();   // admin may set/correct/clear (blank = clear)
    const cur = db.prepare('SELECT email FROM applicants WHERE id = ?').get(id);
    if (!cur) return res.redirect('/admin/people');
    if (dob) { const age = ageFromDob(dob); if (age == null || age < 5 || age > 110) return res.redirect('/admin/people?msg=' + encodeURIComponent('That date of birth doesn’t look right.')); }
    // Validate before writing — a blank name/phone or an invalid email would otherwise be
    // saved AND (if email changed) rekey every per-user row onto '' via rekeyEmailTx. Mirrors
    // the self-service /profile validation.
    if (!full_name || !phone || !isValidEmail(email))
      return res.redirect('/admin/people?msg=' + encodeURIComponent('Name, phone, and a valid email are required.'));
    // if email changed, make sure it doesn't collide
    if (email !== cur.email) {
      const clash = db.prepare('SELECT 1 FROM applicants WHERE email = ? AND id != ?').get(email, id);
      if (clash) return res.redirect('/admin/people?msg=That+email+is+already+in+use');
      // Never rekey a player onto an admin address — admin identity is the ADMINS
      // env set keyed by email, so this would silently grant them admin.
      if (ADMINS.includes(email)) return res.redirect('/admin/people?msg=' + encodeURIComponent('That email is reserved and can’t be assigned.'));
    }
    // Identity row + rekey cascade commit together or not at all — see the same guard on
    // /profile. A partial commit strands the player's history on the old address.
    try {
      transact(() => {
        db.prepare('UPDATE applicants SET full_name=?, email=?, phone=?, dob=? WHERE id=?')
          .run(full_name, email, phone, dob || null, id);
        // Carry EVERY per-user row to the new address (single source of truth: rekeyEmailTx in db.js).
        if (email !== cur.email) rekeyEmailTx(cur.email, email);
        // keep the denormalised check-in name in sync across every program (name can change without email)
        db.prepare('UPDATE checkins SET name=? WHERE email=?').run(full_name, email);
      });
    } catch (e) {
      console.error(`[admin] identity edit FAILED for ${cur.email}: ${e.message}`);
      return res.redirect('/admin/people?msg=' + encodeURIComponent('Couldn’t save that — nothing was changed.'));
    }
    if (email !== cur.email) refreshAvatarMap(); // avatar file follows the id; re-key its email in the map
    audit(req.userEmail, 'admin', 'people:edit', email);
    pcoQueuePatch(email, { full_name, phone });   // mirror the edit into PCO People (outbox; inert unless connected)
    res.redirect('/admin/people?msg=Saved');
  });

  // Suspend / unsuspend a person (admin). Suspended = keeps account + history but can't
  // check in or post (see /checkin/join + mutedOut). Suspending also drops any current
  // check-in, offering a freed floor slot onward — a muted player shouldn't hold a spot.
  app.post('/admin/people/suspend', requireAdmin, (req, res) => {
    const id = Number(req.body.id) || 0;
    const on = req.body.on === '1';
    const reason = (req.body.reason || '').trim().slice(0, 300);
    const cur = db.prepare('SELECT email FROM applicants WHERE id = ?').get(id);
    if (!cur) return res.redirect('/admin/people');
    db.prepare('UPDATE applicants SET suspended = ?, suspend_reason = ? WHERE id = ?')
      .run(on ? 1 : 0, on ? (reason || null) : null, id);
    if (on) {
      const runDate = nextRunDate();
      const offeree = offereeForFloorLeave(runDate, cur.email);
      db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ? AND program_id = 1').run(runDate, cur.email);
      if (offeree) createOffer(runDate, offeree, req);
      // Suspension has to clear BOTH programs' floors. pkGate only blocks NEW pickleball
      // actions, so without this a suspended player keeps their seat all week and the
      // waitlist never promotes behind them.
      dropFromPickleball(cur.email);
    }
    audit(req.userEmail, 'admin', on ? 'people:suspend' : 'people:unsuspend', cur.email);
    res.redirect('/admin/people?msg=' + encodeURIComponent(on ? 'Suspended' : 'Unsuspended'));
  });
}

// ---------- ANALYTICS (F5) ----------
// The church-facing question isn't "who came Tuesday" (rosters answer that) — it's trend, reach and
// stickiness: is the run growing, how many are NEW, do people come back. Computed straight from the
// permanent attendance log; per-RUN buckets (not calendar weeks) because a run is the natural unit.
// Friendly names for notification kinds in the pulse breakdown. Tags carry program ids
// (wlmove2, gatedann) — match by family, fall back to the raw tag.
function pushKindLabel(tag) {
  if (!tag) return 'Untagged';
  if (tag === 'offer') return 'Spot offers';
  if (tag === 'announce' || /ann$/.test(tag)) return 'Announcements';
  if (tag === 'confirm') return 'Confirm reminders';
  if (/^wlmove/.test(tag)) return 'Waitlist moves';
  if (tag === 'adminlogin') return 'Admin sign-in alerts';
  if (/^joinreq/.test(tag)) return 'Join requests';
  if (/mention/.test(tag)) return 'Chat mentions';
  return tag;
}

// ---------- AUDIT VIEWER (S6 follow-up) — the permanent record, readable ----------
// audit_key_events is the never-pruned legal record (waiver verifications, role grants, admin
// sign-ins). These are its only read surfaces; nothing here can write to the table. Filters are
// whitelisted + bound — free text only ever reaches a LIKE parameter.
function keyEventQuery(req) {
  const q = String(req.query.q || '').trim().slice(0, 200);
  const action = String(req.query.action || '').trim().slice(0, 80);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = dateRe.test(String(req.query.from || '')) ? String(req.query.from) : '';
  const to = dateRe.test(String(req.query.to || '')) ? String(req.query.to) : '';
  const where = [], params = [];
  if (q) { where.push('(actor LIKE ? OR target LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (action) { where.push('action = ?'); params.push(action); }
  if (from) { where.push('at >= ?'); params.push(from + ' 00:00:00'); }
  if (to) { where.push('at <= ?'); params.push(to + ' 23:59:59'); }
  return { q, action, from, to, sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

export function mountAdminReports(app) {
  app.get('/admin/analytics', requireAdmin, (req, res) => {
    // Engagement pulse (metrics layer): actives from last_seen_at, notification volume + taps and
    // installs from metrics_events. Display-ready strings computed HERE so the view stays dumb.
    // Per-kind open rates: sends carry the tag in meta; taps carry "tag|path" since the SW started
    // passing &tag= (older tap rows are bare paths and stay out of the per-kind split).
    const kindAgg = new Map();
    for (const r of db.prepare("SELECT meta, COALESCE(SUM(n),0) s FROM metrics_events WHERE kind='push_send' AND at >= datetime('now','localtime','-30 days') GROUP BY meta").all()) {
      const k = pushKindLabel(r.meta); const a = kindAgg.get(k) || { sent: 0, opened: 0 }; a.sent += r.s; kindAgg.set(k, a);
    }
    for (const r of db.prepare("SELECT meta FROM metrics_events WHERE kind='push_tap' AND at >= datetime('now','localtime','-30 days')").all()) {
      const bar = String(r.meta || '').indexOf('|'); if (bar <= 0) continue;
      const k = pushKindLabel(r.meta.slice(0, bar)); const a = kindAgg.get(k) || { sent: 0, opened: 0 }; a.opened++; kindAgg.set(k, a);
    }
    const kinds = [...kindAgg.entries()].map(([label, v]) => ({ label, ...v })).sort((x, y) => y.sent - x.sent);
    const pulse = {
      kinds,
      wau: db.prepare("SELECT COUNT(*) n FROM applicants WHERE last_seen_at >= datetime('now','localtime','-7 days')").get().n,
      mau: db.prepare("SELECT COUNT(*) n FROM applicants WHERE last_seen_at >= datetime('now','localtime','-30 days')").get().n,
      pushes30: db.prepare("SELECT COALESCE(SUM(n),0) s FROM metrics_events WHERE kind='push_send' AND at >= datetime('now','localtime','-30 days')").get().s,
      taps30: db.prepare("SELECT COUNT(*) n FROM metrics_events WHERE kind='push_tap' AND at >= datetime('now','localtime','-30 days')").get().n,
      installs: db.prepare("SELECT COUNT(*) n FROM metrics_events WHERE kind='pwa_install'").get().n,
    };
    const cards = [];
    for (const p of PROGRAMS.values()) {
      if (p.id === 90) continue;
      const runs = db.prepare(`
      SELECT a.run_date, COUNT(*) n,
             SUM(CASE WHEN f.first = a.run_date THEN 1 ELSE 0 END) newcomers
      FROM attendance a
      JOIN (SELECT email, MIN(run_date) first FROM attendance WHERE program_id = ? GROUP BY email) f
        ON f.email = a.email
      WHERE a.program_id = ? AND a.email NOT LIKE '%@guest.local'
      GROUP BY a.run_date ORDER BY a.run_date DESC LIMIT 12`).all(p.id, p.id).reverse();
      if (!runs.length) continue;   // nothing to chart yet — the card would just be zeros
      const last4 = db.prepare('SELECT DISTINCT run_date FROM attendance WHERE program_id = ? ORDER BY run_date DESC LIMIT 4').all(p.id).map(r => r.run_date);
      const retained = last4.length < 4 ? null : db.prepare(`
      SELECT COUNT(*) n FROM (
        SELECT email FROM attendance WHERE program_id = ? AND run_date IN (${last4.map(() => '?').join(',')})
        GROUP BY email HAVING COUNT(DISTINCT run_date) >= 3)`).get(p.id, ...last4).n;
      const yr = db.prepare(`
      SELECT COUNT(*) total, COUNT(DISTINCT email) uniques
      FROM attendance WHERE program_id = ? AND run_date >= strftime('%Y-01-01','now') AND email NOT LIKE '%@guest.local'`).get(p.id);
      // Demand + fill-speed from run_summary (metrics layer) — appears once summaries exist.
      const rs = db.prepare(`SELECT COUNT(*) runs, AVG(wait_n) avgWait,
        SUM(offers_sent) osent, SUM(offers_claimed) oclaim,
        AVG(CASE WHEN opened_at IS NOT NULL AND filled_at IS NOT NULL
            THEN (julianday(filled_at) - julianday(opened_at)) * 1440 END) fillMins
      FROM run_summary WHERE program_id = ? AND cancelled = 0`).get(p.id);
      const demand = rs && rs.runs ? {
        runs: rs.runs,
        avgWait: (rs.avgWait ?? 0).toFixed(1),
        fillMins: rs.fillMins != null ? String(Math.round(rs.fillMins)) : null,
        claimPct: rs.osent ? String(Math.round((rs.oclaim / rs.osent) * 100)) : null,
      } : null;
      cards.push({ name: p.displayName, emoji: p.emoji, runs, retained, total: yr.total, uniques: yr.uniques, demand,
        active4: last4.length < 4 ? null : db.prepare(`SELECT COUNT(DISTINCT email) n FROM attendance WHERE program_id = ? AND run_date IN (${last4.map(() => '?').join(',')})`).get(p.id, ...last4).n });
    }
    res.send(analyticsPage({ cards, pulse }));
  });
  app.get('/admin/audit', requireAdmin, (req, res) => {
    const f = keyEventQuery(req);
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const total = db.prepare('SELECT COUNT(*) n FROM audit_key_events' + f.sql).get(...f.params).n;
    const rows = db.prepare('SELECT * FROM audit_key_events' + f.sql + ' ORDER BY id DESC LIMIT 101 OFFSET ?').all(...f.params, page * 100);
    const actions = db.prepare('SELECT DISTINCT action FROM audit_key_events ORDER BY action').all().map((r) => r.action);
    res.send(auditViewerPage({ rows: rows.slice(0, 100), hasMore: rows.length > 100, page, total, actions, q: f.q, action: f.action, from: f.from, to: f.to }));
  });
  // ---------- RUN HISTORY — the run_summary browser (proposal #1) ----------
  // Per-run receipts of the numbers the archive keeps: demand, fill speed, offer outcomes.
  // Read-only; CSV carries every row for spreadsheets/pitches.
  app.get('/admin/history', requireAdmin, (req, res) => {
    const sections = [];
    for (const p of PROGRAMS.values()) {
      if (p.config.static) continue;
      const rows = db.prepare(`SELECT *, CASE WHEN opened_at IS NOT NULL AND filled_at IS NOT NULL
        THEN CAST(ROUND((julianday(filled_at) - julianday(opened_at)) * 1440) AS INTEGER) END fill_mins
      FROM run_summary WHERE program_id = ? ORDER BY run_date DESC LIMIT 200`).all(p.id);
      if (rows.length) sections.push({ name: p.displayName, emoji: p.emoji, rows });
    }
    res.send(runHistoryPage({ sections }));
  });
  app.get('/admin/history.csv', requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT * FROM run_summary ORDER BY run_date DESC').all();
    const nameOf = (pid) => (PROGRAMS.get(pid) || { displayName: `program ${pid}` }).displayName;
    const lines = ['Program,Run date,Floor,Waitlisted,Guests,Cap,Cancelled,Check-in opened,First check-in,Floor full,Offers sent,Offers claimed,Offers expired',
      ...rows.map((r) => [nameOf(r.program_id), r.run_date, r.floor_n, r.wait_n, r.guest_n, r.cap, r.cancelled ? 'yes' : '', r.opened_at, r.first_checkin_at, r.filled_at, r.offers_sent, r.offers_claimed, r.offers_expired].map(csvCell).join(','))];
    res.setHeader('Content-Disposition', 'attachment; filename="run-history.csv"');
    res.type('text/csv').send('﻿' + lines.join('\r\n'));
  });

  app.get('/admin/audit.csv', requireAdmin, (req, res) => {
    const f = keyEventQuery(req);
    const rows = db.prepare('SELECT at, actor, actor_role, action, target FROM audit_key_events' + f.sql + ' ORDER BY id DESC').all(...f.params);
    const lines = ['When,Actor,Role,Action,Target', ...rows.map((r) => [r.at, r.actor, r.actor_role, r.action, r.target].map(csvCell).join(','))];
    res.setHeader('Content-Disposition', 'attachment; filename="key-events.csv"');
    res.type('text/csv').send('\uFEFF' + lines.join('\r\n')); // BOM = Excel reads UTF-8
  });
}

// ---------- BOTTOM-NAV LOCALIZER (admin) ----------
// The floating-nav bug only occurs in the installed iOS PWA, which nothing local can reproduce.
// Six fixes were written for it without one measurement from the failing device. An admin
// long-presses the masthead while the bug is on screen; this stores exactly what the device
// reported. docs/NAV-LOCALIZER.md maps a capture to a single mechanism — read, then fix.
// Admin-gated both ways: a member's long-press writes nothing (and shows nothing).
const stmtGeoInsert = db.prepare('INSERT INTO geo_reports (actor, server_ver, payload) VALUES (?,?,?)');

export function mountNavLocalizer(app) {
  app.post('/debug/geo', requireAdmin, express.raw({ type: '*/*', limit: '256kb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {});
    try { JSON.parse(raw); } catch { return res.status(400).end(); }   // store only valid JSON
    // The server stamps its OWN build, so client/server version skew is computed from a trusted side.
    const info = stmtGeoInsert.run(req.userEmail, String(BUILD_VER), raw);
    audit(req.userEmail, 'admin', 'debug:geo-capture', String(info.lastInsertRowid));
    res.status(204).end();
  });
  app.get('/debug/geo', requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT id, at, actor, server_ver, payload FROM geo_reports ORDER BY id DESC LIMIT 20').all();
    res.type('application/json').send(JSON.stringify(
      rows.map(r => ({ ...r, payload: (() => { try { return JSON.parse(r.payload); } catch { return r.payload; } })() })), null, 2));
  });
}

export function mountPeopleRecords(app) {
  // Admin confirms a waiver they have actually SEEN (a physical copy, or the church's own records).
  // This is a different claim from the member's self-report: the member attests they signed, an admin
  // attests they've seen it — so it writes waiver_verified_at (the same column the PCO form check
  // uses) and names the admin in the audit log. It never invents a SIGNING date: an optional
  // "signed on" is recorded when the admin knows it, otherwise only the verification date exists.
  app.post('/admin/people/waiver', requireAdmin, (req, res) => {
    const a = db.prepare('SELECT email, full_name FROM applicants WHERE id = ?').get(req.body.id);
    if (!a) return res.redirect('/admin/people?msg=' + encodeURIComponent('No such person.'));
    if (req.body.on === '0') {
      db.prepare('UPDATE applicants SET waiver_verified_at = NULL WHERE email = ?').run(a.email);
      audit(req.userEmail, 'admin', 'people:waiver-unverify', a.email);
      return res.redirect('/admin/people?msg=' + encodeURIComponent(`Cleared the confirmation for ${a.full_name} — their own attestation stands.`));
    }
    const signedOn = String(req.body.signed_on || '').trim();
    if (signedOn && !/^\d{4}-\d{2}-\d{2}$/.test(signedOn))
      return res.redirect('/admin/people?msg=' + encodeURIComponent('Use a date like 2026-07-15, or leave it blank.'));
    // A date the organizer supplies is AUTHORITATIVE — they've seen the signed document, so it
    // corrects a self-report's "when I ticked the box" timestamp (which is not a signing date at
    // all). No date given → whatever is on record stands. Either way the audit row carries the date,
    // so the correction is traceable.
    // The audit row carries the PRIOR attestation date: an admin-supplied date OVERWRITES it, and
    // without the before-value the correction's provenance vanishes once anyone asks "what changed".
    const prior = db.prepare('SELECT waiver_at FROM applicants WHERE email = ?').get(a.email)?.waiver_at || 'none';
    db.prepare(`UPDATE applicants SET waiver_ok = 1,
                waiver_at = COALESCE(?, waiver_at),
                waiver_verified_at = datetime('now','localtime') WHERE email = ?`)
      .run(signedOn || null, a.email);
    audit(req.userEmail, 'admin', 'people:waiver-verified' + (signedOn ? `:signed-${signedOn}:was-${prior}` : ''), a.email);
    res.redirect('/admin/people?msg=' + encodeURIComponent(`${a.full_name}'s waiver is confirmed on file.`));
  });

  app.post('/admin/people/delete', requireAdmin, (req, res) => {
    const { id } = req.body;
    const a = db.prepare('SELECT email, full_name, avatar FROM applicants WHERE id = ?').get(id);
    if (a) {
      // If they held a floor spot for the current run, offer it onward (capture before delete).
      const runDate = nextRunDate();
      const offeree = offereeForFloorLeave(runDate, a.email);
      db.prepare('DELETE FROM applicants WHERE id = ?').run(id);
      if (a.avatar) safeUnlinkAvatar(a.avatar); // delete their photo file on hard-delete
      db.prepare('DELETE FROM checkins WHERE email = ?').run(a.email);
      if (offeree) createOffer(runDate, offeree, req);
      db.prepare('DELETE FROM votes WHERE applicant_id = ?').run(id);      // votes cast ON them
      db.prepare('DELETE FROM pco_outbox WHERE email = ?').run(a.email);   // pending PCO writes die with the account (the PCO person is never deleted)
      db.prepare('DELETE FROM votes WHERE voter_email = ?').run(a.email);  // and votes they cast — else a
      // same-email re-registration made team would resurrect years-old approve/reject tallies.
      // hard-delete is the ONLY path that removes attendance history. checkins (above) and
      // attendance are program-generic now, so one delete per table clears every program.
      db.prepare('DELETE FROM attendance WHERE email = ?').run(a.email);
      // Best-effort: delete any chat photo FILES this person uploaded (DM + group) before
      // dropping the rows. Keyed by message id in the DB, so we collect the image paths
      // first, then unlink. Stickers (/stickers/*) are shared assets → safeUnlinkChatImage
      // no-ops on them, so only real /chat-media uploads are removed.
      for (const r of db.prepare('SELECT image FROM messages WHERE (from_email = ? OR to_email = ?) AND image IS NOT NULL').all(a.email, a.email))
        safeUnlinkChatImage(r.image);
      // group messages can also carry voice/video uploads — clean all three media files
      // group_messages spans every program now, so this one sweep collects pickleball media too.
      for (const r of db.prepare('SELECT image, audio, video FROM group_messages WHERE from_email = ?').all(a.email)) {
        safeUnlinkChatImage(r.image); safeUnlinkChatImage(r.audio); safeUnlinkChatImage(r.video);
      }
      // purge messaging: their own reactions everywhere, reactions on their messages,
      // then their messages (both directions). Ordered so no orphaned rows survive,
      // independent of the FK cascade.
      db.prepare('DELETE FROM message_reactions WHERE from_email = ?').run(a.email);
      db.prepare('DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE from_email = ? OR to_email = ?)').run(a.email, a.email);
      db.prepare('DELETE FROM messages WHERE from_email = ? OR to_email = ?').run(a.email, a.email);
      // purge Run Chat: their own reactions everywhere, reactions on their messages,
      // their messages, and their read marker. Ordered so no orphan rows survive.
      db.prepare('DELETE FROM group_reactions WHERE from_email = ?').run(a.email);
      db.prepare('DELETE FROM group_reactions WHERE group_message_id IN (SELECT id FROM group_messages WHERE from_email = ?)').run(a.email);
      db.prepare('DELETE FROM group_messages WHERE from_email = ?').run(a.email);
      db.prepare('DELETE FROM group_reads WHERE email = ?').run(a.email);  // (email,program_id) PK → clears every program's marker
      db.prepare('DELETE FROM program_membership WHERE email = ?').run(a.email); // drop all per-program memberships
      db.prepare('DELETE FROM push_subscriptions WHERE email = ?').run(a.email);
      // Per-week sit-outs + announcement read/dismiss markers. These outlived the delete, which
      // both leaked rows forever and left a live PK-collision trap for anyone later rekeyed ONTO
      // this address (see rekeyEmailTx). Any unused sign-in link is revoked too — a delete the
      // admin just performed shouldn't leave a working magic link in an inbox.
      db.prepare('DELETE FROM regular_optout WHERE email = ?').run(a.email);  // program-generic → clears every program's sit-outs
      db.prepare('DELETE FROM team_assignments WHERE email = ?').run(a.email); // and any run-team assignments
      db.prepare('DELETE FROM announcement_reads WHERE email = ?').run(a.email);
      db.prepare('DELETE FROM announcement_dismissals WHERE email = ?').run(a.email);
      db.prepare('DELETE FROM login_tokens WHERE email = ?').run(a.email);
      db.prepare('DELETE FROM waiver_records WHERE email = ?').run(a.email);   // per-program waivers (F6) — guardian contact details are PII, gone on hard-delete
      // The ladder is a SECOND identity space (it holds people who never had an app account), so it
      // is not reached by any of the email-keyed sweeps above. Without this the deleted person stayed
      // in the picker and kept their name on the public wall board.
      purgeLadderIdentity(a.email);
      // Same reasoning for the run roster + game results: a synced registrant is a THIRD identity
      // space (they may never have had an app account at all). Their seats are tombstoned rather
      // than deleted, so the games they played still show the right number of players a side.
      purgeGameIdentity(a.email);
      // Social graph (Phase 6): drop every edge touching this person, in BOTH directions, so a
      // same-email re-registration can't inherit stale friendships/blocks (mirrors the votes purge).
      db.prepare('DELETE FROM social_edges WHERE from_email = ? OR to_email = ?').run(a.email, a.email);
      // Queue-with-friends (Phase 6b): drop their party memberships, and dissolve any party they LED
      // — clearing the group pointer off every remaining member's checkin so none dangle.
      db.prepare('DELETE FROM signup_group_members WHERE email = ?').run(a.email);
      const ledGroups = db.prepare('SELECT id FROM signup_groups WHERE leader_email = ?').all(a.email).map(r => r.id);
      if (ledGroups.length) {
        const gph = ledGroups.map(() => '?').join(',');
        db.prepare(`UPDATE checkins SET group_id = NULL WHERE group_id IN (${gph})`).run(...ledGroups);
        db.prepare(`DELETE FROM signup_group_members WHERE group_id IN (${gph})`).run(...ledGroups);
        db.prepare('DELETE FROM signup_groups WHERE leader_email = ?').run(a.email);
      }
      // Persistent parties (Friends-tab layer): same shape — drop memberships, dissolve led parties.
      db.prepare('DELETE FROM party_members WHERE email = ?').run(a.email);
      const ledParties = db.prepare('SELECT id FROM parties WHERE leader_email = ?').all(a.email).map(r => r.id);
      if (ledParties.length) {
        db.prepare(`DELETE FROM party_members WHERE party_id IN (${ledParties.map(() => '?').join(',')})`).run(...ledParties);
        db.prepare('DELETE FROM parties WHERE leader_email = ?').run(a.email);
      }
      refreshAvatarMap(); // drop them from the email→photo registry
      audit(req.userEmail, 'admin', 'people:delete', a.email);
    }
    res.redirect('/admin/people?msg=Deleted');
  });
}
