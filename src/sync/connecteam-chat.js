/* Crew photos and reviews posted in Connecteam's team chats.
 *
 * 19 November 2026: crews post job photos in the "Photos" team chat and
 * customer reviews in "Reviews". Connecteam's API cannot read chat messages,
 * only list the chats, so the company brain had no way to see them. A webhook
 * can: Connecteam calls us for every new message, with its text and, for a
 * photo, a download link.
 *
 * This is the TEST receiver. It keeps the last 50 messages in memory and
 * shows them on an admin endpoint, so we can see exactly what Connecteam sends
 * before building anything on it. Nothing is written to the database and no
 * photo is downloaded or stored; for each attachment it only checks that the
 * link opens.
 *
 * Connecteam does not sign the body. It sends back the secret we gave it when
 * the webhook was registered, in the x-webhook-secret header, so that is what
 * is checked. Only the chats listed in CONNECTEAM_CHAT_WATCH are kept; a
 * private conversation is never kept, whatever the list says.
 */
import { timingSafeEqual } from "node:crypto";

const KEEP = 50;
const recent = [];

const secretOk = got => {
  const want = process.env.CONNECTEAM_WEBHOOK_SECRET || "";
  if (!want || !got) return false;
  const a = Buffer.from(String(got)), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};

const watched = () => new Set(String(process.env.CONNECTEAM_CHAT_WATCH || "")
  .split(",").map(s => s.trim()).filter(Boolean));

/* Does the photo link open, and what is it? Checked once, in the background. */
async function probe(url) {
  try {
    const r = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, redirect: "follow",
                                 signal: AbortSignal.timeout(8000) });
    return { status: r.status, contentType: r.headers.get("content-type") };
  } catch (e) {
    return { error: e.message.slice(0, 120) };
  }
}

export function mountConnecteamChat(app, wrap) {
  app.post("/api/hooks/connecteam-chat", (req, res) => {
    if (!process.env.CONNECTEAM_WEBHOOK_SECRET) return res.status(503).json({ error: "not set up" });
    if (!secretOk(req.get("x-webhook-secret"))) return res.status(401).json({ error: "bad secret" });

    const b = req.body ?? {};
    const m = b.data?.message ?? {};
    const watch = watched();
    /* Answer straight away: Connecteam gives up after 10 seconds and retries. */
    res.status(200).json({ ok: true });

    if (m.conversationType === "private") return;
    if (watch.size && !watch.has(String(m.conversationId))) return;

    const entry = {
      received_at: new Date().toISOString(),
      request_id: b.requestId ?? null,
      event: b.eventType ?? null,
      conversation_id: m.conversationId ?? null,
      conversation_type: m.conversationType ?? null,
      message_id: m.id ?? null,
      message_type: m.type ?? null,
      sender_id: m.senderId ?? null,
      text: typeof m.content === "string" ? m.content.slice(0, 300) : null,
      attachments: (Array.isArray(m.attachments) ? m.attachments : []).map(a => ({
        type: a.type ?? null, file_name: a.fileName ?? null, file_size: a.fileSize ?? null,
        url_host: (() => { try { return new URL(a.url).host; } catch { return null; } })(),
        opens: null
      })),
      /* the envelope's own keys, so a field we did not expect is still visible */
      keys: Object.keys(b), message_keys: Object.keys(m)
    };
    recent.unshift(entry);
    recent.length = Math.min(recent.length, KEEP);
    console.log(`connecteam chat: ${entry.event} ${entry.message_type} in ${entry.conversation_id}, ` +
      `${entry.attachments.length} attachment(s)`);

    const urls = (Array.isArray(m.attachments) ? m.attachments : []).map(a => a.url);
    Promise.all(urls.map(u => u ? probe(u) : Promise.resolve(null)))
      .then(res => res.forEach((p, i) => { entry.attachments[i].opens = p; }));
  });

  app.get("/api/admin/connecteam-chat/recent", wrap(async (_req, res) => {
    res.json({ configured: Boolean(process.env.CONNECTEAM_WEBHOOK_SECRET),
               watching: [...watched()], count: recent.length, recent });
  }));
}
