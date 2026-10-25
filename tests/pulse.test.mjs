// Unit checks for the Pulse Advisor decision logic (LiveWeather/pulse.js), run with: node tests/pulse.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'LiveWeather', 'pulse.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const { Pulse } = sandbox.window;
Pulse.init({
  fmtHM: (t) => new Date(t).toISOString().slice(11, 16), fT: (c) => Math.round(c) + '°', fW: (k) => String(Math.round(k)), wU: () => 'km/h',
  fP: (mm) => mm.toFixed(1), pU: () => 'mm', fV: (m) => (m / 1000).toFixed(1) + ' km', dur: (ms) => Math.round(ms / 60e3) + ' min', cond: () => 'Rain',
});

const HOUR = 3600e3, now = Date.UTC(2026, 9, 25, 12);
/** 24 hourly steps from the current hour; f(h) returns overrides for hour h */
function data(f = () => ({}), cur = {}) {
  const H = { time: [], t: [], at: [], pp: [], pr: [], wc: [], wg: [], ws: [], vis: [], uv: [], day: [] };
  for (let h = 0; h < 30; h++) {
    const v = { t: 18, at: 18, pp: 5, pr: 0, wc: 1, wg: 15, ws: 8, vis: 20000, uv: 3, day: 1, ...f(h) };
    H.time.push(now + h * HOUR); Object.keys(v).forEach((k) => H[k].push(v[k]));
  }
  return { H, M: null, cur: { t: 18, at: 18, pr: 0, wc: 1, wg: 15, ws: 8, ...cur } };
}
const run = (t, extra = {}) => Pulse.compute({ t, now: now + 60e3, win: 6, thr: 40, profile: 'standard', hz: null, aq: { us_aqi: 30 }, ...extra });

let failed = 0;
function check(name, out, level, verdictRe) {
  const ok = out.level === level && verdictRe.test(out.verdict);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}: level ${out.level} · ${out.verdict}${ok ? '' : `   (expected ${level}, ${verdictRe})`}`);
}

check('calm', run(data()), 0, /No umbrella/);
check('small rain risk', run(data((h) => (h === 3 ? { pp: 30 } : {}))), 1, /compact umbrella/);
check('rain likely', run(data((h) => (h >= 2 ? { pp: 80, pr: 1.2, wc: 61 } : {}))), 2, /Take an umbrella/);
check('raining now', run(data((h) => ({ pp: 90, pr: 1.5, wc: 63 }), { pr: 1.5, wc: 63 })), 2, /Umbrella needed now/);
check('windy rain', run(data((h) => (h >= 2 ? { pp: 80, pr: 1.2, wc: 61, wg: 66 } : {}))), 2, /Rain jacket, not an umbrella/);
check('downpours', run(data((h) => (h === 2 ? { pp: 90, pr: 25, wc: 65 } : {}))), 3, /Downpours/);
check('torrential', run(data((h) => (h === 2 ? { pp: 95, pr: 60, wc: 65 } : {}))), 4, /Torrential/);
check('thunder', run(data((h) => (h === 3 ? { pp: 70, pr: 3, wc: 95 } : {}))), 3, /Thunderstorms/);
check('hail', run(data((h) => (h === 3 ? { pp: 70, pr: 3, wc: 96 } : {}))), 4, /Hail/);
check('freezing rain', run(data((h) => (h === 1 ? { pp: 70, pr: 1, wc: 66, t: -1, at: -4 } : {}))), 4, /Freezing rain/);
check('damaging gusts', run(data((h) => (h === 4 ? { wg: 95 } : {}))), 4, /Damaging winds/);
check('destructive gusts', run(data((h) => (h === 4 ? { wg: 125 } : {}))), 5, /Stay indoors/);
check('extreme heat', run(data(() => ({ at: 47 }))), 4, /Extreme heat/);
check('heat, sensitive profile', run(data(() => ({ at: 37 })), { profile: 'sensitive' }), 3, /Very hot/);
check('heat, hardy profile', run(data(() => ({ at: 37 })), { profile: 'hardy' }), 1, /Warm/);
check('bitter cold', run(data(() => ({ at: -22, t: -15 })), { win: 6 }), 3, /Bitter cold/);
check('dense fog', run(data((h) => (h === 2 ? { vis: 150 } : {}))), 3, /Dense fog/);
check('unhealthy air', run(data(), { aq: { us_aqi: 170 } }), 2, /Unhealthy air/);
const tcHz = { tcWindowKt: () => 45, threat: { level: 'direct', s: { name: 'Kirk', classText: 'Hurricane' } }, warnings: [] };
check('cyclone winds', run(data(), { hz: tcHz }), 5, /Stay indoors — cyclone winds/);
const red = { warnings: [{ source: 'official', level: 'red', title: 'Tornado Warning', agency: 'NWS', start: now - HOUR, end: now + 2 * HOUR, kind: 'official' }], tcWindowKt: () => 0 };
check('official red warning', run(data(), { hz: red }), 5, /follow official advice/);
const orangeHeat = { warnings: [{ source: 'official', level: 'orange', title: 'Heat Wave', agency: 'IMD', start: now - HOUR, end: now + 9 * HOUR, kind: 'official' }], tcWindowKt: () => 0 };
const merged = run(data(() => ({ at: 47 })), { hz: orangeHeat });
check('official + same-level hazard → specific advice', merged, 4, /Extreme heat/);
if (!/Official warning in force — IMD: Heat Wave/.test(merged.detail)) { failed++; console.log('✗ merged detail does not cite the official warning: ' + merged.detail); }
const future = { warnings: [{ source: 'official', level: 'red', title: 'Later warning', agency: 'NWS', start: now + 20 * HOUR, end: now + 30 * HOUR, kind: 'official' }], tcWindowKt: () => 0 };
check('warning outside the window is ignored', run(data(), { hz: future }), 0, /No umbrella/);
const sunGear = run(data(() => ({ uv: 9 })));
if (!sunGear.gear.some((g) => g.label === 'Sunscreen')) { failed++; console.log('✗ strong UV should suggest sunscreen'); }
const stormGear = run(data(() => ({ uv: 9, pp: 90, pr: 30, wc: 65 })));
if (stormGear.gear.some((g) => g.label === 'Sunscreen')) { failed++; console.log('✗ no sunscreen in a downpour'); }

console.log(failed ? `\n${failed} failure(s)` : '\nall Pulse checks passed');
process.exit(failed ? 1 : 0);
