const terminalElement = document.getElementById("terminal");

if ("serial" in navigator) {
  // check passed
  terminalElement.textContent = "Successfully detected serial capability";
} else {
  terminalElement.textContent = "No serial for you!! :(";
}

document.querySelector("button").addEventListener("click", async () => {
  // Prompt user to select a serial port
  const port = await navigator.serial.requestPort();
});
