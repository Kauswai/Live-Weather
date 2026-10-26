# SkyPulse checks (dev only)

Nothing here is deployed: the Pages workflow publishes `LiveWeather/` only.

| Script | What it checks |
|---|---|
| `pulse.test.mjs` | The Pulse Advisor decision logic (`LiveWeather/pulse.js`) against hand-made weather: every level from "No umbrella needed" to "Stay indoors", profiles, warnings inside/outside the window, gear. No dependencies. |
| `sun.test.mjs` | The year-chart markers (`Solar.year` in `LiveWeather/sun.js`) at Arctic, Antarctic, near-circle, tropical and mid-latitude places: four blue dots inside the polar circles, two overhead days and two lows in the tropics, and which high and low get the larger dot. No dependencies. |
| `smoke.mjs` | Serves `LiveWeather/` locally and drives it in Chromium with **every external API mocked** (`fixtures.mjs`: Open-Meteo, BigDataCloud, NWS, map tiles, `tropical.json`). Five places/weather scenarios on a phone and a desktop viewport, every tab, then interactions: storm selection, forecast slider, full-screen map, settings (units, theme, layout), persistence, the on-device cache, the offline fallback and the HTTP 400 fallback. A resilience group checks that one failing section doesn't stop the page loading, that a start-up crash is shown on screen, that a page cached from the previous release reloads itself, that jittery PC positioning isn't treated as movement, and that a saved GPS fix is used at launch without asking for location (unless the browser already allows it). Fails on page errors, console errors, CSP violations, horizontal scrolling, or any JavaScript dialog — the fixtures carry XSS probes (`<img onerror>`, `<script>`, `javascript:` links). Screenshots go to `smoke-out/`. |

```bash
cd tests
npm install                       # Playwright
npx playwright install chromium   # once
npm test                          # all suites
node smoke.mjs ../smoke-out --only=interact   # one group
```

Python 3 must be on the PATH (the smoke test serves the site with `python3 -m http.server`).
