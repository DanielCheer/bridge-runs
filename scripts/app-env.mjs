// app-env.mjs — the environment variables the app reads, as one prefix list, for every process
// that launches the app on someone else's environment: the test harness (test/helpers/app.mjs),
// the guard and demo tests, and the demo supervisor (scripts/run-demo.mjs). Each one starts its
// child from the parent's environment MINUS these, so a developer's exported SMTP, Planning Center
// or database settings can never leak into a test or demo instance; it then adds back only the
// variables it means to set.
//
// Keep it a superset of what config.js, guard.js, db.js, auth.js, mailer.js, backup.js and pco.js
// read. A variable missing here would pass straight through to every isolated child.
export const APP_ENV_KEYS = /^(HARNESS|DEMO_|PORT|DB_PATH|BACKUP_|CHAT_|AVATAR|BANNER|PK_|PCO_|SMTP_|SESSION_|COOKIE_|ADMIN_|PUBLIC_URL|ENABLE_TEST_TICK|TEST_NOW|FORCE_HELD_RELEASED|ALLOW_INSECURE_SESSION|RUN_CAP|WAITLIST_CAP|PREREG_CAP|REGULAR_CAP|VOTE_THRESHOLD|OFFER_WINDOW_HOURS|WAIVER_URL|LEGAL_)/;

// `env` without any app variable.
export function withoutAppEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !APP_ENV_KEYS.test(k)));
}
