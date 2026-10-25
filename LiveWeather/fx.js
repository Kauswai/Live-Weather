/* SkyPulse weather effects — a single full-screen <canvas> particle system.
 *
 * Scenes: drizzle · rain (light / moderate) · heavy · storm (+hail) · cyclone · snow · fog · clouds · stars
 * Every drop has a depth z ∈ [0,1] that drives its length, speed, thickness and opacity (parallax),
 * drops are batched per depth layer into one path per frame, and the loop pauses when the tab is hidden.
 *
 * API: FX.set({ kind, intensity 0–1, windKmh, windFromDeg, isDay, hemisphere: 'N'|'S', stormBearing, quality: 'full'|'lite'|'off' })
 */
(function () {
  const canvas = document.getElementById('fx');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobile = window.matchMedia('(max-width: 760px)').matches;
  let W = 0, H = 0, DPR = 1;
  let cfg = { kind: 'none', intensity: 0, windKmh: 0, windFromDeg: 270, isDay: true, hemisphere: 'N', stormBearing: null, quality: 'full' };
  const qf = () => (cfg.quality === 'lite' ? 0.45 : 1);           // particle budget for the "Lite" effects setting
  let drops = [], splashes = [], flakes = [], hail = [], debris = [], spray = [], mist = [], fog = [], clouds = [], stars = [];
  let flash = 0, bolt = null, nextStrike = 0, distantFlash = null, raf = 0, last = 0, t = 0;
  let gust = 0, gustTarget = 0, spiral = null, spiralAngle = 0;
  const rnd = (a, b) => a + Math.random() * (b - a);

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    spiral = null;
    build();
  }

  /* ----- scene parameters ----- */
  function params() {
    const k = cfg.kind, i = Math.max(0.05, Math.min(1, cfg.intensity || 0.5));
    const area = (W * H) / (1440 * 900);
    const P = {
      drizzle: { n: 700 * i, len: [3, 8], spd: [3.2, 6.5], w: [0.55, 1.2], a: [0.22, 0.55], mist: 5, splash: 0 },
      rain:    { n: 170 + 330 * i, len: [9, 22], spd: [11, 19], w: [0.7, 1.5], a: [0.2, 0.5], mist: 2, splash: 0.25 * i },
      heavy:   { n: 900 + 450 * i, len: [18, 38], spd: [19, 30], w: [0.9, 2.0], a: [0.25, 0.6], mist: 3, splash: 0.9, sheets: true, dark: 0.16 },
      storm:   { n: 700 + 300 * i, len: [20, 40], spd: [20, 32], w: [0.9, 2.0], a: [0.25, 0.62], mist: 3, splash: 1, sheets: true, dark: 0.24, lightning: true },
      cyclone: { n: 1000 + 400 * i, len: [26, 56], spd: [24, 38], w: [0.8, 1.9], a: [0.2, 0.55], mist: 4, splash: 0.5, sheets: true, dark: 0.3, lightning: true, cyclone: true },
    }[k];
    if (P) P.n = Math.round(P.n * area * (mobile ? 0.55 : 1) * qf());
    return P;
  }

  /** horizontal drift per unit fall (screen slant) from wind */
  function slant() {
    const toward = ((cfg.windFromDeg ?? 270) + 180) * Math.PI / 180;
    const east = Math.sin(toward) * (cfg.windKmh || 0);
    let s = Math.max(-0.9, Math.min(0.9, east / 45));
    if (cfg.kind === 'cyclone') s = (Math.sign(east) || 1) * (1.1 + 0.9 * Math.min(1, (cfg.windKmh || 60) / 120));
    return s + gust * (cfg.kind === 'cyclone' ? 0.9 : 0.35) * (Math.sign(s) || 1);
  }

  function newDrop(P, anywhere) {
    const z = Math.random() ** 0.8;
    return {
      x: rnd(-W * 0.3, W * 1.3), y: anywhere ? rnd(-H, H) : rnd(-H * 0.3, -10), z,
      len: P.len[0] + (P.len[1] - P.len[0]) * z, spd: P.spd[0] + (P.spd[1] - P.spd[0]) * z * rnd(0.85, 1.15),
      land: H * (0.72 + 0.28 * z) + rnd(-20, 20),
    };
  }

  function build() {
    const P = params();
    drops = []; splashes = []; flakes = []; hail = []; debris = []; spray = []; mist = []; fog = []; clouds = []; stars = [];
    bolt = null; flash = 0; nextStrike = performance.now() + rnd(1500, 5000);
    if (P) {
      for (let n = 0; n < P.n; n++) drops.push(newDrop(P, true));
      for (let n = 0; n < P.mist; n++) mist.push({ x: rnd(0, W), y: rnd(H * 0.2, H), r: rnd(Math.max(W, H) * 0.25, Math.max(W, H) * 0.55), v: rnd(0.05, 0.25), a: cfg.kind === 'drizzle' ? rnd(0.05, 0.1) : rnd(0.03, 0.07) });
      if (P.cyclone) {
        for (let n = 0; n < (mobile ? 25 : 60) * qf(); n++) spray.push({ x: rnd(0, W), y: rnd(0, H), len: rnd(60, 200), spd: rnd(18, 34), a: rnd(0.04, 0.12) });
        for (let n = 0; n < (mobile ? 8 : 16); n++) debris.push(newDebris(true));
      }
      if (cfg.hail) for (let n = 0; n < (mobile ? 40 : 90); n++) hail.push({ x: rnd(0, W), y: rnd(-H, H), r: rnd(1.2, 2.8), vy: rnd(10, 18), vx: 0, bounced: false, land: H * rnd(0.75, 1) });
    }
    if (cfg.kind === 'snow') {
      const n = Math.round((120 + 380 * (cfg.intensity || 0.5)) * (W * H) / (1440 * 900) * (mobile ? 0.6 : 1) * qf());
      for (let k = 0; k < n; k++) flakes.push(newFlake(true));
    }
    if (cfg.kind === 'fog' || cfg.kind === 'drizzle') {
      for (let k = 0; k < (cfg.kind === 'fog' ? 7 : 3); k++) fog.push({ y: rnd(H * 0.15, H * 0.95), h: rnd(H * 0.12, H * 0.3), x: rnd(-W, W), v: rnd(0.08, 0.3), a: cfg.kind === 'fog' ? rnd(0.08, 0.16) : rnd(0.04, 0.07) });
    }
    if (cfg.kind === 'clouds' || cfg.kind === 'rain' || cfg.kind === 'drizzle') {
      for (let k = 0; k < (mobile ? 5 : 9); k++) clouds.push({ x: rnd(-W * 0.2, W), y: rnd(-H * 0.1, H * 0.45), r: rnd(120, 320), v: rnd(0.04, 0.18), a: rnd(0.04, cfg.kind === 'clouds' ? 0.09 : 0.06) });
    }
    if (cfg.kind === 'stars') {
      for (let k = 0; k < (mobile ? 70 : 140) * qf(); k++) stars.push({ x: rnd(0, W), y: rnd(0, H * 0.7), r: rnd(0.4, 1.4), p: rnd(0, Math.PI * 2), s: rnd(0.6, 2) });
    }
  }

  function newFlake(anywhere) {
    const z = Math.random();
    return { x: rnd(-50, W + 50), y: anywhere ? rnd(-H, H) : rnd(-60, -10), z, r: 0.8 + 2.6 * z, vy: 0.4 + 1.6 * z, ph: rnd(0, Math.PI * 2), sw: rnd(0.3, 1.4) };
  }
  function newDebris(anywhere) {
    const fromLeft = slant() > 0;
    return { x: anywhere ? rnd(0, W) : (fromLeft ? -30 : W + 30), y: rnd(0, H), vx: rnd(8, 18), vy: rnd(-2, 3), rot: rnd(0, 6.28), vr: rnd(-0.3, 0.3), s: rnd(3, 7), c: Math.random() < 0.6 ? 'rgba(120,150,80,.75)' : 'rgba(150,110,70,.75)' };
  }

  /* ----- lightning ----- */
  function makeBolt() {
    const x0 = rnd(W * 0.1, W * 0.9), yEnd = H * rnd(0.55, 0.85);
    const segs = [];
    const branch = (x, y, ang, len, depth) => {
      let px = x, py = y;
      const n = Math.round(len / 18);
      for (let k = 0; k < n && py < yEnd; k++) {
        const nx = px + Math.sin(ang) * 18 + rnd(-12, 12), ny = py + Math.cos(ang) * 18 + rnd(0, 8);
        segs.push([px, py, nx, ny, depth]);
        if (depth < 2 && Math.random() < 0.08) branch(nx, ny, ang + rnd(-0.9, 0.9), len * 0.4, depth + 1);
        px = nx; py = ny;
      }
    };
    branch(x0, -10, rnd(-0.25, 0.25), yEnd + 20, 0);
    return { segs, life: 1 };
  }

  function lightning(now, dt) {
    if (now > nextStrike) {
      const close = Math.random() < (cfg.kind === 'cyclone' ? 0.35 : 0.55);
      if (close) { bolt = makeBolt(); flash = 0.75; }
      else distantFlash = { x: rnd(0, W), y: rnd(0, H * 0.35), r: rnd(W * 0.3, W * 0.7), life: 1 };
      nextStrike = now + rnd(2500, cfg.intensity > 0.7 ? 7000 : 11000);
    }
    if (flash > 0) {
      // double-pulse flicker like a real return stroke
      const a = flash > 0.5 ? flash : flash > 0.3 ? 0.1 : flash * 1.1;
      ctx.fillStyle = `rgba(225,232,255,${a * 0.55})`; ctx.fillRect(0, 0, W, H);
      flash -= dt * 1.9;
    }
    if (distantFlash) {
      const d = distantFlash, g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.r);
      g.addColorStop(0, `rgba(200,210,255,${0.22 * d.life})`); g.addColorStop(1, 'rgba(200,210,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      d.life -= dt * 2.5; if (d.life <= 0) distantFlash = null;
    }
    if (bolt) {
      ctx.save(); ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(180,200,255,.9)'; ctx.shadowBlur = 14;
      for (const [x1, y1, x2, y2, depth] of bolt.segs) {
        ctx.strokeStyle = `rgba(245,248,255,${bolt.life * (depth ? 0.55 : 0.95)})`;
        ctx.lineWidth = depth ? 1 : 2.4;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      ctx.restore();
      bolt.life -= dt * 3.2; if (bolt.life <= 0) bolt = null;
    }
  }

  /* ----- cyclone spiral bands ----- */
  function buildSpiral() {
    const R = Math.hypot(W, H) * 1.1, c = document.createElement('canvas');
    c.width = c.height = Math.round(R * 2 / 2); // half-res offscreen, scaled up when drawn
    const g = c.getContext('2d'), C = c.width / 2;
    g.translate(C, C);
    for (let arm = 0; arm < 4; arm++) {
      for (let k = 0; k < 160; k++) {
        const th = k * 0.055 + arm * Math.PI / 2, r = 18 * Math.exp(0.19 * th * 1.6);
        if (r > C) break;
        const x = Math.cos(th) * r, y = Math.sin(th) * r, s = 10 + r * 0.22;
        const grd = g.createRadialGradient(x, y, 0, x, y, s);
        grd.addColorStop(0, 'rgba(220,230,245,0.028)'); grd.addColorStop(1, 'rgba(220,230,245,0)');
        g.fillStyle = grd; g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill();
      }
    }
    spiral = { c, size: R * 2 };
  }
  function drawSpiral(dt) {
    if (!spiral) buildSpiral();
    // centre the eye off-screen in the direction of the storm (screen: east = right, north = up)
    const b = (cfg.stormBearing ?? 135) * Math.PI / 180, dist = Math.hypot(W, H) * 0.55;
    const cx = W / 2 + Math.sin(b) * dist, cy = H / 2 - Math.cos(b) * dist;
    spiralAngle += dt * 0.05 * (cfg.hemisphere === 'S' ? 1 : -1); // NH counter-clockwise
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(spiralAngle);
    ctx.globalAlpha = 0.9; ctx.drawImage(spiral.c, -spiral.size / 2, -spiral.size / 2, spiral.size, spiral.size);
    ctx.restore();
  }

  /* ----- frame ----- */
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now; t += dt;
    const f = dt * 60; // frame-rate independent steps
    ctx.clearRect(0, 0, W, H);
    const P = params();

    // gusts: smoothly wander toward random targets
    if (Math.random() < dt * (cfg.kind === 'cyclone' ? 0.8 : 0.25)) gustTarget = rnd(-0.2, cfg.kind === 'cyclone' ? 1 : 0.6);
    gust += (gustTarget - gust) * Math.min(1, dt * 1.2);

    if (stars.length) {
      for (const s of stars) {
        const a = 0.35 + 0.35 * Math.sin(t * s.s + s.p);
        ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill();
      }
    }
    for (const c of clouds) {
      c.x += c.v * f * (slant() >= 0 ? 1 : -1);
      if (c.x - c.r > W) c.x = -c.r; if (c.x + c.r < 0) c.x = W + c.r;
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
      g.addColorStop(0, `rgba(235,240,250,${c.a})`); g.addColorStop(1, 'rgba(235,240,250,0)');
      ctx.fillStyle = g; ctx.fillRect(c.x - c.r, c.y - c.r, c.r * 2, c.r * 2);
    }
    if (P?.dark) { ctx.fillStyle = `rgba(4,8,20,${P.dark * (0.7 + 0.3 * cfg.intensity)})`; ctx.fillRect(0, 0, W, H); }
    if (P?.cyclone) drawSpiral(dt);
    for (const m of mist) {
      m.x += m.v * f * (slant() >= 0 ? 1 : -1); if (m.x - m.r > W) m.x = -m.r; if (m.x + m.r < 0) m.x = W + m.r;
      const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r);
      g.addColorStop(0, `rgba(210,222,240,${m.a})`); g.addColorStop(1, 'rgba(210,222,240,0)');
      ctx.fillStyle = g; ctx.fillRect(m.x - m.r, m.y - m.r, m.r * 2, m.r * 2);
    }
    for (const b of fog) {
      b.x += b.v * f; if (b.x > W) b.x = -W;
      const g = ctx.createLinearGradient(0, b.y - b.h / 2, 0, b.y + b.h / 2);
      g.addColorStop(0, 'rgba(225,230,240,0)'); g.addColorStop(0.5, `rgba(225,230,240,${b.a})`); g.addColorStop(1, 'rgba(225,230,240,0)');
      ctx.fillStyle = g; ctx.fillRect(b.x, b.y - b.h / 2, W * 2, b.h);
    }

    if (P) {
      const s = slant();
      // rain sheets / gust curtains
      if (P.sheets) {
        // a curtain of denser rain sweeping across, leaning with the rain
        const sx = ((t * (P.cyclone ? 260 : 120)) % (W * 1.6)) - W * 0.3, hw = P.cyclone ? 260 : 160;
        const a = P.cyclone ? 0.025 + 0.035 * Math.max(0, gust) : 0.04 + 0.05 * Math.max(0, gust);
        const g = ctx.createLinearGradient(sx - hw, 0, sx + hw, 0);
        g.addColorStop(0, 'rgba(200,215,235,0)'); g.addColorStop(0.5, `rgba(200,215,235,${a})`); g.addColorStop(1, 'rgba(200,215,235,0)');
        ctx.save(); const k = Math.max(-2, Math.min(2, s)); ctx.transform(1, 0, k, 1, -k * H / 2, 0);
        ctx.fillStyle = g; ctx.fillRect(sx - hw, 0, hw * 2, H); ctx.restore();
      }
      // drops in 3 depth layers, one path per layer
      const layers = [[], [], []];
      for (const d of drops) {
        d.y += d.spd * f; d.x += d.spd * s * f;
        if (d.y > d.land || d.x < -W * 0.4 || d.x > W * 1.4) {
          if (P.splash && d.z > 0.55 && d.y > d.land && d.x > 0 && d.x < W && Math.random() < P.splash) {
            for (let k = 0; k < (P.cyclone ? 2 : 3); k++) splashes.push({ x: d.x, y: d.land, vx: rnd(-1.6, 1.6) + s * 1.5, vy: rnd(-3.2, -1.2), life: 1, r: rnd(0.6, 1.3) });
          }
          Object.assign(d, newDrop(P, false));
        }
        layers[d.z < 0.33 ? 0 : d.z < 0.66 ? 1 : 2].push(d);
      }
      ctx.lineCap = 'round';
      layers.forEach((L, li) => {
        const zMid = (li + 0.5) / 3;
        ctx.strokeStyle = `rgba(190,215,245,${P.a[0] + (P.a[1] - P.a[0]) * zMid})`;
        ctx.lineWidth = P.w[0] + (P.w[1] - P.w[0]) * zMid;
        ctx.beginPath();
        for (const d of L) { ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - s * d.len, d.y - d.len); }
        ctx.stroke();
      });
      // splashes
      ctx.fillStyle = 'rgba(200,222,250,.55)';
      for (let k = splashes.length - 1; k >= 0; k--) {
        const p = splashes[k];
        p.x += p.vx * f; p.y += p.vy * f; p.vy += 0.25 * f; p.life -= 0.045 * f;
        if (p.life <= 0) { splashes.splice(k, 1); continue; }
        ctx.globalAlpha = p.life; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (splashes.length > 600) splashes.splice(0, splashes.length - 600);
      // cyclone: spray streaks + debris
      if (P.cyclone) {
        ctx.lineWidth = 1.2;
        for (const p of spray) {
          p.x += p.spd * Math.sign(s) * (1 + gust) * f; p.y += p.spd * 0.08 * f;
          if (p.x > W + p.len) { p.x = -p.len; p.y = rnd(0, H); } else if (p.x < -p.len) { p.x = W + p.len; p.y = rnd(0, H); }
          ctx.strokeStyle = `rgba(225,235,250,${p.a * (0.6 + Math.max(0, gust))})`;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - Math.sign(s) * p.len, p.y - p.len * 0.08); ctx.stroke();
        }
        for (let k = 0; k < debris.length; k++) {
          const d = debris[k];
          d.x += d.vx * Math.sign(s) * (0.7 + gust) * f; d.y += (d.vy + Math.sin(t * 3 + k) * 1.5) * f * 0.5; d.rot += d.vr * f;
          if (d.x > W + 40 || d.x < -40 || d.y > H + 40 || d.y < -40) debris[k] = newDebris(false);
          ctx.save(); ctx.translate(d.x, d.y); ctx.rotate(d.rot); ctx.fillStyle = d.c;
          ctx.beginPath(); ctx.ellipse(0, 0, d.s, d.s * 0.45, 0, 0, 6.283); ctx.fill(); ctx.restore();
        }
      }
    }
    // hail
    if (hail.length) {
      ctx.fillStyle = 'rgba(240,245,255,.85)';
      for (const h of hail) {
        h.y += h.vy * f; h.x += h.vx * f;
        if (!h.bounced && h.y > h.land) { h.bounced = true; h.vy = -h.vy * 0.35; h.vx = rnd(-2, 2); }
        if (h.bounced) h.vy += 0.6 * f;
        if (h.y > H + 10 || (h.bounced && h.y > h.land + 30)) Object.assign(h, { x: rnd(0, W), y: rnd(-80, -10), vy: rnd(10, 18), vx: 0, bounced: false, land: H * rnd(0.75, 1) });
        ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, 6.283); ctx.fill();
      }
    }
    // snow
    if (flakes.length) {
      const s = slant();
      for (const fl of flakes) {
        fl.y += fl.vy * f; fl.x += (Math.sin(t * fl.sw + fl.ph) * 0.6 + s * 2) * f * (0.4 + fl.z);
        if (fl.y > H + 10 || fl.x < -60 || fl.x > W + 60) Object.assign(fl, newFlake(false));
        ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.55 * fl.z})`;
        ctx.beginPath(); ctx.arc(fl.x, fl.y, fl.r, 0, 6.283); ctx.fill();
      }
    }
    if (P?.lightning) lightning(now, dt);
  }

  function start() {
    cancelAnimationFrame(raf); last = 0;
    if (cfg.kind === 'none' || cfg.quality === 'off') { ctx.clearRect(0, 0, W, H); return; }
    if (reduced) { frame(performance.now()); cancelAnimationFrame(raf); return; } // one static frame
    raf = requestAnimationFrame(frame);
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAnimationFrame(raf); else start(); });
  window.addEventListener('resize', () => { clearTimeout(resize._t); resize._t = setTimeout(() => { resize(); start(); }, 150); });

  window.FX = {
    set(next) {
      const changed = next.kind !== cfg.kind || !!next.hail !== !!cfg.hail || Math.abs((next.intensity || 0) - (cfg.intensity || 0)) > 0.15 || (next.quality && next.quality !== cfg.quality);
      cfg = { ...cfg, ...next };
      if (changed || !W) { if (!W) resize(); else build(); start(); }
    },
    get kind() { return cfg.kind; },
  };
})();
