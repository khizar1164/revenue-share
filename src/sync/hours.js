/* Hours, read from the sheet Matthew pastes into.
 *
 * Agreed with Matthew Brown (payroll): he pulls weekly out of Connecteam after
 * correcting timesheets, and pastes name / week ending / hours into one tab. He
 * is already doing that pull for payroll, so this costs him nothing extra.
 *
 * We read, we never write to his tab. If he fixes a timesheet later he edits
 * the cell and the board follows on the next sync.
 *
 * Names are the weak point. Connecteam spells them its own way, and a name that
 * silently fails to match means someone quietly does not get paid — so anything
 * unmatched is reported loudly rather than skipped.
 */

import { query, withTransaction } from "../db.js";

export const HOURS_TAB = "Hours";
export const HOURS_HEADER = ["Employee", "Week ending", "Hours", "Notes"];

/* The month-end pull lives in its own tab rather than mixed in with the weeks.
   Two reasons: pasting a month total underneath the weekly rows would double
   the hours, and separating them means Matthew never has to remember which
   kind of row he is adding — the tab he is in decides it.

   A month here overrides the weeks for that month, the same rule the Drive
   version uses. It is the number the 75-hour gate is judged on. */
export const MONTH_TAB = "Hours Month End";
export const MONTH_HEADER = ["Employee", "Month", "Hours", "Notes"];

const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

/* Given names get shortened in both directions on a timesheet: Joshua Pama is
   "Josh P" in the review log, and someone typing "Daniel" may be looking for
   Dan. So a first name matches if either is a prefix of the other. */
const firstNameLike = (rosterFirst, queryFirst) =>
  rosterFirst === queryFirst ||
  rosterFirst.startsWith(queryFirst) ||
  queryFirst.startsWith(rosterFirst);

/**
 * Build a matcher over the current roster.
 *
 * The rule throughout is: match generously, but refuse when more than one
 * person fits. This roster has Josh Trim and Joshua Pama — "Josh" alone is
 * genuinely ambiguous, and guessing would pay the wrong man. Anything refused
 * comes back to a person to resolve, which is a nuisance; paying the wrong
 * person silently is worse.
 */
export function nameMatcher(roster) {
  const parts = roster.map(e => {
    const [first, ...rest] = norm(e.full_name).split(" ");
    return { e, first, last: rest.length ? rest[rest.length - 1] : "" };
  });

  return function match(name) {
    const n = norm(name);
    if (!n) return null;

    const exact = roster.find(e => norm(e.full_name) === n);
    if (exact) return exact;

    const byCode = roster.find(e => norm(e.code_name) === n);
    if (byCode) return byCode;

    const [nf, ...restQ] = n.split(" ");
    const nl = restQ.length ? restQ[restQ.length - 1] : "";

    if (nf && nl) {
      /* "Josh T" / "Joshua P" — first name loosely, surname by its initial */
      const hits = parts.filter(p =>
        firstNameLike(p.first, nf) && p.last && p.last[0] === nl[0]);
      if (hits.length === 1) return hits[0].e;
      if (hits.length > 1) return null;          // two people fit; do not guess
    }

    if (nf && !nl) {
      /* a bare first name only counts when exactly one person can be meant */
      const hits = parts.filter(p => firstNameLike(p.first, nf));
      if (hits.length === 1) return hits[0].e;
    }

    return null;
  };
}

/** Parse the tab's rows into { name, weekEnding, hours }. */
export function parseHoursRows(values) {
  if (!values.length) return { rows: [], skipped: 0 };
  const header = values[0].map(c => String(c ?? "").toLowerCase().trim());
  const looksLikeHeader = header.some(h => /employee|name/.test(h)) &&
                          header.some(h => /hour/.test(h));
  const body = looksLikeHeader ? values.slice(1) : values;

  const col = {
    name:  header.findIndex(h => /employee|name/.test(h)),
    week:  header.findIndex(h => /week|ending|date|month|period/.test(h)),
    hours: header.findIndex(h => /hour/.test(h))
  };
  if (!looksLikeHeader) { col.name = 0; col.week = 1; col.hours = 2; }
  if (col.hours < 0) col.hours = 2;
  if (col.name < 0) col.name = 0;

  const rows = [];
  let skipped = 0;
  for (const r of body) {
    const name = String(r[col.name] ?? "").trim();
    const rawHours = String(r[col.hours] ?? "").replace(/[^\d.]/g, "");
    const hours = Number(rawHours);
    if (!name || !rawHours || !Number.isFinite(hours) || hours < 0) { if (name || rawHours) skipped++; continue; }
    rows.push({
      name,
      weekEnding: col.week >= 0 ? String(r[col.week] ?? "").trim() : "",
      hours
    });
  }
  return { rows, skipped };
}

/* Sheets stores a date as a serial number counted from 1899-12-30, and hands it
   over that way when values are read unformatted. So "2026-09-07" arrives as
   46272, which Date() will happily read as the year 46272 — a silent way to
   file every row under the wrong month. */
const SHEETS_EPOCH = Date.UTC(1899, 11, 30);
const looksLikeSerial = n => Number.isFinite(n) && n > 20000 && n < 80000;

export function parseSheetDate(value) {
  if (value == null || value === "") return null;

  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (looksLikeSerial(n)) return new Date(SHEETS_EPOCH + Math.floor(n) * 86400000);

  const d = new Date(String(value).trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Which month does a week-ending date belong to? Falls back to the period. */
function monthOf(weekEnding, fallback) {
  const d = parseSheetDate(weekEnding);
  if (!d) return fallback;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * Read the tab and write hours into the database.
 *
 * Weekly rows for the same person in the same month are SUMMED — that is what
 * a weekly export means. Because the whole tab is re-read each time, the total
 * is rebuilt from scratch rather than added to, so correcting a cell in the
 * sheet corrects the total here instead of double-counting it.
 */
export async function importHours(google, spreadsheetId, { period, log = () => {} } = {}) {
  const values = await google.read(spreadsheetId, `${HOURS_TAB}!A1:D2000`, { raw: true });
  const { rows, skipped } = parseHoursRows(values);
  log(`read ${rows.length} weekly rows from ${HOURS_TAB}` +
      (skipped ? `, skipped ${skipped} unreadable` : ""));

  /* The month-end tab is optional — it only exists once someone has pasted a
     final pull into it, and a missing tab is not an error. */
  let monthRows = [];
  try {
    const mv = await google.read(spreadsheetId, `${MONTH_TAB}!A1:D2000`, { raw: true });
    monthRows = parseHoursRows(mv).rows;
    if (monthRows.length) log(`read ${monthRows.length} month-end rows from ${MONTH_TAB}`);
  } catch { /* tab not there yet */ }

  const roster = (await query(
    `select id, full_name, code_name from employees where status <> 'left' and is_mover`)).rows;
  const match = nameMatcher(roster);

  /* period -> employee -> summed hours */
  const totals = new Map();
  const unmatched = new Map();

  /* Months that have a final pull. Their weekly rows are ignored rather than
     added to, so a month total pasted after four weeks replaces them. */
  const closed = new Set();
  for (const r of monthRows) {
    const p = monthOf(r.weekEnding, period);
    if (p) closed.add(p);
  }
  if (closed.size) {
    log(`month-end figures present for ${[...closed].map(p => p.slice(0, 7)).join(", ")}` +
        ` — weekly rows for those months are ignored`);
  }

  /* `sum` is right for weekly rows — four weeks make a month. It is wrong for
     month-end rows: a month total is a single figure by definition, so two rows
     for the same person mean someone pasted twice, and adding them would double
     that person's hours. There the last row simply wins. */
  const add = (r, p, { sum = true } = {}) => {
    const emp = match(r.name);
    if (!emp) { unmatched.set(r.name, (unmatched.get(r.name) || 0) + r.hours); return; }
    if (period && p !== period) return;             // only the month we were asked for
    if (!totals.has(p)) totals.set(p, new Map());
    const m = totals.get(p);
    m.set(emp.id, sum ? (m.get(emp.id) || 0) + r.hours : r.hours);
  };

  /* A month-end row whose Month cell is a specific day is still that month —
     but a whole column of consecutive days is the signature of a fill-handle
     drag rather than a real paste, and that is worth saying out loud. */
  const monthDays = new Set(monthRows.map(r => {
    const d = parseSheetDate(r.weekEnding);
    return d ? d.toISOString().slice(0, 10) : null;
  }).filter(Boolean));
  const suspicious = monthRows.length >= 3 && monthDays.size >= monthRows.length - 1;

  for (const r of monthRows) add(r, monthOf(r.weekEnding, period), { sum: false });
  for (const r of rows) {
    const p = monthOf(r.weekEnding, period);
    if (closed.has(p)) continue;                    // superseded by the month-end pull
    add(r, p);
  }

  let written = 0;
  await withTransaction(async c => {
    for (const [p, byEmp] of totals) {
      for (const [employeeId, hours] of byEmp) {
        await c.query(
          `insert into hours (employee_id, period, hours, recorded_by)
           values ($1,$2,$3,'sheet')
           on conflict (employee_id, period) do update
             set hours = excluded.hours, updated_at = now(), recorded_by = 'sheet'`,
          [employeeId, p, Math.round(hours * 100) / 100]);
        written++;
      }
    }
  });

  const detail = {
    rowsRead: rows.length,
    monthRowsRead: monthRows.length,
    written,
    periods: [...totals.keys()],
    unmatched: [...unmatched.entries()].map(([name, hours]) => ({ name, hours })),
    rosterSize: roster.length,
    warnings: []
  };
  if (suspicious) {
    detail.warnings.push(
      `every row in ${MONTH_TAB} has a different date — that usually means the ` +
      `Month column was filled by dragging rather than typed. Check the figures ` +
      `before anyone is paid on them.`);
  }
  if (detail.unmatched.length) {
    log(`NOT MATCHED: ${detail.unmatched.map(u => u.name).join(", ")}`);
  }
  for (const w of detail.warnings) log(`WARNING: ${w}`);
  return detail;
}
