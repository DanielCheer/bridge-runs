# Architecture

The Bridge Runs app is one Node.js process: Express serves server-rendered HTML, a single SQLite
file (`node:sqlite`) holds all state, and a small client script turns the pages into an installable
PWA that patches itself in place by polling. There is no build step, no front-end framework and no
template engine.

## Layers

Plain ES modules in seven layers. **A module imports only from layers below it** (and from its own
layer), so the import graph has no cycles and a reader always knows which way to look.
`test/layers.test.mjs` fails on any upward import, and CI also runs `madge --circular`.

| Layer | Path | May import |
|---|---|---|
| entry | `server.js` | everything below; nothing imports it |
| routes | `routes/` | engine, lib, views, infrastructure, config, other routes |
| engine | `engine/` | lib, views, infrastructure, config, other engine modules |
| lib | `lib/` | views, infrastructure, config |
| infrastructure | `guard.js` `db.js` `db-migrate.js` `auth.js` `mailer.js` `backup.js` `pco.js` | each other, config, `lib/settings.js` |
| views | `views/` | config and other views only: no database, no engine |
| config | `config.js` | `guard.js` only |

Views sit low on purpose: they are pure functions from data to HTML, so routes read the data and
pass it in, and `lib/media.js` and the program loader can hand them their few runtime inputs
(avatar map, program paths, demo mode) through setter seams without a cycle.

## Module map

**Entry and environment**

| Module | What it is |
|---|---|
| `server.js` | The entry (~200 lines): seeds a fresh demo world, builds the app, calls each `mount*(app)` in registration order, wires the injection seams, hydrates the programs, registers the terminal error handler, runs the boot rollover, listens. |
| `config.js` | Every environment variable the app modules read, read once at startup, plus `APP_ROOT`. Imports `guard.js` first, so the isolation check runs before any path default can be seen. The infrastructure modules keep their own reads next to the checks that depend on them. |

**Infrastructure** (unchanged by the split)

| Module | What it is |
|---|---|
| `guard.js` | The startup contract between an isolated instance (a test, or the demo) and production: one `checkIsolation()` for `HARNESS=1` and `DEMO_MODE=1`. See [TESTING.md](TESTING.md) and [DEMO.md](DEMO.md). |
| `db.js`, `db-migrate.js` | Opens the database, creates the schema, runs versioned migrations and boot pruning; exports `db`, `transact`, `rekeyEmailTx`. |
| `auth.js` | Signed, versioned session cookies; `requireLogin` / `requireAdmin` and the approver/council guard factories. |
| `mailer.js` | Magic links, announcements and spot offers over SMTP; dev mode prints links. |
| `pco.js` | Planning Center sync. See [PCO-SYNC-PHASE1-SPEC.md](PCO-SYNC-PHASE1-SPEC.md). |
| `backup.js` | Encrypted `VACUUM INTO` snapshots at boot and daily (`writeEncryptedSnapshot`, also behind the admin download); records `last_backup_at` / `last_backup_error` and calls the injected `onFailure` (an admin push) when backups start failing. |

**`lib/`** — shared helpers with no domain knowledge

| Module | What it is |
|---|---|
| `settings.js` | `getSetting` / `setSetting` / `delSetting` over `app_settings` (also used by `pco.js` and `backup.js`), and `getSecret` / `setSecret` for the credentials kept there, sealed at rest; the plain accessors refuse those keys. |
| `audit.js` | `audit()` (with the never-pruned key-event mirror), `metric()`, the daily audit-log trim. |
| `email.js` | `isValidEmail` (the only gate before the mailer) and `lc` (email normalisation). |
| `rate-limit.js` | In-memory sliding-window `rateLimited()` and its hourly prune. |
| `push.js` | The VAPID keypair (`initPush()` at boot) and `sendPush()`. |
| `sign-in.js` | `signIn()` (session plus the admin sign-in ping) and `createLoginLink()`. |
| `dates.js` | Local-calendar helpers (`ymdLocal`, `shiftYmd`, weekday labels, clock labels) and `schedNow()`, the scheduler clock `TEST_NOW` pins. |
| `http.js` | `mountHttpBasics(app)`: `trust proxy` from `TRUST_PROXY` (so `req.ip` is the per-IP rate-limit key), security headers including the CSP subset, compression, body/cookie parsing, the iOS form-POST redirect shim; `safeNextPath`. |
| `media.js` | Uploads: parsers, magic-byte sniffing, server-named writes (`serverFileName`: owner id plus 128 random bits), safe deletes, retention, banner paths, stickers, the avatar map. Creates its directories on import. |
| `at-rest-crypto.js` | The one at-rest scheme (AES-256-GCM `enc1:`, key HKDF-derived from `SESSION_SECRET`, one salt per use). |
| `dm-crypto.js` | DM at-rest encryption (`dmEnc` / `dmDec`) on that scheme. |
| `csv.js` | CSV cell encoding with formula-injection neutralised. |
| `demo-world.js` | The fixture world module, imported only in demo mode. |

**`engine/`** — the domain, bottom to top

| Module | What it is |
|---|---|
| `applicants.js` | Account lookups, age and `isMinor`, the approved population, the council's approver pool and vote tally. |
| `programs.js` | The program registry (`PROGRAMS`, `P(id)`), each program's clock (run date, season, open/cancelled state, start/end times), membership and hosts, `programGate`, banners, door mode. |
| `basketball-calendar.js` | Program 1's capacities (with `reloadRunSettings`, their only writer), standing day with per-week host overrides, season gate, open/cancelled/locked state. |
| `announcements.js` | Latest posts, the bell panel and unread markers, broadcast audiences, scheduled posts and their precise-fire timer. |
| `waivers.js` | The club-wide attestation stamp and per-program waivers with guardian consent. |
| `seating.js` | The unified seating engine: `partitionFor` (floor / offered / waitlist), party packing, the waitlist offer cycle (`createOffer`, expiry, re-offer), promotion pings, the run summary. |
| `parties.js` | Per-night queue-with-friends groups and persistent Friends-tab parties. |
| `social.js` | Friends, follows and blocks over `social_edges`; `canMessage`; directory search. |
| `chat.js` | Program chat rooms: loading, membership, unread and mention counts, read markers, pushes, the chat gate, `/poll` fingerprints. |
| `messages.js` | Direct messages: unread count, inbox, new-message push. |
| `ladder.js` | `runNightFor` (the night a program's routes act on), ladder roster, standings, nominations, headcount. |
| `teams.js` | Teams and games: assignment, party-aware fill, the board data, results and standings. |
| `renewals.js` | Auto-renew seating and the no-show penalty. |
| `roster-sync.js` | Reconciling a run's Planning Center registrations into `run_roster`. |
| `run-engine.js` | The program-generic weekly engine: each program's scheduler step, the rollover, removing a player with the offer it triggers, season changes. |
| `basketball.js` | Program 1's weekly engine: `loadRun`, `ensureWeek`, `autoRunState`, `autoJoinTeam`. |
| `council.js` | `recomputeStatus`: the status change when votes reach the threshold, including releasing a rejected player's seats. |
| `builtin-programs.js` | `PROGRAM_DEFS` for programs 1, 2, 3 and 90, and the generic unread / hub-card / tick factories. |
| `program-loader.js` | `buildPrograms()` (from `PROGRAM_DEFS` or a program row's JSON spec), the in-app program themes, the slug rules. |
| `demo-run.js` | Demo program 90's showcase: `seedDemoRun()`. |
| `scheduler.js` | `startScheduler()`: the 60-second tick and the announcement timer. |

`PROGRAM_DEFS[1]` calls the basketball engine, which calls `P()`. Keeping the registry
(`programs.js`) at the bottom and the definitions (`builtin-programs.js`) and loader near the top is
what keeps that relationship one-directional.

**`routes/`** — the HTTP surface, one module per area. Each exports `mount*(app)` functions that
register routes exactly where `server.js` calls them.

| Module | Routes |
|---|---|
| `guards.js` | Not routes: `requireApprover`, `requireCouncil`, `requirePlayer`, `mutedOut`. |
| `public.js` | Static mounts, `/sw.js`, `/app.js`, the waiver QR, the sliding session, `/manifest.webmanifest`; `/` and `/apply`; policy pages; `/invite/:token`. |
| `auth.js` | `/login`, `/auth`, `/login/code`, `/logout`, `/status`. |
| `demo.js` | Demo mode (`/demo/login`, `/demo/reset`) and the program-90 controls (`/admin/demo/*`). |
| `announcements.js`, `push.js`, `waivers.js` | `/announce*`, `/push/*`, `/waiver`. |
| `runs.js` | The runs hub `/runs` and past rosters. |
| `checkin.js` | Basketball under `/checkin`, its actions, the claim link, `/run.ics`, `/season`. |
| `poll.js` | `/poll`, the read-only fingerprint. |
| `profile.js`, `messages.js`, `friends.js`, `chat.js` | `/u/:id`, `/profile*`; `/messages*`; `/friends*` and parties; `/chat*`, `/pickleball/chat*`, `/players/search`, and the generic `runChat*` handlers. |
| `admin.js` | `/admin*` (council, settings, run day, banners, roles, people, exports, analytics, audit, history), `/debug/geo`. |
| `kiosk.js`, `programs-admin.js`, `pco.js` | `/kiosk/*`; `/admin/programs*`; `/admin/pco*` and `/pco/webhook`. |
| `run-routes.js` | The generic run handlers, `mountRunProgram` (one program's routes under its own path), the inline routes of programs 1 and 2, `mountPendingPrograms`. |
| `run-teams.js`, `run-ladder.js` | The teams-board, games and leaderboard handlers; the ladder handlers. |
| `health.js`, `test-seams.js`, `errors.js` | `/healthz`; the test-only `/admin/test/*`; the terminal error handler. |

**`views/`** — `index.js` is the public surface every importer uses.

| Module | What it is |
|---|---|
| `util.js` | `esc()` and the date/time labels. |
| `components.js` | Icons, avatars (`setAvatarMap`), badges, the bell, the tab bar and nav (`setProgramMeta`), onboarding cards, follow buttons. |
| `chat-ui.js` | Bubbles, the composer and its script, stickers, the lightbox and voice player, the press-and-hold menu, the chat room fragment. |
| `shell.js` | `HEAD` (styles, splash, client bootstrap, install wall, demo strip), header, footers, and `BUILD_VER`: the newest mtime over `views/**/*.js` and `public/styles.css`, which `/poll` returns so open apps reload after a deploy. |
| `client-app.js` | `APP_JS`, the browser engine served at `/app.js` (router, poll-and-patch, push, badges). |
| `pages/*.js` | One module per page family: intake, login, invite, checkin, chat, profile, friends, runs-hub, run, messages, admin, analytics, kiosk, programs, pco, people, legal, misc, ladder, teams. |

Other paths: `public/` (static assets), `legal/` (policy Markdown), `scripts/` (operator and test
tools; `app-env.mjs` is the one list of the app's environment variables that every launcher strips
from a child's environment), `fixtures/world.mjs` (the synthetic world), `test/`,
`.github/workflows/ci.yml`, `ops/windows/` (self-hosting).

## Request flow

1. `mountHttpBasics`: security headers (the CSP subset, `X-Frame-Options: DENY`, `nosniff`,
   referrer and permissions policy, HSTS on HTTPS; see [SECURITY.md](SECURITY.md)), compression, urlencoded and cookie parsing, then the iOS
   form-POST fix (a non-fetch form POST that redirects gets a 200 page that redirects on the
   client, because a 302 after a native form POST blanks a home-screen PWA on iOS).
2. `mountAssets`: `/avatars` (public: the kiosk shows avatars without a cookie) and `/chat-media`
   (signed-in only, `private` cache), both overridable directories with immutable names, mounted
   **before** the public static so an override wins, `/sw.js`, `/app.js` (immutable, `?v=BUILD_VER`),
   `/waiver-qr.svg`, `public/`, then the sliding session and activity stamp.
3. The route modules, in the order `server.js` mounts them. `test/routes.test.mjs` pins the whole
   stack (every layer, its order and each route's middleware chain) against
   `test/snapshots/routes.txt`.
4. `mountPendingPrograms`: routes for every program beyond basketball and pickleball, after
   `buildPrograms()`.
5. `registerTerminalError`, last, so a throw in any route (including routes mounted from program
   config) is logged and answered instead of crashing the process. A program created at runtime
   re-appends it after its routes.

Pages are complete HTML documents. Live pages call `GET /poll` every ~10 s; it returns a small
fingerprint (and `BUILD_VER`) with **zero writes**, and the client re-fetches and patches only the
region that changed, or reloads when a deploy changed `BUILD_VER`.

## Programs

Every run (basketball, pickleball, volleyball, the demo program, programs created in-app) is an
entry in the in-memory `PROGRAMS` registry, hydrated at boot by `buildPrograms()` from the
`program` table plus `PROGRAM_DEFS` for the code-defined ones. Code reads the registry
(`P(id).config`) instead of branching on program ids, so a new run is a new registry entry and its
features (teams, ladder, offer windows, penalties, waivers) are config flags.

**Why pickleball keeps an inline route list.** Programs 3 and up get their routes from
`mountRunProgram`; basketball (`/checkin`) and pickleball (`/pickleball`) predate it and keep
inline routes. Mounting pickleball through the factory as well (`p.id >= 2`) was checked against the
route snapshot and is **not** equivalent: the factory would add 18 routes pickleball doesn't have
today (`/requests`, `/claim/:token`, the team, game, leaderboard, roster-sync, penalty-clear and
party check-in routes), add a `USE /pickleball` path guard, replace pickleball's own `GET
/pickleball/season` handler (its own season board, gated by `pkChatGate`) with the generic
`runGetSeason`, and register all of it at the end of the stack instead of where pickleball's
chat, banner and run routes sit today. Retiring the inline list is therefore a behaviour change to
make deliberately (deciding which of those routes pickleball should gain), not a refactor.

## Background work

Timers run in-process. `engine/scheduler.js` owns:

- a **60-second tick**: each program's own `tick()` (weekly rollover, auto open/lock, expiring
  waitlist offers and promoting the next person), scheduled announcements, the Planning Center
  outbox;
- the precise-fire timer for a pending scheduled announcement.

`server.js` runs the boot rollover (`ensureWeek`) after `buildPrograms()`, and, once listening, the
daily database snapshot, chat-media and audit-log pruning and the Planning Center delta poll.

Test instances drive time through `TEST_NOW` and `POST /admin/test/tick` (both refused on the
production port by `guard.js`) instead of waiting on real timers.

## Data

One SQLite file (WAL mode), opened synchronously through `node:sqlite`. The main tables:

- people and access: `applicants`, `votes`, `invites`, `login_tokens`, `program_membership`,
  `waiver_records`, `social_edges`;
- runs: `program`, `run_state`, `run_overrides`, `checkins`, `run_roster`, `attendance`,
  `run_summary`, `team_assignments`, `run_games`, `ladder_*`, `parties`, `signup_groups`;
- messaging: `group_messages`, `messages` (DMs, encrypted at rest), reactions, read markers,
  `announcements`, `push_subscriptions`;
- operations: `app_settings`, `audit_log` (newest 5,000), `audit_key_events` (never pruned),
  `metrics_events`, `geo_reports`, `pco_outbox`.

**Never `await` between a read and the write that depends on it.** Every database call is
synchronous, and Node runs one request's synchronous code to completion before starting another,
so a check-then-write with no `await` in between (is there a free seat? then insert the check-in)
cannot interleave with another request. An `await` between the two (for a network call, a file
write, a timer) hands control to other requests, and the read is stale by the time the write runs:
two people can take the last seat. Do outward work before the read or after the write, or wrap the
read and write in `transact()` with no `await` inside. At the time of the split, every `await` in
the app is network or file work (Planning Center, mail, QR rendering, image processing and writes)
placed before the reads that depend on it or after the writes; the profile-photo upload re-reads
the current photo after its awaits for exactly this reason. Keep it that way.

What is kept, for how long, and how it is deleted: [PII-RETENTION.md](PII-RETENTION.md). What
protects it (sessions, encryption at rest, backups, headers, capability URLs) and the known gaps:
[SECURITY.md](SECURITY.md).
