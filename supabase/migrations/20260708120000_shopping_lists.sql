-- Persistent shopping lists (Order Mode)

create table public.shopping_lists (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  source text not null default 'manual',
  fulfilment_method text not null default 'in_store'
    check (fulfilment_method in ('delivery','click_collect','in_store','whatsapp')),
  retailer_name text,
  status text not null default 'draft'
    check (status in ('draft','active','completed','archived')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.shopping_list_items (
  id uuid primary key default gen_random_uuid(),
  shopping_list_id uuid not null references public.shopping_lists(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  item_name text not null,
  quantity numeric,
  unit text,
  quantity_text text,
  category text,
  notes text,
  status text not null default 'required'
    check (status in ('required','optional','check_pantry','already_have','bought')),
  source text not null default 'manual',
  recipe_id uuid references public.recipes(id) on delete set null,
  pantry_item_id uuid references public.pantry_items(id) on delete set null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index shopping_list_items_list_idx on public.shopping_list_items (shopping_list_id);
create index shopping_lists_household_idx on public.shopping_lists (household_id, status);

alter table public.shopping_lists enable row level security;
alter table public.shopping_list_items enable row level security;

create policy "household shopping lists" on public.shopping_lists
  for all
  using (household_id in (select household_id from public.household_members where user_id = auth.uid()))
  with check (household_id in (select household_id from public.household_members where user_id = auth.uid()));

create policy "household shopping list items" on public.shopping_list_items
  for all
  using (household_id in (select household_id from public.household_members where user_id = auth.uid()))
  with check (household_id in (select household_id from public.household_members where user_id = auth.uid()));
