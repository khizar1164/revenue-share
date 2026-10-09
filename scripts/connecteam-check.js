/* The Connecteam side, without Connecteam.
 *
 * Nothing here touches the network or the database. The things worth being
 * sure of are the ones that would be embarrassing to get wrong in front of
 * Matthew: that the integration refuses to write while it is switched off,
 * that the request it would send is the request Connecteam documents, and that
 * the task says something a person can act on.
 *
 * The fake fetch is the point. Running this against the real API would need a
 * key, a plan tier Andrew may not have, and a willingness to create live tasks
 * in somebody's workspace to find out whether the code works.
 */
import {
  taskText, createTask, writingEnabled, taskLevels, status
} from "../src/connecteam.js";
import { levelFor } from "../src/sync/discipline.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

/* Each test sets the environment it needs and puts it back. */
function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

console.log("1. IT WILL NOT WRITE UNTIL IT IS TOLD IT MAY");
await withEnv({ CONNECTEAM_API_KEY: "test-key", CONNECTEAM_TASKS: undefined }, async () => {
  check("switched off by default", writingEnabled() === false);
  check("and says why", /nobody has said to start/.test(status() ?? ""), status() ?? "(none)");
  let threw = null;
  await createTask({ boardId: "b1", userIds: [1], title: "x" }).catch(e => { threw = e.message; });
  check("createTask refuses rather than pretending", /not 'on'/.test(threw ?? ""), threw ?? "it did not throw");
});
await withEnv({ CONNECTEAM_API_KEY: undefined, CONNECTEAM_TASKS: "on" }, () => {
  check("a key alone is not permission, and permission alone is not a key",
    /no Connecteam API key/.test(status() ?? ""), status() ?? "(none)");
});

console.log("\n2. THE REQUEST IS THE ONE CONNECTEAM DOCUMENTS");
await withEnv({ CONNECTEAM_API_KEY: "test-key", CONNECTEAM_TASKS: "on" }, async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 200, statusText: "OK",
             text: async () => JSON.stringify({ data: { task: { id: 991 } } }) };
  };
  const task = await createTask({
    boardId: "board-7", userIds: [4242], title: "Written warning — A Mover",
    description: "<p>because</p>", labelIds: ["lab-hr"],
    dueDate: "2026-10-15T00:00:00Z"
  }, { fetchImpl });

  check("posts to the board's tasks collection",
    seen.url.endsWith("/tasks/v1/taskboards/board-7/tasks"), seen.url);
  check("as a POST", seen.init.method === "POST");
  check("with the key in X-API-KEY, unprefixed", seen.init.headers["X-API-KEY"] === "test-key");
  check("userIds is an array of ids", Array.isArray(seen.body.userIds) && seen.body.userIds[0] === 4242);
  check("status is published, so somebody actually sees it", seen.body.status === "published");
  check("dueDate is whole seconds, not milliseconds",
    seen.body.dueDate === 1792022400, String(seen.body.dueDate));
  check("and the new task's id comes back", String(task.id) === "991");

  /* Reading a task gives description as a list of typed blocks; writing one
     wants an object with a content string. Sending either a bare string or the
     shape that was read back is rejected. */
  check("the body is an object, not a string",
    seen.body.description && !Array.isArray(seen.body.description),
    JSON.stringify(seen.body.description));
  check("with the html under content", seen.body.description.content === "<p>because</p>");
  check("labelIds go through", seen.body.labelIds?.[0] === "lab-hr");
  check("and it is a one-off, not a recurring task", seen.body.type === "oneTime");
  /* A dueDate alone is rejected: their validator compares it to startTime and
     cannot handle startTime being absent. */
  check("a due date brings a start time with it",
    seen.body.startTime === seen.body.dueDate, JSON.stringify(seen.body.startTime));
});

console.log("\n3. A FAILURE SAYS WHAT CONNECTEAM SAID");
await withEnv({ CONNECTEAM_API_KEY: "test-key", CONNECTEAM_TASKS: "on" }, async () => {
  const fetchImpl = async () => ({
    ok: false, status: 403, statusText: "Forbidden",
    text: async () => JSON.stringify({ message: "quick_tasks.write scope required" })
  });
  let threw = null;
  await createTask({ boardId: "b", userIds: [1], title: "x" }, { fetchImpl })
    .catch(e => { threw = e.message; });
  check("the reason survives", /quick_tasks\.write scope required/.test(threw ?? ""), threw ?? "no error");
  check("and so does the status", /403/.test(threw ?? ""));
});

console.log("\n4. THE THRESHOLDS");
check("14 is nothing yet", levelFor(14) === null);
check("15 is a written warning", levelFor(15) === "warning");
check("29 is still a warning", levelFor(29) === "warning");
check("30 is a suspension", levelFor(30) === "suspension");
check("45 is termination", levelFor(45) === "termination");
check("and so is 60", levelFor(60) === "termination");

console.log("\n5. ALL THREE LEVELS RAISE A TASK UNLESS TOLD OTHERWISE");
withEnv({ CONNECTEAM_TASK_LEVELS: undefined }, () => {
  const l = taskLevels();
  check("warning", l.has("warning"));
  check("suspension", l.has("suspension"));
  check("termination", l.has("termination"));
});
withEnv({ CONNECTEAM_TASK_LEVELS: "warning" }, () => {
  const l = taskLevels();
  check("and Andrew can narrow it to one", l.has("warning") && !l.has("suspension"));
});

console.log("\n6. THE TASK READS LIKE SOMETHING TO DO");
const t = taskText({
  name: "Jayson Murphy", level: "warning", lost: 15,
  windowFrom: "2026-08-07", windowTo: "2026-10-06",
  incidents: [
    { date: "Oct 06, 2026", delta: -10, reason: "No call no show (tardy log)" },
    { date: "Sep 23, 2026", delta: -2, reason: "Call off — time off not requested in advance" },
    { date: "Sep 18, 2026", delta: -1, reason: "Late — 23 min (tardy log)" }
  ]
});
check("the title names the person and the action",
  t.title === "Written warning — Jayson Murphy", t.title);
check("the body gives the number", /lost <b>15 points<\/b>/.test(t.description));
check("and the window it was lost in", /2026-08-07 to 2026-10-06/.test(t.description));
check("worst incident first", t.description.indexOf("No call no show") < t.description.indexOf("Late — 23 min"));
check("it does not announce a decision",
  !/is suspended|is terminated|has been fired/i.test(t.description));
check("it says where the write-up comes from", /write-up generates/.test(t.description));
check("the body is html", /^<p>/.test(t.description));

/* Reasons come off a sheet somebody types into. */
const nasty = taskText({ name: "A Mover", level: "warning", lost: 15,
  windowFrom: "2026-08-07", windowTo: "2026-10-06",
  incidents: [{ date: "Oct 01, 2026", delta: -1, reason: "Late <b>& rude" }] });
check("a typed reason cannot inject markup",
  nasty.description.includes("Late &lt;b&gt;&amp; rude"));

const sus = taskText({ name: "A Mover", level: "suspension", lost: 31,
  windowFrom: "2026-08-07", windowTo: "2026-10-06", incidents: [] });
check("a suspension says it is seven days unpaid", /7 days unpaid/.test(sus.title), sus.title);
check("and names the 30-point threshold", /30-point threshold/.test(sus.description));

console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
process.exit(failures ? 1 : 0);
