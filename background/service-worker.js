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
  getTrustData,
  pruneStaleEntries,
} from '../engine/aggregator.js';
import { signIn, signOut, getUser } from '../auth/session.js';
import { submitReport } from '../api/submissions.js';
import { logger } from '../utils/logger.js';
import { getWalletAddress, setWalletAddress, clearWallet } from '../services/wallet.js';
import { ENV } from '../config/env.js';

const ALARM_POLL = 'scannr:poll';
const STORAGE_KEY_ENABLED = 'scannr_enabled';

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

let visibleTweetUrls = [];
let scannrEnabled = false;

// Log redirect URL on startup so we can verify it matches Supabase config
console.log('[Scannr SW] Extension redirect URL:', chrome.identity.getRedirectURL());

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
  'scannr:health-check',
  'scannr:sign-in',
  'scannr:sign-out',
  'scannr:get-user',
  'scannr:submit-report',
  'scannr:get-recent-submissions',
  'scannr:get-community-submissions',
  'scannr:get-user-profile',
  'scannr:get-wallet',
  'scannr:open-wallet-setup',
  'scannr:disconnect-wallet',
  'scannr:get-wallet-balance',
  'scannr:attestation-request',
  'scannr:attestation-complete',
  'scannr:query-ethos-handle',
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

    // --- Health check ---
    case 'scannr:health-check': {
      checkProviderHealth().then((health) => sendResponse({ health }));
      return true;
    }

    // --- Auth: Sign in with X ---
    case 'scannr:sign-in': {
      console.log('[Scannr SW] Sign-in message received');
      signIn()
        .then((result) => {
          console.log('[Scannr SW] Sign-in result:', JSON.stringify(result));
          sendResponse(result);
        })
        .catch((err) => {
          console.log('[Scannr SW] Sign-in exception:', err.message, err);
          sendResponse({ error: err.message });
        });
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

    // --- Community: Get current user's recent submissions ---
    case 'scannr:get-recent-submissions': {
      const limit = message.payload?.limit || 20;
      import('../api/supabase.js').then(async ({ getSupabase }) => {
        const supabase = getSupabase();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          sendResponse({ error: 'Not signed in' });
          return;
        }
        const { data, error } = await supabase
          .from('submissions')
          .select('id, target_url, type, category, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(limit);
        if (error) {
          sendResponse({ error: error.message });
        } else {
          sendResponse({ submissions: data || [] });
        }
      }).catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    // --- Community: Get all submissions for a specific tweet ---
    case 'scannr:get-community-submissions': {
      const tweetUrl = message.payload?.tweetUrl;
      if (!tweetUrl) {
        sendResponse({ error: 'Missing tweetUrl' });
        return false;
      }
      import('../api/supabase.js').then(async ({ getSupabase }) => {
        const supabase = getSupabase();
        const { data, error } = await supabase
          .from('submissions')
          .select('id, type, category, reporter_handle, created_at')
          .eq('target_url', tweetUrl)
          .order('created_at', { ascending: false });
        if (error) {
          sendResponse({ error: error.message });
        } else {
          sendResponse({ submissions: data || [] });
        }
      }).catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    // --- Profile: Get current user's profile from users table ---
    case 'scannr:get-user-profile': {
      import('../api/supabase.js').then(async ({ getSupabase }) => {
        const supabase = getSupabase();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          sendResponse({ error: 'Not signed in' });
          return;
        }
        const { data: profile, error } = await supabase
          .from('users')
          .select('x_handle, x_display_name, x_avatar_url, ethos_score, ethos_level')
          .eq('id', user.id)
          .single();
        if (error) {
          sendResponse({ error: error.message });
        } else {
          sendResponse({ profile });
        }
      }).catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    // --- Wallet: Get stored address ---
    case 'scannr:get-wallet': {
      getWalletAddress().then((address) => sendResponse({ address }));
      return true;
    }

    // --- Wallet: Open hosted Privy auth page ---
    case 'scannr:open-wallet-setup': {
      chrome.tabs.create({ url: ENV.PRIVY_AUTH_URL });
      sendResponse({ ok: true });
      return false;
    }

    // --- Wallet: Disconnect ---
    case 'scannr:disconnect-wallet': {
      clearWallet().then(() => sendResponse({ ok: true }));
      return true;
    }

    // --- Wallet: Get TRUST balance ---
    case 'scannr:get-wallet-balance': {
      getWalletAddress().then(async (address) => {
        if (!address) {
          sendResponse({ balance: null });
          return;
        }
        try {
          const { getWalletBalance } = await import('../services/intuition.js');
          const balance = await getWalletBalance(address);
          sendResponse({ balance });
        } catch (err) {
          sendResponse({ balance: null, error: err.message });
        }
      });
      return true;
    }

    // --- Attestation: Legacy handler (attestations now handled via Edge Function in submissions.js) ---
    case 'scannr:attestation-request': {
      logger.info('attestation-request received (now handled by Edge Function)');
      sendResponse({ ok: true, skipped: true });
      return false;
    }

    // --- Attestation: Complete (legacy — kept for backward compat) ---
    case 'scannr:attestation-complete': {
      logger.info('attestation-complete received:', message.payload);
      sendResponse({ ok: true });
      return false;
    }

    // --- Ethos handle lookup (account-level fallback) ---
    case 'scannr:query-ethos-handle': {
      const handle = (message.payload?.handle || '').replace(/^@/, '');
      if (!handle || handle === 'unknown') {
        sendResponse({ score: null, level: null, found: false });
        return false;
      }

      // Check 30-min cache
      const cacheKey = `ethos_handle_${handle.toLowerCase()}`;
      chrome.storage.local.get(cacheKey).then(async (stored) => {
        const cached = stored[cacheKey];
        if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
          sendResponse(cached.data);
          return;
        }

        try {
          const url = `${CONFIG.ETHOS_API_BASE_URL}/api/v2/score/userkey?userkey=service:x.com:username:${encodeURIComponent(handle.toLowerCase())}`;
          const resp = await fetch(url, {
            headers: {
              'Content-Type': 'application/json',
              'X-Ethos-Client': CONFIG.ETHOS_CLIENT_ID,
            },
          });

          if (resp.status === 404) {
            const result = { score: null, level: null, found: false };
            chrome.storage.local.set({ [cacheKey]: { data: result, ts: Date.now() } });
            sendResponse(result);
            return;
          }

          if (!resp.ok) {
            sendResponse({ score: null, level: null, found: false, error: `Ethos ${resp.status}` });
            return;
          }

          const data = await resp.json();
          const result = {
            score: typeof data.score === 'number' ? data.score : null,
            level: typeof data.level === 'string' ? data.level : null,
            found: true,
          };
          chrome.storage.local.set({ [cacheKey]: { data: result, ts: Date.now() } });
          sendResponse(result);
        } catch (err) {
          logger.warn('Ethos handle lookup failed:', err);
          sendResponse({ score: null, level: null, found: false, error: err.message });
        }
      });
      return true;
    }

    default:
      return false;
  }
});

// -------------------------------------------------------------------------
// External Messages (from hosted Privy auth page)
// -------------------------------------------------------------------------

const ALLOWED_ORIGIN = ENV.PRIVY_AUTH_URL.replace(/\/+$/, '');

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // Validate sender origin
  if (!sender.origin || !sender.origin.startsWith(ALLOWED_ORIGIN)) {
    return;
  }

  if (message.type === 'wallet-connected') {
    const { address, privyUserId } = message;
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      sendResponse({ success: false, error: 'Invalid address' });
      return;
    }

    logger.info(`Wallet connected from hosted page: ${address}`);

    setWalletAddress(address).then(async () => {
      // Persist to users table + trigger pre-funding
      try {
        const { getSupabase } = await import('../api/supabase.js');
        const supabase = getSupabase();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          await supabase
            .from('users')
            .update({ wallet_address: address })
            .eq('id', user.id);

          // Check if user needs pre-funding
          const { data: profile } = await supabase
            .from('users')
            .select('is_funded')
            .eq('id', user.id)
            .single();

          if (profile && !profile.is_funded && ENV.PREFUND_FUNCTION_URL) {
            const { data: { session: sbSession } } = await supabase.auth.getSession();
            if (sbSession?.access_token) {
              fetch(ENV.PREFUND_FUNCTION_URL, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'apikey': ENV.SUPABASE_ANON_KEY,
                  'Authorization': `Bearer ${sbSession.access_token}`,
                },
                body: JSON.stringify({ wallet_address: address }),
              }).then(async (res) => {
                if (!res.ok) {
                  const body = await res.json().catch(() => ({}));
                  if (body.reason === 'treasury_depleted') {
                    await chrome.storage.local.set({ scannr_prefund_status: 'treasury_depleted' });
                  }
                  logger.warn('Prefund failed:', body.error || res.status);
                } else {
                  await chrome.storage.local.set({ scannr_prefund_status: 'funded' });
                }
              }).catch(() => {});
            }
          }
        }
      } catch (err) {
        logger.warn('Failed to persist wallet address:', err);
      }

      sendResponse({ success: true });

      // Close the auth tab
      if (sender.tab?.id) {
        setTimeout(() => chrome.tabs.remove(sender.tab.id).catch(() => {}), 1500);
      }
    });

    return true; // async sendResponse
  }

  // Attestation complete from hosted page
  if (message.type === 'attestation-complete') {
    const { txHashes, error: txError } = message;
    if (txHashes && txHashes.length > 0) {
      import('../api/supabase.js').then(async ({ getSupabase }) => {
        try {
          const supabase = getSupabase();
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return;

          for (const hash of txHashes) {
            await supabase.from('user_actions').insert({
              user_id: user.id,
              action_type: 'attestation',
              tx_hash: hash,
              chain_id: ENV.INTUITION_CHAIN_ID,
            });
          }
        } catch (err) {
          logger.warn('Failed to record attestation:', err);
        }
      });
    }
    if (txError) {
      logger.warn('Attestation signing failed:', txError);
    }
    // Clean up pending txs
    chrome.storage.local.remove('scannr_pending_txs');
    sendResponse({ success: true });

    if (sender.tab?.id) {
      setTimeout(() => chrome.tabs.remove(sender.tab.id).catch(() => {}), 2000);
    }
    return true;
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
