# The Bridge Adv Runs

Two things in one small web app:

1. **Application form** (`/`) — public. Anyone can apply to the Adv Run. Collects name, phone, email, level, where they've played, and waiver confirmation.
2. **Friday check-in** (`/checkin`) — approved players sign in with their email and tap **I'm in**. Caps at 15, everyone after goes on a waitlist that auto-promotes when someone drops.
3. **Council review** (`/admin`) — admins only. Approve / clear-for-tryout / reject applicants.

The waiver QR shown on the form and the check-in page is generated from `WAIVER_URL` (served at `/waiver-qr.svg`); with it unset, the waiver QR/link section is not shown.

---

## How the flow works (the design you chose)

- Someone fills out the **form** → they're `pending`.
- The **council** reviews in `/admin`. The form is a *low bar* — it should rarely reject anyone. Its job is to catch obvious non-fits and collect contact + waiver, not to judge skill.
- Council taps **Clear for tryout** → player can now check in, and shows a yellow **TRYOUT** tag on the floor list so you know who to watch.
- After they've played and you've seen them, tap **Approve** → permanent spot.
- **Play decides the ceiling. The form is just the front door.**

Only `approved` and `tryout` players can check in. `pending` and `rejected` can't.

## Managing people (admin-only)

`/admin` → **Manage people** opens a full directory (`/admin/people`):
- **Search** by name, email, or phone.
- **Add a pre-approved player** — type name/phone/email, they're created as approved, skipping the form AND the vote. Use this for people you already know meet the bar. If the email already exists, it just approves that record instead of duplicating. **The email must be the exact one they'll sign in with**, or they're locked out.
- **Edit** anyone's name, phone, or email inline (email changes are checked for collisions and synced to any active check-in).
- **Delete** a person — removes their record, check-ins, and votes. Confirmation required.
- **Copy all numbers** — one tap copies every approved player's "Name: phone" to your clipboard for pasting into the group chat.

This screen is admin-only. Team approvers can't reach it.

## Unapproved players can't see the check-in

A logged-in player who isn't approved (pending, rejected, or no record) is redirected off `/checkin` to a plain `/status` page showing only their standing. They can't see the run, the count, the roster, or the join button. Only approved players (and admins running it) reach the check-in.

## Approving applicants: unanimous vote

Applicants are decided by a **team vote with a fixed threshold**: **3 approvals** gets someone in, **3 rejects** blocks them, anything less stays pending. The admin (you) does **not** vote — you have oversight and manage people, but decisions belong to the team. Team members are auto-approved and skip the vote.

The threshold is set by `VOTE_THRESHOLD` (default 3). Raise it as the team grows. Note: you need at least `VOTE_THRESHOLD` team members voting or nobody can ever reach it — don't let the team shrink below the threshold.

- Each applicant card in `/admin` shows a live tally (e.g. "2/3 approved") and Approve/Reject buttons for you. You can change your vote; status recomputes instantly.
- **Approved** the moment every approver has voted approve. **Rejected** the moment anyone votes reject. Otherwise **pending**.
- Admins see a "Waiting on: [names]" line so you can chase approvers who haven't voted — because under unanimity, one person who never votes leaves an applicant stuck pending forever.
- **Team members are auto-approved** and skip the vote entirely (making someone team sets them approved). They can't be voted on.
- You can't vote on your own application. Admin can **Reset votes** to send an applicant back to pending for a re-vote.
- Only **approved** players can check in. There's no "tryout" backdoor — the vote is the only way in (besides being team).

**Two things to keep in mind about unanimity:**
1. There is no hardcoded "3." The threshold is *every current approver*. Add a 4th (a 3rd team member) and now 4 must agree. If you want exactly 3 deciders, keep the pool at 3.
2. Unanimity's failure mode is limbo, not rejection. One approver who never logs in = an applicant stuck pending indefinitely. Watch the "waiting on" list.

## Who can approve applicants (two power levels)

**Admin** — set by the `ADMIN_EMAILS` env var. Full control: approve, reject, assign roles, open/close runs, remove players, and view the audit log.

**Team approver** — any player flagged **◆ Team** can approve/reject applicants AND run the floor: open/close the run, see the players list (with names), and remove or bump players. They're your co-runners for when you're not there. What team **cannot** do stays locked to admin: delete a person from the database, edit anyone's contact info, assign roles, reset votes, or open the People-management screen. So a team member can fully run a Friday without you, but can't erase the member list or hand out roles. Every team action is checked against the database per request and recorded in the audit log with their name.

## Audit log

Every status change, role change, run open/close, and player removal is recorded with who did it, their role, the action, the target, and a timestamp. The log shows on the `/admin` page — **admin-only** (team approvers don't see it). Last 40 entries. This is how you answer "who rejected that guy?" on Monday.

## Late Core & Friday 4pm release

A Core member who joins **after** you open the run (didn't pre-register) is a *late regular* — they go on the **waitlist**, not the floor, so the open-phase floor spots stay reserved for Approved players. From **Friday 4pm** onward, if the floor still has open spots, held late-Core are released and move onto the floor automatically (normals had all week and the open window to claim them first).

## Guests

On the check-in page, operators (admin/team) have an **Add a guest** box for last-minute additions — type a name, they're dropped onto the run for that Friday (floor if there's room, waitlist if not). Guests show a **Guest** tag in the roster and don't need an application or login. Subject to the same 20-person hard cap.

## Weekly reset & regular cap

**Midnight reset:** the active run is the coming Friday. It stays on that Friday all day; at **Saturday 00:00** it rolls to the next Friday, the old week's check-ins and opt-outs are purged, and Core can immediately start pre-joining the new week.

**Pre-register cap:** while the run is closed, **team + Core combined** can hold at most `PREREG_CAP` (default 10) of the 15 floor spots — so at least 5 spots are always reserved for Approved players. Regulars pre-register through the week (you'll typically open the run to everyone around Wednesday evening). Once the pre-register total hits 12, extra Core can't lock a spot early, but they can still join once you open check-in to everyone — and if normals don't claim the reserved spots, whoever taps first gets them.

## Roles: Team and Core

Two roles, set per player in `/admin` (only approved/tryout players can hold one):

**◆ Team** — people who help run it.
- **Auto-renew:** each team member can toggle whether they get a guaranteed floor spot every week. ON (default) = auto-added each Friday. OFF = not auto-added; they join manually when they want to play. (Separate from "sit out this week," which is a one-off skip for an auto-renew-on member.)
- Auto-added to the floor with **top priority** the moment you open the run. If pre-access joiners already filled the cap, the newest of them is bumped to the waitlist rather than a team member.
- Get a **Sit out this week** button to clear their own auto-seat; the opt-out sticks for that Friday across close/reopen.
- Still fully removable by admins.

**★ Core** — trusted core with pre-access.
- Can tap **I'm in (early access)** and join while the run is still closed to everyone else.
- No auto-join, no held seat. If they don't act, they get nothing — the role is a head start, not a reservation.

**Count visibility:** while the run is closed, the player count is hidden (shows a dash) from Approved players. Admins, team, and Core — the people who can act on it — still see the real number. Once you open, everyone sees the count.

Rejecting a player strips both roles automatically.

## Opening and closing the run

You manually control when people can join. On the check-in page (as admin) there's an **Open check-in / Close check-in** toggle.

- Every new Friday starts **CLOSED** — nobody can join until you open it. This stops people piling in before you've said go.
- While **closed**: players see "Check-in isn't open yet" and no join button. Anyone already checked in can still drop out. The join lock is enforced on the server, so it can't be bypassed.
- While **open**: approved/tryout players get the "I'm in" button.
- Close it again any time (e.g. once you've got your 15 and don't want more waitlist churn).

---

## Requirements

- **Node.js 22 or newer** (uses the built-in SQLite — nothing to compile, no build tools). Check with `node --version`. If you're below 22, install the latest LTS from nodejs.org.

## Try the demo

```bash
git clone https://github.com/DanielCheer/bridge-runs && cd bridge-runs
npm ci
npm run demo
```

Open http://localhost:3100 and pick a persona (organizer, team, council, core player, regular
player, pending applicant). Everything is fictional and resets every 6 hours. Details:
[docs/DEMO.md](docs/DEMO.md). There's also a `Dockerfile` that runs the same thing.

## Run it locally (test first)

```bash
npm install
ADMIN_EMAILS="your@email.com" npm start
```

Open http://localhost:3000. With no email configured it runs in **DEV MODE** — sign-in links print to the terminal instead of being emailed, so you can test the whole thing solo.

---

## Environment variables

Copy `.env.example` to `.env` and fill in, OR set them inline. The app reads plain env vars (there's no dotenv loader wired in — on Render you set these in the dashboard; locally, prefix the command or use `export`).

| Var | What it does | Required? |
|---|---|---|
| `ADMIN_EMAILS` | Comma-separated admin emails. These get `/admin`. | **Yes** |
| `SESSION_SECRET` | Random string that signs login cookies. | **Yes** (any long random string) |
| `PUBLIC_URL` | Your real public URL, e.g. `https://desktop-xyz.tailXXXX.ts.net`. Used to build the magic link. | Yes once public |
| `RUN_CAP` | Player cap. Default `15`. | No |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Email sending. See below. | Yes for real email |
| `DB_PATH` | Where the SQLite file lives. Default: next to the code. | No |

Generate a session secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Email (magic-link sign-in)

Sign-in needs to send email. Easiest free option is **Gmail with an App Password**:

1. Turn on 2-Step Verification on your Google account.
2. Go to Google Account → Security → App passwords → create one for "Mail".
3. Set:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=youraddress@gmail.com
   SMTP_PASS=the-16-char-app-password
   SMTP_FROM=youraddress@gmail.com
   ```

Gmail free sends to anyone, ~500/day — way more than 15 players need. (Any other SMTP provider works too.)

---

## Option A — Run on your PC via Tailscale Funnel (recommended for you)

You already have Tailscale. Funnel exposes your local app to the public internet over HTTPS, hides your home IP, and gives players a normal link — no Render cold-starts, no port forwarding.

**One-time tailnet setup** (in the Tailscale admin console at login.tailscale.com):
1. DNS → enable **MagicDNS**.
2. DNS → **Enable HTTPS** certificates.
3. Access Controls → make sure your device can use Funnel. Add to the policy file if needed:
   ```json
   "nodeAttrs": [
     { "target": ["autogroup:member"], "attr": ["funnel"] }
   ]
   ```

**Every time you host:**
```bash
# 1. start the app (with your env vars set)
npm start

# 2. in another terminal, expose port 3000 to the public internet
tailscale funnel 3000
```

Tailscale prints your public URL, like:
```
https://your-machine.tailXXXX.ts.net/
```
Set that as `PUBLIC_URL` (restart the app so magic links use it), then paste the link into your group chat. **Your PC has to be on and running the app while people are checking in** — fine for a Friday night.

To run Funnel in the background so it survives terminal close: `tailscale funnel --bg 3000`. Turn it off with `tailscale funnel 3000 off`.

> Note: Funnel does **not** add any login itself — that's why the app has its own magic-link sign-in. Don't rely on Tailscale for auth here.

---

## Option B — Host it free on Render (always-on link)

1. Push this folder to a GitHub repo.
2. On render.com → New → **Web Service** → connect the repo.
3. Build command: `npm install` · Start command: `npm start`.
4. Add a **Disk** (e.g. 1 GB) mounted at `/data`, and set `DB_PATH=/data/bridge.db` so data survives deploys.
5. Set all the env vars from the table above (`PUBLIC_URL` = the `onrender.com` URL Render gives you).

Caveat: Render's free tier **sleeps after 15 min idle**, so the first person to open it after a quiet spell waits ~30s for cold start. Fine for a scheduled run.

---

## Data / admin notes

- Everything lives in one SQLite file (`bridge.db` by default). Back it up by copying that file.
- The "run" is automatically the **next Friday**. After Friday 11pm it rolls to the following week. Each Friday starts with an empty check-in list.
- To reset all data: stop the app, delete `bridge.db` (and `bridge.db-wal` / `-shm` if present), restart.

## Files

```
server.js     routes + logic
db.js         database + schema
auth.js       magic-link sessions, admin/login guards
mailer.js     email sending (SMTP or dev-console)
views.js      the HTML pages
public/
  styles.css  the look
```

## Auto-open on Wednesday night (optional — not enabled)

Right now you open each run manually by tapping **Open check-in**. The player-facing copy says "opens Wednesday night," so you must actually tap it Wednesday and announce it, or the copy is a lie.

If you'd rather it open itself every Wednesday at a set time, that's a scheduled job (a few lines using node-cron calling `setRunOpen(nextFriday(), true)` at, say, Wed 8pm). Not built — ask for it if you want the timing enforced by code instead of by you remembering.

## Operational notes

**Timezone:** the Friday date and the after-11pm rollover use the server's local time. Run the app on a machine set to your local timezone (Eastern), or the run could roll to the next week at the wrong moment.

**Sign-in emails:** magic links expire in 15 minutes, and requesting a new one invalidates the old. If a player says their link doesn't work, have them request a fresh one from the sign-in page. They must use the exact email they applied with. When you approve someone, grab the sign-in link from the People screen ("Copy sign-in link") and send it to them — approval doesn't notify anyone automatically.
