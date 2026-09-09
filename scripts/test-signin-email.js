/* Send ONE real sign-in email, to a single named address.
 *
 * Sending is off by default and the allowlist is set to the one recipient, so
 * this cannot reach a mover even by mistake — Andrew has not approved crew
 * emails yet, and that stays true while this runs.
 *
 * To make the link genuinely work, a mover's address is borrowed for the few
 * seconds it takes to issue the token, then put straight back. The token is
 * tied to the person, not the address, so the link keeps working afterwards
 * and shows exactly what that mover would see.
 */
import { issueLoginToken } from "../src/auth.js";
import { query, close, loadEnv } from "../src/db.js";

loadEnv();

const TO = process.argv[2] || "khizarh@immediatemoversnwi.com";

/* the two stops, opened for this one recipient only */
process.env.SEND_EMAILS = "on";
process.env.MAIL_ALLOWLIST = TO;

const { sendSignInLink, FROM, allowedRecipients } = await import("../src/mail.js");

const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:3000";

console.log(`from      ${FROM}`);
console.log(`to        ${TO}`);
console.log(`allowlist ${allowedRecipients().join(", ")}`);
console.log("");

/* borrow a slot so the link resolves to a real report */
const stand = (await query(
  `select id, code_name, full_name, email from employees
    where status <> 'left' and is_mover
    order by (select count(*) from point_events pe where pe.employee_id = employees.id) desc
    limit 1`)).rows[0];

const realEmail = stand.email;
console.log(`borrowing ${stand.code_name} (${stand.full_name}) to issue the link`);

try {
  await query(`update employees set email = $2 where id = $1`, [stand.id, TO]);
  const issued = await issueLoginToken(TO);
  if (!issued) throw new Error("no link was issued — check the roster");

  const url = `${PUBLIC_URL}/auth/${issued.token}`;
  const sent = await sendSignInLink({
    to: TO, name: "Khizar", url, minutes: issued.expiresInMinutes
  });

  console.log(`\nsent. Resend id ${sent.id}`);
  console.log(`the link lasts ${issued.expiresInMinutes} minutes and works once`);
  console.log(`it opens ${stand.code_name}'s report — what a mover would see`);
  console.log(`\nmake sure the server is running:  npm start`);
} finally {
  await query(`update employees set email = $2 where id = $1`, [stand.id, realEmail]);
  console.log(`\n${stand.code_name}'s own address restored.`);
  const check = await query(
    `select count(*)::int n from employees where email = $1`, [TO]);
  console.log(`rows still holding the test address: ${check.rows[0].n} (should be 0)`);
  await close();
}
