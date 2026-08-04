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
  usage: {
    tankDiameterFeet: Number.parseFloat(process.env.TANK_DIAMETER_FEET || "0"),
    gallonsPerFoot: Number.parseFloat(process.env.TANK_GALLONS_PER_FOOT || "0"),
    pumpRateGpm: Number.parseFloat(process.env.PUMP_RATE_GPM || "0")
  },
  ntfy: {
    enabled: String(process.env.NTFY_ENABLED || "").toLowerCase() === "true",
    serverUrl: process.env.NTFY_SERVER_URL || "",
    topic: process.env.NTFY_TOPIC || "",
    token: process.env.NTFY_TOKEN || ""
  },
  // Absolute full level of the tank, in feet of water above the sensor tap.
  // Everything derived from "how full is it" - percent full, the tank graphic,
  // and the clamps on every level threshold - is measured against this.
  maxFeet: Number.parseFloat(process.env.TANK_MAX_FEET || "7.2"),
  status: {
    greenMs: 5 * 60 * 1000,
    yellowMs: 10 * 60 * 1000
  }
};

const db = new Database(CONFIG.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(fs.readFileSync(path.join(__dirname, "db", "schema.sql"), "utf8"));

// CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
// columns added to schema.sql after a database was first created have to be
// applied explicitly. Adding a nullable column is cheap and non-destructive.
function ensureColumn(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (existing.some((info) => info.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`Added ${table}.${column} column.`);
}

ensureColumn("daily_usage", "drop_feet", "REAL");
ensureColumn("daily_usage", "pump_minutes", "REAL");
ensureColumn("daily_usage", "gallons_per_foot", "REAL");
ensureColumn("daily_usage", "covered_minutes", "REAL");

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
  pumpEventsSince: db.prepare(`
    SELECT timestamp, action, reason, mode, pump_on, feet
    FROM pump_events
    WHERE timestamp >= ?
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
    INSERT INTO daily_usage (
      day, gallons, pump_rate, computed_at,
      drop_feet, pump_minutes, gallons_per_foot, covered_minutes
    )
    VALUES (
      @day, @gallons, @pump_rate, @computed_at,
      @drop_feet, @pump_minutes, @gallons_per_foot, @covered_minutes
    )
    ON CONFLICT(day) DO UPDATE SET
      gallons = excluded.gallons,
      pump_rate = excluded.pump_rate,
      computed_at = excluded.computed_at,
      drop_feet = excluded.drop_feet,
      pump_minutes = excluded.pump_minutes,
      gallons_per_foot = excluded.gallons_per_foot,
      covered_minutes = excluded.covered_minutes
  `),
  dailyUsageRange: db.prepare(`
    SELECT day, gallons, pump_rate, drop_feet, pump_minutes, gallons_per_foot, covered_minutes
    FROM daily_usage
    WHERE day >= ? AND day <= ?
    ORDER BY day ASC
  `),
  dailyUsageDays: db.prepare(`
    SELECT day FROM daily_usage WHERE day >= ? AND day <= ?
  `),
  rescaleDailyUsage: db.prepare(`
    UPDATE daily_usage
    SET gallons = @gallons,
        pump_rate = @pump_rate,
        gallons_per_foot = @gallons_per_foot,
        computed_at = @computed_at
    WHERE day = @day
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
const USB_RELAY_RETRY_MS = 10000;

// The pump output is opened asynchronously (USB relay enumeration is not
// instant), so for the first moments after a start or a hot re-init the
// output legitimately reads as unavailable. Without this grace window every
// single app restart fired a high-priority "relay problem" push followed a
// second later by "relay reconnected" - which trains people to ignore the one
// alert that actually matters.
const PUMP_FAULT_ALERT_GRACE_MS = 60 * 1000;
let pumpOutputReadyDeadline = Date.now() + PUMP_FAULT_ALERT_GRACE_MS;

const DEFAULT_NTFY_SETTINGS = {
  enabled: CONFIG.ntfy.enabled,
  serverUrl: CONFIG.ntfy.serverUrl,
  topic: CONFIG.ntfy.topic,
  token: CONFIG.ntfy.token
};

const DEFAULT_ALERT_SETTINGS = {
  criticalFeet: 1.0,
  lowWarningFeet: 2.0,
  // Must stay at or under CONFIG.maxFeet, or the "tank is full" alert can never
  // fire. sanitizeAlertSettings clamps stored values on read, so an installation
  // that saved a higher number under an older, taller maxFeet is corrected
  // automatically rather than silently losing its full alert.
  fullFeet: 7.0,
  lowWaterAlertsEnabled: true,
  rapidLossAlertsEnabled: true,
  rapidLossFeet: 1.0,
  rapidLossMinutes: 30
};

// --- Water usage estimation -------------------------------------------------
//
// This is deliberately an estimate, not metering. There is no flow meter on
// this system; the only thing we observe is tank level every 5 minutes. Water
// leaving the tank shows up as the level falling, so usage is reconstructed
// from level drops, plus whatever the pump put in while the level was being
// held up or refilled.
//
// Two things dominate the error, and both are handled below:
//
//   1. Sensor noise. Naively summing every 5-minute drop would rectify noise
//      into fake consumption - at +/-0.05 ft of jitter that is several
//      thousand gallons a day of pure noise on a tank this size. Readings are
//      therefore collapsed into hourly buckets by median (12 samples/bucket,
//      which cuts the jitter roughly threefold) and changes smaller than a
//      deadband are treated as zero.
//   2. Usage that happens while the pump is running is invisible in the level
//      alone, because inflow masks it. Pump-on minutes multiplied by the pump
//      rate add that back.
const GALLONS_PER_CUBIC_FOOT = 7.48052;
const USAGE_BUCKET_MS = 60 * 60 * 1000;
const USAGE_DEADBAND_FEET = 0.03;
const USAGE_MAX_GAP_MINUTES = 360;
const USAGE_ROLLING_DAYS = 730;
// Days always recomputed from raw readings on each refresh, so late-arriving
// data and the still-in-progress current day stay correct.
const USAGE_RECOMPUTE_DAYS = 3;
const USAGE_PUMP_RATE_WINDOW_DAYS = 30;
const USAGE_PUMP_RATE_BUCKET_MS = 15 * 60 * 1000;

const DEFAULT_USAGE_SETTINGS = {
  // Only the tank's inside diameter matters here, not its height or where the
  // sensor is tapped: usage is derived from *changes* in level, so the 1 ft
  // offset between this sensor and the tank's physical gauge cancels out.
  tankDiameterFeet: CONFIG.usage.tankDiameterFeet > 0 ? CONFIG.usage.tankDiameterFeet : 33,
  gallonsPerFootOverride: CONFIG.usage.gallonsPerFoot > 0 ? CONFIG.usage.gallonsPerFoot : 0,
  pumpRateGpm: CONFIG.usage.pumpRateGpm > 0 ? CONFIG.usage.pumpRateGpm : 0,
  autoPumpRate: true
};

const usageState = {
  gallonsPerFoot: 0,
  pumpRateGpm: 0,
  pumpRateSource: "unknown",
  lastComputedAt: null
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

// Bumped on every (re)initialization of the pump output. Any async retry loop
// left over from a previous output captures the value at its creation and
// stops touching shared state once it no longer matches - otherwise a
// hot-swap of output hardware leaves an orphaned reconnect loop racing the new
// one and clobbering pumpState with faults from hardware we no longer use.
let pumpOutputGeneration = 0;
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
  // Inclusive on purpose. fullFeet is clamped to at most the tank's maximum, so
  // an installation whose full level sits exactly at the top of the tank could
  // never satisfy a strict greater-than - the level has nowhere above to go.
  if (feet >= alertSettings.fullFeet) {
    return { level: "full", label: "Near Full" };
  }
  return { level: "normal", label: "Normal" };
}

// The level thresholds the tank graphic labels itself with. Only the
// single-reading callers ask for these: enrichReading is also mapped over whole
// trend and history result sets, and getAlertSettings() is a database read, so
// including them unconditionally would add one query per row.
function markThresholds() {
  const alertSettings = getAlertSettings();
  return {
    lowWarningFeet: alertSettings.lowWarningFeet,
    criticalFeet: alertSettings.criticalFeet,
    fullFeet: alertSettings.fullFeet
  };
}

function enrichReading(row, { includeThresholds = false } = {}) {
  const thresholds = includeThresholds ? markThresholds() : null;

  if (!row) {
    return {
      reading: null,
      percentFull: 0,
      communication: getCommunicationStatus(null),
      alarm: getAlarmState(null),
      maxFeet: CONFIG.maxFeet,
      ...thresholds
    };
  }

  const percentFull = round(clamp((row.feet / CONFIG.maxFeet) * 100, 0, 100), 1);
  return {
    ...row,
    percentFull,
    communication: getCommunicationStatus(row.timestamp),
    alarm: getAlarmState(row.feet),
    maxFeet: CONFIG.maxFeet,
    ...thresholds
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

// Releases whatever output hardware is currently held, driving it OFF on the
// way out, and invalidates any in-flight reconnect loop. Safe to call when no
// output is open. This is what makes an output change applyable in place: the
// old GPIO export or serial connection is fully released before the new one is
// opened, which is the same ordering a process restart gave us before.
function teardownPumpOutput() {
  pumpOutputGeneration += 1;
  const previous = pumpOutput;
  pumpOutput = null;
  pumpState.output.available = false;

  if (!previous) return;

  try {
    if (previous.kind === "gpio") {
      previous.gpio.writeSync(previous.activeHigh ? 0 : 1);
      previous.gpio.unexport();
    } else if (previous.kind === "usb_relay") {
      if (previous.retryTimer) clearTimeout(previous.retryTimer);
      if (previous.port?.isOpen) {
        previous.port.write(USB_RELAY_OFF);
        previous.port.close();
      }
    }
  } catch (error) {
    console.warn(`Releasing previous pump output failed: ${error.message}`);
  }
}

// Note that this runs even when PUMP_CONTROL_ENABLED is false. Opening the
// output only ever drives it OFF, so doing it unconditionally is strictly
// safer than leaving the hardware untouched - and it means the Settings page
// can tell you whether the relay is actually plugged in and talking *before*
// you commit to enabling control. Energizing is still gated on
// CONFIG.pump.enabled in evaluatePumpControl().
function initPumpOutput() {
  teardownPumpOutput();

  const generation = pumpOutputGeneration;
  const settings = getPumpOutputSettings();
  pumpState.output.type = settings.type;
  pumpState.fault = null;
  pumpOutputReadyDeadline = Date.now() + PUMP_FAULT_ALERT_GRACE_MS;

  if (settings.type === "usb_relay") {
    initUsbRelayOutput(generation);
    return;
  }

  try {
    const { Gpio } = require("onoff");
    const gpio = new Gpio(settings.gpioPin, "out");
    pumpOutput = { kind: "gpio", gpio, activeHigh: settings.gpioActiveHigh, generation };
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
  // trusting a fixed path.
  //
  // When VID/PID are set and nothing matches, this deliberately returns null
  // rather than falling back to usbRelayPort. The saved path is only a
  // fallback for when identity matching is not configured at all. Once you
  // have told us what the relay *is*, a no-match means the relay is not
  // present - and /dev/ttyUSB1 may well have been renumbered to the water
  // level sensor by then. Sending relay commands to the sensor's port is a
  // worse failure than reporting the relay as missing.
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

function initUsbRelayOutput(generation) {
  const output = {
    kind: "usb_relay",
    port: null,
    path: null,
    retryTimer: null,
    connecting: false,
    generation
  };
  pumpOutput = output;

  // Two invariants this loop holds that the previous version did not:
  //
  //   - At most one retry is pending and at most one open() is in flight, so
  //     a reconnect can never fan out into overlapping attempts against the
  //     same device. Previously a retry could be scheduled from the open()
  //     callback and from the port's "close" event, and each attempt created
  //     a fresh SerialPort while the discarded one kept its listeners.
  //   - It stops touching shared state as soon as it is no longer the current
  //     output. That is a hard requirement now that settings can be applied
  //     without restarting: without it, a loop still hunting for the old
  //     device would keep overwriting pumpState.fault with stale failures
  //     about hardware the operator already moved away from.
  const isCurrent = () => pumpOutput === output && pumpOutputGeneration === generation;

  const scheduleReopen = () => {
    if (!isCurrent() || output.retryTimer) return;
    output.retryTimer = setTimeout(() => {
      output.retryTimer = null;
      reopen();
    }, USB_RELAY_RETRY_MS);
    output.retryTimer.unref?.();
  };

  const openPort = (path, baudRate) => new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate, autoOpen: false });
    output.port = port;
    output.path = path;

    port.on("open", () => {
      if (!isCurrent()) return;
      pumpState.output.available = true;
      pumpState.fault = null;
      pumpState.reason = `USB relay on ${path} initialized off.`;
      console.log(`Pump USB relay connected at ${path} (${baudRate} baud)`);
      writePumpOutput(false);
    });

    port.on("error", (error) => {
      if (!isCurrent()) return;
      pumpState.output.available = false;
      pumpState.fault = `USB relay error: ${error.message}`;
      console.error(pumpState.fault);
    });

    port.on("close", () => {
      if (!isCurrent()) return;
      pumpState.output.available = false;
      pumpState.fault = "USB relay port closed.";
      pumpState.output.dropCount += 1;
      pumpState.output.lastDropAt = new Date().toISOString();
      console.warn(`Pump USB relay port closed (drop #${pumpState.output.dropCount}); ` +
        `retrying in ${Math.round(USB_RELAY_RETRY_MS / 1000)} seconds.`);
      scheduleReopen();
    });

    port.open((error) => (error ? reject(error) : resolve()));
  });

  const reopen = async () => {
    if (!isCurrent() || output.connecting || output.port?.isOpen) return;
    output.connecting = true;

    try {
      // Re-read settings on every attempt instead of closing over the values
      // captured at init. A retry loop that keeps hunting for the device you
      // configured ten minutes ago is exactly the "it only works after a
      // restart" behavior we are trying to remove.
      const settings = getPumpOutputSettings();
      if (settings.type !== "usb_relay") return;

      const byIdentity = Boolean(settings.usbRelayVendorId && settings.usbRelayProductId);
      if (!settings.usbRelayPort && !byIdentity) {
        pumpState.output.available = false;
        pumpState.fault = "USB relay port is not configured.";
        pumpState.reason = "No USB relay port set; pump held off.";
        return;
      }

      const path = await resolveUsbRelayPath(settings);
      if (!isCurrent()) return;

      if (!path) {
        pumpState.output.available = false;
        pumpState.fault = byIdentity
          ? `No USB relay matching ${settings.usbRelayVendorId}:${settings.usbRelayProductId} found.`
          : "USB relay port is not configured.";
        console.warn(pumpState.fault);
        scheduleReopen();
        return;
      }

      await openPort(path, settings.usbRelayBaud);
    } catch (error) {
      if (!isCurrent()) return;
      pumpState.output.available = false;
      pumpState.fault = `USB relay unavailable: ${error.message}`;
      console.warn(pumpState.fault);
      scheduleReopen();
    } finally {
      output.connecting = false;
    }
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

// Completed pump runs, reconstructed by pairing on/off transitions in
// pump_events. Derived rather than recorded in its own table because
// pump_events is never pruned, so this works over history that predates the
// feature instead of starting from empty.
//
// Not every run has a clean end. The watchdog cuts the relay directly, and a
// hard kill leaves no chance to log anything, so an "on" can be followed by
// another "on" with no "off" between them. Those runs get closed at the last
// moment we have evidence for and flagged, rather than dropped (which would
// under-report runtime) or run forward to now (which would wildly over-report).
function getPumpRuns({ sinceIso, limit = 100 }) {
  const events = statements.pumpEventsSince.all(sinceIso);
  const runs = [];
  let open = null;

  const close = (endedAt, endReason, endFeet, endedUnexpectedly) => {
    const seconds = Math.max(0,
      Math.round((new Date(endedAt).getTime() - new Date(open.startedAt).getTime()) / 1000));
    runs.push({ ...open, endedAt, endReason, endFeet, seconds, endedUnexpectedly, inProgress: false });
    open = null;
  };

  for (const event of events) {
    const isOn = Boolean(event.pump_on);

    if (isOn && !open) {
      open = {
        startedAt: event.timestamp,
        startReason: event.reason,
        startFeet: event.feet,
        mode: event.mode
      };
      continue;
    }

    // A second "on" with no "off" between: the previous run ended without
    // being recorded. Its true end is unknown but is no later than this.
    if (isOn && open) {
      close(event.timestamp, "Ended without being recorded - the monitor was restarted or the backup safety system cut the pump.", event.feet, true);
      open = {
        startedAt: event.timestamp,
        startReason: event.reason,
        startFeet: event.feet,
        mode: event.mode
      };
      continue;
    }

    if (!isOn && open) close(event.timestamp, event.reason, event.feet, false);
  }

  // A still-running pump is reported with the runtime it has so far, so the log
  // agrees with the live pump panel instead of omitting the run in progress.
  if (open) {
    runs.push({
      ...open,
      endedAt: null,
      endReason: null,
      endFeet: null,
      seconds: Math.max(0, Math.round((Date.now() - new Date(open.startedAt).getTime()) / 1000)),
      endedUnexpectedly: false,
      inProgress: true
    });
  }

  runs.reverse();
  const totalSeconds = runs.reduce((sum, run) => sum + run.seconds, 0);
  return {
    runs: runs.slice(0, limit),
    totalRuns: runs.length,
    totalSeconds,
    longestSeconds: runs.reduce((max, run) => Math.max(max, run.seconds), 0),
    truncated: runs.length > limit
  };
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
    if (!pumpAlertState.faultNotified && Date.now() >= pumpOutputReadyDeadline) {
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
    latest: enrichReading(latest, { includeThresholds: true })
  };
}

function getUsageSettings() {
  return sanitizeUsageSettings(getStoredJsonSetting("usage", DEFAULT_USAGE_SETTINGS));
}

function sanitizeUsageSettings(input) {
  const tankDiameterFeet = round(clamp(Number(input.tankDiameterFeet), 0, 500), 2);
  const gallonsPerFootOverride = round(clamp(Number(input.gallonsPerFootOverride), 0, 1000000), 2);
  const pumpRateGpm = round(clamp(Number(input.pumpRateGpm), 0, 10000), 2);

  return {
    tankDiameterFeet: Number.isFinite(tankDiameterFeet) ? tankDiameterFeet : DEFAULT_USAGE_SETTINGS.tankDiameterFeet,
    gallonsPerFootOverride: Number.isFinite(gallonsPerFootOverride) ? gallonsPerFootOverride : 0,
    pumpRateGpm: Number.isFinite(pumpRateGpm) ? pumpRateGpm : 0,
    autoPumpRate: Boolean(input.autoPumpRate)
  };
}

function resolveGallonsPerFoot(settings) {
  if (settings.gallonsPerFootOverride > 0) return settings.gallonsPerFootOverride;
  if (!(settings.tankDiameterFeet > 0)) return 0;
  const radius = settings.tankDiameterFeet / 2;
  return Math.PI * radius * radius * GALLONS_PER_CUBIC_FOOT;
}

function localDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDayStart(dayKey) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function addDays(dayKey, delta) {
  const date = localDayStart(dayKey);
  date.setDate(date.getDate() + delta);
  return localDayKey(date);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.round((sorted.length - 1) * fraction), 0, sorted.length - 1);
  return sorted[index];
}

// Collapses raw readings into one representative sample per time bucket:
// median level (noise rejection) at the mean timestamp of the bucket.
function bucketReadings(rows, originMs, bucketMs) {
  const buckets = new Map();

  for (const row of rows) {
    const time = new Date(row.timestamp).getTime();
    if (!Number.isFinite(time) || !Number.isFinite(row.feet)) continue;
    const index = Math.floor((time - originMs) / bucketMs);
    if (!buckets.has(index)) buckets.set(index, { times: [], feet: [] });
    const bucket = buckets.get(index);
    bucket.times.push(time);
    bucket.feet.push(row.feet);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bucket]) => ({
      t: bucket.times.reduce((sum, value) => sum + value, 0) / bucket.times.length,
      feet: median(bucket.feet)
    }));
}

// Minutes the pump was energized between two instants, reconstructed from the
// pump_events timeline. pump_events is never pruned, so this stays accurate
// for days whose readings are long gone.
function pumpOnMinutesBetween(fromMs, toMs) {
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();

  let on = statements.lastPumpStateBefore.get(fromIso)?.pump_on === 1;
  let cursor = fromMs;
  let onMs = 0;

  for (const event of statements.pumpEventsBetween.all(fromIso, toIso)) {
    const time = new Date(event.timestamp).getTime();
    if (!Number.isFinite(time)) continue;
    const clamped = clamp(time, fromMs, toMs);
    if (on) onMs += clamped - cursor;
    cursor = clamped;
    on = event.pump_on === 1;
  }

  if (on) onMs += toMs - cursor;
  return onMs / 60000;
}

// Infers the pump's delivery rate from how fast the tank actually rose during
// intervals when the pump ran the whole time.
//
// A net rise always *understates* the pump, because the camp is usually still
// drawing water while the tank fills. The fastest observed fills are the ones
// with the least draw against them, so the high end of the distribution is the
// closest approximation to what the pump really puts out. The 90th percentile
// rather than the maximum keeps one noisy bucket from setting the number.
function estimatePumpRateGpm(gallonsPerFoot) {
  const since = new Date(Date.now() - USAGE_PUMP_RATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = statements.trendRange.all(since.toISOString());
  if (rows.length < 8) return 0;

  const samples = bucketReadings(rows, since.getTime(), USAGE_PUMP_RATE_BUCKET_MS);
  const rates = [];

  for (let i = 1; i < samples.length; i += 1) {
    const previous = samples[i - 1];
    const current = samples[i];
    const gapMinutes = (current.t - previous.t) / 60000;
    if (!(gapMinutes > 0) || gapMinutes > USAGE_MAX_GAP_MINUTES) continue;

    // Require the pump to have been on for essentially the whole interval,
    // otherwise part of the rise happened with the pump off and the rate comes
    // out too low.
    const pumpMinutes = pumpOnMinutesBetween(previous.t, current.t);
    if (pumpMinutes < gapMinutes * 0.98) continue;

    const riseFeet = current.feet - previous.feet;
    if (riseFeet <= USAGE_DEADBAND_FEET) continue;

    rates.push((riseFeet * gallonsPerFoot) / gapMinutes);
  }

  if (rates.length < 5) return 0;
  return round(percentile(rates, 0.9), 2);
}

function resolvePumpRateGpm(settings, gallonsPerFoot) {
  if (!settings.autoPumpRate) {
    usageState.pumpRateSource = settings.pumpRateGpm > 0 ? "manual" : "unset";
    return settings.pumpRateGpm;
  }

  const estimated = estimatePumpRateGpm(gallonsPerFoot);
  if (estimated > 0) {
    usageState.pumpRateSource = "estimated";
    return estimated;
  }

  usageState.pumpRateSource = settings.pumpRateGpm > 0 ? "manual-fallback" : "unset";
  return settings.pumpRateGpm;
}

// Estimated gallons consumed during one local calendar day. Returns null when
// there is nothing to compute from, which deliberately leaves any previously
// stored row for that day untouched - so pruning old readings can never erase
// or shrink usage history that was already rolled up.
function computeUsageForDay(dayKey, context) {
  const startMs = localDayStart(dayKey).getTime();
  const endMs = Math.min(localDayStart(addDays(dayKey, 1)).getTime(), Date.now());
  if (endMs <= startMs) return null;

  const rows = statements.readingsBetween.all(
    new Date(startMs).toISOString(),
    new Date(endMs).toISOString()
  );
  if (!rows.length) return null;

  const samples = bucketReadings(rows, startMs, USAGE_BUCKET_MS);

  // Seed with the last reading at or before midnight so water used during the
  // first hour is attributed instead of dropped.
  const baseline = statements.readingAtOrBefore.get(new Date(startMs).toISOString());
  if (baseline) {
    const baselineMs = new Date(baseline.timestamp).getTime();
    if (Number.isFinite(baselineMs) && startMs - baselineMs <= USAGE_MAX_GAP_MINUTES * 60000) {
      samples.unshift({ t: baselineMs, feet: baseline.feet });
    }
  }

  if (samples.length < 2) return null;

  let gallons = 0;
  let dropFeet = 0;
  let pumpMinutes = 0;
  let coveredMinutes = 0;

  for (let i = 1; i < samples.length; i += 1) {
    const previous = samples[i - 1];
    const current = samples[i];
    const gapMinutes = (current.t - previous.t) / 60000;
    if (!(gapMinutes > 0) || gapMinutes > USAGE_MAX_GAP_MINUTES) continue;

    let intervalDrop = previous.feet - current.feet;
    if (Math.abs(intervalDrop) < USAGE_DEADBAND_FEET) intervalDrop = 0;

    // Recorded even when no pump rate is known yet. It costs one extra lookup
    // and it means that once a rate does become available, days whose raw
    // readings have since been pruned can still be repriced from stored
    // inputs instead of being stuck at their rate-less estimate forever.
    const intervalPumpMinutes = pumpOnMinutesBetween(previous.t, current.t);

    const intervalGallons = intervalDrop * context.gallonsPerFoot
      + intervalPumpMinutes * context.pumpRateGpm;

    // Clamped per interval: a rising tank with the pump off means water was
    // added by some other means (or the sensor moved), not negative usage.
    gallons += Math.max(0, intervalGallons);
    dropFeet += intervalDrop;
    pumpMinutes += intervalPumpMinutes;
    coveredMinutes += gapMinutes;
  }

  return {
    day: dayKey,
    gallons: round(gallons, 1),
    drop_feet: round(dropFeet, 4),
    pump_minutes: round(pumpMinutes, 2),
    pump_rate: context.pumpRateGpm,
    gallons_per_foot: round(context.gallonsPerFoot, 4),
    covered_minutes: round(coveredMinutes, 1),
    computed_at: new Date().toISOString()
  };
}

const writeDailyUsageRows = db.transaction((rows) => {
  for (const row of rows) statements.upsertDailyUsage.run(row);
});

const rescaleDailyUsageRows = db.transaction((rows) => {
  for (const row of rows) statements.rescaleDailyUsage.run(row);
});

// Reprices already-rolled-up days that we can no longer recompute from raw
// readings (they were pruned). Uses the stored drop/pump-minute inputs, so
// correcting the tank diameter or pump rate later fixes the whole two-year
// history instead of leaving a discontinuity at the retention boundary.
function rescaleStoredUsage(gallonsPerFoot, pumpRateGpm) {
  const todayKey = localDayKey(new Date());
  const rows = statements.dailyUsageRange.all(addDays(todayKey, -USAGE_ROLLING_DAYS), todayKey);
  const computedAt = new Date().toISOString();

  const updates = rows
    .filter((row) => Number.isFinite(row.drop_feet)
      && Math.abs((row.gallons_per_foot ?? 0) - gallonsPerFoot) > 1e-6)
    .map((row) => ({
      day: row.day,
      gallons: round(Math.max(0, row.drop_feet * gallonsPerFoot + (row.pump_minutes || 0) * pumpRateGpm), 1),
      pump_rate: pumpRateGpm,
      gallons_per_foot: round(gallonsPerFoot, 4),
      computed_at: computedAt
    }));

  if (updates.length) {
    rescaleDailyUsageRows(updates);
    console.log(`Repriced ${updates.length} days of usage history at ${round(gallonsPerFoot, 1)} gal/ft.`);
  }
  return updates.length;
}

function refreshDailyUsage(options = {}) {
  const settings = getUsageSettings();
  const gallonsPerFoot = resolveGallonsPerFoot(settings);

  usageState.gallonsPerFoot = gallonsPerFoot;
  if (!(gallonsPerFoot > 0)) {
    usageState.pumpRateSource = "unset";
    return;
  }

  const pumpRateGpm = resolvePumpRateGpm(settings, gallonsPerFoot);
  usageState.pumpRateGpm = pumpRateGpm;

  if (options.rescale) rescaleStoredUsage(gallonsPerFoot, pumpRateGpm);

  const first = statements.firstReadingTime.get();
  if (!first) return;

  const todayKey = localDayKey(new Date());
  const earliestKey = addDays(todayKey, -USAGE_ROLLING_DAYS);
  let cursor = localDayKey(new Date(first.timestamp));
  if (cursor < earliestKey) cursor = earliestKey;

  const known = new Set(statements.dailyUsageDays.all(cursor, todayKey).map((row) => row.day));
  const alwaysRecomputeFrom = addDays(todayKey, -(USAGE_RECOMPUTE_DAYS - 1));
  const context = { gallonsPerFoot, pumpRateGpm };
  const writes = [];

  for (let day = cursor; day <= todayKey; day = addDays(day, 1)) {
    const stale = options.full || !known.has(day) || day >= alwaysRecomputeFrom;
    if (!stale) continue;
    const computed = computeUsageForDay(day, context);
    if (computed) writes.push(computed);
  }

  if (writes.length) writeDailyUsageRows(writes);
  usageState.lastComputedAt = new Date().toISOString();
}

function summarizeUsage() {
  const settings = getUsageSettings();
  const gallonsPerFoot = resolveGallonsPerFoot(settings);
  const todayKey = localDayKey(new Date());
  const rows = statements.dailyUsageRange.all(addDays(todayKey, -(USAGE_ROLLING_DAYS - 1)), todayKey);

  const totalSince = (days) => {
    const from = addDays(todayKey, -(days - 1));
    return round(rows.reduce((sum, row) => (row.day >= from ? sum + row.gallons : sum), 0), 0);
  };

  const monthly = new Map();
  for (const row of rows) {
    const month = row.day.slice(0, 7);
    monthly.set(month, round((monthly.get(month) || 0) + row.gallons, 0));
  }

  const coveredMinutes = rows.reduce((sum, row) => sum + (row.covered_minutes || 0), 0);
  const spanDays = rows.length ? Math.max(1, rows.length) : 0;

  return {
    configured: gallonsPerFoot > 0,
    gallonsPerFoot: round(gallonsPerFoot, 1),
    tankDiameterFeet: settings.tankDiameterFeet,
    pumpRateGpm: usageState.pumpRateGpm,
    pumpRateSource: usageState.pumpRateSource,
    lastComputedAt: usageState.lastComputedAt,
    rollingDays: USAGE_ROLLING_DAYS,
    firstDay: rows.length ? rows[0].day : null,
    lastDay: rows.length ? rows[rows.length - 1].day : null,
    daysRecorded: rows.length,
    // What fraction of the recorded span the sensor was actually reporting
    // for. A two-year total built from patchy data should say so rather than
    // quietly reading low.
    coveragePercent: spanDays ? round(clamp((coveredMinutes / (spanDays * 1440)) * 100, 0, 100), 1) : 0,
    today: totalSince(1),
    last7Days: totalSince(7),
    last30Days: totalSince(30),
    last365Days: totalSince(365),
    last730Days: totalSince(730),
    monthly: [...monthly.entries()].map(([month, gallons]) => ({ month, gallons })),
    daily: rows.map((row) => ({ day: row.day, gallons: row.gallons }))
  };
}

function saveReading(input) {
  const reading = normalizeReading(input);
  const result = statements.insertReading.run(reading);
  const saved = { id: result.lastInsertRowid, ...reading };
  const payload = enrichReading(saved, { includeThresholds: true });
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
  res.write(`event: latest\ndata: ${JSON.stringify(enrichReading(statements.latest.get(), { includeThresholds: true }))}\n\n`);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

app.get("/api/latest", (req, res) => {
  res.json(enrichReading(statements.latest.get(), { includeThresholds: true }));
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

app.get("/api/pump/runs", (req, res) => {
  const requestedDays = Number.parseInt(req.query.days || "30", 10);
  const days = Number.isFinite(requestedDays) ? clamp(requestedDays, 1, 730) : 30;
  const requestedLimit = Number.parseInt(req.query.limit || "50", 10);
  const limit = Number.isFinite(requestedLimit) ? clamp(requestedLimit, 1, 500) : 50;
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  res.json({ days, since: sinceIso, ...getPumpRuns({ sinceIso, limit }) });
});

app.get("/api/health", (req, res) => {
  const latest = statements.latest.get();
  const alertSettings = getAlertSettings();
  res.json({
    ok: true,
    mode: serialState.mode,
    serial: serialState,
    database: CONFIG.dbPath,
    latest: enrichReading(latest, { includeThresholds: true }),
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

app.get("/api/usage", (req, res) => {
  res.json(summarizeUsage());
});

app.get("/api/config/usage", (req, res) => {
  const settings = getUsageSettings();
  res.json({
    ...settings,
    gallonsPerFoot: round(resolveGallonsPerFoot(settings), 1),
    effectivePumpRateGpm: usageState.pumpRateGpm,
    pumpRateSource: usageState.pumpRateSource
  });
});

app.post("/api/config/usage", (req, res) => {
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "Usage settings changes require confirm=true." });
    return;
  }

  try {
    const next = sanitizeUsageSettings(req.body);
    saveStoredJsonSetting("usage", next);
    // Reprice the stored history and recompute everything we still have
    // readings for, so the change applies to the whole two-year window rather
    // than only to days from here forward.
    refreshDailyUsage({ full: true, rescale: true });
    res.json({
      ...next,
      gallonsPerFoot: round(resolveGallonsPerFoot(next), 1),
      effectivePumpRateGpm: usageState.pumpRateGpm,
      pumpRateSource: usageState.pumpRateSource,
      usage: summarizeUsage()
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
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
  // maxFeet rides along so the form can bound its inputs to the real tank
  // height instead of the 8.0 that used to be typed into the markup.
  res.json({ ...getAlertSettings(), maxFeet: CONFIG.maxFeet });
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

// Live view of what the output hardware is actually doing right now, so the
// Settings page can answer "is the relay plugged in and talking?" without
// anyone having to read logs or restart anything.
function getPumpOutputStatus() {
  return {
    controlEnabled: CONFIG.pump.enabled,
    type: pumpState.output.type,
    available: pumpState.output.available,
    fault: pumpState.fault,
    connectedPath: pumpOutput?.kind === "usb_relay" && pumpOutput.port?.isOpen ? pumpOutput.path : null,
    dropCount: pumpState.output.dropCount,
    lastDropAt: pumpState.output.lastDropAt
  };
}

app.get("/api/config/pump-output", (req, res) => {
  res.json({
    ...getPumpOutputSettings(),
    recommendation: PUMP_OUTPUT_RECOMMENDATION,
    status: getPumpOutputStatus()
  });
});

// Opening a serial port is asynchronous, so the instant after initPumpOutput()
// returns the output is always still "unavailable". Settling briefly before
// reporting means the operator sees the actual outcome of what they just did
// instead of a failure that corrects itself a moment later.
const PUMP_OUTPUT_SETTLE_MS = 2000;

async function applyPumpOutputChange() {
  initPumpOutput();
  await new Promise((resolve) => setTimeout(resolve, PUMP_OUTPUT_SETTLE_MS));
  evaluatePumpControl();
  return getPumpOutputStatus();
}

app.post("/api/config/pump-output", async (req, res) => {
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "Pump output changes require confirm=true." });
    return;
  }

  let next;
  try {
    next = sanitizePumpOutputSettings(req.body);
    saveStoredJsonSetting("pumpOutput", next);
    logPumpEvent("output-config", "Pump output hardware changed from dashboard.", statements.latest.get());
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  // Apply immediately rather than telling the operator to restart. Teardown
  // releases the old export/serial connection and drives it off first, so the
  // ordering is the same one a restart used to provide.
  const status = await applyPumpOutputChange();
  res.json({ ...next, recommendation: PUMP_OUTPUT_RECOMMENDATION, status });
});

// Re-scan for the relay on demand. This is the "I just plugged it in" button:
// USB devices that appear after the app started, or that came back on a
// different /dev path, are picked up here instead of at the next reboot.
app.post("/api/config/pump-output/reconnect", async (req, res) => {
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "Reconnecting the pump output requires confirm=true." });
    return;
  }

  res.json({ status: await applyPumpOutputChange() });
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
  // Roll usage up before the first prune so that a day about to fall out of
  // the readings retention window is captured in daily_usage first.
  try {
    refreshDailyUsage({ full: true });
  } catch (error) {
    console.error(`Initial usage rollup failed: ${error.message}`);
  }
  setInterval(() => {
    try {
      refreshDailyUsage();
    } catch (error) {
      console.error(`Usage rollup failed: ${error.message}`);
    }
  }, 60 * 60 * 1000).unref();

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
