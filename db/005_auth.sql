-- Sign-in by email link.
--
-- No passwords. A mover types their work email, gets a link, clicks it, and is
-- in. For people working off a phone between jobs, a password they set once and
-- forget by the next payday is a reason not to look at their own numbers.
--
-- Two tables. login_tokens is the single-use link; sessions is what the browser
-- keeps afterwards. Both store a hash rather than the value itself, so a leaked
-- database backup cannot be replayed to get into anyone's report.

begin;

create table login_tokens (
  token_hash   text primary key,          -- sha256 of the value in the link
  employee_id  uuid not null references employees (id) on delete cascade,
  email        text not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  used_at      timestamptz,
  requested_ip text
);

create index login_tokens_emp_idx on login_tokens (employee_id, created_at desc);

comment on table login_tokens is
  'Single-use sign-in links. Short lived, and consumed on first use so a link '
  'forwarded or left in a shared inbox cannot be reused.';

create table sessions (
  token_hash   text primary key,
  employee_id  uuid not null references employees (id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent   text
);

create index sessions_emp_idx on sessions (employee_id);
create index sessions_expiry_idx on sessions (expires_at);

-- Admin is a named list rather than a role on the employee: Andrew and Nicole
-- are not movers, and the people who run the programme are not the people in it.
create table admin_users (
  email      text primary key,
  full_name  text,
  created_at timestamptz not null default now()
);

comment on table admin_users is
  'Who may open the admin panel. Kept separate from employees because the two '
  'lists genuinely differ — Nicole is not on the board, and a mover must never '
  'become an admin by being edited.';

commit;
