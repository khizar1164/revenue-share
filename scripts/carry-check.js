/* A negative month carries into the next one.
 *
 * Andrew, 9 October: "a negative point balance carries over against the start
 * of the following months points."
 *
 * The fold is the part worth testing. The carry is not a running total of
 * everything ever lost — a quiet month clears it — and it must never compound
 * into a debt nobody can work off. Those are the two ways this rule goes wrong,
 * and both of them are money.
 *
 * monthsBetween is tested on its own because the fold is only right if it
 * visits every month, including the empty ones. Folding only the months that
 * had entries would carry a penalty straight past the month meant to settle it.
 */
import { monthsBetween, computeSplit, RULES } from "../src/calc.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

console.log("1. EVERY MONTH IN THE RANGE, INCLUDING THE EMPTY ONES");
check("September to December is three months, not four",
  monthsBetween("2026-09", "2026-12").join(",") === "2026-09,2026-10,2026-11",
  monthsBetween("2026-09", "2026-12").join(","));
check("the target month itself is never folded in",
  !monthsBetween("2026-09", "2026-11").includes("2026-11"));
check("the same month is an empty range", monthsBetween("2026-10", "2026-10").length === 0);
check("it crosses a year end",
  monthsBetween("2026-11", "2027-02").join(",") === "2026-11,2026-12,2027-01",
  monthsBetween("2026-11", "2027-02").join(","));

/* The fold itself, stated the way the rule reads. */
const fold = (deltas) => {
  let carry = 0;
  for (const d of deltas) carry = Math.min(0, RULES.startPoints + d + carry);
  return carry;
};

console.log("\n2. THE FOLD");
check("a clean month carries nothing", fold([0]) === 0);
check("losing 15 exactly carries nothing", fold([-15]) === 0);
check("losing 20 carries −5", fold([-20]) === -5, String(fold([-20])));
check("a quiet month after it clears the carry", fold([-20, 0]) === 0, String(fold([-20, 0])));
check("a second bad month stacks on the first",
  fold([-20, -18]) === -8, String(fold([-20, -18])));
check("a lighter second month shrinks the carry rather than clearing it",
  fold([-20, -12]) === -2, String(fold([-20, -12])));

/* The carry is not capped. That is the literal reading of the rule and it is
   worth stating as a property here rather than discovering it later: it grows
   while months keep finishing below zero, and every clean month pays back a
   full 15. In practice it stays small, because the discipline window terminates
   somebody at 45 lost in 60 days long before a carry like this could build. */
console.log("\n3. IT GROWS WHILE THINGS ARE BAD, AND IS PAID BACK AT 15 A MONTH");
const year = fold(Array(12).fill(-30));
check("twelve months at −30 compound rather than capping", year === -180, String(year));
check("one clean month pays back exactly 15",
  fold([...Array(12).fill(-30), 0]) === -165,
  String(fold([...Array(12).fill(-30), 0])));
check("a small carry is cleared by a single clean month", fold([-20, 0]) === 0);
check("so an ordinary bad month never follows somebody for long",
  fold([-18]) === -3 && fold([-18, 0]) === 0);

console.log("\n4. WHAT THE SPLIT DOES WITH IT");
const person = (point_delta, point_carry) => ({
  id: "x", code_name: "M01", full_name: "A Mover", status: "active",
  hours: 150, point_delta, point_carry, review_points: 0,
  bonuses: 0, deductions: 0, discipline_lost: 0
});
const run = (delta, carry) => computeSplit({
  revenue: { completed_revenue: 100000 }, claims: { total: 0 },
  people: [person(delta, carry)], settings: { hours_gate_waived: false }
}).rows[0];

const clean = run(0, 0);
check("no carry means a start of 15", clean.points === 15 && clean.point_start === 15);

const carried = run(0, -5);
check("carrying −5 starts the month on 10", carried.points === 10, String(carried.points));
check("and the report can say so", carried.point_carry_in === -5 && carried.point_start === 10);

const sunk = run(-20, 0);
check("a share is never negative", sunk.points === 0, String(sunk.points));
check("but it says what it hands on", sunk.point_carry_out === -5, String(sunk.point_carry_out));

const both = run(-12, -5);
check("carry in and a bad month compound into the next carry",
  both.points === 0 && both.point_carry_out === -2,
  `${both.points} / ${both.point_carry_out}`);

console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
process.exit(failures ? 1 : 0);
