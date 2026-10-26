// views/pages/run.js — the generic run page every program after basketball renders.
import { esc, wdayFull, wdayShort } from '../util.js';
import {
  IC_CLOSE, qrBlock, locationBlock, avatarInner, GROUP_ICON, MINOR_STAR, progMeta, tabNav, backToRuns, joinErrNotice,
} from '../components.js';
import { HEAD, header, footWithTabs } from '../shell.js';
import { fmtCountdown, COURT_SVG } from './checkin.js';

// ---------- FRIENDS (Phase 6: social graph home) ----------
// Pickleball run — a SEPARATE, hidden run on its own pk_* tables. Dedicated view (reuses the
// shell + avatar + list styles); does not touch the basketball checkinPage. Native POST forms.
// Program-generic run page. Defaults reproduce PICKLEBALL exactly (so pickleballPage below is a
// pass-through wrapper and the golden master stays byte-identical); a 3rd program calls runPage
// with its own runBase / theme / sport / etc. NOTE: offer-window UI (offered "claiming" rows) is
// NOT rendered yet — volleyball (offerWindow:true) needs a follow-up increment for that.
export function runPage({ email, runDate = '', runLabel = '', hours = '6–8 PM', startLabel = '6 PM', isOpen = false, cancelled = false, cap = 12, waitlistCap = 4, going = 0, waiting = 0, canOperate = false, isAdmin = false, myState = 'out', myWaitPos = 0, floorPlayers = [], offeredPlayers = [], waitPlayers = [], hidden = true, tipoff = 0, announcement = null, schedAnns = [], kioskUrl = '', kioskable = false, myConfirmed = false, confirmBy = '', partyMsg = '', iAutoRenew = false, bannerSrc = '/gym.jpg', bannerVer = '4', season = '', seasonWeekday = '', seasonLabel = '', preseason = false, today = '', seasonMax = '', pkMsg = '', joinErr = '', dmUnread = 0, groupUnread = 0, groupMention = 0, ann = null,
  runBase = '/pickleball', programId = 2, theme = 'pk', sport = 'Pickleball', sportEmoji = '🥒', dayName = 'Tuesday', pollKey = 'pickleball',
  teamsCfg = null, teamRows = [], teamsOpen = false, penaltyState = {}, partyData = null, demoMode = false, pendingRequests = [] }) {
  // Admin-supplied program names: escape every interpolation (case-convert first — see runChatPage).
  const sportE = esc(sport), emojiE = esc(sportEmoji), low = esc(sport.toLowerCase()), up = esc(sport.toUpperCase());
  const full = going >= cap, totalFull = (going + waiting) >= (cap + waitlistCap);
  const rmForm = (p) => `<form method="POST" action="${runBase}/remove" style="margin:0"><input type="hidden" name="email" value="${esc(p.email)}"><button class="btn leave sm" type="submit">Remove</button></form>`;
  // Tappable name → profile popup (reuses the shared pvOpen + /u/:id/card); guests (no
  // applicant_id) stay plain text. Role badge mirrors the basketball roster.
  const demoIdx = (em) => { const m = /^demo-(\d+)@demo\.local$/.exec(em); return m ? Number(m[1]) : 0; };
  const nameLink = (p, inner) => (p.applicant_id && !/@guest\.local$/.test(p.email))
    ? `<a class="lrlink" href="/u/${p.applicant_id}" onclick="if(window.pvOpen){pvOpen(${p.applicant_id});return false;}">${inner}</a>`
    // Demo players have no account — their names open the same profile popup via the demo card
    // route, so the showcase feels live (profile, role, stats, Follow) without real rows.
    : (demoMode && demoIdx(p.email) ? `<a class="lrlink" href="#" onclick="if(window.pvOpenDemo){pvOpenDemo(${demoIdx(p.email)});}return false;">${inner}</a>` : inner);
  // Auto-renew penalty badge (Phase 5.5, operators only): an amber ⏸/⚠ chip + a one-tap ✓ Forgive for
  // any floor player carrying strikes or a pause. penaltyState is {} for members + for programs that
  // never enabled the penalty → zero bytes there (pk/basketball stay byte-identical).
  const penBadge = (p) => {
    const pi = penaltyState[p.email]; if (!pi) return '';
    const paused = !!pi.until;
    const ttl = paused ? `Auto-renew paused until ${esc(pi.until)} after no-shows — ✓ to forgive` : `${pi.strikes} auto-renew no-show strike${pi.strikes === 1 ? '' : 's'} — ✓ to forgive`;
    return `<span class="tag" title="${ttl}" style="margin-left:4px;background:#b3541e;color:#fff">${paused ? '⏸ paused' : '⚠ ' + pi.strikes}</span><form method="POST" action="${runBase}/penalty/clear" class="swapform" style="display:inline;margin:0 0 0 4px"><input type="hidden" name="email" value="${esc(p.email)}"><button class="btn ghost sm" type="submit" title="Forgive — clear strikes/pause" style="padding:1px 7px">✓</button></form>`;
  };
  const rowFloor = (p, n) => `<div class="lr"><span class="ln">${n}</span>${nameLink(p, `<span class="lav">${avatarInner(p.email, p.name)}</span><span class="lnm">${esc(p.name)}${p.minor ? MINOR_STAR : ''}${p.email === email ? ' <span class="tag">You</span>' : ''}${p.confirmed_at ? ' <span class="tag reg" title="Confirmed coming">✓</span>' : ''}</span>`)}${canOperate ? penBadge(p) + rmForm(p) : ''}</div>`;
  const rowWait = (p, i) => `<div class="lr"><span class="ln">W${i}</span>${nameLink(p, `<span class="lav wl">${avatarInner(p.email, p.name)}</span><span class="lnm">${esc(p.name)}${p.minor ? MINOR_STAR : ''}</span>`)}${canOperate ? `<form method="POST" action="${runBase}/bump" style="margin:0"><input type="hidden" name="email" value="${esc(p.email)}"><button class="btn sm" type="submit">Bump in</button></form>${rmForm(p)}` : ''}</div>`;
  // Offer-window programs only: a waitlister who's been offered a freed floor spot (holding it until
  // they claim or it expires). offeredPlayers is empty for simple programs, so this never renders.
  // In DEMO mode the operator gets a one-tap "✓ Claim" (a real player would tap their emailed link) so
  // the auto-offer → claim → promote money-moment can be driven live on one screen.
  const demoClaimForm = (p) => (demoMode && canOperate && p.claim_token)
    ? `<form method="POST" action="${runBase}/claim/${encodeURIComponent(p.claim_token)}" style="margin:0"><button class="btn primary sm" type="submit" title="Complete the claim (demo)">✓ Claim</button></form>`
    : '';
  const rowOffer = (p) => `<div class="lr"><span class="ln">·</span>${nameLink(p, `<span class="lav wl">${avatarInner(p.email, p.name)}</span><span class="lnm">${esc(p.name)}${p.minor ? MINOR_STAR : ''}${p.email === email ? ' <span class="tag">You</span>' : ''} <span class="tag">⏳ Claiming</span></span>`)}${canOperate ? demoClaimForm(p) + rmForm(p) : ''}</div>`;
  let action;
  if (cancelled) action = `<button class="btn" type="button" disabled>Run cancelled</button>`;
  else if (myState === 'in') action = `<form method="POST" action="${runBase}/leave"><button class="btn ghost" type="submit">Sit out</button></form>`;
  else if (myState === 'waitlist') action = `<form method="POST" action="${runBase}/leave"><button class="btn ghost" type="submit">Leave waitlist (#${myWaitPos} of ${waiting})</button></form>`;
  else if (!isOpen) action = `<button class="btn" type="button" disabled>Check-in closed</button>`;
  else if (totalFull) action = `<button class="btn" type="button" disabled>Run &amp; waitlist full</button>`;
  else if (full) action = `<form method="POST" action="${runBase}/join"><button class="btn primary" type="submit">Join waitlist (${waiting}/${waitlistCap})</button></form>`;
  else action = `<form method="POST" action="${runBase}/join"><button class="btn primary" type="submit">I'm in</button></form>`;
  const runToggle = canOperate && !cancelled ? (isOpen ? `<form method="POST" action="${runBase}/close" style="margin:0"><button class="btn leave" type="submit">Close check-in</button></form>` : `<form method="POST" action="${runBase}/open" style="margin:0"><button class="btn primary" type="submit">Open check-in</button></form>`) : '';

  // ----- teal scoreboard hero (mirrors the basketball check-in hero) -----
  // "Group chat" button beside the Run pill — links to the Pickleball chat tab; small
  // unread dot when group unread > 0.
  const chatBtn = `<a class="hchat" href="${runBase}/chat" data-chat-program="${programId}" aria-label="Group chat${groupUnread > 0 ? `, ${groupUnread} unread` : ''}">
        <span class="hci">${GROUP_ICON}</span>Group chat${groupUnread > 0 ? '<span class="hdot" aria-hidden="true"></span>' : ''}
      </a>`;
  // Operator "Add a guest" — sits on the RIGHT of the Checked-in / Waitlist row.
  const addGuest = canOperate
    ? `<details class="hguest">
        <summary>+ Guest</summary>
        <form method="POST" action="${runBase}/guest" onsubmit="var b=this.querySelector('button');if(b.dataset.s){return false;}b.dataset.s=1;b.disabled=true;b.textContent='Adding…';">
          <input name="name" required maxlength="60" placeholder="Guest name — last-minute add">
          <div style="height:8px"></div>
          <button class="btn sm" type="submit">Add guest to the run</button>
        </form>
      </details>`
    : '';
  // ----- hero footer (INSIDE the card, like basketball): Post announcement (operators,
  //       LEFT) + Auto-renew pill (members, RIGHT) -----
  const annCompose = canOperate
    ? `<details class="announce-compose"><summary>📣 Post announcement</summary><form method="POST" action="${runBase}/announce" class="swapform" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s){return false;}b.dataset.s=1;b.disabled=true;b.textContent='Posting…';"><textarea name="body" required maxlength="1000" rows="2" placeholder="Message to all ${low} members (pushes to their phones)"></textarea><div style="height:8px"></div><label style="margin:0 0 8px">Schedule (optional) <span style="text-transform:none;font-weight:400;color:var(--muted)">— leave empty to post now</span><input type="datetime-local" name="publish_at"></label><label class="lvl" style="margin:0 0 8px"><input type="checkbox" name="email_everyone"> Also email everyone</label><button class="btn sm" type="submit">Post &amp; notify</button></form>${schedAnns.length ? `<ul class="annlog" style="margin-top:10px">${schedAnns.map((x) => `<li>
        <div class="annlog-b">${esc(x.body)}</div>
        <div class="annlog-m"><span class="annlog-state sched">Scheduled</span> Fires ${esc(String(x.publish_at || '').replace('T', ' '))}
          <form method="POST" action="${runBase}/announce/cancel" class="swapform" style="display:inline;margin-left:6px"><input type="hidden" name="id" value="${Number(x.id)}"><button class="btn ghost sm" type="submit" style="padding:3px 10px">Cancel</button></form></div>
      </li>`).join('')}</ul>` : ''}</details>`
    : '';
  // Kiosk link for the door crew (proposal #3): per-program token the operator/host mints
  // themselves — no admin round-trip; rotating kills only THIS program's screens.
  // kioskable (not bare canOperate): the static demo program has no kiosk by design, so it
  // must never offer the controls (the 2026-08-04 'Not found' tap).
  // The ladder sits in the same operator row as the kiosk link: on run night the scorer is already
  // on this page, and typing a URL at the net is not a workflow.
  const ladderPath = progMeta(programId).ladder;
  // The teams board and the leaderboard sit in this same operator row, for the reason stated
  // above: on run night the operator is already on this page, and typing a URL at the net is not
  // a workflow. Both paths were published by the server registry and read by NOBODY until
  // 2026-09-14 — the teams board, the courtside surface the whole games feature was built for,
  // was reachable only by typing /checkin/teams.
  // Gating differs because the routes differ: the teams board is operator-only (runTeamsBoard
  // redirects everyone else), so offering it to a member would be a link that bounces them. The
  // leaderboard is readable by anyone who has joined the run, so it shows for everyone.
  const teamsPath = progMeta(programId).teams;
  const boardPath = progMeta(programId).leaderboard;
  const kioskRow = (kioskable || ladderPath || boardPath || (canOperate && teamsPath))
    ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
        ${canOperate && teamsPath ? `<a class="btn ghost sm" style="margin:0" href="${esc(teamsPath)}">🏀 Teams board</a>` : ''}
        ${boardPath ? `<a class="btn ghost sm" style="margin:0" href="${esc(boardPath)}">🏆 Standings</a>` : ''}
        ${ladderPath ? `<a class="btn ghost sm" style="margin:0" href="${esc(ladderPath)}">📋 Ladder &amp; scores</a>` : ''}
        ${kioskUrl ? `<a class="btn ghost sm" style="margin:0" target="_blank" rel="noopener" href="${esc(kioskUrl)}">📺 Kiosk screen</a>` : ''}
        ${kioskable ? `<form method="POST" action="${runBase}/kiosk-rotate" class="swapform" style="margin:0"${kioskUrl ? ` onsubmit="return confirm('Refresh this run&#39;s kiosk link? Screens on the old link stop working.')"` : ''}><button class="btn ghost sm" type="submit">${kioskUrl ? '↻ Refresh kiosk link' : '📺 Create kiosk link'}</button></form>` : ''}
      </div>`
    : '';
  const autoRenewPill = cancelled ? '' : `<form method="POST" action="${runBase}/autorenew" class="arform" style="margin:0"><input type="hidden" name="on" value="${iAutoRenew ? '0' : '1'}"><button class="arpill${iAutoRenew ? ' on' : ''}" type="submit" title="Auto-join the ${low} run each week">🔁 Auto-renew${iAutoRenew ? ' · ON' : ' · OFF'}</button></form>`;
  const heroFooter = (annCompose || autoRenewPill || kioskRow)
    ? `<div class="hann"><div class="hann-l">${annCompose}${kioskRow}</div>${autoRenewPill ? `<div class="hann-r">${autoRenewPill}</div>` : ''}</div>`
    : '';
  const scoreInner = `
    <div class="count">
      <span class="n">${going}</span>
      <span class="of">/${cap}</span>
    </div>
    <div class="seeall"><div class="chev">›</div><span>Who's going</span></div>`;
  const hero = `
    <div class="hero">
      <div class="wood"></div>
      ${COURT_SVG}
      <div class="htop">
        <span class="spill${(cancelled || !isOpen) ? ' closed' : ''}">● Run ${cancelled ? 'Cancelled' : (isOpen ? 'Open' : 'Closed')}</span>
        ${chatBtn}
      </div>
      <div class="score" role="button" tabindex="0" onclick="wgOpen()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();wgOpen()}">${scoreInner}</div>
      <div class="hbar"><div>${going}<span>Checked in</span></div><div>${waiting}<span>Waitlist</span></div>${addGuest}</div>
      <div class="hsub"><span class="hdate">${cancelled ? 'cancelled' : isOpen ? 'registration live' : 'check-in closed'}</span></div>
      ${heroFooter}
    </div>`;

  // ----- "Who's going" bottom-sheet overlay (cloned from basketball's wgSheet) -----
  // Read-only for members; operators (canOperate) get Remove on floor rows and
  // Bump-in + Remove on waitlist rows (rowFloor / rowWait already carry those). These
  // POST normally (302 → /pickleball).
  const wgSheet = `
    <div id="wgwrap" class="wgwrap">
      <div class="wgscrim" onclick="wgClose()"></div>
      <div class="wgsheet" role="dialog" aria-modal="true" aria-label="Who's going">
        <div class="wgsheet-h"><b>On the floor · ${going} / ${cap}</b><button class="wgx" type="button" onclick="wgClose()" aria-label="Close">${IC_CLOSE}</button></div>
        <div class="wgsheet-b">
          ${floorPlayers.length ? floorPlayers.map((p, i) => rowFloor(p, i + 1)).join('') : '<div class="subh">Nobody yet — be the first in.</div>'}${offeredPlayers.length ? `<div class="subh">Holding a spot · offer sent</div>${offeredPlayers.map((p) => rowOffer(p)).join('')}` : ''}
          ${waitPlayers.length ? `<div class="subh">Waitlist · ${waiting}</div>${waitPlayers.map((p, i) => rowWait(p, i + 1)).join('')}` : ''}
        </div>
      </div>
    </div>`;

  // Teams panel (Phase 5) — renders only for a program with config.features.teams (teamsCfg). Empty
  // string otherwise → byte-identical for programs without teams. Numbered teams + members + a
  // self-join/switch button (floor players, once teams open) + operator auto-fill/assign controls.
  const teamsPanel = !teamsCfg ? '' : (() => {
    const assigned = new Set(teamRows.map(r => r.email));
    const nameOf = (em) => { const p = floorPlayers.find(x => x.email === em); return esc(p ? p.name : em) + (p && p.minor ? MINOR_STAR : ''); };   // minors carry the red asterisk in EVERY list
    // Party colour map: everyone sharing a group_id gets the same muted dot, so you can see at a
    // glance who queued together (solo players get no dot). Palette cycles past 6 parties.
    const partyIdx = new Map();
    for (const p of floorPlayers) if (p.group_id && !partyIdx.has(p.group_id)) partyIdx.set(p.group_id, (partyIdx.size % 6) + 1);
    const pdot = (em) => { const p = floorPlayers.find(x => x.email === em); const i = p && p.group_id ? partyIdx.get(p.group_id) : 0; return i ? `<span class="pdot pd${i}" title="Checked in as a group"></span>` : ''; };
    // Tappable like every roster: real players open the profile popup, demo players the demo card.
    const nameCell = (em) => { const p = floorPlayers.find(x => x.email === em); return p ? nameLink(p, nameOf(em)) : nameOf(em); };
    const myTeam = (teamRows.find(r => r.email === email) || {}).team_no || 0;
    const onFloor = floorPlayers.some(p => p.email === email);
    const cols = [];
    const teamCount = {};   // per-team sizes, reused by the Unassigned quick-assign buttons
    for (let n = 1; n <= teamsCfg.count; n++) {
      const mem = teamRows.filter(r => r.team_no === n);
      teamCount[n] = mem.length;
      const full = mem.length >= teamsCfg.size;
      const canJoin = teamsOpen && onFloor && teamsCfg.selfServe && myTeam !== n && !full;
      cols.push(`<div style="flex:1;min-width:118px;border:1px solid var(--line);border-radius:12px;padding:10px;background:var(--card)${full ? ';opacity:.55' : ''}"><div style="font-weight:800;margin-bottom:6px">Team ${n} <span style="color:var(--muted);font-weight:600">${mem.length}/${teamsCfg.size}${full ? ' · FULL' : ''}</span></div>${mem.map(r => `<div style="display:flex;align-items:center;gap:6px;padding:3px 0">${pdot(r.email)}<span style="flex:1">${nameCell(r.email)}${r.email === email ? ' <span class="tag">You</span>' : ''}</span>${canOperate ? `<form method="POST" action="${runBase}/team/assign" style="margin:0"><input type="hidden" name="email" value="${esc(r.email)}"><input type="hidden" name="team" value="0"><button class="btn ghost sm" type="submit" title="Unassign">×</button></form>` : ''}</div>`).join('') || '<div style="color:var(--muted)">—</div>'}${canJoin ? `<form method="POST" action="${runBase}/team/join" style="margin:6px 0 0"><input type="hidden" name="team" value="${n}"><button class="btn sm" type="submit">${myTeam ? 'Switch here' : 'Join'}</button></form>` : ''}</div>`);
    }
    const unassigned = floorPlayers.filter(p => !assigned.has(p.email));   // guests included — they play (2026-08-04)
    const ops = canOperate ? `<form method="POST" action="${runBase}/team/fill" style="margin:10px 0 0"><button class="btn sm" type="submit">⚖ Auto-fill teams</button></form>${unassigned.length ? `<div class="subh" style="margin-top:10px">Unassigned · ${unassigned.length}</div>${unassigned.map(p => `<div style="display:flex;align-items:center;gap:6px;padding:3px 0">${pdot(p.email)}<span style="flex:1">${nameCell(p.email)}</span>${Array.from({ length: teamsCfg.count }, (_, i) => `<form method="POST" action="${runBase}/team/assign" style="margin:0"><input type="hidden" name="email" value="${esc(p.email)}"><input type="hidden" name="team" value="${i + 1}"><button class="btn ghost sm" type="submit"${teamCount[i + 1] >= teamsCfg.size ? ' disabled style="opacity:.35"' : ''}>${i + 1}</button></form>`).join('')}</div>`).join('')}` : ''}` : '';
    const mine = myTeam ? `<form method="POST" action="${runBase}/team/leave" style="margin:10px 0 0"><button class="btn ghost sm" type="submit">Leave my team</button></form>` : '';
    return `<div class="infosec teamspanel" style="margin-top:20px"><div class="card"><div class="clab">Teams</div>${teamsOpen ? '' : '<p class="tally-note" style="color:var(--muted);margin:6px 0 10px">Teams open once the roster locks.</p>'}<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">${cols.join('')}</div>${mine}${ops}</div></div>`;
  })();
  // Queue-with-friends panel (Phase 6b) — renders only when partyData is present (config.features.groupQueue,
  // volleyball). Empty string otherwise → byte-identical for programs without it. Forms carry .swapform so
  // invite/accept/decline/check-in/leave swap in place. A party seats atomically (server side).
  // Party card — parties are created/managed on the FRIENDS tab; this card is just status + the
  // one-tap group check-in (any joined member seats the whole party, all confirmed on the spot).
  const partyPanel = !partyData ? '' : (() => {
    const pd = partyData;
    let mine;
    if (pd.party) {
      const p = pd.party;
      const rows = p.members.map(m => `<div style="display:flex;align-items:center;gap:6px;padding:3px 0">
          <span style="flex:1">${m.id ? `<a class="lrlink" href="/u/${m.id}" onclick="if(window.pvOpen){pvOpen(${m.id});return false;}">${esc(m.name)}${m.minor ? MINOR_STAR : ''}</a>` : esc(m.name) + (m.minor ? MINOR_STAR : '')}</span>${m.checkedIn ? '<span class="tag" style="background:#2f7169;color:#fff">✓ In</span>' : ''}</div>`).join('');
      const allIn = p.members.every(m => m.checkedIn);
      const checkinBtn = (isOpen && !cancelled && !allIn && !p.tooBig)
        ? `<form class="swapform" method="POST" action="${runBase}/party/checkin" style="margin:0"><button class="btn primary" type="submit">✓ Check in my party (${p.members.length})</button></form>` : '';
      const note = p.tooBig
        ? `<p class="tally-note" style="color:var(--muted);margin:8px 0 0">Your party (${p.members.length}) is bigger than this run's group limit (${pd.maxSize}) — trim it on the Friends tab.</p>`
        : (allIn ? `<p class="tally-note" style="color:var(--muted);margin:8px 0 0">Everyone's in — see you out there. 🎉</p>`
        : `<p class="tally-note" style="color:var(--muted);margin:8px 0 0">One tap seats everyone together — floor or waitlist, as one. Checking in counts as confirming.</p>`);
      mine = `<div class="clab">Your party${p.name ? ` · ${esc(p.name)}` : ''} <span style="color:var(--muted);font-weight:600">${p.members.length}/${pd.maxSize}</span></div>${rows}<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">${checkinBtn}</div>${note}
        <p class="tally-note" style="margin:6px 0 0"><a href="/friends">Manage your party on the Friends tab →</a></p>`;
    } else {
      mine = `<div class="clab">Queue with friends</div><p class="tally-note" style="color:var(--muted);margin:6px 0">Create a party on the <a href="/friends">Friends tab</a> — then check in together here with one tap.</p>`;
    }
    const notice = partyMsg === 'full'
      ? `<div class="notice warn" style="margin-top:10px">Your whole party doesn't fit in what's left of this run — the group seats together or not at all, so nobody was added.</div>`
      : partyMsg === 'big' ? `<div class="notice warn" style="margin-top:10px">Your party is bigger than this run's group limit — trim it on the Friends tab.</div>` : '';
    return `${notice}<div class="infosec teamspanel" style="margin-top:20px"><div class="card">${mine}</div></div>`;
  })();
  return HEAD(`${sport} — The Bridge`, `has-tabs ${theme}`) + header(`<b>${up}</b>${esc(email)}`, wdayShort(runDate), ann, hours) + `
    ${backToRuns}
    <div class="rule"></div>
    ${hidden ? `<div class="notice" style="margin-top:10px">🔒 <b>Hidden run</b> — only admins can see this. Flip it live when it's ready.${isAdmin ? ` <form method="POST" action="${runBase}/publish" class="swapform" style="display:inline"><button class="btn sm" type="submit" style="margin-left:6px">Make it live</button></form>` : ''}</div>` : (isAdmin ? `<div class="notice good" style="margin-top:10px">✅ <b>Live</b> — members can join. <form method="POST" action="${runBase}/publish" class="swapform" style="display:inline" onsubmit="return confirm('Hide this run from every member? Nobody but admins will see it until you publish it again.');"><input type="hidden" name="on" value="0"><button class="btn ghost sm" type="submit" style="margin-left:6px">Hide again</button></form></div>` : '')}
    <div class="phead"><h1>${sportE} ${emojiE}</h1></div>
    ${cancelled ? `<p class="psub" style="margin:-4px 0 8px;color:var(--muted)">Cancelled this week</p>` : ''}
    <div class="gymbanner">
      <img src="${esc(bannerSrc)}?v=${esc(String(bannerVer))}" alt="The Bridge court" width="1160" height="580" fetchpriority="high">
      <div class="gymcap">
        ${cancelled
          ? `<div class="l">This week<b>🚫 Run cancelled</b></div>`
          : `<div class="l">Next run<b>${esc(wdayFull(runDate))} · ${esc(runLabel)} · ${esc(startLabel)}</b></div>
        <div class="r"><span>Starts in</span><b class="tick" data-tip="${tipoff}">${esc(fmtCountdown(tipoff))}</b></div>`}
      </div>
      ${canOperate && !demoMode ? `<a class="bannedit" href="${runBase}/banner" aria-label="Change banner photo">🖼 Change</a>` : ''}
    </div>
    ${announcement ? `<div class="notice" style="margin-top:10px;display:flex;align-items:flex-start;gap:8px;justify-content:space-between"><span>📣 <b>Announcement</b> · ${esc(announcement.body)}${announcement.author ? `<span style="color:var(--muted)"> — ${esc(announcement.author)}</span>` : ''}</span>${canOperate ? `<form method="POST" action="${runBase}/announce/retract" class="swapform" style="margin:0;flex-shrink:0"><button class="btn ghost sm" type="submit" title="Retract this announcement">Retract</button></form>` : ''}</div>` : ''}
    ${hero}${joinErrNotice(joinErr)}${demoMode && canOperate ? `<div class="notice demonote" style="margin-top:10px">🎬 <b>Demo mode.</b> Seed a full floor + waitlist, then pull a floor player (Remove in "Who's going") to fire a real auto-offer — the top waitlister moves to <b>⏳ Claiming</b>; tap <b>✓ Claim</b> to slide them onto the floor. <b>End queue</b> = run's over (roster archives, check-in closes); <b>Start queue</b> = next week opens and the auto-renewers instantly claim their guaranteed spots. Nothing here touches live data.<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><form method="POST" action="/admin/demo/seed" class="swapform" style="margin:0"><button class="btn primary sm" type="submit">${going + waiting ? '↻ Reset' : '▶ Seed'} full run</button></form><form method="POST" action="/admin/demo/endqueue" class="swapform" style="margin:0"><button class="btn sm" type="submit">⏹ End queue</button></form><form method="POST" action="/admin/demo/startqueue" class="swapform" style="margin:0"><button class="btn sm" type="submit">▶ Start queue</button></form><form method="POST" action="/admin/demo/clear" class="swapform" style="margin:0" onsubmit="return confirm('Clear the demo run?')"><button class="btn ghost sm" type="submit">Clear</button></form><a class="btn ghost sm" style="margin:0" target="_blank" rel="noopener" href="/kiosk/90">📺 Kiosk screen</a></div></div>` : ''}
    ${canOperate && pendingRequests.length ? `<div class="notice warn" style="margin-top:10px">
      <b>Join requests (${pendingRequests.length})</b>
      ${pendingRequests.map(p => `<div style="display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap"><span style="flex:1;min-width:140px">${esc(p.name)}</span>
        <form method="POST" action="${runBase}/requests" class="swapform" style="margin:0"><input type="hidden" name="email" value="${esc(p.email)}"><input type="hidden" name="act" value="approve"><button class="btn sm" type="submit">Approve</button></form>
        <form method="POST" action="${runBase}/requests" class="swapform" style="margin:0"><input type="hidden" name="email" value="${esc(p.email)}"><input type="hidden" name="act" value="decline"><button class="btn ghost sm" type="submit">Decline</button></form></div>`).join('')}
    </div>` : ''}
    ${(action || runToggle) ? `<div class="controls">${action}${runToggle}</div>` : ''}
    ${myState === 'in' && !cancelled && confirmBy ? (myConfirmed
      ? `<div class="notice good" style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span style="flex:1;min-width:180px">✓ <b>You're confirmed</b> — see you there!</span><form method="POST" action="${runBase}/confirm" class="swapform" style="margin:0"><input type="hidden" name="un" value="1"><button class="btn ghost sm" type="submit" style="width:auto">Undo ✕</button></form></div>`
      : `<form method="POST" action="${runBase}/confirm" class="swapform" style="margin-top:10px"><button class="btn primary" type="submit">✓ I'm coming</button><p class="tally-note" style="margin:6px 0 0">Confirm by <b>${esc(confirmBy)}</b> — unconfirmed spots go to the waitlist.</p></form>`) : ''}
    ${myState === 'waitlist' && !cancelled ? `<div class="notice warn" style="margin-top:10px">You're <b>#${myWaitPos} of ${waiting}</b> on the waitlist. If a spot opens you'll get a notification and move onto the floor — no need to re-check.</div>` : ''}${partyPanel}${teamsPanel}
    ${cancelled ? '' : `<div style="margin-top:12px"><a href="${runBase}/run.ics" style="font-size:13px;color:var(--muted)">📅 Add this run to your calendar</a></div>`}
    ${qrBlock}
    <div style="height:28px"></div>
    ${locationBlock}
    ${canOperate ? `<div class="infosec" style="margin-top:20px"><div class="card"><div class="clab">Operator tools</div>
      ${(pkMsg === 'season') ? '<div class="notice good">Season start set ✓</div>'
        : (pkMsg === 'seasonoff') ? '<div class="notice good">Season cleared — runs resume every week ✓</div>'
        : (pkMsg === 'date') ? '<div class="notice good">Run date updated ✓</div>'
        : (pkMsg === 'seasonpast') ? '<div class="notice bad">Pick a season start that is not in the past.</div>'
        : (pkMsg === 'seasonrange') ? '<div class="notice bad">Pick a season start within the next year.</div>'
        : (pkMsg === 'seasonbad') ? '<div class="notice bad">That season date did not look right — try again.</div>'
        : (pkMsg === 'datepast') ? '<div class="notice bad">Pick a run date that is not in the past.</div>'
        : (pkMsg === 'daterange') ? '<div class="notice bad">Pick a run date within the next 60 days.</div>'
        : (pkMsg === 'datebad') ? '<div class="notice bad">That run date did not look right — try again.</div>' : ''}
      ${preseason
        ? `<p class="tally-note" style="color:var(--muted);margin:8px 0 0">Runs ${dayName}s. Weekly run-date &amp; cancel controls appear once the season starts (${esc(seasonWeekday)}, ${esc(seasonLabel)}).</p>`
        : `<form method="POST" action="${runBase}/date" class="swapform" style="display:flex;gap:8px;align-items:center;margin:8px 0 0"><input type="date" name="date" value="${esc(runDate)}" style="font-size:16px"><button class="btn ghost sm" type="submit">Set run date</button></form>
      ${cancelled
        ? `<form method="POST" action="${runBase}/cancel" class="swapform" style="margin-top:10px"><input type="hidden" name="on" value="0"><button class="btn ghost sm" type="submit">Restore this run</button></form>`
        : `<form method="POST" action="${runBase}/cancel" class="swapform" style="margin-top:10px" onsubmit="return confirm('Cancel this week\\'s run?')"><button class="btn ghost sm" type="submit">🚫 Cancel this week</button></form>`}`}
      <div class="rule" style="margin:14px 0 12px"></div>
      <div class="clab" style="margin-bottom:2px">Season</div>
      <p class="tally-note" style="margin:6px 0 10px">${season
        ? `Season starts <b>${esc(seasonWeekday)}, ${esc(seasonLabel)}</b> — no runs and no auto check-in until then.`
        : `Runs every ${dayName}. Set a season start to pause the schedule until the season opens.`}</p>
      <form method="POST" action="${runBase}/season" class="swapform" style="margin:0">
        <div class="field"><label>Season start</label><input type="date" name="season" value="${esc(season)}" min="${esc(today)}" max="${esc(seasonMax)}" style="font-size:16px;min-height:44px;padding:11px 13px;width:100%;box-sizing:border-box;max-width:100%"></div>
        <button class="btn sm" type="submit" style="margin-top:8px">Set season start</button>
      </form>
      ${season ? `<form method="POST" action="${runBase}/season" class="swapform" style="margin-top:8px" onsubmit="return confirm('Clear the season start? Runs resume every week right away.');"><input type="hidden" name="season" value=""><button class="btn ghost sm" type="submit">Clear — run every week</button></form>` : ''}
    </div></div>` : ''}
    ${wgSheet}
    <div id="pvwrap" class="wgwrap pvwrap"><div class="wgscrim" onclick="pvClose()"></div>
      <div class="wgsheet pvsheet" role="dialog" aria-modal="true" aria-label="Player profile">
        <div class="wgsheet-h"><b>Profile</b><button class="wgx" type="button" onclick="pvClose()" aria-label="Close">${IC_CLOSE}</button></div>
        <div class="wgsheet-b pvbody"><div class="pcload">Loading…</div></div>
      </div></div>
    <script>
      // Who's-going overlay (cloned from the basketball check-in page). Open is instant;
      // close plays a slide-down unless reduced-motion / noanim.
      window.wgOpen=function(){var w=document.getElementById('wgwrap');if(w){window.__ovPrev=document.activeElement;w.classList.add('open');document.body.style.overflow='hidden';var sh=w.querySelector('.wgsheet');if(sh){sh.setAttribute('tabindex','-1');try{sh.focus();}catch(e){}}}};
      window.wgClose=function(){var w=document.getElementById('wgwrap');if(!w)return;var sh=w.querySelector('.wgsheet');
        var still=document.documentElement.classList.contains('noanim')||(window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches);
        function restore(){var p=window.__ovPrev;if(p&&p.focus)try{p.focus();}catch(e){}}
        if(sh&&!still){sh.classList.add('closing');setTimeout(function(){w.classList.remove('open');sh.classList.remove('closing');document.body.style.overflow='';restore();},200);}
        else{w.classList.remove('open');document.body.style.overflow='';restore();}};
      // Quick-look profile popup (tap a name). Opens ON TOP of the who's-going sheet; closing
      // reveals the who's-going sheet still underneath.
      window.pvOpen=function(id){var w=document.getElementById('pvwrap');if(!w)return;var b=w.querySelector('.pvbody');if(b)b.innerHTML='<div class="pcload">Loading…</div>';w.classList.add('open');document.body.style.overflow='hidden';
        if(window.fetch)fetch('/u/'+id+'/card',{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.ok?r.text():Promise.reject();}).then(function(h){if(b)b.innerHTML=h;}).catch(function(){if(b)b.innerHTML='<div class="pcload">Couldn\\u2019t load that profile.</div>';});};
      // Demo-run variant: synthetic players have no /u id — their card comes from /demo/u/:i/card.
      window.pvOpenDemo=function(i){var w=document.getElementById('pvwrap');if(!w)return;var b=w.querySelector('.pvbody');if(b)b.innerHTML='<div class="pcload">Loading…</div>';w.classList.add('open');document.body.style.overflow='hidden';
        if(window.fetch)fetch('/demo/u/'+i+'/card',{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.ok?r.text():Promise.reject();}).then(function(h){if(b)b.innerHTML=h;}).catch(function(){if(b)b.innerHTML='<div class="pcload">Couldn\\u2019t load that profile.</div>';});};
      window.pvClose=function(){var w=document.getElementById('pvwrap');if(!w)return;w.classList.remove('open');var wg=document.getElementById('wgwrap');if(!(wg&&wg.classList.contains('open')))document.body.style.overflow='';};
      // Countdown ticker for the next-run banner (mirrors the check-in tip-off ticker).
      function pkTick(){var el=document.querySelector('.gymbanner .tick');if(!el)return;var tip=+el.getAttribute('data-tip');var diff=tip-Date.now();
        if(diff<=0){el.textContent="IT'S GAME TIME";return;}
        function pad(n){return String(n).padStart(2,'0');}
        var d=Math.floor(diff/86400000),h=Math.floor(diff%86400000/3600000),m=Math.floor(diff%3600000/60000);
        el.textContent=d+'D '+pad(h)+':'+pad(m);}
      pkTick(); if(!window.__pkTickBound){window.__pkTickBound=true;setInterval(pkTick,30000);}
      // Live refresh: re-fetch + swap the page when the run fingerprint changes (join/leave/
      // confirm/open-close/announce). Gentle — never nukes an open sheet or a form being filled.
      window.__pkOnChange=function(){
        if((window.__overlayOpen&&window.__overlayOpen())||(window.__composing&&window.__composing()))return;
        if(!window.fetch||!window.__swapWrap)return;
        fetch('${runBase}',{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.text();}).then(function(h){document.documentElement.classList.add('noanim');window.__swapWrap(h);}).catch(function(){});
      };
      if(window.__poll)window.__poll('${pollKey}',window.__pkOnChange);
    </script>
  ` + footWithTabs(tabNav('runs', { dm: dmUnread, group: groupUnread, groupMention, program: programId }));
}
// Thin wrapper — runPage's defaults ARE the pickleball values, so this stays byte-identical.
export function pickleballPage(state) { return runPage(state); }
