// views/pages/runs-hub.js — the runs hub (/runs) with the daily verse, the join-a-run page, past
// run rosters and the season board.
import { esc, wdayFull } from '../util.js';
import {
  annBell, avatarInner, tabNav, firstRunTour, WELCOME_MODAL, backToRuns, MINOR_STAR,
} from '../components.js';
import { HEAD, footWithTabs, header } from '../shell.js';

// Daily KJV verse for the runs hub — deterministic by calendar day (same for everyone that day,
// rotates at midnight). Curated toward strength, brotherhood, perseverance, and running the race.
const KJV_VERSES = [
  { text: 'I can do all things through Christ which strengtheneth me.', ref: 'Philippians 4:13' },
  { text: 'But they that wait upon the LORD shall renew their strength; they shall mount up with wings as eagles; they shall run, and not be weary; and they shall walk, and not faint.', ref: 'Isaiah 40:31' },
  { text: 'Iron sharpeneth iron; so a man sharpeneth the countenance of his friend.', ref: 'Proverbs 27:17' },
  { text: 'Be strong and of a good courage; be not afraid, neither be thou dismayed: for the LORD thy God is with thee whithersoever thou goest.', ref: 'Joshua 1:9' },
  { text: 'Know ye not that they which run in a race run all, but one receiveth the prize? So run, that ye may obtain.', ref: '1 Corinthians 9:24' },
  { text: 'Let us run with patience the race that is set before us.', ref: 'Hebrews 12:1' },
  { text: 'Two are better than one; because they have a good reward for their labour.', ref: 'Ecclesiastes 4:9' },
  { text: 'A friend loveth at all times, and a brother is born for adversity.', ref: 'Proverbs 17:17' },
  { text: 'And whatsoever ye do, do it heartily, as to the Lord, and not unto men.', ref: 'Colossians 3:23' },
  { text: 'The LORD is my strength and my shield; my heart trusted in him, and I am helped.', ref: 'Psalm 28:7' },
  { text: 'I have fought a good fight, I have finished my course, I have kept the faith.', ref: '2 Timothy 4:7' },
  { text: 'Wherefore comfort yourselves together, and edify one another, even as also ye do.', ref: '1 Thessalonians 5:11' },
  { text: 'Let all your things be done with charity.', ref: '1 Corinthians 16:14' },
  { text: 'This is my commandment, That ye love one another, as I have loved you.', ref: 'John 15:12' },
  { text: 'Behold, how good and how pleasant it is for brethren to dwell together in unity!', ref: 'Psalm 133:1' },
  { text: 'Trust in the LORD with all thine heart; and lean not unto thine own understanding.', ref: 'Proverbs 3:5' },
  { text: 'The joy of the LORD is your strength.', ref: 'Nehemiah 8:10' },
  { text: 'Wait on the LORD: be of good courage, and he shall strengthen thine heart.', ref: 'Psalm 27:14' },
  { text: 'Let us not be weary in well doing: for in due season we shall reap, if we faint not.', ref: 'Galatians 6:9' },
  { text: 'Bear ye one another’s burdens, and so fulfil the law of Christ.', ref: 'Galatians 6:2' },
  { text: 'The LORD shall fight for you, and ye shall hold your peace.', ref: 'Exodus 14:14' },
  { text: 'Watch ye, stand fast in the faith, quit you like men, be strong.', ref: '1 Corinthians 16:13' },
  { text: 'For God hath not given us the spirit of fear; but of power, and of love, and of a sound mind.', ref: '2 Timothy 1:7' },
  { text: 'Commit thy works unto the LORD, and thy thoughts shall be established.', ref: 'Proverbs 16:3' },
  { text: 'A merry heart doeth good like a medicine.', ref: 'Proverbs 17:22' },
  { text: 'In all thy ways acknowledge him, and he shall direct thy paths.', ref: 'Proverbs 3:6' },
  { text: 'Whatsoever thy hand findeth to do, do it with thy might.', ref: 'Ecclesiastes 9:10' },
  { text: 'The steps of a good man are ordered by the LORD.', ref: 'Psalm 37:23' },
  { text: 'Finally, be ye all of one mind, having compassion one of another, love as brethren.', ref: '1 Peter 3:8' },
  { text: 'For where two or three are gathered together in my name, there am I in the midst of them.', ref: 'Matthew 18:20' },
  { text: 'Greater love hath no man than this, that a man lay down his life for his friends.', ref: 'John 15:13' },
  { text: 'Be strong in the Lord, and in the power of his might.', ref: 'Ephesians 6:10' },
  { text: 'He giveth power to the faint; and to them that have no might he increaseth strength.', ref: 'Isaiah 40:29' },
  { text: 'Cast thy burden upon the LORD, and he shall sustain thee.', ref: 'Psalm 55:22' },
  { text: 'And let us consider one another to provoke unto love and to good works.', ref: 'Hebrews 10:24' },
  { text: 'This is the day which the LORD hath made; we will rejoice and be glad in it.', ref: 'Psalm 118:24' },
  { text: 'Thy word is a lamp unto my feet, and a light unto my path.', ref: 'Psalm 119:105' },
  { text: 'Let brotherly love continue.', ref: 'Hebrews 13:1' },
  { text: 'The LORD is good, a strong hold in the day of trouble; and he knoweth them that trust in him.', ref: 'Nahum 1:7' },
  { text: 'Fear thou not; for I am with thee: be not dismayed; for I am thy God.', ref: 'Isaiah 41:10' },
];
function dailyVerse() {
  const d = new Date();
  const dayIndex = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  return KJV_VERSES[((dayIndex % KJV_VERSES.length) + KJV_VERSES.length) % KJV_VERSES.length];
}

// Runs hub — the launcher that lists every run the viewer can see (Basketball always;
// Pickleball for admins always, for members once it's published). Tapping a card opens
// that run's check-in page. `runs` = [{ key, emoji, name, href, runDate, dateLabel,
// timeLabel, going, cap, status:'open'|'closed'|'cancelled', hidden }]. Self-contained
// styles (scoped .rh*) so it needs no new global CSS.
export function runsPage({ email, runs = [], canJoin = true, status = 'approved', canOperate = false, isAdmin = false, needsWaiver = false, needsDob = false, firstName = 'there', pastRuns = [], dmUnread = 0, groupUnread = 0, groupMention = 0, chatProgram = 1, ann = null }) {
  // Non-approved viewers can SEE the runs but can't join — a tap routes them to apply
  // (or to their status) instead of into a check-in they're not cleared for.
  const applyHref = status === 'none' ? '/' : '/status';
  const DOW3 = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const MON3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  // Per-sport identity ball watermarks (inline SVG, stroke=currentColor=the rail colour).
  const BBALL = '<svg width="116" height="116" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 2v20"/><path d="M2 12h20"/><path d="M7.8 3c-3 3.6-3 14.4 0 18"/><path d="M16.2 3c3 3.6 3 14.4 0 18"/></svg>';
  const PADDLE = '<svg width="110" height="110" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><g transform="rotate(-45 12 12)"><rect x="8" y="2.6" width="8" height="11.4" rx="4"/><path d="M12 14v5.4"/></g><circle cx="5.4" cy="18.6" r="2.1"/></svg>';
  const VBALL = '<svg width="116" height="116" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M11.1 7.1a16.55 16.55 0 0 1 10.9 4"/><path d="M12 12a12.6 12.6 0 0 1-8.7 5"/><path d="M16.8 13.6a16.55 16.55 0 0 1-9 7.5"/><path d="M20.7 17a12.8 12.8 0 0 0-8.7-5 13.3 13.3 0 0 1 0-10"/><path d="M6.3 3.8a16.55 16.55 0 0 0 1.9 11.5"/></svg>';
  const LOCK_OPEN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 7.7-1.5"/></svg>';
  const LOCK_SHUT = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>';
  // key → [rail colour, ball, watermark rotation, left%, top%]. Unknown (e.g. demo) → neutral purple.
  const SPORT = { basketball: ['#e4611f', BBALL, '-10deg', '40%', '44%'], pickleball: ['#1f6f66', PADDLE, '13deg', '55%', '63%'], volleyball: ['#2f5d9e', VBALL, '5deg', '47%', '38%'] };
  const sportOf = (r) => SPORT[r.key] || ['#6d5bd0', BBALL, '-6deg', '45%', '45%'];
  // Viewer's own status → a small pill (takes priority over the generic hidden tag).
  const mineBadge = (r) => {
    const m = r.mine; if (!m) return '';
    if (m.state === 'in') return `<span class="jc-pill you">✓ You're in</span>`;
    if (m.state === 'offered') return `<span class="jc-pill claim">⏳ Claim your spot</span>`;
    if (m.state === 'waitlist') return `<span class="jc-pill wait">Waitlisted · #${m.pos} of ${m.total}</span>`;
    return '';
  };
  // Social proof: mutual-follows already checked in — up to 3 avatars + a name label.
  const frGoing = (r) => {
    const fr = r.friendsGoing || [];
    if (!fr.length) return '';
    const avs = fr.slice(0, 3).map(f => `<span class="mav jc-fav">${avatarInner(f.email, f.name)}</span>`).join('');
    const names = fr.map(f => esc((f.name || '').trim().split(/\s+/)[0] || 'Someone'));
    const label = names.length === 1 ? `${names[0]} is going`
      : names.length === 2 ? `${names[0]} & ${names[1]} going`
      : `${names[0]}, ${names[1]} +${names.length - 2} going`;
    return `<span class="jc-fr"><span class="jc-favs">${avs}</span><span class="jc-frtxt">${label}</span></span>`;
  };
  // Scoreboard card: sport-coloured date-rail (weekday/day/month + open|closed padlock) and a body
  // with a faint off-centre ball watermark, the run name, the count, the time, and the viewer's badge.
  // Open → vivid sport colour + unlocked; anything else (closed/cancelled/hidden) → greyed + locked.
  // A locked card still opens its run page (B) — it just reads as unavailable.
  const card = (r) => {
    const [color, ball, rot, wl, wt] = sportOf(r);
    const d = r.runDate ? new Date(r.runDate + 'T12:00:00') : null;
    const open = r.status === 'open' && !r.hidden;
    const badge = mineBadge(r) || (r.hidden ? `<span class="jc-pill hid">Hidden</span>` : (r.status === 'cancelled' ? `<span class="jc-pill hid">Cancelled</span>` : ''));
    return `<a class="jc ${open ? 'open' : 'locked'}" style="--sport:${open ? color : '#a29c8f'};--wl:${wl};--wt:${wt};--rot:${rot}" href="${canJoin ? r.href : applyHref}"${canJoin ? '' : ' data-full'}>
      <span class="jc-date">
        <span class="jc-dow">${d ? DOW3[d.getDay()] : '—'}</span><span class="jc-num">${d ? d.getDate() : ''}</span><span class="jc-mon">${d ? MON3[d.getMonth()] : ''}</span>
        <span class="jc-lock" aria-label="${open ? 'Check-in open' : 'Check-in closed'}">${open ? LOCK_OPEN : LOCK_SHUT}</span>
      </span>
      <span class="jc-body">
        <span class="jc-wm" aria-hidden="true">${ball}</span>
        <span class="jc-r1"><span class="jc-name">${esc(r.name)}</span>${canJoin && r.status !== 'cancelled' ? `<span class="jc-count"><b>${r.going}</b>/${r.cap}</span>` : ''}</span>
        <span class="jc-time">${r.status === 'cancelled' ? 'Cancelled this week' : (r.timeLabel ? esc(r.timeLabel) : '')}</span>
        ${badge ? `<span class="jc-pills">${badge}</span>` : ''}
        ${frGoing(r)}
      </span>
    </a>`;
  };
  const pastCard = (r) => {
    const [, ball] = sportOf(r);
    const d = r.runDate ? new Date(r.runDate + 'T12:00:00') : null;
    // Opens the read-only "who went" roster for that run — a past run is viewable, just done.
    return `<a class="jc locked" href="/runs/past/${r.programId}/${esc(r.runDate)}" style="--sport:#a29c8f;--wl:47%;--wt:45%;--rot:-6deg">
      <span class="jc-date"><span class="jc-dow">${d ? DOW3[d.getDay()] : '—'}</span><span class="jc-num">${d ? d.getDate() : ''}</span><span class="jc-mon">${d ? MON3[d.getMonth()] : ''}</span></span>
      <span class="jc-body"><span class="jc-wm" aria-hidden="true">${ball}</span>
        <span class="jc-r1"><span class="jc-name">${esc(r.name)}</span></span>
        <span class="jc-time">${d ? `${DOW3[d.getDay()]} · ${MON3[d.getMonth()]} ${d.getDate()}` : ''}</span>
        <span class="jc-pills"><span class="jc-pill you">Attended ✓</span></span>
      </span></a>`;
  };
  const applyBanner = canJoin ? '' : `<div class="notice" style="margin:12px 0 0">${status === 'pending'
      ? `⏳ <b>Application in review</b> — you’ll be able to check in here once the organizers approve you.`
      : status === 'rejected'
      ? `<b>Not on the Adv list this season.</b> The open Monday recreational run is always available.`
      : `👋 <b>Not a member yet?</b> Apply to join — fill out the form and you’ll get in once you’re approved. <a class="btn sm" href="/" data-full style="margin-left:6px;width:auto">Apply to join →</a>`}</div>`;
  const { btn: annBtn, sheet: annSheet } = annBell(ann);
  const nudge = needsDob ? `<div class="notice warn" style="margin:0 0 12px">📅 <b>Add your date of birth</b> — we use it for age-based safety rules. <a class="btn sm" href="/profile" style="margin-left:6px;width:auto">Add it →</a></div>` : '';
  const verse = (() => { const v = dailyVerse(); return `<div class="hubverse"><p class="hubverse-t">“${esc(v.text)}”</p><p class="hubverse-r">— ${esc(v.ref)} · KJV</p></div>`; })();
  return HEAD('Runs — The Bridge', 'has-tabs') + WELCOME_MODAL + `
    ${canJoin ? `<script>window.__tourRole={op:${canOperate ? 1 : 0},adm:${isAdmin ? 1 : 0},waiver:${needsWaiver ? 1 : 0}};</script>` : ''}
    <style>
      .jhead{position:relative;overflow:hidden;margin:2px 0 0;padding:2px 2px 2px}
      .jh-court{position:absolute;border:1.5px solid rgba(228,97,31,.13);border-radius:50%;pointer-events:none}
      .jh-court.c1{width:300px;height:300px;right:-120px;top:-150px}
      .jh-court.c2{width:180px;height:180px;right:-58px;top:-84px;border-color:rgba(34,35,29,.06)}
      .jh-court.c3{width:150px;height:150px;left:-92px;bottom:-34px;border-color:rgba(228,97,31,.09)}
      .jbrand{display:flex;align-items:center;gap:9px;position:relative;z-index:1}
      .jmark{width:34px;height:34px;border-radius:8px;object-fit:contain;flex:none}
      .jbn{display:flex;flex-direction:column;gap:2px}
      .jbn b{font-family:var(--head);font-weight:800;font-size:11px;letter-spacing:.2em;color:var(--ink)}
      .jbn em{font-family:var(--head);font-weight:800;font-style:normal;font-size:8px;letter-spacing:.3em;color:var(--orange)}
      .jbell{margin-left:auto;display:flex}
      .jgreet{margin-top:9px;position:relative;z-index:1}
      .je-eye{display:block;font-family:var(--head);font-weight:800;font-size:12px;letter-spacing:.32em;color:var(--orange);text-transform:uppercase}
      .jgreet h1{margin:4px 0 0;font-family:var(--head);font-weight:800;font-size:33px;line-height:.95;letter-spacing:-.5px;text-transform:uppercase;color:var(--ink)}
      .je-dot{color:var(--orange)}
      .jedge{height:3px;margin:8px 0 6px;background:var(--orange);border-radius:2px}
      .jseg{display:flex;gap:4px;margin:4px 0 9px;padding:4px;border-radius:12px;background:var(--card);border:1px solid var(--line)}
      .jseg-b{flex:1;padding:9px 0;border:0;border-radius:8px;background:transparent;cursor:pointer;font-family:var(--head);font-weight:800;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);-webkit-tap-highlight-color:transparent}
      .jseg-b.on{background:var(--ink);color:var(--bg,#f6f1e8);box-shadow:inset 0 -2px 0 0 var(--orange)}
      .jsec{display:flex;align-items:center;gap:8px;margin:2px 0 8px}
      .jsec-tick{width:8px;height:14px;background:var(--orange);transform:skewX(-14deg);border-radius:1px}
      .jsec h3{font-family:var(--head);font-weight:800;font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink);margin:0}
      .jsec-meta{margin-left:auto;font-family:var(--head);font-weight:800;font-size:9.5px;letter-spacing:.16em;color:var(--muted);text-transform:uppercase}
      .jops{display:flex;gap:8px;margin:0 0 8px}
      .jops a{font-family:var(--head);font-weight:800;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:6px 12px;background:var(--card)}
      .jlist{display:flex;flex-direction:column;gap:7px}
      .jlist[hidden]{display:none}
      .jc{--sport:var(--ink);position:relative;display:flex;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;text-decoration:none;color:inherit;box-shadow:0 1px 2px rgba(0,0,0,.04),0 10px 22px -16px rgba(34,35,29,.2);transition:transform .06s ease}
      .jc:active{transform:scale(.99)}
      .jc.locked{background:#f4f1ea}
      .jc-date{flex:none;width:58px;background-color:var(--sport);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:9px 0;background-image:repeating-linear-gradient(115deg,rgba(255,255,255,.05) 0 2px,transparent 2px 11px)}
      .jc.locked .jc-date{background-image:none}
      .jc-dow{font-family:var(--head);font-weight:800;font-size:10px;letter-spacing:.16em;color:rgba(255,255,255,.85)}
      .jc-num{font-family:var(--head);font-weight:800;font-size:26px;line-height:1;letter-spacing:-.5px;color:#fff}
      .jc-mon{font-family:var(--head);font-weight:800;font-size:8.5px;letter-spacing:.24em;color:rgba(255,255,255,.62)}
      .jc-lock{margin-top:8px;opacity:.95;display:flex}
      .jc-body{position:relative;flex:1;min-width:0;padding:9px 13px;display:flex;flex-direction:column;justify-content:center;gap:5px;overflow:hidden}
      .jc-wm{position:absolute;left:var(--wl,50%);top:var(--wt,50%);transform:translate(-50%,-50%) rotate(var(--rot,0deg));color:var(--sport);opacity:.09;pointer-events:none}
      .jc.locked .jc-wm{opacity:.07}
      .jc-wm svg{display:block}
      .jc-r1,.jc-time,.jc-pills,.jc-fr{position:relative;z-index:1}
      .jc-r1{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
      .jc-name{flex:1;font-family:var(--head);font-weight:800;font-size:17px;letter-spacing:.2px;text-transform:uppercase;color:var(--ink);min-width:0}
      .jc.locked .jc-name{color:#958f80}
      .jc-count{flex:none;font-family:var(--head);font-weight:800;font-size:18px;color:var(--muted)}
      .jc-count b{color:var(--sport);font-weight:800}
      /* Slate: the per-sport accents are tuned for light cards — lift the numerator's
         brightness so the count pops without losing the colour coding (owner report). */
      html.theme-midnight .jc-count b{filter:brightness(1.45)}
      .jc.locked .jc-count,.jc.locked .jc-count b{color:#b7b0a0}
      .jc-time{font-size:12.5px;font-weight:600;color:var(--muted)}
      .jc.locked .jc-time{color:#a49d8d}
      .jc-pills{display:flex;gap:6px;flex-wrap:wrap;margin-top:1px}
      .jc-pill{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:6px;font-family:var(--head);font-weight:800;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}
      .jc-pill.you{color:#fff;background:#1f6f66}
      .jc-pill.claim{color:#fff;background:var(--orange)}
      .jc-pill.wait{color:#8a6a1b;background:#f7eccf}
      .jc-pill.hid{color:#8a6a1b;background:#f0e6cf}
      .jc-fr{display:flex;align-items:center;gap:7px;margin-top:2px}
      .jc-favs{display:inline-flex}
      .jc-fav.mav{width:19px;height:19px;font-size:9px;border:1.5px solid var(--card);box-shadow:0 0 0 .5px var(--line)}
      .jc-favs .jc-fav:not(:first-child){margin-left:-6px}
      .jc-frtxt{color:var(--muted);font-size:11.5px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .jempty{color:var(--muted);text-align:center;font-size:14px;padding:20px 0}
      .hubverse{max-width:36ch;margin:8px auto 0;text-align:center;padding:0 14px}
      .hubverse-t{font-size:13.5px;line-height:1.5;color:var(--ink);font-style:italic;margin:0}
      .hubverse-r{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:6px 0 0;font-weight:700}
      @media (prefers-color-scheme:dark){
        .jc.locked{background:#26251f}
        .jc-pill.wait{background:#3a3016;color:#e7c766}
        .jc-pill.hid{background:#3a3016;color:#e7c766}
      }
    </style>
    <header class="jhead">
      <span class="jh-court c1"></span><span class="jh-court c2"></span><span class="jh-court c3"></span>
      <div class="jbrand"><img class="jmark" alt="The Bridge" src="/icon-192.png?v=2"><div class="jbn"><b>THE BRIDGE</b><em>YA SPORTS</em></div><span class="jbell">${annBtn}</span></div>
      <div class="jgreet"><span class="je-eye">Welcome,</span><h1>${esc(firstName)}<span class="je-dot">.</span></h1></div>
    </header>
    <div class="jedge" aria-hidden="true"></div>
    ${nudge}${applyBanner}
    ${canOperate ? `<div class="jops"><a href="/admin">⚙ Council</a>${isAdmin ? `<a href="/admin/people">People &amp; invites</a>` : ''}</div>` : ''}
    <div class="jseg"><button type="button" class="jseg-b on" data-jt="up">Upcoming</button><button type="button" class="jseg-b" data-jt="past">Past</button></div>
    <div class="jsec"><span class="jsec-tick"></span><h3>This Week</h3><span class="jsec-meta">${runs.length} run${runs.length === 1 ? '' : 's'}</span></div>
    <div class="jlist" data-jl="up">${runs.length ? runs.map(card).join('') : '<p class="jempty">No runs available yet.</p>'}</div>
    <div class="jlist" data-jl="past" hidden>${pastRuns.length ? pastRuns.map(pastCard).join('') : '<p class="jempty">No past games yet — your attended runs will show here.</p>'}</div>
    ${verse}
    ${annSheet}
    ${canJoin ? firstRunTour : ''}
    <script>(function(){if(window.__jtabBound)return;window.__jtabBound=1;document.addEventListener('click',function(e){var b=e.target&&e.target.closest&&e.target.closest('.jseg-b[data-jt]');if(!b)return;var sel=b.getAttribute('data-jt');var ts=document.querySelectorAll('.jseg-b[data-jt]');for(var i=0;i<ts.length;i++)ts[i].classList.toggle('on',ts[i]===b);var ls=document.querySelectorAll('.jlist[data-jl]');for(var j=0;j<ls.length;j++)ls[j].hidden=(ls[j].getAttribute('data-jl')!==sel);});})();</script>
    <script>(function(){if(window.__hubBfBound)return;window.__hubBfBound=1;window.addEventListener('pageshow',function(e){if(e.persisted)location.reload();});})();</script>
  ` + footWithTabs(tabNav('runs', { dm: dmUnread, group: groupUnread, groupMention, program: chatProgram }), { noFooter: true });
}

// Pickleball JOIN PROMPT — shown when an approved member who hasn't joined pickleball opens
// the run. Joining is opt-in (separate from basketball approval): tap Join → become a member →
// see the run + chat. The Chat tab reflects the runs they HAVE joined (or locks if none) — it
// never assumes basketball, since this viewer isn't a member of THIS run.
// Program-generic join prompt. Defaults reproduce PICKLEBALL exactly; pkJoinPage is a wrapper.
export function runJoinPage({ email, runDate = '', runLabel = '', dmUnread = 0, groupUnread = 0, groupMention = 0, chatProgram = 1, ann = null,
  runBase = '/pickleball', theme = 'pk', sport = 'Pickleball', sportEmoji = '🥒', joinMode = 'open', requested = false }) {
  // Admin-supplied program names: escape every interpolation (case-convert first — see runChatPage).
  const sportE = esc(sport), emojiE = esc(sportEmoji), low = esc(sport.toLowerCase()), up = esc(sport.toUpperCase());
  const nextRun = runLabel ? ` Next run: <b>${esc(wdayFull(runDate))}, ${esc(runLabel)}</b>.` : '';
  // Three prompts for three enforced join modes (F3): open = the historic Join button;
  // invite = honest explanation, no button; host = Request → "request sent" once pending.
  const joinBlock = joinMode === 'invite'
    ? `<h3 style="margin:4px 0 8px">${sportE} is invite only</h3>
       <p class="lead" style="margin:0 0 14px">The organizers add members themselves. Ask them to add you and this run will unlock for you automatically.${nextRun}</p>`
    : joinMode === 'host'
      ? (requested
        ? `<h3 style="margin:4px 0 8px">Request sent ✓</h3>
           <p class="lead" style="margin:0 0 14px">The organizers have your request — you'll get a notification the moment they approve it.${nextRun}</p>`
        : `<h3 style="margin:4px 0 8px">Want in on ${low}?</h3>
           <p class="lead" style="margin:0 0 14px">This run's organizers approve who joins. Send a request and you'll be notified when you're in.${nextRun}</p>
           <form method="POST" action="${runBase}/join-run" class="swapform"><button class="btn primary" type="submit">${emojiE} Request to join</button></form>`)
      : `<h3 style="margin:4px 0 8px">Want in on ${low}?</h3>
       <p class="lead" style="margin:0 0 14px">Join to check in each week and chat with the ${low} crew — it's its own run, with its own check-in and chat.${nextRun}</p>
      <form method="POST" action="${runBase}/join-run" class="swapform"><button class="btn primary" type="submit">${emojiE} Join ${low}</button></form>`;
  return HEAD(`Join ${sport} — The Bridge`, `has-tabs ${theme}`) + header(`<b>${up}</b>${esc(email)}`, '', ann, '') + `
    ${backToRuns}
    <div class="rule"></div>
    <div class="phead"><h1>${sportE} ${emojiE}</h1></div>
    <div class="card rail" style="margin-top:12px">
      <span class="eyebrow">Join the run</span>
      ${joinBlock}
    </div>
  ` + footWithTabs(tabNav('runs', { dm: dmUnread, group: groupUnread, groupMention, program: chatProgram }));
}
export function pkJoinPage(state) { return runJoinPage(state); }

// Past run — read-only "who went" roster (opened from the hub's Past tab). Looks like a run
// page but it's done: no actions, just the archived attendance list. Names link to profiles
// where an account exists; minors carry the red asterisk like every list.
export function pastRunPage({ name = '', emoji = '', runDate = '', rows = [], dmUnread = 0, groupUnread = 0, groupMention = 0, chatProgram = 1, ann = null }) {
  const d = runDate ? new Date(runDate + 'T12:00:00') : null;
  const when = d ? d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : '';
  const row = (p, i) => {
    const inner = `<span class="lav">${avatarInner(p.email, p.name)}</span><span class="lnm">${esc(p.name)}${p.minor ? MINOR_STAR : ''}</span>`;
    return `<div class="lr"><span class="ln">${i + 1}</span>${p.applicant_id ? `<a class="lrlink" href="/u/${p.applicant_id}">${inner}</a>` : inner}</div>`;
  };
  return HEAD(`${name} — past run`, 'has-tabs') + header(`<b>${esc(name.toUpperCase())}</b>Past run`, '', ann, '') + `
    ${backToRuns}
    <div class="rule"></div>
    <div class="phead"><h1>${esc(name)} ${emoji}</h1></div>
    <div class="card rail" style="margin-top:12px">
      <span class="eyebrow">Past run · ${esc(when)}</span>
      <h3 style="margin:4px 0 10px">Who went · ${rows.length}</h3>
      ${rows.length ? rows.map(row).join('') : '<p class="lead" style="margin:0">No attendance was recorded for this run.</p>'}
    </div>
  ` + footWithTabs(tabNav('runs', { dm: dmUnread, group: groupUnread, groupMention, program: chatProgram }));
}

// Season board — most runs this calendar year. Top 8 + the viewer's own row (if outside
// the top). Gentle by design: it celebrates the top and shows you yours, never ranks the
// bottom. Self-contained inline styles so it needs no new CSS.
export function seasonPage({ rows, email, dmUnread = 0, groupUnread = 0, groupMention = 0, ann = null, title = 'Season Board', subtitle = 'Most runs this calendar year 🏀', program = 1, theme = '', emptyMsg = 'No runs logged yet this season — get out there 🏀' }) {
  // Basketball (program 1) is the neutral hub run → it links back to Profile. Every opt-in run
  // (pickleball, volleyball, …) gets the Runs back-link + its own body theme instead. No per-
  // program branch — a new run just passes its theme.
  const optIn = program !== 1;
  const meRow = rows.find(r => r.me);
  const medal = (r) => r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : String(r);
  const rowHtml = (r) => `<div style="display:flex;align-items:center;gap:12px;padding:11px 14px;border:1px solid var(--line);border-radius:12px;margin-top:8px;background:${r.me ? 'var(--teal-tint,#e6efec)' : 'var(--card)'}">
      <span style="font-weight:800;font-size:17px;min-width:32px;text-align:center;font-variant-numeric:tabular-nums">${medal(r.rank)}</span>
      <span style="flex:1;font-weight:600">${esc(r.name)}${r.me ? ' · <b>you</b>' : ''}</span>
      <span style="font-weight:800;font-variant-numeric:tabular-nums">${r.n}<span style="font-weight:400;color:var(--muted)"> runs</span></span>
    </div>`;
  const list = rows.length
    ? rows.slice(0, 8).map(rowHtml).join('') + (meRow && meRow.rank > 8 ? `<div style="text-align:center;color:var(--muted);margin:6px 0 0">···</div>${rowHtml(meRow)}` : '')
    : `<div class="foot" style="margin-top:14px">${esc(emptyMsg)}</div>`;
  return HEAD(`${esc(title)} — The Bridge`, 'has-tabs' + (theme ? ' ' + theme : '')) + header(`<b>SEASON</b>${esc(email)}`, '', ann) + `
    ${optIn ? backToRuns : ''}
    <div class="rule"></div>
    <div class="phead"><h1>${esc(title)}</h1></div>
    <p class="psub" style="margin:-4px 0 6px;color:var(--muted)">${esc(subtitle)}</p>
    ${list}
    ${optIn ? '' : '<div class="foot" style="margin-top:18px"><a href="/profile">← Back to profile</a></div>'}
  ` + footWithTabs(tabNav('', { dm: dmUnread, group: groupUnread, groupMention, program }));
}
