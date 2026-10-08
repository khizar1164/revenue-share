/* Prove the write path, without writing to Matthew.
 *
 *   node scripts/connecteam-task.js                         show what it would send
 *   node scripts/connecteam-task.js --send --to "Khizar Hayat"
 *
 * Dry run by default. The only way to find out whether the API key may create
 * tasks is to create one — scopes are not reported anywhere, a read-only key
 * reads perfectly well and fails at the first POST — and the place to find
 * that out is not Matthew's list on the morning somebody crosses 15.
 *
 * So this sends one real task, with the same board, label and body a genuine
 * notice would carry, to whoever is named. Archive it afterwards.
 */
import {
  findBoard, findLabel, findUser, createTask, taskText,
  configured, writingEnabled, status
} from "../src/connecteam.js";
import { loadEnv } from "../src/db.js";

loadEnv();

const argv = process.argv.slice(2);
const SEND = argv.includes("--send");
const to = (() => {
  const i = argv.indexOf("--to");
  return i >= 0 ? argv[i + 1] : "Khizar Hayat";
})();

if (!configured()) {
  console.log("no CONNECTEAM_API_KEY set — nothing to try");
  process.exit(1);
}

const board = await findBoard();
if (!board) { console.log("no task board found"); process.exit(1); }
const label = await findLabel(board.id ?? board.taskBoardId);
const who = to.includes("@")
  ? await findUser({ email: to })
  : await findUser({ name: to });

console.log(`board : ${board.id} ${board.name}`);
console.log(`label : ${label ? `${label.id} ${label.name}` : "(none found — the task would be unfiled)"}`);
console.log(`to    : ${who ? `${who.userId} ${who.firstName} ${who.lastName} <${who.email}>` : `NOT FOUND: ${to}`}`);
if (!who) process.exit(1);

/* The same body a real notice would carry, so this tests the thing that will
   actually be sent rather than a "hello" that proves less than it looks. */
const { title, description } = taskText({
  name: "TEST — ignore", level: "warning", lost: 15,
  windowFrom: "2026-08-09", windowTo: "2026-10-08",
  incidents: [
    { date: "Oct 06, 2026", delta: -10, reason: "No call no show (tardy log)" },
    { date: "Sep 23, 2026", delta: -2, reason: "Call off — time off not requested in advance" }
  ]
});

console.log(`\ntitle : ${title}`);
console.log(`body  : ${description}`);

if (!SEND) {
  console.log("\nnothing sent. add --send to actually create it.");
  process.exit(0);
}
if (!writingEnabled()) {
  console.log(`\nrefused: ${status()}`);
  console.log("set CONNECTEAM_TASKS=on for this run if you mean to create it.");
  process.exit(1);
}

const task = await createTask({
  boardId: board.id ?? board.taskBoardId,
  userIds: [who.userId],
  labelIds: label ? [label.id] : undefined,
  title: `${title} (test)`,
  description
});
console.log(`\ncreated task ${task?.id ?? JSON.stringify(task)}. Archive it when you have seen it.`);
