// config.js — the application's environment, read once at startup, plus APP_ROOT.
//
// Every process.env read made by the app modules (server.js, lib/, engine/, routes/, views/) lives
// here, so the full set of knobs is one file and nothing reads the environment at request time.
// The infrastructure modules keep their own reads next to the check that depends on them:
// guard.js (the isolation contract), db.js (DB_PATH), auth.js (SESSION_SECRET, ADMIN_EMAILS,
// COOKIE_INSECURE), mailer.js (SMTP_*), backup.js (BACKUP_*) and pco.js (PCO_*).
//
// Path defaults resolve against APP_ROOT (this file's directory), never the working directory.
// guard.js refuses an isolated instance (HARNESS=1 / DEMO_MODE=1) whose path variables are unset or
// point inside APP_ROOT, so the defaults below are production's. That check runs when guard.js is
// first imported, so it is imported here first: no module can see a path from this file before the
// isolation contract has been enforced.
import './guard.js';
import path from 'path';
import { fileURLToPath } from 'url';

export const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const PORT = process.env.PORT || 3000;
// The public origin for links in messages (claim links, invite and sign-in QR codes, OAuth
// redirect). Empty → each caller falls back to the request's own host.
export const PUBLIC_URL = process.env.PUBLIC_URL || '';

// Basketball run capacities: the env values are the defaults; a host can override them in-app
// (app_settings, applied by reloadRunSettings()).
export const CAP_ENV = Number(process.env.RUN_CAP || 15);
export const WAITLIST_CAP_ENV = Number(process.env.WAITLIST_CAP || 5);
export const PREREG_CAP_ENV = Number(process.env.PREREG_CAP || process.env.REGULAR_CAP || 10);
export const VOTE_THRESHOLD = Number(process.env.VOTE_THRESHOLD || 3); // approvals to get in / rejects to block
// Waitlist offer-and-confirm window. SINGLE source of truth, env-overridable so the
// owner can lower it (e.g. to 1h) without a code change — ms is derived from it.
export const OFFER_WINDOW_HOURS = Number(process.env.OFFER_WINDOW_HOURS || 3);
// Pickleball capacities.
export const PK_CAP = Number(process.env.PK_CAP || 20), PK_WAIT = Number(process.env.PK_WAIT || 4);

// Upload and media locations (each overridable so a test or the demo never touches live files).
export const AVATARS_DIR = process.env.AVATARS_DIR || path.join(APP_ROOT, 'public', 'avatars');
export const CHAT_MEDIA_DIR = process.env.CHAT_MEDIA_DIR || path.join(APP_ROOT, 'public', 'chat-media');
export const CHAT_VIDEO_MAX_MB = Number(process.env.CHAT_VIDEO_MAX_MB || 40);   // server cap, mirrored by the client
export const BANNER_DIR = process.env.BANNER_DIR || path.join(APP_ROOT, 'public');
export const BANNER_PATH_ENV = process.env.BANNER_PATH;
export const PK_BANNER_PATH_ENV = process.env.PK_BANNER_PATH;
// /admin/export/db writes its temporary snapshot beside the backups.
export const EXPORT_TMP_DIR = process.env.BACKUP_DIR || path.join(APP_ROOT, 'backups');

// The at-rest keys (DM bodies, secrets in app_settings: lib/at-rest-crypto.js) are derived from the
// session secret (auth.js makes SESSION_SECRET mandatory outside ALLOW_INSECURE_SESSION); the
// fallback matches auth.js's. Rotating SESSION_SECRET makes everything sealed under it unreadable.
export const AT_REST_KEY_SECRET = process.env.SESSION_SECRET || 'CHANGE_ME_dev_secret_do_not_ship';
// Web Push contact (VAPID subject).
export const PUSH_CONTACT_EMAIL = process.env.SMTP_FROM || process.env.SMTP_USER || 'admin@localhost';
// Shown in the boot log only; auth.js parses the list itself.
export const ADMIN_EMAILS_ENV = process.env.ADMIN_EMAILS;

// The external waiver form. Unset → no QR/link section anywhere and /waiver-qr.svg is a 404 (no
// organization's real form is a built-in default).
export const WAIVER_URL = process.env.WAIVER_URL || '';
// One seeded avatar (the host's) mapped by email to /avatars/daniel.jpg. Unset → none.
export const AVATAR_SEED_EMAIL = process.env.AVATAR_SEED_EMAIL || '';

// Who the policy pages name as the operator/contact. Unset → the [PLACEHOLDER] stays visible
// on the page (honest about missing config) rather than a made-up value.
export const LEGAL_ENV = { date: 'LEGAL_EFFECTIVE_DATE', name: 'LEGAL_CONTACT_NAME', email: 'LEGAL_CONTACT_EMAIL' };
export const LEGAL = Object.fromEntries(Object.entries(LEGAL_ENV).map(([k, env]) => [k, process.env[env]]));
// Where the policy Markdown lives (privacy-policy.md, terms-of-use.md, code-of-conduct.md). Read once
// at boot, so an edit needs a restart.
export const LEGAL_DIR = process.env.LEGAL_DIR || path.join(APP_ROOT, 'legal');

// Demo mode tuning (DEMO_MODE itself is read by guard.js, which enforces its isolation).
export const DEMO_RESET_HOURS = Number(process.env.DEMO_RESET_HOURS || 6);
// One reset per minute: each reset restarts the process, so a minimum uptime IS the rate limit.
export const DEMO_RESET_COOLDOWN_MS = Number(process.env.DEMO_RESET_COOLDOWN_S ?? 60) * 1000;

// Test-only seams; guard.js refuses every one of them on the production port.
export const TEST_NOW = (process.env.TEST_NOW && !isNaN(new Date(process.env.TEST_NOW).getTime())) ? new Date(process.env.TEST_NOW).getTime() : null;
export const ENABLE_TEST_TICK = process.env.ENABLE_TEST_TICK === '1';
export const FORCE_HELD_RELEASED = process.env.FORCE_HELD_RELEASED === '1';
