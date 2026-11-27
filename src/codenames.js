/* Code names on the break-room TV, and how they change.
 *
 * Andrew, 21 Nov 2026: "when new hires come in they automatically know their
 * code name ... rotate names out each month and the movers will just have to
 * sign into their account to see their new name. Maybe start with next month."
 *
 * The crew could tell who a new hire was because names were handed out in a
 * fixed order (the next unused one on the list). Now:
 *   - a new hire gets a RANDOM free name;
 *   - on the 1st of every month, from December 2026, every mover gets a new
 *     random name: never the one they had, and never one anybody had the
 *     month before, so last month's board cannot be matched to this month's.
 * Each month's names are kept in code_name_history. Payout lines already
 * freeze the name used for that month.
 */
import { randomInt } from "node:crypto";
import { query, withTransaction } from "./db.js";

export const NAME_POOL = [
  "RANGER", "JAGUAR", "LYNX", "BEAR", "BISON", "RHINO", "WOLF", "OTTER", "FALCON", "HERON",
  "BADGER", "MARTEN", "STOAT", "OSPREY", "KESTREL", "RAVEN", "HAWK", "EAGLE", "PUMA", "TIGER",
  "COBRA", "VIPER", "MAMBA", "DINGO", "JACKAL", "CARIBOU", "MOOSE", "ELK", "STAG", "BOAR",
  "KODIAK", "MARLIN", "CONDOR", "PANTHER", "COUGAR", "GRIZZLY", "WOLVERINE", "BOBCAT", "COYOTE", "FOX",
  "MUSTANG", "BRONCO", "STALLION", "HORNET", "SCORPION", "BARRACUDA", "SHARK", "ORCA", "WALRUS", "BEAVER",
  "RACCOON", "MINK", "FERRET", "IBIS", "CRANE", "PELICAN", "ALBATROSS", "SPARROW", "MERLIN", "HARRIER",
  "GECKO", "IGUANA", "PYTHON", "GATOR", "BULL", "RAM", "YAK", "LLAMA", "ZEBRA", "GAZELLE",
  "IMPALA", "OKAPI", "TAPIR", "LEMUR", "MANDRILL", "GORILLA", "CHEETAH", "LEOPARD", "OCELOT", "SERVAL"
];

/** First of this month in Chicago, as YYYY-MM-01. */
export function chicagoPeriod(d = new Date()) {
  const [y, m] = d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" }).split("-");
  return `${y}-${m}-01`;
}

const pick = list => list[randomInt(list.length)];

/** A random name from the pool that nobody holds now. */
export async function freeCodeName(db = { query }) {
  const taken = new Set((await db.query(`select code_name from employees`)).rows.map(r => r.code_name));
  const free = NAME_POOL.filter(n => !taken.has(n));
  if (free.length) return pick(free);
  let i = taken.size + 1;
  while (taken.has(`CREW${i}`)) i++;
  return `CREW${i}`;
}

/**
 * Give every mover a new name for `period`. Office accounts (OFFICE-...) and
 * merged-away rows keep theirs. Runs once per month: a second call finds the
 * month already in code_name_history and does nothing.
 */
export async function rotateCodeNames({ period = chicagoPeriod(), dryRun = false } = {}) {
  return withTransaction(async db => {
    /* one rotation per month, even with two copies of the service */
    await db.query(`lock table code_name_history in exclusive mode`);
    const done = (await db.query(`select 1 from code_name_history where period = $1 limit 1`, [period])).rows[0];
    if (done) return { period, rotated: 0, note: "already rotated this month" };

    const all = (await db.query(`select id, code_name, is_mover, merged_into from employees`)).rows;
    const movers = all.filter(e => e.is_mover && !e.merged_into && !/^OFFICE-/i.test(e.code_name));
    const keep = new Set(all.filter(e => !movers.includes(e)).map(e => e.code_name));     // names that stay where they are
    const lastMonth = new Set(all.map(e => e.code_name));                                 // everything on show until today
    let fresh = NAME_POOL.filter(n => !keep.has(n) && !lastMonth.has(n));
    /* not enough names nobody has used: allow last month's, but never a person's own */
    const fallback = NAME_POOL.filter(n => !keep.has(n));
    const plan = [];
    const used = new Set();
    for (const e of movers.sort(() => randomInt(3) - 1)) {
      let options = fresh.filter(n => !used.has(n));
      if (!options.length) options = fallback.filter(n => !used.has(n) && n !== e.code_name);
      const name = options.length ? pick(options) : `CREW${randomInt(1000, 9999)}`;
      used.add(name);
      plan.push({ id: e.id, from: e.code_name, to: name });
    }
    if (dryRun) return { period, rotated: plan.length, dryRun: true, plan };

    /* names are unique: park everyone first, then hand the new names out */
    await db.query(`update employees set code_name = 'ROTATING-' || left(id::text, 8) where id = any($1::uuid[])`, [plan.map(p => p.id)]);
    for (const p of plan) await db.query(`update employees set code_name = $2 where id = $1`, [p.id, p.to]);
    await db.query(
      `insert into code_name_history (period, employee_id, code_name)
       select $1::date, id, code_name from employees where merged_into is null
       on conflict do nothing`, [period]);
    return { period, rotated: plan.length };
  });
}

/** The scheduled check: rotate on the first run of a new month, from ROTATE_CODE_NAMES_FROM (default December 2026). */
export async function maybeRotate() {
  const period = chicagoPeriod();
  const from = process.env.ROTATE_CODE_NAMES_FROM || "2026-12-01";
  if (/^(off|no|false)$/i.test(from) || period < from) return `not yet (starts ${from})`;
  const r = await rotateCodeNames({ period });
  return r.note ? `${period.slice(0, 7)}: ${r.note}` : `${period.slice(0, 7)}: ${r.rotated} movers have new code names`;
}
