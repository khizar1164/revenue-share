-- One record per time somebody crosses a discipline threshold.
--
-- Andrew, 3 October: "create a quick task in connecteam for matthew under
-- Payroll." The points system already knows the moment someone passes 15, 30
-- or 45 lost points in a rolling 60 days. Up to now that fact sat on a
-- dashboard waiting to be noticed.
--
-- The reason this needs a table rather than a calculation is repetition. The
-- check runs every half hour. Somebody sitting on 18 points is over the line
-- on every single run, and without a record of what has already been raised,
-- Matthew would get the same task forty-eight times a day.
--
-- So: a notice is open from the moment it is raised until the person falls
-- back under that threshold, and while one is open nothing at that level or
-- below is raised again. Rising from 15 to 30 does raise a second one, because
-- a suspension is not the same conversation as a warning.
--
-- Nothing here decides anything. The notice is a record that somebody was
-- told, and the points are still the only thing that says where a person
-- stands.

begin;

create table if not exists discipline_notices (
  id          bigserial primary key,
  employee_id uuid not null references employees(id) on delete cascade,
  level       text not null check (level in ('warning','suspension','termination')),
  lost        int  not null,              -- points lost when it was raised
  window_from date not null,
  window_to   date not null,
  raised_at   timestamptz not null default now(),
  cleared_at  timestamptz,                -- when they dropped back under it
  task_id     text,                       -- Connecteam's id, null if no task went out
  task_error  text                        -- why not, when one should have
);

-- The question asked on every run is "is there an open notice for this person
-- at this level", so that is the index.
create index if not exists discipline_notices_open
  on discipline_notices (employee_id, level)
  where cleared_at is null;

comment on table discipline_notices is
  'Raised when an employee crosses 15, 30 or 45 lost points in a rolling 60 '
  'days. Open until they fall back below that threshold; while open, the same '
  'level is not raised again. task_id is the Connecteam quick task, which is '
  'null when task creation is switched off — the crossing is still recorded.';

comment on column discipline_notices.task_error is
  'Set when a task should have been created and could not be. Kept so a failed '
  'notification is visible rather than silently absent, and so the run that '
  'fixes it can tell which ones to retry.';

commit;
