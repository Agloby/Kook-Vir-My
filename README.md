# Kook vir Jou

Household recipe finder, **Koskas** pantry/stock register, meal planner and shopping-list app.
Domain: `kookvirjou.com`. Static frontend on Netlify, backend on Supabase (project
`kraal-recipe-finder`, ref `iwncoqufcivqgjvlynaz`, eu-west-1).

## Layout

```
netlify-site/            static site (publish directory — no build step)
  index.html             the whole app (vanilla HTML/CSS/JS)
  manifest.webmanifest   PWA manifest
  sw.js                  service worker (app shell only; never caches API data)
  offline.html           offline fallback page
  icons/                 app icons
supabase/
  functions/             Edge Function source (deployed on the Supabase project)
    generate-recipes/
    scan-pantry-photo/
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

## What the app deliberately does not do

- It cannot add items to a retailer's online basket or place orders — no Irish
  grocery retailer offers a public API for that. Order Mode builds the list,
  records the fulfilment preference, and opens the retailer's own site.
- Allergy checks are best-effort keyword scans, clearly worded as such — never a
  certified allergen check. Product labels must always be checked.
- Cost/nutrition figures marked `*` are AI estimates; saved household prices and
  Open Food Facts data are labelled with their source.
- Expiry reminders are in-app (plus an optional browser notification when the
  app opens). There is no background push — that would need push subscriptions,
  VAPID keys and a scheduled backend job.
