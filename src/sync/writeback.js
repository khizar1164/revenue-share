/* The nightly write-back to Andrew's workbook.
 *
 * Two jobs, and the second one is the important one.
 *
 *   1. A readable month summary he can open without asking anyone. One tab per
 *      month, overwritten each night.
 *
 *   2. A backup of everything a person typed. Revenue, jobs and crew can all be
 *      rebuilt from SmartMoving if the database were lost — but point events,
 *      reviews, claims, hours and adjustments exist nowhere else. Render's
 *      point-in-time recovery covers three days; this covers everything older,
 *      in a form Andrew can read without a database client.
 *
 * We only ever write tabs we own. Nothing touches Process Rules or Revenue
 * Share Calculations.
 */

import { query } from "../db.js";
import { monthly } from "../calc.js";
import { summaryRequests, backupRequests, hoursRequests } from "./sheet-format.js";

const MONTHS = ["January","February","March","April","May","June","July",
                "August","September","October","November","December"];

export const summaryTabName = period => {
  const [y, m] = String(period).split("-");
  return `RS ${y}-${m}`;
};
export const BACKUP_TAB = "RS Backup";

const money = n => Number(n ?? 0);
const label = period => {
  const [y, m] = String(period).split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
};

/** A1 range wide enough for the rows we are about to write. */
const rangeFor = (tab, rows, cols) => `${tab}!A1:${String.fromCharCode(64 + cols)}${rows}`;

/* ------------------------------------------------------------- summary ---- */

export async function buildSummary(year, month) {
  const r = await monthly(year, month);
  const when = new Date().toISOString().slice(0, 16).replace("T", " ");

  const head = [
    [`Revenue Share — ${label(r.period)}`],
    [`Generated ${when} UTC · written by the dashboard, do not edit`],
    [],
    ["Completed revenue", money(r.revenue), "", `${r.completed_jobs ?? ""} jobs`],
    ["Commission × 2%", money(r.commission)],
    [`Claims (${r.claims_count})`, -money(r.claims_total)],
    ["POOL", money(r.pool)],
    ["  Points 60%", money(r.points_pool), "", `${r.totals.points} points`],
    ["  Reviews 40%", money(r.reviews_pool), "", `${r.totals.reviews} review points`],
    ["Sharing", `${r.counts.qualified} of ${r.counts.roster}`, "",
      r.hours_gate_waived ? "75-hour minimum waived this month" : `${r.counts.short} short on hours`]
  ];
  if (r.forfeited > 0) head.push(["Forfeited & redistributed", money(r.forfeited), "",
    `${r.counts.forfeited} left without notice`]);
  if (r.unallocated > 0.01) head.push(["Not allocated", money(r.unallocated), "",
    (r.unallocated_why || []).join("; ")]);
  head.push(["Paying out", money(r.allocated)]);
  head.push(["Total take-home", money(r.totals.take_home), "", "after extras and deductions"]);
  head.push([]);

  const cols = ["Code", "Name", "Hours", "Points", "Reviews",
                "Points $", "Reviews $", "Extras", "Deductions", "Take home", "Note"];

  const tier = p => (p.paid ? 0 : p.forfeits ? 1 : 2);
  const body = r.rows.slice()
    .sort((a, b) => tier(a) - tier(b) || b.share - a.share)
    .map(p => [
      p.code_name, p.full_name, money(p.hours), p.points, p.review_points,
      p.paid ? money(p.points_amount) : "",
      p.paid ? money(p.reviews_amount) : "",
      p.bonuses ? money(p.bonuses) : "",
      p.deductions ? money(p.deductions) : "",
      money(p.take_home),
      p.forfeits ? `forfeited ${money(p.forfeited)} — no two weeks notice` : (p.reason || "")
    ]);

  const totals = ["", "TOTAL", "", r.totals.points, r.totals.reviews,
    money(r.points_pool), money(r.reviews_pool), "", "", money(r.totals.take_home), ""];

  const rows = [...head, cols, ...body, [], totals];

  /* Where each block sits, so the formatter targets it exactly instead of
     guessing — the figures block grows and shrinks depending on whether
     anything was forfeited or left unallocated. */
  const headerRow = head.length;
  const bodyStart = headerRow + 1;
  const bodyEnd   = bodyStart + body.length;
  const sorted    = r.rows.slice().sort((a, b) => tier(a) - tier(b) || b.share - a.share);

  const marks = {
    kvStart: 3,
    kvEnd: head.length - 1,
    poolRow: head.findIndex(row => row[0] === "POOL"),
    headerRow, bodyStart, bodyEnd,
    totalRow: rows.length - 1,
    states: {
      paid:      sorted.map((p, i) => p.paid ? bodyStart + i : -1).filter(i => i >= 0),
      forfeited: sorted.map((p, i) => p.forfeits ? bodyStart + i : -1).filter(i => i >= 0),
      short:     sorted.map((p, i) => (!p.paid && !p.forfeits) ? bodyStart + i : -1).filter(i => i >= 0)
    }
  };

  return { period: r.period, rows, width: cols.length, marks };
}

/* -------------------------------------------------------------- backup ---- */

/** Everything a person typed, across every month. Nothing derived. */
export async function buildBackup() {
  const cols = ["Type", "Date", "Code", "Name", "Detail", "Amount", "Recorded by", "Logged at"];

  const points = await query(`
    select 'point' as type, pe.occurred_on::text as date, e.code_name, e.full_name,
           pe.reason || coalesce(' · job ' || pe.job_number, '') as detail,
           pe.delta::text as amount, coalesce(pe.recorded_by,'') as by, pe.created_at
      from point_events pe join employees e on e.id = pe.employee_id`);

  const reviews = await query(`
    select 'review' as type, r.occurred_on::text as date, e.code_name, e.full_name,
           coalesce('job ' || r.job_number, '') ||
             coalesce(' · ' || r.customer_name, '') ||
             coalesce(' · ' || r.source, '') ||
             case when r.has_photo then ' · photo' else '' end as detail,
           r.points::text as amount, coalesce(r.recorded_by,'') as by, r.created_at
      from reviews r
      join review_credits rc on rc.review_id = r.id
      join employees e on e.id = rc.employee_id`);

  const claims = await query(`
    select 'claim' as type, occurred_on::text as date, '' as code_name, '' as full_name,
           reason || coalesce(' · job ' || job_number, '') as detail,
           amount::text as amount, coalesce(recorded_by,'') as by, created_at
      from claims`);

  const adj = await query(`
    select a.kind as type, a.occurred_on::text as date, e.code_name, e.full_name,
           a.reason as detail, a.amount::text as amount,
           coalesce(a.recorded_by,'') as by, a.created_at
      from adjustments a join employees e on e.id = a.employee_id`);

  const hours = await query(`
    select 'hours' as type, h.period::text as date, e.code_name, e.full_name,
           'month total' as detail, h.hours::text as amount,
           coalesce(h.recorded_by,'') as by, h.updated_at as created_at
      from hours h join employees e on e.id = h.employee_id`);

  const all = [...points.rows, ...reviews.rows, ...claims.rows, ...adj.rows, ...hours.rows]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) ||
                    String(a.type).localeCompare(String(b.type)));

  const rows = all.map(r => [
    r.type, r.date, r.code_name, r.full_name, r.detail, r.amount, r.by,
    r.created_at ? new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ") : ""
  ]);

  return {
    rows: [
      [`Everything entered by hand — backup, written nightly`],
      [`These records exist nowhere else. Revenue, jobs and crew can be rebuilt from SmartMoving; these cannot.`],
      [],
      cols, ...rows
    ],
    width: cols.length,
    count: rows.length
  };
}

/* --------------------------------------------------------------- write ---- */

export async function writeBack(google, spreadsheetId, { year, month, log = () => {} } = {}) {
  const now = new Date();
  const y = year ?? now.getFullYear();
  const m = month ?? now.getMonth() + 1;

  const summary = await buildSummary(y, m);
  const tab = summaryTabName(summary.period);
  await google.ensureTab(spreadsheetId, tab, { rows: 200, cols: summary.width });
  await google.clear(spreadsheetId, `${tab}!A1:Z400`);
  await google.write(spreadsheetId, rangeFor(tab, summary.rows.length, summary.width), summary.rows);

  const summaryId = await google.tabId(spreadsheetId, tab);
  await google.batchUpdate(spreadsheetId,
    summaryRequests(summaryId, summary.marks, summary.width));
  log(`wrote and formatted ${summary.rows.length} rows in "${tab}"`);

  const backup = await buildBackup();
  await google.ensureTab(spreadsheetId, BACKUP_TAB, { rows: 5000, cols: backup.width });
  await google.clear(spreadsheetId, `${BACKUP_TAB}!A1:Z10000`);
  await google.write(spreadsheetId, rangeFor(BACKUP_TAB, backup.rows.length, backup.width), backup.rows);

  const backupId = await google.tabId(spreadsheetId, BACKUP_TAB);
  await google.batchUpdate(spreadsheetId, backupRequests(backupId, 3, backup.count, backup.width));
  log(`wrote ${backup.count} entered records to "${BACKUP_TAB}"`);

  /* keep Matthew's tab tidy too — he types into it every week */
  try {
    const hoursId = await google.tabId(spreadsheetId, "Hours");
    if (hoursId != null) {
      const existing = await google.read(spreadsheetId, "Hours!A1:D2000");
      await google.batchUpdate(spreadsheetId, hoursRequests(hoursId, existing.length));
    }
  } catch { /* formatting his tab is a courtesy, never a reason to fail the run */ }

  return { tab, summaryRows: summary.rows.length, backupRows: backup.count };
}

/* ------------------------------------------------------------- reformat ---- */

/** Every month tab we own, oldest first. */
export function ourMonthTabs(tabs) {
  return tabs
    .map(t => t.title)
    .filter(title => /^RS \d{4}-\d{2}$/.test(title))
    .sort();
}

/**
 * Rebuild and reformat every tab we own.
 *
 * The nightly run only touches the current month, which is right — but it means
 * a tab written before the formatting existed, or on a night when formatting
 * failed, would stay ugly forever. This walks the lot.
 *
 * Rewriting a past month is safe because every figure is derived: the tab is a
 * view of the database, not a record of its own. That stops being true once a
 * month is locked for payout, and this will need to skip locked months then.
 */
export async function reformatAll(google, spreadsheetId, { log = () => {} } = {}) {
  const { tabs } = await google.info(spreadsheetId);
  const months = ourMonthTabs(tabs);
  const done = [];

  for (const title of months) {
    const [, ym] = title.split(" ");
    const [y, m] = ym.split("-").map(Number);
    const summary = await buildSummary(y, m);

    await google.clear(spreadsheetId, `${title}!A1:Z400`);
    await google.write(spreadsheetId,
      rangeFor(title, summary.rows.length, summary.width), summary.rows);

    const id = tabs.find(t => t.title === title).id;
    await google.batchUpdate(spreadsheetId,
      summaryRequests(id, summary.marks, summary.width));

    log(`reformatted "${title}" (${summary.rows.length} rows)`);
    done.push(title);
  }

  const backupTab = tabs.find(t => t.title === BACKUP_TAB);
  if (backupTab) {
    const backup = await buildBackup();
    await google.clear(spreadsheetId, `${BACKUP_TAB}!A1:Z10000`);
    await google.write(spreadsheetId,
      rangeFor(BACKUP_TAB, backup.rows.length, backup.width), backup.rows);
    await google.batchUpdate(spreadsheetId,
      backupRequests(backupTab.id, 3, backup.count, backup.width));
    log(`reformatted "${BACKUP_TAB}" (${backup.count} records)`);
    done.push(BACKUP_TAB);
  }

  const hoursTab = tabs.find(t => t.title === "Hours");
  if (hoursTab) {
    const existing = await google.read(spreadsheetId, "Hours!A1:D2000");
    await google.batchUpdate(spreadsheetId, hoursRequests(hoursTab.id, existing.length));
    log(`reformatted "Hours" (${Math.max(existing.length - 1, 0)} rows of data, left alone)`);
    done.push("Hours");
  }

  return { tabs: done, months: months.length };
}
