/**
 * Scannr — Ethos Network Provider
 *
 * Ported from EthosService.ts with retry logic, batch scoring,
 * and X handle resolution.
 *
 * Ethos scores: 0–2800, normalized to 0–100 for the provider formula.
 *
 * Endpoints:
 *   GET  /api/v2/score/address?address=0x...    (single score)
 *   POST /api/v2/score/addresses                 (batch scores)
 *   GET  /api/v2/user/by/address/0x...          (X handle lookup)
 */

import { ReputationProvider } from './provider-interface.js';
import { CONFIG } from '../config/defaults.js';
import { memGet, memSet } from '../utils/cache.js';
import { createRateLimiter } from '../utils/rate-limiter.js';
import { logger } from '../utils/logger.js';

const ETHOS_MAX_SCORE = 2800;
const CACHE_PREFIX = 'ethos_';

const rateLimiter = createRateLimiter(
  CONFIG.RATE_LIMIT_MAX_CALLS_ETHOS,
  CONFIG.RATE_LIMIT_WINDOW_MS
);

/**
 * Fetch with exponential backoff on 429/5xx errors.
 */
async function fetchWithRetry(url, init, maxRetries = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.status === 429 || (response.status >= 500 && attempt < maxRetries)) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError || new Error('fetchWithRetry: all retries exhausted');
}

export class EthosProvider extends ReputationProvider {
  constructor() {
    super('ethos', 0.30);
  }

  /**
   * Query Ethos for a wallet address or account.
   * Returns normalized 0–100 score for the provider formula.
   */
  async query(identifier, type) {
    if (type !== 'wallet' && type !== 'account') {
      // Not applicable for link queries — return null score so aggregator skips this provider
      return { score: null, signals: { notApplicable: true }, raw: null };
    }

    const cacheKey = CACHE_PREFIX + identifier.toLowerCase();
    const cached = memGet(cacheKey);
    if (cached) return cached;

    if (!rateLimiter.canCall()) {
      logger.warn('Ethos rate limit reached');
      return { score: 0, signals: { rateLimited: true }, raw: null };
    }

    try {
      const data = await this._fetchScore(identifier);
      rateLimiter.record();

      const normalized = Math.round((data.score / ETHOS_MAX_SCORE) * 100);
      const result = {
        score: Math.min(100, Math.max(0, normalized)),
        signals: {
          rawScore: data.score,
          level: data.level,
          maxScore: ETHOS_MAX_SCORE,
        },
        raw: data,
      };

      memSet(cacheKey, result, CONFIG.SCORE_CACHE_TTL_MS);
      return result;
    } catch (err) {
      logger.error('Ethos query failed:', err);
      return { score: 0, signals: { error: err.message }, raw: null };
    }
  }

  /**
   * Get the raw Ethos score (0–2800) for report weight calculation.
   * Used directly by the trust engine (not the provider formula).
   */
  async getRawScore(walletAddress) {
    const normalized = walletAddress.toLowerCase();
    const cacheKey = CACHE_PREFIX + 'raw_' + normalized;
    const cached = memGet(cacheKey);
    if (cached) return cached;

    try {
      const data = await this._fetchScore(normalized);
      const result = {
        score: typeof data.score === 'number' ? data.score : 0,
        level: typeof data.level === 'string' ? data.level : 'neutral',
      };
      memSet(cacheKey, result, CONFIG.SCORE_CACHE_TTL_MS);
      return result;
    } catch {
      return { score: 0, level: 'neutral' };
    }
  }

  /**
   * Batch-fetch raw Ethos scores.
   * Ethos v2 batch response: object keyed by address.
   */
  async getRawScoresBatch(addresses) {
    const results = new Map();
    const uncached = [];

    for (const addr of addresses) {
      const normalized = addr.toLowerCase();
      const cached = memGet(CACHE_PREFIX + 'raw_' + normalized);
      if (cached) {
        results.set(normalized, cached);
      } else {
        uncached.push(normalized);
      }
    }

    if (uncached.length > 0) {
      try {
        const response = await fetchWithRetry(
          `${CONFIG.ETHOS_API_BASE_URL}/api/v2/score/addresses`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Ethos-Client': CONFIG.ETHOS_CLIENT_ID,
            },
            body: JSON.stringify({ addresses: uncached }),
          }
        );

        if (response.ok) {
          const data = await response.json();
          for (const [addr, scoreData] of Object.entries(data)) {
            const normalized = addr.toLowerCase();
            const result = {
              score: scoreData?.score ?? 0,
              level: scoreData?.level ?? 'neutral',
            };
            results.set(normalized, result);
            memSet(CACHE_PREFIX + 'raw_' + normalized, result, CONFIG.SCORE_CACHE_TTL_MS);
          }
        }
      } catch (error) {
        logger.warn('Ethos batch fetch failed:', error);
      }

      for (const addr of uncached) {
        if (!results.has(addr)) {
          results.set(addr, { score: 0, level: 'neutral' });
        }
      }
    }

    return results;
  }

  /**
   * Look up X handle from wallet address via Ethos profile.
   */
  async getXHandleByAddress(walletAddress) {
    try {
      const response = await fetch(
        `${CONFIG.ETHOS_API_BASE_URL}/api/v2/user/by/address/${encodeURIComponent(walletAddress.toLowerCase())}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Ethos-Client': CONFIG.ETHOS_CLIENT_ID,
          },
        }
      );

      if (!response.ok) return null;

      const data = await response.json();
      const xUserkey = (data.userkeys ?? []).find(
        (k) => k.startsWith('service:x.com:')
      );
      if (xUserkey) {
        const parts = xUserkey.split(':');
        if (parts[2] === 'username' && parts[3]) {
          return `@${parts[3]}`;
        }
      }
      if (data.username) return `@${data.username}`;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Health check — hit Ethos API with Vitalik's address.
   */
  async ping() {
    try {
      const url = `${CONFIG.ETHOS_API_BASE_URL}/api/v2/score/address?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`;
      const resp = await fetch(url, {
        headers: { 'X-Ethos-Client': CONFIG.ETHOS_CLIENT_ID },
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  // --- Internal ---

  async _fetchScore(walletAddress) {
    const url = `${CONFIG.ETHOS_API_BASE_URL}/api/v2/score/address?address=${encodeURIComponent(walletAddress)}`;
    const resp = await fetchWithRetry(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Ethos-Client': CONFIG.ETHOS_CLIENT_ID,
      },
    });

    if (resp.status === 404) {
      return { score: 0, level: 'neutral' };
    }

    if (!resp.ok) {
      throw new Error(`Ethos API ${resp.status}: ${resp.statusText}`);
    }

    return await resp.json();
  }
}
