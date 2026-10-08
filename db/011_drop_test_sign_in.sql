-- Remove the one sign-in that was never a sign-in.
--
-- The sign_ins table was backfilled from the live sessions when it was created
-- on 9 October 2026, and one of the seven rows it picked up was not a crew
-- member looking at their pay. It is dated 9 September, a month before any
-- crew member was sent a link, and it came from a Windows desktop while every
-- genuine sign-in in the list is an iPhone or an Android. Andrew's instruction
-- at the time was "I don't want any emails sent to them yet about logging in",
-- so nobody had a link to use.
--
-- It was somebody testing the sign-in flow during the build, recorded against
-- Aaron Schwark because his was the record used to test it. He has since left
-- without notice, which made it read on the dashboard as a departed employee
-- signing in last month. Khizar asked twice whether it was an error. A row
-- that has to be explained every time somebody looks at it is worse than no
-- row, and this one is not evidence of anything that happened.
--
-- Scoped by the facts rather than by id, so it describes what it removes and
-- cannot reach anything else. Written to delete nothing if the row has already
-- gone.

begin;

delete from sign_ins s
 using employees e
 where s.employee_id = e.id
   and e.full_name = 'Aaron Schwark'
   and s.at < date '2026-10-01'
   and s.user_agent like '%Windows NT%';

commit;
