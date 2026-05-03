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

/* SERIAL CONNECTION FUNCTIONS ----------------------------------------------------------------- */
// serial connection variables
let baudRate = 115200;
let port = null;
let reader = null;
let writer = null;
let readLoop = null;
let isConnected = false;
// timing / buffering variables
const MAX_BUFFER_SIZE = 65536;
let receiveBuffer = [];
let lastReceiveTime = 0;
let bufferTimeout = null;
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
  const inputAmp1 = document.getElementById('ch1-type');
  const inputAmp2 = document.getElementById('ch2-type');

  const freq = Number.parseInt(inputFreq?.value ?? '0', 10) >>> 0;  // uint32
  const type = Number.parseInt(inputType?.value ?? '0', 10) & 0x03; // 2 bits
  const attn = Number.parseInt(inputAttn?.value ?? '0', 10) & 0x03; // 2 bits
  const trig = Number.parseInt(inputTrig?.value ?? '0', 10) >>> 0;  // uint16
  const amp1 = Number.parseInt(inputAmp1?.value ?? '0', 10) & 0x01; // 1 bit
  const amp2 = Number.parseInt(inputAmp2?.value ?? '0', 10) & 0x01; // 1 bit
  
  // clamp input frequency and show it in the UI
  const freqClamped = Math.min(Math.max(freq, 10), 50000) >>> 0;
  inputFreq.value = freqClamped;

  // sample rate adjustment
  if (freq <= 1000) {
		sampleRateHz = 10000;
	} else if (freq <= 5000) {
		sampleRateHz = 50000;
	} else if (freq <= 10000) {
		sampleRateHz = 100000;
	} else {
		sampleRateHz = 300000;
	}

  const mode = (amp1 << 5) | (amp2 << 4) | (type << 2) | (attn);

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

/* DATA PROCESSING FUNCTIONS ------------------------------------------------------------------- */
// USB protocol constants
const usbMagic = [0x69, 0xF7, 0x69, 0xF7, 0x00];
const usbHeaderSize = 16;
const payloadTotalSize = 4096;  // includes only ADC1/2 data as 8b values
// frame state variables
let rxBuffer = [];
let frameBuffer = null;
let frameOffset = 0;            // no offset by default
let expectedIndex = 0;          // first index of a frame is 0

/**
 * Find MAGIC header from USB buffer.
 *
 * @param {Array} buffer data in buffer
 * @returns index of first MAGIC byte or -1 if not found
 */
function findMagic(buffer)
{
  for (let i=0; i<=buffer.length-5; i++) {
    let match = true;
    for (let j=0; j<5; j++) {
      if (buffer[i + j] !== usbMagic[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Process received data.
 *
 * @param {Uint8Array} data incoming data as uint8 values
 * @returns null
 */
function processReceivedData(data)
{
  rxBuffer.push(...data); // incoming data chuncks are appended to rolling buffer

  while (true) {
    if (rxBuffer.length < usbHeaderSize) return;  // header won't fit

    // find magic bytes from the buffer
    let magicIndex = findMagic(rxBuffer);
    if (magicIndex === -1) {  // no magic match, keep last 4 bytes
      rxBuffer = rxBuffer.slice(-4);
      return;
    }
    // if magic bytes are not the first in the array discard bytes til magic
    if (magicIndex > 0) {
      rxBuffer = rxBuffer.slice(magicIndex);
    }
    // magic is the first in the buffer, but header is incomplete
    if (rxBuffer.length < usbHeaderSize) return;

    // parse header
    const packetIndex = rxBuffer[5];
    const ctrlSum1 = (rxBuffer[6] << 24) |
                      (rxBuffer[7] << 16) |
                      (rxBuffer[8] << 8) |
                      (rxBuffer[9]);
    const ctrlSum2 = (rxBuffer[10] << 24) |
                      (rxBuffer[11] << 16) |
                      (rxBuffer[12] << 8) |
                      (rxBuffer[13]);
    const payloadLen = (rxBuffer[14] << 8) | (rxBuffer[15]);
    const packetSize = usbHeaderSize + payloadLen;

    // packet not full
    if (rxBuffer.length < packetSize) return;

    // extract payload
    const payload = rxBuffer.slice(16, 16 + payloadLen);

    // start a new frame if packet index is 0
    if (packetIndex === 0) {
      frameBuffer = new Uint8Array(payloadTotalSize);
      frameOffset = 0;
      expectedIndex = 0;
    }

    if (frameBuffer && packetIndex === expectedIndex) {
      frameBuffer.set(payload, frameOffset);
      frameOffset += payloadLen;
      expectedIndex++;
      
      if (expectedIndex === 5) {  // frame complete
        if (frameOffset === payloadTotalSize) {
          divideDataIntoChannels(frameBuffer);
        } else {
          console.warn("Frame size mismatch:", frameOffset);
        }
        // reset index for the next frame
        frameBuffer = null;
        expectedIndex = 0;
        frameOffset = 0;
      }
    } else {  // reset out of sync frame
      frameBuffer = null;
      expectedIndex = 0;
      frameOffset = 0;
      console.warn("Frame out of sync!");
    }

    // remove processed packet from the ring buffer
    rxBuffer = rxBuffer.slice(packetSize);
  }
}

/**
 * Divide raw ADC values into two channels.
 * 
 * @param {Uint8Array} frameBuf
 */
function divideDataIntoChannels(frameBuf)
{
  const sampleCount = frameBuf.length >> 1; // bitshift division by 2 -> 2048
  const channelLength = sampleCount >> 1;   // 2048 / 2 -> 1024 per channel
  const ch1Values = new Int16Array(channelLength);
  const ch2Values = new Int16Array(channelLength);

  let channelIndex = 0;
  // data is formatted - [CH1_H, CH1_L, CH2_H, CH2_L, ...]
  for (let i=0; i<frameBuf.length; i+=4) {
    let val1 = (frameBuf[i] << 8) | frameBuf[i + 1];
    let val2 = (frameBuf[i + 2] << 8) | frameBuf[i + 3];
    ch1Values[channelIndex] = val1;
    ch2Values[channelIndex] = val2;
    channelIndex++;
  }
  plotFrame(ch1Values, ch2Values);
}

/* SCOPE DRAWING FUNCTIONS --------------------------------------------------------------------- */
// scope constants
const zeroVoltLevel = 2047;
const adcTomV = (3300 / 4095) * 3.05; // (ADC ref mV) / (ADC max val) * (hardware gain comp)
const xDivs = 10;
const yDivs = 8;
// scope & canvas variables
let gridCanvas, gridCtx;
let canvas, ctx;
let isRunning = true;
let triggerLevel = 2047;
let sampleRateHz = 10000;
let timeMsPerDiv = 1;
let samplesPerScreen, ch1ScaleFactor, ch2ScaleFactor;
let padding = 10;

/**
 * Update the value of triggerLevel upon change.
 */
function updateTriggerLevel()
{
  const slider = document.getElementById('gen-trig');
  if (!slider) return;
  triggerLevel = Number(slider.value);
}

/**
 * Update the values of timeMsPerDiv, ch1mVPerDiv and ch2mVPerDiv.
 */
function updateScopeScales()
{
  const timeSel = document.getElementById('time-scale');
  const ch1Sel = document.getElementById('ch1-scale');
  const ch2Sel = document.getElementById('ch2-scale');

  // calculate amount of samples on the screen
  if (timeSel) samplesPerScreen = Math.floor((sampleRateHz*Number(timeSel.value)*xDivs) / 1000);
  // calculate voltage scales
  const yPixelsPerDiv = (canvas.height - 2*padding) / yDivs;
  if (ch1Sel) ch1ScaleFactor = yPixelsPerDiv / Number(ch1Sel.value);
  if (ch2Sel) ch2ScaleFactor = yPixelsPerDiv / Number(ch2Sel.value);
}

/**
 * Update variables on load & add hooks.
 */
window.addEventListener('DOMContentLoaded', () => {
  gridCanvas = document.createElement('canvas');
  gridCtx = gridCanvas.getContext('2d');
  canvas = document.getElementById('screen');
  ctx = canvas.getContext('2d');
  drawGrid(canvas.width, canvas.height);

  document.getElementById('time-scale')?.addEventListener('change', updateScopeScales);
  document.getElementById('ch1-scale')?.addEventListener('change', updateScopeScales);
  document.getElementById('ch2-scale')?.addEventListener('change', updateScopeScales);
  // also update scale selections
  updateScopeScales();
});


/**
 * Toggle scope display update.
 */
function toggleDisplayUpdate()
{
  const btn = document.getElementById('stopBtn');
  
  isRunning = !isRunning;
  btn.classList.toggle('active');
  btn.textContent = isRunning ? 'STOP' : 'RUN';
}

/**
 * Draw the oscilloscope background grid.
 *
 * @param {*} width
 * @param {*} height
 */
function drawGrid(width, height)
{
  const xStep = (width - 2 * padding) / xDivs;
  const yStep = (height - 2 * padding) / yDivs;
  gridCanvas.width = width;
  gridCanvas.height = height;

  gridCtx.save();

  // clear background
  gridCtx.fillStyle = isLightTheme ? '#FFFFFF' : '#000000';
  gridCtx.fillRect(0, 0, width, height);
  
  // grid style depending on theme
  gridCtx.strokeStyle = isLightTheme ? '#BABABA' : '#404040';
  gridCtx.lineWidth = 1;
  gridCtx.beginPath();
  // vertical lines
  for (let i=0; i<=xDivs; i++) {
    const x = padding + i*xStep;
    gridCtx.moveTo(x, padding);
    gridCtx.lineTo(x, height-padding);
  }
  // horizontal lines
  for (let i=0; i<=yDivs; i++) {
    const y = padding + i*yStep;
    gridCtx.moveTo(padding, y);
    gridCtx.lineTo(width-padding, y);
  }
  gridCtx.stroke();

  // horizontal centre
  gridCtx.strokeStyle = isLightTheme ? '#404040' : '#BABABA';
  gridCtx.lineWidth = 1.5;
  gridCtx.beginPath();
  const centerY = padding + (height - 2 * padding) / 2;
  gridCtx.moveTo(padding, centerY);
  gridCtx.lineTo(width-padding, centerY);
  gridCtx.stroke();

  gridCtx.restore();
}

/**
 * Draw trigger level line (scaled to CH1).
 *
 * @param {*} width
 * @param {*} height
 */
function drawTrigger(width, height)
{
  const mV = (triggerLevel - zeroVoltLevel) * adcTomV;
  // clamp to visible scope area
  const clampedY = Math.max(padding, Math.min(height-padding, (height/2) - (mV*ch1ScaleFactor)));

  ctx.save();
  // dashed trigger line
  ctx.strokeStyle = "#ff0088";
  ctx.lineWidth = 1.2;
  ctx.setLineDash([16, 8]);

  ctx.beginPath();
  ctx.moveTo(padding, clampedY);
  ctx.lineTo(width-padding, clampedY);
  ctx.stroke();

  ctx.restore();
}

/**
 * Plot full scope frame.
 *
 * @param {Uint8Array} ch1 readings from ADC1
 * @param {Uint8Array} ch2 readings from ADC1
 * @returns null
 */
function plotFrame(ch1, ch2) {
  if (!isRunning || !canvas || !ctx) return;

  const width = canvas.width;
  const height = canvas.height;

  // background grid and trigger line
  ctx.drawImage(gridCanvas, 0, 0);
  drawTrigger(width, height);
  //drawTrigger(ctx, padding, width, height);

  // time scaling (ms)
  const visibleSamples = Math.min(samplesPerScreen, ch1.length);  // in case not enough data
  if (visibleSamples === 0) return;
  const xStep = (width - 2*padding) / visibleSamples;

  // calculate data
  measureAndUpdate(ch1, ch2, visibleSamples);

  // draw ch1 data
  ctx.save();
  ctx.strokeStyle = "#94b1ff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  for (let i=0; i<visibleSamples; i++) {
    const x = padding + i*xStep;
    const mV = (ch1[i]-zeroVoltLevel) * adcTomV;
    const y = Math.max(padding, Math.min(height-padding, (height/2) - (mV*ch1ScaleFactor)));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  // draw ch2 data
  ctx.save();
  ctx.strokeStyle = "#ff6600";
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  for (let i=0; i<visibleSamples; i++) {
    const x = padding + i*xStep;
    const mV = (ch2[i] - zeroVoltLevel) * adcTomV;
    const y = Math.max(padding, Math.min(height-padding, (height/2) - (mV*ch2ScaleFactor)));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}











/* -------------------- MEASUREMENTS (RMS / FREQ / PHASE) -------------------- */

// How often to COMPUTE (we still push samples every call)
const MEAS_EVERY_N_FRAMES = 3;
let _measFrameCounter = 0;

// Rolling buffer (ADC counts stored as floats)
const MEAS_BUFFER_LEN = 8192;          // ~0.82 s at 10 kHz
const MEAS_WINDOW_SEC = 0.60;          // ~0.60 s window for calculations
const MIN_MEAS_SAMPLES = 512;          // avoid too-short windows

const measBuf1 = new Float32Array(MEAS_BUFFER_LEN);
const measBuf2 = new Float32Array(MEAS_BUFFER_LEN);
let measIndex = 0;
let measCount = 0;                     // number of valid samples in buffer (<= MEAS_BUFFER_LEN)

// Scratch buffers for contiguous window extraction (allocated once)
const win1 = new Float32Array(MEAS_BUFFER_LEN);
const win2 = new Float32Array(MEAS_BUFFER_LEN);

/**
 * Push one frame of samples into the rolling measurement buffer.
 * ch1/ch2 can be Uint16Array, Array<number>, etc.
 */
function pushMeasurementData(ch1, ch2) {
  const n = Math.min(ch1.length, ch2.length);
  for (let i = 0; i < n; i++) {
    measBuf1[measIndex] = ch1[i];
    measBuf2[measIndex] = ch2[i];

    measIndex++;
    if (measIndex >= MEAS_BUFFER_LEN) measIndex = 0;

    if (measCount < MEAS_BUFFER_LEN) measCount++;
  }
}

/**
 * Extract last N samples from rolling buffers into win1/win2 as contiguous arrays.
 * Returns { x, y, N } where x/y are the scratch arrays and N is the valid length.
 */
function getLatestWindow(sampleRateHz) {
  // Desired N based on seconds, clamped to available history
  let N = Math.floor(sampleRateHz * MEAS_WINDOW_SEC);
  N = Math.max(MIN_MEAS_SAMPLES, N);
  N = Math.min(N, measCount, MEAS_BUFFER_LEN);

  if (N < MIN_MEAS_SAMPLES) return { x: null, y: null, N: 0 };

  // Start index of the last N samples in the circular buffer
  let start = measIndex - N;
  if (start < 0) start += MEAS_BUFFER_LEN;

  // Copy into contiguous scratch arrays
  for (let i = 0; i < N; i++) {
    const idx = (start + i);
    const j = (idx >= MEAS_BUFFER_LEN) ? (idx - MEAS_BUFFER_LEN) : idx;
    win1[i] = measBuf1[j];
    win2[i] = measBuf2[j];
  }

  return { x: win1, y: win2, N };
}

function wrap180(deg) {
  deg = ((deg + 180) % 360 + 360) % 360 - 180;
  return deg;
}

/**
 * AC RMS in mV around offsetCounts (e.g. zeroVoltLevel).
 */
function computeRmsMv(adc, offsetCounts, mvPerCount, N) {
  let sumSq = 0.0;
  for (let i = 0; i < N; i++) {
    const xMv = (adc[i] - offsetCounts) * mvPerCount;
    sumSq += xMv * xMv;
  }
  return Math.sqrt(sumSq / Math.max(1, N));
}

/**
 * Rising zero-crossing + linear interpolation + linear regression on crossing indices.
 * More stable than "average period" because it uses all crossings.
 *
 * Returns { freqHz, crossingsCount }
 */
function estimateFreqZeroCrossLR(adc, sampleRateHz, offsetCounts, N) {
  const HYST = 6; // ADC counts; tune if needed

  // Collect fractional crossing indices
  const crossings = [];
  let prev = adc[0] - offsetCounts;

  for (let i = 1; i < N; i++) {
    const cur = adc[i] - offsetCounts;

    if (prev < -HYST && cur >= HYST) {
      // Linear interpolation of the zero-crossing
      const t = prev / (prev - cur);          // 0..1
      crossings.push((i - 1) + t);
    }
    prev = cur;
  }

  // Need >= 3 crossings (>= 2 periods) for stability
  if (crossings.length < 3) return { freqHz: NaN, crossingsCount: crossings.length };

  // Linear regression: crossings[k] ≈ a + k * periodSamples
  let sumK = 0, sumI = 0, sumKK = 0, sumKI = 0;
  for (let k = 0; k < crossings.length; k++) {
    const idx = crossings[k];
    sumK += k;
    sumI += idx;
    sumKK += k * k;
    sumKI += k * idx;
  }
  const n = crossings.length;
  const denom = (n * sumKK - sumK * sumK);
  if (denom === 0) return { freqHz: NaN, crossingsCount: crossings.length };

  const periodSamples = (n * sumKI - sumK * sumI) / denom;
  const freqHz = sampleRateHz / periodSamples;

  // Sanity
  if (!Number.isFinite(freqHz) || freqHz <= 0) return { freqHz: NaN, crossingsCount: crossings.length };

  return { freqHz, crossingsCount: crossings.length };
}

/**
 * Normalised bounded cross-correlation to estimate delay (lag in samples).
 * We search only within +/- maxLag (keeps it fast and avoids wrong peaks).
 * Lag at max correlation is the time shift. [3](https://stackoverflow.com/questions/41492882/find-time-shift-of-two-signals-using-cross-correlation)[4](https://www.mathworks.com/help/matlab/ref/xcorr.html)
 *
 * Returns fractional lag (sub-sample refined via parabola fit).
 */
function estimateDelayXCorr(x, y, N, maxLag) {
  // Mean remove
  let meanX = 0, meanY = 0;
  for (let i = 0; i < N; i++) { meanX += x[i]; meanY += y[i]; }
  meanX /= N; meanY /= N;

  // Amplitude normalisation (stabilises correlation peak when amplitudes differ)
  let maxX = 1e-9, maxY = 1e-9;
  for (let i = 0; i < N; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax > maxX) maxX = ax;
    if (ay > maxY) maxY = ay;
  }

  // Helper: correlation at a specific lag using normalised sequences
  function corrAtLag(lag) {
    let s = 0;
    const i0 = Math.max(0, -lag);
    const i1 = Math.min(N, N - lag);
    for (let i = i0; i < i1; i++) {
      const a = (x[i] - meanX) / maxX;
      const b = (y[i + lag] - meanY) / maxY;
      s += a * b;
    }
    // Normalise by overlap length so different lags compare fairly
    const L = Math.max(1, i1 - i0);
    return s / L;
  }

  let bestLag = 0;
  let bestCorr = -Infinity;

  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const c = corrAtLag(lag);
    if (c > bestCorr) { bestCorr = c; bestLag = lag; }
  }

  // Sub-sample refinement (parabolic interpolation around peak)
  if (bestLag > -maxLag && bestLag < maxLag) {
    const cM1 = corrAtLag(bestLag - 1);
    const c0  = corrAtLag(bestLag);
    const cP1 = corrAtLag(bestLag + 1);
    const denom = (cM1 - 2 * c0 + cP1);
    if (denom !== 0) {
      const delta = 0.5 * (cM1 - cP1) / denom;    // usually [-0.5..0.5]
      return bestLag + delta;
    }
  }

  return bestLag;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function updateReadingsUI({ ch1RmsMv, ch2RmsMv, ch1FreqHz, ch2FreqHz, phaseDeg }) {
  const fmtRms = (mv) => {
    if (!Number.isFinite(mv)) return "-";
    if (mv >= 1000) return (mv / 1000).toFixed(3) + " V";
    return mv.toFixed(1) + " mV";
  };

  const fmtFreq = (hz) => {
    if (!Number.isFinite(hz)) return "-";
    if (hz >= 1000) return (hz / 1000).toFixed(2) + " kHz";
    return hz.toFixed(2) + " Hz";
  };

  const fmtPhase = (deg) => {
    if (!Number.isFinite(deg)) return "-";
    return deg.toFixed(1) + "°";
  };

  setText("ch1-rms",  fmtRms(ch1RmsMv));
  setText("ch2-rms",  fmtRms(ch2RmsMv));
  setText("ch1-freq", fmtFreq(ch1FreqHz));
  setText("ch2-freq", fmtFreq(ch2FreqHz));
  setText("m-phase",  fmtPhase(phaseDeg));
}

/**
 * Main entry:
 * Call measureAndUpdate(ch1, ch2) once per received frame (e.g., from plotFrame()).
 *
 * - Always pushes samples into rolling buffer.
 * - Computes every MEAS_EVERY_N_FRAMES frames.
 */
function measureAndUpdate(ch1, ch2) {
  // Always push new data (critical so the rolling buffer stays up-to-date)
  pushMeasurementData(ch1, ch2);

  // Throttle compute (but not pushing)
  _measFrameCounter++;
  if ((_measFrameCounter % MEAS_EVERY_N_FRAMES) !== 0) return;

  // Need enough history
  const { x, y, N } = getLatestWindow(sampleRateHz);
  if (!x || !y || N < MIN_MEAS_SAMPLES) return;

  // Scale factor for converting counts -> mV (same as your drawing)
  const mvPerCount = adcTomV;

  // RMS over the measurement window
  const ch1RmsMv = computeRmsMv(x, zeroVoltLevel, mvPerCount, N);
  const ch2RmsMv = computeRmsMv(y, zeroVoltLevel, mvPerCount, N);

  // Frequency per channel (needs multiple cycles at low Hz) [1](https://www.raymaps.com/index.php/frequency-estimation-using-zero-crossing-method/)[2](https://e2e.ti.com/cfs-file/__key/telligent-evolution-components-attachments/00-14-01-00-00-66-61-09/Zero-Crossing-detection-Methods.pdf)
  const f1 = estimateFreqZeroCrossLR(x, sampleRateHz, zeroVoltLevel, N);
  const f2 = estimateFreqZeroCrossLR(y, sampleRateHz, zeroVoltLevel, N);
  const ch1FreqHz = f1.freqHz;
  const ch2FreqHz = f2.freqHz;

  // Choose frequency for phase conversion
  const f =
    (Number.isFinite(ch1FreqHz) && Number.isFinite(ch2FreqHz)) ? 0.5 * (ch1FreqHz + ch2FreqHz) :
    (Number.isFinite(ch1FreqHz) ? ch1FreqHz :
    (Number.isFinite(ch2FreqHz) ? ch2FreqHz : NaN));

  // Phase via correlation delay (bounded)
  let phaseDeg = NaN;
  if (Number.isFinite(f) && f >= 5) {
    // Search within +/- half period (in samples), and also keep it bounded by N/3
    const halfPeriod = Math.max(2, Math.floor(sampleRateHz / (2 * f)));
    const maxLag = Math.max(2, Math.min(halfPeriod, Math.floor(N / 3)));

    const lag = estimateDelayXCorr(x, y, N, maxLag);
    const dt = lag / sampleRateHz;

    // phi = 360 * f * dt [5](https://sengpielaudio.com/calculator-timedelayphase.htm)
    phaseDeg = wrap180(360.0 * f * dt);
  }

  updateReadingsUI({ ch1RmsMv, ch2RmsMv, ch1FreqHz, ch2FreqHz, phaseDeg });
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
