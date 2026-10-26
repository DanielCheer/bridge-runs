// views.js — server-rendered pages. No template engine; plain template literals.
import { esc, fmtWhen } from './views/util.js';
import {
  qrBlock, homeScreenCard, tabNav, opsNav, backToRuns, firstRunTour, backBtn, copyBtn, shareBtn,
  shareScript,
} from './views/components.js';
import { HEAD, FOOT, header, footWithTabs } from './views/shell.js';
export {
  pcoAdminPage,
} from './views/pages/pco.js';
export {
  programsAdminPage,
} from './views/pages/programs.js';
export {
  kioskPage,
} from './views/pages/kiosk.js';
export {
  analyticsPage, runHistoryPage, auditViewerPage,
} from './views/pages/analytics.js';
export {
  adminPage,
} from './views/pages/admin.js';
export {
  threadPage,
} from './views/pages/messages.js';
export {
  runPage, pickleballPage,
} from './views/pages/run.js';
export {
  runsPage, runJoinPage, pkJoinPage, pastRunPage, seasonPage,
} from './views/pages/runs-hub.js';
export {
  friendsSearchFragment, friendsPage,
} from './views/pages/friends.js';
export {
  demoProfileCard, profileCard, profilePage, profileTabPage,
} from './views/pages/profile.js';
export {
  chatPage, runChatPage, chatOlderFragment, chatLockedPage,
} from './views/pages/chat.js';
export {
  checkinPage, claimResultPage,
} from './views/pages/checkin.js';
export {
  invitePage,
} from './views/pages/invite.js';
export {
  loginPage,
} from './views/pages/login.js';
export {
  intakePage,
} from './views/pages/intake.js';
export {
  BUILD_VER, setDemoMode,
} from './views/shell.js';
export {
  STICKERS,
} from './views/chat-ui.js';
export {
  setAvatarMap, avatarUrlFor, setProgramMeta,
} from './views/components.js';
export {
  APP_JS,
} from './views/client-app.js';

// ---------- PLANNING CENTER SYNC (admin console) ----------
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
  return HEAD('Your status — The Bridge', '', { wall: false }) + header('<b>STATUS</b>' + esc(email)) + `
    <div class="rule"></div>
    ${body}
    ${homeScreenCard}
    <div class="foot" style="margin-top:24px"><a href="/logout">Sign out</a></div>
  ` + FOOT;
}

// ---------- CHAT LOCKED (no run joined yet) ----------
// Sign-out confirmation. GET /logout renders THIS (a harmless read — no state
// change), and the actual session clear happens only on POST. That closes the
// CSRF / link-prefetch hole a GET-that-logs-you-out opens, and keeps a working
// no-JS path (the button below posts). With JS, the delegated handler in HEAD
// intercepts the "Sign out" link and posts directly, so this page is rarely seen.
// Demo reset (DEMO_MODE only, organizer only). The confirm never auto-submits: a reset wipes
// everyone's changes. After the POST the server exits and its supervisor reseeds, so the
// "resetting" page waits for /healthz to drop and answer again before going back to the picker.
export function demoResetPage({ resetting = false } = {}) {
  if (resetting) {
    return HEAD('Resetting the demo — The Bridge', '', { wall: false }) + header('<b>DEMO</b>') + `
    <div class="rule"></div>
    <h1>Resetting the demo</h1>
    <p class="lead">Wiping every change and reseeding the fictional world. This takes a few seconds; you'll be sent back to pick someone.</p>
    <script>(function(){var gone=false,t0=Date.now();function poll(){fetch('/healthz',{cache:'no-store'}).then(function(r){if(r.ok&&(gone||Date.now()-t0>20000))location.href='/login';else setTimeout(poll,500);}).catch(function(){gone=true;setTimeout(poll,500);});}setTimeout(poll,300);})();</script>
  ` + FOOT;
  }
  return HEAD('Reset the demo — The Bridge', '', { wall: false }) + header('<b>DEMO</b>') + `
    <div class="rule"></div>
    <span class="eyebrow">Organizer</span>
    <h1>Reset the demo?</h1>
    <p class="lead">Every visitor's posts, uploads, sign-ups and changes are wiped, and the fictional world is reseeded. Everyone is signed out.</p>
    <form method="POST" action="/demo/reset"><button class="btn" type="submit">Reset now</button></form>
    <div style="height:8px"></div>
    <a class="btn ghost" href="/runs">Cancel</a>
  ` + FOOT;
}

export function logoutPage() {
  return HEAD('Sign out — The Bridge', '', { wall: false }) + header('<b>SIGN OUT</b>') + `
    <div class="rule"></div>
    <span class="eyebrow">Passwordless</span>
    <h1>Sign out?</h1>
    <p class="lead">You'll need the 6-digit code we email you to sign back in — you don't normally need to sign out.</p>
    <form method="POST" action="/logout"><button class="btn" type="submit">Sign out</button></form>
    <div style="height:8px"></div>
    <a class="btn ghost" href="/checkin">Stay signed in</a>
  ` + FOOT;
}

// One-time-link confirm page. Rendered on the GET of a magic-sign-in / claim link so a
// bare GET (email security scanners like Outlook SafeLinks auto-visit links) DOESN'T
// consume the single-use token — only the POST does. Real browsers auto-submit the form
// on load, so for a human it's still effectively one tap; a scanner (no JS execution)
// just sees the page and the token stays valid for the actual person.
export function confirmActionPage({ title, heading, sub, action, fields = {}, button = 'Continue' }) {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v == null ? '' : v))}">`).join('');
  return HEAD(`${title} — The Bridge`, '', { wall: false }) + header(`<b>${esc(title.toUpperCase())}</b>`) + `
    <div class="rule"></div>
    <span class="eyebrow">One tap</span>
    <h1>${esc(heading)}</h1>
    <p class="lead">${esc(sub)}</p>
    <form method="POST" action="${esc(action)}" id="confirmform">${hidden}
      <button class="btn" type="submit">${esc(button)}</button>
    </form>
    <script>setTimeout(function(){try{document.getElementById('confirmform').submit();}catch(e){}},60);</script>
  ` + FOOT;
}

// Minimal, safe Markdown → HTML for the static legal docs (legal/*.md). Handles the exact
// subset those files use: #/##/### headings, **bold**, *italic*, `- ` and `1. ` lists,
// `---` rules, and paragraphs. Text is HTML-escaped FIRST (defense-in-depth even though the
// source is our own trusted files), THEN inline **/* is applied to the escaped text. Scoped
// to these docs on purpose — not a general Markdown engine.
export function mdToHtml(md) {
  const escT = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => escT(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  const out = [];
  let para = [], listType = null, listItems = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushList = () => { if (listItems.length) { out.push(`<${listType}>` + listItems.map(li => '<li>' + inline(li) + '</li>').join('') + `</${listType}>`); listItems = []; listType = null; } };
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (/^#{1,3}\s/.test(line)) { flushPara(); flushList(); const lvl = line.match(/^#+/)[0].length; out.push(`<h${lvl}>` + inline(line.replace(/^#+\s/, '')) + `</h${lvl}>`); }
    else if (/^---+\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); }
    else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { flushPara(); if (listType !== 'ul') { flushList(); listType = 'ul'; } listItems.push(m[1]); }
    else if ((m = line.match(/^\s*\d+\.\s+(.*)/))) { flushPara(); if (listType !== 'ol') { flushList(); listType = 'ol'; } listItems.push(m[1]); }
    else if (line === '') { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join('\n');
}

// Legal / policy page in the app shell (privacy, terms, conduct). Public, no install wall.
export function legalPage(title, html) {
  return HEAD(`${title} — The Bridge`, '', { wall: false }) + header(`<b>${esc(title.toUpperCase())}</b>`) + `
    <div class="rule"></div>
    <div class="legal">${html}</div>
    <div class="foot" style="margin-top:24px"><a href="/">Apply</a> · <a href="/login">Sign in</a></div>
  ` + FOOT;
}

// ---------- CHECK-IN BANNER TOOL (operators) ----------
// Pick a photo → pan/zoom it inside a fixed 3:1 window → save. The window IS the banner
// crop; the client computes the source-pixel rect and posts it with the file (server crops
// to 2320×1102, 40:19). Native multipart POST — the submit handler just fills the hidden crop inputs.
const bannerCropScript = () => `<script>
(function(){
  var file=document.getElementById('bfile'), stage=document.getElementById('bstage'),
      frame=document.getElementById('bframe'), img=document.getElementById('bimg'),
      zoom=document.getElementById('bzoom'), form=document.getElementById('bform');
  if(!file||!frame)return;
  var nw=0,nh=0,cover=1,z=1,ox=0,oy=0,fw=0,fh=0;
  function apply(){ fw=frame.clientWidth; fh=frame.clientHeight;
    var scale=cover*z, dw=nw*scale, dh=nh*scale;
    ox=Math.min(0,Math.max(fw-dw,ox)); oy=Math.min(0,Math.max(fh-dh,oy));
    img.style.width=dw+'px'; img.style.height=dh+'px'; img.style.transform='translate('+ox+'px,'+oy+'px)'; }
  function fit(){ fw=frame.clientWidth; fh=frame.clientHeight; cover=Math.max(fw/nw,fh/nh); z=1; if(zoom)zoom.value=1;
    var scale=cover*z; ox=(fw-nw*scale)/2; oy=(fh-nh*scale)/2; apply(); }
  file.addEventListener('change',function(){ var f=file.files&&file.files[0]; if(!f)return;
    var url=URL.createObjectURL(f);
    img.onload=function(){ nw=img.naturalWidth; nh=img.naturalHeight; if(stage)stage.hidden=false; fit(); };
    img.src=url; });
  var drag=false,px=0,py=0;
  frame.addEventListener('pointerdown',function(e){ if(!nh)return; drag=true; px=e.clientX; py=e.clientY; try{frame.setPointerCapture(e.pointerId);}catch(_){} });
  frame.addEventListener('pointermove',function(e){ if(!drag)return; ox+=e.clientX-px; oy+=e.clientY-py; px=e.clientX; py=e.clientY; apply(); });
  function end(e){ drag=false; try{frame.releasePointerCapture(e.pointerId);}catch(_){} }
  frame.addEventListener('pointerup',end); frame.addEventListener('pointercancel',end);
  if(zoom)zoom.addEventListener('input',function(){ if(!nh)return; var old=cover*z, cx=(-ox+fw/2)/old, cy=(-oy+fh/2)/old;
    z=Number(zoom.value)||1; var ns=cover*z; ox=fw/2-cx*ns; oy=fh/2-cy*ns; apply(); });
  window.addEventListener('resize',function(){ if(nh)apply(); });
  form.addEventListener('submit',function(e){
    if(!nh){ e.preventDefault(); alert('Pick a photo first.'); return; }
    var scale=cover*z;
    document.getElementById('bcx').value=Math.max(0,Math.round(-ox/scale));
    document.getElementById('bcy').value=Math.max(0,Math.round(-oy/scale));
    document.getElementById('bcw').value=Math.round(fw/scale);
    document.getElementById('bch').value=Math.round(fh/scale);
  });
})();
</script>`;

// One-time waiver gate — shown when a member without waiver_ok tries to join ANY run's
// queue. They confirm they've signed, we set waiver_ok, and they're returned to the run.
export function waiverPage({ email, next = '/checkin', err = '', programId = 0, programName = '', guardian = false } = {}) {
  // Program variant (F6): the program's OWN waiver — no club QR block (that's the shared
  // document), and a guardian consent section when the program requires it for this minor.
  const guardianBlock = guardian ? `
      <div class="subhead" style="margin-top:14px">Parent / guardian consent</div>
      <p class="tally-note" style="margin:4px 0 8px">This player is under 18, so a parent or guardian completes this part.</p>
      <label>Guardian name<input name="guardian_name" maxlength="60" required autocomplete="off"></label>
      <label>Guardian phone<input name="guardian_phone" maxlength="30" inputmode="tel" required autocomplete="off"></label>
      <label>Guardian email<input name="guardian_email" type="email" required autocomplete="off"></label>
      <label class="check"><input type="checkbox" name="guardian_agree" value="1" required><span>I am this player's parent or guardian and I consent to their participation.</span></label>` : '';
  return HEAD('Waiver — The Bridge', '', { wall: false }) + header(`<b>WAIVER</b>${esc(email)}`, '') + `
    <div class="rule"></div>
    <span class="eyebrow">One-time — before your first check-in</span>
    <h1>${programName ? `Sign the ${esc(programName)} waiver` : 'Sign the waiver first'}</h1>
    <p class="lead">${programName
      ? `${esc(programName)} has its own waiver${guardian ? ' and, for players under 18, a parent or guardian’s consent' : ''}. It's a one-time step for this program. No waiver, no play.`
      : `Before you join a run, you need to complete the waiver. It's a one-time step — sign it once and you won't be asked again. No waiver, no play.`}</p>
    ${err ? `<div class="notice bad">${esc(err)}</div>` : ''}
    ${programId ? '' : qrBlock}
    <form method="POST" action="/waiver" class="card rail" style="margin-top:14px">
      <input type="hidden" name="next" value="${esc(next)}">
      ${programId ? `<input type="hidden" name="p" value="${Number(programId)}">` : ''}
      <label class="check"><input type="checkbox" name="agree" value="1" required><span>I've signed the waiver and agree to its terms.</span></label>
      ${guardianBlock}
      <div style="height:12px"></div>
      <button class="btn primary" type="submit">Continue →</button>
    </form>
    <div class="foot" style="margin-top:20px"><a href="${esc(next)}">← Back</a></div>
  ` + FOOT;
}

export function bannerPage({ err = '', bannerVer = '0', action = '/admin/banner', imgSrc = '/gym.jpg', back = '/checkin', bodyClass = '' } = {}) {
  const errMsg = err === 'big' ? 'That image is too large (max 14 MB).'
    : err === 'type' ? 'That file isn’t a supported image (JPG, PNG, or WebP).'
    : err === 'crop' ? 'Couldn’t read the crop area — try again.'
    : err ? 'Something went wrong processing the image. Try again.' : '';
  return HEAD('Change banner — The Bridge', bodyClass, { wall: false }) + header('<b>BANNER</b>admin', '') + `
    <div class="rule"></div>
    <span class="eyebrow">Check-in hero photo</span>
    <h1>Change the banner</h1>
    <p class="lead">Pick a photo, then <b>drag to position</b> and use the <b>slider to zoom</b>. The framed area is exactly what shows on the check-in page — a wide 3:1 banner.</p>
    ${errMsg ? `<div class="notice bad">${errMsg}</div>` : ''}

    <div class="subhead">Current</div>
    <div class="curframe"><img src="${esc(imgSrc)}?v=${esc(String(bannerVer))}" alt="Current banner"></div>

    <form method="POST" action="${esc(action)}" enctype="multipart/form-data" id="bform" class="card rail" style="margin-top:14px">
      <input type="hidden" name="cx" id="bcx"><input type="hidden" name="cy" id="bcy">
      <input type="hidden" name="cw" id="bcw"><input type="hidden" name="ch" id="bch">
      <label class="btn ghost" for="bfile" style="cursor:pointer">📷 Choose a photo</label>
      <input type="file" id="bfile" name="photo" accept="image/*" hidden>
      <div id="bstage" hidden style="margin-top:14px">
        <div id="bframe" class="cropframe"><img id="bimg" alt="" draggable="false"></div>
        <label style="margin-top:12px">Zoom</label>
        <input type="range" id="bzoom" min="1" max="4" step="0.01" value="1" style="width:100%">
        <div style="height:14px"></div>
        <button class="btn" type="submit" id="bsave">Save banner</button>
      </div>
    </form>
    ${bannerCropScript()}
    <div class="foot" style="margin-top:24px"><a href="${esc(back)}">← Back</a></div>
  ` + FOOT;
}

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
    <a class="btn" href="/admin/export/db" style="margin:0" download>⬇︎ Download database (.db)</a>
    <div class="exwarn">⚠️ The database contains <b>everything</b> — contact details, chat and direct messages. Only download it to a device you control, and store it securely. Every download is logged.</div>

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
// ---------- TEAMS BOARD — the operator's courtside surface ----------
// Design target: ONE TAP per change, thumb-sized, readable in a gym. Sides shift constantly, so
// anything requiring "select then place" is too slow. With two sides a tap needs no destination:
// tapping a player moves them to the other side. The small x benches them; a benched player taps
// back onto the shorter side.
// No swapform/fetch interception here on purpose — a full POST-redirect is more robust than an
// optimistic swap when the phone's wifi is patchy at the back of a gym.
const TEAMS_CSS = `
  .tmwrap{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}
  @media (max-width:520px){ .tmwrap{grid-template-columns:1fr 1fr;gap:8px} }
  .tmside{background:var(--card,#fff);border-radius:14px;padding:12px 10px 14px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
  .tmhead{display:flex;align-items:baseline;justify-content:space-between;margin:0 2px 8px}
  .tmhead h3{margin:0;font-size:15px;letter-spacing:.04em;text-transform:uppercase}
  .tmhead .n{font-size:26px;font-weight:800;line-height:1}
  .tmrow{display:flex;align-items:stretch;gap:6px;margin-bottom:7px}
  .tmname{flex:1;min-width:0;display:block;text-align:left;font-size:17px;font-weight:600;
    padding:13px 12px;border-radius:11px;border:1px solid rgba(34,35,29,.14);background:transparent;
    color:inherit;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tmname:active{transform:scale(.985)}
  .tmx{flex:0 0 42px;border-radius:11px;border:1px solid rgba(34,35,29,.12);background:transparent;
    color:var(--muted);font-size:17px;cursor:pointer}
  .tmempty{color:var(--muted);font-size:13px;padding:10px 2px}
  .tmbench{margin-top:14px}
  .tmbench .tmname{font-weight:500;opacity:.85}
  .tmbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
`;
export function teamsBoardPage({
  program = 1, theme = '', emoji = '', sport = '', email = '', runDate = '', dateLabel = '',
  sides = [], bench = [], basePath = '', canSync = false,
  games = false, tonight = [], fp = '', gameMinSide = 3,
  msg = '', err = '', dmUnread = 0, groupUnread = 0, groupMention = 0,
}) {
  // A player button posts only their address; the server decides where they land. Keeping the
  // destination server-side is what lets one tap mean "the other side" from either side, and
  // "the shorter side" from the bench, without the page having to know the counts.
  // `from` is the side the operator can SEE them on (blank = bench). The server refuses the move if
  // they have since been moved elsewhere, so a double-tap or a stale second phone can't silently
  // toggle a player back and forth.
  const chip = (p, from = '', benchable = true) => `
    <div class="tmrow">
      <form method="post" action="${esc(basePath)}/team/swap" style="flex:1;min-width:0;display:flex">
        <input type="hidden" name="email" value="${esc(p.email)}">
        <input type="hidden" name="from" value="${esc(String(from))}">
        <button class="tmname" type="submit" title="Move ${esc(p.name)} to the other side">${esc(p.name)}</button>
      </form>
      ${benchable ? `<form method="post" action="${esc(basePath)}/team/bench" style="display:flex">
        <input type="hidden" name="email" value="${esc(p.email)}">
        <button class="tmx" type="submit" title="Bench ${esc(p.name)}">&times;</button>
      </form>` : ''}
    </div>`;
  const side = (players, i) => `
    <div class="tmside">
      <div class="tmhead"><h3>Side ${i + 1}</h3><span class="n">${players.length}</span></div>
      ${players.length ? players.map(p => chip(p, i + 1)).join('') : '<p class="tmempty">Tap a name from the bench.</p>'}
    </div>`;
  const total = sides.reduce((n, x) => n + x.length, 0) + bench.length;
  return HEAD(`Teams — ${esc(sport)}`, 'has-tabs' + (theme ? ' ' + theme : ''))
    + header(`<b>TEAMS</b>${esc(email)}`, '', null) + `
    ${backToRuns}
    <div class="rule"></div>
    <style>${TEAMS_CSS}${games ? GAMES_CSS : ''}</style>
    <div class="phead"><h1>Teams ${esc(emoji)}</h1></div>
    <p class="psub" style="margin:-4px 0 10px;color:var(--muted)">${esc(dateLabel)} &middot; ${total} player${total === 1 ? '' : 's'} &middot; tap a name to move them across</p>
    ${msg ? `<div class="note ok">${esc(msg)}</div>` : ''}
    ${err ? `<div class="note warn">${esc(err)}</div>` : ''}
    ${games ? gamesStrip({ basePath, tonight, fp, minSide: gameMinSide, canLog: total > 0 && sides.every(x => x.length >= gameMinSide) }) : ''}
    ${total ? '' : `<div class="card"><b>Nobody on the floor yet.</b><p class="foot" style="margin:6px 0 0">${canSync
      ? 'Pull tonight&rsquo;s registered players from Planning Center below.'
      : 'Players appear here once they&rsquo;re on tonight&rsquo;s roster.'}</p></div>`}
    <div class="tmwrap">${sides.map(side).join('')}</div>
    <div class="tmbench">
      <div class="subhead">Bench &middot; ${bench.length}</div>
      <div class="card" style="padding:10px">
        ${bench.length ? bench.map(p => chip(p, '', false)).join('')
          : '<p class="tmempty" style="margin:0">Everyone&rsquo;s on a side.</p>'}
      </div>
    </div>
    <div class="tmbar">
      ${canSync ? `<form method="post" action="${esc(basePath)}/roster-sync"
        onsubmit="var b=this.querySelector('button');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Syncing…';">
        <button class="btn sm" style="width:auto" type="submit">&#8635; Sync tonight&rsquo;s roster</button></form>` : ''}
      ${total ? `<form method="post" action="${esc(basePath)}/teams/clear"
        onsubmit="return confirm('Clear both sides? Everyone goes back to the bench.');">
        <button class="btn ghost sm" style="width:auto" type="submit">Clear sides</button></form>` : ''}
    </div>
    <p class="foot" style="margin-top:14px">Tap a name to send them to the other side. Tap &times; to bench them. A benched player goes to whichever side is shorter.</p>
    ` + footWithTabs(tabNav('', { dm: dmUnread, group: groupUnread, groupMention, program }));
}
// ---------- GAME RESULTS — the strip that turns a board into a record ----------
// Sits ABOVE the sides on purpose: when a game ends the eye path is top-of-screen, tap, then
// re-mix below. Winner is one button. The score is a second, optional tap folded into a
// <details> so the zero-score path stays visually one tap — a required score is what stops
// anyone logging by week three, and an invented one is silently wrong data on a public board.
const GAMES_CSS = `
  .gmbar{padding:12px 14px;margin:0 0 12px}
  .gmwin{display:flex;flex-direction:column;gap:10px;margin:0}
  .gmbtn{width:100%;min-height:52px;font-size:17px;font-weight:650;cursor:pointer;
    border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--fg)}
  .gmbtn:hover{border-color:var(--accent)}
  .gmbtn[disabled]{opacity:.55}
  /* Two thumb-sized number pads side by side. Big text because this is filled in a gym, standing,
     by someone about to play the next game. */
  .gmscrow{display:flex;gap:10px;align-items:end}
  .gmscrow label{flex:1;font-size:12px;color:var(--muted);display:flex;flex-direction:column;gap:4px}
  .gmscrow input{width:100%;padding:12px;font-size:26px;font-weight:650;text-align:center;
    border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg)}
  .gmdash{padding-bottom:14px;color:var(--muted);font-size:20px}
  .gmton{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0 0 12px;font-size:13px;color:var(--muted)}
  .gmton form{margin:0}
  .gmton .lk{background:none;border:0;color:var(--accent);cursor:pointer;font:inherit;padding:0;text-decoration:underline}
  .gmlog{margin:0;font-size:12px;color:var(--muted)}
  .gmlog li{margin:3px 0}
`;
// One finished game, as a sentence. The roster is folded away because the only reason to open it
// is to check a snapshot looks right — which is exactly the check that catches a result logged
// AFTER the sides were re-mixed, the one failure this design cannot prevent outright.
const gameLine = (g) => `Side ${g.win} won${g.ws == null ? '' : ` ${g.ws}–${g.ls}`}`
  + ` &middot; ${g.counts[0]}v${g.counts[1]}`;

export function gamesStrip({ basePath = '', tonight = [], fp = '', canLog = true, minSide = 3 }) {
  const wins = [0, 0];
  for (const g of tonight) if (g.win >= 1 && g.win <= 2) wins[g.win - 1]++;
  const tally = tonight.length
    ? (wins[0] === wins[1] ? `Sides level ${wins[0]}–${wins[1]}`
      : `Side ${wins[0] > wins[1] ? 1 : 2} leads ${Math.max(...wins)}–${Math.min(...wins)}`)
    : '';
  const last = tonight[0];
  return (!canLog ? `
    <div class="card gmbar"><b>Not enough players on a side to log a game.</b>
      <p class="foot" style="margin:6px 0 0">Both sides need ${minSide} or more. Tonight&rsquo;s games below are
      unaffected, and Undo still works.</p></div>` : `
    <div class="card gmbar">
      <div class="subhead" style="margin:0 0 8px">Final score</div>
      <form method="post" action="${esc(basePath)}/game" class="gmwin"
        onsubmit="var b=this.querySelector('.gmbtn');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Saving…';">
        <input type="hidden" name="fp" value="${esc(fp)}">
        <div class="gmscrow">
          <label>Side 1<input name="s1" inputmode="numeric" pattern="[0-9]*" maxlength="2"
            autocomplete="off" required aria-label="Side 1 final score"></label>
          <span class="gmdash">&ndash;</span>
          <label>Side 2<input name="s2" inputmode="numeric" pattern="[0-9]*" maxlength="2"
            autocomplete="off" required aria-label="Side 2 final score"></label>
        </div>
        <button class="gmbtn" type="submit">Log this game</button>
      </form>
      <p class="foot" style="margin:8px 0 0">Whoever scored more wins it &mdash; no need to say which side.
        Move anyone who subbed in <b>before</b> you log.</p>
    </div>`)
    + (tonight.length ? `
    <div class="gmton">
      <span><b>Tonight:</b> ${tonight.length} game${tonight.length === 1 ? '' : 's'}${tally ? ' &middot; ' + tally : ''}</span>
      <span>&middot; last: ${gameLine(last)}</span>
      <form method="post" action="${esc(basePath)}/game/undo"
        onsubmit="return confirm('Remove the last game? It comes off the leaderboard too.');">
        <input type="hidden" name="id" value="${esc(String(last.id))}">
        <button class="lk" type="submit">Undo last</button></form>
      <details style="flex:1 1 100%">
        <summary style="cursor:pointer">Who was in tonight&rsquo;s games</summary>
        <ul class="gmlog" style="padding-left:18px;margin-top:6px">
          ${tonight.map(g => `<li>${gameLine(g)} &mdash; <b>won:</b> ${esc(g.sides[g.win - 1].join(', ') || '—')}
             &middot; <b>lost:</b> ${esc(g.sides[g.win === 1 ? 1 : 0].join(', ') || '—')}</li>`).join('')}
        </ul>
      </details>
    </div>` : '');
}
// The season board for a run whose games are logged from the teams board.
export function leaderboardPage({
  program = 1, theme = '', emoji = '', sport = '', email = '', basePath = '', canOperate = false,
  from = '', players = [], nights = 0, games = 0, recent = [], dateLabel = '',
  msg = '', err = '', dmUnread = 0, groupUnread = 0, groupMention = 0,
}) {
  const scored = players.some(p => p.scored > 0);
  // Point differential is shown ONLY for players who actually have a scored game. Passing null
  // renders a dash: a player nobody kept score for has NO differential, and printing "0" for them
  // would read as an even record rather than as an absence.
  const rows = players.map(p => ({ label: p.label, w: p.w, l: p.l, pd: p.scored ? p.pd : null }));
  // Standings already drop tombstones; belt-and-braces so a merge can never bury a live player's
  // record under a deleted person's address.
  const mergeOpts = players.filter(p => !/^former-[0-9a-f]+@/.test(p.email))
    .map(p => `<option value="${esc(p.email)}">${esc(p.label)} — ${esc(p.email)}</option>`).join('');
  return HEAD(`Leaderboard — ${esc(sport)}`, 'has-tabs' + (theme ? ' ' + theme : ''))
    + header(`<b>LEADERBOARD</b>${esc(email)}`, '', null) + `
    ${backToRuns}
    <div class="rule"></div>
    <style>${LADDER_CSS}${GAMES_CSS}</style>
    <div class="phead"><h1>Leaderboard ${esc(emoji)}</h1></div>
    <p class="psub" style="margin:-4px 0 10px;color:var(--muted)">
      ${games} game${games === 1 ? '' : 's'} across ${nights} night${nights === 1 ? '' : 's'} since ${esc(from)}
      &middot; most wins first, then point differential</p>
    ${msg ? `<div class="note ok">${esc(msg)}</div>` : ''}
    ${err ? `<div class="note warn">${esc(err)}</div>` : ''}
    ${players.length ? ladderTable(rows, 12, 'players') + ladderCapNote(rows, 12, 'players') : `
      <div class="card"><b>No games logged yet.</b>
        <p class="foot" style="margin:6px 0 0">Results come from the teams board &mdash; tap who won after a game
        and everyone on both sides gets credited.</p></div>`}
    ${recent.length ? `
      <div class="subhead" style="margin-top:18px">Tonight &middot; ${esc(dateLabel)}</div>
      <div class="card" style="padding:10px 14px">
        <ul class="gmlog" style="padding-left:18px;margin:0">
          ${recent.map(g => `<li>${gameLine(g)} &mdash; ${esc(g.sides[g.win - 1].join(', '))}</li>`).join('')}
        </ul>
      </div>` : ''}
    ${canOperate && players.length > 1 ? `
      <div class="subhead" style="margin-top:18px">Same person, two rows?</div>
      <div class="card">
        <p class="foot" style="margin:0 0 8px">A player who registered once without an email address and once with
          one shows up twice. Merging moves every game from the first onto the second. It refuses if
          they were ever on the same game, because then they are not the same person.</p>
        <form method="post" action="${esc(basePath)}/game/merge"
          onsubmit="return confirm('Merge these two players? This cannot be undone.');">
          <label class="lbl">Move this player<select name="from" required><option value="">Choose…</option>${mergeOpts}</select></label>
          <label class="lbl">onto this one<select name="into" required><option value="">Choose…</option>${mergeOpts}</select></label>
          <button class="btn sm" style="width:auto;margin-top:8px" type="submit">Merge</button>
        </form>
      </div>` : ''}
    <p class="foot" style="margin-top:14px">Every player on the winning side gets the win, and the margin goes to
      everyone who was on the floor for it. Sides are taken from the teams board at the moment the score is logged,
      so move anyone who subbed in <b>before</b> you log it.</p>
    ` + footWithTabs(tabNav('', { dm: dmUnread, group: groupUnread, groupMention, program }));
}
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
