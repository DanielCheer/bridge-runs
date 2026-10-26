// lib/at-rest-crypto.js — the one at-rest encryption scheme in the app (AES-256-GCM, key derived
// from SESSION_SECRET with HKDF). Direct-message bodies (lib/dm-crypto.js) and the secrets in
// app_settings (lib/settings.js) each derive their own key from it with a different salt.
//
// Stored format: 'enc1:' + base64(iv[12] | tag[16] | ciphertext). No key material sits in the
// database it protects, and there is no new secret to manage. The flip side: rotating
// SESSION_SECRET makes every value sealed under the old secret unreadable (see docs/SECURITY.md).
import crypto from 'node:crypto';
import { AT_REST_KEY_SECRET } from '../config.js';

const PREFIX = 'enc1:';

// True when `stored` is a sealed value (as opposed to legacy plaintext).
export const isSealed = (stored) => typeof stored === 'string' && stored.startsWith(PREFIX);

// A sealer bound to one HKDF salt/info pair. open() throws on a tampered value or the wrong key;
// each caller decides what that means for its data.
export function atRestCipher(salt, info) {
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(AT_REST_KEY_SECRET), Buffer.from(salt), Buffer.from(info), 32));
  return {
    seal(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    },
    open(stored) {
      const buf = Buffer.from(String(stored).slice(PREFIX.length), 'base64');
      const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    },
  };
}
