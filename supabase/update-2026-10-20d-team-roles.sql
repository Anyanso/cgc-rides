-- Update for an EXISTING Chosen Generation Rides database (20 Oct 2026, evening):
-- a supervisor who manages the leaders from the app, and can hand the role over.
-- Supabase -> SQL Editor -> New query -> paste ALL of this -> Run. Safe to run more than once.

-- ---------------------------------------------------------------- team roles
-- One SUPERVISOR (a leader who can also change who leads, and hand the role over) and at most two
-- other leaders ("Leader" and "Assistant leader"). Roles change only through set_team_role() and
-- hand_over_supervisor() below, which only the supervisor can use, and every change is logged.
alter table profiles add column if not exists is_supervisor boolean not null default false;
alter table profiles add column if not exists leader_title text;   -- 'Supervisor', 'Leader' or 'Assistant leader'
alter table profiles drop constraint if exists profiles_supervisor_is_leader;
alter table profiles add constraint profiles_supervisor_is_leader check (not is_supervisor or role = 'leader');
create unique index if not exists profiles_one_supervisor on profiles ((true)) where is_supervisor;

create table if not exists team_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid references profiles (id) on delete set null,
  actor_name  text,
  target      uuid references profiles (id) on delete set null,
  target_name text,
  change      text not null
);

create or replace function protect_profile() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- The SQL editor / server admin may change anything. (The team functions below run as the
  -- owner, so they pass here too; nobody else can change a team role.)
  if current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  -- Team roles are protected from everyone, leaders included.
  if tg_op = 'INSERT' then
    new.is_supervisor := false;
    new.leader_title := null;
    if new.role = 'leader' then new.role := 'rider'; end if;
  else
    new.is_supervisor := old.is_supervisor;
    new.leader_title := old.leader_title;
    if old.role = 'leader' or new.role = 'leader' then new.role := old.role; end if;
  end if;

  -- Leaders may change everything else.
  if is_leader() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.user_id := auth.uid();
    new.email := coalesce(auth.jwt() ->> 'email', new.email);
    if new.role not in ('rider', 'driver') then new.role := 'rider'; end if;
    new.driver_status := case when new.role = 'driver' then 'pending' else 'none' end;
    new.priority := false;
    new.licence_ok := false;
    new.insurance_ok := false;
    new.police_check_expiry := null;
    new.texts_consent_at := null;
    new.texts_consent_withdrawn_at := null;
  else
    new.user_id := old.user_id;
    new.email := old.email;
    new.priority := old.priority;
    new.licence_ok := old.licence_ok;
    new.insurance_ok := old.insurance_ok;
    new.police_check_expiry := old.police_check_expiry;
    new.texts_consent_at := old.texts_consent_at;
    new.texts_consent_withdrawn_at := old.texts_consent_withdrawn_at;
    if new.role not in ('rider', 'driver') then new.role := old.role; end if;
    new.driver_status := old.driver_status;
    if new.role = 'driver' and old.driver_status = 'none' then new.driver_status := 'pending'; end if;
  end if;
  return new;
end $$;

create or replace function is_supervisor() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from profiles where user_id = auth.uid() and is_supervisor and role = 'leader')
$$;

-- The supervisor makes someone Leader / Assistant leader, or moves them back to driver or rider.
-- A driver keeps their car details and checks. At most two leaders besides the supervisor.
create or replace function set_team_role(p_profile uuid, p_role text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; t profiles; n int; label text;
begin
  select * into me from profiles where user_id = auth.uid();
  if not found or not me.is_supervisor then raise exception 'Only the supervisor can change who leads.'; end if;
  if p_role not in ('leader', 'assistant', 'driver', 'rider') then raise exception 'Choose leader, assistant leader, driver or rider.'; end if;
  select * into t from profiles where id = p_profile for update;
  if not found then raise exception 'That person was not found.'; end if;
  if t.id = me.id then raise exception 'To change your own role, hand over the supervisor role first.'; end if;
  if t.user_id is null then raise exception '% has never signed in to the app, so they can''t lead yet. Ask them to sign in once first.', t.full_name; end if;
  if p_role in ('leader', 'assistant') then
    select count(*) into n from profiles where role = 'leader' and not is_supervisor and id <> t.id;
    if n >= 2 then raise exception 'There are already two leaders. Move one of them back to driver or rider first.'; end if;
    label := case when p_role = 'leader' then 'Leader' else 'Assistant leader' end;
    update profiles set role = 'leader', leader_title = label where id = t.id;
  else
    label := case when p_role = 'driver' then 'Driver' else 'Rider' end;
    update profiles set role = p_role, leader_title = null,
           driver_status = case when p_role = 'driver' and driver_status = 'none' then 'pending' else driver_status end
     where id = t.id;
  end if;
  insert into team_log (actor, actor_name, target, target_name, change)
  values (me.id, me.full_name, t.id, t.full_name, 'made ' || t.full_name || ' ' || lower(label));
  return label;
end $$;

-- The supervisor hands the role to one of the leaders, and chooses what they become themselves.
create or replace function hand_over_supervisor(p_profile uuid, p_my_role text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; t profiles; n int;
begin
  select * into me from profiles where user_id = auth.uid();
  if not found or not me.is_supervisor then raise exception 'Only the supervisor can hand over the role.'; end if;
  if p_my_role not in ('leader', 'assistant', 'driver', 'rider') then raise exception 'Choose what you will be: leader, assistant leader, driver or rider.'; end if;
  select * into t from profiles where id = p_profile for update;
  if not found or t.id = me.id then raise exception 'Choose someone else to hand over to.'; end if;
  if t.role <> 'leader' then raise exception 'Make % a leader first, then hand over.', t.full_name; end if;

  update profiles set is_supervisor = false where id = me.id;
  update profiles set is_supervisor = true, leader_title = 'Supervisor' where id = t.id;
  if p_my_role in ('leader', 'assistant') then
    select count(*) into n from profiles where role = 'leader' and not is_supervisor and id <> me.id;
    if n >= 2 then raise exception 'There are already two leaders, so you can''t stay a leader. Choose driver or rider.'; end if;
    update profiles set leader_title = case when p_my_role = 'leader' then 'Leader' else 'Assistant leader' end where id = me.id;
  else
    update profiles set role = p_my_role, leader_title = null,
           driver_status = case when p_my_role = 'driver' and driver_status = 'none' then 'pending' else driver_status end
     where id = me.id;
  end if;
  insert into team_log (actor, actor_name, target, target_name, change)
  values (me.id, me.full_name, t.id, t.full_name, 'handed the supervisor role to ' || t.full_name);
  return 'ok';
end $$;

alter table team_log enable row level security;
drop policy if exists team_log_read on team_log;
create policy team_log_read on team_log for select using (is_leader());

-- The first leader becomes the supervisor (only if there isn't one yet). Other leaders become "Leader".
update profiles set is_supervisor = true, leader_title = 'Supervisor'
 where id = (select id from profiles where role = 'leader' order by created_at limit 1)
   and not exists (select 1 from profiles where is_supervisor);
update profiles set leader_title = 'Leader' where role = 'leader' and not is_supervisor and leader_title is null;

grant select on team_log to authenticated;
revoke all on team_log from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;

-- Check: this shows your team. The supervisor should be you.
select full_name, email, leader_title from profiles where role = 'leader' order by is_supervisor desc, created_at;
