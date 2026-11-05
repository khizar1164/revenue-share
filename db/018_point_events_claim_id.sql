-- Which claim a deduction came from.
--
-- Andrew, 3 November: "let's say there's six people on this job, instead of me
-- having to come over here and do this for six different people." Recording a
-- claim against a crew took seven actions: the claim, then one point entry per
-- person with the job number and note retyped each time.
--
-- The reason this is a column and not just a convention is undoing. Until now
-- a claim and its six deductions were unrelated rows that happened to share a
-- job number, so taking back a mistake meant finding and deleting seven things
-- and hoping none were missed. Andrew is handing this job to somebody else
-- -- "I'm going to start having somebody else manage this part" -- which is
-- exactly when a half-undone correction stops being recoverable.
--
-- on delete cascade, so removing the claim removes what it cost people. The
-- pool goes back up and the points go back at the same moment, which is the
-- only pair of outcomes that is ever correct together.

begin;

alter table point_events
  add column if not exists claim_id bigint references claims (id) on delete cascade;

create index if not exists point_events_claim_idx
  on point_events (claim_id) where claim_id is not null;

comment on column point_events.claim_id is
  'The claim this deduction came from, when it came from one. Null for points '
  'entered on their own. Cascades, so deleting a claim takes its deductions '
  'with it rather than leaving them stranded against a job nobody can explain.';

commit;
