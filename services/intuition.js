/**
 * Scannr — Intuition Network Service
 *
 * GraphQL reads (free) and transaction builders for the Intuition
 * MultiVault contract. All tx builders return unsigned transaction
 * objects — signing happens in the auth.html Privy page.
 */

import { createPublicClient, http, encodeFunctionData, parseEther, formatEther } from 'viem';
import { ENV } from '../config/env.js';
import { intuitionTestnet } from '../chains/intuition.js';

// ---------------------------------------------------------------------------
// Public Client (read-only)
// ---------------------------------------------------------------------------

const publicClient = createPublicClient({
  chain: intuitionTestnet,
  transport: http(ENV.INTUITION_RPC_URL),
});

// ---------------------------------------------------------------------------
// Well-known URIs
// ---------------------------------------------------------------------------

export const PREDICATES = {
  FLAGGED_AS_SCAM: 'intuition://predicate/flagged-as-scam',
  VOUCHED_AS_LEGITIMATE: 'intuition://predicate/vouched-as-legitimate',
};

export const OBJECTS = {
  SCAM: 'intuition://object/scam',
  LEGITIMATE: 'intuition://object/legitimate',
};

// ---------------------------------------------------------------------------
// MultiVault ABI (minimal — only functions we use)
// ---------------------------------------------------------------------------

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
    name: 'createTriples',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'subjectIds', type: 'bytes32[]' },
      { name: 'predicateIds', type: 'bytes32[]' },
      { name: 'objectIds', type: 'bytes32[]' },
      { name: 'assets', type: 'uint256[]' },
    ],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'receiver', type: 'address' },
      { name: 'termId', type: 'bytes32' },
      { name: 'curveId', type: 'uint256' },
      { name: 'minShares', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
];

// ---------------------------------------------------------------------------
// GraphQL Reads
// ---------------------------------------------------------------------------

async function gql(query, variables = {}) {
  const res = await fetch(ENV.INTUITION_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Intuition GraphQL error: ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

/**
 * Find an atom by its URI string. Returns { id } or null.
 */
export async function findAtomByUri(uri) {
  const data = await gql(`
    query FindAtom($uri: String!) {
      atoms(where: { uri: $uri }, limit: 1) {
        items { id }
      }
    }
  `, { uri });
  return data.atoms.items[0] || null;
}

/**
 * Find a triple by subject/predicate/object IDs. Returns { id } or null.
 */
export async function findTriple(subjectId, predicateId, objectId) {
  const data = await gql(`
    query FindTriple($subjectId: numeric!, $predicateId: numeric!, $objectId: numeric!) {
      triples(where: {
        subject_id: { _eq: $subjectId },
        predicate_id: { _eq: $predicateId },
        object_id: { _eq: $objectId }
      }, limit: 1) {
        items { id }
      }
    }
  `, {
    subjectId: Number(subjectId),
    predicateId: Number(predicateId),
    objectId: Number(objectId),
  });
  return data.triples.items[0] || null;
}

/**
 * Get accounts that have signaled (deposited) on a triple.
 */
export async function getSignalersForTriple(tripleId) {
  const data = await gql(`
    query GetSignalers($tripleId: numeric!) {
      positions(where: { vault_id: { _eq: $tripleId } }) {
        items {
          account { id label }
          shares
        }
      }
    }
  `, { tripleId: Number(tripleId) });
  return data.positions.items;
}

/**
 * Get native TRUST balance for a wallet address (via RPC, not GraphQL).
 */
export async function getWalletBalance(address) {
  const balance = await publicClient.getBalance({ address });
  return formatEther(balance);
}

// ---------------------------------------------------------------------------
// Transaction Builders (return unsigned tx objects for Privy signing)
// ---------------------------------------------------------------------------

const ATOM_COST = 1000000001000000n;   // ~0.001 TRUST (from getAtomCost)
const TRIPLE_COST = 1000000001000000n;  // ~0.001 TRUST (from getTripleCost)
const DEPOSIT_AMOUNT = parseEther('0.001');

/**
 * Build a createAtoms transaction (batch of 1).
 */
export function buildCreateAtomTx(uri, from) {
  const uriBytes = new TextEncoder().encode(uri);
  const hex = '0x' + Array.from(uriBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return {
    to: ENV.MULTIVAULT_ADDRESS,
    from,
    value: `0x${ATOM_COST.toString(16)}`,
    data: encodeFunctionData({
      abi: MULTIVAULT_ABI,
      functionName: 'createAtoms',
      args: [[hex], [ATOM_COST]],  // data[], assets[]
    }),
  };
}

/**
 * Build a createTriples transaction (batch of 1).
 * IDs are bytes32 hex strings.
 */
export function buildCreateTripleTx(subjectId, predicateId, objectId, from) {
  return {
    to: ENV.MULTIVAULT_ADDRESS,
    from,
    value: `0x${TRIPLE_COST.toString(16)}`,
    data: encodeFunctionData({
      abi: MULTIVAULT_ABI,
      functionName: 'createTriples',
      args: [[subjectId], [predicateId], [objectId], [TRIPLE_COST]],
    }),
  };
}

/**
 * Build a deposit transaction (signal support on existing term).
 */
export function buildDepositTx(receiver, termId, from) {
  return {
    to: ENV.MULTIVAULT_ADDRESS,
    from,
    value: `0x${DEPOSIT_AMOUNT.toString(16)}`,
    data: encodeFunctionData({
      abi: MULTIVAULT_ABI,
      functionName: 'deposit',
      args: [receiver, termId, 0n, 0n],  // curveId 0, minShares 0
    }),
  };
}
