# Releases

Every deploy to live gets a row here and an annotated git tag (`rel-YYYYMMDD-HHMM`), written by
`./release.sh "summary"` after the deploy is verified. **Reverting** = `git checkout <tag>` (the
launcher boots the working tree, so checking out a tag and restarting IS the rollback), plus — if
data must roll back too — `node restore-backup.mjs backups/<snapshot>.db.enc bridge.db` with the
server stopped. Code tags and DB snapshots are deliberately independent: most rollbacks want old
code with CURRENT data.

Backfilled below from git history for the releases that shipped before this file existed.

| Date (local) | Tag | Commit | Summary |
|---|---|---|---|
| 2026-07-31 | rel-20260731-1957 | e93faae | Kiosk arrivals — door screens overlay live PCO Check-Ins taps (IN chips, building tally, walk-ins); /admin/pco toggle, inert without creds; pco-fn 128/128 + full regression |
| 2026-07-31 | rel-20260731-1727 | db09db0 | Waitlist pings, analytics dashboard, gym kiosk, scheduled announcements — approved queue complete |
| 2026-07-31 | rel-20260731-1718 | 47b4630 | Program hosts + enforced join modes (request/approve flow); off-site backup mirror; PII one-pager |
| 2026-07-31 | rel-20260731-1550 | 0b53e23 | Security batch: revocable sessions + admin sign-in alerts, security headers, healthz, key-event audit, npm audit clean, desktop push |
| 2026-07-31 | rel-20260731-1415 | 465276c | SW coverage (cache contract + offline card in CDP) + nav geometry rig (24 invariants, decision table, pinch-zoom) + release tagging |
| 2026-07-31 | rel-20260731-1410 | 64a13ed | Encrypted backups + delta-audit fixes (door-mode late sweep, reconcile UTC window, sweep lock, org invalidation) |
| 2026-07-31 | rel-20260731-A *(retro)* | ffb66aa | Encrypted backups (AES-256-GCM + tested restore) + all 15 findings from the 2-day delta audit (door-mode late-sweep P1, reconcile UTC-window P1, sweep lock, org-change invalidation, outbox grace, skip lists) |
| 2026-07-31 | — | 3085ed8 | Nav localizer (device geometry capture + decision tree); client-bundle parse gate |
| 2026-07-31 | — | 1a8fbe4 | Orange Back button on admin pages; nav bar positions by measurement (superseded by localizer plan) |
| 2026-07-31 | — | db838a1+baa19c3 | Test isolation enforced at boot (guard.js); harness sanitizer; port registry |
| 2026-07-31 | — | 4f880b2+80499c9 | OAuth hardening (single-flight refresh, PKCE, 403 semantics, pacing) + daily keep-alive; test-fixture push purge |
| 2026-07-31 | — | c943e8b | PCO OAuth connect flow (church authorizes; no secret changes hands) |
| 2026-07-31 | — | 1e4919f | Admin can confirm a physically-signed waiver as verified (audited) |
| 2026-07-31 | — | 35943cd | Waiver as permanent verifiable record; PCO custom fields split into waiver + attendance sets |
| 2026-07-31 | — | cafeb94 | PCO Phase 2: attendance scoreboard on People profiles |
| 2026-07-31 | — | 54f92d0 | Self-serve programs hardening (XSS, pk/vb namespace hijack, error-handler ordering) |
| 2026-07-31 | — | 986e0fb | Self-serve program creation from the app (no deploy) |
| 2026-07-30 | — | df7b4ba | PCO Phase 2b: door mode, Check-Ins reconciliation, door-pass QRs |
| 2026-07-30 | — | c0e46cf | PCO Phase 1: People identity sync (link/create/patch, webhook, delta poll) |

*(History before 2026-07-30 — demo prep, volleyball, parties, confirm flow, audits 1–3 — is in
`git log`; memory file `bridge-runs-features-added` narrates it.)*
