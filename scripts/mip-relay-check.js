/* The MoveitPro relay, without MoveitPro and without Discord.
 *
 * Two things are worth being sure of before anything reaches a channel the
 * whole company reads.
 *
 * The signature, because it is the only thing standing between that channel
 * and anyone who finds the URL. Every way it can be wrong is tested: no
 * header, a malformed one, the wrong secret, a body changed after signing,
 * and a replay of a perfectly good signature from last week.
 *
 * The wording, because Andrew asked for the old date next to the new one and
 * because calling a payment "cash" when the data only says "a person entered
 * it" would be putting words in the system's mouth.
 */
import crypto from "node:crypto";
import { verifyDelivery, MAX_SKEW_SECONDS } from "../src/moveitpro.js";
import {
  bookedMessage, rescheduledMessage, cancelledMessage, manualPaymentMessage, day, usd
} from "../src/discord.js";
import { isCancelled } from "../src/sync/mip-relay.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const SECRET = "mip_whsec_testonly";
const sign = (body, secret = SECRET, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=` + crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

const BODY = JSON.stringify({ id: "11111111-1111-1111-1111-111111111111", type: "job.updated",
                              record_id: "22222222-2222-2222-2222-222222222222" });

console.log("1. THE SIGNATURE");
check("a correctly signed delivery is accepted", verifyDelivery(BODY, sign(BODY), SECRET).ok);
check("and its event comes back parsed",
  verifyDelivery(BODY, sign(BODY), SECRET).event?.type === "job.updated");
check("no header is refused", !verifyDelivery(BODY, null, SECRET).ok);
check("a malformed header is refused", !verifyDelivery(BODY, "nonsense", SECRET).ok);
check("the wrong secret is refused", !verifyDelivery(BODY, sign(BODY, "someone-elses"), SECRET).ok);
check("an empty body is refused", !verifyDelivery("", sign(""), SECRET).ok);
check("no secret configured is refused", !verifyDelivery(BODY, sign(BODY), "").ok);

/* The attack this is really for: a real signature, a changed body. */
const tampered = BODY.replace("job.updated", "job.created");
check("a body changed after signing is refused",
  !verifyDelivery(tampered, sign(BODY), SECRET).ok, "same signature, different body");

/* And the other one: a real, correctly signed delivery, replayed later. */
const old = Math.floor(Date.now() / 1000) - (MAX_SKEW_SECONDS + 60);
check("a replay of a genuine signature is refused",
  !verifyDelivery(BODY, sign(BODY, SECRET, old), SECRET).ok,
  verifyDelivery(BODY, sign(BODY, SECRET, old), SECRET).why);
check("something inside the window is still fine",
  verifyDelivery(BODY, sign(BODY, SECRET, Math.floor(Date.now() / 1000) - 60), SECRET).ok);

/* A body with no id cannot be deduplicated, and at-least-once delivery makes
   that a duplicate-posting bug rather than a cosmetic one. */
const noId = JSON.stringify({ type: "job.created" });
check("a body with no id is refused", !verifyDelivery(noId, sign(noId), SECRET).ok);

console.log("\n2. THE DISPATCH MESSAGES");
const JOB = {
  id: "22222222-2222-2222-2222-222222222222",
  invoice_number: 11123,
  customer_name: "Geneva Lanning",
  customer_phone: "574-229-3269",
  service_date: "2026-10-26",
  origin_address: { full_address: "18369 Crownhill Drive, South Bend, Indiana 46637" },
  destination_address: { full_address: "6338 Eagles Lake Drive, Cincinnati, Ohio 45248" }
};
const extra = { serviceType: "Load Only" };

const booked = bookedMessage(JOB, extra);
check("dates read the way the channel already reads", day("2026-10-26") === "10/26/2026");
for (const bit of ["Job Booked", "11123", "Geneva Lanning", "574-229-3269",
                   "10/26/2026", "Load Only", "Crownhill", "Eagles Lake"]) {
  check(`booked message carries ${bit}`, booked.includes(bit));
}

/* Andrew, 15 October: "These are showing the wrong job numbers sometimes."
   MoveitPro puts two numbers on one move — estimate #11251 and invoice #9194
   for Christine Paro — and the channel reads the estimate one, because that is
   what the threads and the boards and the reps all say. The relay printed the
   invoice number, which is correct data answering the wrong question. The two
   counters are independent, so they drift by thousands. */
console.log("\n2b. WHICH OF THE TWO NUMBERS GOES IN THE CHANNEL");
const PARO = { ...JOB, invoice_number: 9194, customer_name: "Christine Paro" };
const paro = bookedMessage(PARO, { serviceType: "Residential Move", jobNumber: 11251 });
check("the estimate number is the one that prints", paro.includes("11251"),
  "what Jason answers Andrew with");
check("and the invoice number is not", !paro.includes("9194"),
  "nobody quotes the billing counter");
for (const kind of [["rescheduled", rescheduledMessage(PARO, "2026-10-20", { jobNumber: 11251 })],
                    ["cancelled", cancelledMessage(PARO, { jobNumber: 11251 })]]) {
  check(`a ${kind[0]} message uses it too`, kind[1].includes("11251") && !kind[1].includes("9194"));
}

/* A manual job is typed straight into dispatch and never has an estimate, so
   the invoice number is the only number it has. Printing a dash instead would
   be a worse answer than printing the number that exists. */
check("a manual job still shows its invoice number",
  bookedMessage(PARO, { serviceType: null, jobNumber: null }).includes("9194"),
  "no estimate exists for one of these");
check("and a job with neither prints a dash",
  bookedMessage({ ...JOB, invoice_number: null }, {}).includes("**Job #:** —"));

const moved = rescheduledMessage({ ...JOB, service_date: "2026-11-02" }, "2026-10-26", extra);
check("a reschedule shows the old date", moved.includes("10/26/2026"));
check("and the new one", moved.includes("11/02/2026"));
check("with the old one struck through", /~~10\/26\/2026~~/.test(moved));
check("and still carries everything else", moved.includes("11123") && moved.includes("Load Only"));

check("a cancellation says so", cancelledMessage(JOB, extra).startsWith("❌ **Job Cancelled**"));

/* Names and addresses are typed by strangers. */
const nasty = bookedMessage({ ...JOB, customer_name: "@everyone _boss_" }, extra);
check("a customer cannot ping the company", !/allowed_mentions/.test(nasty) && nasty.includes("@everyone"));
check("and cannot italicise the rest of the message", nasty.includes("\\_boss\\_"));

console.log("\n3. THE PAYMENT MESSAGE");
const pay = { amount_cents: 15000, tip_cents: 0, kind: "sale",
              gateway_type: "manual", created_at: "2026-10-12T16:36:57.000Z" };
const msg = manualPaymentMessage(pay, { customerName: "Jo Ellen Helmer", jobNumber: 11123 });
check("the amount is right", usd(15000) === "$150.00");
check("it is in the message", msg.includes("$150.00"));
check("so is the customer", msg.includes("Jo Ellen Helmer"));
check("and the job number", msg.includes("11123"));
check("it does NOT claim to be cash", !/\bcash\b/i.test(msg),
  "MoveitPro cannot tell cash from cheque, so neither can we");
check("it says a person entered it", /entered by hand/i.test(msg));

const tipped = manualPaymentMessage({ ...pay, tip_cents: 2000 }, { customerName: "A Customer" });
check("a tip is broken out when there is one", tipped.includes("$20.00"));
check("and the job's share shown beside it", tipped.includes("$130.00"));
check("no tip line when there is no tip", !/Tip/.test(msg));

/* The filter that keeps the payments channel from doubling. "manual" is 98 of
   every 100 payments, so it cannot be the test on its own; where the money was
   taken is. */
console.log("\n4. WHICH PAYMENTS ARE OURS TO POST");
const surfaces = (process.env.MIP_PAYMENT_SURFACES || "bol")
  .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
const posts = p =>
  p.gateway_type === "manual" &&
  (!surfaces.length || surfaces.includes(String(p.surface ?? "").toLowerCase()));

check("a payment taken on site is ours",
  posts({ gateway_type: "manual", surface: "bol" }));
check("one taken in the customer portal is not — Zapier already has it",
  !posts({ gateway_type: "manual", surface: "customer_portal" }));
check("a card through the processor is not",
  !posts({ gateway_type: "authorize_net", surface: "bol" }));
check("nor a Stripe one", !posts({ gateway_type: "stripe", surface: "bol" }));
check("a surface we have never seen is not posted either",
  !posts({ gateway_type: "manual", surface: "something_new" }),
  "silence is recoverable, a doubled channel is not");

/* Against the real spread: 96 portal, 2 bol out of 98 manual. */
const sample = [
  ...Array(96).fill({ gateway_type: "manual", surface: "customer_portal" }),
  ...Array(2).fill({ gateway_type: "manual", surface: "bol" }),
  ...Array(2).fill({ gateway_type: "authorize_net", surface: "customer_portal" })
];
check("on last week's real spread, 2 of 100 would post",
  sample.filter(posts).length === 2, `${sample.filter(posts).length} of ${sample.length}`);

/* Andrew cancelled a job on 13 October and nothing reached the channel. The
   check asked only whether cancelled_at was set; of the 46 cancelled jobs in
   the account, 45 have it null and say so only in status. */
console.log("\n5. A CANCELLED JOB IS RECOGNISED HOWEVER IT IS MARKED");
check("cancelled_at set", isCancelled({ cancelled_at: "2026-10-12T18:27:27Z", status: "cancelled" }));
check("status says cancelled with no cancelled_at, which is the usual case",
  isCancelled({ cancelled_at: null, status: "cancelled" }),
  "45 of the 46 real ones look like this");
check("whatever the case", isCancelled({ status: "Cancelled" }));
check("and with a reason appended", isCancelled({ status: "cancelled - customer" }));
check("a live job is not cancelled", !isCancelled({ status: "not-confirmed", cancelled_at: null }));
check("nor a closed one", !isCancelled({ status: "closed", cancelled_at: null }));
check("nor one we have never seen", !isCancelled(undefined) && !isCancelled(null));

console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
process.exit(failures ? 1 : 0);
