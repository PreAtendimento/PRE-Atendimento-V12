---
name: Supabase-to-pg migration
description: How the Supabase SDK was replaced with a pg-based shim and what still optionally uses Supabase.
---

## The rule
All database access now goes through `src/services/db.ts` (pg Pool using `DATABASE_URL`). The `src/services/supabase.ts` file exports a `supabaseAdmin` shim that mirrors the Supabase SDK chainable API but executes raw SQL via pg.

## What still optionally uses Supabase
Password reset emails (`requestPasswordReset`, `resetPassword`) dynamically import `@supabase/supabase-js` only if `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set. If not set, the functions return a graceful no-op (user sees generic success message, no email sent).

**Why:** The app uses a custom bcrypt/JWT auth system — Supabase Auth is only used as an email delivery mechanism for password resets. Core login/register/session never touches Supabase.

## Migration details
- 17 migrations run against Replit PostgreSQL (DATABASE_URL)
- RLS policies were stripped from migrations (not needed; access control is enforced in Express middleware)
- `authService.ts` uses `DATABASE_URL` directly via pg.Client (unchanged pattern from original)
- `JWT_SECRET` reads from `JWT_SECRET` env var first, then falls back to `SUPABASE_JWT_SECRET` for backward compat

**How to apply:** When adding new tables, add a migration entry to `src/db/migrate.ts`. Migrations auto-run at server startup.
