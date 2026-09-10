/* August 2026, on Andrew's own numbers (his sheet dated 8/31/2026).

   Andrew asked to see how the new calculation lines up with the old one, and
   whether it favours the top performers and is fair. His Attendance column is
   used as points; anyone on his list who is not on our roster is skipped.

     node scripts/demo-august.js            compare only — writes nothing
     node scripts/demo-august.js load       put the figures into August for the demo
     node scripts/demo-august.js remove     take every demo row back out

   Everything written is tagged recorded_by = 'demo', so remove is exact.
   August is before the programme start, so none of this reaches a real
   payout or anyone's year to date. */

import { computeSplit, monthly, RULES } from "../src/calc.js";
import { query, withTransaction, close, loadEnv } from "../src/db.js";

loadEnv();

const PERIOD = "2026-08-01";
const ON = "2026-08-31";
/* Point rows go on the 1st. The discipline window is 60 days, so a row on the
   31st would reach into September's standing on any server still running code
   without the demo exclusion in calc.js. On the 1st it reaches no live month. */
const POINTS_ON = "2026-08-01";
const TAG = "demo";
const SOURCE = "Andrew's sheet 8/31/2026";

/* name, attendance (used as points), reviews, hours */
const SHEET = [
  ["Jacob Byer",        7, 12, 200.70],
  ["Adam Fredenburg",   5, 12, 186.75],
  ["Ethan Garcia",     10, 13, 218.70],
  ["Craig Hawkins",    15,  4, 125.53],
  ["Tyler Johnston",   12,  5, 245.17],
  ["Jeffrey Martin",    6,  8, 207.05],
  ["Jayson Murphy",     3, 14, 236.54],
  ["Joshua Pama",       4, 10, 122.64],
  ["Julio Rodriguez",   5,  6, 156.44],
  ["Aaron Schwark",     4, 10, 205.59],
  ["Josh Trim",        11, 15, 146.93],
  ["Jordan Walker",     7,  3, 156.80],
  ["Blade Williams",   15,  0,  13.48]
];
/* on Andrew's list, not on our roster — skipped as he asked */
const SKIPPED = ["Bruce", "Daniel Fredenburg", "Jawuan Gaines", "Tyler Hansel",
                 "Nathan Lulinski", "Luke Ruminski"];

const mode = process.argv[2] ?? "compare";
const money = n => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function roster() {
  const rows = (await query(
    `select id, code_name, full_name from employees where is_mover and status <> 'left'`)).rows;
  const byName = new Map(rows.map(r => [r.full_name.toLowerCase(), r]));
  const people = SHEET.map(([name, attendance, reviews, hours]) => {
    const e = byName.get(name.toLowerCase());
    if (!e) throw new Error(`${name} is not on the roster — check the spelling`);
    return { ...e, attendance, reviews, hours };
  });
  return people;
}

async function revenueAndClaims() {
  const rev = (await query(
    `select completed_revenue::float8 as completed_revenue, completed_jobs
       from revenue_snapshots where period = $1 order by captured_at desc limit 1`, [PERIOD])).rows[0];
  if (!rev) throw new Error("no August revenue on record");
  const claims = (await query(
    `select coalesce(sum(amount),0)::float8 as total, count(*)::int as n
       from claims where date_trunc('month', occurred_on) = $1::date`, [PERIOD])).rows[0];
  return { rev, claims };
}

/* The old calculator, as its formulas actually read in the "Revenue Share
   Calculations" tab: pool = revenue x 2% - claims; 60% by share of points,
   40% by share of reviews; everyone listed shares; hours are not considered. */
function oldWay(people, pool) {
  const pts = people.reduce((a, p) => a + p.attendance, 0);
  const rvw = people.reduce((a, p) => a + p.reviews, 0);
  return new Map(people.map(p => [p.id,
    (pts ? p.attendance / pts : 0) * pool * RULES.pointsShare +
    (rvw ? p.reviews / rvw : 0) * pool * (1 - RULES.pointsShare)]));
}

function newWay(people, rev, claims) {
  return computeSplit({
    revenue: rev, claims,
    settings: { hours_gate_waived: false },
    people: people.map(p => ({
      id: p.id, code_name: p.code_name, full_name: p.full_name, status: "active",
      hours: p.hours, point_delta: p.attendance - RULES.startPoints,
      review_points: p.reviews, bonuses: 0, deductions: 0, discipline_lost: 0
    }))
  });
}

async function compare() {
  const people = await roster();
  const { rev, claims } = await revenueAndClaims();
  const result = newWay(people, rev, claims);
  const old = oldWay(people, result.pool);

  console.log(`\nAUGUST 2026 — Andrew's figures, attendance used as points`);
  console.log(`revenue ${money(rev.completed_revenue)} (${rev.completed_jobs} jobs)  ` +
              `claims ${money(claims.total)}  pool ${money(result.pool)}`);
  console.log(`skipped (not on roster): ${SKIPPED.join(", ")}\n`);

  const rows = people.map(p => {
    const n = result.rows.find(r => r.employee_id === p.id);
    const o = Math.round(old.get(p.id) * 100) / 100;
    return { ...p, old: o, now: n.take_home, paid: n.paid, reason: n.reason };
  }).sort((a, b) => b.now - a.now || b.old - a.old);

  const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);
  console.log(pad("", 18) + lpad("pts", 4) + lpad("rev", 5) + lpad("hours", 8) +
              lpad("old way", 11) + lpad("new way", 11) + lpad("change", 10) + lpad("new $/hr", 10));
  for (const r of rows) {
    const d = r.now - r.old;
    console.log(pad(r.full_name, 18) + lpad(r.attendance, 4) + lpad(r.reviews, 5) +
      lpad(r.hours.toFixed(2), 8) + lpad(money(r.old), 11) + lpad(money(r.now), 11) +
      lpad((d >= 0 ? "+" : "-") + money(Math.abs(d)).slice(1), 10) +
      lpad(r.paid ? money(r.now / r.hours) : "—", 10) +
      (r.paid ? "" : `   ${r.reason}`));
  }
  const tot = k => rows.reduce((a, r) => a + r[k], 0);
  console.log(pad("TOTAL", 35) + lpad(money(tot("old")), 11) + lpad(money(tot("now")), 11));
  console.log(`\nnew way unallocated: ${money(result.unallocated)}`);
  return { rows, result };
}

async function removeDemo(c) {
  const r1 = await c.query(`delete from point_events where recorded_by = $1 and date_trunc('month', occurred_on) = $2::date`, [TAG, PERIOD]);
  const r2 = await c.query(`delete from reviews where recorded_by = $1 and date_trunc('month', occurred_on) = $2::date`, [TAG, PERIOD]);
  const r3 = await c.query(`delete from hours where recorded_by = $1 and period = $2::date`, [TAG, PERIOD]);
  return { points: r1.rowCount, reviews: r2.rowCount, hours: r3.rowCount };
}

async function load() {
  const people = await roster();
  await withTransaction(async c => {
    await removeDemo(c);   // re-running replaces rather than stacking
    for (const p of people) {
      /* points are 15 plus the month's events, so one event brings each person
         to exactly Andrew's attendance figure, net of the same-day points the
         system already logged */
      const have = (await c.query(
        `select coalesce(sum(delta),0)::int as d from point_events
          where employee_id = $1 and date_trunc('month', occurred_on) = $2::date`,
        [p.id, PERIOD])).rows[0].d;
      const delta = p.attendance - (RULES.startPoints + have);
      if (delta !== 0) {
        await c.query(
          `insert into point_events (employee_id, occurred_on, delta, reason, recorded_by)
           values ($1, $2, $3, $4, $5)`,
          [p.id, POINTS_ON, delta, `Set to attendance ${p.attendance} (${SOURCE})`, TAG]);
      }
      if (p.reviews > 0) {
        const id = (await c.query(
          `insert into reviews (occurred_on, customer_name, source, has_photo, points, recorded_by)
           values ($1, $2, $3, false, $4, $5) returning id`,
          [ON, `${p.reviews} reviews for the month`, SOURCE, p.reviews, TAG])).rows[0].id;
        await c.query(`insert into review_credits (review_id, employee_id) values ($1, $2)`, [id, p.id]);
      }
      await c.query(
        `insert into hours (employee_id, period, hours, recorded_by) values ($1, $2, $3, $4)
         on conflict (employee_id, period) do update
           set hours = excluded.hours, recorded_by = excluded.recorded_by, updated_at = now()`,
        [p.id, PERIOD, p.hours, TAG]);
    }
  });

  /* the live calculation must now say exactly what the comparison said */
  const { rows } = await compare();
  const live = await monthly(2026, 8);
  let bad = 0;
  for (const r of rows) {
    const l = live.rows.find(x => x.employee_id === r.id);
    const ok = l && l.points === r.attendance && l.review_points === r.reviews &&
               Math.abs(l.hours - r.hours) < 0.005 && Math.abs(l.take_home - r.now) < 0.01 &&
               l.standing === "clear";
    if (!ok) { bad++; console.log(`  MISMATCH ${r.full_name}`, l && { pts: l.points, rev: l.review_points, hrs: l.hours, $: l.take_home, standing: l.standing }); }
  }
  console.log(bad ? `\n${bad} MISMATCH(ES) in the live figures` : `\nlive August matches the comparison for all ${rows.length}`);
  return bad;
}

try {
  if (mode === "compare") await compare();
  else if (mode === "load") process.exitCode = (await load()) ? 1 : 0;
  else if (mode === "remove") {
    const n = await withTransaction(c => removeDemo(c));
    console.log(`removed demo rows — points ${n.points}, reviews ${n.reviews}, hours ${n.hours}`);
  } else throw new Error(`unknown mode "${mode}" — compare, load or remove`);
} finally {
  await close();
}
