/* Rebuild and reformat every tab we own. Run after a formatting change, or if
   a nightly write-back failed partway. Safe to run any time. */
import { createGoogleClient } from "../src/sync/google.js";
import { reformatAll } from "../src/sync/writeback.js";
import { close, loadEnv } from "../src/db.js";

loadEnv();
process.env.GOOGLE_SERVICE_ACCOUNT_FILE ||= process.env.GSA_FILE ?? "";

const google = createGoogleClient();
const r = await reformatAll(google, process.env.SHEET_ID, { log: s => console.log("  " + s) });
console.log(`\n${r.tabs.length} tabs rebuilt.`);
await close();
