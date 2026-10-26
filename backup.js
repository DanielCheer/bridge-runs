// backup.js — periodic snapshots of the SQLite DB.
// All applicants, approvals, roles and votes live in one file on one PC. A
// corrupt file or a dead disk with no backup means re-approving everyone from
// scratch. This takes a consistent snapshot on startup and once a day after.
//
// Uses `VACUUM INTO`, which writes a fresh, transactionally-consistent, compacted
// copy of the whole DB regardless of WAL state — safer than copying the live
// .db file out from under the open connection.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import db, { DB_PATH } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const KEEP = Number(process.env.BACKUP_KEEP || 14);   // retain the last N snapshots
// Snapshots are ENCRYPTED at rest (AES-256-GCM) — they contain the whole database, including
// Planning Center tokens and member data, and the continuity plan copies them to church-controlled
// storage. Encryption protects those OFF-SITE copies; an attacker on THIS disk has the live DB
// anyway (full-disk encryption is that answer, not this one). The key lives in its own file so it
// can never be inside the thing it encrypts. Restore path: `node scripts/restore-backup.mjs <enc> <out.db>`
// — tested by gm-harness/backup-fn-test.sh, including tamper rejection.
const KEY_FILE = process.env.BACKUP_KEY_FILE || path.join(__dirname, 'backup.key');
function backupKey() {
  let hex;
  try {
    hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
  } catch {
    hex = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(KEY_FILE, hex + '\n', { mode: 0o600 });
    console.log(`[backup] generated encryption key at ${path.basename(KEY_FILE)} — copy it somewhere SEPARATE from the snapshots; a snapshot without it is unreadable`);
  }
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`backup key at ${KEY_FILE} is malformed (expected 64 hex chars)`);
  return Buffer.from(hex, 'hex');
}
// Container: MAGIC(6) | IV(12) | CIPHERTEXT | TAG(16). GCM's tag makes tampering detectable —
// a flipped byte fails decryption outright instead of restoring silently corrupted data.
const MAGIC = Buffer.from('BRENC1');
function encryptFile(srcPath, destPath, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(fs.readFileSync(srcPath)), cipher.final()]);
  fs.writeFileSync(destPath, Buffer.concat([MAGIC, iv, ct, cipher.getAuthTag()]));
}
// How often to snapshot while the process stays up. A backup also fires on every
// startup, so this is just the floor for a run that stays up for days. It only
// bounds the worst-case loss window (corrupt-right-before-a-backup); the DB is
// tiny so a tighter interval is near-free. Tune via BACKUP_EVERY_HOURS in .env.
const EVERY_MS = Number(process.env.BACKUP_EVERY_HOURS || 24) * 60 * 60 * 1000;

function stamp(d = new Date()) {
  // YYYY-MM-DD_HHmmss in local time — sorts chronologically as a filename.
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function backupNow() {
  let tmp = null;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const key = backupKey();   // resolve the key FIRST — no point vacuuming if we can't encrypt
    const dest = path.join(BACKUP_DIR, `bridge-${stamp()}.db.enc`);
    tmp = dest + '.tmp-vacuum';
    // Prune dead magic-link tokens before the snapshot so the copy stays lean. A
    // token is dead once used OR expired; unused-and-valid links are preserved.
    db.prepare('DELETE FROM login_tokens WHERE used = 1 OR expires_at < ?').run(Date.now());
    // VACUUM INTO takes a string literal — escape single quotes in the path. The plaintext
    // vacuum goes to a temp file that is encrypted and then removed in the same call, so no
    // completed backup ever sits on disk unencrypted.
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    encryptFile(tmp, dest, key);
    fs.unlinkSync(tmp); tmp = null;
    // Collapse the WAL back into the main DB. Without this the -wal file grows
    // unbounded across a long-running process (the 4MB-WAL problem). TRUNCATE
    // resets it to zero bytes. Safe here — single connection, no other writers.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    prune();
    offsiteCopy(dest);
    console.log(`[backup] wrote ${path.basename(dest)} (encrypted)`);
    return dest;
  } catch (e) {
    // Fail loud but never crash the server over a backup problem. Never leave a plaintext
    // vacuum behind on a failed run.
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* already gone */ } }
    console.error(`[backup] FAILED: ${e.message}`);
    return null;
  }
}

function prune() {
  // Covers both the new encrypted snapshots and any PRE-ENCRYPTION plaintext ones, so the old
  // plaintext files age out of retention on the normal schedule instead of lingering forever.
  const snaps = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^bridge-.*\.db(\.enc)?$/.test(f))
    .sort();                       // chronological by name (the stamp sorts)
  const excess = snaps.length - KEEP;
  for (let i = 0; i < excess; i++) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, snaps[i])); } catch { /* ignore */ }
  }
}

// OFF-SITE copy (S3, the continuity-plan promise): every encrypted snapshot is mirrored into
// BACKUP_OFFSITE_DIR — point it at a folder a sync client owns (Google Drive for Desktop, OneDrive,
// a mounted bucket) and the church-controlled off-site copy is automatic. Snapshots are AES-GCM
// encrypted, so the sync provider only ever holds ciphertext; the key must NEVER live in that
// folder. Unset = feature off (logged once, not every snapshot). Same retention as local.
const OFFSITE_DIR = process.env.BACKUP_OFFSITE_DIR || '';
let offsiteWarned = false;
function offsiteCopy(encPath) {
  if (!OFFSITE_DIR) {
    if (!offsiteWarned) { offsiteWarned = true; console.log('[backup] BACKUP_OFFSITE_DIR unset — off-site mirroring is OFF'); }
    return;
  }
  try {
    fs.mkdirSync(OFFSITE_DIR, { recursive: true });
    fs.copyFileSync(encPath, path.join(OFFSITE_DIR, path.basename(encPath)));
    const snaps = fs.readdirSync(OFFSITE_DIR).filter(f => /^bridge-.*\.db\.enc$/.test(f)).sort();
    for (let i = 0; i < snaps.length - KEEP; i++) {
      try { fs.unlinkSync(path.join(OFFSITE_DIR, snaps[i])); } catch { /* ignore */ }
    }
  } catch (e) {
    console.error(`[backup] OFF-SITE copy FAILED: ${e.message}`);   // loud, never fatal — the local snapshot exists
  }
}

// Snapshot at startup, then daily. A run that stays up all week still gets
// covered; a run that restarts often gets a fresh snapshot each launch.
export function startBackups() {
  backupNow();
  const t = setInterval(backupNow, EVERY_MS);
  t.unref?.();   // don't keep the process alive solely for the backup timer
  return t;
}
