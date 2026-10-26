// guard.js — the enforced boundary between an ISOLATED instance (a test, or the public demo) and
// PRODUCTION.
//
// WHY: tests and the demo boot THIS app from THIS directory, with isolation supplied entirely by
// environment overrides. Every default in the app points at production (the live DB file, live
// media/avatar/banner/backup directories and backup key, port 3000 which Tailscale Funnel
// publishes, and the real api.planningcenteronline.com), so ONE forgotten override means a test or
// a demo visitor quietly operating on real data or real people. That is not a hypothetical: a
// test run once paged the owner's phone through real push subscriptions carried in a copied
// database.
//
// So isolation stops being "each runner remembered" and becomes a startup contract:
//   HARNESS=1 / DEMO_MODE=1 → every outward path MUST be redirected somewhere safe, or the process
//                refuses to start and says exactly which variable is wrong. Both modes go through
//                the ONE check below (checkIsolation); there is no second, weaker copy.
//   production → the test-only seams (clock override, forced ticks, insecure cookies) are refused,
//                so a harness-shaped instance can never own the public port.
//
// Imported as the FIRST statement of db.js, which every entry point loads before touching any
// state — including before the database file is opened. A new script cannot forget it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = process.env.HARNESS === '1';
const DEMO_MODE = process.env.DEMO_MODE === '1';
// The mode that demands isolation, for messages ("HARNESS=1", "DEMO_MODE=1"), or null in production.
const ISOLATED = HARNESS ? 'HARNESS=1' : DEMO_MODE ? 'DEMO_MODE=1' : null;
const PROD_PCO_HOST = 'planningcenteronline.com';
// The synthetic world's domain (fixtures/world.mjs). A demo database may hold nobody else.
const FIXTURE_DOMAIN = '@test.local';

const die = (label, lines) => {
  console.error(`\n[guard] REFUSING TO START — ${label} isolation is not safe:\n`);
  for (const l of lines) console.error('  • ' + l);
  console.error('\n[guard] Fix the environment (see docs/TESTING.md, docs/DEMO.md) and re-run.\n');
  process.exit(90);
};

// Is `p` inside the live application directory (i.e. would writing it touch the real deployment)?
function insideApp(p) {
  const abs = path.resolve(APP_DIR, p);
  const rel = path.relative(APP_DIR, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// THE isolation check, for every mode that must never touch production. Returns the problems
// (empty = safe); the caller dies on any.
function checkIsolation(label, env = process.env) {
  const problems = [];
  const port = Number(env.PORT || 3000);
  if (!env.PORT) problems.push(`PORT is unset — a ${label} instance must never bind 3000 (the public Funnel port).`);
  else if (port === 3000) problems.push(`PORT=3000 is the live/published port. Use another port for ${label}.`);

  // Writable paths: every one of these has a production default inside this directory.
  for (const [key, why] of [
    ['DB_PATH', 'the live database'],
    ['BACKUP_DIR', 'the live backup folder (its prune would delete real snapshots)'],
    ['BACKUP_KEY_FILE', 'the production backup key (isolated snapshots would be encrypted with, and readable by, the real key)'],
    ['CHAT_MEDIA_DIR', 'live chat uploads'],
    ['AVATARS_DIR', 'live profile photos'],
    ['BANNER_DIR', 'live run banner images'],
  ]) {
    const v = env[key];
    if (!v) problems.push(`${key} is unset — it defaults to ${why}.`);
    else if (insideApp(v)) problems.push(`${key}="${v}" resolves inside the live app directory (${why}).`);
  }

  // External API: PCO credentials live in the DATABASE, so a copied DB can hold real ones. Talking
  // to production PCO from a test would create/rename real people and can rotate the live token.
  const api = env.PCO_API_BASE;
  if (!api) problems.push('PCO_API_BASE is unset — it defaults to the REAL Planning Center API.');
  else {
    let host = '';
    try { host = new URL(api).hostname; } catch { problems.push(`PCO_API_BASE="${api}" is not a valid URL.`); }
    if (host && (host === PROD_PCO_HOST || host.endsWith('.' + PROD_PCO_HOST)))
      problems.push(`PCO_API_BASE points at production Planning Center (${host}).`);
  }

  // Mail: must be unroutable. The real .env carries working Gmail credentials.
  const smtp = env.SMTP_HOST;
  if (smtp && !['127.0.0.1', 'localhost', '::1'].includes(smtp))
    problems.push(`SMTP_HOST="${smtp}" is not loopback — ${label} could send real email.`);

  return problems;
}

if (ISOLATED) {
  const problems = checkIsolation(ISOLATED);
  if (problems.length) die(ISOLATED, problems);
} else {
  // Production side: refuse the test-only seams so a misconfigured harness run can never become
  // the public instance (Funnel forwards whatever owns port 3000).
  const seams = ['HARNESS', 'ENABLE_TEST_TICK', 'TEST_NOW', 'FORCE_HELD_RELEASED', 'COOKIE_INSECURE']
    .filter(k => process.env[k]);
  const port = Number(process.env.PORT || 3000);
  if (seams.length && port === 3000)
    die('production', [`Test-only settings are present on the live port 3000: ${seams.join(', ')}.`,
         'Either set HARNESS=1 with a harness port, or remove these from the environment.']);
}

// Database invariants, checked AFTER the database is open (db.js calls this immediately). The env
// checks above can't see what a copied DB carries: real push subscriptions, real PCO tokens, real
// people. A copy that skipped scripts/sanitize-db.mjs dies here instead of reaching someone's phone,
// and a demo pointed at any copy of a real database (wherever it lives) dies here too.
export function assertFixtureSanitized(db) {
  if (!ISOLATED) return;
  const problems = [];
  const count = (sql, ...a) => { try { return db.prepare(sql).get(...a).n; } catch { return 0; } };
  const subs = count('SELECT COUNT(*) n FROM push_subscriptions');
  if (subs) problems.push(`${subs} real push subscription(s) in the database — they point at real devices.`);
  const pco = count("SELECT COUNT(*) n FROM app_settings WHERE key LIKE 'pco_%'");
  if (pco) problems.push(`${pco} Planning Center credential/setting row(s) in the database — a tick could write to the church's real directory.`);
  const outbox = count('SELECT COUNT(*) n FROM pco_outbox WHERE done_at IS NULL');
  if (outbox) problems.push(`${outbox} queued Planning Center write(s) copied from live — they would be replayed for real.`);
  if (problems.length) die(ISOLATED, [...problems, 'Run: node scripts/sanitize-db.mjs <db>']);
  // The demo only ever runs on a database it seeded itself from the synthetic world, so anyone
  // outside the fixture domain means this is somebody's real data.
  if (DEMO_MODE) {
    const real = count('SELECT COUNT(*) n FROM applicants WHERE lower(email) NOT LIKE ?', '%' + FIXTURE_DOMAIN);
    if (real) die(ISOLATED, [`${real} applicant(s) outside ${FIXTURE_DOMAIN} in the demo database — a demo only runs on the synthetic world it seeds itself.`,
      'Point DB_PATH at an empty location (scripts/run-demo.mjs wipes it on every start).']);
  }
}

export { HARNESS, DEMO_MODE };
