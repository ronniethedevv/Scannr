/**
 * Scannr — Deploy Predicate Atoms
 *
 * One-time script that creates the predicate and context Atoms on
 * Intuition Testnet. These Atoms form the vocabulary for all Scannr
 * attestations.
 *
 * Usage:
 *   node scripts/deploy-predicates.mjs               # with GraphQL check
 *   node scripts/deploy-predicates.mjs --skip-graphql # skip GraphQL, create directly
 *
 * Requires a .env file in the project root with:
 *   TREASURY_PRIVATE_KEY=0x...
 */

import 'dotenv/config';
import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  defineChain,
  toHex,
  toBytes,
  decodeEventLog,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'config', 'intuition-atoms.json');

const MULTIVAULT_ADDRESS = '0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91';
let ATOM_COST = 1000000001000000n; // ~0.001 TRUST — will be overwritten by getAtomCost()

const skipGraphql = process.argv.includes('--skip-graphql');

// GraphQL endpoints to try (in order)
const GRAPHQL_ENDPOINTS = [
  'https://testnet.api.intuition.systems/graphql',
  'https://api.intuition.systems/v1/graphql',
  'https://api.intuition.systems/graphql',
];

const intuitionTestnet = defineChain({
  id: 13579,
  name: 'Intuition Testnet',
  network: 'intuition-testnet',
  nativeCurrency: { name: 'tTRUST', symbol: 'tTRUST', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet.rpc.intuition.systems/'] },
  },
});

const MULTIVAULT_ABI = [
  {
    name: 'createAtoms',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'data', type: 'bytes[]' },
      { name: 'assets', type: 'uint256[]' },
    ],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
  {
    name: 'getAtomCost',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
];

// AtomCreated event ABI — for decoding receipt logs
const ATOM_CREATED_EVENT = {
  type: 'event',
  name: 'AtomCreated',
  inputs: [
    { name: 'creator', type: 'address', indexed: true },
    { name: 'atomUri', type: 'bytes', indexed: false },
    { name: 'vaultID', type: 'uint256', indexed: false },
  ],
};

// ---------------------------------------------------------------------------
// Atoms to deploy
// ---------------------------------------------------------------------------

const ATOMS = [
  { key: 'is_trustworthy', uri: 'scannr://predicate/is-trustworthy' },
  { key: 'is_false_info', uri: 'scannr://predicate/is-false-info' },
  { key: 'is_hacked_account', uri: 'scannr://predicate/is-hacked-account' },
  { key: 'is_wrong_link', uri: 'scannr://predicate/is-wrong-link' },
  { key: 'crypto_twitter', uri: 'scannr://context/crypto-twitter' },
];

// ---------------------------------------------------------------------------
// GraphQL — probe for a working endpoint, then query
// ---------------------------------------------------------------------------

let graphqlUrl = null;

async function probeGraphql() {
  if (skipGraphql) {
    console.log('  GraphQL check skipped (--skip-graphql)');
    return false;
  }

  for (const url of GRAPHQL_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ atoms(limit: 1) { items { id } } }' }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const json = await res.json();
        if (json.data) {
          graphqlUrl = url;
          console.log(`  GraphQL available: ${url}`);
          return true;
        }
      }
    } catch {
      // try next
    }
  }
  console.log('  WARNING: No GraphQL endpoint reachable. Skipping existence checks.');
  console.log('  Running the script twice may create duplicate atoms (costs extra gas).');
  return false;
}

async function findAtomByUri(uri) {
  if (!graphqlUrl) return null;

  try {
    const res = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query FindAtom($uri: String!) {
          atoms(where: { uri: $uri }, limit: 1) {
            items { id }
          }
        }`,
        variables: { uri },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;
    const json = await res.json();
    if (json.errors?.length) return null;
    return json.data.atoms.items[0] || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extract atom ID from transaction receipt
// ---------------------------------------------------------------------------

function extractAtomIdFromReceipt(receipt) {
  // Method 1: Try decoding AtomCreated event
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: [ATOM_CREATED_EVENT],
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'AtomCreated' && decoded.args.vaultID != null) {
        return decoded.args.vaultID.toString();
      }
    } catch {
      // not this event, try next log
    }
  }

  // Method 2: First log with 2+ topics — atom ID in topic[1]
  for (const log of receipt.logs) {
    if (log.topics.length >= 2) {
      try {
        return BigInt(log.topics[1]).toString();
      } catch {
        continue;
      }
    }
  }

  // Method 3: Check log data for a uint256
  for (const log of receipt.logs) {
    if (log.data && log.data.length >= 66) {
      try {
        // First 32 bytes of data might be the atom ID
        const firstWord = '0x' + log.data.slice(2, 66);
        const val = BigInt(firstWord);
        if (val > 0n && val < 1000000n) {
          return val.toString();
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Deploy a single atom
// ---------------------------------------------------------------------------

async function deployAtom(walletClient, publicClient, uri, account) {
  // Check if already exists via GraphQL (if available)
  const existing = await findAtomByUri(uri);
  if (existing) {
    console.log(`  SKIP: "${uri}" already exists (atom ID: ${existing.id})`);
    return String(existing.id);
  }

  // Encode URI to bytes
  const uriBytes = toHex(toBytes(uri));

  console.log(`  URI bytes: ${uriBytes}`);
  console.log(`  Atom cost (wei): ${ATOM_COST}`);
  console.log(`  Atom cost (TRUST): ${Number(ATOM_COST) / 1e18}`);

  // Step 1: Simulate (dry run) — createAtoms takes arrays (batch of 1)
  let simulatedAtomIds;
  let request;
  try {
    const sim = await publicClient.simulateContract({
      address: MULTIVAULT_ADDRESS,
      abi: MULTIVAULT_ABI,
      functionName: 'createAtoms',
      args: [[uriBytes], [ATOM_COST]],  // data[], assets[]
      value: ATOM_COST,                  // msg.value covers total cost
      account: account,
    });
    simulatedAtomIds = sim.result;  // bytes32[]
    request = sim.request;
    console.log(`  Simulate OK — atom ID: ${simulatedAtomIds[0]}`);
  } catch (err) {
    console.log(`  Simulate FAILED`);
    console.log(`  Revert reason: ${err.shortMessage || err.message}`);
    console.log(`  Full error: ${JSON.stringify(err.details || err.cause, null, 2)}`);
    throw new Error(`simulateContract failed for "${uri}": ${err.shortMessage || err.message}`);
  }

  // Step 2: Send the pre-validated request
  let txHash;
  try {
    txHash = await walletClient.writeContract(request);
  } catch (err) {
    console.log(`  writeContract FAILED`);
    console.log(`  Revert reason: ${err.shortMessage || err.message}`);
    console.log(`  Full error: ${JSON.stringify(err.details || err.cause, null, 2)}`);
    throw err;
  }

  console.log(`  TX sent: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status !== 'success') {
    console.log(`  TX REVERTED on-chain: ${txHash}`);
    console.log(`  Logs: ${JSON.stringify(receipt.logs.map(l => ({ topics: l.topics, data: l.data })), null, 2)}`);
    throw new Error(`Transaction reverted: ${txHash}`);
  }

  // Atom ID comes from simulation result (bytes32)
  const atomId = simulatedAtomIds[0];
  console.log(`  CREATED: "${uri}" → atom ID: ${atomId}`);
  return atomId;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const privateKey = process.env.TREASURY_PRIVATE_KEY;
  if (!privateKey) {
    console.error('ERROR: TREASURY_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey);
  console.log(`Treasury address: ${account.address}`);

  const publicClient = createPublicClient({
    chain: intuitionTestnet,
    transport: http(),
  });

  const walletClient = createWalletClient({
    account,
    chain: intuitionTestnet,
    transport: http(),
  });

  // Query actual atom cost from contract
  try {
    ATOM_COST = await publicClient.readContract({
      address: MULTIVAULT_ADDRESS,
      abi: MULTIVAULT_ABI,
      functionName: 'getAtomCost',
    });
    console.log(`Atom cost from contract: ${ATOM_COST} wei (${Number(ATOM_COST) / 1e18} TRUST)`);
  } catch (err) {
    console.log(`Could not read getAtomCost(), using default: ${ATOM_COST} wei`);
  }

  // Check balance
  const totalNeeded = ATOM_COST * 5n + parseEther('0.01'); // 5 atoms + buffer
  const balance = await publicClient.getBalance({ address: account.address });
  const balanceEth = Number(balance) / 1e18;
  console.log(`Treasury balance: ${balanceEth.toFixed(6)} tTRUST`);
  console.log(`Total needed: ~${Number(totalNeeded) / 1e18} tTRUST`);

  if (balance < totalNeeded) {
    console.error(`ERROR: Need at least ${Number(totalNeeded) / 1e18} tTRUST to deploy 5 atoms`);
    process.exit(1);
  }

  // Probe GraphQL availability
  await probeGraphql();

  // Deploy each atom
  const result = {};
  for (const { key, uri } of ATOMS) {
    console.log(`\nDeploying: ${key}`);
    const atomId = await deployAtom(walletClient, publicClient, uri, account);
    result[key] = { uri, atomId };
  }

  // Write output
  const output = {
    ...result,
    _meta: {
      network: 'testnet',
      chainId: 13579,
      multivault: MULTIVAULT_ADDRESS,
      deployedAt: new Date().toISOString(),
    },
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`\nConfig written to config/intuition-atoms.json`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
