-- Attach the claims that predate the crew picker to the points they cost.
--
-- claim_id arrived with the multi-select form, so every claim recorded before
-- it has none, and the break-room page shows those with no code names against
-- them. Andrew asked for the code names; this is the history catching up.
--
-- The join is by date, because it is the only one available: not one of the
-- eleven claim deductions carries a job number. Date alone would normally be
-- too loose, but here it is not ambiguous in the way it looks:
--
--   28 Sep  two claims, $550 and $140.40, BOTH on job 10659, and four
--           deductions. Same job means the same crew, so both claims belong
--           to those four. What cannot be told from the data is whether the
--           four were docked once or twice; that does not matter here,
--           because claim_id records who was on the job and not how much
--           anybody paid.
--   09 Oct  one claim, three deductions.
--   17 Oct  one claim, four deductions.
--
-- The remaining five claims have no deductions at all -- nobody was docked
-- for the dollies, either paint claim, the TV cords or the mirror -- so they
-- will never show a crew however this is written. Worth knowing rather than
-- fixing: whether every claim should cost somebody points is Andrew's call,
-- not a gap in the data.
--
-- One consequence to be aware of, on the 28 September pair only: claim_id
-- cascades, so deleting either of those two claims removes deductions that
-- also belong to the other. Accepted deliberately. The alternative is leaving
-- four people's names off a page that was asked for, to guard against someone
-- deleting a six-week-old claim.

begin;

-- One claim per deduction, which is what the column means: a deduction was
-- for one claim, not for two. The first attempt matched every claim sharing
-- the date and would have tried to link the four 28 September deductions to
-- both claims, producing fifteen links from eleven rows and letting Postgres
-- pick which claim won.
--
-- So where a date carries more than one claim, the deductions go to the
-- largest, which on 28 September is the $550 floor damage rather than the
-- $140.40 cabinet foot. That is a judgement, not a fact, and it is why the
-- smaller claim is left showing no crew rather than borrowing the same four
-- names.
update point_events pe
   set claim_id = pick.id
  from (
    select distinct on (occurred_on)
           occurred_on, id
      from claims
     order by occurred_on, amount desc, id
  ) pick
 where pe.claim_id is null
   and pe.delta < 0
   and pe.reason ilike '%claim%'
   and pe.occurred_on = pick.occurred_on
   /* Only where every claim that day is from the same job, so the crew is
      the same whichever claim it was. A date carrying two different jobs
      would be a guess and is left alone. */
   and (select count(distinct coalesce(c2.job_number, ''))
          from claims c2 where c2.occurred_on = pe.occurred_on) = 1;

commit;
