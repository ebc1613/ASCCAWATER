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
  0.5-4.5V linear output (0 PSI = 0.5V, 5 PSI = 4.5V), wired VCC/GND/Signal.
- Transmitter power: 12V LiFePO4 + solar charge controller -> buck converter -> 5V rail.
  The 5V rail powers both the ESP32 (5V/VIN pin) and the sensor directly and is always on;
  only the ESP32 itself deep-sleeps between readings.

## Wiring

Both ADC inputs need a divider because the ESP32 ADC tops out around 3.3V:

- Pressure sensor signal -> divider (10k to signal, 22k to GND) -> GPIO4.
  Ratio 0.6875, so the sensor's 4.5V max output reads as ~3.09V at the pin.
- 12V battery sense -> divider (100k to battery+, 27k to GND) -> GPIO3.
  Ratio 0.213, so a full 14.6V LiFePO4 reads as ~3.1V at the pin.

GPIO3/GPIO4 are assumed free on the V3 board layout - confirm they aren't already used
by your specific clone before wiring.

## Libraries

Install via Arduino IDE Library Manager:

- **RadioLib** (by jgromes) - handles the SX1262 radio on both ends.

## Board settings (Arduino IDE)

- Board: "ESP32S3 Dev Module" (Heltec V3 / MakerFocus V3 both use an ESP32-S3).
- USB CDC On Boot: Enabled (so Serial over USB works without a separate UART bridge issue).
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
