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
  // The server clamps each of these against the tank height anyway; matching
  // the input ceilings to it keeps the form from accepting a number that will
  // come back silently reduced.
  const maxFeet = Number(config.maxFeet);
  if (Number.isFinite(maxFeet) && maxFeet > 0) {
    alertEls.fullFeet.max = String(maxFeet);
    alertEls.rapidLossFeet.max = String(maxFeet);
    alertEls.lowWarningFeet.max = String(Math.round((maxFeet - 0.2) * 10) / 10);
    alertEls.criticalFeet.max = String(Math.round((maxFeet - 0.4) * 10) / 10);
  }

  alertEls.lowWarningFeet.value = config.lowWarningFeet ?? 2.0;
  alertEls.criticalFeet.value = config.criticalFeet ?? 1.0;
  alertEls.fullFeet.value = config.fullFeet ?? 7.0;
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

const usageEls = {
  form: document.getElementById("usageForm"),
  tankDiameterFeet: document.getElementById("usageTankDiameter"),
  gallonsPerFootOverride: document.getElementById("usageGallonsPerFootOverride"),
  gallonsPerFoot: document.getElementById("usageGallonsPerFoot"),
  autoPumpRate: document.getElementById("usageAutoPumpRate"),
  pumpRateGpm: document.getElementById("usagePumpRate"),
  status: document.getElementById("usageConfigStatus")
};

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
  liveStatus: document.getElementById("pumpOutputLiveStatus"),
  reconnectButton: document.getElementById("reconnectRelayButton"),
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

function setUsageStatus(text, level = "neutral") {
  usageEls.status.textContent = text;
  usageEls.status.className = `config-status ${level}`;
}

function fillUsageForm(config) {
  usageEls.tankDiameterFeet.value = config.tankDiameterFeet ?? 0;
  usageEls.gallonsPerFootOverride.value = config.gallonsPerFootOverride ?? 0;
  usageEls.autoPumpRate.checked = Boolean(config.autoPumpRate);
  usageEls.pumpRateGpm.value = config.pumpRateGpm ?? 0;

  const perFoot = Number(config.gallonsPerFoot) || 0;
  if (perFoot > 0) {
    const gpm = Math.round(Number(config.effectivePumpRateGpm) || 0);
    const sourceLabel = {
      estimated: `Pump rate worked out from past fills: about ${gpm} gal/min.`,
      manual: `Pump rate set by hand: ${gpm} gal/min.`,
      "manual-fallback": `No fills to learn from yet, using the manual ${gpm} gal/min.`,
      unset: "No pump rate yet - water used while the pump is filling is not counted."
    }[config.pumpRateSource] || "";
    usageEls.gallonsPerFoot.textContent =
      `${Math.round(perFoot).toLocaleString()} gallons per foot of level. ${sourceLabel}`.trim();
    usageEls.gallonsPerFoot.className = "config-status ok";
  } else {
    usageEls.gallonsPerFoot.textContent = "Set a tank diameter to enable usage tracking.";
    usageEls.gallonsPerFoot.className = "config-status error";
  }

  setUsageStatus("Saved", perFoot > 0 ? "ok" : "neutral");
}

function collectUsageForm() {
  return {
    tankDiameterFeet: Number(usageEls.tankDiameterFeet.value),
    gallonsPerFootOverride: Number(usageEls.gallonsPerFootOverride.value),
    autoPumpRate: usageEls.autoPumpRate.checked,
    pumpRateGpm: Number(usageEls.pumpRateGpm.value),
    confirm: true
  };
}

usageEls.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!window.confirm("Save tank and usage settings?\n\nUsage history will be recalculated with the new numbers.")) return;

  try {
    setUsageStatus("Saving and recalculating");
    fillUsageForm(await requestJson("/api/config/usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectUsageForm())
    }));
  } catch (error) {
    setUsageStatus(error.message, "error");
  }
});

loadUsageConfig().catch((error) => setUsageStatus(error.message, "error"));

async function loadUsageConfig() {
  setUsageStatus("Loading");
  fillUsageForm(await requestJson("/api/config/usage"));
}

function setPumpOutputStatus(text, level = "neutral") {
  pumpOutputEls.status.textContent = text;
  pumpOutputEls.status.className = `config-status ${level}`;
}

function renderRelayLiveStatus(status) {
  const el = pumpOutputEls.liveStatus;
  if (!status) {
    el.textContent = "Unknown";
    el.className = "config-status neutral";
    return;
  }

  const suffix = status.controlEnabled
    ? ""
    : " Pump control is disabled (PUMP_CONTROL_ENABLED), so the output is detected but will not be energized.";

  if (status.available) {
    const where = status.connectedPath ? ` at ${status.connectedPath}` : "";
    el.textContent = `Connected${where}.${suffix}`;
    el.className = "config-status ok";
    return;
  }

  el.textContent = `${status.fault || "Not connected."}${suffix}`;
  el.className = "config-status error";
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
    const isSensor = isRadioPort(port);
    const label = port.manufacturer ? `${port.path} (${port.manufacturer})` : port.path;
    option.textContent = isSensor
      ? `${label} - ${port.confirmed ? "CONFIRMED LoRa radio receiver" : "LoRa radio receiver"}, not the relay`
      : label;
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
  const firstNonSensorPort = knownSerialPorts.find((port) => !isRadioPort(port));
  select.value = matchesDetected
    ? selectedPath
    : (selectedPath ? CUSTOM_PORT_VALUE : (firstNonSensorPort?.path || CUSTOM_PORT_VALUE));
  if (!matchesDetected && selectedPath) {
    pumpOutputEls.usbRelayPort.value = selectedPath;
  }
  updateCustomPortVisibility();
}

// The server tags every detected port with the role it believes it plays.
// Trusting that tag rather than a single remembered path matters when the OS
// renumbers devices: the radio can move to a path the picker has never seen,
// and a stale path comparison would then happily offer the radio as the relay.
function isRadioPort(port) {
  return Boolean(port) && port.role === "radio";
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
  const isSensorPort = isRadioPort(identity) ||
    (Boolean(knownSensorPort) && getSelectedUsbRelayPort() === knownSensorPort);

  if (isSensorPort) {
    pumpOutputEls.usbRelayLockToIdentity.checked = false;
    pumpOutputEls.usbRelayLockToIdentity.disabled = true;
    pumpOutputEls.usbRelayIdentity.textContent =
      "This is the LoRa radio receiver's port, not the relay - pick a different port before locking.";
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
  renderRelayLiveStatus(config.status);
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

pumpOutputEls.reconnectButton.addEventListener("click", async () => {
  if (!window.confirm("Release and re-open the pump output hardware now?\n\nThe pump is driven OFF while this happens.")) return;

  try {
    pumpOutputEls.reconnectButton.disabled = true;
    setPumpOutputStatus("Reconnecting");
    pumpOutputEls.liveStatus.textContent = "Reconnecting";
    pumpOutputEls.liveStatus.className = "config-status neutral";
    const result = await requestJson("/api/config/pump-output/reconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    renderRelayLiveStatus(result.status);
    await refreshSerialPorts(getSelectedUsbRelayPort());
    setPumpOutputStatus(result.status?.available ? "Relay connected" : "Relay not found", result.status?.available ? "ok" : "error");
  } catch (error) {
    setPumpOutputStatus(error.message, "error");
  } finally {
    pumpOutputEls.reconnectButton.disabled = false;
  }
});

pumpOutputEls.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!window.confirm("Save pump output settings and apply them now?\n\nThe pump output is released and re-opened, and is driven OFF while that happens.")) return;

  try {
    setPumpOutputStatus("Saving");
    const saved = await requestJson("/api/config/pump-output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectPumpOutputForm())
    });
    await fillPumpOutputForm(saved);
    setPumpOutputStatus("Saved and applied", "ok");
  } catch (error) {
    setPumpOutputStatus(error.message, "error");
  }
});

async function pollRelayStatus() {
  try {
    const config = await requestJson("/api/config/pump-output");
    renderRelayLiveStatus(config.status);
  } catch {
    // Transient - the periodic poll retries, and the visible status simply
    // keeps showing the last known value rather than flashing an error.
  }
}

loadPumpOutputConfig().catch((error) => setPumpOutputStatus(error.message, "error"));
setInterval(pollRelayStatus, 5000);
