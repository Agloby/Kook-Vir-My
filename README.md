# Kook vir Jou

Household recipe finder, **Koskas** pantry/stock register, meal planner and shopping-list app.
Domain: `kookvirjou.com`. Static frontend on Netlify, backend on Supabase (project
`kraal-recipe-finder`, ref `iwncoqufcivqgjvlynaz`, eu-west-1).

## Layout

```
netlify-site/            static site (publish directory — no build step)
  index.html             the whole app (vanilla HTML/CSS/JS)
  pepesto-helpers.js     testable basket-ranking and request-control helpers
  recipe-helpers.js      testable ingredient/date/category helpers (normalization,
                         unit conversion, shopping-list merging, week/date math)
  manifest.webmanifest   PWA manifest
  sw.js                  service worker (app shell only; never caches API data)
  offline.html           offline fallback page
  icons/                 app icons
supabase/
  functions/             Edge Function source (deployed on the Supabase project)
    generate-recipes/
    scan-pantry-photo/
    pepesto-basket/      secure retailer comparison and Pepesto handoff
  migrations/            SQL migrations (already applied to the live project)
netlify.toml             publish dir + service-worker cache headers
```

## Deploying

**Frontend:** connect this repo to Netlify (or drag `netlify-site/` into Netlify Drop).
`netlify.toml` sets the publish directory.

**Database:** migrations in `supabase/migrations/` are applied to the live project.
For future changes: `supabase link --project-ref iwncoqufcivqgjvlynaz && supabase db push`,
or paste the SQL into the dashboard's SQL editor.

**Edge Functions:** `supabase functions deploy generate-recipes` /
`scan-pantry-photo`. Both need the `ANTHROPIC_API_KEY` secret
(`supabase secrets set ANTHROPIC_API_KEY=... --project-ref iwncoqufcivqgjvlynaz`).

## Pepesto supermarket comparison

The Shopping tab can explicitly compare the required items in an open list at
Tesco Ireland (`tesco.ie`), Dunnes Stores Grocery (`dunnesstoresgrocery.com`)
and SuperValu Ireland (`shop.supervalu.ie`). The browser calls the authenticated
`pepesto-basket` Supabase Edge Function; the function reloads the list under the
caller's RLS-protected session, sends normalised required lines to Pepesto's
`POST https://s.pepesto.com/api/products` endpoint, and returns a sanitised
matched-product summary plus Pepesto's validated basket-adjustment handoff URL.

Set the server-side secret (never add the real value to this repository):

```sh
supabase secrets set PEPESTO_API_KEY=YOUR_KEY --project-ref iwncoqufcivqgjvlynaz
```

Deploy the function:

```sh
supabase functions deploy pepesto-basket --project-ref iwncoqufcivqgjvlynaz
```

For local Edge Function development, serve the function with Supabase CLI and a
local `PEPESTO_API_KEY` environment secret. Run helper tests without making paid
calls:

```sh
deno test supabase/functions/pepesto-basket/helpers_test.ts
node --test tests/pepesto-frontend.test.mjs tests/recipe-helpers.test.mjs
```

The integration does not run on page load, tab changes, or item edits. Results
are kept only in browser memory for the current session; use **Refresh prices**
to request new data. Pepesto's current `/products` starter price is €0.04 per
retailer, so one three-store comparison is approximately €0.12 and four such
comparisons are approximately €0.48. Pricing can change; retailer login,
delivery charges, slots, loyalty discounts, substitutions, local availability,
product-label checks and final payment remain outside Kook vir Jou.

## What the app deliberately does not do

- Kook vir Jou can compare supported retailer products and hand the selected
  list to Pepesto's checkout process. It does not guarantee direct basket
  insertion, automate payment, collect retailer passwords or card details, or
  control retailer login, delivery slots, substitutions or final availability.
- Allergy checks are best-effort keyword scans, clearly worded as such — never a
  certified allergen check. Product labels must always be checked.
- Cost/nutrition figures marked `*` are AI estimates; saved household prices and
  Open Food Facts data are labelled with their source.
- Expiry reminders are in-app (plus an optional browser notification when the
  app opens). There is no background push — that would need push subscriptions,
  VAPID keys and a scheduled backend job.
