/* Create the Hours tab Matthew pastes into, and seed it with the roster so he
   can see the spellings we expect. Safe to re-run — it never clears rows he
   has already entered. */
import { createGoogleClient } from "../src/sync/google.js";
import { HOURS_TAB, HOURS_HEADER } from "../src/sync/hours.js";
import { query, close, loadEnv } from "../src/db.js";

loadEnv();
process.env.GOOGLE_SERVICE_ACCOUNT_FILE ||= process.env.GSA_FILE ?? "";

const SHEET_ID = process.env.SHEET_ID;
if (!SHEET_ID) { console.error("SHEET_ID is not set"); process.exit(1); }

const google = createGoogleClient();
console.log("service account:", google.email);

const info = await google.info(SHEET_ID);
console.log(`workbook: "${info.title}"`);
console.log("existing tabs:", info.tabs.map(t => t.title).join(", "), "\n");

const made = await google.ensureTab(SHEET_ID, HOURS_TAB, { rows: 1000, cols: 4 });
console.log(made ? `created the "${HOURS_TAB}" tab` : `"${HOURS_TAB}" tab already there`);

const existing = await google.read(SHEET_ID, `${HOURS_TAB}!A1:D2000`);
const hasData = existing.length > 1;

if (!hasData) {
  const roster = (await query(
    `select full_name from employees where status <> 'left' order by full_name`)).rows;

  /* Header, then one pre-filled name per mover with hours left blank. Matthew
     can paste over the lot; the point is that he can see which spellings match
     without having to guess. */
  const rows = [HOURS_HEADER, ...roster.map(r => [r.full_name, "", "", ""])];
  await google.write(SHEET_ID, `${HOURS_TAB}!A1:D${rows.length}`, rows);
  await google.formatHeader(SHEET_ID, HOURS_TAB);
  console.log(`wrote the header and ${roster.length} roster names`);
} else {
  console.log(`left ${existing.length - 1} existing rows alone`);
}

console.log(`\nMatthew's link:`);
console.log(`  https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
console.log(`  (the "${HOURS_TAB}" tab)`);

await close();
