# Personal information: what the app keeps, for how long, and how it is removed

Plain answers to "what do you hold about our people?", written for the organization that runs the
app. It follows the principles of Canadian privacy law (PIPEDA): consent, limited collection,
safeguards, openness. The numbers below are the ones the code enforces; each names where.

## What is collected, and why

| Data | Why it exists | Where it lives |
|---|---|---|
| Name, email, phone | Identify the member; sign-in links; contact between organizers and players | App database |
| Date of birth (optional until a program requires it) | The under-18 safeguarding rule (no 1-on-1 DMs with a known minor) | App database |
| Waiver attestation + dates | "Cleared to play": who confirmed, when, and whether it was verified against the organization's own record | App database |
| Per-program waiver records | A program with its own waiver (e.g. a youth run) keeps its own signed record per member, with the same lifecycle as the main waiver | App database |
| Parent/guardian name, phone, email | Collected ONLY when a minor joins a program that requires guardian consent; the guardian attests on that program's waiver | App database (on the member's record and the program waiver record) |
| Attendance history | Rosters, season boards, the organization's reporting | App database (plus summary custom fields in the organization's own Planning Center, if connected) |
| Chat messages, photos, voice/video notes | The run's group chat and DMs, features members use knowingly. DMs are encrypted at rest | Database + media files on disk |
| Profile photo | Optional, member-uploaded | Media files on disk |
| Push subscription | Spot offers and announcements to the member's own device; revocable in browser settings | App database |

**Not collected:** payment data, precise location, analytics/tracking identifiers, contacts, or
anything from third-party accounts. Sign-in is by emailed link or code; no passwords are stored.

## How long it is kept

- **Membership data (name, contact, waiver, attendance):** for the life of the membership.
  Attendance is the organization's operational record; nothing expires automatically while the
  person is a member. Guardian contact details and per-program waiver records follow the same rule
  and are erased with the member's account (and a deleted program's own waiver records are erased
  with the program).
- **Sign-in links/codes:** used or expired ones are purged at every backup and at startup.
- **Chat media (photos/voice/video):** pruned after one year, at boot and daily (`pruneOldMedia`
  in `server.js`).
- **Operational log:** trimmed to the newest 5,000 entries (`pruneAuditLog`). A small permanent
  ledger (`audit_key_events`) keeps only organizationally significant events: waiver
  confirmations, role changes, account approvals/removals, admin sign-ins.
- **Backups:** the newest 14 encrypted snapshots (`BACKUP_KEEP`, default 14, about two weeks);
  older ones are deleted automatically. Snapshots are AES-256-GCM encrypted and the key is stored
  separately (`backup.js`), so an off-site copy is ciphertext to whoever holds it.
- **Usage statistics:** the app keeps a small set of *aggregate* numbers about how the runs are
  used: per-run totals in `run_summary` (how many played, how many waited, how fast the floor
  filled, offer outcomes) and anonymous product events in `metrics_events`. These contain **no
  names, emails, or messages**. The one personal element is a coarse "last active" date on each
  member's own record (updated at most once per day), deleted with the account like everything
  else on that record.
- **Usage-statistics lifecycle (planned, applied when reached):** per-run summary rows (a few
  dozen per year, anonymous) are kept indefinitely as the attendance-trend record. Individual
  product events are kept **13 months** for year-over-year comparison, then collapsed into monthly
  totals and the individual rows deleted. The first rows reach that age in late 2027; the rollup
  is built then (see the note on `metrics_events` in `db.js`).

## How removal works

- **An organizer can remove a member** (People → Delete). This is a hard delete: profile,
  check-ins, attendance history, votes, chat messages and their media files, photo, read-markers,
  memberships, and any pending sync writes, cascaded in one action. The member's Planning Center
  record (the organization's own system) is never touched by a delete here.
- **Members can edit their own** name, phone, email, and photo at any time; an email change
  carries the whole history to the new address.
- **Backups age out** on the 14-snapshot schedule, so a deleted member leaves the backup horizon
  within about two weeks.

## Safeguards, in one paragraph

Data lives in a single SQLite database on a machine the operator controls, reachable only over
HTTPS. Sessions are signed and revocable ("Sign out everywhere"), and admin sign-ins alert the
admin's own devices. Backups are encrypted at rest with a tested restore path
(`restore-backup.mjs`, including tamper rejection). The Planning Center connection, when
enabled, uses the organization's own authorization, can be revoked by them at any time, and syncs
only the directory fields listed above; attendance detail stays in the app. Test instances are
structurally prevented from touching real member data or devices (`guard.js`).

## Who to ask

Data questions or removal requests go to the app administrator listed on the `/privacy` page
(`LEGAL_CONTACT_NAME` / `LEGAL_CONTACT_EMAIL`).
