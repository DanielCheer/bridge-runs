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
import { fileURLToPath } from 'url';
import db, { DB_PATH } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const KEEP = Number(process.env.BACKUP_KEEP || 14);   // retain the last N snapshots
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
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const dest = path.join(BACKUP_DIR, `bridge-${stamp()}.db`);
    // Prune dead magic-link tokens before the snapshot so the copy stays lean. A
    // token is dead once used OR expired; unused-and-valid links are preserved.
    db.prepare('DELETE FROM login_tokens WHERE used = 1 OR expires_at < ?').run(Date.now());
    // VACUUM INTO takes a string literal — escape single quotes in the path.
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    // Collapse the WAL back into the main DB. Without this the -wal file grows
    // unbounded across a long-running process (the 4MB-WAL problem). TRUNCATE
    // resets it to zero bytes. Safe here — single connection, no other writers.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    prune();
    console.log(`[backup] wrote ${path.basename(dest)}`);
    return dest;
  } catch (e) {
    // Fail loud but never crash the server over a backup problem.
    console.error(`[backup] FAILED: ${e.message}`);
    return null;
  }
}

function prune() {
  const snaps = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^bridge-.*\.db$/.test(f))
    .sort();                       // chronological by name
  const excess = snaps.length - KEEP;
  for (let i = 0; i < excess; i++) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, snaps[i])); } catch { /* ignore */ }
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
