/**
 * Scannr — Overlay (Shadow DOM UI Injection)
 *
 * Injects native-looking trust indicators into X (Twitter):
 *   - Compact trust pills (~28px) inline with tweet text
 *   - Floating detail card on hover/click (like X's profile hover cards)
 *   - Link verification data feeds into pill trust level & detail card
 *
 * Detail card lives inside closed Shadow DOM for style isolation.
 * Pills are injected directly into X's DOM for inline placement.
 */

import { CONFIG } from '../config/defaults.js';
import { logger } from '../utils/logger.js';
import { startScanner, stopScanner } from './scanner.js';
import { extractLinks } from '../engine/link-checker.js';

const P = CONFIG.CSS_PREFIX;

// -------------------------------------------------------------------------
// Shield SVG icon (14px inline, matches OKX's 20px avatar scale)
// -------------------------------------------------------------------------

const SHIELD_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle;flex-shrink:0;color:#E7E9EA;"><path d="M12 2L4 6v5c0 5.25 3.4 10.15 8 11.25C16.6 21.15 20 16.25 20 11V6l-8-4z" fill="currentColor" opacity="0.25"/><path d="M12 2L4 6v5c0 5.25 3.4 10.15 8 11.25C16.6 21.15 20 16.25 20 11V6l-8-4z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>`;

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

let shadowHost = null;
let shadowRoot = null;
let scannrEnabled = false;

const activePills = new Map();
const trustCache = new Map();
const linkResultsCache = new Map(); // tweetUrl → Array<{ url, result }>

// -------------------------------------------------------------------------
// Initialization
// -------------------------------------------------------------------------

(async function init() {
  try {
    const stored = await chrome.storage.local.get('scannr_enabled');
    scannrEnabled = stored.scannr_enabled === true;
  } catch {
    scannrEnabled = false;
  }

  if (scannrEnabled) {
    boot();
  } else {
    logger.info('Scannr is OFF — waiting for toggle');
  }

  listenForMessages();
})();

// -------------------------------------------------------------------------
// Boot / Shutdown
// -------------------------------------------------------------------------

function boot() {
  createShadowHost();
  startScanner();
  document.body.addEventListener('scannr:tweet-found', handleTweetFound);
  startPillRevalidation();
  logger.info('Overlay booted');
}

function startPillRevalidation() {
  setInterval(() => {
    for (const [url, pill] of activePills.entries()) {
      if (!pill.isConnected) {
        activePills.delete(url);
      }
    }
  }, CONFIG.VIEWPORT_SYNC_INTERVAL_MS);
}

function shutdown() {
  stopScanner();
  document.body.removeEventListener('scannr:tweet-found', handleTweetFound);

  closeDetailCard();

  if (shadowHost) {
    shadowHost.remove();
    shadowHost = null;
    shadowRoot = null;
  }

  for (const pill of activePills.values()) pill.remove();
  activePills.clear();
  trustCache.clear();

  linkResultsCache.clear();

  logger.info('Overlay shut down');
}

// -------------------------------------------------------------------------
// Shadow DOM Host (for detail card only)
// -------------------------------------------------------------------------

function createShadowHost() {
  if (shadowHost) return;

  shadowHost = document.createElement('div');
  shadowHost.id = `${P}-shadow-host`;
  shadowHost.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:99999;pointer-events:none;';
  document.body.appendChild(shadowHost);

  shadowRoot = shadowHost.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = getScannrStyles();
  shadowRoot.appendChild(style);
}

function getShadowContainer() {
  return shadowRoot;
}

// -------------------------------------------------------------------------
// Tweet Processing
// -------------------------------------------------------------------------

function handleTweetFound(event) {
  const { tweetUrl, hasExternalLink, element } = event.detail;

  // Only show trust pills on tweets that contain external links
  if (!hasExternalLink) return;

  // Run link verification FIRST (local registry, no network calls)
  const tweetText = element.querySelector(CONFIG.SELECTOR_TWEET_TEXT);
  let linkResults = [];
  if (tweetText) {
    linkResults = extractLinks(tweetText).map(({ url, result }) => ({ url, result }));
    linkResultsCache.set(tweetUrl, linkResults);
  }

  // Calculate trust from provider data (if cached) + link verification
  const providerData = trustCache.get(tweetUrl) || null;
  const trustResult = calculateTrustResult(providerData, linkResults);
  injectTrustPill(element, tweetUrl, trustResult);

  requestReputation(tweetUrl);
}

// -------------------------------------------------------------------------
// Single Source of Truth — Trust Calculation
// -------------------------------------------------------------------------

/**
 * Calculate final trust result from provider scores + link verification.
 * This is the ONLY function that determines trust level. Every UI element
 * (pill, score bar, hover card) reads from its output.
 *
 * Link verification is BINARY — not a score input:
 *   1. ANY flagged link → "Unsafe" (red). Flagged overrides everything.
 *   2. ANY verified link (and none flagged) → "Verified" (green). Done.
 *   3. Links exist but none in registry → fall through to providers.
 *   4. No links → use provider scores.
 *
 * Provider-based levels (only when no link verdict):
 *   70-100 → Trusted (green)
 *   40-69  → Caution (yellow)
 *   1-39   → Low Trust (red)
 *   0      → No Data (gray)
 */
function calculateTrustResult(providerData, linkResults) {
  const links = linkResults || [];
  const verifiedLinks = links.filter(l => l.result.status === 'verified');
  const flaggedLinks = links.filter(l => l.result.status === 'flagged');
  const breakdown = providerData?.breakdown || {};

  // --- PRIORITY 1: Any flagged link → Unsafe ---
  if (flaggedLinks.length > 0) {
    return {
      score: null, level: 'unsafe', label: 'Unsafe', color: '#F4212E',
      providerData: providerData || null, linkResults: links,
      breakdown, lastUpdated: providerData?.lastUpdated || null,
    };
  }

  // --- PRIORITY 2: Any verified link → Verified ---
  if (verifiedLinks.length > 0) {
    return {
      score: null, level: 'verified', label: 'Verified', color: '#00BA7C',
      providerData: providerData || null, linkResults: links,
      breakdown, lastUpdated: providerData?.lastUpdated || null,
    };
  }

  // --- PRIORITY 3: No link verdict → use provider scores ---
  const score = providerData?.confidence || 0;
  let level, label, color;

  if (score >= 70) {
    level = 'trusted'; label = 'Trusted'; color = '#00BA7C';
  } else if (score >= 40) {
    level = 'caution'; label = 'Caution'; color = '#FFD400';
  } else if (score > 0) {
    level = 'low-trust'; label = 'Low Trust'; color = '#F4212E';
  } else {
    level = 'no-data'; label = 'No Data'; color = '#71767B';
  }

  return {
    score, level, label, color,
    providerData: providerData || null, linkResults: links,
    breakdown, lastUpdated: providerData?.lastUpdated || null,
  };
}

// -------------------------------------------------------------------------
// OKX Coexistence — detect & position alongside other extension pills
// -------------------------------------------------------------------------

function findInjectionPoint(tweetEl) {
  // Primary: insert before [data-testid="tweetText"] — same parent as OKX pills
  const tweetText = tweetEl.querySelector(CONFIG.SELECTOR_TWEET_TEXT);
  if (tweetText && tweetText.parentElement) {
    return { target: tweetText, position: 'beforeElement' };
  }

  // Fallback: insert before the first child of the tweet article
  return { target: tweetEl, position: 'prepend' };
}

// -------------------------------------------------------------------------
// Trust Pill — compact inline indicator (~28px, matches OKX pill sizing)
// -------------------------------------------------------------------------

function injectTrustPill(tweetEl, tweetUrl, trustResult) {
  if (activePills.has(tweetUrl)) {
    updatePill(tweetUrl, trustResult);
    return;
  }

  const { label, color } = trustResult;

  const { target, position } = findInjectionPoint(tweetEl);

  const pill = document.createElement('span');
  pill.className = `${P}-pill`;
  pill.setAttribute('role', 'button');
  pill.setAttribute('tabindex', '0');
  pill.setAttribute('aria-label', `Scannr: ${label}`);
  pill.dataset.scannrUrl = tweetUrl;

  pill.innerHTML = `${SHIELD_SVG} <span style="color:#E7E9EA;font-weight:500;">Trust:</span> <span style="color:${color};font-weight:600;">${label}</span>`;
  pill.style.cssText = `
    display:inline-flex;align-items:center;gap:4px;
    width:fit-content;max-width:fit-content;align-self:flex-start;
    height:28px;padding:4px 10px;border-radius:9999px;
    margin:4px 0 4px 0;
    font-size:13px;cursor:pointer;
    background:#202327;border:1px solid rgba(255,255,255,0.08);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    white-space:nowrap;user-select:none;line-height:1;
    transition:opacity 0.15s ease;
    box-sizing:border-box;
  `;

  // Hover: show detail card
  let hoverTimer = null;
  pill.addEventListener('mouseenter', () => {
    pill.style.opacity = '0.85';
    hoverTimer = setTimeout(() => {
      openDetailCard(tweetUrl, trustResult, pill);
    }, 300);
  });
  pill.addEventListener('mouseleave', () => {
    pill.style.opacity = '1';
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  });

  // Click: immediate detail card
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    openDetailCard(tweetUrl, trustResult, pill);
  });

  pill.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation();
      e.preventDefault();
      openDetailCard(tweetUrl, trustResult, pill);
    }
  });

  if (position === 'beforeElement') {
    // Insert as a sibling right before target element (same parent as tweetText/OKX)
    target.parentElement.insertBefore(pill, target);
  } else if (position === 'afterElement') {
    target.parentElement.insertBefore(pill, target.nextSibling);
  } else if (position === 'append') {
    target.appendChild(pill);
  } else if (position === 'prepend') {
    target.prepend(pill);
  } else {
    target.appendChild(pill);
  }

  activePills.set(tweetUrl, pill);
}

function updatePill(tweetUrl, trustResult) {
  const pill = activePills.get(tweetUrl);
  if (!pill) return;

  const { label, color } = trustResult;
  pill.innerHTML = `${SHIELD_SVG} <span style="color:#E7E9EA;font-weight:500;">Trust:</span> <span style="color:${color};font-weight:600;">${label}</span>`;
  pill.setAttribute('aria-label', `Scannr: ${label}`);
}

// -------------------------------------------------------------------------
// Detail Card — floating dropdown on hover/click (X-style hover card)
// -------------------------------------------------------------------------

let activeDetailCard = null;
let cardHideTimer = null;

function openDetailCard(tweetUrl, trustResult, anchorEl) {
  // If already showing for this URL, don't re-open
  if (activeDetailCard && activeDetailCard.tweetUrl === tweetUrl) return;

  closeDetailCard();

  const container = getShadowContainer();
  if (!container) return;

  // Everything reads from the single computed trustResult
  const { score, level, label, color: scoreColor, breakdown, linkResults: cardLinks, lastUpdated } = trustResult;
  const isLinkBased = level === 'verified' || level === 'unsafe';

  // Wrapper (for mouse-enter/leave tracking on the card itself)
  const wrapper = document.createElement('div');
  wrapper.className = `${P}-card-wrapper`;

  // Card — force dark background with inline style as fallback
  const card = document.createElement('div');
  card.className = `${P}-detail-card`;
  card.style.background = '#1D1F23';
  card.style.color = '#E7E9EA';
  card.addEventListener('click', (e) => e.stopPropagation());

  // -- Header --
  const titleDiv = document.createElement('div');
  titleDiv.className = `${P}-card-title`;
  titleDiv.textContent = isLinkBased ? 'Scannr Link Check' : 'Scannr Trust Score';
  card.appendChild(titleDiv);

  // -- Score bar + number --
  const scoreRow = document.createElement('div');
  scoreRow.className = `${P}-card-score-row`;

  const scoreBar = document.createElement('div');
  scoreBar.className = `${P}-card-score-bar`;
  const scoreFill = document.createElement('div');
  scoreFill.className = `${P}-card-score-fill`;

  if (isLinkBased) {
    // Full bar, no numeric score for link-based verdicts
    scoreFill.style.width = '100%';
    scoreFill.style.background = scoreColor;
  } else {
    scoreFill.style.width = `${Math.round(score || 0)}%`;
    scoreFill.style.background = scoreColor;
  }
  scoreBar.appendChild(scoreFill);

  const scoreNum = document.createElement('span');
  scoreNum.className = `${P}-card-score-num`;
  scoreNum.style.color = scoreColor;

  if (isLinkBased) {
    scoreNum.textContent = label;
  } else {
    scoreNum.textContent = `${Math.round(score || 0)}/100`;
    scoreNum.style.color = '#E7E9EA';
  }

  scoreRow.appendChild(scoreBar);
  scoreRow.appendChild(scoreNum);
  card.appendChild(scoreRow);

  // -- Provider rows --
  const providers = [
    { name: 'Ethos', key: 'ethos', desc: 'vouches' },
    { name: 'Community', key: 'community', desc: 'flags & vouches' },
    { name: 'Prints', key: 'prints', desc: 'Awaiting API' },
  ];

  for (const prov of providers) {
    const provRow = document.createElement('div');
    provRow.className = `${P}-card-provider`;

    const provData = breakdown[prov.key];
    const isActive = provData && provData.available !== false;
    const isPrints = prov.key === 'prints';

    const dot = document.createElement('span');
    dot.className = `${P}-card-dot`;
    dot.style.color = (isPrints || !isActive) ? '#71767B' : '#00BA7C';
    dot.textContent = (isPrints || !isActive) ? '\u25CB' : '\u25CF';

    const provLabel = document.createElement('span');
    provLabel.className = `${P}-card-prov-name`;
    provLabel.textContent = prov.name;

    const provInfo = document.createElement('span');
    provInfo.className = `${P}-card-prov-info`;
    if (isPrints) {
      provInfo.textContent = 'Awaiting API';
    } else if (isActive && provData.count !== undefined) {
      provInfo.textContent = `${provData.count} ${prov.desc}`;
    } else if (isActive && provData.score !== undefined) {
      provInfo.textContent = `Score: ${provData.score}`;
    } else {
      provInfo.textContent = isActive ? 'Connected' : 'No data';
    }

    provRow.appendChild(dot);
    provRow.appendChild(provLabel);
    provRow.appendChild(provInfo);
    card.appendChild(provRow);
  }

  // -- Links section (from local registry verification) --
  if (cardLinks && cardLinks.length > 0) {
    const linkDivider = document.createElement('div');
    linkDivider.className = `${P}-card-divider`;
    card.appendChild(linkDivider);

    const linksTitle = document.createElement('div');
    linksTitle.className = `${P}-card-links-title`;
    linksTitle.textContent = 'Links';
    card.appendChild(linksTitle);

    for (const { url, result } of cardLinks) {
      const linkRow = document.createElement('div');
      linkRow.className = `${P}-card-link-row`;

      const linkDomain = document.createElement('span');
      linkDomain.className = `${P}-card-link-domain`;
      linkDomain.textContent = url;

      const linkStatus = document.createElement('span');
      linkStatus.className = `${P}-card-link-status`;

      if (result.status === 'verified') {
        linkStatus.innerHTML = `<span style="color:#00BA7C;">\u2713 Verified</span> <span style="color:#71767B;">\u00B7 ${escapeHtml(result.source)}</span>`;
      } else if (result.status === 'flagged') {
        linkStatus.innerHTML = `<span style="color:#F4212E;">\u26A0 ${escapeHtml(result.reason)}</span> <span style="color:#71767B;">\u00B7 ${escapeHtml(result.source)}</span>`;
      } else {
        linkStatus.innerHTML = `<span style="color:#71767B;">Unknown</span>`;
      }

      linkRow.appendChild(linkDomain);
      linkRow.appendChild(linkStatus);
      card.appendChild(linkRow);
    }
  }

  // -- Timestamp --
  const tsDiv = document.createElement('div');
  tsDiv.className = `${P}-card-timestamp`;
  if (lastUpdated) {
    tsDiv.textContent = `Last checked: ${timeAgo(lastUpdated)}`;
  } else {
    tsDiv.textContent = 'Last checked: just now';
  }
  card.appendChild(tsDiv);

  // -- Divider --
  const divider = document.createElement('div');
  divider.className = `${P}-card-divider`;
  card.appendChild(divider);

  // -- Disclaimer --
  const disclaimer = document.createElement('div');
  disclaimer.className = `${P}-card-disclaimer`;
  disclaimer.textContent = 'Trust scores are informational only. Not financial advice.';
  card.appendChild(disclaimer);

  // -- Flag / Vouch buttons (only for signed-in users) --
  const actionsRow = document.createElement('div');
  actionsRow.className = `${P}-card-actions`;

  // Check auth state and render buttons or sign-in prompt
  chrome.runtime.sendMessage({ type: 'scannr:get-user' }, (result) => {
    if (result?.user) {
      const flagBtn = document.createElement('button');
      flagBtn.className = `${P}-card-btn ${P}-card-btn--flag`;
      flagBtn.textContent = 'Flag';
      flagBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleSubmission('flag', tweetUrl, flagBtn, vouchBtn);
      });

      const vouchBtn = document.createElement('button');
      vouchBtn.className = `${P}-card-btn ${P}-card-btn--vouch`;
      vouchBtn.textContent = 'Vouch';
      vouchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleSubmission('vouch', tweetUrl, vouchBtn, flagBtn);
      });

      actionsRow.appendChild(flagBtn);
      actionsRow.appendChild(vouchBtn);
    } else {
      const signInHint = document.createElement('span');
      signInHint.className = `${P}-card-signin-hint`;
      signInHint.textContent = 'Sign in to flag or vouch';
      actionsRow.appendChild(signInHint);
    }
  });

  card.appendChild(actionsRow);

  wrapper.appendChild(card);
  container.appendChild(wrapper);

  // Position relative to anchor pill
  positionCard(card, anchorEl);

  // -- Dismiss logic --
  // Mouse-out: dismiss after delay (desktop hover card behavior)
  const startHideTimer = () => {
    if (cardHideTimer) clearTimeout(cardHideTimer);
    cardHideTimer = setTimeout(() => closeDetailCard(), 300);
  };
  const cancelHideTimer = () => {
    if (cardHideTimer) { clearTimeout(cardHideTimer); cardHideTimer = null; }
  };

  // Card stays open while mouse is over it
  wrapper.addEventListener('mouseenter', cancelHideTimer);
  wrapper.addEventListener('mouseleave', startHideTimer);

  // Also keep open while mouse is over the pill
  anchorEl.addEventListener('mouseenter', cancelHideTimer);
  anchorEl.addEventListener('mouseleave', startHideTimer);

  // Click outside (on the page)
  const clickOutside = (e) => {
    if (!wrapper.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
      closeDetailCard();
    }
  };
  setTimeout(() => document.addEventListener('click', clickOutside, { capture: true }), 0);

  // Escape
  const escHandler = (e) => {
    if (e.key === 'Escape') closeDetailCard();
  };
  document.addEventListener('keydown', escHandler);

  // Scroll dismiss
  const scrollHandler = () => closeDetailCard();
  window.addEventListener('scroll', scrollHandler, { once: true, passive: true });

  activeDetailCard = {
    tweetUrl,
    wrapper,
    anchorEl,
    cleanup: () => {
      cancelHideTimer();
      document.removeEventListener('click', clickOutside, { capture: true });
      document.removeEventListener('keydown', escHandler);
      window.removeEventListener('scroll', scrollHandler);
      // Remove listeners from pill
      anchorEl.removeEventListener('mouseenter', cancelHideTimer);
      anchorEl.removeEventListener('mouseleave', startHideTimer);
    },
  };
}

function closeDetailCard() {
  if (activeDetailCard) {
    activeDetailCard.cleanup();
    activeDetailCard.wrapper.remove();
    activeDetailCard = null;
  }
  if (cardHideTimer) { clearTimeout(cardHideTimer); cardHideTimer = null; }
}

function positionCard(card, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const cardWidth = 300;
  const margin = 8;

  let top = rect.bottom + margin;
  let left = rect.left;

  // Keep within viewport horizontally
  if (left + cardWidth > window.innerWidth) {
    left = window.innerWidth - cardWidth - margin;
  }
  if (left < margin) left = margin;

  // If not enough space below, show above
  if (top + 320 > window.innerHeight) {
    top = rect.top - margin;
    card.style.transform = 'translateY(-100%)';
  }

  card.style.top = `${top}px`;
  card.style.left = `${left}px`;
}

// -------------------------------------------------------------------------
// HTML escaping for registry strings in detail card
// -------------------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// -------------------------------------------------------------------------
// Submission Handler (Flag / Vouch)
// -------------------------------------------------------------------------

async function handleSubmission(type, tweetUrl, activeBtn, otherBtn) {
  activeBtn.disabled = true;
  otherBtn.disabled = true;
  activeBtn.textContent = type === 'flag' ? 'Flagging...' : 'Vouching...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'scannr:submit-report',
      payload: { reportType: type, targetUrl: tweetUrl },
    });

    if (response?.error) {
      if (response.error === 'Not signed in') {
        activeBtn.textContent = 'Sign in first';
      } else {
        activeBtn.textContent = 'Error';
      }
      setTimeout(() => {
        activeBtn.textContent = type === 'flag' ? 'Flag' : 'Vouch';
        activeBtn.disabled = false;
        otherBtn.disabled = false;
      }, 2000);
      return;
    }

    activeBtn.textContent = type === 'flag' ? 'Flagged' : 'Vouched';
    activeBtn.classList.add(`${P}-card-btn--done`);
  } catch {
    activeBtn.textContent = type === 'flag' ? 'Flag' : 'Vouch';
    activeBtn.disabled = false;
    otherBtn.disabled = false;
  }
}

// -------------------------------------------------------------------------
// Background Messages
// -------------------------------------------------------------------------

function listenForMessages() {
  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'scannr:trust-update') {
        const updates = message.payload?.updates || [];
        for (const update of (Array.isArray(updates) ? updates : Object.values(updates))) {
          if (update.tweetUrl) {
            trustCache.set(update.tweetUrl, update);
            updatePillsForUrl(update.tweetUrl, update);
          }
        }
      }

      if (message.type === 'scannr:toggle') {
        const nowEnabled = message.payload?.enabled === true;
        if (nowEnabled && !scannrEnabled) {
          scannrEnabled = true;
          boot();
        } else if (!nowEnabled && scannrEnabled) {
          scannrEnabled = false;
          shutdown();
        }
      }

      return undefined;
    });
  } catch (err) {
    logger.warn('Failed to set up message listener:', err);
  }
}

function updatePillsForUrl(tweetUrl, providerData) {
  const linkResults = linkResultsCache.get(tweetUrl) || [];
  const trustResult = calculateTrustResult(providerData, linkResults);

  const tweets = document.querySelectorAll(CONFIG.SELECTOR_TWEET);
  for (const tweet of tweets) {
    const link = tweet.querySelector('a[href*="/status/"]');
    if (!link) continue;
    const href = link.getAttribute('href');
    if (href && `https://x.com${href}` === tweetUrl) {
      injectTrustPill(tweet, tweetUrl, trustResult);
      break;
    }
  }
}

// -------------------------------------------------------------------------
// Reputation Request
// -------------------------------------------------------------------------

async function requestReputation(tweetUrl) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'scannr:query',
      payload: { identifier: tweetUrl, type: 'link' },
    });

    if (response?.result) {
      trustCache.set(tweetUrl, response.result);
      updatePillsForUrl(tweetUrl, response.result);
    }
  } catch {
    // Background may not be ready
  }
}

// -------------------------------------------------------------------------
// Utilities
// -------------------------------------------------------------------------

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// -------------------------------------------------------------------------
// Styles — detail card inside Shadow DOM
// -------------------------------------------------------------------------

function getScannrStyles() {
  return `
/* Force dark color scheme for entire shadow DOM */
:host {
  color-scheme: dark;
}

/* Card wrapper — receives mouse events */
.${P}-card-wrapper {
  position: fixed; inset: 0;
  z-index: 100000; pointer-events: none;
}

/* Detail card — X-style hover card */
.${P}-detail-card {
  position: fixed;
  width: 300px;
  background: #1D1F23;
  color-scheme: dark;
  border: 1px solid rgb(47, 51, 54);
  border-radius: 16px;
  padding: 16px;
  color: #E7E9EA;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
  animation: ${P}-card-in 0.15s ease;
  z-index: 100001;
}

@keyframes ${P}-card-in {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}

/* Title */
.${P}-card-title {
  font-size: 15px; font-weight: 700; margin-bottom: 10px;
  color: #E7E9EA;
}

/* Score row */
.${P}-card-score-row {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 14px;
}

.${P}-card-score-bar {
  flex: 1; height: 4px; border-radius: 2px;
  background: rgba(255,255,255,0.1); overflow: hidden;
}

.${P}-card-score-fill {
  height: 100%; border-radius: 2px;
  transition: width 0.3s ease;
}

.${P}-card-score-num {
  font-size: 14px; font-weight: 700; color: #E7E9EA;
  white-space: nowrap;
}

/* Provider rows */
.${P}-card-provider {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 0; font-size: 13px;
}

.${P}-card-dot { font-size: 10px; width: 14px; text-align: center; }
.${P}-card-prov-name { font-weight: 600; color: #E7E9EA; min-width: 65px; }
.${P}-card-prov-info { color: #71767B; }

/* Links section */
.${P}-card-links-title {
  font-size: 13px; font-weight: 600; color: #E7E9EA;
  margin-bottom: 6px;
}

.${P}-card-link-row {
  display: flex; align-items: baseline; gap: 8px;
  padding: 3px 0; font-size: 12px;
  flex-wrap: wrap;
}

.${P}-card-link-domain {
  color: #1D9BF0; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis;
  max-width: 120px; white-space: nowrap;
}

.${P}-card-link-status {
  color: #71767B; white-space: nowrap;
}

/* Timestamp */
.${P}-card-timestamp {
  font-size: 12px; color: #71767B;
  margin-top: 10px; margin-bottom: 6px;
}

/* Divider */
.${P}-card-divider {
  height: 1px; background: rgb(47, 51, 54);
  margin: 8px 0;
}

/* Disclaimer */
.${P}-card-disclaimer {
  font-size: 12px; color: #71767B;
  margin-bottom: 6px; line-height: 1.4;
}

/* Action buttons (Flag / Vouch) */
.${P}-card-actions {
  display: flex; gap: 8px; margin-top: 8px;
}

.${P}-card-btn {
  flex: 1; padding: 6px 0; border: none; border-radius: 8px;
  font-size: 13px; font-weight: 600; cursor: pointer;
  transition: opacity 0.15s;
  font-family: inherit;
}

.${P}-card-btn:hover { opacity: 0.85; }
.${P}-card-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.${P}-card-btn--flag {
  background: rgba(244, 33, 46, 0.15); color: #F4212E;
}

.${P}-card-btn--vouch {
  background: rgba(0, 186, 124, 0.15); color: #00BA7C;
}

.${P}-card-btn--done {
  opacity: 0.6; cursor: default;
}

.${P}-card-signin-hint {
  color: #71767B; font-size: 12px; text-align: center; width: 100%;
}
  `;
}
