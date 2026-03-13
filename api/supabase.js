/**
 * Scannr — Supabase Client
 *
 * Singleton Supabase client configured for Chrome Extension environment.
 * Uses chrome.storage.local as the session persistence layer so auth
 * tokens survive service worker restarts.
 */

import { createClient } from '@supabase/supabase-js';
import { ENV } from '../config/env.js';

// ---------------------------------------------------------------------------
// Custom storage adapter — chrome.storage.local (async, MV3-safe)
// ---------------------------------------------------------------------------

const chromeStorageAdapter = {
  async getItem(key) {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? null;
  },
  async setItem(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async removeItem(key) {
    await chrome.storage.local.remove(key);
  },
};

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let client = null;

export function getSupabase() {
  if (!client) {
    client = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_ANON_KEY, {
      auth: {
        storage: chromeStorageAdapter,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false, // no URL-based auth in extensions
      },
    });
  }
  return client;
}
