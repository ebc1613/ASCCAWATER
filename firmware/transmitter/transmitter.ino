// Camp ASCCA water tower - tank-side transmitter
//
// Board: Heltec WiFi LoRa 32 V3 (or MakerFocus ESP32 LoRa V3 clone), SX1262, 915 MHz.
// Power: 12V LiFePO4 + solar -> buck converter -> 5V rail powers the ESP32 (5V/VIN pin)
//        and the pressure sensor directly. The 5V rail is always on; only the ESP32
//        sleeps between readings.
// Sensor: 1/8" NPT pressure transducer, 5 PSI full scale, 5V supply, ratiometric
//        0.5-4.5V linear output (0 PSI = 0.5V, 5 PSI = 4.5V).
//
// Wiring (verify against your board's silkscreen - this is a clone, not genuine Heltec):
//   Pressure sensor signal -> voltage divider (10k top / 22k bottom to GND) -> GPIO4 (ADC1_CH3)
//     Divider ratio 22k/(10k+22k) = 0.6875, so 4.5V sensor output reads as ~3.09V at the ADC.
//   12V battery sense -> voltage divider (100k top / 27k bottom to GND) -> GPIO3 (ADC1_CH2)
//     Divider ratio 27k/(100k+27k) = 0.2126, so 14.6V (full LiFePO4) reads as ~3.1V at the ADC.
//   LoRa radio (SX1262) uses the board's onboard SPI pins below - no extra wiring needed.
//
// Library: RadioLib (install via Arduino Library Manager - search "RadioLib" by jgromes).

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
#define LORA_SPREADING_FACTOR 10   // higher = more range/penetration, slower airtime
#define LORA_CODING_RATE     8     // 4/8, most robust
#define LORA_TX_POWER_DBM    22    // SX1262 max conducted power

// ---- Sensor ADC pins ----
#define PIN_PRESSURE_ADC 4   // verify free/unused on your board
#define PIN_BATTERY_ADC  3   // verify free/unused on your board

// ---- Pressure sensor calibration ----
const float SENSOR_V_AT_0_PSI = 0.5f;
const float SENSOR_V_AT_MAX_PSI = 4.5f;
const float SENSOR_MAX_PSI = 5.0f;
const float PRESSURE_DIVIDER_RATIO = 22000.0f / (10000.0f + 22000.0f); // 0.6875

// ---- Battery sense calibration ----
const float BATTERY_DIVIDER_RATIO = 27000.0f / (100000.0f + 27000.0f); // 0.2126

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

float readAveragedMilliVolts(int pin, int samples = 16) {
  uint32_t total = 0;
  for (int i = 0; i < samples; i++) {
    total += analogReadMilliVolts(pin);
    delay(2);
  }
  return total / (float)samples / 1000.0f;
}

float readPressurePsi() {
  analogSetPinAttenuation(PIN_PRESSURE_ADC, ADC_11db);
  float adcVolts = readAveragedMilliVolts(PIN_PRESSURE_ADC);
  float sensorVolts = adcVolts / PRESSURE_DIVIDER_RATIO;

  float psi = (sensorVolts - SENSOR_V_AT_0_PSI) /
              (SENSOR_V_AT_MAX_PSI - SENSOR_V_AT_0_PSI) * SENSOR_MAX_PSI;

  if (psi < 0) psi = 0;
  if (psi > SENSOR_MAX_PSI + 0.5f) psi = SENSOR_MAX_PSI + 0.5f; // allow small overrange, clamp runaway
  return psi;
}

float readBatteryVolts() {
  analogSetPinAttenuation(PIN_BATTERY_ADC, ADC_11db);
  float adcVolts = readAveragedMilliVolts(PIN_BATTERY_ADC);
  return adcVolts / BATTERY_DIVIDER_RATIO;
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
