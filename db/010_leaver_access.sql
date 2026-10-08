-- When somebody leaves, finish filling in the day they left.
--
-- Migration 006 backfilled ended_on for people marked 'left' and the
-- application has set it on every status change since. It never backfilled
-- 'no_notice', so the two people marked that way on 23 September 2026 — before
-- that code existed — still have no leaving date at all.
--
-- That matters now because portal access is about to depend on it. Without a
-- date there is no way to tell somebody who walked out last week from somebody
-- who walked out last year, and a rule that cannot tell them apart has to
-- guess. updated_at is when the status was last changed, which for these rows
-- is the day they were marked, and is the best record there is.

begin;

update employees
   set ended_on = updated_at::date
 where status in ('left', 'no_notice')
   and ended_on is null;

commit;
