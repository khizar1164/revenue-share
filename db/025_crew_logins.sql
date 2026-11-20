-- Crew logins: a password and Face ID / fingerprint (Andrew, 20 November 2026).
--
-- Until now the crew signed in with an emailed link every time the 30-day
-- session ran out. The first link now leads to a set-up page: choose a
-- password and turn on Face ID. After that they sign in with one tap; the
-- link stays as the way back in when a password is forgotten.

begin;

create table if not exists crew_logins (
  employee_id     uuid primary key references employees (id) on delete cascade,
  password_hash   text,                       -- scrypt, never the password
  password_set_at timestamptz,
  failed_count    int not null default 0,
  locked_until    timestamptz,
  updated_at      timestamptz not null default now()
);

-- Face ID / fingerprint keys (WebAuthn passkeys). The private key never
-- leaves the phone; this is the public half, used to check a sign-in.
create table if not exists crew_passkeys (
  credential_id   text primary key,           -- base64url
  employee_id     uuid not null references employees (id) on delete cascade,
  public_key      bytea not null,
  counter         bigint not null default 0,
  transports      text[],
  device          text,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz
);
create index if not exists crew_passkeys_emp_idx on crew_passkeys (employee_id);

-- The one-time challenge a Face ID sign-in or set-up answers. Short-lived.
create table if not exists crew_webauthn_challenges (
  id           text primary key,
  employee_id  uuid references employees (id) on delete cascade,
  challenge    text not null,
  purpose      text not null check (purpose in ('register', 'login')),
  expires_at   timestamptz not null
);

commit;
