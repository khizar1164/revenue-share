/* Completed revenue, read from MoveitPro. The only source since November 2026.
 *
 * Why this exists. Bookings moved to MoveitPro in October, so the SmartMoving
 * Revenue Forecast stopped counting new jobs on 26 October and has reported
 * November as $0 ever since. MoveitPro added GET /v1/jobs/{id}/charges in
 * November: the job's bill as the closeout reads it, signed or closed out,
 * with sales tax as its own figure. That is the number we asked them for in
 * request 1.1, and it is what this reads.
 *
 * How a month is counted:
 *
 *   - every job whose service date falls in the month (cancelled ones are
 *     not listed by MoveitPro unless asked for)
 *   - each job's bills, once the office has CLOSED THEM OUT. A signed bill
 *     not yet closed out waits; an unsigned job has no bill at all
 *   - revenue is the bill total LESS sales tax. Tips are not on the bill at
 *     all (they live on payments), so they stay out, as before
 *   - a multi-day move has its bill on the day its paperwork lives on, and its
 *     other days return no bill, so a move that crosses a month end counts
 *     into exactly one month
 *
 * What it does NOT change is how a month is protected. The figures go through
 * the same ingestReport() the SmartMoving email used to: only this month and last month can
 * move, an identical reading is not stored twice, and a figure entered by
 * hand holds until somebody enters one again. October is held at Andrew's
 * $195,000 that way and this will not touch it.
 */

import * as mip from "../moveitpro.js";
import { query } from "../db.js";
import { ingestReport, periodInZone } from "./revenue-store.js";

/** First and last day of a month, as YYYY-MM-DD. */
export function monthRange(period) {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [period, `${period.slice(0, 7)}-${String(last).padStart(2, "0")}`];
}

function previousPeriod(period) {
  const [y, m] = period.split("-").map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
}

/* MoveitPro publishes a rate limit and answers 429 with Retry-After. A month
   is a hundred or so calls, so a burst can hit it; wait and try again rather
   than report a month short. The key is shared with the Discord relay and
   lead dating, so the wait honours Retry-After and the calls are paced:
   finishing a revenue run a minute later costs nothing, starving a booking
   notification does. Tests pass pauseMs: 0. */
export async function getWithRetry(get, path, { tries = 8, pauseMs = 250, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (pauseMs) await sleep(pauseMs);
  for (let i = 0; ; i++) {
    try { return await get(path); }
    catch (e) {
      if (e.status !== 429 || i >= tries - 1) throw e;
      const asked = Number(e.retryAfter) > 0 ? Number(e.retryAfter) * 1000 : 0;
      await sleep(Math.min(Math.max(asked, 5000 * (i + 1)), 120_000));
    }
  }
}

/** Every job with a service date in the month, following the cursor. */
async function jobsInMonth(period, get, retry) {
  const [from, to] = monthRange(period);
  const jobs = [];
  let cursor = "";
  for (let page = 0; page < 50; page++) {
    const path = `/v1/jobs?limit=100&service_date_from=${from}&service_date_to=${to}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const res = await getWithRetry(get, path, retry);
    const list = Array.isArray(res) ? res : res?.data ?? [];
    jobs.push(...list);
    cursor = res?.next_cursor ?? res?.pagination?.next_cursor ?? "";
    if (!cursor) break;
  }
  return jobs;
}

/**
 * One month's completed revenue from MoveitPro.
 * `get` is injectable so the arithmetic can be checked without the network.
 */
export async function mipMonth(period, { get = rawGet, retry } = {}) {
  const jobs = await jobsInMonth(period, get, retry);
  let totalCents = 0, taxCents = 0;
  const billedJobs = new Set();
  let bills = 0, unsigned = 0, awaitingCloseout = 0;

  for (const job of jobs) {
    const list = await getWithRetry(get, `/v1/jobs/${job.id}/charges`, retry);
    const arr = Array.isArray(list) ? list : list?.data ?? [];
    if (!arr.length) { unsigned++; continue; }
    for (const b of arr) {
      /* Closed out only. A signed bill can still be adjusted by the office
         before closeout, and MoveitPro's own Job Profitability report counts
         closed-out jobs only. Reconciled 11 November: November to date
         matched that report to the cent on all 25 closed jobs; the one
         difference was a three-day move signed but not closed out ($12,494.72),
         which arrives here the moment the office closes it. */
      if (b.status !== "closed_out") { awaitingCloseout++; continue; }
      totalCents += Number(b.total_cents) || 0;
      taxCents += Number(b.tax_cents) || 0;
      bills++;
      billedJobs.add(job.estimate_id || job.id);
    }
  }

  return {
    period,
    completed_revenue: Math.round(totalCents - taxCents) / 100,
    completed_jobs: billedJobs.size,
    total_tips: null,
    total_taxes: Math.round(taxCents) / 100,
    detail: { jobs_listed: jobs.length, bills, without_bill: unsigned, awaiting_closeout: awaitingCloseout }
  };
}

/* The shared client returns json.data, which drops next_cursor. Pagination
   needs the whole body, so list calls go through this instead. */
export async function rawGet(path) {
  if (!mip.configured()) throw new Error(mip.status());
  const base = (process.env.MOVEITPRO_BASE || "https://api.moveitpro.com").replace(/\/+$/, "");
  const res = await fetch(base + path, {
    headers: { authorization: `Bearer ${mip.apiKey()}`, ...mip.signRequest("GET", path), accept: "application/json" }
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave it */ }
  if (!res.ok) {
    const err = new Error(`MoveitPro GET ${path} → ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.retryAfter = res.headers.get("retry-after");
    throw err;
  }
  return json;
}

/**
 * The scheduled job: this month and last month from MoveitPro, stored under
 * the same protective rules. Returns the line the admin panel shows.
 */
/** Is the newest figure for a month one somebody typed. Such a month holds
    whatever MoveitPro says, so reading it would spend requests for nothing. */
async function heldByHand(period) {
  const r = (await query(
    `select source from revenue_snapshots where period = $1::date
      order by captured_at desc limit 1`, [period])).rows[0];
  return r?.source === "manual";
}

export async function syncMipRevenue({ now = new Date(), get = rawGet, ingest = ingestReport, retry,
                                       isHeld = heldByHand } = {}) {
  const current = periodInZone(now);
  const months = [], skipped = [];
  for (const period of [current, previousPeriod(current)]) {
    if (await isHeld(period)) { skipped.push(period); continue; }
    months.push(await mipMonth(period, { get, retry }));
  }
  const { results } = months.length ? await ingest(months, { now }) : { results: [] };
  for (const p of skipped) results.push({ period: p, action: "held by a manual entry, not read" });

  return results.map(r => {
    const m = months.find(x => x.period === r.period);
    const head = `${r.period.slice(0, 7)} ${r.action}`;
    const fig = r.revenue != null ? ` $${Number(r.revenue).toLocaleString("en-US")}` : "";
    const held = r.reported != null ? ` (MoveitPro says $${Number(r.reported).toLocaleString("en-US")})` : "";
    const was = r.was != null ? ` (was $${Number(r.was).toLocaleString("en-US")})` : "";
    const counts = m ? ` · ${m.completed_jobs} jobs, ${m.detail.awaiting_closeout} signed awaiting closeout` : "";
    return head + fig + held + was + counts;
  }).join("; ") + " · from MoveitPro";
}
