-- Per-month switches.
--
-- The one that matters right now is the hours gate. September 2026 is the first
-- month of the programme and the hours process was only agreed partway through
-- it, so Andrew may want to run this month without the 75-hour minimum and
-- start applying it properly in October. That is a decision, not a bug, so it
-- gets recorded per month with a note rather than being a line of code someone
-- has to remember to change back.

begin;

create table month_settings (
  period            date primary key,
  hours_gate_waived boolean not null default false,
  note              text,
  updated_by        text,
  updated_at        timestamptz not null default now()
);

comment on column month_settings.hours_gate_waived is
  'When true the 75-hour minimum does not apply for this month and everyone on '
  'the roster shares. The roster only contains crew who actually worked jobs, '
  'so this does not pay people who were not there.';

commit;
