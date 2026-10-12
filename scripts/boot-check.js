/* The server actually starts.
 *
 * On 12 October a deploy failed with "Cannot access 'wrap' before
 * initialization": a route had been added above the line that defines wrap,
 * and `const` does not hoist the way a function declaration does. Every check
 * in the suite passed, because none of them ran the server — `node --check`
 * parses, and a temporal dead zone error only exists at runtime.
 *
 * Render kept the previous version serving, so nothing broke for anyone. That
 * is luck rather than design, and the gap is worth closing: the one thing
 * never tested was whether the thing starts.
 *
 * So this runs it. Under NODE_ENV=test the server evaluates its whole module
 * and then declines to bind a port, which is exactly what is wanted: every
 * line of top-level code executes, so anything unresolvable throws, and
 * nothing is left listening afterwards. A clean exit means it would have
 * started. It needs no database — connections are made lazily — so this stays
 * in the suite that runs on every change rather than the one that needs
 * Postgres.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

console.log("1. THE SERVER STARTS");

const child = spawn(process.execPath, [join(root, "src", "server.js")], {
  cwd: root,
  env: {
    ...process.env,
    RUN_SCHEDULER: "off",      /* nothing should reach SmartMoving or a sheet */
    NODE_ENV: "test",          /* evaluate everything, bind nothing */
    SEND_EMAILS: "off",
    CONNECTEAM_TASKS: "off"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let out = "";
const done = new Promise(resolve => {
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });
  child.on("exit", code => resolve(code === 0 ? "ok" : `exited ${code}`));
  child.on("error", e => resolve(`could not run it: ${e.message}`));
  setTimeout(() => resolve("timed out"), 20000);
});

const how = await done;
child.kill("SIGKILL");

const ok = how === "ok";
console.log(`  ${ok ? "PASS" : "FAIL"}  every line of it evaluates  — ${ok ? "clean exit" : how}`);
if (!ok) {
  console.log("\n  what it printed:");
  for (const line of out.split("\n").slice(0, 25)) console.log("    " + line);
}

console.log("\n" + "=".repeat(58));
console.log(ok ? "ALL CHECKS PASSED" : "1 FAILURE(S)");
console.log("=".repeat(58));
process.exit(ok ? 0 : 1);
