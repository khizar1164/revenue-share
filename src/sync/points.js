/* "Came in on day off" points, derived rather than logged.
 *
 * A mover who runs two jobs on one date earns +1; three jobs, +2. This is the
 * only point event nobody has to remember, because the job dates already say
 * it happened. August 2026 had 48 of them across the crew, worth 55 points.
 *
 * Andrew renamed this from "Same-day job" on 28 September 2026, then settled
 * what it should actually mean: coming in on your day off is worth +1, and it
 * has nothing to do with how many jobs you ran. "I'm not sure where the 2 job
 * thing came into factor."
 *
 * Nothing in the schedule records whose day off it was, so from 1 October this
 * stops being derived and becomes a reason a manager picks in the admin panel.
 * September keeps what it already earned — the month has been shown to the
 * crew and rescoring it now would move totals they have already seen.
 *
 * Rewritten each run for the month in question, so re-syncing after SmartMoving
 * gains a late job corrects the total instead of doubling it.
 */

import { query, withTransaction } from "../db.js";

const REASON = "Came in on day off";

/* What these rows were called until 28 September 2026. The wording is the key
   the rebuild below deletes on, so the old one has to stay listed: without it
   the September rows would be stranded and the month would count twice. */
const LEGACY_REASONS = ["Same-day job"];

/* Derived up to the end of September only. From October a manager records it,
   because the job dates cannot tell us whose day off it was. */
export const DERIVED_UNTIL = "2026-10-01";

export async function syncSameDayPoints(period) {
  if (period >= DERIVED_UNTIL) {
    /* still clear our own rows for the month, so a re-run of an earlier
       version cannot leave derived points stranded in October */
    await query(
      `delete from point_events
        where recorded_by = 'system'
          and date_trunc('month', occurred_on) = $2::date
          and reason like any ($1::text[])`,
      [[REASON, ...LEGACY_REASONS].map(r => r + "%"), period]);
    return { days: 0, points: 0 };
  }

  const found = await query(
    `select e.id                       as employee_id,
            j.service_date             as on_date,
            count(*)::int              as jobs
       from sm_job_crew jc
       join sm_jobs j  on j.job_id = jc.job_id
       join employees e on e.sm_crew_id = jc.sm_crew_id
      where j.service_date is not null
        and date_trunc('month', j.service_date) = $1::date
      group by e.id, j.service_date
     having count(*) > 1
      order by j.service_date`,
    [period]);

  const events = found.rows.map(r => ({
    employee_id: r.employee_id,
    occurred_on: r.on_date,
    delta: r.jobs - 1,
    reason: `${REASON} (${r.jobs} jobs)`
  }));

  await withTransaction(async c => {
    /* only our own derived rows are replaced; anything a manager typed stays */
    await c.query(
      `delete from point_events
        where recorded_by = 'system'
          and date_trunc('month', occurred_on) = $2::date
          and reason like any ($1::text[])`,
      [[REASON, ...LEGACY_REASONS].map(r => r + "%"), period]);

    for (const e of events) {
      await c.query(
        `insert into point_events (employee_id, occurred_on, delta, reason, recorded_by)
         values ($1, $2, $3, $4, 'system')`,
        [e.employee_id, e.occurred_on, e.delta, e.reason]);
    }
  });

  return {
    days: events.length,
    points: events.reduce((a, e) => a + e.delta, 0)
  };
}
