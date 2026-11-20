/* Job photos from the crew (Andrew, 19 November 2026).
 *
 * The mover picks the job, ticks who was on it, and uploads. Each photo goes
 * to Google Drive under PHOTO_DRIVE_FOLDER_ID (a folder in the "Crew Job
 * Photos" Shared Drive): one folder per month, then one per job, named by job
 * number only, never the customer. The record of who sent what stays here, so
 * the "most job photos submitted" rule can be counted.
 *
 * Photos arrive one request at a time, already shrunk on the phone, so a
 * crew member on mobile data is never sending one 40 MB request that dies
 * halfway. Nothing is ever deleted by the crew; only admins see the list.
 */
import express from "express";
import { query } from "./db.js";
import { sessionFor, readCookie } from "./auth.js";
import { loadCredentials, createGoogleClient, DRIVE_WRITE_SCOPE } from "./sync/google.js";

const MAX_FILES = 40;               // per upload
const MAX_BYTES = 15 * 1024 * 1024; // per photo, after the phone shrinks it
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let drive = null;
function driveClient() {
  if (!process.env.PHOTO_DRIVE_FOLDER_ID) return null;
  if (!drive) {
    const creds = loadCredentials();
    if (!creds) return null;
    drive = createGoogleClient(creds, { scope: DRIVE_WRITE_SCOPE });
  }
  return drive;
}
export const photosReady = () => Boolean(process.env.PHOTO_DRIVE_FOLDER_ID && loadCredentials());

async function me(req) {
  const m = await sessionFor(readCookie(req));
  return m && m.id ? m : null;
}

export function mountPhotos(app, wrap) {
  /* My jobs from the last 7 days, each with the crew MoveitPro has on it, and
     everyone currently on the crew so a missing name can be added. */
  app.get("/api/crew/jobs", wrap(async (req, res) => {
    const m = await me(req);
    if (!m) return res.status(401).json({ error: "not signed in" });
    const jobs = (await query(
      `select j.job_ref, j.job_number, to_char(j.service_date, 'YYYY-MM-DD') as service_date,
              array_agg(c.employee_id) as crew
         from job_crew j
         join job_crew c on c.source = j.source and c.job_ref = j.job_ref
        where j.employee_id = $1 and j.source = 'moveitpro'
          and j.service_date between current_date - 7 and current_date
        group by j.job_ref, j.job_number, j.service_date
        order by j.service_date desc, j.job_number`, [m.id])).rows;
    const roster = (await query(
      `select id, full_name from employees
        where is_mover and merged_into is null and status = 'active'
        order by full_name`)).rows;
    res.json({ me: m.id, ready: photosReady(), jobs, roster });
  }));

  /* Start an upload: the job and the crew. Makes the Drive folder now, so the
     photos that follow only have to land in it. */
  app.post("/api/crew/photos/start", wrap(async (req, res) => {
    const m = await me(req);
    if (!m) return res.status(401).json({ error: "not signed in" });
    const d = driveClient();
    if (!d) return res.status(503).json({ error: "photo uploads are not switched on yet" });

    const jobNumber = String(req.body?.job_number ?? "").trim().replace(/^#/, "");
    if (!/^[0-9]{3,7}(-[0-9]{1,2})?$/.test(jobNumber)) return res.status(400).json({ error: "pick the job, or type its number" });
    const crew = [...new Set([m.id, ...(Array.isArray(req.body?.crew) ? req.body.crew : [])].map(String))]
      .filter(id => UUID.test(id));
    const note = String(req.body?.note ?? "").trim().slice(0, 300) || null;

    /* the job's own date when it is one of theirs, otherwise today */
    const known = (await query(
      `select job_ref, to_char(service_date, 'YYYY-MM-DD') as d from job_crew
        where source = 'moveitpro' and job_number = $1 order by service_date desc limit 1`, [jobNumber])).rows[0];
    const day = known?.d || new Date().toISOString().slice(0, 10);
    const [y, mo, dd] = day.split("-");

    const monthFolder = await d.folderIn(process.env.PHOTO_DRIVE_FOLDER_ID, `${y}-${mo}`);
    const jobFolder = await d.folderIn(monthFolder, `Job ${jobNumber} (${Number(dd)} ${MON[Number(mo) - 1]})`);

    const r = await query(
      `insert into job_photo_uploads (employee_id, job_ref, job_number, service_date, crew, note, drive_folder_id)
       values ($1, $2, $3, $4, $5::uuid[], $6, $7) returning id`,
      [m.id, known?.job_ref ?? null, jobNumber, day, crew, note, jobFolder]);
    res.status(201).json({ id: r.rows[0].id });
  }));

  /* One photo. The body is the image itself. */
  app.post("/api/crew/photos/:id/file",
    express.raw({ type: () => true, limit: MAX_BYTES }),
    wrap(async (req, res) => {
      const m = await me(req);
      if (!m) return res.status(401).json({ error: "not signed in" });
      const id = /^\d{1,18}$/.test(req.params.id) ? req.params.id : null;
      const up = id && (await query(
        `select id, employee_id, drive_folder_id, photo_count, finished_at, job_number
           from job_photo_uploads where id = $1`, [id])).rows[0];
      if (!up || up.employee_id !== m.id) return res.status(404).json({ error: "no such upload" });
      if (up.finished_at) return res.status(409).json({ error: "this upload is already finished" });
      if (up.photo_count >= MAX_FILES) return res.status(413).json({ error: `up to ${MAX_FILES} photos at a time` });

      const type = String(req.get("content-type") || "");
      if (!/^image\/(jpeg|png|heic|heif|webp)$/i.test(type)) return res.status(415).json({ error: "photos only" });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "empty photo" });

      const ext = type.split("/")[1].replace("jpeg", "jpg");
      const name = `Job ${up.job_number} - ${String(up.photo_count + 1).padStart(2, "0")}.${ext}`;
      const f = await driveClient().uploadFile(up.drive_folder_id, name, type, req.body);
      await query(`insert into job_photo_files (upload_id, drive_file_id, file_name, bytes) values ($1,$2,$3,$4)`,
        [up.id, f.id, name, req.body.length]);
      const c = await query(`update job_photo_uploads set photo_count = photo_count + 1 where id = $1 returning photo_count`, [up.id]);
      res.status(201).json({ count: c.rows[0].photo_count });
    }));

  app.post("/api/crew/photos/:id/finish", wrap(async (req, res) => {
    const m = await me(req);
    if (!m) return res.status(401).json({ error: "not signed in" });
    const r = await query(
      `update job_photo_uploads set finished_at = coalesce(finished_at, now())
        where id = $1 and employee_id = $2 returning photo_count, job_number`, [req.params.id, m.id]);
    if (!r.rowCount) return res.status(404).json({ error: "no such upload" });
    res.json(r.rows[0]);
  }));

  /* What I have sent this month. */
  app.get("/api/crew/photos/mine", wrap(async (req, res) => {
    const m = await me(req);
    if (!m) return res.status(401).json({ error: "not signed in" });
    const r = await query(
      `select job_number, to_char(created_at at time zone 'America/Chicago', 'Mon DD') as day, photo_count
         from job_photo_uploads
        where employee_id = $1 and photo_count > 0
          and created_at >= date_trunc('month', now() at time zone 'America/Chicago')
        order by created_at desc`, [m.id]);
    res.json({ total: r.rows.reduce((a, x) => a + x.photo_count, 0), uploads: r.rows });
  }));

  /* Admin: every upload in a month, and who sent the most. */
  app.get("/api/admin/photos", wrap(async (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? `${req.query.month}-01` : null;
    const period = month ?? new Date().toISOString().slice(0, 7) + "-01";
    const uploads = (await query(
      `select u.id, u.job_number, to_char(u.service_date, 'YYYY-MM-DD') as service_date,
              to_char(u.created_at at time zone 'America/Chicago', 'YYYY-MM-DD HH24:MI') as sent,
              u.photo_count, u.note, u.drive_folder_id, e.full_name as sent_by,
              (select string_agg(x.full_name, ', ' order by x.full_name) from employees x where x.id = any(u.crew)) as crew
         from job_photo_uploads u join employees e on e.id = u.employee_id
        where u.photo_count > 0 and date_trunc('month', u.created_at at time zone 'America/Chicago') = $1::date
        order by u.created_at desc`, [period])).rows;
    const totals = (await query(
      `select e.full_name, sum(u.photo_count)::int as photos, count(*)::int as jobs
         from job_photo_uploads u join employees e on e.id = u.employee_id
        where u.photo_count > 0 and date_trunc('month', u.created_at at time zone 'America/Chicago') = $1::date
        group by e.full_name order by photos desc`, [period])).rows;
    res.json({ month: period.slice(0, 7), ready: photosReady(), totals, uploads });
  }));
}
