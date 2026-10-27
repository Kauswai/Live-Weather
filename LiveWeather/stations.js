/* SkyPulse research stations: key polar and remote stations that the place search (GeoNames, via Open-Meteo) lacks
 * or lists without a country. Open-Meteo forecasts any coordinate, so a station works like any other place.
 * Coordinates are the stations' published positions (public facts), rounded to ~100 m or better.
 *   Stations.search(query) → matches in the Open-Meteo geocoding result format
 *   Stations.nearest(lat, lon, km) → the closest station within km, or null
 */
(function () {
  'use strict';
  const AQ = ['AQ', 'Antarctica'];
  // [name, lat, lon, operated by, [country code, region shown], 'aliases|…']
  const LIST = [
    // Antarctica (south of 60° S)
    ['Amundsen–Scott South Pole Station', -89.9975, 139.2728, 'United States', AQ, 'South Pole|Amundsen Scott|Pole Station|Geographic South Pole'],
    ['McMurdo Station', -77.8463, 166.6683, 'United States', AQ, 'McMurdo'],
    ['Palmer Station', -64.7743, -64.0531, 'United States', AQ, ''],
    ['Vostok Station', -78.4642, 106.8372, 'Russian', AQ, 'Vostok'],
    ['Mirny Station', -66.5531, 93.0097, 'Russian', AQ, 'Mirny|Mirnyy'],
    ['Progress Station', -69.3789, 76.3869, 'Russian', AQ, ''],
    ['Novolazarevskaya Station', -70.7739, 11.8247, 'Russian', AQ, 'Novolazarevskaya|Novo'],
    ['Bellingshausen Station', -62.1964, -58.9608, 'Russian', AQ, 'Bellingshausen'],
    ['Esperanza Base', -63.3975, -56.9961, 'Argentine', AQ, 'Esperanza|Base Esperanza|Hope Bay'],
    ['Marambio Base', -64.2414, -56.6272, 'Argentine', AQ, 'Marambio|Vicecomodoro Marambio'],
    ['Carlini Base', -62.2381, -58.6667, 'Argentine', AQ, 'Carlini|Jubany'],
    ['San Martín Base', -68.1300, -67.1028, 'Argentine', AQ, 'San Martin'],
    ['Belgrano II Base', -77.8747, -34.6269, 'Argentine', AQ, 'Belgrano'],
    ['Orcadas Base', -60.7375, -44.7372, 'Argentine', AQ, 'Orcadas|Laurie Island'],
    ['Eduardo Frei Montalva Base', -62.2008, -58.9628, 'Chilean', AQ, 'Frei|Villa Las Estrellas'],
    ["Bernardo O'Higgins Base", -63.3208, -57.8986, 'Chilean', AQ, "O'Higgins|OHiggins"],
    ['Arturo Prat Base', -62.4783, -59.6636, 'Chilean', AQ, 'Prat'],
    ['Concordia Station', -75.0997, 123.3322, 'French–Italian', AQ, 'Concordia|Dome C|Dome Concordia'],
    ["Dumont d'Urville Station", -66.6628, 140.0014, 'French', AQ, "Dumont d'Urville|Dumont dUrville|DDU"],
    ['Mario Zucchelli Station', -74.6950, 164.1130, 'Italian', AQ, 'Zucchelli|Terra Nova Bay'],
    ['Rothera Research Station', -67.5683, -68.1250, 'British', AQ, 'Rothera'],
    ['Halley Research Station', -75.5730, -25.4740, 'British', AQ, 'Halley|Halley VI'],
    ['Signy Research Station', -60.7083, -45.5950, 'British', AQ, 'Signy'],
    ['Neumayer Station III', -70.6667, -8.2667, 'German', AQ, 'Neumayer'],
    ['Troll Station', -72.0114, 2.5350, 'Norwegian', AQ, 'Troll'],
    ['Princess Elisabeth Antarctica', -71.9497, 23.3469, 'Belgian', AQ, 'Princess Elisabeth Station|Princess Elisabeth'],
    ['Casey Station', -66.2825, 110.5267, 'Australian', AQ, 'Casey'],
    ['Davis Station', -68.5767, 77.9675, 'Australian', AQ, 'Davis'],
    ['Mawson Station', -67.6033, 62.8736, 'Australian', AQ, 'Mawson'],
    ['Scott Base', -77.8492, 166.7681, 'New Zealand', AQ, ''],
    ['Syowa Station', -69.0069, 39.5900, 'Japanese', AQ, 'Syowa|Showa'],
    ['Dome Fuji Station', -77.3167, 39.7000, 'Japanese', AQ, 'Dome Fuji|Dome F'],
    ['Bharati Station', -69.4078, 76.1953, 'Indian', AQ, 'Bharati'],
    ['Maitri Station', -70.7658, 11.7322, 'Indian', AQ, 'Maitri'],
    ['Great Wall Station', -62.2164, -58.9644, 'Chinese', AQ, 'Great Wall'],
    ['Zhongshan Station', -69.3733, 76.3778, 'Chinese', AQ, 'Zhongshan'],
    ['Kunlun Station', -80.4170, 77.1160, 'Chinese', AQ, 'Kunlun|Dome A|Dome Argus'],
    ['Qinling Station', -74.9000, 163.7167, 'Chinese', AQ, 'Qinling|Inexpressible Island'],
    ['King Sejong Station', -62.2233, -58.7892, 'South Korean', AQ, 'King Sejong|Sejong'],
    ['Jang Bogo Station', -74.6236, 164.2286, 'South Korean', AQ, 'Jang Bogo'],
    ['Comandante Ferraz Antarctic Station', -62.0853, -58.3925, 'Brazilian', AQ, 'Ferraz|Comandante Ferraz'],
    ['Vernadsky Research Base', -65.2453, -64.2578, 'Ukrainian', AQ, 'Vernadsky|Akademik Vernadsky|Faraday'],
    ['SANAE IV', -71.6728, -2.8406, 'South African', AQ, 'SANAE'],
    ['Artigas Base', -62.1844, -58.9022, 'Uruguayan', AQ, 'Artigas'],
    ['Arctowski Polish Antarctic Station', -62.1597, -58.4733, 'Polish', AQ, 'Arctowski|Henryk Arctowski'],
    ['Juan Carlos I Base', -62.6633, -60.3881, 'Spanish', AQ, 'Juan Carlos'],
    // sub-Antarctic islands
    ['Macquarie Island Station', -54.4994, 158.9369, 'Australian', ['AU', 'Macquarie Island, Australia'], 'Macquarie'],
    ['King Edward Point', -54.2833, -36.4944, 'British', ['GS', 'South Georgia'], 'Grytviken'],
    ['Marion Island Station', -46.8767, 37.8653, 'South African', ['ZA', 'Prince Edward Islands, South Africa'], 'Marion Island'],
    ['Alfred Faure Station', -46.4319, 51.8567, 'French', ['TF', 'Crozet Islands, French Southern Lands'], 'Alfred Faure|Crozet'],
    // Arctic
    ['Summit Station', 72.5794, -38.4594, 'United States', ['GL', 'Greenland'], 'Summit Camp|Greenland Summit'],
    ['Villum Research Station', 81.6000, -16.6667, 'Danish', ['GL', 'Greenland'], 'Station Nord|Villum'],
    ['Danmarkshavn', 76.7695, -18.6683, 'Danish', ['GL', 'Greenland'], ''],
    ['Zackenberg Research Station', 74.4700, -20.5700, 'Danish', ['GL', 'Greenland'], 'Zackenberg'],
    ['Hornsund Polish Polar Station', 77.0007, 15.5403, 'Polish', ['SJ', 'Svalbard'], 'Hornsund'],
    ['Cape Baranov Ice Base', 79.2667, 101.7500, 'Russian', ['RU', 'Severnaya Zemlya, Russia'], 'Cape Baranov|Mys Baranova'],
    ['Geographic North Pole', 89.9990, 0, '', ['', 'Arctic Ocean'], 'North Pole'],
  ];

  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const STATIONS = LIST.map(([name, lat, lon, op, [cc, region], aka]) => ({
    name, lat, lon, cc, region, admin1: op ? `${op} station` : '',
    keys: [name, ...aka.split('|').filter(Boolean)].map(norm),
  }));
  const asResult = (s) => ({ id: 'station:' + norm(s.name).replace(/ /g, '-'), name: s.name, latitude: s.lat, longitude: s.lon,
    country: s.region, country_code: s.cc || undefined, admin1: s.admin1, station: true });

  /** every query word must start a word of the station's name or one of its aliases; whole-name prefixes rank first */
  function search(q, max = 4) {
    const words = norm(q).split(' ').filter(Boolean);
    if (words.join('').length < 3) return [];
    const phrase = words.join(' ');
    return STATIONS.map((s) => {
      let rank = 0;
      for (const k of s.keys) {
        const toks = k.split(' ');
        if (words.every((w) => toks.some((t) => t.startsWith(w)))) rank = Math.max(rank, k.startsWith(phrase) ? 2 : 1);
      }
      return [rank, s];
    }).filter(([rank]) => rank).sort((a, b) => b[0] - a[0]).slice(0, max).map(([, s]) => asResult(s));
  }

  const km = (aLat, aLon, bLat, bLon) => {
    const r = Math.PI / 180, h = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  };
  function nearest(lat, lon, maxKm = 30) {
    let best = null, bd = maxKm;
    for (const s of STATIONS) { const d = km(lat, lon, s.lat, s.lon); if (d <= bd) { bd = d; best = s; } }
    return best && asResult(best);
  }

  window.Stations = { search, nearest, norm };
})();
