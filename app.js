import { SerialLineClient } from './serial.js';
import { parseIscLine, NUM_SAMPLES } from './protocol.js';
import { computeMetrics, formatValue, computePhaseDeg, estimateFreqHz } from './dsp.js';
import { renderScope } from './render.js';

const ui = {
  canvas: document.getElementById('scope'),
  btnConnect: document.getElementById('btnConnect'),
  btnDisconnect: document.getElementById('btnDisconnect'),
  btnRun: document.getElementById('btnRun'),
  btnHold: document.getElementById('btnHold'),
  btnFft: document.getElementById('btnFft'),
  status: document.getElementById('status'),

  trigOff: document.getElementById('trigOff'),
  trigCh1: document.getElementById('trigCh1'),
  trigCh2: document.getElementById('trigCh2'),

  ch1On: document.getElementById('ch1On'),
  ch2On: document.getElementById('ch2On'),

  // Channel range selection (4 ADC inputs: direct + amplified for each channel)
  ch1Direct: document.getElementById('ch1Direct'),
  ch1Amp: document.getElementById('ch1Amp'),
  ch2Direct: document.getElementById('ch2Direct'),
  ch2Amp: document.getElementById('ch2Amp'),

  // EEPROM UI
  z1Now: document.getElementById('z1Now'),
  z2Now: document.getElementById('z2Now'),
  cal1Now: document.getElementById('cal1Now'),
  cal2Now: document.getElementById('cal2Now'),
  btnSaveZero1: document.getElementById('btnSaveZero1'),
  btnSaveZero2: document.getElementById('btnSaveZero2'),
  cal1Input: document.getElementById('cal1Input'),
  cal2Input: document.getElementById('cal2Input'),
  btnSaveCal1: document.getElementById('btnSaveCal1'),
  btnSaveCal2: document.getElementById('btnSaveCal2'),

  mCh1: document.getElementById('mCh1'),
  mCh2: document.getElementById('mCh2'),
  mPhase: document.getElementById('mPhase'),
  mFreq: document.getElementById('mFreq'),  fftFText: document.getElementById('fftFText'),
  fftCh1PctText: document.getElementById('fftCh1PctText'),
  fftCh2PctText: document.getElementById('fftCh2PctText'),
  xDiv: document.getElementById('xDiv'),
  yDiv1: document.getElementById('yDiv1'),
  yDiv2: document.getElementById('yDiv2'),

  yZoom1: document.getElementById('yZoom1'),
  yZoom2: document.getElementById('yZoom2'),

  genWave: document.getElementById('genWave'),
  genFreq: document.getElementById('genFreq'),
  btnGenSend: document.getElementById('btnGenSend'),

  xBtns: Array.from(document.querySelectorAll('.xbtn')),
  aBtns: Array.from(document.querySelectorAll('.abtn')),

  // Cursor/zoom UI
  cursorEnable: document.getElementById('cursorEnable'),
  cursorCh: document.getElementById('cursorCh'),
  btnCursorReset: document.getElementById('btnCursorReset'),
  btnZoomReset: document.getElementById('btnZoomReset'),
  zoomText: document.getElementById('zoomText'),
  dtText: document.getElementById('dtText'),
  invDtText: document.getElementById('invDtText'),
  dVText: document.getElementById('dVText'),
  ch1AvgText: document.getElementById('ch1AvgText'),
  ch1RmsText: document.getElementById('ch1RmsText'),
  ch1PpText: document.getElementById('ch1PpText'),
  ch2AvgText: document.getElementById('ch2AvgText'),
  ch2RmsText: document.getElementById('ch2RmsText'),
  ch2PpText: document.getElementById('ch2PpText'),
  dVCurCh1Text: document.getElementById('dVCurCh1Text'),
  dVCurCh2Text: document.getElementById('dVCurCh2Text'),
  nSamplesText: document.getElementById('nSamplesText'),
};

const ctx = ui.canvas.getContext('2d');

const view = {
  colors: {
    bg: getCss('--bg', '#0b2a18'),
    grid: getCss('--grid', '#14381f'),
    gridStrong: getCss('--grid-strong', '#ff3aa7'),
    ch1: getCss('--ch1', '#72ff6a'),
    ch2: getCss('--ch2', '#7ab6ff'),
    clip: getCss('--clip', '#ff3b30'),
  },
  margins: { left: 20, right: 20, top: 20, bottom: 20 },
  showCh1: true,
  showCh2: true,

  // "counts per division" for display; you can tune these later to match VB scaling.
  yCountsPerDiv: 200,
  yZoom: [1.0, 1.0],
};

const state = {
  connected: false,
  connecting: false,
  running: true,
  latestFrame: null,
  viewMode: 'time', // 'time' | 'fft'
  fftCache: null,
  fftCacheKey: 0,
  fftCursor: { n: 0.35 },
  fftDrag: null,

  rawPrev: null,
  rawPending: null,

  // Front-end / probe scaling factor (1 = no extra scaling).
  // NOTE: CAL already encodes the ADC path gain (direct vs amplified), so this should normally stay 1.
  attenuation: [1, 1],
  
  //vcoef: [0.405, 0.405], // later overwritten by cal
  vcoef: [1, 1], // later overwritten by cal
  mode: 'rms', // rms|pp|avg|dbm
  prevPhase: null,
  sampleRateHz: 48000, // updated by G command mapping
  defaultG: 6,
  timeUsPerDiv: 1000, // x scale display

  // X zoom/pan for display (0..NUM_SAMPLES-1 index space)
  xZoom: 1.0,
  xCenter: NUM_SAMPLES / 2,

  // Generator state
  generator: { wave: 's', freq: 1000, att: 0 },

  // Movable cursors (operate also in HOLD)
  cursors: {
    enabled: true,
    ch: 'ch1',
    t1: NUM_SAMPLES * 0.30,
    t2: NUM_SAMPLES * 0.70,
    v1N: 0.35, // normalized Y within plot area
    v2N: 0.65,
    drag: null,
    panStart: null,
  },

  // Init (Variant B): send C1/c3 only after first valid ISC frame
  initChannelsPending: false,
  initChannelsSent: false,

  // 4 ADC inputs: each channel has direct + amplified path (VB: v6imendus + seadistakanalid)
  v6imendus: [false, false], // [CH1, CH2] false=direct, true=amplified
  adcMap: {
    ch2: { direct: 1, amp: 2 }, // sends C1/C2
    ch1: { direct: 3, amp: 4 }, // sends c3/c4
  },

  // Simple software trigger (VB-like): OFF / CH1 / CH2, rising edge on 0 level
  trigger: {
    source: 'off', // 'off' | 'ch1' | 'ch2'
    levelCounts: 0,
    hystCounts: 10,
    preRatio: 0.25,
    lastIndex: null,
  },
};


const serial = new SerialLineClient();
serial.onLine = onLine;
serial.onStatus = (s) => setStatus(s);
serial.onError = (e) => {
  console.error(e);
  setStatus('Viga');
  alert(String(e?.message ?? e));
};

function setStatus(text) {
  ui.status.textContent = text;
}

function enableControls(enabled) {
  ui.btnDisconnect.disabled = !enabled;
  ui.btnRun.disabled = !enabled;
  ui.btnHold.disabled = !enabled;

  ui.trigOff.disabled = !enabled;
  ui.trigCh1.disabled = !enabled;
  ui.trigCh2.disabled = !enabled;

  ui.ch1On.disabled = !enabled;
  ui.ch2On.disabled = !enabled;

  ui.ch1Direct.disabled = !enabled;
  ui.ch1Amp.disabled = !enabled;
  ui.ch2Direct.disabled = !enabled;
  ui.ch2Amp.disabled = !enabled;

  ui.btnSaveZero1.disabled = !enabled;
  ui.btnSaveZero2.disabled = !enabled;
  ui.cal1Input.disabled = !enabled;
  ui.cal2Input.disabled = !enabled;
  ui.btnSaveCal1.disabled = !enabled;
  ui.btnSaveCal2.disabled = !enabled;

  ui.genWave.disabled = !enabled;
  ui.genFreq.disabled = !enabled;
  ui.btnGenSend.disabled = !enabled;

  for (const b of ui.xBtns) b.disabled = !enabled;
  for (const b of ui.aBtns) b.disabled = !enabled;
}


function updateConnectButton() {
  ui.btnConnect.classList.toggle('btn-connected', state.connected);
  ui.btnConnect.classList.toggle('btn-disconnected', !state.connected);
  ui.btnConnect.textContent = state.connected ? 'Lahuta COM' : 'Ühenda COM';
}
function updateRunButton() {
  ui.btnRun.classList.toggle('btn-run', state.running);
  ui.btnRun.classList.toggle('btn-hold', !state.running);
  ui.btnRun.textContent = state.running ? 'RUN' : 'HOLD';
}

function updateViewModeUI() {
  document.body.classList.toggle('fft-mode', state.viewMode === 'fft');
}

function updateFftButton() {
  if (!ui.btnFft) return;
  const on = (state.viewMode === 'fft');
  ui.btnFft.classList.toggle('btn-fft', on);
  ui.btnFft.classList.toggle('btn-fft-off', !on);
}

function setSettingsEnabled(enabled) {
  const setDis = (el, dis) => { if (el) el.disabled = dis; };

  // Input settings
  setDis(ui.ch1Direct, !enabled);
  setDis(ui.ch1Amp, !enabled);
  setDis(ui.ch2Direct, !enabled);
  setDis(ui.ch2Amp, !enabled);
  setDis(ui.yZoom, !enabled);

  // Generator settings
  setDis(ui.genWave, !enabled);
  setDis(ui.genFreq, !enabled);
  setDis(ui.btnGenSend, !enabled);
  for (const b of ui.aBtns) b.disabled = !enabled;

  // Timebase buttons (X)
  for (const b of ui.xBtns) b.disabled = !enabled;
}

function applyHoldLock() {
  if (!state.connected) { setSettingsEnabled(false); return; }
  setSettingsEnabled(state.running);
}


// Small util for serial pacing
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Send init channels with a pause between commands (your finding)
async function sendInitChannelsOnce() {
  // Init sequence needs delays so commands don't collide.
  const WAIT = 200;

  // Channel defaults
  await serial.writeLine('c1');
  await sleep(WAIT);
  await serial.writeLine('C3');
  await sleep(WAIT);

  // Generator INIT: 0 dB, sine, 1000 Hz
  setAmpActive('0');
  ui.genWave.value = 's';
  ui.genFreq.value = '1000';
  state.generator.wave = 's';
  state.generator.freq = 1000;
  state.generator.att = 0;
  await serial.writeLine('a0');
  await sleep(WAIT);
  await serial.writeLine('s1000');
  await sleep(WAIT);

  // Timebase INIT (G-code)
  const g = state.defaultG ?? 6;
  setXActive(String(g));
  state.sampleRateHz = (SAMPLE_RATE_BY_G[g] ?? state.sampleRateHz) * SAMPLE_RATE_CAL;
  state.timeUsPerDiv = usPerDivFromG(g);
  ui.xDiv.textContent = formatTimeDiv(state.timeUsPerDiv);
  await serial.writeLine(`G${g}`);
}



async function doConnect() {
try {
    console.log('[ISC] Ühenda COM clicked');

    if (!window.isSecureContext) {
      alert('Web Serial nõuab secure context\n\nKasuta https:// või http://localhost (mitte file://).');
      return;
    }
    if (!serial.supported()) {
      alert('Web Serial ei ole saadaval. Vajalik Chrome/Edge + lubatud Serial API.');
      return;
    }

    await serial.connect({ baudRate: 115200 });
    state.connected = true;
    state.running = true;
    enableControls(true);

    // UI default: otse (aga ära saada kohe; oota esimene korrektne ISC kaader)
    ui.ch1Direct.checked = true;
    ui.ch2Direct.checked = true;
    state.v6imendus = [false, false];

    state.initChannelsPending = true;
    state.initChannelsSent = false;

    // Generator UI defaults
    setXActive('50');
    const pick = chooseGForTimeDiv(50);
    state.sampleRateHz = pick.sr;
    state.timeUsPerDiv = pick.effUsDiv;
    ui.xDiv.textContent = formatTimeDiv(state.timeUsPerDiv);

    ui.genWave.value = 's';
    ui.genFreq.value = '1000';
    setAmpActive('0');
    state.generator.wave = 's';
    state.generator.freq = 1000;
    state.generator.att = 0;
    // Timebase default: force G6 (more logical baseline)
    state.defaultG = 6;
    setXActive(String(state.defaultG));
    state.sampleRateHz = (SAMPLE_RATE_BY_G[state.defaultG] ?? state.sampleRateHz) * (typeof SAMPLE_RATE_CAL === 'number' ? SAMPLE_RATE_CAL : 1.0);
    state.timeUsPerDiv = usPerDivFromG(state.defaultG);
    ui.xDiv.textContent = formatTimeDiv(state.timeUsPerDiv);

    setStatus('Avatud');
  } catch (e) {
    console.error('[ISC] connect failed', e);
    setStatus('Viga');
    alert(String(e?.message ?? e));
  }
  updateConnectButton();
  updateRunButton();
  applyHoldLock();
}

async function doDisconnect() {
await serial.close();
  state.connected = false;

  state.initChannelsPending = false;
  state.initChannelsSent = false;

  enableControls(false);
  updateConnectButton();
  applyHoldLock();
}

ui.btnConnect.addEventListener('click', async () => {
  if (state.connecting) return;

  if (state.connected) {
    await doDisconnect();
    return;
  }

  state.connecting = true;
  try {
    console.log('[ISC] Ühenda COM clicked');

    if (!window.isSecureContext) {
      alert('Web Serial nõuab secure context\n\nKasuta https:// või http://localhost (mitte file://).');
      return;
    }
    if (!serial.supported()) {
      alert('Web Serial ei ole saadaval. Vajalik Chrome/Edge + lubatud Serial API.');
      return;
    }

    // IMPORTANT: keep requestPort as the first awaited operation after checks (better user-gesture reliability in Edge)
    await serial.connect({ baudRate: 115200 });

    state.connected = true;
    state.running = true;
    enableControls(true);

    // UI default: otse (aga ära saada kohe; oota esimene korrektne ISC kaader)
    ui.ch1Direct.checked = true;
    ui.ch2Direct.checked = true;
    state.v6imendus = [false, false];

    state.initChannelsPending = true;
    state.initChannelsSent = false;

    // Generator defaults (sent after init logic elsewhere)
    ui.genWave.value = 's';
    ui.genFreq.value = '1000';
    setAmpActive('0');
    state.generator.wave = 's';
    state.generator.freq = 1000;
    state.generator.att = 0;

    // Timebase default: force G6
    state.defaultG = 6;
    setXActive(String(state.defaultG));
    state.sampleRateHz = (SAMPLE_RATE_BY_G[state.defaultG] ?? state.sampleRateHz) * (typeof SAMPLE_RATE_CAL === 'number' ? SAMPLE_RATE_CAL : 1.0);
    state.timeUsPerDiv = usPerDivFromG(state.defaultG);
    ui.xDiv.textContent = formatTimeDiv(state.timeUsPerDiv);

    setStatus('Avatud');
  } catch (e) {
    console.error('[ISC] connect failed', e);
    setStatus('Viga');

    // Edge sometimes throws quickly on the very first prompt; show a softer message
    const msg = String(e?.message ?? e);
    if (msg.includes('No port selected')) {
      // user cancelled / dialog closed
      // Don't spam alert; just show status.
      setStatus('Port valimata');
    } else {
      alert(msg);
    }
  } finally {
    state.connecting = false;
    updateConnectButton();
    updateRunButton();
    applyHoldLock();
  }
});


ui.btnRun.addEventListener('click', () => {
  if (!state.connected) return;
  state.running = !state.running;
  setStatus(state.running ? 'RUN' : 'HOLD');
  updateRunButton();
  applyHoldLock();
});
ui.cursorCh.addEventListener('change', () => {
  state.cursors.ch = ui.cursorCh.value === 'ch2' ? 'ch2' : 'ch1';
});
ui.btnCursorReset.addEventListener('click', () => {
  state.cursors.t1 = NUM_SAMPLES * 0.30;
  state.cursors.t2 = NUM_SAMPLES * 0.70;
  state.cursors.v1N = 0.35;
  state.cursors.v2N = 0.65;
});
ui.btnZoomReset.addEventListener('click', () => {
  state.xZoom = 1.0;
  state.xCenter = NUM_SAMPLES / 2;
});

function windowLen() {
  return Math.max(8, NUM_SAMPLES / Math.max(1.0, state.xZoom));
}
function windowStart() {
  const len = windowLen();
  return clampStart(state.xCenter - len / 2);
}

function plotRectClient() {
  // Match render.js plot area, but in CSS pixels (client coordinates).
  const rect = ui.canvas.getBoundingClientRect();
  // Canvas is usually scaled for DPR: canvas.width/height are in device pixels.
  const sx = rect.width / Math.max(1, ui.canvas.width);
  const sy = rect.height / Math.max(1, ui.canvas.height);

  const left = rect.left + view.margins.left * sx;
  const top = rect.top + view.margins.top * sy;
  const width = rect.width - (view.margins.left + view.margins.right) * sx;
  const height = rect.height - (view.margins.top + view.margins.bottom) * sy;
  return { left, top, width, height };
}


function fftNormFromClientX(clientX, rect) {
  return clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
}

function hitTestFftCursorClient(clientX, clientY, rect) {
  const r = 10;
  const yHandle = rect.top + rect.height - 10;
  const x = rect.left + state.fftCursor.n * rect.width;

  const d = Math.hypot(clientX - x, clientY - yHandle);
  if (d <= r) return { which: 'n' };

  if (Math.abs(clientX - x) <= 6 && clientY >= rect.top && clientY <= rect.top + rect.height) return { which: 'n' };

  return null;
}



function yNormFromPixel(py) {
  const rect = plotRectClient();
  return clamp01((py - rect.top) / rect.height);
}

function yNormToPixel(yN) {
  const rect = plotRectClient();
  return rect.top + clamp01(yN) * rect.height;
}

function sampleIndexFromPixel(px) {
  const pr = plotRectClient();
  const x = clamp01((px - pr.left) / Math.max(1, pr.width));
  const len = windowLen();
  const start = windowStart();
  return start + x * (len - 1);
}

function countsFromPixel(py) {
  // Invert render.js mapping inside plot rect:
  // y = yMid - v * yScale, where yScale = (h/2) / view.yCountsPerDiv / (divY/2)
  const pr = plotRectClient();
  const y = clamp01((py - pr.top) / Math.max(1, pr.height));

  const divY = 8; // MUST match render.js grid divisions
  const yMid = pr.height / 2;
  const yScale = (pr.height / 2) / view.yCountsPerDiv / (divY / 2);

  return (yMid - (y * pr.height)) / yScale;
}

function hitTestCursors(clientX, clientY) {
  const pr = plotRectClient();

  const t1x = sampleToPixel(state.cursors.t1, pr);
  const t2x = sampleToPixel(state.cursors.t2, pr);
  const v1y = yNormToPixel(state.cursors.v1N ?? 0.35);
  const v2y = yNormToPixel(state.cursors.v2N ?? 0.65);

  // "Handles" (small balls) for easier grabbing
  const hx = pr.left + 10;
  const hy = pr.top + pr.height - 10;
  const r = 10;

  const dist2 = (x1, y1, x2, y2) => {
    const dx = x1 - x2, dy = y1 - y2;
    return dx*dx + dy*dy;
  };

  // Prefer handle hits first
  if (dist2(clientX, clientY, hx, v1y) <= r*r) return 'v1';
  if (dist2(clientX, clientY, hx, v2y) <= r*r) return 'v2';
  if (dist2(clientX, clientY, t1x, hy) <= r*r) return 't1';
  if (dist2(clientX, clientY, t2x, hy) <= r*r) return 't2';

  // Fallback: line proximity
  const tol = 8;
  if (Math.abs(clientX - t1x) < tol) return 't1';
  if (Math.abs(clientX - t2x) < tol) return 't2';
  if (Math.abs(clientY - v1y) < tol) return 'v1';
  if (Math.abs(clientY - v2y) < tol) return 'v2';
  return null;
}

function sampleToPixel(sampleIdx, pr) {
  const len = windowLen();
  const start = windowStart();
  const x = (sampleIdx - start) / Math.max(1e-6, (len - 1));
  return pr.left + clamp01(x) * pr.width;
}

function countsToPixel(counts, pr) {
  const divY = 8; // MUST match render.js
  const yMid = pr.height / 2;
  const yScale = (pr.height / 2) / view.yCountsPerDiv / (divY / 2);
  const y = yMid - counts * yScale;
  return pr.top + y;
}


ui.canvas.addEventListener('pointerdown', (ev) => {
  if (!state.cursors.enabled) return;

  // Defensive: reset any stuck state from a previous interaction
  state.cursors.drag = null;
  state.cursors.panStart = null;
  state.fftDrag = null;

  try { ui.canvas.setPointerCapture(ev.pointerId); } catch { /* ignore */ }

  // FFT cursors: in FFT view drag FFT markers instead of time-domain cursors
  if (state.viewMode === 'fft') {
    const r = plotRectClient();
    const hit = hitTestFftCursorClient(ev.clientX, ev.clientY, r);
    if (hit) {
      state.fftDrag = hit.which;
      ev.preventDefault();
      return;
    }
    // click elsewhere in FFT view: do nothing (keeps spectrum stable)
    return;
  }

  if (ev.shiftKey) {
    state.cursors.panStart = { x: ev.clientX, xCenter: state.xCenter };
    return;
  }

  const hit = hitTestCursors(ev.clientX, ev.clientY);
  state.cursors.drag = hit;
});

ui.canvas.addEventListener('pointermove', (ev) => {
  if (!state.cursors.enabled) return;

  if (state.viewMode === 'fft' && state.fftDrag) {
    const r = plotRectClient();
    const n = fftNormFromClientX(ev.clientX, r);
    state.fftCursor.n = clamp(n, 0, 1);
    ev.preventDefault();
    return;
  }

  if (state.cursors.panStart) {
    const rect = ui.canvas.getBoundingClientRect();
    const dx = ev.clientX - state.cursors.panStart.x;
    const len = windowLen();
    const deltaSamples = -(dx / Math.max(1, rect.width)) * (len - 1);
    state.xCenter = clampSample(state.cursors.panStart.xCenter + deltaSamples);
    return;
  }

  if (!state.cursors.drag) return;
  const d = state.cursors.drag;
  if (d === 't1' || d === 't2') {
    const si = sampleIndexFromPixel(ev.clientX);
    state.cursors[d] = clampSample(si);
  } else if (d === 'v1' || d === 'v2') {
    const yn = yNormFromPixel(ev.clientY);
    if (d === 'v1') state.cursors.v1N = yn;
    else state.cursors.v2N = yn;
  }
});

function endCursorInteraction(ev) {
  state.cursors.drag = null;
  state.cursors.panStart = null;
  state.fftDrag = null;
  try {
    if (ev?.pointerId != null && ui.canvas.hasPointerCapture(ev.pointerId)) {
      ui.canvas.releasePointerCapture(ev.pointerId);
    }
  } catch { /* ignore */ }
}

ui.canvas.addEventListener('pointerup', endCursorInteraction);
ui.canvas.addEventListener('pointercancel', endCursorInteraction);
ui.canvas.addEventListener('lostpointercapture', endCursorInteraction);

// Extra safety: if the tab loses focus, drop drag state so cursors don't get "stuck"
window.addEventListener('blur', () => endCursorInteraction(null));
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') endCursorInteraction(null);
});
ui.canvas.addEventListener('wheel', (ev) => {
  // X zoom only
  ev.preventDefault();
  const rect = ui.canvas.getBoundingClientRect();
  const mouseSample = sampleIndexFromPixel(ev.clientX);

  const factor = ev.deltaY < 0 ? 1.15 : (1 / 1.15);
  const newZoom = clamp(state.xZoom * factor, 1.0, 32.0);

  // keep mouseSample under cursor
  const oldLen = windowLen();
  const oldStart = windowStart();
  const x = (mouseSample - oldStart) / Math.max(1e-6, (oldLen - 1));

  state.xZoom = newZoom;
  const newLen = windowLen();
  state.xCenter = clampSample(mouseSample - (x * (newLen - 1) - newLen / 2));
}, { passive: false });


ui.btnFft?.addEventListener('click', () => {
  state.viewMode = (state.viewMode === 'fft') ? 'time' : 'fft';
  if (state.viewMode === 'fft') {
    // entering FFT: compute immediately from frozen frame if available
    if (state.latestFrame?.ok) {
      state.fftCache = {
        ch1: fftMagReal(state.latestFrame.s1, state.sampleRateHz),
        ch2: fftMagReal(state.latestFrame.s2, state.sampleRateHz),
      };
    } else {
      state.fftCache = null;
    }
  }
  updateFftButton();
  setStatus(state.viewMode === 'fft' ? 'FFT' : (state.running ? 'RUN' : 'HOLD'));
  updateViewModeUI();
});
// Trigger UI (simple software trigger): OFF / CH1 / CH2, rising edge only
function setTriggerSource(src) {
  state.trigger.source = src;
  state.trigger.lastIndex = null;

  // UI highlight
  ui.trigOff.classList.toggle('active', src === 'off');
  ui.trigCh1.classList.toggle('active', src === 'ch1');
  ui.trigCh2.classList.toggle('active', src === 'ch2');

  setStatus(src === 'off' ? 'Trigger OFF' : (src === 'ch1' ? 'Trigger CH1 ↑' : 'Trigger CH2 ↑'));
}

// Return indices of rising edges using a simple Schmitt trigger around `level`.
function findRisingEdgesSchmitt(samples, level = 0, hyst = 0) {
  const N = samples?.length ?? 0;
  if (N < 2) return [];
  const low = level - Math.abs(hyst);
  const high = level + Math.abs(hyst);

  const idx = [];
  let armed = (samples[0] <= low);

  for (let i = 1; i < N; i++) {
    const v = samples[i];
    if (armed) {
      if (v >= high) {
        idx.push(i);
        armed = false;
      }
    } else {
      if (v <= low) armed = true;
    }
  }
  return idx;
}

// Software trigger: rotate buffers so that a rising edge is at a fixed X position (pretrigger ratio).
function applySoftwareTrigger(frame) {
  const src = state.trigger?.source ?? 'off';
  if (!frame?.ok || src === 'off') {
    // keep renderer happy: clear wrap marker
    if (frame) frame.wrapIndex = null;
    return frame;
  }

  const ref = (src === 'ch2') ? frame.s2 : frame.s1;
  const N = ref?.length ?? 0;
  if (N < 2) return frame;

  const pre = Math.round((state.trigger.preRatio ?? 0.25) * N);
  const level = state.trigger.levelCounts ?? 0;
  const hyst = state.trigger.hystCounts ?? 0;

  const edges = findRisingEdgesSchmitt(ref, level, hyst);
  if (!edges.length) {
    frame.wrapIndex = null;
    return frame;
  }

  // Prefer an edge that is AFTER the pretrigger point (so left side is truly "pre-trigger"),
  // otherwise fall back to the last edge before it.
  let chosen = edges.find(i => i >= pre);
  if (chosen == null) chosen = edges[edges.length - 1];

  let delta = chosen - pre;                 // desired: display[pre] = raw[chosen]
  delta = ((delta % N) + N) % N;           // normalize to 0..N-1

  // If delta==0, no rotation is needed.
  if (delta === 0) {
    frame.wrapIndex = null;
    return frame;
  }

  const rotate = (arr) => {
    const out = new Int16Array(N);
    const tail = N - delta;
    // out[0..tail-1] = arr[delta..N-1]
    out.set(arr.subarray(delta), 0);
    // out[tail..N-1] = arr[0..delta-1]
    out.set(arr.subarray(0, delta), tail);
    return out;
  };

  const wrapIndex = N - delta; // boundary between end-of-record and start-of-record

  // Save last index (debug / future smoothing)
  state.trigger.lastIndex = chosen;

  return {
    ...frame,
    s1: rotate(frame.s1),
    s2: rotate(frame.s2),
    wrapIndex,
    trigPreIndex: pre,
    trigRawIndex: chosen,
    trigDelta: delta,
  };
}

ui.trigOff.addEventListener('click', () => setTriggerSource('off'));
ui.trigCh1.addEventListener('click', () => setTriggerSource('ch1'));
ui.trigCh2.addEventListener('click', () => setTriggerSource('ch2'));

ui.ch1On.addEventListener('change', () => { view.showCh1 = ui.ch1On.checked; });
ui.ch2On.addEventListener('change', () => { view.showCh2 = ui.ch2On.checked; });

ui.yZoom1?.addEventListener('change', () => {
  const z = parseFloat(ui.yZoom1.value);
  view.yZoom[0] = (Number.isFinite(z) && z > 0) ? z : 1.0;
});
ui.yZoom2?.addEventListener('change', () => {
  const z = parseFloat(ui.yZoom2.value);
  view.yZoom[1] = (Number.isFinite(z) && z > 0) ? z : 1.0;
});


// --- Channel selection (ADC input mapping) ---
function currentCh1Adc() {
  return ui.ch1Amp.checked ? state.adcMap.ch1.amp : state.adcMap.ch1.direct;
}
function currentCh2Adc() {
  return ui.ch2Amp.checked ? state.adcMap.ch2.amp : state.adcMap.ch2.direct;
}

// Apply channel selection immediately (no extra buttons)
async function setCh1Range(isAmp) {
  state.v6imendus[0] = !!isAmp;
  if (!state.connected) return;
  await serial.writeLine(`C${currentCh1Adc()}`);
}
async function setCh2Range(isAmp) {
  state.v6imendus[1] = !!isAmp;
  if (!state.connected) return;
  await serial.writeLine(`c${currentCh2Adc()}`);
}

ui.ch1Direct.addEventListener('change', () => { if (ui.ch1Direct.checked) setCh1Range(false).catch(console.warn); });
ui.ch1Amp.addEventListener('change', () => { if (ui.ch1Amp.checked) setCh1Range(true).catch(console.warn); });
ui.ch2Direct.addEventListener('change', () => { if (ui.ch2Direct.checked) setCh2Range(false).catch(console.warn); });
ui.ch2Amp.addEventListener('change', () => { if (ui.ch2Amp.checked) setCh2Range(true).catch(console.warn); });

// --- EEPROM actions ---
ui.btnSaveZero1.addEventListener('click', async () => {
  const f = state.latestFrame;
  if (!f?.ok) return;
  const avg = mean(f.s1);
  const newZ = clampInt16(f.z1 + Math.round(avg));
  await serial.writeLine(`Z${newZ}`);
});
ui.btnSaveZero2.addEventListener('click', async () => {
  const f = state.latestFrame;
  if (!f?.ok) return;
  const avg = mean(f.s2);
  const newZ = clampInt16(f.z2 + Math.round(avg));
  await serial.writeLine(`z${newZ}`);
});

ui.btnSaveCal1.addEventListener('click', async () => {
  const v = parseInt(ui.cal1Input.value, 10);
  if (!Number.isFinite(v) || v <= 0) { alert('Sisesta CAL CH1 integer (nt 2468).'); return; }
  await serial.writeLine(`M${v}`);
});
ui.btnSaveCal2.addEventListener('click', async () => {
  const v = parseInt(ui.cal2Input.value, 10);
  if (!Number.isFinite(v) || v <= 0) { alert('Sisesta CAL CH2 integer (nt 2468).'); return; }
  await serial.writeLine(`m${v}`);
});

function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}
function clampInt16(x) {
  x = Math.round(x);
  if (x > 32767) return 32767;
  if (x < -32768) return -32768;
  return x;
}

ui.btnGenSend.addEventListener('click', async () => {
  // Send frequency (with current waveform, because MCU command is wave+freq)
  const wave = ui.genWave.value; // s/n/k
  const f = clamp(parseInt(ui.genFreq.value, 10) || 1000, 5, 100000);
  ui.genFreq.value = String(f);
  state.generator.wave = wave;
  state.generator.freq = f;
  await serial.writeLine(`${wave}${f}`);
});

ui.genWave.addEventListener('change', () => {
  // Send immediately on waveform change (uses current frequency)
  if (!state.connected) return;
  const wave = ui.genWave.value;
  const f = clamp(parseInt(ui.genFreq.value, 10) || 1000, 5, 100000);
  ui.genFreq.value = String(f);
  state.generator.wave = wave;
  state.generator.freq = f;
  serial.writeLine(`${wave}${f}`).catch(console.warn);
});

ui.genFreq.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') ui.btnGenSend.click();
});


function setAmpActive(aStr) {
  ui.aBtns.forEach((b) => b.classList.toggle('active', b.dataset.a === aStr));
  state.generator.att = parseInt(aStr, 10) || 0;
}
ui.aBtns.forEach((btn) => btn.addEventListener('click', () => {
  const a = btn.dataset.a; // '0' | '1' | '3'
  setAmpActive(a);
  if (!state.connected) return;
  serial.writeLine(`a${a}`).catch(console.warn);
}));

ui.xBtns.forEach((btn) => btn.addEventListener('click', async () => {
  const g = parseInt(btn.dataset.g, 10);
  if (!Number.isFinite(g)) return;

  setXActive(String(g));

  const us = usPerDivFromG(g);
  state.timeUsPerDiv = us;
  ui.xDiv.textContent = formatTimeDiv(us);

  state.sampleRateHz = (SAMPLE_RATE_BY_G[g] ?? state.sampleRateHz) * SAMPLE_RATE_CAL;
  await serial.writeLine(`G${g}`);
}));

function onLine(line) {
  const frame = parseIscLine(line);
  if (!frame || !frame.ok) return;

  // Variant B: send init only after first valid frame, with a pause between commands
  if (state.connected && state.initChannelsPending && !state.initChannelsSent) {
    state.initChannelsSent = true;
    state.initChannelsPending = false;

    ui.ch1Direct.checked = true;
    ui.ch2Direct.checked = true;
    state.v6imendus = [false, false];

    sendInitChannelsOnce().catch(console.warn);
  }

  // HOLD: keep frozen display, but allow the very first frame through so the scope shows something
  if (!state.running && state.latestFrame) return;

  // Update vcoef from CAL (VB: Vcoef = 1000 / osscal)
  if (frame.cal1 > 0) state.vcoef[0] = 1000 / frame.cal1;
  if (frame.cal2 > 0) state.vcoef[1] = 1000 / frame.cal2;

  // Update EEPROM display + prefill CAL inputs
  ui.z1Now.textContent = String(frame.z1);
  ui.z2Now.textContent = String(frame.z2);
  ui.cal1Now.textContent = String(frame.cal1);
  ui.cal2Now.textContent = String(frame.cal2);
  if (!ui.cal1Input.value) ui.cal1Input.value = String(frame.cal1 || '');
  if (!ui.cal2Input.value) ui.cal2Input.value = String(frame.cal2 || '');

  const dispFrame = applySoftwareTrigger(frame);
  state.latestFrame = dispFrame;

  // Measurements
  const m1 = computeMetrics(dispFrame.s1, { attenuation: state.attenuation[0], vcoef_mV_per_count: state.vcoef[0], mode: state.mode });
  const m2 = computeMetrics(dispFrame.s2, { attenuation: state.attenuation[1], vcoef_mV_per_count: state.vcoef[1], mode: state.mode });

  ui.mCh1.textContent = `${formatValue(m1.display, state.mode)} (${m1.rms_mV.toFixed(0)} mV RMS)`;
  ui.mCh2.textContent = `${formatValue(m2.display, state.mode)} (${m2.rms_mV.toFixed(0)} mV RMS)`;

  const ph = computePhaseDeg(dispFrame.s2, dispFrame.s1, state.prevPhase);
  state.prevPhase = ph.phaseDeg ?? state.prevPhase;
  ui.mPhase.textContent = ph.stableText;

  const freq = estimateFreqHz(ph.periodSamples, state.sampleRateHz);
  ui.mFreq.textContent = (freq && Number.isFinite(freq)) ? `${freq.toFixed(1)} Hz` : '-';

  // Scales text
  ui.yDiv1.textContent = approxYDivText(state.vcoef[0]);
  ui.yDiv2.textContent = approxYDivText(state.vcoef[1]);
  ui.xDiv.textContent = ui.xDiv.textContent || formatTimeDiv(state.timeUsPerDiv);

  // Cursor stats panel (if present in this build)
  try {
    if (typeof updateCursorReadouts === 'function') updateCursorReadouts();
  } catch (e) {
    // ignore
  }
}


function updateCursorReadouts() {
  // Works also in HOLD: uses state.latestFrame (display frame).
  const f = state.latestFrame;

  // In FFT view, time-domain cursor math is not meaningful — show only FFT readout.
  if (state.viewMode === 'fft') {
    // clear time-domain fields (prevents stale values if CSS changes)
    if (ui.dtText) ui.dtText.textContent = '-';
    if (ui.invDtText) ui.invDtText.textContent = '-';
    if (ui.dVText) ui.dVText.textContent = '-';
    if (ui.ch1AvgText) ui.ch1AvgText.textContent = '-';
    if (ui.ch1RmsText) ui.ch1RmsText.textContent = '-';
    if (ui.ch1PpText) ui.ch1PpText.textContent = '-';
    if (ui.ch2AvgText) ui.ch2AvgText.textContent = '-';
    if (ui.ch2RmsText) ui.ch2RmsText.textContent = '-';
    if (ui.ch2PpText) ui.ch2PpText.textContent = '-';
    if (ui.dVCurCh1Text) ui.dVCurCh1Text.textContent = '-';
    if (ui.dVCurCh2Text) ui.dVCurCh2Text.textContent = '-';
    if (ui.nSamplesText) ui.nSamplesText.textContent = '-';

  // FFT single cursor readout
    if (state.viewMode === 'fft' && state.fftCache?.ch1?.mag?.length) {
      const fMin = 1;
      const fMax = (state.sampleRateHz || 1) / 2;
      const logMin = Math.log10(fMin);
      const logMax = Math.log10(Math.max(fMin * 1.01, fMax));
      const n = clamp(state.fftCursor.n, 0, 1);
      const f = Math.pow(10, logMin + n * (logMax - logMin));
      const pctAtF = (magArr) => {
        if (!magArr || magArr.length < 2) return null;
        const bins = magArr.length;
        const k = clamp(Math.round((f / fMax) * (bins - 1)), 0, bins - 1);
        let totalP = 0;
        // exclude DC bin 0
        for (let i = 1; i < bins; i++) totalP += magArr[i] * magArr[i];
        const p = magArr[k] * magArr[k];
        if (totalP <= 0) return 0;
        return 100 * (p / totalP);
      };
      const p1 = pctAtF(state.fftCache.ch1.mag);
      const p2 = pctAtF(state.fftCache.ch2.mag);
      if (ui.fftFText) ui.fftFText.textContent = `${f.toFixed(f < 1000 ? 1 : 0)} Hz`;
      if (ui.fftCh1PctText) ui.fftCh1PctText.textContent = (p1 == null) ? '-' : `${p1.toFixed(2)} %`;
      if (ui.fftCh2PctText) ui.fftCh2PctText.textContent = (p2 == null) ? '-' : `${p2.toFixed(2)} %`;
    } else {
      if (ui.fftFText) ui.fftFText.textContent = '-';
      if (ui.fftCh1PctText) ui.fftCh1PctText.textContent = '-';
      if (ui.fftCh2PctText) ui.fftCh2PctText.textContent = '-';
    }
  return;
  }

  if (!state.cursors?.enabled || !f?.ok) {
    if (ui.dtText) ui.dtText.textContent = '-';
    if (ui.invDtText) ui.invDtText.textContent = '-';
    if (ui.dVText) ui.dVText.textContent = '-';
    if (ui.ch1AvgText) ui.ch1AvgText.textContent = '-';
    if (ui.ch1RmsText) ui.ch1RmsText.textContent = '-';
    if (ui.ch1PpText) ui.ch1PpText.textContent = '-';
    if (ui.ch2AvgText) ui.ch2AvgText.textContent = '-';
    if (ui.ch2RmsText) ui.ch2RmsText.textContent = '-';
    if (ui.ch2PpText) ui.ch2PpText.textContent = '-';
    if (ui.dVCurCh1Text) ui.dVCurCh1Text.textContent = '-';
    if (ui.dVCurCh2Text) ui.dVCurCh2Text.textContent = '-';
    if (ui.nSamplesText) ui.nSamplesText.textContent = '-';
    return;
  }

  const tA = Math.min(state.cursors.t1, state.cursors.t2);
  const tB = Math.max(state.cursors.t1, state.cursors.t2);
  const i0 = Math.max(0, Math.floor(tA));
  const i1 = Math.min(NUM_SAMPLES - 1, Math.ceil(tB));
  const n = Math.max(0, (i1 - i0 + 1));

  // Δt and 1/Δt
  const dtSamples = Math.abs(state.cursors.t2 - state.cursors.t1);
  const dt = dtSamples / Math.max(1, state.sampleRateHz);
  if (ui.dtText) ui.dtText.textContent = Number.isFinite(dt) ? `${(dt * 1000).toFixed(3)} ms` : '-';
  if (ui.invDtText) ui.invDtText.textContent = (dt > 0) ? `${(1 / dt).toFixed(2)} Hz` : '-';
  if (ui.nSamplesText) ui.nSamplesText.textContent = String(n);

  // Cursor ΔV (horizontal cursors) computed separately for CH1 & CH2 because Vcoef differs.
  function countsFromYNorm(yN, chIdx) {
    const rect = plotRectClient();
    const divY = 8;
    const yMid = rect.height / 2;
    const yScale = (rect.height / 2) / view.yCountsPerDiv / (divY / 2);
    const z = view.yZoom?.[chIdx] ?? 1.0;
    const yPix = yN * rect.height;
    return (yMid - yPix) / Math.max(1e-9, (yScale * z));
  }

  const dCountsCh1 = countsFromYNorm(state.cursors.v2N, 0) - countsFromYNorm(state.cursors.v1N, 0);
  const dCountsCh2 = countsFromYNorm(state.cursors.v2N, 1) - countsFromYNorm(state.cursors.v1N, 1);

  const dMvCh1 = dCountsCh1 / Math.max(1e-9, (state.vcoef[0] || 1));
  const dMvCh2 = dCountsCh2 / Math.max(1e-9, (state.vcoef[1] || 1));
  if (ui.dVCurCh1Text) ui.dVCurCh1Text.textContent = `${(dMvCh1 / 1000).toFixed(3)} V`;
  if (ui.dVCurCh2Text) ui.dVCurCh2Text.textContent = `${(dMvCh2 / 1000).toFixed(3)} V`;

  // Legacy single ΔV pill (use selected channel)
  const selCh = (state.cursors.ch === 'ch2') ? 1 : 0;
  const dMvSel = (selCh === 1 ? dMvCh2 : dMvCh1);
  if (ui.dVText) ui.dVText.textContent = `${(dMvSel / 1000).toFixed(3)} V`;


  function computeWindowStats(samples, vcoef_mV_per_count) {
    let sum = 0;
    let sum2 = 0;
    let min = Infinity;
    let max = -Infinity;
    let cnt = 0;

    for (let i = i0; i <= i1; i++) {
      const v = samples[i];
      if (!Number.isFinite(v)) continue;
      sum += v;
      sum2 += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
      cnt++;
    }
    if (cnt === 0) return null;

    const avgCounts = sum / cnt;
    const rmsCounts = Math.sqrt(sum2 / cnt);
    const vppCounts = max - min;

    const k = Math.max(1e-9, vcoef_mV_per_count);
    const avgV = (avgCounts / k) / 1000;
    const rmsV = (rmsCounts / k) / 1000;
    const vppV = (vppCounts / k) / 1000;

    return { avgV, rmsV, vppV, cnt };
  }

  const s1 = computeWindowStats(f.s1, state.vcoef[0] || 1);
  const s2 = computeWindowStats(f.s2, state.vcoef[1] || 1);

  if (ui.ch1AvgText) ui.ch1AvgText.textContent = s1 ? `${s1.avgV.toFixed(3)} V` : '-';
  if (ui.ch1RmsText) ui.ch1RmsText.textContent = s1 ? `${s1.rmsV.toFixed(3)} V` : '-';
  if (ui.ch1PpText) ui.ch1PpText.textContent = s1 ? `${s1.vppV.toFixed(3)} V` : '-';

  if (ui.ch2AvgText) ui.ch2AvgText.textContent = s2 ? `${s2.avgV.toFixed(3)} V` : '-';
  if (ui.ch2RmsText) ui.ch2RmsText.textContent = s2 ? `${s2.rmsV.toFixed(3)} V` : '-';
  if (ui.ch2PpText) ui.ch2PpText.textContent = s2 ? `${s2.vppV.toFixed(3)} V` : '-';
  

  // not FFT view: clear FFT readout
  if (ui.fftFText) ui.fftFText.textContent = '-';
  if (ui.fftCh1PctText) ui.fftCh1PctText.textContent = '-';
  if (ui.fftCh2PctText) ui.fftCh2PctText.textContent = '-';

}

function tick() {
  // Update zoom label
  if (ui.zoomText) ui.zoomText.textContent = `Zoom: ${state.xZoom.toFixed(2)}×`;
  if (typeof updateCursorReadouts === 'function') updateCursorReadouts();
  if (state.viewMode === 'fft' && !state.fftCache && state.latestFrame?.ok) {
    state.fftCache = {
      ch1: fftMagReal(state.latestFrame.s1, state.sampleRateHz),
      ch2: fftMagReal(state.latestFrame.s2, state.sampleRateHz),
    };
  }

  renderScope(ctx, state.latestFrame, view, { xZoom: state.xZoom, xCenter: state.xCenter, yZoom: view.yZoom, cursors: state.cursors, vcoef: state.vcoef, sampleRateHz: state.sampleRateHz , mode: state.viewMode, fft: state.fftCache, sampleRateHz: state.sampleRateHz , fftCursor: state.fftCursor});
  requestAnimationFrame(tick);
}
tick();
updateFftButton();

function getCss(varName, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || fallback;
}

function chooseGForTimeDiv(usPerDiv) {
  // Choose the closest HW samplerate bucket so that 1024 samples span ~10 divisions.
  // totalTime = NUM_SAMPLES / sampleRate. So effective us/div = (totalTime / 10)*1e6.
  const table = [
    { code: 1, sr: 520 },
    { code: 2, sr: 1750 },
    { code: 3, sr: 2800 },
    { code: 4, sr: 5000 },
    { code: 5, sr: 12400 },
    { code: 6, sr: 55100 },
    { code: 7, sr: 160000 },
    { code: 8, sr: 200000 },
    { code: 9, sr: 250000 },
  ];
  const target = usPerDiv;
  let best = table[0];
  let bestErr = Infinity;

  for (const t of table) {
    const effUsDiv = ((NUM_SAMPLES / t.sr) / 10) * 1e6;
    const err = Math.abs(Math.log(effUsDiv / target)); // scale-invariant
    if (err < bestErr) { bestErr = err; best = { ...t, effUsDiv }; }
  }
  if (!best.effUsDiv) best.effUsDiv = ((NUM_SAMPLES / best.sr) / 10) * 1e6;
  return best; // {code, sr, effUsDiv}
}


function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

// --- FFT (real input) ---
// Returns { freqsHz: Float32Array, mag: Float32Array } bins 0..N/2, Hann-windowed.
// Note: magnitude is relative (normalized); we display in dB relative to peak.
function fftMagReal(samples, sampleRateHz) {
  const N = samples.length | 0;
  if (N < 2) return { freqsHz: new Float32Array(0), mag: new Float32Array(0) };

  // Use largest power-of-two <= N
  let n = 1;
  while ((n << 1) <= N) n <<= 1;

  const re = new Float32Array(n);
  const im = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))); // Hann
    re[i] = samples[i] * w;
    im[i] = 0;
  }

  // Bit-reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tr = re[i]; re[i] = re[j]; re[j] = tr;
      let ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  // FFT
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1, wIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];

        const vr = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vi = re[i + j + half] * wIm + im[i + j + half] * wRe;

        re[i + j] = uRe + vr;
        im[i + j] = uIm + vi;
        re[i + j + half] = uRe - vr;
        im[i + j + half] = uIm - vi;

        const nextWRe = wRe * wlenRe - wIm * wlenIm;
        const nextWIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextWRe;
        wIm = nextWIm;
      }
    }
  }

  const bins = (n >> 1) + 1;
  const mag = new Float32Array(bins);
  const freqsHz = new Float32Array(bins);
  const norm = 1 / n;

  for (let k = 0; k < bins; k++) {
    mag[k] = Math.hypot(re[k], im[k]) * norm;
    freqsHz[k] = (k * sampleRateHz) / n;
  }
  return { freqsHz, mag };
}

function recomputeFftFromLatest() {
  const f = state.latestFrame;
  if (!f?.ok) return;
  state.fftCache = {
    ch1: fftMagReal(f.s1, state.sampleRateHz),
    ch2: fftMagReal(f.s2, state.sampleRateHz),
  };
  state.fftCacheKey = ((f.s1?.[0] ?? 0) & 0xffff) ^ (((f.s2?.[0] ?? 0) & 0xffff) << 1) ^ ((state.sampleRateHz|0) << 2);
}


function clamp01(x) { return clamp(x, 0, 1); }

// Clamp a sample index / center to valid sample range
function clampSample(x) { return clamp(x, 0, NUM_SAMPLES - 1); }

// Clamp the visible window start index (depends on zoom/windowLen)
function clampStart(x) {
  const len = windowLen();
  const maxStart = Math.max(0, NUM_SAMPLES - len);
  return clamp(x, 0, maxStart);
}


function fftNormFromX(x, plot) {
  return clamp((x - plot.x0) / plot.w, 0, 1);
}

function hitTestFftCursors(mx, my, plot) {
  const r = 10;
  const yHandle = plot.y0 + plot.h - 10;
  const x1 = plot.x0 + state.fftCursors.n1 * plot.w;
  const x2 = plot.x0 + state.fftCursors.n2 * plot.w;
  const d1 = Math.hypot(mx - x1, my - yHandle);
  const d2 = Math.hypot(mx - x2, my - yHandle);
  if (d1 <= r) return { which: 'n1' };
  if (d2 <= r) return { which: 'n2' };
  if (Math.abs(mx - x1) <= 6 && my >= plot.y0 && my <= plot.y0 + plot.h) return { which: 'n1' };
  if (Math.abs(mx - x2) <= 6 && my >= plot.y0 && my <= plot.y0 + plot.h) return { which: 'n2' };
  return null;
}


function formatTimeDiv(us) {
  if (us < 1000) return `${us} µs/div`;
  if (us < 1e6) return `${(us / 1000).toFixed(us % 1000 === 0 ? 0 : 1)} ms/div`;
  return `${(us / 1e6).toFixed(2)} s/div`;
}

function approxYDivText(vcoef_mV_per_count, z=1.0) {
  const mvPerDiv = (view.yCountsPerDiv / vcoef_mV_per_count) / (z || 1.0);
  if (mvPerDiv < 1000) return `${Math.round(mvPerDiv)} mV/div`;
  return `${(mvPerDiv / 1000).toFixed(2)} V/div`;
}

// Mapping (ported from HW.setsalmplerate thresholds + the 'samprate' values used in VB UI)
// --- Timebase mapping (G1..G9) ---
// Fine-tune all sample rates with a single multiplier if needed (1.000 = no change).
const SAMPLE_RATE_CAL = 1.0;

const SAMPLE_RATE_BY_G = {
  // G1..G5: slow mode (analogRead + loendur_rate) -> empirical values (measured vs generator)
  1: 500,     // was 520
  2: 1508,    // was 1750
  3: 2414,    // was 2800
  4: 4202,    // was 5000
  5: 10000,   // was 12400

  // G6..G9: DMA mode. Computed from ADC clock ~= 12 MHz (board config) and STM32 ADC sampling times.
  6: 47619.0476,   // 12e6 / (239.5 + 12.5) = 47.619 kHz
  7: 142857.1429,  // 12e6 / (71.5 + 12.5)  = 142.857 kHz
  8: 176470.5882,  // 12e6 / (55.5 + 12.5)  = 176.471 kHz
  9: 222222.2222,  // 12e6 / (41.5 + 12.5)  = 222.222 kHz
};

function usPerDivFromG(g) {
  const sr = (SAMPLE_RATE_BY_G[g] ?? 48000) * SAMPLE_RATE_CAL;
  // 1024 samples across 10 divisions
  return (NUM_SAMPLES / sr) / 10 * 1e6;
}

function pickClosestG(targetUs) {
  let bestG = 9;
  let bestErr = Infinity;
  for (let g = 1; g <= 9; g++) {
    const err = Math.abs(usPerDivFromG(g) - targetUs);
    if (err < bestErr) { bestErr = err; bestG = g; }
  }
  return bestG;
}

function setXActive(gStr) {
  ui.xBtns.forEach((b) => b.classList.toggle('active', b.dataset.g === gStr));
}

function mapSamplerateFromPseudo(sisend) {
  let code = 0;
  let sr = 48000;
  if (sisend > 0) { code = 1; sr = 520; }
  if (sisend > 20) { code = 2; sr = 1750; }
  if (sisend > 40) { code = 3; sr = 2800; }
  if (sisend > 80) { code = 4; sr = 5000; }
  if (sisend > 160) { code = 5; sr = 12400; }
  if (sisend > 320) { code = 6; sr = 55100; }
  if (sisend > 700) { code = 7; sr = 160000; }
  if (sisend > 1600) { code = 8; sr = 200000; }
  if (sisend > 3200) { code = 9; sr = 250000; }
  return { code, sampleRateHz: sr };
}

function timeDivToPseudoSagedus(usPerDiv) {
  const ms = usPerDiv / 1000;
  const totalSec = (ms * 10) / 1000; // 10 div across
  const approxHz = 1 / Math.max(totalSec, 1e-6);
  return approxHz;
}
