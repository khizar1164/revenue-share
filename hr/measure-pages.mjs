/* How tall is each page of a notice, against how tall a page can be.
 *
 *   node hr/measure-pages.mjs hr/example-suspension.fillable.html
 *
 * Written because page 3 overflowed by an amount nobody could see, and the
 * usual way to deal with that is to shave the type until it fits — which is
 * how the first version of this document ended up cramped. Measuring says
 * which section is over and by how many pixels, so the fix can be given to
 * the section that is actually too tall.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const MM = 96 / 25.4;
const CONTENT_W = 8.5 * 96 - 2 * 14 * MM;              /* 710.17 */
const USABLE_H = 11 * 96 - (14 + 12) * MM;             /* 957.73 */

const chrome = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome"
].filter(Boolean).find(p => existsSync(p));
if (!chrome) throw new Error("no Chrome found. Set CHROME to the binary.");

const file = resolve(process.argv[2] ?? join("hr", "disciplinary-notice.html"));
const work = join(tmpdir(), "ims-measure-" + process.pid);
mkdirSync(work, { recursive: true });

const probe = `
<style>html,body{width:${CONTENT_W}px!important;margin:0!important}</style>
<script>
  (function () {
    function go() {
      var out = [], pages = document.querySelectorAll("section.page");
      for (var p = 0; p < pages.length; p++) {
        var tall = [], kids = pages[p].children;
        for (var k = 0; k < kids.length; k++) {
          var r = kids[k].getBoundingClientRect();
          if (r.height >= 20) {
            tall.push({ tag: kids[k].className || kids[k].tagName,
                        text: (kids[k].textContent || "").trim().slice(0, 34),
                        h: Math.round(r.height) });
          }
        }
        out.push({ page: p + 1, h: Math.round(pages[p].getBoundingClientRect().height), blocks: tall });
      }
      var box = document.createElement("div");
      box.id = "__pages";
      box.textContent = JSON.stringify(out);
      document.body.appendChild(box);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(go);
    else window.addEventListener("load", go);
  })();
</script>`;

const probePath = join(work, "m.html");
writeFileSync(probePath, readFileSync(file, "utf8").replace("</head>", probe + "\n</head>"));

const dom = execFileSync(chrome, [
  "--headless", "--disable-gpu", "--no-sandbox",
  "--user-data-dir=" + join(work, "p"),
  "--virtual-time-budget=15000", "--dump-dom",
  "file:///" + probePath.replace(/\\/g, "/")
], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

const m = dom.match(/<div id="__pages">([^<]*)<\/div>/);
if (!m) throw new Error("the measuring pass produced nothing");

console.log(`usable height per page: ${USABLE_H.toFixed(0)}px\n`);
for (const p of JSON.parse(m[1].replace(/&quot;/g, '"'))) {
  const over = p.h - USABLE_H;
  console.log(`page ${p.page}: ${p.h}px  ${over > 0 ? `OVER by ${Math.round(over)}px` : `${Math.round(-over)}px spare`}`);
  if (process.argv.includes("--blocks")) {
    for (const b of p.blocks) console.log(`     ${String(b.h).padStart(4)}  ${b.tag}  ${b.text}`);
  }
}
