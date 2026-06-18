"use strict";

const els = {
  form: document.getElementById("ntfyForm"),
  enabled: document.getElementById("ntfyEnabled"),
  serverUrl: document.getElementById("ntfyServerUrl"),
  topic: document.getElementById("ntfyTopic"),
  token: document.getElementById("ntfyToken"),
  clearToken: document.getElementById("ntfyClearToken"),
  status: document.getElementById("configStatus"),
  testButton: document.getElementById("testNtfyButton")
};

const pumpOutputEls = {
  form: document.getElementById("pumpOutputForm"),
  type: document.getElementById("pumpOutputType"),
  gpioOption: document.getElementById("pumpOutputTypeGpioOption"),
  usbRelayOption: document.getElementById("pumpOutputTypeUsbRelayOption"),
  gpioFields: document.getElementById("gpioFields"),
  gpioPin: document.getElementById("pumpGpioPin"),
  gpioActiveHigh: document.getElementById("pumpGpioActiveHigh"),
  usbRelayFields: document.getElementById("usbRelayFields"),
  usbRelayPortSelect: document.getElementById("pumpUsbRelayPortSelect"),
  usbRelayPortCustomLabel: document.getElementById("pumpUsbRelayPortCustomLabel"),
  usbRelayPort: document.getElementById("pumpUsbRelayPort"),
  usbRelayBaud: document.getElementById("pumpUsbRelayBaud"),
  refreshPortsButton: document.getElementById("refreshSerialPortsButton"),
  status: document.getElementById("pumpOutputStatus"),
  recommendation: document.getElementById("pumpOutputRecommendation")
};

const CUSTOM_PORT_VALUE = "__custom__";

const PUMP_OUTPUT_LABELS = {
  gpio: "Raspberry Pi GPIO",
  usb_relay: "USB Relay (LCUS-style)"
};

function setStatus(text, level = "neutral") {
  els.status.textContent = text;
  els.status.className = `config-status ${level}`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function fillForm(config) {
  els.enabled.checked = Boolean(config.enabled);
  els.serverUrl.value = config.serverUrl || "";
  els.topic.value = config.topic || "";
  els.token.value = "";
  els.clearToken.checked = false;
  setStatus(config.hasToken ? "Saved with token" : "Saved", config.enabled ? "ok" : "neutral");
}

function collectForm() {
  return {
    enabled: els.enabled.checked,
    serverUrl: els.serverUrl.value.trim(),
    topic: els.topic.value.trim(),
    token: els.token.value,
    clearToken: els.clearToken.checked,
    confirm: true
  };
}

async function loadConfig() {
  setStatus("Loading");
  fillForm(await requestJson("/api/config/ntfy"));
}

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!window.confirm("Save ntfy notification settings?")) return;

  try {
    setStatus("Saving");
    fillForm(await requestJson("/api/config/ntfy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectForm())
    }));
  } catch (error) {
    setStatus(error.message, "error");
  }
});

els.testButton.addEventListener("click", async () => {
  if (!window.confirm("Send a test notification to the configured ntfy topic?")) return;

  try {
    setStatus("Sending test");
    await requestJson("/api/config/ntfy/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    setStatus("Test sent", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

loadConfig().catch((error) => setStatus(error.message, "error"));

function setPumpOutputStatus(text, level = "neutral") {
  pumpOutputEls.status.textContent = text;
  pumpOutputEls.status.className = `config-status ${level}`;
}

function updatePumpOutputFieldVisibility() {
  const isUsbRelay = pumpOutputEls.type.value === "usb_relay";
  pumpOutputEls.gpioFields.style.display = isUsbRelay ? "none" : "grid";
  pumpOutputEls.usbRelayFields.style.display = isUsbRelay ? "grid" : "none";
}

let knownSerialPorts = [];

function updateCustomPortVisibility() {
  const isCustom = pumpOutputEls.usbRelayPortSelect.value === CUSTOM_PORT_VALUE;
  pumpOutputEls.usbRelayPortCustomLabel.style.display = isCustom ? "grid" : "none";
}

function populatePortSelect(selectedPath) {
  const select = pumpOutputEls.usbRelayPortSelect;
  select.innerHTML = "";

  if (knownSerialPorts.length === 0) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "No serial ports detected";
    select.appendChild(empty);
  }

  for (const port of knownSerialPorts) {
    const option = document.createElement("option");
    option.value = port.path;
    option.textContent = port.manufacturer ? `${port.path} (${port.manufacturer})` : port.path;
    select.appendChild(option);
  }

  const customOption = document.createElement("option");
  customOption.value = CUSTOM_PORT_VALUE;
  customOption.textContent = "Custom path...";
  select.appendChild(customOption);

  const matchesDetected = Boolean(selectedPath) && knownSerialPorts.some((port) => port.path === selectedPath);
  select.value = matchesDetected ? selectedPath : (selectedPath ? CUSTOM_PORT_VALUE : (knownSerialPorts[0]?.path || CUSTOM_PORT_VALUE));
  if (!matchesDetected && selectedPath) {
    pumpOutputEls.usbRelayPort.value = selectedPath;
  }
  updateCustomPortVisibility();
}

function getSelectedUsbRelayPort() {
  const value = pumpOutputEls.usbRelayPortSelect.value;
  return value === CUSTOM_PORT_VALUE ? pumpOutputEls.usbRelayPort.value.trim() : value;
}

async function refreshSerialPorts(selectedPath) {
  const { ports } = await requestJson("/api/system/serial-ports");
  knownSerialPorts = ports;
  populatePortSelect(selectedPath);
}

function applyRecommendation(recommendation) {
  pumpOutputEls.gpioOption.textContent = PUMP_OUTPUT_LABELS.gpio;
  pumpOutputEls.usbRelayOption.textContent = PUMP_OUTPUT_LABELS.usb_relay;

  if (!recommendation) {
    pumpOutputEls.recommendation.textContent = "";
    return;
  }

  if (recommendation.suggestedType === "gpio") {
    pumpOutputEls.gpioOption.textContent = `${PUMP_OUTPUT_LABELS.gpio} (Recommended)`;
  } else if (recommendation.suggestedType === "usb_relay") {
    pumpOutputEls.usbRelayOption.textContent = `${PUMP_OUTPUT_LABELS.usb_relay} (Recommended)`;
  }

  pumpOutputEls.recommendation.textContent = recommendation.reason;
  pumpOutputEls.recommendation.className = `config-status ${recommendation.suggestedType ? "ok" : "neutral"}`;
}

async function fillPumpOutputForm(config) {
  applyRecommendation(config.recommendation);
  pumpOutputEls.type.value = config.type || "gpio";
  pumpOutputEls.gpioPin.value = config.gpioPin ?? 17;
  pumpOutputEls.gpioActiveHigh.checked = Boolean(config.gpioActiveHigh);
  pumpOutputEls.usbRelayBaud.value = config.usbRelayBaud ?? 9600;
  try {
    await refreshSerialPorts(config.usbRelayPort || "");
  } catch (error) {
    pumpOutputEls.usbRelayPort.value = config.usbRelayPort || "";
    setPumpOutputStatus(`Could not list serial ports: ${error.message}`, "error");
  }
  updatePumpOutputFieldVisibility();
  setPumpOutputStatus("Saved", "ok");
}

function collectPumpOutputForm() {
  return {
    type: pumpOutputEls.type.value,
    gpioPin: Number(pumpOutputEls.gpioPin.value),
    gpioActiveHigh: pumpOutputEls.gpioActiveHigh.checked,
    usbRelayPort: getSelectedUsbRelayPort(),
    usbRelayBaud: Number(pumpOutputEls.usbRelayBaud.value),
    confirm: true
  };
}

async function loadPumpOutputConfig() {
  setPumpOutputStatus("Loading");
  await fillPumpOutputForm(await requestJson("/api/config/pump-output"));
}

pumpOutputEls.type.addEventListener("change", updatePumpOutputFieldVisibility);
pumpOutputEls.usbRelayPortSelect.addEventListener("change", updateCustomPortVisibility);
pumpOutputEls.refreshPortsButton.addEventListener("click", () => {
  refreshSerialPorts(getSelectedUsbRelayPort()).catch((error) => setPumpOutputStatus(error.message, "error"));
});

pumpOutputEls.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!window.confirm("Save pump output settings? The app must be restarted for this to take effect.")) return;

  try {
    setPumpOutputStatus("Saving");
    const saved = await requestJson("/api/config/pump-output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectPumpOutputForm())
    });
    await fillPumpOutputForm(saved);
    setPumpOutputStatus("Saved - restart app to apply", "ok");
  } catch (error) {
    setPumpOutputStatus(error.message, "error");
  }
});

loadPumpOutputConfig().catch((error) => setPumpOutputStatus(error.message, "error"));
