-- Update for an EXISTING Chosen Generation Rides database (20 Oct 2026, late afternoon):
-- special services, joint services at a different time, and Sundays with no service.
-- Supabase -> SQL Editor -> New query -> paste ALL of this -> Run. Safe to run more than once.

-- ---------------------------------------------------------------- services
-- Every Sunday is a service at 11:45 by default and needs no row here. The leader adds a row to
-- change one day (e.g. a joint service at 10:00), to mark a Sunday as having no service, or to add
-- a special service on any day (e.g. Christmas Eve at 19:00). One service per day.
create table if not exists services (
  service_date      date primary key,
  title             text,                          -- e.g. 'Joint service'; empty = 'Sunday service'
  start_time        time not null default '11:45',
  arrive_before_min int  not null default 15 check (arrive_before_min between 0 and 90),
  cutoff            timestamptz,                   -- when ride requests close; empty = noon the day before
  cancelled         boolean not null default false,
  note              text,
  updated_at        timestamptz not null default now()
);

-- Requests and plans can now be for any service day, not only Sundays.
alter table ride_requests drop constraint if exists ride_requests_sunday_check;
alter table plans drop constraint if exists plans_sunday_check;

alter table services enable row level security;
drop policy if exists services_read on services;
drop policy if exists services_leader on services;
create policy services_read   on services for select using (auth.uid() is not null);
create policy services_leader on services for all using (is_leader()) with check (is_leader());

create or replace function check_request() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare closes timestamptz; svc services; special boolean;
begin
  if current_user in ('postgres', 'supabase_admin', 'service_role') or is_leader() then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    new.rider_id := old.rider_id;
    new.sunday := old.sunday;
    if new.status = 'cancelled' then return new; end if;   -- a rider can always say "I can't make it"
  end if;
  -- (The column is still called "sunday"; it holds the service date, which may be any day.)
  select * into svc from services where service_date = new.sunday;
  special := svc.service_date is not null;
  if special and svc.cancelled then
    raise exception 'There is no service on %. Please check the app for the next one.', to_char(new.sunday, 'FMDay, FMMonth FMDD');
  end if;
  if not special and extract(dow from new.sunday) <> 0 then
    raise exception 'There is no service on that day.';
  end if;
  if new.sunday > today_regina() + (case when special then 120 else 42 end) then
    raise exception 'That service is too far ahead to request a ride.';
  end if;
  closes := coalesce(svc.cutoff, ((new.sunday - 1)::timestamp + interval '12 hours') at time zone 'America/Regina');
  if now() >= closes then
    raise exception 'Requests for % closed on % at %. Please contact the transport leader.', to_char(new.sunday, 'FMDay, FMMonth FMDD'),
      to_char(closes at time zone 'America/Regina', 'FMDay'), to_char(closes at time zone 'America/Regina', 'FMHH12:MI AM');
  end if;
  return new;
end $$;

grant select, insert, update, delete on services to authenticated;
revoke all on services from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
