(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);

  async function api(path, { quiet = false } = {}) {
    try {
      const res = await fetch(getServerBase() + path);
      let data = null;
      try { data = await res.json(); } catch (_) { /* no body */ }
      if (!res.ok) {
        throw new Error((data && data.error) || `Request failed (${res.status})`);
      }
      return data;
    } catch (err) {
      if (!quiet) showToast(err.message || 'Something went wrong');
      throw err;
    }
  }

  let toastTimer = null;
  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.hidden = false;
    requestAnimationFrame(() => toast.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => { toast.hidden = true; }, 250);
    }, 2600);
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  let config = null;

  // ------------------------------------------------------------------
  // Status pill
  // ------------------------------------------------------------------

  async function checkStatus() {
    const pill = $('statusPill');
    try {
      const res = await fetch(getServerBase() + '/api/status');
      const data = await res.json();
      if (data.reachable) {
        pill.dataset.state = 'online';
        $('statusText').textContent = typeof data.latencyMs === 'number' ? `Online \u00b7 ${data.latencyMs}ms` : 'Online';
      } else if (data.reason === 'not-configured') {
        pill.dataset.state = 'checking';
        $('statusText').textContent = 'Not configured';
      } else {
        pill.dataset.state = 'offline';
        $('statusText').textContent = 'Offline';
      }
      return Boolean(data.reachable);
    } catch (_) {
      pill.dataset.state = 'offline';
      $('statusText').textContent = 'Offline';
      return false;
    }
  }

  function refreshStatus() { checkStatus(); }

  // ------------------------------------------------------------------
  // Live preview
  // ------------------------------------------------------------------

  let previewMode = 'none'; // 'mjpeg' | 'snapshot'
  let snapshotTimer = null;
  let watchdogTimer = null;
  let lastFrameAt = 0;
  let streamStartedAt = 0;

  function showTally(on) {
    $('tally').classList.toggle('on', on);
  }

  function hideEmptyState() {
    $('previewEmpty').style.display = 'none';
  }

  function showEmptyState(message) {
    const empty = $('previewEmpty');
    empty.style.display = 'flex';
    if (message) empty.querySelector('p').textContent = message;
  }

  function markFrameLoaded() {
    lastFrameAt = Date.now();
    showTally(true);
    hideEmptyState();
  }

  function stopSnapshotPolling() {
    if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
  }

  function startSnapshotPolling() {
    previewMode = 'snapshot';
    clearInterval(watchdogTimer);
    const img = $('previewImg');
    img.onload = markFrameLoaded;
    img.onerror = () => showTally(false);
    stopSnapshotPolling();
    const tick = () => { img.src = `${getServerBase()}/api/snapshot?t=${Date.now()}`; };
    tick();
    snapshotTimer = setInterval(tick, 800);
    $('previewCaption').textContent = 'Preview: snapshot refresh (install ffmpeg for smoother live video)';
  }

  function fallbackToSnapshot() {
    if (previewMode === 'snapshot') return;
    startSnapshotPolling();
  }

  function startMjpegStream() {
    previewMode = 'mjpeg';
    stopSnapshotPolling();
    lastFrameAt = 0;
    streamStartedAt = Date.now();
    const img = $('previewImg');
    img.onload = markFrameLoaded;
    img.onerror = () => fallbackToSnapshot();
    img.src = `${getServerBase()}/api/stream?_=${streamStartedAt}`;
    $('previewCaption').textContent = 'Preview: live (ffmpeg relay)';

    clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
      if (previewMode !== 'mjpeg') return;
      const stalled = lastFrameAt
        ? Date.now() - lastFrameAt > 8000
        : Date.now() - streamStartedAt > 6000;
      if (stalled) fallbackToSnapshot();
    }, 2000);
  }

  async function initPreview() {
    if (!config || !config.ip) {
      showEmptyState('No preview yet');
      $('previewCaption').textContent = '\u00a0';
      return;
    }
    try {
      const info = await api('/api/stream-info', { quiet: true });
      if (info && info.ffmpegAvailable) {
        startMjpegStream();
      } else {
        startSnapshotPolling();
      }
    } catch (_) {
      startSnapshotPolling();
    }
  }

  // ------------------------------------------------------------------
  // Pan / tilt d-pad
  // ------------------------------------------------------------------

  const activeDirections = new Set();

  function setDpadEngaged(on) {
    $('dpad').classList.toggle('engaged', on);
  }

  async function moveCamera(direction) {
    const panSpeed = $('panSpeed').value;
    const tiltSpeed = $('tiltSpeed').value;
    await api(`/api/ptz/move?direction=${direction}&panSpeed=${panSpeed}&tiltSpeed=${tiltSpeed}`, { quiet: true });
  }

  async function stopCamera() {
    await api('/api/ptz/stop', { quiet: true });
  }

  function wireDpad() {
    const buttons = document.querySelectorAll('.dpad-btn');
    buttons.forEach((btn) => {
      const direction = btn.dataset.direction;

      const start = (e) => {
        e.preventDefault();
        btn.setPointerCapture?.(e.pointerId);
        btn.classList.add('pressed');
        activeDirections.add(direction);
        setDpadEngaged(true);
        moveCamera(direction);
      };
      const end = (e) => {
        btn.classList.remove('pressed');
        activeDirections.delete(direction);
        if (activeDirections.size === 0) {
          setDpadEngaged(false);
          stopCamera();
        }
      };

      btn.addEventListener('pointerdown', start);
      btn.addEventListener('pointerup', end);
      btn.addEventListener('pointerleave', end);
      btn.addEventListener('pointercancel', end);
    });

    $('stopBtn').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      activeDirections.clear();
      buttons.forEach((b) => b.classList.remove('pressed'));
      setDpadEngaged(false);
      stopCamera();
    });
  }

  // ------------------------------------------------------------------
  // Zoom / focus rockers
  // ------------------------------------------------------------------

  function wireRocker(rockerId, dataAttr, startPath, stopPath, speedInputId) {
    const rocker = $(rockerId);
    rocker.querySelectorAll('.rocker-half').forEach((btn) => {
      const direction = btn.dataset[dataAttr];
      const start = (e) => {
        e.preventDefault();
        btn.setPointerCapture?.(e.pointerId);
        btn.classList.add('pressed');
        const speed = $(speedInputId).value;
        api(`${startPath}?direction=${direction}&speed=${speed}`, { quiet: true });
      };
      const end = () => {
        btn.classList.remove('pressed');
        api(stopPath, { quiet: true });
      };
      btn.addEventListener('pointerdown', start);
      btn.addEventListener('pointerup', end);
      btn.addEventListener('pointerleave', end);
      btn.addEventListener('pointercancel', end);
    });
  }

  function wireFocusLock() {
    const btn = $('focusLockBtn');
    let locked = false;
    btn.addEventListener('click', async () => {
      locked = !locked;
      btn.setAttribute('aria-pressed', String(locked));
      btn.textContent = locked ? 'Unlock focus' : 'Lock focus';
      try {
        await api(`/api/ptz/focus-lock?locked=${locked}`);
      } catch (_) {
        // revert on failure
        locked = !locked;
        btn.setAttribute('aria-pressed', String(locked));
        btn.textContent = locked ? 'Unlock focus' : 'Lock focus';
      }
    });
  }

  // ------------------------------------------------------------------
  // Sliders
  // ------------------------------------------------------------------

  function wireSlider(inputId, outputId, configKey) {
    const input = $(inputId);
    const output = $(outputId);
    input.addEventListener('input', () => { output.textContent = input.value; });
    input.addEventListener('change', async () => {
      const body = {};
      body[configKey] = Number(input.value);
      await postConfig(body, { quiet: true });
    });
  }

  async function postConfig(body, { quiet = false } = {}) {
    const res = await fetch(getServerBase() + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
      if (!quiet) showToast(data.error || 'Could not save settings');
      throw new Error(data.error || 'save failed');
    }
    config = data;
    return data;
  }

  // ------------------------------------------------------------------
  // Presets
  // ------------------------------------------------------------------

  function saveIconSvg() {
    return '<svg viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5V4Zm2 2v4h8V6H7Zm0 8v6h10v-6H7Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  }

  function thumbnailUrl(preset) {
    return `${getServerBase()}/api/presets/${preset.id}/thumbnail?v=${preset.thumbnailVersion}`;
  }

  function renderPresets(presets) {
    const grid = $('presetsGrid');
    grid.innerHTML = '';
    presets.forEach((preset) => {
      const card = document.createElement('div');
      card.className = 'preset-card';

      const thumb = document.createElement('img');
      thumb.className = 'preset-thumb';
      thumb.alt = '';
      if (preset.hasThumbnail) thumb.src = thumbnailUrl(preset);
      else thumb.classList.add('empty');
      thumb.onerror = () => thumb.classList.add('empty');

      const nameInput = document.createElement('input');
      nameInput.className = 'preset-name';
      nameInput.value = preset.label;
      nameInput.maxLength = 40;
      nameInput.addEventListener('change', async () => {
        try {
          await fetch(`${getServerBase()}/api/presets/${preset.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: nameInput.value })
          });
        } catch (_) { /* ignore */ }
      });

      const actions = document.createElement('div');
      actions.className = 'preset-actions';

      const goBtn = document.createElement('button');
      goBtn.className = 'preset-go';
      goBtn.type = 'button';
      goBtn.textContent = 'Go';
      goBtn.addEventListener('click', () => api(`/api/ptz/preset/recall?id=${preset.id}`));

      const saveBtn = document.createElement('button');
      saveBtn.className = 'preset-save';
      saveBtn.type = 'button';
      saveBtn.title = 'Save current position to this preset';
      saveBtn.innerHTML = saveIconSvg();
      saveBtn.addEventListener('click', async () => {
        await api(`/api/ptz/preset/save?id=${preset.id}`);
        thumb.classList.remove('empty');
        thumb.src = `${getServerBase()}/api/presets/${preset.id}/thumbnail?v=${Date.now()}`;
        showToast(`Saved current position to "${nameInput.value}"`);
      });

      actions.append(goBtn, saveBtn);
      card.append(thumb, nameInput, actions);
      grid.appendChild(card);
    });
  }

  async function loadPresets() {
    try {
      const presets = await api('/api/presets', { quiet: true });
      renderPresets(presets || []);
    } catch (_) { /* leave grid empty */ }
  }

  // ------------------------------------------------------------------
  // Camera discovery
  // ------------------------------------------------------------------
  // The camera's IP can change (DHCP), so every load re-scans the network
  // rather than trusting the saved address. If the camera we find matches
  // the MAC address we last used, we reconnect automatically; otherwise the
  // results are just listed in Settings for a one-click pick.

  let discoveredCameras = [];

  function setDiscoveryScanning() {
    const empty = $('discoveryEmpty');
    $('discoveryList').querySelectorAll('.discovery-item').forEach((el) => el.remove());
    empty.textContent = 'Scanning\u2026';
    empty.hidden = false;
  }

  function renderDiscoveries(list) {
    const container = $('discoveryList');
    const empty = $('discoveryEmpty');
    container.querySelectorAll('.discovery-item').forEach((el) => el.remove());

    if (!list.length) {
      empty.textContent = 'No cameras found on this network yet.';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    list
      .slice()
      .sort((a, b) => Number(b.knownDevice) - Number(a.knownDevice))
      .forEach((cam) => {
        const row = document.createElement('div');
        row.className = 'discovery-item';

        const info = document.createElement('div');
        info.className = 'discovery-info';
        const ipEl = document.createElement('span');
        ipEl.className = 'discovery-ip';
        ipEl.textContent = cam.ip;
        const metaEl = document.createElement('span');
        metaEl.className = 'discovery-meta';
        const bits = [];
        if (cam.deviceModel) bits.push(cam.deviceModel);
        else if (cam.devname) bits.push(cam.devname);
        bits.push(cam.sources.includes('onvif') && cam.sources.includes('http-scan') ? 'ONVIF + HTTP' : cam.sources.includes('onvif') ? 'ONVIF' : 'HTTP scan');
        if (cam.knownDevice) bits.push('previously used');
        metaEl.textContent = bits.join(' \u00b7 ');
        info.append(ipEl, metaEl);

        const useBtn = document.createElement('button');
        useBtn.type = 'button';
        useBtn.className = 'mini-btn';
        useBtn.textContent = 'Use';
        useBtn.addEventListener('click', () => useDiscoveredCamera(cam));

        row.append(info, useBtn);
        container.appendChild(row);
      });
  }

  async function useDiscoveredCamera(cam) {
    try {
      const body = { ip: cam.ip };
      if (cam.mac) body.knownMac = cam.mac;
      await postConfig(body);
      $('cfgIp').value = cam.ip;
      showToast(`Switched to ${cam.ip}`);
      closeSettings();
      checkStatus();
      initPreview();
      renderDiscoveries(discoveredCameras);
    } catch (_) { /* toasted already */ }
  }

  async function runDiscovery() {
    setDiscoveryScanning();
    try {
      const data = await api('/api/discover', { quiet: true });
      discoveredCameras = (data && data.cameras) || [];
    } catch (_) {
      discoveredCameras = [];
    }
    renderDiscoveries(discoveredCameras);
    return discoveredCameras;
  }

  // Runs on every load. If the camera we already know (by MAC) shows up at
  // a new address, switch to it with no clicks needed. Otherwise, if the
  // saved camera isn't responding, open Settings so the person can pick
  // from what was found.
  async function runDiscoveryAndMaybeReconnect(wasOnlineAtBoot) {
    const cameras = await runDiscovery();
    if (!config) return;

    const knownMac = config.knownMac;
    const match = knownMac && cameras.find((c) => c.mac && c.mac.toLowerCase() === knownMac.toLowerCase());
    let reconnected = false;

    if (match && match.ip !== config.ip) {
      try {
        await postConfig({ ip: match.ip, knownMac: match.mac }, { quiet: true });
        showToast(`Camera moved \u2014 reconnected at ${match.ip}`);
        await checkStatus();
        initPreview();
        renderDiscoveries(cameras);
        reconnected = true;
      } catch (_) { /* fall through to manual picker below */ }
    }

    if (!wasOnlineAtBoot && !reconnected && config.ip) {
      openSettings();
      $('settingsHint').className = 'field-hint error';
      $('settingsHint').textContent = 'Your saved camera isn\u2019t responding \u2014 pick one below if it\u2019s listed.';
    }
  }

  function wireDiscovery() {
    $('rescanBtn').addEventListener('click', runDiscovery);
  }

  // ------------------------------------------------------------------
  // Home / reset
  // ------------------------------------------------------------------

  function wireMiscButtons() {
    $('homeBtn').addEventListener('click', () => api('/api/ptz/home'));
    $('resetBtn').addEventListener('click', () => {
      const ok = window.confirm(
        'This runs the camera\u2019s pan/tilt recalibration routine \u2014 it will sweep through its full range of motion. Continue?'
      );
      if (ok) api('/api/ptz/reset');
    });
  }

  // ------------------------------------------------------------------
  // Settings overlay
  // ------------------------------------------------------------------

  function openSettings() {
    $('cfgServerBase').value = getServerBase();
    if (config) {
      $('cfgIp').value = config.ip || '';
      $('cfgHttpPort').value = config.httpPort || 80;
      $('cfgRtspPort').value = config.rtspPort || 554;
      $('cfgUsername').value = config.username || '';
      $('cfgPassword').value = '';
      $('cfgPassword').placeholder = config.hasPassword ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (unchanged)' : 'admin';
      $('cfgPreviewStream').value = String(config.previewStream || 2);
    }
    $('settingsHint').textContent = '\u00a0';
    $('settingsHint').className = 'field-hint';
    $('settingsOverlay').hidden = false;
  }

  function closeSettings() {
    $('settingsOverlay').hidden = true;
  }

  function readSettingsForm() {
    return {
      ip: $('cfgIp').value.trim(),
      httpPort: Number($('cfgHttpPort').value) || 80,
      rtspPort: Number($('cfgRtspPort').value) || 554,
      username: $('cfgUsername').value,
      password: $('cfgPassword').value,
      previewStream: Number($('cfgPreviewStream').value)
    };
  }

  function wireSettings() {
    $('settingsBtn').addEventListener('click', openSettings);
    $('closeSettingsBtn').addEventListener('click', closeSettings);
    $('settingsOverlay').addEventListener('click', (e) => {
      if (e.target === $('settingsOverlay')) closeSettings();
    });

    $('settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        setServerBase($('cfgServerBase').value);
        await postConfig(readSettingsForm());
        showToast('Camera settings saved');
        closeSettings();
        refreshStatus();
        initPreview();
        loadPresets();
      } catch (_) { /* toasted already */ }
    });

    $('testConnectionBtn').addEventListener('click', async () => {
      const hint = $('settingsHint');
      hint.className = 'field-hint';
      hint.textContent = 'Testing\u2026';
      try {
        setServerBase($('cfgServerBase').value);
        await postConfig(readSettingsForm(), { quiet: true });
        const res = await fetch(getServerBase() + '/api/status');
        const data = await res.json();
        if (data.reachable) {
          hint.className = 'field-hint success';
          hint.textContent = `Connected \u2014 responded in ${data.latencyMs}ms`;
        } else {
          hint.className = 'field-hint error';
          hint.textContent = `Couldn\u2019t reach the camera (${data.reason || 'unknown error'})`;
        }
        refreshStatus();
      } catch (err) {
        hint.className = 'field-hint error';
        hint.textContent = err.message || 'Could not save settings';
      }
    });
  }

  // ------------------------------------------------------------------
  // Keyboard shortcuts
  // ------------------------------------------------------------------

  const KEY_DIRECTIONS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right'
  };
  const heldKeys = new Set();

  function isTypingTarget(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
  }

  function wireKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (isTypingTarget(document.activeElement)) return;
      if (KEY_DIRECTIONS[e.key]) {
        e.preventDefault();
        if (!heldKeys.has(e.key)) {
          heldKeys.add(e.key);
          setDpadEngaged(true);
          moveCamera(KEY_DIRECTIONS[e.key]);
        }
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        api(`/api/ptz/zoom?direction=in&speed=${$('zoomSpeed').value}`, { quiet: true });
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        api(`/api/ptz/zoom?direction=out&speed=${$('zoomSpeed').value}`, { quiet: true });
      }
    });

    window.addEventListener('keyup', (e) => {
      if (KEY_DIRECTIONS[e.key]) {
        heldKeys.delete(e.key);
        if (heldKeys.size === 0) {
          setDpadEngaged(false);
          stopCamera();
        }
      } else if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
        api(`/api/ptz/zoom?direction=stop`, { quiet: true });
      }
    });
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  async function boot() {
    wireDpad();
    wireRocker('zoomRocker', 'zoom', '/api/ptz/zoom', '/api/ptz/zoom?direction=stop', 'zoomSpeed');
    wireRocker('focusRocker', 'focus', '/api/ptz/focus', '/api/ptz/focus?direction=stop', 'focusSpeed');
    wireFocusLock();
    wireMiscButtons();
    wireSettings();
    wireDiscovery();
    wireKeyboard();

    wireSlider('panSpeed', 'panSpeedOut', 'panSpeed');
    wireSlider('tiltSpeed', 'tiltSpeedOut', 'tiltSpeed');
    wireSlider('zoomSpeed', 'zoomSpeedOut', 'zoomSpeed');
    wireSlider('focusSpeed', 'focusSpeedOut', 'focusSpeed');

    try {
      config = await api('/api/config', { quiet: true });
      $('panSpeed').value = config.panSpeed; $('panSpeedOut').textContent = config.panSpeed;
      $('tiltSpeed').value = config.tiltSpeed; $('tiltSpeedOut').textContent = config.tiltSpeed;
      $('zoomSpeed').value = config.zoomSpeed; $('zoomSpeedOut').textContent = config.zoomSpeed;
      $('focusSpeed').value = config.focusSpeed; $('focusSpeedOut').textContent = config.focusSpeed;
    } catch (_) { /* defaults stay in the markup */ }

    if (!config || !config.ip) {
      openSettings();
      if (!getServerBase()) {
        $('settingsHint').className = 'field-hint';
        $('settingsHint').textContent = 'Enter the address of your PTZ server (e.g. http://192.168.1.20:4790), then Save.';
      }
    }

    loadPresets();
    initPreview();

    const wasOnlineAtBoot = await checkStatus();
    runDiscoveryAndMaybeReconnect(wasOnlineAtBoot);
    setInterval(refreshStatus, 6000);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
