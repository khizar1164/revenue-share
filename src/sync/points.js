/* "Came in on day off" points, derived rather than logged.
 *
 * A mover who runs two jobs on one date earns +1; three jobs, +2. This is the
 * only point event nobody has to remember, because the job dates already say
 * it happened. August 2026 had 48 of them across the crew, worth 55 points.
 *
 * Andrew renamed this from "Same-day job" on 28 September 2026, for the rules
 * list going on the break-room TV. Worth knowing that the name and the test
 * are not the same thing: what is actually measured is two or more jobs on one
 * date, which is not always a day off, and a day off worked as a single job
 * earns nothing here. If that gap matters, it needs a reason a manager enters
 * by hand, because nothing in the schedule records whose day off it was.
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

export async function syncSameDayPoints(period) {
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
