// Minimal Web Serial line reader (Chrome/Edge).
// - Secure context required (HTTPS or localhost)
// - requestPort() must be called from a user gesture.
//
// Sources:
//  - MDN Web Serial API & Serial.requestPort(): https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
//  - WICG spec: https://wicg.github.io/serial/

export class SerialLineClient {
  constructor() {
    /** @type {SerialPort|null} */
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.keepReading = false;

    /** @type {(line: string)=>void} */
    this.onLine = () => {};
    /** @type {(s: string)=>void} */
    this.onStatus = () => {};
    /** @type {(e: any)=>void} */
    this.onError = () => {};
  }

  supported() {
    return !!navigator.serial;
  }

  async connect({ baudRate = 115200 } = {}) {
    if (!this.supported()) throw new Error("Web Serial pole selles brauseris saadaval.");
    // Must be called from a user gesture.
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate });

    // Writer (text)
    const enc = new TextEncoderStream();
    const writableClosed = enc.readable.pipeTo(this.port.writable);
    this.writer = enc.writable.getWriter();
    this._writableClosed = writableClosed;

    // Reader (text -> lines)
    const dec = new TextDecoderStream();
    const readableClosed = this.port.readable.pipeTo(dec.writable);
    this._readableClosed = readableClosed;

    this.reader = dec.readable
      .pipeThrough(new TransformStream(new LineBreakTransformer()))
      .getReader();

    this.keepReading = true;
    this.onStatus("Avatud");

    this._readLoop().catch((e) => this.onError(e));
  }

  async writeLine(text) {
    if (!this.writer) return;
    await this.writer.write(text + "\n");
  }

  async close() {
    try {
      this.keepReading = false;
      if (this.reader) {
        await this.reader.cancel();
        await this._readableClosed?.catch(() => {});
        this.reader.releaseLock();
        this.reader = null;
      }
      if (this.writer) {
        await this.writer.close();
        await this._writableClosed?.catch(() => {});
        this.writer.releaseLock?.();
        this.writer = null;
      }
      if (this.port) {
        await this.port.close();
        this.port = null;
      }
    } finally {
      this.onStatus("Lahti");
    }
  }

  async _readLoop() {
    while (this.port?.readable && this.keepReading) {
      const { value, done } = await this.reader.read();
      if (done) break;
      if (typeof value === "string" && value.length) this.onLine(value);
    }
  }
}

// From Chrome Dev docs examples
class LineBreakTransformer {
  constructor() { this.chunks = ""; }
  transform(chunk, controller) {
    this.chunks += chunk;
    // STM32 USB.println() typically emits \r\n
    const lines = this.chunks.split(/\r?\n/);
    this.chunks = lines.pop() ?? "";
    for (const line of lines) controller.enqueue(line);
  }
  flush(controller) {
    if (this.chunks) controller.enqueue(this.chunks);
  }
}
