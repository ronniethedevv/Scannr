/**
 * Scannr — Default Configuration
 *
 * All tunable parameters live here. Users can override weights
 * and thresholds via the popup settings panel.
 */

export const CONFIG = {
  // -----------------------------------------------------------------------
  // Provider API Endpoints
  // -----------------------------------------------------------------------
  ETHOS_API_BASE_URL: 'https://api.ethos.network',
  ETHOS_CLIENT_ID: 'scannr@1.0.0',

  PRINTS_API_BASE_URL: '', // Placeholder — set when API goes live

  // -----------------------------------------------------------------------
  // Provider Weights (used in confidence formula, 0–1 scale, must sum to 1)
  // -----------------------------------------------------------------------
  PROVIDER_WEIGHTS: {
    ethos: 0.35,
    community: 0.40,
    prints: 0.25,  // Low weight until API is live; redistributed when disabled
  },

  // -----------------------------------------------------------------------
  // Feature Flags
  // -----------------------------------------------------------------------
  ETHOS_ENABLED: true,
  COMMUNITY_ENABLED: true,
  PRINTS_ENABLED: false,  // Flip to true once Fluent Prints API is available

  // -----------------------------------------------------------------------
  // Conviction Thresholds (net negative weight boundaries)
  // -----------------------------------------------------------------------
  THRESHOLD_SAFE: 0,
  THRESHOLD_UNVERIFIED: 1_000_000,
  THRESHOLD_LIKELY_SCAM: 10_000_000,
  // >= THRESHOLD_LIKELY_SCAM → Verified Scam (fall-through)

  // -----------------------------------------------------------------------
  // Contested Content — when both sides have significant weight
  // -----------------------------------------------------------------------
  CONTESTED_RATIO: 0.4,  // If minority side >= 40% of majority → "Contested"

  // -----------------------------------------------------------------------
  // Scoring
  // -----------------------------------------------------------------------
  COUNCIL_SIZE: 5,              // Top N reporters by reputation shown in sidebar
  WEIGHT_EXPONENT: 2,           // weight = ethosScore ^ WEIGHT_EXPONENT

  // -----------------------------------------------------------------------
  // Polling & Performance
  // -----------------------------------------------------------------------
  POLLING_INTERVAL_MS: 30_000,      // Background poll cycle (30s)
  VIEWPORT_SYNC_INTERVAL_MS: 15_000, // Content script → background URL sync
  MUTATION_DEBOUNCE_MS: 100,         // DOM mutation observer debounce
  SCORE_CACHE_TTL_MS: 5 * 60_000,   // Ethos score cache lifetime (5 min)

  // -----------------------------------------------------------------------
  // Rate Limiting
  // -----------------------------------------------------------------------
  RATE_LIMIT_WINDOW_MS: 60_000,       // 1-minute sliding window
  RATE_LIMIT_MAX_CALLS_ETHOS: 30,     // Max Ethos API calls per window
  RATE_LIMIT_MAX_CALLS_COMMUNITY: 60, // Max Community (Supabase) calls per window
  RATE_LIMIT_MAX_CALLS_PRINTS: 30,    // Max Prints API calls per window

  // -----------------------------------------------------------------------
  // UI — X's native color palette
  // -----------------------------------------------------------------------
  X_COLORS: {
    safe:     '#00BA7C',
    warning:  '#FFD400',
    danger:   '#F4212E',
    neutral:  '#71767B',
    bg:       '#000000',
    bgHover:  '#16181C',
    border:   '#2F3336',
    text:     '#E7E9EA',
    textSec:  '#71767B',
  },

  // Trust pill — conviction → color + background mapping
  TRUST_PILL: {
    'Verified Scam':     { color: '#F4212E', bg: 'rgba(244, 33, 46, 0.15)' },
    'Likely Scam':       { color: '#FFD400', bg: 'rgba(255, 212, 0, 0.15)' },
    'Contested Content': { color: '#FFD400', bg: 'rgba(255, 212, 0, 0.15)' },
    'Safe':              { color: '#00BA7C', bg: 'rgba(0, 186, 124, 0.15)' },
    'Unverified':        { color: '#71767B', bg: 'rgba(113, 118, 123, 0.15)' },
  },

  // -----------------------------------------------------------------------
  // DOM Selectors (X/Twitter — March 2026)
  // -----------------------------------------------------------------------
  SELECTOR_TWEET: '[data-testid="tweet"]',
  SELECTOR_TWEET_FALLBACKS: [
    'article[data-testid="tweet"]',
    'article[role="article"]',
    '[data-testid="cellInnerDiv"] article',
  ],
  SELECTOR_TWEET_TEXT: '[data-testid="tweetText"]',
  SELECTOR_TWEET_ACTIONS: '[role="group"]',
  SELECTOR_TWEET_HEADER: '[data-testid="User-Name"]',

  // -----------------------------------------------------------------------
  // CSS
  // -----------------------------------------------------------------------
  CSS_PREFIX: 'scannr',
};
