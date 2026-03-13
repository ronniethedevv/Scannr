/**
 * Build script — run with: node scripts/build-registry.js
 *
 * Fetches protocol and scam domain data from public sources
 * and generates config/verified-registry.json
 *
 * Run this before each extension build to keep the registry current.
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'config', 'verified-registry.json');

async function fetchDeFiLlama() {
  console.log('Fetching DeFiLlama protocols...');
  const res = await fetch('https://api.llama.fi/protocols');
  if (!res.ok) throw new Error(`DeFiLlama API returned ${res.status}`);
  const protocols = await res.json();

  const entries = {};

  for (const protocol of protocols) {
    if (!protocol.url) continue;

    try {
      const url = new URL(protocol.url);
      const domain = url.hostname.replace(/^www\./, '');

      entries[domain] = {
        name: protocol.name,
        category: protocol.category || 'DeFi',
        source: 'DeFiLlama',
      };

      // Also add common subdomains
      if (!domain.startsWith('app.')) {
        entries[`app.${domain}`] = { ...entries[domain] };
      }
    } catch {
      // Invalid URL, skip
    }
  }

  console.log(`  Found ${Object.keys(entries).length} protocol domains`);
  return entries;
}

// Manual curated list — safety net for well-known domains
const MANUAL_VERIFIED = {
  'coinbase.com':     { name: 'Coinbase', category: 'Exchange', source: 'Manual' },
  'binance.com':      { name: 'Binance', category: 'Exchange', source: 'Manual' },
  'metamask.io':      { name: 'MetaMask', category: 'Wallet', source: 'Manual' },
  'ledger.com':       { name: 'Ledger', category: 'Hardware Wallet', source: 'Manual' },
  'trezor.io':        { name: 'Trezor', category: 'Hardware Wallet', source: 'Manual' },
  'opensea.io':       { name: 'OpenSea', category: 'NFT Marketplace', source: 'Manual' },
  'etherscan.io':     { name: 'Etherscan', category: 'Block Explorer', source: 'Manual' },
  'solscan.io':       { name: 'Solscan', category: 'Block Explorer', source: 'Manual' },
  'coingecko.com':    { name: 'CoinGecko', category: 'Data', source: 'Manual' },
  'dexscreener.com':  { name: 'DEX Screener', category: 'Analytics', source: 'Manual' },
};

async function fetchCoinGeckoExchanges() {
  console.log('Fetching CoinGecko exchanges...');
  const res = await fetch(
    'https://api.coingecko.com/api/v3/exchanges?per_page=250'
  );
  if (!res.ok) throw new Error(`CoinGecko API returned ${res.status}`);
  const exchanges = await res.json();

  const entries = {};

  for (const exchange of exchanges) {
    if (!exchange.url) continue;

    try {
      const url = new URL(exchange.url);
      const domain = url.hostname.replace(/^www\./, '');

      entries[domain] = {
        name: exchange.name,
        category: 'Exchange',
        source: 'CoinGecko',
      };
    } catch {
      // Invalid URL, skip
    }
  }

  console.log(`  Found ${Object.keys(entries).length} exchange domains`);
  return entries;
}

async function fetchMetaMaskPhishingList() {
  console.log('Fetching MetaMask phishing blocklist...');
  const res = await fetch(
    'https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/master/src/config.json'
  );
  if (!res.ok) throw new Error(`MetaMask blocklist returned ${res.status}`);
  const config = await res.json();

  const flagged = {};

  for (const domain of config.blacklist || []) {
    flagged[domain] = {
      reason: 'Known phishing domain',
      source: 'MetaMask',
    };
  }

  for (const domain of config.fuzzylist || []) {
    if (!flagged[domain]) {
      flagged[domain] = {
        reason: 'Suspected phishing (typosquat)',
        source: 'MetaMask',
      };
    }
  }

  console.log(`  Found ${Object.keys(flagged).length} flagged domains`);
  return flagged;
}

function mergeVerified(target, source) {
  for (const [domain, entry] of Object.entries(source)) {
    if (target[domain]) {
      // Domain exists in both — combine sources
      const existingSources = target[domain].source.split(', ');
      if (!existingSources.includes(entry.source)) {
        target[domain].source += `, ${entry.source}`;
      }
    } else {
      target[domain] = { ...entry };
    }
  }
}

async function buildRegistry() {
  console.log('Building Scannr link registry...\n');

  const verified = await fetchDeFiLlama();

  // CoinGecko exchanges
  try {
    const exchanges = await fetchCoinGeckoExchanges();
    mergeVerified(verified, exchanges);
  } catch (err) {
    console.warn(`  CoinGecko fetch failed (${err.message}). Continuing without exchange data.`);
  }

  // Manual curated entries (always applied)
  mergeVerified(verified, MANUAL_VERIFIED);
  console.log(`  Added ${Object.keys(MANUAL_VERIFIED).length} manual entries`);

  let flagged = {};
  try {
    flagged = await fetchMetaMaskPhishingList();
  } catch (err) {
    console.warn(`  MetaMask fetch failed (${err.message}). Continuing with empty flagged list.`);
  }

  // Flagged takes priority — remove conflicts
  for (const domain of Object.keys(flagged)) {
    if (verified[domain]) {
      console.log(`  WARNING: ${domain} is both verified and flagged. Flagged takes priority.`);
      delete verified[domain];
    }
  }

  const registry = {
    version: new Date().toISOString().split('T')[0],
    stats: {
      verified_count: Object.keys(verified).length,
      flagged_count: Object.keys(flagged).length,
    },
    verified,
    flagged,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(registry));
  console.log(`\nRegistry built successfully:`);
  console.log(`  Verified: ${registry.stats.verified_count} domains`);
  console.log(`  Flagged: ${registry.stats.flagged_count} domains`);
  console.log(`  Output: ${OUTPUT_PATH}`);
}

buildRegistry().catch((err) => {
  console.error('Registry build failed:', err);
  process.exit(1);
});
