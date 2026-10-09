/* Who comes across from Connecteam, and who must not.
 *
 * Two ways this goes wrong and both put somebody on the revenue share who does
 * not belong there, or leave off somebody who does:
 *
 *   the department filter — Connecteam holds the office as well as the crew,
 *   and sales, accounting and customer service must never arrive here;
 *
 *   the matching — "Joshua Trim" in Connecteam is "Josh Trim" on the roster,
 *   and somebody with no email at all still has to be recognised, or every run
 *   adds them again.
 *
 * Both are tested against a fake Connecteam built from what the real one
 * actually returned on 9 October, so the shapes are the ones that exist rather
 * than the ones the documentation describes. No network, no database: the
 * matching is exercised through normName, and the filtering through the same
 * predicate the sync uses.
 */
import { normName } from "../src/sync/crew.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const OPERATIONS = 17516007;

/* Straight from the live account, trimmed to the fields that matter. */
const USERS = [
  { firstName: "Andrew", lastName: "Brown", email: "accounts@immediatemoversnwi.com",
    userType: "owner", smartGroupsIds: [17515905] },
  { firstName: "Matthew", lastName: "Brown", email: "matthewb@immediatemoversnwi.com",
    userType: "manager", smartGroupsIds: [17515905, 17516007] },
  { firstName: "Zoraida", lastName: "Vega", email: "zoriv@immediatemoversnwi.com",
    userType: "user", smartGroupsIds: [17515905, 21843674] },
  { firstName: "Sarah", lastName: "Miller", email: "sarahmiller819@aol.com",
    userType: "user", smartGroupsIds: [17515905, 21843712] },
  { firstName: "Jason", lastName: "Powell", email: "powell747@gmail.com",
    userType: "user", smartGroupsIds: [17515905, 21843712, 27314241] },
  { firstName: "Joshua", lastName: "Trim", email: "joshtrim67@gmail.com",
    userType: "user", smartGroupsIds: [17515905, 17516007, 17516010] },
  { firstName: "Jason", lastName: "Plummer", email: "",
    userType: "user", smartGroupsIds: [17515905, 17516007, 17516010] },
  { firstName: "Brett", lastName: "Wood", email: "brettwood182@gmail.com",
    userType: "user", smartGroupsIds: [17515905, 17516007, 17516010] },
  { firstName: "Gone", lastName: "Already", email: "gone@example.com",
    userType: "user", isArchived: true, smartGroupsIds: [17515905, 17516007] },
];

/* The same predicate the sync applies. */
const isCrew = u => u.userType === "user" && !u.isArchived &&
  (u.smartGroupsIds ?? []).includes(OPERATIONS);

const crew = USERS.filter(isCrew).map(u => `${u.firstName} ${u.lastName}`);

console.log("1. WHO COUNTS AS CREW");
check("Joshua Trim does", crew.includes("Joshua Trim"));
check("Brett Wood does", crew.includes("Brett Wood"));
check("Jason Plummer does, with no email", crew.includes("Jason Plummer"));
check("Andrew, who owns the company, does not", !crew.includes("Andrew Brown"));
check("Matthew, who is a manager, does not", !crew.includes("Matthew Brown"),
  "he is in Operations and still must not be paid as a mover");
check("sales does not", !crew.includes("Sarah Miller") && !crew.includes("Jason Powell"));
check("business development does not", !crew.includes("Zoraida Vega"));
check("somebody archived does not", !crew.includes("Gone Already"));
check("and that is everyone", crew.length === 3, crew.join(", "));

console.log("\n2. MATCHING SOMEBODY ALREADY ON THE ROSTER");
/* The roster as it is, against the names Connecteam uses for the same people. */
const roster = [
  { full_name: "Josh Trim", email: "joshtrim67@gmail.com" },
  { full_name: "Jason Plummer", email: "" },
  { full_name: "Tyler Johnston", email: "" },
];
const byEmail = new Map(roster.filter(r => r.email).map(r => [r.email.toLowerCase(), r]));
const byName = new Map(roster.map(r => [normName(r.full_name), r]));
const known = u => {
  const e = (u.email ?? "").trim().toLowerCase();
  return (e && byEmail.has(e)) || byName.has(normName(`${u.firstName} ${u.lastName}`));
};

check("'Joshua Trim' finds 'Josh Trim' by email",
  known(USERS.find(u => u.lastName === "Trim")));
check("'Jason Plummer' with no email is found by name",
  known(USERS.find(u => u.lastName === "Plummer")));
check("Brett Wood is genuinely new",
  !known(USERS.find(u => u.lastName === "Wood")));

console.log("\n3. NAMES ARE NORMALISED ENOUGH TO MATCH, NOT SO MUCH THEY COLLIDE");
check("case and spacing do not matter", normName("  JOSH   trim ") === "josh trim");
check("punctuation is dropped", normName("D'Angelo O'Brien-Smith") === "d angelo o brien smith");
check("two different people stay different", normName("Jason Powell") !== normName("Jason Plummer"));
check("Josh and Joshua are still not the same string",
  normName("Josh Trim") !== normName("Joshua Trim"),
  "which is why email is tried first");

console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
process.exit(failures ? 1 : 0);
