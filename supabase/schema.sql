-- Chosen Generation Rides: database setup for Supabase (free tier).
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
-- It is safe to run again later (everything is "create if not exists" or "create or replace").
--
-- THE PRIVACY MODEL (enforced here, in the database, not just in the screens):
--   * Leader: sees and edits everything.
--   * Everyone else: can read and edit ONLY their own profile, requests and availability.
--   * Nobody but the leader can read another person's row directly. A driver gets their
--     riders' pickup details, and a rider gets their driver's name and phone, only through
--     the functions below (my_route, my_rides), and only after the leader has approved the plan.
--   * Nobody can make themselves a leader, clear themselves as a driver, or edit their own
--     vetting notes (the protect_profile trigger undoes it).
--   * The plan cannot be saved with a driver the leader hasn't cleared, or more riders than seats.
--   * Vetting is the leader's job: a driver gets riders only once the leader sets them to
--     "cleared". Licence, insurance and police-check dates are optional notes for the leader.
-- Time zone: Saskatchewan is on Central Standard Time all year (America/Regina).


-- ---------------------------------------------------------------- tables

create table if not exists profiles (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid unique references auth.users (id) on delete set null,  -- null = added by the leader (phoned in)
  email              text,
  full_name          text not null,
  phone              text,
  role               text not null default 'rider' check (role in ('rider', 'driver', 'leader')),
  gender             text check (gender in ('F', 'M')),
  home_address       text,
  neighbourhood      text,
  lat                double precision,
  lng                double precision,
  geo_source         text check (geo_source in ('address', 'neighbourhood', 'manual', 'none')),
  -- rider details
  minor              boolean not null default false,
  priority           boolean not null default false,          -- leader sets (e.g. seniors, no other way to church)
  weekly_checkin     boolean not null default false,          -- asks each week "Do you need a ride?"; silence = no ride
  notes              text,                                    -- e.g. "uses a walker"
  -- driver details
  seats              int not null default 0 check (seats >= 0 and seats <= 14),
  drives_every_week  boolean not null default false,
  second_trip        boolean not null default false,
  vehicle            text,
  driver_status      text not null default 'none' check (driver_status in ('none', 'pending', 'cleared', 'suspended')),
  licence_ok         boolean not null default false,
  insurance_ok       boolean not null default false,
  police_check_expiry date,
  -- text-message consent (CASL)
  texts_consent_at   timestamptz,
  texts_consent_withdrawn_at timestamptz,
  created_at         timestamptz not null default now()
);

create table if not exists consent_log (
  id          bigint generated always as identity primary key,
  profile_id  uuid not null references profiles (id) on delete cascade,
  kind        text not null check (kind in ('given', 'withdrawn')),
  wording     text,                                           -- the exact words they agreed to
  recorded_by uuid references profiles (id) on delete set null,
  at          timestamptz not null default now()
);

create table if not exists driver_weeks (
  driver_id uuid not null references profiles (id) on delete cascade,
  sunday    date not null,
  available boolean not null,
  note      text,
  primary key (driver_id, sunday)
);

create table if not exists ride_requests (
  id         uuid primary key default gen_random_uuid(),
  rider_id   uuid not null references profiles (id) on delete cascade,
  sunday     date not null check (extract(dow from sunday) = 0),
  ride_home  boolean not null default false,
  extra_people int not null default 0 check (extra_people between 0 and 10),  -- people coming with the rider; each needs a seat
  can_split  boolean not null default false,   -- OK to seat the group in different cars if no single car fits
  note       text,
  status     text not null default 'requested' check (status in ('requested', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (rider_id, sunday)
);

create table if not exists plans (
  id          uuid primary key default gen_random_uuid(),
  sunday      date not null unique check (extract(dow from sunday) = 0),
  status      text not null default 'draft' check (status in ('draft', 'approved')),
  summary     jsonb not null default '{}'::jsonb,
  approved_at timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists assignments (
  id            uuid primary key default gen_random_uuid(),
  plan_id       uuid not null references plans (id) on delete cascade,
  rider_id      uuid not null references profiles (id) on delete cascade,
  driver_id     uuid not null references profiles (id) on delete restrict,
  trip          int not null default 1 check (trip in (1, 2)),
  stop_order    int not null default 0,
  pickup_min    int,        -- minutes after midnight
  ready_by_min  int,
  arrive_min    int,
  seats         int not null default 1 check (seats >= 1),   -- people in this car (rider plus anyone with them)
  unique (plan_id, rider_id, driver_id, trip)
);

create table if not exists waitlist (
  plan_id  uuid not null references plans (id) on delete cascade,
  rider_id uuid not null references profiles (id) on delete cascade,
  reason   text,
  seats    int not null default 1,   -- seats still needed
  primary key (plan_id, rider_id)
);

create table if not exists alerts (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('driver_cancel', 'rider_cancel', 'info')),
  sunday     date,
  driver_id  uuid references profiles (id) on delete cascade,
  rider_id   uuid references profiles (id) on delete cascade,
  message    text not null,
  resolved   boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists assignments_driver_idx on assignments (driver_id);
create index if not exists requests_sunday_idx on ride_requests (sunday);

-- ---------------------------------------------------------------- helpers

create or replace function today_regina() returns date
language sql stable as $$ select (now() at time zone 'America/Regina')::date $$;

-- These read profiles as the table owner, so they work inside row-level-security rules.
create or replace function is_leader() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from profiles where user_id = auth.uid() and role = 'leader')
$$;

create or replace function my_profile_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from profiles where user_id = auth.uid()
$$;

-- ---------------------------------------------------------------- protect privileged columns

create or replace function protect_profile() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- The SQL editor / server admin and the leader may change anything.
  if current_user in ('postgres', 'supabase_admin', 'service_role') or is_leader() then
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

drop trigger if exists protect_profile_trg on profiles;
create trigger protect_profile_trg before insert or update on profiles
  for each row execute function protect_profile();

-- ---------------------------------------------------------------- ride request rules

create or replace function check_request() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare closes timestamptz;
begin
  if current_user in ('postgres', 'supabase_admin', 'service_role') or is_leader() then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    new.rider_id := old.rider_id;
    new.sunday := old.sunday;
    if new.status = 'cancelled' then return new; end if;   -- a rider can always say "I can't make it"
  end if;
  closes := ((new.sunday - 1)::timestamp + interval '12 hours') at time zone 'America/Regina';
  if new.sunday > today_regina() + 42 then
    raise exception 'That Sunday is too far ahead to request a ride.';
  end if;
  if now() >= closes then
    raise exception 'Requests for % closed on Saturday at noon. Please contact the transport leader.', new.sunday;
  end if;
  return new;
end $$;

drop trigger if exists check_request_trg on ride_requests;
create trigger check_request_trg before insert or update on ride_requests
  for each row execute function check_request();

-- When a rider with a seat cancels, the leader gets an alert.
create or replace function alert_on_rider_cancel() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare nm text;
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' and exists (
    select 1 from assignments a join plans p on p.id = a.plan_id
    where p.sunday = new.sunday and a.rider_id = new.rider_id
  ) then
    select full_name into nm from profiles where id = new.rider_id;
    insert into alerts (kind, sunday, rider_id, message)
    values ('rider_cancel', new.sunday, new.rider_id, nm || ' can''t make it on ' || new.sunday || ' and had a seat.');
  end if;
  return new;
end $$;

drop trigger if exists alert_on_rider_cancel_trg on ride_requests;
create trigger alert_on_rider_cancel_trg after update on ride_requests
  for each row execute function alert_on_rider_cancel();

-- ---------------------------------------------------------------- row-level security

alter table profiles      enable row level security;
alter table consent_log   enable row level security;
alter table driver_weeks  enable row level security;
alter table ride_requests enable row level security;
alter table plans         enable row level security;
alter table assignments   enable row level security;
alter table waitlist      enable row level security;
alter table alerts        enable row level security;

drop policy if exists profiles_select on profiles;
drop policy if exists profiles_insert on profiles;
drop policy if exists profiles_update on profiles;
drop policy if exists profiles_delete on profiles;
create policy profiles_select on profiles for select using (user_id = auth.uid() or is_leader());
create policy profiles_insert on profiles for insert with check (user_id = auth.uid() or is_leader());
create policy profiles_update on profiles for update using (user_id = auth.uid() or is_leader())
                                                      with check (user_id = auth.uid() or is_leader());
create policy profiles_delete on profiles for delete using (is_leader());

drop policy if exists requests_select on ride_requests;
drop policy if exists requests_insert on ride_requests;
drop policy if exists requests_update on ride_requests;
drop policy if exists requests_delete on ride_requests;
create policy requests_select on ride_requests for select using (rider_id = my_profile_id() or is_leader());
create policy requests_insert on ride_requests for insert with check (rider_id = my_profile_id() or is_leader());
create policy requests_update on ride_requests for update using (rider_id = my_profile_id() or is_leader())
                                                       with check (rider_id = my_profile_id() or is_leader());
create policy requests_delete on ride_requests for delete using (is_leader());

drop policy if exists weeks_all on driver_weeks;
create policy weeks_all on driver_weeks for all
  using (driver_id = my_profile_id() or is_leader())
  with check (driver_id = my_profile_id() or is_leader());

-- Leader-only tables. Everyone else reaches this data only through the functions below.
drop policy if exists plans_leader on plans;
drop policy if exists assignments_leader on assignments;
drop policy if exists waitlist_leader on waitlist;
drop policy if exists alerts_leader on alerts;
drop policy if exists consent_leader on consent_log;
create policy plans_leader       on plans       for all using (is_leader()) with check (is_leader());
create policy assignments_leader on assignments for all using (is_leader()) with check (is_leader());
create policy waitlist_leader    on waitlist    for all using (is_leader()) with check (is_leader());
create policy alerts_leader      on alerts      for all using (is_leader()) with check (is_leader());
create policy consent_leader     on consent_log for select using (is_leader());

-- ---------------------------------------------------------------- functions the app calls

-- A rider's own requests, with driver details ONLY once the leader has approved the plan.
-- A group split across cars comes back as one row per car.
create or replace function my_rides()
returns table (sunday date, status text, ride_home boolean, note text, extra_people int, can_split boolean,
               driver_name text, driver_phone text, vehicle text,
               seats int, trip int, pickup_min int, ready_by_min int, arrive_min int, waitlisted_seats int)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.sunday,
         case when r.status = 'cancelled' then 'cancelled'
              when p.status = 'approved' and a.id is not null then 'seated'
              when p.status = 'approved' and w.rider_id is not null then 'waitlisted'
              else 'requested' end,
         r.ride_home, r.note, r.extra_people, r.can_split,
         case when r.status <> 'cancelled' and p.status = 'approved' then d.full_name end,
         case when r.status <> 'cancelled' and p.status = 'approved' then d.phone end,
         case when r.status <> 'cancelled' and p.status = 'approved' then d.vehicle end,
         case when r.status <> 'cancelled' and p.status = 'approved' then a.seats end,
         case when r.status <> 'cancelled' and p.status = 'approved' then a.trip end,
         case when r.status <> 'cancelled' and p.status = 'approved' then a.pickup_min end,
         case when r.status <> 'cancelled' and p.status = 'approved' then a.ready_by_min end,
         case when r.status <> 'cancelled' and p.status = 'approved' then a.arrive_min end,
         case when r.status <> 'cancelled' and p.status = 'approved' then w.seats end
  from ride_requests r
  join profiles me on me.id = r.rider_id and me.user_id = auth.uid()
  left join plans p on p.sunday = r.sunday
  left join assignments a on a.plan_id = p.id and a.rider_id = r.rider_id
  left join profiles d on d.id = a.driver_id
  left join waitlist w on w.plan_id = p.id and w.rider_id = r.rider_id
  where r.sunday >= today_regina()
  order by r.sunday, a.trip, a.stop_order
$$;

-- A driver's pickup list for one Sunday: ONLY their own riders, ONLY after approval.
create or replace function my_route(p_sunday date)
returns table (trip int, stop_order int, pickup_min int, ready_by_min int, arrive_min int,
               rider_name text, rider_phone text, address text, neighbourhood text,
               lat double precision, lng double precision,
               minor boolean,
               rider_notes text, request_note text, ride_home boolean, extra_people int, seats int, party_total int)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.trip, a.stop_order, a.pickup_min, a.ready_by_min, a.arrive_min,
         r.full_name, r.phone, r.home_address, r.neighbourhood, r.lat, r.lng,
         r.minor,
         r.notes, q.note, coalesce(q.ride_home, false), coalesce(q.extra_people, 0), a.seats, 1 + coalesce(q.extra_people, 0)
  from assignments a
  join plans p on p.id = a.plan_id and p.status = 'approved' and p.sunday = p_sunday
  join profiles me on me.id = a.driver_id and me.user_id = auth.uid()
  join profiles r on r.id = a.rider_id
  left join ride_requests q on q.rider_id = a.rider_id and q.sunday = p.sunday
  where coalesce(q.status, 'requested') <> 'cancelled'
  order by a.trip, a.stop_order
$$;

-- "I can't make it." Marks the driver unavailable and alerts the leader. Returns riders affected.
create or replace function driver_cant_make_it(p_sunday date, p_note text default null)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; n int;
begin
  select * into me from profiles where user_id = auth.uid() and (role = 'driver' or (role = 'leader' and seats > 0));
  if not found then raise exception 'Only drivers can use this.'; end if;
  insert into driver_weeks (driver_id, sunday, available, note) values (me.id, p_sunday, false, p_note)
  on conflict (driver_id, sunday) do update set available = false, note = excluded.note;
  select count(*) into n from assignments a join plans p on p.id = a.plan_id
   where p.sunday = p_sunday and a.driver_id = me.id;
  insert into alerts (kind, sunday, driver_id, message)
  values ('driver_cancel', p_sunday, me.id,
          me.full_name || ' can''t make it on ' || p_sunday || '. ' || n || ' rider(s) need a new ride.'
          || coalesce(' Note: ' || p_note, ''));
  return n;
end $$;

-- Record (or withdraw) consent to receive texts. Wording is stored with the date.
-- Leader may record it for someone who agreed by phone (pass their profile id).
create or replace function give_text_consent(p_wording text, p_profile uuid default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare target uuid; actor uuid := my_profile_id();
begin
  if p_profile is not null and p_profile <> actor then
    if not is_leader() then raise exception 'Only the leader can record consent for someone else.'; end if;
    target := p_profile;
  else
    target := actor;
  end if;
  if target is null then raise exception 'Create your profile first.'; end if;
  update profiles set texts_consent_at = now(), texts_consent_withdrawn_at = null where id = target;
  insert into consent_log (profile_id, kind, wording, recorded_by) values (target, 'given', p_wording, actor);
end $$;

create or replace function withdraw_text_consent(p_profile uuid default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare target uuid; actor uuid := my_profile_id();
begin
  if p_profile is not null and p_profile <> actor then
    if not is_leader() then raise exception 'Only the leader can do this for someone else.'; end if;
    target := p_profile;
  else
    target := actor;
  end if;
  update profiles set texts_consent_at = null, texts_consent_withdrawn_at = now() where id = target;
  insert into consent_log (profile_id, kind, recorded_by) values (target, 'withdrawn', actor);
end $$;

-- Leader saves a whole plan in one step (draft or approved). Safety rules are checked here.
-- p_assignments: [{"riderId","driverId","trip","order","pickupMin","readyByMin","arriveMin"}]
-- p_waitlist:    [{"riderId","reason"}]
create or replace function save_plan(p_sunday date, p_status text, p_summary jsonb,
                                     p_assignments jsonb, p_waitlist jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare pid uuid;
begin
  if not is_leader() then raise exception 'Only the transport leader can save a plan.'; end if;
  if p_status not in ('draft', 'approved') then raise exception 'Status must be draft or approved.'; end if;

  insert into plans (sunday, status, summary, approved_at)
  values (p_sunday, p_status, coalesce(p_summary, '{}'::jsonb), case when p_status = 'approved' then now() end)
  on conflict (sunday) do update
    set status = excluded.status,
        summary = excluded.summary,
        approved_at = case when excluded.status = 'approved' then coalesce(plans.approved_at, now()) end
  returning id into pid;

  delete from assignments where plan_id = pid;
  delete from waitlist where plan_id = pid;

  insert into assignments (plan_id, rider_id, driver_id, trip, stop_order, pickup_min, ready_by_min, arrive_min, seats)
  select pid, (e ->> 'riderId')::uuid, (e ->> 'driverId')::uuid, coalesce((e ->> 'trip')::int, 1),
         coalesce((e ->> 'order')::int, 0), (e ->> 'pickupMin')::int, (e ->> 'readyByMin')::int, (e ->> 'arriveMin')::int,
         greatest(coalesce((e ->> 'seats')::int, 1), 1)
  from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) e;

  insert into waitlist (plan_id, rider_id, reason, seats)
  select pid, (e ->> 'riderId')::uuid, e ->> 'reason', greatest(coalesce((e ->> 'seats')::int, 1), 1)
  from jsonb_array_elements(coalesce(p_waitlist, '[]'::jsonb)) e
  on conflict do nothing;

  if exists (
    select 1 from assignments a join profiles d on d.id = a.driver_id
    where a.plan_id = pid and d.driver_status <> 'cleared'
  ) then
    raise exception 'Only cleared drivers can be given riders.';
  end if;

  if exists (
    select 1 from (
      select driver_id, trip, sum(seats) c from assignments where plan_id = pid group by 1, 2) x
    join profiles d on d.id = x.driver_id where x.c > d.seats
  ) then
    raise exception 'A car has more people than seats (counting everyone coming with each rider).';
  end if;

  return pid;
end $$;

-- ---------------------------------------------------------------- removing a person
-- The leader can remove a rider or driver (for example a test name). Their requests, weekly
-- availability, ride assignments, waitlist entries, alerts and consent records go with them.
-- If they were in a plan, that plan goes back to draft so nobody is shown a half-empty plan.
-- Leaders cannot be removed here (use the SQL Editor), and nobody can remove themselves.
-- Their sign-in (email) is kept: if they sign in again they simply register again.

create or replace function remove_person(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare victim profiles; n_plans int; n_rides int;
begin
  if not is_leader() then raise exception 'Only the transport leader can remove people.'; end if;
  select * into victim from profiles where id = p_id;
  if not found then raise exception 'That person was not found.'; end if;
  if victim.role = 'leader' then raise exception 'Leaders cannot be removed here.'; end if;
  if victim.user_id is not null and victim.user_id = auth.uid() then raise exception 'You cannot remove yourself.'; end if;

  select count(distinct plan_id), count(*) into n_plans, n_rides
    from assignments where rider_id = p_id or driver_id = p_id;

  update plans set status = 'draft', approved_at = null
   where id in (select plan_id from assignments where rider_id = p_id or driver_id = p_id);
  delete from assignments where rider_id = p_id or driver_id = p_id;
  delete from profiles where id = p_id;

  return jsonb_build_object('removed', victim.full_name, 'plansReopened', n_plans, 'ridesRemoved', n_rides);
end $$;

-- ---------------------------------------------------------------- permissions

revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

-- ---------------------------------------------------------------- make the first leader
-- 1) Sign in to the app once with your email (this creates your login).
-- 2) Run this in the SQL editor, with your own email and name:
--
--   insert into profiles (user_id, email, full_name, role)
--   select id, email, 'Your Name', 'leader' from auth.users where email = 'you@example.com'
--   on conflict (user_id) do update set role = 'leader';
--
-- To hand over to a new leader later: do the same for them, then set your own role back to 'rider'.
-- The leader's own phone number lives on their profile; nothing in the code needs changing.
