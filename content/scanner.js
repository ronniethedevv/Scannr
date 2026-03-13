/**
 * Scannr — Feed Scanner
 *
 * MutationObserver-based DOM scanner for X (Twitter). Watches the feed
 * for new tweets, extracts account handles and links, and triggers
 * reputation lookups via the background service worker.
 *
 * This file handles DETECTION only — all UI injection lives in overlay.js.
 */

import { CONFIG } from '../config/defaults.js';
import { logger } from '../utils/logger.js';

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

/** WeakSet of tweet elements already processed (prevents double-injection) */
const processedTweets = new WeakSet();

/** Set of tweet URLs currently visible in the viewport */
const visibleTweetUrls = new Set();

/** Whether Scannr is currently active */
let isActive = false;

/** MutationObserver instance */
let observer = null;

/** Debounce timer for mutation batching */
let debounceTimer = null;

/** Fallback interval that keeps scanning until tweets are found */
let fallbackScanTimer = null;

// -------------------------------------------------------------------------
// Public API (called by overlay.js and background messages)
// -------------------------------------------------------------------------

/**
 * Start scanning the feed for tweets.
 * Called when Scannr is enabled (user toggle).
 */
export function startScanner() {
  if (isActive) return;
  isActive = true;

  // Watch for new tweets added to the DOM (start BEFORE processing existing)
  startMutationObserver();

  // Process tweets already on the page
  processExistingTweets();

  // X is an SPA — tweets may not be rendered yet at document_idle.
  // Retry a few times with increasing delays to catch late-rendering tweets.
  scheduleRetries();

  // Fallback: keep scanning every 5s until at least one tweet is found.
  // This catches cases where the MutationObserver and retries both miss.
  startFallbackScan();

  // Periodically sync visible URLs with background for polling
  startViewportSync();

  logger.info('Scanner started');
}

/**
 * Stop scanning and clean up.
 * Called when Scannr is disabled.
 */
export function stopScanner() {
  isActive = false;

  if (observer) {
    observer.disconnect();
    observer = null;
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  if (fallbackScanTimer) {
    clearInterval(fallbackScanTimer);
    fallbackScanTimer = null;
  }

  visibleTweetUrls.clear();
  logger.info('Scanner stopped');
}

/**
 * Check if a tweet element has already been processed.
 */
export function isProcessed(tweetEl) {
  return processedTweets.has(tweetEl);
}

/**
 * Mark a tweet element as processed.
 */
export function markProcessed(tweetEl) {
  processedTweets.add(tweetEl);
}

/**
 * Get the set of currently visible tweet URLs.
 */
export function getVisibleUrls() {
  return visibleTweetUrls;
}

/**
 * Whether the scanner is currently active.
 */
export function isScannerActive() {
  return isActive;
}

// -------------------------------------------------------------------------
// SPA Retry — X renders tweets asynchronously after page load
// -------------------------------------------------------------------------

function scheduleRetries() {
  const delays = [500, 1500, 3000, 6000, 10000, 15000, 20000, 30000, 45000, 60000];
  for (const delay of delays) {
    setTimeout(() => {
      if (!isActive) return;
      if (visibleTweetUrls.size > 0) return; // Already found tweets, no need to retry
      logger.info(`[Scanner] Retry scan after ${delay}ms...`);
      processExistingTweets();
    }, delay);
  }
}

// -------------------------------------------------------------------------
// Fallback Scan — persistent interval until tweets are found
// -------------------------------------------------------------------------

function startFallbackScan() {
  if (fallbackScanTimer) clearInterval(fallbackScanTimer);

  fallbackScanTimer = setInterval(() => {
    if (!isActive) return;
    if (visibleTweetUrls.size > 0) {
      // Tweets found — stop the fallback scan
      clearInterval(fallbackScanTimer);
      fallbackScanTimer = null;
      return;
    }
    logger.info('[Scanner] Fallback scan tick...');
    processExistingTweets();
  }, 5000);
}

// -------------------------------------------------------------------------
// Tweet Processing
// -------------------------------------------------------------------------

/**
 * Process all tweets currently in the DOM.
 * Uses a multi-strategy approach since X frequently changes their markup.
 */
function processExistingTweets() {
  let tweets;

  // Strategy 1: data-testid="tweet" (classic, may be removed)
  tweets = document.querySelectorAll(CONFIG.SELECTOR_TWEET);
  if (tweets.length > 0) {
    logger.info(`[Scanner] Found ${tweets.length} tweets via primary selector`);
    for (const tweet of tweets) processTweet(tweet);
    return;
  }

  // Strategy 2: configured fallback selectors
  for (const fallback of CONFIG.SELECTOR_TWEET_FALLBACKS || []) {
    tweets = document.querySelectorAll(fallback);
    if (tweets.length > 0) {
      logger.info(`[Scanner] Found ${tweets.length} tweets via fallback "${fallback}"`);
      for (const tweet of tweets) processTweet(tweet);
      return;
    }
  }

  // Strategy 3: structural detection — find article elements containing /status/ links
  // This is the most resilient approach: tweets always contain a permalink to /user/status/ID
  const articles = document.querySelectorAll('article');
  if (articles.length > 0) {
    let count = 0;
    for (const article of articles) {
      if (article.querySelector('a[href*="/status/"]')) {
        processTweet(article);
        count++;
      }
    }
    if (count > 0) {
      logger.info(`[Scanner] Found ${count} tweets via structural detection (article + status link)`);
      return;
    }
  }

  // Strategy 4: broadest — any container with a /status/ link, walk up to find the tweet boundary
  const statusLinks = document.querySelectorAll('a[href*="/status/"]');
  if (statusLinks.length > 0) {
    const tweetContainers = new Set();
    for (const link of statusLinks) {
      const href = link.getAttribute('href');
      if (!href || !/^\/\w+\/status\/\d+/.test(href)) continue;
      // Walk up to find the nearest cellInnerDiv or a reasonable container
      const container = findTweetContainer(link);
      if (container && !tweetContainers.has(container)) {
        tweetContainers.add(container);
        processTweet(container);
      }
    }
    if (tweetContainers.size > 0) {
      logger.info(`[Scanner] Found ${tweetContainers.size} tweets via link-walk detection`);
      return;
    }
  }

  // Nothing found — log diagnostics
  const allTestIds = new Set();
  document.querySelectorAll('[data-testid]').forEach(el => allTestIds.add(el.getAttribute('data-testid')));
  const articleCount = document.querySelectorAll('article').length;
  const statusLinkCount = document.querySelectorAll('a[href*="/status/"]').length;
  logger.warn(`[Scanner] No tweets found. articles: ${articleCount}, status links: ${statusLinkCount}, testIds: ${allTestIds.size > 0 ? Array.from(allTestIds).join(', ') : 'none'}`);
}

/**
 * Walk up from a /status/ link to find the tweet's container element.
 * Looks for cellInnerDiv, article, or a div with specific structural cues.
 */
function findTweetContainer(element) {
  let current = element.parentElement;
  let depth = 0;
  while (current && depth < 15) {
    // Prefer data-testid="cellInnerDiv" if it exists
    if (current.getAttribute?.('data-testid') === 'cellInnerDiv') return current;
    // Prefer article elements
    if (current.tagName === 'ARTICLE') return current;
    current = current.parentElement;
    depth++;
  }
  // Fallback: walk up ~8 levels from the link (typical tweet nesting depth)
  current = element;
  for (let i = 0; i < 8 && current.parentElement; i++) {
    current = current.parentElement;
  }
  return current;
}

/**
 * Process a single tweet element.
 * Extracts URL, author handle, and link presence.
 * Dispatches a custom event for overlay.js to handle UI injection.
 */
function processTweet(tweetEl) {
  if (processedTweets.has(tweetEl)) return;
  processedTweets.add(tweetEl);

  const tweetUrl = extractTweetUrl(tweetEl);
  if (!tweetUrl) return;

  const authorHandle = extractAuthorHandle(tweetEl);
  const hasExternalLink = tweetContainsLink(tweetEl);

  // Track as visible
  visibleTweetUrls.add(tweetUrl);

  // Dispatch event for overlay.js to inject UI (bubbles to document.body)
  tweetEl.dispatchEvent(
    new CustomEvent('scannr:tweet-found', {
      bubbles: true,
      detail: { tweetUrl, authorHandle, hasExternalLink, element: tweetEl },
    })
  );
}

// -------------------------------------------------------------------------
// DOM Extraction
// -------------------------------------------------------------------------

/**
 * Extract the canonical tweet URL from a tweet element.
 * Looks for the permalink <a> with href like /username/status/123.
 */
export function extractTweetUrl(tweetEl) {
  const links = tweetEl.querySelectorAll('a[href*="/status/"]');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (href && /^\/\w+\/status\/\d+/.test(href)) {
      return `https://x.com${href}`;
    }
  }
  return null;
}

/**
 * Extract the tweet author's X handle.
 * Looks for the first <a href="/username"> link within the tweet header.
 */
export function extractAuthorHandle(tweetEl) {
  const userLinks = tweetEl.querySelectorAll('a[href^="/"]');
  for (const link of userLinks) {
    const href = link.getAttribute('href');
    if (href && /^\/\w+$/.test(href) && !href.includes('/status/')) {
      return href.replace('/', '@');
    }
  }
  return 'unknown';
}

/**
 * Check whether a tweet contains an external link (t.co shortened URL).
 * X wraps all external URLs in t.co redirects.
 */
export function tweetContainsLink(tweetEl) {
  const tweetTextEl = tweetEl.querySelector(CONFIG.SELECTOR_TWEET_TEXT);
  if (!tweetTextEl) return false;

  const links = tweetTextEl.querySelectorAll('a[href]');
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    if (href.includes('t.co/') || href.startsWith('http')) {
      return true;
    }
  }

  // Also check for card links (embedded URL previews)
  const cardLink = tweetEl.querySelector('[data-testid="card.wrapper"] a[href]');
  return !!cardLink;
}

// -------------------------------------------------------------------------
// Mutation Observer
// -------------------------------------------------------------------------

/** Pending nodes collected between debounce ticks */
let pendingNodes = [];

function startMutationObserver() {
  if (observer) observer.disconnect();
  pendingNodes = [];

  observer = new MutationObserver((mutations) => {
    if (!isActive) return;

    // Collect added element nodes synchronously (mutations is only valid now)
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          pendingNodes.push(node);
        }
      }
    }

    // Debounce: process collected nodes after rapid DOM changes settle
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const nodes = pendingNodes;
      pendingNodes = [];

      let found = 0;
      const selectors = [CONFIG.SELECTOR_TWEET, ...(CONFIG.SELECTOR_TWEET_FALLBACKS || [])];

      for (const node of nodes) {
        // Strategy A: selector-based matching
        for (const selector of selectors) {
          if (node.matches?.(selector)) {
            processTweet(node);
            found++;
          }
          const nested = node.querySelectorAll?.(selector);
          if (nested) {
            for (const tweet of nested) {
              processTweet(tweet);
              found++;
            }
          }
        }

        // Strategy B: structural detection (articles with /status/ links)
        if (node.tagName === 'ARTICLE' && node.querySelector('a[href*="/status/"]')) {
          processTweet(node);
          found++;
        }
        const articles = node.querySelectorAll?.('article');
        if (articles) {
          for (const article of articles) {
            if (article.querySelector('a[href*="/status/"]')) {
              processTweet(article);
              found++;
            }
          }
        }
      }
      if (found > 0) {
        logger.info(`[Scanner] Mutation observer found ${found} new tweets`);
      }
    }, CONFIG.MUTATION_DEBOUNCE_MS);
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// -------------------------------------------------------------------------
// Viewport Sync — report visible URLs to background for polling
// -------------------------------------------------------------------------

function startViewportSync() {
  setInterval(() => {
    if (!isActive || visibleTweetUrls.size === 0) return;

    try {
      chrome.runtime.sendMessage({
        type: 'scannr:report-visible-urls',
        payload: { urls: Array.from(visibleTweetUrls) },
      }).catch(() => {});
    } catch {
      // Extension context may be invalidated
    }
  }, CONFIG.VIEWPORT_SYNC_INTERVAL_MS);
}
