-- Update for an EXISTING Chosen Generation Rides database (20 Oct 2026, late afternoon):
-- people whose house the map doesn't list can place a pin on it (or use their phone's location).
-- Supabase -> SQL Editor -> New query -> paste ALL of this -> Run. Safe to run more than once.

alter table profiles drop constraint if exists profiles_geo_source_check;
alter table profiles add constraint profiles_geo_source_check check (geo_source in ('verified', 'address', 'neighbourhood', 'manual', 'pin', 'none'));

select 'Pins on the map are ready.' as result;
