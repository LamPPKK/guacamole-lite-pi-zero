'use strict';

const form = document.querySelector('#connection-form');
const protocolInput = document.querySelector('#protocol');
const portInput = document.querySelector('#port');
const hostnameInput = document.querySelector('#hostname');
const selfTargetInput = document.querySelector('#self-target');
const hostFieldLabel = document.querySelector('#host-field-label');
const hostPrefix = document.querySelector('#host-prefix');
const passwordInput = document.querySelector('#password');
const passwordToggle = document.querySelector('#toggle-password');
const display = document.querySelector('#display');
const emptyState = document.querySelector('#empty-state');
const statusBadge = document.querySelector('#status');
const statusText = document.querySelector('#status-text');
const gatewayStatus = document.querySelector('#gateway-status');
const gatewayLabel = document.querySelector('#gateway-label');
const accessLabel = document.querySelector('#access-label');
const accessRoute = document.querySelector('#access-route');
const accessFooter = document.querySelector('#access-footer');
const viewerRoute = document.querySelector('#viewer-route');
const connectButton = document.querySelector('#connect-button');
const connectLabel = document.querySelector('#connect-label');
const disconnectButton = document.querySelector('#disconnect');
const fullscreenButton = document.querySelector('#fullscreen');
const sessionTitle = document.querySelector('#session-title');
const sessionProtocol = document.querySelector('#session-protocol');
const viewportSize = document.querySelector('#viewport-size');
const guacamoleAvailable = typeof Guacamole !== 'undefined';

let client = null;
let connectionHadError = false;
let previousSshTarget = { hostname: '', port: '22' };
const keyboard = guacamoleAvailable ? new Guacamole.Keyboard(display) : null;

if (keyboard) {
  keyboard.onkeydown = (keysym) => {
    if (!client) return true;
    client.sendKeyEvent(1, keysym);
    return false;
  };
  keyboard.onkeyup = (keysym) => {
    if (!client) return true;
    client.sendKeyEvent(0, keysym);
    return false;
  };
}

function setStatus(text, state) {
  statusText.textContent = text;
  statusBadge.className = `status ${state}`;
}

function setGateway(text, state) {
  gatewayLabel.textContent = text;
  gatewayStatus.className = `gateway-state ${state}`;
}

function setBusy(busy) {
  connectButton.disabled = busy;
  connectButton.classList.toggle('busy', busy);
  connectLabel.textContent = busy ? 'Negotiating…' : 'Start session';
}

function updateProtocolFields() {
  const protocol = protocolInput.value;
  if (protocol !== 'ssh' && selfTargetInput.checked) {
    selfTargetInput.checked = false;
    updateSelfTarget();
  }
  document.querySelectorAll('.rdp-only').forEach((element) => {
    element.hidden = protocol !== 'rdp';
  });
  document.querySelectorAll('.ssh-only').forEach((element) => {
    element.hidden = protocol !== 'ssh';
  });
  portInput.value = { rdp: '3389', vnc: '5900', ssh: '22' }[protocol];
}

function updateSelfTarget() {
  const enabled = protocolInput.value === 'ssh' && selfTargetInput.checked;
  const wasEnabled = hostnameInput.readOnly;

  if (enabled) {
    if (!wasEnabled) {
      previousSshTarget = { hostname: hostnameInput.value, port: portInput.value || '22' };
    }
    hostnameInput.value = '127.0.0.1';
    portInput.value = '22';
  } else if (wasEnabled) {
    hostnameInput.value = previousSshTarget.hostname;
    portInput.value = previousSshTarget.port;
  }

  hostnameInput.readOnly = enabled;
  portInput.readOnly = enabled;
  hostFieldLabel.textContent = enabled ? 'This Pi address' : 'Private address';
  hostPrefix.textContent = enabled ? 'PI' : 'IP';
}

function setAccessMode(mode) {
  const vpn = mode === 'vpn';
  accessLabel.textContent = vpn ? 'VPN + BASIC AUTH' : 'SSH TUNNEL';
  accessRoute.textContent = vpn ? 'VPN IP' : 'LOOPBACK';
  accessFooter.textContent = vpn ? 'WEB ACCESS VIA VPN' : 'WEB ACCESS VIA SSH';
  viewerRoute.textContent = `${location.host || '127.0.0.1:8080'} · GUACD:4822`;
}

function updateViewportSize() {
  if (client) {
    const remoteDisplay = client.getDisplay();
    const width = remoteDisplay.getWidth();
    const height = remoteDisplay.getHeight();
    if (width && height) {
      viewportSize.textContent = `${width} × ${height}`;
      return;
    }
  }
  viewportSize.textContent = `${Math.max(0, display.clientWidth)} × ${Math.max(0, display.clientHeight)}`;
}

function scaleDisplay() {
  updateViewportSize();
  if (!client) return;
  const remoteDisplay = client.getDisplay();
  const width = remoteDisplay.getWidth();
  const height = remoteDisplay.getHeight();
  if (!width || !height) return;
  remoteDisplay.scale(Math.min(display.clientWidth / width, display.clientHeight / height));
}

function resetViewer() {
  display.replaceChildren(emptyState);
  emptyState.hidden = false;
  display.dataset.state = 'idle';
  disconnectButton.disabled = true;
  sessionTitle.textContent = 'Awaiting target';
  sessionProtocol.textContent = 'NO SESSION';
  updateViewportSize();
}

function disconnect() {
  const activeClient = client;
  client = null;
  activeClient?.disconnect();
  keyboard?.reset();
  connectionHadError = false;
  resetViewer();
  setBusy(false);
  setStatus('Disconnected', 'idle');
}

async function checkGateway() {
  if (location.protocol === 'file:') {
    setGateway('UI PREVIEW', 'preview');
    setAccessMode('ssh-tunnel');
    return;
  }
  try {
    const response = await fetch('/healthz', { cache: 'no-store' });
    const health = await response.json();
    if (!response.ok && response.status !== 503) throw new Error('gateway unavailable');
    setGateway(health.guacd ? 'GATEWAY ONLINE' : 'GUACD OFFLINE', health.guacd ? 'online' : 'error');
    setAccessMode(health.accessMode);
  } catch {
    setGateway('GATEWAY OFFLINE', 'error');
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.querySelector('.viewer-shell').requestFullscreen?.();
}

protocolInput.addEventListener('change', updateProtocolFields);
selfTargetInput.addEventListener('change', updateSelfTarget);
window.addEventListener('resize', scaleDisplay);
window.addEventListener('fullscreenchange', () => {
  fullscreenButton.setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen');
  scaleDisplay();
});

passwordToggle.addEventListener('click', () => {
  const reveal = passwordInput.type === 'password';
  passwordInput.type = reveal ? 'text' : 'password';
  passwordToggle.setAttribute('aria-pressed', String(reveal));
  passwordToggle.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
});

disconnectButton.addEventListener('click', disconnect);
fullscreenButton.addEventListener('click', toggleFullscreen);
display.addEventListener('pointerdown', () => display.focus());
window.addEventListener('keydown', (event) => {
  const displayFocused = document.activeElement === display || display.contains(document.activeElement);
  if (event.key === 'F11' && client && displayFocused) {
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleFullscreen();
  }
}, true);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkGateway();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!guacamoleAvailable || location.protocol === 'file:') {
    setStatus('Open through the configured gateway', 'error');
    setGateway('UI PREVIEW', 'preview');
    return;
  }

  disconnect();
  connectionHadError = false;
  setBusy(true);
  setStatus('Creating session', 'working');

  const values = Object.fromEntries(new FormData(form));
  values.self = selfTargetInput.checked && values.protocol === 'ssh';
  values.width = Math.max(640, Math.floor(display.clientWidth));
  values.height = Math.max(480, Math.floor(display.clientHeight));
  values.dpi = Math.round(96 * window.devicePixelRatio);

  try {
    const response = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Failed to create token');

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const tunnel = new Guacamole.WebSocketTunnel(`${scheme}://${location.host}/?token=${encodeURIComponent(result.token)}`);
    const sessionClient = new Guacamole.Client(tunnel);
    client = sessionClient;
    const remoteDisplay = sessionClient.getDisplay();
    emptyState.hidden = true;
    display.replaceChildren(remoteDisplay.getElement());
    display.dataset.state = 'connecting';
    sessionProtocol.textContent = values.protocol.toUpperCase();
    sessionTitle.textContent = values.self ? 'This Pi · 127.0.0.1:22' : `${values.hostname}:${values.port}`;
    remoteDisplay.onresize = scaleDisplay;

    sessionClient.onstatechange = (state) => {
      if (client !== sessionClient) return;
      if (state === Guacamole.Client.State.CONNECTING || state === Guacamole.Client.State.WAITING) {
        setStatus('Negotiating', 'working');
      } else if (state === Guacamole.Client.State.CONNECTED) {
        display.dataset.state = 'connected';
        setStatus('Connected', 'online');
        setBusy(false);
        disconnectButton.disabled = false;
        display.focus();
      } else if (state === Guacamole.Client.State.DISCONNECTED) {
        client = null;
        keyboard?.reset();
        resetViewer();
        setBusy(false);
        if (!connectionHadError) setStatus('Disconnected', 'idle');
      }
    };

    sessionClient.onerror = (status) => {
      if (client !== sessionClient) return;
      connectionHadError = true;
      setStatus(status.message || 'Connection failed', 'error');
      setBusy(false);
    };

    if (values.protocol !== 'ssh') {
      const mouse = new Guacamole.Mouse(remoteDisplay.getElement());
      mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (mouseState) => {
        if (client === sessionClient) sessionClient.sendMouseState(mouseState, true);
      };
      const touchscreen = new Guacamole.Mouse.Touchscreen(remoteDisplay.getElement());
      touchscreen.onmousedown = touchscreen.onmouseup = touchscreen.onmousemove = (mouseState) => {
        if (client === sessionClient) sessionClient.sendMouseState(mouseState, true);
      };
    }
    sessionClient.connect();
  } catch (error) {
    connectionHadError = true;
    resetViewer();
    setStatus(error.message, 'error');
    setBusy(false);
  }
});

updateProtocolFields();
updateViewportSize();
checkGateway();
setInterval(checkGateway, 30000);
