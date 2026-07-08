-- Barcode / Open Food Facts metadata on pantry items, plus expiry-reminder snooze

alter table public.pantry_items
  add column if not exists barcode text,
  add column if not exists brand text,
  add column if not exists product_data jsonb,
  add column if not exists nutrition_per_100g jsonb,
  add column if not exists ingredients_text text,
  add column if not exists allergen_text text,
  add column if not exists reminder_snooze_until date;

-- allow 'barcode' as an item source
alter table public.pantry_items drop constraint if exists pantry_items_source_check;
alter table public.pantry_items
  add constraint pantry_items_source_check
  check (source in ('manual','photo','barcode'));
