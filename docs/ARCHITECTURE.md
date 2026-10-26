# Architecture

The Bridge Runs app is one Node.js process: Express serves server-rendered HTML, a single SQLite
file (`node:sqlite`) holds all state, and a small client script turns the pages into an installable
PWA that patches itself in place by polling. There is no build step, no front-end framework and no
template engine.

> This map describes the code as it is today. `server.js` and `views.js` are large single files;
> splitting them into `lib/`, `engine/`, `routes/` and `views/` modules is planned, and this
> document will be updated with the new layout when that happens.

## File map

| Path | What it is |
|---|---|
| `server.js` | The Express app: middleware, every route, the run engine (check-ins, waitlist offers, seating, teams, ladder, parties, chat, announcements), background timers, and boot. Sections are delimited by `// ---------- NAME ----------` banners. |
| `views.js` | Every page as a template-literal function (`esc()` for escaping), plus `APP_JS`, the client engine served at `/app.js` (router, poll-and-patch, push, badges). Exports `BUILD_VER`, the newest mtime of `views.js`/`styles.css`. |
| `db.js` | Opens the database, creates the schema (`CREATE TABLE IF NOT EXISTS` plus guarded `ALTER`s), runs migrations, boot-time pruning, and exports `db`, `transact`, `rekeyEmailTx`. |
| `db-migrate.js` | Versioned, all-or-nothing schema migrations keyed on `PRAGMA user_version`. |
| `guard.js` | The startup contract between a test instance and production. Imported first by `db.js`, so no entry point can skip it. See [TESTING.md](TESTING.md). |
| `auth.js` | Signed session cookies (HMAC, versioned for "sign out everywhere"), `requireLogin` / `requireAdmin` / approver and council guards. |
| `mailer.js` | Magic links, announcements and spot offers over SMTP; with no SMTP configured, links print to the console (dev mode). |
| `pco.js` | Planning Center sync: identity link, outbox, webhook, delta poll, custom fields, Check-Ins reconciliation. See [PCO-SYNC-PHASE1-SPEC.md](PCO-SYNC-PHASE1-SPEC.md). |
| `backup.js` | Encrypted (AES-256-GCM) `VACUUM INTO` snapshots at boot and daily, keeping the newest `BACKUP_KEEP`. |
| `public/` | Static assets: `styles.css`, `sw.js` (conservative service worker), icons, fonts, stickers, banners, demo media. |
| `legal/` | Markdown for `/privacy`, `/terms`, `/conduct`, rendered with the operator's contact details from env. |

## Request flow

1. **Security headers**: `X-Frame-Options: DENY`, `nosniff`, referrer and permissions policy, HSTS
   on HTTPS.
2. **compression**, **urlencoded** body parsing, **cookie-parser**.
3. **iOS form-POST fix**: a non-fetch form POST that redirects gets a 200 page that redirects on
   the client, because a 302 after a native form POST blanks a home-screen PWA on iOS.
4. **Static mounts**: `/avatars` and `/chat-media` (overridable directories, immutable names),
   `/sw.js`, `/app.js` (immutable, `?v=BUILD_VER`), `/waiver-qr.svg`, then `public/`.
5. **Sliding session + activity stamp**: a valid cookie is re-issued, and `last_seen_at` is touched
   at most once per local day.
6. **Routes**: public (apply, login, legal, invite), member (check-in, runs, chat, messages,
   profile, friends), admin/council (review, people, programs, announcements, analytics, audit,
   kiosk, Planning Center), and `/poll`.
7. **Terminal error handler**, registered last, so a throw in any route (including routes mounted
   from program config) is logged and answered instead of crashing the process.

Pages are complete HTML documents. Live pages call `GET /poll` every ~10 s; it returns a small
fingerprint (and `BUILD_VER`) with **zero writes**, and the client re-fetches and patches only the
region that changed, or reloads when a deploy changed `BUILD_VER`.

## Programs

Every run (basketball, pickleball, volleyball, a demo program, programs created in-app) is an entry
in the in-memory `PROGRAMS` registry, hydrated at boot from the `program` table plus per-program
presentation in `PROGRAM_DEFS`. Code reads the registry (`P(id).config`) instead of branching on
program ids, so a new run is a new registry entry and its features (teams, ladder, offer windows,
penalties, waivers) are config flags.

## Background work

All timers live in `server.js` and run in-process:

- a **60-second tick**: each program's own `tick()` (weekly rollover, auto open/lock, expiring
  waitlist offers and promoting the next person), scheduled announcements, the Planning Center
  outbox;
- the **weekly rollover** (`ensureWeek`): archive the finished run into `attendance` and
  `run_summary`, purge check-ins, auto-seat renewers;
- **daily**: database snapshot, chat-media and audit-log pruning, Planning Center delta poll.

Test instances drive time through `TEST_NOW` and `POST /admin/test/tick` (both refused on the
production port by `guard.js`) instead of waiting on real timers.

## Data

One SQLite file (WAL mode). The main tables:

- people and access: `applicants`, `votes`, `invites`, `login_tokens`, `program_membership`,
  `waiver_records`, `social_edges`;
- runs: `program`, `run_state`, `run_overrides`, `checkins`, `run_roster`, `attendance`,
  `run_summary`, `team_assignments`, `run_games`, `ladder_*`, `parties`, `signup_groups`;
- messaging: `group_messages`, `messages` (DMs, encrypted at rest), reactions, read markers,
  `announcements`, `push_subscriptions`;
- operations: `app_settings`, `audit_log` (newest 5,000), `audit_key_events` (never pruned),
  `metrics_events`, `geo_reports`, `pco_outbox`.

What is kept, for how long, and how it is deleted: [PII-RETENTION.md](PII-RETENTION.md).
