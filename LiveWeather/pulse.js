/* SkyPulse Pulse Advisor: what to take, or whether to go out at all, over a look-ahead window.
 *
 * Every factor (rain/snow intensity and type, wind and cyclone wind, feels-like temperature, visibility,
 * air quality and UV, active warnings) proposes a piece of advice with a level on one 0–5 scale:
 *   0 clear · 1 low · 2 moderate · 3 caution · 4 high · 5 extreme
 * The highest level wins (ties go to the more specific hazard), the rest become notes, and the gear list is
 * collected from all of them. Thresholds shift with the profile (standard / sensitive / hardy).
 * Pure logic: Pulse.compute(input) → advice. Formatting helpers are injected once with Pulse.init().
 */
(function () {
  'use strict';
  const HOUR = 3600e3, Q = 15 * 60e3;
  const LV = { red: 3, orange: 2, yellow: 1, info: 0 };
  const TONES = ['clear', 'low', 'moderate', 'caution', 'high', 'extreme'];
  const LEVEL_NAME = ['All clear', 'Low', 'Moderate', 'Caution', 'High', 'Extreme'];
  const PROFILES = {
    standard: { heat: 0, cold: 0, wind: 1, aqi: 0 },
    sensitive: { heat: -3, cold: 5, wind: 0.85, aqi: 1 },
    hardy: { heat: 3, cold: -5, wind: 1.15, aqi: 0 },
  };
  let F = null; // formatting helpers from app.js
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  /** how many thresholds a value has passed (ascending scale) */
  const passed = (v, list) => (num(v) ? list.filter((x) => v >= x).length : 0);
  const isSnow = (c) => (c >= 71 && c <= 77) || c === 85 || c === 86;
  const isWet = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;

  function compute(o) {
    const { H, M, cur } = o.t, now = o.now, winH = o.win, thr = o.thr, end = now + winH * HOUR;
    const prof = PROFILES[o.profile] || PROFILES.standard;
    const i0 = clamp(Math.floor((now - H.time[0]) / HOUR), 0, H.time.length - 1);
    const when = (ms) => (ms <= now ? 'now' : F.fmtHM(ms));

    /* ---------------- hours and 15-minute slots inside the window ---------------- */
    const idx = [];
    for (let i = i0; i < H.time.length && H.time[i] < end; i++) idx.push(i);
    const slots = [];
    if (M) for (let j = 0; j < M.time.length; j++) { if (M.time[j] + Q <= now) continue; if (M.time[j] >= end) break; slots.push(j); }

    /* ---------------- rain need: the umbrella logic ---------------- */
    let maxP = 0, maxI = idx[0], sum = 0, first = null;
    idx.forEach((i, k) => {
      const p = H.pp[i] ?? 0, r = H.pr[i] ?? 0;
      const w = k === 0 ? clamp(1 - (now - H.time[i]) / HOUR, 0, 1) : clamp((end - H.time[i]) / HOUR, 0, 1);
      sum += r * w;
      if (p > maxP) { maxP = p; maxI = i; }
      if (first === null && (p >= thr || r >= 0.3)) first = i;
    });
    let ncSum = 0, ncFirst = null;
    slots.forEach((j) => { const r = M.pr[j] ?? 0; ncSum += r; if (ncFirst === null && r >= 0.1) ncFirst = Math.max(now, M.time[j]); });
    const rainingNow = (cur.pr ?? 0) >= 0.1 || isWet(cur.wc);
    let clearsAt = null;
    if (rainingNow) for (let i = i0 + 1; i < H.time.length && H.time[i] < now + 24 * HOUR; i++) {
      if ((H.pp[i] ?? 0) < thr * 0.5 && (H.pr[i] ?? 0) < 0.1) { clearsAt = H.time[i]; break; }
    }

    /* ---------------- hazard inputs over the window ---------------- */
    const vals = (hk, mk, curV) => [...idx.map((i) => H[hk]?.[i]), ...(M && M[mk] ? slots.map((j) => M[mk][j]) : []), curV].filter(num);
    const codes = vals('wc', 'wc', cur.wc);
    const thunder = codes.some((c) => c >= 95), hail = codes.some((c) => c === 96 || c === 99);
    const freezing = codes.some((c) => [56, 57, 66, 67].includes(c));
    const snow = codes.some(isSnow), heavySnow = codes.some((c) => c === 75 || c === 86);
    const rates = [...idx.map((i) => H.pr[i]), ...slots.map((j) => (M.pr[j] ?? 0) * 4), cur.pr].filter(num);
    const maxRate = rates.length ? Math.max(...rates) : 0;
    let rateAt = now;
    idx.forEach((i) => { if ((H.pr[i] ?? 0) === maxRate) rateAt = Math.max(now, H.time[i]); });
    slots.forEach((j) => { if ((M.pr[j] ?? 0) * 4 === maxRate) rateAt = Math.max(now, M.time[j]); });
    const gusts = vals('wg', 'wg', cur.wg), maxGust = gusts.length ? Math.max(...gusts) : 0;
    let gustAt = now; idx.forEach((i) => { if (H.wg[i] === maxGust) gustAt = Math.max(now, H.time[i]); });
    const feels = vals('at', 'at', cur.at);
    const atMax = feels.length ? Math.max(...feels) : cur.at, atMin = feels.length ? Math.min(...feels) : cur.at;
    let heatAt = now, coldAt = now; idx.forEach((i) => { if (H.at[i] === atMax) heatAt = Math.max(now, H.time[i]); if (H.at[i] === atMin) coldAt = Math.max(now, H.time[i]); });
    const vis = vals('vis', 'vis'), minVis = vis.length ? Math.min(...vis) : null;
    const uvs = idx.filter((i) => H.day[i]).map((i) => H.uv[i]).filter(num), uvMax = uvs.length ? Math.max(...uvs) : 0;
    const aqi = o.aq && num(o.aq.us_aqi) ? o.aq.us_aqi : null;
    const tcKt = o.hz?.tcWindowKt ? o.hz.tcWindowKt(winH) : 0;
    const threat = o.hz?.threat || null;

    // warnings that overlap the window (or carry no time and are in force)
    const inWin = (w) => (!num(w.start) || w.start <= end) && (!num(w.end) || w.end >= now);
    const warnings = (o.hz?.warnings || []).filter(inWin);
    const official = warnings.filter((w) => w.source === 'official');
    const extraKinds = ['flood', 'waves', 'cyclone', 'surge'];           // derived hazards not covered by the factors below
    const derived = warnings.filter((w) => w.source !== 'official' && extraKinds.includes(w.kind));

    /* ---------------- candidate advice ---------------- */
    const C = [];
    const add = (key, level, prio, verdict, detail, icon) => C.push({ key, level, prio, verdict, detail, icon });

    // rain need (0–3, as the old umbrella advisor) → advice
    let rain;
    if (rainingNow || (thunder && maxP >= thr)) rain = 3;
    else if (maxP >= thr || sum >= 1 || (ncFirst !== null && ncSum >= 0.5)) rain = 2;
    else if (maxP >= thr * 0.6 || sum >= 0.2) rain = 1;
    else rain = 0;
    let rainDetail;
    if (rain === 3 && rainingNow) {
      rainDetail = `${F.cond(cur.wc)} right now${clearsAt ? `, easing around ${F.fmtHM(clearsAt)}` : ' and continuing for a while'}.`;
      add('rain', 2, 40, isSnow(cur.wc) ? 'Snowing — cover up' : 'Umbrella needed now', rainDetail, isSnow(cur.wc) ? 'snow' : 'umbrella');
    } else if (rain >= 2) {
      rainDetail = `Rain likely ${first != null && H.time[first] > now ? 'from about ' + when(H.time[first]) : 'soon'} — peak ${maxP}% chance${maxI != null && H.time[maxI] > now ? ' around ' + when(H.time[maxI]) : ''}, ~${F.fP(sum)} ${F.pU()} expected in the next ${winH} h.`;
      if (ncFirst !== null && ncFirst - now < 90 * 60e3) rainDetail += ` Nowcast shows rain starting ${ncFirst - now < 5 * 60e3 ? 'any minute' : 'in ~' + F.dur(ncFirst - now)}.`;
      add('rain', 2, 40, 'Take an umbrella', rainDetail, 'umbrella');
    } else if (rain === 1) {
      rainDetail = `Small risk: up to ${maxP}% chance${maxI != null ? ' around ' + when(H.time[maxI]) : ''} within ${winH} h.`;
      add('rain', 1, 40, 'Pack a compact umbrella', rainDetail, 'umbrella');
    } else {
      rainDetail = `Rain chance stays at or below ${maxP}% for the next ${winH} h.`;
      add('rain', 0, 0, 'No umbrella needed', rainDetail, 'closed');
    }
    // an umbrella is useless in strong gusts: same rain, different gear
    const noUmbrella = (rain >= 1 && maxGust >= 60) || tcKt >= 34;
    if (rain >= 1 && maxGust >= 60) add('jacket', rain >= 2 ? 2 : 1, 82, rain >= 2 ? 'Rain jacket, not an umbrella' : 'Pack a rain jacket',
      `${rainDetail} Gusts up to ${F.fW(maxGust)} ${F.wU()} will turn an umbrella inside out.`, 'jacket');
    // intensity
    if (!snow || maxRate >= 7.6) {
      if (maxRate >= 50) add('downpour', 4, 66, 'Torrential rain — avoid going out', `Bursts of up to ${F.fP(maxRate)} ${F.pU()}/h around ${when(rateAt)}. Flash flooding is likely: keep away from streams, underpasses and flooded roads.`, 'umbrella');
      else if (maxRate >= 20) add('downpour', 3, 65, 'Downpours — limit time outside', `Bursts of up to ${F.fP(maxRate)} ${F.pU()}/h around ${when(rateAt)}; streets and underpasses can flood quickly.`, 'umbrella');
      else if (maxRate >= 7.6) add('downpour', 2, 45, 'Heavy rain — umbrella and waterproof shoes', `Heavy rain at times, up to ${F.fP(maxRate)} ${F.pU()}/h around ${when(rateAt)}.`, 'umbrella');
    }
    if (hail) add('hail', 4, 72, 'Hail — stay under cover', 'Thunderstorms with hail are forecast in this window. Stay indoors or in a car, away from windows.', 'storm');
    else if (thunder) add('thunder', maxP >= thr * 0.6 || rainingNow ? 3 : 2, 70, 'Thunderstorms — stay near shelter', `Thunderstorms are possible${maxI != null && H.time[maxI] > now ? `, peaking at ${maxP}% around ${when(H.time[maxI])}` : ''}. When thunder roars, go indoors; avoid open ground, water and lone trees.`, 'storm');
    if (freezing) add('ice', 4, 75, 'Freezing rain — icy, avoid going out', 'Rain freezing on contact will glaze roads, pavements and steps with ice.', 'ice');
    if (snow) {
      if (maxGust >= 50) add('snow', 4, 60, 'Blowing snow — stay in if you can', `Snow with gusts up to ${F.fW(maxGust)} ${F.wU()}: visibility can drop to near zero.`, 'snow');
      else if (heavySnow) add('snow', 3, 60, 'Heavy snow — avoid unnecessary travel', 'Heavy snow in this window; roads and paths will be slippery.', 'snow');
      else add('snow', 2, 60, 'Snow — hooded jacket and boots', 'Snow in this window — a hooded jacket beats an umbrella.', 'snow');
    }
    // wind (cyclone first)
    const windLv = passed(maxGust, [40, 62, 75, 89, 118].map((x) => x * prof.wind));
    if (tcKt >= 34) {
      const s = threat?.s || {};
      add('tc', 5, 100, 'Stay indoors — cyclone winds',
        `${s.classText || 'Cyclone'} ${s.name || ''}: winds up to ~${F.fW(tcKt * 1.852)} ${F.wU()} in the next ${winH} h${rainingNow ? `, with ${F.cond(cur.wc).toLowerCase()} now` : maxP ? `, rain chance up to ${maxP}%` : ''}. Umbrellas are useless and dangerous in wind-driven rain — follow official advice.`, 'home');
    } else if (tcKt >= 25) {
      add('tc', 3, 100, 'Cyclone nearby — limit time outdoors', `${threat?.s?.name || 'A tropical cyclone'} brings winds of ~${F.fW(tcKt * 1.852)} ${F.wU()} here in the next ${winH} h. Finish preparations and secure loose objects.`, 'wind');
    }
    if (windLv >= 2) {
      const v = [null, null, 'Strong gusts — take care outside', 'Very windy — limit time outdoors', 'Damaging winds — avoid going out', 'Stay indoors — destructive winds'][windLv];
      add('wind', windLv, 80, v, `Gusts up to ${F.fW(maxGust)} ${F.wU()} around ${when(gustAt)}${windLv >= 4 ? ' — falling branches and flying debris are likely; stay away from trees and power lines.' : '.'}`, windLv >= 5 ? 'home' : 'wind');
    }
    // feels-like temperature
    const heatLv = passed(atMax, [32, 36, 40, 45, 52].map((x) => x + prof.heat));
    const coldLv = num(atMin) ? [0, -10, -20, -28, -35].map((x) => x + prof.cold).filter((x) => atMin <= x).length : 0;
    if (heatLv) add('heat', heatLv, 55, [null, 'Warm — stay hydrated', 'Hot — water and shade', 'Very hot — limit exertion outdoors', 'Extreme heat — avoid going out midday', 'Dangerous heat — stay somewhere cool'][heatLv],
      `Feels like up to ${F.fT(atMax)} around ${when(heatAt)}.${heatLv >= 3 ? ' Heat exhaustion can set in quickly — rest in the shade and check on vulnerable people.' : ''}`, heatLv >= 5 ? 'home' : 'heat');
    if (coldLv) add('cold', coldLv, 54, [null, 'Cold — dress in layers', 'Very cold — hat and gloves', 'Bitter cold — cover exposed skin', 'Severe cold — limit time outside', 'Dangerous cold — stay indoors'][coldLv],
      `Feels like ${F.fT(atMin)} around ${when(coldAt)}.${coldLv >= 3 ? ' Frostbite can develop on exposed skin within minutes.' : ''}`, coldLv >= 5 ? 'home' : 'cold');
    // visibility, air, sun
    const fogLv = num(minVis) ? (minVis < 200 ? 3 : minVis < 1000 ? 1 : 0) : 0;
    if (fogLv) add('fog', fogLv, 50, fogLv >= 3 ? 'Dense fog — avoid driving if you can' : 'Mist or fog — take care on the roads', `Visibility down to ${minVis < 1000 ? Math.round(minVis) + ' m' : (minVis / 1000).toFixed(1) + ' km'} in this window.`, 'fog');
    let airLv = passed(aqi, [101, 151, 201, 301]);
    if (airLv && prof.aqi) airLv = Math.min(5, airLv + prof.aqi);
    if (airLv) add('air', airLv, 45, [null, 'Air quality poor for sensitive groups', 'Unhealthy air — limit outdoor exertion', 'Very unhealthy air — stay indoors if you can', 'Hazardous air — stay indoors', 'Hazardous air — stay indoors'][airLv], `US AQI ${Math.round(aqi)} right now.`, 'mask');
    const uvLv = uvMax >= 11 ? 2 : uvMax >= 8 ? 1 : 0;
    if (uvLv) add('uv', uvLv, 30, uvLv >= 2 ? 'Extreme UV — avoid the midday sun' : 'Very strong sun — sunscreen and a hat', `UV index up to ${uvMax.toFixed(0)} in this window.`, 'sun');
    // warnings
    // an alert for other districts of your state (local === false) counts here as an advisory at most
    const lvHere = (w) => (w.local === false && LV[w.level] > LV.yellow ? 'yellow' : w.level);
    const topOff = official.slice().sort((a, b) => LV[lvHere(b)] - LV[lvHere(a)])[0];
    const offLv = topOff ? { red: 5, orange: 4, yellow: 2, info: 0 }[lvHere(topOff)] : 0;
    if (offLv) add('official', offLv, 90, offLv >= 5 ? 'Dangerous weather — follow official advice' : offLv >= 4 ? 'Official warning — avoid going out if you can' : 'Official advisory in effect',
      `${topOff.agency || 'Official'}: ${topOff.title}.${topOff.text ? ' ' + topOff.text : ''}`, offLv >= 5 ? 'home' : 'alert');
    const topDer = derived.slice().sort((a, b) => LV[b.level] - LV[a.level])[0];
    const derLv = topDer ? { red: 4, orange: 3, yellow: 1, info: 0 }[topDer.level] : 0;
    if (derLv) add('derived', derLv, topDer.source === 'derived-tc' ? 85 : 62, topDer.title, `${topDer.text || ''}${topDer.advice ? ' ' + topDer.advice : ''}`.trim(), topDer.kind === 'cyclone' ? 'wind' : 'alert');

    const precipLvOf = () => Math.max(...C.filter((c) => ['rain', 'jacket', 'downpour', 'hail', 'thunder', 'ice', 'snow'].includes(c.key)).map((c) => c.level), 0);

    /* ---------------- decide ---------------- */
    C.sort((a, b) => b.level - a.level || b.prio - a.prio);
    let top = C[0];
    // an official warning backs up a specific hazard of the same level: lead with the specific advice, cite the warning
    if (top.key === 'official') {
      const alt = C.find((c) => c !== top && c.level === top.level && c.key !== 'derived');
      if (alt) top = { ...alt, detail: `${alt.detail} Official warning in force — ${topOff.agency || 'national service'}: ${topOff.title}.`, merged: true };
    }
    const level = top.level;
    const notes = [];
    C.filter((c) => c.key !== top.key && c.level >= 2 && c.key !== 'rain' && c.verdict !== top.verdict && !(top.merged && c.key === 'official')).slice(0, 2).forEach((c) => notes.push(`⚠️ Also: ${c.verdict}.`));
    if (rain >= 1 && !noUmbrella && maxGust >= 45) notes.push(`💨 Gusts up to ${F.fW(maxGust)} ${F.wU()} — choose a windproof umbrella, or a rain jacket.`);
    if (thunder && top.key !== 'thunder') notes.push('⚡ Thunderstorms possible — avoid open ground and tall isolated trees.');
    if (level === 0 && (H.uv[i0] ?? 0) >= 6) notes.push('😎 Strong sun though — an umbrella doubles as shade.');
    if (top.key !== 'rain' && rain >= 1 && level >= 2) notes.push(`☔ ${rainDetail}`);

    // gear
    const gear = [];
    const g = (icon, label) => { if (!gear.some((x) => x.label === label)) gear.push({ icon, label }); };
    if (level >= 5 || (top.icon === 'home')) g('🏠', 'Shelter indoors');
    if (rain >= 1 && !noUmbrella && !(snow && !codes.some((c) => isWet(c) && !isSnow(c)))) g('☂️', rain === 1 ? 'Compact umbrella' : maxGust >= 45 ? 'Windproof umbrella' : 'Umbrella');
    if (noUmbrella && rain >= 1) g('🧥', 'Rain jacket');
    if (snow) g('🧥', 'Hooded jacket');
    if (maxRate >= 7.6 || snow || sum >= 10) g('🥾', 'Waterproof shoes');
    if (freezing) g('🥾', 'Grippy footwear');
    if (num(atMin) && atMin <= -5 + prof.cold) g('🧤', 'Hat & gloves');
    else if (num(atMin) && atMin <= 8 + prof.cold) g('🧣', 'Warm layers');
    if (num(atMax) && atMax >= 30 + prof.heat) g('💧', 'Water bottle');
    const sunny = level < 4 && precipLvOf() < 2;            // no sun gear when the advice is to stay in, or it pours
    if (sunny && uvMax >= 6) g('🧴', 'Sunscreen');
    if (sunny && (uvMax >= 6 || heatLv >= 2)) g('🧢', 'Sun hat');
    if (sunny && uvMax >= 8) g('🕶️', 'Sunglasses');
    if (airLv >= 2) g('😷', 'Mask (N95/FFP2)');
    if (fogLv) g('🔦', 'Lights on');

    // the six meters
    const precipLv = precipLvOf();
    const nOff = official.length, nSky = warnings.length - nOff;
    const factors = [
      { key: 'precip', label: 'Rain & snow', level: precipLv, value: maxRate < 0.1 && rain === 0 ? `Dry · ≤${maxP}%` : `${maxP}% · ${F.fP(maxRate)} ${F.pU()}/h` },
      { key: 'wind', label: 'Wind', level: Math.max(windLv, tcKt >= 34 ? 5 : tcKt >= 25 ? 3 : 0), value: `Gusts ${F.fW(Math.max(maxGust, tcKt * 1.852 * 1.25))} ${F.wU()}` },
      { key: 'temp', label: 'Feels like', level: Math.max(heatLv, coldLv), value: num(atMin) && Math.round(atMin) !== Math.round(atMax) ? `${F.fT(atMin)} → ${F.fT(atMax)}` : F.fT(atMax) },
      { key: 'vis', label: 'Visibility', level: fogLv, value: num(minVis) ? (minVis < 1000 ? `${Math.round(minVis)} m` : F.fV(minVis)) : '–' },
      { key: 'air', label: 'Air & UV', level: Math.max(airLv, uvLv), value: `${aqi != null ? 'AQI ' + Math.round(aqi) : 'AQI –'} · UV ${uvMax.toFixed(0)}` },
      { key: 'alerts', label: 'Alerts', level: Math.max(offLv, derLv), value: warnings.length ? `${warnings.length} active${nOff ? ` · ${nOff} official` : ''}` : 'None in effect' },
    ];

    // advisories to list: everything relevant in the window, most severe and official first
    const advisories = warnings.slice().sort((a, b) => LV[b.level] - LV[a.level] || (a.source === 'official' ? -1 : 0) - (b.source === 'official' ? -1 : 0)).slice(0, 4);

    return {
      level, tone: TONES[level], levelName: LEVEL_NAME[level], verdict: top.verdict, detail: top.detail, icon: top.icon, topKey: top.key,
      notes: notes.slice(0, 4), gear: gear.slice(0, 6), factors, advisories, moreWarnings: Math.max(0, (o.hz?.warnings || []).length - advisories.length),
      threat: threat && threat.level !== 'far' ? threat : null,
      rain: { level: rain, maxP, maxI, sum, first, firstRain: first != null ? H.time[first] : ncFirst, idx, thunder, rainingNow, clearsAt, noUmbrella },
    };
  }

  window.Pulse = { init: (helpers) => { F = helpers; }, compute, TONES, LEVEL_NAME };
})();
