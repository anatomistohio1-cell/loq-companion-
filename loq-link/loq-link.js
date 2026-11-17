const SESSION_KEY = 'nerv-loq-session-token';
const getElement = (id) => document.getElementById(id);
let refreshInProgress = false;

const setStatus = (connected, message) => {
  const badge = getElement('loqLinkStatus');
  if (badge) {
    badge.textContent = connected ? 'CONNECTED' : 'DISCONNECTED';
    badge.classList.toggle('green', connected);
    badge.classList.toggle('muted', !connected);
  }
  const messageNode = getElement('loqLinkMessage');
  if (messageNode) messageNode.textContent = message;
};

const clearMetrics = () => {
  ['loqLinkDeviceName', 'loqLinkCpu', 'loqLinkMemory', 'loqLinkBattery'].forEach((id) => {
    const node = getElement(id);
    if (node) node.textContent = '—';
  });
  const endpoints = getElement('loqLinkEndpoints');
  const count = getElement('loqLinkOutputCount');
  if (endpoints) endpoints.replaceChildren();
  if (count) count.textContent = 'Not connected';
};

const request = async (path, body = {}) => {
  const token = sessionStorage.getItem(SESSION_KEY);
  if (!token) throw new Error('Pair this laptop first.');
  const response = await fetch('/.netlify/functions/loq-command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: token, path, body }),
    signal: AbortSignal.timeout(15_000),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`LOQ Link returned an invalid response (${response.status}).`);
  }
  if (!response.ok) {
    if (response.status === 401) sessionStorage.removeItem(SESSION_KEY);
    throw new Error(result.detail || `LOQ Link returned ${response.status}.`);
  }
  return result;
};

const renderEndpoints = (devices) => {
  const list = getElement('loqLinkEndpoints');
  const count = getElement('loqLinkOutputCount');
  if (!list) return;
  list.replaceChildren();
  if (count) count.textContent = `${devices.length} Windows endpoint${devices.length === 1 ? '' : 's'}`;

  devices.forEach((device) => {
    const card = document.createElement('article');
    card.className = 'audio-endpoint-card';
    const heading = document.createElement('div');
    heading.className = 'audio-endpoint-heading';
    const name = document.createElement('strong');
    name.textContent = device.name;
    const state = document.createElement('span');
    state.className = `inline-status ${device.state === 'active' ? 'green' : 'muted'}`;
    state.textContent = device.state;
    heading.append(name, state);
    card.append(heading);

    const description = document.createElement('p');
    description.className = 'source-note';
    const roles = [
      device.is_default_console || device.is_default_multimedia ? 'Default output' : '',
      device.form_factor || 'Windows audio endpoint',
      device.current_shared_mix_format
        ? `${device.current_shared_mix_format.sample_rate_hz} Hz · ${device.current_shared_mix_format.channels} ch`
        : '',
    ].filter(Boolean);
    description.textContent = roles.join(' · ');
    card.append(description);

    if (device.state === 'active' && !device.is_default_multimedia) {
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.className = 'control-button';
      choose.textContent = 'Set Windows default';
      choose.addEventListener('click', async () => {
        choose.disabled = true;
        try {
          await request('/audio/default', { endpoint_id: device.id });
          await refresh();
        } catch (error) {
          setStatus(false, error.message);
        } finally {
          choose.disabled = false;
        }
      });
      card.append(choose);
    }

    if (device.state === 'active' && device.volume_supported) {
      const controls = document.createElement('div');
      controls.className = 'audio-endpoint-controls';
      const volume = document.createElement('input');
      volume.type = 'range';
      volume.min = '0';
      volume.max = '100';
      volume.step = '1';
      volume.value = String(device.volume_percent);
      volume.setAttribute('aria-label', `${device.name} volume`);
      volume.addEventListener('change', async () => {
        try {
          await request('/audio/volume', {
            endpoint_id: device.id,
            volume_percent: Number(volume.value),
          });
        } catch (error) {
          setStatus(false, error.message);
        }
      });
      const mute = document.createElement('button');
      mute.type = 'button';
      mute.className = 'control-button alt';
      mute.textContent = device.muted ? 'Unmute' : 'Mute';
      mute.addEventListener('click', async () => {
        try {
          await request('/audio/mute', { endpoint_id: device.id, muted: !device.muted });
          await refresh();
        } catch (error) {
          setStatus(false, error.message);
        }
      });
      controls.append(volume, mute);
      card.append(controls);
    }
    list.append(card);
  });
};

const refresh = async () => {
  if (refreshInProgress) return;
  if (!sessionStorage.getItem(SESSION_KEY)) {
    clearMetrics();
    setStatus(false, 'Not paired. Start LOQ Link on Windows and enter its pairing code.');
    return;
  }
  refreshInProgress = true;
  try {
    const [metrics, endpoints] = await Promise.all([
      request('/metrics'),
      request('/audio/devices'),
    ]);
    getElement('loqLinkDeviceName').textContent = metrics.device_name || 'Windows host';
    getElement('loqLinkCpu').textContent = metrics.cpu_percent == null ? '—' : `${Math.round(metrics.cpu_percent)}%`;
    getElement('loqLinkMemory').textContent = metrics.memory_percent == null ? '—' : `${Math.round(metrics.memory_percent)}%`;
    getElement('loqLinkBattery').textContent = metrics.battery_percent == null ? 'Not available' : `${Math.round(metrics.battery_percent)}%`;
    renderEndpoints(Array.isArray(endpoints.devices) ? endpoints.devices : []);
    setStatus(true, `Connected to ${metrics.device_name || 'Windows host'} through the authenticated cloud relay.`);
  } catch (error) {
    setStatus(false, error.message);
    if (!sessionStorage.getItem(SESSION_KEY)) clearMetrics();
  } finally {
    refreshInProgress = false;
  }
};

getElement('loqLinkPairForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = getElement('loqLinkPairingCode');
  const button = getElement('loqLinkPairButton');
  button.disabled = true;
  setStatus(false, 'Pairing through the secure relay…');
  try {
    const response = await fetch('/.netlify/functions/pair-loq', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairing_code: code.value }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || `Pairing failed (${response.status}).`);
    sessionStorage.setItem(SESSION_KEY, result.access_token);
    code.value = '';
    setStatus(true, 'Laptop paired. Loading actual Windows telemetry and audio endpoints…');
    await refresh();
  } catch (error) {
    setStatus(false, error.message || 'Unable to reach the LOQ relay.');
  } finally {
    code.value = '';
    button.disabled = false;
  }
});

getElement('loqLinkDisconnectButton').addEventListener('click', async () => {
  try {
    if (sessionStorage.getItem(SESSION_KEY)) await request('/disconnect');
  } catch (error) {
    console.warn('LOQ relay session revocation failed:', error);
  }
  sessionStorage.removeItem(SESSION_KEY);
  clearMetrics();
  setStatus(false, 'Disconnected from this laptop.');
});

getElement('loqLinkRefreshButton').addEventListener('click', () => void refresh());
const deckLink = getElement('nervDeckLink');
if (deckLink && window.NERV_DEPLOYMENT_CONFIG?.deckUrl) {
  deckLink.href = window.NERV_DEPLOYMENT_CONFIG.deckUrl;
  deckLink.target = '_blank';
  deckLink.rel = 'noopener noreferrer';
}

void refresh();
window.setInterval(() => {
  if (document.visibilityState === 'visible') void refresh();
}, 10_000);
