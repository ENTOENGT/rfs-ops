-- 020 — Part G1: group notifications, quotation terms templates, email templates, one email subject per shipment,
-- email history on the shipment, Customer Service retired. Safe to run twice. Nothing is deleted.

-- ------------------------------------------------------------ notifications
alter table notifications add column if not exists event text;                 -- what happened (new_enquiry, rate_received…)
alter table notifications add column if not exists vendor_request_id uuid references vendor_requests(id);
alter table notifications add column if not exists actor_name text;             -- who did it
create index if not exists notif_dedupe_idx on notifications (user_id, job_file_id, event, created_at desc);

-- "email me too" per event (emails start when the company mailbox is connected)
create table if not exists notification_prefs (
  user_id uuid not null references users(id) on delete cascade,
  event text not null,
  email boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, event)
);

-- ------------------------------------------------------------ quotation terms templates
create table if not exists quote_term_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  division text check (division in ('imports', 'exports', 'cross_trade')),   -- null = any
  mode text,                                                                   -- sea / air / road; null = any
  shipment_type text check (shipment_type in ('fcl', 'lcl')),                  -- null = any
  customer_id uuid references customers(id),                                   -- null = any customer
  scope text, exclusions text, terms text, additional_remarks text, payment_terms text,
  is_active boolean not null default true,
  created_by uuid references users(id), created_at timestamptz not null default now(),
  updated_by uuid references users(id), updated_at timestamptz not null default now()
);
create table if not exists quote_term_template_history (
  id bigserial primary key,
  template_id uuid not null references quote_term_templates(id),
  action text not null,
  snapshot jsonb not null,
  user_id uuid references users(id), user_name text,
  at timestamptz not null default now()
);
alter table quotations add column if not exists additional_remarks text;
alter table quotations add column if not exists payment_terms text;
alter table quotations add column if not exists terms_template_id uuid references quote_term_templates(id);
alter table quotations add column if not exists terms_edited boolean not null default false;

-- ------------------------------------------------------------ email templates
create table if not exists email_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null,                   -- which email (agent_rate_request, quotation_submission…)
  division text check (division in ('imports', 'exports', 'cross_trade')),
  mode text,
  customer_id uuid references customers(id),
  subject text not null,
  body text not null,
  is_active boolean not null default true,
  created_by uuid references users(id), created_at timestamptz not null default now(),
  updated_by uuid references users(id), updated_at timestamptz not null default now()
);
create index if not exists etpl_key_idx on email_templates (template_key) where is_active;
create table if not exists email_template_history (
  id bigserial primary key,
  template_id uuid not null references email_templates(id),
  action text not null,
  snapshot jsonb not null,
  user_id uuid references users(id), user_name text,
  at timestamptz not null default now()
);

-- ------------------------------------------------------------ one subject per shipment + email history
alter table job_files add column if not exists email_topic text;   -- the words after the [ENQ] tag, fixed when the enquiry opens

create table if not exists email_messages (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null references job_files(id),
  direction text not null check (direction in ('in', 'out')),
  status text not null check (status in ('prepared', 'received', 'sent')),
  template_key text,
  vendor_request_id uuid references vendor_requests(id),
  quotation_id uuid references quotations(id),
  from_addr text, from_name text, to_addrs text, cc_addrs text,
  subject text,
  sent_at timestamptz,
  message_id text, in_reply_to text, conversation_id text,
  body_excerpt text,
  document_id uuid references jf_documents(id),       -- the saved .eml / .msg file
  attachment_count int not null default 0,
  source text not null check (source in ('button', 'upload', 'mailbox')),
  created_by uuid references users(id), created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists em_file_idx on email_messages (job_file_id, coalesce(sent_at, created_at) desc);
create unique index if not exists em_msgid_uq on email_messages (job_file_id, message_id) where message_id is not null;
alter table jf_documents add column if not exists email_id uuid references email_messages(id);   -- attachment taken from an email

-- ------------------------------------------------------------ Customer Service retired (role kept, history kept)
alter table roles add column if not exists retired_at timestamptz;
update roles set retired_at = now() where code = 'customer_service' and retired_at is null;

-- ------------------------------------------------------------ history only grows (function from 018)
do $$ declare t text; begin
  foreach t in array array['quote_term_template_history', 'email_template_history'] loop
    execute format('drop trigger if exists %I on %I', t || '_append_only', t);
    execute format('create trigger %I before update or delete on %I for each row execute function history_is_append_only()', t || '_append_only', t);
  end loop;
end $$;

-- ------------------------------------------------------------ permissions
insert into permissions (code, module, name, sensitivity) values
  ('templates.manage', 'Commercial', 'Maintain quotation terms and email templates', 'general'),
  ('emails.view', 'Commercial', 'See the emails saved on a shipment', 'general')
on conflict (code) do nothing;
insert into role_permissions (role_id, permission_code)
  select r.id, 'templates.manage' from roles r where r.code in ('commercials_manager')
union all
  select r.id, 'emails.view' from roles r where r.code in ('commercials_manager', 'sales', 'coordinator', 'agent_coordinator',
    'operations_manager', 'freight_ops', 'operations', 'documentation_manager')
on conflict do nothing;

alter table notification_prefs enable row level security;
alter table quote_term_templates enable row level security;
alter table quote_term_template_history enable row level security;
alter table email_templates enable row level security;
alter table email_template_history enable row level security;
alter table email_messages enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on notification_prefs, quote_term_templates, quote_term_template_history, email_templates, email_template_history, email_messages from anon, authenticated';
    execute 'revoke all on sequence quote_term_template_history_id_seq, email_template_history_id_seq from anon, authenticated';
  end if;
end $$;

insert into schema_migrations (name) values ('020_notifications_templates_emails.sql') on conflict do nothing;
