// routes/auth.js — signing in and out: the magic link and 6-digit code (/login, /auth,
// /login/code), /logout, and /status, which routes a signed-in person by account state.
import crypto from 'crypto';
import db from '../db.js';
import { sendMagicLink, emailConfigured } from '../mailer.js';
import { currentUser, clearSession, isAdmin, requireLogin } from '../auth.js';
import { loginPage, confirmActionPage, logoutPage, statusPage } from '../views.js';
import { isValidEmail } from '../lib/email.js';
import { rateLimited } from '../lib/rate-limit.js';
import { safeNextPath, clientIp } from '../lib/http.js';
import { createLoginLink, signIn } from '../lib/sign-in.js';
import { applicantByEmail } from '../engine/applicants.js';

export function mountAuth(app) {
  // ---------- LOGIN (magic link) ----------
  app.get('/login', (req, res) => {
    if (currentUser(req)) return res.redirect(safeNextPath(req.query.next));
    // `msg` is a benign notice (e.g. "signed out on every device") — rendered via the page's
    // error slot, which is escaped in the view.
    res.send(loginPage({ next: req.query.next || '', error: String(req.query.msg || '') }));
  });

  app.post('/login', async (req, res) => {
    const em = String(req.body.email || '').trim().toLowerCase();
    const next = req.body.next || '/runs';
    if (!isValidEmail(em)) return res.send(loginPage({ error: 'Enter a valid email.' }));

    // Throttle magic-link sends: at most 3 per address / 5 min (stops bombing one
    // inbox) and 20 per IP / 10 min (stops cycling through many addresses). Both
    // protect our Gmail daily quota.
    if (rateLimited('login-email', em, 3, 5 * 60 * 1000) ||
        rateLimited('login-ip', clientIp(req), 20, 10 * 60 * 1000)) {
      return res.send(loginPage({ next,
        error: 'You’ve requested a few links already — check your inbox (and spam), then wait a minute before trying again.' }));
    }

    // Requesting a new link invalidates any older unused ones for this email, so a
    // "resend" always leaves exactly one valid link + code.
    const { url: link, code } = createLoginLink(req, em, next);

    if (emailConfigured) {
      // Don't make the player wait on the email — respond instantly, then send on
      // the next tick so even nodemailer's synchronous MIME/TLS setup happens
      // AFTER the response is flushed. A failure is logged loudly here; the "check
      // your email" page tells them how to request a fresh link.
      res.send(loginPage({ sent: true, email: em, next }));
      setImmediate(() => {
        sendMagicLink(em, link, code).catch(err =>
          console.error(`[login] magic-link send FAILED for ${em}: ${err.message}`));
      });
      return;
    } else {
      // Dev mode: no SMTP configured — the "send" just returns the link + code to show.
      const result = await sendMagicLink(em, link, code);
      res.send(loginPage({ sent: true, email: em, next, devLink: result.dev ? link : '', devCode: result.dev ? code : '' }));
    }
  });

  // GET renders a confirm page that auto-submits — it does NOT consume the token, so an
  // email security scanner's bare GET (Outlook SafeLinks etc.) can't burn the sign-in link
  // + code before the person taps it. The POST does the actual single-use consume + sign-in.
  app.get('/auth', (req, res) => {
    const { token, next } = req.query;
    const row = db.prepare('SELECT * FROM login_tokens WHERE token = ?').get(token || '');
    if (!row || row.used || row.expires_at < Date.now()) {
      return res.send(loginPage({ next: next || '',
        error: 'That link is expired or already used — enter your email to get a fresh one. Use the same email you applied with.' }));
    }
    return res.send(confirmActionPage({
      title: 'Signing in', heading: 'Tap to sign in', sub: 'One tap finishes signing you in to The Bridge Adv Runs.',
      action: '/auth', fields: { token, next: next || '' }, button: 'Sign in →',
    }));
  });
  app.post('/auth', (req, res) => {
    const { token, next } = req.body;
    const row = db.prepare('SELECT * FROM login_tokens WHERE token = ?').get(token || '');
    if (!row || row.used || row.expires_at < Date.now()) {
      return res.send(loginPage({ next: next || '',
        error: 'That link is expired or already used — enter your email to get a fresh one. Use the same email you applied with.' }));
    }
    db.prepare('UPDATE login_tokens SET used = 1 WHERE token = ?').run(token);
    signIn(res, row.email, 'magic link');
    res.redirect(safeNextPath(next));
  });

  // Sign in with the 6-digit code from the email — the path that works INSIDE the
  // installed app (an emailed link would open Safari, a separate storage jar). Same
  // single-use credential row as the magic link; brute force is capped by attempts +
  // rate limits, and the error is identical for wrong/expired/no-code so membership
  // and pending-code state never leak.
  app.post('/login/code', (req, res) => {
    const em = String(req.body.email || '').trim().toLowerCase();
    const codeIn = String(req.body.code || '').replace(/\D/g, '');
    const next = req.body.next || '/runs';
    const fail = (msg) => res.send(loginPage({ sent: true, email: em, next, codeError: msg }));

    if (rateLimited('login-code', em, 10, 10 * 60 * 1000) ||
        rateLimited('login-code-ip', clientIp(req), 30, 10 * 60 * 1000))
      return fail('Too many tries — wait a few minutes, or request a fresh code.');
    if (codeIn.length !== 6) return fail('Enter the 6-digit code from your email.');

    const row = db.prepare('SELECT * FROM login_tokens WHERE email = ? AND used = 0 AND expires_at > ? ORDER BY rowid DESC LIMIT 1')
      .get(em, Date.now());
    const GENERIC = 'That code didn’t match or has expired — request a fresh one.';
    if (!row || !row.code) return fail(GENERIC);
    if (row.attempts >= 5) { db.prepare('UPDATE login_tokens SET used = 1 WHERE token = ?').run(row.token); return fail(GENERIC); }

    const a = Buffer.from(codeIn), b = Buffer.from(String(row.code));
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!match) { db.prepare('UPDATE login_tokens SET attempts = attempts + 1 WHERE token = ?').run(row.token); return fail(GENERIC); }

    db.prepare('UPDATE login_tokens SET used = 1 WHERE token = ?').run(row.token);
    signIn(res, em, 'sign-in code');
    res.redirect(safeNextPath(next));
  });

  // GET renders a confirm page only (no state change) so a prefetch / <img src>/CSRF
  // GET can't sign anyone out; POST does the actual clear. The client-side handler in
  // HEAD intercepts "Sign out" links and posts directly for a seamless one-tap flow.
  app.get('/logout', (req, res) => { res.send(logoutPage()); });
  app.post('/logout', (req, res) => { clearSession(res); res.redirect('/'); });
}

export function mountStatus(app) {
  // Minimal status page for players who aren't approved (no check-in chrome).
  app.get('/status', requireLogin, (req, res) => {
    const a = applicantByEmail(req.userEmail);
    const status = a?.status || 'none';
    if (isAdmin(req.userEmail) || status === 'approved') return res.redirect('/runs');
    res.send(statusPage({ email: req.userEmail, status }));
  });
}
