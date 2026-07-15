// Camp ASCCA water tower - tank-side transmitter
//
// Board: Heltec WiFi LoRa 32 V3 (HTIT-WB32LAF), ESP32-S3, SX1262, 915 MHz.
// Power: 12V LiFePO4 + solar -> buck converter -> 5V rail powers the ESP32 (5V/VIN pin)
//        and the pressure sensor directly. The 5V rail is always on; only the ESP32
//        sleeps between readings.
// Sensor: 1/8" NPT pressure transducer, 5 PSI full scale, 5V supply, ratiometric
//        0.5-4.5V linear output (0 PSI = 0.5V, 5 PSI = 4.5V) per its datasheet. It has a
//        HIGH output impedance (~100k), so it must feed a high-impedance load - a low-Z
//        resistor divider collapses its output (see ADC note).
// ADC: the ESP32-S3's built-in ADC reads the sensor directly. The old ADS1115 was removed,
//        and its 10k/22k divider had to go too: because the sensor is high-impedance, it
//        read fine into the ADS1115 (megohm input) but collapsed under the divider's ~32k
//        load, reading far too low. With no divider, the sensor drives GPIO4 directly and
//        the ADC sees its true voltage. Tank max ~6.75 ft = ~2.92 PSI = ~2.84V, which is
//        under the ADC's ~3.1V (11db) ceiling, so no division is needed for range.
//        analogReadMilliVolts() applies the chip's factory ADC calibration.
// Battery monitoring: DISABLED - a placeholder 0.0V is sent (server.js requires a finite
//        battery field, so it can't be dropped). See note below to add it later.
//
// Wiring:
//   Pressure sensor VCC -> 5V rail, GND -> common GND.
//   Pressure sensor signal -> ~1-4.7k series resistor -> GPIO4 (ADC1_CH3), plus a 0.1uF cap
//     from GPIO4 to GND. NO voltage divider. The series R limits fault current if the sensor
//     ever swings to its 4.5V full scale (above the ADC's 3.3V limit); the cap is the charge
//     reservoir the ADC's sample-and-hold needs to read this high-impedance sensor. Neither
//     changes the steady-state (DC) voltage the ADC sees.
//   LoRa radio (SX1262) uses the board's onboard SPI pins below - no extra wiring needed.
//
// To add battery monitoring later: put battery+ through its own divider (sized so full
//   charge stays under ~3.0V) into another ADC1 pin such as GPIO3 (ADC1_CH2), then read
//   it the same way readPressurePsi() reads its pin. Keep the divider's low leg grounded
//   solidly - a floating divider is what puts full battery voltage onto the ADC pin.
//
// Library: RadioLib (install via Arduino Library Manager - "RadioLib" by jgromes).

#include <RadioLib.h>

// ---- LoRa radio pins (Heltec WiFi LoRa 32 V3 standard mapping) ----
#define PIN_LORA_NSS   8
#define PIN_LORA_DIO1  14
#define PIN_LORA_RST   12
#define PIN_LORA_BUSY  13
#define PIN_LORA_SCK   9
#define PIN_LORA_MISO  11
#define PIN_LORA_MOSI  10

// ---- LoRa radio settings ----
// 903.9 MHz: low end of the US 902-928 MHz ISM band (with guard band from the 902.0 MHz
// edge). Lower frequency = longer wavelength = better diffraction through tree trunks
// and foliage than the 915 MHz band center. Must match the receiver exactly.
#define LORA_FREQUENCY_MHZ   903.9
#define LORA_BANDWIDTH_KHZ   125.0
#define LORA_SPREADING_FACTOR 12   // higher = more range/penetration, slower airtime
#define LORA_CODING_RATE     8     // 4/8, most robust
#define LORA_TX_POWER_DBM    22    // SX1262 max conducted power

// ---- Sensor ADC pin ----
#define PIN_PRESSURE_ADC 4   // GPIO4 = ADC1_CH3, free now that the I2C/ADS1115 is gone

// ---- Pressure sensor calibration ----
// With the divider gone, the ADC reads the sensor's TRUE output voltage, which follows the
// datasheet curve: 0.5V at 0 PSI, rising 0.8V per PSI (0.5-4.5V over 0-5 PSI). Confirmed by
// a bench measurement of 1.9V (open-circuit) at ~4 ft, which the datasheet predicts as 1.89V.
// psi is computed straight from the voltage and sent in the packet; the receiver converts
// psi -> feet. If a clean known-level reading later shows a constant offset, trim
// SENSOR_V_AT_0_PSI to match (that shifts the whole curve without changing the slope).
const float SENSOR_V_AT_0_PSI = 0.5f;  // sensor output voltage at 0 PSI (empty)
const float SENSOR_V_PER_PSI  = 0.8f;  // datasheet slope: (4.5V - 0.5V) / 5 PSI
const float SENSOR_MAX_PSI    = 5.0f;  // sensor full scale; clamps runaway/fault reads

// ---- Battery monitoring - DISABLED (see header) ----
const bool BATTERY_MONITORED = false;
const float BATTERY_PLACEHOLDER_VOLTS = 0.0f; // sent in place of a real reading

// ---- Timing ----
const uint64_t SLEEP_INTERVAL_US = 5ULL * 60ULL * 1000000ULL; // 5 minutes

RTC_DATA_ATTR uint32_t seqCounter = 0;

SPIClass loraSPI(HSPI);
Module loraModule(PIN_LORA_NSS, PIN_LORA_DIO1, PIN_LORA_RST, PIN_LORA_BUSY, loraSPI);
SX1262 radio = new Module(loraModule);

struct __attribute__((packed)) TankPacket {
  uint32_t seq;
  float psi;
  float batteryVolts;
};

float readAveragedVolts(int pin, int samples = 16) {
  uint32_t total = 0;
  for (int i = 0; i < samples; i++) {
    total += analogReadMilliVolts(pin);
    delay(2);
  }
  return total / (float)samples / 1000.0f;
}

float readPressurePsi() {
  analogSetPinAttenuation(PIN_PRESSURE_ADC, ADC_11db);
  // No divider: the ADC pin reads the sensor's true output voltage directly.
  float sensorVolts = readAveragedVolts(PIN_PRESSURE_ADC);

  float psi = (sensorVolts - SENSOR_V_AT_0_PSI) / SENSOR_V_PER_PSI;

  if (psi < 0) psi = 0;                           // below the 0.5V floor = empty
  if (psi > SENSOR_MAX_PSI) psi = SENSOR_MAX_PSI; // clamp runaway/fault reads to full scale
  return psi;
}

float readBatteryVolts() {
  return BATTERY_PLACEHOLDER_VOLTS; // battery monitoring disabled
}

void goToSleep() {
  esp_sleep_enable_timer_wakeup(SLEEP_INTERVAL_US);
  esp_deep_sleep_start();
}

void setup() {
  Serial.begin(115200);
  delay(100);

  loraSPI.begin(PIN_LORA_SCK, PIN_LORA_MISO, PIN_LORA_MOSI, PIN_LORA_NSS);

  int state = radio.begin(LORA_FREQUENCY_MHZ);
  if (state != RADIOLIB_ERR_NONE) {
    Serial.printf("Radio init failed, code %d. Sleeping and retrying next cycle.\n", state);
    goToSleep();
    return;
  }

  // Heltec WiFi LoRa 32 V3 wires the SX1262's DIO2 pin to the antenna TX/RX switch.
  // RadioLib doesn't enable that by default - without this call, begin()/transmit()
  // report success but nothing actually reaches the antenna.
  radio.setDio2AsRfSwitch(true);

  radio.setBandwidth(LORA_BANDWIDTH_KHZ);
  radio.setSpreadingFactor(LORA_SPREADING_FACTOR);
  radio.setCodingRate(LORA_CODING_RATE);
  radio.setOutputPower(LORA_TX_POWER_DBM);

  TankPacket packet;
  packet.seq = ++seqCounter;
  packet.psi = readPressurePsi();
  packet.batteryVolts = readBatteryVolts();

  state = radio.transmit((uint8_t *)&packet, sizeof(packet));
  if (state == RADIOLIB_ERR_NONE) {
    Serial.printf("Sent seq=%lu psi=%.2f battery=%.2f\n",
                  (unsigned long)packet.seq, packet.psi, packet.batteryVolts);
  } else {
    Serial.printf("Send failed, code %d\n", state);
  }

  radio.sleep();
  goToSleep();
}

void loop() {
  // Never reached - setup() always ends in deep sleep.
}
