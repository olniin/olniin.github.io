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

/* USB PROTOCOL VARIABLES ---------------------------------------------------------------------- */
const usbMagic = [0x69, 0xF7, 0x69, 0xF7, 0x00];
const usbHeaderSize = 16;
const payloadTotalSize = 4096;  // includes only ADC1/2 data as 8b values

/* FRAME STATE VARIABLES ----------------------------------------------------------------------- */
let rxBuffer = [];
let frameBuffer = null;
let frameOffset = 0;    // no offset by default
let expectedIndex = 0;  // first index of a frame is 0




// ===== SCOPE DISPLAY CONSTANTS =====
const ADC_MAX = 4095;
const VREF = 3.3;          // set to your ADC reference / frontend scaling
const H_DIVS = 10;         // horizontal divisions
const V_DIVS = 8;          // vertical divisions

// If you interpolate with upFactor=4 before plotting:
const INTERP_UP = 4;

// Set this to your real sample rate (before interpolation).
// From your earlier setup, you mentioned TIM3 ~ 500 kHz triggering ADC:




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

/* DATA PROCESSING FUNCTIONS ------------------------------------------------------------------- */

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
    console.log(packetIndex);
    console.log(payloadLen);
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
      console.log("FRAME ADDED! new offset, expectedIndex", frameOffset, expectedIndex);

      if (expectedIndex === 5) {  // frame complete
        if (frameOffset === payloadTotalSize) {
          console.log("FULL frame:", frameBuffer);
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
  console.log("CH1:", ch1Values);
  console.log("CH2:", ch2Values);

  // Pass to next stage (renderer / processing)
  //handleChannels(ch1, ch2);
  plotFrame(ch1Values, ch2Values);
}

/* SCOPE DRAWING FUNCTIONS --------------------------------------------------------------------- */
// global variable defaults
const zeroVoltLevel = 2047;
const hardwareGainComp = 3;
const xDivs = 10;
const yDivs = 8;
let triggerLevel = 2047;
let timeMsPerDiv = 1;
let ch1mVPerDiv = 250;
let ch2mVPerDiv = 250;
let isRunning = true;
let sampleRateHz = 10000;

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

  if (timeSel) timeMsPerDiv = Number(timeSel.value);  // ms/div
  if (ch1Sel) ch1mVPerDiv = Number(ch1Sel.value);     // mV/div
  if (ch2Sel) ch2mVPerDiv = Number(ch2Sel.value);     // mV/div
}

// update selections on load
window.addEventListener('DOMContentLoaded', () => {
  updateScopeScales();

  document.getElementById('time-scale')?.addEventListener('change', updateScopeScales);
  document.getElementById('ch1-scale')?.addEventListener('change', updateScopeScales);
  document.getElementById('ch2-scale')?.addEventListener('change', updateScopeScales);
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
 * @param {*} ctx
 * @param {*} padding
 * @param {*} width
 * @param {*} height
 */
function drawGrid(ctx, padding, width, height)
{
  const drawWidth = width - 2 * padding;
  const drawHeight = height - 2 * padding;
  const xStep = drawWidth / xDivs;
  const yStep = drawHeight / yDivs;

  ctx.save();

  // clear background
  ctx.fillStyle = isLightTheme ? '#FFFFFF' : '#000000';
  ctx.fillRect(0, 0, width, height);
  
  // grid style depending on theme
  ctx.strokeStyle = isLightTheme ? '#BABABA' : '#404040';
  ctx.lineWidth = 1;
  ctx.beginPath();
  // vertical lines
  for (let i=0; i<=xDivs; i++) {
    const x = padding + i*xStep;
    ctx.moveTo(x, padding);
    ctx.lineTo(x, height-padding);
  }
  // horizontal lines
  for (let i=0; i<=yDivs; i++) {
    const y = padding + i*yStep;
    ctx.moveTo(padding, y);
    ctx.lineTo(width-padding, y);
  }
  ctx.stroke();

  // horizontal centre
  ctx.strokeStyle = isLightTheme ? '#404040' : '#BABABA';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const centerY = padding + drawHeight / 2;
  ctx.moveTo(padding, centerY);
  ctx.lineTo(width-padding, centerY);
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
  if (!isRunning) return;

  const canvas = document.getElementById("screen");
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const padding = 10;
  const drawWidth = width - 2*padding;
  const drawHeight = height - 2*padding;

  // background grid and trigger line
  drawGrid(ctx, padding, width, height);
  //drawTrigger(ctx, padding, width, height);

  // time scaling (ms)
  const totalTime = timeMsPerDiv * xDivs;
  const samplesPerScreen = Math.floor((sampleRateHz * totalTime) / 1000);
  const visibleSamples = Math.min(samplesPerScreen, ch1.length);  // in case not enough data
  const xStep = drawWidth / visibleSamples;

  // voltage scaling
  const adcTomV = (3300 / 4096) * hardwareGainComp; // scale
  const yPixelsPerDiv = drawHeight / yDivs;
  const ch1ScaleFactor = yPixelsPerDiv / ch1mVPerDiv;
  const ch2ScaleFactor = yPixelsPerDiv / ch2mVPerDiv;

  // draw ch1 data
  ctx.save();
  ctx.strokeStyle = "#94b1ff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  let x = padding;
  for (let i=0; i<visibleSamples; i++) {
    const mV = (ch1[i]-zeroVoltLevel) * adcTomV;
    const y = (height/2) - (mV*ch1ScaleFactor);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    x += xStep;
  }
  ctx.stroke();
  ctx.restore();

  // draw ch2 data
  ctx.save();
  ctx.strokeStyle = "#ff6600";
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  x = padding;
  for (let i=0; i<visibleSamples; i++) {
    const mV = (ch2[i] - zeroVoltLevel) * adcTomV;
    const y = (height / 2) - (mV * ch2ScaleFactor);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    x += xStep;
  }
  ctx.stroke();
  ctx.restore();
  console.log("DRAWING DONE", ch1, ch2);
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
