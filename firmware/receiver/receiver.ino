// Camp ASCCA water tower - well house receiver
//
// Board: Heltec WiFi LoRa 32 V3 (or MakerFocus ESP32 LoRa V3 clone), SX1262, 915 MHz.
// Power/connection: USB cable to the Raspberry Pi. The same USB-serial chip used to
//        flash this sketch is read by server.js as SERIAL_PORT (default /dev/ttyUSB0).
//
// This sketch listens for LoRa packets from the transmitter and:
//   1. prints one JSON line per packet to USB serial, matching the format server.js expects:
//        {"tower":"camp-main","feet":6.8,"psi":2.94,"battery":13.1,"rssi":-108,"snr":-3.5,"seq":1523}
//   2. shows the latest reading on the board's onboard OLED for a quick local glance.
//
// Onboard OLED (Heltec V3): SSD1306 128x64 on its own I2C bus - SDA=GPIO17, SCL=GPIO18,
//   reset=GPIO21. IMPORTANT: the OLED is powered through Vext, which is off until GPIO36
//   is driven LOW. Miss that and begin() appears to work but the screen stays dark.
//
// Libraries (install via Arduino Library Manager):
//   - RadioLib (by jgromes) - SX1262 radio.
//   - U8g2 (by olikraus) - SSD1306 OLED.

#include <RadioLib.h>
#include <U8g2lib.h>
#include <Wire.h>

// ---- LoRa radio pins (Heltec WiFi LoRa 32 V3 standard mapping) ----
#define PIN_LORA_NSS   8
#define PIN_LORA_DIO1  14
#define PIN_LORA_RST   12
#define PIN_LORA_BUSY  13
#define PIN_LORA_SCK   9
#define PIN_LORA_MISO  11
#define PIN_LORA_MOSI  10

// ---- Onboard OLED pins (Heltec WiFi LoRa 32 V3) ----
#define VEXT_PIN  36   // drive LOW to power the OLED (and other Vext peripherals)
#define OLED_SDA  17
#define OLED_SCL  18
#define OLED_RST  21

// ---- LoRa radio settings - must match the transmitter exactly ----
// 903.9 MHz: low end of the US 902-928 MHz ISM band, for better penetration through
// tree trunks/foliage than the 915 MHz band center.
#define LORA_FREQUENCY_MHZ    903.9
#define LORA_BANDWIDTH_KHZ    125.0
#define LORA_SPREADING_FACTOR 12
#define LORA_CODING_RATE      8

#define TOWER_NAME "camp-main"
const float FEET_PER_PSI = 1.0f / 0.433f; // water column: psi = feet * 0.433

SPIClass loraSPI(HSPI);
Module loraModule(PIN_LORA_NSS, PIN_LORA_DIO1, PIN_LORA_RST, PIN_LORA_BUSY, loraSPI);
SX1262 radio = new Module(loraModule);

// Full-buffer software-I2C driver on the OLED's dedicated pins (clock, data, reset).
U8G2_SSD1306_128X64_NONAME_F_SW_I2C oled(U8G2_R0, OLED_SCL, OLED_SDA, OLED_RST);

struct __attribute__((packed)) TankPacket {
  uint32_t seq;
  float psi;
  float batteryVolts;
};

// Draw a one-line status message centered-ish (used before the first packet and on error).
void showMessage(const char *line1, const char *line2) {
  oled.clearBuffer();
  oled.setFont(u8g2_font_6x12_tf);
  oled.drawStr(0, 12, "Camp ASCCA water");
  oled.drawHLine(0, 16, 128);
  oled.drawStr(0, 38, line1);
  if (line2) oled.drawStr(0, 52, line2);
  oled.sendBuffer();
}

// Map raw RSSI (dBm) to a glanceable link-quality word. RSSI is the best single
// indicator of received signal strength; the exact SNR is shown numerically alongside.
// Thresholds are rough field rules of thumb for SF12/125kHz LoRa - adjust to taste.
// SF12 runs ~5dB more sensitive than SF10 (about 2.5dB per SF step), so these are
// shifted 5dB lower than the SF10 thresholds to keep the same relative margins.
const char *signalLabel(float rssi) {
  if (rssi >= -100.0f) return "STRONG";
  if (rssi >= -115.0f) return "GOOD";
  if (rssi >= -125.0f) return "WEAK";
  return "FAINT";
}

// Draw the latest reading. feet is the headline; the quality word plus the RSSI/SNR
// detail line let you judge link strength at a glance during install/troubleshooting.
void showReading(float feet, float psi, float rssi, float snr, uint32_t seq) {
  char buf[32];
  oled.clearBuffer();

  // Title
  oled.setFont(u8g2_font_6x12_tf);
  oled.drawStr(0, 10, "Camp ASCCA water");
  oled.drawHLine(0, 13, 128);

  // Water level, big
  oled.setFont(u8g2_font_10x20_tf);
  snprintf(buf, sizeof(buf), "%.1f ft", feet);
  oled.drawStr(0, 33, buf);

  // Link-quality word, right-aligned beside the level
  oled.setFont(u8g2_font_6x12_tf);
  const char *quality = signalLabel(rssi);
  oled.drawStr(128 - (int)strlen(quality) * 6, 30, quality);

  // psi (left) and sequence number (right)
  snprintf(buf, sizeof(buf), "%.2f psi", psi);
  oled.drawStr(0, 47, buf);
  snprintf(buf, sizeof(buf), "#%lu", (unsigned long)seq);
  oled.drawStr(128 - (int)strlen(buf) * 6, 47, buf);

  // Signal detail line: RSSI in dBm and SNR in dB, full precision
  oled.setFont(u8g2_font_5x8_tf);
  snprintf(buf, sizeof(buf), "RSSI %ddBm  SNR %.1fdB", (int)rssi, snr);
  oled.drawStr(0, 62, buf);

  oled.sendBuffer();
}

// Raised by the DIO1 interrupt the moment a LoRa packet finishes arriving. The ISR must
// stay tiny (just set the flag) and live in IRAM; the packet is read back in loop().
volatile bool packetReady = false;
IRAM_ATTR void onPacketReady() {
  packetReady = true;
}

void setup() {
  Serial.begin(115200);
  delay(100);

  // Power the OLED rail before touching the display, then start U8g2.
  pinMode(VEXT_PIN, OUTPUT);
  digitalWrite(VEXT_PIN, LOW);
  delay(50);
  oled.begin();
  showMessage("Starting radio...", nullptr);

  loraSPI.begin(PIN_LORA_SCK, PIN_LORA_MISO, PIN_LORA_MOSI, PIN_LORA_NSS);

  int state = radio.begin(LORA_FREQUENCY_MHZ);
  if (state != RADIOLIB_ERR_NONE) {
    Serial.printf("Radio init failed, code %d\n", state);
    showMessage("Radio init FAILED", "check board/wiring");
    while (true) delay(1000);
  }

  // Heltec WiFi LoRa 32 V3 wires the SX1262's DIO2 pin to the antenna TX/RX switch.
  // RadioLib doesn't enable that by default - without this call, begin()/receive()
  // report success but the antenna path is never actually connected.
  radio.setDio2AsRfSwitch(true);

  radio.setBandwidth(LORA_BANDWIDTH_KHZ);
  radio.setSpreadingFactor(LORA_SPREADING_FACTOR);
  radio.setCodingRate(LORA_CODING_RATE);

  // Boosted RX LNA gain mode: a few dB better sensitivity for ~2mA extra current.
  // Worth it here since this board runs off USB power, not battery.
  radio.setRxBoostedGainMode(true);

  // Listen continuously and let DIO1 interrupt us when a packet lands, rather than
  // polling with blocking receive() (which re-arms between calls and leaves gaps where
  // a packet can slip past unheard). startReceive() puts the SX1262 in permanent RX.
  radio.setDio1Action(onPacketReady);
  int rxState = radio.startReceive();
  if (rxState != RADIOLIB_ERR_NONE) {
    Serial.printf("startReceive failed, code %d\n", rxState);
    showMessage("RX start FAILED", "check board/wiring");
    while (true) delay(1000);
  }

  showMessage("Waiting for tank", "signal...");
}

// The tank tops out around 8 ft (~3.5 psi of water column); anything well outside that
// range is a wiring fault or corrupt frame, not real water. Dropping it here keeps a
// bogus reading from ever reaching the pump auto-control on the Pi. Note this only
// rejects out-of-range values - it cannot detect a sensor stuck reading a
// plausible-but-wrong level, which is why the Pi still enforces max-runtime
// and a physical float switch is the real overflow backstop (see README).
const float MIN_VALID_PSI = -0.2f;
const float MAX_VALID_PSI = 6.0f;

void loop() {
  // Nothing to do until the DIO1 interrupt says a packet arrived.
  if (!packetReady) {
    return;
  }
  packetReady = false;

  TankPacket packet;
  int state = radio.readData((uint8_t *)&packet, sizeof(packet));

  // Grab the length and link metrics for this packet before we re-arm the radio.
  size_t packetLen = radio.getPacketLength();
  float rssi = radio.getRSSI();
  float snr = radio.getSNR();

  // Re-arm for the next packet immediately, so we are listening again while we spend
  // time on the serial print and the (slow, software-I2C) OLED update below.
  radio.startReceive();

  if (state != RADIOLIB_ERR_NONE) {
    Serial.printf("Receive error, code %d\n", state);
    return;
  }

  // Reject anything that is not exactly our struct (stray traffic, truncated frame).
  if (packetLen != sizeof(packet)) {
    Serial.printf("Dropped packet: unexpected length %u\n", (unsigned)packetLen);
    return;
  }

  if (!isfinite(packet.psi) || packet.psi < MIN_VALID_PSI || packet.psi > MAX_VALID_PSI) {
    Serial.printf("Dropped packet: psi out of range (%.2f)\n", packet.psi);
    return;
  }

  float feet = packet.psi * FEET_PER_PSI;

  Serial.printf(
    "{\"tower\":\"%s\",\"feet\":%.2f,\"psi\":%.2f,\"battery\":%.2f,\"rssi\":%.1f,\"snr\":%.1f,\"seq\":%lu}\n",
    TOWER_NAME, feet, packet.psi, packet.batteryVolts, rssi, snr, (unsigned long)packet.seq
  );

  showReading(feet, packet.psi, rssi, snr, packet.seq);
}
