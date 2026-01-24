// import serialConnect from "serial.js"
const serialConnect = require("serial.js");

const terminalElement = document.getElementById("terminal");

if ("serial" in navigator) {
  // check passed
  terminalElement.textContent = "Successfully detected serial capability";
} else {
  terminalElement.textContent = "No serial for you!! :(";
}

document.querySelector("button").addEventListener("click", serialConnect());
