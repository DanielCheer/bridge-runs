// views/client-app.js — APP_JS, the client engine served at /app.js: the tab router, poll-and-
// patch, push, badges and the install wall. Plain browser script in a string; no server values.

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
window.__composing=function(){var ae=document.activeElement;if(ae&&/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)&&(ae.type||'')!=='hidden')return true;var f=document.querySelectorAll('textarea,input');for(var i=0;i<f.length;i++){var t=(f[i].type||'text').toLowerCase();if(t==='hidden'||t==='checkbox'||t==='radio'||t==='submit'||t==='button'||t==='file'||t==='date'||t==='time'||t==='datetime-local'||t==='month'||t==='week')continue;if(f[i].value&&f[i].value.trim())return true;}if(document.querySelector('details.announce-compose[open]'))return true;return false;};
// Patch the DM (Profile tab) + group (Chat tab) unread badges in place every poll
// tick — no reload needed to keep them fresh. Also toggles the hero group-chat dot.
window.__patchBadges=function(d){try{d=d||{};var chats=d.chats||{};
  // Look up a chat element's unread from the poll's program-keyed map via its data-chat-program.
  function counts(el){var id=el&&el.getAttribute('data-chat-program');var c=id&&chats[id];return c?{u:c.u||0,m:c.m||0}:{u:0,m:0};}
  function setTab(key,n,mention){var a=document.querySelector('.tabs a[data-tab="'+key+'"]');if(!a)return;var b=a.querySelector('.tabbadge');
    if(n>0){var t=(mention>0?'@':'')+(n>9?'9+':String(n));if(!b){b=document.createElement('span');b.className='tabbadge';a.appendChild(b);}b.textContent=t;b.className='tabbadge'+(mention>0?' mention':'');}
    else if(b){b.parentNode.removeChild(b);}}
  // The Chat tab is run-aware: it carries data-chat-program, so badge it with THAT program's
  // unread from the map. Works for any number of runs — no per-program branch here.
  var ct=document.querySelector('.tabs a[data-tab="chat"]'), cc=counts(ct);
  setTab('chat', cc.u, cc.m); setTab('profile', d.dm||0, 0);
  var hchat=document.querySelector('.hchat');if(hchat){var dot=hchat.querySelector('.hdot');var hg=counts(hchat).u; // hero dot uses its own program's unread
    if(hg>0){if(!dot){dot=document.createElement('span');dot.className='hdot';dot.setAttribute('aria-hidden','true');hchat.appendChild(dot);}}else if(dot){dot.parentNode.removeChild(dot);}}
  // Masthead announcement bell dot — toggled live from the poll ann unread flag.
  var bell=document.querySelector('.bellbtn');if(bell){var bd=bell.querySelector('.belldot');
    if((d.ann||0)>0){if(!bd){bd=document.createElement('span');bd.className='belldot';bd.setAttribute('aria-hidden','true');bell.appendChild(bd);}}else if(bd){bd.parentNode.removeChild(bd);}}
  // Home-screen app-icon badge (installed PWA, iOS 16.4+): DM + basketball chat unread.
  if(navigator.setAppBadge){var c1=chats[1]||{};var tot=(d.dm||0)+(c1.u||0);
    if(tot>0)navigator.setAppBadge(tot).catch(function(){});
    else if(navigator.clearAppBadge)navigator.clearAppBadge().catch(function(){});}
}catch(e){}};
// Swap only the .wrap contents (+ <title> + body class) from a fetched full page and
// re-run its inline scripts (innerHTML won't execute them) — the shared engine behind
// both the check-in action fetches and the client tab router. Returns false on any
// parse/shape problem so callers fall back to a hard navigation.
window.__swapWrap=function(html,animate){
  try{
    // Parse + validate FIRST so the caller's fallback contract stays synchronous — the mutation
    // itself may run inside a View Transition callback below.
    var doc=new DOMParser().parseFromString(html,'text/html');
    var nw=doc.querySelector('.wrap'),cur=document.querySelector('.wrap');
    if(!nw||!cur)return false;
    var mutate=function(){
      if(doc.title)document.title=doc.title;
      if(doc.body&&doc.body.className!==document.body.className)document.body.className=doc.body.className;
      document.body.style.overflow='';   // any open overlay is destroyed by this swap; never leave scroll locked
      cur.innerHTML=nw.innerHTML;
      // The tab bar now lives outside .wrap → swap it explicitly so its active tab / run-aware
      // Chat href / badges track the new page. Absent on some pages (e.g. wall) → just leave it.
      var ntb=doc.querySelector('.tabs'), ctb=document.querySelector('.tabs');
      if(ntb&&ctb){ ctb.parentNode.replaceChild(ntb.cloneNode(true), ctb); }
      else if(ntb&&!ctb){ document.body.appendChild(ntb.cloneNode(true)); }
      else if(!ntb&&ctb){ ctb.parentNode.removeChild(ctb); }
      var s=cur.querySelectorAll('script');
      for(var i=0;i<s.length;i++){var ns=document.createElement('script');if(s[i].src)ns.src=s[i].src;else ns.textContent=s[i].textContent;s[i].parentNode.replaceChild(ns,s[i]);}
    };
    // Soft transitions (owner request 2026-08-04): NAVIGATION swaps crossfade via the View
    // Transitions API — the browser snapshots old/new and animates between them; the tab bar +
    // masthead carry view-transition-names so the chrome stays still while content moves.
    // Deliberately ONLY for navigation (animate flag): poll refreshes and form-shim re-renders
    // stay hard cuts, or the app would flash on every background update. Falls back to the
    // instant swap where the API is missing, the tab is hidden, or the user prefers less motion.
    var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches;
    if(animate&&document.startViewTransition&&!reduce&&!document.hidden){
      // The mutate runs ASYNC here, after we've already returned true (and the caller pushed
      // state) — a throw can't reach the caller's hard-nav fallback, so fall back ourselves:
      // location reflects the NEW page at that point, a hard load of it lands correctly.
      document.startViewTransition(function(){ try{mutate();}catch(e){try{window.location.href=location.pathname+location.search;}catch(e2){}} });
    }
    else{ mutate(); }
    return true;
  }catch(e){return false;}
};
// iOS keyboard watcher — the SINGLE owner of body.kb-open, on EVERY page (not just chat).
// When the on-screen keyboard overlays the page, iOS shrinks the VISUAL viewport while the
// layout viewport keeps its height — position:fixed elements pin to the visual viewport and
// the bottom nav "floats" mid-screen. Any input can summon the keyboard (guest add, announce,
// search…), so: visual viewport meaningfully shorter than the layout viewport → kb-open
// (nav hidden) — plus the chat composer's engaged flag (it positions itself separately and
// covers the installed-PWA resize mode, where both viewports shrink and overlap reads ~0).
// MEASURE, DON'T GUESS. Earlier versions tried to infer "is the keyboard open" from viewport
// arithmetic and a focused-input heuristic, then hid the nav. That inference is unreliable — iOS
// Safari-in-a-tab shrinks only the VISUAL viewport, the installed app shrinks the LAYOUT viewport
// too, and WebKit can leave a position:fixed element PAINTED at a stale anchor after the keyboard
// goes away. Every heuristic was right in one mode and wrong in another, which is why the bar kept
// reappearing mid-screen.
// Instead: ask the element where it actually IS, ask the viewport where its bottom actually IS, and
// correct exactly that difference. This is model-agnostic — if fixed already tracks the visual
// viewport the correction is 0; if it's anchored to the layout viewport (or stale) we shift it by
// the measured gap. It self-heals on every viewport event, so a stale paint can't survive one.
window.__kbSync=function(){
  var vv=window.visualViewport;
  // The chat composer owns the bottom strip while it's engaged — the nav steps aside only there.
  var open=!!window.__composerEngaged;
  document.body.classList.toggle('kb-open',open);
  var tabs=document.querySelector('.tabs');
  if(!tabs)return;
  if(!vv){ tabs.style.transform=''; return; }
  tabs.style.transform='';                              // measure unshifted
  var want=vv.offsetTop+vv.height;                      // bottom of the VISIBLE area, in client coords
  var have=tabs.getBoundingClientRect().bottom;         // where the bar actually renders
  var fix=Math.round(want-have);
  // DEVICE-EVIDENCED (capture 2026-08-04, /demo, installed app): WebKit can leave the VISUAL
  // viewport STUCK at its keyboard-open height after dismissal — vv.height 528 vs innerHeight 873,
  // activeElement BODY, scale 1, offsetTop 0, stable for seconds in the ring. In that state want
  // is a lie and the lift branch parked the bar 345px up the page. A shrunken viewport is only
  // TRUSTED when a keyboard is actually possible (an editable is focused / the composer is
  // engaged) or the viewport is genuinely transformed (pinch: scale/offset). Otherwise: no lift —
  // the layout bottom IS the visible bottom. Self-heals the moment WebKit fires the real resize.
  var ae1=document.activeElement;
  var editable=!!(ae1&&(ae1.tagName==='INPUT'||ae1.tagName==='TEXTAREA'||ae1.tagName==='SELECT'||ae1.isContentEditable));
  var kbPossible=editable||!!window.__composerEngaged||vv.scale>1.01||Math.round(vv.offsetTop)>0||Math.round(vv.offsetLeft||0)>0;
  if(fix<-1&&!kbPossible){fix=0;}
  // Only correct a real discrepancy, and never more than a viewport (a wild number means the
  // measurement is mid-transition — leave it alone rather than fling the bar off-screen).
  // POSITIVE GAP STILL FROZEN: this corrects only fix<-1. The bar-ABOVE-visible-bottom symptom
  // (fix>0) remains record-only — the 2026-08-04 capture licensed the stale-viewport gate, not a
  // positive-gap actuator. See docs/NAV-LOCALIZER.md.
  var applied='';
  if(fix<-1&&fix>-window.innerHeight){applied='translateY('+fix+'px)';tabs.style.transform=applied;}
  // Ring buffer (~40) — turns a single capture into a SEQUENCE, which is what distinguishes
  // "keyboard still open" from "layout viewport stuck after dismissal" from "our transform is stale".
  try{
    var B=window.__geoRing||(window.__geoRing=[]);
    var ae2=document.activeElement;
    B.push({t:Date.now(),ih:window.innerHeight,vh:vv.height,vt:Math.round(vv.offsetTop),
      sc:vv.scale,rb:Math.round(have),fx:fix,ap:applied,kp:kbPossible?1:0,
      ae:ae2?(ae2.tagName+(ae2.type?':'+ae2.type:'')):'',ce:!!window.__composerEngaged});
    if(B.length>40)B.shift();
  }catch(e){}
};
// ---- Bottom-nav LOCALIZER ----------------------------------------------------------------
// Captures what the DEVICE actually reports while the bug is visible. Reads only; the endpoint is
// admin-gated, so a member long-pressing the masthead gets nothing and writes nothing.
// Order matters: build + queue the payload BEFORE drawing anything. If drawing the confirmation
// overlay makes the bar snap back to the bottom, that is affirmative evidence of WebKit stale
// paint (geometry reads fine, pixels lie) — note it in the report.
window.__geoCapture=function(){
  var tabs=document.querySelector('.tabs'), vv=window.visualViewport;
  var cs=tabs?getComputedStyle(tabs):null, r=tabs?tabs.getBoundingClientRect():null;
  // Any ancestor with a transform/filter/contain/will-change becomes a containing block for
  // position:fixed — the original month-one cause. Structurally impossible today; recorded so a
  // regression names itself instead of being re-diagnosed from scratch.
  var anc=[],n=tabs?tabs.parentElement:null;
  while(n){var s=getComputedStyle(n),hit={};
    ['transform','translate','scale','rotate','filter','backdropFilter','perspective','contain','willChange','containerType'].forEach(function(p){
      var v=s[p]; if(v&&v!=='none'&&v!=='normal'&&v!=='auto'&&v!=='initial')hit[p]=String(v).slice(0,40);});
    if(Object.keys(hit).length)anc.push({el:n.tagName+(n.className?'.'+String(n.className).split(' ')[0]:''),css:hit});
    n=n.parentElement;}
  // NB: no regex with an escaped slash here — this file is a template literal, so \/ collapses to /
  // and would emit a broken pattern into the client bundle (it has bitten this file before).
  var base=function(u){var p=String(u||'').split('/');return p[p.length-1];};
  var sheets=[];try{for(var i=0;i<document.styleSheets.length;i++){var h=document.styleSheets[i].href;if(h)sheets.push(base(h));}}catch(e){}
  var payload={
    when:new Date().toISOString(), path:location.pathname,
    layout:{ih:window.innerHeight,iw:window.innerWidth,ch:document.documentElement.clientHeight,
      cw:document.documentElement.clientWidth,sy:Math.round(window.scrollY),
      sw:screen.width,sh:screen.height,dpr:window.devicePixelRatio},
    visual:vv?{h:vv.height,w:vv.width,top:vv.offsetTop,left:vv.offsetLeft,pageTop:vv.pageTop,scale:vv.scale}:null,
    bar:r?{top:Math.round(r.top),bottom:Math.round(r.bottom),height:Math.round(r.height),
      offsetH:tabs.offsetHeight,inlineTransform:tabs.style.transform||'',
      position:cs.position,bottomCss:cs.bottom,transform:cs.transform,visibility:cs.visibility,
      display:cs.display,padBottom:cs.paddingBottom}:null,   // padBottom = the RESOLVED safe-area inset
    derived:r&&vv?{visibleBottom:Math.round(vv.offsetTop+vv.height),barBottom:Math.round(r.bottom),
      gap:Math.round((vv.offsetTop+vv.height)-r.bottom)}:null,
    ancestors:anc,
    mode:{standalone:navigator.standalone===true,
      displayMode:!!(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches),
      ua:navigator.userAgent},
    state:{activeEl:document.activeElement?(document.activeElement.tagName+(document.activeElement.type?':'+document.activeElement.type:'')):'',
      bodyClass:document.body.className,composerEngaged:!!window.__composerEngaged},
    build:{clientVer:window.__ver||'',sheets:sheets,
      sw:(navigator.serviceWorker&&navigator.serviceWorker.controller)?base(navigator.serviceWorker.controller.scriptURL):''},
    tour:(function(){var t=document.getElementById('tour');if(!t)return null;
      var on=-1,ds=document.querySelectorAll('#tourdots i');for(var k=0;k<ds.length;k++)if(ds[k].className==='on')on=k;
      var res='';try{res=sessionStorage.getItem('__tourResume')||'';}catch(e){}
      var seen='';try{seen=localStorage.getItem('bridgeTourV1')||'';}catch(e){}
      return {hidden:!!t.hidden,ttl:(document.getElementById('tourttl')||{}).textContent||'',on:on,dots:ds.length,
        bridge:!!document.getElementById('tourbridge'),catchBg:(document.getElementById('tourcatch')||{style:{}}).style.background||'',
        overflow:document.body.style.overflow||'',resume:res,seen:seen};})(),
    ring:(window.__geoRing||[]).slice(-40)
  };
  var body=JSON.stringify(payload);
  // fetch (not sendBeacon): the overlay must only appear when the server CONFIRMED the store.
  // sendBeacon can't report status, so a member's accidental long-press would have shown a
  // "captured" box for a POST the admin gate rejected — a lie, and a mystery debug box for them.
  fetch('/debug/geo',{method:'POST',headers:{'Content-Type':'application/json'},body:body,keepalive:true})
    .then(function(res){ if(res.ok)window.__geoOverlay(payload); })
    .catch(function(){});
};
window.__geoOverlay=function(payload){
  var vv=window.visualViewport;
  // Confirmation overlay drawn only post-2xx — see the stale-paint note above.
  var d=payload.derived||{}, o=document.createElement('div');
  o.setAttribute('style','position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;background:#1b1b17;color:#fff;'
    +'font:12px/1.45 ui-monospace,Menlo,monospace;padding:10px 12px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.4)');
  o.textContent='geo captured · barBottom '+(d.barBottom!=null?d.barBottom:'?')+' · visibleBottom '
    +(d.visibleBottom!=null?d.visibleBottom:'?')+' · gap '+(d.gap!=null?d.gap:'?')
    +' · innerH '+window.innerHeight+' · vvH '+(vv?Math.round(vv.height):'?')+' · vvTop '+(vv?Math.round(vv.offsetTop):'?')
    +' — screenshot this, then tap to dismiss';
  o.addEventListener('click',function(){o.remove();});
  document.body.appendChild(o);
  setTimeout(function(){if(o.parentNode)o.remove();},20000);
};
(function(){
  // Trigger: ~800ms press on the masthead. Delegated at document level so it survives the router's
  // .wrap swaps (the masthead is inside .wrap and gets replaced on every navigation).
  if(window.__geoBound)return; window.__geoBound=1;
  var timer=null;
  var start=function(e){ var t=e.target&&e.target.closest&&e.target.closest('.mast,.bl,header');
    if(!t)return; clearTimeout(timer); timer=setTimeout(function(){ if(window.__geoCapture)window.__geoCapture(); },800); };
  var cancel=function(){ clearTimeout(timer); };
  document.addEventListener('touchstart',start,{passive:true});
  document.addEventListener('touchend',cancel); document.addEventListener('touchmove',cancel,{passive:true});
  document.addEventListener('mousedown',start); document.addEventListener('mouseup',cancel);
})();
(function(){
  if(window.__kbWatchBound)return; window.__kbWatchBound=1;
  var vv=window.visualViewport;
  function kick(){ requestAnimationFrame(window.__kbSync); setTimeout(window.__kbSync,150); setTimeout(window.__kbSync,450); }
  if(vv){ vv.addEventListener('resize',kick); vv.addEventListener('scroll',kick); }
  document.addEventListener('focusin',kick); document.addEventListener('focusout',kick);
  window.addEventListener('orientationchange',kick); document.addEventListener('visibilitychange',kick);
})();
// True while any full-screen overlay/sheet is open — a poll-driven .wrap swap must NOT
// fire then (it would destroy the tour/sheet mid-use and could leave scroll locked).
window.__overlayOpen=function(){
  var t=document.getElementById('tour'); if(t&&!t.hidden)return true;
  var ids=['annwrap','wgwrap','memwrap','pvwrap'];
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
      .then(function(d){fails=0;window.__patchBadges(d);
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
  function paint(res,href,push,type,animate){
    // The swap animates via a View Transition inside __swapWrap when animate !== false.
    // popstate passes false: iOS already played its native edge-swipe animation — a second
    // crossfade over the same page reads as a double-flash.
    if(push)history.pushState({r:1},'',href); else history.replaceState({r:1},'',href);
    window.scrollTo(0,0);
    if(!window.__swapWrap(res.text,animate!==false)){hard(href);}
  }
  function mkres(r){ return r.text().then(function(t){return {ok:r.ok,url:r.url,redirected:r.redirected,text:t};}); }
  var navSeq=0; // navigation generation token: only the LATEST go() may paint — without it a
  // slow tab fetch resolving after a faster later one repaints (and re-pushes) the stale page.
  function go(href,push,animate){
    var abs; try{abs=new URL(href,location.href);}catch(e){hard(href);return;}
    if(abs.origin!==location.origin){hard(href);return;}
    var seq=++navSeq;
    var type=push?window.__navDir(location.pathname,abs.pathname):null;
    warm(href); // (re)fills a fresh entry if the current one is missing or stale
    var e=cache[href]; delete cache[href];
    var pr=e?e.p:null;
    if(!pr){ try{pr=fetch(href,{credentials:'same-origin'}).then(mkres);}catch(e){hard(href);return;} }
    if(window.__pollStop)window.__pollStop();   // park poll so its onChange can't clobber mid-swap
    pr.then(function(res){
      if(seq!==navSeq)return;   // a newer navigation superseded this one — its paint wins
      if(!res||typeof res.text!=='string'){hard(href);return;}
      if(res.redirected&&res.url){var u;try{u=new URL(res.url);}catch(e){u=null;} if(u&&u.pathname!==abs.pathname){hard(res.url);return;}}
      paint(res,href,push,type,animate);
      // Actually LANDED on chat → now mark it read (the prewarm skipped it). Beacon =
      // fire-and-forget; the badge clears on the next poll tick.
      if(abs.pathname.endsWith('/chat')&&navigator.sendBeacon){try{navigator.sendBeacon(abs.pathname+'/seen');}catch(e){}} // any run's chat room (/chat, /pickleball/chat, /volleyball/chat, …) — P2-1
    }).catch(function(){if(seq===navSeq)hard(href);});
  }
  window.__go=go; // exposed so the team tour can drive a smooth router swap between pages
  document.addEventListener('pointerdown',function(e){
    var a=e.target&&e.target.closest&&e.target.closest('.tabs a[href],.opsnav a[href],.jc[href],.backruns[href],.hchat[href],.ftab[href],.mrow[href],.bk[href],.pbback[href],.pback[href],.chatback[href]');
    if(a)warm(a.getAttribute('href'));
  },{passive:true,capture:true});
  document.addEventListener('click',function(e){
    if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
    var a=e.target&&e.target.closest&&e.target.closest('.tabs a[href],.opsnav a[href],.jc[href],.backruns[href],.hchat[href],.ftab[href],.mrow[href],.bk[href],.pbback[href],.pback[href],.chatback[href]');
    if(!a)return;
    if(a.hasAttribute('data-full'))return;   // opt out of the SPA swap → normal full navigation (e.g. apply form)
    if(a.target&&a.target!==''&&a.target!=='_self')return;
    var href=a.getAttribute('href'); if(!href||href.charAt(0)==='#')return;
    var abs; try{abs=new URL(href,location.href);}catch(x){return;}
    if(abs.origin!==location.origin)return;
    e.preventDefault();
    if(abs.pathname===location.pathname&&abs.search===location.search)return;   // current tab → no-op
    go(href,true);
  });
  window.addEventListener('popstate',function(){ go(location.pathname+location.search,false,false); });
})();
// Run-page action forms (I'm in / Sit out / Open / Close / guest / teams / who's-going sheet actions):
// POST via fetch + swap .wrap in place so the page never navigates (scroll kept, instant feedback,
// no full-screen flash). Bound ONCE at document level here in app.js — which loads on every page —
// so it works for ANY run program (basketball / pickleball / volleyball / future) without each run
// page re-binding it. Degrades gracefully: with JS off (or fetch/DOMParser missing) the plain form
// still POSTs and the route 302-redirects as before.
if(!window.__ckControlsBound){ window.__ckControlsBound=true;
  document.addEventListener('submit',function(e){
    var form=e.target.closest&&e.target.closest('.controls form, .arform, .hguest form, .wgsheet form, .teamspanel form, .swapform');
    if(!form)return;
    // An inline onsubmit="return confirm(...)" that the user CANCELLED sets defaultPrevented in the
    // target phase; this document-level listener still fires. Bail so "Cancel" truly cancels (and the
    // fetch doesn't run the action anyway). Load-bearing now that confirm-guarded forms carry swapform.
    if(e.defaultPrevented)return;
    if(!window.fetch||!window.DOMParser||!window.__swapWrap)return;
    e.preventDefault();
    var reopenWg=!!(form.closest&&form.closest('.wgsheet')); // remove/bump from the open sheet → re-open it after the swap
    var btn=form.querySelector('button[type=submit],button:not([type])');
    if(btn){btn.classList.add('is-busy');btn.setAttribute('aria-busy','true');}
    var y=window.scrollY;
    window.__ckBusy=true; // park poll-driven swaps so they can't clobber this optimistic action mid-flight
    fetch(form.action,{method:'POST',body:new URLSearchParams(new FormData(form)),headers:{'X-Requested-With':'fetch'},credentials:'same-origin'})
      .then(function(r){return r.text();})
      .then(function(html){
        document.documentElement.classList.add('noanim'); // a swap isn't a fresh nav → no entry-reveal replay
        window.__ckBusy=false;
        // A redirect shim (e.g. the waiver gate) has no .wrap → swap fails; follow its target so an
        // unwaivered "I'm in" reaches /waiver instead of dead-ending.
        if(!window.__swapWrap(html)){var m=html.match(/location\.replace\("([^"]+)"\)/);window.location.href=m?m[1]:window.location.pathname;return;}
        window.scrollTo(0,y);
        if(reopenWg&&window.wgOpen)window.wgOpen();
        var n=document.querySelector('.count .n');
        if(n){n.classList.remove('pulse-now');void n.offsetWidth;n.classList.add('pulse-now');}
      })
      .catch(function(){window.__ckBusy=false;window.location.href=window.location.pathname;}); // stay on the current run page
  });
}
// Register the service worker (offline shell + Web Push + app-icon badge). Runs on
// real document loads only; harmless where unsupported.
if('serviceWorker' in navigator&&!window.__swBound){window.__swBound=1;
  window.addEventListener('load',function(){try{navigator.serviceWorker.register('/sw.js');}catch(e){}});}
// Shared Web Push enable flow — used by BOTH the first-run check-in prompt and the
// Profile card. Must be called from a user gesture (iOS requires it for the permission
// prompt). Resolves true once the subscription is registered server-side.
window.__pushSupported=function(){return ('serviceWorker' in navigator)&&('PushManager' in window)&&('Notification' in window);};
window.__pushStandalone=function(){return (navigator.standalone===true)||(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches);};
// Where push is actually possible (F1). APPLE requires the installed (standalone) app for web
// push — but that rule is Apple's, not the web's. Desktop Chrome/Edge/Firefox and Android support
// push in a plain tab, and gating THEM on installation meant laptop members silently never got
// spot offers. So: standalone required on iOS/iPadOS only. (iPadOS reports itself as MacIntel with
// touch — that's the maxTouchPoints test.)
window.__pushEligible=function(){
  if(!window.__pushSupported||!window.__pushSupported())return false;
  var ios=/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  return !ios||window.__pushStandalone();
};
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
    var pv=document.getElementById('pvwrap'); if(pv&&pv.classList.contains('open')){if(window.pvClose)window.pvClose();return;} // profile popup is topmost
    var w=document.querySelector('.wgwrap.open'); if(!w)return;
    var id=w.id;
    if(id==='wgwrap'&&window.wgClose)window.wgClose();
    else if(id==='memwrap'&&window.memClose)window.memClose();
    else if(id==='annwrap'&&window.annClose)window.annClose();
  });
}
// Swipe DOWN to dismiss any bottom-sheet (who's-going, run members, announcements, profile) —
// the touch-native equivalent of the X / Esc. Reuses each sheet's own close fn so focus-restore
// and scroll-lock stay correct. Only arms when the sheet body is scrolled to the TOP (so a
// downward swipe over scrollable content still scrolls) and the drag is clearly VERTICAL (so it
// never hijacks the announcement rows' horizontal swipe-to-clear). Bound once; survives swaps.
if(!window.__ovSwipeBound){window.__ovSwipeBound=1;
  var dS=null,dW=null,dBody=null,dScrim=null,y0=0,x0=0,dy=0,drag=false;
  function topSheet(){var pv=document.getElementById('pvwrap');if(pv&&pv.classList.contains('open'))return pv;return document.querySelector('.wgwrap.open');}
  function closeFor(w){var id=w&&w.id;
    if(id==='pvwrap'&&window.pvClose)window.pvClose();
    else if(id==='wgwrap'&&window.wgClose)window.wgClose();
    else if(id==='memwrap'&&window.memClose)window.memClose();
    else if(id==='annwrap'&&window.annClose)window.annClose();}
  function clr(sh,w,sc){if(sh){sh.style.transition='';sh.style.transform='';sh.style.animation='';}if(w){w.style.transition='';w.style.opacity='';}if(sc){sc.style.transition='';sc.style.opacity='';sc.style.animation='';}}
  document.addEventListener('touchstart',function(e){
    if(!e.touches||e.touches.length!==1)return;
    var w=topSheet();if(!w)return;
    if(!e.target.closest||!e.target.closest('.wgsheet'))return; // started on the scrim → its onclick handles it
    var sh=w.querySelector('.wgsheet');if(!sh)return;
    dBody=sh.querySelector('.wgsheet-b');
    if(dBody&&dBody.scrollTop>2){dS=null;return;}            // content scrolled → leave it to scroll
    dS=sh;dW=w;dScrim=w.querySelector('.wgscrim');y0=e.touches[0].clientY;x0=e.touches[0].clientX;dy=0;drag=false;
  },{passive:false});
  document.addEventListener('touchmove',function(e){
    if(!dS)return;
    dy=e.touches[0].clientY-y0;var dx=e.touches[0].clientX-x0;
    if(!drag){                                               // decide direction on the first meaningful move
      if(dy<=3&&Math.abs(dx)<10&&dy>-3)return;               // too small yet
      if(dy<=0||Math.abs(dx)>dy){dS=null;return;}            // upward or horizontal → not a dismiss
      if(dBody&&dBody.scrollTop>2){dS=null;return;}
      drag=true;
      // Take manual control of the scrim so it can LIGHTEN as you pull. Its a-rise has fill:both
      // pinning opacity, so kill that first. Without this the opaque grey backdrop just GROWS behind
      // the sheet as it slides down (revealing more scrim) — that visible grey growth was the "blink".
      if(dScrim){dScrim.style.animation='none';dScrim.style.transition='none';}
    }
    if(dy<0)dy=0;
    e.preventDefault();
    dS.style.transition='none';dS.style.transform='translateY('+dy+'px)';
    if(dScrim)dScrim.style.opacity=String(Math.max(0.06,1-dy/380));  // backdrop fades as the sheet is pulled
  },{passive:false});
  document.addEventListener('touchend',function(){
    if(!dS)return;
    var sh=dS,w=dW,scrim=dScrim,px=dy,wasDrag=drag,h=sh.offsetHeight||500;
    dS=null;dW=null;dBody=null;dScrim=null;drag=false;
    var still=document.documentElement.classList.contains('noanim')||(window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches);
    if(wasDrag&&px>Math.min(150,h*0.28)){                    // past threshold → dismiss
      if(still){clr(sh,w,scrim);closeFor(w);return;}
      // Sheet slides down fully OPAQUE (never fade the sheet/wrap — that bleeds the page through it);
      // the scrim (already animation:none + partly faded from the drag) finishes fading to 0. No
      // bleed-through, no pop, no grey-growth.
      sh.style.animation='none';
      sh.style.transition='transform .18s ease-out';
      if(scrim)scrim.style.transition='opacity .16s ease-out';
      requestAnimationFrame(function(){sh.style.transform='translateY('+(h+40)+'px)';if(scrim)scrim.style.opacity='0';});
      var fired=false,fin=function(){if(fired)return;fired=true;
        // Teardown INLINE, not via the close fn: the close fn would run its OWN 200ms wgdown after
        // ours (wrap still up + scroll locked = a pause). Same teardown all four close fns do — drop
        // .open, and unless another sheet/tour is still up underneath, restore scroll + focus.
        w.classList.remove('open');
        var other=document.querySelector('.wgwrap.open'),t=document.getElementById('tour');
        if(!other&&!(t&&!t.hidden)){document.body.style.overflow='';var p=window.__ovPrev;if(p&&p.focus){try{p.focus();}catch(e){}}}
        clr(sh,w,scrim);};                                   // wrap hidden → full scrim reset restores a-rise for next open
      sh.addEventListener('transitionend',fin,{once:true});
      setTimeout(fin,240);
    }else{                                                   // not far enough (or no real drag) → snap back
      sh.style.transition='transform .2s cubic-bezier(.2,.7,.2,1)';
      sh.style.transform='';
      // Restore the backdrop to full; keep animation:none (re-adding a-rise would replay its fade-in
      // = a flash while the sheet stays open). Leaving it means the NEXT open shows the scrim without
      // the subtle fade-in — negligible, and any real close resets it.
      if(wasDrag&&scrim){scrim.style.transition='opacity .2s ease-out';scrim.style.opacity='1';}
      setTimeout(function(){clr(sh,w);if(wasDrag&&scrim)scrim.style.transition='';},220);
    }
  });
}`;
