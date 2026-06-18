"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

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
    return { suggestedType: "gpio", reason: `Detected ${model}. GPIO recommended.` };
  }

  if (process.arch === "x64" || process.arch === "ia32") {
    return {
      suggestedType: "usb_relay",
      reason: `Linux on ${process.arch} (no GPIO header, not a Raspberry Pi). USB relay recommended.`
    };
  }

  if (process.arch.startsWith("arm")) {
    return { suggestedType: "gpio", reason: `ARM Linux (${process.arch}). GPIO likely available.` };
  }

  return {
    suggestedType: null,
    reason: `Could not confidently detect hardware (${process.platform}/${process.arch}).`
  };
}

const PUMP_OUTPUT_RECOMMENDATION = detectPumpOutputRecommendation();

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_FEET = 8.0;

const clients = new Set();
const readings = [];
let seq = 1;
let feet = 5.6;
let direction = -1;
let simulatedNow = Date.now();
let pumpSettings = {
  mode: "manual_off",
  autoOnFeet: 2.0,
  autoOffFeet: 7.2,
  staleShutdownMinutes: 60,
  maxRuntimeMinutes: 12 * 60
};
let ntfySettings = {
  enabled: false,
  serverUrl: "",
  topic: "",
  token: ""
};
let pumpOutputSettings = {
  type: PUMP_OUTPUT_RECOMMENDATION.suggestedType || "gpio",
  gpioPin: 17,
  gpioActiveHigh: true,
  usbRelayPort: "",
  usbRelayBaud: 9600
};
let pumpState = {
  enabled: false,
  pumpOn: false,
  mode: "manual_off",
  reason: "Demo mode. Pump output disabled.",
  startedAt: null,
  lastChangedAt: new Date().toISOString(),
  fault: null,
  output: { type: "gpio", available: false }
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, places = 2) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function downsampleRows(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const stride = Math.ceil(rows.length / maxPoints);
  return rows.filter((row, index) => index % stride === 0 || index === rows.length - 1);
}

function communication(timestamp) {
  if (!timestamp) return { level: "waiting", label: "Waiting for Data", ageSeconds: null };
  const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (ageSeconds <= 300) return { level: "green", label: "Online", ageSeconds };
  if (ageSeconds <= 600) return { level: "yellow", label: "Delayed", ageSeconds };
  return { level: "red", label: "No Recent Updates", ageSeconds };
}

function alarm(readingFeet) {
  if (!Number.isFinite(readingFeet)) return { level: "waiting", label: "Waiting for Data" };
  if (readingFeet < 1.0) return { level: "critical", label: "Critical Low" };
  if (readingFeet < 2.0) return { level: "warning", label: "Low Warning" };
  if (readingFeet > 7.5) return { level: "full", label: "Near Full" };
  return { level: "normal", label: "Normal" };
}

function enrich(row) {
  if (!row) {
    return {
      reading: null,
      percentFull: 0,
      communication: communication(null),
      alarm: alarm(null),
      maxFeet: MAX_FEET
    };
  }

  return {
    ...row,
    percentFull: round(clamp((row.feet / MAX_FEET) * 100, 0, 100), 1),
    communication: communication(row.timestamp),
    alarm: alarm(row.feet),
    maxFeet: MAX_FEET
  };
}

function sendJson(res, payload) {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sanitizePumpSettings(input) {
  const next = {
    mode: ["auto", "manual_off", "manual_on"].includes(input.mode) ? input.mode : pumpSettings.mode,
    autoOnFeet: round(clamp(Number(input.autoOnFeet), 0.1, MAX_FEET - 0.5), 2),
    autoOffFeet: round(clamp(Number(input.autoOffFeet), 0.5, MAX_FEET), 2),
    staleShutdownMinutes: Math.round(clamp(Number(input.staleShutdownMinutes), 5, 240)),
    maxRuntimeMinutes: Math.round(clamp(Number(input.maxRuntimeMinutes), 10, 24 * 60))
  };

  if (!Number.isFinite(next.autoOnFeet)) next.autoOnFeet = pumpSettings.autoOnFeet;
  if (!Number.isFinite(next.autoOffFeet)) next.autoOffFeet = pumpSettings.autoOffFeet;
  if (!Number.isFinite(next.staleShutdownMinutes)) next.staleShutdownMinutes = pumpSettings.staleShutdownMinutes;
  if (!Number.isFinite(next.maxRuntimeMinutes)) next.maxRuntimeMinutes = pumpSettings.maxRuntimeMinutes;
  if (next.autoOffFeet <= next.autoOnFeet + 0.5) next.autoOffFeet = round(next.autoOnFeet + 0.5, 2);
  return next;
}

function publicNtfySettings(settings) {
  return {
    enabled: Boolean(settings.enabled),
    serverUrl: settings.serverUrl,
    topic: settings.topic,
    hasToken: Boolean(settings.token)
  };
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

function setPumpOn(nextPumpOn, reason) {
  const changed = pumpState.pumpOn !== nextPumpOn;
  pumpState.pumpOn = nextPumpOn;
  pumpState.reason = reason;
  pumpState.lastChangedAt = new Date().toISOString();
  if (nextPumpOn && changed) pumpState.startedAt = pumpState.lastChangedAt;
  if (!nextPumpOn) pumpState.startedAt = null;
  broadcast("pump", getPumpStatus());
}

function evaluatePump() {
  const latest = readings[0];
  pumpState.mode = pumpSettings.mode;

  if (!latest) {
    setPumpOn(false, "Waiting for water level data.");
    return;
  }

  const ageMs = Date.now() - new Date(latest.timestamp).getTime();
  if (ageMs > pumpSettings.staleShutdownMinutes * 60 * 1000) {
    setPumpOn(false, `Stopped because no LoRa reading arrived for ${pumpSettings.staleShutdownMinutes} minutes.`);
    return;
  }

  if (pumpState.pumpOn && pumpState.startedAt) {
    const runtimeMs = Date.now() - new Date(pumpState.startedAt).getTime();
    if (runtimeMs > pumpSettings.maxRuntimeMinutes * 60 * 1000) {
      setPumpOn(false, `Stopped after max runtime of ${Math.round(pumpSettings.maxRuntimeMinutes / 60)} hours.`);
      return;
    }
  }

  if (pumpSettings.mode === "manual_off") {
    setPumpOn(false, "Manual off.");
    return;
  }
  if (pumpSettings.mode === "manual_on") {
    setPumpOn(true, "Manual on.");
    return;
  }
  if (!pumpState.pumpOn && latest.feet <= pumpSettings.autoOnFeet) {
    setPumpOn(true, `Auto on at ${latest.feet.toFixed(2)} ft.`);
    return;
  }
  if (pumpState.pumpOn && latest.feet >= pumpSettings.autoOffFeet) {
    setPumpOn(false, `Auto off at ${latest.feet.toFixed(2)} ft.`);
    return;
  }
  pumpState.reason = pumpState.pumpOn ? "Auto running until off level." : "Auto waiting for on level.";
}

function getPumpStatus() {
  const runtimeSeconds = pumpState.pumpOn && pumpState.startedAt
    ? Math.max(0, Math.round((Date.now() - new Date(pumpState.startedAt).getTime()) / 1000))
    : 0;
  return {
    ...pumpState,
    mode: pumpSettings.mode,
    runtimeSeconds,
    settings: pumpSettings,
    latest: enrich(readings[0])
  };
}

function broadcast(type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

function createReading(timestamp) {
  feet += direction * (0.08 + Math.random() * 0.16);
  if (feet < 1.2) direction = 1;
  if (feet > 7.7) direction = -1;

  const noisyFeet = clamp(feet + (Math.random() - 0.5) * 0.18, 0.2, MAX_FEET);
  const reading = {
    id: seq,
    tower: "camp-main",
    feet: round(noisyFeet, 2),
    psi: round(noisyFeet * 0.433, 2),
    battery: round(12.6 + Math.random() * 0.8, 2),
    rssi: round(-115 + Math.random() * 24, 1),
    snr: round(-6 + Math.random() * 10, 1),
    seq,
    timestamp: new Date(timestamp).toISOString()
  };
  seq += 1;
  return reading;
}

function addReading({ broadcastUpdate = true } = {}) {
  const reading = createReading(simulatedNow);
  simulatedNow += 60 * 60 * 1000;
  readings.unshift(reading);
  readings.length = Math.min(readings.length, 1000);
  if (broadcastUpdate) broadcast("reading", enrich(reading));
  evaluatePump();
}

function seedDemoHistory() {
  simulatedNow = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const halfHourMs = 30 * 60 * 1000;
  const count = Math.floor((7 * 24 * 60 * 60 * 1000) / halfHourMs);

  for (let index = 0; index <= count; index += 1) {
    const reading = createReading(simulatedNow);
    simulatedNow += halfHourMs;
    readings.unshift(reading);
  }

  simulatedNow = Date.now() + 60 * 60 * 1000;
}

function serveStatic(req, res) {
  const requested = req.url === "/" ? "/index.html" : decodeURIComponent(req.url);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8"
    }[ext] || "application/octet-stream";

    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive"
    });
    clients.add(res);
    res.write(`event: latest\ndata: ${JSON.stringify(enrich(readings[0]))}\n\n`);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/api/latest") {
    sendJson(res, enrich(readings[0]));
    return;
  }

  if (url.pathname === "/api/readings") {
    const limit = clamp(Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1, 1000);
    sendJson(res, { limit, readings: readings.slice(0, limit).map(enrich) });
    return;
  }

  if (url.pathname === "/api/system/serial-ports") {
    try {
      const { SerialPort } = require("serialport");
      const ports = await SerialPort.list();
      sendJson(res, {
        ports: ports.map((port) => ({
          path: port.path,
          manufacturer: port.manufacturer || null,
          serialNumber: port.serialNumber || null,
          vendorId: port.vendorId || null,
          productId: port.productId || null
        }))
      });
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (url.pathname === "/api/trend") {
    const requestedHours = Number.parseInt(url.searchParams.get("hours") || "48", 10);
    const hours = requestedHours === 168 ? 168 : 48;
    const newestTime = readings[0] ? new Date(readings[0].timestamp).getTime() : Date.now();
    const cutoff = newestTime - hours * 60 * 60 * 1000;
    const rows = readings
      .filter((reading) => new Date(reading.timestamp).getTime() >= cutoff)
      .slice()
      .reverse();
    sendJson(res, { hours, maxPoints: 300, totalReadings: rows.length, readings: downsampleRows(rows, 300).map(enrich) });
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, {
      ok: true,
      mode: "dependency-free-demo",
      latest: enrich(readings[0]),
      uptimeSeconds: Math.round(process.uptime())
    });
    return;
  }

  if (url.pathname === "/api/pump/status") {
    evaluatePump();
    sendJson(res, getPumpStatus());
    return;
  }

  if (url.pathname === "/api/config/ntfy") {
    if (req.method === "GET") {
      sendJson(res, publicNtfySettings(ntfySettings));
      return;
    }

    if (req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        if (body.confirm !== true) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Configuration changes require confirm=true." }));
          return;
        }
        ntfySettings = sanitizeNtfySettings(body, { existingToken: ntfySettings.token });
        sendJson(res, publicNtfySettings(ntfySettings));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
  }

  if (url.pathname === "/api/config/pump-output") {
    if (req.method === "GET") {
      sendJson(res, { ...pumpOutputSettings, recommendation: PUMP_OUTPUT_RECOMMENDATION });
      return;
    }

    if (req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        if (body.confirm !== true) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Pump output changes require confirm=true." }));
          return;
        }
        pumpOutputSettings = {
          type: body.type === "usb_relay" ? "usb_relay" : "gpio",
          gpioPin: Number(body.gpioPin) || 17,
          gpioActiveHigh: Boolean(body.gpioActiveHigh),
          usbRelayPort: String(body.usbRelayPort || ""),
          usbRelayBaud: Number(body.usbRelayBaud) || 9600
        };
        sendJson(res, { ...pumpOutputSettings, recommendation: PUMP_OUTPUT_RECOMMENDATION, restartRequired: true, demo: true });
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
  }

  if (url.pathname === "/api/config/ntfy/test" && req.method === "POST") {
    try {
      const body = await readRequestJson(req);
      if (body.confirm !== true) throw new Error("Test notification requires confirm=true.");
      if (!ntfySettings.enabled) throw new Error("ntfy notifications are disabled.");
      sendJson(res, { ok: true, demo: true });
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (url.pathname === "/api/pump/mode" && req.method === "POST") {
    const body = await readRequestJson(req);
    if (body.confirm !== true || !["auto", "manual_off", "manual_on"].includes(body.mode)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Pump mode changes require confirm=true and a valid mode." }));
      return;
    }
    pumpSettings = { ...pumpSettings, mode: body.mode };
    evaluatePump();
    sendJson(res, getPumpStatus());
    return;
  }

  if (url.pathname === "/api/pump/settings" && req.method === "POST") {
    const body = await readRequestJson(req);
    if (body.confirm !== true) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Settings changes require confirm=true." }));
      return;
    }
    pumpSettings = sanitizePumpSettings({ ...pumpSettings, ...body });
    evaluatePump();
    sendJson(res, getPumpStatus());
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Demo water monitor listening on http://${HOST}:${PORT}`);
  seedDemoHistory();
  addReading();
  setInterval(addReading, 10000);
});
