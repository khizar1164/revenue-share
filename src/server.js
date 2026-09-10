/* HTTP server.
 *
 * Deliberately not Next.js. The prototype Andrew signed off is ~700 lines of
 * working vanilla JS; re-expressing it in React would buy nothing for a screen
 * that displays numbers on a wall, and would add a build step, a framework and
 * a few hundred packages to something one person has to keep running. So: a
 * small Express app that serves the approved markup and a JSON API behind it.
 *
 * Three surfaces, three levels of access:
 *   /tv/:token   no login, code names only, protected by being unguessable
 *   /me          email sign-in, one person's own figures
 *   /admin       restricted list, everything
 */

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { monthly, forEmployee } from "./calc.js";
import { boardView, reportView, adminView } from "./views.js";
import { query, loadEnv, safeTarget } from "./db.js";
import { createScheduler } from "./scheduler.js";
import { registerJobs } from "./jobs.js";
import { issueLoginToken, consumeLoginToken, sessionFor, endSession,
         readCookie, setSessionCookie, clearSessionCookie, isAdmin } from "./auth.js";
import { sendSignInLink, mailConfigured } from "./mail.js";

loadEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

/* The TV URL carries a token instead of a login. Long and random, set once. */
const TV_TOKEN = process.env.TV_TOKEN || "dev-only-token";

/* Which month are we showing? Defaults to now, overridable for testing. */
function askedPeriod(req) {
  const q = String(req.query.month ?? "");
  const m = q.match(/^(\d{4})-(\d{2})$/);
  if (m) return { year: +m[1], month: +m[2] };
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(`${req.method} ${req.path} failed:`, e.message);
  res.status(500).json({ error: "something went wrong working that out" });
});

/* ------------------------------------------------------------ the board ---- */

app.get("/api/board/:token", wrap(async (req, res) => {
  if (req.params.token !== TV_TOKEN) return res.status(404).json({ error: "not found" });
  const { year, month } = askedPeriod(req);
  res.set("cache-control", "no-store");
  res.json(boardView(await monthly(year, month)));
}));

/* ------------------------------------------------------------- sign in ---- */

const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;

/**
 * Ask for a link.
 *
 * The reply is the same whether or not the address is on the roster. Otherwise
 * this page becomes a way to find out who works here, one address at a time.
 */
app.post("/api/auth/request", wrap(async (req, res) => {
  const said = { ok: true,
    message: "If that address is on the roster, a sign-in link is on its way." };

  if (!mailConfigured()) {
    return res.status(503).json({ error: "email is not configured yet" });
  }

  const issued = await issueLoginToken(req.body?.email, {
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress
  });
  if (!issued) return res.json(said);          // deliberately indistinguishable

  try {
    await sendSignInLink({
      to: issued.employee.email,
      name: issued.employee.full_name,
      url: `${PUBLIC_URL}/auth/${issued.token}`,
      minutes: issued.expiresInMinutes
    });
  } catch (e) {
    console.error("could not send sign-in link:", e.message);
    return res.status(502).json({ error: "the email could not be sent just now" });
  }
  res.json(said);
}));

/** Spend the link, start a session, land on the report. */
app.get("/auth/:token", wrap(async (req, res) => {
  const session = await consumeLoginToken(req.params.token, {
    userAgent: req.headers["user-agent"]
  });
  if (!session) {
    return res.redirect("/me?expired=1");
  }
  setSessionCookie(res, session.token, { secure: PUBLIC_URL.startsWith("https") });
  res.redirect("/me");
}));

app.post("/api/auth/logout", wrap(async (req, res) => {
  await endSession(readCookie(req));
  clearSessionCookie(res);
  res.json({ ok: true });
}));

/* ----------------------------------------------------------- my report ---- */

/** Who is asking? The cookie decides — never the URL. */
async function currentEmployee(req) {
  return sessionFor(readCookie(req));
}

app.get("/api/me", wrap(async (req, res) => {
  const me = await currentEmployee(req);
  if (!me) return res.status(401).json({ error: "not signed in" });
  const { year, month } = askedPeriod(req);
  const detail = await forEmployee(year, month, me.id);
  if (!detail) return res.status(404).json({ error: "no report for you this month" });
  res.json(reportView(detail));
}));

/**
 * By id — the preview route, for looking at any report before sign-in exists.
 * It answers only while previewing is switched on, and a real session always
 * overrides the id in the URL so a signed-in mover cannot read someone else's.
 */
app.get("/api/me/:employeeId", wrap(async (req, res) => {
  const me = await currentEmployee(req);
  const previewing = process.env.ALLOW_REPORT_PREVIEW !== "off";
  if (!me && !previewing) return res.status(401).json({ error: "not signed in" });

  const id = me ? me.id : req.params.employeeId;
  const { year, month } = askedPeriod(req);
  const detail = await forEmployee(year, month, id);
  if (!detail) return res.status(404).json({ error: "no report for that person this month" });
  res.json(reportView(detail));
}));

/* --------------------------------------------------------------- admin ---- */

app.get("/api/admin/summary", wrap(async (req, res) => {
  const { year, month } = askedPeriod(req);
  res.json(adminView(await monthly(year, month)));
}));

app.get("/api/admin/roster", wrap(async (_req, res) => {
  const r = await query(
    `select id, code_name, full_name, status, sm_crew_id, email, is_mover
       from employees where status <> 'left' and is_mover order by code_name`);
  res.json(r.rows);
}));

/* job number -> the crew who worked it. This is the lookup that makes logging
   a review two fields and a tap. */
app.get("/api/admin/job/:jobNumber", wrap(async (req, res) => {
  const r = await query(
    `select j.job_number, j.service_date, j.completed_at,
            e.id, e.code_name, e.full_name
       from sm_jobs j
       join sm_job_crew jc on jc.job_id = j.job_id
       join employees e    on e.sm_crew_id = jc.sm_crew_id
      where j.job_number = $1
      order by e.full_name`, [req.params.jobNumber]);

  if (!r.rowCount) {
    return res.json({ job_number: req.params.jobNumber, found: false, crew: [],
      note: "not in SmartMoving yet — pick the crew by hand" });
  }
  res.json({
    job_number: r.rows[0].job_number,
    service_date: r.rows[0].service_date,
    completed_at: r.rows[0].completed_at,
    found: true,
    crew: r.rows.map(x => ({ id: x.id, code_name: x.code_name, full_name: x.full_name }))
  });
}));

app.get("/api/admin/reviews", wrap(async (req, res) => {
  const { year, month } = askedPeriod(req);
  const period = `${year}-${String(month).padStart(2, "0")}-01`;
  const r = await query(
    `select r.id, r.occurred_on, r.job_number, r.customer_name, r.source,
            r.has_photo, r.points,
            coalesce(json_agg(json_build_object('id', e.id, 'code_name', e.code_name,
                     'full_name', e.full_name) order by e.full_name)
                     filter (where e.id is not null), '[]') as crew
       from reviews r
       left join review_credits rc on rc.review_id = r.id
       left join employees e on e.id = rc.employee_id
      where date_trunc('month', r.occurred_on) = $1::date
      group by r.id
      order by r.occurred_on desc, r.id desc`, [period]);
  res.json(r.rows);
}));

app.post("/api/admin/reviews", wrap(async (req, res) => {
  const { occurred_on, job_number, customer_name, source, has_photo, crew } = req.body ?? {};
  if (!Array.isArray(crew) || !crew.length) {
    return res.status(400).json({ error: "a review needs at least one mover credited to it" });
  }
  const points = has_photo ? 3 : 1;
  const ins = await query(
    `insert into reviews (occurred_on, job_number, customer_name, source, has_photo, points, recorded_by)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [occurred_on || new Date(), job_number || null, customer_name || null,
     source || null, !!has_photo, points, req.body.recorded_by || "admin"]);

  const id = ins.rows[0].id;
  for (const employeeId of crew) {
    await query(`insert into review_credits (review_id, employee_id) values ($1,$2)
                 on conflict do nothing`, [id, employeeId]);
  }
  res.status(201).json({ id, points, credited: crew.length });
}));

app.delete("/api/admin/reviews/:id", wrap(async (req, res) => {
  await query(`delete from reviews where id = $1`, [req.params.id]);
  res.status(204).end();
}));

/* claims, adjustments and hours all follow the same shape */
app.post("/api/admin/claims", wrap(async (req, res) => {
  const { occurred_on, job_number, reason, amount } = req.body ?? {};
  if (!(Number(amount) > 0)) return res.status(400).json({ error: "amount must be greater than zero" });
  const r = await query(
    `insert into claims (occurred_on, job_number, reason, amount, recorded_by)
     values ($1,$2,$3,$4,$5) returning id`,
    [occurred_on || new Date(), job_number || null, reason || "Claim", amount, req.body.recorded_by || "admin"]);
  res.status(201).json(r.rows[0]);
}));

app.post("/api/admin/adjustments", wrap(async (req, res) => {
  const { employee_id, occurred_on, kind, reason, amount } = req.body ?? {};
  if (!["bonus", "deduction"].includes(kind)) return res.status(400).json({ error: "kind must be bonus or deduction" });
  if (!(Number(amount) > 0)) return res.status(400).json({ error: "amount must be greater than zero" });
  const r = await query(
    `insert into adjustments (employee_id, occurred_on, kind, reason, amount, recorded_by)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [employee_id, occurred_on || new Date(), kind, reason || kind, amount, req.body.recorded_by || "admin"]);
  res.status(201).json(r.rows[0]);
}));

/* Per-month switches. Right now that means the hours gate. */
app.get("/api/admin/settings", wrap(async (req, res) => {
  const { year, month } = askedPeriod(req);
  const period = `${year}-${String(month).padStart(2, "0")}-01`;
  const r = await query(`select * from month_settings where period = $1::date`, [period]);
  res.json(r.rows[0] ?? { period, hours_gate_waived: false, note: null });
}));

app.put("/api/admin/settings", wrap(async (req, res) => {
  const { period, hours_gate_waived, note } = req.body ?? {};
  if (!/^\d{4}-\d{2}-01$/.test(String(period))) {
    return res.status(400).json({ error: "period must be the first of a month, e.g. 2026-09-01" });
  }
  const r = await query(
    `insert into month_settings (period, hours_gate_waived, note, updated_by)
     values ($1,$2,$3,$4)
     on conflict (period) do update set
       hours_gate_waived = excluded.hours_gate_waived,
       note = excluded.note, updated_by = excluded.updated_by, updated_at = now()
     returning *`,
    [period, !!hours_gate_waived, note || null, req.body.updated_by || "admin"]);
  res.json(r.rows[0]);
}));

/* Matthew pulls weekly out of Connecteam. Take the whole sheet in one go rather
   than making someone type thirteen numbers into thirteen boxes. */
app.put("/api/admin/hours/bulk", wrap(async (req, res) => {
  const { period, rows } = req.body ?? {};
  if (!/^\d{4}-\d{2}-01$/.test(String(period))) {
    return res.status(400).json({ error: "period must be the first of a month" });
  }
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: "nothing to save" });
  }

  const roster = (await query(
    `select id, full_name, code_name from employees where status <> 'left'`)).rows;

  /* Connecteam spells names its own way, so match generously: exact, then
     case-insensitive, then first-name-plus-last-initial. Anything still
     unmatched comes back so a person can decide, rather than being dropped. */
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z ]/g, "").trim();
  const match = name => {
    const n = norm(name);
    if (!n) return null;
    return roster.find(e => norm(e.full_name) === n)
        ?? roster.find(e => norm(e.code_name) === n)
        ?? roster.find(e => {
             const [f, l] = norm(e.full_name).split(" ");
             const [nf, nl] = n.split(" ");
             return f === nf && l && nl && l[0] === nl[0];
           })
        ?? null;
  };

  const saved = [], unmatched = [];
  for (const row of rows) {
    const emp = row.employee_id
      ? roster.find(e => e.id === row.employee_id)
      : match(row.name);
    const hours = Number(row.hours);
    if (!emp) { unmatched.push({ name: row.name, hours: row.hours }); continue; }
    if (!Number.isFinite(hours) || hours < 0) continue;

    /* Matthew pulls weekly, so a second paste in the same month is usually the
       next week's hours rather than a correction. `add` sums them; without it
       the figure replaces what is there. */
    const r = await query(
      `insert into hours (employee_id, period, hours, recorded_by)
       values ($1,$2,$3,$4)
       on conflict (employee_id, period)
         do update set hours = ${req.body.add ? "hours.hours + excluded.hours" : "excluded.hours"},
                       updated_at = now(), recorded_by = excluded.recorded_by
       returning hours`,
      [emp.id, period, hours, req.body.recorded_by || "admin"]);
    saved.push({ code_name: emp.code_name, full_name: emp.full_name, hours: Number(r.rows[0].hours) });
  }
  res.json({ saved, unmatched, roster_size: roster.length });
}));

app.put("/api/admin/hours", wrap(async (req, res) => {
  const { employee_id, period, hours } = req.body ?? {};
  const r = await query(
    `insert into hours (employee_id, period, hours, recorded_by)
     values ($1,$2,$3,$4)
     on conflict (employee_id, period)
       do update set hours = excluded.hours, updated_at = now(), recorded_by = excluded.recorded_by
     returning employee_id, period, hours`,
    [employee_id, period, hours, req.body.recorded_by || "admin"]);
  res.json(r.rows[0]);
}));

/* Roster edits. Status is the one that moves money: 'no_notice' forfeits the
   share and spreads it across everyone still working. */
app.patch("/api/admin/employee/:id", wrap(async (req, res) => {
  const { status, code_name, full_name, email } = req.body ?? {};
  if (status && !["active", "no_notice", "left"].includes(status)) {
    return res.status(400).json({ error: "status must be active, no_notice or left" });
  }
  const r = await query(
    `update employees set
       status    = coalesce($2, status),
       code_name = coalesce($3, code_name),
       full_name = coalesce($4, full_name),
       email     = coalesce($5, email),
       updated_at = now()
     where id = $1
     returning id, code_name, full_name, status, email`,
    [req.params.id, status ?? null, code_name ?? null, full_name ?? null, email ?? null]);
  if (!r.rowCount) return res.status(404).json({ error: "no such person on the roster" });
  res.json(r.rows[0]);
}));

app.post("/api/admin/points", wrap(async (req, res) => {
  const { employee_id, occurred_on, delta, reason, job_number } = req.body ?? {};
  if (!Number.isInteger(delta) || delta === 0) return res.status(400).json({ error: "delta must be a non-zero whole number" });
  const r = await query(
    `insert into point_events (employee_id, occurred_on, delta, reason, job_number, recorded_by)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [employee_id, occurred_on || new Date(), delta, reason || "Adjustment",
     job_number || null, req.body.recorded_by || "admin"]);
  res.status(201).json(r.rows[0]);
}));

/* ---------------------------------------------------------------- pages ---- */

app.use("/static", express.static(join(root, "public"), { maxAge: "1h" }));

app.get("/tv/:token", (req, res) => {
  if (req.params.token !== TV_TOKEN) return res.status(404).send("Not found");
  res.sendFile(join(root, "public", "tv.html"));
});

/* Andrew and Nicole. Email sign-in goes in front of this before it is public —
   until then it is reachable only on the local machine. */
app.get("/admin", (_req, res) => res.sendFile(join(root, "public", "admin.html")));

/* One employee's private report. The id in the path is a placeholder for the
   signed-in person; once sign-in is wired the server decides who you are and
   this route stops trusting the URL. */
app.get("/me", (_req, res) => res.sendFile(join(root, "public", "me.html")));
app.get("/me/:employeeId", (_req, res) => res.sendFile(join(root, "public", "me.html")));

/* Lets the report page offer a person-picker while there is no sign-in.
   Set ALLOW_REPORT_PREVIEW=off before this is reachable from outside. */
app.get("/api/me-preview", wrap(async (_req, res) => {
  if (process.env.ALLOW_REPORT_PREVIEW === "off") return res.status(404).json({ error: "not found" });
  const r = await query(
    `select id, code_name, full_name from employees where status <> 'left' and is_mover order by code_name`);
  res.json(r.rows);
}));

/* What the background jobs are doing. The admin panel shows this so that
   "is it actually running" has an answer without reading a log. */
app.get("/api/admin/jobs", (_req, res) => {
  res.json(scheduler ? scheduler.status() : []);
});

app.post("/api/admin/jobs/:name/run", wrap(async (req, res) => {
  if (!scheduler) return res.status(503).json({ error: "the scheduler is not running" });
  try {
    const detail = await scheduler.run(req.params.name);
    res.json({ ran: req.params.name, detail });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

/* Deliberately not behind wrap(): a health check that answers "something went
   wrong" is no use to whoever is trying to work out what broke. Each part is
   probed separately and reports its own failure, so a deploy problem names
   itself instead of needing the logs. Nothing here echoes a credential —
   safeTarget() gives the host and database name only. */
app.get("/healthz", async (_req, res) => {
  const out = {
    ok: false,
    at: new Date().toISOString(),
    scheduler: !!scheduler,
    database: { configured: Boolean(process.env.DATABASE_URL), target: safeTarget() }
  };

  try {
    const r = await query("select 1 as ok");
    out.database.reachable = r.rows[0].ok === 1;
  } catch (e) {
    out.database.reachable = false;
    out.database.error = e.message;
    return res.status(503).json(out);
  }

  try {
    const t = await query(
      `select count(*)::int n from information_schema.tables
        where table_schema = 'revenue_share'`);
    out.database.tables = t.rows[0].n;
    if (!t.rows[0].n) out.database.note = "no tables yet — migrations have not run";
  } catch (e) {
    out.database.error = e.message;
  }

  /* Only the four jobs that actually run in production. A test suite writes
     its own rows to sync_runs, and a health page listing a job called
     "explodes" is alarming to whoever finds it at 2am. */
  try {
    const recent = await query(
      `select distinct on (kind) kind, ok, started_at, ended_at, detail
         from sync_runs
        where kind in ('smartmoving', 'hours', 'revenue', 'writeback')
        order by kind, started_at desc`);
    out.last_runs = recent.rows;

    /* A job that has not run in far longer than its schedule is the failure
       nobody notices — it does not error, it just stops. */
    const stale = recent.rows.filter(r => {
      const age = Date.now() - new Date(r.started_at).getTime();
      const limit = r.kind === "hours" ? 60 * 60e3            // every 10 min
                  : r.kind === "smartmoving" ? 8 * 3600e3     // every 4 hours
                  : 36 * 3600e3;                              // daily
      return age > limit;
    }).map(r => r.kind);
    if (stale.length) out.stale_jobs = stale;

    const missing = ["smartmoving", "hours", "revenue", "writeback"]
      .filter(k => !recent.rows.some(r => r.kind === k));
    if (missing.length) out.never_run = missing;
  } catch (e) {
    out.last_runs = { error: e.message };
  }

  out.ok = out.database.reachable === true && (out.database.tables ?? 0) > 0;
  res.status(out.ok ? 200 : 503).json(out);
});

app.get("/", (_req, res) => res.redirect("/healthz"));

/* The scheduler lives in this process because the service is always on anyway.
   Off by default outside production so a local run does not start hitting
   SmartMoving and rewriting Andrew's sheet the moment someone opens a page. */
let scheduler = null;
const schedulingWanted = process.env.RUN_SCHEDULER === "on" ||
  (process.env.NODE_ENV === "production" && process.env.RUN_SCHEDULER !== "off");

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`revenue share listening on :${PORT}`);
    console.log(`  board   http://localhost:${PORT}/tv/${TV_TOKEN}`);
    console.log(`  admin   http://localhost:${PORT}/admin`);
    console.log(`  health  http://localhost:${PORT}/healthz`);

    if (schedulingWanted) {
      scheduler = registerJobs(createScheduler({ log: s => console.log("  " + s) }));
    } else {
      console.log("  scheduler off — set RUN_SCHEDULER=on to start the background jobs");
    }
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { scheduler?.stop(); process.exit(0); });
  }
}

export default app;
