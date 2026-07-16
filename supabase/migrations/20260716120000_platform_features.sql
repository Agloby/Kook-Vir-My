-- Concurrency, transactional workflows, usage telemetry, alerts, and household exit.

alter table public.shopping_list_items add column if not exists updated_at timestamptz not null default now();
alter table public.meal_plan_items add column if not exists updated_at timestamptz not null default now();
alter table public.meal_plans add column if not exists updated_at timestamptz not null default now();
alter table public.recipes add column if not exists updated_at timestamptz not null default now();
alter table public.leftovers add column if not exists updated_at timestamptz not null default now();

create or replace function public.touch_updated_at() returns trigger language plpgsql set search_path=public as $$
begin new.updated_at=now(); return new; end $$;
do $$ declare t text; begin
  foreach t in array array['shopping_lists','shopping_list_items','meal_plans','meal_plan_items','recipes','pantry_items','leftovers'] loop
    execute format('drop trigger if exists touch_updated_at on public.%I',t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function public.touch_updated_at()',t);
  end loop;
end $$;

create table public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references public.households(id) on delete cascade,
  category text not null check(category in ('recipe_ai','photo_ai','pepesto_compare','pepesto_checkout','maps')),
  estimated_cost_eur numeric(10,4) not null default 0 check(estimated_cost_eur>=0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index usage_events_user_created_idx on public.usage_events(user_id,created_at desc);
alter table public.usage_events enable row level security;
create policy "read own usage" on public.usage_events for select using(user_id=(select auth.uid()));

create table public.app_error_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  household_id uuid references public.households(id) on delete set null,
  source text not null,
  message text not null,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index app_error_events_created_idx on public.app_error_events(created_at desc);
alter table public.app_error_events enable row level security;

create table public.usage_alerts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  alert_date date not null default current_date,
  category text not null,
  message text not null,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  unique(user_id,alert_date,category)
);
alter table public.usage_alerts enable row level security;
create policy "manage own alerts" on public.usage_alerts for all using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));

create or replace function public.record_usage_event(p_category text,p_cost numeric default 0,p_metadata jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_household uuid; v_daily numeric;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_category not in ('recipe_ai','photo_ai','pepesto_compare','pepesto_checkout','maps') or p_cost<0 then raise exception 'Invalid usage event'; end if;
  select household_id into v_household from public.household_members where user_id=v_user;
  insert into public.usage_events(user_id,household_id,category,estimated_cost_eur,metadata)
    values(v_user,v_household,p_category,p_cost,coalesce(p_metadata,'{}'::jsonb));
  select coalesce(sum(estimated_cost_eur),0) into v_daily from public.usage_events where user_id=v_user and created_at>=current_date;
  if v_daily>=2 then insert into public.usage_alerts(user_id,category,message) values(v_user,'daily_cost','Estimated third-party usage today has reached €'||round(v_daily,2)) on conflict(user_id,alert_date,category) do update set message=excluded.message,created_at=now(); end if;
end $$;
revoke all on function public.record_usage_event(text,numeric,jsonb) from public,anon;
grant execute on function public.record_usage_event(text,numeric,jsonb) to authenticated;

create or replace function public.record_client_error(p_source text,p_message text,p_context jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_household uuid;
begin
  if char_length(p_source)>80 or char_length(p_message)>1000 then raise exception 'Invalid error event'; end if;
  if v_user is not null then select household_id into v_household from public.household_members where user_id=v_user; end if;
  insert into public.app_error_events(user_id,household_id,source,message,context) values(v_user,v_household,p_source,p_message,coalesce(p_context,'{}'::jsonb));
end $$;
revoke all on function public.record_client_error(text,text,jsonb) from public,anon;
grant execute on function public.record_client_error(text,text,jsonb) to authenticated;

create or replace function public.apply_shopping_list_changes(p_list_id uuid,p_updates jsonb,p_inserts jsonb)
returns setof public.shopping_list_items language plpgsql security definer set search_path=public as $$
declare v_household uuid; v jsonb;
begin
  select sl.household_id into v_household from public.shopping_lists sl join public.household_members hm on hm.household_id=sl.household_id where sl.id=p_list_id and hm.user_id=auth.uid();
  if v_household is null or jsonb_typeof(p_updates)<>'array' or jsonb_typeof(p_inserts)<>'array' or jsonb_array_length(p_updates)+jsonb_array_length(p_inserts)>300 then raise exception 'Invalid shopping-list change'; end if;
  for v in select value from jsonb_array_elements(p_updates) loop
    update public.shopping_list_items set quantity=(v->>'quantity')::numeric,unit=nullif(v->>'unit',''),quantity_text=nullif(v->>'quantity_text',''),pantry_item_id=nullif(v->>'pantry_item_id','')::uuid
    where id=(v->>'id')::uuid and shopping_list_id=p_list_id and household_id=v_household;
    if not found then raise exception 'Shopping item changed or unavailable'; end if;
  end loop;
  for v in select value from jsonb_array_elements(p_inserts) loop
    insert into public.shopping_list_items(shopping_list_id,household_id,item_name,quantity,unit,quantity_text,category,notes,status,source,recipe_id,pantry_item_id,sort_order)
    values(p_list_id,v_household,btrim(v->>'item_name'),nullif(v->>'quantity','')::numeric,nullif(v->>'unit',''),nullif(v->>'quantity_text',''),nullif(v->>'category',''),nullif(v->>'notes',''),coalesce(nullif(v->>'status',''),'required'),coalesce(nullif(v->>'source',''),'manual'),nullif(v->>'recipe_id','')::uuid,nullif(v->>'pantry_item_id','')::uuid,coalesce((v->>'sort_order')::int,0));
  end loop;
  return query select * from public.shopping_list_items where shopping_list_id=p_list_id order by sort_order;
end $$;
revoke all on function public.apply_shopping_list_changes(uuid,jsonb,jsonb) from public,anon;
grant execute on function public.apply_shopping_list_changes(uuid,jsonb,jsonb) to authenticated;

create or replace function public.add_meal_with_optional_leftover(p_meal jsonb,p_followup jsonb default null)
returns setof public.meal_plan_items language plpgsql security definer set search_path=public as $$
declare v_household uuid; v_plan uuid; v_followup_plan uuid; v_row public.meal_plan_items;
begin
  v_plan:=(p_meal->>'meal_plan_id')::uuid;
  select mp.household_id into v_household from public.meal_plans mp join public.household_members hm on hm.household_id=mp.household_id where mp.id=v_plan and hm.user_id=auth.uid();
  if v_household is null then raise exception 'Meal plan unavailable'; end if;
  insert into public.meal_plan_items(meal_plan_id,household_id,meal_date,meal_slot,recipe_id,manual_title,servings,notes,use_leftovers,leftover_id)
  values(v_plan,v_household,(p_meal->>'meal_date')::date,p_meal->>'meal_slot',nullif(p_meal->>'recipe_id','')::uuid,nullif(p_meal->>'manual_title',''),nullif(p_meal->>'servings','')::int,nullif(p_meal->>'notes',''),coalesce((p_meal->>'use_leftovers')::boolean,false),nullif(p_meal->>'leftover_id','')::uuid)
  returning * into v_row; return next v_row;
  if p_followup is not null then
    insert into public.meal_plans(household_id,week_start) values(v_household,(p_followup->>'week_start')::date)
      on conflict(household_id,week_start) do update set household_id=excluded.household_id returning id into v_followup_plan;
    insert into public.meal_plan_items(meal_plan_id,household_id,meal_date,meal_slot,recipe_id,manual_title,servings,notes,use_leftovers)
    values(v_followup_plan,v_household,(p_followup->>'meal_date')::date,coalesce(nullif(p_followup->>'meal_slot',''),'lunch'),nullif(p_followup->>'recipe_id','')::uuid,nullif(p_followup->>'manual_title',''),nullif(p_followup->>'servings','')::int,'Cook once, eat twice — leftovers from the day before',true)
    returning * into v_row; return next v_row;
  end if;
end $$;
revoke all on function public.add_meal_with_optional_leftover(jsonb,jsonb) from public,anon;
grant execute on function public.add_meal_with_optional_leftover(jsonb,jsonb) to authenticated;

create or replace function public.leave_household()
returns uuid language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_old uuid; v_new uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select household_id into v_old from public.household_members where user_id=v_user for update;
  delete from public.household_members where user_id=v_user;
  if v_old is not null and not exists(select 1 from public.household_members where household_id=v_old) then delete from public.households where id=v_old; end if;
  insert into public.households default values returning id into v_new;
  insert into public.household_members(household_id,user_id,role) values(v_new,v_user,'owner');
  return v_new;
end $$;
revoke all on function public.leave_household() from public,anon;
grant execute on function public.leave_household() to authenticated;

do $$ declare t text; begin
  foreach t in array array['shopping_lists','shopping_list_items','meal_plans','meal_plan_items','pantry_items','leftovers','usage_alerts'] loop
    begin execute format('alter publication supabase_realtime add table public.%I',t); exception when duplicate_object then null; end;
  end loop;
end $$;
