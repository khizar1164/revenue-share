/* The scheduler.
 *
 * Runs inside the web service rather than as separate Render cron jobs: the
 * service is always on anyway, and one process means one set of logs and no
 * second thing to pay for.
 *
 * Three properties matter more than cleverness here, because nobody is watching
 * it at 2am:
 *
 *   - a job never overlaps itself. A slow SmartMoving sync must not have a
 *     second copy started on top of it.
 *   - a job that throws does not take the process, or any other job, with it.
 *   - every run is recorded in sync_runs, so "when did hours last come in"
 *     has an answer.
 */

import { query } from "./db.js";

/* La Porte is in the Central time zone — the north-west corner of Indiana,
   unlike most of the state. Daily jobs are meant to land at a sensible local
   hour, so they are scheduled against this rather than the server's UTC. */
export const TZ = process.env.TIMEZONE || "America/Chicago";

function tzParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return p;
}

/** Wall-clock time in a zone -> the UTC instant it happens at.
    Two passes so it lands correctly either side of a DST change. */
function zonedToUtc(y, mo, d, hh, mm, timeZone) {
  const wanted = Date.UTC(y, mo - 1, d, hh, mm, 0);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = tzParts(new Date(guess), timeZone);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess = wanted - (seen - guess);
  }
  return guess;
}

/** Milliseconds until the next occurrence of HH:MM in the given zone. */
export function msUntilDaily(hhmm, now = Date.now(), timeZone = TZ) {
  const [hh, mm] = String(hhmm).split(":").map(Number);
  const p = tzParts(new Date(now), timeZone);
  let at = zonedToUtc(p.year, p.month, p.day, hh, mm, timeZone);
  if (at <= now) {
    const tomorrow = new Date(now + 24 * 3600 * 1000);
    const q = tzParts(tomorrow, timeZone);
    at = zonedToUtc(q.year, q.month, q.day, hh, mm, timeZone);
  }
  return at - now;
}

/* ------------------------------------------------------------------------ */

export function createScheduler({ log = console.log } = {}) {
  const jobs = new Map();
  let stopped = false;

  async function runOnce(job, trigger = "schedule") {
    if (job.running) { log(`[${job.name}] still running, skipping this turn`); return null; }
    job.running = true;
    const started = Date.now();

    let runId = null;
    try {
      const r = await query(
        `insert into sync_runs (kind) values ($1) returning id`, [job.name]);
      runId = r.rows[0].id;
    } catch (e) {
      log(`[${job.name}] could not record the run: ${e.message}`);
    }

    try {
      const detail = await job.fn();
      const text = typeof detail === "string" ? detail : JSON.stringify(detail ?? {});
      job.lastOk = new Date();
      job.lastError = null;
      job.lastDetail = text;
      if (runId) {
        await query(`update sync_runs set ended_at = now(), ok = true, detail = $2 where id = $1`,
          [runId, text.slice(0, 1000)]).catch(() => {});
      }
      log(`[${job.name}] ok in ${Date.now() - started}ms — ${text.slice(0, 200)}`);
      return detail;
    } catch (e) {
      job.lastError = e.message;
      job.failures = (job.failures || 0) + 1;
      if (runId) {
        await query(`update sync_runs set ended_at = now(), ok = false, detail = $2 where id = $1`,
          [runId, String(e.message).slice(0, 1000)]).catch(() => {});
      }
      /* deliberately swallowed: one broken job must not stop the others */
      log(`[${job.name}] FAILED (${job.failures} in a row) — ${e.message}`);
      return null;
    } finally {
      job.running = false;
      job.lastRun = new Date();
    }
  }

  function schedule(job) {
    if (stopped) return;
    const delay = job.dailyAt ? msUntilDaily(job.dailyAt) : job.everyMs;
    job.nextRun = new Date(Date.now() + delay);
    job.timer = setTimeout(async () => {
      await runOnce(job);
      schedule(job);
    }, delay);
    job.timer.unref?.();
  }

  return {
    /** everyMs for an interval, or dailyAt:"HH:MM" for a time of day. */
    add(name, fn, { everyMs, dailyAt, runAtStartAfterMs } = {}) {
      const job = { name, fn, everyMs, dailyAt, running: false, failures: 0 };
      jobs.set(name, job);
      schedule(job);

      if (runAtStartAfterMs != null) {
        const t = setTimeout(() => runOnce(job, "startup"), runAtStartAfterMs);
        t.unref?.();
      }
      log(`[${name}] scheduled ${dailyAt ? `daily at ${dailyAt} ${TZ}` : `every ${Math.round(everyMs / 60000)} min`}` +
          `, next ${job.nextRun.toISOString().slice(0, 16).replace("T", " ")}Z`);
      return this;
    },

    /** Kick a job by hand — the admin panel's "sync now". */
    run(name) {
      const job = jobs.get(name);
      if (!job) throw new Error(`no such job: ${name}`);
      return runOnce(job, "manual");
    },

    status() {
      return [...jobs.values()].map(j => ({
        name: j.name,
        schedule: j.dailyAt ? `daily ${j.dailyAt} ${TZ}` : `every ${Math.round(j.everyMs / 60000)} min`,
        running: j.running,
        last_run: j.lastRun ?? null,
        last_ok: j.lastOk ?? null,
        last_error: j.lastError ?? null,
        last_detail: j.lastDetail ?? null,
        consecutive_failures: j.failures || 0,
        next_run: j.nextRun ?? null
      }));
    },

    stop() {
      stopped = true;
      for (const j of jobs.values()) clearTimeout(j.timer);
      log("scheduler stopped");
    }
  };
}
