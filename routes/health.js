// routes/health.js — GET /healthz: the liveness probe the Windows watchdog and the test harness
// poll (a database round-trip, no session).
import db from '../db.js';

export function mountHealth(app) {
  // For the uptime monitor: cheap, unauthenticated, and it actually exercises the DB — a hung
  // SQLite handle should page the owner, not just a dead port. Returns no data beyond up/degraded.
  app.get('/healthz', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.type('text/plain').send('ok');
    } catch (e) {
      console.error(`[healthz] DB check failed: ${e.message}`);
      res.status(503).type('text/plain').send('degraded');
    }
  });
}
