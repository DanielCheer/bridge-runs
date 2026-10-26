// views/pages/messages.js — a direct-message thread.
import { esc, _mDate, dayKey, fmtClock, fmtDay } from '../util.js';
import { avatarInner, WELCOME_MODAL, IC_BACK } from '../components.js';
import {
  sendErrNotice, bubbleInner, lightboxScript, composerForm, composerInitJS, longPressScript,
} from '../chat-ui.js';
import { HEAD, FOOT } from '../shell.js';

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

  return HEAD('Messages — The Bridge', 'thread-page') + WELCOME_MODAL + `
    <div class="pbar">
      <a class="pbback" href="/profile" aria-label="Back">${IC_BACK}</a>
      <a class="pbwho" href="/u/${p.id}">
        <span class="pbav">${avatarInner(p.email, name)}</span>
        <span class="pbnm">${esc(name)}${p.is_host ? '<small>★ Host</small>' : ''}</span>
      </a>
    </div>
    <div class="dmpriv" role="note">🔒 Private chat — kept encrypted, and organizers don't read your messages.</div>
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
        window.__threadRefresh=function(gentle){
          if(!window.fetch||!window.DOMParser)return;
          var atBottom=(window.innerHeight+window.scrollY)>=(document.body.scrollHeight-40);
          if(gentle&&!atBottom)return; // a poll tick must not yank a scrolled-up reader
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
            .then(function(r){ if(r.redirected&&r.url&&r.url.indexOf('err=')>=0){window.location.href=r.url;return;} window.__threadRefresh(); }) // any err= (slow/suspended/…) surfaces its notice
            .catch(function(){ window.location.href=location.pathname; });
        }); }
        // Live updates via the shared 10s poll (page=profile detects DM changes) — patches
        // #thread in place instead of the old 20s full-page reload; gentle so a scrolled-up
        // reader isn't yanked, and the composer/typing survive.
        if(window.__poll)window.__poll('profile',function(){window.__threadRefresh(true);});
      })();
    </script>
    ${longPressScript()}
    ${lightboxScript()}
  ` + FOOT;
}
