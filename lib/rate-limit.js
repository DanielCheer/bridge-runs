// lib/rate-limit.js — in-memory sliding-window rate limiting, keyed per bucket and per key.

// ---- in-memory rate limiter ----
// Guards the two unauthenticated POSTs (/login, /apply). /login fires a real
// Gmail send for any email typed in, so without this a loop could email-bomb an
// address and burn our ~500/day Gmail quota (locking out real sign-ins). Sliding
// window per key; buckets are plain Maps, fine for a single-process app at this
// scale. Pruned lazily on each hit so they don't grow unbounded.
const rlBuckets = new Map();
function rateLimited(bucket, key, limit, windowMs, now = Date.now()) {
  let m = rlBuckets.get(bucket);
  if (!m) { m = new Map(); rlBuckets.set(bucket, m); }
  const cutoff = now - windowMs;
  const hits = (m.get(key) || []).filter(t => t > cutoff);
  if (hits.length >= limit) { m.set(key, hits); return true; }
  hits.push(now);
  m.set(key, hits);
  return false;
}
// The lazy per-hit prune above only trims each key's timestamp array — it never
// removes the KEY itself, so a distinct email/IP that hits once leaves a permanent
// entry and rlBuckets grows unbounded over the process lifetime. Sweep every 15 min:
// drop keys whose newest hit is older than a generous window, then empty buckets.
setInterval(() => {
  const stale = Date.now() - 60 * 60 * 1000; // 1h ≥ every configured window
  for (const [bucket, m] of rlBuckets) {
    for (const [key, hits] of m) {
      if (!hits.length || hits[hits.length - 1] < stale) m.delete(key);
    }
    if (m.size === 0) rlBuckets.delete(bucket);
  }
}, 15 * 60 * 1000).unref(); // unref so the sweep never keeps the process alive

export {
  rateLimited,
};
