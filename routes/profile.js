// routes/profile.js — profiles: another player's profile and card (/u/:id), your own profile tab
// with edits and photo, and its settings (chat push opt-in, sign out everywhere).
import crypto from 'crypto';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import db, { rekeyEmailTx, transact } from '../db.js';
import { AVATARS_DIR } from '../config.js';
import { pcoQueuePatch } from '../pco.js';
import { requireLogin, setSession, isAdmin, ADMINS, clearSession } from '../auth.js';
import { profileCard, profilePage, profileTabPage } from '../views.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { isValidEmail } from '../lib/email.js';
import { rateLimited } from '../lib/rate-limit.js';
import { refreshAvatarMap, uploadAvatar, sniffImage, safeUnlinkAvatar } from '../lib/media.js';
import { isMinor, stmtApplicantById, applicantByEmail, ageFromDob } from '../engine/applicants.js';
import { P, runCookie, PROGRAMS } from '../engine/programs.js';
import { nextRunDate, runTimeRange } from '../engine/basketball-calendar.js';
import { annPanel, announcementHistory } from '../engine/announcements.js';
import {
  canMessage, blockedPair, iBlocked, isFollowing, relationshipTo, friendsOf, followersOf,
  friendReqIncomingCount,
} from '../engine/social.js';
import { chatProgramFor, chatCountsFor, groupUnread, groupMentionUnread } from '../engine/chat.js';
import { unreadCount, loadInbox } from '../engine/messages.js';
import { requirePlayer } from './guards.js';

// --- attendance ("games attended") helpers -------------------------------
// The attendance table is the permanent log of who was on the FINAL floor each
// Friday; loadRun() archives into it right before its weekly checkins purge.
// Hoisted — attendanceStats runs on every profile page/card render (node:sqlite has no stmt cache).
const stmtAttTotal = db.prepare('SELECT COUNT(*) n FROM attendance WHERE email = ? AND program_id = 1');
const stmtAttSeason = db.prepare("SELECT COUNT(*) n FROM attendance WHERE email = ? AND program_id = 1 AND run_date >= strftime('%Y-01-01','now')");
const stmtAttDates = db.prepare('SELECT run_date FROM attendance WHERE email = ? AND program_id = 1 ORDER BY run_date ASC');
function attendanceStats(email) {
  const total = stmtAttTotal.get(email).n;
  const season = stmtAttSeason.get(email).n;
  const dates = stmtAttDates.all(email).map(r => r.run_date);
  const first = dates.length ? dates[0] : null;
  // Longest run of consecutive runs attended. Compare CALENDAR days (UTC-midnight floor,
  // DST-safe). Runs are ~weekly, but the host can MOVE a run, so a 4–10-day gap still
  // means "the very next run" (not a 7-day-exact match); >10 days means a run was missed.
  let streak = 0, cur = 0, prevUtc = null;
  for (const s of dates) {
    const utc = Date.parse(s + 'T00:00:00Z');
    const days = prevUtc != null ? Math.round((utc - prevUtc) / 86400000) : null;
    cur = (days !== null && days >= 4 && days <= 10) ? cur + 1 : 1;
    if (cur > streak) streak = cur;
    prevUtc = utc;
  }
  return { total, season, streak, first, dates };
}

// ---------- PROFILE (own editable tab) ----------
// Positions are PER-PROGRAM config now (config.positions = [[code,label],…]) so a new sport
// declares its own set in the wizard instead of editing a hardcoded list (F6). The save whitelist
// is the union across ALL programs (hidden ones included — hiding a program must not strip its
// members' stored picks on the next profile save) plus the legacy codes that predate the config.
const LEGACY_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C', 'S', 'OH', 'MB', 'OPP', 'L', 'DS'];
function positionWhitelist() {
  const set = new Set(LEGACY_POSITIONS);
  for (const p of PROGRAMS.values()) for (const [code] of (p.config.positions || [])) set.add(code);
  return set;
}
// Profile picker groups: one chip row per program that declares positions. Hidden programs keep
// their group visible (pre-F6 the two sport rows always showed, vb hidden or not — same UI, and a
// member's picks for a program that later publishes are already in place).
function positionGroups() {
  const groups = [];
  for (const p of PROGRAMS.values()) {
    if (!p.config.positions || !p.config.positions.length || p.config.static) continue;
    groups.push({ label: p.displayName, chips: p.config.positions });
  }
  return groups;
}

export function mountProfile(app) {
  // ---------- PROFILE (view another player) ----------
  // Compact profile card fragment for the who's-going quick-look popup (fetched by pvOpen).
  app.get('/u/:id/card', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    const p = stmtApplicantById.get(Number(req.params.id) || 0);
    if (!p || (p.status !== 'approved' && !gate.viewerIsAdmin)) return res.status(404).send('');
    const canContact = gate.viewerIsAdmin || !!(gate.a && gate.a.is_team);
    const canDM = canMessage(req.userEmail, gate.a, p);   // hide Message when the server would block it (block / minor)
    const myBlock = iBlocked(req.userEmail, p.email);   // only MY OWN block renders Unblock — a reverse block must not show a phantom row
    res.send(profileCard({ p, stats: attendanceStats(p.email), canDM, isSelf: p.email === req.userEmail, minor: isMinor(p), showRoles: gate.viewerIsAdmin, following: isFollowing(req.userEmail, p.email), blocked: myBlock, restricted: blockedPair(req.userEmail, p.email) && !myBlock }));
  });

  app.get('/u/:id', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    const p = stmtApplicantById.get(Number(req.params.id) || 0);
    if (!p || (p.status !== 'approved' && !gate.viewerIsAdmin)) return res.redirect('/checkin');
    // OWNER RULE: operators (admin/team) see full name + phone; regular players don't.
    const canContact = gate.viewerIsAdmin || !!(gate.a && gate.a.is_team);
    const chatProgram = chatProgramFor(req);
    const cc = chatCountsFor(chatProgram || 1, req.userEmail, gate.a ? gate.a.id : 0);
    res.send(profilePage({
      p, stats: attendanceStats(p.email), isSelf: p.email === req.userEmail, canContact,
      canDM: canMessage(req.userEmail, gate.a, p), // hide Message when the server would block it (block / minor)
      rel: relationshipTo(req.userEmail, p.email), // friend/block affordance state
      following: isFollowing(req.userEmail, p.email), // one-way follow affordance
      runDate: nextRunDate(),
      hours: runTimeRange(nextRunDate()),
      back: P(runCookie(req)).paths.chat, // Back returns to the run you came from (its own chat room)
      dmUnread: unreadCount(req.userEmail), groupUnread: cc.group,
      groupMention: cc.gm, chatProgram, // Chat tab reflects the run they've joined (or locks if none)
      ann: annPanel(req.userEmail),
      minor: isMinor(p), // red safeguarding badge on the profile (visible to every viewer)
      showRoles: gate.viewerIsAdmin, // role badges are admin-eyes-only
    }));
  });
  app.get('/profile', requireLogin, async (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    const a = gate.a;
    if (!a) return res.redirect('/status'); // admins with no applicant row have nothing to edit
    // Door check-in pass (Phase 2b): renders ONLY from a VERIFIED code (pco_pass_code is written
    // by the read-back, never assumed) and only while the admin has passes switched on.
    let passQr = '';
    if (getSetting('pco_pass_enabled') === '1' && a.pco_pass_code) {
      try { passQr = await QRCode.toString(a.pco_pass_code, { type: 'svg', margin: 1, color: { dark: '#183B38', light: '#ffffff' } }); }
      catch (e) { console.error(`[pco] pass QR failed for ${a.email}: ${e.message}`); }
    }
    // Operator announcement history lives here now (moved off the check-in page).
    const canOperate = gate.viewerIsAdmin || !!a.is_team;
    // Host DM inbox lives on the host's own profile tab now (no Messages tab). Only
    // the host loads/sees it; players get no inbox here.
    const iAmHost = !!a.is_host;
    // Run-day + Cancel-run controls now live on the check-in page's Operator-tools card
    // (moved off the profile), so nothing run-day-related is computed here anymore.
    // Photo upload/remove outcome → view notice. ok/removed = success; err:<code> maps
    // to a friendly message in the view. Codes come from the /profile/photo route below.
    const photoMsg = req.query.photo ? String(req.query.photo)
      : (req.query.photoerr ? 'err:' + String(req.query.photoerr) : '');
    const chatProgram = chatProgramFor(req);
    const cc = chatCountsFor(chatProgram || 1, a.email, a.id);
    res.send(profileTabPage({ a, stats: attendanceStats(a.email), saved: req.query.saved === '1', error: '', passQr, passCode: a.pco_pass_code || '',
      dmUnread: unreadCount(a.email), groupUnread: cc.group, groupMention: cc.gm, chatProgram, canOperate, announcementLog: canOperate ? announcementHistory() : [],
      friendCount: friendsOf(a.email).length, friendReqIn: friendReqIncomingCount(a.email), followerCount: followersOf(a.email).length, // Friends entry-point summary
      iAmHost, threads: loadInbox(a.email), photoMsg, ann: annPanel(a.email), minor: isMinor(a), showRoles: gate.viewerIsAdmin,
      positionGroups: positionGroups() }));
  });

  // ---------- PROFILE PHOTO (upload / remove) ----------
  // Tap the avatar → Photos picker → auto-submits here. multer buffers the file in
  // memory (10 MB cap); we sniff MAGIC BYTES (not the client MIME/extension), then
  // sharp square-cover-crops to 512×512, applies EXIF orientation, STRIPS metadata,
  // and re-encodes to ~80% JPEG (≈40–90 KB). Stored under a SERVER-derived name
  // (<id>-<hex>.jpg) — the user's filename never touches disk, so no path traversal.
  // The previous file is deleted on replace. Rate-limited via the shared limiter.
  app.post('/profile/photo', requireLogin, (req, res) => {
    uploadAvatar(req, res, async (err) => {
      const a = applicantByEmail(req.userEmail);
      if (!a) return res.redirect('/status');
      if (rateLimited('avatar', req.userEmail, 10, 10 * 60 * 1000))
        return res.redirect('/profile?photoerr=slow');
      if (err) {
        const code = (err && err.code === 'LIMIT_FILE_SIZE') ? 'big' : 'bad';
        return res.redirect('/profile?photoerr=' + code);
      }
      const file = req.file;
      if (!file || !file.buffer || !file.buffer.length) return res.redirect('/profile?photoerr=none');
      if (!sniffImage(file.buffer)) return res.redirect('/profile?photoerr=type'); // magic-byte gate
      try {
        const out = await sharp(file.buffer, { failOn: 'error' })
          .rotate()                                        // bake EXIF orientation in…
          .resize(512, 512, { fit: 'cover', position: 'centre' })
          .jpeg({ quality: 80, mozjpeg: true })            // …then re-encode (metadata stripped by default)
          .toBuffer();
        const fname = `${a.id}-${crypto.randomBytes(6).toString('hex')}.jpg`;
        await fs.promises.writeFile(path.join(AVATARS_DIR, fname), out); // async write off the event loop
        // Re-read the CURRENT avatar right before the swap (post-await): `a` was fetched before the
        // sharp/writeFile awaits, so two concurrent uploads would both see the original and both
        // delete IT — orphaning the first upload's file. Reading it here chains the unlink to
        // whatever was current when this upload takes over.
        const prev = db.prepare('SELECT avatar FROM applicants WHERE id = ?').get(a.id)?.avatar;
        db.prepare('UPDATE applicants SET avatar = ? WHERE id = ?').run(fname, a.id);
        if (prev && prev !== fname) safeUnlinkAvatar(prev); // drop the old file on replace
        refreshAvatarMap();
        audit(req.userEmail, 'player', 'profile:photo', a.email);
        return res.redirect('/profile?photo=ok');
      } catch (e) {
        console.error(`[avatar] process failed for ${a.email}: ${e.message}`);
        return res.redirect('/profile?photoerr=proc');
      }
    });
  });

  // Revert to the initials disc: clear applicants.avatar + delete the file.
  app.post('/profile/photo/remove', requireLogin, (req, res) => {
    const a = applicantByEmail(req.userEmail);
    if (!a) return res.redirect('/status');
    if (rateLimited('avatar', req.userEmail, 10, 10 * 60 * 1000)) return res.redirect('/profile?photoerr=slow');
    const prev = a.avatar;
    if (prev) {
      db.prepare('UPDATE applicants SET avatar = NULL WHERE id = ?').run(a.id);
      safeUnlinkAvatar(prev);
      refreshAvatarMap();
      audit(req.userEmail, 'player', 'profile:photo:remove', a.email);
    }
    res.redirect('/profile?photo=removed');
  });

  app.post('/profile', requireLogin, (req, res) => {
    const a = applicantByEmail(req.userEmail);
    if (!a) return res.redirect('/status');
    const full_name = (req.body.full_name || '').trim().slice(0, 60);
    const phone = (req.body.phone || '').trim().slice(0, 30);
    const email = (req.body.email || '').trim().toLowerCase();
    // position is now multi-select (checkboxes): array, single string, or absent
    let posInput = req.body.position || [];
    if (typeof posInput === 'string') posInput = [posInput];
    const posOk = positionWhitelist();
    const position = [...new Set(posInput.filter(p => p && posOk.has(p)))].join(',');
    // Email opt-out — an unchecked checkbox doesn't POST, so absent = opted OUT.
    const email_optout = req.body.email_announce ? 0 : 1;
    // DOB: SET-ONCE by the member (add it if legacy/missing); an already-set dob can only be changed by
    // an admin — otherwise a minor could self-edit to adult and unlock DMs. Blank on edit = leave as-is.
    const dobIn = String(req.body.dob || '').trim();
    let dobToSave = a.dob || null;
    const stats = attendanceStats(a.email);
    // Full prop set so a validation error re-renders the WHOLE profile tab (bell, host inbox,
    // run-day control, announcement history) — not a stripped-down page. Reused by every error branch.
    const iAmHost = !!a.is_host, canOperate = isAdmin(req.userEmail) || !!a.is_team;
    const errProps = {
      a, stats, dmUnread: unreadCount(a.email), groupUnread: groupUnread(a.email), groupMention: groupMentionUnread(a.email, a.id),
      canOperate, iAmHost, announcementLog: canOperate ? announcementHistory() : [], threads: loadInbox(a.email), ann: annPanel(a.email),
      chatProgram: chatProgramFor(req), // keep the run-aware Chat tab correct on a validation re-render too
      minor: isMinor(a), // red safeguarding badge (dob is set-once, so unchanged on an error re-render)
      positionGroups: positionGroups(),
    };
    if (!full_name || !phone || !isValidEmail(email))
      return res.send(profileTabPage({ ...errProps, error: 'Name, phone, and a valid email are required.' }));
    if (email !== a.email && db.prepare('SELECT 1 FROM applicants WHERE email = ? AND id != ?').get(email, a.id))
      return res.send(profileTabPage({ ...errProps, error: 'That email is already in use by another player.' }));
    // Never let a self-service email change grant admin. Admin identity is the
    // ADMINS env set keyed by email, so changing INTO an admin address = takeover.
    if (email !== a.email && ADMINS.includes(email))
      return res.send(profileTabPage({ ...errProps, error: 'That email can’t be used. Pick another.' }));
    if (!a.dob && dobIn) {   // settable only when currently empty
      const age = ageFromDob(dobIn);
      if (age == null || age < 5 || age > 110) return res.send(profileTabPage({ ...errProps, error: 'That date of birth doesn’t look right.' }));
      dobToSave = dobIn;
    }
    // The identity row and its rekey cascade commit together or not at all — committing the
    // applicants row first would leave every history row (checkins, votes, DMs, chat, push subs)
    // stranded on the old address if the cascade failed, orphaning the account.
    try {
      transact(() => {
        db.prepare('UPDATE applicants SET full_name=?, phone=?, email=?, position=?, email_optout=?, dob=? WHERE id=?')
          .run(full_name, phone, email, position, email_optout, dobToSave, a.id);
        // Carry EVERY per-user row (checkins, attendance, votes, DMs, Run Chat, reads, push
        // subs, opt-outs…) onto the new address. rekeyEmailTx in db.js is the single source
        // of truth for the cascade.
        if (email !== a.email) rekeyEmailTx(a.email, email);
        // Name can change without the email changing — sync the denormalised name across the
        // person's check-in rows in every program (checkins is program-generic; one update covers all).
        db.prepare('UPDATE checkins SET name=? WHERE email=?').run(full_name, email);
      });
    } catch (e) {
      console.error(`[profile] identity edit FAILED for ${a.email}: ${e.message}`);
      return res.send(profileTabPage({ ...errProps, error: 'Couldn’t save that — your details are unchanged. Try again.' }));
    }
    audit(req.userEmail, 'player', 'profile:edit', email);
    pcoQueuePatch(email, { full_name, phone });   // mirror the edit into PCO People (outbox; inert unless connected)
    if (email !== a.email) { setSession(res, email); refreshAvatarMap(); } // cookie IS the email — re-sign it; re-key the avatar map
    res.redirect('/profile?saved=1');
  });
}

export function mountProfileSettings(app) {
  // "Sign out everywhere": bump the version → every cookie ever issued for this account dies at its
  // next request, including on a lost/stolen device. Key-event audited (S6) — a revocation is
  // exactly the record someone asks about later.
  // Opt-in "every chat message" pushes (2026-08-05). Default OFF = the standing posture
  // (announcements / offers / mentions / DMs only). Per person, all programs.
  app.post('/profile/chatpush', requireLogin, (req, res) => {
    db.prepare('UPDATE applicants SET chat_push = ? WHERE email = ?')
      .run(req.body.on === '1' ? 1 : 0, req.userEmail);
    res.redirect('/profile');
  });
  app.post('/profile/logoutall', requireLogin, (req, res) => {
    const email = req.userEmail.toLowerCase();
    const r = db.prepare('UPDATE applicants SET session_ver = session_ver + 1 WHERE email = ?').run(email);
    if (!r.changes) setSetting('sessver_' + email, Number(getSetting('sessver_' + email) || 0) + 1);
    audit(email, 'player', 'session:signout-all', '');
    clearSession(res);
    res.redirect('/login?msg=' + encodeURIComponent('Signed out on every device. Sign in again below.'));
  });
}
