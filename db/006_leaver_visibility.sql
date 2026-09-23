-- Someone who gives notice should not vanish from the month they worked.
--
-- Andrew, 23 September: he marked Jeffrey Martin as "Left, gave notice" and
-- Jeffrey disappeared from the admin roster the same moment. "Left, no notice"
-- behaves correctly and stays put.
--
-- The cause: every roster query filters on `status <> 'left'`, so the row went
-- the instant the status changed. That also meant his hours for the month could
-- no longer be entered — Connecteam's export is matched against the roster, and
-- he was no longer on it — and the month he actually worked lost him entirely.
--
-- The fix is to remember WHEN someone left and keep them visible for the rest of
-- that month. `ended_on` already exists for this and was never being filled, so
-- this backfills it from the last edit to the row and the application sets it
-- from now on.
--
-- Andrew settled the money question the same day: "leave no notice given = no
-- bonus, leaves with notice given = bonus earned still." So someone who gives
-- notice is paid for the month they worked exactly as if they had stayed, and
-- only drops off from the following month. Walking out with no notice still
-- forfeits the share to everyone who picked up the slack.

begin;

/* Anyone already marked 'left' has no leaving date, so they would stay hidden
   for ever. updated_at is when the status was last changed, which for these
   rows is the day they were marked — the best record we have. */
update employees
   set ended_on = updated_at::date
 where status = 'left'
   and ended_on is null;

comment on column employees.ended_on is
  'The day someone stopped working here, set when status becomes left or '
  'no_notice and cleared if they are set back to active. The roster keeps a '
  'leaver visible for the remainder of the month they left, then drops them.';

/* the roster and the month report both ask "who left in this period" */
create index if not exists employees_ended_on_idx on employees (ended_on)
  where ended_on is not null;

commit;
