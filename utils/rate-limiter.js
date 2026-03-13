/**
 * Scannr — Rate Limiter
 *
 * Sliding-window rate limiter for API calls. Each provider gets its own
 * limiter instance to prevent one noisy provider from starving others.
 *
 * Usage:
 *   const limiter = createRateLimiter(30, 60_000); // 30 calls per minute
 *   if (limiter.canCall()) {
 *     limiter.record();
 *     await fetch(...);
 *   } else {
 *     // Back off or queue
 *   }
 */

/**
 * Create a rate limiter with a sliding window.
 *
 * @param {number} maxCalls — maximum calls allowed in the window
 * @param {number} windowMs — window duration in milliseconds
 * @returns {{ canCall: () => boolean, record: () => void, remaining: () => number }}
 */
export function createRateLimiter(maxCalls, windowMs) {
  const timestamps = [];

  function prune() {
    const cutoff = Date.now() - windowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
  }

  return {
    /** Check if a call is allowed without recording it. */
    canCall() {
      prune();
      return timestamps.length < maxCalls;
    },

    /** Record a call (call this AFTER making the request). */
    record() {
      timestamps.push(Date.now());
    },

    /** How many calls remain in the current window. */
    remaining() {
      prune();
      return Math.max(0, maxCalls - timestamps.length);
    },

    /** Reset the limiter (e.g., after a long pause). */
    reset() {
      timestamps.length = 0;
    },
  };
}
