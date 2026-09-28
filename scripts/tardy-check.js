/* Matthew's tardy log → point deductions, tested on a made-up log shaped
   exactly like his (real attendance stays out of the repository).
   Rules (28 September): lateness is graded on the minutes — 1 is forgiven,
   2-30 is -1, 31-60 is -2, 61+ is -3. Truck not out on time -1, call off -2,
   same day call off -3. */
import { classifyTab, parseLogGrid, toEvents, summarise, PENALTY, latePenalty }
  from "../src/sync/tardy.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};
const csv = s => s.trim().split("\n").map(l => l.split(","));
const dates = n => Array.from({ length: n }, (_, i) => `9/${i + 1}`).join(",");

const LATE = csv(`
September 2026 Tardy Log,,,,,,
Employee,${dates(30)},Total Minutes,Tardy Days
Sam,,4,1,,,2,,,,,,,,,,,,,,,,,,,,,,,,,7,3
Josh P,,,,8,9,,,,1,,,,,,,,,,,,,,,,,,,,,,18,3
Josh T,,3,,20,CALL OFF,,,,3,,,,,,,,,,,,,,,,,,,,,,26,3
Pat,,,,0,,,,,,,,,,,,,,,,,,,,,,,,,,,0,0
Nobody Here,,,5,,,,,,,,,,,,,,,,,,,,,,,,,,,,5,1
Kim,,,,??,,,,,,,,,,,,,,,,,,,,,,,,,,,0,0
Dana,,,45,,,,,75,,SAME DAY CALL OFF,,,,,,,,,,,,,,,,,,,,,120,2
Daily Mins,0,7,6,28,9,2,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,56,10
Enter the number of minutes late for each employee on each date.,,,,
`);
const TRUCK = csv(`
September 2026 Truck not out on time Log,,,,
Employee,${dates(30)},Total Minutes,Days Late
Sam,,,2,,,,,,,,,,,,,,,,,,,,,,,,,,,,2,1
Josh T,,,,,CALL OFF,,,,,,,,,,,,,,,,,,,,,,,,,,0,0
Dana,,,,,,,,,,CALL OFF,,,,,,,,,,,,,,,,,,,,,0,0
Daily Mins,0,0,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,1
`);
const ROSTER = [
  { id: "sam",  code_name: "WOLF",  full_name: "Sam Carter" },
  { id: "pama", code_name: "HAWK",  full_name: "Joshua Pama" },
  { id: "trim", code_name: "BADGER", full_name: "Josh Trim" },
  { id: "pat",  code_name: "OTTER", full_name: "Pat Lee" },
  { id: "kim",  code_name: "LYNX",  full_name: "Kim Ortiz" },
  { id: "dana", code_name: "RAVEN", full_name: "Dana Webb" }
];

console.log("\n1. FINDING THE MONTH'S TABS");
check("tardies tab", classifyTab("September Tardies", 9) === "late");
check("a cut-short truck tab name", classifyTab("September Trucks not out in tim", 9) === "truck");
check("another month's tab is ignored", classifyTab("August Tardies", 9) === null);
check("an unrelated tab is ignored", classifyTab("September Notes", 9) === null);

console.log("\n2. READING THE LATE LOG");
const late = parseLogGrid(LATE, { kind: "late", year: 2026, month: 9 });
const lateOf = n => late.entries.filter(e => e.name === n);
check("no structural problem", late.problem === null);
check("each logged cell is one entry", lateOf("Sam").length === 3, lateOf("Sam").map(e => e.date).join(" "));
check("dates land on the right day", lateOf("Josh P")[0].date === "2026-09-04" && lateOf("Josh P")[2].date === "2026-09-09");
check("CALL OFF is read as a call off", lateOf("Josh T").some(e => e.type === "calloff" && e.date === "2026-09-05"));
check("0 and blank are on time", lateOf("Pat").length === 0);
check("the totals row and instructions are not people", !late.entries.some(e => /daily|enter/i.test(e.name)));
check("an unreadable cell is reported, not guessed", late.warnings.some(w => /Kim/.test(w) && /\?\?/.test(w)), late.warnings[0]);

console.log("\n3. TURNING IT INTO POINTS");
const truck = parseLogGrid(TRUCK, { kind: "truck", year: 2026, month: 9 });
const { events, unmatched } = toEvents([...late.entries, ...truck.entries], ROSTER);
const pts = id => events.filter(e => e.employee_id === id).reduce((a, e) => a + e.delta, 0);
check("truck -1, call off -2, same day call off -3",
  PENALTY.truck === -1 && PENALTY.calloff === -2 && PENALTY.samedaycalloff === -3);

console.log("\n3a. THE MINUTE BANDS");
check("1 minute is forgiven", latePenalty(1) === 0);
check("2 minutes is -1", latePenalty(2) === -1);
check("30 minutes is still -1", latePenalty(30) === -1);
check("31 minutes is -2", latePenalty(31) === -2);
check("60 minutes is still -2", latePenalty(60) === -2);
check("61 minutes is -3", latePenalty(61) === -3);
check("two hours is still -3, not worse", latePenalty(120) === -3);
check("a forgiven minute leaves no entry at all",
  !events.some(e => e.employee_id === "sam" && e.occurred_on === "2026-09-03" && e.type === "late"));

console.log("\n3b. WHAT THAT COMES TO");
check("Sam: 4 min -1, 1 min nothing, 2 min -1, plus a late truck = -3",
  pts("sam") === -3, `${pts("sam")}`);
const samSep3 = events.filter(e => e.employee_id === "sam" && e.occurred_on === "2026-09-03");
check("a minute late and a late truck the same day is just the truck",
  samSep3.reduce((a, e) => a + e.delta, 0) === -1, samSep3.map(e => e.reason).join(" + "));
check("\"Josh P\" is Joshua Pama and \"Josh T\" is Josh Trim", pts("pama") === -2 && pts("trim") !== 0);
check("a call off written in both tabs counts once",
  events.filter(e => e.employee_id === "trim" && e.type === "calloff").length === 1, `Josh T ${pts("trim")}`);
check("Josh T: 3 min, 20 min, 3 min, one call off = -5", pts("trim") === -5);
check("Dana: 45 min -2, 75 min -3, same day call off -3 = -8", pts("dana") === -8, `${pts("dana")}`);
check("a same day call off beats a plain one written in the other tab",
  events.filter(e => e.employee_id === "dana" && /call off/i.test(e.reason)).length === 1
  && events.some(e => e.employee_id === "dana" && e.type === "samedaycalloff"));
check("someone not on the roster is reported, not dropped silently", unmatched.includes("Nobody Here"));
check("reasons say where they came from", events.every(e => /tardy log/.test(e.reason)), events[0].reason);

console.log("\n4. REFUSING WHAT IT CAN'T READ");
const renamed = parseLogGrid(csv("Name,9/1,9/2\nSam,3,"), { kind: "late", year: 2026, month: 9 });
check("no Employee header is a problem, so the month is not wiped", !!renamed.problem, renamed.problem);
const wrongMonth = parseLogGrid(LATE, { kind: "late", year: 2026, month: 10 });
check("no dates for the month is a problem too", !!wrongMonth.problem, wrongMonth.problem);

console.log("\n  " + summarise({ period: "2026-09-01", events, unmatched, warnings: late.warnings }));
console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
process.exit(failures ? 1 : 0);
