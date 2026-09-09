/* Same-day job points, derived rather than logged.
 *
 * A mover who runs two jobs on one date earns +1; three jobs, +2. This is the
 * only point event nobody has to remember, because the job dates already say
 * it happened. August 2026 had 48 of them across the crew, worth 55 points.
 *
 * Rewritten each run for the month in question, so re-syncing after SmartMoving
 * gains a late job corrects the total instead of doubling it.
 */

import { query, withTransaction } from "../db.js";

const REASON = "Same-day job";

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
        where reason like $1
          and recorded_by = 'system'
          and date_trunc('month', occurred_on) = $2::date`,
      [REASON + "%", period]);

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
