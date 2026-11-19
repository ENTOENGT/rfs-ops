-- 029 — Outlook connection (G3, step 1). Safe to run twice; only new columns and tables.
-- Pilot users connect their own mailbox once ("Connect my Outlook"); RFS Ops then acts only on that mailbox, with that
-- person's own Microsoft permissions. Tokens are stored encrypted and never shown on any screen.

-- who may connect (switched on by the Super Admin, person by person)
alter table users add column if not exists outlook_pilot boolean not null default false;

create table if not exists outlook_connections (
  user_id uuid primary key references users(id),
  ms_user_id text not null,
  ms_email text not null,
  ms_name text,
  refresh_token_enc text not null,
  access_token_enc text,
  access_expires_at timestamptz,
  scope text,
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  delta_link text,                -- where the inbox reading left off (step 3)
  last_error text,
  updated_at timestamptz not null default now()
);
alter table outlook_connections enable row level security;

-- ================================================================ Keep every document for good (19 Nov 2026)
-- The company keeps all documents permanently: no document type expires any more, and no file still in storage is
-- scheduled for deletion. (Files already deleted by the old 30-day rule cannot be brought back; their records stay.)
update document_types set retention_days = null where retention_days is not null;
update job_documents set expires_at = null where expires_at is not null and purged_at is null;

insert into schema_migrations (name) values ('029_outlook.sql') on conflict do nothing;
