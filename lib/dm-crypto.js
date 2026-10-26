// lib/dm-crypto.js — at-rest encryption for direct-message bodies (AES-256-GCM, key derived from
// the session secret).
import crypto from 'crypto';
import { DM_KEY_SECRET } from '../config.js';

// ---------- DM at-rest encryption ----------
// Direct-message bodies are encrypted at rest (AES-256-GCM) so a leaked DB file / off-site
// backup does not spill people's private conversations in plaintext. The key is derived from
// SESSION_SECRET (already mandatory + fail-loud in auth.js) via HKDF — no new secret to manage,
// and no key material sits inside the DB it protects. Legacy plaintext rows (pre-encryption)
// stay readable: dmDec passes through anything without the `enc1:` marker, and empty bodies
// (sticker/photo-only rows) are never encrypted. This is at-rest privacy, NOT end-to-end: the
// host process can derive the key, so there is no admin-facing surface that reads DMs (that is
// deliberate), but the operator is not cryptographically locked out — see SECURITY-OVERVIEW.
const DM_KEY = crypto.hkdfSync('sha256',
  Buffer.from(DM_KEY_SECRET),
  Buffer.from('bridge-dm-atrest'), Buffer.from('dm-body-v1'), 32);
function dmEnc(text) {
  if (!text) return text || '';                    // '' / null → store as-is (no empty ciphertext)
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(DM_KEY), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'enc1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function dmDec(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('enc1:')) return stored; // legacy plaintext / non-string
  try {
    const buf = Buffer.from(stored.slice(5), 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(DM_KEY), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return ''; }                             // tamper / wrong key → empty, never crash the thread
}

export {
  dmDec, dmEnc,
};
