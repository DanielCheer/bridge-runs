// views.js — server-rendered pages. No template engine; plain template literals.
import fs from 'fs';
const esc = (s = '') => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Cache-bust styles.css by its own modification time. Static assets are served
// with a 7-day cache; without this, returning users keep stale CSS after any
// design change. The query only changes when the file changes, so it still
// caches well between edits.
let CSS_VER = '1';
try { CSS_VER = String(Math.floor(fs.statSync(new URL('./public/styles.css', import.meta.url)).mtimeMs)); } catch {}

// SQLite datetime('now') stores UTC as 'YYYY-MM-DD HH:MM:SS'. Render it in the
// server's local timezone (run the app on Eastern — see README ops notes).
const fmtWhen = (sqlUtc) => {
  if (!sqlUtc) return '';
  const d = new Date(String(sqlUtc).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return esc(String(sqlUtc));
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
};

const HEAD = (title) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#F7F5F0">
<link rel="icon" href="/favicon.ico?v=2" sizes="any">
<link rel="icon" type="image/png" href="/icon-192.png?v=2">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-title" content="Bridge Runs">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700;800&family=Archivo:wght@400;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css?v=${CSS_VER}">
</head><body><div class="wrap">`;

const FOOT = `<div class="foot">The Bridge Adv Runs · Markham · Fridays 7–10PM</div></div></body></html>`;

const LOGO = `<svg class="logo" viewBox="0 0 64 64" fill="none" aria-hidden="true">
  <circle cx="32" cy="32" r="27" stroke="#70B5B0" stroke-width="5" stroke-linecap="round"
    stroke-dasharray="150 20" transform="rotate(-30 32 32)"/>
  <path d="M30 6 C 34 22, 34 42, 28 58" stroke="#70B5B0" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M8 24 C 24 30, 44 22, 58 12" stroke="#70B5B0" stroke-width="4" stroke-linecap="round"/>
</svg>`;

const header = (right = '') => `<div class="top">
  ${LOGO}
  <div class="mark"><span class="a">the bridge</span><span class="b">Adv&nbsp;<em>Runs</em></span></div>
  <div class="meta">${right || '<b>FRIDAYS</b>7:00–10:00 PM'}</div>
</div>`;

// Operator page-switcher — shows on the check-in / council / people pages so
// admins & team can jump between them. Manage People is admin-only, so team
// members don't get that button. Hidden entirely for regular players.
const opsNav = (current, { isAdmin = false, isTeam = false } = {}) => {
  if (!isAdmin && !isTeam) return '';
  const item = (href, label, key) => `<a href="${href}"${current === key ? ' class="on"' : ''}>${label}</a>`;
  return `<nav class="opsnav">
    ${item('/checkin', 'Check-in', 'checkin')}
    ${item('/admin', 'Council', 'admin')}
    ${isAdmin ? item('/admin/people', 'People', 'people') : ''}
  </nav>`;
};

const WAIVER_URL = process.env.WAIVER_URL
  || 'https://thebridgemarkham.churchcenter.com/people/forms/1158040';

const qrBlock = `<div class="qr">
  <img src="/waiver-qr.png" alt="Waiver QR code">
  <div class="t"><b>Sign the waiver</b>
  <p>Scan, or <a href="${WAIVER_URL}" target="_blank" rel="noopener">tap here to open it</a>. No waiver, no play.</p></div>
</div>`;

const locationBlock = `<div class="loc">
  <span class="loc-h">Where</span>
  <span class="loc-a">The Bridge Church, 5440 16th Ave, Markham L3P 3J3 — <b>enter at the back</b>. <a class="loc-map" href="https://www.google.com/maps/search/?api=1&query=5440+16th+Avenue+Markham+ON+L3P+3J3" target="_blank" rel="noopener">Maps →</a></span>
</div>`;

// ---------- INTAKE FORM (public application → council votes) ----------
export function intakePage({ submitted = false, error = '' } = {}) {
  if (submitted) {
    return HEAD('Applied — Adv Runs') + header() + `
      <div class="keyline"></div>
      <span class="eyebrow">You're in the queue</span>
      <h1>Application received</h1>
      <p class="lead">Thanks — the organizers have your info. Next step: come play on Mondays at our recreational open runs, 7–10PM. That's the tryout — they'll watch you play and decide on Adv spots from there. If you're approved, they'll send you the check-in link directly.</p>
      <div class="notice warn">Haven't signed the waiver yet? Do it now — you can't step on the floor without it.</div>
      ${qrBlock}
      <a class="btn ghost" href="/">Back</a>
    ` + FOOT;
  }
  return HEAD('Apply — The Bridge Adv Runs') + header() + `
    <div class="keyline"></div>
    <span class="eyebrow">Faith · Ball · Community</span>
    <h1>Faith. Ball. Community.</h1>
    <p class="lead">This run started to bring people together through basketball and point them toward Jesus. We play competitive ball and occasionally pause for a devotional. You don't have to share our faith to play — but it's part of who we are.</p>
    <p class="lead" style="margin-top:10px">The Adv Run is the competitive Friday run, and it's invite-based. Fill this out, then come to the <b>Monday recreational run</b> — that's the tryout. The organizers watch you play there and decide from there.</p>

    <div class="notice" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <span>Already applied or approved?</span>
      <a class="btn ghost sm" href="/login" style="width:auto">Sign in →</a>
    </div>

    ${error ? `<div class="notice" style="border-color:rgba(217,88,75,.5)">${esc(error)}</div>` : ''}

    <form method="POST" action="/apply" class="card rail">
      <label for="full_name">Full name</label>
      <input id="full_name" name="full_name" required autocomplete="name" placeholder="First Last">

      <label for="phone">Phone</label>
      <input id="phone" name="phone" required inputmode="tel" autocomplete="tel" placeholder="(647) 000-0000">

      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@email.com">

      <label>What level of basketball have you played? <span style="text-transform:none;font-weight:400;color:var(--muted)">(pick all that apply)</span></label>
      <div class="levels">
        <label class="lvl"><input type="checkbox" name="levels" value="Pickup / rec only"> Pickup / rec only</label>
        <label class="lvl"><input type="checkbox" name="levels" value="House league"> House league</label>
        <label class="lvl"><input type="checkbox" name="levels" value="High school"> High school</label>
        <label class="lvl"><input type="checkbox" name="levels" value="Men's league"> Men's league</label>
        <label class="lvl"><input type="checkbox" name="levels" value="College / semi-pro"> College / semi-pro</label>
        <label class="lvl"><input type="checkbox" name="levels" value="Other" id="lvlOther"> Other</label>
      </div>
      <input id="otherText" name="levels_other" placeholder="Tell us the other level…" style="display:none;margin-top:8px">

      <div class="check">
        <input id="waiver_ok" name="waiver_ok" type="checkbox" value="1" required>
        <label for="waiver_ok">I've completed (or will complete) the church waiver linked below. I understand I can't play without it.</label>
      </div>

      <div style="height:16px"></div>
      <button class="btn" type="submit">Submit application</button>
    </form>

    <script>
      (function(){
        var other=document.getElementById('lvlOther'), otherText=document.getElementById('otherText');
        if(other){other.addEventListener('change',function(){otherText.style.display=other.checked?'block':'none';if(!other.checked)otherText.value='';});}
        var form=document.querySelector('form[action="/apply"]');
        if(form){form.addEventListener('submit',function(e){
          var any=form.querySelectorAll('input[name="levels"]:checked').length>0;
          if(!any){e.preventDefault();alert('Pick at least one level of basketball you\\'ve played.');}
        });}
      })();
    </script>

    ${qrBlock}
    ${locationBlock}
    <div class="foot" style="margin-top:20px">Already approved? <a href="/login">Sign in to check in →</a></div>
  ` + FOOT;
}

// ---------- LOGIN ----------
export function loginPage({ sent = false, email = '', next = '', devLink = '', error = '' } = {}) {
  if (sent) {
    return HEAD('Check your email') + header() + `
      <div class="keyline"></div>
      <h1>Check your email</h1>
      <p class="lead">We sent a sign-in link to <b>${esc(email)}</b>. Tap it on this phone and you're in. Expires in 15 minutes.</p>
      ${devLink ? `<div class="notice warn">DEV MODE — email isn't configured, so here's your link:<br><a href="${esc(devLink)}">${esc(devLink)}</a></div>` : ''}
      <div class="notice">Didn't get it? Check spam, wait a minute, then <a href="/login${next ? '?next=' + encodeURIComponent(next) : ''}">request a new link</a> — the old one stops working when you do.</div>
      <a class="btn ghost" href="/checkin">Back</a>
    ` + FOOT;
  }
  return HEAD('Sign in — Adv Runs') + header() + `
    <div class="keyline"></div>
    <span class="eyebrow">Approved players</span>
    <h1>Sign in to check in</h1>
    <p class="lead">Enter the email you applied with. We'll send a one-tap sign-in link — no password.</p>
    ${error ? `<div class="notice warn">${esc(error)}</div>` : ''}
    <form method="POST" action="/login" class="card rail">
      <input type="hidden" name="next" value="${esc(next)}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@email.com">
      <p class="tally-note" style="margin:8px 0 0">Use the exact email you applied with, or we won't recognize you.</p>
      <div style="height:14px"></div>
      <button class="btn" type="submit" id="sendbtn"><span class="spin" aria-hidden="true"></span><span class="btnlabel">Send my link</span></button>
    </form>
    <div class="foot" style="margin-top:20px">Not on the list yet? <a href="/">Apply here →</a></div>
    <script>
      (function(){
        var form = document.querySelector('form[action="/login"]');
        if(!form) return;
        form.addEventListener('submit', function(){
          var b = document.getElementById('sendbtn');
          if(!b) return;
          b.classList.add('sending');
          b.disabled = true;
          var lbl = b.querySelector('.btnlabel');
          if(lbl) lbl.textContent = 'Sending…';
        });
      })();
    </script>
  ` + FOOT;
}

// ---------- INVITE (self-serve pre-approval link) ----------
export function invitePage({ invalid = false, used = false, token = '', full_name = '', phone = '', email = '', error = '' } = {}) {
  if (invalid) {
    return HEAD('Invite not found — Adv Runs') + header() + `
      <div class="keyline"></div>
      <h1>That link isn't valid</h1>
      <p class="lead">This invite link doesn't exist. Double check you copied the whole link, or ask whoever sent it for a fresh one.</p>
      <a class="btn ghost" href="/login">Already have an account? Sign in</a>
    ` + FOOT;
  }
  if (used) {
    return HEAD('Invite already used — Adv Runs') + header() + `
      <div class="keyline"></div>
      <h1>This invite's already been used</h1>
      <p class="lead">Each invite link works once. If that was you, just sign in below. If it wasn't, ask an organizer for a fresh link.</p>
      <a class="btn" href="/login">Sign in</a>
    ` + FOOT;
  }
  return HEAD("You're invited — Adv Runs") + header() + `
    <div class="keyline"></div>
    <span class="eyebrow">You're pre-approved</span>
    <h1>Finish setting up your spot</h1>
    <p class="lead">An organizer's already cleared you for the Adv Run — just confirm your info and you're in, no application, no waiting.</p>
    ${error ? `<div class="notice" style="border-color:rgba(217,88,75,.5)">${esc(error)}</div>` : ''}
    <form method="POST" action="/invite/${esc(token)}" class="card rail">
      <label for="full_name">Full name</label>
      <input id="full_name" name="full_name" required autocomplete="name" value="${esc(full_name)}" placeholder="First Last">

      <label for="phone">Phone</label>
      <input id="phone" name="phone" required inputmode="tel" autocomplete="tel" value="${esc(phone)}" placeholder="(647) 000-0000">

      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email" value="${esc(email)}" placeholder="you@email.com">
      <p class="tally-note" style="margin:6px 0 0">This is the email you'll sign in with every time — make sure it's one you check.</p>

      <div class="check">
        <input id="waiver_ok" name="waiver_ok" type="checkbox" value="1" required>
        <label for="waiver_ok">I've completed (or will complete) the church waiver linked below. I understand I can't play without it.</label>
      </div>

      <div style="height:16px"></div>
      <button class="btn" type="submit">Confirm and check in →</button>
    </form>

    ${qrBlock}
    <div class="foot" style="margin-top:20px">Already set up? <a href="/login">Sign in</a></div>
  ` + FOOT;
}

// ---------- CHECK-IN ----------
export function checkinPage({ email, status, runLabel, runDate, cap, waitlistCap, going, waiting, full, runFull, isOpen, canSeeCount, regularSlotsFull,
                             myState, myWaitPos, iAmTeam, iAmRegular, iOptedOut, iAutoRenew,
                             viewerIsAdmin, canOperate, canSeeRoster, announcement, announcementLog = [], inPlayers, waitPlayers }) {

  // Not cleared to play yet (admins always get through — they run the check-in)
  if (!viewerIsAdmin && status !== 'approved') {
    const pill = status === 'rejected' ? '<span class="pill rejected">Not this season</span>'
      : status === 'pending' ? '<span class="pill pending">Under review</span>'
      : '<span class="pill pending">Not on the list</span>';
    return HEAD('Check-in — Adv Runs') + header() + `
      <div class="keyline"></div>
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

  // ----- my own action button -----
  const canPlay = status === 'approved';
  let action = '';
  if (!canPlay) {
    action = '';
  } else if (iAmTeam && iAutoRenew && iOptedOut && myState === 'out') {
    action = `<form method="POST" action="/checkin/optin"><button class="btn" type="submit">Actually, I'm in this week</button></form>`;
  } else if (iAmTeam && iAutoRenew && (myState === 'in' || (!isOpen && !iOptedOut))) {
    // team auto-joins on open; give them a self-clear
    action = `<form method="POST" action="/checkin/optout"><button class="btn leave" type="submit">Sit out this week</button></form>`;
  } else if (myState === 'in') {
    action = `<form method="POST" action="/checkin/leave"><button class="btn leave" type="submit">Drop out</button></form>`;
  } else if (myState === 'waitlist') {
    action = `<form method="POST" action="/checkin/leave"><button class="btn leave" type="submit">Leave waitlist (#${myWaitPos})</button></form>`;
  } else if (!isOpen && iAmRegular && regularSlotsFull) {
    action = `<button class="btn" type="button" disabled>Early spots full — opens to all soon</button>`;
  } else if (!isOpen && iAmRegular) {
    // regulars can join while closed — shown as a normal join, no role wording
    action = `<form method="POST" action="/checkin/join"><button class="btn" type="submit">I'm in</button></form>`;
  } else if (!isOpen && iAmTeam) {
    // team keep pre-access even with auto-renew off — manual join while closed
    action = `<form method="POST" action="/checkin/join"><button class="btn" type="submit">I'm in</button></form>`;
  } else if (!isOpen) {
    action = `<button class="btn" type="button" disabled>Check-in closed</button>`;
  } else if (runFull) {
    action = `<button class="btn" type="button" disabled>Run &amp; waitlist full</button>`;
  } else if (full) {
    action = `<form method="POST" action="/checkin/join"><button class="btn" type="submit">Join waitlist (${waiting}/${waitlistCap})</button></form>`;
  } else {
    action = `<form method="POST" action="/checkin/join"><button class="btn" type="submit">I'm in</button></form>`;
  }

  // ----- my own state line -----
  let mine = '';
  if (iAmTeam && iAutoRenew && iOptedOut) {
    mine = `<div class="notice">You're sitting out this Friday. Tap below if that changes.</div>`;
  } else if (iAmTeam && iAutoRenew && !isOpen) {
    mine = `<div class="notice good">You're on the floor for Friday. Sitting out this week? Clear your spot below.</div>`;
  } else if (iAmRegular && !isOpen && regularSlotsFull) {
    mine = `<div class="notice warn">Early spots are full for this week. You'll be able to join when check-in opens to everyone.</div>`;
  } else if (iAmRegular && !isOpen && myState === 'out') {
    mine = '';  // regulars just get the join button — no role wording
  } else if (!isOpen && myState === 'out') {
    mine = `<div class="notice warn">Registration opens <b>Wednesday night</b> for approved players — spots are capped at ${cap}, so get in early once it's live. The organizer opens it manually and will announce it.</div>`;
  } else if (myState === 'in') {
    mine = `<div class="notice good">You're on the floor for Friday. ✓${iAmTeam ? ' (team)' : ''}</div>`;
  } else if (myState === 'waitlist') {
    mine = `<div class="notice warn">You're <b>#${myWaitPos}</b> on the waitlist. If someone drops, the top of the list moves in automatically.</div>`;
  } else if (full) {
    mine = `<div class="notice warn">Run's full at ${cap}. Join the waitlist and you'll move in if a spot opens.</div>`;
  }

  // ----- team auto-renew toggle -----
  let autoRenewToggle = '';
  if (iAmTeam) {
    autoRenewToggle = iAutoRenew
      ? `<details class="announce-compose"><summary>Auto-renew: <b>ON</b> — you get a floor spot every week</summary>
          <p class="tally-note" style="margin:8px 0">Turn this off if you only want to play some weeks — you'll join manually instead of being auto-added. (Use "sit out this week" above for a one-off skip.)</p>
          <form method="POST" action="/checkin/autorenew"><input type="hidden" name="on" value="0"><button class="btn ghost sm" type="submit">Turn auto-renew off</button></form>
        </details>`
      : `<div class="notice">Auto-renew is <b>off</b> — you're not auto-added. Join manually below when you want to play.
          <form method="POST" action="/checkin/autorenew" style="margin-top:8px"><input type="hidden" name="on" value="1"><button class="btn sm" type="submit">Turn auto-renew back on</button></form>
        </div>`;
  }

  // ----- Operator roster + controls (admin + team) -----
  let adminRoster = '';
  if (canOperate) {
    const inRow = (p, i) => `<li>
      <span class="num">${i}</span>
      <span class="pn">${esc(p.name)}${p.email === email ? ' <span class="me">You</span>' : ''}</span>
      ${p.guest ? '<span class="tag tryout">Guest</span>' : ''}
      ${p.team ? '<span class="tag team">Team</span>' : ''}
      ${p.regular ? '<span class="tag reg">Core</span>' : ''}
      ${p.tryout ? '<span class="tag tryout">Tryout</span>' : ''}
      <form method="POST" action="/checkin/remove" style="margin:0">
        <input type="hidden" name="email" value="${esc(p.email)}">
        <button class="btn leave sm" type="submit" title="Remove from run">Remove</button>
      </form>
    </li>`;
    const waitRow = (p, i) => `<li>
      <span class="num">${i}</span>
      <span class="pn">${esc(p.name)}${p.email === email ? ' <span class="me">You</span>' : ''}</span>
      ${p.guest ? '<span class="tag tryout">Guest</span>' : ''}
      ${p.held ? '<span class="tag reg">Core · held</span>' : ''}
      ${p.team ? '<span class="tag team">Team</span>' : ''}
      ${(p.regular && !p.held) ? '<span class="tag reg">Core</span>' : ''}
      ${p.tryout ? '<span class="tag tryout">Tryout</span>' : ''}
      <form method="POST" action="/checkin/promote" style="margin:0">
        <input type="hidden" name="email" value="${esc(p.email)}">
        <button class="btn sm" type="submit" title="Move into the run">Bump in</button>
      </form>
      <form method="POST" action="/checkin/remove" style="margin:0">
        <input type="hidden" name="email" value="${esc(p.email)}">
        <button class="btn ghost sm" type="submit" title="Remove from waitlist">✕</button>
      </form>
    </li>`;
    const inList = inPlayers.map((p, i) => inRow(p, i + 1)).join('');
    const waitList = waitPlayers.map((p, i) => waitRow(p, i + 1)).join('');
    const toggle = isOpen
      ? `<form method="POST" action="/checkin/close" style="margin:0"><button class="btn leave" type="submit">Close check-in</button></form>`
      : `<form method="POST" action="/checkin/open" style="margin:0"><button class="btn" type="submit">Open check-in</button></form>`;
    adminRoster = `
      <div class="runstate ${isOpen ? 'open' : 'closed'}">
        <span class="dot"></span> Check-in is <b>${isOpen ? 'OPEN' : 'CLOSED'}</b>${isOpen ? '' : ' — players can\'t join yet'}
      </div>
      <div style="margin:12px 0">${toggle}</div>
      <div class="notice">Organizer view — you and the team see names and can manage the floor. Players see only the count.</div>
      <div class="subhead">On the floor</div>
      <ul class="plist plist-admin">${inList || '<li><span class="pn" style="color:var(--chalk-dim)">Nobody yet.</span></li>'}</ul>
      ${waitPlayers.length ? `<div class="subhead">Waitlist (${waiting}/${waitlistCap})</div><ul class="plist plist-admin">${waitList}</ul>` : ''}
      <details class="announce-compose"><summary>Add a guest</summary>
        <form method="POST" action="/checkin/guest" style="margin-top:10px">
          <input name="name" required maxlength="60" placeholder="Guest name — last-minute add">
          <div style="height:8px"></div>
          <button class="btn sm" type="submit">Add guest to the run</button>
        </form>
      </details>`;
  } else if (canSeeRoster && (inPlayers.length || waitPlayers.length)) {
    // read-only list for regulars / normal-when-open: names only, no roles, no controls
    const roRow = (p, i) => `<li>
      <span class="num">${i}</span>
      <span class="pn">${esc(p.name)}${p.email === email ? ' <span class="me">You</span>' : ''}</span>
    </li>`;
    const inRO = inPlayers.map((p, i) => roRow(p, i + 1)).join('');
    const waitRO = waitPlayers.map((p, i) => roRow(p, i + 1)).join('');
    adminRoster = `
      <div class="subhead">On the floor</div>
      <ul class="plist">${inRO || '<li><span class="pn">Nobody yet.</span></li>'}</ul>
      ${waitPlayers.length ? `<div class="subhead">Waitlist (${waiting}/${waitlistCap})</div><ul class="plist">${waitRO}</ul>` : ''}`;
  }

  // ----- announcements (all approved see it; operators post/clear) -----
  const annBlock = announcement
    ? `<div class="announce">
        <div class="announce-h">📣 Announcement</div>
        <div class="announce-b">${esc(announcement.body)}</div>
        <div class="announce-meta">Posted ${esc(fmtWhen(announcement.at))}${canOperate && announcement.author ? ' · ' + esc(announcement.author) : ''}</div>
        ${canOperate ? `<form method="POST" action="/announce/clear" style="margin:8px 0 0"><button class="btn ghost sm" type="submit">Clear</button></form>` : ''}
      </div>`
    : '';
  const annCompose = canOperate
    ? `<details class="announce-compose"><summary>${announcement ? 'Replace announcement' : 'Post an announcement'}</summary>
        <form method="POST" action="/announce" style="margin-top:10px">
          <textarea name="body" required maxlength="500" placeholder="e.g. No run this Friday — gym's booked. Back next week."></textarea>
          <div style="height:8px"></div>
          <button class="btn sm" type="submit">Post to all players</button>
        </form>
      </details>`
    : '';
  // ----- announcement history (operators only) -----
  const annHistory = (canOperate && announcementLog.length)
    ? `<details class="announce-compose"><summary>Announcement history (${announcementLog.length})</summary>
        <ul class="annlog">
          ${announcementLog.map(a => `<li>
            <div class="annlog-b">${esc(a.body)}</div>
            <div class="annlog-m">
              <span class="annlog-state ${a.archived ? 'past' : 'live'}">${a.archived ? 'Cleared' : 'Live'}</span>
              Posted ${esc(fmtWhen(a.at))}${a.author ? ' · ' + esc(a.author) : ''}${a.archived && a.archived_at ? ' · cleared ' + esc(fmtWhen(a.archived_at)) : ''}
            </div>
          </li>`).join('')}
        </ul>
      </details>`
    : '';

  return HEAD('Friday Check-in — Adv Runs') + header(`<b>CHECK-IN</b>${esc(email)}`) + `
    ${opsNav('checkin', { isAdmin: viewerIsAdmin, isTeam: iAmTeam })}
    ${annBlock}
    ${annCompose}
    ${annHistory}
    <div class="run">
      <div class="when">Friday <span>·</span> ${esc(runLabel)}${!isOpen ? ' <span class="closedbadge">Closed</span>' : ''}</div>
      <div class="sub">Adv Run @ The Bridge · 7:00–10:00 PM · cap ${cap}</div>
      <div class="count">
        ${canSeeCount
          ? `<span class="n ${full ? 'full' : ''}">${going}/${cap}</span>
             <span class="lab">${runFull ? 'run + waitlist full' : full ? `full · waitlist ${waiting}/${waitlistCap}` : (cap - going) + ' spots left'}</span>`
          : `<span class="n">—</span>
             <span class="lab">count shows when check-in opens</span>`}
      </div>
    </div>

    ${mine}
    <div style="margin:16px 0">${action}</div>
    ${autoRenewToggle}
    ${adminRoster}

    ${qrBlock}
    <div style="height:40px"></div>
    ${locationBlock}
    <p class="tally-note" style="text-align:center;margin-top:22px">💡 Tip: tap your browser's <b>Share</b> → <b>Add to Home Screen</b> to open the run in one tap. It launches <b>fullscreen like an app</b> (no browser bars) and keeps you signed in.</p>
    <div class="foot" style="margin-top:12px"><a href="/logout">Sign out</a></div>
    <script>
      // light auto-refresh so the count/roster stays current without websockets
      setInterval(()=>{ if(document.visibilityState==='visible') location.reload(); }, 20000);
    </script>
  ` + FOOT;
}

// ---------- ADMIN / COUNCIL ----------
export function adminPage({ applicants, runLabel, checkedInCount, cap,
                           viewerIsAdmin = true, viewerIsTeam = false, viewerEmail = '', log = [],
                           filter = 'all', counts = {} }) {
  const pill = (s) => `<span class="pill ${s}">${s}</span>`;
  const voteBtn = (id, vote, label, cls, active) =>
    `<form method="POST" action="/admin/vote"><input type="hidden" name="id" value="${id}"><input type="hidden" name="vote" value="${vote}"><button class="btn ${cls} sm${active ? ' voted' : ''}" type="submit">${active ? '✓ ' : ''}${label}</button></form>`;

  const rows = applicants.map(a => {
    const isSelf = a.email === viewerEmail;
    // Role toggles — ADMIN ONLY. Making team auto-approves; regular needs approved.
    const roleBtn = (role, flag, onLabel, offLabel, show) => (!viewerIsAdmin || !show) ? '' : (flag
      ? `<form method="POST" action="/admin/role"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="role" value="${role}"><input type="hidden" name="on" value="0"><button class="btn sm regstar" type="submit">${onLabel}</button></form>`
      : `<form method="POST" action="/admin/role"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="role" value="${role}"><input type="hidden" name="on" value="1"><button class="btn ghost sm" type="submit">${offLabel}</button></form>`);
    const teamBtn = roleBtn('team', a.is_team, '◆ Team — remove', 'Make team', true);
    const regBtn  = roleBtn('regular', a.is_regular, '★ Core — remove', 'Make Core', a.status === 'approved');

    // Team members are auto-approved and not voted on.
    let decisionBlock;
    if (a.is_team) {
      decisionBlock = `<div class="ad" style="margin-top:10px">◆ Team — auto-approved, no vote needed.</div>
        <div class="acts">${teamBtn}${regBtn}</div>`;
    } else {
      const v = a.vote || { poolSize: 0, threshold: 3, approved: [], rejected: [], waiting: [], myVote: null };
      const th = v.threshold || 3;
      const tally = `<div class="tally"><b>${v.approved.length}/${th}</b> approvals${v.rejected.length ? ` · <span style="color:var(--bad)">${v.rejected.length}/${th} rejects</span>` : ''} <span class="tally-note">(${th} to decide)</span></div>`;
      // admin-only: who's still to vote
      const waiting = (viewerIsAdmin && v.waiting.length && a.status === 'pending')
        ? `<div class="tally-note">Waiting on: ${v.waiting.map(esc).join(', ')}</div>` : '';
      const rejectedBy = (viewerIsAdmin && v.rejected.length)
        ? `<div class="tally-note">Rejected by: ${v.rejected.map(esc).join(', ')}</div>` : '';
      const voteButtons = !viewerIsTeam
        ? '<span class="ad" style="margin:0">Team decides — you have oversight, not a vote.</span>'
        : (isSelf
          ? '<span class="ad" style="margin:0">Your own application — you can\'t vote.</span>'
          : `${voteBtn(a.id, 'approve', 'Approve', 'ghost', v.myVote === 'approve')}
             ${voteBtn(a.id, 'reject', 'Reject', 'leave', v.myVote === 'reject')}`);
      const resetBtn = viewerIsAdmin
        ? `<form method="POST" action="/admin/reset"><input type="hidden" name="id" value="${a.id}"><button class="btn ghost sm" type="submit">Reset votes</button></form>` : '';
      decisionBlock = `${tally}${waiting}${rejectedBy}
        <div class="acts">${voteButtons}${resetBtn}${teamBtn}${regBtn}</div>`;
    }

    return `<details class="arow"${a.status === 'pending' ? ' open' : ''}>
    <summary><span class="an">${esc(a.full_name)}${a.is_team ? ' <span class="tag team">◆ Team</span>' : ''}${a.is_regular ? ' <span class="tag reg">★ Core</span>' : ''}</span> ${pill(a.status)}</summary>
    <div class="ae" style="margin-top:12px">${esc(a.email)} · ${esc(a.phone)}</div>
    <div class="ad"><b>${esc(a.experience)}</b>${a.where_played ? ' — ' + esc(a.where_played) : ''}<br>
      Waiver: ${a.waiver_ok ? '✓ confirmed' : '✗ not confirmed'} · applied ${esc(a.created_at)}</div>
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

  return HEAD('Council — Adv Runs') + header(`<b>COUNCIL</b>${viewerIsAdmin ? 'admin' : 'team'}`) + `
    ${opsNav('admin', { isAdmin: viewerIsAdmin, isTeam: viewerIsTeam })}
    <div class="keyline"></div>
    <span class="eyebrow">${applicants.length} ${filter === 'all' ? 'applicant' : filter}${applicants.length===1?'':'s'}</span>
    <h1>Council review</h1>
    <p class="lead">${viewerIsAdmin
      ? 'Approval is decided by the <b>team</b>: 3 approvals gets an applicant in, 3 rejects blocks them. You have oversight and manage people, but you don\'t vote. Team members are auto-approved and skip the vote.'
      : 'It takes <b>3 approvals</b> to get an applicant in, or <b>3 rejects</b> to block them. Cast your vote below.'}</p>
    <div class="notice">This Friday (${esc(runLabel)}): <b>${checkedInCount}/${cap}</b> checked in.</div>
    ${filterTabs}
    ${rows || `<div class="card">${emptyMsg}</div>`}
    ${logBlock}
    <div class="foot" style="margin-top:24px"><a href="/logout">Sign out</a></div>
  ` + FOOT;
}

// ---------- STATUS PAGE (unapproved players) ----------
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
  return HEAD('Your status — Adv Runs') + header('<b>STATUS</b>' + esc(email)) + `
    <div class="keyline"></div>
    ${body}
    <div class="foot" style="margin-top:24px"><a href="/logout">Sign out</a></div>
  ` + FOOT;
}

// ---------- PEOPLE MANAGEMENT (admin-only) ----------
export function peoplePage({ people, q = '', approvedPhones = [], signInUrl = '', invites = [], newInviteLink = '', msg = '' }) {
  const pill = (s) => `<span class="pill ${s}">${s}</span>`;
  const rows = people.map(a => `<details class="arow"${q ? ' open' : ''}>
    <summary><span class="an">${esc(a.full_name)}${a.is_team ? ' <span class="tag team">◆</span>' : ''}${a.is_regular ? ' <span class="tag reg">★</span>' : ''}</span> ${pill(a.status)}</summary>
    <form method="POST" action="/admin/people/edit" class="editrow" style="margin-top:12px">
      <input type="hidden" name="id" value="${a.id}">
      <label>Name<input name="full_name" value="${esc(a.full_name)}"></label>
      <label>Phone<input name="phone" value="${esc(a.phone)}" inputmode="tel"></label>
      <label>Email<input name="email" type="email" value="${esc(a.email)}"></label>
      <div class="editacts">
        <button class="btn sm" type="submit">Save</button>
      </div>
    </form>
    <form method="POST" action="/admin/people/delete" onsubmit="return confirm('Delete ${esc(a.full_name)} permanently? This removes their record, check-ins and votes.');" style="margin:6px 0 0">
      <input type="hidden" name="id" value="${a.id}">
      <button class="btn leave sm" type="submit">Delete person</button>
    </form>
  </details>`).join('');

  const phoneList = approvedPhones.map(p => `${p.full_name}: ${p.phone}`).join('\n');

  return HEAD('People — Adv Runs') + header('<b>PEOPLE</b>admin') + `
    ${opsNav('people', { isAdmin: true })}
    <div class="keyline"></div>
    <span class="eyebrow">${people.length} ${q ? 'match' + (people.length===1?'':'es') : 'people'}</span>
    <h1>People</h1>
    ${msg ? `<div class="notice good">${esc(msg)}</div>` : ''}

    <form method="GET" action="/admin/people" style="margin:8px 0 4px">
      <input name="q" value="${esc(q)}" placeholder="Search name, email, or phone…">
    </form>

    <a class="btn ghost" href="/admin/share" style="margin:8px 0 0">📱 Share sign-up QR &amp; links</a>

    <div class="subhead">Add a player</div>
    <form method="POST" action="/admin/people/invite" class="card rail">
      <p class="tally-note" style="margin:0 0 10px">Fill in whatever you know — all three fields are optional. Give <b>all three</b> and they're approved instantly, no link needed. Give less (or nothing) and you'll get a one-time link to send them — they fill in the rest, confirm the waiver, and land signed in.</p>
      <label>Full name <span style="text-transform:none;font-weight:400;color:var(--muted)">(optional)</span><input name="full_name" placeholder="Leave blank to let them fill it in"></label>
      <label>Phone <span style="text-transform:none;font-weight:400;color:var(--muted)">(optional)</span><input name="phone" inputmode="tel" placeholder="Leave blank to let them fill it in"></label>
      <label>Email <span style="text-transform:none;font-weight:400;color:var(--muted)">(optional — required for instant add)</span><input name="email" type="email" placeholder="Leave blank to let them fill it in"></label>
      <label style="margin-bottom:2px">Role</label>
      <div class="levels">
        <label class="lvl"><input type="radio" name="role" value="" checked> Approved only — can check in</label>
        <label class="lvl"><input type="radio" name="role" value="regular"> ★ Core — early access to join before you open the run</label>
        <label class="lvl"><input type="radio" name="role" value="team"> ◆ Team — helps run it, auto-seated each week</label>
      </div>
      <p class="tally-note" style="margin:8px 0 0">If the email already exists on file, this just approves that record (and sets the role) instead of duplicating it.</p>
      <div style="height:12px"></div>
      <button class="btn" type="submit">Add player</button>
    </form>

    ${newInviteLink ? `<div class="notice good">
        <b>Link created — copy and send it:</b>
        <input id="newinv" readonly value="${esc(newInviteLink)}" style="font-size:13px;margin-top:8px">
        <div style="height:8px"></div>
        <button class="btn sm" type="button" onclick="const t=document.getElementById('newinv');t.select();navigator.clipboard.writeText(t.value);this.textContent='Copied ✓';setTimeout(()=>this.textContent='Copy link',1500)">Copy link</button>
      </div>` : ''}

    ${invites.length ? `<details class="announce-compose"><summary>Pending invites (${invites.length})</summary>
        <ul class="annlog">
          ${invites.map(iv => `<li>
            <div class="annlog-b">${esc(iv.full_name || '(no name yet)')}${iv.phone ? ' · ' + esc(iv.phone) : ''}${iv.email ? ' · ' + esc(iv.email) : ''}${iv.role ? ` <span class="tag ${iv.role === 'team' ? 'team' : 'reg'}">${iv.role === 'team' ? '◆ Team' : '★ Core'}</span>` : ''}</div>
            <div class="annlog-m" style="margin-bottom:8px">Created ${esc(fmtWhen(iv.created_at))} by ${esc(iv.created_by)} · not used yet</div>
            <input readonly value="${esc(iv.link)}" style="font-size:12.5px" onclick="this.select()">
            <div style="height:6px"></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn ghost sm" type="button" onclick="navigator.clipboard.writeText('${esc(iv.link)}');this.textContent='Copied ✓';setTimeout(()=>this.textContent='Copy link',1500)">Copy link</button>
              <form method="POST" action="/admin/people/invite/revoke" onsubmit="return confirm('Revoke this invite link? It will stop working.');" style="margin:0">
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
      <input id="invite" readonly value="${esc(signInUrl)}" style="font-size:13px">
      <div style="height:10px"></div>
      <button class="btn sm" type="button" onclick="const t=document.getElementById('invite');t.select();navigator.clipboard.writeText(t.value);this.textContent='Copied ✓';setTimeout(()=>this.textContent='Copy sign-in link',1500)">Copy sign-in link</button>
    </div>

    <div class="subhead">Copy approved players' numbers</div>
    <div class="card" style="padding:14px">
      <textarea id="phones" rows="${Math.min(Math.max(approvedPhones.length,2),12)}" readonly style="font-size:13px">${esc(phoneList)}</textarea>
      <div style="height:10px"></div>
      <button class="btn sm" type="button" onclick="const t=document.getElementById('phones');t.select();navigator.clipboard.writeText(t.value);this.textContent='Copied ✓';setTimeout(()=>this.textContent='Copy all numbers',1500)">Copy all numbers</button>
    </div>

    <div class="subhead">Everyone</div>
    ${rows || '<div class="card">No people yet.</div>'}
    <div class="foot" style="margin-top:24px"><a href="/logout">Sign out</a></div>
  ` + FOOT;
}

// ---------- SHARE (QR + link for the application form) ----------
export function sharePage({ applyUrl = '', applyQr = '', signInUrl = '', loginQr = '' }) {
  const copyBtn = (id, label) => `<button class="btn sm" type="button" onclick="const t=document.getElementById('${id}');t.select();navigator.clipboard.writeText(t.value);this.textContent='Copied ✓';setTimeout(()=>this.textContent='${label}',1500)">${label}</button>`;
  return HEAD('Share — Adv Runs') + header('<b>SHARE</b>admin') + `
    ${opsNav('people', { isAdmin: true })}
    <div class="keyline"></div>
    <span class="eyebrow">Sign-up form</span>
    <h1>Share the application</h1>
    <p class="lead">Show this at the Monday rec runs — people scan the code to open the application form. No typing a long link.</p>

    <div class="card" style="text-align:center;padding:20px">
      <div class="qrbox">${applyQr}</div>
      <div style="height:14px"></div>
      <a class="btn" href="${esc(applyUrl)}" target="_blank" rel="noopener">Open the application form →</a>
      <div style="height:10px"></div>
      <input id="applylink" readonly value="${esc(applyUrl)}" style="font-size:13px;text-align:center">
      <div style="height:8px"></div>
      ${copyBtn('applylink', 'Copy link')}
    </div>

    <div class="subhead">Sign-in link (for already-approved players)</div>
    <div class="card" style="text-align:center;padding:18px">
      <div class="qrbox qrbox-sm">${loginQr}</div>
      <div style="height:12px"></div>
      <input id="loginlink" readonly value="${esc(signInUrl)}" style="font-size:13px;text-align:center">
      <div style="height:8px"></div>
      ${copyBtn('loginlink', 'Copy sign-in link')}
    </div>

    <div class="foot" style="margin-top:24px"><a href="/admin/people">Manage people</a> · <a href="/logout">Sign out</a></div>
  ` + FOOT;
}
