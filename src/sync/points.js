/* "Came in on day off" — no longer derived from anything.
 *
 * This used to read the SmartMoving schedule: anyone on two jobs in one day
 * earned +1, three jobs +2. Matthew spotted on 29 September 2026 what that
 * actually measured. "So its pulling data for every day that someone is
 * assigned to a job? We dont want it to do that. That is when someone is not
 * scheduled to work but comes into work on their day off."
 *
 * He is right, and the two are not the same thing at all. Working two jobs on
 * a Tuesday you were rostered for is an ordinary day. Coming in on a Sunday
 * you were not rostered for is the thing worth a point. The schedule knows the
 * first and cannot know the second, because nothing in SmartMoving records
 * whose day off it was. Andrew had already said the same on 28 September:
 * "Im not sure where the 2 job thing came into factor. Going forward lets have
 * it set as if they come in on their day off it counts as 1, not nececssarily
 * tied to quantity of jobs."
 *
 * So it is now a reason a manager picks in the admin panel, worth +1, and this
 * file exists only to sweep up after the old rule. It ran for August and
 * September and left 91 entries worth 99 points behind; Matthew asked for all
 * of them, both months: "Please remove all of the current ones". Neither month
 * had been paid, so nobody was clawed back.
 *
 * The sweep stays rather than being deleted outright. The old rows were
 * rebuilt on every sync, so one straggler on a service that had not restarted
 * would quietly reappear on the board. Once it has nothing left to remove it
 * costs one delete that matches no rows.
 */

import { query } from "../db.js";

/* Every wording the derived rows ever carried. recorded_by = 'system' was only
   ever used for these, so the tag alone is enough, but the reasons are matched
   too so a future automatic source cannot be swept away by accident. */
const DERIVED_REASONS = ["Came in on day off%", "Same-day job%"];

/** The reason a manager picks by hand. Kept here so the admin panel and any
    report agree on one spelling. */
export const REASON = "Came in on day off";

/**
 * Remove anything left from the old automatic rule, in every month rather than
 * just the one being synced — August had to go as well as September, and a
 * sync only ever looks at the current month.
 */
export async function syncSameDayPoints(_period) {
  const gone = await query(
    `delete from point_events
      where recorded_by = 'system'
        and reason like any ($1::text[])
      returning delta`,
    [DERIVED_REASONS]);

  return {
    removed: gone.rowCount,
    points:  gone.rows.reduce((a, r) => a + Number(r.delta), 0)
  };
}
