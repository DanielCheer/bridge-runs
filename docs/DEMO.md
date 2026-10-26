# The demo

`DEMO_MODE=1` runs the real application on a fictional world, for anyone to click through. It is
the same code as production: the same routes, run engine, chat and admin screens. Three things are
added on top: a persona picker on `/login`, a strip on every page ("Demo — fictional data, resets
every 6 hours · GitHub ↗"), and a reset.

## Run it

```bash
npm ci
npm run demo                                    # http://localhost:3100
node scripts/run-demo.mjs --port 3100 --data /some/empty/folder
docker build -t bridge-runs-demo . && docker run --rm -p 3100:3100 bridge-runs-demo
```

Use `localhost` rather than a LAN address. The session cookie is `Secure`, and browsers only
accept a `Secure` cookie over plain HTTP from `localhost`.

## Personas

`/login` lists one fictional account per kind of viewer. Picking one signs you in as that person
(`POST /demo/login`); the list in `fixtures/world.mjs` (`DEMO_PERSONAS`) is the only set of
accounts the picker can sign into.

| Persona | Who | Try |
|---|---|---|
| Organizer | the admin (`ADMIN_EMAILS`) | `/admin` (review, people, programs, analytics, audit), the waitlist showcase below, `/kiosk/90` |
| Team member | the org team | the teams board, approving applicants |
| Council voter | votes on applicants | the council screen at `/admin` |
| Core player | a regular with early access | joining a run before it opens to everyone |
| Regular player | an approved player with friends and a party | runs, chat (photos, voice notes, video, stickers), DMs, profile |
| Pending applicant | applied, not yet approved | the "application in review" status page |

The normal email sign-in stays under the picker. The demo has no SMTP, so the 6-digit code is shown
on screen instead of being emailed (the app's existing DEV MODE path).

### The waitlist showcase (Organizer)

Program 90 ("DEMO — Live Waitlist") runs the real offer engine on synthetic players:

1. Open `/demo` (on `/runs` its card is marked Hidden: only admins see it) and press
   **↻ Reset full run** in the "Demo mode" box: a full floor, a waitlist, parties, teams and chat.
2. **Remove** a player under "Who's going". The engine immediately offers the spot to the top of
   the waitlist, exactly as it would on a real night (they show as **⏳ Claiming**).
3. Press **✓ Claim**: the player slides onto the floor.
4. **📺 Kiosk screen** (`/kiosk/90`) shows the same roster as the door screen.

## Reset

The world is wiped and reseeded:

- every `DEMO_RESET_HOURS` (default 6): the server exits on a timer;
- when the Organizer presses **Reset** (the link in the strip, `GET`/`POST /demo/reset`). Only the
  organizer can, at most once a minute (`DEMO_RESET_COOLDOWN_S`, default 60). Each reset restarts the
  process, so a minimum uptime is the rate limit.

A reset is a clean process exit. `scripts/run-demo.mjs` is a small supervisor: on every start it
empties its data folder (database, backups and key, chat uploads, avatars, banners), starts
`node server.js` with `DEMO_MODE=1`, and waits. The server finds an empty database and seeds the
synthetic world (`seedWorld()` from `fixtures/world.mjs`, the same world the tests use), so every
lap begins from the same state, and nothing anyone posted or uploaded survives it. Each start
also gets a new random `SESSION_SECRET`, so everyone is signed out.

The supervisor only wipes a folder it owns: an empty one, or one carrying its `.bridge-runs-demo`
marker. Any other folder is refused, not deleted. If the server crashes it is restarted on a clean
world after 5 seconds, and the supervisor gives up after 5 crashes in a minute. A guard refusal
(exit 90) stops it immediately.

## Why it can't touch real data

The demo is an isolated instance under the same contract as the tests. `guard.js` runs one check,
`checkIsolation()`, for `HARNESS=1` and `DEMO_MODE=1` alike (see [TESTING.md](TESTING.md)). The
process refuses to start (exit 90, naming the variable) unless:

- the database, backups, backup key, uploads, avatars and banners are all set and resolve outside
  the app directory, so it can't open `bridge.db` or reach `backups/` or `backup.key`;
- `PORT` is set and isn't 3000;
- `PCO_API_BASE` isn't Planning Center (the supervisor points it at a closed local port);
- `SMTP_HOST` is unset or loopback.

Once the database is open, a demo also refuses any database holding someone outside the fixture
domain (`@test.local`). A copy of a real database fails this check wherever it lives, even though
it passes the path checks.

Nothing goes out. Mail runs in DEV mode, Planning Center can't be reached, and backups are
encrypted into the demo's own folder with its own key. Web Push works only for a visitor who opts
in on their own device.

## Limits

- Anyone can apply through the public form or post in chat. What they enter is visible to other
  visitors until the next reset. Don't put real personal details in the demo.
- Program 90's showcase starts empty after each reset; the organizer seeds it from `/demo`.
- Policy pages show `[PLACEHOLDER]` contact details (no `LEGAL_*` variables are set).
