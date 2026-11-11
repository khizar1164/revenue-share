/* Who worked each job, read from MoveitPro.
 *
 * This replaces the SmartMoving sync. SmartMoving's key stopped working around
 * 10 November 2026, and with it the dashboard lost track of who was on a job:
 * logging a review by job number stopped filling in the crew, and claims on
 * November jobs stopped reaching the movers' write-ups. MoveitPro now lists the
 * crew on every job, and on 11 November all 98 crew entries on November's 30
 * worked jobs resolved to a MoveitPro employee.
 *
 * Two steps each run:
 *
 *   1. Link movers to MoveitPro employees, by name, once. Only a match that is
 *      unambiguous among CURRENT MoveitPro employees is saved. Jacob Byer has a
 *      terminated record and a current one, so the terminated one is ignored;
 *      "Josh Trim" is "Joshua Trim" there, so a first name that is the start of
 *      the other's, with the same surname, counts when it is the only fit.
 *      Anyone with no match (Brett Wood, 11 November) is reported, not guessed.
 *
 *   2. Rebuild job_crew for every job with a service date this month or last
 *      month: the estimate number staff quote, the date, and one row per mover.
 *      A job cancelled since the last run drops out, because its rows are
 *      cleared when it is no longer listed.
 *
 * The estimate number costs a call per job the first time, so it is kept on the
 * row and reused, and the relay's own mip_jobs record is read first.
 */

import { query, withTransaction, hasColumn } from "../db.js";
import { rawGet, getWithRetry, monthRange } from "./mip-revenue.js";
import { periodInZone } from "./revenue-store.js";

/** First day MoveitPro's crews are used. Before it, job_crew holds SmartMoving's record only. */
export const MOVEITPRO_CREW_FROM = "2026-11-01";

const norm = s =>String(s ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
const nameOf = e => norm(e.full_name || e.name || [e.first_name, e.last_name].filter(Boolean).join(" "));
const isCurrent = e => String(e.employee_status ?? "").toLowerCase() !== "terminated";

/**
 * Which dashboard mover is which MoveitPro employee. Pure, so it can be checked
 * without either system. Returns links to save and the names it would not guess.
 */
export function matchEmployees(movers, mipEmployees, { taken = new Set() } = {}) {
  const current = mipEmployees.filter(isCurrent);
  const links = [], unmatched = [], ambiguous = [];

  for (const m of movers) {
    /* re-read each time: an employee linked earlier in this run is taken */
    const pool = current.filter(e => !taken.has(e.id));
    const want = norm(m.full_name);
    let hits = pool.filter(e => nameOf(e) === want);
    let how = "name";
    if (hits.length > 1) {
      const dispatchable = hits.filter(e => e.is_dispatchable);
      if (dispatchable.length === 1) hits = dispatchable;
    }
    if (!hits.length) {
      const [first, ...rest] = want.split(" ");
      const last = rest.at(-1);
      hits = pool.filter(e => {
        const [f, ...r] = nameOf(e).split(" ");
        return last && r.at(-1) === last && f && first && (f.startsWith(first) || first.startsWith(f));
      });
      how = "short name";
    }
    if (hits.length === 1) { links.push({ employeeId: m.id, mipId: hits[0].id, how, name: m.full_name }); taken.add(hits[0].id); }
    else if (hits.length > 1) ambiguous.push(m.full_name);
    else unmatched.push(m.full_name);
  }
  return { links, unmatched, ambiguous };
}

async function listAll(get, path, retry) {
  const out = [];
  let cursor = "";
  for (let page = 0; page < 50; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await getWithRetry(get, path + (cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ""), retry);
    out.push(...(Array.isArray(res) ? res : res?.data ?? []));
    cursor = res?.next_cursor ?? res?.pagination?.next_cursor ?? "";
    if (!cursor) break;
  }
  return out;
}

function previousPeriod(period) {
  const [y, m] = period.split("-").map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
}

/**
 * The scheduled job. `from`/`to` (YYYY-MM-DD) widen it for a one-off catch-up,
 * e.g. { from: "2026-10-01" } after SmartMoving went quiet.
 */
export async function syncJobCrew({ from, to, now = new Date(), get = rawGet, retry } = {}) {
  if (!(await hasColumn("job_crew", "job_ref"))) {
    return "waiting for migration 021 (job_crew) to be run";
  }
  const current = periodInZone(now);
  from ??= previousPeriod(current);
  to ??= monthRange(current)[1];
  /* November 2026 is the first month MoveitPro's crews count. October and
     earlier stay exactly as SmartMoving recorded them (Khizar, 12 November):
     those months were worked and settled on that record, so a later read from
     another system must not rewrite who was on a job. */
  if (from < MOVEITPRO_CREW_FROM) from = MOVEITPRO_CREW_FROM;
  if (to < from) return `nothing to do: MoveitPro crews start ${MOVEITPRO_CREW_FROM}`;

  /* 1. link movers to MoveitPro employees */
  const mipEmployees = await listAll(get, "/v1/employees?limit=100", retry);
  const roster = (await query(
    `select id, full_name, mip_employee_id from employees
      where is_mover and merged_into is null`)).rows;
  const taken = new Set(roster.filter(r => r.mip_employee_id).map(r => r.mip_employee_id));
  const { links, unmatched, ambiguous } =
    matchEmployees(roster.filter(r => !r.mip_employee_id), mipEmployees, { taken });
  for (const l of links) {
    await query(`update employees set mip_employee_id = $2, updated_at = now()
                  where id = $1 and mip_employee_id is null`, [l.employeeId, l.mipId]);
  }
  const byMip = new Map((await query(
    `select id, mip_employee_id from employees where mip_employee_id is not null`)).rows
    .map(r => [r.mip_employee_id, r.id]));
  const mipName = new Map(mipEmployees.map(e => [e.id, [e.first_name, e.last_name].filter(Boolean).join(" ")]));

  /* 2. rebuild the crew for every job in range */
  const jobs = await listAll(get, `/v1/jobs?limit=100&service_date_from=${from}&service_date_to=${to}`, retry);
  const ids = jobs.map(j => j.id);
  const known = new Map((await query(
    `select job_ref, max(job_number) as n from job_crew
      where source = 'moveitpro' and job_ref = any($1::text[]) and job_number is not null
      group by job_ref`, [ids])).rows.map(r => [r.job_ref, r.n]));
  for (const r of (await query(
    `select job_id::text as id, estimate_number from mip_jobs
      where job_id = any($1::uuid[]) and estimate_number is not null`, [ids])).rows) {
    if (!known.has(r.id)) known.set(r.id, String(r.estimate_number));
  }

  let rows = 0, withCrew = 0;
  const strangers = new Map();
  for (const job of jobs) {
    const members = (job.crews ?? []).flatMap(c => c.members ?? []);
    let number = known.get(job.id) ?? null;
    if (number == null && job.estimate_id && members.length) {
      const est = await getWithRetry(get, `/v1/estimates/${job.estimate_id}`, retry);
      const n = (est?.data ?? est)?.estimate_number;
      number = n == null ? null : String(n);
    }
    const ours = [];
    for (const m of members) {
      const emp = byMip.get(m.employee_id);
      if (emp) ours.push({ emp, role: m.role ?? null, lead: m.is_crew_lead ?? null });
      else strangers.set(m.employee_id, (strangers.get(m.employee_id) ?? 0) + 1);
    }
    await withTransaction(async c => {
      await c.query(`delete from job_crew where source = 'moveitpro' and job_ref = $1`, [job.id]);
      const seen = new Set();
      for (const o of ours) {
        if (seen.has(o.emp)) continue;
        seen.add(o.emp);
        await c.query(
          `insert into job_crew (source, job_ref, job_number, service_date, completed_at,
                                 employee_id, role, is_crew_lead)
           values ('moveitpro', $1, $2, $3, $4, $5, $6, $7)`,
          [job.id, number, job.service_date?.slice(0, 10) ?? null, job.closed_at ?? null,
           o.emp, o.role, o.lead]);
        rows++;
      }
    });
    if (ours.length) withCrew++;
  }

  /* a job cancelled or removed since the last run is no longer listed */
  const gone = await query(
    `delete from job_crew where source = 'moveitpro'
        and service_date between $1::date and $2::date
        and not (job_ref = any($3::text[]))`, [from, to, ids]);

  const parts = [`${from}..${to}: ${jobs.length} jobs, ${withCrew} with crew, ${rows} crew rows`];
  if (gone.rowCount) parts.push(`${gone.rowCount} rows dropped from cancelled jobs`);
  if (links.length) parts.push(`linked ${links.map(l => l.name + (l.how === "name" ? "" : ` (${l.how})`)).join(", ")}`);
  if (unmatched.length) parts.push(`no MoveitPro employee for ${unmatched.join(", ")}`);
  if (ambiguous.length) parts.push(`more than one MoveitPro employee fits ${ambiguous.join(", ")}`);
  if (strangers.size) {
    parts.push(`on jobs but not on our roster: ${[...strangers].map(([id, n]) => `${mipName.get(id) ?? id.slice(0, 8)} (${n})`).join(", ")}`);
  }
  return parts.join(" · ");
}
