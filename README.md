# ◆ Scannr

Trust layer for X/Twitter — Chrome extension with on-chain attestations.

## What it does

Scannr adds trust signals to every tweet on your X timeline. It aggregates reputation data from multiple on-chain and off-chain sources into a single trust pill that appears next to tweets, so you can spot scams, verify builders, and vouch for legitimate content.

- **Trust pills** on every tweet — color-coded reputation at a glance
- **Vouch or flag** content directly from the hover card
- **On-chain attestations** written to Intuition Network's knowledge graph as stake-weighted triples
- **Ethos integration** for account-level credibility scores
- **Community reports** — see what other Scannr users have flagged or vouched

## Install

Scannr works on any Chromium browser — Chrome, Brave, Edge, Arc.

1. Download **scannr-v1.0.0.zip** from the [latest release](https://github.com/ronniethedevv/Scannr/releases/latest)
2. Unzip to a folder on your computer
3. Open `chrome://extensions` (or `brave://extensions`)
4. Toggle **Developer mode** ON (top right)
5. Click **Load unpacked**
6. Select the unzipped folder
7. Pin Scannr to your toolbar
8. Go to [x.com](https://x.com) and start scanning

## How it works

When you browse X, Scannr queries multiple reputation providers for each tweet and merges the results into a single trust score:

| Provider | Weight | Signal |
|----------|--------|--------|
| Ethos Network | 0.30 | Account-level credibility scores |
| Community | 0.35 | Vouches and flags from Scannr users |
| Intuition Network | 0.20 | On-chain, stake-weighted content attestations |
| Prints (Fluent) | 0.15 | Contextual reputation (coming soon) |

When you vouch or flag a tweet, Scannr writes an on-chain attestation to Intuition's MultiVault contract — a triple like `(tweet_url, is_trustworthy, crypto_twitter)` backed by TRUST token deposits. These attestations are permanent, public, and readable by any app building on the Intuition knowledge graph.

## Architecture

```
X Timeline
  └─ Content Script (Shadow DOM)
       ├─ Trust pills injected per tweet
       └─ Hover card with score breakdown
              │
              ▼
       Service Worker
       ├─ Aggregator engine (weighted multi-provider scoring)
       ├─ Ethos provider (REST API)
       ├─ Community provider (Supabase queries)
       └─ Intuition provider (on-chain reads)
              │
              ▼
       Supabase Edge Functions
       ├─ create-attestation (writes atoms + triples to Intuition)
       └─ prefund (treasury wallet management)
```

- **Chrome MV3** extension, vanilla JS, closed Shadow DOM
- **Supabase** for auth (X OAuth), database, and Edge Functions
- **Privy** for embedded wallets on Intuition Network
- **Intuition Network** L3 for on-chain attestations via MultiVault contract
- **esbuild** for bundling

## Built with

- [Intuition Network](https://intuition.systems) — on-chain knowledge graph
- [Ethos Network](https://ethos.network) — account reputation
- [Supabase](https://supabase.com) — backend
- [Privy](https://privy.io) — embedded wallets
- [viem](https://viem.sh) — Ethereum client

---

Built by [@ronnie_thedev](https://x.com/ronnie_thedev)
