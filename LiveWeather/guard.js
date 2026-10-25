/* SkyPulse start-up guard (loaded first). If anything throws before the first forecast is on screen, the location
 * gate shows the error — instead of a spinner that never ends — with Reload and "Clear saved data" buttons, and the
 * details to copy into a bug report. Errors after start-up are left to the app (its live feed reports them). */
(function () {
  'use strict';
  const starting = () => document.getElementById('app')?.getAttribute('aria-busy') === 'true';
  function show(where, message, stack) {
    if (!starting()) return;
    const gate = document.getElementById('gate'), box = document.getElementById('gateErr');
    if (!gate || !box) return;
    clearTimeout(window.__gateTimer);
    gate.hidden = false; gate.classList.remove('hide');
    document.getElementById('gateTitle').textContent = 'SkyPulse hit a problem while starting';
    document.getElementById('gateMsg').textContent = 'Try reloading. If it keeps happening, clear the saved data, or send the details below.';
    document.getElementById('gateSpinner')?.classList.add('off');
    document.getElementById('gateActions').hidden = true;
    document.getElementById('gateErrActions').hidden = false;
    box.hidden = false;
    box.textContent = `${where}: ${message || 'unknown error'}\n${String(stack || '').split('\n').slice(0, 6).join('\n')}\n\n${navigator.userAgent}`;
  }
  window.addEventListener('error', (e) => show('Start-up error', e.message, e.error && e.error.stack));
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason; show('Start-up error', r && r.message ? r.message : String(r), r && r.stack); });
  document.addEventListener('click', (e) => {
    if (e.target.closest('#gateReload')) location.reload();
    if (e.target.closest('#gateReset')) {
      try { Object.keys(localStorage).filter((k) => k.startsWith('skypulse.')).forEach((k) => localStorage.removeItem(k)); } catch { /* storage unavailable */ }
      location.reload();
    }
  });
  window.SkyGuard = { report: show };
})();
