export async function serialConnect() {
  const port = await navigator.serial.requestPort();

  await port.open({baudRate: 115200});

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
          console.log(value);
        }
      }
    } catch (error) {
      terminalElement.textContent(error);
    }
  }
}
