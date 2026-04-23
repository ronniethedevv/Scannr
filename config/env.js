/**
 * Scannr — Environment Configuration
 *
 * Supabase project credentials. These are PUBLIC keys — safe to ship
 * in the extension bundle. Row Level Security (RLS) on the Supabase
 * side ensures data access is scoped to authenticated users.
 */

export const ENV = {
  // Supabase
  SUPABASE_URL: 'https://oxyfufzlcyywgvfchebr.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94eWZ1ZnpsY3l5d2d2ZmNoZWJyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxODc1NDcsImV4cCI6MjA4ODc2MzU0N30.Sbclp2HoJNtSKmBf4jnWSaRl3_0N0gzpDOCfTZCsGsM',

  // Privy hosted auth page (wallet setup opens here)
  PRIVY_AUTH_URL: 'https://scannr-auth.vercel.app',

  // Intuition Network (testnet)
  INTUITION_CHAIN_ID: 13579,
  INTUITION_RPC_URL: 'https://testnet.rpc.intuition.systems/',
  INTUITION_GRAPHQL_URL: 'https://testnet.intuition.sh/v1/graphql',
  MULTIVAULT_ADDRESS: '0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91',

  // Supabase Edge Functions
  PREFUND_FUNCTION_URL: 'https://oxyfufzlcyywgvfchebr.supabase.co/functions/v1/prefund',
  ATTESTATION_FUNCTION_URL: 'https://oxyfufzlcyywgvfchebr.supabase.co/functions/v1/create-attestation',
};
