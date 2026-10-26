/* SkyPulse settings: one validated preferences object in localStorage, the look (theme, accent, density),
 * a small layout engine that packs the visible sections into the desktop grid in the user's order, and the
 * settings sheet. Exposes window.Prefs and window.Layout.
 */
(function () {
  'use strict';
  const KEY = 'skypulse.settings';

  /* ------------------------------------------------------------ catalogue */
  const SECTIONS = [
    ['hero', 'Current conditions', 'Now'],
    ['pulse', 'Pulse Advisor', 'Now'],
    ['warn', 'Warnings', 'Now · Alerts'],
    ['tiles', 'Detail tiles', 'Now'],
    ['q15', 'Next 6 hours (15-minute steps)', 'Forecast'],
    ['chart', 'Past · present · future chart', 'Forecast'],
    ['feed', 'Live feed', 'Feed'],
    ['hourly', 'Next 24 hours', 'Forecast'],
    ['daily', '8-day forecast', 'Forecast'],
    ['past', 'Looking back', 'Forecast'],
    ['storms', 'Cyclone tracker', 'Storms'],
    ['sun', 'Sun tracker', 'Sun'],
  ].map(([id, label, tab]) => ({ id, label, tab }));
  const DEFAULT_ORDER = SECTIONS.map((s) => s.id);
  const TILES = [['feels', 'Feels like'], ['hum', 'Humidity'], ['dew', 'Dew point'], ['cloud', 'Cloud cover'], ['sky', 'Sky colour'], ['wind', 'Wind'], ['press', 'Pressure'],
    ['rain', 'Rain · next 24 h'], ['nowcast', 'Nowcast · 2 h'], ['uv', 'UV index'], ['vis', 'Visibility'], ['aqi', 'Air quality'], ['moon', 'Moon']];
  const ACCENTS = [['#7cc4ff', 'Sky'], ['#4fd1c5', 'Teal'], ['#b39bff', 'Violet'], ['#ffb84d', 'Amber'], ['#ff7aa8', 'Rose'], ['#8fdc5a', 'Lime']];
  const LAYERS = [['cone', 'Cones'], ['track', 'Forecast track'], ['past', 'Past track'], ['radii', 'Wind radii'], ['labels', 'Labels']];

  const OPT = {
    temp: [['C', '°C'], ['F', '°F']],
    wind: [['kmh', 'km/h'], ['mph', 'mph'], ['ms', 'm/s'], ['kn', 'knots']],
    precip: [['mm', 'mm'], ['in', 'inches']],
    pressure: [['hPa', 'hPa'], ['inHg', 'inHg'], ['mmHg', 'mmHg']],
    dist: [['km', 'km'], ['mi', 'miles']],
    clock: [['auto', 'Auto'], ['12', '12-hour'], ['24', '24-hour']],
    theme: [['dynamic', 'Live sky'], ['night', 'Night'], ['oled', 'Black'], ['contrast', 'High contrast']],
    density: [['comfortable', 'Comfortable'], ['compact', 'Compact']],
    effects: [['full', 'Full'], ['lite', 'Lite'], ['off', 'Off']],
    defaultTab: [['last', 'Last used'], ['now', 'Now'], ['forecast', 'Forecast'], ['alerts', 'Alerts'], ['storms', 'Storms'], ['sun', 'Sun'], ['feed', 'Feed']],
    profile: [['standard', 'Standard'], ['sensitive', 'Sensitive'], ['hardy', 'Hardy']],
    pulseWin: [[1, '1 h'], [3, '3 h'], [6, '6 h'], [12, '12 h'], [24, '24 h']],
    min15: [['auto', 'Auto (US & Europe)'], ['off', 'Off']],
    cacheMin: [[15, '15 min'], [20, '20 min'], [30, '30 min'], [0, 'Off']],
    locLaunch: [['saved', 'Saved location'], ['gps', 'Ask for GPS']],
  };
  const DEFAULTS = {
    temp: 'C', wind: 'kmh', precip: 'mm', pressure: 'hPa', dist: 'km', clock: 'auto',
    theme: 'dynamic', accent: ACCENTS[0][0], density: 'comfortable', effects: 'full', defaultTab: 'last',
    profile: 'standard', pulseWin: 6, pulseThr: 40, min15: 'auto', cacheMin: 15, locLaunch: 'saved',
    order: DEFAULT_ORDER, hidden: [], tilesHidden: [],
    stormLayers: { cone: true, track: true, past: true, radii: true, labels: true },
  };
  const PRESETS = { metric: { temp: 'C', wind: 'kmh', precip: 'mm', dist: 'km' }, imperial: { temp: 'F', wind: 'mph', precip: 'in', dist: 'mi' } };

  /* ----------------------------------------------------------- validation */
  const ids = (list) => new Set(list.map((x) => (Array.isArray(x) ? x[0] : x.id)));
  const SEC_IDS = ids(SECTIONS), TILE_IDS = ids(TILES);
  function fixOrder(v) {
    if (!Array.isArray(v)) return DEFAULT_ORDER.slice();
    const out = [...new Set(v.filter((x) => SEC_IDS.has(x)))];
    // sections added in a later version slot in after their default predecessor
    DEFAULT_ORDER.forEach((id, i) => {
      if (out.includes(id)) return;
      const prev = DEFAULT_ORDER.slice(0, i).reverse().find((p) => out.includes(p));
      out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, id);
    });
    return out;
  }
  function valid(k, v) {
    if (OPT[k]) return OPT[k].some(([x]) => x === v) ? v : DEFAULTS[k];
    switch (k) {
      case 'accent': return typeof v === 'string' && ACCENTS.some(([c]) => c === v.toLowerCase()) ? v.toLowerCase() : DEFAULTS.accent;
      case 'pulseThr': return Number.isInteger(v) && v >= 10 && v <= 90 && v % 5 === 0 ? v : DEFAULTS.pulseThr;
      case 'order': return fixOrder(v);
      case 'hidden': return Array.isArray(v) ? [...new Set(v.filter((x) => SEC_IDS.has(x)))] : [];
      case 'tilesHidden': return Array.isArray(v) ? [...new Set(v.filter((x) => TILE_IDS.has(x)))] : [];
      case 'stormLayers': return Object.fromEntries(LAYERS.map(([id]) => [id, v && typeof v === 'object' && typeof v[id] === 'boolean' ? v[id] : true]));
      default: return undefined;
    }
  }

  /* ---------------------------------------------------------------- store */
  const read = (k) => { try { const v = localStorage.getItem(k); return v == null ? null : JSON.parse(v); } catch { return null; } };
  let P = {};
  (function load() {
    let saved = read(KEY);
    if (!saved || typeof saved !== 'object') {
      // first run of this version: carry over the old per-key preferences
      saved = {};
      if (read('skypulse.unit') === 'F') Object.assign(saved, PRESETS.imperial);
      const w = read('skypulse.umbWin'), t = read('skypulse.umbThr');
      if (w != null) saved.pulseWin = w;
      if (t != null) saved.pulseThr = t;
    }
    for (const k of Object.keys(DEFAULTS)) P[k] = valid(k, k in saved ? saved[k] : DEFAULTS[k]);
  })();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch { /* storage unavailable */ } };
  const listeners = [];
  function patch(obj) {
    const changed = new Set();
    for (const [k, v] of Object.entries(obj)) {
      if (!(k in DEFAULTS)) continue;
      const nv = valid(k, v);
      if (JSON.stringify(nv) !== JSON.stringify(P[k])) { P[k] = nv; changed.add(k); }
    }
    if (!changed.size) return;
    save();
    if ([...changed].some((k) => ['theme', 'accent', 'density'].includes(k))) applyLook();
    if ([...changed].some((k) => ['order', 'hidden'].includes(k))) Layout.apply();
    listeners.forEach((fn) => { try { fn(changed); } catch (e) { console.warn('prefs listener', e); } });
    if (sheetOpen()) renderSheet();
  }
  const get = (k) => { const v = P[k]; return Array.isArray(v) ? v.slice() : v && typeof v === 'object' ? { ...v } : v; };

  /* ----------------------------------------------------------- appearance */
  function applyLook() {
    const b = document.body; if (!b) return;
    OPT.theme.forEach(([t]) => b.classList.toggle('theme-' + t, P.theme === t));
    b.classList.toggle('density-compact', P.density === 'compact');
    document.documentElement.style.setProperty('--accent', P.accent);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', P.theme === 'oled' ? '#000000' : '#0b1530');
  }

  /* --------------------------------------------------------------- layout */
  // desktop column spans out of 12; anything not listed is full width. TALL items also take the next row's
  // columns (the Pulse Advisor sits beside both the current conditions and the warnings).
  const SPANS = { xl: { hero: 7, pulse: 5, chart: 8, feed: 4, daily: 7, past: 5 }, md: { feed: 6, past: 6 } };
  const TALL = { xl: { pulse: true } };
  const TABS = ['now', 'forecast', 'alerts', 'storms', 'sun', 'feed'];
  const Layout = {
    bp: () => (window.innerWidth > 1080 ? 'xl' : window.innerWidth > 760 ? 'md' : 'sm'),
    apply() {
      const main = document.getElementById('app'); if (!main) return;
      const bp = Layout.bp(), hidden = new Set(P.hidden);
      const custom = P.order.join() !== DEFAULT_ORDER.join();
      main.classList.toggle('custom-order', custom);
      const items = [];
      P.order.forEach((id, i) => {
        const el = main.querySelector(`[data-sec="${id}"]`); if (!el) return;
        el.classList.toggle('user-hidden', hidden.has(id));
        // phones keep the hand-tuned per-tab order from the stylesheet until the user reorders
        el.style.order = bp !== 'sm' || custom ? String(i + 1) : '';
        el.style.gridColumn = ''; el.style.gridRow = '';
        if (bp !== 'sm' && !hidden.has(id) && !el.hidden) items.push({ el, span: SPANS[bp]?.[id] ?? 12, tall: !!TALL[bp]?.[id] });
      });
      // pack rows of 12 columns; the last item of a short row stretches to fill it. A tall item leaves
      // the next row that many columns narrower (CSS auto-placement flows the next items around it).
      let row = 0, cap = 12, carry = 0, prev = null;
      const next = () => { row = 0; cap = 12 - carry; carry = 0; prev = null; };
      items.forEach((it, k) => {
        if (row > 0 && row + it.span > cap) { if (prev) prev.span += cap - row; next(); }
        it.span = Math.min(it.span, cap);
        it.rows = it.tall && k < items.length - 1 ? 2 : 1;
        if (it.rows === 2) carry = it.span;
        row += it.span; prev = it;
        if (row === cap) next();
      });
      if (prev && row) prev.span += cap - row;
      items.forEach((it) => { it.el.style.gridColumn = `span ${it.span}`; if (it.rows === 2) it.el.style.gridRow = 'span 2'; });
      Layout.tabs();
    },
    /** tabs that still have at least one visible section; hides the others in the tab bar */
    tabs() {
      const hidden = new Set(P.hidden);
      const vis = TABS.filter((t) => SECTIONS.some((s) => !hidden.has(s.id) && (document.querySelector(`[data-sec="${s.id}"]`)?.dataset.tab || '').split(' ').includes(t)));
      document.querySelectorAll('#tabbar button[data-tab]').forEach((b) => { b.hidden = !vis.includes(b.dataset.tab); });
      const bar = document.getElementById('tabbar'); if (bar) bar.style.setProperty('--n', Math.max(1, vis.length));
      Layout.visibleTabs = vis;
      window.dispatchEvent(new CustomEvent('layout:tabs', { detail: vis }));
      Layout.emptyCheck();
      return vis;
    },
    emptyCheck() {
      const main = document.getElementById('app'), hint = document.getElementById('emptyHint'); if (!main || !hint) return;
      const tab = main.dataset.active, phone = Layout.bp() === 'sm';
      const shown = [...main.querySelectorAll('[data-sec]')].some((el) => !el.hidden && !el.classList.contains('user-hidden') && (!phone || (el.dataset.tab || '').split(' ').includes(tab)));
      hint.hidden = shown;
    },
    visibleTabs: TABS,
  };
  let raf = 0;
  const relayout = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => Layout.apply()); };
  window.matchMedia('(max-width: 1080px)').addEventListener('change', relayout);
  window.matchMedia('(max-width: 760px)').addEventListener('change', relayout);

  /* ---------------------------------------------------------------- sheet */
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach((c) => c != null && n.append(c));
    return n;
  };
  const sheetOpen = () => { const s = $('#settingsSheet'); return s && !s.hidden; };
  let lastFocus = null, extra = { dataInfo: () => '', clearData: null };

  function seg(key, opts = OPT[key], label) {
    return el('div', { class: 'seg small set-seg', role: 'group', 'aria-label': label || key },
      opts.map(([v, txt]) => el('button', { type: 'button', class: P[key] === v ? 'active' : '', 'aria-pressed': String(P[key] === v), text: txt, onclick: () => patch({ [key]: v }) })));
  }
  const row = (label, control, help) => el('div', { class: 'set-row' }, el('div', { class: 'set-label' }, el('span', { text: label }), help ? el('small', { text: help }) : null), control);
  const group = (title, ...rows) => el('section', { class: 'set-group' }, el('h3', { text: title }), ...rows);

  function renderSheet() {
    const body = $('#settingsBody'); if (!body) return;
    const scroll = body.scrollTop;
    body.replaceChildren(
      group('Units',
        row('Temperature', seg('temp', OPT.temp, 'Temperature unit')),
        row('Wind', seg('wind', OPT.wind, 'Wind unit')),
        row('Rain & snow', seg('precip', OPT.precip, 'Precipitation unit')),
        row('Pressure', seg('pressure', OPT.pressure, 'Pressure unit')),
        row('Distance', seg('dist', OPT.dist, 'Distance unit'), 'Visibility, storm distances, waves (m ↔ ft)'),
        row('Clock', seg('clock', OPT.clock, 'Clock format')),
        el('p', { class: 'set-note', text: 'The °C / °F switch in the top bar applies the whole metric or imperial set; pick individual units here.' })),
      group('Appearance',
        row('Theme', seg('theme', OPT.theme, 'Theme'), 'Live sky follows the current weather'),
        row('Accent colour', el('div', { class: 'swatches', role: 'group', 'aria-label': 'Accent colour' },
          ACCENTS.map(([c, n]) => el('button', { type: 'button', class: 'swatch-btn' + (P.accent === c ? ' active' : ''), style: `--c:${c}`, title: n, 'aria-label': n, 'aria-pressed': String(P.accent === c), onclick: () => patch({ accent: c }) })))),
        row('Density', seg('density', OPT.density, 'Density')),
        row('Weather effects', seg('effects', OPT.effects, 'Weather effects'), 'Animated rain, snow and storms behind the cards')),
      group('Layout',
        el('p', { class: 'set-note', text: 'Show, hide and reorder sections. On phones each section stays in its own tab.' }),
        el('ol', { class: 'set-sections' }, P.order.map((id, i) => {
          const s = SECTIONS.find((x) => x.id === id), on = !P.hidden.includes(id);
          const move = (d) => { const o = P.order.slice(); o.splice(i, 1); o.splice(i + d, 0, id); patch({ order: o }); };
          return el('li', { class: on ? '' : 'off' },
            el('label', { class: 'set-check' }, el('input', { type: 'checkbox', checked: on, onchange: (e) => patch({ hidden: e.target.checked ? P.hidden.filter((x) => x !== id) : [...P.hidden, id] }) }),
              el('span', { text: s.label }), el('small', { text: s.tab })),
            el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Move ${s.label} up`, disabled: i === 0, onclick: () => move(-1), text: '↑' }),
            el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Move ${s.label} down`, disabled: i === P.order.length - 1, onclick: () => move(1), text: '↓' }));
        })),
        row('Detail tiles', el('div', { class: 'set-tiles' }, TILES.map(([id, n]) => el('label', { class: 'set-chip' + (P.tilesHidden.includes(id) ? '' : ' on') },
          el('input', { type: 'checkbox', checked: !P.tilesHidden.includes(id), onchange: (e) => patch({ tilesHidden: e.target.checked ? P.tilesHidden.filter((x) => x !== id) : [...P.tilesHidden, id] }) }), el('span', { text: n }))))),
        row('Start on', seg('defaultTab', OPT.defaultTab, 'Start tab'), 'Phones: the tab shown when the app opens'),
        el('button', { type: 'button', class: 'btn ghost small', text: 'Reset layout', onclick: () => patch({ order: DEFAULT_ORDER, hidden: [], tilesHidden: [] }) })),
      group('Pulse Advisor',
        row('Profile', seg('profile', OPT.profile, 'Advisor profile'), P.profile === 'sensitive' ? 'Earlier heat, cold, wind and air-quality advice (children, older people, health conditions)' : P.profile === 'hardy' ? 'Higher thresholds for people used to working outdoors' : 'Thresholds for most adults'),
        row('Look ahead', seg('pulseWin', OPT.pulseWin, 'Look-ahead window')),
        row(`Rain alert at ${P.pulseThr}%`, el('input', { type: 'range', min: 10, max: 90, step: 5, value: P.pulseThr, 'aria-label': 'Rain chance threshold', onchange: (e) => patch({ pulseThr: +e.target.value }) }))),
      group('Data & privacy',
        row('15-minute data', seg('min15', OPT.min15, '15-minute data'), 'Open-Meteo 15-minute forecasts for the US and Europe'),
        row('On opening', seg('locLaunch', OPT.locLaunch, 'Location on opening'), P.locLaunch === 'gps' ? 'Asks the browser for your position every time the app opens' : 'Starts from your last GPS fix (kept only on this device, rounded to about 100 m) without a permission prompt. Live GPS starts by itself when the browser already allows it; tap Live GPS to update.'),
        row('Reuse saved weather for', seg('cacheMin', OPT.cacheMin, 'Cache duration'), 'Opening the app or a searched place within this time uses the copy saved on this device instead of a new request. Manual refresh always fetches.'),
        row('Saved on this device', el('div', { class: 'set-data' }, el('span', { class: 'muted', text: extra.dataInfo() }),
          el('button', { type: 'button', class: 'btn ghost small', text: 'Clear saved data', onclick: () => { extra.clearData?.(); renderSheet(); } })),
        'Settings, your last GPS fix, recent forecasts (up to 8 places, 24 h), place names and coastline checks. Nothing is uploaded.'),
        el('button', { type: 'button', class: 'btn ghost small danger', text: 'Reset all settings', onclick: () => { if (confirm('Reset every SkyPulse setting to its default?')) patch(structuredClone(DEFAULTS)); } })),
    );
    body.scrollTop = scroll;
  }
  function openSheet(section) {
    const s = $('#settingsSheet'); if (!s) return;
    lastFocus = document.activeElement;
    renderSheet();
    s.hidden = false; $('#sheetBackdrop').hidden = false;
    document.body.classList.add('sheet-open');
    requestAnimationFrame(() => {
      s.classList.add('open');
      const target = section && [...s.querySelectorAll('.set-group h3')].find((h) => h.textContent === section);
      if (target) target.scrollIntoView({ block: 'start' });
      $('#settingsClose').focus();
    });
  }
  function closeSheet() {
    const s = $('#settingsSheet'); if (!s || s.hidden) return;
    s.classList.remove('open'); s.hidden = true; $('#sheetBackdrop').hidden = true;
    document.body.classList.remove('sheet-open');
    lastFocus?.focus?.();
  }
  function initSheet() {
    $('#settingsBtn')?.addEventListener('click', () => openSheet());
    $('#settingsClose')?.addEventListener('click', closeSheet);
    $('#sheetBackdrop')?.addEventListener('click', closeSheet);
    document.addEventListener('click', (e) => { if (e.target.closest('[data-open-settings]')) openSheet('Layout'); });
    document.addEventListener('keydown', (e) => {
      if (!sheetOpen()) return;
      if (e.key === 'Escape') { closeSheet(); return; }
      if (e.key === 'Tab') { // keep focus inside the dialog
        const f = [...$('#settingsSheet').querySelectorAll('button:not([disabled]), input, [tabindex="0"]')].filter((x) => x.offsetParent);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { f.at(-1).focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === f.at(-1)) { f[0].focus(); e.preventDefault(); }
      }
    });
    applyLook();
    // runtime show/hide of a section (e.g. the 15-minute card) re-packs the grid
    const mo = new MutationObserver(relayout);
    document.querySelectorAll('#app > [data-sec]').forEach((n) => mo.observe(n, { attributes: true, attributeFilter: ['hidden'] }));
    Layout.apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSheet); else initSheet();

  window.Prefs = {
    get, patch, set: (k, v) => patch({ [k]: v }),
    preset: (name) => patch(PRESETS[name] || {}),
    on: (fn) => listeners.push(fn),
    open: openSheet, close: closeSheet,
    /** app-provided hooks for the Data section */
    hooks: (h) => Object.assign(extra, h),
    SECTIONS, TILES, LAYERS, DEFAULTS,
  };
  window.Layout = Layout;
})();
