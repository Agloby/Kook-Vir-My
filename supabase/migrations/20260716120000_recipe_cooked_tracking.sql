-- Track how many times a recipe has actually been cooked, and when it was last cooked,
-- so the Library tab can show "completed" recipes and sort by cook recency without
-- relying on ratings existing (you might cook something and not rate it yet).

alter table public.recipes
  add column if not exists times_cooked integer not null default 0,
  add column if not exists last_cooked_at timestamptz;

create index if not exists recipes_household_last_cooked_idx
  on public.recipes (household_id, last_cooked_at desc)
  where times_cooked > 0;
