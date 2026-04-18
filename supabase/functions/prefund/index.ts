/**
 * Scannr — Pre-fund Edge Function
 *
 * Awards 0.5 TRUST from the treasury wallet to qualifying new users.
 *
 * Eligibility:
 *   - X account age >= 30 days
 *   - Followers >= 10
 *   - Tweets >= 20
 *   - Not already funded (dedup by wallet_address)
 *
 * Environment variables (set in Supabase dashboard):
 *   - TREASURY_PRIVATE_KEY: hex private key of the treasury wallet
 *   - INTUITION_RPC_URL: RPC endpoint for Intuition Network
 *
 * Deploy: supabase functions deploy prefund
 */

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  defineChain,
} from 'https://esm.sh/viem@2';
import { privateKeyToAccount } from 'https://esm.sh/viem@2/accounts';

const FUND_AMOUNT = parseEther('0.5');

const intuitionTestnet = defineChain({
  id: 13579,
  name: 'Intuition Testnet',
  network: 'intuition-testnet',
  nativeCurrency: { name: 'tTRUST', symbol: 'tTRUST', decimals: 18 },
  rpcUrls: {
    default: { http: [Deno.env.get('INTUITION_RPC_URL') || 'https://testnet.rpc.intuition.systems/'] },
  },
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    // Validate JWT
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Missing auth token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid auth token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Parse request body
    const { wallet_address } = await req.json();
    if (!wallet_address || !/^0x[a-fA-F0-9]{40}$/.test(wallet_address)) {
      return new Response(JSON.stringify({ error: 'Invalid wallet address' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check eligibility — X account metadata
    const meta = user.user_metadata || {};
    const createdAt = meta.created_at ? new Date(meta.created_at) : null;
    const accountAgeDays = createdAt
      ? (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24)
      : 0;
    const followers = meta.followers_count || 0;
    const tweets = meta.statuses_count || meta.tweet_count || 0;

    if (accountAgeDays < 30 || followers < 10 || tweets < 20) {
      return new Response(JSON.stringify({
        error: 'Account does not meet eligibility requirements',
        details: { accountAgeDays: Math.floor(accountAgeDays), followers, tweets },
      }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Dedup — check if wallet already funded
    const { data: existing } = await supabase
      .from('funded_wallets')
      .select('id')
      .eq('wallet_address', wallet_address)
      .maybeSingle();

    if (existing) {
      return new Response(JSON.stringify({ error: 'Wallet already funded' }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Send TRUST from treasury
    const treasuryKey = Deno.env.get('TREASURY_PRIVATE_KEY');
    if (!treasuryKey) {
      return new Response(JSON.stringify({ error: 'Treasury not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const account = privateKeyToAccount(treasuryKey as `0x${string}`);

    const walletClient = createWalletClient({
      account,
      chain: intuitionTestnet,
      transport: http(),
    });

    const publicClient = createPublicClient({
      chain: intuitionTestnet,
      transport: http(),
    });

    // Check treasury balance before sending
    const treasuryBalance = await publicClient.getBalance({ address: account.address });
    if (treasuryBalance < parseEther('0.6')) {
      return new Response(JSON.stringify({
        error: 'Pre-funding temporarily unavailable',
        reason: 'treasury_depleted',
      }), {
        status: 503,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const txHash = await walletClient.sendTransaction({
      to: wallet_address as `0x${string}`,
      value: FUND_AMOUNT,
    });

    // Wait for confirmation
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    // Record in funded_wallets table
    await supabase.from('funded_wallets').insert({
      user_id: user.id,
      wallet_address,
      tx_hash: txHash,
      amount: '0.5',
    });

    // Mark user as funded
    await supabase
      .from('users')
      .update({ is_funded: true, funded_at: new Date().toISOString() })
      .eq('id', user.id);

    return new Response(JSON.stringify({
      ok: true,
      tx_hash: txHash,
      amount: '0.5 TRUST',
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Prefund error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
