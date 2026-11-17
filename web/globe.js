/* Wireframe "network of humans" globe: two dotted spheres with links, slowly rotating. */
window.OHGlobe = function (canvas) {
  const ctx = canvas.getContext("2d");
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W = 0, H = 0, DPR = 1, raf = 0, alive = true, t0 = performance.now();

  function sphere(n, r) {
    const pts = [];
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2;
      const rad = Math.sqrt(1 - y * y);
      const th = ga * i;
      // small jitter so it looks organic, not mathematical
      const j = 1 + (Math.random() - 0.5) * 0.06;
      pts.push([Math.cos(th) * rad * r * j, y * r * j, Math.sin(th) * rad * r * j]);
    }
    return pts;
  }
  function links(pts, k) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const d = [];
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1], dz = pts[i][2] - pts[j][2];
        d.push([dx * dx + dy * dy + dz * dz, j]);
      }
      d.sort((a, b) => a[0] - b[0]);
      for (let m = 0; m < k; m++) if (i < d[m][1]) out.push([i, d[m][1]]);
    }
    // a few long arcs, like orbits across the globe
    for (let s = 0; s < Math.floor(pts.length / 14); s++) {
      const a = (Math.random() * pts.length) | 0, b = (Math.random() * pts.length) | 0;
      if (a !== b) out.push([a, b, 1]);
    }
    return out;
  }

  const small = Math.min(innerWidth, innerHeight) < 700;
  const outer = sphere(small ? 170 : 260, 1);
  const inner = sphere(small ? 90 : 140, 0.5);
  const oL = links(outer, 2), iL = links(inner, 2);
  const stars = Array.from({ length: small ? 70 : 140 }, () => [Math.random(), Math.random(), Math.random() * 0.6 + 0.2]);
  const pulses = []; // gold "claims" travelling along links

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function project(p, ry, rx, R, cx, cy) {
    let [x, y, z] = p;
    const cyr = Math.cos(ry), syr = Math.sin(ry);
    [x, z] = [x * cyr - z * syr, x * syr + z * cyr];
    const cxr = Math.cos(rx), sxr = Math.sin(rx);
    [y, z] = [y * cxr - z * sxr, y * sxr + z * cxr];
    const persp = 2.6 / (2.6 - z);
    return [cx + x * R * persp, cy + y * R * persp, z];
  }

  function draw(now) {
    if (!alive) return;
    const t = reduce ? 0 : (now - t0) / 1000;
    ctx.clearRect(0, 0, W, H);

    for (const s of stars) {
      const tw = 0.5 + 0.5 * Math.sin(t * 1.3 + s[0] * 40);
      ctx.fillStyle = `rgba(255,255,255,${0.12 + 0.35 * s[2] * tw})`;
      ctx.fillRect(s[0] * W, s[1] * H, 1.2, 1.2);
    }

    const mobile = W < 700;
    const R = mobile ? Math.min(W * 0.36, H * 0.2) : Math.min(W * 0.4, H * 0.28, 320);
    const cx = W / 2, cy = mobile ? R + 92 : Math.min(H * 0.36, R + 100);
    const ry = t * 0.12, rx = -0.32 + Math.sin(t * 0.2) * 0.05;

    const layer = (pts, L, scaleAlpha, rotMul) => {
      const P = pts.map((p) => project(p, ry * rotMul, rx, R, cx, cy));
      ctx.lineWidth = 0.6;
      for (const [a, b, arc] of L) {
        const za = (P[a][2] + P[b][2]) / 2;
        const al = (0.05 + 0.22 * ((za + 1) / 2)) * scaleAlpha * (arc ? 0.6 : 1);
        ctx.strokeStyle = `rgba(255,255,255,${al})`;
        ctx.beginPath(); ctx.moveTo(P[a][0], P[a][1]); ctx.lineTo(P[b][0], P[b][1]); ctx.stroke();
      }
      for (const p of P) {
        const d = (p[2] + 1) / 2;
        ctx.fillStyle = `rgba(255,255,255,${(0.25 + 0.75 * d) * scaleAlpha})`;
        const r = 0.6 + 1.5 * d;
        ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 6.283); ctx.fill();
      }
      return P;
    };
    layer(inner, iL, 0.75, -1.4);
    const P = layer(outer, oL, 1, 1);

    // gold pulses = people claiming
    if (!reduce && Math.random() < 0.06 && pulses.length < 8) {
      const l = oL[(Math.random() * oL.length) | 0];
      pulses.push({ a: l[0], b: l[1], k: 0 });
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.k += 0.018;
      if (p.k >= 1) { pulses.splice(i, 1); continue; }
      const A = P[p.a], B = P[p.b];
      const x = A[0] + (B[0] - A[0]) * p.k, y = A[1] + (B[1] - A[1]) * p.k;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 9);
      g.addColorStop(0, "rgba(255,217,120,0.95)");
      g.addColorStop(1, "rgba(242,193,78,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 6.283); ctx.fill();
    }

    raf = requestAnimationFrame(draw);
  }

  resize();
  addEventListener("resize", resize);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else if (alive) raf = requestAnimationFrame(draw);
  });
  raf = requestAnimationFrame(draw);
  return { stop() { alive = false; cancelAnimationFrame(raf); removeEventListener("resize", resize); } };
};
