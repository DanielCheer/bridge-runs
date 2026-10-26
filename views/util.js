// views/util.js — the view layer's primitives: HTML escaping and the date/time labels pages print
// (weekday names, SQL UTC timestamps in server-local time, message day separators).

const esc = (s = '') => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Run-day labels — the app's "Friday"/"FRI" wording follows the actual run date. A
// YYYY-MM-DD is parsed at local noon (matches runLabelFor on the server) to avoid a
// timezone day-shift. Falls back to Friday/FRI when no date is supplied (pages with
// no run context, e.g. sign-in / apply — generic branding).
const _WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const _WDS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const wdayFull = (dateStr) => dateStr ? _WD[new Date(dateStr + 'T12:00:00').getDay()] : '';
const wdayShort = (dateStr) => dateStr ? _WDS[new Date(dateStr + 'T12:00:00').getDay()] : '';

// SQLite datetime('now') stores UTC as 'YYYY-MM-DD HH:MM:SS'. Render it in the
// server's local timezone (run the app on Eastern — see README ops notes).
const fmtWhen = (sqlUtc) => {
  if (!sqlUtc) return '';
  // Accept BOTH SQLite 'YYYY-MM-DD HH:MM:SS' (space) and ISO
  // 'YYYY-MM-DDTHH:MM:SS(.sss)Z' — normalise to a T-separated UTC string so Date
  // parses either the same way, instead of choking on an already-ISO value and
  // falling through to printing the raw string (the "raw ISO in the inbox" bug).
  const s = String(sqlUtc).trim().replace(' ', 'T').replace(/(\.\d+)?Z?$/, '') + 'Z';
  const d = new Date(s);
  if (isNaN(d)) return esc(String(sqlUtc));
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
};

// Month-year label from a YYYY-MM-DD (or SQL datetime) string.
const fmtMonthYear = (s) => {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T').slice(0, 19) + (String(s).length > 10 ? 'Z' : 'T12:00:00'));
  return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
};

// ---------- MESSAGES: day / clock helpers (SQL UTC → server-local) ----------
const _mDate = (sqlUtc) => new Date(String(sqlUtc).replace(' ', 'T') + 'Z');
const dayKey = (sqlUtc) => { const d = _mDate(sqlUtc); return isNaN(d) ? '' : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const fmtClock = (sqlUtc) => { const d = _mDate(sqlUtc); return isNaN(d) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); };
const fmtDay = (sqlUtc) => {
  const d = _mDate(sqlUtc);
  if (isNaN(d)) return '';
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startToday - startThat) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
};

export {
  esc, fmtWhen, wdayFull, wdayShort, fmtMonthYear, _mDate, dayKey, fmtClock, fmtDay,
};
