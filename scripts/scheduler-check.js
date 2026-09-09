/* The scheduler's behaviour, tested without waiting hours for it.
   The timezone maths gets its own section: La Porte is Central, the server
   runs UTC, and "runs an hour late for half the year" is exactly the kind of
   bug nobody notices until a payout looks wrong. */
import { createScheduler, msUntilDaily, TZ } from "../src/scheduler.js";
import { close } from "../src/db.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* what wall-clock time is it in the zone, at a given instant */
const wallClock = (ms, timeZone = TZ) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false
  }).format(new Date(ms));

console.log(`\n1. DAILY TIMES LAND IN THE RIGHT ZONE  (${TZ})`);
{
  /* mid-winter and mid-summer, either side of a DST change */
  const winter = Date.UTC(2027, 0, 15, 12, 0, 0);
  const summer = Date.UTC(2027, 6, 15, 12, 0, 0);

  for (const [label, now] of [["January", winter], ["July", summer]]) {
    for (const at of ["02:15", "06:00"]) {
      const fires = now + msUntilDaily(at, now);
      check(`${label}: ${at} fires at ${at} local`, wallClock(fires) === at,
        `fires ${wallClock(fires)} local / ${new Date(fires).toISOString().slice(11,16)} UTC`);
    }
  }

  check("a time later today is under 24h away",
    msUntilDaily("23:59", Date.UTC(2027, 0, 15, 0, 0, 0)) < 24 * 3600e3);
  check("a time already past rolls to tomorrow",
    msUntilDaily("00:01", Date.UTC(2027, 0, 15, 23, 0, 0)) > 0);
  check("never schedules in the past",
    [..."0123456789"].every((_, h) => msUntilDaily(`0${h}:00`, Date.now()) > 0));
}

console.log("\n2. A JOB THAT THROWS DOES NOT TAKE ANYTHING WITH IT");
{
  const s = createScheduler({ log: () => {} });
  let goodRuns = 0;
  s.add("explodes", async () => { throw new Error("deliberate"); }, { everyMs: 60_000 });
  s.add("fine", async () => { goodRuns++; return "ok"; }, { everyMs: 60_000 });

  await s.run("explodes").catch(() => check("run() did not reject", false));
  await s.run("fine");

  const st = s.status();
  const bad = st.find(j => j.name === "explodes");
  check("the failure is caught, not thrown", true);
  check("it is recorded against the job", bad.last_error === "deliberate", bad.last_error);
  check("the failure is counted", bad.consecutive_failures === 1);
  check("the other job still ran", goodRuns === 1);
  check("the healthy job has no error", st.find(j => j.name === "fine").last_error === null);
  s.stop();
}

console.log("\n3. A JOB NEVER OVERLAPS ITSELF");
{
  const s = createScheduler({ log: () => {} });
  let started = 0, release;
  const held = new Promise(r => { release = r; });
  /* hold the job open rather than sleeping a guessed number of milliseconds —
     every run writes to sync_runs on Render first, and that round trip is
     longer than any sleep worth putting in a test */
  s.add("slow", async () => { started++; await held; return "done"; }, { everyMs: 60_000 });

  const first = s.run("slow");
  while (started === 0) await sleep(20);     // wait for it to genuinely be inside fn

  const second = await s.run("slow");        // refused while the first is in flight
  check("a second start is refused while the first is in flight", second === null);
  check("only one copy actually began", started === 1, `${started} started`);

  release();
  check("the held run returns its result", (await first) === "done");

  release = null;
  const third = await s.run("slow");
  check("it runs again once the first has finished", third === "done");
  check("both completed runs counted", started === 2);
  s.stop();
}

console.log("\n4. STATUS REPORTS WHAT HAPPENED");
{
  const s = createScheduler({ log: () => {} });
  s.add("worker", async () => ({ jobs: 113, calls: 20 }), { everyMs: 4 * 3600e3 });
  s.add("nightly", async () => "wrote the sheet", { dailyAt: "02:15" });

  await s.run("worker");
  const st = s.status();
  const w = st.find(j => j.name === "worker");
  const n = st.find(j => j.name === "nightly");

  check("interval jobs describe their cadence", /every 240 min/.test(w.schedule), w.schedule);
  check("daily jobs name the zone", n.schedule.includes(TZ), n.schedule);
  check("a successful run is timestamped", w.last_ok instanceof Date);
  check("the result is kept for the panel", /113/.test(w.last_detail), w.last_detail);
  check("the next run is known before it happens", n.next_run instanceof Date,
    n.next_run?.toISOString().slice(0, 16).replace("T", " ") + "Z");
  check("a job that has not run yet says so", n.last_ok === null);
  s.stop();
}

console.log("\n5. STOPPING ACTUALLY STOPS IT");
{
  const s = createScheduler({ log: () => {} });
  let ran = 0;
  /* long enough that a run completes between ticks — each one writes a
     sync_runs row to Render, which is not instant */
  s.add("ticker", async () => { ran++; }, { everyMs: 900 });

  while (ran === 0) await sleep(50);         // let it tick at least once
  const during = ran;
  s.stop();
  await sleep(1500);                          // two intervals' worth of quiet

  check("it was running before stop", during >= 1, `${during} run(s)`);
  check("no new run starts after stop", ran === during, `${ran} total`);
  check("a manual run still works after stop", (await s.run("ticker")) === undefined && ran === during + 1,
    "stop halts the schedule, not the ability to run by hand");
}

console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
await close();
process.exit(failures ? 1 : 0);
