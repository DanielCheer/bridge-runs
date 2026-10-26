# Operator guide

How to host the app and run it week to week. This is the part of the old README written for the
person running the programs; the README itself is now about the code. Behaviour described here is
the code's as of the `portfolio-cleanup` branch. Everything is configured through environment
variables; [`.env.example`](../.env.example) lists all of them with their defaults.

## Hosting

**Requirements:** Node.js 22.13 or newer (the app uses the built-in `node:sqlite`, so there is
nothing to compile). Copy `.env.example` to `.env` and set at least `ADMIN_EMAILS`,
`SESSION_SECRET` and `PUBLIC_URL`. `npm start` loads `.env` when it exists.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # a SESSION_SECRET
npm ci
npm start                                                                   # http://localhost:3000
```

With no SMTP settings the app runs in **dev mode**: sign-in links and codes print to the terminal
(and show on the page) instead of being emailed, so you can try everything alone.

**Email.** Any SMTP provider works. With Gmail: turn on 2-Step Verification, create an App
Password (Google Account → Security → App passwords), and set `SMTP_HOST=smtp.gmail.com`,
`SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASS` (the app password) and optionally `SMTP_FROM`. A free
Gmail account sends about 500 messages a day.

**Public HTTPS with Tailscale Funnel.** Funnel publishes a local port on a
`https://<machine>.<tailnet>.ts.net/` address without port forwarding and without exposing the
home IP. In the Tailscale admin console, enable MagicDNS and HTTPS certificates and allow Funnel
for the device in the policy file. Then:

```bash
tailscale funnel --bg 3000        # off again: tailscale funnel 3000 off
```

Set `PUBLIC_URL` to the address Funnel prints and restart, so magic links, claim links and QR
codes point at it. Funnel adds no login of its own; the app's sign-in is the only gate. Funnel is
one proxy hop, which is the `TRUST_PROXY` default (see [SECURITY.md](SECURITY.md#rate-limits)).

**Keeping it running on Windows.** [`ops/windows/`](../ops/windows/) holds the supervision used in
production:

- `install-autostart.ps1` (run once, as administrator) registers a logon task that starts the
  launcher, and a watchdog task every 5 minutes;
- `start-bridge.cmd` is the launcher: it restarts `node server.js` a few seconds after any exit;
- `watchdog.ps1` restarts the launcher only when `/healthz` is down **and** no launcher is
  running, and logs what it did to `watchdog.log`.

Pair it with an external uptime monitor on `/healthz`: nothing on the machine can see a Funnel or
internet outage.

**Timezone.** Run dates, the weekly rollover and the run-day cutoffs use the server's local time.
Host on a machine set to the programs' timezone.

## Roles

| Role | How it's set | What it can do |
|---|---|---|
| Admin | `ADMIN_EMAILS` | Everything: people, roles, programs, settings, exports, audit, analytics. Voting on applicants belongs to the council. |
| Team (◆) | Admin, on the People screen | Runs the floor: open and close check-in, add guests, remove or bump players, the teams board. Auto-seated each week while their auto-renew is on. Cannot delete people, edit contact details or hand out roles. |
| Pillar (★, "core" in code) | Admin | Early access: can join while check-in is still closed, within `PREREG_CAP`. No reserved seat. |
| Council | Admin | Votes on applicants, and nothing else. |
| Host | Admin, per program | Runs a program's night without the admin's people and settings powers. |

Every role change, status change, removal and open/close is written to the audit log with who did
it. Admins see the latest entries on `/admin` and the full, filterable record at `/admin/audit`.

## Applicants and the council vote

Anyone can apply through the public form; they start as **pending**. Council members vote on the
council screen. `VOTE_THRESHOLD` approvals (default 3) admit an applicant; the same number of
rejects blocks them; anything less stays pending. Only votes from current council members count,
so keep at least `VOTE_THRESHOLD` people on the council, or nobody can ever be decided. An admin
can reset an applicant's votes for a re-vote. A rejected player is taken off every floor, and
their spot is offered to the next person on the waitlist.

People you already know can skip the form: **People → Add a player** creates an approved account
(or a one-time invite link when you don't have all of their details). The email must be the one
they will sign in with.

## Run night

- A new week starts **closed**. Open check-in from the run page when you announce it; close it
  again whenever you like. The join lock is enforced on the server.
- While closed, Team (auto-seated) and Pillars (early joins) together hold at most `PREREG_CAP`
  floor spots, so the rest stay open for everyone else.
- A Pillar who joins after you open goes to the waitlist; from 4 pm on run day any still-open floor
  spots are released to them.
- When someone leaves the floor, the spot is **offered** to the top of the waitlist by push
  notification and email, with a one-time claim link valid for `OFFER_WINDOW_HOURS` (default 3).
  If the offer expires, the next person gets it.
- **+ Guest** on the run page adds a walk-in by name (floor if there's room, waitlist if not). Guests
  need no account.
- The door screen (`/kiosk/<program>`) is a read-only roster opened with a token link you mint on
  the run page; regenerate the link to revoke it.

## People, exports and backups

`/admin/people` is the directory: search, edit contact details, change roles, delete (a hard,
cascading delete; see [PII-RETENTION.md](PII-RETENTION.md)), and copy every approved player's
number. `/admin/export` downloads attendance CSVs and an encrypted database backup.

Encrypted snapshots are written at boot and daily to `BACKUP_DIR`, under the key in
`BACKUP_KEY_FILE`; keep a copy of the key somewhere other than the snapshots. Restore with the
server stopped:

```bash
node scripts/restore-backup.mjs backups/<snapshot>.db.enc restored.db [backup.key]
```

[RELEASES.md](../RELEASES.md) describes rolling back code with the release tags.

## Sign-in problems

Sign-in is by emailed link or 6-digit code, valid for 15 minutes; requesting a new one retires the
old one. A member who can't get in should request a fresh code and use the exact email on their
record (an admin can correct it on the People screen). "Sign out everywhere" on the Profile tab
revokes every session a member has.
