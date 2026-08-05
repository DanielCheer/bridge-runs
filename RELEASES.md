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
| 2026-08-05 | rel-20260805-1115 | cdb9733 | Audit round 5: Slate contrast sweep — link token (peach), white-on-accent twins, teal/muted lifts, kiosk greens tokenized; per-program kiosk token now retires the legacy global |
| 2026-08-05 | rel-20260805-0912 | ba07108 | Basketball kiosk link controls on /checkin (mint/rotate + screen link — parity with pickleball/volleyball) |
| 2026-08-05 | rel-20260805-0851 | 1737153 | Slate: pickleball/volleyball accents get light variants (were invisible on slate) + kiosk rows show profile photos |
| 2026-08-05 | rel-20260805-0836 | 4e923ea | Dark theme much lighter (slate #364765/#465878) + renamed Midnight to Slate (key unchanged — existing picks carry over) |
| 2026-08-05 | rel-20260805-0824 | 2e59b2d | Midnight lightened to slate navy (#1B2740) — owner report: too dark; all touchpoints (splash, chrome tint, picker swatch, bubbles, composer) moved together |
| 2026-08-04 | rel-20260804-1614 | 298bdae | Audit round 4: Classic composer background restored (P1), Midnight readability sweep (bubbles, cream buttons, banners, splash, kiosk, chrome tint), scheduler txn + ordering + harness guard, router race token + back-swipe fix, teams floor-check, watchdog port guard |
| 2026-08-04 | rel-20260804-1537 | 27b3951 | Back pill on Council + People (→ Check-in) — every tabbed screen now has an up-path |
| 2026-08-04 | rel-20260804-1526 | 6f4e4cc | Midnight is navy now (#111827, softer dark) + composer strip and DM top bar themed (the dark-input-on-light-strip fix) |
| 2026-08-04 | rel-20260804-1518 | 43da9f4 | Themes trimmed to Classic + Midnight (removed the three too-similar lights; stale choices fall back to Classic) |
| 2026-08-04 | rel-20260804-1503 | 974e023 | User themes: Classic + Midnight + Soft Glass + Porcelain + Paper, per-device picker on Profile (pre-paint html-class bootstrap, var-driven skins; QR whites preserved) — verified via real-app themed screenshots, full CDP + suites green |
| 2026-08-04 | rel-20260804-1425 | 82d7700 | View-transition overlap fix — masthead unpinned (top bars differ per page; only the identical opaque tab bar stays frozen) |
| 2026-08-04 | rel-20260804-1419 | fd9bcda | Soft page transitions — navigation swaps crossfade (View Transitions API; chrome pinned still, polls/forms stay instant, reduced-motion + old-browser fallback) |
| 2026-08-04 | rel-20260804-1407 | a43b297 | Back button = fixed hierarchy climb (run→hub, admin tools→People), never history.back — kills the run↔chat ping-pong |
| 2026-08-04 | rel-20260804-1357 | db6ae85 | Guests are team-assignable — teamFloor + unassigned panel include the whole floor (a post-close guest could never get a chair) |
| 2026-08-04 | rel-20260804-1346 | 698e320 | Scheduled announcements fire at the exact instant (armed timer + boot re-arm, 60s tick as net; verified +0.40s on a real clock) |
| 2026-08-04 | rel-20260804-1339 | 480a77c | NAV BUG RESOLVED via first device capture — stuck-visual-viewport gate (keyboard-plausibility) + geometry 29/29 pins both sides; team seats are floor-only (waitlist slide loses the chair, self-heal at read); localizer doc updated |
| 2026-08-04 | rel-20260804-1329 | 6bac6ad | Demo-kiosk 'Not found' fixed (static programs never offer/mint kiosk tokens; orphan token removed) + chat room header pinned while scrolling (back always reachable) — program-fn 88, chat suites + CDP green |
| 2026-08-04 | rel-20260804-1157 | 3253a69 | Five audit proposals: /admin/history run browser + CSV, per-kind notification open rates (SW v3 tag pass-through), per-program kiosk tokens w/ host minting, last-active chips on People, metrics retention policy — board green (metrics-fn 32, program-fn 86) |
| 2026-08-04 | rel-20260804-1037 | e4b0d09 | Audit batch: F8 scheduling fixed (was broken since ship) + scheduled-post manage/cancel, UTC fill-speed + migration, join-mode enforcement closed, program-agnostic suspend/reject cascade, delete cascade + metrics tables, F4 on all shift paths, kiosk + PCO arrivals hardening, metric rate limits — board 15 suites + CDP + tour green |
| 2026-08-03 | rel-20260803-1702 | c75a730 | Tour drive rig (player 8 + admin 17 steps, 12/12) + tour state in the masthead capture — device break not reproducible in Chromium, capture armed per never-guess policy |
| 2026-08-03 | rel-20260803-1650 | b893e34 | Chat rooms: back chevron in the room header → the room's run page (all programs); DM threads already had one; CDP 52/52 + chat suites green |
| 2026-08-03 | rel-20260803-1643 | b0b1f67 | Sheet backdrops fully transparent — the stuck grey shadow is removed for good (owner decision); tap-to-close + drag unchanged; CDP 52/52 |
| 2026-08-03 | rel-20260803-1601 | 1431c7d | Metrics layer — run_summary at archive (demand/fill-speed/offers), identity-free metrics_events (push/tap/install/join), last-seen actives, analytics pulse + demand lines; SW v2; metrics-fn 23/23 + full board |
| 2026-07-31 | rel-20260731-2049 | 0c332c2 | Audit-record viewer (/admin/audit + filtered CSV), F4 pings on all four waitlist-shifting paths, clearRunParties atomic — full board green (14 suites + CDP) |
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
