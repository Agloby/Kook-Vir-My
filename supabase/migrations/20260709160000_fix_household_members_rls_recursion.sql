-- The original SELECT policy on household_members queried household_members
-- from within its own USING clause, which Postgres detects as infinite
-- recursion (error 42P17). Every read of this table failed with a 500,
-- blocking new signups from ever loading their household. The app only
-- ever needs "is this my own membership row", so the self-referential
-- subquery is unnecessary.
drop policy if exists "read own membership rows" on public.household_members;

create policy "read own membership rows" on public.household_members
  for select
  using (user_id = auth.uid());
