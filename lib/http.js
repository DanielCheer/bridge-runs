// lib/http.js — the HTTP baseline every request passes through (security headers, compression,
// body and cookie parsing, the iOS form-POST redirect shim) and small request helpers.
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';

function clientIp(req) {
  // Behind ONE trusted proxy (Tailscale Funnel), the real client IP is the LAST hop the
  // proxy appended to X-Forwarded-For — NOT the first. Taking the first trusts a value the
  // client can inject (`X-Forwarded-For: 1.2.3.4`), letting an attacker rotate fake IPs past
  // the per-IP rate limits (the exact email-bomb / Gmail-quota-burn the limiter guards). The
  // last entry is the one Funnel set, so it can't be spoofed. Fall back to the socket peer.
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return (xff.length ? xff[xff.length - 1] : '') || req.socket.remoteAddress || 'unknown';
}
// Local-path guard for post-login redirects (blocks open-redirects like //evil.com).
function safeNextPath(next) {
  // Strict path allowlist: must start with a single "/" and contain ONLY URL-path-safe
  // characters. This blocks protocol-relative (`//evil`), backslash tricks, AND the
  // `"<>` that would otherwise let a crafted ?next= break out of the client-redirect shim.
  return (typeof next === 'string' && /^\/(?!\/)[A-Za-z0-9/_\-?=&.%#!:@~+]*$/.test(next)) ? next : '/runs';
}

export function mountHttpBasics(app) {
  app.disable('x-powered-by');
  // One proxy hop in front of us (Tailscale Funnel terminates TLS). This makes req.protocol/req.ip
  // reflect the real client, which the rate-limit bucketing and Secure-cookie semantics assume.
  app.set('trust proxy', 1);
  // Security headers (S2). No CSP yet — the app's inline scripts/handlers would need a full nonce
  // refactor, and a hollow 'unsafe-inline' policy is a false badge; do it properly or not at all.
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');                        // nothing here belongs in an iframe (clickjacking)
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');  // mic: voice notes
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');       // 180d; https-only (harness runs plain http)
    next();
  });
  // gzip every text response (HTML/CSS/JS/JSON). ~75% wire cut on the frequent
  // polling reloads. Placed before static so served assets are compressed too.
  app.use(compression());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  // iOS FIX: a standalone (Home-Screen) PWA renders a BLANK page when a *native form*
  // POST responds with a 302 redirect — a long-standing WebKit bug. For non-AJAX POSTs
  // only, emit a 200 that redirects on the CLIENT (JS + meta-refresh) instead of a 302.
  // AJAX POSTs (they send X-Requested-With: fetch — check-in actions, chat, etc.) keep
  // the real 302 so their `.then(r => r.text())` handlers still follow it and swap in place.
  app.use((req, res, next) => {
    if (req.method === 'POST' && (req.headers['x-requested-with'] || '') !== 'fetch') {
      res.redirect = (arg1, arg2) => {
        const dest = String(arg2 !== undefined ? arg2 : arg1);
        res.set('Cache-Control', 'no-store');
        // Defense-in-depth: %-encode "<> in the meta URL and < the JSON string so a
        // redirect target can never break out of the attribute OR the </script> boundary.
        const metaDest = dest.replace(/[<>"]/g, c => ({ '<': '%3C', '>': '%3E', '"': '%22' }[c]));
        res.status(200).type('html').send(
          `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${metaDest}">`
          + `<script>location.replace(${JSON.stringify(dest).replace(/</g, '\\u003C')})</script>`);
      };
    }
    next();
  });
}

export {
  clientIp, safeNextPath,
};
