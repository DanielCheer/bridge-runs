// views/chat-ui.js — the messaging UI shared by group chat and DMs: message bubbles (photo,
// voice, video, sticker, @-mentions), the composer with stickers and its client script, the
// photo lightbox and voice player, the press-and-hold menu, and the chat room fragment.
import { CHAT_VIDEO_MAX_MB } from '../config.js';
import { esc, _mDate, dayKey, fmtClock, fmtDay } from './util.js';
import {
  IC_PLAY, IC_PAUSE, IC_SAVE, IC_SEND, IC_CLOSE, IC_PLUS, IC_PHOTO, IC_STICKER, IC_MIC, IC_VIDEO,
  IC_REPLY, IC_TRASH, IC_PIN, IC_COPY, avatarInner, GROUP_ICON,
} from './components.js';

// ---------- STICKER PACK (Bridge / basketball themed, SVGs in public/stickers) ----------
// The single source of truth for the starter pack. lib/media.js imports this to validate
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
    // Cross-platform playback can fail silently (e.g. Android WebM/Opus on older iOS). Surface
    // it instead of a dead player: an errored/unplayable clip shows a "can't play — save" note.
    function mediaErr(t){ if(!t||!t.tagName||(t.tagName!=='AUDIO'&&t.tagName!=='VIDEO')||!t.closest('.msg'))return; var b=t.closest('.mbwrap')||t.parentNode; if(!b||b.__mErr)return; b.__mErr=1; var n=document.createElement('div'); n.className='media-err'; n.style.cssText='font-size:12px;color:var(--muted,#8a8474);margin-top:6px'; n.textContent='⚠️ Can’t play this on your device — press & hold to save.'; b.appendChild(n); }
    document.addEventListener('error',function(e){ mediaErr(e.target); },true);
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
// Client-side video size cap — mirrors the server's CHAT_VIDEO_MAX_MB (config.js, the same
// value) so an over-cap clip is rejected BEFORE it uploads over Daniel's home
// connection through Funnel, rather than after a doomed full upload → 413.
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
          var CB=cform.getAttribute('action')||'/chat'; // base path (/chat or /pickleball/chat) — keep media in the same room
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
            fetch(CB+'/video',{method:'POST',body:fd,headers:{'X-Requested-With':'fetch'},credentials:'same-origin'})
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
          function reset(comp){ engaged=false; lastCss=''; window.__composerEngaged=false; if(window.__kbSync)window.__kbSync();
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
                window.__composerEngaged=true; if(window.__kbSync)window.__kbSync();   // the global watcher owns body.kb-open
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
          var CB=cform.getAttribute('action')||'/chat'; // base path (/chat or /pickleball/chat) — keep media in the same room
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
            fetch(CB+'/voice',{method:'POST',body:fd,headers:{'X-Requested-With':'fetch'},credentials:'same-origin'})
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
                       senders = new Map(), mentionNames = new Map(), isMod = false, canPin = false }, base = '/chat') {
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
      const dIdx = /^demo-(\d+)@demo\.local$/.exec(m.from_email);
      head = sid ? `<a class="mname" href="/u/${sid}" onclick="if(window.pvOpen){pvOpen(${sid});return false;}">${label}</a>`
        : dIdx ? `<a class="mname" href="#" onclick="if(window.pvOpenDemo){pvOpenDemo(${Number(dIdx[1])});}return false;">${label}</a>`
        : `<div class="mname">${label}</div>`;
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
    const chips = rx.length ? `<div class="tapbacks">${rx.map(r => `<form method="POST" action="${base}/react" class="tbf">
        <input type="hidden" name="message_id" value="${m.id}"><input type="hidden" name="emoji" value="${esc(r.emoji)}">
        <button class="tb${r.mine ? ' mine' : ''}" type="submit" title="Toggle reaction">${esc(r.emoji)}${r.count > 1 ? ` <span>${r.count}</span>` : ''}</button>
      </form>`).join('')}</div>` : '';

    const time = tail ? `<div class="mt">${esc(fmtClock(m.created_at))}</div>` : '';

    // Press-and-hold affordances travel as data-* (read by longPressScript). Reply
    // is always available in the group room; Delete only when the viewer may delete
    // (own message always; any message if host/admin).
    const canDel = isMod || mine;
    const saveable = m.video ? m.video : m.audio ? m.audio : (m.image && !isSticker(m.image) ? m.image : '');
    const lpData = `data-mid="${m.id}" data-reacturl="${base}/react" data-reply-id="${m.id}" data-reply-nm="${esc(mine ? 'You' : nameFor(m.from_email))}"`
      + (canDel ? ` data-candel="1" data-delurl="${base}/delete"` : '')
      + (saveable ? ` data-save="${esc(saveable)}"` : '')
      + (canPin ? ` data-canpin="1" data-pinurl="${base}/pin" data-pinned="${m.pinned_at ? '1' : '0'}"` : '');

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
const pinnedBar = (pinned = [], pinnedNames = new Map(), canPin = false, base = '/chat') => {
  if (!pinned.length) return '';
  const rows = pinned.map(p => {
    const who = esc(pinnedNames.get(p.from_email) || p.from_email);
    const txt = p.body ? esc(p.body) : (p.audio ? '🎤 Voice message' : p.video ? '🎥 Video' : p.image ? '📷 Photo' : '📌 Pinned');
    const unpin = canPin ? `<form method="POST" action="${base}/pin" class="pinx-f"><input type="hidden" name="message_id" value="${p.id}"><button type="submit" class="pinx" aria-label="Unpin">${IC_CLOSE}</button></form>` : '';
    return `<div class="pinrow"><button type="button" class="pinjump" data-jump="${p.id}"><b>${who}</b> <span>${txt}</span></button>${unpin}</div>`;
  }).join('');
  return `<details class="pinned" id="pinnedbar" open><summary>📌 Pinned · ${pinned.length}</summary>${rows}</details>`;
};

function chatFragment({ me, msgs = [], reactions = new Map(), parents = new Map(),
                        senders = new Map(), mentionNames = new Map(), isMod = false, canPin = false,
                        pinned = [], pinnedNames = new Map(), hasOlder = false, err = '',
                        base = '/chat', pollPage = 'chat', placeholder = 'Message the run',
                        emptyName = 'Run Chat', emptyMsg = 'This is the start of the room — say hi to the whole run 👋' }) {
  let body = groupMsgBody({ me, msgs, reactions, parents, senders, mentionNames, isMod, canPin }, base);

  if (!msgs.length) {
    body = `<div class="mstart"><div class="mstartav">${GROUP_ICON}</div><b>${esc(emptyName)}</b><p>${esc(emptyMsg)}</p></div>`;
  }

  const composer = composerForm(base, placeholder, { mentions: true });

  return `
    ${sendErrNotice(err)}
    ${pinnedBar(pinned, pinnedNames, canPin, base)}
    <div class="thread" id="thread">${loadOlderBtn(hasOlder)}${body}</div>
    ${composer}
    <script>
      (function(){
        var thread=document.getElementById('thread');
        var tid=${JSON.stringify(pollPage)};
        var CHATBASE=${JSON.stringify(base)};
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
        // The 10s poll is GENTLE: if you've scrolled up (reading history / an older page
        // loaded), don't yank the feed to the latest. Explicit actions (send/react/delete)
        // pass no gentle arg. The prefetched arg lets a send reuse its POST response body.
        window.__threadRefresh=function(gentle, prefetched){
          if(!window.fetch||!window.DOMParser)return;
          var atBottom=(window.innerHeight+window.scrollY)>=(document.body.scrollHeight-40);
          if(gentle&&!atBottom)return;
          function playing(n){var m=n.querySelectorAll('audio,video');for(var i=0;i<m.length;i++){if(!m[i].paused&&!m[i].ended)return true;}return false;}
          function apply(html){
            var doc=new DOMParser().parseFromString(html,'text/html');
            var nt=doc.getElementById('thread');
            if(nt){
              // Incremental reconcile by data-mid: APPEND new messages, PATCH changed ones in
              // place, REMOVE deletes within the fetched window — never a full innerHTML wipe
              // (which cuts a voice/video playing mid-listen, drops loaded scroll-back history,
              // and re-renders all 200 bubbles). Voice-player listeners are delegated on
              // document, so appended/patched audio needs no re-binding.
              var opt=thread.querySelectorAll('.msg:not([data-mid])');            // optimistic echoes — the server render now carries the real row
              for(var i=0;i<opt.length;i++){ var bl=opt[i].querySelectorAll('img[src^="blob:"],video[src^="blob:"]'); for(var q=0;q<bl.length;q++){ try{URL.revokeObjectURL(bl[q].src);}catch(_){} } if(opt[i].parentNode)opt[i].parentNode.removeChild(opt[i]); }
              var cur={}, cn=thread.querySelectorAll('.msg[data-mid]');
              for(var i=0;i<cn.length;i++) cur[cn[i].getAttribute('data-mid')]=cn[i];
              var fn=nt.querySelectorAll('.msg[data-mid]'), fids={}, fmin=Infinity;
              for(var i=0;i<fn.length;i++){var id=+fn[i].getAttribute('data-mid');fids[id]=1;if(id<fmin)fmin=id;}
              for(var mid in cur){ if(+mid>=fmin && !fids[+mid]){ if(cur[mid].parentNode)cur[mid].parentNode.removeChild(cur[mid]); delete cur[mid]; } }
              var last=null;
              for(var i=0;i<fn.length;i++){
                var f=fn[i], id=f.getAttribute('data-mid'), ex=cur[id];
                if(!ex){ var imp=document.importNode(f,true); imp.classList.add('msg-in');
                  if(last&&last.parentNode) last.parentNode.insertBefore(imp,last.nextSibling); else thread.appendChild(imp);
                  last=imp;
                } else { if(!playing(ex) && ex.innerHTML!==f.innerHTML) ex.innerHTML=f.innerHTML; last=ex; }
              }
            }
            var nm=doc.querySelector('.chatsec-t span'),cm=document.querySelector('.chatsec-t span');
            if(nm&&cm)cm.textContent=nm.textContent;
            if(atBottom)toBottom();
          }
          if(prefetched){ apply(prefetched); return; }
          fetch(CHATBASE,{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.text();}).then(apply).catch(function(){});
        };
        // Keep the newest message in view as photos decode: a lazy image loading below the
        // fold grows the page; if we're already near the bottom, re-anchor so you don't get
        // stranded above the latest message (chat imgs have no reserved dimensions).
        thread.addEventListener('load',function(e){ if(e.target&&e.target.tagName==='IMG'){ if((window.innerHeight+window.scrollY)>=(document.body.scrollHeight-140))toBottom(); } },true);
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
          fetch(CHATBASE+'/older?before='+encodeURIComponent(before),{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}})
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
            .then(function(r){ if(r.redirected&&r.url&&r.url.indexOf('err=')>=0){window.location.href=r.url;return;} return r.text().then(function(html){ window.__threadRefresh(false,html); }); }) // any err= (slow/suspended/…) → show the notice; else reuse the POST response, no 2nd fetch
            .catch(function(){ window.location.href=CHATBASE; });
        }); }
        // Poll-and-patch the feed (P0-1): re-fetch + patch #thread only on change,
        // never touching the composer. Replaces the old 20s full-page reload.
        if(window.__poll)window.__poll(tid,function(){window.__threadRefresh(true);});
      })();
    </script>
    ${longPressScript()}
    ${lightboxScript()}
    ${voicePlayerScript()}`;
}

export {
  chatFragment, isSticker, sendErrNotice, bubbleInner, lightboxScript, composerForm, composerInitJS,
  longPressScript, groupMsgBody, loadOlderBtn,
};
