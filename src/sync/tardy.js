/* Matthew's tardy log, turned into point deductions.
 *
 * Matthew keeps one tab per month for lateness and one for trucks that left
 * the shop late: a row per mover, a column per date, minutes late in the cell,
 * or "CALL OFF". The rules, as Matthew and Andrew set them (14 September):
 *
 *   late                 graded on the minutes, see latePenalty below
 *   truck not out   -1   each name listed for that day
 *   call off        -2
 *   same day call off -3
 *
 * Andrew graded lateness on 28 September 2026. Until then anything Matthew
 * logged cost a flat -1, so a minute late and an hour late were the same
 * thing. A single minute now costs nothing at all and no entry is written
 * for it, which is what "1 min = nothing" has to mean for the crew to
 * believe it.
 *
 * Trucks not out on time are still a flat -1 — Andrew graded tardies, and
 * grading trucks too would quietly change what people lose. Worth asking.
 *
 * Late and a late truck on the same day are two entries, so -2 — which is
 * what Matthew asked for.
 *
 * Like same-day points, these are derived rather than typed: every run
 * rebuilds the month's tardy-log entries from the sheet, so correcting a cell
 * corrects the points, and nothing is counted twice.
 */

import { withTransaction } from "../db.js";
import { matchableRoster, ignoredNames } from "../roster.js";
import { nameMatcher } from "./hours.js";

export const TAG = "tardy-log";
export const PENALTY = { truck: -1, calloff: -2, samedaycalloff: -3 };

/**
 * Minutes late → points. Andrew's bands, 28 September 2026:
 *   1 minute        nothing
 *   2 to 30         -1
 *   31 to 60        -2
 *   61 and over     -3
 * Anything that scores nothing is never written down, so a one-minute late
 * leaves no entry on anyone's ledger rather than a puzzling zero.
 */
export function latePenalty(minutes) {
  if (!(minutes >= 2)) return 0;
  if (minutes <= 30) return -1;
  if (minutes <= 60) return -2;
  return -3;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
                "august", "september", "october", "november", "december"];
const pad = n => String(n).padStart(2, "0");
const text = v => String(v ?? "").trim();

/** Which log a tab holds, for this month — or null. Tab names get cut short
    ("September Trucks not out in tim"), so only the key word is looked for. */
export function classifyTab(title, month) {
  const t = text(title).toLowerCase();
  if (!t.includes(MONTHS[month - 1])) return null;
  if (/truck/.test(t)) return "truck";
  if (/tard|late|call/.test(t)) return "late";
  return null;
}

/**
 * One tab's grid → entries. A structural problem (no header, no dates for the
 * month) is returned as `problem`, so the caller can refuse to touch the
 * database rather than wipe a month because a column got renamed.
 */
export function parseLogGrid(grid, { kind, year, month }) {
  const out = { entries: [], warnings: [], problem: null };
  const h = grid.findIndex(r => /^employee$/i.test(text(r?.[0])));
  if (h < 0) { out.problem = "no \"Employee\" header row"; return out; }

  const cols = [];
  grid[h].forEach((c, i) => {
    if (i === 0) return;
    const m = text(c).match(/^(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?$/);
    if (m && Number(m[1]) === month && Number(m[2]) >= 1 && Number(m[2]) <= 31) {
      cols.push({ i, day: Number(m[2]) });
    }
  });
  if (!cols.length) { out.problem = `no ${MONTHS[month - 1]} date columns`; return out; }

  for (const row of grid.slice(h + 1)) {
    const name = text(row?.[0]);
    if (!name) continue;
    if (/^(daily|total|enter)/i.test(name)) break;       // totals and the instructions line

    for (const { i, day } of cols) {
      const v = text(row[i]);
      if (!v || v === "0") continue;
      const date = `${year}-${pad(month)}-${pad(day)}`;
      /* "same day" has to be looked for first — it contains "call off" */
      if (/same\s*-?\s*day.*call\s*-?\s*off/i.test(v)) {
        out.entries.push({ name, date, type: "samedaycalloff" });
      } else if (/call\s*-?\s*off/i.test(v)) {
        out.entries.push({ name, date, type: "calloff" });
      } else if (/^\d+(\.\d+)?$/.test(v) && Number(v) > 0) {
        out.entries.push({ name, date, type: kind, minutes: Number(v) });
      } else {
        out.warnings.push(`${name} on ${month}/${day}: couldn't read "${v}"`);
      }
    }
  }
  return out;
}

/** Entries → point events for people on the roster. */
export function toEvents(entries, roster) {
  const match = nameMatcher(roster);
  const events = [], unmatched = new Set();

  /* One absence is one deduction. A call off can appear in both tabs, and the
     same one may be written plainly in one and as a same-day in the other, so
     they are collected per person per date and the worse wording wins. */
  const callOffs = new Map();

  for (const e of entries) {
    const who = match(e.name);
    if (!who) { unmatched.add(e.name); continue; }

    if (e.type === "calloff" || e.type === "samedaycalloff") {
      const key  = `${who.id}|${e.date}`;
      const seen = callOffs.get(key);
      if (!seen || PENALTY[e.type] < PENALTY[seen.type]) {
        callOffs.set(key, { who, date: e.date, type: e.type });
      }
      continue;
    }

    /* graded: a minute late costs nothing, so nothing is written down */
    const delta = e.type === "late" ? latePenalty(e.minutes) : PENALTY[e.type];
    if (delta === 0) continue;

    events.push({
      employee_id: who.id,
      full_name:   who.full_name,
      occurred_on: e.date,
      type:        e.type,
      delta,
      reason: e.type === "truck" ? `Truck not out on time — ${e.minutes} min (tardy log)`
            :                      `Late — ${e.minutes} min (tardy log)`
    });
  }

  for (const c of callOffs.values()) {
    events.push({
      employee_id: c.who.id,
      full_name:   c.who.full_name,
      occurred_on: c.date,
      type:        c.type,
      delta:       PENALTY[c.type],
      reason: c.type === "samedaycalloff" ? "Same day call off (tardy log)"
            :                               "Call off (tardy log)"
    });
  }
  return { events, unmatched: [...unmatched] };
}

/** Replace the month's tardy-log entries with these. Nothing else is touched. */
export async function applyEvents(events, period) {
  await withTransaction(async c => {
    await c.query(
      `delete from point_events
        where recorded_by = $1 and date_trunc('month', occurred_on) = $2::date`,
      [TAG, period]);
    for (const e of events) {
      await c.query(
        `insert into point_events (employee_id, occurred_on, delta, reason, recorded_by)
         values ($1, $2, $3, $4, $5)`,
        [e.employee_id, e.occurred_on, e.delta, e.reason, TAG]);
    }
  });
}

export function summarise({ period, events, unmatched, pastCrew = [], warnings }) {
  const [, m] = period.split("-").map(Number);
  const n = t => events.filter(e => e.type === t).length;
  const people = new Set(events.map(e => e.employee_id)).size;
  const total = events.reduce((a, e) => a + e.delta, 0);
  let s = `${MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1)}: ` +
          `${n("late")} late, ${n("truck")} trucks late, ${n("calloff")} call off${n("calloff") === 1 ? "" : "s"}` +
          (n("samedaycalloff") ? `, ${n("samedaycalloff")} same day` : "") +
          ` → ${total} points across ${people} ${people === 1 ? "person" : "people"}`;
  if (unmatched.length) s += `; NOT MATCHED: ${unmatched.join(", ")}`;
  if (pastCrew.length) s += `; past crew, no points: ${pastCrew.join(", ")}`;
  if (warnings.length) s += `; couldn't read: ${warnings.slice(0, 5).join("; ")}`;
  return s;
}

/** Parsed entries → the database, for one month. Shared by the sync and the loader. */
export async function loadEntries(entries, { period, warnings = [], dryRun = false }) {
  const roster = await matchableRoster(period);
  const { events, unmatched: allUnmatched } = toEvents(entries, roster);
  if (!dryRun) await applyEvents(events, period);

  /* names known to belong to nobody on the programme — see db/007 */
  const isIgnored = await ignoredNames();
  const unmatched = allUnmatched.filter(n => !isIgnored(n));
  const pastCrew  = allUnmatched.filter(isIgnored);

  return { period, events, unmatched, pastCrew, warnings,
           summary: summarise({ period, events, unmatched, pastCrew, warnings }) };
}

/** The scheduled run: read this month's tabs from the Google Sheet and apply them. */
export async function importTardies(google, sheetId, { period, dryRun = false }) {
  const [year, month] = period.split("-").map(Number);
  const info = await google.info(sheetId);
  const tabs = info.tabs
    .map(t => ({ title: t.title, kind: classifyTab(t.title, month) }))
    .filter(t => t.kind);

  if (!tabs.length) {
    return { period, tabs: [], events: [], unmatched: [], warnings: [],
             summary: `no ${MONTHS[month - 1]} tabs in the tardy log yet — nothing changed` };
  }

  const entries = [], warnings = [];
  for (const t of tabs) {
    const grid = await google.read(sheetId, `'${t.title.replace(/'/g, "''")}'!A1:AN80`);
    const r = parseLogGrid(grid, { kind: t.kind, year, month });
    if (r.problem) {
      /* refuse loudly: rebuilding from a tab we can't read would wipe the month */
      throw new Error(`tardy log tab "${t.title}" has ${r.problem} — nothing changed`);
    }
    entries.push(...r.entries);
    warnings.push(...r.warnings);
  }
  const out = await loadEntries(entries, { period, warnings, dryRun });
  return { ...out, tabs: tabs.map(t => t.title) };
}
