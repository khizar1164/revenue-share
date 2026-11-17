-- A finished month locked against accidental changes (Andrew, 17 November).
-- A row means the month is locked; deleting it unlocks the month.
create table if not exists month_locks (
  period     date primary key check (period = date_trunc('month', period)::date),
  locked_by  text,
  locked_at  timestamptz not null default now()
);
