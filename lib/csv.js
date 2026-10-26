// lib/csv.js — CSV cell encoding for the admin exports.

// RFC-4180 CSV cell with spreadsheet-formula-injection neutralized (shared by the exports).
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                    // a name like =HYPERLINK(...) can't run as a formula
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export {
  csvCell,
};
