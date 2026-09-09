/* Tests for the split, run against the pure function so the real database
   keeps only real data. Revenue and point totals are August's actual figures;
   hours, reviews and adjustments are hypothetical, which is the point — they
   are the parts a person still types, and the maths has to hold whatever
   they type. */

import { computeSplit, RULES } from "../src/calc.js";

const usd = n => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}
const near = (a, b, tol = 0.02) => Math.abs(a - b) < tol;

/* real August points, from the same-day sync */
const CREW = [
  ["LYNX",   "Aaron Schwark",   23], ["JAGUAR", "Tyler Johnston",  23],
  ["RANGER", "Ethan Garcia",    22], ["BISON",  "Adam Fredenburg", 21],
  ["BEAR",   "Jeffrey Martin",  20], ["RHINO",  "Jayson Murphy",   20],
  ["TITAN",  "Craig Hawkins",   20], ["OTTER",  "Julio Rodriguez", 19],
  ["WOLF",   "Jacob Byer",      18], ["FALCON", "Jordan Walker",   17],
  ["HAWK",   "Joshua Pama",     17], ["BADGER", "Josh Trim",       15]
];

function build(overrides = {}) {
  return {
    revenue: { completed_revenue: 201389.69, completed_jobs: 103, captured_at: new Date() },
    claims:  { total: overrides.claims ?? 0, n: overrides.claimsN ?? 0 },
    people: CREW.map(([code, name, points], i) => ({
      id: `emp-${i}`, code_name: code, full_name: name,
      status: overrides.status?.[code] ?? "active",
      hours: overrides.hours?.[code] ?? 180,
      point_delta: points - RULES.startPoints,
      review_points: overrides.reviews?.[code] ?? (14 - i),
      bonuses: overrides.bonuses?.[code] ?? 0,
      deductions: overrides.deductions?.[code] ?? 0,
      discipline_lost: overrides.discipline?.[code] ?? 0
    }))
  };
}

/* ------------------------------------------------------------------ 1 ---- */
console.log("\n1. THE POOL");
{
  const r = computeSplit(build({ claims: 1000, claimsN: 2 }));
  check("commission is 2% of revenue", near(r.commission, 201389.69 * 0.02), usd(r.commission));
  check("claims come off the pool", near(r.pool, r.commission - 1000), usd(r.pool));
  check("60/40 split reconstructs the pool", near(r.points_pool + r.reviews_pool, r.pool));
  check("points side is 60%", near(r.points_pool, r.pool * 0.6), usd(r.points_pool));
}

/* ------------------------------------------------------------------ 2 ---- */
console.log("\n2. EVERYONE QUALIFIED");
{
  const r = computeSplit(build());
  const sum = r.rows.reduce((a, p) => a + p.share, 0);
  check("all 12 are paid", r.counts.qualified === 12);
  check("shares sum to the pool", near(sum, r.pool, 0.05), `${usd(sum)} vs ${usd(r.pool)}`);
  check("nothing forfeited", r.forfeited === 0);
  const top = r.rows.find(p => p.code_name === "LYNX");
  check("highest points earns the largest points share",
    r.rows.every(p => p.points_amount <= top.points_amount + 0.01));
}

/* ------------------------------------------------------------------ 3 ---- */
console.log("\n3. THE 75-HOUR GATE");
{
  const r = computeSplit(build({ hours: { BADGER: 60, HAWK: 74 } }));
  const badger = r.rows.find(p => p.code_name === "BADGER");
  const hawk   = r.rows.find(p => p.code_name === "HAWK");
  const sum    = r.rows.reduce((a, p) => a + p.share, 0);

  check("under 75 hours is not paid", badger.share === 0 && hawk.share === 0);
  check("74 hours still fails the gate", !hawk.hours_ok);
  check("their points still count and show", badger.points === 15);
  check("the pool is still fully paid out", near(sum, r.pool, 0.05), usd(sum));
  check("reason is written out", /hours short/.test(badger.reason ?? ""), badger.reason);
  check("qualified count drops to 10", r.counts.qualified === 10);
}

/* ------------------------------------------------------------------ 4 ---- */
console.log("\n4. FORFEIT AND REDISTRIBUTE");
{
  const base = computeSplit(build());
  const r    = computeSplit(build({ status: { RHINO: "no_notice" } }));

  const rhino = r.rows.find(p => p.code_name === "RHINO");
  const other = r.rows.find(p => p.code_name === "LYNX");
  const otherBefore = base.rows.find(p => p.code_name === "LYNX");
  const paidSum = r.rows.reduce((a, p) => a + p.share, 0);

  check("the leaver is paid nothing", rhino.share === 0);
  check("a forfeited figure is calculated", rhino.forfeited > 0, usd(rhino.forfeited));
  check("it matches what they would have earned",
    near(rhino.forfeited, otherBefore ? base.rows.find(p => p.code_name === "RHINO").share : 0, 0.05),
    `${usd(rhino.forfeited)} vs ${usd(base.rows.find(p => p.code_name === "RHINO").share)}`);
  check("everyone else's share rises", other.share > otherBefore.share,
    `LYNX ${usd(otherBefore.share)} → ${usd(other.share)}`);
  check("the pool STILL pays out in full", near(paidSum, r.pool, 0.05),
    `${usd(paidSum)} vs ${usd(r.pool)}`);
  check("reason is written out", /two weeks notice/.test(rhino.reason ?? ""), rhino.reason);
  check("total redistributed is reported", near(r.forfeited, rhino.forfeited));
}

/* ------------------------------------------------------------------ 5 ---- */
console.log("\n5. FORFEIT PLUS SHORT HOURS TOGETHER");
{
  const r = computeSplit(build({
    status: { RHINO: "no_notice" },
    hours:  { BADGER: 40, RHINO: 190 }
  }));
  const sum = r.rows.reduce((a, p) => a + p.share, 0);
  check("both are excluded from payment", r.counts.qualified === 10);
  check("only the walker shows a forfeited figure",
    r.rows.filter(p => p.forfeited > 0).length === 1);
  check("someone short on hours shows no red number",
    r.rows.find(p => p.code_name === "BADGER").forfeited === 0);
  check("the pool still pays out in full", near(sum, r.pool, 0.05), usd(sum));
}

/* ------------------------------------------------------------------ 6 ---- */
console.log("\n6. BONUSES AND INDIVIDUAL DEDUCTIONS");
{
  const r = computeSplit(build({
    bonuses:    { LYNX: 150, JAGUAR: 150 },
    deductions: { WOLF: 40 }
  }));
  const lynx = r.rows.find(p => p.code_name === "LYNX");
  const wolf = r.rows.find(p => p.code_name === "WOLF");
  const shareSum = r.rows.reduce((a, p) => a + p.share, 0);

  check("a bonus adds on top of the share", near(lynx.take_home, lynx.share + 150), usd(lynx.take_home));
  check("a deduction comes off take-home", near(wolf.take_home, wolf.share - 40), usd(wolf.take_home));
  check("neither touches the shared pool", near(shareSum, r.pool, 0.05));
  check("take-home total reflects both",
    near(r.totals.take_home, shareSum + 300 - 40, 0.05), usd(r.totals.take_home));
}

/* ------------------------------------------------------------------ 7 ---- */
console.log("\n7. EDGE CASES");
{
  const zero = computeSplit(build({ claims: 999999 }));
  check("claims larger than the commission floor the pool at zero", zero.pool === 0);
  check("nobody is paid a negative amount", zero.rows.every(p => p.share >= 0));

  const noRevenue = computeSplit({ revenue: null, claims: { total: 0, n: 0 }, people: build().people });
  check("a missing revenue reading yields a zero pool, not a crash", noRevenue.pool === 0);

  const drained = computeSplit(build({}));
  drained.rows.forEach(p => { /* points can never go below zero */ });
  const negative = computeSplit({
    revenue: { completed_revenue: 100000 }, claims: { total: 0, n: 0 },
    people: [{ id: "x", code_name: "TEST", full_name: "T", status: "active", hours: 100,
               point_delta: -40, review_points: 5, bonuses: 0, deductions: 0, discipline_lost: 40 }]
  });
  check("points floor at zero, never negative", negative.rows[0].points === 0);
  check("no points means no points money, reviews still pay",
    negative.rows[0].points_amount === 0 && negative.rows[0].reviews_amount > 0);
  check("discipline standing is graded", negative.rows[0].standing === "suspension",
    `40 lost → ${negative.rows[0].standing}`);
}

/* ------------------------------------------------------------------ 8 ---- */
console.log("\n8. DISCIPLINE THRESHOLDS");
{
  const r = computeSplit(build({ discipline: { LYNX: 0, JAGUAR: 15, RANGER: 30, BISON: 45 } }));
  const s = c => r.rows.find(p => p.code_name === c).standing;
  check("0 lost is clear",           s("LYNX") === "clear");
  check("15 lost is a warning",      s("JAGUAR") === "warning");
  check("30 lost is suspension",     s("RANGER") === "suspension");
  check("45 lost is termination",    s("BISON") === "termination");
}

console.log("\n" + "=".repeat(56));
console.log(failures === 0 ? `ALL CHECKS PASSED` : `${failures} FAILURE(S)`);
console.log("=".repeat(56));
process.exit(failures ? 1 : 0);
