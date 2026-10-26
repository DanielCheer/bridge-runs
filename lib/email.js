// lib/email.js — the one gate between a typed address and the mailer.

// ---- email validation ----
// The ONLY gate between a typed address and nodemailer's `to:`/`bcc:`. An `includes('@')`
// check is not enough: nodemailer parses `to:` as an RFC-5322 ADDRESS LIST, so a string like
// "a@b.com, victim@x.org, …" is a hundred recipients in one field — a relay that also sails
// past the per-address rate limit (which keys on the whole string, so every list is a fresh
// bucket). Quoted/grouped/commented forms are refused for the same reason: what we validate
// must be what the mailer sends. Local part therefore excludes the list/group/comment/quote
// metacharacters entirely, and the domain must be dotted labels (so `@guest.local`
// placeholders still pass). Lengths are the RFC-5321 maximums.
const EMAIL_RE = /^[^\s@,;:<>"'\\()[\]]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const isValidEmail = (e) => typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e);

// An email normalized for comparison and as a key (trimmed, lower-case).
const lc = e => String(e || '').trim().toLowerCase();

export {
  isValidEmail, lc,
};
