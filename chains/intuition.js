/**
 * Scannr — Intuition Network Chain Definition (viem)
 *
 * Testnet for development. Switch to mainnet (chain ID 1155)
 * before production launch.
 */

import { defineChain } from 'viem';

export const intuitionTestnet = defineChain({
  id: 13579,
  name: 'Intuition Testnet',
  network: 'intuition-testnet',
  nativeCurrency: { name: 'tTRUST', symbol: 'tTRUST', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet.rpc.intuition.systems/'] },
  },
  blockExplorers: {
    default: { name: 'Intuition Explorer', url: 'https://testnet.explorer.intuition.systems' },
  },
});

export const intuitionMainnet = defineChain({
  id: 1155,
  name: 'Intuition Network',
  network: 'intuition',
  nativeCurrency: { name: 'TRUST', symbol: 'TRUST', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.intuition.systems/'] },
  },
  blockExplorers: {
    default: { name: 'Intuition Explorer', url: 'https://explorer.intuition.systems' },
  },
});
