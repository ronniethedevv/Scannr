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
// Diamond SVG icon — Scannr brand mark (always purple)
// -------------------------------------------------------------------------

const DIAMOND_SVG = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;flex-shrink:0;"><path d="M6 0L12 6L6 12L0 6Z" fill="#8B5CF6"/></svg>`;

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

let shadowHost = null;
let shadowRoot = null;
let scannrEnabled = false;

const activePills = new Map();
const trustCache = new Map();
const linkResultsCache = new Map(); // tweetUrl → Array<{ url, result }>
const latestTrustResults = new Map(); // tweetUrl → latest trustResult (avoids stale closures)
const authorHandleCache = new Map(); // tweetUrl → "@handle"
const ethosHandleCache = new Map(); // handle → { score, level, found, ts }

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
        latestTrustResults.delete(url);
        authorHandleCache.delete(url);
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
  latestTrustResults.clear();
  authorHandleCache.clear();
  ethosHandleCache.clear();

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
  const { tweetUrl, authorHandle, hasExternalLink, element } = event.detail;

  // Store author handle for account-level fallback
  if (authorHandle && authorHandle !== 'unknown') {
    authorHandleCache.set(tweetUrl, authorHandle);
  }

  // Run link verification (local registry, no network calls)
  let linkResults = [];
  if (hasExternalLink) {
    const tweetText = element.querySelector(CONFIG.SELECTOR_TWEET_TEXT);
    if (tweetText) {
      linkResults = extractLinks(tweetText).map(({ url, result }) => ({ url, result }));
      linkResultsCache.set(tweetUrl, linkResults);
    }
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

  logger.info(`[TrustResult] Input: providerData=${providerData ? JSON.stringify({ confidence: providerData.confidence, breakdown: providerData.breakdown }) : 'null'}, links=${links.length} (verified=${verifiedLinks.length}, flagged=${flaggedLinks.length})`);

  // --- PRIORITY 1: Any flagged link → Unsafe ---
  if (flaggedLinks.length > 0) {
    return {
      score: null, level: 'unsafe', label: 'Unsafe', color: '#EF4444',
      providerData: providerData || null, linkResults: links,
      breakdown, lastUpdated: providerData?.lastUpdated || null,
    };
  }

  // --- PRIORITY 2: Any verified link → Verified ---
  if (verifiedLinks.length > 0) {
    return {
      score: null, level: 'verified', label: 'Verified', color: '#22C55E',
      providerData: providerData || null, linkResults: links,
      breakdown, lastUpdated: providerData?.lastUpdated || null,
    };
  }

  // --- PRIORITY 3: No link verdict → use provider scores ---
  const score = providerData?.confidence || 0;
  let level, label, color;

  if (score >= 70) {
    level = 'trusted'; label = 'Trusted'; color = '#22C55E';
  } else if (score >= 40) {
    level = 'caution'; label = 'Caution'; color = '#EAB308';
  } else if (score > 0) {
    level = 'low-trust'; label = 'Low Trust'; color = '#EF4444';
  } else {
    level = 'no-data'; label = 'No Data'; color = '#666666';
  }

  const result = {
    score, level, label, color,
    providerData: providerData || null, linkResults: links,
    breakdown, lastUpdated: providerData?.lastUpdated || null,
  };
  logger.info(`[TrustResult] Output: score=${score}, level="${level}", label="${label}"`);
  return result;
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
// Trust Pill — compact inline indicator (26px, Scannr diamond brand mark)
// -------------------------------------------------------------------------

function pillBorderTint(level) {
  switch (level) {
    case 'trusted': case 'verified': return 'rgba(34, 197, 94, 0.2)';
    case 'caution': return 'rgba(234, 179, 8, 0.2)';
    case 'low-trust': case 'unsafe': return 'rgba(239, 68, 68, 0.2)';
    default: return '#222222';
  }
}

function injectTrustPill(tweetEl, tweetUrl, trustResult) {
  // Always store the latest result so event handlers read fresh data
  latestTrustResults.set(tweetUrl, trustResult);

  if (activePills.has(tweetUrl)) {
    updatePill(tweetUrl, trustResult);
    return;
  }

  const { label, color, level } = trustResult;

  const { target, position } = findInjectionPoint(tweetEl);

  const pill = document.createElement('span');
  pill.className = `${P}-pill`;
  pill.setAttribute('role', 'button');
  pill.setAttribute('tabindex', '0');
  pill.setAttribute('aria-label', `Scannr: ${label}`);
  pill.dataset.scannrUrl = tweetUrl;
  pill.dataset.level = level;

  const borderTint = pillBorderTint(level);
  const isNoData = level === 'no-data';

  pill.innerHTML = `${DIAMOND_SVG} <span style="color:#888888;font-weight:500;font-size:12px;">Trust:</span> <span style="color:${color};font-weight:600;font-size:12px;">${label}</span>`;
  pill.style.cssText = `
    display:inline-flex;align-items:center;gap:4px;
    width:fit-content;max-width:fit-content;align-self:flex-start;
    height:26px;padding:2px 10px 2px 8px;border-radius:9999px;
    margin:4px 0 4px 0;
    font-size:12px;cursor:pointer;
    background:#0A0A0A;border:1px solid ${borderTint};
    font-family:'DM Sans',-apple-system,BlinkMacSystemFont,sans-serif;
    white-space:nowrap;user-select:none;line-height:1;
    transition:border-color 0.15s ease,box-shadow 0.15s ease,opacity 180ms ease;
    box-sizing:border-box;
    opacity:0.4;
  `;

  // Hover: purple glow + show detail card
  let hoverTimer = null;
  pill.addEventListener('mouseenter', () => {
    pill.style.borderColor = '#8B5CF6';
    pill.style.boxShadow = '0 0 20px rgba(139,92,246,0.1)';
    pill.style.opacity = '1';
    hoverTimer = setTimeout(() => {
      openDetailCard(tweetUrl, latestTrustResults.get(tweetUrl) || trustResult, pill);
    }, 300);
  });
  pill.addEventListener('mouseleave', () => {
    pill.style.borderColor = borderTint;
    pill.style.boxShadow = 'none';
    if (!pill.classList.contains(`${P}-pill--active`)) {
      pill.style.opacity = '0.4';
    }
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  });

  // Click: immediate detail card
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    openDetailCard(tweetUrl, latestTrustResults.get(tweetUrl) || trustResult, pill);
  });

  pill.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation();
      e.preventDefault();
      openDetailCard(tweetUrl, latestTrustResults.get(tweetUrl) || trustResult, pill);
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

  const { label, color, level } = trustResult;
  const borderTint = pillBorderTint(level);
  const isNoData = level === 'no-data';

  pill.innerHTML = `${DIAMOND_SVG} <span style="color:#888888;font-weight:500;font-size:12px;">Trust:</span> <span style="color:${color};font-weight:600;font-size:12px;">${label}</span>`;
  pill.setAttribute('aria-label', `Scannr: ${label}`);
  pill.dataset.level = level;
  pill.style.borderColor = borderTint;
  if (!pill.classList.contains(`${P}-pill--active`)) {
    pill.style.opacity = '0.4';
  }
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
  const { score, level, label, color: scoreColor, breakdown, linkResults: cardLinks, lastUpdated, accountFallback } = trustResult;
  const isLinkBased = level === 'verified' || level === 'unsafe';
  const isAccountFallback = !!accountFallback;

  // Wrapper (for mouse-enter/leave tracking on the card itself)
  const wrapper = document.createElement('div');
  wrapper.className = `${P}-card-wrapper`;

  // Card
  const card = document.createElement('div');
  card.className = `${P}-detail-card`;
  card.style.background = '#1A1A1A';
  card.style.color = '#F5F5F5';
  card.addEventListener('click', (e) => e.stopPropagation());

  // -- Header (uppercase label) --
  const titleDiv = document.createElement('div');
  titleDiv.className = `${P}-card-title`;
  titleDiv.textContent = isAccountFallback ? 'SCANNR ACCOUNT CHECK' : isLinkBased ? 'SCANNR LINK CHECK' : 'SCANNR TRUST SCORE';
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

  if (isLinkBased) {
    scoreNum.style.color = scoreColor;
    scoreNum.textContent = label;
  } else {
    scoreNum.innerHTML = `<span style="color:${scoreColor}">${Math.round(score || 0)}</span><span style="color:#555555"> / 100</span>`;
  }

  scoreRow.appendChild(scoreBar);
  scoreRow.appendChild(scoreNum);
  card.appendChild(scoreRow);

  // -- Author Ethos row (Amendment 3) --
  {
    const authorHandle = authorHandleCache.get(tweetUrl);
    if (authorHandle && authorHandle !== 'unknown') {
      const cleanHandle = authorHandle.replace(/^@/, '').toLowerCase();
      const ethosData = ethosHandleCache.get(cleanHandle);
      const authorRow = document.createElement('div');
      authorRow.className = `${P}-card-author-row`;

      const authorLabel = document.createElement('span');
      authorLabel.className = `${P}-card-author-label`;
      authorLabel.textContent = authorHandle.startsWith('@') ? authorHandle : `@${authorHandle}`;

      const authorScore = document.createElement('span');
      authorScore.className = `${P}-card-author-score`;
      if (ethosData && ethosData.found && ethosData.score != null) {
        authorScore.innerHTML = `Ethos: <span style="font-family:'JetBrains Mono',monospace;color:#A78BFA;">${ethosData.score}</span>`;
      } else {
        authorScore.textContent = 'Ethos: —';
        authorScore.style.color = '#555555';
      }

      const ethosLink = document.createElement('a');
      ethosLink.className = `${P}-card-author-ethos-link`;
      ethosLink.href = `https://app.ethos.network/profile/x/${encodeURIComponent(cleanHandle)}`;
      ethosLink.target = '_blank';
      ethosLink.rel = 'noopener';
      ethosLink.textContent = '\u2197';

      authorRow.appendChild(authorLabel);
      authorRow.appendChild(authorScore);
      authorRow.appendChild(ethosLink);
      card.appendChild(authorRow);
    }
  }

  // -- Data source rows --

  if (isAccountFallback) {
    // Account-level Ethos fallback
    const accountRow = document.createElement('div');
    accountRow.className = `${P}-card-provider`;
    const dot1 = document.createElement('div');
    dot1.className = `${P}-card-dot`;
    dot1.style.background = '#666666';
    const name1 = document.createElement('span');
    name1.className = `${P}-card-prov-name`;
    name1.textContent = 'Account';
    const info1 = document.createElement('span');
    info1.className = `${P}-card-prov-info`;
    info1.textContent = accountFallback.handle.startsWith('@') ? accountFallback.handle : `@${accountFallback.handle}`;
    accountRow.appendChild(dot1);
    accountRow.appendChild(name1);
    accountRow.appendChild(info1);
    card.appendChild(accountRow);

    const ethosRow = document.createElement('div');
    ethosRow.className = `${P}-card-provider`;
    const dot2 = document.createElement('div');
    dot2.className = `${P}-card-dot`;
    dot2.style.background = '#EAB308';
    const name2 = document.createElement('span');
    name2.className = `${P}-card-prov-name`;
    name2.textContent = 'Ethos';
    const info2 = document.createElement('span');
    info2.className = `${P}-card-prov-info`;
    info2.style.fontFamily = "'JetBrains Mono','SF Mono',monospace";
    info2.textContent = `${accountFallback.ethosScore} \u00B7 ${accountFallback.ethosLevel || 'unknown'}`;
    ethosRow.appendChild(dot2);
    ethosRow.appendChild(name2);
    ethosRow.appendChild(info2);
    card.appendChild(ethosRow);

    // Caption
    const caption = document.createElement('div');
    caption.className = `${P}-card-caption`;
    caption.textContent = 'No tweet-level data available. Showing account reputation.';
    card.appendChild(caption);
  } else {
    // Tweet-level breakdown — Community + Links rows

    // Community row
    {
      const communityRow = document.createElement('div');
      communityRow.className = `${P}-card-provider`;
      const communityData = breakdown.community;
      const hasReports = communityData && communityData.available !== false;
      const signals = trustResult?.providerData?.providerResults?.find(p => p.name === 'community')?.signals;
      const flags = signals?.flags || 0;
      const vouches = signals?.vouches || 0;

      const dot = document.createElement('div');
      dot.className = `${P}-card-dot`;
      dot.style.background = (hasReports && (flags > 0 || vouches > 0)) ? '#22C55E' : '#666666';

      const nameEl = document.createElement('span');
      nameEl.className = `${P}-card-prov-name`;
      nameEl.textContent = 'Community';

      const infoEl = document.createElement('span');
      infoEl.className = `${P}-card-prov-info`;
      if (hasReports && (flags > 0 || vouches > 0)) {
        const parts = [];
        if (vouches > 0) parts.push(`${vouches} vouch${vouches !== 1 ? 'es' : ''}`);
        if (flags > 0) parts.push(`${flags} flag${flags !== 1 ? 's' : ''}`);
        infoEl.textContent = parts.join(', ');
      } else {
        infoEl.textContent = 'No reports yet';
      }

      communityRow.appendChild(dot);
      communityRow.appendChild(nameEl);
      communityRow.appendChild(infoEl);
      card.appendChild(communityRow);
    }

    // On-chain row (Intuition attestations)
    {
      const onchainRow = document.createElement('div');
      onchainRow.className = `${P}-card-provider`;
      const intuitionSignals = trustResult?.providerData?.providerResults
        ?.find(p => p.name === 'intuition')?.signals;
      const iVouches = intuitionSignals?.vouches || 0;
      const iFlags = intuitionSignals?.flags || 0;
      const iAtomId = intuitionSignals?.atomId;
      const hasOnchain = iVouches > 0 || iFlags > 0;

      const dot = document.createElement('div');
      dot.className = `${P}-card-dot`;
      dot.style.background = hasOnchain ? '#8B5CF6' : '#666666';

      const nameEl = document.createElement('span');
      nameEl.className = `${P}-card-prov-name`;
      nameEl.textContent = 'On-chain';

      const infoEl = document.createElement('span');
      infoEl.className = `${P}-card-prov-info`;
      if (hasOnchain) {
        const parts = [];
        if (iVouches > 0) parts.push(`${iVouches} vouch${iVouches !== 1 ? 'es' : ''}`);
        if (iFlags > 0) parts.push(`${iFlags} flag${iFlags !== 1 ? 's' : ''}`);
        infoEl.textContent = parts.join(', ');
      } else {
        infoEl.textContent = 'No attestations';
      }

      onchainRow.appendChild(dot);
      onchainRow.appendChild(nameEl);
      onchainRow.appendChild(infoEl);

      // Click to view on Intuition Explorer
      if (iAtomId) {
        onchainRow.style.cursor = 'pointer';
        onchainRow.addEventListener('click', (e) => {
          e.stopPropagation();
          window.open(`https://testnet.explorer.intuition.systems/atom/${iAtomId}`, '_blank');
        });
      }

      card.appendChild(onchainRow);
    }

    // Links row
    {
      const linksRow = document.createElement('div');
      linksRow.className = `${P}-card-provider`;
      const hasLinks = cardLinks && cardLinks.length > 0;
      const verifiedCount = hasLinks ? cardLinks.filter(l => l.result.status === 'verified').length : 0;
      const flaggedCount = hasLinks ? cardLinks.filter(l => l.result.status === 'flagged').length : 0;
      const unknownCount = hasLinks ? cardLinks.length - verifiedCount - flaggedCount : 0;

      const dot = document.createElement('div');
      dot.className = `${P}-card-dot`;
      dot.style.background = hasLinks ? '#22C55E' : '#666666';

      const nameEl = document.createElement('span');
      nameEl.className = `${P}-card-prov-name`;
      nameEl.textContent = 'Links';

      const infoEl = document.createElement('span');
      infoEl.className = `${P}-card-prov-info`;
      if (!hasLinks) {
        infoEl.textContent = 'No links';
      } else {
        const parts = [];
        if (verifiedCount > 0) parts.push(`${verifiedCount} verified`);
        if (flaggedCount > 0) parts.push(`${flaggedCount} flagged`);
        if (unknownCount > 0) parts.push(`${unknownCount} unknown`);
        infoEl.textContent = parts.join(', ');
      }

      linksRow.appendChild(dot);
      linksRow.appendChild(nameEl);
      linksRow.appendChild(infoEl);
      card.appendChild(linksRow);
    }
  }

  // -- Links detail section (expanded per-link breakdown) --
  if (cardLinks && cardLinks.length > 0) {
    const linkDivider = document.createElement('div');
    linkDivider.className = `${P}-card-divider`;
    card.appendChild(linkDivider);

    const linksTitle = document.createElement('div');
    linksTitle.className = `${P}-card-links-title`;
    linksTitle.textContent = 'Link Details';
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
        linkStatus.innerHTML = `<span style="color:#22C55E;">\u2713 Verified</span> <span style="color:#555555;">\u00B7 ${escapeHtml(result.source)}</span>`;
      } else if (result.status === 'flagged') {
        linkStatus.innerHTML = `<span style="color:#EF4444;">\u26A0 ${escapeHtml(result.reason)}</span> <span style="color:#555555;">\u00B7 ${escapeHtml(result.source)}</span>`;
      } else {
        linkStatus.innerHTML = `<span style="color:#666666;">Unknown</span>`;
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
      // Vouch button — immediate submit
      const vouchBtn = document.createElement('button');
      vouchBtn.className = `${P}-card-btn ${P}-card-btn--vouch`;
      vouchBtn.textContent = 'Vouch';
      vouchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelHideTimer();
        handleSubmission('vouch', tweetUrl, 'vouch', vouchBtn, actionsRow);
      });
      actionsRow.appendChild(vouchBtn);

      // Flag category buttons — each submits immediately with its category
      const flagCategories = [
        { label: 'False Info', category: 'false_info' },
        { label: 'Hacked Account', category: 'hacked_account' },
        { label: 'Wrong Link', category: 'wrong_link' },
      ];
      for (const { label, category } of flagCategories) {
        const flagBtn = document.createElement('button');
        flagBtn.className = `${P}-card-btn ${P}-card-btn--flag`;
        flagBtn.textContent = label;
        flagBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          cancelHideTimer();
          handleSubmission('flag', tweetUrl, category, flagBtn, actionsRow);
        });
        actionsRow.appendChild(flagBtn);
      }
    } else {
      const signInHint = document.createElement('span');
      signInHint.className = `${P}-card-signin-hint`;
      signInHint.textContent = 'Sign in to flag or vouch';
      actionsRow.appendChild(signInHint);
    }
  });

  card.appendChild(actionsRow);

  // -- Community reports button --
  const communityBtnRow = document.createElement('div');
  communityBtnRow.className = `${P}-card-community-row`;

  const communityBtn = document.createElement('button');
  communityBtn.className = `${P}-card-community-btn`;
  communityBtn.textContent = 'See community reports';
  communityBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cancelHideTimer();
    openCommunityCard(tweetUrl, card);
  });
  communityBtnRow.appendChild(communityBtn);
  card.appendChild(communityBtnRow);

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

  // Click outside — check shadow host (closed shadow DOM hides internals from composedPath)
  const clickOutside = (e) => {
    const path = e.composedPath();
    if (path.includes(shadowHost) || path.includes(anchorEl)) {
      return; // Click was inside our shadow host or on the pill
    }
    closeDetailCard();
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

  // Keep pill fully visible while card is open
  anchorEl.classList.add(`${P}-pill--active`);
  anchorEl.style.opacity = '1';

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

let activeCommunityCard = null;

function closeCommunityCard() {
  if (activeCommunityCard) {
    activeCommunityCard.remove();
    activeCommunityCard = null;
  }
}

function closeDetailCard() {
  closeCommunityCard();
  if (activeDetailCard) {
    // Restore pill to faint state
    activeDetailCard.anchorEl.classList.remove(`${P}-pill--active`);
    activeDetailCard.anchorEl.style.opacity = '0.4';
    activeDetailCard.cleanup();
    activeDetailCard.wrapper.remove();
    activeDetailCard = null;
  }
  if (cardHideTimer) { clearTimeout(cardHideTimer); cardHideTimer = null; }
}

/**
 * Opens a community reports card beside the primary detail card.
 * Fetches all submissions for the given tweet URL and displays them.
 */
async function openCommunityCard(tweetUrl, primaryCard) {
  // If already open for this URL, close it (toggle)
  if (activeCommunityCard) {
    closeCommunityCard();
    return;
  }

  const container = getShadowContainer();
  if (!container) return;

  const communityCard = document.createElement('div');
  communityCard.className = `${P}-community-card`;
  communityCard.style.background = '#1A1A1A';
  communityCard.style.color = '#F5F5F5';
  communityCard.addEventListener('click', (e) => e.stopPropagation());

  // Keep primary card open when hovering community card
  communityCard.addEventListener('mouseenter', () => {
    if (cardHideTimer) { clearTimeout(cardHideTimer); cardHideTimer = null; }
  });
  communityCard.addEventListener('mouseleave', () => {
    if (cardHideTimer) clearTimeout(cardHideTimer);
    cardHideTimer = setTimeout(() => closeDetailCard(), 300);
  });

  // Header
  const header = document.createElement('div');
  header.className = `${P}-community-header`;
  header.textContent = 'COMMUNITY REPORTS';
  communityCard.appendChild(header);

  // Loading state
  const loadingDiv = document.createElement('div');
  loadingDiv.className = `${P}-community-loading`;
  loadingDiv.textContent = 'Loading...';
  communityCard.appendChild(loadingDiv);

  // Position beside the primary card
  const primaryRect = primaryCard.getBoundingClientRect();
  const cardWidth = 280;
  const gap = 8;

  // Try right side first, fall back to left
  let left = primaryRect.right + gap;
  if (left + cardWidth > window.innerWidth - 8) {
    left = primaryRect.left - cardWidth - gap;
  }
  if (left < 8) left = 8;

  communityCard.style.top = `${primaryRect.top}px`;
  communityCard.style.left = `${left}px`;

  container.appendChild(communityCard);
  activeCommunityCard = communityCard;

  // Fetch community submissions
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'scannr:get-community-submissions',
      payload: { tweetUrl },
    });

    // Remove loading
    loadingDiv.remove();

    if (response?.error) {
      const errDiv = document.createElement('div');
      errDiv.className = `${P}-community-empty`;
      errDiv.textContent = response.error;
      communityCard.appendChild(errDiv);
      return;
    }

    const submissions = response?.submissions || [];
    if (submissions.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = `${P}-community-empty`;
      emptyDiv.textContent = 'No community reports yet';
      communityCard.appendChild(emptyDiv);
      return;
    }

    for (const sub of submissions) {
      const row = document.createElement('div');
      row.className = `${P}-community-row`;

      const icon = document.createElement('span');
      icon.className = `${P}-community-icon`;
      icon.style.color = sub.type === 'flag' ? '#EF4444' : '#22C55E';
      icon.textContent = sub.type === 'flag' ? '\u26A0' : '\u2713';

      const info = document.createElement('div');
      info.className = `${P}-community-info`;

      const handle = document.createElement('span');
      handle.className = `${P}-community-handle`;
      handle.textContent = sub.reporter_handle ? `@${sub.reporter_handle}` : 'Anonymous';

      const meta = document.createElement('span');
      meta.className = `${P}-community-meta`;
      const typeLabel = sub.type === 'flag' ? 'Flagged' : 'Vouched as Legit';
      const catLabel = sub.category ? ` \u00B7 ${sub.category}` : '';
      const ethosSpan = sub.reporter_ethos_score != null
        ? ` <span style="font-family:'JetBrains Mono',monospace;color:#A78BFA;">\u00B7 Ethos: ${sub.reporter_ethos_score}</span>`
        : '';
      meta.innerHTML = `<span style="color:${sub.type === 'flag' ? '#EF4444' : '#22C55E'}">${escapeHtml(typeLabel)}</span>${escapeHtml(catLabel)}${ethosSpan} <span style="color:#555555;">\u00B7 ${timeAgo(sub.created_at)}</span>`;

      info.appendChild(handle);
      info.appendChild(meta);

      // "View Ethos" link
      if (sub.reporter_handle) {
        const ethosLink = document.createElement('a');
        ethosLink.className = `${P}-community-ethos-link`;
        ethosLink.href = `https://app.ethos.network/profile/x/${encodeURIComponent(sub.reporter_handle)}`;
        ethosLink.target = '_blank';
        ethosLink.rel = 'noopener';
        ethosLink.textContent = 'View Ethos \u2197';
        info.appendChild(ethosLink);
      }

      row.appendChild(icon);
      row.appendChild(info);
      communityCard.appendChild(row);
    }
  } catch {
    loadingDiv.textContent = 'Failed to load';
  }
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

async function handleSubmission(type, tweetUrl, category, activeBtn, actionsRow) {
  // Disable all buttons in the actions row
  const allBtns = actionsRow.querySelectorAll('button');
  allBtns.forEach(btn => { btn.disabled = true; });
  const origText = activeBtn.textContent;
  activeBtn.textContent = type === 'flag' ? 'Flagging...' : 'Vouching...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'scannr:submit-report',
      payload: { reportType: type, targetUrl: tweetUrl, category },
    });

    if (response?.error) {
      if (response.error === 'Not signed in') {
        activeBtn.textContent = 'Sign in first';
      } else if (response.error === 'Already submitted') {
        activeBtn.textContent = 'Already submitted';
      } else {
        activeBtn.textContent = 'Error';
      }
      setTimeout(() => {
        activeBtn.textContent = origText;
        allBtns.forEach(btn => { btn.disabled = false; });
      }, 2000);
      return;
    }

    activeBtn.textContent = type === 'flag' ? 'Flagged' : 'Vouched';
    activeBtn.classList.add(`${P}-card-btn--done`);
  } catch {
    activeBtn.textContent = origText;
    allBtns.forEach(btn => { btn.disabled = false; });
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

      // Check if result has meaningful tweet-level data
      const hasTweetData = hasMeaningfulTweetData(response.result, tweetUrl);
      if (!hasTweetData) {
        // No tweet-level data — try account-level Ethos fallback
        requestEthosFallback(tweetUrl);
      }
    } else {
      // No result at all — try fallback
      requestEthosFallback(tweetUrl);
    }
  } catch {
    // Background may not be ready
  }
}

/**
 * Check whether reputation result has meaningful tweet-level data
 * (community submissions or link verdicts).
 */
function hasMeaningfulTweetData(result, tweetUrl) {
  // Check community submissions
  const communitySignals = result?.providerResults?.find(p => p.name === 'community')?.signals;
  if (communitySignals && (communitySignals.flags > 0 || communitySignals.vouches > 0)) {
    return true;
  }
  // Check link results
  const links = linkResultsCache.get(tweetUrl) || [];
  if (links.some(l => l.result.status === 'verified' || l.result.status === 'flagged')) {
    return true;
  }
  return false;
}

/**
 * Account-level Ethos fallback — query by author handle when no tweet-level data exists.
 */
async function requestEthosFallback(tweetUrl) {
  const handle = authorHandleCache.get(tweetUrl);
  if (!handle || handle === 'unknown') return;

  const cleanHandle = handle.replace(/^@/, '').toLowerCase();

  // Check local cache (avoid redundant messages for same author)
  const cached = ethosHandleCache.get(cleanHandle);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
    applyEthosFallback(tweetUrl, handle, cached);
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'scannr:query-ethos-handle',
      payload: { handle },
    });

    if (response) {
      const entry = { ...response, ts: Date.now() };
      ethosHandleCache.set(cleanHandle, entry);
      applyEthosFallback(tweetUrl, handle, entry);
    }
  } catch {
    // Service worker not ready
  }
}

/**
 * Apply Ethos account-level data as a fallback trust result.
 * - Low Ethos score (< 400 or untrusted/questionable) → "Caution" (yellow)
 * - No Ethos profile (404) → "No Data" (gray)
 * - Normal/high Ethos score → "No Data" (gray) — one source isn't enough for green
 */
function applyEthosFallback(tweetUrl, handle, ethosData) {
  if (!ethosData.found) return; // No profile → stay "No Data"

  const isLowScore = ethosData.score != null && ethosData.score < 400;
  const isLowLevel = ethosData.level === 'untrusted' || ethosData.level === 'questionable';

  if (!isLowScore && !isLowLevel) return; // Normal score → stay "No Data"

  // Low score — show Caution pill with account-level data
  const trustResult = {
    score: Math.round((ethosData.score / 2800) * 100),
    level: 'caution',
    label: 'Caution',
    color: '#EAB308',
    providerData: null,
    linkResults: [],
    breakdown: {},
    lastUpdated: null,
    accountFallback: {
      handle,
      ethosScore: ethosData.score,
      ethosLevel: ethosData.level,
    },
  };

  latestTrustResults.set(tweetUrl, trustResult);

  // Update pill if it exists
  const pill = activePills.get(tweetUrl);
  if (pill) {
    updatePill(tweetUrl, trustResult);
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
/* Font faces — loaded from extension bundle */
@font-face {
  font-family: 'DM Sans';
  font-weight: 400;
  src: url(chrome-extension://${chrome.runtime.id}/assets/fonts/DMSans-Regular.woff2) format('woff2');
}
@font-face {
  font-family: 'DM Sans';
  font-weight: 500;
  src: url(chrome-extension://${chrome.runtime.id}/assets/fonts/DMSans-Medium.woff2) format('woff2');
}
@font-face {
  font-family: 'DM Sans';
  font-weight: 600;
  src: url(chrome-extension://${chrome.runtime.id}/assets/fonts/DMSans-SemiBold.woff2) format('woff2');
}
@font-face {
  font-family: 'JetBrains Mono';
  font-weight: 500;
  src: url(chrome-extension://${chrome.runtime.id}/assets/fonts/JetBrainsMono-Medium.woff2) format('woff2');
}

:host {
  color-scheme: dark;
}

/* Card wrapper — receives mouse events */
.${P}-card-wrapper {
  position: fixed; inset: 0;
  z-index: 100000; pointer-events: none;
}

/* Animations */
@keyframes ${P}-card-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes ${P}-fade-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ─── Detail Card ──────────────────────────────── */

.${P}-detail-card {
  position: fixed;
  width: 320px;
  background: #1A1A1A;
  color-scheme: dark;
  border: 1px solid #222222;
  border-radius: 12px;
  padding: 16px;
  color: #F5F5F5;
  font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 13px;
  line-height: 1.5;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5), 0 0 0 1px #222222;
  pointer-events: auto;
  animation: ${P}-card-in 0.15s ease;
  z-index: 100001;
}

/* Title — uppercase label */
.${P}-card-title {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #555555;
  margin-bottom: 10px;
}

/* Score row */
.${P}-card-score-row {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 14px;
}

.${P}-card-score-bar {
  flex: 1; height: 4px; border-radius: 2px;
  background: #141414; overflow: hidden;
}

.${P}-card-score-fill {
  height: 100%; border-radius: 2px;
  transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.${P}-card-score-num {
  font-family: 'JetBrains Mono', 'SF Mono', monospace;
  font-size: 14px; font-weight: 600;
  white-space: nowrap;
}

/* Author Ethos row */
.${P}-card-author-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 0; font-size: 12px;
  border-bottom: 1px solid #222222;
  margin-bottom: 4px;
}
.${P}-card-author-label {
  font-weight: 600; color: #F5F5F5;
}
.${P}-card-author-score {
  color: #888888; font-size: 12px;
  margin-left: auto;
}
.${P}-card-author-ethos-link {
  color: #A78BFA; text-decoration: none; font-size: 12px;
}
.${P}-card-author-ethos-link:hover {
  text-decoration: underline;
}

/* Data rows (Community, Links, Account, Ethos) */
.${P}-card-provider {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 0; font-size: 13px;
}

.${P}-card-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.${P}-card-prov-name {
  font-weight: 500; color: #888888; min-width: 80px;
}

.${P}-card-prov-info {
  color: #F5F5F5;
}

/* Account fallback caption */
.${P}-card-caption {
  font-size: 11px;
  color: #555555;
  margin-top: 6px;
  line-height: 1.4;
}

/* Links detail section */
.${P}-card-links-title {
  font-size: 11px; font-weight: 500; color: #555555;
  margin-bottom: 6px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.${P}-card-link-row {
  display: flex; align-items: baseline; gap: 8px;
  padding: 3px 0; font-size: 12px;
  flex-wrap: wrap;
}

.${P}-card-link-domain {
  color: #8B5CF6; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis;
  max-width: 120px; white-space: nowrap;
}

.${P}-card-link-status {
  color: #555555; white-space: nowrap;
}

/* Timestamp */
.${P}-card-timestamp {
  font-size: 11px; color: #555555;
  margin-top: 10px; margin-bottom: 6px;
}

/* Divider */
.${P}-card-divider {
  height: 1px; background: #222222;
  margin: 12px 0;
}

/* Disclaimer */
.${P}-card-disclaimer {
  font-size: 11px; color: #555555;
  margin-bottom: 6px; line-height: 1.4;
  text-align: center;
}

/* Action buttons */
.${P}-card-actions {
  display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;
}

.${P}-card-btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid #222222;
  border-radius: 8px;
  font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 12px; font-weight: 500;
  cursor: pointer;
  background: transparent;
  transition: all 0.15s ease;
}

.${P}-card-btn:active { transform: scale(0.97); }
.${P}-card-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.${P}-card-btn--flag {
  color: #EF4444;
}
.${P}-card-btn--flag:hover {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
}

.${P}-card-btn--vouch {
  color: #22C55E;
}
.${P}-card-btn--vouch:hover {
  background: rgba(34, 197, 94, 0.1);
  border-color: rgba(34, 197, 94, 0.3);
}

.${P}-card-btn--done {
  opacity: 0.5; cursor: default; pointer-events: none;
}
.${P}-card-btn--flag.${P}-card-btn--done {
  background: rgba(239, 68, 68, 0.08);
}
.${P}-card-btn--vouch.${P}-card-btn--done {
  background: rgba(34, 197, 94, 0.08);
}

.${P}-card-signin-hint {
  color: #555555; font-size: 12px; text-align: center; width: 100%;
}

/* Community reports button */
.${P}-card-community-row {
  margin-top: 8px;
}

.${P}-card-community-btn {
  display: flex; align-items: center; justify-content: center;
  gap: 6px;
  width: 100%; padding: 8px;
  border: 1px solid #222222;
  border-radius: 8px; background: transparent;
  color: #A78BFA;
  font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 12px; font-weight: 500; cursor: pointer;
  transition: all 0.15s ease;
}
.${P}-card-community-btn:hover {
  background: rgba(139, 92, 246, 0.15);
  border-color: rgba(139, 92, 246, 0.3);
}

/* ─── Community Card ───────────────────────────── */

.${P}-community-card {
  position: fixed; width: 280px;
  background: #1A1A1A; color: #F5F5F5;
  border: 1px solid #222222; border-radius: 12px;
  padding: 16px; pointer-events: auto;
  font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 13px; line-height: 1.5;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5), 0 0 0 1px #222222;
  animation: ${P}-card-in 0.15s ease;
  z-index: 100002;
  max-height: 400px; overflow-y: auto;
  color-scheme: dark;
}

.${P}-community-card::-webkit-scrollbar { width: 4px; }
.${P}-community-card::-webkit-scrollbar-track { background: transparent; }
.${P}-community-card::-webkit-scrollbar-thumb {
  background: rgba(139, 92, 246, 0.25);
  border-radius: 2px;
}

.${P}-community-header {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: #555555;
  margin-bottom: 10px;
}

.${P}-community-loading,
.${P}-community-empty {
  font-size: 12px; color: #555555;
  text-align: center; padding: 12px 0;
}

.${P}-community-row {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 10px 0;
  border-bottom: 1px solid #222222;
}
.${P}-community-row:last-child { border-bottom: none; }

.${P}-community-icon {
  font-size: 13px; flex-shrink: 0; margin-top: 1px;
}

.${P}-community-info {
  display: flex; flex-direction: column; min-width: 0;
}

.${P}-community-handle {
  font-size: 13px; font-weight: 600; color: #F5F5F5;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.${P}-community-meta {
  font-size: 12px; color: #888888; margin-top: 2px;
}

.${P}-community-ethos-link {
  color: #A78BFA;
  font-size: 11px;
  text-decoration: none;
  display: inline-block;
  margin-top: 2px;
}
.${P}-community-ethos-link:hover {
  text-decoration: underline;
  color: #8B5CF6;
}
  `;
}
