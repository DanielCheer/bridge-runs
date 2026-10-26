// views/pages/analytics.js — the organizer's records: analytics, run history and the audit viewer.
import { esc } from '../util.js';
import { backBtn } from '../components.js';
import { HEAD, FOOT, header } from '../shell.js';

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
