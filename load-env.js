/**
 * load-env.js
 * Maps SUPABASE_DB_URL → DATABASE_URL so pg connections use Supabase Postgres.
 * Import this as the very first module in server.ts.
 */
if (process.env.SUPABASE_DB_URL) {
  process.env.DATABASE_URL = process.env.SUPABASE_DB_URL;
}
