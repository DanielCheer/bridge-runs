// views/shell.js — the page shell: <head> (styles and build stamps, the splash, the client engine
// bootstrap, the install wall, the demo strip), the header, and the footers. BUILD_VER and
// CSS_VER (the cache-busting stamps) are computed here at startup.
import fs from 'fs';
import path from 'path';
import { APP_ROOT } from '../config.js';
import { esc } from './util.js';
import { IOS_STEPS, annBell } from './components.js';

// Cache-bust styles.css by its own modification time. Static assets are served
// with a 7-day cache; without this, returning users keep stale CSS after any
// design change. The query only changes when the file changes, so it still
// caches well between edits.
let CSS_VER = '1';
const STYLES_PATH = path.join(APP_ROOT, 'public', 'styles.css');
try { CSS_VER = String(Math.floor(fs.statSync(STYLES_PATH).mtimeMs)); } catch {}

// Build version = newest mtime of the client-facing sources: every module under views/ and
// styles.css. /poll returns it; an open (live-polling)
// session auto-reloads to fresh code on deploy — so shipped fixes reach already-open apps within
// ~10s instead of never.
function viewSources() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(path.join(APP_ROOT, 'views'));
  return out;
}
export let BUILD_VER = CSS_VER;
try {
  const mtimes = [...viewSources(), STYLES_PATH].map((p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } });
  BUILD_VER = String(Math.floor(Math.max(...mtimes)));
} catch {}

// Cold-start splash. Pre-paint script hides #splash before first paint on any
// navigation AFTER the first in a session (sessionStorage 'splashed' flag), so
// it only ever animates on a genuine cold start — no flash on later pages. The
// critical CSS is inlined so the overlay paints correctly before styles.css
// loads. prefers-reduced-motion shortens the hold and drops the spin/fade.
const SPLASH_HEAD = `<script>(function(){try{if(sessionStorage.getItem('splashed'))document.documentElement.className+=' splashed';}catch(e){}})();</script>
<style>
#splash{position:fixed;inset:0;z-index:9999;background:#F8F5EF;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:46px;opacity:1;transition:opacity .5s ease}
html.theme-midnight #splash{background:#364765}
html.theme-midnight #splash .tt b{color:#F2F4F9}
html.theme-midnight #splash .tt .sb,html.theme-midnight #splash .tt .ck{color:#7FC8B5}
html.splashed #splash{display:none}
#splash.hide{opacity:0;pointer-events:none}
#splash .bw{position:relative;display:grid;place-items:center}
#splash .lg{position:absolute;width:230px;height:230px;opacity:.10}
#splash .tt{position:relative;text-align:center}
#splash .tt b{font-family:'Anton',Impact,sans-serif;font-size:46px;letter-spacing:.01em;color:#20211c;line-height:.92;display:block}
#splash .tt .sb{display:block;margin-top:12px;font-family:'Archivo',system-ui,sans-serif;font-weight:800;font-size:12.5px;letter-spacing:.24em;text-transform:uppercase;color:#22615A}
#splash .tt .rl{width:64px;height:3px;margin:16px auto 0;border-radius:3px;background:linear-gradient(90deg,#C24512,#FBB360,#E4611F)}
#splash .tt .ck{display:block;margin-top:15px;font-family:'Archivo',system-ui,sans-serif;font-weight:800;font-size:12.5px;letter-spacing:.2em;text-transform:uppercase;color:#22615A}
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
    <div class="tt"><b>THE BRIDGE</b><span class="sb">YA Sports</span><div class="rl"></div><span class="ck">Christ is King</span></div>
  </div>
  <div class="sp"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
  <div class="ft">5440 16th Ave · Markham</div>
</div>
<script>(function(){var s=document.getElementById('splash');if(!s)return;if(document.documentElement.classList.contains('splashed'))return;var done=function(){s.classList.add('hide');try{sessionStorage.setItem('splashed','1');}catch(e){}setTimeout(function(){if(s&&s.parentNode)s.parentNode.removeChild(s);},600);};var r=window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches;setTimeout(done,r?500:1500);window.addEventListener('load',function(){setTimeout(done,900);});})();</script>`;
// Tiny inline HEAD bootstrap: sets the build version (the ONLY server-interpolated value)
// and the pre-paint no-animation flag BEFORE the engine loads, then pulls the cached engine
// as a BLOCKING script (NOT defer) so its window.* globals exist before any <body> inline
// script runs. ?v=BUILD_VER busts the cache whenever a views module or styles.css changes.
const ANIM_HEAD = `<script>window.__ver=${JSON.stringify(BUILD_VER)};(function(){try{if(sessionStorage.getItem('noanim')){sessionStorage.removeItem('noanim');document.documentElement.className+=' noanim';}}catch(e){}})();</script><script src="/app.js?v=${BUILD_VER}"></script>`;
// ---- Mandatory "Add to Home Screen" wall (mobile browsers only) ----
// Picture-by-picture install guide. People kept getting stuck in three spots, all
// addressed below: (1) Share can be behind the ••• menu, (2) "Add to Home Screen" is
// BELOW the apps / under "More", (3) on iPhone the app installs from SAFARI only (a
// browser or in-app webview must "Open in Safari" first). The visual iOS steps are
// shared with the sign-in guide (installSteps). Pre-paint gate stamps <html.walled>
// only on a mobile browser that isn't the installed app; desktop + standalone never.
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
  // Install hard-lock (re-enabled 2026-07-29): a mobile browser that ISN'T the installed app gets
  // the Add-to-Home-Screen wall — keeps everyone on the uniform PWA (notifications, offline shell,
  // consistent UX). Only mobile (coarse pointer + iOS/Android) is walled; DESKTOP + the standalone
  // app are NEVER walled, so the demo laptop + installed phones are unaffected.
  if(!standalone&&coarse&&(ios||android)){document.documentElement.className+=' walled';}
  window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__bip=e;});
  window.addEventListener('appinstalled',function(){try{navigator.sendBeacon('/metrics/install');}catch(_){}});
}catch(e){}})();</script>`;

// Overlay body + a script that shows the iOS visual steps (adding an "Open in Safari"
// banner when the browser isn't real Safari — Chrome/Firefox/Edge on iOS or an in-app
// webview) or the Android one-tap install button.
const WALL_BODY = `<div id="installwall" role="dialog" aria-modal="true" aria-label="Install the app">
  <div class="iw-in">
    <div style="text-align:center"><img class="iw-icon" src="/icon-192.png" alt=""></div>
    <div class="iw-ey">The Bridge</div>
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

// Demo mode (DEMO_MODE=1, docs/DEMO.md), set once at boot by server.js through setDemoMode().
// Off by default, so production, the tests and the golden master render byte-identically.
// When on: a slim strip on every page, and a persona picker on /login.
let DEMO = null;   // { personas: [{ key, label, who }], resetHours }
export function setDemoMode(on, { personas = [], resetHours = 6 } = {}) {
  DEMO = on ? { personas: personas.map(({ key, label, who }) => ({ key, label, who })), resetHours } : null;
}
const REPO_URL = 'https://github.com/DanielCheer/bridge-runs';
const demoStrip = () => DEMO ? `<div class="demo-strip" role="note" style="background:#183B38;color:#F8F5EF;font:600 12px/1.4 system-ui,sans-serif;text-align:center;padding:6px 12px;position:relative;z-index:50">Demo — fictional data, resets every ${esc(String(DEMO.resetHours))} hours · <a href="/demo/reset" style="color:#F8F5EF;text-decoration:underline">Reset (organizer)</a> · <a href="${REPO_URL}" target="_blank" rel="noopener" style="color:#F8F5EF;text-decoration:underline">GitHub ↗</a></div>` : '';
const demoPersonaPicker = () => DEMO ? `
    <span class="eyebrow">Live demo</span>
    <h1>Pick who to be</h1>
    <p class="lead">Every account here is fictional. Pick a role to sign in as that person, no email needed.</p>
    <form method="POST" action="/demo/login" class="card rail demo-personas">
      ${DEMO.personas.map(p => `<button class="btn ghost" type="submit" name="persona" value="${esc(p.key)}" style="display:block;width:100%;text-align:left;margin:0 0 8px"><b>${esc(p.label)}</b><br><span class="tally-note" style="margin:0">${esc(p.who)}</span></button>`).join('')}
    </form>
    <p class="tally-note" style="margin:18px 0 8px">Or use the normal sign-in below. No email is sent in the demo: the code shows on the next screen.</p>` : '';

const HEAD = (title, bodyClass = '', { wall = true } = {}) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#F8F5EF">
<script>/* User theme bootstrap — BEFORE styles load so there is no flash. Class lives on <html>
(the router swap replaces body.className, html survives). Whitelisted; a stale value from a
removed theme is cleaned up so the picker's highlight matches reality. Classic = no class.
Runs AFTER the theme-color meta above so it can restamp the browser/PWA chrome tint too. */
try{var t=localStorage.getItem('bridgeTheme');
if(t&&/^(midnight)$/.test(t)){document.documentElement.className='theme-'+t;
var m=document.querySelector('meta[name=theme-color]');if(m)m.setAttribute('content','#364765');}
else if(t)localStorage.removeItem('bridgeTheme');}catch(e){}</script>
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
<link rel="preload" href="/fonts/archivo.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/styles.css?v=${CSS_VER}">
</head><body class="${bodyClass}">${SPLASH_BODY}${demoStrip()}${wall ? WALL_BODY : ''}<div class="wrap">`;

const FOOTER_LINKS = `<div class="foot legalfoot"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/conduct">Conduct</a></div>`;
const FOOT = `${FOOTER_LINKS}</div></body></html>`;
// Tab-bar pages: render the fixed bottom tab bar as the LAST child of `.wrap`, with the footer
// text BEFORE it. It must stay inside `.wrap` (the client router swaps `.wrap` — the active-tab
// highlight comes from re-rendering it), but nothing must sit AFTER it in the scroll flow: on
// iOS Safari, in-flow content after a fixed bottom bar peeks out below it on overscroll (the
// tabs looked like they "moved" at the bottom). Footer-then-tabs fixes that while keeping the
// router's swap intact.
// The tab bar lives OUTSIDE .wrap (a direct <body> child) so no ancestor of .wrap can ever
// become a containing block for its position:fixed (iOS WebKit was trapping it mid-page). The
// SPA router swaps it explicitly (see __swapWrap). .wrap closes first, then the nav.
const footWithTabs = (tabsHtml, opts = {}) => `${opts.noFooter ? '' : FOOTER_LINKS}</div>${tabsHtml}</body></html>`;

// The scoreboard basketball mark — used in the masthead.
const BALL = `<svg class="ball" viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="#22615A"/><path d="M20 2v36M2 20h36M7 7c7 5 7 21 0 26M33 7c-7 5-7 21 0 26" stroke="#F8F5EF" stroke-width="1.5" opacity=".85"/></svg>`;

// Masthead — ball mark + wordmark on the left; an announcements BELL then
// <run-weekday> · 7–10 PM on the right. `right` is accepted for backwards-compat but
// the mast is fixed; every caller follows it with <div class="rule"></div>.
// `weekdayShort` reflects the current run's day (defaults to FRI for pages with no run
// context). `ann` (optional) = the viewer's announcement state — when present the bell +
// its bottom-sheet panel render; when omitted (public / non-approved pages) neither does.
const header = (right = '', weekdayShort = '', ann = null, hours = '') => { // hours passed only where there's a run context; blank on other pages
  const { btn, sheet } = annBell(ann);
  return `<div class="mast">
  <div class="bl">${BALL}<div class="wm"><b>THE BRIDGE</b></div></div>
  <div class="mastr"><div class="when">${weekdayShort ? `<b>${esc(weekdayShort)}</b>` : ''}<span>${esc(hours)}</span></div>${btn}</div>
</div>${sheet}`;
};

export {
  HEAD, FOOT, header, demoPersonaPicker, footWithTabs,
};
