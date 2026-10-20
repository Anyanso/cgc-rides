-- Update for an EXISTING Chosen Generation Rides database (20 Oct 2026, afternoon):
-- last-minute ride requests that drivers answer in the app, and cancelled riders leaving the plan.
-- Supabase -> SQL Editor -> New query -> paste ALL of this -> Run. Safe to run more than once.

-- ---------------------------------------------------------------- last-minute requests (asked in the app)
-- The leader asks chosen cleared drivers to pick up someone at the last minute. Each driver sees
-- the request on their dashboard and answers Yes or No. The FIRST yes gets the ride; only that
-- driver then sees the address and phone. Drivers reach this only through the functions below.
create table if not exists help_requests (
  id            uuid primary key default gen_random_uuid(),
  sunday        date not null,
  rider_name    text not null,
  rider_phone   text,
  address       text not null,
  neighbourhood text,
  postal_code   text,
  lat           double precision,
  lng           double precision,
  seats         int not null default 1 check (seats between 1 and 10),
  pickup_min    int,
  status        text not null default 'open' check (status in ('open', 'covered', 'cancelled')),
  accepted_by   uuid references profiles (id) on delete set null,
  accepted_at   timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists help_asks (
  request_id  uuid not null references help_requests (id) on delete cascade,
  driver_id   uuid not null references profiles (id) on delete cascade,
  away_min    int,
  answer      text check (answer in ('yes', 'no')),
  answered_at timestamptz,
  primary key (request_id, driver_id)
);

alter table help_requests enable row level security;
alter table help_asks     enable row level security;
drop policy if exists help_requests_leader on help_requests;
drop policy if exists help_asks_leader on help_asks;
create policy help_requests_leader on help_requests for all using (is_leader()) with check (is_leader());
create policy help_asks_leader     on help_asks     for all using (is_leader()) with check (is_leader());

-- A driver's last-minute requests. The address and phone appear ONLY once this driver has the ride.
drop function if exists my_help_requests();
create function my_help_requests()
returns table (id uuid, sunday date, rider_name text, neighbourhood text, seats int, pickup_min int, away_min int,
               status text, my_answer text, mine boolean, address text, rider_phone text)
language sql stable security definer set search_path = public, pg_temp as $$
  select h.id, h.sunday, split_part(h.rider_name, ' ', 1), h.neighbourhood, h.seats, h.pickup_min, k.away_min,
         h.status, k.answer, coalesce(h.accepted_by = me.id, false),
         case when h.accepted_by = me.id then h.address end,
         case when h.accepted_by = me.id then h.rider_phone end
  from help_asks k
  join help_requests h on h.id = k.request_id
  join profiles me on me.id = k.driver_id and me.user_id = auth.uid()
  where h.sunday >= today_regina() and h.status <> 'cancelled'
  order by h.created_at desc
$$;

-- A driver answers. The first yes gets the ride (the row is locked, so two yeses can't both win).
-- Returns 'accepted', 'taken' (someone else was first), 'cancelled' or 'noted' (a no).
create or replace function answer_help(p_request uuid, p_answer text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; h help_requests;
begin
  if p_answer not in ('yes', 'no') then raise exception 'Please answer yes or no.'; end if;
  select * into me from profiles where user_id = auth.uid();
  if not found or not exists (select 1 from help_asks where request_id = p_request and driver_id = me.id) then
    raise exception 'This request was not sent to you.';
  end if;
  select * into h from help_requests where id = p_request for update;
  update help_asks set answer = p_answer, answered_at = now() where request_id = p_request and driver_id = me.id;
  if p_answer = 'no' then return 'noted'; end if;
  if h.status = 'cancelled' then return 'cancelled'; end if;
  if h.status = 'covered' then return case when h.accepted_by = me.id then 'accepted' else 'taken' end; end if;
  update help_requests set status = 'covered', accepted_by = me.id, accepted_at = now() where id = p_request;
  insert into alerts (kind, sunday, driver_id, message)
  values ('info', h.sunday, me.id, me.full_name || ' said yes: they will pick up ' || h.rider_name ||
          ' on ' || to_char(h.sunday, 'FMDay, FMMonth FMDD') || '.');
  return 'accepted';
end $$;

-- When a rider cancels, they come OUT of that Sunday's plan (seat and waiting list), and the
-- leader gets an alert naming the driver. If they ask again later, they are a NEW request: the
-- leader must approve them back in, so the driver is always told. Asking again closes the alert.
create or replace function alert_on_rider_cancel() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare nm text; dn text; seat record;
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    select x.driver_id, x.pickup_min into seat from assignments x join plans p on p.id = x.plan_id
     where p.sunday = new.sunday and x.rider_id = new.rider_id order by x.trip limit 1;
    delete from assignments x using plans p where p.id = x.plan_id and p.sunday = new.sunday and x.rider_id = new.rider_id;
    delete from waitlist w using plans p where p.id = w.plan_id and p.sunday = new.sunday and w.rider_id = new.rider_id;
    if seat.driver_id is not null then
      select full_name into nm from profiles where id = new.rider_id;
      select full_name into dn from profiles where id = seat.driver_id;
      insert into alerts (kind, sunday, rider_id, driver_id, message)
      values ('rider_cancel', new.sunday, new.rider_id, seat.driver_id,
        nm || ' cancelled their ride for ' || to_char(new.sunday, 'FMDay, FMMonth FMDD') || '. They were in ' || dn || '''s car'
        || coalesce(' (pickup ' || to_char(time '00:00' + make_interval(mins => seat.pickup_min), 'FMHH12:MI AM') || ')', '') || '.');
    end if;
  elsif new.status <> 'cancelled' and old.status = 'cancelled' then
    update alerts set resolved = true
     where kind = 'rider_cancel' and rider_id = new.rider_id and sunday = new.sunday and not resolved;
  end if;
  return new;
end $$;

grant select, insert, update, delete on help_requests, help_asks to authenticated;
revoke all on help_requests, help_asks from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
