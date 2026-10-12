# LiveWeather: the SkyPulse website

A static site: plain HTML, CSS and JavaScript, with no build step or dependencies beyond Chart.js from a CDN. GitHub Pages serves this folder as-is. See the [repository README](../README.md) for an overview and deployment.

## Files
| File | Purpose |
|---|---|
| `index.html` | Page skeleton: top bar (search, GPS, units), hero, umbrella advisor, tiles, chart, live feed, hourly, daily, look-back, location gate. |
| `styles.css` | Theme tokens, scene palettes (`body.scene-*`), rain/snow overlays, a 12-column grid that collapses at 1080 px and 760 px. |
| `icons.js` | `WX.iconSVG(code, isDay, size)`, `WX.WMO` (code → text), `WX.scene(code, isDay)`, `WX.umbrellaSVG()`. |
| `app.js` | All application logic (one IIFE, no globals besides `WX`). |

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
