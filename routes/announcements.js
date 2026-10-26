// routes/announcements.js — basketball's announcement post, cancel and clear (approvers), and the
// bell's seen/dismiss markers for every member.
import db from '../db.js';
import { sendAnnouncement } from '../mailer.js';
import { requireLogin } from '../auth.js';
import { audit } from '../lib/audit.js';
import { rateLimited } from '../lib/rate-limit.js';
import { sendPush } from '../lib/push.js';
import { approvedEmails } from '../engine/applicants.js';
import {
  announcementRecipients, parseScheduleAt, fmtScheduleAt, armScheduleTimer, latestAnnouncement,
  markAnnouncementsSeen,
} from '../engine/announcements.js';
import { requireApprover } from './guards.js';

const stmtAnnouncementExists = db.prepare('SELECT 1 FROM announcements WHERE id = ? AND program_id = 1');

export function mountAnnouncements(app) {
  // Post an announcement — admin or team. Shows to all approved players on check-in.
  // Posting a new one archives the current live one (kept in history, not lost).
  app.post('/announce', requireApprover, (req, res) => {
    const body = (req.body.body || '').trim().slice(0, 500);
    // Double-submit guard: a fast double-tap (the compose form isn't router-intercepted) would
    // otherwise insert two rows AND fire push + email twice (a real Gmail-quota hit). Skip a
    // repeat of the same body by the same author within 10s.
    const dup = body && db.prepare("SELECT 1 FROM announcements WHERE program_id = 1 AND body = ? AND author = ? AND at >= datetime('now','-10 seconds') LIMIT 1").get(body, req.userEmail);
    // F8: a future publish_at stores the post as PENDING — invisible everywhere, no push, no
    // archive-the-previous — until the tick fires it at that local time, exactly like posting live.
    const schedAt = parseScheduleAt(req.body.publish_at);
    if (body && !dup && schedAt) {
      db.prepare('INSERT INTO announcements (body, author, pending, publish_at, sched_email) VALUES (?,?,1,?,?)')
        .run(body, req.userEmail, schedAt, req.body.email_everyone ? 1 : 0);
      audit(req.userEmail, req.actorRole, 'announce:scheduled', `${schedAt} ${body.slice(0, 40)}`);
      armScheduleTimer();
      return res.redirect('/checkin?msg=' + encodeURIComponent(`Scheduled for ${fmtScheduleAt(schedAt)}.`));
    }
    if (body && !dup) {
      db.prepare("UPDATE announcements SET archived = 1, archived_at = datetime('now') WHERE archived = 0 AND program_id = 1").run();
      db.prepare('INSERT INTO announcements (body,author) VALUES (?,?)').run(body, req.userEmail);
      audit(req.userEmail, req.actorRole, 'announce:post', body.slice(0, 60));

      // Push to every subscribed player (the app-native channel — always on, independent
      // of the email checkbox and the email opt-out). Excludes the poster.
      const me = req.userEmail.toLowerCase();
      setImmediate(() => sendPush(approvedEmails().filter(e => e.toLowerCase() !== me),
        { title: 'The Bridge Runs', body: body.slice(0, 140), url: '/checkin', tag: 'announce' }));

      // Optionally email every approved player who hasn't opted out of broadcast email.
      // Fired in the background so the redirect stays instant; failures are loud.
      if (req.body.email_everyone) {
        const author = req.userEmail;
        setImmediate(() => {
          try {
            const recipients = announcementRecipients();
            sendAnnouncement(recipients, body, author).catch(err =>
              console.error(`[announce] email send FAILED: ${err.message}`));
          } catch (err) {
            console.error(`[announce] email prep FAILED: ${err.message}`);
          }
        });
      }
    }
    res.redirect(req.body.from === 'admin' ? '/admin' : '/checkin');
  });

  // Cancel a SCHEDULED announcement before it fires (P2-4: the F8 state machine's missing exit —
  // without this the only way to stop a mis-scheduled post was DB surgery). Pending-only delete:
  // a fired/live post can never be deleted through here, only cleared via /announce/clear.
  app.post('/announce/cancel', requireApprover, (req, res) => {
    const id = Number(req.body.id);
    if (Number.isInteger(id) && id > 0) {
      const r = db.prepare('DELETE FROM announcements WHERE id = ? AND pending = 1 AND program_id = 1').run(id);
      if (r.changes) audit(req.userEmail, req.actorRole, 'announce:cancel-scheduled', String(id));
      armScheduleTimer();
    }
    res.redirect('/profile');
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

  // Mark the viewer's announcements as read — fired when the masthead bell panel opens
  // (fetch, keep-alive). Any signed-in user can clear their own dot; lightly rate-limited
  // (the panel-open is the only caller) to shrug off a rapid open/close loop. 204 = done.
  app.post('/announcements/seen', requireLogin, (req, res) => {
    if (rateLimited('ann-seen', req.userEmail, 30, 60 * 1000)) return res.status(429).end();
    markAnnouncementsSeen(req.userEmail);
    res.status(204).end();
  });

  // Dismiss (swipe-to-clear) an announcement from the CALLER'S OWN panel — ANY signed-in
  // viewer, NOT admin-gated. This is a PERSONAL hide: it records a per-user dismissal and
  // never touches the `announcements` row, so the announcement stays live for everyone
  // else. Idempotent (INSERT OR IGNORE); rate-limited to shrug off a rapid swipe loop. A
  // fetch caller (X-Requested-With: fetch) gets 204; a no-JS form POST gets a 302 back.
  app.post('/announcements/:id/dismiss', requireLogin, (req, res) => {
    if (rateLimited('ann-dismiss', req.userEmail, 60, 60 * 1000)) return res.status(429).end();
    const id = Number(req.params.id) || 0;
    // Only dismiss an announcement that EXISTS — the id is caller-supplied, and without this
    // the table takes an unbounded stream of junk ids (nothing prunes dismissals for
    // announcements that never existed).
    if (id && stmtAnnouncementExists.get(id)) {
      db.prepare('INSERT OR IGNORE INTO announcement_dismissals (email, announcement_id) VALUES (?, ?)')
        .run(req.userEmail.toLowerCase(), id);
    }
    const wantsJson = (req.headers['x-requested-with'] || '') === 'fetch';
    if (wantsJson) return res.status(204).end();
    // Bounce back to wherever they were, but only ever to a SAME-ORIGIN path — strip the
    // host/scheme off the Referer so a spoofed header can't funnel an off-site URL into the
    // redirect shim (the shim escapes it anyway, but keep this consistent with safeNextPath).
    let back = '/checkin';
    try { const u = new URL(req.get('referer')); back = (u.pathname || '/') + (u.search || ''); } catch {}
    res.redirect(back);
  });
}
