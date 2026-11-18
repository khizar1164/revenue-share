/* Write-up steps. Andrew and Matthew, 18 November 2026.
 *
 * Replaces the rolling 60-day count, which wrote the same person up again
 * every time a few old points dropped off and one new one landed (Jordan on 2
 * and 4 November). The rule now:
 *
 *   Everyone starts clean on 1 November 2026. Points before that are kept but
 *   never count towards a write-up.
 *
 *   Warning      15 points lost within 30 days.
 *   Suspension   15 NEW points after the warning, before 30 days pass.
 *   Termination  15 new points after the suspension, before 30 days pass,
 *                or a third suspension within 365 days.
 *
 *   Overflow carries: reach 18 on the day of a write-up and 15 pay for it,
 *   3 start the next step.
 *
 *   30 days with no new write-up steps you down one, and the count starts
 *   again from zero that day. From a suspension that is 60 days to clean.
 *   Termination does not step down.
 *
 *   A write-up marked "not issued" never happened: the 15 points it would
 *   have used are let go and the person stays on the step they were on.
 *
 * Everything is worked out again from 1 November each time, so a point typed
 * in late with an earlier date lands where it belongs. This file is pure: the
 * dates in, the steps out, so the rule can be checked without a database.
 */

export const STEPS = {
  from: "2026-11-01",
  needed: 15,
  days: 30,
  suspensionsForTermination: 3,
  suspensionYear: 365
};

export const LEVELS = [null, "warning", "suspension", "termination"];
export const RANK = { warning: 1, suspension: 2, termination: 3 };

const D = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
export const addDays = (s, n) => new Date(D(s) + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 864e5);

/**
 * events     [{ date: "YYYY-MM-DD", lost: 3 }]   lost is positive
 * today      the last day to count ("as of")
 * notIssued  Set of "level|YYYY-MM-DD" for write-ups marked not issued
 *
 * Returns where the person stands on `today` and every write-up on the way.
 */
export function replay(events, { today, from = STEPS.from, notIssued = new Set(), rules = STEPS } = {}) {
  const byDay = new Map();
  for (const e of events) {
    if (!e || !(e.lost > 0) || e.date < from || e.date > today) continue;
    byDay.set(e.date, (byDay.get(e.date) ?? 0) + Number(e.lost));
  }

  let step = 0;           // 0 clean, 1 warning, 2 suspension, 3 termination
  let anchor = from;      // last write-up or step-down: the 30 days run from here
  let countStart = from;  // first day whose points count toward the next step
  let acc = 0;            // points toward the next step, once on a step
  let carry = 0;          // what the last write-up carried over
  let recent = [];        // [date, pts] for the rolling 30 days while clean
  const writeUps = [], stepDowns = [], forgiven = [], suspensions = [];

  const escalate = (d, total) => {
    while (total >= rules.needed && step < 3) {
      const next = step + 1;
      const level = LEVELS[next];
      const countFrom = step === 0 ? recent[0]?.[0] ?? d : countStart;
      if (notIssued.has(`${level}|${d}`)) {
        forgiven.push({ level, date: d });
        total -= rules.needed;
        continue;
      }
      const counted = total;
      total -= rules.needed;
      step = next;
      anchor = d;
      countStart = d;
      let why = null;
      if (step === 2) {
        suspensions.push(d);
        const inYear = suspensions.filter(s => daysBetween(s, d) < rules.suspensionYear).length;
        if (inYear >= rules.suspensionsForTermination) {
          step = 3;
          why = `third suspension within ${rules.suspensionYear} days`;
        }
      }
      writeUps.push({ level: LEVELS[step], date: d, points: counted, count_from: countFrom, why });
    }
    carry = step > 0 ? total : 0;
    acc = step > 0 ? total : 0;
    recent = step === 0 && total > 0 ? [[d, total]] : [];
  };

  if (today >= from) {
    for (let d = from; d <= today; d = addDays(d, 1)) {
      const pts = byDay.get(d) ?? 0;
      if (step === 0) {
        if (pts) recent.push([d, pts]);
        const cut = addDays(d, -rules.days);           // older than 30 days
        recent = recent.filter(([x]) => x > cut && x >= countStart);
        const total = recent.reduce((a, [, p]) => a + p, 0);
        if (total >= rules.needed) escalate(d, total);
      } else if (step < 3) {
        acc += pts;
        if (acc >= rules.needed) escalate(d, acc);
      }
      /* Step down at the end of the 30th day. Andrew's example: a warning on
         day 20 and 15 more on day 50 is a suspension, so day 50 is still
         inside the 30 days; with nothing new by the end of day 80 it drops
         back. The count then starts again from zero the next day. */
      if ((step === 1 || step === 2) && d === addDays(anchor, rules.days)) {
        stepDowns.push({ from: LEVELS[step], to: LEVELS[step - 1], date: d });
        step -= 1;
        anchor = d;
        countStart = addDays(d, 1);
        acc = 0;
        carry = 0;
        recent = [];
      }
    }
  }

  const clean = step === 0;
  const points = clean ? recent.reduce((a, [, p]) => a + p, 0) : step < 3 ? acc : 0;
  /* while clean, only the last 30 days count, and never before the day they
     became clean */
  const countFrom = clean
    ? ([addDays(today, -rules.days + 1), countStart].sort().at(-1))
    : countStart;
  return {
    level: LEVELS[step],
    step,
    points,                                   // toward the next step
    needed: rules.needed,
    carry,                                    // of `points`, carried from the last write-up
    count_from: today >= from ? countFrom : from,
    steps_down_on: step === 1 || step === 2 ? addDays(anchor, rules.days) : null,
    last_write_up: writeUps.at(-1) ?? null,
    write_ups: writeUps,
    step_downs: stepDowns,
    forgiven,
    suspensions_in_year: suspensions.filter(s => daysBetween(s, today) < rules.suspensionYear).length
  };
}
