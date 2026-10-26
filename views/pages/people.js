// views/pages/people.js — people management, the exports page and the share (QR) page.
import { esc, fmtWhen } from '../util.js';
import { tabNav, opsNav, firstRunTour, backBtn, copyBtn, shareBtn, shareScript } from '../components.js';
import { HEAD, header, footWithTabs } from '../shell.js';

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
    <a class="btn" href="/admin/export/db" style="margin:0" download>⬇︎ Download encrypted backup (.db.enc)</a>
    <div class="exwarn">⚠️ The database contains <b>everything</b> — contact details, chat and direct messages. The download is encrypted with the server's backup key; to open it, run <code>node scripts/restore-backup.mjs &lt;file&gt; &lt;out.db&gt; backup.key</code> with the <code>backup.key</code> from the server. Keep the key and the file apart. Every download is logged.</div>

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
