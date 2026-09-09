/* Load real data: revenue history from the report, roster from SmartMoving,
   and the August job->crew index. Idempotent — safe to re-run. */
import { readFileSync, existsSync } from "node:fs";
import { parseReportFile } from "../src/sync/revenue-report.js";
import { createClient, monthBounds, buildJobCrewIndex } from "../src/sync/smartmoving.js";
import { query, withTransaction, close, safeTarget, loadEnv } from "../src/db.js";

loadEnv();

const REPORT  = process.env.REVENUE_REPORT;
const KEYFILE = process.env.SMARTMOVING_KEY_FILE ?? "";
const API_KEY = process.env.SMARTMOVING_API_KEY ?? (existsSync(KEYFILE) ? readFileSync(KEYFILE, "utf8").trim() : null);

const money = n => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* Code names. Andrew left these to us; he approves or swaps any he dislikes.
   Assigned by seniority of review count where known, otherwise alphabetical. */
const CODE_NAMES = [
  "RANGER", "JAGUAR", "LYNX", "BEAR", "BISON", "RHINO", "WOLF", "OTTER",
  "TITAN", "FALCON", "HAWK", "BADGER", "MOOSE", "COBRA", "EAGLE", "VIPER",
  "RAVEN", "STAG", "PUMA", "OSPREY", "HERON", "MARLIN", "KODIAK", "SABLE"
];

console.log("connecting to", safeTarget(), "\n");

/* ------------------------------------------------------ revenue history ---- */
console.log("REVENUE HISTORY");
const months = parseReportFile(REPORT).filter(m => m.completed_revenue > 0 || m.completed_jobs > 0);

await withTransaction(async c => {
  for (const m of months) {
    /* one authoritative row per period from the report; re-running replaces it */
    await c.query(
      `delete from revenue_snapshots where period = $1 and source = 'report'`, [m.period]);
    await c.query(
      `insert into revenue_snapshots
         (period, completed_revenue, completed_jobs, total_tips, total_taxes, source)
       values ($1, $2, $3, $4, $5, 'report')`,
      [m.period, m.completed_revenue, m.completed_jobs, m.total_tips, m.total_taxes]);
  }
});
const rev = await query(
  `select count(*)::int n, min(period) lo, max(period) hi, sum(completed_revenue) total
     from revenue_snapshots where source = 'report'`);
console.log(`  ${rev.rows[0].n} months  ${String(rev.rows[0].lo).slice(0,10)} → ${String(rev.rows[0].hi).slice(0,10)}`);
console.log(`  lifetime completed revenue ${money(rev.rows[0].total)}\n`);

/* -------------------------------------------------------------- roster ---- */
if (!API_KEY) { console.log("no SmartMoving key — skipping roster and jobs"); await close(); process.exit(0); }

const client = createClient({ apiKey: API_KEY, log: () => {} });

console.log("ROSTER");
const { from, to } = monthBounds(2026, 8);
const index = await buildJobCrewIndex(client, { from, to, log: () => {} });

/* only crew who actually ran jobs — the five office/sales people on the active
   list worked none, and putting them on a movers' board would be noise */
const jobCount = new Map();
for (const ids of index.crewByJob.values())
  for (const id of ids) jobCount.set(id, (jobCount.get(id) || 0) + 1);

const movers = index.crew
  .filter(c => jobCount.has(c.id))
  .sort((a, b) => jobCount.get(b.id) - jobCount.get(a.id));
const benched = index.crew.filter(c => !jobCount.has(c.id));

await withTransaction(async c => {
  for (const [i, m] of movers.entries()) {
    await c.query(
      `insert into employees (code_name, full_name, sm_crew_id, status)
       values ($1, $2, $3, 'active')
       on conflict (sm_crew_id) do update
         set full_name = excluded.full_name, updated_at = now()`,
      [CODE_NAMES[i] ?? `CREW${i + 1}`, m.name, m.id]);
  }
});

const emps = await query(`select code_name, full_name, sm_crew_id from employees order by code_name`);
console.log(`  ${emps.rowCount} movers loaded (${benched.length} active crew ran no jobs and were skipped)`);
for (const e of emps.rows) console.log(`    ${e.code_name.padEnd(9)} ${e.full_name.padEnd(20)} ${jobCount.get(e.sm_crew_id) ?? 0} jobs`);
console.log(`  skipped: ${benched.map(b => b.name).join(", ")}\n`);

/* ---------------------------------------------------------------- jobs ---- */
console.log("AUGUST JOB INDEX");
await withTransaction(async c => {
  for (const j of index.jobs) {
    await c.query(
      `insert into sm_jobs (job_id, job_number, opportunity_id, service_date, completed_at, service_type)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (job_id) do update set
         job_number = excluded.job_number, service_date = excluded.service_date,
         completed_at = excluded.completed_at, synced_at = now()`,
      [j.job_id, j.job_number, j.opportunity_id, j.service_date, j.completed_at, j.service_type]);
  }
  for (const [jobId, ids] of index.crewByJob) {
    for (const id of ids) {
      await c.query(
        `insert into sm_job_crew (job_id, sm_crew_id) values ($1,$2) on conflict do nothing`,
        [jobId, id]);
    }
  }
});

const stats = await query(`
  select (select count(*) from sm_jobs)                                  as jobs,
         (select count(*) from sm_job_crew)                              as links,
         (select count(*) from sm_jobs where completed_at is not null)   as completed`);
console.log(`  ${stats.rows[0].jobs} jobs, ${stats.rows[0].links} crew links, ${stats.rows[0].completed} completed`);

/* prove the lookup the admin panel will do */
const demo = await query(`
  select j.job_number, string_agg(e.full_name, ', ' order by e.full_name) as crew
    from sm_jobs j
    join sm_job_crew jc on jc.job_id = j.job_id
    join employees e on e.sm_crew_id = jc.sm_crew_id
   group by j.job_number having count(*) >= 3
   order by j.job_number limit 4`);
console.log("\n  job-number lookup (what the admin panel will show):");
for (const r of demo.rows) console.log(`    ${r.job_number.padEnd(10)} ${r.crew}`);

await query(`insert into sync_runs (kind, ended_at, ok, detail) values ($1, now(), true, $2)`,
  ["seed", `${months.length} months, ${emps.rowCount} movers, ${index.jobs.length} jobs`]);

console.log(`\nDONE — ${client.callCount} API calls used.`);
await close();
