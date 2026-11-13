/* The Rules page and the Write-ups page, from the 13 November meeting.
 *
 * Rules: Andrew could not see the point rules anywhere on the dashboard. They
 * lived in the admin page's dropdown, in the code. They are rows now, edited on
 * their own page so the main admin page doesn't get any longer.
 *
 * Write-ups: every notice the discipline check has raised, with a step to say
 * whether it was actually given, so one that never happened can be told apart.
 * The admin page pops up a newly raised one.
 *
 * Both work before db/022 is applied. Render deploys on a merge and the
 * migrations are run by hand, so there is always a window where the code is
 * ahead of the schema: the dropdown falls back to the built-in list and the
 * pages say the database needs updating rather than failing.
 */
import { query, hasColumn } from "./db.js";
import { RULES } from "./calc.js";
import { PENALTY } from "./sync/tardy.js";

/* Andrew's finalised sheet, 28 September 2026. The same rows db/022 seeds;
   used only until that migration has run. */
export const DEFAULT_RULES = [
  ["Most job photos submitted", 3],
  ["Came in same day", 1],
  ["Policy violation", -1],
  ["Up to 30 mins late", -1],
  ["Applicable material/equipment not removed from truck", -1],
  ["Truck not restocked", -1],
  ["Truck cleanliness not acceptable", -1],
  ["Equipment/pads not neatly organized on truck", -1],
  ["Not out by shop time", -1],
  ["Failure to perform pre-inspection walkthrough properly", -1],
  ["31 to 60 mins late", -2],
  ["Stopped before first job without need for fuel (15-20% or less)", -2],
  ["Customer complaint — vaping/smoking in sight of customer", -2],
  ["Call off — unable to work scheduled shift when time off was not requested in advance", -2],
  ["61+ mins late", -3],
  ["Same day call off", -3],
  ["Claim", -3],
  ["Customer complaint — specifically names you", -5],
  ["No call no show — tardiness not communicated within 30 minutes of shift start", -10]
].map(([label, points], i) => ({ id: null, label, points, sort: (i + 1) * 10 }));

const rulesTable = () => query(`select to_regclass('point_rules') is not null as ok`).then(r => r.rows[0].ok);
const tracking = () => hasColumn("discipline_notices", "outcome");

/* The rules the system applies on its own. Shown on the Rules page so the
   whole picture is in one place; changing these is a code change. */
function fixedRules() {
  return {
    startPoints: RULES.startPoints,
    window: RULES.disciplineDays,
    thresholds: [
      { level: "Written warning", at: RULES.warnAt },
      { level: "Suspension", at: RULES.suspendAt },
      { level: "Termination", at: RULES.terminateAt }
    ],
    tardyLog: [
      { what: "Late 2 to 30 minutes", points: -1 },
      { what: "Late 31 to 60 minutes", points: -2 },
      { what: "Late 61 minutes or more", points: -3 },
      { what: "Truck not out on time", points: PENALTY.truck },
      { what: "Call off", points: PENALTY.calloff },
      { what: "Same day call off", points: PENALTY.samedaycalloff },
      { what: "No call no show", points: PENALTY.nocallnoshow }
    ]
  };
}

function cleanRule(body) {
  const label = String(body?.label ?? "").replace(/\s+/g, " ").trim();
  const points = Number(body?.points);
  if (!label) return { error: "say what the rule is" };
  if (label.length > 120) return { error: "keep the rule under 120 characters" };
  if (!Number.isInteger(points) || points === 0) return { error: "points must be a whole number other than 0" };
  if (Math.abs(points) > 50) return { error: "points must be between -50 and 50" };
  return { label, points };
}

const NOTICE_COLS = `n.id, n.employee_id, e.full_name, e.code_name, n.level, n.lost,
  to_char(n.window_from, 'YYYY-MM-DD') as window_from, to_char(n.window_to, 'YYYY-MM-DD') as window_to,
  n.raised_at, n.cleared_at, n.task_id, n.task_error`;
const OUTCOME_COLS = `, n.outcome, to_char(n.outcome_on, 'YYYY-MM-DD') as outcome_on,
  n.outcome_note, n.outcome_by, n.outcome_at, n.seen_at`;

export function mountAdminPages(app, wrap) {
  /* ---------------------------------------------------------- rules --- */
  app.get("/api/admin/rules", wrap(async (_req, res) => {
    const editable = await rulesTable();
    const rules = editable
      ? (await query(`select id, label, points, sort from point_rules order by points desc, sort, id`)).rows
      : DEFAULT_RULES;
    res.json({ editable, rules, fixed: fixedRules() });
  }));

  app.post("/api/admin/rules", wrap(async (req, res) => {
    if (!await rulesTable()) return res.status(409).json({ error: "the database needs updating first (db/022)" });
    const r = cleanRule(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    const row = (await query(
      `insert into point_rules (label, points, sort, updated_by)
       values ($1, $2, (select coalesce(max(sort), 0) + 10 from point_rules), 'admin')
       returning id, label, points, sort`, [r.label, r.points])).rows[0];
    res.status(201).json(row);
  }));

  app.put("/api/admin/rules/:id", wrap(async (req, res) => {
    if (!await rulesTable()) return res.status(409).json({ error: "the database needs updating first (db/022)" });
    const r = cleanRule(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    const row = (await query(
      `update point_rules set label = $2, points = $3, updated_by = 'admin', updated_at = now()
        where id = $1 returning id, label, points, sort`, [req.params.id, r.label, r.points])).rows[0];
    if (!row) return res.status(404).json({ error: "no such rule" });
    res.json(row);
  }));

  app.delete("/api/admin/rules/:id", wrap(async (req, res) => {
    if (!await rulesTable()) return res.status(409).json({ error: "the database needs updating first (db/022)" });
    const r = await query(`delete from point_rules where id = $1`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "no such rule" });
    res.status(204).end();
  }));

  /* ------------------------------------------------------- write-ups --- */
  app.get("/api/admin/notices", wrap(async (_req, res) => {
    const tracked = await tracking();
    const rows = (await query(
      `select ${NOTICE_COLS}${tracked ? OUTCOME_COLS : ""}
         from discipline_notices n join employees e on e.id = n.employee_id
        order by n.raised_at desc, n.id desc`)).rows;
    res.json({ tracking: tracked, notices: rows });
  }));

  app.put("/api/admin/notices/:id/outcome", wrap(async (req, res) => {
    if (!await tracking()) return res.status(409).json({ error: "the database needs updating first (db/022)" });
    const outcome = req.body?.outcome ?? null;
    if (![null, "issued", "not_issued"].includes(outcome)) {
      return res.status(400).json({ error: "outcome must be issued, not_issued or null" });
    }
    const on = outcome === "issued" ? String(req.body?.on ?? "").trim() : "";
    if (outcome === "issued" && !/^\d{4}-\d{2}-\d{2}$/.test(on)) {
      return res.status(400).json({ error: "say the day it was given, like 2026-11-14" });
    }
    const note = String(req.body?.note ?? "").trim().slice(0, 300) || null;
    const r = await query(
      `update discipline_notices
          set outcome = $2, outcome_on = $3, outcome_note = $4,
              outcome_by = case when $2::text is null then null else 'admin' end,
              outcome_at = case when $2::text is null then null else now() end,
              seen_at = coalesce(seen_at, now())
        where id = $1 returning id`,
      [req.params.id, outcome, on || null, outcome ? note : null]);
    if (!r.rowCount) return res.status(404).json({ error: "no such notice" });
    res.json({ ok: true });
  }));

  /* The pop-up on the admin page: notices nobody has looked at yet, and the
     count still waiting for an outcome, for the badge on the header link. */
  app.get("/api/admin/notices/alerts", wrap(async (_req, res) => {
    if (!await tracking()) return res.json({ tracking: false, unseen: [], pending: 0 });
    const unseen = (await query(
      `select ${NOTICE_COLS}
         from discipline_notices n join employees e on e.id = n.employee_id
        where n.seen_at is null order by n.raised_at`)).rows;
    const pending = (await query(
      `select count(*)::int n from discipline_notices where outcome is null`)).rows[0].n;
    res.json({ tracking: true, unseen, pending });
  }));

  app.post("/api/admin/notices/seen", wrap(async (req, res) => {
    if (!await tracking()) return res.json({ ok: true });
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter(x => /^\d+$/.test(x));
    if (ids.length) {
      await query(`update discipline_notices set seen_at = now()
                    where id = any($1::bigint[]) and seen_at is null`, [ids]);
    }
    res.json({ ok: true });
  }));
}
