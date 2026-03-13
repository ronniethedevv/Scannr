/**
 * Scannr — Confidence Formula
 *
 * Ported from TrustService.calculateConfidence() — the core reputation-weighted
 * conviction algorithm. Also includes the new provider-based multi-source formula.
 *
 * Report-based math:
 *   - Each report's weight = ethosScore² (quadratic voting)
 *   - Net score = Σ(negative weights) - Σ(positive weights)
 *   - Thresholds determine conviction level
 *   - Self-reporting → weight = 0
 *   - "Contested Content" when both sides strong and within 40% ratio
 *
 * Provider-based math:
 *   - Each provider returns normalized 0–100 score
 *   - Weighted average across active providers → conviction level
 */

import { CONFIG } from '../config/defaults.js';

export const CONVICTION_LEVELS = {
  SAFE: 'Safe',
  UNVERIFIED: 'Unverified',
  LIKELY_SCAM: 'Likely Scam',
  VERIFIED_SCAM: 'Verified Scam',
  CONTESTED: 'Contested Content',
};

// =========================================================================
// Report-Based Conviction (original Scannr algorithm)
// =========================================================================

/**
 * Calculate conviction level from user reports.
 *
 * @param {Array<{claimType: string, weight: number}>} reports
 * @returns {string} ConvictionLevel
 */
export function calculateConfidence(reports) {
  if (!reports || reports.length === 0) return CONVICTION_LEVELS.UNVERIFIED;

  let negativeWeight = 0;
  let positiveWeight = 0;

  for (const report of reports) {
    if (report.claimType === 'negative') {
      negativeWeight += report.weight;
    } else {
      positiveWeight += report.weight;
    }
  }

  // Contested Content Detection
  const larger = Math.max(negativeWeight, positiveWeight);
  const smaller = Math.min(negativeWeight, positiveWeight);

  if (
    larger > CONFIG.THRESHOLD_UNVERIFIED &&
    smaller > CONFIG.THRESHOLD_UNVERIFIED &&
    smaller / larger >= CONFIG.CONTESTED_RATIO
  ) {
    return CONVICTION_LEVELS.CONTESTED;
  }

  const netScore = negativeWeight - positiveWeight;

  if (netScore < CONFIG.THRESHOLD_SAFE) return CONVICTION_LEVELS.SAFE;
  if (netScore < CONFIG.THRESHOLD_UNVERIFIED) return CONVICTION_LEVELS.UNVERIFIED;
  if (netScore < CONFIG.THRESHOLD_LIKELY_SCAM) return CONVICTION_LEVELS.LIKELY_SCAM;

  return CONVICTION_LEVELS.VERIFIED_SCAM;
}

/**
 * Compute report weight. weight = ethosScore²
 * Returns 0 if reporter handle matches tweet author (self-report prevention).
 *
 * @param {number} ethosScore — 0–2800
 * @param {string|null} reporterHandle
 * @param {string} tweetAuthorHandle
 * @returns {number}
 */
export function computeReportWeight(ethosScore, reporterHandle, tweetAuthorHandle) {
  if (
    reporterHandle &&
    tweetAuthorHandle &&
    reporterHandle.toLowerCase() === tweetAuthorHandle.toLowerCase()
  ) {
    return 0;
  }
  return Math.pow(Math.abs(ethosScore || 0), CONFIG.WEIGHT_EXPONENT);
}

/**
 * Build full TweetTrustData from reports.
 * Computes conviction, weight sums, First Responder, and Council.
 *
 * @param {string} tweetUrl
 * @param {Array} reports
 * @returns {object} TweetTrustData
 */
export function aggregateTrustData(tweetUrl, reports) {
  let negativeWeight = 0;
  let positiveWeight = 0;

  for (const r of reports) {
    if (r.claimType === 'negative') {
      negativeWeight += r.weight;
    } else {
      positiveWeight += r.weight;
    }
  }

  const sorted = [...reports].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  const firstResponder = sorted.length > 0 ? sorted[0] : null;

  const council = reports
    .filter((r) => r.id !== firstResponder?.id)
    .sort((a, b) => b.ethosScore - a.ethosScore)
    .slice(0, CONFIG.COUNCIL_SIZE);

  const conviction = calculateConfidence(reports);

  return {
    tweetUrl,
    reports,
    conviction,
    negativeWeight,
    positiveWeight,
    firstResponder,
    council,
    lastUpdated: new Date().toISOString(),
  };
}

// =========================================================================
// Provider-Based Confidence (multi-source formula)
// =========================================================================

/**
 * Compute weighted confidence from provider results.
 *
 * @param {Array<{name: string, score: number, weight: number, active: boolean}>} providerResults
 * @returns {{confidence: number, conviction: string, breakdown: object}}
 */
export function computeProviderConfidence(providerResults) {
  const active = providerResults.filter(
    (p) => p.active && typeof p.score === 'number' && p.score >= 0
  );

  if (active.length === 0) {
    return { confidence: 50, conviction: CONVICTION_LEVELS.UNVERIFIED, breakdown: {} };
  }

  const totalWeight = active.reduce((sum, p) => sum + p.weight, 0);
  let weightedSum = 0;
  const breakdown = {};

  for (const provider of active) {
    const normalizedWeight = provider.weight / totalWeight;
    const contribution = provider.score * normalizedWeight;
    weightedSum += contribution;
    breakdown[provider.name] = {
      score: provider.score,
      weight: normalizedWeight,
      contribution: Math.round(contribution * 100) / 100,
    };
  }

  const confidence = Math.round(Math.min(100, Math.max(0, weightedSum)));
  const conviction = scoreToConviction(confidence);

  return { confidence, conviction, breakdown };
}

/**
 * Map 0–100 confidence to conviction level.
 *   80–100 → Safe, 60–79 → Unverified, 40–59 → Contested,
 *   20–39 → Likely Scam, 0–19 → Verified Scam
 */
export function scoreToConviction(score) {
  if (score >= 80) return CONVICTION_LEVELS.SAFE;
  if (score >= 60) return CONVICTION_LEVELS.UNVERIFIED;
  if (score >= 40) return CONVICTION_LEVELS.CONTESTED;
  if (score >= 20) return CONVICTION_LEVELS.LIKELY_SCAM;
  return CONVICTION_LEVELS.VERIFIED_SCAM;
}

/**
 * Format large weight numbers for display (e.g. 1,000,000 → "1.0M").
 */
export function formatWeight(weight) {
  if (weight >= 1_000_000_000) return `${(weight / 1_000_000_000).toFixed(1)}B`;
  if (weight >= 1_000_000) return `${(weight / 1_000_000).toFixed(1)}M`;
  if (weight >= 1_000) return `${(weight / 1_000).toFixed(1)}K`;
  return weight.toLocaleString();
}
