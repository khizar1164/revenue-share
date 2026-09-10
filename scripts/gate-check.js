/* The admin gate and the public-mode defaults, proved the way production runs:
   served as https, with and without ADMIN_PASSWORD. The first deploy had every
   one of these doors open; this file exists so that cannot quietly happen again. */
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

let nextPort = 3910;
async function withServer(env, fn) {
  const port = nextPort++;
  const p = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, ...env, PORT: String(port), RUN_SCHEDULER: "off" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  /* wait for the server to say it is listening, rather than guessing a delay */
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start:\n" + out)), 20000);
    const seen = d => { out += d; if (/listening on/.test(out)) { clearTimeout(t); resolve(); } };
    p.stdout.on("data", seen);
    p.stderr.on("data", seen);
    p.on("exit", c => { clearTimeout(t); reject(new Error(`server exited (${c}):\n${out}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  try { await fn(base); }
  finally { p.removeAllListeners("exit"); p.kill(); await wait(150); }
}

const status = async (url, opts) => (await fetch(url, opts)).status;
const PUBLIC = { PUBLIC_URL: "https://share.immediatemover.com", TV_TOKEN: "tv-test-token" };

console.log("\n1. PUBLIC, NO ADMIN_PASSWORD — EVERYTHING LOCKED");
await withServer({ ...PUBLIC, ADMIN_PASSWORD: "", ALLOW_REPORT_PREVIEW: "" }, async b => {
  check("admin summary is locked", await status(b + "/api/admin/summary") === 503);
  check("admin roster is locked", await status(b + "/api/admin/roster") === 503);
  check("admin writes are locked", await status(b + "/api/admin/claims",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }) === 503);
  check("the scheduler cannot be kicked", await status(b + "/api/admin/jobs/hours/run", { method: "POST" }) === 503);
  check("login refuses rather than admitting", await status(b + "/api/admin/login",
    { method: "POST", headers: { "content-type": "application/json" }, body: '{"password":""}' }) === 503);
  check("report preview is off by default", await status(b + "/api/me-preview") === 404);
  check("reading a report by id needs a session", await status(b + "/api/me/00000000-0000-0000-0000-000000000000") === 401);
  check("the TV still works with its token", await status(b + "/api/board/tv-test-token") === 200);
  check("…and not without it", await status(b + "/api/board/wrong") === 404);
});

console.log("\n2. PUBLIC, NO TV_TOKEN — NO FALLBACK BOARD");
await withServer({ PUBLIC_URL: "https://x.example", TV_TOKEN: "", ADMIN_PASSWORD: "x" }, async b => {
  check("the old dev token does not work in public", await status(b + "/api/board/dev-only-token") === 404);
});

console.log("\n3. PUBLIC, WITH ADMIN_PASSWORD");
const PW = "correct horse battery staple";
await withServer({ ...PUBLIC, ADMIN_PASSWORD: PW }, async b => {
  check("unsigned-in admin gets 401", await status(b + "/api/admin/summary") === 401);

  const wrong = await fetch(b + "/api/admin/login", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "guess" }) });
  check("a wrong password is refused", wrong.status === 401);
  check("…and sets no cookie", !wrong.headers.get("set-cookie"));

  const right = await fetch(b + "/api/admin/login", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PW }) });
  const cookie = (right.headers.get("set-cookie") || "").split(";")[0];
  check("the right password signs in", right.status === 200 && cookie.startsWith("rs_admin="));
  const flags = right.headers.get("set-cookie") || "";
  check("cookie is HttpOnly, Secure and SameSite=Strict",
    /HttpOnly/.test(flags) && /Secure/.test(flags) && /SameSite=Strict/.test(flags));

  check("signed in, admin works", await status(b + "/api/admin/summary", { headers: { cookie } }) === 200);

  const [exp, sig] = cookie.slice("rs_admin=".length).split(".");
  const forged = `rs_admin=${Number(exp) + 999999}.${sig}`;
  check("a tampered expiry is rejected", await status(b + "/api/admin/summary", { headers: { cookie: forged } }) === 401);
  check("a made-up cookie is rejected",
    await status(b + "/api/admin/summary", { headers: { cookie: "rs_admin=9999999999999.abc" } }) === 401);

  /* Andrew opens any crew member's report from the admin panel. That must
     need the admin cookie — preview stays off for everyone else. */
  check("without admin, no report picker", await status(b + "/api/me-preview") === 404);
  check("…nor with a forged cookie", await status(b + "/api/me-preview", { headers: { cookie: forged } }) === 404);
  const picker = await fetch(b + "/api/me-preview", { headers: { cookie } });
  const crew = picker.ok ? await picker.json() : [];
  check("signed-in admin gets the crew list", picker.status === 200 && crew.length > 0, `${crew.length} people`);
  if (crew[0]) {
    const url = `${b}/api/me/${crew[0].id}?month=2026-08`;
    check("…and can open anyone's report", await status(url, { headers: { cookie } }) === 200);
    check("the same report without admin is refused", await status(url) === 401);
  }
});

console.log("\n4. CHANGING THE PASSWORD SIGNS EVERYONE OUT");
let oldCookie = "";
await withServer({ ...PUBLIC, ADMIN_PASSWORD: "first-password" }, async b => {
  const r = await fetch(b + "/api/admin/login", { method: "POST",
    headers: { "content-type": "application/json" }, body: '{"password":"first-password"}' });
  oldCookie = (r.headers.get("set-cookie") || "").split(";")[0];
});
await withServer({ ...PUBLIC, ADMIN_PASSWORD: "second-password" }, async b => {
  check("an old session dies with the old password",
    await status(b + "/api/admin/summary", { headers: { cookie: oldCookie } }) === 401);
});

console.log("\n5. GUESSING IS THROTTLED");
await withServer({ ...PUBLIC, ADMIN_PASSWORD: "whatever-it-is" }, async b => {
  let last = 0;
  for (let i = 0; i < 10; i++) {
    last = await status(b + "/api/admin/login", { method: "POST",
      headers: { "content-type": "application/json" }, body: '{"password":"nope"}' });
  }
  check("after repeated failures it stops answering", last === 429, `status ${last}`);
});

console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
process.exit(failures ? 1 : 0);
