// engine/scheduler.js — the in-process clock: every 60 seconds each program's tick() (rollover,
// auto open/lock, offer expiry), scheduled announcements and the Planning Center outbox; plus the
// precise-fire timer for a pending scheduled post. Started once by server.js at boot.
import { pcoTick } from '../pco.js';
import { PROGRAMS } from './programs.js';
import { fireScheduledAnnouncements, armScheduleTimer } from './announcements.js';

export function startScheduler() {
  // The boot-time weekly rollover runs in server.js after buildPrograms() — ensureWeek → autoJoinTeam →
  // seatRenewers reads P(1).config, so the PROGRAMS registry must be hydrated first. This 60s
  // interval is safe as-is: it first fires ~60s in, long after buildPrograms() has run.
  setInterval(() => {
    try {
      // Each program runs its own per-tick work via its registry tick() — program-generic, so a new
      // run is picked up with zero scheduler code change. id order (basketball, then pickleball)
      // preserves the original call sequence. Each program is isolated: with in-app program creation
      // a single bad program must not starve every other run's rollover/expiry every 60 s.
      for (const p of PROGRAMS.values()) {
        try { p.tick(); } catch (e) { console.error(`[interval] program ${p.id} (${p.key}) tick FAILED: ${e.message}`); }
      }
    } catch (e) { console.error(`[interval] rollover/expiry FAILED: ${e.message}`); }
    try { fireScheduledAnnouncements(); } catch (e) { console.error(`[sched-announce] tick FAILED: ${e.message}`); }
    // PCO People sync: drain the outbox + reconcile unlinked members. Async and fully
    // self-contained (own error handling, inert without credentials) — fire and forget.
    pcoTick().catch(e => console.error('[pco] tick rejected:', e.message));
  }, 60000).unref();
  armScheduleTimer();   // precise firing for any pending post that survived a restart
}
