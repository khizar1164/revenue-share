/* Rebuild who worked each job from MoveitPro, over a range.
 *
 *   node scripts/crew-catchup.js                     this month and last
 *   node scripts/crew-catchup.js 2026-10-01          from that day to the end of this month
 *   node scripts/crew-catchup.js 2026-10-01 2026-10-31
 *
 * The scheduled crew-jobs run keeps the current and previous month up to date.
 * This is for catching up a range once, as after SmartMoving's key stopped
 * working in November 2026 and October's later jobs were never recorded.
 *
 * Needs MOVEITPRO_API_KEY and MOVEITPRO_HMAC_SECRET, and migration 021.
 * From Pakistan the API is behind Cloudflare's block, so a VPN has to be on.
 */
import { loadEnv, close } from "../src/db.js";
import { syncJobCrew } from "../src/sync/mip-crew.js";

loadEnv();
const [from, to] = process.argv.slice(2);
try {
  console.log(await syncJobCrew({ from, to }));
} catch (e) {
  console.error("crew catch-up failed:", e.message);
  process.exitCode = 1;
} finally {
  await close();
}
