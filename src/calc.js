/* The calculation engine.
 *
 * Everything here is derived at read time from the dated rows in the database.
 * Nothing is stored back until a month is locked, so a figure on the TV can
 * never drift away from the events that produced it.
 *
 * The one subtle part is forfeit-and-redistribute. When someone walks off
 * without two weeks notice they lose their share and it goes to the crew who
 * picked up the slack. That means two splits get calculated:
 *
 *   pass A — includes the leaver, and tells us what they WOULD have earned.
 *            That is the red number on the TV.
 *   pass B — excludes them, and is what actually pays. Everyone else's share
 *            rises to absorb the gap, so the pool always pays out in full.
 */

import { query } from "./db.js";

export const RULES = {
  commissionRate: 0.02,      // 2% of completed revenue
  pointsShare:    0.60,      // 60 / 40 split, points / reviews
  startPoints:    15,        // everyone begins each month here
  minHours:       75,        // eligibility gate
  disciplineDays: 60,        // rolling window
  warnAt:         15,
  suspendAt:      30,
  terminateAt:    45
};

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const periodOf = (y, m) => `${y}-${String(m).padStart(2, "0")}-01`;

/* ------------------------------------------------------------ gathering ---- */

async function gather(period) {
  /* the most recent report reading for the month */
  const revenue = await query(
    `select completed_revenue, completed_jobs, captured_at
       from revenue_snapshots
      where period = $1
      order by captured_at desc
      limit 1`, [period]);

  const claims = await query(
    `select coalesce(sum(amount), 0)::float8 as total, count(*)::int as n
       from claims
      where date_trunc('month', occurred_on) = $1::date`, [period]);

  /* one row per employee with everything they earned this month */
  const people = await query(
    `select e.id, e.code_name, e.full_name, e.status, e.sm_crew_id,

            coalesce(h.hours, 0)::float8 as hours,

            coalesce((select sum(pe.delta) from point_events pe
                       where pe.employee_id = e.id
                         and date_trunc('month', pe.occurred_on) = $1::date), 0)::int
              as point_delta,

            coalesce((select sum(r.points) from review_credits rc
                        join reviews r on r.id = rc.review_id
                       where rc.employee_id = e.id
                         and date_trunc('month', r.occurred_on) = $1::date), 0)::int
              as review_points,

            coalesce((select sum(a.amount) from adjustments a
                       where a.employee_id = e.id and a.kind = 'bonus'
                         and date_trunc('month', a.occurred_on) = $1::date), 0)::float8
              as bonuses,

            coalesce((select sum(a.amount) from adjustments a
                       where a.employee_id = e.id and a.kind = 'deduction'
                         and date_trunc('month', a.occurred_on) = $1::date), 0)::float8
              as deductions,

            coalesce((select -sum(pe.delta) from point_events pe
                       where pe.employee_id = e.id and pe.delta < 0
                         and pe.occurred_on > ($1::date + interval '1 month' - ($2 || ' days')::interval)
                         and pe.occurred_on < ($1::date + interval '1 month')), 0)::int
              as discipline_lost

       from employees e
       left join hours h on h.employee_id = e.id and h.period = $1::date
      where e.status <> 'left' and e.is_mover
      order by e.code_name`,
    [period, RULES.disciplineDays]);

  const settings = await query(
    `select hours_gate_waived, note from month_settings where period = $1::date`, [period]);

  return {
    revenue:  revenue.rows[0] ?? null,
    claims:   claims.rows[0],
    people:   people.rows,
    settings: settings.rows[0] ?? { hours_gate_waived: false, note: null }
  };
}

/* ------------------------------------------------------------ the split ---- */

export function computeSplit(raw, rules = RULES) {
  const revenue    = Number(raw.revenue?.completed_revenue ?? 0);
  const claimTotal = Number(raw.claims?.total ?? 0);

  const commission = revenue * rules.commissionRate;
  const pool       = Math.max(0, commission - claimTotal);
  const pointsPool = pool * rules.pointsShare;
  const reviewPool = pool * (1 - rules.pointsShare);

  /* A waived month lets everyone on the roster share regardless of hours. The
     roster is built from people who actually worked jobs, so this never pays
     someone who was not there. */
  const waived = !!raw.settings?.hours_gate_waived;

  /* shape each person before any money is assigned */
  const rows = raw.people.map(p => {
    const points  = Math.max(0, rules.startPoints + Number(p.point_delta));
    const hoursOK = waived || Number(p.hours) >= rules.minHours;
    return {
      employee_id: p.id,
      code_name:   p.code_name,
      full_name:   p.full_name,
      status:      p.status,
      hours:       Number(p.hours),
      points,
      review_points: Number(p.review_points),
      bonuses:       Number(p.bonuses),
      deductions:    Number(p.deductions),
      discipline_lost: Number(p.discipline_lost),
      hours_ok: hoursOK,
      paid:     hoursOK && p.status === "active",
      forfeits: hoursOK && p.status === "no_notice"
    };
  });

  /* two denominators — see the note at the top of the file */
  const denomA = { points: 0, reviews: 0 };   // everyone who cleared the hours gate
  const denomB = { points: 0, reviews: 0 };   // only those actually being paid
  for (const r of rows) {
    if (!r.hours_ok) continue;
    denomA.points  += r.points;
    denomA.reviews += r.review_points;
    if (r.paid) {
      denomB.points  += r.points;
      denomB.reviews += r.review_points;
    }
  }

  let forfeited = 0;
  for (const r of rows) {
    r.points_amount  = 0;
    r.reviews_amount = 0;
    r.forfeited      = 0;

    if (r.paid) {
      r.points_amount  = denomB.points  ? (r.points / denomB.points) * pointsPool : 0;
      r.reviews_amount = denomB.reviews ? (r.review_points / denomB.reviews) * reviewPool : 0;
    } else if (r.forfeits) {
      const wouldPoints  = denomA.points  ? (r.points / denomA.points) * pointsPool : 0;
      const wouldReviews = denomA.reviews ? (r.review_points / denomA.reviews) * reviewPool : 0;
      r.forfeited = wouldPoints + wouldReviews;
      forfeited  += r.forfeited;
    }

    r.share     = r.points_amount + r.reviews_amount;
    r.take_home = r.share + r.bonuses - r.deductions;

    r.points_pct  = denomB.points  ? r.points / denomB.points : 0;
    r.reviews_pct = denomB.reviews ? r.review_points / denomB.reviews : 0;

    r.standing =
      r.discipline_lost >= rules.terminateAt ? "termination"
      : r.discipline_lost >= rules.suspendAt ? "suspension"
      : r.discipline_lost >= rules.warnAt    ? "warning"
      : "clear";

    /* why someone is not being paid, in words the report can print */
    r.reason = r.paid ? null
      : r.forfeits ? "no two weeks notice — share forfeited"
      : waived ? "not sharing this month"
      : `${round2(rules.minHours - r.hours)} hours short of the ${rules.minHours}-hour minimum`;

    for (const k of ["points_amount", "reviews_amount", "forfeited", "share", "take_home", "bonuses", "deductions"]) {
      r[k] = round2(r[k]);
    }
  }

  const paid = rows.filter(r => r.paid);
  const allocated = paid.reduce((a, r) => a + r.share, 0);

  /* Half the pool can have nobody to go to. If no reviews have been logged yet
     the 40% side has a denominator of zero, so it pays nothing and the pool
     does not fully clear. Same on the points side if everyone is on zero.

     Andrew's rule (10 September): it stays unallocated through the month —
     people are still qualifying, and most months it will find someone before
     the 30th. Whatever is still unallocated when the month closes stays with
     the company. So this is never redistributed and never quietly rounded
     away; it is reported every day so the figure is visible while there is
     still time for someone to earn it. */
  const unallocated = Math.max(0, pool - allocated);
  const unallocatedWhy = [];
  if (unallocated > 0.01) {
    if (!denomB.points)  unallocatedWhy.push("no points to share against");
    if (!denomB.reviews) unallocatedWhy.push("no review points recorded this month");
    if (!paid.length)    unallocatedWhy.push("nobody has cleared the hours gate");
  }

  return {
    revenue:      round2(revenue),
    completed_jobs: raw.revenue?.completed_jobs ?? null,
    captured_at:  raw.revenue?.captured_at ?? null,
    commission:   round2(commission),
    claims_total: round2(claimTotal),
    claims_count: raw.claims?.n ?? 0,
    pool:         round2(pool),
    points_pool:  round2(pointsPool),
    reviews_pool: round2(reviewPool),
    forfeited:    round2(forfeited),
    allocated:       round2(allocated),
    unallocated:     round2(unallocated),
    unallocated_why: unallocatedWhy,
    totals: {
      points:  denomB.points,
      reviews: denomB.reviews,
      paid_out: round2(allocated),
      take_home: round2(rows.reduce((a, r) => a + r.take_home, 0))
    },
    counts: {
      roster:    rows.length,
      qualified: paid.length,
      forfeited: rows.filter(r => r.forfeits).length,
      short:     rows.filter(r => !r.hours_ok).length
    },
    hours_gate_waived: waived,
    settings_note:     raw.settings?.note ?? null,
    hours_entered:     rows.filter(r => r.hours > 0).length,
    rows
  };
}

/* ------------------------------------------------------------- ordering ---- */

/** Paid first, then anyone who forfeited, then anyone short on hours. */
export function rank(rows, key = "share") {
  const tier = r => (r.paid ? 0 : r.forfeits ? 1 : 2);
  return rows.slice().sort((a, b) =>
    tier(a) - tier(b) || (b[key] - a[key]) || (b.share - a.share));
}

/* ---------------------------------------------------------------- entry ---- */

export async function monthly(year, month) {
  const period = periodOf(year, month);
  const raw = await gather(period);
  return { period, ...computeSplit(raw) };
}

/* ------------------------------------------------------------------ YTD ---- */

/*
 * Year to date means since the programme started, not since 1 January.
 *
 * The share began in September 2026. January to August had revenue but no
 * pool — nobody was owed anything — so counting those months would show the
 * crew a "year to date pool" of money that never existed for them. From 2027
 * onward the two definitions agree and YTD is simply January to now.
 */
export const PROGRAM_START = process.env.PROGRAM_START || "2026-09-01";

export function ytdMonths(year, month) {
  const [sy, sm] = PROGRAM_START.split("-").map(Number);
  let from;
  if (year > sy) from = 1;
  else if (year === sy) from = sm;
  else return [];                                  // before the programme existed
  const out = [];
  for (let m = from; m <= month; m++) out.push({ year, month: m });
  return out;
}

/**
 * Every month from the start of the programme year to the one asked for,
 * worked out separately and then added up.
 *
 * It has to be month by month. Each month has its own pool, its own hours gate
 * and its own crew — someone can qualify in September and not in October — so
 * a year's take-home is the sum of twelve splits, never one split over a year.
 */
export async function ytd(year, month) {
  const months = ytdMonths(year, month);
  const results = await Promise.all(months.map(m => monthly(m.year, m.month)));

  const totals = { revenue: 0, pool: 0, points_pool: 0, reviews_pool: 0, allocated: 0,
                   unallocated: 0, forfeited: 0, claims_total: 0, completed_jobs: 0, take_home: 0 };
  const people = new Map();

  for (const r of results) {
    for (const k of ["revenue", "pool", "points_pool", "reviews_pool", "allocated",
                     "unallocated", "forfeited", "claims_total"]) totals[k] += Number(r[k]) || 0;
    totals.completed_jobs += Number(r.completed_jobs) || 0;
    totals.take_home += Number(r.totals.take_home) || 0;

    for (const p of r.rows) {
      const e = people.get(p.employee_id) ?? {
        employee_id: p.employee_id, code_name: p.code_name, full_name: p.full_name,
        points_amount: 0, reviews_amount: 0, share: 0, bonuses: 0, deductions: 0,
        take_home: 0, forfeited: 0, review_points: 0, hours: 0,
        months_paid: 0, months_on_roster: 0, months: []
      };
      for (const k of ["points_amount", "reviews_amount", "share", "bonuses", "deductions",
                       "take_home", "forfeited", "review_points", "hours"]) e[k] += Number(p[k]) || 0;
      e.months_on_roster++;
      if (p.paid) e.months_paid++;
      e.months.push({ period: r.period, take_home: p.take_home, share: p.share,
                      paid: p.paid, forfeits: p.forfeits, hours: p.hours });
      people.set(p.employee_id, e);
    }
  }

  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);
  const rows = [...people.values()].map(e => {
    for (const k of ["points_amount", "reviews_amount", "share", "bonuses", "deductions",
                     "take_home", "forfeited", "hours"]) e[k] = round2(e[k]);
    return e;
  }).sort((a, b) => b.take_home - a.take_home);

  return {
    year, through: months.length ? `${year}-${String(month).padStart(2, "0")}` : null,
    program_start: PROGRAM_START,
    months: results.map(r => ({ period: r.period, pool: r.pool, allocated: r.allocated,
                                unallocated: r.unallocated, completed_jobs: r.completed_jobs })),
    totals, rows
  };
}

/** One person's detail, for their private report. */
export async function forEmployee(year, month, employeeId) {
  const result = await monthly(year, month);
  const me = result.rows.find(r => r.employee_id === employeeId);
  if (!me) return null;

  const period = periodOf(year, month);

  const ledger = await query(
    `select occurred_on, delta, reason, job_number
       from point_events
      where employee_id = $1 and date_trunc('month', occurred_on) = $2::date
      order by occurred_on, id`, [employeeId, period]);

  const reviews = await query(
    `select r.occurred_on, r.job_number, r.customer_name, r.source, r.points, r.has_photo
       from review_credits rc join reviews r on r.id = rc.review_id
      where rc.employee_id = $1 and date_trunc('month', r.occurred_on) = $2::date
      order by r.occurred_on`, [employeeId, period]);

  const adjustments = await query(
    `select occurred_on, kind, reason, amount
       from adjustments
      where employee_id = $1 and date_trunc('month', occurred_on) = $2::date
      order by occurred_on`, [employeeId, period]);

  return {
    period,
    pool: result.pool,
    points_pool: result.points_pool,
    reviews_pool: result.reviews_pool,
    ...me,
    ledger: ledger.rows,
    reviews: reviews.rows,
    adjustments: adjustments.rows
  };
}
