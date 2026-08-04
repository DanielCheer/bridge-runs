// pco.js — Planning Center People ⇄ Bridge identity sync (Phase 1).
// PCO People stays the church's system of record for identity: Bridge links members by email
// (applicants.pco_id), writes new approved members back, PATCHes profile edits through a
// replayable outbox, and takes PCO-side edits back in via webhook + delta poll (PCO wins for
// identity fields). Check-Ins/Groups attendance are NOT writable by anyone (platform wall) —
// nothing here pretends otherwise. Spec: docs/PCO-SYNC-PHASE1-SPEC.md.
//
// Inert by design until an admin stores credentials on /admin/pco. All network work happens on
// the 60s tick / daily poll / explicit admin actions — never inline with a member request, so a
// PCO outage can't slow or block anything a player does.
import crypto from 'node:crypto';
import db, { transact } from './db.js';

// Test seam: the pco-fn suite points this at a local mock. Unset in prod → the real API.
const API_BASE = process.env.PCO_API_BASE || 'https://api.planningcenteronline.com';
// Retry backoff unit (attempt N waits N×base). Env-tunable so the test suite isn't waiting
// real minutes; prod default 60s keeps retries well inside PCO's 100-req/20s budget.
const RETRY_BASE_MS = Number(process.env.PCO_RETRY_BASE_MS || 60000);
// Minimum gap between API calls (PCO: 100 req / 20 s). 0 disables pacing — the test harness sets
// that so a 96-assert suite doesn't take minutes.
const PACE_MS = process.env.PCO_PACE_MS == null ? 250 : Number(process.env.PCO_PACE_MS);
let lastCallAt = 0;
const MAX_ATTEMPTS = 5;      // then fail-loud: close the row + audit (never silent)
const LINK_GRACE_ATTEMPTS = 60;   // ~1h of ticks for the reconcile scan to link before a patch dead-letters
const SCAN_BATCH = 10;       // unlinked members processed per tick — polite pacing, self-healing
// Synthetic identities that must NEVER reach the church directory.
const SYNTHETIC = "email NOT LIKE '%@guest.local' AND email NOT LIKE '%@demo.local'";

// Hoisted statements (node:sqlite has no statement cache).
const stmtGetSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const stmtSetSetting = db.prepare('INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)');
const stmtDelSetting = db.prepare('DELETE FROM app_settings WHERE key = ?');
const stmtAudit = db.prepare('INSERT INTO audit_log (actor,actor_role,action,target) VALUES (?,?,?,?)');
const stmtByEmail = db.prepare('SELECT * FROM applicants WHERE email = ?');
const stmtByPcoId = db.prepare('SELECT * FROM applicants WHERE pco_id = ?');
const stmtLink = db.prepare('UPDATE applicants SET pco_id = ? WHERE email = ?');
const stmtUnlinked = db.prepare(
  `SELECT email, full_name, phone, dob FROM applicants
   WHERE status='approved' AND pco_id IS NULL AND ${SYNTHETIC} ORDER BY id LIMIT ?`);
const stmtOutboxAdd = db.prepare('INSERT INTO pco_outbox (kind,email,payload) VALUES (?,?,?)');
const stmtOutboxDue = db.prepare(
  'SELECT * FROM pco_outbox WHERE done_at IS NULL AND next_at <= ? ORDER BY id LIMIT 10');
const stmtOutboxOk = db.prepare("UPDATE pco_outbox SET done_at = datetime('now') WHERE id = ?");
const stmtOutboxRetry = db.prepare(
  'UPDATE pco_outbox SET attempts = attempts + 1, last_error = ?, next_at = ? WHERE id = ?');
const stmtOutboxDead = db.prepare(
  "UPDATE pco_outbox SET attempts = attempts + 1, last_error = ?, done_at = datetime('now') WHERE id = ?");
const stmtOutboxPending = db.prepare('SELECT COUNT(*) n FROM pco_outbox WHERE done_at IS NULL');
const stmtInbound = db.prepare('UPDATE applicants SET full_name = ?, phone = ?, dob = ? WHERE email = ?');

const getSetting = (k) => stmtGetSetting.get(k)?.value;
const setSetting = (k, v) => stmtSetSetting.run(k, String(v));
const delSetting = (k) => stmtDelSetting.run(k);
const audit = (action, target) => stmtAudit.run('planning-center', 'system', action, target || '');

// ---------- connection state ----------
// Two ways in, same capabilities (see docs/PCO-SYNC-PHASE1-SPEC.md):
//   PAT   — an app id + secret a PCO admin generates and hands over. One minute to set up; acts as
//           that person, so it can die with their account.
//   OAUTH — the church authorizes this app from Planning Center's own screen. No secret is ever
//           sent to us, the grant belongs to the ORGANIZATION (it survives the person who clicked),
//           and they can revoke it from their connected-apps list. Access tokens last 2h and are
//           refreshed automatically; refresh tokens rotate on every use and are honoured 90 days.
// OAuth wins whenever it's configured; the PAT remains for a fast pilot.
export function pcoAuthMode() {
  if (getSetting('pco_oauth_access') && getSetting('pco_oauth_refresh')) return 'oauth';
  if (getSetting('pco_app_id') && getSetting('pco_secret')) return 'pat';
  return null;
}
export function pcoConnected() { return pcoAuthMode() !== null; }
const OAUTH_AUTHORIZE = () => `${API_BASE}/oauth/authorize`;
const OAUTH_TOKEN = () => `${API_BASE}/oauth/token`;
export const PCO_SCOPES = 'people check_ins';   // check_ins = READ-only reconciliation (see Phase 2b)

class PcoAuthError extends Error {}        // the stored credential is dead → pause, ask to reconnect
class PcoRateError extends Error {}        // 429 → a global backoff window is armed
class PcoPermissionError extends Error {}  // 403: the credential is FINE but lacks this product/record
class PcoTransientError extends Error {}   // 5xx / network: their side or the wire — retry later
// Anything here must NOT consume an outbox row's retry attempts or a sweep's per-person skip
// list: the row/person is fine, the CONDITION is global (dead credential, rate limit, outage,
// or a product-wide permission gap — a 403 on Check-Ins fails for every member identically, so
// skipping people one by one would just convert it into a silently empty report).
const isRetryable = (e) => e instanceof PcoAuthError || e instanceof PcoRateError
  || e instanceof PcoTransientError || e instanceof PcoPermissionError
  || e instanceof TypeError;   // fetch throws TypeError on network failure

// Mark the connection unusable until an admin reconnects. Audited once per transition, never per
// tick, so a broken connection is loud in the log exactly once.
// The notifier is injected by server.js (push/email live there) — pco.js must not import the app.
let notifyAdmins = null;
export function pcoSetNotifier(fn) { notifyAdmins = typeof fn === 'function' ? fn : null; }
function flagAuthError(where) {
  if (getSetting('pco_error') !== 'auth') {
    setSetting('pco_error', 'auth');
    audit('pco:auth-failed — sync paused, reconnect on /admin/pco', where);
    // A paused sync also stops the daily keep-alive, and the refresh window is finite — so this
    // cannot wait to be noticed on an admin screen. Tell the admins the moment it happens.
    if (notifyAdmins) {
      try {
        notifyAdmins('Planning Center sync paused',
          'The connection was rejected. Open the Planning Center screen to reconnect — attendance and waiver info stop syncing until then.');
      } catch (e) { console.error(`[pco] admin notify failed: ${e.message}`); }
    }
  }
}

// Exchange or refresh an OAuth token. `body` carries the grant. Stores the rotated refresh token —
// PCO issues a NEW one on every refresh, so keeping the old one would break the next refresh.
async function oauthTokenRequest(body, where) {
  const res = await fetch(OAUTH_TOKEN(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: getSetting('pco_oauth_client_id'),
      client_secret: getSetting('pco_oauth_client_secret'),
      ...body,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    if (res.status === 429) {   // the token endpoint counts against the same budget
      const wait = (Number(res.headers.get('retry-after')) || 20) * 1000;
      setSetting('pco_backoff_until', String(Date.now() + wait));
      throw new PcoRateError(`PCO token endpoint rate-limited, backing off ${wait}ms`);
    }
    // A failed REFRESH means the stored grant is genuinely dead → pause and ask for a reconnect.
    // A failed authorization_code exchange is a FLOW error (expired code, redirect mismatch) and
    // must NOT condemn a working connection — e.g. a church already running on a PAT that tries
    // the OAuth upgrade and mistimes the consent screen.
    if (body.grant_type === 'refresh_token' && (res.status === 400 || res.status === 401)) flagAuthError(where);
    throw new PcoAuthError(`PCO token request failed (${res.status}) ${detail}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new PcoAuthError('PCO token response had no access_token');
  // One transaction: a crash between these writes would leave a new access token beside a dead
  // rotated-away refresh token, which only a re-authorization could fix.
  transact(() => {
    setSetting('pco_oauth_access', json.access_token);
    if (json.refresh_token) setSetting('pco_oauth_refresh', json.refresh_token);
    setSetting('pco_oauth_expires', String(Date.now() + (Number(json.expires_in) || 7200) * 1000));
  });
  return json;
}
// SINGLE-FLIGHT refresh. The 60s tick, the daily poll, the weekly rollover push and any admin
// button share one token row, and PCO ROTATES the refresh token on every use — so two concurrent
// refreshes mean the loser presents an already-consumed token. That 400s, flags the connection as
// dead, and (if PCO invalidates the token family on reuse) really does kill the grant. Everyone
// awaits the SAME request instead, so a rotation can never race itself.
let refreshInFlight = null;
// Sweep mutex: the 60s tick, the weekly rollover, and every admin button can run multi-request
// sweeps (field push, initial link, create-bridge-only). Two overlapping first-enable pushes both
// see an empty pco_field_ids cache and both CREATE definitions → the church's People account grows
// duplicate "YA Sports — …" fields. All sweeps queue through one chain instead.
let sweepChain = Promise.resolve();
function withSweepLock(fn) {
  const run = sweepChain.then(fn, fn);
  sweepChain = run.catch(() => {});   // the chain itself never rejects; callers still see the error
  return run;
}
function refreshAccessToken(where) {
  if (!refreshInFlight) {
    refreshInFlight = oauthTokenRequest(
      { grant_type: 'refresh_token', refresh_token: getSetting('pco_oauth_refresh') }, where)
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}
// Refresh a little BEFORE expiry so a long sync can't die mid-run on a boundary.
async function ensureFreshToken() {
  if (pcoAuthMode() !== 'oauth') return;
  const expires = Number(getSetting('pco_oauth_expires') || 0);
  if (expires - Date.now() > 60000) return;
  await refreshAccessToken('refresh');
}
// `force` pins the style: 'pat' makes "Connect & test" actually test the PAT it was given, instead
// of silently validating an existing OAuth grant and storing an untested (possibly wrong) token.
function authHeader(force) {
  const mode = force || pcoAuthMode();
  return mode === 'oauth'
    ? `Bearer ${getSetting('pco_oauth_access')}`
    : 'Basic ' + Buffer.from(`${getSetting('pco_app_id')}:${getSetting('pco_secret')}`).toString('base64');
}

// One fetch wrapper owns ALL error semantics: 401 flips the connection into a visible
// "reconnect" state (banner on /admin/pco + audit, once); 429 arms a global backoff honouring
// Retry-After; other non-2xx throw with status+body so callers can retry or fail-loud.
async function pcoFetch(path, { method = 'GET', body, auth, _retried = false } = {}) {
  // Honour a 429 penalty on EVERY path, not just the 60s tick: an admin re-pressing a button that
  // just got rate-limited would otherwise hammer PCO straight through the penalty window.
  const until = Number(getSetting('pco_backoff_until') || 0);
  if (until > Date.now())
    throw new PcoRateError(`Planning Center asked us to wait ${Math.ceil((until - Date.now()) / 1000)}s — try again shortly.`);
  // Pace every call. PCO allows 100 requests / 20s; the per-member loops (verify passes, field
  // pushes) would sail past that and 429 mid-run, leaving half-written reports. 250ms ≈ 4/s keeps a
  // wide margin. PCO_PACE_MS=0 in the harness so tests don't crawl.
  if (PACE_MS > 0) {
    const wait = lastCallAt + PACE_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCallAt = Date.now();
  }
  if (auth !== 'pat') await ensureFreshToken();   // no-op for a PAT; refreshes an OAuth token near expiry
  const res = await fetch(API_BASE + path, {
    method,
    headers: { Authorization: authHeader(auth), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // An OAuth access token can be rejected before its recorded expiry (revoked, or clock skew).
    // Try exactly ONE refresh-and-retry before declaring the connection broken; a PAT has nothing
    // to refresh, so it fails immediately.
    if (!_retried && auth !== 'pat' && pcoAuthMode() === 'oauth') {
      try {
        await refreshAccessToken(path);
        return pcoFetch(path, { method, body, auth, _retried: true });
      } catch { /* fall through to the hard failure below */ }
    }
    flagAuthError(path);
    throw new PcoAuthError(`PCO auth failed (401)`);
  }
  if (res.status === 403) {
    // NOT a dead credential. 403 means this token lacks permission for this product or record —
    // e.g. the church has no Check-Ins licence, or the authorizing admin can't see that data.
    // Pausing the whole People sync here would blame the church for a feature-level gap and stop
    // the keep-alive with it.
    throw new PcoPermissionError(
      `Planning Center denied access to ${path} (403) — the connection doesn't have permission for that part of Planning Center.`);
  }
  if (res.status === 429) {
    const wait = (Number(res.headers.get('retry-after')) || 20) * 1000;
    setSetting('pco_backoff_until', String(Date.now() + wait));
    throw new PcoRateError(`PCO rate-limited, backing off ${wait}ms`);
  }
  if (res.status >= 500) throw new PcoTransientError(`PCO ${method} ${path} → ${res.status} (their side; will retry)`);
  if (!res.ok) throw new Error(`PCO ${method} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  if (res.status === 204) return null;
  const clear = getSetting('pco_error'); if (clear) delSetting('pco_error'); // healthy again
  return res.json();
}

// ---------- JSON:API helpers ----------
// Collect a person's email addresses (lowercased) from an `included` sideload.
function emailsOf(person, includedById) {
  const refs = person.relationships?.emails?.data || [];
  return refs.map(r => includedById.get(`Email/${r.id}`)?.attributes?.address)
    .filter(Boolean).map(e => e.toLowerCase());
}
function indexIncluded(json) {
  const m = new Map();
  for (const inc of json.included || []) m.set(`${inc.type}/${inc.id}`, inc);
  return m;
}
// Page through a People collection URL, invoking cb(person, includedById) per person.
async function eachPerson(startPath, cb) {
  let path = startPath;
  while (path) {
    const json = await pcoFetch(path);
    const inc = indexIncluded(json);
    for (const p of json.data || []) await cb(p, inc);
    // links.next is absolute; strip the origin so pcoFetch can re-prefix (mock + prod both fine)
    const next = json.links?.next;
    path = next ? next.replace(/^https?:\/\/[^/]+/, '') : null;
  }
}
const splitName = (full) => {
  const s = String(full || '').trim(), i = s.lastIndexOf(' ');
  return i < 0 ? { first: s, last: '' } : { first: s.slice(0, i), last: s.slice(i + 1) };
};
const joinName = (a) => [a.first_name, a.last_name].filter(Boolean).join(' ').trim();

// ---------- outbound: match / create / patch ----------
// Find the PCO person for one email (exact address match after a name-or-email search).
async function matchOne(email) {
  // Paginate the whole search: name_or_email ranks fuzzy NAME hits too, so with >1 page of
  // "Grace …" people the exact grace@… email match can sit on page 2 — a first-page-only read
  // declared the member unmatched, and autocreate would then mint a DUPLICATE person.
  const hits = [];
  await eachPerson(
    `/people/v2/people?where[search_name_or_email]=${encodeURIComponent(email)}&include=emails&per_page=100`,
    (p, inc) => { if (emailsOf(p, inc).includes(email.toLowerCase())) hits.push(p.id); });
  if (hits.length > 1) audit('pco:duplicate-emails-in-pco — linked first, review the rest', email);
  return hits[0] || null;
}

// Create a Person (+ email, + phone) in PCO for a Bridge applicant. Match-before-create is the
// caller's job (createFor / reconcile both do it) so this stays a pure create.
async function createInPco(a) {
  const { first, last } = splitName(a.full_name);
  const person = await pcoFetch('/people/v2/people', {
    method: 'POST',
    body: { data: { type: 'Person', attributes: { first_name: first, last_name: last, ...(a.dob ? { birthdate: a.dob } : {}) } } },
  });
  const id = person.data.id;
  await pcoFetch(`/people/v2/people/${id}/emails`, {
    method: 'POST', body: { data: { type: 'Email', attributes: { address: a.email, primary: true } } },
  });
  if (a.phone) await pcoFetch(`/people/v2/people/${id}/phone_numbers`, {
    method: 'POST', body: { data: { type: 'PhoneNumber', attributes: { number: a.phone, primary: true } } },
  });
  return id;
}

// Link-or-create for one applicant email. Returns 'linked' | 'created' | null (not found + create off).
async function ensurePerson(email, mayCreate) {
  const a = stmtByEmail.get(email);
  if (!a || a.pco_id) return null;
  const found = await matchOne(a.email);
  if (found) { stmtLink.run(found, a.email); audit('pco:linked', a.email); return 'linked'; }
  if (!mayCreate) return null;
  const id = await createInPco(a);
  stmtLink.run(id, a.email);
  audit('pco:created-person', a.email);
  return 'created';
}

// Queue a profile edit for PCO. Called from the profile/admin-edit routes; a no-op when not
// connected (nothing to sync to) — the reconcile scan will pick the person up post-connect anyway.
export function pcoQueuePatch(email, { full_name, phone } = {}) {
  if (!pcoConnected()) return;
  const a = stmtByEmail.get(email);
  if (!a || /@(guest|demo)\.local$/.test(email)) return;
  // Only approved members belong in the church directory — the reconcile scan links only
  // status='approved', so a patch for a pending/rejected applicant could never find a pco_id and
  // would sit in the drain queue forever, head-of-line-blocking real members' edits.
  if (a.status !== 'approved') return;
  stmtOutboxAdd.run('patch', email, JSON.stringify({ full_name, phone }));
}

async function drainOutbox() {
  for (const row of stmtOutboxDue.all(Date.now())) {
    try {
      const a = stmtByEmail.get(row.email);
      if (!a) { stmtOutboxDead.run('applicant gone (deleted before sync)', row.id); continue; }
      if (!a.pco_id) {
        // Not linked yet — the reconcile scan owns linking; requeue this patch behind it, but only
        // for a bounded grace window. A member who never links (autocreate off, absent from PCO)
        // must eventually dead-letter, or their eternal rows occupy the drain's LIMIT-10 slots and
        // freeze every later member's real edits behind them.
        if (row.attempts + 1 >= LINK_GRACE_ATTEMPTS) {
          stmtOutboxDead.run('never linked to a PCO person (autocreate off or not in People)', row.id);
          audit('pco:outbox-dead — member never linked; edit will sync on next change after linking', row.email);
        } else {
          stmtOutboxRetry.run('awaiting pco_id link', Date.now() + RETRY_BASE_MS, row.id);
        }
        continue;
      }
      const p = JSON.parse(row.payload || '{}');
      if (p.full_name) {
        const { first, last } = splitName(p.full_name);
        await pcoFetch(`/people/v2/people/${a.pco_id}`, {
          method: 'PATCH', body: { data: { type: 'Person', id: String(a.pco_id), attributes: { first_name: first, last_name: last } } },
        });
      }
      if (p.phone) {
        // PATCH the primary phone if one exists, else POST a new one.
        const cur = await pcoFetch(`/people/v2/people/${a.pco_id}/phone_numbers`);
        const prim = (cur.data || []).find(n => n.attributes?.primary) || (cur.data || [])[0];
        if (prim) await pcoFetch(`/people/v2/people/${a.pco_id}/phone_numbers/${prim.id}`, {
          method: 'PATCH', body: { data: { type: 'PhoneNumber', id: String(prim.id), attributes: { number: p.phone } } },
        });
        else await pcoFetch(`/people/v2/people/${a.pco_id}/phone_numbers`, {
          method: 'POST', body: { data: { type: 'PhoneNumber', attributes: { number: p.phone, primary: true } } },
        });
      }
      stmtOutboxOk.run(row.id);
    } catch (e) {
      // Global/transient conditions must not consume this row's attempts: a 15-minute PCO outage or
      // an ISP blip would otherwise dead-letter a member's queued profile edit permanently. Only a
      // failure that is genuinely about THIS row (a 4xx on its own payload) burns an attempt.
      if (isRetryable(e)) throw e;
      if (row.attempts + 1 >= MAX_ATTEMPTS) {
        stmtOutboxDead.run(e.message, row.id);
        audit(`pco:outbox-dead after ${MAX_ATTEMPTS} attempts — ${e.message.slice(0, 120)}`, row.email);
      } else {
        stmtOutboxRetry.run(e.message, Date.now() + RETRY_BASE_MS * (row.attempts + 1), row.id);
      }
    }
  }
}

// Self-healing outbound: any approved member without a pco_id gets matched (and, if the admin
// enabled auto-create, created) a few per tick. No per-route hooks to forget — approval,
// invite-claim, and un-suspend all converge here because they all end in status='approved'.
async function reconcileScan() {
  const mayCreate = getSetting('pco_autocreate') === '1';
  for (const a of stmtUnlinked.all(SCAN_BATCH)) await ensurePerson(a.email, mayCreate);
}

// ---------- inbound: PCO wins for identity fields ----------
// Apply a PCO person's attributes to the linked applicant. Only linked people (by pco_id) are
// touched — Bridge never mass-imports the congregation. Empty PCO values never clobber.
function applyInbound(pcoId, attrs, emails) {
  const a = stmtByPcoId.get(String(pcoId));
  if (!a) return false;
  const name = joinName(attrs) || a.full_name;
  const dob = attrs.birthdate || a.dob;
  const changed = name !== a.full_name || (dob || null) !== (a.dob || null);
  if (changed) {
    stmtInbound.run(name, a.phone, dob, a.email);
    audit('pco:inbound-update', a.email);
  }
  return changed;
}

// Nightly (and admin "Sync now") delta poll — webhook fallback, and the pilot-mode inbound path
// before webhooks are registered. Uses PCO's updated_at filter from the last high-water mark.
export async function pcoDaily() {
  if (!pcoConnected() || getSetting('pco_error') === 'auth') return;
  const since = getSetting('pco_since') || new Date(0).toISOString();
  const mark = new Date().toISOString();
  await eachPerson(
    `/people/v2/people?where[updated_at][gte]=${encodeURIComponent(since)}&include=emails&per_page=100`,
    (p, inc) => { applyInbound(p.id, p.attributes || {}, emailsOf(p, inc)); });
  setSetting('pco_since', mark);
}

// Webhook receiver (person.created/updated/destroyed). Raw-body HMAC-SHA256 check against the
// stored authenticity secret — reject anything unsigned. destroyed = mark + audit, NEVER delete.
export function pcoHandleWebhook(rawBody, signature) {
  const secret = getSetting('pco_webhook_secret');
  if (!secret) return { ok: false, code: 503 };
  const expect = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // Compare as BUFFERS with byte lengths: a header containing a high-byte char has a JS string
  // length that differs from its UTF-8 byte length, and timingSafeEqual THROWS on unequal buffers
  // — turning a forged header into a 500 instead of a clean 401.
  const gotBuf = Buffer.from(String(signature || ''), 'utf8');
  const expectBuf = Buffer.from(expect, 'utf8');
  if (gotBuf.length !== expectBuf.length || !crypto.timingSafeEqual(gotBuf, expectBuf)) return { ok: false, code: 401 };
  let deliveries;
  try { deliveries = JSON.parse(rawBody.toString('utf8')).data || []; }
  catch { return { ok: false, code: 400 }; }
  for (const d of deliveries) {
    const name = d.attributes?.name || '';
    let payload = d.attributes?.payload;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { continue; } }
    const person = payload?.data;
    if (!person?.id) continue;
    if (name.endsWith('person.destroyed')) {
      const a = stmtByPcoId.get(String(person.id));
      if (a) audit('pco:person-destroyed-in-pco — Bridge account kept, review', a.email);
    } else {
      applyInbound(person.id, person.attributes || {}, []);
    }
  }
  return { ok: true, code: 200 };
}

// ---------- the tick (wired into server.js's 60s interval + test tick) ----------
export async function pcoTick() {
  if (!pcoConnected() || getSetting('pco_error') === 'auth') return;
  if (Number(getSetting('pco_backoff_until') || 0) > Date.now()) return;
  try {
    await drainOutbox();
    await reconcileScan();
    // Slow drain: any custom-field backlog self-heals across ticks. This is also what makes a
    // waiver confirmation reach PCO within a minute — no hook on the waiver route needed, because
    // the signature diff notices the change on its own.
    await pcoPushFields(5);
  } catch (e) {
    if (!(e instanceof PcoAuthError) && !(e instanceof PcoRateError))
      console.error('[pco] tick failed:', e.message);
  }
}

// ---------- admin actions ----------
export async function pcoConnect(appId, secret, autocreate, webhookSecret) {
  setSetting('pco_app_id', appId.trim());
  setSetting('pco_secret', secret.trim());
  setSetting('pco_autocreate', autocreate ? '1' : '0');
  if (webhookSecret) setSetting('pco_webhook_secret', webhookSecret);
  delSetting('pco_error'); delSetting('pco_backoff_until');
  try {
    // auth:'pat' — test the credential we were JUST given, not an OAuth grant that may also exist.
    const root = await pcoFetch('/people/v2?per_page=1', { auth: 'pat' });   // cheapest authenticated call; names the org
    const org = root?.data?.attributes?.name || root?.meta?.parent?.name || 'Connected';
    applyOrgIdentity(root, org);   // same cross-org invalidation as the OAuth path — a PAT for a
                                   // DIFFERENT org must not inherit cached field ids / sync marks
    if (!getSetting('pco_since')) setSetting('pco_since', new Date().toISOString());
    audit('pco:connected', org);
    return { ok: true, org };
  } catch (e) {
    delSetting('pco_app_id'); delSetting('pco_secret'); delSetting('pco_org'); delSetting('pco_error');
    return { ok: false, error: e.message };
  }
}
// Record which ORGANIZATION this connection belongs to, and invalidate everything keyed to a
// previous one when it changes: cached custom-field definition ids, the delta-poll high-water
// mark, form/event ids, reports, and the per-person push signatures. Pushing with a foreign org's
// field ids would write garbage into a stranger's records. Shared by BOTH connect paths (PAT and
// OAuth) — the invalidation living in only one of them was exactly the kind of asymmetry that rots.
function applyOrgIdentity(root, orgName) {
  const orgId = root?.data?.id ? String(root.data.id) : '';
  const priorOrg = getSetting('pco_org_id') || '';
  if (orgId && priorOrg && orgId !== priorOrg) {
    for (const k of ['pco_field_ids', 'pco_since', 'pco_waiver_form', 'pco_checkins_event',
                     'pco_report', 'pco_waiver_report', 'pco_pass_report', 'pco_checkins_report']) delSetting(k);
    db.prepare('UPDATE applicants SET pco_att_sig = NULL WHERE pco_att_sig IS NOT NULL').run();
    audit('pco:org-changed — cached field ids, sync marks and reports cleared; existing person links kept for review', `${priorOrg}→${orgId}`);
  }
  if (orgId) setSetting('pco_org_id', orgId);
  setSetting('pco_org', orgName);
}

export function pcoDisconnect() {
  for (const k of ['pco_app_id', 'pco_secret', 'pco_org', 'pco_error', 'pco_backoff_until',
                   'pco_report', 'pco_autocreate', 'pco_webhook_secret',
                   'pco_oauth_access', 'pco_oauth_refresh', 'pco_oauth_expires', 'pco_oauth_state'])
    delSetting(k);
  audit('pco:disconnected', '');   // the registered app's client id/secret are KEPT — reconnecting
}                                  // is then one click, and they identify this app, not the church

// ---------- OAuth: register the app once, then the church authorizes it ----------
// The client id/secret identify THIS APP (created once by an Organization Administrator at
// api.planningcenteronline.com — PCO restricted app creation to org admins in March 2023). They are
// not the church's credentials, and no secret travels to us during an authorization.
export function pcoSaveOAuthApp(clientId, clientSecret) {
  if (clientId) setSetting('pco_oauth_client_id', String(clientId).trim());
  if (clientSecret) setSetting('pco_oauth_client_secret', String(clientSecret).trim());
  if (!clientId && !clientSecret) {
    delSetting('pco_oauth_client_id'); delSetting('pco_oauth_client_secret');
  }
}
export function pcoOAuthConfigured() {
  return !!(getSetting('pco_oauth_client_id') && getSetting('pco_oauth_client_secret'));
}
// Build the URL the admin is sent to. `state` is single-use with a short TTL — it's what stops a
// forged callback from planting someone else's authorization in this app.
export function pcoOAuthStartUrl(redirectUri) {
  const state = crypto.randomBytes(16).toString('base64url');
  // PKCE (S256) — recommended by PCO for confidential clients. The client_secret already makes a
  // stolen code unusable, so this is defence in depth: it also binds the code to THIS start request.
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  // Keep the two most recent pending starts. A second "Connect" (impatient click, or a slow consent
  // screen) used to overwrite the first, which then stranded a legitimate callback with a mismatch.
  let pending = [];
  try { pending = JSON.parse(getSetting('pco_oauth_state') || '[]'); } catch {}
  if (!Array.isArray(pending)) pending = [];
  pending = [{ state, at: Date.now(), redirectUri, verifier }, ...pending].slice(0, 2);
  setSetting('pco_oauth_state', JSON.stringify(pending));
  const q = new URLSearchParams({
    client_id: getSetting('pco_oauth_client_id'), redirect_uri: redirectUri,
    response_type: 'code', scope: PCO_SCOPES, state,
    code_challenge: challenge, code_challenge_method: 'S256',
  });
  return `${OAUTH_AUTHORIZE()}?${q.toString()}`;
}
export async function pcoOAuthCallback(code, state) {
  let pending = [];
  try { pending = JSON.parse(getSetting('pco_oauth_state') || '[]'); } catch {}
  if (!Array.isArray(pending)) pending = [];
  const saved = state ? pending.find(p => p && p.state === state) : null;
  // Consume ONLY the matching start; a sibling start stays valid so the other tab can still finish.
  const rest = pending.filter(p => p !== saved && p && Date.now() - p.at < 10 * 60 * 1000);
  if (rest.length) setSetting('pco_oauth_state', JSON.stringify(rest)); else delSetting('pco_oauth_state');
  if (!saved) return { ok: false, error: 'That authorization link expired or didn’t match — start again.' };
  if (Date.now() - saved.at > 10 * 60 * 1000) return { ok: false, error: 'That authorization took too long — start again.' };
  if (!code) return { ok: false, error: 'Planning Center didn’t return an authorization code.' };
  const hadFallback = !!(getSetting('pco_app_id') && getSetting('pco_secret'));
  try {
    await oauthTokenRequest({
      grant_type: 'authorization_code', code, redirect_uri: saved.redirectUri,
      ...(saved.verifier ? { code_verifier: saved.verifier } : {}),
    }, 'authorize');
    delSetting('pco_error'); delSetting('pco_backoff_until');
    const root = await pcoFetch('/people/v2?per_page=1');
    const org = root?.data?.attributes?.name || 'Connected';
    applyOrgIdentity(root, org);
    if (!getSetting('pco_since')) setSetting('pco_since', new Date().toISOString());
    audit('pco:connected-oauth', org);
    return { ok: true, org };
  } catch (e) {
    for (const k of ['pco_oauth_access', 'pco_oauth_refresh', 'pco_oauth_expires']) delSetting(k);
    // A failed OAuth attempt must not leave a working PAT connection paused. (oauthTokenRequest no
    // longer flags on this grant, but a later step — e.g. the org lookup — still can.)
    if (hadFallback && getSetting('pco_error') === 'auth') delSetting('pco_error');
    return { ok: false, error: e.message.slice(0, 160) };
  }
}
export function pcoSetAutocreate(on) { setSetting('pco_autocreate', on ? '1' : '0'); }

// Initial link: pull the WHOLE People list once, match every approved member by email, and store
// a report {matched, bridgeOnly[], pcoOnly, dupes[]} for the admin screen. Idempotent — re-running
// refreshes the report and links anyone new.
export function pcoRunInitialLink() { return withSweepLock(runInitialLinkInner); }
async function runInitialLinkInner() {
  const byEmail = new Map();   // email → pco person id (first wins; dupes flagged)
  const dupes = [];
  let pcoCount = 0;
  await eachPerson('/people/v2/people?include=emails&per_page=100', (p, inc) => {
    pcoCount++;
    for (const e of emailsOf(p, inc)) {
      if (byEmail.has(e)) { if (!dupes.includes(e)) dupes.push(e); }
      else byEmail.set(e, p.id);
    }
  });
  let matched = 0; const bridgeOnly = [];
  const members = db.prepare(
    `SELECT email, pco_id FROM applicants WHERE status='approved' AND ${SYNTHETIC}`).all();
  for (const m of members) {
    const hit = byEmail.get(m.email.toLowerCase());
    if (hit) { if (!m.pco_id) { stmtLink.run(hit, m.email); audit('pco:linked', m.email); } matched++; }
    else if (!m.pco_id) bridgeOnly.push(m.email);
    else matched++;   // already linked from a previous run — still a match
  }
  const report = {
    at: new Date().toISOString(), matched, bridgeOnly,
    pcoOnly: Math.max(0, pcoCount - matched), dupes,
  };
  setSetting('pco_report', JSON.stringify(report));
  audit(`pco:initial-link matched=${matched} bridge-only=${bridgeOnly.length} pco-only=${report.pcoOnly}`, '');
  return report;
}

// "Create the Bridge-only members in PCO" button — walks the stored report list with
// match-before-create (someone may have been added in PCO since the report was built).
export function pcoCreateBridgeOnly() { return withSweepLock(createBridgeOnlyInner); }
async function createBridgeOnlyInner() {
  const report = JSON.parse(getSetting('pco_report') || '{}');
  let created = 0, linked = 0;
  for (const email of report.bridgeOnly || []) {
    const r = await ensurePerson(email, true);
    if (r === 'created') created++; else if (r === 'linked') linked++;
  }
  report.bridgeOnly = (report.bridgeOnly || []).filter(e => !stmtByEmail.get(e)?.pco_id);
  report.matched = (report.matched || 0) + created + linked;
  setSetting('pco_report', JSON.stringify(report));
  audit(`pco:create-bridge-only created=${created} linked=${linked}`, '');
  return { created, linked };
}

// ---------- Phase 2: Bridge facts → People custom fields ----------
// The church's own reporting surface inside Planning Center: real custom fields (not free-text
// notes), so staff can filter Lists, fire Workflows and pull reports. Custom fields hold a CURRENT
// VALUE — a scoreboard, not a per-date ledger — which is exactly right for the two things worth
// publishing. Both sets are independently toggleable:
//
//   WAIVER (pco_waiver_fields) — "is this member cleared to play, and since when". The per-person
//   fact the church actually needs in its own system: a List of "waiver on file = No" is a
//   follow-up queue, and it stays useful no matter who runs the door.
//
//   ATTENDANCE (pco_attendance_fields) — the games-played scoreboard. Worth publishing only while
//   Bridge is the attendance system of record. In the Check-Ins hybrid the station's taps ARE the
//   attendance record inside PCO natively, so this set becomes redundant bookkeeping — leave it
//   off there and let the waiver fields have the space.
const WAIVER_FIELDS = [
  { key: 'waiver', name: 'YA Sports — waiver on file', type: 'string' },   // 'Yes' / 'No' — filterable in Lists
  { key: 'waiverDate', name: 'YA Sports — waiver confirmed', type: 'date' },
];
const ATT_FIELDS = [
  { key: 'games', name: 'YA Sports — games attended', type: 'number' },
  { key: 'last', name: 'YA Sports — last attended', type: 'date' },
  { key: 'sports', name: 'YA Sports — sports played', type: 'string' },
];
// Which field sets the church has switched on (order fixed so cached ids stay stable).
function enabledFieldDefs() {
  return [
    ...(getSetting('pco_waiver_fields') === '1' ? WAIVER_FIELDS : []),
    ...(getSetting('pco_attendance_fields') === '1' ? ATT_FIELDS : []),
  ];
}
const stmtAttRows = db.prepare(
  'SELECT program_id, COUNT(*) n, MAX(run_date) last FROM attendance WHERE email = ? GROUP BY program_id');
// pco_att_sig holds the signature of the LAST PUSHED field values (all sets, not just attendance —
// the column predates the waiver set and is reused rather than migrated).
const stmtAttCandidates = db.prepare(
  `SELECT email, pco_id, pco_att_sig, waiver_ok, waiver_at, waiver_verified_at FROM applicants
   WHERE pco_id IS NOT NULL AND ${SYNTHETIC} ORDER BY id`);
const stmtSetAttSig = db.prepare('UPDATE applicants SET pco_att_sig = ? WHERE email = ?');

// Program id → the label the church sees in PCO. Injected from server.js's registry at boot so
// this module never imports the program layer (and a new sport needs no edit here).
let PROGRAM_LABELS = { 1: 'Basketball', 2: 'Pickleball', 3: 'Volleyball' };
export function pcoSetProgramLabels(map) { if (map && Object.keys(map).length) PROGRAM_LABELS = map; }

// One person's publishable facts + the signature that decides whether a push is needed at all.
// Only ENABLED sets contribute, so turning a set off stops rewriting those values (the last
// values stay in PCO — the church's data, not ours to blank) and turning one on pushes everyone.
function profileFieldsFor(row) {
  const values = {}; const sig = [];
  if (getSetting('pco_waiver_fields') === '1') {
    // Three distinct states, because "verified against the church's own waiver records" and "the
    // member told us they signed" are not the same claim and a church record shouldn't blur them.
    values.waiver = !row.waiver_ok ? 'No'
      : row.waiver_verified_at ? 'Yes (verified)' : 'Yes (self-reported)';
    // Only a REAL recorded date is published — a legacy member cleared before dates were kept
    // publishes the Yes without inventing a date. The SIGNING date wins when known (that's what
    // "waiver confirmed" means to a reader); the verification date is the fallback.
    const d = row.waiver_at || row.waiver_verified_at;
    values.waiverDate = row.waiver_ok && d ? String(d).slice(0, 10) : '';
    sig.push(`w:${values.waiver}:${values.waiverDate}`);
  }
  if (getSetting('pco_attendance_fields') === '1') {
    const rows = stmtAttRows.all(row.email).filter(r => Number(r.program_id) !== 90);   // demo never counts
    const games = rows.reduce((n, r) => n + r.n, 0);
    const last = rows.reduce((m, r) => (r.last > m ? r.last : m), '');
    const sports = rows.filter(r => r.n > 0).map(r => PROGRAM_LABELS[r.program_id] || `Program ${r.program_id}`).sort().join(', ');
    Object.assign(values, { games: String(games), last, sports });
    sig.push(`a:${games}|${last}|${sports}`);
  }
  return { values, sig: sig.join('||') };
}

// Ensure the three field definitions exist in the church's People account; cache their ids.
// PCO allows creating definitions via the API, so setup is automatic — but if a data_type is
// rejected we retry as plain text rather than leaving the church with a half-built sync.
async function ensureFieldDefs(defs) {
  const cached = JSON.parse(getSetting('pco_field_ids') || '{}');
  if (defs.every(f => cached[f.key])) return cached;
  const existing = new Map();
  await (async () => {
    let path = '/people/v2/field_definitions?per_page=100';
    while (path) {
      const json = await pcoFetch(path);
      for (const d of json.data || []) {
        if (!d.attributes?.deleted_at) existing.set(String(d.attributes?.name || '').trim(), d.id);
      }
      const next = json.links?.next;
      path = next ? next.replace(/^https?:\/\/[^/]+/, '') : null;
    }
  })();
  const ids = { ...cached };
  for (const f of defs) {
    if (ids[f.key]) continue;
    const hit = existing.get(f.name);
    if (hit) { ids[f.key] = hit; continue; }
    const create = (type) => pcoFetch('/people/v2/field_definitions', {
      method: 'POST',
      body: { data: { type: 'FieldDefinition', attributes: { name: f.name, data_type: type } } },
    });
    let made;
    try { made = await create(f.type); }
    catch (e) {
      if (e instanceof PcoAuthError || e instanceof PcoRateError) throw e;
      made = await create('string');   // graceful fallback: a text field still filters in Lists
      audit(`pco:field-def-fallback ${f.name} (${f.type} rejected → text)`, '');
    }
    ids[f.key] = made.data.id;
    audit('pco:field-def-created', f.name);
  }
  setSetting('pco_field_ids', JSON.stringify(ids));
  return ids;
}

// Write one person's values, PATCHing an existing datum or POSTing a new one.
async function pushOnePerson(pcoId, ids, values, defs) {
  const cur = await pcoFetch(`/people/v2/people/${pcoId}/field_data?per_page=100`);
  const byDef = new Map();
  for (const d of cur.data || []) {
    const defId = d.relationships?.field_definition?.data?.id || d.attributes?.field_definition_id;
    if (defId) byDef.set(String(defId), d.id);
  }
  for (const f of defs) {
    const defId = ids[f.key], value = values[f.key];
    if (!defId || value === '' || value == null) continue;   // never write a blank over a real value
    const have = byDef.get(String(defId));
    if (have) await pcoFetch(`/people/v2/people/${pcoId}/field_data/${have}`, {
      method: 'PATCH', body: { data: { type: 'FieldDatum', id: String(have), attributes: { value } } },
    });
    else await pcoFetch(`/people/v2/people/${pcoId}/field_data`, {
      method: 'POST', body: { data: { type: 'FieldDatum', attributes: { field_definition_id: defId, value } } },
    });
  }
}

// Push up to `limit` people whose scoreboard CHANGED since their last push. Returns how many were
// written. Called from the weekly rollover (all of that night's players), the 60s tick (a slow
// drain so any backlog self-heals), and the admin "Push attendance now" button.
// Per-boot skip list for people whose PCO record errored non-retryably (e.g. destroyed in PCO —
// the webhook deliberately keeps the link and only audits). Without it, ORDER BY id retries the
// same dead row FIRST on every tick and everyone behind it never syncs again. In-memory on
// purpose: a restart retries once, so a fixed record heals without any manual reset.
const fieldSkip = new Set();
export async function pcoPushFields(limit = 25) {
  const defs = enabledFieldDefs();
  if (!pcoConnected() || !defs.length) return 0;
  return withSweepLock(async () => {
    const ids = await ensureFieldDefs(defs);
    let pushed = 0;
    for (const m of stmtAttCandidates.all()) {
      if (pushed >= limit) break;
      if (fieldSkip.has(m.email)) continue;
      const { values, sig } = profileFieldsFor(m);
      if (!sig || sig === (m.pco_att_sig || '')) continue;           // nothing enabled, or unchanged
      try {
        await pushOnePerson(m.pco_id, ids, values, defs);
        stmtSetAttSig.run(sig, m.email);
        pushed++;
      } catch (e) {
        if (isRetryable(e)) throw e;   // global condition — stop the sweep, retry next tick
        fieldSkip.add(m.email);        // THIS person's record is the problem — never block the rest
        audit(`pco:field-push-skipped — ${e.message.slice(0, 100)}`, m.email);
      }
    }
    if (pushed) {
      setSetting('pco_att_last', new Date().toISOString());
      audit('pco:profile-fields-pushed', String(pushed));
    }
    return pushed;
  });
}
// Turning a set on/off clears the cached definition ids (the next push re-discovers or creates the
// now-relevant ones) and the per-person signatures, so every profile is rewritten with the new
// shape rather than being skipped as "unchanged".
function resetFieldPushState() {
  delSetting('pco_field_ids');
  db.prepare('UPDATE applicants SET pco_att_sig = NULL WHERE pco_att_sig IS NOT NULL').run();
}
export function pcoSetAttendanceFields(on) { setSetting('pco_attendance_fields', on ? '1' : '0'); resetFieldPushState(); }
export function pcoSetWaiverFields(on) { setSetting('pco_waiver_fields', on ? '1' : '0'); resetFieldPushState(); }
// How many linked members are waiting for a push (drives the admin console's count).
export function pcoFieldsPending() {
  if (!enabledFieldDefs().length) return 0;
  let n = 0;
  for (const m of stmtAttCandidates.all()) {
    const { sig } = profileFieldsFor(m);
    if (sig && sig !== (m.pco_att_sig || '')) n++;
  }
  return n;
}

// ---------- Waiver verification against the church's own records ----------
// Bridge's waiver flag is a member ATTESTATION ("I signed it"). If the church runs its waiver as a
// Planning Center form, the submissions are readable through the API — so the attestation can be
// matched against the system of record and become PROOF instead of a claim. Everything here is
// read-only against PCO; the only writes are to Bridge's own columns.
export function pcoVerifyWaivers() { return withSweepLock(verifyWaiversInner); }
async function verifyWaiversInner() {
  const formId = getSetting('pco_waiver_form');
  if (!formId) throw new Error('No waiver form configured');
  // person id → earliest submission date (the date they actually signed).
  const signed = new Map();
  let unmatched = 0;
  let path = `/people/v2/forms/${encodeURIComponent(formId)}/form_submissions?per_page=100`;
  while (path) {
    const json = await pcoFetch(path);
    for (const s of json.data || []) {
      const pid = s.relationships?.person?.data?.id;
      const when = String(s.attributes?.created_at || '').slice(0, 10);
      if (!pid) { unmatched++; continue; }           // an anonymous submission can't be matched to a member
      const prev = signed.get(String(pid));
      if (!prev || (when && when < prev)) signed.set(String(pid), when);
    }
    const next = json.links?.next;
    path = next ? next.replace(/^https?:\/\/[^/]+/, '') : null;
  }
  const stampVerified = db.prepare(
    `UPDATE applicants SET waiver_ok = 1,
            waiver_at = COALESCE(waiver_at, ?),
            waiver_verified_at = ? WHERE email = ?`);
  let verified = 0; const missing = [];
  for (const m of stmtAttCandidates.all()) {
    const when = signed.get(String(m.pco_id));
    if (when) { stampVerified.run(when, when, m.email); verified++; }
    else missing.push(m.email);
  }
  const report = { at: new Date().toISOString(), verified, missing, submissions: signed.size, unmatched };
  setSetting('pco_waiver_report', JSON.stringify(report));
  audit(`pco:waivers-verified verified=${verified} missing=${missing.length} submissions=${signed.size}`, '');
  return report;
}
export function pcoSetWaiverForm(id) { if (id) setSetting('pco_waiver_form', String(id)); else delSetting('pco_waiver_form'); }

// ---------- Phase 2b: Check-Ins at the door (read-side) ----------
// PCO Check-Ins is write-walled for everyone, but READING check-ins back is open — that's the
// whole hybrid: the church's station takes the tap (their official record), Bridge reads the taps
// and reconciles them against its own roster. Nothing here writes to Check-Ins.

// Reconcile one run date against the door taps. Buckets:
//   ok      — signed up in Bridge AND tapped at the station
//   noShows — on the Bridge roster, never tapped (guests exempt: no PCO person to tap as)
//   walkIns — tapped at the station with no Bridge signup (named if the person is linked)
// The roster provider is injected by server.js: "who counts as expected on the floor" is program
// logic (partitions, caps, offer windows) that lives there. Without it, this module's own fallback
// query would count WAITLISTERS — who correctly stayed home — as no-shows in a church-visible report.
let rosterProvider = null;
export function pcoSetRosterProvider(fn) { rosterProvider = typeof fn === 'function' ? fn : null; }

export async function pcoReconcile(dateStr) {
  const eventId = getSetting('pco_checkins_event');
  if (!eventId) throw new Error('No Check-Ins event configured');
  // The tap window is the LOCAL day, converted to UTC bounds. PCO timestamps are UTC; a naive
  // `${date}T00:00:00Z` window ends at 8 PM Eastern — a basketball run's 8:30 PM taps would all
  // fall on the "next day" and the report would confidently declare the whole floor a no-show.
  // Server local time == the church's local time (enforced by the hosting runbook's TZ step).
  const dayStart = new Date(dateStr + 'T00:00:00');
  if (isNaN(dayStart.getTime())) throw new Error('Bad reconcile date');
  const gte = dayStart.toISOString();
  const lte = new Date(dayStart.getTime() + 24 * 3600 * 1000 - 1000).toISOString();
  const tapped = new Set();   // pco person ids that tapped that (local) day
  await eachPerson(
    `/check-ins/v2/events/${encodeURIComponent(eventId)}/check_ins` +
    `?where[created_at][gte]=${encodeURIComponent(gte)}&where[created_at][lte]=${encodeURIComponent(lte)}&per_page=100`,
    (c) => { const pid = c.relationships?.person?.data?.id; if (pid) tapped.add(String(pid)); });
  // Expected = FLOOR players of the programs that ran that date (per program partition), never
  // waitlisters and never other programs sharing the date.
  const roster = rosterProvider ? rosterProvider(dateStr) : db.prepare(
    `SELECT email, name FROM checkins WHERE run_date = ? AND ${SYNTHETIC}`).all(dateStr);
  const linkOf = new Map(db.prepare('SELECT email, pco_id FROM applicants WHERE pco_id IS NOT NULL').all()
    .map(r => [r.email, String(r.pco_id)]));
  const byPcoId = new Map([...linkOf].map(([e, p]) => [p, e]));
  let ok = 0; const noShows = [];
  const rosterIds = new Set();
  for (const r of roster) {
    const pid = linkOf.get(r.email);
    if (pid) rosterIds.add(pid);
    if (pid && tapped.has(pid)) ok++;
    else noShows.push(r.name || r.email);
  }
  const walkIns = [...tapped].filter(pid => !rosterIds.has(pid))
    .map(pid => byPcoId.get(pid) || `PCO person #${pid}`);
  const report = { at: new Date().toISOString(), date: dateStr, ok, noShows, walkIns };
  setSetting('pco_checkins_report', JSON.stringify(report));
  audit(`pco:reconcile ${dateStr} ok=${ok} no-shows=${noShows.length} walk-ins=${walkIns.length}`, '');
  return report;
}

// Kiosk arrivals — the door screen's live view of today's station taps. Viewer-driven: the
// kiosk's own 8s self-refresh calls this on every render; it answers from cache instantly and
// kicks ONE background refresh when the cache is older than PCO_KIOSK_POLL_MS (default 30s),
// so a TV left on polls PCO ~2 req/30s while someone is actually watching and zero when not.
// Taps can only exist inside the run day's LOCAL window, so any other date returns null and no
// request is ever spent on a future run. A failed refresh keeps the last good set (a PCO blip
// must not blank the door screen mid-run) but still stamps the clock, so a down API is retried
// at the poll cadence — not at every 8s screen swap. `live` turns true only after a successful
// read: the kiosk renders nothing rather than a confident "0 arrived" it never actually fetched.
// Roster membership is NOT decided here (same split as pcoReconcile's injected provider):
// this maps taps → linked emails; who counts as floor/waitlist/walk-in is server.js's call.
// Poll floor 5 SECONDS in prod (P3-4): an operator setting PCO_KIOSK_POLL_MS=10 thinking seconds
// must not turn every 8s screen refresh into a PCO page-walk. The harness keeps a ms-scale floor
// so its fast-cadence asserts still run.
const KIOSK_POLL_MS = Math.max(process.env.HARNESS ? 5 : 5000, Number(process.env.PCO_KIOSK_POLL_MS) || 30000);
const stmtLinkedPairs = () => db.prepare('SELECT email, pco_id FROM applicants WHERE pco_id IS NOT NULL');
let kioskTaps = { date: '', at: 0, arrived: new Set(), unlinkedTaps: 0, live: false, refreshing: false };
async function refreshKioskTaps(cache, dateStr, eventId) {
  // `cache` is the epoch this refresh belongs to (P3-4): a midnight rollover swaps the module
  // binding for a fresh object, so a completion from the OLD day writes into the orphaned object
  // and can never contaminate the new day's cache.
  try {
    const dayStart = new Date(dateStr + 'T00:00:00');   // LOCAL day → UTC bounds, same as pcoReconcile
    const gte = dayStart.toISOString();
    const lte = new Date(dayStart.getTime() + 24 * 3600 * 1000 - 1000).toISOString();
    const tapped = new Set();
    await eachPerson(
      `/check-ins/v2/events/${encodeURIComponent(eventId)}/check_ins` +
      `?where[created_at][gte]=${encodeURIComponent(gte)}&where[created_at][lte]=${encodeURIComponent(lte)}&per_page=100`,
      (c) => { const pid = c.relationships?.person?.data?.id; if (pid) tapped.add(String(pid)); });
    // Resolve taps → emails ONCE per successful refresh (P3-4), not per 8s render.
    const linked = new Map(stmtLinkedPairs().all().map((r) => [String(r.pco_id), r.email.toLowerCase()]));
    const arrived = new Set();
    let unlinkedTaps = 0;
    for (const pid of tapped) { const em = linked.get(pid); if (em) arrived.add(em); else unlinkedTaps++; }
    cache.arrived = arrived; cache.unlinkedTaps = unlinkedTaps;
    cache.live = true;
  } catch (e) {
    console.error(`[pco] kiosk arrivals refresh failed: ${e.message}`);
  } finally {
    cache.at = Date.now();
    cache.refreshing = false;
  }
}
export function pcoKioskArrivals(dateStr, todayStr) {
  if (getSetting('pco_kiosk_arrivals') !== '1' || !pcoAuthMode()) return null;
  const eventId = getSetting('pco_checkins_event');
  if (!eventId || dateStr !== todayStr) return null;
  if (kioskTaps.date !== dateStr) kioskTaps = { date: dateStr, at: 0, arrived: new Set(), unlinkedTaps: 0, live: false, refreshing: false };
  if (!kioskTaps.refreshing && Date.now() - kioskTaps.at >= KIOSK_POLL_MS) {
    kioskTaps.refreshing = true;
    refreshKioskTaps(kioskTaps, dateStr, eventId);   // deliberately un-awaited — the door screen never blocks on PCO
  }
  return { arrived: kioskTaps.arrived, unlinkedTaps: kioskTaps.unlinkedTaps, live: kioskTaps.live };
}

// Verify door passes by reading them back from PCO (consumption, not emission): for every linked
// member, store the FIRST pass code PCO actually has on file — Church Center's own pass counts,
// so does a Bridge-issued barcode once the church imports the CSV. The profile QR renders ONLY
// from a verified code; members with none land on the "missing" list that feeds the CSV export.
// One request PER MEMBER, so it is bounded and resumable: it checks only members whose pass is
// still unknown (a code already on file doesn't change), up to `limit` per run. An unbounded sweep
// of a few hundred members would run past PCO's 100-req/20s budget and 429 mid-loop, leaving a
// half-written report. The counts in the report come from the DB afterwards, so they're always the
// whole picture even though the sweep is partial.
export async function pcoVerifyPasses(limit = 100) {
  const todo = db.prepare(
    `SELECT email, pco_id FROM applicants
     WHERE pco_id IS NOT NULL AND pco_pass_code IS NULL AND ${SYNTHETIC} ORDER BY id LIMIT ?`).all(limit + 1);
  const more = todo.length > limit;
  const setCode = db.prepare('UPDATE applicants SET pco_pass_code = ? WHERE email = ?');
  let checked = 0;
  for (const m of todo.slice(0, limit)) {
    if (fieldSkip.has(m.email)) continue;   // same per-boot skip: one 404-ing person mustn't wedge the sweep
    let json;
    try { json = await pcoFetch(`/check-ins/v2/people/${m.pco_id}/passes`); }
    catch (e) {
      if (isRetryable(e)) throw e;
      fieldSkip.add(m.email);
      audit(`pco:pass-check-skipped — ${e.message.slice(0, 100)}`, m.email);
      continue;
    }
    const code = json.data?.[0]?.attributes?.code || null;
    if (code) setCode.run(code, m.email);
    checked++;
  }
  const withPass = db.prepare(`SELECT COUNT(*) n FROM applicants WHERE pco_pass_code IS NOT NULL AND ${SYNTHETIC}`).get().n;
  const missing = db.prepare(
    `SELECT email FROM applicants WHERE pco_id IS NOT NULL AND pco_pass_code IS NULL AND ${SYNTHETIC} ORDER BY id`)
    .all().map(r => r.email);
  const report = { at: new Date().toISOString(), withPass, missing, checked, more };
  setSetting('pco_pass_report', JSON.stringify(report));
  audit(`pco:verify-passes checked=${checked} with=${withPass} missing=${missing.length}${more ? ' (more remain)' : ''}`, '');
  return report;
}

// Rows for the "PCO barcode CSV" (People importer format — Barcode column is officially
// supported; the import ADDS barcodes but never overwrites an existing one). Only linked members
// still missing a verified pass; code = BR<pco_id> (stable + collision-free by construction).
export function pcoBarcodeRows() {
  return db.prepare(
    `SELECT full_name, email, pco_id FROM applicants
     WHERE pco_id IS NOT NULL AND pco_pass_code IS NULL AND ${SYNTHETIC} ORDER BY full_name`).all()
    .map(a => ({ ...splitName(a.full_name), email: a.email, barcode: 'BR' + a.pco_id }));
}

export function pcoStatus() {
  return {
    connected: pcoConnected(),
    authMode: pcoAuthMode(),                       // 'oauth' | 'pat' | null
    oauthConfigured: pcoOAuthConfigured(),
    oauthClientId: getSetting('pco_oauth_client_id') || '',
    webhookSet: !!getSetting('pco_webhook_secret'),
    tokenExpires: Number(getSetting('pco_oauth_expires') || 0),
    scopes: PCO_SCOPES,
    org: getSetting('pco_org') || '',
    error: getSetting('pco_error') || '',
    autocreate: getSetting('pco_autocreate') === '1',
    since: getSetting('pco_since') || '',
    report: JSON.parse(getSetting('pco_report') || 'null'),
    outboxPending: stmtOutboxPending.get().n,
    linked: db.prepare('SELECT COUNT(*) n FROM applicants WHERE pco_id IS NOT NULL').get().n,
    // Phase 2 (People custom fields — waiver and/or attendance)
    waiverFields: getSetting('pco_waiver_fields') === '1',
    attendanceFields: getSetting('pco_attendance_fields') === '1',
    attendanceLast: getSetting('pco_att_last') || '',
    attendancePending: pcoFieldsPending(),
    waiverFieldNames: WAIVER_FIELDS.map(f => f.name),
    attFieldNames: ATT_FIELDS.map(f => f.name),
    // Waiver verification against the church's own form records
    waiverForm: getSetting('pco_waiver_form') || '',
    waiverReport: JSON.parse(getSetting('pco_waiver_report') || 'null'),
    waiverCounts: db.prepare(
      `SELECT SUM(CASE WHEN waiver_verified_at IS NOT NULL THEN 1 ELSE 0 END) verified,
              SUM(CASE WHEN waiver_ok = 1 AND waiver_verified_at IS NULL THEN 1 ELSE 0 END) selfReported,
              SUM(CASE WHEN COALESCE(waiver_ok,0) = 0 THEN 1 ELSE 0 END) none
       FROM applicants WHERE status = 'approved' AND ${SYNTHETIC}`).get(),
    // Phase 2b surfaces
    doorMode: getSetting('pco_door_mode') === '1',
    kioskArrivals: getSetting('pco_kiosk_arrivals') === '1',
    passEnabled: getSetting('pco_pass_enabled') === '1',
    eventId: getSetting('pco_checkins_event') || '',
    passHolders: db.prepare('SELECT COUNT(*) n FROM applicants WHERE pco_pass_code IS NOT NULL').get().n,
    passReport: JSON.parse(getSetting('pco_pass_report') || 'null'),
    checkinsReport: JSON.parse(getSetting('pco_checkins_report') || 'null'),
  };
}
