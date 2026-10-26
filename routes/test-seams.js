// routes/test-seams.js — test-only routes, mounted only with ENABLE_TEST_TICK=1 (guard.js refuses
// that on the production port): run every scheduler tick now, and dump the route table.
import { ENABLE_TEST_TICK } from '../config.js';
import { pcoTick, pcoDaily } from '../pco.js';
import { requireAdmin } from '../auth.js';
import { schedNow } from '../lib/dates.js';
import { PROGRAMS } from '../engine/programs.js';
import { fireScheduledAnnouncements } from '../engine/announcements.js';

export function mountTestSeams(app) {
  // Test-only: synchronously run every program's scheduler tick (rollover + auto open/ping/lock).
  // Mounted ONLY when ENABLE_TEST_TICK=1 so it can never exist in prod — lets the harness drive the
  // clock phases (paired with TEST_NOW) without waiting for the 60s interval. Precedent: FORCE_HELD_RELEASED.
  if (ENABLE_TEST_TICK) {
    app.post('/admin/test/tick', requireAdmin, async (req, res) => {
      for (const p of PROGRAMS.values()) p.tick();
      try { fireScheduledAnnouncements(); } catch (e) { console.error(e.message); }
      await pcoTick();                                  // awaited so the harness can assert right after
      if (req.body && req.body.pcodaily) await pcoDaily(); // opt-in: also run the nightly delta poll
      res.json({ ok: true, now: schedNow() });
    });
    // Test-only: the live Express stack, one layer per line in registration order, so a refactor that
    // moves routes between files can prove the mounted set, its order and each route's middleware
    // chain are unchanged (test/routes.test.mjs compares it to test/snapshots/routes.txt).
    app.get('/admin/test/routes', requireAdmin, (req, res) => {
      const name = (fn) => (fn && fn.name) || '<anonymous>';
      const lines = [];
      for (const layer of app._router.stack) {
        if (layer.route) {
          const chain = layer.route.stack.map((l) => name(l.handle)).join(' ');
          lines.push(`${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}  [${chain}]`);
        } else {
          lines.push(`USE ${layer.regexp.fast_slash ? '/' : layer.regexp.source} ${name(layer.handle)}`);
        }
      }
      res.type('text/plain').send(lines.join('\n') + '\n');
    });
  }
}
