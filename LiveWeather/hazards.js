/* SkyPulse hazards: tropical-cyclone threat analysis + warnings.
 *
 * Data in:  data/tropical.json (built every 30 min by pipeline/fetch_tropical.py from NHC, JMA, JTWC, IMD, GDACS, NDMA SACHET)
 *           + live browser calls: NWS alerts (US), HKO warnings (Hong Kong), Open-Meteo elevation (coastline probe) and marine (waves, SST).
 * Out:      the Warnings card, the Tropical-cyclone card (Leaflet track map, impacts at your location) and the storm list.
 *
 * Wind at the user's point is *estimated* from agency quadrant wind radii with a piecewise power-law vortex
 * (RMW → 64 kt → 50 kt → 34 kt radii, then r^-0.6 decay). Directions use ~20° inflow around the centre.
 */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const KT = 1.852;                // kt → km/h
  const NM = 1.852;                // nm → km
  const HOUR = 3600e3;
  const RAD = Math.PI / 180;
  let H = null;                    // helpers injected by app.js
  const st = { data: null, dataAt: 0, dataErr: null, coast: null, coastKey: null, marine: null, marineAt: 0, marineKey: null,
               nws: null, nwsAt: 0, nwsKey: null, hko: null, hkoAt: 0, sel: null, map: null, layers: null, last: null, ctx: null };

  /* ------------------------------------------------------------ geodesy */
  function distKm(a, b, c, d) {
    const dLat = (c - a) * RAD, dLon = (d - b) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a * RAD) * Math.cos(c * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
    const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }
  function dest(lat, lon, brg, km) {
    const d = km / 6371, t = brg * RAD, p1 = lat * RAD, l1 = lon * RAD;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
    const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [p2 / RAD, l2 / RAD];
  }
  const angDiff = (a, b) => { const d = Math.abs((((a - b) % 360) + 360) % 360); return d > 180 ? 360 - d : d; };
  const unwrap = (lon, ref) => { while (lon - ref > 180) lon -= 360; while (ref - lon > 180) lon += 360; return lon; };
  const lerp = (a, b, f) => a + (b - a) * f;
  function inRing(lat, lon, ring) {
    if (!ring || ring.length < 3) return false;
    const ref = ring[0][1]; lon = unwrap(lon, ref);
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][0], xi = unwrap(ring[i][1], ref), yj = ring[j][0], xj = unwrap(ring[j][1], ref);
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function circMean(degs, weights) {
    let x = 0, y = 0;
    degs.forEach((d, i) => { const w = weights ? weights[i] : 1; x += Math.cos(d * RAD) * w; y += Math.sin(d * RAD) * w; });
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }

  /* ---------------------------------------------------- intensity scales */
  const SS = [[137, 'Category 5', '#ff6060'], [113, 'Category 4', '#ff8f20'], [96, 'Category 3', '#ffc140'], [83, 'Category 2', '#ffe775'],
              [64, 'Category 1', '#ffffcc'], [34, 'Tropical storm', '#00faf4'], [0, 'Tropical depression', '#5ebaff']];
  const ssCat = (kt1) => SS.find(([v]) => (kt1 ?? 0) >= v);
  const ssColor = (kt1) => ssCat(kt1)[2];
  function localScales(s, kt1) {
    const out = [];
    const v10 = kt1 * 0.88, v3 = kt1 * 0.95;
    if (['AL', 'EP', 'CP'].includes(s.basin) || s.source === 'JTWC') out.push(['Saffir–Simpson (1-min)', ssCat(kt1)[1]]);
    if (s.basin === 'WP') {
      const j = s.source === 'JMA' ? s.vmaxKt : v10;
      out.push(['JMA (10-min)', j >= 105 ? 'Violent Typhoon' : j >= 85 ? 'Very Strong Typhoon' : j >= 64 ? 'Typhoon' : j >= 48 ? 'Severe Tropical Storm' : j >= 34 ? 'Tropical Storm' : 'Tropical Depression']);
    }
    if (s.basin === 'IO') out.push(['IMD (3-min)', v3 >= 120 ? 'Super Cyclonic Storm' : v3 >= 90 ? 'Extremely Severe Cyclonic Storm' : v3 >= 64 ? 'Very Severe Cyclonic Storm' : v3 >= 48 ? 'Severe Cyclonic Storm' : v3 >= 34 ? 'Cyclonic Storm' : v3 >= 28 ? 'Deep Depression' : 'Depression']);
    if (s.basin === 'SH') {
      if ((s.lon ?? 0) >= 30 && (s.lon ?? 0) < 90) out.push(['Météo-France SWIO (10-min)', v10 > 115 ? 'Very Intense Tropical Cyclone' : v10 >= 90 ? 'Intense Tropical Cyclone' : v10 >= 64 ? 'Tropical Cyclone' : v10 >= 48 ? 'Severe Tropical Storm' : v10 >= 34 ? 'Moderate Tropical Storm' : 'Tropical Depression']);
      else out.push(['Australian / Fiji (10-min)', v10 >= 108 ? 'Category 5 (severe)' : v10 >= 86 ? 'Category 4 (severe)' : v10 >= 64 ? 'Category 3 (severe)' : v10 >= 48 ? 'Category 2' : v10 >= 34 ? 'Category 1' : 'Tropical Low']);
    }
    return out;
  }

  // national services for "local agency" links (country code → [name, url])
  const LOCAL = {
    IN: ['India Meteorological Department', 'https://mausam.imd.gov.in/'], BD: ['Bangladesh Meteorological Department', 'https://live6.bmd.gov.bd/'],
    PK: ['Pakistan Meteorological Department', 'https://www.pmd.gov.pk/'], LK: ['Department of Meteorology, Sri Lanka', 'https://www.meteo.gov.lk/'],
    MM: ['Dept. of Meteorology and Hydrology, Myanmar', 'https://www.moezala.gov.mm/'], OM: ['Oman Meteorology', 'https://www.met.gov.om/'],
    TH: ['Thai Meteorological Department', 'https://www.tmd.go.th/en/'], VN: ['Viet Nam NCHMF', 'https://nchmf.gov.vn/'],
    PH: ['PAGASA', 'https://www.pagasa.dost.gov.ph/tropical-cyclone/severe-weather-bulletin'], CN: ['China Meteorological Administration', 'https://typhoon.nmc.cn/'],
    HK: ['Hong Kong Observatory', 'https://www.hko.gov.hk/en/wxinfo/currwx/tc_pos.htm'], MO: ['Macao SMG', 'https://www.smg.gov.mo/'],
    TW: ['Central Weather Administration', 'https://www.cwa.gov.tw/V8/E/P/Typhoon/TY_NEWS.html'], JP: ['Japan Meteorological Agency', 'https://www.jma.go.jp/bosai/map.html#contents=typhoon&lang=en'],
    KR: ['Korea Meteorological Administration', 'https://www.weather.go.kr/w/eng/typhoon/typhoon-info.do'], US: ['NWS / National Hurricane Center', 'https://www.weather.gov/'],
    PR: ['NWS San Juan', 'https://www.weather.gov/sju/'], GU: ['NWS Guam', 'https://www.weather.gov/gum/'], MP: ['NWS Guam', 'https://www.weather.gov/gum/'],
    MX: ['Servicio Meteorológico Nacional', 'https://smn.conagua.gob.mx/es/ciclones-tropicales/informacion-historica'], CU: ['INSMET Cuba', 'http://www.insmet.cu/'],
    DO: ['INDOMET', 'https://onamet.gob.do/'], JM: ['Meteorological Service of Jamaica', 'https://metservice.gov.jm/'], BS: ['Bahamas Dept. of Meteorology', 'https://www.bahamasweather.org.bs/'],
    HT: ['Unité Hydrométéorologique d’Haïti', 'https://www.meteo-haiti.gouv.ht/'], BZ: ['National Meteorological Service of Belize', 'https://www.nms.gov.bz/'],
    AU: ['Bureau of Meteorology', 'https://www.bom.gov.au/cyclone/'], NZ: ['MetService', 'https://www.metservice.com/warnings/home'],
    FJ: ['Fiji Meteorological Service', 'https://www.met.gov.fj/'], VU: ['Vanuatu Meteorology', 'https://www.vmgd.gov.vu/'], NC: ['Météo-France Nouvelle-Calédonie', 'https://www.meteo.nc/'],
    TO: ['Tonga Meteorological Service', 'https://met.gov.to/'], WS: ['Samoa Meteorology', 'https://www.samet.gov.ws/'], PF: ['Météo-France Polynésie', 'https://meteo.pf/'],
    MG: ['Météo Madagascar', 'https://www.meteomadagascar.mg/'], MZ: ['INAM Moçambique', 'https://www.inam.gov.mz/'], RE: ['Météo-France La Réunion', 'https://meteofrance.re/fr/cyclone'],
    MU: ['Mauritius Meteorological Services', 'http://metservice.intnet.mu/'], ID: ['BMKG Indonesia', 'https://www.bmkg.go.id/'], MY: ['MetMalaysia', 'https://www.met.gov.my/'],
    KH: ['Cambodia Ministry of Water Resources & Meteorology', 'https://www.cambodiameteo.com/'], LA: ['Lao Dept. of Meteorology & Hydrology', 'http://dmh.gov.la/'],
    YE: ['Yemen Meteorological Service', 'https://www.ycaa.gov.ye/'], SO: ['SWALIM Somalia', 'https://www.faoswalim.org/'], AE: ['UAE National Center of Meteorology', 'https://www.ncm.gov.ae/'],
  };

  /* ------------------------------------------------- track normalisation */
  function nearest(points, t, maxH) {
    let best = null, bd = Infinity;
    for (const p of points || []) { const d = Math.abs(Date.parse(p.time) - t); if (d < bd) { bd = d; best = p; } }
    return best && bd <= maxH * HOUR ? best : null;
  }
  function jmaRadii(p) {
    const r = {};
    const storm = Math.max(0, ...(p.storm || []).map((x) => x.nm || 0)), gale = Math.max(0, ...(p.gale || []).map((x) => x.nm || 0));
    if (storm) r['50'] = [storm, storm, storm, storm];
    if (gale) r['34'] = [gale, gale, gale, gale];
    return r;
  }
  /** hourly-interpolatable track: current position + forecasts, winds as 1-min equivalent */
  function track(s) {
    const to1 = (v) => (v == null ? null : s.windAvg === '10-min' ? v / 0.88 : v);
    const alt = (s.alt || []).find((a) => a.source === 'JTWC');
    const altPts = alt ? [{ time: alt.time, radii: alt.radii }, ...(alt.forecast || [])] : [];
    const pts = [{ time: s.time, lat: s.lat, lon: s.lon, vmaxKt: s.vmaxKt, gustKt: s.gustKt, radii: s.radii, pressure: s.pressure }, ...(s.forecast || [])]
      .filter((p) => p.time && p.lat != null && p.lon != null)
      .map((p) => {
        const t = Date.parse(p.time);
        let radii = p.radii && Object.keys(p.radii).length ? p.radii : null;
        if (!radii) radii = nearest(altPts, t, 6)?.radii || (s.source === 'JMA' ? jmaRadii(p) : null) || {};
        return { t, lat: p.lat, lon: p.lon, vmax: to1(p.vmaxKt), vAgency: p.vmaxKt, gust: to1(p.gustKt), radii, pressure: p.pressure, note: p.note, probNm: p.probRadiusNm, tau: p.tau };
      })
      .sort((a, b) => a.t - b.t);
    // carry longitudes continuously across the dateline
    for (let i = 1; i < pts.length; i++) pts[i].lon = unwrap(pts[i].lon, pts[i - 1].lon);
    return pts;
  }
  function stateAt(trk, t) {
    if (!trk.length) return null;
    if (t <= trk[0].t) return { ...trk[0] };
    if (t > trk[trk.length - 1].t) return null;
    let i = 0; while (i < trk.length - 2 && trk[i + 1].t < t) i++;
    const a = trk[i], b = trk[i + 1], f = (t - a.t) / (b.t - a.t || 1);
    const radii = {};
    for (const k of ['34', '50', '64']) {
      const ra = a.radii?.[k], rb = b.radii?.[k];
      if (ra || rb) radii[k] = [0, 1, 2, 3].map((q) => lerp(ra?.[q] || 0, rb?.[q] || 0, f));
    }
    const v = (x, y) => (x == null ? y : y == null ? x : lerp(x, y, f));
    return { t, lat: lerp(a.lat, b.lat, f), lon: lerp(a.lon, b.lon, f), vmax: v(a.vmax, b.vmax), gust: v(a.gust, b.gust), radii };
  }

  /* ---------------------------------------------------- wind estimate */
  function quadR(arr, brg) {
    if (!arr) return 0;
    const p = (((brg - 45) % 360) + 360) % 360 / 90, i = Math.floor(p), f = p - i;
    return arr[i % 4] * (1 - f) + arr[(i + 1) % 4] * f;
  }
  function windKt(s, dNm, brg) {
    const vmax = s.vmax || 0; if (!vmax) return 0;
    const r34 = quadR(s.radii['34'], brg), r50 = quadR(s.radii['50'], brg), r64 = quadR(s.radii['64'], brg);
    let rmw = r64 > 0 ? Math.max(6, r64 * 0.45) : r50 > 0 ? Math.max(8, r50 * 0.35) : r34 > 0 ? Math.max(10, r34 * 0.22) : 25;
    rmw = Math.min(rmw, 60);
    const pts = [[rmw, vmax]];
    if (r64 > rmw && vmax > 64) pts.push([r64, 64]);
    if (r50 > pts[pts.length - 1][0] && vmax > 50) pts.push([r50, 50]);
    if (r34 > pts[pts.length - 1][0] && vmax > 34) pts.push([r34, 34]);
    if (dNm <= rmw) return vmax * Math.max(0.2, dNm / rmw);
    for (let k = 0; k < pts.length - 1; k++) {
      const [r1, v1] = pts[k], [r2, v2] = pts[k + 1];
      if (dNm <= r2) return v1 * (dNm / r1) ** (Math.log(v2 / v1) / Math.log(r2 / r1));
    }
    const [rl, vl] = pts[pts.length - 1];
    return vl * (rl / dNm) ** (pts.length > 1 ? 0.6 : 0.5);
  }
  /** direction the cyclone's wind comes FROM at a point, with ~20° inflow */
  const windFrom = (brgCentreToPoint, south) => (((brgCentreToPoint + (south ? -70 : 70)) % 360) + 360) % 360;

  /* -------------------------------------------- per-storm threat analysis */
  function analyze(s, loc, ctx) {
    const trk = track(s); if (!trk.length) return null;
    const now = Date.now(), south = (s.lat ?? 0) < 0;
    const t0 = Math.max(now, trk[0].t), tEnd = trk[trk.length - 1].t;
    const cur = stateAt(trk, Math.min(Math.max(now, trk[0].t), tEnd)) || trk[trk.length - 1];
    const series = [];
    for (let t = t0; t <= tEnd && series.length < 170; t = series.length === 1 ? Math.ceil((t0 + 1) / HOUR) * HOUR : t + HOUR) {
      const x = stateAt(trk, t); if (!x) break;
      const dKm = distKm(x.lat, x.lon, loc.lat, loc.lon), brg = bearing(x.lat, x.lon, loc.lat, loc.lon);
      const sust = windKt(x, dKm / NM, brg);
      const gf = x.gust && x.vmax ? Math.max(1.15, Math.min(1.5, x.gust / x.vmax)) : 1.25;
      series.push({ t, dKm, brg, sust, gust: sust * gf, from: windFrom(brg, south), lat: x.lat, lon: x.lon, vmax: x.vmax });
    }
    const dNow = distKm(cur.lat, cur.lon, loc.lat, loc.lon);
    let cpa = series.length ? series.reduce((m, p) => (p.dKm < m.dKm ? p : m), series[0]) : { t: now, dKm: dNow, brg: bearing(cur.lat, cur.lon, loc.lat, loc.lon), sust: 0, gust: 0 };
    const peak = series.reduce((m, p) => (p.sust > (m?.sust ?? -1) ? p : m), null);
    const win = (kt) => { const w = series.filter((p) => p.sust >= kt); return w.length ? { start: w[0].t, end: w[w.length - 1].t, hours: w.length } : null; };
    const ts = win(34), hu = win(64), storm50 = win(50);

    // side of track at closest approach (positive = right of motion)
    let side = null;
    if (series.length > 2) {
      const k = series.indexOf(cpa), a = series[Math.max(0, k - 1)], b = series[Math.min(series.length - 1, k + 1)];
      if (a !== b) {
        const heading = bearing(a.lat, a.lon, b.lat, b.lon), rel = ((bearing(cpa.lat, cpa.lon, loc.lat, loc.lon) - heading + 540) % 360) - 180;
        side = rel > 0 ? 'right' : 'left';
      }
    }
    const dangerous = side && ((side === 'right' && !south) || (side === 'left' && south));
    const approaching = series.length > 3 && series[3].dKm < series[0].dKm - 5;

    let level = 'far';
    if (ts || cpa.dKm <= 150) level = 'direct';
    else if (cpa.dKm <= 500) level = 'near';
    else if (cpa.dKm <= 1000 && approaching) level = 'watch';

    // coast-relative flow while the storm's winds matter (≥ 25 kt)
    let flow = null;
    const coast = ctx.coast;
    if (coast?.coastal && series.length) {
      const strong = series.filter((p) => p.sust >= 25);
      flow = strong.map((p) => ({ t: p.t, kind: angDiff(p.from, coast.seaBearing) <= 60 ? 'onshore' : angDiff(p.from, coast.seaBearing) >= 120 ? 'offshore' : 'alongshore', sust: p.sust, from: p.from }));
    }
    const onshorePeak = flow?.filter((f) => f.kind === 'onshore').reduce((m, f) => Math.max(m, f.sust), 0) ?? 0;
    const surge = surgeRisk({ coast, onshorePeak, dangerous, flow, cpa, s });

    // rainfall from the model while the storm is near (CPA ± 24 h)
    let rain = null;
    if (ctx.t && (level === 'direct' || level === 'near')) {
      const Hh = ctx.t.H, a = cpa.t - 24 * HOUR, b = cpa.t + 24 * HOUR;
      let sum = 0, maxHr = 0;
      for (let i = 0; i < Hh.time.length; i++) if (Hh.time[i] >= a && Hh.time[i] <= b && Hh.time[i] >= now - HOUR) { sum += Hh.pr[i] || 0; maxHr = Math.max(maxHr, Hh.pr[i] || 0); }
      rain = { sum, maxHr, from: Math.max(a, now), to: b };
    }
    // official areas the point falls in
    const official = officialAreas(s, loc, trk);
    return { s, trk, cur, series, cpa, peak, ts, hu, storm50, side, dangerous, approaching, level, dNow, brgNow: bearing(cur.lat, cur.lon, loc.lat, loc.lon), flow, surge, rain, official, south };
  }

  function surgeRisk({ coast, onshorePeak, dangerous, flow, cpa, s }) {
    if (!coast) return { level: 'unknown', text: 'Coastline not analysed yet.' };
    if (!coast.coastal || coast.distKm > 20) return { level: 'none', text: `About ${coast.coastal ? Math.round(coast.distKm) : '30+'} km from the open sea — outside the storm-surge zone. River and flash flooding from heavy rain remain possible.` };
    if (!flow || !flow.length || onshorePeak < 25) {
      const off = flow?.some((f) => f.kind === 'offshore');
      return { level: 'low', text: off ? 'Cyclone winds blow offshore here (land → sea), pushing water away from this coast — surge risk is low, though rough seas and swell still reach the shore.' : 'Cyclone winds are not expected to blow strongly onshore here.' };
    }
    let score = onshorePeak >= 64 ? 3 : onshorePeak >= 50 ? 2 : onshorePeak >= 34 ? 1 : 0;
    if (dangerous) score += 1;
    if (coast.elev != null) score += coast.elev < 5 ? 1 : coast.elev > 30 ? -2 : coast.elev > 15 ? -1 : 0;
    if (coast.distKm > 8) score -= 1;
    const level = score >= 4 ? 'high' : score >= 3 ? 'elevated' : score >= 2 ? 'moderate' : 'low';
    const on = flow.filter((f) => f.kind === 'onshore');
    const span = on.length ? `${H.fmtDay(on[0].t)} ${H.fmtHM(on[0].t)} – ${H.fmtDay(on[on.length - 1].t)} ${H.fmtHM(on[on.length - 1].t)}` : '';
    const parts = [`Onshore winds (from the sea, ${H.dirName(coast.seaBearing)} side) up to ~${Math.round(onshorePeak * KT)} km/h ${span ? 'from ' + span : ''}.`];
    if (dangerous) parts.push(`You are on the ${s.lat < 0 ? 'left' : 'right'}-hand (dangerous) side of the track, where winds and surge are strongest.`);
    if (coast.elev != null) parts.push(`Ground elevation here ≈ ${Math.round(coast.elev)} m, ${coast.distKm < 2 ? 'right on' : '~' + Math.round(coast.distKm) + ' km from'} the coast.`);
    return { level, text: parts.join(' '), onshorePeak };
  }

  function officialAreas(s, loc, trk) {
    const out = [];
    if (s.cone && inRing(loc.lat, loc.lon, s.cone)) out.push({ level: 'yellow', title: `Inside the ${s.official?.code || s.source} forecast cone`, text: 'The storm centre could pass over or near you.' });
    if (s.imd) {
      const hit = (rings) => (rings || []).some((r) => inRing(loc.lat, loc.lon, r));
      if (hit(s.imd.r64)) out.push({ level: 'red', title: 'IMD: inside the forecast 64 kt (118 km/h) wind area', text: 'Very severe cyclonic storm-force winds forecast by RSMC New Delhi.' });
      else if (hit(s.imd.r50)) out.push({ level: 'orange', title: 'IMD: inside the forecast 50 kt (93 km/h) wind area', text: 'Severe cyclonic storm-force winds forecast by RSMC New Delhi.' });
      else if (hit(s.imd.r34)) out.push({ level: 'orange', title: 'IMD: inside the forecast 34 kt (63 km/h) wind area', text: 'Gale-force winds forecast by RSMC New Delhi.' });
      else if (hit(s.imd.r28)) out.push({ level: 'yellow', title: 'IMD: inside the forecast 28 kt (52 km/h) wind area', text: 'Strong winds forecast by RSMC New Delhi.' });
      if (hit(s.imd.cone)) out.push({ level: 'yellow', title: 'Inside the IMD forecast cone', text: 'RSMC New Delhi cone of uncertainty for the cyclone centre.' });
    }
    if (s.source === 'JMA') {
      const d = distKm(s.lat, s.lon, loc.lat, loc.lon), b = bearing(s.lat, s.lon, loc.lat, loc.lon);
      const rad = (list) => Math.max(0, ...(list || []).filter((x) => x.dir === 'All' || !x.dir || angDiff(b, dirDeg(x.dir)) <= 90).map((x) => x.nm || 0)) * NM;
      if (d <= rad(s.storm)) out.push({ level: 'red', title: 'JMA: inside the storm-warning area (50 kt+)', text: 'Winds of 50 kt (93 km/h) or more now.' });
      else if (d <= rad(s.gale)) out.push({ level: 'orange', title: 'JMA: inside the gale-warning area (30 kt+)', text: 'Winds of 30 kt (56 km/h) or more now.' });
      for (const f of s.forecast || []) {
        const sr = Math.max(0, ...(f.storm || []).map((x) => x.nm || 0));
        if (sr && f.probRadiusNm != null && distKm(f.lat, f.lon, loc.lat, loc.lon) <= (sr + f.probRadiusNm) * NM) {
          out.push({ level: 'orange', title: `JMA: may enter the storm-warning area by ${H.fmtDay(Date.parse(f.time))} ${H.fmtHM(Date.parse(f.time))}`, text: 'Forecast storm-warning area (probability circle + 50 kt radius).' });
          break;
        }
      }
    }
    return out;
  }
  const DIRS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const dirDeg = (d) => DIRS16.indexOf(d) * 22.5;

  /* ------------------------------------------------- coastline + marine */
  async function coastProbe(lat, lon) {
    const R = [1.5, 4, 8, 15, 30], pts = [[lat, lon]];
    for (const r of R) for (let k = 0; k < 16; k++) pts.push(dest(lat, lon, k * 22.5, r));
    const url = 'https://api.open-meteo.com/v1/elevation?latitude=' + pts.map((p) => p[0].toFixed(4)).join(',') + '&longitude=' + pts.map((p) => (((p[1] + 540) % 360) - 180).toFixed(4)).join(',');
    const e = (await H.getJSON(url, 12000)).elevation;
    const elev = e[0];
    let first = -1, water = [], seaPoint = null;
    R.forEach((r, ri) => {
      const hits = [];
      for (let k = 0; k < 16; k++) if (e[1 + ri * 16 + k] === 0) hits.push(k * 22.5);
      water.push(hits);
      if (first < 0 && hits.length) first = ri;
    });
    if (first < 0) return { elev, coastal: false };
    const degs = [], ws = [];
    for (let ri = first; ri < Math.min(R.length, first + 2); ri++) water[ri].forEach((d) => { degs.push(d); ws.push(1 / R[ri]); });
    const seaBearing = circMean(degs, ws);
    seaPoint = dest(lat, lon, seaBearing, R[first]);
    return { elev, coastal: true, distKm: first === 0 ? 1 : (R[first - 1] + R[first]) / 2, seaBearing, seaFrac: water[first].length / 16, seaPoint };
  }

  async function marine(lat, lon) {
    const url = 'https://marine-api.open-meteo.com/v1/marine?' + new URLSearchParams({
      latitude: lat.toFixed(3), longitude: lon.toFixed(3), timeformat: 'unixtime', timezone: 'GMT', forecast_days: 6,
      hourly: 'wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,wind_wave_height,sea_surface_temperature',
    });
    const d = await H.getJSON(url, 12000);
    const h = d.hourly; if (!h) return null;
    const time = h.time.map((x) => x * 1000), now = Date.now();
    let iNow = time.findIndex((t) => t > now - HOUR); if (iNow < 0) iNow = 0;
    let iPk = iNow;
    for (let i = iNow; i < time.length; i++) if ((h.wave_height[i] ?? -1) > (h.wave_height[iPk] ?? -1)) iPk = i;
    return {
      cell: [d.latitude, d.longitude], dist: distKm(lat, lon, d.latitude, d.longitude),
      now: { hs: h.wave_height[iNow], dir: h.wave_direction[iNow], per: h.wave_period[iNow], swell: h.swell_wave_height[iNow], sst: h.sea_surface_temperature?.[iNow] },
      peak: { t: time[iPk], hs: h.wave_height[iPk], dir: h.wave_direction[iPk], per: h.wave_period[iPk] },
      time, hs: h.wave_height,
    };
  }
  const seaState = (m) => m == null ? '–' : m < 0.1 ? 'Calm' : m < 0.5 ? 'Smooth' : m < 1.25 ? 'Slight' : m < 2.5 ? 'Moderate' : m < 4 ? 'Rough' : m < 6 ? 'Very rough' : m < 9 ? 'High' : m < 14 ? 'Very high' : 'Phenomenal';
  const fWave = (m) => (m == null ? '–' : H.unit() === 'F' ? `${(m * 3.281).toFixed(1)} ft` : `${m.toFixed(1)} m`);

  /* ------------------------------------------------------------ warnings */
  const LV = { red: 3, orange: 2, yellow: 1, info: 0 };
  function derivedWarnings(ctx, threat) {
    const out = [], t = ctx.t; if (!t) return out;
    const Hh = t.H, now = Date.now(), i0 = Math.max(0, Hh.time.findIndex((x) => x > now - HOUR));
    const span = (a, b) => `${H.fmtDay(a)} ${H.fmtHM(a)} – ${H.fmtDay(b)} ${H.fmtHM(b)}`;
    // rain / flooding
    let best = { sum: 0, i: i0 }, maxHr = { v: 0, i: i0 }, tot72 = 0;
    for (let i = i0; i < Math.min(Hh.time.length, i0 + 72); i++) {
      tot72 += Hh.pr[i] || 0;
      if ((Hh.pr[i] || 0) > maxHr.v) maxHr = { v: Hh.pr[i], i };
      let s = 0; for (let k = i; k < Math.min(Hh.time.length, i + 24); k++) s += Hh.pr[k] || 0;
      if (s > best.sum && i < i0 + 48) best = { sum: s, i };
    }
    const r24 = best.sum;
    if (r24 >= 64.5 || maxHr.v >= 30) {
      const lv = r24 >= 204.5 ? 'red' : r24 >= 115.6 || maxHr.v >= 50 ? 'orange' : 'yellow';
      const cat = r24 >= 204.5 ? 'Extremely heavy rain' : r24 >= 115.6 ? 'Very heavy rain' : r24 >= 64.5 ? 'Heavy rain' : 'Intense downpours';
      out.push({ id: 'd-rain', level: lv, icon: '🌊', kind: 'flood', title: `${cat} — flood risk`, start: Hh.time[best.i], end: Hh.time[Math.min(Hh.time.length - 1, best.i + 23)],
        text: `Up to ${H.fP(r24)} ${H.pU()} in 24 h (${span(Hh.time[best.i], Hh.time[Math.min(Hh.time.length - 1, best.i + 23)])})${maxHr.v >= 20 ? `, bursts of ${H.fP(maxHr.v)} ${H.pU()}/h around ${H.fmtDay(Hh.time[maxHr.i])} ${H.fmtHM(Hh.time[maxHr.i])}` : ''}. 72-h total ${H.fP(tot72)} ${H.pU()}.`,
        advice: 'Avoid low-lying roads, underpasses and streams; never drive through flood water. Landslides are possible on steep slopes.', source: 'derived' });
    }
    // wind
    let gMax = { v: 0, i: i0 };
    for (let i = i0; i < Math.min(Hh.time.length, i0 + 48); i++) if ((Hh.wg[i] || 0) > gMax.v) gMax = { v: Hh.wg[i], i };
    let gKmh = gMax.v, gT = Hh.time[gMax.i], viaTc = false;
    if (threat?.peak && threat.peak.gust * KT > gKmh && threat.peak.t - now < 72 * HOUR) { gKmh = threat.peak.gust * KT; gT = threat.peak.t; viaTc = true; }
    if (gKmh >= 62) {
      const lv = gKmh >= 118 ? 'red' : gKmh >= 89 ? 'orange' : 'yellow';
      out.push({ id: 'd-wind', level: lv, icon: '💨', kind: 'wind', title: gKmh >= 118 ? 'Destructive winds' : gKmh >= 89 ? 'Damaging winds' : 'Strong, gusty winds', start: gT, end: gT,
        text: `Gusts up to ${H.fW(gKmh)} ${H.wU()} around ${H.fmtDay(gT)} ${H.fmtHM(gT)}${viaTc ? ` (from ${threat.s.classText || 'the cyclone'} ${threat.s.name})` : ''}.`,
        advice: gKmh >= 89 ? 'Secure loose objects, stay away from windows, trees and power lines; expect power cuts and fallen trees.' : 'Secure loose outdoor items; take care on exposed roads and bridges.', source: viaTc ? 'derived-tc' : 'derived' });
    }
    // thunderstorms / hail
    for (let i = i0; i < Math.min(Hh.time.length, i0 + 24); i++) {
      if (Hh.wc[i] >= 95) {
        const hail = Hh.wc.slice(i0, i0 + 24).some((c) => c === 96 || c === 99);
        out.push({ id: 'd-ts', level: hail ? 'orange' : 'yellow', icon: '⚡', kind: 'thunder', title: hail ? 'Thunderstorms with hail' : 'Thunderstorms and lightning', start: Hh.time[i], end: Hh.time[i],
          text: `Thunderstorms likely from around ${H.fmtDay(Hh.time[i])} ${H.fmtHM(Hh.time[i])}.`, advice: 'When thunder roars, go indoors. Avoid open fields, hilltops, water and isolated trees.', source: 'derived' });
        break;
      }
    }
    // heat / cold
    let atMax = { v: -99, i: i0 }, atMin = { v: 99, i: i0 };
    for (let i = i0; i < Math.min(Hh.time.length, i0 + 48); i++) { if (Hh.at[i] > atMax.v) atMax = { v: Hh.at[i], i }; if (Hh.at[i] < atMin.v) atMin = { v: Hh.at[i], i }; }
    if (atMax.v >= 40) out.push({ id: 'd-heat', level: atMax.v >= 52 ? 'red' : atMax.v >= 45 ? 'orange' : 'yellow', icon: '🥵', kind: 'heat', title: 'Extreme heat', start: Hh.time[atMax.i], end: Hh.time[atMax.i],
      text: `Feels like ${H.fT(atMax.v)} around ${H.fmtDay(Hh.time[atMax.i])} ${H.fmtHM(Hh.time[atMax.i])}.`, advice: 'Drink water, avoid the midday sun and strenuous activity, check on vulnerable people.', source: 'derived' });
    if (atMin.v <= -20) out.push({ id: 'd-cold', level: atMin.v <= -35 ? 'red' : atMin.v <= -28 ? 'orange' : 'yellow', icon: '🥶', kind: 'cold', title: 'Dangerous cold / wind chill', start: Hh.time[atMin.i], end: Hh.time[atMin.i],
      text: `Feels like ${H.fT(atMin.v)} around ${H.fmtDay(Hh.time[atMin.i])} ${H.fmtHM(Hh.time[atMin.i])}.`, advice: 'Frostbite can occur quickly on exposed skin — cover up.', source: 'derived' });
    // fog
    for (let i = i0; i < Math.min(Hh.time.length, i0 + 12); i++) if (Hh.vis[i] != null && Hh.vis[i] < 200) {
      out.push({ id: 'd-fog', level: 'yellow', icon: '🌫️', kind: 'fog', title: 'Dense fog', start: Hh.time[i], end: Hh.time[i], text: `Visibility below 200 m around ${H.fmtDay(Hh.time[i])} ${H.fmtHM(Hh.time[i])}.`, advice: 'Drive slowly with low-beam lights; allow extra distance.', source: 'derived' });
      break;
    }
    // freezing rain
    if (Hh.wc.slice(i0, i0 + 24).some((c) => c === 66 || c === 67)) out.push({ id: 'd-ice', level: 'orange', icon: '🧊', kind: 'ice', title: 'Freezing rain — icy surfaces', start: now, end: now, text: 'Freezing rain is forecast within 24 h.', advice: 'Roads and pavements may become glazed with ice.', source: 'derived' });
    // waves / surf (coastal only)
    const m = st.marine, coast = ctx.coast;
    if (m && coast?.coastal && coast.distKm <= 20 && m.peak.hs >= 2.5) {
      out.push({ id: 'd-waves', level: m.peak.hs >= 6 ? 'red' : m.peak.hs >= 4 ? 'orange' : 'yellow', icon: '🌊', kind: 'waves', title: `${seaState(m.peak.hs)} seas — dangerous surf`, start: m.peak.t, end: m.peak.t,
        text: `Waves up to ${fWave(m.peak.hs)} (${H.dirName(m.peak.dir)} swell, ${Math.round(m.peak.per || 0)} s) around ${H.fmtDay(m.peak.t)} ${H.fmtHM(m.peak.t)}.`, advice: 'Stay off beaches, breakwaters and rocks; strong rip currents. Small boats should not go to sea.', source: 'derived' });
    }
    // tropical cyclone
    if (threat && (threat.level === 'direct' || threat.level === 'near')) {
      const s = threat.s, nm = `${s.classText || 'Tropical cyclone'} ${s.name}`;
      if (threat.hu) out.push({ id: 'tc-hu-' + s.key, level: 'red', icon: '🌀', kind: 'cyclone', title: `${nm}: hurricane/typhoon-force winds possible`, start: threat.hu.start, end: threat.hu.end, text: `Sustained winds ≥ 118 km/h estimated ${span(threat.hu.start, threat.hu.end)}. Closest approach ${Math.round(threat.cpa.dKm)} km at ${H.fmtDay(threat.cpa.t)} ${H.fmtHM(threat.cpa.t)}.`, advice: 'Follow evacuation orders from local authorities. Shelter in a strong building away from windows; the calm of the eye is followed by winds from the opposite direction.', source: 'derived-tc' });
      else if (threat.ts) out.push({ id: 'tc-ts-' + s.key, level: 'orange', icon: '🌀', kind: 'cyclone', title: `${nm}: gale/storm-force winds expected`, start: threat.ts.start, end: threat.ts.end, text: `Sustained winds ≥ 63 km/h estimated ${span(threat.ts.start, threat.ts.end)}. Closest approach ${Math.round(threat.cpa.dKm)} km at ${H.fmtDay(threat.cpa.t)} ${H.fmtHM(threat.cpa.t)}.`, advice: 'Finish preparations before winds arrive; charge phones, store water, secure outdoor objects.', source: 'derived-tc' });
      else out.push({ id: 'tc-near-' + s.key, level: 'yellow', icon: '🌀', kind: 'cyclone', title: `${nm} passing within ${Math.round(threat.cpa.dKm)} km`, start: threat.cpa.t, end: threat.cpa.t, text: `Closest approach around ${H.fmtDay(threat.cpa.t)} ${H.fmtHM(threat.cpa.t)}; outer rain bands and gusty winds possible.`, advice: 'Monitor official advisories — track forecasts can shift.', source: 'derived-tc' });
      if (threat.surge && ['high', 'elevated', 'moderate'].includes(threat.surge.level)) out.push({ id: 'tc-surge-' + s.key, level: threat.surge.level === 'high' ? 'red' : threat.surge.level === 'elevated' ? 'orange' : 'yellow', icon: '🌊', kind: 'surge', title: `Storm-surge risk: ${threat.surge.level}`, start: threat.cpa.t, end: threat.cpa.t, text: threat.surge.text, advice: 'Move away from the shoreline and low-lying coastal areas if told to evacuate. Surge is the deadliest cyclone hazard.', source: 'derived-tc' });
      threat.official.forEach((o, k) => out.push({ id: `tc-off-${s.key}-${k}`, icon: '📍', kind: 'cyclone', ...o, source: 'official', agency: s.official?.code || s.source }));
    }
    return out;
  }

  function nwsWarnings(d) {
    return (d?.features || []).map((f) => {
      const p = f.properties;
      const lv = p.severity === 'Extreme' ? 'red' : p.severity === 'Severe' ? 'orange' : p.severity === 'Moderate' ? 'yellow' : 'info';
      return { id: 'nws-' + p.id, level: lv, icon: /hurricane|tropical|storm surge/i.test(p.event) ? '🌀' : /flood/i.test(p.event) ? '🌊' : /wind/i.test(p.event) ? '💨' : '⚠️', kind: 'official', title: p.event,
        start: Date.parse(p.onset || p.effective), end: Date.parse(p.ends || p.expires), text: p.headline || '', description: p.description, advice: p.instruction, source: 'official', agency: p.senderName || 'NWS' };
    });
  }
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
  function indiaWarnings(ctx) {
    const list = st.data?.india?.alerts || []; if (!list.length) return [];
    const admins = (ctx.admins || []).map(norm).filter((a) => a.length >= 3 && a !== 'india');
    if (!admins.length) return [];
    const state = admins[admins.length - 1], finer = admins.slice(0, -1);
    return list.map((a) => {
      // the issuing office (e.g. "IMD Jaipur") names a city, so districts are matched only against the alert's own area/headline
      const where = norm([a.area, a.headline, a.description].join(' '));
      const local = finer.some((n) => where.includes(n));
      if (!local && !norm([a.sender, a.area, a.headline].join(' ')).includes(state)) return null;
      const lv = a.severity === 'Extreme' ? 'red' : a.severity === 'Severe' ? 'orange' : 'yellow';
      return { id: 'in-' + a.id, level: lv, icon: /cyclone|depression/i.test(a.event) ? '🌀' : /flood|rain/i.test(a.event) ? '🌊' : /thunder|lightning/i.test(a.event) ? '⚡' : /heat/i.test(a.event) ? '🥵' : '⚠️',
        kind: 'official', title: a.event + (local ? '' : ' (in your state)'), start: Date.parse(a.onset), end: Date.parse(a.expires), text: a.headline, description: a.description,
        advice: a.instruction, area: a.area, source: 'official', agency: a.issuer || a.sender, local };
    }).filter(Boolean).sort((x, y) => (y.local - x.local) || (LV[y.level] - LV[x.level]));
  }
  function hkoWarnings(d) {
    if (!d) return [];
    return Object.values(d).map((w) => ({ id: 'hko-' + w.code, level: /TC8|TC9|TC10|WRAINB|WRAINR/.test(w.code) ? 'red' : /TC3|WRAINA|WTS/.test(w.code) ? 'orange' : 'yellow', icon: w.code?.startsWith('TC') ? '🌀' : '⚠️',
      kind: 'official', title: w.name + (w.type ? ` (${w.type})` : ''), start: Date.parse(w.issueTime), end: null, text: `${w.actionCode === 'CANCEL' ? 'Cancelled' : 'In force'} since ${H.fmtHM(Date.parse(w.issueTime))}`, source: 'official', agency: 'Hong Kong Observatory' }));
  }
  function gdacsWarnings(ctx, threat) {
    const g = threat?.s?.gdacs; if (!g || !ctx.countryName || !(threat.level === 'direct' || threat.level === 'near')) return [];
    if (!(g.countries || []).some((c) => norm(c) === norm(ctx.countryName))) return [];
    const lv = g.alertLevel === 'Red' ? 'red' : g.alertLevel === 'Orange' ? 'orange' : 'yellow';
    return [{ id: 'gdacs-' + g.eventId, level: lv, icon: '🌐', kind: 'official', title: `GDACS ${g.alertLevel} alert: ${threat.s.name}`, start: null, end: null, text: `${g.severity || ''} — affected: ${(g.countries || []).join(', ')}.`, source: 'official', agency: 'GDACS (UN/EC)', link: g.report }];
  }

  /* --------------------------------------------------------------- render */
  const LV_TXT = { red: 'Warning', orange: 'Alert', yellow: 'Advisory', info: 'Info' };
  function renderWarnings(list) {
    const card = $('#warnCard'); if (!card) return;
    const n = list.length;
    $('#warnCount').textContent = n ? `${n} active` : 'All clear';
    $('#warnCount').className = 'warn-count ' + (n ? (list[0].level || 'yellow') : 'clear');
    $('#warnList').innerHTML = n ? list.map((w, k) => `
      <li class="warn lv-${w.level}">
        <div class="w-ico" aria-hidden="true">${w.icon || '⚠️'}</div>
        <div class="w-body">
          <div class="w-top"><b>${H.esc(w.title)}</b><span class="w-badge ${w.source.startsWith('official') ? 'off' : 'est'}">${w.source.startsWith('official') ? 'Official · ' + H.esc(w.agency || '') : w.source === 'derived-tc' ? 'SkyPulse cyclone estimate' : 'SkyPulse forecast'}</span></div>
          ${w.start ? `<div class="w-time">${LV_TXT[w.level] || ''} · ${w.end && w.end !== w.start ? `${H.esc(H.fmtDay(w.start))} ${H.esc(H.fmtHM(w.start))} → ${H.esc(H.fmtDay(w.end))} ${H.esc(H.fmtHM(w.end))}` : `${H.esc(H.fmtDay(w.start))} ${H.esc(H.fmtHM(w.start))}`}</div>` : `<div class="w-time">${LV_TXT[w.level] || ''}</div>`}
          <p>${H.esc(w.text || '')}</p>
          ${w.area ? `<p class="w-area">Area: ${H.esc(w.area)}</p>` : ''}
          ${w.description || w.advice ? `<details><summary>What to do${w.description ? ' · details' : ''}</summary>${w.advice ? `<p>${H.esc(w.advice)}</p>` : ''}${w.description ? `<p class="w-desc">${H.esc(w.description).replace(/\n/g, '<br>')}</p>` : ''}${w.link ? `<p><a href="${H.esc(w.link)}" target="_blank" rel="noopener">More</a></p>` : ''}</details>` : ''}
        </div>
      </li>`).join('') : `<li class="warn-none">✓ No warnings for your area right now. <span class="muted">Checked: ${H.esc(sourcesChecked())}</span></li>`;
  }
  function sourcesChecked() {
    const s = ['SkyPulse forecast hazards'];
    const c = st.ctx || {};
    if (st.data) s.push('tropical cyclones (NHC · JMA · JTWC · IMD)');
    if (c.cc === 'IN') s.push('IMD/NDMA SACHET');
    if (st.nws) s.push('NWS');
    if (c.cc === 'HK') s.push('HKO');
    return s.join(' · ');
  }

  function stormRow(a) {
    const s = a.s, c = ssColor(a.cur.vmax);
    return `<li><button class="storm-row ${st.sel === s.key ? 'sel' : ''}" data-key="${H.esc(s.key)}">
      <span class="sdot" style="background:${c}"></span>
      <span class="s-name"><b>${H.esc(s.name)}</b><small>${H.esc(s.classText || '')} · ${H.esc(s.basinName || s.basin)}</small></span>
      <span class="s-int">${H.fW((s.vmaxKt || 0) * KT)} ${H.wU()}<small>${s.pressure ? s.pressure + ' hPa' : ''}</small></span>
      <span class="s-dist">${Math.round(a.dNow).toLocaleString()} km<small>${H.dirName(bearing(st.ctx.loc.lat, st.ctx.loc.lon, a.cur.lat, a.cur.lon))}</small></span>
    </button></li>`;
  }

  const threatTxt = { direct: 'Direct threat', near: 'Close pass', watch: 'Approaching', far: 'Far away' };
  function renderStorm(a) {
    const card = $('#tcCard'); if (!card) return;
    if (!a) { card.hidden = true; return; }
    card.hidden = false;
    const s = a.s, loc = st.ctx.loc, kt1 = a.cur.vmax || 0, cat = ssCat(kt1);
    const kmh = (kt) => `${H.fW(kt * KT)} ${H.wU()}`;
    $('#tcTitle').innerHTML = `<span class="tc-badge" style="background:${cat[2]}">${H.esc(cat[1])}</span> ${H.esc(s.classText || 'Tropical cyclone')} <b>${H.esc(s.name)}</b>`;
    $('#tcThreat').className = 'tc-threat t-' + a.level;
    const head = a.level === 'direct'
      ? (a.hu ? `Hurricane/typhoon-force winds possible here ${H.fmtDay(a.hu.start)} ${H.fmtHM(a.hu.start)} – ${H.fmtDay(a.hu.end)} ${H.fmtHM(a.hu.end)}.` : a.ts ? `Gale-force (≥ 63 km/h) winds expected here ${H.fmtDay(a.ts.start)} ${H.fmtHM(a.ts.start)} – ${H.fmtDay(a.ts.end)} ${H.fmtHM(a.ts.end)}.` : 'The centre is forecast to pass very close.')
      : a.level === 'near' ? `Passing ${Math.round(a.cpa.dKm)} km from you — outer rain bands and gusty winds possible.`
      : a.level === 'watch' ? `Approaching: now ${Math.round(a.dNow).toLocaleString()} km away.` : `No threat to your location (${Math.round(a.dNow).toLocaleString()} km away).`;
    $('#tcThreat').innerHTML = `<b>${threatTxt[a.level]}</b> ${H.esc(head)} ${a.series.length ? `Closest approach <b>${Math.round(a.cpa.dKm).toLocaleString()} km</b> (${H.dirName((a.cpa.brg + 180) % 360)} of you) at ${H.esc(H.fmtDay(a.cpa.t))} ${H.esc(H.fmtHM(a.cpa.t))}${a.side ? `, ${a.dangerous ? 'on the dangerous side' : 'on the weaker side'} of the track` : ''}.` : ''}`;

    // intensity facts
    const scales = localScales(s, kt1).map(([k, v]) => `<div class="stat"><small>${H.esc(k)}</small><b>${H.esc(v)}</b></div>`).join('');
    const mv = s.moveKt != null ? `${H.esc(s.moveText || H.dirName(s.moveDir ?? 0))} ${s.moveDir != null ? `(${Math.round(s.moveDir)}°)` : ''} at ${H.fW(s.moveKt * KT)} ${H.wU()}` : '–';
    $('#tcFacts').innerHTML = `
      <div class="stat"><small>Max sustained (${H.esc(s.windAvg || '1-min')})</small><b>${kmh(s.vmaxKt || 0)}</b><span>${s.vmaxKt} kt${s.windAvg === '10-min' ? ` · ≈${Math.round(kt1)} kt 1-min` : ''}</span></div>
      <div class="stat"><small>Gusts</small><b>${s.gustKt ? kmh(s.gustKt) : '–'}</b><span>${s.gustKt ? s.gustKt + ' kt' : ''}</span></div>
      <div class="stat"><small>Central pressure</small><b>${s.pressure ? s.pressure + ' hPa' : '–'}</b><span>${s.eyeNm ? `Eye ${Math.round(s.eyeNm * NM)} km wide` : ''}</span></div>
      <div class="stat"><small>Movement</small><b>${mv}</b><span>${a.approaching ? 'Approaching you' : 'Not approaching'}</span></div>
      <div class="stat"><small>Distance now</small><b>${Math.round(a.dNow).toLocaleString()} km</b><span>${H.dirName((a.brgNow + 180) % 360)} of you</span></div>
      <div class="stat"><small>Wind field</small><b>${s.radii?.['34'] ? Math.round(Math.max(...s.radii['34']) * NM) + ' km' : '–'}</b><span>Gale radius (34 kt)${s.radii?.['64'] ? ` · ${Math.round(Math.max(...s.radii['64']) * NM)} km hurricane-force` : ''}</span></div>
      ${scales}`;

    // local impacts
    const imp = [];
    if (a.peak && a.peak.sust >= 15) imp.push(`<div class="imp"><b>💨 Peak wind here</b><span>~${kmh(a.peak.sust)} sustained, gusts ~${kmh(a.peak.gust)} around ${H.esc(H.fmtDay(a.peak.t))} ${H.esc(H.fmtHM(a.peak.t))} (from the ${H.dirName(a.peak.from)}).${a.ts ? ` Gale-force for ~${a.ts.hours} h.` : ''}</span></div>`);
    else imp.push(`<div class="imp"><b>💨 Wind here</b><span>Cyclone winds should stay below ~${kmh(Math.max(5, a.peak?.sust || 0))} at your location.</span></div>`);
    if (a.ts) {
      const seq = []; a.series.filter((p) => p.sust >= 25).forEach((p, k, arr) => { if (k % 3 === 0 || k === arr.length - 1) { const d = H.dirName(p.from); if (seq[seq.length - 1] !== d) seq.push(d); } });
      if (seq.length > 1) imp.push(`<div class="imp"><b>🧭 Wind direction</b><span>Starts from the ${seq[0]} and turns ${seq.slice(1).join(' → ')} as the storm passes${a.cpa.dKm < 40 ? ' — expect a lull in the eye, then winds from the opposite side' : ''}.</span></div>`);
    }
    const coast = st.ctx.coast;
    if (coast?.coastal && a.flow?.length) {
      const segs = []; a.flow.forEach((f) => { if (!segs.length || segs[segs.length - 1].kind !== f.kind) segs.push({ kind: f.kind, a: f.t, b: f.t }); else segs[segs.length - 1].b = f.t; });
      imp.push(`<div class="imp"><b>🏖️ Onshore / offshore</b><span>Sea lies to the ${H.dirName(coast.seaBearing)} (~${Math.round(coast.distKm)} km). ${segs.map((g) => `<em class="flow ${g.kind}">${g.kind}</em> ${H.esc(H.fmtDay(g.a))} ${H.esc(H.fmtHM(g.a))}–${H.esc(H.fmtHM(g.b))}`).join(' · ')}. Onshore winds pile water against the coast (raising surge and waves); offshore winds push it away.</span></div>`);
    } else if (coast && !coast.coastal) imp.push(`<div class="imp"><b>🏖️ Onshore / offshore</b><span>More than 30 km from the open sea — onshore/offshore flow and surge don’t apply here.</span></div>`);
    if (a.surge) imp.push(`<div class="imp surge-${a.surge.level}"><b>🌊 Storm surge: ${H.esc(a.surge.level)}</b><span>${H.esc(a.surge.text)}${surgeOfficial(s)}</span></div>`);
    if (a.rain) imp.push(`<div class="imp"><b>🌧️ Rain during passage</b><span>~${H.fP(a.rain.sum)} ${H.pU()} forecast ${H.esc(H.fmtDay(a.rain.from))}–${H.esc(H.fmtDay(a.rain.to))}${a.rain.maxHr >= 10 ? `, up to ${H.fP(a.rain.maxHr)} ${H.pU()}/h` : ''} (model).${rainOfficial(s)}</span></div>`);
    const m = st.marine;
    if (m && coast?.coastal && coast.distKm <= 30) imp.push(`<div class="imp"><b>🌊 Waves (nearest sea)</b><span>Now ${fWave(m.now.hs)} (${seaState(m.now.hs)}), peak ${fWave(m.peak.hs)} ${H.dirName(m.peak.dir)} at ${H.esc(H.fmtDay(m.peak.t))} ${H.esc(H.fmtHM(m.peak.t))}, period ${Math.round(m.peak.per || 0)} s${m.now.sst != null ? ` · sea temp ${H.fT(m.now.sst)}` : ''}.${s.maxWaveFt ? ` Agency max wave near the centre: ${fWave(s.maxWaveFt / 3.281)}.` : ''}${s.seas ? ` ${s.seas.height} ${s.seas.unit} seas extend ${Math.round(Math.max(...s.seas.radiiNm) * NM)} km from the centre.` : ''}</span></div>`);
    else if (s.maxWaveFt || s.seas) imp.push(`<div class="imp"><b>🌊 Waves near the storm</b><span>${s.maxWaveFt ? `Max significant wave height ${fWave(s.maxWaveFt / 3.281)}.` : ''} ${s.seas ? `${s.seas.height} ${s.seas.unit} seas extend up to ${Math.round(Math.max(...s.seas.radiiNm) * NM)} km from the centre.` : ''}</span></div>`);
    $('#tcImpacts').innerHTML = imp.join('');

    // forecast table
    const rows = a.trk.map((p) => {
      const d = distKm(p.lat, p.lon, loc.lat, loc.lon);
      return `<tr><td>${H.esc(H.fmtDay(p.t))} ${H.esc(H.fmtHM(p.t))}</td><td><span class="sdot" style="background:${ssColor(p.vmax)}"></span>${H.esc(ssCat(p.vmax)[1].replace('Category', 'Cat'))}</td><td>${p.vAgency != null ? kmh(p.vAgency) : '–'}</td><td>${p.gust ? kmh(p.gust * (s.windAvg === '10-min' ? 0.88 : 1)) : '–'}</td><td>${p.pressure ? p.pressure : '–'}</td><td>${Math.round(d).toLocaleString()} km ${H.dirName(bearing(loc.lat, loc.lon, p.lat, p.lon))}${p.note ? ` · ${H.esc(p.note)}` : ''}</td></tr>`;
    }).join('');
    $('#tcTable').innerHTML = `<thead><tr><th>Time (local)</th><th>Category</th><th>Wind</th><th>Gust</th><th>hPa</th><th>From you</th></tr></thead><tbody>${rows}</tbody>`;

    // official text
    const off = [];
    if (s.headline) off.push(`<p class="tc-headline">${H.esc(s.headline)}</p>`);
    if (s.watchesWarnings) off.push(`<details open><summary>Watches & warnings (${H.esc(s.official?.code || s.source)})</summary><pre>${H.esc(s.watchesWarnings)}</pre></details>`);
    if (s.hazards) off.push(`<details><summary>Hazards affecting land</summary><pre>${H.esc(s.hazards.replace(/Key messages.*?\n\s*\n/s, ''))}</pre></details>`);
    const alt = (s.alt || [])[0];
    if (s.summary || alt?.summary) off.push(`<details><summary>JTWC remarks</summary><p>${H.esc(s.summary || alt.summary)}</p></details>`);
    if (s.source === 'JMA') off.push(`<details><summary>JMA analysis</summary><p>${H.esc([s.classText, s.scale ? s.scale + ' size' : null, s.gale?.length ? 'Gale area ' + s.gale.map((g) => `${g.dir} ${Math.round(g.nm * NM)} km`).join(', ') : null, s.storm?.length ? 'Storm area ' + s.storm.map((g) => `${g.dir} ${Math.round(g.nm * NM)} km`).join(', ') : null].filter(Boolean).join(' · '))}</p></details>`);
    if (s.gdacs) off.push(`<details><summary>GDACS ${H.esc(s.gdacs.alertLevel || '')} alert</summary><p>${H.esc(s.gdacs.severity || '')}. Affected: ${H.esc((s.gdacs.countries || []).join(', ') || '—')}.</p><div class="gd-img">${Object.entries(s.gdacs.images || {}).filter(([k]) => /surge|rain/.test(k)).map(([k, u]) => `<a href="${H.esc(u)}" target="_blank" rel="noopener"><img loading="lazy" src="${H.esc(u)}" alt="${H.esc(k)}"><span>${k.includes('surge') ? 'Model storm surge (' + (k.split('_').pop()) + ')' : 'Rain forecast'}</span></a>`).join('')}</div>${s.gdacs.report ? `<p><a href="${H.esc(s.gdacs.report)}" target="_blank" rel="noopener">GDACS report</a></p>` : ''}</details>`);
    $('#tcOfficial').innerHTML = off.join('') || '<p class="muted">No text bulletin available from this agency.</p>';

    const local = LOCAL[st.ctx.cc];
    const links = [[s.official?.name, s.official?.url], local && [local[0] + ' (your national service)', local[1]], ...(s.links || []).map((l) => [l.label, l.url]), ...((s.alt || [])[0]?.links || []).map((l) => [l.label, l.url])].filter((l) => l && l[1]);
    $('#tcLinks').innerHTML = links.map(([n, u]) => `<a class="chip" href="${H.esc(u)}" target="_blank" rel="noopener">${H.esc(n)} ↗</a>`).join('');
    const issued = s.advisoryIssued || s.issued || s.time;
    $('#tcMeta').textContent = `Data: ${s.official?.code === s.source ? s.official.name : `${s.source}${s.official ? ` · official centre ${s.official.name}` : ''}`} · advisory ${H.ago(Date.parse(issued))} · SkyPulse feed updated ${st.data?.generated ? H.ago(Date.parse(st.data.generated)) : '—'}. Local impacts are estimates from agency wind radii and forecast models; always follow official warnings.`;
    drawMap(a);
  }
  function surgeOfficial(s) {
    const m = (s.hazards || '').match(/STORM SURGE:\s*([\s\S]*?)(?:\n\s*\n|$)/);
    return m ? ` Official: “${H.esc(m[1].replace(/\s+/g, ' ').trim())}”` : '';
  }
  function rainOfficial(s) {
    const m = (s.hazards || '').match(/RAINFALL:\s*([\s\S]*?)(?:\n\s*\n|$)/);
    return m ? ` Official: “${H.esc(m[1].replace(/\s+/g, ' ').trim())}”` : '';
  }

  /* ------------------------------------------------------------------ map */
  function quadPolygon(lat, lon, r) {
    const pts = [];
    for (let b = 0; b <= 360; b += 6) { const q = r[Math.min(3, Math.floor((b % 360) / 90))]; if (q > 0) pts.push(dest(lat, lon, b, q * NM)); else pts.push([lat, lon]); }
    return pts;
  }
  function hull(points) {
    const p = points.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const cross = (o, a, b) => (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
    const lower = [], upper = [];
    for (const x of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], x) <= 0) lower.pop(); lower.push(x); }
    for (let i = p.length - 1; i >= 0; i--) { const x = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], x) <= 0) upper.pop(); upper.push(x); }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }
  // NHC average track errors (nm) for a computed cone when no official cone is published
  const CONE_NM = [[0, 0], [12, 26], [24, 39], [36, 52], [48, 67], [60, 83], [72, 97], [96, 130], [120, 180]];
  const coneR = (tau) => { for (let i = 1; i < CONE_NM.length; i++) if (tau <= CONE_NM[i][0]) { const [t0, r0] = CONE_NM[i - 1], [t1, r1] = CONE_NM[i]; return r0 + (r1 - r0) * (tau - t0) / (t1 - t0); } return 180; };
  function computedCone(trk, s) {
    const circles = trk.map((p) => {
      const tau = (p.t - trk[0].t) / HOUR, r = (s.source === 'JMA' && p.probNm != null ? p.probNm : coneR(tau)) * NM;
      const c = []; for (let b = 0; b < 360; b += 15) { const [la, lo] = dest(p.lat, p.lon, b, Math.max(r, 5)); c.push([la, unwrap(lo, p.lon)]); } return c;
    });
    const rings = [];
    for (let i = 0; i < circles.length - 1; i++) rings.push(hull(circles[i].concat(circles[i + 1])));
    return rings;
  }

  function drawMap(a) {
    if (typeof L === 'undefined') { $('#tcMap').innerHTML = '<p class="muted" style="padding:16px">Map library failed to load.</p>'; return; }
    if (!st.map) {
      st.map = L.map('tcMap', { zoomControl: true, attributionControl: true, worldCopyJump: false, scrollWheelZoom: false, tap: true });
      const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
      L.tileLayer(esri + 'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 13, attribution: 'Tiles &copy; Esri — Esri, HERE, Garmin, &copy; OpenStreetMap contributors' }).addTo(st.map);
      L.tileLayer(esri + 'World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 13, pane: 'overlayPane', opacity: 0.85 }).addTo(st.map);
      st.layers = L.layerGroup().addTo(st.map);
    }
    const s = a.s, loc = st.ctx.loc, g = st.layers; g.clearLayers();
    const ref = a.cur.lon, uLon = unwrap(loc.lon, ref);
    const fixRing = (ring) => ring.map(([la, lo]) => [la, unwrap(lo, ref)]);
    // cone
    let coneLabel = 'computed';
    if (s.cone) { L.polygon(fixRing(s.cone), { color: '#ffffff', weight: 1, opacity: 0.6, fillColor: '#ffffff', fillOpacity: 0.12, dashArray: '4 4' }).addTo(g); coneLabel = s.official?.code || s.source; }
    else if (s.imd?.cone) { s.imd.cone.forEach((r) => L.polygon(fixRing(r), { color: '#ffffff', weight: 1, opacity: 0.6, fillOpacity: 0.12, fillColor: '#fff', dashArray: '4 4' }).addTo(g)); coneLabel = 'IMD'; }
    else if (a.trk.length > 1) L.polygon(computedCone(a.trk, s).map(fixRing), { stroke: false, fillColor: '#ffffff', fillOpacity: 0.11, fillRule: 'nonzero' }).addTo(g);
    if (s.imd) [['r28', '#7fd3ff'], ['r34', '#ffe066'], ['r50', '#ff9f43'], ['r64', '#ff5d5d']].forEach(([k, c]) => (s.imd[k] || []).forEach((r) => L.polygon(fixRing(r), { color: c, weight: 1, fillColor: c, fillOpacity: 0.12 }).addTo(g)));
    // current wind radii
    [['34', '#ffe066'], ['50', '#ff9f43'], ['64', '#ff5d5d']].forEach(([k, c]) => {
      const r = s.radii?.[k]; if (!r || !r.some((x) => x > 0)) return;
      L.polygon(fixRing(quadPolygon(s.lat, s.lon, r)), { color: c, weight: 1.5, fillColor: c, fillOpacity: 0.16 }).addTo(g).bindPopup(`${k} kt winds (${Math.round(k * KT)} km/h+)`);
    });
    // JMA probability circles
    (s.forecast || []).forEach((f) => { if (f.probRadiusNm) L.circle([f.lat, unwrap(f.lon, ref)], { radius: f.probRadiusNm * NM * 1000, color: '#ffffff', weight: 1, opacity: 0.35, fill: false, dashArray: '2 4' }).addTo(g); });
    // past track
    const past = (s.past || []).map((p) => [p.lat, unwrap(p.lon, ref)]);
    const pastPath = past.length ? past : (s.pastPath || []).map(([la, lo]) => [la, unwrap(lo, ref)]);
    if (pastPath.length) L.polyline(pastPath.concat([[a.trk[0].lat, a.trk[0].lon]]), { color: '#ffffff', weight: 2, opacity: 0.7 }).addTo(g);
    // forecast track with intensity dots
    L.polyline(a.trk.map((p) => [p.lat, p.lon]), { color: '#ffffff', weight: 2, dashArray: '6 6', opacity: 0.9 }).addTo(g);
    a.trk.forEach((p, k) => {
      L.circleMarker([p.lat, p.lon], { radius: k ? 6 : 9, color: '#0b1530', weight: 1.5, fillColor: ssColor(p.vmax), fillOpacity: 1 }).addTo(g)
        .bindPopup(`<b>${H.esc(H.fmtDay(p.t))} ${H.esc(H.fmtHM(p.t))}</b><br>${H.esc(ssCat(p.vmax)[1])}<br>${p.vAgency != null ? H.fW(p.vAgency * KT) + ' ' + H.wU() : ''}${p.pressure ? ' · ' + p.pressure + ' hPa' : ''}`);
    });
    // you + closest approach
    const you = L.circleMarker([loc.lat, uLon], { radius: 7, color: '#fff', weight: 2, fillColor: '#4fd18b', fillOpacity: 1 }).addTo(g).bindPopup('You are here');
    if (a.series.length) L.polyline([[loc.lat, uLon], [a.cpa.lat, unwrap(a.cpa.lon, ref)]], { color: '#4fd18b', weight: 1.5, dashArray: '3 5' }).addTo(g).bindTooltip(`${Math.round(a.cpa.dKm)} km at closest approach`, { sticky: true });
    $('#tcLegend').innerHTML = `<span><i style="background:#fff;opacity:.4"></i>Cone (${H.esc(coneLabel)})</span><span><i style="background:#ffe066"></i>34 kt</span><span><i style="background:#ff9f43"></i>50 kt</span><span><i style="background:#ff5d5d"></i>64 kt</span><span><i style="background:#4fd18b;border-radius:50%"></i>You</span>`;
    const bounds = L.latLngBounds(a.trk.map((p) => [p.lat, p.lon]).concat(pastPath.slice(-6)).concat([[loc.lat, uLon]]));
    const fit = () => { st.map.invalidateSize(); st.map.fitBounds(bounds.pad(0.15), { maxZoom: 7 }); };
    if (st.mapKey !== s.key + loc.lat + loc.lon) { st.mapKey = s.key + loc.lat + loc.lon; setTimeout(fit, 60); }
    void you;
  }

  /* --------------------------------------------------------------- update */
  async function update(ctx) {
    st.ctx = ctx;
    const now = Date.now(), loc = ctx.loc, jobs = [];
    if (!st.data || now - st.dataAt > 5 * 60e3) jobs.push(H.getJSON('data/tropical.json?t=' + Math.floor(now / 300e3), 12000).then((d) => { st.data = d; st.dataAt = now; st.dataErr = null; }).catch((e) => { st.dataErr = e.message; }));
    const ck = `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
    if (st.coastKey !== ck) { st.coastKey = ck; st.coast = null; st.marine = null; st.userSel = false; jobs.push(coastProbe(loc.lat, loc.lon).then((c) => { st.coast = c; }).catch(() => { st.coast = null; })); }
    const usLike = ['US', 'PR', 'GU', 'VI', 'AS', 'MP'].includes(ctx.cc) || (!ctx.cc && loc.lat > 17 && loc.lat < 72 && loc.lon < -64 && loc.lon > -180);
    if (usLike && (st.nwsKey !== ck || now - st.nwsAt > 5 * 60e3)) jobs.push(H.getJSON(`https://api.weather.gov/alerts/active?point=${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`, 10000).then((d) => { st.nws = d; st.nwsAt = now; st.nwsKey = ck; }).catch(() => { st.nws = null; }));
    else if (!usLike) st.nws = null;
    if (ctx.cc === 'HK' && now - st.hkoAt > 5 * 60e3) jobs.push(H.getJSON('https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=warnsum&lang=en', 10000).then((d) => { st.hko = d; st.hkoAt = now; }).catch(() => { st.hko = null; }));
    await Promise.all(jobs);
    ctx.coast = st.coast;
    if (st.coast?.coastal && st.coast.distKm <= 30 && (st.marineKey !== ck || now - st.marineAt > 30 * 60e3)) {
      const [la, lo] = st.coast.seaPoint || [loc.lat, loc.lon];
      try { st.marine = await marine(la, lo); st.marineAt = now; st.marineKey = ck; } catch { st.marine = null; }
    }

    const analyses = (st.data?.storms || []).map((s) => { try { return analyze(s, loc, ctx); } catch (e) { console.warn('TC analysis', s.key, e); return null; } }).filter(Boolean)
      .sort((x, y) => ({ direct: 0, near: 1, watch: 2, far: 3 }[x.level] - { direct: 0, near: 1, watch: 2, far: 3 }[y.level]) || x.cpa.dKm - y.cpa.dKm);
    const threat = analyses.find((a) => a.level !== 'far') || null;
    st.last = { analyses, threat };
    if (!st.userSel || !analyses.some((a) => a.s.key === st.sel)) st.sel = threat?.s.key || null;
    const shown = analyses.find((a) => a.s.key === st.sel) || null;

    const warnings = [
      ...nwsWarnings(st.nws), ...(ctx.cc === 'IN' ? indiaWarnings(ctx) : []), ...hkoWarnings(st.hko), ...gdacsWarnings(ctx, threat),
      ...derivedWarnings(ctx, threat),
    ].filter((w) => !(w.source === 'official' && w.end && w.end < now))
     .sort((x, y) => (LV[y.level] - LV[x.level]) || ((x.source.startsWith('official') ? 0 : 1) - (y.source.startsWith('official') ? 0 : 1)));
    renderWarnings(warnings);
    renderStorm(shown);
    $('#stormList').innerHTML = analyses.length ? analyses.map(stormRow).join('') : `<li class="muted" style="padding:8px 2px">${st.data ? 'No active tropical cyclones worldwide right now.' : st.dataErr ? 'Tropical-cyclone feed unavailable (' + H.esc(st.dataErr) + ').' : 'Loading…'}</li>`;
    $('#stormListNote').textContent = st.data?.generated ? `${analyses.length} active · feed ${H.ago(Date.parse(st.data.generated))}` : '';

    const nowState = threat ? threat.series[0] : null;
    return {
      warnings, threat, analyses,
      cyclone: threat && threat.level === 'direct' && nowState && (nowState.sust >= 30 || (threat.ts && threat.ts.start - now < 3 * HOUR)),
      stormBearing: threat ? bearing(loc.lat, loc.lon, threat.cur.lat, threat.cur.lon) : null,
      hemisphere: threat?.south ? 'S' : 'N',
      tcWindowKt: (h) => threat ? Math.max(0, ...threat.series.filter((p) => p.t <= now + h * HOUR).map((p) => p.sust)) : 0,
    };
  }

  function init(helpers) {
    H = helpers;
    document.addEventListener('click', (e) => {
      const b = e.target.closest('.storm-row'); if (!b) return;
      st.sel = b.dataset.key; st.userSel = true;
      const a = st.last?.analyses.find((x) => x.s.key === st.sel);
      renderStorm(a);
      document.querySelectorAll('.storm-row').forEach((r) => r.classList.toggle('sel', r.dataset.key === st.sel));
      $('#tcCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  function refreshMap() { if (st.map) setTimeout(() => { st.map.invalidateSize(); }, 50); }
  function rerender() { if (st.last && st.ctx) { renderStorm(st.last.analyses.find((a) => a.s.key === st.sel)); } }

  window.Hazards = { init, update, refreshMap, rerender };
})();
