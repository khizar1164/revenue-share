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

const clean = v => v == null ? null : String(v).trim();

/* Zapier sends whatever the person who built the step called the fields. The
   live zap sends FullName, PhoneNumber and Email; my first guess looked only
   for full_name and phone_number and camelCase, so every field missed and two
   real leads were refused for having no way to contact them.
   
   Guessing spellings was the wrong shape of answer. Both sides are flattened
   to letters and digits only — FullName, full_name, "Full Name" and fullname
   all become fullname — so the mapping stops caring how anyone writes it. */
const flatten = k => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

function indexed(payload) {
  const out = new Map();
  for (const [k, v] of Object.entries(payload ?? {})) {
    const key = flatten(k);
    /* First spelling wins, so an explicit Email is not overwritten by a later
       email_address that happens to be empty. */
    if (!out.has(key) || (out.get(key) == null || String(out.get(key)).trim() === "")) {
      out.set(key, v);
    }
  }
  return out;
}

/** The first of these names that carries anything. */
const pick = (idx, ...names) => {
  for (const n of names) {
    const v = idx.get(flatten(n));
    if (v != null && String(v).trim() !== "") return v;
  }
  return null;
};

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
  const idx = indexed(payload);
  const warnings = [];

  let firstName = clean(pick(idx, "first_name", "given_name"));
  let lastName = clean(pick(idx, "last_name", "family_name", "surname"));
  if (!firstName) {
    const [f, l] = splitName(pick(idx, "full_name", "name"));
    firstName = f; lastName = lastName ?? l;
  }

  const email = clean(pick(idx, "email", "email_address"));
  const phone = phoneOf(pick(idx, "phone", "phone_number", "mobile", "cell"));

  if (!email) warnings.push("no email");
  if (!phone) warnings.push("no usable phone");

  const body = {
    ...(firstName ? { first_name: firstName.slice(0, 128) } : {}),
    ...(lastName ? { last_name: lastName.slice(0, 128) } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phones: [{ type: "Mobile", number: phone }] } : {}),
    /* Where the lead came from. The caller is authenticated with our own
       relay key, so this is configuration rather than user input: if the zap
       states a source, that is a deliberate choice by whoever built it and
       silently ignoring it would be worse than honouring it. Falls back to
       ours when it says nothing. */
    referred_by: (clean(pick(idx, "referral_source", "referred_by", "source")) ||
                  process.env.LEAD_REFERRED_BY || "z AD - Social Media").slice(0, 128),
    ...(process.env.MOVEITPRO_BRANCH_ID ? { branch_id: process.env.MOVEITPRO_BRANCH_ID } : {})
  };

  const moveDate = clean(pick(idx, "move_date", "when_are_you_moving"));
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
  const idx = indexed(payload);
  const given = pick(idx, "leadgen_id", "lead_id", "id");
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
