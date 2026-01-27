export async function serialConnect() {
  const port = await navigator.serial.requestPort();
  await port.open({baudRate: 115200});

  const textDecoder = new TextDecoderStream();
  const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
  const reader = textDecoder.readable
    .pipeThrough(new TransformStream(new LineBreakTransformer()))
    .getReader();

  while (port.readable) {
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) {
          // allow port to be closed later
          reader.releaseLock();
          break;
        }
        if (value) {
          console.log(value); // should be a string now
        }
      }
    } catch (error) {
      // TODO: Handle non-fatal errors
    }
  }
}

class LineBreakTransformer {
  constructor() {
    // A container for holding stream data until a new line.
    this.chunks = "";
  }

  transform(chunk, controller) {
    // Append new chunks to existing chunks.
    this.chunks += chunk;
    // For each line breaks in chunks, send the parsed lines out.
    const lines = this.chunks.split("\0");
    this.chunks = lines.pop();
    lines.forEach((line) => controller.enqueue(line));
  }

  flush(controller) {
    // When the stream is closed, flush any remaining chunks out.
    controller.enqueue(this.chunks);
  }
}
