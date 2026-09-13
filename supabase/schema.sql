create extension if not exists pgcrypto;

create table if not exists clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  doctor_name text,
  email text,
  phone text,
  timezone text not null default 'Asia/Kuala_Lumpur',
  website_domain text,
  api_key_hash text not null unique,
  api_key_last4 text not null default '',
  whatsapp_enabled boolean not null default false,
  email_enabled boolean not null default true,
  reminder_24h boolean not null default true,
  reminder_2h boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists clinic_users (
  clinic_id uuid not null references clinics(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','staff')),
  created_at timestamptz not null default now(),
  primary key (clinic_id,user_id)
);

create table if not exists clinic_integrations (
  clinic_id uuid primary key references clinics(id) on delete cascade,
  whatsapp_phone_number_id text,
  whatsapp_access_token text,
  whatsapp_business_account_id text,
  resend_from text,
  updated_at timestamptz not null default now()
);

create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_name text not null,
  phone text,
  email text,
  appointment_at timestamptz not null,
  service text,
  notes text,
  status text not null default 'confirmed' check (status in ('confirmed','cancelled','completed','reschedule_requested','no_show')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists appointments_clinic_due_idx on appointments(clinic_id,appointment_at,status);

create table if not exists reminder_logs (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments(id) on delete cascade,
  reminder_type text not null check (reminder_type in ('confirmation','24h','2h')),
  channel text not null check (channel in ('whatsapp','email')),
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  provider_message_id text,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique(appointment_id,reminder_type,channel)
);
create index if not exists reminder_logs_created_idx on reminder_logs(created_at desc);

create table if not exists webhook_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id) on delete set null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create or replace function public.is_clinic_member(p_clinic uuid) returns boolean
language sql stable security definer set search_path=public as $$
  select exists(select 1 from clinic_users where clinic_id=p_clinic and user_id=auth.uid());
$$;

create or replace function public.create_clinic(
  p_name text, p_doctor text, p_email text, p_phone text, p_domain text
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_id uuid; v_key text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  v_key := 'cr_live_' || encode(gen_random_bytes(24),'hex');
  insert into clinics(name,doctor_name,email,phone,website_domain,api_key_hash,api_key_last4)
  values(p_name,p_doctor,p_email,p_phone,p_domain,encode(digest(v_key,'sha256'),'hex'),right(v_key,4)) returning id into v_id;
  insert into clinic_users(clinic_id,user_id,role) values(v_id,auth.uid(),'owner');
  return jsonb_build_object('clinic_id',v_id,'api_key',v_key);
end; $$;

create or replace function public.rotate_api_key(p_clinic uuid) returns text
language plpgsql security definer set search_path=public as $$
declare v_key text;
begin
  if not public.is_clinic_member(p_clinic) then raise exception 'Not authorized'; end if;
  v_key := 'cr_live_' || encode(gen_random_bytes(24),'hex');
  update clinics set api_key_hash=encode(digest(v_key,'sha256'),'hex'),api_key_last4=right(v_key,4),updated_at=now() where id=p_clinic;
  return v_key;
end; $$;

alter table clinics enable row level security;
alter table clinic_users enable row level security;
alter table clinic_integrations enable row level security;
alter table appointments enable row level security;
alter table reminder_logs enable row level security;
alter table webhook_events enable row level security;

drop policy if exists clinic_member_select on clinics;
create policy clinic_member_select on clinics for select using (public.is_clinic_member(id));
drop policy if exists clinic_member_update on clinics;
create policy clinic_member_update on clinics for update using (public.is_clinic_member(id)) with check (public.is_clinic_member(id));

drop policy if exists clinic_users_select on clinic_users;
create policy clinic_users_select on clinic_users for select using (public.is_clinic_member(clinic_id));

drop policy if exists appointments_all on appointments;
create policy appointments_all on appointments for all using (public.is_clinic_member(clinic_id)) with check (public.is_clinic_member(clinic_id));

drop policy if exists logs_select on reminder_logs;
create policy logs_select on reminder_logs for select using (exists(select 1 from appointments a where a.id=appointment_id and public.is_clinic_member(a.clinic_id)));

drop policy if exists integration_all on clinic_integrations;
create policy integration_all on clinic_integrations for all using (public.is_clinic_member(clinic_id)) with check (public.is_clinic_member(clinic_id));

drop policy if exists webhook_select on webhook_events;
create policy webhook_select on webhook_events for select using (public.is_clinic_member(clinic_id));

revoke all on function public.create_clinic(text,text,text,text,text) from public;
grant execute on function public.create_clinic(text,text,text,text,text) to authenticated;
revoke all on function public.rotate_api_key(uuid) from public;
grant execute on function public.rotate_api_key(uuid) to authenticated;
