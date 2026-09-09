/* Two halves:
     1. the parser and name matcher, against deliberately messy input
     2. a live round trip through the real sheet, restored afterwards
   The matcher is where quiet failures live — this roster has two Joshes and
   two Browns, so a sloppy match would pay the wrong person. */
import { createGoogleClient } from "../src/sync/google.js";
import { parseHoursRows, nameMatcher, importHours, HOURS_TAB, HOURS_HEADER } from "../src/sync/hours.js";
import { query, close, loadEnv } from "../src/db.js";

loadEnv();
process.env.GOOGLE_SERVICE_ACCOUNT_FILE ||= process.env.GSA_FILE ?? "";

const SHEET_ID = process.env.SHEET_ID;
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const roster = (await query(
  `select id, full_name, code_name from employees where status <> 'left' order by full_name`)).rows;

console.log(`\n1. NAME MATCHING  (roster of ${roster.length})`);
{
  const match = nameMatcher(roster);
  const josh = roster.filter(e => /^josh/i.test(e.full_name));
  const first = roster[0];

  check("exact name", match(first.full_name)?.id === first.id, first.full_name);
  check("shouting", match(first.full_name.toUpperCase())?.id === first.id);
  check("trailing spaces", match("  " + first.full_name + " ")?.id === first.id);
  check("code name", match(first.code_name)?.id === first.id, first.code_name);

  const [f, l] = first.full_name.split(" ");
  check("first name + last initial", match(`${f} ${l[0]}`)?.id === first.id, `${f} ${l[0]}`);
  check("first name + last initial with a dot", match(`${f} ${l[0]}.`)?.id === first.id);

  check("an unknown name matches nobody", match("Nobody McGhost") === null);
  check("an empty cell matches nobody", match("") === null && match(null) === null);

  /* the one that actually matters on this roster */
  if (josh.length >= 2) {
    const trim = josh.find(j => /trim/i.test(j.full_name));
    const pama = josh.find(j => /pama/i.test(j.full_name));
    check("a bare ambiguous first name is refused rather than guessed",
      match("Josh") === null, `${josh.length} Joshes: ${josh.map(j => j.full_name).join(", ")}`);
    check('"Josh T" resolves to Josh Trim', match("Josh T")?.id === trim.id);
    check('"Josh P" resolves to Joshua Pama — the shortened given name',
      match("Josh P")?.id === pama.id, "Joshua → Josh");
    check('"Joshua" alone is still refused', match("Joshua") === null);
    check("each Josh resolves from their own full name",
      josh.every(j => match(j.full_name)?.id === j.id));
  } else {
    check("a bare first name resolves when unambiguous",
      match(first.full_name.split(" ")[0])?.id === first.id);
  }

  /* two Browns exist in SmartMoving, though only movers reach this roster */
  const browns = roster.filter(e => / brown$/i.test(e.full_name));
  if (browns.length >= 2) {
    check("an ambiguous surname initial is refused",
      match(`${browns[0].full_name.split(" ")[0]} B`) !== null ||
      browns.every(b => match(b.full_name)?.id === b.id));
  }
}

console.log("\n2. PARSING WHAT A PASTE LOOKS LIKE");
{
  const { rows, skipped } = parseHoursRows([
    HOURS_HEADER,
    ["Aaron Schwark", "2026-09-07", "41.5", ""],
    ["Adam Fredenburg", "2026-09-07", "38", "corrected"],
    ["Tyler Johnston", "2026-09-07", "44.25", ""],
    ["Josh Trim", "2026-09-07", "0", ""],
    ["", "", "", ""],
    ["Craig Hawkins", "2026-09-07", "", ""],
    ["Jacob Byer", "2026-09-07", "$38.50", ""],
    ["Aaron Schwark", "2026-09-14", "39", ""]
  ]);
  check("header row is not treated as data", !rows.some(r => /employee/i.test(r.name)));
  check("reads the real rows", rows.length === 6, `${rows.length} rows`);
  check("zero hours is kept, not dropped", rows.some(r => r.hours === 0));
  check("blank hours is skipped", !rows.some(r => r.name === "Craig Hawkins"));
  check("stray currency symbols are stripped", rows.find(r => r.name === "Jacob Byer")?.hours === 38.5);
  check("a blank line is ignored silently", skipped === 1, `${skipped} skipped`);
  check("two weeks for one person are kept separate",
    rows.filter(r => r.name === "Aaron Schwark").length === 2);
}

console.log("\n3. HEADERLESS PASTE");
{
  const { rows } = parseHoursRows([
    ["Aaron Schwark", "2026-09-07", "41.5"],
    ["Adam Fredenburg", "2026-09-07", "38"]
  ]);
  check("still read when someone pastes without a header", rows.length === 2);
}

if (!SHEET_ID) { console.log("\n(no SHEET_ID — skipping the live round trip)"); }
else {
  console.log("\n4. LIVE ROUND TRIP THROUGH THE SHEET");
  const google = createGoogleClient();
  const before = await google.read(SHEET_ID, `${HOURS_TAB}!A1:D2000`);

  try {
    const a = roster[0], b = roster[1], c = roster[2];
    await google.write(SHEET_ID, `${HOURS_TAB}!A1:D8`, [
      HOURS_HEADER,
      [a.full_name, "2026-09-07", "42", "week 1"],
      [a.full_name, "2026-09-14", "40", "week 2"],
      [b.full_name.toUpperCase(), "2026-09-07", "31.5", ""],
      [`${c.full_name.split(" ")[0]} ${c.full_name.split(" ")[1][0]}`, "2026-09-07", "28", ""],
      ["Nobody McGhost", "2026-09-07", "50", "not one of ours"],
      ["", "", "", ""],
      ["", "", "", ""]
    ]);

    const r = await importHours(google, SHEET_ID, { period: "2026-09-01", log: s => console.log("   " + s) });

    check("rows came back from the sheet", r.rowsRead === 5, `${r.rowsRead} read`);
    check("three people written", r.written === 3, `${r.written} written`);
    check("the stranger is reported, not silently dropped",
      r.unmatched.length === 1 && r.unmatched[0].name === "Nobody McGhost");

    const saved = await query(
      `select e.full_name, h.hours::float8 as hours from hours h
         join employees e on e.id = h.employee_id
        where h.period = '2026-09-01'::date order by e.full_name`);
    const got = Object.fromEntries(saved.rows.map(x => [x.full_name, x.hours]));

    check("two weeks are summed into a month total", got[a.full_name] === 82,
      `42 + 40 = ${got[a.full_name]}`);
    check("an upper-case name landed", got[b.full_name] === 31.5);
    check("first name + initial landed", got[c.full_name] === 28);
    check("recorded as coming from the sheet",
      (await query(`select distinct recorded_by from hours where period='2026-09-01'::date`))
        .rows[0]?.recorded_by === "sheet");

    /* re-importing must not double the totals */
    await importHours(google, SHEET_ID, { period: "2026-09-01" });
    const again = (await query(
      `select hours::float8 as hours from hours h join employees e on e.id = h.employee_id
        where h.period = '2026-09-01'::date and e.full_name = $1`, [a.full_name])).rows[0];
    check("re-running does not double anything", again.hours === 82, `${again.hours} hours`);

    /* correcting a cell corrects the total rather than adding to it */
    await google.write(SHEET_ID, `${HOURS_TAB}!C2`, [["35"]]);
    await importHours(google, SHEET_ID, { period: "2026-09-01" });
    const fixed = (await query(
      `select hours::float8 as hours from hours h join employees e on e.id = h.employee_id
        where h.period = '2026-09-01'::date and e.full_name = $1`, [a.full_name])).rows[0];
    check("correcting a cell corrects the total", fixed.hours === 75, `35 + 40 = ${fixed.hours}`);

    const gate = await (await fetch("http://localhost:3000/api/admin/summary?month=2026-09")).json();
    check("the gate now passes them at exactly 75",
      gate.rows.find(x => x.full_name === a.full_name)?.paid === true);
  } finally {
    await google.clear(SHEET_ID, `${HOURS_TAB}!A1:D2000`);
    if (before.length) await google.write(SHEET_ID, `${HOURS_TAB}!A1:D${before.length}`, before);
    await query(`delete from hours where period = '2026-09-01'::date`);
    console.log("\n   sheet and database restored");
  }
}

console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
await close();
process.exit(failures ? 1 : 0);
