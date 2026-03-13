/**
 * Scannr — Aggregator
 *
 * Orchestrates all reputation providers and the trust data store.
 * Two modes of operation:
 *
 *   1. Provider-based: Query multiple providers in parallel, combine into
 *      a composite confidence score (for real-time badge display).
 *
 *   2. Report-based: Submit user reports weighted by Ethos score,
 *      aggregated into conviction levels with First Responder + Council
 *      (ported from TrustService).
 *
 * Handles provider failures gracefully — remaining providers still produce
 * a score. If ALL fail, returns "Unverified" (neutral).
 */

import { EthosProvider } from '../providers/ethos.js';
import { CommunityProvider } from '../providers/community.js';
import { PrintsProvider } from '../providers/prints.js';
import {
  computeProviderConfidence,
  computeReportWeight,
  aggregateTrustData,
} from './formula.js';
import { logger } from '../utils/logger.js';

// -------------------------------------------------------------------------
// Provider Registry
// -------------------------------------------------------------------------

/** @type {Object<string, import('../providers/provider-interface.js').ReputationProvider>} */
const providers = {};

/**
 * Register a provider instance. Replaces any existing provider with the same name.
 */
export function registerProvider(provider) {
  providers[provider.name] = provider;
  logger.info(`Provider registered: ${provider.name} (weight: ${provider.weight}, enabled: ${provider.enabled})`);
}

// Register built-in providers
registerProvider(new EthosProvider());
registerProvider(new CommunityProvider());
registerProvider(new PrintsProvider());

// -------------------------------------------------------------------------
// Trust Data Store (persisted via chrome.storage.local)
// -------------------------------------------------------------------------

const STORAGE_KEY = 'scannr_trust_data';

/** In-memory trust data: tweetUrl → TweetTrustData */
const trustDataStore = new Map();
let storeLoaded = false;

/** Load persisted trust data into memory */
async function loadTrustStore() {
  if (storeLoaded) return;
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY];
    if (stored) {
      for (const [url, data] of Object.entries(stored)) {
        trustDataStore.set(url, data);
      }
    }
    storeLoaded = true;
  } catch (err) {
    logger.warn('Failed to load trust store:', err);
    storeLoaded = true;
  }
}

/** Maximum trust data entries to persist (prevents unbounded storage growth) */
const MAX_TRUST_ENTRIES = 500;

/** Persist trust data to chrome.storage.local */
function persistTrustStore() {
  // Enforce size limit — evict oldest entries first
  if (trustDataStore.size > MAX_TRUST_ENTRIES) {
    const entries = [...trustDataStore.entries()];
    entries.sort((a, b) => new Date(a[1].lastUpdated || 0) - new Date(b[1].lastUpdated || 0));
    const toRemove = entries.slice(0, entries.length - MAX_TRUST_ENTRIES);
    for (const [url] of toRemove) {
      trustDataStore.delete(url);
    }
  }

  const obj = {};
  for (const [url, data] of trustDataStore.entries()) {
    obj[url] = data;
  }
  chrome.storage.local.set({ [STORAGE_KEY]: obj }).catch((err) => {
    logger.warn('Failed to persist trust store:', err);
  });
}

// Load on import
loadTrustStore();

// -------------------------------------------------------------------------
// Provider-Based Queries
// -------------------------------------------------------------------------

/**
 * Query all active providers for a given identifier.
 * Disabled providers' weights are redistributed proportionally to active ones.
 *
 * @param {string} identifier — X handle, wallet address, or tweet URL
 * @param {'account' | 'link' | 'wallet'} type
 * @returns {Promise<{confidence, conviction, breakdown, providerResults}>}
 */
export async function queryReputation(identifier, type) {
  const activeProviders = Object.values(providers).filter((p) => p.enabled);

  if (activeProviders.length === 0) {
    return { confidence: 50, conviction: 'Unverified', breakdown: {}, providerResults: [] };
  }

  // Redistribute disabled providers' weight proportionally to active ones.
  const rawTotal = activeProviders.reduce((sum, p) => sum + p.weight, 0);
  const redistributedWeights = new Map();
  for (const p of activeProviders) {
    redistributedWeights.set(p.name, rawTotal > 0 ? p.weight / rawTotal : 1 / activeProviders.length);
  }

  const settled = await Promise.allSettled(
    activeProviders.map(async (provider) => {
      const result = await provider.query(identifier, type);
      return {
        name: provider.name,
        score: result.score,
        weight: redistributedWeights.get(provider.name),
        active: true,
        signals: result.signals,
        raw: result.raw,
      };
    })
  );

  const providerResults = settled.map((outcome, i) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    logger.warn(`Provider ${activeProviders[i].name} failed:`, outcome.reason);
    return {
      name: activeProviders[i].name,
      score: 0,
      weight: redistributedWeights.get(activeProviders[i].name),
      active: false,
      signals: { error: outcome.reason?.message || 'Provider failed' },
      raw: null,
    };
  });

  const { confidence, conviction, breakdown } = computeProviderConfidence(providerResults);
  return { confidence, conviction, breakdown, providerResults };
}

/**
 * Batch query all active providers for multiple URLs.
 * Returns a merged Map<url, {score, signals}> with the best data from each.
 */
export async function queryBatchUrls(urls) {
  if (urls.length === 0) return new Map();

  const batchCapable = Object.values(providers).filter((p) => p.enabled);
  if (batchCapable.length === 0) return new Map();

  const results = new Map();
  const settled = await Promise.allSettled(
    batchCapable.map((p) => p.queryBatch(urls, 'link'))
  );

  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled') continue;
    for (const [url, data] of outcome.value.entries()) {
      const existing = results.get(url);
      if (!existing || data.score > existing.score) {
        results.set(url, data);
      }
    }
  }

  return results;
}

// -------------------------------------------------------------------------
// Report-Based Trust Engine (ported from TrustService)
// -------------------------------------------------------------------------

/**
 * Submit a new report for a tweet.
 *
 * Flow:
 *   1. Fetch reporter's Ethos score
 *   2. Compute weight (ethosScore² with self-report check)
 *   3. Add report to store and re-aggregate
 *
 * @returns {object} Updated TweetTrustData
 */
export async function submitReport(tweetUrl, tweetAuthorHandle, reporterWallet, claimType, context) {
  await loadTrustStore();

  // Step 1: Fetch Ethos score
  const ethosResult = await providers.ethos.getRawScore(reporterWallet);

  // Step 2: Try to resolve reporter's X handle
  const reporterHandle = await providers.ethos.getXHandleByAddress(reporterWallet).catch(() => null);

  // Step 3: Compute weight with integrity check
  const weight = computeReportWeight(ethosResult.score, reporterHandle, tweetAuthorHandle);

  // Step 4: Build report object
  const report = {
    id: `report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tweetUrl,
    tweetAuthorHandle,
    reporterWallet,
    reporterHandle,
    claimType,
    context,
    ethosScore: ethosResult.score,
    weight,
    createdAt: new Date().toISOString(),
  };

  // Step 5: Add to store and re-aggregate
  const existing = trustDataStore.get(tweetUrl);
  const reports = existing ? [...existing.reports, report] : [report];
  const trustData = aggregateTrustData(tweetUrl, reports);

  trustDataStore.set(tweetUrl, trustData);
  persistTrustStore();

  return trustData;
}

/**
 * Get cached trust data for a tweet URL.
 */
export function getTrustData(tweetUrl) {
  return trustDataStore.get(tweetUrl) || null;
}

/**
 * Get cached trust data for multiple URLs.
 */
export function getTrustDataBatch(urls) {
  const results = new Map();
  for (const url of urls) {
    const data = trustDataStore.get(url);
    if (data) results.set(url, data);
  }
  return results;
}


/**
 * Prune entries not in active viewport set.
 */
export function pruneStaleEntries(activeUrls) {
  let pruned = false;
  for (const url of trustDataStore.keys()) {
    if (!activeUrls.has(url)) {
      trustDataStore.delete(url);
      pruned = true;
    }
  }
  if (pruned) persistTrustStore();
}

// -------------------------------------------------------------------------
// Provider Management
// -------------------------------------------------------------------------

export async function checkProviderHealth() {
  const results = {};
  const checks = await Promise.allSettled(
    Object.values(providers).map(async (p) => ({
      name: p.name,
      healthy: await p.ping(),
    }))
  );

  for (const check of checks) {
    if (check.status === 'fulfilled') {
      results[check.value.name] = check.value.healthy;
    }
  }

  return results;
}

export function getProviders() {
  return { ...providers };
}

export function setProviderEnabled(name, enabled) {
  if (providers[name]) {
    providers[name].enabled = enabled;
    logger.info(`Provider ${name} ${enabled ? 'enabled' : 'disabled'}`);
  }
}

export function setProviderWeight(name, weight) {
  if (providers[name]) {
    providers[name].weight = Math.min(1, Math.max(0, weight));
    logger.info(`Provider ${name} weight set to ${weight}`);
  }
}
