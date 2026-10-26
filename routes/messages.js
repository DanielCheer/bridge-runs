// routes/messages.js — direct messages: a thread with one person (read, send with photo or
// sticker, react). Bodies are encrypted at rest through lib/dm-crypto.js.
import db from '../db.js';
import { requireLogin } from '../auth.js';
import { threadPage } from '../views/index.js';
import { rateLimited } from '../lib/rate-limit.js';
import { dmDec, dmEnc } from '../lib/dm-crypto.js';
import { sniffImage, uploadChatImage, processChatImage, writeChatImage, stickerPath } from '../lib/media.js';
import { stmtApplicantById } from '../engine/applicants.js';
import { canMessage } from '../engine/social.js';
import { validEmoji } from '../engine/chat.js';
import { unreadCount, notifyDM } from '../engine/messages.js';
import { requirePlayer, mutedOut } from './guards.js';

// Thread — load counterpart, gate (canMessage OR pre-existing history, so a demoted
// host's past threads stay readable), mark-read (the ONLY read event; GET side-effect
// is intentional), then 3 bulk SELECTs → Maps (messages / reactions / reply parents).
const stmtDmHasHistory = db.prepare('SELECT 1 FROM messages WHERE (from_email=? AND to_email=?) OR (from_email=? AND to_email=?) LIMIT 1');
const stmtDmMarkRead = db.prepare("UPDATE messages SET read_at = datetime('now') WHERE to_email = ? AND from_email = ? AND read_at IS NULL");
const stmtDmThread = db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages WHERE (from_email=? AND to_email=?) OR (from_email=? AND to_email=?)
      ORDER BY id DESC LIMIT 500
    ) ORDER BY id ASC`);

export function mountMessages(app) {
  // The Messages tab is gone — host DMs live on the host's /profile. Old links land there.
  app.get('/messages', requireLogin, (req, res) => res.redirect('/profile'));

  // React — must precede POST /messages/:id so "react" is never captured as :id.
  // Gate: sender must be a participant of the target message's pair. Identity from
  // req.userEmail. Toggle off on re-tap of the same emoji; replace otherwise.
  app.post('/messages/react', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    if (!gate.a) return res.redirect('/status');
    if (mutedOut(gate, res, { back: '/messages' })) return; // suspended = muted
    const me = req.userEmail;
    const messageId = Number(req.body.message_id) || 0;
    const msg = db.prepare('SELECT id, from_email, to_email FROM messages WHERE id = ?').get(messageId);
    if (!msg || (msg.from_email !== me && msg.to_email !== me)) return res.redirect('/messages');
    const other = msg.from_email === me ? msg.to_email : msg.from_email;
    const back = () => {
      const op = db.prepare('SELECT id FROM applicants WHERE email = ?').get(other);
      return res.redirect(op ? '/messages/' + op.id : '/messages');
    };
    const emoji = validEmoji(req.body.emoji);
    if (!emoji) return back();
    if (rateLimited('msg-react', me, 40, 10 * 60 * 1000)) return back();
    const existing = db.prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND from_email = ?').get(messageId, me);
    if (existing && existing.emoji === emoji) {
      db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND from_email = ?').run(messageId, me);
    } else {
      db.prepare(`INSERT INTO message_reactions (message_id, from_email, emoji) VALUES (?,?,?)
                ON CONFLICT(message_id, from_email) DO UPDATE SET emoji = excluded.emoji, created_at = datetime('now')`)
        .run(messageId, me, emoji);
    }
    return back();
  });
  app.get('/messages/:id', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    if (!gate.a) return res.redirect('/status');
    const me = req.userEmail, a = gate.a;
    const p = stmtApplicantById.get(Number(req.params.id) || 0);
    if (!p) return res.redirect('/messages');
    const hasHistory = !!stmtDmHasHistory.get(me, p.email, p.email, me);
    const canPost = canMessage(me, a, p);
    if (!canPost && !hasHistory) return res.redirect('/messages');
    stmtDmMarkRead.run(me, p.email);   // intentional GET side-effect (mark thread read) — compile-site moved, execution unchanged
    const msgs = stmtDmThread.all(me, p.email, p.email, me);
    for (const m of msgs) m.body = dmDec(m.body);        // decrypt at-rest DM bodies for the thread render
    const reactions = new Map();  // message_id -> [{emoji,count,mine}]
    const parents = new Map();    // parent id -> {from_email, body, image}
    if (msgs.length) {
      const ids = msgs.map(m => m.id);
      const ph = ids.map(() => '?').join(',');
      for (const r of db.prepare(`
      SELECT message_id, emoji, COUNT(*) AS cnt,
             SUM(CASE WHEN from_email = ? THEN 1 ELSE 0 END) AS mine
      FROM message_reactions WHERE message_id IN (${ph})
      GROUP BY message_id, emoji ORDER BY message_id, emoji`).all(me, ...ids)) {
        if (!reactions.has(r.message_id)) reactions.set(r.message_id, []);
        reactions.get(r.message_id).push({ emoji: r.emoji, count: r.cnt, mine: r.mine > 0 });
      }
      const replyIds = [...new Set(msgs.map(m => m.reply_to).filter(Boolean))];
      if (replyIds.length) {
        const ph3 = replyIds.map(() => '?').join(',');
        for (const pr of db.prepare(`SELECT id, from_email, body, image FROM messages WHERE id IN (${ph3})`).all(...replyIds)) {
          pr.body = dmDec(pr.body);                     // decrypt reply-parent preview body
          parents.set(pr.id, pr);
        }
      }
    }
    res.send(threadPage({ me, p, msgs, reactions, parents, canPost, unread: unreadCount(me), err: req.query.err || '' }));
  });

  // Send — canMessage required (even a readable legacy thread can't be posted to once
  // you no longer qualify). Accepts text, an OPTIONAL photo (multipart `image`), or a
  // `sticker` name; body trimmed/capped; reply_to validated to this pair or dropped. A
  // message may carry body, image, or both; neither → no-op. Same media pipeline as /chat.
  app.post('/messages/:id', requireLogin, (req, res) => {
    uploadChatImage(req, res, async (err) => {
      const gate = requirePlayer(req, res);
      if (!gate) return;
      if (!gate.a) return res.redirect('/status');
      if (mutedOut(gate, res, { back: '/messages/' + (Number(req.params.id) || 0) })) return; // suspended = muted
      const me = req.userEmail, a = gate.a;
      const p = stmtApplicantById.get(Number(req.params.id) || 0);
      if (!p || !canMessage(me, a, p)) return res.redirect('/messages');
      const dest = '/messages/' + p.id;
      if (err) return res.redirect(dest + '?err=' + (err.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad'));
      const body = (req.body.body || '').trim().slice(0, 1000);
      const file = req.file;
      const sticker = stickerPath(req.body.sticker);
      let replyTo = Number(req.body.reply_to) || 0;
      if (replyTo) {
        const par = db.prepare(
          'SELECT id FROM messages WHERE id = ? AND ((from_email=? AND to_email=?) OR (from_email=? AND to_email=?))')
          .get(replyTo, me, p.email, p.email, me);
        if (!par) replyTo = 0;
      }

      // Sticker send (no upload): image = validated sticker path, no body.
      if (sticker) {
        if (rateLimited('msg-media', me, 20, 10 * 60 * 1000)) return res.redirect(dest + '?err=slow');
        db.prepare('INSERT INTO messages (from_email, to_email, body, reply_to, image) VALUES (?,?,?,?,?)')
          .run(me, p.email, '', replyTo || null, sticker);
        notifyDM(a, p.email, 'Sticker 🏀');
        return res.redirect(dest);
      }
      // Photo send (optional caption): sniff → process → insert → write → set image.
      if (file && file.buffer && file.buffer.length) {
        if (rateLimited('msg-media', me, 15, 10 * 60 * 1000)) return res.redirect(dest + '?err=slow');
        if (!sniffImage(file.buffer)) return res.redirect(dest + '?err=type'); // magic-byte gate
        let msgId = 0;
        try {
          const jpeg = await processChatImage(file.buffer);                    // process BEFORE insert
          const info = db.prepare('INSERT INTO messages (from_email, to_email, body, reply_to) VALUES (?,?,?,?)')
            .run(me, p.email, dmEnc(body), replyTo || null);                   // body encrypted at rest
          msgId = info.lastInsertRowid;
          const imgPath = await writeChatImage(jpeg, msgId);
          db.prepare('UPDATE messages SET image = ? WHERE id = ?').run(imgPath, msgId);
        } catch (e) {
          if (msgId) db.prepare('DELETE FROM messages WHERE id = ?').run(msgId); // no half-sent (caption-only) row
          console.error(`[dm] image process failed for ${me}: ${e.message}`);
          return res.redirect(dest + '?err=bad');
        }
        notifyDM(a, p.email, body ? '📷 ' + body : '📷 Photo');
        return res.redirect(dest);
      }
      // Text-only (unchanged): bounce a rate-limit notice rather than silently dropping.
      if (!body) return res.redirect(dest);
      if (rateLimited('msg-send', me, 20, 10 * 60 * 1000)) return res.redirect(dest + '?err=slow');
      db.prepare('INSERT INTO messages (from_email, to_email, body, reply_to) VALUES (?,?,?,?)')
        .run(me, p.email, dmEnc(body), replyTo || null);                       // body encrypted at rest
      notifyDM(a, p.email, body);
      res.redirect(dest);
    });
  });
}
