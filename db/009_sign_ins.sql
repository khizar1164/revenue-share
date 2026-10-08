-- Every time a crew member opens their own page.
--
-- Andrew, 9 October: "can you make it so that we can see the last date a crew
-- member has logged into their portal", and a live list of sign-ins as they
-- happen.
--
-- The sessions table already knows when somebody signed in, and is the wrong
-- place to ask. purgeExpired() deletes a session the moment it lapses, which is
-- correct for a credential and useless as a record: the answer to "when did
-- Jacob last log in" would quietly become "never" a fortnight after he did.
-- login_tokens are deleted a day after they expire, so they are no better.
--
-- So sign-ins get their own table, written once and never updated. It holds no
-- credential, which is the point: it can be kept for as long as it is useful
-- without keeping anything worth stealing.
--
-- No IP address. It would make the row personal data in a way the question
-- does not need — Andrew wants to know whether people are looking at their
-- numbers, not where they were standing when they did.

begin;

create table if not exists sign_ins (
  id          bigserial primary key,
  employee_id uuid not null references employees (id) on delete cascade,
  at          timestamptz not null default now(),
  user_agent  text
);

create index if not exists sign_ins_emp_idx on sign_ins (employee_id, at desc);
create index if not exists sign_ins_at_idx  on sign_ins (at desc);

comment on table sign_ins is
  'One row each time a crew member opens their report through a sign-in link. '
  'Append only, and holds no token — sessions are purged on expiry and cannot '
  'answer when somebody last signed in.';

-- Whatever the live sessions still remember, so the list does not start empty
-- and pretend nobody has ever been in.
insert into sign_ins (employee_id, at, user_agent)
select employee_id, created_at, user_agent from sessions
on conflict do nothing;

commit;
