/* One-off: copy a Connecteam weekly export into our own Hours tab, so the
   expected shape is visible in the sheet rather than described in a message.
   Once the Drive API is on, the Connecteam files are read directly and this
   tab goes back to being a manual fallback. */
import { createGoogleClient } from "../src/sync/google.js";
import { readWeeklyFile } from "../src/sync/hours-weekly.js";
import { HOURS_TAB, HOURS_HEADER, importHours, nameMatcher } from "../src/sync/hours.js";
import { query, close, loadEnv } from "../src/db.js";

loadEnv();
process.env.GOOGLE_SERVICE_ACCOUNT_FILE ||= process.env.GSA_FILE ?? "";

const SOURCE = process.argv[2] || "1ISyIM47vMRdVFo_YuxznZs5z435kuyUakNgi7LsHH_s";
const google = createGoogleClient();

const file = await readWeeklyFile(google, SOURCE);
const weekEnd = file.week ? file.week.to.toISOString().slice(0, 10) : "";
console.log(`source: ${file.title}`);
console.log(`week ending: ${weekEnd}\n`);

const roster = (await query(
  `select id, full_name, code_name from employees where status <> 'left'`)).rows;
const match = nameMatcher(roster);

/* Keep Matthew's spelling in the sheet, not ours — the tab should show what a
   real paste looks like, including names that need the matcher to resolve. */
const rows = file.rows.map(r => {
  const emp = match(r.name);
  return [r.name, weekEnd, r.hours,
    emp ? (emp.full_name === r.name ? "" : `matches ${emp.full_name}`) : "NOT ON THE ROSTER"];
});

await google.write(process.env.SHEET_ID,
  `${HOURS_TAB}!A1:D${rows.length + 1}`, [HOURS_HEADER, ...rows]);
await google.clear(process.env.SHEET_ID, `${HOURS_TAB}!A${rows.length + 2}:D2000`);

console.log("written to the Hours tab:");
console.log("  " + HOURS_HEADER.join(" | "));
for (const r of rows) console.log("  " + r.join(" | "));

const imported = await importHours(google, process.env.SHEET_ID, { period: "2026-09-01" });
console.log(`\nimported: ${imported.written} people from ${imported.rowsRead} rows` +
  (imported.unmatched.length ? `, unmatched: ${imported.unmatched.map(u => u.name).join(", ")}` : ", all matched"));

const state = await query(`
  select e.code_name, e.full_name, coalesce(h.hours,0)::float8 as hours,
         coalesce(h.hours,0) >= 75 as over
    from employees e
    left join hours h on h.employee_id = e.id and h.period = '2026-09-01'
   where e.status <> 'left'
   order by coalesce(h.hours,0) desc, e.full_name`);

console.log("\nSEPTEMBER SO FAR");
for (const r of state.rows) {
  console.log(`  ${r.code_name.padEnd(9)}${r.full_name.padEnd(20)}` +
    `${String(r.hours).padStart(7)}h  ${r.over ? "over 75" : (75 - r.hours).toFixed(2) + "h short"}`);
}
const qualified = state.rows.filter(r => r.over).length;
console.log(`\n${qualified} of ${state.rows.length} over the 75-hour minimum`);

await close();
