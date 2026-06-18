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
- `NTFY_ENABLED`: enable ntfy notifications, default `false`
- `NTFY_SERVER_URL`: LAN ntfy server URL, for example `http://192.168.1.50:8081`
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

By default, `PUMP_CONTROL_ENABLED=false`, so the dashboard can show the controls without energizing any output. Enable it only after the relay/contactor wiring, enclosure, breaker/fuse, grounding, and manual disconnect are ready.

Current defaults:

- Auto on below `2.0 ft`
- Auto off at `7.2 ft`
- Stop pump after `60 minutes` without a LoRa reading
- Stop pump after `12 hours` continuous runtime
- Startup mode is `Manual Off`

The dashboard lets you change the on/off levels, stale-signal stop time, and max runtime. Saving those values requires a browser confirmation. Changing between `Auto`, `Manual On`, and `Manual Off` also requires confirmation.

Manual On is allowed, but it is still bounded by the stale-reading and max-runtime safety stops. If readings stop for an hour, the pump is shut off.

Recommended hardware pattern:

- Pi GPIO drives only an opto-isolated relay input or contactor control circuit.
- Pump power does not pass through the Pi.
- Use normally-open behavior so boot, crash, or GPIO failure leaves the pump off.
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
sudo cp .env.example /etc/default/water-monitor
sudo systemctl daemon-reload
sudo systemctl enable --now water-monitor
```

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
