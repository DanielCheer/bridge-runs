// views/pages/misc.js — small single-purpose pages: account status, demo reset, sign-out, the
// confirm-an-action interstitial, the banner crop tool and the waiver gate.
import { esc } from '../util.js';
import { homeScreenCard, qrBlock } from '../components.js';
import { HEAD, FOOT, header } from '../shell.js';

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
