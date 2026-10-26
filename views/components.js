// views/components.js — the shared building blocks every page draws from: icons, avatars (the
// map lib/media.js hands over via setAvatarMap), badges, the announcements bell, the tab bar and
// nav buttons (program paths via setProgramMeta), share/copy buttons, the waiver QR, onboarding
// cards (install steps, sign-in code, first-run tour, welcome modal) and follow buttons.
import { AVATAR_SEED_EMAIL, WAIVER_URL } from '../config.js';
import { esc, fmtWhen } from './util.js';

// The picture-by-picture iOS install steps, shared by the install wall (views shell) and the
// sign-in guide (installSteps).
const IOS_STEPS = `<ol class="vsteps">
  <li><span class="vpic"><svg viewBox="0 0 32 32" fill="none" stroke="#E86A33" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4.5v15"/><path d="M11 9.5l5-5 5 5"/><path d="M10 14H7.5A1.5 1.5 0 0 0 6 15.5v10A1.5 1.5 0 0 0 7.5 27h17a1.5 1.5 0 0 0 1.5-1.5v-10A1.5 1.5 0 0 0 24.5 14H22"/></svg></span><div class="vtxt"><b>1. Tap Share</b><span>The box with an ↑ arrow, at the bottom of Safari. Don't see it? Tap <b>•••</b> (bottom-right) then <b>Share</b>.</span></div></li>
  <li><span class="vpic"><svg viewBox="0 0 32 32" fill="none" stroke="#E86A33" stroke-width="2.2" stroke-linecap="round"><rect x="6" y="6" width="20" height="20" rx="6"/><path d="M16 11.5v9M11.5 16h9"/></svg></span><div class="vtxt"><b>2. Add to Home Screen</b><span><b>Scroll down</b> past the row of apps and tap it — tap <b>More</b> / <b>Edit Actions</b> if you don't see it.</span></div></li>
  <li><span class="vpic"><svg viewBox="0 0 32 32"><rect x="4" y="4" width="24" height="24" rx="7" fill="#2C6B66"/><text x="16" y="21" font-size="11" font-weight="800" fill="#fff" text-anchor="middle" font-family="Arial,Helvetica,sans-serif">AR</text></svg></span><div class="vtxt"><b>3. Tap “Add”</b><span>A screen titled <b>Add to Home Screen</b> pops up — tap <b>Add</b> (top-right). Then open <b>Bridge Runs</b> from your Home Screen and enter your code.</span></div></li>
</ol>`;

// Two-letter initials for avatar fallbacks.
const initials = (name = '') => name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';

// PHASE 2: general per-player photo upload. For now a single seeded avatar
// (Daniel, the host) maps by email → /avatars/daniel.jpg; everyone else falls
// back to initials. AVATAR_SEED_EMAIL unset → no seeded avatar at all.
const AVATAR_SEED = AVATAR_SEED_EMAIL.toLowerCase();
// Uploaded-photo registry: lowercased email -> { file, v }. lib/media.js rebuilds this
// (from applicants.avatar) at boot and after any avatar/email mutation, so avatarUrl
// can resolve email -> photo with NO per-call db access and NO change to avatarInner's
// signature across the ~10 render sites (roster, host card, inbox, chat, /u/:id, …).
// v = the file's mtime ms — a cache-buster so a REPLACED photo shows immediately
// despite the 7-day static cache (the filename also changes per upload, so this is
// belt-and-suspenders). A DB-backed photo takes precedence over the daniel.jpg seed.
let AVATAR_MAP = new Map();
export function setAvatarMap(m) { AVATAR_MAP = (m instanceof Map) ? m : new Map(); }
const avatarUrl = (email = '') => {
  const rec = AVATAR_MAP.get(String(email).toLowerCase());
  if (rec) return `/avatars/${encodeURIComponent(rec.file)}?v=${encodeURIComponent(rec.v)}`;
  return AVATAR_SEED && String(email).toLowerCase() === AVATAR_SEED ? '/avatars/daniel.jpg' : '';
};
// Render an avatar: uploaded/seeded photo if present, else initials on a teal disc.
const avatarInner = (email, name) => {
  const url = avatarUrl(email);
  return url ? `<img src="${esc(url)}" alt="">` : esc(initials(name));
};
// Public avatar-URL resolver (single source of truth) — routes/chat.js reuses this for
// the /players/search JSON so the mention dropdown shows the same photo the chat does.
// Returns '' when the person has no photo (client falls back to initials).
export function avatarUrlFor(email) { return avatarUrl(email); }

// Group (Run Chat) glyph — a small three-person mark, drawn white to sit on the
// teal avatar disc. Reused by the check-in card, the inbox pin, and the chat bar.
const GROUP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:60%;height:60%"><circle cx="9" cy="9" r="3"/><path d="M3.5 19c0-3 2.5-4.5 5.5-4.5s5.5 1.5 5.5 4.5"/><path d="M16 6.2a3 3 0 0 1 0 5.6"/><path d="M17.5 14.6c2.3.4 4 1.8 4 4.4"/></svg>`;

// Safeguarding: a loud red "Minor" chip for anyone under 18 (known DOB). Orthogonal to
// role — shown IN ADDITION to it — so the community can see it at a glance. The under-18
// flag is computed server-side (isMinor) and passed in; the view never guesses age.
const MINOR_BADGE = '<span class="bdg minor" title="Under 18">⚠ Minor</span>';
// In LISTS (rosters, who's-going, chat members) minors get just a small red asterisk after the
// name — everyone sees it for awareness. The full "Minor" tag + all other roles live on the profile.
const MINOR_STAR = '<span class="minast" title="Under 18" aria-label="under 18">*</span>';

// Quick-look profile popup — SHARED include for the chat pages (the check-in + run pages carry
// their own inline copy beside the who's-going sheet). Tapping a sender name opens the card in
// place; demo senders resolve through the demo card route.
const pvSheet = () => `<div id="pvwrap" class="wgwrap pvwrap"><div class="wgscrim" onclick="pvClose()"></div>
      <div class="wgsheet pvsheet" role="dialog" aria-modal="true" aria-label="Player profile">
        <div class="wgsheet-h"><b>Profile</b><button class="wgx" type="button" onclick="pvClose()" aria-label="Close">${IC_CLOSE}</button></div>
        <div class="wgsheet-b pvbody"><div class="pcload">Loading…</div></div>
      </div></div>`;
const pvScript = () => `<script>
      window.pvOpen=function(id){var w=document.getElementById('pvwrap');if(!w)return;var b=w.querySelector('.pvbody');if(b)b.innerHTML='<div class="pcload">Loading…</div>';w.classList.add('open');document.body.style.overflow='hidden';
        if(window.fetch)fetch('/u/'+id+'/card',{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.ok?r.text():Promise.reject();}).then(function(h){if(b)b.innerHTML=h;}).catch(function(){if(b)b.innerHTML='<div class="pcload">Couldn\\u2019t load that profile.</div>';});};
      window.pvOpenDemo=function(i){var w=document.getElementById('pvwrap');if(!w)return;var b=w.querySelector('.pvbody');if(b)b.innerHTML='<div class="pcload">Loading…</div>';w.classList.add('open');document.body.style.overflow='hidden';
        if(window.fetch)fetch('/demo/u/'+i+'/card',{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.ok?r.text():Promise.reject();}).then(function(h){if(b)b.innerHTML=h;}).catch(function(){if(b)b.innerHTML='<div class="pcload">Couldn\\u2019t load that profile.</div>';});};
      window.pvClose=function(){var w=document.getElementById('pvwrap');if(!w)return;w.classList.remove('open');var wg=document.getElementById('wgwrap');if(!(wg&&wg.classList.contains('open')))document.body.style.overflow='';};
    </script>`;

// Role badges live ONLY on profiles now, and only an ADMIN viewer sees them (owner rule:
// lists stay clean; roles aren't public). The red Minor tag is the one exception — every
// viewer sees it on a profile (awareness), and lists show the MINOR_STAR asterisk.

// Bottom tab bar — Check-in / Roster / Profile. Shown to every signed-in
// approved player (admins too) on the player-facing pages. Operator pages keep
// opsNav at the top instead.
const ICON = {
  runs: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="#8a8474" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/></svg>',
  checkin: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="#8a8474" stroke-width="2"><path d="M3 11l9-7 9 7"/><path d="M5 10v9h14v-9"/></svg>',
  chat: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="#8a8474" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H8l-4 4z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01"/></svg>',
  profile: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="#8a8474" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>',
};
// Messaging affordance icons — inline SVGs matching the ICON stroke style
// (2px round-joined strokes, currentColor). Replace the old raw glyphs
// (↩ ☺ 🗑 ↑ ‹ ✕) so the reply/react/delete/send/back/close controls read as
// crisp icons inside 32px circular tap areas (see .mi CSS).
const mi = (inner, sz = 17) => `<svg class="mi" viewBox="0 0 24 24" width="${sz}" height="${sz}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const IC_REPLY = mi('<path d="M9 17l-5-5 5-5"/><path d="M4 12h11a4 4 0 0 1 4 4v2"/>');
const IC_TRASH = mi('<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6.5 7l1 12.5h9L17.5 7"/>');
const IC_PIN = mi('<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z"/>');
const IC_SEND = mi('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>', 20);
const IC_BACK = mi('<path d="M15 18l-6-6 6-6"/>', 22);
const IC_CLOSE = mi('<path d="M6 6l12 12M18 6L6 18"/>', 16);
const IC_COPY = mi('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>', 18);
// Save/download — arrow into a tray (used by the long-press "Save" action + lightbox).
const IC_SAVE = mi('<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/>', 18);
// Attach (＋) — opens the photo/sticker menu left of the composer textarea.
const IC_PLUS = mi('<path d="M12 5v14"/><path d="M5 12h14"/>', 22);
const IC_PHOTO = mi('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 16l-5-5-8 8"/>', 19);
const IC_STICKER = mi('<path d="M14.5 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8l6-6V5a2 2 0 0 0-2-2z"/><path d="M14 21v-4a2 2 0 0 1 2-2h4"/><path d="M8.5 12s1 1.4 3.5 1.4S15.5 12 15.5 12"/><path d="M9 8.5h.01M15 8.5h.01"/>', 19);
// Voice message: mic (attach menu + record), stop (square), play (triangle) for preview.
const IC_MIC = mi('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>', 19);
const IC_VIDEO = mi('<rect x="3" y="6" width="12" height="12" rx="2"/><path d="M15 10l6-3v10l-6-3z"/>', 19);
const IC_PLAY = mi('<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>', 18);
const IC_PAUSE = mi('<rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none"/>', 18);

// ---------- MASTHEAD NOTIFICATION BELL ----------
// A clean bell in the app's inline-SVG stroke style (currentColor = ink, teal on the
// dot). Sits left of the .when block on every authenticated page; tapping it opens the
// announcements bottom-sheet (reuses .wgwrap/.wgsheet/.wgscrim). The orange .belldot
// shows only when the viewer has an unseen announcement.
const BELL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`;
// Announcements panel wiring. Own annOpen/annClose (no collision with the who's-going
// wgOpen/wgClose or the members memOpen/memClose). Opening marks-read (POST, keep-alive)
// and removes the dot immediately; the next /poll tick reconciles it against the server.
// Dismiss on scrim-tap (inline) or Esc (bound once). Close plays the shared slide-down.
const ANN_JS = `
  window.annOpen=function(){var w=document.getElementById('annwrap');if(!w)return;w.classList.add('open');document.body.style.overflow='hidden';
    var d=document.querySelector('.bellbtn .belldot');if(d&&d.parentNode)d.parentNode.removeChild(d);
    try{fetch('/announcements/seen',{method:'POST',headers:{'X-Requested-With':'fetch'},credentials:'same-origin',keepalive:true});}catch(e){}};
  window.annClose=function(){var w=document.getElementById('annwrap');if(!w)return;var sh=w.querySelector('.wgsheet');
    var still=document.documentElement.classList.contains('noanim')||(window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches);
    if(sh&&!still){sh.classList.add('closing');setTimeout(function(){w.classList.remove('open');sh.classList.remove('closing');document.body.style.overflow='';},200);}
    else{w.classList.remove('open');document.body.style.overflow='';}};
  if(!window.__annBound){window.__annBound=true;document.addEventListener('keydown',function(e){if(e.key==='Escape'){var w=document.getElementById('annwrap');if(w&&w.classList.contains('open'))window.annClose();}});}`;
// Swipe-left-to-clear for the announcements panel — available to EVERY viewer (a personal
// dismiss: it hides the row from THIS user's panel only; the announcement stays live for
// everyone else). iOS-mail behaviour on each `.annrow.swipeable`: a mostly-HORIZONTAL drag
// left slides the `.annrow-c` foreground over a red `.anndel` "Clear" action; releasing
// past OPEN_AT rests it revealed (tap Clear to dismiss), past DEL_AT dismisses immediately,
// otherwise it snaps back. A vertical drag is left to the panel's native scroll (row has
// touch-action:pan-y; we only preventDefault once a drag is judged horizontal), and a plain
// tap never dismisses. Clear = fetch(POST .../dismiss) → collapse the row out + remove it;
// the next /poll tick reconciles the bell dot.
const ANN_SWIPE_JS = `
  (function(){
    if(window.__annSwipeBound) return; window.__annSwipeBound=true;
    var REVEAL=86, OPEN_AT=42, DEL_AT=150;
    var openRow=null, active=null, start=null, cur=0, decided=false, horizontal=false;
    function fg(r){ return r.querySelector('.annrow-c'); }
    function setX(r,x,anim){ var c=fg(r); if(!c) return; if(anim){ r.classList.remove('dragging'); } else { r.classList.add('dragging'); } c.style.transform = x ? 'translateX('+x+'px)' : ''; }
    function closeIt(r){ if(!r) return; setX(r,0,true); r.classList.remove('open'); if(openRow===r) openRow=null; }
    function openIt(r){ setX(r,-REVEAL,true); r.classList.add('open'); openRow=r; }
    function maybeEmpty(){ var b=document.querySelector('#annwrap .wgsheet-b'); if(b && !b.querySelector('.annrow')){ b.innerHTML='<div class="annempty">No announcements yet.</div>'; } }
    function collapse(r){
      var h=r.offsetHeight; r.style.maxHeight=h+'px'; r.classList.add('removing'); void r.offsetHeight;
      r.style.maxHeight='0px'; r.style.opacity='0';
      var done=function(){ if(r.parentNode) r.parentNode.removeChild(r); maybeEmpty(); };
      r.addEventListener('transitionend',done,{once:true}); setTimeout(done,450);
    }
    function dismiss(r){
      var id=r.getAttribute('data-annid'); if(!id) return;
      if(openRow===r) openRow=null; r.style.pointerEvents='none';
      fetch('/announcements/'+encodeURIComponent(id)+'/dismiss',{method:'POST',headers:{'X-Requested-With':'fetch'},credentials:'same-origin'})
        .then(function(res){ if(res.status===204||res.ok){ collapse(r); } else { throw 0; } })
        .catch(function(){ r.style.pointerEvents=''; closeIt(r); });
    }
    document.addEventListener('pointerdown',function(e){
      var r=e.target.closest && e.target.closest('.annrow.swipeable');
      if(openRow && openRow!==r){ closeIt(openRow); }
      if(!r) return;
      if(e.target.closest('.anndel')) return;   // the revealed Delete: handled on click
      active=r; start={x:e.clientX,y:e.clientY}; cur=0; decided=false; horizontal=false;
    },true);
    document.addEventListener('pointermove',function(e){
      if(!active||!start) return;
      var dx=e.clientX-start.x, dy=e.clientY-start.y;
      if(!decided){ if(Math.abs(dx)<6 && Math.abs(dy)<6) return; decided=true; horizontal=Math.abs(dx)>Math.abs(dy); if(horizontal){ active.classList.add('dragging'); } }
      if(!horizontal) return;                   // vertical drag → leave it to native scroll
      e.preventDefault();
      var base=(openRow===active)?-REVEAL:0;
      var x=base+dx; if(x>0) x=x*0.2; var lim=-DEL_AT-40; if(x<lim) x=lim;
      cur=x; var c=fg(active); if(c) c.style.transform='translateX('+x+'px)';
    },{passive:false});
    function end(){
      if(!active) return; var r=active, wasH=horizontal; active=null; start=null;
      if(!wasH){ if(openRow===r) closeIt(r); return; }   // a tap on an open row closes it
      if(cur<=-DEL_AT){ dismiss(r); } else if(cur<=-OPEN_AT){ openIt(r); } else { closeIt(r); }
    }
    document.addEventListener('pointerup',end,true);
    document.addEventListener('pointercancel',function(){ if(active){ var r=active; active=null; start=null; if(openRow!==r) closeIt(r); } },true);
    document.addEventListener('click',function(e){
      var btn=e.target.closest && e.target.closest('.anndel'); if(!btn) return;
      var r=btn.closest('.annrow.swipeable'); if(r){ e.preventDefault(); dismiss(r); }
    },true);
  })();`;
// Build the bell button + the panel sheet from a viewer's announcement state. Returns
// {btn, sheet}; both '' when `ann` is absent (public/non-approved pages skip the bell).
// Every dynamic field — body AND author name — is esc()'d (XSS-safe).
function annBell(ann) {
  if (!ann) return { btn: '', sheet: '' };
  const dot = ann.unread ? '<span class="belldot" aria-hidden="true"></span>' : '';
  const btn = `<button class="bellbtn" type="button" onclick="annOpen()" aria-label="Announcements">${BELL_ICON}${dot}</button>`;
  const items = ann.items || [];
  // EVERY viewer can swipe-to-clear their OWN panel (a personal dismiss — the row stays
  // live for everyone else), so every row is swipeable: a foreground .annrow-c slides over
  // a red .anndel "Clear" action, keyed by data-annid. Body AND author name are esc()'d.
  const rows = items.length
    ? items.map(m => {
        const who = esc(m.authorName || m.author || '');
        const meta = `<div class="annrow-m">${who ? who + ' · ' : ''}${esc(fmtWhen(m.at))}</div>`;
        const body = `<div class="annrow-b">${esc(m.body)}</div>`;
        return `<div class="annrow swipeable" data-annid="${Number(m.id)}"><button type="button" class="anndel" aria-label="Clear announcement" tabindex="-1">Clear</button><div class="annrow-c">${body}${meta}</div></div>`;
      }).join('')
    : '<div class="annempty">No announcements yet.</div>';
  const sheet = `
    <div id="annwrap" class="wgwrap">
      <div class="wgscrim" onclick="annClose()"></div>
      <div class="wgsheet" role="dialog" aria-modal="true" aria-label="Announcements">
        <div class="wgsheet-h"><b>Announcements</b><button class="wgx" type="button" onclick="annClose()" aria-label="Close">${IC_CLOSE}</button></div>
        <div class="wgsheet-b">${rows}</div>
      </div>
    </div>
    <script>${ANN_JS}${ANN_SWIPE_JS}</script>`;
  return { btn, sheet };
}

// current = active tab key. Three tabs: Check-in · Chat · Profile. Per-tab unread
// counts: the Chat tab carries the group (Run Chat) unread; the Profile tab carries
// the 1:1 DM unread (host DMs live in Profile now). Either hides at 0. Callers pass
// { dm, group }. Pass a non-matching `current` (e.g. '') to highlight none.
// `program` makes the Chat tab run-aware: program 2 (pickleball) points Chat at
// /pickleball/chat and its badge reflects the counts the caller passes; program 1
// (default, basketball) points at /chat. The caller always passes the counts (group/
// groupMention) for whichever chat the tab points to, so the badge logic stays uniform.
// Program presentation metadata (id → { chat, season, seasonLabel }) injected by the server
// at boot (setProgramMeta) so views render run-aware links WITHOUT hardcoding paths — the
// server's PROGRAMS registry is the single source of truth. The seed default keeps program 1
// working if a render somehow beats hydration (it never does at request time).
let PROGRAM_META = { 1: { chat: '/chat', season: '/season', seasonLabel: 'Season board' } };
// Why a join POST didn't seat you: the join handlers redirect back with ?joinerr=<code> and the
// run page shows one line. Unknown codes render nothing (the param is user-controlled).
const JOIN_ERRORS = {
  notapproved: "You need to be an approved member of this run before you can check in.",
  suspended: "Your check-in is paused, so you weren't added. Reach out to the host if you think this is a mistake.",
  cancelled: "This week's run is cancelled, so check-in is off.",
  locked: 'Check-in is locked for this run. The host can still add you at the door.',
  closed: "Check-in isn't open yet. Try again once it opens.",
  prereg: 'The early-access spots are full. Check-in opens to everyone later.',
  full: 'The run and its waitlist are full, so nobody new can join.',
};
export function joinErrNotice(code) {
  const msg = Object.hasOwn(JOIN_ERRORS, code) ? JOIN_ERRORS[code] : '';
  return msg ? `<div class="notice bad" style="margin-top:12px">${msg}</div>` : '';
}

export function setProgramMeta(meta) { if (meta && meta[1]) PROGRAM_META = meta; }
const progMeta = (id) => PROGRAM_META[id] || PROGRAM_META[1];
// data-tab lets the live poll patch the right tab regardless of its (varying) href; the Chat
// tab also carries data-chat-program so the poll patcher knows which program's unread to show.
const tabNav = (current, { dm = 0, group = 0, groupMention = 0, program = 1 } = {}) => {
  const tab = (href, key, label, extra = '', attrs = '', cls = '') => `<a href="${href}" data-tab="${key}"${attrs} class="tab${current === key ? ' on' : ''}${cls}">${ICON[key]}${label}${extra}</a>`;
  // groupMention > 0 → a DISTINCT "@" marker (teal) instead of the plain orange count,
  // so a mentioned player can tell "you were tagged" from ordinary unread at a glance.
  const badge = (n, mention = 0) => n > 0
    ? `<span class="tabbadge${mention > 0 ? ' mention' : ''}">${mention > 0 ? '@' : ''}${n > 9 ? '9+' : n}</span>`
    : '';
  // program === 0 → the viewer has joined no run: the Chat tab is LOCKED (greyed + a lock glyph,
  // still tappable → the "join a run first" prompt at /chat/locked). It carries no data-chat-program,
  // so the live badge patcher leaves it alone. Otherwise the tab is run-aware: its href + which
  // program's unread it shows both come from the registry, so a new run needs no branch here.
  const chatLocked = program === 0;
  const chatHref = chatLocked ? '/chat/locked' : progMeta(program).chat;
  const chatExtra = chatLocked ? '<span class="tablock" aria-hidden="true">🔒</span>' : badge(group, groupMention);
  const chatAttrs = chatLocked ? ' data-chat-locked="1"' : ` data-chat-program="${program}"`;
  return `<nav class="tabs"><div class="tabrow">
    ${tab('/runs', 'runs', 'Runs')}
    ${tab(chatHref, 'chat', 'Chat', chatExtra, chatAttrs, chatLocked ? ' locked' : '')}
    ${tab('/profile', 'profile', 'Profile', badge(dm))}
  </div></nav>`;
};

// Operator page-switcher — shows on the check-in / council / people pages so
// admins & team can jump between them. Manage People is admin-only, so team
// members don't get that button. Hidden entirely for regular players.
const opsNav = (current, { isAdmin = false, isTeam = false, isCouncil = false } = {}) => {
  if (!isAdmin && !isTeam && !isCouncil) return '';
  const item = (href, label, key) => `<a href="${href}"${current === key ? ' class="on"' : ''}>${label}</a>`;
  return `<nav class="opsnav">
    ${item('/checkin', 'Check-in', 'checkin')}
    ${item('/admin', 'Council', 'admin')}
    ${isAdmin ? item('/admin/people', 'People', 'people') : ''}
    ${isAdmin ? item('/admin/programs', 'Programs', 'programs') : ''}
  </nav>`;
};

// Big orange Back button — a FIXED destination, deliberately NOT history.back() (owner decision
// 2026-08-04): two pages that link to each other turn history-back into a ping-pong (hub → run →
// chat → back-to-run → Back landed you in CHAT again, "the most recent page", not the page
// above). Back now always climbs the hierarchy: run pages → the Runs hub, admin tools → People.
// The chat rooms' own chevron covers chat → run. Anchor (not button) so the SPA router
// intercepts it (.backruns[href] is in the intercept list) for a smooth swap.
const backBtn = (dest = '/runs') => `<a class="backruns" href="${dest}" aria-label="Go back" style="display:inline-flex;align-items:center;gap:6px;background:#E86A33;color:#fff;font-family:inherit;font-weight:800;font-size:15px;line-height:1;padding:11px 18px 11px 15px;border:none;border-radius:13px;cursor:pointer;margin:14px 0 2px;box-shadow:0 3px 10px rgba(232,106,51,.32);-webkit-tap-highlight-color:transparent;text-decoration:none"><span style="font-size:22px;margin-top:-2px">‹</span>Back</a>`;
const backToRuns = backBtn('/runs');

// Copy-to-clipboard button for a readonly <input>/<textarea> by id. Shows
// "Copied ✓" briefly, then restores the label. Used on the people + share pages.
const copyBtn = (id, label) => `<button class="btn sm" type="button" onclick="const t=document.getElementById('${id}');t.select();navigator.clipboard.writeText(t.value);this.textContent='Copied ✓';setTimeout(()=>this.textContent='${label}',1500)">${label}</button>`;
// Native OS share sheet for the value of readonly input #id — hidden unless the browser
// supports navigator.share (iOS Safari does, including standalone). The copy button
// stays as the universal fallback. Pair with shareScript() on the same page.
const shareBtn = (id) => `<button class="btn ghost sm sharebtn" type="button" data-share="${id}" hidden>Share…</button>`;
const shareScript = () => `<script>
  (function(){
    if(navigator.share){var b=document.querySelectorAll('.sharebtn');for(var i=0;i<b.length;i++)b[i].hidden=false;}
    if(window.__shareBound)return; window.__shareBound=1;
    document.addEventListener('click',function(e){
      var btn=e.target&&e.target.closest&&e.target.closest('.sharebtn'); if(!btn||!navigator.share)return;
      var el=document.getElementById(btn.getAttribute('data-share')); if(!el)return;
      e.preventDefault(); navigator.share({url:el.value}).catch(function(){});
    });
  })();
</script>`;

// The external waiver form: WAIVER_URL (config.js). Unset → no QR/link section anywhere.

const qrBlock = WAIVER_URL ? `<div class="qr">
  <img src="/waiver-qr.svg" alt="Waiver QR code">
  <div class="t"><b>Sign the waiver</b>
  <p>Scan, or <a href="${esc(WAIVER_URL)}" target="_blank" rel="noopener">tap here to open it</a>. No waiver, no play.</p></div>
</div>` : '';

const locationBlock = `<div class="loc">
  <span class="loc-h">Where</span>
  <span class="loc-a">The Bridge Church, 5440 16th Ave, Markham L3P 3J3 — <b>enter at the back</b>. <a class="loc-map" href="https://www.google.com/maps/search/?api=1&query=5440+16th+Avenue+Markham+ON+L3P+3J3" target="_blank" rel="noopener">Maps →</a></span>
</div>`;

// Add-to-Home-Screen prompt — shown on the "link sent" login state and the
// status page. A tiny inline script hides it once the app is already installed
// (opened in standalone / apple web-app mode) so installed users never see it.
const homeScreenCard = `
  <div class="card a2hs" id="a2hs">
    <span class="eyebrow">Get the app</span>
    <h3>Add The Bridge to your home screen</h3>
    <div class="steps">
      <div class="step"><span class="plat">iOS</span><span>Tap <b>Share</b> → <b>Add to Home Screen</b></span></div>
      <div class="step"><span class="plat">Android</span><span>Tap <b>⋮</b> → <b>Install app</b></span></div>
    </div>
    <p class="sub">Stay signed in and ensure full app functionality.</p>
  </div>
  <script>(function(){var el=document.getElementById('a2hs');if(!el)return;if((window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||navigator.standalone){el.style.display='none';}})();</script>`;

// The 6-digit code entry — the sign-in path that works INSIDE the installed app. Shown
// on the "check your email" pages alongside the magic link (link = on a computer, code
// = in the app). autocomplete=one-time-code lets iOS autofill it from the email.
const codeEntryCard = (email, next = '', codeError = '', devCode = '') => `
  <div class="card rail" style="margin-top:14px">
    <span class="eyebrow">In the app?</span>
    <h3 style="margin:2px 0 8px">Enter your 6-digit code</h3>
    ${codeError ? `<div class="notice warn">${esc(codeError)}</div>` : ''}
    ${devCode ? `<div class="notice warn">DEV MODE code: <b>${esc(devCode)}</b></div>` : ''}
    <form method="POST" action="/login/code">
      <input type="hidden" name="email" value="${esc(email)}">
      <input type="hidden" name="next" value="${esc(next)}">
      <input class="codein" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="000000" aria-label="6-digit code" required>
      <div style="height:12px"></div>
      <button class="btn" type="submit">Sign in</button>
    </form>
  </div>`;

// First-time setup guide shown on the "check your email" pages. Numbered install →
// open → enter-code steps. Self-hides when already running as the installed app
// (standalone), and tailors the iOS wording when the browser isn't Safari.
// First-run coach-mark tour: shown ONCE after sign-in (localStorage bridgeTourV1). Spot-
// lights each key control with a tooltip, then offers to enable notifications. Included
// on the check-in page (the landing surface). Starts after the splash clears.
const firstRunTour = `
  <div id="tour" hidden>
    <div id="tourcatch"></div>
    <div id="tourhole" style="display:none"></div>
    <div id="tourtip">
      <div id="tourttl"></div>
      <div id="tourtxt"></div>
      <div id="tourbtns"><button type="button" id="tourskip">Skip</button><div id="tourdots"></div><button type="button" id="tournext" class="btn sm">Next</button></div>
    </div>
  </div>
  <script>
  (function(){
    var tour=document.getElementById('tour'); if(!tour||tour.__bound) return; tour.__bound=1; // bind per fresh #tour node (survives router swaps)
    var KEY='bridgeTourV1';
    var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches;
    function supported(){ return !!(window.__pushEligible&&window.__pushEligible()); }
    // Operator steps (Council / open-close / guest / announce / auto-renew) carry selectors
    // that exist ONLY for team+admin — the filter below drops any step whose element isn't on
    // the page, so operators get these extra spotlights automatically and players never do.
    // Steps carry an optional path (the page they run on) so the tour can WALK INTO Council
    // (/admin) and People (/admin/people) and spotlight controls there. op = team+admin only,
    // adm = admin only — filtered by whether the matching ops-nav link exists (deterministic
    // per user, so the step list + indices are identical on every page so resume aligns).
    var STEPS_ALL=[
      // ---- everyone ----
      {path:'/runs',ttl:"Welcome 👋",txt:"Here’s a quick tour of the app."},
      {path:'/runs',sel:'.jc',ttl:"Pick your run",txt:"These are the runs — basketball, pickleball and more. Each has its own check-in, chat and season board. Tap one to open it."},
      {path:'/runs',ttl:"Play with friends 🤝",txt:"Follow other players — once you follow each other, you’ll see who’s going right on each run’s card, and you can check in together as a group."},
      {path:'/checkin',sel:'[data-tour="join"]',ttl:"Grab your spot",txt:"Tap “I’m in” each week to claim a spot. Spots are limited — first come, first served. If it’s full you join the waitlist and move up automatically when a spot opens."},
      {path:'/checkin',sel:'.tabs a[href="/chat"]',ttl:"Run chat",txt:"Every run has its own chat — photos, voice notes, @mentions. It unlocks once you’ve joined that run. On the team? Press & hold a message to Pin it."},
      {path:'/checkin',sel:'.tabs a[href="/profile"]',ttl:"Your profile & friends",txt:"Your stats, photo and settings live here — plus Friends, where you follow players and see their games."},
      {path:'/checkin',sel:'.bellbtn',ttl:"Announcements",txt:"Updates from the host show up here."},
      // ---- operators: team + admin (op) ----
      {path:'/checkin',sel:'[data-tour="ops-run"]',op:1,ttl:"Run the check-in",txt:"Open or close check-in by hand — it also auto-opens ahead of each run and locks shortly before it starts. Tap the scoreboard’s “Who’s going” to remove or bump players."},
      {path:'/checkin',sel:'[data-tour="rundate"]',op:1,ttl:"Run day, cancel & season",txt:"Operator tools: move this week’s run to another date or time, cancel a week, or set when the season starts. Players get an announcement automatically."},
      {path:'/checkin',sel:'.bannedit',op:1,ttl:"Change the banner",txt:"Swap the run’s banner photo and crop it right here in the app."},
      {path:'/checkin',sel:'.hguest summary',op:1,ttl:"Add a guest",txt:"Drop in a last-minute walk-on by name — works even after check-in locks."},
      {path:'/checkin',sel:'.announce-compose summary',op:1,ttl:"Announce to everyone",txt:"Post an update that pushes to the whole run’s phones (and emails those who opted in)."},
      {path:'/checkin',sel:'.arpill',op:1,ttl:"Your guaranteed spot",txt:"As team you’re auto-added each week. Toggle this to sit out a week — it never affects your standing."},
      {path:'/checkin',ttl:"Turn on notifications",txt:"Get a ping for spot offers, announcements and @mentions — never miss out. Want a buzz for every chat message too? Flip that on under Profile → Chat notifications.",notif:1},
      // ---- admin-only (adm): council + people + data ----
      {path:'/admin',op:1,sel:'[data-tour="council"]',ttl:"Vote players in",txt:"New applicants show up here — tap Approve or Reject on each. 3 approvals lets someone in; 3 rejects turns them away."},
      {path:'/admin/people',adm:1,sel:'[data-tour="people"]',ttl:"Manage people",txt:"Search anyone to suspend, remove, or change their role (Team / Pillar / Host). Up top, Share the sign-up QR to invite new players."},
      {path:'/admin/people',adm:1,sel:'[data-tour="export"]',ttl:"Export & backup",txt:"Export attendance to a spreadsheet — open it in Google Sheets or import into Planning Center — or download a full backup of the whole database. Every download is logged."},
      // Last (shown only to players who haven't signed yet, via role.waiver): the "Sign now" button
      // takes them to the waiver — so they're cleared BEFORE they ever open a run's check-in.
      {path:'/checkin',waiver:1,ttl:"Last thing — your waiver",txt:"Sign the waiver once and you're cleared to join any run. It takes about 20 seconds — let's do it now so you're ready when a run opens."}
    ];
    var STEPS=[], i=0, running=0, snapNext=true, hole=document.getElementById('tourhole'), tip=document.getElementById('tourtip'),
        ttl=document.getElementById('tourttl'), txt=document.getElementById('tourtxt'),
        next=document.getElementById('tournext'), dots=document.getElementById('tourdots');
    function killBridge(){ var b=document.getElementById('tourbridge'); if(b&&b.parentNode)b.parentNode.removeChild(b); }
    function done(){ try{localStorage.setItem(KEY,'1');sessionStorage.removeItem('__tourResume');}catch(e){} tour.hidden=true; document.body.style.overflow=''; running=0; killBridge(); }
    function place(){
      var s=STEPS[i], el=s.sel?document.querySelector(s.sel):null;
      document.getElementById('tourcatch').style.background = el ? 'transparent' : 'rgba(18,20,14,.72)';
      // Snap (kill the .25s glide) when the spotlight first appears on this page, or reappears after
      // a no-target step — otherwise it animates in from a stale/corner position (the flicker on
      // cross-page + post-notif steps, since each page starts with a fresh #tour at 0,0). Same-page
      // target→target moves keep the smooth glide. Restore the transition on the next frame.
      var snap = snapNext || hole.style.display!=='block';
      if(el){ try{el.scrollIntoView({block:'center'});}catch(e){}
        var r=el.getBoundingClientRect(), pad=8;
        if(snap){ hole.style.transition='none'; tip.style.transition='none'; }
        hole.style.display='block';
        hole.style.left=(r.left-pad)+'px'; hole.style.top=(r.top-pad)+'px';
        hole.style.width=(r.width+pad*2)+'px'; hole.style.height=(r.height+pad*2)+'px';
        var th=tip.offsetHeight||150, top;
        if(r.bottom+th+16 < window.innerHeight) top=r.bottom+12; else top=Math.max(12, r.top-th-12);
        tip.style.top=top+'px';
        tip.style.left=Math.max(12, Math.min(window.innerWidth-tip.offsetWidth-12, r.left+r.width/2-tip.offsetWidth/2))+'px';
      } else {
        tip.style.transition='none'; // centered tip snaps in (never glides from the last target)
        hole.style.display='none';
        tip.style.top=Math.max(12,(window.innerHeight-(tip.offsetHeight||160))/2)+'px';
        tip.style.left=Math.max(12,(window.innerWidth-tip.offsetWidth)/2)+'px';
        snap=true;
      }
      if(snap){ void hole.offsetHeight; requestAnimationFrame(function(){ hole.style.transition=''; tip.style.transition=''; }); }
      snapNext=false;
    }
    function render(){
      var s=STEPS[i]; ttl.textContent=s.ttl; txt.textContent=s.txt;
      var d=''; for(var k=0;k<STEPS.length;k++) d+='<i class="'+(k===i?'on':'')+'"></i>'; dots.innerHTML=d;
      next.textContent=s.notif?'Enable':(s.waiver?'Sign now':(i===STEPS.length-1?'Done':'Next')); next.disabled=false; place();
    }
    function goToStep(idx){
      if(idx>=STEPS.length){ done(); return; }
      var target=STEPS[idx].path||'/runs';
      if(target!==location.pathname){                 // step lives on another page → navigate, resume there
        try{ sessionStorage.setItem('__tourResume', String(idx)); }catch(e){}
        // Bridge scrim on <body> (OUTSIDE .wrap, so the router's .wrap swap can't destroy it):
        // holds a continuous dark backdrop across the page hop so the tour never flashes the
        // bare page between leaving this step and re-anchoring on the next. Removed when the
        // tour re-shows on the new page (or by the failsafe below).
        var br=document.getElementById('tourbridge');
        if(!br){ br=document.createElement('div'); br.id='tourbridge';
          br.style.cssText='position:fixed;inset:0;z-index:399;background:rgba(18,20,14,.72);opacity:1;transition:opacity .2s'; document.body.appendChild(br); }
        setTimeout(killBridge, 3000); // failsafe: the SPA swap keeps this JS context alive, so a stuck bridge always clears
        tour.hidden=true; running=0; // keep body scroll LOCKED — the bridge is up
        if(window.__go) window.__go(target,true); else window.location.href=target;
        return;
      }
      i=idx; render();
    }
    function advance(){
      var s=STEPS[i];
      if(s.notif){ next.disabled=true; var nx=function(){goToStep(i+1);}; (window.__pushEnable?window.__pushEnable():Promise.resolve()).then(nx,nx); return; }
      if(s.waiver){ try{localStorage.setItem(KEY,'1');sessionStorage.removeItem('__tourResume');}catch(e){} var u='/waiver'; if(window.__go)window.__go(u,true); else window.location.href=u; return; } // end the tour AT the waiver
      goToStep(i+1);
    }
    next.addEventListener('click',advance);
    document.getElementById('tourskip').addEventListener('click',done);
    document.getElementById('tourcatch').addEventListener('click',function(){ if(!STEPS[i].notif&&!STEPS[i].waiver) advance(); }); // notif + waiver need their explicit button
    window.addEventListener('resize',function(){ if(!tour.hidden) place(); });
    // Swipe RIGHT → back a step, swipe LEFT → forward (goToStep handles the cross-page hops).
    // Forward-swipe skips the notif step's push prompt (only the Enable button grants it).
    var tsx=0,tsy=0;
    tour.addEventListener('touchstart',function(e){ if(e.touches&&e.touches.length===1){tsx=e.touches[0].clientX;tsy=e.touches[0].clientY;} },{passive:true});
    tour.addEventListener('touchend',function(e){
      if(tour.hidden||!e.changedTouches||!e.changedTouches.length)return;
      var dx=e.changedTouches[0].clientX-tsx, dy=e.changedTouches[0].clientY-tsy;
      if(Math.abs(dx)>50 && Math.abs(dx)>Math.abs(dy)*1.4){ if(dx>0){ if(i>0)goToStep(i-1); } else goToStep(i+1); }
    },{passive:true});
    // force=true → replay (ignore seen-flag, no splash delay). Auto-runs once on the check-in
    // home page; on other pages it runs ONLY when RESUMING a tour that navigated here.
    window.__startTour=function(force){
      if(running) return;
      var resume=-1;
      try{ var rs=sessionStorage.getItem('__tourResume'); if(rs!==null){ resume=parseInt(rs,10); sessionStorage.removeItem('__tourResume'); } }catch(e){}
      if(resume<0 && !force){
        if(location.pathname!=='/runs') return;
        try{ if(localStorage.getItem(KEY)) return; }catch(e){}
      }
      running=1;
      // Operator role must be IDENTICAL on every tour page so step indices align across
      // page hops. The Runs hub has no ops-nav, so pages set window.__tourRole server-side;
      // fall back to detecting the ops-nav links where that global isn't present.
      var role=window.__tourRole||null;
      var isOp=role?!!role.op:!!document.querySelector('.opsnav a[href="/admin"]'),
          isAdm=role?!!role.adm:!!document.querySelector('.opsnav a[href="/admin/people"]'),
          waiverNeeded=role?!!role.waiver:false,   // only unsigned players get the waiver step
          sup=supported();
      setTimeout(function(){
        STEPS=STEPS_ALL.filter(function(s){ if(s.op&&!isOp)return false; if(s.adm&&!isAdm)return false; if(s.notif&&!sup)return false; if(s.waiver&&!waiverNeeded)return false; return true; });
        if(!STEPS.length){ done(); killBridge(); return; }
        i = resume>=0 ? Math.max(0,Math.min(resume,STEPS.length-1)) : 0;
        tour.hidden=false; document.body.style.overflow='hidden'; render();
        // Cut the bridge in a SINGLE frame right after the spotlight paints (double-rAF) — no
        // opacity fade (that slow reveal read as janky) and no bare-page frame. Re-run place()
        // in the same frame so the spotlight can't hand off to a stale position.
        requestAnimationFrame(function(){ requestAnimationFrame(function(){ place(); killBridge(); }); });
      }, resume>=0?200:(force?0:((document.getElementById('splash')&&!reduce)?1700:350)));
    };
    window.__startTour(false);
  })();
  </script>`;

const installSteps = `
  <div class="card" id="firstrun" style="margin-top:14px">
    <span class="eyebrow">First time? One-time setup</span>
    <h3 style="margin:2px 0 10px">Get the app</h3>
    <div id="fr-safari" class="notice warn" hidden style="margin:0 0 10px">You're not in Safari — on iPhone the app installs from <b>Safari</b> only. Tap <b>•••</b> / your browser menu → <b>Open in Safari</b>, then:</div>
    ${IOS_STEPS}
  </div>
  <script>(function(){
    var el=document.getElementById('firstrun'); if(!el)return;
    var standalone=(navigator.standalone===true)||(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches);
    if(standalone){ el.style.display='none'; return; }
    var ua=navigator.userAgent||'';
    var ios=/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1);
    var realSafari=/Version\\/[\\d.]+.*Safari/.test(ua)&&!/CriOS|FxiOS|EdgiOS|OPiOS|mercury/i.test(ua);
    if(ios&&!realSafari){ var s=document.getElementById('fr-safari'); if(s)s.hidden=false; }
  })();</script>`;

// One-time, per-device welcome modal — shown ONCE on the first in-app load after a
// player signs in. Guarded by a localStorage flag and PRE-PAINTED like the splash:
// the inline script stamps <html class="welcomed"> BEFORE the modal element is parsed,
// so a device that's already seen it never paints it (no flash on every load). Only
// embedded in post-login (in-app) pages — never on the public apply/login pages.
// "Got it" sets the flag and hides it. No schema change; copy matches the check-in +
// email Add-to-Home-Screen tip. Also self-hides if already installed (standalone).
const WELCOME_MODAL = `
  <style>
  #welcome{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;padding:22px;
    background:rgba(18,20,14,.55);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
  html.welcomed #welcome{display:none}
  #welcome .wcard{background:var(--card);border-radius:20px;max-width:400px;width:100%;padding:24px 22px 20px;
    box-shadow:0 30px 70px -20px rgba(0,0,0,.5);text-align:left}
  #welcome .weyebrow{font-family:var(--head);font-weight:800;font-size:10.5px;letter-spacing:.22em;text-transform:uppercase;color:var(--teal)}
  #welcome h3{font-family:var(--anton);font-size:26px;line-height:1.05;margin:6px 0 6px;color:var(--ink)}
  #welcome .wsub{color:var(--muted);font-size:14px;line-height:1.5;margin:0 0 14px}
  #welcome .wsteps{display:flex;flex-direction:column;gap:8px;margin:0 0 14px}
  #welcome .wstep{display:flex;gap:10px;align-items:baseline;font-size:14px;color:var(--ink)}
  #welcome .wplat{font-family:var(--head);font-weight:800;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--teal);min-width:56px;flex:none}
  #welcome .wtip{font-size:13px;color:var(--ink);background:var(--tint2);border-radius:10px;padding:10px 12px;line-height:1.5;margin:0 0 16px}
  #welcome .wgot{width:100%}
  </style>
  <script>(function(){try{if(localStorage.getItem('bridgeWelcomed')||(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||navigator.standalone)document.documentElement.className+=' welcomed';}catch(e){}})();</script>
  <div id="welcome" role="dialog" aria-modal="true" aria-label="Welcome to the run">
    <div class="wcard">
      <span class="weyebrow">Welcome to the run</span>
      <h3>Add to your home screen</h3>
      <p class="wsub">Stay signed in and ensure full app functionality.</p>
      <div class="wsteps">
        <div class="wstep"><span class="wplat">iOS</span><span>Tap <b>Share</b> → <b>Add to Home Screen</b></span></div>
        <div class="wstep"><span class="wplat">Android</span><span>Tap <b>⋮</b> → <b>Install app</b></span></div>
      </div>
      <p class="wtip">Launches fullscreen like an app (no browser bars) and keeps you signed in.</p>
      <button class="btn wgot" type="button" onclick="(function(){try{localStorage.setItem('bridgeWelcomed','1');}catch(e){}document.documentElement.className+=' welcomed';})()">Got it</button>
    </div>
  </div>`;

// Game format card — static reference shown at the bottom of the check-in page.
// Icons + foil-accented values ported from the game_format mockup.
const GAME_FORMAT_CARD = `
    <div class="card">
      <div class="clab">Game Format</div>
      <div class="ctitle">How we run it</div>
      <div class="rows">
        <div class="row">
          <span class="ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18M6 5c4 3 4 11 0 14M18 5c-4 3-4 11 0 14"/></svg></span>
          <div class="rtx"><b>5-on-5</b><span>Full court</span></div>
          <div class="rval">5<em>v</em>5</div>
        </div>
        <div class="row">
          <span class="ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg></span>
          <div class="rtx"><b>1s &amp; 2s</b><span>Ones and twos scoring</span></div>
          <div class="rval">1<em>&amp;</em>2</div>
        </div>
        <div class="row">
          <span class="ic"><svg viewBox="0 0 24 24"><path d="M4 19V5M4 6h13l-2 4 2 4H4"/></svg></span>
          <div class="rtx"><b>Games to 9</b><span>Win by 2</span></div>
          <div class="rval"><em>9</em></div>
        </div>
        <div class="row">
          <span class="ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 8l8 8"/></svg></span>
          <div class="rtx"><b>Dead at 11</b><span>Hard cap — first to 11 takes it</span></div>
          <div class="rval"><em>11</em></div>
        </div>
      </div>
    </div>`;

// Relationship action button(s): a set of `.swapform` POSTs (already in the SPA interceptor
// selector) whose route redirects back to `back` and is swapped in place — no full reload.
// `rel` is the viewer's relationship toward this person (see relationshipTo in engine/social.js).
// Reused on the /friends rows AND on a player's full profile.
function friendBtn(id, rel, back = '/friends') {
  const f = (action, label, cls) =>
    `<form class="swapform frbtn" method="POST" action="/friends/${action}"><input type="hidden" name="id" value="${id}"><input type="hidden" name="back" value="${esc(back)}"><button class="btn ${cls}" type="submit">${label}</button></form>`;
  switch (rel) {
    case 'friends':    return `<span class="frchip">✓ Friends</span>${f('remove', 'Remove', 'ghost sm')}`;
    case 'incoming':   return `${f('accept', '✓ Accept', 'primary sm')}${f('decline', 'Decline', 'ghost sm')}`;
    case 'outgoing':   return f('decline', 'Requested — cancel', 'ghost sm');
    case 'blocked':    return f('unblock', 'Unblock', 'ghost sm');
    case 'blocked_by':
    case 'self':       return '';
    default:           return f('request', '＋ Add friend', 'primary sm');
  }
}

// One-way follow control (Javelin-style). `following` = do I already follow them. When I don't
// AND `backLabel` is set (the Followers list), it reads "Follow back" instead of "Follow".
function followBtn(id, following, back = '/friends', backLabel = false) {
  const action = following ? 'unfollow' : 'follow';
  const label = following ? 'Following ✓' : (backLabel ? 'Follow back' : '＋ Follow');
  const cls = following ? 'ghost sm' : 'primary sm';
  return `<form class="swapform frbtn" method="POST" action="/friends/${action}"><input type="hidden" name="id" value="${id}"><input type="hidden" name="back" value="${esc(back)}"><button class="btn ${cls}" type="submit">${label}</button></form>`;
}

// Friends home — directory search, incoming requests, friends' games, your friends,
// pending sent, and a collapsed blocked list. All person-scoped (not run-scoped). Every row
// links to /u/:id; every action is a swapform that swaps back into this page. Self-contained
// styles (scoped .fr*) so it needs no new global CSS.
// One person row: avatar + name (→ /u/:id) + a right-side action string. Reused on the page + the
// live-search fragment. FOLLOW-only model (mutual friend-requests were dropped as redundant).
function frPersonRow(p, actions) {
  return `<div class="mrow frrow">
      <a class="mav" href="/u/${p.id}" aria-label="${esc(p.name)}">${avatarInner(p.email, p.name)}</a>
      <a class="mtx" href="/u/${p.id}"><b class="mnm">${esc(p.name)}</b></a>
      <span class="fract">${actions}</span>
    </div>`;
}

export {
  IOS_STEPS, annBell, IC_PLAY, IC_PAUSE, IC_SAVE, IC_SEND, IC_CLOSE, IC_PLUS, IC_PHOTO, IC_STICKER,
  IC_MIC, IC_VIDEO, qrBlock, locationBlock, codeEntryCard, installSteps, homeScreenCard, avatarInner,
  GROUP_ICON, MINOR_STAR, progMeta, tabNav, opsNav, backToRuns, firstRunTour, WELCOME_MODAL,
  GAME_FORMAT_CARD, pvSheet, pvScript, MINOR_BADGE, followBtn, frPersonRow, IC_REPLY, IC_TRASH, IC_PIN,
  IC_COPY, IC_BACK, backBtn, copyBtn, shareBtn, shareScript,
};
