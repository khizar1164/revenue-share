/* Send the crew their sign-in links.
 *
 *   node scripts/invite.js              show who would be written to, send nothing
 *   node scripts/invite.js --send       actually send
 *   node scripts/invite.js --only "Jacob Byer,Craig Hawkins"
 *
 * Dry run by default, and that is deliberate. This is the one script in the
 * repository that writes to fourteen people at once about their pay, and the
 * cost of a mistake is not a bad row in a table, it is fourteen people reading
 * something nobody meant to send. So it prints the list and stops unless asked
 * twice.
 *
 * It sends the same email the sign-in page sends, through the same function,
 * so there is one wording and one link format rather than a second copy that
 * drifts.
 *
 * Who is left out, and why:
 *   - anyone with no email, because there is nowhere to send it
 *   - anyone marked 'left' or 'no_notice'. Andrew, 8 October: not Aaron
 *     Schwark and not Blade Williams. They forfeited, their dashboard shows
 *     zero, and a link inviting them to look at it is a conversation someone
 *     should choose to have rather than one a script starts.
 *   - anyone not a mover: the office is not on the programme.
 */
import { issueLoginToken } from "../src/auth.js";
import { sendSignInLink, sendingEnabled, mailStatus, allowedRecipients } from "../src/mail.js";
import { query, close, loadEnv } from "../src/db.js";

loadEnv();

const SEND = process.argv.includes("--send");
const only = (() => {
  const i = process.argv.indexOf("--only");
  if (i < 0) return null;
  return new Set((process.argv[i + 1] || "").split(",").map(s => s.trim()).filter(Boolean));
})();

const PUBLIC_URL = (process.env.PUBLIC_URL || "https://share.immediatemover.com").replace(/\/+$/, "");

try {
  const roster = await query(
    `select full_name, email, status from employees
      where is_mover and status = 'active' and coalesce(email,'') <> ''
      order by full_name`);

  const people = roster.rows.filter(p => !only || only.has(p.full_name));
  if (only) {
    for (const name of only) {
      if (!people.some(p => p.full_name === name)) console.log(`  ?  "${name}" is not on the list`);
    }
  }

  /* Say out loud what the guards are set to. Someone running this wants to
     know before they press send, not after it quietly did nothing. */
  const allow = allowedRecipients();
  console.log(`mail: ${mailStatus()}`);
  console.log(`allowlist: ${allow ? allow.join(", ") : "(none — anyone can be written to)"}`);
  console.log(`link base: ${PUBLIC_URL}`);
  console.log(`\n${people.length} to write to:`);
  for (const p of people) console.log(`   ${p.full_name.padEnd(20)} ${p.email}`);

  const skipped = await query(
    `select full_name, status, coalesce(nullif(email,''),'(no email)') email
       from employees where is_mover and (status <> 'active' or coalesce(email,'') = '')
      order by full_name`);
  if (skipped.rowCount) {
    console.log("\nleft out:");
    for (const p of skipped.rows) {
      console.log(`   ${p.full_name.padEnd(20)} ${p.status === "active" ? "no email" : p.status}`);
    }
  }

  if (!SEND) {
    console.log("\nnothing sent. add --send to actually write to these people.");
    process.exit(0);
  }

  if (!sendingEnabled()) {
    console.log("\nSEND_EMAILS is not 'on', so nothing would leave the building. Stopping " +
                "rather than reporting success for mail that never went.");
    process.exit(1);
  }

  console.log("\nsending...");
  let sent = 0, failed = 0;
  for (const p of people) {
    try {
      const issued = await issueLoginToken(p.email);
      if (!issued) { console.log(`  SKIP ${p.full_name} — no sign-in allowed for that address`); continue; }
      await sendSignInLink({
        to: issued.employee.email,
        name: issued.employee.full_name,
        url: `${PUBLIC_URL}/auth/${issued.token}`,
        minutes: issued.expiresInMinutes
      });
      sent++;
      console.log(`  sent ${p.full_name}`);
    } catch (e) {
      failed++;
      console.log(`  FAILED ${p.full_name} — ${e.message}`);
    }
  }
  console.log(`\n${sent} sent, ${failed} failed.`);
  if (sent) {
    console.log("Links last 20 minutes and work once. Anyone who misses the window can " +
                `request another at ${PUBLIC_URL}/me`);
  }
} finally {
  await close();
}
