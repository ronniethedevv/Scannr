/**
 * Scannr — Intuition Network Provider (v2)
 *
 * On-chain reputation provider that reads attestation data from
 * Intuition Network via the Hasura GraphQL API at testnet.intuition.sh.
 *
 * Schema migration (April 2026):
 *   - Old endpoint testnet.api.intuition.systems/graphql (retired) →
 *     new endpoint testnet.intuition.sh/v1/graphql
 *   - Atom IDs are bytes32 hex strings (e.g. "0x46810c72..."), not numerics
 *   - Lookup atoms by label (exact match on the tweet URL)
 *   - Triple signal = count of triples per predicate category
 *     (vault/share weighting not exposed in current schema)
 *
 * Score calculation:
 *   - Net = vouches - flags
 *   - Total = vouches + flags
 *   - If total == 0 → score 50 (neutral)
 *   - Otherwise → 50 + (net / total) * 50
 *   - Clamped to 0–100
 */

import { ReputationProvider } from './provider-interface.js';
import { ENV } from '../config/env.js';
import { memGet, memSet } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import ATOM_CONFIG from '../config/intuition-atoms.json';

const CACHE_TTL = 5 * 60_000; // 5 minutes
const CACHE_PREFIX = 'intuition_';

export class IntuitionProvider extends ReputationProvider {
  constructor() {
    super('intuition', 0.20);
  }

  /**
   * Query on-chain attestation data for a tweet URL.
   */
  async query(identifier, type) {
    // Only applicable for tweet URLs
    if (type !== 'link') {
      return { score: 50, signals: { notApplicable: true, attestations: 0 }, raw: null };
    }

    const cacheKey = CACHE_PREFIX + identifier;
    const cached = memGet(cacheKey);
    if (cached) return cached;

    try {
      const result = await this._queryIntuition(identifier);
      memSet(cacheKey, result, CACHE_TTL);
      return result;
    } catch (err) {
      logger.warn('[Intuition] Query failed:', err);
      return { score: 50, signals: { error: err.message, attestations: 0 }, raw: null };
    }
  }

  /**
   * Health check — verify Intuition GraphQL is reachable.
   */
  async ping() {
    try {
      const res = await fetch(ENV.INTUITION_GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: '{ atoms(limit: 1) { term_id } }',
        }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  async _gql(query, variables = {}) {
    const res = await fetch(ENV.INTUITION_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Intuition GraphQL ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    return json.data;
  }

  async _queryIntuition(tweetUrl) {
    // Step 1: Find atom for this tweet URL by label exact match
    const atomData = await this._gql(
      `query FindAtom($label: String!) {
        atoms(where: { label: { _eq: $label } }, limit: 1) {
          term_id
          label
          type
        }
      }`,
      { label: tweetUrl },
    );

    const atom = atomData.atoms?.[0];
    if (!atom) {
      return {
        score: 50,
        signals: { attestations: 0, vouches: 0, flags: 0, atomId: null },
        raw: null,
      };
    }

    const atomId = atom.term_id;

    // Step 2: Get all triples where this atom is the subject
    const triplesData = await this._gql(
      `query GetTriples($subjectId: String!) {
        triples(where: { subject_id: { _eq: $subjectId } }) {
          term_id
          predicate { term_id label }
          object { term_id label }
        }
      }`,
      { subjectId: atomId },
    );

    const triples = triplesData.triples || [];

    // Step 3: Count vouches vs flags using predicate atom IDs from config
    const vouchPredicateId = ATOM_CONFIG.is_trustworthy?.atomId;
    const flagPredicateIds = [
      ATOM_CONFIG.is_false_info?.atomId,
      ATOM_CONFIG.is_hacked_account?.atomId,
      ATOM_CONFIG.is_wrong_link?.atomId,
    ].filter(Boolean);

    let vouches = 0;
    let flags = 0;

    for (const triple of triples) {
      const pId = triple.predicate?.term_id;
      if (!pId) continue;

      if (pId === vouchPredicateId) {
        vouches += 1;
      } else if (flagPredicateIds.includes(pId)) {
        flags += 1;
      }
    }

    // Step 4: Compute score (same formula as CommunityProvider)
    const total = vouches + flags;
    let score = 50;
    if (total > 0) {
      const net = vouches - flags;
      score = Math.round(Math.min(100, Math.max(0, 50 + (net / total) * 50)));
    }

    logger.info(
      `[Intuition] ${tweetUrl}: vouches=${vouches}, flags=${flags}, score=${score}, atomId=${atomId}`,
    );

    return {
      score,
      signals: {
        vouches,
        flags,
        attestations: triples.length,
        atomId,
      },
      raw: { triples, atomId },
    };
  }
}