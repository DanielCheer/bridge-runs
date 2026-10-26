// routes/chat.js — chat rooms over HTTP: the basketball room (/chat/*), the generic per-program
// handlers (runChat*) every other room delegates to, and the @-mention player search.
import db from '../db.js';
import { requireLogin } from '../auth.js';
import { chatLockedPage, chatPage, chatOlderFragment, runChatPage, avatarUrlFor } from '../views/index.js';
import { rateLimited } from '../lib/rate-limit.js';
import {
  sniffImage, uploadChatImage, processChatImage, writeChatImage, stickerPath, safeUnlinkChatImage,
  sniffAudio, uploadChatAudio, writeChatAudio, sniffVideo, uploadChatVideo, writeChatVideo,
} from '../lib/media.js';
import { P, setRunCookie } from '../engine/programs.js';
import { nextRunDate, runTimeRange } from '../engine/basketball-calendar.js';
import { annPanel } from '../engine/announcements.js';
import {
  chatProgramFor, loadGroupChat, markGroupRead, loadGroupChatOlder, validMentions, notifyMentions,
  notifyChatOptIns, validEmoji, bumpChatSeq, loadChat, markChatRead, runChatGate, loadChatOlder,
  notifyChatMentions, bumpChatSeqFor,
} from '../engine/chat.js';
import { unreadCount } from '../engine/messages.js';
import { requirePlayer, mutedOut } from './guards.js';

// ---------- RUN CHAT (program-generic) ----------
// An opt-in run's own room on the UNIFIED group_messages tables (keyed by program_id) — the same
// media pipeline (/chat-media) + base-pathed chat view as basketball. Extracted from the pickleball
// chat routes so a new run gets its whole chat surface from mountRunProgram. Basketball keeps its
// own inline /chat (the hub run). Gate = programGate + membership; 404 while the run is hidden.
// Copy/theme/base/rate-limit-bucket/seq-key all come from the registry — no per-program branch.
function runChatGet(programId, req, res) {
  const g = runChatGate(programId, req, res); if (!g) return;
  setRunCookie(req, res, programId);
  const me = req.userEmail, p = P(programId);
  const chatData = loadChat(programId, me);
  const isMod = g.admin || !!(g.a && g.a.is_host);
  const canPin = isMod || !!(g.a && g.a.is_team);
  if (req.headers['x-prewarm'] !== '1') markChatRead(programId, me);
  res.send(runChatPage({
    me, chat: { me, ...chatData, isMod, canPin, err: req.query.err || '' },
    program: programId, theme: p.config.theme, sport: p.displayName, sportEmoji: p.emoji,
    base: p.paths.chat, pollPage: `${p.config.logTag}chat`,
    dmUnread: unreadCount(me), groupUnread: 0, groupMention: 0, ann: null,
  }));
}
function runChatSeen(programId, req, res) {
  const g = runChatGate(programId, req, res); if (!g) return;
  markChatRead(programId, req.userEmail);
  res.status(204).end();
}
function runChatOlder(programId, req, res) {
  const g = runChatGate(programId, req, res); if (!g) return;
  const me = req.userEmail;
  const before = parseInt(req.query.before, 10);
  if (!Number.isInteger(before) || before <= 0) return res.status(400).send('');
  const data = loadChatOlder(programId, me, before);
  const isMod = g.admin || !!(g.a && g.a.is_host);
  const canPin = isMod || !!(g.a && g.a.is_team);
  res.send(chatOlderFragment({ me, ...data, isMod, canPin, base: P(programId).paths.chat }));
}
function runChatPost(programId, req, res) {
  const cb = P(programId).paths.chat, cfg = P(programId).config;
  uploadChatImage(req, res, async (err) => {
    const g = runChatGate(programId, req, res); if (!g) return;
    if (mutedOut(g, res, { back: cb })) return;
    const me = req.userEmail;
    if (err) return res.redirect(`${cb}?err=` + (err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad'));
    const body = (req.body.body || '').trim().slice(0, 1000);
    const file = req.file;
    const sticker = stickerPath(req.body.sticker);
    let replyTo = Number(req.body.reply_to) || 0;
    if (replyTo && !db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = ?').get(replyTo, programId)) replyTo = 0;
    const mentions = body ? validMentions(req.body.mentions) : null;
    if (sticker) {
      if (rateLimited(`${cfg.logTag}chat-media`, me, 20, 10 * 60 * 1000)) return res.redirect(`${cb}?err=slow`);
      db.prepare('INSERT INTO group_messages (from_email, body, reply_to, image, program_id) VALUES (?,?,?,?,?)')
        .run(me, '', replyTo || null, sticker, programId);
      notifyChatOptIns(programId, me, '💬 Sticker');
      return res.redirect(cb);
    }
    if (file && file.buffer && file.buffer.length) {
      if (rateLimited(`${cfg.logTag}chat-media`, me, 15, 10 * 60 * 1000)) return res.redirect(`${cb}?err=slow`);
      if (!sniffImage(file.buffer)) return res.redirect(`${cb}?err=type`);
      let msgId = 0;
      try {
        const jpeg = await processChatImage(file.buffer);
        const info = db.prepare('INSERT INTO group_messages (from_email, body, reply_to, mentions, program_id) VALUES (?,?,?,?,?)')
          .run(me, body, replyTo || null, mentions, programId);
        msgId = info.lastInsertRowid;
        const imgPath = await writeChatImage(jpeg, msgId);
        db.prepare('UPDATE group_messages SET image = ? WHERE id = ?').run(imgPath, msgId);
        notifyChatMentions(programId, me, body, mentions);
        notifyChatOptIns(programId, me, body || '📷 Photo', mentions);
      } catch (e) {
        if (msgId) db.prepare('DELETE FROM group_messages WHERE id = ?').run(msgId);
        console.error(`[${cfg.logTag}chat] image process failed for ${me}: ${e.message}`);
        return res.redirect(`${cb}?err=bad`);
      }
      return res.redirect(cb);
    }
    if (!body) return res.redirect(cb);
    if (rateLimited(`${cfg.logTag}chat-send`, me, 30, 10 * 60 * 1000)) return res.redirect(`${cb}?err=slow`);
    db.prepare('INSERT INTO group_messages (from_email, body, reply_to, mentions, program_id) VALUES (?,?,?,?,?)')
      .run(me, body, replyTo || null, mentions, programId);
    notifyChatMentions(programId, me, body, mentions);
    notifyChatOptIns(programId, me, body, mentions);
    res.redirect(cb);
  });
}
function runChatReact(programId, req, res) {
  const cb = P(programId).paths.chat, cfg = P(programId).config;
  const g = runChatGate(programId, req, res); if (!g) return;
  if (mutedOut(g, res, { back: cb })) return;
  const me = req.userEmail;
  const messageId = Number(req.body.message_id) || 0;
  if (!db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = ?').get(messageId, programId)) return res.redirect(cb);
  const emoji = validEmoji(req.body.emoji);
  if (!emoji) return res.redirect(cb);
  if (rateLimited(`${cfg.logTag}chat-react`, me, 40, 10 * 60 * 1000)) return res.redirect(cb);
  const existing = db.prepare('SELECT emoji FROM group_reactions WHERE group_message_id = ? AND from_email = ?').get(messageId, me);
  if (existing && existing.emoji === emoji) {
    db.prepare('DELETE FROM group_reactions WHERE group_message_id = ? AND from_email = ?').run(messageId, me);
  } else {
    db.prepare(`INSERT INTO group_reactions (group_message_id, from_email, emoji, program_id) VALUES (?,?,?,?)
                ON CONFLICT(group_message_id, from_email) DO UPDATE SET emoji = excluded.emoji, created_at = datetime('now')`)
      .run(messageId, me, emoji, programId);
  }
  res.redirect(cb);
}
function runChatDelete(programId, req, res) {
  const cb = P(programId).paths.chat;
  const g = runChatGate(programId, req, res); if (!g) return;
  const me = req.userEmail;
  const messageId = Number(req.body.message_id) || 0;
  const msg = db.prepare('SELECT id, from_email, image, audio, video FROM group_messages WHERE id = ? AND program_id = ?').get(messageId, programId);
  if (!msg) return res.redirect(cb);
  const isMod = g.admin || !!(g.a && g.a.is_host);
  if (!isMod && msg.from_email !== me) return res.redirect(cb);
  db.prepare('DELETE FROM group_reactions WHERE group_message_id = ?').run(messageId);
  db.prepare('DELETE FROM group_messages WHERE id = ?').run(messageId);
  bumpChatSeqFor(programId);
  safeUnlinkChatImage(msg.image); safeUnlinkChatImage(msg.audio); safeUnlinkChatImage(msg.video);
  res.redirect(cb);
}
function runChatPin(programId, req, res) {
  const cb = P(programId).paths.chat;
  const g = runChatGate(programId, req, res); if (!g) return;
  if (mutedOut(g, res, { back: cb })) return;
  const canPin = g.admin || !!(g.a && (g.a.is_host || g.a.is_team));
  if (!canPin) return res.redirect(cb);
  const messageId = Number(req.body.message_id) || 0;
  const msg = db.prepare('SELECT id, pinned_at FROM group_messages WHERE id = ? AND program_id = ?').get(messageId, programId);
  if (!msg) return res.redirect(cb);
  if (msg.pinned_at) db.prepare('UPDATE group_messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?').run(messageId);
  else db.prepare("UPDATE group_messages SET pinned_at = datetime('now'), pinned_by = ? WHERE id = ?").run(req.userEmail, messageId);
  bumpChatSeqFor(programId);
  res.redirect(cb);
}
function runChatVoice(programId, req, res) {
  const cfg = P(programId).config;
  uploadChatAudio(req, res, async (err) => {
    const g = runChatGate(programId, req, res, true); if (!g) return;
    if (mutedOut(g, res, { json: true })) return;
    const me = req.userEmail;
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ err: err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad' });
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ err: 'empty' });
    const ext = sniffAudio(file.buffer);
    if (!ext) return res.status(415).json({ err: 'type' });
    if (rateLimited(`${cfg.logTag}chat-media`, me, 15, 10 * 60 * 1000)) return res.status(429).json({ err: 'slow' });
    let dur = Math.round(Number(req.body.dur) || 0);
    if (!(dur > 0)) dur = 0;
    if (dur > 300) dur = 300;
    let replyTo = Number(req.body.reply_to) || 0;
    if (replyTo && !db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = ?').get(replyTo, programId)) replyTo = 0;
    const info = db.prepare('INSERT INTO group_messages (from_email, body, reply_to, program_id) VALUES (?,?,?,?)')
      .run(me, '', replyTo || null, programId);
    const id = info.lastInsertRowid;
    try {
      const apath = await writeChatAudio(file.buffer, id, ext);
      db.prepare('UPDATE group_messages SET audio = ?, audio_dur = ? WHERE id = ?').run(apath, dur, id);
      notifyChatOptIns(programId, me, '🎤 Voice note');
    } catch (e) {
      db.prepare('DELETE FROM group_messages WHERE id = ?').run(id);
      console.error(`[${cfg.logTag}chat] voice write failed for ${me}: ${e.message}`);
      return res.status(500).json({ err: 'bad' });
    }
    res.json({ ok: 1 });
  });
}
function runChatVideo(programId, req, res) {
  const cfg = P(programId).config;
  uploadChatVideo(req, res, async (err) => {
    const g = runChatGate(programId, req, res, true); if (!g) return;
    if (mutedOut(g, res, { json: true })) return;
    const me = req.userEmail;
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ err: err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad' });
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ err: 'empty' });
    const ext = sniffVideo(file.buffer);
    if (!ext) return res.status(415).json({ err: 'type' });
    if (rateLimited(`${cfg.logTag}chat-media`, me, 15, 10 * 60 * 1000)) return res.status(429).json({ err: 'slow' });
    let dur = Math.round(Number(req.body.dur) || 0);
    if (!(dur > 0)) dur = 0;
    if (dur > 3600) dur = 3600;
    let replyTo = Number(req.body.reply_to) || 0;
    if (replyTo && !db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = ?').get(replyTo, programId)) replyTo = 0;
    const info = db.prepare('INSERT INTO group_messages (from_email, body, reply_to, program_id) VALUES (?,?,?,?)')
      .run(me, '', replyTo || null, programId);
    const id = info.lastInsertRowid;
    try {
      const vpath = await writeChatVideo(file.buffer, id, ext);
      db.prepare('UPDATE group_messages SET video = ?, video_dur = ? WHERE id = ?').run(vpath, dur, id);
      notifyChatOptIns(programId, me, '🎬 Video');
    } catch (e) {
      db.prepare('DELETE FROM group_messages WHERE id = ?').run(id);
      console.error(`[${cfg.logTag}chat] video write failed for ${me}: ${e.message}`);
      return res.status(500).json({ err: 'bad' });
    }
    res.json({ ok: 1 });
  });
}

export function mountChat(app) {
  // ---------- RUN CHAT (single shared room for ALL approved players) ----------
  // Coexists with the 1:1 host DMs above — separate tables, separate routes. All
  // four routes: requireLogin + requirePlayer (approved players + admins). Sender
  // identity comes ONLY from req.userEmail; a body from_email is never trusted.

  // Chat is LOCKED until you've joined a run. The run-aware Chat tab points here for a viewer who
  // belongs to no run; it explains why + links to the runs hub. Self-correcting: if they HAVE
  // joined a run (e.g. just did), bounce straight to that run's chat rather than show the lock.
  app.get('/chat/locked', requireLogin, (req, res) => {
    const pid = chatProgramFor(req);
    if (pid) return res.redirect(P(pid).paths.chat);
    res.send(chatLockedPage({ email: req.userEmail, dmUnread: unreadCount(req.userEmail) }));
  });

  // The room — its own full page (the Chat tab). Last ~200 messages ASC in bulk +
  // reactions map + reply-parent map + sender map (no N+1). Opening the room UPSERTs
  // the viewer's read high-water mark (mark-read on GET), so the Chat tab badge reads
  // 0 group-unread while you're here. The err flag (rate-limit notice) is carried in.
  app.get('/chat', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    setRunCookie(req, res, 1); // reading basketball chat → neutral pages' Chat tab points back at basketball
    const { a, viewerIsAdmin } = gate;
    const me = req.userEmail;
    const chatData = loadGroupChat(me);
    const isMod = viewerIsAdmin || !!(a && a.is_host);
    const canPin = isMod || !!(a && a.is_team);   // team + admin/host can pin
    // A router PREWARM (pointerdown) must NOT clear unread — only a real landing does, via the
    // /chat/seen beacon. A normal full-page load (no prewarm header) still marks read here.
    if (req.headers['x-prewarm'] !== '1') markGroupRead(me);
    res.send(chatPage({
      me,
      chat: { me, ...chatData, isMod, canPin, err: req.query.err || '' },
      runDate: nextRunDate(),
      hours: runTimeRange(nextRunDate()),
      dmUnread: unreadCount(me),
      groupUnread: 0,   // just marked read
      groupMention: 0,  // mentions cleared on open too
      ann: annPanel(me),
    }));
  });

  // Mark Run Chat read — fired as a beacon by the client router when it actually LANDS on
  // /chat (a router prewarm skips the mark-read so a mere pointerdown/scroll can't clear the
  // unread badge). No body; requireLogin + player gate, then move the read high-water mark.
  app.post('/chat/seen', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    markGroupRead(req.userEmail);
    res.status(204).end();
  });

  // Scroll-back: return an HTML fragment of the 200 messages older than ?before=<id>
  // (the oldest message currently shown) for the client to PREPEND. Read-only — no
  // mark-read side effect (you're browsing history, not catching up on the latest).
  app.get('/chat/older', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    const { a, viewerIsAdmin } = gate;
    const me = req.userEmail;
    const before = parseInt(req.query.before, 10);
    if (!Number.isInteger(before) || before <= 0) return res.status(400).send('');
    const data = loadGroupChatOlder(me, before);
    const isMod = viewerIsAdmin || !!(a && a.is_host);
    const canPin = isMod || !!(a && a.is_team);
    res.send(chatOlderFragment({ me, ...data, isMod, canPin }));
  });

  // Send — text, an OPTIONAL photo (multipart `image`), or a `sticker` name. reply_to
  // validated to a real group message or dropped. Identity from req.userEmail. A message
  // may carry body, image, or both; neither → no-op. multer parses multipart; for a plain
  // urlencoded/fetch text send it just calls through (req.file undefined).
  app.post('/chat', requireLogin, (req, res) => {
    uploadChatImage(req, res, async (err) => {
      const gate = requirePlayer(req, res);
      if (!gate) return;
      if (mutedOut(gate, res, { back: '/chat' })) return; // suspended = muted
      const me = req.userEmail;
      if (err) return res.redirect('/chat?err=' + (err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad'));
      const body = (req.body.body || '').trim().slice(0, 1000);
      const file = req.file;
      const sticker = stickerPath(req.body.sticker);
      let replyTo = Number(req.body.reply_to) || 0;
      if (replyTo && !db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = 1').get(replyTo)) replyTo = 0;
      // @-mentions: validate the hidden comma-separated ids against real applicants.
      // Only meaningful when there's a body to carry the "@Name" text (stickers have none).
      const mentions = body ? validMentions(req.body.mentions) : null;

      // Sticker send (no upload): image = validated sticker path, no body.
      if (sticker) {
        if (rateLimited('chat-media', me, 20, 10 * 60 * 1000)) return res.redirect('/chat?err=slow');
        db.prepare('INSERT INTO group_messages (from_email, body, reply_to, image) VALUES (?,?,?,?)')
          .run(me, '', replyTo || null, sticker);
        notifyChatOptIns(1, me, '💬 Sticker');
        return res.redirect('/chat');
      }
      // Photo send (optional caption in body): sniff → process → insert → write → set image.
      if (file && file.buffer && file.buffer.length) {
        if (rateLimited('chat-media', me, 15, 10 * 60 * 1000)) return res.redirect('/chat?err=slow');
        if (!sniffImage(file.buffer)) return res.redirect('/chat?err=type'); // magic-byte gate
        let msgId = 0;
        try {
          const jpeg = await processChatImage(file.buffer);                  // process BEFORE insert
          const info = db.prepare('INSERT INTO group_messages (from_email, body, reply_to, mentions) VALUES (?,?,?,?)')
            .run(me, body, replyTo || null, mentions);
          msgId = info.lastInsertRowid;
          const imgPath = await writeChatImage(jpeg, msgId);
          db.prepare('UPDATE group_messages SET image = ? WHERE id = ?').run(imgPath, msgId);
          notifyMentions(me, body, mentions);
          notifyChatOptIns(1, me, body || '📷 Photo', mentions);
        } catch (e) {
          if (msgId) db.prepare('DELETE FROM group_messages WHERE id = ?').run(msgId); // no half-sent (caption-only) row
          console.error(`[chat] image process failed for ${me}: ${e.message}`);
          return res.redirect('/chat?err=bad');
        }
        return res.redirect('/chat');
      }
      // Text-only (unchanged): neither body, image, nor sticker → no-op insert.
      if (!body) return res.redirect('/chat');
      if (rateLimited('chat-send', me, 30, 10 * 60 * 1000)) return res.redirect('/chat?err=slow');
      db.prepare('INSERT INTO group_messages (from_email, body, reply_to, mentions) VALUES (?,?,?,?)')
        .run(me, body, replyTo || null, mentions);
      notifyMentions(me, body, mentions);
      notifyChatOptIns(1, me, body, mentions);
      res.redirect('/chat');
    });
  });

  // React — 6 tapbacks or a single validated free emoji (same rules as DMs). Toggle
  // off on re-tap of the same emoji; replace otherwise, via the UNIQUE constraint.
  app.post('/chat/react', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    if (mutedOut(gate, res, { back: '/chat' })) return; // suspended = muted
    const me = req.userEmail;
    const messageId = Number(req.body.message_id) || 0;
    if (!db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = 1').get(messageId)) return res.redirect('/chat');
    const emoji = validEmoji(req.body.emoji);
    if (!emoji) return res.redirect('/chat');
    if (rateLimited('chat-react', me, 40, 10 * 60 * 1000)) return res.redirect('/chat');
    const existing = db.prepare('SELECT emoji FROM group_reactions WHERE group_message_id = ? AND from_email = ?').get(messageId, me);
    if (existing && existing.emoji === emoji) {
      db.prepare('DELETE FROM group_reactions WHERE group_message_id = ? AND from_email = ?').run(messageId, me);
    } else {
      db.prepare(`INSERT INTO group_reactions (group_message_id, from_email, emoji) VALUES (?,?,?)
                ON CONFLICT(group_message_id, from_email) DO UPDATE SET emoji = excluded.emoji, created_at = datetime('now')`)
        .run(messageId, me, emoji);
    }
    res.redirect('/chat');
  });

  // Delete — host or admin may delete ANY message; a player may delete their OWN.
  // Reactions cascade via the FK; the explicit delete makes it independent of the
  // runtime pragma. A dangling reply_to on a child renders the graceful stub.
  app.post('/chat/delete', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    const me = req.userEmail, a = gate.a;
    const messageId = Number(req.body.message_id) || 0;
    const msg = db.prepare('SELECT id, from_email, image, audio, video FROM group_messages WHERE id = ? AND program_id = 1').get(messageId);
    if (!msg) return res.redirect('/chat');
    const isMod = gate.viewerIsAdmin || !!(a && a.is_host);
    if (!isMod && msg.from_email !== me) return res.redirect('/chat');
    db.prepare('DELETE FROM group_reactions WHERE group_message_id = ?').run(messageId);
    db.prepare('DELETE FROM group_messages WHERE id = ?').run(messageId);
    bumpChatSeq(); // propagate the delete to other clients' poll (MAX(id) may not move)
    // Drop any stored media file (best-effort; stickers/external paths are a no-op).
    safeUnlinkChatImage(msg.image); safeUnlinkChatImage(msg.audio); safeUnlinkChatImage(msg.video);
    res.redirect('/chat');
  });

  // Pin / unpin a Run Chat message — team, host, or admin only. Toggles pinned_at.
  app.post('/chat/pin', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    if (mutedOut(gate, res, { back: '/chat' })) return; // suspended = muted
    const a = gate.a;
    const canPin = gate.viewerIsAdmin || !!(a && (a.is_host || a.is_team));
    if (!canPin) return res.redirect('/chat');
    const messageId = Number(req.body.message_id) || 0;
    const msg = db.prepare('SELECT id, pinned_at FROM group_messages WHERE id = ? AND program_id = 1').get(messageId);
    if (!msg) return res.redirect('/chat');
    if (msg.pinned_at) db.prepare('UPDATE group_messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?').run(messageId);
    else db.prepare("UPDATE group_messages SET pinned_at = datetime('now'), pinned_by = ? WHERE id = ?").run(req.userEmail, messageId);
    bumpChatSeq(); // pin/unpin now propagates to other clients' feeds via the poll fingerprint (P2-10)
    res.redirect('/chat');
  });

  // Voice message — a recorded audio clip (multipart field `audio`, optional reply_to +
  // dur). Always a fetch send (MediaRecorder blob), so this replies in JSON, not a
  // redirect; the client refreshes the thread on success. multer buffers → sniffAudio
  // magic-byte gate → store raw container → set audio/audio_dur on a new message.
  app.post('/chat/voice', requireLogin, (req, res) => {
    uploadChatAudio(req, res, async (err) => {
      const gate = requirePlayer(req, res);
      if (!gate) return;
      if (mutedOut(gate, res, { json: true })) return; // suspended = muted
      const me = req.userEmail;
      if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ err: err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad' });
      const file = req.file;
      if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ err: 'empty' });
      const ext = sniffAudio(file.buffer);                          // magic-byte gate (never client MIME)
      if (!ext) return res.status(415).json({ err: 'type' });
      if (rateLimited('chat-media', me, 15, 10 * 60 * 1000)) return res.status(429).json({ err: 'slow' });
      let dur = Math.round(Number(req.body.dur) || 0);              // client-reported; cosmetic only
      if (!(dur > 0)) dur = 0;
      if (dur > 300) dur = 300;
      let replyTo = Number(req.body.reply_to) || 0;
      if (replyTo && !db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = 1').get(replyTo)) replyTo = 0;
      const info = db.prepare('INSERT INTO group_messages (from_email, body, reply_to) VALUES (?,?,?)')
        .run(me, '', replyTo || null);
      const id = info.lastInsertRowid;
      try {
        const apath = await writeChatAudio(file.buffer, id, ext);
        db.prepare('UPDATE group_messages SET audio = ?, audio_dur = ? WHERE id = ?').run(apath, dur, id);
        notifyChatOptIns(1, me, '🎤 Voice note');
      } catch (e) {
        db.prepare('DELETE FROM group_messages WHERE id = ?').run(id); // no ghost row on disk failure
        console.error(`[chat] voice write failed for ${me}: ${e.message}`);
        return res.status(500).json({ err: 'bad' });
      }
      res.json({ ok: 1 });
    });
  });

  // Video message — a picked/recorded clip (multipart field `video`, optional reply_to +
  // dur). Fetch send like voice, so it replies in JSON. multer buffers → sniffVideo magic-
  // byte gate → store the raw container → set video/video_dur on a new message. Shares the
  // 'chat-media' rate-limit bucket with photos/voice.
  app.post('/chat/video', requireLogin, (req, res) => {
    uploadChatVideo(req, res, async (err) => {
      const gate = requirePlayer(req, res);
      if (!gate) return;
      if (mutedOut(gate, res, { json: true })) return; // suspended = muted
      const me = req.userEmail;
      if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ err: err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad' });
      const file = req.file;
      if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ err: 'empty' });
      const ext = sniffVideo(file.buffer);                          // magic-byte gate (never client MIME)
      if (!ext) return res.status(415).json({ err: 'type' });
      if (rateLimited('chat-media', me, 15, 10 * 60 * 1000)) return res.status(429).json({ err: 'slow' });
      let dur = Math.round(Number(req.body.dur) || 0);              // client-reported; cosmetic only
      if (!(dur > 0)) dur = 0;
      if (dur > 3600) dur = 3600;
      let replyTo = Number(req.body.reply_to) || 0;
      if (replyTo && !db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND program_id = 1').get(replyTo)) replyTo = 0;
      const info = db.prepare('INSERT INTO group_messages (from_email, body, reply_to) VALUES (?,?,?)')
        .run(me, '', replyTo || null);
      const id = info.lastInsertRowid;
      try {
        const vpath = await writeChatVideo(file.buffer, id, ext);
        db.prepare('UPDATE group_messages SET video = ?, video_dur = ? WHERE id = ?').run(vpath, dur, id);
        notifyChatOptIns(1, me, '🎬 Video');
      } catch (e) {
        db.prepare('DELETE FROM group_messages WHERE id = ?').run(id); // no ghost row on disk failure
        console.error(`[chat] video write failed for ${me}: ${e.message}`);
        return res.status(500).json({ err: 'bad' });
      }
      res.json({ ok: 1 });
    });
  });
  app.get('/pickleball/chat', requireLogin, (req, res) => runChatGet(2, req, res));
  app.post('/pickleball/chat/seen', requireLogin, (req, res) => runChatSeen(2, req, res));
  app.get('/pickleball/chat/older', requireLogin, (req, res) => runChatOlder(2, req, res));
  app.post('/pickleball/chat', requireLogin, (req, res) => runChatPost(2, req, res));
  app.post('/pickleball/chat/react', requireLogin, (req, res) => runChatReact(2, req, res));
  app.post('/pickleball/chat/delete', requireLogin, (req, res) => runChatDelete(2, req, res));
  app.post('/pickleball/chat/pin', requireLogin, (req, res) => runChatPin(2, req, res));
  app.post('/pickleball/chat/voice', requireLogin, (req, res) => runChatVoice(2, req, res));
  app.post('/pickleball/chat/video', requireLogin, (req, res) => runChatVideo(2, req, res));
}

// ---------- PLAYER SEARCH (Run Chat @-mention autocomplete) ----------
// Powers the @-mention dropdown in the Run Chat composer. Gated to approved players +
// admins (requirePlayer) and rate-limited. Searches ALL applicants by name (owner:
// "anyone in the database"), prefix matches ranked first, top 8. Returns esc-safe JSON
// [{id, name, avatar}] — name/avatar are data-only (client renders via textContent).
const stmtMentionSearch = db.prepare(`
    SELECT id, full_name, email, avatar FROM applicants
    WHERE full_name LIKE ? ESCAPE '\\' AND status = 'approved' AND email NOT LIKE '%@guest.local'
    ORDER BY (CASE WHEN full_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END), full_name COLLATE NOCASE
    LIMIT 8`);

export function mountPlayerSearch(app) {
  app.get('/players/search', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    if (rateLimited('players-search', req.userEmail, 40, 60 * 1000)) return res.status(429).json([]);
    const q = String(req.query.q || '').trim().slice(0, 60);
    // Escape LIKE wildcards so a literal % / _ / \ in the query can't widen the match.
    const like = q.replace(/[\\%_]/g, c => '\\' + c);
    const rows = stmtMentionSearch.all('%' + like + '%', like + '%');
    res.json(rows.map(r => ({ id: r.id, name: r.full_name, avatar: avatarUrlFor(r.email) || '' })));
  });
}

export {
  runChatGet, runChatSeen, runChatOlder, runChatPost, runChatReact, runChatDelete, runChatPin,
  runChatVoice, runChatVideo,
};
