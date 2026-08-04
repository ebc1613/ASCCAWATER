"use strict";

// The tank's full height, in feet above the sensor tap. Seeded with the server
// default and corrected from the first reading that arrives, so the trend axis
// and tank graphic follow TANK_MAX_FEET rather than a number baked in here.
let MAX_FEET = 7.2;
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
  tankMarkFull: document.getElementById("tankMarkFull"),
  tankMarkLow: document.getElementById("tankMarkLow"),
  tankMarkCritical: document.getElementById("tankMarkCritical"),
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
  pumpMaxHours: document.getElementById("pumpMaxHours"),
  trendMaxLabel: document.getElementById("trendMaxLabel"),
  runsBody: document.getElementById("runsBody"),
  runsCount: document.getElementById("runsCount"),
  runsTotal: document.getElementById("runsTotal"),
  runsLongest: document.getElementById("runsLongest"),
  pumpBlocked: document.getElementById("pumpBlocked"),
  pumpBlockedHeadline: document.getElementById("pumpBlockedHeadline"),
  pumpBlockedDetail: document.getElementById("pumpBlockedDetail"),
  usageSource: document.getElementById("usageSource"),
  usage730: document.getElementById("usage730"),
  usage365: document.getElementById("usage365"),
  usage30: document.getElementById("usage30"),
  usage7: document.getElementById("usage7"),
  usageMonths: document.getElementById("usageMonths"),
  usageNote: document.getElementById("usageNote")
};

let latestReading = null;
let recentReadings = [];
let trendReadings = [];
let pumpStatus = null;
let trendHours = 48;
let runDays = 7;

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
  renderTankMarks(reading);
  setStatus(reading.communication);
  setAlarm(reading.alarm);
}

// The tank's height markings used to be hardcoded in the markup and stylesheet
// as "8 ft" with the low and critical lines pinned at 25% and 12.5% - one
// eighth each. That was only ever right for an 8-foot tank with default alert
// levels, and it silently misreported both the full height and the thresholds
// once either changed. Drive them from the same numbers the alarms use.
function renderTankMarks(reading) {
  const maxFeet = Number(reading.maxFeet);
  if (!Number.isFinite(maxFeet) || maxFeet <= 0) return;

  applyTankHeight(maxFeet);
  els.tankMarkFull.textContent = `${formatNumber(maxFeet, 1)} ft`;

  const place = (el, feet) => {
    const value = Number(feet);
    // A threshold at or above the top of the tank has nowhere to sit, and one
    // at zero is not a level anyone is watching for.
    if (!Number.isFinite(value) || value <= 0 || value >= maxFeet) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent = `${formatNumber(value, 1)} ft`;
    el.style.bottom = `${(value / maxFeet) * 100}%`;
  };

  place(els.tankMarkLow, reading.lowWarningFeet);
  place(els.tankMarkCritical, reading.criticalFeet);
}

// Adopt the server's tank height everywhere it is baked into the page: the
// trend chart's y-axis, its printed maximum, and the ceiling on the auto-level
// inputs. Redraws the trend, since its scale changed under it.
function applyTankHeight(maxFeet) {
  if (maxFeet === MAX_FEET) return;
  MAX_FEET = maxFeet;

  els.trendMaxLabel.textContent = `${formatNumber(maxFeet, 1)} ft max`;
  els.pumpOnFeet.max = String(maxFeet);
  els.pumpOffFeet.max = String(maxFeet);
  if (trendReadings.length) drawTrend();
}

// Several safety checks run before the selected mode is even consulted, and
// each one holds the pump off and returns. When that happens the mode button
// still lights up as selected, which reads as "it worked" while nothing
// physically moves. Say so plainly instead.
function describePumpBlock(status) {
  if (status.enabled === false) {
    return {
      headline: "Pump control is switched off for this installation.",
      detail: "The relay is connected and your mode choice is saved, but nothing will be energized - "
        + "the pump cannot run in any mode until pump control is turned on. This is the deliberate "
        + "safety gate for wiring that is not finished yet. To turn it on, set PUMP_CONTROL_ENABLED=true "
        + "in /etc/default/water-monitor and restart the service, and only after the relay, contactor, "
        + "disconnect, and breaker are all in place."
    };
  }

  if (status.pumpOn) return null;

  // Mode asks for the pump to run, but something upstream is refusing.
  const wantsOn = status.mode === "manual_on";
  if (!wantsOn) return null;

  return {
    headline: "Manual On is selected, but the pump is being held off.",
    detail: status.fault || status.reason || "Reason unavailable."
  };
}

function renderPumpBlock(status) {
  const block = describePumpBlock(status);
  if (!block) {
    els.pumpBlocked.hidden = true;
    return;
  }
  els.pumpBlockedHeadline.textContent = block.headline;
  els.pumpBlockedDetail.textContent = block.detail;
  els.pumpBlocked.hidden = false;
}

function renderPump(status) {
  if (!status) return;
  // A run only appears in (or leaves) the log when the pump actually switches,
  // so refresh on the transition rather than on every status push.
  const wasOn = pumpStatus ? Boolean(pumpStatus.pumpOn) : null;
  pumpStatus = status;
  renderPumpBlock(status);
  const isOn = Boolean(status.pumpOn);
  if (wasOn !== null && wasOn !== isOn) loadRuns();
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

function formatGallons(value) {
  if (!Number.isFinite(Number(value))) return "--";
  const gallons = Number(value);
  if (gallons >= 1000000) return `${(gallons / 1000000).toFixed(2)}M gal`;
  if (gallons >= 10000) return `${Math.round(gallons / 1000).toLocaleString()}k gal`;
  return `${Math.round(gallons).toLocaleString()} gal`;
}

function renderUsage(usage) {
  if (!usage) return;

  if (!usage.configured) {
    els.usageSource.textContent = "Not configured";
    els.usageSource.className = "config-status error";
    els.usageNote.textContent = "Set the tank diameter in Settings to start estimating water usage.";
    return;
  }

  els.usage730.textContent = formatGallons(usage.last730Days);
  els.usage365.textContent = formatGallons(usage.last365Days);
  els.usage30.textContent = formatGallons(usage.last30Days);
  els.usage7.textContent = formatGallons(usage.last7Days);

  const gpm = Math.round(Number(usage.pumpRateGpm) || 0);
  const pumpLabel = {
    estimated: `pump about ${gpm} gal/min, measured automatically`,
    manual: `pump ${gpm} gal/min`,
    "manual-fallback": `pump ${gpm} gal/min`,
    unset: "pump rate unknown"
  }[usage.pumpRateSource] || "pump rate unknown";

  els.usageSource.textContent = `${usage.daysRecorded} days recorded`;
  els.usageSource.className = "config-status ok";

  const coverageNote = usage.coveragePercent < 90
    ? ` Sensor data covers only ${usage.coveragePercent}% of that span, so the real total is likely higher.`
    : "";
  const pumpNote = usage.pumpRateSource === "unset"
    ? " Water used while the pump was filling is not counted yet, so this reads low - set a pump rate in Settings."
    : "";

  els.usageNote.textContent =
    `Rough estimate from tank level change plus pump run time (${Math.round(usage.gallonsPerFoot).toLocaleString()} gal per foot, ${pumpLabel}). ` +
    `Not a metered figure.${pumpNote}${coverageNote}`;

  renderUsageMonths(usage.monthly || []);
}

function renderUsageMonths(monthly) {
  if (!monthly.length) {
    els.usageMonths.innerHTML = "";
    return;
  }

  const recent = monthly.slice(-24);
  const peak = Math.max(...recent.map((entry) => entry.gallons), 1);

  els.usageMonths.innerHTML = recent.map((entry) => {
    const height = Math.max(2, Math.round((entry.gallons / peak) * 100));
    const [year, month] = entry.month.split("-");
    const label = new Intl.DateTimeFormat(undefined, { month: "short" })
      .format(new Date(Number(year), Number(month) - 1, 1));
    return `
      <div class="usage-month" title="${entry.month}: ${Math.round(entry.gallons).toLocaleString()} gal">
        <div class="usage-bar-track"><div class="usage-bar" style="height:${height}%"></div></div>
        <span>${label}</span>
      </div>
    `;
  }).join("");
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

async function loadUsage() {
  try {
    renderUsage(await (await fetch("/api/usage")).json());
  } catch (error) {
    // Usage is a summary figure, not a safety-critical reading. A failure
    // here must not take down the rest of the dashboard load.
    console.error("Could not load usage summary", error);
  }
}

// "2h 15m" / "45m" / "38s". Whole hours and minutes are what someone comparing
// a fill against the pump's max run hours actually needs; seconds only matter
// for the very short runs where minutes would round to a meaningless "0m".
function formatRunDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (!hours) return `${minutes}m`;
  // 90 min rounds to "1h 30m", but 119.7 min must not become "1h 60m".
  if (minutes === 60) return `${hours + 1}h 00m`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

// Includes minutes, unlike the trend axis: "started at 3 PM" is not enough to
// line a run up against anything.
function formatRunStart(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  }).format(new Date(timestamp));
}

const RUN_MODE_LABELS = {
  auto: "Auto",
  manual_on: "Manual On",
  manual_off: "Manual Off"
};

function renderRuns(payload) {
  els.runsCount.textContent = payload.totalRuns;
  els.runsTotal.textContent = formatRunDuration(payload.totalSeconds);
  els.runsLongest.textContent = formatRunDuration(payload.longestSeconds);

  if (!payload.runs.length) {
    els.runsBody.innerHTML = `<tr><td colspan="4">The pump did not run in the last ${payload.days} days.</td></tr>`;
    return;
  }

  els.runsBody.innerHTML = payload.runs.map((run) => {
    const started = formatRunStart(run.startedAt);
    const duration = run.inProgress
      ? `${formatRunDuration(run.seconds)} <span class="run-flag running">so far</span>`
      : formatRunDuration(run.seconds);
    const why = run.inProgress
      ? "Still running."
      : escapeHtml(run.endReason || "Unknown.");
    const flag = run.endedUnexpectedly ? ' <span class="run-flag unrecorded">not recorded</span>' : "";
    return `<tr>
      <td>${escapeHtml(started)}</td>
      <td>${duration}</td>
      <td>${escapeHtml(RUN_MODE_LABELS[run.mode] || run.mode || "--")}</td>
      <td>${why}${flag}</td>
    </tr>`;
  }).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

async function loadRuns() {
  try {
    const response = await fetch(`/api/pump/runs?days=${runDays}&limit=50`);
    renderRuns(await response.json());
  } catch (error) {
    console.error("Could not load pump runs", error);
  }
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
  await loadUsage();
  await loadRuns();
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
document.querySelectorAll(".runs-panel .trend-range").forEach((button) => {
  button.addEventListener("click", () => {
    runDays = Number(button.dataset.days);
    document.querySelectorAll(".runs-panel .trend-range")
      .forEach((other) => other.classList.toggle("active", other === button));
    loadRuns();
  });
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
// The rollup only recomputes hourly on the server, so polling faster than
// this would just re-fetch an identical answer.
setInterval(loadUsage, 15 * 60 * 1000);
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
