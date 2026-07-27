// db-migrate.js — one-time, versioned, reversible schema migrations for the
// multi-program platform. Kept in ONE clearly-named module (not scattered inline
// in db.js) because a schema migration on LIVE member data is the highest-blast-
// radius code in the app: it must be readable, independently testable, and
// all-or-nothing. db.js imports migrateToPhase2(db) and calls it once at boot,
// after every CREATE/ALTER has run and before the app serves a request.
//
// Versioning uses PRAGMA user_version (SQLite's built-in schema-version header):
//   0/1 = pre-Phase-2 (pk_* live on their own clone tables)
//   2   = Phase-2 migrated (pk_* rows merged into the generic program_id tables)
// The whole migration runs in ONE transaction. Any throw rolls the entire thing
// back, user_version stays < 2, the old pk_* tables are untouched, and the next
// boot retries cleanly. Legacy pk_* tables are RENAMED to zz_legacy_pk_* (never
// dropped) so a rollback is a file-restore + git-checkout with the rows intact.

const PHASE2_VERSION = 2;

// Tables whose UNIQUE / PRIMARY KEY must gain program_id before two programs can
// share a run_date (or a read-marker email). SQLite can't ALTER a constraint in
// place, so each is a table-rebuild: create *_new with the widened constraint,
// copy every row, drop the old, rename. None of these five is an FK parent or
// child, so the rebuild is safe with foreign_keys ON.
const REBUILDS = [
  {
    name: 'checkins',
    // Widened UNIQUE; identical columns + AUTOINCREMENT id otherwise.
    ddl: `CREATE TABLE checkins_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date TEXT NOT NULL,
      email    TEXT NOT NULL,
      name     TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      held     INTEGER NOT NULL DEFAULT 0,
      offered_at INTEGER,
      claim_token TEXT,
      confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      program_id INTEGER NOT NULL DEFAULT 1,
      UNIQUE(run_date, email, program_id)
    )`,
    cols: 'id,run_date,email,name,sort_order,held,offered_at,claim_token,confirmed_at,created_at,program_id',
    indexes: [`CREATE INDEX IF NOT EXISTS idx_checkins_claim ON checkins(claim_token)`],
    marker: 'UNIQUE(run_date, email, program_id)',
  },
  {
    name: 'run_state',
    ddl: `CREATE TABLE run_state_new (
      run_date TEXT NOT NULL,
      is_open  INTEGER NOT NULL DEFAULT 0,
      cancelled INTEGER NOT NULL DEFAULT 0,
      program_id INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (run_date, program_id)
    )`,
    cols: 'run_date,is_open,cancelled,program_id',
    indexes: [],
    marker: 'PRIMARY KEY (run_date, program_id)',
  },
  {
    name: 'regular_optout',
    ddl: `CREATE TABLE regular_optout_new (
      run_date TEXT NOT NULL,
      email    TEXT NOT NULL,
      program_id INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (run_date, email, program_id)
    )`,
    cols: 'run_date,email,program_id',
    indexes: [],
    marker: 'PRIMARY KEY (run_date, email, program_id)',
  },
  {
    name: 'attendance',
    ddl: `CREATE TABLE attendance_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date    TEXT NOT NULL,
      email       TEXT NOT NULL,
      name        TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      program_id  INTEGER NOT NULL DEFAULT 1,
      UNIQUE(run_date, email, program_id)
    )`,
    cols: 'id,run_date,email,name,recorded_at,program_id',
    indexes: [`CREATE INDEX IF NOT EXISTS idx_attendance_email ON attendance(email)`],
    marker: 'UNIQUE(run_date, email, program_id)',
  },
  {
    name: 'group_reads',
    ddl: `CREATE TABLE group_reads_new (
      email        TEXT NOT NULL,
      last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_read_id INTEGER NOT NULL DEFAULT 0,
      program_id   INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (email, program_id)
    )`,
    cols: 'email,last_read_at,last_read_id,program_id',
    indexes: [],
    marker: 'PRIMARY KEY (email, program_id)',
  },
];

// pk_* clone → generic table copy specs (all rows land as program_id = 2).
// The chat tables are handled separately (id remap); these are the flat ones.
// pk_checkins lacks held/offered_at/claim_token — they default 0/NULL/NULL.
const PK_ROW_COPIES = [
  { from: 'pk_checkins',   to: 'checkins',
    insert: 'INSERT INTO checkins (run_date,email,name,sort_order,held,offered_at,claim_token,confirmed_at,created_at,program_id)',
    select: 'SELECT run_date,email,name,sort_order,0,NULL,NULL,confirmed_at,created_at,2 FROM pk_checkins' },
  { from: 'pk_optout',     to: 'regular_optout',
    insert: 'INSERT INTO regular_optout (run_date,email,program_id)',
    select: 'SELECT run_date,email,2 FROM pk_optout' },
  { from: 'pk_run_state',  to: 'run_state',
    insert: 'INSERT INTO run_state (run_date,is_open,cancelled,program_id)',
    select: 'SELECT run_date,is_open,cancelled,2 FROM pk_run_state' },
  { from: 'pk_attendance', to: 'attendance',
    insert: 'INSERT INTO attendance (run_date,email,name,recorded_at,program_id)',
    select: 'SELECT run_date,email,name,recorded_at,2 FROM pk_attendance' },
  { from: 'pk_announcements', to: 'announcements',
    // pk uses created_at; the generic table calls it `at`. No read/dismissal
    // tracking existed for pk announcements, so their ids are unreferenced —
    // new AUTOINCREMENT ids are fine.
    insert: 'INSERT INTO announcements (body,author,at,archived,archived_at,program_id)',
    select: 'SELECT body,author,created_at,archived,NULL,2 FROM pk_announcements' },
];

// Every pk_* table that gets renamed to zz_legacy_pk_* at the end (kept for rollback).
const PK_TABLES = [
  'pk_checkins', 'pk_optout', 'pk_run_state', 'pk_attendance',
  'pk_group_messages', 'pk_group_reactions', 'pk_group_reads', 'pk_announcements',
];

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function tableSql(db, name) {
  const r = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return r ? r.sql : '';
}

export function migrateToPhase2(db) {
  const ver = db.prepare('PRAGMA user_version').get().user_version;
  if (ver >= PHASE2_VERSION) return { migrated: false, reason: 'already at version ' + ver };

  db.exec('BEGIN');
  try {
    // --- 1. Rebuild the five constraints to include program_id -----------------
    // Idempotent: skip a table whose constraint already carries the marker (so a
    // fresh db built from up-to-date DDL, or a partial rerun, doesn't double-work).
    for (const t of REBUILDS) {
      if (!hasTable(db, t.name)) continue;                 // fresh db may lack it (created later); nothing to widen
      if (tableSql(db, t.name).includes(t.marker)) continue; // already widened
      // Preserve the AUTOINCREMENT high-water mark. A table rebuild resets sqlite_sequence to
      // MAX(copied id); for a table with deleted rows (weekly roster churn) that's LOWER than the
      // historical high-water, so the next auto-insert would RECYCLE an id — breaking AUTOINCREMENT's
      // "never reuse" contract and shifting internal ids vs pre-migration. Capture it before the
      // drop (DROP removes the sqlite_sequence row) and restore it after, so ids continue exactly.
      const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(t.name);
      db.exec(t.ddl);
      db.exec(`INSERT INTO ${t.name}_new (${t.cols}) SELECT ${t.cols} FROM ${t.name}`);
      db.exec(`DROP TABLE ${t.name}`);
      db.exec(`ALTER TABLE ${t.name}_new RENAME TO ${t.name}`);
      for (const ix of t.indexes) db.exec(ix);
      if (seq) {  // only AUTOINCREMENT tables have a sqlite_sequence row
        db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(t.name);
        db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(t.name, seq.seq);
      }
    }

    // --- 2. Merge pk_* rows in as program_id = 2 -------------------------------
    // Flat tables first (no id dependencies).
    for (const c of PK_ROW_COPIES) {
      if (!hasTable(db, c.from)) continue;
      db.exec(`${c.insert} ${c.select}`);
    }

    // Chat tables need a message-id remap: pk_group_messages.id and
    // group_messages.id are both AUTOINCREMENT from 1, so their id spaces overlap.
    // Offset every pk message id by OFFSET = MAX(group_messages.id) (0 if empty) so
    // pk ids land strictly above every basketball id, then rewrite every column
    // that references a message id by the same offset, in lockstep.
    if (hasTable(db, 'pk_group_messages')) {
      const offset = db.prepare('SELECT COALESCE(MAX(id),0) o FROM group_messages').get().o;
      // Parents first (FK: group_reactions -> group_messages(id), foreign_keys ON).
      db.exec(`INSERT INTO group_messages
        (id, from_email, body, reply_to, image, created_at, mentions, pinned_at, pinned_by, audio, audio_dur, video, video_dur, program_id)
        SELECT id + ${offset}, from_email, body,
               CASE WHEN reply_to IS NOT NULL THEN reply_to + ${offset} ELSE NULL END,
               image, created_at, mentions, pinned_at, pinned_by, audio, audio_dur, video, video_dur, 2
        FROM pk_group_messages`);
      if (hasTable(db, 'pk_group_reactions')) {
        db.exec(`INSERT INTO group_reactions (group_message_id, from_email, emoji, created_at, program_id)
          SELECT group_message_id + ${offset}, from_email, emoji, created_at, 2 FROM pk_group_reactions`);
      }
      if (hasTable(db, 'pk_group_reads')) {
        // last_read_id 0 = "read nothing yet" → stays 0; any real watermark shifts by offset.
        db.exec(`INSERT INTO group_reads (email, last_read_at, last_read_id, program_id)
          SELECT email, last_read_at,
                 CASE WHEN last_read_id > 0 THEN last_read_id + ${offset} ELSE 0 END, 2
          FROM pk_group_reads`);
      }
    }

    // --- 3. Rename the drained pk_* clones to zz_legacy_* (reversible artifact) --
    for (const t of PK_TABLES) {
      if (hasTable(db, t)) db.exec(`ALTER TABLE ${t} RENAME TO zz_legacy_${t}`);
    }

    db.exec(`PRAGMA user_version = ${PHASE2_VERSION}`);
    db.exec('COMMIT');
    console.log('[db-migrate] Phase 2 complete: pk_* merged into generic program_id tables (version ' + PHASE2_VERSION + ')');
    return { migrated: true };
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[db-migrate] Phase 2 FAILED, rolled back — db unchanged:', e.message);
    throw e;
  }
}

export { PHASE2_VERSION, PK_TABLES, REBUILDS };
