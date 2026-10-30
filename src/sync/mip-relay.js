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
import { query, hasColumn } from "../db.js";
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

/* Card transactions, and why they are off.
 *
 * Andrew, 17 October: "Let's hold off for now until we have phased out
 * SmartMoving completely. If you would like to build it and test it and have
 * it on pause, you're more than welcome to."
 *
 * So this ships finished and silent. Switching MIP_CARD_PAYMENTS to "on" is
 * the whole activation: no deploy, no code change, and it can go back off just
 * as fast if the channel doubles. Until then card events are fetched, counted
 * and dropped, which also means the logs show what WOULD have posted before
 * anyone commits to it. */
const cardPaymentsEnabled = () =>
  String(process.env.MIP_CARD_PAYMENTS || "off").trim().toLowerCase() === "on";

/**
 * Is this a chargeback.
 *
 * Andrew, same message: "we will want to keep the zap active that looks for
 * charge back notifications." That zap reads the processor's own email, which
 * arrives whether or not MoveitPro ever hears about the dispute, so it is the
 * better source and it stays.
 *
 * This is therefore a hard exclusion rather than a default. It holds even when
 * MIP_CARD_PAYMENTS is on, because the failure it prevents is a chargeback
 * posting twice in the one channel where people are already alarmed.
 */
export const isChargeback = payment =>
  String(payment?.status ?? "").toLowerCase() === "chargeback";

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
   null for those and the caller falls back.

   Andrew, 29 October: job 11463 reached Discord as "Job #: 9255" with no
   service type. The lookup below had failed and the caller fell back to the
   invoice number — quietly, because the catch here returned nulls and said
   nothing, so a failed fetch looked exactly like a manual job. Three bookings
   arrived in the same second that evening and two of the three lost their
   estimate this way; later events on the same job resolved it fine, so it is
   transient rather than broken.

   Still never throw: a message with a worse number beats no message. But try
   twice, and say so when it fails, because an hour of logs showed no trace of
   any of this. */
async function estimateFor(job, opts = {}) {
  const { log = console.warn } = opts;
  if (!job.estimate_id) return { serviceType: null, jobNumber: null };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const e = await getEstimate(job.estimate_id, opts);
      return {
        serviceType: e?.service_type ?? null,
        jobNumber: e?.estimate_number ?? null
      };
    } catch (e) {
      /* A pause, because the failures came in a burst and an instant retry
         walks back into whatever turned the first one away. */
      if (attempt === 1) { await new Promise(r => setTimeout(r, 500)); continue; }
      log(`moveitpro: estimate ${job.estimate_id} unreadable, ` +
          `job ${job.invoice_number ?? job.id} loses its number ` +
          `and service type: ${e.message}`);
    }
  }
  return { serviceType: null, jobNumber: null };
}

/* The company, when the customer is a business.
 *
 * Andrew, 31 October: "It just shows customer name but not the company name.
 * Can you have it include the company name also" — estimate #11446, a White
 * Glove delivery out of a commercial address that reached dispatch as "Mary
 * Beth" with no sign of which business it was for.
 *
 * The job cannot answer this. Its customer_name, customer_email and
 * customer_phone are as-booked snapshots of the contact and carry no company;
 * the company is on the customer record, which prospect_id points at. So this
 * is a second lookup, the same shape as the estimate one above, and it fails
 * the same way when bookings arrive together.
 *
 * Three states, not two, which is why this returns undefined as well as null:
 *
 *   a name     the customer is a business and we read it
 *   null       the customer is a person, so there is no company to print
 *   undefined  we could not find out, and the caller falls back to what the
 *              row already knows rather than dropping a line it had before
 *
 * Never throws. A booking missing its company line is a good message; no
 * message at all is not. */
async function companyFor(job, opts = {}) {
  const { log = console.warn } = opts;
  /* A manual job has no customer record behind it, so there is nothing to
     look up and nothing to be uncertain about. */
  if (!job.prospect_id) return null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const c = await getCustomer(job.prospect_id, opts);
      return c?.company_name?.trim() || null;
    } catch (e) {
      if (attempt === 1) { await new Promise(r => setTimeout(r, 500)); continue; }
      log(`moveitpro: customer ${job.prospect_id} unreadable, ` +
          `job ${job.invoice_number ?? job.id} loses its company name: ${e.message}`);
    }
  }
  return undefined;
}

/* Claim a job we believe we have never seen.
 *
 * "Booked" is the one message decided by a row being absent rather than by two
 * values differing, so it is the one that duplicates when the same job is
 * handled twice at once: both handlers read nothing, both post. That is how
 * Ruchelle Murphy's booking went out twice on 29 October, once as 11463 and
 * once as 9255.
 *
 * The insert is the lock. Whoever creates the row posts; anyone who finds it
 * already there stays quiet. remember() fills the rest in a moment. */
async function claimFirstSighting(jobId) {
  const r = await query(
    `insert into mip_jobs (job_id) values ($1)
     on conflict (job_id) do nothing
     returning job_id`, [jobId]);
  return r.rows.length > 0;
}

/* estimate_number is stored as well as invoice_number because the payments
   channel has only a job id to work from and still has to print the number
   staff recognise, without fetching the estimate a second time. */
async function remember(job, estimateNumber = null, companyName = null) {
  /* company_name may not be there yet. Render deploys on a push to main and
     the migration is run by hand, so the code is ahead of the schema for a
     window that is minutes or days wide. Naming a column that does not exist
     does not degrade — Postgres rejects the whole statement — and this is the
     statement every job event ends on, so getting it wrong stops dispatch
     entirely rather than losing one optional line. */
  const withCompany = await hasColumn("mip_jobs", "company_name");

  const cols = ["job_id", "invoice_number", "estimate_number", "service_date",
                "cancelled_at", "status", "customer_name"];
  const vals = [job.id, job.invoice_number ?? null, estimateNumber,
                job.service_date ?? null, job.cancelled_at ?? null,
                job.status ?? null, job.customer_name ?? null];
  if (withCompany) { cols.push("company_name"); vals.push(companyName ?? null); }

  await query(
    `insert into mip_jobs (${cols.join(", ")})
     values (${cols.map((_, i) => `$${i + 1}`).join(",")})
     on conflict (job_id) do update set
       invoice_number  = excluded.invoice_number,
       /* a later event that cannot reach the estimate must not wipe a number
          we already know */
       estimate_number = coalesce(excluded.estimate_number, mip_jobs.estimate_number),
       service_date    = excluded.service_date,
       cancelled_at    = excluded.cancelled_at,
       status          = excluded.status,
       customer_name   = excluded.customer_name,
       ${withCompany ? "/* and the same for the company, for the same reason */\n       company_name    = coalesce(excluded.company_name, mip_jobs.company_name)," : ""}
       updated_at      = now()`,
    vals);
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
  /* Null until the migration has run, which only costs the fallback that
     keeps a company name we already read. See remember(). */
  const companyCol = await hasColumn("mip_jobs", "company_name")
    ? "company_name" : "null::text as company_name";
  const before = (await query(
    `select to_char(service_date, 'YYYY-MM-DD') as service_date,
            cancelled_at, status, invoice_number, estimate_number, ${companyCol}
       from mip_jobs where job_id = $1`, [id])).rows[0];

  let job;
  try { job = await getJob(id, opts); }
  catch (e) {
    /* record_gone is ordinary: deleted between the event and our fetch. */
    if (e.status === 404) return `job ${id} no longer exists`;
    throw e;
  }

  const extra = await estimateFor(job, opts);
  /* A lookup that failed this time does not mean we never knew the number.
     Once an estimate has been read for a job it is on the row, and the number
     staff recognise is better taken from there than given up on. */
  if (extra.jobNumber == null && before?.estimate_number != null) {
    extra.jobNumber = before.estimate_number;
  }
  const nowCancelled = isCancelled(job);
  const wasCancelled = isCancelled(before);
  /* Both sides are now plain YYYY-MM-DD. A job with no date on either side has
     not moved, which is why the empty strings have to compare equal. */
  const dateMoved = before && (before.service_date ?? "") !== (job.service_date ?? "");

  /* Decided before anything is written, so the company lookup below can be
     skipped on the events that say nothing. */
  let what = null, duplicate = false;
  if (!before && !nowCancelled) {
    /* Two handlers on the same job both read nothing and both post. Only the
       one that creates the row gets to say it. The loser still falls through
       to remember(), because its estimate lookup may have been the one that
       worked and the coalesce there keeps whichever number we have. */
    if (await claimFirstSighting(id)) what = "booked";
    else duplicate = true;
  } else if (nowCancelled && !wasCancelled) {
    what = "cancelled";
  } else if (dateMoved && !nowCancelled) {
    what = "rescheduled";
  }

  /* Only when something is going out. Most job events change nothing we post
     about, and an extra customer fetch on every one of them would spend an
     API we already know turns requests away when three bookings land in the
     same second. */
  const found = what ? await companyFor(job, opts) : undefined;
  extra.company = found === undefined ? (before?.company_name ?? null) : found;

  const message =
    what === "booked"      ? discord.bookedMessage(job, extra) :
    what === "cancelled"   ? discord.cancelledMessage(job, extra) :
    what === "rescheduled" ? discord.rescheduledMessage(job, before.service_date, extra) :
    null;

  await remember(job, extra.jobNumber, extra.company);
  const said = extra.jobNumber ?? job.invoice_number ?? id;
  if (duplicate) return `job ${said}: another handler announced it`;
  if (!message) return `job ${said}: nothing worth posting`;
  await discord.toDispatch(message, opts);
  return `job ${said} ${what}`;
}

/** Who the payment belongs to, when we can find out. Never fatal. */
async function nameOn(payment, opts) {
  if (!payment.customer_id) return null;
  try {
    const c = await getCustomer(payment.customer_id, opts);
    return [c?.first_name, c?.last_name].filter(Boolean).join(" ") || c?.name || null;
  } catch { return null; }
}

/** The invoice number we already know for the job this payment sits on. */
async function jobNumberOn(payment) {
  if (payment.surface_entity_type !== "dispatch_job" || !payment.surface_entity_id) return null;
  const known = (await query(
    `select estimate_number, invoice_number from mip_jobs where job_id = $1`,
    [payment.surface_entity_id])).rows[0];
  return known?.estimate_number ?? known?.invoice_number ?? null;
}

/**
 * A card transaction, posted from the ledger rather than the processor email.
 *
 * The refund is the whole reason this exists, so the sale it reverses is
 * fetched when there is one. parent_transaction_id is only populated on
 * refund and void rows, and a failed lookup costs us a line of detail rather
 * than the message.
 */
async function postCard(payment, opts) {
  const [customerName, jobNumber] = await Promise.all([
    nameOn(payment, opts), jobNumberOn(payment)
  ]);

  let parent = null;
  if (payment.parent_transaction_id) {
    try { parent = await getPayment(payment.parent_transaction_id, opts); }
    catch { /* the reversal still posts, just without naming its sale */ }
  }

  await discord.toPayments(
    discord.cardPaymentMessage(payment, { customerName, jobNumber, parent }), opts);

  const sign = (payment.kind === "refund" || payment.kind === "void") ? "-" : "";
  return `card ${payment.kind} posted (${sign}${discord.usd(payment.amount_cents)})`;
}

/**
 * One payment event.
 *
 * Hand-entered payments post today. Card transactions are built and tested but
 * held behind MIP_CARD_PAYMENTS until SmartMoving is retired, and chargebacks
 * are never ours at all.
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

  /* Chargebacks are somebody else's job, whatever else is switched on. */
  if (isChargeback(payment)) {
    return `payment ${id} is a chargeback — the processor's own zap posts those`;
  }

  /* An authorization is a hold, not money. It is noise in either channel. */
  if (payment.kind === "auth_only") {
    return `payment ${id} is auth_only — no money moved`;
  }

  const byHand = payment.gateway_type === BY_HAND;

  if (!byHand) {
    if (!cardPaymentsEnabled()) {
      return `payment ${id} went through ${payment.gateway_type} — card posting is off ` +
             `(would have been ${payment.kind})`;
    }
    return postCard(payment, opts);
  }

  const surfaces = SURFACES();
  if (surfaces.length && !surfaces.includes(String(payment.surface ?? "").toLowerCase())) {
    return `payment ${id} was taken on ${payment.surface} — already in the channel via Zapier`;
  }
  if (payment.status === "failed" || payment.status === "voided") {
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
