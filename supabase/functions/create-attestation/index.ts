/**
 * Scannr — Create Attestation Edge Function
 *
 * Creates on-chain attestations on Intuition Testnet when users
 * flag or vouch for tweets. The treasury wallet signs all transactions
 * server-side (users don't need a wallet for attestations).
 *
 * Flow:
 *   1. Validate JWT
 *   2. Create tweet URL Atom (or skip if revert = already exists)
 *   3. Create Triple (subject=tweet, predicate=category, object=context)
 *   4. Record in user_actions table
 *
 * Environment variables (set in Supabase dashboard):
 *   - TREASURY_PRIVATE_KEY: hex private key of the treasury wallet
 *   - INTUITION_RPC_URL: RPC endpoint for Intuition Network
 *
 * Deploy: supabase functions deploy create-attestation
 */

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  createWalletClient,
  createPublicClient,
  http,
  defineChain,
  toHex,
  toBytes,
  formatEther,
} from 'https://esm.sh/viem@2';
import { privateKeyToAccount } from 'https://esm.sh/viem@2/accounts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MULTIVAULT_ADDRESS = '0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91' as const;

// Predicate & context Atom IDs — deployed via scripts/deploy-predicates.mjs
const PREDICATE_ATOMS: Record<string, `0x${string}`> = {
  is_trustworthy:    '0x56e25f24db1101a52a906d93da0e6056227d3a48e33be08fdb645989fa49330f',
  is_false_info:     '0x9c0a6b0ada694a217c79ca5b6ada08d316b3d447b5688554323dac895cd57fd5',
  is_hacked_account: '0x22cb78371e7bcf49cbc65faca4912e210e2bed35ccc6d2023fa6ce93b51b36fb',
  is_wrong_link:     '0x3448e5c9189781c876738c1aad022b5a6d8556c6a32e06173bf5fe60e27136d6',
};

const CONTEXT_ATOM_ID: `0x${string}` = '0x302dfc8697dbbdf64d359cafc4d0a825571e82f42ee4f11b638e5b7f23f2c307';

// ---------------------------------------------------------------------------
// Chain & ABI
// ---------------------------------------------------------------------------

const intuitionTestnet = defineChain({
  id: 13579,
  name: 'Intuition Testnet',
  network: 'intuition-testnet',
  nativeCurrency: { name: 'tTRUST', symbol: 'tTRUST', decimals: 18 },
  rpcUrls: {
    default: { http: [Deno.env.get('INTUITION_RPC_URL') || 'https://testnet.rpc.intuition.systems/'] },
  },
});

const MULTIVAULT_ABI = [
  {
    name: 'getAtomCost',
    type: 'function',
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getTripleCost',
    type: 'function',
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'createAtoms',
    type: 'function',
    stateMutability: 'payable' as const,
    inputs: [
      { name: 'atomUris', type: 'bytes[]' },
      { name: 'deposits', type: 'uint256[]' },
    ],
    outputs: [{ name: 'atomIds', type: 'bytes32[]' }],
  },
  {
    name: 'createTriples',
    type: 'function',
    stateMutability: 'payable' as const,
    inputs: [
      { name: 'subjectIds', type: 'bytes32[]' },
      { name: 'predicateIds', type: 'bytes32[]' },
      { name: 'objectIds', type: 'bytes32[]' },
      { name: 'deposits', type: 'uint256[]' },
    ],
    outputs: [{ name: 'tripleIds', type: 'bytes32[]' }],
  },
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'payable' as const,
    inputs: [
      { name: 'receiver', type: 'address' },
      { name: 'termId', type: 'bytes32' },
      { name: 'curveId', type: 'uint256' },
      { name: 'minShares', type: 'uint256' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
] as const;

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    // -----------------------------------------------------------------------
    // Auth
    // -----------------------------------------------------------------------
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return jsonResponse(401, { error: 'Missing auth header' });
    }

    const token = authHeader.replace('Bearer ', '');

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');

    console.log('SUPABASE_URL set:', !!supabaseUrl);
    console.log('SUPABASE_ANON_KEY set:', !!supabaseAnonKey);

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars');
      return jsonResponse(500, { error: 'Server misconfigured — missing Supabase env vars' });
    }

    // Auth client uses ANON key — validates the user's JWT
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      console.error('Auth failed:', authError?.message || 'no user returned');
      return jsonResponse(401, { error: 'Invalid JWT', details: authError?.message });
    }

    console.log('Authenticated user:', user.id);

    // -----------------------------------------------------------------------
    // Parse & validate request
    // -----------------------------------------------------------------------
    const { tweetUrl, predicateKey, userId } = await req.json();

    if (!tweetUrl || typeof tweetUrl !== 'string') {
      return jsonResponse(400, { error: 'Missing tweetUrl' });
    }

    const predicateAtomId = PREDICATE_ATOMS[predicateKey];
    if (!predicateAtomId) {
      return jsonResponse(400, { error: `Invalid predicateKey: ${predicateKey}` });
    }

    // -----------------------------------------------------------------------
    // Treasury wallet setup
    // -----------------------------------------------------------------------
    const treasuryKey = Deno.env.get('TREASURY_PRIVATE_KEY');
    if (!treasuryKey) {
      return jsonResponse(500, { error: 'Treasury not configured' });
    }

    const treasuryAccount = privateKeyToAccount(treasuryKey as `0x${string}`);

    const walletClient = createWalletClient({
      account: treasuryAccount,
      chain: intuitionTestnet,
      transport: http(),
    });

    const publicClient = createPublicClient({
      chain: intuitionTestnet,
      transport: http(),
    });

    // -----------------------------------------------------------------------
    // Read costs + balance
    // -----------------------------------------------------------------------
    const [atomCost, tripleCost, balance] = await Promise.all([
      publicClient.readContract({
        address: MULTIVAULT_ADDRESS, abi: MULTIVAULT_ABI, functionName: 'getAtomCost',
      }),
      publicClient.readContract({
        address: MULTIVAULT_ADDRESS, abi: MULTIVAULT_ABI, functionName: 'getTripleCost',
      }),
      publicClient.getBalance({ address: treasuryAccount.address }),
    ]);

    console.log(`Treasury balance: ${formatEther(balance)} tTRUST`);
    console.log(`Atom cost: ${atomCost} wei, Triple cost: ${tripleCost} wei`);

    const minDeposit = 10000000000000000n; // 1e16 wei (0.01 ETH) — contract minDeposit floor
    const atomDeposit = atomCost + minDeposit;
    const tripleDeposit = tripleCost + minDeposit;

    const minNeeded = atomDeposit + tripleDeposit + 1000000000000000n; // + 0.001 buffer
    if (balance < minNeeded) {
      console.log(`Treasury depleted: have ${formatEther(balance)}, need ${formatEther(minNeeded)}`);
      return jsonResponse(503, {
        error: 'Attestations temporarily unavailable',
        reason: 'treasury_depleted',
      });
    }

    // -----------------------------------------------------------------------
    // Step 1: Create tweet URL Atom
    // -----------------------------------------------------------------------
    let tweetAtomId: `0x${string}` | null = null;
    let atomTxHash: string | null = null;

    const atomData = toHex(toBytes(tweetUrl));
    console.log('createAtoms args:');
    console.log('  atomUris:', [atomData]);
    console.log('  deposits (wei):', [atomDeposit.toString()]);
    console.log('  value (wei):', atomDeposit.toString());
    console.log('  from account:', treasuryAccount.address);

    try {
      const { result: atomIdsResult, request: atomRequest } = await publicClient.simulateContract({
        address: MULTIVAULT_ADDRESS,
        abi: MULTIVAULT_ABI,
        functionName: 'createAtoms',
        args: [[atomData], [atomDeposit]],
        value: atomDeposit,
        account: treasuryAccount,
      });

      tweetAtomId = (atomIdsResult as `0x${string}`[])[0];
      console.log(`Simulate OK — tweet atom ID: ${tweetAtomId}`);

      atomTxHash = await walletClient.writeContract(atomRequest);
      await publicClient.waitForTransactionReceipt({ hash: atomTxHash });
      console.log(`Tweet atom created: ${tweetAtomId} (tx: ${atomTxHash})`);
    } catch (err: any) {
      console.log('=== createAtoms REVERT DETAILS ===');
      console.log('shortMessage:', err.shortMessage || 'none');
      console.log('message:', err.message || 'none');
      console.log('details:', err.details || 'none');
      console.log('metaMessages:', JSON.stringify(err.metaMessages || []));
      console.log('cause.reason:', err.cause?.reason || 'none');
      console.log('cause.shortMessage:', err.cause?.shortMessage || 'none');
      console.log('cause.data:', err.cause?.data || 'none');
      console.log('name:', err.name || 'none');
      console.log('=================================');
      atomTxHash = null;
      tweetAtomId = null;
    }

    // -----------------------------------------------------------------------
    // Step 2: Create Triple (subject=tweet, predicate=category, object=context)
    // -----------------------------------------------------------------------
    let tripleId: `0x${string}` | null = null;
    let tripleTxHash: string | null = null;

    if (tweetAtomId) {
      console.log(`Simulating triple creation: (${tweetAtomId}, ${predicateAtomId}, ${CONTEXT_ATOM_ID})`);
      try {
        const { result: tripleIdsResult, request } = await publicClient.simulateContract({
          address: MULTIVAULT_ADDRESS,
          abi: MULTIVAULT_ABI,
          functionName: 'createTriples',
          args: [[tweetAtomId], [predicateAtomId], [CONTEXT_ATOM_ID], [tripleDeposit]],
          value: tripleDeposit,
          account: treasuryAccount,
        });

        tripleId = (tripleIdsResult as `0x${string}`[])[0];
        console.log(`Simulate OK — triple ID: ${tripleId}`);

        tripleTxHash = await walletClient.writeContract(request);
        await publicClient.waitForTransactionReceipt({ hash: tripleTxHash });
        console.log(`Triple created: ${tripleId} (tx: ${tripleTxHash})`);
      } catch (err: any) {
        console.log('=== createTriples REVERT DETAILS ===');
        console.log('shortMessage:', err.shortMessage || 'none');
        console.log('message:', err.message || 'none');
        console.log('details:', err.details || 'none');
        console.log('===================================');
      }
    } else {
      console.log('Skipping triple creation — tweet atom ID unknown');
    }

    // -----------------------------------------------------------------------
    // Step 3: Record in user_actions
    // -----------------------------------------------------------------------
    if (tripleTxHash) {
      await supabase.from('user_actions').insert({
        user_id: userId || user.id,
        action_type: 'attestation',
        target_url: tweetUrl,
        intuition_tx_hash: tripleTxHash,
        intuition_atom_id: tweetAtomId,
        intuition_triple_id: tripleId,
        chain_id: 13579,
      });
      console.log('Recorded in user_actions');
    }

    return jsonResponse(200, {
      success: true,
      atomId: tweetAtomId,
      tripleId,
      atomTxHash,
      tripleTxHash,
    });

  } catch (err) {
    console.error('Attestation error:', err);
    return jsonResponse(500, { error: 'Internal server error' });
  }
});
