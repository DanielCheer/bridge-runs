// views/pages/admin.js — /admin: applications and council votes, run settings and the run day.
import { esc, fmtWhen, wdayFull, wdayShort } from '../util.js';
import { avatarInner, tabNav, opsNav, firstRunTour, backBtn } from '../components.js';
import { HEAD, header, footWithTabs } from '../shell.js';

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
