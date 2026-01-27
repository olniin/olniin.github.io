export async function serialConnect() {
  const port = await navigator.serial.requestPort();

  await port.open({baudRate: 115200});

  const textDecoder = new TextDecoderStream();
  const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
  const reader = textDecoder.readable.getReader();

  while (port.readable) {
    const reader = port.readable.getReader();
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
