// views/pages/profile.js — profiles: another player's page and card, the demo cards, and your own
// profile tab (edits, photo, inbox, settings).
import { esc, fmtMonthYear, wdayShort, fmtWhen } from '../util.js';
import {
  avatarInner, MINOR_BADGE, tabNav, WELCOME_MODAL, followBtn, annBell, progMeta,
} from '../components.js';
import { isSticker } from '../chat-ui.js';
import { HEAD, header, footWithTabs } from '../shell.js';

// ---------- PROFILE (view another player) ----------
// Compact profile card — served as a fragment for the quick-look popup (tap a name in the
// who's-going sheet). Just the essentials + a Message / Full-profile jump; no page chrome.
// DEMO-ONLY quick-look card for synthetic @demo.local players (the demo run is admin-only):
// looks and feels like the live card — avatar, role badge, stats, minor tag, a Follow toggle —
// but is generated from the seeded roster row. Nothing persists (demo players have no accounts
// by design); the Follow button toggles client-side so the showcase reads as live.
export function demoProfileCard({ name = '', idx = 1, minor = false }) {
  const role = idx === 1 ? '<span class="bdg host">★ Host</span>'
    : (idx === 2 || idx === 6) ? '<span class="bdg team">◆ Team</span>'
    : idx === 3 ? '<span class="bdg core">★ Pillar</span>'
    : '<span class="bdg reg">Regular</span>';
  const stats = { total: 24 - idx, season: ((idx * 3) % 9) + 2, streak: idx % 4 };   // deterministic, plausible
  const POS = ['PG', 'SG', 'SF', 'PF', 'C'];
  return `<div class="pchero"><div class="pcav pcav-xl">${avatarInner(`demo-${idx}@demo.local`, name)}</div>
      <div class="pcnm pcnm-xl">${esc(name)}</div><div class="pcbadge">${minor ? MINOR_BADGE : ''}${role}</div><div class="pcsince">${esc(POS[idx % POS.length])} · Member since Mar 2026</div></div>
    <div class="pcstats"><div><b>${stats.total}</b><span>Games</span></div><div><b>${stats.season}</b><span>Season</span></div><div><b>${stats.streak}</b><span>Streak</span></div></div>
    <a class="pact primary" href="/demo/chat"><span class="pic">💬</span>Send a Message<span class="pchev">›</span></a>
    <button type="button" class="pact" onclick="var b=this,on=b.dataset.on;b.dataset.on=on?'':'1';b.querySelector('.pl').textContent=on?'Follow':'✓ Following';"><span class="pic">👥</span><span class="pl">Follow</span><span class="pchev">›</span></button>`;
}

// Quick-look profile card — ACTION-SHEET layout (owner spec, Javelin-style): big centered
// avatar + name, then stacked action rows — Send a Message (primary), View Profile, Follow
// toggle, Block. Minor tag for every viewer; role badges admin-only. Contact info stays on the
// full profile (operator rule) — the card is actions, not data.
export function profileCard({ p, stats, canDM = true, isSelf = false, minor = false, showRoles = false, following = false, blocked = false, restricted = false }) {
  const rb = (minor ? MINOR_BADGE : '') + (showRoles ? (p.is_host ? '<span class="bdg host">★ Host</span>' : p.is_team ? '<span class="bdg team">◆ Team</span>' : p.is_regular ? '<span class="bdg core">★ Pillar</span>' : '<span class="bdg reg">Regular</span>') : '');
  const memberSince = stats.first ? fmtMonthYear(stats.first) : null;
  const chev = '<span class="pchev">›</span>';
  const post = (path) => `fetch('${path}',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'fetch'},body:'id=${p.id}',credentials:'same-origin'})`;
  const actions = isSelf
    ? `<a class="pact" href="/profile"><span class="pic">👤</span>Edit profile${chev}</a>`
    : restricted
    // They blocked the viewer — no phantom Follow/Block affordances; View Profile only.
    ? `<a class="pact" href="/u/${p.id}"><span class="pic">👤</span>View Profile${chev}</a>`
    : [
      canDM ? `<a class="pact primary" href="/messages/${p.id}"><span class="pic">💬</span>Send a Message${chev}</a>` : '',
      `<a class="pact" href="/u/${p.id}"><span class="pic">👤</span>View Profile${chev}</a>`,
      blocked
        ? `<button type="button" class="pact danger" onclick="${post('/friends/unblock')};this.outerHTML='<div class=\\'pact\\'>Unblocked ✓</div>';"><span class="pic">🚫</span>Unblock${chev}</button>`
        : `<button type="button" class="pact" data-on="${following ? '1' : ''}" onclick="var b=this,on=b.dataset.on;fetch('/friends/'+(on?'unfollow':'follow'),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'fetch'},body:'id=${p.id}',credentials:'same-origin'});b.dataset.on=on?'':'1';b.querySelector('.pl').textContent=on?'Follow':'✓ Following';"><span class="pic">👥</span><span class="pl">${following ? '✓ Following' : 'Follow'}</span>${chev}</button>`
        + `<button type="button" class="pact danger" onclick="if(confirm('Block this member? You will not see or message each other.')){${post('/friends/block')};if(window.pvClose)pvClose();}"><span class="pic">🚫</span>Block user${chev}</button>`,
    ].join('');
  return `<div class="pchero"><div class="pcav pcav-xl">${avatarInner(p.email, p.full_name)}</div>
      <div class="pcnm pcnm-xl">${esc(p.full_name)}</div>${rb ? `<div class="pcbadge">${rb}</div>` : ''}${memberSince ? `<div class="pcsince">Member since ${esc(memberSince)}</div>` : ''}</div>
    <div class="pcstats"><div><b>${stats.total}</b><span>Games</span></div><div><b>${stats.season}</b><span>Season</span></div><div><b>${stats.streak}</b><span>Streak</span></div></div>
    ${actions}`;
}

export function profilePage({ p, stats, isSelf = false, canContact = false, canDM = true, rel = 'none', following = false, runDate = '', hours = '8:30–10:30 PM', dmUnread = 0, groupUnread = 0, groupMention = 0, chatProgram = 1, ann = null, back = '/chat', minor = false, showRoles = false }) {
  // Minor tag: EVERYONE sees it (awareness). Role badges: ADMIN viewers only.
  const badges = [
    minor ? MINOR_BADGE : '',
    showRoles && p.is_host ? '<span class="bdg host">★ Host</span>' : '',
    showRoles ? (p.is_team ? '<span class="bdg team">◆ Team</span>' : (p.is_regular ? '<span class="bdg core">★ Pillar</span>' : '')) : '',
    showRoles && !p.is_host && !p.is_team && !p.is_regular ? '<span class="bdg reg">Regular</span>' : '',
    isSelf ? '<span class="tag">YOU</span>' : '',
  ].join('');
  const hostcall = p.is_host
    ? `<div class="hostcall"><div class="ic">?</div><div class="tx"><b>Host of the run</b><span>Come to me with any questions about the night — I organize it.</span></div></div>`
    : '';
  const contact = canContact
    ? `<div class="contact"><div class="ck">Contact</div><div class="cv">${esc(p.full_name)}<br><a href="tel:${esc(p.phone)}">${esc(p.phone)}</a><br><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></div></div>`
    : '';
  const prowBtns = [];
  // Message any approved player in-app (player-to-player DMs). Host keeps its own wording.
  // Hidden across a block (either direction) — matches canMessage server-side (Phase 6).
  if (!isSelf && canDM && p.status === 'approved' && !/@guest\.local$/.test(p.email) && rel !== 'blocked' && rel !== 'blocked_by')
    prowBtns.push(`<a class="btn primary" href="/messages/${p.id}">Message${p.is_host ? ' the host' : ' ' + esc((p.full_name || '').split(' ')[0])}</a>`);
  if (canContact) prowBtns.push(`<a class="btn ghost" href="tel:${esc(p.phone)}">Call</a>`);
  if (canContact && !p.is_host) prowBtns.push(`<a class="btn ghost" href="sms:${esc(p.phone)}">Text</a>`);
  if (isSelf) prowBtns.push(`<a class="btn ghost" href="/profile">Edit profile</a>`);
  const prow = prowBtns.length ? `<div class="prow">${prowBtns.join('')}</div>` : '';
  // Follow / block controls (Phase 6, follow-only) — only for another approved, non-guest member
  // who hasn't blocked me. If I've blocked them → Unblock; otherwise → Follow + Block.
  let frControls = '';
  if (!isSelf && p.status === 'approved' && !/@guest\.local$/.test(p.email) && rel !== 'blocked_by') {
    const bform = (action, label) => `<form class="swapform frbtn" method="POST" action="/friends/${action}"><input type="hidden" name="id" value="${p.id}"><input type="hidden" name="back" value="/u/${p.id}"><button class="btn ghost sm" type="submit">${label}</button></form>`;
    frControls = rel === 'blocked'
      ? `<div class="fract" style="margin-top:12px;gap:8px">${bform('unblock', 'Unblock')}</div>`
      : `<div class="fract" style="margin-top:12px;gap:8px">${followBtn(p.id, following, '/u/' + p.id)}${bform('block', 'Block')}</div>`;
  }
  return HEAD('Profile — The Bridge', 'has-tabs') + header('', wdayShort(runDate), ann, hours) + WELCOME_MODAL + `
    <div class="rule"></div>
    <a class="pback" href="${esc(back)}">‹ Back</a>
    <div class="phead">
      <div class="pav">${avatarInner(p.email, p.full_name)}</div>
      <div class="pname"><b>${esc(p.full_name)}</b><div class="pbadges">${badges}</div></div>
    </div>
    ${hostcall}
    <div class="bigstat"><div class="wood"></div><div class="n">${stats.total}<em> games</em></div>
      <div class="k">${stats.first ? `Games attended · since ${esc(fmtMonthYear(stats.first))}` : 'Games attended · history starts now'}</div></div>
    <div class="tiles">
      <div class="tile"><b>${stats.season}</b><span>This season</span></div>
      <div class="tile"><b>${stats.streak}</b><span>Longest streak</span></div>
      <div class="tile"><b>${esc((p.position || '').split(',').filter(Boolean).join(' · ')) || '—'}</b><span>Position</span></div>
    </div>
    ${contact}
    ${prow}
    ${frControls}
  ` + footWithTabs(tabNav(isSelf ? 'profile' : '', { dm: dmUnread, group: groupUnread, groupMention, program: chatProgram }));
}

// Host DM inbox rows — reused on the host's profile tab (host DMs live in Profile
// now). Each row links to its thread; unread pip per thread. `me` = the host.
function inboxRows(me, threads) {
  return threads.map(t => {
    const name = t.person ? t.person.full_name : t.other;
    const id = t.person ? t.person.id : 0;
    const snippet = t.last
      ? (t.last.body ? (t.fromMe ? 'You: ' : '') + t.last.body
         : (isSticker(t.last.image) ? '💬 Sticker' : '📷 Photo'))
      : '';
    const inner = `<span class="mav">${avatarInner(t.other, name)}</span>
      <span class="mtx"><b class="mnm">${esc(name)}</b><span class="msnip">${esc(snippet)}</span></span>
      <span class="mmeta">${t.last ? `<span class="mtime">${esc(fmtWhen(t.last.created_at))}</span>` : ''}${t.unread > 0 ? `<span class="mdot">${t.unread > 9 ? '9+' : t.unread}</span>` : ''}</span>`;
    return id
      ? `<a class="mrow${t.unread ? ' unread' : ''}" href="/messages/${id}">${inner}</a>`
      : `<div class="mrow">${inner}</div>`;
  }).join('');
}

// ---------- PROFILE (own editable tab) ----------
export function profileTabPage({ a, stats, saved = false, error = '', dmUnread = 0, groupUnread = 0, groupMention = 0, chatProgram = 1, canOperate = false, announcementLog = [], iAmHost = false, threads = [], photoMsg = '', ann = null, friendCount = 0, friendReqIn = 0, followerCount = 0, minor = false, showRoles = false, passQr = '', passCode = '', positionGroups = [] }) {
  // Door check-in pass (Phase 2b, hybrid mode): the QR the church's Check-Ins station scans.
  // Rendered only when the server verified the code exists in PCO (passQr non-empty).
  const passCard = passQr ? `
    <div class="card rail" style="margin-top:12px">
      <div class="subhead" style="margin-top:0">Door check-in pass</div>
      <p class="tally-note" style="margin:4px 0 8px">Show this at the check-in station on run night — one scan and you're in. No typing, no forms.</p>
      <div style="max-width:200px;margin:0 auto">${passQr}</div>
      <p style="text-align:center;margin:6px 0 0;font-size:12px;letter-spacing:2px;color:var(--muted)">${esc(passCode)}</p>
    </div>` : '';
  // The own-profile tab is a chromeless editor (its own .bar, no masthead), so the
  // global announcements bell lives in the .bar rather than the .mast here. Same
  // button + panel + JS as every other page (one shared affordance, one live dot).
  const { btn: annBtn, sheet: annSheet } = annBell(ann);
  // Position chips come from each program's config.positions (F6) — server passes the groups.
  // Host/admin-only: move a given week's run to a different weekday. Compact,
  // collapsed-by-default <details> so it never breaks the profile's no-scroll fit.
  // Run-day + Cancel-run controls moved to the check-in page's Operator-tools card
  // (runDayControls) so each run manages itself — the profile no longer carries them.
  // Every player's DM inbox lives on their own profile tab (there is no Messages tab).
  // Player-to-player DMs: start one from any player's profile (Message button).
  const inbox = `<div id="dminbox">
       <div class="subhead" style="margin-top:16px">Messages${dmUnread > 0 ? ` <span class="mdot" style="display:inline-block;vertical-align:middle;margin-left:4px">${dmUnread > 9 ? '9+' : dmUnread}</span>` : ''}</div>
       ${threads.length
        ? `<div class="mlist">${inboxRows(a.email, threads)}</div>`
        : `<div class="mempty"><div class="mei">💬</div><b>No messages yet</b><p>Open a player's profile and tap Message to start a chat.</p></div>`}
       </div>`;
  // Operator-only: the announcement history (moved here off the check-in page).
  const annHistory = (canOperate && announcementLog.length)
    ? `<details class="announce-compose" style="margin-top:12px"><summary>Announcement history (${announcementLog.length})</summary>
        <ul class="annlog">
          ${announcementLog.map(x => `<li>
            <div class="annlog-b">${esc(x.body)}</div>
            <div class="annlog-m">
              <span class="annlog-state ${x.pending ? 'sched' : (x.archived ? 'past' : 'live')}">${x.pending ? 'Scheduled' : (x.archived ? 'Cleared' : 'Live')}</span>
              ${x.pending
                ? `Fires ${esc(String(x.publish_at || '').replace('T', ' '))}${x.author ? ' · ' + esc(x.author) : ''}
                   <form method="POST" action="/announce/cancel" class="swapform" style="display:inline;margin-left:6px"><input type="hidden" name="id" value="${Number(x.id)}"><button class="btn ghost sm" type="submit" style="padding:3px 10px">Cancel</button></form>`
                : `Posted ${esc(fmtWhen(x.at))}${x.author ? ' · ' + esc(x.author) : ''}${x.archived && x.archived_at ? ' · cleared ' + esc(fmtWhen(x.archived_at)) : ''}`}
            </div>
          </li>`).join('')}
        </ul>
      </details>`
    : '';
  const selected = new Set((a.position || '').split(',').map(s => s.trim()).filter(Boolean));
  const chipRow = (list) => list.map(([v, l]) =>
    `<label class="chip"><input type="checkbox" name="position" value="${esc(v)}" hidden${selected.has(v) ? ' checked' : ''}>${esc(v)}<small>${esc(l)}</small></label>`).join('');
  const positionSec = positionGroups.length
    ? `<div class="sec"><div class="lb"><b>Position</b><span>Tap to toggle</span></div>
        ${positionGroups.map(g => `<div class="poslab">${esc(g.label)}</div><div class="chips sm">${chipRow(g.chips)}</div>`).join('')}
      </div>`
    : '';
  const memberSince = fmtMonthYear(a.created_at);
  const hasAvatar = !!a.avatar;
  // Photo upload/remove outcome (redirect flag → friendly notice). Errors are the
  // route's reject codes (magic-byte/type/size/etc.); ok/removed are the success paths.
  const PHOTO_ERRS = {
    big: "That image is too large — pick one under 10 MB.",
    type: "That file isn't a photo. Choose a JPEG, PNG, or WEBP image.",
    bad: "Couldn't read that upload — please try again.",
    proc: "Couldn't process that image — try a different one.",
    none: "No photo was selected.",
    slow: "Too many photo changes — wait a minute and try again.",
  };
  const photoNotice = photoMsg === 'ok' ? '<div class="notice good">Photo updated ✓</div>'
    : photoMsg === 'removed' ? '<div class="notice good">Photo removed</div>'
    : photoMsg.startsWith('err:') ? `<div class="notice bad">${esc(PHOTO_ERRS[photoMsg.slice(4)] || 'Photo upload failed — try again.')}</div>`
    : '';
  return HEAD('Your profile — The Bridge', 'has-tabs') + WELCOME_MODAL + `
    <form id="photoform" method="POST" action="/profile/photo" enctype="multipart/form-data" style="display:none">
      <input id="photoinput" type="file" accept="image/*" name="photo" onchange="if(this.files&&this.files[0]){this.form.submit()}">
    </form>
    <form id="photoremove" method="POST" action="/profile/photo/remove" class="swapform" style="display:none"></form>
    <form method="POST" action="/profile" class="pedit">
      <div class="bar"><a class="bk" href="/checkin">‹ Back</a><span class="ti">Profile</span><span class="baracts">${annBtn}<button class="dn" type="submit">Save</button></span></div>
      ${saved ? '<div class="notice good">Saved ✓</div>' : ''}
      ${error ? `<div class="notice bad">${esc(error)}</div>` : ''}
      ${photoNotice}
      <div class="idrow">
        <label class="pic" for="photoinput" title="Change photo" aria-label="Change profile photo">${avatarInner(a.email, a.full_name)}<span class="cam">✎</span></label>
        <div class="idfield">
          <div class="idname">${esc(a.full_name)}${showRoles && a.is_host ? '<span class="hostpill">★ Host</span>' : ''}${minor ? ' ' + MINOR_BADGE : ''}</div>
          <div class="phactions">${hasAvatar ? '<button type="submit" form="photoremove" class="phbtn">Remove photo</button>' : '<span class="phsoon">Tap photo to change</span>'}</div>
        </div>
      </div>
      <details class="acct">
        <summary>Account info<span class="acct-hint">name · phone · email · DOB</span></summary>
        <div class="acct-body">
          <div class="field"><label>Name</label><input name="full_name" value="${esc(a.full_name)}" required autocomplete="name"></div>
          <div class="field"><label>Phone</label><input name="phone" value="${esc(a.phone)}" inputmode="tel" required autocomplete="tel"></div>
          <div class="field"><label>Email</label><input name="email" type="email" value="${esc(a.email)}" required autocomplete="email"></div>
          <div class="field"><label>Date of birth</label>
            ${a.dob
              ? `<p class="tally-note" style="margin:2px 0 0"><b>${esc(a.dob)}</b> · contact an organizer to change it.</p>`
              : `<input name="dob" type="date" autocomplete="bday">
            <p class="tally-note" style="margin:6px 0 0">Optional but recommended (a safeguarding requirement). Once set, only an organizer can change it.</p>`}
          </div>
        </div>
      </details>
      ${positionSec}
      <div class="sec"><div class="lb"><b>Email</b></div>
        <label class="lvl" style="display:block"><input type="checkbox" name="email_announce" value="1"${a.email_optout ? '' : ' checked'}> Email me announcements &amp; run-day changes</label>
        <p class="tally-note" style="margin:6px 0 0">Sign-in links and waitlist spot offers are always sent.</p>
      </div>
      <div class="statcard">
        <div class="g">${stats.total}<em> gp</em></div>
        <div class="d">Games attended · Member since ${esc(memberSince)}<br>${stats.season} this season · ${stats.streak}-run streak${a.is_host ? ' · ★ Host' : ''}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">
        <a class="btn ghost sm" href="${progMeta(chatProgram).season}">🏆 ${esc(progMeta(chatProgram).seasonLabel)}</a>
        ${progMeta(chatProgram).ladder ? `<a class="btn ghost sm" href="${progMeta(chatProgram).ladder}">📋 Ladder</a>` : ''}
      </div>
      ${(stats.dates && stats.dates.length) ? `<details style="margin-top:10px">
        <summary style="cursor:pointer;font-size:13px;color:var(--muted)">Run history · ${stats.dates.length}</summary>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:9px">${stats.dates.slice().reverse().map(d => `<span style="font-size:12px;padding:3px 9px;border:1px solid var(--line);border-radius:999px;color:var(--muted)">${esc(new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}</span>`).join('')}</div>
      </details>` : ''}
    </form>
    <div id="pushctl" class="card" style="margin-top:12px;padding:14px" hidden>
      <b style="font-size:14px">Game-day notifications</b>
      <p class="tally-note" id="pushnote" style="margin:6px 0 10px">Spot offers, announcements and mentions — right on your phone.</p>
      <button class="btn ghost sm" type="button" id="pushbtn">Enable notifications</button>
    </div>
    <a href="/friends" style="display:flex;align-items:center;gap:12px;margin-top:16px;padding:12px 13px;border:1px solid var(--line);border-radius:14px;background:var(--card);text-decoration:none;color:inherit">
      <span style="font-size:22px;line-height:1">👥</span>
      <span style="flex:1;min-width:0"><b style="display:block;font-family:var(--head);font-size:15px;color:var(--ink)">Friends</b><small style="color:var(--muted);font-size:12.5px">${friendCount ? esc(String(friendCount)) + ' friend' + (friendCount === 1 ? '' : 's') : 'Find & add players'}${followerCount ? ' · ' + followerCount + ' follower' + (followerCount === 1 ? '' : 's') : ''}${friendReqIn > 0 ? ' · ' + friendReqIn + ' request' + (friendReqIn === 1 ? '' : 's') : ''}</small></span>
      ${friendReqIn > 0 ? `<span class="mdot">${friendReqIn > 9 ? '9+' : friendReqIn}</span>` : ''}
      <span style="color:var(--muted);font-size:20px">›</span>
    </a>
    ${canOperate ? `<a href="/admin" style="display:flex;align-items:center;gap:12px;margin-top:10px;padding:12px 13px;border:1px solid var(--line);border-radius:14px;background:var(--card);text-decoration:none;color:inherit">
      <span style="font-size:22px;line-height:1">⚙️</span>
      <span style="flex:1;min-width:0"><b style="display:block;font-family:var(--head);font-size:15px;color:var(--ink)">Admin</b><small style="color:var(--muted);font-size:12.5px">Council review${showRoles ? ' · people & invites · exports' : ''}</small></span>
      <span style="color:var(--muted);font-size:20px">›</span>
    </a>` : ''}
    ${passCard}
    <div class="card rail" style="margin-top:12px">
      <b style="font-size:14px;font-family:var(--head)">Chat notifications</b>
      <p class="tally-note" style="margin:4px 0 10px">Announcements, spot offers, @mentions and DMs always ping you. Want a ping for <b>every</b> chat message too?</p>
      <form method="POST" action="/profile/chatpush" class="swapform" style="margin:0">
        <input type="hidden" name="on" value="${a.chat_push ? '0' : '1'}">
        <button class="arpill${a.chat_push ? ' on' : ''}" type="submit">💬 Every chat message${a.chat_push ? ' · ON' : ' · OFF'}</button>
      </form>
    </div>
    <div class="card rail" style="margin-top:12px">
      <b style="font-size:14px;font-family:var(--head)">App theme</b>
      <p class="tally-note" style="margin:4px 0 10px">Pick your look — it applies instantly, just on this device.</p>
      <div id="themerow" style="display:flex;gap:8px;flex-wrap:wrap">
        ${[['', 'Classic', '#F8F5EF', '#E4611F'], ['midnight', 'Slate', '#364765', '#E4611F']].map(([k, label, bgc, ac]) => `
        <button type="button" class="themeopt" data-theme="${k}" style="display:flex;align-items:center;gap:7px;border:1.5px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:8px 13px;font-size:12.5px;font-weight:700;font-family:var(--head);cursor:pointer">
          <span style="width:18px;height:18px;border-radius:50%;background:${bgc};border:1px solid rgba(0,0,0,.15);display:inline-block;position:relative;overflow:hidden"><span style="position:absolute;right:0;top:0;bottom:0;width:7px;background:${ac}"></span></span>${label}
        </button>`).join('')}
      </div>
      <script>
        (function(){ if(window.__themeBound) return; window.__themeBound=1;
          function mark(){ var cur=''; try{cur=localStorage.getItem('bridgeTheme')||'';}catch(e){}
            if(!/^(midnight)$/.test(cur))cur='';   // stale value from a removed theme = Classic
            document.querySelectorAll('.themeopt').forEach(function(b){
              var on=(b.getAttribute('data-theme')||'')===cur;
              b.style.borderColor=on?'var(--orange)':'var(--line)';
              b.style.boxShadow=on?'0 0 0 1.5px var(--orange)':'none'; }); }
          document.addEventListener('click',function(e){ var b=e.target&&e.target.closest&&e.target.closest('.themeopt'); if(!b) return;
            var k=b.getAttribute('data-theme')||'';
            try{ if(k)localStorage.setItem('bridgeTheme',k); else localStorage.removeItem('bridgeTheme'); }catch(e2){}
            document.documentElement.className=(document.documentElement.className.replace(/\\btheme-[a-z]+\\b/g,'').trim()+(k?' theme-'+k:'')).trim();
            var m=document.querySelector('meta[name=theme-color]');if(m)m.setAttribute('content',k==='midnight'?'#364765':'#F8F5EF');
            mark(); });
          mark();
        })();
      </script>
    </div>
    <form method="POST" action="/profile/logoutall" style="margin-top:12px" onsubmit="return confirm('Sign out on every device you\\'ve ever used? You\\'ll sign back in with your email.')">
      <button class="btn ghost sm" type="submit">Sign out everywhere</button>
      <p class="tally-note" style="margin:6px 0 0">Lost a phone, or somewhere you didn't sign out? This ends the session on <b>every</b> device at once.</p>
    </form>
    ${inbox}
    ${annHistory}
    ${annSheet}
    <div class="foot signout"><a href="/runs" onclick="try{localStorage.removeItem('bridgeTourV1');}catch(e){}">↻ Replay app tour${canOperate ? ' (incl. team controls)' : ''}</a> · <a href="/logout">Sign out</a></div>
    <script>
      (function(){
        // Surgical poll-and-patch (P0-1): patch the DM/group badges every tick; the
        // host also gets their DM inbox (#dminbox) patched in place when a new message
        // arrives. Players have no inbox → badges-only (onChange no-ops). Replaces the
        // old 20s full-page reload of the host inbox.
        window.__profileOnChange=function(){
          var box=document.getElementById('dminbox');
          if(!box||!window.fetch||!window.DOMParser)return; // players → badges only
          fetch('/profile',{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}})
            .then(function(r){return r.text();})
            .then(function(html){var doc=new DOMParser().parseFromString(html,'text/html');
              var nb=doc.getElementById('dminbox'); if(nb)box.innerHTML=nb.innerHTML;})
            .catch(function(){});
        };
        if(window.__poll)window.__poll('profile',window.__profileOnChange);

        // ---- Web Push opt-in. The #pushctl card shows only where push is possible;
        // on iOS push exists ONLY inside the installed (Home-Screen) PWA. State sync
        // runs every time this script executes (incl. after a router swap into
        // /profile); the click listener is bound once + delegated. ----
        var ctl=document.getElementById('pushctl');
        if(ctl){
          var supported=('serviceWorker' in navigator)&&('PushManager' in window)&&('Notification' in window);
          var standalone=(navigator.standalone===true)||(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches);
          var btn=document.getElementById('pushbtn'), note=document.getElementById('pushnote');
          function u8(b64){var pad='='.repeat((4-b64.length%4)%4);var s=(b64+pad).replace(/-/g,'+').replace(/_/g,'/');var raw=atob(s);var a=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)a[i]=raw.charCodeAt(i);return a;}
          function setState(on){ if(btn)btn.textContent=on?'Notifications are on — tap to turn off':'Enable notifications'; if(btn)btn.dataset.on=on?'1':''; }
          function sync(){
            if(!supported){ ctl.hidden=true; return; }
            ctl.hidden=false;
            if(!standalone){ if(btn)btn.disabled=true; if(note)note.textContent='Add this app to your Home Screen first (Share → Add to Home Screen), then enable here.'; return; }
            if(Notification.permission==='denied'){ if(btn)btn.disabled=true; if(note)note.textContent='Notifications are blocked — turn them on for this app in Settings.'; return; }
            if(btn)btn.disabled=false;
            navigator.serviceWorker.ready.then(function(reg){return reg.pushManager.getSubscription();})
              .then(function(sub){ setState(!!sub); }).catch(function(){});
          }
          if(!window.__pushBound){ window.__pushBound=1;
            document.addEventListener('click',function(e){
              var b=e.target&&e.target.closest&&e.target.closest('#pushbtn'); if(!b||b.disabled)return;
              e.preventDefault();
              if(b.dataset.on==='1' && !confirm("Turn off notifications? You won’t be pinged for waitlist spot offers, announcements, run-day changes or @mentions.")) return;
              b.disabled=true;
              navigator.serviceWorker.ready.then(function(reg){
                return reg.pushManager.getSubscription().then(function(sub){
                  if(sub){ var ep=sub.endpoint; return sub.unsubscribe().then(function(){
                    return fetch('/push/unsubscribe',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({endpoint:ep})});
                  }).then(function(){ setState(false); }); }
                  return window.__pushEnable().then(function(ok){ if(ok) setState(true); });
                });
              }).catch(function(){}).then(function(){ b.disabled=false; if(window.__pushSync)window.__pushSync(); });
            });
          }
          window.__pushSync=sync; sync();
        }
      })();
    </script>
  ` + footWithTabs(tabNav('profile', { dm: dmUnread, group: groupUnread, groupMention, program: chatProgram }));
}
