import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { defineChain } from 'viem';

const EXTENSION_ID = import.meta.env.VITE_EXTENSION_ID;
const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID;

const intuitionTestnet = defineChain({
  id: 13579,
  name: 'Intuition Testnet',
  network: 'intuition-testnet',
  nativeCurrency: { name: 'tTRUST', symbol: 'tTRUST', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet.rpc.intuition.systems/'] } },
});

function WalletSetup() {
  const { ready, authenticated, login, user } = usePrivy();
  const { wallets } = useWallets();
  const [status, setStatus] = useState('loading');

  const embedded = wallets.find((w) => w.walletClientType === 'privy');

  useEffect(() => {
    if (!embedded?.address || !user) return;
    setStatus('sending');

    if (!EXTENSION_ID) {
      setStatus('error-no-ext');
      return;
    }

    try {
      chrome.runtime.sendMessage(
        EXTENSION_ID,
        { type: 'wallet-connected', address: embedded.address, privyUserId: user.id },
        (response) => {
          if (chrome.runtime.lastError || !response?.success) {
            setStatus('error-send');
            return;
          }
          setStatus('done');
          setTimeout(() => window.close(), 2000);
        },
      );
    } catch {
      setStatus('error-send');
    }
  }, [embedded?.address, user]);

  useEffect(() => {
    if (!ready) setStatus('loading');
    else if (!authenticated) setStatus('login');
    else if (!embedded) setStatus('creating');
  }, [ready, authenticated, embedded]);

  if (status === 'loading') return <p style={S.muted}>Initializing...</p>;

  if (status === 'login') {
    return (
      <>
        <div style={S.logo}>S</div>
        <h1 style={S.title}>Scannr Wallet</h1>
        <p style={S.desc}>Connect a wallet to submit on-chain trust attestations.</p>
        <button style={S.btn} onClick={login}>Set up wallet</button>
      </>
    );
  }

  if (status === 'creating') return <p style={S.muted}>Creating embedded wallet...</p>;
  if (status === 'sending') return <p style={S.muted}>Connecting to Scannr...</p>;

  if (status === 'done') {
    return (
      <>
        <div style={S.logo}>S</div>
        <h1 style={S.title}>Wallet Connected!</h1>
        <p style={S.addr}>{embedded?.address?.slice(0, 6)}...{embedded?.address?.slice(-4)}</p>
        <p style={S.hint}>This tab will close automatically.</p>
      </>
    );
  }

  if (status === 'error-no-ext') {
    return <p style={S.error}>Extension ID not configured. Please contact support.</p>;
  }

  if (status === 'error-send') {
    return (
      <>
        <p style={S.error}>Could not connect to Scannr extension.</p>
        <p style={S.hint}>Make sure the extension is installed and try again.</p>
      </>
    );
  }

  return null;
}

const S = {
  logo: { width: 56, height: 56, background: '#1D9BF0', color: '#fff', fontSize: 28, fontWeight: 700, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px' },
  title: { fontSize: 22, fontWeight: 700, color: '#E7E9EA', marginBottom: 8 },
  desc: { fontSize: 14, color: '#71767B', lineHeight: 1.5, marginBottom: 24 },
  muted: { fontSize: 14, color: '#71767B' },
  addr: { fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 15, color: '#1D9BF0', background: 'rgba(29,155,240,0.1)', padding: '10px 16px', borderRadius: 8, margin: '16px 0' },
  hint: { fontSize: 13, color: '#536471', marginTop: 16 },
  error: { fontSize: 14, color: '#F4212E', marginBottom: 8 },
  btn: { width: '100%', padding: '12px 24px', fontSize: 15, fontWeight: 700, color: '#fff', background: '#1D9BF0', border: 'none', borderRadius: 9999, cursor: 'pointer' },
};

function App() {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        embeddedWallets: { createOnLogin: 'users-without-wallets' },
        defaultChain: intuitionTestnet,
        supportedChains: [intuitionTestnet],
        appearance: { theme: 'dark', accentColor: '#1D9BF0' },
      }}
    >
      <WalletSetup />
    </PrivyProvider>
  );
}

createRoot(document.getElementById('root')).render(<App />);
