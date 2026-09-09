/* The scheduled sync, and the thing Render will run on a timer.
 *
 *   node scripts/sync.js              current month
 *   node scripts/sync.js 2026-08      a specific one
 *
 * Roughly 20 API calls per run, so a four-hourly schedule sits at about
 * 4,500 calls a month against SmartMoving's free 20,000 allowance.
 */
import { readFileSync, existsSync } from "node:fs";
import { createClient, monthBounds, buildJobCrewIndex } from "../src/sync/smartmoving.js";
import { syncSameDayPoints } from "../src/sync/points.js";
import { query, withTransaction, close, loadEnv } from "../src/db.js";

loadEnv();

const KEYFILE = process.env.SMARTMOVING_KEY_FILE ?? "";
const API_KEY = process.env.SMARTMOVING_API_KEY
  ?? (existsSync(KEYFILE) ? readFileSync(KEYFILE, "utf8").trim() : null);

const arg = process.argv[2];
const now = new Date();
const [year, month] = arg?.match(/^\d{4}-\d{2}$/)
  ? arg.split("-").map(Number)
  : [now.getFullYear(), now.getMonth() + 1];
const period = `${year}-${String(month).padStart(2, "0")}-01`;

const started = await query(
  `insert into sync_runs (kind) values ('smartmoving') returning id`);
const runId = started.rows[0].id;

try {
  if (!API_KEY) throw new Error("no SmartMoving API key available");
  /* Log the throttle and retry chatter. This runs unattended, so when it does
     go wrong the log is the only witness. */
  const say = s => console.log("  " + s);
  const client = createClient({ apiKey: API_KEY, log: say });
  const { from, to } = monthBounds(year, month);

  console.log(`sync ${period}  (${from}–${to})`);
  const index = await buildJobCrewIndex(client, { from, to, log: say });

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
    /* a mover taken off a job should lose the credit, so rebuild the links
       for the jobs we just saw rather than only adding to them */
    for (const [jobId, ids] of index.crewByJob) {
      await c.query(`delete from sm_job_crew where job_id = $1`, [jobId]);
      for (const id of ids) {
        await c.query(
          `insert into sm_job_crew (job_id, sm_crew_id) values ($1,$2) on conflict do nothing`,
          [jobId, id]);
      }
    }
  });

  /* Enrol anyone who actually worked. A one-off seed based on one month was
     wrong: Blade Williams ran no jobs in August and seven in September, so a
     static roster would have quietly left him off the board. Working a job is
     the definition of being a mover, so the roster follows the jobs.
     Office and sales never appear, because they never work one. */
  const jobsPerCrew = new Map();
  for (const ids of index.crewByJob.values()) {
    for (const id of ids) jobsPerCrew.set(id, (jobsPerCrew.get(id) || 0) + 1);
  }
  const known = new Set(
    (await query(`select sm_crew_id from employees where sm_crew_id is not null`))
      .rows.map(r => r.sm_crew_id));

  const NAME_POOL = ["RANGER","JAGUAR","LYNX","BEAR","BISON","RHINO","WOLF","OTTER",
    "TITAN","FALCON","HAWK","BADGER","MOOSE","COBRA","EAGLE","VIPER","RAVEN","STAG",
    "PUMA","OSPREY","HERON","MARLIN","KODIAK","SABLE","HERON","ORYX"];

  const added = [];
  for (const member of index.crew) {
    if (known.has(member.id) || !jobsPerCrew.has(member.id)) continue;
    const taken = new Set((await query(`select code_name from employees`)).rows.map(r => r.code_name));
    const code = NAME_POOL.find(n => !taken.has(n)) ?? `CREW${taken.size + 1}`;
    await query(
      `insert into employees (code_name, full_name, sm_crew_id, status)
       values ($1,$2,$3,'active') on conflict (sm_crew_id) do nothing`,
      [code, member.name, member.id]);
    added.push(`${member.name} as ${code}`);
  }
  if (added.length) console.log("  enrolled: " + added.join(", "));

  const sd = await syncSameDayPoints(period);

  const counts = await query(
    `select (select count(*) from sm_jobs where date_trunc('month', service_date) = $1::date) as jobs,
            (select count(*) from sm_job_crew jc join sm_jobs j on j.job_id = jc.job_id
              where date_trunc('month', j.service_date) = $1::date) as links`, [period]);

  const detail = `${counts.rows[0].jobs} jobs, ${counts.rows[0].links} crew links, ` +
                 `${sd.days} same-day dates worth ${sd.points} points, ${client.callCount} API calls`;
  console.log("  " + detail);

  await query(`update sync_runs set ended_at = now(), ok = true, detail = $2 where id = $1`,
    [runId, detail]);
  console.log("ok");
} catch (e) {
  await query(`update sync_runs set ended_at = now(), ok = false, detail = $2 where id = $1`,
    [runId, e.message.slice(0, 500)]);
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await close();
}
