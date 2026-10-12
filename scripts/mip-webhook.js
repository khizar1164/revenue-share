/* Register, list or remove our MoveitPro webhook endpoint.
 *
 *   node scripts/mip-webhook.js list
 *   node scripts/mip-webhook.js create --send
 *   node scripts/mip-webhook.js ping <endpoint-id>
 *   node scripts/mip-webhook.js delete <endpoint-id> --send
 *
 * Creating is the one that matters, and it can only be done once usefully:
 * MoveitPro returns the endpoint's signing secret EXACTLY ONCE, in that
 * response, and will never show it again. If it is lost the endpoint has to
 * have its secret rotated or be deleted and remade. So create prints it, says
 * plainly that this is the only time, and stops.
 *
 * Writes need an Idempotency-Key, and a retry with the same key replays the
 * original response rather than making a second endpoint — which is exactly
 * what you want from something that can only be done once.
 */
import crypto from "node:crypto";
import { loadEnv } from "../src/db.js";

loadEnv();

const BASE = (process.env.MOVEITPRO_BASE || "https://api.moveitpro.com").replace(/\/+$/, "");
const KEY = (process.env.MOVEITPRO_API_KEY || "").trim();
const SECRET = (process.env.MOVEITPRO_HMAC_SECRET || "").trim();
if (!KEY || !SECRET) {
  console.error("MOVEITPRO_API_KEY and MOVEITPRO_HMAC_SECRET must be set");
  process.exit(1);
}

const PUBLIC_URL = (process.env.PUBLIC_URL || "https://share.immediatemover.com").replace(/\/+$/, "");
const TARGET = `${PUBLIC_URL}/api/hooks/moveitpro`;
const EVENTS = ["job.created", "job.updated", "payment.recorded"];

async function call(method, path, body) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000).toString();
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const canonical = ["v1", ts, method, path, hash].join(":");
  const sig = crypto.createHmac("sha256", SECRET).update(canonical).digest("hex");

  const res = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      "x-mip-timestamp": ts,
      "x-mip-signature": sig,
      accept: "application/json",
      ...(raw ? { "content-type": "application/json" } : {}),
      /* Creating is stable per target and events, so a retry replays the
         original response rather than making a second endpoint. A ping is the
         opposite: you send one to find out whether it works NOW, so it gets a
         fresh key each time. One shared key across both is how the first ping
         came back as idempotency_key_reuse. */
      ...(method === "POST" ? {
        "idempotency-key": path.endsWith("/test")
          ? `ims-ping-${Date.now()}`
          : "ims-relay-" + crypto.createHash("sha256")
              .update(method + path + TARGET + EVENTS.join(",")).digest("hex").slice(0, 32)
      } : {})
    },
    body: raw || undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave it */ }
  return { status: res.status, json, text };
}

const [cmd = "list", arg] = process.argv.slice(2).filter(a => !a.startsWith("--"));
const SEND = process.argv.includes("--send");

if (cmd === "list") {
  const r = await call("GET", "/v1/webhook-endpoints");
  console.log("HTTP", r.status);
  for (const e of r.json?.data ?? []) {
    console.log(`  ${e.id}  ${e.status ?? "?"}  ${e.url}`);
    console.log(`      events: ${(e.events ?? []).join(", ")}`);
  }
  if (!(r.json?.data ?? []).length) console.log("  (none registered)");

} else if (cmd === "create") {
  console.log("url    :", TARGET);
  console.log("events :", EVENTS.join(", "));
  if (!SEND) { console.log("\nnothing created. add --send."); process.exit(0); }

  const r = await call("POST", "/v1/webhook-endpoints", {
    url: TARGET, events: EVENTS, description: "Immediate Movers Discord relay"
  });
  console.log("\nHTTP", r.status);
  if (r.status !== 201) { console.log(r.text.slice(0, 500)); process.exit(1); }

  const e = r.json.data;
  console.log("endpoint id:", e.id);
  console.log("\n" + "=".repeat(62));
  console.log("SIGNING SECRET — shown once, never again:");
  console.log("  " + (e.secret ?? "(replayed, secret not reissued)"));
  console.log("Put it in Render as MIP_WEBHOOK_SECRET.");
  console.log("=".repeat(62));

} else if (cmd === "ping") {
  if (!arg) { console.error("which endpoint?"); process.exit(1); }
  const r = await call("POST", `/v1/webhook-endpoints/${arg}/test`);
  console.log("HTTP", r.status, r.text.slice(0, 300));

} else if (cmd === "delete") {
  if (!arg) { console.error("which endpoint?"); process.exit(1); }
  if (!SEND) { console.log(`would delete ${arg}. add --send.`); process.exit(0); }
  const r = await call("DELETE", `/v1/webhook-endpoints/${arg}`);
  console.log("HTTP", r.status, r.text.slice(0, 200));

} else {
  console.error("list | create | ping <id> | delete <id>");
  process.exit(1);
}
