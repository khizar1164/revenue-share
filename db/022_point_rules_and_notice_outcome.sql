-- Two things from the 13 November meeting with Andrew.
--
-- 1. The point rules, as rows. Until now they were a fixed list in the admin
--    page's dropdown, so Andrew could not see them on the dashboard, and
--    changing one meant a code change. Now they are kept here and edited on
--    the Rules page. A point entry keeps its own copy of the reason text, so
--    editing or deleting a rule never changes an entry already recorded.
--
-- 2. Whether a write-up was actually given. A notice is raised automatically
--    when someone crosses 15, 30 or 45 lost points; whether Matthew then sat
--    down with them was not recorded anywhere, so one that was never given
--    looked the same as one that was. outcome is null until somebody says.
--    seen_at drives the pop-up on the admin page for a newly raised notice.

begin;

create table if not exists point_rules (
  id         bigserial primary key,
  label      text not null check (length(trim(label)) between 1 and 120),
  points     int  not null check (points <> 0),
  sort       int  not null default 0,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table point_rules is
  'The list a manager picks from when recording points. Edited on the Rules '
  'page. Entries keep their own reason text, so editing a rule is not retroactive.';

-- Andrew's finalised sheet, 28 September 2026, in his order and his wording.
insert into point_rules (label, points, sort, updated_by)
select v.label, v.points, v.sort, 'seed'
  from (values
    ('Most job photos submitted', 3, 10),
    ('Came in same day', 1, 20),
    ('Policy violation', -1, 30),
    ('Up to 30 mins late', -1, 40),
    ('Applicable material/equipment not removed from truck', -1, 50),
    ('Truck not restocked', -1, 60),
    ('Truck cleanliness not acceptable', -1, 70),
    ('Equipment/pads not neatly organized on truck', -1, 80),
    ('Not out by shop time', -1, 90),
    ('Failure to perform pre-inspection walkthrough properly', -1, 100),
    ('31 to 60 mins late', -2, 110),
    ('Stopped before first job without need for fuel (15-20% or less)', -2, 120),
    ('Customer complaint — vaping/smoking in sight of customer', -2, 130),
    ('Call off — unable to work scheduled shift when time off was not requested in advance', -2, 140),
    ('61+ mins late', -3, 150),
    ('Same day call off', -3, 160),
    ('Claim', -3, 170),
    ('Customer complaint — specifically names you', -5, 180),
    ('No call no show — tardiness not communicated within 30 minutes of shift start', -10, 190)
  ) as v(label, points, sort)
 where not exists (select 1 from point_rules);

alter table discipline_notices
  add column if not exists outcome      text check (outcome in ('issued', 'not_issued')),
  add column if not exists outcome_on   date,
  add column if not exists outcome_note text,
  add column if not exists outcome_by   text,
  add column if not exists outcome_at   timestamptz,
  add column if not exists seen_at      timestamptz;

comment on column discipline_notices.outcome is
  'issued = the write-up was given to the person (outcome_on is the day); '
  'not_issued = it was decided not to give it (outcome_note says why); '
  'null = nobody has said yet.';

-- Everything raised before this page existed has already been seen by
-- whoever was going to see it; only notices raised from now on pop up.
update discipline_notices set seen_at = now() where seen_at is null;

commit;
