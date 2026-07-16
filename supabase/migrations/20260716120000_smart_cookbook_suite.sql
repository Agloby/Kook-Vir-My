-- Smart cookbook: durable cook history, dated notes, versions, collections and sharing.

create table public.recipe_cooks (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  profile_id uuid not null references auth.users(id) on delete cascade,
  cooked_at timestamptz not null default now(),
  servings_made numeric,
  servings_eaten numeric,
  taste smallint check (taste between 1 and 5),
  convenience smallint check (convenience between 1 and 5),
  cost smallint check (cost between 1 and 5),
  serving_size smallint check (serving_size between 1 and 5),
  actual_cost numeric check (actual_cost >= 0),
  actual_minutes integer check (actual_minutes >= 0),
  comment text,
  photo_url text,
  substitutions text,
  would_make_again boolean,
  stated_time_accurate boolean,
  portions_enough boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.recipe_versions (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  name text not null,
  ingredients jsonb not null default '[]'::jsonb,
  steps jsonb not null default '[]'::jsonb,
  servings numeric,
  notes text,
  is_preferred boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.recipe_collections (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  name text not null,
  emoji text,
  created_at timestamptz not null default now(),
  unique (household_id, name)
);

create table public.recipe_collection_items (
  collection_id uuid not null references public.recipe_collections(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  added_by uuid not null references auth.users(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (collection_id, recipe_id)
);

alter table public.recipes
  add column if not exists library_status text not null default 'want_to_try'
    check (library_status in ('want_to_try','cooked','make_again','avoid')),
  add column if not exists share_token uuid,
  add column if not exists is_share_enabled boolean not null default false;

create unique index recipes_share_token_idx on public.recipes(share_token) where share_token is not null;
create index recipe_cooks_household_date_idx on public.recipe_cooks(household_id, cooked_at desc);
create index recipe_cooks_recipe_date_idx on public.recipe_cooks(recipe_id, cooked_at desc);
create index recipe_versions_recipe_idx on public.recipe_versions(recipe_id);
create index recipe_collections_household_idx on public.recipe_collections(household_id);
create index recipe_collection_items_recipe_idx on public.recipe_collection_items(recipe_id);

alter table public.recipe_cooks enable row level security;
alter table public.recipe_versions enable row level security;
alter table public.recipe_collections enable row level security;
alter table public.recipe_collection_items enable row level security;

create policy "household cook history" on public.recipe_cooks for select
  using (household_id in (select household_id from public.household_members where user_id = (select auth.uid())));
create policy "write own cook history" on public.recipe_cooks for insert
  with check (profile_id = (select auth.uid()) and household_id in (select household_id from public.household_members where user_id = (select auth.uid())));
create policy "update own cook history" on public.recipe_cooks for update
  using (profile_id = (select auth.uid())) with check (profile_id = (select auth.uid()));
create policy "delete own cook history" on public.recipe_cooks for delete using (profile_id = (select auth.uid()));

create policy "household recipe versions" on public.recipe_versions for select
  using (household_id in (select household_id from public.household_members where user_id = (select auth.uid())));
create policy "create household recipe versions" on public.recipe_versions for insert
  with check (created_by = (select auth.uid()) and household_id in (select household_id from public.household_members where user_id = (select auth.uid())));
create policy "edit own recipe versions" on public.recipe_versions for update
  using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));
create policy "delete own recipe versions" on public.recipe_versions for delete using (created_by = (select auth.uid()));

create policy "household collections" on public.recipe_collections for all
  using (household_id in (select household_id from public.household_members where user_id = (select auth.uid())))
  with check (created_by = (select auth.uid()) and household_id in (select household_id from public.household_members where user_id = (select auth.uid())));
create policy "household collection items" on public.recipe_collection_items for all
  using (collection_id in (select id from public.recipe_collections where household_id in (select household_id from public.household_members where user_id = (select auth.uid()))))
  with check (added_by = (select auth.uid()) and collection_id in (select id from public.recipe_collections where household_id in (select household_id from public.household_members where user_id = (select auth.uid()))));

-- Photos are stored in a private bucket and served through short-lived signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recipe-photos', 'recipe-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create policy "household recipe photos read" on storage.objects for select
  using (bucket_id = 'recipe-photos' and (storage.foldername(name))[1] in (
    select household_id::text from public.household_members where user_id = (select auth.uid())
  ));
create policy "own recipe photos insert" on storage.objects for insert
  with check (bucket_id = 'recipe-photos' and (storage.foldername(name))[1] in (
    select household_id::text from public.household_members where user_id = (select auth.uid())
  ) and owner_id = (select auth.uid()::text));
create policy "own recipe photos update" on storage.objects for update
  using (bucket_id = 'recipe-photos' and owner_id = (select auth.uid()::text));
create policy "own recipe photos delete" on storage.objects for delete
  using (bucket_id = 'recipe-photos' and owner_id = (select auth.uid()::text));
