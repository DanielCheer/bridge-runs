// routes/public.js — what anyone can reach before signing in: static files and the client engine
// (mountAssets, which also runs the sliding session and the install beacon), the application form
// (mountIntake), the policy pages (mountLegal) and invite links (mountInvite).
import express from 'express';
import QRCode from 'qrcode';
import path from 'path';
import db from '../db.js';
import { AVATARS_DIR, CHAT_MEDIA_DIR, APP_ROOT, LEGAL_ENV, LEGAL, WAIVER_URL } from '../config.js';
import { setSession, currentUser } from '../auth.js';
import { APP_JS, intakePage, mdToHtml, legalPage, invitePage } from '../views.js';
import { metric, audit } from '../lib/audit.js';
import { rateLimited } from '../lib/rate-limit.js';
import { ymdLocal } from '../lib/dates.js';
import { isValidEmail } from '../lib/email.js';
import { clientIp } from '../lib/http.js';
import { applicantByEmail, ageFromDob } from '../engine/applicants.js';
import { stampWaiver } from '../engine/waivers.js';
import fs from 'fs';
import { sendMagicLink, emailConfigured } from '../mailer.js';
import { createLoginLink, signIn } from '../lib/sign-in.js';
import { nextRunDate } from '../engine/basketball-calendar.js';
import { autoJoinTeam } from '../engine/basketball.js';

// The waiver QR is generated from WAIVER_URL instead of being shipped as an image, so the code
// people scan always encodes the same link printed beside it, and no organization's real form is
// baked into the repo. WAIVER_URL is fixed for the life of the process, so the SVG is rendered
// once, on first request, and reused. No WAIVER_URL → no QR (views render no section) → 404.
let waiverQrSvg = null;

// Sliding session: any request carrying a valid cookie gets its ~10-year window
// pushed forward, so a player who keeps showing up never has to sign in again.
// Static assets are served above and never reach this.
// Piggybacked engagement pulse (metrics layer): the SAME resolved identity feeds two throttled
// touches — last_seen_at at most once per LOCAL day per account (in-memory day map; a restart
// costs one extra write per user), and a push_tap row when the SW-appended ?from=push marker
// arrives. No other request writes anything — /poll's zero-write contract holds after the first
// touch of the day.
const lastSeenDay = new Map();
const stmtTouchSeen = db.prepare("UPDATE applicants SET last_seen_at = datetime('now','localtime') WHERE email = ?");

export function mountAssets(app) {
  // Profile-photo storage. Defaults to public/avatars (served by the general static
  // mount below); AVATARS_DIR lets a test/other env point it elsewhere. Mounted at
  // /avatars BEFORE the public static so an override wins, yet a missing file falls
  // through to the public mount (keeps the hand-placed daniel.jpg seed working even
  // when AVATARS_DIR is a temp dir). Created on boot so the first upload never ENOENTs.
  app.use('/avatars', express.static(AVATARS_DIR, { maxAge: '365d', immutable: true })); // content-addressed name + ?v= bust → safe to pin
  // Chat photo storage. Same override pattern as avatars: CHAT_MEDIA_DIR points it
  // elsewhere in test/other envs and is mounted at /chat-media BEFORE the public static
  // so an override wins, yet a missing file falls through. Created on boot so the first
  // upload never ENOENTs. Stickers live in public/stickers and are served by the general
  // public mount below (no per-file DB — validated by name against STICKERS on send).
  app.use('/chat-media', express.static(CHAT_MEDIA_DIR, { maxAge: '365d', immutable: true })); // <msgid>-<hex> names never rewritten → safe to pin
  // The service worker must never be pinned by HTTP cache (it controls the whole app),
  // so serve it no-cache from the same public dir, ahead of the 7-day static mount.
  app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('application/javascript');
    res.sendFile(path.join(APP_ROOT, 'public', 'sw.js'));
  });
  // The client engine (router/poll/swap/push/badges/logout — see APP_JS in views.js),
  // extracted from an inline HEAD script so it caches once instead of re-shipping ~15KB per
  // page. The URL carries ?v=BUILD_VER (tracks views.js/styles.css mtime), so any code change
  // mints a fresh URL; the body is byte-identical for a given build → cache a year, immutable.
  app.get('/app.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('application/javascript').send(APP_JS);
  });
  app.get('/waiver-qr.svg', async (req, res, next) => {
    if (!WAIVER_URL) return next();
    try {
      waiverQrSvg ??= await QRCode.toString(WAIVER_URL, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
      res.set('Cache-Control', 'public, max-age=604800').type('image/svg+xml').send(waiverQrSvg);
    } catch (e) { next(e); } // QR failure must not take the process down (Express 4 won't catch async throws)
  });
  app.use(express.static(path.join(APP_ROOT, 'public'), { maxAge: '7d', immutable: false }));
  app.use((req, res, next) => {
    const email = currentUser(req);
    if (email) {
      setSession(res, email);
      const d = ymdLocal();
      if (lastSeenDay.get(email) !== d) {
        lastSeenDay.set(email, d);
        try { stmtTouchSeen.run(email); } catch (e) { console.error(`[metrics] last-seen touch failed: ${e.message}`); }
      }
      if (req.query.from === 'push' && !rateLimited('push_tap', email, 40, 24 * 3600 * 1000)) {
        // meta = "tag|path" when the SW passed the notification tag (charset-stripped: our tags are
        // plain slugs; a hostile ?tag= can't smuggle an identity into the identity-free table).
        const tg = String(req.query.tag || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
        metric('push_tap', { meta: (tg ? tg + '|' : '') + String(req.path).slice(0, 78) });   // P3-5 cap: real taps are a handful/day
      }
    }
    next();
  });

  // PWA install beacon (metrics layer): the client fires navigator.sendBeacon here on the
  // `appinstalled` event — the only way the server ever learns an install happened. Signed-in
  // only (beacons carry same-origin cookies) so an anonymous crawler can't inflate the count;
  // no identity is stored, just the fact.
  app.post('/metrics/install', (req, res) => {
    const who = currentUser(req);
    // P3-5: a member re-installs at most a couple of times ever — 3/day per account keeps a
    // hostile beacon loop from inflating the count or growing metrics_events unbounded.
    if (who && !rateLimited('metric_install', who, 3, 24 * 3600 * 1000)) metric('pwa_install');
    res.status(204).end();
  });

  // PWA manifest — controls the icon + name when players "Add to Home Screen".
  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json').send(JSON.stringify({
      name: 'The Bridge Adv Runs',
      short_name: 'Bridge Runs',
      start_url: '/runs',
      scope: '/',
      display: 'standalone',
      background_color: '#22615A',
      theme_color: '#22615A',
      icons: [
        { src: '/icon-192.png?v=2', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
  });
}

export function mountIntake(app) {
  // ---------- INTAKE (public application form → council votes) ----------
  app.get('/', (req, res) => res.send(intakePage()));

  app.post('/apply', (req, res) => {
    // Cap application spam per IP so nobody can flood the pending list.
    if (rateLimited('apply-ip', clientIp(req), 8, 10 * 60 * 1000)) {
      return res.send(intakePage({ error: 'Too many submissions from here — give it a few minutes and try again.' }));
    }
    const { full_name, phone, email, where_played, waiver_ok } = req.body;
    const dob = String(req.body.dob || '').trim();
    // levels can be a single string, an array, or undefined
    let levels = req.body.levels || [];
    if (typeof levels === 'string') levels = [levels];
    const otherText = (req.body.levels_other || '').trim();
    // replace bare "Other" with the typed value
    const experience = levels
      .map(l => (l === 'Other' && otherText) ? `Other: ${otherText}` : l)
      .filter(l => l && l !== 'Other')
      .join(', ');
    if (!full_name || !phone || !email || !experience) {
      return res.send(intakePage({ error: 'Please fill in name, phone, email, and at least one level.' }));
    }
    const em = String(email).trim().toLowerCase();
    // A stored address is later a nodemailer recipient (announcement BCC, spot offers), so it
    // has to survive the same gate as /login rather than entering the DB unchecked.
    if (!isValidEmail(em)) return res.send(intakePage({ error: 'That email doesn’t look right — check it and try again.' }));
    // DOB is required (drives the under-18 DM safeguarding rule). Reject missing / malformed / absurd.
    const applicantAge = ageFromDob(dob);
    if (applicantAge == null || applicantAge < 5 || applicantAge > 110) {
      return res.send(intakePage({ error: 'Please enter a valid date of birth.' }));
    }
    try {
      const existing = applicantByEmail(em);
      // Anyone with a player's email could otherwise rename/rehome them via the
      // public QR form. An already-cleared player (approved / team / host) is never
      // overwritten by a public re-application — send them to sign in instead.
      if (existing && (existing.status === 'approved' || existing.is_team || existing.is_host)) {
        return res.send(intakePage({ alreadyApproved: true }));
      }
      if (existing) {
        db.prepare(`UPDATE applicants SET full_name=?, phone=?, experience=?, where_played=?, waiver_ok=?, dob=?
                  WHERE email=?`)
          .run(full_name.trim(), phone.trim(), experience, (where_played || '').trim(),
               waiver_ok ? 1 : 0, dob, em);
      } else {
        db.prepare(`INSERT INTO applicants (full_name,email,phone,experience,where_played,waiver_ok,dob)
                  VALUES (?,?,?,?,?,?,?)`)
          .run(full_name.trim(), em, phone.trim(), experience, (where_played || '').trim(),
               waiver_ok ? 1 : 0, dob);
      }
      if (waiver_ok) stampWaiver(em);   // permanent attestation date (the form's box is required)
      res.send(intakePage({ submitted: true }));
    } catch (e) {
      console.error(e);
      res.send(intakePage({ error: 'Something broke on our end. Try again.' }));
    }
  });
}

// ---------- LEGAL / POLICY PAGES (public) ----------
// Renders the source drafts in legal/*.md through the app shell. The .md files stay
// untouched as review copies (they carry an operator-only "DRAFT — have a lawyer review"
// note + [PLACEHOLDERS]); we strip that note and fill the placeholders at RENDER time, so
// the published page is clean while the file remains the reviewable source of truth.
const LEGAL_DOCS = {
  privacy: { file: 'privacy-policy.md', title: 'Privacy Policy' },
  terms: { file: 'terms-of-use.md', title: 'Terms of Use' },
  conduct: { file: 'code-of-conduct.md', title: 'Code of Conduct' },
};
function renderLegal(key) {
  const d = LEGAL_DOCS[key];
  if (!d) return null;
  let md;
  try { md = fs.readFileSync(path.join(APP_ROOT, 'legal', d.file), 'utf8'); } catch { return null; }
  md = md.replace(/^\s*\*\*[^\n]*DRAFT[^\n]*\*\*\s*\n/, '');                 // drop the operator-only draft note
  md = md.replace(/\[DATE\]/g, LEGAL.date || '$&')                          // '$&' = leave the token as-is
         .replace(/\[HOST NAME\]/g, LEGAL.name || '$&')
         .replace(/\[NAME — e\.g\.,[^\]]*\]/g, 'Google (Gmail)')             // the email service sub-processor
         .replace(/\[NAME\]/g, LEGAL.name || '$&')
         .replace(/\[EMAIL\/PHONE\]/g, LEGAL.email || '$&')
         .replace(/\[EMAIL\]/g, LEGAL.email || '$&')
         .replace(/,?\s*\[PHONE — optional\]/g, '');                         // optional → omit (with any leading comma)
  return legalPage(d.title, mdToHtml(md));
}

export function mountLegal(app) {
  // Who the policies name as the operator/contact: LEGAL (config.js). Unset → the [PLACEHOLDER]
  // stays visible on the page (honest about missing config) rather than a made-up value.
  for (const [key, env] of Object.entries(LEGAL_ENV)) {
    if (!LEGAL[key]) console.warn(`[legal] ${env} unset — policy pages will show the placeholder`);
  }
  for (const key of Object.keys(LEGAL_DOCS)) {
    app.get('/' + key, (req, res) => {
      const html = renderLegal(key);
      if (html) res.send(html); else res.status(404).type('text').send('Not found');
    });
  }
}

export function mountInvite(app) {
  // An admin creates a token — optionally with name/phone already filled in, or
  // totally blank. The player opens the link, fills in whatever's missing, and
  // is created as approved (with whatever role the admin picked) — no vote, no
  // waiting on the admin to type in their contact info by hand.
  app.get('/invite/:token', (req, res) => {
    const iv = db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);
    if (!iv) return res.send(invitePage({ invalid: true }));
    if (iv.used) return res.send(invitePage({ used: true }));
    res.send(invitePage({ token: iv.token, full_name: iv.full_name, phone: iv.phone, email: iv.email }));
  });

  app.post('/invite/:token', async (req, res) => {
    const iv = db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);
    if (!iv) return res.send(invitePage({ invalid: true }));
    if (iv.used) return res.send(invitePage({ used: true }));

    const full_name = (req.body.full_name || iv.full_name || '').trim();
    const phone = (req.body.phone || iv.phone || '').trim();
    const email = (req.body.email || iv.email || '').trim().toLowerCase();
    const waiverOk = req.body.waiver_ok ? 1 : 0;
    const dob = String(req.body.dob || '').trim();
    const inviteAge = ageFromDob(dob);
    const dobBad = inviteAge == null || inviteAge < 5 || inviteAge > 110;
    if (!full_name || !phone || !isValidEmail(email) || !waiverOk || dobBad) {
      return res.send(invitePage({
        token: iv.token, full_name, phone, email, dob,
        error: !waiverOk ? 'Please confirm the waiver to continue.'
          : dobBad ? 'Please enter a valid date of birth.'
          : 'Fill in your name, phone, and a valid email.',
      }));
    }

    // Ownership proof: a smooth instant-claim (auto sign-in) is ONLY granted when the
    // admin pre-filled an email on the invite AND the submitter kept/entered that exact
    // email. Anything else — no pre-filled email, or a submitted email that differs
    // (possibly matching a DIFFERENT existing player) — has NO proof the submitter owns
    // the address, so we never open a session as them. We still honor the invite
    // (approve + role, on the correct record) and email a one-tap sign-in link to the
    // submitted address to verify ownership before a session is established.
    const prefilled = (iv.email || '').trim().toLowerCase();
    const prefilledMatch = !!prefilled && prefilled === email;

    const isTeam = iv.role === 'team' ? 1 : 0;
    const isRegular = iv.role === 'regular' ? 1 : 0;
    const existing = applicantByEmail(email);
    if (existing) {
      if (prefilledMatch) {
        // Verified owner confirming their own pre-filled invite — safe to refresh
        // their name/phone from what they submitted. Persist the waiver they just attested
        // (the form requires the checkbox — see the !waiverOk reject above); a fresh-INSERT
        // claim already sets waiver_ok=1, and dropping it here left auto-seated team members
        // with no waiver on file.
        db.prepare('UPDATE applicants SET status=?, is_team=?, is_regular=?, full_name=?, phone=?, waiver_ok=1 WHERE email=?')
          .run('approved', isTeam, isRegular, full_name, phone, email);
      } else {
        // Unverified submitter (email doesn't match the invite's prefill → no ownership proof).
        // Only ever un-hold their status to approved; NEVER change roles here. Granting is_team/
        // is_regular would let anyone holding a role-carrying invite type a VICTIM's email and
        // promote that victim (e.g. into the Team voting pool) with no proof they own it. A real
        // role upgrade goes through the prefilled-match branch (verified) or /admin/people/edit.
        db.prepare("UPDATE applicants SET status = CASE WHEN status = 'rejected' THEN 'rejected' ELSE 'approved' END WHERE email = ?")
          .run(email);
      }
    } else if (prefilledMatch) {
      // Verified owner (admin pre-filled this exact email) — grant the role + waiver they attested.
      db.prepare(`INSERT INTO applicants (full_name,email,phone,experience,waiver_ok,status,is_team,is_regular)
                VALUES (?,?,?,?,1,'approved',?,?)`)
        .run(full_name, email, phone, 'Pre-approved (invite)', isTeam, isRegular);
    } else {
      // Unverified new email (submitter typed an address that doesn't match the invite's prefill) —
      // approve but grant NO role and NO waiver, matching the existing-row unverified branch above.
      // A role here would let a role-carrying invite seat a phantom team member (autoJoinTeam) for an
      // address the submitter never proved they own; an admin can grant the role later via edit.
      db.prepare(`INSERT INTO applicants (full_name,email,phone,experience,waiver_ok,status,is_team,is_regular)
                VALUES (?,?,?,?,0,'approved',0,0)`)
        .run(full_name, email, phone, 'Pre-approved (invite, unverified)');
    }
    // Record the invitee's DOB (drives the under-18 DM rule). KEEP-FIRST-SET (COALESCE): an already-set
    // DOB is never overwritten here — otherwise a known minor holding an invite link could re-claim it
    // with a fake adult DOB and unlock 1:1 DMs, defeating the set-once rule /profile enforces.
    db.prepare('UPDATE applicants SET dob = COALESCE(dob, ?) WHERE email = ?').run(dob, email);
    // Permanent attestation date for the two branches that grant the waiver (verified claim, either
    // existing-row or fresh-INSERT). The unverified branches grant no waiver, so they get no date.
    if (prefilledMatch) stampWaiver(email);
    db.prepare("UPDATE invites SET used = 1, used_at = datetime('now'), used_email = ? WHERE token = ?")
      .run(email, iv.token);
    // WIRING: a team invite creates an auto-renew team member — seat them on the
    // current run now (autoJoinTeam is rollover-gated in ensureWeek), so a claimed
    // team invite shows them seated the moment they land on check-in.
    if (isTeam) autoJoinTeam(nextRunDate());
    audit(iv.created_by, 'admin', `invite:claimed${iv.role ? ':' + iv.role : ''}${prefilledMatch ? '' : ':link'}`, `${full_name} <${email}>`);

    if (prefilledMatch) {
      // Pre-approved AND the address is proven (admin pre-filled it) — sign them in.
      signIn(res, email, 'invite claim');
      return res.redirect('/runs');
    }

    // No ownership proof — send a one-tap sign-in link to the submitted email and
    // show a friendly "check your email" page. No session is set here.
    const { url: link, code } = createLoginLink(req, email);
    let devLink = '', devCode = '';
    if (emailConfigured) {
      setImmediate(() => {
        sendMagicLink(email, link, code).catch(err =>
          console.error(`[invite] sign-in link send FAILED for ${email}: ${err.message}`));
      });
    } else {
      try {
        const result = await sendMagicLink(email, link, code);
        if (result.dev) { devLink = link; devCode = code; }
      } catch (e) { console.error(`[invite] dev-mail send failed for ${email}: ${e.message}`); }
    }
    return res.send(invitePage({ checkEmail: true, email, devLink, devCode }));
  });
}
