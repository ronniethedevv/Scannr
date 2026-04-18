/**
 * Scannr — Popup Script
 *
 * Controls the extension popup UI:
 *   - Master toggle (TL Protection on/off)
 *   - Provider status cards with health indicators
 *   - Weight tuning sliders
 *   - Scanned tweet count
 */

// -------------------------------------------------------------------------
// DOM References
// -------------------------------------------------------------------------

const masterToggle = document.getElementById('master-toggle');
const authSignedOut = document.getElementById('auth-signed-out');
const authSignedIn = document.getElementById('auth-signed-in');
const authUserName = document.getElementById('auth-user-name');
const signInBtn = document.getElementById('sign-in-btn');
const signOutBtn = document.getElementById('sign-out-btn');

// -------------------------------------------------------------------------
// Initialization
// -------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  // Load current state from background
  const status = await sendMessage({ type: 'scannr:get-status' });

  // Master toggle
  masterToggle.checked = status?.enabled || false;
  masterToggle.addEventListener('change', () => {
    const enabled = masterToggle.checked;
    sendMessage({ type: 'scannr:toggle', payload: { enabled } });
    updateUIState(enabled, 0);
    // Start polling for status updates so "Waiting for tweets..." refreshes
    if (enabled) startStatusPolling();
    else stopStatusPolling();
  });

  // Scanned tweet count
  updateUIState(status?.enabled || false, status?.visibleUrls || 0);

  // Auto-refresh status while popup is open and scannr is enabled
  if (status?.enabled) startStatusPolling();

  // Reputation source selector
  await initReputationSource();

  // Auth state
  await refreshAuthUI();

  signInBtn.addEventListener('click', async () => {
    console.log('[Scannr Popup] Sign in button clicked');
    signInBtn.disabled = true;
    signInBtn.textContent = 'Signing in...';
    const result = await sendMessage({ type: 'scannr:sign-in' });
    console.log('[Scannr Popup] Sign in response:', JSON.stringify(result));
    if (result?.error) {
      signInBtn.textContent = result.error === 'Sign-in was cancelled'
        ? 'Sign in with X'
        : `Error: ${result.error}`;
      signInBtn.disabled = false;
      if (result.error !== 'Sign-in was cancelled') {
        setTimeout(() => {
          signInBtn.textContent = 'Sign in with X';
        }, 3000);
      }
    } else {
      await refreshAuthUI();
    }
  });

  signOutBtn.addEventListener('click', async () => {
    signOutBtn.disabled = true;
    await sendMessage({ type: 'scannr:sign-out' });
    await refreshAuthUI();
    signOutBtn.disabled = false;
  });

  // Wallet UI
  await refreshWalletUI();

  document.getElementById('setup-wallet-btn')?.addEventListener('click', () => {
    sendMessage({ type: 'scannr:open-wallet-setup' });
    window.close();
  });

  document.getElementById('disconnect-wallet-btn')?.addEventListener('click', async () => {
    await sendMessage({ type: 'scannr:disconnect-wallet' });
    await refreshWalletUI();
  });

  document.getElementById('wallet-copy-btn')?.addEventListener('click', async () => {
    const result = await sendMessage({ type: 'scannr:get-wallet' });
    if (result?.address) {
      await navigator.clipboard.writeText(result.address);
      const btn = document.getElementById('wallet-copy-btn');
      btn.classList.add('wallet-copy-btn--copied');
      setTimeout(() => btn.classList.remove('wallet-copy-btn--copied'), 1500);
    }
  });

  // Community activity feed
  loadActivityFeed();
});

// -------------------------------------------------------------------------
// Reputation Source Selector
// -------------------------------------------------------------------------

async function initReputationSource() {
  const stored = await chrome.storage.local.get('reputation_source');
  const current = stored.reputation_source || 'ethos';

  const radios = document.querySelectorAll('input[name="reputation_source"]');
  for (const radio of radios) {
    radio.checked = radio.value === current;
    radio.addEventListener('change', () => {
      if (radio.checked) {
        chrome.storage.local.set({ reputation_source: radio.value });
      }
    });
  }

  // Show Ethos health status
  sendMessage({ type: 'scannr:health-check' }).then((result) => {
    const statusEl = document.getElementById('rep-status-ethos');
    if (statusEl && result?.health) {
      const isOnline = result.health.ethos === true;
      statusEl.textContent = isOnline ? 'Online' : 'Offline';
      statusEl.className = `rep-source-option__status ${isOnline ? 'rep-source-option__status--online' : 'rep-source-option__status--offline'}`;
    }
  });
}

// -------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------

function updateUIState(enabled, tweetCount = 0) {

  // Update scanned tweets indicator
  let statsEl = document.getElementById('scan-stats');
  if (!statsEl) {
    statsEl = document.createElement('div');
    statsEl.id = 'scan-stats';
    statsEl.className = 'scan-stats';
    const toggleSection = document.querySelector('.toggle-section');
    if (toggleSection) toggleSection.appendChild(statsEl);
  }

  if (enabled && tweetCount > 0) {
    statsEl.textContent = `Scanning ${tweetCount} tweet${tweetCount !== 1 ? 's' : ''} in viewport`;
    statsEl.style.display = 'block';
  } else if (enabled) {
    statsEl.textContent = 'Waiting for tweets...';
    statsEl.style.display = 'block';
  } else {
    statsEl.style.display = 'none';
  }
}

// -------------------------------------------------------------------------
// Auth UI
// -------------------------------------------------------------------------

async function refreshAuthUI() {
  const result = await sendMessage({ type: 'scannr:get-user' });
  const user = result?.user;

  if (user) {
    authSignedOut.style.display = 'none';
    authSignedIn.style.display = 'block';

    // Fetch profile from users table
    const profileResult = await sendMessage({ type: 'scannr:get-user-profile' });
    const profile = profileResult?.profile;

    // Display handle — prefer users table, fall back to auth metadata
    const handle = profile?.x_handle
      || user.user_metadata?.preferred_username
      || user.user_metadata?.user_name
      || user.email
      || 'User';
    authUserName.textContent = `@${handle}`;

    // Display Ethos score + submission count
    const statsEl = document.getElementById('auth-profile-stats');
    if (statsEl) {
      const parts = [];
      if (profile?.ethos_score != null) {
        parts.push(`<span class="stat-label">Ethos:</span> <span class="stat-value stat-value--ethos">${profile.ethos_score}</span>`);
      }
      // Fetch submission count from activity feed data
      const subsResult = await sendMessage({
        type: 'scannr:get-recent-submissions',
        payload: { limit: 100 },
      });
      const subCount = subsResult?.submissions?.length || 0;
      parts.push(`<span class="stat-label">Submissions:</span> <span class="stat-value">${subCount}</span>`);
      statsEl.innerHTML = parts.join('<span style="color:#333;"> · </span>');
    }
  } else {
    authSignedOut.style.display = 'block';
    authSignedIn.style.display = 'none';
    signInBtn.textContent = 'Sign in with X';
    signInBtn.disabled = false;
  }
}

// -------------------------------------------------------------------------
// Wallet UI
// -------------------------------------------------------------------------

async function refreshWalletUI() {
  const walletSection = document.getElementById('wallet-section');
  const walletNotConnected = document.getElementById('wallet-not-connected');
  const walletConnected = document.getElementById('wallet-connected');
  const walletAddressEl = document.getElementById('wallet-address');
  const walletBalanceEl = document.getElementById('wallet-balance');

  // Only show wallet section if user is signed in
  const userResult = await sendMessage({ type: 'scannr:get-user' });
  if (!userResult?.user) {
    walletSection.style.display = 'none';
    return;
  }

  walletSection.style.display = 'block';

  const result = await sendMessage({ type: 'scannr:get-wallet' });
  const address = result?.address;

  if (address) {
    walletNotConnected.style.display = 'none';
    walletConnected.style.display = 'block';
    walletAddressEl.textContent = `${address.slice(0, 6)}...${address.slice(-4)}`;

    // Fetch balance async
    sendMessage({ type: 'scannr:get-wallet-balance' }).then((balResult) => {
      if (balResult?.balance != null) {
        const bal = parseFloat(balResult.balance);
        walletBalanceEl.textContent = `${bal.toFixed(2)} TRUST`;
      } else {
        walletBalanceEl.textContent = '';
      }
    });

    // Check if prefund failed due to treasury depletion
    chrome.storage.local.get('scannr_prefund_status').then((stored) => {
      if (stored.scannr_prefund_status === 'treasury_depleted') {
        let hint = document.getElementById('wallet-prefund-hint');
        if (!hint) {
          hint = document.createElement('div');
          hint.id = 'wallet-prefund-hint';
          hint.className = 'wallet-hint';
          hint.innerHTML = 'Free credits unavailable. Get TRUST at <a href="https://bridge.intuition.systems" target="_blank">bridge.intuition.systems</a>';
          walletConnected.appendChild(hint);
        }
      }
    });
  } else {
    walletNotConnected.style.display = 'block';
    walletConnected.style.display = 'none';
  }
}

// -------------------------------------------------------------------------
// Messaging
// -------------------------------------------------------------------------

function sendMessage(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        resolve(response || {});
      });
    } catch {
      resolve({});
    }
  });
}

// -------------------------------------------------------------------------
// Status Polling — refresh "Waiting for tweets..." while popup is open
// -------------------------------------------------------------------------

let statusPollTimer = null;

function startStatusPolling() {
  stopStatusPolling();
  statusPollTimer = setInterval(async () => {
    const status = await sendMessage({ type: 'scannr:get-status' });
    updateUIState(status?.enabled || false, status?.visibleUrls || 0);
  }, 3000);
}

function stopStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

// -------------------------------------------------------------------------
// Community Activity Feed
// -------------------------------------------------------------------------

async function loadActivityFeed() {
  const feed = document.getElementById('activity-feed');
  const result = await sendMessage({
    type: 'scannr:get-recent-submissions',
    payload: { limit: 20 },
  });

  if (result?.error === 'Not signed in') {
    feed.innerHTML = '<div class="activity-feed__empty">Sign in to see your activity</div>';
    return;
  }
  if (result?.error) {
    feed.innerHTML = '<div class="activity-feed__empty">Could not load activity</div>';
    return;
  }

  const submissions = result?.submissions || [];
  if (submissions.length === 0) {
    feed.innerHTML = '<div class="activity-feed__empty">No activity yet</div>';
    return;
  }

  feed.innerHTML = '';
  for (const sub of submissions) {
    const row = document.createElement('div');
    row.className = 'activity-row';

    const isFlag = sub.type === 'flag';
    const icon = isFlag ? '\uD83D\uDEA9' : '\u2713';
    const color = isFlag ? '#EF4444' : '#22C55E';
    const handle = extractHandle(sub.target_url);
    const action = isFlag ? 'Flagged' : 'Vouched';
    const category = sub.category ? ` as ${sub.category}` : '';
    const ago = timeAgo(sub.created_at);

    row.innerHTML = `
      <span class="activity-row__icon" style="color:${color}">${icon}</span>
      <div class="activity-row__content">
        <div class="activity-row__target">Tweet by <span class="activity-row__handle">${escapeHtml(handle)}</span></div>
        <div class="activity-row__meta"><span style="color:${color}">${action}${escapeHtml(category)}</span> <span class="activity-row__time">&middot; ${ago}</span></div>
      </div>
    `;

    feed.appendChild(row);
  }
}

function extractHandle(targetUrl) {
  if (!targetUrl) return 'unknown';
  try {
    const url = new URL(targetUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.length > 0 ? `@${parts[0]}` : 'unknown';
  } catch {
    // Not a URL — treat as handle
    return targetUrl.startsWith('@') ? targetUrl : `@${targetUrl}`;
  }
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
