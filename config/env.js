/**
 * Scannr — Environment Configuration
 *
 * Supabase project credentials. These are PUBLIC keys — safe to ship
 * in the extension bundle. Row Level Security (RLS) on the Supabase
 * side ensures data access is scoped to authenticated users.
 */

export const ENV = {
  SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_ANON_KEY',
};
