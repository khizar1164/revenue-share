-- When somebody was last nudged about signing in.
--
-- Andrew, 3 November: six of nineteen movers had ever signed in, and he wanted
-- the rest chased. Those who have never been in get a weekly reminder; those
-- who have get one every two days, which is the figure he settled on after the
-- meeting.
--
-- The reason this needs a table is the same reason discipline_notices does.
-- The check runs on a schedule, and "has this person signed in" is true on
-- every run, so without a record of what has already gone out the two-day
-- group would be messaged on every pass instead of every two days.
--
-- Kept per send rather than as a single last_sent column, so it can be seen
-- how many times somebody has been chased before anyone concludes the
-- reminders are not working.

begin;

create table if not exists sign_in_reminders (
  id          bigserial primary key,
  employee_id uuid not null references employees (id) on delete cascade,
  kind        text not null check (kind in ('never', 'returning')),
  sent_at     timestamptz not null default now()
);

create index if not exists sign_in_reminders_who
  on sign_in_reminders (employee_id, sent_at desc);

comment on table sign_in_reminders is
  'One row per reminder sent. The scheduler reads the most recent per person '
  'to decide who is due, so a run that fires twice does not message anybody '
  'twice.';

comment on column sign_in_reminders.kind is
  'never = has not signed in, chased weekly. returning = has, nudged every '
  'two days. The two exist to be counted separately: if take-up stalls, the '
  'question is which group stopped responding.';

commit;
