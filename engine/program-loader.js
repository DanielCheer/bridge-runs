// engine/program-loader.js — hydrates the registry: buildPrograms() reads the program table and
// builds each entry from PROGRAM_DEFS (code-defined programs) or from the row's own JSON spec
// (programs created in the app), then hands the views and the Planning Center sync their slice.
// Also the slug rules for a new program (reserved routes, files and settings namespaces).
import path from 'path';
import fs from 'fs';
import db from '../db.js';
import { APP_ROOT } from '../config.js';
import { pcoSetProgramLabels } from '../pco.js';
import { setProgramMeta } from '../views.js';
import { runLabelFor, runWeekday } from '../lib/dates.js';
import { bannerFile } from '../lib/media.js';
import { PROGRAMS, stmtProgActiveById } from './programs.js';
import { gamesOn } from './teams.js';
import { genericUnread, genericHubCard, genericTick, PROGRAM_DEFS } from './builtin-programs.js';

// ---------- DB-DEFINED PROGRAMS (created in-app, no deploy) ----------
// A church admin fills in the "New program" wizard → one `program` row with a JSON spec → this
// builds the same shape PROGRAM_DEFS hand-writes, so the generic engine (routes, scheduler, chat,
// season, teams, parties, hub card, exports, PCO labels) picks it up with zero new code. Only the
// genuinely arbitrary choices are stored; everything formulaic is DERIVED here — which is exactly
// why hand-writing them was never real engineering work:
//   paths    /<slug>, /<slug>/chat, /<slug>/season
//   keys     <slug>_run_date, <slug>_autoopen_done, … (the app_settings namespace)
//   copy     push/announcement strings, from the display name + emoji
//   banner   public/prog-<slug>-banner.jpg (falls back to the shared gym photo until one is uploaded)
const PROGRAM_THEMES = ['default', 'pk', 'vb'];   // curated, known-legible skins (see styles.css)
function derivedCopy(name, emoji) {
  const low = name.toLowerCase();
  return {
    openTitle: `${name} check-in is open`,
    openBody: (rd) => `Check-in is open for ${runWeekday(rd)}, ${runLabelFor(rd)} ${low} — grab your spot ${emoji}`,
    confirmTitle: `Confirm your ${low} spot`,
    confirmBody: (rd) => `You're on the floor for ${runWeekday(rd)} ${low}. Tap to confirm — or leave to free your spot.`,
    promoTitle: `You're in for ${low} ${emoji}`,
    promoBody: (rd) => `A spot opened — you're on the floor for ${runWeekday(rd)}, ${runLabelFor(rd)} ${low}.`,
    annTitle: `${name} announcement`,
  };
}
function defFromRow(row) {
  let spec;
  try { spec = JSON.parse(row.config || 'null'); } catch { spec = null; }
  if (!spec || !row.slug) return null;
  // A spec that PARSES but is missing numbers would build a program whose scheduler computes an
  // Invalid Date (dow NaN) and whose hub card throws — a 500 on /runs for every member. Only a
  // complete spec becomes a program; an incomplete one stays inert (and visibly unmounted on the
  // admin screen). Reachable only by hand-editing the DB — the wizard validates — but the blast
  // radius is all-users, so the contract is enforced here rather than assumed.
  for (const n of ['cap', 'waitlist', 'dow', 'startHour', 'endHour']) {
    if (!Number.isFinite(spec[n])) { console.error(`[program] id=${row.id} spec missing ${n} — not mounted`); return null; }
  }
  const slug = row.slug, name = spec.displayName || row.name, emoji = spec.emoji || '🏅';
  const k = (s) => `${slug}_${s}`;
  const features = {};
  if (spec.teams && spec.teams.count > 0) features.teams = { count: spec.teams.count, size: spec.teams.size, opensAt: 'lock', selfServe: true };
  if (spec.groupQueue && spec.groupQueue.maxSize > 1) features.groupQueue = { maxSize: spec.groupQueue.maxSize };
  return {
    key: slug, emoji, displayName: name,
    paths: { run: `/${slug}`, chat: `/${slug}/chat`, season: `/${slug}/season` },
    seasonLabel: `${name} season`,
    config: {
      cap: spec.cap, waitlist: spec.waitlist, prereg: spec.prereg || 0,
      dow: spec.dow, startHour: spec.startHour, endHour: spec.endHour,
      pingHour: spec.pingHour == null ? 9 : spec.pingHour, pingDowOffset: spec.pingDowOffset == null ? 0 : spec.pingDowOffset,
      lockTime: spec.lockTime, confirmCutoff: spec.confirmCutoff || null,
      keys: {
        runDate: k('run_date'), runBase: k('run_base'), seasonStart: k('season_start'),
        autoopen: k('autoopen_done'), autoping: k('autoping_done'), autolock: k('autolock_done'),
        arassess: k('arassess_done'), confirmsweep: k('confirmsweep_done'),
      },
      logTag: slug, openOffsetDays: spec.openOffsetDays == null ? -7 : spec.openOffsetDays,
      copy: derivedCopy(name, emoji),
      theme: PROGRAM_THEMES.includes(spec.theme) ? spec.theme : 'default',
      access: 'opt-in', approval: row.approval,
      joinMode: ['open', 'invite', 'host'].includes(spec.joinMode) ? spec.joinMode : 'open',
      bannerPath: bannerFile(`prog-${slug}-banner.jpg`), bannerPublic: `/prog-${slug}-banner.jpg`,
      tiers: ['team', 'host'], offerWindow: !!spec.offerWindow,
      autoRenew: spec.autoRenew ? { from: 'members' } : null,
      mentionTag: `${slug}mention`, chatSeqKey: k('chat_seq'),
      // Positions (F6): shape-guarded like the numeric contract above — a hand-edited spec must
      // not let a non-[code,label] entry reach the profile renderer.
      positions: Array.isArray(spec.positions)
        ? spec.positions.filter(x => Array.isArray(x) && typeof x[0] === 'string' && x[0]).map(x => [x[0], String(x[1] || '')])
        : null,
      // Own waiver (F6): the key is frozen at creation (spec.waiverKey) so slug renames don't
      // orphan signed records; a legacy spec without the stamp falls back to the current slug.
      waiver: spec.waiver && spec.waiver.own
        ? { key: spec.waiverKey || slug, guardianUnder: spec.waiver.guardian ? 18 : 0 }
        : null,
      features,
    },
    unread: genericUnread(row.id), hubCard: genericHubCard(row.id), tick: genericTick(row.id),
  };
}
// A program's own routes live under /<slug>, so a slug must never shadow an app route or a real
// file in public/. Computed from the LIVE router stack rather than a hand-kept list — a list would
// silently rot the next time a route is added. `app` is the Express app whose stack is walked (a
// route handler passes req.app).
function slugIsReserved(slug, app) {
  if (fs.existsSync(path.join(APP_ROOT, 'public', slug))) return true;
  // A slug also becomes a NAMESPACE: defFromRow derives `<slug>_run_date`, `<slug>_chat_seq`,
  // `<slug>mention` and the rate-limit bucket from it. The code programs' namespaces do NOT match
  // their slugs (pickleball's slug is 'pickleball' but its keys are `pk_*`), so a program created
  // with slug 'pk' would silently SHARE pickleball's run date, open/lock/sweep markers, chat
  // fingerprint and push tag. Reserve every live namespace token, not just route paths.
  for (const p of PROGRAMS.values()) {
    const cfg = p.config;
    if (cfg.logTag && cfg.logTag === slug) return true;
    if (cfg.mentionTag && cfg.mentionTag === `${slug}mention`) return true;
    if (cfg.chatSeqKey && cfg.chatSeqKey === `${slug}_chat_seq`) return true;
    for (const key of Object.values(cfg.keys || {})) {
      if (typeof key === 'string' && key.startsWith(`${slug}_`)) return true;
    }
  }
  const stack = (app._router && app._router.stack) || [];
  for (const layer of stack) {
    const raw = layer.route && layer.route.path;
    for (const p of (Array.isArray(raw) ? raw : [raw])) {
      if (typeof p === 'string' && p.startsWith('/') && p.split('/')[1] === slug) return true;
    }
  }
  return false;
}

function buildPrograms() {
  PROGRAMS.clear();
  for (const row of db.prepare('SELECT * FROM program ORDER BY id').all()) {
    // Code-defined programs (1/2/3/90) always win by id — their behaviour is frozen. Everything
    // else is built from the row's JSON spec, so an in-app creation needs no deploy.
    const def = PROGRAM_DEFS[row.id] || defFromRow(row);
    if (!def) continue; // a row with neither an engine nor a valid spec is inert, never a crash
    PROGRAMS.set(row.id, {
      id: row.id, key: def.key, emoji: def.emoji, displayName: def.displayName,
      paths: def.paths, seasonLabel: def.seasonLabel, config: def.config,
      active: def.alwaysActive ? (() => true) : (() => !!(stmtProgActiveById.get(row.id) || {}).active),
      unread: def.unread, hubCard: def.hubCard, tick: def.tick,
    });
  }
  // Hand the view layer the presentation subset so it renders run-aware links (Chat tab href,
  // season link) without hardcoding paths — the server is the single source of program truth.
  const meta = {};
  // ladder: the path only when that program keeps score, '' otherwise — so a view can offer the
  // link without knowing anything about the feature flag.
  for (const [id, p] of PROGRAMS) meta[id] = { chat: p.paths.chat, season: p.paths.season, seasonLabel: p.seasonLabel,
    ladder: ((p.config.features || {}).ladder ? `${p.paths.run}/ladder` : ''),
    teams: ((p.config.features || {}).teams ? `${p.paths.run}/teams` : ''),
    // The leaderboard exists only where games are logged, which is a narrower flag than teams
    // (two sides, games on). Derived here for the same reason as ladder/teams: the view asks the
    // registry for a path and never learns the feature rules.
    leaderboard: (gamesOn(id) ? `${p.paths.run}/leaderboard` : '') };
  setProgramMeta(meta);
  // Same idea for the PCO sync: it labels the "sports played" custom field from the registry, so
  // adding a program needs no edit in pco.js. Built from the program KEY (the canonical sport
  // name — 'basketball', 'volleyball'), not displayName: display names carry branding prefixes
  // ("ADV Basketball") that don't belong in a church-facing sport list. Demo is filtered out on
  // the sync side by program id.
  const labels = {};
  for (const [id, p] of PROGRAMS) labels[id] = p.key.charAt(0).toUpperCase() + p.key.slice(1);
  pcoSetProgramLabels(labels);
}

export {
  PROGRAM_THEMES, slugIsReserved, buildPrograms,
};
