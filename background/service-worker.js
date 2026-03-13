/**
 * Scannr — Background Service Worker
 *
 * Runs as the MV3 service worker. Responsibilities:
 *   1. Message routing between content scripts, popup, and providers
 *   2. Alarm-based polling for visible tweet URLs
 *   3. Report submission with Ethos-weighted conviction
 *   4. Trust data persistence (survives worker restarts)
 *   5. Provider health monitoring
 */

import { CONFIG } from '../config/defaults.js';
import {
  queryReputation,
  checkProviderHealth,
  setProviderEnabled,
  setProviderWeight,
  getTrustData,
  pruneStaleEntries,
} from '../engine/aggregator.js';
import { signIn, signOut, getUser } from '../auth/session.js';
import { submitReport } from '../api/submissions.js';
import { logger } from '../utils/logger.js';

const ALARM_POLL = 'scannr:poll';
const STORAGE_KEY_ENABLED = 'scannr_enabled';

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

let visibleTweetUrls = [];
let scannrEnabled = false;

// -------------------------------------------------------------------------
// Initialization
// -------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  logger.info('Extension installed/updated');
  const stored = await chrome.storage.local.get(STORAGE_KEY_ENABLED);

  if (details.reason === 'install' && stored[STORAGE_KEY_ENABLED] === undefined) {
    // Default to enabled on first install
    scannrEnabled = true;
    await chrome.storage.local.set({ [STORAGE_KEY_ENABLED]: true });
    logger.info('First install — defaulting to enabled');
  } else {
    scannrEnabled = stored[STORAGE_KEY_ENABLED] === true;
  }

  if (scannrEnabled) startPolling();
});

chrome.runtime.onStartup.addListener(async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEY_ENABLED);
  scannrEnabled = stored[STORAGE_KEY_ENABLED] === true;
  if (scannrEnabled) startPolling();
});

// -------------------------------------------------------------------------
// Message Handling
// -------------------------------------------------------------------------

// Valid message types this service worker accepts
const VALID_MESSAGE_TYPES = new Set([
  'scannr:query',
  'scannr:report-visible-urls',
  'scannr:get-trust-data',
  'scannr:toggle',
  'scannr:get-status',
  'scannr:set-provider',
  'scannr:set-weight',
  'scannr:health-check',
  'scannr:sign-in',
  'scannr:sign-out',
  'scannr:get-user',
  'scannr:submit-report',
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Security: verify sender is this extension
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ error: 'unauthorized' });
    return false;
  }

  // Security: validate message type against whitelist
  if (!message?.type || !VALID_MESSAGE_TYPES.has(message.type)) {
    return false;
  }

  switch (message.type) {
    // --- Provider-based reputation query ---
    case 'scannr:query': {
      const { identifier, type } = message.payload || {};
      if (typeof identifier !== 'string' || !identifier || !['account', 'link', 'wallet'].includes(type)) {
        sendResponse({ error: 'Invalid query payload' });
        return false;
      }
      queryReputation(identifier, type)
        .then((result) => sendResponse({ result }))
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    // --- Content script reports visible tweet URLs ---
    case 'scannr:report-visible-urls': {
      visibleTweetUrls = message.payload.urls || [];
      sendResponse({ ok: true });
      return false;
    }

    // --- Get cached trust data for URLs ---
    case 'scannr:get-trust-data': {
      const urls = message.payload?.tweetUrls || [];
      const cached = [];
      for (const url of urls) {
        const data = getTrustData(url);
        if (data) cached.push(data);
      }
      // Push cached data back to requesting tab
      if (cached.length > 0 && sender.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'scannr:trust-update',
          payload: { updates: cached },
        }).catch(() => {});
      }
      sendResponse({ ok: true });
      return false;
    }

    // --- Popup toggles Scannr on/off ---
    case 'scannr:toggle': {
      const enabled = message.payload.enabled === true;
      scannrEnabled = enabled;
      chrome.storage.local.set({ [STORAGE_KEY_ENABLED]: enabled });

      if (enabled) {
        startPolling();
      } else {
        stopPolling();
      }

      broadcastToXTabs({ type: 'scannr:toggle', payload: { enabled } });
      sendResponse({ ok: true });
      return false;
    }

    // --- Popup requests status ---
    case 'scannr:get-status': {
      handleGetStatus().then(sendResponse);
      return true;
    }

    // --- Popup toggles a provider ---
    case 'scannr:set-provider': {
      const { name, enabled } = message.payload;
      setProviderEnabled(name, enabled);
      chrome.storage.local.set({ [`scannr_provider_${name}`]: enabled });
      sendResponse({ ok: true });
      return false;
    }

    // --- Popup adjusts a provider weight ---
    case 'scannr:set-weight': {
      const { name: provName, weight } = message.payload;
      setProviderWeight(provName, weight);
      chrome.storage.local.set({ [`scannr_weight_${provName}`]: weight });
      sendResponse({ ok: true });
      return false;
    }

    // --- Health check ---
    case 'scannr:health-check': {
      checkProviderHealth().then((health) => sendResponse({ health }));
      return true;
    }

    // --- Auth: Sign in with X ---
    case 'scannr:sign-in': {
      signIn().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    // --- Auth: Sign out ---
    case 'scannr:sign-out': {
      signOut().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    // --- Auth: Get current user ---
    case 'scannr:get-user': {
      getUser().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    // --- Community: Submit flag/vouch ---
    case 'scannr:submit-report': {
      const { reportType, targetUrl, category, note } = message.payload || {};
      if (!reportType || !targetUrl) {
        sendResponse({ error: 'Invalid submission payload' });
        return false;
      }
      submitReport(reportType, targetUrl, category, note)
        .then(sendResponse)
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    default:
      return false;
  }
});

// -------------------------------------------------------------------------
// Status
// -------------------------------------------------------------------------

async function handleGetStatus() {
  const health = await checkProviderHealth();
  return {
    enabled: scannrEnabled,
    providerHealth: health,
    visibleUrls: visibleTweetUrls.length,
  };
}

// -------------------------------------------------------------------------
// Polling — periodic trust data sync
// -------------------------------------------------------------------------

function startPolling() {
  chrome.alarms.clear(ALARM_POLL).catch(() => {});
  const minutes = Math.max(CONFIG.POLLING_INTERVAL_MS / 60_000, 0.5);
  chrome.alarms.create(ALARM_POLL, {
    delayInMinutes: minutes,
    periodInMinutes: minutes,
  });
  logger.info(`Polling started (every ${CONFIG.POLLING_INTERVAL_MS / 1000}s)`);
}

function stopPolling() {
  chrome.alarms.clear(ALARM_POLL).catch(() => {});
  visibleTweetUrls = [];
  logger.info('Polling stopped');
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_POLL) return;
  if (!scannrEnabled || visibleTweetUrls.length === 0) return;

  try {
    // Prune stale entries
    pruneStaleEntries(new Set(visibleTweetUrls));
  } catch (err) {
    logger.warn('Poll cycle failed:', err);
  }
});

// -------------------------------------------------------------------------
// Broadcasting
// -------------------------------------------------------------------------

async function broadcastToXTabs(message) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    }
  } catch {
    // Extension context may be invalidated
  }
}
