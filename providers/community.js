/**
 * Scannr — Community Provider
 *
 * Reputation provider powered by community flag/vouch submissions
 * stored in Supabase. Replaces the Intuition on-chain provider.
 *
 * Score calculation:
 *   - Net = vouches - flags
 *   - Total = vouches + flags
 *   - If total == 0 → score 50 (neutral)
 *   - Otherwise → 50 + (net / total) * 50
 *   - Clamped to 0–100
 *
 * This gives a simple sentiment score:
 *   100 = all vouches, 50 = neutral/no data, 0 = all flags
 */

import { ReputationProvider } from './provider-interface.js';
import { CONFIG } from '../config/defaults.js';
import { getSubmissionsForUrl, getSubmissionsBatch } from '../api/submissions.js';
import { logger } from '../utils/logger.js';

export class CommunityProvider extends ReputationProvider {
  constructor() {
    super('community', CONFIG.PROVIDER_WEIGHTS.community);
  }

  /**
   * Query community reputation for a URL.
   */
  async query(identifier, type) {
    try {
      const { flags, vouches } = await getSubmissionsForUrl(identifier);
      const score = this._computeScore(flags, vouches);

      return {
        score,
        signals: { flags, vouches, total: flags + vouches },
        raw: { flags, vouches },
      };
    } catch (err) {
      logger.warn('Community provider query failed:', err);
      return { score: 50, signals: { error: err.message }, raw: null };
    }
  }

  /**
   * Batch query — fetch submission counts for multiple URLs.
   */
  async queryBatch(identifiers, type) {
    const results = new Map();
    try {
      const batchData = await getSubmissionsBatch(identifiers);
      for (const [url, { flags, vouches }] of batchData.entries()) {
        const score = this._computeScore(flags, vouches);
        results.set(url, {
          score,
          signals: { flags, vouches, total: flags + vouches },
          raw: { flags, vouches },
        });
      }
    } catch (err) {
      logger.warn('Community provider batch query failed:', err);
      for (const id of identifiers) {
        results.set(id, { score: 50, signals: { error: err.message }, raw: null });
      }
    }
    return results;
  }

  /**
   * Health check — verify Supabase is reachable.
   */
  async ping() {
    try {
      // A lightweight query to verify connectivity
      const { getSupabase } = await import('../api/supabase.js');
      const supabase = getSupabase();
      const { error } = await supabase.from('submissions').select('id').limit(1);
      return !error;
    } catch {
      return false;
    }
  }

  /**
   * Score = 50 + (net / total) * 50, clamped to 0–100.
   * Returns 50 (neutral) when there are no submissions.
   */
  _computeScore(flags, vouches) {
    const total = flags + vouches;
    if (total === 0) return 50;
    const net = vouches - flags;
    return Math.round(Math.min(100, Math.max(0, 50 + (net / total) * 50)));
  }
}
