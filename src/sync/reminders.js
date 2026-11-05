/* Nudging people towards their own numbers.
 *
 * Andrew, 3 November: six of nineteen movers had ever signed in. "A lot of
 * people don't even know what their name is, and they're not even coming to us
 * and asking." He wanted the rest chased, and the ones who had been in
 * reminded to come back.
 *
 * Two groups, deliberately treated differently:
 *
 *   never signed in    chased weekly until they do. This is onboarding, and
 *                      it stops the day they arrive.
 *   signed in already  every two days. Andrew's figure. In the meeting the
 *                      agreed number was weekly; he raised it afterwards and
 *                      that is what is built.
 *
 * A note on the second group, recorded because it is the thing most likely to
 * need changing. Sixteen people every two days is about two hundred and forty
 * messages a month, and a message that says nothing new teaches people to
 * ignore the channel. If take-up drops or people mute it, the fix is to send
 * that group on change instead — points lost, or short of the hours gate with
 * a week to go — rather than on a timer.
 *
 * Connecteam rather than email, because Andrew asked for it and a push reaches
 * a phone an email does not. The Updates feature he demoed has no API, so this
 * goes through chat; see sendPrivateMessage. Anyone we cannot reach is
 * reported rather than skipped silently — two people have no email at all and
 * can never sign in, which is item 2 of the same review.
 */
import { query, hasColumn } from "../db.js";
import { findUser, sendPrivateMessage, findPublisher, configured, writingEnabled } from "../connecteam.js";

const NEVER_EVERY_DAYS = 7;
const RETURNING_EVERY_DAYS = 2;

/** Who is due a nudge, and which kind. */
export async function due({ now = new Date() } = {}) {
  const tracked = await hasColumn("sign_in_reminders", "sent_at");

  const r = await query(
    `select e.id, e.full_name, e.code_name, coalesce(e.email,'') as email,
            s.last_at,
            ${tracked ? `(select max(sent_at) from sign_in_reminders x
                           where x.employee_id = e.id)` : "null::timestamptz"} as last_nudge
       from employees e
       left join (select employee_id, max(at) as last_at from sign_ins group by employee_id) s
              on s.employee_id = e.id
      where e.is_mover and e.status = 'active'
      order by e.full_name`);

  const out = { never: [], returning: [], unreachable: [] };
  for (const p of r.rows) {
    if (!p.email) { out.unreachable.push(p); continue; }

    const every = p.last_at ? RETURNING_EVERY_DAYS : NEVER_EVERY_DAYS;
    const since = p.last_nudge ? (now - new Date(p.last_nudge)) / 864e5 : Infinity;
    if (since < every) continue;

    (p.last_at ? out.returning : out.never).push(p);
  }
  return out;
}

const textFor = p => p.last_at
  ? `Hi ${p.full_name.split(" ")[0]}, your bonus numbers have moved. `
    + `Open the dashboard to see where you stand this month.`
  : `Hi ${p.full_name.split(" ")[0]}, you have a bonus dashboard and have not signed in yet. `
    + `It shows your points, your hours and what your share is worth. `
    + `Check your email for your sign-in link, or ask in the office for a new one.`;

/**
 * Send what is due.
 *
 * Dry by default, like every other sync here. A reminder run that fires during
 * a test messages real crew on their own phones, which is not something a test
 * gets to do by accident.
 */
export async function sendReminders({ dryRun = true, now = new Date() } = {}) {
  if (!configured()) return { skipped: "no Connecteam API key" };

  const list = await due({ now });
  const tracked = await hasColumn("sign_in_reminders", "sent_at");
  const publisher = (!dryRun && writingEnabled()) ? (await findPublisher())?.id : null;

  const results = { never: 0, returning: 0, failed: [], unreachable: list.unreachable.map(p => p.full_name) };

  for (const [kind, people] of [["never", list.never], ["returning", list.returning]]) {
    for (const p of people) {
      if (dryRun) { results[kind]++; continue; }
      try {
        const who = await findUser({ email: p.email, name: p.full_name });
        if (!who) { results.failed.push(`${p.full_name}: not in Connecteam`); continue; }

        const sent = await sendPrivateMessage({ userId: who.userId ?? who.id, text: textFor(p), publisherId: publisher });
        if (!sent.sent) { results.failed.push(`${p.full_name}: ${sent.why}`); continue; }

        if (tracked) {
          await query(
            `insert into sign_in_reminders (employee_id, kind) values ($1,$2)`, [p.id, kind]);
        }
        results[kind]++;
      } catch (e) {
        results.failed.push(`${p.full_name}: ${e.message.slice(0, 120)}`);
      }
    }
  }

  return { ...results, dryRun };
}
