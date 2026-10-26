// routes/poll.js — GET /poll: the read-only change fingerprint every live page polls (about every
// 10 s) to decide whether to re-fetch and patch a region. It never writes.
import db from '../db.js';
import { isAdmin, requireLogin } from '../auth.js';
import { BUILD_VER } from '../views/index.js';
import { getSetting } from '../lib/settings.js';
import { applicantIdOf } from '../engine/applicants.js';
import {
  P, programRunDate, runOpenFor, runCancelledFor, PROGRAMS, pkRunDate, pkIsOpen, pkIsCancelled,
} from '../engine/programs.js';
import { nextRunDate, runIsOpen, runIsCancelled } from '../engine/basketball-calendar.js';
import {
  latestAnnouncementFor, latestAnnouncement, announcementUnread, latestPkAnnouncement,
} from '../engine/announcements.js';
import { heldReleased, partitionFor, partitionRun, pkPartition } from '../engine/seating.js';
import {
  stmtPollChat, stmtPollChatReact, stmtPollPkChat, stmtPollPkChatReact, chatPollFingerprint,
} from '../engine/chat.js';
import { unreadCount } from '../engine/messages.js';
import { ensureWeekFor } from '../engine/run-engine.js';
import { ensureWeek } from '../engine/basketball.js';

function runPollFingerprint(programId) {
  const cfg = P(programId).config, rd = programRunDate(programId);
  ensureWeekFor(programId); // no-op until the date advances; never writes offers
  const part = partitionFor(programId, rd), rows = part.rows || [];
  // Offer-window runs carry offered/held flags + the held-release boundary; simple runs don't.
  const order = cfg.offerWindow
    ? rows.map(r => `${r.id}${r.offered_at != null ? 'o' : ''}${r.held ? 'h' : ''}${r.confirmed_at ? 'c' : ''}`).join(',')
    : rows.map(r => `${r.id}${r.confirmed_at ? 'c' : ''}`).join(',');
  const held = cfg.offerWindow ? `${heldReleased(rd) ? 1 : 0}:` : '';
  const ann = latestAnnouncementFor(programId);
  return `${rd}:${runOpenFor(programId, rd) ? 1 : 0}:${runCancelledFor(programId, rd) ? 1 : 0}:${held}${order}:${ann ? ann.id : 0}`;
}
const stmtPollDM = db.prepare('SELECT MAX(id) mx, COUNT(*) c FROM messages WHERE from_email = ? OR to_email = ?');

export function mountPoll(app) {
  // ---------- POLL (read-only fingerprint for the surgical poll-and-patch clients) ----------
  // A tiny JSON heartbeat the check-in / chat / profile pages hit every 10s to decide
  // whether to re-fetch-and-patch a region, instead of a full-page reload. It does
  // ZERO writes: never marks-read, never expires offers, and calls only the no-op
  // ensureWeek() (which writes only when the run date advances). Mark-read stays on the
  // real page GETs; offer-expiry stays on loadRun + the 60s interval.
  app.get('/poll', requireLogin, (req, res) => {
    const email = req.userEmail;
    const page = req.query.page;
    let f = '';
    if (page === 'checkin') {
      const runDate = nextRunDate();
      ensureWeek(runDate); // no-op until the run date advances; deliberately NO expireAndReoffer (that writes)
      const part = partitionRun(runDate);
      // Canonical sort order + per-row offered(o)/held(h) flags → catches join, leave,
      // promote/reorder at equal counts, offer-sent, and hold-state changes. Plus the
      // held-release boundary, the live announcement id, and the cancelled flag — cancelling
      // a CLOSED, empty run changes nothing else in here (is_open stays 0, the roster delete
      // is a no-op), so without `cancelled` open clients never swap in the "Run cancelled"
      // banner. Pickleball's fingerprint already carries it.
      const order = part.rows.map(r => `${r.id}${r.offered_at != null ? 'o' : ''}${r.held ? 'h' : ''}${r.confirmed_at ? 'c' : ''}`).join(',');
      const ann = latestAnnouncement();
      f = `${runDate}:${runIsOpen(runDate) ? 1 : 0}:${runIsCancelled(runDate) ? 1 : 0}:${heldReleased(runDate) ? 1 : 0}:${order}:${ann ? ann.id : 0}`;
    } else if (page === 'chat') {
      const g = stmtPollChat.get(), rx = stmtPollChatReact.get();
      f = `${g.mx || 0}:${getSetting('chat_seq') || 0}:${rx.c || 0}:${rx.mx || ''}`;
    } else if (page === 'pkchat') {
      const g = stmtPollPkChat.get(), rx = stmtPollPkChatReact.get();
      f = `${g.mx || 0}:${getSetting('pk_chat_seq') || 0}:${rx.c || 0}:${rx.mx || ''}`;
    } else if (page === 'pickleball') {
      const rd = pkRunDate(), part = pkPartition(rd);
      const order = part.rows.map(r => `${r.id}${r.confirmed_at ? 'c' : ''}`).join(',');
      const a = latestPkAnnouncement();
      f = `${rd}:${pkIsOpen(rd) ? 1 : 0}:${pkIsCancelled(rd) ? 1 : 0}:${order}:${a ? a.id : 0}`;
    } else if (page === 'profile') {
      const m = stmtPollDM.get(email, email);
      f = `${m.mx || 0}:${m.c || 0}`;
    } else {
      // Every OTHER run (e.g. volleyball) — keyed by its own slug (prog.key, the run page's pollKey)
      // or logTag+"chat" (the chat page's pollPage). Basketball(1)/pickleball(2) are handled by the
      // literal branches above. A hidden run's fingerprint is withheld from non-admins (matches its
      // page gate) so it isn't leaked before publish.
      for (const p of PROGRAMS.values()) {
        if (p.id < 3 || !(p.active() || isAdmin(email))) continue;
        if (page === p.key) { f = runPollFingerprint(p.id); break; }
        if (page === `${p.config.logTag}chat`) { f = chatPollFingerprint(p.id); break; }
      }
    }
    const aid = applicantIdOf(email);
    // Program-keyed chat unread map: the client reads data-chat-program off the Chat tab / hero
    // and looks up its counts here, so the badges work for any number of runs. Only LIVE programs
    // contribute (a hidden run shows no badge — matches the old pkOn gate). The old scalar fields
    // (group/gm/pkgroup/pkgm) are DUAL-EMITTED for one release so a stale cached client keeps
    // working until its next 10s poll force-reloads it on the BUILD_VER bump.
    const chats = {};
    for (const p of PROGRAMS.values()) { if (!p.active()) continue; const u = p.unread(email, aid); chats[p.id] = { u: u.group, m: u.gm }; }
    const c1 = chats[1] || { u: 0, m: 0 }, c2 = chats[2] || { u: 0, m: 0 };
    res.json({ f, dm: unreadCount(email), chats,
      group: c1.u, gm: c1.m, pkgroup: c2.u, pkgm: c2.m,          // legacy — dual-emit for stale clients (drop next release)
      ann: announcementUnread(email) ? 1 : 0, v: BUILD_VER });
  });
}
