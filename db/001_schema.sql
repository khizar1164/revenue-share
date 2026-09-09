-- Revenue Share — schema
-- Immediate Movers & Storage
--
-- Two ideas carry the whole design:
--   * point_events is a dated log, never a running total. That is what makes the
--     rolling 60-day discipline window, the employee's "why is my number this"
--     ledger, and any dispute about a deduction answerable.
--   * review_credits is one row per person per review, so correcting a crew after
--     the fact is an edit to a record rather than a recalculation of a total.
--
-- Everything derived — the pool, the 60/40 split, each share, the forfeited
-- amount — is computed at read time. None of it is stored, so it cannot drift.

begin;

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- roster ----

create table employees (
  id            uuid primary key default gen_random_uuid(),
  code_name     text not null unique,          -- RANGER — the only name the TV shows
  full_name     text not null,                 -- Josh Trim
  sm_crew_id    text unique,                   -- SmartMoving crew member id
  email         text unique,                   -- for the sign-in link
  status        text not null default 'active'
                check (status in ('active', 'no_notice', 'left')),
  started_on    date,
  ended_on      date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on column employees.status is
  'active = sharing. no_notice = walked without two weeks; share is forfeited and '
  'redistributed, shown red on the TV. left = gave notice, simply no longer sharing.';

-- --------------------------------------------- SmartMoving job/crew index ----
-- Rebuilt by the sync. The job record does not carry its crew, so we build the
-- index from the crew side: for each active mover, ask which jobs they worked.

create table sm_jobs (
  job_id          text primary key,
  job_number      text not null,
  opportunity_id  text,
  service_date    date,
  completed_at    timestamptz,
  service_type    integer,
  synced_at       timestamptz not null default now()
);

create index sm_jobs_number_idx  on sm_jobs (job_number);
create index sm_jobs_service_idx on sm_jobs (service_date);

create table sm_job_crew (
  job_id      text not null references sm_jobs (job_id) on delete cascade,
  sm_crew_id  text not null,
  primary key (job_id, sm_crew_id)
);

create index sm_job_crew_crew_idx on sm_job_crew (sm_crew_id);

-- --------------------------------------------------------------- revenue ----
-- One row per fetch of the daily Revenue Forecast report, never overwritten,
-- so the crew can watch the pool build and we can always show why it moved.

create table revenue_snapshots (
  id                bigserial primary key,
  period            date not null,             -- first day of the month
  completed_revenue numeric(12,2) not null,
  completed_jobs    integer,
  total_tips        numeric(12,2),
  total_taxes       numeric(12,2),
  source            text not null default 'report'
                    check (source in ('report', 'manual')),
  captured_at       timestamptz not null default now()
);

create index revenue_period_idx on revenue_snapshots (period, captured_at desc);

-- ---------------------------------------------------------------- points ----

create table point_events (
  id           bigserial primary key,
  employee_id  uuid not null references employees (id) on delete cascade,
  occurred_on  date not null,
  delta        integer not null,                -- +1 same-day job, -2 call off, …
  reason       text not null,
  job_number   text,
  recorded_by  text,
  created_at   timestamptz not null default now()
);

create index point_events_emp_idx on point_events (employee_id, occurred_on);
create index point_events_date_idx on point_events (occurred_on);

-- --------------------------------------------------------------- reviews ----
-- Logged in the dashboard, not the spreadsheet. customer_name is recorded for
-- reference and never matched on — the name on a review is often not the name
-- on the job. job_number is the only key that decides credit.

create table reviews (
  id            uuid primary key default gen_random_uuid(),
  occurred_on   date not null,
  job_number    text,
  customer_name text,
  source        text,                            -- LP Google, Facebook, BBB…
  has_photo     boolean not null default false,
  points        integer not null check (points > 0),   -- 1, or 3 with a photo
  recorded_by   text,
  created_at    timestamptz not null default now()
);

create index reviews_date_idx on reviews (occurred_on);
create index reviews_job_idx  on reviews (job_number);

create table review_credits (
  review_id   uuid not null references reviews (id) on delete cascade,
  employee_id uuid not null references employees (id) on delete cascade,
  primary key (review_id, employee_id)
);

create index review_credits_emp_idx on review_credits (employee_id);

-- ---------------------------------------------------------------- claims ----
-- Comes off the whole pool before it splits.

create table claims (
  id          bigserial primary key,
  occurred_on date not null,
  job_number  text,
  reason      text not null,
  amount      numeric(10,2) not null check (amount >= 0),
  recorded_by text,
  created_at  timestamptz not null default now()
);

create index claims_date_idx on claims (occurred_on);

-- ----------------------------------------------------------------- hours ----
-- Entered once a month. 75 is the eligibility gate. A mid-month start gets no
-- proration — Andrew's call: it just goes by whether they hit 75 that month.

create table hours (
  employee_id uuid not null references employees (id) on delete cascade,
  period      date not null,
  hours       numeric(6,2) not null check (hours >= 0),
  recorded_by text,
  updated_at  timestamptz not null default now(),
  primary key (employee_id, period)
);

-- ----------------------------------------------------- bonuses/deductions ----
-- Private to the individual report. Never shown on the break-room TV.

create table adjustments (
  id          bigserial primary key,
  employee_id uuid not null references employees (id) on delete cascade,
  occurred_on date not null,
  kind        text not null check (kind in ('bonus', 'deduction')),
  reason      text not null,
  amount      numeric(10,2) not null check (amount >= 0),
  recorded_by text,
  created_at  timestamptz not null default now()
);

create index adjustments_emp_idx on adjustments (employee_id, occurred_on);

-- ------------------------------------------------------------ month close ----
-- Written once, when a month is locked. This is the record of what was actually
-- paid, frozen against later edits to the underlying rows.

create table payout_runs (
  id           bigserial primary key,
  period       date not null unique,
  pool         numeric(12,2) not null,
  points_pool  numeric(12,2) not null,
  reviews_pool numeric(12,2) not null,
  revenue      numeric(12,2) not null,
  claims_total numeric(12,2) not null,
  locked_at    timestamptz,
  locked_by    text,
  created_at   timestamptz not null default now()
);

create table payout_lines (
  payout_run_id  bigint not null references payout_runs (id) on delete cascade,
  employee_id    uuid not null references employees (id),
  code_name      text not null,        -- frozen: code names can be reassigned later
  full_name      text not null,
  hours          numeric(6,2),
  points         integer,
  review_points  integer,
  points_amount  numeric(10,2) not null default 0,
  reviews_amount numeric(10,2) not null default 0,
  bonuses        numeric(10,2) not null default 0,
  deductions     numeric(10,2) not null default 0,
  forfeited      numeric(10,2) not null default 0,
  take_home      numeric(10,2) not null default 0,
  qualified      boolean not null,
  primary key (payout_run_id, employee_id)
);

-- ------------------------------------------------------------ sync audit ----

create table sync_runs (
  id         bigserial primary key,
  kind       text not null,            -- 'smartmoving' | 'revenue_report' | 'sheet_writeback'
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  ok         boolean,
  detail     text
);

create index sync_runs_kind_idx on sync_runs (kind, started_at desc);

commit;
