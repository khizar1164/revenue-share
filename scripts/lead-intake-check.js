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
import { toLead, splitName, phoneOf, idempotencyKeyFor, keyOk } from "../src/sync/lead-intake.js";

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
check("and nothing is warned about", live.warnings.length === 0, live.warnings.join(", "));

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
const { body, warnings } = toLead({
  full_name: "Geneva Lanning", email: "g@example.com", phone: "574-229-3269"
});
check("the source is stamped on it", body.referred_by === "z AD - Social Media");
check("and nothing is warned about a complete lead", warnings.length === 0, warnings.join(", "));

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

console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
process.exit(failures ? 1 : 0);
