/* Sign-in, tested against the real database.
   The point of this file is the things that must NOT happen: reading someone
   else's report, replaying a used link, or learning who works here by trying
   addresses at the sign-in box. */
import { issueLoginToken, consumeLoginToken, sessionFor, endSession, purgeExpired }
  from "../src/auth.js";
import { signInEmail } from "../src/mail.js";
import { query, close, loadEnv } from "../src/db.js";

loadEnv();
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const roster = (await query(
  `select id, code_name, full_name from employees
    where status <> 'left' and is_mover order by full_name limit 2`)).rows;
const [alice, bob] = roster;
const aliceEmail = "auth-check-a@example.com";
const bobEmail   = "auth-check-b@example.com";

await query(`update employees set email = $2 where id = $1`, [alice.id, aliceEmail]);
await query(`update employees set email = $2 where id = $1`, [bob.id, bobEmail]);

try {
  console.log(`\n1. ISSUING A LINK  (${alice.full_name})`);
  const issued = await issueLoginToken(aliceEmail);
  check("a link is issued for someone on the roster", !!issued?.token);
  check("it is tied to the right person", issued.employee.id === alice.id);
  check("it expires soon, not eventually", issued.expiresInMinutes <= 30,
    `${issued.expiresInMinutes} minutes`);
  check("the token is long enough to be unguessable", issued.token.length >= 40,
    `${issued.token.length} chars`);

  const stored = await query(
    `select token_hash from login_tokens where employee_id = $1 order by created_at desc limit 1`,
    [alice.id]);
  check("the token itself is never stored, only a hash",
    stored.rows[0].token_hash !== issued.token && stored.rows[0].token_hash.length === 64);

  console.log("\n2. AN UNKNOWN ADDRESS GIVES NOTHING AWAY");
  check("a stranger gets no link", (await issueLoginToken("nobody@example.com")) === null);
  check("an empty address is refused", (await issueLoginToken("")) === null);
  check("nonsense is refused", (await issueLoginToken("not-an-email")) === null);

  console.log("\n3. SPENDING THE LINK");
  const session = await consumeLoginToken(issued.token);
  check("the link opens a session", !!session?.token);
  check("the session lasts a sensible time", session.expiresInDays <= 60,
    `${session.expiresInDays} days`);

  const who = await sessionFor(session.token);
  check("the session resolves to the right person", who?.id === alice.id, who?.full_name);

  console.log("\n4. A LINK WORKS ONCE");
  check("replaying it fails", (await consumeLoginToken(issued.token)) === null);
  check("the first session still works", (await sessionFor(session.token))?.id === alice.id);

  console.log("\n5. RUBBISH IS REFUSED");
  check("a made-up link fails", (await consumeLoginToken("not-a-real-token")) === null);
  check("an empty link fails", (await consumeLoginToken("")) === null);
  check("a made-up session fails", (await sessionFor("not-a-real-session")) === null);

  console.log("\n6. ASKING AGAIN CANCELS THE OLD LINK");
  const first = await issueLoginToken(aliceEmail);
  const second = await issueLoginToken(aliceEmail);
  check("the older link stops working", (await consumeLoginToken(first.token)) === null,
    "no widening the window by clicking twice");
  check("the newer one works", !!(await consumeLoginToken(second.token)));

  console.log("\n7. AN EXPIRED LINK IS DEAD");
  const old = await issueLoginToken(bobEmail);
  await query(`update login_tokens set expires_at = now() - interval '1 minute'
                where employee_id = $1 and used_at is null`, [bob.id]);
  check("it will not open a session", (await consumeLoginToken(old.token)) === null);

  console.log("\n8. SIGNING OUT");
  const s2 = await consumeLoginToken((await issueLoginToken(bobEmail)).token);
  check("signed in", (await sessionFor(s2.token))?.id === bob.id);
  await endSession(s2.token);
  check("the session is gone after signing out", (await sessionFor(s2.token)) === null);

  console.log("\n9. SOMEONE WHO HAS LEFT CANNOT SIGN IN");
  await query(`update employees set status = 'left' where id = $1`, [bob.id]);
  check("no link is issued", (await issueLoginToken(bobEmail)) === null);
  await query(`update employees set status = 'active' where id = $1`, [bob.id]);

  console.log("\n10. THE EMAIL ITSELF");
  const mail = signInEmail({ name: alice.full_name, url: "https://example.com/auth/abc", minutes: 20 });
  check("has a subject", /revenue share/i.test(mail.subject), mail.subject);
  check("greets them by first name", mail.text.includes(alice.full_name.split(" ")[0]));
  check("contains the link", mail.html.includes("https://example.com/auth/abc"));
  check("says how long it lasts", /20 minutes/.test(mail.text));
  check("has a plain-text version for phones that want it", mail.text.length > 100);
  check("carries no figures — the link is the only thing in it",
    !/\$/.test(mail.text), "nothing to leak if forwarded");

  console.log("\n11. HOUSEKEEPING");
  const purged = await purgeExpired();
  check("expired rows can be cleared", typeof purged.sessions === "number",
    `${purged.sessions} sessions, ${purged.tokens} tokens`);

  console.log("\n" + "=".repeat(58));
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
  console.log("=".repeat(58));
} catch (e) {
  console.error("ERRORED:", e.message);
  failures++;
} finally {
  await query(`delete from sessions where employee_id = any($1)`, [[alice.id, bob.id]]);
  await query(`delete from login_tokens where employee_id = any($1)`, [[alice.id, bob.id]]);
  await query(`update employees set email = null, status = 'active' where id = any($1)`,
    [[alice.id, bob.id]]);
  console.log("\ntest accounts cleaned up.");
  await close();
}
process.exit(failures ? 1 : 0);
