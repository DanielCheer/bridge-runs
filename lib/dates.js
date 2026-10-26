// lib/dates.js — local-calendar helpers (YYYY-MM-DD in server-local time, weekday names, clock
// labels) and schedNow(), the scheduler's clock, which TEST_NOW pins in tests.
import { TEST_NOW } from '../config.js';

// "T17:00:00" — the local-time suffix for an hour. Shared by both programs' schedules.
const hhLocal = h => `T${String(h).padStart(2, '0')}:00:00`;
// Test seam: TEST_NOW (config.js) overrides "now" for the auto-scheduler so its clock phases (auto
// open/ping/lock) are drivable in tests. Unset in prod → real Date.now(). Precedent: FORCE_HELD_RELEASED.
function schedNow() { return TEST_NOW != null ? TEST_NOW : Date.now(); }
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];  // dow → standing-day label
function runLabelFor(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
// "7 PM" / "7:30 PM" from HH:MM.
function fmtClockLabel(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM', h12 = ((h + 11) % 12) + 1;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ap}` : `${h12} ${ap}`;
}
// "7–10 PM" (drops the shared AM/PM on the start when it matches the end); the tip-off
// time alone as "7 PM". Used in the masthead + move announcement.
// "6–8 PM" from two HH:MM strings. Shared by both programs — basketball resolves its window
// from per-week overrides, pickleball derives it from PK_START_H/PK_END_H.
function fmtClockRange(start, end) {
  const s = fmtClockLabel(start), e = fmtClockLabel(end);
  const sap = s.slice(-2), eap = e.slice(-2);
  return sap === eap ? `${s.slice(0, -3)}–${e}` : `${s}–${e}`;
}
// Shift a local YYYY-MM-DD by whole days (DST-safe: anchored at local noon so a ±1h
// DST shift never crosses a calendar day). Returns local YYYY-MM-DD.
function shiftYmd(ymdStr, days) {
  const r = new Date(ymdStr + 'T12:00:00');
  r.setDate(r.getDate() + days);
  return ymdLocal(r);
}
// Dynamic day labels — the whole app's "Friday" wording follows the actual run day.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_SHORT = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
function runWeekday(dateStr) { return WEEKDAYS[new Date(dateStr + 'T12:00:00').getDay()]; }
function runWeekdayShort(dateStr) { return WEEKDAYS_SHORT[new Date(dateStr + 'T12:00:00').getDay()]; }
// Local YYYY-MM-DD (matches nextRunDefault's local-parts formatting).
function ymdLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export {
  ymdLocal, shiftYmd, fmtClockRange, fmtClockLabel, schedNow, runLabelFor, runWeekday, hhLocal,
  DAY_NAMES,
};
