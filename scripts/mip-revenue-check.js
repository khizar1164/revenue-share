/* Revenue from MoveitPro's job bills: the arithmetic, with no network and no
 * database. A fake MoveitPro answers the two calls the sync makes.
 *
 * What has to hold, because the crew are paid from this figure:
 *   - sales tax comes off; it is not revenue
 *   - a job with no bill yet (not signed, or the other days of a multi-day
 *     move) adds nothing
 *   - a move billed by phase counts every bill, but is one job
 *   - the job list is followed across pages, so a busy month is not cut short
 *   - a 429 is waited out, not reported as a short month
 */
import { mipMonth, monthRange, syncMipRevenue } from "../src/sync/mip-revenue.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

/* 101 jobs so the list needs a second page */
const jobs = Array.from({ length: 101 }, (_, i) => ({ id: `j${i}`, estimate_id: `e${i}` }));
jobs[100].estimate_id = "e99";                       // second day of a two-day move
const bills = {
  j0: [{ total_cents: 50267, tax_cents: 277, status: "closed_out" }],
  j1: [{ total_cents: 67250, tax_cents: 0, status: "signed" }],
  j2: [{ total_cents: 100000, tax_cents: 700, status: "closed_out" },     // billed by phase
       { total_cents: 20000, tax_cents: 140, status: "closed_out" }],
  j99: [{ total_cents: 30000, tax_cents: 0, status: "closed_out" }]       // j100 shares its move
};

let rateLimitedOnce = false;
async function fakeGet(path) {
  if (path.startsWith("/v1/jobs?")) {
    const cursor = new URL("http://x" + path).searchParams.get("cursor");
    return cursor === "page2"
      ? { data: jobs.slice(100), next_cursor: null }
      : { data: jobs.slice(0, 100), next_cursor: "page2" };
  }
  const id = path.split("/")[3];
  if (id === "j1" && !rateLimitedOnce) {
    rateLimitedOnce = true;
    const e = new Error("rate limited"); e.status = 429; throw e;
  }
  return { data: bills[id] ?? [] };
}

console.log("\n1. THE MONTH");
const [from, to] = monthRange("2026-11-01");
check("November runs 1st to 30th", from === "2026-11-01" && to === "2026-11-30");
check("February knows its length", monthRange("2028-02-01")[1] === "2028-02-29");

console.log("\n2. THE FIGURE");
const m = await mipMonth("2026-11-01", { get: fakeGet });
const expected = (50267 - 277 + 67250 + 100000 - 700 + 20000 - 140 + 30000) / 100;
check("revenue is bill totals less sales tax", m.completed_revenue === expected,
  `${m.completed_revenue} vs ${expected}`);
check("tax is kept separately", m.total_taxes === (277 + 700 + 140) / 100);
check("tips are not invented", m.total_tips === null);
check("a phased move is one job, not two", m.completed_jobs === 4, `${m.completed_jobs} jobs`);
check("both pages of jobs were read", m.detail.jobs_listed === 101);
check("jobs without a bill are counted, not summed", m.detail.without_bill === 97);
check("a 429 was waited out rather than dropped", rateLimitedOnce && m.completed_revenue === expected);

console.log("\n3. WHAT IT HANDS ON");
let handed = null;
const line = await syncMipRevenue({
  now: new Date("2026-11-11T15:00:00Z"),
  get: fakeGet,
  ingest: async (months) => { handed = months; return { results: [
    { period: "2026-11-01", action: "updated", revenue: months[0].completed_revenue, was: 0 },
    { period: "2026-10-01", action: "held by a manual entry", revenue: 195000, reported: months[1].completed_revenue }
  ] }; }
});
check("this month and last month, in that order",
  handed?.map(x => x.period).join(",") === "2026-11-01,2026-10-01");
check("a held month says what MoveitPro would have said", /held by a manual entry \$195,000 \(MoveitPro says/.test(line), line);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
