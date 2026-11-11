/* How a month's completed revenue is stored, whatever reads it.
 *
 * Until November 2026 the figure came from SmartMoving's daily Revenue Forecast
 * email. It now comes from MoveitPro's job bills (see mip-revenue.js), and the
 * email path is gone. The rules below were written for the email and still
 * hold, because they are about protecting a figure people are paid from, not
 * about where it came from.
 *
 * Which months a reading may change:
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
      `select completed_revenue::float8 as revenue, completed_jobs, source
         from revenue_snapshots where period = $1::date
        order by captured_at desc limit 1`, [period])).rows[0];

    const same = last &&
      Math.abs(last.revenue - row.completed_revenue) < 0.005 &&
      (last.completed_jobs ?? null) === (row.completed_jobs ?? null);

    if (same) { results.push({ period, action: "unchanged", revenue: row.completed_revenue }); continue; }

    /* A figure somebody set by hand stands until somebody sets it again.
     *
     * Andrew, 3 November: "I think the revenue number updated after you
     * manually changed it." October had been set to 195,000 by hand at 12:47
     * and the report put it back to 120,646.92 at 17:33 the same day, because
     * the newest reading wins everywhere that reads this table.
     *
     * That rule was right while the report was the whole truth. It is not any
     * more: bookings moved to MoveitPro, so SmartMoving has counted no new
     * completed job since 26 October and has been sending the same figure ever
     * since — one that now understates October by about 74,000. A hand-entered
     * figure is a correction to exactly that, so the report no longer gets to
     * undo it.
     *
     * Held, not merged: the report's own figure is already in the history
     * above this row, and nothing is deleted. To hand the month back to the
     * report, enter its figure by hand once and the next report matches it. */
    if (last && last.source === "manual") {
      results.push({ period, action: "held by a manual entry",
        revenue: last.revenue, reported: row.completed_revenue });
      continue;
    }

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

/**
 * The scheduled check. The MoveitPro read runs under the name "revenue"; this
 * answers "has it been succeeding?" and fails loudly when it has not, so the
 * health page and the admin panel show a stale figure instead of a quietly
 * frozen pool.
 */
export async function revenueFreshness({ maxHours = 6 } = {}) {
  const r = (await query(
    `select started_at, ok, detail from sync_runs
      where kind = 'revenue' and ok = true
      order by started_at desc limit 1`)).rows[0];
  if (!r) throw new Error("revenue has never been read from MoveitPro yet");
  const hours = (Date.now() - new Date(r.started_at).getTime()) / 3600e3;
  if (hours > maxHours) {
    throw new Error(`revenue not read from MoveitPro for ${Math.round(hours)} hours ` +
      `(last: ${r.detail ?? "?"})`);
  }
  return `last read ${Math.round(hours)}h ago, ${r.detail ?? ""}`;
}
