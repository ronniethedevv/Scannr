/**
 * Scannr — Attestation Service
 *
 * Orchestrates on-chain attestation creation on Intuition Network.
 * Given a report type (flag/vouch) and target URL, builds the
 * sequence of unsigned transactions needed:
 *
 *   1. Create target atom (tweet URL) if it doesn't exist
 *   2. Ensure predicate + object atoms exist
 *   3. Create triple or deposit into existing triple
 *
 * Returns an array of unsigned tx objects for Privy to sign.
 */

import {
  findAtomByUri,
  findTriple,
  buildCreateAtomTx,
  buildCreateTripleTx,
  buildDepositTx,
  PREDICATES,
  OBJECTS,
} from './intuition.js';

/**
 * Build all transactions needed for an attestation.
 *
 * @param {'flag'|'vouch'} reportType
 * @param {string} targetUrl - The tweet URL being flagged/vouched
 * @param {string} walletAddress - The signer's address
 * @returns {Promise<object[]>} Array of unsigned transaction objects
 */
export async function buildAttestationTxs(reportType, targetUrl, walletAddress) {
  const txs = [];

  const predicateUri = reportType === 'flag'
    ? PREDICATES.FLAGGED_AS_SCAM
    : PREDICATES.VOUCHED_AS_LEGITIMATE;

  const objectUri = reportType === 'flag'
    ? OBJECTS.SCAM
    : OBJECTS.LEGITIMATE;

  // Step 1: Ensure target atom exists (tweet URL)
  let targetAtom = await findAtomByUri(targetUrl);
  if (!targetAtom) {
    txs.push(buildCreateAtomTx(targetUrl, walletAddress));
  }

  // Step 2: Ensure predicate atom exists
  let predicateAtom = await findAtomByUri(predicateUri);
  if (!predicateAtom) {
    txs.push(buildCreateAtomTx(predicateUri, walletAddress));
  }

  // Step 3: Ensure object atom exists
  let objectAtom = await findAtomByUri(objectUri);
  if (!objectAtom) {
    txs.push(buildCreateAtomTx(objectUri, walletAddress));
  }

  // If we need to create atoms first, return those txs.
  // The service worker will call us again after atoms are created.
  if (txs.length > 0) {
    return txs;
  }

  // Step 4: Check if triple exists
  const triple = await findTriple(targetAtom.id, predicateAtom.id, objectAtom.id);

  if (triple) {
    // Triple exists — deposit to signal agreement
    txs.push(buildDepositTx(walletAddress, triple.id, walletAddress));
  } else {
    // Create the triple
    txs.push(buildCreateTripleTx(
      targetAtom.id,
      predicateAtom.id,
      objectAtom.id,
      walletAddress,
    ));
  }

  return txs;
}
