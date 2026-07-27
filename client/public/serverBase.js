// Where the PTZ server lives. '' means "same origin as this page" (true in
// plain local dev if you ever serve both from the same host/port). Persisted
// in localStorage so it survives reloads and works inside a Tauri webview,
// which has no server-side session to fall back on. Loaded before app.js and
// gamepad.js, both of which read window.getServerBase() for every API call.
(() => {
  'use strict';
  const KEY = 'ptzServerBase';

  function getServerBase() {
    return (localStorage.getItem(KEY) || '').replace(/\/+$/, '');
  }

  function setServerBase(value) {
    const trimmed = (value || '').trim().replace(/\/+$/, '');
    if (trimmed) localStorage.setItem(KEY, trimmed);
    else localStorage.removeItem(KEY);
  }

  window.getServerBase = getServerBase;
  window.setServerBase = setServerBase;
})();
