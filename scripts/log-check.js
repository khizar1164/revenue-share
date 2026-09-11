/* Taking a mistaken entry back out — Andrew, 11 September:
   "I need to be able to remove a point log that was entered in case of a
   mistake. Similar to how the reviews is in admin account."
   Claims got the same, since a wrong claim moves the whole pool.

   Runs against the real database, so it works in July 2026 — before the
   programme, with nothing in it — and removes whatever it adds. Its point
   entries are positive so they can never register as discipline. */
import { spawn } from "node:child_process";
import { query, close, loadEnv } from "../src/db.js";

loadEnv();
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const PORT = 3989, PW = "log-check-pw", B = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), RUN_SCHEDULER: "off", ADMIN_PASSWORD: PW,
         PUBLIC_URL: "", NODE_ENV: "development" },
  stdio: ["ignore", "pipe", "pipe"]
});
let out = "";
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("server did not start\n" + out)), 20000);
  const seen = d => { out += d; if (/listening on/.test(out)) { clearTimeout(t); res(); } };
  srv.stdout.on("data", seen); srv.stderr.on("data", seen);
});

const login = await fetch(`${B}/api/admin/login`, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PW }) });
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const call = (path, opts = {}) => fetch(B + path, { ...opts,
  headers: { "content-type": "application/json", cookie, ...(opts.headers || {}) } });

const made = { points: [], claims: [] };
try {
  const who = (await (await call("/api/admin/roster")).json())[0];

  console.log("\n1. POINT LOG");
  const add = await call("/api/admin/points", { method: "POST", body: JSON.stringify({
    employee_id: who.id, occurred_on: "2026-07-15", delta: 1, reason: "log-check entry" }) });
  const pid = (await add.json()).id; made.points.push(pid);
  check("an entry can be added", add.status === 201);

  const list = await (await call("/api/admin/points?month=2026-07")).json();
  const row = list.find(r => String(r.id) === String(pid));
  check("it appears in the month's log", !!row);
  check("with a name and a plain date", row && row.full_name === who.full_name && row.occurred_on === "2026-07-15",
    row && `${row.full_name}, ${row.occurred_on}`);
  check("other months don't show it",
    !(await (await call("/api/admin/points?month=2026-08")).json()).some(r => String(r.id) === String(pid)));

  check("removing it needs admin", (await fetch(`${B}/api/admin/points/${pid}`, { method: "DELETE" })).status === 401);
  const del = await call(`/api/admin/points/${pid}`, { method: "DELETE" });
  check("a signed-in admin can remove it", del.status === 204);
  check("…and it is really gone",
    !(await query(`select 1 from point_events where id = $1`, [pid])).rowCount);
  made.points = [];
  check("removing it twice says so", (await call(`/api/admin/points/${pid}`, { method: "DELETE" })).status === 404);
  check("a junk id is refused", (await call(`/api/admin/points/1;drop`, { method: "DELETE" })).status === 400);

  const sys = (await query(`select id from point_events where recorded_by = 'system' limit 1`)).rows[0];
  if (sys) {
    const r = await call(`/api/admin/points/${sys.id}`, { method: "DELETE" });
    const b = await r.json();
    check("same-day points are not removable — they'd come straight back", r.status === 409, b.error?.slice(0, 60));
    check("…and are left in place", (await query(`select 1 from point_events where id = $1`, [sys.id])).rowCount === 1);
  }

  console.log("\n2. CLAIMS");
  const c = await call("/api/admin/claims", { method: "POST", body: JSON.stringify({
    occurred_on: "2026-07-15", reason: "log-check claim", amount: 1000 }) });
  const cid = (await c.json()).id; made.claims.push(cid);
  check("a claim can be added", c.status === 201);
  const cl = await (await call("/api/admin/claims?month=2026-07")).json();
  check("it appears in the month's claims", cl.some(r => String(r.id) === String(cid) && r.amount === 1000));
  check("removing it needs admin", (await fetch(`${B}/api/admin/claims/${cid}`, { method: "DELETE" })).status === 401);
  check("a signed-in admin can remove it", (await call(`/api/admin/claims/${cid}`, { method: "DELETE" })).status === 204);
  made.claims = [];
  check("…and it is really gone", !(await query(`select 1 from claims where id = $1`, [cid])).rowCount);

  console.log("\n3. THE PAGE");
  const page = await (await fetch(`${B}/admin`)).text();
  check("has the point log and claims tables", /id="ptTbl"/.test(page) && /id="clTbl"/.test(page));
  check("month is a picker, not a bare month input", /id="monthBtn"/.test(page) && !/type="month"/.test(page));
  check("date boxes open their calendar on click", /showPicker/.test(page));
  check("calendar icons are drawn for a dark page", /color-scheme:\s*dark/.test(page));
  check("claims default to $1,000", /id="clAmt"[^>]*value="1000"/.test(page));
} finally {
  for (const id of made.points) await query(`delete from point_events where id = $1`, [id]);
  for (const id of made.claims) await query(`delete from claims where id = $1`, [id]);
  srv.kill();
  await close();
}

console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
process.exit(failures ? 1 : 0);
