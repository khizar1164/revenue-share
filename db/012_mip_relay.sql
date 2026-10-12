-- What MoveitPro has told us, so we can tell what changed.
--
-- Andrew, 9 October: job booked, rescheduled or cancelled should land in
-- dispatch-updates, and a reschedule should show the old date as well as the
-- new one.
--
-- MoveitPro's webhook says WHICH job changed, never WHAT changed — the
-- delivery carries an event type and a record id and nothing else. So the old
-- date has to come from somewhere, and the only somewhere is us: the last
-- state we saw for that job, written every time we look.
--
-- mip_events exists because delivery is at-least-once by their own
-- documentation, and they coalesce rapid updates. Without it a retry would
-- post the same booking to Discord twice, which in a channel people read at a
-- glance is worse than a missed one.

begin;

create table if not exists mip_events (
  id          uuid primary key,              -- the signed id INSIDE the body
  event_type  text not null,
  record_id   uuid,
  received_at timestamptz not null default now()
);

create index if not exists mip_events_received_idx on mip_events (received_at desc);

comment on table mip_events is
  'Every webhook delivery from MoveitPro we have acted on, keyed by the id '
  'inside the signed body. Delivery is at-least-once, so this is what stops a '
  'retry posting to Discord twice. The X-MIP-Delivery-Id header is NOT used — '
  'it is unauthenticated.';

create table if not exists mip_jobs (
  job_id         uuid primary key,
  invoice_number integer,
  service_date   date,
  cancelled_at   timestamptz,
  status         text,
  customer_name  text,
  first_seen_at  timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table mip_jobs is
  'The last state we saw for each MoveitPro job. Not a copy of their data and '
  'not a source of truth for anything — it exists so that when a job changes '
  'we can say what it changed FROM, which their webhook does not tell us.';

commit;
