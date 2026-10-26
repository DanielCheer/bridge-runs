// views/pages/programs.js — the in-app programs list and the create/edit form.
import { esc } from '../util.js';
import { opsNav, backBtn } from '../components.js';
import { HEAD, FOOT, header } from '../shell.js';

// ---------- PROGRAMS (admin) — the in-app "add a program" screen ----------
// Plain admin tool page (statusPage idiom). Every wizard field maps to one stored choice; all the
// formulaic wiring (paths, setting keys, notification copy, banner) is derived server-side.
export function programsAdminPage({ rows = [], msg = '', form = false, themes = [], kioskToken = '' }) {
  const DAYS = [['0', 'Sunday'], ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday']];
  // Whole-hour label, local to the view: lib/dates.js's fmtClockLabel/fmtClockRange can't be imported
  // here (views sit below lib/ and import only config.js and each other), and this screen only ever
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
