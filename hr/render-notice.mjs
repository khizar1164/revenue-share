/* Fill the disciplinary notice template and write it out as HTML ready for PDF.
 *
 *   node hr/render-notice.mjs --sample
 *   node hr/render-notice.mjs --employee <uuid> --level warning
 *
 * The template is plain {{TOKEN}} substitution on purpose. No templating library
 * for one document, and a missing token fails loudly rather than printing
 * "{{POINTS_LOST}}" on a letter that goes in somebody's file.
 *
 * Render to PDF with headless Chrome:
 *   chrome --headless=new --print-to-pdf=out.pdf --no-pdf-header-footer file:///...
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, "disciplinary-notice.html");

/* Andrew's values, exactly as written in Core Values.pdf. The write-up names
   the one the behaviour fell short of, so it reads as "here is the standard,
   here is where it slipped" rather than a list of dates and numbers. Andrew
   has the final say on which reason maps to which value — this is a first
   pass for him to correct. */
export const VALUES = {
  integrity: ["Integrity",
    "We do the right thing, even when no one is watching. We maintain honesty, professionalism, and the right attitude in everything we do."],
  accountability: ["Accountability",
    "We take ownership of every relocation project assigned to us and accept responsibility for our actions and decisions. When we make a mistake, we own it, make it right, and learn from it."],
  boldness: ["Boldness",
    "We face challenges and obstacles with courage, confidence, and determination. We are not afraid to take initiative, solve problems, or make difficult decisions when necessary."],
  loyalty: ["Loyalty",
    "We value trust, commitment, and dedication in our relationships with our team, customers, and company. We work to create security, solidarity, and lasting connections."],
  teamwork: ["Teamwork",
    "We value cooperation, communication, and unity. We support one another and recognize that our collective effort is stronger than any one individual. We achieve more together."],
  excellence: ["Excellence",
    "We strive to do our best on every job, every day. We maintain high standards, continue to improve, and look for ways to become better at what we do."]
};

/* Reason text -> the value it falls short of. Order matters: first match wins,
   so the specific patterns sit above the general ones. */
export const VALUE_RULES = [
  [/no call no show|call off/i,                 "loyalty"],
  [/late|not out by shop|truck not out/i,       "teamwork"],
  [/claim|complaint/i,                          "excellence"],
  [/restock|cleanliness|pads|equipment|walkthrough|material/i, "accountability"],
  [/policy violation|vap|smok/i,                "integrity"]
];

export const valueFor = reasons => {
  for (const [re, key] of VALUE_RULES) if (reasons.some(r => re.test(r))) return key;
  return "accountability";
};

const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const day = d => new Date(d + "T00:00:00").toLocaleDateString("en-US",
  { month: "short", day: "numeric", year: "numeric" });

export function fill(data) {
  const html = readFileSync(TEMPLATE, "utf8");
  const [vName, vText] = VALUES[data.value] ?? VALUES.accountability;

  const rows = data.incidents.map(i =>
    `<tr><td>${day(i.date)}</td><td>${esc(i.reason)}</td>` +
    `<td class="n pts">${i.delta > 0 ? "+" : "−"}${Math.abs(i.delta)}</td></tr>`).join("\n      ");

  const lost = data.incidents.filter(i => i.delta < 0).reduce((a, i) => a + i.delta, 0);

  const map = {
    EMPLOYEE_NAME: esc(data.employee),
    SUPERVISOR: esc(data.supervisor),
    DATE_ISSUED: day(data.issued),
    LVL_WARNING:     data.level === "warning"     ? "on" : "",
    LVL_SUSPENSION:  data.level === "suspension"  ? "on" : "",
    LVL_TERMINATION: data.level === "termination" ? "on" : "",
    POINTS_LOST: String(Math.abs(lost)),
    POINTS_LOST_SIGNED: "−" + String(Math.abs(lost)),
    THRESHOLD: data.level === "termination" ? "45" : data.level === "suspension" ? "30" : "15",
    POINTS_NOW: String(data.pointsNow),
    WINDOW_FROM: day(data.windowFrom),
    WINDOW_TO: day(data.windowTo),
    INCIDENT_ROWS: rows,
    VALUE_NAME: vName,
    VALUE_TEXT: esc(vText),
    IMPACT: esc(data.impact ?? ""),
    PRIOR: esc(data.prior ?? ""),
    REQUIRED: esc(data.required ?? ""),
    SUPERVISOR_COMMENTS: esc(data.comments ?? ""),
    /* The ruled background is there to be written on. Where the system has
       already filled the box the rules run straight through the words, so
       they come off and the box is just a box. */
    IMPACT_CLS:   data.impact   ? "prefill" : "",
    PRIOR_CLS:    data.prior    ? "prefill" : "",
    REQUIRED_CLS: data.required ? "prefill" : "",
    COMMENTS_CLS: data.comments ? "prefill" : ""
  };

  let out = html;
  for (const [k, v] of Object.entries(map)) out = out.replaceAll(`{{${k}}}`, v);

  const missed = out.match(/\{\{[A-Z_]+\}\}/g);
  if (missed) throw new Error("template tokens left unfilled: " + [...new Set(missed)].join(", "));
  return out;
}

/* ------------------------------------------------------------------------- */

if (process.argv.includes("--sample")) {
  const incidents = [
    { date: "2026-09-18", delta: -1,  reason: "Late — 23 min (tardy log)" },
    { date: "2026-09-23", delta: -2,  reason: "Call off — time off not requested in advance" },
    { date: "2026-10-01", delta: -1,  reason: "Truck not out on time (tardy log)" },
    { date: "2026-10-02", delta: -1,  reason: "Late — 18 min (tardy log)" },
    { date: "2026-10-06", delta: -10, reason: "No call no show (tardy log)" }
  ];
  const html = fill({
    employee: "Example Employee",
    supervisor: "Matthew Brown",
    issued: "2026-10-06",
    level: "warning",
    pointsNow: 2,
    windowFrom: "2026-08-07",
    windowTo: "2026-10-06",
    incidents,
    value: valueFor(incidents.map(i => i.reason)),
    impact: "Crews cannot leave the shop until everyone is accounted for, so a late "
      + "start moves every job behind it and the customer waits.",
    prior: "Verbal discussion 23 September 2026 after the call off.",
    required: "Arrive and be ready to work at your scheduled start time. If you are "
      + "going to be late, call Matthew before the shift starts, not after."
  });
  const out = join(here, "sample-notice.html");
  writeFileSync(out, html);
  console.log("wrote " + out);
}
