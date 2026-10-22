/* Andrew, 22 October: "can you make it so that anybody that is marked as
   'Left, no notice' and has no hours does not show up on current or future
   months from the date they were marked ... I dont want the list to keep
   growing too long as staff come and go."

   The rule is read off the hours, not off a stored decision, so this proves
   the three things that can go wrong with it:

     - somebody who walked out and worked none of the month is gone,
     - the month they DID work still has them, because that month's pay was
       split with them in it and must not move afterwards,
     - and a leaver with hours this month stays until the month they stop.

   Read-only: it asserts against whatever rows the database already holds,
   so it is safe to point at production. */
import { query, close } from "../src/db.js";
import { monthly } from "../src/calc.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const periods = (await query(
  `select to_char(d, 'YYYY-MM-DD') as p
     from generate_series(date_trunc('month', current_date) - interval '3 months',
                          date_trunc('month', current_date) + interval '1 month',
                          interval '1 month') d
    order by d`)).rows.map(r => r.p);

console.log("\nLEFT, NO NOTICE — WHO THE MONTH SHOWS\n");

for (const period of periods) {
  const [y, m] = period.split("-").map(Number);
  const rows = (await monthly(y, m)).rows;
  const shown = new Set(rows.map(r => r.employee_id));

  const leavers = (await query(
    `select e.id, e.full_name, e.ended_on, coalesce(h.hours, 0)::float8 as hours
       from employees e
       left join hours h on h.employee_id = e.id and h.period = $1::date
      where e.is_mover and e.status = 'no_notice'`, [period])).rows;

  for (const p of leavers) {
    const end = p.ended_on;
    const marked = end && end < new Date(Date.UTC(m === 12 ? y + 1 : y, m % 12, 1));
    const label = `${period.slice(0, 7)} ${p.full_name} (${p.hours}h)`;
    if (marked && p.hours === 0) {
      check(`${label} is gone`, !shown.has(p.id));
    } else {
      check(`${label} still shows`, shown.has(p.id),
            marked ? "worked this month" : "marked later");
    }
  }
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall good\n");
await close();
process.exit(failures ? 1 : 0);
