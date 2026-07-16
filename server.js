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
  // The ESP32 receiver and the USB pump relay are BOTH USB-serial devices on the same
  // machine, and the OS can renumber their /dev paths across a reboot or reconnect. To
  // keep them straight, the sensor is matched by USB vendor/product ID (default = the
  // Heltec V3's CP2102 bridge, 10c4:ea60) rather than trusting a fixed path; if no match
  // is found we fall back to serialPort. The relay is matched by its own VID/PID the same
  // way (PUMP_USB_RELAY_VENDOR_ID/PRODUCT_ID) - as long as the two devices use different
  // bridges (CP2102 sensor vs CH340 relay), they can never grab each other's port.
  serialVendorId: process.env.SERIAL_VENDOR_ID || "10c4",
  serialProductId: process.env.SERIAL_PRODUCT_ID || "ea60",
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
    usbRelayBaud: Number.parseInt(process.env.PUMP_USB_RELAY_BAUD || "9600", 10),
    usbRelayVendorId: process.env.PUMP_USB_RELAY_VENDOR_ID || "",
    usbRelayProductId: process.env.PUMP_USB_RELAY_PRODUCT_ID || ""
  },
  ntfy: {
    enabled: String(process.env.NTFY_ENABLED || "").toLowerCase() === "true",
    serverUrl: process.env.NTFY_SERVER_URL || "",
    topic: process.env.NTFY_TOPIC || "",
    token: process.env.NTFY_TOKEN || ""
  },
  maxFeet: 8.0,
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
  readingAtOrBefore: db.prepare(`
    SELECT feet, timestamp
    FROM readings
    WHERE timestamp <= ?
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
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
  `),
  readingsBetween: db.prepare(`
    SELECT feet, timestamp
    FROM readings
    WHERE timestamp > ? AND timestamp <= ?
    ORDER BY timestamp ASC, id ASC
  `),
  firstReadingTime: db.prepare(`
    SELECT timestamp FROM readings ORDER BY timestamp ASC, id ASC LIMIT 1
  `),
  pumpEventsBetween: db.prepare(`
    SELECT timestamp, pump_on
    FROM pump_events
    WHERE timestamp > ? AND timestamp <= ?
    ORDER BY timestamp ASC, id ASC
  `),
  lastPumpStateBefore: db.prepare(`
    SELECT pump_on
    FROM pump_events
    WHERE timestamp <= ?
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
  `),
  upsertDailyUsage: db.prepare(`
    INSERT INTO daily_usage (day, gallons, pump_rate, computed_at)
    VALUES (@day, @gallons, @pump_rate, @computed_at)
    ON CONFLICT(day) DO UPDATE SET
      gallons = excluded.gallons,
      pump_rate = excluded.pump_rate,
      computed_at = excluded.computed_at
  `),
  dailyUsageRange: db.prepare(`
    SELECT day, gallons
    FROM daily_usage
    WHERE day >= ? AND day <= ?
    ORDER BY day ASC
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
  // Backstops sized for overflow safety, not convenience. Because the sensor
  // only reports every few minutes, a stuck-low sensor or a relay that will
  // not release can keep filling between readings - these two ceilings bound
  // how long that can go on. Tune both from the Pump panel in /config.html to
  // match how long your pump actually takes to fill the tank.
  staleShutdownMinutes: 15,
  maxRuntimeMinutes: 120
};

const DEFAULT_PUMP_OUTPUT_SETTINGS = {
  type: CONFIG.pump.output,
  gpioPin: CONFIG.pump.gpioPin,
  gpioActiveHigh: CONFIG.pump.activeHigh,
  usbRelayPort: CONFIG.pump.usbRelayPort,
  usbRelayBaud: CONFIG.pump.usbRelayBaud,
  usbRelayVendorId: CONFIG.pump.usbRelayVendorId,
  usbRelayProductId: CONFIG.pump.usbRelayProductId
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

const DEFAULT_ALERT_SETTINGS = {
  criticalFeet: 1.0,
  lowWarningFeet: 2.0,
  fullFeet: 7.5,
  lowWaterAlertsEnabled: true,
  rapidLossAlertsEnabled: true,
  rapidLossFeet: 1.0,
  rapidLossMinutes: 30
};

const alertState = {
  lastAlarmLevel: null,
  rapidLossArmed: true
};

// Tracks which pump/relay safety conditions we've already notified about, so a
// single fault sends one message when it starts and one "all clear" when it
// ends - not a fresh alert on every 60-second control tick.
const pumpAlertState = {
  faultNotified: false,
  staleNotified: false
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
    available: false,
    dropCount: 0,
    lastDropAt: null
  }
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, places = 2) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

// Human-friendly duration for notification text, e.g. 120 -> "2 hours",
// 90 -> "1.5 hours", 15 -> "15 minutes". Avoids "0 hours" for sub-hour values.
function formatDuration(minutes) {
  if (minutes >= 60) {
    const hours = minutes / 60;
    const label = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
    return `${label} hour${hours === 1 ? "" : "s"}`;
  }
  const mins = Math.round(minutes);
  return `${mins} minute${mins === 1 ? "" : "s"}`;
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

function getAlarmState(feet, alertSettings = getAlertSettings()) {
  if (!Number.isFinite(feet)) {
    return { level: "waiting", label: "Waiting for Data" };
  }
  if (feet < alertSettings.criticalFeet) {
    return { level: "critical", label: "Critical Low" };
  }
  if (feet < alertSettings.lowWarningFeet) {
    return { level: "warning", label: "Low Warning" };
  }
  if (feet > alertSettings.fullFeet) {
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

function sanitizeUsbHexId(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{1,4}$/.test(trimmed) ? trimmed : "";
}

function sanitizePumpOutputSettings(input) {
  const type = input.type === "usb_relay" ? "usb_relay" : "gpio";
  const gpioPin = Math.round(clamp(Number(input.gpioPin), 0, 40));
  const usbRelayBaud = Math.round(clamp(Number(input.usbRelayBaud), 1200, 115200));
  let usbRelayVendorId = sanitizeUsbHexId(input.usbRelayVendorId);
  let usbRelayProductId = sanitizeUsbHexId(input.usbRelayProductId);

  // Refuse to lock the relay onto the water-level sensor's own identity -
  // this is exactly the mix-up a bare port-picker UI invites (both devices
  // are USB-serial adapters on the same machine), and it would make the
  // relay driver "find" and drive the sensor's port instead of the relay's.
  if (
    usbRelayVendorId &&
    usbRelayProductId &&
    usbRelayVendorId === CONFIG.serialVendorId.toLowerCase() &&
    usbRelayProductId === CONFIG.serialProductId.toLowerCase()
  ) {
    usbRelayVendorId = "";
    usbRelayProductId = "";
  }

  return {
    type,
    gpioPin: Number.isFinite(gpioPin) ? gpioPin : DEFAULT_PUMP_OUTPUT_SETTINGS.gpioPin,
    gpioActiveHigh: Boolean(input.gpioActiveHigh),
    usbRelayPort: String(input.usbRelayPort || "").trim(),
    usbRelayBaud: Number.isFinite(usbRelayBaud) ? usbRelayBaud : DEFAULT_PUMP_OUTPUT_SETTINGS.usbRelayBaud,
    usbRelayVendorId,
    usbRelayProductId
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

function getAlertSettings() {
  const stored = getStoredJsonSetting("alerts", DEFAULT_ALERT_SETTINGS);
  return sanitizeAlertSettings(stored);
}

function sanitizeAlertSettings(input) {
  let criticalFeet = round(clamp(Number(input.criticalFeet), 0.1, CONFIG.maxFeet - 0.4), 2);
  if (!Number.isFinite(criticalFeet)) criticalFeet = DEFAULT_ALERT_SETTINGS.criticalFeet;

  let lowWarningFeet = round(clamp(Number(input.lowWarningFeet), criticalFeet + 0.2, CONFIG.maxFeet - 0.2), 2);
  if (!Number.isFinite(lowWarningFeet)) lowWarningFeet = Math.max(DEFAULT_ALERT_SETTINGS.lowWarningFeet, criticalFeet + 0.2);

  let fullFeet = round(clamp(Number(input.fullFeet), lowWarningFeet + 0.2, CONFIG.maxFeet), 2);
  if (!Number.isFinite(fullFeet)) fullFeet = Math.max(DEFAULT_ALERT_SETTINGS.fullFeet, lowWarningFeet + 0.2);

  let rapidLossFeet = round(clamp(Number(input.rapidLossFeet), 0.1, CONFIG.maxFeet), 2);
  if (!Number.isFinite(rapidLossFeet)) rapidLossFeet = DEFAULT_ALERT_SETTINGS.rapidLossFeet;

  let rapidLossMinutes = Math.round(clamp(Number(input.rapidLossMinutes), 5, 720));
  if (!Number.isFinite(rapidLossMinutes)) rapidLossMinutes = DEFAULT_ALERT_SETTINGS.rapidLossMinutes;

  return {
    criticalFeet,
    lowWarningFeet,
    fullFeet,
    lowWaterAlertsEnabled: Boolean(input.lowWaterAlertsEnabled),
    rapidLossAlertsEnabled: Boolean(input.rapidLossAlertsEnabled),
    rapidLossFeet,
    rapidLossMinutes
  };
}

function checkWaterAlerts(saved) {
  const alertSettings = getAlertSettings();
  const ntfySettings = getNtfySettings();
  const alarm = getAlarmState(saved.feet, alertSettings);

  if (alertSettings.lowWaterAlertsEnabled && ntfySettings.enabled && alarm.level !== alertState.lastAlarmLevel) {
    const messages = {
      critical: `Critical low water: ${saved.feet.toFixed(2)} ft (tower ${saved.tower}).`,
      warning: `Low water warning: ${saved.feet.toFixed(2)} ft (tower ${saved.tower}).`,
      normal: (alertState.lastAlarmLevel === "warning" || alertState.lastAlarmLevel === "critical")
        ? `Water level recovered to ${saved.feet.toFixed(2)} ft (tower ${saved.tower}).`
        : null
    };
    const message = messages[alarm.level];
    if (message) {
      sendNtfyNotification(ntfySettings, message, "Camp ASCCA Water Tower - Level Alert")
        .catch((error) => console.error(`Failed to send low-water notification: ${error.message}`));
    }
  }
  alertState.lastAlarmLevel = alarm.level;

  if (alertSettings.rapidLossAlertsEnabled) {
    const windowMs = alertSettings.rapidLossMinutes * 60 * 1000;
    const cutoff = new Date(new Date(saved.timestamp).getTime() - windowMs).toISOString();
    const baseline = statements.readingAtOrBefore.get(cutoff);

    if (baseline) {
      const drop = baseline.feet - saved.feet;
      if (drop >= alertSettings.rapidLossFeet) {
        if (alertState.rapidLossArmed) {
          alertState.rapidLossArmed = false;
          if (ntfySettings.enabled) {
            const message = `Rapid water loss: ${drop.toFixed(2)} ft in ${alertSettings.rapidLossMinutes} minutes (tower ${saved.tower}, now ${saved.feet.toFixed(2)} ft).`;
            sendNtfyNotification(ntfySettings, message, "Camp ASCCA Water Tower - Rapid Loss")
              .catch((error) => console.error(`Failed to send rapid-loss notification: ${error.message}`));
          }
        }
      } else {
        alertState.rapidLossArmed = true;
      }
    }
  }
}

function sendNtfyNotification(settings, message, title = "Camp ASCCA Water Tower", options = {}) {
  return new Promise((resolve, reject) => {
    if (!settings.enabled) {
      reject(new Error("ntfy notifications are disabled."));
      return;
    }

    const target = new URL(`${settings.serverUrl}/${encodeURIComponent(settings.topic)}`);
    const body = Buffer.from(message);
    const client = target.protocol === "https:" ? https : http;
    // The Title header must be plain ASCII - HTTP header values cannot carry
    // emoji or other multi-byte characters (Node throws ERR_INVALID_CHAR).
    // Visual urgency is conveyed via ntfy's Tags (emoji shortcodes) and
    // Priority headers instead, which are ASCII.
    const req = client.request(target, {
      method: "POST",
      timeout: 5000,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": body.length,
        "Title": title,
        ...(options.priority ? { "Priority": String(options.priority) } : {}),
        ...(options.tags ? { "Tags": options.tags } : {}),
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

// Fire-and-forget notification for pump/relay safety events. Unlike the
// water-level alerts, these are about the pump hardware and controller, so the
// message body includes plain-English "what to do" steps for on-site staff who
// are not expected to know the software internals.
function sendPumpAlert(title, message, options = {}) {
  let ntfySettings;
  try {
    ntfySettings = getNtfySettings();
  } catch (error) {
    console.error(`Could not load ntfy settings for pump alert: ${error.message}`);
    return;
  }
  if (!ntfySettings.enabled) return;
  sendNtfyNotification(ntfySettings, message, title, options)
    .catch((error) => console.error(`Failed to send pump alert "${title}": ${error.message}`));
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

async function resolveUsbRelayPath(settings) {
  if (!settings.usbRelayVendorId || !settings.usbRelayProductId) {
    return settings.usbRelayPort || null;
  }

  // Cheap CH340-style relay boards rarely have a unique serial number
  // programmed, so the OS cannot keep their /dev path stable across a
  // disconnect/reconnect - each reconnect can get renumbered. Vendor and
  // product ID survive that renumbering, so prefer matching on those over
  // trusting a fixed path. usbRelayPort is kept only as a fallback for when
  // no match is found (e.g. unplugged) or when VID/PID are not set.
  try {
    const ports = await SerialPort.list();
    const match = ports.find((candidate) =>
      (candidate.vendorId || "").toLowerCase() === settings.usbRelayVendorId.toLowerCase() &&
      (candidate.productId || "").toLowerCase() === settings.usbRelayProductId.toLowerCase());
    return match ? match.path : null;
  } catch (error) {
    console.warn(`USB relay discovery by vendor/product ID failed: ${error.message}`);
    return settings.usbRelayPort || null;
  }
}

function initUsbRelayOutput(settings) {
  const byIdentity = Boolean(settings.usbRelayVendorId && settings.usbRelayProductId);
  if (!settings.usbRelayPort && !byIdentity) {
    pumpState.fault = "USB relay port is not configured.";
    pumpState.reason = "No USB relay port set; pump held off.";
    return;
  }

  pumpOutput = { kind: "usb_relay", port: null };

  const reopen = async () => {
    if (pumpOutput.port?.isOpen) return;

    const path = await resolveUsbRelayPath(settings);
    if (!path) {
      pumpState.output.available = false;
      pumpState.fault = byIdentity
        ? `No USB relay matching ${settings.usbRelayVendorId}:${settings.usbRelayProductId} found.`
        : "USB relay port is not configured.";
      console.warn(pumpState.fault);
      setTimeout(reopen, 10000);
      return;
    }

    const port = new SerialPort({ path, baudRate: settings.usbRelayBaud, autoOpen: false });
    pumpOutput.port = port;

    port.on("open", () => {
      pumpState.output.available = true;
      pumpState.fault = null;
      pumpState.reason = `USB relay on ${path} initialized off.`;
      console.log(`Pump USB relay connected at ${path} (${settings.usbRelayBaud} baud)`);
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
      pumpState.output.dropCount += 1;
      pumpState.output.lastDropAt = new Date().toISOString();
      console.warn(`Pump USB relay port closed (drop #${pumpState.output.dropCount}); retrying in 10 seconds.`);
      setTimeout(reopen, 10000);
    });

    port.open((error) => {
      if (error) {
        pumpState.output.available = false;
        pumpState.fault = `USB relay unavailable: ${error.message}`;
        console.warn(pumpState.fault);
        setTimeout(reopen, 10000);
      }
    });
  };

  reopen();
}

function writePumpOutput(pumpOn) {
  if (!pumpOutput) return;

  if (pumpOutput.kind === "gpio") {
    try {
      const active = pumpOutput.activeHigh ? 1 : 0;
      const inactive = pumpOutput.activeHigh ? 0 : 1;
      pumpOutput.gpio.writeSync(pumpOn ? active : inactive);
    } catch (error) {
      // A write we can't confirm succeeded must not be trusted as the real
      // state. Mark the output unavailable so evaluatePumpControl() forces
      // pumpState.pumpOn back to false on its next tick instead of the
      // dashboard silently showing a commanded state that never reached
      // the hardware.
      pumpState.output.available = false;
      pumpState.fault = `GPIO write failed: ${error.message}`;
      console.error(pumpState.fault);
    }
    return;
  }

  if (pumpOutput.kind === "usb_relay") {
    if (!pumpOutput.port || !pumpOutput.port.isOpen || pumpOutput.port.destroyed) {
      pumpState.output.available = false;
      pumpState.fault = pumpState.fault || "USB relay port is not open.";
      return;
    }
    pumpOutput.port.write(pumpOn ? USB_RELAY_ON : USB_RELAY_OFF, (error) => {
      if (error) {
        // Do not also force-close the port here: the underlying device
        // failure that caused this write to fail already triggers the
        // port's own "error"/"close" events independently, which own
        // reconnection via the existing reopen() retry loop. Closing it
        // again here double-schedules that retry and races a fresh
        // successful reopen, clobbering good state with a stale fault.
        pumpState.output.available = false;
        pumpState.fault = `USB relay write failed: ${error.message}`;
        console.error(pumpState.fault);
      }
    });
  }
}

function reassertPumpOutput() {
  // Defense against a relay that changes state on its own - a welded/stuck
  // contact, EMI, a brownout on the relay board, or a board that powers up in
  // its last (ON) state. Everywhere else we only *send* a relay command on a
  // state transition (setPumpOn early-returns when nothing changed), so a
  // spuriously energized relay would otherwise never receive another OFF and
  // could fill the tank to overflow while the software still believes it is
  // off. Re-driving the desired physical state on a fast timer means a relay
  // that drifts out of sync is corrected within seconds, in either direction.
  if (!pumpOutput || !pumpState.output.available) return;
  writePumpOutput(pumpState.pumpOn);
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
    if (!pumpAlertState.staleNotified) {
      pumpAlertState.staleNotified = true;
      sendPumpAlert(
        "Water tower: no signal - pump stopped",
        `The monitor stopped hearing from the tank sensor for ${settings.staleShutdownMinutes} minutes, so the pump was shut off as a precaution. It will not run when it cannot see the water level.\n\n` +
        "This is almost always a dead battery or lost power at the tank sensor, not the pump itself.\n\n" +
        "WHAT TO DO:\n" +
        "1. Walk out to the tank and look at the small monitor/sensor box - is its power light on?\n" +
        "2. Check the battery and solar panel that power it.\n" +
        "3. If you cannot fix it, leave it be - the pump stays off for safety. Water can be added manually if needed; call maintenance.\n\n" +
        "You will get an \"all clear\" message here when the signal comes back.",
        { tags: "warning", priority: "high" }
      );
    }
    return;
  }

  if (pumpAlertState.staleNotified) {
    pumpAlertState.staleNotified = false;
    sendPumpAlert(
      "Water tower: signal restored",
      "The tank sensor is reporting again and automatic pump control is back to normal. No action needed.",
      { tags: "white_check_mark" }
    );
  }

  if (!CONFIG.pump.enabled) {
    setPumpOn(false, "Pump output disabled. Set PUMP_CONTROL_ENABLED=true after wiring is ready.", latest);
    return;
  }

  if (pumpState.fault || !pumpState.output.available) {
    setPumpOn(false, pumpState.fault || "Pump output unavailable; pump held off.", latest);
    if (!pumpAlertState.faultNotified) {
      pumpAlertState.faultNotified = true;
      sendPumpAlert(
        "Water pump: relay problem - pump held off",
        `The monitor cannot reliably control the pump relay right now, so it is holding the pump OFF to be safe.\n\n` +
        `Details: ${pumpState.fault || "relay not available"}\n\n` +
        "This is usually the USB relay unplugged, a loose USB cable, or the relay box losing power.\n\n" +
        "WHAT TO DO:\n" +
        "1. Check the USB cable between the Raspberry Pi and the relay box - unplug it and plug it back in firmly.\n" +
        "2. Make sure the relay box has power.\n" +
        "3. Control resumes on its own once it reconnects, and you will get an \"all clear\" here.\n\n" +
        "Until then the pump cannot run automatically. Call maintenance if it does not clear.",
        { tags: "warning", priority: "high" }
      );
    }
    return;
  }

  if (pumpAlertState.faultNotified) {
    pumpAlertState.faultNotified = false;
    sendPumpAlert(
      "Water pump: relay reconnected",
      "The pump relay is working again and automatic control has resumed. No action needed.",
      { tags: "white_check_mark" }
    );
  }

  if (pumpState.pumpOn && pumpState.startedAt) {
    const runtimeMs = Date.now() - new Date(pumpState.startedAt).getTime();
    if (runtimeMs > settings.maxRuntimeMinutes * 60 * 1000) {
      setPumpOn(false, `Stopped after max runtime of ${Math.round(settings.maxRuntimeMinutes / 60)} hours.`, latest);
      sendPumpAlert(
        "Water pump: safety shutoff - ran too long",
        `The pump ran continuously for about ${formatDuration(settings.maxRuntimeMinutes)} and was automatically shut off to prevent an overflow.\n\n` +
        "This usually means the tank is not filling the way it should - a closed valve, the pump losing its prime, or the level sensor stuck on one number.\n\n" +
        "WHAT TO DO:\n" +
        "1. Go look at the tank and check the real water level.\n" +
        "2. If it is full or overflowing, leave the pump OFF, check the float switch, and call maintenance.\n" +
        "3. If the tank is low and needs water, open the dashboard, set the pump to Manual On, and watch it. If it shuts off again without filling, the pump or a valve needs attention.\n\n" +
        "The pump will stay off until someone turns it back on from the dashboard.",
        { tags: "warning", priority: "high" }
      );
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
  checkWaterAlerts(saved);
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
      })),
      // So the relay port picker can avoid defaulting to (or silently
      // accepting a "lock to this device" on) the water-level sensor's own
      // port - the sensor and the relay are both USB-serial devices on the
      // same machine and are easy to mix up from a bare port list.
      sensorPort: CONFIG.serialPort
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
  const alertSettings = getAlertSettings();
  res.json({
    ok: true,
    mode: serialState.mode,
    serial: serialState,
    database: CONFIG.dbPath,
    latest: enrichReading(latest),
    thresholds: {
      maxFeet: CONFIG.maxFeet,
      lowWarningFeet: alertSettings.lowWarningFeet,
      criticalFeet: alertSettings.criticalFeet,
      fullFeet: alertSettings.fullFeet
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

app.get("/api/config/alerts", (req, res) => {
  res.json(getAlertSettings());
});

app.post("/api/config/alerts", (req, res) => {
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "Alert settings changes require confirm=true." });
    return;
  }

  try {
    const next = sanitizeAlertSettings(req.body);
    saveStoredJsonSetting("alerts", next);
    res.json(next);
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
  // Re-drive the physical relay far more often than we re-evaluate control
  // logic, so a relay that latches on by itself is forced back off within
  // seconds rather than waiting up to a minute for the next control tick.
  setInterval(reassertPumpOutput, 10 * 1000).unref();
  startSerialReader();
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);

  // Pump safety must never wait on HTTP connections draining: a long-lived
  // SSE client (the dashboard's /events stream) keeps server.close()'s
  // callback from ever firing, which previously meant the pump-off below
  // never ran and the process hung indefinitely on SIGTERM. Turn the pump
  // off and release hardware first, unconditionally, then best-effort close
  // the HTTP server with a hard timeout backstop.
  setPumpOn(false, "Server shutdown.", statements.latest.get());
  if (pumpOutput?.kind === "gpio") pumpOutput.gpio.unexport();
  if (pumpOutput?.kind === "usb_relay" && pumpOutput.port?.isOpen) pumpOutput.port.close();

  for (const client of sseClients) client.end();

  let exited = false;
  const finish = () => {
    if (exited) return;
    exited = true;
    db.close();
    process.exit(0);
  };

  const forceExitTimer = setTimeout(() => {
    console.warn("Shutdown timed out waiting for connections to close; forcing exit.");
    finish();
  }, 5000);
  forceExitTimer.unref();

  server.close(() => {
    clearTimeout(forceExitTimer);
    finish();
  });

  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
}

function emergencyPumpOff(reason) {
  console.error(reason);
  try {
    writePumpOutput(false);
  } catch (writeError) {
    console.error(`Emergency pump-off write failed: ${writeError.message}`);
  }
  try {
    pumpState.pumpOn = false;
    pumpState.reason = reason;
    logPumpEvent("off", reason, statements.latest.get());
  } catch (logError) {
    console.error(`Emergency pump-off event logging failed: ${logError.message}`);
  }
  // Best-effort only: the process is about to exit, so this POST may not finish
  // flushing before then. The watchdog's liveness check is the reliable path
  // that will notify if this crash keeps the app from answering. We still try
  // here so a one-off recovered crash gets reported too.
  try {
    sendPumpAlert(
      "Water monitor crashed - pump forced off",
      "The monitor software hit an error. It forced the pump OFF on the way down as a safety measure and is restarting itself.\n\n" +
      "WHAT TO DO:\n" +
      "1. Usually nothing - it restarts on its own within a minute.\n" +
      "2. Open the dashboard in a minute to confirm the level is showing again.\n" +
      "3. If you keep getting this message, the Raspberry Pi needs a restart or maintenance.",
      { tags: "warning", priority: "high" }
    );
  } catch (alertError) {
    console.error(`Emergency pump-off alert failed: ${alertError.message}`);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Last-resort safety net: a crash must never leave the relay energized.
// GPIO writes are synchronous and complete before exit; the USB relay write
// and the crash notification are fire-and-forget over the network/serial, so
// exit is delayed briefly to give both a chance to flush. This does not
// protect against SIGKILL or host power loss - only fail-open relay/contactor
// wiring protects against those.
process.on("uncaughtException", (error) => {
  emergencyPumpOff(`Uncaught exception, forcing pump off: ${error.stack || error.message}`);
  setTimeout(() => process.exit(1), 750);
});

process.on("unhandledRejection", (reason) => {
  emergencyPumpOff(`Unhandled rejection, forcing pump off: ${reason instanceof Error ? reason.stack : reason}`);
  setTimeout(() => process.exit(1), 750);
});
