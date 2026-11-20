-- Job photos the crew upload from their own page (Andrew, 19 November 2026).
--
-- Connecteam's API cannot read the Photos chat, so photos now come in through
-- the dashboard: the mover picks the job, ticks who was on it, and uploads.
-- The files go to Google Drive (a folder per month, then per job); only the
-- record of who sent what lives here, which is what the "most job photos"
-- rule needs to be counted rather than guessed.

begin;

create table if not exists job_photo_uploads (
  id              bigserial primary key,
  employee_id     uuid not null references employees (id) on delete cascade,  -- who uploaded
  job_ref         text,                     -- MoveitPro job id, when picked from the list
  job_number      text not null,            -- the estimate number staff quote
  service_date    date,
  crew            uuid[] not null default '{}',   -- everyone ticked as on the job
  note            text,
  drive_folder_id text,
  photo_count     int not null default 0,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz,
  connecteam_posted_at timestamptz,
  connecteam_error     text
);
create index if not exists job_photo_uploads_emp_idx  on job_photo_uploads (employee_id, created_at);
create index if not exists job_photo_uploads_job_idx  on job_photo_uploads (job_number);

create table if not exists job_photo_files (
  id             bigserial primary key,
  upload_id      bigint not null references job_photo_uploads (id) on delete cascade,
  drive_file_id  text not null,
  file_name      text,
  bytes          int,
  created_at     timestamptz not null default now()
);
create index if not exists job_photo_files_upload_idx on job_photo_files (upload_id);

commit;
