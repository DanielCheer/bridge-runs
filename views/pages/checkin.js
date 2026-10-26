// views/pages/checkin.js — basketball's run page (/checkin) with the host's run-day controls, and the
// waitlist offer's claim result.
import { esc, fmtWhen, wdayFull, wdayShort } from '../util.js';
import {
  IC_CLOSE, qrBlock, locationBlock, avatarInner, GROUP_ICON, MINOR_STAR, progMeta, tabNav, opsNav,
  backToRuns, firstRunTour, WELCOME_MODAL, GAME_FORMAT_CARD,
} from '../components.js';
import { HEAD, FOOT, header, footWithTabs } from '../shell.js';

// ---------- CHECK-IN ----------
// Server-rendered initial value for the tip-off countdown (client script ticks it).
function fmtCountdown(tipMs, now = Date.now()) {
  const diff = tipMs - now;
  if (diff <= 0) return "IT'S GAME TIME";
  const pad = n => String(n).padStart(2, '0');
  const d = Math.floor(diff / 86400000);
  const h = Math.floor(diff % 86400000 / 3600000);
  const m = Math.floor(diff % 3600000 / 60000);
  return `${d}D ${pad(h)}:${pad(m)}`;
}

const COURT_SVG = `<svg class="court" viewBox="0 0 200 200" fill="none" aria-hidden="true"><circle cx="100" cy="200" r="70" stroke-width="2"/><path d="M40 200v-70h120v70M100 130v-40" stroke-width="2"/><circle cx="100" cy="130" r="26" stroke-width="2"/></svg>`;

// Operator "Run day" + "Cancel this week" controls (HOST/ADMIN only) — an Operator-tools card
// on the check-in page (moved off the profile). `runDay` carries the current run + defaults.
function runDayControls({ runDay, rdMsg = '' }) {
  if (!runDay) return '';
  const ti = 'font-size:16px;min-height:44px;padding:11px 13px;width:100%;box-sizing:border-box;max-width:100%;min-width:0';
  const rdBanner = (rdMsg === 'set' || rdMsg === '1') ? '<div class="notice good">Run day updated ✓</div>'
    : rdMsg === 'season' ? '<div class="notice good">Season start set ✓</div>'
    : rdMsg === 'seasonoff' ? '<div class="notice good">Season cleared — runs resume every week ✓</div>'
    : rdMsg === 'past' ? '<div class="notice bad">Pick a date that isn\'t in the past.</div>'
    : rdMsg === 'range' ? '<div class="notice bad">Pick a date within the next 30 days.</div>'
    : rdMsg === 'time' ? '<div class="notice bad">Check the times — end must be after start.</div>'
    : rdMsg === 'bad' ? '<div class="notice bad">That date didn\'t look right — try again.</div>'
    : rdMsg === 'seasonpast' ? '<div class="notice bad">Pick a season start that isn\'t in the past.</div>'
    : rdMsg === 'seasonrange' ? '<div class="notice bad">Pick a season start within the next year.</div>'
    : rdMsg === 'seasonbad' ? '<div class="notice bad">That season date didn\'t look right — try again.</div>'
    : rdMsg === 'preseason' ? '<div class="notice bad">The season hasn\'t started yet — set the opener with the Season control below.</div>'
    : '';

  // "Next run" line — pre-season it's the season opener (not editable via the 30-day picker).
  const nextLine = runDay.preseason
    ? `<p class="tally-note" style="margin:8px 0 10px">Next run: <b>${esc(runDay.weekday)}, ${esc(runDay.label)}, ${esc(runDay.timeLabel)}</b> — season opener.</p>`
    : `<p class="tally-note" style="margin:8px 0 10px">Next run: <b>${esc(runDay.weekday)}, ${esc(runDay.label)}, ${esc(runDay.timeLabel)}</b>${runDay.dateMoved ? ` — moved from the usual day (${esc(runDay.defaultLabel)}).` : (runDay.isOverride ? ' — usual day, custom time.' : ' (usual day & time).')} Change it — players get an announcement.</p>`;

  // Weekly run-day + cancel controls — only meaningful once the season is underway. Pre-season
  // the upcoming run is weeks out (beyond the 30-day picker), so hide them and show a note.
  const weekSection = runDay.preseason
    ? `<p class="tally-note" style="color:var(--muted);margin:8px 0 0">Weekly run-day &amp; cancel controls appear once the season starts (${esc(runDay.seasonWeekday)}, ${esc(runDay.seasonLabel)}).</p>`
    : `<form method="POST" action="/admin/rundate" class="swapform" style="margin:0">
      <div class="field"><label>Run date</label><input type="date" name="date" value="${esc(runDay.runDate)}" min="${esc(runDay.today)}" max="${esc(runDay.maxDate)}" required style="${ti}"></div>
      <div style="display:flex;gap:10px;margin-top:8px">
        <div class="field" style="flex:1;margin:0"><label>Start</label><input type="time" name="start" value="${esc(runDay.start)}" required style="${ti}"></div>
        <div class="field" style="flex:1;margin:0"><label>End</label><input type="time" name="end" value="${esc(runDay.end)}" required style="${ti}"></div>
      </div>
      <label class="lvl" style="margin:10px 0 8px;display:block"><input type="checkbox" name="email_everyone" checked> Also email everyone</label>
      <button class="btn sm" type="submit">Set run day &amp; time</button>
    </form>
    ${runDay.isOverride ? `<form method="POST" action="/admin/rundate" class="swapform" style="margin-top:8px"><input type="hidden" name="date" value="${esc(runDay.defaultDate)}"><input type="hidden" name="email_everyone" value="1"><button class="btn ghost sm" type="submit">Reset to the usual day &amp; time (${esc(runDay.defaultLabel)})</button></form>` : ''}
    <div class="rule" style="margin:14px 0 12px"></div>
    ${runDay.cancelled
      ? `<div class="notice bad" style="margin:0 0 10px"><b>🚫 This run is cancelled.</b> Players were notified. Restore it to run check-in again.</div><form method="POST" action="/admin/run/cancel" class="swapform" style="margin:0"><input type="hidden" name="on" value="0"><button class="btn ghost sm" type="submit">Restore this run</button></form>`
      : `<p class="tally-note" style="margin:0 0 8px">Something come up? Cancel this week's run — players get a "run cancelled" notification and check-in is blocked. (Only this week.)</p><form method="POST" action="/admin/run/cancel" class="swapform" style="margin:0" onsubmit="return confirm('Cancel this week\\'s run? Everyone will be notified it\\'s off.');"><input type="hidden" name="on" value="1"><button class="btn leave sm" type="submit">🚫 Cancel this week's run</button></form>`}`;

  // Season-start gate control — pause the weekly schedule until the season opens (or clear it).
  const seasonSection = `<div class="rule" style="margin:14px 0 12px"></div>
    <div class="clab" style="margin-bottom:2px">Season</div>
    <p class="tally-note" style="margin:6px 0 10px">${runDay.season
      ? `Season starts <b>${esc(runDay.seasonWeekday)}, ${esc(runDay.seasonLabel)}</b> — no runs and no auto check-in until ~2 days before.`
      : `Runs every week. Set a season start to pause the schedule until the season opens.`}</p>
    <form method="POST" action="/admin/season" class="swapform" style="margin:0">
      <div class="field"><label>Season start</label><input type="date" name="season" value="${esc(runDay.season)}" min="${esc(runDay.today)}" max="${esc(runDay.seasonMax)}" style="${ti}"></div>
      <button class="btn sm" type="submit" style="margin-top:8px">Set season start</button>
    </form>
    ${runDay.season ? `<form method="POST" action="/admin/season" class="swapform" style="margin-top:8px" onsubmit="return confirm('Clear the season start? Runs resume every week right away.');"><input type="hidden" name="season" value=""><button class="btn ghost sm" type="submit">Clear — run every week</button></form>` : ''}`;

  return `<div class="infosec" data-tour="rundate" style="margin-top:20px"><div class="card"><div class="clab">Operator tools</div>
    ${rdBanner}
    ${nextLine}
    ${weekSection}
    ${seasonSection}
  </div></div>`;
}

export function checkinPage({ email, status, runLabel, runDate, hours = '8:30–10:30 PM', startLabel = '8:30 PM', tipoff = 0, openDay = 'Monday', openTime = '5 PM', cap, waitlistCap, going, waiting, full, runFull, isOpen, canSeeCount, regularSlotsFull,
                             myState, myWaitPos, myOffer = null, offerWindowHours = 3, iAmTeam, iAmCouncil = false, iAmRegular, iOptedOut, iAutoRenew,
                             viewerIsAdmin, canOperate, canSeeRoster, kioskUrl = '', suspended = false, suspendReason = '', myConfirmed = false, confirmBy = '', msg = '', bannerVer = '4', cancelled = false, locked = false, announcement = null, announcementLog = [], inPlayers, offeredPlayers = [], waitPlayers, host = null, runDay = null, rdMsg = '', dmUnread = 0, groupUnread = 0, groupMention = 0, ann = null }) {

  // Not cleared to play yet (admins always get through — they run the check-in)
  if (!viewerIsAdmin && status !== 'approved') {
    const pill = status === 'rejected' ? '<span class="pill rejected">Not this season</span>'
      : status === 'pending' ? '<span class="pill pending">Under review</span>'
      : '<span class="pill pending">Not on the list</span>';
    return HEAD('Check-in — The Bridge') + header() + `
      <div class="rule"></div>
      <h1>Not cleared yet</h1>
      <p class="lead">You're signed in as <b>${esc(email)}</b>. ${pill}</p>
      ${status === 'pending'
        ? '<div class="notice">Your application is in with the organizers. You\'ll be cleared to come try out at an open run — check-in unlocks once you\'re approved.</div>'
        : status === 'rejected'
        ? '<div class="notice">You\'re not on the Adv list this season. The open Monday run is always available.</div>'
        : '<div class="notice">We don\'t have an application on file for this email. Apply first, then check in.</div>'}
      ${status !== 'pending' ? '<a class="btn" href="/">Go to application</a>' : ''}
      <div style="height:10px"></div>
      <a class="btn ghost" href="/logout">Sign out</a>
    ` + FOOT;
  }

  // ----- my own action button (nine branches, unchanged POSTs) -----
  const canPlay = status === 'approved';
  let action;
  if (cancelled) {
    // Run cancelled → no check-in for anyone; the banner below explains (server blocks the POST too).
    action = `<button class="btn" type="button" disabled>Run cancelled</button>`;
  } else if (suspended) {
    // Suspended → no join CTA at all; a notice below explains why (server also blocks the POST).
    action = `<button class="btn" type="button" disabled>Check-in paused</button>`;
  } else if (!canPlay) {
    action = '';
  } else if (myState === 'offered' && myOffer) {
    // A floor spot is being HELD for them — the one action is to claim it.
    action = `<a class="btn primary" href="/checkin/claim/${esc(myOffer.token)}">Claim my spot</a>`;
  } else if (iAmTeam && iAutoRenew && iOptedOut && myState === 'out' && !locked) {
    action = `<form method="POST" action="/checkin/optin"><button class="btn primary" type="submit">I'm in</button></form>`;
  } else if (iAmTeam && iAutoRenew && (myState === 'in' || (!isOpen && !iOptedOut))) {
    // team auto-joins on open; give them a self-clear
    action = `<form method="POST" action="/checkin/optout"><button class="btn ghost" type="submit">Sit out</button></form>`;
  } else if (myState === 'in') {
    action = `<form method="POST" action="/checkin/leave"><button class="btn ghost" type="submit">Sit out</button></form>`;
  } else if (myState === 'waitlist') {
    action = `<form method="POST" action="/checkin/leave"><button class="btn ghost" type="submit">Leave waitlist (#${myWaitPos} of ${waiting})</button></form>`;
  } else if (locked) {
    // Locked at 2 PM — roster is set. Players already in can still Sit out (handled above,
    // which frees the spot to the waitlist). No new self-sign-ups; a host can add a +1.
    action = `<button class="btn" type="button" disabled>Check-in locked</button>`;
  } else if (!isOpen && iAmRegular && regularSlotsFull) {
    action = `<button class="btn" type="button" disabled>Early spots full — opens to all soon</button>`;
  } else if (!isOpen && iAmRegular) {
    // regulars can join while closed — shown as a normal join, no role wording
    action = `<form method="POST" action="/checkin/join"><button class="btn primary" type="submit">I'm in</button></form>`;
  } else if (!isOpen && iAmTeam) {
    // team keep pre-access even with auto-renew off — manual join while closed
    action = `<form method="POST" action="/checkin/join"><button class="btn primary" type="submit">I'm in</button></form>`;
  } else if (!isOpen) {
    action = `<button class="btn" type="button" disabled>Check-in closed</button>`;
  } else if (runFull) {
    action = `<button class="btn" type="button" disabled>Run &amp; waitlist full</button>`;
  } else if (full) {
    action = `<form method="POST" action="/checkin/join"><button class="btn primary" type="submit">Join waitlist (${waiting}/${waitlistCap})</button></form>`;
  } else {
    action = `<form method="POST" action="/checkin/join"><button class="btn primary" type="submit">I'm in</button></form>`;
  }

  // Run-day confirm/release: a floor player either confirms they're coming or frees the
  // spot via the normal Sit-out. Independent of `action` so it rides alongside it.
  // confirmBy === '' means the confirm step is OFF for this program (no cutoff configured, or
  // door check-in mode is on — the physical station tap is the confirmation) → render nothing.
  const confirmCta = (myState === 'in' && !suspended && confirmBy)
    ? (myConfirmed
        ? `<div class="notice good" style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span style="flex:1;min-width:180px">✓ Confirmed. Can't make it? Sit out to free your spot.</span><form method="POST" action="/checkin/confirm" class="swapform" style="margin:0"><input type="hidden" name="un" value="1"><button class="btn ghost sm" type="submit" style="width:auto">Undo ✕</button></form></div>`
        : `<form method="POST" action="/checkin/confirm" class="swapform" style="margin-top:10px"><button class="btn primary" type="submit">✓ I'm coming</button>${confirmBy ? `<p class="tally-note" style="margin:6px 0 0">Confirm by <b>${esc(confirmBy)}</b> — unconfirmed spots go to the waitlist.</p>` : ''}</form>`)
    : '';
  // (The run-day confirm/release ping is now automatic at the 2 PM lock — no host button.)

  // ----- my own state line -----
  // Claim banner (offered players): a spot opened and is HELD for them — prominent
  // call to claim, with the time remaining. Auto-refresh keeps the countdown fresh.
  let claimLeft = '';
  if (myState === 'offered' && myOffer) {
    const rem = Math.max(0, myOffer.expiresAt - Date.now());
    const h = Math.floor(rem / 3600000), m = Math.floor(rem % 3600000 / 60000);
    claimLeft = rem > 0 ? `${h}h ${m}m left` : 'expiring now';
  }
  let mine = '';
  if (myState === 'offered' && myOffer) {
    mine = `<div class="notice claim"><b>🎉 A spot opened — it's yours to claim!</b><br>
      Tap <b>Claim my spot</b> below — <b class="claimleft" data-exp="${myOffer.expiresAt}">${claimLeft}</b> before it passes to the next person on the waitlist.</div>`;
  } else if (iAmTeam && iAutoRenew && iOptedOut) {
    mine = '';
  } else if (iAmTeam && iAutoRenew && !isOpen) {
    mine = '';  // "You're on the floor ✓" removed per owner — redundant with the Sit-out button
  } else if (iAmRegular && !isOpen && regularSlotsFull) {
    mine = `<div class="notice warn">Early spots are full for this week. You'll be able to join when check-in opens to everyone.</div>`;
  } else if (iAmRegular && !isOpen && myState === 'out') {
    mine = '';  // regulars just get the join button — no role wording
  } else if (!isOpen && myState === 'out') {
    mine = `<div class="notice warn">Registration opens <b>${openDay} at ${openTime}</b> for approved players — spots are capped at ${cap}, so get in early once it's live. It opens automatically and you'll get a notification.</div>`;
  } else if (myState === 'in') {
    mine = '';  // "You're on the floor for Friday ✓" removed per owner — redundant with the Sit-out button
  } else if (myState === 'waitlist') {
    mine = `<div class="notice warn">You're <b>#${myWaitPos} of ${waiting}</b> on the waitlist. If a spot opens you'll be emailed and have ${offerWindowHours} hour${offerWindowHours === 1 ? '' : 's'} to claim it before it passes to the next person.</div>`;
  } else if (full) {
    mine = `<div class="notice warn">Run's full at ${cap}. Join the waitlist and you'll move in if a spot opens.</div>`;
  }

  // ----- team auto-renew: compact ON/OFF pill for the hero footer (team only) -----
  // One tap POSTs /checkin/autorenew, flipping the guaranteed-weekly-spot flag.
  const autoRenewPill = iAmTeam
    ? `<form method="POST" action="/checkin/autorenew" class="arform" style="margin:0">
        <input type="hidden" name="on" value="${iAutoRenew ? '0' : '1'}">
        <button class="arpill${iAutoRenew ? ' on' : ''}" type="submit" role="switch" aria-checked="${iAutoRenew ? 'true' : 'false'}" title="Toggle your guaranteed weekly spot">
          <span class="arlab">Auto-renew</span><span class="arsep">·</span><span class="arstate">${iAutoRenew ? 'ON' : 'OFF'}</span>
        </button>
      </form>`
    : '';

  // ----- Operator run toggle (open/close) — rendered in the controls row -----
  const runToggle = canOperate
    ? (cancelled
        // Run cancelled → can't open it (un-cancel from Profile → Run day first).
        ? `<button class="btn" type="button" disabled>Open check-in</button>`
        : locked
        // Locked at 2 PM → roster is set; add players via +1 (opening wouldn't unlock joins).
        ? `<button class="btn" type="button" disabled>Locked · 2 PM</button>`
        : isOpen
        ? `<form method="POST" action="/checkin/close" style="margin:0"><button class="btn leave" type="submit" data-tour="ops-run">Close check-in</button></form>`
        : `<form method="POST" action="/checkin/open" style="margin:0"><button class="btn primary" type="submit" data-tour="ops-run">Open check-in</button></form>`)
    : '';

  // ----- announcement compose (operators only; folded into the teal hero) -----
  const annCompose = canOperate
    ? `<details class="announce-compose"><summary>Send announcement</summary>
        <form method="POST" action="/announce" class="swapform" style="margin-top:10px" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s){return false;}b.dataset.s=1;b.disabled=true;b.textContent='Posting…';">
          <textarea name="body" required maxlength="500" placeholder="e.g. No run this week — gym's booked. Back next week."></textarea>
          <div style="height:8px"></div>
          <label style="margin:0 0 8px">Schedule (optional) <span style="text-transform:none;font-weight:400;color:var(--muted)">— leave empty to post now</span><input type="datetime-local" name="publish_at"></label><label class="lvl" style="margin:0 0 8px"><input type="checkbox" name="email_everyone"> Also email everyone</label>
          <button class="btn sm" type="submit">Post to all players</button>
        </form>
      </details>`
    : '';
  // Announcement history moved to the admin's /profile page (see profileTabPage).

  // ----- announcement banner (P1-1 restore) — the latest LIVE announcement, shown
  //       in-app to ALL players. Operators post + email; this is the missing in-app
  //       surface. Dismissible per-announcement-id via localStorage (a NEW post has a
  //       new id, so it shows again); its id rides the /poll checkin fingerprint so a
  //       fresh announcement appears live without a manual reload. -----
  const annBanner = announcement
    ? `<div class="annbanner" id="annbanner" data-annid="${announcement.id}">
        <span class="annbanner-i" aria-hidden="true">📣</span>
        <div class="annbanner-b">
          <div class="annbanner-t">${esc(announcement.body)}</div>
          <div class="annbanner-m">${announcement.authorName ? esc(announcement.authorName) + ' · ' : ''}${esc(fmtWhen(announcement.at))}</div>
        </div>
        <button class="annbanner-x" type="button" aria-label="Dismiss" onclick="(function(){try{localStorage.setItem('annDismissed','${Number(announcement.id)}');}catch(e){}var b=document.getElementById('annbanner');if(b)b.parentNode.removeChild(b);})()">${IC_CLOSE}</button>
      </div>
      <script>(function(){try{if(localStorage.getItem('annDismissed')==='${Number(announcement.id)}'){var b=document.getElementById('annbanner');if(b)b.parentNode.removeChild(b);}}catch(e){}})();</script>`
    : '';

  // ----- info section: meet-your-host + game format (approved players only) -----
  const hostCard = host
    ? `<div class="card">
        <div class="clab">Meet your host</div>
        <div class="host">
          <span class="hav">${avatarInner(host.email, host.full_name)}</span>
          <div class="who"><b>${esc(host.full_name)}</b><span class="bdg host">★ Host</span></div>
        </div>
        <p class="hcopy">Hey — welcome to the Advanced basketball runs at The Bridge. I first came here through the rec runs, and that's what led me to start exploring my faith. I started this run to build a community of Christ-like people who bond over basketball — and to open that same door for others. Questions? Reach out below anytime.</p>
        <a class="btn primary" href="/messages/${host.id}">Message the host</a>
      </div>`
    : '';
  // The Run Chat is its own tab now (reached via the hero "Group chat" button
  // beside the Run pill, or the Chat tab), so no standalone card here.
  const infoSection = canPlay
    ? `<div class="infosec">${hostCard}${GAME_FORMAT_CARD}</div>`
    : '';

  // ----- scoreboard hero -----
  const scoreInner = `
    <div class="count">
      <span class="n">${canSeeCount ? going : '—'}</span>
      <span class="of">/${cap}</span>
      ${!canSeeCount ? '<span class="cl"><small>count shows when check-in opens</small></span>' : ''}
    </div>
    ${canSeeRoster ? '<div class="seeall"><div class="chev">›</div><span>Who\'s going</span></div>' : ''}`;
  const scoreBlock = canSeeRoster
    ? `<div class="score" role="button" tabindex="0" onclick="wgOpen()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();wgOpen()}">${scoreInner}</div>`
    : `<div class="score">${scoreInner}</div>`;
  // ----- hero "Group chat" button (beside the Run pill; links to the Chat tab
  //       where the Run Chat lives). Small unread dot when group unread > 0. -----
  const chatBtn = canPlay
    ? `<a class="hchat" href="/chat" data-chat-program="1" aria-label="Group chat${groupUnread > 0 ? `, ${groupUnread} unread` : ''}">
        <span class="hci">${GROUP_ICON}</span>Group chat${groupUnread > 0 ? '<span class="hdot" aria-hidden="true"></span>' : ''}
      </a>`
    : '';
  // ----- hero footer: Send announcement (operators, LEFT) + Auto-renew (team, RIGHT) -----
  // Kiosk link parity with the generic run pages (owner ask 2026-08-05: "no kiosk screen for
  // basketball?") — same controls, basketball's own mint route. Never static, so canOperate is
  // the whole gate.
  // Basketball is program 1, so it reads its own paths out of the SAME server registry the
  // generic run page uses rather than hardcoding them here — the registry already knows which
  // programs have teams and which log games. Until 2026-09-14 nothing read either path, so the
  // teams board (the courtside surface the games feature was built for) could only be reached by
  // typing /checkin/teams. The teams board is operator-only, so its link lives in this
  // operator-gated row; standings are readable by any member, so they get their own row below.
  const teamsPath = progMeta(1).teams;
  const boardPath = progMeta(1).leaderboard;
  const kioskRow = canOperate
    ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
        ${teamsPath ? `<a class="btn ghost sm" style="margin:0" href="${esc(teamsPath)}">🏀 Teams board</a>` : ''}
        ${kioskUrl ? `<a class="btn ghost sm" style="margin:0" target="_blank" rel="noopener" href="${esc(kioskUrl)}">📺 Kiosk screen</a>` : ''}
        <form method="POST" action="/checkin/kiosk-rotate" class="swapform" style="margin:0"${kioskUrl ? ` onsubmit="return confirm('Refresh this run&#39;s kiosk link? Screens on the old link stop working.')"` : ''}><button class="btn ghost sm" type="submit">${kioskUrl ? '↻ Refresh kiosk link' : '📺 Create kiosk link'}</button></form>
      </div>`
    : '';
  // Standings are a MEMBER surface (runLeaderboard admits anyone who has joined the run), so this
  // row sits deliberately OUTSIDE the canOperate gate above.
  const boardRow = boardPath
    ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
        <a class="btn ghost sm" style="margin:0" href="${esc(boardPath)}">🏆 Standings</a>
      </div>`
    : '';
  const heroFooter = (annCompose || autoRenewPill || kioskRow || boardRow)
    ? `<div class="hann"><div class="hann-l">${annCompose}${kioskRow}${boardRow}</div>${autoRenewPill ? `<div class="hann-r">${autoRenewPill}</div>` : ''}</div>`
    : '';
  // ----- operator "Add a guest" — sits on the RIGHT of the hbar (Checked in /
  //       Waitlist) row; expands the last-minute guest-add form (POST /checkin/guest,
  //       unchanged). Only rendered for operators. -----
  const addGuest = canOperate
    ? `<details class="hguest">
        <summary>+ Guest</summary>
        <form method="POST" action="/checkin/guest" onsubmit="var b=this.querySelector('button');if(b.dataset.s){return false;}b.dataset.s=1;b.disabled=true;b.textContent='Adding…';">
          <input name="name" required maxlength="60" placeholder="Guest name — last-minute add">
          <div style="height:8px"></div>
          <button class="btn sm" type="submit">Add guest to the run</button>
        </form>
      </details>`
    : '';
  const hero = `
    <div class="hero">
      <div class="wood"></div>
      ${COURT_SVG}
      <div class="htop">
        <span class="spill${(cancelled || locked || !isOpen) ? ' closed' : ''}">● Run ${cancelled ? 'Cancelled' : locked ? 'Locked' : (isOpen ? 'Open' : 'Closed')}</span>
        ${chatBtn}
      </div>
      ${scoreBlock}
      ${canSeeCount ? `<div class="hbar"><div>${going}<span>Checked in</span></div><div>${waiting}<span>Waitlist</span></div>${addGuest}</div>` : ''}
      <div class="hsub"><span class="hdate">${cancelled ? 'cancelled' : locked ? 'roster locked' : isOpen ? 'registration live' : (iAmRegular || iAmTeam ? '' : `queue opens ${openDay.slice(0, 3).toLowerCase()}`)}</span></div>
      ${heroFooter}
    </div>`;

  // ----- "Who's going" overlay (opens on top of the page; no navigation) -----
  // Read-only for players; for operators (canOperate) each row gains its floor-
  // management control — Remove on floor rows, Bump-in + Remove on waitlist rows
  // (same POST targets as the old Roster tab). These POST normally (302 → /checkin);
  // the check-in fetch-swap interceptor only catches `.controls form`, not these.
  const wgRemoveForm = (p) => `<form method="POST" action="/checkin/remove" style="margin:0"><input type="hidden" name="email" value="${esc(p.email)}"><button class="btn leave sm" type="submit" title="Remove">Remove</button></form>`;
  const wgBumpForm = (p) => `<form method="POST" action="/checkin/promote" style="margin:0"><input type="hidden" name="email" value="${esc(p.email)}"><button class="btn sm" type="submit" title="Move into the run">Bump in</button></form>`;
  // Tapping a real player's avatar/name opens their profile; guests (no account) aren't linked.
  const wgNameLink = (p, inner) => (p.applicant_id && !/@guest\.local$/.test(p.email)) ? `<a class="lrlink" href="/u/${p.applicant_id}" onclick="if(window.pvOpen){pvOpen(${p.applicant_id});return false;}">${inner}</a>` : inner;
  const wgRow = (p, n) => `<div class="lr"><span class="ln">${n}</span>${wgNameLink(p, `<span class="lav">${avatarInner(p.email, p.name)}</span><span class="lnm">${esc(p.name)}${p.minor ? MINOR_STAR : ''}${p.email === email ? ' <span class="tag">You</span>' : ''}${p.confirmed_at ? ' <span class="tag reg" title="Confirmed">✓</span>' : ''}</span>`)}${canOperate ? wgRemoveForm(p) : ''}</div>`;
  // Held offer row — the spot is taken (counts toward the floor) but the person hasn't
  // confirmed yet, so it's shown as "claiming" rather than as a settled floor player.
  const wgOfferRow = (p) => `<div class="lr"><span class="ln">·</span>${wgNameLink(p, `<span class="lav wl">${avatarInner(p.email, p.name)}</span><span class="lnm">${esc(p.name)}${p.minor ? MINOR_STAR : ''}${p.email === email ? ' <span class="tag">You</span>' : ''} <span class="tag">⏳ Claiming</span></span>`)}${canOperate ? wgRemoveForm(p) : ''}</div>`;
  const wgWaitRow = (p, i) => `<div class="lr"><span class="ln">W${i}</span>${wgNameLink(p, `<span class="lav wl">${avatarInner(p.email, p.name)}</span><span class="lnm">${esc(p.name)}${p.minor ? MINOR_STAR : ''}</span>`)}${canOperate ? wgBumpForm(p) + wgRemoveForm(p) : ''}</div>`;
  const wgSheet = canSeeRoster ? `
    <div id="wgwrap" class="wgwrap">
      <div class="wgscrim" onclick="wgClose()"></div>
      <div class="wgsheet" role="dialog" aria-modal="true" aria-label="Who's going">
        <div class="wgsheet-h"><b>On the floor · ${going} / ${cap}</b><button class="wgx" type="button" onclick="wgClose()" aria-label="Close">${IC_CLOSE}</button></div>
        <div class="wgsheet-b">
          ${inPlayers.length ? inPlayers.map((p, i) => wgRow(p, i + 1)).join('') : '<div class="subh">Nobody yet — be the first in.</div>'}
          ${offeredPlayers.length ? `<div class="subh">Holding a spot · offer sent</div>${offeredPlayers.map((p) => wgOfferRow(p)).join('')}` : ''}
          ${waitPlayers.length ? `<div class="subh">Waitlist · ${waiting}</div>${waitPlayers.map((p, i) => wgWaitRow(p, i + 1)).join('')}` : ''}
        </div>
      </div>
    </div>` : '';

  return HEAD(`${wdayFull(runDate)} Check-in — The Bridge`, 'has-tabs') + header(`<b>CHECK-IN</b>${esc(email)}`, wdayShort(runDate), ann, hours) + WELCOME_MODAL + `
    ${backToRuns}
    ${opsNav('checkin', { isAdmin: viewerIsAdmin, isTeam: iAmTeam, isCouncil: iAmCouncil })}
    ${canOperate ? `<div id="tgnudge" class="notice" style="margin-top:10px;display:flex;align-items:center;gap:10px;justify-content:space-between">
      <span>🏀 <b>You’re on the team</b> — you’ve got extra controls.</span>
      <span style="display:flex;gap:8px;align-items:center;flex-shrink:0">
        <button type="button" class="btn sm" onclick="try{localStorage.setItem('tgSeen1','1');localStorage.removeItem('bridgeTourV1');}catch(e){}location.href='/runs';">Take the tour</button>
        <button type="button" aria-label="Dismiss" onclick="try{localStorage.setItem('tgSeen1','1');}catch(e){}var n=document.getElementById('tgnudge');if(n)n.style.display='none';" style="border:0;background:none;font-size:20px;line-height:1;color:var(--muted);cursor:pointer;padding:0 4px">&times;</button>
      </span>
    </div>
    <script>(function(){try{if(localStorage.getItem('tgSeen1')){var n=document.getElementById('tgnudge');if(n)n.style.display='none';}}catch(e){}})();</script>` : ''}
    <div class="rule"></div>
    <div id="notifprompt" class="notifprompt" hidden>
      <div class="np-b"><b>🔔 Turn on notifications</b><span>Spot offers, run updates &amp; @mentions — right on your phone.</span></div>
      <div class="np-a"><button type="button" class="btn sm" id="np-enable">Enable</button><button type="button" class="np-x" id="np-dismiss" aria-label="Not now">${IC_CLOSE}</button></div>
    </div>
    <script>
      (function(){
        // First-run push nudge. Buttons are wired ONCE (harmless while hidden); the
        // REVEAL is gated: only inside the installed app (iOS can't subscribe from a
        // browser tab), only when supported, not blocked, not already on, not dismissed.
        var el=document.getElementById('notifprompt'); if(!el)return;
        if(!window.__notifPromptBound){ window.__notifPromptBound=1;
          document.addEventListener('click',function(e){
            var p=document.getElementById('notifprompt');
            if(e.target&&e.target.closest&&e.target.closest('#np-dismiss')){ if(p)p.hidden=true; try{localStorage.setItem('notifPromptDone','1');}catch(x){} return; }
            var en=e.target&&e.target.closest&&e.target.closest('#np-enable'); if(!en)return;
            en.disabled=true;
            window.__pushEnable().then(function(ok){ if(ok){ if(p)p.hidden=true; try{localStorage.setItem('notifPromptDone','1');}catch(x){} } else { en.disabled=false; } });
          });
        }
        if(!window.__pushEligible||!window.__pushEligible())return;
        if(Notification.permission==='denied')return;
        try{if(localStorage.getItem('notifPromptDone')==='1')return;}catch(e){}
        navigator.serviceWorker.ready.then(function(reg){return reg.pushManager.getSubscription();})
          .then(function(sub){ if(!sub) el.hidden=false; }).catch(function(){});
      })();
    </script>
    <div class="gymbanner">
      <img src="/gym.jpg?v=${esc(String(bannerVer))}" alt="The Bridge gym" width="1160" height="580" fetchpriority="high">
      <div class="gymcap">
        ${cancelled
          // Cancelled → don't advertise a next run or a tip-off countdown (contradictory).
          ? `<div class="l">This week<b>🚫 Run cancelled</b></div>`
          : `<div class="l">Next run<b>${wdayFull(runDate)} · ${esc(runLabel)} · ${esc(startLabel)}</b></div>
        <div class="r"><span>Tip-off in</span><b class="tick" data-tip="${tipoff}">${esc(fmtCountdown(tipoff))}</b></div>`}
      </div>
      ${canOperate ? `<a class="bannedit" href="/admin/banner" aria-label="Change banner photo">🖼 Change</a>` : ''}
    </div>
    ${hero}
    ${annBanner}
    ${cancelled ? `<div class="notice bad" style="margin-top:12px"><b>🚫 This week's run is cancelled.</b> No run ${esc(wdayFull(runDate))}, ${esc(runLabel)} — check-in is off. Watch for an announcement about the next one.</div>` : ''}
    ${msg ? `<div class="notice good" style="margin-top:12px">${esc(msg)}</div>` : ''}
    ${suspended ? `<div class="notice bad" style="margin-top:12px"><b>⊘ Your check-in is paused.</b>${suspendReason ? ' ' + esc(suspendReason) : ''} Reach out to the host if you think this is a mistake.</div>` : ''}
    ${mine}
    ${(action || runToggle) ? `<div class="controls" data-tour="join">${action}${runToggle}</div>` : ''}
    ${confirmCta}
    ${cancelled ? '' : `<div style="margin-top:12px"><a href="/run.ics" style="font-size:13px;color:var(--muted)">📅 Add this run to your calendar</a></div>`}
    ${infoSection}
    ${wgSheet}
    ${canSeeRoster ? `<div id="pvwrap" class="wgwrap pvwrap"><div class="wgscrim" onclick="pvClose()"></div>
      <div class="wgsheet pvsheet" role="dialog" aria-modal="true" aria-label="Player profile">
        <div class="wgsheet-h"><b>Profile</b><button class="wgx" type="button" onclick="pvClose()" aria-label="Close">${IC_CLOSE}</button></div>
        <div class="wgsheet-b pvbody"><div class="pcload">Loading…</div></div>
      </div></div>` : ''}

    ${qrBlock}
    <div style="height:28px"></div>
    ${locationBlock}
    ${canOperate ? runDayControls({ runDay, rdMsg }) : ''}
    <div class="foot" style="margin-top:12px"><a href="/logout">Sign out</a></div>
    <script>
      // Who's-going overlay. Open is instant; close plays a slide-down (unless
      // reduced-motion / noanim) with the state flip only at the end.
      window.wgOpen=function(){var w=document.getElementById('wgwrap');if(w){window.__ovPrev=document.activeElement;w.classList.add('open');document.body.style.overflow='hidden';var sh=w.querySelector('.wgsheet');if(sh){sh.setAttribute('tabindex','-1');try{sh.focus();}catch(e){}}}};
      // Quick-look profile popup (tap a name in the who's-going sheet). Opens ON TOP of it and
      // fetches a compact card; closing reveals the who's-going sheet still underneath.
      window.pvOpen=function(id){var w=document.getElementById('pvwrap');if(!w)return;var b=w.querySelector('.pvbody');if(b)b.innerHTML='<div class="pcload">Loading…</div>';w.classList.add('open');document.body.style.overflow='hidden';
        if(window.fetch)fetch('/u/'+id+'/card',{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.ok?r.text():Promise.reject();}).then(function(h){if(b)b.innerHTML=h;}).catch(function(){if(b)b.innerHTML='<div class="pcload">Couldn\\u2019t load that profile.</div>';});};
      window.pvClose=function(){var w=document.getElementById('pvwrap');if(!w)return;w.classList.remove('open');var wg=document.getElementById('wgwrap');if(!(wg&&wg.classList.contains('open')))document.body.style.overflow='';};
      window.wgClose=function(){var w=document.getElementById('wgwrap');if(!w)return;var sh=w.querySelector('.wgsheet');
        var still=document.documentElement.classList.contains('noanim')||(window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches);
        function restore(){var p=window.__ovPrev;if(p&&p.focus)try{p.focus();}catch(e){}}
        if(sh&&!still){sh.classList.add('closing');setTimeout(function(){w.classList.remove('open');sh.classList.remove('closing');document.body.style.overflow='';restore();},200);}
        else{w.classList.remove('open');document.body.style.overflow='';restore();}};

      // (.wrap swap engine — window.__swapWrap — now lives once in ANIM_HEAD, shared
      // by these check-in action fetches and the client tab router.)

      // (The run-action-form interceptor now lives in app.js so it binds on EVERY page for ANY run
      // program — it was formerly here, which only bound it once /checkin had loaded in the session.)

      // Surgical poll-and-patch (P0-1) replaces the old 20s full-page reload. On a
      // fingerprint change we re-fetch /checkin and swap .wrap in place (scroll kept,
      // no flash) — the SAME machinery the action buttons use. Skipped while the
      // user's own action fetch is in flight (__ckBusy), the who's-going sheet is
      // open, or a field is being edited. __poll self-guards against double-binding.
      window.__ckOnChange=function(){
        if(window.__ckBusy)return;
        if(window.__composing&&window.__composing())return;
        if(window.__overlayOpen&&window.__overlayOpen())return;   // don't nuke an open tour/sheet
        if(!window.fetch||!window.DOMParser||!window.__swapWrap)return;
        var y=window.scrollY;
        fetch('/checkin',{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}})
          .then(function(r){return r.text();})
          .then(function(html){
            if(window.__ckBusy||(window.__overlayOpen&&window.__overlayOpen()))return; // re-check at resolve time
            document.documentElement.classList.add('noanim');
            if(window.__swapWrap(html))window.scrollTo(0,y);})
          .catch(function(){});
      };
      if(window.__poll)window.__poll('checkin',window.__ckOnChange);

      // Keep the screen awake while viewing the live check-in page (host running the
      // night). pathname-gated + visibility-gated so it releases on any other tab and
      // re-acquires here; iOS auto-releases on background, hence the visibility hook.
      window.__wlSync=function(){
        if(!('wakeLock' in navigator))return;
        var want=${canOperate ? 'true' : 'false'}&&location.pathname.indexOf('/checkin')===0&&document.visibilityState==='visible';
        if(want&&!window.__wl){navigator.wakeLock.request('screen').then(function(s){window.__wl=s;s.addEventListener('release',function(){window.__wl=null;});}).catch(function(){});}
        else if(!want&&window.__wl){try{window.__wl.release();}catch(e){} window.__wl=null;}
      };
      if(!window.__wlBound){window.__wlBound=1;document.addEventListener('visibilitychange',function(){if(window.__wlSync)window.__wlSync();});}
      window.__wlSync();

      // tip-off countdown ticker — queries the (possibly re-swapped) node fresh.
      function paintTick(){var el=document.querySelector('.tick');if(!el)return;var tip=+el.getAttribute('data-tip');var diff=tip-Date.now();
        if(diff<=0){el.textContent="IT'S GAME TIME";return;}
        function pad(n){return String(n).padStart(2,'0');}
        var d=Math.floor(diff/86400000),h=Math.floor(diff%86400000/3600000),m=Math.floor(diff%3600000/60000);
        el.textContent=d+'D '+pad(h)+':'+pad(m);}
      paintTick();
      if(!window.__tickBound){ window.__tickBound=true; setInterval(paintTick,30000); }

      // Claim-countdown banner ticks client-side now that full reloads are gone; the
      // held-offer row is dropped server-side on expiry (60s interval), which changes
      // the /poll fingerprint → a swap then reconciles the page.
      function paintClaim(){var el=document.querySelector('.claimleft');if(!el)return;
        var rem=(+el.getAttribute('data-exp'))-Date.now();
        if(rem<=0){el.textContent='expiring now';return;}
        var h=Math.floor(rem/3600000),m=Math.floor(rem%3600000/60000);el.textContent=h+'h '+m+'m left';}
      paintClaim();
      if(!window.__claimBound){ window.__claimBound=true; setInterval(paintClaim,30000); }
    </script>
    ${firstRunTour}
  ` + footWithTabs(tabNav('runs', { dm: dmUnread, group: groupUnread, groupMention }));
}

// ---------- CLAIM RESULT (waitlist offer landing page) ----------
// Shown after tapping a spot-offer claim link (from the email or the in-app banner).
// ok=true → they're in for Friday; ok=false → the offer expired / was already claimed.
export function claimResultPage({ ok = false, runLabel = '', runDate = '', startLabel = '8:30 PM' } = {}) {
  if (ok) {
    return HEAD("You're in — The Bridge", '', { wall: false }) + header('', wdayShort(runDate)) + `
      <div class="rule"></div>
      <span class="eyebrow">Spot claimed</span>
      <h1>You're in for ${wdayFull(runDate)} ✓</h1>
      <p class="lead">Your spot's locked in${runLabel ? ` for <b>${esc(runLabel)}</b>` : ''}. See you on the floor — ${esc(startLabel)}, enter at the back.</p>
      <a class="btn" href="/checkin">Go to check-in →</a>
    ` + FOOT;
  }
  return HEAD('Offer expired — The Bridge', '', { wall: false }) + header('', wdayShort(runDate)) + `
    <div class="rule"></div>
    <span class="eyebrow">Too late</span>
    <h1>This offer has passed</h1>
    <p class="lead">That spot's already been claimed or the offer window closed, so it's moved on to the next person. If you'd still like to play, head to check-in and hop on the waitlist — you'll be offered the next spot that opens.</p>
    <a class="btn" href="/checkin">Go to check-in →</a>
  ` + FOOT;
}

export {
  fmtCountdown, COURT_SVG,
};
