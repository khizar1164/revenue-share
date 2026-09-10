/* What the scheduler actually runs.
 *
 * Cadences are set by how fast each source really changes, not by how fast we
 * could ask:
 *
 *   smartmoving  every 4 hours   ~20 calls a run, so about 4,500 a month
 *                                against SmartMoving's free 20,000 allowance.
 *                                Job assignments change through the day but
 *                                not by the minute, and there is a per-minute
 *                                rate limit that makes anything faster pointless.
 *
 *   hours        every 10 min    Matthew pastes weekly, but when he does, the
 *                                board should move while he is still looking
 *                                at it. Reading a small sheet is nearly free.
 *
 *   revenue      daily 06:00     the Revenue Forecast report is emailed daily.
 *
 *   writeback    daily 02:15     quiet hour, and after the day's jobs have
 *                                landed, so the sheet reflects a settled day.
 */

import { readFileSync, existsSync } from "node:fs";
import { createClient, monthBounds, buildJobCrewIndex } from "./sync/smartmoving.js";
import { syncSameDayPoints } from "./sync/points.js";
import { importHours } from "./sync/hours.js";
import { importWeeklyHours } from "./sync/hours-weekly.js";
import { writeBack, reformatAll } from "./sync/writeback.js";
import { createGoogleClient, loadCredentials } from "./sync/google.js";
import { parseReportFile } from "./sync/revenue-report.js";
import { reportFreshness } from "./sync/report-hook.js";
import { query, withTransaction } from "./db.js";

/* In production the key is an environment variable. SMARTMOVING_KEY_FILE is a
   local convenience only — it lets a developer keep the key out of their shell
   history without it ever being committed. */
export const smartmovingKey = () => {
  if (process.env.SMARTMOVING_API_KEY) return process.env.SMARTMOVING_API_KEY.trim();
  const file = process.env.SMARTMOVING_KEY_FILE;
  return file && existsSync(file) ? readFileSync(file, "utf8").trim() : null;
};

const thisMonth = () => {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1,
           period: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01` };
};

/* ----------------------------------------------------------- smartmoving --- */

const NAME_POOL = ["RANGER","JAGUAR","LYNX","BEAR","BISON","RHINO","WOLF","OTTER",
  "TITAN","FALCON","HAWK","BADGER","MOOSE","COBRA","EAGLE","VIPER","RAVEN","STAG",
  "PUMA","OSPREY","HERON","MARLIN","KODIAK","SABLE","ORYX","IBEX"];

export async function syncSmartMoving({ year, month } = {}) {
  const key = smartmovingKey();
  if (!key) throw new Error("no SmartMoving API key configured");

  const now = thisMonth();
  const y = year ?? now.year, m = month ?? now.month;
  const period = `${y}-${String(m).padStart(2, "0")}-01`;

  const client = createClient({ apiKey: key, log: () => {} });
  const { from, to } = monthBounds(y, m);
  const index = await buildJobCrewIndex(client, { from, to, log: () => {} });

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
    /* rebuild the links for jobs we just saw, so a mover taken off a job
       actually loses the credit rather than keeping it forever */
    for (const [jobId, ids] of index.crewByJob) {
      await c.query(`delete from sm_job_crew where job_id = $1`, [jobId]);
      for (const id of ids) {
        await c.query(
          `insert into sm_job_crew (job_id, sm_crew_id) values ($1,$2) on conflict do nothing`,
          [jobId, id]);
      }
    }
  });

  /* Working a job is what makes someone a mover, so the roster follows the
     jobs. Office and sales never appear because they never work one. */
  const worked = new Set();
  for (const ids of index.crewByJob.values()) for (const id of ids) worked.add(id);

  const known = new Set((await query(
    `select sm_crew_id from employees where sm_crew_id is not null`)).rows.map(r => r.sm_crew_id));

  const added = [];
  for (const member of index.crew) {
    if (known.has(member.id) || !worked.has(member.id)) continue;
    const taken = new Set((await query(`select code_name from employees`)).rows.map(r => r.code_name));
    const code = NAME_POOL.find(n => !taken.has(n)) ?? `CREW${taken.size + 1}`;
    await query(
      `insert into employees (code_name, full_name, sm_crew_id, status)
       values ($1,$2,$3,'active') on conflict (sm_crew_id) do nothing`,
      [code, member.name, member.id]);
    added.push(`${member.name} as ${code}`);
  }

  const sd = await syncSameDayPoints(period);

  return {
    period,
    jobs: index.jobs.length,
    crew: index.crew.length,
    enrolled: added,
    same_day_dates: sd.days,
    same_day_points: sd.points,
    api_calls: client.callCount
  };
}

/* ------------------------------------------------------------------ hours --- */

/**
 * Hours come from Connecteam, which produces a fresh spreadsheet per pull —
 * weekly through the month, and a full-month export at month end that
 * supersedes those weeks. We find them in Drive rather than asking Matthew to
 * copy anything into a standing tab.
 *
 * The hand-maintained Hours tab is still read as a fallback, so hours can
 * always be entered by hand if Connecteam or Drive is unavailable.
 */
export async function syncHours({ period } = {}) {
  if (!loadCredentials()) throw new Error("no Google credentials configured");

  const google = createGoogleClient();
  const p = period ?? thisMonth().period;
  const parts = [];

  let fromDrive = null;
  try {
    fromDrive = await importWeeklyHours(google, {
      folderId: process.env.HOURS_FOLDER_ID || undefined, period: p });
    const months = fromDrive.weeks.filter(w => w.kind === "month").length;
    parts.push(`${fromDrive.files} Connecteam file${fromDrive.files === 1 ? "" : "s"}` +
               (months ? ` (${months} month-end)` : "") +
               ` → ${fromDrive.written} people`);
    if (fromDrive.unmatched.length) {
      parts.push(`NOT MATCHED: ${fromDrive.unmatched.map(u => u.name).join(", ")}`);
    }
  } catch (e) {
    /* Drive being unavailable must not stop the manual tab from working */
    parts.push(`Connecteam unavailable (${e.message.slice(0, 80)})`);
  }

  if (process.env.SHEET_ID && !(fromDrive && fromDrive.written)) {
    const manual = await importHours(google, process.env.SHEET_ID, { period: p });
    if (manual.rowsRead) {
      parts.push(`manual Hours tab → ${manual.written} people`);
      if (manual.unmatched.length) {
        parts.push(`NOT MATCHED: ${manual.unmatched.map(u => u.name).join(", ")}`);
      }
    }
  }

  return parts.join("; ") || "nothing to read";
}

/* ---------------------------------------------------------------- revenue --- */

/**
 * Read the Revenue Forecast report and record the month's completed revenue.
 *
 * The live path is the daily email SmartMoving sends: it carries a signed
 * download link rather than an attachment. Until that mailbox is wired, this
 * reads a file at REVENUE_REPORT so the job is exercised on the same code
 * path — only where the bytes come from changes.
 */
export async function syncRevenue({ file } = {}) {
  const path = file ?? process.env.REVENUE_REPORT;
  if (!path || !existsSync(path)) {
    throw new Error("no Revenue Forecast report available — set REVENUE_REPORT " +
                    "or connect the daily report email");
  }
  const months = parseReportFile(path);
  const { period } = thisMonth();
  const row = months.find(m => m.period === period);
  if (!row) return `report read (${months.length} months) but nothing for ${period} yet`;

  await query(
    `insert into revenue_snapshots
       (period, completed_revenue, completed_jobs, total_tips, total_taxes, source)
     values ($1,$2,$3,$4,$5,'report')`,
    [row.period, row.completed_revenue, row.completed_jobs, row.total_tips, row.total_taxes]);

  return `${period}: $${row.completed_revenue.toLocaleString("en-US")} from ${row.completed_jobs} jobs`;
}

/* -------------------------------------------------------------- writeback --- */

export async function syncWriteBack({ all = false } = {}) {
  if (!loadCredentials()) throw new Error("no Google credentials configured");
  if (!process.env.SHEET_ID) throw new Error("SHEET_ID is not set");
  const google = createGoogleClient();

  /* On the 1st, walk every tab rather than only the new month. The month that
     just ended gets one final rewrite with its closing figures, and anything
     left unformatted by a failed night is picked up. Cheap once a month;
     wasteful every night. */
  const now = new Date();
  if (all || now.getDate() === 1) {
    const r = await reformatAll(google, process.env.SHEET_ID);
    return `rebuilt ${r.tabs.length} tabs: ${r.tabs.join(", ")}`;
  }

  const { year, month } = thisMonth();
  const r = await writeBack(google, process.env.SHEET_ID, { year, month });
  return `"${r.tab}" ${r.summaryRows} rows, backup ${r.backupRows} records`;
}

/* ------------------------------------------------------------------------- */

export function registerJobs(scheduler) {
  const MIN = 60_000;
  scheduler.add("smartmoving", () => syncSmartMoving(), {
    everyMs: 4 * 60 * MIN, runAtStartAfterMs: 20_000 });
  scheduler.add("hours", () => syncHours(), {
    everyMs: 10 * MIN, runAtStartAfterMs: 45_000 });
  /* The report is ingested whenever its email arrives (via the Zap), so this
     is a watch, not a fetch. It runs under its own name: were it logged as
     "revenue" it would count as a report arriving and declare the feed healthy
     for ever. Fails loudly if nothing has come in for over a day. */
  scheduler.add("revenue-watch", () => reportFreshness({ maxHours: 26 }), {
    everyMs: 2 * 60 * MIN, runAtStartAfterMs: 60_000 });
  scheduler.add("writeback", () => syncWriteBack(), { dailyAt: "02:15" });
  return scheduler;
}
