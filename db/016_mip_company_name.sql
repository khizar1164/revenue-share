-- Whose job it is, when the customer is a business.
--
-- Andrew, 31 October: "Can you get these to include company name if there is
-- one? For example estimate number #11446 ... It just shows customer name but
-- not the company name."
--
-- #11446 was a White Glove delivery out of a commercial address that reached
-- dispatch as "Mary Beth" and nothing else. Mary Beth is whoever answered the
-- phone; the business she answered it for was nowhere on the card.
--
-- The job payload cannot answer this. customer_name, customer_email and
-- customer_phone are as-booked snapshots of the contact and carry no company.
-- The company lives on the customer record, which the job points at through
-- prospect_id, so printing it costs a second lookup per job.
--
-- This column is what stops that lookup being repeated. Once we have read a
-- company for a job it is on the row, and a later event that cannot reach the
-- customer still prints the name rather than silently dropping the line --
-- the same reason estimate_number is stored here.

begin;

alter table mip_jobs add column if not exists company_name text;

comment on column mip_jobs.company_name is
  'The customer company on the job, read from the customer record via '
  'prospect_id. Null on a residential job, which genuinely has no company, '
  'and also when the lookup has never succeeded -- the two are not '
  'distinguished here, so an absent company prints as no line at all.';

commit;
