// guard.js — the enforced boundary between a TEST instance and PRODUCTION.
//
// WHY: the harness boots THIS app from THIS directory against a COPY of the live database, with
// isolation supplied entirely by environment overrides. Every default in the app points at
// production (the live DB file, live media/avatar/banner/backup directories, port 3000 which
// Tailscale Funnel publishes, and the real api.planningcenteronline.com), so ONE forgotten override
// means a test quietly operating on real data or real people. That is not a hypothetical: a test
// run once paged the owner's phone through real push subscriptions carried in the copied database.
//
// So isolation stops being "each runner remembered" and becomes a startup contract:
//   HARNESS=1  → every outward path MUST be redirected somewhere safe, or the process refuses to
//                start and says exactly which variable is wrong.
//   production → the test-only seams (clock override, forced ticks, insecure cookies) are refused,
//                so a harness-shaped instance can never own the public port.
//
// Imported as the FIRST statement of db.js, which every entry point loads before touching any
// state — including before the database file is opened. A new script cannot forget it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = process.env.HARNESS === '1';
const PROD_PCO_HOST = 'planningcenteronline.com';

const die = (lines) => {
  console.error('\n[guard] REFUSING TO START — test isolation is not safe:\n');
  for (const l of lines) console.error('  • ' + l);
  console.error('\n[guard] Fix the environment (see docs/TESTING.md) and re-run.\n');
  process.exit(90);
};

// Is `p` inside the live application directory (i.e. would writing it touch the real deployment)?
function insideApp(p) {
  const abs = path.resolve(APP_DIR, p);
  const rel = path.relative(APP_DIR, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

if (HARNESS) {
  const problems = [];
  const port = Number(process.env.PORT || 3000);
  if (!process.env.PORT) problems.push('PORT is unset — a harness instance must never bind 3000 (the public Funnel port).');
  else if (port === 3000) problems.push('PORT=3000 is the live/published port. Use a harness port.');

  // Writable paths: every one of these has a production default inside this directory.
  for (const [key, why] of [
    ['DB_PATH', 'the live database'],
    ['BACKUP_DIR', 'the live backup folder (its prune would delete real snapshots)'],
    ['CHAT_MEDIA_DIR', 'live chat uploads'],
    ['AVATARS_DIR', 'live profile photos'],
    ['BANNER_DIR', 'live run banner images'],
  ]) {
    const v = process.env[key];
    if (!v) problems.push(`${key} is unset — it defaults to ${why}.`);
    else if (insideApp(v)) problems.push(`${key}="${v}" resolves inside the live app directory (${why}).`);
  }

  // External API: PCO credentials live in the DATABASE, so a copied DB can hold real ones. Talking
  // to production PCO from a test would create/rename real people and can rotate the live token.
  const api = process.env.PCO_API_BASE;
  if (!api) problems.push('PCO_API_BASE is unset — it defaults to the REAL Planning Center API.');
  else {
    let host = '';
    try { host = new URL(api).hostname; } catch { problems.push(`PCO_API_BASE="${api}" is not a valid URL.`); }
    if (host && (host === PROD_PCO_HOST || host.endsWith('.' + PROD_PCO_HOST)))
      problems.push(`PCO_API_BASE points at production Planning Center (${host}).`);
  }

  // Mail: must be unroutable. The real .env carries working Gmail credentials.
  const smtp = process.env.SMTP_HOST;
  if (smtp && !['127.0.0.1', 'localhost', '::1'].includes(smtp))
    problems.push(`SMTP_HOST="${smtp}" is not loopback — a test could send real email.`);

  if (problems.length) die(problems);
} else {
  // Production side: refuse the test-only seams so a misconfigured harness run can never become
  // the public instance (Funnel forwards whatever owns port 3000).
  const seams = ['HARNESS', 'ENABLE_TEST_TICK', 'TEST_NOW', 'FORCE_HELD_RELEASED', 'COOKIE_INSECURE']
    .filter(k => process.env[k]);
  const port = Number(process.env.PORT || 3000);
  if (seams.length && port === 3000)
    die([`Test-only settings are present on the live port 3000: ${seams.join(', ')}.`,
         'Either set HARNESS=1 with a harness port, or remove these from the environment.']);
}

// Fixture invariants, checked AFTER the database is open (db.js calls this immediately). The env
// checks above can't see what a copied DB carries: real push subscriptions, real PCO tokens. A copy
// that skipped scripts/sanitize-db.mjs dies here instead of reaching someone's phone.
export function assertFixtureSanitized(db) {
  if (!HARNESS) return;
  const problems = [];
  const count = (sql) => { try { return db.prepare(sql).get().n; } catch { return 0; } };
  const subs = count('SELECT COUNT(*) n FROM push_subscriptions');
  if (subs) problems.push(`${subs} real push subscription(s) in the test database — they point at real devices.`);
  const pco = count("SELECT COUNT(*) n FROM app_settings WHERE key LIKE 'pco_%'");
  if (pco) problems.push(`${pco} Planning Center credential/setting row(s) in the test database — a tick could write to the church's real directory.`);
  const outbox = count('SELECT COUNT(*) n FROM pco_outbox WHERE done_at IS NULL');
  if (outbox) problems.push(`${outbox} queued Planning Center write(s) copied from live — they would be replayed for real.`);
  if (problems.length) die([...problems, 'Run: node scripts/sanitize-db.mjs <db>']);
}

export { HARNESS };
