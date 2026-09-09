// db.js — uses Node's built-in SQLite (node:sqlite, Node 22+). No native build,
// no extra install. File-based, survives restarts.
// guard.js MUST be first: it enforces the test/production boundary (paths, ports, external API,
// mail) BEFORE this module opens a database file. Every entry point imports db.js, so no script can
// start without passing it. See guard.js for the reasoning.
import { assertFixtureSanitized } from './guard.js';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import { migrateToPhase2 } from './db-migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'bridge.db');

const db = new DatabaseSync(DB_PATH);
// A harness DB must not carry live push subscriptions or Planning Center credentials — checked here,
// the first moment it can be, so an unsanitized copy fails to boot instead of contacting real people.
assertFixtureSanitized(db);
db.exec('PRAGMA journal_mode = WAL;');
// NORMAL is the recommended durability for WAL: safe across app crashes, only
// risks the last transaction on an OS crash / power loss. Default FULL fsyncs on
// every write (~200ms/write on Windows) — far too slow and needless here.
db.exec('PRAGMA synchronous = NORMAL;');
// Phase-2 messaging relies on ON DELETE CASCADE for message_reactions. node:sqlite
// defaults foreign_keys OFF, so enable it. Inert for every pre-existing table —
// none of them declare a FOREIGN KEY — so this only governs the messaging tables.
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS applicants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name   TEXT NOT NULL,
    email       TEXT NOT NULL UNIQUE,
    phone       TEXT NOT NULL,
    experience  TEXT NOT NULL,
    where_played TEXT,
    notes       TEXT,
    waiver_ok   INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'pending',
    is_team     INTEGER NOT NULL DEFAULT 0,   -- helps run it: auto-joins the floor on open
    is_regular  INTEGER NOT NULL DEFAULT 0,   -- pre-access: can join while run is closed
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date TEXT NOT NULL,
    email    TEXT NOT NULL,
    name     TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,  -- admin can float a waitlister to the top
    held     INTEGER NOT NULL DEFAULT 0,    -- late regular: kept on waitlist until Fri 4pm
    offered_at INTEGER,                     -- waitlist offer: epoch ms the floor spot was offered (NULL = no pending offer)
    claim_token TEXT,                       -- one-time token for the offer's claim link (NULL = none)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(run_date, email)
  );
  CREATE TABLE IF NOT EXISTS login_tokens (
    token      TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS run_state (
    run_date TEXT PRIMARY KEY,
    is_open  INTEGER NOT NULL DEFAULT 0   -- new Fridays default CLOSED
  );
  CREATE TABLE IF NOT EXISTS regular_optout (
    run_date TEXT NOT NULL,
    email    TEXT NOT NULL,
    PRIMARY KEY (run_date, email)   -- a regular who said "out this week"
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL DEFAULT (datetime('now')),
    actor     TEXT NOT NULL,   -- email of who did it
    actor_role TEXT NOT NULL,  -- 'admin' | 'team'
    action    TEXT NOT NULL,   -- e.g. 'vote:approve', 'role:team:on', 'checkin:remove'
    target    TEXT NOT NULL    -- applicant email or name affected
  );
  CREATE TABLE IF NOT EXISTS votes (
    applicant_id INTEGER NOT NULL,
    voter_email  TEXT NOT NULL,
    vote         TEXT NOT NULL,   -- 'approve' | 'reject'
    at           TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (applicant_id, voter_email)
  );
  CREATE TABLE IF NOT EXISTS announcements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    body        TEXT NOT NULL,
    author      TEXT NOT NULL,
    at          TEXT NOT NULL DEFAULT (datetime('now')),
    archived    INTEGER NOT NULL DEFAULT 0,   -- 0 = the live one players see; 1 = kept in history
    archived_at TEXT                          -- when it was cleared/replaced
  );
  CREATE TABLE IF NOT EXISTS invites (
    token       TEXT PRIMARY KEY,
    full_name   TEXT NOT NULL DEFAULT '',   -- admin can pre-fill any/all of these, or leave blank
    phone       TEXT NOT NULL DEFAULT '',   -- for the player to fill in themselves
    email       TEXT NOT NULL DEFAULT '',
    role        TEXT NOT NULL DEFAULT '',   -- '' | 'regular' | 'team'
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    used        INTEGER NOT NULL DEFAULT 0,
    used_at     TEXT,
    used_email  TEXT
  );
`);

// Defensive migration: if an older checkins table exists without sort_order, add it.
const checkinCols = db.prepare('PRAGMA table_info(checkins)').all().map(c => c.name);
if (!checkinCols.includes('sort_order')) {
  db.exec('ALTER TABLE checkins ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
}
// Add is_regular to applicants if missing (older DBs).
const appCols = db.prepare('PRAGMA table_info(applicants)').all().map(c => c.name);
if (!appCols.includes('is_regular')) {
  db.exec('ALTER TABLE applicants ADD COLUMN is_regular INTEGER NOT NULL DEFAULT 0');
}
// Roles v2: is_team added; anyone flagged regular under the OLD meaning
// (auto-join) becomes team, since that's what the old flag did.
if (!appCols.includes('is_team')) {
  db.exec('ALTER TABLE applicants ADD COLUMN is_team INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE applicants SET is_team = is_regular, is_regular = 0 WHERE is_regular = 1');
}
// held column for late-regular waitlisting (older DBs)
const ckCols = db.prepare('PRAGMA table_info(checkins)').all().map(c => c.name);
if (!ckCols.includes('held')) {
  db.exec('ALTER TABLE checkins ADD COLUMN held INTEGER NOT NULL DEFAULT 0');
}
// Waitlist offer-and-confirm (2026-07): a freed floor spot is OFFERED (held) to the
// top waitlister rather than silently auto-promoting them. offered_at = epoch ms the
// offer was made; claim_token = the one-time token in their claim link. Both nullable
// (NULL = no pending offer). Additive; index the token for O(1) claim lookups.
if (!ckCols.includes('offered_at')) {
  db.exec('ALTER TABLE checkins ADD COLUMN offered_at INTEGER');
}
if (!ckCols.includes('claim_token')) {
  db.exec('ALTER TABLE checkins ADD COLUMN claim_token TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_checkins_claim ON checkins(claim_token)');
// Run-day confirm/release (2026-07): a host-triggered push asks floor players to confirm
// they're coming or release their spot. confirmed_at = when they confirmed (NULL = not yet).
// Cleared with the weekly checkins purge, so it's per-run by construction.
if (!ckCols.includes('confirmed_at')) {
  db.exec('ALTER TABLE checkins ADD COLUMN confirmed_at TEXT');
}
// Run cancellation (2026-07): a host can CANCEL a specific week's run. Per-run_date (so
// cancelling this week never touches next week), additive + guarded. 1 = cancelled.
const rsCols = db.prepare('PRAGMA table_info(run_state)').all().map(c => c.name);
if (!rsCols.includes('cancelled')) {
  db.exec('ALTER TABLE run_state ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0');
}
// auto_renew: team members default to a guaranteed weekly spot; can turn it off
if (!appCols.includes('auto_renew')) {
  db.exec('ALTER TABLE applicants ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 1');
}
// waiver_at (2026-07-31): the PERMANENT record of when this member attested to the waiver.
// waiver_ok alone answers "may they play"; it can't answer "when did they agree", and the
// audit_log row (`waiver:ack`) is pruned to the newest 5000 entries, so it was never a durable
// record. NULL = attested before this column existed (or not at all) — legacy rows are left NULL
// on purpose: a backfilled date would be a fabricated attestation.
if (!appCols.includes('waiver_at')) {
  db.exec('ALTER TABLE applicants ADD COLUMN waiver_at TEXT');
}
// waiver_verified_at (2026-07-31): set only when the attestation was MATCHED against the church's
// own waiver system of record (a Planning Center form submission). waiver_at answers "when did
// they say they signed"; this answers "when did we confirm they actually did". Two columns because
// they are two different facts — collapsing them would let a self-report masquerade as proof.
if (!appCols.includes('waiver_verified_at')) {
  db.exec('ALTER TABLE applicants ADD COLUMN waiver_verified_at TEXT');
}
// dob (2026-07): date of birth ('YYYY-MM-DD'), captured at signup/invite. Drives the safeguarding
// rule that a known minor (<18) can't use 1:1 direct messages. Nullable — legacy members have none
// (treated as unknown/not-a-minor until they add it in their profile).
if (!appCols.includes('dob')) {
  db.exec('ALTER TABLE applicants ADD COLUMN dob TEXT');
}
// Announcements: archive instead of delete, so cleared/replaced posts stay as history.
const annCols = db.prepare('PRAGMA table_info(announcements)').all().map(c => c.name);
if (!annCols.includes('archived')) {
  db.exec('ALTER TABLE announcements ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
}
if (!annCols.includes('archived_at')) {
  db.exec('ALTER TABLE announcements ADD COLUMN archived_at TEXT');
}
// invites.email added after the table already shipped once — migrate existing DBs.
const inviteCols = db.prepare('PRAGMA table_info(invites)').all().map(c => c.name);
if (!inviteCols.includes('email')) {
  db.exec("ALTER TABLE invites ADD COLUMN email TEXT NOT NULL DEFAULT ''");
}

// --- Announcement read-state (2026-07): masthead notification bell ---------
// One row per viewer holding the id of the newest announcement they've seen. The
// bell's unread dot = an announcement exists with id > last_seen_id (or ANY
// announcement, if the viewer has no row yet). Marking read upserts last_seen_id to
// MAX(announcements.id). Additive + migration-guarded (CREATE TABLE IF NOT EXISTS),
// matching the additive style of every table above. Keyed by (lowercased) email so
// it survives across sessions and reloads.
db.exec(`
  CREATE TABLE IF NOT EXISTS announcement_reads (
    email        TEXT PRIMARY KEY,
    last_seen_id INTEGER,
    updated_at   TEXT
  );
`);

// --- Per-user announcement dismissals (2026-07): swipe-to-clear ------------
// One row per (viewer, announcement) they've dismissed from THEIR OWN panel. A
// dismiss is PERSONAL — it hides that announcement for this viewer only; the row in
// `announcements` is never deleted and everyone else still sees it. The panel query
// LEFT-excludes these ids per viewer, and the unread dot ignores dismissed ids.
// Keyed by (lowercased email, announcement_id) so a re-dismiss is idempotent (INSERT
// OR IGNORE). Additive + migration-guarded (CREATE TABLE IF NOT EXISTS).
db.exec(`
  CREATE TABLE IF NOT EXISTS announcement_dismissals (
    email           TEXT NOT NULL,
    announcement_id INTEGER NOT NULL,
    dismissed_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (email, announcement_id)
  );
`);

// --- Host-configurable run day (2026-07) ---
// The run defaults to a weekly Friday. A host can move a GIVEN week's run to a
// different weekday. Each row overrides ONE week, keyed by that week's default
// Friday (YYYY-MM-DD) — the stable weekly anchor nextFriday() computes. run_date
// is the host-chosen actual date. CREATE TABLE IF NOT EXISTS is inherently
// migration-guarded, matching the additive style of every table above.
db.exec(`
  CREATE TABLE IF NOT EXISTS run_overrides (
    default_date TEXT PRIMARY KEY,           -- the default Friday of the overridden week
    run_date     TEXT NOT NULL,              -- the host-chosen actual run date
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// Optional per-week TIME override (2026-07): the host can move the start/end time as
// well as the day. NULL = the DEFAULT_START–DEFAULT_END window in server.js. A row may exist for a
// time-only change even when run_date === default_date. Additive + migration-guarded.
const roCols = db.prepare('PRAGMA table_info(run_overrides)').all().map(c => c.name);
if (!roCols.includes('run_time')) db.exec('ALTER TABLE run_overrides ADD COLUMN run_time TEXT');
if (!roCols.includes('run_end'))  db.exec('ALTER TABLE run_overrides ADD COLUMN run_end TEXT');

// Sign-in CODE (2026-07): one login_tokens row now carries both the magic-link token
// AND a 6-digit code, so people can sign in INSIDE the installed PWA (where tapping an
// emailed link would land in Safari, a separate storage jar). attempts caps brute force.
const ltCols = db.prepare('PRAGMA table_info(login_tokens)').all().map(c => c.name);
if (!ltCols.includes('code'))     db.exec('ALTER TABLE login_tokens ADD COLUMN code TEXT');
if (!ltCols.includes('attempts')) db.exec('ALTER TABLE login_tokens ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');

// Run Chat unread by ID (2026-07): replace the timestamp high-water mark (`last_read_at`,
// which forced a full-table scan on every poll tick) with an integer `last_read_id`, so
// unread = COUNT of group_messages with id > last_read_id (a bounded PK range, not a scan).
// Backfill each reader's id from the last message at/under their old timestamp.
// grCols.length guards a FRESH db: the table isn't created until further below, so on an
// empty db this PRAGMA returns [] and we skip the ALTER (the CREATE now declares the column
// inline). On an existing db the table is present → the ALTER backfills as before.
const grCols = db.prepare('PRAGMA table_info(group_reads)').all().map(c => c.name);
if (grCols.length && !grCols.includes('last_read_id')) {
  db.exec('ALTER TABLE group_reads ADD COLUMN last_read_id INTEGER NOT NULL DEFAULT 0');
  db.exec(`UPDATE group_reads SET last_read_id =
    COALESCE((SELECT MAX(id) FROM group_messages WHERE created_at <= group_reads.last_read_at), 0)`);
  console.log('[db] group_reads: backfilled last_read_id');
}

// --- Native/PWA (2026-07): key-value app settings (holds the generated VAPID push
// keypair so it survives restarts + rides the db backup) + Web Push subscriptions. ---
db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- geo_reports (2026-07-31): device geometry captures for the bottom-nav localizer. The floating
  -- nav bug only appears in the installed iOS PWA, which no local test can reproduce — six fixes
  -- were written without a single measurement from the failing device. An admin taps to capture the
  -- real numbers (viewport/rect/computed style/ancestors/mode/event history) while the bug is on
  -- screen; the decision tree in docs/NAV-LOCALIZER.md maps one capture to one mechanism.
  -- Its own table, not audit_log: that has fixed actor/action/target columns and is pruned to 5000
  -- rows, so stuffing JSON into the target column would be the "substring where a structured field
  -- belongs" band-aid. Payload is JSON TEXT; rows are few (hand-triggered) and kept.
  -- audit_key_events (2026-07-31, S6): the NEVER-PRUNED record of legally/organizationally
  -- significant actions. audit_log is an operational log trimmed to 5000 rows; waiver
  -- attestations, role grants and admin sign-ins must outlive that. Rows are rare (hand-count per
  -- week), so unbounded growth is a non-issue for decades.
  CREATE TABLE IF NOT EXISTS audit_key_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    actor      TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    action     TEXT NOT NULL,
    target     TEXT NOT NULL DEFAULT ''
  );
  -- run_summary (2026-08-03, metrics layer): ONE aggregate row per finished run, written at
  -- archive time from data that is purged moments later (checkins timing, waitlist size,
  -- run_state). This is the permanent record of DEMAND (wait_n), FILL SPEED (opened_at →
  -- filled_at) and offer outcomes — the numbers the checkins purge used to destroy weekly.
  -- Aggregates only: no emails, no names. Never pruned; ~52 rows/program/year.
  CREATE TABLE IF NOT EXISTS run_summary (
    run_date   TEXT NOT NULL,
    program_id INTEGER NOT NULL DEFAULT 1,
    floor_n    INTEGER NOT NULL DEFAULT 0,   -- archived floor size (matches attendance)
    wait_n     INTEGER NOT NULL DEFAULT 0,   -- non-guest waitlisters at archive (unmet demand)
    guest_n    INTEGER NOT NULL DEFAULT 0,
    cap        INTEGER,                      -- cap at archive time (caps are editable)
    cancelled  INTEGER NOT NULL DEFAULT 0,
    opened_at  TEXT,                         -- first check-in open (run_state.opened_at)
    first_checkin_at TEXT,                   -- earliest checkins.created_at
    filled_at  TEXT,                         -- created_at of the cap-th check-in (floor-full moment)
    offers_sent INTEGER NOT NULL DEFAULT 0, offers_claimed INTEGER NOT NULL DEFAULT 0, offers_expired INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (run_date, program_id)
  );
  -- metrics_events (2026-08-03): append-only engagement/product events. Deliberately carries NO
  -- emails — kinds + counts + run keys only, so it stays outside the PII surface (see
  -- docs/PII-RETENTION.md). Rows are tiny and rare (dozens/week); offer rows are rolled into
  -- run_summary at archive, the rest serve the analytics pulse.
  -- RETENTION (stated 2026-08-04, docs/PII-RETENTION.md): individual events live 13 months for
  -- year-over-year, then collapse into monthly rollups. Implement the rollup when the first rows
  -- age past 13 months (~Sept 2027) — a planned lifecycle, not a future magic-constant cleanup.
  CREATE TABLE IF NOT EXISTS metrics_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    kind       TEXT NOT NULL,                -- push_send | push_tap | pwa_install | checkin_join | offer_send | offer_claim | offer_expire
                                             -- checkin_join population (P3-7): SOLO self-joins only, demo excluded.
                                             -- Party check-ins and auto-renew re-seats are deliberately NOT counted —
                                             -- the metric answers "how many individual grab-a-spot taps", not seats filled.
    program_id INTEGER,
    run_date   TEXT,
    n          INTEGER NOT NULL DEFAULT 1,   -- batch size (push_send) or 1
    meta       TEXT NOT NULL DEFAULT ''      -- push tag / path / mins-to-claim — never an identity
  );
  CREATE INDEX IF NOT EXISTS idx_metrics_kind_at ON metrics_events (kind, at);
  CREATE INDEX IF NOT EXISTS idx_metrics_run ON metrics_events (run_date, program_id, kind);
  CREATE TABLE IF NOT EXISTS geo_reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL DEFAULT (datetime('now')),
    actor      TEXT NOT NULL DEFAULT '',
    server_ver TEXT NOT NULL DEFAULT '',
    payload    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL,
    endpoint   TEXT NOT NULL UNIQUE,       -- the push service URL (unique per device/browser)
    p256dh     TEXT NOT NULL,              -- client public key
    auth       TEXT NOT NULL,              -- client auth secret
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_push_email ON push_subscriptions(email);
`);

// --- Redesign 2026-07: attendance history + player position + host role ---
// Permanent attendance log — the source of truth for "games attended". NEVER purged
// by any routine path (only a person hard-delete removes their rows). loadRun()
// archives the final floor into this table right before its weekly checkins purge,
// so history survives the reset. UNIQUE(run_date,email) makes archiving idempotent.
db.exec(`
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date    TEXT NOT NULL,
    email       TEXT NOT NULL,
    name        TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(run_date, email)
  );
  CREATE INDEX IF NOT EXISTS idx_attendance_email ON attendance(email);
`);
// Position (PG/SG/SF/PF/C) — player-editable on their profile, shown on cards. '' = unset.
if (!appCols.includes('position')) {
  db.exec("ALTER TABLE applicants ADD COLUMN position TEXT NOT NULL DEFAULT ''");
}
// Host — THE organizer of the night. Loudest badge + a "come to me with questions"
// profile callout. Admin-set via /admin/role; single-host invariant enforced there.
if (!appCols.includes('is_host')) {
  db.exec('ALTER TABLE applicants ADD COLUMN is_host INTEGER NOT NULL DEFAULT 0');
}
// Email opt-out (2026-07): 1 = don't send this person BROADCAST emails (announcements,
// run day/time changes). Transactional mail (magic-link sign-in, invites, and a
// waitlist spot-offer they're actively waiting on) is always sent regardless.
if (!appCols.includes('email_optout')) {
  db.exec('ALTER TABLE applicants ADD COLUMN email_optout INTEGER NOT NULL DEFAULT 0');
}
// Suspension (2026-07): an admin can suspend a person — they keep their account + history
// but can't check in or post in Run Chat until unsuspended. suspended = 1/0, suspend_reason
// is the (optional) message shown to them. Additive, guarded.
if (!appCols.includes('suspended')) {
  db.exec('ALTER TABLE applicants ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0');
}
if (!appCols.includes('suspend_reason')) {
  db.exec('ALTER TABLE applicants ADD COLUMN suspend_reason TEXT');
}
// Profile photo (2026-07): stored filename (NOT a path) in public/avatars/, keyed by
// applicant id (<id>-<shortrandom>.jpg) so it survives email changes. Nullable — NULL
// means "no photo, render initials". Additive + migration-guarded, matching every
// column above. server.js owns the file lifecycle (write/replace-delete/remove-delete).
if (!appCols.includes('avatar')) {
  db.exec('ALTER TABLE applicants ADD COLUMN avatar TEXT');
}

// --- Phase 2 (2026-07): in-app messaging (players <-> host) ---
// Additive, idempotent. Ships photo_path + reply_to + reactions NOW (even though
// v1 has no photo pipeline) so photos can be layered in later with no reshuffle.
//   messages.reply_to is a PLAIN nullable id — deliberately NO foreign key. When a
//   quoted parent is gone, the child keeps its dangling reply_to and the thread
//   renders a graceful "Original message unavailable" stub (see threadPage). A
//   FK ON DELETE SET NULL would instead silently drop the quote; we want the stub.
//   message_reactions FK-cascades on message delete; person-delete also cleans up
//   explicitly, so orphans are impossible with or without the runtime pragma.
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_email TEXT NOT NULL,
    to_email   TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',       -- '' allowed for a photo/sticker-only msg
    reply_to   INTEGER,                        -- nullable quote-reply target (no FK: see note)
    photo_path TEXT,                            -- legacy reserved column (unused; superseded by image)
    image      TEXT,                            -- media path/URL: /chat-media/<id-hex>.jpg or /stickers/<name>.svg
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at    TEXT                             -- NULL = unread by to_email
  );
  CREATE INDEX IF NOT EXISTS idx_messages_to   ON messages(to_email, read_at);
  CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_email, to_email, id);
  CREATE INDEX IF NOT EXISTS idx_messages_toem ON messages(to_email, from_email, id);
  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id INTEGER NOT NULL,
    from_email TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (message_id, from_email),       -- one reaction per person per msg; re-tap replaces
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions(message_id);
`);

// --- Run Chat (2026-07): single shared group room for ALL approved players ---
// Additive, idempotent — coexists with the 1:1 DM tables above, shares none of
// their rows. Mirrors the DM design:
//   group_messages.reply_to is a PLAIN nullable id (deliberately NO foreign key).
//   A deleted parent leaves the child's reply_to dangling and the room renders a
//   graceful "Original message unavailable" stub (see chatFragment) rather than
//   silently dropping the quote.
//   group_reactions FK-cascades on message delete; person-delete + /chat/delete
//   also clean up explicitly, so orphans are impossible with or without the pragma.
//   group_reads holds one row per viewer = the high-water mark for "read"; the
//   room feed's per-user unread badge is counted against it.
db.exec(`
  CREATE TABLE IF NOT EXISTS group_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_email TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',       -- '' allowed for a photo/sticker-only msg
    reply_to   INTEGER,                        -- nullable quote-reply target (no FK: see note)
    image      TEXT,                            -- media path/URL: /chat-media/<id-hex>.jpg or /stickers/<name>.svg
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  DROP INDEX IF EXISTS idx_group_messages_feed;  -- redundant: group_messages.id IS the rowid PK
  CREATE INDEX IF NOT EXISTS idx_group_messages_from ON group_messages(from_email, created_at);
  CREATE TABLE IF NOT EXISTS group_reactions (
    group_message_id INTEGER NOT NULL,
    from_email       TEXT NOT NULL,
    emoji            TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_message_id, from_email),   -- one reaction per person per msg; re-tap replaces
    FOREIGN KEY (group_message_id) REFERENCES group_messages(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_group_reactions_msg ON group_reactions(group_message_id);
  CREATE TABLE IF NOT EXISTS group_reads (
    email        TEXT PRIMARY KEY,
    last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_read_id INTEGER NOT NULL DEFAULT 0
  );
`);

// --- Chat media (2026-07): photos + stickers on messages -------------------
// A message may carry an `image` — either an uploaded photo (/chat-media/<id-hex>.jpg,
// resized/stripped by server.js) or a sticker (/stickers/<name>.svg). Stickers are
// detected by the /stickers/ prefix (bubble-less, larger render) — no separate column.
// Additive + migration-guarded on BOTH messaging tables, matching every column above.
const msgCols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
if (!msgCols.includes('image')) {
  db.exec('ALTER TABLE messages ADD COLUMN image TEXT');
}
const gmsgCols = db.prepare('PRAGMA table_info(group_messages)').all().map(c => c.name);
if (!gmsgCols.includes('image')) {
  db.exec('ALTER TABLE group_messages ADD COLUMN image TEXT');
}

// --- @-mentions (2026-07): Run Chat messages can tag applicants ------------
// mentions = a comma-separated list of applicant ids the sender @-tagged in the
// body (e.g. "12,15"). Nullable — NULL/'' means "no mentions". Additive +
// migration-guarded, matching every column above. The body still stores the raw
// "@Full Name" text; the id list drives esc-safe linkify on render + the
// "you were mentioned" unread indicator. group_messages only (DMs skip mentions).
if (!gmsgCols.includes('mentions')) {
  db.exec('ALTER TABLE group_messages ADD COLUMN mentions TEXT');
}
// --- Pinned messages (2026-07): team/admin/host can pin a Run Chat message; pinned
// ones show at the top of the room (Discord-style). pinned_at = when it was pinned
// (NULL = not pinned; used for ordering newest-pin first), pinned_by = pinner's email.
if (!gmsgCols.includes('pinned_at')) db.exec('ALTER TABLE group_messages ADD COLUMN pinned_at TEXT');
if (!gmsgCols.includes('pinned_by')) db.exec('ALTER TABLE group_messages ADD COLUMN pinned_by TEXT');
// --- Voice messages (2026-07): a message may carry a recorded audio clip instead of
// text/photo. audio = public /chat-media/<id>-<hex>.<ext> path (NULL = none), audio_dur
// = clip length in whole seconds (client-reported, capped server-side) for the m:ss label.
if (!gmsgCols.includes('audio')) db.exec('ALTER TABLE group_messages ADD COLUMN audio TEXT');
if (!gmsgCols.includes('audio_dur')) db.exec('ALTER TABLE group_messages ADD COLUMN audio_dur INTEGER');
// --- Video messages (2026-07): a message may carry a recorded/picked video clip.
// video = public /chat-media/<id>-<hex>.<ext> path (NULL = none), video_dur = clip
// length in whole seconds (client-reported, capped) for the duration label. Stored raw
// (no re-encode) like voice; rendered with a native <video> (real duration metadata).
if (!gmsgCols.includes('video')) db.exec('ALTER TABLE group_messages ADD COLUMN video TEXT');
if (!gmsgCols.includes('video_dur')) db.exec('ALTER TABLE group_messages ADD COLUMN video_dur INTEGER');

// --- Multi-program platform (2026-07, PHASE 1 — additive foundation, ZERO behaviour change) ---
// The app is becoming program-aware so a second run (e.g. Pickleball) can live ALONGSIDE the
// Basketball run without touching its data. Basketball is program 1. Every run-scoped table
// gains program_id DEFAULT 1 (backfilled), so the existing queries — which don't filter on it
// yet — keep returning EXACTLY the same (program-1) rows. Pickleball (program 2) is seeded
// HIDDEN + inactive; nothing reads it until the run-scoping + routes ship in a later phase.
// Additive only — no constraint/PK changes here (those come with the scoping phase).
db.exec(`
  CREATE TABLE IF NOT EXISTS program (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    sport      TEXT NOT NULL DEFAULT '',
    slug       TEXT UNIQUE,
    active     INTEGER NOT NULL DEFAULT 1,        -- 0 = hidden / not live yet
    approval   TEXT NOT NULL DEFAULT 'council',   -- council | host | open | invite
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS program_membership (
    program_id INTEGER NOT NULL,
    email      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | suspended
    role       TEXT NOT NULL DEFAULT 'approved',  -- host | team | regular | approved
    joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (program_id, email)
  );
  -- Teams within a run (Phase 5): numbered teams (1..config.features.teams.count) players join after
  -- the roster locks. Additive + feature-flagged (config.features.teams) — dark until a program turns
  -- it on. PK makes double-assignment impossible; program_id + run_date scope it like every run table.
  CREATE TABLE IF NOT EXISTS team_assignments (
    program_id  INTEGER NOT NULL,
    run_date    TEXT NOT NULL,
    email       TEXT NOT NULL,
    team_no     INTEGER NOT NULL,
    assigned_by TEXT NOT NULL DEFAULT '',     -- '' = self-served; else the operator's email
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (program_id, run_date, email)
  );
`);
// Seed the programs (idempotent). 1 = the live Advanced Basketball run; 2 = Pickleball, 3 = Volleyball (both HIDDEN).
db.prepare("INSERT OR IGNORE INTO program (id,name,sport,slug,active,approval) VALUES (1,'Advanced Basketball','basketball','adv',1,'council')").run();
db.prepare("INSERT OR IGNORE INTO program (id,name,sport,slug,active,approval) VALUES (2,'Pickleball','pickleball','pickleball',0,'invite')").run();
db.prepare("INSERT OR IGNORE INTO program (id,name,sport,slug,active,approval) VALUES (3,'Volleyball','volleyball','volleyball',0,'invite')").run();
// Demo run (id 90) — a config-driven showcase program used ONLY for live demos. Ships inactive
// (active=0) so it is invisible to members and only an admin can open/operate it. Its players are
// synthetic checkins-only rows (@demo.local, no applicant rows) confined to program_id=90, so it
// can never touch live basketball/pickleball/volleyball rosters, attendance, or exports.
db.prepare("INSERT OR IGNORE INTO program (id,name,sport,slug,active,approval) VALUES (90,'Demo','demo','demo',0,'invite')").run();
// --- Ladder (2026-09-08): in-run game results, per program ------------------
// The season standings a program projects on the gym screen. ONE row per finished game, keyed by
// program + run date so it partitions exactly like checkins/attendance, and by EMAIL (never a typed
// name) so the roster IS the check-in list: who played resolves through applicants/checkins and
// survives a rename or an email rekey. Doubles is the shape the runs actually play — four columns,
// not a join table: a pairing is only ever two players, and a fixed shape keeps the standings query
// a single scan with no fan-out. Scores are stored raw (not a differential) because point
// differential is derived — storing the derived number is what goes stale when a game is undone.
// Additive + migration-guarded like every table above; dark until a program's config turns the
// ladder feature on.
db.exec(`
  CREATE TABLE IF NOT EXISTS ladder_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    program_id INTEGER NOT NULL,
    run_date   TEXT NOT NULL,
    w1 TEXT NOT NULL, w2 TEXT NOT NULL,      -- winning pair (lowercased emails, sorted)
    l1 TEXT NOT NULL, l2 TEXT NOT NULL,      -- losing pair
    w_score INTEGER NOT NULL,
    l_score INTEGER NOT NULL,
    logged_by TEXT NOT NULL,                 -- who tapped Log it (audit trail for an undo dispute)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ladder_games_prog ON ladder_games(program_id, run_date);
  -- The ladder's OWN roster. It exists because the roster cannot be derived: the church runs these
  -- nights in Planning Center, PCO Check-Ins is read-walled without a Check-Ins grant, and this
  -- app's checkins/attendance are empty for a program that signs up elsewhere. So the names are
  -- entered ONCE and live here for the season — never re-typed per night (owner ask 2026-09-08).
  -- Whoever the app DOES know (a member, a guest, a check-in) is unioned in at read time, so the
  -- day PCO or in-app check-in becomes available the picker fills itself and this table is just
  -- the people that neither knows about.
  -- The email column is the identity everywhere in the ladder: a real address for someone with an
  -- account, else a synthetic slug@ladder.local — the same convention as @guest.local, and equally
  -- never eligible for the church directory (nothing writes these rows into applicants).
  -- retired_at soft-deletes: a player who stops coming leaves the picker but KEEPS their results,
  -- which a hard delete would silently rewrite (standings are summed from games, not stored).
  CREATE TABLE IF NOT EXISTS ladder_players (
    program_id INTEGER NOT NULL,
    email      TEXT NOT NULL,
    name       TEXT NOT NULL,
    added_by   TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    retired_at TEXT,
    PRIMARY KEY (program_id, email)
  );
  -- Sportsmanship nominations ("Iron Sharpens Iron"): ONE nomination per voter per night, so the
  -- PK enforces one-person-one-vote without a uniqueness check in the handler. A re-nomination
  -- REPLACES that voter's pick (INSERT OR REPLACE) — changing your mind is not a second vote.
  CREATE TABLE IF NOT EXISTS ladder_nominations (
    program_id INTEGER NOT NULL,
    run_date   TEXT NOT NULL,
    email      TEXT NOT NULL,                -- who is nominated
    voter      TEXT NOT NULL,                -- who nominated them
    note       TEXT NOT NULL DEFAULT '',
    at         TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (program_id, run_date, voter)
  );
  -- HEADCOUNT: how many people were actually in the gym on a given night.
  --
  -- It cannot be derived. checkins/attendance are empty for a run that signs up in Planning Center,
  -- and ladder_games only knows people who appear in a LOGGED game — on 2026-09-08 pickleball had
  -- 12 people and zero logged games, so every existing source said "nobody came". A gauge that
  -- reads zero on a 12-person night is worse than no gauge, so the number is entered once by the
  -- operator and stored as itself.
  -- Deliberately a COUNT, not rows-per-person: nobody is taking names at an open gym, and inventing
  -- one row per head would be fabricating attendance records that later look like real identities.
  -- One row per program-night (PK), so re-entering a corrected number overwrites rather than doubles.
  CREATE TABLE IF NOT EXISTS run_headcount (
    program_id INTEGER NOT NULL,
    run_date   TEXT NOT NULL,
    n          INTEGER NOT NULL,
    noted_by   TEXT NOT NULL DEFAULT '',
    at         TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (program_id, run_date)
  );
`);
// program.config (2026-07-31) — the JSON spec for programs CREATED IN THE APP (admin "New program"
// wizard). NULL for the four code-defined programs above: buildPrograms prefers PROGRAM_DEFS by id,
// so basketball/pickleball/volleyball/demo behaviour is untouched, and only DB-defined rows (id ≥ 4)
// are built from this column. That's what makes adding a program a church-admin action, not a deploy.
{
  const cols = db.prepare('PRAGMA table_info(program)').all().map(c => c.name);
  if (!cols.includes('config')) db.exec('ALTER TABLE program ADD COLUMN config TEXT');
}
// Add program_id (DEFAULT 1) to every run-scoped table — guarded + backfilled so existing rows stay basketball.
for (const t of ['checkins', 'run_state', 'run_overrides', 'regular_optout', 'attendance', 'group_messages', 'group_reads', 'group_reactions', 'announcements', 'votes']) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  if (!cols.includes('program_id')) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN program_id INTEGER NOT NULL DEFAULT 1`);
    console.log(`[db] program-aware: added program_id to ${t}`);
  }
}

// --- Multi-program platform (2026-07, PHASE 2 — merge the pk_* clones into the generic
// program_id-scoped tables). Pickleball's rows now live in checkins/run_state/attendance/
// regular_optout/group_*/announcements as program_id=2. The old pk_* clone tables are no
// longer created here; on an existing db the one-time migration below renames them to
// zz_legacy_pk_* (rows kept for rollback) after copying their data across. See db-migrate.js.

// program_membership.auto_renew — a member's self-service weekly auto-add flag (generic table).
const pmCols = db.prepare('PRAGMA table_info(program_membership)').all().map(c => c.name);
if (pmCols.length && !pmCols.includes('auto_renew')) db.exec('ALTER TABLE program_membership ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 0');
// Auto-renew penalty (Phase 5.5): consecutive-flake strike counter + a hard-pause window (YYYY-MM-DD) + last-strike date.
if (pmCols.length && !pmCols.includes('ar_strikes')) db.exec('ALTER TABLE program_membership ADD COLUMN ar_strikes INTEGER NOT NULL DEFAULT 0');
if (pmCols.length && !pmCols.includes('ar_paused_until')) db.exec('ALTER TABLE program_membership ADD COLUMN ar_paused_until TEXT');
if (pmCols.length && !pmCols.includes('ar_strike_at')) db.exec('ALTER TABLE program_membership ADD COLUMN ar_strike_at TEXT');

// applicants.is_council — the Adv Basketball voting pool, SEPARATE from team/admin (owner rule
// 2026-08-06: "council aren't admin, they're just part of the process"). The seed rides the ALTER
// (column-absence is the one-time marker): today's voters — team minus host — keep their vote;
// from here on, council is granted explicitly and team/host/admin no longer imply it.
{
  const aCols = db.prepare('PRAGMA table_info(applicants)').all().map(c => c.name);
  if (aCols.length && !aCols.includes('is_council')) {
    db.exec('ALTER TABLE applicants ADD COLUMN is_council INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE applicants SET is_council = 1 WHERE is_team = 1 AND COALESCE(is_host, 0) = 0');
  }
}

// One-time, versioned, all-or-nothing schema migration. Runs here — after every CREATE/ALTER
// (so the generic tables + their program_id columns exist) and before the app serves a request.
// A no-op once PRAGMA user_version >= 2; on failure it rolls back and the old db is untouched.
migrateToPhase2(db);

// Auto-renew penalty (Phase 5.5): auto_seated marks a checkins row as an auto-renew AUTO-SEAT (vs a
// self-join) — only auto-seated no-shows/late-leaves strike a standing renewal. Added AFTER
// migrateToPhase2 ON PURPOSE: that migration REBUILDS checkins with a fixed column list, so a column
// added before it would be dropped by the rebuild (checkins/attendance/run_state/regular_optout/
// group_reads are all rebuilt — additive columns on them must come after). program_membership isn't
// rebuilt, so the ar_* ALTERs above sit before fine.
{
  const cc = db.prepare('PRAGMA table_info(checkins)').all().map(c => c.name);
  if (!cc.includes('auto_seated')) db.exec('ALTER TABLE checkins ADD COLUMN auto_seated INTEGER NOT NULL DEFAULT 0');
  // Queue-with-friends (Phase 6b): a checkin's party pointer (signup_groups.id). NULL = solo.
  // Party-atomic seating groups floor/waitlist decisions by this id so a party is never split.
  // vb-only via config.features.groupQueue; NULL everywhere until a party checks in → solo ≡ today.
  // Added AFTER migrateToPhase2 with auto_seated (checkins is rebuilt by that migration).
  if (!cc.includes('group_id')) db.exec('ALTER TABLE checkins ADD COLUMN group_id INTEGER');
  // checkins.dob (2026-07): optional per-checkin DOB FALLBACK for rows with NO applicant account —
  // demo players (checkins-only) + guests. partitionFor coalesces applicants.dob → this to drive the
  // red "Minor" roster badge. Real members keep their DOB on applicants; this stays null for them.
  // MUST be here (after migrateToPhase2 rebuilds checkins), not with the applicants.dob ALTER above.
  if (!cc.includes('dob')) db.exec('ALTER TABLE checkins ADD COLUMN dob TEXT');
}

// --- Social graph (2026-07, PHASE 6 — friends / follow / block) -------------
// UNIVERSAL, person-to-person (NOT run- or program-scoped): one edge table serves every
// relationship kind so a new kind is just a new `kind` value, never a new table.
//   kind='friend'  — a MUTUAL tie stored as ONE directed row: from_email = the requester,
//                    to_email = the target. status 'requested' until the target accepts →
//                    'accepted'. Queried BIDIRECTIONALLY (a friendship is one row, either way).
//   kind='follow'  — a one-way notify tie (from_email follows to_email); always 'accepted'.
//   kind='block'   — a one-way safety valve (from_email blocked to_email); always 'accepted'.
//                    Consumed as a seating/team invariant (a blocked pair is never auto-placed
//                    together) and auto-removes any friendship/follow in EITHER direction.
// Additive + migration-guarded (CREATE TABLE IF NOT EXISTS), a brand-new table the Phase-2
// migration never rebuilds — placed AFTER migrateToPhase2 so it's independent of that rebuild.
// rekeyEmailTx below carries a person's edges (both columns) on an email change; the person
// hard-delete path purges both directions. Indexed both ways for O(log n) directory lookups.
db.exec(`
  CREATE TABLE IF NOT EXISTS social_edges (
    from_email TEXT NOT NULL,
    to_email   TEXT NOT NULL,
    kind       TEXT NOT NULL,                        -- 'friend' | 'follow' | 'block'
    status     TEXT NOT NULL DEFAULT 'accepted',     -- friend: 'requested'->'accepted'; follow/block: 'accepted'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,                                 -- last status change (e.g. accept time)
    PRIMARY KEY (from_email, to_email, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_social_to   ON social_edges(to_email, kind, status);
  CREATE INDEX IF NOT EXISTS idx_social_from ON social_edges(from_email, kind, status);
`);

// --- Queue-with-friends (2026-07, PHASE 6b — a party checks in together) -----
// A "party" = a set of buddies who sign up for ONE run together and seat ATOMICALLY (all on the
// floor or all on the waitlist, never split). UNIVERSAL schema (program_id + run_date scoped like
// every run table) but the FEATURE is config-gated (config.features.groupQueue) — volleyball-only
// at launch; with it off, no party rows are ever written and checkins.group_id stays NULL → seating
// is byte-identical to today (reduction-proof: solo-only ≡ current behaviour).
//   signup_groups        — one row per party: leader + the (program, run_date) it's for.
//   signup_group_members — invite lifecycle per member: 'invited' → 'joined' | 'declined'.
// Additive + migration-guarded (brand-new tables the Phase-2 migration never rebuilds). Every
// email/run-scoped column joins rekeyEmailTx + person-delete + the rollover/cancel/date purges
// in this same commit (see server.js). A member's checkins.group_id points back here when they're
// seated as part of the party.
db.exec(`
  CREATE TABLE IF NOT EXISTS signup_groups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    program_id   INTEGER NOT NULL,
    run_date     TEXT NOT NULL,
    leader_email TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_signup_groups_run ON signup_groups(program_id, run_date);
  CREATE TABLE IF NOT EXISTS signup_group_members (
    group_id   INTEGER NOT NULL,
    email      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'invited',   -- 'invited' | 'joined' | 'declined'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, email)
  );
  CREATE INDEX IF NOT EXISTS idx_sgm_email ON signup_group_members(email);
`);

// --- Persistent parties (2026-07) — the FRIENDS-TAB layer above the per-run signup_groups. ---
// A party is created once (Friends tab), members are invited/joined there, and "Check in as
// party" on a run INSTANTIATES the per-run signup_groups machinery from it (atomic seating,
// team fill, dots all unchanged). One party per person (as leader or joined member). Decline =
// DELETE the invite row (re-invitable); the per-run 'declined' state lives in signup_group_members.
db.exec(`
  CREATE TABLE IF NOT EXISTS parties (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL DEFAULT '',
    leader_email TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_parties_leader ON parties(leader_email);
  CREATE TABLE IF NOT EXISTS party_members (
    party_id   INTEGER NOT NULL,
    email      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'invited',   -- 'invited' | 'joined'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (party_id, email)
  );
  CREATE INDEX IF NOT EXISTS idx_party_members_email ON party_members(email);
  -- Per-program waivers (F6 youth pack). A program whose config carries waiver:{key} requires a
  -- row here instead of the global applicants.waiver_ok. waiver_key is stamped into the program
  -- spec at creation and never changes (slug renames don't orphan records). Attestation dates are
  -- 'localtime' like applicants.waiver_at — these are dates people read on a quasi-legal record.
  -- Guardian columns are filled when the program requires consent for a minor (guardian attests);
  -- verified_at/verified_by is the organizer's separate "I've seen the signed document" claim.
  CREATE TABLE IF NOT EXISTS waiver_records (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    waiver_key          TEXT NOT NULL,
    email               TEXT NOT NULL,
    attested_at         TEXT,
    guardian_name       TEXT,
    guardian_phone      TEXT,
    guardian_email      TEXT,
    guardian_consent_at TEXT,
    verified_at         TEXT,
    verified_by         TEXT,
    UNIQUE (waiver_key, email)
  );
  CREATE INDEX IF NOT EXISTS idx_waiver_records_email ON waiver_records(email);
`);

// ---------- Planning Center sync (Phase 1: People ⇄ Bridge identity) ----------
// applicants.pco_id — the durable link to a PCO Person once matched or created. TEXT because
// PCO ids are opaque strings. Lives in the post-Phase2 zone: adding it above the rebuild would
// drop it from fresh DBs (the checkins.dob lesson).
{
  const cols = db.prepare('PRAGMA table_info(applicants)').all().map(c => c.name);
  if (!cols.includes('pco_id')) db.exec('ALTER TABLE applicants ADD COLUMN pco_id TEXT');
  // pco_pass_code — the VERIFIED Check-Ins pass/barcode value for this person, written only by
  // the "Verify passes" read-back (never assumed): the profile door-QR renders from this, so a
  // QR only ever shows once PCO actually knows the code. NULL = no working pass yet.
  if (!cols.includes('pco_pass_code')) db.exec('ALTER TABLE applicants ADD COLUMN pco_pass_code TEXT');
  // pco_att_sig — signature of the attendance stats last pushed to this person's PCO custom
  // fields. Only a CHANGED signature is re-pushed, so the weekly sync costs ~4 requests per
  // person who actually played (not per member) — comfortably inside PCO's 100-req/20s budget.
  if (!cols.includes('pco_att_sig')) db.exec('ALTER TABLE applicants ADD COLUMN pco_att_sig TEXT');
  // session_ver (2026-07-31, S1): the account's live session version. Cookies carry the version
  // they were minted with; "Sign out everywhere" bumps this and every older cookie dies at its
  // next request. Default 0 keeps every existing (legacy, unversioned) session valid until the
  // owner of the account chooses to revoke.
  if (!cols.includes('session_ver')) db.exec('ALTER TABLE applicants ADD COLUMN session_ver INTEGER NOT NULL DEFAULT 0');
  // last_seen_at (2026-08-03, metrics layer): coarse daily activity stamp — updated at most once
  // per LOCAL day by the engagement middleware, so WAU/MAU is computable without an event log.
  // Personal data: covered in docs/PII-RETENTION.md, deleted with the account like the rest of
  // the applicants row.
  if (!cols.includes('last_seen_at')) db.exec('ALTER TABLE applicants ADD COLUMN last_seen_at TEXT');
  // Opt-in "every chat message" pushes (2026-08-05). Default 0 = the standing posture:
  // only announcements / spot offers / @mentions / DMs buzz. Toggled on /profile.
  if (!cols.includes('chat_push')) db.exec('ALTER TABLE applicants ADD COLUMN chat_push INTEGER NOT NULL DEFAULT 0');
}
// run_state.opened_at (2026-08-03, metrics layer): when check-in FIRST opened for this run —
// the anchor for "the floor filled in N minutes". Stamped by the two open funnels (setRunOpen /
// setRunStateFor) only when not already set; carried into run_summary at archive, purged with
// the row.
//
// TIMESTAMP CONVENTION (2026-08-04, learned from a P1): any column that participates in
// ARITHMETIC with another timestamp column must share its zone. checkins.created_at is UTC
// (datetime('now')), so opened_at is UTC too — the fill-speed subtraction is the whole reason it
// exists. Self-contained localtime columns (metrics_events.at, run_summary.created_at,
// audit tables) stay localtime and are only ever compared against 'now','localtime'. When adding
// a timestamp column, pick the zone by what it will be SUBTRACTED FROM.
{
  const cols = db.prepare('PRAGMA table_info(run_state)').all().map(c => c.name);
  if (!cols.includes('opened_at')) db.exec('ALTER TABLE run_state ADD COLUMN opened_at TEXT');
  // One-time repair: 2026-08-03 wrote opened_at as localtime while created_at is UTC, inflating
  // every fill-speed pair by the UTC offset — convert the brief window of localtime rows.
  if (!db.prepare("SELECT value FROM app_settings WHERE key='mig_opened_at_utc'").get()) {
    db.exec("UPDATE run_state SET opened_at = datetime(opened_at,'utc') WHERE opened_at IS NOT NULL");
    db.exec("UPDATE run_summary SET opened_at = datetime(opened_at,'utc') WHERE opened_at IS NOT NULL");
    db.prepare("INSERT OR REPLACE INTO app_settings (key,value) VALUES ('mig_opened_at_utc','1')").run();
  }
}
// Scheduled announcements (2026-07-31, F8): pending=1 rows are invisible to every live query and
// fire on the 60s tick when publish_at (local 'YYYY-MM-DDTHH:MM') arrives — archive-the-previous +
// push happen AT that moment, exactly like an immediate post. sched_email carries the "also email"
// choice to fire time. (pk_announcements is a separate legacy table — scheduling covers the
// program-generic `announcements` used by basketball + all mounted programs.)
{
  const anCols = db.prepare('PRAGMA table_info(announcements)').all().map(c => c.name);
  if (!anCols.includes('publish_at')) db.exec('ALTER TABLE announcements ADD COLUMN publish_at TEXT');
  if (!anCols.includes('pending')) db.exec('ALTER TABLE announcements ADD COLUMN pending INTEGER NOT NULL DEFAULT 0');
  if (!anCols.includes('sched_email')) db.exec('ALTER TABLE announcements ADD COLUMN sched_email INTEGER NOT NULL DEFAULT 0');
}
// pco_outbox — queued OUTBOUND writes (profile PATCHes and the like), drained on the 60s tick.
// A PCO outage never blocks a Bridge action; every write is replayable; a row that exhausts its
// retries is closed with last_error + an audit row (fail-loud, never silent). Inert without creds.
db.exec(`
  CREATE TABLE IF NOT EXISTS pco_outbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,              -- 'patch' (Phase 1); future kinds ride the same drain
    email      TEXT NOT NULL,              -- Bridge identity the write is about
    payload    TEXT NOT NULL DEFAULT '{}', -- JSON: fields to write
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_at    INTEGER NOT NULL DEFAULT 0, -- epoch ms gate for retry backoff
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    done_at    TEXT                        -- set on success OR on giving up (see last_error)
  );
  CREATE INDEX IF NOT EXISTS idx_pco_outbox_open ON pco_outbox(done_at, next_at);
`);

// Prune stale magic-link tokens on startup. A token is dead once it's been used
// OR has expired — keeping them forever just grows the table unbounded (a fresh
// row is written on every /login). Unused-and-still-valid tokens are preserved
// so a link someone requested seconds before a restart still works.
{
  const { changes } = db.prepare('DELETE FROM login_tokens WHERE used = 1 OR expires_at < ?')
    .run(Date.now());
  if (changes) console.log(`[db] pruned ${changes} stale login token(s)`);
}
// Keep the audit log from growing without bound — retain the most recent 5000 rows.
// (Reads are LIMIT 40 by PK, so this is purely disk hygiene.)
{
  const { changes } = db.prepare('DELETE FROM audit_log WHERE id < (SELECT MAX(id) - 5000 FROM audit_log)').run();
  if (changes) console.log(`[db] pruned ${changes} old audit-log row(s)`);
}

// A player's email is their identity key across ~a dozen tables. When it changes
// (self-service profile edit OR admin edit) every per-user row must move to the new
// address ATOMICALLY — a partial move (messages carried but votes not) would orphan
// history or silently drop a team member's cast votes. This is the SINGLE source of
// truth for that cascade; both edit handlers call it, so a new email-keyed table is
// added HERE once instead of drifting between two copy-pasted blocks. node:sqlite has
// no better-sqlite3-style .transaction(), so wrap manually and fail-closed on error.
// Run fn() inside one transaction. Exported so a caller can commit an identity edit and its
// rekey cascade together — see rekeyEmailTx.
function transact(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Per-user tables whose PRIMARY KEY includes `email`. A plain UPDATE on these throws
// SQLITE_CONSTRAINT whenever the TARGET address already owns rows — which happens in ordinary
// use: ANY address can magic-link sign in and pick up read-markers/memberships without ever
// being an applicant, and a deleted person's markers outlive the delete. Every one of these is
// per-user *state* (read markers, sit-outs, memberships), so the person doing the migrating
// keeps their own: drop whatever the target address left behind, then carry. Internal constants
// — never user input — so interpolating them into SQL is safe.
const EMAIL_KEYED_TABLES = ['announcement_reads', 'announcement_dismissals', 'regular_optout',
  'group_reads', 'program_membership', 'team_assignments', 'signup_group_members', 'party_members',
  'waiver_records'];   // per-program waivers (F6) — composite (waiver_key,email); target's rows lose, same doctrine as program_membership

// Carry every per-user row from oldEmail to newEmail. Assumes the CALLER already opened a
// transaction, so the `applicants` row update commits atomically with this cascade — a
// half-migrated identity (applicants moved, history left behind) is worse than a rejected edit.
function rekeyEmailTx(oldEmail, newEmail) {
  if (!oldEmail || !newEmail || oldEmail === newEmail) return;
  {
    // Program-generic now: one UPDATE per table covers ALL programs (the pk_* clones are gone).
    // This cascade is program-count-invariant — adding a program adds ZERO lines here.
    db.prepare('UPDATE checkins              SET email=?       WHERE email=?').run(newEmail, oldEmail);
    db.prepare('UPDATE attendance            SET email=?       WHERE email=?').run(newEmail, oldEmail);
    db.prepare('UPDATE votes                 SET voter_email=? WHERE voter_email=?').run(newEmail, oldEmail);
    db.prepare('UPDATE messages              SET from_email=?  WHERE from_email=?').run(newEmail, oldEmail);
    db.prepare('UPDATE messages              SET to_email=?    WHERE to_email=?').run(newEmail, oldEmail);
    db.prepare('UPDATE message_reactions     SET from_email=?  WHERE from_email=?').run(newEmail, oldEmail);
    db.prepare('UPDATE group_messages        SET from_email=?  WHERE from_email=?').run(newEmail, oldEmail);
    db.prepare('UPDATE group_messages        SET pinned_by=?   WHERE pinned_by=?').run(newEmail, oldEmail);
    db.prepare('UPDATE group_reactions       SET from_email=?  WHERE from_email=?').run(newEmail, oldEmail);
    db.prepare('UPDATE push_subscriptions    SET email=?       WHERE email=?').run(newEmail, oldEmail);
    // Ladder results are keyed by email in FOUR player columns — a rename must carry every seat or
    // the standings silently split one person into two duos. Nominations carry both sides (the
    // nominee and the voter); the (program,run_date,voter) PK can collide only if the SAME person
    // nominated under both addresses on one night, so the target's row loses (same doctrine as
    // program_membership) and the migrating identity's pick stands.
    for (const c of ['w1', 'w2', 'l1', 'l2']) {
      db.prepare(`UPDATE ladder_games SET ${c}=? WHERE ${c}=?`).run(newEmail, oldEmail);
    }
    db.prepare(`DELETE FROM ladder_players WHERE email=? AND EXISTS
      (SELECT 1 FROM ladder_players o WHERE o.email=? AND o.program_id=ladder_players.program_id)`)
      .run(newEmail, oldEmail);
    db.prepare('UPDATE ladder_players SET email=? WHERE email=?').run(newEmail, oldEmail);
    db.prepare('UPDATE ladder_nominations SET email=? WHERE email=?').run(newEmail, oldEmail);
    db.prepare(`DELETE FROM ladder_nominations WHERE voter=? AND EXISTS
      (SELECT 1 FROM ladder_nominations o WHERE o.voter=? AND o.program_id=ladder_nominations.program_id
        AND o.run_date=ladder_nominations.run_date)`).run(newEmail, oldEmail);
    db.prepare('UPDATE ladder_nominations SET voter=? WHERE voter=?').run(newEmail, oldEmail);
    // pco_outbox rows are keyed on email but not UNIQUE on it — a plain carry is safe, and the
    // applicants.pco_id link rides the applicants row itself (updated by the caller in this txn).
    db.prepare('UPDATE pco_outbox            SET email=?       WHERE email=?').run(newEmail, oldEmail);
    // Email-keyed per-user state (read markers, sit-outs, per-program membership + auto-renew).
    // Target-address leftovers lose; the migrating person's own state is carried over them.
    for (const t of EMAIL_KEYED_TABLES) {
      db.prepare(`DELETE FROM ${t} WHERE email = ?`).run(newEmail);
      db.prepare(`UPDATE ${t} SET email = ? WHERE email = ?`).run(newEmail, oldEmail);
    }
    // social_edges (Phase 6): a directed graph keyed on BOTH from_email AND to_email, so it can't
    // ride the single-column EMAIL_KEYED_TABLES loop — it needs a bespoke, collision-safe merge.
    // Merging oldEmail INTO newEmail: (1) drop any edge directly between the two addresses (it would
    // become a self-loop after the merge); (2) drop newEmail's rows that would PK-collide with a
    // carried oldEmail row — the migrating person's own edge wins, matching the loop's doctrine above;
    // (3) carry both columns. Steps 1-2 make step 3 collision-free. Correlated-DELETE verified under
    // node:sqlite. (A rare status downgrade — new 'accepted' losing to old 'requested' on a collision —
    // is acceptable on an already-rare identity edit.)
    db.prepare('DELETE FROM social_edges WHERE (from_email=? AND to_email=?) OR (from_email=? AND to_email=?)')
      .run(oldEmail, newEmail, newEmail, oldEmail);
    db.prepare(`DELETE FROM social_edges WHERE from_email=? AND EXISTS
      (SELECT 1 FROM social_edges o WHERE o.from_email=? AND o.to_email=social_edges.to_email AND o.kind=social_edges.kind)`)
      .run(newEmail, oldEmail);
    db.prepare(`DELETE FROM social_edges WHERE to_email=? AND EXISTS
      (SELECT 1 FROM social_edges o WHERE o.to_email=? AND o.from_email=social_edges.from_email AND o.kind=social_edges.kind)`)
      .run(newEmail, oldEmail);
    db.prepare('UPDATE social_edges SET from_email=? WHERE from_email=?').run(newEmail, oldEmail);
    db.prepare('UPDATE social_edges SET to_email=?   WHERE to_email=?').run(newEmail, oldEmail);
    // signup_groups leader (Phase 6b) — leader_email isn't the plain `email` column, so it can't ride
    // the loop above; a straight UPDATE (id is the PK, leader_email non-unique → no collision).
    // The party's MEMBER rows ride the loop via 'signup_group_members'.
    db.prepare('UPDATE signup_groups SET leader_email=? WHERE leader_email=?').run(newEmail, oldEmail);
    // parties (persistent, Friends-tab layer): ONE-PARTY-PER-PERSON invariant — the migrating
    // person's party wins; dissolve any party the TARGET address led, then carry leadership.
    // party_members rides the EMAIL_KEYED_TABLES loop above.
    {
      const tgtLed = db.prepare('SELECT id FROM parties WHERE leader_email=?').all(newEmail).map(r => r.id);
      const oldLeads = !!db.prepare('SELECT 1 FROM parties WHERE leader_email=?').get(oldEmail);
      for (const pid of tgtLed) {
        // SAME-PARTY MERGE: if the old identity's only tie to a target-led party is MEMBERSHIP in
        // it (the row the loop above just carried), the person is consolidating into their own
        // leader seat — drop the self-membership, KEEP the party. A genuine two-party conflict
        // (old also leads one) keeps the doctrine: the migrating person's party wins → dissolve.
        const selfRow = db.prepare('SELECT 1 FROM party_members WHERE party_id=? AND email=?').get(pid, newEmail);
        if (selfRow && !oldLeads) {
          db.prepare('DELETE FROM party_members WHERE party_id=? AND email=?').run(pid, newEmail);
        } else {
          db.prepare('DELETE FROM party_members WHERE party_id=?').run(pid);
          db.prepare('DELETE FROM parties WHERE id=?').run(pid);
        }
      }
      db.prepare('UPDATE parties SET leader_email=? WHERE leader_email=?').run(newEmail, oldEmail);
    }
    db.prepare('UPDATE announcements         SET author=?      WHERE author=?').run(newEmail, oldEmail); // "posted by" resolves to their name
    // Old-address sign-in tokens are INVALIDATED, not carried — they were emailed to an
    // address the person may no longer control, so a lingering valid link/code is a risk.
    db.prepare('UPDATE login_tokens SET used=1 WHERE email=? AND used=0').run(oldEmail);
  }
}

export { DB_PATH, rekeyEmailTx, transact, EMAIL_KEYED_TABLES };
export default db;
