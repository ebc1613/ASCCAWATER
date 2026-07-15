# ESP32 LoRa Firmware

Two Arduino sketches for the LoRa link between the tank-side sensor and the Pi:

- `transmitter/transmitter.ino` - lives at the tank/well on solar + 12V LiFePO4. Reads the
  pressure sensor, sleeps, wakes every 5 minutes, sends one LoRa packet.
- `receiver/receiver.ino` - sits next to the Pi, connected by USB. Listens for LoRa
  packets and prints one JSON line per packet to USB serial, matching the format
  `server.js` reads from `SERIAL_PORT`.

## Hardware assumed

- Board: Heltec WiFi LoRa 32 V3 or a pin-compatible clone (SX1262, 915 MHz, CP2102 USB-serial).
  Pin numbers in both sketches match the genuine Heltec V3 mapping - verify against your
  specific board's silkscreen/pinout diagram before wiring, especially if it's a clone.
- Sensor: 1/8" NPT pressure transducer, 5 PSI full scale, 5V supply, ratiometric
  0.5-4.5V linear output (0 PSI = 0.5V, 5 PSI = 4.5V) per its datasheet, wired
  VCC/GND/Signal. The tank has never been run empty or anywhere near 5 PSI, so
  `transmitter.ino` calibrates off a real measurement (0.48V at the ADC pin = 4.75 ft)
  rather than the datasheet's full-scale point - see "Pressure sensor calibration" below.
- ADC: the ESP32-S3's built-in ADC on the transmitter reads the pressure sensor. An
  external ADS1115 was tried but removed - on a breadboard it kept dying to loose grounds
  and a stray 13V, and tank-level readings don't need 16-bit precision. See "Why not the
  ADS1115" below.
- Transmitter power: 12V LiFePO4 + solar charge controller -> buck converter -> 5V rail.
  The 5V rail powers the ESP32 (5V/VIN pin) and the sensor, and is always on; only the
  ESP32 itself deep-sleeps between readings.

## Wiring

- Pressure sensor VCC -> 5V rail, GND -> common ground.
- Pressure sensor signal -> divider (10k to signal, 22k to GND) -> ESP32 GPIO4
  (ADC1_CH3, `PIN_PRESSURE_ADC` in `transmitter.ino`).
  Ratio 22k/(10k+22k) = 0.6875. The sensor's real full-tank output sits well under 1V at
  the pin, nowhere near the ESP32 ADC's ~3.3V ceiling - even at the sensor's rated 4.5V
  max the divider only puts ~3.09V at the pin, so there's no overpressure headroom to
  design around. `analogReadMilliVolts()` applies the chip's factory calibration. An
  optional 0.1uF cap from GPIO4 to GND steadies the reading.
- Keep the divider's 22k leg solidly grounded. If it floats, the full sensor voltage
  lands on the ADC pin - the same failure mode that kept killing the ADS1115.
- LoRa radio (SX1262) uses the board's onboard SPI pins - no extra wiring needed.

The receiver has no analog inputs.

### Battery monitoring - disabled

Battery voltage sensing is off. `transmitter.ino` sets `BATTERY_MONITORED = false` and
sends a placeholder `0.0V` (server.js requires a finite `battery` field, so it can't be
dropped - the dashboard's battery value is not real).

To add it later: put battery+ through its own divider, sized so a full ~14.6V charge
stays under ~3.0V, into another ADC1 pin such as GPIO3 (ADC1_CH2), and read it the same
way `readPressurePsi()` reads its pin. Keep the divider's low leg solidly grounded.

### Why not the ADS1115

The ADS1115 is a better ADC (16-bit, low noise), but for this tank-level sensor the
ESP32's built-in 12-bit ADC, averaged over 16 samples, is good enough. With the current
calibration (see below) the sensor's usable tank range is compressed into a narrow band
at the ADC pin, so one 12-bit LSB works out to roughly a third of an inch and post-averaging
noise adds a few tenths of a foot of jitter - coarser than the extra ADS1115 bits could
have helped with, but well within the sensor's own accuracy and real-world sloshing/drift,
and plenty for pump on/off thresholds. (If finer resolution is ever needed, the fix is a
different sensor or divider that uses more of the ADC's range, not a better ADC.) The
ADS1115 was also fragile: any input over ~3.6V destroys it instantly, which on a breadboard
(loose grounds, a nearby 13V battery line) happened repeatedly. The native ADC has no such
failure mode.

### Pressure sensor calibration

`transmitter.ino` computes water level from the ADC pin voltage using two points:

- **Empty (0 ft):** the sensor's rated 0.5V floor at 0 PSI, carried through the 22k/10k
  divider (`ADC_VOLTS_AT_EMPTY = 0.5 * 0.6875`). The tank has never actually been run dry,
  so this is the datasheet's floor, not a measurement.
- **Calibration point:** a measured ADC pin reading of 0.48V at a known water level of
  4.75 ft (`ADC_VOLTS_AT_CAL` / `FEET_AT_CAL`), taken with the transducer-to-tank air gap
  bled out. (An earlier 7.5 ft point was taken with air trapped in that line and was wrong.)

Feet is interpolated linearly between those two points, then converted to `psi` (via the
water-column relationship, `psi = feet * 0.433`) to keep the LoRa packet format and
`receiver.ino`'s `psi` -> `feet` conversion unchanged. Update `ADC_VOLTS_AT_CAL` and
`FEET_AT_CAL` in `transmitter.ino` if a better calibration measurement is taken.

## Libraries

Install via Arduino IDE Library Manager:

- **RadioLib** (by jgromes) - handles the SX1262 radio on both ends.
- **U8g2** (by olikraus) - drives the onboard SSD1306 OLED on the receiver. The receiver
  powers the OLED through Vext (GPIO36 driven LOW) and uses SDA=GPIO17, SCL=GPIO18,
  reset=GPIO21 - the Heltec V3 standard OLED mapping.

The transmitter needs only RadioLib now (no ADS1115 library).

## Board settings (Arduino IDE)

- Board: "ESP32S3 Dev Module" (Heltec V3 / MakerFocus V3 both use an ESP32-S3).
- USB CDC On Boot: **Disabled**. The Heltec V3 routes its USB-C jack through a CP2102
  bridge to UART0, and the ESP32-S3's native USB pins are not on the connector. With CDC
  Enabled, `Serial` goes to that native USB (a dead end here) and the monitor stays blank
  except for the ROM boot banner. Disabled routes `Serial` to UART0/CP2102, which is what
  you actually see on the port.
- Upload Speed: 921600 is fine for both.

## Protocol

The transmitter sends a 12-byte packed struct (`seq`, `psi`, `batteryVolts`) as a raw LoRa
payload - no LoRaWAN, no ACK, fire-and-forget. The receiver converts `psi` to `feet` using
the water-column relationship (`psi = feet * 0.433`) and fills in `rssi`/`snr` from the
received packet before printing JSON. Both sketches must use matching frequency,
bandwidth, spreading factor, and coding rate (defined near the top of each file).

If you change the antenna, enclosure, or get unreliable links through the trees, the
spreading factor is the first knob to try: higher (up to 12) trades airtime for range,
lower (down to 7) trades range for speed/battery.
