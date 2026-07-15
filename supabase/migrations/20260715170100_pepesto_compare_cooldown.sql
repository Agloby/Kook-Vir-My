-- Nothing server-side stopped repeated "Compare"/"Refresh" clicks from re-incurring the
-- ~EUR0.12-per-click Pepesto cost; the client-side single-flight gate only prevents
-- concurrent calls from one open tab, not repeated clicks over time. Track the last
-- successful compare per list so the edge function can enforce a short cooldown.
alter table public.shopping_lists
  add column if not exists pepesto_last_compared_at timestamptz;
