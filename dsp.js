// dsp.js - signal processing helpers for ISC web oscilloscope
// Exports: computeMetrics, formatValue, computePhaseDeg, estimateFreqHz

function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / Math.max(1, arr.length);
}

function rms(arr) {
  let s2 = 0;
  for (let i = 0; i < arr.length; i++) s2 += arr[i] * arr[i];
  return Math.sqrt(s2 / Math.max(1, arr.length));
}

function minMax(arr) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!Number.isFinite(mn)) mn = 0;
  if (!Number.isFinite(mx)) mx = 0;
  return { min: mn, max: mx };
}

// Convert ADC "counts" (centered) to millivolts.
// In this project, `vcoef` follows the VB convention: Vcoef = 1000 / CAL.
// Empirically across the UI (cursor ΔV, V/div text), it is used as **counts per mV**,
// therefore:  mV = counts / vcoef.
function toMilliVolts(counts, vcoef_counts_per_mV, attenuation) {
  const att = Number.isFinite(attenuation) ? attenuation : 1;
  const vcoef = Number.isFinite(vcoef_counts_per_mV) ? vcoef_counts_per_mV : 1;
  return (counts / Math.max(1e-12, vcoef)) * att;
}

// mode: 'rms' | 'pp' | 'avg' | 'dbm'
export function computeMetrics(samples, opts = {}) {
  const attenuation = opts.attenuation ?? 1;
  const vcoef = opts.vcoef_mV_per_count ?? 1;
  const mode = opts.mode ?? 'rms';

  const m = mean(samples);
  const r = rms(samples);
  const { min, max } = minMax(samples);

  const avg_mV = toMilliVolts(m, vcoef, attenuation);
  const rms_mV = toMilliVolts(r, vcoef, attenuation);
  const pp_mV = toMilliVolts((max - min), vcoef, attenuation);

  let display = rms_mV / 1000; // default: volts RMS
  if (mode === 'pp') display = pp_mV / 1000;
  else if (mode === 'avg') display = avg_mV / 1000;
  else if (mode === 'dbm') {
    // assume 50 ohm, using RMS voltage (in volts)
    const vrms = rms_mV / 1000;
    const pW = (vrms * vrms) / 50;
    const dBm = 10 * Math.log10(Math.max(1e-12, pW) / 1e-3);
    display = dBm;
  }

  return { avg_mV, rms_mV, pp_mV, display };
}

export function formatValue(value, mode = 'rms') {
  if (!Number.isFinite(value)) return '-';
  if (mode === 'dbm') return `${value.toFixed(1)} dBm`;

  const absV = Math.abs(value);
  if (absV < 1) return `${(value * 1000).toFixed(absV < 0.1 ? 0 : 0)} mV`;
  return `${value.toFixed(absV < 10 ? 2 : 1)} V`;
}

function zeroCrossingsRising(x) {
  // indices where signal crosses 0 from negative to non-negative
  const out = [];
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) out.push(i);
  }
  return out;
}

function estimatePeriodFromCrossings(zc) {
  if (!zc || zc.length < 2) return null;
  // average of first few deltas
  const n = Math.min(8, zc.length - 1);
  let s = 0;
  for (let i = 0; i < n; i++) s += (zc[i + 1] - zc[i]);
  return s / n;
}

function crossCorrelationLag(a, b, maxLag) {
  // normalized cross correlation to find best lag
  // lag>0 means b is delayed relative to a (b shifted right)
  const n = a.length;
  let bestLag = 0;
  let best = -Infinity;

  // precompute energy
  let ea = 0, eb = 0;
  for (let i = 0; i < n; i++) { ea += a[i]*a[i]; eb += b[i]*b[i]; }
  const denom = Math.sqrt(Math.max(1e-12, ea * eb));

  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    // overlap region
    const i0 = Math.max(0, -lag);
    const i1 = Math.min(n, n - lag);
    for (let i = i0; i < i1; i++) s += a[i] * b[i + lag];
    const corr = s / denom;
    if (corr > best) { best = corr; bestLag = lag; }
  }
  return { bestLag, bestCorr: best };
}

// Returns { phaseDeg, stableText, periodSamples }
export function computePhaseDeg(s1, s2, prevPhase) {
  if (!s1 || !s2 || s1.length < 8 || s2.length < 8) {
    return { phaseDeg: null, stableText: '-', periodSamples: null };
  }

  // remove DC
  const m1 = mean(s1), m2 = mean(s2);
  const a = new Float32Array(s1.length);
  const b = new Float32Array(s2.length);
  for (let i = 0; i < s1.length; i++) { a[i] = s1[i] - m1; b[i] = s2[i] - m2; }

  const zc1 = zeroCrossingsRising(a);
  const periodSamples = estimatePeriodFromCrossings(zc1);

  // correlation lag search: within quarter frame
  const maxLag = Math.max(8, Math.floor(s1.length / 4));
  const { bestLag } = crossCorrelationLag(a, b, maxLag);

  let phaseDeg = null;
  if (periodSamples && Number.isFinite(periodSamples) && periodSamples > 0) {
    phaseDeg = (bestLag / periodSamples) * 360;
    // wrap to [-180, 180)
    while (phaseDeg >= 180) phaseDeg -= 360;
    while (phaseDeg < -180) phaseDeg += 360;
  }

  const stableText = (phaseDeg == null || !Number.isFinite(phaseDeg))
    ? '-'
    : `${phaseDeg.toFixed(1)}°`;

  return { phaseDeg, stableText, periodSamples };
}

export function estimateFreqHz(periodSamples, sampleRateHz) {
  if (!Number.isFinite(periodSamples) || periodSamples <= 0) return null;
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) return null;
  return sampleRateHz / periodSamples;
}
