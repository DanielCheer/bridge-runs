// lib/settings.js — app_settings, the key/value table for runtime configuration an admin edits in
// the app (run caps, season dates, door mode, kiosk tokens, Planning Center state). One copy of the
// accessors for every module.
import db from '../db.js';

// Hoisted — settings sit on the hottest path (seasonStart/pkSeasonStart inside nextRunDate,
// chat_seq every /poll tick, bumpChatSeq on every send). node:sqlite has no stmt cache, so
// re-preparing per call recompiles the SQL each time; prepare once, reuse.
const stmtGetSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const stmtSetSetting = db.prepare('INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)');
const stmtDelSetting = db.prepare('DELETE FROM app_settings WHERE key = ?');
const getSetting = (k) => stmtGetSetting.get(k)?.value;
const setSetting = (k, v) => stmtSetSetting.run(k, String(v));
const delSetting = (k) => stmtDelSetting.run(k);

export {
  getSetting, setSetting, delSetting,
};
