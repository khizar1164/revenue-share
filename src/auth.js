/* Sign-in by emailed link.
 *
 * The rules that shape this file:
 *
 *   - Never say whether an email is on the roster. "If that address is on the
 *     roster, a link is on its way" is the answer either way, so the sign-in
 *     page cannot be used to find out who works here.
 *   - Store hashes, never the token. A leaked backup should not let anyone
 *     into a mover's report.
 *   - One use per link. A link forwarded, or sitting in a shared inbox, stops
 *     working the moment it has been used.
 */

import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { query } from "./db.js";

const LINK_MINUTES   = 20;
const SESSION_DAYS   = 30;
const COOKIE         = "rs_session";

const hash = v => createHash("sha256").update(String(v)).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const normEmail = e => String(e ?? "").trim().toLowerCase();

/* --------------------------------------------------------------- links ---- */

/**
 * Issue a sign-in link for an email, if it belongs to anyone.
 *
 * Returns { token, employee } when there is someone to send to, and null when
 * there is not — the caller answers identically either way.
 */
export async function issueLoginToken(email, { ip } = {}) {
  const addr = normEmail(email);
  if (!addr || !addr.includes("@")) return null;

  const r = await query(
    `select id, code_name, full_name, email from employees
      where lower(email) = $1 and status <> 'left' and is_mover`, [addr]);
  if (!r.rowCount) return null;

  const employee = r.rows[0];
  const token = newToken();

  /* Asking again replaces the outstanding link rather than leaving several
     live at once — someone who clicks "send it again" should not widen the
     window they can be signed in through. */
  await query(`delete from login_tokens where employee_id = $1 and used_at is null`,
    [employee.id]);
  await query(
    `insert into login_tokens (token_hash, employee_id, email, expires_at, requested_ip)
     values ($1, $2, $3, now() + ($4 || ' minutes')::interval, $5)`,
    [hash(token), employee.id, addr, String(LINK_MINUTES), ip ?? null]);

  return { token, employee, expiresInMinutes: LINK_MINUTES };
}

/** Spend a link and open a session. Returns null if it is bad, old or used. */
export async function consumeLoginToken(token, { userAgent } = {}) {
  if (!token) return null;

  const r = await query(
    `update login_tokens set used_at = now()
      where token_hash = $1 and used_at is null and expires_at > now()
      returning employee_id`, [hash(token)]);
  if (!r.rowCount) return null;

  return startSession(r.rows[0].employee_id, { userAgent });
}

/* ------------------------------------------------------------ sessions ---- */

export async function startSession(employeeId, { userAgent } = {}) {
  const token = newToken();
  await query(
    `insert into sessions (token_hash, employee_id, expires_at, user_agent)
     values ($1, $2, now() + ($3 || ' days')::interval, $4)`,
    [hash(token), employeeId, String(SESSION_DAYS), (userAgent ?? "").slice(0, 300)]);
  return { token, employeeId, expiresInDays: SESSION_DAYS };
}

export async function sessionFor(token) {
  if (!token) return null;
  const r = await query(
    `update sessions set last_seen_at = now()
      where token_hash = $1 and expires_at > now()
      returning employee_id`, [hash(token)]);
  if (!r.rowCount) return null;

  const e = await query(
    `select id, code_name, full_name, email from employees
      where id = $1 and status <> 'left'`, [r.rows[0].employee_id]);
  return e.rows[0] ?? null;
}

export const endSession = token =>
  token ? query(`delete from sessions where token_hash = $1`, [hash(token)]) : null;

/** Housekeeping — expired rows are of no use to anyone. */
export async function purgeExpired() {
  const a = await query(`delete from sessions where expires_at < now()`);
  const b = await query(
    `delete from login_tokens where expires_at < now() - interval '1 day'`);
  return { sessions: a.rowCount, tokens: b.rowCount };
}

/* --------------------------------------------------------------- admin ---- */

export async function isAdmin(email) {
  const addr = normEmail(email);
  if (!addr) return false;
  const r = await query(`select 1 from admin_users where lower(email) = $1`, [addr]);
  return r.rowCount > 0;
}

/* -------------------------------------------------------------- cookie ---- */

export const COOKIE_NAME = COOKIE;

export function readCookie(req, name = COOKIE) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function setSessionCookie(res, token, { secure = true } = {}) {
  const bits = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",                       // the link arrives from an email client
    `Max-Age=${SESSION_DAYS * 86400}`
  ];
  if (secure) bits.push("Secure");
  res.setHeader("Set-Cookie", bits.join("; "));
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Compare two secrets without leaking their length through timing. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ---------------------------------------------------------- admin gate ---- */
/*
 * The admin panel shows every mover's real name, pay and email, and it can
 * change hours, bonuses and who has forfeited. It was deployed to a public URL
 * with none of this in front of it. This is the fix.
 *
 * FAIL CLOSED. If ADMIN_PASSWORD is not set the admin API refuses everything —
 * it never falls back to open. A missing environment variable must lock the
 * door, not unlock it; that is exactly how the first deploy went wrong.
 *
 * The session is a signed cookie rather than a database row: admins are not
 * employees, so they do not fit the sessions table, and a signature needs no
 * storage. It is keyed on the password, so changing the password signs every
 * admin out at once.
 */

export const ADMIN_COOKIE = "rs_admin";
const ADMIN_HOURS = 12;

export const adminConfigured = () => Boolean(process.env.ADMIN_PASSWORD);

const adminKey = () =>
  createHash("sha256").update("rs-admin:" + (process.env.ADMIN_PASSWORD ?? "")).digest();

const signAdmin = exp =>
  createHmac("sha256", adminKey()).update(String(exp)).digest("base64url");

/* A strong password over HTTPS is not realistically brute-forced, but there
   is no reason to let anyone try thousands of times. */
const failures = new Map();                  // ip -> [timestamps]
const WINDOW = 15 * 60e3, LIMIT = 8;

export function adminLoginAllowed(ip) {
  const now = Date.now();
  const recent = (failures.get(ip) ?? []).filter(t => now - t < WINDOW);
  failures.set(ip, recent);
  return recent.length < LIMIT;
}

export function checkAdminPassword(given, ip) {
  if (!adminConfigured()) return false;
  const ok = safeEqual(given, process.env.ADMIN_PASSWORD);
  if (!ok) failures.set(ip, [...(failures.get(ip) ?? []), Date.now()]);
  else failures.delete(ip);
  return ok;
}

export function setAdminCookie(res, { secure = true } = {}) {
  const exp = Date.now() + ADMIN_HOURS * 3600e3;
  const bits = [
    `${ADMIN_COOKIE}=${exp}.${signAdmin(exp)}`,
    "Path=/", "HttpOnly", "SameSite=Strict",   // admin never arrives from a link
    `Max-Age=${ADMIN_HOURS * 3600}`
  ];
  if (secure) bits.push("Secure");
  res.append("Set-Cookie", bits.join("; "));
}

export function clearAdminCookie(res) {
  res.append("Set-Cookie", `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

export function isAdminRequest(req) {
  if (!adminConfigured()) return false;
  const raw = readCookie(req, ADMIN_COOKIE);
  if (!raw) return false;
  const [exp, sig] = raw.split(".");
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  return safeEqual(sig, signAdmin(exp));
}
