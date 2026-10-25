# SkyPulse checks (dev only)

Nothing here is deployed: the Pages workflow publishes `LiveWeather/` only.

| Script | What it checks |
|---|---|
| `pulse.test.mjs` | The Pulse Advisor decision logic (`LiveWeather/pulse.js`) against hand-made weather: every level from "No umbrella needed" to "Stay indoors", profiles, warnings inside/outside the window, gear. No dependencies. |
| `smoke.mjs` | Serves `LiveWeather/` locally and drives it in Chromium with **every external API mocked** (`fixtures.mjs`: Open-Meteo, BigDataCloud, NWS, map tiles, `tropical.json`). Five places/weather scenarios on a phone and a desktop viewport, every tab, then interactions: storm selection, forecast slider, full-screen map, settings (units, theme, layout), persistence, the on-device cache, the offline fallback and the HTTP 400 fallback. Fails on page errors, console errors, CSP violations, horizontal scrolling, or any JavaScript dialog — the fixtures carry XSS probes (`<img onerror>`, `<script>`, `javascript:` links). Screenshots go to `smoke-out/`. |

```bash
cd tests
npm install                       # Playwright
npx playwright install chromium   # once
npm test                          # both suites
node smoke.mjs ../smoke-out --only=interact   # one group
```

Python 3 must be on the PATH (the smoke test serves the site with `python3 -m http.server`).
