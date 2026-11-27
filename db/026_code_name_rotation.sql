-- Code names change every month (Andrew, 21 Nov 2026): the crew worked out a
-- new hire's code name because names were handed out in a fixed order. From
-- December each mover gets a new random name on the 1st, and signs in to see
-- it. This keeps who had which name each month, so an admin can still look a
-- past month up, and so a month is never rotated twice.
create table if not exists code_name_history (
  period       date not null,                      -- first of the month the name was used
  employee_id  uuid not null references employees (id),
  code_name    text not null,
  primary key (period, employee_id)
);
create index if not exists code_name_history_name on code_name_history (period, code_name);
