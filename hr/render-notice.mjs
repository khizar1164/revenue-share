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

/* Why each violation matters, in operational terms.
 *
 * Andrew's own wording, from the planning thread he sent on 6 October, lightly
 * trimmed to fit a form. Keeping his words matters: this is the paragraph the
 * employee reads, and he is the one who has to stand behind it.
 *
 * Keyed to the Performance Points sheet. First match wins, so the specific
 * patterns sit above the general ones.
 */
export const IMPACT_LIBRARY = [
  [/no call no show/i, "No call no show creates one of the greatest scheduling disruptions, because management cannot plan around an absence they do not know about. Dispatch waits, tries to make contact, then has to reorganise crews on the spot. The uncertainty affects coworkers, customers, labour cost and management time all at once."],
  [/same.?day call off/i, "A same-day absence leaves almost no opportunity to replace you. Crews go out understaffed, jobs take longer, coworkers are asked to work harder or later, and customers wait. It can also mean overtime, or pulling someone off another assignment."],
  [/call off/i, "Calling off without notice leaves the day short-handed. Jobs take longer, coworkers carry the heavier end, and management has to rearrange crews that were built around expected staffing."],
  [/61\+|61 ?\+|61 or more/i, "At this point management may have to restructure the day entirely. Trucks, crews and customers are scheduled around expected staffing, so an extended absence affects numerous employees and customers rather than only the person who is late."],
  [/31 to 60/i, "A delay of this length can require dispatch to hold an entire crew, replace you, rearrange assignments or call the customer about a late arrival. It increases payroll expense while reducing productive hours, and can put later jobs on the schedule at risk."],
  [/up to 30 mins late|late —|late -/i, "Even a short delay can stop a crew leaving the shop on time. Movers work as a team, so one person being late leaves several people waiting while the customer's arrival window keeps running. That delay carries into every job scheduled afterwards and creates extra labour cost, rushed conditions and customer dissatisfaction."],
  [/not out by shop|truck not out/i, "The scheduled departure time exists so the crew can reach the customer inside the promised window. Delaying departure affects not only the first customer but potentially every customer that truck is booked to see that day."],
  [/fuel/i, "Fuelling is part of vehicle readiness. An avoidable stop with adequate fuel already in the tank delays the whole crew, and the company is paying several people while the truck is not moving towards a job that earns anything."],
  [/restock/i, "The next crew may not discover missing materials until they are ready to leave, or worse, until they arrive at the job. That means unnecessary trips, delays, an inability to protect the customer's belongings properly, and friction between crews."],
  [/pads|equipment\/pads|organiz/i, "Poor organisation wastes time at the start of every job, makes equipment harder to account for, increases the chance of something going missing, and puts the work onto whoever uses the truck next."],
  [/cleanliness/i, "The truck is part of the customer's impression of this company. A dirty or poorly kept truck undermines their confidence before the move has even started, and forces somebody else to put right what should already have been done."],
  [/material|not removed from truck/i, "Equipment that is not returned properly is unavailable to another truck or crew. People end up searching for supplies, buying replacements, or going out to a job inadequately equipped."],
  [/walkthrough|inspection/i, "The walkthrough protects the customer, you, and the company. Missing existing damage, access problems, difficult items or floor and wall conditions is what creates arguments later about who was responsible, and it increases our exposure to claims."],
  [/vap|smok/i, "Customers are judging professionalism for the whole move. Smoking or vaping where a customer can see it affects their opinion of you and of the whole company, and can lead to complaints, poor reviews, lost referrals, or worry about smoke near their belongings."],
  [/specifically names you/i, "When a customer names an individual, their concern was tied directly to that person's conduct or performance. A complaint takes management time to investigate and resolve, and can end in discounts, refunds, lost referrals, negative reviews or a claim."],
  [/complaint/i, "A complaint takes management time to investigate and resolve, and can end in discounts, refunds, lost referrals, negative reviews, chargebacks or claims."],
  [/claim/i, "Damage has direct financial consequences through repair, replacement, claims administration, insurance exposure and management time. It also affects how far the customer trusts us, and whether they recommend us or come back."],
  [/policy violation/i, "Policies set consistent expectations for safety, service, accountability and fairness. When they are disregarded it creates inconsistency, and it tells coworkers that the standards are optional."]
];

const impactFor = reason => (IMPACT_LIBRARY.find(([re]) => re.test(reason)) ?? [, null])[1];

/**
 * The impact section.
 *
 * Two halves, and the split is the whole point. Andrew, 6 October: "I wouldn't
 * have AI automatically tell an employee 'you cost the company $500' unless
 * that is actually documented."
 *
 * So the system writes only the part it can stand behind — why this kind of
 * thing matters, in general, which is teaching rather than accusation. What
 * actually happened on the day is left for Matthew to fill in, because he is
 * the one who knows whether the truck left thirty minutes late and who was
 * stood waiting for it. A form that invented those details would be worse
 * than one that left them blank.
 */
export function impactNarrative(incidents, limit = 3) {
  const bad = incidents.filter(i => i.delta < 0)
    .sort((a, b) => a.delta - b.delta);          // worst first
  const seen = new Set(), rows = [];
  for (const i of bad) {
    const text = impactFor(i.reason);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    rows.push([i.reason, text]);
    if (rows.length >= limit) break;
  }
  return rows;
}

/**
 * Facts the system can actually evidence, as opposed to ones it would be
 * guessing at. Khizar, 7 October: "we can see tardies and claim and AI can put
 * as I know?" — right, and the first draft was too timid about it.
 *
 * What is in the data: the minutes, because the tardy log records them and
 * they are carried in the reason text; how many separate occasions; how many
 * shifts were missed; how many incidents reached a customer.
 *
 * What is NOT in the data, and must never be written as though it were: the
 * cost of a claim against a person. The claims table has an amount and a job
 * number but no employee — claims come off the pool company-wide and are not
 * attributed to anyone. So the notice can say a claim happened, and the points
 * sheet says what it costs in points, but it cannot say "your claim cost $550"
 * because the system does not know whose it was.
 */
/**
 * A documented claim, stated as the record holds it.
 *
 * Khizar, 7 October: "it is already documented you already know the claim is
 * $550 on 28". Correct, and the earlier draft was too cautious: the amount,
 * the job and the date are all recorded, so they belong on the notice.
 *
 * What is not recorded is who caused the damage. The claims table carries an
 * amount and a job number and no employee, and the three point deduction for
 * the September claim went to four people. So the sentence names the job and
 * the amount, and states the person's connection to it as a fact — on the
 * crew, and point-charged — without ever saying they cost the company that
 * money. That is the difference between a figure that holds up and one that
 * gets taken apart.
 */
const money = n => "$" + Number(n).toLocaleString("en-US",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function claimLines(claims = []) {
  return claims.map(c => {
    const what = c.reason ? ` for ${String(c.reason).toLowerCase()}` : "";
    const when = new Date(c.date + "T00:00:00").toLocaleDateString("en-US",
      { month: "long", day: "numeric", year: "numeric" });
    const tie = c.onCrew
      ? "You were on the crew for that job and carry a 3 point deduction for it."
      : "You carry a 3 point deduction for it.";
    return `A claim of ${money(c.amount)}${what} is recorded against job ` +
           `${c.job_number} on ${when}. ${tie}`;
  });
}

export function recordShows(incidents, claims = []) {
  const bad = incidents.filter(i => i.delta < 0);
  const out = [];

  const lates = bad.filter(i => /late/i.test(i.reason) && !/truck not out/i.test(i.reason));
  /* Only the tardy log records a real figure, in the form "Late - 23 min".
     "Up to 30 mins late" is the name of a band on the points sheet, not a
     measurement, and adding those up would invent a total nobody measured. */
  let measured = 0, counted = 0;
  for (const i of lates) {
    const m = String(i.reason).match(/late\s*[—-]\s*(\d+)\s*min/i);
    if (m) { measured += Number(m[1]); counted++; }
  }
  const mins = measured;
  if (lates.length) {
    out.push(`${lates.length} late arrival${lates.length === 1 ? "" : "s"}` +
      (mins ? `, of which ${counted} ${counted === 1 ? "was" : "were"} timed at ` +
              `${mins} minutes in total` : "") + ".");
  }

  const trucks = bad.filter(i => /truck not out/i.test(i.reason));
  if (trucks.length) out.push(`${trucks.length} occasion${trucks.length === 1 ? "" : "s"} ` +
    `where the truck did not leave the shop on time.`);

  const missed = bad.filter(i => /call off|no call no show/i.test(i.reason));
  const noShow = bad.filter(i => /no call no show/i.test(i.reason));
  if (missed.length) {
    out.push(`${missed.length} shift${missed.length === 1 ? "" : "s"} missed` +
      (noShow.length ? `, ${noShow.length} of them without any notice at all` : " at short notice") + ".");
  }

  const reached = bad.filter(i => /claim|complaint/i.test(i.reason));
  if (reached.length) {
    out.push(`${reached.length} incident${reached.length === 1 ? "" : "s"} that reached a customer ` +
      `as a complaint or a claim.`);
  }
  out.push(...claimLines(claims));
  return out;
}

/* The handbook section each violation sits under. Employee Handbook, updated
   7 October 2026. The old form asked "what was the rule, policy, law, standard
   or regulation that was violated?" and the first redesign answered it with a
   core value, which is the spirit but not the rule. Both belong on the page.

   Andrew's note when he sent it: section 7.2 is out of date, so nothing here
   points at it. */
export const POLICY_LIBRARY = [
  [/late|not out by shop|truck not out|call off|no call no show/i,
   ["7.1 Attendance & Punctuality",
    "Employees are expected to be in the workplace, ready to work, at their scheduled start time and to complete their entire shift. Time off must be requested in writing, in advance, and anyone unexpectedly unable to report must notify their supervisor directly and as early as possible. A voicemail, text or email is not acceptable except in an extreme emergency."]],
  [/vap|smok/i,
   ["6.12 Smoking, with 6.1 Standards of Conduct", null]],
  [/restock|cleanliness|pads|equipment|material|not removed from truck|fuel/i,
   ["6.10 Use of Company Property, with 6.15 Company Supplies", null]],
  [/claim|complaint|walkthrough|inspection|policy violation/i,
   ["6.1 Standards of Conduct", null]]
];

export function policyFor(incidents) {
  const bad = incidents.filter(i => i.delta < 0);
  if (!bad.length) return ["6.1 Standards of Conduct", null];
  const worst = Math.min(...bad.map(i => i.delta));
  const reason = bad.find(i => i.delta === worst).reason;
  return (POLICY_LIBRARY.find(([re]) => re.test(reason)) ?? [, ["6.1 Standards of Conduct", null]])[1];
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

/**
 * The incidents table.
 *
 * Fifteen dated lines is a page on its own, which is what pushed Jayson's
 * notice to five. Past six incidents the rows run in two columns instead, so
 * the list takes half the height at the same type size. Below that it stays a
 * single column, where splitting would just look like padding.
 *
 * Six, not ten: nine rows in one column turned out to be taller than fifteen
 * in two, which is how an eight-incident notice ran longer than Jayson's.
 */
function incidentTable(incidents, lostSigned) {
  const row = i =>
    `<tr><td>${day(i.date)}</td><td>${esc(i.reason)}</td>` +
    `<td class="n pts">${i.delta > 0 ? "+" : "−"}${Math.abs(i.delta)}</td></tr>`;
  const head = '<thead><tr><th style="width:110px">Date</th><th>What happened</th>' +
               '<th class="n" style="width:46px">Pts</th></tr></thead>';
  const table = rows => `<table>${head}<tbody>${rows.map(row).join("")}</tbody></table>`;

  if (incidents.length <= 6) {
    return "  " + table(incidents).replace("</table>",
      `<tfoot><tr><td colspan="2">Total lost in this period</td>` +
      `<td class="n">${lostSigned}</td></tr></tfoot></table>`);
  }
  const half = Math.ceil(incidents.length / 2);
  return `  <div class="cols2">${table(incidents.slice(0, half))}` +
         `${table(incidents.slice(half))}</div>
` +
         `  <div class="ttot"><span>Total lost in this period</span><span>${lostSigned}</span></div>`;
}

/* The supervisor's three boxes, as the generator worked them out. In a flat
   PDF they are printed. In a fillable one they are the starting text of a
   form field, which is the same words in a place Matthew can correct them. */
export function fieldValues(data) {
  return {
    prior: data.prior ?? "",
    required: data.required ?? "",
    supervisor_comments: data.comments ?? "",
    employee_comments: ""
  };
}

export function fill(data, opts = {}) {
  const html = readFileSync(TEMPLATE, "utf8");
  /* Fillable: the three boxes print empty, because their words arrive as form
     field values instead. Printing them as well would show every line twice. */
  const editable = opts.fillable === true;
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
    IMPACT_ROWS: impactNarrative(data.incidents).map(([reason, text]) =>
      `    <div class="imp"><span class="ik">${esc(reason)}</span><p>${esc(text)}</p></div>`).join("\n"),
    RECORD_ROWS: recordShows(data.incidents, data.claims)
      .map(t => `    <li>${esc(t)}</li>`).join("\n") || "    <li>No countable pattern in the record.</li>",
    ACTUAL: esc(data.actual ?? ""),
    ACTUAL_CLS: data.actual ? "prefill" : "",
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
    INCIDENT_TABLE: incidentTable(data.incidents, "−" + String(Math.abs(lost))),
    POLICY_REF: esc(policyFor(data.incidents)[0]),
    POLICY_TEXT: policyFor(data.incidents)[1]
      ? `<p class="polq">${esc(policyFor(data.incidents)[1])}</p>` : "",
    VALUE_NAME: vName,
    VALUE_TEXT: esc(vText),
    PRIOR: editable ? "" : esc(data.prior ?? ""),
    REQUIRED: editable ? "" : esc(data.required ?? ""),
    SUPERVISOR_COMMENTS: editable ? "" : esc(data.comments ?? ""),
    /* The ruled background is there to be written on. Where the system has
       already filled the box the rules run straight through the words, so
       they come off and the box is just a box. A fillable box keeps its full
       height whatever is in it, because somebody is about to type there. */
    PRIOR_CLS:    !editable && data.prior    ? "prefill" : "",
    REQUIRED_CLS: !editable && data.required ? "prefill" : "",
    COMMENTS_CLS: !editable && data.comments ? "prefill" : ""
  };

  let out = editable ? html.replace("<body>", '<body class="fillable">') : html;
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
    claims: [{ date: "2026-09-27", job_number: "10659", amount: 550,
                reason: "Floor damage", onCrew: true }],
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
    claims: [{ date: "2026-09-27", job_number: "10659", amount: 550,
                reason: "Floor damage", onCrew: true },
              { date: "2026-09-27", job_number: "10659", amount: 140.40,
                reason: "Cabinet foot broke", onCrew: true }],
    prior: "Written warning issued 19 September 2026 after reaching 15 points. "
      + "Verbal 2 September about calling off without notice.",
    required: "Return from suspension able to be relied on: at the shop on time, every "
      + "shift, and a phone call to Matthew before the start of any shift you cannot make. "
      + "Nothing about a customer job is to reach Andrew before it reaches Matthew."
  }
};

/* --fillable writes the version whose supervisor boxes become PDF form
   fields, alongside the words that belong in them. make-fillable.mjs reads
   both. */
const FILLABLE = process.argv.includes("--fillable");
const nameFor = file => FILLABLE ? file.replace(/\.html$/, ".fillable.html") : file;

for (const key of Object.keys(EXAMPLES)) {
  if (!process.argv.includes("--" + key) && !process.argv.includes("--examples")) continue;
  const e = EXAMPLES[key];
  const data = { ...e, value: valueFor(e.incidents) };
  const html = fill(data, { fillable: FILLABLE });
  const out = join(here, nameFor(e.file));
  writeFileSync(out, html);
  if (FILLABLE) {
    writeFileSync(out.replace(/\.html$/, ".fields.json"),
                  JSON.stringify(fieldValues(data), null, 2));
  }
  const lost = Math.abs(e.incidents.reduce((a, i) => a + Math.min(0, i.delta), 0));
  console.log(`${nameFor(e.file)}  ${e.incidents.length} incidents, ${lost} points lost, value: ${valueFor(e.incidents)}`);
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
