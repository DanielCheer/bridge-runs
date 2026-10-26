// lib/media.js — uploaded files: profile photos, chat photos/voice/video, program banners and
// stickers. Upload parsers, magic-byte sniffing, server-named writes, safe deletes, retention, and
// the avatar map handed to the views. Creates its directories on import.
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import sharp from 'sharp';
import db from '../db.js';
import {
  AVATARS_DIR, CHAT_MEDIA_DIR, CHAT_VIDEO_MAX_MB, BANNER_DIR, BANNER_PATH_ENV, PK_BANNER_PATH_ENV,
} from '../config.js';
import { STICKERS, setAvatarMap } from '../views/index.js';

// Profile photos and chat media (their static mounts are in server.js). Created on boot so the
// first upload never ENOENTs.
fs.mkdirSync(AVATARS_DIR, { recursive: true });
fs.mkdirSync(CHAT_MEDIA_DIR, { recursive: true });

// The name every uploaded file is stored under: <owner id>-<32 hex>.<ext>. Server-derived (a client
// filename never touches disk), and 128 random bits, because the name is the only thing standing
// between a stranger and a profile photo: /avatars is served without a cookie (the token-authed
// kiosk renders avatars signed out), so an avatar URL is a capability URL. /chat-media also
// requires a signed-in user. See docs/SECURITY.md.
function serverFileName(ownerId, ext) {
  return `${ownerId}-${crypto.randomBytes(16).toString('hex')}.${ext}`;
}

// ---- Profile photos --------------------------------------------------------
// Upload → memory (never trust a client filename to disk). 10 MB pre-process cap
// so a malicious/huge upload can't exhaust memory or disk before we downscale it.
const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
}).single('photo');

// Magic-byte sniff: the ONLY thing we trust to decide "is this really an image?".
// MIME headers and extensions are attacker-controlled; the first bytes are not.
// iOS re-encodes HEIC → JPEG on an accept="image/*" pick, so we only need
// jpeg/png/webp here. Returns the format or null (reject).
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

// Magic-byte sniff for a recorded voice clip — same trust model as sniffImage (never
// the client MIME/extension). Recognises the three containers MediaRecorder emits:
// WebM/Matroska (EBML, Chrome/Android → 'webm'), MP4/M4A (…ftyp at byte 4, iOS Safari
// → 'm4a'), and Ogg (Firefox → 'ogg'). Returns the extension to store under, or null
// (reject). The returned ext is the ONLY thing trusted to build the filename, so a
// spoofed name/type can never traverse or mislabel the stored file.
function sniffAudio(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'webm'; // EBML (WebM/MKV)
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'm4a';  // ....ftyp (MP4/M4A)
  if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'ogg';  // OggS
  return null;
}

// Magic-byte sniff for a video clip — same trust model as sniffImage/sniffAudio (never
// the client MIME/extension). Recognises the containers a phone/browser produces on an
// accept="video/*" pick: MP4 and QuickTime/MOV both carry a '....ftyp' box at byte 4
// (the major brand at bytes 8–11 tells them apart — 'qt  ' = QuickTime → 'mov', anything
// else → 'mp4'), and WebM/Matroska starts with the EBML marker. Returns the extension to
// store under, or null (reject). The ext is the ONLY thing trusted to build the filename.
function sniffVideo(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'webm'; // EBML (WebM/MKV)
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {              // ....ftyp (MP4/MOV)
    return (buf[8] === 0x71 && buf[9] === 0x74) ? 'mov' : 'mp4';                               // 'qt' major brand → QuickTime
  }
  return null;
}

// Delete a stored avatar file. Names are ALWAYS server-derived (<id>-<hex>.jpg), so a
// separator/`..` means something is wrong — refuse rather than traverse out of the dir.
// The daniel.jpg seed is never in the DB, so it can never be passed here.
function safeUnlinkAvatar(fname) {
  if (!fname || typeof fname !== 'string') return;
  if (fname.includes('/') || fname.includes('\\') || fname.includes('..')) return;
  try { fs.unlinkSync(path.join(AVATARS_DIR, fname)); } catch { /* already gone — fine */ }
}

// ---- Chat media (photos on messages) --------------------------------------
// Same trust model as the profile-photo pipeline: multer buffers the file in memory
// (10 MB pre-cap so a huge upload can't exhaust memory/disk before we downscale),
// magic-byte sniff (never the client MIME/extension), then sharp resizes to a max
// 1600px long edge, bakes EXIF orientation, STRIPS metadata, and re-encodes to ~80%
// JPEG (≈100–300 KB). Stored under a SERVER-derived name (<msgid>-<hex>.jpg) — the
// client filename never touches disk, so no path traversal. Single field: `image`.
const uploadChatImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
}).single('image');

// Downscale + strip + re-encode a sniffed image buffer to a ~80% JPEG (≈100–300 KB).
// Runs BEFORE any DB insert, so a sharp failure (corrupt/decompression-bomb) rejects
// cleanly with no half-created message. Throws on a sharp error.
async function processChatImage(buf) {
  return sharp(buf, { failOn: 'error' })
    .rotate()                                          // bake EXIF orientation in…
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })              // …then re-encode (metadata stripped by default)
    .toBuffer();
}
// Write a processed jpeg under a SERVER-derived name keyed by the message id
// (<msgid>-<hex>.jpg). Returns the public /chat-media path stored on the message.
async function writeChatImage(jpegBuf, msgId) {
  const fname = serverFileName(msgId, 'jpg');
  await fs.promises.writeFile(path.join(CHAT_MEDIA_DIR, fname), jpegBuf); // async so the disk write doesn't block the event loop
  return `/chat-media/${fname}`;
}

// Voice clips: multer buffers the upload in memory (8 MB pre-cap — an opus/aac voice
// note is ~4 KB/s, so 8 MB covers well past the 5-min ceiling while blocking a huge
// upload). Single field `audio`. We sniff magic bytes (sniffAudio), then store the raw
// container as-is under a SERVER-derived name (<msgid>-<hex>.<ext>) — no re-encode (no
// ffmpeg dep), and the client filename never touches disk. safeUnlinkChatImage already
// deletes ANY /chat-media/<name>, so voice files clean up on message/account delete too.
const uploadChatAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
}).single('audio');
async function writeChatAudio(buf, msgId, ext) {
  const fname = serverFileName(msgId, ext);
  await fs.promises.writeFile(path.join(CHAT_MEDIA_DIR, fname), buf); // async — a big upload write must not stall the loop
  return `/chat-media/${fname}`;
}

// Video clips: like voice, stored raw (no re-encode / no ffmpeg dep) under a SERVER-
// derived name. The pre-cap is larger (video is ~10–30 MB/min off a phone) but bounded
// — CHAT_VIDEO_MAX_MB (default 40) tunes it, since the upload rides Daniel's home
// connection through Funnel. Single field `video`. safeUnlinkChatImage deletes ANY
// /chat-media/<name>, so video files clean up on message/account delete too.
const uploadChatVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHAT_VIDEO_MAX_MB * 1024 * 1024, files: 1 },
}).single('video');
async function writeChatVideo(buf, msgId, ext) {
  const fname = serverFileName(msgId, ext);
  await fs.promises.writeFile(path.join(CHAT_MEDIA_DIR, fname), buf); // async — a 40MB video write must not block every other request
  return `/chat-media/${fname}`;
}

// ---- Check-in banner (host-uploaded, cropped in-app) ----------------------
// The 2:1 hero photo on the check-in page. A host uploads a photo and frames it in the
// browser (pan/zoom in a 2:1 window); the client sends the source-pixel crop rect and we
// sharp-crop to the final 2320×1102 (40:19). BANNER_PATH is env-overridable (tests point elsewhere).
// ONE root for every program's banner file. Previously each program hardcoded its own path into
// `public/`, so volleyball's and any in-app-created program's banner had NO env override at all —
// a test that uploaded a banner would overwrite an image the LIVE server serves immediately. Now
// there is a single writable location for the guard to verify and for the harness to redirect.
fs.mkdirSync(BANNER_DIR, { recursive: true });   // a redirected banner dir may not exist yet (matches AVATARS_DIR/CHAT_MEDIA_DIR)
const bannerFile = (name) => path.join(BANNER_DIR, name);
const BANNER_PATH = BANNER_PATH_ENV || bannerFile('gym.jpg');
const uploadBanner = multer({ storage: multer.memoryStorage(), limits: { fileSize: 14 * 1024 * 1024, files: 1 } }).single('photo');
// Cache-bust token = the banner file's mtime, so an upload busts the <img> the moment it's
// saved (no restart, no manual version bump). Falls back to a constant if the file is absent.
function bannerVersion() {
  try { return String(Math.floor(fs.statSync(BANNER_PATH).mtimeMs)); } catch { return '0'; }
}
// Pickleball gets its OWN banner photo (pk-banner.jpg); until one is uploaded it falls back
// to the basketball court photo, so the page always shows something.
const PK_BANNER_PATH = PK_BANNER_PATH_ENV || bannerFile('pk-banner.jpg');
// Write a file ATOMICALLY: full write to a temp path, then rename over the target. rename is atomic
// on one filesystem, so a concurrent reader (a poll/prewarm hitting the banner mid-upload) always
// sees the OLD or the NEW file in full — never a half-written image that could get served + cached.
async function writeFileAtomic(dest, buf) {
  const tmp = `${dest}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, buf);
  try { await fs.promises.rename(tmp, dest); }
  catch (e) { try { await fs.promises.unlink(tmp); } catch {} throw e; }
}

// Delete a stored chat photo by its public path. Only /chat-media/<safe-name> paths are
// touched — stickers (/stickers/*) and anything with a separator/`..` are refused, so a
// stray value can never traverse out of CHAT_MEDIA_DIR. Best-effort (already-gone = fine).
function safeUnlinkChatImage(imgPath) {
  if (!imgPath || typeof imgPath !== 'string') return;
  const prefix = '/chat-media/';
  if (!imgPath.startsWith(prefix)) return;             // stickers + external paths: nothing to delete
  const fname = imgPath.slice(prefix.length);
  if (!fname || fname.includes('/') || fname.includes('\\') || fname.includes('..')) return;
  try { fs.unlinkSync(path.join(CHAT_MEDIA_DIR, fname)); } catch { /* already gone — fine */ }
}

// Chat-media retention: keep photos/voice/video for 1 YEAR, then delete the files and null
// the media columns (the message row + any caption stay, so reply-chains/history are intact;
// a >1-year-old media-only bubble simply goes empty — nobody scrolls back that far in a run
// chat). Sticker images (/stickers/…) are shared SVGs, never pruned. Runs at boot + daily.
function pruneOldMedia() {
  try {
    let n = 0;
    const g = db.prepare("SELECT id, image, audio, video FROM group_messages WHERE created_at < datetime('now','-1 year') AND (audio IS NOT NULL OR video IS NOT NULL OR image LIKE '/chat-media/%')").all();
    const gclr = db.prepare("UPDATE group_messages SET audio = NULL, video = NULL, image = CASE WHEN image LIKE '/chat-media/%' THEN NULL ELSE image END WHERE id = ?");
    // group_messages now holds every program's room (program_id), so this one sweep covers
    // pickleball too — the old pk_group_messages twin is gone (Phase 2 merge). Age-based media
    // retention is program-agnostic, so no program_id filter is needed or wanted here.
    for (const r of g) { safeUnlinkChatImage(r.image); safeUnlinkChatImage(r.audio); safeUnlinkChatImage(r.video); gclr.run(r.id); n++; }
    const d = db.prepare("SELECT id, image FROM messages WHERE created_at < datetime('now','-1 year') AND image LIKE '/chat-media/%'").all();
    const dclr = db.prepare('UPDATE messages SET image = NULL WHERE id = ?');
    for (const r of d) { safeUnlinkChatImage(r.image); dclr.run(r.id); n++; }
    if (n) console.log(`[media-prune] cleared ${n} chat-media file(s) older than 1 year`);
  } catch (e) { console.error(`[media-prune] failed: ${e.message}`); }
}

// The valid sticker set (from views/chat-ui.js) → an image path, or null if unknown. A sticker
// send carries only a name; this is the ONLY thing trusted to build the path (no upload,
// no client-supplied path), so a bogus/traversal name can never become an image.
const STICKER_SET = new Set(STICKERS);
function stickerPath(name) {
  return STICKER_SET.has(String(name || '')) ? `/stickers/${name}.svg` : null;
}

// Rebuild the email→photo registry the views read (see setAvatarMap). Called at boot
// and after any avatar OR email mutation. v = file mtime ms (cache-buster). Small
// table, single process — a full rebuild is simplest and always consistent.
function refreshAvatarMap() {
  const m = new Map();
  for (const r of db.prepare("SELECT email, avatar FROM applicants WHERE avatar IS NOT NULL AND avatar != ''").all()) {
    let v = '1';
    try { v = String(Math.floor(fs.statSync(path.join(AVATARS_DIR, r.avatar)).mtimeMs)); } catch { /* file missing → default v */ }
    m.set(String(r.email).toLowerCase(), { file: r.avatar, v });
  }
  setAvatarMap(m);
}

export {
  BANNER_PATH, refreshAvatarMap, bannerVersion, uploadAvatar, sniffImage, safeUnlinkAvatar,
  uploadChatImage, processChatImage, writeChatImage, stickerPath, safeUnlinkChatImage, sniffAudio,
  uploadChatAudio, writeChatAudio, sniffVideo, uploadChatVideo, writeChatVideo, uploadBanner,
  writeFileAtomic, bannerFile, PK_BANNER_PATH, pruneOldMedia, serverFileName,
};
