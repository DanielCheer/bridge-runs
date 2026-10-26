// seed-fixture.mjs — create a fresh database with the app's schema and fill it with the synthetic
// world (fixtures/world.mjs).
//
//   node scripts/seed-fixture.mjs --db <path> [--today YYYY-MM-DD]
//
// The schema is created the same way the app creates it: by importing db.js (CREATE TABLEs, guarded
// ALTERs, versioned migrations). That import goes through guard.js first, so this runs as a test
// instance (HARNESS=1) with every writable location beside the database file, never inside the
// app directory. Values already present in the environment win, so a caller (test/helpers/app.mjs)
// can pass its own.
//
// Refuses to touch an existing file: a fixture is always built from nothing.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { db: { type: 'string' }, today: { type: 'string' } } });
if (!values.db) { console.error('usage: node scripts/seed-fixture.mjs --db <path> [--today YYYY-MM-DD]'); process.exit(2); }
if (values.today && !/^\d{4}-\d{2}-\d{2}$/.test(values.today)) { console.error(`--today must be YYYY-MM-DD, got "${values.today}"`); process.exit(2); }

const dbPath = path.resolve(values.db);
for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
  if (fs.existsSync(f)) { console.error(`[seed-fixture] ${f} already exists — refusing to seed over it`); process.exit(2); }
}
const work = path.dirname(dbPath);
const env = {
  HARNESS: '1',
  PORT: '0',                                   // never bound: this process only builds the file
  DB_PATH: dbPath,
  BACKUP_DIR: path.join(work, 'backups'),
  CHAT_MEDIA_DIR: path.join(work, 'media'),
  AVATARS_DIR: path.join(work, 'avatars'),
  BANNER_DIR: path.join(work, 'banners'),
  PCO_API_BASE: 'http://127.0.0.1:1',
};
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;
// db.js resolves DB_PATH at import time, so it must agree with --db even if the caller's env differs.
process.env.DB_PATH = dbPath;

const { default: db } = await import('../db.js');
const { seedWorld } = await import('../fixtures/world.mjs');
const world = seedWorld(db, { today: values.today });
db.close();
console.log(`[seed-fixture] ${dbPath} — synthetic world for ${world.today}`);
