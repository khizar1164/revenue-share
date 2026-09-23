/* Who a name on a sheet is allowed to match to.
 *
 * This is not the same question as "who is on the board this month". The
 * calculation decides that. This decides only which people a name written in
 * Matthew's tardy log, Nicole's review log or a Connecteam export can refer to.
 *
 * Someone who gave notice still has hours, reviews and tardies belonging to the
 * month they worked, and they are still paid for it, so they have to stay
 * matchable after they leave. They were not, which is why every sync was
 * reporting "NOT MATCHED: Jeffrey Martin" and quietly dropping his September.
 *
 * They do not stay matchable for ever. Names are matched loosely — first name
 * plus last initial — so a roster that never forgets anyone would eventually
 * have two people answering to "Josh T." and the sheet would pick the wrong one.
 * So a leaver ages out: either at the start of the month being synced, or three
 * months after they left when the sync is not about one month in particular.
 */

import { query } from "./db.js";

/**
 * @param {string|null} period  the month being synced, 'YYYY-MM-01'. When given,
 *   anyone who left on or after the 1st of that month can still be matched.
 *   When omitted, anyone who left in the last three months can.
 */
export async function matchableRoster(period = null) {
  const r = await query(
    `select id, code_name, full_name from employees
      where is_mover
        and (status <> 'left'
             or ended_on >= coalesce($1::date, (current_date - interval '3 months')::date))
      order by code_name`,
    [period ?? null]);
  return r.rows;
}
