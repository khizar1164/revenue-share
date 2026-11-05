-- The lesson from a claim, in a sentence the crew can act on.
--
-- Andrew, 3 November: "on the board in the break room... show a list of all of
-- the claims and what they're for, that way the crew knows where we have more
-- room for improvement." And, minutes later: "I don't want it so highlighted
-- on 'hey, this is everything we're doing wrong'... maybe we can have it show
-- some automated tips."
--
-- Those are one page, not two. A claim on its own reads as blame; a claim with
-- what to do differently reads as training.
--
-- Written once, when the claim is recorded, rather than regenerated each
-- morning. Three reasons: showing a stored sentence costs nothing, the wording
-- stays put instead of drifting daily under the crew's eyes, and a sentence
-- going on a screen in front of people can be read before it gets there.
-- edited_by is set when Andrew rewrites one, and a rewritten tip is never
-- replaced by a generated one.
--
-- Andrew's side of the bargain, in his words: "I'll try to be very detailed
-- with my reasons when I put them in. That way it helps the tip that it auto
-- generates."

begin;

create table if not exists claim_tips (
  claim_id   bigint primary key references claims (id) on delete cascade,
  tip        text not null,
  edited_by  text,                       -- set when a person rewrote it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table claim_tips is
  'One tip per claim, shown on the break-room board. The board cycles through '
  'these a day at a time, so the pool persists rather than emptying when a '
  'month closes.';

comment on column claim_tips.edited_by is
  'Who rewrote the tip by hand. Set means leave it alone: a generated sentence '
  'must never overwrite one somebody chose.';

commit;
