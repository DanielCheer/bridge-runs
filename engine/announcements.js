// engine/announcements.js — announcements: the latest post per program, the masthead bell panel
// with unread tracking, broadcast audiences, and scheduled posts (the precise-fire timer plus the
// catch-up the 60-second tick runs).
import db from '../db.js';
import { TEST_NOW } from '../config.js';
import { sendAnnouncement, emailConfigured } from '../mailer.js';
import { audit } from '../lib/audit.js';
import { sendPush } from '../lib/push.js';
import { schedNow } from '../lib/dates.js';
import { approvedEmails } from './applicants.js';
import { P, programMemberEmails, programEmailRecipients } from './programs.js';

// Hot path (rendered on every check-in + polled in the check-in fingerprint), so
// the statement is prepared once at module scope rather than per call.
const stmtLatestAnnouncement = db.prepare(`SELECT a.*, COALESCE(ap.full_name, a.author) AS authorName
  FROM announcements a LEFT JOIN applicants ap ON ap.email = a.author
  WHERE a.archived = 0 AND COALESCE(a.pending,0) = 0 AND a.program_id = 1 ORDER BY a.id DESC LIMIT 1`); // authorName resolves the poster's email → name
function latestAnnouncement() {
  // the live one players see — archived posts are history only
  return stmtLatestAnnouncement.get() || null;
}
function announcementHistory(limit = 40) {
  // newest first; includes the live one plus everything archived
  return db.prepare('SELECT * FROM announcements WHERE program_id = 1 ORDER BY id DESC LIMIT ?').all(limit);
}
function announcementRecipients() {
  return db.prepare("SELECT email FROM applicants WHERE status = 'approved' AND email NOT LIKE '%@guest.local' AND COALESCE(email_optout,0) = 0")
    .all().map(r => r.email);
}
// Plain approved players with NO early access — the ones the "check-in is open" auto-
// notice is for. Core (is_regular), Team, and Host already have early access, so they're
// EXCLUDED from the queue-open ping. Push variant ignores email opt-out; email variant honors it.
function queueOpenPushEmails() {
  return db.prepare("SELECT email FROM applicants WHERE status = 'approved' AND email NOT LIKE '%@guest.local' AND is_regular = 0 AND is_team = 0 AND is_host = 0")
    .all().map(r => r.email);
}
function queueOpenEmailRecipients() {
  return db.prepare("SELECT email FROM applicants WHERE status = 'approved' AND email NOT LIKE '%@guest.local' AND is_regular = 0 AND is_team = 0 AND is_host = 0 AND COALESCE(email_optout,0) = 0")
    .all().map(r => r.email);
}

// ---- Masthead notification bell: announcements panel + unread tracking ----
// The bell lists recent announcements (live + archived history) newest-first and
// shows an orange dot when the viewer has an unseen one. Unread is tracked per
// viewer in announcement_reads (last_seen_id high-water mark). All render text is
// esc()'d in views; author email is mapped to the poster's full_name for display.
// The viewer's panel list: recent announcements newest-first, EXCLUDING any this viewer
// has personally dismissed (swipe-to-clear). The dismiss is per-user — the row stays in
// `announcements` and in everyone else's panel; only this viewer's copy is hidden.
const stmtAnnPanel = db.prepare(`
    SELECT a.id, a.body, a.author, a.at,
           COALESCE(ap.full_name, a.author) AS authorName
    FROM announcements a
    LEFT JOIN applicants ap ON ap.email = a.author
    WHERE a.program_id = 1 AND COALESCE(a.pending,0) = 0 AND a.id NOT IN (SELECT announcement_id FROM announcement_dismissals WHERE email = ?)
    ORDER BY a.id DESC LIMIT ?`); // hoisted — runs on every authed page render (node:sqlite has no stmt cache)
function announcementsForPanel(email, limit = 20) {
  return stmtAnnPanel.all(String(email || '').toLowerCase(), limit);
}
const stmtAnnLastSeen = db.prepare('SELECT last_seen_id FROM announcement_reads WHERE email = ?');
// Count of announcements newer than the viewer's last-seen id that they have NOT
// dismissed — dismissed ids never light the dot, so clearing the last unread one clears
// the bell. (A viewer who never opened the panel has last_seen_id 0 → any non-dismissed
// announcement counts.)
const stmtAnnUnreadCount = db.prepare(`
  SELECT COUNT(*) n FROM announcements a
  WHERE a.program_id = 1 AND COALESCE(a.pending,0) = 0 AND a.id > ?
    AND a.id NOT IN (SELECT announcement_id FROM announcement_dismissals WHERE email = ?)`);
function announcementUnread(email) {
  if (!email) return false;
  const em = email.toLowerCase();
  const row = stmtAnnLastSeen.get(em);
  const lastSeen = row ? (row.last_seen_id || 0) : 0;
  return stmtAnnUnreadCount.get(lastSeen, em).n > 0;
}
// Upsert the viewer's last-seen id to the current MAX — clears their unread dot.
const stmtMarkAnnSeen = db.prepare(`
  INSERT INTO announcement_reads (email, last_seen_id, updated_at)
  VALUES (?, (SELECT COALESCE(MAX(id),0) FROM announcements WHERE program_id = 1 AND COALESCE(pending,0) = 0), datetime('now'))
  ON CONFLICT(email) DO UPDATE SET
    last_seen_id = (SELECT COALESCE(MAX(id),0) FROM announcements WHERE program_id = 1 AND COALESCE(pending,0) = 0),
    updated_at = datetime('now')`);
function markAnnouncementsSeen(email) {
  if (email) stmtMarkAnnSeen.run(email.toLowerCase());
}
// The masthead bell's render state for a viewer: their (non-dismissed) list + unread
// flag. Every viewer can swipe-to-clear their own rows, so no role gating here.
function annPanel(email) {
  return { items: announcementsForPanel(email, 20), unread: announcementUnread(email) };
}

// ---------- SCHEDULED ANNOUNCEMENTS (F8) ----------
// 'YYYY-MM-DDTHH:MM' from a datetime-local input, kept in LOCAL time (all scheduling in this app
// is local — cutoffs, pings, waiver dates). Returns the normalized string only if it parses and is
// in the future; anything else means "post now".
function parseScheduleAt(v) {
  // A duplicated form field arrives as an ARRAY under express.urlencoded — String() would mangle
  // it, fail the regex, and silently convert "scheduled" into "post now" (the P1 that shipped F8
  // broken). Take the first non-empty value so a stray duplicate can never flip the meaning.
  if (Array.isArray(v)) v = v.find((x) => String(x || '').trim()) || '';
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return null;
  const t = new Date(s + ':00').getTime();
  return Number.isFinite(t) && t > schedNow() ? s : null;
}
// "Thu, Oct 29, 6:30 PM" for parseScheduleAt's LOCAL "YYYY-MM-DDTHH:MM". Same shape as views/util.js's
// fmtWhen, which can't be reused here: it reads its input as a UTC SQLite timestamp, and this value
// is already local, so it would be shifted by the UTC offset.
function fmtScheduleAt(s) {
  return new Date(s + ':00').toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const localNowMinute = () => {
  const d = new Date(schedNow());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
// Fire due posts (60s tick). AT the moment it fires it becomes an ordinary live announcement:
// archive the program's previous live post, flip pending off, push — and email if that was ticked
// when it was scheduled.
// Precise firing (owner request 2026-08-04: "send the instant of the scheduled time"): a single
// armed timeout targets the NEXT due publish_at exactly, so a 7:00 post fires AT 7:00, not at
// the first 60s tick after it. The tick still calls fireScheduledAnnouncements as the safety net
// (a lost timer — crash, clock jump — costs at most the old minute of lag, never the post).
// Re-armed on boot, on schedule, on cancel, and after every fire. Under TEST_NOW the timer never
// arms AT ALL: it computes its delay from the real clock while the due check reads the test clock,
// so a pinned-past TEST_NOW would arm 0ms → fire → nothing due → re-arm 0ms, a hot spin. The
// harness fires through /admin/test/tick instead — which is the documented design.
let schedFireTimer = null;
function armScheduleTimer() {
  if (TEST_NOW != null) return;
  if (schedFireTimer) { clearTimeout(schedFireTimer); schedFireTimer = null; }
  const next = db.prepare('SELECT MIN(publish_at) m FROM announcements WHERE pending = 1').get().m;
  if (!next) return;
  const ms = new Date(next + ':00').getTime() - Date.now();   // publish_at is minute-granular local
  schedFireTimer = setTimeout(() => {
    schedFireTimer = null;
    try { fireScheduledAnnouncements(); } catch (e) { console.error(`[announce] timed fire failed: ${e.message}`); armScheduleTimer(); }
  }, Math.max(0, Math.min(ms + 250, 2147000000)));   // +250ms lands just past the minute boundary; clamp ≈24d re-arms itself
  schedFireTimer.unref();   // the 60s tick (also unref'd) is the delivery guarantee; never pin the event loop
}
function fireScheduledAnnouncements() {
  const due = db.prepare(
    "SELECT id, program_id, body, author, sched_email FROM announcements WHERE pending = 1 AND publish_at <= ? ORDER BY publish_at, id").all(localNowMinute());
  // ORDER BY publish_at (not id): on a catch-up batch (downtime, same-minute posts) the
  // LAST-firing post stays live — that must be the latest-scheduled one, not the highest id.
  for (const a of due) {
    // Fire = INSERT a FRESH row + drop the pending one: the unread-bell dot is `id > last_seen_id`
    // and the panel orders by id DESC, so flipping pending=0 in place kept the OLD id — no dot,
    // wrong order, for anyone who'd seen a later post meanwhile. Archive+insert+delete commit as
    // ONE transaction: a mid-fire throw (transient SQLITE_BUSY) must not leave the fresh row live
    // with the pending row intact, or the next tick fires it AGAIN (duplicate rows + push).
    try {
      db.exec('BEGIN');
      db.prepare("UPDATE announcements SET archived = 1, archived_at = datetime('now') WHERE archived = 0 AND COALESCE(pending,0) = 0 AND program_id = ?").run(a.program_id);
      db.prepare('INSERT INTO announcements (body, author, program_id) VALUES (?,?,?)').run(a.body, a.author, a.program_id);
      db.prepare('DELETE FROM announcements WHERE id = ?').run(a.id);
      audit('system', 'system', 'announce:fired', `${a.program_id}:${a.body.slice(0, 40)}`);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} console.error(`[announce] fire failed for #${a.id}: ${e.message}`); continue; }
    const isBball = a.program_id === 1;
    const url = isBball ? '/checkin' : P(a.program_id)?.paths.run;
    if (!url) continue;   // program deleted since scheduling — row fired into history, nobody pushed
    const title = isBball ? 'The Bridge Runs' : P(a.program_id).config.copy.annTitle;
    const targets = isBball ? approvedEmails() : programMemberEmails(a.program_id);
    setImmediate(() => sendPush(targets.filter(e => e.toLowerCase() !== String(a.author).toLowerCase()),
      { title, body: a.body.slice(0, 140), url, tag: isBball ? 'announce' : `${P(a.program_id).config.logTag}ann` }));
    if (a.sched_email && emailConfigured) {
      const recipients = isBball ? announcementRecipients() : programEmailRecipients(a.program_id);
      setImmediate(() => { try { if (recipients.length) sendAnnouncement(recipients, a.body, a.author).catch(e => console.error(`[sched-announce] email FAILED: ${e.message}`)); } catch (e) { console.error(`[sched-announce] ${e.message}`); } });
    }
  }
  armScheduleTimer();   // next pending post gets its own precise timer
}
const stmtLatestAnnouncementById = db.prepare('SELECT id, body, author, at AS created_at FROM announcements WHERE program_id = ? AND COALESCE(archived,0) = 0 AND COALESCE(pending,0) = 0 ORDER BY id DESC LIMIT 1');
// Latest LIVE pickleball announcement (program 2 rows in the shared announcements table; retracted ones archived).
function latestAnnouncementFor(programId) { return stmtLatestAnnouncementById.get(programId) || null; }
function latestPkAnnouncement() { return latestAnnouncementFor(2); }

export {
  announcementRecipients, parseScheduleAt, fmtScheduleAt, armScheduleTimer, latestAnnouncement,
  markAnnouncementsSeen, latestAnnouncementFor, annPanel, announcementUnread, latestPkAnnouncement,
  announcementHistory, queueOpenPushEmails, queueOpenEmailRecipients, fireScheduledAnnouncements,
};
