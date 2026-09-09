/* The month-end tab must override the weekly tab, not add to it.
   Pasting a month total under four weeks of rows would double everyone's
   hours and push people over the gate who never earned it — so this is
   proved against the real sheet, then put back as it was. */
import { createGoogleClient } from "../src/sync/google.js";
import { importHours, HOURS_TAB, HOURS_HEADER, MONTH_TAB, MONTH_HEADER } from "../src/sync/hours.js";
import { query, close, loadEnv } from "../src/db.js";

loadEnv();
process.env.GOOGLE_SERVICE_ACCOUNT_FILE ||= process.env.GSA_FILE ?? "";

const ID = process.env.SHEET_ID;
const google = createGoogleClient();
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const weekBefore  = await google.read(ID, `${HOURS_TAB}!A1:D2000`);
const monthBefore = await google.read(ID, `${MONTH_TAB}!A1:D2000`);

const roster = (await query(
  `select id, full_name from employees where status <> 'left' and is_mover order by full_name limit 3`)).rows;
const hoursOf = async id => Number((await query(
  `select hours::float8 h from hours where period='2026-09-01' and employee_id=$1`, [id])).rows[0]?.h ?? 0);

try {
  console.log("\n1. WEEKS ONLY");
  await google.clear(ID, `${MONTH_TAB}!A1:D2000`);
  await google.write(ID, `${MONTH_TAB}!A1:D1`, [MONTH_HEADER]);
  await google.clear(ID, `${HOURS_TAB}!A1:D2000`);
  await google.write(ID, `${HOURS_TAB}!A1:D7`, [
    HOURS_HEADER,
    [roster[0].full_name, "2026-09-06", 22, ""],
    [roster[0].full_name, "2026-09-13", 21, ""],
    [roster[0].full_name, "2026-09-20", 19, ""],
    [roster[1].full_name, "2026-09-13", 30, ""],
    [roster[1].full_name, "2026-09-20", 28, ""],
    [roster[2].full_name, "2026-09-13", 12, ""]
  ]);
  await importHours(google, ID, { period: "2026-09-01", log: s => console.log("   " + s) });
  check("three weeks add up", await hoursOf(roster[0].id) === 62, `22+21+19 = ${await hoursOf(roster[0].id)}`);
  check("second person adds up too", await hoursOf(roster[1].id) === 58);
  check("nobody is over 75 yet", (await hoursOf(roster[0].id)) < 75);

  console.log("\n2. THE MONTH-END PULL LANDS");
  await google.write(ID, `${MONTH_TAB}!A1:D4`, [
    MONTH_HEADER,
    [roster[0].full_name, "2026-09", 81.5, "final"],
    [roster[1].full_name, "2026-09", 76.25, "final"],
    [roster[2].full_name, "2026-09", 14, "final"]
  ]);
  await importHours(google, ID, { period: "2026-09-01", log: s => console.log("   " + s) });

  const a = await hoursOf(roster[0].id);
  check("the month figure replaces the weeks", a === 81.5, `${a} — not 62, not 143.5`);
  check("second person likewise", await hoursOf(roster[1].id) === 76.25);
  check("and the third", await hoursOf(roster[2].id) === 14);
  check("the gate now passes them", a >= 75, `${a}h clears 75`);

  console.log("\n3. CORRECTING THE MONTH FIGURE");
  await google.write(ID, `${MONTH_TAB}!C2`, [[79]]);
  await importHours(google, ID, { period: "2026-09-01" });
  check("a corrected cell corrects the total", await hoursOf(roster[0].id) === 79, "81.5 → 79");

  console.log("\n4. RUNNING AGAIN CHANGES NOTHING");
  await importHours(google, ID, { period: "2026-09-01" });
  await importHours(google, ID, { period: "2026-09-01" });
  check("hours are rebuilt, never accumulated", await hoursOf(roster[0].id) === 79);

  console.log("\n5. REMOVING THE MONTH ROWS FALLS BACK TO THE WEEKS");
  await google.clear(ID, `${MONTH_TAB}!A2:D2000`);
  await importHours(google, ID, { period: "2026-09-01" });
  check("the weekly total returns", await hoursOf(roster[0].id) === 62, `back to ${await hoursOf(roster[0].id)}`);

  console.log("\n6. A MONTH WRITTEN AS WORDS STILL WORKS");
  await google.write(ID, `${MONTH_TAB}!A1:D2`, [MONTH_HEADER,
    [roster[0].full_name, "September 2026", 88, ""]]);
  await importHours(google, ID, { period: "2026-09-01" });
  check('"September 2026" is understood', await hoursOf(roster[0].id) === 88);

  console.log("\n" + "=".repeat(58));
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
  console.log("=".repeat(58));
} catch (e) {
  console.error("ERRORED:", e.message);
  failures++;
} finally {
  await google.clear(ID, `${HOURS_TAB}!A1:D2000`);
  if (weekBefore.length) await google.write(ID, `${HOURS_TAB}!A1:D${weekBefore.length}`, weekBefore);
  await google.clear(ID, `${MONTH_TAB}!A1:D2000`);
  if (monthBefore.length) await google.write(ID, `${MONTH_TAB}!A1:D${monthBefore.length}`, monthBefore);
  await query(`delete from hours where period = '2026-09-01'`);
  await importHours(google, ID, { period: "2026-09-01" });   // restore the real figures
  console.log("\nsheet restored, real hours re-imported.");
  await close();
}
process.exit(failures ? 1 : 0);
