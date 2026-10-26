// The encrypted-backup loop end to end: boot writes an AES-256-GCM snapshot (never a plaintext
// one) with an auto-generated key, mirrors it off-site, and scripts/restore-backup.mjs decrypts,
// integrity-checks and matches the source -- while a tampered snapshot or a wrong key is refused
// outright instead of restoring corrupt data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp, REPO } from './helpers/app.mjs';

let app, offsite, snapshot, keyFile;
before(async () => {
  offsite = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-offsite-'));
  app = await startApp({ env: { BACKUP_OFFSITE_DIR: offsite } });
  keyFile = path.join(app.work, 'backup.key');
  const dir = path.join(app.work, 'backups');
  snapshot = fs.readdirSync(dir).filter((f) => /^bridge-.*\.db\.enc$/.test(f)).map((f) => path.join(dir, f))[0];
});
after(async () => {
  await app?.stop();
  fs.rmSync(offsite, { recursive: true, force: true });
});

const restore = (src, out, key = keyFile) =>
  spawnSync(process.execPath, [path.join(REPO, 'scripts', 'restore-backup.mjs'), src, out, key], { encoding: 'utf8' });
const members = (dbPath) => {
  const d = new DatabaseSync(dbPath, { readOnly: true });
  try { return d.prepare('SELECT COUNT(*) n FROM applicants').get().n; } finally { d.close(); }
};

test('boot writes an encrypted snapshot, and only that', () => {
  assert.ok(snapshot, 'an encrypted snapshot exists');
  const plain = fs.readdirSync(path.dirname(snapshot)).filter((f) => /^bridge-.*\.db$/.test(f) || f.includes('tmp-vacuum'));
  assert.deepEqual(plain, [], 'no plaintext snapshot or vacuum temp file left on disk');
  const head = fs.readFileSync(snapshot).subarray(0, 200);
  assert.equal(head.subarray(0, 6).toString(), 'BRENC1', 'container header');
  assert.ok(!head.includes(Buffer.from('SQLite format 3')), 'ciphertext does not leak the SQLite header');
});

test('the key file was generated: 64 hex chars, in the test directory', () => {
  assert.match(fs.readFileSync(keyFile, 'utf8').trim(), /^[0-9a-f]{64}$/);
});

test('the snapshot is mirrored off-site, still encrypted', () => {
  const mirrored = path.join(offsite, path.basename(snapshot));
  assert.ok(fs.existsSync(mirrored));
  assert.ok(fs.readFileSync(mirrored).equals(fs.readFileSync(snapshot)));
});

test('restore decrypts, passes integrity_check, and matches the source', () => {
  const out = path.join(app.work, 'restored.db');
  const r = restore(snapshot, out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /integrity ok/);
  assert.equal(members(out), members(app.dbPath));
  assert.ok(members(out) > 0);
});

test('a tampered snapshot is refused, and says why', () => {
  const tampered = path.join(app.work, 'tampered.enc');
  const b = fs.readFileSync(snapshot);
  b[100] ^= 0xff;   // one flipped byte mid-ciphertext
  fs.writeFileSync(tampered, b);
  const out = path.join(app.work, 'bad.db');
  const r = restore(tampered, out);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DECRYPTION FAILED/);
  assert.equal(fs.existsSync(out), false, 'nothing was written');
});

test('the wrong key is refused the same way', () => {
  const wrongKey = path.join(app.work, 'wrong.key');
  fs.writeFileSync(wrongKey, crypto.randomBytes(32).toString('hex') + '\n');
  const r = restore(snapshot, path.join(app.work, 'wrong.db'), wrongKey);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DECRYPTION FAILED/);
});
