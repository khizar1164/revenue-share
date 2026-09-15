/* The Review Log reader, on a made-up log shaped like Nicole's real one
   (real customer names stay out of the repository).
   1 point, 3 with a photo; every mover credited on the row gets the full
   value; a customer who reviews on two platforms counts twice. */
import { parseMonthBlock, toRecords, parseDate, summarise } from "../src/sync/reviews-sheet.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};
const csv = s => s.trim().split("\n").map(l => l.split(","));

const GRID = csv(`
Review Bonus (Employees Only),,,,,,,
Review Count,JOB #,REVIEW SOURCE,AUGUST,Date Posted,Sam,Josh T,Josh P
1,7001,LP Google,Old Customer,8/30/2026,1,,1
Review Count,JOB #,REVIEW SOURCE,SEPTEMBER,Date Posted,Sam,Josh T,Josh P,Nobody Here
1,9001,LP Google,A Customer,9/2/2026,1,1,,1
,9001,BBB,A Customer,9/3/2026,1,1,,
1,9002,Facebook,B Customer,9/4/2026,3,3,3,
1,9003,SB Google,C Customer,9/5/2026,,,1,
1,9004,LP Google,D Customer,10/2/2026,1,1,1,
1,9005,LP Google,E Customer,9/6/2026,x,,1,
,,,,,,,
13,0,#DIV/0!,TOTAL,,5,5,5,1
Review Count,JOB #,REVIEW SOURCE,OCTOBER,Date Posted,Sam
1,9500,LP Google,Later Customer,10/5/2026,1
`);
const ROSTER = [
  { id: "sam",  code_name: "WOLF",   full_name: "Sam Carter" },
  { id: "trim", code_name: "BADGER", full_name: "Josh Trim" },
  { id: "pama", code_name: "HAWK",   full_name: "Joshua Pama" }
];

console.log("\n1. DATES");
check("M/D/YYYY in the month is read", parseDate("9/4/2026", { year: 2026, month: 9 }) === "2026-09-04");
check("another month is refused", parseDate("10/2/2026", { year: 2026, month: 9 }) === null);
check("junk is refused", parseDate("soon", { year: 2026, month: 9 }) === null);

console.log("\n2. FINDING SEPTEMBER IN A YEAR OF BLOCKS");
const p = parseMonthBlock(GRID, { year: 2026, month: 9 });
check("no structural problem", p.problem === null);
check("August's row is not in it", !p.reviews.some(r => r.customer_name === "Old Customer"));
check("October's row is not in it", !p.reviews.some(r => r.customer_name === "Later Customer"));
check("it stops at the block's TOTAL line", !p.reviews.some(r => /TOTAL/i.test(r.customer_name ?? "")));
check("a row dated outside the month is skipped and said so",
  !p.reviews.some(r => r.customer_name === "D Customer") && p.warnings.some(w => /not a september date/i.test(w)),
  p.warnings[0]);
check("an unreadable credit is reported", p.warnings.some(w => /couldn't read "x"/.test(w)));

console.log("\n3. POINTS AND CREDIT");
const { records, unmatched } = toRecords(p.reviews, ROSTER);
const pts = id => records.filter(r => r.credits.includes(id)).reduce((a, r) => a + r.points, 0);
check("a plain review is 1 point", records.find(r => r.job_number === "9003").points === 1);
check("a review with a photo is 3", records.find(r => r.job_number === "9002").points === 3);
check("the photo flag follows the 3", records.find(r => r.job_number === "9002").has_photo === true);
check("everyone on the row gets the full value, not a share",
  records.find(r => r.job_number === "9002").credits.length === 3 &&
  records.find(r => r.job_number === "9002").points === 3);
check("the same customer on two platforms counts twice",
  records.filter(r => r.customer_name === "A Customer").length === 2);
check("Sam: 1 + 1 + 3 = 5 (the unreadable cell is skipped, not guessed at)", pts("sam") === 5, `${pts("sam")}`);
check("Josh T: 1 + 1 + 3 = 5", pts("trim") === 5, `${pts("trim")}`);
check("Josh P: 3 + 1 + 1 = 5", pts("pama") === 5, `${pts("pama")}`);
check("someone not on the roster is reported, not guessed", unmatched.includes("Nobody Here"));
check("the sheet's own total row agrees", pts("sam") === 5 && pts("trim") === 5 && pts("pama") === 5);

console.log("\n4. A ROW THAT MIXES 1 AND 3");
const mixed = parseMonthBlock(csv(`
Review Count,JOB #,REVIEW SOURCE,SEPTEMBER,Date Posted,Sam,Josh T
1,9100,LP Google,Mixed Customer,9/7/2026,3,1
`), { year: 2026, month: 9 });
check("becomes one review per value, so nobody is rounded",
  mixed.reviews.length === 2 && mixed.reviews.some(r => r.points === 3) && mixed.reviews.some(r => r.points === 1));

console.log("\n5. REFUSING WHAT IT CANNOT READ");
const noBlock = parseMonthBlock(csv("Review Count,JOB #,REVIEW SOURCE,MARCH,Date Posted,Sam\n1,1,x,y,3/1/2026,1"),
  { year: 2026, month: 9 });
check("no block for the month is a problem, so the month is not wiped", !!noBlock.problem, noBlock.problem);
const noNames = parseMonthBlock(csv("Review Count,JOB #,REVIEW SOURCE,SEPTEMBER,Date Posted\n1,1,x,y,9/1/2026"),
  { year: 2026, month: 9 });
check("a block with no names is a problem too", !!noNames.problem, noNames.problem);

console.log("\n  " + summarise({ period: "2026-09-01", records, unmatched, warnings: p.warnings }));
console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
process.exit(failures ? 1 : 0);
