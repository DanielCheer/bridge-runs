// restore-backup.mjs — decrypt + verify a backup snapshot. The other half of "encrypted backups
// with a tested restore path": an encrypted backup nobody has ever restored is a hope, not a backup.
//
//   node restore-backup.mjs <bridge-....db.enc> <out.db> [keyfile]
//
// keyfile defaults to ./backup.key next to this script. On success the restored DB is opened and
// integrity-checked, and the member count is printed so a human can sanity-check it instantly.
// GCM authenticates the whole container: a tampered or truncated snapshot FAILS decryption —
// it can never restore silently corrupted data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [, , src, out, keyArg] = process.argv;
if (!src || !out) { console.error('usage: node restore-backup.mjs <snapshot.db.enc> <out.db> [keyfile]'); process.exit(2); }
const keyFile = keyArg || path.join(__dirname, 'backup.key');

const hex = fs.readFileSync(keyFile, 'utf8').trim();
if (!/^[0-9a-f]{64}$/.test(hex)) { console.error(`key at ${keyFile} is malformed`); process.exit(2); }
const buf = fs.readFileSync(src);

const MAGIC = Buffer.from('BRENC1');
if (!buf.subarray(0, 6).equals(MAGIC)) {
  console.error('not an encrypted snapshot (missing BRENC1 header) — a pre-encryption .db restores by plain copy');
  process.exit(2);
}
const iv = buf.subarray(6, 18);
const tag = buf.subarray(buf.length - 16);
const ct = buf.subarray(18, buf.length - 16);
const de = crypto.createDecipheriv('aes-256-gcm', Buffer.from(hex, 'hex'), iv);
de.setAuthTag(tag);
let plain;
try { plain = Buffer.concat([de.update(ct), de.final()]); }
catch { console.error('DECRYPTION FAILED — wrong key, or the snapshot was tampered with/truncated.'); process.exit(1); }
fs.writeFileSync(out, plain);

// Verify what we just restored, not just that bytes appeared.
const db = new DatabaseSync(out, { readOnly: true });
const integ = db.prepare('PRAGMA integrity_check').get();
const ok = integ && Object.values(integ)[0] === 'ok';
const members = db.prepare('SELECT COUNT(*) n FROM applicants').get().n;
db.close();
if (!ok) { console.error('restored file FAILED SQLite integrity_check'); process.exit(1); }
console.log(`restored ${path.basename(src)} → ${out} · integrity ok · ${members} member record(s)`);
