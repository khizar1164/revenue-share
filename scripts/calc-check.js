/* Run the engine against live August data and print what the board would show. */
import { monthly, rank, RULES } from "../src/calc.js";
import { syncSameDayPoints } from "../src/sync/points.js";
import { query, close } from "../src/db.js";

const usd = n => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (n * 100).toFixed(1) + "%";

console.log("deriving same-day job points from the job index…");
const sd = await syncSameDayPoints("2026-08-01");
console.log(`  ${sd.days} same-day dates, ${sd.points} points — nobody logged any of them\n`);

const r = await monthly(2026, 8);

console.log("=".repeat(78));
console.log("AUGUST 2026");
console.log("=".repeat(78));
console.log(`  completed revenue   ${usd(r.revenue).padStart(14)}   ${r.completed_jobs} jobs`);
console.log(`  commission @ 2%     ${usd(r.commission).padStart(14)}`);
console.log(`  claims (${r.claims_count})          ${("-" + usd(r.claims_total)).padStart(14)}`);
console.log(`  ${"POOL".padEnd(19)} ${usd(r.pool).padStart(14)}`);
console.log(`    points 50%        ${usd(r.points_pool).padStart(14)}   over ${r.totals.points} points`);
console.log(`    reviews 35%       ${usd(r.reviews_pool).padStart(14)}   over ${r.totals.reviews} review points`);
console.log(`    hours 15%         ${usd(r.hours_pool).padStart(14)}   over ${r.totals.hours} hours`);
if (r.forfeited > 0) console.log(`  forfeited & redistributed ${usd(r.forfeited).padStart(8)}`);
console.log(`\n  roster ${r.counts.roster} | qualified ${r.counts.qualified} | forfeited ${r.counts.forfeited} | short on hours ${r.counts.short}`);

console.log("\n" + "-".repeat(78));
console.log("  " + "CODE".padEnd(9) + "NAME".padEnd(19) + "HRS".padStart(5) + "PTS".padStart(5) +
            "REV".padStart(5) + "POINTS $".padStart(12) + "REVIEWS $".padStart(12) + "TAKE HOME".padStart(12));
console.log("-".repeat(78));

for (const p of rank(r.rows)) {
  const flag = p.paid ? " " : p.forfeits ? "!" : "·";
  console.log(
    ` ${flag}` +
    p.code_name.padEnd(9) +
    p.full_name.slice(0, 18).padEnd(19) +
    String(p.hours).padStart(5) +
    String(p.points).padStart(5) +
    String(p.review_points).padStart(5) +
    (p.paid ? usd(p.points_amount) : "—").padStart(12) +
    (p.paid ? usd(p.reviews_amount) : "—").padStart(12) +
    (p.paid ? usd(p.take_home) : p.forfeits ? "-" + usd(p.forfeited) : "—").padStart(12));
}
console.log("-".repeat(78));
console.log("  " + "".padEnd(28) + "".padStart(15) +
            usd(r.points_pool).padStart(12) + usd(r.reviews_pool).padStart(12) + usd(r.totals.take_home).padStart(12));

/* sanity checks — the arithmetic that must always hold */
console.log("\nCHECKS");
const paid = r.rows.filter(p => p.paid);
const sumShare = paid.reduce((a, p) => a + p.share, 0);
const line = (label, ok, detail) => console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);

line("pool = revenue x 2% - claims",
  Math.abs(r.pool - (r.revenue * RULES.commissionRate - r.claims_total)) < 0.01,
  `${usd(r.pool)}`);
line("50/35/15 split sums to the pool",
  Math.abs((r.points_pool + r.reviews_pool + r.hours_pool) - r.pool) < 0.01);
line("everything paid out equals the pool",
  r.counts.qualified === 0 || Math.abs(sumShare - r.pool) < 0.05,
  r.counts.qualified === 0 ? "nobody qualified yet — no hours entered" : `${usd(sumShare)} vs ${usd(r.pool)}`);
line("nobody short on hours is paid",
  r.rows.every(p => p.hours_ok || p.share === 0));
line("nobody who forfeited is paid",
  r.rows.every(p => !p.forfeits || p.share === 0));

const missing = [];
if (!r.rows.some(p => p.hours > 0))          missing.push("hours (nobody has any — the 75-hour gate blocks everyone)");
if (!r.rows.some(p => p.review_points > 0))  missing.push("reviews");
if (r.claims_count === 0)                    missing.push("claims (may genuinely be none)");
if (missing.length) {
  console.log("\nNOT YET ENTERED");
  for (const m of missing) console.log("  · " + m);
}

const pts = await query(`select count(*)::int n, sum(delta)::int total from point_events`);
console.log(`\npoint_events in the database: ${pts.rows[0].n} rows, ${pts.rows[0].total} points net`);

await close();
