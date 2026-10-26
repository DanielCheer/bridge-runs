// views/pages/kiosk.js — the big-screen door roster.
import { esc } from '../util.js';
import { avatarInner } from '../components.js';
import { HEAD } from '../shell.js';

// ---------- KIOSK (F7) — big-screen live roster for the gym door ----------
// Self-contained page (no tabs, no session assumptions): giant type readable from metres away,
// refreshes itself every 8s by fetching its own URL and swapping the list (no SPA machinery).
export function kioskPage({ sport, emoji, theme = '', runDate = '', dateLabel = '', cap = 0, floor = [], wait = [], cancelled = false, door = null }) {
  // door = { live, arrived, walkIns } when PCO kiosk-arrivals is on and today is the run day:
  // rows gain an IN chip as the station taps people, the count line gains the building tally.
  // `live` false = first fetch hasn't landed yet — say "starting…" rather than a false zero.
  const row = (p, i, cls) => `<div class="krow ${cls}${p.arrived ? ' kinrow' : ''}"><span class="kn">${i + 1}</span><span class="kav">${avatarInner(p.email || '', p.name)}</span><span class="km">${esc(p.name)}${p.confirmed ? ' <span class="kc">✓</span>' : ''}${p.arrived ? ' <span class="kin">IN</span>' : ''}</span></div>`;
  const doorLine = !door ? '' : (door.live
    ? ` · ${door.arrived} in the building${door.walkIns ? ` · +${door.walkIns} walk-in${door.walkIns === 1 ? '' : 's'}` : ''}`
    : ' · door sync starting…');
  return HEAD(`${sport} — door`, `kiosk ${theme}`, { wall: false }) + `
    <style>
      body.kiosk{overflow:auto} body.kiosk .wrap{max-width:1100px;padding:28px}
      .khead{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:8px}
      .khead h1{font-size:44px;margin:0} .khead .kd{font-size:22px;color:var(--muted)}
      .kcount{font-size:26px;font-weight:800;margin:2px 0 18px}
      .kcols{display:grid;grid-template-columns:1fr 1fr;gap:28px}
      @media (max-width:700px){.kcols{grid-template-columns:1fr}}
      .ksec h2{font-size:20px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 10px}
      .krow{display:flex;gap:14px;align-items:center;padding:10px 14px;border:1px solid var(--line);border-radius:12px;margin-bottom:8px;background:var(--card)}
      .krow .kn{font-weight:800;font-size:22px;min-width:34px;color:var(--muted)}
      .kav{width:44px;height:44px;border-radius:50%;overflow:hidden;flex:none;display:grid;place-items:center;
        font-family:var(--head);font-weight:800;font-size:16px;color:#fff;background:linear-gradient(150deg,#2f7169,#1a453f)}
      .kav img{width:100%;height:100%;object-fit:cover}
      .krow .km{font-size:26px;font-weight:600} .kc{color:var(--good);font-weight:800}
      .krow.kw .km{font-size:22px;font-weight:500}
      .kin{background:#2e7d53;color:#fff;font-size:15px;font-weight:800;padding:2px 9px;border-radius:8px;vertical-align:2px;letter-spacing:.05em}
      .krow.kinrow{border-color:var(--good)}
      .kcxl{font-size:34px;font-weight:800;margin:40px 0;text-align:center}
      /* PIN-gated exit (owner ask 2026-08-05): the kiosk iPad shouldn't offer a way off this
         screen — no footer links here, and leaving goes through a 4-digit pad. A SOFT gate:
         it stops wandering fingers, not Safari's URL bar — pair with iOS Guided Access. */
      #kexit{position:fixed;top:14px;right:14px;width:44px;height:44px;border-radius:50%;border:1px solid var(--line);
        background:var(--card);color:var(--muted);font-size:17px;opacity:.45;cursor:pointer;z-index:40}
      #kpin{position:fixed;inset:0;z-index:50;background:rgba(15,18,14,.55);display:grid;place-items:center}
      #kpin[hidden]{display:none} /* display:grid would otherwise beat the [hidden] UA rule (same trap as .replychip) */
      .kpin-box{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:22px 24px;width:300px;text-align:center;box-shadow:0 24px 60px -20px rgba(0,0,0,.5)}
      .kpin-box b{font-family:var(--head);font-size:15px;letter-spacing:.06em;text-transform:uppercase}
      .kpin-dots{display:flex;justify-content:center;gap:12px;margin:16px 0 18px}
      .kpin-dots i{width:14px;height:14px;border-radius:50%;border:2px solid var(--muted);display:inline-block}
      .kpin-dots i.f{background:var(--ink);border-color:var(--ink)}
      .kpin-box.bad .kpin-dots i{border-color:var(--bad);background:transparent}
      .kpin-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
      .kpin-pad button{min-height:56px;border-radius:14px;border:1px solid var(--line);background:var(--bg);color:var(--ink);
        font-family:var(--head);font-weight:800;font-size:21px;cursor:pointer}
      .kpin-cancel{margin-top:14px;background:none;border:none;color:var(--muted);font-size:13px;font-weight:700;cursor:pointer;font-family:var(--head)}
    </style>
    <div id="kbody">
    <div class="khead"><h1>${esc(emoji)} ${esc(sport)}</h1><span class="kd">${esc(dateLabel)}</span></div>
    ${cancelled ? `<div class="kcxl">🚫 Cancelled this week</div>` : `
    <div class="kcount">${floor.length} / ${cap} on the floor · ${wait.length} waiting${doorLine}</div>
    <div class="kcols">
      <div class="ksec"><h2>On the floor</h2>${floor.map((p, i) => row(p, i, '')).join('') || '<p style="color:var(--muted)">Nobody yet.</p>'}</div>
      <div class="ksec"><h2>Waitlist</h2>${wait.map((p, i) => row(p, i, 'kw')).join('') || '<p style="color:var(--muted)">Empty — spots open.</p>'}</div>
    </div>`}
    </div>
    <script>(function(){var miss=0;setInterval(function(){fetch(location.href).then(function(r){return r.text()}).then(function(t){
      var m=t.match(/<div id="kbody">([\\s\\S]*?)<\\/div>\\s*<script>/);
      if(m){miss=0;document.getElementById('kbody').innerHTML=m[1];}
      else if(++miss>=4){/* token rotated / link dead (P3-3): say so instead of freezing on a stale roster */
        document.getElementById('kbody').innerHTML='<div class="kcxl">📺 Screen disconnected<br><span style="font-size:20px;font-weight:600">This kiosk link was refreshed — open the new link from Admin → Programs.</span></div>';}
    }).catch(function(){});},8000);})();</script>
    <button id="kexit" type="button" aria-label="Exit kiosk">✕</button>
    <div id="kpin" hidden>
      <div class="kpin-box">
        <b>Exit kiosk</b>
        <div class="kpin-dots"><i></i><i></i><i></i><i></i></div>
        <div class="kpin-pad">
          <button type="button" data-k="1">1</button><button type="button" data-k="2">2</button><button type="button" data-k="3">3</button>
          <button type="button" data-k="4">4</button><button type="button" data-k="5">5</button><button type="button" data-k="6">6</button>
          <button type="button" data-k="7">7</button><button type="button" data-k="8">8</button><button type="button" data-k="9">9</button>
          <span></span><button type="button" data-k="0">0</button><button type="button" data-k="del">⌫</button>
        </div>
        <button type="button" class="kpin-cancel">Cancel</button>
      </div>
    </div>
    <script>(function(){
      var PIN='0000'; // owner-set soft gate (stops wandering fingers, not the URL bar — use Guided Access on the iPad)
      var buf='', pin=document.getElementById('kpin'), box=pin.querySelector('.kpin-box'),
          dots=pin.querySelectorAll('.kpin-dots i');
      function draw(){ for(var i=0;i<4;i++) dots[i].className = i<buf.length ? 'f' : ''; }
      document.getElementById('kexit').addEventListener('click',function(){ buf=''; draw(); box.classList.remove('bad'); pin.hidden=false; });
      pin.querySelector('.kpin-cancel').addEventListener('click',function(){ pin.hidden=true; });
      pin.addEventListener('click',function(e){
        var b=e.target && e.target.closest && e.target.closest('[data-k]'); if(!b) return;
        var k=b.getAttribute('data-k');
        if(k==='del'){ buf=buf.slice(0,-1); draw(); return; }
        if(buf.length>=4) return;
        buf+=k; draw();
        if(buf.length===4){
          if(buf===PIN){ window.location.href='/runs'; }
          else { box.classList.add('bad'); setTimeout(function(){ buf=''; draw(); box.classList.remove('bad'); },500); }
        }
      });
    })();</script>
  </div></body></html>`;
}
