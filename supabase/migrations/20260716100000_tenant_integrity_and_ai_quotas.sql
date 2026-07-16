-- Enforce tenant consistency at the database boundary. Child rows previously carried a
-- client-supplied household_id that was not required to match their parent/reference rows.

alter table public.shopping_lists add constraint shopping_lists_id_household_unique unique (id, household_id);
alter table public.meal_plans add constraint meal_plans_id_household_unique unique (id, household_id);
alter table public.recipes add constraint recipes_id_household_unique unique (id, household_id);
alter table public.pantry_items add constraint pantry_items_id_household_unique unique (id, household_id);
alter table public.leftovers add constraint leftovers_id_household_unique unique (id, household_id);

alter table public.shopping_list_items
  drop constraint if exists shopping_list_items_shopping_list_id_fkey,
  drop constraint if exists shopping_list_items_recipe_id_fkey,
  drop constraint if exists shopping_list_items_pantry_item_id_fkey,
  add constraint shopping_list_items_list_household_fkey
    foreign key (shopping_list_id, household_id)
    references public.shopping_lists (id, household_id) on delete cascade,
  add constraint shopping_list_items_recipe_household_fkey
    foreign key (recipe_id, household_id)
    references public.recipes (id, household_id) on delete set null (recipe_id),
  add constraint shopping_list_items_pantry_household_fkey
    foreign key (pantry_item_id, household_id)
    references public.pantry_items (id, household_id) on delete set null (pantry_item_id);

alter table public.meal_plan_items
  drop constraint if exists meal_plan_items_meal_plan_id_fkey,
  drop constraint if exists meal_plan_items_recipe_id_fkey,
  drop constraint if exists meal_plan_items_leftover_id_fkey,
  add constraint meal_plan_items_plan_household_fkey
    foreign key (meal_plan_id, household_id)
    references public.meal_plans (id, household_id) on delete cascade,
  add constraint meal_plan_items_recipe_household_fkey
    foreign key (recipe_id, household_id)
    references public.recipes (id, household_id) on delete set null (recipe_id),
  add constraint meal_plan_items_leftover_household_fkey
    foreign key (leftover_id, household_id)
    references public.leftovers (id, household_id) on delete set null (leftover_id);

-- Future writes are constrained immediately. NOT VALID avoids making deployment depend on
-- historical free-text data; validate these after cleaning any advisor-reported old rows.
alter table public.shopping_lists
  add constraint shopping_lists_title_length check (char_length(btrim(title)) between 1 and 120) not valid;
alter table public.shopping_list_items
  add constraint shopping_list_items_name_length check (char_length(btrim(item_name)) between 1 and 200) not valid,
  add constraint shopping_list_items_quantity_nonnegative check (quantity is null or quantity >= 0) not valid,
  add constraint shopping_list_items_text_lengths check (
    (unit is null or char_length(unit) <= 40) and
    (quantity_text is null or char_length(quantity_text) <= 100) and
    (category is null or char_length(category) <= 80) and
    (notes is null or char_length(notes) <= 500)
  ) not valid;
alter table public.meal_plan_items
  add constraint meal_plan_items_servings_range check (servings is null or servings between 1 and 100) not valid,
  add constraint meal_plan_items_text_lengths check (
    (manual_title is null or char_length(manual_title) between 1 and 200) and
    (notes is null or char_length(notes) <= 1000)
  ) not valid;
alter table public.pantry_items
  add constraint pantry_items_quantity_nonnegative check (quantity >= 0) not valid,
  add constraint pantry_items_par_nonnegative check (par_level is null or par_level >= 0) not valid;
alter table public.recipe_feedback_tags
  add constraint recipe_feedback_tags_allowed check (tag in (
    'make again','great taste','wife liked it','child liked it','good for leftovers',
    'too much effort','too many dishes','too expensive','high protein win','too bland','avoid next time'
  )) not valid;

-- Atomic per-user/day AI allowance. Edge Functions call this through the authenticated
-- user's JWT; clients cannot read or alter the backing table directly.
create table public.ai_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null default current_date,
  request_kind text not null check (request_kind in ('recipe','photo')),
  request_count integer not null default 0 check (request_count >= 0),
  primary key (user_id, usage_date, request_kind)
);
alter table public.ai_daily_usage enable row level security;

create or replace function public.consume_ai_quota(p_kind text)
returns table (allowed boolean, used integer, daily_limit integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_limit integer;
  v_used integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_kind = 'recipe' then v_limit := 20;
  elsif p_kind = 'photo' then v_limit := 10;
  else raise exception 'Invalid quota kind';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || current_date::text || p_kind, 0));
  select request_count into v_used from public.ai_daily_usage
    where user_id = v_user and usage_date = current_date and request_kind = p_kind;
  v_used := coalesce(v_used, 0);
  if v_used >= v_limit then return query select false, v_used, v_limit; return; end if;

  insert into public.ai_daily_usage (user_id, usage_date, request_kind, request_count)
    values (v_user, current_date, p_kind, 1)
    on conflict (user_id, usage_date, request_kind)
    do update set request_count = public.ai_daily_usage.request_count + 1
    returning request_count into v_used;
  return query select true, v_used, v_limit;
end;
$$;

revoke all on function public.consume_ai_quota(text) from public, anon;
grant execute on function public.consume_ai_quota(text) to authenticated;

-- Apply a reviewed set of absolute pantry quantities in one transaction. RLS-style
-- membership checks are repeated inside the SECURITY DEFINER boundary.
create or replace function public.set_pantry_quantities(p_changes jsonb)
returns setof public.pantry_items
language plpgsql
security definer
set search_path = public
as $$
declare v_change jsonb; v_id uuid; v_quantity numeric;
begin
  if auth.uid() is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 100 then
    raise exception 'Invalid pantry update';
  end if;
  for v_change in select value from jsonb_array_elements(p_changes) loop
    v_id := (v_change->>'id')::uuid; v_quantity := (v_change->>'quantity')::numeric;
    if v_quantity < 0 then raise exception 'Quantity cannot be negative'; end if;
    if not exists (
      select 1 from public.pantry_items p join public.household_members hm on hm.household_id=p.household_id
      where p.id=v_id and hm.user_id=auth.uid()
    ) then raise exception 'Pantry item is unavailable'; end if;
  end loop;
  return query
    update public.pantry_items p set quantity=(c.value->>'quantity')::numeric, updated_at=now()
    from jsonb_array_elements(p_changes) c(value)
    where p.id=(c.value->>'id')::uuid returning p.*;
end;
$$;
revoke all on function public.set_pantry_quantities(jsonb) from public, anon;
grant execute on function public.set_pantry_quantities(jsonb) to authenticated;

-- A person may only attach/update a rating against a recipe in their current household.
drop policy if exists "insert own ratings" on public.recipe_ratings;
create policy "insert own household ratings" on public.recipe_ratings for insert with check (
  profile_id = (select auth.uid()) and recipe_id in (
    select r.id from public.recipes r join public.household_members hm on hm.household_id=r.household_id
    where hm.user_id=(select auth.uid())
  )
);
drop policy if exists "update own ratings" on public.recipe_ratings;
create policy "update own household ratings" on public.recipe_ratings for update
using (profile_id=(select auth.uid())) with check (
  profile_id=(select auth.uid()) and recipe_id in (
    select r.id from public.recipes r join public.household_members hm on hm.household_id=r.household_id
    where hm.user_id=(select auth.uid())
  )
);
