/* SkyPulse cyclone tracker: every active tropical cyclone on one interactive Leaflet map.
 *
 * Draws, per storm: the forecast cone (official NHC/IMD polygon, else a cone built from typical track errors),
 * the past track coloured by intensity, the forecast track with Saffir–Simpson-coloured points, the current
 * 34/50/64-kt wind radii and a label. A time slider (with play) moves every storm along its forecast. Picking a
 * storm zooms to it and fills the detail card (hazards.js) plus an intensity-forecast chart with a typical-error
 * band. Storm data and per-storm analyses come from Hazards.update(); geometry helpers from Hazards.lib.
 */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const HOUR = 3600e3;
  // approximate multi-year mean error of official intensity forecasts (kt) by lead time (h), for the error band
  const INT_ERR = [[0, 0], [12, 6], [24, 9], [36, 11], [48, 12], [72, 14], [96, 15], [120, 16]];
  const RADII = [['34', '#ffe066'], ['50', '#ff9f43'], ['64', '#ff5d5d']];
  let H = null;
  const st = { map: null, g: null, data: null, dataErr: null, analyses: [], threat: null, loc: null, sel: null, userSel: false, t: 0, play: null, fitKey: null, needFit: false, full: false };
  const lib = () => window.Hazards?.lib;
  const layers = () => Prefs.get('stormLayers');
  const selected = () => st.analyses.find((a) => a.s.key === st.sel) || null;
  const interp = (table, x) => { for (let i = 1; i < table.length; i++) if (x <= table[i][0]) { const [x0, y0] = table[i - 1], [x1, y1] = table[i]; return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0); } return table.at(-1)[1]; };
  const visible = () => { const el = $('#tcMap'); return !!el && el.offsetWidth > 0 && el.offsetHeight > 0; };

  /* ------------------------------------------------------------- map setup */
  function ensureMap() {
    if (st.map) return true;
    if (typeof L === 'undefined') { $('#tcMap').innerHTML = '<p class="muted" style="padding:16px">Map library failed to load.</p>'; return false; }
    st.map = L.map('tcMap', { zoomControl: true, attributionControl: true, worldCopyJump: false, scrollWheelZoom: false, minZoom: 1, maxZoom: 10, zoomSnap: 0.5 });
    const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
    L.tileLayer(esri + 'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 13, attribution: 'Tiles &copy; Esri — Esri, HERE, Garmin, &copy; OpenStreetMap contributors', referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(st.map);
    L.tileLayer(esri + 'World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 13, pane: 'overlayPane', opacity: 0.85 }).addTo(st.map);
    st.g = Object.fromEntries(['cone', 'sel', 'radii', 'past', 'track', 'time', 'you', 'storms'].map((k) => [k, L.layerGroup().addTo(st.map)]));
    // wheel-zoom only once the map has focus (or is full screen), so the page still scrolls past it
    st.map.on('focus', () => st.map.scrollWheelZoom.enable());
    st.map.on('blur', () => { if (!st.full) st.map.scrollWheelZoom.disable(); });
    st.map.setView([20, st.loc ? st.loc.lon : 0], 2);
    return true;
  }

  /** a reference longitude that keeps every storm (and you) on one continuous strip of map */
  function bestRef(lons) {
    const { unwrap } = lib();
    let best = lons[0] ?? 0, span = Infinity;
    for (const c of lons) { const u = lons.map((l) => unwrap(l, c)); const sp = Math.max(...u) - Math.min(...u); if (sp < span) { span = sp; best = c; } }
    return best;
  }

  /* ------------------------------------------------------------------ draw */
  function draw() {
    if (!ensureMap() || !st.loc) return;
    const Lb = lib(), lay = layers(), loc = st.loc, an = st.analyses;
    Object.values(st.g).forEach((g) => g.clearLayers());
    const ref = bestRef([...an.map((a) => a.cur.lon), loc.lon]);
    st.ref = ref;
    const uLon = Lb.unwrap(loc.lon, ref);

    an.forEach((a) => {
      const s = a.s, isSel = s.key === st.sel;
      const shift = Lb.unwrap(a.cur.lon, ref) - a.cur.lon;                 // whole turns of 360° for this storm
      const P = (la, lo) => [la, Lb.unwrap(lo, a.cur.lon) + shift];
      const R = (ring) => ring.map(([la, lo]) => P(la, lo));
      a.$P = P;
      // cone of uncertainty
      if (lay.cone) {
        const opt = { color: '#ffffff', weight: isSel ? 1.2 : 0.8, opacity: isSel ? 0.7 : 0.4, fillColor: '#ffffff', fillOpacity: isSel ? 0.13 : 0.07, dashArray: '4 4', interactive: false };
        if (s.cone && s.cone.length > 2) L.polygon(R(s.cone), opt).addTo(st.g.cone);
        else if (s.imd?.cone) s.imd.cone.forEach((r) => L.polygon(R(r), opt).addTo(st.g.cone));
        else if (a.trk.length > 1) L.polygon(Lb.computedCone(a.trk, s).map(R), { stroke: false, fillColor: '#ffffff', fillOpacity: isSel ? 0.12 : 0.06, fillRule: 'nonzero', interactive: false }).addTo(st.g.cone);
      }
      // past track, coloured by intensity where the agency gives it
      if (lay.past) {
        const tenMin = s.windAvg === '10-min';
        const past = s.past.length ? s.past.map((p) => ({ lat: p.lat, lon: p.lon, v: p.vmaxKt != null ? (tenMin ? p.vmaxKt / 0.88 : p.vmaxKt) : null }))
          : s.pastPath.map(([lat, lon]) => ({ lat, lon, v: null }));
        const pts = past.concat([{ lat: a.trk[0].lat, lon: a.trk[0].lon, v: a.trk[0].vmax }]);
        for (let k = 1; k < pts.length; k++) {
          const v = pts[k - 1].v;
          L.polyline([P(pts[k - 1].lat, pts[k - 1].lon), P(pts[k].lat, pts[k].lon)], { color: v != null ? Lb.ssColor(v) : '#ffffff', weight: isSel ? 3 : 2.2, opacity: 0.85, interactive: false }).addTo(st.g.past);
        }
      }
      // forecast track with intensity points
      if (lay.track && a.trk.length > 1) {
        L.polyline(a.trk.map((p) => P(p.lat, p.lon)), { color: '#ffffff', weight: isSel ? 2.2 : 1.6, dashArray: '6 6', opacity: 0.9, interactive: false }).addTo(st.g.track);
        a.trk.slice(1).forEach((p) => {
          L.circleMarker(P(p.lat, p.lon), { radius: isSel ? 6 : 4.5, color: '#0b1530', weight: 1.2, fillColor: Lb.ssColor(p.vmax), fillOpacity: 1 })
            .addTo(st.g.track)
            .bindTooltip(`<b>${H.esc(s.name)}</b> · ${H.esc(H.fmtDay(p.t))} ${H.esc(H.fmtHM(p.t))}<br>${H.esc(Lb.ssCat(p.vmax)[1])}${p.vAgency != null ? ` · ${H.esc(H.fW(p.vAgency * Lb.KT))} ${H.esc(H.wU())}` : ''}${p.pressure ? ` · ${H.esc(H.fPr(p.pressure))} ${H.esc(H.prU())}` : ''}`)
            .on('click', () => select(s.key));
        });
      }
      // current wind radii
      if (lay.radii) RADII.forEach(([k, c]) => {
        const r = s.radii?.[k]; if (!r || !r.some((x) => x > 0)) return;
        L.polygon(R(Lb.quadPolygon(s.lat, s.lon, r)), { color: c, weight: 1.2, fillColor: c, fillOpacity: isSel ? 0.18 : 0.12, interactive: false }).addTo(st.g.radii);
      });
      // the storm symbol
      const size = isSel ? 38 : 28;
      const icon = L.divIcon({ className: 'storm-ico' + (isSel ? ' sel' : ''), html: WX.stormGlyph(Lb.ssColor(a.cur.vmax), a.south, size), iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
      const mk = L.marker(P(a.cur.lat, a.cur.lon), { icon, title: s.name, riseOnHover: true, zIndexOffset: isSel ? 1000 : 0 }).addTo(st.g.storms).on('click', () => select(s.key));
      const lbl = `<b>${H.esc(s.name)}</b> <span>${H.esc(Lb.ssCat(a.cur.vmax)[1].replace('Category ', 'Cat ').replace('Tropical ', 'T. '))}</span>`;
      mk.bindTooltip(lbl, lay.labels ? { permanent: true, direction: 'right', offset: [size / 2, 0], className: 'storm-label' } : { direction: 'top', className: 'storm-label' });
    });

    // extra layers for the selected storm: IMD wind areas, JMA probability circles, your closest approach
    const a = selected();
    if (a) {
      const s = a.s, P = a.$P;
      if (s.imd && lay.radii) [['r28', '#7fd3ff'], ['r34', '#ffe066'], ['r50', '#ff9f43'], ['r64', '#ff5d5d']].forEach(([k, c]) => (s.imd[k] || []).forEach((r) => L.polygon(r.map(([la, lo]) => P(la, lo)), { color: c, weight: 1, fillColor: c, fillOpacity: 0.1, interactive: false }).addTo(st.g.sel)));
      if (lay.cone) s.forecast.forEach((f) => { if (f.probRadiusNm && f.lat != null) L.circle(P(f.lat, f.lon), { radius: f.probRadiusNm * Lb.NM * 1000, color: '#ffffff', weight: 1, opacity: 0.35, fill: false, dashArray: '2 4', interactive: false }).addTo(st.g.sel); });
      if (a.series.length && a.level !== 'far') {
        L.polyline([[loc.lat, uLon], P(a.cpa.lat, a.cpa.lon)], { color: '#4fd18b', weight: 1.5, dashArray: '3 5' }).addTo(st.g.sel)
          .bindTooltip(`${H.esc(H.fD(a.cpa.dKm))} at closest approach`, { sticky: true });
      }
    }
    L.circleMarker([loc.lat, uLon], { radius: 7, color: '#fff', weight: 2, fillColor: '#4fd18b', fillOpacity: 1 }).addTo(st.g.you).bindTooltip('You are here');
    drawTime();
    legend();
    $('#spEmpty').hidden = !!an.length;
    if (!an.length) $('#spEmpty').textContent = st.data ? 'No active tropical cyclones anywhere right now.' : st.dataErr ? `Cyclone feed unavailable (${st.dataErr}).` : 'Loading cyclone feed…';

    const key = `${st.sel}|${loc.lat.toFixed(1)},${loc.lon.toFixed(1)}|${an.map((x) => x.s.key).join()}`;
    if (key !== st.fitKey) { st.fitKey = key; fit(); }
  }

  function legend() {
    const Lb = lib();
    const cats = [[25, 'TD'], [34, 'TS'], [64, '1'], [83, '2'], [96, '3'], [113, '4'], [137, '5']];
    $('#tcLegend').innerHTML = `<span class="lg-cats">${cats.map(([v, n]) => `<i style="background:${Lb.ssColor(v)}" title="${n === 'TD' ? 'Tropical depression' : n === 'TS' ? 'Tropical storm' : 'Category ' + n}">${n}</i>`).join('')}</span>
      <span><i class="lg-cone"></i>Cone</span><span><i style="background:#ffe066"></i>34</span><span><i style="background:#ff9f43"></i>50</span><span><i style="background:#ff5d5d"></i>64 kt</span><span><i class="lg-you"></i>You</span>`;
  }

  /* ------------------------------------------------------------- fitting */
  function bounds(list, withYou) {
    const pts = [];
    list.forEach((a) => {
      const P = a.$P || ((la, lo) => [la, lo]);
      a.trk.forEach((p) => pts.push(P(p.lat, p.lon)));
      a.s.past.slice(-6).forEach((p) => pts.push(P(p.lat, p.lon)));
    });
    if (withYou && st.loc) pts.push([st.loc.lat, lib().unwrap(st.loc.lon, st.ref ?? st.loc.lon)]);
    return pts.length ? L.latLngBounds(pts) : null;
  }
  function fit() {
    if (!st.map) return;
    if (!visible()) { st.needFit = true; return; }
    st.needFit = false;
    st.map.invalidateSize();
    const a = selected();
    const b = a ? bounds([a], a.level !== 'far') : bounds(st.analyses, true);
    if (b && b.isValid()) st.map.fitBounds(b.pad(0.15), { maxZoom: a ? 6.5 : 4 });
    else if (st.loc) st.map.setView([20, lib().unwrap(st.loc.lon, st.ref ?? st.loc.lon)], 2);
  }
  function fitAll() {
    if (!st.map) return;
    st.map.invalidateSize();
    const b = bounds(st.analyses, true);
    if (b && b.isValid()) st.map.fitBounds(b.pad(0.12), { maxZoom: 4 }); else st.map.setView([20, st.loc?.lon || 0], 2);
  }

  /* ---------------------------------------------------------- time slider */
  function setupSlider() {
    const inp = $('#spTimeInput'), now = Date.now();
    const maxH = Math.max(0, ...st.analyses.map((a) => (a.trk.at(-1).t - now) / HOUR));
    const max = Math.max(6, Math.ceil(maxH / 6) * 6);
    inp.max = String(max); inp.disabled = !st.analyses.length; $('#spPlay').disabled = !st.analyses.length;
    if (st.t > max) st.t = 0;
    inp.value = String(st.t);
  }
  function drawTime() {
    if (!st.g) return;
    st.g.time.clearLayers();
    const Lb = lib(), T = Date.now() + st.t * HOUR;
    $('#spTimeLabel').textContent = st.t ? `${H.fmtDay(T)} ${H.fmtHM(T)} · +${st.t} h` : 'Now';
    if (!st.t) return;
    st.analyses.forEach((a) => {
      const x = Lb.stateAt(a.trk, T); if (!x || !a.$P) return;            // beyond this storm's forecast
      const c = Lb.ssColor(x.vmax), isSel = a.s.key === st.sel;
      if (isSel && layers().radii) RADII.forEach(([k, col]) => { const r = x.radii?.[k]; if (r && r.some((v) => v > 0)) L.polygon(Lb.quadPolygon(x.lat, x.lon, r).map(([la, lo]) => a.$P(la, lo)), { color: col, weight: 1, dashArray: '3 3', fillColor: col, fillOpacity: 0.1, interactive: false }).addTo(st.g.time); });
      L.circleMarker(a.$P(x.lat, x.lon), { radius: isSel ? 10 : 8, color: '#ffffff', weight: 2, dashArray: '3 2', fillColor: c, fillOpacity: 0.9 }).addTo(st.g.time)
        .bindTooltip(`<b>${H.esc(a.s.name)}</b> · +${st.t} h<br>${H.esc(Lb.ssCat(x.vmax)[1])} · ${H.esc(H.fW((x.vmax || 0) * Lb.KT))} ${H.esc(H.wU())} (1-min)`, { direction: 'top' });
    });
  }
  function setTime(h) { st.t = Math.max(0, h); $('#spTimeInput').value = String(st.t); drawTime(); }
  function stopPlay() {
    if (st.play) { clearInterval(st.play); st.play = null; }
    $('#spPlay').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
    $('#spPlay').setAttribute('aria-label', 'Play forecast');
  }
  function togglePlay() {
    if (st.play) { stopPlay(); return; }
    const max = +$('#spTimeInput').max;
    if (st.t >= max) setTime(0);
    st.play = setInterval(() => {
      if (document.hidden || !visible()) { stopPlay(); return; }
      const next = st.t + 3;
      if (next > max) { stopPlay(); return; }
      setTime(next);
    }, 450);
    $('#spPlay').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';
    $('#spPlay').setAttribute('aria-label', 'Pause forecast');
  }

  /* ------------------------------------------------------------ storm list */
  function renderList() {
    const Lb = lib(), el = $('#stormList'), an = st.analyses, loc = st.loc;
    const thr = { direct: 'Direct threat', near: 'Close pass', watch: 'Approaching' };
    el.innerHTML = an.length ? an.map((a) => {
      const s = a.s, isSel = s.key === st.sel;
      return `<li><button class="storm-row ${isSel ? 'sel' : ''}" data-key="${H.esc(s.key)}" aria-pressed="${isSel}">
        <span class="sdot" style="background:${Lb.ssColor(a.cur.vmax)}"></span>
        <span class="s-name"><b>${H.esc(s.name)}</b><small>${H.esc(s.classText || Lb.ssCat(a.cur.vmax)[1])} · ${H.esc(s.basinName || s.basin || '')}</small></span>
        <span class="s-int">${H.esc(H.fW((s.vmaxKt || 0) * Lb.KT))} ${H.esc(H.wU())}<small>${s.pressure ? `${H.esc(H.fPr(s.pressure))} ${H.esc(H.prU())}` : ''}</small></span>
        <span class="s-dist">${H.esc(H.fD(a.dNow))}<small>${thr[a.level] ? `<em class="thr t-${a.level}">${thr[a.level]}</em>` : H.dirName(Lb.bearing(loc.lat, loc.lon, a.cur.lat, a.cur.lon))}</small></span>
      </button></li>`;
    }).join('') : `<li class="muted sp-none">${st.data ? 'No active tropical cyclones worldwide right now.' : st.dataErr ? 'Tropical-cyclone feed unavailable (' + H.esc(st.dataErr) + ').' : 'Loading…'}</li>`;
    $('#stormListNote').textContent = st.data?.generated ? `${an.length} active · feed ${H.ago(Date.parse(st.data.generated))}` : st.dataErr ? 'Feed unavailable' : 'Loading…';
  }

  /* ----------------------------------------------------- intensity chart */
  function drawIntensity(a) {
    const svg = $('#tcIntensity'); if (!svg || !a) return;
    const Lb = lib(), s = a.s, now = Date.now(), tenMin = s.windAvg === '10-min';
    const w = Math.max(300, Math.round((svg.parentElement.clientWidth || 640) - 4)), h = 220;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const M = { L: 44, R: w - 30, T: 12, B: h - 26 };
    const past = s.past.filter((p) => p.vmaxKt != null).map((p) => ({ t: Date.parse(p.time), v: tenMin ? p.vmaxKt / 0.88 : p.vmaxKt, p: p.pressure })).filter((p) => Number.isFinite(p.t) && p.t >= now - 72 * HOUR && p.t < a.trk[0].t);
    const fc = a.trk.map((p) => ({ t: p.t, v: p.vmax ?? 0, p: p.pressure, tau: (p.t - a.trk[0].t) / HOUR }));
    const all = past.concat(fc);
    const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(...all.map((p) => p.t), t0 + HOUR);
    const vMax = Math.max(70, ...fc.map((p) => p.v + interp(INT_ERR, p.tau)), ...past.map((p) => p.v)) + 8;
    const X = (t) => M.L + ((t - t0) / (t1 - t0)) * (M.R - M.L);
    const Y = (kt) => M.B - (Math.max(0, kt) / vMax) * (M.B - M.T);
    const conv = (kt) => H.cW(kt * Lb.KT);
    let g = '';
    // Saffir–Simpson bands
    const edges = [0, 34, 64, 83, 96, 113, 137, 999];
    const names = ['TD', 'TS', '1', '2', '3', '4', '5'];
    for (let k = 0; k < 7; k++) {
      const lo = edges[k], hi = Math.min(edges[k + 1], vMax); if (lo >= vMax) break;
      g += `<rect x="${M.L}" y="${Y(hi).toFixed(1)}" width="${M.R - M.L}" height="${(Y(lo) - Y(hi)).toFixed(1)}" fill="${Lb.ssColor(lo + 0.1)}" opacity=".07"/>`;
      g += `<text x="${M.R + 4}" y="${((Y(lo) + Y(hi)) / 2 + 4).toFixed(1)}" class="band-lbl">${names[k]}</text>`;
    }
    // y axis in the user's wind unit
    const top = conv(vMax), step = [5, 10, 20, 25, 50, 100].find((x) => top / x <= 5) || 100;
    for (let u = step; u < top; u += step) { const kt = (u / conv(1)); g += `<line x1="${M.L}" x2="${M.R}" y1="${Y(kt).toFixed(1)}" y2="${Y(kt).toFixed(1)}" class="grid-line"/><text x="${M.L - 6}" y="${(Y(kt) + 4).toFixed(1)}" text-anchor="end">${u}</text>`; }
    g += `<text x="6" y="${M.T + 8}" class="axis-u">${H.esc(H.wU())}</text>`;
    // day ticks
    for (let d = Math.ceil(t0 / (24 * HOUR)) * 24 * HOUR; d <= t1; d += 24 * HOUR) {
      g += `<line x1="${X(d).toFixed(1)}" x2="${X(d).toFixed(1)}" y1="${M.T}" y2="${M.B + 4}" class="grid-line"/><text x="${(X(d) + 3).toFixed(1)}" y="${M.B + 16}">${H.esc(H.fmtDay(d))}</text>`;
    }
    // typical-error band around the forecast
    if (fc.length > 1) {
      const up = fc.map((p) => `${X(p.t).toFixed(1)},${Y(p.v + interp(INT_ERR, p.tau)).toFixed(1)}`);
      const dn = fc.slice().reverse().map((p) => `${X(p.t).toFixed(1)},${Y(p.v - interp(INT_ERR, p.tau)).toFixed(1)}`);
      g += `<path d="M${up.join('L')}L${dn.join('L')}Z" class="err-band"/>`;
    }
    if (past.length) g += `<path d="M${past.concat([fc[0]]).map((p) => `${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('L')}" class="int-past"/>`;
    g += `<path d="M${fc.map((p) => `${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('L')}" class="int-fc"/>`;
    all.forEach((p) => { g += `<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="${past.includes(p) ? 2.5 : 4}" fill="${Lb.ssColor(p.v)}" stroke="#0b1530" stroke-width="1"/>`; });
    if (now >= t0 && now <= t1) g += `<line x1="${X(now).toFixed(1)}" x2="${X(now).toFixed(1)}" y1="${M.T}" y2="${M.B}" class="now-line"/><text x="${(X(now) + 4).toFixed(1)}" y="${M.T + 10}" class="lbl-strong">now</text>`;
    g += '<g id="tcIntHover" style="display:none"><line class="hover-line" y1="' + M.T + '" y2="' + M.B + '"/><circle class="hover-dot" r="5"/></g>';
    svg.innerHTML = g;
    svg.$pts = all.map((p) => ({ ...p, x: X(p.t), y: Y(p.v), past: past.includes(p) }));
    $('#tcIntNote').textContent = `1-minute sustained wind${tenMin ? ` (${s.source} 10-minute winds converted ÷ 0.88)` : ''}. Shaded band: typical error of official intensity forecasts (approx. ±6 kt at 12 h to ±16 kt at 120 h) — not an official product.`;
  }
  function intHover(e) {
    const svg = $('#tcIntensity'), pts = svg.$pts; if (!pts?.length) return;
    const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal, x = ((e.clientX - r.left) * vb.width) / r.width;
    const p = pts.reduce((b, q) => (Math.abs(q.x - x) < Math.abs(b.x - x) ? q : b), pts[0]);
    const hv = $('#tcIntHover'); hv.style.display = '';
    hv.querySelector('line').setAttribute('x1', p.x.toFixed(1)); hv.querySelector('line').setAttribute('x2', p.x.toFixed(1));
    hv.querySelector('circle').setAttribute('cx', p.x.toFixed(1)); hv.querySelector('circle').setAttribute('cy', p.y.toFixed(1));
    const tip = $('#tcIntTip'), Lb = lib();
    tip.innerHTML = `<b>${H.esc(H.fmtDay(p.t))} ${H.esc(H.fmtHM(p.t))}<span class="tag">${p.past ? 'observed' : p.tau ? `+${Math.round(p.tau)} h forecast` : 'latest'}</span></b>
      <div><i style="background:${Lb.ssColor(p.v)}"></i>${H.esc(Lb.ssCat(p.v)[1])}</div>
      <div>Wind ${H.esc(H.fW(p.v * Lb.KT))} ${H.esc(H.wU())} (${Math.round(p.v)} kt)${!p.past && p.tau ? ` ± ${Math.round(interp(INT_ERR, p.tau))} kt typical` : ''}</div>
      ${p.p ? `<div>Pressure ${H.esc(H.fPr(p.p))} ${H.esc(H.prU())}</div>` : ''}`;
    tip.hidden = false;
    const pr = tip.parentElement.getBoundingClientRect(), px = r.left - pr.left + (p.x * r.width) / vb.width, py = r.top - pr.top + (p.y * r.height) / vb.height;
    let left = px + 14; if (left + tip.offsetWidth > pr.width - 4) left = px - 14 - tip.offsetWidth;
    tip.style.left = Math.max(4, left) + 'px'; tip.style.top = Math.max(4, py - tip.offsetHeight / 2) + 'px';
  }
  function intLeave() { const hv = $('#tcIntHover'); if (hv) hv.style.display = 'none'; $('#tcIntTip').hidden = true; }

  /* -------------------------------------------------------------- actions */
  function renderSelected() {
    const a = selected();
    window.Hazards?.renderDetail(a);
    if (a) drawIntensity(a);
  }
  function select(key, { zoom = true } = {}) {
    if (!st.analyses.some((a) => a.s.key === key)) return;
    st.sel = key; st.userSel = true;
    if (zoom) st.fitKey = null;                                           // re-fit even if this storm was already picked
    renderList(); draw(); renderSelected();
  }
  function setFull(on) {
    st.full = on;
    $('#spMapWrap').classList.toggle('full', on);
    document.body.classList.toggle('map-full', on);
    $('#spFull').setAttribute('aria-pressed', String(on));
    $('#spFull').title = on ? 'Exit full screen' : 'Full-screen map';
    if (st.map) { st.map.scrollWheelZoom[on ? 'enable' : 'disable'](); setTimeout(() => st.map.invalidateSize(), 60); }
  }

  /* ----------------------------------------------------------------- API */
  function update(o) {
    Object.assign(st, o);
    if (!st.userSel || !st.analyses.some((a) => a.s.key === st.sel)) { st.sel = st.threat?.s.key || null; st.userSel = false; }
    setupSlider();
    renderList(); draw(); renderSelected();
  }
  /** call when the panel becomes visible (tab switch, layout change) */
  function refresh() {
    if (!st.map) return;
    setTimeout(() => {
      st.map.invalidateSize();
      if (st.needFit) fit();
      const a = selected(); if (a) drawIntensity(a);
    }, 60);
  }
  function init(helpers) {
    H = helpers;
    const chips = $('#spLayers');
    const renderChips = () => {
      const lay = layers();
      chips.innerHTML = Prefs.LAYERS.map(([id, label]) => `<button type="button" class="chip small${lay[id] ? ' on' : ''}" data-layer="${id}" aria-pressed="${!!lay[id]}">${label}</button>`).join('');
    };
    renderChips();
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('[data-layer]'); if (!b) return;
      const lay = layers(); lay[b.dataset.layer] = !lay[b.dataset.layer];
      Prefs.set('stormLayers', lay);
    });
    Prefs.on((changed) => { if (changed.has('stormLayers')) { renderChips(); if (st.loc) draw(); } });
    $('#stormList').addEventListener('click', (e) => { const b = e.target.closest('.storm-row'); if (b) select(b.dataset.key); });
    $('#spWorld').addEventListener('click', fitAll);
    $('#spFull').addEventListener('click', () => setFull(!st.full));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.full) setFull(false); });
    $('#spPlay').addEventListener('click', togglePlay);
    $('#spTimeInput').addEventListener('input', (e) => { stopPlay(); setTime(+e.target.value); });
    const svg = $('#tcIntensity');
    svg.addEventListener('pointermove', intHover); svg.addEventListener('pointerdown', intHover);
    svg.addEventListener('pointerleave', intLeave); svg.addEventListener('pointercancel', intLeave);
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { const a = selected(); if (a && visible()) drawIntensity(a); }, 200); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlay(); });
  }

  window.Storms = { init, update, refresh, select };
})();
