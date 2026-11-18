/* Who has crossed a discipline threshold, and telling Matthew about it.
 *
 * Andrew, 3 October: "create a quick task in connecteam for matthew under
 * Payroll." The points were already doing the work — 15 lost in a rolling 60
 * days is a written warning, 30 is a suspension, 45 is termination — but
 * knowing it required somebody to go and look. This goes and looks.
 *
 * The window is the 60 days to today, not the calendar month. That is how the
 * rule is written and how Andrew describes it, and it matters: somebody can
 * cross 15 on the third of the month on the strength of incidents from the
 * month before.
 *
 * Three things this deliberately does not do.
 *
 * It does not decide anything. Crossing 15 means a conversation is due, and
 * the handbook (6.2) leaves the decision with the supervisor either way. The
 * task says a threshold was crossed and what the record shows. It does not say
 * anyone is suspended.
 *
 * It does not raise the same thing twice. A notice stays open until the person
 * drops back under that threshold, and while it is open nothing at that level
 * is raised again — otherwise a half-hourly check would hand Matthew the same
 * task forty-eight times a day.
 *
 * It does not need Connecteam. The crossing is recorded whether or not a task
 * can be created, so switching the integration on later does not mean the
 * weeks before it were never watched. A crossing that should have raised a
 * task and could not keeps the reason, where somebody can see it.
 */
import { query, withTransaction } from "../db.js";
import { STEPS, RANK } from "../steps.js";
import { stepsFor, todayHere } from "../steps-db.js";
import {
  configured, writingEnabled, status as ctStatus, taskLevels,
  findUser, findBoard, findLabel, createTask, taskText
} from "../connecteam.js";

/* 18 November 2026: the rolling 60-day thresholds (15, 30, 45) are replaced
   by steps, worked out in src/steps.js. What stays from the original design
   below: it decides nothing, it never raises the same write-up twice, and it
   records a write-up whether or not Connecteam can be told. */

/** The deductions that make up one write-up, worst first. */
async function incidentsBetween(employeeId, from, to, limit = 4) {
  const r = await query(
    `select to_char(occurred_on, 'Mon DD, YYYY') as date, delta, reason
       from point_events
      where employee_id = $1 and delta < 0
        and recorded_by is distinct from 'demo'
        and occurred_on >= $2::date and occurred_on <= $3::date
      order by delta asc, occurred_on desc
      limit $4`, [employeeId, from, to, limit]);
  return r.rows.map(i => ({ ...i, delta: Number(i.delta) }));
}

/* ------------------------------------------------------------------------- */

/**
 * Work out everyone's step and act on what changed.
 *
 *   dryRun   work it all out, create nothing, change nothing
 *
 * Returns a line for the job log, same as every other sync.
 */
export async function syncDiscipline({ dryRun = false } = {}) {
  const today = todayHere();
  const people = (await query(
    `select id, full_name, email from employees
      where is_mover and status = 'active' order by full_name`)).rows;
  const steps = await stepsFor(today, people.map(p => p.id));

  /* write-ups already raised under the step rule */
  const existing = (await query(
    `select id, employee_id, level, to_char(window_to, 'YYYY-MM-DD') as d, cleared_at
       from discipline_notices where window_from >= $1::date`, [STEPS.from])).rows;
  const have = new Set(existing.map(n => `${n.employee_id}|${n.level}|${n.d}`));

  const raised = [], cleared = [], failed = [];
  const wanted = taskLevels();

  /* The fresh start: anything still open from the 60-day rule is closed, so
     nobody begins November carrying a write-up. The rows stay as the record. */
  const old = await query(
    `select count(*)::int as n from discipline_notices
      where cleared_at is null and window_from < $1::date`, [STEPS.from]);
  if (old.rows[0].n) {
    if (!dryRun) {
      await query(`update discipline_notices set cleared_at = now()
                    where cleared_at is null and window_from < $1::date`, [STEPS.from]);
    }
    cleared.push(`${old.rows[0].n} from the old 60-day rule`);
  }

  /* Who the task is for, looked up once. If Connecteam cannot say, tasks are
     skipped and the write-ups still get recorded — the worst case is that
     Matthew is told late, not that nobody ever knew. */
  let assignee = null, board = null, label = null, reachProblem = ctStatus();
  const wantTasks = !dryRun && configured() && writingEnabled();
  if (wantTasks) {
    try {
      assignee = await findUser({
        email: process.env.CONNECTEAM_ASSIGNEE_EMAIL,
        name: process.env.CONNECTEAM_ASSIGNEE || "Matthew Brown"
      });
      board = await findBoard();
      if (board) label = await findLabel(board.id ?? board.taskBoardId);
      if (!assignee) reachProblem = "nobody in Connecteam matches the assignee";
      else if (!board) reachProblem = "no Connecteam task board to put it on";
    } catch (e) {
      reachProblem = e.message;
    }
  }

  for (const p of people) {
    const s = steps.get(p.id);
    if (!s) continue;

    for (const w of s.write_ups) {
      if (have.has(`${p.id}|${w.level}|${w.date}`)) continue;

      const incidents = await incidentsBetween(p.id, w.count_from, w.date);
      const { title, description } = taskText({
        name: p.full_name, level: w.level, lost: w.points,
        windowFrom: w.count_from, windowTo: w.date, incidents, why: w.why
      });

      let taskId = null, taskError = null;
      if (!dryRun && wantTasks && assignee && board && wanted.has(w.level)) {
        try {
          const task = await createTask({
            boardId: board.id ?? board.taskBoardId,
            userIds: [assignee.userId],
            labelIds: label ? [label.id] : undefined,
            title, description
          });
          taskId = String(task?.id ?? task?.taskId ?? "");
        } catch (e) {
          taskError = e.message;
          failed.push(`${p.full_name}: ${e.message.slice(0, 90)}`);
        }
      } else if (!dryRun && wanted.has(w.level)) {
        taskError = reachProblem ?? "task creation skipped";
      }

      if (!dryRun) {
        await query(`insert into discipline_notices
                       (employee_id, level, lost, window_from, window_to, task_id, task_error)
                     values ($1,$2,$3,$4,$5,$6,$7)`,
          [p.id, w.level, w.points, w.count_from, w.date, taskId || null, taskError]);
      }
      have.add(`${p.id}|${w.level}|${w.date}`);
      raised.push(`${p.full_name} ${w.level} on ${w.date}${w.why ? ` (${w.why})` : ""}`);
    }

    /* Only the write-up for the step they are on now stays open. One they
       stepped down from, or that a higher one replaced, closes. */
    const keep = s.step > 0 && s.last_write_up && RANK[s.last_write_up.level] === s.step
      ? `${s.last_write_up.level}|${s.last_write_up.date}` : null;
    const toClose = existing.filter(n => n.employee_id === p.id && !n.cleared_at
      && `${n.level}|${n.d}` !== keep);
    if (toClose.length) {
      if (!dryRun) {
        await query(`update discipline_notices set cleared_at = now() where id = any($1::bigint[])`,
          [toClose.map(n => n.id)]);
      }
      cleared.push(`${p.full_name} now ${s.level ?? "clean"}`);
    }
  }

  /* Crossings recorded while Connecteam was unreachable or switched off.
     Without this the promise the rest of this file makes — that turning the
     integration on later does not mean the weeks before went unwatched — is
     only half true: the record would exist and nobody would ever be told. A
     notice is retried while it is still open, because a person who is still
     over the line still needs the conversation. Once they drop back under,
     the moment has passed and chasing it would just be noise. */
  const caughtUp = [];
  if (wantTasks && assignee && board) {
    const owed = await query(
      /* As text, formatted by Postgres. A date column arrives as a JS Date,
         and String()ing that gives "Thu Oct 08 2026 ..." — which is how a
         task went out reading "the 60 days to Thu Oct 08". */
      `select n.id, n.level, n.lost,
              to_char(n.window_from, 'YYYY-MM-DD') as window_from,
              to_char(n.window_to,   'YYYY-MM-DD') as window_to,
              e.id as employee_id, e.full_name
         from discipline_notices n
         join employees e on e.id = n.employee_id
        where n.cleared_at is null and n.task_id is null and n.task_error is not null
        order by n.raised_at`);

    for (const n of owed.rows) {
      if (!wanted.has(n.level)) continue;
      const incidents = await incidentsBetween(n.employee_id, n.window_from, n.window_to);
      const { title, description } = taskText({
        name: n.full_name, level: n.level, lost: n.lost,
        windowFrom: n.window_from,
        windowTo: n.window_to,
        incidents
      });
      try {
        const task = await createTask({
          boardId: board.id ?? board.taskBoardId,
          userIds: [assignee.userId],
          labelIds: label ? [label.id] : undefined,
          title, description
        });
        await query(`update discipline_notices set task_id = $1, task_error = null where id = $2`,
          [String(task?.id ?? task?.taskId ?? ""), n.id]);
        caughtUp.push(n.full_name);
      } catch (e) {
        await query(`update discipline_notices set task_error = $1 where id = $2`,
          [e.message, n.id]);
        failed.push(`${n.full_name}: ${e.message.slice(0, 90)}`);
      }
    }
  }

  const parts = [];
  parts.push(raised.length ? `${raised.length} new write-up(s): ${raised.join("; ")}` : "no new write-ups");
  if (cleared.length) parts.push(`closed: ${cleared.join(", ")}`);
  if (caughtUp.length) parts.push(`${caughtUp.length} caught up: ${caughtUp.join(", ")}`);
  if (failed.length) parts.push(`${failed.length} task(s) not created — ${failed.join("; ")}`);
  else if (raised.length && reachProblem) parts.push(`no task sent — ${reachProblem}`);
  if (dryRun) parts.push("(dry run — nothing written)");
  return parts.join(". ");
}
