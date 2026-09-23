-- Names on a sheet that belong to nobody on the programme.
--
-- Nicole's review log goes back years, so it carries people who earned a review
-- while they worked here and have since left. The sync reported them as
-- "NOT MATCHED: Tyler H, Luke" on every run. Andrew, 23 September: "they may
-- have gotten a review but dont work here anymore."
--
-- Nothing was going wrong — an unmatched name is correctly credited to nobody,
-- and the review still counts for whoever else is on the row. The problem is
-- the warning. NOT MATCHED is the one signal that says a mover's points are
-- being dropped, and a warning that can never be cleared is a warning everyone
-- learns to scroll past. Then the day a current mover's name is misspelled,
-- nobody notices and they quietly lose money.
--
-- So a name can be marked as known-and-not-on-the-programme. It is still not
-- credited to anyone. It just stops being shouted about, and the real ones
-- stand alone again.

begin;

create table if not exists ignored_names (
  name       text primary key,        -- normalised: lowercase, letters and spaces
  as_written text not null,           -- what the sheet actually says
  note       text,
  added_at   timestamptz not null default now()
);

comment on table ignored_names is
  'Names appearing in the review or tardy logs that belong to nobody on the '
  'revenue share — usually people who left before the programme started. They '
  'are credited nothing either way; this only keeps them out of the NOT MATCHED '
  'warning so a genuine mismatch is still visible.';

insert into ignored_names (name, as_written, note) values
  ('tyler h', 'Tyler H', 'Andrew, 23 September 2026: got a review but does not work here any more'),
  ('luke',    'Luke',    'Andrew, 23 September 2026: got a review but does not work here any more')
on conflict (name) do nothing;

commit;
