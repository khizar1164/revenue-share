/* Weekly vs month-end precedence, tested with a fake Drive.
   Getting this wrong means hours counted twice, which means paying twice —
   so it is worth proving rather than assuming. */
import { weekFromTitle, isFullMonth, splitWeekAcrossMonths, importWeeklyHours }
  from "../src/sync/hours-weekly.js";
import { query, close, loadEnv } from "../src/db.js";

loadEnv();
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

console.log("\n1. TELLING A MONTH FROM A WEEK");
{
  const t = n => isFullMonth(weekFromTitle(n));
  check("a full September is a month",  t("Movers_Hours_2026-09-01_2026-09-30"));
  check("a full February is a month",   t("Movers_Hours_2027-02-01_2027-02-28"));
  check("a leap February is a month",   t("Movers_Hours_2028-02-01_2028-02-29"));
  check("a 31-day month is a month",    t("Movers_Hours_2026-08-01_2026-08-31"));
  check("a normal week is not",        !t("Movers_Hours_2026-09-07_2026-09-13"));
  check("a straddling week is not",    !t("Movers_Hours_2026-09-28_2026-10-04"));
  check("the 1st to the 29th is not",  !t("Movers_Hours_2026-09-01_2026-09-29"),
    "a short pull must not pass as the whole month");
}

/* a stand-in Drive holding four weeks and one month-end pull */
function fakeDrive(files, people) {
  return {
    async listSpreadsheets() { return files.map(f => ({ ...f, modifiedTime: f.modifiedTime })); },
    async info(id) { return { title: files.find(f => f.id === id).name, tabs: [{ title: "S" }] }; },
    async read(id) {
      const f = files.find(x => x.id === id);
      return [["Full name", "Hours Worked"], ...people.map(p => [p.name, f.hours[p.name] ?? 0])];
    }
  };
}

const roster = (await query(
  `select id, full_name from employees where status <> 'left' order by full_name limit 3`)).rows;
const people = roster.map(r => ({ name: r.full_name }));
const weekHours = Object.fromEntries(people.map(p => [p.name, 20]));
const monthHours = Object.fromEntries(people.map(p => [p.name, 68]));

console.log("\n2. WEEKS ONLY — THEY ADD UP");
{
  const drive = fakeDrive([
    { id: "w1", name: "Movers_Hours_2026-09-07_2026-09-13", modifiedTime: "2026-09-14", hours: weekHours },
    { id: "w2", name: "Movers_Hours_2026-09-14_2026-09-20", modifiedTime: "2026-09-21", hours: weekHours },
    { id: "w3", name: "Movers_Hours_2026-09-21_2026-09-27", modifiedTime: "2026-09-28", hours: weekHours }
  ], people);
  const r = await importWeeklyHours(drive, { period: "2026-09-01", log: () => {} });
  const got = (await query(
    `select hours::float8 h from hours where period='2026-09-01' and employee_id=$1`,
    [roster[0].id])).rows[0];
  check("three weeks are summed", got.h === 60, `20 x 3 = ${got.h}`);
  check("all three files counted", r.weeks.length === 3);
}

console.log("\n3. A MONTH-END PULL REPLACES THE WEEKS");
{
  const drive = fakeDrive([
    { id: "w1", name: "Movers_Hours_2026-09-07_2026-09-13", modifiedTime: "2026-09-14", hours: weekHours },
    { id: "w2", name: "Movers_Hours_2026-09-14_2026-09-20", modifiedTime: "2026-09-21", hours: weekHours },
    { id: "w3", name: "Movers_Hours_2026-09-21_2026-09-27", modifiedTime: "2026-09-28", hours: weekHours },
    { id: "m1", name: "Movers_Hours_2026-09-01_2026-09-30", modifiedTime: "2026-10-01", hours: monthHours }
  ], people);
  const r = await importWeeklyHours(drive, { period: "2026-09-01", log: () => {} });
  const got = (await query(
    `select hours::float8 h from hours where period='2026-09-01' and employee_id=$1`,
    [roster[0].id])).rows[0];

  check("the month-end figure wins outright", got.h === 68, `${got.h} — not 60, not 128`);
  check("the weeks are skipped, not silently dropped",
    r.skipped.filter(s => /superseded/.test(s.why)).length === 3,
    r.skipped.map(s => s.why)[0]);
  check("only the month file contributed", r.weeks.length === 1 && r.weeks[0].kind === "month");
}

console.log("\n4. A STRADDLING WEEK IS ONLY HALF SUPERSEDED");
{
  const drive = fakeDrive([
    { id: "wx", name: "Movers_Hours_2026-09-28_2026-10-04", modifiedTime: "2026-10-05", hours: weekHours },
    { id: "m1", name: "Movers_Hours_2026-09-01_2026-09-30", modifiedTime: "2026-10-01", hours: monthHours }
  ], people);

  await importWeeklyHours(drive, { period: "2026-09-01", log: () => {} });
  const sep = (await query(
    `select hours::float8 h from hours where period='2026-09-01' and employee_id=$1`,
    [roster[0].id])).rows[0];
  check("September takes the month-end number only", sep.h === 68, `${sep.h}`);

  await importWeeklyHours(drive, { period: "2026-10-01", log: () => {} });
  const oct = (await query(
    `select hours::float8 h from hours where period='2026-10-01' and employee_id=$1`,
    [roster[0].id])).rows[0];
  const expected = Math.round(20 * (4 / 7) * 100) / 100;
  check("October still gets its four days of that week", oct.h === expected,
    `4/7 of 20 = ${oct.h}`);
}

console.log("\n5. RE-PULLING A MONTH USES THE NEWER FILE");
{
  const drive = fakeDrive([
    { id: "m1", name: "Movers_Hours_2026-09-01_2026-09-30", modifiedTime: "2026-10-01", hours: monthHours },
    { id: "m2", name: "Movers_Hours_2026-09-01_2026-09-30", modifiedTime: "2026-10-03",
      hours: Object.fromEntries(people.map(p => [p.name, 71])) }
  ], people);
  await importWeeklyHours(drive, { period: "2026-09-01", log: () => {} });
  const got = (await query(
    `select hours::float8 h from hours where period='2026-09-01' and employee_id=$1`,
    [roster[0].id])).rows[0];
  check("a corrected re-pull replaces the first", got.h === 71, `${got.h} — the later file`);
}

console.log("\n6. RUNNING TWICE CHANGES NOTHING");
{
  const drive = fakeDrive([
    { id: "m1", name: "Movers_Hours_2026-09-01_2026-09-30", modifiedTime: "2026-10-01", hours: monthHours }
  ], people);
  await importWeeklyHours(drive, { period: "2026-09-01", log: () => {} });
  await importWeeklyHours(drive, { period: "2026-09-01", log: () => {} });
  const got = (await query(
    `select hours::float8 h from hours where period='2026-09-01' and employee_id=$1`,
    [roster[0].id])).rows[0];
  check("hours are rebuilt, never accumulated", got.h === 68, `${got.h}`);
}

await query(`delete from hours where recorded_by = 'connecteam'`);
console.log("\ntest hours removed.");

console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
await close();
process.exit(failures ? 1 : 0);
