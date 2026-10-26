/* SkyPulse solar maths: sun position and sun events from the NOAA Solar Calculator equations (after Meeus),
 * accurate to ~1 minute for ±100 years. Written for SkyPulse; exposed as window.Solar.
 * All times are epoch milliseconds; latitude/longitude in degrees (east positive).
 */
(function () {
  const RAD = Math.PI / 180, DEG = 180 / Math.PI, DAY = 86400000;
  const sin = (d) => Math.sin(d * RAD), cos = (d) => Math.cos(d * RAD), tan = (d) => Math.tan(d * RAD);

  /** Sun declination (deg) and equation of time (minutes) at instant ms. */
  function solar(ms) {
    const T = (ms / DAY + 2440587.5 - 2451545) / 36525;              // Julian centuries since J2000
    const L0 = ((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360 + 360) % 360; // mean longitude
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);         // mean anomaly
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);    // orbit eccentricity
    const C = sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) + sin(2 * M) * (0.019993 - 0.000101 * T) + sin(3 * M) * 0.000289;
    const omega = 125.04 - 1934.136 * T;
    const lambda = L0 + C - 0.00569 - 0.00478 * sin(omega);          // apparent longitude
    const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * cos(omega);                          // obliquity (corrected)
    const decl = Math.asin(sin(eps) * sin(lambda)) * DEG;
    const y = tan(eps / 2) ** 2;
    const eot = 4 * DEG * (y * sin(2 * L0) - 2 * e * sin(M) + 4 * e * y * sin(M) * cos(2 * L0) - 0.5 * y * y * sin(4 * L0) - 1.25 * e * e * sin(2 * M));
    return { decl, eot };
  }

  /** Atmospheric refraction correction (deg) for a geometric elevation (deg). */
  function refraction(h) {
    if (h > 85) return 0;
    const t = tan(h);
    if (h > 5) return (58.1 / t - 0.07 / t ** 3 + 0.000086 / t ** 5) / 3600;
    if (h > -0.575) return (1735 + h * (-518.2 + h * (103.4 + h * (-12.79 + h * 0.711)))) / 3600;
    return (-20.774 / t) / 3600;
  }

  /** Apparent sun position: elevation (deg, refraction-corrected) and azimuth (deg from north, clockwise). */
  function position(ms, lat, lon) {
    lat = Math.max(-89.999, Math.min(89.999, lat));
    const { decl, eot } = solar(ms);
    const utcMin = (((ms % DAY) + DAY) % DAY) / 60000;
    const tst = (((utcMin + eot + 4 * lon) % 1440) + 1440) % 1440;    // true solar time (min)
    const ha = tst / 4 - 180;                                        // hour angle (deg)
    const cz = Math.max(-1, Math.min(1, sin(lat) * sin(decl) + cos(lat) * cos(decl) * cos(ha)));
    const geo = 90 - Math.acos(cz) * DEG;
    const az = (Math.atan2(sin(ha), cos(ha) * sin(lat) - tan(decl) * cos(lat)) * DEG + 540) % 360;
    return { el: geo + refraction(geo), geo, az, decl, eot, ha };
  }

  /**
   * Sun events for one local calendar day.
   * @param utcMid   UTC-midnight epoch of the *local* date (e.g. Date.UTC(2026, 9, 12))
   * @param offsetMs the location's UTC offset, used to pick the solar noon belonging to that local date
   */
  function times(utcMid, lat, lon, offsetMs = 0) {
    lat = Math.max(-89.999, Math.min(89.999, lat));
    const clockNoon = utcMid + DAY / 2 - offsetMs;
    let noon = utcMid + (720 - 4 * lon) * 60000;
    for (let i = 0; i < 3; i++) {
      noon = utcMid + (720 - 4 * lon - solar(noon).eot) * 60000;
      while (noon - clockNoon > DAY / 2) noon -= DAY;
      while (clockNoon - noon > DAY / 2) noon += DAY;
    }
    // time at which the sun's geometric centre reaches elevation h0 (morning or evening side)
    const at = (h0, rising) => {
      let t = noon;
      for (let i = 0; i < 4; i++) {
        const { decl } = solar(t);
        const c = (sin(h0) - sin(lat) * sin(decl)) / (cos(lat) * cos(decl));
        if (c > 1) return { polar: 'below' };   // never reaches h0
        if (c < -1) return { polar: 'above' };  // never drops below h0
        t = noon + (rising ? -1 : 1) * 4 * Math.acos(c) * DEG * 60000;
      }
      return { t };
    };
    const rise = at(-0.833, true), set = at(-0.833, false);  // −0.833° = refraction + solar radius
    const pick = (o) => o.t ?? null;
    let polar = rise.polar === 'above' && set.polar === 'above' ? 'day' : rise.polar === 'below' && set.polar === 'below' ? 'night' : null;
    let r = pick(rise), s = pick(set), dayLen;
    if (polar === 'day') dayLen = DAY;
    else if (polar === 'night') dayLen = 0;
    else if (r != null && s != null && s > r && s - r <= DAY) dayLen = s - r;
    else {
      // first/last day of midnight sun or polar night: the iteration lands on different sides of the
      // threshold for morning and evening, so integrate the time above the horizon instead (5-min steps)
      const N = 288; let up = 0;
      for (let k = 0; k < N; k++) if (position(noon - DAY / 2 + (k + 0.5) * DAY / N, lat, lon).geo > -0.833) up++;
      dayLen = (up * DAY) / N;
      if (up === N) polar = 'day'; else if (up === 0) polar = 'night';
      if (polar || (r != null && s != null)) r = s = null; // keep a lone valid rise or set, drop an inconsistent pair
    }
    return {
      noon, polar,
      rise: r, set: s,
      dayLen,
      maxEl: position(noon, lat, lon).el,
      riseAz: r != null ? position(r, lat, lon).az : null,
      setAz: s != null ? position(s, lat, lon).az : null,
      civilDawn: pick(at(-6, true)), civilDusk: pick(at(-6, false)),
      nautDawn: pick(at(-12, true)), nautDusk: pick(at(-12, false)),
      astroDawn: pick(at(-18, true)), astroDusk: pick(at(-18, false)),
      goldenAmEnd: pick(at(6, true)), goldenPmStart: pick(at(6, false)),
      decl: solar(noon).decl, eot: solar(noon).eot,
    };
  }

  /** Day length (h) and noon sun angle (°) for every day of a year, plus the days worth marking on a chart:
   *  dayMarks — start and end of the midnight sun and of the polar night where they occur, else the longest and
   *             shortest day; elMarks — every turning point of the noon sun angle ({ k, max, big }), so the tropics
   *             get both zenith passages and both solstice lows, with the year's highest/lowest drawn larger. */
  function year(jan1, nDays, lat, lon, off) {
    const H = 3600000, dl = [], el = [], dec = [];
    for (let k = 0; k < nDays; k++) { const t = times(jan1 + k * DAY, lat, lon, off); dl.push(Math.max(0, Math.min(24, t.dayLen / H))); el.push(t.maxEl); dec.push(t.decl); }
    // tropics: the sun is overhead on the day(s) the declination crosses the latitude. Noon sampling can
    // miss the exact crossing by up to ~0.2°, so those days are pinned to 90°.
    const zenith = [];
    if (Math.abs(lat) <= 23.45) for (let k = 0; k < nDays - 1; k++) {
      if ((dec[k] - lat) * (dec[k + 1] - lat) <= 0) { const z = Math.abs(dec[k] - lat) <= Math.abs(dec[k + 1] - lat) ? k : k + 1; if (!zenith.includes(z)) zenith.push(z); }
    }
    const elRaw = el.slice();                                    // before pinning: ranks the two zenith days
    zenith.forEach((z) => { el[z] = 90; });
    const arg = (a, better) => a.reduce((b, v, k) => (better(v, a[b]) ? k : b), 0);
    const iMin = arg(dl, (a, b) => a < b), iMax = arg(dl, (a, b) => a > b);
    // midnight-sun / polar-night periods as runs of days; a run cut by New Year is not a real start or end
    const runs = (test) => {
      const out = []; let s0 = null;
      for (let k = 0; k <= nDays; k++) {
        if (k < nDays && test(dl[k])) { if (s0 == null) s0 = k; } else if (s0 != null) { out.push([s0, k - 1]); s0 = null; }
      }
      return out;
    };
    const sunRuns = runs((v) => v >= 23.99), nightRuns = runs((v) => v <= 0.01);
    const edgesOf = (rs) => rs.flatMap(([a, b]) => [a > 0 ? a : null, b < nDays - 1 ? b : null]).filter((k) => k != null);
    /** [first, last] day of a period, joining the two halves of one that spans New Year */
    const spanOf = (rs) => (!rs.length ? null : rs.length > 1 && rs[0][0] === 0 && rs[rs.length - 1][1] === nDays - 1 ? [rs[rs.length - 1][0], rs[0][1]] : [rs[0][0], rs[rs.length - 1][1]]);
    const dayMarks = [...new Set([...(sunRuns.length ? edgesOf(sunRuns) : [iMax]), ...(nightRuns.length ? edgesOf(nightRuns) : [iMin])])];
    const elMarks = [];
    for (let k = 1; k < nDays - 1; k++) {
      if (el[k] > el[k - 1] && el[k] >= el[k + 1]) elMarks.push({ k, max: true });
      else if (el[k] < el[k - 1] && el[k] <= el[k + 1]) elMarks.push({ k, max: false });
    }
    const top = elMarks.filter((m) => m.max).reduce((b, m) => (!b || elRaw[m.k] > elRaw[b.k] ? m : b), null);
    const low = elMarks.filter((m) => !m.max).reduce((b, m) => (!b || el[m.k] < el[b.k] ? m : b), null);
    elMarks.forEach((m) => { m.big = m === top || m === low; });
    return {
      dl, el, zenith, dayMarks, elMarks, sunSpan: spanOf(sunRuns), nightSpan: spanOf(nightRuns),
      iMin, iMax, iElMin: arg(el, (a, b) => a < b), iElMax: arg(el, (a, b) => a > b),
    };
  }

  /** Name of the light phase for a given apparent elevation. */
  function phase(el) {
    if (el >= 6) return 'Daylight';
    if (el >= -0.833) return 'Golden hour';
    if (el >= -6) return 'Civil twilight';
    if (el >= -12) return 'Nautical twilight';
    if (el >= -18) return 'Astronomical twilight';
    return 'Night';
  }

  window.Solar = { solar, position, times, year, phase, DAY };
})();
