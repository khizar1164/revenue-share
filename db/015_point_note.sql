-- What the policy violation actually was.
--
-- Andrew, 21 October: "can you make it so that I can enter a note for when
-- someone gets a policy deduction so they know what it's for?"
--
-- The reason on a point entry is picked off his finalised list, which is the
-- right way round — the break-room sheet and the dashboard have to say the
-- same thing, and a free-typed reason would drift from it within a week. But
-- "Policy violation −1" on its own tells the person their number moved and
-- nothing about why, and that is the entry most likely to be disputed.
--
-- So the reason stays the reason, exactly as chosen, and the note sits beside
-- it. Nothing reads it: the split, the 60-day discipline window and the
-- write-up's policy citation all key off the reason text, so a note mentioning
-- a claim or a complaint can never change which rule a notice cites.
--
-- It shows on the person's own page under the entry it belongs to, in the
-- admin point log, in the incident table on a write-up, and in the nightly
-- backup to the sheet. Optional everywhere, and never on the break-room TV.

begin;

alter table point_events
  add column note text;

comment on column point_events.note is
  'What happened, in a manager''s own words, shown to the person beside the '
  'reason. Optional. Never matched on — the reason text is what decides the '
  'impact paragraph and the policy reference on a disciplinary notice.';

commit;
