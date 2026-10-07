/* Sending mail, via Resend.
 *
 * One message type: the sign-in link. It is read on a phone, in a truck, by
 * someone who wants to know what they earned — so it is short, the link is the
 * only thing to do, and it says how long it lasts.
 */

const API = "https://api.resend.com/emails";

export const FROM = process.env.MAIL_FROM ||
  "Immediate Movers <revenue-share@share.immediatemover.com>";

/* Andrew, 10 September: "I don't want any emails sent to them yet about logging
   in at this time." So sending is OFF unless someone deliberately turns it on
   with SEND_EMAILS=on. Configured and enabled are two different questions, and
   this file will not send a single message until the second one is answered.

   This is a hard stop rather than a note in a README because the sign-in
   endpoint is live and one stray request would otherwise mail a mover. */
export function sendingEnabled() {
  return process.env.SEND_EMAILS === "on";
}

export function mailConfigured() {
  return Boolean(process.env.RESEND_API_KEY) && sendingEnabled();
}

/** Why sending is unavailable, in words worth showing someone. */
export function mailStatus() {
  if (!process.env.RESEND_API_KEY) return "no Resend API key configured";
  if (!sendingEnabled()) return "sending is switched off — Andrew has not approved crew emails yet";
  return null;
}

/* A second, independent stop.
 *
 * MAIL_ALLOWLIST names the only addresses that may receive anything. It exists
 * so the pipeline can be tested end to end without any possibility of a message
 * reaching a mover — turning sending on for a test does not also open the door
 * to fourteen other people. Leave it unset once the crew are meant to receive
 * mail; until then it should name only whoever is doing the testing. */
export function allowedRecipients() {
  const raw = process.env.MAIL_ALLOWLIST;
  if (!raw) return null;                       // null = no restriction
  return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function refuseIfNotAllowed(to) {
  const allow = allowedRecipients();
  if (!allow) return;
  const blocked = (Array.isArray(to) ? to : [to])
    .map(a => String(a).toLowerCase())
    .filter(a => !allow.includes(a));
  if (blocked.length) {
    throw new Error(
      `${blocked.join(", ")} is not on MAIL_ALLOWLIST — while the allowlist is ` +
      `set, only the addresses on it can receive anything`);
  }
}

async function send({ to, subject, html, text, replyTo }) {
  if (!sendingEnabled()) {
    throw new Error(
      "email sending is switched off (SEND_EMAILS is not 'on') — " +
      "Andrew asked that no sign-in emails go to the crew yet");
  }
  refuseIfNotAllowed(to);

  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");

  const res = await fetch(API, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: FROM, to: Array.isArray(to) ? to : [to],
      subject, html, text,
      ...(replyTo ? { reply_to: replyTo } : {})
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.message || body.error || `HTTP ${res.status}`;
    /* the two failures worth naming, because the fix differs */
    if (/domain is not verified/i.test(msg)) {
      throw new Error(`${msg} — the sending domain has not finished verifying in Resend`);
    }
    if (res.status === 403 || /not allowed|restricted/i.test(msg)) {
      throw new Error(`${msg} — check the API key has sending access for this domain`);
    }
    throw new Error(msg);
  }
  return body;
}

/* ---------------------------------------------------------- sign-in link -- */

const esc = s => String(s ?? "").replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function signInEmail({ name, url, minutes }) {
  const first = String(name || "").split(" ")[0] || "there";

  const text =
`Hi ${first},

Here's your link to see your revenue share for this month:

${url}

It works once and lasts ${minutes} minutes. If you didn't ask for it, ignore this — nobody can get in without it.

Immediate Movers & Storage`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f2ee;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ee;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;
                    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
        <tr><td style="background:#1a1815;padding:20px 26px;">
          <div style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:.04em;">
            IMMEDIATE MOVERS <span style="color:#f0762e;">&amp;</span> STORAGE
          </div>
          <div style="color:#8b857a;font-size:12px;letter-spacing:.14em;text-transform:uppercase;margin-top:3px;">
            Revenue Share
          </div>
        </td></tr>
        <tr><td style="padding:28px 26px 8px;color:#1a1815;font-size:16px;line-height:1.55;">
          <p style="margin:0 0 14px;">Hi ${esc(first)},</p>
          <p style="margin:0 0 22px;">Here's your link to see what you've earned this month.</p>
        </td></tr>
        <tr><td align="center" style="padding:0 26px 24px;">
          <a href="${esc(url)}"
             style="display:inline-block;background:#f0762e;color:#1a0e05;text-decoration:none;
                    font-size:16px;font-weight:700;padding:14px 30px;border-radius:9px;">
            See my revenue share
          </a>
        </td></tr>
        <tr><td style="padding:0 26px 26px;color:#6b6459;font-size:13.5px;line-height:1.55;">
          <p style="margin:0 0 12px;">The link works once and lasts ${minutes} minutes.</p>
          <p style="margin:0 0 12px;">If you didn't ask for it you can ignore this — nobody can get in without it.</p>
          <p style="margin:0;word-break:break-all;color:#8b857a;font-size:12px;">
            Button not working? Paste this in: ${esc(url)}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject: "Your revenue share link", html, text };
}

/**
 * The first email, the one nobody asked for.
 *
 * signInEmail is a reply: somebody typed their address into the sign-in page
 * thirty seconds earlier, so "if you didn't ask for it, ignore this" makes
 * sense there. Sent cold to sixteen movers it reads as nonsense, because none
 * of them asked for anything.
 *
 * It also has to answer the question the rollout guarantees. A link lasting
 * twenty minutes, sent to sixteen people at once, is expired for most of them
 * before they look. Told that up front and shown where to get another, that is
 * a non-event. Not told, it is sixteen people saying the link is broken.
 */
export function inviteEmail({ name, url, minutes, base }) {
  const first = String(name || "").split(" ")[0] || "there";
  const me = `${base}/me`;

  const text =
`Hi ${first},

Andrew has set up a page where you can see your own revenue share: your points, your hours, your reviews, and what you have earned this month. Only you can see yours.

${url}

That link works once and lasts ${minutes} minutes, so it may already have expired by the time you open this. If it has, go to ${me}, type in this email address, and a fresh one will arrive.

Any questions, ask Matthew or Andrew.

Immediate Movers & Storage`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f2ee;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ee;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;
                    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
        <tr><td style="background:#1a1815;padding:20px 26px;">
          <div style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:.04em;">
            IMMEDIATE MOVERS <span style="color:#f0762e;">&amp;</span> STORAGE
          </div>
          <div style="color:#8b857a;font-size:12px;letter-spacing:.14em;text-transform:uppercase;margin-top:3px;">
            Revenue Share
          </div>
        </td></tr>
        <tr><td style="padding:28px 26px 8px;color:#1a1815;font-size:16px;line-height:1.55;">
          <p style="margin:0 0 14px;">Hi ${esc(first)},</p>
          <p style="margin:0 0 14px;">Andrew has set up a page where you can see your own
             revenue share: your points, your hours, your reviews, and what you have earned
             this month.</p>
          <p style="margin:0 0 22px;">Only you can see yours.</p>
        </td></tr>
        <tr><td align="center" style="padding:0 26px 24px;">
          <a href="${esc(url)}"
             style="display:inline-block;background:#f0762e;color:#1a0e05;text-decoration:none;
                    font-size:16px;font-weight:700;padding:14px 30px;border-radius:9px;">
            See my revenue share
          </a>
        </td></tr>
        <tr><td style="padding:0 26px 26px;color:#6b6459;font-size:13.5px;line-height:1.55;">
          <p style="margin:0 0 12px;"><b style="color:#1a1815;">If that link has expired</b>, and it
             may well have, go to <a href="${esc(me)}" style="color:#c2561c;">${esc(me)}</a>,
             type in this email address, and a fresh one will arrive. It works once and lasts
             ${minutes} minutes.</p>
          <p style="margin:0 0 12px;">Any questions, ask Matthew or Andrew.</p>
          <p style="margin:0;word-break:break-all;color:#8b857a;font-size:12px;">
            Button not working? Paste this in: ${esc(url)}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject: "Your revenue share", html, text };
}

export async function sendInvite({ to, name, url, minutes, base }) {
  const { subject, html, text } = inviteEmail({ name, url, minutes, base });
  return send({ to, subject, html, text });
}

export async function sendSignInLink({ to, name, url, minutes }) {
  const { subject, html, text } = signInEmail({ name, url, minutes });
  return send({ to, subject, html, text });
}

export { send };
