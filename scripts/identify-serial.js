"use strict";

// Answers "which USB device is the radio?" with evidence instead of inference.
//
// The app matches the LoRa receiver and the pump relay by USB vendor/product
// ID, which is a good default but is still a guess: it says "this device has
// the chip a receiver usually has," not "this device is the receiver." Clone
// boards ship different USB bridges, and a relay and a receiver that happen to
// share a CH340 are indistinguishable by ID alone. This tool settles it by
// making the device prove what it is.
//
// Three grades of evidence, best first:
//
//   1. CONFIRMED (live) - the running app parsed a real tank reading off this
//      port. Nothing else on this machine emits that. Costs nothing and
//      touches no hardware, so it is always tried first.
//
//   2. CONFIRMED (probe) - we opened the port, pulsed the ESP32's reset line,
//      and the board's ROM bootloader answered with its boot banner, or the
//      sketch printed a reading. Only an ESP32 does that; the relay is
//      electrically incapable of it.
//
//   3. SILENT - the port said nothing. Not proof of anything on its own, but
//      combined with (2) on another port it is how you tell them apart.
//
// Usage:
//   node scripts/identify-serial.js              # ask the app, then probe
//   node scripts/identify-serial.js --no-probe   # ask the app only, touch nothing
//   node scripts/identify-serial.js --include-relay
//   node scripts/identify-serial.js --seconds 8

const path = require("node:path");
const http = require("node:http");
const { SerialPort } = require("serialport");

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const flagValue = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const OPTIONS = {
  probe: !hasFlag("no-probe"),
  includeRelay: hasFlag("include-relay"),
  listenSeconds: Number.parseFloat(flagValue("seconds", "6")),
  baudRate: Number.parseInt(process.env.BAUD_RATE || "115200", 10),
  statusUrl: process.env.WATCHDOG_STATUS_URL
    || `http://127.0.0.1:${process.env.PORT || "80"}/api/pump/status`,
  healthUrl: `http://127.0.0.1:${process.env.PORT || "80"}/api/health`,
  portsUrl: `http://127.0.0.1:${process.env.PORT || "80"}/api/system/serial-ports`,
  dbPath: process.env.DB_PATH || path.join(__dirname, "..", "water-monitor.sqlite")
};

function getJson(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });
}

// The relay's configured identity, read straight from the database so this
// works whether or not the app is running.
function relayIdentity() {
  try {
    const Database = require("better-sqlite3");
    const db = new Database(OPTIONS.dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get("pumpOutput");
    db.close();
    if (!row) return null;
    const stored = JSON.parse(row.value);
    if (stored.type !== "usb_relay") return null;
    return {
      vendorId: (stored.usbRelayVendorId || "").toLowerCase(),
      productId: (stored.usbRelayProductId || "").toLowerCase(),
      port: stored.usbRelayPort || ""
    };
  } catch {
    return null;
  }
}

function looksLikeReading(text) {
  for (const line of text.split(/[\r\n]+/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Number.isFinite(Number(parsed.feet)) && Number.isFinite(Number(parsed.psi))) {
        return trimmed;
      }
    } catch { /* partial line, keep looking */ }
  }
  return null;
}

// The ESP32 ROM bootloader prints this at every reset, before any sketch runs,
// at 115200 regardless of what the sketch does. It is the single most reliable
// "there is an ESP32 on the other end of this cable" signal available.
function looksLikeEsp32Boot(text) {
  const match = text.match(/ESP-ROM:[^\r\n]*|rst:0x[0-9a-f]+[^\r\n]*|boot:0x[0-9a-f]+[^\r\n]*/i);
  return match ? match[0].trim() : null;
}

// Pulse the ESP32's reset line the way esptool does: RTS drives EN through the
// board's auto-reset transistors, so RTS high briefly holds the chip in reset
// and releasing it reboots the board into its ROM bootloader banner. On a relay
// board these lines go nowhere - CH340 modem-control pins are not wired to the
// relay coil, which is driven only by the 4-byte serial command this tool never
// sends. Nothing is written to any port here; this is read-only.
function pulseReset(port) {
  return new Promise((resolve) => {
    port.set({ dtr: false, rts: true }, () => {
      setTimeout(() => port.set({ dtr: false, rts: false }, () => resolve()), 120);
    });
  });
}

async function probePort(candidate) {
  return new Promise((resolve) => {
    let received = "";
    let settled = false;

    // lock:false so a port the main app is holding still yields evidence
    // instead of an "in use" error - we only ever read from it.
    const port = new SerialPort({
      path: candidate.path,
      baudRate: OPTIONS.baudRate,
      autoOpen: false,
      lock: false
    });

    const finish = (verdict, evidence) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (port.isOpen) port.close(() => {});
      } catch { /* closing a dead port is not interesting */ }
      resolve({ verdict, evidence, received: received.trim() });
    };

    const timer = setTimeout(() => {
      const reading = looksLikeReading(received);
      if (reading) return finish("radio", `printed a tank reading: ${reading}`);
      const boot = looksLikeEsp32Boot(received);
      if (boot) return finish("radio", `ESP32 boot banner: ${boot}`);
      if (received.trim()) return finish("unknown", `sent ${received.trim().length} bytes, but nothing recognizable`);
      finish("silent", "said nothing");
    }, Math.max(1, OPTIONS.listenSeconds) * 1000);

    port.on("error", (error) => finish("error", error.message));
    port.on("data", (chunk) => {
      received += chunk.toString("utf8");
      const reading = looksLikeReading(received);
      if (reading) finish("radio", `printed a tank reading: ${reading}`);
    });

    port.open(async (error) => {
      if (error) return finish("error", error.message);
      await pulseReset(port);
    });
  });
}

async function main() {
  console.log("Identifying USB devices on this machine.\n");

  const relay = relayIdentity();
  const ports = await SerialPort.list();

  if (ports.length === 0) {
    console.log("No serial ports found at all. Nothing is plugged in, or the");
    console.log("service account is not in the 'dialout' group.");
    return;
  }

  console.log("Detected serial devices:");
  for (const port of ports) {
    const id = port.vendorId && port.productId ? `${port.vendorId}:${port.productId}` : "no USB ID";
    const serial = port.serialNumber ? ` serial=${port.serialNumber}` : "";
    console.log(`  ${port.path}  ${id}${serial}  ${port.manufacturer || ""}`);
  }

  // Grade 1: the running app has already proven it, for free.
  const health = await getJson(OPTIONS.healthUrl);
  const live = health?.serial;
  let provenPath = null;

  console.log("");
  if (!health) {
    console.log("The app is not answering on this machine, so there is no live");
    console.log("evidence to use. Falling back to probing the hardware directly.");
  } else if (live?.mode === "simulation") {
    console.log("The app is running with SIMULATE=true - its readings are invented,");
    console.log("not received, so it can tell you nothing about the real hardware.");
    console.log("The probe below is the only evidence available in this mode.");
  } else if (live?.connected && live.lastLineAt) {
    const ageMinutes = Math.round((Date.now() - new Date(live.lastLineAt).getTime()) / 60000);
    provenPath = live.port;
    console.log(`CONFIRMED: ${live.port} is the radio board.`);
    console.log(`  The running app parsed a real tank reading from it ${ageMinutes} minute(s) ago.`);
    console.log(`  Nothing else on this machine produces that. This is proof, not a guess.`);
  } else if (live?.connected) {
    console.log(`${live.port} is open as the radio, but no reading has come through yet.`);
    console.log(`  Readings arrive about every 5 minutes. Either wait for one, or probe below.`);
  } else {
    console.log(`The app has no radio port open right now (${live?.lastError || "reason unknown"}).`);
  }

  if (!OPTIONS.probe) {
    console.log("\n--no-probe given; stopping without touching the hardware.");
    return;
  }

  // Probing pulses reset lines. Harmless on a relay board, but this controls a
  // pump, so it does not happen silently while the pump is energized.
  const pump = await getJson(OPTIONS.statusUrl);
  if (pump?.pumpOn) {
    console.log("\nSkipping the hardware probe: the pump is currently RUNNING.");
    console.log("Turn the pump off from the dashboard first, then run this again.");
    return;
  }

  const candidates = ports.filter((port) => {
    if (OPTIONS.includeRelay || !relay) return true;
    const isRelay = (relay.vendorId && relay.productId &&
      (port.vendorId || "").toLowerCase() === relay.vendorId &&
      (port.productId || "").toLowerCase() === relay.productId) ||
      (!relay.vendorId && relay.port && port.path === relay.port);
    if (isRelay) {
      console.log(`\n  (skipping ${port.path} - it is the configured pump relay. Use --include-relay to probe it anyway.)`);
    }
    return !isRelay;
  });

  console.log(`\nProbing ${candidates.length} device(s), listening ${OPTIONS.listenSeconds}s each.`);
  console.log("Reading only - no bytes are written to any port.\n");

  const results = [];
  for (const candidate of candidates) {
    process.stdout.write(`  ${candidate.path} ... `);
    const result = await probePort(candidate);
    console.log(result.evidence);
    results.push({ candidate, result });
  }

  const radios = results.filter((entry) => entry.result.verdict === "radio");

  console.log("");
  if (radios.length === 1) {
    console.log(`CONFIRMED: ${radios[0].candidate.path} is the radio board.`);
    console.log(`  Evidence: ${radios[0].result.evidence}`);
    if (provenPath && provenPath !== radios[0].candidate.path) {
      console.log(`\n  WARNING: the app is reading ${provenPath} instead. Restart the`);
      console.log(`  service so it re-resolves: sudo systemctl restart water-monitor`);
    }
  } else if (radios.length > 1) {
    console.log(`Found ${radios.length} devices that answer like an ESP32:`);
    for (const entry of radios) console.log(`  ${entry.candidate.path} - ${entry.result.evidence}`);
    console.log("\nOnly one of these is the tank receiver. The one that prints a tank");
    console.log("reading (not just a boot banner) is the real one - re-run with");
    console.log("--seconds 320 to wait out a full 5-minute transmit cycle.");
  } else {
    console.log("No device identified itself as the radio board.");
    console.log("  Check that the receiver is plugged in and powered, and that its USB");
    console.log("  cable is a data cable rather than charge-only. If a probed port");
    console.log("  errored with a permissions message, add the account to 'dialout'.");
  }
}

main().catch((error) => {
  console.error(`identify-serial failed: ${error.message}`);
  process.exit(1);
});
