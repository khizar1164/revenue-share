/* Turn a rendered notice into a PDF Matthew can type into.
 *
 *   node hr/make-fillable.mjs jayson-write-up.html
 *   node hr/make-fillable.mjs jayson-write-up.html --out somewhere-else.pdf
 *
 * Andrew, 3 October: "add that it will be an editable pdf so Matthew can add."
 * So the four write-in boxes and the two date lines become real PDF form
 * fields. Everything else — the incidents, the points, the policy, the core
 * values — is printed and cannot be edited, which is the point: the generated
 * record is the record, and the parts a supervisor fills in are the parts a
 * supervisor fills in.
 *
 * How the coordinates are found, because this is the only interesting part.
 * Chrome will print the page but it will not tell you where anything landed,
 * and the PDF has no idea it was ever HTML. So the document is measured twice:
 *
 *   1. opened at exactly the width the printed page gives it — US Letter less
 *      the 14mm side margins, which is 710.17 CSS pixels — and every element
 *      carrying data-field reports its box relative to its own page section;
 *   2. printed to PDF.
 *
 * Both runs lay out the same document at the same width with the same fonts, so
 * the boxes from the first are where the ink is in the second. Pixels become
 * points at 0.75 (96dpi CSS against 72dpi PDF) and the page margins are added
 * back by hand, since @page margins only exist when printing.
 *
 * It is exact rather than approximately right, and it stays exact if the design
 * changes, which hand-placed coordinates would not.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument, StandardFonts, rgb, PDFName, PDFString } from "pdf-lib";

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));

/* US Letter in CSS pixels, and the margins from the template's @page rule.
   If that rule changes these have to change with it, so it is stated once. */
const MM = 96 / 25.4;              /* CSS pixels per millimetre */
const PAGE_W_PX = 8.5 * 96;        /* 816    */
const MARGIN_X_MM = 14;
const MARGIN_TOP_MM = 14;
const CONTENT_W_PX = PAGE_W_PX - 2 * MARGIN_X_MM * MM;   /* 710.17 */
const PX_TO_PT = 0.75;
const PAGE_H_PT = 11 * 72;         /* 792 */
const MARGIN_X_PT = MARGIN_X_MM * (72 / 25.4);           /* 39.685 */
const MARGIN_TOP_PT = MARGIN_TOP_MM * (72 / 25.4);

/* Which fields hold a paragraph and which hold one line. A date in a multiline
   field would let someone press Enter and push the date out of sight. */
const MULTILINE = new Set(["prior", "required", "supervisor_comments", "employee_comments"]);

/* What each field is called in a PDF reader's tab order and tooltip. Nobody
   reads field names, but someone filling the form with the keyboard hears
   them, and "prior" on its own says nothing. */
const LABELS = {
  prior: "Previous discussions or warnings on this subject",
  required: "What must change",
  supervisor_comments: "Additional comments — supervisor",
  employee_comments: "Employee comments",
  employee_date: "Date — employee",
  supervisor_date: "Date — supervisor"
};

/** Where Chrome is, or null. For a health check that can say whether this
    server is able to build a write-up at all, rather than finding out when
    somebody presses the button. */
export function chromePath() {
  try { return chrome(); } catch { return null; }
}

function chrome() {
  /* Set deliberately, so a wrong value is a mistake to report rather than a
     reason to quietly use a different browser than the one asked for. */
  if (process.env.CHROME) {
    if (existsSync(process.env.CHROME)) return process.env.CHROME;
    throw new Error(`no Chrome found at CHROME=${process.env.CHROME}`);
  }
  const guesses = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
  const found = guesses.find(p => existsSync(p));
  if (!found) throw new Error("no Chrome found. Set CHROME to the binary.");
  return found;
}

/* A scratch directory of our own. Chrome wants a profile directory it can
   write to and will pick a surprising one if not told. */
function scratch() {
  const d = join(tmpdir(), "ims-notice-" + process.pid);
  mkdirSync(d, { recursive: true });
  return d;
}

/* Step one: where is every field box, in pixels, relative to its page. */
async function measure(html, work) {
  const probe = `
<style>html,body{width:${CONTENT_W_PX}px!important;margin:0!important}</style>
<script>
  (function () {
    function go() {
      var out = [], pages = document.querySelectorAll("section.page");
      for (var p = 0; p < pages.length; p++) {
        var sr = pages[p].getBoundingClientRect();
        var fields = pages[p].querySelectorAll("[data-field]");
        for (var i = 0; i < fields.length; i++) {
          var r = fields[i].getBoundingClientRect();
          out.push({ name: fields[i].getAttribute("data-field"), page: p,
                     x: r.left - sr.left, y: r.top - sr.top,
                     w: r.width, h: r.height });
        }
      }
      var box = document.createElement("div");
      box.id = "__rects";
      box.setAttribute("data-pages", String(pages.length));
      box.textContent = JSON.stringify(out);
      document.body.appendChild(box);
    }
    /* Measured before the webfonts arrive, every box would be the wrong
       height, because the fallback font sets different line boxes. */
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(go);
    else window.addEventListener("load", go);
  })();
</script>`;

  const probePath = join(work, "measure.html");
  writeFileSync(probePath, html.replace("</head>", probe + "\n</head>"));

  const { stdout: dom } = await run(chrome(), [
    "--headless", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    "--user-data-dir=" + join(work, "profile"),
    /* Five seconds is generous. Measured across 15s, 8s, 4s, 2s and 1s the
       boxes land in exactly the same place and the run takes the same four
       seconds either way, because the cost is starting Chrome rather than
       waiting for anything. The budget is only here so that a stalled webfont
       cannot hang somebody's request. */
    "--virtual-time-budget=5000",
    "--dump-dom", "file:///" + probePath.replace(/\\/g, "/")
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  const m = dom.match(/<div id="__rects" data-pages="(\d+)">([^<]*)<\/div>/);
  if (!m) throw new Error("the measuring pass produced nothing. Did Chrome reach the webfonts?");
  return { sections: Number(m[1]), rects: JSON.parse(m[2].replace(/&quot;/g, '"')) };
}

/* Step two: the PDF itself, exactly as it is produced today. */
async function print(htmlPath, work) {
  const out = join(work, "flat.pdf");
  await run(chrome(), [
    "--headless", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    "--user-data-dir=" + join(work, "profile2"),
    "--virtual-time-budget=5000",
    "--no-pdf-header-footer",
    "--print-to-pdf=" + out,
    "file:///" + htmlPath.replace(/\\/g, "/")
  ]);
  return readFileSync(out);
}

export async function makeFillable({ htmlPath, outPath, values = {} }) {
  const html = readFileSync(htmlPath, "utf8");
  if (!/\bdata-field=/.test(html)) {
    throw new Error("that HTML has no data-field boxes in it, so there is nothing to make fillable");
  }

  const work = scratch();

  /* Both passes read the same file and neither needs the other's answer, so
     they could run at once — Chrome takes about four seconds to start whatever
     it is asked to do, and doing that twice in a row is four seconds somebody
     spends watching a button.
     
     They do not, by default. The service runs on a 512MB instance and a
     headless Chromium printing this document wants a couple of hundred of
     those. Two at once plus Node is close enough to the ceiling that a write-up
     could take the dashboard and the break-room board down with it, and saving
     four seconds on a once-a-month button is not worth that. NOTICE_PARALLEL=on
     turns it on where there is memory to spare. */
  let sections, rects, flat;
  if (process.env.NOTICE_PARALLEL === "on") {
    [{ sections, rects }, flat] = await Promise.all([
      measure(html, work),
      print(htmlPath, work)
    ]);
  } else {
    ({ sections, rects } = await measure(html, work));
    flat = await print(htmlPath, work);
  }
  if (!rects.length) throw new Error("no field boxes were found on the page");

  const pdf = await PDFDocument.load(flat);
  const pages = pdf.getPages();

  /* The page a field lands on is taken from which section it sits in, which
     holds only while one section prints as one page. If the design ever grows
     past that, fields would be stamped onto the wrong sheet — so it stops
     here rather than producing a convincing wrong document. */
  if (pages.length !== sections) {
    throw new Error(`the document measured ${sections} sections but printed ` +
      `${pages.length} pages. A section has overflowed, and field positions ` +
      `cannot be trusted until it fits.`);
  }

  const form = pdf.getForm();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (const r of rects) {
    const page = pages[r.page];
    const multi = MULTILINE.has(r.name);

    const field = form.createTextField("ims." + r.name);
    /* The tooltip, which is also what a screen reader announces and what some
       readers show in the field list. "prior" tells nobody anything. */
    if (LABELS[r.name]) {
      field.acroField.dict.set(PDFName.of("TU"), PDFString.of(LABELS[r.name]));
    }
    if (multi) field.enableMultiline();
    const text = values[r.name];
    if (text) field.setText(String(text));

    /* Inset so the typing does not sit against the printed frame. The date
       lines are a rule under the text rather than a box, so they only need
       room at the sides. */
    const padX = 3, padTop = multi ? 2 : 0, padBottom = multi ? 2 : 3;

    field.addToPage(page, {
      x: MARGIN_X_PT + r.x * PX_TO_PT + padX,
      y: PAGE_H_PT - (MARGIN_TOP_PT + (r.y + r.h) * PX_TO_PT) + padBottom,
      width: r.w * PX_TO_PT - 2 * padX,
      height: r.h * PX_TO_PT - padTop - padBottom,
      font,
      borderWidth: 0,
      backgroundColor: undefined,
      textColor: rgb(0.1, 0.1, 0.1)
    });

    /* After addToPage, not before: the size lives in the field's default
       appearance string, and that string does not exist until the field is
       on a page. */
    field.setFontSize(multi ? 10 : 11);
  }

  /* Without this a reader may show the fields empty until each one is clicked. */
  form.updateFieldAppearances(font);

  const bytes = await pdf.save();
  writeFileSync(outPath, bytes);
  return { out: outPath, fields: rects.map(r => r.name), pages: pages.length };
}

/* ------------------------------------------------------------------------- */

/* Only when somebody ran this file. The server imports it, and under `node -e`
   there is no argv[1] at all, which the previous version read straight off the
   end of. */
const ranDirectly = typeof process.argv[1] === "string" &&
  process.argv[1].replace(/\\/g, "/").endsWith("/make-fillable.mjs");

if (ranDirectly) {
  const args = process.argv.slice(2);
  const htmlArg = args.find(a => !a.startsWith("--"));
  if (!htmlArg) {
    console.log("usage: node hr/make-fillable.mjs <notice.html> [--out file.pdf]");
    process.exit(1);
  }
  const htmlPath = resolve(existsSync(htmlArg) ? htmlArg : join(here, htmlArg));
  const i = args.indexOf("--out");
  const outPath = i >= 0 && args[i + 1]
    ? resolve(args[i + 1])
    : htmlPath.replace(/\.fillable\.html$|\.html$/, ".fillable.pdf");

  /* Whatever the generator already worked out for those boxes travels in a
     sidecar beside the HTML, so it arrives as the field's starting text
     instead of being printed where nobody can change it. */
  const sidecar = htmlPath.replace(/\.html$/, ".fields.json");
  const values = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, "utf8")) : {};

  const res = await makeFillable({ htmlPath, outPath, values });
  console.log(`${basename(res.out)} — ${res.pages} pages, ${res.fields.length} fillable boxes:`);
  for (const f of res.fields) {
    console.log(`   ${(LABELS[f] ?? f).padEnd(44)}${values[f] ? "pre-filled" : "empty"}`);
  }
}
