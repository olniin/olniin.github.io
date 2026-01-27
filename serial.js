export async function serialConnect() {
  const port = await navigator.serial.requestPort();
  await port.open({baudRate: 115200});

  const textDecoder = new TextDecoderStream();
  const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
  const reader = textDecoder.readable
    .pipeThrough(new TransformStream(new LineBreakTransformer()))
    .getReader();


  const serialOutput = [];
  const dataHasBegun = 0;
  const dataCounter = 0;
  while (port.readable) {
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) {
          // allow port to be closed later
          reader.releaseLock();
          break;
        }
        if (value.startsWith("ISC")) {
          console.log("ISC detection correct");
          console.log(value); // should be a string now
          dataCounter = 0;
          dataHasBegun = 1;
        } else if(value && dataHasBegun && dataCounter<1024) {
          const parts = value.split(",");
          serialOutput.push(parseInt(parts[0], 16));
          serialOutput.push(parseInt(parts[1], 16));
          console.log(serialOutput);
          console.log(value);
          dataCounter+=1;
        } else {
          dataHasBegun = 0;
          serialOutput = [];
          console.log("Data reset!");
        }
      }
    } catch (error) {
      // TODO: Handle non-fatal errors
      console.log(error);
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
