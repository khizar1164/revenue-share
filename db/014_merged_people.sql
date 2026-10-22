-- Two accounts, one person.
--
-- Andrew, 21 October: "Landon has two accounts in revenue dashboard."
--
-- He is right, and the roster has two doors. Until 9 October somebody became a
-- mover by working a job: the SmartMoving sync saw a crew member on a job and
-- enrolled them, keyed on sm_crew_id. Since 9 October they also arrive the day
-- they are set up in Connecteam, keyed on email and then on a normalised name.
--
-- The Connecteam door matches against everybody already here before it adds
-- anyone. The SmartMoving one never did: it asked only whether that
-- sm_crew_id was already on the roster, and somebody brought across from
-- Connecteam has no sm_crew_id at all. So the first job worked by anyone hired
-- since the Connecteam sync went in creates a second row for them, with a
-- second code name, and the month splits in half across the two — points and
-- the portal on one, hours and the jobs on the other, and neither reaching
-- 100 hours.
--
-- The door is fixed in jobs.js. This is for the rows that already exist.
--
-- Merging is not deleting. Deleting the spare row loses the trail of how the
-- figures were put back together, and the FK from payout_lines would refuse it
-- the moment a month is locked. So the row stays, is marked as not a mover —
-- the same way office and management are — and records which account it was
-- merged into. Everything a person typed against it moves across; nothing is
-- thrown away; and because every month is computed at read time rather than
-- stored, the months already gone right themselves.
--
-- It also has to stay for the sync's sake. The account kept takes the crew id
-- across when it has none of its own; where it already has one, the spare row
-- keeps its own, and that is what stops SmartMoving enrolling the same person a
-- third time on their next job.

begin;

alter table employees
  add column merged_into uuid references employees (id);

comment on column employees.merged_into is
  'Set when this row turned out to be a second account for somebody already on '
  'the roster. Everything recorded against it has been moved to the account it '
  'names; is_mover is false, so it is on no roster, matches no name from a '
  'sheet and cannot request a sign-in link. Kept rather than deleted so the '
  'merge is on the record and so a second SmartMoving crew id still stops that '
  'sync re-enrolling the same person.';

create index if not exists employees_merged_into_idx on employees (merged_into)
  where merged_into is not null;

commit;
