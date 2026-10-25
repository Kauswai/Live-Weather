/* SkyPulse on-device weather cache.
 *
 * Each place's last forecast (+ air quality and place name) is kept in localStorage under its own key, with a
 * small index for lookups. Lookups match the nearest saved place within a radius, so a GPS fix that drifts a
 * few hundred metres still reuses it. At most MAX places are kept (least recently fetched dropped first) and
 * entries older than KEEP_MS are purged; a stale entry is only ever used as an offline fallback.
 */
(function () {
  'use strict';
  const IDX = 'skypulse.wxc.idx', PRE = 'skypulse.wxc.';
  const MAX = 8, KEEP_MS = 24 * 3600e3, PLACE_MS = 30 * 86400e3;
  const RAD = Math.PI / 180;
  const km = (a, b, c, d) => {
    const h = Math.sin(((c - a) * RAD) / 2) ** 2 + Math.cos(a * RAD) * Math.cos(c * RAD) * Math.sin(((d - b) * RAD) / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const idOf = (lat, lon) => `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const ls = {
    get(k) { try { const v = localStorage.getItem(k); return v == null ? null : JSON.parse(v); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
  };
  const index = () => { const v = ls.get(IDX); return Array.isArray(v) ? v.filter((e) => e && typeof e.id === 'string' && Number.isFinite(e.at)) : []; };

  function prune(list) {
    const now = Date.now();
    const keep = list.filter((e) => now - e.at < KEEP_MS).sort((a, b) => b.at - a.at).slice(0, MAX);
    list.filter((e) => !keep.includes(e)).forEach((e) => ls.del(PRE + e.id));
    return keep;
  }
  function nearest(lat, lon, maxKm, test = () => true) {
    let best = null, bd = Infinity;
    for (const e of index()) { const d = km(lat, lon, e.lat, e.lon); if (d <= maxKm && d < bd && test(e)) { bd = d; best = e; } }
    return best;
  }

  const WxCache = {
    /** freshest-matching saved forecast near a point: { at, kind, fc, aq, place } or null */
    get(lat, lon, { kind = null, maxKm = 1.5 } = {}) {
      const e = nearest(lat, lon, maxKm, (x) => kind == null || x.kind === kind);
      if (!e) return null;
      const body = ls.get(PRE + e.id);
      return body && body.fc ? { ...body, at: e.at, kind: e.kind } : null;
    },
    /** a saved place name near a point, whatever the age of its forecast */
    place(lat, lon, maxKm = 1) {
      const e = nearest(lat, lon, maxKm, (x) => x.place && Date.now() - x.at < PLACE_MS);
      return e ? e.place : null;
    },
    put(lat, lon, kind, { fc, aq, place }) {
      const id = idOf(lat, lon), at = Date.now();
      const all = index();
      // a neighbour within 300 m is the same spot with a slightly different fix: replace it
      const twins = all.filter((e) => e.id !== id && km(lat, lon, e.lat, e.lon) <= 0.3);
      twins.forEach((e) => ls.del(PRE + e.id));
      let list = all.filter((e) => e.id !== id && !twins.includes(e));
      const meta = { id, lat: +lat.toFixed(3), lon: +lon.toFixed(3), kind, at, place: place ? { name: place.name, sub: place.sub, cc: place.cc, country: place.country, admins: place.admins } : null };
      list = prune([meta, ...list]);
      let ok = ls.set(PRE + id, { fc, aq });
      // storage full: drop the oldest places until it fits (or give up quietly)
      while (!ok && list.length > 1) { const old = list.pop(); ls.del(PRE + old.id); ok = ls.set(PRE + id, { fc, aq }); }
      if (!ok) { ls.del(PRE + id); list = list.filter((e) => e.id !== id); }
      ls.set(IDX, list);
      return ok;
    },
    clear() {
      index().forEach((e) => ls.del(PRE + e.id)); ls.del(IDX);
      try { Object.keys(localStorage).filter((k) => k.startsWith(PRE) || k === 'skypulse.coast').forEach((k) => localStorage.removeItem(k)); } catch { /* storage unavailable */ }
    },
    info() {
      const list = index(); let bytes = 0;
      try { list.forEach((e) => { bytes += (localStorage.getItem(PRE + e.id) || '').length; }); } catch { /* storage unavailable */ }
      return { places: list.length, kb: Math.round(bytes / 1024) };
    },
  };
  // drop expired entries once per load
  ls.set(IDX, prune(index()));
  window.WxCache = WxCache;
})();
