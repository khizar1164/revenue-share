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

/* Their quick tasks and ours disagree about what "manual" means in English;
   in their data it is simply "a person recorded this, the processor did not". */
const BY_HAND = "manual";

/** Already seen? Delivery is at-least-once, so this is asked of everything. */
async function alreadyHandled(event) {
  const r = await query(
    `insert into mip_events (id, event_type, record_id)
     values ($1, $2, $3) on conflict (id) do nothing returning id`,
    [event.id, event.type ?? event.event_type ?? "unknown", event.record_id ?? event.data?.id ?? null]);
  return r.rowCount === 0;
}

/* The service type lives on the estimate, not the job. A manual job has no
   estimate at all, which is not an error — it is a job somebody typed in. */
async function serviceTypeFor(job, opts) {
  if (!job.estimate_id) return null;
  try {
    const e = await getEstimate(job.estimate_id, opts);
    return e?.service_type ?? null;
  } catch {
    return null;                         // never let a nicety lose the message
  }
}

async function remember(job) {
  await query(
    `insert into mip_jobs (job_id, invoice_number, service_date, cancelled_at, status, customer_name)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (job_id) do update set
       invoice_number = excluded.invoice_number,
       service_date   = excluded.service_date,
       cancelled_at   = excluded.cancelled_at,
       status         = excluded.status,
       customer_name  = excluded.customer_name,
       updated_at     = now()`,
    [job.id, job.invoice_number ?? null, job.service_date ?? null,
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

  const before = (await query(
    `select service_date, cancelled_at, invoice_number from mip_jobs where job_id = $1`, [id])).rows[0];

  let job;
  try { job = await getJob(id, opts); }
  catch (e) {
    /* record_gone is ordinary: deleted between the event and our fetch. */
    if (e.status === 404) return `job ${id} no longer exists`;
    throw e;
  }

  const extra = { serviceType: await serviceTypeFor(job, opts) };
  const nowCancelled = Boolean(job.cancelled_at);
  const wasCancelled = Boolean(before?.cancelled_at);
  const dateMoved = before && String(before.service_date ?? "").slice(0, 10) !==
                               String(job.service_date ?? "").slice(0, 10);

  let message = null, what = null;
  if (!before && !nowCancelled) {
    message = discord.bookedMessage(job, extra); what = "booked";
  } else if (nowCancelled && !wasCancelled) {
    message = discord.cancelledMessage(job, extra); what = "cancelled";
  } else if (dateMoved && !nowCancelled) {
    message = discord.rescheduledMessage(job, before.service_date, extra); what = "rescheduled";
  }

  await remember(job);
  if (!message) return `job ${job.invoice_number ?? id}: nothing worth posting`;
  await discord.toDispatch(message, opts);
  return `job ${job.invoice_number ?? id} ${what}`;
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
      `select invoice_number from mip_jobs where job_id = $1`, [payment.surface_entity_id])).rows[0];
    jobNumber = known?.invoice_number ?? null;
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
