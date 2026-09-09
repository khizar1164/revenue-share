/* Write the summary and backup into the real workbook, read them back, and
   check they say what the database says. Leaves the tabs in place — they are
   the deliverable, not test litter — but removes any test rows it created. */
import { createGoogleClient } from "../src/sync/google.js";
import { writeBack, summaryTabName, BACKUP_TAB } from "../src/sync/writeback.js";
import { monthly } from "../src/calc.js";
import { query, close, loadEnv } from "../src/db.js";

loadEnv();
process.env.GOOGLE_SERVICE_ACCOUNT_FILE ||= process.env.GSA_FILE ?? "";

const SHEET_ID = process.env.SHEET_ID;
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const google = createGoogleClient();
const undo = [];

try {
  /* give August something to write: hours for three people plus a bonus */
  const roster = (await query(
    `select id, code_name, full_name from employees where status <> 'left' order by full_name`)).rows;
  const [a, b] = roster;

  for (const [emp, hrs] of [[a, 186], [b, 61]]) {
    await query(
      `insert into hours (employee_id, period, hours, recorded_by)
       values ($1,'2026-08-01',$2,'writeback-check')
       on conflict (employee_id, period) do update set hours = excluded.hours`,
      [emp.id, hrs]);
  }
  undo.push(() => query(`delete from hours where recorded_by = 'writeback-check'`));

  const adj = await query(
    `insert into adjustments (employee_id, occurred_on, kind, reason, amount, recorded_by)
     values ($1,'2026-08-14','bonus','Hoarder house — clean-out fee',150,'writeback-check')
     returning id`, [a.id]);
  undo.push(() => query(`delete from adjustments where recorded_by = 'writeback-check'`));

  console.log("\n1. WRITE");
  const res = await writeBack(google, SHEET_ID, { year: 2026, month: 8, log: s => console.log("   " + s) });
  check("a month tab was written", !!res.tab, res.tab);
  check("the backup tab was written", res.backupRows > 0, `${res.backupRows} records`);

  console.log("\n2. THE SUMMARY MATCHES THE DATABASE");
  {
    const truth = await monthly(2026, 8);
    const rows = await google.read(SHEET_ID, `${res.tab}!A1:K200`, { raw: true });
    const flat = rows.map(r => r.join("|")).join("\n");
    const find = label => {
      const row = rows.find(r => String(r[0] ?? "").trim() === label.trim());
      return row ? Number(String(row[1]).replace(/[$,]/g, "")) : null;
    };

    check("headed with the month", /August 2026/.test(rows[0]?.[0] ?? ""), rows[0]?.[0]);
    check("revenue matches", Math.abs(find("Completed revenue") - truth.revenue) < 0.01,
      `$${find("Completed revenue")}`);
    check("pool matches", Math.abs(find("POOL") - truth.pool) < 0.01, `$${find("POOL")}`);
    check("60/40 split matches",
      Math.abs(find("  Points 60%") - truth.points_pool) < 0.01 &&
      Math.abs(find("  Reviews 40%") - truth.reviews_pool) < 0.01);
    check("take-home matches", Math.abs(find("Total take-home") - truth.totals.take_home) < 0.01);

    const header = rows.find(r => r[0] === "Code");
    check("there is a per-person table", !!header && header[1] === "Name");
    const start = rows.indexOf(header) + 1;
    const people = rows.slice(start).filter(r => r[0] && r[0] !== "" && r[1] !== "TOTAL");
    check("every mover is listed", people.length === truth.counts.roster,
      `${people.length} of ${truth.counts.roster}`);

    const paid = truth.rows.find(p => p.paid);
    if (paid) {
      const row = people.find(r => r[0] === paid.code_name);
      check("a paid mover's take-home matches",
        row && Math.abs(Number(row[9]) - paid.take_home) < 0.01,
        `${paid.code_name} $${row?.[9]}`);
      check("their bonus is shown separately", row && Number(row[7] || 0) === paid.bonuses);
    }
    check("real names are in the summary — this sheet is not the TV",
      flat.includes(a.full_name));
  }

  console.log("\n3. THE BACKUP HOLDS WHAT NOBODY ELSE HAS");
  {
    const rows = await google.read(SHEET_ID, `${BACKUP_TAB}!A1:H5000`);
    const header = rows.find(r => r[0] === "Type");
    const body = rows.slice(rows.indexOf(header) + 1).filter(r => r[0]);
    const types = new Set(body.map(r => r[0]));

    check("point events are backed up", types.has("point"), `${body.filter(r=>r[0]==="point").length} rows`);
    check("hours are backed up", types.has("hours"));
    check("bonuses are backed up", types.has("bonus"));
    check("the same-day points derived from the schedule are there",
      body.some(r => /same-day/i.test(r[4] ?? "")));

    const dbPoints = Number((await query(`select count(*)::int n from point_events`)).rows[0].n);
    check("every point event made it", body.filter(r => r[0] === "point").length === dbPoints,
      `${dbPoints} in the database`);
    check("it says what it is for", /exist nowhere else/i.test(rows[1]?.[0] ?? ""));
  }

  console.log("\n4. WE ONLY TOUCH OUR OWN TABS");
  {
    const info = await google.info(SHEET_ID);
    const names = info.tabs.map(t => t.title);
    check("their original tabs are untouched",
      names.includes("Process Rules") && names.includes("Revenue Share Calculations"),
      names.join(", "));
    check("ours are clearly ours", names.filter(n => n.startsWith("RS ")).length >= 2);

    const rules = await google.read(SHEET_ID, "Process Rules!A1:J40");
    const filled = rules.filter(r => r.some(c => String(c ?? "").trim()));
    check("Process Rules still has its content", filled.length >= 20, filled.length + " rows with content");
    const calcs = await google.read(SHEET_ID, "Revenue Share Calculations!A1:J30");
    check("Revenue Share Calculations is intact",
      calcs.filter(r => r.some(c => String(c ?? "").trim())).length >= 15);
  }

  console.log("\n5. RE-RUNNING IS SAFE");
  {
    const before = (await google.read(SHEET_ID, `${res.tab}!A1:K200`)).length;
    await writeBack(google, SHEET_ID, { year: 2026, month: 8 });
    const after = (await google.read(SHEET_ID, `${res.tab}!A1:K200`)).length;
    check("the tab does not grow each night", before === after, `${before} rows both times`);
  }

  console.log("\n" + "=".repeat(58));
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
  console.log("=".repeat(58));
} catch (e) {
  console.error("\nERRORED:", e.message);
  failures++;
} finally {
  for (const fn of undo.reverse()) { try { await fn(); } catch {} }
  /* rewrite the tabs so what is left in the sheet reflects the real database */
  try { await writeBack(google, SHEET_ID, { year: 2026, month: 8 }); } catch {}
  console.log("\ntest rows removed, tabs rewritten from real data.");
  await close();
}
process.exit(failures ? 1 : 0);
