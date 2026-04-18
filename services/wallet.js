/**
 * Scannr — Wallet State Service
 *
 * Persists embedded wallet address in chrome.storage.local.
 * Used by the service worker and popup.
 */

const STORAGE_KEY_WALLET = 'scannr_wallet_address';

export async function getWalletAddress() {
  const result = await chrome.storage.local.get(STORAGE_KEY_WALLET);
  return result[STORAGE_KEY_WALLET] || null;
}

export async function setWalletAddress(address) {
  await chrome.storage.local.set({ [STORAGE_KEY_WALLET]: address });
}

export async function clearWallet() {
  await chrome.storage.local.remove(STORAGE_KEY_WALLET);
}
