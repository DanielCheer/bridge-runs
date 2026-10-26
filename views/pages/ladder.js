// views/pages/ladder.js — the doubles ladder page and its kiosk board, with the standings table
// the leaderboard also uses.
import { esc } from '../util.js';
import { tabNav, backToRuns } from '../components.js';
import { HEAD, header, footWithTabs } from '../shell.js';

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

export {
  LADDER_CSS, ladderTable, ladderCapNote,
};
