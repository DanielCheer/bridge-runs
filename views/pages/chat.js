// views/pages/chat.js — the chat tab: basketball's room, any program's room, the load-older
// fragment, and the locked state before a member has joined a run.
import { esc, wdayShort } from '../util.js';
import {
  IC_CLOSE, avatarInner, GROUP_ICON, MINOR_STAR, tabNav, WELCOME_MODAL, pvSheet, pvScript,
} from '../components.js';
import { chatFragment, groupMsgBody, loadOlderBtn } from '../chat-ui.js';
import { HEAD, header, footWithTabs } from '../shell.js';

// ---------- CHAT (standalone group Run Chat page — the Chat tab) ----------
// The group Run Chat is its own full page now. Page chrome (masthead + a Run Chat
// section header) + the shared chatFragment (feed + pinned composer + reload/scroll
// script). body.has-chat reserves room for the composer sitting just above the
// bottom tab bar. Mark-read happens in the GET /chat route.
export function chatPage({ me, chat, runDate = '', hours = '8:30–10:30 PM', dmUnread = 0, groupUnread = 0, groupMention = 0, ann = null }) {
  const members = chat.members || [];
  // Member row → tappable link to their profile. No role badges in lists (roles are
  // admin-only, on profiles); a minor gets the red asterisk for awareness.
  const memRow = (p) => `<a class="lr" href="/u/${p.id}">
      <span class="lav">${avatarInner(p.email, p.full_name)}</span>
      <span class="lnm">${esc(p.full_name)}${p.minor ? MINOR_STAR : ''}${p.email === me ? ' <span class="tag">You</span>' : ''}</span>
    </a>`;
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
  return HEAD('Run Chat — The Bridge', 'has-chat') + header('', wdayShort(runDate), ann, hours) + WELCOME_MODAL + `
    <div class="rule"></div>
    <div class="chatsec chatsec-top">
      <div class="chatsec-h">
        <a class="chatback" href="/checkin" aria-label="Back to the run">‹</a>
        <div class="chatsec-tap" role="button" tabindex="0" onclick="memOpen()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();memOpen()}" aria-label="View run members">
          <span class="chav">${GROUP_ICON}</span>
          <div class="chatsec-t"><b>Run Chat</b><span>${chat.memberCount} member${chat.memberCount === 1 ? '' : 's'} · talk to the whole run</span></div>
          <span class="chatsec-chev" aria-hidden="true">›</span>
        </div>
      </div>
    </div>
    ${chatFragment(chat)}
    ${membersSheet}
    ${pvSheet()}
    ${pvScript()}
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
  ` + footWithTabs(tabNav('chat', { dm: dmUnread, group: groupUnread, groupMention }), { noFooter: true });
}

// Run chat — an opt-in run's own room (pickleball, volleyball, …), a program-generic mirror of the
// basketball chatPage on the SAME unified group_messages tables (keyed by program_id). Reuses the
// base-pathed chatFragment so the whole message UI (reactions, replies, pins, voice/video, @mentions,
// poll-patch) is identical. The Chat tab stays on THIS run here (program). Copy/theme/base all come
// from the caller → a new run needs no new chat page, just its params.
export function runChatPage({ me, chat, program = 2, theme = 'pk', sport = 'Pickleball', sportEmoji = '🥒', base = '/pickleball/chat', pollPage = 'pkchat', dmUnread = 0, groupUnread = 0, groupMention = 0, ann = null }) {
  const members = chat.members || [];
  // Program names are ADMIN-SUPPLIED now (in-app program creation), so every interpolation of the
  // sport name/emoji is escaped here. Case conversion happens BEFORE escaping so an entity can't
  // be mangled (esc-then-uppercase would turn &amp; into &AMP;).
  const low = esc(sport.toLowerCase()), sportE = esc(sport), emojiE = esc(sportEmoji);
  const memRow = (p) => `<a class="lr" href="/u/${p.id}">
      <span class="lav">${avatarInner(p.email, p.full_name)}</span>
      <span class="lnm">${esc(p.full_name)}${p.minor ? MINOR_STAR : ''}${p.email === me ? ' <span class="tag">You</span>' : ''}</span>
    </a>`;
  const membersSheet = `
    <div id="memwrap" class="wgwrap">
      <div class="wgscrim" onclick="memClose()"></div>
      <div class="wgsheet" role="dialog" aria-modal="true" aria-label="${sportE} members">
        <div class="wgsheet-h"><b>${sportE} members · ${members.length}</b><button class="wgx" type="button" onclick="memClose()" aria-label="Close">${IC_CLOSE}</button></div>
        <div class="wgsheet-b">
          ${members.length ? members.map(memRow).join('') : '<div class="subh">No members yet.</div>'}
        </div>
      </div>
    </div>`;
  return HEAD(`${sport} Chat — The Bridge`, `has-chat ${theme}`) + header('', '', ann, '') + WELCOME_MODAL + `
    <div class="rule"></div>
    <div class="chatsec chatsec-top">
      <div class="chatsec-h">
        <a class="chatback" href="${esc(base.replace(/\/chat$/, ''))}" aria-label="Back to the ${low} run">‹</a>
        <div class="chatsec-tap" role="button" tabindex="0" onclick="memOpen()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();memOpen()}" aria-label="View ${low} members">
          <span class="chav">${emojiE}</span>
          <div class="chatsec-t"><b>${sportE} Chat</b><span>${chat.memberCount} member${chat.memberCount === 1 ? '' : 's'} · talk to the ${low} run</span></div>
          <span class="chatsec-chev" aria-hidden="true">›</span>
        </div>
      </div>
    </div>
    ${chatFragment({ ...chat, base, pollPage, placeholder: `Message the ${low} run`, emptyName: `${sportE} Chat`, emptyMsg: `This is the start of the ${low} room — say hi ${emojiE}` })}
    ${membersSheet}
    ${pvSheet()}
    ${pvScript()}
    <script>
      window.memOpen=function(){var w=document.getElementById('memwrap');if(w){window.__ovPrev=document.activeElement;w.classList.add('open');document.body.style.overflow='hidden';var sh=w.querySelector('.wgsheet');if(sh){sh.setAttribute('tabindex','-1');try{sh.focus();}catch(e){}}}};
      window.memClose=function(){var w=document.getElementById('memwrap');if(!w)return;var sh=w.querySelector('.wgsheet');
        var still=document.documentElement.classList.contains('noanim')||(window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches);
        function restore(){var p=window.__ovPrev;if(p&&p.focus)try{p.focus();}catch(e){}}
        if(sh&&!still){sh.classList.add('closing');setTimeout(function(){w.classList.remove('open');sh.classList.remove('closing');document.body.style.overflow='';restore();},200);}
        else{w.classList.remove('open');document.body.style.overflow='';restore();}};
    </script>
  ` + footWithTabs(tabNav('chat', { dm: dmUnread, group: groupUnread, groupMention, program }), { noFooter: true });
}

// ---------- RUN CHAT: the shared group room fragment (rendered inside chatPage) ----------
// A prepended scroll-back page: an optional fresh button + the older bubbles.
export function chatOlderFragment({ me, msgs = [], reactions = new Map(), parents = new Map(),
                                    senders = new Map(), mentionNames = new Map(), isMod = false, canPin = false, hasOlder = false, base = '/chat' }) {
  return loadOlderBtn(hasOlder) + groupMsgBody({ me, msgs, reactions, parents, senders, mentionNames, isMod, canPin }, base);
}

// The run-aware Chat tab lands here for a viewer who belongs to no run. Greyed tab + this prompt =
// "join a run to unlock its chat." Self-correcting on the server: anyone who HAS joined a run is
// bounced to that run's real chat before this ever renders.
export function chatLockedPage({ email, dmUnread = 0 }) {
  return HEAD('Chat — The Bridge', 'has-tabs') + header('<b>CHAT</b>' + esc(email)) + `
    <div class="rule"></div>
    <div class="card rail" style="margin-top:18px;text-align:center;padding:26px 20px">
      <div style="font-size:42px;line-height:1">🔒</div>
      <h1 style="margin:10px 0 6px">Chat is locked</h1>
      <p class="lead" style="margin:0 auto 18px;max-width:32ch">Join a run to unlock its chat and talk with the group.</p>
      <a class="btn primary" href="/runs">Browse runs →</a>
    </div>
  ` + footWithTabs(tabNav('chat', { dm: dmUnread, program: 0 }), { noFooter: true });
}
