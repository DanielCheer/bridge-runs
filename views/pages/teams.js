// views/pages/teams.js — the courtside teams board, the game-results strip and the leaderboard.
import { esc } from '../util.js';
import { tabNav, backToRuns } from '../components.js';
import { HEAD, header, footWithTabs } from '../shell.js';
import { LADDER_CSS, ladderTable, ladderCapNote } from './ladder.js';

// ---------- TEAMS BOARD — the operator's courtside surface ----------
// Design target: ONE TAP per change, thumb-sized, readable in a gym. Sides shift constantly, so
// anything requiring "select then place" is too slow. With two sides a tap needs no destination:
// tapping a player moves them to the other side. The small x benches them; a benched player taps
// back onto the shorter side.
// No swapform/fetch interception here on purpose — a full POST-redirect is more robust than an
// optimistic swap when the phone's wifi is patchy at the back of a gym.
const TEAMS_CSS = `
  .tmwrap{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}
  @media (max-width:520px){ .tmwrap{grid-template-columns:1fr 1fr;gap:8px} }
  .tmside{background:var(--card,#fff);border-radius:14px;padding:12px 10px 14px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
  .tmhead{display:flex;align-items:baseline;justify-content:space-between;margin:0 2px 8px}
  .tmhead h3{margin:0;font-size:15px;letter-spacing:.04em;text-transform:uppercase}
  .tmhead .n{font-size:26px;font-weight:800;line-height:1}
  .tmrow{display:flex;align-items:stretch;gap:6px;margin-bottom:7px}
  .tmname{flex:1;min-width:0;display:block;text-align:left;font-size:17px;font-weight:600;
    padding:13px 12px;border-radius:11px;border:1px solid rgba(34,35,29,.14);background:transparent;
    color:inherit;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tmname:active{transform:scale(.985)}
  .tmx{flex:0 0 42px;border-radius:11px;border:1px solid rgba(34,35,29,.12);background:transparent;
    color:var(--muted);font-size:17px;cursor:pointer}
  .tmempty{color:var(--muted);font-size:13px;padding:10px 2px}
  .tmbench{margin-top:14px}
  .tmbench .tmname{font-weight:500;opacity:.85}
  .tmbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
`;
export function teamsBoardPage({
  program = 1, theme = '', emoji = '', sport = '', email = '', runDate = '', dateLabel = '',
  sides = [], bench = [], basePath = '', canSync = false,
  games = false, tonight = [], fp = '', gameMinSide = 3,
  msg = '', err = '', dmUnread = 0, groupUnread = 0, groupMention = 0,
}) {
  // A player button posts only their address; the server decides where they land. Keeping the
  // destination server-side is what lets one tap mean "the other side" from either side, and
  // "the shorter side" from the bench, without the page having to know the counts.
  // `from` is the side the operator can SEE them on (blank = bench). The server refuses the move if
  // they have since been moved elsewhere, so a double-tap or a stale second phone can't silently
  // toggle a player back and forth.
  const chip = (p, from = '', benchable = true) => `
    <div class="tmrow">
      <form method="post" action="${esc(basePath)}/team/swap" style="flex:1;min-width:0;display:flex">
        <input type="hidden" name="email" value="${esc(p.email)}">
        <input type="hidden" name="from" value="${esc(String(from))}">
        <button class="tmname" type="submit" title="Move ${esc(p.name)} to the other side">${esc(p.name)}</button>
      </form>
      ${benchable ? `<form method="post" action="${esc(basePath)}/team/bench" style="display:flex">
        <input type="hidden" name="email" value="${esc(p.email)}">
        <button class="tmx" type="submit" title="Bench ${esc(p.name)}">&times;</button>
      </form>` : ''}
    </div>`;
  const side = (players, i) => `
    <div class="tmside">
      <div class="tmhead"><h3>Side ${i + 1}</h3><span class="n">${players.length}</span></div>
      ${players.length ? players.map(p => chip(p, i + 1)).join('') : '<p class="tmempty">Tap a name from the bench.</p>'}
    </div>`;
  const total = sides.reduce((n, x) => n + x.length, 0) + bench.length;
  return HEAD(`Teams — ${esc(sport)}`, 'has-tabs' + (theme ? ' ' + theme : ''))
    + header(`<b>TEAMS</b>${esc(email)}`, '', null) + `
    ${backToRuns}
    <div class="rule"></div>
    <style>${TEAMS_CSS}${games ? GAMES_CSS : ''}</style>
    <div class="phead"><h1>Teams ${esc(emoji)}</h1></div>
    <p class="psub" style="margin:-4px 0 10px;color:var(--muted)">${esc(dateLabel)} &middot; ${total} player${total === 1 ? '' : 's'} &middot; tap a name to move them across</p>
    ${msg ? `<div class="note ok">${esc(msg)}</div>` : ''}
    ${err ? `<div class="note warn">${esc(err)}</div>` : ''}
    ${games ? gamesStrip({ basePath, tonight, fp, minSide: gameMinSide, canLog: total > 0 && sides.every(x => x.length >= gameMinSide) }) : ''}
    ${total ? '' : `<div class="card"><b>Nobody on the floor yet.</b><p class="foot" style="margin:6px 0 0">${canSync
      ? 'Pull tonight&rsquo;s registered players from Planning Center below.'
      : 'Players appear here once they&rsquo;re on tonight&rsquo;s roster.'}</p></div>`}
    <div class="tmwrap">${sides.map(side).join('')}</div>
    <div class="tmbench">
      <div class="subhead">Bench &middot; ${bench.length}</div>
      <div class="card" style="padding:10px">
        ${bench.length ? bench.map(p => chip(p, '', false)).join('')
          : '<p class="tmempty" style="margin:0">Everyone&rsquo;s on a side.</p>'}
      </div>
    </div>
    <div class="tmbar">
      ${canSync ? `<form method="post" action="${esc(basePath)}/roster-sync"
        onsubmit="var b=this.querySelector('button');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Syncing…';">
        <button class="btn sm" style="width:auto" type="submit">&#8635; Sync tonight&rsquo;s roster</button></form>` : ''}
      ${total ? `<form method="post" action="${esc(basePath)}/teams/clear"
        onsubmit="return confirm('Clear both sides? Everyone goes back to the bench.');">
        <button class="btn ghost sm" style="width:auto" type="submit">Clear sides</button></form>` : ''}
    </div>
    <p class="foot" style="margin-top:14px">Tap a name to send them to the other side. Tap &times; to bench them. A benched player goes to whichever side is shorter.</p>
    ` + footWithTabs(tabNav('', { dm: dmUnread, group: groupUnread, groupMention, program }));
}
// ---------- GAME RESULTS — the strip that turns a board into a record ----------
// Sits ABOVE the sides on purpose: when a game ends the eye path is top-of-screen, tap, then
// re-mix below. Winner is one button. The score is a second, optional tap folded into a
// <details> so the zero-score path stays visually one tap — a required score is what stops
// anyone logging by week three, and an invented one is silently wrong data on a public board.
const GAMES_CSS = `
  .gmbar{padding:12px 14px;margin:0 0 12px}
  .gmwin{display:flex;flex-direction:column;gap:10px;margin:0}
  .gmbtn{width:100%;min-height:52px;font-size:17px;font-weight:650;cursor:pointer;
    border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--fg)}
  .gmbtn:hover{border-color:var(--accent)}
  .gmbtn[disabled]{opacity:.55}
  /* Two thumb-sized number pads side by side. Big text because this is filled in a gym, standing,
     by someone about to play the next game. */
  .gmscrow{display:flex;gap:10px;align-items:end}
  .gmscrow label{flex:1;font-size:12px;color:var(--muted);display:flex;flex-direction:column;gap:4px}
  .gmscrow input{width:100%;padding:12px;font-size:26px;font-weight:650;text-align:center;
    border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg)}
  .gmdash{padding-bottom:14px;color:var(--muted);font-size:20px}
  .gmton{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0 0 12px;font-size:13px;color:var(--muted)}
  .gmton form{margin:0}
  .gmton .lk{background:none;border:0;color:var(--accent);cursor:pointer;font:inherit;padding:0;text-decoration:underline}
  .gmlog{margin:0;font-size:12px;color:var(--muted)}
  .gmlog li{margin:3px 0}
`;
// One finished game, as a sentence. The roster is folded away because the only reason to open it
// is to check a snapshot looks right — which is exactly the check that catches a result logged
// AFTER the sides were re-mixed, the one failure this design cannot prevent outright.
const gameLine = (g) => `Side ${g.win} won${g.ws == null ? '' : ` ${g.ws}–${g.ls}`}`
  + ` &middot; ${g.counts[0]}v${g.counts[1]}`;

export function gamesStrip({ basePath = '', tonight = [], fp = '', canLog = true, minSide = 3 }) {
  const wins = [0, 0];
  for (const g of tonight) if (g.win >= 1 && g.win <= 2) wins[g.win - 1]++;
  const tally = tonight.length
    ? (wins[0] === wins[1] ? `Sides level ${wins[0]}–${wins[1]}`
      : `Side ${wins[0] > wins[1] ? 1 : 2} leads ${Math.max(...wins)}–${Math.min(...wins)}`)
    : '';
  const last = tonight[0];
  return (!canLog ? `
    <div class="card gmbar"><b>Not enough players on a side to log a game.</b>
      <p class="foot" style="margin:6px 0 0">Both sides need ${minSide} or more. Tonight&rsquo;s games below are
      unaffected, and Undo still works.</p></div>` : `
    <div class="card gmbar">
      <div class="subhead" style="margin:0 0 8px">Final score</div>
      <form method="post" action="${esc(basePath)}/game" class="gmwin"
        onsubmit="var b=this.querySelector('.gmbtn');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Saving…';">
        <input type="hidden" name="fp" value="${esc(fp)}">
        <div class="gmscrow">
          <label>Side 1<input name="s1" inputmode="numeric" pattern="[0-9]*" maxlength="2"
            autocomplete="off" required aria-label="Side 1 final score"></label>
          <span class="gmdash">&ndash;</span>
          <label>Side 2<input name="s2" inputmode="numeric" pattern="[0-9]*" maxlength="2"
            autocomplete="off" required aria-label="Side 2 final score"></label>
        </div>
        <button class="gmbtn" type="submit">Log this game</button>
      </form>
      <p class="foot" style="margin:8px 0 0">Whoever scored more wins it &mdash; no need to say which side.
        Move anyone who subbed in <b>before</b> you log.</p>
    </div>`)
    + (tonight.length ? `
    <div class="gmton">
      <span><b>Tonight:</b> ${tonight.length} game${tonight.length === 1 ? '' : 's'}${tally ? ' &middot; ' + tally : ''}</span>
      <span>&middot; last: ${gameLine(last)}</span>
      <form method="post" action="${esc(basePath)}/game/undo"
        onsubmit="return confirm('Remove the last game? It comes off the leaderboard too.');">
        <input type="hidden" name="id" value="${esc(String(last.id))}">
        <button class="lk" type="submit">Undo last</button></form>
      <details style="flex:1 1 100%">
        <summary style="cursor:pointer">Who was in tonight&rsquo;s games</summary>
        <ul class="gmlog" style="padding-left:18px;margin-top:6px">
          ${tonight.map(g => `<li>${gameLine(g)} &mdash; <b>won:</b> ${esc(g.sides[g.win - 1].join(', ') || '—')}
             &middot; <b>lost:</b> ${esc(g.sides[g.win === 1 ? 1 : 0].join(', ') || '—')}</li>`).join('')}
        </ul>
      </details>
    </div>` : '');
}
// The season board for a run whose games are logged from the teams board.
export function leaderboardPage({
  program = 1, theme = '', emoji = '', sport = '', email = '', basePath = '', canOperate = false,
  from = '', players = [], nights = 0, games = 0, recent = [], dateLabel = '',
  msg = '', err = '', dmUnread = 0, groupUnread = 0, groupMention = 0,
}) {
  const scored = players.some(p => p.scored > 0);
  // Point differential is shown ONLY for players who actually have a scored game. Passing null
  // renders a dash: a player nobody kept score for has NO differential, and printing "0" for them
  // would read as an even record rather than as an absence.
  const rows = players.map(p => ({ label: p.label, w: p.w, l: p.l, pd: p.scored ? p.pd : null }));
  // Standings already drop tombstones; belt-and-braces so a merge can never bury a live player's
  // record under a deleted person's address.
  const mergeOpts = players.filter(p => !/^former-[0-9a-f]+@/.test(p.email))
    .map(p => `<option value="${esc(p.email)}">${esc(p.label)} — ${esc(p.email)}</option>`).join('');
  return HEAD(`Leaderboard — ${esc(sport)}`, 'has-tabs' + (theme ? ' ' + theme : ''))
    + header(`<b>LEADERBOARD</b>${esc(email)}`, '', null) + `
    ${backToRuns}
    <div class="rule"></div>
    <style>${LADDER_CSS}${GAMES_CSS}</style>
    <div class="phead"><h1>Leaderboard ${esc(emoji)}</h1></div>
    <p class="psub" style="margin:-4px 0 10px;color:var(--muted)">
      ${games} game${games === 1 ? '' : 's'} across ${nights} night${nights === 1 ? '' : 's'} since ${esc(from)}
      &middot; most wins first, then point differential</p>
    ${msg ? `<div class="note ok">${esc(msg)}</div>` : ''}
    ${err ? `<div class="note warn">${esc(err)}</div>` : ''}
    ${players.length ? ladderTable(rows, 12, 'players') + ladderCapNote(rows, 12, 'players') : `
      <div class="card"><b>No games logged yet.</b>
        <p class="foot" style="margin:6px 0 0">Results come from the teams board &mdash; tap who won after a game
        and everyone on both sides gets credited.</p></div>`}
    ${recent.length ? `
      <div class="subhead" style="margin-top:18px">Tonight &middot; ${esc(dateLabel)}</div>
      <div class="card" style="padding:10px 14px">
        <ul class="gmlog" style="padding-left:18px;margin:0">
          ${recent.map(g => `<li>${gameLine(g)} &mdash; ${esc(g.sides[g.win - 1].join(', '))}</li>`).join('')}
        </ul>
      </div>` : ''}
    ${canOperate && players.length > 1 ? `
      <div class="subhead" style="margin-top:18px">Same person, two rows?</div>
      <div class="card">
        <p class="foot" style="margin:0 0 8px">A player who registered once without an email address and once with
          one shows up twice. Merging moves every game from the first onto the second. It refuses if
          they were ever on the same game, because then they are not the same person.</p>
        <form method="post" action="${esc(basePath)}/game/merge"
          onsubmit="return confirm('Merge these two players? This cannot be undone.');">
          <label class="lbl">Move this player<select name="from" required><option value="">Choose…</option>${mergeOpts}</select></label>
          <label class="lbl">onto this one<select name="into" required><option value="">Choose…</option>${mergeOpts}</select></label>
          <button class="btn sm" style="width:auto;margin-top:8px" type="submit">Merge</button>
        </form>
      </div>` : ''}
    <p class="foot" style="margin-top:14px">Every player on the winning side gets the win, and the margin goes to
      everyone who was on the floor for it. Sides are taken from the teams board at the moment the score is logged,
      so move anyone who subbed in <b>before</b> you log it.</p>
    ` + footWithTabs(tabNav('', { dm: dmUnread, group: groupUnread, groupMention, program }));
}
