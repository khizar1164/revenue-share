/* The Reviews page (Andrew, 21 November 2026).
 *
 * Reviews are now logged automatically by the company brain: it collects
 * every new review, matches the reviewer to a MoveitPro job and its crew, and
 * writes the review here with recorded_by = 'brain'. This page shows a month
 * laid out like Nicole's Review Log sheet (job, source, customer, date, then a
 * column per mover with their credit), with the review itself (stars, text,
 * photos) from the brain's inbox.
 *
 * A review the brain could not place is logged with nobody credited and
 * counted in the red "needs checking" badge. Fixing it here (job number, crew,
 * photo) credits the crew; "Looks right" clears it without changes.
 *
 * Rows that came from the sheet (before 21 November) stay read-only here:
 * the sheet is still their source and rebuilds them.
 */
import { query } from "./db.js";
import { refuseIfLocked } from "./locks.js";

export const AUTOMATIC_FROM = () => process.env.REVIEWS_AUTOMATIC_FROM || "2026-11-21";

async function inboxExists() {
  return Boolean((await query(`select to_regclass('company_brain.review_inbox') as t`)).rows[0].t);
}

export function mountReviewsPage(app, wrap) {
  app.get("/api/admin/reviews-log/badge", wrap(async (_req, res) => {
    if (!(await inboxExists())) return res.json({ needs: 0 });
    const r = await query(
      `select count(*)::int n from company_brain.review_inbox i join reviews r on r.id = i.review_id
        where i.status = 'needs_check'`);
    res.json({ needs: r.rows[0].n });
  }));

  app.get("/api/admin/reviews-log", wrap(async (req, res) => {
    const m = String(req.query.month || "").match(/^(\d{4})-(\d{2})$/);
    const now = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }).slice(0, 7);
    const period = `${m ? m[0] : now}-01`;
    const inbox = await inboxExists();

    const rows = (await query(
      `select r.id, to_char(r.occurred_on, 'YYYY-MM-DD') as date, r.job_number, r.customer_name, r.source,
              r.has_photo, r.points, r.recorded_by,
              array(select rc.employee_id from review_credits rc where rc.review_id = r.id) as crew
              ${inbox ? `, i.stars, i.body, i.photo_urls, i.status as check_status, i.match_note, i.raw->>'reviewUrl' as url`
                      : `, null::int as stars, null as body, null::text[] as photo_urls, null as check_status, null as match_note, null as url`}
         from reviews r
         ${inbox ? "left join company_brain.review_inbox i on i.review_id = r.id" : ""}
        where date_trunc('month', r.occurred_on) = $1::date
        order by r.occurred_on, r.created_at`, [period])).rows;

    /* the columns: everyone on the crew now, plus anyone credited this month */
    const credited = [...new Set(rows.flatMap(r => r.crew))];
    const people = (await query(
      `select id, full_name, code_name from employees
        where merged_into is null and is_mover and (status = 'active' or id = any($1::uuid[]))
        order by full_name`, [credited])).rows;

    const needs = inbox ? (await query(
      `select count(*)::int n from company_brain.review_inbox i join reviews r on r.id = i.review_id
        where i.status = 'needs_check'`)).rows[0].n : 0;

    res.json({ month: period.slice(0, 7), automaticFrom: AUTOMATIC_FROM(), needs, people, rows });
  }));

  /* Fix a review: job, photo, crew. Credits are replaced, points follow the photo. */
  app.put("/api/admin/reviews/:id", wrap(async (req, res) => {
    const row = (await query(
      `select id, recorded_by, to_char(occurred_on,'YYYY-MM-DD') as d from reviews where id = $1`, [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: "that review is gone" });
    if (row.recorded_by === "review-log" && process.env.REVIEW_SHEET_ID) {
      return res.status(409).json({ error: "this one came from the Review Log sheet, so change it there" });
    }
    if (await refuseIfLocked(res, row.d)) return;
    const b = req.body ?? {};
    const crew = Array.isArray(b.crew) ? [...new Set(b.crew.map(String))] : null;
    if (!crew) return res.status(400).json({ error: "crew must be a list" });
    const job = String(b.job_number ?? "").trim().replace(/^#/, "") || null;
    const photo = !!b.has_photo;

    await query(`update reviews set job_number = $2, has_photo = $3, points = $4,
                   customer_name = coalesce(nullif($5, ''), customer_name), source = coalesce(nullif($6, ''), source)
                 where id = $1`,
      [row.id, job, photo, photo ? 3 : 1, String(b.customer_name ?? "").trim(), String(b.source ?? "").trim()]);
    await query(`delete from review_credits where review_id = $1`, [row.id]);
    for (const e of crew) {
      await query(`insert into review_credits (review_id, employee_id) values ($1,$2) on conflict do nothing`, [row.id, e]);
    }
    if (await inboxExists()) {
      await query(`update company_brain.review_inbox set status = 'logged', job_number = $2, crew = $3::uuid[],
                     match_note = coalesce(match_note, '') || ' · fixed in the dashboard'
                    where review_id = $1`, [row.id, job, crew]);
    }
    res.json({ ok: true, points: photo ? 3 : 1, credited: crew.length });
  }));

  /* "Looks right": clear a needs-checking review without changing it. */
  app.post("/api/admin/reviews/:id/ok", wrap(async (req, res) => {
    if (!(await inboxExists())) return res.json({ ok: true });
    await query(`update company_brain.review_inbox set status = 'logged',
                   match_note = coalesce(match_note, '') || ' · marked right in the dashboard'
                  where review_id = $1 and status = 'needs_check'`, [req.params.id]);
    res.json({ ok: true });
  }));
}

/* ------------------------------------------------- the sheet as backup --- */
/* Andrew: the dashboard is the main record and the Review Log sheet is the
   backup. Each run writes the month into a "Dashboard Reviews" tab in the same
   layout as Nicole's blocks. Her own tabs are never touched. */
export async function writeReviewBackup(google, sheetId, period) {
  const TAB = "Dashboard Reviews";
  const rows = (await query(
    `select to_char(r.occurred_on, 'MM/DD/YYYY') as d, r.job_number, r.source, r.customer_name, r.points,
            array(select e.full_name from review_credits rc join employees e on e.id = rc.employee_id
                   where rc.review_id = r.id order by e.full_name) as crew
       from reviews r where date_trunc('month', r.occurred_on) = $1::date
      order by r.occurred_on, r.created_at`, [period])).rows;
  const names = [...new Set(rows.flatMap(r => r.crew))].sort();
  const month = new Date(period + "T12:00:00Z").toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const header = ["Review Count", "Job #", "Source", month.toUpperCase(), "Date", ...names];
  const body = rows.map((r, i) => [i + 1, r.job_number || "", r.source || "", r.customer_name || "", r.d,
    ...names.map(n => (r.crew.includes(n) ? r.points : ""))]);
  const totals = ["", "", "", "TOTAL", "", ...names.map(n => rows.reduce((a, r) => a + (r.crew.includes(n) ? r.points : 0), 0))];

  await google.ensureTab(sheetId, TAB, { rows: 400, cols: Math.max(12, header.length + 2) });
  await google.clear(sheetId, `'${TAB}'!A1:AZ400`);
  await google.write(sheetId, `'${TAB}'!A1`, [
    [`Written by the revenue dashboard ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })} Central. The dashboard is the main record; this tab is a backup.`],
    [], header, ...body, totals]);
  return `${rows.length} reviews backed up to "${TAB}"`;
}
