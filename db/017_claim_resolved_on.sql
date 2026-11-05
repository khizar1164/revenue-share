-- When a claim was settled, as distinct from when the job was.
--
-- Andrew, 3 November: "sometimes the claim doesn't show up right away.
-- Sometimes it's not resolved for a month to two months later."
--
-- A claim had one date, occurred_on, which is the job date, and that is what
-- decided which month absorbed it. So a claim settled weeks later still landed
-- on the month of the job, and that month was closed and its pool already
-- quoted.
--
-- This is not hypothetical. Measured on 5 November: nine claims, average gap
-- between job and entry eleven days, worst twenty-four. Six of the nine were
-- entered in November against October jobs. Three of them landed after Andrew
-- had approved October's pool and took it down by $374.50 with nothing
-- announcing it. That is crew pay moving after the fact.
--
-- So a claim now counts against the month it was resolved. occurred_on stays
-- the job date, because the job and the crew still have to be identifiable;
-- resolved_on is what calc.js attributes by.
--
-- Backfilled to occurred_on rather than to created_at, deliberately. Using
-- created_at would be more truthful about the past, but it would move
-- $1,171.79 of claims out of October and lift that pool well above the figure
-- Andrew approved. The whole point of this change is that a closed month stops
-- moving, so it would be a poor start to move one. History stays exactly as it
-- is and the new rule applies from here.

begin;

alter table claims add column if not exists resolved_on date;

update claims set resolved_on = occurred_on where resolved_on is null;

alter table claims alter column resolved_on set not null;
alter table claims alter column resolved_on set default current_date;

create index if not exists claims_resolved_idx on claims (resolved_on);

comment on column claims.occurred_on is
  'The date of the job the claim is about. Identifies the job and the crew; '
  'does NOT decide which month bears the cost.';

comment on column claims.resolved_on is
  'The date the claim was settled. This is the month that bears it, so a '
  'claim resolved long after the job cannot reopen a month that has closed. '
  'Defaults to today, which is right for a claim entered when it is agreed.';

commit;
