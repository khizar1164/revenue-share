/* Andrew's four requests (10 September), checked together:
     1. real names with surname initial on the review chips
     2. a YTD pool on the break-room screen — the pool, never revenue
     3. each person's own YTD on their report — theirs and nobody else's
     4. a YTD view in admin
   Plus the YTD rule itself: since the programme started, month by month. */
import { spawn } from "node:child_process";
import { ytd, ytdMonths, PROGRAM_START, computeSplit, RULES } from "../src/calc.js";
import { query, close, loadEnv } from "../src/db.js";

loadEnv();
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

console.log(`\n1. WHAT "YEAR TO DATE" MEANS  (programme start ${PROGRAM_START})`);
{
  const sep = ytdMonths(2026, 9), dec = ytdMonths(2026, 12), mar27 = ytdMonths(2027, 3);
  check("September 2026 is one month", sep.length === 1);
  check("December 2026 is Sep–Dec, not Jan–Dec", dec.length === 4 && dec[0].month === 9,
    dec.map(m => m.month).join(","));
  check("from 2027 it is simply January onward", mar27.length === 3 && mar27[0].month === 1);
  check("before the programme there is no year to date", ytdMonths(2026, 8).length === 0,
    "August 2026 had revenue but no pool");
}

console.log("\n2. YTD IS A SUM OF MONTHS, NOT ONE SPLIT");
{
  /* someone who qualifies in one month and not the next must be paid for
     the first and nothing for the second — a year-long split would blur that */
  const mk = hours => ({
    revenue: { completed_revenue: 100000 }, claims: { total: 0, n: 0 },
    people: [
      { id: "a", code_name: "A", full_name: "A", status: "active", hours,  point_delta: 0, review_points: 5, bonuses: 0, deductions: 0, discipline_lost: 0 },
      { id: "b", code_name: "B", full_name: "B", status: "active", hours: 100, point_delta: 0, review_points: 5, bonuses: 0, deductions: 0, discipline_lost: 0 }
    ]
  });
  const m1 = computeSplit(mk(100)), m2 = computeSplit(mk(40));
  const aYear = m1.rows[0].take_home + m2.rows[0].take_home;
  check("qualifying one month and not the next pays only the first",
    m1.rows[0].paid && !m2.rows[0].paid && aYear === m1.rows[0].take_home,
    `$${m1.rows[0].take_home} + $0 = $${aYear}`);
  check("the other mover takes the whole second month",
    m2.rows[1].take_home === m2.pool, `$${m2.rows[1].take_home} of $${m2.pool}`);
}

console.log("\n3. YTD AGAINST THE LIVE DATABASE");
const y = await ytd(2026, 9);
{
  check("covers September", y.months.length === 1 && y.months[0].period === "2026-09-01");
  check("pool matches the month for a one-month year", Math.abs(y.totals.pool - y.months[0].pool) < 0.01,
    `$${y.totals.pool}`);
  check("every mover has a row", y.rows.length > 0, `${y.rows.length} people`);
  check("take-home adds up", Math.abs(y.rows.reduce((a, r) => a + r.take_home, 0) - y.totals.take_home) < 0.05);
}

/* spin the server up to test the screens */
const PORT = 3988;
const srv = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), RUN_SCHEDULER: "off",
         TV_TOKEN: "ytd-check", ADMIN_PASSWORD: "ytd-check-pw", ALLOW_REPORT_PREVIEW: "on" },
  stdio: ["ignore", "pipe", "pipe"]
});
let out = "";
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("server did not start\n" + out)), 20000);
  const seen = d => { out += d; if (/listening on/.test(out)) { clearTimeout(t); res(); } };
  srv.stdout.on("data", seen); srv.stderr.on("data", seen);
});
const B = `http://127.0.0.1:${PORT}`;

try {
  console.log("\n4. THE BREAK-ROOM SCREEN");
  const board = await (await fetch(`${B}/api/board/ytd-check?month=2026-09`)).json();
  check("carries a YTD pool", board.ytd && board.ytd.pool > 0, `$${board.ytd?.pool}`);
  check("says how many months it covers", board.ytd?.months === 1);
  const raw = JSON.stringify(board);
  check("still no revenue anywhere on the TV — including YTD",
    !/"revenue"/.test(raw) && !/50612|50,612/.test(raw));
  check("no real names", !/Schwark|Trim|Hawkins|Fredenburg/.test(raw));
  const page = await (await fetch(`${B}/tv/ytd-check`)).text();
  check("the screen has a Year to date tile", /Year to date/.test(page) && /id="ytd"/.test(page));

  console.log("\n5. EACH PERSON'S OWN REPORT");
  const roster = await (await fetch(`${B}/api/me-preview`)).json();
  const someone = roster[0];
  const rep = await (await fetch(`${B}/api/me/${someone.id}?month=2026-09`)).json();
  check("has a YTD section", rep.ytd && typeof rep.ytd.take_home === "number", `$${rep.ytd?.take_home}`);
  check("broken down by month", Array.isArray(rep.ytd?.months) && rep.ytd.months.length === 1);
  const repRaw = JSON.stringify(rep);
  const others = roster.filter(r => r.id !== someone.id);
  check("carries nobody else's figures",
    !others.some(o => repRaw.includes(o.full_name) || repRaw.includes(o.id)),
    `checked ${others.length}`);

  console.log("\n6. THE ADMIN YTD VIEW");
  const login = await fetch(`${B}/api/admin/login`, { method: "POST",
    headers: { "content-type": "application/json" }, body: '{"password":"ytd-check-pw"}' });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  check("YTD endpoint is behind the gate", (await fetch(`${B}/api/admin/ytd`)).status === 401);
  const ay = await (await fetch(`${B}/api/admin/ytd?month=2026-09`, { headers: { cookie } })).json();
  check("signed in, it returns the year", ay.totals && ay.rows.length > 0);
  check("admin sees revenue there — it is Andrew's panel", ay.totals.revenue > 0, `$${ay.totals.revenue}`);
  const adminPage = await (await fetch(`${B}/admin`)).text();
  check("the page has the Month / YTD switch", /id="viewYtd"/.test(adminPage) && /Year to date/.test(adminPage));

  console.log("\n7. REVENUE BY HAND");
  const rv = await (await fetch(`${B}/api/admin/revenue?month=2026-09`, { headers: { cookie } })).json();
  check("the current figure is readable", rv.current && rv.current.revenue > 0,
    `$${rv.current?.revenue} (${rv.current?.source})`);
  check("revenue entry is behind the gate", (await fetch(`${B}/api/admin/revenue`, { method: "POST",
    headers: { "content-type": "application/json" }, body: '{"period":"2026-09-01","completed_revenue":1}' })).status === 401);
  const badPeriod = await fetch(`${B}/api/admin/revenue`, { method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: '{"period":"September","completed_revenue":100}' });
  check("a malformed month is refused", badPeriod.status === 400);

  console.log("\n8. NAMES ON THE REVIEW CHIPS");
  /* run the page's own shortNames() against the real roster */
  const fn = adminPage.match(/function shortNames\(list\)\{[\s\S]*?\n  \}/)?.[0];
  check("the helper is on the page", !!fn);
  const shortNames = new Function(fn + "; return shortNames;")();
  const ros = await (await fetch(`${B}/api/admin/roster`, { headers: { cookie } })).json();
  const names = shortNames(ros);
  const labels = ros.map(r => names[r.id]);
  check("every mover gets a label", labels.every(Boolean), `${labels.length}`);
  check("no two movers share a label", new Set(labels).size === labels.length);
  check("labels are first name and surname initial", labels.every(l => /^[A-Z][a-z]+( [A-Z][a-z]*)?$/.test(l)),
    labels.slice(0, 5).join(", "));
  const trim = ros.find(r => /Trim/.test(r.full_name)), pama = ros.find(r => /Pama/.test(r.full_name));
  if (trim && pama) {
    check("the two Joshes stay distinct", names[trim.id] !== names[pama.id],
      `${names[trim.id]} / ${names[pama.id]}`);
  }
  check("no code names on the chips", !labels.some(l => /^[A-Z]{4,}$/.test(l)));
  console.log("\n  chips will read: " + labels.sort().join(" · "));

  console.log("\n" + "=".repeat(58));
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
  console.log("=".repeat(58));
} finally {
  srv.kill();
  await close();
}
process.exit(failures ? 1 : 0);
