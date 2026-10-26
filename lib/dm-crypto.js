// lib/dm-crypto.js — at-rest encryption for direct-message bodies, on the shared scheme in
// lib/at-rest-crypto.js.
import { atRestCipher, isSealed } from './at-rest-crypto.js';

// ---------- DM at-rest encryption ----------
// Direct-message bodies are encrypted at rest so a leaked DB file / off-site backup does not spill
// people's private conversations in plaintext. Legacy plaintext rows (pre-encryption) stay
// readable: dmDec passes through anything without the `enc1:` marker, and empty bodies
// (sticker/photo-only rows) are never encrypted. This is at-rest privacy, NOT end-to-end: the
// host process can derive the key, so there is no admin-facing surface that reads DMs (that is
// deliberate), but the operator is not cryptographically locked out — see docs/SECURITY.md.
const DM = atRestCipher('bridge-dm-atrest', 'dm-body-v1');
function dmEnc(text) {
  if (!text) return text || '';                    // '' / null → store as-is (no empty ciphertext)
  return DM.seal(text);
}
function dmDec(stored) {
  if (!isSealed(stored)) return stored;            // legacy plaintext / non-string
  try { return DM.open(stored); }
  catch { return ''; }                             // tamper / wrong key → empty, never crash the thread
}

export {
  dmDec, dmEnc,
};
