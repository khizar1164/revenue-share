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

/* What kind of thing went wrong. Drives the impact wording below. */
const CATEGORY = [
  [/no call no show|call off/i,                        "absence"],
  [/claim|complaint/i,                                 "customer"],
  [/late|not out by shop|truck not out/i,              "lateness"],
  [/vap|smok|policy violation/i,                       "conduct"],
  [/restock|cleanliness|pads|equipment|walkthrough|material|fuel|inspection/i, "truck"]
];
const categoriesOf = incidents => new Set(incidents
  .filter(i => i.delta < 0)
  .map(i => (CATEGORY.find(([re]) => re.test(i.reason)) ?? [, "truck"])[1]));

/**
 * The impact section, built from what actually happened.
 *
 * Andrew, 2 October: "I don't feel like it explains the true depth. Financially,
 * Company Culture, Customer impression, Scheduling... one's actions can cause a
 * domino effect across the whole day."
 *
 * So it is four named dimensions rather than one vague line, and the wording
 * follows the incidents: a letter about truck condition should not lecture
 * somebody about missed shifts. Matthew can still edit any of it before he
 * sits down with the person — these are a starting point, not the last word.
 *
 * The financial line for a claim is the literal mechanism, not a figure of
 * speech: claims are deducted from the pool before it is divided, so they come
 * out of what every mover on the board is paid. September carried two, worth
 * $690.40 off the pool.
 */
export function impactRows(incidents) {
  const c = categoriesOf(incidents);
  const rows = [];
  const add = (k, p) => rows.push([k, p]);

  if (c.has("lateness") || c.has("absence")) {
    add("Scheduling", "A crew cannot leave the shop until everyone is there. One late start "
      + "pushes the first job back and every job behind it moves with it, so a delay at "
      + "seven in the morning is still being felt at the last job of the day.");
  } else if (c.has("truck")) {
    add("Scheduling", "A truck that has to be restocked, cleaned or sorted before it can "
      + "leave holds the whole crew at the shop, and that time comes out of the job.");
  }

  if (c.has("customer")) {
    add("Customers", "Customers tell each other and they tell Google. A complaint or a claim "
      + "costs us the review, the repeat booking and the referrals that would have followed "
      + "it, long after the job itself is forgotten.");
  } else if (c.has("conduct")) {
    add("Customers", "What a customer sees in their driveway is who we are to them. Anything "
      + "unprofessional in front of them undoes the work the rest of the crew has just done.");
  } else {
    add("Customers", "A customer who was given a window and is still waiting has already "
      + "formed an opinion of us before the first box is carried.");
  }

  add("The crew", c.has("absence")
    ? "When someone does not turn up the work does not disappear, it lands on the people who "
      + "did. They carry the heavier end all day, and they notice who left them to it."
    : "Standards hold because everyone keeps them. Every exception asks the people who did it "
      + "properly why they bothered, and that is how a good crew stops being one.");

  add("Financial", c.has("customer")
    ? "Claims are deducted from the revenue share pool before it is divided, so this does not "
      + "only cost the company. It comes out of what every mover on the board is paid that "
      + "month, including the people who had nothing to do with it."
    : "Hours spent waiting at the shop or putting right what should already have been right "
      + "are paid for and earn nothing. That is money the pool never sees.");

  return rows;
}

/** Points lost decides the level, so the document cannot contradict its own figures. */
export const levelFor = lost =>
  lost >= 45 ? "termination" : lost >= 30 ? "suspension" : "warning";

export const nextActionText = level =>
  level === "termination"
    ? "This is a termination."
  : level === "suspension"
    ? "This is a seven-day unpaid suspension. If 45 points are lost in a rolling 60-day "
      + "period, the next step is termination."
  : "This is a written warning. If 30 points are lost in a rolling 60-day period, the next "
    + "step is a seven-day unpaid suspension without pay. At 45 points it is termination.";

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

  const level = levelFor(down);

  const map = {
    EMPLOYEE_NAME: esc(data.employee),
    SUPERVISOR: esc(data.supervisor),
    DATE_ISSUED: day(data.issued),
    LVL_WARNING:     level === "warning"     ? "on" : "",
    LVL_SUSPENSION:  level === "suspension"  ? "on" : "",
    LVL_TERMINATION: level === "termination" ? "on" : "",
    NEXT_ACTION: nextActionText(level),
    IMPACT_ROWS: impactRows(data.incidents).map(([k, t]) =>
      `    <div class="imp"><span class="ik">${k}</span><p>${esc(t)}</p></div>`).join("\n"),
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
    PRIOR: esc(data.prior ?? ""),
    REQUIRED: esc(data.required ?? ""),
    SUPERVISOR_COMMENTS: esc(data.comments ?? ""),
    /* The ruled background is there to be written on. Where the system has
       already filled the box the rules run straight through the words, so
       they come off and the box is just a box. */
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
  warning: {
    file: "example-written-warning.html",
    employee: "Example Employee A", supervisor: "Matthew Brown",
    issued: "2026-10-06", pointsNow: 0,
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
    prior: "Verbal 28 August about timekeeping. Verbal 19 September after the hour-late start.",
    required: "Be at the shop and ready to work at your scheduled start time, every shift. "
      + "If something goes wrong on a job, tell Matthew the same day rather than letting "
      + "the customer be the one who raises it."
  },
  suspension: {
    file: "example-suspension.html",
    employee: "Example Employee B", supervisor: "Matthew Brown",
    issued: "2026-10-06", pointsNow: 0,
    windowFrom: "2026-08-07", windowTo: "2026-10-06",
    incidents: [
      { date: "2026-08-12", delta: -1,  reason: "Policy violation" },
      { date: "2026-08-21", delta: -2,  reason: "31 to 60 mins late" },
      { date: "2026-09-02", delta: -2,  reason: "Call off — time off not requested in advance" },
      { date: "2026-09-08", delta: -3,  reason: "61+ mins late" },
      { date: "2026-09-15", delta: -2,  reason: "Customer complaint — vaping/smoking in sight of customer" },
      { date: "2026-09-21", delta: -3,  reason: "Same day call off" },
      { date: "2026-09-30", delta: -3,  reason: "Claim" },
      { date: "2026-10-03", delta: -5,  reason: "Customer complaint — specifically names you" },
      { date: "2026-10-06", delta: -10, reason: "No call no show (tardy log)" }
    ],
    prior: "Written warning issued 19 September 2026 after reaching 15 points. "
      + "Verbal 2 September about calling off without notice.",
    required: "Return from suspension able to be relied on: at the shop on time, every "
      + "shift, and a phone call to Matthew before the start of any shift you cannot make. "
      + "Nothing about a customer job is to reach Andrew before it reaches Matthew."
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
