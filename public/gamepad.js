// DualShock 4 (or any browser-standard gamepad) support, via the Gamepad API.
//
// Pairing happens at the OS level, not in the browser: put the DS4 into
// pairing mode (hold Share + PS until the light bar flashes rapidly), pair
// it in your computer's Bluetooth settings, then come back here and press
// any button on the controller — browsers only "see" a gamepad after it's
// received input at least once.
//
// Default mapping (assumes Chrome/Edge's "standard" gamepad layout, which is
// what DS4 reports almost everywhere):
//
//   Left stick        Pan / Tilt
//   Right stick (Y)   Focus far / near
//   R2 / L2           Zoom in / out
//   D-pad             Recall presets 1-4
//   Square            Recall preset 5
//   Cross (X)         Stop
//   Circle            Home
//   Triangle          Toggle focus lock
//   L1 / R1           Sensitivity down / up
//   Options           Open/close Settings
//
// This file is intentionally standalone — it talks to the same /api/ptz/*
// routes the on-screen controls use, so it doesn't need to reach into
// app.js at all.

(() => {
  'use strict';

  const DEAD_ZONE = 0.15;
  const TRIGGER_THRESHOLD = 0.08;
  const SEND_INTERVAL_MS = 120; // throttle: don't re-send faster than ~8/sec
  const SENSITIVITY_STEP = 0.1;
  const SENSITIVITY_MIN = 0.3;
  const SENSITIVITY_MAX = 1.0;

  let sensitivity = 1.0;
  let rafId = null;
  let connectedIndex = null;
  let prevButtons = [];

  let lastMove = { direction: null, panSpeed: 0, tiltSpeed: 0, at: 0 };
  let lastZoom = { direction: null, speed: 0, at: 0 };
  let lastFocus = { direction: null, speed: 0, at: 0 };
  let focusLocked = false;

  const $ = (id) => document.getElementById(id);

  function fireAndForget(path) {
    fetch(path).catch(() => {});
  }

  function setStatus(connected, label, mappingWarning) {
    const el = $('padStatus');
    const strip = $('padStrip');
    if (!el || !strip) return;
    strip.dataset.state = connected ? 'connected' : 'disconnected';
    if (!connected) {
      el.textContent = 'No controller \u2014 pair via Bluetooth, then press any button';
    } else {
      el.textContent = mappingWarning
        ? `${label} connected (non-standard mapping \u2014 buttons may not line up)`
        : `${label} connected`;
    }
  }

  function setSensitivityReadout() {
    const el = $('padSensitivity');
    if (el) el.textContent = `${Math.round(sensitivity * 100)}%`;
  }

  function applyDeadZone(v) {
    return Math.abs(v) < DEAD_ZONE ? 0 : v;
  }

  function directionFromAxes(x, y) {
    // Gamepad Y axis is inverted: -1 is up, +1 is down.
    const left = x < -DEAD_ZONE, right = x > DEAD_ZONE;
    const up = y < -DEAD_ZONE, down = y > DEAD_ZONE;
    if (up && left) return 'leftup';
    if (up && right) return 'rightup';
    if (down && left) return 'leftdown';
    if (down && right) return 'rightdown';
    if (up) return 'up';
    if (down) return 'down';
    if (left) return 'left';
    if (right) return 'right';
    return null;
  }

  function scaleSpeed(value, max) {
    const magnitude = Math.min(1, Math.abs(value)) * sensitivity;
    return Math.max(1, Math.round(magnitude * max));
  }

  function isSettingsOpen() {
    const overlay = $('settingsOverlay');
    return overlay ? !overlay.hidden : false;
  }

  function pollMove(gp) {
    const x = applyDeadZone(gp.axes[0] || 0);
    const y = applyDeadZone(gp.axes[1] || 0);
    const direction = directionFromAxes(x, y);
    const now = performance.now();

    if (!direction) {
      if (lastMove.direction) {
        fireAndForget('/api/ptz/stop');
        lastMove = { direction: null, panSpeed: 0, tiltSpeed: 0, at: now };
      }
      return;
    }

    const panSpeed = scaleSpeed(x, 24);
    const tiltSpeed = scaleSpeed(y, 20);
    const changed = direction !== lastMove.direction ||
      Math.abs(panSpeed - lastMove.panSpeed) >= 2 ||
      Math.abs(tiltSpeed - lastMove.tiltSpeed) >= 2;

    if (changed || now - lastMove.at > SEND_INTERVAL_MS) {
      fireAndForget(`/api/ptz/move?direction=${direction}&panSpeed=${panSpeed}&tiltSpeed=${tiltSpeed}`);
      lastMove = { direction, panSpeed, tiltSpeed, at: now };
    }
  }

  function pollZoom(gp) {
    const inVal = gp.buttons[7] ? gp.buttons[7].value : 0; // R2
    const outVal = gp.buttons[6] ? gp.buttons[6].value : 0; // L2
    const now = performance.now();

    let direction = null;
    let raw = 0;
    if (inVal > TRIGGER_THRESHOLD && inVal >= outVal) { direction = 'in'; raw = inVal; }
    else if (outVal > TRIGGER_THRESHOLD) { direction = 'out'; raw = outVal; }

    if (!direction) {
      if (lastZoom.direction) {
        fireAndForget('/api/ptz/zoom?direction=stop');
        lastZoom = { direction: null, speed: 0, at: now };
      }
      return;
    }

    const speed = scaleSpeed(raw, 7);
    const changed = direction !== lastZoom.direction || Math.abs(speed - lastZoom.speed) >= 1;

    if (changed || now - lastZoom.at > SEND_INTERVAL_MS) {
      fireAndForget(`/api/ptz/zoom?direction=${direction}&speed=${speed}`);
      lastZoom = { direction, speed, at: now };
    }
  }

  function pollFocus(gp) {
    const y = applyDeadZone(gp.axes[3] || 0); // right stick, vertical
    const now = performance.now();
    const direction = y < 0 ? 'in' : y > 0 ? 'out' : null; // 'in' == Far, 'out' == Near (matches the on-screen rocker)

    if (!direction) {
      if (lastFocus.direction) {
        fireAndForget('/api/ptz/focus?direction=stop');
        lastFocus = { direction: null, speed: 0, at: now };
      }
      return;
    }

    const speed = scaleSpeed(y, 7);
    const changed = direction !== lastFocus.direction || Math.abs(speed - lastFocus.speed) >= 1;

    if (changed || now - lastFocus.at > SEND_INTERVAL_MS) {
      fireAndForget(`/api/ptz/focus?direction=${direction}&speed=${speed}`);
      lastFocus = { direction, speed, at: now };
    }
  }

  function toggleFocusLock() {
    focusLocked = !focusLocked;
    fireAndForget(`/api/ptz/focus-lock?locked=${focusLocked}`);
    const btn = $('focusLockBtn');
    if (btn) {
      btn.setAttribute('aria-pressed', String(focusLocked));
      btn.textContent = focusLocked ? 'Unlock focus' : 'Lock focus';
    }
  }

  function adjustSensitivity(delta) {
    sensitivity = Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, +(sensitivity + delta).toFixed(2)));
    setSensitivityReadout();
  }

  function pollButtons(gp, settingsOpen) {
    const pressed = gp.buttons.map((b) => b.pressed);
    const justPressed = (i) => pressed[i] && !prevButtons[i];

    // Options always toggles Settings, whether it's open or closed.
    if (justPressed(9)) {
      $(isSettingsOpen() ? 'closeSettingsBtn' : 'settingsBtn')?.click();
    }

    if (!settingsOpen) {
      if (justPressed(0)) fireAndForget('/api/ptz/stop'); // Cross
      if (justPressed(1)) fireAndForget('/api/ptz/home'); // Circle
      if (justPressed(3)) toggleFocusLock(); // Triangle
      if (justPressed(2)) fireAndForget('/api/ptz/preset/recall?id=5'); // Square
      if (justPressed(12)) fireAndForget('/api/ptz/preset/recall?id=1'); // D-pad up
      if (justPressed(13)) fireAndForget('/api/ptz/preset/recall?id=2'); // D-pad down
      if (justPressed(14)) fireAndForget('/api/ptz/preset/recall?id=3'); // D-pad left
      if (justPressed(15)) fireAndForget('/api/ptz/preset/recall?id=4'); // D-pad right
      if (justPressed(4)) adjustSensitivity(-SENSITIVITY_STEP); // L1
      if (justPressed(5)) adjustSensitivity(SENSITIVITY_STEP); // R1
    }

    prevButtons = pressed;
  }

  function loop() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = connectedIndex !== null ? pads[connectedIndex] : null;
    if (gp) {
      const settingsOpen = isSettingsOpen();
      if (!settingsOpen) {
        pollMove(gp);
        pollZoom(gp);
        pollFocus(gp);
      }
      pollButtons(gp, settingsOpen);
    }
    rafId = requestAnimationFrame(loop);
  }

  window.addEventListener('gamepadconnected', (e) => {
    connectedIndex = e.gamepad.index;
    prevButtons = e.gamepad.buttons.map(() => false);
    setStatus(true, e.gamepad.id || 'Controller', e.gamepad.mapping !== 'standard');
    if (!rafId) rafId = requestAnimationFrame(loop);
  });

  window.addEventListener('gamepaddisconnected', (e) => {
    if (e.gamepad.index === connectedIndex) {
      connectedIndex = null;
      setStatus(false);
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      lastMove = { direction: null, panSpeed: 0, tiltSpeed: 0, at: 0 };
      lastZoom = { direction: null, speed: 0, at: 0 };
      lastFocus = { direction: null, speed: 0, at: 0 };
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    setStatus(false);
    setSensitivityReadout();
  });
})();
