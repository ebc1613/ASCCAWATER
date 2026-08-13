# Campsite Water Tower Monitor

Local LAN dashboard for a Raspberry Pi at the well house. The app reads newline-delimited JSON from an ESP32 LoRa receiver over USB serial, stores readings in SQLite, and serves a dark, touch-friendly dashboard.

This is monitor-only software. It does not control pumps, valves, chlorinators, or any other equipment.

## Features

- Finds the LoRa receiver by its USB vendor/product ID (`10c4:ea60`, the Heltec V3's CP2102 bridge), falling back to `SERIAL_PORT` (`/dev/water-radio`) if nothing matches.
- Override the identity with `SERIAL_VENDOR_ID`/`SERIAL_PRODUCT_ID`, or the fallback path with `SERIAL_PORT=/dev/ttyACM0`.
- Stores water level, PSI, battery, RSSI, SNR, sequence, tower, and timestamp in SQLite.
- Live dashboard updates with Server-Sent Events.
- Starts normally when the serial device is missing and shows `Waiting for Data`.
- Simulation mode for setup and demos.
- API endpoints for latest reading, recent readings, health, and 48-hour or 7-day trend data.
- Pump run log showing how long each run lasted and why it stopped.

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

- `SERIAL_PORT`: fallback path for the receiver, used only when no device matches its USB ID, default `/dev/water-radio` (a stable symlink the installer's udev rule creates)
- `SERIAL_VENDOR_ID` / `SERIAL_PRODUCT_ID`: USB identity of the LoRa receiver board, default `10c4`/`ea60`. The receiver and the pump relay are both USB-serial devices on this machine and `ttyUSB` numbering follows boot enumeration order, so each is matched by identity and neither is ever allowed to open the other's port. If your receiver is a clone with a CH340 (`1a86:7523`, the same chip as the relay), set these to match it and give the relay a distinct identity - otherwise the two cannot be told apart. `GET /api/system/serial-ports` labels every detected device with the role the app assigns it.
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
- `TANK_DIAMETER_FEET`: tank inside diameter in feet, used to convert level change into gallons for the usage estimate, default `33`. Overridden by the saved setting from `/config.html`.
- `TANK_GALLONS_PER_FOOT`: direct gallons-per-foot figure for a non-cylindrical tank. When set above `0` it takes precedence over the diameter.
- `PUMP_RATE_GPM`: pump inflow rate in gallons per minute. Default `0`, meaning the app infers it from past fills; the value here is only used as a fallback until it can.
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

If `PUMP_OUTPUT` is not set, the app detects the host hardware at startup (Raspberry Pi device-tree model file, OS platform, and CPU architecture) and defaults to whichever output type that hardware actually supports - a real Raspberry Pi defaults to `gpio`, an x86 Linux box (like a donated laptop) defaults to `usb_relay`. The `/config.html` "Pump Output Hardware" panel shows this detection result and marks the recommended option, though you can still pick either one manually - the saved setting there takes precedence over the environment variable.

Output settings apply immediately when saved. The app releases the old GPIO export or serial connection and drives it off before opening the new one, which is the same ordering a restart used to give, so no restart is needed.

### Finding the relay

The "Pump Output Hardware" panel shows a live **Relay Hardware** line - whether the output is currently open, which path it is on, and the exact fault if not. It updates every few seconds. Two things to know:

- The output is opened **even when `PUMP_CONTROL_ENABLED=false`**. Opening it only ever drives it OFF, so this is strictly safer than leaving the hardware untouched, and it means you can confirm the relay is plugged in and talking *before* enabling control. Nothing will be energized while control is disabled.
- A relay plugged in **after** the app started is picked up automatically within about ten seconds; there is a reconnect attempt on that interval whenever the output is not open. **Detect / Reconnect Relay** forces that scan immediately, and **Refresh Port List** re-enumerates the dropdown. Neither needs a restart.

If the relay is still not found, the cause is usually below the app:

- **Another daemon claimed the device.** On Debian and Raspberry Pi OS, `brltty` recognizes several CH340 product IDs as braille displays and grabs the port a second or two after it is plugged in - the device then disappears from `/dev`. The classic symptom is "it works after a reboot but never on a hot plug", because on a cold boot this app can win the race. `ModemManager` causes a milder version of the same thing by probing new serial devices for a modem. The installer handles both: a udev rule tells ModemManager to skip CH340 relays, and `brltty-udev.service` is masked - see "brltty" below.
- **Permissions.** The service account must be in the `dialout` group. The installer does this, but group membership only takes effect for processes started afterwards - `sudo systemctl restart water-monitor` is enough, a full reboot is not.
- **Check what the OS sees** with `lsusb` and `ls -l /dev/serial/by-id/`. If the relay is not there either, it is a cable, hub, or power problem, not a software one.

### brltty

The installer masks `brltty-udev.service`, which otherwise claims the CH340 relay. This is a machine-wide change and it is worth being explicit about why it is acceptable here: the well-house Pi is a headless controller that only maintenance staff ever touch, with no braille display attached and none planned. It is not a workstation.

It is fully reversible, and should be reversed before anyone uses a braille display on this machine:

```bash
sudo systemctl unmask brltty-udev.service
sudo systemctl start brltty-udev.service
```

To install without touching brltty at all - on any machine a person actually sits at:

```bash
sudo DISABLE_BRLTTY=false ./scripts/install.sh
```

If you would rather keep braille support working *and* free the relay, the narrower fix is to shadow the shipped rules file by copying `/usr/lib/udev/rules.d/85-brltty.rules` to `/etc/udev/rules.d/85-brltty.rules` and commenting out only the `1a86/7523` lines. That disables brltty for CH340 adapters specifically and leaves real braille displays working. It needs redoing if the brltty package ships a changed rules file, which is why the installer uses the simpler mask.

### USB Relay Path Stability

Cheap CH340-style relay boards usually have no serial number programmed into their EEPROM. Without one, the OS cannot recognize "this is the same device I saw before" across a disconnect/reconnect, so its assigned path (`/dev/ttyUSB1`, `/dev/cu.usbserial-XXXX`, etc.) can change every time the connection drops and re-enumerates - even though nothing about the wiring or the relay itself changed. A fixed path setting will silently stop working the next time that happens.

The vendor and product ID (for example `1a86:7523` for a common CH340 chip) are baked into the chip itself and stay constant across reconnects, so the app can use those to find the relay instead of trusting a path. Set `PUMP_USB_RELAY_VENDOR_ID` and `PUMP_USB_RELAY_PRODUCT_ID`, or check "Lock to this USB device" next to the port dropdown in `/config.html`, and the app (and the watchdog below) will resolve the actual path fresh on every connect attempt.

The saved port path is a fallback for when identity matching is **not configured at all**. Once a vendor/product ID is set and nothing matches it, the app reports the relay as missing rather than falling back to the stored path. That is deliberate: a no-match means the relay is not present, and by then `/dev/ttyUSB1` may well have been renumbered onto the water level sensor. Sending relay commands to the sensor's port is a worse outcome than reporting the relay as missing.

This doesn't fix an unstable physical connection - if the relay keeps dropping off the bus entirely (visible as the whole USB hub it's on disappearing from `system_profiler`/`lsusb`, not just the relay), that's a wiring/power problem at the cable or hub, not something software can paper over.

By default, `PUMP_CONTROL_ENABLED=false`, so the dashboard can show the controls without energizing any output. Enable it only after the relay/contactor wiring, enclosure, breaker/fuse, grounding, and manual disconnect are ready.

Current defaults:

- Auto on below `2.0 ft`
- Auto off at `7.2 ft`
- Stop pump after `15 minutes` without a LoRa reading
- Stop pump after `120 minutes` continuous runtime (raise this from **Max Run Hours** on the dashboard)
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
   - **Liveness**: if `/api/pump/status` stops responding for `WATCHDOG_FAILURE_THRESHOLD` consecutive checks (default 3, ~15s at the default 5s interval), it opens the relay/GPIO directly and forces it off. Covers the main app being dead, deadlocked, or unreachable - a `SIGKILL`, an out-of-memory kill, a native-module segfault, anything that stops it from answering. At watchdog startup only, `WATCHDOG_STARTUP_GRACE_SECONDS` (default 90) is allowed for the main app to come up before silence counts as a failure - systemd starts both services together and `After=` only orders the start, it does not wait for the app to be listening. The grace ends the instant the app answers once, and never applies again for the life of the process, so a crash mid-run is acted on immediately. Nothing is at risk during the window: a relay is de-energized when unpowered, and the main app has not had a chance to energize anything yet either.
   - **Independent max runtime**: even while the main app is alive and reporting itself healthy, the watchdog tracks how long it has personally observed `pumpOn: true`, using its own clock - not the runtime the main app reports about itself. If that exceeds the ceiling, it forces the relay off regardless of what the main app says. This is what catches a *logic* bug (not a crash) that leaves the pump on - for example, if the main app's own auto-off threshold or max-runtime check were ever wrong, this is a second opinion that does not trust the same code that made the mistake.

     The ceiling is the **Max Run Hours** value set on the dashboard, read from the status endpoint, plus `WATCHDOG_RUNTIME_GRACE_MINUTES` (default 20). Only the elapsed-time *measurement* is independent; the policy is shared on purpose. A fixed limit here meant the watchdog silently overruled the dashboard - a tank configured for a long fill got cut off at 2.5 hours with an urgent "ran too long" alert every time, because the two numbers had to be hand-matched and had drifted apart. Independence is about not trusting the app's observations, not about ignoring the operator's settings. The reported value is validated against the same 1..1440 minute range the app itself accepts, and a bad or missing one leaves the last good ceiling in place, so a corrupted status payload cannot talk the watchdog out of ever cutting off. The grace margin exists so the app's own cleaner stop always runs first and this fires only as a true backstop.

     `WATCHDOG_MAX_RUNTIME_MINUTES` no longer clamps this. It bounds only the fallback limit used before the watchdog has reached the app even once. Making the dashboard the source of truth was only half the fix: the env var went on capping the result, and because `scripts/install.sh` writes `/etc/default/water-monitor` only when that file does not already exist, every box installed before the change still carried the old flat `WATCHDOG_MAX_RUNTIME_MINUTES=150`. The watchdog kept cutting fills short at the stale number no matter what the dashboard said - the exact symptom the change was supposed to end. A value left in a config file must not be able to silently overrule the operator, so a ceiling set below the dashboard's setting is now logged as stale and ignored. The result is still bounded: the app clamps its own setting to 24 hours before reporting it, the watchdog re-validates it against that same range, and the final limit is capped at 24 hours plus the grace margin.
   On either trigger, the watchdog also makes a best-effort direct write to the database to flip the saved pump mode to `manual_off`, so that if the main app comes back, it does not immediately re-energize the pump from a stuck `auto` or `manual_on` setting. This write is why the startup grace matters: without it the watchdog reached its 3-strike threshold roughly 15 seconds into every boot, rewrote the saved pump mode, and pushed an urgent "EMERGENCY cutoff" notification - which looked exactly like the dashboard forgetting its settings on every restart. The physical relay cutoff above does not depend on this write succeeding. The watchdog runs as its own service and, by design, does **not** depend on `water-monitor.service` being up (`After=` ordering only, no `Requisite=`) - it must still come up and stay running when the main app is stopped, failed, or crashed at boot.
6. **Hardware wiring** is the only layer that survives total power loss to the Pi or relay. Wire the relay/contactor so the pump's *normal, de-energized* state is OFF (see "Recommended hardware pattern" above) - software watchdogs cannot help if the board itself has no power.

**Known limitation - a sensor stuck on a plausible reading.** Every software layer above trusts the reported level. If the pressure sensor or transmitter fails in a way that keeps reporting a *believable but wrong* low level (e.g. a wiring fault that pins the reading near empty), Auto mode will hold the pump on and the stale-signal stop will not fire, because readings are still arriving. The only things that catch this are the max-runtime ceilings (main app + watchdog) and, definitively, a **physical high-level float switch wired in series with the pump contactor** so it cuts power mechanically at the overflow point regardless of anything the software believes. For an unattended tank that can overflow, treat the float switch as required, not optional. The receiver firmware also drops packets whose PSI is outside the sensor's valid range, but that only catches *out-of-range* garbage, not a plausible-but-wrong value.

Watchdog environment variables (set alongside the other `PUMP_*` variables in `/etc/default/water-monitor`):

- `WATCHDOG_STATUS_URL`: pump status endpoint to poll, default `http://127.0.0.1:$PORT/api/pump/status`
- `WATCHDOG_INTERVAL_SECONDS`: poll interval, default `5`
- `WATCHDOG_FAILURE_THRESHOLD`: consecutive failed checks before forcing the relay off, default `3`
- `WATCHDOG_STARTUP_GRACE_SECONDS`: at watchdog startup only, how long to wait for the main app to come up before silence counts as a failure, default `90`. Ends early the moment the main app answers once. Set to `0` to disable, but expect a spurious cutoff and an urgent notification on every boot if the app takes longer than the failure threshold to start listening.
- `WATCHDOG_RUNTIME_GRACE_MINUTES`: how far above the dashboard's Max Run Hours the watchdog's ceiling sits, default `20`. This is the gap that lets the app's own cleaner stop run first.
- `WATCHDOG_MAX_RUNTIME_MINUTES`: bound on the *fallback* runtime limit only, default `1500` (25 hours). It does not cap the Max Run Hours set on the dashboard - a value below that is treated as stale config, logged, and ignored. If you see that warning, raise the line to `1500` or delete it.
- `WATCHDOG_FALLBACK_RUNTIME_MINUTES`: ceiling used only until the app has reported its setting even once, default `150`.

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

## Water Usage Estimate

The dashboard shows estimated gallons used over rolling 7-day, 30-day, 12-month, and 2-year windows, plus a per-month bar strip.

**This is an estimate, not metering.** There is no flow meter anywhere on this system. The only thing measured is tank level, every 5 minutes. Usage is reconstructed from it:

1. Water leaving the tank shows up as the level falling. Feet of drop times gallons per foot gives gallons out.
2. Water used *while the pump is filling* is masked by the incoming water, so pump run time multiplied by the pump's flow rate is added back.

Configure it in `/config.html` under "Tank Size & Water Usage". Only the tank's **inside diameter** is needed - usage comes from *changes* in level, so the 1 ft offset between this sensor and the tank's physical gauge cancels out and never enters the math. A 33 ft tank works out to about 6,398 gallons per foot. If the tank is not a plain cylinder, put a measured gallons-per-foot figure in the override field instead and the diameter is ignored.

The pump's flow rate is worked out automatically from how fast the tank actually rose during past fills, using the 90th percentile of observed fill rates. A net rise always understates the pump, because the camp is usually still drawing water while the tank fills; the fastest observed fills are the ones with the least draw against them. Until the pump has run enough for that to settle, the manual field is used, and if that is `0` the fill-time contribution is skipped entirely - which makes the total read **low**, and the dashboard says so.

### How the numbers are kept honest

- **Sensor noise is not counted as usage.** Naively summing every 5-minute drop would rectify jitter into fake consumption - at this tank's size that is thousands of phantom gallons a day. Readings are collapsed into hourly buckets by median, and changes below a 0.03 ft deadband are treated as zero. Measured against synthetic data with a known answer: at a realistic ±0.02 ft of sensor jitter, a completely idle tank produces **zero** phantom gallons; a noticeably worse sensor at ±0.05 ft leaks roughly 600 gallons a day, about 5% against typical real usage.
- **Accuracy.** Against six days of synthetic history with a known true consumption of 12,000 gal/day and a known 250 gal/min pump, the rollup recovered the pump rate to within 1% and the six-day total to within about 4%.
- **Gaps are visible, not hidden.** Intervals longer than 6 hours are skipped rather than guessed at, and the panel reports the percentage of the span the sensor was actually reporting for. Below 90% coverage it says outright that the real total is likely higher.
- **History survives retention.** Readings are pruned after `RETENTION_DAYS` (default 90), but the daily rollup rows are never pruned, which is what makes a 2-year window possible from a 90-day reading store. Each day also stores the raw drop and pump minutes it was built from, so correcting the tank diameter or pump rate later reprices the entire history rather than leaving a discontinuity at the retention boundary.
- **A day is only ever computed from data.** If there are no readings for a day, any previously stored row for it is left alone - pruning can never shrink or erase usage history that was already rolled up.

Rollup runs at startup and hourly. Days are local calendar days.

## API

`GET /api/latest`

Returns the latest reading, percent full, alarm state, and communication status. If no data has arrived, the response reports `Waiting for Data`.

`GET /api/readings?limit=100`

Returns recent readings newest first. The limit is clamped between 1 and 1000.

`GET /api/pump/runs?days=30&limit=50`

Returns completed pump runs newest first, with `seconds` for each, plus `totalRuns`, `totalSeconds`, and `longestSeconds` for the window. `days` is clamped 1..730 and `limit` 1..500; the totals always cover the whole window even when the list is truncated.

Runs are **derived** by pairing on/off transitions in `pump_events` rather than recorded in their own table. `pump_events` is never pruned, so the log covers history from before the feature existed. Two runs are not clean pairs and are reported as such:

- `inProgress: true` - the pump is running now; `seconds` is the elapsed time so far and `endedAt` is null.
- `endedUnexpectedly: true` - an `on` followed by another `on` with no `off` between them. The watchdog cuts the relay directly and a hard kill leaves no chance to log anything, so the true end is unknown. The run is closed at the next event, which is the last moment there is evidence for. That under-reports rather than running the duration forward to now, which would wildly over-report.

`GET /api/health`

Returns process status, serial status, database path, latest reading, thresholds, and uptime.

`GET /api/trend`

Returns readings for the dashboard graph. Use `?hours=48` for the default two-day view or `?hours=168` for the seven-day view.

`GET /api/usage`

Returns the estimated water usage rollup: rolling totals for today, 7, 30, 365, and 730 days, a per-month series, the per-day series, the conversion factor in use, the pump rate and where it came from, and the sensor data coverage behind the numbers. See "Water Usage Estimate" above.

`GET /api/config/usage` / `POST /api/config/usage`

Reads and writes the tank diameter, gallons-per-foot override, and pump flow rate. Writing recalculates the whole stored history. `POST` requires `confirm: true`.

`GET /api/config/pump-output` / `POST /api/config/pump-output`

Reads and writes the pump output hardware settings. Both include a live `status` object (`available`, `fault`, `connectedPath`, `dropCount`) describing what the output is doing right now. `POST` applies the change immediately - no restart - and requires `confirm: true`.

`POST /api/config/pump-output/reconnect`

Releases and re-opens the pump output, re-scanning for the relay. This is what the "Detect / Reconnect Relay" button calls. Requires `confirm: true`.

## Thresholds

- Maximum tank height: `7.2 ft` (`TANK_MAX_FEET`)
- Low warning: below `2.0 ft`
- Critical: below `1.0 ft`
- Near full: at or above `7.0 ft`

`TANK_MAX_FEET` is the absolute full level measured in **feet of water above the sensor tap**, not the tank's physical height - the sensor taps in about a foot above the floor, so it reads roughly a foot lower than the tank's own gauge. Percent full, the tank graphic, the trend axis, and the ceiling on every level threshold are all measured against it. Each threshold is clamped to it on read, so lowering it corrects stored settings that no longer fit instead of leaving an alert that can never fire.
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

Or run the installer from the project directory (works on the Pi or any systemd Linux box, e.g. an x86 laptop):

```bash
sudo bash scripts/install.sh
```

By default the installer also sets up two optional pieces of infrastructure:

- **ntfy**, installed from its official apt repo and started as a systemd service (`ntfy.service`) listening on port `8081` on all interfaces, matching the `NTFY_SERVER_URL` default in `.env.example`. Notifications stay off (`NTFY_ENABLED=false`) until you set a topic and enable them from `/config.html`.
- **Tailscale**, installed from its official apt repo and started as a systemd service (`tailscaled`), but **not connected**. Authenticating the box (`sudo tailscale up`) opens a login link and requires a human, so the installer stops short of that step - run it yourself once the install finishes.

Skip either one with `INSTALL_NTFY=false` or `INSTALL_TAILSCALE=false`:

```bash
sudo INSTALL_NTFY=false INSTALL_TAILSCALE=false bash scripts/install.sh
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
