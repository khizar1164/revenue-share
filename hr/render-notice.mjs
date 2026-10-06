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
   so the specific patterns sit above the general ones. Vaping in front of a
   customer is logged as a complaint but it is really professionalism, so it is
   tested before the general complaint rule. */
export const VALUE_RULES = [
  [/vap|smok/i,                                       "integrity"],
  [/policy violation/i,                               "integrity"],
  [/no call no show|call off/i,                       "loyalty"],
  [/claim|complaint/i,                                "excellence"],
  [/late|not out by shop|truck not out/i,             "teamwork"],
  [/restock|cleanliness|pads|equipment|walkthrough|material|fuel|inspection/i,
                                                      "accountability"]
];

const ruleValue = reason => {
  for (const [re, key] of VALUE_RULES) if (re.test(reason)) return key;
  return "accountability";
};

/**
 * Which value a write-up names when several things went wrong.
 *
 * The worst incident decides it. Taking the first rule that matched anything
 * meant a list led by a one-point untidy truck named Accountability while the
 * ten-point no call no show sat underneath it — the letter would have argued
 * the wrong point. Ties go to the earliest, so the answer is stable.
 */
export function valueFor(incidents) {
  const bad = incidents.filter(i => i.delta < 0);
  if (!bad.length) return "accountability";
  const worst = Math.min(...bad.map(i => i.delta));
  return ruleValue(bad.find(i => i.delta === worst).reason);
}

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

  /* A supervisor can write someone up before the points trigger it, so the box
     has to read honestly either way: below 15 it names the threshold they are
     heading for, above it names the one they crossed and what comes next. A
     notice that says "THRESHOLD 15" against 10 points lost would be stating
     something that has not happened. */
  const STEPS = [[15, "a written warning"], [30, "a seven-day unpaid suspension"],
                 [45, "termination"]];
  const down = Math.abs(lost);
  const crossedAt = STEPS.filter(([n]) => down >= n).map(([n]) => n).pop() ?? null;
  const crossed = crossedAt !== null;
  const next = STEPS.find(([n]) => down < n) ?? null;
  const nextAt = next ? next[0] : 45;
  const nextStep = next
    ? `${next[0] - down} more point${next[0] - down === 1 ? "" : "s"} lost in this window reaches ${next[1]}.`
    : "This is at or past the termination threshold.";

  const map = {
    EMPLOYEE_NAME: esc(data.employee),
    SUPERVISOR: esc(data.supervisor),
    DATE_ISSUED: day(data.issued),
    LVL_WARNING:     data.level === "warning"     ? "on" : "",
    LVL_SUSPENSION:  data.level === "suspension"  ? "on" : "",
    LVL_TERMINATION: data.level === "termination" ? "on" : "",
    POINTS_LOST: String(Math.abs(lost)),
    POINTS_LOST_SIGNED: "−" + String(Math.abs(lost)),
    /* When a threshold has been crossed the box names that one, not the one
       ahead of it — a notice issued at 18 points is being issued because of
       the 15, and printing "THRESHOLD 30" beside it states the wrong rule. */
    THRESHOLD_LABEL: crossed ? "Threshold" : "Next threshold",
    THRESHOLD: String(crossed ? crossedAt : nextAt),
    NEXT_STEP: nextStep,
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

/* Andrew, 2 October: "do an example with a bunch of different violations, keep
   it under 15 points. Then another between 15 and 30." Both run from here so
   he can ask for a third without anyone hand-building one. */
const EXAMPLES = {
  under15: {
    file: "example-under-15.html",
    employee: "Example Employee A", supervisor: "Matthew Brown",
    issued: "2026-10-06", level: "warning", pointsNow: 5,
    windowFrom: "2026-08-07", windowTo: "2026-10-06",
    incidents: [
      { date: "2026-08-19", delta: -1, reason: "Truck not restocked" },
      { date: "2026-08-26", delta: -1, reason: "Truck cleanliness not acceptable" },
      { date: "2026-09-03", delta: -1, reason: "Up to 30 mins late" },
      { date: "2026-09-09", delta: -1, reason: "Equipment/pads not neatly organized on truck" },
      { date: "2026-09-17", delta: -2, reason: "Stopped before first job without need for fuel (15-20% or less)" },
      { date: "2026-09-24", delta: -1, reason: "Failure to perform pre-inspection walkthrough properly" },
      { date: "2026-10-01", delta: -1, reason: "Applicable material/equipment not removed from truck" },
      { date: "2026-10-05", delta: -2, reason: "Customer complaint — vaping/smoking in sight of customer" }
    ],
    impact: "Trucks going out unstocked and untidy costs the crew time on site and "
      + "it is the first thing a customer sees when the doors open.",
    prior: "Spoken to on 26 August and again on 17 September about truck condition.",
    required: "Restock and check the truck at the end of every shift, and complete the "
      + "pre-inspection walkthrough properly before leaving the shop. No vaping or "
      + "smoking anywhere a customer can see you."
  },
  mid: {
    file: "example-15-to-30.html",
    employee: "Example Employee B", supervisor: "Matthew Brown",
    issued: "2026-10-06", level: "warning", pointsNow: 0,
    windowFrom: "2026-08-07", windowTo: "2026-10-06",
    incidents: [
      { date: "2026-08-14", delta: -1, reason: "Policy violation" },
      { date: "2026-08-28", delta: -1, reason: "Up to 30 mins late" },
      { date: "2026-09-05", delta: -2, reason: "31 to 60 mins late" },
      { date: "2026-09-12", delta: -2, reason: "Call off — time off not requested in advance" },
      { date: "2026-09-19", delta: -3, reason: "61+ mins late" },
      { date: "2026-09-29", delta: -3, reason: "Claim" },
      { date: "2026-10-02", delta: -1, reason: "Truck not restocked" },
      { date: "2026-10-05", delta: -5, reason: "Customer complaint — specifically names you" }
    ],
    impact: "Three late starts held crews at the shop and moved every job behind them. "
      + "The claim and the complaint both reached Andrew, which is money off the pool "
      + "and a customer we may not get back.",
    prior: "Verbal 28 August about timekeeping. Verbal 19 September after the hour-late start.",
    required: "Be at the shop and ready to work at your scheduled start time, every shift. "
      + "If something goes wrong on a job, tell Matthew the same day rather than "
      + "letting the customer be the one who raises it."
  }
};

for (const key of Object.keys(EXAMPLES)) {
  if (!process.argv.includes("--" + key) && !process.argv.includes("--examples")) continue;
  const e = EXAMPLES[key];
  const html = fill({ ...e, value: valueFor(e.incidents) });
  const out = join(here, e.file);
  writeFileSync(out, html);
  const lost = Math.abs(e.incidents.reduce((a, i) => a + Math.min(0, i.delta), 0));
  console.log(`${e.file}  ${e.incidents.length} incidents, ${lost} points lost, value: ${valueFor(e.incidents)}`);
}

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
    value: valueFor(incidents),
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
