/* The inline scripts in public/*.html actually parse.
 *
 * Worth its own check because of how these pages fail. There is no build step
 * and no module loader: one bad character anywhere in admin.html's script and
 * the browser throws out the whole thing, so every handler on the page stops
 * binding. On 7 October that took out admin sign-in. The page rendered, the
 * password box accepted typing, the button did nothing, and nothing in the
 * suite or the logs said why — a string literal with a real newline in it,
 * three hundred lines away in the background jobs panel.
 *
 * Parsing is all this does. It cannot run the code, because the code wants a
 * document. But a syntax error is the failure that costs the entire page, and
 * it is the one a parse always catches.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pages = join(root, "public");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

/* Every <script> with a body of its own. A src= tag has nothing to parse. */
function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    if (m[2].trim()) out.push(m[2]);
  }
  return out;
}

const parses = body => {
  try { new Function(body); return null; }
  catch (e) { return e.message; }
};

console.log("1. THE PAGES' SCRIPTS PARSE");
for (const file of readdirSync(pages).filter(f => f.endsWith(".html")).sort()) {
  const scripts = inlineScripts(readFileSync(join(pages, file), "utf8"));
  if (!scripts.length) { check(`${file} has no inline script`, true); continue; }
  scripts.forEach((body, i) => {
    const which = scripts.length > 1 ? `${file} script ${i + 1}` : file;
    const err = parses(body);
    check(which, err === null, err ?? `${body.split("\n").length} lines`);
  });
}

/* A guard nobody has watched fail is a guard nobody should trust. This is the
   exact shape of the 7 October mistake. */
console.log("\n2. THE CHECK ITSELF WORKS");
const brokenPage = ["<script>", 'var x = "oh no', 'there";', "</script>"].join("\n");
check("a string broken across a line is rejected",
  parses(inlineScripts(brokenPage)[0]) !== null);
check("and a sound one is not",
  parses(inlineScripts('<script>var x = "fine";</script>')[0]) === null);

console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
process.exit(failures ? 1 : 0);
