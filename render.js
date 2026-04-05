// Canvas renderer for oscilloscope-like view
export function renderScope(ctx, frame, view, extra = {}) {
  const { width, height } = ctx.canvas;
  const mode = extra?.mode || 'time';
  ctx.clearRect(0, 0, width, height);

  // Background
  ctx.fillStyle = view.colors.bg;
  ctx.fillRect(0, 0, width, height);

  // Grid
  const x0 = view.margins.left;
  const y0 = view.margins.top;
  const w = width - view.margins.left - view.margins.right;
  const h = height - view.margins.top - view.margins.bottom;

  const divX = 10;
  const divY = 8;

  ctx.lineWidth = 1;
  for (let i = 0; i <= divX; i++) {
    const x = x0 + (w * i) / divX;
    ctx.strokeStyle = view.colors.grid;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y0 + h);
    ctx.stroke();
  }
  for (let j = 0; j <= divY; j++) {
    const y = y0 + (h * j) / divY;
    ctx.strokeStyle = view.colors.grid;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + w, y);
    ctx.stroke();
  }

  // Center line
  ctx.strokeStyle = view.colors.gridStrong;
  ctx.beginPath();
  ctx.moveTo(x0, y0 + h / 2);
  ctx.lineTo(x0 + w, y0 + h / 2);
  ctx.stroke();

  // Border
  ctx.strokeStyle = "#1d2a20";
  ctx.strokeRect(x0, y0, w, h);

  if (!frame?.ok) return;

  // Extra view params (zoom/cursors)
  const xZoom = extra?.xZoom ?? 1.0;
  const xCenter = extra?.xCenter ?? (frame.s1?.length ? frame.s1.length / 2 : 0);
  const cursors = extra?.cursors ?? null;
  const vcoef = extra?.vcoef ?? [1, 1];
  const sampleRateHz = extra?.sampleRateHz ?? 1;
  const yZoom = extra?.yZoom ?? view.yZoom ?? [1.0, 1.0];

  // Wave plotting with decimation to pixel columns
  const N = frame.s1.length;
  const winLen = Math.max(8, N / Math.max(1.0, xZoom));
  const winStart = Math.max(0, Math.min(N - winLen, xCenter - winLen / 2));
  const fadeHeadLen = frame.fadeHeadLen || 0;
  const fadeTailLen = frame.fadeTailLen || 0;
  const wrap = (frame.wrapIndex == null) ? null : frame.wrapIndex;

  const yScale = (h / 2) / view.yCountsPerDiv / (divY / 2); 
  // Explanation: yCountsPerDiv defines how many "counts" correspond to 1 div. We map to pixels.

  const yMid = y0 + h / 2;

  // sinc interpolation (sin(x)/x) for zoomed view
  function sinc(x) {
    if (x === 0) return 1;
    const pix = Math.PI * x;
    return Math.sin(pix) / pix;
  }
  function sincInterpolate(samples, t) {
    // Windowed sinc interpolation with small radius
    const M = 8;
    const n0 = Math.floor(t);
    let sum = 0;
    let wsum = 0;
    for (let k = -M; k <= M; k++) {
      const n = n0 + k;
      if (n < 0 || n >= N) continue;
      const v = samples[n];
      if (!Number.isFinite(v)) continue;
      const x = t - n;
      // Hann window
      const win = 0.5 + 0.5 * Math.cos(Math.PI * x / (M + 1));
      const w = sinc(x) * win;
      sum += v * w;
      wsum += w;
    }
    if (wsum === 0) return NaN;
    return sum / wsum;
  }

  
  // --- FFT mode ---
  if (mode === 'fft') {
    const fft = extra?.fft;
    const sampleRateHz = extra?.sampleRateHz || 1;
    ctx.save();
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';

    const maxF = sampleRateHz / 2;
    const toDb = (m) => 20 * Math.log10(Math.max(1e-9, m));
    const dbFloor = view.fftDbFloor ?? -80;
    const dbCeil = view.fftDbCeil ?? 0;

    const mapY = (db) => {
      const t = (db - dbCeil) / (dbFloor - dbCeil);
      return y0 + clamp01(t) * h;
    };

    const drawSpec = (spec, color) => {
      if (!spec?.mag || spec.mag.length < 2) return;
      let peak = -1e9;
      for (let i = 0; i < spec.mag.length; i++) peak = Math.max(peak, toDb(spec.mag[i]));
      const shift = -peak; // peak -> 0 dB
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = 0; i < spec.mag.length; i++) {
        const f = (i / (spec.mag.length - 1)) * maxF;
        const fMin = 1;
        const logMin = Math.log10(fMin);
        const logMax = Math.log10(Math.max(fMin * 1.01, maxF));
        const fl = Math.max(fMin, f);
        const xn = (Math.log10(fl) - logMin) / (logMax - logMin);
        const x = x0 + clamp01(xn) * w;
        const db = toDb(spec.mag[i]) + shift;
        const y = mapY(db);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    if (view.showCh1) drawSpec(fft?.ch1, view.colors.ch1);
    if (view.showCh2) drawSpec(fft?.ch2, view.colors.ch2);

    ctx.fillText(`0 Hz`, x0 + 4, y0 + h - 6);
    ctx.fillText(`${Math.round(maxF)} Hz`, x0 + w - 80, y0 + h - 6);
    ctx.fillText(`${dbCeil} dB`, x0 + 4, y0 + 14);
    ctx.fillText(`${dbFloor} dB`, x0 + 4, y0 + h - 20);

    // FFT cursor
    const cur = extra?.fftCursor;
    if (cur) {
      const n = clamp01(cur.n);
      const x = x0 + n * w;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + h);
      ctx.stroke();

      // handle ball
      const yH = y0 + h - 10;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(x, yH, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.stroke();
    }

    ctx.restore();
    return;
  }

const plot = (samples, color, clip, z=1.0) => {
    ctx.strokeStyle = clip ? view.colors.clip : color;
    ctx.lineWidth = 2;

    ctx.beginPath();
    let drawing = false;
    const wrapInWindow = (wrap != null) && (wrap > winStart) && (wrap < (winStart + winLen));
    let prevT = null;

    for (let px = 0; px < w; px++) {
      // Map pixel to fractional sample index in current window
      const t = winStart + (px * (winLen - 1)) / Math.max(1, (w - 1));

      // Break the polyline at buffer wrap boundary (trigger rotation) so we don't draw a diagonal jump.
      if (wrapInWindow && prevT != null && prevT < wrap && t >= wrap) {
        if (drawing) { ctx.stroke(); drawing = false; ctx.beginPath(); }
      }
      prevT = t;
      const v = (xZoom <= 1.01) ? samples[Math.round(t)] : sincInterpolate(samples, t);

      if (!Number.isFinite(v)) {
        if (drawing) { ctx.stroke(); drawing = false; ctx.beginPath(); }
        continue;
      }

      const y = yMid - v * yScale * z;
      const x = x0 + px;

      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else {
        ctx.lineTo(x, y);
      }
    }

    if (drawing) ctx.stroke();
  };

  if (view.showCh1) plot(frame.s1, view.colors.ch1, frame.clip1, (yZoom?.[0] ?? 1.0));
  if (view.showCh2) plot(frame.s2, view.colors.ch2, frame.clip2, (yZoom?.[1] ?? 1.0));

  // Labels
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(10, 10, 260, 62);
  ctx.fillStyle = view.colors.ch1;
  ctx.font = "18px system-ui, Segoe UI, Arial";
  ctx.fillText("CH1", 18, 34);
  ctx.fillStyle = view.colors.ch2;
  ctx.fillText("CH2", 78, 34);

  ctx.fillStyle = "#e8f5e9";
  ctx.font = "14px system-ui, Segoe UI, Arial";
  ctx.fillText(frame.clip1 ? "CLIP1" : "", 140, 34);
  ctx.fillText(frame.clip2 ? "CLIP2" : "", 200, 34);

  ctx.fillStyle = "#b7c7b8";
  ctx.font = "12px system-ui, Segoe UI, Arial";
  ctx.fillText(`parts=1028 chk=${frame.chkOk === null ? "?" : (frame.chkOk ? "OK" : "??")}`, 18, 56);

  // Cursors overlay
  if (cursors?.enabled) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1;

    const sampleToX = (sidx) => x0 + ((sidx - winStart) / Math.max(1e-6, (winLen - 1))) * w;
    const countsToY = (cnt) => yMid - cnt * yScale * yZoom;

    const t1x = sampleToX(cursors.t1);
    const t2x = sampleToX(cursors.t2);
    const v1y = (typeof cursors.v1N === 'number') ? (y0 + cursors.v1N * h) : countsToY(cursors.v1);
    const v2y = (typeof cursors.v2N === 'number') ? (y0 + cursors.v2N * h) : countsToY(cursors.v2);

    // vertical lines
    ctx.beginPath(); ctx.moveTo(t1x, y0); ctx.lineTo(t1x, y0 + h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(t2x, y0); ctx.lineTo(t2x, y0 + h); ctx.stroke();

    // horizontal lines
    ctx.beginPath(); ctx.moveTo(x0, v1y); ctx.lineTo(x0 + w, v1y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x0, v2y); ctx.lineTo(x0 + w, v2y); ctx.stroke();

    // Handles (small balls) for easier dragging
    const r = 5;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    const hx = x0 + 10;
    const hy = y0 + h - 10;
    // Y cursor handles (left side)
    ctx.beginPath(); ctx.arc(hx, v1y, r, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(hx, v2y, r, 0, Math.PI*2); ctx.fill();
    // X cursor handles (bottom)
    ctx.beginPath(); ctx.arc(t1x, hy, r, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(t2x, hy, r, 0, Math.PI*2); ctx.fill();

    // labels
    const dtSamples = Math.abs(cursors.t2 - cursors.t1);
    const dt = dtSamples / Math.max(1, sampleRateHz);
    const chIdx = (cursors.ch === 'ch2') ? 1 : 0;
    // ΔV from horizontal cursors: convert pixel Y to counts for selected channel (accounts for yZoom)
    const divY = 8;
    const yScaleC = (h / 2) / view.yCountsPerDiv / (divY / 2);
    const z = (yZoom?.[chIdx] ?? 1.0);
    const v1N = (typeof cursors.v1N === 'number') ? cursors.v1N : 0.35;
    const v2N = (typeof cursors.v2N === 'number') ? cursors.v2N : 0.65;
    const c1 = (yMid - (v1N * h)) / Math.max(1e-9, (yScaleC * z));
    const c2 = (yMid - (v2N * h)) / Math.max(1e-9, (yScaleC * z));
    const dMv = (c2 - c1) / Math.max(1e-9, (vcoef[chIdx] || 1));

    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "right";
    const tx = x0 + w - 10;
    ctx.fillText(`Δt ${(dt*1000).toFixed(3)} ms`, tx, y0 + 18);
    ctx.fillText(`ΔV ${(dMv/1000).toFixed(3)} V`, tx, y0 + 34);
    ctx.textAlign = "left";

    ctx.restore();
  }

}
function clamp(x,a,b){return Math.max(a,Math.min(b,x));}
function clamp01(x){return clamp(x,0,1);}
