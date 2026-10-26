// engine/chat.js — program chat rooms: loading messages (with reactions, replies and pins),
// membership, unread and @-mention counts, read markers, mention and opt-in pushes, the chat gate,
// and the change fingerprints /poll reads.
import db from '../db.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { sendPush } from '../lib/push.js';
import { isMinor, applicantByEmail, approvedEmails } from './applicants.js';
import { P, programMemberEmails, memberOf, programGate, PROGRAMS, programJoinedBy } from './programs.js';

// --- Unified Run Chat engine (Phase 3b) ------------------------------------------------------
// ONE program-parameterized engine serves every program's room: each hoisted statement binds
// program_id at call time, so a single prepared statement covers all programs. The public
// groupUnread / pkGroupUnread / loadGroupChat / loadPkGroupChat / markGroupRead / notifyMentions
// (…and pk twins) are THIN WRAPPERS below that pass the program id — so no call site changed.
// Reads P(programId) for the member roster source (apply=all-approved, opt-in=members) + mention
// push routing (paths.chat + config.mentionTag). P() is referenced at call time (safe here).
//
// Run Chat unread: group_messages newer than this viewer's read high-water mark (or ALL if they've
// never opened the room), excluding their own posts. One COUNT per page load, served by the PK.
const stmtChatUnread = db.prepare(`
  SELECT COUNT(*) n FROM group_messages
  WHERE program_id = ? AND id > COALESCE((SELECT last_read_id FROM group_reads WHERE email = ? AND program_id = ?), 0)
    AND from_email != ?`);
function chatUnreadFor(programId, email) { return email ? stmtChatUnread.get(programId, email, programId, email).n : 0; }
function groupUnread(email) { return chatUnreadFor(1, email); }

// Badge split: the Messages tab shows DM unread (unreadCount), the Roster tab
// shows group (Run Chat) unread (groupUnread). Every tab-bearing route feeds both
// into tabNav({ dm, group }).

// Load the Run Chat feed for rendering under the roster: last ~200 messages ASC in
// bulk + reactions map + reply-parent map + sender map (no N+1) + member count.
// Mirrors what the old /chat GET assembled; the caller marks-read separately.
// Bulk-hydrate a chronological (id ASC) slice of group messages: reactions,
// reply-parents, sender identities, and @-mention names — all no-N+1. Shared by
// loadGroupChat (latest page) and loadGroupChatOlder (a scroll-back page).
function hydrateGroupMessages(programId, me, msgs) {
  const reactions = new Map();  // message_id -> [{emoji,count,mine}]
  const parents = new Map();    // parent id -> {from_email, body}
  const senders = new Map();    // email -> {id, full_name, is_host}
  if (msgs.length) {
    const ids = msgs.map(m => m.id);
    const ph = ids.map(() => '?').join(',');
    for (const r of db.prepare(`
      SELECT group_message_id AS mid, emoji, COUNT(*) AS cnt,
             SUM(CASE WHEN from_email = ? THEN 1 ELSE 0 END) AS mine
      FROM group_reactions WHERE group_message_id IN (${ph})
      GROUP BY group_message_id, emoji ORDER BY group_message_id, emoji`).all(me, ...ids)) {
      if (!reactions.has(r.mid)) reactions.set(r.mid, []);
      reactions.get(r.mid).push({ emoji: r.emoji, count: r.cnt, mine: r.mine > 0 });
    }
    const replyIds = [...new Set(msgs.map(m => m.reply_to).filter(Boolean))];
    if (replyIds.length) {
      const ph2 = replyIds.map(() => '?').join(',');
      for (const pr of db.prepare(`SELECT id, from_email, body, image, audio, video FROM group_messages WHERE id IN (${ph2}) AND program_id = ?`).all(...replyIds, programId))
        parents.set(pr.id, pr);
    }
    const emails = [...new Set([...msgs.map(m => m.from_email), ...[...parents.values()].map(p => p.from_email)])];
    const ph3 = emails.map(() => '?').join(',');
    for (const s of db.prepare(`SELECT id, full_name, email, is_host FROM applicants WHERE email IN (${ph3})`).all(...emails))
      senders.set(s.email, s);
    // Fallback for a sender with no applicant row (the demo run's synthetic @demo.local players):
    // resolve the display name from this program's check-in roster so chat shows a name, not an email.
    // No-op for real programs — every real chatter has an applicant row — so it's byte-identical there.
    const unresolved = emails.filter(e => !senders.has(e));
    if (unresolved.length) {
      const phc = unresolved.map(() => '?').join(',');
      for (const c of db.prepare(`SELECT DISTINCT email, name FROM checkins WHERE program_id = ? AND email IN (${phc})`).all(programId, ...unresolved))
        if (!senders.has(c.email)) senders.set(c.email, { id: 0, full_name: c.name, is_host: 0 });
    }
  }
  // Mention-name map: id -> full_name for every applicant @-tagged across the loaded
  // messages. Drives esc-safe linkify in chatFragment (match the escaped name in the
  // escaped body, wrap in <a class="mention">). One bulk query, no N+1.
  const mentionNames = new Map();
  const mentionIds = [...new Set(msgs.flatMap(m =>
    (m.mentions ? String(m.mentions).split(',') : []).map(Number).filter(Boolean)))];
  if (mentionIds.length) {
    const phm = mentionIds.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT id, full_name FROM applicants WHERE id IN (${phm})`).all(...mentionIds))
      mentionNames.set(r.id, r.full_name);
  }
  return { reactions, parents, senders, mentionNames };
}

// Hoisted — the chat re-render path (loadGroupChat) runs on every /chat page fetch, which every
// open client re-fetches on each fingerprint change (each message × each viewer on a busy night).
const stmtChatHasOlder = db.prepare('SELECT 1 FROM group_messages WHERE id < ? AND program_id = ? LIMIT 1');
const stmtChatMsgs = db.prepare('SELECT * FROM ( SELECT * FROM group_messages WHERE program_id = ? ORDER BY id DESC LIMIT 200 ) ORDER BY id ASC');
const stmtChatOlder = db.prepare('SELECT * FROM ( SELECT * FROM group_messages WHERE id < ? AND program_id = ? ORDER BY id DESC LIMIT 200 ) ORDER BY id ASC');
// Member roster: an APPLY program (basketball) lists every approved player; an OPT-IN program
// (pickleball) lists only those who joined it (program_membership). Same columns + sort either way.
const stmtChatMembersAll = db.prepare(`SELECT id, full_name, email, is_host, is_team, is_regular, avatar, dob
    FROM applicants WHERE status = 'approved' AND email NOT LIKE '%@guest.local'
    ORDER BY is_host DESC, is_team DESC, is_regular DESC, full_name COLLATE NOCASE`);
const stmtChatMembersJoined = db.prepare(`SELECT a.id, a.full_name, a.email, a.is_host, a.is_team, a.is_regular, a.avatar, a.dob
    FROM program_membership pm JOIN applicants a ON a.email = pm.email
    WHERE pm.program_id = ? AND a.status = 'approved' AND a.email NOT LIKE '%@guest.local'
    ORDER BY a.is_host DESC, a.is_team DESC, a.is_regular DESC, a.full_name COLLATE NOCASE`);
const stmtChatPinned = db.prepare('SELECT * FROM group_messages WHERE pinned_at IS NOT NULL AND program_id = ? ORDER BY pinned_at DESC LIMIT 5');
function chatMembersFor(programId) {
  const p = P(programId);
  const rows = (p && p.config.access === 'opt-in') ? stmtChatMembersJoined.all(programId) : stmtChatMembersAll.all();
  return rows.map(r => ({ ...r, minor: isMinor(r) }));   // red asterisk in the member sheet (awareness)
}
// True if at least one group message exists older than `id` in this program's room (drives the
// "Load earlier messages" button — shown only when there is more history).
function hasOlderChat(programId, id) { return id ? !!stmtChatHasOlder.get(id, programId) : false; }

function loadChat(programId, me) {
  const msgs = stmtChatMsgs.all(programId);
  const maps = hydrateGroupMessages(programId, me, msgs);
  // Member list = the SAME population the "N members" count uses (see chatMembersFor).
  // memberCount is derived from this list's length so the header count and the members
  // overlay can never disagree. Sorted host → team → core → regular, then name.
  const members = chatMembersFor(programId);
  // Pinned messages — newest pin first, capped. Hydrate their senders too (a pinned
  // message may be older than the loaded 200, so it needs its own sender lookup).
  const pinned = stmtChatPinned.all(programId);
  const pinnedNames = new Map();
  if (pinned.length) {
    const pe = [...new Set(pinned.map(p => p.from_email))];
    const ph = pe.map(() => '?').join(',');
    for (const s of db.prepare(`SELECT email, full_name FROM applicants WHERE email IN (${ph})`).all(...pe)) pinnedNames.set(s.email, s.full_name);
  }
  return { msgs, ...maps, members, memberCount: members.length, pinned, pinnedNames,
           hasOlder: msgs.length ? hasOlderChat(programId, msgs[0].id) : false };
}

// One page of scroll-back: the ≤200 messages immediately older than `beforeId`, chronological
// (id ASC), hydrated the same way. hasOlder reports whether yet more history remains above.
function loadChatOlder(programId, me, beforeId) {
  const msgs = stmtChatOlder.all(beforeId, programId);
  const maps = hydrateGroupMessages(programId, me, msgs);
  return { msgs, ...maps, hasOlder: msgs.length ? hasOlderChat(programId, msgs[0].id) : false };
}
function loadGroupChat(me) { return loadChat(1, me); }
function loadGroupChatOlder(me, beforeId) { return loadChatOlder(1, me, beforeId); }

// Validate a raw comma-separated mention-id string against the applicants table.
// Returns a canonical comma-separated string of the REAL ids (deduped, capped), or
// null when none are valid. Guards against a client posting bogus/foreign ids.
function validMentions(raw) {
  const ids = [...new Set(String(raw || '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0))].slice(0, 30);
  if (!ids.length) return null;
  const ph = ids.map(() => '?').join(',');
  const real = new Set(db.prepare(`SELECT id FROM applicants WHERE id IN (${ph})`).all(...ids).map(r => r.id));
  const valid = ids.filter(id => real.has(id));
  return valid.length ? valid.join(',') : null;
}
// Push a "you were mentioned" notification to each @-mentioned player (never the sender). No-op
// with no mentions / no subscriptions. Fired in the background. Routes to the mentioned program's
// chat (P(programId).paths.chat) with its own push-dedup tag (config.mentionTag).
function notifyChatMentions(programId, fromEmail, body, mentions) {
  if (!mentions) return;
  const ids = String(mentions).split(',').map(Number).filter(Boolean);
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT email FROM applicants WHERE id IN (${ph}) AND email NOT LIKE '%@guest.local'`).all(...ids);
  const from = String(fromEmail).toLowerCase();
  const emails = rows.map(r => r.email).filter(e => e.toLowerCase() !== from);
  if (!emails.length) return;
  const sender = applicantByEmail(fromEmail);
  const name = sender ? sender.full_name : 'Someone';
  const p = P(programId);
  setImmediate(() => sendPush(emails, { title: `${name} mentioned you`, body: (body || '').slice(0, 140), url: p.paths.chat, tag: p.config.mentionTag }));
}
function notifyMentions(fromEmail, body, mentions) { return notifyChatMentions(1, fromEmail, body, mentions); }
// Opt-in chat pushes (owner ask 2026-08-05): by DEFAULT ordinary chat messages never buzz —
// only announcements / spot offers / @mentions / DMs do. A member flips "every chat message"
// ON from their Profile (applicants.chat_push). One stable tag per program collapses a busy
// room into a single updating notification instead of a stack; mentioned users are excluded
// here because notifyChatMentions already pinged them louder.
function notifyChatOptIns(programId, fromEmail, preview, mentions = null) {
  const optIns = db.prepare('SELECT email FROM applicants WHERE COALESCE(chat_push,0) = 1 AND COALESCE(suspended,0) = 0').all().map((r) => r.email.toLowerCase());
  if (!optIns.length) return;
  const from = String(fromEmail).toLowerCase();
  const mentioned = new Set();
  const ids = String(mentions || '').split(',').map(Number).filter(Boolean);
  if (ids.length) for (const r of db.prepare(`SELECT email FROM applicants WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)) mentioned.add(r.email.toLowerCase());
  const optSet = new Set(optIns);
  const members = programId === 1 ? approvedEmails() : programMemberEmails(programId);
  const emails = members.filter((e) => { const lc = e.toLowerCase(); return lc !== from && optSet.has(lc) && !mentioned.has(lc); });
  if (!emails.length) return;
  const sender = applicantByEmail(fromEmail);
  const p = P(programId);
  setImmediate(() => sendPush(emails, {
    title: `${sender ? sender.full_name : 'Someone'} · ${p.displayName} chat`,
    body: (preview || '').slice(0, 140),
    url: p.paths.chat, tag: `${p.config.logTag || 'run'}chatmsg`,
  }));
}

// "You were mentioned" count: UNREAD group messages (newer than this viewer's read
// high-water mark, not their own) whose stored mentions include their applicant id.
// Reuses the group_reads high-water mark that groupUnread already scopes against.
const stmtChatMentions = db.prepare(`
    SELECT mentions FROM group_messages
    WHERE program_id = ? AND id > COALESCE((SELECT last_read_id FROM group_reads WHERE email = ? AND program_id = ?), 0)
      AND from_email != ? AND mentions IS NOT NULL AND mentions != ''`); // hoisted — runs on every /poll tick; PK range, not a scan
function chatMentionUnreadFor(programId, email, applicantId) {
  if (!email || !applicantId) return 0;
  const rows = stmtChatMentions.all(programId, email, programId, email);
  const idStr = String(applicantId);
  let n = 0;
  for (const r of rows) if (String(r.mentions).split(',').includes(idStr)) n++;
  return n;
}
function groupMentionUnread(email, applicantId) { return chatMentionUnreadFor(1, email, applicantId); }
// Bump this viewer's Run Chat read high-water mark to now (clears their group-unread) for a program.
const stmtMarkChatRead = db.prepare(`INSERT INTO group_reads (email, last_read_id, last_read_at, program_id)
              VALUES (?, (SELECT COALESCE(MAX(id),0) FROM group_messages WHERE program_id = ?), datetime('now'), ?)
              ON CONFLICT(email, program_id) DO UPDATE SET last_read_id = excluded.last_read_id, last_read_at = excluded.last_read_at`);
function markChatRead(programId, me) { stmtMarkChatRead.run(me, programId, programId); }
function markGroupRead(me) { return markChatRead(1, me); }

// --- Pickleball unread counts on the unified chat engine (program 2), still used by the inline
// pickleball season board. The pk chat ROUTES delegate to the generic runChat* handlers now, so the
// old load/older/notify/markRead pk wrappers were removed as dead after that extraction (P3-8).
function pkGroupUnread(email) { return chatUnreadFor(2, email); }
function pkGroupMentionUnread(email, applicantId) { return chatMentionUnreadFor(2, email, applicantId); }
// Chat gate = page gate + pickleball MEMBERSHIP. You must have opened the pickleball run
// (which joins you) to access its chat — being an approved basketball player isn't enough.
// pkIsMember/pkGate are hoisted function declarations, so this resolves despite ordering.
// Chat gate (program-generic) = page gate (login + approved + 404 while hidden) + run MEMBERSHIP.
// You must have opened the run (which joins you) to reach its chat — being approved elsewhere isn't
// enough. pkChatGate is a thin wrapper; a new run gets its chat gate for free.
function runChatGate(programId, req, res, json) {
  const g = programGate(programId, req, res); if (!g) return null; // programGate already responded on failure
  if (!memberOf(programId, req.userEmail)) {
    if (json) res.status(403).json({ err: 'notmember' });
    else res.redirect(P(programId).paths.run);             // open the run first to join
    return null;
  }
  return g;
}
function pkChatGate(req, res, json) { return runChatGate(2, req, res, json); }
// The program whose chat the Chat tab should open on a run-agnostic page (runs hub, profile,
// friends, a join prompt). Returns 0 when the viewer has joined NO active run → the tab renders
// LOCKED (grey + a "join a run first" prompt) instead of silently defaulting to basketball, which
// is an approved-players-only run. Prefers the last-opened run (cookie) when it's one they've
// joined; else their lowest-id joined run.
function chatProgramFor(req) {
  const email = req.userEmail;
  const joined = [...PROGRAMS.values()].filter(p => p.active() && programJoinedBy(p.id, email));
  if (!joined.length) return 0;
  const ck = Number(req.cookies && req.cookies.bridge_run);
  return (joined.find(p => p.id === ck) || joined[0]).id;
}
// The chat unread counts for a given program — used on the neutral pages so the run-aware
// Chat tab badge matches the room it will open. Delegates to that program's dispatch.
function chatCountsFor(program, email, aid) {
  return P(program).unread(email, aid);
}

// Reactions: the 6 standard tapbacks OR a single validated free emoji. Rejects any
// text/markup outright (both here AND esc()'d at render — defence in depth).
const STD_TAPBACKS = ['❤️', '👍', '👎', '😂', '‼️', '❓'];
function validEmoji(raw) {
  const e = String(raw || '').trim();
  if (!e) return null;
  if (STD_TAPBACKS.includes(e)) return e;                   // allowlist bypasses the heuristics
  if (Buffer.byteLength(e, 'utf8') > 16) return null;       // short: allows VS-16 / a skin modifier
  if ([...e].length > 8) return null;                       // codepoint cap (one emoji / short ZWJ seq)
  if (/[A-Za-z0-9<>"'`&\/\\]/.test(e)) return null;         // no ASCII text, no markup chars
  try {
    // all codepoints must be emoji-class (pictographic / modifier / flag / VS-16 / ZWJ)
    if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|️|‍)+$/u.test(e)) return null;
  } catch { return null; }                                  // no Unicode property support → reject
  return e;
}

// /poll fingerprint statements (P0-1) — read-only, hoisted. The poll route diffs a
// tiny fingerprint to decide when a page should re-fetch-and-patch (no full reload),
// and returns the live DM/group unread counts the client patches into tab badges.
const stmtPollChat = db.prepare('SELECT COALESCE(MAX(id),0) mx FROM group_messages WHERE program_id = 1'); // MAX on the PK is O(1); COUNT(*) was a full scan every poll tick
// A monotonic "chat structure changed" counter — bumped on delete/pin/unpin so those
// propagate to other clients' feeds without a COUNT(*) scan (deletes/pins don't move MAX(id)).
function bumpChatSeq() { setSetting('chat_seq', String((Number(getSetting('chat_seq')) || 0) + 1)); }
const stmtPollChatReact = db.prepare('SELECT COUNT(*) c, MAX(created_at) mx FROM group_reactions WHERE program_id = 1');
// Pickleball chat poll fingerprint (program 2 on the shared tables; own seq key in app_settings).
const stmtPollPkChat = db.prepare('SELECT COALESCE(MAX(id),0) mx FROM group_messages WHERE program_id = 2');
const stmtPollPkChatReact = db.prepare('SELECT COUNT(*) c, MAX(created_at) mx FROM group_reactions WHERE program_id = 2');
function bumpChatSeqFor(programId) { const k = P(programId).config.chatSeqKey; setSetting(k, String((Number(getSetting(k)) || 0) + 1)); }
// Program-generic poll fingerprints (basketball id=1 + pickleball id=2 keep their own hoisted
// statements/branches above; these serve every OTHER run — e.g. volleyball — so a new run gets
// live-refresh from the registry, no new /poll branch). Statements bind program_id at call (node:
// sqlite has no statement cache, so re-preparing per tick would be the scan these hoists avoid).
const stmtPollChatMaxG = db.prepare('SELECT COALESCE(MAX(id),0) mx FROM group_messages WHERE program_id = ?');
const stmtPollChatReactG = db.prepare('SELECT COUNT(*) c, MAX(created_at) mx FROM group_reactions WHERE program_id = ?');
function chatPollFingerprint(programId) {
  const g = stmtPollChatMaxG.get(programId), rx = stmtPollChatReactG.get(programId);
  return `${g.mx || 0}:${getSetting(P(programId).config.chatSeqKey) || 0}:${rx.c || 0}:${rx.mx || ''}`;
}

export {
  groupUnread, chatProgramFor, chatCountsFor, groupMentionUnread, stmtPollChat, stmtPollChatReact,
  stmtPollPkChat, stmtPollPkChatReact, chatPollFingerprint, validEmoji, loadGroupChat, markGroupRead,
  loadGroupChatOlder, validMentions, notifyMentions, notifyChatOptIns, bumpChatSeq, loadChat,
  markChatRead, runChatGate, loadChatOlder, notifyChatMentions, bumpChatSeqFor, chatUnreadFor,
  chatMentionUnreadFor, pkGroupUnread, pkGroupMentionUnread, pkChatGate,
};
