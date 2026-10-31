// Checks the lunar maths (LiveWeather/moon.js → Lunar) against known events.
// Run with: node tests/moon.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'LiveWeather');
const sandbox = { window: {} };
for (const f of ['sun.js', 'moon.js']) vm.runInNewContext(readFileSync(join(dir, f), 'utf8'), sandbox);
const { Lunar, Solar } = sandbox.window;
const MIN = 60e3, DAY = 86400e3;
const at = (iso) => Date.parse(iso);

let failed = 0;
function check(name, ok, detail) { failed += ok ? 0 : 1; console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); }

// 1. total solar eclipses: from inside the path of totality the Moon covers the Sun (topocentric positions agree)
for (const [where, lat, lon, iso] of [['Dallas, 8 Apr 2024', 32.78, -96.80, '2024-04-08T18:42:30Z'], ['Nashville, 21 Aug 2017', 36.16, -86.78, '2017-08-21T18:28:30Z']]) {
  const m = Lunar.position(at(iso), lat, lon), s = Solar.position(at(iso), lat, lon);
  const sep = Math.hypot(m.alt - s.el, (m.az - s.az) * Math.cos(s.el * Math.PI / 180));
  check(`eclipse: Moon on the Sun at ${where}`, sep < 0.25, `separation ${sep.toFixed(3)}° (Moon ${m.alt.toFixed(2)}°/${m.az.toFixed(2)}°, Sun ${s.el.toFixed(2)}°/${s.az.toFixed(2)}°)`);
  check(`eclipse: new Moon dark at ${where}`, m.illum < 0.001, `lit ${(m.illum * 100).toFixed(2)}%`);
}

// 2. principal phases (published times, UTC)
for (const [label, from, k, iso] of [
  ['new moon 8 Apr 2024 18:21', '2024-04-01', 0, '2024-04-08T18:21Z'],
  ['full moon 18 Sep 2024 02:34 (supermoon)', '2024-09-10', 2, '2024-09-18T02:34Z'],
  ['full moon 14 Mar 2025 06:55 (eclipse)', '2025-03-08', 2, '2025-03-14T06:55Z'],
  ['new moon 29 Jan 2025 12:36', '2025-01-20', 0, '2025-01-29T12:36Z'],
  ['first quarter 5 Feb 2025 08:02', '2025-01-30', 1, '2025-02-05T08:02Z'],
]) {
  const p = Lunar.phases(at(from), 8).find((x) => x.k === k);
  const err = p ? (p.t - at(iso)) / MIN : NaN;
  check(label, Math.abs(err) <= 3, p ? `got ${new Date(p.t).toISOString().slice(0, 16)}Z (${err >= 0 ? '+' : ''}${err.toFixed(1)} min)` : 'not found');
}
const sept = Lunar.phases(at('2024-09-10'), 8).find((x) => x.k === 2);
check('supermoon distance (Sep 2024 ≈ 357,500 km)', Math.abs(sept.dist - 357500) < 1500, `${Math.round(sept.dist).toLocaleString()} km`);
const ph = Lunar.phases(at('2025-01-01'), 12);
check('phases come in order, a week apart', ph.every((p, i) => !i || (p.k === (ph[i - 1].k + 1) % 4 && p.t - ph[i - 1].t > 5.5 * DAY && p.t - ph[i - 1].t < 8.5 * DAY)), ph.map((p) => p.name[0] + p.name.split(' ')[1][0]).join(' '));

// 3. full moon is fully lit and opposite the Sun
const full = Lunar.position(at('2025-03-14T06:55Z'), 0, 0);
check('full moon lit', full.illum > 0.995 && Math.abs(full.elong - 180) < 1.5, `${(full.illum * 100).toFixed(2)}%, elongation ${full.elong.toFixed(1)}°`);
check('phase names', Lunar.phaseName(2) === 'New moon' && Lunar.phaseName(45) === 'Waxing crescent' && Lunar.phaseName(181) === 'Full moon' && Lunar.phaseName(300) === 'Waning crescent');

// 4. rise/set: at the computed times the upper limb is on the horizon; transit is the day's highest point
for (const [where, lat, lon, off, day] of [['London', 51.5, -0.12, 0, '2025-06-10'], ['Mumbai', 19.08, 72.88, 19800e3, '2025-11-02'], ['Sydney', -33.87, 151.21, 39600e3, '2026-01-15']]) {
  const mid = at(day + 'T00:00:00Z'), t = Lunar.times(mid, lat, lon, off);
  const lim = (x) => { const p = Lunar.position(x, lat, lon); return p.geo + 0.5667 + p.diam / 120; };
  const okRise = t.rise == null || Math.abs(lim(t.rise)) < 0.02, okSet = t.set == null || Math.abs(lim(t.set)) < 0.02;
  let higher = false;
  for (let x = mid - off; x < mid - off + DAY; x += 5 * MIN) if (Lunar.position(x, lat, lon).alt > t.transitAlt + 0.01) higher = true;
  check(`rise/set/transit at ${where} ${day}`, okRise && okSet && !higher && (t.rise != null || t.set != null),
    `rise ${t.rise ? new Date(t.rise + off).toISOString().slice(11, 16) : '—'} · set ${t.set ? new Date(t.set + off).toISOString().slice(11, 16) : '—'} · highest ${t.transitAlt.toFixed(1)}° (local)`);
}
// polar: the Moon can stay up or down all day
const polar = [...Array(30)].map((_, k) => Lunar.times(at('2025-01-01T00:00:00Z') + k * DAY, 78.2, 15.6, 3600e3));
check('Svalbard: Moon up all day and down all day within a month', polar.some((t) => t.alwaysUp) && polar.some((t) => t.alwaysDown));

console.log(failed ? `\n${failed} failure(s)` : '\nall Moon checks passed');
process.exit(failed ? 1 : 0);
