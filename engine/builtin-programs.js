// engine/builtin-programs.js — the code-defined programs (1 basketball, 2 pickleball,
// 3 volleyball, 90 the demo run) as PROGRAM_DEFS entries, plus the generic unread / hub-card /
// tick factories every config-driven program uses. Read by buildPrograms() at boot; this module
// sits above the engines its entries call, which is what lets engine/programs.js stay below them.
import { PK_CAP, PK_WAIT } from '../config.js';
import { fmtClockRange, runLabelFor, runWeekday } from '../lib/dates.js';
import { bannerFile, PK_BANNER_PATH } from '../lib/media.js';
import {
  P, programRunDate, runOpenFor, runCancelledFor, programActive, startHHMM, endHHMM,
} from './programs.js';
import {
  nextRunDate, CAP, WAITLIST_CAP, PREREG_CAP, OPEN_H, runTimeRange, runIsOpen, runIsCancelled,
  DEFAULT_START, DEFAULT_END, RUN_DOW, OPEN_DAYS_BEFORE,
} from './basketball-calendar.js';
import { partitionFor, expireAndReoffer } from './seating.js';
import { chatUnreadFor, chatMentionUnreadFor, groupUnread, groupMentionUnread } from './chat.js';
import { ensureWeekFor, autoRunStateFor } from './run-engine.js';
import { loadRun, ensureWeek, autoRunState } from './basketball.js';

// ---------- PICKLEBALL (separate, hidden run — ISOLATED pk_* tables, no basketball impact) ----------
// Pickleball's standing day = Tuesday (PK_DOW=2), DECOUPLED from basketball so moving the
// basketball run (RUN_DOW) never drags pickleball's date along. Weekly auto-schedule:
// check-in reopens right after the run ends (PK_END_H), the roster locks at start
// (PK_START_H), and the floor gets a confirm ping the night before (PK_PING_H, day before).
const PK_DOW = 2, PK_START_H = 18, PK_START_M = 15, PK_END_H = 20, PK_END_M = 15,
      PK_PING_H = 9, PK_PING_DOW_OFFSET = 0, PK_LOCK = '17:30';   // Tue 6:15-8:15 PM; confirm ping RUN-DAY 9 AM (owner rule)

// ---------- PROGRAM REGISTRY HYDRATION ----------
// Per-program presentation + engine dispatch. Phase 1: each entry still routes to today's
// basketball / pickleball functions — the registry exists so nothing hardcodes "1 vs 2". A
// later phase folds these two DEFS into a single config-driven engine (config_json /
// program_settings land with that schema work, when there's a real consumer + editor).
// Generic registry closures for an OPT-IN program (pickleball, volleyball) — so a program's DEFS
// entry is pure config, not cloned unread/hubCard/tick logic. Basketball keeps its own (it uses
// host-editable caps + per-week time overrides). Each returns a closure that reads P(id) at call time.
function genericUnread(programId) {
  return (email, aid) => ({ group: chatUnreadFor(programId, email), gm: chatMentionUnreadFor(programId, email, aid) });
}
function genericHubCard(programId) {
  return () => {
    ensureWeekFor(programId);
    const cfg = P(programId).config;
    const rd = programRunDate(programId), part = partitionFor(programId, rd);
    const floor = cfg.offerWindow ? part.floorReal : part.floor;
    return {
      runDate: rd, dateLabel: runLabelFor(rd), timeLabel: fmtClockRange(startHHMM(cfg), endHHMM(cfg)),
      going: floor.length + (cfg.offerWindow ? part.offered.length : 0), cap: cfg.cap, // count held offers so the hub card matches the run page (no 8→7 dip mid-offer)
      status: runCancelledFor(programId, rd) ? 'cancelled' : (runOpenFor(programId, rd) ? 'open' : 'closed'),
      hidden: !programActive(programId),
      part, // the partition this card already computed — reused by myRunStatusFor on /runs (stripped before view props)
    };
  };
}
function genericTick(programId) {
  return () => {
    ensureWeekFor(programId);
    const rd = programRunDate(programId);
    if (P(programId).config.offerWindow) expireAndReoffer(rd, null, programId);   // queue programs re-offer freed spots
    autoRunStateFor(programId);
  };
}
const PROGRAM_DEFS = {
  1: {
    key: 'basketball', emoji: '🏀', displayName: 'ADV Basketball', alwaysActive: true,
    paths: { run: '/checkin', chat: '/chat', season: '/season' }, seasonLabel: 'Season board',
    // Per-program config (Phase 3a foundation): the single source the unified engine will read
    // so a new run = a config row, not cloned code. Capacities are HOST-EDITABLE at runtime
    // (app_settings via reloadRunSettings), so they're getters — a snapshot would go stale on the
    // next Council settings save. Nothing consumes this yet (0-diff); the engine merge wires it in.
    config: {
      get cap() { return CAP; }, get waitlist() { return WAITLIST_CAP; }, get prereg() { return PREREG_CAP; },
      dow: RUN_DOW, start: DEFAULT_START, end: DEFAULT_END,          // Wed 8:30–10:30 PM
      openDaysBefore: OPEN_DAYS_BEFORE, openHour: OPEN_H, lockTime: '14:00',
      confirmCutoff: '16:30',   // unconfirmed floor released at 4:30 PM run day (owner-set; must be ≥ lockTime — the sweep runs inside the post-lock branch)
      theme: 'default', access: 'apply', approval: 'council',
      tiers: ['team', 'core', 'host'], offerWindow: true,
      autoRenew: { from: 'team' },   // only the org team (applicants.is_team) auto-renews; no non-team fill
      positions: [['PG', 'Point'], ['SG', 'Shoot'], ['SF', 'Small F'], ['PF', 'Power F'], ['C', 'Center']],   // profile picker chips (F6: per-program)
      // autoRenewPenalty: { strikes: 3, pauseWeeks: 2 },   // DARK — add to police team no-shows (autoRunState assess + seatRenewers skip already wired; marker app_settings 'arassess_done')
      mentionTag: 'mention', chatSeqKey: 'chat_seq',   // push-dedup tag + app_settings key for this room
      // TWO sides, because that is what a full-court run is. `size` is deliberately loose (cap is 15,
      // so 10 a side never legitimately fills): the size guard exists to stop a mis-tap stacking one
      // team, and a guard that fights the operator mid-night is worse than no guard.
      // selfServe:false — sides are called by whoever is running the night, not self-picked.
      // games:true turns on result logging from the teams board + the leaderboard it feeds.
      features: { teams: { count: 2, size: 10, opensAt: 'lock', selfServe: false, games: true }, groupQueue: false },
      // This run signs up in Planning Center, not here, so its floor is synced in. Prefix only
      // NARROWS the candidate signups; pcoSignupRosterForDate matches on the event date.
      // Matches the weekly runs only. The church's Planning Center admin renamed these on 2026-09-10 to
      // "YA Basketball - Advanced Run (Wed Sep 23)" so other staff can tell the events apart.
      // The "(Wed" is load-bearing: the crew signup is "YA Basketball - Advanced Run (Team)" and
      // without it that would match too, and resolve as a second signup on every run date.
      pcoSignupPrefix: 'YA Basketball - Advanced Run (Wed',
    },
    unread: (email, aid) => ({ group: groupUnread(email), gm: groupMentionUnread(email, aid) }),
    hubCard: (req) => {
      const bb = loadRun(req);
      return {
        runDate: bb.runDate, dateLabel: runLabelFor(bb.runDate), timeLabel: runTimeRange(bb.runDate),
        going: bb.inPlayers.length + bb.offeredPlayers.length, cap: CAP,
        status: runIsCancelled(bb.runDate) ? 'cancelled' : (runIsOpen(bb.runDate) ? 'open' : 'closed'),
        hidden: false,
        part: bb.part, // reuse loadRun's partition for the /runs badge (myRunStatusFor) — post-expireAndReoffer, exactly what a 2nd partition would see
      };
    },
    // Per-tick work for the 60s scheduler loop: rollover + offer-expiry + auto open/close.
    tick: () => { const rd = nextRunDate(); ensureWeek(rd); expireAndReoffer(rd, null); autoRunState(); },
  },
  2: {
    key: 'pickleball', emoji: '🥒', displayName: 'Pickleball',
    paths: { run: '/pickleball', chat: '/pickleball/chat', season: '/pickleball/season' }, seasonLabel: 'Pickleball season',
    // Pickleball config: fixed cap/waitlist (not host-editable today), own Tue schedule, teal 'pk'
    // theme, opt-in access, team-only tier (no core). Matches today's PK_* constants exactly.
    config: {
      cap: PK_CAP, waitlist: PK_WAIT, prereg: 0,
      dow: PK_DOW, startHour: PK_START_H, startMin: PK_START_M, endHour: PK_END_H, endMin: PK_END_M,   // Tue 6:15–8:15 PM
      pingHour: PK_PING_H, pingDowOffset: PK_PING_DOW_OFFSET, lockTime: PK_LOCK,
      confirmCutoff: '16:30',   // unconfirmed floor released at 4:30 PM run day (absolute, owner-set)
      keys: { runDate: 'pk_run_date', runBase: 'pk_run_base', seasonStart: 'pk_season_start',
              autoopen: 'pk_autoopen_done', autoping: 'pk_autoping_done', autolock: 'pk_autolock_done', arassess: 'pk_arassess_done', confirmsweep: 'pk_confirmsweep_done' },  // app_settings keys
      logTag: 'pk', openOffsetDays: -7,   // audit/push/log prefix; reopen openOffsetDays before run day at endHour
      copy: {
        openTitle: 'Pickleball check-in is open',
        openBody: (rd) => `Check-in is open for ${runWeekday(rd)}, ${runLabelFor(rd)} pickleball — grab your spot 🥒`,
        confirmTitle: 'Confirm your pickleball spot',
        confirmBody: (rd) => `You're on the floor for ${runWeekday(rd)} pickleball. Tap to confirm — or leave to free your spot.`,
        promoTitle: "You're in for pickleball 🥒",
        promoBody: (rd) => `A spot opened — you're on the floor for ${runWeekday(rd)}, ${runLabelFor(rd)} pickleball.`,
        annTitle: 'Pickleball announcement',
      },
      theme: 'pk', access: 'opt-in', approval: 'invite',
      bannerPath: PK_BANNER_PATH, bannerPublic: '/pk-banner.jpg',   // own banner file + its public URL (fallback /gym.jpg)
      tiers: ['team', 'host'], offerWindow: false,
      autoRenew: { from: 'members' },   // any opt-in member (program_membership.auto_renew) renews; team seated first, then non-team fill
      // autoRenewPenalty: { strikes: 3, pauseWeeks: 2 },   // DARK — add to enable no-show strikes (engine + keys.arassess ready)
      mentionTag: 'pkmention', chatSeqKey: 'pk_chat_seq',
      // groupQueue ON: parties can check into pickleball ("a party can join any run"). Simple
      // model + packParties reduction-proof — with no group_ids the roster is byte-identical.
      // ladder ON: doubles results logged at the court feed a season board (owner 2026-09-08).
      // `log` decides who may record a game — 'operator' (host/admin) or 'players' (any member on
      // tonight's roster); `pointsTo` only prefills the winners' score box. Absent/false = the
      // whole feature is dark for that program, routes included.
      features: { teams: false, groupQueue: { maxSize: 4 },
        // pcoGroup: the Church Center group whose membership IS the ladder roster. With it set,
        // the operator can pull the roster instead of typing it (Groups is readable on a plain
        // People-viewer token; Check-Ins is not). Absent = the roster is entered by hand.
        // nominations: CLOSED until the end of the season (owner 2026-09-08) — the award is voted
        // once, in the final weeks, not accumulated all season. Flip to true to open voting.
        ladder: { pointsTo: 11, log: 'operator', award: 'Iron Sharpens Iron', nominations: false, pcoGroup: 3185612 } },
    },
    unread: genericUnread(2),
    hubCard: genericHubCard(2),
    tick: genericTick(2),
  },
  // Volleyball — the Phase-4 acceptance test: adding a program is PURE CONFIG (this block + a
  // program row + a CSS theme). Ships HIDDEN (program.active=0); publish = flip active + set the
  // season start in September. Cap 21 (3×7), waitlist 6, opt-in, org-team tier only. Day/time are
  // PLACEHOLDER (Fri ~6–9 PM) — config, finalize before publish. Uses the generic engine end-to-end;
  // routes are registered by mountRunProgram.
  // SIMPLE seating model (offerWindow:false, like pickleball): a freed floor spot promotes the top
  // waitlister IMMEDIATELY — no 3h email-offer/claim window. Chosen over the offer model because the
  // offer-window claim route + offer UI were never wired for vb AND offers fought the queue-with-
  // friends parties (a single freed seat can't be offered to a multi-person party). groupQueue stays
  // ON: packParties (in simplePartition) keeps a party atomic on the floor.
  3: {
    key: 'volleyball', emoji: '🏐', displayName: 'Volleyball',
    paths: { run: '/volleyball', chat: '/volleyball/chat', season: '/volleyball/season' }, seasonLabel: 'Volleyball season',
    config: {
      cap: 21, waitlist: 6, prereg: 0,
      dow: 5, startHour: 18, endHour: 21,          // Fri 6–9 PM (PLACEHOLDER — owner to finalize 6:30–9:30)
      pingHour: 9, pingDowOffset: 0, lockTime: '18:00',    // confirm ping RUN-DAY 9 AM (owner rule), roster locks 6 PM
      confirmCutoff: '16:30',                              // unconfirmed floor released at 4:30 PM run day (absolute, owner-set)
      keys: { runDate: 'vb_run_date', runBase: 'vb_run_base', seasonStart: 'vb_season_start',
              autoopen: 'vb_autoopen_done', autoping: 'vb_autoping_done', autolock: 'vb_autolock_done', arassess: 'vb_arassess_done', confirmsweep: 'vb_confirmsweep_done' },
      logTag: 'vb', openOffsetDays: -7,
      copy: {
        openTitle: 'Volleyball check-in is open',
        openBody: (rd) => `Check-in is open for ${runWeekday(rd)}, ${runLabelFor(rd)} volleyball — grab your spot 🏐`,
        confirmTitle: 'Confirm your volleyball spot',
        confirmBody: (rd) => `You're on the floor for ${runWeekday(rd)} volleyball. Tap to confirm — or leave to free your spot.`,
        promoTitle: "You're in for volleyball 🏐",
        promoBody: (rd) => `A spot opened — you're on the floor for ${runWeekday(rd)}, ${runLabelFor(rd)} volleyball.`,
        annTitle: 'Volleyball announcement',
      },
      theme: 'vb', access: 'opt-in', approval: 'invite',
      bannerPath: bannerFile('vb-banner.jpg'), bannerPublic: '/vb-banner.jpg',
      tiers: ['team', 'host'], offerWindow: false,   // SIMPLE model — immediate waitlist promotion (see block comment)
      autoRenew: { from: 'members' },
      autoRenewPenalty: { strikes: 3, pauseWeeks: 2 },   // ENABLED: 3 consecutive no-shows (auto-seated, never confirmed) → auto-renew pauses 2 weeks. Tunable.
      positions: [['S', 'Setter'], ['OH', 'Outside'], ['MB', 'Middle'], ['OPP', 'Opp'], ['L', 'Libero'], ['DS', 'Def']],   // profile picker chips (F6: per-program)
      mentionTag: 'vbmention', chatSeqKey: 'vb_chat_seq',
      features: { teams: { count: 3, size: 7, opensAt: 'lock', selfServe: true }, groupQueue: { maxSize: 4 } },  // 3×7 teams; queue-with-friends parties up to 4 (Phase 6b)
    },
    unread: genericUnread(3),
    hubCard: genericHubCard(3),
    tick: genericTick(3),
  },
  // DEMO — a live, fully-interactive showcase run that reuses the REAL engine (offerWindow: true, so
  // the auto-offer → confirm → promote money-moment is genuine, not mocked). Two things keep it safe:
  //   • static: true — no weekly rollover / archive / auto-open (ensureWeekFor + the tick no-op), so a
  //     seeded roster stays put and nothing ever lands in attendance/season/exports.
  //   • players are synthetic checkins-only rows (@demo.local, no applicant rows) in program_id=90 —
  //     invisible to friend search, people admin, push, and every other live surface.
  // Ships inactive (program.active=0): only an admin sees/operates it (programGate allows admins on
  // hidden programs). Seed/reset/clear + the money-moment run from the demo control strip on /demo.
  90: {
    key: 'demo', emoji: '🎬', displayName: 'DEMO — Live Waitlist',
    paths: { run: '/demo', chat: '/demo/chat', season: '/demo/season' }, seasonLabel: 'Demo season',
    config: {
      cap: 12, waitlist: 6, prereg: 0,             // 12 floor = 3 teams of 4 (party + two-groups + individuals showcase)
      dow: 3, startHour: 19, endHour: 21,          // cosmetic (static — never scheduled): Wed 7–9 PM
      pingHour: 18, pingDowOffset: 1, lockTime: '18:00',
      keys: { runDate: 'demo_run_date', runBase: 'demo_run_base', seasonStart: 'demo_season_start',
              autoopen: 'demo_autoopen_done', autoping: 'demo_autoping_done', autolock: 'demo_autolock_done', arassess: 'demo_arassess_done' },
      logTag: 'demo', openOffsetDays: -7,
      copy: {
        openTitle: 'Demo check-in is open',
        openBody: (rd) => `Demo check-in is open for ${runLabelFor(rd)}.`,
        confirmTitle: 'Confirm your demo spot',
        confirmBody: (rd) => `You're on the floor for the ${runLabelFor(rd)} demo run.`,
        promoTitle: "You're in (demo)",
        promoBody: (rd) => `A spot opened — you're on the floor for the ${runLabelFor(rd)} demo run.`,
        annTitle: 'Demo announcement',
      },
      theme: 'default', access: 'opt-in', approval: 'invite',
      tiers: ['team', 'host'], offerWindow: true, static: true,   // REAL offer money-moment, but frozen lifecycle
      autoRenew: { from: 'members' },
      mentionTag: 'demomention', chatSeqKey: 'demo_chat_seq',
      // Teams + queue-with-friends ON for the showcase: 3 teams of 4 (a full party / two groups /
      // individuals) + party-atomic seating — the same generic features volleyball uses.
      features: { teams: { count: 3, size: 4, opensAt: 'lock', selfServe: true }, groupQueue: { maxSize: 4 } },
    },
    unread: genericUnread(90),
    hubCard: genericHubCard(90),
    tick: () => {},   // static — the 60s scheduler does no work for the demo
  },
};

export {
  genericUnread, genericHubCard, genericTick, PROGRAM_DEFS,
};
