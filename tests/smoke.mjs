// SkyPulse smoke test: serves LiveWeather/ locally, mocks every external API with tests/fixtures.mjs,
// drives each tab on a phone and a desktop viewport, and fails on page errors, console errors,
// CSP violations or any JavaScript dialog (the fixtures carry XSS probes).
//
//   node tests/smoke.mjs [outDir] [--only=name]
//
// Needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`) and Python 3.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as F from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'LiveWeather');
const args = process.argv.slice(2);
const OUT = resolve(args.find((a) => !a.startsWith('--')) || 'smoke-out');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
const PORT = 8000 + Math.floor(Math.random() * 900);
mkdirSync(OUT, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));
const BASE = `http://127.0.0.1:${PORT}/`;

const SCENARIOS = [
  { name: 'nyc-calm', place: 'nyc', wx: 'calm' },
  { name: 'berlin-rain', place: 'berlin', wx: 'rain' },
  { name: 'miami-cyclone', place: 'miami', wx: 'cyclone' },
  { name: 'delhi-heat', place: 'delhi', wx: 'heat' },
  { name: 'tokyo-storm', place: 'tokyo', wx: 'storm' },
];
const VIEWPORTS = { phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, desktop: { viewport: { width: 1440, height: 1000 } } };
const TABS = ['now', 'forecast', 'alerts', 'storms', 'sun', 'feed'];

let failures = 0;
const fail = (msg) => { failures++; console.log('  ✗ ' + msg); };

async function route(ctx, sc, hits) {
  const place = F.PLACES[sc.place];
  await ctx.route('**/*', async (r) => {
    const url = r.request().url(), u = new URL(url);
    hits[u.host] = (hits[u.host] || 0) + 1;
    const json = (body) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (u.host === `127.0.0.1:${PORT}`) {
      if (u.pathname.endsWith('/data/tropical.json')) return json(F.tropical(sc.wx));
      return r.continue();
    }
    switch (u.host) {
      case 'api.open-meteo.com':
        if (u.pathname.startsWith('/v1/elevation')) return json(F.elevation(url, place));
        hits.forecast = (hits.forecast || 0) + 1;
        hits.lastForecastURL = url;
        return json(F.forecast(url, sc.wx, place));
      case 'air-quality-api.open-meteo.com': return json(F.airQuality(sc.wx));
      case 'marine-api.open-meteo.com': return json(F.marine(url));
      case 'geocoding-api.open-meteo.com': return json(F.search(u.searchParams.get('name') || ''));
      case 'api.bigdatacloud.net': hits.reverse = (hits.reverse || 0) + 1; return json(F.reverse(place));
      case 'api.weather.gov': return json(F.nws(sc.wx));
      case 'data.weather.gov.hk': return json({});
      case 'server.arcgisonline.com': return r.fulfill({ status: 200, contentType: 'image/png', body: F.TILE });
      default: return r.abort();
    }
  });
}

async function newPage(browser, sc, vp, hits, state) {
  const place = F.PLACES[sc.place];
  const ctx = await browser.newContext({ ...VIEWPORTS[vp], geolocation: { latitude: place.lat, longitude: place.lon, accuracy: 12 }, permissions: ['geolocation'],
    ...(state ? { storageState: state } : {}), serviceWorkers: 'block' });
  await route(ctx, sc, hits);
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource.*(404|ERR_FAILED)/.test(m.text())) problems.push('console: ' + m.text()); if (/Content Security Policy|Refused to/.test(m.text())) problems.push('csp: ' + m.text()); });
  page.on('dialog', (d) => { problems.push('DIALOG (XSS?): ' + d.message()); d.dismiss(); });
  return { ctx, page, problems };
}

const browser = await chromium.launch();
for (const sc of SCENARIOS) {
  if (ONLY && !sc.name.includes(ONLY)) continue;
  for (const vp of Object.keys(VIEWPORTS)) {
    console.log(`▶ ${sc.name} · ${vp}`);
    const hits = {};
    const { ctx, page, problems } = await newPage(browser, sc, vp, hits);
    await page.goto(BASE);
    try { await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false', null, { timeout: 15000 }); }
    catch { fail('app never finished loading'); }
    await page.waitForTimeout(1500);
    for (const tab of TABS) {
      if (vp === 'phone') {
        const btn = page.locator(`#tabbar button[data-tab="${tab}"]`);
        if (await btn.count() && await btn.isVisible()) { await btn.click(); await page.waitForTimeout(700); }
        else continue;
      }
      await page.screenshot({ path: join(OUT, `${sc.name}-${vp}-${tab}.png`), fullPage: true });
      if (vp === 'desktop') break; // desktop shows every section on one page
    }
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (sw > 1) fail(`page scrolls horizontally by ${sw}px`);
    // reload within the cache window: the forecast must come from the local cache
    const before = hits.forecast || 0;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false', null, { timeout: 15000 }).catch(() => fail('reload never finished'));
    await page.waitForTimeout(800);
    if ((hits.forecast || 0) !== before) fail(`reload re-fetched the forecast (${before} → ${hits.forecast}) instead of using the cache`);
    if (hits.reverse > 1) fail(`reverse geocoder called ${hits.reverse}×`);
    problems.forEach(fail);
    console.log(`  requests: ${Object.entries(hits).filter(([k]) => k !== 'lastForecastURL').map(([k, v]) => `${k}=${v}`).join(' ')}`);
    if (sc.name === 'nyc-calm' && vp === 'desktop') console.log('  forecast URL: ' + hits.lastForecastURL);
    await ctx.close();
  }
}
// ------------------------------------------------------------------ interactions
if (!ONLY || ONLY === 'interact') {
  const sc = SCENARIOS[2]; // Miami hurricane
  for (const vp of ['phone', 'desktop']) {
    console.log(`▶ interactions · ${vp}`);
    const hits = {};
    const { ctx, page, problems } = await newPage(browser, sc, vp, hits);
    await page.goto(BASE + '?tab=storms');
    await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false', null, { timeout: 15000 });
    await page.waitForTimeout(1200);
    // storm list → select another storm, scrub the forecast, full-screen map
    await page.locator('.storm-row').nth(1).click(); await page.waitForTimeout(500);
    const title = await page.locator('#tcTitle').textContent();
    if (!/Zelia|Kong/.test(title)) fail('selecting a storm did not update the detail card: ' + title);
    await page.locator('#spTimeInput').fill('48'); await page.waitForTimeout(300);
    if (!/\+48 h/.test(await page.locator('#spTimeLabel').textContent())) fail('time slider label did not update');
    await page.locator('#spPlay').click(); await page.waitForTimeout(1200); await page.locator('#spPlay').click();
    await page.locator('#spFull').click(); await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, `interact-${vp}-mapfull.png`) });
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    if (await page.locator('#spMapWrap.full').count()) fail('Escape did not leave full screen');
    await page.locator('#spLayers [data-layer="cone"]').click(); await page.waitForTimeout(200);
    await page.screenshot({ path: join(OUT, `interact-${vp}-storms.png`), fullPage: vp === 'desktop' });
    // settings: imperial units, black theme, accent, compact, 24 h clock, hide the sun tracker, move storms up
    await page.locator('#settingsBtn').click(); await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, `interact-${vp}-settings.png`) });
    const press = async (group, label) => { await page.locator(`.set-seg[aria-label="${group}"] button`, { hasText: label }).first().click(); await page.waitForTimeout(120); };
    await press('Temperature unit', '°F'); await press('Wind unit', 'knots'); await press('Pressure unit', 'inHg'); await press('Distance unit', 'miles');
    await press('Clock format', '24-hour'); await press('Theme', 'Black'); await press('Density', 'Compact'); await press('Weather effects', 'Lite'); await press('Advisor profile', 'Sensitive');
    await page.locator('.swatch-btn').nth(2).click();
    await page.locator('.set-sections li', { hasText: 'Sun tracker' }).locator('input').uncheck();
    for (let k = 0; k < 3; k++) await page.locator('.set-sections li', { hasText: 'Cyclone tracker' }).locator('button[aria-label^="Move"][aria-label$="up"]').click();
    await page.locator('.set-chip', { hasText: 'Moon' }).locator('input').uncheck();
    await page.screenshot({ path: join(OUT, `interact-${vp}-settings2.png`) });
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    if (await page.locator('#settingsSheet:not([hidden])').count()) fail('Escape did not close settings');
    if (vp === 'phone') {
      if (await page.locator('#tabbar button[data-tab="sun"]').isVisible()) fail('Sun tab still visible after hiding the sun tracker');
      for (const tab of ['now', 'forecast', 'storms']) { await page.locator(`#tabbar button[data-tab="${tab}"]`).click(); await page.waitForTimeout(600); await page.screenshot({ path: join(OUT, `interact-${vp}-custom-${tab}.png`), fullPage: true }); }
    } else await page.screenshot({ path: join(OUT, `interact-${vp}-custom.png`), fullPage: true });
    const txt = await page.locator('#tiles').textContent();
    if (!/°/.test(txt) || /km\/h/.test(await page.locator('#pulseCard').textContent())) fail('unit change not applied everywhere (km/h still in Pulse card)');
    if (/Moon/.test(txt)) fail('hidden tile still shown');
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('skypulse.settings')));
    if (prefs.temp !== 'F' || prefs.theme !== 'oled' || !prefs.hidden.includes('sun')) fail('settings not persisted: ' + JSON.stringify(prefs));
    // reload keeps the customisation
    await page.reload(); await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false', null, { timeout: 15000 });
    if (!(await page.evaluate(() => document.body.classList.contains('theme-oled')))) fail('theme not restored after reload');
    // offline: age the saved copy past its TTL and make the forecast API fail → stale copy, no error gate
    await page.evaluate(() => { const k = 'skypulse.wxc.idx'; const idx = JSON.parse(localStorage.getItem(k)); idx.forEach((e) => { e.at -= 3 * 3600e3; }); localStorage.setItem(k, JSON.stringify(idx)); });
    await ctx.unroute('**/*');
    await ctx.route('**/*', (r) => { const u = new URL(r.request().url()); if (u.host.startsWith('127.0.0.1')) return u.pathname.endsWith('tropical.json') ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(F.tropical('cyclone')) }) : r.continue(); return r.abort(); });
    await page.reload(); await page.waitForTimeout(9000);
    if ((await page.locator('#app').getAttribute('aria-busy')) !== 'false') fail('offline reload did not fall back to the saved copy');
    if (!/offline copy/.test(await page.locator('#updated').textContent())) fail('offline copy not labelled: ' + await page.locator('#updated').textContent());
    problems.filter((x) => !/ERR_FAILED|net::/.test(x)).forEach(fail);
    await ctx.close();
  }
  // Open-Meteo rejects the 15-minute step parameters → the app retries with the plain request
  {
    console.log('▶ HTTP 400 fallback');
    const hits = {}; const sc = SCENARIOS[1];
    const { ctx, page, problems } = await newPage(browser, sc, 'desktop', hits);
    await ctx.route(/api\.open-meteo\.com\/v1\/forecast/, (r) => (r.request().url().includes('forecast_minutely_15') ? r.fulfill({ status: 400, contentType: 'application/json', body: '{"error":true,"reason":"test"}' }) : r.fallback()));
    await page.goto(BASE);
    await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false', null, { timeout: 15000 }).catch(() => fail('400 fallback never loaded'));
    if (!hits.lastForecastURL || hits.lastForecastURL.includes('forecast_minutely_15')) fail('fallback request not made');
    problems.filter((x) => !/400/.test(x)).forEach(fail);
    await ctx.close();
  }
}
await browser.close();
server.kill();
console.log(failures ? `\n${failures} problem(s)` : '\nall clear');
process.exit(failures ? 1 : 0);
