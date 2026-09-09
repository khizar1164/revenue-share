-- This database is shared with the chatbot (its `conversations` table lives in
-- public). Payroll figures and a chatbot's history should not sit in the same
-- namespace: a future migration on either side could collide on a table name,
-- and "what belongs to what" stops being obvious to whoever looks next.
--
-- So the revenue share owns its own schema. Nothing about the chatbot changes.
-- Done now while every table is still empty; later it would mean moving data.

begin;

create schema if not exists revenue_share;

do $$
declare t text;
begin
  foreach t in array array[
    'employees', 'sm_jobs', 'sm_job_crew', 'revenue_snapshots',
    'point_events', 'reviews', 'review_credits', 'claims', 'hours',
    'adjustments', 'payout_runs', 'payout_lines', 'sync_runs'
  ] loop
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      execute format('alter table public.%I set schema revenue_share', t);
    end if;
  end loop;
end $$;

commit;
