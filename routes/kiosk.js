// routes/kiosk.js — the door kiosk: a token-gated, sign-in-free board of tonight's floor and
// waitlist (and the ladder) for a screen at the venue, and the admin token rotation.
import crypto from 'crypto';
import { pcoKioskArrivals } from '../pco.js';
import { currentUser, isAdmin, requireAdmin } from '../auth.js';
import { ladderBoardPage, kioskPage } from '../views/index.js';
import { getSetting, setSetting, delSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { lc } from '../lib/email.js';
import { runLabelFor, ymdLocal, schedNow } from '../lib/dates.js';
import { PROGRAMS, programActive, P, programRunDate, runCancelledFor } from '../engine/programs.js';
import { nextRunDate } from '../engine/basketball-calendar.js';
import { partitionFor } from '../engine/seating.js';
import {
  ladderCfg, ladderRunDate, ladderFrom, ladderStandings, ladderNominations,
} from '../engine/ladder.js';

// ---------- KIOSK (F7) ----------
// A big-screen live roster for the gym door (TV/laptop): floor + waitlist, refreshing itself.
// Auth: an admin session works directly; for a shared screen with no login, an admin mints a
// kiosk link carrying a token (`?k=`), revocable by regenerating. Read-only by construction.
// The one gate every screen-on-the-wall route passes through — door roster, ladder board, and any
// future one. It lives here ONCE: a second copy of a token comparison is a second place to get the
// timing-safe compare, the legacy-token fallback or the hidden-program rule subtly wrong.
// Returns null (having answered the request) when the caller must stop.
function kioskGate(req, res) {
  const pid = Number(req.params.pid);
  if (!PROGRAMS.has(pid)) { res.status(404).send('Not found'); return null; }
  const admin = isAdmin(currentUser(req));
  // The static DEMO kiosk is ADMIN-SESSION-ONLY (owner ask 2026-08-05: show the door screen on
  // the synthetic roster while demoing). No demo token exists or can ever mint (runKioskRotate's
  // static guard), so there is no shareable demo link; everyone else 404s like any hidden program.
  if (pid === 90 && !admin) { res.status(404).send('Not found'); return null; }
  // Timing-safe token compare (P3-3) — an early-exit === leaks prefix-match timing. Length guard
  // first: timingSafeEqual throws on unequal lengths. Per-program tokens (proposal #3) so one
  // program's leaked link is revocable alone; the legacy global token keeps old screens working.
  const tok = String(req.query.k || '');
  const tokEq = (want) => !!want && tok.length === want.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(want));
  // Legacy global token only while NO per-program token exists: minting a program's own link
  // then self-retires the global for THAT program, so "screens on the old link stop working"
  // (the rotate confirm) is actually true (2026-08-05 audit P3-3).
  const perProg = String(getSetting(`kiosk_token_${pid}`) || '');
  const tokenOk = tokEq(perProg) || (!perProg && tokEq(String(getSetting('kiosk_token') || '')));
  if (!tokenOk && !admin) { res.status(403).send('Kiosk link required.'); return null; }
  // A token must not expose an UNPUBLISHED program's roster (P3-3): hidden = admins only.
  if (!programActive(pid) && !admin) { res.status(404).send('Not found'); return null; }
  return { pid, admin };
}

export function mountKiosk(app) {
  // The ladder on the wall: same revocable link as the door screen, no login, read-only by
  // construction (nothing here writes, and the page carries no controls). Self-refreshing so a
  // projector left on all night follows the standings as games land.
  app.get('/kiosk/:pid/ladder', (req, res) => {
    const k = kioskGate(req, res); if (!k) return;
    const cfg = ladderCfg(k.pid); if (!cfg) return res.status(404).send('Not found');
    const p = P(k.pid), from = ladderFrom(k.pid);
    res.send(ladderBoardPage({
      sport: p.displayName, emoji: p.emoji, theme: p.config.theme || '',
      award: cfg.award || 'Sportsmanship',
      dateLabel: runLabelFor(ladderRunDate(k.pid)),
      standings: ladderStandings(k.pid, from), noms: ladderNominations(k.pid, from),
    }));
  });
  app.get('/kiosk/:pid', (req, res) => {
    const k = kioskGate(req, res); if (!k) return;
    const pid = k.pid;
    const rd = pid === 1 ? nextRunDate() : programRunDate(pid);
    const part = partitionFor(pid, rd);
    const floor = (P(pid).config.offerWindow ? part.floorReal : part.floor) || [];
    const wait = (part.wait || part.waitPlayers || []);
    // Door arrivals (PCO Phase 2b): today's station taps, from pco.js's viewer-driven cache.
    // Roster membership is decided HERE (pco.js only maps taps → linked emails) — a tap from
    // someone with no spot tonight is a walk-in, whether or not their account is linked.
    const arr = pcoKioskArrivals(rd, ymdLocal(new Date(schedNow())));
    const tappedIn = (p) => !!(arr && arr.arrived.has(lc(p.email || '')));
    const fl = floor.map(p => ({ name: p.name || p.email, email: p.email || '', confirmed: !!p.confirmed_at, arrived: tappedIn(p) }));
    const wl = wait.map(p => ({ name: p.name || p.email, email: p.email || '', arrived: tappedIn(p) }));
    let door = null;
    if (arr) {
      const rostered = new Set([...floor, ...wait].map(p => lc(p.email || '')));
      let walkIns = arr.unlinkedTaps;
      for (const e of arr.arrived) if (!rostered.has(e)) walkIns++;
      door = { live: arr.live, arrived: fl.concat(wl).filter(p => p.arrived).length, walkIns };
    }
    res.send(kioskPage({
      sport: P(pid).displayName, emoji: P(pid).emoji, theme: P(pid).config.theme || '',
      runDate: rd, dateLabel: runLabelFor(rd), cap: P(pid).config.cap,
      floor: fl, wait: wl, door,
      cancelled: runCancelledFor(pid, rd),
    }));
  });
  // Admin: mint/rotate kiosk tokens — per program now (proposal #3). With a pid, rotate ONE
  // program's token; without, mint fresh tokens for every real program AND rotate the legacy
  // global away so "refresh" means what it says.
  app.post('/admin/kiosk', requireAdmin, (req, res) => {
    const pid = Number(req.body.pid);
    if (Number.isInteger(pid) && PROGRAMS.has(pid) && !P(pid).config.static) {
      setSetting(`kiosk_token_${pid}`, crypto.randomBytes(12).toString('base64url'));
      audit(req.userEmail, 'admin', 'kiosk:token-rotated', `program ${pid}`);
      return res.redirect('/admin/programs?msg=' + encodeURIComponent(`${P(pid).displayName} kiosk link refreshed — its old screens stop working.`));
    }
    for (const p of PROGRAMS.values()) if (!p.config.static) setSetting(`kiosk_token_${p.id}`, crypto.randomBytes(12).toString('base64url'));
    delSetting('kiosk_token');   // the global-era token dies with a full refresh
    audit(req.userEmail, 'admin', 'kiosk:token-rotated', 'all programs');
    res.redirect('/admin/programs?msg=' + encodeURIComponent('Kiosk links refreshed for every program — old screens stop working, grab new links from the cards.'));
  });
}
