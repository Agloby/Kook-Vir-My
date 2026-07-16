-- Supabase performance advisor: every RLS policy below calls auth.uid() (or a subquery using
-- it) directly, which Postgres re-evaluates once per row scanned rather than once per query.
-- Wrapping it as (select auth.uid()) lets the planner treat it as a stable subquery instead -
-- same access rules, no behaviour change, just avoids per-row re-evaluation at scale.
-- Also adds covering indexes for foreign keys the advisor flagged as unindexed.

drop policy if exists "members can read their household" on public.households;
create policy "members can read their household" on public.households
  for select
  using (id in (select household_id from public.household_members where user_id = (select auth.uid())));

drop policy if exists "members can update their household" on public.households;
create policy "members can update their household" on public.households
  for update
  using (id in (select household_id from public.household_members where user_id = (select auth.uid())))
  with check (id in (select household_id from public.household_members where user_id = (select auth.uid())));

drop policy if exists "read own membership rows" on public.household_members;
create policy "read own membership rows" on public.household_members
  for select
  using (user_id = (select auth.uid()));

drop policy if exists "household pantry" on public.pantry_items;
create policy "household pantry" on public.pantry_items
  for all
  using (household_id in (select household_id from public.household_members where user_id = (select auth.uid())))
  with check (household_id in (select household_id from public.household_members where user_id = (select auth.uid())));

drop policy if exists "household recipes" on public.recipes;
create policy "household recipes" on public.recipes
  for all
  using (household_id in (select household_id from public.household_members where user_id = (select auth.uid())))
  with check (household_id in (select household_id from public.household_members where user_id = (select auth.uid())));

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

drop policy if exists "household shops" on public.shops;
create policy "household shops" on public.shops
  for all
  using (household_id in (select household_id from public.household_members where user_id = (select auth.uid())))
  with check (household_id in (select household_id from public.household_members where user_id = (select auth.uid())));

drop policy if exists "household ingredient prices" on public.ingredient_prices;
create policy "household ingredient prices" on public.ingredient_prices
  for all
  using (household_id in (select household_id from public.household_members where user_id = (select auth.uid())))
  with check (household_id in (select household_id from public.household_members where user_id = (select auth.uid())));

drop policy if exists "household leftovers" on public.leftovers;
create policy "household leftovers" on public.leftovers
  for all
  using (household_id in (select household_id from public.household_members where user_id = (select auth.uid())))
  with check (household_id in (select household_id from public.household_members where user_id = (select auth.uid())));

drop policy if exists "household shopping lists" on public.shopping_lists;
create policy "household shopping lists" on public.shopping_lists
  for all
  using (household_id in (select household_id from public.household_members where user_id = (select auth.uid())))
  with check (household_id in (select household_id from public.household_members where user_id = (select auth.uid())));

drop policy if exists "household shopping list items" on public.shopping_list_items;
create policy "household shopping list items" on public.shopping_list_items
  for all
  using (household_id in (select household_id from public.household_members where user_id = (select auth.uid())))
  with check (household_id in (select household_id from public.household_members where user_id = (select auth.uid())));

drop policy if exists "household meal plans" on public.meal_plans;
create policy "household meal plans" on public.meal_plans
  for all
  using (household_id in (select household_id from public.household_members where user_id = (select auth.uid())))
  with check (household_id in (select household_id from public.household_members where user_id = (select auth.uid())));

drop policy if exists "household meal plan items" on public.meal_plan_items;
create policy "household meal plan items" on public.meal_plan_items
  for all
  using (household_id in (select household_id from public.household_members where user_id = (select auth.uid())))
  with check (household_id in (select household_id from public.household_members where user_id = (select auth.uid())));

drop policy if exists "read household feedback tags" on public.recipe_feedback_tags;
create policy "read household feedback tags" on public.recipe_feedback_tags
  for select
  using (recipe_id in (
    select id from public.recipes
    where household_id in (select household_id from public.household_members where user_id = (select auth.uid()))
  ));

drop policy if exists "insert own feedback tags" on public.recipe_feedback_tags;
create policy "insert own feedback tags" on public.recipe_feedback_tags
  for insert
  with check (
    profile_id = (select auth.uid())
    and recipe_id in (
      select id from public.recipes
      where household_id in (select household_id from public.household_members where user_id = (select auth.uid()))
    )
  );

drop policy if exists "delete own feedback tags" on public.recipe_feedback_tags;
create policy "delete own feedback tags" on public.recipe_feedback_tags
  for delete
  using (profile_id = (select auth.uid()));

drop policy if exists "delete own ratings" on public.recipe_ratings;
create policy "delete own ratings" on public.recipe_ratings
  for delete
  using (profile_id = (select auth.uid()));

drop policy if exists "insert own ratings" on public.recipe_ratings;
create policy "insert own ratings" on public.recipe_ratings
  for insert
  with check (profile_id = (select auth.uid()));

drop policy if exists "update own ratings" on public.recipe_ratings;
create policy "update own ratings" on public.recipe_ratings
  for update
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

drop policy if exists "read household ratings" on public.recipe_ratings;
create policy "read household ratings" on public.recipe_ratings
  for select
  using (recipe_id in (
    select id from public.recipes
    where household_id in (select household_id from public.household_members where user_id = (select auth.uid()))
  ));

-- Missing covering indexes on foreign keys (advisor: unindexed_foreign_keys).
create index if not exists leftovers_recipe_id_idx on public.leftovers (recipe_id);
create index if not exists meal_plan_items_leftover_id_idx on public.meal_plan_items (leftover_id);
create index if not exists meal_plan_items_recipe_id_idx on public.meal_plan_items (recipe_id);
create index if not exists recipe_feedback_tags_profile_id_idx on public.recipe_feedback_tags (profile_id);
create index if not exists recipe_ratings_profile_id_idx on public.recipe_ratings (profile_id);
create index if not exists recipes_household_id_idx on public.recipes (household_id);
create index if not exists shopping_list_items_household_id_idx on public.shopping_list_items (household_id);
create index if not exists shopping_list_items_pantry_item_id_idx on public.shopping_list_items (pantry_item_id);
create index if not exists shopping_list_items_recipe_id_idx on public.shopping_list_items (recipe_id);
create index if not exists shopping_lists_created_by_idx on public.shopping_lists (created_by);
create index if not exists shops_household_id_idx on public.shops (household_id);
