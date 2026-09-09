/* Verify both sync inputs against real data before anything is built on top. */
import { readFileSync, existsSync } from "node:fs";
import { parseReportFile, monthOf, currentPeriod } from "../src/sync/revenue-report.js";
import { createClient, monthBounds, buildJobCrewIndex, sameDayJobs } from "../src/sync/smartmoving.js";

const KEY_FILE = process.env.SMARTMOVING_KEY_FILE ?? "";
const REPORT   = process.env.REVENUE_REPORT;

const money = n => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

console.log("=".repeat(64));
console.log("1. REVENUE FORECAST PARSER");
console.log("=".repeat(64));

const months = parseReportFile(REPORT);
console.log(`parsed ${months.length} months, ${months.at(-1).label} → ${months[0].label}\n`);

const check = [
  { period: "2026-08-01", revenue: 201389.69, jobs: 103 },
  { period: "2026-07-01", revenue: 180779.83, jobs: 115 },
  { period: "2026-06-01", revenue: 190792.48, jobs: 101 }
];
let bad = 0;
for (const c of check) {
  const m = monthOf(months, c.period);
  const okRev = m && Math.abs(m.completed_revenue - c.revenue) < 0.005;
  const okJob = m && m.completed_jobs === c.jobs;
  if (!okRev || !okJob) bad++;
  console.log(`  ${m?.label.padEnd(8)} ${money(m?.completed_revenue).padStart(13)} ${String(m?.completed_jobs).padStart(4)} jobs  ` +
              `tips ${money(m?.total_tips).padStart(10)}  ${okRev && okJob ? "OK" : "MISMATCH"}`);
}
console.log(`\n  ${bad === 0 ? "PASS — parser matches the report exactly" : bad + " MISMATCHES"}`);

const cur = monthOf(months, currentPeriod());
console.log(`\n  current month (${currentPeriod().slice(0, 7)}): ` +
            (cur ? `${money(cur.completed_revenue)} from ${cur.completed_jobs} jobs — pool would be ${money(cur.completed_revenue * 0.02)}`
                 : "not in the report yet"));

const seed = months.filter(m => m.completed_revenue > 0).slice(0, 14);
console.log(`\n  history available to seed the board: ${months.filter(m => m.completed_revenue > 0).length} months`);
console.log("  last 12 completed:");
seed.slice(0, 12).forEach(m => console.log(`    ${m.label.padStart(8)}  ${money(m.completed_revenue).padStart(13)}  ${String(m.completed_jobs).padStart(3)} jobs`));

/* ---------------------------------------------------------------------- */
if (!existsSync(KEY_FILE)) { console.log("\n(no API key file — skipping SmartMoving check)"); process.exit(0); }

console.log("\n" + "=".repeat(64));
console.log("2. SMARTMOVING CREW INDEX");
console.log("=".repeat(64));

const client = createClient({ apiKey: readFileSync(KEY_FILE, "utf8").trim(), log: s => console.log("   " + s) });

console.log("ping:", JSON.stringify(await client.ping()));

const { from, to } = monthBounds(2026, 8);
console.log(`\nbuilding job→crew index for August 2026 (${from}–${to})…`);
const index = await buildJobCrewIndex(client, { from, to, log: s => console.log(s) });

console.log(`\n  jobs indexed        ${index.jobs.length}`);
console.log(`  active crew         ${index.crew.length}`);
console.log(`  job numbers mapped  ${index.byJobNumber.size}`);
console.log(`  API calls used      ${client.callCount}`);

const sizes = {};
for (const ids of index.crewByJob.values()) sizes[ids.size] = (sizes[ids.size] || 0) + 1;
console.log("  crew per job:", Object.entries(sizes).sort((a,b)=>a[0]-b[0]).map(([k, v]) => `${k}→${v}`).join("  "));

const sample = [...index.byJobNumber.entries()].filter(([, c]) => c.length > 1).slice(0, 4);
const nameOf = id => index.crew.find(c => c.id === id)?.name ?? id.slice(0, 8);
console.log("\n  sample — typing these job numbers would auto-fill:");
for (const [jobNo, ids] of sample) console.log(`    ${jobNo.padEnd(10)} ${ids.map(nameOf).join(", ")}`);

const sd = sameDayJobs(index);
console.log(`\n  same-day job bonuses detected: ${sd.length} (worth ${sd.reduce((a, s) => a + s.points, 0)} points, logged by nobody)`);
sd.slice(0, 5).forEach(s => console.log(`    ${nameOf(s.sm_crew_id).padEnd(20)} ${s.date}  ${s.jobs} jobs  +${s.points}`));

const completed = index.jobs.filter(j => j.completed_at).length;
console.log(`\n  jobs with completedAtUtc: ${completed} of ${index.jobs.length}`);
console.log("\nDONE.");
