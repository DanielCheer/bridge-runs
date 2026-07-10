// auth.js — signed-cookie sessions + route guards.
import crypto from 'crypto';

// Fail loud if the session secret is missing: a public/known secret lets anyone forge an
// admin cookie. Better a hard boot failure than a silent takeover risk. The only escape
// hatch is an explicit dev opt-in (ALLOW_INSECURE_SESSION=1) for throwaway local runs.
if (!process.env.SESSION_SECRET && process.env.ALLOW_INSECURE_SESSION !== '1') {
  throw new Error('SESSION_SECRET is required (set it in .env). Set ALLOW_INSECURE_SESSION=1 only for throwaway local dev.');
}
const SECRET = process.env.SESSION_SECRET || 'CHANGE_ME_dev_secret_do_not_ship';
const COOKIE = 'bridge_session';

// admin emails come from env, comma-separated
const ADMINS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function sign(value) {
  const mac = crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
  return `${value}.${mac}`;
}
function verify(signed) {
  if (!signed || !signed.includes('.')) return null;
  const i = signed.lastIndexOf('.');
  const value = signed.slice(0, i);
  const mac = signed.slice(i + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
  // constant-time compare
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value; // the email
}

export function setSession(res, email) {
  res.cookie(COOKIE, sign(email.toLowerCase()), {
    httpOnly: true,                         // no JS access → XSS can't read the session
    sameSite: 'lax',                        // CSRF guard; 'lax' still lets the emailed magic link log you in
    // The app is served exclusively over HTTPS (Tailscale Funnel), so the session cookie
    // is always Secure — it never travels over plaintext. localhost is a secure context
    // too, so local browser testing still works. Previously this keyed off NODE_ENV,
    // which isn't set in this deployment, so the flag was silently OFF. Set
    // COOKIE_INSECURE=1 ONLY if you ever serve plain HTTP over a LAN IP for dev.
    secure: process.env.COOKIE_INSECURE !== '1',
    maxAge: 1000 * 60 * 60 * 24 * 365 * 10, // ~10 years — effectively forever; players
    // never have to re-auth. It's a stateless signed cookie (no server store), so it
    // simply persists; the only way out is the Sign Out link. Server-set HttpOnly, so
    // iOS ITP's 7-day script-storage cap doesn't apply.
  });
}
export function clearSession(res) { res.clearCookie(COOKIE); }

export function currentUser(req) {
  return verify(req.cookies?.[COOKIE]) || null;
}
export function isAdmin(email) {
  return !!email && ADMINS.includes(email.toLowerCase());
}

export function requireLogin(req, res, next) {
  const email = currentUser(req);
  if (!email) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  req.userEmail = email;
  next();
}
export function requireAdmin(req, res, next) {
  const email = currentUser(req);
  if (!isAdmin(email)) return res.status(403).send('Not authorized.');
  req.userEmail = email;
  next();
}

// Approvers = admins OR logged-in team members. Team membership is checked
// against the DB at request time, so a cookie alone can't spoof it.
export function makeRequireApprover(db) {
  return function requireApprover(req, res, next) {
    const email = currentUser(req);
    if (!email) return res.status(403).send('Sign in first.');
    if (isAdmin(email)) { req.userEmail = email; req.actorRole = 'admin'; return next(); }
    const row = db.prepare('SELECT is_team FROM applicants WHERE email = ?').get(email);
    if (row && row.is_team) { req.userEmail = email; req.actorRole = 'team'; return next(); }
    return res.status(403).send('Approver access only. Ask an organizer.');
  };
}

export { ADMINS };
