/* SkyPulse sky colour: what the sky above you should look like right now, and why.
 *
 * Rayleigh scattering by air molecules makes a clean daytime sky blue. Everything else shifts it:
 *  - aerosols (haze, smoke, dust; aerosol optical depth AOD) scatter all colours more evenly, turning blue to white
 *    or grey, or to yellow-brown when mineral dust absorbs blue light;
 *  - humidity swells aerosol particles (hygroscopic growth), so the same AOD looks milkier in moist air;
 *  - clouds at each level (low stratus, mid altostratus, high cirrus) grey or whiten the sky; thick or precipitating
 *    cloud darkens it;
 *  - a low sun shines through a long slant path that strips out blue, so light turns golden, orange or red, more so with
 *    aerosols; mid/high cloud with a clear horizon is what catches colourful sunrises and sunsets.
 * This is a rule-based estimate from the forecast, not an observation. Sky.describe(input) → { title, comment, notes,
 * factors, zenith, horizon }.
 */
(function () {
  'use strict';
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const pct = (v) => (num(v) ? Math.round(v) + '%' : '–');

  function describe(o) {
    const { el, cl = 0, cm = 0, ch = 0, cc = 0, wc = 0, vis, rh, rh850, rh700, rh500, rh300, aod, dust, pm25, pr = 0, elev = 0, sunDir } = o;
    const notes = [];
    let title, comment, zenith, horizon;
    const hazy = num(aod) ? aod : null;
    const humidLow = Math.max(num(rh) ? rh : 0, num(rh850) ? rh850 : 0);
    const upperMoist = Math.max(num(rh500) ? rh500 : 0, num(rh300) ? rh300 : 0);
    const thunder = wc >= 95, snow = (wc >= 71 && wc <= 77) || wc === 85 || wc === 86, fog = wc === 45 || wc === 48 || (num(vis) && vis < 1000);
    const wet = (wc >= 51 && wc <= 67) || (wc >= 80 && wc <= 82) || pr >= 0.2;
    const lowSun = el >= -0.8 && el < 10, twilight = el >= -6 && el < -0.8, night = el < -6;
    const toward = sunDir ? ` (${sunDir})` : '';

    /* ---------------- the main look ---------------- */
    if (thunder) {
      title = 'Dark slate-grey storm sky';
      comment = 'Towering cumulonimbus is thick enough to block most sunlight; under the strongest cells the light can take on a greenish tint.';
      zenith = '#2f3642'; horizon = '#4b5852';
    } else if (fog) {
      title = 'White-grey fog';
      comment = 'Cloud is at ground level: water droplets scatter every colour equally, so the sky and the horizon merge into one flat white-grey.';
      zenith = '#c4c9ce'; horizon = '#d6d9dc';
    } else if (snow) {
      title = 'Bright, flat white-grey';
      comment = 'Snow-bearing cloud diffuses the light evenly; with fresh snow on the ground the whole scene looks pale and shadowless.';
      zenith = '#b9c1ca'; horizon = '#dde2e7';
    } else if (wet && (cl >= 60 || cc >= 80)) {
      title = pr >= 4 || cl >= 90 ? 'Dark grey, rain-laden' : 'Grey and rain-streaked';
      comment = 'Deep, water-heavy cloud absorbs and scatters the light many times over, so the sky turns grey and darkens as the rain gets heavier.';
      zenith = pr >= 4 ? '#4a515b' : '#6c747e'; horizon = pr >= 4 ? '#5d646d' : '#868d95';
    } else if (night) {
      if (cc >= 80) {
        title = 'Starless, overcast night';
        comment = cl >= 60 ? 'A low cloud deck hides the stars; over towns it reflects street lighting as a dull orange-grey glow.' : 'Higher cloud hides most stars and the Moon may show only as a bright smudge.';
        zenith = '#1b1e27'; horizon = cl >= 60 ? '#3d3530' : '#252a36';
      } else if ((hazy != null && hazy >= 0.3) || (num(pm25) && pm25 >= 35) || humidLow >= 85) {
        title = 'Washed-out night sky';
        comment = 'Haze and moist air scatter artificial light back down, so the sky looks grey-orange rather than black and only the brightest stars show.';
        zenith = '#161a28'; horizon = '#3a3440';
      } else {
        title = cc >= 30 ? 'Dark sky with passing cloud' : 'Clear, dark night sky';
        comment = `Clean${humidLow < 60 ? ', dry' : ''} air keeps the sky dark — good conditions for stars${elev > 1500 ? ', helped by the altitude' : ''}.`;
        zenith = '#070c1c'; horizon = '#16213d';
      }
    } else if (twilight) {
      const vivid = hazy != null && hazy >= 0.15 && hazy < 0.6;
      title = vivid ? 'Twilight: vivid orange glow' : hazy != null && hazy >= 0.6 ? 'Twilight: muted brownish-red' : 'Twilight: pastel pink and blue';
      comment = `The sun is just below the horizon${toward}: deep blue overhead fades to ${vivid ? 'a strong orange-red band, deepened by particles in the air' : hazy != null && hazy >= 0.6 ? 'a dim, brownish red — heavy haze swallows much of the light' : 'pink and yellow near the horizon, with the bluish Earth shadow and pink Belt of Venus opposite the sun'}.`;
      zenith = '#1d2c63'; horizon = vivid ? '#ff7a45' : hazy != null && hazy >= 0.6 ? '#9c5a48' : '#f3a6a0';
    } else if (cl >= 80 || cc >= 92) {
      const thick = cl >= 90 && cm >= 50;
      title = thick ? 'Dark grey overcast' : 'Grey overcast';
      comment = `A ${thick ? 'deep, layered' : 'continuous low'} cloud deck (low ${pct(cl)}${cm >= 30 ? `, mid ${pct(cm)}` : ''}) scatters all colours equally, so no blue gets through${thick ? ' and less light reaches the ground' : ''}.`;
      zenith = thick ? '#5b626b' : '#878f98'; horizon = thick ? '#707780' : '#a3a9b0';
    } else if (cm >= 60 && cl < 50) {
      title = 'Milky white-grey veil';
      comment = `A mid-level sheet of altostratus (${pct(cm)}) dims the sky to a uniform pale grey; the sun shows as a watery disc without a sharp outline.`;
      zenith = '#a3afbd'; horizon = '#cfd5dc';
    } else if (ch >= 50 && cl < 30 && cm < 30) {
      title = 'Blue with a white sheen';
      comment = `High ice cloud (cirrus/cirrostratus, ${pct(ch)}) spreads a thin white film over the blue${ch < 90 ? '; look for a 22° halo around the sun' : ''}.`;
      zenith = '#4f86cf'; horizon = '#cfdff0';
    } else if (num(dust) && dust >= 80) {
      title = 'Yellow-brown dusty haze';
      comment = `Mineral dust (${Math.round(dust)} µg/m³) both scatters light and absorbs blue, giving a beige-yellow sky and a dimmed, whitish sun.`;
      zenith = '#b29f78'; horizon = '#dcc898';
    } else if ((hazy != null && hazy >= 0.6) || (num(pm25) && pm25 >= 75)) {
      title = 'Whitish-grey haze';
      comment = `A heavy load of fine particles (${hazy != null ? `AOD ${hazy.toFixed(2)}` : ''}${hazy != null && num(pm25) ? ', ' : ''}${num(pm25) ? `PM2.5 ${Math.round(pm25)} µg/m³` : ''}) scatters all colours, washing the blue out to white-grey; the sun looks dimmed.`;
      zenith = '#a3afbb'; horizon = '#d6d6cf';
    } else if ((hazy != null && hazy >= 0.3) || (humidLow >= 75 && hazy != null && hazy >= 0.15)) {
      title = 'Pale, milky blue';
      comment = `Haze (AOD ${hazy.toFixed(2)})${humidLow >= 75 ? ` in humid air (${pct(humidLow)}) — moisture swells the particles —` : ''} scatters extra white light, so the blue is pale and fades to white near the horizon.`;
      zenith = '#7aa6d6'; horizon = '#dbe6ef';
    } else if (hazy != null && hazy < 0.1 && humidLow < 60 && cc < 25) {
      title = 'Deep, saturated blue';
      comment = `Clean (AOD ${hazy.toFixed(2)}), dry air leaves almost pure Rayleigh scattering, so the blue is rich overhead${elev > 1500 ? ' — even darker at this altitude, with less air above you' : ''}.`;
      zenith = elev > 1500 ? '#1748b8' : '#1f5fd6'; horizon = '#8fc3ff';
    } else {
      title = cc >= 25 ? 'Blue with white clouds' : 'Clear blue';
      comment = `${cc >= 25 ? `Broken cloud (${pct(cc)}) drifts across ` : ''}a ${hazy != null && hazy >= 0.15 ? 'slightly hazy' : 'clean'} blue sky that pales towards the horizon, where sunlight passes through more air.`;
      zenith = '#3a7be0'; horizon = '#b9d8ff';
    }

    /* ---------------- extra remarks ---------------- */
    if (lowSun && !thunder && !fog && !(wet && cl >= 60)) {
      const tint = hazy == null ? 'golden' : hazy < 0.1 ? 'pale yellow' : hazy < 0.4 ? 'orange' : 'deep red';
      notes.push(`The sun is low (${el.toFixed(0)}°${toward}): its light crosses a long path of air that strips out blue, so expect ${tint} tones near the horizon.`);
      horizon = { 'pale yellow': '#ffd98a', golden: '#ffbf5e', orange: '#ff9a45', 'deep red': '#e8583a' }[tint];
    }
    if ((lowSun || twilight) && cl < 40 && (cm + ch) >= 25 && (cm + ch) <= 140) notes.push('Mid and high cloud over a clear horizon is ideal for clouds lit pink, orange and red from below.');
    if (!night && !thunder && !fog && cl < 50 && upperMoist >= 80 && ch < 30) notes.push(`Moist upper air (${pct(upperMoist)} at 5–9 km) — thin cirrus may form and soften the blue.`);
    if (!night && cc < 40 && num(rh500) && num(rh300) && rh500 <= 30 && rh300 <= 30) notes.push('Very dry upper air keeps the sky crisp.');
    if (!night && hazy != null && hazy >= 0.3 && num(dust) && dust >= 30 && !(dust >= 80)) notes.push(`Some of the haze is dust (${Math.round(dust)} µg/m³), adding a yellowish tint near the horizon.`);

    const factors = [
      `Sun ${el >= 0 ? el.toFixed(0) + '° up' : Math.abs(el).toFixed(0) + '° down'}`,
      `Cloud low ${pct(cl)} · mid ${pct(cm)} · high ${pct(ch)}`,
      hazy != null ? `AOD ${hazy.toFixed(2)}` : 'AOD n/a',
      num(dust) ? `Dust ${Math.round(dust)} µg/m³` : null,
      num(pm25) ? `PM2.5 ${Math.round(pm25)}` : null,
      `RH surface ${pct(rh)}${num(rh850) ? ` · 1.5 km ${pct(rh850)}` : ''}${num(rh700) ? ` · 3 km ${pct(rh700)}` : ''}${num(rh500) ? ` · 5.5 km ${pct(rh500)}` : ''}${num(rh300) ? ` · 9 km ${pct(rh300)}` : ''}`,
    ].filter(Boolean);
    return { title, comment, notes, factors, zenith, horizon };
  }

  window.Sky = { describe };
})();
