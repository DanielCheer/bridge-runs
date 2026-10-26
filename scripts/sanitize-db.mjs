// sanitize-db.mjs — strip every OUTWARD-REACHING credential and endpoint from a test database.
//
//   node scripts/sanitize-db.mjs <db>          (or: import { sanitize } from './scripts/sanitize-db.mjs')
//
// WHY THIS EXISTS: a test instance runs the real scheduler and doesn't know it's a test, so anything
// in its database that points outward escapes the sandbox. A copy of a real database carries:
//   • push_subscriptions  → real phones (a test once paged a real device this way).
//   • vapid_*             → the signing keypair those subscriptions trust. Safe to drop: the app
//                           regenerates a keypair when missing, and sendPush no-ops with zero
//                           subscriptions.
//   • pco_*               → Planning Center credentials. A test tick would CREATE and RENAME people
//                           in a real directory; worse, an OAuth refresh rotates the token and would
//                           break the live connection from a read-only test.
//   • pco_outbox          → queued real writes, replayed against the real API on the first tick.
// Purging is a property of the FIXTURE, so no individual test has to remember it. guard.js re-checks
// the same invariants at startup (assertFixtureSanitized), so a database that skipped this dies
// loudly instead of reaching someone. The synthetic fixture (fixtures/world.mjs) never contains any
// of these; this is for databases that started life somewhere else.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export function sanitize(db) {
  const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const out = {};
  // A table can be missing when the database predates it; that is "nothing to remove", not an error.
  // Any other failure (locked, corrupt) throws: a half-sanitized fixture must not look clean.
  const run = (label, table, sql) => { out[label] = hasTable(table) ? Number(db.prepare(sql).run().changes) : 0; };
  run('push_subscriptions', 'push_subscriptions', 'DELETE FROM push_subscriptions');
  run('pco_settings', 'app_settings', "DELETE FROM app_settings WHERE key LIKE 'pco_%'");
  run('vapid_keys', 'app_settings', "DELETE FROM app_settings WHERE key LIKE 'vapid_%'");
  run('pco_outbox', 'pco_outbox', 'DELETE FROM pco_outbox');
  return out;
}

// CLI entry: only when run directly, not when imported.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) { console.error('usage: node scripts/sanitize-db.mjs <db>'); process.exit(2); }
  const db = new DatabaseSync(target);
  const n = sanitize(db);
  db.close();
  const summary = Object.entries(n).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`[sanitize] ${target}${summary ? ' — removed ' + summary : ' — already clean'}`);
}
