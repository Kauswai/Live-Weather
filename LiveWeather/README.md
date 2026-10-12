# LiveWeather: the SkyPulse website

A static site: plain HTML, CSS and JavaScript, with no build step or dependencies beyond Chart.js from a CDN. GitHub Pages serves this folder as-is. See the [repository README](../README.md) for an overview and deployment.

## Files
| File | Purpose |
|---|---|
| `index.html` | Page skeleton: top bar (search, GPS, units), hero, umbrella advisor, tiles, sun tracker, chart, live feed, hourly, daily, look-back, location gate. |
| `styles.css` | Theme tokens, scene palettes (`body.scene-*`), rain/snow overlays, a 12-column grid that collapses at 1080 px and 760 px. |
| `icons.js` | `WX.iconSVG(code, isDay, size)`, `WX.WMO` (code → text), `WX.scene(code, isDay)`, `WX.umbrellaSVG()`. |
| `sun.js` | `SunCalc`: solar position and sun-event maths (NOAA/Meeus). Pure functions with no DOM access. |
| `app.js` | All application logic (one IIFE, no globals besides `WX` and `SunCalc`). |

## How it works

### Location
1. `navigator.geolocation.watchPosition` (high accuracy) starts on load.
2. The first fix loads data. Later fixes only update the accuracy badge, unless you have moved at least `MOVE_KM` (1.5 km). A move triggers a full refetch and a feed entry.
3. If permission is denied or there is no fix:
   - it uses the last place saved in `localStorage` (`skypulse.lastLoc`);
   - otherwise it shows a gate offering a GPS retry or city search.
4. Choosing a searched city switches to manual mode. The **Live GPS** button resumes tracking.

### Data
Three requests run in parallel on every refresh. Air quality and reverse geocoding are optional, so their failures are ignored.

| Request | Endpoint | Notes |
|---|---|---|
| Forecast | `api.open-meteo.com/v1/forecast` | `timezone=auto`, `timeformat=unixtime`, `past_days=2`, `forecast_days=8`. Returns `current`, 18 `hourly` variables, `daily` and `minutely_15` precipitation. |
| Air quality | `air-quality-api.open-meteo.com/v1/air-quality` | `us_aqi`, `pm2_5`, `pm10` |
| Place name | `api.bigdatacloud.net/data/reverse-geocode-client` | Only for GPS fixes; searched cities already have names |

- **Time handling:** all timestamps are Unix epochs and are shown in the *location's* time zone via `Intl.DateTimeFormat`, so DST is handled correctly.
- **Daily rows:** daily timestamps are local midnight, so they are labelled after re-applying `utc_offset_seconds`.
- **Refresh cadence:** data refreshes every `REFRESH_MS` (5 min). It refreshes immediately when the tab becomes visible again after being stale. On failure it retries after 1 min.
- **Stale responses:** a fetch token discards responses that belong to an older location.

### Umbrella advisor (`computeUmbrella`)
It looks at every hour from now until now + window (1/3/6/12/24 h), using threshold `T` (10–90 %, default 40 %):

- **maxP**: the highest hourly precipitation probability.
- **sum**: expected rainfall. The current and last hours are weighted by the fraction that falls inside the window.
- **Nowcast**: 15-minute precipitation inside the window, and the first slot with ≥ 0.1 mm.
- **Flags**: thunder (WMO ≥ 95), snow, maximum gust, raining now (current precipitation ≥ 0.1 mm or a wet weather code).

| Level | Condition | Verdict |
|---|---|---|
| 3 | raining now, or thunder with maxP ≥ T | Umbrella needed now / Umbrella + caution |
| 2 | maxP ≥ T, or sum ≥ 1 mm, or nowcast ≥ 0.5 mm | Take an umbrella |
| 1 | maxP ≥ 0.6·T, or sum ≥ 0.2 mm | Pack a compact umbrella |
| 0 | otherwise | No umbrella needed |

Extra notes appear for gusts ≥ 45 km/h (use a windproof umbrella or jacket), thunder, snow, and strong UV on dry days.

### Sun tracker (`sun.js` + `buildSunTracker` / `updateSunTracker`)
Everything is calculated in the browser from latitude, longitude and time; no API is involved. It uses the NOAA solar calculator equations (after Meeus), which are accurate to about 1 minute.

1. **Time of year → `SunCalc.solar(t)`**. From the Julian century it derives the sun's mean longitude and anomaly, orbital eccentricity, apparent longitude and obliquity. These give the **declination** δ (how far north or south the sun is overhead) and the **equation of time** (how far sundials run ahead of or behind clocks).
2. **Live position → `SunCalc.position(t, lat, lon)`**.
   - True solar time = UTC minutes + equation of time + 4·longitude; the hour angle follows from it.
   - Elevation: `sin h = sin φ sin δ + cos φ cos δ cos H`, plus a standard atmospheric-refraction correction.
   - Azimuth is measured clockwise from north.
3. **Events for the local date → `SunCalc.times(utcMidnight, lat, lon, utcOffset)`**.
   - Solar noon = 720 − 4·lon − EoT minutes. The UTC offset makes sure it is the noon belonging to the *local* calendar day, which matters near the date line.
   - Each event solves `cos H = (sin h₀ − sin φ sin δ)/(cos φ cos δ)`, re-evaluating δ at the event time (4 iterations).
   - Thresholds h₀:
     - sunrise/sunset: −0.833° (refraction + solar radius)
     - civil, nautical and astronomical twilight: −6°, −12°, −18°
     - golden hour: +6°
   - If |cos H| > 1, the result is reported as **polar day** or **polar night**.

What the card shows (it is the last section on the page, since weather comes first):
- **Elevation curve:** spans sunrise to sunset; for polar days and nights it spans local midnight to midnight.
  - Golden hours are shaded. The path already travelled is drawn solid and the rest dashed.
  - A strip below the horizon (down to −18°) shows how deep the sun is at night.
  - **Hover or drag** anywhere on it for a tooltip giving the time (with "in 2h 10m" or "3h ago"), sun angle, azimuth, shadow length and light phase. The hovered position is mirrored as a white dot on the sky dome.
- **Sky dome:** a top-down polar plot (zenith in the centre, horizon at the rim) with the day's path, the sunrise and sunset azimuths, and the live sun.
- **Stats (12):**
  - updated every second: elevation and phase, azimuth, shadow length (1/tan h), and a countdown to sunset or sunrise;
  - fixed for the day:
    - sunrise and sunset (time, azimuth, civil dawn/dusk);
    - solar noon (direction of the sun, offset from 12:00 on the clock);
    - **max sun angle today** (vs the year's peak and tomorrow);
    - **max sun angle this year** (peak date, number of overhead/90° days in the tropics, lowest noon sun);
    - day length with the change vs yesterday and tomorrow;
    - golden hours and astronomical twilight.
- **Year chart:**
  - Shows day length (left axis, 0–24 h) and the noon sun angle (right axis, 0–90°) for every day of the current year.
  - Marks today and the extremes of both series, and gives midnight-sun or polar-night day counts at high latitudes.
  - **Hover or tap** any day to see its date (with "in N days" or "N days ago"), day length versus today, max sun angle with the solar-noon time, and sunrise and sunset.
  - Daily values are computed once per place and year by `yearData()` (366 × `SunCalc.times`) and cached.

When the static parts are rebuilt:
- they are rebuilt when the location's calendar date, the location or the window size changes;
- the SVGs are drawn at real pixel width so text stays readable on phones;
- the tracker uses the coordinates of the *loaded* dataset, so it never mixes a new location with the previous location's time zone.

### Live feed
- **After each refresh:** the current conditions are compared with the previous snapshot. Thresholds: temperature ±0.5 °C, humidity ±4 %, cloud ±15 %, pressure ±0.8 hPa, wind ±6 km/h, or a change of weather code. If nothing changed, it logs "steady".
- **Umbrella changes:** a change in umbrella level is logged only if the window and threshold settings are unchanged.
- **Upcoming events:** checked every refresh and every 30 s, and announced once each:
  - rain ≥ T within 3 h;
  - nowcast rain within 60 min;
  - thunder within 6 h;
  - sunrise/sunset within 1 h;
  - UV ≥ 6;
  - gusts ≥ 60 km/h.

### Persistence
`localStorage` (wrapped in try/catch) remembers the unit, umbrella window, threshold and last location. Nothing else is stored.

## Tuning
Constants at the top of `app.js`:

```js
const REFRESH_MS = 5 * 60e3;  // weather refresh cadence
const MOVE_KM = 1.5;          // refetch after moving this far
const FEED_MAX = 60;          // feed entries kept
```

## Testing tips
- Geolocation needs HTTPS or `localhost`. Serve the folder with `py -m http.server 8090` from inside `LiveWeather/`, or with `--directory LiveWeather` from the repo root.
- To simulate GPS in DevTools, use **Sensors → Location**. The **More tools → Sensors** panel lets you change the location while the page is open, which tests the "you moved" refresh.

## Known limitations
- The 15-minute nowcast is high-resolution only in Europe and North America. Elsewhere Open-Meteo interpolates it from hourly data.
- If the air-quality API is unavailable, that tile is omitted.
- Hourly rain probability is per hour. The advisor uses the peak hour rather than a combined "any rain" probability, which would overstate correlated hours.
