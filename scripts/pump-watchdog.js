"use strict";

// Independent fail-safe for the pump relay.
//
// This runs as a separate process from the main app on purpose: if the main
// app deadlocks, segfaults in a native module, or is killed with SIGKILL, it
// cannot run its own crash handlers. This watchdog has no dependency on the
// main app's event loop or its code - it only talks to the main app over
// HTTP and to the relay hardware directly.
//
// Two independent reasons this watchdog will force the relay off:
//
//   1. Liveness: the main app's /api/pump/status stops responding for
//      WATCHDOG_FAILURE_THRESHOLD consecutive checks. Covers the main app
//      being dead, deadlocked, or unreachable.
//
//   2. Max runtime: this watchdog has been observing pumpOn=true for longer
//      than WATCHDOG_MAX_RUNTIME_MINUTES, using its own clock - not the main
//      app's self-reported runtime. The main app has its own max-runtime
//      safety stop, but that logic lives in the same process that could be
//      the thing that's broken. This is a second, independent ceiling that
//      does not trust the main app to be telling the truth about its own
//      state, so a logic bug that leaves the pump on all night (not just a
//      crash) still gets caught and cut.
//
// On either trigger, this also tries to flip the main app's persisted pump
// mode to manual_off (best-effort, direct SQLite write) so that if/when the
// main app recovers, it does not immediately re-energize the pump from a
// stuck "auto" or "manual_on" setting. The physical relay/GPIO cutoff below
// does not depend on this succeeding.
//
// This does not protect against the Pi/relay losing power entirely - only
// fail-open relay/contactor wiring (see README "Recommended hardware
// pattern") protects against that.

const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const Database = require("better-sqlite3");

const CONFIG = {
  statusUrl: process.env.WATCHDOG_STATUS_URL
    || `http://127.0.0.1:${process.env.PORT || "80"}/api/pump/status`,
  dbPath: process.env.DB_PATH || path.join(__dirname, "..", "water-monitor.sqlite"),
  intervalSeconds: Number.parseFloat(process.env.WATCHDOG_INTERVAL_SECONDS || "5"),
  failureThreshold: Number.parseInt(process.env.WATCHDOG_FAILURE_THRESHOLD || "3", 10),
  maxRuntimeMinutes: Number.parseFloat(process.env.WATCHDOG_MAX_RUNTIME_MINUTES || "150"),
  requestTimeoutMs: 3000,
  gpioPin: Number.parseInt(process.env.PUMP_GPIO_PIN || "17", 10),
  gpioActiveHigh: String(process.env.PUMP_GPIO_ACTIVE_HIGH || "true").toLowerCase() !== "false",
  usbRelayPort: process.env.PUMP_USB_RELAY_PORT || "",
  usbRelayBaud: Number.parseInt(process.env.PUMP_USB_RELAY_BAUD || "9600", 10),
  usbRelayVendorId: process.env.PUMP_USB_RELAY_VENDOR_ID || "",
  usbRelayProductId: process.env.PUMP_USB_RELAY_PRODUCT_ID || "",
  outputType: process.env.PUMP_OUTPUT || ""
};

const USB_RELAY_OFF = Buffer.from([0xa0, 0x01, 0x00, 0xa1]);
const MAX_RUNTIME_MS = Math.max(0.01, CONFIG.maxRuntimeMinutes) * 60 * 1000;

let consecutiveFailures = 0;
let unhealthy = false;
let pumpOnObservedSince = null;
let maxRuntimeTripped = false;

function getOutputSettings() {
  // Read the live setting the main app actually uses, if the database is
  // reachable. This is a plain file read independent of whether the main
  // app process is alive. Falls back to env vars if the DB can't be opened
  // (e.g. it does not exist yet) so the watchdog still has something to
  // act on.
  try {
    const db = new Database(CONFIG.dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get("pumpOutput");
    db.close();
    if (row) {
      const stored = JSON.parse(row.value);
      return {
        type: stored.type === "usb_relay" ? "usb_relay" : "gpio",
        gpioPin: Number.isFinite(Number(stored.gpioPin)) ? Number(stored.gpioPin) : CONFIG.gpioPin,
        gpioActiveHigh: Boolean(stored.gpioActiveHigh),
        usbRelayPort: stored.usbRelayPort || CONFIG.usbRelayPort,
        usbRelayBaud: Number.isFinite(Number(stored.usbRelayBaud)) ? Number(stored.usbRelayBaud) : CONFIG.usbRelayBaud,
        usbRelayVendorId: stored.usbRelayVendorId || CONFIG.usbRelayVendorId,
        usbRelayProductId: stored.usbRelayProductId || CONFIG.usbRelayProductId
      };
    }
  } catch (error) {
    console.warn(`Watchdog could not read pump output setting from database: ${error.message}`);
  }

  return {
    type: CONFIG.outputType === "usb_relay" ? "usb_relay" : "gpio",
    gpioPin: CONFIG.gpioPin,
    gpioActiveHigh: CONFIG.gpioActiveHigh,
    usbRelayPort: CONFIG.usbRelayPort,
    usbRelayBaud: CONFIG.usbRelayBaud,
    usbRelayVendorId: CONFIG.usbRelayVendorId,
    usbRelayProductId: CONFIG.usbRelayProductId
  };
}

function formatDuration(minutes) {
  if (minutes >= 60) {
    const hours = minutes / 60;
    const label = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
    return `${label} hour${hours === 1 ? "" : "s"}`;
  }
  const mins = Math.round(minutes);
  return `${mins} minute${mins === 1 ? "" : "s"}`;
}

function getNtfySettings() {
  // Read the same ntfy settings the main app saves from /config.html. Plain
  // file read, independent of whether the main app process is alive - so the
  // watchdog can still send an alert precisely when the main app is the thing
  // that has died.
  try {
    const db = new Database(CONFIG.dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get("ntfy");
    db.close();
    if (row) {
      const stored = JSON.parse(row.value);
      return {
        enabled: Boolean(stored.enabled),
        serverUrl: String(stored.serverUrl || "").replace(/\/+$/, ""),
        topic: String(stored.topic || ""),
        token: String(stored.token || "")
      };
    }
  } catch (error) {
    console.warn(`Watchdog could not read ntfy settings from database: ${error.message}`);
  }
  return { enabled: false, serverUrl: "", topic: "", token: "" };
}

function sendNtfyAlert(title, message, options = {}) {
  // Wrapped so a malformed setting or header can never throw out of here -
  // this is the watchdog; it must not crash while trying to raise an alarm.
  // Title stays ASCII (HTTP headers cannot carry emoji); visual urgency comes
  // from the ASCII Tags (emoji shortcodes) and Priority headers instead.
  try {
    const settings = getNtfySettings();
    if (!settings.enabled || !settings.serverUrl || !settings.topic) return;

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
        ...(options.priority ? { Priority: String(options.priority) } : {}),
        ...(options.tags ? { Tags: options.tags } : {}),
        ...(settings.token ? { Authorization: `Bearer ${settings.token}` } : {})
      }
    }, (response) => response.resume());

    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (error) => console.warn(`Watchdog: ntfy alert failed: ${error.message}`));
    req.end(body);
  } catch (error) {
    console.warn(`Watchdog: could not send ntfy alert: ${error.message}`);
  }
}

function forcePersistedModeToManualOff(reason) {
  // Best-effort only. The physical cutoff below does not depend on this.
  // Guards against the main app recovering and immediately re-energizing
  // the pump from a stuck "auto" or "manual_on" setting it never cleared.
  try {
    const db = new Database(CONFIG.dbPath, { fileMustExist: true, timeout: 2000 });
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get("pump");
    const current = row ? JSON.parse(row.value) : {};
    if (current.mode === "manual_off") {
      db.close();
      return;
    }
    const next = { ...current, mode: "manual_off" };
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('pump', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify(next), new Date().toISOString());
    db.close();
    console.warn(`Watchdog: forced persisted pump mode to manual_off (${reason}).`);
  } catch (error) {
    console.warn(`Watchdog: could not force persisted pump mode to manual_off: ${error.message}`);
  }
}

async function resolveUsbRelayPath(settings) {
  if (!settings.usbRelayVendorId || !settings.usbRelayProductId) {
    return settings.usbRelayPort || null;
  }

  try {
    const { SerialPort } = require("serialport");
    const ports = await SerialPort.list();
    const match = ports.find((candidate) =>
      (candidate.vendorId || "").toLowerCase() === settings.usbRelayVendorId.toLowerCase() &&
      (candidate.productId || "").toLowerCase() === settings.usbRelayProductId.toLowerCase());
    return match ? match.path : null;
  } catch (error) {
    console.warn(`Watchdog: USB relay discovery by vendor/product ID failed: ${error.message}`);
    return settings.usbRelayPort || null;
  }
}

async function forceRelayOff(reason) {
  forcePersistedModeToManualOff(reason);

  const settings = getOutputSettings();

  if (settings.type === "usb_relay") {
    const path = await resolveUsbRelayPath(settings);
    if (!path) {
      console.error("Watchdog: no USB relay found (by port or vendor/product ID), cannot force pump off.");
      return;
    }
    const { SerialPort } = require("serialport");
    // lock: false is deliberate. The main app holds an exclusive lock on
    // this same port while it's running; if this watchdog also requested
    // an exclusive lock, the one moment it needs to act - the main app
    // misbehaving while still holding the port open - is exactly the
    // moment its own open() would fail with "cannot lock port" and the
    // cutoff would silently not happen. This must work regardless of
    // whatever the main app is doing with the port.
    const port = new SerialPort({ path, baudRate: settings.usbRelayBaud, autoOpen: false, lock: false });
    port.open((error) => {
      if (error) {
        console.error(`Watchdog: could not open USB relay port to force pump off: ${error.message}`);
        return;
      }
      port.write(USB_RELAY_OFF, (writeError) => {
        if (writeError) console.error(`Watchdog: USB relay off write failed: ${writeError.message}`);
        port.close();
      });
    });
    return;
  }

  try {
    const { Gpio } = require("onoff");
    const gpio = new Gpio(settings.gpioPin, "out");
    gpio.writeSync(settings.gpioActiveHigh ? 0 : 1);
    gpio.unexport();
  } catch (error) {
    console.error(`Watchdog: could not drive GPIO pin to force pump off: ${error.message}`);
  }
}

function checkStatus() {
  const request = http.get(CONFIG.statusUrl, { timeout: CONFIG.requestTimeoutMs }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        onUnreachable(`status endpoint returned HTTP ${response.statusCode}`);
        return;
      }
      try {
        const status = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        onStatus(status);
      } catch (error) {
        onUnreachable(`could not parse status response: ${error.message}`);
      }
    });
  });

  request.on("timeout", () => request.destroy(new Error("status check timed out")));
  request.on("error", (error) => onUnreachable(error.message));
}

function onStatus(status) {
  if (unhealthy) {
    console.log("Watchdog: main app is responding again. Resuming passive monitoring.");
    sendNtfyAlert(
      "Water monitor back online",
      "The main water monitor is responding again and the backup safety system is back to just watching.\n\n" +
      "IMPORTANT: while it was down, the pump was left OFF and set to \"Manual Off.\" If the tank needs water, someone must turn the pump back on from the dashboard.",
      { tags: "white_check_mark" }
    );
  }
  consecutiveFailures = 0;
  unhealthy = false;

  if (!status.pumpOn) {
    pumpOnObservedSince = null;
    maxRuntimeTripped = false;
    return;
  }

  if (pumpOnObservedSince === null) {
    pumpOnObservedSince = Date.now();
    maxRuntimeTripped = false;
    return;
  }

  const observedRuntimeMs = Date.now() - pumpOnObservedSince;
  if (observedRuntimeMs >= MAX_RUNTIME_MS) {
    if (!maxRuntimeTripped) {
      console.error(`Watchdog: pump has been on for over ${CONFIG.maxRuntimeMinutes} minutes by this ` +
        `watchdog's own clock, regardless of what the main app reports. Forcing pump relay off.`);
      sendNtfyAlert(
        "Water pump EMERGENCY cutoff - ran too long",
        `The backup safety system forced the pump OFF because it had been running for over ${formatDuration(CONFIG.maxRuntimeMinutes)} straight - longer than it should ever take to fill the tank.\n\n` +
        "WHAT TO DO:\n" +
        "1. Go check the tank in person right away - is it full or overflowing?\n" +
        "2. If it is full, leave the pump off and check the float switch.\n" +
        "3. If it never filled, the pump may have lost its prime or a valve is closed - call maintenance.\n" +
        "4. The pump is locked to \"Manual Off.\" Only turn it back on from the dashboard after you have checked the tank.\n\n" +
        "Do not ignore this one.",
        { tags: "rotating_light", priority: "urgent" }
      );
    }
    maxRuntimeTripped = true;
    forceRelayOff(`independent max runtime of ${CONFIG.maxRuntimeMinutes} minutes exceeded`);
  }
}

function onUnreachable(detail) {
  consecutiveFailures += 1;
  console.warn(`Watchdog: status check failed (${consecutiveFailures}/${CONFIG.failureThreshold}): ${detail}`);

  if (consecutiveFailures >= CONFIG.failureThreshold) {
    if (!unhealthy) {
      console.error("Watchdog: main app appears down. Forcing pump relay off.");
      sendNtfyAlert(
        "Water pump EMERGENCY cutoff - monitor not responding",
        "The backup safety system had to force the pump OFF because the main water monitor stopped responding. This is the last-resort protection against the tank overflowing.\n\n" +
        "WHAT TO DO:\n" +
        "1. Try to open the dashboard. If it does not load, the Raspberry Pi likely needs restarting - unplug its power for 10 seconds, then plug it back in.\n" +
        "2. Walk out and check the tank's water level in person to be safe.\n" +
        "3. The pump has been left OFF and locked to \"Manual Off.\" Once the monitor is working again, someone must turn the pump back on from the dashboard.\n\n" +
        "Do not ignore this - the automatic system is not running right now. Call maintenance if the dashboard does not come back.",
        { tags: "rotating_light", priority: "urgent" }
      );
    }
    unhealthy = true;
    forceRelayOff("main app unreachable");
  }
}

console.log(`Pump watchdog started. Polling ${CONFIG.statusUrl} every ${CONFIG.intervalSeconds}s. ` +
  `Forces pump off after ${CONFIG.failureThreshold} consecutive failed checks, or after ` +
  `${CONFIG.maxRuntimeMinutes} minutes of independently observed continuous runtime, whichever comes first.`);

checkStatus();
setInterval(checkStatus, Math.max(1, CONFIG.intervalSeconds) * 1000);
