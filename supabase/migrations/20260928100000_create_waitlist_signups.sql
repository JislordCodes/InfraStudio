-- Landing-page waitlist / design-partner signups (InfraStudio/api/waitlist.js).
-- RLS is enabled with NO policies on purpose: the anon key can neither read nor
-- write this table (it holds real names/emails). Only the Vercel functions,
-- which use the service-role key, touch it.
create table if not exists public.waitlist_signups (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  submitted_at timestamptz,
  type         text not null default 'early-access' check (type in ('early-access', 'design-partner')),
  name         text not null,
  email        text not null,
  profession   text not null,
  company      text not null default '',
  notes        text not null default '',
  user_agent   text
);

-- One row per person: resubmitting the same email is a no-op, not a duplicate
-- (and not a duplicate notification email).
create unique index if not exists waitlist_signups_email_key
  on public.waitlist_signups (lower(email));

create index if not exists waitlist_signups_created_at_idx
  on public.waitlist_signups (created_at desc);

alter table public.waitlist_signups enable row level security;
