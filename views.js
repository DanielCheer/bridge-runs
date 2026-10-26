// views.js — server-rendered pages. No template engine; plain template literals.
import { esc, fmtWhen, wdayFull, wdayShort } from './views/util.js';
import {
  qrBlock, homeScreenCard, avatarInner, tabNav, opsNav, backToRuns, firstRunTour, backBtn, copyBtn,
  shareBtn, shareScript,
} from './views/components.js';
import { HEAD, FOOT, header, footWithTabs } from './views/shell.js';
export {
  threadPage,
} from './views/pages/messages.js';
export {
  runPage, pickleballPage,
} from './views/pages/run.js';
export {
  runsPage, runJoinPage, pkJoinPage, pastRunPage, seasonPage,
} from './views/pages/runs-hub.js';
export {
  friendsSearchFragment, friendsPage,
} from './views/pages/friends.js';
export {
  demoProfileCard, profileCard, profilePage, profileTabPage,
} from './views/pages/profile.js';
export {
  chatPage, runChatPage, chatOlderFragment, chatLockedPage,
} from './views/pages/chat.js';
export {
  checkinPage, claimResultPage,
} from './views/pages/checkin.js';
export {
  invitePage,
} from './views/pages/invite.js';
export {
  loginPage,
} from './views/pages/login.js';
export {
  intakePage,
} from './views/pages/intake.js';
export {
  BUILD_VER, setDemoMode,
} from './views/shell.js';
export {
  STICKERS,
} from './views/chat-ui.js';
export {
  setAvatarMap, avatarUrlFor, setProgramMeta,
} from './views/components.js';
export {
  APP_JS,
} from './views/client-app.js';

// ---------- ADMIN / COUNCIL ----------
export function adminPage({ applicants, runLabel, runDate = '', hours = '8:30–10:30 PM', checkedInCount, cap,
                           waitlistCap = 5, preregCap = 10, msg = '',
                           viewerIsAdmin = true, viewerIsTeam = false, viewerIsHost = false, viewerCanVote = false, viewerEmail = '', log = [],
                           filter = 'all', counts = {}, teamMembers = [], ann = null,
                           dmUnread = 0, groupUnread = 0, groupMention = 0 }) {
  const pill = (s) => `<span class="pill ${s}">${s}</span>`;
  // Map a voter email → their display name (voters are always team members, so the
  // council roster covers every one). Falls back to the raw email if somehow unseen.
  // esc() is applied here so a name containing markup is safe wherever it's rendered.
  const nameByEmail = new Map(teamMembers.map(m => [m.email.toLowerCase(), m.full_name]));
  const voterName = (e) => esc(nameByEmail.get(String(e).toLowerCase()) || e);
  const voteBtn = (id, vote, label, cls, active) =>
    `<form method="POST" action="/admin/vote" class="swapform"><input type="hidden" name="id" value="${id}"><input type="hidden" name="vote" value="${vote}"><button class="btn ${cls} sm${active ? ' voted' : ''}" type="submit">${active ? '✓ ' : ''}${label}</button></form>`;

  const rows = applicants.map((a, __i) => {
    const isSelf = a.email === viewerEmail;
    // Role toggles — ADMIN ONLY. Making team auto-approves; regular needs approved.
    const roleBtn = (role, flag, onLabel, offLabel, show) => (!viewerIsAdmin || !show) ? '' : (flag
      ? `<form method="POST" action="/admin/role" class="swapform"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="role" value="${role}"><input type="hidden" name="on" value="0"><button class="btn sm regstar" type="submit">${onLabel}</button></form>`
      : `<form method="POST" action="/admin/role" class="swapform"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="role" value="${role}"><input type="hidden" name="on" value="1"><button class="btn ghost sm" type="submit">${offLabel}</button></form>`);
    const teamBtn = roleBtn('team', a.is_team, '◆ Team — remove', 'Make team', true);
    // Make Pillar auto-approves (like team), so it's offered for pending applicants too, not just approved.
    const regBtn  = roleBtn('regular', a.is_regular, '★ Pillar — remove', 'Make Pillar', true);
    const hostBtn = roleBtn('host', a.is_host, '★ Host — remove', 'Make Host', a.status === 'approved' && viewerIsAdmin);
    // Council = a vote on applicants and nothing else (its own role — not team, not admin).
    const councilBtn = roleBtn('council', a.is_council, '⚖ Council — remove', 'Add to council', a.status === 'approved' && viewerIsAdmin);

    // Team members are auto-approved and not voted on.
    let decisionBlock;
    if (a.is_team) {
      decisionBlock = `<div class="ad" style="margin-top:10px">◆ Team — auto-approved, no vote needed.</div>
        <div class="acts">${teamBtn}${regBtn}${hostBtn}${councilBtn}</div>`;
    } else {
      const v = a.vote || { poolSize: 0, threshold: 3, approved: [], rejected: [], waiting: [], myVote: null };
      const th = v.threshold || 3;
      const tally = `<div class="tally"><span class="vc-approve"><b>${v.approved.length}/${th}</b> approvals</span>${v.rejected.length ? ` · <span class="vc-reject"><b>${v.rejected.length}/${th}</b> rejects</span>` : ''} <span class="tally-note">(${th} to decide)</span></div>`;
      // Vote transparency — ADMIN ONLY (owner's call). Non-admin team members keep
      // seeing only the tally + their own vote highlight (below), never who cast what.
      // Maps voter emails → names via the council roster. e.g. "Approved by Nic, Sarah
      // · Rejected by Mike".
      const whoVoted = viewerIsAdmin ? (() => {
        const parts = [];
        if (v.approved.length) parts.push(`<span class="vc-approve">Approved by ${v.approved.map(voterName).join(', ')}</span>`);
        if (v.rejected.length) parts.push(`<span class="vc-reject">Rejected by ${v.rejected.map(voterName).join(', ')}</span>`);
        return parts.length ? `<div class="tally-note">${parts.join(' · ')}</div>` : '';
      })() : '';
      // admin-only: who's still to vote (names, not raw emails)
      const waiting = (viewerIsAdmin && v.waiting.length && a.status === 'pending')
        ? `<div class="tally-note">Waiting on: ${v.waiting.map(voterName).join(', ')}</div>` : '';
      const voteButtons = !viewerCanVote
        ? '<span class="ad" style="margin:0">The council decides — you have oversight, not a vote.</span>'
        : (isSelf
          ? '<span class="ad" style="margin:0">Your own application — you can\'t vote.</span>'
          : `${voteBtn(a.id, 'approve', 'Approve', 'approve', v.myVote === 'approve')}
             ${voteBtn(a.id, 'reject', 'Reject', 'leave', v.myVote === 'reject')}`);
      const resetBtn = viewerIsAdmin
        ? `<form method="POST" action="/admin/reset" class="swapform"><input type="hidden" name="id" value="${a.id}"><button class="btn ghost sm" type="submit">Reset votes</button></form>` : '';
      decisionBlock = `${tally}${whoVoted}${waiting}
        <div class="acts"${__i === 0 ? ' data-tour="council"' : ''}>${voteButtons}${resetBtn}${teamBtn}${regBtn}${hostBtn}${councilBtn}</div>`;
    }

    return `<details class="arow"${a.status === 'pending' ? ' open' : ''}>
    <summary><span class="an">${esc(a.full_name)}${a.is_host ? ' <span class="tag host">★ Host</span>' : ''}${a.is_team ? ' <span class="tag team">◆ Team</span>' : ''}${a.is_regular ? ' <span class="tag reg">★ Pillar</span>' : ''}</span> ${pill(a.status)}</summary>
    <div class="ae" style="margin-top:12px">${esc(a.email)} · ${esc(a.phone)}</div>
    <div class="ad"><b>${esc(a.experience)}</b>${a.where_played ? ' — ' + esc(a.where_played) : ''}<br>
      Waiver: ${a.waiver_ok ? '✓ confirmed' : '✗ not confirmed'} · applied ${esc(fmtWhen(a.created_at))}</div>
    ${decisionBlock}
  </details>`;
  }).join('');

  const logBlock = (viewerIsAdmin && log.length)
    ? `<details class="announce-compose" style="margin-top:20px"><summary>Audit log — last ${log.length}</summary>
       <div class="card" style="padding:12px 14px;margin-top:8px">${log.map(l =>
         `<div style="font-size:12.5px;color:var(--muted);padding:5px 0;border-bottom:1px solid var(--line)">
            <b style="color:var(--ink)">${esc(l.actor)}</b> <span class="tag ${l.actor_role==='admin'?'team':'reg'}" style="padding:1px 6px">${l.actor_role}</span>
            ${esc(l.action)} → ${esc(l.target)}<br><span style="opacity:.7">${esc(l.at)} UTC</span>
          </div>`).join('')}</div></details>`
    : '';

  const tab = (key, label) => {
    const n = counts[key] ?? 0;
    const active = filter === key;
    return `<a href="/admin?status=${key}" class="ftab${active ? ' on' : ''}">${label} <span class="fcount">${n}</span></a>`;
  };
  const filterTabs = `<div class="ftabs">
    ${tab('all', 'All')}${tab('pending', 'Pending')}${tab('approved', 'Approved')}${tab('rejected', 'Rejected')}
  </div>`;
  const emptyMsg = filter === 'all' ? 'No applications yet.' : `No ${filter} applicants.`;

  // "The Council" — the voting pool (is_team=1). Shown to ALL operators (admin +
  // team) so everyone can see who decides. Reuses the roster row styling; host is
  // badged distinctly from team.
  const councilRoster = teamMembers.length ? `
    <div class="subhead">The Council · ${teamMembers.length} voting</div>
    <div class="card" style="padding:10px 14px;margin-top:6px">
      <div class="roster">${teamMembers.map(m =>
        `<div class="r"><span class="av">${avatarInner(m.email, m.full_name)}</span><span class="nm">${esc(m.full_name)}</span><span class="bdg team">⚖ Council</span></div>`
      ).join('')}</div>
    </div>` : '';

  return HEAD('Council — The Bridge', 'has-tabs') + header(`<b>COUNCIL</b>${viewerIsAdmin ? 'admin' : (viewerCanVote ? 'council' : 'team')}`, wdayShort(runDate), ann, hours) + `
    ${backBtn('/checkin')}
    ${opsNav('admin', { isAdmin: viewerIsAdmin, isTeam: viewerIsTeam, isCouncil: viewerCanVote })}${firstRunTour}
    <div class="rule"></div>
    <span class="eyebrow">${applicants.length} ${filter === 'all' ? 'applicant' : filter}${applicants.length===1?'':'s'}</span>
    <h1>Council review</h1>
    <p class="lead">${viewerCanVote
      ? 'It takes <b>3 approvals</b> to get an applicant in, or <b>3 rejects</b> to block them. Cast your vote below.'
      : 'Approval is decided by the <b>council</b>: 3 approvals gets an applicant in, 3 rejects blocks them. You have oversight and manage people, but you don\'t vote. Team members are auto-approved and skip the vote.'}</p>
    <div class="notice">This ${wdayFull(runDate)} (${esc(runLabel)}): <b>${checkedInCount}/${cap}</b> checked in.</div>
    ${msg ? `<div class="notice good">${esc(msg)}</div>` : ''}
    ${viewerIsAdmin ? `<details class="announce-compose" style="margin-top:12px"><summary>⚙️ Run settings — capacity</summary>
      <form method="POST" action="/admin/settings" class="editrow swapform" style="margin-top:10px">
        <label>Floor cap <span style="text-transform:none;font-weight:400;color:var(--muted)">(players in the run)</span><input name="run_cap" type="number" min="1" max="100" inputmode="numeric" value="${cap}"></label>
        <label>Waitlist cap<input name="waitlist_cap" type="number" min="0" max="100" inputmode="numeric" value="${waitlistCap}"></label>
        <label>Pre-register cap <span style="text-transform:none;font-weight:400;color:var(--muted)">(team + core spots held while closed)</span><input name="prereg_cap" type="number" min="0" max="100" inputmode="numeric" value="${preregCap}"></label>
        <p class="tally-note" style="margin:2px 0 0">Takes effect on the next check-in — no restart. Applies to the current + future runs.</p>
        <div class="editacts"><button class="btn sm" type="submit">Save settings</button></div>
      </form>
    </details>` : ''}
    ${councilRoster}
    ${filterTabs}
    ${rows || `<div class="card">${emptyMsg}</div>`}
    ${logBlock}
    <div class="foot" style="margin-top:24px"><a href="/logout">Sign out</a></div>
  ` + footWithTabs(tabNav('', { dm: dmUnread, group: groupUnread, groupMention }));
}

// ---------- STATUS PAGE (unapproved players) ----------
// ---------- ANALYTICS (F5) — the church's trend view ----------
// Server-rendered bars (pure divs — no chart lib, nothing external). Newcomers render as the
// darker base slice of each bar so "how many were NEW" reads at a glance.
export function analyticsPage({ cards = [], pulse = null }) {
  const chart = (runs) => {
    const max = Math.max(...runs.map(r => r.n), 1);
    return `<div style="display:flex;align-items:flex-end;gap:6px;height:120px;margin:12px 0 4px">
      ${runs.map(r => {
        const h = Math.round((r.n / max) * 110), nh = Math.round((r.newcomers / max) * 110);
        return `<div title="${esc(r.run_date)}: ${r.n} (${r.newcomers} new)" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:110px">
          <div style="height:${h - nh}px;background:#d8b98a;border-radius:4px 4px 0 0"></div>
          <div style="height:${nh}px;background:#22615a;border-radius:${h === nh ? '4px 4px 0 0' : '0'}"></div>
        </div>`;
      }).join('')}
    </div>
    <div style="display:flex;gap:6px">${runs.map(r => `<span style="flex:1;text-align:center;font-size:10px;color:var(--muted)">${esc(r.run_date.slice(5))}</span>`).join('')}</div>`;
  };
  const card = (c) => `<div class="card rail" style="margin-top:12px">
    <div class="subhead" style="margin-top:0">${esc(c.emoji)} ${esc(c.name)}</div>
    ${chart(c.runs)}
    <p class="tally-note" style="margin:10px 0 0"><span style="display:inline-block;width:10px;height:10px;background:#22615a;border-radius:2px"></span> newcomers · <span style="display:inline-block;width:10px;height:10px;background:#d8b98a;border-radius:2px"></span> returning</p>
    <p style="margin:10px 0 0">This year: <b>${c.total}</b> check-ins by <b>${c.uniques}</b> people.${c.retained != null ? ` Over the last 4 runs: <b>${c.active4}</b> played, <b>${c.retained}</b> came to 3+ (the regulars).` : ''}</p>
    ${c.demand ? `<p style="margin:10px 0 0">Demand (${c.demand.runs} summarized run${c.demand.runs === 1 ? '' : 's'}): avg <b>${esc(c.demand.avgWait)}</b> waitlisted${c.demand.fillMins != null ? ` · floor fills in ~<b>${esc(c.demand.fillMins)} min</b>` : ''}${c.demand.claimPct != null ? ` · <b>${esc(c.demand.claimPct)}%</b> of freed spots claimed` : ''}.</p>` : ''}
  </div>`;
  return HEAD('Analytics — The Bridge', '', { wall: false }) + header('<b>ANALYTICS</b>') + `
    ${backBtn('/admin/people')}
    <div class="rule"></div>
    <span class="eyebrow">Attendance trends</span>
    <h1 style="margin-bottom:0">How the runs are doing</h1>
    ${pulse && (pulse.mau || pulse.pushes30 || pulse.installs) ? `<div class="card rail" style="margin-top:12px">
      <div class="subhead" style="margin-top:0">📡 Engagement pulse</div>
      <p style="margin:0">Active members: <b>${pulse.wau}</b> this week · <b>${pulse.mau}</b> this month.
      Notifications (30d): <b>${pulse.pushes30}</b> sent to devices${pulse.taps30 ? ` · <b>${pulse.taps30}</b> opened from a notification` : ''}.
      Home-screen installs recorded: <b>${pulse.installs}</b>.</p>
      ${(pulse.kinds || []).length ? `<p style="margin:8px 0 0">By kind (30d): ${pulse.kinds.map((k) => `<b>${esc(k.label)}</b> ${k.sent} sent${k.opened ? ` · ${k.opened} opened${k.sent ? ` (${Math.min(100, Math.round((k.opened / k.sent) * 100))}%)` : ''}` : ''}`).join(' &nbsp;·&nbsp; ')}</p>` : ''}
      <p class="tally-note" style="margin:8px 0 0">Counting started Aug 2026 — actives need a day of traffic, installs count from now on. <a href="/admin/history">Full run history ›</a></p>
    </div>` : ''}
    ${cards.length ? cards.map(card).join('') : '<p class="lead" style="margin-top:12px">No attendance history yet — charts appear after the first archived run.</p>'}
    <div class="foot" style="margin-top:24px"><a href="/admin/people">‹ Back to People &amp; invites</a></div>
  ` + FOOT;
}

// ---------- RUN HISTORY — per-run receipts from run_summary (proposal #1) ----------
// One table row per archived run night, per program: demand, fill speed, offer outcomes.
// Read-only; the CSV link exports everything for spreadsheets / the pitch deck.
export function runHistoryPage({ sections = [] }) {
  const row = (r) => `<tr${r.cancelled ? ' style="opacity:.55"' : ''}>
    <td style="white-space:nowrap">${esc(r.run_date)}${r.cancelled ? ' <span class="tag susp">cancelled</span>' : ''}</td>
    <td>${r.floor_n}${r.cap ? ` / ${r.cap}` : ''}</td>
    <td>${r.wait_n || '—'}</td>
    <td>${r.guest_n || '—'}</td>
    <td>${r.fill_mins != null ? `${r.fill_mins} min` : '—'}</td>
    <td>${r.offers_sent ? `${r.offers_sent} → ${r.offers_claimed} claimed${r.offers_expired ? ` · ${r.offers_expired} expired` : ''}` : '—'}</td>
  </tr>`;
  const section = (s) => `<div class="card rail" style="margin-top:12px;overflow-x:auto">
    <div class="subhead" style="margin-top:0">${esc(s.emoji)} ${esc(s.name)}</div>
    <table class="audit-t">
      <thead><tr><th>Run</th><th>Floor</th><th>Waited</th><th>Guests</th><th>Filled in</th><th>Freed spots</th></tr></thead>
      <tbody>${s.rows.map(row).join('')}</tbody>
    </table>
  </div>`;
  return HEAD('Run history — The Bridge', '', { wall: false }) + header('<b>RUN HISTORY</b>') + `
    <style>.audit-t{width:100%;border-collapse:collapse;font-size:13px}.audit-t th{text-align:left;color:var(--muted);padding:4px 8px}.audit-t td{padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}</style>
    ${backBtn('/admin/people')}
    <div class="rule"></div>
    <span class="eyebrow">The permanent run record</span>
    <h1 style="margin-bottom:0">Run history</h1>
    <p class="lead" style="margin-top:8px">Every archived run night: who fit, who waited, how fast the floor filled, and what happened to freed spots. Collected automatically since Aug 2026. <a href="/admin/history.csv" download>⬇︎ CSV of everything</a></p>
    ${sections.length ? sections.map(section).join('') : '<p class="lead" style="margin-top:12px">Nothing yet — the first summary row is written the night a run is archived.</p>'}
    <div class="foot" style="margin-top:24px"><a href="/admin/people">‹ Back to People &amp; invites</a></div>
  ` + FOOT;
}

// ---------- AUDIT VIEWER — the S6 permanent record, readable + exportable ----------
// audit_key_events' only read surface. Server-rendered GET filters (native form, no SPA), 100/page,
// CSV link carries the active filters. Every cell esc()'d; the page never mutates anything.
export function auditViewerPage({ rows = [], actions = [], q = '', action = '', from = '', to = '', page = 0, hasMore = false, total = 0 }) {
  const qs = (p) => {
    const u = new URLSearchParams();
    if (q) u.set('q', q); if (action) u.set('action', action);
    if (from) u.set('from', from); if (to) u.set('to', to);
    if (p) u.set('page', String(p));
    const s = u.toString(); return s ? '?' + s : '';
  };
  const row = (r) => `<tr><td style="white-space:nowrap">${esc(r.at)}</td><td>${esc(r.actor)}<span class="tally-note"> · ${esc(r.actor_role)}</span></td><td>${esc(r.action)}</td><td style="word-break:break-all">${esc(r.target)}</td></tr>`;
  return HEAD('Audit record — The Bridge', '', { wall: false }) + header('<b>AUDIT RECORD</b>') + `
    <style>.audit-t{width:100%;border-collapse:collapse;font-size:13px}.audit-t th{text-align:left;color:var(--muted);padding:4px 8px}.audit-t td{padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}</style>
    ${backBtn('/admin/people')}
    <div class="rule"></div>
    <span class="eyebrow">Permanent record</span>
    <h1 style="margin-bottom:0">Key events</h1>
    <p class="lead" style="margin-top:8px">Waiver verifications, role changes and admin sign-ins — kept forever, separate from the operational log that trims itself. Read-only.</p>
    <div class="card rail" style="margin-top:12px">
      <form method="GET" action="/admin/audit" class="editrow" style="align-items:flex-end;flex-wrap:wrap">
        <label style="flex:2;min-width:160px">Person / target<input name="q" value="${esc(q)}" placeholder="email or text"></label>
        <label style="flex:2;min-width:160px">Action<select name="action"><option value="">All actions</option>${actions.map((a) => `<option value="${esc(a)}"${a === action ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
        <label style="flex:1;min-width:130px">From<input type="date" name="from" value="${esc(from)}"></label>
        <label style="flex:1;min-width:130px">To<input type="date" name="to" value="${esc(to)}"></label>
        <button class="btn sm" type="submit">Filter</button>
      </form>
      <p class="tally-note" style="margin:10px 0 0">${total} event${total === 1 ? '' : 's'}${(q || action || from || to) ? ' match' : ' on record'} · <a href="/admin/audit.csv${qs(0)}" download>⬇︎ CSV of this view</a></p>
    </div>
    <div class="card rail" style="margin-top:12px;overflow-x:auto">
      ${rows.length ? `<table class="audit-t">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th></tr></thead>
        <tbody>${rows.map(row).join('')}</tbody>
      </table>` : '<p style="margin:0;color:var(--muted)">Nothing matches.</p>'}
      ${(page > 0 || hasMore) ? `<div style="display:flex;gap:10px;margin-top:12px">
        ${page > 0 ? `<a class="btn ghost sm" href="/admin/audit${qs(page - 1)}">‹ Newer</a>` : ''}
        ${hasMore ? `<a class="btn ghost sm" href="/admin/audit${qs(page + 1)}">Older ›</a>` : ''}
      </div>` : ''}
    </div>
    <div class="foot" style="margin-top:24px"><a href="/admin/people">‹ Back to People &amp; invites</a></div>
  ` + FOOT;
}

// ---------- KIOSK (F7) — big-screen live roster for the gym door ----------
// Self-contained page (no tabs, no session assumptions): giant type readable from metres away,
// refreshes itself every 8s by fetching its own URL and swapping the list (no SPA machinery).
export function kioskPage({ sport, emoji, theme = '', runDate = '', dateLabel = '', cap = 0, floor = [], wait = [], cancelled = false, door = null }) {
  // door = { live, arrived, walkIns } when PCO kiosk-arrivals is on and today is the run day:
  // rows gain an IN chip as the station taps people, the count line gains the building tally.
  // `live` false = first fetch hasn't landed yet — say "starting…" rather than a false zero.
  const row = (p, i, cls) => `<div class="krow ${cls}${p.arrived ? ' kinrow' : ''}"><span class="kn">${i + 1}</span><span class="kav">${avatarInner(p.email || '', p.name)}</span><span class="km">${esc(p.name)}${p.confirmed ? ' <span class="kc">✓</span>' : ''}${p.arrived ? ' <span class="kin">IN</span>' : ''}</span></div>`;
  const doorLine = !door ? '' : (door.live
    ? ` · ${door.arrived} in the building${door.walkIns ? ` · +${door.walkIns} walk-in${door.walkIns === 1 ? '' : 's'}` : ''}`
    : ' · door sync starting…');
  return HEAD(`${sport} — door`, `kiosk ${theme}`, { wall: false }) + `
    <style>
      body.kiosk{overflow:auto} body.kiosk .wrap{max-width:1100px;padding:28px}
      .khead{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:8px}
      .khead h1{font-size:44px;margin:0} .khead .kd{font-size:22px;color:var(--muted)}
      .kcount{font-size:26px;font-weight:800;margin:2px 0 18px}
      .kcols{display:grid;grid-template-columns:1fr 1fr;gap:28px}
      @media (max-width:700px){.kcols{grid-template-columns:1fr}}
      .ksec h2{font-size:20px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 10px}
      .krow{display:flex;gap:14px;align-items:center;padding:10px 14px;border:1px solid var(--line);border-radius:12px;margin-bottom:8px;background:var(--card)}
      .krow .kn{font-weight:800;font-size:22px;min-width:34px;color:var(--muted)}
      .kav{width:44px;height:44px;border-radius:50%;overflow:hidden;flex:none;display:grid;place-items:center;
        font-family:var(--head);font-weight:800;font-size:16px;color:#fff;background:linear-gradient(150deg,#2f7169,#1a453f)}
      .kav img{width:100%;height:100%;object-fit:cover}
      .krow .km{font-size:26px;font-weight:600} .kc{color:var(--good);font-weight:800}
      .krow.kw .km{font-size:22px;font-weight:500}
      .kin{background:#2e7d53;color:#fff;font-size:15px;font-weight:800;padding:2px 9px;border-radius:8px;vertical-align:2px;letter-spacing:.05em}
      .krow.kinrow{border-color:var(--good)}
      .kcxl{font-size:34px;font-weight:800;margin:40px 0;text-align:center}
      /* PIN-gated exit (owner ask 2026-08-05): the kiosk iPad shouldn't offer a way off this
         screen — no footer links here, and leaving goes through a 4-digit pad. A SOFT gate:
         it stops wandering fingers, not Safari's URL bar — pair with iOS Guided Access. */
      #kexit{position:fixed;top:14px;right:14px;width:44px;height:44px;border-radius:50%;border:1px solid var(--line);
        background:var(--card);color:var(--muted);font-size:17px;opacity:.45;cursor:pointer;z-index:40}
      #kpin{position:fixed;inset:0;z-index:50;background:rgba(15,18,14,.55);display:grid;place-items:center}
      #kpin[hidden]{display:none} /* display:grid would otherwise beat the [hidden] UA rule (same trap as .replychip) */
      .kpin-box{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:22px 24px;width:300px;text-align:center;box-shadow:0 24px 60px -20px rgba(0,0,0,.5)}
      .kpin-box b{font-family:var(--head);font-size:15px;letter-spacing:.06em;text-transform:uppercase}
      .kpin-dots{display:flex;justify-content:center;gap:12px;margin:16px 0 18px}
      .kpin-dots i{width:14px;height:14px;border-radius:50%;border:2px solid var(--muted);display:inline-block}
      .kpin-dots i.f{background:var(--ink);border-color:var(--ink)}
      .kpin-box.bad .kpin-dots i{border-color:var(--bad);background:transparent}
      .kpin-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
      .kpin-pad button{min-height:56px;border-radius:14px;border:1px solid var(--line);background:var(--bg);color:var(--ink);
        font-family:var(--head);font-weight:800;font-size:21px;cursor:pointer}
      .kpin-cancel{margin-top:14px;background:none;border:none;color:var(--muted);font-size:13px;font-weight:700;cursor:pointer;font-family:var(--head)}
    </style>
    <div id="kbody">
    <div class="khead"><h1>${esc(emoji)} ${esc(sport)}</h1><span class="kd">${esc(dateLabel)}</span></div>
    ${cancelled ? `<div class="kcxl">🚫 Cancelled this week</div>` : `
    <div class="kcount">${floor.length} / ${cap} on the floor · ${wait.length} waiting${doorLine}</div>
    <div class="kcols">
      <div class="ksec"><h2>On the floor</h2>${floor.map((p, i) => row(p, i, '')).join('') || '<p style="color:var(--muted)">Nobody yet.</p>'}</div>
      <div class="ksec"><h2>Waitlist</h2>${wait.map((p, i) => row(p, i, 'kw')).join('') || '<p style="color:var(--muted)">Empty — spots open.</p>'}</div>
    </div>`}
    </div>
    <script>(function(){var miss=0;setInterval(function(){fetch(location.href).then(function(r){return r.text()}).then(function(t){
      var m=t.match(/<div id="kbody">([\\s\\S]*?)<\\/div>\\s*<script>/);
      if(m){miss=0;document.getElementById('kbody').innerHTML=m[1];}
      else if(++miss>=4){/* token rotated / link dead (P3-3): say so instead of freezing on a stale roster */
        document.getElementById('kbody').innerHTML='<div class="kcxl">📺 Screen disconnected<br><span style="font-size:20px;font-weight:600">This kiosk link was refreshed — open the new link from Admin → Programs.</span></div>';}
    }).catch(function(){});},8000);})();</script>
    <button id="kexit" type="button" aria-label="Exit kiosk">✕</button>
    <div id="kpin" hidden>
      <div class="kpin-box">
        <b>Exit kiosk</b>
        <div class="kpin-dots"><i></i><i></i><i></i><i></i></div>
        <div class="kpin-pad">
          <button type="button" data-k="1">1</button><button type="button" data-k="2">2</button><button type="button" data-k="3">3</button>
          <button type="button" data-k="4">4</button><button type="button" data-k="5">5</button><button type="button" data-k="6">6</button>
          <button type="button" data-k="7">7</button><button type="button" data-k="8">8</button><button type="button" data-k="9">9</button>
          <span></span><button type="button" data-k="0">0</button><button type="button" data-k="del">⌫</button>
        </div>
        <button type="button" class="kpin-cancel">Cancel</button>
      </div>
    </div>
    <script>(function(){
      var PIN='0000'; // owner-set soft gate (stops wandering fingers, not the URL bar — use Guided Access on the iPad)
      var buf='', pin=document.getElementById('kpin'), box=pin.querySelector('.kpin-box'),
          dots=pin.querySelectorAll('.kpin-dots i');
      function draw(){ for(var i=0;i<4;i++) dots[i].className = i<buf.length ? 'f' : ''; }
      document.getElementById('kexit').addEventListener('click',function(){ buf=''; draw(); box.classList.remove('bad'); pin.hidden=false; });
      pin.querySelector('.kpin-cancel').addEventListener('click',function(){ pin.hidden=true; });
      pin.addEventListener('click',function(e){
        var b=e.target && e.target.closest && e.target.closest('[data-k]'); if(!b) return;
        var k=b.getAttribute('data-k');
        if(k==='del'){ buf=buf.slice(0,-1); draw(); return; }
        if(buf.length>=4) return;
        buf+=k; draw();
        if(buf.length===4){
          if(buf===PIN){ window.location.href='/runs'; }
          else { box.classList.add('bad'); setTimeout(function(){ buf=''; draw(); box.classList.remove('bad'); },500); }
        }
      });
    })();</script>
  </div></body></html>`;
}

// ---------- PROGRAMS (admin) — the in-app "add a program" screen ----------
// Plain admin tool page (statusPage idiom). Every wizard field maps to one stored choice; all the
// formulaic wiring (paths, setting keys, notification copy, banner) is derived server-side.
export function programsAdminPage({ rows = [], msg = '', form = false, themes = [], kioskToken = '' }) {
  const DAYS = [['0', 'Sunday'], ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday']];
  // Whole-hour label, local to the view: server.js's fmtClockLabel/fmtClockRange can't be imported
  // here (views is imported BY server — the reverse would be circular), and this screen only ever
  // renders on-the-hour times, so a 2-line formatter beats threading 24 strings through props.
  const hourLabel = (h) => `${((h % 12) || 12)}${h < 12 || h === 24 ? ' AM' : ' PM'}`;
  const hourOpts = (sel) => Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}"${h === sel ? ' selected' : ''}>${hourLabel(h)}</option>`).join('');
  const THEME_LABEL = { default: 'Court orange', pk: 'Teal & cream', vb: 'Navy & cream' };
  const dayName = (d) => (DAYS[d] || [null, '—'])[1];

  const card = (r) => {
    const badge = r.active
      ? `<span class="pill approved">Live</span>`
      : `<span class="pill pending">Hidden</span>`;
    return `<div class="card rail" style="margin-top:10px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <b style="font-family:var(--head);font-size:16px">${esc(r.emoji)} ${esc(r.name)}</b>
        ${badge}${r.builtIn ? `<span class="pill" title="Defined in code — publish/hide only">Built-in</span>` : ''}
      </div>
      <p class="tally-note" style="margin:6px 0 0">
        ${r.runPath ? `<a href="${esc(r.runPath)}">${esc(r.runPath)}</a> · ` : ''}${r.dow != null ? `${esc(dayName(r.dow))}s ` : ''}${r.timeLabel ? `${esc(r.timeLabel)} · ` : (r.dow != null ? '· ' : '')}${r.cap != null ? `${r.cap} on the floor · ` : ''}${r.members} member${r.members === 1 ? '' : 's'}${r.runDate ? ` · next run ${esc(r.runDate)}` : (r.mounted ? ' · no run date set yet' : '')}
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        ${r.id === 1 ? '' : `<form method="POST" action="/admin/programs/active" class="swapform" style="margin:0"><input type="hidden" name="id" value="${r.id}"><input type="hidden" name="on" value="${r.active ? '0' : '1'}"><button class="btn ${r.active ? 'ghost ' : ''}sm" type="submit">${r.active ? 'Hide' : 'Publish'}</button></form>`}
        ${r.editable ? `<a class="btn ghost sm" href="#edit-${r.id}" style="margin:0">Edit settings</a>` : ''}
        ${r.id !== 90 ? (r.kioskUrl ? `<a class="btn ghost sm" style="margin:0" target="_blank" rel="noopener" href="${esc(r.kioskUrl)}">📺 Kiosk link</a><form method="POST" action="/admin/kiosk" class="swapform" style="margin:0" onsubmit="return confirm('Refresh ${esc(r.name)}&#39;s kiosk link? Its old screens stop working.')"><input type="hidden" name="pid" value="${r.id}"><button class="btn ghost sm" type="submit" title="Rotate this program's kiosk token">↻</button></form>` : `<form method="POST" action="/admin/kiosk" class="swapform" style="margin:0"><button class="btn ghost sm" type="submit">📺 Create kiosk links</button></form>`) : ''}
        ${r.editable && !r.hasData ? `<form method="POST" action="/admin/programs/delete" style="margin:0" onsubmit="return confirm('Delete ${esc(r.name)}? It has no sign-ups or history yet.')"><input type="hidden" name="id" value="${r.id}"><button class="btn ghost sm" type="submit">Delete</button></form>` : ''}
      </div>
      ${r.id !== 90 ? `<details style="margin-top:10px"><summary class="tally-note" style="cursor:pointer">Members &amp; hosts</summary>
        <form method="POST" action="/admin/programs/member" class="editrow" style="margin-top:8px">
          <input type="hidden" name="id" value="${r.id}">
          <label style="flex:1">Member email<input name="email" type="email" placeholder="their app account email"></label>
          <label style="width:170px">Action<select name="act">
            <option value="add">Add as member</option>
            <option value="host">Make host</option>
            <option value="unhost">Remove host role</option>
            <option value="remove">Remove from program</option>
          </select></label>
          <button class="btn ghost sm" type="submit">Apply</button>
        </form>
        <p class="tally-note" style="margin:6px 0 0">A <b>host</b> runs this program day-to-day — open/close check-in, announcements, guests, and approving join requests — without any other admin power.</p>
      </details>` : ''}
      ${r.editable ? `<details id="edit-${r.id}" style="margin-top:10px"><summary class="tally-note" style="cursor:pointer">Settings</summary>
        ${programForm({ action: '/admin/programs/edit', id: r.id, spec: r.spec, slug: r.slug, approval: r.approval, submit: 'Save changes', DAYS, hourOpts, themes, THEME_LABEL, seasonStart: r.seasonStart || '' })}
      </details>` : ''}
    </div>`;
  };

  return HEAD('Programs — The Bridge', '', { wall: false }) + header('<b>PROGRAMS</b>') + `
    ${backBtn('/admin/people')}
    ${opsNav('programs', { isAdmin: true })}
    <div class="rule"></div>
    ${msg ? `<div class="notice">${esc(msg)}</div>` : ''}
    <span class="eyebrow">Every run on the platform</span>
    <h1 style="margin-bottom:0">Programs</h1>
    <p class="lead" style="margin-top:6px">Add a new sport or program yourself — it gets its own check-in, waitlist, chat room, season board and notifications automatically. New programs start hidden so you can set them up before anyone sees them.</p>
    ${rows.map(card).join('')}
    <div class="subhead" id="new">Add a program</div>
    <details class="announce-compose" ${form ? 'open' : ''}>
      <summary>New program</summary>
      ${programForm({ action: '/admin/programs/create', spec: null, slug: '', approval: 'open', submit: 'Create program', DAYS, hourOpts, themes, THEME_LABEL })}
    </details>
    <div class="foot" style="margin-top:24px"><a href="/admin/people">‹ Back to People &amp; invites</a></div>
  ` + FOOT;
}
// Shared create/edit form. `spec` null = the create defaults.
function programForm({ action, id = null, spec, slug, approval, submit, DAYS, hourOpts, themes, THEME_LABEL, seasonStart = '' }) {
  const s = spec || {};
  const v = (k, d) => (s[k] == null ? d : s[k]);
  const teams = s.teams || {}, gq = s.groupQueue || {};
  const cutoff = v('confirmCutoff', null);
  const w = s.waiver || null;
  // One-tap starting points (create only): each preset fills the knobs below — then customize.
  // Plain DOM writes on THIS form only (closest('form')), so the create and edit forms never fight.
  const presets = id ? '' : `
    <div class="lb" style="margin:2px 0 4px"><b>Start from</b><span>tap to prefill, then adjust</span></div>
    <div class="chips sm" style="margin-bottom:10px">
      <button type="button" class="btn ghost sm preset" data-preset='{"joinMode":"open","seating":"instant","confirmMode":"none","autoRenew":1,"waiverMode":"shared","waiverGuardian":0}'>🏀 Casual pickup — click to join</button>
      <button type="button" class="btn ghost sm preset" data-preset='{"joinMode":"host","seating":"offer","confirmMode":"cutoff","autoRenew":1,"waiverMode":"shared","waiverGuardian":0}'>🏆 Committed roster — confirm or lose the spot</button>
      <button type="button" class="btn ghost sm preset" data-preset='{"joinMode":"host","seating":"instant","confirmMode":"none","autoRenew":0,"waiverMode":"own","waiverGuardian":1}'>🧒 Youth program — own waiver + guardian consent</button>
    </div>`;
  return `<form method="POST" action="${action}" class="card rail" style="margin-top:10px">
    ${id ? `<input type="hidden" name="id" value="${id}">` : ''}
    ${presets}
    <label>Program name<input name="name" value="${esc(v('displayName', ''))}" placeholder="Youth Basketball" maxlength="40" required></label>
    <div class="editrow">
      <label style="flex:1">Web address<input name="slug" value="${esc(slug)}" placeholder="youth" maxlength="21" required></label>
      <label style="width:90px">Icon<input name="emoji" value="${esc(v('emoji', '🏅'))}" maxlength="4"></label>
    </div>
    <p class="tally-note" style="margin:0 0 10px">Members will find it at <b>/your-address</b>, with its chat at <b>/your-address/chat</b>.</p>
    <div class="editrow">
      <label style="flex:1">Day<select name="dow">${DAYS.map(([d, n]) => `<option value="${d}"${String(v('dow', 5)) === d ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <label style="flex:1">Starts<select name="startHour">${hourOpts(v('startHour', 18))}</select></label>
      <label style="flex:1">Ends<select name="endHour">${hourOpts(v('endHour', 21))}</select></label>
    </div>
    <div class="editrow">
      <label style="flex:1">On the floor<input name="cap" type="number" min="1" max="200" value="${esc(String(v('cap', 20)))}"></label>
      <label style="flex:1">Waitlist<input name="waitlist" type="number" min="0" max="50" value="${esc(String(v('waitlist', 6)))}"></label>
      <label style="flex:1">Early access<input name="prereg" type="number" min="0" max="200" value="${esc(String(v('prereg', 0)))}"></label>
    </div>
    <label>Who can join<select name="joinMode">
      ${[['open', 'Anyone approved in the app can join themselves'],
         ['host', 'They request — a host or admin approves'],
         ['invite', 'Invite only — organizers add members']]
        .map(([k, l]) => `<option value="${k}"${v('joinMode', 'open') === k ? ' selected' : ''}>${l}</option>`).join('')}
    </select></label>
    <label>When a spot frees up<select name="seating">
      <option value="instant"${!v('offerWindow', false) ? ' selected' : ''}>Next person moves up immediately (recommended)</option>
      <option value="offer"${v('offerWindow', false) ? ' selected' : ''}>Offer it to them with a claim window</option>
    </select></label>
    <label>Run-day confirmation<select name="confirmMode">
      <option value="none"${!cutoff ? ' selected' : ''}>Not needed — no confirm step</option>
      <option value="cutoff"${cutoff ? ' selected' : ''}>Players confirm by a deadline or lose the spot</option>
    </select></label>
    <div class="editrow">
      <label style="flex:1">Confirm deadline<input name="confirmCutoff" value="${esc(cutoff || '16:30')}" placeholder="16:30"></label>
      <label style="flex:1">Roster locks at<input name="lockTime" value="${esc(v('lockTime', '18:00'))}" placeholder="18:00"></label>
    </div>
    <div class="editrow">
      <label style="flex:1">Teams<input name="teamsCount" type="number" min="0" max="12" value="${esc(String(teams.count || 0))}"></label>
      <label style="flex:1">Players per team<input name="teamsSize" type="number" min="0" max="30" value="${esc(String(teams.size || 0))}"></label>
      <label style="flex:1">Sign up with friends<input name="partySize" type="number" min="0" max="12" value="${esc(String(gq.maxSize || 0))}"></label>
    </div>
    <p class="tally-note" style="margin:0 0 10px">Teams: 0 turns team picking off. Friends: the most people who can sign up together as a group (0 turns it off).</p>
    <label>Colour<select name="theme">${themes.map(t => `<option value="${t}"${v('theme', 'default') === t ? ' selected' : ''}>${THEME_LABEL[t] || t}</option>`).join('')}</select></label>
    <label>Positions <span style="text-transform:none;font-weight:400;color:var(--muted)">(optional — one per line, like "GK Goalkeeper")</span><textarea name="positions" rows="3" placeholder="GK Goalkeeper&#10;DF Defender">${esc((s.positions || []).map(([c, l]) => `${c} ${l}`.trim()).join('\n'))}</textarea></label>
    <p class="tally-note" style="margin:0 0 10px">Players pick these on their profile; the short code shows on rosters. Leave empty for no position picker.</p>
    <label>Waiver<select name="waiverMode">
      <option value="shared"${w ? '' : ' selected'}>The shared club waiver everyone signs</option>
      <option value="own"${w ? ' selected' : ''}>This program has its own waiver</option>
    </select></label>
    <label class="lvl"><input type="checkbox" name="waiverGuardian" value="1"${w && w.guardian ? ' checked' : ''}> Under-18s need a parent or guardian's consent</label>
    <p class="tally-note" style="margin:0 0 10px">With its own waiver, members sign this program's waiver before their first join (guardian consent turns this on automatically). Organizers confirm sighted documents on People.</p>
    <label>Season starts <span style="text-transform:none;font-weight:400;color:var(--muted)">(optional — no runs before this date)</span><input name="seasonStart" type="date" value="${esc(seasonStart)}"></label>
    <label class="lvl" style="margin-top:8px"><input type="checkbox" name="autoRenew" value="1"${v('autoRenew', true) ? ' checked' : ''}> Members keep their spot each week unless they sit out</label>
    <button class="btn" type="submit" style="margin-top:12px">${esc(submit)}</button>
    ${id ? '' : `<script>document.currentScript.closest('form').querySelectorAll('.preset').forEach(b => b.addEventListener('click', () => {
      const p = JSON.parse(b.dataset.preset), f = b.closest('form');
      for (const [k, val] of Object.entries(p)) {
        const el = f.elements[k]; if (!el) continue;
        if (el.type === 'checkbox') el.checked = !!val; else el.value = String(val);
      }
      f.querySelectorAll('.preset').forEach(x => x.classList.remove('voted')); b.classList.add('voted');
    }))</script>`}
  </form>`;
}

// ---------- PLANNING CENTER SYNC (admin console) ----------
// Deliberately a plain admin tool page (statusPage idiom, no tabs): status card → connect form →
// actions → match report. Everything user-derived goes through esc().
export function pcoAdminPage({ s = {}, msg = '' }) {
  const rep = s.report;
  const statusCard = s.connected
    ? `<div class="card rail" style="margin-top:12px">
        <div class="subhead" style="margin-top:0">Connected${s.authMode === 'oauth' ? ' — authorized by the church' : ' — via a token'}</div>
        <p style="margin:6px 0 0"><b>${esc(s.org || 'Planning Center')}</b> — People sync is live.
        ${s.linked} member${s.linked === 1 ? '' : 's'} linked · ${s.outboxPending} pending write${s.outboxPending === 1 ? '' : 's'}.</p>
        ${s.error === 'auth' ? `<p style="color:#b3261e;margin:8px 0 0"><b>⚠ Planning Center rejected the connection — sync is paused.</b> ${s.authMode === 'oauth' ? 'Press <b>Re-authorize</b> below (the church may have revoked access).' : 'Reconnect below with a fresh token.'}</p>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <form method="POST" action="/admin/pco/link" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Working…';"><button class="btn sm" type="submit">Match People now</button></form>
          <form method="POST" action="/admin/pco/poll" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Working…';"><button class="btn ghost sm" type="submit">Pull latest PCO edits</button></form>
          <form method="POST" action="/admin/pco/auto"><input type="hidden" name="on" value="${s.autocreate ? '0' : '1'}"><button class="btn ghost sm" type="submit">${s.autocreate ? '✓ Auto-add new members — turn off' : 'Auto-add new members — turn on'}</button></form>
          <form method="POST" action="/admin/pco/disconnect" onsubmit="return confirm('Disconnect Planning Center? Links are kept; syncing stops.')"><button class="btn ghost sm" type="submit">Disconnect</button></form>
        </div>
      </div>`
    : `<div class="card rail" style="margin-top:12px">
        <div class="subhead" style="margin-top:0">Not connected</div>
        <p style="margin:6px 0 0">Link the church's Planning Center account and this app keeps its <b>People</b> directory in sync automatically: members are matched by email (nobody re-registers), new approved members are written back, and profile edits flow both ways. Attendance stays in this app — Planning Center doesn't accept attendance from any outside system.</p>
      </div>`;
  const oauthCard = `
    <div class="subhead">Connect — recommended${s.authMode === 'oauth' ? ' (in use)' : ''}</div>
    <div class="card rail">
      <p class="tally-note" style="margin:0 0 10px"><b>The church authorizes this app from Planning Center's own screen.</b> No password or secret is ever sent to us, the permission belongs to the <b>organization</b> (so it keeps working when staff change), and it can be revoked any time from Planning Center's connected-applications list. Access is limited to: <b>${esc(s.scopes || '')}</b>.</p>
      <p class="tally-note" style="margin:0 0 10px">One-time setup by a Planning Center <b>Organization Administrator</b>: create an API application, and paste this exact redirect URI into it —</p>
      <p style="margin:0 0 10px;word-break:break-all"><code>${esc(s.redirectUri || '')}</code></p>
      <form method="POST" action="/admin/pco/oauth/app" style="margin:0 0 10px">
        <label>Application (client) ID<input name="client_id" autocomplete="off" value="${esc(s.oauthClientId)}"></label>
        <label>Application secret<input name="client_secret" type="password" autocomplete="off" placeholder="${s.oauthConfigured ? '•••••••• (saved)' : ''}"></label>
        <button class="btn ghost sm" type="submit" style="margin-top:8px">Save application</button>
      </form>
      ${s.oauthConfigured
        ? `<a class="btn" href="/admin/pco/oauth/start" style="margin:0">${s.authMode === 'oauth' ? 'Re-authorize' : 'Connect Planning Center'}</a>`
        : `<p class="tally-note" style="margin:0">Save the application above to enable the connect button.</p>`}
      ${s.authMode === 'oauth' && s.tokenExpires ? `<p class="tally-note" style="margin:10px 0 0">Connected. Access renews automatically (current token valid until ${esc(new Date(s.tokenExpires).toISOString().slice(0, 16).replace('T', ' '))} UTC).</p>` : ''}
      <div class="subhead" style="margin-top:14px">Instant updates (optional)</div>
      <p class="tally-note" style="margin:0 0 8px">Planning Center can notify this app the moment someone's details change there. Paste the webhook's signing secret from Planning Center and inbound changes arrive instantly instead of on the daily sync.</p>
      <form method="POST" action="/admin/pco/webhook" class="editrow" style="margin:0">
        <label style="flex:1">Webhook signing secret<input name="webhook_secret" autocomplete="off" placeholder="${s.webhookSet ? '•••••••• (saved — paste to replace, blank to clear)' : ''}"></label>
        <button class="btn ghost sm" type="submit">Save</button>
      </form>
    </div>`;
  const connectForm = `
    <div class="subhead">Connect with a token — quick alternative${s.authMode === 'pat' ? ' (in use)' : ''}</div>
    <form method="POST" action="/admin/pco/connect" class="card rail">
      <p class="tally-note" style="margin:0 0 10px">Faster to set up, and fine for a pilot: a PCO admin creates a <b>Personal Access Token</b> (api.planningcenteronline.com → Personal Access Tokens) and sends both halves. The trade-off is that it's a shared secret tied to <b>that person's account</b>, so it can stop working if they leave. Stored in the app's database (never in code), and included in the app's database backups — so treat those backups as sensitive.</p>
      <label>Application ID<input name="app_id" autocomplete="off" placeholder="pco_app_…"></label>
      <label>Secret<input name="secret" type="password" autocomplete="off" placeholder="••••••••"></label>
      <label>Webhook authenticity secret <span style="text-transform:none;font-weight:400;color:var(--muted)">(optional — only if webhooks are set up in PCO)</span><input name="webhook_secret" autocomplete="off"></label>
      <label class="lvl" style="margin-top:8px"><input type="checkbox" name="autocreate" value="1" checked> Automatically add new approved members to People</label>
      <button class="btn" type="submit" style="margin-top:10px">Connect &amp; test</button>
    </form>`;
  const reportCard = rep ? `
    <div class="subhead">Last match report <span style="text-transform:none;font-weight:400;color:var(--muted)">(${esc(String(rep.at || '').slice(0, 16).replace('T', ' '))})</span></div>
    <div class="card rail">
      <p style="margin:0"><b>${rep.matched}</b> matched by email · <b>${(rep.bridgeOnly || []).length}</b> only in this app · <b>${rep.pcoOnly}</b> only in People (they just haven't joined a run — nothing is imported).</p>
      ${(rep.bridgeOnly || []).length ? `
        <p class="tally-note" style="margin:10px 0 6px">Members not yet in the church directory:</p>
        <p style="margin:0;word-break:break-all">${rep.bridgeOnly.slice(0, 30).map(esc).join(' · ')}${rep.bridgeOnly.length > 30 ? ` · +${rep.bridgeOnly.length - 30} more` : ''}</p>
        <form method="POST" action="/admin/pco/create" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Working…';" style="margin-top:10px"><button class="btn sm" type="submit">Add ${rep.bridgeOnly.length} to People</button></form>` : ''}
      ${(rep.dupes || []).length ? `<p class="tally-note" style="margin:10px 0 0">⚠ Duplicate emails inside People (linked the first, review in PCO): ${rep.dupes.slice(0, 10).map(esc).join(', ')}</p>` : ''}
    </div>` : '';
  // ---- Phase 2b cards: door mode, Check-Ins reconciliation, door passes ----
  const doorCard = `
    <div class="subhead">Run-night mode</div>
    <div class="card rail">
      <p style="margin:0">${s.doorMode
        ? '<b>🚪 Door mode is ON.</b> The church’s Check-Ins station is the confirmation — the in-app “✓ I’m coming” step is hidden and unconfirmed spots are never swept.'
        : '<b>📲 In-app confirm is ON.</b> Floor players confirm in the app by the cutoff or their spot is released. Turn on door mode when the PCO Check-Ins station runs the door — one tap there replaces the in-app step.'}</p>
      <form method="POST" action="/admin/pco/doormode" style="margin-top:10px"><input type="hidden" name="on" value="${s.doorMode ? '0' : '1'}"><button class="btn ${s.doorMode ? 'ghost ' : ''}sm" type="submit">${s.doorMode ? 'Switch back to in-app confirm' : 'Turn on door mode'}</button></form>
      <p style="margin:14px 0 0">${s.kioskArrivals
        ? '<b>📺 Kiosk arrivals are ON.</b> On the run day, kiosk screens mark each person <b>IN</b> as the station taps them and count walk-ins — refreshed from Check-Ins about every 30 seconds while a screen is watching.'
        : '<b>📺 Kiosk arrivals are OFF.</b> Kiosk screens show the roster only. Turn this on and the door screen also marks who has physically tapped in at the station tonight — no extra device needed at the door.'}${s.eventId ? '' : ' <b>Needs the Check-Ins event ID below first.</b>'}</p>
      <form method="POST" action="/admin/pco/kioskarrivals" style="margin-top:10px"><input type="hidden" name="on" value="${s.kioskArrivals ? '0' : '1'}"><button class="btn ${s.kioskArrivals ? 'ghost ' : ''}sm" type="submit">${s.kioskArrivals ? 'Stop showing arrivals' : 'Show arrivals on kiosk screens'}</button></form>
    </div>`;
  const anyFields = s.waiverFields || s.attendanceFields;
  const attCard = s.connected ? `
    <div class="subhead">What we write onto People profiles</div>
    <div class="card rail">
      <p class="tally-note" style="margin:0 0 12px">Real custom fields (not notes), so your staff can filter Lists, trigger Workflows and pull reports inside Planning Center. Fields are created automatically the first time, then kept current.</p>

      <p style="margin:0 0 6px"><b>Waiver status</b> — ${(s.waiverFieldNames || []).map(n => `<b>${esc(n)}</b>`).join(' · ')}</p>
      <p class="tally-note" style="margin:0 0 8px">Who is cleared to play, and the date. Written as <b>Yes (verified)</b>, <b>Yes (self-reported)</b> or <b>No</b> — so a List of “No” is your follow-up queue and “self-reported” shows who hasn't been matched to a real waiver record yet. Useful no matter who runs the door.</p>
      <form method="POST" action="/admin/pco/waiver" style="margin:0 0 14px"><input type="hidden" name="on" value="${s.waiverFields ? '0' : '1'}"><button class="btn ${s.waiverFields ? 'ghost ' : ''}sm" type="submit">${s.waiverFields ? '✓ On — turn off' : 'Turn on waiver fields'}</button></form>

      <p style="margin:0 0 6px"><b>Attendance scoreboard</b> — ${(s.attFieldNames || []).map(n => `<b>${esc(n)}</b>`).join(' · ')}</p>
      <p class="tally-note" style="margin:0 0 8px">Games played per person. Worth publishing while this app is your attendance record — if you run Check-Ins at the door, Planning Center already holds attendance natively and this set is redundant, so leave it off.</p>
      <form method="POST" action="/admin/pco/attendance" style="margin:0"><input type="hidden" name="on" value="${s.attendanceFields ? '0' : '1'}"><button class="btn ${s.attendanceFields ? 'ghost ' : ''}sm" type="submit">${s.attendanceFields ? '✓ On — turn off' : 'Turn on attendance fields'}</button></form>

      ${anyFields ? `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px">
        <form method="POST" action="/admin/pco/attendance/push" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Working…';" style="margin:0"><button class="btn sm" type="submit">Update People now${s.attendancePending ? ` (${s.attendancePending})` : ''}</button></form>
      </div>
      ${s.attendanceLast ? `<p class="tally-note" style="margin:10px 0 0">Last written ${esc(String(s.attendanceLast).slice(0, 16).replace('T', ' '))}${s.attendancePending ? ` · ${s.attendancePending} profile${s.attendancePending === 1 ? '' : 's'} queued (they update automatically)` : ' · everyone up to date'}.</p>` : ''}` : ''}
      <p class="tally-note" style="margin:12px 0 0">Per-run history (who was on the floor which night, waitlist and offer history) always stays in this app — Planning Center accepts attendance from no outside system.</p>
    </div>` : '';
  const wc = s.waiverCounts || {}, wr = s.waiverReport;
  const waiverVerifyCard = s.connected ? `
    <div class="subhead">Waiver verification</div>
    <div class="card rail">
      <p class="tally-note" style="margin:0 0 10px">Right now this app records what members <b>tell</b> us — they tick “I've signed the waiver.” If your waiver is a <b>Planning Center form</b>, we can read its submissions and confirm it against your own records, so “signed” stops being a claim. Read-only: nothing is written back to your form.</p>
      <p style="margin:0 0 10px">Approved members: <b>${wc.verified || 0}</b> verified · <b>${wc.selfReported || 0}</b> self-reported · <b>${wc.none || 0}</b> no waiver.</p>
      <form method="POST" action="/admin/pco/waiver/form" class="editrow" style="margin:0 0 8px">
        <label style="flex:1">Waiver form ID<input name="form_id" value="${esc(s.waiverForm)}" inputmode="numeric" placeholder="the number in the form's URL"></label>
        <button class="btn ghost sm" type="submit">Save</button>
      </form>
      ${s.waiverForm ? `<form method="POST" action="/admin/pco/waiver/verify" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Working…';" style="margin:0"><button class="btn sm" type="submit">Verify waivers against the form</button></form>` : ''}
      ${wr ? `<p class="tally-note" style="margin:10px 0 0">Last check ${esc(String(wr.at).slice(0, 16).replace('T', ' '))}: matched <b>${wr.verified}</b> · ${wr.missing.length} member${wr.missing.length === 1 ? '' : 's'} with no submission${wr.unmatched ? ` · ${wr.unmatched} submission${wr.unmatched === 1 ? '' : 's'} not linked to a person` : ''}.${wr.missing.length ? ` Not found: ${wr.missing.slice(0, 12).map(esc).join(', ')}${wr.missing.length > 12 ? '…' : ''}` : ''}</p>` : ''}
      <p class="tally-note" style="margin:10px 0 0">If the waiver lives somewhere else (a Google Form, paper), verification stays manual — tell me where it lives and I'll wire that source in the same way.</p>
    </div>` : '';
  const cr = s.checkinsReport;
  const checkinsCard = s.connected ? `
    <div class="subhead">Check-Ins at the door</div>
    <div class="card rail">
      <p class="tally-note" style="margin:0 0 10px">After a run, pull the station's taps back and reconcile them against the roster — no-shows flagged, walk-ins surfaced. Reading Check-Ins is open to us; writing is walled for everyone.</p>
      <form method="POST" action="/admin/pco/event" class="editrow" style="margin:0 0 8px">
        <label style="flex:1">Check-Ins event ID<input name="event_id" value="${esc(s.eventId)}" inputmode="numeric" placeholder="the number in the event's URL"></label>
        <button class="btn ghost sm" type="submit">Save</button>
      </form>
      ${s.eventId ? `<form method="POST" action="/admin/pco/reconcile" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Working…';" class="editrow" style="margin:0">
        <label style="flex:1">Run date<input name="date" type="date"></label>
        <button class="btn sm" type="submit">Reconcile</button>
      </form>` : ''}
      ${cr ? `<div class="notice" style="margin:10px 0 0"><b>${esc(cr.date)}</b> — ${cr.ok} ✓ tapped &amp; signed up${cr.noShows.length ? ` · <b>${cr.noShows.length} no-show${cr.noShows.length === 1 ? '' : 's'}:</b> ${cr.noShows.slice(0, 12).map(esc).join(', ')}${cr.noShows.length > 12 ? '…' : ''}` : ' · no no-shows'}${cr.walkIns.length ? ` · <b>${cr.walkIns.length} walk-in${cr.walkIns.length === 1 ? '' : 's'}:</b> ${cr.walkIns.slice(0, 12).map(esc).join(', ')}${cr.walkIns.length > 12 ? '…' : ''}` : ' · no walk-ins'}</div>` : ''}
    </div>` : '';
  const pr = s.passReport;
  const passesCard = s.connected ? `
    <div class="subhead">Door passes (profile QR)</div>
    <div class="card rail">
      <p class="tally-note" style="margin:0 0 10px">Each member's profile can carry a QR the station scans — no name typing at the door. Flow: export the barcode CSV → import it in People (Barcode column) → Verify passes. QRs only appear once verified. ${s.passHolders} member${s.passHolders === 1 ? ' has' : 's have'} a working pass.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <form method="POST" action="/admin/pco/passes" style="margin:0"><input type="hidden" name="on" value="${s.passEnabled ? '0' : '1'}"><button class="btn ghost sm" type="submit">${s.passEnabled ? '✓ Profile QRs shown — hide' : 'Show profile QRs'}</button></form>
        <a class="btn ghost sm" href="/admin/pco/barcodes.csv" style="margin:0" download>⬇︎ Barcode CSV for People import</a>
        <form method="POST" action="/admin/pco/passes/verify" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Working…';" style="margin:0"><button class="btn sm" type="submit">Verify passes</button></form>
      </div>
      ${pr && pr.missing.length ? `<p class="tally-note" style="margin:10px 0 0">Still without a pass (${pr.missing.length}): ${pr.missing.slice(0, 15).map(esc).join(', ')}${pr.missing.length > 15 ? '…' : ''}</p>` : ''}
    </div>` : '';
  return HEAD('Planning Center — The Bridge', '', { wall: false }) + header('<b>PLANNING CENTER</b>') + `
    ${backBtn('/admin/people')}
    <div class="rule"></div>
    ${msg ? `<div class="notice">${esc(msg)}</div>` : ''}
    <span class="eyebrow">People sync</span>
    <h1 style="margin-bottom:0">Planning Center</h1>
    ${statusCard}
    ${doorCard}
    ${oauthCard}
    ${connectForm}
    ${reportCard}
    ${attCard}
    ${waiverVerifyCard}
    ${checkinsCard}
    ${passesCard}
    <div class="foot" style="margin-top:24px"><a href="/admin/people">‹ Back to People &amp; invites</a></div>
  ` + FOOT;
}

export function statusPage({ email, status }) {
  const body = status === 'pending'
    ? `<span class="eyebrow">Application in review</span>
       <h1>You're in the queue</h1>
       <p class="lead">Your application is with the organizers. Come play on Mondays at our recreational open runs, 7–10PM — that's where they watch and decide. If you're approved, you'll get the check-in link.</p>`
    : status === 'rejected'
    ? `<span class="eyebrow">Not this season</span>
       <h1>Not on the Adv list</h1>
       <p class="lead">You're not approved for the Adv runs right now. The open Monday recreational run is always available.</p>`
    : `<span class="eyebrow">No application found</span>
       <h1>We don't recognize this email</h1>
       <p class="lead">Nothing's on file for <b>${esc(email)}</b>. Two things to check: make sure you're signing in with the <b>exact email you applied with</b> — if you applied with a different address, sign out and use that one. If you've never applied, fill out the form.</p>
       <a class="btn" href="/">Go to the application</a>
       <div style="height:8px"></div>
       <a class="btn ghost" href="/logout">Sign out &amp; try another email</a>`;
  return HEAD('Your status — The Bridge', '', { wall: false }) + header('<b>STATUS</b>' + esc(email)) + `
    <div class="rule"></div>
    ${body}
    ${homeScreenCard}
    <div class="foot" style="margin-top:24px"><a href="/logout">Sign out</a></div>
  ` + FOOT;
}

// ---------- CHAT LOCKED (no run joined yet) ----------
// Sign-out confirmation. GET /logout renders THIS (a harmless read — no state
// change), and the actual session clear happens only on POST. That closes the
// CSRF / link-prefetch hole a GET-that-logs-you-out opens, and keeps a working
// no-JS path (the button below posts). With JS, the delegated handler in HEAD
// intercepts the "Sign out" link and posts directly, so this page is rarely seen.
// Demo reset (DEMO_MODE only, organizer only). The confirm never auto-submits: a reset wipes
// everyone's changes. After the POST the server exits and its supervisor reseeds, so the
// "resetting" page waits for /healthz to drop and answer again before going back to the picker.
export function demoResetPage({ resetting = false } = {}) {
  if (resetting) {
    return HEAD('Resetting the demo — The Bridge', '', { wall: false }) + header('<b>DEMO</b>') + `
    <div class="rule"></div>
    <h1>Resetting the demo</h1>
    <p class="lead">Wiping every change and reseeding the fictional world. This takes a few seconds; you'll be sent back to pick someone.</p>
    <script>(function(){var gone=false,t0=Date.now();function poll(){fetch('/healthz',{cache:'no-store'}).then(function(r){if(r.ok&&(gone||Date.now()-t0>20000))location.href='/login';else setTimeout(poll,500);}).catch(function(){gone=true;setTimeout(poll,500);});}setTimeout(poll,300);})();</script>
  ` + FOOT;
  }
  return HEAD('Reset the demo — The Bridge', '', { wall: false }) + header('<b>DEMO</b>') + `
    <div class="rule"></div>
    <span class="eyebrow">Organizer</span>
    <h1>Reset the demo?</h1>
    <p class="lead">Every visitor's posts, uploads, sign-ups and changes are wiped, and the fictional world is reseeded. Everyone is signed out.</p>
    <form method="POST" action="/demo/reset"><button class="btn" type="submit">Reset now</button></form>
    <div style="height:8px"></div>
    <a class="btn ghost" href="/runs">Cancel</a>
  ` + FOOT;
}

export function logoutPage() {
  return HEAD('Sign out — The Bridge', '', { wall: false }) + header('<b>SIGN OUT</b>') + `
    <div class="rule"></div>
    <span class="eyebrow">Passwordless</span>
    <h1>Sign out?</h1>
    <p class="lead">You'll need the 6-digit code we email you to sign back in — you don't normally need to sign out.</p>
    <form method="POST" action="/logout"><button class="btn" type="submit">Sign out</button></form>
    <div style="height:8px"></div>
    <a class="btn ghost" href="/checkin">Stay signed in</a>
  ` + FOOT;
}

// One-time-link confirm page. Rendered on the GET of a magic-sign-in / claim link so a
// bare GET (email security scanners like Outlook SafeLinks auto-visit links) DOESN'T
// consume the single-use token — only the POST does. Real browsers auto-submit the form
// on load, so for a human it's still effectively one tap; a scanner (no JS execution)
// just sees the page and the token stays valid for the actual person.
export function confirmActionPage({ title, heading, sub, action, fields = {}, button = 'Continue' }) {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v == null ? '' : v))}">`).join('');
  return HEAD(`${title} — The Bridge`, '', { wall: false }) + header(`<b>${esc(title.toUpperCase())}</b>`) + `
    <div class="rule"></div>
    <span class="eyebrow">One tap</span>
    <h1>${esc(heading)}</h1>
    <p class="lead">${esc(sub)}</p>
    <form method="POST" action="${esc(action)}" id="confirmform">${hidden}
      <button class="btn" type="submit">${esc(button)}</button>
    </form>
    <script>setTimeout(function(){try{document.getElementById('confirmform').submit();}catch(e){}},60);</script>
  ` + FOOT;
}

// Minimal, safe Markdown → HTML for the static legal docs (legal/*.md). Handles the exact
// subset those files use: #/##/### headings, **bold**, *italic*, `- ` and `1. ` lists,
// `---` rules, and paragraphs. Text is HTML-escaped FIRST (defense-in-depth even though the
// source is our own trusted files), THEN inline **/* is applied to the escaped text. Scoped
// to these docs on purpose — not a general Markdown engine.
export function mdToHtml(md) {
  const escT = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => escT(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  const out = [];
  let para = [], listType = null, listItems = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushList = () => { if (listItems.length) { out.push(`<${listType}>` + listItems.map(li => '<li>' + inline(li) + '</li>').join('') + `</${listType}>`); listItems = []; listType = null; } };
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (/^#{1,3}\s/.test(line)) { flushPara(); flushList(); const lvl = line.match(/^#+/)[0].length; out.push(`<h${lvl}>` + inline(line.replace(/^#+\s/, '')) + `</h${lvl}>`); }
    else if (/^---+\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); }
    else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { flushPara(); if (listType !== 'ul') { flushList(); listType = 'ul'; } listItems.push(m[1]); }
    else if ((m = line.match(/^\s*\d+\.\s+(.*)/))) { flushPara(); if (listType !== 'ol') { flushList(); listType = 'ol'; } listItems.push(m[1]); }
    else if (line === '') { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join('\n');
}

// Legal / policy page in the app shell (privacy, terms, conduct). Public, no install wall.
export function legalPage(title, html) {
  return HEAD(`${title} — The Bridge`, '', { wall: false }) + header(`<b>${esc(title.toUpperCase())}</b>`) + `
    <div class="rule"></div>
    <div class="legal">${html}</div>
    <div class="foot" style="margin-top:24px"><a href="/">Apply</a> · <a href="/login">Sign in</a></div>
  ` + FOOT;
}

// ---------- CHECK-IN BANNER TOOL (operators) ----------
// Pick a photo → pan/zoom it inside a fixed 3:1 window → save. The window IS the banner
// crop; the client computes the source-pixel rect and posts it with the file (server crops
// to 2320×1102, 40:19). Native multipart POST — the submit handler just fills the hidden crop inputs.
const bannerCropScript = () => `<script>
(function(){
  var file=document.getElementById('bfile'), stage=document.getElementById('bstage'),
      frame=document.getElementById('bframe'), img=document.getElementById('bimg'),
      zoom=document.getElementById('bzoom'), form=document.getElementById('bform');
  if(!file||!frame)return;
  var nw=0,nh=0,cover=1,z=1,ox=0,oy=0,fw=0,fh=0;
  function apply(){ fw=frame.clientWidth; fh=frame.clientHeight;
    var scale=cover*z, dw=nw*scale, dh=nh*scale;
    ox=Math.min(0,Math.max(fw-dw,ox)); oy=Math.min(0,Math.max(fh-dh,oy));
    img.style.width=dw+'px'; img.style.height=dh+'px'; img.style.transform='translate('+ox+'px,'+oy+'px)'; }
  function fit(){ fw=frame.clientWidth; fh=frame.clientHeight; cover=Math.max(fw/nw,fh/nh); z=1; if(zoom)zoom.value=1;
    var scale=cover*z; ox=(fw-nw*scale)/2; oy=(fh-nh*scale)/2; apply(); }
  file.addEventListener('change',function(){ var f=file.files&&file.files[0]; if(!f)return;
    var url=URL.createObjectURL(f);
    img.onload=function(){ nw=img.naturalWidth; nh=img.naturalHeight; if(stage)stage.hidden=false; fit(); };
    img.src=url; });
  var drag=false,px=0,py=0;
  frame.addEventListener('pointerdown',function(e){ if(!nh)return; drag=true; px=e.clientX; py=e.clientY; try{frame.setPointerCapture(e.pointerId);}catch(_){} });
  frame.addEventListener('pointermove',function(e){ if(!drag)return; ox+=e.clientX-px; oy+=e.clientY-py; px=e.clientX; py=e.clientY; apply(); });
  function end(e){ drag=false; try{frame.releasePointerCapture(e.pointerId);}catch(_){} }
  frame.addEventListener('pointerup',end); frame.addEventListener('pointercancel',end);
  if(zoom)zoom.addEventListener('input',function(){ if(!nh)return; var old=cover*z, cx=(-ox+fw/2)/old, cy=(-oy+fh/2)/old;
    z=Number(zoom.value)||1; var ns=cover*z; ox=fw/2-cx*ns; oy=fh/2-cy*ns; apply(); });
  window.addEventListener('resize',function(){ if(nh)apply(); });
  form.addEventListener('submit',function(e){
    if(!nh){ e.preventDefault(); alert('Pick a photo first.'); return; }
    var scale=cover*z;
    document.getElementById('bcx').value=Math.max(0,Math.round(-ox/scale));
    document.getElementById('bcy').value=Math.max(0,Math.round(-oy/scale));
    document.getElementById('bcw').value=Math.round(fw/scale);
    document.getElementById('bch').value=Math.round(fh/scale);
  });
})();
</script>`;

// One-time waiver gate — shown when a member without waiver_ok tries to join ANY run's
// queue. They confirm they've signed, we set waiver_ok, and they're returned to the run.
export function waiverPage({ email, next = '/checkin', err = '', programId = 0, programName = '', guardian = false } = {}) {
  // Program variant (F6): the program's OWN waiver — no club QR block (that's the shared
  // document), and a guardian consent section when the program requires it for this minor.
  const guardianBlock = guardian ? `
      <div class="subhead" style="margin-top:14px">Parent / guardian consent</div>
      <p class="tally-note" style="margin:4px 0 8px">This player is under 18, so a parent or guardian completes this part.</p>
      <label>Guardian name<input name="guardian_name" maxlength="60" required autocomplete="off"></label>
      <label>Guardian phone<input name="guardian_phone" maxlength="30" inputmode="tel" required autocomplete="off"></label>
      <label>Guardian email<input name="guardian_email" type="email" required autocomplete="off"></label>
      <label class="check"><input type="checkbox" name="guardian_agree" value="1" required><span>I am this player's parent or guardian and I consent to their participation.</span></label>` : '';
  return HEAD('Waiver — The Bridge', '', { wall: false }) + header(`<b>WAIVER</b>${esc(email)}`, '') + `
    <div class="rule"></div>
    <span class="eyebrow">One-time — before your first check-in</span>
    <h1>${programName ? `Sign the ${esc(programName)} waiver` : 'Sign the waiver first'}</h1>
    <p class="lead">${programName
      ? `${esc(programName)} has its own waiver${guardian ? ' and, for players under 18, a parent or guardian’s consent' : ''}. It's a one-time step for this program. No waiver, no play.`
      : `Before you join a run, you need to complete the waiver. It's a one-time step — sign it once and you won't be asked again. No waiver, no play.`}</p>
    ${err ? `<div class="notice bad">${esc(err)}</div>` : ''}
    ${programId ? '' : qrBlock}
    <form method="POST" action="/waiver" class="card rail" style="margin-top:14px">
      <input type="hidden" name="next" value="${esc(next)}">
      ${programId ? `<input type="hidden" name="p" value="${Number(programId)}">` : ''}
      <label class="check"><input type="checkbox" name="agree" value="1" required><span>I've signed the waiver and agree to its terms.</span></label>
      ${guardianBlock}
      <div style="height:12px"></div>
      <button class="btn primary" type="submit">Continue →</button>
    </form>
    <div class="foot" style="margin-top:20px"><a href="${esc(next)}">← Back</a></div>
  ` + FOOT;
}

export function bannerPage({ err = '', bannerVer = '0', action = '/admin/banner', imgSrc = '/gym.jpg', back = '/checkin', bodyClass = '' } = {}) {
  const errMsg = err === 'big' ? 'That image is too large (max 14 MB).'
    : err === 'type' ? 'That file isn’t a supported image (JPG, PNG, or WebP).'
    : err === 'crop' ? 'Couldn’t read the crop area — try again.'
    : err ? 'Something went wrong processing the image. Try again.' : '';
  return HEAD('Change banner — The Bridge', bodyClass, { wall: false }) + header('<b>BANNER</b>admin', '') + `
    <div class="rule"></div>
    <span class="eyebrow">Check-in hero photo</span>
    <h1>Change the banner</h1>
    <p class="lead">Pick a photo, then <b>drag to position</b> and use the <b>slider to zoom</b>. The framed area is exactly what shows on the check-in page — a wide 3:1 banner.</p>
    ${errMsg ? `<div class="notice bad">${errMsg}</div>` : ''}

    <div class="subhead">Current</div>
    <div class="curframe"><img src="${esc(imgSrc)}?v=${esc(String(bannerVer))}" alt="Current banner"></div>

    <form method="POST" action="${esc(action)}" enctype="multipart/form-data" id="bform" class="card rail" style="margin-top:14px">
      <input type="hidden" name="cx" id="bcx"><input type="hidden" name="cy" id="bcy">
      <input type="hidden" name="cw" id="bcw"><input type="hidden" name="ch" id="bch">
      <label class="btn ghost" for="bfile" style="cursor:pointer">📷 Choose a photo</label>
      <input type="file" id="bfile" name="photo" accept="image/*" hidden>
      <div id="bstage" hidden style="margin-top:14px">
        <div id="bframe" class="cropframe"><img id="bimg" alt="" draggable="false"></div>
        <label style="margin-top:12px">Zoom</label>
        <input type="range" id="bzoom" min="1" max="4" step="0.01" value="1" style="width:100%">
        <div style="height:14px"></div>
        <button class="btn" type="submit" id="bsave">Save banner</button>
      </div>
    </form>
    ${bannerCropScript()}
    <div class="foot" style="margin-top:24px"><a href="${esc(back)}">← Back</a></div>
  ` + FOOT;
}

// ---------- PEOPLE MANAGEMENT (admin-only) ----------
export function peoplePage({ people, q = '', approvedPhones = [], signInUrl = '', invites = [], newInviteLink = '', msg = '', ann = null, dmUnread = 0, groupUnread = 0, groupMention = 0, waiverProgs = [], waiverRecs = {} }) {
  const pill = (s) => `<span class="pill ${s}">${s}</span>`;
  // Last-active chip (proposal #4): the churn signal — quiet for anyone seen this week, amber
  // past 30 days. last_seen_at counting started Aug 2026; older accounts show nothing until
  // they next open the app.
  const lastActive = (a) => {
    if (!a.last_seen_at) return '';
    const days = Math.floor((Date.now() - new Date(String(a.last_seen_at).replace(' ', 'T')).getTime()) / 86400000);
    if (!Number.isFinite(days) || days < 0) return '';
    const label = days === 0 ? 'active today' : days === 1 ? 'active yesterday' : `active ${days}d ago`;
    return ` <span class="tag${days > 30 ? ' susp' : ''}" style="font-weight:500">${label}</span>`;
  };
  const rows = people.map(a => `<details class="arow"${q ? ' open' : ''}>
    <summary><span class="an">${esc(a.full_name)}${a.is_team ? ' <span class="tag team">◆</span>' : ''}${a.is_regular ? ' <span class="tag reg">★</span>' : ''}${a.suspended ? ' <span class="tag susp">⊘ Suspended</span>' : ''}${a.status === 'approved' && !a.waiver_ok ? ' <span class="tag susp">⚠ No waiver</span>' : ''}${lastActive(a)}</span> ${pill(a.status)}</summary>
    <form method="POST" action="/admin/people/edit" class="editrow swapform" style="margin-top:12px">
      <input type="hidden" name="id" value="${a.id}">
      <label>Name<input name="full_name" value="${esc(a.full_name)}"></label>
      <label>Phone<input name="phone" value="${esc(a.phone)}" inputmode="tel"></label>
      <label>Email<input name="email" type="email" value="${esc(a.email)}"></label>
      <label>Date of birth <span style="text-transform:none;font-weight:400;color:var(--muted)">(drives the under-18 DM rule; blank to clear)</span><input name="dob" type="date" value="${esc(a.dob || '')}"></label>
      <div class="editacts">
        <button class="btn sm" type="submit">Save</button>
      </div>
    </form>
    <p class="tally-note" style="margin:6px 0 0">Waiver: ${a.waiver_verified_at
      ? `<b>confirmed on file</b>${a.waiver_at ? ` — signed ${esc(String(a.waiver_at).slice(0, 10))}` : ''} · seen by an organizer ${esc(String(a.waiver_verified_at).slice(0, 10))}`
      : a.waiver_ok
        ? `<b>self-reported</b>${a.waiver_at ? ` — they confirmed ${esc(String(a.waiver_at).slice(0, 10))}` : ' — date not recorded (before dates were kept)'}`
        : '<b>not on file</b> — they can’t join a run until they confirm it'}</p>
    ${a.waiver_verified_at
      ? `<form method="POST" action="/admin/people/waiver" class="swapform" style="margin:6px 0 0"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="on" value="0"><button class="btn ghost sm" type="submit">Undo waiver confirmation</button></form>`
      : `<form method="POST" action="/admin/people/waiver" class="editrow swapform" style="margin:6px 0 0">
           <input type="hidden" name="id" value="${a.id}"><input type="hidden" name="on" value="1">
           <label style="flex:1">Signed on <span style="text-transform:none;font-weight:400;color:var(--muted)">(optional — leave blank if you don't know)</span><input name="signed_on" type="date"></label>
           <button class="btn sm" type="submit">I've seen their signed waiver</button>
         </form>`}
    ${a.guardian_name ? `<p class="tally-note" style="margin:6px 0 0">Guardian: <b>${esc(a.guardian_name)}</b>${a.guardian_phone ? ` · ${esc(a.guardian_phone)}` : ''}${a.guardian_email ? ` · ${esc(a.guardian_email)}` : ''}</p>` : ''}
    ${waiverProgs.map(wp => {
      const rec = (waiverRecs[a.email] || []).find(r => r.waiver_key === wp.key);
      const state = !rec ? '<b>not on file</b>'
        : rec.verified_at ? `<b>confirmed on file</b> · seen by an organizer ${esc(String(rec.verified_at).slice(0, 10))}`
        : rec.attested_at
          ? `<b>self-reported</b> — confirmed ${esc(String(rec.attested_at).slice(0, 10))}${rec.guardian_consent_at ? ` · guardian ${esc(rec.guardian_name || '')} consented ${esc(String(rec.guardian_consent_at).slice(0, 10))}` : ''}`
          : '<b>not on file</b>';
      const btn = rec && rec.verified_at
        ? `<form method="POST" action="/admin/people/waiver-record" class="swapform" style="display:inline;margin-left:6px"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="key" value="${esc(wp.key)}"><input type="hidden" name="on" value="0"><button class="btn ghost sm" type="submit" style="padding:3px 10px">Undo</button></form>`
        : `<form method="POST" action="/admin/people/waiver-record" class="swapform" style="display:inline;margin-left:6px"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="key" value="${esc(wp.key)}"><input type="hidden" name="on" value="1"><button class="btn ghost sm" type="submit" style="padding:3px 10px">I've seen it signed</button></form>`;
      return `<p class="tally-note" style="margin:6px 0 0">${esc(wp.label)} waiver: ${state}${btn}</p>`;
    }).join('')}
    ${a.suspended
      ? `<form method="POST" action="/admin/people/suspend" class="swapform" style="margin:6px 0 0">
           <input type="hidden" name="id" value="${a.id}"><input type="hidden" name="on" value="0">
           ${a.suspend_reason ? `<p class="tally-note" style="margin:0 0 6px">Reason: ${esc(a.suspend_reason)}</p>` : ''}
           <button class="btn ghost sm" type="submit">Unsuspend — restore check-in &amp; chat</button>
         </form>`
      : `<form method="POST" action="/admin/people/suspend" class="editrow swapform" style="margin:6px 0 0">
           <input type="hidden" name="id" value="${a.id}"><input type="hidden" name="on" value="1">
           <label>Suspend reason <span style="text-transform:none;font-weight:400;color:var(--muted)">(optional — shown to them)</span><input name="reason" placeholder="e.g. no-show 3 weeks running"></label>
           <div class="editacts"><button class="btn ghost sm" type="submit">Suspend — block check-in &amp; chat</button></div>
         </form>`}
    <form method="POST" action="/admin/people/delete" data-confirmdel data-name="${esc(a.full_name)}" style="margin:6px 0 0">
      <input type="hidden" name="id" value="${a.id}">
      <button class="btn leave sm" type="submit">Delete person</button>
    </form>
  </details>`).join('');

  const phoneList = approvedPhones.map(p => `${p.full_name}: ${p.phone}`).join('\n');

  return HEAD('People — The Bridge', 'has-tabs') + header('<b>PEOPLE</b>admin', '', ann) + `
    ${backBtn('/checkin')}
    ${opsNav('people', { isAdmin: true })}${firstRunTour}
    <div class="rule"></div>
    <span class="eyebrow">${people.length} ${q ? 'match' + (people.length===1?'':'es') : 'people'}</span>
    <h1>People</h1>
    ${msg ? `<div class="notice good">${esc(msg)}</div>` : ''}

    <form method="GET" action="/admin/people" style="margin:8px 0 4px">
      <input name="q" value="${esc(q)}" placeholder="Search name, email, or phone…">
    </form>

    <div data-tour="people" style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 0">
      <a class="btn ghost" href="/admin/share" style="margin:0">📱 Share sign-up QR &amp; links</a>
      <a class="btn ghost" href="/admin/people/export.csv" style="margin:0" download>⬇︎ Export people (CSV)</a>
      <a class="btn ghost" href="/admin/export" style="margin:0" data-tour="export">⬇︎ Export &amp; backup</a>
      <a class="btn ghost" href="/admin/pco" style="margin:0">⇄ Planning Center</a>
      <a class="btn ghost" href="/admin/programs" style="margin:0">🏅 Programs</a>
      <a class="btn ghost" href="/admin/analytics" style="margin:0">📈 Analytics</a>
      <a class="btn ghost" href="/admin/history" style="margin:0">🗓 Run history</a>
      <a class="btn ghost" href="/admin/audit" style="margin:0">🗂 Audit</a>
    </div>

    <div class="subhead">Add a player</div>
    <form method="POST" action="/admin/people/invite" class="card rail swapform">
      <p class="tally-note" style="margin:0 0 10px">Fill in whatever you know — all three fields are optional. Give <b>all three</b> and they're approved instantly, no link needed. Give less (or nothing) and you'll get a one-time link to send them — they fill in the rest, confirm the waiver, and land signed in.</p>
      <label>Full name <span style="text-transform:none;font-weight:400;color:var(--muted)">(optional)</span><input name="full_name" placeholder="Leave blank to let them fill it in"></label>
      <label>Phone <span style="text-transform:none;font-weight:400;color:var(--muted)">(optional)</span><input name="phone" inputmode="tel" placeholder="Leave blank to let them fill it in"></label>
      <label>Email <span style="text-transform:none;font-weight:400;color:var(--muted)">(optional — required for instant add)</span><input name="email" type="email" placeholder="Leave blank to let them fill it in"></label>
      <label style="margin-bottom:2px">Role</label>
      <div class="levels">
        <label class="lvl"><input type="radio" name="role" value="" checked> Approved only — can check in</label>
        <label class="lvl"><input type="radio" name="role" value="regular"> ★ Pillar — a trusted regular who helps anchor the run</label>
        <label class="lvl"><input type="radio" name="role" value="team"> ◆ Team — helps run it, auto-seated each week</label>
      </div>
      <p class="tally-note" style="margin:8px 0 0">If the email already exists on file, this just approves that record (and sets the role) instead of duplicating it.</p>
      <div style="height:12px"></div>
      <button class="btn" type="submit">Add player</button>
    </form>

    ${newInviteLink ? `<div class="notice good">
        <b>Link created — copy and send it:</b>
        <input id="newinv" readonly value="${esc(newInviteLink)}" style="font-size:16px;margin-top:8px">
        <div style="height:8px"></div>
        ${copyBtn('newinv', 'Copy link')} ${shareBtn('newinv')}
      </div>` : ''}

    ${invites.length ? `<details class="announce-compose"><summary>Pending invites (${invites.length})</summary>
        <ul class="annlog">
          ${invites.map(iv => `<li>
            <div class="annlog-b">${esc(iv.full_name || '(no name yet)')}${iv.phone ? ' · ' + esc(iv.phone) : ''}${iv.email ? ' · ' + esc(iv.email) : ''}${iv.role ? ` <span class="tag ${iv.role === 'team' ? 'team' : 'reg'}">${iv.role === 'team' ? '◆ Team' : '★ Pillar'}</span>` : ''}</div>
            <div class="annlog-m" style="margin-bottom:8px">Created ${esc(fmtWhen(iv.created_at))} by ${esc(iv.created_by)} · not used yet</div>
            <input readonly value="${esc(iv.link)}" style="font-size:16px" onclick="this.select()">
            <div style="height:6px"></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn ghost sm" type="button" onclick="var i=this.closest('li').querySelector('input[readonly]');if(i){i.select();try{navigator.clipboard.writeText(i.value);}catch(e){}}this.textContent='Copied ✓';setTimeout(()=>this.textContent='Copy link',1500)">Copy link</button>
              <form method="POST" action="/admin/people/invite/revoke" class="swapform" onsubmit="return confirm('Revoke this invite link? It will stop working.');" style="margin:0">
                <input type="hidden" name="token" value="${esc(iv.token)}">
                <button class="btn leave sm" type="submit">Revoke</button>
              </form>
            </div>
          </li>`).join('')}
        </ul>
      </details>` : ''}

    <div class="subhead">General sign-in link</div>
    <div class="card" style="padding:14px">
      <p class="tally-note" style="margin:0 0 8px">For anyone already approved — they sign in with the email on file:</p>
      <input id="invite" readonly value="${esc(signInUrl)}" style="font-size:16px">
      <div style="height:10px"></div>
      ${copyBtn('invite', 'Copy sign-in link')} ${shareBtn('invite')}
    </div>

    <div class="subhead">Copy approved players' numbers</div>
    <div class="card" style="padding:14px">
      <textarea id="phones" rows="${Math.min(Math.max(approvedPhones.length,2),12)}" readonly style="font-size:16px">${esc(phoneList)}</textarea>
      <div style="height:10px"></div>
      ${copyBtn('phones', 'Copy all numbers')}
    </div>

    <div class="subhead">Everyone</div>
    ${rows || '<div class="card">No people yet.</div>'}
    <div class="foot" style="margin-top:24px"><a href="/logout">Sign out</a></div>
    <script>
      // Delegated delete confirm — reads the name from data-name so an apostrophe
      // in the name (e.g. O'Brien) can never break an inline confirm() and let a
      // delete through unconfirmed. Escaped attribute → decoded string here.
      // Guarded: __swapWrap re-runs inline scripts on every router swap, so without
      // this flag a People→Council→People round-trip would stack the listener and
      // fire confirm() twice.
      if(!window.__delConfirmBound){window.__delConfirmBound=1;
        document.addEventListener('submit',function(e){
          var f=e.target.closest&&e.target.closest('form[data-confirmdel]');
          if(!f)return;
          var nm=f.getAttribute('data-name')||'this person';
          if(!confirm('Delete '+nm+' permanently? This removes their record, check-ins and votes.'))e.preventDefault();
        });
      }
    </script>
    ${shareScript()}
  ` + footWithTabs(tabNav('', { dm: dmUnread, group: groupUnread, groupMention }));
}

// ---------- EXPORT (admin: attendance CSV per run + full DB backup) ----------
export function exportPage({ programs = [], dmUnread = 0, groupUnread = 0, groupMention = 0, ann = null }) {
  const attRow = (p) => `<div class="exrow">
      <span class="exemoji" aria-hidden="true">${p.emoji}</span>
      <span class="exbody"><b>${esc(p.name)}</b><span class="exsub">${p.count} attendance record${p.count === 1 ? '' : 's'}${p.active ? '' : ' · hidden'}</span></span>
      <a class="btn ghost sm" href="/admin/export/attendance.csv?program=${p.id}" download>⬇︎ CSV</a>
    </div>`;
  return HEAD('Export — The Bridge', 'has-tabs') + header('<b>EXPORT</b>admin', '', ann) + `
    ${opsNav('people', { isAdmin: true })}
    <div class="rule"></div>
    <style>
      .exrow{display:flex;align-items:center;gap:12px;padding:12px 2px;border-bottom:1px solid var(--line)}
      .exrow:last-child{border-bottom:0}
      .exemoji{font-size:22px;width:34px;text-align:center;flex:none}
      .exbody{flex:1;min-width:0;display:flex;flex-direction:column}
      .exsub{color:var(--muted);font-size:13px}
      .exwarn{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-top:10px;color:var(--muted);font-size:13px;line-height:1.5}
    </style>
    <span class="eyebrow">Attendance</span>
    <h1>Export data</h1>
    <p class="lead">Download attendance as a CSV — open it in Google Sheets (File → Import) or paste into Planning Center. One row per person per run.</p>
    <div class="card" style="padding:2px 14px">${programs.length ? programs.map(attRow).join('') : '<div class="exsub" style="padding:14px 0">No runs yet.</div>'}</div>

    <div class="subhead" style="margin-top:20px">People</div>
    <a class="btn ghost" href="/admin/people/export.csv" style="margin:0" download>⬇︎ Export people (CSV)</a>

    <div class="subhead" style="margin-top:20px">Full backup</div>
    <a class="btn" href="/admin/export/db" style="margin:0" download>⬇︎ Download database (.db)</a>
    <div class="exwarn">⚠️ The database contains <b>everything</b> — contact details, chat and direct messages. Only download it to a device you control, and store it securely. Every download is logged.</div>

    <div class="foot" style="margin-top:24px"><a href="/admin/people">← Manage people</a> · <a href="/logout">Sign out</a></div>
  ` + footWithTabs(tabNav('', { dm: dmUnread, group: groupUnread, groupMention }));
}

// ---------- SHARE (QR + link for the application form) ----------
export function sharePage({ applyUrl = '', applyQr = '', signInUrl = '', loginQr = '', ann = null, dmUnread = 0, groupUnread = 0, groupMention = 0 }) {
  return HEAD('Share — The Bridge', 'has-tabs') + header('<b>SHARE</b>admin', '', ann) + `
    ${opsNav('people', { isAdmin: true })}
    <div class="rule"></div>
    <span class="eyebrow">Sign-up form</span>
    <h1>Share the application</h1>
    <p class="lead">Show this at the Monday rec runs — people scan the code to open the application form. No typing a long link.</p>

    <div class="card" style="text-align:center;padding:20px">
      <div class="qrbox">${applyQr}</div>
      <div style="height:14px"></div>
      <a class="btn" href="${esc(applyUrl)}" target="_blank" rel="noopener">Open the application form →</a>
      <div style="height:10px"></div>
      <input id="applylink" readonly value="${esc(applyUrl)}" style="font-size:16px;text-align:center">
      <div style="height:8px"></div>
      ${copyBtn('applylink', 'Copy link')} ${shareBtn('applylink')}
    </div>

    <div class="subhead">Sign-in link (for already-approved players)</div>
    <div class="card" style="text-align:center;padding:18px">
      <div class="qrbox qrbox-sm">${loginQr}</div>
      <div style="height:12px"></div>
      <input id="loginlink" readonly value="${esc(signInUrl)}" style="font-size:16px;text-align:center">
      <div style="height:8px"></div>
      ${copyBtn('loginlink', 'Copy sign-in link')} ${shareBtn('loginlink')}
    </div>

    <div class="foot" style="margin-top:24px"><a href="/admin/people">Manage people</a> · <a href="/logout">Sign out</a></div>
    ${shareScript()}
  ` + footWithTabs(tabNav('', { dm: dmUnread, group: groupUnread, groupMention }));
}

// ---------- LADDER (2026-09-08) ----------
// Two surfaces over the same standings: the in-app page an operator works from (roster, log a
// game, undo, nominate) and the wall board a projector shows. They share these row builders so a
// scoring rule can never say one thing on the phone and another on the screen.
// Ranking is WINS, then POINT DIFFERENTIAL, then win rate — the owner's rule; the page says so out
// loud, because a leaderboard that doesn't publish its tiebreak gets argued with at the net.
const ladderPd = (n) => (n == null ? '—' : (n > 0 ? '+' : '') + n);   // null = no scored game, not an even one
const ladderPdCls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const LADDER_CSS = `
  .ldr{display:flex;flex-direction:column;gap:8px;margin:0}
  .ldrow{position:relative;display:grid;grid-template-columns:auto 1fr auto auto;gap:12px;align-items:center;
    padding:11px 14px;border:1px solid var(--line);border-radius:12px;background:var(--card);overflow:hidden}
  /* Win bar: a gradient, not a flat block — a hard edge mid-row reads as a rendering fault at a
     distance, a fade reads as a bar chart. */
  .ldrow .ldbar{position:absolute;left:0;top:0;bottom:0;
    background:linear-gradient(90deg,rgba(46,143,85,.16),rgba(46,143,85,.03))}
  .ldrow > *{position:relative}
  .ldrow .rk{font-weight:800;font-size:19px;min-width:28px;text-align:center;color:var(--muted);font-variant-numeric:tabular-nums}
  .ldrow .ldnm{font-weight:700;font-size:17px;line-height:1.15}
  .ldrow .rec{font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
  .ldrow .pd{font-weight:700;margin-left:8px}
  .ldrow .pd.up{color:var(--good)} .ldrow .pd.down{color:var(--muted)}
  .ldrow .wn{font-weight:800;font-size:24px;font-variant-numeric:tabular-nums;min-width:2ch;text-align:right}
  .ldrow.ldlead{border-color:var(--good)}
  .ldchips{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
  .ldchip{display:inline-flex;align-items:center;gap:6px;min-height:46px;padding:9px 14px;border:1px solid var(--line);
    border-radius:12px;background:var(--card);font-weight:600;font-size:15px;cursor:pointer;color:inherit}
  .ldchip[data-side="w"]{background:var(--good);border-color:var(--good);color:#fff}
  .ldchip[data-side="l"]{border-color:var(--ink,#2b2b2b);background:rgba(0,0,0,.06);color:inherit;font-weight:700}
  .ldchip .hr{font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.7}
  .ldslots{display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center;margin-top:4px}
  .ldslot{border:1px solid var(--line);border-radius:12px;padding:9px 12px;min-height:74px;background:var(--card)}
  .ldslot h4{margin:0 0 4px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
  .ldslot .ldwho{font-weight:700;font-size:15px;line-height:1.2}
  .ldslot input{width:4ch;font-size:22px;font-weight:800;text-align:center;padding:2px 4px;margin-top:6px;
    font-variant-numeric:tabular-nums}
  .ldvs{font-weight:800;color:var(--muted);font-size:13px;text-transform:uppercase}
  /* Phone: the scorer works one-handed at the net, so the two sides stack instead of squeezing
     three columns into 390px and wrapping every name. */
  @media (max-width:520px){
    .ldslots{grid-template-columns:1fr;gap:8px}
    .ldvs{text-align:center;font-size:12px}
  }
  .ldmore{margin-top:8px}
  .ldmore>summary{cursor:pointer;font-size:13px;color:var(--muted);list-style:none;padding:6px 2px}
  .ldmore>summary::-webkit-details-marker{display:none}
  .ldmore>summary::before{content:"B8  "}
  .ldmore[open]>summary::before{content:"BE  "}
  .lbcap{margin:10px 0 0;color:var(--muted);font-size:15px}
  .ldlog{font-size:14px;line-height:1.85}
  .ldlog span{color:var(--muted);font-size:12px;margin-left:4px}
`;
// One standings row, shared by both surfaces. `max` scales the fill bar; `big` is the wall board.
function ladderRow(r, i, max, big) {
  const w = max ? Math.max(6, Math.round((r.w / max) * 100)) : 0;
  const label = Array.isArray(r.label) ? r.label.join(' + ') : r.label;
  return `<div class="ldrow${i === 0 && r.w > 0 ? ' ldlead' : ''}"${big ? ' style="padding:16px 20px"' : ''}>
    <span class="ldbar" style="width:${w}%"></span>
    <span class="rk"${big ? ' style="font-size:36px;min-width:52px"' : ''}>${i + 1}</span>
    <span class="ldnm"${big ? ' style="font-size:36px"' : ''}>${esc(label)}</span>
    <span class="rec"${big ? ' style="font-size:20px"' : ''}>${r.w}&ndash;${r.l}<span class="pd ${ladderPdCls(r.pd)}">${ladderPd(r.pd)}</span></span>
    <span class="wn"${big ? ' style="font-size:52px"' : ''}>${r.w}</span>
  </div>`;
}
function ladderRows(rows, big = false, offset = 0, maxOverride = null) {
  const max = maxOverride != null ? maxOverride : (rows.length ? rows[0].w : 0);
  return rows.map((r, i) => ladderRow(r, i + offset, max, big)).join('');
}
// A cap that doesn't SAY it's a cap reads as "you aren't on the board" to whoever finished 11th.
// In the app the rest is one tap away; on a projector nobody can tap, so it just states the count.
function ladderTable(rows, shown, noun) {
  if (!rows.length) return '';
  const max = rows[0].w, rest = rows.slice(shown);
  return `<div class="ldr">${ladderRows(rows.slice(0, shown), false, 0, max)}</div>` + (rest.length
    ? `<details class="ldmore"><summary>Show the other ${rest.length} ${esc(noun)}</summary>
        <div class="ldr" style="margin-top:8px">${ladderRows(rest, false, shown, max)}</div></details>`
    : '');
}
const ladderCapNote = (rows, shown, noun) => rows.length > shown
  ? `<p class="lbcap">Top ${shown} of ${rows.length} ${esc(noun)}</p>` : '';
// ---------- TEAMS BOARD — the operator's courtside surface ----------
// Design target: ONE TAP per change, thumb-sized, readable in a gym. Sides shift constantly, so
// anything requiring "select then place" is too slow. With two sides a tap needs no destination:
// tapping a player moves them to the other side. The small x benches them; a benched player taps
// back onto the shorter side.
// No swapform/fetch interception here on purpose — a full POST-redirect is more robust than an
// optimistic swap when the phone's wifi is patchy at the back of a gym.
const TEAMS_CSS = `
  .tmwrap{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}
  @media (max-width:520px){ .tmwrap{grid-template-columns:1fr 1fr;gap:8px} }
  .tmside{background:var(--card,#fff);border-radius:14px;padding:12px 10px 14px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
  .tmhead{display:flex;align-items:baseline;justify-content:space-between;margin:0 2px 8px}
  .tmhead h3{margin:0;font-size:15px;letter-spacing:.04em;text-transform:uppercase}
  .tmhead .n{font-size:26px;font-weight:800;line-height:1}
  .tmrow{display:flex;align-items:stretch;gap:6px;margin-bottom:7px}
  .tmname{flex:1;min-width:0;display:block;text-align:left;font-size:17px;font-weight:600;
    padding:13px 12px;border-radius:11px;border:1px solid rgba(34,35,29,.14);background:transparent;
    color:inherit;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tmname:active{transform:scale(.985)}
  .tmx{flex:0 0 42px;border-radius:11px;border:1px solid rgba(34,35,29,.12);background:transparent;
    color:var(--muted);font-size:17px;cursor:pointer}
  .tmempty{color:var(--muted);font-size:13px;padding:10px 2px}
  .tmbench{margin-top:14px}
  .tmbench .tmname{font-weight:500;opacity:.85}
  .tmbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
`;
export function teamsBoardPage({
  program = 1, theme = '', emoji = '', sport = '', email = '', runDate = '', dateLabel = '',
  sides = [], bench = [], basePath = '', canSync = false,
  games = false, tonight = [], fp = '', gameMinSide = 3,
  msg = '', err = '', dmUnread = 0, groupUnread = 0, groupMention = 0,
}) {
  // A player button posts only their address; the server decides where they land. Keeping the
  // destination server-side is what lets one tap mean "the other side" from either side, and
  // "the shorter side" from the bench, without the page having to know the counts.
  // `from` is the side the operator can SEE them on (blank = bench). The server refuses the move if
  // they have since been moved elsewhere, so a double-tap or a stale second phone can't silently
  // toggle a player back and forth.
  const chip = (p, from = '', benchable = true) => `
    <div class="tmrow">
      <form method="post" action="${esc(basePath)}/team/swap" style="flex:1;min-width:0;display:flex">
        <input type="hidden" name="email" value="${esc(p.email)}">
        <input type="hidden" name="from" value="${esc(String(from))}">
        <button class="tmname" type="submit" title="Move ${esc(p.name)} to the other side">${esc(p.name)}</button>
      </form>
      ${benchable ? `<form method="post" action="${esc(basePath)}/team/bench" style="display:flex">
        <input type="hidden" name="email" value="${esc(p.email)}">
        <button class="tmx" type="submit" title="Bench ${esc(p.name)}">&times;</button>
      </form>` : ''}
    </div>`;
  const side = (players, i) => `
    <div class="tmside">
      <div class="tmhead"><h3>Side ${i + 1}</h3><span class="n">${players.length}</span></div>
      ${players.length ? players.map(p => chip(p, i + 1)).join('') : '<p class="tmempty">Tap a name from the bench.</p>'}
    </div>`;
  const total = sides.reduce((n, x) => n + x.length, 0) + bench.length;
  return HEAD(`Teams — ${esc(sport)}`, 'has-tabs' + (theme ? ' ' + theme : ''))
    + header(`<b>TEAMS</b>${esc(email)}`, '', null) + `
    ${backToRuns}
    <div class="rule"></div>
    <style>${TEAMS_CSS}${games ? GAMES_CSS : ''}</style>
    <div class="phead"><h1>Teams ${esc(emoji)}</h1></div>
    <p class="psub" style="margin:-4px 0 10px;color:var(--muted)">${esc(dateLabel)} &middot; ${total} player${total === 1 ? '' : 's'} &middot; tap a name to move them across</p>
    ${msg ? `<div class="note ok">${esc(msg)}</div>` : ''}
    ${err ? `<div class="note warn">${esc(err)}</div>` : ''}
    ${games ? gamesStrip({ basePath, tonight, fp, minSide: gameMinSide, canLog: total > 0 && sides.every(x => x.length >= gameMinSide) }) : ''}
    ${total ? '' : `<div class="card"><b>Nobody on the floor yet.</b><p class="foot" style="margin:6px 0 0">${canSync
      ? 'Pull tonight&rsquo;s registered players from Planning Center below.'
      : 'Players appear here once they&rsquo;re on tonight&rsquo;s roster.'}</p></div>`}
    <div class="tmwrap">${sides.map(side).join('')}</div>
    <div class="tmbench">
      <div class="subhead">Bench &middot; ${bench.length}</div>
      <div class="card" style="padding:10px">
        ${bench.length ? bench.map(p => chip(p, '', false)).join('')
          : '<p class="tmempty" style="margin:0">Everyone&rsquo;s on a side.</p>'}
      </div>
    </div>
    <div class="tmbar">
      ${canSync ? `<form method="post" action="${esc(basePath)}/roster-sync"
        onsubmit="var b=this.querySelector('button');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Syncing…';">
        <button class="btn sm" style="width:auto" type="submit">&#8635; Sync tonight&rsquo;s roster</button></form>` : ''}
      ${total ? `<form method="post" action="${esc(basePath)}/teams/clear"
        onsubmit="return confirm('Clear both sides? Everyone goes back to the bench.');">
        <button class="btn ghost sm" style="width:auto" type="submit">Clear sides</button></form>` : ''}
    </div>
    <p class="foot" style="margin-top:14px">Tap a name to send them to the other side. Tap &times; to bench them. A benched player goes to whichever side is shorter.</p>
    ` + footWithTabs(tabNav('', { dm: dmUnread, group: groupUnread, groupMention, program }));
}
// ---------- GAME RESULTS — the strip that turns a board into a record ----------
// Sits ABOVE the sides on purpose: when a game ends the eye path is top-of-screen, tap, then
// re-mix below. Winner is one button. The score is a second, optional tap folded into a
// <details> so the zero-score path stays visually one tap — a required score is what stops
// anyone logging by week three, and an invented one is silently wrong data on a public board.
const GAMES_CSS = `
  .gmbar{padding:12px 14px;margin:0 0 12px}
  .gmwin{display:flex;flex-direction:column;gap:10px;margin:0}
  .gmbtn{width:100%;min-height:52px;font-size:17px;font-weight:650;cursor:pointer;
    border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--fg)}
  .gmbtn:hover{border-color:var(--accent)}
  .gmbtn[disabled]{opacity:.55}
  /* Two thumb-sized number pads side by side. Big text because this is filled in a gym, standing,
     by someone about to play the next game. */
  .gmscrow{display:flex;gap:10px;align-items:end}
  .gmscrow label{flex:1;font-size:12px;color:var(--muted);display:flex;flex-direction:column;gap:4px}
  .gmscrow input{width:100%;padding:12px;font-size:26px;font-weight:650;text-align:center;
    border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg)}
  .gmdash{padding-bottom:14px;color:var(--muted);font-size:20px}
  .gmton{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0 0 12px;font-size:13px;color:var(--muted)}
  .gmton form{margin:0}
  .gmton .lk{background:none;border:0;color:var(--accent);cursor:pointer;font:inherit;padding:0;text-decoration:underline}
  .gmlog{margin:0;font-size:12px;color:var(--muted)}
  .gmlog li{margin:3px 0}
`;
// One finished game, as a sentence. The roster is folded away because the only reason to open it
// is to check a snapshot looks right — which is exactly the check that catches a result logged
// AFTER the sides were re-mixed, the one failure this design cannot prevent outright.
const gameLine = (g) => `Side ${g.win} won${g.ws == null ? '' : ` ${g.ws}–${g.ls}`}`
  + ` &middot; ${g.counts[0]}v${g.counts[1]}`;

export function gamesStrip({ basePath = '', tonight = [], fp = '', canLog = true, minSide = 3 }) {
  const wins = [0, 0];
  for (const g of tonight) if (g.win >= 1 && g.win <= 2) wins[g.win - 1]++;
  const tally = tonight.length
    ? (wins[0] === wins[1] ? `Sides level ${wins[0]}–${wins[1]}`
      : `Side ${wins[0] > wins[1] ? 1 : 2} leads ${Math.max(...wins)}–${Math.min(...wins)}`)
    : '';
  const last = tonight[0];
  return (!canLog ? `
    <div class="card gmbar"><b>Not enough players on a side to log a game.</b>
      <p class="foot" style="margin:6px 0 0">Both sides need ${minSide} or more. Tonight&rsquo;s games below are
      unaffected, and Undo still works.</p></div>` : `
    <div class="card gmbar">
      <div class="subhead" style="margin:0 0 8px">Final score</div>
      <form method="post" action="${esc(basePath)}/game" class="gmwin"
        onsubmit="var b=this.querySelector('.gmbtn');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Saving…';">
        <input type="hidden" name="fp" value="${esc(fp)}">
        <div class="gmscrow">
          <label>Side 1<input name="s1" inputmode="numeric" pattern="[0-9]*" maxlength="2"
            autocomplete="off" required aria-label="Side 1 final score"></label>
          <span class="gmdash">&ndash;</span>
          <label>Side 2<input name="s2" inputmode="numeric" pattern="[0-9]*" maxlength="2"
            autocomplete="off" required aria-label="Side 2 final score"></label>
        </div>
        <button class="gmbtn" type="submit">Log this game</button>
      </form>
      <p class="foot" style="margin:8px 0 0">Whoever scored more wins it &mdash; no need to say which side.
        Move anyone who subbed in <b>before</b> you log.</p>
    </div>`)
    + (tonight.length ? `
    <div class="gmton">
      <span><b>Tonight:</b> ${tonight.length} game${tonight.length === 1 ? '' : 's'}${tally ? ' &middot; ' + tally : ''}</span>
      <span>&middot; last: ${gameLine(last)}</span>
      <form method="post" action="${esc(basePath)}/game/undo"
        onsubmit="return confirm('Remove the last game? It comes off the leaderboard too.');">
        <input type="hidden" name="id" value="${esc(String(last.id))}">
        <button class="lk" type="submit">Undo last</button></form>
      <details style="flex:1 1 100%">
        <summary style="cursor:pointer">Who was in tonight&rsquo;s games</summary>
        <ul class="gmlog" style="padding-left:18px;margin-top:6px">
          ${tonight.map(g => `<li>${gameLine(g)} &mdash; <b>won:</b> ${esc(g.sides[g.win - 1].join(', ') || '—')}
             &middot; <b>lost:</b> ${esc(g.sides[g.win === 1 ? 1 : 0].join(', ') || '—')}</li>`).join('')}
        </ul>
      </details>
    </div>` : '');
}
// The season board for a run whose games are logged from the teams board.
export function leaderboardPage({
  program = 1, theme = '', emoji = '', sport = '', email = '', basePath = '', canOperate = false,
  from = '', players = [], nights = 0, games = 0, recent = [], dateLabel = '',
  msg = '', err = '', dmUnread = 0, groupUnread = 0, groupMention = 0,
}) {
  const scored = players.some(p => p.scored > 0);
  // Point differential is shown ONLY for players who actually have a scored game. Passing null
  // renders a dash: a player nobody kept score for has NO differential, and printing "0" for them
  // would read as an even record rather than as an absence.
  const rows = players.map(p => ({ label: p.label, w: p.w, l: p.l, pd: p.scored ? p.pd : null }));
  // Standings already drop tombstones; belt-and-braces so a merge can never bury a live player's
  // record under a deleted person's address.
  const mergeOpts = players.filter(p => !/^former-[0-9a-f]+@/.test(p.email))
    .map(p => `<option value="${esc(p.email)}">${esc(p.label)} — ${esc(p.email)}</option>`).join('');
  return HEAD(`Leaderboard — ${esc(sport)}`, 'has-tabs' + (theme ? ' ' + theme : ''))
    + header(`<b>LEADERBOARD</b>${esc(email)}`, '', null) + `
    ${backToRuns}
    <div class="rule"></div>
    <style>${LADDER_CSS}${GAMES_CSS}</style>
    <div class="phead"><h1>Leaderboard ${esc(emoji)}</h1></div>
    <p class="psub" style="margin:-4px 0 10px;color:var(--muted)">
      ${games} game${games === 1 ? '' : 's'} across ${nights} night${nights === 1 ? '' : 's'} since ${esc(from)}
      &middot; most wins first, then point differential</p>
    ${msg ? `<div class="note ok">${esc(msg)}</div>` : ''}
    ${err ? `<div class="note warn">${esc(err)}</div>` : ''}
    ${players.length ? ladderTable(rows, 12, 'players') + ladderCapNote(rows, 12, 'players') : `
      <div class="card"><b>No games logged yet.</b>
        <p class="foot" style="margin:6px 0 0">Results come from the teams board &mdash; tap who won after a game
        and everyone on both sides gets credited.</p></div>`}
    ${recent.length ? `
      <div class="subhead" style="margin-top:18px">Tonight &middot; ${esc(dateLabel)}</div>
      <div class="card" style="padding:10px 14px">
        <ul class="gmlog" style="padding-left:18px;margin:0">
          ${recent.map(g => `<li>${gameLine(g)} &mdash; ${esc(g.sides[g.win - 1].join(', '))}</li>`).join('')}
        </ul>
      </div>` : ''}
    ${canOperate && players.length > 1 ? `
      <div class="subhead" style="margin-top:18px">Same person, two rows?</div>
      <div class="card">
        <p class="foot" style="margin:0 0 8px">A player who registered once without an email address and once with
          one shows up twice. Merging moves every game from the first onto the second. It refuses if
          they were ever on the same game, because then they are not the same person.</p>
        <form method="post" action="${esc(basePath)}/game/merge"
          onsubmit="return confirm('Merge these two players? This cannot be undone.');">
          <label class="lbl">Move this player<select name="from" required><option value="">Choose…</option>${mergeOpts}</select></label>
          <label class="lbl">onto this one<select name="into" required><option value="">Choose…</option>${mergeOpts}</select></label>
          <button class="btn sm" style="width:auto;margin-top:8px" type="submit">Merge</button>
        </form>
      </div>` : ''}
    <p class="foot" style="margin-top:14px">Every player on the winning side gets the win, and the margin goes to
      everyone who was on the floor for it. Sides are taken from the teams board at the moment the score is logged,
      so move anyone who subbed in <b>before</b> you log it.</p>
    ` + footWithTabs(tabNav('', { dm: dmUnread, group: groupUnread, groupMention, program }));
}
// The in-app page: standings first (what everyone opens it for), then the operator's tools.
export function ladderPage({
  program = 2, theme = '', emoji = '', title = 'Ladder', award = 'Sportsmanship',
  email = '', seasonFrom = '', roster = [], standings = { players: [], games: [], nights: 0 },
  noms = [], canLog = false, canOperate = false, canSync = false, nominationsOpen = false, headcounts = [], headcountToday = undefined, dateLabel = '',
  pointsTo = 11, basePath = '', kioskUrl = '',
  msg = '', err = '', dmUnread = 0, groupUnread = 0, groupMention = 0,
}) {
  const s = standings;
  const chip = (p) => `<button type="button" class="ldchip" data-email="${esc(p.email)}" data-side="">${esc(p.name)}${p.here ? ' <span class="hr">in</span>' : ''}</button>`;
  // Built ONLY while voting is open: this select is the one place the page would otherwise hand
  // every roster email address to any member who opens it (audit 2026-09-08).
  const nomOptions = nominationsOpen ? roster.map(p => `<option value="${esc(p.email)}">${esc(p.name)}</option>`).join('') : '';
  // The merge picker is inside the operator-only roster card. It DOES show the address, because
  // that is the only thing that tells two "Vincent" rows apart.
  const mergeOptions = !canOperate ? '' : roster.map(p =>
    `<option value="${esc(p.email)}">${esc(p.name)} &mdash; ${esc(p.email)}</option>`).join('');
  const logCard = !canLog ? '' : `
    <div class="subhead">Log a game</div>
    <form class="card" method="post" action="${esc(basePath)}/ladder/log" id="ldform"
      onsubmit="var b=this.querySelector('#ldgo');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Logging…';">
      <div class="ldslots">
        <div class="ldslot"><h4>Winners</h4><div class="ldwho" id="ldw">Tap two names</div>
          <input type="number" name="w_score" id="ldws" value="${pointsTo}" min="0" max="99" inputmode="numeric" aria-label="Winners score"></div>
        <div class="ldvs">def.</div>
        <div class="ldslot"><h4>Losers</h4><div class="ldwho" id="ldl">Then the other two</div>
          <input type="number" name="l_score" id="ldls" min="0" max="99" inputmode="numeric" placeholder="0" aria-label="Losers score"></div>
      </div>
      <div class="ldchips" id="ldpick">${roster.map(chip).join('') || '<span class="foot">Add players below first.</span>'}</div>
      <input type="hidden" name="w1" id="ldw1"><input type="hidden" name="w2" id="ldw2">
      <input type="hidden" name="l1" id="ldl1"><input type="hidden" name="l2" id="ldl2">
      <button class="btn" id="ldgo" disabled>Log it</button>
      <p class="foot" style="margin:8px 0 0">Doubles only &mdash; two winners, two losers, and the final score. Wins rank the board; point differential breaks ties.</p>
    </form>
    <form method="post" action="${esc(basePath)}/ladder/undo" style="margin-top:8px"
      onsubmit="if(!confirm('Delete the last game logged tonight?'))return false;var b=this.querySelector('button');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Undoing…';">
      <button class="btn ghost sm">Undo the last game of tonight</button>
    </form>`;
  const rosterCard = !canOperate ? '' : `
    <div class="subhead">Roster</div>
    <div class="card">
      <p class="foot" style="margin:0 0 10px">${canSync
        ? 'Pull it from the Church Center group in one tap, or add anyone the group doesn&rsquo;t know about below. Syncing only ever ADDS &mdash; it never removes someone who has games on the board.'
        : 'Entered once and kept for the season &mdash; nobody re-types it each week. Add an email if the player has a Bridge account; a name alone is fine for everyone else.'}</p>
      ${canSync ? `<form method="POST" action="${esc(basePath)}/ladder/sync" style="margin:0 0 10px"
        onsubmit="var b=this.querySelector('button');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Syncing…';">
        <button class="btn sm" style="width:auto" type="submit">↻ Sync roster from Planning Center</button></form>` : ''}
      <form method="post" action="${esc(basePath)}/ladder/player" style="display:flex;gap:8px;flex-wrap:wrap">
        <input name="name" placeholder="Name" maxlength="60" style="flex:2;min-width:140px">
        <input name="email" placeholder="Email (optional)" type="email" style="flex:2;min-width:140px">
        <button class="btn sm" style="width:auto">Add</button>
      </form>
      ${roster.length > 1 ? `<details class="ldmore" style="margin:10px 0 0">
        <summary>Same person listed twice? Merge them</summary>
        <p class="foot" style="margin:6px 0 8px">Happens when someone is typed in one week and synced from Planning Center the next. Their games move across; nothing is lost.</p>
        <form method="post" action="${esc(basePath)}/ladder/merge" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"
          onsubmit="var f=this.from.selectedOptions[0].text,t=this.into.selectedOptions[0].text;return confirm('Merge ' + f + ' into ' + t + '? ' + f + ' comes off the roster and their games move to ' + t + '.');">
          <select name="from" style="flex:2;min-width:140px">${mergeOptions}</select>
          <span class="foot">into</span>
          <select name="into" style="flex:2;min-width:140px">${mergeOptions}</select>
          <button class="btn sm" style="width:auto">Merge</button>
        </form>
      </details>` : ''}
      ${roster.length ? `<div class="ldchips" style="margin-bottom:0">${roster.map(p => `
        <form method="post" action="${esc(basePath)}/ladder/retire" style="display:inline" data-nm="${esc(p.name)}"
          onsubmit="return confirm('Take ' + this.dataset.nm + ' off the roster? Their results stay on the board.');">
          <input type="hidden" name="email" value="${esc(p.email)}">
          <button class="ldchip" title="Take ${esc(p.name)} off the roster - results stay">${esc(p.name)} <span class="hr">remove</span></button>
        </form>`).join('')}</div>` : ''}
    </div>`;
  // Voting opens once, at the end of the season. While it is closed the form is not rendered at all
  // (the handler refuses too) — which also keeps the roster's email addresses out of a page every
  // member can open, since this select was the only place they appeared.
  const votingToggle = canOperate ? `
      <form method="post" action="${esc(basePath)}/ladder/voting" style="margin:10px 0 0">
        <input type="hidden" name="open" value="${nominationsOpen ? '0' : '1'}">
        <button class="btn sm ${nominationsOpen ? 'ghost' : ''}" style="width:auto">${nominationsOpen ? 'Close voting' : 'Open voting for the season finale'}</button>
      </form>` : '';
  // Turnout. A count, not a roster: nobody takes names at an open gym. Shown WITH the season's other
  // nights because one number can't answer "is this working" — the average and the trend can.
  const hcTotal = headcounts.reduce((t, h) => t + h.n, 0);
  const hcAvg = headcounts.length ? Math.round((hcTotal / headcounts.length) * 10) / 10 : 0;
  const headCard = !canOperate ? '' : `
    <div class="subhead">Turnout</div>
    <div class="card">
      <p class="foot" style="margin:0 0 10px">How many people were actually here tonight &mdash; a head count, not a roster. Nothing else records this: a night with no logged games otherwise reads as nobody came.</p>
      <form method="post" action="${esc(basePath)}/headcount" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input name="n" type="number" min="0" max="500" inputmode="numeric" placeholder="0"
          value="${headcountToday == null ? '' : headcountToday}" style="flex:1;min-width:90px" aria-label="Headcount tonight">
        <button class="btn sm" style="width:auto">${headcountToday == null ? 'Log turnout' : 'Update'}</button>
        <span class="foot">${esc(dateLabel)}</span>
      </form>
      ${headcounts.length ? `
      <p class="foot" style="margin:12px 0 6px"><b>${hcAvg}</b> average over ${headcounts.length} night${headcounts.length === 1 ? '' : 's'} &middot; ${hcTotal} total</p>
      <div class="ldlog">${headcounts.slice(0, 10).map(h =>
        `<div><b>${h.n}</b> <span>${esc(h.runDate || h.run_date)}</span></div>`).join('')}</div>` : ''}
    </div>`;
  const nomCard = `
    <div class="subhead">${esc(award)} award</div>
    <div class="card">
      <p class="foot" style="margin:0 0 10px">Not for the best player &mdash; for the one who makes everyone else better.${nominationsOpen ? ' One pick each per night; you can change it.' : ''}</p>
      ${noms.length ? `<div class="ldr" style="margin-bottom:10px">${noms.slice(0, 5).map((n, i) => `
        <div class="ldrow"><span class="rk">${i + 1}</span>
          <span class="ldnm">${esc(n.name)}${n.note ? `<span class="foot" style="display:block;font-weight:400">&ldquo;${esc(n.note)}&rdquo;</span>` : ''}</span>
          <span class="rec"></span><span class="wn">${n.n}</span></div>`).join('')}</div>`
    : (nominationsOpen ? '<p class="foot" style="margin:0 0 10px">No nominations yet.</p>' : '')}
      ${nominationsOpen && roster.length ? `<form method="post" action="${esc(basePath)}/ladder/nominate" style="display:flex;gap:8px;flex-wrap:wrap">
        <select name="email" style="flex:2;min-width:150px">${nomOptions}</select>
        <input name="note" placeholder="Why (optional)" maxlength="140" style="flex:3;min-width:160px">
        <button class="btn sm" style="width:auto">Nominate</button>
      </form>` : (nominationsOpen ? '' : `<p class="foot" style="margin:0">Voting opens in the final weeks &mdash; one pick each, announced on the last night.</p>`)}${votingToggle}
    </div>`;
  return HEAD(`${esc(title)} — The Bridge`, 'has-tabs' + (theme ? ' ' + theme : '')) + header(`<b>LADDER</b>${esc(email)}`, '', null) + `
    ${backToRuns}
    <div class="rule"></div>
    <style>${LADDER_CSS}</style>
    <div class="phead"><h1>${esc(title)} ${esc(emoji)}</h1></div>
    <p class="psub" style="margin:-4px 0 10px;color:var(--muted)">Doubles, individual points &middot; wins, then point differential &middot; ${s.nights} night${s.nights === 1 ? '' : 's'}, ${s.games.length} game${s.games.length === 1 ? '' : 's'} since ${esc(seasonFrom)}</p>
    ${msg ? `<div class="note ok">${esc(msg)}</div>` : ''}
    ${err ? `<div class="note warn">${esc(err)}</div>` : ''}
    ${s.players.length ? ladderTable(s.players, 12, 'players')
    : '<div class="card"><b>No games logged yet.</b><p class="foot" style="margin:6px 0 0">The first result you log starts the season board.</p></div>'}
    ${s.games.length ? `<div class="subhead">Last games</div><div class="card"><div class="ldlog">${s.games.slice(0, 8).map(g =>
      `<div><b>${esc(g.winners.join(' + '))}</b> def. ${esc(g.losers.join(' + '))} <b>${g.ws}&ndash;${g.ls}</b> <span>${esc(g.runDate)}</span></div>`).join('')}</div></div>` : ''}
    ${headCard}
    ${logCard}
    ${nomCard}
    ${rosterCard}
    ${kioskUrl ? `<div class="foot" style="margin-top:16px">Screen for the gym: <a href="${esc(kioskUrl)}" data-full>open the wall board</a> &mdash; no sign-in, refreshes itself.</div>` : ''}
    <script>
      /* Tap-to-pick: two winners, then two losers, filling the hidden inputs the form posts.
         __swapWrap re-runs inline scripts on every router swap, so the dataset flag keeps a second
         binding from double-counting taps. */
      (function(){
        var pick=document.getElementById('ldpick'); if(!pick||pick.dataset.bound)return; pick.dataset.bound='1';
        var W=[],L=[];
        var elW=document.getElementById('ldw'),elL=document.getElementById('ldl'),go=document.getElementById('ldgo');
        function nameOf(e){var b=pick.querySelector('[data-email="'+e+'"]');return b?b.textContent.replace(/\s+in$/,'').trim():e;}
        function paint(){
          var chips=pick.querySelectorAll('.ldchip');
          for(var i=0;i<chips.length;i++){var e=chips[i].getAttribute('data-email');
            chips[i].setAttribute('data-side', W.indexOf(e)>-1?'w':(L.indexOf(e)>-1?'l':''));}
          elW.textContent=W.length?W.map(nameOf).join(' + '):'Tap two names';
          elL.textContent=L.length?L.map(nameOf).join(' + '):'Then the other two';
          document.getElementById('ldw1').value=W[0]||'';document.getElementById('ldw2').value=W[1]||'';
          document.getElementById('ldl1').value=L[0]||'';document.getElementById('ldl2').value=L[1]||'';
          var ws=parseInt(document.getElementById('ldws').value,10),ls=parseInt(document.getElementById('ldls').value,10);
          go.disabled=!(W.length===2&&L.length===2&&ws>ls&&ls>=0);
        }
        pick.addEventListener('click',function(ev){
          var b=ev.target.closest?ev.target.closest('.ldchip'):null; if(!b)return; ev.preventDefault();
          var e=b.getAttribute('data-email'),iw=W.indexOf(e),il=L.indexOf(e);
          if(iw>-1)W.splice(iw,1); else if(il>-1)L.splice(il,1);
          else if(W.length<2)W.push(e); else if(L.length<2)L.push(e);
          paint();
        });
        var sw=document.getElementById('ldws'),sl=document.getElementById('ldls');
        if(sw)sw.addEventListener('input',paint); if(sl)sl.addEventListener('input',paint);
        paint();
      })();
    </script>
  ` + footWithTabs(tabNav('', { dm: dmUnread, group: groupUnread, groupMention, program }));
}
// The wall board: no controls, no sign-in, big type for the far end of a gym. Refreshes itself like
// the door screen so a projector left on all night keeps up as games land.
export function ladderBoardPage({ sport = '', emoji = '', theme = '', award = 'Sportsmanship', dateLabel = '', standings = { players: [], games: [], nights: 0 }, noms = [] }) {
  const s = standings;
  return HEAD(`${sport} — ladder`, `kiosk ${theme}`, { wall: false }) + `
    <style>
      ${LADDER_CSS}
      /* Projection scale: read from the far end of a gym, so everything is a step up from the
         in-app page, and the legal footer is dropped (same as the door screen). */
      body.kiosk{overflow:auto} body.kiosk .wrap{max-width:1700px;padding:28px 34px}
      .lbhead h1{font-size:56px;margin:0;letter-spacing:-.015em;line-height:1.05}
      .lbsub{color:var(--muted);font-size:21px;margin:6px 0 0}
      .lbcols{display:grid;grid-template-columns:1.75fr 1fr;gap:32px;align-items:start;margin-top:22px}
      @media (max-width:900px){.lbcols{grid-template-columns:1fr}}
      .lbsec h2{font-size:20px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:0 0 12px}
      .lbsec .ldrow{padding:13px 16px}
      .lbsec .ldnm{font-size:22px} .lbsec .wn{font-size:30px} .lbsec .rk{font-size:22px;min-width:34px}
      .lbsec .rec{font-size:16px}
    </style>
    <div class="lbhead">
      <h1>${esc(sport)} ladder ${esc(emoji)}</h1>
      <p class="lbsub">Doubles, individual points &middot; wins, then point differential &middot; ${s.nights} night${s.nights === 1 ? '' : 's'} &middot; ${s.games.length} game${s.games.length === 1 ? '' : 's'}${dateLabel ? ` &middot; tonight ${esc(dateLabel)}` : ''}</p>
    </div>
    <div class="lbcols">
      <div class="lbsec">
        <h2>Season standings</h2>
        ${s.players.length ? `<div class="ldr">${ladderRows(s.players.slice(0, 12), true)}</div>${ladderCapNote(s.players, 12, 'players')}`
      : '<div class="card"><b>No games logged yet.</b></div>'}
      </div>
      <div class="lbsec">
        <h2>Tonight</h2>
        ${s.games.length ? `<div class="card"><div class="ldlog">${s.games.slice(0, 6).map(g =>
          `<div><b>${esc(g.winners.join(' + '))}</b> def. ${esc(g.losers.join(' + '))} <b>${g.ws}&ndash;${g.ls}</b></div>`).join('')}</div></div>`
      : '<div class="card">No games yet.</div>'}
        <h2 style="margin-top:24px">${esc(award)} award</h2>
        ${noms.length ? `<div class="ldr">${noms.slice(0, 5).map((n, i) => `
          <div class="ldrow"><span class="rk">${i + 1}</span><span class="ldnm">${esc(n.name)}</span>
          <span class="rec"></span><span class="wn">${n.n}</span></div>`).join('')}</div>`
      : '<div class="card">No nominations yet.</div>'}
      </div>
    </div>
    <script>setTimeout(function(){location.reload();},20000);</script>
  </div></body></html>`;
}
