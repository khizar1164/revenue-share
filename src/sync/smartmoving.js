/* SmartMoving API client.
 *
 * Two things learned from probing the live API that shape this file:
 *
 *   1. A job record's crewMembers[] is ALWAYS empty, on both the standard and
 *      the premium endpoints. The crew->jobs direction is fully populated, so
 *      we build the job->crew index from the crew side instead. 17 active
 *      movers = 17 calls for a whole month.
 *
 *   2. There is a per-minute rate limit (~120 calls) that answers 429 with a
 *      "try again in N seconds" message. Every call goes through one throttle.
 */

const BASE = "https://api-public.smartmoving.com/v1";

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createClient({
  apiKey,
  minIntervalMs = 780,
  timeoutMs = 20_000,
  maxRetries = 4,
  log = () => {}
}) {
  if (!apiKey) throw new Error("SmartMoving API key is required");

  let chain = Promise.resolve();          // serialises calls
  let calls = 0;

  async function raw(path, params, attempt = 0) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    calls++;
    let res, body;
    try {
      /* Without a timeout a stalled connection hangs the whole sync forever —
         and this runs unattended on a schedule, where nobody is watching it
         not finish. Cap every request and treat a stall as a retryable fault. */
      res = await fetch(url, {
        headers: { "x-api-key": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs)
      });
      body = await res.text();
    } catch (e) {
      if (attempt >= maxRetries) {
        throw new Error(`${path} unreachable after ${attempt + 1} attempts: ${e.message}`);
      }
      const wait = Math.min(30_000, 1000 * 2 ** attempt);   // 1s, 2s, 4s, 8s
      log(`network fault on ${path} (${e.cause?.code || e.name}) — retrying in ${wait / 1000}s`);
      await sleep(wait);
      return raw(path, params, attempt + 1);
    }

    if (res.status === 429) {
      if (attempt >= maxRetries) throw new Error(`rate limited repeatedly on ${path}`);
      const wait = (Number((body.match(/in (\d+) seconds/) || [])[1]) || 30) + 2;
      log(`rate limited, waiting ${wait}s`);
      await sleep(wait * 1000);
      return raw(path, params, attempt + 1);
    }

    /* 5xx is the server having a moment; worth another go. 4xx is us. */
    if (res.status >= 500) {
      if (attempt >= maxRetries) throw new Error(`${path} -> ${res.status} after ${attempt + 1} attempts`);
      const wait = Math.min(30_000, 1000 * 2 ** attempt);
      log(`${res.status} on ${path} — retrying in ${wait / 1000}s`);
      await sleep(wait);
      return raw(path, params, attempt + 1);
    }
    if (!res.ok) {
      const err = new Error(`${path} -> ${res.status} ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }

    await sleep(minIntervalMs);
    try { return JSON.parse(body); } catch { return body; }
  }

  /* serialise so the throttle actually holds under concurrent callers */
  function get(path, params) {
    const next = chain.then(() => raw(path, params));
    chain = next.catch(() => {});
    return next;
  }

  async function getAllPages(path, params, { pageSize = 100, cap = 50 } = {}) {
    const out = [];
    for (let page = 1; page <= cap; page++) {
      const r = await get(path, { ...params, PageSize: pageSize, Page: page });
      const rows = r.pageResults || [];
      out.push(...rows);
      const total = r.totalResults ?? out.length;
      if (!rows.length || out.length >= total) break;
    }
    return out;
  }

  return {
    get,
    getAllPages,
    get callCount() { return calls; },

    /** Liveness + build number. Cheapest way to check the key still works. */
    ping: () => get("/api/ping"),

    /** Every crew member, active and not. 114 at La Porte as of Sept 2026. */
    crewMembers: () => getAllPages("/api/crew-members"),

    /** Jobs a single mover worked in a date window. This is the crew->job link. */
    jobsForCrewMember: (crewMemberId, from, to) =>
      getAllPages(`/api/crew-members/${crewMemberId}/jobs`, { From: from, To: to }),

    branches: () => getAllPages("/api/branches")
  };
}

/** SmartMoving dates are yyyyMMdd integers. */
export const toSmDate = d =>
  d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

export function monthBounds(year, month /* 1-12 */) {
  return {
    from: year * 10000 + month * 100 + 1,
    to: toSmDate(new Date(year, month, 0))      // day 0 of next month = last of this
  };
}

export const fromSmDate = n => {
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

/**
 * Build the job -> crew index for a month.
 *
 * Returns { jobs, byJobNumber, crew } where byJobNumber maps a job number to the
 * crew who worked it — which is what the admin panel needs when someone types a
 * job number while logging a review.
 */
export async function buildJobCrewIndex(client, { from, to, activeOnly = true, log = () => {} }) {
  const roster = await client.crewMembers();
  const crew = activeOnly ? roster.filter(c => c.status === "Active") : roster;
  log(`crew: ${crew.length} of ${roster.length} (${activeOnly ? "active only" : "all"})`);

  const jobs = new Map();          // job_id -> job
  const crewByJob = new Map();     // job_id -> Set(sm_crew_id)

  for (const member of crew) {
    const theirs = await client.jobsForCrewMember(member.id, from, to);
    log(`  ${member.name}: ${theirs.length} jobs`);
    for (const j of theirs) {
      if (!jobs.has(j.id)) {
        jobs.set(j.id, {
          job_id: j.id,
          job_number: j.jobNumber,
          opportunity_id: j.opportunityId ?? null,
          service_date: j.serviceDate ? fromSmDate(j.serviceDate) : null,
          completed_at: j.completedAtUtc ?? null,
          service_type: j.serviceType ?? null
        });
      }
      if (!crewByJob.has(j.id)) crewByJob.set(j.id, new Set());
      crewByJob.get(j.id).add(member.id);
    }
  }

  const byJobNumber = new Map();
  for (const [jobId, ids] of crewByJob) {
    const job = jobs.get(jobId);
    byJobNumber.set(job.job_number, [...ids]);
  }

  return { jobs: [...jobs.values()], crewByJob, byJobNumber, crew };
}

/**
 * Same-day jobs: a mover worked two or more jobs on the same calendar date.
 * Worth +1 each in the points system, and this is the one point event that
 * needs nobody to log it.
 */
export function sameDayJobs(index) {
  const perCrewDate = new Map();     // crewId -> Map(date -> count)
  for (const [jobId, ids] of index.crewByJob) {
    const job = index.jobs.find(j => j.job_id === jobId);
    if (!job?.service_date) continue;
    for (const id of ids) {
      if (!perCrewDate.has(id)) perCrewDate.set(id, new Map());
      const m = perCrewDate.get(id);
      m.set(job.service_date, (m.get(job.service_date) || 0) + 1);
    }
  }
  const out = [];
  for (const [crewId, dates] of perCrewDate) {
    for (const [date, n] of dates) {
      if (n > 1) out.push({ sm_crew_id: crewId, date, jobs: n, points: n - 1 });
    }
  }
  return out;
}
