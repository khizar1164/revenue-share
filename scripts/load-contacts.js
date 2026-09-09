/* Load the crew's contact details from Andrew's export.
 *
 * Storing an address is not the same as writing to it. Nothing here sends
 * anything — sending stays off until Andrew says otherwise, and mail.js
 * refuses regardless of what is in this table.
 */
import { readFileSync } from "node:fs";
import { nameMatcher } from "../src/sync/hours.js";
import { query, close, loadEnv } from "../src/db.js";

loadEnv();
const FILE = process.argv[2] || process.env.CONTACTS_CSV;

/* small CSV reader — this file is plain, but a quoted comma would ruin a split */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim()));
}

const rows = parseCsv(readFileSync(FILE, "utf8"));
const header = rows[0].map(h => h.toLowerCase().trim());
const col = {
  first: header.findIndex(h => /first/.test(h)),
  last:  header.findIndex(h => /last/.test(h)),
  phone: header.findIndex(h => /phone/.test(h)),
  email: header.findIndex(h => /email/.test(h))
};

const roster = (await query(
  `select id, code_name, full_name from employees where status <> 'left' and is_mover`)).rows;
const match = nameMatcher(roster);

const matched = [], unmatched = [];
for (const r of rows.slice(1)) {
  const name = `${r[col.first] ?? ""} ${r[col.last] ?? ""}`.trim();
  const email = String(r[col.email] ?? "").trim().toLowerCase();
  if (!name || !email) continue;
  const emp = match(name);
  if (emp) matched.push({ emp, name, email });
  else unmatched.push({ name, email });
}

console.log(`${rows.length - 1} contacts in the file, roster of ${roster.length}\n`);
for (const m of matched) {
  console.log(`  ${m.emp.code_name.padEnd(9)}${m.name.padEnd(20)}${m.email}`);
  await query(`update employees set email = $2, updated_at = now() where id = $1`,
    [m.emp.id, m.email]);
}
if (unmatched.length) {
  console.log("\nNOT ON THE ROSTER — no address saved:");
  for (const u of unmatched) console.log(`  ${u.name.padEnd(20)}${u.email}`);
}

const missing = roster.filter(e => !matched.some(m => m.emp.id === e.id));
if (missing.length) {
  console.log("\nON THE ROSTER BUT NOT IN THE FILE — still no address:");
  for (const e of missing) console.log(`  ${e.code_name.padEnd(9)}${e.full_name}`);
}

const have = await query(
  `select count(*)::int n from employees where email is not null and is_mover and status <> 'left'`);
console.log(`\n${have.rows[0].n} of ${roster.length} movers now have an address on file.`);
console.log("Nothing has been emailed. Sending stays off until Andrew says otherwise.");

await close();
