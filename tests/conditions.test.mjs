// Checks when the condition label becomes "Stormy" (LiveWeather/icons.js → WX.stormy).
// Run with: node tests/conditions.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const sandbox = { window: {} };
vm.runInNewContext(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'LiveWeather', 'icons.js'), 'utf8'), sandbox);
const { stormy } = sandbox.window.WX;

let failed = 0;
function check(name, input, label, why) {
  const r = stormy(input);
  const ok = label === null ? r === null : r && r.label === label && (!why || r.why === why);
  failed += ok ? 0 : 1;
  console.log(`${ok ? '✓' : '✗'} ${name}: ${r ? `${r.label} (${r.why})` : 'no change'}${ok ? '' : ` — expected ${label}${why ? ` (${why})` : ''}`}`);
}

// km/h, mm/h, hPa; tcKt in knots
check('ordinary showers', { wc: 80, ws: 20, wg: 40, pr: 2 }, null);
check('breezy rain stays rain', { wc: 63, ws: 38, wg: 68, pr: 3 }, null);
check('showers with damaging gusts', { wc: 81, ws: 35, wg: 80, pr: 4 }, 'Stormy', 'wind');
check('rain with near-gale winds', { wc: 61, ws: 52, wg: 70, pr: 1 }, 'Stormy', 'wind');
check('overcast gale, no rain yet', { wc: 3, ws: 65, wg: 85 }, 'Stormy', 'wind');
check('deep extratropical low', { wc: 61, ws: 42, wg: 60, pr: 1, ps: 978 }, 'Stormy', 'low');
check('snow in a gale', { wc: 73, ws: 55, wg: 80 }, 'Snowstorm', 'wind');
check('cyclone winds here', { wc: 80, ws: 30, wg: 50, pr: 2, tcKt: 40 }, 'Stormy', 'tc');
check('cyclone rain bands', { wc: 80, ws: 25, wg: 45, pr: 3, tcNear: true }, 'Stormy', 'tc-bands');
check('cyclone nearby but dry', { wc: 2, ws: 20, wg: 35, tcNear: true }, null);
check('tornado / severe-storm warning in force', { wc: 95, ws: 20, wg: 45, pr: 5, warn: true }, 'Stormy', 'warning');
check('warning under a mostly clear sky', { wc: 1, ws: 15, wg: 30, warn: true }, null);
check('hurricane warning ahead of the storm, calm overcast', { wc: 3, ws: 18, wg: 30, warn: true }, null);
check('high-wind warning, overcast and windy', { wc: 3, ws: 45, wg: 70, warn: true }, 'Stormy', 'warning');
check('plain thunderstorm', { wc: 95, ws: 20, wg: 50, pr: 6 }, null);
check('severe thunderstorm gusts', { wc: 96, ws: 30, wg: 85, pr: 20 }, 'Stormy', 'wind');
check('dry, clear gale', { wc: 0, ws: 66, wg: 95 }, 'Gale-force winds');
check('clear but very gusty', { wc: 1, ws: 40, wg: 92 }, 'Very windy');

console.log(failed ? `\n${failed} failure(s)` : '\nall condition checks passed');
process.exit(failed ? 1 : 0);
