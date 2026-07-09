// server.js — The Bridge Adv Runs
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';

import db from './db.js';
import { startBackups } from './backup.js';
import { sendMagicLink, emailConfigured } from './mailer.js';
import {
  setSession, clearSession, currentUser, isAdmin,
  requireLogin, requireAdmin, makeRequireApprover, ADMINS,
} from './auth.js';
import {
  intakePage, loginPage, checkinPage, adminPage, statusPage, peoplePage, invitePage, sharePage,
} from './views.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const CAP = Number(process.env.RUN_CAP || 15);
const WAITLIST_CAP = Number(process.env.WAITLIST_CAP || 5);
const TOTAL_CAP = CAP + WAITLIST_CAP;
const VOTE_THRESHOLD = Number(process.env.VOTE_THRESHOLD || 3); // approvals to get in / rejects to block
const PREREG_CAP = Number(process.env.PREREG_CAP || process.env.REGULAR_CAP || 10); // max team+regular pre-joining while closed; reserves the rest for normals
const requireApprover = makeRequireApprover(db);

function audit(actor, actorRole, action, target) {
  db.prepare('INSERT INTO audit_log (actor,actor_role,action,target) VALUES (?,?,?,?)')
    .run(actor, actorRole, action, target || '');
}

// ---- in-memory rate limiter ----
// Guards the two unauthenticated POSTs (/login, /apply). /login fires a real
// Gmail send for any email typed in, so without this a loop could email-bomb an
// address and burn our ~500/day Gmail quota (locking out real sign-ins). Sliding
// window per key; buckets are plain Maps, fine for a single-process app at this
// scale. Pruned lazily on each hit so they don't grow unbounded.
const rlBuckets = new Map();
function rateLimited(bucket, key, limit, windowMs, now = Date.now()) {
  let m = rlBuckets.get(bucket);
  if (!m) { m = new Map(); rlBuckets.set(bucket, m); }
  const cutoff = now - windowMs;
  const hits = (m.get(key) || []).filter(t => t > cutoff);
  if (hits.length >= limit) { m.set(key, hits); return true; }
  hits.push(now);
  m.set(key, hits);
  return false;
}
function clientIp(req) {
  // Behind Tailscale Funnel / any proxy, the real IP is in X-Forwarded-For.
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function latestAnnouncement() {
  // the live one players see — archived posts are history only
  return db.prepare('SELECT * FROM announcements WHERE archived = 0 ORDER BY id DESC LIMIT 1').get() || null;
}
function announcementHistory(limit = 40) {
  // newest first; includes the live one plus everything archived
  return db.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT ?').all(limit);
}

// The people who vote: TEAM MEMBERS ONLY. Admins run the app but do not vote —
// approval decisions belong to the team (unanimous).
function approverEmails() {
  return new Set(
    db.prepare('SELECT email FROM applicants WHERE is_team = 1').all()
      .map(r => r.email.toLowerCase()));
}

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
    if (status === 'rejected') db.prepare('DELETE FROM checkins WHERE email = ?').run(app.email);
  }
  return status;
}

// Vote detail for the council UI.
function voteInfo(id, viewerEmail) {
  const pool = approverEmails();
  const votes = db.prepare('SELECT voter_email,vote FROM votes WHERE applicant_id = ?').all(id);
  const inPool = votes.filter(v => pool.has(v.voter_email.toLowerCase()));
  const approved = inPool.filter(v => v.vote === 'approve').map(v => v.voter_email.toLowerCase());
  const rejected = inPool.filter(v => v.vote === 'reject').map(v => v.voter_email.toLowerCase());
  const voted = new Set(inPool.map(v => v.voter_email.toLowerCase()));
  const waiting = [...pool].filter(e => !voted.has(e));
  const mine = votes.find(v => v.voter_email.toLowerCase() === viewerEmail.toLowerCase());
  return { poolSize: pool.size, threshold: VOTE_THRESHOLD, approved, rejected, waiting, myVote: mine?.vote || null };
}

app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', immutable: false }));

// Sliding session: any request carrying a valid cookie gets its 180-day window
// pushed forward, so a player who keeps showing up never has to sign in again.
// Static assets are served above and never reach this.
app.use((req, res, next) => {
  const email = currentUser(req);
  if (email) setSession(res, email);
  next();
});

// PWA manifest — controls the icon + name when players "Add to Home Screen".
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').send(JSON.stringify({
    name: 'The Bridge Adv Runs',
    short_name: 'Bridge Runs',
    start_url: '/checkin',
    scope: '/',
    display: 'standalone',
    background_color: '#2C6B66',
    theme_color: '#2C6B66',
    icons: [
      { src: '/icon-192.png?v=2', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }));
});

// ---- helpers ----
function nextFriday(d = new Date()) {
  const r = new Date(d);
  const day = r.getDay();            // 0 Sun … 5 Fri
  const add = (5 - day + 7) % 7;
  // Stays on this Friday all day; at Saturday 00:00 it rolls to next Friday —
  // so the queue resets at midnight and regulars can re-queue right away.
  r.setDate(r.getDate() + add);
  return r.toISOString().slice(0, 10); // YYYY-MM-DD
}
function runLabelFor(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function applicantByEmail(email) {
  return db.prepare('SELECT * FROM applicants WHERE email = ?').get(email.toLowerCase());
}

// ---------- INTAKE (public application form → council votes) ----------
app.get('/', (req, res) => res.send(intakePage()));

app.post('/apply', (req, res) => {
  // Cap application spam per IP so nobody can flood the pending list.
  if (rateLimited('apply-ip', clientIp(req), 8, 10 * 60 * 1000)) {
    return res.send(intakePage({ error: 'Too many submissions from here — give it a few minutes and try again.' }));
  }
  const { full_name, phone, email, where_played, waiver_ok } = req.body;
  // levels can be a single string, an array, or undefined
  let levels = req.body.levels || [];
  if (typeof levels === 'string') levels = [levels];
  const otherText = (req.body.levels_other || '').trim();
  // replace bare "Other" with the typed value
  const experience = levels
    .map(l => (l === 'Other' && otherText) ? `Other: ${otherText}` : l)
    .filter(l => l && l !== 'Other')
    .join(', ');
  if (!full_name || !phone || !email || !experience) {
    return res.send(intakePage({ error: 'Please fill in name, phone, email, and at least one level.' }));
  }
  const em = String(email).trim().toLowerCase();
  try {
    const existing = applicantByEmail(em);
    if (existing) {
      db.prepare(`UPDATE applicants SET full_name=?, phone=?, experience=?, where_played=?, waiver_ok=?
                  WHERE email=?`)
        .run(full_name.trim(), phone.trim(), experience, (where_played || '').trim(),
             waiver_ok ? 1 : 0, em);
    } else {
      db.prepare(`INSERT INTO applicants (full_name,email,phone,experience,where_played,waiver_ok)
                  VALUES (?,?,?,?,?,?)`)
        .run(full_name.trim(), em, phone.trim(), experience, (where_played || '').trim(),
             waiver_ok ? 1 : 0);
    }
    res.send(intakePage({ submitted: true }));
  } catch (e) {
    console.error(e);
    res.send(intakePage({ error: 'Something broke on our end. Try again.' }));
  }
});

// ---------- LOGIN (magic link) ----------
app.get('/login', (req, res) => {
  if (currentUser(req)) return res.redirect(req.query.next || '/checkin');
  res.send(loginPage({ next: req.query.next || '' }));
});

app.post('/login', async (req, res) => {
  const em = String(req.body.email || '').trim().toLowerCase();
  const next = req.body.next || '/checkin';
  if (!em || !em.includes('@')) return res.send(loginPage({ error: 'Enter a valid email.' }));

  // Throttle magic-link sends: at most 3 per address / 5 min (stops bombing one
  // inbox) and 20 per IP / 10 min (stops cycling through many addresses). Both
  // protect our Gmail daily quota.
  if (rateLimited('login-email', em, 3, 5 * 60 * 1000) ||
      rateLimited('login-ip', clientIp(req), 20, 10 * 60 * 1000)) {
    return res.send(loginPage({ next,
      error: 'You’ve requested a few links already — check your inbox (and spam), then wait a minute before trying again.' }));
  }

  const token = crypto.randomBytes(24).toString('base64url');
  const expires = Date.now() + 15 * 60 * 1000;
  // Requesting a new link invalidates any older unused ones for this email,
  // so a "resend" always leaves exactly one valid link.
  db.prepare('UPDATE login_tokens SET used = 1 WHERE email = ? AND used = 0').run(em);
  db.prepare('INSERT INTO login_tokens (token,email,expires_at) VALUES (?,?,?)')
    .run(token, em, expires);

  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const link = `${base}/auth?token=${token}&next=${encodeURIComponent(next)}`;

  if (emailConfigured) {
    // Don't make the player wait on the email — respond instantly, then send on
    // the next tick so even nodemailer's synchronous MIME/TLS setup happens
    // AFTER the response is flushed. A failure is logged loudly here; the "check
    // your email" page tells them how to request a fresh link.
    res.send(loginPage({ sent: true, email: em }));
    setImmediate(() => {
      sendMagicLink(em, link).catch(err =>
        console.error(`[login] magic-link send FAILED for ${em}: ${err.message}`));
    });
    return;
  } else {
    // Dev mode: no SMTP configured — the "send" just returns the link to show.
    const result = await sendMagicLink(em, link);
    res.send(loginPage({ sent: true, email: em, devLink: result.dev ? link : '' }));
  }
});

app.get('/auth', (req, res) => {
  const { token, next } = req.query;
  const row = db.prepare('SELECT * FROM login_tokens WHERE token = ?').get(token || '');
  if (!row || row.used || row.expires_at < Date.now()) {
    return res.send(loginPage({ next: next || '',
      error: 'That link is expired or already used — enter your email to get a fresh one. Use the same email you applied with.' }));
  }
  db.prepare('UPDATE login_tokens SET used = 1 WHERE token = ?').run(token);
  setSession(res, row.email);
  res.redirect(next || '/checkin');
});

app.get('/logout', (req, res) => { clearSession(res); res.redirect('/'); });

// ---------- INVITE LINK (self-serve pre-approval) ----------
// An admin creates a token — optionally with name/phone already filled in, or
// totally blank. The player opens the link, fills in whatever's missing, and
// is created as approved (with whatever role the admin picked) — no vote, no
// waiting on the admin to type in their contact info by hand.
app.get('/invite/:token', (req, res) => {
  const iv = db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);
  if (!iv) return res.send(invitePage({ invalid: true }));
  if (iv.used) return res.send(invitePage({ used: true }));
  res.send(invitePage({ token: iv.token, full_name: iv.full_name, phone: iv.phone, email: iv.email }));
});

app.post('/invite/:token', (req, res) => {
  const iv = db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);
  if (!iv) return res.send(invitePage({ invalid: true }));
  if (iv.used) return res.send(invitePage({ used: true }));

  const full_name = (req.body.full_name || iv.full_name || '').trim();
  const phone = (req.body.phone || iv.phone || '').trim();
  const email = (req.body.email || iv.email || '').trim().toLowerCase();
  const waiverOk = req.body.waiver_ok ? 1 : 0;
  if (!full_name || !phone || !email || !email.includes('@') || !waiverOk) {
    return res.send(invitePage({
      token: iv.token, full_name, phone, email,
      error: !waiverOk ? 'Please confirm the waiver to continue.' : 'Fill in your name, phone, and a valid email.',
    }));
  }

  const isTeam = iv.role === 'team' ? 1 : 0;
  const isRegular = iv.role === 'regular' ? 1 : 0;
  const existing = applicantByEmail(email);
  if (existing) {
    // Someone with this email is already on file — approve + apply the
    // invite's role rather than creating a duplicate.
    db.prepare('UPDATE applicants SET status=?, is_team=?, is_regular=?, full_name=?, phone=? WHERE email=?')
      .run('approved', isTeam, isRegular, full_name, phone, email);
  } else {
    db.prepare(`INSERT INTO applicants (full_name,email,phone,experience,waiver_ok,status,is_team,is_regular)
                VALUES (?,?,?,?,1,'approved',?,?)`)
      .run(full_name, email, phone, 'Pre-approved (invite)', isTeam, isRegular);
  }
  db.prepare("UPDATE invites SET used = 1, used_at = datetime('now'), used_email = ? WHERE token = ?")
    .run(email, iv.token);
  audit(iv.created_by, 'admin', `invite:claimed${iv.role ? ':' + iv.role : ''}`, `${full_name} <${email}>`);

  // The invite token itself is proof of pre-approval — sign them straight in.
  setSession(res, email);
  res.redirect('/checkin');
});

// Post an announcement — admin or team. Shows to all approved players on check-in.
// Posting a new one archives the current live one (kept in history, not lost).
app.post('/announce', requireApprover, (req, res) => {
  const body = (req.body.body || '').trim().slice(0, 500);
  if (body) {
    db.prepare("UPDATE announcements SET archived = 1, archived_at = datetime('now') WHERE archived = 0").run();
    db.prepare('INSERT INTO announcements (body,author) VALUES (?,?)').run(body, req.userEmail);
    audit(req.userEmail, req.actorRole, 'announce:post', body.slice(0, 60));
  }
  res.redirect(req.body.from === 'admin' ? '/admin' : '/checkin');
});

// Clear the current announcement — admin or team. Archives it (keeps history) rather than deleting.
app.post('/announce/clear', requireApprover, (req, res) => {
  const active = latestAnnouncement();
  if (active) {
    db.prepare("UPDATE announcements SET archived = 1, archived_at = datetime('now') WHERE id = ?").run(active.id);
    audit(req.userEmail, req.actorRole, 'announce:clear', '');
  }
  res.redirect(req.body.from === 'admin' ? '/admin' : '/checkin');
});

// Minimal status page for players who aren't approved (no check-in chrome).
app.get('/status', requireLogin, (req, res) => {
  const a = applicantByEmail(req.userEmail);
  const status = a?.status || 'none';
  if (isAdmin(req.userEmail) || status === 'approved') return res.redirect('/checkin');
  res.send(statusPage({ email: req.userEmail, status }));
});

// ---------- CHECK-IN ----------
function runIsOpen(runDate) {
  const row = db.prepare('SELECT is_open FROM run_state WHERE run_date = ?').get(runDate);
  return !!(row && row.is_open); // no row = never opened = closed
}
function setRunOpen(runDate, open) {
  db.prepare(`INSERT INTO run_state (run_date, is_open) VALUES (?, ?)
              ON CONFLICT(run_date) DO UPDATE SET is_open = excluded.is_open`)
    .run(runDate, open ? 1 : 0);
}

// Prepared once at startup (hot path), not per request.
const stmtRun = db.prepare(`
  SELECT c.*, COALESCE(a.status,'') AS pstatus,
         COALESCE(a.is_team,0) AS is_team, COALESCE(a.is_regular,0) AS is_regular
  FROM checkins c LEFT JOIN applicants a ON a.email = c.email
  WHERE c.run_date = ? ORDER BY c.sort_order ASC, c.id ASC`);

// Held late-regulars are released onto the floor from Friday 4pm onward.
function heldReleased(d = new Date()) {
  if (process.env.FORCE_HELD_RELEASED === '1') return true; // test hook only
  return d.getDay() === 5 && d.getHours() >= 16; // Friday ≥ 4pm
}

function loadRun() {
  const runDate = nextFriday();
  // Fresh slate: once the week rolls over (midnight Sat), drop the old week's
  // check-ins and opt-outs so the queue is genuinely reset.
  db.prepare('DELETE FROM checkins WHERE run_date < ?').run(runDate);
  db.prepare('DELETE FROM regular_optout WHERE run_date < ?').run(runDate);
  autoJoinTeam(runDate);
  const rows = stmtRun.all(runDate).map(r => ({
    ...r, tryout: r.pstatus === 'tryout', team: !!r.is_team, regular: !!r.is_regular,
    guest: /@guest\.local$/.test(r.email),
  }));
  const released = heldReleased();
  // Before Friday 4pm, held late-regulars are kept off the floor (waitlisted)
  // even if spots are open — those spots stay reserved for normals. After 4pm
  // they're treated like everyone else and can fill any remaining floor spots.
  const active = released ? rows : rows.filter(r => !r.held);
  const heldRows = released ? [] : rows.filter(r => r.held);
  const inPlayers = active.slice(0, CAP);
  const overflow = active.slice(CAP);
  const waitPlayers = [...overflow, ...heldRows].slice(0, WAITLIST_CAP);
  const totalCount = rows.length;
  return { runDate, inPlayers, waitPlayers, totalCount };
}

app.get('/checkin', requireLogin, (req, res) => {
  const email = req.userEmail;
  const a = applicantByEmail(email);
  const status = a?.status || 'none';
  const viewerIsAdmin0 = isAdmin(email);
  // Unapproved players can't see the check-in at all — bounced to a status page.
  if (!viewerIsAdmin0 && status !== 'approved') return res.redirect('/status');
  const { runDate, inPlayers, waitPlayers, totalCount } = loadRun();

  let myState = 'out';
  if (inPlayers.some(p => p.email === email)) myState = 'in';
  else if (waitPlayers.some(p => p.email === email)) myState = 'waitlist';
  const myWaitPos = myState === 'waitlist'
    ? waitPlayers.findIndex(p => p.email === email) + 1 : 0;

  const viewerIsAdmin = viewerIsAdmin0;
  const iAmTeam = !!(a && a.is_team);
  const iAmRegular = !!(a && a.is_regular);
  const iAutoRenew = !!(a && a.auto_renew);
  const canOperate = viewerIsAdmin || iAmTeam;
  const iOptedOut = !!db.prepare('SELECT 1 FROM regular_optout WHERE run_date = ? AND email = ?')
    .get(runDate, email);
  const isOpen = runIsOpen(runDate);
  const canSeeCount = isOpen || canOperate || iAmRegular;
  const canSeeRoster = canOperate || iAmRegular || isOpen;
  // pre-registration cap reached (team + regulars) — only relevant while closed
  const preregCount = db.prepare(`SELECT COUNT(*) r FROM checkins c
      JOIN applicants ap ON ap.email = c.email
      WHERE c.run_date = ? AND (ap.is_regular = 1 OR ap.is_team = 1)`).get(runDate).r;
  const regularSlotsFull = !isOpen && iAmRegular && !iAmTeam && preregCount >= PREREG_CAP && myState === 'out';

  res.send(checkinPage({
    email, status,
    runLabel: runLabelFor(runDate), runDate,
    cap: CAP, waitlistCap: WAITLIST_CAP,
    going: inPlayers.length,
    waiting: waitPlayers.length,
    full: inPlayers.length >= CAP,
    runFull: totalCount >= (CAP + WAITLIST_CAP),
    isOpen, canSeeCount,
    regularSlotsFull,
    myState, myWaitPos,
    iAmTeam, iAmRegular, iOptedOut, iAutoRenew,
    viewerIsAdmin, canOperate, canSeeRoster,
    announcement: latestAnnouncement(),
    announcementLog: canOperate ? announcementHistory() : [],
    // roster goes to anyone who can see it; controls only to operators
    inPlayers: canSeeRoster ? inPlayers : [],
    waitPlayers: canSeeRoster ? waitPlayers : [],
  }));
});

app.post('/checkin/join', requireLogin, (req, res) => {
  const email = req.userEmail;
  const a = applicantByEmail(email);
  if (!a || a.status !== 'approved') return res.redirect('/checkin');
  const runDate = nextFriday();
  // Pre-access: regulars and team can join while the run is still closed.
  const hasPreAccess = !!(a.is_regular || a.is_team);
  const runOpen = runIsOpen(runDate);
  if (!runOpen && !hasPreAccess) return res.redirect('/checkin');
  const already = db.prepare('SELECT 1 FROM checkins WHERE run_date=? AND email=?').get(runDate, email);
  // Pre-register cap: while CLOSED, team + regulars can hold at most PREREG_CAP
  // spots, so at least (floor − cap) survive for normals once you open.
  if (!runOpen && a.is_regular && !a.is_team && !already) {
    const { r } = db.prepare(`SELECT COUNT(*) r FROM checkins c
      JOIN applicants ap ON ap.email = c.email
      WHERE c.run_date = ? AND (ap.is_regular = 1 OR ap.is_team = 1)`).get(runDate);
    if (r >= PREREG_CAP) return res.redirect('/checkin'); // early spots full; opens to all later
  }
  // Hard cap: 15 floor + 5 waitlist. Past that, nobody new joins.
  if (!already) {
    const { n } = db.prepare('SELECT COUNT(*) n FROM checkins WHERE run_date=?').get(runDate);
    if (n >= TOTAL_CAP) return res.redirect('/checkin'); // run + waitlist full
  }
  try {
    // A regular who joins AFTER the run opens is "late" — held on the waitlist
    // until Friday 4pm so the open-phase floor spots stay reserved for normals.
    const isLateRegular = runOpen && a.is_regular && !a.is_team && !already;
    db.prepare('INSERT OR IGNORE INTO checkins (run_date,email,name,held) VALUES (?,?,?,?)')
      .run(runDate, email, a.full_name, isLateRegular ? 1 : 0);
  } catch (e) { console.error(e); }
  res.redirect('/checkin');
});

app.post('/checkin/leave', requireLogin, (req, res) => {
  const runDate = nextFriday();
  db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ?').run(runDate, req.userEmail);
  res.redirect('/checkin'); // waitlist auto-promotes because list is recomputed by position
});

// Team member toggles their persistent auto-renew (guaranteed weekly spot).
app.post('/checkin/autorenew', requireLogin, (req, res) => {
  const a = applicantByEmail(req.userEmail);
  if (a && a.is_team) {
    const on = req.body.on === '1';
    db.prepare('UPDATE applicants SET auto_renew = ? WHERE id = ?').run(on ? 1 : 0, a.id);
    if (!on) {
      // opting out of the held-seat system — drop the current auto-spot too
      db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ?').run(nextFriday(), req.userEmail);
    }
    audit(req.userEmail, 'team', 'auto-renew:' + (on ? 'on' : 'off'), req.userEmail);
  }
  res.redirect('/checkin');
});

// --- admin-only game controls ---
app.post('/checkin/guest', requireApprover, (req, res) => {
  const runDate = nextFriday();
  const name = (req.body.name || '').trim().slice(0, 60);
  if (name) {
    const { n } = db.prepare('SELECT COUNT(*) n FROM checkins WHERE run_date=?').get(runDate);
    if (n < TOTAL_CAP) {
      const email = `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@guest.local`;
      db.prepare('INSERT INTO checkins (run_date,email,name) VALUES (?,?,?)').run(runDate, email, name + ' (guest)');
      audit(req.userEmail, req.actorRole, 'checkin:guest-add', name);
    }
  }
  res.redirect('/checkin');
});
app.post('/checkin/remove', requireApprover, (req, res) => {
  const runDate = nextFriday();
  const target = String(req.body.email || '').toLowerCase();
  db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ?').run(runDate, target);
  audit(req.userEmail, req.actorRole, 'checkin:remove', target);
  res.redirect('/checkin');
});

app.post('/checkin/promote', requireApprover, (req, res) => {
  const runDate = nextFriday();
  const email = String(req.body.email || '').toLowerCase();
  // float this player above everyone currently checked in → they slot into the run,
  // bumping the last person in the run down to the top of the waitlist if it was full
  const { m } = db.prepare('SELECT MIN(sort_order) m FROM checkins WHERE run_date = ?').get(runDate);
  const newOrder = (m ?? 0) - 1;
  db.prepare('UPDATE checkins SET sort_order = ? WHERE run_date = ? AND email = ?')
    .run(newOrder, runDate, email);
  res.redirect('/checkin');
});

function autoJoinTeam(runDate) {
  // Team members are dropped onto the floor with TOP priority when the run
  // opens — if pre-access joiners already filled the cap, the newest of them
  // is bumped to waitlist rather than a team member. Team runs the run.
  const team = db.prepare(
    `SELECT email, full_name FROM applicants
     WHERE is_team = 1 AND status = 'approved' AND auto_renew = 1`).all();
  const optedOut = db.prepare('SELECT 1 FROM regular_optout WHERE run_date = ? AND email = ?');
  const insert = db.prepare('INSERT OR IGNORE INTO checkins (run_date,email,name,sort_order) VALUES (?,?,?,?)');
  let { m } = db.prepare('SELECT MIN(sort_order) m FROM checkins WHERE run_date = ?').get(runDate);
  let order = (m ?? 0);
  for (const t of team) {
    if (optedOut.get(runDate, t.email)) continue; // team member sat out this week
    order -= 1;
    insert.run(runDate, t.email, t.full_name, order);
  }
  // Enforce hard total cap: if team priority pushed anyone past floor+waitlist,
  // trim the lowest-ranked (they're non-team, since team floated to the top).
  const rows = db.prepare('SELECT id FROM checkins WHERE run_date=? ORDER BY sort_order ASC, id ASC').all(runDate);
  if (rows.length > TOTAL_CAP) {
    const cut = rows.slice(TOTAL_CAP).map(r => r.id);
    const del = db.prepare('DELETE FROM checkins WHERE id = ?');
    for (const id of cut) del.run(id);
  }
}

app.post('/checkin/open', requireApprover, (req, res) => {
  const runDate = nextFriday();
  setRunOpen(runDate, true);
  autoJoinTeam(runDate); // team is dropped onto the floor the moment you open
  audit(req.userEmail, req.actorRole, 'run:open', runDate);
  res.redirect('/checkin');
});
app.post('/checkin/close', requireApprover, (req, res) => {
  setRunOpen(nextFriday(), false);
  audit(req.userEmail, req.actorRole, 'run:close', nextFriday());
  res.redirect('/checkin');
});

// A regular clears (or restores) their own auto-seat for this week.
app.post('/checkin/optout', requireLogin, (req, res) => {
  const runDate = nextFriday();
  db.prepare('INSERT OR IGNORE INTO regular_optout (run_date,email) VALUES (?,?)')
    .run(runDate, req.userEmail);
  db.prepare('DELETE FROM checkins WHERE run_date = ? AND email = ?').run(runDate, req.userEmail);
  res.redirect('/checkin');
});
app.post('/checkin/optin', requireLogin, (req, res) => {
  const runDate = nextFriday();
  db.prepare('DELETE FROM regular_optout WHERE run_date = ? AND email = ?').run(runDate, req.userEmail);
  // if the run is already open, put them back on the floor now
  if (runIsOpen(runDate)) {
    const a = applicantByEmail(req.userEmail);
    if (a && a.status === 'approved') {
      db.prepare('INSERT OR IGNORE INTO checkins (run_date,email,name) VALUES (?,?,?)')
        .run(runDate, req.userEmail, a.full_name);
    }
  }
  res.redirect('/checkin');
});

// ---------- ADMIN / COUNCIL ----------
app.get('/admin', requireApprover, (req, res) => {
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
  const applicants = filtered.map(a => ({
    ...a,
    vote: a.is_team ? null : voteInfo(a.id, req.userEmail),
  }));
  const runDate = nextFriday();
  const checkedInCount = db.prepare('SELECT COUNT(*) n FROM checkins WHERE run_date = ?').get(runDate).n;
  const log = viewerIsAdmin
    ? db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 40').all() : [];
  res.send(adminPage({
    applicants, runLabel: runLabelFor(runDate), checkedInCount, cap: CAP,
    viewerIsAdmin, viewerIsTeam: req.actorRole === 'team', viewerEmail: req.userEmail, log,
    filter, counts,
  }));
});

// An approver casts (or changes) their vote. Unanimous approve → approved;
// any reject → rejected. Recomputed live.
app.post('/admin/vote', requireApprover, (req, res) => {
  const { id, vote } = req.body;
  // Only team members vote. Admins run the app but don't get a vote.
  if (req.actorRole !== 'team') return res.status(403).send('Only team members vote on applicants.');
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
  const a = db.prepare('SELECT email FROM applicants WHERE id = ?').get(id);
  if (a) {
    db.prepare('DELETE FROM votes WHERE applicant_id = ?').run(id);
    db.prepare("UPDATE applicants SET status = 'pending' WHERE id = ? AND is_team = 0").run(id);
    audit(req.userEmail, 'admin', 'reset', a.email);
  }
  res.redirect('/admin');
});

app.post('/admin/role', requireAdmin, (req, res) => {
  const { id, role, on } = req.body; // role: 'team' | 'regular'
  const turnOn = on === '1';
  const a = db.prepare('SELECT status, email FROM applicants WHERE id = ?').get(id);
  if (!a) return res.redirect('/admin');
  if (role === 'team') {
    // Making someone team AUTO-APPROVES them (they skip the vote).
    if (turnOn) {
      db.prepare("UPDATE applicants SET is_team = 1, status = 'approved' WHERE id = ?").run(id);
    } else {
      db.prepare('UPDATE applicants SET is_team = 0 WHERE id = ?').run(id);
    }
    audit(req.userEmail, 'admin', `role:team:${turnOn ? 'on' : 'off'}`, a.email);
  } else if (role === 'regular') {
    // Regular can only be flagged on someone already approved.
    if (a.status === 'approved') {
      db.prepare('UPDATE applicants SET is_regular = ? WHERE id = ?').run(turnOn ? 1 : 0, id);
      audit(req.userEmail, 'admin', `role:regular:${turnOn ? 'on' : 'off'}`, a.email);
    }
  }
  res.redirect('/admin');
});

// Share page — a big scannable QR + tap-able link for the application form,
// to show/hand out at the Monday rec runs. QR is generated live from PUBLIC_URL
// so it never points at a stale address.
app.get('/admin/share', requireAdmin, async (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const applyUrl = base + '/';
  const [applyQr, loginQr] = await Promise.all([
    QRCode.toString(applyUrl, { type: 'svg', margin: 1, color: { dark: '#183B38', light: '#ffffff' } }),
    QRCode.toString(base + '/login', { type: 'svg', margin: 1, color: { dark: '#183B38', light: '#ffffff' } }),
  ]);
  res.send(sharePage({ applyUrl, applyQr, signInUrl: base + '/login', loginQr }));
});

// ---------- PEOPLE MANAGEMENT (admin-only) ----------
app.get('/admin/people', requireAdmin, (req, res) => {
  const q = (req.query.q || '').trim();
  let people;
  if (q) {
    const like = `%${q}%`;
    people = db.prepare(
      `SELECT * FROM applicants WHERE full_name LIKE ? OR email LIKE ? OR phone LIKE ?
       ORDER BY full_name COLLATE NOCASE`).all(like, like, like);
  } else {
    people = db.prepare('SELECT * FROM applicants ORDER BY full_name COLLATE NOCASE').all();
  }
  const approvedPhones = db.prepare(
    "SELECT full_name, phone FROM applicants WHERE status='approved' ORDER BY full_name COLLATE NOCASE").all();
  const signInUrl = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`) + '/login';
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const invites = db.prepare('SELECT * FROM invites WHERE used = 0 ORDER BY created_at DESC').all()
    .map(iv => ({ ...iv, link: `${base}/invite/${iv.token}` }));
  const newInviteLink = req.query.invite ? `${base}/invite/${req.query.invite}` : '';
  res.send(peoplePage({ people, q, approvedPhones, signInUrl, invites, newInviteLink, msg: req.query.msg || '' }));
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
  const cur = db.prepare('SELECT email FROM applicants WHERE id = ?').get(id);
  if (!cur) return res.redirect('/admin/people');
  // if email changed, make sure it doesn't collide
  if (email !== cur.email) {
    const clash = db.prepare('SELECT 1 FROM applicants WHERE email = ? AND id != ?').get(email, id);
    if (clash) return res.redirect('/admin/people?msg=That+email+is+already+in+use');
  }
  db.prepare('UPDATE applicants SET full_name=?, email=?, phone=? WHERE id=?')
    .run(full_name, email, phone, id);
  // keep check-in name in sync if they're checked in
  db.prepare('UPDATE checkins SET name=?, email=? WHERE email=?').run(full_name, email, cur.email);
  audit(req.userEmail, 'admin', 'people:edit', email);
  res.redirect('/admin/people?msg=Saved');
});

app.post('/admin/people/delete', requireAdmin, (req, res) => {
  const { id } = req.body;
  const a = db.prepare('SELECT email, full_name FROM applicants WHERE id = ?').get(id);
  if (a) {
    db.prepare('DELETE FROM applicants WHERE id = ?').run(id);
    db.prepare('DELETE FROM checkins WHERE email = ?').run(a.email);
    db.prepare('DELETE FROM votes WHERE applicant_id = ?').run(id);
    audit(req.userEmail, 'admin', 'people:delete', a.email);
  }
  res.redirect('/admin/people?msg=Deleted');
});

app.listen(PORT, () => {
  console.log(`\nThe Bridge Adv Runs → http://localhost:${PORT}`);
  console.log(`Cap: ${CAP} · Email: ${emailConfigured ? 'SMTP configured' : 'DEV MODE (links print here)'}`);
  console.log(`Admin emails: ${process.env.ADMIN_EMAILS || '(none set — set ADMIN_EMAILS!)'}\n`);
  startBackups(); // snapshot the DB now + once a day
});
