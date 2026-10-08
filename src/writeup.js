/* Build one person's disciplinary notice, from their actual record.
 *
 * Andrew, 9 October: Matthew should be able to pick a name and get the write-up,
 * rather than asking for one. So everything the notice needs is assembled here
 * from the same points the dashboard shows, the notice is filled, and Chrome
 * turns it into a PDF with the supervisor's boxes as real form fields.
 *
 * The honest limits of what this can say, which are design decisions rather
 * than gaps:
 *
 *   Claims are recorded against a job, not against a person. So a claim is
 *   only ever stated as "a claim of £X is recorded against job N, and you were
 *   on the crew for that job". It never says somebody cost the company money,
 *   because the data does not know that and a write-up is not the place to
 *   guess.
 *
 *   Nothing here decides anything. Crossing 15 means a conversation is due;
 *   the handbook (6.2) leaves the decision with the supervisor either way.
 *
 *   The three supervisor boxes come out empty and editable. The system knows
 *   what happened; it does not know what was said in the last conversation or
 *   what Matthew is going to ask for, and inventing either would be worse than
 *   leaving the box blank.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "./db.js";
import { RULES } from "./calc.js";
import { fill, valueFor, fieldValues } from "../hr/render-notice.mjs";
import { makeFillable } from "../hr/make-fillable.mjs";

const day = d => String(d).slice(0, 10);

/** Everything the notice needs about one person, over the rolling window. */
export async function noticeData(employeeId, { days = RULES.disciplineDays, issued } = {}) {
  const who = await query(
    `select id, full_name, code_name, status from employees where id = $1`, [employeeId]);
  if (!who.rowCount) throw new Error("no such person");
  const person = who.rows[0];

  const windowTo = day(issued ?? new Date().toISOString());
  const from = new Date(new Date(windowTo).getTime() - days * 864e5);
  const windowFrom = day(from.toISOString());

  /* Every deduction in the window, oldest first, which is how the table on
     page 1 reads: a sequence rather than a league table. */
  const incidents = (await query(
    `select to_char(occurred_on, 'YYYY-MM-DD') as date, delta, reason
       from point_events
      where employee_id = $1
        and delta < 0
        and recorded_by is distinct from 'demo'
        and occurred_on >  $2::date
        and occurred_on <= $3::date
      order by occurred_on, id`, [employeeId, windowFrom, windowTo])).rows
    .map(i => ({ ...i, delta: Number(i.delta) }));

  /* Claims on jobs this person crewed. The join is the only link that exists:
     claims carry a job number, and SmartMoving says who was on that job. */
  const claims = (await query(
    `select distinct to_char(c.occurred_on, 'YYYY-MM-DD') as date,
            c.job_number, c.amount, c.reason
       from claims c
       join sm_jobs j        on j.job_number = c.job_number
       join sm_job_crew jc   on jc.job_id = j.job_id
       join employees e      on e.sm_crew_id = jc.sm_crew_id
      where e.id = $1
        and c.occurred_on >  $2::date
        and c.occurred_on <= $3::date
      order by date`, [employeeId, windowFrom, windowTo])).rows
    .map(c => ({ ...c, amount: Number(c.amount), onCrew: true }));

  /* Where they stand today, not where they stood when the month opened. */
  const now = await query(
    `select coalesce(sum(delta), 0)::int as pts
       from point_events
      where employee_id = $1
        and recorded_by is distinct from 'demo'
        and date_trunc('month', occurred_on) = date_trunc('month', $2::date)`,
    [employeeId, windowTo]);

  return {
    employee: person.full_name,
    supervisor: process.env.WRITEUP_SUPERVISOR || "Matthew Brown",
    issued: windowTo,
    pointsNow: Number(now.rows[0].pts) + RULES.startPoints,
    windowFrom, windowTo,
    incidents, claims,
    value: valueFor(incidents)
  };
}

/**
 * The finished PDF, as bytes.
 *
 * Both Chrome passes happen in a directory of this call's own, so two people
 * generating at once cannot read each other's half-written files, and the
 * directory goes whether or not it worked.
 */
export async function writeUpPdf(employeeId, opts = {}) {
  const data = await noticeData(employeeId, opts);
  const work = mkdtempSync(join(tmpdir(), "writeup-"));
  try {
    const htmlPath = join(work, "notice.html");
    writeFileSync(htmlPath, fill(data, { fillable: true }));
    const outPath = join(work, "notice.pdf");
    await makeFillable({ htmlPath, outPath, values: fieldValues(data) });
    return { bytes: readFileSync(outPath), data };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** A filename somebody can find again in their downloads folder. */
export function writeUpFilename(data) {
  const name = data.employee.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `write-up-${name}-${data.issued}.pdf`;
}
