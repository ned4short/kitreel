// Reel effects: a crop that pans with the player, the spotlight ring, and title/end cards.
// Pure helpers (no DOM) except drawCard/ringImage, which take a canvas.

const STEP = 0.5;      // seconds between camera keyframes
const SMOOTH = 1.0;    // seconds of smoothing either side, so the camera glides instead of jitters

// Player position over the clip, relative to the clip start, one point every 0.5 s.
function samples(clip, key) {
  const pts = (clip.path || []).map(p => ({ t: p.t - clip.start, v: p[key] }))
    .filter(p => p.t >= -0.5 && p.t <= clip.end - clip.start + 0.5);
  const dur = clip.end - clip.start;
  const out = [];
  for (let t = 0; t <= dur + 1e-6; t += STEP) {
    if (!pts.length) { out.push({ t, v: null }); continue; }
    // linear interpolation between known points; hold the nearest value at the edges
    let i = pts.findIndex(p => p.t >= t);
    let v;
    if (i === -1) v = pts[pts.length - 1].v;
    else if (i === 0) v = pts[0].v;
    else { const a = pts[i - 1], b = pts[i]; v = a.v + (b.v - a.v) * (t - a.t) / ((b.t - a.t) || 1); }
    out.push({ t: Math.min(t, dur), v });
  }
  return out;
}

function smooth(points) {
  const n = Math.round(SMOOTH / STEP);
  return points.map((p, i) => {
    let sum = 0, w = 0;
    for (let k = -n; k <= n; k++) {
      const q = points[i + k];
      if (!q || q.v === null) continue;
      const weight = n + 1 - Math.abs(k);
      sum += q.v * weight; w += weight;
    }
    return { t: p.t, v: w ? sum / w : p.v };
  });
}

// An ffmpeg expression for a piecewise-linear value over time t: v0 + Σ slope·clip(t − tᵢ, 0, Δtᵢ).
export function linearExpr(points) {
  if (!points.length) return "0";
  const r = n => (Math.round(n * 100) / 100).toString();
  let expr = r(points[0].v);
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1], dt = b.t - a.t;
    const dv = b.v - a.v;
    if (!dt || Math.abs(dv) < 0.5) continue;
    expr += `${dv >= 0 ? "+" : "-"}${r(Math.abs(dv) / dt)}*clip(t-${r(a.t)},0,${r(dt)})`;
  }
  return expr;
}

// Crop size for the chosen shape, plus where the crop window sits over time.
export function cameraFor(clip, SW, SH, ratio) {
  let w, h;
  if (SW / SH > ratio) { h = SH; w = Math.round(SH * ratio); } else { w = SW; h = Math.round(SW / ratio); }
  w -= w % 2; h -= h % 2;
  const even = n => Math.round(n / 2) * 2;
  const fixedX = Math.round(Math.max(0, Math.min(SW - w, clip.cx * SW - w / 2)));
  const fixedY = Math.round(Math.max(0, Math.min(SH - h, clip.cy * SH - h / 2)));
  const cxs = samples(clip, "cx"), cys = samples(clip, "cy");
  const moving = cxs.some(p => p.v !== null);
  const xs = moving ? smooth(cxs).map(p => ({ t: p.t, v: even(Math.max(0, Math.min(SW - w, p.v * SW - w / 2))) }))
    : [{ t: 0, v: even(fixedX) }];
  const ys = moving ? smooth(cys).map(p => ({ t: p.t, v: even(Math.max(0, Math.min(SH - h, p.v * SH - h / 2))) }))
    : [{ t: 0, v: even(fixedY) }];
  return { w, h, xs, ys, moving };
}

export function cropFilter(cam) {
  const x = cam.xs.every(p => p.v === cam.xs[0].v) ? String(cam.xs[0].v) : `'${linearExpr(cam.xs)}'`;
  const y = cam.ys.every(p => p.v === cam.ys[0].v) ? String(cam.ys[0].v) : `'${linearExpr(cam.ys)}'`;
  return `crop=${cam.w}:${cam.h}:${x}:${y}`;
}

// Where to draw the spotlight ring (under the player's feet) in the finished frame.
// Returns null when the clip has no tracked path.
export function spotlightFor(clip, cam, SW, SH, W, H) {
  if (!cam.moving) return null;
  const k = W / cam.w;
  const feetX = smooth(samples(clip, "cx")), feetY = smooth(samples(clip, "y1"));
  const heights = (clip.path || []).map(p => (p.y1 - p.y0) * SH).sort((a, b) => a - b);
  const playerH = heights[Math.floor(heights.length / 2)] || SH * 0.15;
  const ringW = Math.round(Math.max(48, Math.min(W * 0.45, playerH * k * 0.9)));
  const ringH = Math.round(ringW * 0.38);
  const xs = feetX.map((p, i) => ({ t: p.t, v: (p.v * SW - cam.xs[Math.min(i, cam.xs.length - 1)].v) * k - ringW / 2 }));
  const ys = feetY.map((p, i) => ({ t: p.t, v: (p.v * SH - cam.ys[Math.min(i, cam.ys.length - 1)].v) * k - ringH / 2 }));
  return { ringW, ringH, x: linearExpr(xs), y: linearExpr(ys) };
}

// A glowing yellow ellipse, drawn once per reel size.
export function drawRing(canvas, w, h) {
  canvas.width = w; canvas.height = h;
  const c = canvas.getContext("2d");
  c.clearRect(0, 0, w, h);
  const lw = Math.max(3, Math.round(h * 0.12));
  c.shadowColor = "rgba(255, 214, 0, 0.9)";
  c.shadowBlur = lw * 2;
  c.strokeStyle = "#FFD600";
  c.lineWidth = lw;
  c.beginPath();
  c.ellipse(w / 2, h / 2, w / 2 - lw * 1.5, h / 2 - lw * 1.5, 0, 0, Math.PI * 2);
  c.stroke();
}

// Title / end card artwork.
export function drawCard(canvas, W, H, kind, info) {
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext("2d");
  const g = c.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#0b1110"); g.addColorStop(1, "#16220f");
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  const u = Math.min(W, H) / 100;              // layout unit
  c.textAlign = "center"; c.textBaseline = "middle";
  const font = (wt, px) => `${wt} ${Math.round(px)}px "Barlow Condensed", "Arial Narrow", "Segoe UI", Arial, sans-serif`;
  const fit = (text, wt, px, maxW) => {
    let size = px;
    c.font = font(wt, size);
    while (c.measureText(text).width > maxW && size > 10) { size -= 2; c.font = font(wt, size); }
  };
  if (kind === "title") {
    const lines = [];
    if (info.number) lines.push({ text: `#${info.number}`, wt: 800, px: u * 18, color: "#C6FF3D" });
    lines.push({ text: (info.name || "Highlights").toUpperCase(), wt: 800, px: u * 13, color: "#FFFFFF" });
    const sub = [info.position, info.team, info.date].filter(Boolean).join(" · ");
    if (sub) lines.push({ text: sub.toUpperCase(), wt: 700, px: u * 5.5, color: "#95A59D" });
    const gap = u * 4;
    const heights = lines.map(l => l.px);
    let y = H / 2 - (heights.reduce((a, b) => a + b, 0) + gap * (lines.length - 1)) / 2;
    for (const l of lines) {
      fit(l.text, l.wt, l.px, W * 0.86);
      c.fillStyle = l.color;
      c.fillText(l.text, W / 2, y + l.px / 2);
      y += l.px + gap;
    }
    c.fillStyle = "#C6FF3D"; c.fillRect(W / 2 - u * 8, H - u * 12, u * 16, Math.max(3, u * 0.8));
  } else {
    fit("MADE WITH", 700, u * 5.5, W * 0.86);
    c.fillStyle = "#95A59D"; c.fillText("MADE WITH", W / 2, H / 2 - u * 15);
    fit("KITREEL 2.0", 800, u * 15, W * 0.86);
    c.fillStyle = "#FFFFFF"; c.fillText("KITREEL", W / 2 - c.measureText(" 2.0").width / 2, H / 2 - u * 3);
    const kw = c.measureText("KITREEL").width;
    c.textAlign = "left"; c.fillStyle = "#C6FF3D";
    c.fillText(" 2.0", W / 2 - c.measureText(" 2.0").width / 2 + kw / 2, H / 2 - u * 3);
    c.textAlign = "center";
    fit("kitreel.nedwebservices.com", 700, u * 5, W * 0.86);
    c.fillStyle = "#C6FF3D"; c.fillText("kitreel.nedwebservices.com", W / 2, H / 2 + u * 10);
  }
}

// A silent stereo WAV (44.1 kHz), so cards have an audio track like the clips.
export function silentWav(seconds) {
  const rate = 44100, ch = 2, n = Math.round(seconds * rate), bytes = n * ch * 2;
  const buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
  const s = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  s(0, "RIFF"); v.setUint32(4, 36 + bytes, true); s(8, "WAVE"); s(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true); s(36, "data"); v.setUint32(40, bytes, true);
  return new Uint8Array(buf);
}
