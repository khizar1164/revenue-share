/* The disciplinary notice still has the boxes the fillable build needs.
 *
 * make-fillable.mjs turns every element carrying data-field into a PDF form
 * field. If somebody edits the template and drops one of those attributes,
 * nothing breaks and nothing complains: the notice still renders, still
 * prints, still looks right. It just quietly stops being fillable in that
 * box, and the first person to find out is Matthew, holding a write-up he
 * cannot type into.
 *
 * So the markers are checked here rather than discovered there. Building an
 * actual PDF needs Chrome and the better part of a minute, which does not
 * belong in a suite that runs on every change — but this part is free.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "hr", "disciplinary-notice.html"), "utf8");
const tool = readFileSync(join(root, "hr", "make-fillable.mjs"), "utf8");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const EXPECTED = ["prior", "required", "supervisor_comments", "employee_comments",
                  "employee_date", "supervisor_date"];

console.log("1. THE TEMPLATE'S FILLABLE BOXES");
const found = [...html.matchAll(/data-field="([^"]+)"/g)].map(m => m[1]);
for (const name of EXPECTED) check(name, found.includes(name));
check("and nothing unexpected", found.every(f => EXPECTED.includes(f)),
  found.filter(f => !EXPECTED.includes(f)).join(", ") || "none");
check("no box is marked twice", new Set(found).size === found.length);

/* Every box has to sit in a section, because the page a field lands on is
   worked out from which section it is in. */
console.log("\n2. EVERY BOX IS INSIDE A PAGE SECTION");
const sections = html.split(/<section class="page">/).slice(1);
const inSections = sections.flatMap(s =>
  [...s.split("</section>")[0].matchAll(/data-field="([^"]+)"/g)].map(m => m[1]));
check("all of them", inSections.length === found.length,
  `${inSections.length} of ${found.length}`);

console.log("\n3. THE TOOL KNOWS WHAT EACH BOX IS");
for (const name of EXPECTED) {
  check(`${name} has a label`, new RegExp(`\\b${name}:\\s*"`).test(tool));
}

/* The fillable build hides the ruled background, because form fields are laid
   over these boxes and typing on top of printed rules is unreadable. */
console.log("\n4. THE FILLABLE BUILD STILL TURNS THE RULES OFF");
check("body.fillable .lines drops the background",
  /body\.fillable \.lines\{background:none\}/.test(html));

/* The image installs with --omit=dev, so anything the running server imports
   has to be a real dependency. pdf-lib was a devDependency while the write-up
   was something I ran on my own machine; the moment the server started building
   them, that became a container that boots and then fails on the first press of
   the button, which is the worst time to find out. */
console.log("\n5. WHAT THE SERVER IMPORTS IS INSTALLED IN THE IMAGE");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const docker = readFileSync(join(root, "Dockerfile"), "utf8");
const omitsDev = /npm ci[^\n]*--omit=dev/.test(docker);
check("the image installs without dev dependencies", omitsDev);
if (omitsDev) {
  check("pdf-lib is a runtime dependency",
    Boolean(pkg.dependencies?.["pdf-lib"]) && !pkg.devDependencies?.["pdf-lib"]);
}
check("and the image is told where Chrome is", /ENV CHROME=/.test(docker));
check("with a browser installed to be there", /chromium/.test(docker));

/* .dockerignore is easy to make too greedy. The template is not optional. */
const ignore = readFileSync(join(root, ".dockerignore"), "utf8")
  .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
for (const needed of ["hr/disciplinary-notice.html", "hr/render-notice.mjs", "hr/make-fillable.mjs"]) {
  check(`${needed} reaches the image`,
    !ignore.some(pat => pat === needed || pat === "hr/" || pat === "hr"));
}

console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
process.exit(failures ? 1 : 0);
