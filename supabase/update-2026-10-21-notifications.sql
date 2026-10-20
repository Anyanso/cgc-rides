-- Update for an EXISTING Chosen Generation Rides database (21 Oct 2026):
-- 1) leaders see people who signed in but never finished registering;
-- 2) phone notifications (the "send-push" Edge Function sends what this queues).
-- Supabase -> SQL Editor -> New query -> paste ALL of this -> Run. Safe to run more than once.

-- ---------------------------------------------------------------- phone notifications (web push)
-- Each phone or computer that allows notifications saves a subscription here (one row per device).
-- Messages wait in push_queue until the "send-push" Edge Function sends them (and marks them sent).
create table if not exists push_subs (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  device     text,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_profile_idx on push_subs (profile_id);

create table if not exists push_queue (
  id         bigint generated always as identity primary key,
  profile_id uuid not null references profiles (id) on delete cascade,
  title      text not null,
  body       text not null,
  tag        text,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create index if not exists push_queue_unsent_idx on push_queue (created_at) where sent_at is null;

alter table push_subs enable row level security;
alter table push_queue enable row level security;
drop policy if exists push_subs_own on push_subs;
create policy push_subs_own on push_subs for select using (profile_id in (select id from profiles where user_id = auth.uid()));
-- push_queue has no policies: only the functions below and the Edge Function (service role) use it.

-- ---------------------------------------------------------------- signed in, never registered
-- People who signed in with their email but never filled in their details. They have no profile,
-- so they don't show anywhere else in the app. Leaders only.
create or replace function unregistered_people()
returns table (email text, signed_up_at timestamptz, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_leader() then raise exception 'Only leaders can see this.'; end if;
  return query
    select u.email::text, u.created_at, u.last_sign_in_at
      from auth.users u
     where not exists (select 1 from profiles p where p.user_id = u.id)
     order by u.created_at desc;
end $$;

-- ---------------------------------------------------------------- notifications
create or replace function save_push_sub(p_endpoint text, p_p256dh text, p_auth text, p_device text default null)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid;
begin
  select id into me from profiles where user_id = auth.uid();
  if me is null then raise exception 'Finish registering first.'; end if;
  if coalesce(p_endpoint, '') !~ '^https://' then raise exception 'That notification address is not valid.'; end if;
  insert into push_subs (profile_id, endpoint, p256dh, auth, device)
  values (me, p_endpoint, p_p256dh, p_auth, left(p_device, 200))
  on conflict (endpoint) do update set profile_id = excluded.profile_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device;
  return 'ok';
end $$;

create or replace function remove_push_sub(p_endpoint text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from push_subs where endpoint = p_endpoint and profile_id in (select id from profiles where user_id = auth.uid());
  return 'ok';
end $$;

-- Leaders: who has notifications turned on (just the people, not their device details).
create or replace function push_people()
returns setof uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_leader() then raise exception 'Only leaders can see this.'; end if;
  return query select distinct profile_id from push_subs;
end $$;

-- Leaders queue messages for the people in an approved plan (the app writes them).
create or replace function queue_push(p_items jsonb)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if not is_leader() then raise exception 'Only leaders can send notifications.'; end if;
  insert into push_queue (profile_id, title, body, tag)
  select i.profile_id, left(i.title, 120), left(i.body, 400), left(i.tag, 60)
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as i(profile_id uuid, title text, body text, tag text)
   where i.profile_id is not null and coalesce(i.title, '') <> '' and coalesce(i.body, '') <> ''
     and exists (select 1 from push_subs s where s.profile_id = i.profile_id);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function push_to_leaders(p_title text, p_body text, p_tag text)
returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into push_queue (profile_id, title, body, tag)
  select p.id, p_title, left(p_body, 400), p_tag from profiles p
   where p.role = 'leader' and exists (select 1 from push_subs s where s.profile_id = p.id)
$$;

-- New alert (a cancellation, a driver who can't make it, a yes to a last-minute request) -> leaders.
create or replace function push_on_alert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform push_to_leaders(case new.kind when 'info' then 'Rides update' else 'Rides alert' end, new.message, 'alert');
  return new;
end $$;
drop trigger if exists push_on_alert_trg on alerts;
create trigger push_on_alert_trg after insert on alerts for each row execute function push_on_alert();

-- A last-minute request -> each driver asked.
create or replace function push_on_help_ask() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare h help_requests;
begin
  select * into h from help_requests where id = new.request_id;
  if found and exists (select 1 from push_subs s where s.profile_id = new.driver_id) then
    insert into push_queue (profile_id, title, body, tag)
    values (new.driver_id, 'Can you help with a ride?',
            split_part(h.rider_name, ' ', 1) || coalesce(' in ' || nullif(h.neighbourhood, ''), '') || ' needs a ride on '
              || trim(to_char(h.sunday, 'Day')) || '. Open the app to say yes or no.',
            'help-' || h.id);
  end if;
  return new;
end $$;
drop trigger if exists push_on_help_ask_trg on help_asks;
create trigger push_on_help_ask_trg after insert on help_asks for each row execute function push_on_help_ask();

-- A new driver waiting for approval -> leaders.
create or replace function push_on_new_driver() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.driver_status = 'pending' and (tg_op = 'INSERT' or old.driver_status is distinct from 'pending') then
    perform push_to_leaders('New driver to approve', new.full_name || ' registered as a driver. Check their details in People.', 'driver-' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists push_on_new_driver_trg on profiles;
create trigger push_on_new_driver_trg after insert or update of driver_status on profiles for each row execute function push_on_new_driver();

-- Used only by the send-push Edge Function (service role): takes the waiting messages, marks them
-- sent, and returns one row per device. Messages older than a day are dropped, not sent late.
create or replace function claim_push()
returns table (queue_id bigint, title text, body text, tag text, endpoint text, p256dh text, auth text)
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  delete from push_queue where created_at < now() - interval '30 days';
  update push_queue set sent_at = now() where sent_at is null and created_at < now() - interval '1 day';
  return query
    with c as (update push_queue q set sent_at = now() where q.sent_at is null returning q.id, q.profile_id, q.title, q.body, q.tag)
    select c.id, c.title, c.body, c.tag, s.endpoint, s.p256dh, s.auth from c join push_subs s on s.profile_id = c.profile_id;
end $$;

grant select, insert, update, delete on push_subs, push_queue to authenticated;
revoke all on push_subs, push_queue from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
-- The Edge Function's key (service role) may use the notification tables; nobody else may claim.
grant select, insert, update, delete on push_subs, push_queue to service_role;
revoke execute on function claim_push() from authenticated, public, anon;
grant execute on function claim_push() to service_role;

select 'Notifications are ready in the database.' as result;
