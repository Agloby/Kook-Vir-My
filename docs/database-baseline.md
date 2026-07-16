# Database baseline

`supabase/baseline.sql` is a schema-only snapshot of the linked production project's `public` schema, captured on 2026-07-16 with `supabase db dump`. It contains tables, constraints, functions, triggers, indexes, RLS policies and grants, but no application rows, credentials, secrets or role ownership metadata.

The timestamped migrations remain the authoritative incremental history. The baseline exists to make disaster recovery and fresh-environment review possible even though the 17 oldest remote migrations are represented locally by history placeholders.

To refresh it:

```sh
npx supabase db dump --linked --schema public --file supabase/baseline.sql
```

Then remove generated `ALTER ... OWNER TO ...` statements, scan the result for secrets, and review the diff before committing. Restore into an empty Supabase-compatible PostgreSQL database before using the normal migrations that post-date the snapshot.
