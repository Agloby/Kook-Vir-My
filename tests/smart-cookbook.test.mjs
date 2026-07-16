import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../netlify-site/index.html', import.meta.url), 'utf8');
const sql = readFileSync(new URL('../supabase/migrations/20260716120000_smart_cookbook_suite.sql', import.meta.url), 'utf8');

test('cookbook exposes editable library, diary and discovery controls', () => {
  for (const id of ['cookbookSearch','cookbookStatus','cookbookSort','cookbookPantryOnly','cookLogDialog','versionDialog','smartGenerationMode']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /Log another cook/);
  assert.match(html, /Cook again/);
  assert.match(html, /Add to collection/);
});

test('cooking mode includes hands-free helpers and completion logging', () => {
  assert.match(html, /ckReadBtn/);
  assert.match(html, /ckVoiceBtn/);
  assert.match(html, /openCookLog\(finished\)/);
  assert.match(html, /servings_made:made,servings_eaten:eaten/);
});

test('migration protects durable cookbook entities with RLS', () => {
  for (const table of ['recipe_cooks','recipe_versions','recipe_collections','recipe_collection_items']) {
    assert.match(sql, new RegExp(`create table public\\.${table}`));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(sql, /private bucket/i);
  assert.match(sql, /file_size_limit/);
});
