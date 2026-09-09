/* Hours from Matthew's weekly Connecteam exports.
 *
 * He does not paste into a standing tab — Connecteam produces a fresh
 * spreadsheet each week, named for the week it covers:
 *
 *     Movers_Hours_2026-09-07_2026-09-13
 *     Full name | Hours Worked | Regular | Overtime | Holiday | Sick | Vacation | Tips | Mileage
 *
 * That is a better fit for how he actually works — he is already generating
 * these for payroll — so we read them where they are rather than asking him to
 * copy anything. The week is taken from the file's own name, since there is no
 * date column inside.
 *
 * "Hours Worked" is the total across every category. Matthew's rule: "All hours
 * apply toward that after I correct their time sheets."
 */

import { query, withTransaction } from "../db.js";
import { nameMatcher } from "./hours.js";

export const FILE_PREFIX = "Movers_Hours_";

/** Movers_Hours_2026-09-07_2026-09-13 -> { from, to } as Dates, or null. */
export function weekFromTitle(title) {
  const m = String(title).match(/(\d{4})-(\d{2})-(\d{2})[_ ]+(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const from = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const to   = new Date(Date.UTC(+m[4], +m[5] - 1, +m[6]));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return null;
  return { from, to };
}

const periodOf = d =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;

const lastDayOfMonth = d =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

/**
 * Is this range exactly one calendar month?
 *
 * Andrew confirmed Connecteam can pull by date, so month-end brings a file
 * covering the 1st to the last — and that is the number the 75-hour gate should
 * be judged on, not a sum of weeks that spill over the edges. A full-month file
 * therefore replaces the weeklies for its month rather than adding to them.
 */
export function isFullMonth({ from, to }) {
  return from.getUTCDate() === 1 &&
         from.getUTCFullYear() === to.getUTCFullYear() &&
         from.getUTCMonth() === to.getUTCMonth() &&
         to.getUTCDate() === lastDayOfMonth(to);
}

/**
 * How a week's hours divide between months.
 *
 * A payroll week does not respect month boundaries — 28 Sept to 4 Oct is three
 * days of one month and four of the next. We only have a weekly total, never a
 * daily breakdown, so the hours are split in proportion to the days falling in
 * each month. It is an approximation, and the only alternative with this data
 * would be to push a whole week into one month, which is a bigger one.
 *
 * Returns [{ period, share }] with shares summing to 1.
 */
export function splitWeekAcrossMonths({ from, to }) {
  const days = new Map();
  for (let t = from.getTime(); t <= to.getTime(); t += 86400000) {
    const p = periodOf(new Date(t));
    days.set(p, (days.get(p) || 0) + 1);
  }
  const total = [...days.values()].reduce((a, n) => a + n, 0) || 1;
  return [...days.entries()].map(([period, n]) => ({ period, share: n / total, days: n }));
}

/** Read one weekly export into { name, hours } rows. */
export async function readWeeklyFile(google, fileId) {
  const info = await google.info(fileId);
  const tab = info.tabs[0];
  if (!tab) throw new Error(`${info.title} has no tabs`);

  const values = await google.read(fileId, `${tab.title}!A1:M500`, { raw: true });
  if (!values.length) return { title: info.title, week: weekFromTitle(info.title), rows: [] };

  const header = values[0].map(c => String(c ?? "").toLowerCase().trim());
  const nameCol  = header.findIndex(h => /full name|employee|name/.test(h));
  const hoursCol = header.findIndex(h => /hours worked/.test(h));
  const anyHours = hoursCol >= 0 ? hoursCol : header.findIndex(h => /hour/.test(h));

  if (nameCol < 0 || anyHours < 0) {
    throw new Error(`${info.title}: could not find a name and an hours column ` +
                    `(saw: ${header.filter(Boolean).join(", ")})`);
  }

  const rows = [];
  for (const r of values.slice(1)) {
    const name = String(r[nameCol] ?? "").trim();
    if (!name) continue;
    const raw = r[anyHours];
    const hours = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/[^\d.]/g, ""));
    /* a blank cell means the person simply did not work that week — that is
       zero, not a parse failure, and it should not be mistaken for one */
    rows.push({ name, hours: Number.isFinite(hours) ? hours : 0 });
  }

  return { title: info.title, week: weekFromTitle(info.title), rows };
}

/**
 * Find every weekly export, read them all, and rebuild each month's totals.
 *
 * Totals are rebuilt from the full set of files rather than added to, so a
 * corrected timesheet in an old week fixes the month instead of double-counting.
 */
export async function importWeeklyHours(google, {
  folderId, prefix = FILE_PREFIX, period, log = () => {}
} = {}) {
  const files = await google.listSpreadsheets({ folderId, namePrefix: prefix, limit: 200 });
  log(`found ${files.length} weekly export${files.length === 1 ? "" : "s"}`);
  if (!files.length) {
    return { files: 0, written: 0, rowsRead: 0, unmatched: [], weeks: [], skipped: [] };
  }

  const roster = (await query(
    `select id, full_name, code_name from employees where status <> 'left' and is_mover`)).rows;
  const match = nameMatcher(roster);

  /* Work out which months have an authoritative full-month export before
     reading anything, so the weeklies for those months can be left alone.
     Newest wins if a month was pulled more than once. */
  const authoritative = new Map();   // period -> { id, name, modifiedTime }
  const ranges = new Map();          // fileId -> week range
  for (const f of files) {
    const range = weekFromTitle(f.name);
    if (!range) continue;
    ranges.set(f.id, range);
    if (!isFullMonth(range)) continue;
    const p = periodOf(range.from);
    const prev = authoritative.get(p);
    if (!prev || String(f.modifiedTime) > String(prev.modifiedTime)) {
      authoritative.set(p, { id: f.id, name: f.name, modifiedTime: f.modifiedTime });
    }
  }
  if (authoritative.size) {
    log(`month-end exports found for ${[...authoritative.keys()].map(p => p.slice(0, 7)).join(", ")}` +
        ` — these replace the weekly files for those months`);
  }

  const totals = new Map();        // period -> employeeId -> hours
  const unmatched = new Map();
  const weeks = [], skipped = [];
  let rowsRead = 0;

  for (const f of files) {
    const range = ranges.get(f.id);
    if (!range) { skipped.push({ name: f.name, why: "no date range in the file name" }); continue; }

    const parts = splitWeekAcrossMonths(range);

    /* A weekly file is ignored for any month that has a full-month export.
       It may still count toward its other month — the week of 28 Sept to
       4 Oct is superseded for September but not for October. */
    const contributes = parts.filter(p => {
      const auth = authoritative.get(p.period);
      return !auth || auth.id === f.id;
    });
    if (!contributes.length) {
      skipped.push({ name: f.name, why: "superseded by the month-end export" });
      continue;
    }
    if (period && !contributes.some(p => p.period === period)) continue;

    let file;
    try { file = await readWeeklyFile(google, f.id); }
    catch (e) { skipped.push({ name: f.name, why: e.message }); continue; }
    if (!file.week) { skipped.push({ name: f.name, why: "no date range inside" }); continue; }

    const whole = isFullMonth(range);
    rowsRead += file.rows.length;
    weeks.push({
      title: file.title,
      kind: whole ? "month" : "week",
      from: range.from.toISOString().slice(0, 10),
      to: range.to.toISOString().slice(0, 10),
      months: contributes.map(p => `${p.period.slice(0, 7)} (${p.days}d)`),
      people: file.rows.length,
      hours: Math.round(file.rows.reduce((a, r) => a + r.hours, 0) * 100) / 100
    });

    for (const row of file.rows) {
      const emp = match(row.name);
      if (!emp) { unmatched.set(row.name, (unmatched.get(row.name) || 0) + row.hours); continue; }
      for (const part of contributes) {
        if (period && part.period !== period) continue;
        /* a full-month file is not apportioned — it already is the month */
        const share = whole ? 1 : part.share;
        if (!totals.has(part.period)) totals.set(part.period, new Map());
        const m = totals.get(part.period);
        m.set(emp.id, (m.get(emp.id) || 0) + row.hours * share);
      }
    }
  }

  let written = 0;
  await withTransaction(async c => {
    for (const [p, byEmp] of totals) {
      for (const [employeeId, hours] of byEmp) {
        await c.query(
          `insert into hours (employee_id, period, hours, recorded_by)
           values ($1,$2,$3,'connecteam')
           on conflict (employee_id, period) do update
             set hours = excluded.hours, updated_at = now(), recorded_by = 'connecteam'`,
          [employeeId, p, Math.round(hours * 100) / 100]);
        written++;
      }
    }
  });

  const result = {
    files: files.length, rowsRead, written,
    periods: [...totals.keys()],
    weeks, skipped,
    unmatched: [...unmatched.entries()].map(([name, hours]) => ({ name, hours }))
  };
  if (result.unmatched.length) log(`NOT MATCHED: ${result.unmatched.map(u => u.name).join(", ")}`);
  if (result.skipped.length) log(`skipped: ${result.skipped.map(s => s.name).join(", ")}`);
  return result;
}
