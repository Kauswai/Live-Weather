# Live Weather

**SkyPulse** is a live weather dashboard for your exact location. It shows past, present and future temperature, humidity, cloud cover, wind, pressure and rain, plus an umbrella advisor that tells you whether to take one.

**Live site:** <https://kauswai.github.io/Live-Weather/>

- Website source and technical notes: [LiveWeather/](LiveWeather/README.md)
- Deployment: `.github/workflows/deploy-pages.yml` publishes `LiveWeather/` to GitHub Pages on every push to `main`.

## Highlights
| | |
|---|---|
| 📍 **Live GPS** | Follows your position and refreshes the forecast when you move more than 1.5 km. Falls back to city search or your last known place. |
| ☂️ **Umbrella advisor** | Choose a 1–24 h window and a rain-chance threshold. It blends hourly probability, expected rainfall and a 15-minute nowcast into a clear recommendation. |
| 📰 **Live feed** | Auto-refreshes every 5 min and logs changes plus upcoming events: rain onset, thunderstorms, sunset, high UV, strong gusts. |
| 📈 **Past · Present · Future** | One interactive chart from 2 days back to 7 days ahead, with a "now" marker. |
| 🧭 **Current conditions** | Feels like, humidity, dew point, cloud layers, wind, pressure tendency, rain, nowcast, UV, visibility, air quality, moon phase. |
| 🗓️ **Forecasts** | Next-24-hour strip, 8-day outlook, and a look back at the last 48 hours. |
| 🌅 **Sun tracker** | The live solar elevation and azimuth are computed from your latitude, longitude and the time of year. It shows the sunrise → sunset elevation curve (hover it for the sun angle at any past or future moment today), a top-down sky path, local sunrise/sunset/solar-noon times, day length (and its daily change), golden hour, twilight and your shadow length. It also gives today's maximum sun angle and the year's highest and lowest noon sun, plus a full-year chart of day length and maximum sun angle; hover it to see any day. It sits at the bottom of the page, below the weather sections. |

No build step, no API keys, no tracking. Your coordinates are sent only to the weather and place-name APIs listed below.

## Repository layout
```
Live-Weather/
├── LiveWeather/              ← the website (served by GitHub Pages)
│   ├── index.html            page structure
│   ├── styles.css            glassmorphism theme, weather-reactive backgrounds, responsive layout
│   ├── icons.js              animated SVG weather icons + WMO weather-code names
│   ├── sun.js                solar position, sunrise/sunset/twilight maths (NOAA algorithm)
│   ├── app.js                location, data fetching, umbrella logic, charts, live feed
│   └── README.md             technical documentation
├── .github/workflows/
│   └── deploy-pages.yml      Pages deployment
└── README.md                 this file
```

## Run locally
Browsers allow geolocation only on HTTPS or `localhost`:

```bash
py -m http.server 8090 --directory LiveWeather
```

Then open <http://localhost:8090>.

## Enabling GitHub Pages (one-time)
Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**. After that, every push to `main` redeploys the site. You can also redeploy by hand from **Actions → Deploy site to GitHub Pages → Run workflow**.

## Data & credits
- Weather forecast, history, nowcast and air quality: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0)
- Place names from coordinates: [BigDataCloud](https://www.bigdatacloud.com/) free client-side reverse geocoding
- City search: Open-Meteo Geocoding API
- Sun position & events: computed locally with the [NOAA Solar Calculator](https://gml.noaa.gov/grad/solcalc/calcdetails.html) equations (Meeus, *Astronomical Algorithms*)
- Charts: [Chart.js](https://www.chartjs.org/) 4.4.1
