/* MoveitPro events, turned into Discord messages.
 *
 * Andrew, 9 and 10 October: jobs booked, rescheduled and cancelled into
 * dispatch-updates; payments entered by hand into payments, because those are
 * the ones the card processor never emails about.
 *
 * The shape of the problem is that their webhook says only which record
 * changed. So every event means: fetch the record, compare it with what we
 * last saw, decide what that difference is called, and store the new state.
 * The comparison is the whole reason mip_jobs exists.
 *
 * Nothing here throws on an unknown event. MoveitPro can add event types
 * whenever they like, and an endpoint that 500s on one it does not recognise
 * gets retried seven times and then disabled.
 */
import { query } from "../db.js";
import { getJob, getEstimate, getPayment, getCustomer } from "../moveitpro.js";
import * as discord from "../discord.js";

/* In MoveitPro's data "manual" means only "a person recorded this, the
   processor did not" — and that turns out to be nearly everything: 98 of the
   last 100 payments. On its own it is useless as a filter, because the card
   and ACH payments Andrew already receives in Discord, from the processor's
   own emails through Zapier, are recorded as manual too. Posting those would
   double every card transaction in a channel that is currently correct.
   
   `surface` is what actually separates them. 96 of those 98 are
   customer_portal — a customer paying online, which is exactly what the CC and
   ACH Zaps already cover. The remaining two are `bol`: taken on site when the
   Bill of Lading is signed, which is where cash and cheques are handed over.
   
   So the filter is where the money was taken, not how it was recorded. It is
   still an inference rather than a fact — a card run on site is also `bol` —
   which is why the message says a person entered it rather than calling it
   cash, and why this is a list that can be changed without a deploy. */
const BY_HAND = "manual";
const SURFACES = () => (process.env.MIP_PAYMENT_SURFACES || "bol")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

/** Already seen? Delivery is at-least-once, so this is asked of everything. */
async function alreadyHandled(event) {
  const r = await query(
    `insert into mip_events (id, event_type, record_id)
     values ($1, $2, $3) on conflict (id) do nothing returning id`,
    [event.id, event.type ?? event.event_type ?? "unknown", event.record_id ?? event.data?.id ?? null]);
  return r.rowCount === 0;
}

/**
 * Has this job been cancelled.
 *
 * Not simply whether cancelled_at is set, which is what this used to ask and
 * why Andrew cancelled a job on 13 October and saw nothing in the channel. Of
 * the 46 cancelled jobs in the account, 45 carry cancelled_at as null and say
 * so only in status. MoveitPro records the cancellation on the free-text
 * status and fills cancelled_at only sometimes.
 *
 * So either one counts. status is free text, so this matches rather than
 * compares: "cancelled", "Cancelled", "cancelled - customer" all mean the job
 * is not happening.
 */
export const isCancelled = job =>
  Boolean(job?.cancelled_at) || /cancel/i.test(String(job?.status ?? ""));

/* The service type lives on the estimate, not the job — and so does the number
   the company actually uses. MoveitPro puts two numbers on every booked move,
   ESTIMATE #11251 and INVOICE #9194, and every thread, board and rep says the
   estimate one. The relay used to print invoice_number, which is why Andrew
   saw numbers that did not match the threads.

   A manual job has no estimate at all, which is not an error — it is a job
   somebody typed in, and it has only an invoice number. Both fields come back
   null for those and the caller falls back. */
async function estimateFor(job, opts) {
  if (!job.estimate_id) return { serviceType: null, jobNumber: null };
  try {
    const e = await getEstimate(job.estimate_id, opts);
    return {
      serviceType: e?.service_type ?? null,
      jobNumber: e?.estimate_number ?? null
    };
  } catch {
    return { serviceType: null, jobNumber: null };  // never lose the message
  }
}

/* estimate_number is stored as well as invoice_number because the payments
   channel has only a job id to work from and still has to print the number
   staff recognise, without fetching the estimate a second time. */
async function remember(job, estimateNumber = null) {
  await query(
    `insert into mip_jobs (job_id, invoice_number, estimate_number, service_date,
                           cancelled_at, status, customer_name)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (job_id) do update set
       invoice_number  = excluded.invoice_number,
       /* a later event that cannot reach the estimate must not wipe a number
          we already know */
       estimate_number = coalesce(excluded.estimate_number, mip_jobs.estimate_number),
       service_date    = excluded.service_date,
       cancelled_at    = excluded.cancelled_at,
       status          = excluded.status,
       customer_name   = excluded.customer_name,
       updated_at      = now()`,
    [job.id, job.invoice_number ?? null, estimateNumber, job.service_date ?? null,
     job.cancelled_at ?? null, job.status ?? null, job.customer_name ?? null]);
}

/**
 * One job event. Returns what it posted, or why it did not.
 *
 * A job can be rescheduled and cancelled in the same breath. Cancelled wins:
 * it is the thing a dispatcher needs to see, and a date change on a job that
 * is no longer happening is noise.
 */
export async function handleJob(event, opts = {}) {
  const id = event.record_id ?? event.data?.id;
  if (!id) return "job event with no record id";

  /* As text, formatted by Postgres. A date column arrives as a JS Date, and
     MoveitPro sends a string — comparing the two stringifies the Date to
     "Thu Oct 22 2026 ...", which never equals "2026-10-22". Every update then
     looks like a date change, and the old date prints as that whole mouthful.
     Both happened in the channel before this line said to_char. */
  const before = (await query(
    `select to_char(service_date, 'YYYY-MM-DD') as service_date,
            cancelled_at, status, invoice_number
       from mip_jobs where job_id = $1`, [id])).rows[0];

  let job;
  try { job = await getJob(id, opts); }
  catch (e) {
    /* record_gone is ordinary: deleted between the event and our fetch. */
    if (e.status === 404) return `job ${id} no longer exists`;
    throw e;
  }

  const extra = await estimateFor(job, opts);
  const nowCancelled = isCancelled(job);
  const wasCancelled = isCancelled(before);
  /* Both sides are now plain YYYY-MM-DD. A job with no date on either side has
     not moved, which is why the empty strings have to compare equal. */
  const dateMoved = before && (before.service_date ?? "") !== (job.service_date ?? "");

  let message = null, what = null;
  if (!before && !nowCancelled) {
    message = discord.bookedMessage(job, extra); what = "booked";
  } else if (nowCancelled && !wasCancelled) {
    message = discord.cancelledMessage(job, extra); what = "cancelled";
  } else if (dateMoved && !nowCancelled) {
    message = discord.rescheduledMessage(job, before.service_date, extra); what = "rescheduled";
  }

  await remember(job, extra.jobNumber);
  const said = extra.jobNumber ?? job.invoice_number ?? id;
  if (!message) return `job ${said}: nothing worth posting`;
  await discord.toDispatch(message, opts);
  return `job ${said} ${what}`;
}

/**
 * One payment event.
 *
 * Only the ones a person entered. Card and ACH already reach the payments
 * channel from the processor's own emails, and posting them again would double
 * every card transaction in a channel that is currently correct.
 */
export async function handlePayment(event, opts = {}) {
  const id = event.record_id ?? event.data?.id;
  if (!id) return "payment event with no record id";

  let payment;
  try { payment = await getPayment(id, opts); }
  catch (e) {
    if (e.status === 404) return `payment ${id} no longer exists`;
    throw e;
  }

  if (payment.gateway_type !== BY_HAND) {
    return `payment ${id} went through ${payment.gateway_type} — the processor emails those`;
  }
  const surfaces = SURFACES();
  if (surfaces.length && !surfaces.includes(String(payment.surface ?? "").toLowerCase())) {
    return `payment ${id} was taken on ${payment.surface} — already in the channel via Zapier`;
  }
  if (payment.kind === "auth_only" || payment.status === "failed" || payment.status === "voided") {
    return `payment ${id} is ${payment.kind}/${payment.status} — no money moved`;
  }

  let customerName = null;
  if (payment.customer_id) {
    try {
      const c = await getCustomer(payment.customer_id, opts);
      customerName = [c?.first_name, c?.last_name].filter(Boolean).join(" ") || c?.name || null;
    } catch { /* a payment without a name is still worth posting */ }
  }

  let jobNumber = null;
  if (payment.surface_entity_type === "dispatch_job" && payment.surface_entity_id) {
    const known = (await query(
      `select estimate_number, invoice_number from mip_jobs where job_id = $1`,
      [payment.surface_entity_id])).rows[0];
    /* The estimate number is what staff quote. A manual job has none. */
    jobNumber = known?.estimate_number ?? known?.invoice_number ?? null;
  }

  await discord.toPayments(
    discord.manualPaymentMessage(payment, { customerName, jobNumber }), opts);
  return `payment ${id} posted (${discord.usd(payment.amount_cents)})`;
}

/** Route one verified event. Unknown types are acknowledged and ignored. */
export async function handleEvent(event, opts = {}) {
  const type = event.type ?? event.event_type ?? "";
  if (await alreadyHandled(event)) return `${type}: already handled`;

  if (type === "job.created" || type === "job.updated") return handleJob(event, opts);
  if (type === "payment.recorded") return handlePayment(event, opts);
  /* MoveitPro's own test event, and the only thing that exercises the whole
     chain at once: their signature, our verification, and both Discord URLs
     as the server actually has them. A ping that only answered 200 would
     prove the half that was never in doubt. */
  if (type === "ping") {
    const said = [];
    for (const [where, send] of [["dispatch-updates", discord.toDispatch],
                                 ["payments", discord.toPayments]]) {
      try {
        await send("✅ **Relay connected.** MoveitPro can reach this channel. " +
                   "Real messages start from the next booking or payment.", opts);
        said.push(where);
      } catch (e) {
        said.push(`${where} FAILED (${e.message})`);
      }
    }
    return "ping → " + said.join(", ");
  }
  return `${type}: not a type we post`;
}
