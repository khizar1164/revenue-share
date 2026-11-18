/* The write-up steps for real people: their points from the database, run
   through the rule in steps.js. Kept apart from steps.js so the rule itself
   stays checkable without a database. */
import { query, hasColumn } from "./db.js";
import { replay, STEPS } from "./steps.js";

const TZ = process.env.TIMEZONE || "America/Chicago";

/** Today in La Porte, as YYYY-MM-DD. The server's own clock runs on UTC. */
export function todayHere(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Where everyone stands on `asOf` (default today). Returns a Map of
 * employee id -> the replay result. Anyone with no points since the fresh
 * start is simply clean.
 */
export async function stepsFor(asOf = todayHere(), employeeIds = null) {
  const ev = await query(
    `select employee_id, to_char(occurred_on, 'YYYY-MM-DD') as d, -sum(delta)::int as lost
       from point_events
      where delta < 0 and recorded_by is distinct from 'demo'
        and occurred_on >= $1::date and occurred_on <= $2::date
        and ($3::uuid[] is null or employee_id = any($3::uuid[]))
      group by 1, 2`, [STEPS.from, asOf, employeeIds]);

  /* write-ups marked "not issued" under this rule (window_from is the day the
     count for that step began, never before the fresh start) */
  const notIssued = new Map();
  if (await hasColumn("discipline_notices", "outcome")) {
    const ni = await query(
      `select employee_id, level, to_char(window_to, 'YYYY-MM-DD') as d
         from discipline_notices
        where outcome = 'not_issued' and window_from >= $1::date`, [STEPS.from]);
    for (const n of ni.rows) {
      const s = notIssued.get(n.employee_id) ?? new Set();
      s.add(`${n.level}|${n.d}`);
      notIssued.set(n.employee_id, s);
    }
  }

  const byPerson = new Map();
  for (const r of ev.rows) {
    const list = byPerson.get(r.employee_id) ?? [];
    list.push({ date: r.d, lost: Number(r.lost) });
    byPerson.set(r.employee_id, list);
  }

  const out = new Map();
  const ids = employeeIds ?? [...new Set([...byPerson.keys(), ...notIssued.keys()])];
  for (const id of ids) {
    out.set(id, replay(byPerson.get(id) ?? [], { today: asOf, notIssued: notIssued.get(id) }));
  }
  return out;
}

/** A clean result, for anyone missing from the map. */
export const cleanStep = asOf => replay([], { today: asOf });
