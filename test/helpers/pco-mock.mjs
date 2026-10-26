// test/helpers/pco-mock.mjs — a minimal fake of the Planning Center API for the pco suite.
//
//   const mock = await startPcoMock({ congregation: [['First', 'Last', ['a@test.local'], { phone }], ...] });
//   // boot the app with PCO_API_BASE=mock.url; drive failures via mock.url + '/__mock/*'
//   await mock.close();
//
// JSON:API-ish shapes matching what pco.js actually consumes: paginated people?include=emails,
// search_name_or_email, POST person/emails/phone_numbers, PATCH person/phone, the updated_at delta
// filter, Basic-auth (PAT) and Bearer (OAuth) checks, the OAuth token endpoint with refresh
// rotation and PKCE, custom fields, form submissions, Check-Ins passes and taps, Registrations
// signups -- plus failure injection (429/5xx/4xx/401/403) through /__mock/* control endpoints.
// Listens on 127.0.0.1 on a free port; every URL it hands out (pagination links) uses that origin.
import http from 'node:http';

export function startPcoMock({ congregation = [] } = {}) {
  let base = '';   // http://127.0.0.1:<port>, set once listening
  const GOOD_AUTH = 'Basic ' + Buffer.from('testapp:testsecret').toString('base64');
  // OAuth fixtures: the mock plays PCO's token endpoint. Access tokens it has issued are accepted as
  // Bearer; refresh rotates (like the real API), and a revoked refresh token is rejected.
  const OAUTH_CLIENT = { id: 'cid-test', secret: 'csecret-test' };
  let oauthAccess = new Set(), oauthRefresh = new Set(), oauthIssued = 0, oauthRevoked = false;
  let refreshReuse = 0;     // times an already-consumed refresh token was presented (the race signal)
  let lastPkce = null;      // { challenge, method, verifier } — proves PKCE is sent and echoed back
  let forbidPrefix = null;  // { prefix, times } — force 403s on one product, e.g. an unlicensed Check-Ins
  let orgId = '1';          // switchable, to test reconnecting a DIFFERENT organization
  const issueTokens = (ttl) => {
    const a = `acc-${++oauthIssued}`, r = `ref-${oauthIssued}`;
    oauthAccess.add(a); oauthRefresh.add(r);
    return { access_token: a, refresh_token: r, expires_in: ttl, token_type: 'Bearer' };
  };

  let nextId = 1000;
  let people = [];        // {id, first_name, last_name, birthdate, updated_at, emails:[...], phones:[{id,number,primary}]}
  let requestLog = [];    // {method, path} — asserts inspect this
  let failQueue = [];     // statuses to serve before behaving (injected)

  let checkIns = [];      // {id, personId, eventId, created_at} — Check-Ins read-side fixtures
  let fieldDefs = [];     // {id, name, data_type} — People custom field definitions
  let fieldData = [];     // {id, personId, defId, value} — per-person custom field values
  let rejectTypes = [];   // data_types the mock refuses on create (exercises the text fallback)
  let formSubs = [];      // {id, formId, personId|null, created_at} — waiver-form submissions
  let signups = [];       // {id, name, archived, times:[ISO], attendees:[{personId,active,waitlisted,canceled}]}
                          // Registrations: the weekly run roster, which pco.js resolves BY DATE not title.
  const seedPerson = (first, last, emails, extra = {}) => {
    people.push({ id: String(++nextId), first_name: first, last_name: last, birthdate: extra.birthdate || null,
      updated_at: extra.updated_at || '2020-01-01T00:00:00Z', emails: emails.map(e => e.toLowerCase()),
      phones: extra.phone ? [{ id: String(++nextId), number: extra.phone, primary: true }] : [], passes: [] });
    return people[people.length - 1];
  };
  // The starting congregation (passed in by the suite), restored by /__mock/reset.
  function seedDefault() {
    nextId = 1000; people = []; requestLog = []; failQueue = []; checkIns = [];
    fieldDefs = []; fieldData = []; rejectTypes = []; formSubs = []; signups = [];
    oauthAccess = new Set(); oauthRefresh = new Set(); oauthIssued = 0; oauthRevoked = false;
    refreshReuse = 0; lastPkce = null;
    for (const [first, last, emails, extra] of congregation) seedPerson(first, last, emails, extra);
  }
  seedDefault();

  const personJson = (p) => ({
    type: 'Person', id: p.id,
    attributes: { first_name: p.first_name, last_name: p.last_name, birthdate: p.birthdate, updated_at: p.updated_at },
    relationships: { emails: { data: p.emails.map((_, i) => ({ type: 'Email', id: `${p.id}-e${i}` })) } },
  });
  const includedEmails = (list) => list.flatMap(p =>
    p.emails.map((addr, i) => ({ type: 'Email', id: `${p.id}-e${i}`, attributes: { address: addr, primary: i === 0 } })));

  const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj ? JSON.stringify(obj) : ''); };
  const readBody = (req) => new Promise((resolve) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const path = url.pathname;

    // ---- control plane (no auth) ----
    if (path === '/__mock/state') return send(res, 200, { people, log: requestLog, oauthIssued, refreshReuse, pkce: lastPkce });
    if (path === '/__mock/org' && req.method === 'POST') {      // pretend a different organization
      const b = await readBody(req);
      orgId = String(b.id || '1');
      return send(res, 200, { orgId });
    }
    if (path === '/__mock/forbid' && req.method === 'POST') {   // next N calls to a path prefix → 403
      const b = await readBody(req);
      forbidPrefix = { prefix: b.prefix || '/check-ins', times: b.times || 1 };
      return send(res, 200, { ok: true });
    }
    if (path === '/__mock/reset') { seedDefault(); return send(res, 200, { ok: true }); }
    if (path === '/__mock/signup' && req.method === 'POST') {  // seed a Registrations signup + its attendees
      const b = await readBody(req);
      const sg = { id: String(++nextId), name: b.name || 'Signup', archived: !!b.archived, times: b.times || [],
        attendees: (b.attendees || []).map(a => ({ personId: String(a.personId), active: a.active !== false,
          waitlisted: !!a.waitlisted, canceled: !!a.canceled })) };
      signups.push(sg);
      return send(res, 200, { id: sg.id });
    }
    if (path === '/__mock/signup/attendees' && req.method === 'POST') {  // replace a signup's attendees (reconcile fixture)
      const b = await readBody(req);
      const sg = signups.find(x => x.id === String(b.id));
      if (!sg) return send(res, 404, { errors: [{ detail: 'not found' }] });
      sg.attendees = (b.attendees || []).map(x => ({ personId: String(x.personId), active: x.active !== false,
        waitlisted: !!x.waitlisted, canceled: !!x.canceled }));
      return send(res, 200, { ok: true });
    }
    if (path === '/__mock/seed' && req.method === 'POST') {
      const b = await readBody(req);
      const p = seedPerson(b.first || 'X', b.last || 'Y', b.emails || [], b);
      return send(res, 200, { id: p.id });
    }
    if (path === '/__mock/touch' && req.method === 'POST') {   // bump updated_at + edit (delta-poll fixture)
      const b = await readBody(req);
      const p = people.find(x => x.id === String(b.id));
      if (p) Object.assign(p, b.attrs || {}, { updated_at: new Date(Date.now() + 60000).toISOString() });
      return send(res, 200, { ok: !!p });
    }
    if (path === '/__mock/fail' && req.method === 'POST') {    // serve these statuses before behaving
      const b = await readBody(req);
      failQueue.push(...Array(b.times || 1).fill(b.status || 500));
      return send(res, 200, { queued: failQueue.length });
    }
    if (path === '/__mock/formsub' && req.method === 'POST') { // record a waiver-form submission
      const b = await readBody(req);
      formSubs.push({ id: String(++nextId), formId: String(b.formId || '1'),
        personId: b.personId == null ? null : String(b.personId), created_at: b.created_at || '2026-05-01T10:00:00Z' });
      return send(res, 200, { ok: true });
    }
    if (path === '/__mock/pass' && req.method === 'POST') {    // attach a Check-Ins pass to a person
      const b = await readBody(req);
      const p = people.find(x => x.id === String(b.personId));
      if (p) p.passes.push({ id: String(++nextId), code: b.code || 'X', kind: b.kind || 'barcode' });
      return send(res, 200, { ok: !!p });
    }
    if (path === '/__mock/fields') return send(res, 200, { defs: fieldDefs, data: fieldData });
    if (path === '/__mock/rejecttype' && req.method === 'POST') {   // refuse a data_type on create
      const b = await readBody(req);
      rejectTypes.push(b.type || 'number');
      return send(res, 200, { rejecting: rejectTypes });
    }
    if (path === '/__mock/checkin' && req.method === 'POST') { // record a station tap
      const b = await readBody(req);
      checkIns.push({ id: String(++nextId), personId: String(b.personId), eventId: String(b.eventId || '1'),
        created_at: b.created_at || new Date().toISOString() });
      return send(res, 200, { ok: true });
    }

    if (path === '/__mock/oauth/revoke' && req.method === 'POST') {   // simulate a revoked grant
      oauthRevoked = true;
      return send(res, 200, { ok: true });
    }

    requestLog.push({ method: req.method, path: path + url.search });

    // Record the PKCE challenge presented on the authorize hop (the app redirects the BROWSER here,
    // so the mock only needs to observe the parameters).
    if (path === '/oauth/authorize') {
      lastPkce = { challenge: url.searchParams.get('code_challenge'), method: url.searchParams.get('code_challenge_method'), verifier: null };
      return send(res, 200, { ok: true, note: 'mock authorize — the app never follows this itself' });
    }

    // ---- OAuth token endpoint (authorization_code + refresh_token grants) ----
    if (path === '/oauth/token' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.client_id !== OAUTH_CLIENT.id || b.client_secret !== OAUTH_CLIENT.secret)
        return send(res, 401, { error: 'invalid_client' });
      if (b.grant_type === 'authorization_code') {
        if (b.code === 'rate-code') return send(res, 429, { error: 'slow_down' });
        if (b.code !== 'good-code') return send(res, 400, { error: 'invalid_grant' });
        oauthRevoked = false;   // a fresh authorization is a NEW grant — it supersedes a revocation
        if (lastPkce) lastPkce.verifier = b.code_verifier || null;   // must arrive on the exchange
        // ttl is short in tests so the refresh-before-expiry path is exercised deliberately
        return send(res, 200, issueTokens(Number(url.searchParams.get('ttl')) || 7200));
      }
      if (b.grant_type === 'refresh_token') {
        if (oauthRevoked) return send(res, 400, { error: 'invalid_grant' });
        if (!oauthRefresh.has(b.refresh_token)) {
          // Presenting a rotated-away token is exactly what a concurrent-refresh race looks like.
          refreshReuse++;
          return send(res, 400, { error: 'invalid_grant', reused: true });
        }
        oauthRefresh.delete(b.refresh_token);   // rotation: the old refresh token dies
        return send(res, 200, issueTokens(7200));
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }

    // ---- injected failures + auth ----
    if (failQueue.length) {
      const code = failQueue.shift();
      if (code === 429) { res.writeHead(429, { 'Retry-After': '1' }); return res.end('{}'); }
      return send(res, code, { errors: [{ detail: 'injected' }] });
    }
    // Either auth style is accepted, exactly like the real API: a PAT over Basic, or a Bearer access
    // token this mock issued (a stale/rotated-away token is rejected, which drives the retry path).
    // Product-level permission denial (403) — the credential is fine, this product is not allowed.
    if (forbidPrefix && path.startsWith(forbidPrefix.prefix) && forbidPrefix.times > 0) {
      forbidPrefix.times--;
      return send(res, 403, { errors: [{ detail: 'not permitted for this token' }] });
    }
    const authz = req.headers.authorization || '';
    const bearerOk = authz.startsWith('Bearer ') && !oauthRevoked && oauthAccess.has(authz.slice(7));
    if (authz !== GOOD_AUTH && !bearerOk) return send(res, 401, { errors: [{ detail: 'bad auth' }] });

    // ---- Registrations API surface (the weekly run roster) ----
    // pco.js lists signups by title prefix, decides WHICH one by signup_times.starts_at in local
    // time, then pulls attendees and one email call each. All four steps are faked here so the suite
    // drives the real pcoSignupRosterForDate instead of a stub — a stub would not have caught the
    // undeclared-`signup` ReferenceError that made this whole path dead in rel-20260911-1731.
    if (path === '/registrations/v2/signups' && req.method === 'GET')
      return send(res, 200, { data: signups.map(sg => ({ type: 'Signup', id: sg.id,
        attributes: { name: sg.name, archived: sg.archived } })), links: {} });

    if (path.startsWith('/registrations/v2/signups/') && req.method === 'GET') {
      const [sid, tail] = path.slice('/registrations/v2/signups/'.length).split('/');
      const sg = signups.find(x => x.id === sid);
      if (!sg) return send(res, 404, { errors: [{ detail: 'not found' }] });
      if (tail === 'signup_times')
        return send(res, 200, { data: sg.times.map((t, i) => ({ type: 'SignupTime', id: sg.id + '-t' + i,
          attributes: { starts_at: t } })), links: {} });
      if (tail === 'attendees') {
        const inc = sg.attendees.map(a => people.find(x => x.id === a.personId)).filter(Boolean);
        return send(res, 200, {
          data: sg.attendees.map((a, i) => ({ type: 'Attendee', id: sg.id + '-a' + i,
            attributes: { active: a.active, canceled: a.canceled, waitlisted: a.waitlisted },
            relationships: { person: { data: { type: 'Person', id: a.personId } } } })),
          included: inc.map(personJson), links: {},
        });
      }
    }

    // ---- People API surface ----
    if (path === '/people/v2' && req.method === 'GET')
      return send(res, 200, { data: { type: 'Organization', id: orgId, attributes: { name: orgId === '1' ? 'Mock Community Church' : 'Other Church' } } });

    if (path === '/people/v2/people' && req.method === 'GET') {
      let list = people;
      const search = url.searchParams.get('where[search_name_or_email]');
      if (search) list = list.filter(p => p.emails.includes(search.toLowerCase())
        || `${p.first_name} ${p.last_name}`.toLowerCase().includes(search.toLowerCase()));
      const gte = url.searchParams.get('where[updated_at][gte]');
      if (gte) list = list.filter(p => p.updated_at >= gte);
      const per = Math.min(Number(url.searchParams.get('per_page') || 25), 100);
      const off = Number(url.searchParams.get('offset') || 0);
      const page = list.slice(off, off + per);
      const links = {};
      if (off + per < list.length) {
        const n = new URL(url); n.searchParams.set('offset', off + per);
        links.next = `${base}${n.pathname}${n.search}`;
      }
      return send(res, 200, { data: page.map(personJson), included: includedEmails(page), links, meta: { total_count: list.length } });
    }

    if (path === '/people/v2/people' && req.method === 'POST') {
      const b = await readBody(req);
      const a = b.data?.attributes || {};
      const p = seedPerson(a.first_name || '', a.last_name || '', [], { birthdate: a.birthdate });
      p.updated_at = new Date().toISOString();
      return send(res, 201, { data: personJson(p) });
    }

    const mPerson = path.match(/^\/people\/v2\/people\/(\d+)$/);
    if (mPerson) {
      const p = people.find(x => x.id === mPerson[1]);
      if (!p) return send(res, 404, { errors: [{ detail: 'not found' }] });
      if (req.method === 'GET') return send(res, 200, { data: personJson(p), included: includedEmails([p]) });
      if (req.method === 'PATCH') {
        const b = await readBody(req);
        Object.assign(p, b.data?.attributes || {}); p.updated_at = new Date().toISOString();
        return send(res, 200, { data: personJson(p) });
      }
    }

    const mEmails = path.match(/^\/people\/v2\/people\/(\d+)\/emails$/);
    if (mEmails && req.method === 'POST') {
      const p = people.find(x => x.id === mEmails[1]);
      if (!p) return send(res, 404, {});
      const b = await readBody(req);
      p.emails.push(String(b.data?.attributes?.address || '').toLowerCase());
      return send(res, 201, { data: { type: 'Email', id: `${p.id}-e${p.emails.length - 1}` } });
    }

    const mPhones = path.match(/^\/people\/v2\/people\/(\d+)\/phone_numbers(\/(\d+))?$/);
    if (mPhones) {
      const p = people.find(x => x.id === mPhones[1]);
      if (!p) return send(res, 404, {});
      if (!mPhones[3] && req.method === 'GET')
        return send(res, 200, { data: p.phones.map(n => ({ type: 'PhoneNumber', id: n.id, attributes: { number: n.number, primary: n.primary } })) });
      if (!mPhones[3] && req.method === 'POST') {
        const b = await readBody(req);
        p.phones.push({ id: String(++nextId), number: b.data?.attributes?.number || '', primary: true });
        return send(res, 201, { data: { type: 'PhoneNumber', id: p.phones[p.phones.length - 1].id } });
      }
      if (mPhones[3] && req.method === 'PATCH') {
        const b = await readBody(req), n = p.phones.find(x => x.id === mPhones[3]);
        if (n) n.number = b.data?.attributes?.number || n.number;
        return send(res, 200, {});
      }
    }

    // ---- People custom fields (definitions + per-person data) ----
    if (path === '/people/v2/field_definitions') {
      if (req.method === 'GET')
        return send(res, 200, { data: fieldDefs.map(d => ({ type: 'FieldDefinition', id: d.id, attributes: { name: d.name, data_type: d.data_type, deleted_at: null } })), links: {} });
      if (req.method === 'POST') {
        const b = await readBody(req);
        const a = b.data?.attributes || {};
        if (rejectTypes.includes(a.data_type)) return send(res, 422, { errors: [{ detail: `data_type ${a.data_type} not allowed` }] });
        const d = { id: String(++nextId), name: a.name || '', data_type: a.data_type || 'string' };
        fieldDefs.push(d);
        return send(res, 201, { data: { type: 'FieldDefinition', id: d.id, attributes: { name: d.name, data_type: d.data_type } } });
      }
    }
    const mFd = path.match(/^\/people\/v2\/people\/(\d+)\/field_data(\/(\d+))?$/);
    if (mFd) {
      const pid = mFd[1];
      if (!mFd[3] && req.method === 'GET')
        return send(res, 200, { data: fieldData.filter(f => f.personId === pid).map(f => ({
          type: 'FieldDatum', id: f.id, attributes: { value: f.value },
          relationships: { field_definition: { data: { type: 'FieldDefinition', id: f.defId } } } })) });
      if (!mFd[3] && req.method === 'POST') {
        const b = await readBody(req);
        const a = b.data?.attributes || {};
        const f = { id: String(++nextId), personId: pid, defId: String(a.field_definition_id), value: String(a.value) };
        fieldData.push(f);
        return send(res, 201, { data: { type: 'FieldDatum', id: f.id } });
      }
      if (mFd[3] && req.method === 'PATCH') {
        const b = await readBody(req), f = fieldData.find(x => x.id === mFd[3]);
        if (f) f.value = String(b.data?.attributes?.value);
        return send(res, 200, {});
      }
    }

    // ---- People Forms: submissions are readable (the waiver-verification source) ----
    const mSubs = path.match(/^\/people\/v2\/forms\/(\d+)\/form_submissions$/);
    if (mSubs && req.method === 'GET') {
      const list = formSubs.filter(s => s.formId === mSubs[1]);
      return send(res, 200, {
        data: list.map(s => ({
          type: 'FormSubmission', id: s.id, attributes: { created_at: s.created_at, verified: true },
          relationships: { person: { data: s.personId ? { type: 'Person', id: s.personId } : null } },
        })),
        links: {}, meta: { total_count: list.length },
      });
    }

    // ---- Check-Ins API surface (READ-only, like the real thing) ----
    const mPass = path.match(/^\/check-ins\/v2\/people\/(\d+)\/passes$/);
    if (mPass && req.method === 'GET') {
      const p = people.find(x => x.id === mPass[1]);
      if (!p) return send(res, 404, {});
      return send(res, 200, { data: p.passes.map(x => ({ type: 'Pass', id: x.id, attributes: { code: x.code, kind: x.kind } })) });
    }
    const mTaps = path.match(/^\/check-ins\/v2\/events\/(\d+)\/check_ins$/);
    if (mTaps && req.method === 'GET') {
      const gte = url.searchParams.get('where[created_at][gte]') || '';
      const lte = url.searchParams.get('where[created_at][lte]') || '9999';
      const list = checkIns.filter(c => c.eventId === mTaps[1] && c.created_at >= gte && c.created_at <= lte);
      return send(res, 200, {
        data: list.map(c => ({ type: 'CheckIn', id: c.id, attributes: { created_at: c.created_at },
          relationships: { person: { data: { type: 'Person', id: c.personId } } } })),
        meta: { total_count: list.length },
      });
    }

    send(res, 404, { errors: [{ detail: `mock has no route ${req.method} ${path}` }] });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: base,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}
