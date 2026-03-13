/**
 * Scannr — Provider Interface
 *
 * Every reputation data source must implement this interface.
 * This makes adding/removing providers trivial — swap one file,
 * update config/defaults.js, done.
 *
 * Implementing a new provider:
 *   1. Create providers/your-provider.js
 *   2. Extend ReputationProvider
 *   3. Implement query() and ping()
 *   4. Optionally implement queryBatch() for batch-capable providers
 *   5. Add to config/defaults.js (weight + feature flag)
 *   6. Register via registerProvider() in engine/aggregator.js
 */

export class ReputationProvider {
  /**
   * @param {string} name — unique provider identifier (e.g., "ethos", "prints")
   * @param {number} weight — default weight in confidence formula (0–1)
   */
  constructor(name, weight) {
    this.name = name;
    this.weight = weight;
    this.enabled = true;
  }

  /**
   * Query reputation for a given identifier.
   *
   * @param {string} identifier — X handle, wallet address, or URL
   * @param {'account' | 'link' | 'wallet'} type — what kind of lookup
   * @returns {Promise<{
   *   score: number,       // 0–100 normalized reputation score
   *   signals: object,     // structured breakdown (provider-specific)
   *   raw: object | null   // unprocessed API response for debugging
   * }>}
   */
  async query(identifier, type) {
    throw new Error(`${this.name}: query() must be implemented`);
  }

  /**
   * Batch query — query multiple identifiers at once.
   * Override this for providers that support batch APIs.
   * Default falls back to sequential single queries.
   *
   * @param {string[]} identifiers
   * @param {'account' | 'link' | 'wallet'} type
   * @returns {Promise<Map<string, {score, signals, raw}>>}
   */
  async queryBatch(identifiers, type) {
    const results = new Map();
    for (const id of identifiers) {
      try {
        results.set(id, await this.query(id, type));
      } catch {
        results.set(id, { score: 0, signals: { error: 'batch fallback failed' }, raw: null });
      }
    }
    return results;
  }

  /**
   * Health check — is this provider's API reachable?
   *
   * @returns {Promise<boolean>}
   */
  async ping() {
    throw new Error(`${this.name}: ping() must be implemented`);
  }
}
