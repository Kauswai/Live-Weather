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

// cond: the expected condition label, or a pattern it must not match
const SCENARIOS = [
  { name: 'nyc-calm', place: 'nyc', wx: 'calm', cond: /^(?!Stormy)/ },
  { name: 'berlin-rain', place: 'berlin', wx: 'rain', cond: /^(?!Stormy)/ },
  { name: 'miami-cyclone', place: 'miami', wx: 'cyclone', cond: /^Stormy$/ },
  { name: 'delhi-heat', place: 'delhi', wx: 'heat', cond: /^(?!Stormy)/ },
  { name: 'tokyo-storm', place: 'tokyo', wx: 'storm', cond: /^(?!Stormy)/ },
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
      if (u.pathname.endsWith('/data/tropical.json')) return json(F.tropical(sc.tc || sc.wx));
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

async function newPage(browser, sc, vp, hits, state, extra = {}) {
  const place = F.PLACES[sc.place];
  const ctx = await browser.newContext({ ...VIEWPORTS[vp], geolocation: { latitude: place.lat, longitude: place.lon, accuracy: 12 }, permissions: ['geolocation'],
    ...(state ? { storageState: state } : {}), serviceWorkers: 'block', ...extra });
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
    const condTxt = await page.locator('#heroCond').textContent();
    if (!sc.cond.test(condTxt)) fail(`condition shown as "${condTxt}"`);
    if (sc.wx === 'storm' && !(await page.locator('#hourly .hour.stormy').count())) fail('severe-thunderstorm hours not marked stormy');
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
    if (/Kirk/.test(title) || !/Zelia|Kong|Lane|Dana/.test(title)) fail('selecting a storm did not update the detail card: ' + title);
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

// ------------------------------------------------------------------ resilience
if (!ONLY || ONLY === 'resilience') {
  const sc = SCENARIOS[1];
  const ready = (page) => page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false', null, { timeout: 15000 }).then(() => true, () => false);
  // one section throwing must not stop the page from loading
  {
    console.log('▶ a section fails to draw');
    const { ctx, page } = await newPage(browser, sc, 'desktop', {});
    await ctx.addInitScript(() => { let wx; Object.defineProperty(window, 'WX', { configurable: true, get: () => wx, set: (v) => { v.pulseSVG = () => { throw new Error('injected'); }; wx = v; } }); });
    await page.goto(BASE);
    if (!(await ready(page))) fail('page did not load when one section threw');
    if (!(await page.waitForFunction(() => document.querySelector('#gate').hidden, null, { timeout: 3000 }).then(() => true, () => false))) fail('location gate still covers the page');
    if (!/Couldn't draw the Pulse Advisor/.test(await page.locator('#feed').textContent())) fail('section failure not reported in the feed');
    await ctx.close();
  }
  // a start-up crash shows the error instead of an endless spinner
  {
    console.log('▶ start-up crash is reported on screen');
    const { ctx, page } = await newPage(browser, sc, 'desktop', {});
    await ctx.route(/\/app\.js/, async (r) => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()).replace("'use strict';", "'use strict'; throw new Error('injected start-up failure');") }); });
    await page.goto(BASE); await page.waitForTimeout(1500);
    if (!/problem while starting/.test(await page.locator('#gateTitle').textContent())) fail('start-up crash not shown');
    if (!/injected start-up failure/.test(await page.locator('#gateErr').textContent())) fail('start-up error details missing');
    await ctx.close();
  }
  // just after a deploy, a page cached from the previous release loads this release's scripts: it reloads itself once
  {
    console.log('▶ stale cached page after a deploy');
    const { ctx, page } = await newPage(browser, sc, 'desktop', {});
    const OLD_PAGE = '<!doctype html><meta charset="utf-8"><div id="app" aria-busy="true"><h1 id="placeName"></h1></div><script src="icons.js"></script><script src="hazards.js"></script><script src="app.js"></script>';
    let served = 0;
    await ctx.route(new RegExp(`127\\.0\\.0\\.1:${PORT}/(index\\.html)?$`), (r) => (served++ ? r.fallback() : r.fulfill({ status: 200, contentType: 'text/html', body: OLD_PAGE })));
    await page.goto(BASE);
    if (!(await ready(page))) fail('stale page did not reload into the current release');
    if (served < 2) fail('stale page was not reloaded');
    if (!(await page.locator('#pulseCard').count())) fail('current page not shown after the reload');
    await ctx.close();
  }
  // coarse PC positioning flipping between two fixes inside its accuracy must not count as moving
  {
    console.log('▶ jittery desktop location');
    const hits = {}; const place = F.PLACES[sc.place];
    const { ctx, page, problems } = await newPage(browser, sc, 'desktop', hits);
    await ctx.setGeolocation({ latitude: place.lat, longitude: place.lon, accuracy: 20000 });
    await page.goto(BASE);
    await ready(page);
    for (let k = 0; k < 30; k++) { await ctx.setGeolocation({ latitude: place.lat + (k % 2) * 0.055, longitude: place.lon, accuracy: 20000 }); await page.waitForTimeout(100); }
    const moves = await page.locator('#feed li', { hasText: 'You moved' }).count();
    if (moves) fail(`location jitter counted as ${moves} move(s)`);
    await ctx.setGeolocation({ latitude: place.lat + 0.2, longitude: place.lon, accuracy: 30 }); await page.waitForTimeout(800);
    if (!(await page.locator('#feed li', { hasText: /moved|refined/ }).count())) fail('a precise fix 22 km away was ignored');
    problems.forEach(fail);
    await ctx.close();
  }
  // a storm rated Red by GDACS for the whole country, passing ~450 km away without gales here, is not "dangerous weather" here;
  // an alert for other districts of the state counts as an advisory at most
  {
    console.log('▶ distant cyclone with a country-wide Red rating');
    const far = { name: 'medchal-bay', place: 'medchal', wx: 'calm', tc: 'bay' };
    const { ctx, page, problems } = await newPage(browser, far, 'desktop', {});
    await page.goto(BASE);
    await ready(page);
    await page.waitForFunction(() => /GDACS/.test(document.querySelector('#warnList')?.textContent || ''), null, { timeout: 8000 }).catch(() => fail('GDACS rating not listed'));
    const lvl = parseInt(await page.locator('#pulseLevel').textContent(), 10);
    if (!(lvl <= 2)) fail(`Pulse level ${lvl}/5 for a storm ~450 km away: ${await page.locator('#pulseVerdict').textContent()}`);
    if (/Dangerous weather/.test(await page.locator('#pulseCard').textContent())) fail('distant storm reported as dangerous weather');
    if (/Stormy/.test(await page.locator('#heroCond').textContent())) fail('a dry day ~450 km from a cyclone shown as stormy');
    if (!(await page.locator('#warnList .warn.lv-info', { hasText: 'GDACS Red alert for Dana (whole storm)' }).count())) fail('GDACS rating not shown as storm-wide information');
    if (!(await page.locator('#warnList .warn', { hasText: 'Heavy Rain (in your state)' }).count())) fail('state alert not listed');
    await page.screenshot({ path: join(OUT, 'distant-cyclone.png'), fullPage: false });
    problems.forEach(fail);
    await ctx.close();
  }
  // research stations in search; Antarctic places labelled "Antarctica"; a page at the South Pole
  {
    console.log('▶ research stations in search');
    const hits = {};
    const { ctx, page, problems } = await newPage(browser, sc, 'desktop', hits);
    await page.goto(BASE); await ready(page);
    const find = async (q) => { await page.locator('#searchInput').fill(q); await page.waitForTimeout(700); return page.locator('#searchResults li').allTextContents(); };
    let rows = await find('esperanza');
    if (!rows.some((t) => /Esperanza Base.*Argentine station, Antarctica/.test(t))) fail('Esperanza Base not found: ' + JSON.stringify(rows));
    if (!/Esperanza.*Mexico/.test(rows[0] || '')) fail('exact-name town should stay first: ' + JSON.stringify(rows));
    rows = await find('vostok');
    if (rows.filter((t) => /Vostok/.test(t)).length !== 1 || !/Vostok Station.*Antarctica/.test(rows[0])) fail('Vostok should appear once, labelled Antarctica: ' + JSON.stringify(rows));
    rows = await find('mount erebus');
    if (!rows.some((t) => /Mount Erebus\s*Antarctica$/.test(t))) fail('GeoNames Antarctic place without a country not labelled: ' + JSON.stringify(rows));
    rows = await find('south pole');
    if (!/Amundsen–Scott South Pole Station/.test(rows[0] || '')) fail('South Pole station not found: ' + JSON.stringify(rows));
    await page.locator('#searchResults li').first().dispatchEvent('mousedown');
    await page.waitForFunction(() => /Amundsen/.test(document.querySelector('#placeName').textContent), null, { timeout: 8000 }).catch(() => fail('South Pole not loaded'));
    await page.waitForTimeout(1500);
    if (!/United States station, Antarctica/.test(await page.locator('#placeSub').textContent())) fail('hero sub-line missing Antarctica: ' + await page.locator('#placeSub').textContent());
    if (!/latitude=-89\.99/.test(hits.lastForecastURL || '')) fail('forecast not requested for the pole: ' + hits.lastForecastURL);
    await page.screenshot({ path: join(OUT, 'south-pole.png'), fullPage: true });
    problems.forEach(fail);
    await ctx.close();
  }
  // a saved GPS fix is reused at launch: no permission prompt unless the browser already allows location
  {
    console.log('▶ saved location on launch');
    const place = F.PLACES[sc.place];
    const seed = (ctx) => ctx.addInitScript((fix) => {
      window.__geo = 0;
      const g = navigator.geolocation, w = g.watchPosition.bind(g), c = g.getCurrentPosition.bind(g);
      g.watchPosition = (...a) => { window.__geo++; return w(...a); };
      g.getCurrentPosition = (...a) => { window.__geo++; return c(...a); };
      if (!localStorage.getItem('skypulse.lastGps')) localStorage.setItem('skypulse.lastGps', JSON.stringify(fix));
    }, { lat: place.lat, lon: place.lon, acc: 15, at: Date.now() - 2 * 3600e3, name: place.city });
    {
      const { ctx, page, problems } = await newPage(browser, sc, 'desktop', {}, null, { permissions: [] });
      await seed(ctx); await page.goto(BASE);
      if (!(await ready(page))) fail('saved-location launch never loaded');
      if (await page.evaluate(() => window.__geo)) fail('asked for the location although a saved fix exists');
      if (!/Saved location · 2 h ago/.test(await page.locator('#liveText').textContent())) fail('status does not say the saved location is used: ' + await page.locator('#liveText').textContent());
      if ((await page.locator('#placeName').textContent()) !== place.city) fail('saved place name not shown');
      await page.locator('#locateBtn').click(); await page.waitForTimeout(400);
      if (!(await page.evaluate(() => window.__geo))) fail('Live GPS button did not ask for the location');
      problems.forEach(fail);
      await ctx.close();
    }
    {
      const { ctx, page, problems } = await newPage(browser, sc, 'desktop', {});
      await seed(ctx); await page.goto(BASE);
      await ready(page);
      if (!(await page.evaluate(() => window.__geo))) fail('location already allowed, but live GPS was not started');
      if (!/Live · GPS/.test(await page.locator('#liveText').textContent())) fail('not live with location allowed');
      const fix = await page.evaluate(() => JSON.parse(localStorage.getItem('skypulse.lastGps')));
      if (!fix || fix.lat !== +place.lat.toFixed(3) || Date.now() - fix.at > 60e3) fail('new GPS fix not saved (rounded): ' + JSON.stringify(fix));
      problems.forEach(fail);
      await ctx.close();
    }
  }
}
await browser.close();
server.kill();
console.log(failures ? `\n${failures} problem(s)` : '\nall clear');
process.exit(failures ? 1 : 0);
