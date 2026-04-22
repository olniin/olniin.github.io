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

/* DATA VARIABLES ------------------------------------------------------------------------------ */
let isRunning = true;

// data
const MARKER = Uint8Array.from([0x0F, 0xA6, 0x0F, 0xA6, 0x0F, 0xA6]);

let markerIndex = 0;
let collecting = false;
let payload = [];

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
  const element = document.getElementById('connTimeout'); // TODO: ADD THIS ELEMENT
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
  const btn = document.getElementById('connectBtn');  //TODO: ADD "CONNECT BUTTON" IN HTML
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

    /* Marker byte matching (split-safe) */
    if (byte === MARKER[markerIndex]) {
      markerIndex++;
    } else {
      markerIndex = (byte === MARKER[0]) ? 1 : 0;
    }

    /* Marker fully detected */
    if (markerIndex === MARKER.length) {
      markerIndex = 0;

      if (collecting) {
        /* Finish previous frame */
        handleFrame(Uint8Array.from(payload));
        payload = [];
      }

      /* Start collecting a new frame */
      collecting = true;
      continue; // marker bytes never included
    }

    /* Collect payload */
    if (collecting) {
      payload.push(byte);
    }
  }
}

/**
 * Send commands to MCU as hex values.
 *
 * @param {HTMLElement} btnElement
 * @returns null at failure
 *//*
async function sendHex(btnElement)  //TODO: IN HTML <button onclick="sendHex(this)">Send HEX</button>
{
  if (!isConnected) {
    alert('Please connect to ISC Scope first!');
    return;
  }

  // find the input field associated with this button // TODO: NEED FREQ, WAVE TYPE, ATTENUATION
    const row = btnElement.closest('.send-row, .dynamic-field');
    const input = row.querySelector('.hex-input, .hex-input-dynamic');

    if (!input) return;

    const inputValue = input.value.trim();
    if (!inputValue) return;

    try {
        const hexPairs = inputValue.split(/\s+/).filter(p => p.length > 0);
        const bytes = hexPairs
            .map(b => parseInt(b, 16))
            .filter(b => !isNaN(b) && b >= 0 && b <= 255);

        if (bytes.length === 0) {
            alert('Invalid HEX input');
            return;
        }

        // Validate that all hex pairs are complete (2 characters each)
        const invalidPairs = hexPairs.filter(p => p.length !== 2 || isNaN(parseInt(p, 16)));
        if (invalidPairs.length > 0) {
            alert(`Invalid HEX pairs: ${invalidPairs.join(', ')}`);
            return;
        }

        const data = new Uint8Array(bytes);
        const ending = getLineEnding();
        if (ending) {
            const endingBytes = new TextEncoder().encode(ending);
            const combined = new Uint8Array(data.length + endingBytes.length);
            combined.set(data);
            combined.set(endingBytes, data.length);
            await writer.write(combined);
            txBytes += combined.length;
            logData(combined, 'tx');
        } else {
            await writer.write(data);
            txBytes += data.length;
            logData(data, 'tx');
        }

        updateStats();
        // Input stays after sending - NOT clearing
    } catch (err) {
        console.error('Send error:', err);
        alert('Failed to send: ' + err.message);
    }
}*/

/**
 * Toggle scope display update.
 */
function toggleStop()
{
  const btn = document.getElementById('stopBtn');

  if (true) {
    isRunning = !isRunning;
    btn.classList.toggle('active');
    btn.textContent = isRunning ? 'STOP' : 'RUN';
  }
}


function handleFrame(frameU8)
{
  const len = frameU8.length;

  // Ensure even number of bytes
  if (len % 2 !== 0) {
    console.warn("Frame length is not even, dropping last byte");
  }

  const u16Count = Math.floor(len / 4);
  const frameU16ch1 = new Uint16Array(u16Count);
  const frameU16ch2 = new Uint16Array(u16Count);

  for (let i = 0; i < u16Count; i++) {
    frameU16ch1[i] = (frameU8[i * 4] << 8) | frameU8[i * 4 + 1];
    frameU16ch2[i] = (frameU8[i * 4 + 2] << 8) | frameU8[i * 4 + 3];
  }

  plotFrame(frameU16ch1, frameU16ch2);
}

/**
 * Test canvas function.
 */
function plotFrame(data1, data2)
{
  //const data = [10, 40, 25, 60, 80, 30, 50, 90, 70];
  const canvas = document.getElementById("screen");
  const ctx = canvas.getContext('2d');

  const padding = 10;
  const w = canvas.width - 2 * padding;
  const h = canvas.height - 2 * padding;

  // min & max from ADC:
  const maxVal = 4095;
  const minVal = 0;
  const xStep = w / (512-1);

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.beginPath();
  ctx.strokeStyle = '#94b1ff';
  ctx.lineWidth = 2;

  data1.forEach((value, index) => {
    const x = padding + index * xStep;

    // Invert Y-axis for canvas coordinates
    const y = padding + h - ((value - minVal) / (maxVal - minVal)) * h;

    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.beginPath();
  ctx.strokeStyle = '#ff6600';
  ctx.lineWidth = 2;
  data2.forEach((value, index) => {
    const x = padding + index * xStep;

    // Invert Y-axis for canvas coordinates
    const y = padding + h - ((value - minVal) / (maxVal - minVal)) * h;

    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();
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
