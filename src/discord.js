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

/** 2026-10-26 → 10/26/2026, the way the channel already reads. */
export function day(d) {
  if (!d) return "—";
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

/** The block every dispatch message shares, so the three read alike. */
function jobLines(job, { serviceType } = {}) {
  return [
    line("🏷️", "Job #", job.invoice_number ?? "—"),
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
  lines[3] = `📅 **Move Date:** ~~${day(previousDate)}~~ → **${day(job.service_date)}**`;
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
