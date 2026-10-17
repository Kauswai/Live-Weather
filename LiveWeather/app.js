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
  /** fetch JSON with a timeout; transient failures (5xx, 429, network) are retried twice with backoff */
  async function getJSON(url, ms = 15000, retries = 2) {
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ms);
      let transient = false;
      try {
        const r = await fetch(url, { signal: ctl.signal });
        if (!r.ok) { transient = r.status >= 500 || r.status === 429; throw new Error(`HTTP ${r.status}`); }
        return await r.json();
      } catch (e) {
        if (e.name === 'TypeError') transient = true; // network error
        if (!transient || attempt >= retries) throw new Error(e.name === 'AbortError' ? 'request timed out' : e.message);
      } finally { clearTimeout(timer); }
      await new Promise((res) => setTimeout(res, 1200 * (attempt + 1) ** 2));
    }
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
    // finest → coarsest, state last: used to match local (district/state) warnings
    const adm = (r.localityInfo?.administrative || []).filter((a) => a.adminLevel > 4 && a.name).sort((a, b) => b.adminLevel - a.adminLevel).map((a) => a.name);
    const admins = [...new Set([r.city, r.locality, ...adm, r.principalSubdivision].filter(Boolean))];
    return { name, sub, cc: r.countryCode, country: r.countryName, admins };
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
    const tcKt = S.hz?.tcWindowKt ? S.hz.tcWindowKt(winH) : 0;
    if (tcKt >= 34) {
      notes.push(`🌀 ${S.hz.threat.s.name}: cyclone winds up to ~${fW(tcKt * 1.852)} ${wU()} in this window — umbrellas are useless and dangerous. Stay indoors.`);
      if (level < 2) { level = 2; verdict = 'Stay indoors — cyclone winds'; detail = 'Wind-driven rain makes umbrellas ineffective; follow official advice.'; }
    }
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
    applyFx();
    S.umb = computeUmbrella();
    renderHero(); renderSun(); renderUmbrella(); renderTiles(); updateSunTracker(); renderChart(); renderHourly(); renderDaily(); renderPast(); renderStatus();
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
    const narrow = ($('#mainChart').parentElement.clientWidth || 800) < 560;
    const step = (S.range === 'short' ? 6 : S.range === 'mid' ? 12 : 24) * (narrow ? 2 : 1);

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

  /* ---------------- sun tracker ---------------- */
  const DAY = 86400000;
  const ST = { key: null, yearKey: null };
  const svgNS = (tag, attrs = {}, text) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}>${text ?? ''}</${tag}>`;
  const durHMS = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`; };
  const deltaMS = (ms) => { const s = Math.round(Math.abs(ms) / 1000); return `${ms >= 0 ? '+' : '−'}${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
  const azTxt = (az) => (num(az) ? `${Math.round(az)}° ${dirName(az)}` : '–');
  const tOr = (t, alt = '–') => (num(t) ? fmtHM(t) : alt);
  /** UTC-midnight epoch of the location's current calendar date */
  function localMidnightUTC(ms) {
    const key = 'ymd' + TZ; let f = fmtCache.get(key);
    if (!f) { try { f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch { f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }); } fmtCache.set(key, f); }
    return Date.parse(f.format(ms) + 'T00:00:00Z');
  }

  // curve geometry (viewBox 640×250)
  const CV = { L: 40, R: 624, TOP: 24, HZ: 185, BOT: 212 };
  // dome geometry (viewBox 240×240)
  const DM = { C: 120, R: 98 };
  const domePt = (az, el) => {
    const r = el >= 0 ? (DM.R * (90 - el)) / 90 : DM.R + 7;
    return [DM.C + r * Math.sin(az * Math.PI / 180), DM.C - r * Math.cos(az * Math.PI / 180)];
  };

  function buildSunTracker(mid) {
    const { lat, lon } = S.t; const off = S.t.offset ?? 0;
    const svgW = (el) => Math.max(300, Math.round(el.parentElement.clientWidth - 24));
    const cw = svgW($("#stCurve")); CV.R = cw - 16; $("#stCurve").setAttribute("viewBox", `0 0 ${cw} 250`);
    const today = SunCalc.times(mid, lat, lon, off);
    const yday = SunCalc.times(mid - DAY, lat, lon, off), tmrw = SunCalc.times(mid + DAY, lat, lon, off);
    const partial = !today.polar && (today.rise == null || today.set == null); // first/last day of midnight sun or polar night
    const whole = today.polar || partial;
    const [d0, d1] = whole ? [mid - off, mid - off + DAY] : [today.rise, today.set];
    ST.whole = whole;
    const yMax = Math.max(15, Math.ceil(Math.max(today.maxEl, 1) / 15) * 15);
    const X = (t) => CV.L + ((t - d0) / (d1 - d0)) * (CV.R - CV.L);
    const Y = (e) => (e >= 0 ? CV.HZ - (Math.min(e, yMax) / yMax) * (CV.HZ - CV.TOP) : CV.HZ + (Math.min(-e, 18) / 18) * (CV.BOT - CV.HZ));
    Object.assign(ST, { today, yday, tmrw, d0, d1, X, Y, mid, lat, lon, off });

    // ---- elevation curve ----
    const N = 160, pts = [];
    for (let k = 0; k <= N; k++) { const t = d0 + ((d1 - d0) * k) / N; pts.push([X(t), Y(SunCalc.position(t, lat, lon).el)]); }
    const line = 'M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L');
    const area = 'M' + pts.map(([x, y]) => `${x.toFixed(1)},${Math.min(y, CV.HZ).toFixed(1)}`).join('L') + `L${CV.R},${CV.HZ}L${CV.L},${CV.HZ}Z`;
    let g = `<defs><linearGradient id="stFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc94d" stop-opacity=".35"/><stop offset="1" stop-color="#ff8a5b" stop-opacity=".02"/></linearGradient>
      <clipPath id="stPastClip"><rect id="stClipRect" x="${CV.L}" y="0" width="0" height="250"/></clipPath></defs>`;
    g += svgNS('rect', { class: 'below', x: CV.L, y: CV.HZ, width: CV.R - CV.L, height: CV.BOT - CV.HZ });
    for (let e = 15; e <= yMax; e += 15) {
      g += svgNS('line', { class: 'grid-line', x1: CV.L, x2: CV.R, y1: Y(e), y2: Y(e) });
      g += svgNS('text', { x: CV.L - 6, y: Y(e) + 4, 'text-anchor': 'end' }, e + '°');
    }
    g += svgNS('text', { x: CV.L - 6, y: CV.HZ + 4, 'text-anchor': 'end' }, '0°');
    g += svgNS('text', { x: CV.L - 6, y: CV.BOT + 2, 'text-anchor': 'end' }, '−18°');
    if (!whole) {
      if (num(today.goldenAmEnd)) g += svgNS('rect', { class: 'golden', x: X(d0), y: CV.TOP, width: Math.max(0, X(today.goldenAmEnd) - X(d0)), height: CV.HZ - CV.TOP });
      if (num(today.goldenPmStart)) g += svgNS('rect', { class: 'golden', x: X(today.goldenPmStart), y: CV.TOP, width: Math.max(0, X(d1) - X(today.goldenPmStart)), height: CV.HZ - CV.TOP });
    }
    g += svgNS('path', { d: area, fill: 'url(#stFill)' });
    g += svgNS('line', { class: 'horizon-line', x1: CV.L, x2: CV.R, y1: CV.HZ, y2: CV.HZ });
    g += svgNS('path', { class: 'track-future', d: line });
    g += svgNS('path', { class: 'track-past', d: line, 'clip-path': 'url(#stPastClip)' });
    if (today.noon >= d0 && today.noon <= d1) {
      const xn = X(today.noon);
      g += svgNS('line', { class: 'noon-line', x1: xn, x2: xn, y1: Y(today.maxEl), y2: CV.HZ });
      g += svgNS('text', { x: xn, y: Math.max(12, Y(today.maxEl) - 10), 'text-anchor': 'middle', class: 'lbl-strong' }, `☀ Solar noon ${esc(fmtHM(today.noon))} · ${today.maxEl < 0 ? "−" : ""}${Math.abs(today.maxEl).toFixed(1)}°`);
    }
    // local-hour ticks
    const span = (d1 - d0) / HOUR, every = span > 16 ? 3 : span > 9 ? 2 : 1;
    for (let t = Math.ceil((d0 + off) / HOUR) * HOUR - off; t < d1; t += HOUR) {
      const x = X(t); const h = hourOf(t);
      g += svgNS('line', { class: 'grid-line', x1: x, x2: x, y1: CV.BOT, y2: CV.BOT + 4 });
      if (h % every === 0 && x - CV.L > 34 && CV.R - x > 34) g += svgNS('text', { x, y: CV.BOT + 16, 'text-anchor': 'middle' }, esc(fmtH(t)));
    }
    if (partial) {
      g += svgNS('text', { x: (CV.L + CV.R) / 2, y: 247, 'text-anchor': 'middle', class: 'lbl-strong' }, today.rise != null ? `Sun rises at ${esc(fmtHM(today.rise))} and stays up — midnight sun begins (${durHMS(today.dayLen)} of daylight)` : today.set != null ? `Sun sets at ${esc(fmtHM(today.set))} — the midnight sun ends today` : `Transition day: ${durHMS(today.dayLen)} of daylight`);
    } else if (!today.polar) {
      g += svgNS('text', { x: CV.L, y: 247, class: 'lbl-strong' }, `↑ Sunrise ${esc(fmtHM(d0))}`);
      g += svgNS('text', { x: CV.R, y: 247, 'text-anchor': 'end', class: 'lbl-strong' }, `Sunset ${esc(fmtHM(d1))} ↓`);
    } else {
      g += svgNS('text', { x: (CV.L + CV.R) / 2, y: 247, 'text-anchor': 'middle', class: 'lbl-strong' }, today.polar === 'day' ? 'Polar day — the sun does not set today (local midnight → midnight)' : 'Polar night — the sun stays below the horizon today');
    }
    g += `<line id="stNowLine" class="now-line" x1="0" x2="0" y1="${CV.TOP}" y2="${CV.BOT}"/>
      <g id="stSunG"><circle class="sun-glow" r="15"/><circle class="sun-core" r="7"/><text id="stSunTxt" class="lbl-strong" text-anchor="middle" y="-20"></text></g>
      <g id="stHover" style="display:none"><line id="stHoverLine" class="hover-line" x1="0" x2="0" y1="${CV.TOP}" y2="${CV.BOT}"/><circle id="stHoverDot" class="hover-dot" r="5"/></g>`;
    $('#stCurve').innerHTML = g;
    $('#stCurveTip').hidden = true;

    // ---- sky dome ----
    let d = '';
    d += svgNS('circle', { class: 'dome-edge', cx: DM.C, cy: DM.C, r: DM.R });
    [30, 60].forEach((e) => {
      d += svgNS('circle', { class: 'dome-ring', cx: DM.C, cy: DM.C, r: (DM.R * (90 - e)) / 90 });
      d += svgNS('text', { x: DM.C + 3, y: DM.C - (DM.R * (90 - e)) / 90 + 11 }, e + '°');
    });
    d += svgNS('circle', { cx: DM.C, cy: DM.C, r: 2, fill: 'rgba(255,255,255,.5)' });
    [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([n, a]) => {
      const [x, y] = domePt(a, -1).map((v, i) => (i === 0 ? DM.C + (v - DM.C) * 1.11 : DM.C + (v - DM.C) * 1.11));
      d += svgNS('text', { x, y: y + 4, 'text-anchor': 'middle', class: 'lbl-strong' }, n);
    });
    const dp = [];
    for (let k = 0; k <= 144; k++) { const t = d0 + ((d1 - d0) * k) / 144; const p = SunCalc.position(t, lat, lon); if (p.el >= -0.3) dp.push(domePt(p.az, Math.max(0, p.el))); }
    if (dp.length > 1) d += svgNS('path', { class: 'track-future', d: 'M' + dp.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') });
    [[today.riseAz, '↑'], [today.setAz, '↓']].forEach(([az, s]) => {
      if (!num(az)) return;
      const [x, y] = domePt(az, 0);
      d += svgNS('line', { class: 'dome-ray', x1: DM.C, y1: DM.C, x2: x, y2: y });
      d += svgNS('circle', { class: 'ev-dot', cx: x, cy: y, r: 4 });
      const [lx, ly] = [DM.C + (x - DM.C) * 0.8, DM.C + (y - DM.C) * 0.8];
      d += svgNS('text', { x: lx, y: ly + 4, 'text-anchor': 'middle' }, `${s}${Math.round(az)}°`);
    });
    d += `<g id="stDomeSun"><circle class="sun-glow" r="13"/><circle class="sun-core" r="6"/></g>`;
    d += `<circle id="stDomeHover" class="hover-dot" r="5" style="display:none"/>`;
    $('#stDome').innerHTML = d;

    // ---- static stats ----
    const Yr = yearData(mid);
    const dl = today.dayLen, dly = dl - yday.dayLen, dlt = tmrw.dayLen - dl;
    const polarTxt = today.polar === 'day' ? 'Sun stays up all day (polar day)' : 'Sun stays below the horizon (polar night)';
    const noonAz = SunCalc.position(today.noon, lat, lon).az;
    const vsPeak = today.maxEl - Yr.el[Yr.iElMax];
    $('#stStats').innerHTML = `
      <div class="stat"><small>Elevation now</small><b id="stEl">–</b><span id="stElSub"></span></div>
      <div class="stat"><small>Azimuth now</small><b id="stAz">–</b><span id="stAzSub"></span></div>
      <div class="stat"><small>Shadow length</small><b id="stShadow">–</b><span id="stShadowSub"></span></div>
      <div class="stat"><small id="stCountLbl">Daylight left</small><b id="stCount">–</b><span id="stCountSub"></span></div>
      <div class="stat"><small>Sunrise</small><b>${today.polar ? '—' : esc(tOr(today.rise, 'No sunrise'))}</b><span>${today.polar ? polarTxt : `Azimuth ${azTxt(today.riseAz)} · civil dawn ${esc(tOr(today.civilDawn))}`}</span></div>
      <div class="stat"><small>Sunset</small><b>${today.polar ? '—' : esc(tOr(today.set, 'No sunset'))}</b><span>${today.polar ? polarTxt : `Azimuth ${azTxt(today.setAz)} · civil dusk ${esc(tOr(today.civilDusk))}`}</span></div>
      <div class="stat"><small>Solar noon</small><b>${esc(fmtHM(today.noon))}</b><span>Sun due ${dirName(noonAz)} (${Math.round(noonAz)}°) · ${deltaMS(today.noon - (mid - off + DAY / 2))} vs clock noon</span></div>
      <div class="stat"><small>Max sun angle · today</small><b>${fDeg(today.maxEl)}</b><span>${Math.abs(vsPeak) < 0.05 ? 'Highest of the year' : `${fDeg(vsPeak)} vs year peak`} · tomorrow ${fDeg(tmrw.maxEl)}</span></div>
      <div class="stat"><small>Max sun angle · ${Yr.yr}</small><b>${fDeg(Yr.el[Yr.iElMax])}</b><span>${Yr.zenith.length ? `Sun overhead on ${Yr.zenith.map(Yr.md).join(' & ')}` : `Peak ${Yr.md(Yr.iElMax)}`} · lowest noon ${fDeg(Yr.el[Yr.iElMin])} ${Yr.md(Yr.iElMin)}</span></div>
      <div class="stat"><small>Day length</small><b>${durHMS(dl)}</b><span>${deltaMS(dly)} vs yesterday · tomorrow ${deltaMS(dlt)}</span></div>
      <div class="stat"><small>Golden hour</small><b>${today.polar ? '—' : `${esc(tOr(today.goldenPmStart))}–${esc(tOr(today.set))}`}</b><span>${today.polar ? '' : `Morning ${esc(tOr(today.rise))}–${esc(tOr(today.goldenAmEnd))}`}</span></div>
      <div class="stat"><small>Twilight</small><b>${esc(tOr(today.astroDawn, '—'))} · ${esc(tOr(today.astroDusk, '—'))}</b><span>Astronomical dawn · dusk (sun 18° down)</span></div>`;
    const doy = Math.floor((mid - Date.UTC(new Date(mid).getUTCFullYear(), 0, 1)) / DAY) + 1;
    $('#stSub').textContent = `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'} · day ${doy} of the year · solar declination ${today.decl >= 0 ? '+' : '−'}${Math.abs(today.decl).toFixed(2)}° · equation of time ${deltaMS(today.eot * 60000)}`;

    buildYearChart(Yr);
  }

  const fDeg = (v) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}°`;
  const hmH = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };

  /** day length (h) and noon sun angle (°) for every day of the location's current year — cached per place/year */
  function yearData(mid) {
    const { lat, lon } = S.t; const off = S.t.offset ?? 0;
    const yr = new Date(mid).getUTCFullYear();
    const key = `${lat.toFixed(2)},${lon.toFixed(2)},${yr}`;
    const jan1 = Date.UTC(yr, 0, 1), nDays = (Date.UTC(yr + 1, 0, 1) - jan1) / DAY;
    if (!ST.yr || ST.yr.key !== key) {
      const dl = [], el = [], dec = [];
      for (let k = 0; k < nDays; k++) { const t = SunCalc.times(jan1 + k * DAY, lat, lon, off); dl.push(Math.max(0, Math.min(24, t.dayLen / HOUR))); el.push(t.maxEl); dec.push(t.decl); }
      // tropics: the sun is overhead on the day(s) the declination crosses the latitude. Noon sampling can
      // miss the exact crossing by up to ~0.2°, so those days are pinned to 90°.
      const zenith = [];
      if (Math.abs(lat) <= 23.45) for (let k = 0; k < nDays - 1; k++) {
        if ((dec[k] - lat) * (dec[k + 1] - lat) <= 0) { const z = Math.abs(dec[k] - lat) <= Math.abs(dec[k + 1] - lat) ? k : k + 1; if (!zenith.includes(z)) zenith.push(z); }
      }
      zenith.forEach((z) => { el[z] = 90; });
      const arg = (a, better) => a.reduce((b, v, k) => (better(v, a[b]) ? k : b), 0);
      ST.yr = {
        key, yr, jan1, nDays, dl, el, lat, lon, off,
        iMin: arg(dl, (a, b) => a < b), iMax: arg(dl, (a, b) => a > b),
        iElMin: arg(el, (a, b) => a < b), iElMax: arg(el, (a, b) => a > b),
        zenith,
        md: (k) => new Date(jan1 + k * DAY).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      };
    }
    ST.yr.todayK = Math.round((mid - jan1) / DAY);
    return ST.yr;
  }

  function buildYearChart(Yr) {
    const { yr, jan1, nDays, dl, el, todayK, iMin, iMax, iElMin, iElMax, md, zenith } = Yr;
    const yw = Math.max(300, Math.round($('#stYear').parentElement.clientWidth - 24));
    $('#stYear').setAttribute('viewBox', `0 0 ${yw} 150`);
    const W = { L: 34, R: yw - 34, TOP: 10, BOT: 118 };
    const X = (k) => W.L + (k / (nDays - 1)) * (W.R - W.L);
    const Yh = (h) => W.BOT - (h / 24) * (W.BOT - W.TOP);                       // day length axis (left, 0–24 h)
    const Ye = (e) => W.BOT - (clamp(e, 0, 90) / 90) * (W.BOT - W.TOP);         // sun angle axis (right, 0–90°)
    Object.assign(Yr, { W, X, Yh, Ye });
    let g = '';
    [0, 6, 12, 18, 24].forEach((h) => { g += svgNS('line', { class: 'grid-line', x1: W.L, x2: W.R, y1: Yh(h), y2: Yh(h) }) + svgNS('text', { x: W.L - 5, y: Yh(h) + 4, 'text-anchor': 'end' }, h + 'h'); });
    [0, 45, 90].forEach((e) => { g += svgNS('text', { x: W.R + 5, y: Ye(e) + 4, fill: '#ffc94d' }, e + '°'); });
    for (let m = 0; m < 12; m++) {
      const k = (Date.UTC(yr, m, 1) - jan1) / DAY;
      g += svgNS('line', { class: 'grid-line', x1: X(k), x2: X(k), y1: W.TOP, y2: W.BOT + 4 });
      g += svgNS('text', { x: X(k) + 3, y: W.BOT + 16 }, new Date(Date.UTC(yr, m, 1)).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }));
    }
    const ptsH = dl.map((v, k) => `${X(k).toFixed(1)},${Yh(v).toFixed(1)}`);
    const ptsE = el.map((v, k) => `${X(k).toFixed(1)},${Ye(v).toFixed(1)}`);
    g += svgNS('path', { class: 'yr-area', d: `M${W.L},${Yh(0)}L${ptsH.join('L')}L${W.R},${Yh(0)}Z` });
    g += svgNS('path', { class: 'yr-line', d: 'M' + ptsH.join('L') });
    g += svgNS('path', { class: 'yr-el', d: 'M' + ptsE.join('L') });
    [iMin, iMax].forEach((k) => { g += svgNS('circle', { class: 'yr-ext', cx: X(k), cy: Yh(dl[k]), r: 3.5 }); });
    [iElMin, ...(zenith.length ? zenith : [iElMax])].forEach((k) => { g += svgNS('circle', { class: 'yr-el-ext', cx: X(k), cy: Ye(el[k]), r: 3.5 }); });
    const tx = X(todayK), ty = Yh(dl[todayK] ?? 0);
    g += svgNS('line', { class: 'yr-today', x1: tx, x2: tx, y1: W.TOP, y2: W.BOT });
    g += svgNS('circle', { class: 'yr-dot', cx: tx, cy: ty, r: 5 });
    g += svgNS('circle', { class: 'yr-dot', cx: tx, cy: Ye(el[todayK] ?? 0), r: 5 });
    g += svgNS('text', { x: tx + (tx > W.R - 150 ? -8 : 8), y: W.TOP + 10, 'text-anchor': tx > W.R - 150 ? 'end' : 'start', class: 'lbl-strong' }, `Today ${hmH(dl[todayK] ?? 0)} · ${fDeg(el[todayK] ?? 0)}`);
    g += `<g id="stYearHover" style="display:none"><line id="stYHLine" class="hover-line" x1="0" x2="0" y1="${W.TOP}" y2="${W.BOT}"/>
      <circle id="stYHDay" class="hover-dot" r="4.5" stroke="#7cc4ff"/><circle id="stYHEl" class="hover-dot" r="4.5" stroke="#ffc94d"/></g>`;
    $('#stYear').innerHTML = g;
    $('#stYearTip').hidden = true;
    const nSun = dl.filter((v) => v >= 23.99).length, nNight = dl.filter((v) => v <= 0.01).length;
    $('#stYearNote').textContent = [
      nSun ? `Midnight sun ${nSun} days/yr` : `Longest ${md(iMax)} · ${hmH(dl[iMax])}`,
      nNight ? `Polar night ${nNight} days/yr` : `Shortest ${md(iMin)} · ${hmH(dl[iMin])}`,
      zenith.length ? `Sun overhead (90°) ${zenith.map(md).join(' & ')}` : `Highest sun ${md(iElMax)} · ${fDeg(el[iElMax])}`,
    ].join('  ·  ');
  }

  /* ---- hover tooltips (past/future sun angle, any day of the year) ---- */
  function svgX(svg, e) {
    const r = svg.getBoundingClientRect(); const vb = svg.viewBox.baseVal;
    return ((e.clientX - r.left) * vb.width) / r.width;
  }
  function placeTip(tip, svg, sx, sy) {
    tip.hidden = false;
    const r = svg.getBoundingClientRect(), pr = tip.parentElement.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    const px = r.left - pr.left + (sx * r.width) / vb.width, py = r.top - pr.top + (sy * r.height) / vb.height;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = px + 16; if (left + w > pr.width - 4) left = px - 16 - w;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = clamp(py - h / 2, 4, Math.max(4, pr.height - h - 4)) + 'px';
  }
  const relTag = (t) => { const d = t - Date.now(); return Math.abs(d) < 60e3 ? 'now' : d > 0 ? `in ${dur(d)}` : `${dur(d)} ago`; };

  function curveHover(e) {
    if (!ST.today || !ST.X) return;
    const svg = $('#stCurve'); const x = svgX(svg, e);
    const t = ST.d0 + clamp((x - CV.L) / (CV.R - CV.L), 0, 1) * (ST.d1 - ST.d0);
    const p = SunCalc.position(t, ST.lat, ST.lon);
    const sx = ST.X(t), sy = ST.Y(p.el);
    $('#stHover').style.display = '';
    $('#stHoverLine').setAttribute('x1', sx.toFixed(1)); $('#stHoverLine').setAttribute('x2', sx.toFixed(1));
    $('#stHoverDot').setAttribute('cx', sx.toFixed(1)); $('#stHoverDot').setAttribute('cy', sy.toFixed(1));
    const [dx, dy] = domePt(p.az, p.el); const dh = $('#stDomeHover');
    dh.style.display = ''; dh.setAttribute('cx', dx.toFixed(1)); dh.setAttribute('cy', dy.toFixed(1));
    const shadow = p.el > 0.5 ? `${(1 / Math.tan(p.el * Math.PI / 180)).toFixed(2)}× height` : '—';
    const tip = $('#stCurveTip');
    tip.innerHTML = `<b>${esc(fmtDay(t))} ${esc(fmtDate(t))}, ${esc(fmtHM(t))}<span class="tag">${relTag(t)}</span></b>
      <div><i style="background:#ffc94d"></i>Sun angle: ${fDeg(p.el)}</div>
      <div><i style="background:#7cc4ff"></i>Azimuth: ${azTxt(p.az)}</div>
      <div><i style="background:#9aa7c2"></i>Shadow: ${shadow}</div>
      <div><i style="background:#ff8a5b"></i>${SunCalc.phase(p.el)}</div>`;
    placeTip(tip, svg, sx, sy);
  }
  function curveLeave() {
    const h = $('#stHover'); if (h) h.style.display = 'none';
    const dh = $('#stDomeHover'); if (dh) dh.style.display = 'none';
    $('#stCurveTip').hidden = true;
  }

  function yearHover(e) {
    const Yr = ST.yr; if (!Yr || !Yr.X) return;
    const svg = $('#stYear'); const x = svgX(svg, e);
    const k = clamp(Math.round(((x - Yr.W.L) / (Yr.W.R - Yr.W.L)) * (Yr.nDays - 1)), 0, Yr.nDays - 1);
    const sx = Yr.X(k);
    $('#stYearHover').style.display = '';
    $('#stYHLine').setAttribute('x1', sx.toFixed(1)); $('#stYHLine').setAttribute('x2', sx.toFixed(1));
    $('#stYHDay').setAttribute('cx', sx.toFixed(1)); $('#stYHDay').setAttribute('cy', Yr.Yh(Yr.dl[k]).toFixed(1));
    $('#stYHEl').setAttribute('cx', sx.toFixed(1)); $('#stYHEl').setAttribute('cy', Yr.Ye(Yr.el[k]).toFixed(1));
    const day = Yr.jan1 + k * DAY; const ev = SunCalc.times(day, Yr.lat, Yr.lon, Yr.off);
    const rel = k - Yr.todayK;
    const tag = rel === 0 ? 'today' : rel === 1 ? 'tomorrow' : rel === -1 ? 'yesterday' : rel > 0 ? `in ${rel} days` : `${-rel} days ago`;
    const dDl = (Yr.dl[k] - Yr.dl[Yr.todayK]) * HOUR;
    const tip = $('#stYearTip');
    tip.innerHTML = `<b>${new Date(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}<span class="tag">${tag}</span></b>
      <div><i style="background:#7cc4ff"></i>Day length: ${hmH(Yr.dl[k])}${rel ? ` (${dDl >= 0 ? '+' : '−'}${hmH(Math.abs(dDl) / HOUR)} vs today)` : ''}</div>
      <div><i style="background:#ffc94d"></i>Max sun angle: ${Yr.zenith.includes(k) ? `90° — sun directly overhead (zenith passage) at ${esc(fmtHM(ev.noon))}` : `${fDeg(Yr.el[k])} at ${esc(fmtHM(ev.noon))}`}</div>
      <div><i style="background:#ff9a3d"></i>${ev.polar === 'day' ? 'Midnight sun — no sunset' : ev.polar === 'night' ? 'Polar night — no sunrise' : ev.rise == null && ev.set == null ? 'Sunrise/sunset transition day' : `Sunrise ${esc(tOr(ev.rise, 'none'))} · sunset ${esc(tOr(ev.set, 'none'))}`}</div>`;
    placeTip(tip, svg, sx, Yr.Ye(Yr.el[k]));
  }
  function yearLeave() {
    const h = $('#stYearHover'); if (h) h.style.display = 'none';
    $('#stYearTip').hidden = true;
  }
  [['#stCurve', curveHover, curveLeave], ['#stYear', yearHover, yearLeave]].forEach(([sel, move, leave]) => {
    const el = $(sel);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', move);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('pointercancel', leave);
  });

  /** live part — runs every second */
  function updateSunTracker() {
    if (!S.t || typeof SunCalc === 'undefined') return;
    const now = Date.now(); const mid = localMidnightUTC(now);
    const key = `${S.t.lat.toFixed(4)},${S.t.lon.toFixed(4)},${TZ},${mid}`;
    if (ST.key !== key) { ST.key = key; buildSunTracker(mid); }
    const { today, tmrw, d0, d1, X, Y } = ST;
    const p = SunCalc.position(now, S.t.lat, S.t.lon);
    const up = p.el > -0.833 + 0.27; // apparent elevation of the sun's centre at rise/set ≈ −0.56°
    const x = X(clamp(now, d0, d1)), y = Y(p.el);

    const sunG = $('#stSunG'); if (!sunG) return;
    sunG.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    sunG.classList.toggle('sun-down', p.el < 0);
    const txt = $('#stSunTxt'); txt.textContent = `${p.el.toFixed(1)}°`; txt.setAttribute('y', p.el < 0 ? 30 : -20);
    const nl = $('#stNowLine'); nl.setAttribute('x1', x.toFixed(1)); nl.setAttribute('x2', x.toFixed(1)); nl.style.display = now >= d0 && now <= d1 ? '' : 'none';
    $('#stClipRect').setAttribute('width', Math.max(0, x - CV.L).toFixed(1));

    const [dx, dy] = domePt(p.az, p.el);
    const ds = $('#stDomeSun'); ds.setAttribute('transform', `translate(${dx.toFixed(1)} ${dy.toFixed(1)})`); ds.classList.toggle('sun-down', p.el < 0);

    // countdown to the next event
    let lbl, target, sub;
    if (today.polar === 'day') { lbl = 'Polar day'; target = null; sub = 'Sun stays up all day'; }
    else if (today.polar === 'night') { lbl = 'Polar night'; target = null; sub = 'Sun stays below the horizon'; }
    else if (ST.whole) { lbl = 'Daylight today'; target = null; sub = today.rise != null ? `Midnight sun from ${fmtHM(today.rise)}` : today.set != null ? `First sunset after the midnight sun, at ${fmtHM(today.set)}` : 'Transition day'; $('#stCount').textContent = durHMS(today.dayLen); }
    else if (now < today.rise) { lbl = 'Sunrise in'; target = today.rise; sub = `Sunrise at ${fmtHM(today.rise)}`; }
    else if (now < today.set) { lbl = 'Daylight left'; target = today.set; sub = `${Math.round(((now - today.rise) / today.dayLen) * 100)}% of daylight elapsed`; }
    else { lbl = 'Sunrise in'; target = tmrw.rise; sub = num(tmrw.rise) ? `Tomorrow at ${fmtHM(tmrw.rise)}` : 'No sunrise tomorrow'; }
    $('#stCountLbl').textContent = lbl;
    if (!ST.whole || today.polar) $('#stCount').textContent = num(target) ? durHMS(target - now) : '—';
    $('#stCountSub').textContent = sub;

    const ph = SunCalc.phase(p.el);
    $('#stEl').textContent = `${p.el >= 0 ? '' : '−'}${Math.abs(p.el).toFixed(2)}°`;
    $('#stElSub').textContent = up ? `${ph} · ${p.ha < 0 ? 'rising' : 'descending'}` : `${ph} · below horizon`;
    $('#stAz').textContent = `${p.az.toFixed(1)}°`;
    $('#stAzSub').textContent = `${dirName(p.az)} · ${p.ha < 0 ? 'before' : 'after'} solar noon`;
    if (p.el > 0.5) {
      const r = 1 / Math.tan(p.el * Math.PI / 180);
      $('#stShadow').textContent = `${r < 10 ? r.toFixed(2) : Math.round(r)}× height`;
      $('#stShadowSub').textContent = `A 1.7 m person casts ${(1.7 * r).toFixed(1)} m · pointing ${dirName((p.az + 180) % 360)}`;
    } else { $('#stShadow').textContent = '—'; $('#stShadowSub').textContent = 'Sun too low for a defined shadow'; }
    $('#stPhase').textContent = `${ph}${num(target) ? ` · ${lbl.toLowerCase()} ${dur(target - now)}` : ''}`;
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
      if (!document.hidden) updateSunTracker();
    }
    if (Date.now() >= S.nextFetch && !document.hidden && !S.fetching) refresh('auto');
  }

  /* ---------------- live feed ---------------- */
  const FEED_ICON = { info: '•', alert: '☔', warn: '⚠️', err: '⚠️', good: '✓' };
  function feed(kind, icon, msg) {
    S.feed.unshift({ t: Date.now(), kind, icon: icon || FEED_ICON[kind], msg });
    const fb = document.getElementById("feedBadge"); if (fb && document.getElementById("app").dataset.active !== "feed") fb.hidden = false;
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
        loc.name && loc.cc ? null : reverseGeocode(loc).catch(() => null),
      ]);
      if (token !== S.fetchToken) return; // superseded by a newer request
      if (place) Object.assign(loc, place);
      store.set('lastLoc', { lat: loc.lat, lon: loc.lon, name: loc.name, sub: loc.sub, cc: loc.cc, country: loc.country, admins: loc.admins });
      S.t = processData(fc); S.t.offset = fc.utc_offset_seconds * 1000; S.t.lat = loc.lat; S.t.lon = loc.lon; S.aq = aq;
      S.lastFetch = Date.now(); S.nextFetch = S.lastFetch + REFRESH_MS;
      const first = !S.prevSnap;
      renderAll();
      if (first) {
        $('#app').setAttribute('aria-busy', 'false');
        feed('info', '🛰️', `Loaded ${fc.hourly.time.length} hours of data (2 days past → 8 days ahead) for ${loc.name || 'this point'}, grid elevation ${Math.round(fc.elevation)} m`);
      }
      feedAfterRefresh(reason);
      hideGate();
      updateHazards(token);
    } catch (e) {
      if (token !== S.fetchToken) return;
      S.nextFetch = Date.now() + 60e3;
      feed('err', '⚠️', `Update failed (${e.message}). Retrying in 1 minute.`);
      if (!S.t) gateFail('Could not load weather data', `${e.message}. Check your connection and try again.`);
    } finally {
      if (token === S.fetchToken) { S.fetching = false; $('#refreshBtn').classList.remove('spin'); tick(); }
    }
  }

  /* ---------------- hazards: cyclones + warnings ---------------- */
  const LVN = { red: 3, orange: 2, yellow: 1, info: 0 };
  async function updateHazards(token = S.fetchToken) {
    if (!S.t || typeof Hazards === 'undefined') return;
    const loc = S.loc;
    try {
      const hz = await Hazards.update({ loc: { lat: S.t.lat, lon: S.t.lon }, t: S.t, cc: loc.cc, countryName: loc.country, admins: loc.admins });
      if (token !== S.fetchToken) return;
      S.hz = hz;
    } catch (e) { console.warn('hazards', e); return; }
    applyFx();
    S.umb = computeUmbrella(); renderUmbrella();
    const w = S.hz.warnings.filter((x) => LVN[x.level] >= 1);
    const badge = $('#alertBadge');
    badge.hidden = !w.length; badge.textContent = w.length;
    badge.classList.toggle('amber', !w.some((x) => LVN[x.level] >= 2));
    S.hz.warnings.forEach((x) => {
      if (LVN[x.level] >= 2 || x.source === 'official') once('w-' + x.id + x.level, () => feed(LVN[x.level] >= 2 ? 'warn' : 'alert', x.icon || '⚠️', `${x.source === 'official' ? 'Official' : 'Forecast'} ${x.level} warning — ${x.title}. ${x.text}`));
    });
    const th = S.hz.threat;
    if (th) once(`tc-${th.s.key}-${th.level}`, () => feed('warn', '🌀', `${th.s.classText || 'Tropical cyclone'} ${th.s.name}: ${th.level === 'direct' ? 'direct threat' : th.level === 'near' ? 'close pass' : 'approaching'} — now ${Math.round(th.dNow).toLocaleString()} km away; closest approach ${Math.round(th.cpa.dKm)} km at ${fmtDay(th.cpa.t)} ${fmtHM(th.cpa.t)}.`));
  }

  /* ---------------- weather effects ---------------- */
  function applyFx() {
    if (!S.t || typeof FX === 'undefined') return;
    const c = S.t.cur, code = c.wc, pr = c.pr || 0;
    let kind = 'none', intensity = 0.5, hail = false;
    if (code >= 95) { kind = 'storm'; intensity = code === 95 ? 0.75 : 1; hail = code !== 95; }
    else if (code === 82) { kind = 'heavy'; intensity = 1; }
    else if (code === 65 || code === 67) { kind = 'heavy'; intensity = 0.85; }
    else if (code === 63 || code === 81 || code === 66) { kind = 'rain'; intensity = 0.75; }
    else if (code === 61 || code === 80) { kind = 'rain'; intensity = 0.4; }
    else if (code >= 51 && code <= 57) { kind = 'drizzle'; intensity = code === 51 || code === 56 ? 0.45 : code === 53 ? 0.7 : 0.95; }
    else if (isSnow(code)) { kind = 'snow'; intensity = code === 71 || code === 85 ? 0.4 : code === 73 ? 0.7 : 1; }
    else if (code === 45 || code === 48) kind = 'fog';
    else if (code === 2 || code === 3) kind = 'clouds';
    else if (!c.day) kind = 'stars';
    if (pr >= 0.1 && ['none', 'clouds', 'stars', 'fog'].includes(kind)) { kind = pr >= 4 ? 'heavy' : pr >= 0.6 ? 'rain' : 'drizzle'; intensity = Math.min(1, 0.3 + pr / 5); }
    else if (kind === 'rain') intensity = Math.max(intensity, Math.min(1, pr / 4));
    if (S.hz?.cyclone) { kind = 'cyclone'; intensity = Math.min(1, 0.5 + (S.hz.tcWindowKt(1) || 0) / 130); }
    const force = new URLSearchParams(location.search).get('fx');
    if (force) {
      kind = { moderate: 'rain', light: 'rain', hail: 'storm', thunder: 'storm' }[force] || force;
      intensity = { light: 0.35, moderate: 0.75, drizzle: 0.8, heavy: 1, storm: 0.9, hail: 1, cyclone: 1 }[force] ?? 0.7;
      hail = force === 'hail';
    }
    FX.set({ kind, intensity, hail, windKmh: kind === 'cyclone' ? Math.max(c.ws, 90) : c.ws, windFromDeg: c.wd, isDay: c.day,
      hemisphere: S.hz?.hemisphere || (S.t.lat < 0 ? 'S' : 'N'), stormBearing: S.hz?.stormBearing });
    setScene(kind === 'cyclone' ? 'cyclone' : WX.scene(code, c.day));
  }
  function setScene(name) {
    document.body.classList.forEach((k) => { if (k.startsWith('scene-')) document.body.classList.remove(k); });
    document.body.classList.add('scene-' + name);
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
  let gateTimer;
  const openGate = () => { clearTimeout(gateTimer); $('#gate').hidden = false; $('#gate').classList.remove('hide'); };
  function showGate(title, msg) {
    openGate(); $('#gateTitle').textContent = title; $('#gateMsg').textContent = msg;
    $('#gateSpinner').classList.remove('off'); $('#gateActions').hidden = true;
  }
  function gateFail(title, msg = '') {
    openGate(); $('#gateTitle').textContent = title; $('#gateMsg').textContent = msg;
    $('#gateSpinner').classList.add('off'); $('#gateActions').hidden = false;
    $('#liveText').textContent = 'No location'; $('#livePill').className = 'live-pill error';
  }
  const hideGate = () => { $('#gate').classList.add('hide'); clearTimeout(gateTimer); gateTimer = setTimeout(() => { $('#gate').hidden = true; }, 450); };
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
    setLocation({ lat: r.latitude, lon: r.longitude, name: r.name, sub: [r.admin1, r.country].filter(Boolean).join(', '), source: 'search',
      cc: r.country_code, country: r.country, admins: [...new Set([r.name, r.admin4, r.admin3, r.admin2, r.admin1].filter(Boolean))] }, `Switched to ${r.name}${r.country ? ', ' + r.country : ''}`);
    document.body.classList.remove('search-open');
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
    renderAll(); renderFeed(); updateHazards();
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

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { ST.key = null; updateSunTracker(); }, 200); // sun SVGs are sized in real pixels
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.loc && Date.now() - S.lastFetch > REFRESH_MS) refresh('auto');
  });

  /* ---------------- phone app shell: tabs, gestures, search, install ---------------- */
  const TABS = ['now', 'forecast', 'alerts', 'sun', 'feed'];
  const TAB_TITLE = { now: '', forecast: 'Forecast', alerts: 'Alerts & storms', sun: 'Sun & daylight', feed: 'Live feed' };
  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
  const tabScroll = {};
  function setTab(name, { remember = true } = {}) {
    const main = $('#app'), prev = main.dataset.active;
    if (!TABS.includes(name)) name = 'now';
    if (prev === name) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    tabScroll[prev] = window.scrollY;
    main.dataset.active = name;
    document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $('#tabTitle').textContent = TAB_TITLE[name] + (TAB_TITLE[name] && S.loc?.name ? ` · ${S.loc.name}` : '');
    if (remember) store.set('tab', name);
    if (name === 'feed') $('#feedBadge').hidden = true;
    window.scrollTo(0, isPhone() ? tabScroll[name] || 0 : window.scrollY);
    // components measured while hidden need a re-layout once visible
    requestAnimationFrame(() => {
      if (name === 'forecast' && S.t) renderChart();
      if (name === 'sun') { ST.key = null; updateSunTracker(); }
      if (name === 'alerts' && typeof Hazards !== 'undefined') Hazards.refreshMap();
    });
  }
  $('#tabbar').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });

  // horizontal swipe between tabs (ignores swipes that start on scrollable/interactive widgets)
  let sw = null;
  $('#app').addEventListener('touchstart', (e) => {
    if (!isPhone() || e.touches.length !== 1 || e.target.closest('.hourly, .chart-wrap, svg, .seg, .tc-map-wrap, .tc-table-wrap, input, .leaflet-container')) { sw = null; return; }
    sw = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  $('#app').addEventListener('touchend', (e) => {
    if (!sw) return;
    const dx = e.changedTouches[0].clientX - sw.x, dy = e.changedTouches[0].clientY - sw.y;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45 && Date.now() - sw.t < 600) {
      const i = TABS.indexOf($('#app').dataset.active) + (dx < 0 ? 1 : -1);
      if (i >= 0 && i < TABS.length) setTab(TABS[i]);
    }
    sw = null;
  }, { passive: true });

  // pull to refresh (phones)
  let ptr = null;
  const ptrEl = $('#ptr');
  window.addEventListener('touchstart', (e) => { ptr = isPhone() && window.scrollY <= 0 && !document.body.classList.contains('search-open') && !e.target.closest('.tc-map-wrap, .leaflet-container') ? { y: e.touches[0].clientY, d: 0 } : null; }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (!ptr) return;
    ptr.d = Math.max(0, e.touches[0].clientY - ptr.y);
    if (ptr.d > 6) { ptrEl.style.opacity = Math.min(1, ptr.d / 80); ptrEl.style.transform = `translateY(${Math.min(70, ptr.d * 0.6) - 60}px) rotate(${ptr.d * 3}deg)`; }
  }, { passive: true });
  window.addEventListener('touchend', () => {
    if (!ptr) return;
    const go = ptr.d > 90; ptr = null;
    if (go) {
      ptrEl.classList.add('spin'); ptrEl.style.transform = 'translateY(10px)';
      refresh('manual').finally(() => setTimeout(() => { ptrEl.classList.remove('spin'); ptrEl.style.opacity = 0; ptrEl.style.transform = 'translateY(-60px)'; }, 300));
    } else { ptrEl.style.opacity = 0; ptrEl.style.transform = 'translateY(-60px)'; }
  });

  // search sheet on phones
  $('#searchToggle').addEventListener('click', () => {
    const open = document.body.classList.toggle('search-open');
    if (open) setTimeout(() => input.focus(), 30); else input.blur();
  });
  input.addEventListener('blur', () => setTimeout(() => { if (!input.value) document.body.classList.remove('search-open'); }, 200));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.body.classList.remove('search-open'); });

  // install as an app (PWA)
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#installBtn').hidden = false; });
  $('#installBtn').addEventListener('click', async () => {
    if (!installEvt) return;
    installEvt.prompt(); await installEvt.userChoice.catch(() => null); installEvt = null; $('#installBtn').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; toast('SkyPulse installed ✓'); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  /* ---------------- boot ---------------- */
  if (typeof Hazards !== 'undefined') Hazards.init({ esc, fmtHM, fmtDay, fmtDate, fT, fW, wU, fP, pU, dirName, dur, ago, getJSON, unit: () => S.unit });
  setTab(new URLSearchParams(location.search).get('tab') || store.get('tab', 'now'), { remember: false });
  setSeg('.top-actions .seg', 'unit', S.unit);
  setSeg('#umbWin', 'h', S.umbWin);
  $('#thrInput').value = S.umbThr; $('#thrVal').textContent = S.umbThr + '%';
  setInterval(tick, 1000);
  setInterval(() => { if (S.t) { renderSun(); checkUpcoming(); renderFeed(); } }, 30e3);
  feed('info', '👋', 'SkyPulse started — requesting your location');
  startGPS();
})();
