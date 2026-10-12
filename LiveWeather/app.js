/* SkyPulse — live weather for your location.
 * Data: Open-Meteo forecast + air-quality APIs (no key), BigDataCloud reverse geocoding.
 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const HOUR = 3600e3;
  const REFRESH_MS = 5 * 60e3;   // weather refresh cadence
  const MOVE_KM = 1.5;            // re-fetch when the user moves this far
  const FEED_MAX = 60;

  /* ---------------- persistence (per-viewer conveniences only) ---------------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('skypulse.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('skypulse.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const S = {
    unit: store.get('unit', 'C'),
    umbWin: store.get('umbWin', 6),
    umbThr: store.get('umbThr', 40),
    param: 'temp', range: 'mid',
    loc: null, mode: 'gps', watchId: null,
    t: null, aq: null,
    lastFetch: 0, nextFetch: Infinity, fetching: false, fetchToken: 0,
    feed: [], announced: new Set(), prevSnap: null, prevUmb: null,
    chart: null, chartAnimate: true,
  };

  /* ---------------- units & formatting ---------------- */
  const num = (v) => typeof v === 'number' && !Number.isNaN(v);
  const cT = (c) => (S.unit === 'F' ? c * 9 / 5 + 32 : c);
  const fT = (c) => (num(c) ? Math.round(cT(c)) + '°' : '–');
  const dT = (d) => (S.unit === 'F' ? d * 9 / 5 : d);
  const cW = (k) => (S.unit === 'F' ? k * 0.621371 : k);
  const wU = () => (S.unit === 'F' ? 'mph' : 'km/h');
  const fW = (k) => (num(k) ? Math.round(cW(k)) : '–');
  const cP = (mm) => (S.unit === 'F' ? mm / 25.4 : mm);
  const pU = () => (S.unit === 'F' ? 'in' : 'mm');
  const fP = (mm) => { const v = cP(mm || 0); return S.unit === 'F' ? v.toFixed(2) : v < 10 ? v.toFixed(1) : String(Math.round(v)); };
  const cV = (m) => (S.unit === 'F' ? m / 1609.34 : m / 1000);
  const vU = () => (S.unit === 'F' ? 'mi' : 'km');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const signed = (v, digits = 0) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(digits);

  // Times are displayed in the *location's* time zone.
  let TZ;
  const fmtCache = new Map();
  function fmt(ms, opts) {
    const key = TZ + JSON.stringify(opts);
    let f = fmtCache.get(key);
    if (!f) {
      try { f = new Intl.DateTimeFormat(undefined, { timeZone: TZ, ...opts }); } catch { f = new Intl.DateTimeFormat(undefined, opts); }
      fmtCache.set(key, f);
    }
    return f.format(ms);
  }
  const fmtHM = (ms) => fmt(ms, { hour: 'numeric', minute: '2-digit' });
  const fmtH = (ms) => fmt(ms, { hour: 'numeric' });
  const fmtDay = (ms) => fmt(ms, { weekday: 'short' });
  const fmtDate = (ms) => fmt(ms, { month: 'short', day: 'numeric' });
  const hourOf = (ms) => {
    const key = 'h23' + TZ;
    let f = fmtCache.get(key);
    if (!f) { try { f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }); } catch { f = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23' }); } fmtCache.set(key, f); }
    return parseInt(f.format(ms), 10) % 24;
  };
  const dur = (ms) => { const m = Math.round(Math.abs(ms) / 60e3); const h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m} min`; };
  const deviceTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); if (s < 10) return 'just now'; if (s < 60) return `${s}s ago`; const m = Math.round(s / 60); return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

  /* ---------------- descriptors ---------------- */
  const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const dirName = (d) => DIRS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
  const beaufort = (k) => k < 1 ? 'Calm' : k < 6 ? 'Light air' : k < 12 ? 'Light breeze' : k < 20 ? 'Gentle breeze' : k < 29 ? 'Moderate breeze' : k < 39 ? 'Fresh breeze' : k < 50 ? 'Strong breeze' : k < 62 ? 'Near gale' : k < 75 ? 'Gale' : k < 89 ? 'Strong gale' : 'Storm';
  const uvCat = (u) => u < 3 ? 'Low' : u < 6 ? 'Moderate' : u < 8 ? 'High' : u < 11 ? 'Very high' : 'Extreme';
  const dewCat = (d) => d < 10 ? 'Dry' : d < 13 ? 'Comfortable' : d < 16 ? 'Pleasant' : d < 18 ? 'Slightly humid' : d < 21 ? 'Humid' : d < 24 ? 'Very humid' : 'Oppressive';
  const aqiCat = (a) => a <= 50 ? ['Good', '#4fd18b'] : a <= 100 ? ['Moderate', '#ffd23f'] : a <= 150 ? ['Unhealthy for sensitive groups', '#ff9a3d'] : a <= 200 ? ['Unhealthy', '#ff5a5a'] : a <= 300 ? ['Very unhealthy', '#b06bff'] : ['Hazardous', '#a3324a'];
  const visCat = (m) => m >= 10000 ? 'Excellent' : m >= 4000 ? 'Good' : m >= 1000 ? 'Moderate — haze or mist' : 'Poor — fog';
  const isWet = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;
  const isSnow = (c) => (c >= 71 && c <= 77) || c === 85 || c === 86;
  const cond = (c) => WX.WMO[c] ?? 'Unknown';

  /* ---------------- network ---------------- */
  async function getJSON(url, ms = 15000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'request timed out' : e.message);
    } finally { clearTimeout(timer); }
  }

  const HOURLY = ['temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'apparent_temperature', 'precipitation_probability', 'precipitation', 'weather_code', 'pressure_msl', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'visibility', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'uv_index', 'is_day'];
  const CURRENT = ['temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'is_day', 'precipitation', 'weather_code', 'cloud_cover', 'pressure_msl', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];
  const DAILY = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'sunrise', 'sunset', 'precipitation_sum', 'precipitation_probability_max', 'wind_gusts_10m_max', 'uv_index_max'];

  const forecastURL = ({ lat, lon }) => 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: 'auto', timeformat: 'unixtime',
    past_days: 2, forecast_days: 8, wind_speed_unit: 'kmh',
    current: CURRENT.join(','), hourly: HOURLY.join(','), daily: DAILY.join(','), minutely_15: 'precipitation',
  });
  const aqURL = ({ lat, lon }) => 'https://air-quality-api.open-meteo.com/v1/air-quality?' + new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), current: 'us_aqi,pm2_5,pm10', timezone: 'auto',
  });
  const reverseURL = ({ lat, lon }) => 'https://api.bigdatacloud.net/data/reverse-geocode-client?' + new URLSearchParams({
    latitude: lat.toFixed(5), longitude: lon.toFixed(5), localityLanguage: 'en',
  });
  const searchURL = (q) => 'https://geocoding-api.open-meteo.com/v1/search?' + new URLSearchParams({ name: q, count: 7, language: 'en', format: 'json' });

  async function reverseGeocode(loc) {
    const r = await getJSON(reverseURL(loc), 8000);
    const name = r.city || r.locality || r.principalSubdivision || r.countryName;
    if (!name) return null;
    const sub = [r.city && r.locality && r.locality !== r.city ? r.locality : null, r.principalSubdivision, r.countryName].filter(Boolean).join(', ');
    return { name, sub };
  }

  /* ---------------- data processing ---------------- */
  function processData(d) {
    TZ = d.timezone;
    fmtCache.clear();
    const ms = (a) => a.map((s) => s * 1000);
    const h = d.hourly, dl = d.daily;
    const H = {
      time: ms(h.time), t: h.temperature_2m, rh: h.relative_humidity_2m, dp: h.dew_point_2m, at: h.apparent_temperature,
      pp: h.precipitation_probability, pr: h.precipitation, wc: h.weather_code, ps: h.pressure_msl,
      cc: h.cloud_cover, cl: h.cloud_cover_low, cm: h.cloud_cover_mid, ch: h.cloud_cover_high, vis: h.visibility,
      ws: h.wind_speed_10m, wd: h.wind_direction_10m, wg: h.wind_gusts_10m, uv: h.uv_index, day: h.is_day,
    };
    const D = {
      time: ms(dl.time), wc: dl.weather_code, tmax: dl.temperature_2m_max, tmin: dl.temperature_2m_min,
      sr: ms(dl.sunrise), ss: ms(dl.sunset), prs: dl.precipitation_sum, ppm: dl.precipitation_probability_max,
      gmax: dl.wind_gusts_10m_max, uvm: dl.uv_index_max,
    };
    const M = d.minutely_15 ? { time: ms(d.minutely_15.time), pr: d.minutely_15.precipitation } : null;
    const c = d.current;
    const cur = {
      time: c.time * 1000, t: c.temperature_2m, rh: c.relative_humidity_2m, at: c.apparent_temperature, day: !!c.is_day,
      pr: c.precipitation, wc: c.weather_code, cc: c.cloud_cover, ps: c.pressure_msl, ws: c.wind_speed_10m, wd: c.wind_direction_10m, wg: c.wind_gusts_10m,
    };
    return { H, D, M, cur, elev: d.elevation, tzAbbr: d.timezone_abbreviation };
  }

  /** index of the hour containing `ms` (hourly data is evenly spaced in UTC). */
  const hIdx = (ms) => clamp(Math.floor((ms - S.t.H.time[0]) / HOUR), 0, S.t.H.time.length - 1);
  const nowIdx = () => hIdx(Date.now());
  /** linear interpolation of an hourly series at time ms */
  function at(k, ms) {
    const { H } = S.t; const i = hIdx(ms); const a = H[k][i], b = H[k][i + 1];
    if (!num(a)) return b; if (!num(b)) return a;
    return a + (b - a) * clamp((ms - H.time[i]) / HOUR, 0, 1);
  }
  const dIdx = (ms) => { const { D } = S.t; let i = 0; while (i + 1 < D.time.length && D.time[i + 1] <= ms) i++; return i; };

  /* ---------------- umbrella advisor ---------------- */
  function computeUmbrella(winH = S.umbWin, thr = S.umbThr) {
    const { H, M, cur } = S.t; const now = Date.now(); const end = now + winH * HOUR;
    const idx = [];
    for (let i = nowIdx(); i < H.time.length && H.time[i] < end; i++) idx.push(i);
    let maxP = 0, maxI = idx[0], sum = 0, first = null, thunder = false, snow = false, maxGust = 0;
    idx.forEach((i, k) => {
      const p = H.pp[i] ?? 0, r = H.pr[i] ?? 0;
      const w = k === 0 ? clamp(1 - (now - H.time[i]) / HOUR, 0, 1) : clamp((end - H.time[i]) / HOUR, 0, 1);
      sum += r * w;
      if (p > maxP) { maxP = p; maxI = i; }
      if (first === null && (p >= thr || r >= 0.3)) first = i;
      if (H.wc[i] >= 95) thunder = true;
      if (isSnow(H.wc[i])) snow = true;
      maxGust = Math.max(maxGust, H.wg[i] ?? 0);
    });
    let ncSum = 0, ncFirst = null;
    if (M) for (let j = 0; j < M.time.length; j++) {
      if (M.time[j] + 15 * 60e3 <= now) continue;
      if (M.time[j] >= end) break;
      const r = M.pr[j] ?? 0; ncSum += r;
      if (ncFirst === null && r >= 0.1) ncFirst = Math.max(now, M.time[j]);
    }
    const rainingNow = (cur.pr ?? 0) >= 0.1 || isWet(cur.wc);
    let clearsAt = null;
    if (rainingNow) for (let i = nowIdx() + 1; i < H.time.length && H.time[i] < now + 24 * HOUR; i++) {
      if ((H.pp[i] ?? 0) < thr * 0.5 && (H.pr[i] ?? 0) < 0.1) { clearsAt = H.time[i]; break; }
    }

    let level;
    if (rainingNow || (thunder && maxP >= thr)) level = 3;
    else if (maxP >= thr || sum >= 1 || (ncFirst !== null && ncSum >= 0.5)) level = 2;
    else if (maxP >= thr * 0.6 || sum >= 0.2) level = 1;
    else level = 0;

    const when = (i) => (i == null ? '' : H.time[i] <= now ? 'now' : fmtHM(H.time[i]));
    let verdict, detail;
    switch (level) {
      case 3:
        verdict = rainingNow ? (isSnow(cur.wc) ? 'Snowing — cover up' : 'Umbrella needed now') : 'Umbrella + caution';
        detail = rainingNow
          ? `${cond(cur.wc)} right now${clearsAt ? `, easing around ${fmtHM(clearsAt)}` : ' and continuing for a while'}.`
          : `Thunderstorms are possible, peaking at ${maxP}% around ${when(maxI)}.`;
        break;
      case 2:
        verdict = 'Take an umbrella';
        detail = `Rain likely ${first != null && H.time[first] > now ? 'from about ' + when(first) : 'soon'} — peak ${maxP}% chance${maxI != null && H.time[maxI] > now ? ' around ' + when(maxI) : ''}, ~${fP(sum)} ${pU()} expected in the next ${winH} h.`;
        if (ncFirst !== null && ncFirst - now < 90 * 60e3) detail += ` Nowcast shows rain starting ${ncFirst - now < 5 * 60e3 ? 'any minute' : 'in ~' + dur(ncFirst - now)}.`;
        break;
      case 1:
        verdict = 'Pack a compact umbrella';
        detail = `Small risk: up to ${maxP}% chance${maxI != null ? ' around ' + when(maxI) : ''} within ${winH} h.`;
        break;
      default:
        verdict = 'No umbrella needed';
        detail = `Rain chance stays at or below ${maxP}% for the next ${winH} h.`;
    }
    const notes = [];
    if (level >= 1 && maxGust >= 45) notes.push(`💨 Gusts up to ${fW(maxGust)} ${wU()} — a windproof umbrella or rain jacket is wiser.`);
    if (thunder) notes.push('⚡ Thunderstorms possible — avoid open ground and tall isolated trees.');
    if (snow) notes.push('❄️ Snow in the window — a hooded jacket may beat an umbrella.');
    if (level === 0 && (S.t.H.uv[nowIdx()] ?? 0) >= 6) notes.push('😎 Strong sun though — an umbrella doubles as shade.');
    const firstRain = first != null ? H.time[first] : ncFirst;
    return { level, verdict, detail, notes, maxP, maxI, sum, first, firstRain, idx, thunder, rainingNow, clearsAt };
  }

  /* ---------------- rendering ---------------- */
  const ICON = {
    thermo: '<path d="M14 14.8V4a2 2 0 1 0-4 0v10.8a4 4 0 1 0 4 0z"/>',
    drop: '<path d="M12 3s-6 6.5-6 11a6 6 0 0 0 12 0c0-4.5-6-11-6-11z"/>',
    cloud: '<path d="M17.5 19H8a5 5 0 1 1 .9-9.9A6 6 0 0 1 20 11a4 4 0 0 1-2.5 8z"/>',
    wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/>',
    gauge: '<path d="M12 14l4-4"/><path d="M3.3 17a10 10 0 1 1 17.4 0"/>',
    rain: '<path d="M16 14v6M8 14v6M12 16v6"/><path d="M20 16.6A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 15.3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
    leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z"/><path d="M2 21c0-3 1.9-5.4 5.2-6"/>',
  };
  const ico = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;
  const trendHTML = (diff, unitTxt, digits = 0, eps = 0.05) => {
    if (!num(diff)) return '';
    const cls = diff > eps ? 'up' : diff < -eps ? 'down' : 'flat';
    const arrow = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '■';
    return `<span class="t-trend ${cls}">${arrow} ${signed(diff, digits)}${unitTxt}</span>`;
  };

  function renderAll() {
    if (!S.t) return;
    const { cur } = S.t;
    document.body.className = 'scene-' + WX.scene(cur.wc, cur.day);
    S.umb = computeUmbrella();
    renderHero(); renderSun(); renderUmbrella(); renderTiles(); renderChart(); renderHourly(); renderDaily(); renderPast(); renderStatus();
  }

  function renderHero() {
    const { cur, H, D } = S.t; const now = Date.now(); const di = dIdx(now);
    $('#placeName').textContent = S.loc.name || `${Math.abs(S.loc.lat).toFixed(2)}°${S.loc.lat >= 0 ? 'N' : 'S'}, ${Math.abs(S.loc.lon).toFixed(2)}°${S.loc.lon >= 0 ? 'E' : 'W'}`;
    $('#placeSub').textContent = S.loc.sub || (S.loc.source === 'gps' ? 'Your current location' : '');
    $('#heroIcon').innerHTML = WX.iconSVG(cur.wc, cur.day, 110);
    $('#heroTemp').textContent = fT(cur.t);
    $('#heroCond').textContent = cond(cur.wc);
    $('#heroFeels').textContent = `Feels like ${fT(cur.at)}`;
    $('#heroHiLo').textContent = `H ${fT(D.tmax[di])}  ·  L ${fT(D.tmin[di])}`;

    const parts = [];
    const y = at('t', now - 24 * HOUR);
    if (num(y)) {
      const diff = dT(cur.t - y);
      parts.push(Math.abs(diff) < 1 ? 'About the same temperature as this time yesterday.' : `${Math.round(Math.abs(diff))}° ${diff > 0 ? 'warmer' : 'cooler'} than this time yesterday.`);
    }
    // trend over next 6 h
    let hi = -Infinity, hiI = null, lo = Infinity, loI = null;
    for (let i = nowIdx() + 1; i <= nowIdx() + 6 && i < H.time.length; i++) {
      if (H.t[i] > hi) { hi = H.t[i]; hiI = i; }
      if (H.t[i] < lo) { lo = H.t[i]; loI = i; }
    }
    if (hiI != null && hi - cur.t >= 1.5) parts.push(`Warming to ${fT(hi)} by ${fmtH(H.time[hiI])}.`);
    else if (loI != null && cur.t - lo >= 1.5) parts.push(`Cooling to ${fT(lo)} by ${fmtH(H.time[loI])}.`);
    const u = S.umb;
    if (u.level === 0) parts.push(`Rain unlikely in the next ${S.umbWin} h.`);
    else if (u.rainingNow) parts.push(u.clearsAt ? `Rain should ease around ${fmtHM(u.clearsAt)}.` : 'Wet weather continues.');
    else if (u.firstRain) parts.push(`Rain possible from ${fmtHM(u.firstRain)}.`);
    $('#heroSummary').textContent = parts.join(' ');
  }

  function renderSun() {
    const { D } = S.t; const now = Date.now(); const di = dIdx(now);
    const sr = D.sr[di], ss = D.ss[di];
    const dot = $('#sunDot'), prog = $('#sunArcProgress');
    if (!num(sr) || !num(ss) || ss <= sr) {
      $('#sunrise').textContent = '–'; $('#sunset').textContent = '–'; $('#dayLen').textContent = 'Polar day/night';
      return;
    }
    $('#sunrise').textContent = fmtHM(sr);
    $('#sunset').textContent = fmtHM(ss);
    const f = clamp((now - sr) / (ss - sr), 0, 1);
    const ang = Math.PI * (1 - f);
    const x = 120 + 100 * Math.cos(ang), y = 100 - 100 * Math.sin(ang);
    dot.setAttribute('cx', x.toFixed(1)); dot.setAttribute('cy', y.toFixed(1));
    const night = now < sr || now > ss;
    dot.classList.toggle('night', night);
    prog.setAttribute('d', night && now < sr ? 'M20 100' : `M20 100 A100 100 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}`);
    if (now < sr) { $('#dayLenLabel').textContent = 'Sunrise in'; $('#dayLen').textContent = dur(sr - now); }
    else if (now > ss) {
      const nsr = D.sr[di + 1];
      $('#dayLenLabel').textContent = 'Sunrise in'; $('#dayLen').textContent = num(nsr) ? dur(nsr - now) : '–';
    } else { $('#dayLenLabel').textContent = 'Sunset in'; $('#dayLen').textContent = dur(ss - now); }
  }

  function renderUmbrella() {
    const u = S.umb; const { H } = S.t; const C = 2 * Math.PI * 50;
    const card = $('#umbrellaCard');
    card.classList.remove('lv0', 'lv1', 'lv2', 'lv3'); card.classList.add('lv' + u.level);
    $('#gaugeArc').style.strokeDasharray = `${(u.maxP / 100) * C} ${C}`;
    $('#gaugeThr').style.transform = `rotate(${S.umbThr * 3.6}deg)`;
    $('#gaugeVal').textContent = u.maxP + '%';
    $('#umbIcon').innerHTML = WX.umbrellaSVG(u.level >= 1);
    $('#umbVerdict').textContent = u.verdict;
    $('#umbDetail').textContent = u.detail;
    $('#umbNotes').innerHTML = u.notes.map((n) => `<li>${esc(n)}</li>`).join('');
    const bars = $('#umbBars'); const n = u.idx.length; const every = n <= 8 ? 1 : n <= 13 ? 2 : 4;
    const plot = 38; // bar plot height in px (54 container − 16 label strip)
    bars.innerHTML = u.idx.map((i, k) => {
      const p = H.pp[i] ?? 0;
      return `<div class="b ${p >= S.umbThr ? 'hit' : ''}" style="height:${Math.max(2, (p / 100) * plot)}px" title="${esc(fmtHM(H.time[i]))}: ${p}% · ${fP(H.pr[i])} ${pU()}">${k % every === 0 ? `<span>${k === 0 ? 'now' : esc(fmtH(H.time[i]))}</span>` : ''}</div>`;
    }).join('') + `<div class="thr-line" style="bottom:${16 + (S.umbThr / 100) * plot}px"></div>`;
    $('#thrVal').textContent = S.umbThr + '%';
  }

  function renderTiles() {
    const { cur, H, D } = S.t; const now = Date.now(); const i = nowIdx(); const di = dIdx(now);
    const dp = at('dp', now), uv = at('uv', now), vis = at('vis', now);
    const tiles = [];
    // Feels like
    const fl = cur.at - cur.t;
    tiles.push(`<div class="card tile"><div class="t-head">${ico('thermo')}Feels like</div>
      <div class="t-val">${fT(cur.at)}</div>${trendHTML(dT(cur.t - at('t', now - 3 * HOUR)), '° temp, 3 h', 1, 0.2)}
      <div class="t-note">${fl <= -2 ? 'Wind makes it feel colder' : fl >= 2 ? 'Humidity makes it feel warmer' : 'Close to the actual temperature'} (actual ${fT(cur.t)})</div></div>`);
    // Humidity
    tiles.push(`<div class="card tile"><div class="t-head">${ico('drop')}Humidity</div>
      <div class="t-val">${Math.round(cur.rh)}<small>%</small></div><div class="meter"><i style="width:${cur.rh}%"></i></div>
      ${trendHTML(cur.rh - at('rh', now - 3 * HOUR), '% in 3 h', 0, 0.5)}
      <div class="t-note">Dew point ${fT(dp)} · ${dewCat(dp)}</div></div>`);
    // Dew point
    const spread = cur.t - dp;
    tiles.push(`<div class="card tile"><div class="t-head">${ico('drop')}Dew point</div>
      <div class="t-val">${fT(dp)}</div>${trendHTML(dT(dp - at('dp', now - 3 * HOUR)), '° in 3 h', 1, 0.2)}
      <div class="t-note">${dewCat(dp)} · ${spread < 2.5 ? 'air near saturation — fog or mist possible' : `${Math.round(dT(spread))}° below air temperature`}</div></div>`);
    // Cloud cover
    const layer = (n, v) => `<div><span>${n}</span><div class="meter"><i style="width:${v ?? 0}%"></i></div><span>${Math.round(v ?? 0)}%</span></div>`;
    tiles.push(`<div class="card tile"><div class="t-head">${ico('cloud')}Cloud cover</div>
      <div class="t-val">${Math.round(cur.cc)}<small>%</small></div>
      <div class="layers">${layer('Low', H.cl[i])}${layer('Mid', H.cm[i])}${layer('High', H.ch[i])}</div></div>`);
    // Wind
    tiles.push(`<div class="card tile"><div class="t-head">${ico('wind')}Wind</div>
      <div class="t-val">${fW(cur.ws)}<small>${wU()}</small></div>
      <svg class="compass" viewBox="0 0 64 64" aria-hidden="true"><circle class="ring" cx="32" cy="32" r="27"/>
        <text x="32" y="9">N</text><text x="56" y="32">E</text><text x="32" y="56">S</text><text x="8" y="32">W</text>
        <g class="needle" style="transform:rotate(${(cur.wd + 180) % 360}deg)"><path d="M32 14 L37 34 L32 30 L27 34Z" fill="#fff"/><path d="M32 30 L32 48" stroke="rgba(255,255,255,.5)" stroke-width="2"/></g></svg>
      <div class="t-note">From ${dirName(cur.wd)} (${Math.round(cur.wd)}°) · ${beaufort(cur.ws)}<br>Gusts ${fW(cur.wg)} ${wU()}</div></div>`);
    // Pressure
    const pd = cur.ps - at('ps', now - 3 * HOUR);
    const pTxt = pd <= -3 ? 'Falling fast — stormy, unsettled weather likely' : pd <= -1 ? 'Falling — clouds or rain may increase' : pd >= 1 ? 'Rising — weather improving or settling' : 'Steady — little change expected';
    tiles.push(`<div class="card tile"><div class="t-head">${ico('gauge')}Pressure</div>
      <div class="t-val">${Math.round(cur.ps)}<small>hPa</small></div>${trendHTML(pd, ' hPa in 3 h', 1, 0.3)}
      <div class="t-note">${pTxt}</div></div>`);
    // Rain next 24 h
    let r24 = 0, rh24 = 0, past24 = 0;
    for (let k = i; k < i + 24 && k < H.time.length; k++) { r24 += H.pr[k] ?? 0; if ((H.pr[k] ?? 0) >= 0.1) rh24++; }
    for (let k = Math.max(0, i - 24); k < i; k++) past24 += H.pr[k] ?? 0;
    tiles.push(`<div class="card tile"><div class="t-head">${ico('rain')}Rain · next 24 h</div>
      <div class="t-val">${fP(r24)}<small>${pU()}</small></div>
      <div class="t-note">${rh24 ? `${rh24} wet hour${rh24 > 1 ? 's' : ''} expected` : 'No wet hours expected'} · now ${fP(cur.pr)} ${pU()}<br>Last 24 h: ${fP(past24)} ${pU()}</div></div>`);
    // Nowcast: 15-minute precipitation for the next 2 hours
    const slots = [];
    if (S.t.M) for (let j = 0; j < S.t.M.time.length && slots.length < 8; j++) if (S.t.M.time[j] + 15 * 60e3 > now) slots.push(j);
    if (slots.length) {
      const pr = slots.map((j) => S.t.M.pr[j] ?? 0); const peak = Math.max(...pr); const firstWet = pr.findIndex((v) => v >= 0.1);
      tiles.push(`<div class="card tile"><div class="t-head">${ico('rain')}Nowcast · 2 h</div>
        <div class="t-val" style="font-size:20px">${firstWet < 0 ? 'Dry' : firstWet === 0 ? 'Raining' : 'Rain in ~' + dur(S.t.M.time[slots[firstWet]] - now)}</div>
        <div class="spark">${pr.map((v, k) => `<i title="${esc(fmtHM(S.t.M.time[slots[k]]))}: ${fP(v)} ${pU()}" style="height:${v > 0 ? clamp(15 + (v / Math.max(peak, 1)) * 85, 15, 100) : 4}%" class="${v >= 0.1 ? 'wet' : ''}"></i>`).join('')}</div>
        <div class="t-note">15-min steps · ${esc(fmtHM(S.t.M.time[slots[0]]))}–${esc(fmtHM(S.t.M.time[slots.at(-1)] + 15 * 60e3))}</div></div>`);
    }
    // UV
    const uvNow = cur.day ? Math.max(0, uv ?? 0) : 0;
    tiles.push(`<div class="card tile"><div class="t-head">${ico('sun')}UV index</div>
      <div class="t-val">${uvNow.toFixed(uvNow < 10 ? 1 : 0)}<small>${uvCat(uvNow)}</small></div>
      <div class="uv-scale"><i style="left:${clamp(uvNow / 11, 0, 1) * 100}%"></i></div>
      <div class="t-note">Today's max ${num(D.uvm[di]) ? D.uvm[di].toFixed(1) : '–'} (${uvCat(D.uvm[di] ?? 0)})${D.uvm[di] >= 3 ? ' · sunscreen advised midday' : ''}</div></div>`);
    // Visibility
    tiles.push(`<div class="card tile"><div class="t-head">${ico('eye')}Visibility</div>
      <div class="t-val">${num(vis) ? (cV(vis) >= 10 ? Math.round(cV(vis)) : cV(vis).toFixed(1)) : '–'}<small>${vU()}</small></div>
      <div class="t-note">${num(vis) ? visCat(vis) : 'Not available'}</div></div>`);
    // Air quality (optional)
    const aq = S.aq?.current;
    if (aq && num(aq.us_aqi)) {
      const [cat, col] = aqiCat(aq.us_aqi);
      tiles.push(`<div class="card tile"><div class="t-head">${ico('leaf')}Air quality</div>
        <div class="t-val">${Math.round(aq.us_aqi)}<small>US AQI</small></div>
        <div class="meter"><i style="width:${clamp(aq.us_aqi / 3, 0, 100)}%;background:${col}"></i></div>
        <div class="t-note">${cat}${num(aq.pm2_5) ? ` · PM2.5 ${aq.pm2_5.toFixed(0)} µg/m³` : ''}</div></div>`);
    }
    // Moon phase
    const m = moonPhase(now); const dFull = Math.round(m.toFull);
    tiles.push(`<div class="card tile"><div class="t-head">${ico('moon')}Moon</div>
      <div class="t-val"><span aria-hidden="true">${m.emoji}</span> ${Math.round(m.illum * 100)}<small>% lit</small></div>
      <div class="t-note">${m.name}<br>${dFull === 0 || dFull >= 29 ? 'Full moon tonight' : `Full moon in ${dFull} day${dFull === 1 ? '' : 's'}`}</div></div>`);
    $('#tiles').innerHTML = tiles.join('');
  }

  function moonPhase(ms) {
    const SYN = 29.530588853;
    const age = ((((ms / 86400000 + 2440587.5 - 2451550.1) / SYN) % 1) + 1) % 1; // 0 = new, 0.5 = full
    const k = Math.round(age * 8) % 8;
    const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
    return { name: names[k], emoji: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'][k], illum: (1 - Math.cos(2 * Math.PI * age)) / 2, toFull: (((0.5 - age) % 1) + 1) % 1 * SYN };
  }

  /* ---------------- chart ---------------- */
  const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
  const PARAMS = {
    temp: { unit: () => '°' + S.unit, series: [
      { k: 't', label: 'Temperature', color: '#ff8a5b', fill: true, conv: cT },
      { k: 'at', label: 'Feels like', color: '#ffd166', width: 1.5, conv: cT },
      { k: 'dp', label: 'Dew point', color: '#6cc6ff', width: 1.5, conv: cT }] },
    hum: { unit: () => '%', min: 0, max: 100, series: [{ k: 'rh', label: 'Relative humidity', color: '#6cc6ff', fill: true }] },
    cloud: { unit: () => '%', min: 0, max: 100, series: [
      { k: 'cc', label: 'Total', color: '#e8eefc', fill: true },
      { k: 'cl', label: 'Low', color: '#9aa7c2', width: 1.5 },
      { k: 'cm', label: 'Mid', color: '#b7a6ff', width: 1.5 },
      { k: 'ch', label: 'High', color: '#7cc4ff', width: 1.5 }] },
    rain: { unit: () => '%', min: 0, max: 100, series: [
      { k: 'pp', label: 'Rain chance', color: '#5cb8ff', fill: true },
      { k: 'pr', label: () => `Precipitation (${pU()})`, color: '#9ad8ff', type: 'bar', axis: 'y1', conv: cP, unit: pU }] },
    wind: { unit: wU, min: 0, series: [
      { k: 'ws', label: 'Wind speed', color: '#4fd18b', fill: true, conv: cW },
      { k: 'wg', label: 'Gusts', color: '#ffc24d', width: 1.5, conv: cW }] },
    press: { unit: () => 'hPa', series: [{ k: 'ps', label: 'Pressure (MSL)', color: '#c79bff', fill: true }] },
  };

  const nowLinePlugin = {
    id: 'nowLine',
    beforeDatasetsDraw(chart) {
      const pos = chart.$nowPos; if (pos == null) return;
      const { ctx, chartArea: a, scales: { x } } = chart; const px = x.getPixelForValue(pos);
      if (px < a.left || px > a.right) return;
      ctx.save(); ctx.fillStyle = 'rgba(255,255,255,0.045)'; ctx.fillRect(a.left, a.top, px - a.left, a.bottom - a.top); ctx.restore();
    },
    afterDatasetsDraw(chart) {
      const pos = chart.$nowPos; if (pos == null) return;
      const { ctx, chartArea: a, scales: { x } } = chart; const px = x.getPixelForValue(pos);
      if (px < a.left || px > a.right) return;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(px, a.top + 14); ctx.lineTo(px, a.bottom); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '600 11px Inter, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('NOW', px, a.top + 9);
      ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.font = '500 10px Inter, sans-serif';
      ctx.textAlign = 'right'; ctx.fillText('◂ past', px - 6, a.bottom - 6);
      ctx.textAlign = 'left'; ctx.fillText('forecast ▸', px + 6, a.bottom - 6);
      ctx.restore();
    },
  };

  function renderChart() {
    if (typeof Chart === 'undefined') return;
    const { H } = S.t; const ni = nowIdx(); const last = H.time.length - 1;
    const [from, to] = S.range === 'short' ? [ni - 24, ni + 24] : S.range === 'mid' ? [ni - 48, ni + 72] : [0, last];
    const a = clamp(from, 0, last), b = clamp(to, 0, last);
    const times = H.time.slice(a, b + 1);
    const relNow = ni - a + clamp((Date.now() - H.time[ni]) / HOUR, 0, 1);
    const P = PARAMS[S.param];
    const step = S.range === 'short' ? 6 : S.range === 'mid' ? 12 : 24;

    const datasets = P.series.map((s) => {
      const data = H[s.k].slice(a, b + 1).map((v) => (num(v) ? (s.conv ? s.conv(v) : v) : null));
      const label = typeof s.label === 'function' ? s.label() : s.label;
      const isPast = (i) => i <= relNow;
      if (s.type === 'bar') {
        return { type: 'bar', label, data, yAxisID: s.axis, order: 2, $unit: s.unit,
          backgroundColor: data.map((_, i) => hexA(s.color, isPast(i) ? 0.35 : 0.8)), borderRadius: 2, barPercentage: 1, categoryPercentage: 0.8 };
      }
      return {
        type: 'line', label, data, yAxisID: 'y', order: 1,
        borderColor: s.color, borderWidth: s.width ?? 2.5, pointRadius: 0, pointHoverRadius: 4, pointBackgroundColor: s.color, tension: 0.35,
        fill: s.fill ? 'start' : false,
        backgroundColor: (ctx) => {
          const { chart } = ctx; const ar = chart.chartArea; if (!ar) return 'transparent';
          const g = chart.ctx.createLinearGradient(0, ar.top, 0, ar.bottom);
          g.addColorStop(0, hexA(s.color, 0.32)); g.addColorStop(1, hexA(s.color, 0)); return g;
        },
        segment: {
          borderDash: (ctx) => (ctx.p1DataIndex <= relNow ? [5, 4] : undefined),
          borderColor: (ctx) => (ctx.p1DataIndex <= relNow ? hexA(s.color, 0.6) : undefined),
        },
      };
    });

    const scales = {
      x: {
        grid: { color: (ctx) => (ctx.tick && hourOf(times[ctx.tick.value]) === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.05)') },
        ticks: {
          color: 'rgba(228,236,255,.6)', autoSkip: false, maxRotation: 0,
          callback: (v) => { const t = times[v]; if (t == null) return null; const h = hourOf(t); if (h % step) return null; return h === 0 ? `${fmtDay(t)} ${fmtDate(t).replace(/^\D+\s/, '')}` : fmtH(t); },
        },
      },
      y: {
        min: P.min, max: P.max, grace: P.min == null ? '8%' : 0,
        grid: { color: 'rgba(255,255,255,.07)' }, border: { display: false },
        ticks: { color: 'rgba(228,236,255,.6)', maxTicksLimit: 6, callback: (v) => `${Math.round(v * 10) / 10}${P.unit() === '%' ? '%' : ''}` },
        title: { display: true, text: P.unit(), color: 'rgba(228,236,255,.5)' },
      },
    };
    if (P.series.some((s) => s.axis === 'y1')) {
      scales.y1 = { position: 'right', min: 0, suggestedMax: S.unit === 'F' ? 0.1 : 2, grid: { display: false }, border: { display: false },
        ticks: { color: 'rgba(154,216,255,.7)', maxTicksLimit: 5 }, title: { display: true, text: pU() + '/h', color: 'rgba(154,216,255,.6)' } };
    }

    const config = {
      data: { labels: times.map((t) => `${fmtDay(t)} ${fmtHM(t)}`), datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: S.chartAnimate ? { duration: 500 } : false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: P.series.length > 1, labels: { color: 'rgba(228,236,255,.8)', boxWidth: 12, boxHeight: 3, usePointStyle: false, font: { size: 12 } } },
          tooltip: {
            backgroundColor: 'rgba(10,16,34,.94)', borderColor: 'rgba(255,255,255,.15)', borderWidth: 1, padding: 10, titleColor: '#fff', bodyColor: 'rgba(228,236,255,.9)',
            callbacks: {
              title: (items) => { const t = times[items[0].dataIndex]; return `${fmtDay(t)} ${fmtDate(t)}, ${fmtHM(t)}${t <= Date.now() ? '  (past)' : ''}`; },
              label: (it) => { const u = it.dataset.$unit ? it.dataset.$unit() : P.unit(); const v = it.parsed.y; return ` ${it.dataset.label}: ${num(v) ? (Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v)) : '–'} ${u}`; },
            },
          },
        },
        scales,
      },
      plugins: [nowLinePlugin],
    };

    if (S.chart) S.chart.destroy();
    Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
    S.chart = new Chart($('#mainChart'), { type: 'line', ...config });
    S.chart.$nowPos = relNow;
    S.chart.draw();
    S.chartAnimate = false;
  }

  function renderHourly() {
    const { H, D, cur } = S.t; const i0 = nowIdx(); const now = Date.now();
    const events = [];
    D.sr.forEach((t, k) => { if (num(t) && t > now && t < now + 25 * HOUR) events.push({ t, kind: 'Sunrise', ss: D.ss[k] }); });
    D.ss.forEach((t) => { if (num(t) && t > now && t < now + 25 * HOUR) events.push({ t, kind: 'Sunset' }); });
    const cards = [];
    for (let i = i0; i <= i0 + 24 && i < H.time.length; i++) {
      const isNow = i === i0;
      const t = isNow ? cur.t : H.t[i], wc = isNow ? cur.wc : H.wc[i], day = isNow ? cur.day : !!H.day[i];
      const pp = H.pp[i] ?? 0;
      cards.push(`<div class="hour ${isNow ? 'now' : ''}"><span class="h-t">${isNow ? 'Now' : esc(fmtH(H.time[i]))}</span>
        ${WX.iconSVG(wc, day, 36)}<span class="h-temp">${fT(t)}</span>
        <span class="h-pp ${pp < 20 ? 'dim' : ''}">💧${pp}%</span></div>`);
      events.filter((e) => e.t >= H.time[i] && e.t < H.time[i] + HOUR && !(isNow && e.t < now)).forEach((e) => {
        cards.push(`<div class="hour sunev"><span class="h-t">${esc(fmtHM(e.t))}</span>
          ${WX.iconSVG(0, true, 36)}<span class="h-temp" style="font-size:13px">${e.kind}</span><span class="h-pp dim">${e.kind === 'Sunrise' ? '↑' : '↓'}</span></div>`);
      });
    }
    $('#hourly').innerHTML = cards.join('');
  }

  function renderDaily() {
    const { D, cur } = S.t; const di = dIdx(Date.now());
    const idx = []; for (let k = di; k < D.time.length; k++) idx.push(k);
    const lo = Math.min(...idx.map((k) => D.tmin[k]).filter(num)), hi = Math.max(...idx.map((k) => D.tmax[k]).filter(num));
    const span = hi - lo || 1;
    // daily .time is local midnight expressed in UTC; label via UTC to avoid DST/offset drift
    const dayName = (k) => k === di ? 'Today' : k === di + 1 ? 'Tomorrow' : new Date(D.time[k] + (S.t.offset ?? 0)).toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' });
    const dateTxt = (k) => new Date(D.time[k] + (S.t.offset ?? 0)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    $('#daily').innerHTML = idx.map((k) => {
      const l = ((D.tmin[k] - lo) / span) * 100, w = ((D.tmax[k] - D.tmin[k]) / span) * 100;
      const nowDot = k === di && num(cur.t) ? `<span class="now-dot" style="left:${clamp(((cur.t - lo) / span) * 100, 0, 100)}%"></span>` : '';
      const pp = D.ppm[k] ?? 0;
      return `<div class="day"><div class="d-name"><b>${dayName(k)}</b><small>${dateTxt(k)}</small></div>
        ${WX.iconSVG(D.wc[k], true, 34)}
        <div class="d-pp" title="Max rain chance · total precipitation">${pp >= 10 ? pp + '%' : ''}<small>${(D.prs[k] ?? 0) >= 0.1 ? fP(D.prs[k]) + ' ' + pU() : ''}</small></div>
        <span class="d-lo">${fT(D.tmin[k])}</span>
        <div class="range"><i style="left:${l}%;width:${Math.max(w, 2)}%"></i>${nowDot}</div>
        <span class="d-hi">${fT(D.tmax[k])}</span></div>`;
    }).join('');
  }

  function renderPast() {
    const { H, D, cur } = S.t; const now = Date.now(); const i = nowIdx(); const di = dIdx(now);
    const range = (k, from, to) => { const out = []; for (let j = Math.max(0, from); j < to; j++) if (num(H[k][j])) out.push(H[k][j]); return out; };
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const rain24 = sum(range('pr', i - 24, i)), rain48 = sum(range('pr', i - 48, i));
    const gust24 = Math.max(0, ...range('wg', i - 24, i));
    const rh24 = range('rh', i - 24, i);
    const yd = di - 1;
    const stats = `<div class="past-grid">
      <div class="stat"><small>Yesterday</small><b>${fT(D.tmax[yd])} / ${fT(D.tmin[yd])}</b><br><span>${cond(D.wc[yd])}</span></div>
      <div class="stat"><small>Rain · last 24 h</small><b>${fP(rain24)} ${pU()}</b><br><span>48 h: ${fP(rain48)} ${pU()}</span></div>
      <div class="stat"><small>Peak gust · 24 h</small><b>${fW(gust24)} ${wU()}</b><br><span>${beaufort(gust24)}</span></div>
      <div class="stat"><small>Humidity · 24 h</small><b>${rh24.length ? Math.round(sum(rh24) / rh24.length) : '–'}% avg</b><br><span>${rh24.length ? `${Math.round(Math.min(...rh24))}–${Math.round(Math.max(...rh24))}% range` : ''}</span></div>
    </div>`;
    const y = now - 24 * HOUR;
    const row = (name, was, nowV, fmtV, diffV, unit, digits = 0) => {
      const d = diffV(nowV - was);
      const cls = Math.abs(d) < 0.5 ? 'flat' : d > 0 ? 'up' : 'down';
      return `<div class="cmp-row"><span>${name}</span><span class="was">${fmtV(was)}</span><span>${fmtV(nowV)} <span class="t-trend ${cls}">${signed(d, digits)}${unit}</span></span></div>`;
    };
    const cmp = `<div class="compare"><h3>Now vs. this time yesterday</h3>
      ${row('Temperature', at('t', y), cur.t, fT, dT, '°')}
      ${row('Humidity', at('rh', y), cur.rh, (v) => Math.round(v) + '%', (d) => d, '%')}
      ${row('Cloud cover', at('cc', y), cur.cc, (v) => Math.round(v) + '%', (d) => d, '%')}
      ${row('Pressure', at('ps', y), cur.ps, (v) => Math.round(v) + ' hPa', (d) => d, ' hPa', 1)}
      ${row('Wind', at('ws', y), cur.ws, (v) => fW(v) + ' ' + wU(), cW, '')}
    </div>`;
    $('#past').innerHTML = stats + cmp;
  }

  function renderStatus() {
    const pill = $('#livePill'); pill.className = 'live-pill';
    const L = S.loc;
    if (!L) { $('#liveText').textContent = 'Waiting for location'; return; }
    if (L.source === 'gps') { pill.classList.add('live'); $('#liveText').textContent = `Live · GPS ±${L.acc < 1000 ? Math.round(L.acc) + ' m' : (L.acc / 1000).toFixed(1) + ' km'}`; }
    else if (L.source === 'saved') { pill.classList.add('manual'); $('#liveText').textContent = 'Last known location'; }
    else { pill.classList.add('manual'); $('#liveText').textContent = 'Manual location · auto-refreshing'; }
    const lat = `${Math.abs(L.lat).toFixed(3)}°${L.lat >= 0 ? 'N' : 'S'}`, lon = `${Math.abs(L.lon).toFixed(3)}°${L.lon >= 0 ? 'E' : 'W'}`;
    $('#locMeta').textContent = `${lat}, ${lon}${S.t && num(S.t.elev) ? ` · ${Math.round(S.t.elev)} m` : ''}`;
    $('#locateBtn').classList.toggle('on', S.mode === 'gps');
  }

  function tick() {
    if (S.t) {
      $('#clock').textContent = `Local ${fmt(Date.now(), { hour: 'numeric', minute: '2-digit', second: '2-digit' })} ${S.t.tzAbbr || ''}`.trim();
      $('#updated').textContent = `Updated ${ago(S.lastFetch)}`;
      const left = S.nextFetch - Date.now();
      $('#nextRefresh').textContent = S.fetching ? 'Updating…' : left > 0 && left < Infinity ? `Next update in ${Math.floor(left / 60e3)}:${String(Math.floor((left % 60e3) / 1000)).padStart(2, '0')}` : '';
    }
    if (Date.now() >= S.nextFetch && !document.hidden && !S.fetching) refresh('auto');
  }

  /* ---------------- live feed ---------------- */
  const FEED_ICON = { info: '•', alert: '☔', warn: '⚠️', err: '⚠️', good: '✓' };
  function feed(kind, icon, msg) {
    S.feed.unshift({ t: Date.now(), kind, icon: icon || FEED_ICON[kind], msg });
    if (S.feed.length > FEED_MAX) S.feed.length = FEED_MAX;
    renderFeed();
  }
  function renderFeed() {
    $('#feed').innerHTML = S.feed.map((f) => `<li class="${f.kind}"><span class="f-ico" aria-hidden="true">${f.icon}</span>
      <div class="f-text">${esc(typeof f.msg === 'function' ? f.msg() : f.msg)}<time>${deviceTime(f.t)} · ${ago(f.t)}</time></div></li>`).join('');
  }
  const once = (key, fn) => { if (!S.announced.has(key)) { S.announced.add(key); fn(); } };

  function snapshot() {
    const { cur } = S.t;
    return { t: cur.t, rh: cur.rh, cc: cur.cc, ps: cur.ps, ws: cur.ws, wc: cur.wc, time: cur.time };
  }

  function feedAfterRefresh(reason) {
    const snap = snapshot(); const prev = S.prevSnap; const u = S.umb;
    if (prev) {
      let changes = 0;
      const dTemp = snap.t - prev.t;
      if (Math.abs(dTemp) >= 0.5) { changes++; feed('info', dTemp > 0 ? '🌡️' : '🧊', () => `Temperature ${dTemp > 0 ? 'rose' : 'fell'} ${Math.abs(dT(dTemp)).toFixed(1)}° to ${fT(snap.t)}`); }
      if (Math.abs(snap.rh - prev.rh) >= 4) { changes++; feed('info', '💧', `Humidity ${snap.rh > prev.rh ? 'up' : 'down'} to ${Math.round(snap.rh)}% (was ${Math.round(prev.rh)}%)`); }
      if (Math.abs(snap.cc - prev.cc) >= 15) { changes++; feed('info', '☁️', `Cloud cover ${snap.cc > prev.cc ? 'increased' : 'decreased'} to ${Math.round(snap.cc)}%`); }
      if (Math.abs(snap.ps - prev.ps) >= 0.8) { changes++; feed('info', '📉', `Pressure ${snap.ps > prev.ps ? 'rising' : 'falling'}: ${Math.round(snap.ps)} hPa`); }
      if (Math.abs(snap.ws - prev.ws) >= 6) { changes++; feed('info', '💨', () => `Wind ${snap.ws > prev.ws ? 'picked up' : 'eased'} to ${fW(snap.ws)} ${wU()}`); }
      if (snap.wc !== prev.wc) { changes++; feed(isWet(snap.wc) ? 'alert' : 'info', '🔄', `Conditions changed: ${cond(prev.wc)} → ${cond(snap.wc)}`); }
      if (!changes && reason !== 'auto-quiet') feed('good', '✓', snap.time !== prev.time ? 'New observation — conditions steady' : 'Checked — no change since last update');
    }
    const key = `${S.umbWin}|${S.umbThr}`;
    if (S.prevUmb && S.prevUmb.key === key && S.prevUmb.level !== u.level) {
      feed(u.level > S.prevUmb.level ? 'warn' : 'good', '☂️', `Umbrella advice: ${u.verdict}. ${u.detail}`);
    } else if (!S.prevUmb) {
      feed(u.level >= 2 ? 'alert' : u.level === 1 ? 'warn' : 'good', '☂️', `${u.verdict}. ${u.detail}`);
    }
    S.prevUmb = { key, level: u.level };
    S.prevSnap = snap;
    checkUpcoming();
  }

  /** forward-looking alerts, each announced once */
  function checkUpcoming() {
    if (!S.t) return;
    const { H, M, D } = S.t; const now = Date.now(); const i0 = nowIdx();
    for (let i = i0 + 1; i < H.time.length && H.time[i] < now + 3 * HOUR; i++) {
      if ((H.pp[i] ?? 0) >= S.umbThr) { once('rain-' + H.time[i], () => feed('alert', '☔', `Rain likely around ${fmtHM(H.time[i])} (${H.pp[i]}% chance)`)); break; }
    }
    if (M) for (let j = 0; j < M.time.length; j++) {
      if (M.time[j] < now) continue; if (M.time[j] > now + HOUR) break;
      if ((M.pr[j] ?? 0) >= 0.1) { once('nc-' + M.time[j], () => feed('alert', '🌧️', `Nowcast: rain may start in ~${dur(M.time[j] - now)} (${fmtHM(M.time[j])})`)); break; }
    }
    for (let i = i0; i < H.time.length && H.time[i] < now + 6 * HOUR; i++) {
      if (H.wc[i] >= 95) { once('ts-' + H.time[i], () => feed('warn', '⚡', `Thunderstorm risk around ${fmtHM(H.time[i])}`)); break; }
    }
    [...D.sr.map((t) => ['Sunrise', '🌅', t]), ...D.ss.map((t) => ['Sunset', '🌇', t])].forEach(([name, icon, t]) => {
      if (num(t) && t > now && t - now <= HOUR) once(name + t, () => feed('info', icon, `${name} in ${dur(t - now)} (${fmtHM(t)})`));
    });
    const uv = S.t.cur.day ? at('uv', now) : 0;
    if (uv >= 6) once('uv-' + dIdx(now) + S.loc.lat.toFixed(2), () => feed('warn', '🧴', `UV index ${uv.toFixed(1)} (${uvCat(uv)}) — sunscreen and shade recommended`));
    const g = at('wg', now);
    if (g >= 60) once('gust-' + i0, () => feed('warn', '🌬️', () => `Strong gusts right now: ${fW(g)} ${wU()}`));
  }

  /* ---------------- data refresh ---------------- */
  async function refresh(reason = 'auto') {
    if (!S.loc) return;
    const token = ++S.fetchToken; const loc = S.loc;
    S.fetching = true; $('#refreshBtn').classList.add('spin');
    try {
      const [fc, aq, place] = await Promise.all([
        getJSON(forecastURL(loc)),
        getJSON(aqURL(loc), 10000).catch(() => null),
        loc.name ? null : reverseGeocode(loc).catch(() => null),
      ]);
      if (token !== S.fetchToken) return; // superseded by a newer request
      if (place) Object.assign(loc, place);
      store.set('lastLoc', { lat: loc.lat, lon: loc.lon, name: loc.name, sub: loc.sub });
      S.t = processData(fc); S.t.offset = fc.utc_offset_seconds * 1000; S.aq = aq;
      S.lastFetch = Date.now(); S.nextFetch = S.lastFetch + REFRESH_MS;
      const first = !S.prevSnap;
      renderAll();
      if (first) {
        $('#app').setAttribute('aria-busy', 'false');
        feed('info', '🛰️', `Loaded ${fc.hourly.time.length} hours of data (2 days past → 8 days ahead) for ${loc.name || 'this point'}, grid elevation ${Math.round(fc.elevation)} m`);
      }
      feedAfterRefresh(reason);
      hideGate();
    } catch (e) {
      if (token !== S.fetchToken) return;
      S.nextFetch = Date.now() + 60e3;
      feed('err', '⚠️', `Update failed (${e.message}). Retrying in 1 minute.`);
      if (!S.t) gateFail('Could not load weather data', `${e.message}. Check your connection and try again.`);
    } finally {
      if (token === S.fetchToken) { S.fetching = false; $('#refreshBtn').classList.remove('spin'); tick(); }
    }
  }

  function setLocation(loc, why) {
    const changedPlace = !S.loc || haversine(S.loc, loc) > 0.5;
    S.loc = loc;
    if (changedPlace) { S.prevSnap = null; S.prevUmb = null; S.announced.clear(); S.chartAnimate = true; }
    if (why) feed('info', loc.source === 'gps' ? '📍' : '🔎', why);
    renderStatus();
    refresh('location');
  }

  function haversine(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /* ---------------- geolocation ---------------- */
  function startGPS() {
    if (!('geolocation' in navigator)) { fallbackFromGPS('This browser does not support geolocation.'); return; }
    stopGPS();
    S.mode = 'gps'; renderStatus(); $('#locateBtn').classList.add('on');
    if (!S.t) showGate('Finding your location…', 'Allow location access for live, hyper-local updates.');
    S.watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 });
  }
  function stopGPS() {
    if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
  }
  function onPos(p) {
    if (S.mode !== 'gps') return;
    const { latitude: lat, longitude: lon, accuracy: acc } = p.coords;
    const next = { lat, lon, acc, source: 'gps' };
    if (!S.loc || S.loc.source !== 'gps') {
      setLocation(next, `Live location locked (±${Math.round(acc)} m)`);
      return;
    }
    const km = haversine(S.loc, next);
    if (km >= MOVE_KM) setLocation(next, `You moved ${km.toFixed(1)} km — refreshing forecast for your new position`);
    else { S.loc.acc = acc; renderStatus(); }
  }
  function onPosErr(e) {
    const msg = e.code === 1 ? 'Location permission was denied.' : e.code === 3 ? 'Timed out while getting your location.' : 'Your location is currently unavailable.';
    if (S.loc && S.loc.source === 'gps') {               // transient error while tracking: keep last fix
      if (e.code === 1) { stopGPS(); S.mode = 'manual'; S.loc.source = 'saved'; renderStatus(); feed('warn', '📍', msg + ' Live tracking stopped.'); }
      return;
    }
    fallbackFromGPS(msg);
  }
  function fallbackFromGPS(msg) {
    stopGPS(); S.mode = 'manual'; renderStatus();
    const saved = store.get('lastLoc', null);
    if (!S.loc && saved && num(saved.lat)) {
      setLocation({ ...saved, source: 'saved' }, `${msg} Showing your last known place.`);
    } else if (!S.loc) {
      gateFail(msg, 'You can retry GPS or search for a city instead.');
    } else feed('warn', '📍', msg);
  }

  /* ---------------- gate & toast ---------------- */
  function showGate(title, msg) {
    $('#gate').classList.remove('hide'); $('#gateTitle').textContent = title; $('#gateMsg').textContent = msg;
    $('#gateSpinner').classList.remove('off'); $('#gateActions').hidden = true;
  }
  function gateFail(title, msg = '') {
    $('#gate').classList.remove('hide'); $('#gateTitle').textContent = title; $('#gateMsg').textContent = msg;
    $('#gateSpinner').classList.add('off'); $('#gateActions').hidden = false;
    $('#liveText').textContent = 'No location'; $('#livePill').className = 'live-pill error';
  }
  const hideGate = () => $('#gate').classList.add('hide');
  let toastTimer;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600); }

  /* ---------------- search ---------------- */
  let searchTimer, searchSeq = 0, results = [], active = -1;
  const input = $('#searchInput'), list = $('#searchResults');
  function renderResults() {
    list.hidden = !results.length;
    list.innerHTML = results.map((r, k) => `<li role="option" data-k="${k}" class="${k === active ? 'active' : ''}"><span>${esc(r.name)}</span><small>${esc([r.admin1, r.country].filter(Boolean).join(', '))}</small></li>`).join('');
  }
  function pick(r) {
    if (!r) return;
    stopGPS(); S.mode = 'manual';
    input.value = ''; results = []; renderResults(); input.blur();
    setLocation({ lat: r.latitude, lon: r.longitude, name: r.name, sub: [r.admin1, r.country].filter(Boolean).join(', '), source: 'search' }, `Switched to ${r.name}${r.country ? ', ' + r.country : ''}`);
    hideGate();
  }
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 2) { results = []; renderResults(); return; }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      try {
        const r = await getJSON(searchURL(q), 8000);
        if (seq !== searchSeq) return;
        results = r.results || []; active = results.length ? 0 : -1; renderResults();
        if (!results.length) toast(`No places found for “${q}”`);
      } catch (e) { toast('Search failed: ' + e.message); }
    }, 300);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(results.length - 1, active + 1); renderResults(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); renderResults(); e.preventDefault(); }
    else if (e.key === 'Enter') pick(results[active]);
    else if (e.key === 'Escape') { results = []; renderResults(); }
  });
  list.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); pick(results[+li.dataset.k]); } });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
  input.addEventListener('focus', () => { if (results.length) list.hidden = false; });

  /* ---------------- controls ---------------- */
  const setSeg = (sel, attr, val) => document.querySelectorAll(`${sel} button`).forEach((b) => b.classList.toggle('active', b.dataset[attr] === String(val)));

  document.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => {
    S.unit = b.dataset.unit; store.set('unit', S.unit); setSeg('.top-actions .seg', 'unit', S.unit);
    renderAll(); renderFeed();
  }));
  $('#umbWin').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.umbWin = +b.dataset.h; store.set('umbWin', S.umbWin); setSeg('#umbWin', 'h', S.umbWin);
    if (S.t) { S.umb = computeUmbrella(); renderUmbrella(); renderHero(); }
  });
  $('#thrInput').addEventListener('input', (e) => {
    S.umbThr = +e.target.value; store.set('umbThr', S.umbThr);
    if (S.t) { S.umb = computeUmbrella(); renderUmbrella(); renderHero(); } else $('#thrVal').textContent = S.umbThr + '%';
  });
  $('#paramTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.param = b.dataset.p; setSeg('#paramTabs', 'p', S.param); S.chartAnimate = true; if (S.t) renderChart();
  });
  $('#rangeTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.range = b.dataset.r; setSeg('#rangeTabs', 'r', S.range); S.chartAnimate = true; if (S.t) renderChart();
  });
  $('#refreshBtn').addEventListener('click', () => refresh('manual'));
  $('#locateBtn').addEventListener('click', () => {
    if (S.mode === 'gps' && S.loc?.source === 'gps') {
      navigator.geolocation.getCurrentPosition((p) => { onPos(p); toast(`Location re-checked (±${Math.round(p.coords.accuracy)} m)`); refresh('manual'); }, onPosErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    } else { feed('info', '📍', 'Switching to live GPS tracking…'); startGPS(); }
  });
  $('#gateRetry').addEventListener('click', startGPS);
  $('#gateSearch').addEventListener('click', () => { hideGate(); $('#placeName').textContent = 'Choose a location'; $('#placeSub').textContent = 'Search for a city above'; input.focus(); });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.loc && Date.now() - S.lastFetch > REFRESH_MS) refresh('auto');
  });

  /* ---------------- boot ---------------- */
  setSeg('.top-actions .seg', 'unit', S.unit);
  setSeg('#umbWin', 'h', S.umbWin);
  $('#thrInput').value = S.umbThr; $('#thrVal').textContent = S.umbThr + '%';
  setInterval(tick, 1000);
  setInterval(() => { if (S.t) { renderSun(); checkUpcoming(); renderFeed(); } }, 30e3);
  feed('info', '👋', 'SkyPulse started — requesting your location');
  startGPS();
})();
