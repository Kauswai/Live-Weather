// Checks the sun-year markers (LiveWeather/sun.js → Solar.year) at polar, near-circle, tropical and mid latitudes.
// Run with: node tests/sun.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const sandbox = { window: {} };
vm.runInNewContext(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'LiveWeather', 'sun.js'), 'utf8'), sandbox);
const { Solar } = sandbox.window;
const DAY = 86400e3, yr = 2026, jan1 = Date.UTC(yr, 0, 1), nDays = 365;
const md = (k) => new Date(jan1 + k * DAY).toISOString().slice(5, 10);

let failed = 0;
function check(name, lat, lon, off, expect) {
  const y = Solar.year(jan1, nDays, lat, lon, off);
  const blue = y.dayMarks.map((k) => `${md(k)}(${y.dl[k].toFixed(1)}h)`).join(' ');
  const yellow = y.elMarks.map((m) => `${m.max ? '▲' : '▼'}${md(m.k)}(${y.el[m.k].toFixed(1)}°)${m.big ? '*' : ''}`).join(' ');
  const problems = [];
  if (expect.blue != null && y.dayMarks.length !== expect.blue) problems.push(`expected ${expect.blue} blue, got ${y.dayMarks.length}`);
  if (expect.max != null && y.elMarks.filter((m) => m.max).length !== expect.max) problems.push(`expected ${expect.max} maxima`);
  if (expect.min != null && y.elMarks.filter((m) => !m.max).length !== expect.min) problems.push(`expected ${expect.min} minima`);
  if (y.elMarks.filter((m) => m.big).length !== Math.min(2, y.elMarks.length)) problems.push('expected one large max and one large min');
  if (expect.sun && !y.sunSpan) problems.push('no midnight-sun period');
  if (expect.night && !y.nightSpan) problems.push('no polar-night period');
  if (expect.check) { const m = expect.check(y); if (m) problems.push(m); }
  failed += problems.length ? 1 : 0;
  console.log(`${problems.length ? '✗' : '✓'} ${name} (${lat}°)\n    blue  ${blue}\n    yellow ${yellow}${y.sunSpan ? `\n    midnight sun ${md(y.sunSpan[0])}→${md(y.sunSpan[1])}` : ''}${y.nightSpan ? `  polar night ${md(y.nightSpan[0])}→${md(y.nightSpan[1])}` : ''}${problems.length ? '\n    ' + problems.join('; ') : ''}`);
}

// Arctic: midnight sun (May–Jul) and polar night (Dec → Jan, split by New Year): four blue markers
check('Kiruna area (screenshot place)', 67.54, 20.2, 3600e3, { blue: 4, max: 1, min: 1, sun: true, night: true });
check('Longyearbyen', 78.22, 15.65, 3600e3, { blue: 4, max: 1, min: 1, sun: true, night: true });
// just north of the Arctic Circle: a short midnight sun, no true polar night (refraction) → start/end + shortest day
check('Rovaniemi', 66.5, 25.7, 7200e3, { max: 1, min: 1, sun: true, check: (y) => (y.dayMarks.length >= 2 && y.dayMarks.length <= 3 ? '' : 'expected 2–3 blue markers') });
// Antarctic: midnight sun spans New Year, polar night in winter
check('McMurdo', -77.85, 166.67, 46800e3, { blue: 4, max: 1, min: 1, sun: true, night: true });
// tropics: two zenith passages (90°) and two solstice lows; the higher zenith and the lower low are large
check('Quito', -0.18, -78.47, -18000e3, { blue: 2, max: 2, min: 2, check: (y) => (y.elMarks.filter((m) => m.max).every((m) => y.el[m.k] === 90) ? '' : 'zeniths should be 90°') });
check('Mumbai', 19.08, 72.88, 19800e3, { blue: 2, max: 2, min: 2, check: (y) => { const lows = y.elMarks.filter((m) => !m.max); const big = lows.find((m) => m.big); return big && md(big.k).startsWith('12') ? '' : 'the December low should be the large one'; } });
check('Singapore', 1.35, 103.82, 28800e3, { blue: 2, max: 2, min: 2 });
// mid-latitudes: one high, one low
check('Sydney', -33.87, 151.21, 39600e3, { blue: 2, max: 1, min: 1 });
check('Delhi', 28.61, 77.21, 19800e3, { blue: 2, max: 1, min: 1 });

console.log(failed ? `\n${failed} place(s) failed` : '\nall sun-year checks passed');
process.exit(failed ? 1 : 0);
