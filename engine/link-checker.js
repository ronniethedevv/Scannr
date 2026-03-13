/**
 * Scannr — Link Checker
 *
 * Cross-references URLs against a local registry of known protocols
 * and flagged domains. All checks are local lookups — zero network calls.
 */

import registry from '../config/verified-registry.json';

/**
 * Check a URL against the local registry.
 * @param {string} url — full URL or domain-like string (e.g., "citrea.xyz/bridge")
 * @returns {{ status: 'verified'|'flagged'|'unknown', domain?: string, name?: string, category?: string, reason?: string, source?: string }}
 */
export function checkLink(url) {
  try {
    let fullUrl = url;
    if (!url.startsWith('http')) {
      fullUrl = 'https://' + url;
    }

    const urlObj = new URL(fullUrl);
    const domain = urlObj.hostname.replace(/^www\./, '');

    // Flagged takes priority
    if (registry.flagged[domain]) {
      return {
        status: 'flagged',
        domain,
        reason: registry.flagged[domain].reason,
        source: registry.flagged[domain].source,
      };
    }

    // Check verified
    if (registry.verified[domain]) {
      return {
        status: 'verified',
        domain,
        name: registry.verified[domain].name,
        category: registry.verified[domain].category,
        source: registry.verified[domain].source,
      };
    }

    // Parent domain fallback (e.g., sbts.pudgypenguins.com → pudgypenguins.com)
    const parts = domain.split('.');
    if (parts.length > 2) {
      const parentDomain = parts.slice(-2).join('.');
      if (registry.verified[parentDomain]) {
        return {
          status: 'verified',
          domain,
          name: registry.verified[parentDomain].name,
          category: registry.verified[parentDomain].category,
          source: registry.verified[parentDomain].source,
        };
      }
      // Also check flagged parent
      if (registry.flagged[parentDomain]) {
        return {
          status: 'flagged',
          domain,
          reason: registry.flagged[parentDomain].reason,
          source: registry.flagged[parentDomain].source,
        };
      }
    }

    return { status: 'unknown' };
  } catch {
    return { status: 'unknown' };
  }
}

/**
 * Extract all external URLs from a tweet text element and check each.
 * @param {Element} tweetTextElement — [data-testid="tweetText"] element
 * @returns {Array<{ element: Element, url: string, result: object }>}
 */
export function extractLinks(tweetTextElement) {
  const links = tweetTextElement.querySelectorAll('a[href]');
  const results = [];

  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href) continue;
    if (href.startsWith('/')) continue; // internal X links
    if (href.includes('twitter.com') || href.includes('x.com')) continue;

    // X wraps external links in t.co — visible text shows the actual domain
    const visibleText = link.textContent.trim();

    // Use visible text if it looks like a domain, otherwise fall back to href
    const urlToCheck = visibleText.includes('.') && !visibleText.includes(' ')
      ? visibleText.replace(/…$/, '') // remove X's truncation ellipsis
      : href;

    results.push({
      element: link,
      url: urlToCheck,
      result: checkLink(urlToCheck),
    });
  }

  return results;
}
