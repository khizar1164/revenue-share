-- The number the company actually says out loud.
--
-- Andrew, 15 October: "These are showing the wrong job numbers sometimes."
-- The relay posted Job #9194 for Christine Paro; Jason answered him with
-- "see the #11251 Christine Paro thread". Both numbers are correct and both
-- belong to that one job. MoveitPro's Moves table carries them in separate
-- columns, ESTIMATE and INVOICE:
--
--     ESTIMATE  #11251        <- what every thread, board and rep says
--     INVOICE   #9194         <- a separate billing counter
--
-- The relay was reading invoice_number, which is the one nobody quotes. The
-- two counters are independent, so they drift apart by thousands and the
-- mismatch only shows up when somebody cross-checks a message against a
-- thread, which is why it looked wrong "sometimes" rather than always.
--
-- A manual job has no estimate at all and carries only an invoice number, so
-- that stays as the fallback rather than being dropped.
--
-- This column exists for the payments channel. A payment event names a job id,
-- and the message has to print a number for it without fetching the estimate
-- again, so the estimate number is stored alongside the job the same way the
-- invoice number already was.

begin;

alter table mip_jobs add column if not exists estimate_number integer;

comment on column mip_jobs.estimate_number is
  'The ESTIMATE number MoveitPro shows on the job (#11251), which is what '
  'staff quote to each other. Distinct from invoice_number (#9194), a separate '
  'billing counter. Null on a manual job, which has no estimate.';

commit;
