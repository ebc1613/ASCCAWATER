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
//      than the operator's configured max runtime plus a grace margin, using
//      its own clock - not the main app's self-reported runtime. The main app
//      has its own max-runtime safety stop, but that logic lives in the same
//      process that could be the thing that's broken. This is a second,
//      independent ceiling that does not trust the main app to be telling the
//      truth about its own state, so a logic bug that leaves the pump on all
//      night (not just a crash) still gets caught and cut.
//
//      The limit is read from the app's status endpoint so that the two agree
//      on the policy; only the elapsed-time measurement is independent. The
//      alternative - a fixed limit here - meant the watchdog quietly overruled
//      the dashboard and cut long fills short. Independence is about not
//      trusting the app's *observations*, not about ignoring the operator's
//      settings. A hard cap still bounds whatever the app asks for.
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
  // The watchdog's runtime ceiling follows the max runtime the operator set in
  // the app, plus a grace margin, and is capped by an absolute ceiling.
  //
  // It used to be a flat 150 minutes that ignored the app setting entirely, so
  // a tank legitimately configured for a long fill got cut off at 2.5 hours
  // with an urgent "ran too long" alert, every time. The watchdog was wrong and
  // the app was right, but the watchdog is the one holding the relay.
  //
  // The grace matters: the app enforces its own limit first, and the watchdog
  // should only fire if the app *failed* to. Without the margin both fire at
  // the same instant and every normal timed stop races an emergency cutoff.
  runtimeGraceMinutes: Number.parseFloat(process.env.WATCHDOG_RUNTIME_GRACE_MINUTES || "20"),
  // Absolute cap, whatever the app asks for. The app's own setting is clamped
  // to 24h, so 25h here means "the app's ceiling plus grace" can always be
  // honored, while a corrupted or hostile status payload still cannot talk this
  // watchdog out of ever cutting off.
  hardCeilingMinutes: Number.parseFloat(process.env.WATCHDOG_MAX_RUNTIME_MINUTES || "1500"),
  // Used only until the app has successfully reported its setting even once.
  fallbackRuntimeMinutes: Number.parseFloat(process.env.WATCHDOG_FALLBACK_RUNTIME_MINUTES || "150"),
  // How long to wait, at watchdog startup only, for the main app to come up
  // before treating silence as a failure. systemd starts both services
  // together at boot (After= orders the start, it does not wait for the app to
  // be listening), and the main app needs several seconds to open its
  // database and bind port 80. Without this, the watchdog reached its 3-strike
  // threshold ~15s into every boot and "rescued" a system that was merely
  // still starting: it rewrote the saved pump mode to manual_off and pushed an
  // urgent "EMERGENCY cutoff" notification, every single time the machine was
  // restarted. That is what made saved settings look like they did not
  // survive a reboot.
  startupGraceSeconds: Number.parseFloat(process.env.WATCHDOG_STARTUP_GRACE_SECONDS || "90"),
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

let consecutiveFailures = 0;
let unhealthy = false;
let pumpOnObservedSince = null;
let maxRuntimeTripped = false;
// The app's configured max runtime, as last reported over HTTP. null until the
// app has been reached and returned a usable number.
let appMaxRuntimeMinutes = null;

// Only the *limit* is learned from the app. The elapsed time it is measured
// against is always this watchdog's own clock, so an app that lies about (or
// loses track of) how long the pump has been running still gets caught.
// The app clamps its own max runtime to 24h before reporting it, and
// adoptAppRuntimeLimit() re-validates it against that same range here. So a
// value that has come from the app is already bounded, and the configured hard
// ceiling has nothing left to protect against on that path.
//
// It does still protect the fallback path (used before the app has ever been
// reached) and it stops the two numbers from drifting apart forever, so it is
// kept - but it is no longer allowed to clamp *below* what the operator set.
//
// This is the second half of the bug fixed in "let the watchdog follow the
// app's runtime limit". That change taught the watchdog to read the dashboard
// setting, but left WATCHDOG_MAX_RUNTIME_MINUTES clamping the result - and
// because scripts/install.sh only ever writes /etc/default/water-monitor when
// the file does not already exist, every box installed before that change
// still had the old flat WATCHDOG_MAX_RUNTIME_MINUTES=150 sitting in it. The
// watchdog went on cutting every fill short at the stale env value no matter
// what the dashboard said, which is exactly the symptom the change was meant
// to remove. A stale config file must not be able to silently overrule the
// operator; if it is set low, say so and honor the dashboard.
const ABSOLUTE_MAX_RUNTIME_MINUTES = 24 * 60;

let staleCeilingWarned = false;

function runtimeLimitMinutes() {
  const grace = CONFIG.runtimeGraceMinutes;

  if (!Number.isFinite(appMaxRuntimeMinutes)) {
    // Nothing heard from the app yet: the hard ceiling is the only bound there
    // is, so it applies in full.
    return Math.min(CONFIG.hardCeilingMinutes, CONFIG.fallbackRuntimeMinutes + grace);
  }

  const wanted = appMaxRuntimeMinutes + grace;

  if (CONFIG.hardCeilingMinutes < wanted && !staleCeilingWarned) {
    staleCeilingWarned = true;
    console.warn(`Watchdog: WATCHDOG_MAX_RUNTIME_MINUTES is set to ${CONFIG.hardCeilingMinutes}, ` +
      `below the ${formatDuration(appMaxRuntimeMinutes)} max runtime set on the dashboard ` +
      `(plus ${formatDuration(grace)} of grace = ${formatDuration(wanted)}). Ignoring it and ` +
      `honoring the dashboard - a stale value in /etc/default/water-monitor must not silently ` +
      `cut fills short. Remove or raise that line to clear this warning.`);
  }

  // Bounded by the app's own validated ceiling rather than by whatever the env
  // happens to say, so a corrupt status payload still cannot run forever.
  return Math.min(ABSOLUTE_MAX_RUNTIME_MINUTES + grace, wanted);
}

// The status payload is untrusted input: it arrives over HTTP and is the output
// of the very process this watchdog exists to second-guess. Anything outside
// the range the app itself accepts is ignored in favor of the last good value.
function adoptAppRuntimeLimit(status) {
  const reported = Number(status?.settings?.maxRuntimeMinutes);
  if (!Number.isFinite(reported) || reported < 1 || reported > 24 * 60) return;
  if (reported === appMaxRuntimeMinutes) return;

  const previous = appMaxRuntimeMinutes;
  appMaxRuntimeMinutes = reported;
  staleCeilingWarned = false;
  console.log(`Watchdog: adopting max runtime of ${formatDuration(reported)} from the app ` +
    `(was ${previous === null ? `the ${formatDuration(CONFIG.fallbackRuntimeMinutes)} startup fallback` : formatDuration(previous)}). ` +
    `Will force the relay off after ${formatDuration(runtimeLimitMinutes())} of continuous observed runtime.`);
}
let everReachedApp = false;
let lastForcedOffAt = 0;
let cutoffFailureNotified = false;

const FORCE_OFF_MIN_INTERVAL_MS = 30 * 1000;

const startupGraceUntil = Date.now() + Math.max(0, CONFIG.startupGraceSeconds) * 1000;

// The grace window only covers the gap between this process starting and the
// main app becoming reachable for the first time. Once we have heard from the
// app even once, a later silence is a real failure and is acted on
// immediately - a crash two hours into a run gets no grace at all.
//
// Nothing is at risk during the window: the relay is de-energized whenever it
// is unpowered or freshly opened, and the main app has not had the chance to
// energize anything yet either.
function inStartupGrace() {
  return !everReachedApp && Date.now() < startupGraceUntil;
}

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
        // Fall back to the configured polarity rather than Boolean(undefined).
        // Getting this wrong inverts the meaning of "off": on an active-high
        // board, a stored row missing this key would have had the watchdog
        // write a 1 to force the pump *off*, energizing it instead. The main
        // app always writes the key, but the one process whose job is to be
        // the last line of defense should not depend on that.
        gpioActiveHigh: stored.gpioActiveHigh === undefined
          ? CONFIG.gpioActiveHigh
          : Boolean(stored.gpioActiveHigh),
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

// Cached across trips on purpose. The previous version called unexport() after
// every GPIO write, which tears the pin's sysfs node down for *every* process
// using it - including the main app, whose still-open file descriptor then
// becomes invalid. A watchdog trip could therefore permanently break the main
// app's ability to drive the pin until it was restarted, turning a transient
// blip into a hard outage. Holding the export costs nothing and the pin stays
// driven low.
let cachedGpio = null;

function driveGpioOff(settings) {
  const { Gpio } = require("onoff");
  if (!cachedGpio || cachedGpio.pin !== settings.gpioPin) {
    cachedGpio = { pin: settings.gpioPin, gpio: new Gpio(settings.gpioPin, "out") };
  }
  cachedGpio.gpio.writeSync(settings.gpioActiveHigh ? 0 : 1);
}

function reportCutoffFailure(detail) {
  console.error(`Watchdog: ${detail}`);
  if (cutoffFailureNotified) return;
  cutoffFailureNotified = true;
  sendNtfyAlert(
    "Water pump CUTOFF FAILED - go check the tank",
    "The backup safety system tried to force the pump OFF and could not reach the relay hardware to do it.\n\n" +
    `Details: ${detail}\n\n` +
    "This means nothing in software is currently able to stop the pump.\n\n" +
    "WHAT TO DO NOW:\n" +
    "1. Go to the tank and the pump in person.\n" +
    "2. If the pump is running and the tank is filling toward overflow, cut power to the pump at the breaker or manual disconnect.\n" +
    "3. Call maintenance.\n\n" +
    "Do not wait for this to fix itself.",
    { tags: "rotating_light", priority: "urgent" }
  );
}

async function forceRelayOff(reason, options = {}) {
  // Once tripped, the callers below keep calling this on every 5s poll. Doing
  // the full sequence that often means re-opening the database and the serial
  // port twelve times a minute for as long as the fault lasts. The first
  // cutoff is always immediate; the repeats that only exist to hold the relay
  // down are throttled.
  const now = Date.now();
  if (!options.immediate && now - lastForcedOffAt < FORCE_OFF_MIN_INTERVAL_MS) return;
  lastForcedOffAt = now;

  forcePersistedModeToManualOff(reason);

  const settings = getOutputSettings();

  if (settings.type === "usb_relay") {
    const path = await resolveUsbRelayPath(settings);
    if (!path) {
      reportCutoffFailure("no USB relay found (by port or vendor/product ID), cannot force pump off.");
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
    // A port that errors after opening must not take the process down - this
    // is the watchdog, and an unhandled 'error' event would be fatal.
    port.on("error", (error) => reportCutoffFailure(`USB relay port error during cutoff: ${error.message}`));
    port.open((error) => {
      if (error) {
        reportCutoffFailure(`could not open USB relay port to force pump off: ${error.message}`);
        return;
      }
      port.write(USB_RELAY_OFF, (writeError) => {
        if (writeError) {
          reportCutoffFailure(`USB relay off write failed: ${writeError.message}`);
        } else {
          cutoffFailureNotified = false;
          console.warn(`Watchdog: forced USB relay OFF at ${path} (${reason}).`);
        }
        port.close(() => {});
      });
    });
    return;
  }

  try {
    driveGpioOff(settings);
    cutoffFailureNotified = false;
    console.warn(`Watchdog: forced GPIO pin ${settings.gpioPin} OFF (${reason}).`);
  } catch (error) {
    cachedGpio = null;
    reportCutoffFailure(`could not drive GPIO pin to force pump off: ${error.message}`);
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
  everReachedApp = true;
  adoptAppRuntimeLimit(status);

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

  const limitMinutes = runtimeLimitMinutes();
  const observedRuntimeMs = Date.now() - pumpOnObservedSince;
  if (observedRuntimeMs >= Math.max(0.01, limitMinutes) * 60 * 1000) {
    if (!maxRuntimeTripped) {
      console.error(`Watchdog: pump has been on for over ${limitMinutes} minutes by this ` +
        `watchdog's own clock, regardless of what the main app reports. Forcing pump relay off.`);
      sendNtfyAlert(
        "Water pump EMERGENCY cutoff - ran too long",
        `The backup safety system forced the pump OFF because it had been running for over ${formatDuration(limitMinutes)} straight - longer than the ${formatDuration(appMaxRuntimeMinutes ?? CONFIG.fallbackRuntimeMinutes)} limit set on the dashboard, which the monitor should have enforced on its own.\n\n` +
        "WHAT TO DO:\n" +
        "1. Go check the tank in person right away - is it full or overflowing?\n" +
        "2. If it is full, leave the pump off and check the float switch.\n" +
        "3. If it never filled, the pump may have lost its prime or a valve is closed - call maintenance.\n" +
        "4. The pump is locked to \"Manual Off.\" Only turn it back on from the dashboard after you have checked the tank.\n\n" +
        "Do not ignore this one.",
        { tags: "rotating_light", priority: "urgent" }
      );
    }
    const firstTrip = !maxRuntimeTripped;
    maxRuntimeTripped = true;
    forceRelayOff(
      `independent max runtime of ${limitMinutes} minutes exceeded`,
      { immediate: firstTrip }
    );
  }
}

function onUnreachable(detail) {
  if (inStartupGrace()) {
    console.log(`Watchdog: main app not up yet (${detail}). Within the ` +
      `${CONFIG.startupGraceSeconds}s startup grace window, so not treating this as a failure.`);
    return;
  }

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
    const firstTrip = !unhealthy;
    unhealthy = true;
    forceRelayOff("main app unreachable", { immediate: firstTrip });
  }
}

console.log(`Pump watchdog started. Polling ${CONFIG.statusUrl} every ${CONFIG.intervalSeconds}s. ` +
  `Forces pump off after ${CONFIG.failureThreshold} consecutive failed checks, or after the max runtime ` +
  `set on the dashboard plus ${formatDuration(CONFIG.runtimeGraceMinutes)} of grace, whichever comes ` +
  `first. Until the app first reports its setting, the limit is ` +
  `${formatDuration(Math.min(CONFIG.hardCeilingMinutes, CONFIG.fallbackRuntimeMinutes + CONFIG.runtimeGraceMinutes))} ` +
  `(WATCHDOG_MAX_RUNTIME_MINUTES=${CONFIG.hardCeilingMinutes} bounds that fallback only; it cannot cut ` +
  `the dashboard's setting short). ` +
  `Allowing ${CONFIG.startupGraceSeconds}s for the main app to come up before the first check counts.`);

checkStatus();
setInterval(checkStatus, Math.max(1, CONFIG.intervalSeconds) * 1000);
