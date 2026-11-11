/* What the scheduler actually runs.
 *
 * Cadences are set by how fast each source really changes, not by how fast we
 * could ask:
 *
 *   crew-jobs    hourly          who worked each job, from MoveitPro. Crews
 *                                are set the day before and adjusted on the
 *                                day; an hour is soon enough for a review or a
 *                                claim logged that afternoon.
 *
 *   hours        every 10 min    Matthew pastes weekly, but when he does, the
 *                                board should move while he is still looking
 *                                at it. Reading a small sheet is nearly free.
 *
 *   revenue      every 2 hours   closed-out job bills from MoveitPro. A bill
 *                                is closed out in the office through the day.
 *
 *   writeback    daily 02:15     quiet hour, and after the day's jobs have
 *                                landed, so the sheet reflects a settled day.
 */

import { syncSameDayPoints } from "./sync/points.js";
import { importHours } from "./sync/hours.js";
import { importWeeklyHours } from "./sync/hours-weekly.js";
import { writeBack, reformatAll } from "./sync/writeback.js";
import { createGoogleClient, loadCredentials } from "./sync/google.js";
import { revenueFreshness } from "./sync/revenue-store.js";
import { syncMipRevenue } from "./sync/mip-revenue.js";
import { syncJobCrew } from "./sync/mip-crew.js";
import { configured as moveitproConfigured } from "./moveitpro.js";
import { importTardies } from "./sync/tardy.js";
import { importReviews } from "./sync/reviews-sheet.js";
import { syncDiscipline } from "./sync/discipline.js";
import { syncCrew } from "./sync/crew.js";
import { syncLeadDates } from "./sync/lead-dates.js";
import { sendReminders } from "./sync/reminders.js";
import { writingEnabled } from "./connecteam.js";
import { query } from "./db.js";

const thisMonth = () => {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1,
           period: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01` };
};

/* ------------------------------------------------------------------ hours --- */

/**
 * Hours come from the Hours tab, which Matthew pastes into after he has
 * corrected the timesheets for payroll. Khizar and Matthew settled this on
 * 2 October: no Connecteam, he copies into the sheet.
 *
 * Reading Connecteam's weekly exports straight out of Drive is still here and
 * still works, but it is now off unless HOURS_FOLDER_ID says where to look.
 * That is deliberate. The Drive API is not enabled on this project, so an
 * unconditional attempt failed on every run and wrote "Connecteam unavailable"
 * into the log every ten minutes. A permanent error nobody acts on is worse
 * than no error at all: it is the noise a real failure hides in, which is
 * exactly how four days of missing truck deductions went unnoticed in
 * September. Set HOURS_FOLDER_ID and it comes back.
 */
export async function syncHours({ period } = {}) {
  if (!loadCredentials()) throw new Error("no Google credentials configured");

  const google = createGoogleClient();
  const p = period ?? thisMonth().period;
  const parts = [];

  let fromDrive = null;
  if (process.env.HOURS_FOLDER_ID) {
    try {
      fromDrive = await importWeeklyHours(google, {
        folderId: process.env.HOURS_FOLDER_ID, period: p });
      const months = fromDrive.weeks.filter(w => w.kind === "month").length;
      parts.push(`${fromDrive.files} Connecteam file${fromDrive.files === 1 ? "" : "s"}` +
                 (months ? ` (${months} month-end)` : "") +
                 ` → ${fromDrive.written} people`);
      if (fromDrive.unmatched.length) {
        parts.push(`NOT MATCHED: ${fromDrive.unmatched.map(u => u.name).join(", ")}`);
      }
    } catch (e) {
      /* Drive being unavailable must not stop the sheet from working */
      parts.push(`Connecteam unavailable (${e.message.slice(0, 80)})`);
    }
  }

  if (process.env.SHEET_ID && !(fromDrive && fromDrive.written)) {
    const manual = await importHours(google, process.env.SHEET_ID, { period: p });
    if (manual.rowsRead) {
      parts.push(`Hours tab → ${manual.written} people`);
      if (manual.unmatched.length) {
        parts.push(`NOT MATCHED: ${manual.unmatched.map(u => u.name).join(", ")}`);
      }
    }
  }

  return parts.join("; ") || "nothing to read";
}

/* ------------------------------------------------------------ tardy log --- */

/**
 * Matthew's tardy log — late, trucks not out on time, call offs — rebuilt into
 * point deductions for the month. Runs only once TARDY_SHEET_ID is set, because
 * the log has to be a Google Sheet shared with the service account.
 */
export async function syncTardies({ period } = {}) {
  if (!process.env.TARDY_SHEET_ID) throw new Error("TARDY_SHEET_ID is not set");
  if (!loadCredentials()) throw new Error("no Google credentials configured");
  const r = await importTardies(createGoogleClient(), process.env.TARDY_SHEET_ID,
    { period: period ?? thisMonth().period });
  return r.summary;
}

/* ------------------------------------------------------------- reviews --- */

/**
 * The Review Log spreadsheet — Nicole's, one tab per year. Rebuilt into logged
 * reviews for the month, so what the board pays on is what the log says.
 * Reviews typed into the admin panel are left alone.
 */
export async function syncReviews({ period } = {}) {
  if (!process.env.REVIEW_SHEET_ID) throw new Error("REVIEW_SHEET_ID is not set");
  if (!loadCredentials()) throw new Error("no Google credentials configured");
  const r = await importReviews(createGoogleClient(), process.env.REVIEW_SHEET_ID,
    { period: period ?? thisMonth().period });
  return r.summary;
}

/* -------------------------------------------------------------- writeback --- */

export async function syncWriteBack({ all = false } = {}) {
  if (!loadCredentials()) throw new Error("no Google credentials configured");
  if (!process.env.SHEET_ID) throw new Error("SHEET_ID is not set");
  const google = createGoogleClient();

  /* On the 1st, walk every tab rather than only the new month. The month that
     just ended gets one final rewrite with its closing figures, and anything
     left unformatted by a failed night is picked up. Cheap once a month;
     wasteful every night. */
  const now = new Date();
  if (all || now.getDate() === 1) {
    const r = await reformatAll(google, process.env.SHEET_ID);
    return `rebuilt ${r.tabs.length} tabs: ${r.tabs.join(", ")}`;
  }

  const { year, month } = thisMonth();
  const r = await writeBack(google, process.env.SHEET_ID, { year, month });
  return `"${r.tab}" ${r.summaryRows} rows, backup ${r.backupRows} records`;
}

/* ------------------------------------------------------------------------- */

export function registerJobs(scheduler) {
  const MIN = 60_000;
  /* Who worked each job, from MoveitPro. A manual run can be given
     { from: "2026-10-01" } to catch up a range. The sweep after it is the old
     same-day rule's clean-up, kept from the SmartMoving sync that used to run
     it; see sync/points.js. */
  if (moveitproConfigured()) {
    scheduler.add("crew-jobs", async o => {
      const line = await syncJobCrew(o ?? {});
      await syncSameDayPoints(thisMonth().period);
      return line;
    }, { everyMs: 60 * MIN, runAtStartAfterMs: 20_000 });
  }
  scheduler.add("hours", o => syncHours(o), {
    everyMs: 10 * MIN, runAtStartAfterMs: 45_000 });
  /* Completed revenue from MoveitPro's closed-out job bills. Named "revenue"
     so each run counts as a reading; the watch below runs under its own name,
     or it would declare the figure fresh for ever. */
  if (moveitproConfigured()) {
    scheduler.add("revenue", () => syncMipRevenue(), {
      everyMs: 2 * 60 * MIN, runAtStartAfterMs: 150_000 });
  }
  scheduler.add("revenue-watch", () => revenueFreshness({ maxHours: 6 }), {
    everyMs: 2 * 60 * MIN, runAtStartAfterMs: 60 * MIN });
  /* Matthew updates his log through the day; half-hourly keeps the board
     current without reading the sheet for no reason */
  if (process.env.TARDY_SHEET_ID) {
    scheduler.add("tardies", o => syncTardies(o), {
      everyMs: 30 * MIN, runAtStartAfterMs: 75_000 });
  }
  if (process.env.REVIEW_SHEET_ID) {
    scheduler.add("reviews", o => syncReviews(o), {
      everyMs: 30 * MIN, runAtStartAfterMs: 90_000 });
  }
  /* Who crossed 15, 30 or 45 lost points in the last 60 days, and a task for
     Matthew when somebody does. Half-hourly matches the tardy log it mostly
     reacts to; the notice table means being asked often costs nothing.

     It runs whether or not Connecteam is switched on, because the crossing is
     worth recording either way — turning the integration on later should not
     mean the weeks before it went unwatched. */
  scheduler.add("discipline", o => syncDiscipline(o ?? {}), {
    everyMs: 30 * MIN, runAtStartAfterMs: 105_000 });
  /* New movers come from Connecteam now, not from their first job. Hourly:
     somebody is hired on a day, not on a minute, and the roster only needs to
     know before their first shift rather than within seconds of the paperwork.
     Only runs where there is a key to run it with. */
  if (process.env.CONNECTEAM_API_KEY) {
    scheduler.add("crew", o => syncCrew(o ?? {}), {
      everyMs: 60 * MIN, runAtStartAfterMs: 120_000 });
  }
  /* MoveitPro leaves the estimate undated when the lead came through the API,
     and the estimate is what the sales team see. Quarter-hourly because the
     estimate appears some minutes after the lead, and a rep looking at a job
     booked this morning should not have to wait until tomorrow for its date. */
  scheduler.add("lead-dates", o => syncLeadDates(o ?? {}), {
    everyMs: 15 * MIN, runAtStartAfterMs: 105_000 });
  /* Nudging people towards their own numbers. Once a day at a civilised hour,
     because the job decides who is due from when they were last messaged
     rather than from when it runs: a daily pass is enough to honour a weekly
     and a two-day cadence both. 9:30 rather than overnight, since a push that
     wakes somebody at three in the morning is the fastest way to get the
     channel muted. Only where there is a key, and still gated behind
     CONNECTEAM_WRITE below that. */
  if (process.env.CONNECTEAM_API_KEY) {
    scheduler.add("reminders", () => sendReminders({ dryRun: !writingEnabled() }),
      { dailyAt: "09:30" });
  }
  scheduler.add("writeback", () => syncWriteBack(), { dailyAt: "02:15" });
  return scheduler;
}
