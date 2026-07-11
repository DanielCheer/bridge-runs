// views.js — server-rendered pages. No template engine; plain template literals.
import fs from 'fs';
const esc = (s = '') => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Run-day labels — the app's "Friday"/"FRI" wording follows the actual run date. A
// YYYY-MM-DD is parsed at local noon (matches runLabelFor on the server) to avoid a
// timezone day-shift. Falls back to Friday/FRI when no date is supplied (pages with
// no run context, e.g. sign-in / apply — generic branding).
const _WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const _WDS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const wdayFull = (dateStr) => dateStr ? _WD[new Date(dateStr + 'T12:00:00').getDay()] : 'Friday';
const wdayShort = (dateStr) => dateStr ? _WDS[new Date(dateStr + 'T12:00:00').getDay()] : 'FRI';

// Cache-bust styles.css by its own modification time. Static assets are served
// with a 7-day cache; without this, returning users keep stale CSS after any
// design change. The query only changes when the file changes, so it still
// caches well between edits.
let CSS_VER = '1';
try { CSS_VER = String(Math.floor(fs.statSync(new URL('./public/styles.css', import.meta.url)).mtimeMs)); } catch {}

// Build version = newest mtime of the client-facing sources (views.js + styles.css).
// /poll returns it; an open (live-polling) session auto-reloads to fresh code on
// deploy — so shipped fixes reach already-open apps within ~10s instead of never.
export let BUILD_VER = CSS_VER;
try { BUILD_VER = String(Math.floor(Math.max(fs.statSync(new URL('./views.js', import.meta.url)).mtimeMs, fs.statSync(new URL('./public/styles.css', import.meta.url)).mtimeMs))); } catch {}

// SQLite datetime('now') stores UTC as 'YYYY-MM-DD HH:MM:SS'. Render it in the
// server's local timezone (run the app on Eastern — see README ops notes).
const fmtWhen = (sqlUtc) => {
  if (!sqlUtc) return '';
  // Accept BOTH SQLite 'YYYY-MM-DD HH:MM:SS' (space) and ISO
  // 'YYYY-MM-DDTHH:MM:SS(.sss)Z' — normalise to a T-separated UTC string so Date
  // parses either the same way, instead of choking on an already-ISO value and
  // falling through to printing the raw string (the "raw ISO in the inbox" bug).
  const s = String(sqlUtc).trim().replace(' ', 'T').replace(/(\.\d+)?Z?$/, '') + 'Z';
  const d = new Date(s);
  if (isNaN(d)) return esc(String(sqlUtc));
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
};

// Cold-start splash. Pre-paint script hides #splash before first paint on any
// navigation AFTER the first in a session (sessionStorage 'splashed' flag), so
// it only ever animates on a genuine cold start — no flash on later pages. The
// critical CSS is inlined so the overlay paints correctly before styles.css
// loads. prefers-reduced-motion shortens the hold and drops the spin/fade.
const SPLASH_HEAD = `<script>(function(){try{if(sessionStorage.getItem('splashed'))document.documentElement.className+=' splashed';}catch(e){}})();</script>
<style>
#splash{position:fixed;inset:0;z-index:9999;background:#F8F5EF;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:46px;opacity:1;transition:opacity .5s ease}
html.splashed #splash{display:none}
#splash.hide{opacity:0;pointer-events:none}
#splash .bw{position:relative;display:grid;place-items:center}
#splash .lg{position:absolute;width:230px;height:230px;opacity:.10}
#splash .tt{position:relative;text-align:center}
#splash .tt b{font-family:'Anton',Impact,sans-serif;font-size:46px;letter-spacing:.01em;color:#20211c;line-height:.92;display:block}
#splash .tt .sb{display:block;margin-top:12px;font-family:'Archivo',system-ui,sans-serif;font-weight:800;font-size:12.5px;letter-spacing:.24em;text-transform:uppercase;color:#22615A}
#splash .tt .rl{width:64px;height:3px;margin:16px auto 0;border-radius:3px;background:linear-gradient(90deg,#C24512,#FBB360,#E4611F)}
#splash .sp{width:38px;height:38px;position:relative}
#splash .sp i{position:absolute;left:47.5%;top:6%;width:5%;height:26%;border-radius:3px;background:#22615A;transform-origin:center 172%;animation:splspin 1s linear infinite}
#splash .sp i:nth-child(1){transform:rotate(0deg);animation-delay:-.917s}
#splash .sp i:nth-child(2){transform:rotate(30deg);animation-delay:-.833s}
#splash .sp i:nth-child(3){transform:rotate(60deg);animation-delay:-.75s}
#splash .sp i:nth-child(4){transform:rotate(90deg);animation-delay:-.667s}
#splash .sp i:nth-child(5){transform:rotate(120deg);animation-delay:-.583s}
#splash .sp i:nth-child(6){transform:rotate(150deg);animation-delay:-.5s}
#splash .sp i:nth-child(7){transform:rotate(180deg);animation-delay:-.417s}
#splash .sp i:nth-child(8){transform:rotate(210deg);animation-delay:-.333s}
#splash .sp i:nth-child(9){transform:rotate(240deg);animation-delay:-.25s}
#splash .sp i:nth-child(10){transform:rotate(270deg);animation-delay:-.167s}
#splash .sp i:nth-child(11){transform:rotate(300deg);animation-delay:-.083s}
#splash .sp i:nth-child(12){transform:rotate(330deg);animation-delay:0s}
@keyframes splspin{0%{opacity:1}100%{opacity:.15}}
#splash .ft{position:absolute;bottom:46px;font-family:'Archivo',system-ui,sans-serif;font-weight:700;font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:#8a8474}
@media (prefers-reduced-motion:reduce){#splash .sp i{animation:none}#splash{transition:none}}
</style>`;

const SPLASH_BODY = `<div id="splash" aria-hidden="true">
  <div class="bw">
    <svg class="lg" viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="#22615A"/><path d="M20 2v36M2 20h36M7 7c7 5 7 21 0 26M33 7c-7 5-7 21 0 26" stroke="#F8F5EF" stroke-width="1.4" opacity=".9"/></svg>
    <div class="tt"><b>THE BRIDGE</b><span class="sb">Advanced Basketball Run</span><div class="rl"></div></div>
  </div>
  <div class="sp"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
  <div class="ft">Markham · Fridays 7–10 PM</div>
</div>
<script>(function(){var s=document.getElementById('splash');if(!s)return;if(document.documentElement.classList.contains('splashed'))return;var done=function(){s.classList.add('hide');try{sessionStorage.setItem('splashed','1');}catch(e){}setTimeout(function(){if(s&&s.parentNode)s.parentNode.removeChild(s);},600);};var r=window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches;setTimeout(done,r?500:1500);window.addEventListener('load',function(){setTimeout(done,900);});})();</script>`;

// Animation gate + shared soft-reload helpers. Pre-paint reads the sessionStorage
// 'noanim' flag (set right before any programmatic reload) and stamps <html
// class="noanim"> BEFORE first paint, so entry animations (keyed to
// html:not(.noanim)) never replay on the 20s auto-reload — only on real navs.
//   window.__reload()   : sets the flag then reloads (use for every poll reload)
//   window.__composing(): true if a field is focused / a text field holds a value
//                         / an announce-compose is open — reloads skip when true.
// Static client engine (router, poll, .wrap swap, push, badges, logout, service worker).
// Extracted from an inline HEAD <script> into a cached, versioned /app.js so it downloads
// + parses ONCE and is reused across full loads, instead of re-shipping ~15KB (72% of the
// HTML) inline on every page. It DEFINES the window.* globals that per-page inline scripts
// call synchronously, so HEAD loads it as a BLOCKING <script> before <body> (see ANIM_HEAD)
// — never `defer`. No server interpolation lives here (BUILD_VER stays inline in ANIM_HEAD),
// so the body is byte-identical for every request → safe to cache immutably.
export const APP_JS = `window.__reload=function(){try{sessionStorage.setItem('noanim','1');}catch(e){}location.reload();};
// Nav-rank helper (shared by the client router + the cross-doc pageswap fallback):
// rank the primary destinations left→right so a move to a higher rank is "forward"
// (content enters from the right) and lower is "back". No rank match → null → fade.
(function(){
  var SEQ=['/admin/people','/admin','/profile','/chat','/checkin'];       // match specific-first
  var RANK={'/checkin':0,'/chat':1,'/profile':2,'/admin':3,'/admin/people':4};
  function rank(p){for(var i=0;i<SEQ.length;i++){if(p.indexOf(SEQ[i])===0)return RANK[SEQ[i]];}return -1;}
  window.__navDir=function(from,to){var a=rank(from),b=rank(to);if(a<0||b<0||a===b)return null;return b>a?'nav-forward':'nav-back';};
})();
// Cross-document FALLBACK: when the client router below can't handle a tab nav (no
// fetch / no View Transitions) the browser does a real navigation — still make it
// directional by setting the view-transition-type on both sides (bridged via
// sessionStorage, as Safari lacks the Navigation API). Skipped where unsupported.
window.addEventListener('pageswap',function(e){
  if(!e.viewTransition)return;
  var to=''; try{to=(e.activation&&e.activation.entry)?new URL(e.activation.entry.url).pathname:'';}catch(x){}
  var t=to?window.__navDir(location.pathname,to):null;
  try{if(t){sessionStorage.setItem('vtdir',t);}else{sessionStorage.removeItem('vtdir');}}catch(x){}
  if(t){try{e.viewTransition.types.add(t);}catch(x){}}
});
window.addEventListener('pagereveal',function(e){
  if(!e.viewTransition)return;
  var t=null; try{t=sessionStorage.getItem('vtdir');sessionStorage.removeItem('vtdir');}catch(x){}
  if(t){try{e.viewTransition.types.add(t);}catch(x){}}
});
window.__composing=function(){var ae=document.activeElement;if(ae&&/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)&&(ae.type||'')!=='hidden')return true;var f=document.querySelectorAll('textarea,input');for(var i=0;i<f.length;i++){var t=(f[i].type||'text').toLowerCase();if(t==='hidden'||t==='checkbox'||t==='radio'||t==='submit'||t==='button'||t==='file')continue;if(f[i].value&&f[i].value.trim())return true;}if(document.querySelector('details.announce-compose[open]'))return true;return false;};
// Patch the DM (Profile tab) + group (Chat tab) unread badges in place every poll
// tick — no reload needed to keep them fresh. Also toggles the hero group-chat dot.
window.__patchBadges=function(dm,group,gm,ann){try{
  function setTab(href,n,mention){var a=document.querySelector('.tabs a[href="'+href+'"]');if(!a)return;var b=a.querySelector('.tabbadge');
    if(n>0){var t=(mention>0?'@':'')+(n>9?'9+':String(n));if(!b){b=document.createElement('span');b.className='tabbadge';a.appendChild(b);}b.textContent=t;b.className='tabbadge'+(mention>0?' mention':'');}
    else if(b){b.parentNode.removeChild(b);}}
  setTab('/chat',group,gm); setTab('/profile',dm,0);
  var hchat=document.querySelector('.hchat');if(hchat){var d=hchat.querySelector('.hdot');
    if(group>0){if(!d){d=document.createElement('span');d.className='hdot';d.setAttribute('aria-hidden','true');hchat.appendChild(d);}}else if(d){d.parentNode.removeChild(d);}}
  // Masthead announcement bell dot — toggled live from the poll ann unread flag.
  var bell=document.querySelector('.bellbtn');if(bell){var bd=bell.querySelector('.belldot');
    if(ann>0){if(!bd){bd=document.createElement('span');bd.className='belldot';bd.setAttribute('aria-hidden','true');bell.appendChild(bd);}}else if(bd){bd.parentNode.removeChild(bd);}}
  // Home-screen app-icon badge (installed PWA, iOS 16.4+): total unread across DM+chat.
  if(navigator.setAppBadge){var tot=(dm||0)+(group||0);
    if(tot>0)navigator.setAppBadge(tot).catch(function(){});
    else if(navigator.clearAppBadge)navigator.clearAppBadge().catch(function(){});}
}catch(e){}};
// Swap only the .wrap contents (+ <title> + body class) from a fetched full page and
// re-run its inline scripts (innerHTML won't execute them) — the shared engine behind
// both the check-in action fetches and the client tab router. Returns false on any
// parse/shape problem so callers fall back to a hard navigation.
window.__swapWrap=function(html){
  try{
    var doc=new DOMParser().parseFromString(html,'text/html');
    var nw=doc.querySelector('.wrap'),cur=document.querySelector('.wrap');
    if(!nw||!cur)return false;
    if(doc.title)document.title=doc.title;
    if(doc.body&&doc.body.className!==document.body.className)document.body.className=doc.body.className;
    document.body.style.overflow='';   // any open overlay is destroyed by this swap; never leave scroll locked
    cur.innerHTML=nw.innerHTML;
    var s=cur.querySelectorAll('script');
    for(var i=0;i<s.length;i++){var ns=document.createElement('script');if(s[i].src)ns.src=s[i].src;else ns.textContent=s[i].textContent;s[i].parentNode.replaceChild(ns,s[i]);}
    return true;
  }catch(e){return false;}
};
// True while any full-screen overlay/sheet is open — a poll-driven .wrap swap must NOT
// fire then (it would destroy the tour/sheet mid-use and could leave scroll locked).
window.__overlayOpen=function(){
  var t=document.getElementById('tour'); if(t&&!t.hidden)return true;
  var ids=['annwrap','wgwrap','memwrap'];
  for(var i=0;i<ids.length;i++){var e=document.getElementById(ids[i]); if(e&&e.classList.contains('open'))return true;}
  return false;
};
// Surgical poll-and-patch driver (P0-1). One shared 10s, visibility-gated loop; the
// active page + onChange live on window so a client-side tab swap can RE-TARGET the
// poll (it used to bind once to the first page). __pollStop parks it between swaps so
// a stale onChange can't clobber the page we're navigating to. After 3 consecutive
// fetch failures it degrades to the legacy 20s full reload.
window.__poll=function(page,onChange){
  var changed=(window.__pollPage!==page);
  window.__pollPage=page; window.__pollOnChange=onChange;
  if(changed)window.__pollResetLast=true;
  if(window.__pollBound)return; window.__pollBound=true;
  var last=null, fails=0, legacy=false, iv=null;
  function tick(){
    if(document.visibilityState!=='visible')return;
    if(window.__wlSync)window.__wlSync();   // release/re-acquire the screen wake lock as the page changes
    var pg=window.__pollPage; if(!pg)return;
    if(window.__pollResetLast){last=null;window.__pollResetLast=false;}
    fetch('/poll?page='+encodeURIComponent(pg),{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}})
      .then(function(r){if(!r.ok)throw 0;return r.json();})
      .then(function(d){fails=0;window.__patchBadges(d.dm,d.group,d.gm,d.ann);
        if(d.v&&window.__ver&&d.v!==window.__ver&&(!window.__composing||!window.__composing())){window.__reload();return;}
        if(last!==null&&d.f!==last){try{if(window.__pollOnChange)window.__pollOnChange();}catch(e){}}
        last=d.f;})
      .catch(function(){fails++;if(fails>=3&&!legacy){legacy=true;if(iv)clearInterval(iv);
        setInterval(function(){if(document.visibilityState==='visible'&&(!window.__composing||!window.__composing()))window.__reload();},20000);}});
  }
  iv=setInterval(tick,10000); tick();
};
window.__pollStop=function(){window.__pollPage=null;window.__pollOnChange=null;};
// ---- Client tab router: fetch the next tab in the background and swap it in place
// (no full document reload) so switching is instant — the network round-trip is the
// only cost and it's already warmed on pointerdown. Same-origin .tabs/.opsnav links
// only. ANY problem (cross-origin, auth redirect, fetch/VT failure, missing .wrap,
// version bump) falls back to a normal navigation, so it can never be worse than a
// plain load. The steady-chrome + directional View Transition (styles.css) rides on
// top: header + tab bar hold still, content slides. ----
(function(){
  if(window.__routerBound)return; window.__routerBound=true;
  var cache={}, WARM_TTL=8000; // a prewarm older than this is stale — refetch (new
  // chat messages / check-ins could have landed since the pointerdown that warmed it)
  function warm(href){ if(!href||!window.fetch)return;
    var e=cache[href]; if(e&&Date.now()-e.t<WARM_TTL)return; // fresh prewarm already in flight
    // X-Prewarm tells read-side-effect GETs (/chat) NOT to clear unread on a mere pointerdown
    // — the actual landing fires a /chat/seen beacon instead. Otherwise a touch that turns into
    // a scroll would wipe the unread badge for messages you never saw.
    try{ cache[href]={t:Date.now(),p:fetch(href,{credentials:'same-origin',headers:{'X-Prewarm':'1'}}).then(function(r){return r.text().then(function(t){return {ok:r.ok,url:r.url,redirected:r.redirected,text:t};});})}; }catch(e){} }
  function hard(href){ try{window.location.href=href;}catch(e){} }
  function paint(res,href,push,type){
    // Plain instant swap — NO View Transition. iOS Safari leaves stuck ::view-transition
    // snapshots (old masthead ghosting over the new page), so we skip startViewTransition
    // entirely; __swapWrap replaces .wrap in one synchronous repaint = clean, no overlap.
    if(push)history.pushState({r:1},'',href); else history.replaceState({r:1},'',href);
    window.scrollTo(0,0);
    if(!window.__swapWrap(res.text)){hard(href);}
  }
  function mkres(r){ return r.text().then(function(t){return {ok:r.ok,url:r.url,redirected:r.redirected,text:t};}); }
  function go(href,push){
    var abs; try{abs=new URL(href,location.href);}catch(e){hard(href);return;}
    if(abs.origin!==location.origin){hard(href);return;}
    var type=push?window.__navDir(location.pathname,abs.pathname):null;
    warm(href); // (re)fills a fresh entry if the current one is missing or stale
    var e=cache[href]; delete cache[href];
    var pr=e?e.p:null;
    if(!pr){ try{pr=fetch(href,{credentials:'same-origin'}).then(mkres);}catch(e){hard(href);return;} }
    if(window.__pollStop)window.__pollStop();   // park poll so its onChange can't clobber mid-swap
    pr.then(function(res){
      if(!res||typeof res.text!=='string'){hard(href);return;}
      if(res.redirected&&res.url){var u;try{u=new URL(res.url);}catch(e){u=null;} if(u&&u.pathname!==abs.pathname){hard(res.url);return;}}
      paint(res,href,push,type);
      // Actually LANDED on chat → now mark it read (the prewarm skipped it). Beacon =
      // fire-and-forget; the badge clears on the next poll tick.
      if(abs.pathname==='/chat'&&navigator.sendBeacon){try{navigator.sendBeacon('/chat/seen');}catch(e){}}
    }).catch(function(){hard(href);});
  }
  document.addEventListener('pointerdown',function(e){
    var a=e.target&&e.target.closest&&e.target.closest('.tabs a[href],.opsnav a[href]');
    if(a)warm(a.getAttribute('href'));
  },{passive:true,capture:true});
  document.addEventListener('click',function(e){
    if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
    var a=e.target&&e.target.closest&&e.target.closest('.tabs a[href],.opsnav a[href]');
    if(!a)return;
    if(a.target&&a.target!==''&&a.target!=='_self')return;
    var href=a.getAttribute('href'); if(!href||href.charAt(0)==='#')return;
    var abs; try{abs=new URL(href,location.href);}catch(x){return;}
    if(abs.origin!==location.origin)return;
    e.preventDefault();
    if(abs.pathname===location.pathname&&abs.search===location.search)return;   // current tab → no-op
    go(href,true);
  });
  window.addEventListener('popstate',function(){ go(location.pathname+location.search,false); });
})();
// Register the service worker (offline shell + Web Push + app-icon badge). Runs on
// real document loads only; harmless where unsupported.
if('serviceWorker' in navigator&&!window.__swBound){window.__swBound=1;
  window.addEventListener('load',function(){try{navigator.serviceWorker.register('/sw.js');}catch(e){}});}
// Shared Web Push enable flow — used by BOTH the first-run check-in prompt and the
// Profile card. Must be called from a user gesture (iOS requires it for the permission
// prompt). Resolves true once the subscription is registered server-side.
window.__pushSupported=function(){return ('serviceWorker' in navigator)&&('PushManager' in window)&&('Notification' in window);};
window.__pushStandalone=function(){return (navigator.standalone===true)||(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches);};
window.__pushEnable=function(){
  if(!window.__pushSupported())return Promise.resolve(false);
  function u8(b64){var pad='='.repeat((4-b64.length%4)%4);var s=(b64+pad).replace(/-/g,'+').replace(/_/g,'/');var raw=atob(s);var a=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)a[i]=raw.charCodeAt(i);return a;}
  return Notification.requestPermission().then(function(p){
    if(p!=='granted')return false;
    return navigator.serviceWorker.ready.then(function(reg){
      return reg.pushManager.getSubscription().then(function(sub){
        if(sub)return sub;
        return fetch('/push/key',{credentials:'same-origin'}).then(function(r){return r.json();})
          .then(function(d){return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:u8(d.key)});});
      }).then(function(sub){
        return fetch('/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(sub)}).then(function(){return true;});
      });
    });
  }).catch(function(){return false;});
};
// Confirm before signing out (passwordless = they'll need a fresh email code to
// return). Delegated + bound once, so it covers every "Sign out" link app-wide.
if(!window.__logoutBound){window.__logoutBound=1;
  document.addEventListener('click',function(e){
    var a=e.target&&e.target.closest&&e.target.closest('a[href="/logout"]');
    if(!a)return; e.preventDefault(); // logout mutates session → must be POST, never a GET nav
    if(!confirm("Sign out? You'll need the 6-digit code we email you to sign back in — you don't normally need to sign out.")) return;
    var f=document.createElement('form'); f.method='POST'; f.action='/logout'; document.body.appendChild(f); f.submit();
  });
}
// Global Escape → close whichever full-screen overlay/sheet is open (who's-going, run
// members, announcements). a11y: these sheets are role=dialog; Esc + focus-restore are
// handled by their close fns. Bound once (survives router swaps).
if(!window.__ovEscBound){window.__ovEscBound=1;
  document.addEventListener('keydown',function(e){
    if(e.key!=='Escape')return;
    var w=document.querySelector('.wgwrap.open'); if(!w)return;
    var id=w.id;
    if(id==='wgwrap'&&window.wgClose)window.wgClose();
    else if(id==='memwrap'&&window.memClose)window.memClose();
    else if(id==='annwrap'&&window.annClose)window.annClose();
  });
}`;
// Tiny inline HEAD bootstrap: sets the build version (the ONLY server-interpolated value)
// and the pre-paint no-animation flag BEFORE the engine loads, then pulls the cached engine
// as a BLOCKING script (NOT defer) so its window.* globals exist before any <body> inline
// script runs. ?v=BUILD_VER busts the cache whenever views.js/styles.css change.
const ANIM_HEAD = `<script>window.__ver=${JSON.stringify(BUILD_VER)};(function(){try{if(sessionStorage.getItem('noanim')){sessionStorage.removeItem('noanim');document.documentElement.className+=' noanim';}}catch(e){}})();</script><script src="/app.js?v=${BUILD_VER}"></script>`;

// ---- Mandatory "Add to Home Screen" wall (mobile browsers only) ----
// Picture-by-picture install guide. People kept getting stuck in three spots, all
// addressed below: (1) Share can be behind the ••• menu, (2) "Add to Home Screen" is
// BELOW the apps / under "More", (3) on iPhone the app installs from SAFARI only (a
// browser or in-app webview must "Open in Safari" first). The visual iOS steps are
// shared with the sign-in guide (installSteps). Pre-paint gate stamps <html.walled>
// only on a mobile browser that isn't the installed app; desktop + standalone never.
const IOS_STEPS = `<ol class="vsteps">
  <li><span class="vpic"><svg viewBox="0 0 32 32" fill="none" stroke="#E86A33" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4.5v15"/><path d="M11 9.5l5-5 5 5"/><path d="M10 14H7.5A1.5 1.5 0 0 0 6 15.5v10A1.5 1.5 0 0 0 7.5 27h17a1.5 1.5 0 0 0 1.5-1.5v-10A1.5 1.5 0 0 0 24.5 14H22"/></svg></span><div class="vtxt"><b>1. Tap Share</b><span>The box with an ↑ arrow, at the bottom of Safari. Don't see it? Tap <b>•••</b> (bottom-right) then <b>Share</b>.</span></div></li>
  <li><span class="vpic"><svg viewBox="0 0 32 32" fill="none" stroke="#E86A33" stroke-width="2.2" stroke-linecap="round"><rect x="6" y="6" width="20" height="20" rx="6"/><path d="M16 11.5v9M11.5 16h9"/></svg></span><div class="vtxt"><b>2. Add to Home Screen</b><span><b>Scroll down</b> past the row of apps and tap it — tap <b>More</b> / <b>Edit Actions</b> if you don't see it.</span></div></li>
  <li><span class="vpic"><svg viewBox="0 0 32 32"><rect x="4" y="4" width="24" height="24" rx="7" fill="#2C6B66"/><text x="16" y="21" font-size="11" font-weight="800" fill="#fff" text-anchor="middle" font-family="Arial,Helvetica,sans-serif">AR</text></svg></span><div class="vtxt"><b>3. Tap “Add”</b><span>A screen titled <b>Add to Home Screen</b> pops up — tap <b>Add</b> (top-right). Then open <b>Bridge Runs</b> from your Home Screen and enter your code.</span></div></li>
</ol>`;
const VSTEPS_CSS = `
.vsteps{list-style:none;margin:0;padding:0;text-align:left;background:#fff;border:1px solid #e7e2d6;border-radius:16px}
.vsteps>li{display:flex;gap:12px;align-items:center;padding:12px 14px;border-bottom:1px solid #efe9dc}
.vsteps>li:last-child{border-bottom:none}
.vsteps .vpic{flex:0 0 50px;width:50px;height:50px;display:grid;place-items:center;background:#faf7f1;border:1px solid #eee7d9;border-radius:13px}
.vsteps .vpic svg{width:30px;height:30px}
.vsteps .vtxt{min-width:0}
.vsteps .vtxt>b{display:block;font-family:'Archivo',system-ui,sans-serif;font-weight:800;font-size:13.5px;color:#20211c;margin-bottom:2px}
.vsteps .vtxt>span{font-size:12px;color:#8a8474;line-height:1.4}
.vsteps .vtxt>span b{color:#20211c;font-weight:700}`;
const WALL_HEAD = `<style>
#installwall{display:none}
html.walled #installwall{display:flex}
html.walled body{overflow:hidden}
html.walled .wrap{display:none}
#installwall{position:fixed;inset:0;z-index:9998;background:#F8F5EF;color:#20211c;overflow-y:auto;
  flex-direction:column;align-items:center;padding:30px 22px}
#installwall .iw-in{max-width:360px;width:100%;margin:auto 0}
#installwall img.iw-icon{width:56px;height:56px;border-radius:14px;box-shadow:0 8px 24px -10px rgba(0,0,0,.4)}
#installwall .iw-ey{font-family:'Archivo',system-ui,sans-serif;font-weight:800;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#2C6B66;margin-top:14px;text-align:center}
#installwall h2{font-family:'Anton',system-ui,sans-serif;font-size:27px;text-transform:uppercase;line-height:1.06;margin:6px 0 6px;text-align:center}
#installwall .iw-lead{color:#8a8474;font-size:13.5px;line-height:1.45;margin:0 0 14px;text-align:center}
#installwall .iw-safari{background:#FDEBE0;border:1px solid #f3c9b3;border-radius:12px;padding:10px 12px;font-size:13px;color:#20211c;margin:0 0 12px;text-align:left;line-height:1.4}
#installwall .iw-btn{display:none;background:#E86A33;color:#111;border:none;font-weight:800;font-size:15px;padding:13px 24px;border-radius:12px;cursor:pointer}
#installwall .iw-sub{font-size:12.5px;color:#8a8474;margin:10px 0 0;line-height:1.4;text-align:left}
#installwall .iw-note{font-size:12.5px;color:#8a8474;margin-top:14px;text-align:center}
${VSTEPS_CSS}
</style>
<script>(function(){try{
  var standalone=(navigator.standalone===true)||(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches);
  var ua=navigator.userAgent||'';
  var ios=/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1);
  var android=/Android/.test(ua);
  var coarse=!(window.matchMedia)||window.matchMedia('(pointer:coarse)').matches;
  if(!standalone&&coarse&&(ios||android)){document.documentElement.className+=' walled';}
  window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__bip=e;});
}catch(e){}})();</script>`;

// Overlay body + a script that shows the iOS visual steps (adding an "Open in Safari"
// banner when the browser isn't real Safari — Chrome/Firefox/Edge on iOS or an in-app
// webview) or the Android one-tap install button.
const WALL_BODY = `<div id="installwall" role="dialog" aria-modal="true" aria-label="Install the app">
  <div class="iw-in">
    <div style="text-align:center"><img class="iw-icon" src="/icon-192.png" alt=""></div>
    <div class="iw-ey">The Bridge Adv Runs</div>
    <h2>Install the app to continue</h2>
    <p class="iw-lead">Bridge Runs lives on your Home Screen — for notifications and the full app. About 20 seconds:</p>
    <div id="iw-safari" class="iw-safari" hidden>📍 You're not in <b>Safari</b>. On iPhone the app installs from Safari only — tap <b>•••</b> or your browser's menu, choose <b>Open in Safari</b>, then follow the steps below.</div>
    <div id="iw-ios" hidden>${IOS_STEPS}</div>
    <div id="iw-android" hidden>
      <button class="iw-btn" id="iw-install" type="button">Install app</button>
      <p class="iw-sub">Or open the <b>⋮</b> menu, then <b>Install app</b> / <b>Add to Home screen</b>. Then open Bridge Runs from your Home Screen.</p>
    </div>
    <p class="iw-note">Then open the app and sign in with the 6-digit code we email you — just once.</p>
  </div>
</div>
<script>(function(){
  var ua=navigator.userAgent||'';
  var ios=/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1);
  var android=/Android/.test(ua);
  var realSafari=/Version\\/[\\d.]+.*Safari/.test(ua)&&!/CriOS|FxiOS|EdgiOS|OPiOS|mercury/i.test(ua);
  function show(id){var e=document.getElementById(id);if(e)e.hidden=false;}
  if(android){ show('iw-android'); }
  else { show('iw-ios'); if(ios&&!realSafari) show('iw-safari'); }
  var btn=document.getElementById('iw-install');
  function sb(){ if(window.__bip&&btn) btn.style.display='inline-block'; }
  sb(); window.addEventListener('beforeinstallprompt',sb);
  if(btn) btn.addEventListener('click',function(){ if(window.__bip){ window.__bip.prompt(); window.__bip.userChoice.finally(function(){window.__bip=null;btn.style.display='none';}); } });
})();</script>`;

const HEAD = (title, bodyClass = '', { wall = true } = {}) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#F8F5EF">
<link rel="icon" href="/favicon.ico?v=2" sizes="any">
<link rel="icon" type="image/png" href="/icon-192.png?v=2">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-title" content="Bridge Runs">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="mobile-web-app-capable" content="yes">
<title>${esc(title)}</title>
${SPLASH_HEAD}
${ANIM_HEAD}
${wall ? WALL_HEAD : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@500;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css?v=${CSS_VER}">
</head><body class="${bodyClass}">${SPLASH_BODY}${wall ? WALL_BODY : ''}<div class="wrap">`;

const FOOTER_LINKS = `<div class="foot">The Bridge Adv Runs · Markham · Fridays 7–10PM</div><div class="foot legalfoot"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/conduct">Conduct</a></div>`;
const FOOT = `${FOOTER_LINKS}</div></body></html>`;
// Tab-bar pages: render the fixed bottom tab bar as the LAST child of `.wrap`, with the footer
// text BEFORE it. It must stay inside `.wrap` (the client router swaps `.wrap` — the active-tab
// highlight comes from re-rendering it), but nothing must sit AFTER it in the scroll flow: on
// iOS Safari, in-flow content after a fixed bottom bar peeks out below it on overscroll (the
// tabs looked like they "moved" at the bottom). Footer-then-tabs fixes that while keeping the
// router's swap intact.
const footWithTabs = (tabsHtml) => `${FOOTER_LINKS}${tabsHtml}</div></body></html>`;

// The scoreboard basketball mark — used in the masthead.
const BALL = `<svg class="ball" viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="#22615A"/><path d="M20 2v36M2 20h36M7 7c7 5 7 21 0 26M33 7c-7 5-7 21 0 26" stroke="#F8F5EF" stroke-width="1.5" opacity=".85"/></svg>`;

// Masthead — ball mark + wordmark on the left; an announcements BELL then
// <run-weekday> · 7–10 PM on the right. `right` is accepted for backwards-compat but
// the mast is fixed; every caller follows it with <div class="rule"></div>.
// `weekdayShort` reflects the current run's day (defaults to FRI for pages with no run
// context). `ann` (optional) = the viewer's announcement state — when present the bell +
// its bottom-sheet panel render; when omitted (public / non-approved pages) neither does.
const header = (right = '', weekdayShort = 'FRI', ann = null, hours = '7–10 PM') => {
  const { btn, sheet } = annBell(ann);
  return `<div class="mast">
  <div class="bl">${BALL}<div class="wm"><b>THE BRIDGE</b><span>Adv Runs</span></div></div>
  <div class="mastr">${btn}<div class="when"><b>${esc(weekdayShort)}</b><span>${esc(hours)}</span></div></div>
</div>${sheet}`;
};

// Two-letter initials for avatar fallbacks.
const initials = (name = '') => name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';

// PHASE 2: general per-player photo upload. For now a single seeded avatar
// (Daniel, the host) maps by email → /avatars/daniel.jpg; everyone else falls
// back to initials. AVATAR_SEED is env-overridable so the seed isn't a hard
// dependency on one address.
const AVATAR_SEED = (process.env.AVATAR_SEED_EMAIL || 'danieljcheer@gmail.com').toLowerCase();
// Uploaded-photo registry: lowercased email -> { file, v }. server.js rebuilds this
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
  return String(email).toLowerCase() === AVATAR_SEED ? '/avatars/daniel.jpg' : '';
};
// Render an avatar: uploaded/seeded photo if present, else initials on a teal disc.
const avatarInner = (email, name) => {
  const url = avatarUrl(email);
  return url ? `<img src="${esc(url)}" alt="">` : esc(initials(name));
};
// Public avatar-URL resolver (single source of truth) — server.js reuses this for
// the /players/search JSON so the mention dropdown shows the same photo the chat does.
// Returns '' when the person has no photo (client falls back to initials).
export function avatarUrlFor(email) { return avatarUrl(email); }

// Group (Run Chat) glyph — a small three-person mark, drawn white to sit on the
// teal avatar disc. Reused by the check-in card, the inbox pin, and the chat bar.
const GROUP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:60%;height:60%"><circle cx="9" cy="9" r="3"/><path d="M3.5 19c0-3 2.5-4.5 5.5-4.5s5.5 1.5 5.5 4.5"/><path d="M16 6.2a3 3 0 0 1 0 5.6"/><path d="M17.5 14.6c2.3.4 4 1.8 4 4.4"/></svg>`;

// Role → badge markup (loudest first). p carries host/team/regular/guest flags.
const roleBadge = (p) => p.host ? '<span class="bdg host">★ Host</span>'
  : p.team ? '<span class="bdg team">◆ Team</span>'
  : p.regular ? '<span class="bdg core">★ Core</span>'
  : p.guest ? '<span class="bdg guest">Guest</span>'
  : '<span class="bdg reg">Regular</span>';
// One-word role label for row subtitles.
const roleWord = (p) => p.host ? 'Host' : p.team ? 'Team' : p.regular ? 'Core' : p.guest ? 'Guest' : 'Regular';

// Bottom tab bar — Check-in / Roster / Profile. Shown to every signed-in
// approved player (admins too) on the player-facing pages. Operator pages keep
// opsNav at the top instead.
const ICON = {
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

// ---------- STICKER PACK (Bridge / basketball themed, SVGs in public/stickers) ----------
// The single source of truth for the starter pack. server.js imports this to validate
// a `sticker=<name>` send against the known set (no upload path). Each name maps to
// /stickers/<name>.svg (served statically). Owner can add more files + names later.
export const STICKERS = ['ball', 'hoop', 'swish', 'fire', 'win', 'gameon', 'letsrun', 'jersey', 'gg', 'bridge'];
const stickerLabel = { ball: 'Basketball', hoop: 'Hoop', swish: 'Swish', fire: 'Fire', win: 'Win',
  gameon: 'Game on', letsrun: "Let's run", jersey: 'Jersey', gg: 'GG', bridge: 'The Bridge' };
// The tappable tray grid (hidden until the Sticker option is chosen). Each button is a
// type=button carrying data-sticker; composerMediaJS() fetch-sends it to the composer's
// action. Bubble-less SVGs render at ~110px in the thread once sent.
const stickerTray = () => `<div class="stickertray" id="stickertray" hidden>
    ${STICKERS.map(n => `<button type="button" class="stik" data-sticker="${esc(n)}" aria-label="${esc(stickerLabel[n] || n)}"><img src="/stickers/${esc(n)}.svg" alt="${esc(stickerLabel[n] || n)}" loading="lazy"></button>`).join('')}
  </div>`;

// Send-error notice text for the ?err= codes the composer routes bounce back with.
// slow = rate limit; big = >10 MB; type = not a real image (magic-byte reject);
// bad = multer/sharp failure. Shown above the thread so a dropped send isn't silent.
const SEND_ERRS = {
  slow: 'Sending too fast — your last message didn’t send. Wait a moment and try again.',
  big: 'That photo’s too large (max 10 MB). Pick a smaller one.',
  type: 'That file isn’t a supported image (JPEG, PNG, or WebP).',
  bad: 'Couldn’t send that photo — try again.',
  suspended: 'Your account is paused — you can read but not post right now. Reach out to the host.',
};
const sendErrNotice = (err) => err && SEND_ERRS[err]
  ? `<div class="notice warn ai">${esc(SEND_ERRS[err])}</div>` : '';

// A sticker is any image whose path is under /stickers/ — rendered larger + bubble-less.
const isSticker = (img) => typeof img === 'string' && img.startsWith('/stickers/');
// Seconds → m:ss (e.g. 72 → "1:12"). Empty for 0/absent so we never show "0:00".
const fmtDur = (s) => { s = Math.round(Number(s) || 0); if (!s) return ''; return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
// Shared bubble-inner renderer for BOTH the DM thread and the group room. Handles three
// shapes: sticker (bubble-less floating img), photo (img in a frame, optional caption
// below), or plain text. The image src is server-controlled + validated (not user text),
// but esc()'d anyway (defence in depth); any caption/body text is esc()'d. The pressable
// element stays `.mb` in every case so the long-press menu + lifted clone keep working.
const _EMPTY_MAP = new Map();
// Esc-SAFE @-mention linkify. Input `escapedBody` is ALREADY esc()'d. For each stored
// mention id we look up its name, escape it the SAME way, and — only if that exact
// escaped "@Name" substring appears in the escaped body — wrap it in an <a class="mention">.
// Because we match on the already-escaped text and never re-escape, injection is
// impossible: the id is numeric, the anchor text is the escaped name verbatim. Longest
// names first + private-use placeholders prevent one name matching inside another's text.
function linkifyMentions(escapedBody, mentions, mentionMap = _EMPTY_MAP) {
  if (!mentions) return escapedBody;
  const list = String(mentions).split(',').map(Number).filter(Boolean)
    .map(id => ({ id, name: mentionMap.get(id) })).filter(x => x.name)
    .sort((a, b) => esc(b.name).length - esc(a.name).length);
  if (!list.length) return escapedBody;
  let out = escapedBody;
  const subs = [];
  list.forEach((x, i) => {
    const needle = '@' + esc(x.name);
    if (out.indexOf(needle) === -1) return;   // name not present → skip gracefully
    const ph = 'M' + i + '';       // private-use placeholder (won't collide)
    out = out.split(needle).join(ph);
    subs.push([ph, `<a class="mention" href="/u/${x.id}">${needle}</a>`]);
  });
  subs.forEach(([ph, html]) => { out = out.split(ph).join(html); });
  return out;
}

function bubbleInner(m, mentionMap = _EMPTY_MAP) {
  // Voice message: a small CUSTOM player (play/pause + progress track + m:ss). Native
  // <audio controls> is deliberately avoided — MediaRecorder WebM carries no duration in
  // its header, so browsers report duration=Infinity and render a broken scrubber. We
  // drive the fill + label from audio_dur (client-reported, capped server-side) instead,
  // so progress is correct on every platform. src is server-derived (esc'd anyway).
  if (m.audio) {
    const dur = Math.round(Number(m.audio_dur) || 0);
    const d = fmtDur(dur) || '0:00';
    return `<div class="mbwrap"><div class="mb mb-voice" data-dur="${dur}">`
      + `<button type="button" class="vpp" aria-label="Play voice message"><span class="ic-play">${IC_PLAY}</span><span class="ic-pause">${IC_PAUSE}</span></button>`
      + `<div class="vtrack"><div class="vfill"></div></div>`
      + `<span class="vdur">${d}</span>`
      + `<audio class="vaudio" src="${esc(m.audio)}" preload="none"></audio>`
      + `</div></div>`;
  }
  // Video message: unlike the headerless WebM voice clips, real video containers carry
  // duration metadata, so the NATIVE <video> controls/scrubber work correctly on every
  // platform — no custom player needed. preload=metadata keeps the feed light (only the
  // poster frame + duration load until the viewer taps play). src is server-derived.
  if (m.video) {
    return `<div class="mbwrap"><div class="mb mb-video"><video class="mvideo" src="${esc(m.video)}" controls playsinline preload="metadata"></video></div></div>`;
  }
  const img = m.image;
  if (img && isSticker(img)) {
    return `<div class="mbwrap"><div class="mb mb-sticker"><img class="msticker" src="${esc(img)}" alt="Sticker" loading="lazy"></div></div>`;
  }
  if (img) {
    const cap = m.body ? `<div class="mcap">${linkifyMentions(esc(m.body), m.mentions, mentionMap)}</div>` : '';
    return `<div class="mbwrap"><div class="mb mb-img${m.body ? ' mb-cap' : ''}"><img class="mphoto" src="${esc(img)}" alt="Photo" loading="lazy">${cap}</div></div>`;
  }
  return `<div class="mbwrap"><div class="mb">${linkifyMentions(esc(m.body), m.mentions, mentionMap)}</div></div>`;
}

// Full-image lightbox — one delegated click handler (bound once) opens any tapped
// .mphoto in a fixed overlay; tapping the overlay or Esc closes it. Photos are already
// downscaled server-side (≤1600px), so "full" = the stored file. Enhancement-only:
// with JS off the img is just inline. Included on both messaging pages.
function lightboxScript() {
  return `<script>
  (function(){
    if(window.__lbBound) return; window.__lbBound=true;
    // iOS-exact media save: pull the file, then hand it to the native share sheet
    // (navigator.share with files → "Save Image" / "Save to Files" / "Save Video" on
    // iOS). Falls back to a direct download on desktop/Android, and to opening the file
    // in a new tab if even that is blocked. Exposed globally for the long-press "Save".
    window.__saveMedia=function(url){
      if(!url) return;
      var name=(url.split('/').pop()||'download').split('?')[0];
      fetch(url,{credentials:'same-origin'}).then(function(r){ return r.blob(); }).then(function(b){
        var file; try{ file=new File([b],name,{type:b.type||'application/octet-stream'}); }catch(e){ file=null; }
        if(file&&navigator.canShare&&navigator.canShare({files:[file]})&&navigator.share){
          navigator.share({files:[file]}).catch(function(){});
          return;
        }
        var u=URL.createObjectURL(b), a=document.createElement('a');
        a.href=u; a.download=name; document.body.appendChild(a); a.click();
        setTimeout(function(){ try{ a.remove(); URL.revokeObjectURL(u); }catch(e){} },1500);
      }).catch(function(){ try{ window.open(url,'_blank'); }catch(e){} });
    };
    var ov=null, cur='';
    function close(){ if(ov){ ov.hidden=true; ov.querySelector('img').removeAttribute('src'); cur=''; document.body.style.overflow=''; } }
    document.addEventListener('click',function(e){
      var im=e.target.closest&&e.target.closest('img.mphoto'); if(!im) return;
      e.preventDefault();
      if(!ov){ ov=document.createElement('div'); ov.className='lightbox'; ov.hidden=true;
        ov.innerHTML='<button type="button" class="lbsave" aria-label="Save photo">${IC_SAVE}<span>Save</span></button><img alt="">';
        document.body.appendChild(ov);
        ov.addEventListener('click',function(ev){ if(ev.target.closest('.lbsave')){ ev.stopPropagation(); window.__saveMedia(cur); return; } close(); }); }
      cur=im.getAttribute('src'); ov.querySelector('img').src=cur; ov.hidden=false; document.body.style.overflow='hidden';
    });
    document.addEventListener('keydown',function(e){ if(e.key==='Escape') close(); });
  })();
  </script>`;
}

// Voice-message player wiring (bound once, delegated so it survives client-router swaps).
// Each .mb-voice bubble holds a play/pause button, a progress track, an m:ss label, and a
// preload=none <audio>. Progress + the label are driven by data-dur (our known length),
// NOT audio.duration — MediaRecorder WebM reports Infinity. Tap-to-seek is best-effort
// (unseekable WebM just ignores the currentTime set). Playing one clip pauses any other.
function voicePlayerScript() {
  return `<script>
  (function(){
    if(window.__vpBound) return; window.__vpBound=true;
    function fmt(s){ s=Math.max(0,Math.round(s||0)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }
    function durOf(box,au){ var d=Number(box.getAttribute('data-dur'))||0; if(d>0)return d; return (au&&isFinite(au.duration)&&au.duration>0)?au.duration:0; }
    document.addEventListener('click',function(e){
      var tr=e.target.closest&&e.target.closest('.vtrack');
      if(tr){ var bx=tr.closest('.mb-voice'), a=bx&&bx.querySelector('.vaudio'); if(a){ var dr=durOf(bx,a); if(dr>0){ var r=tr.getBoundingClientRect(); var f=Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)); try{ a.currentTime=f*dr; }catch(_){} } } return; }
      var btn=e.target.closest&&e.target.closest('.vpp'); if(!btn) return;
      var box=btn.closest('.mb-voice'), au=box&&box.querySelector('.vaudio'); if(!au) return;
      if(au.paused){ var all=document.querySelectorAll('.vaudio'); for(var i=0;i<all.length;i++){ if(all[i]!==au) all[i].pause(); } au.play().catch(function(){}); }
      else au.pause();
    });
    function isVA(t){ return t&&t.classList&&t.classList.contains('vaudio'); }
    document.addEventListener('play',function(e){ if(isVA(e.target)){ var b=e.target.closest('.mb-voice'); if(b)b.classList.add('playing'); } },true);
    document.addEventListener('pause',function(e){ if(isVA(e.target)){ var b=e.target.closest('.mb-voice'); if(b)b.classList.remove('playing'); } },true);
    document.addEventListener('ended',function(e){ if(isVA(e.target)){ var b=e.target.closest('.mb-voice'); if(b){ b.classList.remove('playing'); var f=b.querySelector('.vfill'); if(f)f.style.width='0%'; var d=b.querySelector('.vdur'); if(d)d.textContent=fmt(durOf(b,e.target)); } } },true);
    document.addEventListener('timeupdate',function(e){ if(!isVA(e.target)) return; var b=e.target.closest('.mb-voice'); if(!b)return; var dr=durOf(b,e.target); var f=b.querySelector('.vfill'); if(f&&dr>0)f.style.width=Math.min(100,(e.target.currentTime/dr)*100)+'%'; var d=b.querySelector('.vdur'); if(d)d.textContent=fmt(e.target.currentTime); },true);
  })();
  </script>`;
}

// ---------- SHARED MESSAGE COMPOSER (group Chat + 1:1 DM) ----------
// A plain, robust <textarea name="body">: the native placeholder + native maxlength
// do the work, and the textarea submits its own value — so the FormData fetch-send AND
// the JS-off plain-form POST both carry the message with zero mirroring. (An earlier
// contenteditable variant was tried to hide the iOS keyboard form-accessory bar, but
// iOS 26 shows it regardless — pure downside: no JS-off send, nbsp/paste/execCommand
// edge cases — so it was reverted.) SCOPE: only the two message composers.
const COMPOSER_MAXLEN = 1000;
// Client-side video size cap — mirrors the server's CHAT_VIDEO_MAX_MB (same env, same
// process) so an over-cap clip is rejected BEFORE it uploads over Daniel's home
// connection through Funnel, rather than after a doomed full upload → 413.
const CHAT_VIDEO_MAX_MB = Number(process.env.CHAT_VIDEO_MAX_MB || 40);
// enctype=multipart/form-data so a JS-off Send still carries a picked photo (multer
// parses it; text-only sends are handled fine too). The fetch paths override the body
// so the enctype is inert for them. The attach (＋) button opens a small Photo/Sticker
// menu (see composerMediaJS): Photo triggers the hidden file input (auto-sends on pick);
// Sticker toggles the tray above the row. All media POSTs go to this same `action`.
const composerForm = (action, placeholder, { mentions = false } = {}) => `<form method="POST" action="${action}" class="composer${mentions ? ' voice-composer' : ''}" id="composer" enctype="multipart/form-data">
      <input type="hidden" name="reply_to" id="replyTo" value="">
      ${mentions ? '<input type="hidden" name="mentions" id="mentions" value="">' : ''}
      ${mentions ? '<div class="mentionbox" id="mentionbox" hidden></div>' : ''}
      <div class="replychip" id="replychip" hidden>Replying to <b id="replyname"></b><button type="button" class="rcx" onclick="clearReply()" aria-label="Cancel reply">${IC_CLOSE}</button></div>
      ${stickerTray()}
      <div class="attmenu" id="attmenu" hidden>
        <button type="button" class="attitem" id="attphoto">${IC_PHOTO}<span>Photo</span></button>
        ${mentions ? `<button type="button" class="attitem" id="attvideo">${IC_VIDEO}<span>Video</span></button>` : ''}
        <button type="button" class="attitem" id="attsticker">${IC_STICKER}<span>Sticker</span></button>
      </div>
      ${mentions ? `<div class="voicebar" id="voicebar" hidden>
        <span class="vrecdot" id="vrecdot"></span>
        <span class="vtime" id="vtime">0:00</span>
        <div class="vspacer"></div>
        <span class="vhint" id="vhint">Slide up to cancel</span>
      </div>` : ''}
      <div class="crow">
        <button type="button" class="cattach" id="cattach" aria-label="Add photo or sticker" aria-haspopup="true">${IC_PLUS}</button>
        <textarea name="body" id="cbody" rows="1" maxlength="${COMPOSER_MAXLEN}" placeholder="${esc(placeholder)}" aria-label="Message" enterkeyhint="enter" style="font-size:16px"></textarea>
        <button class="csend" type="submit" aria-label="Send">${IC_SEND}</button>
        ${mentions ? `<button type="button" class="cmic" id="cmic" aria-label="Hold to record a voice message">${IC_MIC}</button>` : ''}
      </div>
      <input type="file" id="cfile" name="image" accept="image/*" hidden>
      ${mentions ? `<input type="file" id="cvideo" name="video" accept="video/*" data-maxmb="${CHAT_VIDEO_MAX_MB}" hidden>` : ''}
    </form>`;
// Shared composer wiring — declares the cbody textarea and a minimal auto-grow
// (rows→scrollHeight, capped at 132px to match the CSS max-height). The send handlers
// read cbody.value directly; clearing is cbody.value='' + autoGrow().
const composerInitJS = () => `
        var cbody=document.getElementById('cbody');
        // autoGrow ALSO flips the composer between mic (empty) and send (has text) —
        // like iMessage. Every send path clears cbody.value then calls autoGrow(), so
        // the button reverts to the mic automatically. .has-text drives the CSS swap.
        function autoGrow(){ if(!cbody)return; cbody.style.height='auto'; cbody.style.height=Math.min(cbody.scrollHeight,132)+'px';
          var f=document.getElementById('composer'); if(f) f.classList.toggle('has-text',!!cbody.value.trim()); }
        if(cbody){ cbody.addEventListener('input',autoGrow); autoGrow(); }
        // Keep the keyboard open after sending (like iMessage): the send button
        // preventDefaults pointerdown so it never steals focus from the textarea, so
        // the box never blurs and iOS keeps the keyboard up.
        var csend=document.querySelector('.composer .csend');
        if(csend){ csend.addEventListener('pointerdown',function(e){ e.preventDefault(); }); }
        // ---- attach: Photo + Sticker ----------------------------------------
        // Wires the ＋ menu, the hidden file input (photo → resize/send on the server),
        // and the sticker tray. All send to the composer's own action via fetch; the
        // optimistic bubble echoes instantly, then window.__threadRefresh() reconciles.
        (function(){
          var cform=document.getElementById('composer'); if(!cform) return;
          var attach=document.getElementById('cattach'), menu=document.getElementById('attmenu');
          var tray=document.getElementById('stickertray'), cfile=document.getElementById('cfile');
          var threadEl=document.getElementById('thread');
          function bottom(){ try{ window.scrollTo(0,document.body.scrollHeight); }catch(e){} }
          function hideMenu(){ if(menu)menu.hidden=true; }
          function hideTray(){ if(tray)tray.hidden=true; }
          if(attach&&menu){ attach.addEventListener('click',function(e){ e.stopPropagation(); hideTray(); menu.hidden=!menu.hidden; }); }
          // Opening the + menu must NOT close the keyboard — stop the button stealing focus.
          if(attach){ attach.addEventListener('pointerdown',function(e){ e.preventDefault(); }); }
          var ap=document.getElementById('attphoto'); if(ap&&cfile){ ap.addEventListener('click',function(){ hideMenu(); cfile.click(); }); }
          var as=document.getElementById('attsticker'); if(as&&tray){ as.addEventListener('click',function(){ hideMenu(); tray.hidden=!tray.hidden; }); }
          // Outside-tap closes the ＋ menu / sticker tray. Bound ONCE at document level
          // (guarded) and re-queries the live nodes each event, so it stays correct
          // across client-router swaps that rebuild the composer.
          if(!window.__attDismissBound){ window.__attDismissBound=true;
            document.addEventListener('click',function(e){
              var m=document.getElementById('attmenu'), tr=document.getElementById('stickertray'),
                  at=document.getElementById('cattach'), st=document.getElementById('attsticker');
              if(m&&!m.hidden&&!m.contains(e.target)&&e.target!==at) m.hidden=true;
              if(tr&&!tr.hidden&&!tr.contains(e.target)&&e.target!==st&&!(at&&at.contains(e.target))) tr.hidden=true;
            });
          }
          // Photo: sniff+resize+store happens server-side; here we just upload the file.
          if(cfile){ cfile.addEventListener('change',function(){
            var f=cfile.files&&cfile.files[0]; if(!f) return;
            if(!window.fetch||!window.FormData){ return; } // JS-off fallback: user taps Send → native multipart POST
            var url; try{ url=URL.createObjectURL(f); }catch(e){ url=''; }
            if(url&&threadEl){ var d=document.createElement('div'); d.className='msg mine tail msg-in';
              var w=document.createElement('div'); w.className='mbwrap';
              var b=document.createElement('div'); b.className='mb mb-img';
              var im=document.createElement('img'); im.className='mphoto'; im.src=url; b.appendChild(im);
              w.appendChild(b); d.appendChild(w); threadEl.appendChild(d); bottom(); }
            var fd=new FormData(); fd.append('image',f);
            var rt=document.getElementById('replyTo'); if(rt&&rt.value) fd.append('reply_to',rt.value);
            cfile.value=''; if(window.clearReply)window.clearReply();
            fetch(cform.action,{method:'POST',body:fd,headers:{'X-Requested-With':'fetch'},credentials:'same-origin'})
              .then(function(r){ if(r.redirected&&r.url&&r.url.indexOf('err=')>=0){window.location.href=r.url;return;} if(window.__threadRefresh)window.__threadRefresh(); })
              .catch(function(){ location.reload(); });
          }); }
          // Video (group chat only): posts to /chat/video (JSON reply like voice). Optimistic
          // <video> bubble echoes instantly; a refresh reconciles (and clears it on failure).
          var cvideo=document.getElementById('cvideo');
          var av=document.getElementById('attvideo'); if(av&&cvideo){ av.addEventListener('click',function(){ hideMenu(); cvideo.click(); }); }
          if(cvideo){ cvideo.addEventListener('change',function(){
            var f=cvideo.files&&cvideo.files[0]; if(!f){ return; }
            var maxmb=Number(cvideo.getAttribute('data-maxmb'))||40;
            if(f.size>maxmb*1024*1024){ alert('That video is '+Math.round(f.size/1048576)+' MB — the limit is '+maxmb+' MB. Trim it or lower the quality and try again.'); cvideo.value=''; return; }
            if(!window.fetch||!window.FormData){ cvideo.value=''; return; }
            var url; try{ url=URL.createObjectURL(f); }catch(e){ url=''; }
            if(url&&threadEl){ var d=document.createElement('div'); d.className='msg mine tail msg-in';
              var w=document.createElement('div'); w.className='mbwrap';
              var b=document.createElement('div'); b.className='mb mb-video';
              var v=document.createElement('video'); v.className='mvideo'; v.src=url; v.controls=true; v.playsInline=true; v.preload='metadata'; b.appendChild(v);
              w.appendChild(b); d.appendChild(w); threadEl.appendChild(d); bottom(); }
            var fd=new FormData(); fd.append('video',f);
            var rt=document.getElementById('replyTo'); if(rt&&rt.value) fd.append('reply_to',rt.value);
            cvideo.value=''; if(window.clearReply)window.clearReply();
            fetch('/chat/video',{method:'POST',body:fd,headers:{'X-Requested-With':'fetch'},credentials:'same-origin'})
              .then(function(r){ if(!r.ok){ alert(r.status===413?'That video is too large to send.':r.status===415?'That file isn’t a video we can play.':'Couldn’t send the video — please try again.'); } if(window.__threadRefresh)window.__threadRefresh(); })
              .catch(function(){ location.reload(); });
          }); }
          // Sticker: validated server-side against the known set; sent as a form field.
          if(tray){ tray.addEventListener('click',function(e){
            var btn=e.target.closest&&e.target.closest('.stik'); if(!btn) return;
            var name=btn.getAttribute('data-sticker'); if(!name) return;
            hideTray();
            if(!window.fetch){ // JS-off: submit a throwaway form
              var f=document.createElement('form'); f.method='POST'; f.action=cform.action; f.style.display='none';
              var i=document.createElement('input'); i.name='sticker'; i.value=name; f.appendChild(i);
              document.body.appendChild(f); f.submit(); return;
            }
            if(threadEl){ var d=document.createElement('div'); d.className='msg mine tail msg-in';
              var w=document.createElement('div'); w.className='mbwrap';
              var b=document.createElement('div'); b.className='mb mb-sticker';
              var im=document.createElement('img'); im.className='msticker'; im.src='/stickers/'+name+'.svg'; b.appendChild(im);
              w.appendChild(b); d.appendChild(w); threadEl.appendChild(d); bottom(); }
            var body=new URLSearchParams(); body.append('sticker',name);
            var rt=document.getElementById('replyTo'); if(rt&&rt.value) body.append('reply_to',rt.value);
            if(window.clearReply)window.clearReply();
            fetch(cform.action,{method:'POST',body:body,headers:{'X-Requested-With':'fetch'},credentials:'same-origin'})
              .then(function(r){ if(r.redirected&&r.url&&r.url.indexOf('err=')>=0){window.location.href=r.url;return;} if(window.__threadRefresh)window.__threadRefresh(); })
              .catch(function(){ location.reload(); });
          }); }
        })();
        // ---- keyboard-attached composer (iOS): rest the composer ON the keyboard
        // + hide the tab bar while typing, positioned from live visualViewport
        // geometry so the send button never clips (fixed binds to the LAYOUT
        // viewport, which the iOS keyboard overlays without resizing). ----
        (function(){
          var vv=window.visualViewport; if(!vv) return;
          // Bound ONCE at document/vv/window level (guarded), delegated by re-querying
          // the composer + #cbody each frame — so it survives client-router swaps that
          // rebuild the composer, and no-ops on pages that have none (checkin/profile).
          if(window.__kbBound) return; window.__kbBound=true;
          var coarse=!!(window.matchMedia&&window.matchMedia('(pointer:coarse)').matches); // touch device → software keyboard
          var engaged=false, rafUntil=0, rafOn=false, lastCss='';
          function overlap(){ return Math.max(0, window.innerHeight - vv.height - vv.offsetTop); }
          function reset(comp){ engaged=false; lastCss=''; document.body.classList.remove('kb-open');
            if(comp){ comp.style.bottom=''; comp.style.left=''; comp.style.right=''; }
            document.documentElement.style.removeProperty('--kb'); }
          function sync(){
            var comp=document.querySelector('.composer'), cbody=document.getElementById('cbody');
            if(!comp||!cbody){ if(engaged||lastCss) reset(comp); return; }
            var kb=overlap();
            // Engage on focus. Overlay mode (Safari): kb>50. Resize mode (installed
            // PWA, where iOS shrinks the layout viewport): kb≈0 → rely on coarse pointer.
            var want=(document.activeElement===cbody)&&(kb>50||coarse);
            if(want){
              var css=kb+'|'+vv.offsetLeft+'|'+vv.width;
              if(css!==lastCss){ lastCss=css;
                comp.style.bottom=kb+'px'; comp.style.left=vv.offsetLeft+'px';
                comp.style.right=Math.max(0,window.innerWidth-vv.offsetLeft-vv.width)+'px';
                document.documentElement.style.setProperty('--kb',kb+'px'); }
              if(!engaged){ engaged=true;
                var atBottom=(window.innerHeight+window.scrollY)>=(document.body.scrollHeight-40);
                document.body.classList.add('kb-open');
                if(atBottom) window.scrollTo(0,document.body.scrollHeight); }
            } else if(engaged||lastCss){ reset(comp); }
          }
          function loop(){ if(performance.now()>rafUntil){rafOn=false;return;} sync(); requestAnimationFrame(loop); }
          function kick(){ rafUntil=performance.now()+700; if(!rafOn){rafOn=true;requestAnimationFrame(loop);} }
          document.addEventListener('focusin',function(e){ if(e.target&&e.target.id==='cbody') kick(); });
          document.addEventListener('focusout',function(e){ if(e.target&&e.target.id==='cbody') setTimeout(function(){sync();kick();},50); });
          vv.addEventListener('resize',kick); vv.addEventListener('scroll',kick);
          window.addEventListener('orientationchange',kick); window.addEventListener('resize',kick);
          document.addEventListener('visibilitychange',kick);
        })();
        // ---- voice message (Run Chat only): PUSH-AND-HOLD the mic ----------
        // The right-hand button is the mic when the box is empty, the send arrow once
        // you've typed (iMessage-style; autoGrow toggles .has-text). HOLD the mic to
        // record, RELEASE to send — slide up before releasing to cancel. Pointer capture
        // keeps the whole gesture on the mic. Rebinds to fresh nodes on each router swap.
        (function(){
          var mic=document.getElementById('cmic'); if(!mic) return;   // group chat only
          var cform=document.getElementById('composer'); if(!cform) return;
          var bar=document.getElementById('voicebar'), tEl=document.getElementById('vtime'),
              hint=document.getElementById('vhint'), dot=document.getElementById('vrecdot');
          var threadEl=document.getElementById('thread');
          var rec=null, stream=null, chunks=[], t0=0, timer=null, secs=0, mime='';
          var holding=false, cancelZone=false, startY=0, armed=false, tipTimer=null;
          function fmt(s){ s=Math.max(0,Math.round(s)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }
          function stopStream(){ if(stream){try{stream.getTracks().forEach(function(t){t.stop();});}catch(e){} stream=null;} }
          function cleanup(){ if(timer){clearInterval(timer);timer=null;} stopStream(); rec=null; armed=false;
            cform.classList.remove('vrecording','cancelzone'); if(bar){bar.hidden=true;bar.classList.remove('tip');} }
          function setCancel(cz){ if(cz===cancelZone)return; cancelZone=cz; cform.classList.toggle('cancelzone',cz); if(hint)hint.textContent=cz?'Release to cancel':'Slide up to cancel'; }
          function tick(){ secs=(Date.now()-t0)/1000; if(tEl)tEl.textContent=fmt(secs); if(secs>=300){ holding=false; finish(); } }
          function flashTip(msg){ if(!bar)return; if(tipTimer)clearTimeout(tipTimer);
            cform.classList.remove('vrecording','cancelzone'); if(dot)dot.hidden=true; if(tEl)tEl.textContent=''; if(hint)hint.textContent=msg;
            bar.classList.add('tip'); bar.hidden=false;
            tipTimer=setTimeout(function(){ if(!holding&&!armed){ bar.hidden=true; bar.classList.remove('tip'); if(dot)dot.hidden=false; if(tEl)tEl.textContent='0:00'; if(hint)hint.textContent='Slide up to cancel'; } tipTimer=null; },1100); }
          function startRecording(){
            if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia||typeof MediaRecorder==='undefined'){ holding=false; alert('Voice messages aren\\u2019t supported on this browser.'); return; }
            navigator.mediaDevices.getUserMedia({audio:true}).then(function(s){
              stream=s;
              if(!holding){ stopStream(); return; }          // released before the mic was ready → nothing to record
              chunks=[]; var opts={};
              if(MediaRecorder.isTypeSupported){ if(MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))opts={mimeType:'audio/webm;codecs=opus'}; else if(MediaRecorder.isTypeSupported('audio/webm'))opts={mimeType:'audio/webm'}; else if(MediaRecorder.isTypeSupported('audio/mp4'))opts={mimeType:'audio/mp4'}; }
              try{ rec=new MediaRecorder(stream,opts); }catch(e){ try{ rec=new MediaRecorder(stream); }catch(e2){ cleanup(); alert('Couldn\\u2019t start recording.'); return; } }
              mime=rec.mimeType||opts.mimeType||'audio/webm';
              rec.ondataavailable=function(e){ if(e.data&&e.data.size) chunks.push(e.data); };
              rec.onstop=function(){ var blob=new Blob(chunks,{type:mime}); var dur=Math.round(secs), cz=cancelZone, ss=secs, mm=mime; cleanup();
                if(cz||ss<0.5||!blob.size) return;            // slid to cancel / too short / empty → discard
                sendBlob(blob,dur,mm); };
              // Timeslice is REQUIRED on iOS Safari — without it ondataavailable can hand
              // back an empty blob. 120ms flushes data as we go.
              rec.start(120);
              armed=true; cform.classList.add('vrecording'); if(bar){bar.classList.remove('tip');bar.hidden=false;} if(dot)dot.hidden=false;
              secs=0; t0=Date.now(); if(tEl)tEl.textContent='0:00'; setCancel(false); timer=setInterval(tick,120);
            }).catch(function(){ holding=false; cleanup(); alert('Microphone access is needed for voice messages.'); });
          }
          function finish(){ if(rec&&rec.state!=='inactive'){ try{ rec.stop(); }catch(e){ cleanup(); } } else cleanup(); }
          function sendBlob(blob,dur,m){
            var ext=(m.indexOf('mp4')>=0||m.indexOf('m4a')>=0)?'m4a':(m.indexOf('ogg')>=0?'ogg':'webm');
            var fd=new FormData(); fd.append('audio',blob,'voice.'+ext); fd.append('dur',dur);
            var rt=document.getElementById('replyTo'); if(rt&&rt.value) fd.append('reply_to',rt.value);
            if(threadEl){ var d=document.createElement('div'); d.className='msg mine tail msg-in';
              var w=document.createElement('div'); w.className='mbwrap';
              var b=document.createElement('div'); b.className='mb mb-voice mb-vpending'; b.textContent='\\uD83C\\uDF99 '+fmt(dur);
              w.appendChild(b); d.appendChild(w); threadEl.appendChild(d); try{window.scrollTo(0,document.body.scrollHeight);}catch(e){} }
            if(window.clearReply)window.clearReply();
            fetch('/chat/voice',{method:'POST',body:fd,headers:{'X-Requested-With':'fetch'},credentials:'same-origin'})
              .then(function(r){ if(!r.ok){ return r.json().catch(function(){return{};}).then(function(j){ var msg=(j&&j.err==='big')?'That recording is too long to send.':(j&&j.err==='type')?'This recording format isn\\u2019t supported on your device.':'Couldn\\u2019t send the voice message.'; alert(msg); if(window.__threadRefresh)window.__threadRefresh(); }); } if(window.__threadRefresh)window.__threadRefresh(); })
              .catch(function(){ if(window.__threadRefresh)window.__threadRefresh(); });
          }
          mic.addEventListener('pointerdown',function(e){ if(holding)return; e.preventDefault(); holding=true; setCancel(false); startY=e.clientY; try{ mic.setPointerCapture(e.pointerId); }catch(_){} startRecording(); });
          mic.addEventListener('pointermove',function(e){ if(!holding||!armed)return; setCancel((startY-e.clientY)>70); });
          mic.addEventListener('pointerup',function(e){ if(!holding)return; holding=false; try{ mic.releasePointerCapture(e.pointerId); }catch(_){} var wasArmed=armed; finish(); if(!wasArmed) flashTip('Hold to record'); });
          mic.addEventListener('pointercancel',function(e){ if(!holding)return; holding=false; setCancel(true); finish(); });
          mic.addEventListener('contextmenu',function(e){ e.preventDefault(); });   // no iOS long-press callout
        })();`;

// ---------- @-MENTION AUTOCOMPLETE (Run Chat composer) ----------
// Detects an "@token" at the caret in #cbody, fetches /players/search?q=token, and
// shows a dropdown above the composer. Arrow/Enter/Tab or tap selects → the token is
// replaced with "@Full Name " in the textarea AND the picked applicant id is recorded
// in the hidden #mentions input (comma-separated). Dismisses on space-after-no-match,
// Esc, or blur. The dropdown is built with DOM textContent (never innerHTML of the
// server name) so a name like "<script>" can never inject. Enhancement-only: with the
// hidden #mentions input absent (DM composer) this whole block early-returns.
const mentionAutocompleteJS = () => `
        (function(){
          var ta=document.getElementById('cbody');
          var hid=document.getElementById('mentions');
          var box=document.getElementById('mentionbox');
          if(!ta||!hid||!box||!window.fetch) return;
          var items=[], active=-1, sel=[], tokenStart=-1, timer=null, seq=0;
          function initials(n){ n=(n||'').trim(); if(!n) return '?';
            var p=n.split(/\\s+/); return ((p[0]?p[0][0]:'')+(p[1]?p[1][0]:'')).toUpperCase()||'?'; }
          function clearBox(){ box.hidden=true; box.innerHTML=''; items=[]; active=-1; tokenStart=-1; }
          function findToken(){
            var pos=ta.selectionStart||0; var text=ta.value.slice(0,pos);
            var m=/(^|\\s)@([^\\s@]{0,40})$/.exec(text);
            if(!m){ tokenStart=-1; return null; }
            tokenStart=pos-m[2].length-1; return m[2];
          }
          function paint(){ var opts=box.querySelectorAll('.mopt');
            for(var i=0;i<opts.length;i++){ if(i===active) opts[i].classList.add('on'); else opts[i].classList.remove('on'); } }
          function render(list){
            box.innerHTML=''; items=list||[];
            if(!items.length){ box.hidden=true; active=-1; return; }
            active=0;
            items.forEach(function(p,i){
              var b=document.createElement('button'); b.type='button'; b.className='mopt'+(i===0?' on':'');
              if(p.avatar){ var im=document.createElement('img'); im.src=p.avatar; im.alt=''; b.appendChild(im); }
              else { var av=document.createElement('span'); av.className='mopt-av'; av.textContent=initials(p.name); b.appendChild(av); }
              var nm=document.createElement('span'); nm.className='mopt-n'; nm.textContent=p.name; b.appendChild(nm);
              b.addEventListener('mousedown',function(e){ e.preventDefault(); choose(i); });
              box.appendChild(b);
            });
            box.hidden=false;
          }
          function choose(i){
            var p=items[i]; if(!p||tokenStart<0){ clearBox(); return; }
            var pos=ta.selectionStart||0;
            var before=ta.value.slice(0,tokenStart), after=ta.value.slice(pos);
            var insert='@'+p.name+' ';
            ta.value=before+insert+after;
            var np=(before+insert).length; try{ ta.setSelectionRange(np,np); }catch(e){}
            if(sel.indexOf(String(p.id))<0) sel.push(String(p.id));
            hid.value=sel.join(',');
            clearBox(); ta.focus();
            try{ ta.dispatchEvent(new Event('input',{bubbles:true})); }catch(e){}
          }
          function doFetch(q){
            var my=++seq;
            fetch('/players/search?q='+encodeURIComponent(q),{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}})
              .then(function(r){ return r.ok?r.json():[]; })
              .then(function(list){ if(my!==seq) return; if(document.activeElement!==ta){ clearBox(); return; } render(list); })
              .catch(function(){ clearBox(); });
          }
          ta.addEventListener('input',function(){
            var tk=findToken();
            if(tk===null){ clearBox(); return; }
            if(timer)clearTimeout(timer);
            timer=setTimeout(function(){ doFetch(tk); },130);
          });
          ta.addEventListener('keydown',function(e){
            if(box.hidden||!items.length) return;
            if(e.key==='ArrowDown'){ e.preventDefault(); active=(active+1)%items.length; paint(); }
            else if(e.key==='ArrowUp'){ e.preventDefault(); active=(active-1+items.length)%items.length; paint(); }
            else if(e.key==='Enter'||e.key==='Tab'){ e.preventDefault(); choose(active<0?0:active); }
            else if(e.key==='Escape'){ e.preventDefault(); clearBox(); }
          });
          ta.addEventListener('blur',function(){ setTimeout(clearBox,150); });
        })();`;

// current = active tab key. Three tabs: Check-in · Chat · Profile. Per-tab unread
// counts: the Chat tab carries the group (Run Chat) unread; the Profile tab carries
// the 1:1 DM unread (host DMs live in Profile now). Either hides at 0. Callers pass
// { dm, group }. Pass a non-matching `current` (e.g. '') to highlight none.
const tabNav = (current, { dm = 0, group = 0, groupMention = 0 } = {}) => {
  const tab = (href, key, label, extra = '') => `<a href="${href}" class="tab${current === key ? ' on' : ''}">${ICON[key]}${label}${extra}</a>`;
  // groupMention > 0 → a DISTINCT "@" marker (teal) instead of the plain orange count,
  // so a mentioned player can tell "you were tagged" from ordinary unread at a glance.
  const badge = (n, mention = 0) => n > 0
    ? `<span class="tabbadge${mention > 0 ? ' mention' : ''}">${mention > 0 ? '@' : ''}${n > 9 ? '9+' : n}</span>`
    : '';
  return `<nav class="tabs"><div class="tabrow">
    ${tab('/checkin', 'checkin', 'Check-in')}
    ${tab('/chat', 'chat', 'Chat', badge(group, groupMention))}
    ${tab('/profile', 'profile', 'Profile', badge(dm))}
  </div></nav>`;
};

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
    var KEY='bridgeTourV1';
    try{ if(localStorage.getItem(KEY)) return; }catch(e){}
    var tour=document.getElementById('tour'); if(!tour||window.__tourStarted) return; window.__tourStarted=1;
    var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches;
    var supported=!!(window.__pushSupported&&window.__pushSupported()&&window.__pushStandalone&&window.__pushStandalone());
    var STEPS_ALL=[
      {ttl:"Welcome to the run 👋",txt:"Here’s a 20-second tour of the app."},
      {sel:'[data-tour="join"]',ttl:"Grab your spot",txt:"Tap “I’m in” each week to claim a spot. Spots are limited — first come, first served."},
      {sel:'.tabs a[href="/chat"]',ttl:"Run chat",txt:"Chat with the whole run — photos, plans and @mentions."},
      {sel:'.tabs a[href="/profile"]',ttl:"Your profile",txt:"Your stats, photo and settings live here."},
      {sel:'.bellbtn',ttl:"Announcements",txt:"Updates from the host show up here."},
      {ttl:"Turn on notifications",txt:"Get a ping for spot offers, announcements and @mentions — never miss out.",notif:true}
    ];
    var STEPS=[], i=0, hole=document.getElementById('tourhole'), tip=document.getElementById('tourtip'),
        ttl=document.getElementById('tourttl'), txt=document.getElementById('tourtxt'),
        next=document.getElementById('tournext'), dots=document.getElementById('tourdots');
    function done(){ try{localStorage.setItem(KEY,'1');}catch(e){} tour.hidden=true; document.body.style.overflow=''; }
    function place(){
      var s=STEPS[i], el=s.sel?document.querySelector(s.sel):null;
      document.getElementById('tourcatch').style.background = el ? 'transparent' : 'rgba(18,20,14,.72)';
      if(el){ try{el.scrollIntoView({block:'center'});}catch(e){}
        var r=el.getBoundingClientRect(), pad=8;
        hole.style.display='block';
        hole.style.left=(r.left-pad)+'px'; hole.style.top=(r.top-pad)+'px';
        hole.style.width=(r.width+pad*2)+'px'; hole.style.height=(r.height+pad*2)+'px';
        var th=tip.offsetHeight||150, top;
        if(r.bottom+th+16 < window.innerHeight) top=r.bottom+12; else top=Math.max(12, r.top-th-12);
        tip.style.top=top+'px';
        tip.style.left=Math.max(12, Math.min(window.innerWidth-tip.offsetWidth-12, r.left+r.width/2-tip.offsetWidth/2))+'px';
      } else {
        hole.style.display='none';
        tip.style.top=Math.max(12,(window.innerHeight-(tip.offsetHeight||160))/2)+'px';
        tip.style.left=Math.max(12,(window.innerWidth-tip.offsetWidth)/2)+'px';
      }
    }
    function render(){
      var s=STEPS[i]; ttl.textContent=s.ttl; txt.textContent=s.txt;
      var d=''; for(var k=0;k<STEPS.length;k++) d+='<i class="'+(k===i?'on':'')+'"></i>'; dots.innerHTML=d;
      next.textContent=s.notif?'Enable':(i===STEPS.length-1?'Done':'Next'); next.disabled=false; place();
    }
    function advance(){
      var s=STEPS[i];
      if(s.notif){ next.disabled=true; (window.__pushEnable?window.__pushEnable():Promise.resolve()).then(done,done); return; }
      if(i>=STEPS.length-1){ done(); return; }
      i++; render();
    }
    next.addEventListener('click',advance);
    document.getElementById('tourskip').addEventListener('click',done);
    document.getElementById('tourcatch').addEventListener('click',function(){ if(!STEPS[i].notif) advance(); });
    window.addEventListener('resize',function(){ if(!tour.hidden) place(); });
    setTimeout(function(){
      STEPS=STEPS_ALL.filter(function(s){ return !s.sel || document.querySelector(s.sel); });
      if(!supported) STEPS=STEPS.filter(function(s){ return !s.notif; });
      if(!STEPS.length){ try{localStorage.setItem(KEY,'1');}catch(e){} return; }
      tour.hidden=false; document.body.style.overflow='hidden'; render();
    }, (document.getElementById('splash')&&!reduce)?1700:350);
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
  #welcome .wtip{font-size:13px;color:var(--ink);background:#F1EEE6;border-radius:10px;padding:10px 12px;line-height:1.5;margin:0 0 16px}
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

// ---------- INTAKE FORM (public application → council votes) ----------
export function intakePage({ submitted = false, error = '', alreadyApproved = false } = {}) {
  if (alreadyApproved) {
    return HEAD('Already approved — Adv Runs', '', { wall: false }) + header() + `
      <div class="rule"></div>
      <span class="eyebrow">You're already in</span>
      <h1>You're already approved</h1>
      <p class="lead">This email is already cleared for the Adv Run — no need to re-apply. Just sign in with it to check in for Friday.</p>
      <a class="btn" href="/login">Sign in →</a>
    ` + FOOT;
  }
  if (submitted) {
    return HEAD('Applied — Adv Runs', '', { wall: false }) + header() + `
      <div class="rule"></div>
      <span class="eyebrow">You're in the queue</span>
      <h1>Application received</h1>
      <p class="lead">Thanks — the organizers have your info. Next step: come play on Mondays at our recreational open runs, 7–10PM. That's the tryout — they'll watch you play and decide on Adv spots from there. If you're approved, they'll send you the check-in link directly.</p>
      <div class="notice warn">Haven't signed the waiver yet? Do it now — you can't step on the floor without it.</div>
      ${qrBlock}
      <a class="btn ghost" href="/">Back</a>
    ` + FOOT;
  }
  return HEAD('Apply — The Bridge Adv Runs', '', { wall: false }) + header() + `
    <div class="rule"></div>
    <span class="eyebrow">Faith · Ball · Community</span>
    <h1>Faith. Ball. Community.</h1>
    <p class="lead">Hey — I'm Daniel, and I host the Advanced basketball runs at The Bridge. I first came here through the rec runs myself, and that's what led me to start exploring my faith. I started this run to build a community of Christ-like people who bond over basketball — and to open that same door for others. We play competitive ball and sometimes pause for a devotional; you don't have to share our faith to play, but it's part of who we are.</p>
    <p class="lead" style="margin-top:10px">The Adv Run is the competitive Friday run, and it's invite-based. Fill this out, then come to the <b>Monday recreational run</b> — that's the tryout. The organizers watch you play there and decide from there.</p>

    <div class="notice" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <span>Already applied or approved?</span>
      <a class="btn ghost sm" href="/login" style="width:auto">Sign in →</a>
    </div>

    ${error ? `<div class="notice bad">${esc(error)}</div>` : ''}

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

      <p class="tally-note" style="margin:14px 0 0">By submitting, you agree to our <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>, <a href="/terms" target="_blank" rel="noopener">Terms of Use</a>, and <a href="/conduct" target="_blank" rel="noopener">Code of Conduct</a>.</p>
      <div style="height:14px"></div>
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
export function loginPage({ sent = false, email = '', next = '', devLink = '', devCode = '', codeError = '', error = '' } = {}) {
  if (sent) {
    return HEAD('Check your email', '', { wall: false }) + header() + `
      <div class="rule"></div>
      <h1>Check your email</h1>
      <p class="lead">We emailed <b>${esc(email)}</b> a 6-digit code. Expires in 15 minutes.</p>
      ${installSteps}
      ${codeEntryCard(email, next, codeError, devCode)}
      ${devLink ? `<div class="notice warn">DEV MODE link:<br><a href="${esc(devLink)}">${esc(devLink)}</a></div>` : ''}
      <div class="notice">On a computer? Tap the link in the email instead. Didn't get it? Check spam, then <a href="/login${next ? '?next=' + encodeURIComponent(next) : ''}">request a fresh code</a>.</div>
      <a class="btn ghost" href="/checkin">Back</a>
    ` + FOOT;
  }
  return HEAD('Sign in — Adv Runs', '', { wall: false }) + header() + `
    <div class="rule"></div>
    <span class="eyebrow">Approved players</span>
    <h1>Sign in to check in</h1>
    <p class="lead">Enter the email you applied with — we'll email you a 6-digit code (no password). You do this <b>once</b> on this device, then you're signed in for good — no more codes.</p>
    ${error ? `<div class="notice warn">${esc(error)}</div>` : ''}
    <form method="POST" action="/login" class="card rail">
      <input type="hidden" name="next" value="${esc(next)}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@email.com">
      <p class="tally-note" style="margin:8px 0 0">Use the exact email you applied with, or we won't recognize you.</p>
      <div style="height:14px"></div>
      <button class="btn" type="submit" id="sendbtn"><span class="spin" aria-hidden="true"></span><span class="btnlabel">Email my code</span></button>
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
export function invitePage({ invalid = false, used = false, checkEmail = false, token = '', full_name = '', phone = '', email = '', error = '', devLink = '', devCode = '', codeError = '' } = {}) {
  if (checkEmail) {
    // Invite claimed, but the submitted email wasn't proven (no admin pre-fill match),
    // so we didn't open a session — we emailed a code + link to verify it.
    return HEAD('Check your email — Adv Runs', '', { wall: false }) + header() + `
      <div class="rule"></div>
      <span class="eyebrow">Almost there</span>
      <h1>Check your email</h1>
      <p class="lead">You're approved — we just need to confirm it's you. We emailed <b>${esc(email)}</b> a 6-digit code. Expires in 15 minutes.</p>
      ${installSteps}
      ${codeEntryCard(email, '/checkin', codeError, devCode)}
      ${devLink ? `<div class="notice warn">DEV MODE link:<br><a href="${esc(devLink)}">${esc(devLink)}</a></div>` : ''}
      <div class="notice">On a computer, tap the link in the email instead. Didn't get it? Check spam, then <a href="/login">request a fresh code</a>.</div>
      ${homeScreenCard}
      <a class="btn ghost" href="/login">Back to sign in</a>
    ` + FOOT;
  }
  if (invalid) {
    return HEAD('Invite not found — Adv Runs', '', { wall: false }) + header() + `
      <div class="rule"></div>
      <h1>That link isn't valid</h1>
      <p class="lead">This invite link doesn't exist. Double check you copied the whole link, or ask whoever sent it for a fresh one.</p>
      <a class="btn ghost" href="/login">Already have an account? Sign in</a>
    ` + FOOT;
  }
  if (used) {
    return HEAD('Invite already used — Adv Runs', '', { wall: false }) + header() + `
      <div class="rule"></div>
      <h1>This invite's already been used</h1>
      <p class="lead">Each invite link works once. If that was you, just sign in below. If it wasn't, ask an organizer for a fresh link.</p>
      <a class="btn" href="/login">Sign in</a>
    ` + FOOT;
  }
  return HEAD("You're invited — Adv Runs", '', { wall: false }) + header() + `
    <div class="rule"></div>
    <span class="eyebrow">You're pre-approved</span>
    <h1>Finish setting up your spot</h1>
    <p class="lead">An organizer's already cleared you for the Adv Run — just confirm your info and you're in, no application, no waiting.</p>
    ${error ? `<div class="notice bad">${esc(error)}</div>` : ''}
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

export function checkinPage({ email, status, runLabel, runDate, hours = '7–10 PM', startLabel = '7 PM', tipoff = 0, cap, waitlistCap, going, waiting, full, runFull, isOpen, canSeeCount, regularSlotsFull,
                             myState, myWaitPos, myOffer = null, offerWindowHours = 3, iAmTeam, iAmRegular, iOptedOut, iAutoRenew,
                             viewerIsAdmin, canOperate, canSeeRoster, suspended = false, suspendReason = '', myConfirmed = false, msg = '', bannerVer = '4', cancelled = false, locked = false, announcement = null, announcementLog = [], inPlayers, offeredPlayers = [], waitPlayers, host = null, dmUnread = 0, groupUnread = 0, groupMention = 0, ann = null }) {

  // Not cleared to play yet (admins always get through — they run the check-in)
  if (!viewerIsAdmin && status !== 'approved') {
    const pill = status === 'rejected' ? '<span class="pill rejected">Not this season</span>'
      : status === 'pending' ? '<span class="pill pending">Under review</span>'
      : '<span class="pill pending">Not on the list</span>';
    return HEAD('Check-in — Adv Runs') + header() + `
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
  let action = '';
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
    action = `<form method="POST" action="/checkin/optin"><button class="btn primary" type="submit" data-tour="join">I'm in</button></form>`;
  } else if (iAmTeam && iAutoRenew && (myState === 'in' || (!isOpen && !iOptedOut))) {
    // team auto-joins on open; give them a self-clear
    action = `<form method="POST" action="/checkin/optout"><button class="btn ghost" type="submit">Sit out</button></form>`;
  } else if (myState === 'in') {
    action = `<form method="POST" action="/checkin/leave"><button class="btn ghost" type="submit">Sit out</button></form>`;
  } else if (myState === 'waitlist') {
    action = `<form method="POST" action="/checkin/leave"><button class="btn ghost" type="submit">Leave waitlist (#${myWaitPos})</button></form>`;
  } else if (locked) {
    // Locked at 2 PM — roster is set. Players already in can still Sit out (handled above,
    // which frees the spot to the waitlist). No new self-sign-ups; a host can add a +1.
    action = `<button class="btn" type="button" disabled>Check-in locked</button>`;
  } else if (!isOpen && iAmRegular && regularSlotsFull) {
    action = `<button class="btn" type="button" disabled>Early spots full — opens to all soon</button>`;
  } else if (!isOpen && iAmRegular) {
    // regulars can join while closed — shown as a normal join, no role wording
    action = `<form method="POST" action="/checkin/join"><button class="btn primary" type="submit" data-tour="join">I'm in</button></form>`;
  } else if (!isOpen && iAmTeam) {
    // team keep pre-access even with auto-renew off — manual join while closed
    action = `<form method="POST" action="/checkin/join"><button class="btn primary" type="submit" data-tour="join">I'm in</button></form>`;
  } else if (!isOpen) {
    action = `<button class="btn" type="button" disabled>Check-in closed</button>`;
  } else if (runFull) {
    action = `<button class="btn" type="button" disabled>Run &amp; waitlist full</button>`;
  } else if (full) {
    action = `<form method="POST" action="/checkin/join"><button class="btn primary" type="submit">Join waitlist (${waiting}/${waitlistCap})</button></form>`;
  } else {
    action = `<form method="POST" action="/checkin/join"><button class="btn primary" type="submit" data-tour="join">I'm in</button></form>`;
  }

  // Run-day confirm/release: a floor player either confirms they're coming or frees the
  // spot via the normal Sit-out. Independent of `action` so it rides alongside it.
  const confirmCta = (myState === 'in' && !suspended)
    ? (myConfirmed
        ? `<div class="notice good" style="margin-top:10px">✓ Confirmed. Can't make it? Sit out to free your spot for the waitlist.</div>`
        : `<form method="POST" action="/checkin/confirm" style="margin-top:10px"><button class="btn primary" type="submit">✓ I'm coming</button></form>`)
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
    mine = `<div class="notice warn">Registration opens <b>Wednesday night</b> for approved players — spots are capped at ${cap}, so get in early once it's live. The organizer opens it manually and will announce it.</div>`;
  } else if (myState === 'in') {
    mine = '';  // "You're on the floor for Friday ✓" removed per owner — redundant with the Sit-out button
  } else if (myState === 'waitlist') {
    mine = `<div class="notice warn">You're <b>#${myWaitPos}</b> on the waitlist. If a spot opens you'll be emailed and have ${offerWindowHours} hour${offerWindowHours === 1 ? '' : 's'} to claim it before it passes to the next person.</div>`;
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
        ? `<form method="POST" action="/checkin/close" style="margin:0"><button class="btn leave" type="submit">Close check-in</button></form>`
        : `<form method="POST" action="/checkin/open" style="margin:0"><button class="btn primary" type="submit">Open check-in</button></form>`)
    : '';

  // ----- announcement compose (operators only; folded into the teal hero) -----
  const annCompose = canOperate
    ? `<details class="announce-compose"><summary>Send announcement</summary>
        <form method="POST" action="/announce" style="margin-top:10px">
          <textarea name="body" required maxlength="500" placeholder="e.g. No run this Friday — gym's booked. Back next week."></textarea>
          <div style="height:8px"></div>
          <label class="lvl" style="margin:0 0 8px"><input type="checkbox" name="email_everyone" checked> Also email everyone</label>
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
    ? `<a class="hchat" href="/chat" aria-label="Group chat${groupUnread > 0 ? `, ${groupUnread} unread` : ''}">
        <span class="hci">${GROUP_ICON}</span>Group chat${groupUnread > 0 ? '<span class="hdot" aria-hidden="true"></span>' : ''}
      </a>`
    : '';
  // ----- hero footer: Send announcement (operators, LEFT) + Auto-renew (team, RIGHT) -----
  const heroFooter = (annCompose || autoRenewPill)
    ? `<div class="hann"><div class="hann-l">${annCompose}</div>${autoRenewPill ? `<div class="hann-r">${autoRenewPill}</div>` : ''}</div>`
    : '';
  // ----- operator "Add a guest" — sits on the RIGHT of the hbar (Checked in /
  //       Waitlist) row; expands the last-minute guest-add form (POST /checkin/guest,
  //       unchanged). Only rendered for operators. -----
  const addGuest = canOperate
    ? `<details class="hguest">
        <summary>+ Guest</summary>
        <form method="POST" action="/checkin/guest">
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
      <div class="hsub"><span class="hdate">${cancelled ? 'cancelled' : locked ? 'roster locked' : isOpen ? 'registration live' : (iAmRegular || iAmTeam ? '' : 'queue opens wed')}</span></div>
      ${heroFooter}
    </div>`;

  // ----- "Who's going" overlay (opens on top of the page; no navigation) -----
  // Read-only for players; for operators (canOperate) each row gains its floor-
  // management control — Remove on floor rows, Bump-in + Remove on waitlist rows
  // (same POST targets as the old Roster tab). These POST normally (302 → /checkin);
  // the check-in fetch-swap interceptor only catches `.controls form`, not these.
  const wgRemoveForm = (p) => `<form method="POST" action="/checkin/remove" style="margin:0"><input type="hidden" name="email" value="${esc(p.email)}"><button class="btn leave sm" type="submit" title="Remove">Remove</button></form>`;
  const wgBumpForm = (p) => `<form method="POST" action="/checkin/promote" style="margin:0"><input type="hidden" name="email" value="${esc(p.email)}"><button class="btn sm" type="submit" title="Move into the run">Bump in</button></form>`;
  const wgRow = (p, n) => `<div class="lr"><span class="ln">${n}</span><span class="lav">${avatarInner(p.email, p.name)}</span><span class="lnm">${esc(p.name)}${p.email === email ? ' <span class="tag">You</span>' : ''}${p.confirmed_at ? ' <span class="tag reg" title="Confirmed">✓</span>' : ''}</span>${roleBadge(p)}${canOperate ? wgRemoveForm(p) : ''}</div>`;
  // Held offer row — the spot is taken (counts toward the floor) but the person hasn't
  // confirmed yet, so it's shown as "claiming" rather than as a settled floor player.
  const wgOfferRow = (p) => `<div class="lr"><span class="ln">·</span><span class="lav wl">${avatarInner(p.email, p.name)}</span><span class="lnm">${esc(p.name)}${p.email === email ? ' <span class="tag">You</span>' : ''} <span class="tag">⏳ Claiming</span></span>${canOperate ? wgRemoveForm(p) : ''}</div>`;
  const wgWaitRow = (p, i) => `<div class="lr"><span class="ln">W${i}</span><span class="lav wl">${avatarInner(p.email, p.name)}</span><span class="lnm">${esc(p.name)}</span>${canOperate ? wgBumpForm(p) + wgRemoveForm(p) : ''}</div>`;
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

  return HEAD(`${wdayFull(runDate)} Check-in — Adv Runs`, 'has-tabs') + header(`<b>CHECK-IN</b>${esc(email)}`, wdayShort(runDate), ann, hours) + WELCOME_MODAL + `
    ${opsNav('checkin', { isAdmin: viewerIsAdmin, isTeam: iAmTeam })}
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
        if(!window.__pushSupported||!window.__pushSupported()||!window.__pushStandalone||!window.__pushStandalone())return;
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
    ${(action || runToggle) ? `<div class="controls">${action}${runToggle}</div>` : ''}
    ${confirmCta}
    ${infoSection}
    ${wgSheet}

    ${qrBlock}
    <div style="height:28px"></div>
    ${locationBlock}
    <div class="foot" style="margin-top:12px"><a href="/logout">Sign out</a></div>
    <script>
      // Who's-going overlay. Open is instant; close plays a slide-down (unless
      // reduced-motion / noanim) with the state flip only at the end.
      window.wgOpen=function(){var w=document.getElementById('wgwrap');if(w){window.__ovPrev=document.activeElement;w.classList.add('open');document.body.style.overflow='hidden';var sh=w.querySelector('.wgsheet');if(sh){sh.setAttribute('tabindex','-1');try{sh.focus();}catch(e){}}}};
      window.wgClose=function(){var w=document.getElementById('wgwrap');if(!w)return;var sh=w.querySelector('.wgsheet');
        var still=document.documentElement.classList.contains('noanim')||(window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches);
        function restore(){var p=window.__ovPrev;if(p&&p.focus)try{p.focus();}catch(e){}}
        if(sh&&!still){sh.classList.add('closing');setTimeout(function(){w.classList.remove('open');sh.classList.remove('closing');document.body.style.overflow='';restore();},200);}
        else{w.classList.remove('open');document.body.style.overflow='';restore();}};

      // (.wrap swap engine — window.__swapWrap — now lives once in ANIM_HEAD, shared
      // by these check-in action fetches and the client tab router.)

      // Intercept the check-in action forms (I'm in / Sit out / Open / Close …)
      // AND the hero-footer auto-renew toggle (.arform): POST via fetch, then swap
      // .wrap in place so the page doesn't navigate and the scroll position is kept
      // (auto-renew toggling in place — pill flips ON/OFF with no full-screen flash).
      // Optimistic button state + a hero-count pulse give instant feedback. Bound
      // once at document level so it survives swaps. Degrades gracefully: with JS off
      // (or fetch/DOMParser missing) the plain form still POSTs and the route
      // 302-redirects as before.
      if(!window.__ckControlsBound){ window.__ckControlsBound=true;
        document.addEventListener('submit',function(e){
          var form=e.target.closest&&e.target.closest('.controls form, .arform');
          if(!form)return;
          if(!window.fetch||!window.DOMParser||!window.__swapWrap)return;
          e.preventDefault();
          var btn=form.querySelector('button[type=submit],button:not([type])');
          if(btn){btn.classList.add('is-busy');btn.setAttribute('aria-busy','true');}
          var y=window.scrollY;
          // Guard: while this user's own action fetch is in flight, a poll-driven swap
          // must not race it and clobber the optimistic state (see __ckOnChange).
          window.__ckBusy=true;
          fetch(form.action,{method:'POST',body:new URLSearchParams(new FormData(form)),headers:{'X-Requested-With':'fetch'},credentials:'same-origin'})
            .then(function(r){return r.text();})
            .then(function(html){
              // suppress entry-reveal replay for the in-place swap (a swap isn't a
              // fresh nav); the count pulse below carries the visual feedback.
              document.documentElement.classList.add('noanim');
              window.__ckBusy=false;
              if(!window.__swapWrap(html)){window.location.href='/checkin';return;}
              window.scrollTo(0,y);
              var n=document.querySelector('.count .n');
              if(n){n.classList.remove('pulse-now');void n.offsetWidth;n.classList.add('pulse-now');}
            })
            .catch(function(){window.__ckBusy=false;window.location.href='/checkin';});
        });
      }

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
        var want=location.pathname.indexOf('/checkin')===0&&document.visibilityState==='visible';
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
  ` + footWithTabs(tabNav('checkin', { dm: dmUnread, group: groupUnread, groupMention }));
}

// ---------- CLAIM RESULT (waitlist offer landing page) ----------
// Shown after tapping a spot-offer claim link (from the email or the in-app banner).
// ok=true → they're in for Friday; ok=false → the offer expired / was already claimed.
export function claimResultPage({ ok = false, runLabel = '', runDate = '', startLabel = '7 PM' } = {}) {
  if (ok) {
    return HEAD("You're in — Adv Runs", '', { wall: false }) + header('', wdayShort(runDate)) + `
      <div class="rule"></div>
      <span class="eyebrow">Spot claimed</span>
      <h1>You're in for ${wdayFull(runDate)} ✓</h1>
      <p class="lead">Your spot's locked in${runLabel ? ` for <b>${esc(runLabel)}</b>` : ''}. See you on the floor — ${esc(startLabel)}, enter at the back.</p>
      <a class="btn" href="/checkin">Go to check-in →</a>
    ` + FOOT;
  }
  return HEAD('Offer expired — Adv Runs', '', { wall: false }) + header('', wdayShort(runDate)) + `
    <div class="rule"></div>
    <span class="eyebrow">Too late</span>
    <h1>This offer has passed</h1>
    <p class="lead">That spot's already been claimed or the offer window closed, so it's moved on to the next person. If you'd still like to play, head to check-in and hop on the waitlist — you'll be offered the next spot that opens.</p>
    <a class="btn" href="/checkin">Go to check-in →</a>
  ` + FOOT;
}

// Month-year label from a YYYY-MM-DD (or SQL datetime) string.
const fmtMonthYear = (s) => {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T').slice(0, 19) + (String(s).length > 10 ? 'Z' : 'T12:00:00'));
  return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
};

// ---------- CHAT (standalone group Run Chat page — the Chat tab) ----------
// The group Run Chat is its own full page now. Page chrome (masthead + a Run Chat
// section header) + the shared chatFragment (feed + pinned composer + reload/scroll
// script). body.has-chat reserves room for the composer sitting just above the
// bottom tab bar. Mark-read happens in the GET /chat route.
export function chatPage({ me, chat, runDate = '', hours = '7–10 PM', dmUnread = 0, groupUnread = 0, groupMention = 0, ann = null }) {
  const members = chat.members || [];
  // Member row → tappable link to their profile. Role flags map to the shared roleBadge.
  const memRow = (p) => {
    const flags = { host: !!p.is_host, team: !!p.is_team, regular: !!p.is_regular };
    return `<a class="lr" href="/u/${p.id}">
      <span class="lav">${avatarInner(p.email, p.full_name)}</span>
      <span class="lnm">${esc(p.full_name)}${p.email === me ? ' <span class="tag">You</span>' : ''}</span>
      ${roleBadge(flags)}
    </a>`;
  };
  // Members overlay — reuses the who's-going bottom-sheet (.wgwrap/.wgsheet/.wgscrim).
  // Its own memOpen/memClose so the chat page's #thread refresh never disturbs it.
  const membersSheet = `
    <div id="memwrap" class="wgwrap">
      <div class="wgscrim" onclick="memClose()"></div>
      <div class="wgsheet" role="dialog" aria-modal="true" aria-label="Run members">
        <div class="wgsheet-h"><b>Run members · ${members.length}</b><button class="wgx" type="button" onclick="memClose()" aria-label="Close">${IC_CLOSE}</button></div>
        <div class="wgsheet-b">
          ${members.length ? members.map(memRow).join('') : '<div class="subh">No members yet.</div>'}
        </div>
      </div>
    </div>`;
  return HEAD('Run Chat — Adv Runs', 'has-chat') + header('', wdayShort(runDate), ann, hours) + WELCOME_MODAL + `
    <div class="rule"></div>
    <div class="chatsec chatsec-top">
      <div class="chatsec-h chatsec-tap" role="button" tabindex="0" onclick="memOpen()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();memOpen()}" aria-label="View run members">
        <span class="chav">${GROUP_ICON}</span>
        <div class="chatsec-t"><b>Run Chat</b><span>${chat.memberCount} member${chat.memberCount === 1 ? '' : 's'} · talk to the whole run</span></div>
        <span class="chatsec-chev" aria-hidden="true">›</span>
      </div>
    </div>
    ${chatFragment(chat)}
    ${membersSheet}
    <script>
      // Members bottom-sheet. Open is instant; close plays a slide-down (unless
      // reduced-motion / noanim). Mirrors the who's-going overlay wgOpen/wgClose.
      window.memOpen=function(){var w=document.getElementById('memwrap');if(w){window.__ovPrev=document.activeElement;w.classList.add('open');document.body.style.overflow='hidden';var sh=w.querySelector('.wgsheet');if(sh){sh.setAttribute('tabindex','-1');try{sh.focus();}catch(e){}}}};
      window.memClose=function(){var w=document.getElementById('memwrap');if(!w)return;var sh=w.querySelector('.wgsheet');
        var still=document.documentElement.classList.contains('noanim')||(window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches);
        function restore(){var p=window.__ovPrev;if(p&&p.focus)try{p.focus();}catch(e){}}
        if(sh&&!still){sh.classList.add('closing');setTimeout(function(){w.classList.remove('open');sh.classList.remove('closing');document.body.style.overflow='';restore();},200);}
        else{w.classList.remove('open');document.body.style.overflow='';restore();}};
    </script>
  ` + footWithTabs(tabNav('chat', { dm: dmUnread, group: groupUnread, groupMention }));
}

// ---------- PROFILE (view another player) ----------
export function profilePage({ p, stats, isSelf = false, canContact = false, runDate = '', hours = '7–10 PM', dmUnread = 0, groupUnread = 0, groupMention = 0, ann = null }) {
  const badges = [
    p.is_host ? '<span class="bdg host">★ Host</span>' : '',
    p.is_team ? '<span class="bdg team">◆ Team</span>' : (p.is_regular ? '<span class="bdg core">★ Core</span>' : ''),
    (!p.is_host && !p.is_team && !p.is_regular) ? '<span class="bdg reg">Regular</span>' : '',
    isSelf ? '<span class="tag">YOU</span>' : '',
  ].join('');
  const hostcall = p.is_host
    ? `<div class="hostcall"><div class="ic">?</div><div class="tx"><b>Host of the run</b><span>Come to me with any questions about the night — I organize it.</span></div></div>`
    : '';
  const contact = canContact
    ? `<div class="contact"><div class="ck">Contact</div><div class="cv">${esc(p.full_name)}<br><a href="tel:${esc(p.phone)}">${esc(p.phone)}</a><br><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></div></div>`
    : '';
  const prowBtns = [];
  // Phase 2: host contact moves in-app (shown to everyone, not just operators).
  if (p.is_host && !isSelf) prowBtns.push(`<a class="btn primary" href="/messages/${p.id}">Message the host</a>`);
  if (canContact) prowBtns.push(`<a class="btn ghost" href="tel:${esc(p.phone)}">Call</a>`);
  if (canContact && !p.is_host) prowBtns.push(`<a class="btn ghost" href="sms:${esc(p.phone)}">Text</a>`);
  if (isSelf) prowBtns.push(`<a class="btn ghost" href="/profile">Edit profile</a>`);
  const prow = prowBtns.length ? `<div class="prow">${prowBtns.join('')}</div>` : '';
  return HEAD('Profile — Adv Runs', 'has-tabs') + header('', wdayShort(runDate), ann, hours) + WELCOME_MODAL + `
    <div class="rule"></div>
    <a class="pback" href="/chat">‹ Back</a>
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
  ` + footWithTabs(tabNav(isSelf ? 'profile' : '', { dm: dmUnread, group: groupUnread, groupMention }));
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
export function profileTabPage({ a, stats, saved = false, error = '', dmUnread = 0, groupUnread = 0, groupMention = 0, canOperate = false, announcementLog = [], iAmHost = false, threads = [], runDay = null, rdMsg = '', photoMsg = '', ann = null }) {
  // The own-profile tab is a chromeless editor (its own .bar, no masthead), so the
  // global announcements bell lives in the .bar rather than the .mast here. Same
  // button + panel + JS as every other page (one shared affordance, one live dot).
  const { btn: annBtn, sheet: annSheet } = annBell(ann);
  const POS = [['PG', 'Point'], ['SG', 'Shoot'], ['SF', 'Small F'], ['PF', 'Power F'], ['C', 'Center']];
  // Host/admin-only: move a given week's run to a different weekday. Compact,
  // collapsed-by-default <details> so it never breaks the profile's no-scroll fit.
  // The date input is font-size:16px (zero iOS zoom) with a 44px tap target; min =
  // today. POSTs to /admin/rundate. A separate reset form clears an active override.
  const rdBanner = rdMsg === 'set' ? '<div class="notice good">Run day updated ✓</div>'
    : rdMsg === 'past' ? '<div class="notice bad">Pick a date that isn\'t in the past.</div>'
    : rdMsg === 'range' ? '<div class="notice bad">Pick a date within the next 30 days.</div>'
    : rdMsg === 'time' ? '<div class="notice bad">Check the times — end must be after start.</div>'
    : rdMsg === 'bad' ? '<div class="notice bad">That date didn\'t look right — try again.</div>'
    : '';
  const ti = 'font-size:16px;min-height:44px;padding:11px 13px;width:100%;box-sizing:border-box;max-width:100%;min-width:0';
  const runDaySection = runDay ? `
    <details class="announce-compose" style="margin-top:12px">
      <summary>Run day · ${esc(runDay.weekday)}, ${esc(runDay.label)} · ${esc(runDay.timeLabel)}${runDay.isOverride ? ' (moved)' : ''}</summary>
      ${rdBanner}
      <p class="tally-note" style="margin:8px 0 10px">The next run is <b>${esc(runDay.weekday)}, ${esc(runDay.label)}, ${esc(runDay.timeLabel)}</b>${runDay.dateMoved ? ` — moved from the usual Friday (${esc(runDay.defaultLabel)}).` : (runDay.isOverride ? ' — usual day, custom time.' : ' (its usual day & time).')} Change the date and/or time — players get an announcement.</p>
      <form method="POST" action="/admin/rundate" style="margin:0">
        <div class="field"><label>Run date</label>
          <input type="date" name="date" value="${esc(runDay.runDate)}" min="${esc(runDay.today)}" max="${esc(runDay.maxDate)}" required style="${ti}">
        </div>
        <div style="display:flex;gap:10px;margin-top:8px">
          <div class="field" style="flex:1;margin:0"><label>Start</label>
            <input type="time" name="start" value="${esc(runDay.start)}" required style="${ti}">
          </div>
          <div class="field" style="flex:1;margin:0"><label>End</label>
            <input type="time" name="end" value="${esc(runDay.end)}" required style="${ti}">
          </div>
        </div>
        <label class="lvl" style="margin:10px 0 8px;display:block"><input type="checkbox" name="email_everyone" checked> Also email everyone</label>
        <button class="btn sm" type="submit">Set run day & time</button>
      </form>
      ${runDay.isOverride ? `<form method="POST" action="/admin/rundate" style="margin-top:8px">
        <input type="hidden" name="date" value="${esc(runDay.defaultFriday)}">
        <input type="hidden" name="email_everyone" value="1">
        <button class="btn ghost sm" type="submit">Reset to Friday 7–10 PM (${esc(runDay.defaultLabel)})</button>
      </form>` : ''}
      <div class="rule" style="margin:14px 0 12px"></div>
      ${runDay.cancelled
        ? `<div class="notice bad" style="margin:0 0 10px"><b>🚫 This run is cancelled.</b> Players see it on the check-in page and were notified. Restore it to run check-in again.</div>
           <form method="POST" action="/admin/run/cancel" style="margin:0"><input type="hidden" name="on" value="0"><button class="btn ghost sm" type="submit">Restore this run</button></form>`
        : `<p class="tally-note" style="margin:0 0 8px">Something come up? Cancel this week's run — players get a "run cancelled" notification and check-in is blocked. (Only this week; next week is unaffected.)</p>
           <form method="POST" action="/admin/run/cancel" style="margin:0" onsubmit="return confirm('Cancel this week\\'s run? Everyone will be notified it\\'s off.');"><input type="hidden" name="on" value="1"><button class="btn leave sm" type="submit">🚫 Cancel this week's run</button></form>`}
    </details>` : '';
  // Host-only: the DM inbox (players who messaged the host) lives on the host's own
  // profile tab now — there is no Messages tab. Players never see an inbox here.
  const inbox = iAmHost
    ? `<div id="dminbox">
       <div class="subhead" style="margin-top:16px">Messages${dmUnread > 0 ? ` <span class="mdot" style="display:inline-block;vertical-align:middle;margin-left:4px">${dmUnread > 9 ? '9+' : dmUnread}</span>` : ''}</div>
       ${threads.length
        ? `<div class="mlist">${inboxRows(a.email, threads)}</div>`
        : `<div class="mempty"><div class="mei">💬</div><b>No messages yet</b><p>When a player messages you, their thread shows up here.</p></div>`}
       </div>`
    : '';
  // Operator-only: the announcement history (moved here off the check-in page).
  const annHistory = (canOperate && announcementLog.length)
    ? `<details class="announce-compose" style="margin-top:12px"><summary>Announcement history (${announcementLog.length})</summary>
        <ul class="annlog">
          ${announcementLog.map(x => `<li>
            <div class="annlog-b">${esc(x.body)}</div>
            <div class="annlog-m">
              <span class="annlog-state ${x.archived ? 'past' : 'live'}">${x.archived ? 'Cleared' : 'Live'}</span>
              Posted ${esc(fmtWhen(x.at))}${x.author ? ' · ' + esc(x.author) : ''}${x.archived && x.archived_at ? ' · cleared ' + esc(fmtWhen(x.archived_at)) : ''}
            </div>
          </li>`).join('')}
        </ul>
      </details>`
    : '';
  const selected = new Set((a.position || '').split(',').map(s => s.trim()).filter(Boolean));
  const chips = POS.map(([v, l]) =>
    `<label class="chip"><input type="checkbox" name="position" value="${v}" hidden${selected.has(v) ? ' checked' : ''}>${v}<small>${l}</small></label>`).join('');
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
  return HEAD('Your profile — Adv Runs', 'has-tabs') + WELCOME_MODAL + `
    <form id="photoform" method="POST" action="/profile/photo" enctype="multipart/form-data" style="display:none">
      <input id="photoinput" type="file" accept="image/*" name="photo" onchange="if(this.files&&this.files[0]){this.form.submit()}">
    </form>
    <form id="photoremove" method="POST" action="/profile/photo/remove" style="display:none"></form>
    <form method="POST" action="/profile" class="pedit">
      <div class="bar"><a class="bk" href="/checkin">‹ Back</a><span class="ti">Profile</span><span class="baracts">${annBtn}<button class="dn" type="submit">Save</button></span></div>
      ${saved ? '<div class="notice good">Saved ✓</div>' : ''}
      ${error ? `<div class="notice bad">${esc(error)}</div>` : ''}
      ${photoNotice}
      <div class="idrow">
        <label class="pic" for="photoinput" title="Change photo" aria-label="Change profile photo">${avatarInner(a.email, a.full_name)}<span class="cam">✎</span></label>
        <div class="field idfield">
          <label>Display name${a.is_host ? '<span class="hostpill">★ Host</span>' : ''}<span class="phactions">${hasAvatar ? '<button type="submit" form="photoremove" class="phbtn">Remove photo</button>' : '<span class="phsoon">Tap photo</span>'}</span></label>
          <input name="full_name" value="${esc(a.full_name)}" required autocomplete="name">
        </div>
      </div>
      <div class="two">
        <div class="field"><label>Phone</label><input name="phone" value="${esc(a.phone)}" inputmode="tel" required autocomplete="tel"></div>
        <div class="field"><label>Email</label><input name="email" type="email" value="${esc(a.email)}" required autocomplete="email"></div>
      </div>
      <div class="sec"><div class="lb"><b>Position</b><span>Tap to toggle</span></div><div class="chips">${chips}</div></div>
      <div class="sec"><div class="lb"><b>Email</b></div>
        <label class="lvl" style="display:block"><input type="checkbox" name="email_announce" value="1"${a.email_optout ? '' : ' checked'}> Email me announcements &amp; run-day changes</label>
        <p class="tally-note" style="margin:6px 0 0">Sign-in links and waitlist spot offers are always sent.</p>
      </div>
      <div class="statcard">
        <div class="g">${stats.total}<em> gp</em></div>
        <div class="d">Games attended · Member since ${esc(memberSince)}<br>${stats.season} this season · ${stats.streak}-run streak${a.is_host ? ' · ★ Host' : ''}</div>
      </div>
    </form>
    <div id="pushctl" class="card" style="margin-top:12px;padding:14px" hidden>
      <b style="font-size:14px">Game-day notifications</b>
      <p class="tally-note" id="pushnote" style="margin:6px 0 10px">Spot offers, announcements and mentions — right on your phone.</p>
      <button class="btn ghost sm" type="button" id="pushbtn">Enable notifications</button>
    </div>
    ${runDaySection}
    ${inbox}
    ${annHistory}
    ${annSheet}
    <div class="foot signout"><a href="/checkin" onclick="try{localStorage.removeItem('bridgeTourV1');}catch(e){}window.__tourStarted=0;">↻ Replay app tour</a> · <a href="/logout">Sign out</a></div>
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
  ` + footWithTabs(tabNav('profile', { dm: dmUnread, group: groupUnread, groupMention }));
}

// ---------- MESSAGES: day / clock helpers (SQL UTC → server-local) ----------
const _mDate = (sqlUtc) => new Date(String(sqlUtc).replace(' ', 'T') + 'Z');
const dayKey = (sqlUtc) => { const d = _mDate(sqlUtc); return isNaN(d) ? '' : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const fmtClock = (sqlUtc) => { const d = _mDate(sqlUtc); return isNaN(d) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); };
const fmtDay = (sqlUtc) => {
  const d = _mDate(sqlUtc);
  if (isNaN(d)) return '';
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startToday - startThat) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
};
const REACTION_SET = ['❤️', '👍', '👎', '😂', '‼️', '❓'];

// ---------- MESSAGES: press-and-hold context menu (iMessage-style) ----------
// One shared, self-contained script for BOTH the DM thread and the group Run Chat.
// A long-press (~480ms) or desktop right-click on a message bubble raises a floating
// tapback reaction row ABOVE the bubble and a small Reply/Copy/Delete menu BELOW it,
// over a dimmed scrim. All per-message context (id, POST targets, delete permission,
// reply target) travels as data-* attributes on the .msg element — set by each
// renderer — so this code has no per-thread branching. Reactions/deletes reuse the
// existing POST endpoints (/chat/react|/chat/delete, /messages/react) via a throwaway
// form; Reply reuses window.setReply; Copy uses the clipboard. Degrades cleanly:
//   - JS off: no menu (and no always-on icons) — reading + sending still work as
//     plain form POSTs; react/reply/delete are enhancement-only, as in iMessage.
//   - reduced-motion / html.noanim: the rise animation is suppressed (CSS), so the
//     menu appears instantly with no scale/spring.
// Dismisses on scrim tap, Esc, scroll, or the 20s soft-reload (it is never persisted).
function longPressScript() {
  return `<script>
  (function(){
    if(window.__lpBound) return; window.__lpBound=true;
    var STD=${JSON.stringify(REACTION_SET)};
    var IC={reply:${JSON.stringify(IC_REPLY)},copy:${JSON.stringify(IC_COPY)},del:${JSON.stringify(IC_TRASH)},pin:${JSON.stringify(IC_PIN)},save:${JSON.stringify(IC_SAVE)}};
    var menu=null, active=null, timer=null, sx=0, sy=0;
    function build(){
      if(menu) return;
      menu=document.createElement('div'); menu.className='lpmenu'; menu.hidden=true;
      // scrim (dim, no blur) · lpclone (lifted full-opacity copy of the bubble) ·
      // lpreact (reaction row, floats above the clone) · lpacts (Reply/Copy/Delete,
      // sits below the clone). JS positions all three from the pressed bubble's rect.
      menu.innerHTML='<div class="lpscrim"></div><div class="lpclone"></div><div class="lpreact"></div><div class="lpacts"></div>';
      document.body.appendChild(menu);
      menu.querySelector('.lpscrim').addEventListener('click',close);
    }
    function close(){
      if(!menu||menu.hidden) return;
      menu.hidden=true;
      var cl=menu.querySelector('.lpclone'); if(cl){ cl.innerHTML=''; cl.className='lpclone'; cl.removeAttribute('style'); }
      if(active){active.classList.remove('lp-active'); active=null;}
      document.body.style.overflow='';
    }
    function post(url,fields){
      // Fetch-POST react/delete, then patch #thread in place (no full-page flash).
      // Degrades to a real form POST when fetch is unavailable.
      if(window.fetch){
        fetch(url,{method:'POST',body:new URLSearchParams(fields),headers:{'X-Requested-With':'fetch'},credentials:'same-origin'})
          .then(function(){ close(); if(window.__threadRefresh)window.__threadRefresh(); })
          .catch(function(){ location.reload(); });
        return;
      }
      var f=document.createElement('form'); f.method='POST'; f.action=url; f.style.display='none';
      for(var k in fields){var i=document.createElement('input'); i.type='hidden'; i.name=k; i.value=fields[k]; f.appendChild(i);}
      document.body.appendChild(f); f.submit();
    }
    function act(label,icon,cls){
      var b=document.createElement('button'); b.type='button'; b.className='lpact'+(cls?(' '+cls):'');
      b.innerHTML='<span>'+label+'</span>'+icon; return b;
    }
    function showEmojiInput(url,mid,msg){
      var rr=menu.querySelector('.lpreact'); rr.innerHTML='';
      var wrap=document.createElement('span'); wrap.className='lpfree';
      var inp=document.createElement('input'); inp.maxLength=8; inp.autocomplete='off'; inp.placeholder='＋'; inp.setAttribute('aria-label','Custom emoji');
      var add=document.createElement('button'); add.type='button'; add.className='lpr lpadd'; add.textContent='Add';
      add.addEventListener('click',function(){ var e=(inp.value||'').trim(); if(e) post(url,{message_id:mid,emoji:e}); });
      wrap.appendChild(inp); wrap.appendChild(add); rr.appendChild(wrap);
      position(msg); try{inp.focus();}catch(e){}
    }
    function openFor(msg){
      build();
      var mid=msg.getAttribute('data-mid'); if(!mid) return;
      var reactUrl=msg.getAttribute('data-reacturl');
      var delUrl=msg.getAttribute('data-delurl');
      var canDel=msg.getAttribute('data-candel')==='1';
      var replyId=msg.getAttribute('data-reply-id');
      var replyNm=msg.getAttribute('data-reply-nm')||'';
      var bodyEl=msg.querySelector('.mb'); var text=bodyEl?bodyEl.textContent:'';
      var rr=menu.querySelector('.lpreact'); rr.innerHTML=''; rr.style.display=reactUrl?'':'none';
      if(reactUrl){
        STD.forEach(function(e){
          var b=document.createElement('button'); b.type='button'; b.className='lpr'; b.textContent=e;
          b.addEventListener('click',function(){ post(reactUrl,{message_id:mid,emoji:e}); });
          rr.appendChild(b);
        });
        var more=document.createElement('button'); more.type='button'; more.className='lpr lpmore'; more.setAttribute('aria-label','More emoji'); more.textContent='＋';
        more.addEventListener('click',function(){ showEmojiInput(reactUrl,mid,msg); });
        rr.appendChild(more);
      }
      var ra=menu.querySelector('.lpacts'); ra.innerHTML='';
      if(replyId){
        var rb=act('Reply',IC.reply);
        rb.addEventListener('click',function(){ close(); if(window.setReply) window.setReply(replyId,replyNm); });
        ra.appendChild(rb);
      }
      if(text&&text.trim()){
        var cb=act('Copy',IC.copy);
        cb.addEventListener('click',function(){ try{navigator.clipboard&&navigator.clipboard.writeText(text);}catch(e){} close(); });
        ra.appendChild(cb);
      }
      // Save (photos, voice memos + videos) → iOS share sheet / download (see __saveMedia).
      var saveUrl=msg.getAttribute('data-save');
      if(saveUrl){
        var svb=act('Save',IC.save);
        svb.addEventListener('click',function(){ close(); if(window.__saveMedia) window.__saveMedia(saveUrl); });
        ra.appendChild(svb);
      }
      if(msg.getAttribute('data-canpin')==='1'){
        var isPinned=msg.getAttribute('data-pinned')==='1', pinUrl=msg.getAttribute('data-pinurl');
        var pb=act(isPinned?'Unpin':'Pin',IC.pin);
        pb.addEventListener('click',function(){ close();
          var f=document.createElement('form'); f.method='POST'; f.action=pinUrl; f.style.display='none';
          var i=document.createElement('input'); i.name='message_id'; i.value=mid; f.appendChild(i);
          document.body.appendChild(f); f.submit(); });   // native POST → PRG reload updates the pinned bar
        ra.appendChild(pb);
      }
      if(canDel){
        var xb=act('Delete',IC.del,'danger');
        xb.addEventListener('click',function(){ if(confirm('Delete this message?')) post(delUrl,{message_id:mid}); });
        ra.appendChild(xb);
      }
      // Lift: clone JUST the bubble (.mb) into a fixed overlay above the scrim, at
      // full opacity, carrying the msg mine/theirs/tail classes so the bubble
      // gradient + tail radius match. The original stays dimmed in the page beneath.
      // The clone is display-only (pointer-events:none); the action buttons above
      // still target the real message id via mid/reactUrl/delUrl captured above.
      var clone=menu.querySelector('.lpclone');
      var mineC=msg.classList.contains('mine');
      clone.className='lpclone msg '+(mineC?'mine':'theirs')+(msg.classList.contains('tail')?' tail':'');
      clone.innerHTML=bodyEl?bodyEl.outerHTML:'';   // already-escaped DOM → no re-escape / no injection
      active=msg; msg.classList.add('lp-active');
      menu.hidden=false; document.body.style.overflow='hidden';
      position(msg);
    }
    // Place the lifted clone over the pressed bubble, the reaction row just ABOVE it,
    // the Reply/Copy/Delete menu just BELOW it — all edge-aligned to the bubble side
    // (mine=right, theirs=left) and clamped on-screen. If the row would clip the top
    // or the menu would clip the bottom, the whole group shifts vertically (the clone
    // lifts off its original spot) so nothing lands under the screen edges / keyboard.
    function position(msg){
      var bodyEl=msg.querySelector('.mb'); if(!bodyEl) return;
      var r=bodyEl.getBoundingClientRect();
      var vw=window.innerWidth, vh=window.innerHeight, pad=8, padB=16, gap=8;
      var clone=menu.querySelector('.lpclone');
      var rr=menu.querySelector('.lpreact'), ra=menu.querySelector('.lpacts');
      var mine=msg.classList.contains('mine');
      clone.style.width=r.width+'px';
      var rw=rr.offsetWidth, rh=rr.offsetHeight, aw=ra.offsetWidth, ah=ra.offsetHeight, bh=r.height;
      // Ideal: clone stays where the bubble is. Clamp so the row fits above and the
      // menu fits below; the reactive-row floor wins if the screen is too short.
      var cloneTop=r.top;
      var minTop=pad+rh+gap;                 // room for the reaction row above
      var maxTop=vh-padB-ah-gap-bh;          // room for the menu below
      if(cloneTop>maxTop) cloneTop=maxTop;
      if(cloneTop<minTop) cloneTop=minTop;
      clone.style.top=cloneTop+'px';
      clone.style.left=r.left+'px';
      var rTop=cloneTop-gap-rh;
      var rLeft=mine?(r.right-rw):r.left; rLeft=Math.min(Math.max(pad,rLeft), vw-rw-pad);
      rr.style.top=rTop+'px'; rr.style.left=rLeft+'px';
      var aTop=cloneTop+bh+gap;
      var aLeft=mine?(r.right-aw):r.left; aLeft=Math.min(Math.max(pad,aLeft), vw-aw-pad);
      ra.style.top=aTop+'px'; ra.style.left=aLeft+'px';
    }
    function tgt(e){ var b=e.target.closest&&e.target.closest('.mb'); return b?b.closest('.msg[data-mid]'):null; }
    document.addEventListener('pointerdown',function(e){
      if(e.button===2) return;
      var m=tgt(e); if(!m) return;
      sx=e.clientX; sy=e.clientY;
      timer=setTimeout(function(){ timer=null; openFor(m); }, 480);
    },true);
    document.addEventListener('pointermove',function(e){
      if(timer&&(Math.abs(e.clientX-sx)>10||Math.abs(e.clientY-sy)>10)){ clearTimeout(timer); timer=null; }
    },true);
    function cancel(){ if(timer){ clearTimeout(timer); timer=null; } }
    document.addEventListener('pointerup',cancel,true);
    document.addEventListener('pointercancel',cancel,true);
    window.addEventListener('scroll',function(){ cancel(); close(); },true);
    document.addEventListener('contextmenu',function(e){ var m=tgt(e); if(!m) return; e.preventDefault(); openFor(m); });
    // Kill iOS's native selection/callout ("Copy · Look Up · Translate") on a bubble
    // long-press so ONLY our menu shows.
    document.addEventListener('selectstart',function(e){ if(e.target&&e.target.closest&&e.target.closest('.msg')) e.preventDefault(); });
    document.addEventListener('keydown',function(e){ if(e.key==='Escape') close(); });
    // Existing tapback chips (already-shown reactions) also route through fetch → a
    // #thread patch, so toggling one doesn't full-reload. Degrades to a plain POST.
    document.addEventListener('submit',function(e){
      var f=e.target.closest&&e.target.closest('form.tbf');
      if(!f||!window.fetch)return;
      e.preventDefault();
      fetch(f.action,{method:'POST',body:new URLSearchParams(new FormData(f)),headers:{'X-Requested-With':'fetch'},credentials:'same-origin'})
        .then(function(){ if(window.__threadRefresh)window.__threadRefresh(); })
        .catch(function(){ location.reload(); });
    });
  })();
  </script>`;
}

// ---------- MESSAGES: thread (iMessage-clean, foil system) ----------
export function threadPage({ me, p, msgs = [], reactions = new Map(), parents = new Map(), canPost = true, unread = 0, err = '' }) {
  const name = p.full_name;
  // index of my last outgoing message → carries the Read/Delivered line
  let lastMineIdx = -1;
  msgs.forEach((m, i) => { if (m.from_email === me) lastMineIdx = i; });

  let body = '', prevKey = null, prev = null;
  msgs.forEach((m, i) => {
    const mine = m.from_email === me;
    const k = dayKey(m.created_at);
    if (k !== prevKey) { body += `<div class="mday"><span>${esc(fmtDay(m.created_at))}</span></div>`; prevKey = k; prev = null; }
    const gap = (a, b) => Math.abs(_mDate(a) - _mDate(b));
    const grouped = prev && prev.from_email === m.from_email && gap(m.created_at, prev.created_at) < 120000;
    const next = msgs[i + 1];
    const nextSame = next && next.from_email === m.from_email && dayKey(next.created_at) === k && gap(next.created_at, m.created_at) < 120000;
    const tail = !nextSame;

    let stub = '';
    if (m.reply_to) {
      const par = parents.get(m.reply_to);
      if (par) {
        const who = par.from_email === me ? 'You' : esc(name);
        const txt = par.body ? esc(par.body.slice(0, 60)) : '📷 Photo';
        stub = `<div class="mquote"><b>${who}</b> · ${txt}</div>`;
      } else {
        stub = `<div class="mquote muted">Original message unavailable</div>`;
      }
    }

    const rx = reactions.get(m.id) || [];
    const chips = rx.length ? `<div class="tapbacks">${rx.map(r => `<form method="POST" action="/messages/react" class="tbf">
        <input type="hidden" name="message_id" value="${m.id}"><input type="hidden" name="emoji" value="${esc(r.emoji)}">
        <button class="tb${r.mine ? ' mine' : ''}" type="submit" title="Toggle reaction">${esc(r.emoji)}${r.count > 1 ? ` <span>${r.count}</span>` : ''}</button>
      </form>`).join('')}</div>` : '';

    const time = tail ? `<div class="mt">${esc(fmtClock(m.created_at))}</div>` : '';
    const state = (mine && i === lastMineIdx) ? `<div class="mstate">${m.read_at ? 'Read' : 'Delivered'}</div>` : '';

    // Press-and-hold affordances travel as data-* (read by longPressScript). Reply
    // is offered only while the viewer can still post; DMs have no delete endpoint,
    // so no delete action is offered here.
    const lpData = `data-mid="${m.id}" data-reacturl="/messages/react"`
      + (canPost ? ` data-reply-id="${m.id}" data-reply-nm="${esc(mine ? 'You' : name)}"` : '');

    body += `<div class="msg ${mine ? 'mine' : 'theirs'}${grouped ? ' grouped' : ''}${tail ? ' tail' : ''}" ${lpData}>
        ${stub}
        ${bubbleInner(m)}
        ${chips}${time}${state}
      </div>`;
    prev = m;
  });

  if (!msgs.length) {
    body = `<div class="mstart"><div class="mstartav">${avatarInner(p.email, name)}</div><b>${esc(name)}</b><p>${canPost ? 'Say hi 👋 — this is the start of your conversation.' : 'No messages here yet.'}</p></div>`;
  }

  const composer = canPost
    ? composerForm('/messages/' + p.id, 'Message')
    : `<div class="composer disabled">You can no longer message here.</div>`;

  return HEAD('Messages — Adv Runs', 'thread-page') + WELCOME_MODAL + `
    <div class="pbar">
      <a class="pbback" href="/profile" aria-label="Back">${IC_BACK}</a>
      <a class="pbwho" href="/u/${p.id}">
        <span class="pbav">${avatarInner(p.email, name)}</span>
        <span class="pbnm">${esc(name)}${p.is_host ? '<small>★ Host</small>' : ''}</span>
      </a>
    </div>
    ${sendErrNotice(err)}
    <div class="thread" id="thread">${body}</div>
    ${composer}
    <script>
      (function(){
        var thread=document.getElementById('thread');
        var tid=${JSON.stringify('t' + p.id)};
        function toBottom(){ window.scrollTo(0, document.body.scrollHeight); }
        // Restore scroll after a 20s auto-reload; land at newest on a fresh open.
        try{
          var saved=sessionStorage.getItem('sc-'+tid);
          if(saved!==null){ var o=JSON.parse(saved); if(o.bottom) toBottom(); else window.scrollTo(0,o.y); sessionStorage.removeItem('sc-'+tid); }
          else toBottom();
        }catch(e){ toBottom(); }
${composerInitJS()}
        // reply wiring
        window.setReply=function(id,nm){ var r=document.getElementById('replyTo'),c=document.getElementById('replychip'),n=document.getElementById('replyname'); if(!r)return; r.value=id; if(n)n.textContent=nm; if(c)c.hidden=false; if(cbody)cbody.focus(); };
        window.clearReply=function(){ var r=document.getElementById('replyTo'),c=document.getElementById('replychip'); if(r)r.value=''; if(c)c.hidden=true; };
        // (reply/react/delete now live in the press-and-hold menu — see longPressScript)
        // Patch ONLY #thread from a fresh fetch of THIS thread — composer untouched, so
        // typing / reply-chip / focus survive. Shared by fetch-send + the long-press menu.
        window.__threadRefresh=function(){
          if(!window.fetch||!window.DOMParser)return;
          var atBottom=(window.innerHeight+window.scrollY)>=(document.body.scrollHeight-40);
          fetch(location.pathname,{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}})
            .then(function(r){return r.text();})
            .then(function(html){var doc=new DOMParser().parseFromString(html,'text/html');
              var nt=doc.getElementById('thread'); if(nt)thread.innerHTML=nt.innerHTML;
              if(atBottom)toBottom();})
            .catch(function(){});
        };
        // optimistic send: bubble instantly, then fetch-send (no full-page flash)
        var form=document.getElementById('composer');
        if(form&&cbody){ form.addEventListener('submit',function(e){
          var txt=cbody.value.trim(); if(!txt){ e.preventDefault(); return; } // empty → no send, no native full-page reload (photos/stickers have their own upload path)
          var d=document.createElement('div'); d.className='msg mine tail msg-in';
          var w=document.createElement('div'); w.className='mbwrap';
          var b=document.createElement('div'); b.className='mb'; b.textContent=txt;   // textContent = no HTML injection
          w.appendChild(b); d.appendChild(w); thread.appendChild(d); toBottom();
          if(!window.fetch) return; // no-fetch (JS off) → native POST carries the textarea body
          e.preventDefault();
          var body=new URLSearchParams(new FormData(form));
          cbody.value=''; autoGrow(); if(window.clearReply)window.clearReply();
          fetch(form.action,{method:'POST',body:body,headers:{'X-Requested-With':'fetch'},credentials:'same-origin'})
            .then(function(r){ if(r.redirected&&r.url&&r.url.indexOf('err=slow')>=0){window.location.href=r.url;return;} window.__threadRefresh(); })
            .catch(function(){ window.location.href=location.pathname; });
        }); }
        // Legacy light refresh — DM threads stay on the 20s full reload (poll page
        // conversion is a P1 follow-up); paused while composing, scroll saved.
        setInterval(function(){
          if(document.visibilityState!=='visible') return;
          if(cbody&&(document.activeElement===cbody||cbody.value.trim())) return;
          try{ var atBottom=(window.innerHeight+window.scrollY)>=(document.body.scrollHeight-40); sessionStorage.setItem('sc-'+tid,JSON.stringify({y:window.scrollY,bottom:atBottom})); }catch(e){}
          window.__reload();
        }, 20000);
      })();
    </script>
    ${longPressScript()}
    ${lightboxScript()}
  ` + FOOT;
}

// ---------- RUN CHAT: the shared group room fragment (rendered inside chatPage) ----------
// Returns ONLY the message feed + pinned composer + wiring script — no page chrome
// (chatPage supplies HEAD/header/tabNav). Reuses the DM threadPage styling +
// JS. GROUP differences: received bubbles (.msg.theirs) carry the sender's NAME +
// small avatar above the first bubble of their run; sent bubbles (.msg.mine) stay
// blue/right with no name. Every message gets a delete control the viewer is allowed
// to use (own always; any if host/admin). Forms POST to /chat[/react|/delete], which
// redirect back to /chat. The composer is lifted above the bottom tab bar (see
// body.has-chat CSS). This owns the page's 20s reload loop (scroll-saved,
// __composing()-guarded so it never nukes typing in the chat box).
// Render the inner HTML of #thread (message runs + day separators) for a
// chronological (id ASC) slice. Grouping/tail are computed within the slice, so
// a prepended older page renders self-contained; the client dedupes the seam
// day-divider after inserting. Shared by chatFragment + chatOlderFragment.
function groupMsgBody({ me, msgs = [], reactions = new Map(), parents = new Map(),
                       senders = new Map(), mentionNames = new Map(), isMod = false, canPin = false }) {
  const nameFor = (email) => { const s = senders.get(email); return s ? s.full_name : email; };
  const idFor = (email) => { const s = senders.get(email); return s ? s.id : 0; };

  let body = '', prevKey = null, prev = null;
  msgs.forEach((m, i) => {
    const mine = m.from_email === me;
    const k = dayKey(m.created_at);
    if (k !== prevKey) { body += `<div class="mday"><span>${esc(fmtDay(m.created_at))}</span></div>`; prevKey = k; prev = null; }
    const gap = (a, b) => Math.abs(_mDate(a) - _mDate(b));
    const grouped = prev && prev.from_email === m.from_email && gap(m.created_at, prev.created_at) < 120000;
    const next = msgs[i + 1];
    const nextSame = next && next.from_email === m.from_email && dayKey(next.created_at) === k && gap(next.created_at, m.created_at) < 120000;
    const tail = !nextSame;

    // Sender header (received messages only, first bubble of a run): small avatar
    // + name, muted uppercase Archivo, linking to their profile.
    let head = '';
    if (!mine && !grouped) {
      const nm = nameFor(m.from_email);
      const label = `<span class="gav">${avatarInner(m.from_email, nm)}</span>${esc(nm)}`;
      const sid = idFor(m.from_email);
      head = sid ? `<a class="mname" href="/u/${sid}">${label}</a>` : `<div class="mname">${label}</div>`;
    }

    let stub = '';
    if (m.reply_to) {
      const par = parents.get(m.reply_to);
      if (par) {
        const who = par.from_email === me ? 'You' : esc(nameFor(par.from_email));
        const txt = par.body ? esc(par.body.slice(0, 60)) : (par.audio ? '🎤 Voice message' : par.video ? '🎥 Video' : '📷 Photo');
        stub = `<div class="mquote"><b>${who}</b> · ${txt}</div>`;
      } else {
        stub = `<div class="mquote muted">Original message unavailable</div>`;
      }
    }

    const rx = reactions.get(m.id) || [];
    const chips = rx.length ? `<div class="tapbacks">${rx.map(r => `<form method="POST" action="/chat/react" class="tbf">
        <input type="hidden" name="message_id" value="${m.id}"><input type="hidden" name="emoji" value="${esc(r.emoji)}">
        <button class="tb${r.mine ? ' mine' : ''}" type="submit" title="Toggle reaction">${esc(r.emoji)}${r.count > 1 ? ` <span>${r.count}</span>` : ''}</button>
      </form>`).join('')}</div>` : '';

    const time = tail ? `<div class="mt">${esc(fmtClock(m.created_at))}</div>` : '';

    // Press-and-hold affordances travel as data-* (read by longPressScript). Reply
    // is always available in the group room; Delete only when the viewer may delete
    // (own message always; any message if host/admin).
    const canDel = isMod || mine;
    const saveable = m.video ? m.video : m.audio ? m.audio : (m.image && !isSticker(m.image) ? m.image : '');
    const lpData = `data-mid="${m.id}" data-reacturl="/chat/react" data-reply-id="${m.id}" data-reply-nm="${esc(mine ? 'You' : nameFor(m.from_email))}"`
      + (canDel ? ' data-candel="1" data-delurl="/chat/delete"' : '')
      + (saveable ? ` data-save="${esc(saveable)}"` : '')
      + (canPin ? ` data-canpin="1" data-pinurl="/chat/pin" data-pinned="${m.pinned_at ? '1' : '0'}"` : '');

    body += `<div class="msg ${mine ? 'mine' : 'theirs'}${grouped ? ' grouped' : ''}${tail ? ' tail' : ''}" ${lpData}>
        ${head}${stub}
        ${bubbleInner(m, mentionNames)}
        ${chips}${time}
      </div>`;
    prev = m;
  });
  return body;
}

// The "Load earlier messages" button — the top-of-thread scroll-back trigger.
// Rendered only when older history exists; the client swaps it for the fetched
// page (which carries its own fresh button when yet more remains).
const loadOlderBtn = (hasOlder) => hasOlder
  ? `<button type="button" class="loadmore" id="loadolder">Load earlier messages</button>` : '';

// Pinned-messages bar at the top of the room (Discord-style). Collapsible; each row
// jumps to the message in the thread; pinners (team/host/admin) get an unpin ✕.
const pinnedBar = (pinned = [], pinnedNames = new Map(), canPin = false) => {
  if (!pinned.length) return '';
  const rows = pinned.map(p => {
    const who = esc(pinnedNames.get(p.from_email) || p.from_email);
    const txt = p.body ? esc(p.body.slice(0, 90)) : (p.audio ? '🎤 Voice message' : p.video ? '🎥 Video' : p.image ? '📷 Photo' : '📌 Pinned');
    const unpin = canPin ? `<form method="POST" action="/chat/pin" class="pinx-f"><input type="hidden" name="message_id" value="${p.id}"><button type="submit" class="pinx" aria-label="Unpin">${IC_CLOSE}</button></form>` : '';
    return `<div class="pinrow"><button type="button" class="pinjump" data-jump="${p.id}"><b>${who}</b> <span>${txt}</span></button>${unpin}</div>`;
  }).join('');
  return `<details class="pinned" id="pinnedbar" open><summary>📌 Pinned · ${pinned.length}</summary>${rows}</details>`;
};

// A prepended scroll-back page: an optional fresh button + the older bubbles.
export function chatOlderFragment({ me, msgs = [], reactions = new Map(), parents = new Map(),
                                    senders = new Map(), mentionNames = new Map(), isMod = false, canPin = false, hasOlder = false }) {
  return loadOlderBtn(hasOlder) + groupMsgBody({ me, msgs, reactions, parents, senders, mentionNames, isMod, canPin });
}

function chatFragment({ me, msgs = [], reactions = new Map(), parents = new Map(),
                        senders = new Map(), mentionNames = new Map(), isMod = false, canPin = false,
                        pinned = [], pinnedNames = new Map(), hasOlder = false, err = '' }) {
  let body = groupMsgBody({ me, msgs, reactions, parents, senders, mentionNames, isMod, canPin });

  if (!msgs.length) {
    body = `<div class="mstart"><div class="mstartav">${GROUP_ICON}</div><b>Run Chat</b><p>This is the start of the room — say hi to the whole run 👋</p></div>`;
  }

  const composer = composerForm('/chat', 'Message the run', { mentions: true });

  return `
    ${sendErrNotice(err)}
    ${pinnedBar(pinned, pinnedNames, canPin)}
    <div class="thread" id="thread">${loadOlderBtn(hasOlder)}${body}</div>
    ${composer}
    <script>
      (function(){
        var thread=document.getElementById('thread');
        var tid='chat';
        // Tap a pinned row → scroll to that message in the thread (if it's loaded).
        document.addEventListener('click',function(e){
          var j=e.target&&e.target.closest&&e.target.closest('.pinjump'); if(!j)return;
          var el=document.querySelector('.msg[data-mid="'+j.getAttribute('data-jump')+'"]');
          if(el){ el.scrollIntoView({block:'center'}); el.classList.add('flash'); setTimeout(function(){el.classList.remove('flash');},1200); }
        });
        function toBottom(){ window.scrollTo(0, document.body.scrollHeight); }
        // Restore scroll after a 20s auto-reload; on a FRESH open jump to the newest
        // message (the Run Chat is the whole page now — the Chat tab).
        try{
          var saved=sessionStorage.getItem('sc-'+tid);
          if(saved!==null){ var o=JSON.parse(saved); if(o.bottom) toBottom(); else window.scrollTo(0,o.y); sessionStorage.removeItem('sc-'+tid); }
          else toBottom();
        }catch(e){ toBottom(); }
${composerInitJS()}
${mentionAutocompleteJS()}
        window.setReply=function(id,nm){ var r=document.getElementById('replyTo'),c=document.getElementById('replychip'),n=document.getElementById('replyname'); if(!r)return; r.value=id; if(n)n.textContent=nm; if(c)c.hidden=false; if(cbody)cbody.focus(); };
        window.clearReply=function(){ var r=document.getElementById('replyTo'),c=document.getElementById('replychip'); if(r)r.value=''; if(c)c.hidden=true; };
        // (reply/react/delete now live in the press-and-hold menu — see longPressScript)
        // Patch ONLY the #thread feed + member count from a fresh /chat fetch — the
        // composer node is never touched, so typing / reply-chip / focus survive a
        // refresh. Shared by fetch-send, the long-press menu, and the 10s poll.
        window.__threadRefresh=function(gentle){
          if(!window.fetch||!window.DOMParser)return;
          var atBottom=(window.innerHeight+window.scrollY)>=(document.body.scrollHeight-40);
          // The 10s poll is GENTLE: if you've scrolled up (reading history / an
          // older page loaded), don't yank the feed back to the latest 200. Explicit
          // actions (send / react / delete) pass no arg and always reconcile.
          if(gentle&&!atBottom)return;
          fetch('/chat',{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}})
            .then(function(r){return r.text();})
            .then(function(html){var doc=new DOMParser().parseFromString(html,'text/html');
              var nt=doc.getElementById('thread');
              if(nt){
                // Remember which messages were already on screen, then, after swapping in
                // the fresh feed, tag only the NEW ones with .msg-in so they slide into
                // place (iMessage-style) — idle polls with no new messages don't animate.
                var seen={}, old=thread.querySelectorAll('.msg[data-mid]');
                for(var i=0;i<old.length;i++) seen[old[i].getAttribute('data-mid')]=1;
                thread.innerHTML=nt.innerHTML;
                var now=thread.querySelectorAll('.msg[data-mid]');
                for(var j=0;j<now.length;j++){ var id=now[j].getAttribute('data-mid'); if(!seen[id]) now[j].classList.add('msg-in'); }
              }
              var nm=doc.querySelector('.chatsec-t span'),cm=document.querySelector('.chatsec-t span');
              if(nm&&cm)cm.textContent=nm.textContent;
              if(atBottom)toBottom();})
            .catch(function(){});
        };
        // Load-earlier pagination: the top button fetches the 200 messages before
        // the oldest one shown, prepends them, dedupes the seam day-divider, and
        // pins the viewport to the same message (content grows above the fold).
        thread.addEventListener('click',function(e){
          var btn=e.target&&e.target.closest&&e.target.closest('#loadolder');
          if(!btn||btn.__busy)return;
          var first=thread.querySelector('.msg[data-mid]');
          var before=first&&first.getAttribute('data-mid');
          if(!before||!window.fetch){ if(btn.parentNode)btn.parentNode.removeChild(btn); return; }
          btn.__busy=1; btn.textContent='Loading…';
          var prevH=document.body.scrollHeight, prevY=window.scrollY;
          fetch('/chat/older?before='+encodeURIComponent(before),{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}})
            .then(function(r){return r.text();})
            .then(function(html){
              var tmp=document.createElement('div'); tmp.innerHTML=html;
              var anchor=btn.nextSibling; btn.parentNode.removeChild(btn);
              while(tmp.firstChild) thread.insertBefore(tmp.firstChild, anchor);
              var last=null;
              thread.querySelectorAll('.mday').forEach(function(d){
                var t=d.textContent; if(t===last){ d.parentNode.removeChild(d); } else last=t; });
              window.scrollTo(0, prevY + (document.body.scrollHeight - prevH));
            })
            .catch(function(){ btn.__busy=0; btn.textContent='Load earlier messages'; });
        });
        var form=document.getElementById('composer');
        if(form&&cbody){ form.addEventListener('submit',function(e){
          var txt=cbody.value.trim(); if(!txt){ e.preventDefault(); return; } // empty → no send, no native full-page reload (photos/stickers have their own upload path)
          // optimistic bubble first (instant echo), then fetch-send — no page flash
          var d=document.createElement('div'); d.className='msg mine tail msg-in';
          var w=document.createElement('div'); w.className='mbwrap';
          var b=document.createElement('div'); b.className='mb'; b.textContent=txt;
          w.appendChild(b); d.appendChild(w); thread.appendChild(d); toBottom();
          if(!window.fetch) return; // no-fetch (JS off) → native POST carries the textarea body
          e.preventDefault();
          var body=new URLSearchParams(new FormData(form));
          cbody.value=''; autoGrow(); if(window.clearReply)window.clearReply();
          fetch(form.action,{method:'POST',body:body,headers:{'X-Requested-With':'fetch'},credentials:'same-origin'})
            .then(function(r){ if(r.redirected&&r.url&&r.url.indexOf('err=slow')>=0){window.location.href=r.url;return;} window.__threadRefresh(); })
            .catch(function(){ window.location.href='/chat'; });
        }); }
        // Poll-and-patch the feed (P0-1): re-fetch + patch #thread only on change,
        // never touching the composer. Replaces the old 20s full-page reload.
        if(window.__poll)window.__poll('chat',function(){window.__threadRefresh(true);});
      })();
    </script>
    ${longPressScript()}
    ${lightboxScript()}
    ${voicePlayerScript()}`;
}

// ---------- ADMIN / COUNCIL ----------
export function adminPage({ applicants, runLabel, runDate = '', hours = '7–10 PM', checkedInCount, cap,
                           waitlistCap = 5, preregCap = 10, msg = '',
                           viewerIsAdmin = true, viewerIsTeam = false, viewerIsHost = false, viewerEmail = '', log = [],
                           filter = 'all', counts = {}, teamMembers = [], ann = null }) {
  const pill = (s) => `<span class="pill ${s}">${s}</span>`;
  // Map a voter email → their display name (voters are always team members, so the
  // council roster covers every one). Falls back to the raw email if somehow unseen.
  // esc() is applied here so a name containing markup is safe wherever it's rendered.
  const nameByEmail = new Map(teamMembers.map(m => [m.email.toLowerCase(), m.full_name]));
  const voterName = (e) => esc(nameByEmail.get(String(e).toLowerCase()) || e);
  const voteBtn = (id, vote, label, cls, active) =>
    `<form method="POST" action="/admin/vote"><input type="hidden" name="id" value="${id}"><input type="hidden" name="vote" value="${vote}"><button class="btn ${cls} sm${active ? ' voted' : ''}" type="submit">${active ? '✓ ' : ''}${label}</button></form>`;

  const rows = applicants.map(a => {
    const isSelf = a.email === viewerEmail;
    // Role toggles — ADMIN ONLY. Making team auto-approves; regular needs approved.
    const roleBtn = (role, flag, onLabel, offLabel, show) => (!viewerIsAdmin || !show) ? '' : (flag
      ? `<form method="POST" action="/admin/role"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="role" value="${role}"><input type="hidden" name="on" value="0"><button class="btn sm regstar" type="submit">${onLabel}</button></form>`
      : `<form method="POST" action="/admin/role"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="role" value="${role}"><input type="hidden" name="on" value="1"><button class="btn ghost sm" type="submit">${offLabel}</button></form>`);
    const teamBtn = roleBtn('team', a.is_team, '◆ Team — remove', 'Make team', true);
    // Make Core auto-approves (like team), so it's offered for pending applicants too, not just approved.
    const regBtn  = roleBtn('regular', a.is_regular, '★ Core — remove', 'Make Core', true);
    const hostBtn = roleBtn('host', a.is_host, '★ Host — remove', 'Make Host', a.status === 'approved' && viewerIsAdmin);

    // Team members are auto-approved and not voted on.
    let decisionBlock;
    if (a.is_team) {
      decisionBlock = `<div class="ad" style="margin-top:10px">◆ Team — auto-approved, no vote needed.</div>
        <div class="acts">${teamBtn}${regBtn}${hostBtn}</div>`;
    } else {
      const v = a.vote || { poolSize: 0, threshold: 3, approved: [], rejected: [], waiting: [], myVote: null };
      const th = v.threshold || 3;
      const tally = `<div class="tally"><b>${v.approved.length}/${th}</b> approvals${v.rejected.length ? ` · <span style="color:var(--bad)">${v.rejected.length}/${th} rejects</span>` : ''} <span class="tally-note">(${th} to decide)</span></div>`;
      // Vote transparency — ADMIN ONLY (owner's call). Non-admin team members keep
      // seeing only the tally + their own vote highlight (below), never who cast what.
      // Maps voter emails → names via the council roster. e.g. "Approved by Nic, Sarah
      // · Rejected by Mike".
      const whoVoted = viewerIsAdmin ? (() => {
        const parts = [];
        if (v.approved.length) parts.push(`Approved by ${v.approved.map(voterName).join(', ')}`);
        if (v.rejected.length) parts.push(`Rejected by ${v.rejected.map(voterName).join(', ')}`);
        return parts.length ? `<div class="tally-note">${parts.join(' · ')}</div>` : '';
      })() : '';
      // admin-only: who's still to vote (names, not raw emails)
      const waiting = (viewerIsAdmin && v.waiting.length && a.status === 'pending')
        ? `<div class="tally-note">Waiting on: ${v.waiting.map(voterName).join(', ')}</div>` : '';
      const voteButtons = (!viewerIsTeam || viewerIsHost)
        ? '<span class="ad" style="margin:0">Team decides — you have oversight, not a vote.</span>'
        : (isSelf
          ? '<span class="ad" style="margin:0">Your own application — you can\'t vote.</span>'
          : `${voteBtn(a.id, 'approve', 'Approve', 'ghost', v.myVote === 'approve')}
             ${voteBtn(a.id, 'reject', 'Reject', 'leave', v.myVote === 'reject')}`);
      const resetBtn = viewerIsAdmin
        ? `<form method="POST" action="/admin/reset"><input type="hidden" name="id" value="${a.id}"><button class="btn ghost sm" type="submit">Reset votes</button></form>` : '';
      decisionBlock = `${tally}${whoVoted}${waiting}
        <div class="acts">${voteButtons}${resetBtn}${teamBtn}${regBtn}${hostBtn}</div>`;
    }

    return `<details class="arow"${a.status === 'pending' ? ' open' : ''}>
    <summary><span class="an">${esc(a.full_name)}${a.is_host ? ' <span class="tag host">★ Host</span>' : ''}${a.is_team ? ' <span class="tag team">◆ Team</span>' : ''}${a.is_regular ? ' <span class="tag reg">★ Core</span>' : ''}</span> ${pill(a.status)}</summary>
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
        `<div class="r"><span class="av">${avatarInner(m.email, m.full_name)}</span><span class="nm">${esc(m.full_name)}</span>${m.is_host ? '<span class="bdg host">★ Host</span>' : '<span class="bdg team">◆ Team</span>'}</div>`
      ).join('')}</div>
    </div>` : '';

  return HEAD('Council — Adv Runs') + header(`<b>COUNCIL</b>${viewerIsAdmin ? 'admin' : 'team'}`, wdayShort(runDate), ann, hours) + `
    ${opsNav('admin', { isAdmin: viewerIsAdmin, isTeam: viewerIsTeam })}
    <div class="rule"></div>
    <span class="eyebrow">${applicants.length} ${filter === 'all' ? 'applicant' : filter}${applicants.length===1?'':'s'}</span>
    <h1>Council review</h1>
    <p class="lead">${viewerIsAdmin
      ? 'Approval is decided by the <b>team</b>: 3 approvals gets an applicant in, 3 rejects blocks them. You have oversight and manage people, but you don\'t vote. Team members are auto-approved and skip the vote.'
      : 'It takes <b>3 approvals</b> to get an applicant in, or <b>3 rejects</b> to block them. Cast your vote below.'}</p>
    <div class="notice">This ${wdayFull(runDate)} (${esc(runLabel)}): <b>${checkedInCount}/${cap}</b> checked in.</div>
    ${msg ? `<div class="notice good">${esc(msg)}</div>` : ''}
    ${viewerIsAdmin ? `<details class="announce-compose" style="margin-top:12px"><summary>⚙️ Run settings — capacity</summary>
      <form method="POST" action="/admin/settings" class="editrow" style="margin-top:10px">
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
  return HEAD('Your status — Adv Runs', '', { wall: false }) + header('<b>STATUS</b>' + esc(email)) + `
    <div class="rule"></div>
    ${body}
    ${homeScreenCard}
    <div class="foot" style="margin-top:24px"><a href="/logout">Sign out</a></div>
  ` + FOOT;
}

// Sign-out confirmation. GET /logout renders THIS (a harmless read — no state
// change), and the actual session clear happens only on POST. That closes the
// CSRF / link-prefetch hole a GET-that-logs-you-out opens, and keeps a working
// no-JS path (the button below posts). With JS, the delegated handler in HEAD
// intercepts the "Sign out" link and posts directly, so this page is rarely seen.
export function logoutPage() {
  return HEAD('Sign out — Adv Runs', '', { wall: false }) + header('<b>SIGN OUT</b>') + `
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
  return HEAD(`${title} — Adv Runs`, '', { wall: false }) + header(`<b>${esc(title.toUpperCase())}</b>`) + `
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
  return HEAD(`${title} — Adv Runs`, '', { wall: false }) + header(`<b>${esc(title.toUpperCase())}</b>`) + `
    <div class="rule"></div>
    <div class="legal">${html}</div>
    <div class="foot" style="margin-top:24px"><a href="/">Apply</a> · <a href="/login">Sign in</a></div>
  ` + FOOT;
}

// ---------- CHECK-IN BANNER TOOL (operators) ----------
// Pick a photo → pan/zoom it inside a fixed 3:1 window → save. The window IS the banner
// crop; the client computes the source-pixel rect and posts it with the file (server crops
// to 2320×774). Native multipart POST — the submit handler just fills the hidden crop inputs.
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

export function bannerPage({ err = '', bannerVer = '0' } = {}) {
  const errMsg = err === 'big' ? 'That image is too large (max 14 MB).'
    : err === 'type' ? 'That file isn’t a supported image (JPG, PNG, or WebP).'
    : err === 'crop' ? 'Couldn’t read the crop area — try again.'
    : err ? 'Something went wrong processing the image. Try again.' : '';
  return HEAD('Change banner — Adv Runs', '', { wall: false }) + header('<b>BANNER</b>admin', 'FRI') + `
    <div class="rule"></div>
    <span class="eyebrow">Check-in hero photo</span>
    <h1>Change the banner</h1>
    <p class="lead">Pick a photo, then <b>drag to position</b> and use the <b>slider to zoom</b>. The framed area is exactly what shows on the check-in page — a wide 3:1 banner.</p>
    ${errMsg ? `<div class="notice bad">${errMsg}</div>` : ''}

    <div class="subhead">Current</div>
    <div class="curframe"><img src="/gym.jpg?v=${esc(String(bannerVer))}" alt="Current banner"></div>

    <form method="POST" action="/admin/banner" enctype="multipart/form-data" id="bform" class="card rail" style="margin-top:14px">
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
    <div class="foot" style="margin-top:24px"><a href="/checkin">Back to check-in</a></div>
  ` + FOOT;
}

// ---------- PEOPLE MANAGEMENT (admin-only) ----------
export function peoplePage({ people, q = '', approvedPhones = [], signInUrl = '', invites = [], newInviteLink = '', msg = '', ann = null }) {
  const pill = (s) => `<span class="pill ${s}">${s}</span>`;
  const rows = people.map(a => `<details class="arow"${q ? ' open' : ''}>
    <summary><span class="an">${esc(a.full_name)}${a.is_team ? ' <span class="tag team">◆</span>' : ''}${a.is_regular ? ' <span class="tag reg">★</span>' : ''}${a.suspended ? ' <span class="tag susp">⊘ Suspended</span>' : ''}</span> ${pill(a.status)}</summary>
    <form method="POST" action="/admin/people/edit" class="editrow" style="margin-top:12px">
      <input type="hidden" name="id" value="${a.id}">
      <label>Name<input name="full_name" value="${esc(a.full_name)}"></label>
      <label>Phone<input name="phone" value="${esc(a.phone)}" inputmode="tel"></label>
      <label>Email<input name="email" type="email" value="${esc(a.email)}"></label>
      <div class="editacts">
        <button class="btn sm" type="submit">Save</button>
      </div>
    </form>
    ${a.suspended
      ? `<form method="POST" action="/admin/people/suspend" style="margin:6px 0 0">
           <input type="hidden" name="id" value="${a.id}"><input type="hidden" name="on" value="0">
           ${a.suspend_reason ? `<p class="tally-note" style="margin:0 0 6px">Reason: ${esc(a.suspend_reason)}</p>` : ''}
           <button class="btn ghost sm" type="submit">Unsuspend — restore check-in &amp; chat</button>
         </form>`
      : `<form method="POST" action="/admin/people/suspend" class="editrow" style="margin:6px 0 0">
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

  return HEAD('People — Adv Runs') + header('<b>PEOPLE</b>admin', 'FRI', ann) + `
    ${opsNav('people', { isAdmin: true })}
    <div class="rule"></div>
    <span class="eyebrow">${people.length} ${q ? 'match' + (people.length===1?'':'es') : 'people'}</span>
    <h1>People</h1>
    ${msg ? `<div class="notice good">${esc(msg)}</div>` : ''}

    <form method="GET" action="/admin/people" style="margin:8px 0 4px">
      <input name="q" value="${esc(q)}" placeholder="Search name, email, or phone…">
    </form>

    <a class="btn ghost" href="/admin/share" style="margin:8px 0 0">📱 Share sign-up QR &amp; links</a>
    <a class="btn ghost" href="/admin/people/export.csv" style="margin:8px 0 0" download>⬇︎ Export people (CSV)</a>

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
        <input id="newinv" readonly value="${esc(newInviteLink)}" style="font-size:16px;margin-top:8px">
        <div style="height:8px"></div>
        ${copyBtn('newinv', 'Copy link')} ${shareBtn('newinv')}
      </div>` : ''}

    ${invites.length ? `<details class="announce-compose"><summary>Pending invites (${invites.length})</summary>
        <ul class="annlog">
          ${invites.map(iv => `<li>
            <div class="annlog-b">${esc(iv.full_name || '(no name yet)')}${iv.phone ? ' · ' + esc(iv.phone) : ''}${iv.email ? ' · ' + esc(iv.email) : ''}${iv.role ? ` <span class="tag ${iv.role === 'team' ? 'team' : 'reg'}">${iv.role === 'team' ? '◆ Team' : '★ Core'}</span>` : ''}</div>
            <div class="annlog-m" style="margin-bottom:8px">Created ${esc(fmtWhen(iv.created_at))} by ${esc(iv.created_by)} · not used yet</div>
            <input readonly value="${esc(iv.link)}" style="font-size:16px" onclick="this.select()">
            <div style="height:6px"></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn ghost sm" type="button" onclick="var i=this.closest('li').querySelector('input[readonly]');if(i){i.select();try{navigator.clipboard.writeText(i.value);}catch(e){}}this.textContent='Copied ✓';setTimeout(()=>this.textContent='Copy link',1500)">Copy link</button>
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
  ` + FOOT;
}

// ---------- SHARE (QR + link for the application form) ----------
export function sharePage({ applyUrl = '', applyQr = '', signInUrl = '', loginQr = '', ann = null }) {
  return HEAD('Share — Adv Runs') + header('<b>SHARE</b>admin', 'FRI', ann) + `
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
  ` + FOOT;
}
