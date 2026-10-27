/* Weather icons (inline SVG) and WMO weather-code descriptions. */
(function () {
  const C = {
    sun: '#ffc94d', sunGlow: '#ffb020', moon: '#e9e3c8',
    cloud: '#eef3ff', cloudDark: '#9aa7c2', rain: '#5cb8ff', snow: '#ffffff', bolt: '#ffd23f',
  };

  const sun = (cx, cy, r) => {
    let rays = '';
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const x1 = cx + Math.cos(a) * (r + 4), y1 = cy + Math.sin(a) * (r + 4);
      const x2 = cx + Math.cos(a) * (r + 9), y2 = cy + Math.sin(a) * (r + 9);
      rays += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }
    return `<g class="ic-sun"><g stroke="${C.sun}" stroke-width="3" stroke-linecap="round">${rays}</g>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.sun}"/></g>`;
  };

  const moon = (cx, cy, r) =>
    `<path fill="${C.moon}" d="M${cx + r * 0.35} ${cy - r} A${r} ${r} 0 1 0 ${cx + r} ${cy + r * 0.45} A${r * 0.8} ${r * 0.8} 0 0 1 ${cx + r * 0.35} ${cy - r}z"/>`;

  const cloud = (dx = 0, dy = 0, s = 1, fill = C.cloud) =>
    `<g transform="translate(${dx} ${dy}) scale(${s})" fill="${fill}">` +
    `<circle cx="20" cy="38" r="10"/><circle cx="33" cy="30" r="13"/><circle cx="46" cy="38" r="9"/>` +
    `<rect x="20" y="36" width="26" height="12" rx="2"/></g>`;

  const drops = (n = 3, heavy = false, slant = 3) => {
    let s = `<g stroke="${C.rain}" stroke-width="${heavy ? 3 : 2.5}" stroke-linecap="round">`;
    const xs = n === 2 ? [26, 40] : [22, 33, 44];
    xs.forEach((x, i) => {
      const y = 52 + (i % 2) * 3;
      s += `<line class="ic-drop" style="animation-delay:${i * 0.25}s" x1="${x}" y1="${y}" x2="${x - slant}" y2="${y + (heavy ? 9 : 7)}"/>`;
    });
    return s + '</g>';
  };

  const flakes = () => {
    let s = `<g fill="${C.snow}">`;
    [[22, 55], [33, 59], [44, 55], [28, 62], [39, 63]].forEach(([x, y], i) => {
      s += `<circle class="ic-flake" style="animation-delay:${i * 0.3}s" cx="${x}" cy="${y}" r="2.2"/>`;
    });
    return s + '</g>';
  };

  const bolt = () => `<path fill="${C.bolt}" d="M34 46 L26 60 H33 L29 70 L42 54 H35 L39 46Z"/>`;

  // wind streaks for stormy conditions
  const gust = () => `<g fill="none" stroke="${C.cloud}" stroke-width="2.4" stroke-linecap="round"><path d="M2 47h11a3.5 3.5 0 1 0-3.5-3.5"/><path d="M4 54h7"/></g>`;

  const fog = () =>
    `<g stroke="${C.cloud}" stroke-width="3" stroke-linecap="round" opacity=".85">` +
    `<line x1="12" y1="50" x2="52" y2="50"/><line x1="16" y1="57" x2="48" y2="57"/><line x1="20" y1="64" x2="44" y2="64"/></g>`;

  /** stormy = wind-driven weather (see stormy() below): a dark cloud, slanting rain or snow and wind streaks */
  function iconSVG(code, isDay = true, size = 48, stormy = false) {
    const sky = isDay ? sun(22, 22, 9) : moon(22, 22, 10);
    let body;
    switch (true) {
      case stormy: body = cloud(-6, -8, 0.8, C.cloudDark) + cloud(6, -6, 0.95, '#c3cce0') + (code >= 95 ? bolt() : isSnowCode(code) ? flakes() : drops(3, true, 8)) + gust(); break;
      case code === 0: body = isDay ? sun(32, 32, 13) : moon(32, 32, 15); break;
      case code === 1: body = (isDay ? sun(28, 28, 12) : moon(28, 28, 13)) + cloud(16, 14, 0.7); break;
      case code === 2: body = sky + cloud(4, 2, 0.95); break;
      case code === 3: body = cloud(-6, -6, 0.8, C.cloudDark) + cloud(4, 2, 0.95); break;
      case code === 45 || code === 48: body = cloud(2, -8, 0.95) + fog(); break;
      case code >= 51 && code <= 57: body = cloud(2, -6, 0.95) + drops(2); break;
      case code >= 61 && code <= 67: body = cloud(2, -6, 0.95, code >= 63 ? C.cloudDark : C.cloud) + drops(3, code >= 65); break;
      case code >= 71 && code <= 77: body = cloud(2, -6, 0.95) + flakes(); break;
      case code >= 80 && code <= 82: body = sky + cloud(4, -4, 0.95) + drops(code === 80 ? 2 : 3, code === 82); break;
      case code === 85 || code === 86: body = sky + cloud(4, -4, 0.95) + flakes(); break;
      case code >= 95: body = cloud(2, -8, 0.95, C.cloudDark) + bolt(); break;
      default: body = cloud(2, 0, 0.95);
    }
    return `<svg class="wx-icon" width="${size}" height="${size}" viewBox="0 0 64 70" aria-hidden="true">${body}</svg>`;
  }

  const isSnowCode = (c) => (c >= 71 && c <= 77) || c === 85 || c === 86;
  const isWetCode = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82);

  /** Active storm conditions that the weather code alone understates (it would say "Showers" in a gale or a cyclone).
   *  Pure; winds in km/h, pressure in hPa, rain in mm/h. o: { wc, ws, wg, pr, ps, tcKt: a cyclone's sustained wind here
   *  (kt), tcNear: a cyclone centre within ~250 km, warn: a storm-type official warning in force here }.
   *  Returns null or { label, why: 'tc' | 'tc-bands' | 'warning' | 'wind' | 'low' }. */
  function stormy(o) {
    const wc = o.wc ?? 0, ws = o.ws ?? 0, wg = o.wg ?? 0;
    const snow = isSnowCode(wc), thunder = wc >= 95, wet = isWetCode(wc) || (o.pr ?? 0) >= 0.5;
    const precip = wet || snow || thunder, cloudy = precip || wc === 3;
    const label = snow ? 'Snowstorm' : 'Stormy';
    if ((o.tcKt ?? 0) >= 34) return { label, why: 'tc' };                       // tropical-storm-force winds here
    if (o.tcNear && precip) return { label, why: 'tc-bands' };                  // inside a cyclone's rain bands
    // tornado, severe-storm, wind… warnings, once rain or wind has arrived (a hurricane warning can lead the storm by 36 h)
    if (o.warn && (precip || ws >= 40 || wg >= 60)) return { label, why: 'warning' };
    if ((precip && (ws >= 50 || wg >= 75)) || (cloudy && (ws >= 62 || wg >= 90))) return { label, why: 'wind' };
    if (cloudy && (o.ps ?? Infinity) <= 985 && ws >= 40) return { label, why: 'low' };   // deep (extratropical) low
    if (ws >= 62) return { label: 'Gale-force winds', why: 'wind' };            // dry gale: not "stormy" skies
    if (wg >= 90) return { label: 'Very windy', why: 'wind' };
    return null;
  }

  const WMO = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Light showers', 81: 'Showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Severe thunderstorm, hail',
  };

  function scene(code, isDay) {
    if (code >= 95) return 'storm';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if (code === 45 || code === 48) return 'fog';
    if (code === 3) return isDay ? 'cloudy-day' : 'cloudy-night';
    return isDay ? 'clear-day' : 'clear-night';
  }

  const umbrellaSVG = (open = true) => open
    ? `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 6C13 6 5 14 4 24c2.5-2.5 5-2.5 7 0 2-2.5 5-2.5 6.5 0 2-2.5 5-2.5 6.5 0 1.5-2.5 4.5-2.5 6.5 0 2-2.5 4.5-2.5 6.5 0 2-2.5 4.5-2.5 7 0C43 14 35 6 24 6z" fill="currentColor"/><path d="M24 24v14a4 4 0 0 1-8 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><line x1="24" y1="3" x2="24" y2="6" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`
    : `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 4 L30 30 H18 Z" fill="currentColor" opacity=".9"/><path d="M24 30v8a4 4 0 0 1-8 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`;

  // Pulse Advisor glyphs (24×24 line art, coloured by the card's tone via currentColor)
  const PULSE = {
    jacket: '<path d="M9 3.5 12 5.5l3-2 4.5 2.6-1.8 4.6-1.7-.8V20H8V9.9l-1.7.8-1.8-4.6z"/><path d="M12 5.5V20"/>',
    home: '<path d="M3.5 11.5 12 4l8.5 7.5"/><path d="M6 10v10h4.5v-5.5h3V20H18V10"/>',
    heat: '<path d="M10 13.8V5a2 2 0 1 1 4 0v8.8a4 4 0 1 1-4 0z"/><path d="M12 9v7"/><path d="M18 4.5l1.5-1.2M19 8.5h2M18 12.5l1.5 1.2"/>',
    cold: '<path d="M12 2.5v19M3.8 7.2l16.4 9.6M3.8 16.8l16.4-9.6"/><path d="M9.5 3.8 12 6l2.5-2.2M9.5 20.2 12 18l2.5 2.2"/>',
    snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
    mask: '<path d="M4 9c3-1.6 13-1.6 16 0v4.5c-1.2 3-4.6 5-8 5s-6.8-2-8-5z"/><path d="M4 10.5H2.5M20 10.5h1.5M8 12h8M8.5 15h7"/>',
    fog: '<path d="M4 8h16M3 12h18M5 16h14M8 20h8"/>',
    storm: '<path d="M7 16.5H6a4 4 0 0 1-.6-8A6 6 0 0 1 17 7.4 4.3 4.3 0 0 1 18 16h-.5"/><path d="m12.5 12-2.5 4.5h4L11.5 21"/>',
    wind: '<path d="M3 8.5h10.5a2.6 2.6 0 1 0-2.6-2.6M3 12.5h15a2.8 2.8 0 1 1-2.8 2.8M3 16.5h7"/>',
    ice: '<path d="M3 5h18"/><path d="M5.5 5l1.5 7 1.5-7M10.5 5l1.5 10 1.5-10M15.5 5l1.5 6 1.5-6"/>',
    alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.1"/>',
  };
  function pulseSVG(kind) {
    if (kind === 'umbrella') return umbrellaSVG(true);
    if (kind === 'closed') return umbrellaSVG(false);
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${PULSE[kind] || PULSE.alert}</svg>`;
  }

  /** the cyclone symbol, arms mirrored for clockwise (southern-hemisphere) rotation. With a category it gets a
   *  larger, upright centre showing the number (only the arms spin). */
  const ARM = '<path d="M1.6-2.9C.5-7.6-4.3-10-9.2-8.3c3.7.4 6.3 2.4 7.1 5.7z"/>';
  const stormGlyph = (fill, south = false, size = 30, cat = 0, ink = '#0b1530') =>
    `<svg width="${size}" height="${size}" viewBox="-12 -12 24 24" aria-hidden="true"><g class="spin${south ? ' s' : ''}"><g fill="${fill}" stroke="#0b1530" stroke-width="1"${south ? ' transform="scale(-1 1)"' : ''}>` +
    `${ARM}<g transform="rotate(180)">${ARM}</g>` + (cat ? '' : '<circle r="4.2"/>') + '</g>' + (cat ? '' : '<circle r="1.5" fill="#0b1530"/>') + '</g>' +
    (cat ? `<circle r="5.6" fill="${fill}" stroke="#0b1530" stroke-width="1"/><text y=".4" text-anchor="middle" dominant-baseline="central" font-size="7.6" font-weight="800" font-family="Inter, system-ui, sans-serif" fill="${ink}">${Number(cat)}</text>` : '') +
    '</svg>';

  window.WX = { iconSVG, WMO, scene, stormy, umbrellaSVG, pulseSVG, stormGlyph };
})();
