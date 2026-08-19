'use strict';

const form = document.querySelector('#connection-form');
const protocolInput = document.querySelector('#protocol');
const portInput = document.querySelector('#port');
const passwordInput = document.querySelector('#password');
const passwordToggle = document.querySelector('#toggle-password');
const display = document.querySelector('#display');
const emptyState = document.querySelector('#empty-state');
const statusBadge = document.querySelector('#status');
const statusText = document.querySelector('#status-text');
const gatewayStatus = document.querySelector('#gateway-status');
const gatewayLabel = document.querySelector('#gateway-label');
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
  connectLabel.textContent = busy ? 'Đang bắt tay…' : 'Khởi tạo phiên';
}

function updateProtocolFields() {
  const rdp = protocolInput.value === 'rdp';
  document.querySelectorAll('.rdp-only').forEach((element) => {
    element.hidden = !rdp;
  });
  portInput.value = rdp ? '3389' : '5900';
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
  sessionTitle.textContent = 'Chờ máy đích';
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
  setStatus('Đã ngắt', 'idle');
}

async function checkGateway() {
  if (location.protocol === 'file:') {
    setGateway('UI PREVIEW', 'preview');
    return;
  }
  try {
    const response = await fetch('/healthz', { cache: 'no-store' });
    if (!response.ok) throw new Error('gateway unavailable');
    const health = await response.json();
    setGateway(health.guacd ? 'GATEWAY ONLINE' : 'GUACD OFFLINE', health.guacd ? 'online' : 'error');
  } catch {
    setGateway('GATEWAY OFFLINE', 'error');
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.querySelector('.viewer-shell').requestFullscreen?.();
}

protocolInput.addEventListener('change', updateProtocolFields);
window.addEventListener('resize', scaleDisplay);
window.addEventListener('fullscreenchange', () => {
  fullscreenButton.setAttribute('aria-label', document.fullscreenElement ? 'Thoát toàn màn hình' : 'Mở toàn màn hình');
  scaleDisplay();
});

passwordToggle.addEventListener('click', () => {
  const reveal = passwordInput.type === 'password';
  passwordInput.type = reveal ? 'text' : 'password';
  passwordToggle.setAttribute('aria-pressed', String(reveal));
  passwordToggle.setAttribute('aria-label', reveal ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
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
    setStatus('Mở qua SSH tunnel', 'error');
    setGateway('UI PREVIEW', 'preview');
    return;
  }

  disconnect();
  connectionHadError = false;
  setBusy(true);
  setStatus('Đang tạo phiên', 'working');

  const values = Object.fromEntries(new FormData(form));
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
    if (!response.ok) throw new Error(result.error || 'Không tạo được token');

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const tunnel = new Guacamole.WebSocketTunnel(`${scheme}://${location.host}/?token=${encodeURIComponent(result.token)}`);
    const sessionClient = new Guacamole.Client(tunnel);
    client = sessionClient;
    const remoteDisplay = sessionClient.getDisplay();
    emptyState.hidden = true;
    display.replaceChildren(remoteDisplay.getElement());
    display.dataset.state = 'connecting';
    sessionProtocol.textContent = values.protocol.toUpperCase();
    sessionTitle.textContent = `${values.hostname}:${values.port}`;
    remoteDisplay.onresize = scaleDisplay;

    sessionClient.onstatechange = (state) => {
      if (client !== sessionClient) return;
      if (state === Guacamole.Client.State.CONNECTING || state === Guacamole.Client.State.WAITING) {
        setStatus('Đang bắt tay', 'working');
      } else if (state === Guacamole.Client.State.CONNECTED) {
        display.dataset.state = 'connected';
        setStatus('Đã kết nối', 'online');
        setBusy(false);
        disconnectButton.disabled = false;
        display.focus();
      } else if (state === Guacamole.Client.State.DISCONNECTED) {
        client = null;
        keyboard?.reset();
        resetViewer();
        setBusy(false);
        if (!connectionHadError) setStatus('Đã ngắt', 'idle');
      }
    };

    sessionClient.onerror = (status) => {
      if (client !== sessionClient) return;
      connectionHadError = true;
      setStatus(status.message || 'Kết nối lỗi', 'error');
      setBusy(false);
    };

    const mouse = new Guacamole.Mouse(remoteDisplay.getElement());
    mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (mouseState) => {
      if (client === sessionClient) sessionClient.sendMouseState(mouseState, true);
    };
    const touchscreen = new Guacamole.Mouse.Touchscreen(remoteDisplay.getElement());
    touchscreen.onmousedown = touchscreen.onmouseup = touchscreen.onmousemove = (mouseState) => {
      if (client === sessionClient) sessionClient.sendMouseState(mouseState, true);
    };
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
