// routes/programs-admin.js — creating and editing programs from the app (no deploy): the
// programs list, the create/edit wizard with its validation, membership, activation and delete.
// A created program's routes go live at once through mountPendingPrograms.
import db, { transact } from '../db.js';
import { requireAdmin } from '../auth.js';
import { programsAdminPage } from '../views/index.js';
import { getSetting, setSetting, delSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { isValidEmail } from '../lib/email.js';
import { sendPush } from '../lib/push.js';
import { fmtClockRange } from '../lib/dates.js';
import { applicantByEmail } from '../engine/applicants.js';
import { PROGRAMS, startHHMM, endHHMM, P, joinProgramMembership } from '../engine/programs.js';
import { nextRunDate } from '../engine/basketball-calendar.js';
import { ladderNomsKey } from '../engine/ladder.js';
import { applySeasonStart } from '../engine/run-engine.js';
import { PROGRAM_THEMES, slugIsReserved, buildPrograms } from '../engine/program-loader.js';
import { mountPendingPrograms, MOUNTED_PROGRAMS } from './run-routes.js';

// ---------- PROGRAMS (admin) — create a new run/program from the app, no deploy ----------
// The church's answer to "can we add a youth program ourselves?": this writes a `program` row +
// JSON spec, rebuilds the registry, and mounts the routes live. Code-defined programs (basketball,
// pickleball, volleyball, demo) are read-only here — they can be published/hidden but never edited
// or deleted through this screen, so the live runs can't be reconfigured by accident.
const PROGRAM_CODE_IDS = new Set([1, 2, 3, 90]);
const DEMO_PROGRAM_ID = 90;
function programAdminRows() {
  return db.prepare('SELECT * FROM program ORDER BY id').all().map(row => {
    const p = PROGRAMS.get(row.id);
    let spec = null; try { spec = JSON.parse(row.config || 'null'); } catch {}
    const counts = db.prepare('SELECT (SELECT COUNT(*) FROM checkins WHERE program_id=?) c, (SELECT COUNT(*) FROM attendance WHERE program_id=?) a, (SELECT COUNT(*) FROM group_messages WHERE program_id=?) m, (SELECT COUNT(*) FROM program_membership WHERE program_id=?) mem').get(row.id, row.id, row.id, row.id);
    // NB: basketball's hand-written config predates the generic shape — it has NO `keys` object
    // (its setting names are inline) and carries start/end as 'HH:MM' strings rather than
    // startHour/endHour. Read defensively so this screen renders every program, old shape or new.
    const cfg = p ? p.config : null;
    const hour = (v) => (Number.isFinite(v) ? v : null);
    return {
      id: row.id, name: p ? p.displayName : row.name, slug: row.slug, active: !!row.active, approval: row.approval,
      editable: !PROGRAM_CODE_IDS.has(row.id), builtIn: PROGRAM_CODE_IDS.has(row.id),
      mounted: !!p, emoji: p ? p.emoji : (spec && spec.emoji) || '',
      runPath: p ? p.paths.run : (row.slug ? '/' + row.slug : ''),
      cap: cfg ? cfg.cap : null, dow: cfg && Number.isFinite(cfg.dow) ? cfg.dow : null,
      // One ready-to-print label, built here because lib/dates.js owns the clock formatter: the
      // generic shape carries whole hours, basketball carries 'HH:MM' strings — both render.
      timeLabel: !cfg ? ''
        : Number.isFinite(cfg.startHour) && Number.isFinite(cfg.endHour)
          ? fmtClockRange(startHHMM(cfg), endHHMM(cfg))
          : (cfg.start && cfg.end ? fmtClockRange(cfg.start, cfg.end) : ''),
      startHour: cfg ? hour(cfg.startHour) : null, endHour: cfg ? hour(cfg.endHour) : null,
      theme: cfg ? cfg.theme : '', spec,
      hasData: counts.c > 0 || counts.a > 0 || counts.m > 0, members: counts.mem,
      runDate: cfg ? (cfg.keys ? (getSetting(cfg.keys.runDate) || '') : nextRunDate()) : '',
      seasonStart: cfg && cfg.keys ? (getSetting(cfg.keys.seasonStart) || '') : '',   // wizard edit form field (F6 follow-up)
      // Per-program kiosk link (proposal #3): its own token, falling back to the global-era one.
      kioskUrl: (() => { const t = getSetting(`kiosk_token_${row.id}`) || getSetting('kiosk_token'); return t ? `/kiosk/${row.id}?k=${t}` : ''; })(),
    };
  });
}
// Validate + normalize the wizard's input into the stored spec. Returns {spec, name, slug, approval}
// or {error}. Everything the engine needs is either validated here or derived in defFromRow.
function parseProgramForm(body, { existingSlug = null, app } = {}) {
  const name = String(body.name || '').trim().slice(0, 40);
  if (name.length < 2) return { error: 'Give the program a name (at least 2 characters).' };
  // The name is a DISPLAY string that reaches page headings, aria-labels, placeholders and push
  // copy. Restrict it to characters a program name actually needs — letters (any language),
  // digits, spaces, and . - / + — so no markup or quote character can ever be stored. The views
  // escape it too; this is the input contract that makes the stored value safe by construction.
  if (!/^[\p{L}\p{N} .\-/+]{2,40}$/u.test(name))
    return { error: 'The program name can use letters, numbers, spaces and . - / + only.' };
  const emoji = String(body.emoji || '🏅').trim().slice(0, 4) || '🏅';
  if (/[<>"'`&\\]/.test(emoji)) return { error: 'Pick a plain emoji for the icon.' };
  const slug = String(body.slug || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,20}$/.test(slug)) return { error: 'The web address can only use lowercase letters, numbers and dashes (2–21 characters, starting with a letter).' };
  if (slug !== existingSlug) {
    // Program-collision FIRST: a mounted program's routes also make its slug "reserved", and
    // "another program already uses this" is the message that tells the admin what to actually do.
    if (db.prepare('SELECT 1 FROM program WHERE slug = ?').get(slug)) return { error: `Another program already uses “/${slug}”.` };
    if (slugIsReserved(slug, app)) return { error: `“/${slug}” is already used by the app — pick a different web address.` };
  }
  const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
  const cap = int(body.cap, 0), waitlist = int(body.waitlist, 0), prereg = int(body.prereg, 0);
  if (cap < 1 || cap > 200) return { error: 'Floor size must be between 1 and 200.' };
  if (waitlist < 0 || waitlist > 50) return { error: 'Waitlist size must be between 0 and 50.' };
  if (prereg < 0 || prereg > cap) return { error: 'Early-access spots can’t exceed the floor size.' };
  const dow = int(body.dow, -1);
  if (dow < 0 || dow > 6) return { error: 'Pick which day of the week the run happens.' };
  const startHour = int(body.startHour, -1), endHour = int(body.endHour, -1);
  if (startHour < 0 || startHour > 23) return { error: 'Pick a valid start time.' };
  if (endHour <= startHour || endHour > 24) return { error: 'The end time has to be after the start time.' };
  const hhmm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
  const lockTime = hhmm(body.lockTime) ? String(body.lockTime) : `${String(startHour).padStart(2, '0')}:00`;
  const confirmMode = String(body.confirmMode || 'none');
  let confirmCutoff = null;
  if (confirmMode === 'cutoff') {
    if (!hhmm(body.confirmCutoff)) return { error: 'Give the confirm deadline as a time like 16:30.' };
    confirmCutoff = String(body.confirmCutoff);
  }
  const teamsCount = int(body.teamsCount, 0), teamsSize = int(body.teamsSize, 0);
  if (teamsCount < 0 || teamsCount > 12) return { error: 'Teams: pick between 0 and 12.' };
  if (teamsCount > 0 && (teamsSize < 1 || teamsSize > 30)) return { error: 'Team size must be between 1 and 30.' };
  const partySize = int(body.partySize, 0);
  if (partySize < 0 || partySize > 12) return { error: 'Group sign-up size must be between 0 and 12.' };
  // joinMode is ENFORCED now (F3: runJoinRun + memberOf + the request flow), so the picker is
  // honest again. The legacy `approval` column stays 'open' — joinMode in the spec is the authority.
  const joinMode = ['open', 'invite', 'host'].includes(body.joinMode) ? body.joinMode : 'open';
  const approval = 'open';
  // Positions (F6): one per line, "CODE Label" (e.g. "GK Goalkeeper"). Codes are what get stored
  // on profiles; labels are the chip captions. Empty = this program has no position picker.
  const positions = String(body.positions || '').split(/\r?\n/)
    .map(l => l.trim()).filter(Boolean).slice(0, 16)
    .map(l => { const sp = l.search(/\s/); return sp < 0 ? [l, ''] : [l.slice(0, sp), l.slice(sp + 1).trim()]; })
    .map(([c, l]) => [c.toUpperCase().slice(0, 6), l.slice(0, 24)])
    .filter(([c]) => /^[A-Z0-9]+$/.test(c));
  const spec = {
    displayName: name, emoji, joinMode,
    cap, waitlist, prereg,
    dow, startHour, endHour,
    lockTime, confirmCutoff,
    pingHour: 9, pingDowOffset: 0, openOffsetDays: -7,
    theme: PROGRAM_THEMES.includes(body.theme) ? body.theme : 'default',
    offerWindow: body.seating === 'offer',
    autoRenew: body.autoRenew === '1',
    teams: teamsCount > 0 ? { count: teamsCount, size: teamsSize } : null,
    groupQueue: partySize > 1 ? { maxSize: partySize } : null,
    positions: positions.length ? positions : null,
    // Own waiver + guardian consent (F6 youth pack). Guardian consent implies an own waiver —
    // the consent attestation lives ON the program's waiver record. waiverKey is stamped by the
    // create route (frozen at the creation-time slug) so renames never orphan signed records.
    waiver: (body.waiverMode === 'own' || body.waiverGuardian === '1')
      ? { own: true, guardian: body.waiverGuardian === '1' } : null,
  };
  return { spec, name, slug, approval };
}

export function mountProgramsAdmin(app) {
  app.get('/admin/programs', requireAdmin, (req, res) => {
    res.send(programsAdminPage({ rows: programAdminRows(), msg: req.query.msg || '', form: req.query.form === '1', themes: PROGRAM_THEMES, kioskToken: getSetting('kiosk_token') || '' }));
  });
  app.post('/admin/programs/create', requireAdmin, (req, res) => {
    const parsed = parseProgramForm(req.body, { app: req.app });
    if (parsed.error) return res.redirect('/admin/programs?form=1&msg=' + encodeURIComponent(parsed.error));
    if (parsed.spec.waiver) parsed.spec.waiverKey = parsed.slug;   // frozen forever — renames must not orphan signed waiver records (F6)
    // ids 4..89 are the in-app range (90 is the demo showcase, reserved).
    const maxRow = db.prepare('SELECT MAX(id) m FROM program WHERE id < ?').get(DEMO_PROGRAM_ID);
    const id = Math.max(4, (maxRow.m || 3) + 1);
    if (id >= DEMO_PROGRAM_ID) return res.redirect('/admin/programs?msg=' + encodeURIComponent('Program limit reached — archive an old program first.'));
    try {
      db.prepare('INSERT INTO program (id,name,sport,slug,active,approval,config) VALUES (?,?,?,?,0,?,?)')
        .run(id, parsed.name, parsed.slug, parsed.slug, parsed.approval, JSON.stringify(parsed.spec));
    } catch (e) {
      return res.redirect('/admin/programs?form=1&msg=' + encodeURIComponent('Couldn’t create that program: ' + e.message.slice(0, 100)));
    }
    buildPrograms();            // registry + view meta + PCO sport labels
    mountPendingPrograms(app);     // routes live immediately — no restart
    // Season start from the form (F6 follow-up) — after buildPrograms so P(id) exists. Invalid dates
    // don't block creation; the program lands and the message says what to fix.
    const season = applySeasonStart(id, req.body.seasonStart);
    audit(req.userEmail, 'admin', 'program:create', `${id}:${parsed.slug}`);
    res.redirect('/admin/programs?msg=' + encodeURIComponent(`Created ${parsed.name}.` +
      (season.err ? ' The season date didn’t look right (not past, within a year) — set it in its Settings.' : '') +
      ` It's hidden — publish it when it's ready.`));
  });
  app.post('/admin/programs/edit', requireAdmin, (req, res) => {
    const id = Number(req.body.id);
    const row = db.prepare('SELECT * FROM program WHERE id = ?').get(id);
    if (!row) return res.redirect('/admin/programs?msg=' + encodeURIComponent('No such program.'));
    if (PROGRAM_CODE_IDS.has(id)) return res.redirect('/admin/programs?msg=' + encodeURIComponent('Basketball, pickleball, volleyball and the demo are managed in code — they can be published or hidden here, not edited.'));
    const parsed = parseProgramForm(req.body, { existingSlug: row.slug, app: req.app });
    if (parsed.error) return res.redirect('/admin/programs?msg=' + encodeURIComponent(parsed.error));
    // Waiver key survives every edit (F6): carry the creation-time stamp; a program that ENABLES
    // its own waiver later gets stamped with its current slug from that moment on.
    if (parsed.spec.waiver) {
      let oldKey = null;
      try { oldKey = (JSON.parse(row.config || '{}') || {}).waiverKey || null; } catch {}
      parsed.spec.waiverKey = oldKey || row.slug;
    }
    transact(() => {
      db.prepare('UPDATE program SET name=?, sport=?, slug=?, approval=?, config=? WHERE id=?')
        .run(parsed.name, parsed.slug, parsed.slug, parsed.approval, JSON.stringify(parsed.spec), id);
      // A slug rename moves the program's ENTIRE app_settings namespace (run date, season start,
      // scheduler markers, chat sequence — all keyed <slug>_*). Without this carry, the renamed
      // program silently loses its run date and re-fires open/lock/sweep once, and the old rows
      // leak forever.
      if (parsed.slug !== row.slug) {
        for (const suf of ['run_date', 'run_base', 'season_start', 'autoopen_done', 'autoping_done',
                           'autolock_done', 'arassess_done', 'confirmsweep_done', 'chat_seq']) {
          const v = getSetting(`${row.slug}_${suf}`);
          if (v != null) { setSetting(`${parsed.slug}_${suf}`, v); }
          delSetting(`${row.slug}_${suf}`);
        }
      }
    });
    buildPrograms();
    // A slug change means new paths: mount the new ones (the old routes stay registered but their
    // program is gone from the registry, so they 404 through the normal gate — never a stale run).
    MOUNTED_PROGRAMS.delete(id);
    mountPendingPrograms(app);
    // Season start rides the same form (F6 follow-up): unchanged is a no-op; blanking clears the gate.
    const season = applySeasonStart(id, req.body.seasonStart);
    audit(req.userEmail, 'admin', 'program:edit', `${id}:${parsed.slug}`);
    res.redirect('/admin/programs?msg=' + encodeURIComponent(season.err
      ? 'Saved — but the season date didn’t look right (not past, within a year), so it wasn’t changed.'
      : 'Saved'));
  });
  // F2/F3: per-program member management (admin). Hosts approve REQUESTS on the run page; roles and
  // invite-mode additions are an admin action here, so host-granting stays with the org owner.
  app.post('/admin/programs/member', requireAdmin, (req, res) => {
    const id = Number(req.body.id);
    const email = String(req.body.email || '').trim().toLowerCase();
    const act = String(req.body.act || '');
    if (!PROGRAMS.has(id) || id === 90) return res.redirect('/admin/programs?msg=' + encodeURIComponent('No such program.'));
    if (!isValidEmail(email)) return res.redirect('/admin/programs?msg=' + encodeURIComponent('That email doesn’t look valid.'));
    const a = applicantByEmail(email);
    const back = (m) => res.redirect('/admin/programs?msg=' + encodeURIComponent(m));
    if (act === 'add' || act === 'host') {
      if (!a || a.status !== 'approved') return back('They need an approved app account first (People & invites).');
      joinProgramMembership(id, email);   // approved membership (no-op if already a member)
      db.prepare("UPDATE program_membership SET status = 'approved', role = ? WHERE program_id = ? AND email = ?")
        .run(act === 'host' ? 'host' : 'approved', id, email);
      audit(req.userEmail, 'admin', act === 'host' ? 'program:host-granted' : 'program:member-added', `${id}:${email}`);
      if (act === 'host') setImmediate(() => sendPush([email], {
        title: `You're a host — ${P(id).displayName}`,
        body: 'You can open/close check-in, post announcements, add guests and approve join requests for this run.',
        url: P(id).paths.run, tag: `host${id}`,
      }));
      return back(act === 'host' ? `${a.full_name} is now a host of ${P(id).displayName}.` : `${a.full_name} added to ${P(id).displayName}.`);
    }
    if (act === 'unhost') {
      db.prepare("UPDATE program_membership SET role = 'approved' WHERE program_id = ? AND email = ? AND role = 'host'").run(id, email);
      audit(req.userEmail, 'admin', 'program:host-revoked', `${id}:${email}`);
      return back('Host role removed (they stay a member).');
    }
    if (act === 'remove') {
      db.prepare('DELETE FROM program_membership WHERE program_id = ? AND email = ?').run(id, email);
      audit(req.userEmail, 'admin', 'program:member-removed', `${id}:${email}`);
      return back('Removed from the program (their app account is untouched).');
    }
    back('Unknown action.');
  });
  app.post('/admin/programs/active', requireAdmin, (req, res) => {
    const id = Number(req.body.id), on = req.body.on === '1';
    const row = db.prepare('SELECT * FROM program WHERE id = ?').get(id);
    if (!row) return res.redirect('/admin/programs?msg=' + encodeURIComponent('No such program.'));
    if (id === 1) return res.redirect('/admin/programs?msg=' + encodeURIComponent('The basketball run is always live.'));
    db.prepare('UPDATE program SET active=? WHERE id=?').run(on ? 1 : 0, id);
    buildPrograms();
    audit(req.userEmail, 'admin', on ? 'program:publish' : 'program:hide', `${id}:${row.slug}`);
    res.redirect('/admin/programs?msg=' + encodeURIComponent(on
      ? `${row.name} is live — every approved member can see it now.`
      : `${row.name} is hidden again (admins only).`));
  });
  app.post('/admin/programs/delete', requireAdmin, (req, res) => {
    const id = Number(req.body.id);
    const row = db.prepare('SELECT * FROM program WHERE id = ?').get(id);
    if (!row) return res.redirect('/admin/programs?msg=' + encodeURIComponent('No such program.'));
    if (PROGRAM_CODE_IDS.has(id)) return res.redirect('/admin/programs?msg=' + encodeURIComponent('That program is managed in code and can’t be deleted here.'));
    // Never silently destroy history: a program that has ANY rosters, attendance or chat can only be
    // hidden. Delete is for a mis-created program, and even then it's an explicit empty-only path.
    // The ladder counts as history. A run whose ATTENDANCE lives in Planning Center and whose only
    // record here is the board (exactly pickleball's shape) has zero checkins and zero attendance —
    // without this term the guard called a whole season "empty" and offered to delete it.
    const used = db.prepare(`SELECT (SELECT COUNT(*) FROM checkins WHERE program_id=?) c, (SELECT COUNT(*) FROM attendance WHERE program_id=?) a,
                                  (SELECT COUNT(*) FROM group_messages WHERE program_id=?) m, (SELECT COUNT(*) FROM ladder_games WHERE program_id=?) l,
                                  (SELECT COUNT(*) FROM run_headcount WHERE program_id=?) h`).get(id, id, id, id, id);
    if (used.c || used.a || used.m || used.l || used.h)
      return res.redirect('/admin/programs?msg=' + encodeURIComponent(`${row.name} already has sign-ups, attendance, chat or ladder history — hide it instead of deleting, so the records survive.`));
    // Every program_id-scoped table, so a later program can't inherit orphans if this id is reused.
    // (P2-3: run_summary + metrics_events joined this list when the metrics layer shipped — ids ARE
    // reused, and INSERT OR IGNORE on run_summary's PK would silently keep a dead program's rows in
    // a new program's demand card.)
    const cfg = (PROGRAMS.get(id) || {}).config || {};
    transact(() => {
      for (const t of ['program_membership', 'run_state', 'run_overrides', 'announcements', 'group_reads',
                       'regular_optout', 'team_assignments', 'group_reactions', 'votes', 'run_summary', 'metrics_events',
                       'ladder_games', 'ladder_players', 'ladder_nominations', 'run_headcount',
                       'run_roster', 'run_games'])
        db.prepare(`DELETE FROM ${t} WHERE program_id=?`).run(id);
      // run_game_players has no program_id of its own — reach it through the games just deleted, or
      // a reused id inherits orphaned seats pointing at game rows that no longer exist.
      db.prepare('DELETE FROM run_game_players WHERE game_id NOT IN (SELECT id FROM run_games)').run();
      // Announcement dismissals key by announcement id — sweep rows orphaned by the announcements delete.
      db.prepare('DELETE FROM announcement_dismissals WHERE announcement_id NOT IN (SELECT id FROM announcements)').run();
      // Parties for this run are keyed by group, not program_id — reach them through their run rows.
      const groups = db.prepare('SELECT id FROM signup_groups WHERE program_id=?').all(id).map(r => r.id);
      if (groups.length) {
        const ph = groups.map(() => '?').join(',');
        db.prepare(`DELETE FROM signup_group_members WHERE group_id IN (${ph})`).run(...groups);
        db.prepare('DELETE FROM signup_groups WHERE program_id=?').run(id);
      }
      // Its own waiver records (F6) — keyed by the frozen waiver key, not program_id. Delete is the
      // empty-only path, but a signed record CAN exist for a program nobody ever checked into; those
      // attestations die with the program (guardian contact details included — they're PII).
      if (cfg.waiver && cfg.waiver.key) db.prepare('DELETE FROM waiver_records WHERE waiver_key=?').run(cfg.waiver.key);
      db.prepare('DELETE FROM program WHERE id=?').run(id);
    });
    // Its whole app_settings namespace: the scheduler keys AND chatSeqKey, which lives beside
    // `keys` rather than inside it (a keys-only loop leaked <slug>_chat_seq on every delete).
    for (const k of Object.values(cfg.keys || {})) delSetting(k);
    if (cfg.chatSeqKey) delSetting(cfg.chatSeqKey);
    // Keys built from the program ID rather than its slug, so they are not in cfg.keys. The kiosk
    // token matters most: ids ARE reused, and a surviving token would leave an old wall-board link
    // (already on a projector, already texted around) opening the NEXT program that takes this id.
    delSetting(`kiosk_token_${id}`);
    delSetting(ladderNomsKey(id));
    buildPrograms();
    MOUNTED_PROGRAMS.delete(id);
    audit(req.userEmail, 'admin', 'program:delete', `${id}:${row.slug}`);
    res.redirect('/admin/programs?msg=' + encodeURIComponent(`${row.name} was removed.`));
  });
}
