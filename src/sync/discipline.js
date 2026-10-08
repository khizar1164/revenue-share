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
import { RULES } from "../calc.js";
import {
  configured, writingEnabled, status as ctStatus, taskLevels,
  findUser, findBoard, findLabel, createTask, taskText
} from "../connecteam.js";

const LEVELS = [
  ["termination", RULES.terminateAt],
  ["suspension",  RULES.suspendAt],
  ["warning",     RULES.warnAt]
];

/* Ordered worst first, so "is there already an open notice at this level or
   worse" is a straight index comparison. */
const RANK = { warning: 1, suspension: 2, termination: 3 };

export function levelFor(lost) {
  for (const [name, at] of LEVELS) if (lost >= at) return name;
  return null;
}

/** Everyone's lost points over the rolling window ending today. */
export async function standings(days = RULES.disciplineDays) {
  const r = await query(
    `select e.id, e.full_name, e.email,
            coalesce((select -sum(pe.delta) from point_events pe
                       where pe.employee_id = e.id
                         and pe.delta < 0
                         /* demo rows are a comparison, not something anybody
                            did, and must never discipline a real person */
                         and pe.recorded_by is distinct from 'demo'
                         and pe.occurred_on >  current_date - ($1 || ' days')::interval
                         and pe.occurred_on <= current_date), 0)::int as lost
       from employees e
      where e.is_mover and e.status = 'active'
      order by e.full_name`, [days]);

  return r.rows.map(p => ({ ...p, lost: Number(p.lost), level: levelFor(Number(p.lost)) }));
}

async function worstIncidents(employeeId, days, limit = 4) {
  const r = await query(
    `select to_char(occurred_on, 'Mon DD, YYYY') as date, delta, reason
       from point_events
      where employee_id = $1 and delta < 0
        and recorded_by is distinct from 'demo'
        and occurred_on >  current_date - ($2 || ' days')::interval
        and occurred_on <= current_date
      order by delta asc, occurred_on desc
      limit $3`, [employeeId, days, limit]);
  return r.rows.map(i => ({ ...i, delta: Number(i.delta) }));
}

/* ------------------------------------------------------------------------- */

/**
 * Look at where everyone stands and act on what changed.
 *
 *   dryRun   work it all out, create nothing, change nothing
 *
 * Returns a line for the job log, same as every other sync.
 */
export async function syncDiscipline({ dryRun = false, days = RULES.disciplineDays } = {}) {
  const people = await standings(days);

  const open = await query(
    `select employee_id, level, id from discipline_notices where cleared_at is null`);
  const openBy = new Map();
  for (const n of open.rows) {
    const list = openBy.get(n.employee_id) ?? [];
    list.push(n);
    openBy.set(n.employee_id, list);
  }

  const windowFrom = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const windowTo = new Date().toISOString().slice(0, 10);

  const raised = [], cleared = [], failed = [];
  const wanted = taskLevels();

  /* Who the task is for, looked up once. If Connecteam cannot say, tasks are
     skipped and the crossings still get recorded — the worst case is that
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
      /* A missing label is not a reason to withhold the task. Matthew filing
         it himself is a smaller problem than him never hearing about it. */
    } catch (e) {
      reachProblem = e.message;
    }
  }

  for (const p of people) {
    const mine = openBy.get(p.id) ?? [];
    const worstOpen = mine.reduce((a, n) => Math.max(a, RANK[n.level] ?? 0), 0);

    /* Fallen back under everything they were open at: those notices close, and
       the next time they cross the line it counts as a new one. */
    if (!p.level && mine.length) {
      if (!dryRun) {
        await query(`update discipline_notices set cleared_at = now()
                      where employee_id = $1 and cleared_at is null`, [p.id]);
      }
      cleared.push(p.full_name);
      continue;
    }
    if (!p.level) continue;

    /* Already open at this level or worse — nothing new has happened. */
    if (RANK[p.level] <= worstOpen) continue;

    const incidents = await worstIncidents(p.id, days);
    const { title, description } = taskText({
      name: p.full_name, level: p.level, lost: p.lost, windowFrom, windowTo, incidents
    });

    let taskId = null, taskError = null;
    if (!dryRun && wantTasks && assignee && board && wanted.has(p.level)) {
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
    } else if (!dryRun && wanted.has(p.level)) {
      taskError = reachProblem ?? "task creation skipped";
    }

    if (!dryRun) {
      await withTransaction(async c => {
        /* Crossing 30 settles the warning that came before it: the open
           question is now the bigger one, and leaving the old notice open
           would stop a later drop-and-recross from being seen. */
        await c.query(`update discipline_notices set cleared_at = now()
                        where employee_id = $1 and cleared_at is null`, [p.id]);
        await c.query(`insert into discipline_notices
                         (employee_id, level, lost, window_from, window_to, task_id, task_error)
                       values ($1,$2,$3,$4,$5,$6,$7)`,
          [p.id, p.level, p.lost, windowFrom, windowTo, taskId || null, taskError]);
      });
    }
    raised.push(`${p.full_name} ${p.level} at ${p.lost}`);
  }

  const parts = [];
  parts.push(raised.length ? `${raised.length} crossed: ${raised.join("; ")}` : "nobody newly over");
  if (cleared.length) parts.push(`${cleared.length} back under: ${cleared.join(", ")}`);
  if (failed.length) parts.push(`${failed.length} task(s) not created — ${failed.join("; ")}`);
  else if (raised.length && reachProblem) parts.push(`no task sent — ${reachProblem}`);
  if (dryRun) parts.push("(dry run — nothing written)");
  return parts.join(". ");
}
