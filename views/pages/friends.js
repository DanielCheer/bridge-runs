// views/pages/friends.js — the Friends tab and its live search fragment.
import { esc } from '../util.js';
import { followBtn, frPersonRow, avatarInner, MINOR_STAR, tabNav } from '../components.js';
import { HEAD, header, footWithTabs } from '../shell.js';

// Live-search result rows, also served as a fragment to the typeahead (see GET /friends/search).
// Each result carries {id,name,email,following,blocked}; a blocked person shows a chip, else Follow.
export function friendsSearchFragment(results = []) {
  if (!results.length) return `<div class="frempty">No players found.</div>`;
  return `<div class="mlist">${results.map(r =>
    frPersonRow(r, r.blocked ? '<span class="frchip">Blocked</span>' : followBtn(r.id, r.following, '/friends'))).join('')}</div>`;
}
export function friendsPage({ q = '', results = [], blocked = [], followers = [], following = [], games = [], party = null, dmUnread = 0, groupUnread = 0, groupMention = 0, chatProgram = 1, ann = null }) {
  const BACK = '/friends';
  const dateLabel = rd => esc(new Date(rd + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
  const section = (title, count, inner) => `<div class="subhead frsub">${esc(title)}${count ? ` <span class="frn">${count}</span>` : ''}</div>${inner}`;
  const unblockBtn = (id) => `<form class="swapform frbtn" method="POST" action="/friends/unblock" style="margin:0"><input type="hidden" name="id" value="${id}"><input type="hidden" name="back" value="${BACK}"><button class="btn ghost sm" type="submit">Unblock</button></form>`;

  // Live search — type to autofill matching players (debounced fetch → #frresults); no Search button.
  const searchBlock = `
    <div class="frsearch"><input type="search" id="frq" value="${esc(q)}" placeholder="Search players by name…" autocomplete="off" autocapitalize="words" aria-label="Search players"></div>
    <div id="frresults">${q ? friendsSearchFragment(results) : ''}</div>`;

  // Persistent party — created HERE, checked in with one tap on any group-queue run. pd.party
  // null → invites (if any) + the create form; else the member card with leader controls.
  const partyBlock = !party ? '' : (() => {
    const pd = party;
    const f = (action, fields, label, cls) => `<form class="swapform frbtn" method="POST" action="/friends/party/${action}" style="margin:0">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`).join('')}<button class="btn ${cls}" type="submit">${label}</button></form>`;
    const invites = pd.invites.map(iv => `<div class="lr" style="gap:8px"><span style="flex:1"><b>${esc(iv.leaderName)}</b> invited you${iv.name ? ` to <b>${esc(iv.name)}</b>` : ' to their party'}</span>${f('accept', { party: iv.partyId }, '✓ Join', 'primary sm')}${f('decline', { party: iv.partyId }, 'Decline', 'ghost sm')}</div>`).join('');
    let inner;
    if (pd.party) {
      const p2 = pd.party;
      const rows = p2.members.map(m => `<div class="lr" style="gap:8px"><span style="flex:1">${esc(m.name)}${m.minor ? MINOR_STAR : ''}${m.status === 'leader' ? ' <span class="tag">Leader</span>' : ''}${m.status === 'invited' ? ' <span class="tag" style="opacity:.55">Invited</span>' : ''}</span>${p2.isLeader && m.status !== 'leader' ? f('remove', { id: m.id }, '×', 'ghost sm') : ''}</div>`).join('');
      const picker = (p2.isLeader && pd.invitable.length)
        ? `<details class="frdetails" style="margin-top:8px"><summary>＋ Invite to the party</summary><div style="margin-top:6px">${pd.invitable.map(fr => `<div class="lr" style="gap:8px"><span style="flex:1">${esc(fr.name)}</span>${f('invite', { id: fr.id }, '＋ Invite', 'ghost sm')}</div>`).join('')}</div></details>`
        : (p2.isLeader ? `<p class="tally-note" style="color:var(--muted);margin:8px 0 0">Follow more players to invite them.</p>` : '');
      inner = `${rows}${picker}<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">${f('leave', {}, p2.isLeader ? 'Disband party' : 'Leave party', 'ghost sm')}</div>
        <p class="tally-note" style="color:var(--muted);margin:8px 0 0">Open any run and tap <b>“✓ Check in my party”</b> — you all land on the floor, or wait, together.</p>`;
    } else {
      inner = `<p class="tally-note" style="color:var(--muted);margin:0 0 8px">Create a party once — then check in together on any run with one tap.</p>
        <form class="swapform" method="POST" action="/friends/party/create" style="display:flex;gap:8px;flex-wrap:wrap"><input name="name" maxlength="40" placeholder="Party name (optional)" style="flex:1;min-width:150px"><button class="btn primary sm" type="submit">＋ Create party</button></form>`;
    }
    const title = pd.party ? `Your party${pd.party.name ? ` · ${esc(pd.party.name)}` : ''} <span class="frn">${pd.party.members.length}/${pd.maxSize}</span>` : 'Party';
    return `<div class="subhead frsub">${title}</div>${invites}${inner ? `<div class="card" style="margin-top:6px;padding:12px 14px">${inner}</div>` : ''}`;
  })();

  const followersBlock = followers.length
    ? section('Followers', followers.length, `<div class="mlist">${followers.map(p => frPersonRow(p, followBtn(p.id, p.followsBack, BACK, true))).join('')}</div>`)
    : '';

  const gamesBlock = games.length
    ? section('Games', 0, `<div class="frgames">${games.map(g => `
        <div class="frgame">
          <div class="frgh"><span class="frge">${g.emoji || '🏀'}</span><b>${esc(g.programName)}</b> · <span>${dateLabel(g.runDate)}</span></div>
          <div class="frgf">${g.friends.map(f => `<span class="frgp"><span class="mav sm">${avatarInner(f.email, f.name)}</span>${esc((f.name || '').split(' ')[0])}</span>`).join('')}</div>
          <a class="btn ghost sm" href="${esc(g.href)}">View run →</a>
        </div>`).join('')}</div>`)
    : '';

  const followingBlock = section('Following', following.length,
    following.length
      ? `<div class="mlist">${following.map(p => frPersonRow(p, followBtn(p.id, true, BACK))).join('')}</div>`
      : `<div class="frempty"><b>Not following anyone yet</b><p>Search a player above and tap Follow — you'll see their upcoming games here.</p></div>`);

  const blockedBlock = blocked.length
    ? `<details class="frdetails"><summary>Blocked (${blocked.length})</summary><div class="mlist">${blocked.map(p => frPersonRow(p, unblockBtn(p.id))).join('')}</div></details>`
    : '';

  return HEAD('Friends — The Bridge', 'has-tabs') + header('', '', ann, '') + `
    <div class="rule"></div>
    <div class="frwrap">
      <div class="frtitle"><h1>Friends</h1></div>
      ${searchBlock}
      ${partyBlock}
      ${followersBlock}
      ${gamesBlock}
      ${followingBlock}
      ${blockedBlock}
    </div>
    <script>
      (function(){
        var inp=document.getElementById('frq'), box=document.getElementById('frresults'), t, last='';
        if(!inp||!box||!window.fetch)return;
        inp.addEventListener('input',function(){
          clearTimeout(t); var q=inp.value.trim();
          if(!q){box.innerHTML='';last='';return;}
          t=setTimeout(function(){ if(q===last)return; last=q;
            fetch('/friends/search?q='+encodeURIComponent(q),{headers:{'X-Requested-With':'fetch'},credentials:'same-origin'})
              .then(function(r){return r.text();}).then(function(h){ if(inp.value.trim()===q) box.innerHTML=h; }).catch(function(){});
          },200);
        });
      })();
    </script>
    <style>
      .frwrap{padding:0 2px}
      .frtitle h1{font-size:22px;margin:14px 2px 10px}
      .frsearch{display:flex;gap:8px;margin:0 0 12px}
      .frsearch input{flex:1;min-width:0;padding:11px 13px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink);font-size:15px}
      .frsub{display:flex;align-items:center;gap:7px;margin-top:20px}
      .frn{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--accent,#22615A);color:#fff;font-size:12px;font-weight:700}
      .frwrap .mlist{max-height:none;overflow:visible}
      .frrow{align-items:center}
      .frrow .mtx{flex:1;min-width:0}
      .frempty{color:var(--muted);font-size:14px;padding:12px 2px;line-height:1.5}
      .frempty b{color:var(--ink);display:block;margin-bottom:2px}
      .frempty p{margin:0}
      .frgames{display:flex;flex-direction:column;gap:10px}
      .frgame{border:1px solid var(--line);border-radius:14px;padding:12px 13px;background:var(--card)}
      .frgh{font-size:15px;margin-bottom:8px}.frgh span{color:var(--muted)}
      .frge{margin-right:5px}
      .frgf{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px}
      .frgp{display:inline-flex;align-items:center;gap:6px;font-size:13px}
      .frgp .mav.sm{width:26px;height:26px;font-size:11px}
      .frdetails{margin-top:16px}
      .frdetails summary{cursor:pointer;color:var(--muted);font-size:14px;padding:6px 2px}
    </style>
  ` + footWithTabs(tabNav('', { dm: dmUnread, group: groupUnread, groupMention, program: chatProgram }));
}
