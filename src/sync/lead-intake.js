/* Leads from Zapier into MoveitPro, signed on the way through.
 *
 * Khizar, 12 October: the Meta Lead Ads zap posted into SmartMoving and has to
 * post into MoveitPro instead. It cannot do that directly. MoveitPro requires
 * every write to carry an HMAC signature over a canonical string, and Zapier's
 * webhook action can send headers but cannot compute one. A Code step could,
 * but it would put the API secret inside Zapier, where nothing is tested and
 * rotating it means editing a zap.
 *
 * So Zapier posts here with a shared key, and this signs and forwards. The
 * MoveitPro credentials stay on the server that already holds them.
 *
 * The mapping is deliberately generous about field names. Meta's lead forms
 * return whatever the form was built with — full_name on one, first_name and
 * last_name on another, phone_number or phone — and the zap that feeds this
 * will be rebuilt by hand more than once. Guessing a few spellings is cheaper
 * than a lead silently arriving with no name.
 */
import crypto from "node:crypto";
import { post } from "../moveitpro.js";

/** Zapier's own shared key. Not MoveitPro's, and not interchangeable with it. */
export const relayKey = () => (process.env.LEAD_RELAY_KEY || "").trim() || null;

/** Constant time, because this is the only thing guarding a write to their CRM. */
export function keyOk(given) {
  const want = relayKey();
  if (!want || !given) return false;
  const a = Buffer.from(String(given), "utf8"), b = Buffer.from(want, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const first = (...vals) => vals.find(v => v != null && String(v).trim() !== "") ?? null;
const clean = v => v == null ? null : String(v).trim();

/** "Jane Q Smith" → ["Jane", "Q Smith"]. One word is a first name. */
export function splitName(full) {
  const parts = String(full ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return [null, null];
  if (parts.length === 1) return [parts[0], null];
  return [parts[0], parts.slice(1).join(" ")];
}

/** A phone MoveitPro will accept, or nothing. It wants seven digits at least. */
export function phoneOf(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length >= 7 ? String(raw).trim().slice(0, 32) : null;
}

/**
 * Whatever Zapier sent, as a MoveitPro lead.
 *
 * Returns { body, warnings }. A lead with no name and no way to contact them
 * is not worth creating, and the caller refuses it rather than putting an
 * empty row in front of the sales team.
 */
export function toLead(payload = {}) {
  const p = payload ?? {};
  const warnings = [];

  let firstName = clean(first(p.first_name, p.firstName, p.given_name));
  let lastName = clean(first(p.last_name, p.lastName, p.family_name, p.surname));
  if (!firstName) {
    const [f, l] = splitName(first(p.full_name, p.fullName, p.name));
    firstName = f; lastName = lastName ?? l;
  }

  const email = clean(first(p.email, p.email_address, p.emailAddress));
  const phone = phoneOf(first(p.phone, p.phone_number, p.phoneNumber, p.mobile));

  if (!email) warnings.push("no email");
  if (!phone) warnings.push("no usable phone");

  const body = {
    ...(firstName ? { first_name: firstName.slice(0, 128) } : {}),
    ...(lastName ? { last_name: lastName.slice(0, 128) } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phones: [{ type: "Mobile", number: phone }] } : {}),
    /* Where the lead came from. Set by the caller's configuration rather than
       by the payload, so a form field can never rewrite our attribution. */
    referred_by: (process.env.LEAD_REFERRED_BY || "z AD - Social Media").slice(0, 128),
    ...(process.env.MOVEITPRO_BRANCH_ID ? { branch_id: process.env.MOVEITPRO_BRANCH_ID } : {})
  };

  const moveDate = clean(first(p.move_date, p.moveDate, p.when_are_you_moving));
  if (moveDate && /^\d{4}-\d{2}-\d{2}$/.test(moveDate)) body.move_date = moveDate;

  return { body, warnings };
}

/**
 * The key Zapier's retries ride on.
 *
 * Built from the lead itself rather than from the moment it arrived, so the
 * same person arriving twice replays the first response instead of creating a
 * second record. Meta's own leadgen id is used when the zap passes one along,
 * because that is the only identifier either side agrees on.
 */
export function idempotencyKeyFor(payload, body) {
  const given = payload?.leadgen_id ?? payload?.lead_id ?? payload?.id;
  if (given) return `meta-${String(given).slice(0, 200)}`;
  const seed = [body.email, body.phones?.[0]?.number, body.first_name, body.last_name].join("|");
  return "meta-" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 40);
}

/** Sign it and send it. Returns something worth logging. */
export async function createLead(payload, opts = {}) {
  const { body, warnings } = toLead(payload);
  if (!body.email && !body.phones) {
    const e = new Error("a lead with neither an email nor a phone is not worth creating");
    e.status = 422;
    throw e;
  }
  const r = await post("/v1/leads", body, {
    idempotencyKey: idempotencyKeyFor(payload, body), ...opts
  });
  return {
    id: r.data?.id ?? null,
    replayed: r.replayed,
    name: [body.first_name, body.last_name].filter(Boolean).join(" ") || "(no name)",
    warnings
  };
}
