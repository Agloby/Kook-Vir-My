-- Google Maps credentials now live only in the maps-proxy Edge Function secret.
alter table public.households drop column if exists maps_api_key;
