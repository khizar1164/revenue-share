/* Posting to Discord, in the shape the channels already read in.
 *
 * Andrew's dispatch-updates channel has had SmartMoving posting into it for
 * months and people read it at a glance. So these messages keep the same
 * lines in the same order with the same emoji, and only add what he asked
 * for: on a reschedule, the old date beside the new one.
 *
 * A webhook URL is a credential. Anyone holding one can post into that channel
 * as the app, so they live in the environment and never in the repository, and
 * nothing here ever logs one.
 */

const DISPATCH = () => (process.env.DISCORD_DISPATCH_URL || "").trim() || null;
const PAYMENTS = () => (process.env.DISCORD_PAYMENTS_URL || "").trim() || null;

export const configured = () => Boolean(DISPATCH() && PAYMENTS());

export function status() {
  if (!DISPATCH()) return "no DISCORD_DISPATCH_URL";
  if (!PAYMENTS()) return "no DISCORD_PAYMENTS_URL";
  return null;
}

/**
 * Send one message.
 *
 * Discord answers 429 with a retry_after rather than a queue, so one retry is
 * built in. Beyond that it gives up: a dispatch notice that arrives ten minutes
 * late is worse than one that never came, because people trust the channel to
 * be current.
 */
export async function post(url, content, { fetchImpl = globalThis.fetch, retry = true } = {}) {
  if (!url) throw new Error("no Discord webhook URL");
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    /* allowed_mentions empty: a customer called "@everyone" must not ping the
       company, and names come from a form strangers type into. */
    body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } })
  });

  if (res.status === 429 && retry) {
    const wait = Number((await res.json().catch(() => ({}))).retry_after ?? 1);
    await new Promise(r => setTimeout(r, Math.min(wait * 1000 + 250, 5000)));
    return post(url, content, { fetchImpl, retry: false });
  }
  if (!res.ok) {
    /* Never the URL — it is the credential. */
    throw new Error(`Discord responded ${res.status}`);
  }
  return true;
}

export const toDispatch = (content, o) => post(DISPATCH(), content, o);
export const toPayments = (content, o) => post(PAYMENTS(), content, o);

/* ------------------------------------------------------------ format ----- */

/* Discord renders _ and * as formatting. A customer named O'Brien is fine; one
   whose address has an underscore in it would silently italicise the rest of
   the line. */
const esc = v => String(v ?? "").replace(/([*_`~|\\])/g, "\\$1").trim();

export const usd = cents =>
  "$" + (Number(cents ?? 0) / 100).toLocaleString("en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Money that can go backwards, written the way a person reads it.
 *
 * usd() alone would render a reversal as "$-150.00", with the sign hiding
 * behind the dollar. Andrew, 16 October: "can you make these show negative."
 * The minus belongs in front, where the eye lands on it first, because the
 * whole point is that Jason read a refund as a booking.
 */
export const signedUsd = cents => {
  const n = Number(cents ?? 0);
  return (n < 0 ? "-" : "") + usd(Math.abs(n));
};

/**
 * 2026-10-26 → 10/26/2026, the way the channel already reads.
 *
 * Accepts a Date as well as a string. The caller is supposed to hand this
 * plain text, but a date column read from Postgres arrives as a Date, and the
 * old fallback printed the whole "Thu Oct 22 2026 00:00:00 GMT+0000
 * (Coordinated Universal Time)" into Discord when it did. Falling back to
 * something unreadable is worse than handling the case.
 */
export function day(d) {
  if (!d) return "—";
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return "—";
    const p = n => String(n).padStart(2, "0");
    return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`;
  }
  const [y, m, dd] = String(d).slice(0, 10).split("-");
  return y && m && dd ? `${m}/${dd}/${y}` : String(d);
}

/** A moment, in La Porte's clock rather than UTC. */
export function when(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", {
    timeZone: process.env.TIMEZONE || "America/Chicago",
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit"
  }) + " Central";
}

const line = (emoji, label, value) => `${emoji} **${label}:** ${esc(value) || "—"}`;

/**
 * The block every dispatch message shares, so the three read alike.
 *
 * The number is the ESTIMATE number when the job has one. MoveitPro keeps two
 * on every job — estimate #11251 and invoice #9194 for the same move — and the
 * company says the estimate number. Andrew, 15 October: "These are showing the
 * wrong job numbers sometimes." They were showing invoice_number, which is
 * right in the database and wrong in a channel where Jason answers with
 * "see the #11251 thread". A manual job has no estimate, so the invoice number
 * is still what prints for those.
 *
 * Andrew, 31 October: "It just shows customer name but not the company name."
 * Estimate #11446 was a White Glove delivery out of a commercial address that
 * reached the channel as "Mary Beth" and nothing else, so nobody reading it
 * could tell whose job it was. MoveitPro keeps the company apart from the
 * contact, and the company line prints ONLY when there is one — a residential
 * booking gaining an empty row would cost every other message a line.
 */
function jobLines(job, { serviceType, jobNumber, company } = {}) {
  return [
    line("🏷️", "Job #", jobNumber ?? job.invoice_number ?? "—"),
    ...(company ? [line("🏢", "Company", company)] : []),
    line("👤", "Customer", job.customer_name),
    line("📞", "Phone", job.customer_phone),
    line("📅", "Move Date", day(job.service_date)),
    line("🚚", "Service Type", serviceType ?? "—"),
    line("📍", "Origin", job.origin_address?.full_address),
    line("🎯", "Destination", job.destination_address?.full_address)
  ];
}

export function bookedMessage(job, extra) {
  return ["🎯 **Job Booked**", "", ...jobLines(job, extra)].join("\n");
}

/** Andrew, 9 October: on a reschedule he wants the old date and the new one. */
export function rescheduledMessage(job, previousDate, extra) {
  const lines = jobLines(job, extra);
  /* Found, not counted to. The company line appears only on commercial jobs,
     so the date is at position 3 on some messages and 4 on others; a fixed
     index would strike through the service type on exactly the jobs Andrew
     asked for the company on. */
  const i = lines.findIndex(l => l.includes("**Move Date:**"));
  lines[i] = `📅 **Move Date:** ~~${day(previousDate)}~~ → **${day(job.service_date)}**`;
  return ["🔄 **Job Rescheduled**", "", ...lines].join("\n");
}

export function cancelledMessage(job, extra) {
  return ["❌ **Job Cancelled**", "", ...jobLines(job, extra)].join("\n");
}

/**
 * A payment that was entered by hand.
 *
 * Deliberately not called a cash payment. MoveitPro records only whether the
 * card processor handled it or a person did; cash, cheque and Zelle are
 * identical in the data, and labelling all of them "cash" would put a number
 * in front of Andrew that says something the system does not know.
 */
export function manualPaymentMessage(payment, { customerName, jobNumber } = {}) {
  const net = Number(payment.amount_cents ?? 0) - Number(payment.tip_cents ?? 0);
  const out = [
    "💵 **Payment Recorded** _(entered by hand, not through the card processor)_",
    "",
    line("👤", "Customer", customerName),
    line("💲", "Amount", usd(payment.amount_cents))
  ];
  if (Number(payment.tip_cents ?? 0) > 0) {
    out.push(line("🙏", "Tip", `${usd(payment.tip_cents)} (of which ${usd(net)} is the job)`));
  }
  if (jobNumber) out.push(line("🏷️", "Job #", jobNumber));
  out.push(line("🧾", "Type", payment.kind), line("📅", "Date/Time", when(payment.created_at)));
  return out.join("\n");
}

/**
 * A card transaction, taken from MoveitPro rather than the processor's email.
 *
 * Andrew, 16 October: a refund reached the payments channel reading
 * "Response: Approved, Total Amount: $150.00" and Jason asked whether the
 * customer had moved their date. The processor's email carries nothing that
 * distinguishes a refund from a sale, as Andrew confirmed himself, so no
 * amount of parsing could have caught it.
 *
 * MoveitPro's ledger can: `kind` is one of sale, auth_only, capture, void or
 * refund, and refunds are child rows pointing at the sale they reverse. Their
 * spec says amounts arrive as positive magnitudes and "net-of-refund
 * derivation is the consumer's concern", so applying the sign is our job.
 *
 * A reversal gets its own heading and its own colour of language. Nobody
 * should have to read as far as the amount to know which way the money went.
 */
export function cardPaymentMessage(payment, { customerName, jobNumber, parent } = {}) {
  const reversal = payment.kind === "refund" || payment.kind === "void";
  const declined = payment.status === "failed";
  const cents = Number(payment.amount_cents ?? 0) * (reversal ? -1 : 1);

  const heading = reversal
    ? (payment.kind === "refund" ? "↩️ **Refund Issued**" : "🚫 **Payment Voided**")
    : "💳 **Card Payment**";

  const out = [heading, "", line("👤", "Customer", customerName),
               line("💲", "Amount", signedUsd(cents))];

  if (Number(payment.tip_cents ?? 0) > 0 && !reversal) {
    const net = Number(payment.amount_cents ?? 0) - Number(payment.tip_cents ?? 0);
    out.push(line("🙏", "Tip", `${usd(payment.tip_cents)} (of which ${usd(net)} is the job)`));
  }
  if (jobNumber) out.push(line("🏷️", "Job #", jobNumber));

  /* What is being reversed, when we could find it. A refund on its own tells
     you money went out; naming the sale tells you which one. */
  if (reversal && parent) {
    out.push(line("🔗", "Reverses", `${usd(parent.amount_cents)} taken ${day(parent.created_at)}`));
  }

  out.push(line(declined ? "❌" : "✅", "Status", declined ? "Declined" : "Approved"));
  out.push(line("📅", "Date/Time", when(payment.created_at)));
  return out.join("\n");
}
