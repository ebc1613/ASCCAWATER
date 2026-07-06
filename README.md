# Campsite Water Tower Monitor

Local LAN dashboard for a Raspberry Pi at the well house. The app reads newline-delimited JSON from an ESP32 LoRa receiver over USB serial, stores readings in SQLite, and serves a dark, touch-friendly dashboard.

This is monitor-only software. It does not control pumps, valves, chlorinators, or any other equipment.

## Features

- Reads `/dev/ttyUSB0` by default.
- Override serial device with `SERIAL_PORT=/dev/ttyACM0`.
- Stores water level, PSI, battery, RSSI, SNR, sequence, tower, and timestamp in SQLite.
- Live dashboard updates with Server-Sent Events.
- Starts normally when the serial device is missing and shows `Waiting for Data`.
- Simulation mode for setup and demos.
- API endpoints for latest reading, recent readings, health, and 48-hour or 7-day trend data.

## Serial Format

The ESP32 should send one JSON object per line:

```json
{"tower":"camp-main","feet":6.8,"psi":2.94,"battery":13.1,"rssi":-108,"snr":-3.5,"seq":1523}
```

Required numeric fields are `feet`, `psi`, `battery`, `rssi`, and `snr`. `tower` defaults to `camp-main`; `seq` is optional.

## Install

On the Raspberry Pi:

```bash
sudo apt update
sudo apt install -y nodejs npm build-essential
cd /opt/water-monitor
npm install --omit=dev
```

Node.js 20 or newer is recommended.

## Run

Development or testing on a non-privileged port:

```bash
SIMULATE=true PORT=8080 npm start
```

Production default:

```bash
npm start
```

The production app listens on `0.0.0.0:80`.

Environment variables:

- `SERIAL_PORT`: serial device path, default `/dev/ttyUSB0`
- `BAUD_RATE`: serial baud rate, default `115200`
- `PORT`: HTTP port, default `80`
- `HOST`: HTTP bind address, default `0.0.0.0`
- `SIMULATE`: set to `true` to generate realistic readings every 10 seconds
- `DB_PATH`: SQLite database path, default `water-monitor.sqlite` in the app directory
- `RETENTION_DAYS`: automatic database retention, default `90`
- `PRUNE_INTERVAL_HOURS`: how often old rows are pruned, default `12`
- `TREND_MAX_POINTS`: maximum points returned for the trend graph, default `300`
- `PUMP_CONTROL_ENABLED`: set to `true` only after relay wiring is ready, default `false`
- `PUMP_OUTPUT`: `gpio` or `usb_relay`, default `gpio`. Overridden by the saved setting from `/config.html` once one exists.
- `PUMP_GPIO_PIN`: BCM GPIO pin for pump relay output (used when `PUMP_OUTPUT=gpio`), default `17`
- `PUMP_GPIO_ACTIVE_HIGH`: set to `false` for active-low relay modules, default `true`
- `PUMP_USB_RELAY_PORT`: serial device path for a USB relay board (used when `PUMP_OUTPUT=usb_relay`), for example `/dev/ttyUSB1`
- `PUMP_USB_RELAY_BAUD`: USB relay serial baud rate, default `9600`
- `PUMP_USB_RELAY_VENDOR_ID` / `PUMP_USB_RELAY_PRODUCT_ID`: optional hex USB vendor/product ID (for example `1a86`/`7523` for a common CH340-based relay). When both are set, the app finds the relay by hardware identity at every (re)connect instead of trusting `PUMP_USB_RELAY_PORT` as a fixed path - see "USB Relay Path Stability" below. The `/config.html` "Lock to this USB device" checkbox sets this from the dashboard and takes precedence over these env vars once saved.
- `NTFY_ENABLED`: enable ntfy notifications, default `false`
- `NTFY_SERVER_URL`: ntfy server URL. This deployment self-hosts ntfy on the same Pi as the app, so it's normally `http://127.0.0.1:8081` (or the Pi's own LAN IP) - see the limitation noted under "Notification Settings" below.
- `NTFY_TOPIC`: ntfy topic, for example `camp-ascca-water`
- `NTFY_TOKEN`: optional bearer token for protected ntfy servers

For systemd, copy `.env.example` to `/etc/default/water-monitor` and edit values there.

## DietPi / Low-Resource Notes

This app is intentionally small enough for DietPi on a Raspberry Pi 3B or 4B with 1 GB RAM:

- The systemd unit caps Node heap at 96 MB and service memory at 192 MB.
- The dashboard graph is downsampled to `TREND_MAX_POINTS` so the browser is not asked to draw thousands of points.
- Old readings are pruned automatically with `RETENTION_DAYS`.
- SQLite runs in WAL mode for reliable local writes without a separate database service.

For a 1 GB Pi 3B, the server itself should be fine, but use another device as the wall display if possible. Running a full browser kiosk on the same 1 GB Pi can be the heavier part. A Pi 4B will feel better if it must both serve the app and drive a local screen.

If this Pi will also control a pump through GPIO later, keep pump control in a separate fail-safe module with manual override, relay/contactor isolation, startup-off behavior, and no automatic pump action from the monitor dashboard unless that is explicitly configured.

## Pump Control

Pump control is built as an opt-in feature with two interchangeable output types:

- `gpio`: drives a relay from a Raspberry Pi GPIO pin (requires the `onoff` package and an actual GPIO header - not available on a laptop).
- `usb_relay`: drives a cheap LCUS-1/LCUS-2 style USB relay module (CH340-based, shows up as a serial port) over a 4-byte hex command protocol. This is the option to use on a laptop or any machine without GPIO pins.

If `PUMP_OUTPUT` is not set, the app detects the host hardware at startup (Raspberry Pi device-tree model file, OS platform, and CPU architecture) and defaults to whichever output type that hardware actually supports - a real Raspberry Pi defaults to `gpio`, an x86 Linux box (like a donated laptop) defaults to `usb_relay`. The `/config.html` "Pump Output Hardware" panel shows this detection result and marks the recommended option, though you can still pick either one manually - the saved setting there takes precedence over the environment variable. Either way, **the app must be restarted** after changing output type or port/pin for the new hardware to take effect; this is intentional so the old GPIO export or serial connection is fully released first rather than hot-swapped.

### USB Relay Path Stability

Cheap CH340-style relay boards usually have no serial number programmed into their EEPROM. Without one, the OS cannot recognize "this is the same device I saw before" across a disconnect/reconnect, so its assigned path (`/dev/ttyUSB1`, `/dev/cu.usbserial-XXXX`, etc.) can change every time the connection drops and re-enumerates - even though nothing about the wiring or the relay itself changed. A fixed path setting will silently stop working the next time that happens.

The vendor and product ID (for example `1a86:7523` for a common CH340 chip) are baked into the chip itself and stay constant across reconnects, so the app can use those to find the relay instead of trusting a path. Set `PUMP_USB_RELAY_VENDOR_ID` and `PUMP_USB_RELAY_PRODUCT_ID`, or check "Lock to this USB device" next to the port dropdown in `/config.html`, and the app (and the watchdog below) will resolve the actual path fresh on every connect attempt. `PUMP_USB_RELAY_PORT` / the saved port path is kept as a fallback for when no identity match is found.

This doesn't fix an unstable physical connection - if the relay keeps dropping off the bus entirely (visible as the whole USB hub it's on disappearing from `system_profiler`/`lsusb`, not just the relay), that's a wiring/power problem at the cable or hub, not something software can paper over.

By default, `PUMP_CONTROL_ENABLED=false`, so the dashboard can show the controls without energizing any output. Enable it only after the relay/contactor wiring, enclosure, breaker/fuse, grounding, and manual disconnect are ready.

Current defaults:

- Auto on below `2.0 ft`
- Auto off at `7.2 ft`
- Stop pump after `15 minutes` without a LoRa reading
- Stop pump after `120 minutes` continuous runtime
- Startup mode is `Manual Off`

The dashboard lets you change the on/off levels, stale-signal stop time, and max runtime. Saving those values requires a browser confirmation. Changing between `Auto`, `Manual On`, and `Manual Off` also requires confirmation.

Manual On is allowed, but it is still bounded by the stale-reading and max-runtime safety stops. If readings stop for `staleShutdownMinutes` (default 15 minutes), the pump is shut off. Both defaults are deliberately conservative for overflow safety - raise them from the Pump panel only to match how long your pump actually takes to fill the tank.

### Failure-Safe Mode

If the app process dies, nothing programmatically changes the relay's state on its own - it just stays however it last was. These layers close that gap, each covering what the layer above cannot:

1. **Clean shutdown** (`SIGTERM`/`SIGINT`, e.g. `systemctl stop`) turns the pump off before exiting. This does not wait on HTTP connections to drain first (a stuck dashboard tab must never delay this).
2. **In-process crash handlers** (`uncaughtException`/`unhandledRejection`) force the relay off immediately, before the process exits. This covers ordinary JS crashes and bugs.
3. **Startup-off**: every time the app (re)starts, it drives the relay off before doing anything else, so any restart - planned or via `systemd`'s `Restart=on-failure` - clears a stuck-on relay.
4. **Continuous re-assertion**: every 10 seconds the app re-sends the *desired* physical state to the relay, not just on transitions. Everywhere else a command is only sent when the on/off decision changes, so a relay that energizes on its own - a welded contact, electrical noise, a brownout on the relay board, or a board that powers up in its last state - would otherwise never get another OFF while the software still thinks it is off. This loop forces such a relay back off within seconds, in either direction.
5. **`scripts/pump-watchdog.js`** is a separate program from the main app - a different file, a different process, no shared code, run as its own systemd service (`water-monitor-watchdog.service`). It does not require the main app's code to be working at all, only its HTTP API to respond. It enforces two independent backstops:
   - **Liveness**: if `/api/pump/status` stops responding for `WATCHDOG_FAILURE_THRESHOLD` consecutive checks (default 3, ~15s at the default 5s interval), it opens the relay/GPIO directly and forces it off. Covers the main app being dead, deadlocked, or unreachable - a `SIGKILL`, an out-of-memory kill, a native-module segfault, anything that stops it from answering.
   - **Independent max runtime**: even while the main app is alive and reporting itself healthy, the watchdog tracks how long it has personally observed `pumpOn: true`, using its own clock - not the runtime the main app reports about itself. If that exceeds `WATCHDOG_MAX_RUNTIME_MINUTES`, it forces the relay off regardless of what the main app says. This is what catches a *logic* bug (not a crash) that leaves the pump on - for example, if the main app's own auto-off threshold or max-runtime check were ever wrong, this is a second opinion that does not trust the same code that made the mistake.
   On either trigger, the watchdog also makes a best-effort direct write to the database to flip the saved pump mode to `manual_off`, so that if the main app comes back, it does not immediately re-energize the pump from a stuck `auto` or `manual_on` setting. The physical relay cutoff above does not depend on this write succeeding. The watchdog runs as its own service and, by design, does **not** depend on `water-monitor.service` being up (`After=` ordering only, no `Requisite=`) - it must still come up and stay running when the main app is stopped, failed, or crashed at boot.
6. **Hardware wiring** is the only layer that survives total power loss to the Pi or relay. Wire the relay/contactor so the pump's *normal, de-energized* state is OFF (see "Recommended hardware pattern" above) - software watchdogs cannot help if the board itself has no power.

**Known limitation - a sensor stuck on a plausible reading.** Every software layer above trusts the reported level. If the pressure sensor or transmitter fails in a way that keeps reporting a *believable but wrong* low level (e.g. a wiring fault that pins the reading near empty), Auto mode will hold the pump on and the stale-signal stop will not fire, because readings are still arriving. The only things that catch this are the max-runtime ceilings (main app + watchdog) and, definitively, a **physical high-level float switch wired in series with the pump contactor** so it cuts power mechanically at the overflow point regardless of anything the software believes. For an unattended tank that can overflow, treat the float switch as required, not optional. The receiver firmware also drops packets whose PSI is outside the sensor's valid range, but that only catches *out-of-range* garbage, not a plausible-but-wrong value.

Watchdog environment variables (set alongside the other `PUMP_*` variables in `/etc/default/water-monitor`):

- `WATCHDOG_STATUS_URL`: pump status endpoint to poll, default `http://127.0.0.1:$PORT/api/pump/status`
- `WATCHDOG_INTERVAL_SECONDS`: poll interval, default `5`
- `WATCHDOG_FAILURE_THRESHOLD`: consecutive failed checks before forcing the relay off, default `3`
- `WATCHDOG_MAX_RUNTIME_MINUTES`: independent hard ceiling on continuous pump runtime, default `150` (2.5 hours). Keep this slightly *above* the main app's own max runtime setting (default 120 min) so the app's cleaner stop runs first and this only fires as a true backstop.

The watchdog reads the `pumpOutput` setting from the same database file the main app uses (a plain file read, independent of whether the main app process is alive), so it stays in sync with whatever relay hardware was last configured in `/config.html` without needing its own copy of that setting.

Recommended hardware pattern:

- Pi GPIO/USB relay drives only an opto-isolated relay input or contactor control circuit.
- Pump power does not pass through the Pi.
- Use normally-open behavior so boot, crash, or GPIO/relay failure leaves the pump off.
- Wire a physical high-level float switch in series with the pump contactor coil, so it mechanically breaks pump power at the overflow point no matter what the software or relay does. This is the only layer that protects against a relay welded on or a sensor stuck on a plausible-but-wrong reading.
- Keep a physical manual override/disconnect outside the web app.

## Notification Settings

Open `/config.html` from the dashboard Settings link to point the app at a LAN ntfy server. The page saves:

- Enabled/disabled state
- ntfy server URL
- topic
- optional access token

The app also exposes:

- `GET /api/config/ntfy`
- `POST /api/config/ntfy`
- `POST /api/config/ntfy/test`

The test endpoint sends a simple test notification to the configured topic.

### What sends a notification

Once ntfy is enabled, the system sends push notifications for both water-level and pump/relay-safety events. The safety messages are written in plain English for on-site staff and include step-by-step "WHAT TO DO" instructions - no software knowledge needed. Each condition sends one message when it starts and one "all clear" when it ends, so you are not spammed on every check.

Water-level alerts (from the main app, gated by their own toggles on `/config.html`):

- Critical-low, low-warning, and recovered levels
- Rapid water loss over your configured window

Pump / relay safety alerts (from the main app):

- **No signal - pump stopped**: the tank sensor went quiet, so the pump was held off. Usually a dead battery/power at the tank sensor.
- **Relay problem - pump held off**: the app cannot reliably control the relay (USB unplugged, loose cable, relay lost power).
- **Safety shutoff - ran too long**: the pump hit its max-runtime ceiling and was stopped to prevent overflow.
- **Monitor crashed - pump forced off**: the software hit an error, forced the pump off, and is restarting (best-effort; the watchdog below is the reliable path if a crash keeps it down).
- Matching "restored / reconnected" all-clear messages.

Backup watchdog alerts (from `scripts/pump-watchdog.js`, the independent process):

- **EMERGENCY cutoff - monitor not responding**: the main app stopped answering and the watchdog forced the relay off. Sent at urgent priority.
- **EMERGENCY cutoff - ran too long**: the watchdog's own independent runtime ceiling was exceeded. Sent at urgent priority.
- **Water monitor back online**: the main app is responding again (reminds staff the pump was left in Manual Off and must be turned back on if needed).

The watchdog reads the same ntfy settings from the database that you set in `/config.html`, so there is nothing separate to configure - just enable notifications once. Emergency messages are sent at ntfy `urgent` priority with a siren tag; warnings at `high` with a warning tag; all-clears at normal priority. (Emoji live in the ntfy tags, not the title, because HTTP headers cannot carry emoji.)

**Important limitation: notifications cannot cover the whole Pi going down.** The ntfy server is self-hosted on this same Raspberry Pi, so if the Pi loses power, hard-freezes, or otherwise dies completely, ntfy dies with it and **no notification can be sent** - there's nothing left on the box to send one. This is exactly the "monitor unreachable" scenario the watchdog alert is meant to cover, but it only reaches you if the Pi itself (and its network connection) is still up and just the main app process is unhealthy or unresponsive.

If silent total-Pi failure is a real risk for your site (e.g. no one walks by the well house daily), the only ways to catch it are outside this box:

- Host ntfy elsewhere (a phone app polling this Pi's `/api/health` on a schedule, another always-on device on the LAN running ntfy, or an external uptime/ping service if this network reaches the internet), so the alert channel survives the Pi dying.
- Or, simplest and free: have someone glance at the dashboard once a day. A blank/unreachable page is the same signal a notification would have given you.

## API

`GET /api/latest`

Returns the latest reading, percent full, alarm state, and communication status. If no data has arrived, the response reports `Waiting for Data`.

`GET /api/readings?limit=100`

Returns recent readings newest first. The limit is clamped between 1 and 1000.

`GET /api/health`

Returns process status, serial status, database path, latest reading, thresholds, and uptime.

`GET /api/trend`

Returns readings for the dashboard graph. Use `?hours=48` for the default two-day view or `?hours=168` for the seven-day view.

## Thresholds

- Maximum tank height: `8.0 ft`
- Low warning: below `2.0 ft`
- Critical: below `1.0 ft`
- Near full: above `7.5 ft`
- Green communication status: update within 5 minutes
- Yellow communication status: update within 10 minutes
- Red communication status: no update for more than 10 minutes

## Systemd

Create the service account and install the app:

```bash
sudo useradd --system --home /opt/water-monitor --shell /usr/sbin/nologin watermonitor
sudo mkdir -p /opt/water-monitor
sudo chown -R watermonitor:watermonitor /opt/water-monitor
```

Copy this project to `/opt/water-monitor`, then install the service:

```bash
sudo cp systemd/water-monitor.service /etc/systemd/system/water-monitor.service
sudo cp systemd/water-monitor-watchdog.service /etc/systemd/system/water-monitor-watchdog.service
sudo cp .env.example /etc/default/water-monitor
sudo systemctl daemon-reload
sudo systemctl enable --now water-monitor
sudo systemctl enable --now water-monitor-watchdog
```

The watchdog service is only useful once pump control is wired up; see [Failure-Safe Mode](#failure-safe-mode) below.

Or run the Pi installer from the project directory:

```bash
sudo bash scripts/install-pi.sh
```

View logs:

```bash
journalctl -u water-monitor -f
```

If the `watermonitor` user needs serial permissions:

```bash
sudo usermod -aG dialout watermonitor
sudo systemctl restart water-monitor
```

## Maintenance

Back up the SQLite database:

```bash
sudo bash scripts/backup-db.sh
```

Prune readings older than 90 days:

```bash
sudo DAYS=90 bash scripts/prune-readings.sh
```

## Future Expansion

The database already stores `tower`, and the API enriches readings in one place. Additional monitor-only tables or event streams can be added for pump status, well pressure, chlorinator status, multiple tanks, SMS alert delivery, and Home Assistant integration without changing the current dashboard contract.
