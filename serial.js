export async function serialConnect() {
  const port = await navigator.serial.requestPort();
  const bufferSize = 1024;  // 1 kB
  let buffer = new ArrayBuffer(bufferSize);
  await port.open({baudRate: 115200, bufferSize});

  const reader = port.readable.getReader({mode: "byob"});

  while (port.readable) {
    try {
      while (true) {
        const {value, done} = await reader.read(new Uint8Array(buffer));
        if (done) {
          // allow port to be closed later
          reader.releaseLock();
          break;
        }
        buffer = value.buffer;
        if (value) {
          console.log(value); // should be a string now
        }
      }
    } catch (error) {
      // TODO: Handle non-fatal errors
    }
  }
}
