/* Crew logins: a password, and Face ID / fingerprint (Andrew, 20 Nov 2026).
 *
 * The emailed link still works and is how a mover gets in the first time,
 * and again whenever a password is forgotten. Once in, the set-up page asks
 * for a password and offers Face ID. After that the sign-in screen is one tap.
 *
 * Passwords: scrypt with a random salt, compared in constant time. Five wrong
 * tries lock that login for 15 minutes; the answer never says whether the
 * email or the password was wrong.
 *
 * Face ID: WebAuthn passkeys. The phone keeps the private key behind Face ID
 * or a fingerprint; we keep only the public key and check its signature. The
 * challenge for each attempt is random, single use and expires in 5 minutes.
 */
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from "@simplewebauthn/server";
import { query } from "./db.js";
import { sessionFor, readCookie, startSession, setSessionCookie, STILL_HAS_ACCESS } from "./auth.js";

const scrypt = promisify(_scrypt);
const MAX_TRIES = 5, LOCK_MINUTES = 15, MIN_LENGTH = 8;
const RP_NAME = "Immediate Movers & Storage";
const CHALLENGE_COOKIE = "crew_wa";

async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}
async function checkPassword(pw, stored) {
  const [alg, N, r, p, salt, key] = String(stored || "").split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(key, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p });
  return want.length === got.length && timingSafeEqual(want, got);
}

function cookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function mountCrewLogin(app, wrap, { publicUrl }) {
  const origin = new URL(publicUrl).origin;
  const rpID = new URL(publicUrl).hostname;
  const secure = publicUrl.startsWith("https");
  const me = req => sessionFor(readCookie(req));

  const challengeCookie = (res, id, maxAge) => res.append("Set-Cookie",
    `${CHALLENGE_COOKIE}=${id}; Path=/api/crew; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);

  async function saveChallenge(purpose, challenge, employeeId = null) {
    const id = randomBytes(18).toString("base64url");
    await query(`delete from crew_webauthn_challenges where expires_at < now()`);
    await query(`insert into crew_webauthn_challenges (id, employee_id, challenge, purpose, expires_at)
                 values ($1,$2,$3,$4, now() + interval '5 minutes')`, [id, employeeId, challenge, purpose]);
    return id;
  }
  async function takeChallenge(req, purpose) {
    const id = cookie(req, CHALLENGE_COOKIE);
    if (!id) return null;
    const r = await query(`delete from crew_webauthn_challenges
                            where id = $1 and purpose = $2 and expires_at > now()
                        returning employee_id, challenge`, [id, purpose]);
    return r.rows[0] ?? null;
  }

  async function signIn(res, employeeId, req) {
    const s = await startSession(employeeId, { userAgent: req.headers["user-agent"] });
    setSessionCookie(res, s.token, { secure });
  }

  /* What the set-up page needs to know about the signed-in mover. */
  app.get("/api/crew/login-status", wrap(async (req, res) => {
    const m = await me(req);
    if (!m) return res.status(401).json({ error: "not signed in" });
    const l = (await query(`select password_hash is not null as has_password from crew_logins where employee_id = $1`, [m.id])).rows[0];
    const k = (await query(`select count(*)::int as n from crew_passkeys where employee_id = $1`, [m.id])).rows[0];
    res.json({ name: m.full_name, email: m.email, hasPassword: !!l?.has_password, faceIds: k.n });
  }));

  /* Set or change the password, while signed in (the link got them here). */
  app.post("/api/crew/password", wrap(async (req, res) => {
    const m = await me(req);
    if (!m) return res.status(401).json({ error: "not signed in" });
    const pw = String(req.body?.password ?? "");
    if (pw.length < MIN_LENGTH) return res.status(400).json({ error: `at least ${MIN_LENGTH} characters` });
    if (pw.length > 200) return res.status(400).json({ error: "that is too long" });
    await query(`insert into crew_logins (employee_id, password_hash, password_set_at, failed_count, locked_until)
                 values ($1, $2, now(), 0, null)
                 on conflict (employee_id) do update set password_hash = excluded.password_hash,
                   password_set_at = now(), failed_count = 0, locked_until = null, updated_at = now()`,
      [m.id, await hashPassword(pw)]);
    res.json({ ok: true });
  }));

  /* Email and password. */
  app.post("/api/crew/login", wrap(async (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const pw = String(req.body?.password ?? "");
    const no = () => res.status(401).json({ error: "That email and password don't match. Use \"Email me a link\" if you've forgotten it." });
    if (!email || !pw) return no();
    const e = (await query(`select id from employees where lower(email) = $1 and is_mover and merged_into is null and ${STILL_HAS_ACCESS}`, [email])).rows[0];
    const l = e && (await query(`select password_hash, failed_count, locked_until from crew_logins where employee_id = $1`, [e.id])).rows[0];
    if (!l?.password_hash) { await checkPassword(pw, "scrypt$16384$8$1$AAAA$AAAA").catch(() => {}); return no(); }
    if (l.locked_until && new Date(l.locked_until) > new Date()) {
      return res.status(429).json({ error: `Too many tries. Wait ${LOCK_MINUTES} minutes, or use "Email me a link".` });
    }
    if (!(await checkPassword(pw, l.password_hash))) {
      await query(`update crew_logins set failed_count = failed_count + 1,
                     locked_until = case when failed_count + 1 >= $2 then now() + ($3 || ' minutes')::interval end,
                     updated_at = now() where employee_id = $1`, [e.id, MAX_TRIES, String(LOCK_MINUTES)]);
      return no();
    }
    await query(`update crew_logins set failed_count = 0, locked_until = null, updated_at = now() where employee_id = $1`, [e.id]);
    await signIn(res, e.id, req);
    res.json({ ok: true });
  }));

  /* Face ID set-up, step 1: the phone asks what to make a key for. */
  app.post("/api/crew/faceid/setup-options", wrap(async (req, res) => {
    const m = await me(req);
    if (!m) return res.status(401).json({ error: "not signed in" });
    const existing = (await query(`select credential_id, transports from crew_passkeys where employee_id = $1`, [m.id])).rows;
    const opts = await generateRegistrationOptions({
      rpName: RP_NAME, rpID,
      userName: m.email || m.full_name, userDisplayName: m.full_name,
      userID: Buffer.from(m.id.replace(/-/g, ""), "hex"),
      attestationType: "none",
      excludeCredentials: existing.map(c => ({ id: c.credential_id, transports: c.transports ?? undefined })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" }
    });
    challengeCookie(res, await saveChallenge("register", opts.challenge, m.id), 300);
    res.json(opts);
  }));

  /* Face ID set-up, step 2: keep the public key. */
  app.post("/api/crew/faceid/setup", wrap(async (req, res) => {
    const m = await me(req);
    if (!m) return res.status(401).json({ error: "not signed in" });
    const c = await takeChallenge(req, "register");
    if (!c || c.employee_id !== m.id) return res.status(400).json({ error: "that took too long, try again" });
    let v;
    try {
      v = await verifyRegistrationResponse({ response: req.body, expectedChallenge: c.challenge,
        expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    } catch (e) { return res.status(400).json({ error: "Face ID could not be set up: " + e.message }); }
    if (!v.verified) return res.status(400).json({ error: "Face ID could not be set up" });
    const cred = v.registrationInfo.credential;
    await query(`insert into crew_passkeys (credential_id, employee_id, public_key, counter, transports, device)
                 values ($1,$2,$3,$4,$5,$6) on conflict (credential_id) do nothing`,
      [cred.id, m.id, Buffer.from(cred.publicKey), cred.counter ?? 0, cred.transports ?? null,
       String(req.headers["user-agent"] || "").slice(0, 120)]);
    res.json({ ok: true });
  }));

  /* Face ID sign-in, step 1: a fresh challenge. Any of the phone's saved
     keys for this site may answer it, so no email is needed. */
  app.post("/api/crew/faceid/login-options", wrap(async (_req, res) => {
    const opts = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: [] });
    challengeCookie(res, await saveChallenge("login", opts.challenge), 300);
    res.json(opts);
  }));

  /* Face ID sign-in, step 2: check the signature, start the session. */
  app.post("/api/crew/faceid/login", wrap(async (req, res) => {
    const c = await takeChallenge(req, "login");
    if (!c) return res.status(400).json({ error: "that took too long, try again" });
    const k = (await query(
      `select k.credential_id, k.employee_id, k.public_key, k.counter, k.transports
         from crew_passkeys k join employees e on e.id = k.employee_id
        where k.credential_id = $1 and e.is_mover and e.merged_into is null and ${STILL_HAS_ACCESS.replaceAll("status", "e.status").replaceAll("ended_on", "e.ended_on")}`,
      [String(req.body?.id ?? "")])).rows[0];
    if (!k) return res.status(401).json({ error: "This phone's Face ID isn't set up for your page yet. Sign in another way, then turn it on." });
    let v;
    try {
      v = await verifyAuthenticationResponse({ response: req.body, expectedChallenge: c.challenge,
        expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: k.credential_id, publicKey: new Uint8Array(k.public_key), counter: Number(k.counter),
                      transports: k.transports ?? undefined } });
    } catch (e) { return res.status(401).json({ error: "Face ID didn't match: " + e.message }); }
    if (!v.verified) return res.status(401).json({ error: "Face ID didn't match" });
    await query(`update crew_passkeys set counter = $2, last_used_at = now() where credential_id = $1`,
      [k.credential_id, v.authenticationInfo.newCounter]);
    await signIn(res, k.employee_id, req);
    res.json({ ok: true });
  }));
}
