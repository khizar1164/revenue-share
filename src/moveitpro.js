/* MoveitPro: a signed client, and verification of what they send back.
 *
 * Two different signature schemes live here and they are not the same thing.
 * Conflating them is the obvious mistake, so they are named for their
 * direction:
 *
 *   signRequest  — ours going out. A canonical string of method, path and a
 *                  hash of the body, signed with our API secret, sent as
 *                  X-MIP-Signature plus X-MIP-Timestamp.
 *
 *   verifyDelivery — theirs coming in. A header shaped "t=<unix>,v1=<hex>"
 *                  where the hex signs "{t}." + the RAW body with the
 *                  endpoint's own secret, which is a different secret again.
 *
 * Everything here is read-only against their API. Nothing in this file creates
 * or changes anything in MoveitPro.
 */
import crypto from "node:crypto";

const BASE = (process.env.MOVEITPRO_BASE || "https://api.moveitpro.com").replace(/\/+$/, "");

export const apiKey = () => (process.env.MOVEITPRO_API_KEY || "").trim() || null;
const apiSecret = () => (process.env.MOVEITPRO_HMAC_SECRET || "").trim() || null;

/** Can we talk to MoveitPro at all. */
export const configured = () => Boolean(apiKey() && apiSecret());

export function status() {
  if (!apiKey()) return "no MOVEITPRO_API_KEY";
  if (!apiSecret()) return "no MOVEITPRO_HMAC_SECRET";
  return null;
}

/* ---------------------------------------------------------- outbound ----- */

/**
 * GET something from MoveitPro.
 *
 * Only GET. A write would need an Idempotency-Key and a lot more care than a
 * Discord relay has any business taking, so the door is simply not here.
 */
export async function get(pathWithQuery, { fetchImpl = globalThis.fetch } = {}) {
  if (!configured()) throw new Error(status());
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyHash = crypto.createHash("sha256").update("").digest("hex");
  const canonical = ["v1", ts, "GET", pathWithQuery, bodyHash].join(":");
  const sig = crypto.createHmac("sha256", apiSecret()).update(canonical).digest("hex");

  const res = await fetchImpl(BASE + pathWithQuery, {
    headers: {
      authorization: `Bearer ${apiKey()}`,
      "x-mip-timestamp": ts,
      "x-mip-signature": sig,
      accept: "application/json"
    }
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave it */ }
  if (!res.ok) {
    const raw = json?.error ?? json?.message ?? text.slice(0, 300) ?? res.statusText;
    const err = new Error(`MoveitPro GET ${pathWithQuery} → ${res.status}: ` +
      (typeof raw === "string" ? raw : JSON.stringify(raw)));
    err.status = res.status;
    throw err;
  }
  return json?.data ?? json;
}

export const getJob = (id, o) => get(`/v1/jobs/${encodeURIComponent(id)}`, o);
export const getEstimate = (id, o) => get(`/v1/estimates/${encodeURIComponent(id)}`, o);
export const getPayment = (id, o) => get(`/v1/payments/${encodeURIComponent(id)}`, o);
export const getCustomer = (id, o) => get(`/v1/customers/${encodeURIComponent(id)}`, o);

/* ----------------------------------------------------------- inbound ----- */

export const MAX_SKEW_SECONDS = 300;

/**
 * Is this delivery really from MoveitPro, and recent.
 *
 * Takes the raw body as a string or Buffer — not a parsed object. Re-serialising
 * JSON does not reproduce the bytes that were signed, so the route that
 * receives this must keep the body raw, which is why it is mounted ahead of
 * the JSON parser.
 *
 * Returns { ok: true, event } or { ok: false, why }. It never throws on bad
 * input, because every one of these is somebody else's request and a thrown
 * error is a 500 where a 400 belongs.
 */
export function verifyDelivery(rawBody, headerValue, secret, { now = Date.now() } = {}) {
  if (!secret) return { ok: false, why: "no signing secret configured" };
  if (!rawBody || !rawBody.length) return { ok: false, why: "empty body" };
  if (!headerValue) return { ok: false, why: "no X-MIP-Signature header" };

  const parts = Object.fromEntries(String(headerValue).split(",")
    .map(p => p.trim().split("=", 2))
    .filter(p => p.length === 2));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return { ok: false, why: "signature header is malformed" };

  /* Checked before the compare: a replay of a genuinely signed delivery from
     last week is still something to refuse. */
  const skew = Math.abs(Math.floor(now / 1000) - t);
  if (skew > MAX_SKEW_SECONDS) return { ok: false, why: `signature is ${skew}s old` };

  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const expected = crypto.createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${t}.`, "utf8"), raw])).digest("hex");

  /* Constant time, and only once both are the same length — timingSafeEqual
     throws on a mismatch, which would itself leak the length. */
  const a = Buffer.from(expected, "utf8"), b = Buffer.from(String(v1), "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, why: "signature does not match" };
  }

  let event = null;
  try { event = JSON.parse(raw.toString("utf8")); }
  catch { return { ok: false, why: "body is not JSON" }; }
  if (!event?.id) return { ok: false, why: "event has no id to deduplicate on" };

  return { ok: true, event };
}
