/* SERIAL CONNECTION VARIABLES ----------------------------------------------------------------- */
let baudRate = 115200;
let port = null;
let reader = null;
let writer = null;
let readLoop = null;
let isConnected = false;
let rxBytes = 0;
let txBytes = 0;

/* TIMING/BUFFERING VARIABLES ------------------------------------------------------------------ */
let receiveBuffer = [];
let lastReceiveTime = 0;
let bufferTimeout = null;
const MAX_BUFFER_SIZE = 65536;

/* DATA VARIABLES ------------------------------------------------------------------------------ */
let isRunning = true;
let triggerLevel = 2047;

// data
const MARKER = Uint8Array.from([0x0F, 0xA6, 0x0F, 0xA6, 0x0F, 0xA6]);

let markerIndex = 0;
let collecting = false;
let payload = [];
let markerBuf = []; // holds bytes that may belong to marker


// ===== SCOPE DISPLAY CONSTANTS =====
const ADC_MAX = 4095;
const VREF = 3.3;          // set to your ADC reference / frontend scaling
const H_DIVS = 10;         // horizontal divisions
const V_DIVS = 8;          // vertical divisions

// If you interpolate with upFactor=4 before plotting:
const INTERP_UP = 4;

// Set this to your real sample rate (before interpolation).
// From your earlier setup, you mentioned TIM3 ~ 500 kHz triggering ADC:
let sampleRateHz = 100000;

// 0V reference as ADC code (midscale for bipolar display)
let ch1ZeroCode = 2047;
let ch2ZeroCode = 2047;

// cached UI scales (updated from selects)
let timeMsPerDiv = 10;
let ch1mVPerDiv = 250;
let ch2mVPerDiv = 250;

/* CHECK BROWSER SUPPORT ----------------------------------------------------------------------- */
//if (!('serial' in navigator)) {
//    alert('Web Serial API is not supported in this browser. Please use Chrome, Edge, or Opera.');
// TODO: ADD HTML WARNING
//}

/* SERIAL TIMEOUT ------------------------------------------------------------------------------ */
/**
 * Show timeout warning.
 *
 * @param {boolean} show - true or false
 */
function showTimeoutWarning(show)
{
  const element = document.getElementById('connTimeout');
  if(element) element.style.display = show ? 'inline' : 'none';
}

/**
 * Force serial to disconnect.
 */
function forceDisconnect()
{
  console.log('Force disconnect');
  disconnect(true);
}

/* MAIN SERIAL CONNECTION FUNCTIONS ------------------------------------------------------------ */
/**
 * Toggle serial connection.
 *
 * @returns null if baud rate out of range
 */
async function toggleConnection()
{
  const btn = document.getElementById('connectBtn');
  if (!isConnected) {
    flushReceiveBuffer();
    try{
      port = await navigator.serial.requestPort();
      if (!baudRate||baudRate<1||baudRate>10000000) {
        alert('Invalid baud rate configuration (1-10,000,000)');
        return;
      }
      const options = {baudRate:baudRate,dataBits:8,stopBits:1,parity:"none",flowControl:"none",bufferSize:8192};
      await port.open(options);

      if (port.readable) {
        const flushReader = port.readable.getReader();
        await flushReader.cancel();
        flushReader.releaseLock();
      }
      writer = port.writable.getWriter();
      reader = port.readable.getReader();
      isConnected = true;
      btn.textContent='DISCON';
      btn.classList.add('active');  // TODO: ADD CSS CLASS "ACTIVE"
      updateStatus(true);
      showTimeoutWarning(false);
      readLoop = readData();  // TODO: ???
    } catch (err) {
      console.error('Connection error:', err);
      // skip alert if user cancelled port selection
      if (err.name!=='NotFoundError'&&!err.message?.includes('No port selected')) {
        alert('Failed to connect: ' + err.message);
      }
      await disconnect();
    }
  } else {await disconnect();}
}

/**
 * Disconnect serial port.
 *
 * @param {boolean} force - true or false -> force disconnect?
 */
async function disconnect(force=false)
{
  const btn = document.getElementById('connectBtn');
  btn.disabled = true;
  isConnected = false;
  updateStatus(false);
  showTimeoutWarning(false);

  if (bufferTimeout) {
    clearTimeout(bufferTimeout);
    bufferTimeout=null;
  }
  receiveBuffer=[];

  if (reader) {
    try {
      const cancelPromise = reader.cancel();
      const timeoutPromise = new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')), 2000));
      await Promise.race([cancelPromise, timeoutPromise]);
    } catch (e) {console.warn('Reader cancel failed:', e);}
    try {reader.releaseLock();} catch (e) {}
    reader = null;
  }

  if (writer) {
    try {writer.releaseLock();} catch (e) {}
    writer = null;
  }

  if (port) {
    try {
      const closePromise = port.close();
      const timeoutPromise = new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')), 3000));
      await Promise.race([closePromise, timeoutPromise]);
    } catch (e) {
      console.warn('Port close failed:', e);
      if (port && 'forget' in port) try {await port.forget();} catch (e2) {}
    }
    port = null;
  }

  btn.textContent='CONNECT';
  btn.classList.remove('active');
  btn.disabled = false;
}

/**
 * Read data from serial port.
 */
async function readData()
{
  let stuckTimer = null;
  try {
    while (isConnected&&reader) {
      stuckTimer = setTimeout(()=>{if (isConnected) showTimeoutWarning(true);}, 5000);
      let result;
      try {result = await reader.read();} finally {clearTimeout(stuckTimer);}
      const {value, done} = result;
      if (done) break;
      if (value&&value.length>0) {
        showTimeoutWarning(false);
        const now = Date.now();
        const timingEnabled = false;
        const timingThreshold = 50000;
        if (timingEnabled) {
          const timeSinceLast = (now-lastReceiveTime);
          if (timeSinceLast>timingThreshold&&receiveBuffer.length>0) flushReceiveBuffer();
          if (receiveBuffer.length+value.length>MAX_BUFFER_SIZE) flushReceiveBuffer();
          receiveBuffer.push(...value);
          lastReceiveTime = now;
          if (bufferTimeout) clearTimeout(bufferTimeout);
          bufferTimeout = setTimeout(()=>{if (receiveBuffer.length>0) flushReceiveBuffer();}, Math.max(timingThreshold+10, 50));
        } else {processReceivedData(value);}
      }
      await new Promise(resolve=>setTimeout(resolve, 0));
    }
  } catch (err) {
    if (isConnected) {
      console.error('Read error:', err);
      if (err.name==='NetworkError'||err.message.includes('device disconnected')) {
        await disconnect();
      } else {
        showTimeoutWarning(true);
        setTimeout(()=>{if (isConnected) showTimeoutWarning(false);}, 3000);
      }
    }
  } finally {if (stuckTimer) clearTimeout(stuckTimer);}
}

/**
 * Flush receive buffer.
 *
 * @returns null if receive buffer is empty
 */
function flushReceiveBuffer()
{
  if (receiveBuffer.length === 0) return;

  const data = new Uint8Array(receiveBuffer);
  processReceivedData(data);
  receiveBuffer = [];
}

/**
 * Process received data.
 *
 * @param {Uint8Array} data - data array to be processed
 */

function processReceivedData(data)
{
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];

    if (byte === MARKER[markerIndex]) {
      markerBuf.push(byte);
      markerIndex++;

      // full marker detected
      if (markerIndex === MARKER.length) {
        markerIndex = 0;
        markerBuf.length = 0;

        if (collecting) {
          handleFrame(Uint8Array.from(payload));
          payload = [];
        }

        collecting = true;
      }

      continue;
    }

    // marker match failed
    if (markerIndex > 0) {
      // bytes in markerBuf are NOT marker → flush them safely
      if (collecting) {
        payload.push(...markerBuf);
      }
      markerBuf.length = 0;
      markerIndex = 0;
    }

    // normal payload byte
    if (collecting) {
      payload.push(byte);
    }
  }
}


/**
 * Send commands to MCU as hex values.
 *
 * @returns null at failure
 */
async function sendHex()
{
  if (!isConnected || !writer) {
    alert('Please connect to ISC Scope first!');
    return;
  }

  const inputFreq = document.getElementById('gen-freq');
  const inputType = document.getElementById('gen-wave');
  const inputAttn = document.getElementById('gen-attn');
  const inputTrig = document.getElementById('gen-trig');

  const freq = Number.parseInt(inputFreq?.value ?? '0', 10) >>> 0;  // uint32
  const type = Number.parseInt(inputType?.value ?? '0', 10) & 0x03; // 2 bits
  const attn = Number.parseInt(inputAttn?.value ?? '0', 10) & 0x03; // 2 bits
  const trig = Number.parseInt(inputTrig?.value ?? '0', 10) >>> 0;  // uint16

  // clamp input frequency
  const freqClamped = Math.min(Math.max(freq, 10), 50000) >>> 0;

  const mode = ((type & 0x03) << 2) | (attn & 0x03);

  const data = new Uint8Array([
    0x47, 0xF7, 0xF7,
    (trig >>>  8) & 0xFF,
    (trig >>>  0) & 0xFF,
    mode,
    (freqClamped >>> 24) & 0xFF,
    (freqClamped >>> 16) & 0xFF,
    (freqClamped >>>  8) & 0xFF,
    (freqClamped >>>  0) & 0xFF
  ]);

  try {
    await writer.write(data);
    console.log('CMD sent!', data);
  } catch (err) {
    console.error('Send error:', err);
    alert('Failed to send: ' + err.message);
  }
}

/**
 * Toggle scope display update.
 */
function toggleStop()
{
  const btn = document.getElementById('stopBtn');

  isRunning = !isRunning;
  btn.classList.toggle('active');
  btn.textContent = isRunning ? 'STOP' : 'RUN';
}

function sinc(x)
{
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function hamming(n, N)
{
  return 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (N - 1));
}

function sincInterpolate(input, upFactor = 4, radius = 8)
{
  const inLen = input.length;
  const outLen = inLen * upFactor;
  const output = new Float32Array(outLen);

  const kernelSize = radius * 2 + 1;

  for (let i = 0; i < outLen; i++) {
    const t = i / upFactor;
    const idx = Math.floor(t);

    let sum = 0;
    let norm = 0;

    for (let k = -radius; k <= radius; k++) {
      const n = idx + k;
      if (n < 0 || n >= inLen) continue;

      const x = t - n;
      const w = hamming(k + radius, kernelSize);
      const s = sinc(x) * w;

      sum += input[n] * s;
      norm += s;
    }

    output[i] = norm !== 0 ? sum / norm : 0;
  }

  return output;
}

function handleFrame(frameU8)
{
  // Must contain at least 2 channels (4 bytes)
  if (frameU8.length < 8) return;

  // Drop first CH1+CH2 sample (ADC warm‑up)
  let offset = 0;

  let usableLen = frameU8.length - offset;
  usableLen -= (usableLen % 4);
  if (usableLen <= 0) return;

  const sampleCount = usableLen / 4;
  const ch1 = new Uint16Array(sampleCount);
  const ch2 = new Uint16Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const b = offset + i * 4;
    ch1[i] = (frameU8[b] << 8) | frameU8[b + 1];
    ch2[i] = (frameU8[b + 2] << 8) | frameU8[b + 3];
  }

  
const ch1f = Float32Array.from(ch1);
const ch2f = Float32Array.from(ch2);

const ch1Interp = sincInterpolate(ch1f, 4);
const ch2Interp = sincInterpolate(ch2f, 4);

plotFrame(ch1Interp, ch2Interp);
}

function drawGrid(ctx, padding, w, h)
{
  const x0 = padding;
  const y0 = padding;
  const x1 = padding + w;
  const y1 = padding + h;

  const pxPerDivX = w / H_DIVS;
  const pxPerDivY = h / V_DIVS;

  // theme-friendly grid colours
  const isLight = document.body.classList.contains('light');
  const major = isLight ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.14)';
  const centre = isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.30)';

  ctx.save();
  ctx.lineWidth = 1;

  // vertical major lines
  ctx.strokeStyle = major;
  for (let i = 0; i <= H_DIVS; i++) {
    const x = x0 + i * pxPerDivX;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
  }

  // horizontal major lines
  for (let j = 0; j <= V_DIVS; j++) {
    const y = y0 + j * pxPerDivY;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }

  // centre (0V) line: stronger
  const yCentre = y0 + h / 2;
  ctx.strokeStyle = centre;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(x0, yCentre);
  ctx.lineTo(x1, yCentre);
  ctx.stroke();

  // label "0V"
  ctx.setLineDash([]);
  ctx.fillStyle = centre;
  ctx.font = '11px Courier New';
  ctx.fillText('0V', x0 + 6, yCentre - 6);

  ctx.restore();
}

function codeToVolts(code, zeroCode)
{
  const voltsPerCode = VREF / ADC_MAX;
  return (code - zeroCode) * voltsPerCode * 3;
}

function voltsToCanvasY(volts, voltsPerDiv, padding, h)
{
  const yCentre = padding + h / 2;
  const pxPerDivY = h / V_DIVS;

  // positive volts go UP on a scope -> subtract
  return yCentre - (volts / voltsPerDiv) * pxPerDivY;
}

/**
 * Test canvas function.
 */
function plotFrame(data1, data2)
{
  if (!isRunning) return;

  const canvas = document.getElementById('screen');
  const ctx = canvas.getContext('2d');

  const padding = 10;
  const w = canvas.width  - 2 * padding;
  const h = canvas.height - 2 * padding;

  // refresh cached selector values (cheap; or rely on event listeners)
  updateScopesScales();

  // effective rate if you're plotting interpolated arrays
  const effectiveRateHz = sampleRateHz * INTERP_UP;

  // how many samples should fill the screen based on time/div?
  const timePerDivSec = (timeMsPerDiv / 1000);
  const samplesPerDiv = effectiveRateHz * timePerDivSec;
  const targetSamples = Math.max(16, Math.floor(samplesPerDiv * H_DIVS));

  // choose a window from the end of the arrays (like a live scope)
  const nAvail = Math.min(data1.length, data2.length);
  const windowLen = Math.min(nAvail, targetSamples);
  if (windowLen < 2) return;

  const start = nAvail - windowLen;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // ===== grid + centre line =====
  drawGrid(ctx, padding, w, h);

  // volts/div for each channel
  const ch1VoltsPerDiv = ch1mVPerDiv / 1000;
  const ch2VoltsPerDiv = ch2mVPerDiv / 1000;

  // ===== trigger line (mapped like CH1) =====
  {
    const trigVolts = codeToVolts(triggerLevel, ch1ZeroCode);
    let yTrig = voltsToCanvasY(trigVolts, ch1VoltsPerDiv, padding, h);

    // clamp to plot area
    yTrig = Math.max(padding, Math.min(padding + h, yTrig));

    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#226a87';
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(padding, yTrig);
    ctx.lineTo(padding + w, yTrig);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = '#226a87';
    ctx.font = '11px Courier New';
    ctx.fillText('TRIG', padding + 5, yTrig - 4);
    ctx.restore();
  }

  // ===== draw CH1 =====
  {
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = '#94b1ff';
    ctx.lineWidth = 2;

    
    const targetSamples = Math.floor(samplesPerDiv * H_DIVS);
    const windowLen = Math.min(nAvail, targetSamples);

    // NEW: stretch data horizontally instead of changing window
    const xStep = w / (samplesPerDiv * H_DIVS);


    for (let i = 0; i < windowLen; i++) {
      const x = padding + i * xStep;

      // data1 is interpolated float array of ADC codes; it may overshoot a bit
      const code = Math.max(0, Math.min(ADC_MAX, data1[start + i]));
      const volts = codeToVolts(code, ch1ZeroCode);
      let y = voltsToCanvasY(volts, ch1VoltsPerDiv, padding, h);

      // clamp
      y = Math.max(padding, Math.min(padding + h, y));

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.stroke();
    ctx.restore();
  }

  // ===== draw CH2 =====
  {
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = '#ff6600';
    ctx.lineWidth = 2;

    
    const targetSamples = Math.floor(samplesPerDiv * H_DIVS);
    const windowLen = Math.min(nAvail, targetSamples);

    // NEW: stretch data horizontally instead of changing window
    const xStep = w / (samplesPerDiv * H_DIVS);


    for (let i = 0; i < windowLen; i++) {
      const x = padding + i * xStep;

      const code = Math.max(0, Math.min(ADC_MAX, data2[start + i]));
      const volts = codeToVolts(code, ch2ZeroCode);
      let y = voltsToCanvasY(volts, ch2VoltsPerDiv, padding, h);

      y = Math.max(padding, Math.min(padding + h, y));

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.stroke();
    ctx.restore();
  }
}

function updateTrigger()
{
  const slider = document.getElementById('gen-trig');
  if (!slider) return;
  triggerLevel = Number(slider.value) >>> 0;
}

function updateScopesScales()
{
  const tSel  = document.getElementById('time-scale');
  const c1Sel = document.getElementById('ch1-scale');
  const c2Sel = document.getElementById('ch2-scale');

  if (tSel)  timeMsPerDiv = Number(tSel.value);      // your options are in ms/div (e.g. 0.6 = 0.6 ms = 600 µs)
  if (c1Sel) ch1mVPerDiv  = Number(c1Sel.value);     // mV/div
  if (c2Sel) ch2mVPerDiv  = Number(c2Sel.value);     // mV/div
}

/**
 * Update status indicator.
 *
 * @param {boolean} connected
 */
function updateStatus(connected)
{
  const dot = document.getElementById('statusDot'); // TODO: ADD HTML "STATUS INDICATOR"
  const text = document.getElementById('statusText');
  const isLightTheme = document.body.classList.contains('light');

  if (connected) {
    dot.classList.add('connected'); // TODO: ADD CSS CLASS "DOT.CONNECTED"
    text.textContent = `Connected (${baudRate} baud)`;
    // dark green for light theme, bright green for dark theme
    text.style.color = isLightTheme ? '#1a7a3a' : '#2ed573';
  } else {
    dot.classList.remove('connected');
    text.textContent = 'Disconnected';
    // dark red for light theme, light gray for dark theme
    text.style.color = isLightTheme ? '#dc3545' : '#e0e0e0';
  }
}

/* THEME TOGGLE -------------------------------------------------------------------------------- */
let isLightTheme = false;

/**
 * Toggle site theme.
 */
function toggleTheme()
{
  isLightTheme = !isLightTheme;
  document.body.classList.toggle('light', isLightTheme);  // TODO: ADD THEMES IN CSS & TOGGLE IN HTML
  document.getElementById('themeIcon').textContent  = isLightTheme ? '☀️' : '🌙';
  document.getElementById('themeLabel').textContent = isLightTheme ? 'Light' : 'Dark';
  try {localStorage.setItem('ISCscope-theme', isLightTheme ? 'light' : 'dark');} catch(e) {}
  // refresh connection status colors immediately
  updateStatus(isConnected);
}

// restore saved theme on load
try {
  if (localStorage.getItem('ISCscope-theme') === 'light') toggleTheme();
} catch(e) {}


window.addEventListener('DOMContentLoaded', () => {
  updateScopesScales();

  document.getElementById('time-scale')?.addEventListener('change', updateScopesScales);
  document.getElementById('ch1-scale')?.addEventListener('change', updateScopesScales);
  document.getElementById('ch2-scale')?.addEventListener('change', updateScopesScales);
});
