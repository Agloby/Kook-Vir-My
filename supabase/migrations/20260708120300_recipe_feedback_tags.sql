-- Quick per-person feedback tags on recipes ("too expensive", "make again", ...)

create table public.recipe_feedback_tags (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  tag text not null,
  created_at timestamptz not null default now(),
  unique (recipe_id, profile_id, tag)
);

create index recipe_feedback_tags_recipe_idx on public.recipe_feedback_tags (recipe_id);

alter table public.recipe_feedback_tags enable row level security;

-- Anyone in the household can read tags on the household's recipes (both people's
-- feedback informs the AI), but you can only write/remove your own.
create policy "read household feedback tags" on public.recipe_feedback_tags
  for select
  using (recipe_id in (
    select id from public.recipes
    where household_id in (select household_id from public.household_members where user_id = auth.uid())
  ));

create policy "insert own feedback tags" on public.recipe_feedback_tags
  for insert
  with check (
    profile_id = auth.uid()
    and recipe_id in (
      select id from public.recipes
      where household_id in (select household_id from public.household_members where user_id = auth.uid())
    )
  );

create policy "delete own feedback tags" on public.recipe_feedback_tags
  for delete
  using (profile_id = auth.uid());
