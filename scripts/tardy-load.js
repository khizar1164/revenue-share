/* Load a copy of Matthew's tardy log by hand, until the log is a Google Sheet
   the website reads on its own. Same parser, same rules, same tag — so the
   first automatic run simply replaces what this wrote.

     node scripts/tardy-load.js --late late.csv --truck truck.csv --month 2026-09          show only
     node scripts/tardy-load.js --late late.csv --truck truck.csv --month 2026-09 --apply  write

   Each CSV is one tab exported as it stands: header row "Employee, 9/1, 9/2 …". */
import { readFileSync } from "node:fs";
import { parseLogGrid, loadEntries } from "../src/sync/tardy.js";
import { close, loadEnv } from "../src/db.js";

loadEnv();
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const month = arg("--month");
if (!/^\d{4}-\d{2}$/.test(month ?? "")) throw new Error("--month YYYY-MM is required");
const [year, m] = month.split("-").map(Number);
const apply = process.argv.includes("--apply");

const entries = [], warnings = [];
for (const kind of ["late", "truck"]) {
  const file = arg("--" + kind);
  if (!file) continue;
  const grid = readFileSync(file, "utf8").trim().split(/\r?\n/).map(l => l.split(","));
  const r = parseLogGrid(grid, { kind, year, month: m });
  if (r.problem) throw new Error(`${file}: ${r.problem}`);
  entries.push(...r.entries);
  warnings.push(...r.warnings);
}

try {
  const out = await loadEntries(entries, { period: `${month}-01`, warnings, dryRun: !apply });
  const byPerson = new Map();
  for (const e of out.events) byPerson.set(e.full_name, (byPerson.get(e.full_name) ?? 0) + e.delta);
  console.log("\n" + [...byPerson].sort((a, b) => a[1] - b[1]).map(([n, d]) => `  ${n.padEnd(18)} ${d}`).join("\n"));
  console.log(`\n${out.summary}`);
  console.log(apply ? "\nwritten — replaces this month's tardy-log entries" : "\nnothing written (add --apply)");
} finally {
  await close();
}
