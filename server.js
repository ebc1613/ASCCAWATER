"use strict";

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const express = require("express");
const Database = require("better-sqlite3");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

function detectPumpOutputRecommendation() {
  let model = null;
  for (const file of ["/proc/device-tree/model", "/sys/firmware/devicetree/base/model"]) {
    try {
      const text = fs.readFileSync(file, "utf8").replace(/\0/g, "").trim();
      if (text) {
        model = text;
        break;
      }
    } catch {
      // File does not exist on this platform - expected on non-Pi systems.
    }
  }

  const isRaspberryPi = Boolean(model && /raspberry pi/i.test(model));

  if (process.platform !== "linux") {
    return {
      suggestedType: "usb_relay",
      reason: `Running on ${process.platform} (${process.arch}), which has no GPIO support. USB relay recommended.`
    };
  }

  if (isRaspberryPi) {
    return {
      suggestedType: "gpio",
      reason: `Detected ${model}. GPIO recommended.`
    };
  }

  if (process.arch === "x64" || process.arch === "ia32") {
    return {
      suggestedType: "usb_relay",
      reason: `Linux on ${process.arch} (no GPIO header, not a Raspberry Pi). USB relay recommended.`
    };
  }

  if (process.arch.startsWith("arm")) {
    return {
      suggestedType: "gpio",
      reason: `ARM Linux (${process.arch}). GPIO likely available.`
    };
  }

  return {
    suggestedType: null,
    reason: `Could not confidently detect hardware (${process.platform}/${process.arch}).`
  };
}

const PUMP_OUTPUT_RECOMMENDATION = detectPumpOutputRecommendation();

const CONFIG = {
  host: process.env.HOST || "0.0.0.0",
  port: Number.parseInt(process.env.PORT || "80", 10),
  serialPort: process.env.SERIAL_PORT || "/dev/ttyUSB0",
  baudRate: Number.parseInt(process.env.BAUD_RATE || "115200", 10),
  simulate: String(process.env.SIMULATE || "").toLowerCase() === "true",
  dbPath: process.env.DB_PATH || path.join(__dirname, "water-monitor.sqlite"),
  retentionDays: Number.parseInt(process.env.RETENTION_DAYS || "90", 10),
  pruneIntervalHours: Number.parseInt(process.env.PRUNE_INTERVAL_HOURS || "12", 10),
  trendMaxPoints: Number.parseInt(process.env.TREND_MAX_POINTS || "300", 10),
  pump: {
    enabled: String(process.env.PUMP_CONTROL_ENABLED || "").toLowerCase() === "true",
    output: process.env.PUMP_OUTPUT
      ? (process.env.PUMP_OUTPUT.toLowerCase() === "usb_relay" ? "usb_relay" : "gpio")
      : (PUMP_OUTPUT_RECOMMENDATION.suggestedType || "gpio"),
    gpioPin: Number.parseInt(process.env.PUMP_GPIO_PIN || "17", 10),
    activeHigh: String(process.env.PUMP_GPIO_ACTIVE_HIGH || "true").toLowerCase() !== "false",
    usbRelayPort: process.env.PUMP_USB_RELAY_PORT || "",
    usbRelayBaud: Number.parseInt(process.env.PUMP_USB_RELAY_BAUD || "9600", 10)
  },
  ntfy: {
    enabled: String(process.env.NTFY_ENABLED || "").toLowerCase() === "true",
    serverUrl: process.env.NTFY_SERVER_URL || "",
    topic: process.env.NTFY_TOPIC || "",
    token: process.env.NTFY_TOKEN || ""
  },
  maxFeet: 8.0,
  alarm: {
    criticalFeet: 1.0,
    lowWarningFeet: 2.0,
    fullFeet: 7.5
  },
  status: {
    greenMs: 5 * 60 * 1000,
    yellowMs: 10 * 60 * 1000
  }
};

const db = new Database(CONFIG.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(fs.readFileSync(path.join(__dirname, "db", "schema.sql"), "utf8"));

const statements = {
  insertReading: db.prepare(`
    INSERT INTO readings (tower, feet, psi, battery, rssi, snr, seq, timestamp)
    VALUES (@tower, @feet, @psi, @battery, @rssi, @snr, @seq, @timestamp)
  `),
  latest: db.prepare(`
    SELECT id, tower, feet, psi, battery, rssi, snr, seq, timestamp
    FROM readings
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
  `),
  recent: db.prepare(`
    SELECT id, tower, feet, psi, battery, rssi, snr, seq, timestamp
    FROM readings
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `),
  trendRange: db.prepare(`
    SELECT id, tower, feet, psi, battery, rssi, snr, seq, timestamp
    FROM readings
    WHERE timestamp >= ?
    ORDER BY timestamp ASC, id ASC
  `),
  pruneOldReadings: db.prepare(`
    DELETE FROM readings
    WHERE timestamp < ?
  `),
  getSetting: db.prepare(`
    SELECT value
    FROM app_settings
    WHERE key = ?
  `),
  setSetting: db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `),
  insertPumpEvent: db.prepare(`
    INSERT INTO pump_events (timestamp, action, reason, mode, pump_on, feet, settings)
    VALUES (@timestamp, @action, @reason, @mode, @pump_on, @feet, @settings)
  `)
};

const app = express();
const sseClients = new Set();
let serialState = {
  connected: false,
  mode: CONFIG.simulate ? "simulation" : "serial",
  port: CONFIG.serialPort,
  lastError: CONFIG.simulate ? null : "Serial reader has not opened yet."
};

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  maxAge: "1h"
}));

const DEFAULT_PUMP_SETTINGS = {
  mode: "manual_off",
  autoOnFeet: 2.0,
  autoOffFeet: 7.2,
  staleShutdownMinutes: 60,
  maxRuntimeMinutes: 12 * 60
};

const DEFAULT_PUMP_OUTPUT_SETTINGS = {
  type: CONFIG.pump.output,
  gpioPin: CONFIG.pump.gpioPin,
  gpioActiveHigh: CONFIG.pump.activeHigh,
  usbRelayPort: CONFIG.pump.usbRelayPort,
  usbRelayBaud: CONFIG.pump.usbRelayBaud
};

// LCUS-1/LCUS-2 style USB relay protocol: 4-byte command, last byte is a
// checksum (sum of the first three bytes).
const USB_RELAY_ON = Buffer.from([0xa0, 0x01, 0x01, 0xa2]);
const USB_RELAY_OFF = Buffer.from([0xa0, 0x01, 0x00, 0xa1]);

const DEFAULT_NTFY_SETTINGS = {
  enabled: CONFIG.ntfy.enabled,
  serverUrl: CONFIG.ntfy.serverUrl,
  topic: CONFIG.ntfy.topic,
  token: CONFIG.ntfy.token
};

let pumpOutput = null;
let pumpState = {
  enabled: CONFIG.pump.enabled,
  pumpOn: false,
  mode: DEFAULT_PUMP_SETTINGS.mode,
  reason: "Pump output is off at startup.",
  startedAt: null,
  lastChangedAt: new Date().toISOString(),
  fault: null,
  output: {
    type: CONFIG.pump.output,
    available: false
  }
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, places = 2) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function normalizeReading(input) {
  const reading = {
    tower: typeof input.tower === "string" && input.tower.trim() ? input.tower.trim() : "camp-main",
    feet: Number(input.feet),
    psi: Number(input.psi),
    battery: Number(input.battery),
    rssi: Number(input.rssi),
    snr: Number(input.snr),
    seq: Number.isFinite(Number(input.seq)) ? Number(input.seq) : null,
    timestamp: new Date().toISOString()
  };

  for (const field of ["feet", "psi", "battery", "rssi", "snr"]) {
    if (!Number.isFinite(reading[field])) {
      throw new Error(`Invalid reading field: ${field}`);
    }
  }

  reading.feet = round(reading.feet, 2);
  reading.psi = round(reading.psi, 2);
  reading.battery = round(reading.battery, 2);
  reading.rssi = round(reading.rssi, 1);
  reading.snr = round(reading.snr, 1);
  return reading;
}

function getCommunicationStatus(timestamp) {
  if (!timestamp) {
    return {
      level: "waiting",
      label: "Waiting for Data",
      ageSeconds: null
    };
  }

  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageSeconds = Math.max(0, Math.round(ageMs / 1000));

  if (ageMs <= CONFIG.status.greenMs) {
    return { level: "green", label: "Online", ageSeconds };
  }

  if (ageMs <= CONFIG.status.yellowMs) {
    return { level: "yellow", label: "Delayed", ageSeconds };
  }

  return { level: "red", label: "No Recent Updates", ageSeconds };
}

function getAlarmState(feet) {
  if (!Number.isFinite(feet)) {
    return { level: "waiting", label: "Waiting for Data" };
  }
  if (feet < CONFIG.alarm.criticalFeet) {
    return { level: "critical", label: "Critical Low" };
  }
  if (feet < CONFIG.alarm.lowWarningFeet) {
    return { level: "warning", label: "Low Warning" };
  }
  if (feet > CONFIG.alarm.fullFeet) {
    return { level: "full", label: "Near Full" };
  }
  return { level: "normal", label: "Normal" };
}

function enrichReading(row) {
  if (!row) {
    return {
      reading: null,
      percentFull: 0,
      communication: getCommunicationStatus(null),
      alarm: getAlarmState(null),
      maxFeet: CONFIG.maxFeet
    };
  }

  const percentFull = round(clamp((row.feet / CONFIG.maxFeet) * 100, 0, 100), 1);
  return {
    ...row,
    percentFull,
    communication: getCommunicationStatus(row.timestamp),
    alarm: getAlarmState(row.feet),
    maxFeet: CONFIG.maxFeet
  };
}

function downsampleRows(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;

  const stride = Math.ceil(rows.length / maxPoints);
  return rows.filter((row, index) => index % stride === 0 || index === rows.length - 1);
}

function pruneOldReadings() {
  if (!Number.isFinite(CONFIG.retentionDays) || CONFIG.retentionDays <= 0) return;

  const cutoff = new Date(Date.now() - CONFIG.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = statements.pruneOldReadings.run(cutoff);
  if (result.changes > 0) {
    console.log(`Pruned ${result.changes} readings older than ${CONFIG.retentionDays} days.`);
  }
}

function getStoredJsonSetting(key, fallback) {
  const row = statements.getSetting.get(key);
  if (!row) return fallback;

  try {
    return { ...fallback, ...JSON.parse(row.value) };
  } catch (error) {
    console.warn(`Invalid setting ${key}, using defaults: ${error.message}`);
    return fallback;
  }
}

function saveStoredJsonSetting(key, value) {
  statements.setSetting.run(key, JSON.stringify(value), new Date().toISOString());
}

function getPumpSettings() {
  const stored = getStoredJsonSetting("pump", DEFAULT_PUMP_SETTINGS);
  return sanitizePumpSettings(stored);
}

function getPumpOutputSettings() {
  const stored = getStoredJsonSetting("pumpOutput", DEFAULT_PUMP_OUTPUT_SETTINGS);
  return sanitizePumpOutputSettings(stored);
}

function sanitizePumpOutputSettings(input) {
  const type = input.type === "usb_relay" ? "usb_relay" : "gpio";
  const gpioPin = Math.round(clamp(Number(input.gpioPin), 0, 40));
  const usbRelayBaud = Math.round(clamp(Number(input.usbRelayBaud), 1200, 115200));

  return {
    type,
    gpioPin: Number.isFinite(gpioPin) ? gpioPin : DEFAULT_PUMP_OUTPUT_SETTINGS.gpioPin,
    gpioActiveHigh: Boolean(input.gpioActiveHigh),
    usbRelayPort: String(input.usbRelayPort || "").trim(),
    usbRelayBaud: Number.isFinite(usbRelayBaud) ? usbRelayBaud : DEFAULT_PUMP_OUTPUT_SETTINGS.usbRelayBaud
  };
}

function publicNtfySettings(settings) {
  return {
    enabled: Boolean(settings.enabled),
    serverUrl: settings.serverUrl,
    topic: settings.topic,
    hasToken: Boolean(settings.token)
  };
}

function getNtfySettings() {
  const stored = getStoredJsonSetting("ntfy", DEFAULT_NTFY_SETTINGS);
  return sanitizeNtfySettings(stored, { existingToken: DEFAULT_NTFY_SETTINGS.token });
}

function sanitizeNtfySettings(input, options = {}) {
  const enabled = Boolean(input.enabled);
  const serverUrl = String(input.serverUrl || "").trim().replace(/\/+$/, "");
  const topic = String(input.topic || "").trim();
  let token = input.clearToken ? "" : String(input.token ?? options.existingToken ?? "");

  if (serverUrl) {
    let parsed;
    try {
      parsed = new URL(serverUrl);
    } catch {
      throw new Error("ntfy server URL must be a valid http or https URL.");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("ntfy server URL must start with http:// or https://.");
    }
  }

  if (topic && !/^[A-Za-z0-9._-]{1,80}$/.test(topic)) {
    throw new Error("ntfy topic can only use letters, numbers, dots, underscores, and dashes.");
  }

  if (enabled && (!serverUrl || !topic)) {
    throw new Error("Enable notifications only after server URL and topic are set.");
  }

  if (!input.token && !input.clearToken && options.existingToken) {
    token = options.existingToken;
  }

  return { enabled, serverUrl, topic, token };
}

function sendNtfyNotification(settings, message, title = "Camp ASCCA Water Tower") {
  return new Promise((resolve, reject) => {
    if (!settings.enabled) {
      reject(new Error("ntfy notifications are disabled."));
      return;
    }

    const target = new URL(`${settings.serverUrl}/${encodeURIComponent(settings.topic)}`);
    const body = Buffer.from(message);
    const client = target.protocol === "https:" ? https : http;
    const req = client.request(target, {
      method: "POST",
      timeout: 5000,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": body.length,
        "Title": title,
        ...(settings.token ? { "Authorization": `Bearer ${settings.token}` } : {})
      }
    }, (response) => {
      response.resume();
      response.on("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
          return;
        }
        reject(new Error(`ntfy returned HTTP ${response.statusCode}.`));
      });
    });

    req.on("timeout", () => req.destroy(new Error("ntfy request timed out.")));
    req.on("error", reject);
    req.end(body);
  });
}

function sanitizePumpSettings(input) {
  const settings = {
    mode: ["auto", "manual_off", "manual_on"].includes(input.mode) ? input.mode : DEFAULT_PUMP_SETTINGS.mode,
    autoOnFeet: round(clamp(Number(input.autoOnFeet), 0.1, CONFIG.maxFeet - 0.5), 2),
    autoOffFeet: round(clamp(Number(input.autoOffFeet), 0.5, CONFIG.maxFeet), 2),
    staleShutdownMinutes: Math.round(clamp(Number(input.staleShutdownMinutes), 5, 240)),
    maxRuntimeMinutes: Math.round(clamp(Number(input.maxRuntimeMinutes), 10, 24 * 60))
  };

  if (!Number.isFinite(settings.autoOnFeet)) settings.autoOnFeet = DEFAULT_PUMP_SETTINGS.autoOnFeet;
  if (!Number.isFinite(settings.autoOffFeet)) settings.autoOffFeet = DEFAULT_PUMP_SETTINGS.autoOffFeet;
  if (!Number.isFinite(settings.staleShutdownMinutes)) settings.staleShutdownMinutes = DEFAULT_PUMP_SETTINGS.staleShutdownMinutes;
  if (!Number.isFinite(settings.maxRuntimeMinutes)) settings.maxRuntimeMinutes = DEFAULT_PUMP_SETTINGS.maxRuntimeMinutes;

  if (settings.autoOffFeet <= settings.autoOnFeet + 0.5) {
    settings.autoOffFeet = round(clamp(settings.autoOnFeet + 0.5, 0.5, CONFIG.maxFeet), 2);
  }

  return settings;
}

function initPumpOutput() {
  if (!CONFIG.pump.enabled) {
    pumpState.reason = "Pump output disabled. Set PUMP_CONTROL_ENABLED=true after wiring is ready.";
    return;
  }

  const settings = getPumpOutputSettings();
  pumpState.output.type = settings.type;

  if (settings.type === "usb_relay") {
    initUsbRelayOutput(settings);
    return;
  }

  try {
    const { Gpio } = require("onoff");
    const gpio = new Gpio(settings.gpioPin, "out");
    pumpOutput = { kind: "gpio", gpio, activeHigh: settings.gpioActiveHigh };
    pumpState.output.available = true;
    writePumpOutput(false);
    pumpState.reason = `GPIO output on pin ${settings.gpioPin} initialized off.`;
  } catch (error) {
    pumpState.fault = `GPIO unavailable: ${error.message}`;
    pumpState.reason = "GPIO failed to initialize; pump held off.";
    console.error(pumpState.fault);
  }
}

function initUsbRelayOutput(settings) {
  if (!settings.usbRelayPort) {
    pumpState.fault = "USB relay port is not configured.";
    pumpState.reason = "No USB relay port set; pump held off.";
    return;
  }

  const port = new SerialPort({
    path: settings.usbRelayPort,
    baudRate: settings.usbRelayBaud,
    autoOpen: false
  });

  pumpOutput = { kind: "usb_relay", port };

  const reopen = () => {
    if (port.isOpen) return;
    port.open((error) => {
      if (error) {
        pumpState.output.available = false;
        pumpState.fault = `USB relay unavailable: ${error.message}`;
        console.warn(pumpState.fault);
        setTimeout(reopen, 10000);
      }
    });
  };

  port.on("open", () => {
    pumpState.output.available = true;
    pumpState.fault = null;
    pumpState.reason = `USB relay on ${settings.usbRelayPort} initialized off.`;
    console.log(`Pump USB relay connected at ${settings.usbRelayPort} (${settings.usbRelayBaud} baud)`);
    writePumpOutput(false);
  });

  port.on("error", (error) => {
    pumpState.output.available = false;
    pumpState.fault = `USB relay error: ${error.message}`;
    console.error(pumpState.fault);
  });

  port.on("close", () => {
    pumpState.output.available = false;
    pumpState.fault = "USB relay port closed.";
    console.warn("Pump USB relay port closed; retrying in 10 seconds.");
    setTimeout(reopen, 10000);
  });

  reopen();
}

function writePumpOutput(pumpOn) {
  if (!pumpOutput) return;

  if (pumpOutput.kind === "gpio") {
    const active = pumpOutput.activeHigh ? 1 : 0;
    const inactive = pumpOutput.activeHigh ? 0 : 1;
    pumpOutput.gpio.writeSync(pumpOn ? active : inactive);
    return;
  }

  if (pumpOutput.kind === "usb_relay") {
    if (!pumpOutput.port.isOpen) return;
    pumpOutput.port.write(pumpOn ? USB_RELAY_ON : USB_RELAY_OFF, (error) => {
      if (error) {
        pumpState.fault = `USB relay write failed: ${error.message}`;
        console.error(pumpState.fault);
      }
    });
  }
}

function logPumpEvent(action, reason, latest) {
  const settings = getPumpSettings();
  statements.insertPumpEvent.run({
    timestamp: new Date().toISOString(),
    action,
    reason,
    mode: settings.mode,
    pump_on: pumpState.pumpOn ? 1 : 0,
    feet: latest?.feet ?? null,
    settings: JSON.stringify(settings)
  });
}

function setPumpOn(nextPumpOn, reason, latest) {
  if (pumpState.pumpOn === nextPumpOn && pumpState.reason === reason) return;

  const changed = pumpState.pumpOn !== nextPumpOn;
  pumpState.pumpOn = nextPumpOn;
  pumpState.reason = reason;
  pumpState.lastChangedAt = new Date().toISOString();
  if (nextPumpOn && changed) pumpState.startedAt = pumpState.lastChangedAt;
  if (!nextPumpOn) pumpState.startedAt = null;

  writePumpOutput(nextPumpOn);
  logPumpEvent(nextPumpOn ? "on" : "off", reason, latest);
  broadcastEvent("pump", getPumpStatus());
}

function evaluatePumpControl() {
  const settings = getPumpSettings();
  const latest = statements.latest.get();
  pumpState.mode = settings.mode;

  if (!latest) {
    setPumpOn(false, "Waiting for water level data.", null);
    return;
  }

  const ageMs = Date.now() - new Date(latest.timestamp).getTime();
  const staleMs = settings.staleShutdownMinutes * 60 * 1000;
  if (ageMs > staleMs) {
    setPumpOn(false, `Stopped because no LoRa reading arrived for ${settings.staleShutdownMinutes} minutes.`, latest);
    return;
  }

  if (!CONFIG.pump.enabled) {
    setPumpOn(false, "Pump output disabled. Set PUMP_CONTROL_ENABLED=true after wiring is ready.", latest);
    return;
  }

  if (pumpState.fault || !pumpState.output.available) {
    setPumpOn(false, pumpState.fault || "Pump output unavailable; pump held off.", latest);
    return;
  }

  if (pumpState.pumpOn && pumpState.startedAt) {
    const runtimeMs = Date.now() - new Date(pumpState.startedAt).getTime();
    if (runtimeMs > settings.maxRuntimeMinutes * 60 * 1000) {
      setPumpOn(false, `Stopped after max runtime of ${Math.round(settings.maxRuntimeMinutes / 60)} hours.`, latest);
      return;
    }
  }

  if (settings.mode === "manual_off") {
    setPumpOn(false, "Manual off.", latest);
    return;
  }

  if (settings.mode === "manual_on") {
    setPumpOn(true, "Manual on.", latest);
    return;
  }

  if (!pumpState.pumpOn && latest.feet <= settings.autoOnFeet) {
    setPumpOn(true, `Auto on at ${latest.feet.toFixed(2)} ft.`, latest);
    return;
  }

  if (pumpState.pumpOn && latest.feet >= settings.autoOffFeet) {
    setPumpOn(false, `Auto off at ${latest.feet.toFixed(2)} ft.`, latest);
    return;
  }

  pumpState.reason = pumpState.pumpOn ? "Auto running until off level." : "Auto waiting for on level.";
}

function getPumpStatus() {
  const settings = getPumpSettings();
  const latest = statements.latest.get();
  const runtimeSeconds = pumpState.pumpOn && pumpState.startedAt
    ? Math.max(0, Math.round((Date.now() - new Date(pumpState.startedAt).getTime()) / 1000))
    : 0;

  return {
    ...pumpState,
    mode: settings.mode,
    runtimeSeconds,
    settings,
    latest: enrichReading(latest)
  };
}

function saveReading(input) {
  const reading = normalizeReading(input);
  const result = statements.insertReading.run(reading);
  const saved = { id: result.lastInsertRowid, ...reading };
  const payload = enrichReading(saved);
  broadcastEvent("reading", payload);
  evaluatePumpControl();
  return payload;
}

function broadcastEvent(type, payload) {
  const event = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(event);
  }
}

function parseSerialLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    saveReading(JSON.parse(trimmed));
  } catch (error) {
    serialState.lastError = `Dropped serial line: ${error.message}`;
    console.warn(serialState.lastError, trimmed);
  }
}

function startSerialReader() {
  if (CONFIG.simulate) {
    startSimulator();
    return;
  }

  const port = new SerialPort({
    path: CONFIG.serialPort,
    baudRate: CONFIG.baudRate,
    autoOpen: false
  });

  const reopen = () => {
    if (port.isOpen) return;
    port.open((error) => {
      if (error) {
        serialState.connected = false;
        serialState.lastError = error.message;
        console.warn(`Serial unavailable at ${CONFIG.serialPort}: ${error.message}`);
        setTimeout(reopen, 10000);
      }
    });
  };

  port.on("open", () => {
    serialState.connected = true;
    serialState.lastError = null;
    console.log(`Reading serial data from ${CONFIG.serialPort} at ${CONFIG.baudRate} baud`);
  });

  port.on("error", (error) => {
    serialState.connected = false;
    serialState.lastError = error.message;
    console.error(`Serial error: ${error.message}`);
  });

  port.on("close", () => {
    serialState.connected = false;
    serialState.lastError = "Serial port closed.";
    console.warn("Serial port closed; retrying in 10 seconds.");
    setTimeout(reopen, 10000);
  });

  port.pipe(new ReadlineParser({ delimiter: "\n" })).on("data", parseSerialLine);
  reopen();
}

function startSimulator() {
  serialState.connected = true;
  serialState.lastError = null;
  console.log("SIMULATE=true, generating tank readings every 10 seconds.");

  let seq = 1;
  let feet = 5.6;
  let direction = -1;

  const emit = () => {
    feet += direction * (0.08 + Math.random() * 0.16);
    if (feet < 1.2) direction = 1;
    if (feet > 7.7) direction = -1;

    const noisyFeet = clamp(feet + (Math.random() - 0.5) * 0.18, 0.2, CONFIG.maxFeet);
    saveReading({
      tower: "camp-main",
      feet: noisyFeet,
      psi: noisyFeet * 0.433,
      battery: 12.6 + Math.random() * 0.8,
      rssi: -115 + Math.random() * 24,
      snr: -6 + Math.random() * 10,
      seq
    });
    seq += 1;
  };

  emit();
  setInterval(emit, 10000);
}

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  sseClients.add(res);
  res.write(`event: latest\ndata: ${JSON.stringify(enrichReading(statements.latest.get()))}\n\n`);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

app.get("/api/latest", (req, res) => {
  res.json(enrichReading(statements.latest.get()));
});

app.get("/api/system/serial-ports", async (req, res) => {
  try {
    const ports = await SerialPort.list();
    res.json({
      ports: ports.map((port) => ({
        path: port.path,
        manufacturer: port.manufacturer || null,
        serialNumber: port.serialNumber || null,
        vendorId: port.vendorId || null,
        productId: port.productId || null
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/readings", (req, res) => {
  const limit = clamp(Number.parseInt(req.query.limit || "100", 10) || 100, 1, 1000);
  res.json({
    limit,
    readings: statements.recent.all(limit).map(enrichReading)
  });
});

app.get("/api/health", (req, res) => {
  const latest = statements.latest.get();
  res.json({
    ok: true,
    mode: serialState.mode,
    serial: serialState,
    database: CONFIG.dbPath,
    latest: enrichReading(latest),
    thresholds: {
      maxFeet: CONFIG.maxFeet,
      lowWarningFeet: CONFIG.alarm.lowWarningFeet,
      criticalFeet: CONFIG.alarm.criticalFeet,
      fullFeet: CONFIG.alarm.fullFeet
    },
    retentionDays: CONFIG.retentionDays,
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.get("/api/trend", (req, res) => {
  const requestedHours = Number.parseInt(req.query.hours || "48", 10);
  const hours = requestedHours === 168 ? 168 : 48;
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const rows = statements.trendRange.all(cutoff);
  const maxPoints = clamp(CONFIG.trendMaxPoints, 50, 5000);
  res.json({
    hours,
    maxPoints,
    totalReadings: rows.length,
    readings: downsampleRows(rows, maxPoints).map(enrichReading)
  });
});

app.get("/api/pump/status", (req, res) => {
  evaluatePumpControl();
  res.json(getPumpStatus());
});

app.get("/api/config/ntfy", (req, res) => {
  try {
    res.json(publicNtfySettings(getNtfySettings()));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/config/ntfy", (req, res) => {
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "Configuration changes require confirm=true." });
    return;
  }

  try {
    const current = getNtfySettings();
    const next = sanitizeNtfySettings(req.body, { existingToken: current.token });
    saveStoredJsonSetting("ntfy", next);
    res.json(publicNtfySettings(next));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/config/ntfy/test", async (req, res) => {
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "Test notification requires confirm=true." });
    return;
  }

  try {
    const settings = getNtfySettings();
    await sendNtfyNotification(settings, "Test notification from the Camp ASCCA water tower monitor.");
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/config/pump-output", (req, res) => {
  res.json({ ...getPumpOutputSettings(), recommendation: PUMP_OUTPUT_RECOMMENDATION });
});

app.post("/api/config/pump-output", (req, res) => {
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "Pump output changes require confirm=true." });
    return;
  }

  try {
    const next = sanitizePumpOutputSettings(req.body);
    saveStoredJsonSetting("pumpOutput", next);
    logPumpEvent("output-config", "Pump output hardware changed from dashboard.", statements.latest.get());
    res.json({ ...next, recommendation: PUMP_OUTPUT_RECOMMENDATION, restartRequired: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/pump/settings", (req, res) => {
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "Settings changes require confirm=true." });
    return;
  }

  const current = getPumpSettings();
  const next = sanitizePumpSettings({
    ...current,
    autoOnFeet: req.body.autoOnFeet,
    autoOffFeet: req.body.autoOffFeet,
    staleShutdownMinutes: req.body.staleShutdownMinutes ?? current.staleShutdownMinutes,
    maxRuntimeMinutes: req.body.maxRuntimeMinutes ?? current.maxRuntimeMinutes
  });

  saveStoredJsonSetting("pump", next);
  logPumpEvent("settings", "Pump settings changed from dashboard.", statements.latest.get());
  evaluatePumpControl();
  res.json(getPumpStatus());
});

app.post("/api/pump/mode", (req, res) => {
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "Pump mode changes require confirm=true." });
    return;
  }

  const mode = req.body?.mode;
  if (!["auto", "manual_off", "manual_on"].includes(mode)) {
    res.status(400).json({ error: "Mode must be auto, manual_off, or manual_on." });
    return;
  }

  const settings = getPumpSettings();
  const next = { ...settings, mode };
  saveStoredJsonSetting("pump", next);
  logPumpEvent("mode", `Pump mode changed to ${mode}.`, statements.latest.get());
  evaluatePumpControl();
  res.json(getPumpStatus());
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

const server = app.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`Water monitor dashboard listening on http://${CONFIG.host}:${CONFIG.port}`);
  initPumpOutput();
  evaluatePumpControl();
  pruneOldReadings();
  setInterval(pruneOldReadings, clamp(CONFIG.pruneIntervalHours, 1, 168) * 60 * 60 * 1000).unref();
  setInterval(evaluatePumpControl, 60 * 1000).unref();
  startSerialReader();
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  server.close(() => {
    for (const client of sseClients) client.end();
    setPumpOn(false, "Server shutdown.", statements.latest.get());
    if (pumpOutput?.kind === "gpio") pumpOutput.gpio.unexport();
    if (pumpOutput?.kind === "usb_relay" && pumpOutput.port.isOpen) pumpOutput.port.close();
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
