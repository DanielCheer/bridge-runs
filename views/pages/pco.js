// views/pages/pco.js — the Planning Center admin console.
import { esc } from '../util.js';
import { backBtn } from '../components.js';
import { HEAD, FOOT, header } from '../shell.js';

// Deliberately a plain admin tool page (statusPage idiom, no tabs): status card → connect form →
// actions → match report. Everything user-derived goes through esc().
export function pcoAdminPage({ s = {}, msg = '' }) {
  const rep = s.report;
  const statusCard = s.connected
    ? `<div class="card rail" style="margin-top:12px">
        <div class="subhead" style="margin-top:0">Connected${s.authMode === 'oauth' ? ' — authorized by the church' : ' — via a token'}</div>
        <p style="margin:6px 0 0"><b>${esc(s.org || 'Planning Center')}</b> — People sync is live.
        ${s.linked} member${s.linked === 1 ? '' : 's'} linked · ${s.outboxPending} pending write${s.outboxPending === 1 ? '' : 's'}.</p>
        ${s.error === 'auth' ? `<p style="color:#b3261e;margin:8px 0 0"><b>⚠ Planning Center rejected the connection — sync is paused.</b> ${s.authMode === 'oauth' ? 'Press <b>Re-authorize</b> below (the church may have revoked access).' : 'Reconnect below with a fresh token.'}</p>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <form method="POST" action="/admin/pco/link" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Working…';"><button class="btn sm" type="submit">Match People now</button></form>
          <form method="POST" action="/admin/pco/poll" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Working…';"><button class="btn ghost sm" type="submit">Pull latest PCO edits</button></form>
          <form method="POST" action="/admin/pco/auto"><input type="hidden" name="on" value="${s.autocreate ? '0' : '1'}"><button class="btn ghost sm" type="submit">${s.autocreate ? '✓ Auto-add new members — turn off' : 'Auto-add new members — turn on'}</button></form>
          <form method="POST" action="/admin/pco/disconnect" onsubmit="return confirm('Disconnect Planning Center? Links are kept; syncing stops.')"><button class="btn ghost sm" type="submit">Disconnect</button></form>
        </div>
      </div>`
    : `<div class="card rail" style="margin-top:12px">
        <div class="subhead" style="margin-top:0">Not connected</div>
        <p style="margin:6px 0 0">Link the church's Planning Center account and this app keeps its <b>People</b> directory in sync automatically: members are matched by email (nobody re-registers), new approved members are written back, and profile edits flow both ways. Attendance stays in this app — Planning Center doesn't accept attendance from any outside system.</p>
      </div>`;
  const oauthCard = `
    <div class="subhead">Connect — recommended${s.authMode === 'oauth' ? ' (in use)' : ''}</div>
    <div class="card rail">
      <p class="tally-note" style="margin:0 0 10px"><b>The church authorizes this app from Planning Center's own screen.</b> No password or secret is ever sent to us, the permission belongs to the <b>organization</b> (so it keeps working when staff change), and it can be revoked any time from Planning Center's connected-applications list. Access is limited to: <b>${esc(s.scopes || '')}</b>.</p>
      <p class="tally-note" style="margin:0 0 10px">One-time setup by a Planning Center <b>Organization Administrator</b>: create an API application, and paste this exact redirect URI into it —</p>
      <p style="margin:0 0 10px;word-break:break-all"><code>${esc(s.redirectUri || '')}</code></p>
      <form method="POST" action="/admin/pco/oauth/app" style="margin:0 0 10px">
        <label>Application (client) ID<input name="client_id" autocomplete="off" value="${esc(s.oauthClientId)}"></label>
        <label>Application secret<input name="client_secret" type="password" autocomplete="off" placeholder="${s.oauthConfigured ? '•••••••• (saved)' : ''}"></label>
        <button class="btn ghost sm" type="submit" style="margin-top:8px">Save application</button>
      </form>
      ${s.oauthConfigured
        ? `<a class="btn" href="/admin/pco/oauth/start" style="margin:0">${s.authMode === 'oauth' ? 'Re-authorize' : 'Connect Planning Center'}</a>`
        : `<p class="tally-note" style="margin:0">Save the application above to enable the connect button.</p>`}
      ${s.authMode === 'oauth' && s.tokenExpires ? `<p class="tally-note" style="margin:10px 0 0">Connected. Access renews automatically (current token valid until ${esc(new Date(s.tokenExpires).toISOString().slice(0, 16).replace('T', ' '))} UTC).</p>` : ''}
      <div class="subhead" style="margin-top:14px">Instant updates (optional)</div>
      <p class="tally-note" style="margin:0 0 8px">Planning Center can notify this app the moment someone's details change there. Paste the webhook's signing secret from Planning Center and inbound changes arrive instantly instead of on the daily sync.</p>
      <form method="POST" action="/admin/pco/webhook" class="editrow" style="margin:0">
        <label style="flex:1">Webhook signing secret<input name="webhook_secret" autocomplete="off" placeholder="${s.webhookSet ? '•••••••• (saved — paste to replace, blank to clear)' : ''}"></label>
        <button class="btn ghost sm" type="submit">Save</button>
      </form>
    </div>`;
  const connectForm = `
    <div class="subhead">Connect with a token — quick alternative${s.authMode === 'pat' ? ' (in use)' : ''}</div>
    <form method="POST" action="/admin/pco/connect" class="card rail">
      <p class="tally-note" style="margin:0 0 10px">Faster to set up, and fine for a pilot: a PCO admin creates a <b>Personal Access Token</b> (api.planningcenteronline.com → Personal Access Tokens) and sends both halves. The trade-off is that it's a shared secret tied to <b>that person's account</b>, so it can stop working if they leave. Stored in the app's database (never in code), and included in the app's database backups — so treat those backups as sensitive.</p>
      <label>Application ID<input name="app_id" autocomplete="off" placeholder="pco_app_…"></label>
      <label>Secret<input name="secret" type="password" autocomplete="off" placeholder="••••••••"></label>
      <label>Webhook authenticity secret <span style="text-transform:none;font-weight:400;color:var(--muted)">(optional — only if webhooks are set up in PCO)</span><input name="webhook_secret" autocomplete="off"></label>
      <label class="lvl" style="margin-top:8px"><input type="checkbox" name="autocreate" value="1" checked> Automatically add new approved members to People</label>
      <button class="btn" type="submit" style="margin-top:10px">Connect &amp; test</button>
    </form>`;
  const reportCard = rep ? `
    <div class="subhead">Last match report <span style="text-transform:none;font-weight:400;color:var(--muted)">(${esc(String(rep.at || '').slice(0, 16).replace('T', ' '))})</span></div>
    <div class="card rail">
      <p style="margin:0"><b>${rep.matched}</b> matched by email · <b>${(rep.bridgeOnly || []).length}</b> only in this app · <b>${rep.pcoOnly}</b> only in People (they just haven't joined a run — nothing is imported).</p>
      ${(rep.bridgeOnly || []).length ? `
        <p class="tally-note" style="margin:10px 0 6px">Members not yet in the church directory:</p>
        <p style="margin:0;word-break:break-all">${rep.bridgeOnly.slice(0, 30).map(esc).join(' · ')}${rep.bridgeOnly.length > 30 ? ` · +${rep.bridgeOnly.length - 30} more` : ''}</p>
        <form method="POST" action="/admin/pco/create" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Working…';" style="margin-top:10px"><button class="btn sm" type="submit">Add ${rep.bridgeOnly.length} to People</button></form>` : ''}
      ${(rep.dupes || []).length ? `<p class="tally-note" style="margin:10px 0 0">⚠ Duplicate emails inside People (linked the first, review in PCO): ${rep.dupes.slice(0, 10).map(esc).join(', ')}</p>` : ''}
    </div>` : '';
  // ---- Phase 2b cards: door mode, Check-Ins reconciliation, door passes ----
  const doorCard = `
    <div class="subhead">Run-night mode</div>
    <div class="card rail">
      <p style="margin:0">${s.doorMode
        ? '<b>🚪 Door mode is ON.</b> The church’s Check-Ins station is the confirmation — the in-app “✓ I’m coming” step is hidden and unconfirmed spots are never swept.'
        : '<b>📲 In-app confirm is ON.</b> Floor players confirm in the app by the cutoff or their spot is released. Turn on door mode when the PCO Check-Ins station runs the door — one tap there replaces the in-app step.'}</p>
      <form method="POST" action="/admin/pco/doormode" style="margin-top:10px"><input type="hidden" name="on" value="${s.doorMode ? '0' : '1'}"><button class="btn ${s.doorMode ? 'ghost ' : ''}sm" type="submit">${s.doorMode ? 'Switch back to in-app confirm' : 'Turn on door mode'}</button></form>
      <p style="margin:14px 0 0">${s.kioskArrivals
        ? '<b>📺 Kiosk arrivals are ON.</b> On the run day, kiosk screens mark each person <b>IN</b> as the station taps them and count walk-ins — refreshed from Check-Ins about every 30 seconds while a screen is watching.'
        : '<b>📺 Kiosk arrivals are OFF.</b> Kiosk screens show the roster only. Turn this on and the door screen also marks who has physically tapped in at the station tonight — no extra device needed at the door.'}${s.eventId ? '' : ' <b>Needs the Check-Ins event ID below first.</b>'}</p>
      <form method="POST" action="/admin/pco/kioskarrivals" style="margin-top:10px"><input type="hidden" name="on" value="${s.kioskArrivals ? '0' : '1'}"><button class="btn ${s.kioskArrivals ? 'ghost ' : ''}sm" type="submit">${s.kioskArrivals ? 'Stop showing arrivals' : 'Show arrivals on kiosk screens'}</button></form>
    </div>`;
  const anyFields = s.waiverFields || s.attendanceFields;
  const attCard = s.connected ? `
    <div class="subhead">What we write onto People profiles</div>
    <div class="card rail">
      <p class="tally-note" style="margin:0 0 12px">Real custom fields (not notes), so your staff can filter Lists, trigger Workflows and pull reports inside Planning Center. Fields are created automatically the first time, then kept current.</p>

      <p style="margin:0 0 6px"><b>Waiver status</b> — ${(s.waiverFieldNames || []).map(n => `<b>${esc(n)}</b>`).join(' · ')}</p>
      <p class="tally-note" style="margin:0 0 8px">Who is cleared to play, and the date. Written as <b>Yes (verified)</b>, <b>Yes (self-reported)</b> or <b>No</b> — so a List of “No” is your follow-up queue and “self-reported” shows who hasn't been matched to a real waiver record yet. Useful no matter who runs the door.</p>
      <form method="POST" action="/admin/pco/waiver" style="margin:0 0 14px"><input type="hidden" name="on" value="${s.waiverFields ? '0' : '1'}"><button class="btn ${s.waiverFields ? 'ghost ' : ''}sm" type="submit">${s.waiverFields ? '✓ On — turn off' : 'Turn on waiver fields'}</button></form>

      <p style="margin:0 0 6px"><b>Attendance scoreboard</b> — ${(s.attFieldNames || []).map(n => `<b>${esc(n)}</b>`).join(' · ')}</p>
      <p class="tally-note" style="margin:0 0 8px">Games played per person. Worth publishing while this app is your attendance record — if you run Check-Ins at the door, Planning Center already holds attendance natively and this set is redundant, so leave it off.</p>
      <form method="POST" action="/admin/pco/attendance" style="margin:0"><input type="hidden" name="on" value="${s.attendanceFields ? '0' : '1'}"><button class="btn ${s.attendanceFields ? 'ghost ' : ''}sm" type="submit">${s.attendanceFields ? '✓ On — turn off' : 'Turn on attendance fields'}</button></form>

      ${anyFields ? `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px">
        <form method="POST" action="/admin/pco/attendance/push" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Working…';" style="margin:0"><button class="btn sm" type="submit">Update People now${s.attendancePending ? ` (${s.attendancePending})` : ''}</button></form>
      </div>
      ${s.attendanceLast ? `<p class="tally-note" style="margin:10px 0 0">Last written ${esc(String(s.attendanceLast).slice(0, 16).replace('T', ' '))}${s.attendancePending ? ` · ${s.attendancePending} profile${s.attendancePending === 1 ? '' : 's'} queued (they update automatically)` : ' · everyone up to date'}.</p>` : ''}` : ''}
      <p class="tally-note" style="margin:12px 0 0">Per-run history (who was on the floor which night, waitlist and offer history) always stays in this app — Planning Center accepts attendance from no outside system.</p>
    </div>` : '';
  const wc = s.waiverCounts || {}, wr = s.waiverReport;
  const waiverVerifyCard = s.connected ? `
    <div class="subhead">Waiver verification</div>
    <div class="card rail">
      <p class="tally-note" style="margin:0 0 10px">Right now this app records what members <b>tell</b> us — they tick “I've signed the waiver.” If your waiver is a <b>Planning Center form</b>, we can read its submissions and confirm it against your own records, so “signed” stops being a claim. Read-only: nothing is written back to your form.</p>
      <p style="margin:0 0 10px">Approved members: <b>${wc.verified || 0}</b> verified · <b>${wc.selfReported || 0}</b> self-reported · <b>${wc.none || 0}</b> no waiver.</p>
      <form method="POST" action="/admin/pco/waiver/form" class="editrow" style="margin:0 0 8px">
        <label style="flex:1">Waiver form ID<input name="form_id" value="${esc(s.waiverForm)}" inputmode="numeric" placeholder="the number in the form's URL"></label>
        <button class="btn ghost sm" type="submit">Save</button>
      </form>
      ${s.waiverForm ? `<form method="POST" action="/admin/pco/waiver/verify" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Working…';" style="margin:0"><button class="btn sm" type="submit">Verify waivers against the form</button></form>` : ''}
      ${wr ? `<p class="tally-note" style="margin:10px 0 0">Last check ${esc(String(wr.at).slice(0, 16).replace('T', ' '))}: matched <b>${wr.verified}</b> · ${wr.missing.length} member${wr.missing.length === 1 ? '' : 's'} with no submission${wr.unmatched ? ` · ${wr.unmatched} submission${wr.unmatched === 1 ? '' : 's'} not linked to a person` : ''}.${wr.missing.length ? ` Not found: ${wr.missing.slice(0, 12).map(esc).join(', ')}${wr.missing.length > 12 ? '…' : ''}` : ''}</p>` : ''}
      <p class="tally-note" style="margin:10px 0 0">If the waiver lives somewhere else (a Google Form, paper), verification stays manual — tell me where it lives and I'll wire that source in the same way.</p>
    </div>` : '';
  const cr = s.checkinsReport;
  const checkinsCard = s.connected ? `
    <div class="subhead">Check-Ins at the door</div>
    <div class="card rail">
      <p class="tally-note" style="margin:0 0 10px">After a run, pull the station's taps back and reconcile them against the roster — no-shows flagged, walk-ins surfaced. Reading Check-Ins is open to us; writing is walled for everyone.</p>
      <form method="POST" action="/admin/pco/event" class="editrow" style="margin:0 0 8px">
        <label style="flex:1">Check-Ins event ID<input name="event_id" value="${esc(s.eventId)}" inputmode="numeric" placeholder="the number in the event's URL"></label>
        <button class="btn ghost sm" type="submit">Save</button>
      </form>
      ${s.eventId ? `<form method="POST" action="/admin/pco/reconcile" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Working…';" class="editrow" style="margin:0">
        <label style="flex:1">Run date<input name="date" type="date"></label>
        <button class="btn sm" type="submit">Reconcile</button>
      </form>` : ''}
      ${cr ? `<div class="notice" style="margin:10px 0 0"><b>${esc(cr.date)}</b> — ${cr.ok} ✓ tapped &amp; signed up${cr.noShows.length ? ` · <b>${cr.noShows.length} no-show${cr.noShows.length === 1 ? '' : 's'}:</b> ${cr.noShows.slice(0, 12).map(esc).join(', ')}${cr.noShows.length > 12 ? '…' : ''}` : ' · no no-shows'}${cr.walkIns.length ? ` · <b>${cr.walkIns.length} walk-in${cr.walkIns.length === 1 ? '' : 's'}:</b> ${cr.walkIns.slice(0, 12).map(esc).join(', ')}${cr.walkIns.length > 12 ? '…' : ''}` : ' · no walk-ins'}</div>` : ''}
    </div>` : '';
  const pr = s.passReport;
  const passesCard = s.connected ? `
    <div class="subhead">Door passes (profile QR)</div>
    <div class="card rail">
      <p class="tally-note" style="margin:0 0 10px">Each member's profile can carry a QR the station scans — no name typing at the door. Flow: export the barcode CSV → import it in People (Barcode column) → Verify passes. QRs only appear once verified. ${s.passHolders} member${s.passHolders === 1 ? ' has' : 's have'} a working pass.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <form method="POST" action="/admin/pco/passes" style="margin:0"><input type="hidden" name="on" value="${s.passEnabled ? '0' : '1'}"><button class="btn ghost sm" type="submit">${s.passEnabled ? '✓ Profile QRs shown — hide' : 'Show profile QRs'}</button></form>
        <a class="btn ghost sm" href="/admin/pco/barcodes.csv" style="margin:0" download>⬇︎ Barcode CSV for People import</a>
        <form method="POST" action="/admin/pco/passes/verify" onsubmit="var b=this.querySelector('button[type=submit]');if(b.dataset.s)return false;b.dataset.s=1;b.disabled=true;b.textContent='Working…';" style="margin:0"><button class="btn sm" type="submit">Verify passes</button></form>
      </div>
      ${pr && pr.missing.length ? `<p class="tally-note" style="margin:10px 0 0">Still without a pass (${pr.missing.length}): ${pr.missing.slice(0, 15).map(esc).join(', ')}${pr.missing.length > 15 ? '…' : ''}</p>` : ''}
    </div>` : '';
  return HEAD('Planning Center — The Bridge', '', { wall: false }) + header('<b>PLANNING CENTER</b>') + `
    ${backBtn('/admin/people')}
    <div class="rule"></div>
    ${msg ? `<div class="notice">${esc(msg)}</div>` : ''}
    <span class="eyebrow">People sync</span>
    <h1 style="margin-bottom:0">Planning Center</h1>
    ${statusCard}
    ${doorCard}
    ${oauthCard}
    ${connectForm}
    ${reportCard}
    ${attCard}
    ${waiverVerifyCard}
    ${checkinsCard}
    ${passesCard}
    <div class="foot" style="margin-top:24px"><a href="/admin/people">‹ Back to People &amp; invites</a></div>
  ` + FOOT;
}
