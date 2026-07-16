import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('browser never contains a Google Maps key field or direct Google API call', () => { const source=read('netlify-site/index.html')+read('netlify-site/app.js'); assert.doesNotMatch(source,/maps_api_key|mapsKeyInput|maps\.googleapis\.com|places\.googleapis\.com/); assert.match(source,/functions\.invoke\('maps-proxy'/); });
test('AI functions enforce authentication, quotas and payload limits', () => { for(const file of ['supabase/functions/generate-recipes/index.ts','supabase/functions/scan-pantry-photo/index.ts']){ const source=read(file); assert.match(source,/auth\.getUser\(\)/); assert.match(source,/consume_ai_quota/); assert.match(source,/MAX_BODY_BYTES/); assert.match(source,/AbortController/); } });
test('tenant migration binds child rows to parent households', () => { const sql=read('supabase/migrations/20260716100000_tenant_integrity_and_ai_quotas.sql'); assert.match(sql,/foreign key \(shopping_list_id, household_id\)/i); assert.match(sql,/foreign key \(meal_plan_id, household_id\)/i); assert.match(sql,/set_pantry_quantities/); });
test('Pepesto cooldown applies to comparisons, not checkout', () => { const source=read('supabase/functions/pepesto-basket/index.ts'); assert.match(source,/if \(mode === "compare" && list\.pepesto_last_compared_at\)/); });
test('deployment defines baseline security headers', () => { const config=read('netlify.toml'); for(const header of ['Content-Security-Policy','Permissions-Policy','Referrer-Policy','X-Content-Type-Options','Strict-Transport-Security']) assert.match(config,new RegExp(header)); });
