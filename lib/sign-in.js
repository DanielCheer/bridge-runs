// lib/sign-in.js — the real sign-in sites' shared steps: minting a magic link + code, and issuing
// the session (with an admin's own devices pinged on every admin sign-in).
import crypto from 'crypto';
import db from '../db.js';
import { PUBLIC_URL } from '../config.js';
import { setSession, isAdmin } from '../auth.js';
import { audit } from './audit.js';
import { sendPush } from './push.js';

// Sign-in wrapper for the REAL login sites (magic link, code, invite claim, offer-claim sign-in) —
// NOT the per-request cookie refresh or the profile email re-sign. An admin account signing in
// anywhere pings that admin's own devices: with sessions this long-lived, "someone else logged in
// as me" must be visible in seconds, not discovered by accident.
function signIn(res, email, how) {
  setSession(res, email);
  if (isAdmin(email)) {
    audit(email, 'admin', 'session:admin-login', how);
    setImmediate(() => sendPush([String(email).toLowerCase()], {
      title: 'Admin sign-in',
      body: `Your admin account just signed in (${how}). Wasn't you? Profile → Sign out everywhere.`,
      url: '/profile', tag: 'adminlogin',
    }));
  }
}

// Issue a fresh single-use magic sign-in link for an email: invalidate any older
// unused tokens (so a resend always leaves exactly one valid link), store the new
// one, and return the full /auth URL. Shared by the /login flow AND the invite
// claim flow (when an invite can't prove ownership of the submitted email, we send
// a link instead of silently signing them in).
// Returns { url, code }: a magic-link URL (for browser/desktop) AND a 6-digit code
// (for signing in INSIDE the installed app). Both live on the same row and are
// invalidated together — a resend always leaves exactly one valid credential pair.
function createLoginLink(req, email, next = '/checkin') {
  const token = crypto.randomBytes(24).toString('base64url');
  const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  const expires = Date.now() + 15 * 60 * 1000;
  db.prepare('UPDATE login_tokens SET used = 1 WHERE email = ? AND used = 0').run(email);
  db.prepare('INSERT INTO login_tokens (token,email,expires_at,code) VALUES (?,?,?,?)').run(token, email, expires, code);
  const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return { url: `${base}/auth?token=${token}&next=${encodeURIComponent(next)}`, code };
}

export {
  createLoginLink, signIn,
};
