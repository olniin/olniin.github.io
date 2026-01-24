const terminalElement = document.getElementById("terminal");

if ("serial" in navigator) {
  // check passed
  terminalElement.textContent = "Successfully detected serial capability";
} else {
  terminalElement.textContent = "No serial for you!! :(";
}
