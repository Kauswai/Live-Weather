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

  const drops = (n = 3, heavy = false) => {
    let s = `<g stroke="${C.rain}" stroke-width="${heavy ? 3 : 2.5}" stroke-linecap="round">`;
    const xs = n === 2 ? [26, 40] : [22, 33, 44];
    xs.forEach((x, i) => {
      const y = 52 + (i % 2) * 3;
      s += `<line class="ic-drop" style="animation-delay:${i * 0.25}s" x1="${x}" y1="${y}" x2="${x - 3}" y2="${y + (heavy ? 9 : 7)}"/>`;
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

  const fog = () =>
    `<g stroke="${C.cloud}" stroke-width="3" stroke-linecap="round" opacity=".85">` +
    `<line x1="12" y1="50" x2="52" y2="50"/><line x1="16" y1="57" x2="48" y2="57"/><line x1="20" y1="64" x2="44" y2="64"/></g>`;

  function iconSVG(code, isDay = true, size = 48) {
    const sky = isDay ? sun(22, 22, 9) : moon(22, 22, 10);
    let body;
    switch (true) {
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

  window.WX = { iconSVG, WMO, scene, umbrellaSVG };
})();
