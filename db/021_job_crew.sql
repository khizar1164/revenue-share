-- Who worked each job, from MoveitPro, with SmartMoving's history carried over.
--
-- SmartMoving's API key stopped working around 10 November 2026, and with it
-- the only record of who was on a job: the review lookup by job number, the
-- claims a write-up shows against a mover, and the counts on the duplicates
-- page all read sm_jobs / sm_job_crew. MoveitPro now lists the crew on every
-- job (job.crews[].members[], with employee_id, role and crew lead), and on 11
-- November every one of the 98 crew entries on November's 30 worked jobs
-- resolved to a MoveitPro employee.
--
-- One table, keyed straight to our own employee id rather than to either
-- system's crew id, so nothing that reads it needs to know where a job came
-- from. SmartMoving's rows are copied in once, below, so August to October
-- keep working; sm_jobs and sm_job_crew are left in place untouched as the
-- record they were copied from.

begin;

alter table employees add column if not exists mip_employee_id uuid;
create unique index if not exists employees_mip_employee_idx
  on employees (mip_employee_id) where mip_employee_id is not null;

comment on column employees.mip_employee_id is
  'The MoveitPro employee this mover is. Matched by name by the crew sync and '
  'only when exactly one current MoveitPro employee fits; an ambiguous or '
  'missing match is left null and reported rather than guessed.';

create table if not exists job_crew (
  source        text not null check (source in ('moveitpro', 'smartmoving')),
  job_ref       text not null,          -- the job's id in that system
  job_number    text,                   -- MoveitPro: the ESTIMATE number staff quote
  service_date  date,
  completed_at  timestamptz,
  employee_id   uuid not null references employees (id) on delete cascade,
  role          text,
  is_crew_lead  boolean,
  synced_at     timestamptz not null default now(),
  primary key (source, job_ref, employee_id)
);

create index if not exists job_crew_number_idx   on job_crew (job_number);
create index if not exists job_crew_employee_idx on job_crew (employee_id);
create index if not exists job_crew_date_idx     on job_crew (service_date);

comment on table job_crew is
  'One row per mover per job. MoveitPro rows are rebuilt by the crew sync; '
  'SmartMoving rows were copied once on 12 November 2026 and never change.';

insert into job_crew (source, job_ref, job_number, service_date, completed_at, employee_id)
select 'smartmoving', j.job_id, j.job_number, j.service_date, j.completed_at, e.id
  from sm_jobs j
  join sm_job_crew jc on jc.job_id = j.job_id
  join employees e    on e.sm_crew_id = jc.sm_crew_id
on conflict do nothing;

commit;
