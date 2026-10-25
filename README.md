# Live Weather

**SkyPulse** is a live weather app for your exact location. It shows:

- past, present and future temperature, humidity, cloud cover, wind, pressure and rain, in **15-minute steps** in the US and Europe;
- the **Pulse Advisor**, which tells you what to take, from "no umbrella needed" to "stay indoors";
- a live **cyclone tracker**: every active tropical cyclone on one interactive map, using data from the official regional agencies;
- **local warnings**.

You can install it on a phone as an app.

**Live site:** <https://kauswai.github.io/Live-Weather/>. On a phone, open it and choose *Install app* or *Add to Home screen*.

- Website source and technical notes: [LiveWeather/](LiveWeather/README.md)
- Cyclone and warnings data pipeline: [pipeline/](pipeline/fetch_tropical.py)
- Deployment: `.github/workflows/deploy-pages.yml`. Every push to `main`, and a run every 30 minutes, collects fresh cyclone and warning data, then publishes `LiveWeather/` to GitHub Pages.

## Highlights
| | |
|---|---|
| 📱 **Phone app** | A bottom tab bar (Now · Forecast · Alerts · Storms · Sun · Feed), swipe between tabs, pull to refresh, a search sheet, and alert badges. It installs as a PWA and the app shell works offline. |
| 🫀 **Pulse Advisor** | Looks 1–24 h ahead at rain and snow intensity and type, gusts and cyclone winds, feels-like heat and cold, fog, air quality and UV, plus SkyPulse advisories and official warnings. It gives one verdict on a 0–5 scale: <ul><li>"No umbrella needed", "Take an umbrella" or "Rain jacket, not an umbrella";</li><li>"Limit time outdoors" or "Avoid going out";</li><li>"Stay indoors".</li></ul> It also shows what to take, six factor meters, the warnings in your window, and a link to your national weather service. There are Standard, Sensitive and Hardy profiles. |
| 🌀 **Cyclone tracker** | Its own tab: a live world map of every active storm from **NHC** (Atlantic/East & Central Pacific), **JMA** (RSMC Tokyo), **IMD** (RSMC New Delhi: official cone and wind areas), **JTWC** (all other basins) and **GDACS** (surge/rain model maps). <ul><li>Map layers: forecast cones, intensity-coloured past and forecast tracks, 34/50/64-kt wind radii and labels, each switchable.</li><li>A forecast slider with play, and a full-screen map.</li><li>An intensity-forecast chart with a typical-error band.</li></ul> For a storm near you it shows: <ul><li>the track with your position and the line of closest approach;</li><li>intensity on the agency's own scale and the local scale;</li><li>closest approach, and when gale- or hurricane-force winds arrive and end;</li><li>how the wind direction changes as the storm passes;</li><li>periods of **onshore and offshore winds** from a coastline probe, and storm-surge exposure;</li><li>rain during passage, waves at the nearest sea, and the official bulletins.</li></ul> |
| ⚠️ **Warnings** | Official warnings come from **NWS** (US), **IMD/state agencies via NDMA SACHET** (India, matched to your state or district), **Hong Kong Observatory** and the official cyclone areas. They're combined with SkyPulse forecast hazards: heavy rain and flooding, damaging winds, storm surge, dangerous surf, thunderstorms and hail, heat, cold, fog and ice. |
| 🌧️ **Realistic weather effects** | A canvas particle system with depth, wind slant and splashes. There are separate scenes for drizzle (fine mist), light, moderate and heavy rain (rain curtains and splashes), thunderstorms (branching lightning, flashes, hail), **tropical cyclones** (sideways wind-driven rain, spray, flying debris, spiral bands rotating the right way for each hemisphere), snow, fog, clouds and stars. |
| 📍 **Live GPS** | Follows your position and refreshes the forecast when you move more than 1.5 km. Falls back to city search or your last known place. |
| ⏱️ **15-minute data** | In the US and Europe it uses Open-Meteo's free 15-minute forecasts (temperature, feels like, precipitation, wind, gusts, visibility and weather) for a 6-hour, 15-minute chart and a sharper Pulse Advisor. Weather refreshes on Open-Meteo's 15-minute update cycle; warnings are still checked every 5 min. |
| 💾 **On-device cache** | The last forecast for up to 8 places is kept on the device for 15–30 min (your choice). Opening the app or a searched place again in that time uses it instead of a new request. If the network is down, the newest saved copy is shown and marked "offline copy". |
| 🎛️ **Settings** | <ul><li>Units for each quantity (°C/°F; km/h, mph, m/s or knots; mm or inches; hPa, inHg or mmHg; km or miles) and a 12 or 24-hour clock.</li><li>Appearance: live-sky, night, black (OLED) or high-contrast theme, accent colour, compact density, and full, lite or no weather effects.</li><li>Layout: show, hide and reorder every section, choose the detail tiles, and pick the start tab.</li><li>Pulse profile, 15-minute data, cache duration, and "clear saved data".</li></ul> |
| 📰 **Live feed** | Logs changes, new warnings, cyclone threat changes, rain onset, sunset, UV and strong gusts. |
| 📈 **Past · Present · Future** | One interactive chart from 2 days back to 7 days ahead, with a "now" marker. |
| 🧭 **Current conditions** | Feels like, humidity, dew point, cloud layers, wind, pressure tendency, rain, nowcast, UV, visibility, air quality, moon phase. |
| 🗓️ **Forecasts** | Next-24-hour strip, 8-day outlook, and a look back at the last 48 hours. |
| 🌅 **Sun tracker** | Live solar elevation and azimuth, a sunrise → sunset curve you can hover, a top-down sky path, day length, golden hour, twilight, and a full-year chart of day length and maximum sun angle. |

No API keys, no tracking, no third-party scripts or fonts: the libraries are served from the site itself. Your coordinates, rounded to about 100 m, go only to the weather, elevation, marine, alert and place-name APIs listed below. A Content-Security-Policy blocks everything else.

## Repository layout
```
Live-Weather/
├── LiveWeather/              ← the website (served by GitHub Pages)
│   ├── index.html            page structure (sections tagged per phone tab)
│   ├── styles.css            theme, weather-reactive backgrounds, themes/density, desktop grid + phone app shell
│   ├── app.js                location, forecast refresh + cache, charts, 15-min outlook, live feed, tabs/gestures/PWA
│   ├── guard.js              start-up guard: shows any launch error on screen instead of a stuck spinner
│   ├── settings.js           preferences, appearance, section layout engine, settings sheet
│   ├── cache.js              on-device weather cache (localStorage, up to 8 places)
│   ├── pulse.js              Pulse Advisor decision logic (pure)
│   ├── hazards.js            cyclone threat analysis, warnings, storm detail card
│   ├── storms.js             cyclone tracker: world map, time slider, storm list, intensity chart
│   ├── fx.js                 canvas precipitation and storm effects
│   ├── sun.js                solar position, sunrise/sunset/twilight maths (NOAA equations)
│   ├── icons.js              animated SVG weather icons, Pulse glyphs, WMO weather-code names
│   ├── manifest.webmanifest  PWA manifest       sw.js  service worker (offline shell)
│   ├── vendor/               Chart.js, Leaflet and the Inter font, self-hosted with their licences
│   ├── icons/                app icons (generated by pipeline/make_icons.py)
│   ├── data/tropical.json    generated on every deploy, not committed
│   └── README.md             technical documentation
├── pipeline/
│   ├── fetch_tropical.py     NHC · JMA · JTWC · IMD · GDACS · SACHET → tropical.json (stdlib only)
│   └── make_icons.py         renders the PNG app icons (stdlib only)
├── tests/                    dev-only checks (Pulse logic; Playwright smoke test with mocked APIs)
├── .github/workflows/
│   └── deploy-pages.yml      30-minute data refresh + Pages deployment
├── THIRD_PARTY_NOTICES.md    bundled libraries, data terms, credited methods
└── README.md                 this file
```

## Run locally
```bash
py pipeline/fetch_tropical.py --out LiveWeather/data/tropical.json
```

```bash
py -m http.server 8090 --directory LiveWeather
```

Then open <http://localhost:8090>. Browsers allow geolocation only on HTTPS or `localhost`. The service worker only registers over HTTPS, so local edits are never served from a cache.

**Preview any precipitation effect:** add `?fx=drizzle`, `light`, `moderate`, `heavy`, `storm`, `hail`, `cyclone`, `snow`, `fog`, `clouds` or `stars` to the URL. Add `?tab=storms` (or `now`, `forecast`, `alerts`, `sun`, `feed`) to open a specific tab on a phone.

**Checks:** `node tests/pulse.test.mjs` runs without dependencies; the browser smoke test is described in [tests/README.md](tests/README.md).

## Enabling GitHub Pages (one-time)
Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**. You can also redeploy by hand from **Actions → Deploy site to GitHub Pages → Run workflow**.

GitHub pauses scheduled workflows in repositories with no activity for 60 days. If cyclone data stops updating, re-enable the workflow in the Actions tab.

## Data & credits
- **Weather:** forecast, history, 15-minute data, nowcast, air quality, marine (waves, sea temperature) and elevation from [Open-Meteo](https://open-meteo.com/) (CC BY 4.0). The free API is for non-commercial use; a commercial deployment needs an Open-Meteo subscription.
- **Tropical cyclones:**
  - [NOAA NHC/CPHC](https://www.nhc.noaa.gov/);
  - [JMA](https://www.jma.go.jp/bosai/map.html#contents=typhoon&lang=en) (RSMC Tokyo);
  - [IMD](https://rsmcnewdelhi.imd.gov.in/) (RSMC New Delhi);
  - [JTWC](https://www.metoc.navy.mil/jtwc/jtwc.html);
  - [GDACS](https://www.gdacs.org/) (UN/EC).
- **Warnings:**
  - [NWS alerts API](https://www.weather.gov/documentation/services-web-api);
  - [NDMA SACHET](https://sachet.ndma.gov.in/) CAP feed (IMD and the state disaster-management authorities);
  - [Hong Kong Observatory](https://www.hko.gov.hk/) open data.
- **Maps:** [Leaflet](https://leafletjs.com/) 1.9.4 (BSD-2, self-hosted) with Esri World Dark Gray Canvas tiles (© Esri, © OpenStreetMap contributors).
- **Place names:** [BigDataCloud](https://www.bigdatacloud.com/) for reverse geocoding; Open-Meteo Geocoding for search.
- **Sun position:** computed locally with the [NOAA Solar Calculator](https://gml.noaa.gov/grad/solcalc/calcdetails.html) equations.
- **Charts:** [Chart.js](https://www.chartjs.org/) 4.4.1 (MIT, self-hosted). **Font:** [Inter](https://rsms.me/inter/) (SIL OFL 1.1, self-hosted).
- Full list with licences: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

> Cyclone impacts at your location are SkyPulse **estimates**, derived from agency wind radii and forecast models. Always follow the official warnings and evacuation orders from your national meteorological service and local authorities.
