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

/* Which key carries the move date to MoveitPro.
 *
 * 26 October: the relay read "2026-11-25" off the form, sent it as move_date,
 * and the lead came back with no date anywhere on it. Their API takes a write
 * and drops a field it does not recognise, so a wrong name and a success look
 * identical from here — which is why this went unnoticed through two fixes.
 *
 * Their own records call it service_date. That is the field the relay reads
 * back off every job and prints as "Move Date" in dispatch-updates, so it is
 * the likeliest of these by some distance.
 *
 * A list, and in the environment rather than here, for the same reason
 * MIP_PAYMENT_SURFACES is: the date costs nothing under four keys while three
 * of them are ignored, and whichever one lands can be narrowed to — or the
 * whole thing put back to move_date — without a deploy. */
const moveDateFields = () => (process.env.LEAD_MOVE_DATE_FIELDS ||
  "move_date,service_date,estimated_move_date,requested_move_date")
  .split(",").map(f => f.trim()).filter(Boolean);

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

  /* The move date decides whether the lead reaches a sales rep's follow-up
     list at all, so it is worth more effort than the rest. Meta returns it
     however the form asked for it: the live form asks "What date would you
     like to move (mm dd yyyy)" and answers come back as "8 31 26". An ISO-only
     check threw every one of those away without a word, which is why social
     ads arrived with no date on them. */
  const rawDate = clean(pick(idx, "move_date", "moving_date", "date_of_move",
                              "when_are_you_moving")) ?? moveDateField(idx);
  let moveDate = null;
  if (rawDate) {
    const parsed = parseMoveDate(rawDate);
    if (parsed) {
      moveDate = parsed;
      for (const field of moveDateFields()) body[field] = parsed;
    }
    /* Say so rather than dropping it. A date we cannot read is a form question
       that changed shape, and that is worth seeing in the logs. */
    else warnings.push(`move date not understood: ${rawDate}`);
  } else {
    /* The lead still goes through, because a rep can ask. But a date that was
       never there has to be as visible as a missing phone number: leads were
       reaching MoveitPro undated for a fortnight and nothing anywhere said so. */
    warnings.push("no move date");
  }

  /* moveDate separately from the body, because which key it went out under is
     now configuration and the caller still has to be able to log what it
     sent. */
  return { body, warnings, moveDate };
}

/* Dates the platform stamped rather than the customer answered. Meta puts
   created_time on every lead and Zapier adds timestamps of its own, and all of
   them parse perfectly well — a lead whose date answer came through blank
   arrived carrying the day it was submitted, which sorts the job to the wrong
   end of the board as surely as no date at all. */
const platformDate = k =>
  /creat|submit|receiv|updat|sent|timestamp|birth|expir/.test(k) || k === "dob";

/**
 * The field holding the move date, whatever the form called it.
 *
 * For when the zap is rebuilt and the question text arrives as the key, which
 * is Zapier's own default. A candidate has to read like a date question at all
 * — "where are you moving from" is an address — and one that mentions the move
 * beats a bare Date column.
 *
 * Returns the raw answer whether or not it parses. The version that kept only
 * values it could already parse is why Meta's own date question disappeared
 * without a word: to the caller, unreadable looked exactly like absent.
 */
function moveDateField(idx) {
  let best = null, bestRank = 9;
  for (const [k, v] of idx) {
    if (v == null || String(v).trim() === "" || platformDate(k)) continue;
    if (!/date|when|day/.test(k)) continue;
    const rank = /mov(e|ing)|relocat/.test(k) ? 0 : 1;
    if (rank < bestRank) { best = String(v).trim(); bestRank = rank; }
  }
  return best;
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

/** A real calendar date, close enough to now to be a booking. YYYY-MM-DD. */
function calendarDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  /* Catches 02 31 and friends: the Date rolls them forward, so a round trip
     that does not come back the same is not a real date. */
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;

  /* A move date years in the past is a mistyped year, not a booking. Rejecting
     it here keeps obvious rubbish off the estimate, where it would sort the
     job to the wrong end of the board. */
  const now = Date.now();
  if (date.getTime() < now - 90 * 864e5 || date.getTime() > now + 1095 * 864e5) return null;

  const pad = n => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * "8 31 26", "08/31/2026", "8-31-2026", "2026-08-31", "2026-08-31T00:00:00",
 * "Aug 31 2026" and "8/31" all mean the same day. Month first on the numeric
 * forms, because that is how the Meta form asks and how the US writes it.
 *
 * Returns YYYY-MM-DD, or null when it is not a real calendar date.
 */
export function parseMoveDate(value) {
  let s = String(value ?? "").trim().toLowerCase();
  if (!s) return null;

  /* The time comes off before anything else looks at the string. Meta's own
     date question type answers with a full timestamp — "2026-11-15T00:00:00" —
     and Zapier reformats dates as "11/15/2026 12:00 AM". Both are a day
     somebody picked with midnight stapled on, and both were refused outright. */
  s = s.replace(/[t\s]+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm)?\s*(z|[+-]\d{2}:?\d{2})?$/, "")
       .replace(/[.,\s]+$/, "")
       .trim();
  if (!s) return null;

  /* One or more separators, not exactly one. The live zap sends "10/ 25/2026",
     a slash and a space together, because the form answer carries the spacing
     the customer typed. A single-character separator refused it. */
  const SEP = "[-/.,\\s]+", ORD = "(?:st|nd|rd|th)?";
  const iso = s.match(new RegExp(`^(\\d{4})${SEP}(\\d{1,2})${SEP}(\\d{1,2})$`));
  const us = s.match(new RegExp(`^(\\d{1,2})${SEP}(\\d{1,2})${SEP}(\\d{2}|\\d{4})$`));
  /* A month in words, for the form answered by somebody who ignored the
     (mm dd yyyy), and a bare month and day for the one answered "8/31". */
  const named = s.match(new RegExp(`^([a-z]{3,9})\\.?${SEP}(\\d{1,2})${ORD}(?:${SEP}(\\d{2}|\\d{4}))?$`));
  const dayFirst = s.match(new RegExp(`^(\\d{1,2})${ORD}${SEP}([a-z]{3,9})\\.?(?:${SEP}(\\d{2}|\\d{4}))?$`));
  const noYear = s.match(new RegExp(`^(\\d{1,2})${SEP}(\\d{1,2})$`));

  let y, m, d;
  if (iso) [, y, m, d] = iso;
  else if (us) [, m, d, y] = us;
  else if (named) { [, , d, y] = named; m = MONTHS[named[1].slice(0, 3)]; }
  else if (dayFirst) { [, d, , y] = dayFirst; m = MONTHS[dayFirst[2].slice(0, 3)]; }
  else if (noYear) [, m, d] = noYear;
  else return null;
  if (!m) return null;  // a word where the month goes, and not a month

  m = Number(m); d = Number(d);
  /* Two digits means this century. Meta has never sent a four-digit year
     from a two-digit question, but it costs nothing to accept both. */
  if (y != null && String(y).length === 2) y = 2000 + Number(y);

  /* No year at all: the next time that day comes round. Someone answering
     "8/31" in October means next August, and the window in calendarDate is
     what decides which of the two years it is. */
  if (y == null) {
    const thisYear = new Date().getUTCFullYear();
    return calendarDate(thisYear, m, d) ?? calendarDate(thisYear + 1, m, d);
  }
  return calendarDate(Number(y), m, d);
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
  const { body, warnings, moveDate } = toLead(payload);
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
    /* Reported back so the caller can log what was actually sent. Whether a
       dateless lead in MoveitPro means we never read the date or they never
       stored it is otherwise unanswerable from this side. */
    moveDate,
    warnings
  };
}
