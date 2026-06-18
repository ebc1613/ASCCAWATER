"use strict";

const MAX_FEET = 8.0;
const els = {
  feet: document.getElementById("feetValue"),
  percent: document.getElementById("percentValue"),
  psi: document.getElementById("psiValue"),
  battery: document.getElementById("batteryValue"),
  rssi: document.getElementById("rssiValue"),
  snr: document.getElementById("snrValue"),
  lastUpdate: document.getElementById("lastUpdate"),
  commStatus: document.getElementById("commStatus"),
  alarmStatus: document.getElementById("alarmStatus"),
  tankFill: document.getElementById("tankFill"),
  readingsBody: document.getElementById("readingsBody"),
  refreshButton: document.getElementById("refreshButton"),
  trendCanvas: document.getElementById("trendCanvas"),
  trend48Button: document.getElementById("trend48Button"),
  trend7DayButton: document.getElementById("trend7DayButton"),
  trendRangeLabel: document.getElementById("trendRangeLabel"),
  pumpStateText: document.getElementById("pumpStateText"),
  pumpReason: document.getElementById("pumpReason"),
  pumpStateBadge: document.getElementById("pumpStateBadge"),
  pumpAutoButton: document.getElementById("pumpAutoButton"),
  pumpManualOnButton: document.getElementById("pumpManualOnButton"),
  pumpManualOffButton: document.getElementById("pumpManualOffButton"),
  pumpSettingsForm: document.getElementById("pumpSettingsForm"),
  pumpOnFeet: document.getElementById("pumpOnFeet"),
  pumpOffFeet: document.getElementById("pumpOffFeet"),
  pumpStaleMinutes: document.getElementById("pumpStaleMinutes"),
  pumpMaxHours: document.getElementById("pumpMaxHours")
};

let latestReading = null;
let recentReadings = [];
let trendReadings = [];
let pumpStatus = null;
let trendHours = 48;

function formatNumber(value, digits = 1) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "--";
}

function formatTime(timestamp) {
  if (!timestamp) return "Waiting for Data";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(timestamp));
}

function formatTrendTime(timestamp, includeDate) {
  const options = includeDate
    ? { month: "short", day: "numeric", hour: "numeric" }
    : { hour: "numeric" };
  return new Intl.DateTimeFormat(undefined, options).format(new Date(timestamp));
}

function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return "";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

function setStatus(communication) {
  const level = communication?.level || "waiting";
  const text = communication?.label || "Waiting for Data";
  els.commStatus.className = `status-pill status-${level}`;
  els.commStatus.innerHTML = `<span class="status-dot"></span><span>${text}</span>`;
}

function setAlarm(alarm) {
  const level = alarm?.level || "waiting";
  els.alarmStatus.className = `alarm ${level}`;
  els.alarmStatus.textContent = alarm?.label || "Waiting";
}

function renderLatest(payload) {
  const reading = payload?.reading === null ? null : payload;
  latestReading = reading;

  if (!reading) {
    els.feet.textContent = "--";
    els.percent.textContent = "--% full";
    els.psi.textContent = "--";
    els.battery.textContent = "--";
    els.rssi.textContent = "--";
    els.snr.textContent = "--";
    els.lastUpdate.textContent = "Waiting for Data";
    els.tankFill.style.height = "0%";
    setStatus(payload?.communication);
    setAlarm(payload?.alarm);
    return;
  }

  els.feet.textContent = formatNumber(reading.feet, 1);
  els.percent.textContent = `${formatNumber(reading.percentFull, 1)}% full`;
  els.psi.textContent = formatNumber(reading.psi, 2);
  els.battery.textContent = formatNumber(reading.battery, 1);
  els.rssi.textContent = `${formatNumber(reading.rssi, 0)} dBm`;
  els.snr.textContent = `${formatNumber(reading.snr, 1)} dB`;
  els.lastUpdate.textContent = `${formatTime(reading.timestamp)} ${formatAge(reading.communication?.ageSeconds)}`;
  els.tankFill.style.height = `${Math.max(0, Math.min(100, reading.percentFull))}%`;
  setStatus(reading.communication);
  setAlarm(reading.alarm);
}

function renderPump(status) {
  if (!status) return;
  pumpStatus = status;
  const isOn = Boolean(status.pumpOn);
  const isFault = Boolean(status.fault);
  const modeLabel = {
    auto: "Auto",
    manual_off: "Manual Off",
    manual_on: "Manual On"
  }[status.mode] || "Manual Off";

  els.pumpStateText.textContent = `${isOn ? "Pump On" : "Pump Off"} - ${modeLabel}`;
  els.pumpReason.textContent = status.fault || status.reason || "";
  const isManualOn = status.mode === "manual_on";
  els.pumpStateBadge.textContent = isFault ? "Fault" : (isManualOn ? "Manual On" : (isOn ? "On" : "Off"));
  els.pumpStateBadge.className = `pump-state ${isFault || isManualOn ? "caution" : (isOn ? "on" : "off")}`;
  els.pumpStateText.className = isManualOn ? "pump-caution-text" : "";
  els.pumpAutoButton.classList.toggle("active", status.mode === "auto");
  els.pumpManualOnButton.classList.toggle("active", status.mode === "manual_on");
  els.pumpManualOffButton.classList.toggle("active", status.mode === "manual_off");

  const settings = status.settings || {};
  els.pumpOnFeet.value = formatNumber(settings.autoOnFeet, 1);
  els.pumpOffFeet.value = formatNumber(settings.autoOffFeet, 1);
  els.pumpStaleMinutes.value = Math.round(settings.staleShutdownMinutes || 60);
  els.pumpMaxHours.value = Math.round((settings.maxRuntimeMinutes || 720) / 60);
}

function renderTable() {
  if (!recentReadings.length) {
    els.readingsBody.innerHTML = `<tr><td colspan="6">Waiting for Data</td></tr>`;
    return;
  }

  els.readingsBody.innerHTML = recentReadings.slice(0, 60).map((reading) => `
    <tr>
      <td>${formatTime(reading.timestamp)}</td>
      <td>${formatNumber(reading.feet, 2)}</td>
      <td>${formatNumber(reading.psi, 2)}</td>
      <td>${formatNumber(reading.battery, 2)} V</td>
      <td>${formatNumber(reading.rssi, 0)}</td>
      <td>${formatNumber(reading.snr, 1)}</td>
    </tr>
  `).join("");
}

function drawTrend() {
  const canvas = els.trendCanvas;
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(320, Math.floor(rect.width * ratio));
  canvas.height = Math.floor(320 * ratio);
  ctx.scale(ratio, ratio);

  const width = canvas.width / ratio;
  const height = canvas.height / ratio;
  const pad = { top: 18, right: 18, bottom: 42, left: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#121b22";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#263642";
  ctx.lineWidth = 1;
  ctx.font = "13px system-ui";
  ctx.fillStyle = "#8da2af";

  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + plotH * (i / 4);
    const label = MAX_FEET - (MAX_FEET * i / 4);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(`${label.toFixed(0)} ft`, 4, y + 4);
  }

  if (trendReadings.length < 2) {
    ctx.fillStyle = "#d6e3ea";
    ctx.font = "18px system-ui";
    ctx.fillText("Waiting for trend data", pad.left, height / 2);
    return;
  }

  const points = trendReadings.map((reading) => ({
    t: new Date(reading.timestamp).getTime(),
    y: Math.max(0, Math.min(MAX_FEET, Number(reading.feet)))
  })).filter((point) => Number.isFinite(point.t) && Number.isFinite(point.y));

  if (points.length < 2) {
    ctx.fillStyle = "#d6e3ea";
    ctx.font = "18px system-ui";
    ctx.fillText("Waiting for trend data", pad.left, height / 2);
    return;
  }

  const maxT = Math.max(...points.map((point) => point.t));
  const minT = maxT - trendHours * 60 * 60 * 1000;
  const visiblePoints = points.filter((point) => point.t >= minT && point.t <= maxT);

  if (visiblePoints.length < 2) {
    ctx.fillStyle = "#d6e3ea";
    ctx.font = "18px system-ui";
    ctx.fillText("Waiting for trend data", pad.left, height / 2);
    return;
  }

  ctx.fillStyle = "#8da2af";
  ctx.font = "12px system-ui";
  ctx.fillText(formatTrendTime(minT, trendHours > 48), pad.left, height - 10);
  const endLabel = formatTrendTime(maxT, trendHours > 48);
  const endWidth = ctx.measureText(endLabel).width;
  ctx.fillText(endLabel, width - pad.right - endWidth, height - 10);

  ctx.beginPath();
  visiblePoints.forEach((point, index) => {
    const x = pad.left + ((point.t - minT) / (maxT - minT)) * plotW;
    const y = pad.top + (1 - point.y / MAX_FEET) * plotH;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#4ac1ff";
  ctx.lineWidth = 3;
  ctx.stroke();

  const fillGradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
  fillGradient.addColorStop(0, "rgba(74, 193, 255, 0.32)");
  fillGradient.addColorStop(1, "rgba(74, 193, 255, 0.02)");
  ctx.lineTo(pad.left + plotW, height - pad.bottom);
  ctx.lineTo(pad.left, height - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = fillGradient;
  ctx.fill();
}

async function loadTrend() {
  const trendRes = await fetch(`/api/trend?hours=${trendHours}`);
  const body = await trendRes.json();
  trendReadings = body.readings || [];
  els.trendRangeLabel.textContent = trendHours === 48 ? "48-hour view" : "7-day view";
  els.trend48Button.classList.toggle("active", trendHours === 48);
  els.trend7DayButton.classList.toggle("active", trendHours === 168);
  drawTrend();
}

async function loadData() {
  const [latestRes, readingsRes, pumpRes] = await Promise.all([
    fetch("/api/latest"),
    fetch("/api/readings?limit=100"),
    fetch("/api/pump/status")
  ]);

  renderLatest(await latestRes.json());
  recentReadings = (await readingsRes.json()).readings || [];
  renderPump(await pumpRes.json());
  renderTable();
  await loadTrend();
}

function connectEvents() {
  const events = new EventSource("/events");
  events.addEventListener("latest", (event) => renderLatest(JSON.parse(event.data)));
  events.addEventListener("pump", (event) => renderPump(JSON.parse(event.data)));
  events.addEventListener("reading", (event) => {
    const reading = JSON.parse(event.data);
    renderLatest(reading);
    recentReadings = [reading, ...recentReadings].slice(0, 100);
    const newestTime = new Date(reading.timestamp).getTime();
    const cutoff = newestTime - trendHours * 60 * 60 * 1000;
    trendReadings = [...trendReadings, reading].filter((item) => new Date(item.timestamp).getTime() >= cutoff);
    renderTable();
    drawTrend();
  });
  events.onerror = () => {
    setStatus({ level: "red", label: "Dashboard Link Lost" });
  };
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

async function setPumpMode(mode) {
  const label = {
    auto: "AUTO",
    manual_off: "MANUAL OFF",
    manual_on: "MANUAL ON"
  }[mode];

  if (!window.confirm(`Change pump mode to ${label}?`)) return;
  renderPump(await postJson("/api/pump/mode", { mode, confirm: true }));
}

els.refreshButton.addEventListener("click", loadData);
els.trend48Button.addEventListener("click", () => {
  trendHours = 48;
  loadTrend().catch((error) => window.alert(error.message));
});
els.trend7DayButton.addEventListener("click", () => {
  trendHours = 168;
  loadTrend().catch((error) => window.alert(error.message));
});
els.pumpAutoButton.addEventListener("click", () => setPumpMode("auto").catch((error) => window.alert(error.message)));
els.pumpManualOnButton.addEventListener("click", () => setPumpMode("manual_on").catch((error) => window.alert(error.message)));
els.pumpManualOffButton.addEventListener("click", () => setPumpMode("manual_off").catch((error) => window.alert(error.message)));
els.pumpSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const autoOnFeet = Number(els.pumpOnFeet.value);
  const autoOffFeet = Number(els.pumpOffFeet.value);
  const staleShutdownMinutes = Number(els.pumpStaleMinutes.value);
  const maxRuntimeMinutes = Number(els.pumpMaxHours.value) * 60;

  const message = `Save pump settings?\n\nOn below: ${autoOnFeet.toFixed(1)} ft\nOff at: ${autoOffFeet.toFixed(1)} ft\nNo signal stop: ${staleShutdownMinutes} minutes\nMax runtime: ${Math.round(maxRuntimeMinutes / 60)} hours`;
  if (!window.confirm(message)) return;

  try {
    renderPump(await postJson("/api/pump/settings", {
      autoOnFeet,
      autoOffFeet,
      staleShutdownMinutes,
      maxRuntimeMinutes,
      confirm: true
    }));
  } catch (error) {
    window.alert(error.message);
  }
});
window.addEventListener("resize", drawTrend);
setInterval(() => {
  if (!latestReading) return;
  latestReading.communication = {
    ...latestReading.communication,
    ageSeconds: Math.round((Date.now() - new Date(latestReading.timestamp).getTime()) / 1000)
  };
  renderLatest(latestReading);
}, 30000);

loadData().catch((error) => {
  console.error(error);
  setStatus({ level: "red", label: "API Unavailable" });
});
connectEvents();
