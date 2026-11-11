/* What the daily Revenue Forecast is allowed to change.
 *
 * Written after Andrew, 3 November: "I think the revenue number updated after
 * you manually changed it." October had been set to 195,000 by hand and the
 * report put it back to 120,646.92 four hours later. Nothing here was covered
 * by a check, which is how it went unnoticed.
 *
 * Runs against 2099, so no month anyone is paid from can be touched, and
 * clears those rows again whether it passes or fails.
 */
import { query, close } from "../src/db.js";
import { ingestReport, periodInZone } from "../src/sync/revenue-store.js";

const NOW = new Date("2099-06-15T12:00:00Z");
const THIS = "2099-06-01";
const LAST = "2099-05-01";
const OLDER = "2099-04-01";

const report = (period, revenue, jobs) =>
  [{ period, completed_revenue: revenue, completed_jobs: jobs, total_tips: 0, total_taxes: 0 }];

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const run = async (months) => (await ingestReport(months, { now: NOW })).results;
const latest = async period => (await query(
  `select completed_revenue::float8 as revenue, source
     from revenue_snapshots where period = $1 order by captured_at desc limit 1`,
  [period])).rows[0] ?? null;
const rowCount = async period => (await query(
  `select count(*)::int as n from revenue_snapshots where period = $1`, [period])).rows[0].n;
const clear = () => query(`delete from revenue_snapshots where period >= date '2099-01-01'`);

try {
  await clear();

  console.log("\n1. WHICH MONTH THE REPORT IS LOOKING AT");
  check("the period comes from La Porte's clock, not the server's",
    periodInZone(new Date("2099-07-01T03:30:00Z")) === "2099-06-01",
    "3:30am UTC on the 1st is still the 30th in Central");

  console.log("\n2. WHAT A REPORT STORES");
  let r = (await run(report(THIS, 120646.92, 62))).find(x => x.period === THIS);
  check("a month nobody has recorded yet is recorded", r?.action === "recorded");

  r = (await run(report(THIS, 120646.92, 62))).find(x => x.period === THIS);
  check("the same reading again is not stored twice", r?.action === "unchanged");
  check("so the history stays a record of changes", await rowCount(THIS) === 1);

  r = (await run(report(THIS, 130000, 68))).find(x => x.period === THIS);
  check("a figure that moved is stored", r?.action === "updated", `was ${r?.was}`);

  console.log("\n3. A FIGURE SOMEBODY SET BY HAND");
  await query(
    `insert into revenue_snapshots (period, completed_revenue, completed_jobs, source)
     values ($1, 195000, 62, 'manual')`, [THIS]);
  check("stands as what the board reads", (await latest(THIS))?.revenue === 195000);

  const before = await rowCount(THIS);
  r = (await run(report(THIS, 120646.92, 62))).find(x => x.period === THIS);
  check("is not undone by the next report", r?.action === "held by a manual entry",
    JSON.stringify(r));
  check("and the report writes no row at all", await rowCount(THIS) === before);

  const now = await latest(THIS);
  check("so the hand-entered figure is still the one that counts",
    now.revenue === 195000 && now.source === "manual", `$${now.revenue} (${now.source})`);

  console.log("\n4. A LATER CORRECTION STILL WINS");
  await query(
    `insert into revenue_snapshots (period, completed_revenue, completed_jobs, source)
     values ($1, 201000, 70, 'manual')`, [THIS]);
  check("because the newest hand-entered figure is the newest reading",
    (await latest(THIS))?.revenue === 201000);

  console.log("\n5. HOW FAR BACK A REPORT MAY REACH");
  await run(report(LAST, 90000, 40));
  check("last month is still open to it", (await latest(LAST))?.revenue === 90000);

  r = (await run(report(OLDER, 50000, 20))).find(x => x.period === OLDER);
  check("anything older is not", r === undefined,
    "a month that has been paid must not shift under anyone's feet");
  check("and nothing was written for it", await rowCount(OLDER) === 0);
} finally {
  await clear();
  const left = (await query(
    `select count(*)::int as n from revenue_snapshots where period >= date '2099-01-01'`)).rows[0].n;
  if (left) { failures++; console.log(`\n  FAIL  ${left} test rows left behind`); }
  await close();
}

console.log("\n==========================================================");
console.log(failures ? `${failures} CHECK(S) FAILED` : "ALL CHECKS PASSED");
console.log("==========================================================");
process.exit(failures ? 1 : 0);
