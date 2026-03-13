/**
 * Scannr — Popup Script
 *
 * Controls the extension popup UI:
 *   - Master toggle (TL Protection on/off)
 *   - Provider status cards with health indicators
 *   - Weight tuning sliders
 *   - Scanned tweet count
 */

const PROVIDERS = ['ethos', 'community', 'prints'];

const PROVIDER_DESCRIPTIONS = {
  ethos: 'Vouch-based reputation scores (0\u20132800)',
  community: 'Community flags & vouches',
  prints: 'Composable reputation aggregation (coming soon)',
};

// -------------------------------------------------------------------------
// DOM References
// -------------------------------------------------------------------------

const masterToggle = document.getElementById('master-toggle');
const providerList = document.getElementById('provider-list');
const weightsSection = document.getElementById('weights-section');
const weightSliders = document.getElementById('weight-sliders');
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

  // Load persisted provider toggle states
  const providerStates = await loadProviderStates();

  // Provider cards
  renderProviders(status?.providerHealth || {}, providerStates);

  // Health check (async, update when ready)
  sendMessage({ type: 'scannr:health-check' }).then((health) => {
    if (health?.health) renderProviders(health.health, providerStates);
  });

  // Weight sliders — load persisted weights
  const persistedWeights = await loadPersistedWeights();
  renderWeightSliders(persistedWeights);

  // Auth state
  await refreshAuthUI();

  signInBtn.addEventListener('click', async () => {
    signInBtn.disabled = true;
    signInBtn.textContent = 'Signing in...';
    const result = await sendMessage({ type: 'scannr:sign-in' });
    if (result?.error) {
      signInBtn.textContent = 'Sign in with X';
      signInBtn.disabled = false;
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
});

async function loadProviderStates() {
  const states = {};
  for (const name of PROVIDERS) {
    try {
      const result = await chrome.storage.local.get(`scannr_provider_${name}`);
      states[name] = result[`scannr_provider_${name}`];
    } catch { /* ignore */ }
  }
  return states;
}

async function loadPersistedWeights() {
  const weights = {};
  for (const name of PROVIDERS) {
    try {
      const result = await chrome.storage.local.get(`scannr_weight_${name}`);
      if (typeof result[`scannr_weight_${name}`] === 'number') {
        weights[name] = result[`scannr_weight_${name}`];
      }
    } catch { /* ignore */ }
  }
  return weights;
}

// -------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------

function renderProviders(healthMap, providerStates = {}) {
  providerList.innerHTML = '';

  for (const name of PROVIDERS) {
    const card = document.createElement('div');
    card.className = 'provider-card';

    const isHealthy = healthMap[name] === true;
    const isPrints = name === 'prints';

    // Determine checked state: use persisted state if available, else default
    const isChecked = isPrints ? false : (providerStates[name] !== undefined ? providerStates[name] : true);

    const statusClass = isPrints
      ? 'provider-card__status--disabled'
      : isHealthy
        ? 'provider-card__status--online'
        : 'provider-card__status--offline';

    const statusLabel = isPrints ? 'Coming soon' : isHealthy ? 'Online' : 'Offline';
    const description = PROVIDER_DESCRIPTIONS[name] || '';

    card.innerHTML = `
      <div class="provider-card__info">
        <div class="provider-card__status ${statusClass}" title="${statusLabel}"></div>
        <div>
          <span class="provider-card__name">${name}</span>
          <div class="provider-card__desc">${description}</div>
        </div>
      </div>
      <div class="provider-card__toggle">
        <label class="switch" style="width:36px;height:20px;">
          <input type="checkbox" data-provider="${name}" ${isChecked ? 'checked' : ''} ${isPrints ? 'disabled' : ''}>
          <span class="slider" style="border-radius:20px;"></span>
        </label>
      </div>
    `;

    // Fix slider knob size for smaller toggle
    const slider = card.querySelector('.slider');
    if (slider) {
      slider.style.setProperty('--knob-size', '14px');
    }

    const toggle = card.querySelector('input[type="checkbox"]');
    if (toggle && !isPrints) {
      toggle.addEventListener('change', () => {
        sendMessage({
          type: 'scannr:set-provider',
          payload: { name, enabled: toggle.checked },
        });
      });
    }

    providerList.appendChild(card);
  }
}

function renderWeightSliders(persistedWeights = {}) {
  weightSliders.innerHTML = '';

  const defaultWeights = { ethos: 0.40, community: 0.50, prints: 0.10 };

  for (const name of PROVIDERS) {
    const weight = persistedWeights[name] ?? defaultWeights[name] ?? 0;

    const row = document.createElement('div');
    row.className = 'weight-row';
    row.innerHTML = `
      <div class="weight-row__header">
        <span class="weight-row__label">${name}</span>
        <span class="weight-row__value" id="weight-val-${name}">${Math.round(weight * 100)}%</span>
      </div>
      <input type="range" min="0" max="100" value="${Math.round(weight * 100)}" data-provider="${name}">
    `;

    const slider = row.querySelector('input[type="range"]');
    const valueDisplay = row.querySelector(`#weight-val-${name}`);

    slider.addEventListener('input', () => {
      valueDisplay.textContent = `${slider.value}%`;
    });

    slider.addEventListener('change', () => {
      sendMessage({
        type: 'scannr:set-weight',
        payload: { name, weight: parseInt(slider.value) / 100 },
      });
    });

    weightSliders.appendChild(row);
  }
}

function updateUIState(enabled, tweetCount = 0) {
  weightsSection.style.display = enabled ? 'block' : 'none';

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
    // Use X handle from user_metadata, fallback to email
    const handle = user.user_metadata?.preferred_username
      || user.user_metadata?.user_name
      || user.email
      || 'User';
    authUserName.textContent = `@${handle}`;
  } else {
    authSignedOut.style.display = 'block';
    authSignedIn.style.display = 'none';
    signInBtn.textContent = 'Sign in with X';
    signInBtn.disabled = false;
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
