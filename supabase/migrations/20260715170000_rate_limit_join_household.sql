-- join_household() is a SECURITY DEFINER RPC callable by any authenticated user, and
-- invite codes are only 8 hex characters (~4.3 billion combinations) with no throttling -
-- a scripted caller could brute-force another household's code and gain full read/write
-- access to their address, recipes, pantry and shopping lists. Add a simple per-user
-- attempt counter and reject once someone has tried too many codes in the last hour.

create table public.household_join_attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now()
);

create index household_join_attempts_user_time_idx on public.household_join_attempts (user_id, attempted_at);

-- No policies at all: this table is only ever touched by the SECURITY DEFINER function
-- below (which runs as the table owner and bypasses RLS), never directly by a client.
alter table public.household_join_attempts enable row level security;

create or replace function public.join_household(p_code text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  target_id uuid;
  recent_attempts int;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  -- Serialize attempts for this user so concurrent requests cannot race past the limit.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':household-join', 0));
  delete from public.household_join_attempts
    where user_id = auth.uid() and attempted_at < now() - interval '1 hour';

  select count(*) into recent_attempts
    from public.household_join_attempts
    where user_id = auth.uid() and attempted_at > now() - interval '1 hour';
  if recent_attempts >= 10 then
    raise exception 'Too many join attempts - please wait a while before trying another code.';
  end if;

  insert into public.household_join_attempts (user_id) values (auth.uid());

  select id into target_id from public.households where invite_code = p_code;
  if target_id is null then
    raise exception 'Invalid invite code';
  end if;
  insert into public.household_members (household_id, user_id, role)
    values (target_id, auth.uid(), 'member')
    on conflict (user_id) do update set household_id = excluded.household_id, role = 'member';
  return target_id;
end;
$function$;
