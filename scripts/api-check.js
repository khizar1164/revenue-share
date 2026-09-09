/* Start the server, hit every endpoint, and check the TV leaks nothing.
   The leak test is the important one: the board has no login, so if a real
   name or the revenue figure appears in that payload, the protection is gone. */
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { query, close } from "../src/db.js";

const PORT = 3941;
const TOKEN = "test-token-abc123";
const BASE = `http://localhost:${PORT}`;

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const server = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), TV_TOKEN: TOKEN },
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", () => {});
server.stderr.on("data", d => process.stderr.write("  [server] " + d));

async function get(path) {
  const r = await fetch(BASE + path);
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}

try {
  /* wait for it to come up */
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + "/healthz"); if (r.ok) break; } catch {}
    await wait(250);
  }

  console.log("\n1. HEALTH");
  {
    const r = await get("/healthz");
    check("database reachable through the app", r.status === 200 && r.body?.ok === true);
  }

  console.log("\n2. THE TV BOARD");
  const board = await get(`/api/board/${TOKEN}?month=2026-08`);
  {
    check("responds", board.status === 200);
    check("shows the pool", board.body?.pool > 0, "$" + board.body?.pool);
    check("shows a job count", board.body?.completed_jobs === 103, String(board.body?.completed_jobs));
    check("lists the crew", board.body?.crew?.length === 12, `${board.body?.crew?.length} rows`);
    check("uses code names", board.body?.crew?.every(c => /^[A-Z]+$/.test(c.code_name)));
  }

  console.log("\n3. THE TV LEAKS NOTHING  (no login protects this page)");
  {
    const raw = JSON.stringify(board.body);
    const names = (await query(`select full_name from employees`)).rows.map(r => r.full_name);

    check("no revenue figure anywhere in the payload",
      !/201389|201,389/.test(raw) && board.body?.revenue === undefined);
    check("no 'revenue' or 'commission' key", !/"(revenue|commission)"/.test(raw));

    const leaked = names.filter(n => raw.includes(n) || n.split(" ").some(p => p.length > 4 && raw.includes(p)));
    check("no real names", leaked.length === 0, leaked.length ? "LEAKED: " + leaked.join(", ") : `checked ${names.length}`);

    check("no bonuses or deductions", !/"(bonuses|deductions|take_home)"/.test(raw));
    check("no email addresses", !/@/.test(raw));
    check("no employee ids", !/"(employee_id|id)"\s*:/.test(raw));
  }

  console.log("\n4. THE TOKEN ACTUALLY GUARDS IT");
  {
    check("wrong token is a 404", (await get("/api/board/wrong-token")).status === 404);
    check("empty token is not a way in", (await get("/api/board/")).status === 404);
    check("page route is guarded too", (await get("/tv/nope")).status === 404);
  }

  console.log("\n5. JOB NUMBER LOOKUP");
  {
    const known = (await query(
      `select j.job_number from sm_jobs j join sm_job_crew jc on jc.job_id = j.job_id
        group by j.job_number having count(*) >= 3 limit 1`)).rows[0]?.job_number;
    const r = await get(`/api/admin/job/${known}`);
    check("a known job returns its crew", r.body?.found === true && r.body?.crew?.length >= 3,
      `${known} → ${r.body?.crew?.length} movers`);
    check("crew carries real names for admin", r.body?.crew?.every(c => c.full_name?.length > 2));

    const miss = await get("/api/admin/job/99999-9");
    check("an unknown job says so rather than erroring",
      miss.status === 200 && miss.body?.found === false, miss.body?.note);
  }

  console.log("\n6. ADMIN");
  {
    const s = await get("/api/admin/summary?month=2026-08");
    check("summary includes the revenue admin is allowed to see", s.body?.revenue > 0, "$" + s.body?.revenue);
    const roster = await get("/api/admin/roster");
    check("roster returns the twelve movers", roster.body?.length === 12);
    const reviews = await get("/api/admin/reviews?month=2026-08");
    check("reviews endpoint responds", reviews.status === 200, `${reviews.body?.length} logged`);
  }

  console.log("\n7. WRITING A REVIEW END TO END");
  {
    const known = (await query(
      `select j.job_number from sm_jobs j join sm_job_crew jc on jc.job_id = j.job_id
        group by j.job_number having count(*) >= 3 limit 1`)).rows[0].job_number;
    const lookup = await get(`/api/admin/job/${known}`);
    const crew = lookup.body.crew.map(c => c.id);

    const codes = lookup.body.crew.map(c => c.code_name);
    const ptsOf = board => codes.map(c => board.crew.find(x => x.code_name === c).review_points);

    const before = (await get(`/api/board/${TOKEN}?month=2026-08`)).body;
    const beforePts = ptsOf(before);

    const post = await fetch(BASE + "/api/admin/reviews", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ occurred_on: "2026-08-15", job_number: known,
        customer_name: "API Check", source: "LP Google", has_photo: true, crew })
    });
    const created = await post.json();
    check("review saved", post.status === 201 && created.points === 3,
      `${created.credited} movers credited, ${created.points} points each`);

    const after = (await get(`/api/board/${TOKEN}?month=2026-08`)).body;
    const afterPts = ptsOf(after);
    check("every mover on that job gained 3 points",
      afterPts.every((v, i) => v === beforePts[i] + 3),
      `${codes.join(",")}: ${beforePts.join("/")} → ${afterPts.join("/")}`);

    /* the payable denominator stays zero while nobody clears the hours gate —
       correct, and worth stating rather than discovering later */
    check("the payable pool stays empty while nobody has hours",
      after.totals.reviews === 0 && after.counts.qualified === 0);

    await fetch(BASE + `/api/admin/reviews/${created.id}`, { method: "DELETE" });
    const cleaned = ptsOf((await get(`/api/board/${TOKEN}?month=2026-08`)).body);
    check("removing it puts the board back", cleaned.every((v, i) => v === beforePts[i]));
  }

  console.log("\n" + "=".repeat(56));
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
  console.log("=".repeat(56));
} finally {
  server.kill();
  await close();
}
process.exit(failures ? 1 : 0);
