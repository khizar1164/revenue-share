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

console.log("\n2. NAMES, HOWEVER THE FORM WAS BUILT");
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

/* The attribution must not be rewritable by whoever fills in the form. */
const spoofed = toLead({ full_name: "A Person", email: "a@b.com",
                         referred_by: "Google", referral_source: "Google" });
check("a form field cannot rewrite where the lead came from",
  spoofed.body.referred_by === "z AD - Social Media", spoofed.body.referred_by);

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
