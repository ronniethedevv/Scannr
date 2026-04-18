/**
 * Scannr — Lookup Atom IDs
 *
 * Reads atom IDs from the MultiVault contract on Intuition Testnet
 * using view calls (no private key needed). Looks up each Scannr
 * predicate/context URI and writes the resolved IDs to
 * config/intuition-atoms.json.
 *
 * Usage:
 *   node scripts/lookup-atoms.mjs
 */

import 'dotenv/config';
import {
  createPublicClient,
  http,
  defineChain,
  keccak256,
  toBytes,
} from 'viem';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config', 'intuition-atoms.json');

const MULTIVAULT_ADDRESS = '0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91';

const intuitionTestnet = defineChain({
  id: 13579,
  name: 'Intuition Testnet',
  network: 'intuition-testnet',
  nativeCurrency: { name: 'tTRUST', symbol: 'tTRUST', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet.rpc.intuition.systems/'] },
  },
});

// ABIs to try — the contract may use different function names
const ATOMS_BY_HASH_ABI = [
  {
    name: 'atomsByHash',
    type: 'function',
    inputs: [{ name: 'hash', type: 'bytes32' }],
    outputs: [{ name: 'atomId', type: 'uint256' }],
    stateMutability: 'view',
  },
];

const ATOM_BY_URI_ABI = [
  {
    name: 'atomByURI',
    type: 'function',
    inputs: [{ name: 'atomUri', type: 'bytes' }],
    outputs: [{ name: 'atomId', type: 'uint256' }],
    stateMutability: 'view',
  },
];

const GET_ATOM_COST_ABI = [
  {
    name: 'getAtomCost',
    type: 'function',
    inputs: [],
    outputs: [{ name: 'cost', type: 'uint256' }],
    stateMutability: 'view',
  },
];

// URIs to look up
const ATOMS = [
  { key: 'is_trustworthy', uri: 'scannr://predicate/is-trustworthy' },
  { key: 'is_false_info', uri: 'scannr://predicate/is-false-info' },
  { key: 'is_hacked_account', uri: 'scannr://predicate/is-hacked-account' },
  { key: 'is_wrong_link', uri: 'scannr://predicate/is-wrong-link' },
  { key: 'crypto_twitter', uri: 'scannr://context/crypto-twitter' },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const publicClient = createPublicClient({
    chain: intuitionTestnet,
    transport: http(),
  });

  // Verify contract is responding
  console.log('Checking contract connectivity...');
  try {
    const cost = await publicClient.readContract({
      address: MULTIVAULT_ADDRESS,
      abi: GET_ATOM_COST_ABI,
      functionName: 'getAtomCost',
    });
    console.log(`  getAtomCost() = ${cost} wei (${Number(cost) / 1e18} TRUST)\n`);
  } catch (err) {
    console.log(`  getAtomCost() not available: ${err.shortMessage || err.message}`);
    console.log('  Contract may use a different interface. Continuing...\n');
  }

  // Determine which lookup method works
  const lookupMethod = await detectLookupMethod(publicClient);
  console.log(`Using lookup method: ${lookupMethod}\n`);

  // Look up each atom
  const results = {};
  let allResolved = true;

  for (const { key, uri } of ATOMS) {
    console.log(`Looking up: ${key}`);
    console.log(`  URI: ${uri}`);

    const uriBytes = toBytes(uri);
    const uriHash = keccak256(uriBytes);
    console.log(`  Hash: ${uriHash}`);

    let atomId = null;

    if (lookupMethod === 'atomsByHash') {
      atomId = await lookupByHash(publicClient, uriHash);
    } else if (lookupMethod === 'atomByURI') {
      atomId = await lookupByURI(publicClient, uriBytes);
    } else {
      // Try both
      atomId = await lookupByHash(publicClient, uriHash);
      if (!atomId) {
        atomId = await lookupByURI(publicClient, uriBytes);
      }
    }

    if (atomId && atomId !== '0') {
      console.log(`  Atom ID: ${atomId}\n`);
      results[key] = { uri, atomId };
    } else {
      console.log(`  NOT FOUND (atom ID = 0 or call failed)\n`);
      results[key] = { uri, atomId: '0' };
      allResolved = false;
    }
  }

  // Load existing config and merge
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    // no existing config
  }

  const output = {
    ...existing,
    ...results,
    _meta: {
      ...(existing._meta || {}),
      network: 'testnet',
      chainId: 13579,
      multivault: MULTIVAULT_ADDRESS,
      lookedUpAt: new Date().toISOString(),
    },
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log('Config written to config/intuition-atoms.json');

  if (allResolved) {
    console.log('\nAll atom IDs resolved successfully.');
  } else {
    console.log('\nWARNING: Some atoms were not found. They may not have been created yet.');
  }

  // Print summary table
  console.log('\n--- Summary ---');
  for (const { key, uri } of ATOMS) {
    const id = results[key]?.atomId || '?';
    const status = id !== '0' && !id.startsWith('UNKNOWN') ? 'OK' : 'MISSING';
    console.log(`  ${key.padEnd(20)} → ${id.padEnd(10)} [${status}]`);
  }
}

// ---------------------------------------------------------------------------
// Detect which lookup function the contract supports
// ---------------------------------------------------------------------------

async function detectLookupMethod(publicClient) {
  // Test with a dummy hash
  const testHash = keccak256(toBytes('test'));

  try {
    await publicClient.readContract({
      address: MULTIVAULT_ADDRESS,
      abi: ATOMS_BY_HASH_ABI,
      functionName: 'atomsByHash',
      args: [testHash],
    });
    return 'atomsByHash';
  } catch {
    // not available
  }

  try {
    await publicClient.readContract({
      address: MULTIVAULT_ADDRESS,
      abi: ATOM_BY_URI_ABI,
      functionName: 'atomByURI',
      args: [toBytes('test')],
    });
    return 'atomByURI';
  } catch {
    // not available
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Lookup methods
// ---------------------------------------------------------------------------

async function lookupByHash(publicClient, uriHash) {
  try {
    const atomId = await publicClient.readContract({
      address: MULTIVAULT_ADDRESS,
      abi: ATOMS_BY_HASH_ABI,
      functionName: 'atomsByHash',
      args: [uriHash],
    });
    return atomId.toString();
  } catch (err) {
    console.log(`  atomsByHash failed: ${err.shortMessage || err.message}`);
    return null;
  }
}

async function lookupByURI(publicClient, uriBytes) {
  try {
    const atomId = await publicClient.readContract({
      address: MULTIVAULT_ADDRESS,
      abi: ATOM_BY_URI_ABI,
      functionName: 'atomByURI',
      args: [uriBytes],
    });
    return atomId.toString();
  } catch (err) {
    console.log(`  atomByURI failed: ${err.shortMessage || err.message}`);
    return null;
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
