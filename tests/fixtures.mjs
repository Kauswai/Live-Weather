// Synthetic API responses for the SkyPulse smoke test. Every generator reads the request URL the
// app built, so the fixtures follow whatever variables / time ranges the app actually asks for.

const HOUR = 3600e3, DAY = 86400e3, Q = 15 * 60e3;

/** UTC offset (ms) of an IANA zone at an instant */
export function tzOffset(tz, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(ms).filter((x) => x.type !== 'literal').map((x) => [x.type, +x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

export const PLACES = {
  nyc: { lat: 40.7128, lon: -74.006, tz: 'America/New_York', abbr: 'EDT', city: 'New York', sub: 'New York', cc: 'US', country: 'United States of America', elev: 12 },
  berlin: { lat: 52.52, lon: 13.405, tz: 'Europe/Berlin', abbr: 'CEST', city: 'Berlin', sub: 'Berlin', cc: 'DE', country: 'Germany', elev: 38 },
  miami: { lat: 25.7617, lon: -80.1918, tz: 'America/New_York', abbr: 'EDT', city: 'Miami', sub: 'Florida', cc: 'US', country: 'United States of America', elev: 2 },
  delhi: { lat: 28.6139, lon: 77.209, tz: 'Asia/Kolkata', abbr: 'IST', city: 'New Delhi', sub: 'Delhi', cc: 'IN', country: 'India', elev: 216 },
  tokyo: { lat: 35.6762, lon: 139.6503, tz: 'Asia/Tokyo', abbr: 'JST', city: 'Tokyo', sub: 'Tokyo', cc: 'JP', country: 'Japan', elev: 40 },
};

/** weather "shape" per scenario: functions of hours-from-now (h) and local hour (lh) */
const SHAPES = {
  calm: { t: (h, lh) => 14 + 6 * Math.sin(((lh - 9) / 24) * 2 * Math.PI), pr: () => 0, pp: () => 5, ws: () => 9, wg: () => 18, wc: () => 1, cc: () => 20, vis: () => 24000, rh: () => 55 },
  rain: { t: (h, lh) => 11 + 3 * Math.sin(((lh - 9) / 24) * 2 * Math.PI), pr: (h) => (h > 0.5 && h < 7 ? 3.2 : h > 20 && h < 24 ? 1 : 0), pp: (h) => (h > 0 && h < 8 ? 85 : 30),
    ws: (h) => (h < 10 ? 38 : 20), wg: (h) => (h < 10 ? 68 : 35), wc: (h) => (h > 0.5 && h < 7 ? 63 : 3), cc: () => 95, vis: () => 8000, rh: () => 92 },
  cyclone: { t: () => 27, pr: (h) => (h > 2 && h < 30 ? 12 : 2), pp: () => 95, ws: (h) => (h < 30 ? 70 : 30), wg: (h) => (h < 30 ? 120 : 50), wc: (h) => (h < 30 ? 82 : 61), cc: () => 100, vis: () => 3000, rh: () => 94 },
  heat: { t: (h, lh) => 38 + 7 * Math.sin(((lh - 9) / 24) * 2 * Math.PI), at: (h, lh) => 44 + 8 * Math.sin(((lh - 9) / 24) * 2 * Math.PI), pr: () => 0, pp: () => 3, ws: () => 12, wg: () => 25, wc: () => 0, cc: () => 5, vis: () => 6000, rh: () => 30 },
  storm: { t: () => 22, pr: (h) => (h > 1 && h < 4 ? 28 : 0), pp: (h) => (h > 0 && h < 5 ? 90 : 20), ws: () => 25, wg: (h) => (h > 1 && h < 4 ? 80 : 30), wc: (h) => (h > 1 && h < 4 ? 96 : 2), cc: () => 70, vis: () => 15000, rh: () => 75 },
};

function series(name, shape, h, lh, place) {
  const t = shape.t(h, lh);
  switch (name) {
    case 'temperature_2m': return +t.toFixed(1);
    case 'apparent_temperature': return +(shape.at ? shape.at(h, lh) : t - 1.5).toFixed(1);
    case 'dew_point_2m': return +(t - 6).toFixed(1);
    case 'relative_humidity_2m': return Math.round(shape.rh(h));
    case 'precipitation_probability': return Math.round(shape.pp(h));
    case 'precipitation': case 'rain': return +shape.pr(h).toFixed(1);
    case 'showers': case 'snowfall': return 0;
    case 'weather_code': return shape.wc(h);
    case 'pressure_msl': return +(1012 - (shape === SHAPES.cyclone ? 18 : 0) + Math.sin(h / 9)).toFixed(1);
    case 'cloud_cover': return Math.round(shape.cc(h));
    case 'cloud_cover_low': return Math.round(shape.cc(h) * 0.6);
    case 'cloud_cover_mid': return Math.round(shape.cc(h) * 0.4);
    case 'cloud_cover_high': return Math.round(shape.cc(h) * 0.3);
    case 'visibility': return shape.vis(h);
    case 'wind_speed_10m': return +shape.ws(h).toFixed(1);
    case 'wind_direction_10m': return 240;
    case 'wind_gusts_10m': return +shape.wg(h).toFixed(1);
    case 'uv_index': return lh > 6 && lh < 18 ? +(8 * Math.sin(((lh - 6) / 12) * Math.PI)).toFixed(1) : 0;
    case 'is_day': return lh >= 7 && lh < 19 ? 1 : 0;
    case 'lightning_potential': return 0;
    case 'relative_humidity_850hPa': return Math.round(Math.min(100, shape.rh(h) - 5));
    case 'relative_humidity_700hPa': return Math.round(shape.rh(h) * 0.7);
    case 'relative_humidity_500hPa': return Math.round(shape === SHAPES.calm ? 22 : shape.rh(h) * 0.6);
    case 'relative_humidity_300hPa': return Math.round(shape === SHAPES.calm ? 18 : shape.rh(h) * 0.5);
    default: return 0;
  }
}

export function forecast(url, scenario, place, now = Date.now()) {
  const q = new URL(url).searchParams;
  const shape = SHAPES[scenario] || SHAPES.calm;
  const off = tzOffset(place.tz, now);
  const pastDays = +(q.get('past_days') || 0), fcDays = +(q.get('forecast_days') || 7);
  const localMid = Math.floor((now + off) / DAY) * DAY - off;            // today's local midnight (UTC ms)
  const start = localMid - pastDays * DAY, end = localMid + fcDays * DAY;
  const lhOf = (ms) => (((ms + off) % DAY) + DAY) % DAY / HOUR;
  const out = {
    latitude: +q.get('latitude'), longitude: +q.get('longitude'), generationtime_ms: 0.5, utc_offset_seconds: off / 1000,
    timezone: place.tz, timezone_abbreviation: place.abbr, elevation: place.elev,
  };
  const hv = (q.get('hourly') || '').split(',').filter(Boolean);
  if (hv.length) {
    const time = []; for (let t = start; t < end; t += HOUR) time.push(t / 1000);
    out.hourly = { time };
    for (const v of hv) out.hourly[v] = time.map((s) => series(v, shape, (s * 1000 - now) / HOUR, lhOf(s * 1000), place));
  }
  const mv = (q.get('minutely_15') || '').split(',').filter(Boolean);
  if (mv.length) {
    const fq = q.get('forecast_minutely_15'), pq = q.get('past_minutely_15');
    const q0 = Math.floor(now / Q) * Q;
    const a = pq != null ? q0 - +pq * Q : start, b = fq != null ? q0 + +fq * Q : end;
    const time = []; for (let t = a; t < b; t += Q) time.push(t / 1000);
    out.minutely_15 = { time };
    for (const v of mv) out.minutely_15[v] = time.map((s) => { const x = series(v, shape, (s * 1000 - now) / HOUR, lhOf(s * 1000), place); return /precip|rain|snow/.test(v) ? +(x / 4).toFixed(2) : x; });
  }
  const cv = (q.get('current') || '').split(',').filter(Boolean);
  if (cv.length) {
    const t0 = Math.floor(now / Q) * Q;
    out.current = { time: t0 / 1000, interval: 900 };
    for (const v of cv) out.current[v] = series(v, shape, 0, lhOf(now), place);
  }
  const dv = (q.get('daily') || '').split(',').filter(Boolean);
  if (dv.length) {
    const time = []; for (let t = start; t < end; t += DAY) time.push(t / 1000);
    out.daily = { time };
    for (const v of dv) out.daily[v] = time.map((s) => {
      const ms = s * 1000, hs = Array.from({ length: 24 }, (_, k) => ms + k * HOUR);
      const vals = (n) => hs.map((x) => series(n, shape, (x - now) / HOUR, lhOf(x), place));
      switch (v) {
        case 'sunrise': return (ms + 6.6 * HOUR) / 1000;
        case 'sunset': return (ms + 18.2 * HOUR) / 1000;
        case 'temperature_2m_max': return Math.max(...vals('temperature_2m'));
        case 'temperature_2m_min': return Math.min(...vals('temperature_2m'));
        case 'precipitation_sum': return +vals('precipitation').reduce((x, y) => x + y, 0).toFixed(1);
        case 'precipitation_probability_max': return Math.max(...vals('precipitation_probability'));
        case 'wind_gusts_10m_max': return Math.max(...vals('wind_gusts_10m'));
        case 'uv_index_max': return Math.max(...vals('uv_index'));
        case 'weather_code': return Math.max(...vals('weather_code'));
        default: return 0;
      }
    });
  }
  return out;
}

export const airQuality = (scenario) => ({ current: { time: Math.floor(Date.now() / 1000), us_aqi: scenario === 'heat' ? 178 : 42, pm2_5: scenario === 'heat' ? 96 : 8.4, pm10: 20,
  aerosol_optical_depth: scenario === 'heat' ? 0.72 : scenario === 'calm' ? 0.07 : 0.24, dust: scenario === 'heat' ? 95 : 3 } });

export const reverse = (place) => ({
  city: place.city, locality: place.city, principalSubdivision: place.sub, countryName: place.country, countryCode: place.cc,
  localityInfo: { administrative: [{ adminLevel: 6, name: place.city }] },
});

export const search = (q) => ({
  results: [
    { name: 'Tokyo', latitude: 35.6895, longitude: 139.69171, country: 'Japan', country_code: 'JP', admin1: 'Tokyo' },
    { name: 'Berlin', latitude: 52.52437, longitude: 13.41053, country: 'Germany', country_code: 'DE', admin1: 'Land Berlin' },
  ].filter((r) => r.name.toLowerCase().startsWith(q.toLowerCase().slice(0, 2))),
});

/** Open-Meteo elevation for the coastline probe: sea to the east for Miami / NYC */
export function elevation(url, place) {
  const q = new URL(url).searchParams;
  const la = q.get('latitude').split(',').map(Number), lo = q.get('longitude').split(',').map(Number);
  const coastal = place.city === 'Miami' || place.city === 'New York';
  return { elevation: la.map((_, i) => (coastal && lo[i] > place.lon + 0.03 ? 0 : place.elev)) };
}

export function marine(url) {
  const q = new URL(url).searchParams, n = 6 * 24, t0 = Math.floor(Date.now() / HOUR) * HOUR;
  const time = Array.from({ length: n }, (_, k) => (t0 + k * HOUR) / 1000);
  return { latitude: +q.get('latitude'), longitude: +q.get('longitude'), hourly: {
    time, wave_height: time.map((_, k) => 1.5 + 3 * Math.sin(k / 30)), wave_direction: time.map(() => 110), wave_period: time.map(() => 9),
    swell_wave_height: time.map(() => 1.2), swell_wave_direction: time.map(() => 100), wind_wave_height: time.map(() => 0.8), sea_surface_temperature: time.map(() => 29.2) } };
}

export const nws = (scenario) => ({
  features: scenario === 'cyclone' ? [{ properties: {
    id: 'urn:oid:2.49.0.1.840.0.test.1', event: 'Hurricane Warning', severity: 'Extreme', senderName: 'NWS Miami FL',
    onset: new Date(Date.now() - HOUR).toISOString(), ends: new Date(Date.now() + 2 * DAY).toISOString(),
    headline: 'Hurricane Warning issued for Miami-Dade', description: 'Hurricane conditions expected.\nPrepare now.', instruction: 'Complete preparations. <b>not bold</b>' } }] : [],
});

/* --------------------------------------------------------------- cyclones */
const iso = (ms) => new Date(ms).toISOString().replace('.000', '');
function trackPts(t0, lat, lon, dLat, dLon, v, dv, n = 9, step = 12) {
  return Array.from({ length: n }, (_, k) => ({ time: iso(t0 + k * step * HOUR), tau: k * step, lat: +(lat + dLat * k).toFixed(1), lon: +(lon + dLon * k).toFixed(1),
    vmaxKt: Math.max(25, Math.round(v + dv * k)), gustKt: Math.max(35, Math.round((v + dv * k) * 1.22)), radii: k < 6 ? { 34: [150, 140, 90, 110], ...(v + dv * k >= 50 ? { 50: [70, 60, 40, 50] } : {}), ...(v + dv * k >= 64 ? { 64: [35, 30, 20, 25] } : {}) } : {} }));
}
function coneAround(pts) {
  const left = [], right = [];
  pts.forEach((p, k) => { const r = 0.3 + k * 0.45; left.push([+(p.lat + r).toFixed(2), +(p.lon - r * 0.6).toFixed(2)]); right.unshift([+(p.lat - r).toFixed(2), +(p.lon + r * 0.6).toFixed(2)]); });
  return left.concat(right);
}

export function tropical(scenario) {
  const now = Date.now(), t0 = Math.floor(now / (6 * HOUR)) * 6 * HOUR;
  // Atlantic hurricane heading for south Florida (direct hit in the "cyclone" scenario, offshore otherwise)
  const al = trackPts(t0, 23.6, scenario === 'cyclone' ? -76.4 : -70.5, 0.55, scenario === 'cyclone' ? -0.7 : -0.2, 105, -6);
  const kirk = {
    source: 'NHC', id: 'al142026', name: 'Kirk', basin: 'AL', classCode: 'HU', classText: 'Hurricane', time: al[0].time, lat: al[0].lat, lon: al[0].lon,
    vmaxKt: 105, gustKt: 130, pressure: 955, moveDir: 305, moveKt: 11, windAvg: '1-min', eyeNm: 15, radii: al[0].radii,
    seas: { height: 12, unit: 'ft', radiiNm: [240, 210, 150, 180] }, forecast: al.slice(1), advisoryIssued: iso(t0 + 0.5 * HOUR),
    headline: 'Kirk expected to bring life-threatening storm surge', watchesWarnings: 'A Hurricane Warning is in effect for...\n* Miami-Dade', hazards: 'STORM SURGE: 6 to 9 ft above ground.\n\nRAINFALL: 6 to 10 inches.\n\n',
    cone: coneAround(al), past: Array.from({ length: 8 }, (_, k) => ({ time: iso(t0 - (8 - k) * 6 * HOUR), lat: +(al[0].lat - (8 - k) * 0.35).toFixed(1), lon: +(al[0].lon + (8 - k) * 0.5).toFixed(1), vmaxKt: 60 + k * 6 })),
    links: [{ label: 'NHC graphics & key messages', url: 'https://www.nhc.noaa.gov/' }, { label: 'Bad link', url: 'javascript:alert(1)' }],
    basinName: 'North Atlantic', official: { code: 'NHC', name: 'NOAA National Hurricane Center (RSMC Miami)', url: 'https://www.nhc.noaa.gov/', dataFrom: 'NHC' }, key: 'AL-KIRK', alt: [],
  };
  const wp = trackPts(t0, 17.8, 129.5, 0.9, -0.8, 80, 3, 6, 24);
  const kong = {
    source: 'JMA', id: 'TC2621', name: 'Kong-rey', basin: 'WP', classCode: 'TY', classText: 'Very strong Typhoon', scale: 'Large', issued: iso(t0),
    time: wp[0].time, lat: wp[0].lat, lon: wp[0].lon, pressure: 945, vmaxKt: 80, gustKt: 115, moveDir: 315, moveText: 'NW', moveKt: 9,
    gale: [{ dir: 'All', nm: 260 }], storm: [{ dir: 'All', nm: 90 }], windAvg: '10-min',
    forecast: wp.slice(1).map((p, k) => ({ ...p, radii: undefined, probRadiusNm: 40 + k * 45, storm: [{ dir: 'All', nm: 80 }], gale: [{ dir: 'All', nm: 240 }] })),
    pastPath: Array.from({ length: 10 }, (_, k) => [+(wp[0].lat - (10 - k) * 0.4).toFixed(2), +(wp[0].lon + (10 - k) * 0.7).toFixed(2)]),
    links: [{ label: 'JMA typhoon information', url: 'https://www.jma.go.jp/bosai/map.html#contents=typhoon&lang=en' }],
    basinName: 'Western North Pacific', official: { code: 'JMA', name: 'Japan Meteorological Agency (RSMC Tokyo)', url: 'https://www.jma.go.jp/', dataFrom: 'JMA' }, key: 'WP-KONG-REY', alt: [],
  };
  // South Pacific cyclone crossing the dateline (JTWC only)
  const sh = trackPts(t0, -15.2, 176.5, -0.8, 1.6, 55, 4, 7, 12);
  const zelia = {
    source: 'JTWC', id: 'sh0726', fileId: 'sh0726', name: 'Zelia', basin: 'SH', subBasin: 'P', classText: 'Tropical Cyclone', time: sh[0].time, lat: sh[0].lat, lon: sh[0].lon,
    vmaxKt: 55, gustKt: 70, pressure: '980<img src=x onerror=alert(1)>', moveDir: 120, moveKt: 14, radii: sh[0].radii, maxWaveFt: 24, windAvg: '1-min', advisory: 6,
    summary: 'Rapid intensification expected <script>alert(1)</script>', forecast: sh.slice(1).map((p) => ({ ...p, lon: p.lon > 180 ? +(p.lon - 360).toFixed(1) : p.lon })),
    past: Array.from({ length: 5 }, (_, k) => ({ time: iso(t0 - (5 - k) * 6 * HOUR), lat: +(sh[0].lat + (5 - k) * 0.4).toFixed(1), lon: +(sh[0].lon - (5 - k) * 0.6).toFixed(1), vmaxKt: 35 + k * 4 })),
    links: [{ label: 'JTWC warning text', url: 'https://www.metoc.navy.mil/jtwc/products/sh0726web.txt' }],
    basinName: 'Southern Hemisphere (South Pacific)', official: { code: 'FMS', name: 'Fiji Meteorological Service (RSMC Nadi)', url: 'https://www.met.gov.fj/', dataFrom: 'JTWC' }, key: 'SH-ZELIA', alt: [],
    gdacs: { eventId: 1001, alertLevel: 'Orange', severity: 'Tropical Cyclone (maximum wind speed of 120 km/h)', countries: ['Fiji', 'Tonga'], report: 'javascript:alert(2)', images: { rainmap: 'https://www.gdacs.org/x.png' } },
  };
  const ep = trackPts(t0, 14.5, -118.0, 0.4, -1.1, 145, -8, 7, 12);
  const lane = { source: 'NHC', id: 'ep182026', name: 'Lane', basin: 'EP', classCode: 'HU', classText: 'Hurricane', time: ep[0].time, lat: ep[0].lat, lon: ep[0].lon, vmaxKt: 145, gustKt: 175, pressure: 922,
    moveDir: 290, moveKt: 9, windAvg: '1-min', radii: ep[0].radii, forecast: ep.slice(1), basinName: 'Eastern North Pacific', official: { code: 'NHC', name: 'NOAA National Hurricane Center (RSMC Miami)', url: 'https://www.nhc.noaa.gov/', dataFrom: 'NHC' }, key: 'EP-LANE', alt: [] };
  const io = trackPts(t0, 15.5, 88.0, 0.5, -0.4, 70, 2, 6, 12);
  const dana = { source: 'JTWC', id: 'io052026', name: 'Dana', basin: 'IO', subBasin: 'B', classText: 'Very Severe Cyclonic Storm', time: io[0].time, lat: io[0].lat, lon: io[0].lon, vmaxKt: 70, gustKt: 85, pressure: 970,
    moveDir: 330, moveKt: 8, windAvg: '1-min', radii: io[0].radii, forecast: io.slice(1), basinName: 'North Indian Ocean (Bay of Bengal)', official: { code: 'IMD', name: 'India Meteorological Department (RSMC New Delhi)', url: 'https://rsmcnewdelhi.imd.gov.in/', dataFrom: 'JTWC' }, key: 'IO-DANA', alt: [] };
  return {
    generated: iso(now - 12 * 60e3), status: { NHC: { ok: true }, JMA: { ok: true }, JTWC: { ok: true } },
    storms: [kirk, kong, zelia, lane, dana], gdacs: [],
    india: { source: 'NDMA SACHET (CAP)', alerts: scenario === 'heat' ? [{ id: 'in1', sender: 'IMD New Delhi', event: 'Heat Wave', severity: 'Severe', onset: iso(now - HOUR), expires: iso(now + DAY), headline: 'Severe heat wave over Delhi', description: 'Heat wave conditions very likely.', instruction: 'Avoid sun exposure.', area: 'New Delhi, Delhi', issuer: 'IMD' }] : [] },
  };
}

/** 1×1 grey PNG for map tiles */
export const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
