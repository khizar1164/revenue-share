/* The write-up steps (src/steps.js), checked against the cases Andrew and
   Matthew talked through on 18 November 2026. No database. */
import { replay, addDays, STEPS } from "../src/steps.js";

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}
const day = n => addDays(STEPS.from, n - 1);        // day 1 = 1 November
const ev = list => list.map(([n, lost]) => ({ date: day(n), lost }));
const levels = r => r.write_ups.map(w => `${w.level}@${w.date.slice(5)}`).join(", ");

console.log("\n1. FRESH START");
{
  const r = replay([{ date: "2026-10-28", lost: 20 }, ...ev([[3, 5]])], { today: day(10) });
  check("points before 1 November never count", r.step === 0 && r.points === 5, `${r.points} points`);
}

console.log("\n2. WARNING: 15 IN 30 DAYS");
{
  const a = replay(ev([[1, 10], [31, 5]]), { today: day(31) });
  check("10 on day 1 and 5 on day 31 is not 15 in 30 days", a.step === 0 && a.points === 5, `${a.points}`);
  const b = replay(ev([[2, 10], [31, 5]]), { today: day(31) });
  check("10 on day 2 and 5 on day 31 is a warning", b.level === "warning", levels(b));
}

console.log("\n3. ANDREW'S EXAMPLE (day 20, 50, 80)");
{
  const e = ev([[20, 15], [50, 15]]);
  const r50 = replay(e, { today: day(50) });
  check("day 20 warning, day 50 suspension", levels(r50) === `warning@${day(20).slice(5)}, suspension@${day(50).slice(5)}`, levels(r50));
  const r80 = replay(e, { today: day(80) });
  check("day 80, 30 days with nothing new: back to warning", r80.level === "warning" && r80.points === 0, r80.level);
  check("…and it steps down again on day 110", r80.steps_down_on === day(110), r80.steps_down_on);
  const back = replay(ev([[20, 15], [50, 15], [95, 15]]), { today: day(95) });
  check("15 new points within 30 days of the step down: suspension again", back.level === "suspension", levels(back));
  const clean = replay(e, { today: day(110) });
  check("from a suspension, clean after 60 days", clean.step === 0, clean.level ?? "clean");
}

console.log("\n4. ONLY NEW POINTS");
{
  const r = replay(ev([[5, 15], [10, 14]]), { today: day(10) });
  check("14 new points after a warning is not a suspension", r.level === "warning" && r.points === 14, `${r.points}`);
  const old = replay(ev([[5, 9], [6, 6], [20, 2]]), { today: day(20) });
  check("points that paid for the warning do not count again", old.level === "warning" && old.points === 2, `${old.points}`);
}

console.log("\n5. OVERFLOW CARRIES");
{
  const r = replay(ev([[5, 18]]), { today: day(5) });
  check("18 in a day: warning, 3 carried", r.level === "warning" && r.points === 3 && r.carry === 3, `${r.points}`);
  const s = replay(ev([[5, 18], [8, 12]]), { today: day(8) });
  check("3 carried + 12 new = suspension", s.level === "suspension" && s.points === 0, levels(s));
  const big = replay(ev([[5, 31]]), { today: day(5) });
  check("31 in one day: warning and suspension the same day, 1 carried", big.level === "suspension" && big.points === 1, levels(big));
}

console.log("\n6. TERMINATION");
{
  const r = replay(ev([[5, 15], [10, 15], [15, 15]]), { today: day(40) });
  check("three steps of 15: terminated", r.level === "termination", levels(r));
  check("termination does not step down", r.step === 3 && r.steps_down_on === null);
  /* suspension, back to clean, again, again: third suspension in a year */
  const e = ev([[1, 15], [2, 15], [70, 15], [71, 15], [140, 15], [141, 15]]);
  const t = replay(e, { today: day(141) });
  check("third suspension within 365 days is a termination", t.level === "termination" && /third suspension/.test(t.last_write_up.why), levels(t));
  const spread = ev([[1, 15], [2, 15], [200, 15], [201, 15], [400, 15], [401, 15]]);
  const ok = replay(spread, { today: day(401) });
  check("three suspensions spread over more than a year is not", ok.level === "suspension", levels(ok));
}

console.log("\n7. NOT ISSUED");
{
  const notIssued = new Set([`warning|${day(5)}`]);
  const r = replay(ev([[5, 15], [12, 4]]), { today: day(12), notIssued });
  check("a warning marked not issued: still clean, those 15 let go", r.step === 0 && r.points === 4, `${r.level ?? "clean"} ${r.points}`);
  check("…and it is listed as forgiven", r.forgiven.length === 1);
  const s = new Set([`suspension|${day(10)}`]);
  const q = replay(ev([[5, 15], [10, 15]]), { today: day(12), notIssued: s });
  check("a suspension not issued: stays on warning", q.level === "warning" && q.points === 0, q.level);
}

console.log("\n8. BACKDATED POINTS");
{
  const before = replay(ev([[5, 10]]), { today: day(20) });
  const after = replay(ev([[5, 10], [9, 6]]), { today: day(20) });
  check("a point typed in late with an earlier date lands on its day", before.step === 0 && after.level === "warning" && after.last_write_up.date === day(9), levels(after));
}

console.log("\n" + "=".repeat(56));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(56));
process.exit(failures ? 1 : 0);
