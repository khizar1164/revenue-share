/* Meta leads, mapped for MoveitPro, without touching either.
 *
 * Two things carry risk here. The shared key is the only thing standing
 * between anyone on the internet and a write to the company's CRM. And Meta's
 * lead forms return whatever field names the form was built with, so the
 * mapping has to cope with a zap that gets rebuilt by somebody in a hurry.
 *
 * The idempotency key matters as much as either: Zapier retries, and a retry
 * that creates a second lead puts the same person in front of the sales team
 * twice.
 */
import { toLead, splitName, phoneOf, idempotencyKeyFor, keyOk, parseMoveDate,
         startEstimate, createLead } from "../src/sync/lead-intake.js";
import { syncLeadDates } from "../src/sync/lead-dates.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

console.log("1. THE SHARED KEY");
process.env.LEAD_RELAY_KEY = "correct-horse-battery-staple";
check("the right key is accepted", keyOk("correct-horse-battery-staple"));
check("the wrong key is not", !keyOk("correct-horse-battery-stapl3"));
check("a shorter one is not", !keyOk("correct-horse"));
check("a longer one is not", !keyOk("correct-horse-battery-staple-extra"));
check("nothing at all is not", !keyOk("") && !keyOk(null) && !keyOk(undefined));
delete process.env.LEAD_RELAY_KEY;
check("and with no key configured, nothing is accepted",
  !keyOk("correct-horse-battery-staple"), "an unset secret must not mean an open door");
process.env.LEAD_RELAY_KEY = "correct-horse-battery-staple";

/* The payload the live zap actually sends, copied from a failed run on
   13 October. It was refused for having no email and no phone, because the
   mapping looked only for full_name, phone_number and camelCase, and
   JavaScript does not think Email is email. Two real leads were lost. */
console.log("\n2. THE PAYLOAD THE LIVE ZAP SENDS");
const LIVE = {
  FullName: "Lily Reagen Martinez",
  PhoneNumber: "7087046124",
  Email: "shouldbeblond10@gmail.com",
  ReferralSource: "z AD - Social Media"
};
const live = toLead(LIVE);
check("the email is found", live.body.email === "shouldbeblond10@gmail.com");
check("the phone is found", live.body.phones?.[0]?.number === "7087046124");
check("the name is split",
  live.body.first_name === "Lily" && live.body.last_name === "Reagen Martinez");
/* That run carried no date field at all, which is now said out loud: it is
   the single most useful thing in the zap's run history, because a lead with
   no move date never reaches a rep's follow-up list. */
check("and the only thing warned about is the date it never had",
  live.warnings.join(", ") === "no move date", live.warnings.join(", "));

console.log("\n3. HOWEVER THE FIELDS ARE SPELLED NEXT TIME");
for (const key of ["email", "Email", "EMAIL", "email_address", "Email Address", "emailAddress"]) {
  check(`${key} is understood`, toLead({ [key]: "a@b.com" }).body.email === "a@b.com");
}
for (const key of ["phone", "Phone", "phone_number", "PhoneNumber", "Phone Number", "mobile"]) {
  check(`${key} is understood`,
    toLead({ [key]: "5742293269" }).body.phones?.[0]?.number === "5742293269");
}

console.log("\n4. NAMES, HOWEVER THE FORM WAS BUILT");
check("first and last, given separately",
  toLead({ first_name: "Geneva", last_name: "Lanning" }).body.first_name === "Geneva");
check("a single full_name is split",
  toLead({ full_name: "Geneva Lanning" }).body.last_name === "Lanning");
check("a middle name stays with the surname",
  splitName("Jane Q Smith")[1] === "Q Smith");
check("one word is a first name", splitName("Cher")[0] === "Cher" && splitName("Cher")[1] === null);
check("camelCase works too", toLead({ firstName: "Geneva" }).body.first_name === "Geneva");
check("and no name at all does not crash",
  toLead({ email: "a@b.com" }).body.first_name === undefined);

console.log("\n3. PHONES");
check("a formatted number survives", phoneOf("574-229-3269") === "574-229-3269");
check("so does one with a country code", phoneOf("+1 (574) 229 3269") !== null);
check("something too short is dropped", phoneOf("12345") === null,
  "MoveitPro rejects fewer than seven digits, so sending it loses the whole lead");
check("and so is nonsense", phoneOf("call me") === null);
check("a good one becomes a Mobile entry",
  toLead({ phone: "5742293269" }).body.phones?.[0]?.type === "Mobile");

console.log("\n4. WHAT THE LEAD CARRIES");
const soonest = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
const { body, warnings } = toLead({
  full_name: "Geneva Lanning", email: "g@example.com", phone: "574-229-3269",
  move_date: soonest
});
check("the source is stamped on it", body.referred_by === "z AD - Social Media");
check("and nothing is warned about a complete lead", warnings.length === 0, warnings.join(", "));
check("a complete lead carries its date", body.move_date === soonest, String(body.move_date));

/* The zap is authenticated with our own key, so a source it states is
   configuration rather than user input. Silently ignoring it would make the
   ReferralSource field in the zap do nothing at all, which is worse. */
const stated = toLead({ full_name: "A Person", email: "a@b.com", ReferralSource: "Meta Lead Form" });
check("a source the zap states is honoured", stated.body.referred_by === "Meta Lead Form");
check("and ours is the fallback when it says nothing",
  toLead({ email: "a@b.com" }).body.referred_by === "z AD - Social Media");

const thin = toLead({ full_name: "No Contact" });
check("a lead with no way to reach them is flagged",
  thin.warnings.includes("no email") && thin.warnings.includes("no usable phone"));

console.log("\n5. A RETRY MUST NOT MAKE A SECOND LEAD");
const payload = { full_name: "Geneva Lanning", email: "g@example.com", phone: "574-229-3269" };
const once = idempotencyKeyFor(payload, toLead(payload).body);
const twice = idempotencyKeyFor(payload, toLead(payload).body);
check("the same lead gives the same key", once === twice, once);

const other = { full_name: "Someone Else", email: "s@example.com", phone: "574-229-0000" };
check("a different lead gives a different key",
  idempotencyKeyFor(other, toLead(other).body) !== once);

check("Meta's own id is used when the zap passes one",
  idempotencyKeyFor({ ...payload, leadgen_id: "1234567890" }, toLead(payload).body) === "meta-1234567890");
check("and two different Meta ids never collide",
  idempotencyKeyFor({ leadgen_id: "1" }, toLead(payload).body) !==
  idempotencyKeyFor({ leadgen_id: "2" }, toLead(payload).body));

/* Without a date the lead never reaches a rep's follow-up list, which is how
   social ads ended up sitting unworked. The live Meta form asks for mm dd yyyy
   and people answer it loosely, so the parser has to be generous about the
   shape and strict about the day being real. */
console.log("\n6. THE MOVE DATE");
const soon = new Date(Date.now() + 120 * 864e5);
const yy = String(soon.getUTCFullYear()).slice(2), mm = soon.getUTCMonth() + 1, dd = soon.getUTCDate();
const isoSoon = `${soon.getUTCFullYear()}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;

check("the way the Meta form answers it, 8 31 26 style",
  parseMoveDate(`${mm} ${dd} ${yy}`) === isoSoon, `${mm} ${dd} ${yy} → ${parseMoveDate(`${mm} ${dd} ${yy}`)}`);
check("slashes", parseMoveDate(`${mm}/${dd}/${yy}`) === isoSoon);
check("dashes", parseMoveDate(`${mm}-${dd}-${soon.getUTCFullYear()}`) === isoSoon);
check("ISO, which already worked", parseMoveDate(isoSoon) === isoSoon);
/* Straight off a live zap run on 26 October, which the first version refused:
   the separator is a slash and a space together, not one character. */
check("the spacing the live zap actually sends, 10/ 25/2026",
  parseMoveDate(`${mm}/ ${dd}/${soon.getUTCFullYear()}`) === isoSoon,
  `${mm}/ ${dd}/${soon.getUTCFullYear()} → ${parseMoveDate(`${mm}/ ${dd}/${soon.getUTCFullYear()}`)}`);
check("and spaces either side of a dash", parseMoveDate(`${mm} - ${dd} - ${yy}`) === isoSoon);
check("a day that does not exist is refused", parseMoveDate("02 31 27") === null);
check("free text is refused", parseMoveDate("next month sometime") === null);
check("nothing is refused", parseMoveDate("") === null && parseMoveDate(null) === null);
check("a mistyped year in the past is refused", parseMoveDate("08 31 21") === null,
  "a 2021 date on a new lead is a typo, not a booking");

const dated = toLead({ FullName: "Dated Lead", Email: "d@example.com",
  PhoneNumber: "2193183639", MoveDate: `${mm} ${dd} ${yy}` });
check("and it reaches the lead body", dated.body.move_date === isoSoon, String(dated.body.move_date));

/* The zap names this field itself. If someone rebuilds it and maps the raw
   question text instead, the date must still come through. */
const asked = toLead({ FullName: "Rebuilt Zap", Email: "r@example.com",
  "What Date Would You Like To Move Mm Dd Yyyy": `${mm}/${dd}/${yy}` });
check("even when the zap sends the question text as the key",
  asked.body.move_date === isoSoon, String(asked.body.move_date));

const unreadable = toLead({ FullName: "Odd Date", Email: "o@example.com", MoveDate: "whenever" });
check("a date we cannot read is reported, not dropped in silence",
  unreadable.warnings.some(w => w.startsWith("move date not understood")));

/* Everything below is the third round of this same bug. The date was still not
   arriving in MoveitPro after the first two fixes, and the reason was not the
   parser: the fallback that finds the field when the zap sends the question
   text as the key kept only values it could already parse. An answer it could
   not read was indistinguishable from no answer, so the lead went through with
   no date AND no warning — the exact state these checks now forbid. */
console.log("\n7. THE SHAPES THAT WERE STILL BEING LOST");
const YEAR = soon.getUTCFullYear();
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const word = MONTH_NAMES[mm - 1];

check("a timestamp, which is what Meta's own date question answers with",
  parseMoveDate(`${isoSoon}T00:00:00`) === isoSoon, `${isoSoon}T00:00:00 → ${parseMoveDate(`${isoSoon}T00:00:00`)}`);
check("the same with an offset on the end", parseMoveDate(`${isoSoon}T00:00:00+0000`) === isoSoon);
check("and with a Z", parseMoveDate(`${isoSoon}T00:00:00.000Z`) === isoSoon);
check("a date Zapier reformatted, 11/15/2026 12:00 AM style",
  parseMoveDate(`${mm}/${dd}/${YEAR} 12:00 AM`) === isoSoon,
  `${mm}/${dd}/${YEAR} 12:00 AM → ${parseMoveDate(`${mm}/${dd}/${YEAR} 12:00 AM`)}`);
check("a month written in words", parseMoveDate(`${word} ${dd}, ${YEAR}`) === isoSoon,
  `${word} ${dd}, ${YEAR} → ${parseMoveDate(`${word} ${dd}, ${YEAR}`)}`);
check("the day first", parseMoveDate(`${dd} ${word} ${YEAR}`) === isoSoon);
check("an ordinal on the day", parseMoveDate(`${word} ${dd}th ${YEAR}`) === isoSoon);
check("no year at all means the next one of those days",
  parseMoveDate(`${mm}/${dd}`) === isoSoon, `${mm}/${dd} → ${parseMoveDate(`${mm}/${dd}`)}`);
check("but a word where the month goes is still refused",
  parseMoveDate("whenever 15 2027") === null);

const stamped = toLead({ FullName: "Timestamped", Email: "t@example.com", PhoneNumber: "2193183639",
  "What date would you like to move? (mm/dd/yyyy)": `${isoSoon}T00:00:00` });
check("a timestamp under the question text reaches the lead body",
  stamped.body.move_date === isoSoon, String(stamped.body.move_date));

const loose = toLead({ FullName: "Loose Wording", Email: "l@example.com", PhoneNumber: "2193183639",
  "When would you like to move?": `${mm}/${dd}/${YEAR}` });
check("so does an answer to a question that never says 'date'",
  loose.body.move_date === isoSoon, String(loose.body.move_date));

const odd = toLead({ FullName: "Odd Answer", Email: "q@example.com", PhoneNumber: "2193183639",
  "When would you like to move?": "sometime in the spring" });
check("and an answer we cannot read is reported there too",
  odd.warnings.some(w => w.startsWith("move date not understood")), odd.warnings.join(", "));

/* Meta stamps every lead with its own submission time and Zapier adds more.
   They parse perfectly, so the field finder has to refuse them by name. */
const today = new Date().toISOString().slice(0, 10);
const stampedOnly = toLead({ "Created Date": today, created_time: `${today}T14:03:00+0000`,
  FullName: "Blank Date", Email: "b@example.com", PhoneNumber: "2193183639",
  "What date would you like to move": "" });
check("the day the lead arrived never becomes the move date",
  stampedOnly.body.move_date === undefined, String(stampedOnly.body.move_date));
check("and the lead says it has no date",
  stampedOnly.warnings.includes("no move date"), stampedOnly.warnings.join(", "));

const addresses = toLead({ FullName: "Address Only", Email: "a@example.com", PhoneNumber: "2193183639",
  "Where are you moving from": "123 Main St", "Where are you moving to": "456 Oak Ave" });
check("and an address is never mistaken for one",
  addresses.body.move_date === undefined &&
  !addresses.warnings.some(w => w.startsWith("move date not understood")),
  addresses.warnings.join(", "));

/* MoveitPro leaves the estimate undated when the lead came through the API,
   and the estimate is what the sales team see. The sweep writes the date on
   once the estimate exists. These run against a stubbed MoveitPro, so nothing
   here touches the real one. */
console.log("\n8. DATING THE ESTIMATES MOVEITPRO LEAVES BLANK");
process.env.MOVEITPRO_API_KEY = "test-key";
process.env.MOVEITPRO_HMAC_SECRET = "test-secret";

const reply = (status, body) => ({
  ok: status < 400, status, statusText: "",
  headers: { get: () => null },
  text: async () => JSON.stringify(body)
});

/** A MoveitPro holding these leads and these draft estimates. */
function fakeMip(leads, drafts, { onPatch = () => reply(200, { success: true, data: {} }) } = {}) {
  const seen = { patches: [] };
  const fetchImpl = async (url, init = {}) => {
    if ((init.method || "GET") === "PATCH") {
      seen.patches.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return onPatch();
    }
    if (url.includes("/v1/estimates")) return reply(200, { success: true, data: drafts });
    return reply(200, { success: true, data: leads });
  };
  return { fetchImpl, seen };
}

const LEAD = { id: "lead-1", move_date: "2026-11-25" };
const DRAFT = { id: "est-1", estimate_number: 11440, prospect_id: "lead-1",
                service_date: null, updated_at: "2026-10-27T10:00:00Z" };
const quiet = () => {};

{
  const { fetchImpl, seen } = fakeMip([LEAD], [DRAFT]);
  const out = await syncLeadDates({ fetchImpl, log: quiet });
  check("an undated draft gets its lead's move date", out.dated === 1, JSON.stringify(out));
  check("and it is sent as service_date", seen.patches[0]?.body.service_date === "2026-11-25");
  check("with If-Match carrying what we read",
    seen.patches[0]?.headers["if-match"] === DRAFT.updated_at);
}

{
  const { fetchImpl, seen } = fakeMip([LEAD], [{ ...DRAFT, service_date: "2026-12-01" }]);
  const out = await syncLeadDates({ fetchImpl, log: quiet });
  check("a date the office already set is left alone",
    out.already === 1 && out.dated === 0 && seen.patches.length === 0,
    "their date must win over ours");
}

{
  /* The estimate is not raised at the same moment as the lead. Nothing to do
     yet is a normal state, not a failure. */
  const { fetchImpl, seen } = fakeMip([LEAD], []);
  const out = await syncLeadDates({ fetchImpl, log: quiet });
  check("a lead whose estimate does not exist yet is left for next time",
    out.waiting === 1 && out.dated === 0 && seen.patches.length === 0, JSON.stringify(out));
}

{
  const { fetchImpl, seen } = fakeMip([{ id: "lead-2" }], [{ ...DRAFT, prospect_id: "lead-2" }]);
  const out = await syncLeadDates({ fetchImpl, log: quiet });
  check("a lead with no move date is not touched at all",
    out.looked === 0 && seen.patches.length === 0);
}

{
  /* A 412 is the office editing the estimate between our read and our write. */
  const { fetchImpl } = fakeMip([LEAD], [DRAFT], { onPatch: () => reply(412, { error: "stale" }) });
  const out = await syncLeadDates({ fetchImpl, log: quiet });
  check("an estimate that changed under us is counted, not thrown",
    out.failed === 1 && out.dated === 0, JSON.stringify(out));
}

{
  const many = Array.from({ length: 100 }, (_, i) =>
    ({ ...DRAFT, id: `e${i}`, prospect_id: `p${i}` }));
  const { fetchImpl } = fakeMip([LEAD], many);
  const out = await syncLeadDates({ fetchImpl, log: quiet });
  check("a full page of drafts says so rather than pretending it saw them all",
    out.capped === true, "older estimates would be missed in silence otherwise");
}

/* MoveitPro raises no estimate for a lead created through the API, and its own
   screen says follow-ups start once an estimate exists. So the lead lands
   where no rep is looking. We raise it ourselves. */
console.log("\n9. RAISING THE ESTIMATE MOVEITPRO DOES NOT");

/** A MoveitPro holding `existing` estimates for the lead we ask about. */
function fakeEstimates(existing, { onPost = () => reply(200, { success: true,
    data: { id: "new-est", estimate_number: 11500 } }) } = {}) {
  const seen = { posts: [], patches: [] };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    if (method === "POST" && url.includes("/v1/estimates")) {
      seen.posts.push({ headers: init.headers, body: JSON.parse(init.body) });
      return onPost();
    }
    if (method === "PATCH") {
      seen.patches.push({ headers: init.headers, body: JSON.parse(init.body) });
      return reply(200, { success: true, data: {} });
    }
    if (url.includes("/v1/estimates")) return reply(200, { success: true, data: existing });
    return reply(200, { success: true, data: { id: "lead-1" } });   // POST /v1/leads
  };
  return { fetchImpl, seen };
}

{
  const { fetchImpl, seen } = fakeEstimates([]);
  const out = await startEstimate("lead-1", "2026-11-25", { fetchImpl });
  check("a lead with no estimate gets one", out.created === true && out.estimate === 11500,
    JSON.stringify(out));
  check("carrying the lead it belongs to", seen.posts[0]?.body.prospect_id === "lead-1");
  check("and the move date", seen.posts[0]?.body.service_date === "2026-11-25");
}

{
  const { fetchImpl, seen } = fakeEstimates([]);
  await startEstimate("lead-1", null, { fetchImpl });
  check("a lead with no date still gets an estimate",
    seen.posts.length === 1, "no estimate means no follow-up, date or not");
  check("and no empty date is sent with it",
    !("service_date" in (seen.posts[0]?.body ?? {})),
    "an empty date on the estimate sorts the job to the wrong end of the board");
}

{
  /* Zapier retries. A second estimate in front of the sales team is worse than
     the retry itself. */
  const { fetchImpl, seen } = fakeEstimates([]);
  await startEstimate("lead-1", "2026-11-25", { fetchImpl });
  check("the create is keyed on the lead so a retry cannot double it",
    seen.posts[0]?.headers["idempotency-key"] === "estcreate-lead-1");
}

{
  const DRAFT = { id: "est-1", estimate_number: 11440, status: "draft",
                  service_date: null, updated_at: "2026-10-27T10:00:00Z" };
  const { fetchImpl, seen } = fakeEstimates([DRAFT]);
  const out = await startEstimate("lead-1", "2026-11-25", { fetchImpl });
  check("an estimate that already exists is dated, not duplicated",
    out.created === false && seen.posts.length === 0 && seen.patches.length === 1,
    JSON.stringify(out));
}

{
  const WORKED = { id: "est-1", estimate_number: 11440, status: "saved",
                   service_date: "2026-12-01", updated_at: "2026-10-27T10:00:00Z" };
  const { fetchImpl, seen } = fakeEstimates([WORKED]);
  const out = await startEstimate("lead-1", "2026-11-25", { fetchImpl });
  check("one the office has already worked is left completely alone",
    seen.posts.length === 0 && seen.patches.length === 0 && out.created === false);
}

{
  const { fetchImpl } = fakeEstimates([], { onPost: () => reply(500, { error: "boom" }) });
  const r = await createLead(
    { FullName: "Still Lands", Email: "s@example.com", PhoneNumber: "2193183639",
      MoveDate: `${mm} ${dd} ${yy}` }, { fetchImpl });
  check("a lead still lands when the estimate cannot be raised", r.id === "lead-1");
  check("and the failure is reported rather than swallowed",
    r.warnings.some(w => w.startsWith("estimate not started")), JSON.stringify(r.warnings));
}

console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
process.exit(failures ? 1 : 0);
