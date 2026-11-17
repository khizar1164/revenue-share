/* A finished month, locked so nobody changes it by mistake.
 *
 * Andrew, 17 November: lock a previous month so nothing in it is changed by
 * accident, and unlock it when a correction is meant. Locking is a choice per
 * month, never automatic: in the first days of a month people are still
 * entering last month's claims and tardies.
 *
 * Only a finished month can be locked. The current one is where everything is
 * still being entered, and the background jobs rebuild it on their own.
 *
 * Every write that lands in a month asks here first. The table arrives with
 * db/023; until it exists nothing is locked, so the code can reach Render
 * before the migration does.
 */

import { query } from "./db.js";

let ready = false;
async function tableReady() {
  if (ready) return true;
  const r = await query(`select to_regclass('month_locks') is not null as ok`);
  return (ready = r.rows[0].ok);
}

/** "2026-10-01" style periods that are locked. */
export async function lockedPeriods() {
  if (!await tableReady()) return [];
  const r = await query(
    `select to_char(period,'YYYY-MM-DD') as period, locked_by, locked_at
       from month_locks order by period`);
  return r.rows;
}

/**
 * The first locked month any of these dates falls in, as "October 2026", or
 * null. A missing date means today, which is how every form defaults it.
 */
export async function lockedMonthFor(...dates) {
  if (!await tableReady()) return null;
  const list = dates.length ? dates.map(d => d == null || d === "" ? null : String(d instanceof Date ? d.toISOString() : d).slice(0, 10)) : [null];
  const r = await query(
    `select to_char(ml.period, 'FMMonth YYYY') as month
       from month_locks ml
      where ml.period in (select date_trunc('month', coalesce(d, current_date))::date
                            from unnest($1::date[]) as d)
      order by ml.period limit 1`, [list]);
  return r.rows[0]?.month ?? null;
}

/** Sends the refusal and returns true when a date is in a locked month. */
export async function refuseIfLocked(res, ...dates) {
  const month = await lockedMonthFor(...dates);
  if (!month) return false;
  res.status(423).json({ error: `${month} is locked, so nothing in it can be changed. ` +
    `Unlock it at the top of the admin page first.`, locked: month });
  return true;
}

export async function setLock(period, locked, by = "admin") {
  if (locked) {
    await query(
      `insert into month_locks (period, locked_by) values ($1::date, $2)
       on conflict (period) do nothing`, [period, by]);
  } else {
    await query(`delete from month_locks where period = $1::date`, [period]);
  }
}
