/* SkyPulse lunar maths: Moon position, rise/set, phase and distance, written for SkyPulse from the published
 * low-precision lunar theory (the main periodic terms of Meeus, "Astronomical Algorithms", ch. 47) and standard
 * spherical astronomy. Accurate to roughly 0.05° in position and a minute or two in rise/set and phase times.
 * Times are epoch milliseconds; latitude/longitude in degrees (east positive). Exposed as window.Lunar.
 */
(function () {
  'use strict';
  const RAD = Math.PI / 180, DEG = 180 / Math.PI, DAY = 86400000, SYNODIC = 29.530588853;
  const sin = (d) => Math.sin(d * RAD), cos = (d) => Math.cos(d * RAD);
  const norm360 = (d) => ((d % 360) + 360) % 360;
  const jd = (ms) => ms / DAY + 2440587.5;
  const DELTA_T = 69e3;                                             // terrestrial − universal time in the 2020s (~69 s)

  // periodic terms [D, M, M', F, coefficient]: longitude (deg, sine), distance (km, cosine), latitude (deg, sine)
  const LON = [[0, 0, 1, 0, 6.288774], [2, 0, -1, 0, 1.274027], [2, 0, 0, 0, 0.658314], [0, 0, 2, 0, 0.213618], [0, 1, 0, 0, -0.185116],
    [0, 0, 0, 2, -0.114332], [2, 0, -2, 0, 0.058793], [2, -1, -1, 0, 0.057066], [2, 0, 1, 0, 0.053322], [2, -1, 0, 0, 0.045758],
    [0, 1, -1, 0, -0.040923], [1, 0, 0, 0, -0.03472], [0, 1, 1, 0, -0.030383], [2, 0, 0, -2, 0.015327], [0, 0, 1, 2, -0.012528],
    [0, 0, 1, -2, 0.01098], [4, 0, -1, 0, 0.010675], [0, 0, 3, 0, 0.010034], [4, 0, -2, 0, 0.008548], [2, 1, -1, 0, -0.007888],
    [2, 1, 0, 0, -0.006766], [1, 0, -1, 0, -0.005163], [1, 1, 0, 0, 0.004987], [2, -1, 1, 0, 0.004036], [2, 0, 2, 0, 0.003994],
    [4, 0, 0, 0, 0.003861], [2, 0, -3, 0, 0.003665], [0, 1, -2, 0, -0.002689], [2, 0, -1, 2, -0.002602], [2, -1, -2, 0, 0.00239],
    [1, 0, 1, 0, -0.002348], [2, -2, 0, 0, 0.002236], [0, 1, 2, 0, -0.00212], [0, 2, 0, 0, -0.002069], [2, -2, -1, 0, 0.002048]];
  const DIST = [[0, 0, 1, 0, -20905.355], [2, 0, -1, 0, -3699.111], [2, 0, 0, 0, -2955.968], [0, 0, 2, 0, -569.925], [0, 1, 0, 0, 48.888],
    [0, 0, 0, 2, -3.149], [2, 0, -2, 0, 246.158], [2, -1, -1, 0, -152.138], [2, 0, 1, 0, -170.733], [2, -1, 0, 0, -204.586],
    [0, 1, -1, 0, -129.62], [1, 0, 0, 0, 108.743], [0, 1, 1, 0, 104.755], [2, 0, 0, -2, 10.321], [0, 0, 1, -2, 79.661],
    [4, 0, -1, 0, -34.782], [0, 0, 3, 0, -23.21], [4, 0, -2, 0, -21.636], [2, 1, -1, 0, 24.208], [2, 1, 0, 0, 30.824],
    [1, 0, -1, 0, -8.379], [1, 1, 0, 0, -16.675], [2, -1, 1, 0, -12.831], [2, 0, 2, 0, -10.445], [4, 0, 0, 0, -11.65],
    [2, 0, -3, 0, 14.403], [0, 1, -2, 0, -7.003], [2, -1, -2, 0, 10.056], [1, 0, 1, 0, 6.322], [2, -2, 0, 0, -9.884]];
  const LAT = [[0, 0, 0, 1, 5.128122], [0, 0, 1, 1, 0.280602], [0, 0, 1, -1, 0.277693], [2, 0, 0, -1, 0.173237], [2, 0, -1, 1, 0.055413],
    [2, 0, -1, -1, 0.046271], [2, 0, 0, 1, 0.032573], [0, 0, 2, 1, 0.017198], [2, 0, 1, -1, 0.009266], [0, 0, 2, -1, 0.008822],
    [2, -1, 0, -1, 0.008216], [2, 0, -2, -1, 0.004324], [2, 0, 1, 1, 0.0042], [2, 1, 0, -1, -0.003359], [2, -1, -1, 1, 0.002463],
    [2, -1, 0, 1, 0.002211], [2, -1, -1, -1, 0.002065], [0, 1, -1, -1, -0.001870], [4, 0, -1, -1, 0.001828], [0, 1, 0, 1, -0.001794]];

  /** geocentric ecliptic Moon (deg, km) and Sun (deg, km) at instant ms */
  function ecliptic(ms) {
    const T = (jd(ms + DELTA_T) - 2451545) / 36525;                 // the theory runs on terrestrial time
    const Lp = 218.3164477 + 481267.88123421 * T, D = 297.8501921 + 445267.1114034 * T, M = 357.5291092 + 35999.0502909 * T;
    const Mp = 134.9633964 + 477198.8675055 * T, F = 93.272095 + 483202.0175233 * T;
    const E = 1 - 0.002516 * T;                                     // the Earth's orbit is slowly becoming rounder
    const sum = (terms, f) => terms.reduce((s, [d, m, mp, ff, c]) => s + c * (m ? E ** Math.abs(m) : 1) * f(d * D + m * M + mp * Mp + ff * F), 0);
    const nut = -0.00478 * sin(125.04 - 1934.136 * T);              // main nutation term in longitude
    const lon = norm360(Lp + sum(LON, sin) + nut), lat = sum(LAT, sin), dist = 385000.56 + sum(DIST, cos);
    // the Sun (low precision is plenty for phase and the lit side)
    const Ms = 357.52911 + 35999.05029 * T, L0 = 280.46646 + 36000.76983 * T;
    const sunLon = norm360(L0 + (1.914602 - 0.004817 * T) * sin(Ms) + 0.019993 * sin(2 * Ms) + 0.000289 * sin(3 * Ms) + nut - 0.00569);  // apparent (aberration)
    const sunDist = 149597870.7 * (1.000140612 - 0.016708617 * cos(Ms) - 0.000139589 * cos(2 * Ms));
    return { lon, lat, dist, sunLon, sunDist, eps: 23.439291 - 0.0130042 * T, d: jd(ms) - 2451545 };
  }

  const toEquatorial = (lon, lat, eps) => ({
    ra: norm360(Math.atan2(sin(lon) * cos(eps) - Math.tan(lat * RAD) * sin(eps), cos(lon)) * DEG),
    dec: Math.asin(sin(lat) * cos(eps) + cos(lat) * sin(eps) * sin(lon)) * DEG,
  });
  // Bennett's refraction for an apparent altitude, in degrees
  const refraction = (h) => (h < -1.9 ? 0 : 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * RAD) / 60);

  /**
   * Topocentric Moon as seen from (lat, lon): altitude (refraction-corrected; geo = without refraction), azimuth
   * (from north, clockwise), distance, illuminated fraction, waxing, elongation from the Sun (0 new → 180 full),
   * apparent diameter (arcmin) and `tilt`: where the bright limb points, in degrees anticlockwise from straight up.
   */
  function position(ms, lat, lon) {
    lat = Math.max(-89.999, Math.min(89.999, lat));
    const e = ecliptic(ms);
    const m = toEquatorial(e.lon, e.lat, e.eps), s = toEquatorial(e.sunLon, 0, e.eps);
    const lst = norm360(280.46061837 + 360.98564736629 * e.d + lon);
    const H = lst - m.ra;
    const geoAlt = Math.asin(Math.max(-1, Math.min(1, sin(lat) * sin(m.dec) + cos(lat) * cos(m.dec) * cos(H)))) * DEG;
    const par = Math.asin(6378.14 / e.dist) * DEG;                 // horizontal parallax, ~0.95°
    const geo = geoAlt - par * cos(geoAlt);                         // seen from the surface, not the Earth's centre
    const az = norm360(Math.atan2(sin(H), cos(H) * sin(lat) - Math.tan(m.dec * RAD) * cos(lat)) * DEG + 180);
    // phase
    const cosPsi = cos(e.lat) * cos(e.lon - e.sunLon), psi = Math.acos(Math.max(-1, Math.min(1, cosPsi))) * DEG;
    const i = Math.atan2(e.sunDist * sin(psi), e.dist - e.sunDist * cos(psi)) * DEG;
    const elong = norm360(e.lon - e.sunLon);
    // bright limb position angle (from celestial north, through east) minus the parallactic angle → from the zenith
    const chi = Math.atan2(cos(s.dec) * sin(s.ra - m.ra), sin(s.dec) * cos(m.dec) - cos(s.dec) * sin(m.dec) * cos(s.ra - m.ra)) * DEG;
    const q = Math.atan2(sin(H), Math.tan(lat * RAD) * cos(m.dec) - sin(m.dec) * cos(H)) * DEG;
    return {
      alt: geo + refraction(geo), geo, az, dist: e.dist, ra: m.ra, dec: m.dec, parallax: par,
      illum: (1 + cos(i)) / 2, phaseAngle: i, elong, waxing: elong < 180,
      diam: 2 * Math.asin(1737.4 / e.dist) * DEG * 60, tilt: norm360(chi - q),
    };
  }

  /** altitude of the Moon's centre (no refraction) at which its upper limb touches the horizon, with refraction */
  const h0 = (p) => -(0.5667 + p.diam / 120);

  /**
   * Moon events for one local calendar day [utcMid − offset, +24 h): rise, set (and their azimuths), highest point
   * (transit), or up/down all day. utcMid is the UTC-midnight epoch of the local date.
   */
  function times(utcMid, lat, lon, offsetMs = 0) {
    const t0 = utcMid - offsetMs, step = 10 * 60000, n = DAY / step;
    const f = (t) => { const p = position(t, lat, lon); return { t, v: p.geo - h0(p), p }; };
    const s = []; for (let k = 0; k <= n; k++) s.push(f(t0 + k * step));
    const refine = (a, b) => { for (let k = 0; k < 18; k++) { const m = f((a.t + b.t) / 2); if ((m.v > 0) === (a.v > 0)) a = m; else b = m; } return b.t - (b.t - a.t) * (b.v / (b.v - a.v)); };
    let rise = null, set = null;
    for (let k = 1; k < s.length; k++) {
      if (s[k - 1].v <= 0 && s[k].v > 0 && rise == null) rise = refine(s[k - 1], s[k]);
      if (s[k - 1].v > 0 && s[k].v <= 0 && set == null) set = refine(s[k - 1], s[k]);
    }
    // highest point: the sample maximum, polished by golden-section search
    let top = s.reduce((m, x) => (x.p.geo > m.p.geo ? x : m), s[0]);
    let a = Math.max(t0, top.t - step), b = Math.min(t0 + DAY, top.t + step);
    for (let k = 0; k < 24; k++) { const c = b - (b - a) * 0.618, d = a + (b - a) * 0.618; if (position(c, lat, lon).geo > position(d, lat, lon).geo) b = d; else a = c; }
    const transit = (a + b) / 2, tp = position(transit, lat, lon);
    const up = s.every((x) => x.v > 0), down = s.every((x) => x.v <= 0);
    return {
      rise, set, transit, transitAlt: tp.alt, transitAz: tp.az,
      riseAz: rise != null ? position(rise, lat, lon).az : null, setAz: set != null ? position(set, lat, lon).az : null,
      alwaysUp: up, alwaysDown: down,
    };
  }

  /** the next `count` principal phases after ms: { t, k (0 new, 1 first quarter, 2 full, 3 last quarter), name, dist } */
  const PHASES = ['New moon', 'First quarter', 'Full moon', 'Last quarter'];
  function phases(ms, count = 4) {
    const out = [], step = 6 * 3600e3;
    const elong = (t) => { const e = ecliptic(t); return norm360(e.lon - e.sunLon); };
    const off = (el, g) => ((el - g + 540) % 360) - 180;              // signed degrees past a phase
    let ea = elong(ms);
    for (let t = ms; out.length < count && t < ms + 60 * DAY; t += step) {
      const eb = elong(t + step);
      for (let k = 0; k < 4; k++) {
        if (!(off(ea, k * 90) < 0 && off(eb, k * 90) >= 0 && off(eb, k * 90) - off(ea, k * 90) < 90)) continue;
        let a = t, b = t + step;
        for (let j = 0; j < 30; j++) { const m = (a + b) / 2; if (off(elong(m), k * 90) < 0) a = m; else b = m; }
        const tt = (a + b) / 2;
        out.push({ t: tt, k, name: PHASES[k], dist: ecliptic(tt).dist });
      }
      ea = eb;
    }
    return out.slice(0, count);
  }

  /** the name used for the Moon on a given elongation (each principal phase gets about a day) */
  function phaseName(elong) {
    const near = (g) => Math.abs(((elong - g + 540) % 360) - 180) < 6.1;
    if (near(0)) return 'New moon';
    if (near(90)) return 'First quarter';
    if (near(180)) return 'Full moon';
    if (near(270)) return 'Last quarter';
    return elong < 90 ? 'Waxing crescent' : elong < 180 ? 'Waxing gibbous' : elong < 270 ? 'Waning gibbous' : 'Waning crescent';
  }

  /** days since the last new moon */
  const age = (ms) => (norm360(ecliptic(ms).lon - ecliptic(ms).sunLon) / 360) * SYNODIC;

  window.Lunar = { position, times, phases, phaseName, age, ecliptic, SYNODIC };
})();
