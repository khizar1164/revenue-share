/* The Review Log spreadsheet → logged reviews.
 *
 * Nicole has kept this sheet for years: a tab per year, a block per month, and
 * inside a block one row per review — job number, source, customer, date, then
 * a column per person with the credit in it. The credit is 1, or 3 when the
 * review has a photo, which is the rule the share already uses.
 *
 * A customer who leaves the same review on two platforms gets a row each, and
 * both count: the "Review Count" column only marks the first, to count
 * customers rather than reviews.
 *
 * Like the tardy log, the month is rebuilt on every run, so correcting the
 * sheet corrects the board. Reviews typed into the admin panel are left alone —
 * only rows this importer wrote are replaced.
 */

import { withTransaction } from "../db.js";
import { matchableRoster } from "../roster.js";
import { nameMatcher } from "./hours.js";

export const TAG = "review-log";

const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY",
                "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
const text = v => String(v ?? "").trim();
const pad = n => String(n).padStart(2, "0");

/** The names on a header row, with the column each sits in. */
function creditColumns(header) {
  const out = [];
  header.forEach((c, i) => {
    if (i < 5) return;                       // count, job, source, customer, date
    const name = text(c);
    if (name) out.push({ col: i, name });
  });
  return out;
}

/** M/D/YYYY as the sheet writes it. */
export function parseDate(value, { year, month }) {
  const m = text(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const [, mm, dd, yy] = m.map(Number);
  const y = yy < 100 ? 2000 + yy : yy;
  if (y !== year || mm !== month) return null;
  return `${y}-${pad(mm)}-${pad(dd)}`;
}

/**
 * One month's block out of a year tab.
 *
 * `problem` means the block could not be read at all — the caller must then
 * leave the database alone rather than rebuild a month from nothing.
 */
export function parseMonthBlock(grid, { year, month }) {
  const out = { reviews: [], warnings: [], problem: null };
  const isHeader = r => /^review count$/i.test(text(r?.[0]));
  const start = grid.findIndex(r => isHeader(r) && text(r?.[3]).toUpperCase() === MONTHS[month - 1]);
  if (start < 0) { out.problem = `no ${MONTHS[month - 1]} block`; return out; }

  const names = creditColumns(grid[start]);
  if (!names.length) { out.problem = `the ${MONTHS[month - 1]} block has no names`; return out; }

  for (let i = start + 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row) continue;
    if (isHeader(row)) break;                                  // the next month
    if (/^total$/i.test(text(row[3]))) break;                  // the block's total line

    const credits = [];
    let points = null, mixed = false;
    for (const { col, name } of names) {
      const v = text(row[col]);
      if (!v) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) { out.warnings.push(`row ${i + 1}: couldn't read "${v}" for ${name}`); continue; }
      if (points === null) points = n;
      else if (points !== n) mixed = true;
      credits.push({ name, points: n });
    }
    if (!credits.length) continue;                             // a spacer or an empty row

    const date = parseDate(row[4], { year, month });
    if (!date) {
      out.warnings.push(`row ${i + 1}: "${text(row[4])}" is not a ${MONTHS[month - 1].toLowerCase()} date — skipped`);
      continue;
    }

    /* Nearly always one value for the whole row. If a row ever mixes 1 and 3,
       it becomes one review per value rather than quietly rounding someone. */
    const groups = mixed
      ? [...new Set(credits.map(c => c.points))].map(p => ({ points: p, credits: credits.filter(c => c.points === p) }))
      : [{ points, credits }];

    for (const g of groups) {
      out.reviews.push({
        occurred_on:   date,
        job_number:    text(row[1]) && text(row[1]) !== "0" ? text(row[1]) : null,
        source:        text(row[2]) || null,
        customer_name: text(row[3]) || null,
        points:        g.points,
        has_photo:     g.points >= 3,
        names:         g.credits.map(c => c.name)
      });
    }
  }
  return out;
}

/** Sheet names → roster people. "Jacob/Jake" is one person written two ways. */
export function toRecords(reviews, roster) {
  const match = nameMatcher(roster);
  const unmatched = new Set();
  const records = [];

  for (const r of reviews) {
    const credits = [];
    for (const name of r.names) {
      const who = name.split("/").map(s => s.trim()).filter(Boolean)
        .map(part => match(part)).find(Boolean);
      if (who) { if (!credits.includes(who.id)) credits.push(who.id); }
      else unmatched.add(name.trim());
    }
    if (credits.length) records.push({ ...r, credits });
  }
  return { records, unmatched: [...unmatched] };
}

/** Replace the month's imported reviews. Anything typed in admin is untouched. */
export async function applyRecords(records, period) {
  await withTransaction(async c => {
    await c.query(
      `delete from reviews
        where recorded_by = $1 and date_trunc('month', occurred_on) = $2::date`,
      [TAG, period]);                                          // credits cascade
    for (const r of records) {
      const id = (await c.query(
        `insert into reviews (occurred_on, job_number, customer_name, source, has_photo, points, recorded_by)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [r.occurred_on, r.job_number, r.customer_name, r.source, r.has_photo, r.points, TAG])).rows[0].id;
      for (const employeeId of r.credits) {
        await c.query(`insert into review_credits (review_id, employee_id) values ($1,$2)
                       on conflict do nothing`, [id, employeeId]);
      }
    }
  });
}

export function summarise({ period, records, unmatched, warnings }) {
  const [, m] = period.split("-").map(Number);
  const points = records.reduce((a, r) => a + r.points * r.credits.length, 0);
  const photos = records.filter(r => r.has_photo).length;
  let s = `${MONTHS[m - 1][0] + MONTHS[m - 1].slice(1).toLowerCase()}: ${records.length} reviews` +
          (photos ? ` (${photos} with a photo)` : "") + ` → ${points} review points`;
  if (unmatched.length) s += `; NOT MATCHED: ${unmatched.join(", ")}`;
  if (warnings.length) s += `; ${warnings.length} row(s) skipped: ${warnings.slice(0, 3).join("; ")}`;
  return s;
}

/** The scheduled run: read the year tab, rebuild the month. */
export async function importReviews(google, sheetId, { period, dryRun = false }) {
  const [year, month] = period.split("-").map(Number);
  const info = await google.info(sheetId);
  const tab = info.tabs.find(t => text(t.title) === String(year));
  if (!tab) {
    return { period, reviews: [], records: [], unmatched: [], warnings: [],
             summary: `the review log has no ${year} tab yet — nothing changed` };
  }

  const grid = await google.read(sheetId, `'${tab.title}'!A1:AZ1200`);
  const parsed = parseMonthBlock(grid, { year, month });
  if (parsed.problem) throw new Error(`review log: ${parsed.problem} — nothing changed`);

  const roster = await matchableRoster(period);
  const { records, unmatched } = toRecords(parsed.reviews, roster);
  if (!dryRun) await applyRecords(records, period);

  return { period, tab: tab.title, records, unmatched, warnings: parsed.warnings,
           summary: summarise({ period, records, unmatched, warnings: parsed.warnings }) };
}
