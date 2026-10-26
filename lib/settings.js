// lib/settings.js — app_settings, the key/value table for runtime configuration an admin edits in
// the app (run caps, season dates, door mode, kiosk tokens, Planning Center state). One copy of the
// accessors for every module.
import db from '../db.js';
import { atRestCipher, isSealed } from './at-rest-crypto.js';

// Hoisted — settings sit on the hottest path (seasonStart/pkSeasonStart inside nextRunDate,
// chat_seq every /poll tick, bumpChatSeq on every send). node:sqlite has no stmt cache, so
// re-preparing per call recompiles the SQL each time; prepare once, reuse.
const stmtGetSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const stmtSetSetting = db.prepare('INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)');
const stmtDelSetting = db.prepare('DELETE FROM app_settings WHERE key = ?');

// ---------- Secrets at rest ----------
// Credentials an admin pastes in at runtime (and the VAPID private key the app generates) live in
// app_settings, so they ride every backup and every copy of the database. They are stored sealed
// ('enc1:', AES-256-GCM under a key HKDF-derived from SESSION_SECRET, salt 'bridge-settings-atrest')
// and are only reachable through getSecret / setSecret: getSetting / setSetting refuse these keys,
// so a new caller can't read or write one in plaintext by accident.
const SECRET_KEYS = new Set([
  'vapid_private',
  'pco_secret', 'pco_oauth_client_secret', 'pco_oauth_access', 'pco_oauth_refresh', 'pco_webhook_secret',
]);
const SEALER = atRestCipher('bridge-settings-atrest', 'settings-v1');
function assertPlainKey(k) {
  if (SECRET_KEYS.has(k)) throw new Error(`app_settings '${k}' is a secret: use getSecret / setSecret`);
}

const getSetting = (k) => { assertPlainKey(k); return stmtGetSetting.get(k)?.value; };
const setSetting = (k, v) => { assertPlainKey(k); return stmtSetSetting.run(k, String(v)); };
const delSetting = (k) => stmtDelSetting.run(k);

const warnedUnreadable = new Set();
// The plaintext of a secret, or undefined when unset. A legacy plaintext value (stored before
// secrets were sealed) is returned and rewritten sealed on the spot. A value that no longer opens
// (SESSION_SECRET was rotated, or the row was tampered with) is treated as unset, so every caller
// fails closed exactly as if it had never been configured (no Planning Center calls, the webhook
// answers 503, a fresh VAPID keypair), and the log says which key needs re-entering.
function getSecret(k) {
  if (!SECRET_KEYS.has(k)) throw new Error(`app_settings '${k}' is not a secret: use getSetting`);
  const stored = stmtGetSetting.get(k)?.value;
  if (stored == null || stored === '') return undefined;
  if (!isSealed(stored)) { stmtSetSetting.run(k, SEALER.seal(stored)); return stored; }
  try { return SEALER.open(stored); } catch {
    if (!warnedUnreadable.has(k)) {
      warnedUnreadable.add(k);
      console.error(`[settings] secret '${k}' can't be decrypted (was SESSION_SECRET rotated?); treating it as unset until it is entered again`);
    }
    return undefined;
  }
}
function setSecret(k, v) {
  if (!SECRET_KEYS.has(k)) throw new Error(`app_settings '${k}' is not a secret: use setSetting`);
  warnedUnreadable.delete(k);
  return stmtSetSetting.run(k, SEALER.seal(String(v)));
}

export {
  getSetting, setSetting, delSetting, getSecret, setSecret,
};
