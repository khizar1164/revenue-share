/* The daily Revenue Forecast, received by email and forwarded by Zapier.
 *
 *   SmartMoving emails the report at 5am Central
 *     → a Zap watching Gmail posts that email here
 *     → we pull out the download link, fetch the spreadsheet, parse it
 *     → the pool updates
 *
 * The dashboard never holds a mailbox password. Zapier holds the Gmail
 * connection; we hold only the secret that proves a request came from the Zap.
 *
 * Which months a report may change:
 *
 *   this month      yes — this is the whole point
 *   last month      yes, if the figure moved — a job completed late on the
 *                   30th, or a correction, lands in the next morning's report
 *   anything older  no — a month that has been paid should not shift under
 *                   anyone's feet because a spreadsheet said so
 *
 * A reading that matches the last one for that month is not stored again, so
 * the history stays a record of changes rather than a row a day. Every
 * receipt is logged in sync_runs regardless, which is what the freshness
 * check watches — "the report stopped arriving" must never be silent.
 */

import { query } from "../db.js";
import { extractReportLink, fetchReport } from "./revenue-report.js";
import { TZ } from "../scheduler.js";

/** The month as it is in La Porte, not on the server. A report arriving at
    11pm Central on the 30th is still that month, even though it is already
    the 1st in UTC. */
export function periodInZone(d = new Date(), timeZone = TZ) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" })
    .formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-01`;
}

function previousPeriod(period) {
  const [y, m] = period.split("-").map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
}

/** Write what this report says about the months it is allowed to touch. */
export async function ingestReport(months, { now = new Date() } = {}) {
  const current = periodInZone(now);
  const previous = previousPeriod(current);
  const results = [];

  for (const period of [current, previous]) {
    const row = months.find(m => m.period === period);
    if (!row) { results.push({ period, action: "not in report" }); continue; }

    const last = (await query(
      `select completed_revenue::float8 as revenue, completed_jobs
         from revenue_snapshots where period = $1::date
        order by captured_at desc limit 1`, [period])).rows[0];

    const same = last &&
      Math.abs(last.revenue - row.completed_revenue) < 0.005 &&
      (last.completed_jobs ?? null) === (row.completed_jobs ?? null);

    if (same) { results.push({ period, action: "unchanged", revenue: row.completed_revenue }); continue; }

    await query(
      `insert into revenue_snapshots
         (period, completed_revenue, completed_jobs, total_tips, total_taxes, source)
       values ($1, $2, $3, $4, $5, 'report')`,
      [period, row.completed_revenue, row.completed_jobs, row.total_tips, row.total_taxes]);

    results.push({
      period, action: last ? "updated" : "recorded",
      revenue: row.completed_revenue, jobs: row.completed_jobs,
      was: last ? last.revenue : null
    });
  }
  return { current, results };
}

/** Everything from an email body to a stored figure, recorded as a run. */
export async function handleReportEmail({ body, url, subject } = {}) {
  const run = (await query(`insert into sync_runs (kind) values ('revenue') returning id`)).rows[0].id;
  try {
    const link = url || extractReportLink(body);
    if (!link) throw new Error("no download link found in the email");

    const report = await fetchReport(link);
    const ingested = await ingestReport(report.months);

    const summary = ingested.results.map(r =>
      r.action === "unchanged" || r.action === "not in report"
        ? `${r.period.slice(0, 7)} ${r.action}`
        : `${r.period.slice(0, 7)} $${Number(r.revenue).toLocaleString("en-US")}` +
          (r.jobs != null ? ` / ${r.jobs} jobs` : "") +
          (r.was != null ? ` (was $${Number(r.was).toLocaleString("en-US")})` : "")
    ).join("; ");

    const detail = `${summary} · from ${report.host}`;
    await query(`update sync_runs set ended_at = now(), ok = true, detail = $2 where id = $1`, [run, detail]);
    return { ok: true, ...ingested, host: report.host, months_in_report: report.months.length, detail };
  } catch (e) {
    await query(`update sync_runs set ended_at = now(), ok = false, detail = $2 where id = $1`,
      [run, String(e.message).slice(0, 500)]);
    throw e;
  }
}

/**
 * The scheduled check. Ingestion happens whenever the email arrives, so this
 * job no longer fetches anything — it answers "has the report been arriving?"
 * and fails loudly when it has not, so the health page and the admin panel
 * show a stale feed instead of a quietly frozen pool.
 */
export async function reportFreshness({ maxHours = 30 } = {}) {
  const r = (await query(
    `select started_at, ok, detail from sync_runs
      where kind = 'revenue' and ok = true
      order by started_at desc limit 1`)).rows[0];
  if (!r) {
    throw new Error("the Revenue Forecast report has never been received — check the Zap and the SmartMoving schedule");
  }
  const hours = (Date.now() - new Date(r.started_at).getTime()) / 3600e3;
  if (hours > maxHours) {
    throw new Error(`no Revenue Forecast report for ${Math.round(hours)} hours — ` +
      `the daily email or the Zap may have stopped (last: ${r.detail ?? "?"})`);
  }
  return `last report ${Math.round(hours)}h ago — ${r.detail ?? ""}`;
}
