-- Weekly meal plan (Monday-based weeks)

create table public.meal_plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  week_start date not null,
  title text,
  created_at timestamptz not null default now(),
  unique (household_id, week_start)
);

create table public.meal_plan_items (
  id uuid primary key default gen_random_uuid(),
  meal_plan_id uuid not null references public.meal_plans(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  meal_date date not null,
  meal_slot text not null check (meal_slot in ('breakfast','lunch','dinner','snack')),
  recipe_id uuid references public.recipes(id) on delete set null,
  manual_title text,
  servings int,
  use_leftovers boolean not null default false,
  leftover_id uuid references public.leftovers(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

create index meal_plan_items_plan_idx on public.meal_plan_items (meal_plan_id);
create index meal_plan_items_household_date_idx on public.meal_plan_items (household_id, meal_date);

alter table public.meal_plans enable row level security;
alter table public.meal_plan_items enable row level security;

create policy "household meal plans" on public.meal_plans
  for all
  using (household_id in (select household_id from public.household_members where user_id = auth.uid()))
  with check (household_id in (select household_id from public.household_members where user_id = auth.uid()));

create policy "household meal plan items" on public.meal_plan_items
  for all
  using (household_id in (select household_id from public.household_members where user_id = auth.uid()))
  with check (household_id in (select household_id from public.household_members where user_id = auth.uid()));
