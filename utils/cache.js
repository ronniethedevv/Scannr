/**
 * Scannr — Cache Utility
 *
 * Two-tier caching:
 *   1. In-memory Map for hot data (sub-ms access, lost on service worker kill)
 *   2. chrome.storage.local for persistent data (survives restarts)
 *
 * Each entry has a TTL. Expired entries are lazily evicted on read.
 */

import { logger } from './logger.js';

// -------------------------------------------------------------------------
// In-Memory Cache (fast, ephemeral)
// -------------------------------------------------------------------------

const memoryStore = new Map();

/**
 * Get a value from the in-memory cache.
 * Returns null if missing or expired.
 */
export function memGet(key) {
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
}

/**
 * Set a value in the in-memory cache with a TTL (ms).
 */
export function memSet(key, value, ttlMs) {
  memoryStore.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Delete a key from the in-memory cache.
 */
export function memDelete(key) {
  memoryStore.delete(key);
}

/**
 * Clear the entire in-memory cache.
 */
export function memClear() {
  memoryStore.clear();
}

// -------------------------------------------------------------------------
// Persistent Cache (chrome.storage.local)
// -------------------------------------------------------------------------

const STORAGE_PREFIX = 'scannr_cache_';

/**
 * Get a value from persistent storage.
 * Returns null if missing or expired.
 */
export async function persistGet(key) {
  try {
    const storageKey = STORAGE_PREFIX + key;
    const result = await chrome.storage.local.get(storageKey);
    const entry = result[storageKey];
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      await chrome.storage.local.remove(storageKey);
      return null;
    }
    return entry.value;
  } catch (err) {
    logger.warn('persistGet failed:', err);
    return null;
  }
}

/**
 * Set a value in persistent storage with a TTL (ms).
 */
export async function persistSet(key, value, ttlMs) {
  try {
    const storageKey = STORAGE_PREFIX + key;
    await chrome.storage.local.set({
      [storageKey]: {
        value,
        expiresAt: Date.now() + ttlMs,
      },
    });
  } catch (err) {
    logger.warn('persistSet failed:', err);
  }
}

/**
 * Delete a key from persistent storage.
 */
export async function persistDelete(key) {
  try {
    await chrome.storage.local.remove(STORAGE_PREFIX + key);
  } catch (err) {
    logger.warn('persistDelete failed:', err);
  }
}

/**
 * Clear all Scannr cache entries from persistent storage.
 */
export async function persistClearAll() {
  try {
    const all = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(all).filter((k) => k.startsWith(STORAGE_PREFIX));
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }
  } catch (err) {
    logger.warn('persistClearAll failed:', err);
  }
}
