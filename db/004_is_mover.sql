-- Not everyone in SmartMoving is a mover.
--
-- The roster is built from whoever works a job, which is the right rule — it is
-- how Jeremiah Wagoner and Blade Williams enrolled themselves when they started
-- working, and a static list would have quietly left them off the board.
--
-- But it also catches the owner and the payroll manager on the days they happen
-- to be attached to a job. They are not part of the crew revenue share, and
-- neither appears in Connecteam's hours export, so they would sit on the board
-- for ever at zero hours.
--
-- Deleting them does not work: the next sync sees them working a job and adds
-- them straight back. So they stay on the roster and are marked as not movers,
-- which is also a record of the decision.

begin;

alter table employees
  add column is_mover boolean not null default true;

comment on column employees.is_mover is
  'False for office, sales and management — anyone who may be attached to a job '
  'in SmartMoving but is not part of the crew revenue share. Kept on the roster '
  'rather than deleted so the nightly sync does not re-enrol them.';

/* the two we know about */
update employees set is_mover = false, updated_at = now()
 where full_name in ('Andrew Brown', 'Matthew Brown');

/* Matthew has not worked a job yet, so he is not on the roster. Put him there
   already excluded, so the day he is attached to one he does not appear on the
   break-room screen. */
insert into employees (code_name, full_name, status, is_mover)
select 'OFFICE-MB', 'Matthew Brown', 'active', false
 where not exists (select 1 from employees where full_name = 'Matthew Brown');

/* anything they had recorded against them is not part of the share */
delete from hours
 where employee_id in (select id from employees where is_mover = false);

commit;
