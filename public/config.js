"use strict";

const alertEls = {
  form: document.getElementById("alertForm"),
  lowWarningFeet: document.getElementById("alertLowWarningFeet"),
  criticalFeet: document.getElementById("alertCriticalFeet"),
  fullFeet: document.getElementById("alertFullFeet"),
  lowWaterAlertsEnabled: document.getElementById("alertLowWaterEnabled"),
  rapidLossAlertsEnabled: document.getElementById("alertRapidLossEnabled"),
  rapidLossFeet: document.getElementById("alertRapidLossFeet"),
  rapidLossMinutes: document.getElementById("alertRapidLossMinutes"),
  status: document.getElementById("alertStatus")
};

function setAlertStatus(text, level = "neutral") {
  alertEls.status.textContent = text;
  alertEls.status.className = `config-status ${level}`;
}

function fillAlertForm(config) {
  alertEls.lowWarningFeet.value = config.lowWarningFeet ?? 2.0;
  alertEls.criticalFeet.value = config.criticalFeet ?? 1.0;
  alertEls.fullFeet.value = config.fullFeet ?? 7.5;
  alertEls.lowWaterAlertsEnabled.checked = Boolean(config.lowWaterAlertsEnabled);
  alertEls.rapidLossAlertsEnabled.checked = Boolean(config.rapidLossAlertsEnabled);
  alertEls.rapidLossFeet.value = config.rapidLossFeet ?? 1.0;
  alertEls.rapidLossMinutes.value = config.rapidLossMinutes ?? 30;
  setAlertStatus("Saved", "ok");
}

function collectAlertForm() {
  return {
    lowWarningFeet: Number(alertEls.lowWarningFeet.value),
    criticalFeet: Number(alertEls.criticalFeet.value),
    fullFeet: Number(alertEls.fullFeet.value),
    lowWaterAlertsEnabled: alertEls.lowWaterAlertsEnabled.checked,
    rapidLossAlertsEnabled: alertEls.rapidLossAlertsEnabled.checked,
    rapidLossFeet: Number(alertEls.rapidLossFeet.value),
    rapidLossMinutes: Number(alertEls.rapidLossMinutes.value),
    confirm: true
  };
}

async function loadAlertConfig() {
  setAlertStatus("Loading");
  fillAlertForm(await requestJson("/api/config/alerts"));
}

alertEls.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!window.confirm("Save water level thresholds and alert settings?")) return;

  try {
    setAlertStatus("Saving");
    fillAlertForm(await requestJson("/api/config/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectAlertForm())
    }));
  } catch (error) {
    setAlertStatus(error.message, "error");
  }
});

loadAlertConfig().catch((error) => setAlertStatus(error.message, "error"));

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
  usbRelayLockToIdentity: document.getElementById("pumpUsbRelayLockToIdentity"),
  usbRelayIdentity: document.getElementById("pumpUsbRelayIdentity"),
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
let knownSensorPort = "";

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
    const isSensor = Boolean(knownSensorPort) && port.path === knownSensorPort;
    const label = port.manufacturer ? `${port.path} (${port.manufacturer})` : port.path;
    option.textContent = isSensor ? `${label} - water sensor, not the relay` : label;
    select.appendChild(option);
  }

  const customOption = document.createElement("option");
  customOption.value = CUSTOM_PORT_VALUE;
  customOption.textContent = "Custom path...";
  select.appendChild(customOption);

  const matchesDetected = Boolean(selectedPath) && knownSerialPorts.some((port) => port.path === selectedPath);
  // Never silently default the picker to the sensor's own port - an unset
  // relay port should fall through to "Custom path..." instead, forcing a
  // deliberate choice, rather than pre-selecting whichever device the OS
  // happened to enumerate first (which is often the sensor).
  const firstNonSensorPort = knownSerialPorts.find((port) => port.path !== knownSensorPort);
  select.value = matchesDetected
    ? selectedPath
    : (selectedPath ? CUSTOM_PORT_VALUE : (firstNonSensorPort?.path || CUSTOM_PORT_VALUE));
  if (!matchesDetected && selectedPath) {
    pumpOutputEls.usbRelayPort.value = selectedPath;
  }
  updateCustomPortVisibility();
}

function getSelectedUsbRelayPort() {
  const value = pumpOutputEls.usbRelayPortSelect.value;
  return value === CUSTOM_PORT_VALUE ? pumpOutputEls.usbRelayPort.value.trim() : value;
}

function getSelectedUsbRelayIdentity() {
  const path = getSelectedUsbRelayPort();
  return knownSerialPorts.find((port) => port.path === path) || null;
}

function updateUsbRelayIdentityDisplay() {
  const identity = getSelectedUsbRelayIdentity();
  const isSensorPort = Boolean(knownSensorPort) && getSelectedUsbRelayPort() === knownSensorPort;

  if (isSensorPort) {
    pumpOutputEls.usbRelayLockToIdentity.checked = false;
    pumpOutputEls.usbRelayLockToIdentity.disabled = true;
    pumpOutputEls.usbRelayIdentity.textContent =
      "This is the water-level sensor's port, not the relay - pick a different port before locking.";
  } else if (identity && identity.vendorId && identity.productId) {
    pumpOutputEls.usbRelayLockToIdentity.disabled = false;
    pumpOutputEls.usbRelayIdentity.textContent = `Detected device: ${identity.vendorId}:${identity.productId}`;
  } else {
    pumpOutputEls.usbRelayLockToIdentity.checked = false;
    pumpOutputEls.usbRelayLockToIdentity.disabled = true;
    pumpOutputEls.usbRelayIdentity.textContent = "This port has no vendor/product ID to lock to (custom path, or device has none).";
  }
}

async function refreshSerialPorts(selectedPath) {
  const { ports, sensorPort } = await requestJson("/api/system/serial-ports");
  knownSerialPorts = ports;
  knownSensorPort = sensorPort || "";
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
  pumpOutputEls.usbRelayLockToIdentity.checked = Boolean(config.usbRelayVendorId && config.usbRelayProductId);
  updateUsbRelayIdentityDisplay();
  if (config.usbRelayVendorId && config.usbRelayProductId) {
    pumpOutputEls.usbRelayLockToIdentity.checked = true;
    pumpOutputEls.usbRelayLockToIdentity.disabled = false;
    pumpOutputEls.usbRelayIdentity.textContent = `Locked to device: ${config.usbRelayVendorId}:${config.usbRelayProductId}`;
  }
  updatePumpOutputFieldVisibility();
  setPumpOutputStatus("Saved", "ok");
}

function collectPumpOutputForm() {
  const identity = pumpOutputEls.usbRelayLockToIdentity.checked ? getSelectedUsbRelayIdentity() : null;
  return {
    type: pumpOutputEls.type.value,
    gpioPin: Number(pumpOutputEls.gpioPin.value),
    gpioActiveHigh: pumpOutputEls.gpioActiveHigh.checked,
    usbRelayPort: getSelectedUsbRelayPort(),
    usbRelayBaud: Number(pumpOutputEls.usbRelayBaud.value),
    usbRelayVendorId: identity?.vendorId || "",
    usbRelayProductId: identity?.productId || "",
    confirm: true
  };
}

async function loadPumpOutputConfig() {
  setPumpOutputStatus("Loading");
  await fillPumpOutputForm(await requestJson("/api/config/pump-output"));
}

pumpOutputEls.type.addEventListener("change", updatePumpOutputFieldVisibility);
pumpOutputEls.usbRelayPortSelect.addEventListener("change", () => {
  updateCustomPortVisibility();
  updateUsbRelayIdentityDisplay();
});
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
