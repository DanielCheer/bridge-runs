# Planning Center sync: People ⇄ Bridge

How the app (`pco.js`) talks to [Planning Center](https://www.planningcenter.com/) (PCO), the
church-management system the organization already uses. Phase 1 is the identity link; Phase 2 and
2b reuse the same plumbing for attendance fields and the door check-in station.

The whole integration is **inert until an admin stores credentials on `/admin/pco`**, and all
network work happens on the 60-second tick, the daily poll, or an explicit admin action, never
inline with a member's request, so a PCO outage can't slow down or block anything a player does.

## Goal

**PCO People stays the system of record for identity.** Bridge reads it (members don't
re-register) and writes back (new Bridge members appear in People automatically). Per-run rosters
stay canonical in Bridge: PCO's Check-Ins and Groups attendance are not writable through its API
by anyone, so nothing here pretends otherwise.

## Auth

Two ways in, same capabilities (`pcoAuthMode()`):

- **Personal Access Token**: an app id + secret a PCO admin generates. One-minute setup; it acts
  as that person, so it can die with their account. Good for a pilot.
- **OAuth 2.0**: the organization authorizes the app from Planning Center's own screen. No secret
  is sent to us, the grant belongs to the organization, and they can revoke it from their
  connected-apps list. Access tokens last 2 hours and are refreshed automatically; refresh tokens
  rotate on every use. OAuth wins whenever it is configured.

Credentials live in `app_settings` (runtime-entered by an admin), never in `.env` and never in the
repo. Database snapshots are encrypted at rest (`backup.js`), and `guard.js` refuses to boot a test
instance whose database carries any `pco_*` setting. Scope: `people` (plus `check_ins` read for
Phase 2b).

## Rate limits and transport

- PCO allows 100 requests per 20 seconds per token. Calls are paced (`PCO_PACE_MS`, default 250 ms)
  and paginated at `per_page=100`.
- JSON:API v2 (`/people/v2/...`). A 429 waits for `Retry-After`; other failures go to the outbox's
  retry with linear backoff (`PCO_RETRY_BASE_MS`), then fail loudly after 5 attempts.
- `PCO_API_BASE` overrides the API host; the test suite points it at a local mock.

## Data mapping

| Bridge (`applicants`) | PCO People | Direction | Notes |
|---|---|---|---|
| `email` | person → emails (primary) | match key | lowercased both sides |
| `full_name` | `first_name` + `last_name` | ⇄ | split on the last space; PCO's name wins inbound |
| `phone` | phone_numbers (primary) | Bridge → PCO | inbound deliberately skipped so a stale PCO number can't overwrite one a member just fixed |
| `dob` | `birthdate` | ⇄ | drives the under-18 safeguarding gate; inbound fills it for existing members |
| `pco_id` | person `id` | | the durable link once matched |
| games attended / last attended / programs | custom field data | Bridge → PCO (Phase 2) | field definitions are created automatically |

Synthetic identities (`@guest.local` guests and `@demo.local` demo players) are never synced.

## Flows

### Initial link (admin-triggered)
1. Admin connects PCO, then "Match People now" pages through `GET /people/v2/people?include=emails`.
2. Matches to `applicants` by case-folded email and stores `pco_id`.
3. The report shows matched, Bridge-only (offer "create in PCO") and PCO-only (informational; the
   app never mass-creates Bridge accounts from the directory).
4. Approved Bridge-only members can be created in PCO in one action.

### Outbound (Bridge → PCO)
- On member approval: match by email before creating, so it is idempotent.
- On profile edit (name/phone): PATCH the linked person (`pcoQueuePatch`).
- Every write goes through the `pco_outbox` table, drained on the 60-second tick, so an outage
  never blocks a Bridge action and every write is replayable. Exhausted retries close the row and
  write an audit entry; nothing fails silently.

### Inbound (PCO → Bridge)
- **Webhook** at `/pco/webhook`, verified with HMAC-SHA256 against the stored webhook secret,
  applies the linked member's name and birthdate. PCO wins for those identity fields.
- **Daily delta poll** (`updated_at >= last poll`) covers any webhook gap, and doubles as the
  OAuth keep-alive (a refresh only happens inside an API call).
- A PCO-side delete never deletes a Bridge account.

### Phase 2: attendance into custom fields
On the weekly rollover, linked attendees' field values (games attended, last attended, programs)
are pushed, and only when their signature changed.

### Phase 2b: Check-Ins at the door (read side)
- **Reconciliation:** after a run, Bridge reads the event's check-ins and classifies each person:
  signed up and tapped in, confirmed but no door tap, or door tap without a signup.
- **Door passes:** each member can show a QR their organization's Check-Ins station scans. Bridge
  exports a barcode CSV for PCO's People import and reads passes back to verify the link.
- **Door mode:** when the door tap is the attendance of record, the confirm step is turned off.
- Automating the station itself (scripting PCO's UI) is ruled out on purpose.

### Weekly roster from Registrations
For a run whose signup happens in Planning Center, `pcoSignupRosterForDate` reads the matching
signup (by name prefix and event date) and the weekly roster sync seeds `run_roster` from it.

## Edge cases (decided up front)

- **Duplicate emails in PCO:** link the first active person; flag the rest in the admin report.
- **Email change in Bridge:** the rekey carries `pco_id`; the next PATCH updates PCO's email.
- **Token revoked / refresh expired:** the outbox pauses, the admin page shows a reconnect banner,
  admins get a push notification, and an audit row is written.

## What is NOT built, on purpose

- Writing attendance into Check-Ins or Groups: PCO's API doesn't allow it for any integration.
- Mass-creating Bridge accounts from the whole directory: membership stays invite-driven.

