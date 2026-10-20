-- Update for an EXISTING Chosen Generation Rides database (20 Oct 2026, evening):
-- remembers whether a home was located with the phone ('gps') or by a pin placed by hand ('pin').
-- Supabase -> SQL Editor -> New query -> paste ALL of this -> Run. Safe to run more than once.

alter table profiles drop constraint if exists profiles_geo_source_check;
alter table profiles add constraint profiles_geo_source_check check (geo_source in ('verified', 'address', 'neighbourhood', 'manual', 'gps', 'pin', 'none'));

select 'Phone locations are ready.' as result;
