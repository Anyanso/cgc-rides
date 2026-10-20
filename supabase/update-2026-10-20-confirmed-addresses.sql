-- Update for an EXISTING Chosen Generation Rides database (20 Oct 2026):
-- confirmed addresses, postal codes, and driver "leave by" times.
-- Supabase -> SQL Editor -> New query -> paste ALL of this -> Run. Safe to run more than once.
-- New projects don't need this: schema.sql already includes it.

alter table profiles add column if not exists postal_code text;
alter table profiles drop constraint if exists profiles_geo_source_check;
alter table profiles add constraint profiles_geo_source_check
  check (geo_source in ('verified', 'address', 'neighbourhood', 'manual', 'none'));
alter table assignments add column if not exists depart_min int;

drop function if exists my_route(date);
create function my_route(p_sunday date)
returns table (trip int, stop_order int, pickup_min int, ready_by_min int, arrive_min int, depart_min int,
               rider_name text, rider_phone text, address text, neighbourhood text,
               lat double precision, lng double precision,
               minor boolean,
               rider_notes text, request_note text, ride_home boolean, extra_people int, seats int, party_total int)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.trip, a.stop_order, a.pickup_min, a.ready_by_min, a.arrive_min, a.depart_min,
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

  insert into assignments (plan_id, rider_id, driver_id, trip, stop_order, pickup_min, ready_by_min, arrive_min, depart_min, seats)
  select pid, (e ->> 'riderId')::uuid, (e ->> 'driverId')::uuid, coalesce((e ->> 'trip')::int, 1),
         coalesce((e ->> 'order')::int, 0), (e ->> 'pickupMin')::int, (e ->> 'readyByMin')::int, (e ->> 'arriveMin')::int,
         (e ->> 'departMin')::int,
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


revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;

-- Everyone registered before today has an UNCONFIRMED address (it was never checked to the
-- house number). They are shown a "Please confirm your home address" message and are not
-- matched until they do. To see who still needs to:
--   select full_name, role, home_address, geo_source from profiles where coalesce(geo_source, 'none') not in ('verified', 'manual');
