/* What each screen is allowed to see.
 *
 * The break-room TV is the one that matters here. It has no login — OptiSigns
 * just loads a URL — so its protection is that the page carries nothing worth
 * leaking. That is a property of THIS FILE, not of the template: if a real name
 * or a revenue figure is ever visible on the TV, the mistake will have been
 * made in boardView() below.
 *
 * So the board serialiser is written as an allow-list. It names every field it
 * emits. Adding a column to the calculation does not silently add it to the TV.
 */

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Year to date for the wall. The pool and how much of it went out — never the
 * revenue it came from. Andrew asked for revenue off the TV, and a YTD revenue
 * figure would put it straight back.
 */
function boardYtd(y) {
  if (!y || !y.months.length) return null;
  return {
    pool:      y.totals.pool,
    paid_out:  y.totals.allocated,
    months:    y.months.length,
    since:     y.program_start,
    through:   y.through
  };
}

/**
 * Break-room TV. Code names only, no revenue, no bonuses, no deductions.
 */
export function boardView(result, ytdResult = null) {
  return {
    period: result.period,
    ytd: boardYtd(ytdResult),

    /* the pool and its split — but NOT the revenue it came from */
    pool:         result.pool,
    points_pool:  result.points_pool,
    reviews_pool: result.reviews_pool,
    hours_pool:   result.hours_pool,
    weights:      result.weights,
    forfeited:    result.forfeited,

    /* a job count is safe and gives the crew something concrete */
    completed_jobs: result.completed_jobs,
    claims_total:   result.claims_total,
    claims_count:   result.claims_count,

    counts: result.counts,
    totals: { points: result.totals.points, reviews: result.totals.reviews, hours: result.totals.hours },

    crew: result.rows.map(r => ({
      code_name:     r.code_name,
      points:        r.points,
      review_points: r.review_points,
      hours:         r.hours,
      share:         r.share,
      points_amount: r.points_amount,
      reviews_amount: r.reviews_amount,
      hours_amount:  r.hours_amount,
      forfeited:     r.forfeited,
      paid:          r.paid,
      forfeits:      r.forfeits,
      hours_ok:      r.hours_ok,
      hours_needed:  r.hours_ok ? 0 : round2(75 - r.hours)
    })),

    generated_at: new Date().toISOString()
  };
}

/**
 * One person's private report. Their own real name, their own money, their own
 * ledger — and nobody else's figures at all.
 */
export function reportView(detail, ytdResult = null) {
  if (!detail) return null;
  const mine = ytdResult?.rows.find(r => r.employee_id === detail.employee_id) ?? null;
  return {
    period: detail.period,
    /* only this person's year, never anyone else's */
    ytd: mine ? {
      take_home:      mine.take_home,
      share:          mine.share,
      points_amount:  mine.points_amount,
      reviews_amount: mine.reviews_amount,
      hours_amount:   mine.hours_amount,
      bonuses:        mine.bonuses,
      deductions:     mine.deductions,
      forfeited:      mine.forfeited,
      months_paid:    mine.months_paid,
      months_on_roster: mine.months_on_roster,
      since:          ytdResult.program_start,
      months:         mine.months
    } : null,
    code_name: detail.code_name,
    full_name: detail.full_name,

    hours:    detail.hours,
    hours_ok: detail.hours_ok,
    points:   detail.points,
    review_points: detail.review_points,

    points_amount:  detail.points_amount,
    reviews_amount: detail.reviews_amount,
    hours_amount:   detail.hours_amount,
    share:          detail.share,
    bonuses:        detail.bonuses,
    deductions:     detail.deductions,
    take_home:      detail.take_home,
    forfeited:      detail.forfeited,

    paid:     detail.paid,
    forfeits: detail.forfeits,
    reason:   detail.reason,

    /* context so the person can see how their slice was worked out, without
       seeing what anyone else earned */
    pool:         detail.pool,
    points_pool:  detail.points_pool,
    reviews_pool: detail.reviews_pool,
    hours_pool:   detail.hours_pool,
    weights:      detail.weights,
    points_pct:   detail.points_pct,
    reviews_pct:  detail.reviews_pct,
    hours_pct:    detail.hours_pct,

    standing:        detail.standing,
    discipline_lost: detail.discipline_lost,

    ledger:      detail.ledger,
    reviews:     detail.reviews,
    adjustments: detail.adjustments
  };
}

/**
 * Admin sees everything, because Andrew and Nicole are the ones entering it.
 */
export function adminView(result) {
  return result;
}
