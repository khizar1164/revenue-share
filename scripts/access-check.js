/* Who can open their own page, and who cannot.
 *
 * This is the one rule in the system where being wrong is wrong in two
 * directions at once, and it has already been wrong in both. Until 9 October it
 * read `status <> 'left'`, which locked out the people who were still owed
 * money and left the door open for the people who had forfeited theirs.
 *
 * So it is tested against the real SQL rather than a copy of it. The predicate
 * is imported from auth.js and run by Postgres over a table of made-up people,
 * which is why this lives in test:db: a JavaScript reimplementation of the
 * clause would pass happily while the clause itself said something else.
 *
 * Nothing is written. It is one SELECT over a VALUES list.
 */
import { query, close, loadEnv } from "../src/db.js";
import { STILL_HAS_ACCESS } from "../src/auth.js";

loadEnv();

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

/* Each row is somebody, and what should happen to them. The dates are relative
   to today so this keeps meaning the same thing next month. */
const PEOPLE = [
  ["a working mover",                       "active",    null,                     true],
  ["someone marked active with a past date", "active",   "current_date - 400",      true],
  ["gave notice, left earlier this month",  "left",      "date_trunc('month', current_date)", true],
  ["gave notice, left last month",          "left",      "date_trunc('month', current_date) - interval '20 days'", true],
  ["gave notice, left two months ago",      "left",      "date_trunc('month', current_date) - interval '45 days'", false],
  ["walked out today",                      "no_notice", "current_date",            false],
  ["walked out earlier this month",         "no_notice", "date_trunc('month', current_date)", false],
  ["walked out two months ago",             "no_notice", "date_trunc('month', current_date) - interval '45 days'", false],
  ["left, and nobody recorded when",        "left",      null,                      false],
];

const rows = PEOPLE.map(([label, status, when]) =>
  `('${label}', '${status}', ${when ? `(${when})::date` : "null::date"})`).join(",\n    ");

console.log("1. THE SIGN-IN RULE");
const r = await query(`
  select label, status, ended_on, ${STILL_HAS_ACCESS} as allowed
    from (values
    ${rows}
  ) as t(label, status, ended_on)`);

for (const [i, row] of r.rows.entries()) {
  const want = PEOPLE[i][3];
  check(`${row.label} ${want ? "can" : "cannot"} sign in`, row.allowed === want,
    row.allowed === want ? "" : `got ${row.allowed}`);
}

/* The two directions the old rule got backwards, stated as themselves so a
   future change that reintroduces either one fails here by name. */
console.log("\n2. THE TWO WAYS IT WAS WRONG BEFORE");
const notice = r.rows.find(x => x.label === "gave notice, left earlier this month");
const walked = r.rows.find(x => x.label === "walked out today");
check("somebody still owed for the month they worked is not locked out", notice.allowed === true);
check("somebody who forfeited keeps no access at all", walked.allowed === false);

/* The whole rule in one sentence: access ends with the earning. */
check("no forfeited leaver can sign in, whenever they went",
  r.rows.filter(x => x.status === "no_notice").every(x => x.allowed === false));

/* And against the people who actually exist. */
console.log("\n3. THE REAL ROSTER");
const live = await query(`
  select full_name, status, ended_on, ${STILL_HAS_ACCESS} as allowed
    from employees where is_mover order by status, full_name`);
const active = live.rows.filter(p => p.status === "active");
check("every active mover can sign in", active.every(p => p.allowed), `${active.length} of them`);
for (const p of live.rows.filter(p => p.status !== "active")) {
  console.log(`  note  ${p.full_name} (${p.status}, ended ` +
    `${p.ended_on ? p.ended_on.toISOString().slice(0, 10) : "unrecorded"}) ` +
    `${p.allowed ? "can" : "cannot"} sign in`);
}
check("nobody is missing a leaving date", live.rows.every(p => p.status === "active" || p.ended_on));

await close();

console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
process.exit(failures ? 1 : 0);
