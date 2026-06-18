// Camp ASCCA water tower - well house receiver
//
// Board: Heltec WiFi LoRa 32 V3 (or MakerFocus ESP32 LoRa V3 clone), SX1262, 915 MHz.
// Power/connection: USB cable to the Raspberry Pi. The same USB-serial chip used to
//        flash this sketch is read by server.js as SERIAL_PORT (default /dev/ttyUSB0).
//
// This sketch only listens for LoRa packets from the transmitter and prints one JSON
// line per packet to USB serial, matching the format server.js expects:
//   {"tower":"camp-main","feet":6.8,"psi":2.94,"battery":13.1,"rssi":-108,"snr":-3.5,"seq":1523}
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

// ---- LoRa radio settings - must match the transmitter exactly ----
// 903.9 MHz: low end of the US 902-928 MHz ISM band, for better penetration through
// tree trunks/foliage than the 915 MHz band center.
#define LORA_FREQUENCY_MHZ    903.9
#define LORA_BANDWIDTH_KHZ    125.0
#define LORA_SPREADING_FACTOR 10
#define LORA_CODING_RATE      8

#define TOWER_NAME "camp-main"
const float FEET_PER_PSI = 1.0f / 0.433f; // water column: psi = feet * 0.433

SPIClass loraSPI(HSPI);
Module loraModule(PIN_LORA_NSS, PIN_LORA_DIO1, PIN_LORA_RST, PIN_LORA_BUSY, loraSPI);
SX1262 radio = new Module(loraModule);

struct __attribute__((packed)) TankPacket {
  uint32_t seq;
  float psi;
  float batteryVolts;
};

void setup() {
  Serial.begin(115200);
  delay(100);

  loraSPI.begin(PIN_LORA_SCK, PIN_LORA_MISO, PIN_LORA_MOSI, PIN_LORA_NSS);

  int state = radio.begin(LORA_FREQUENCY_MHZ);
  if (state != RADIOLIB_ERR_NONE) {
    Serial.printf("Radio init failed, code %d\n", state);
    while (true) delay(1000);
  }

  radio.setBandwidth(LORA_BANDWIDTH_KHZ);
  radio.setSpreadingFactor(LORA_SPREADING_FACTOR);
  radio.setCodingRate(LORA_CODING_RATE);
}

void loop() {
  TankPacket packet;
  size_t len = sizeof(packet);

  // Blocks until a packet arrives (no timeout set), which is fine since this
  // node has nothing else to do but listen.
  int state = radio.receive((uint8_t *)&packet, len);

  if (state == RADIOLIB_ERR_NONE && len == sizeof(packet)) {
    float rssi = radio.getRSSI();
    float snr = radio.getSNR();
    float feet = packet.psi * FEET_PER_PSI;

    Serial.printf(
      "{\"tower\":\"%s\",\"feet\":%.2f,\"psi\":%.2f,\"battery\":%.2f,\"rssi\":%.1f,\"snr\":%.1f,\"seq\":%lu}\n",
      TOWER_NAME, feet, packet.psi, packet.batteryVolts, rssi, snr, (unsigned long)packet.seq
    );
  } else if (state != RADIOLIB_ERR_RX_TIMEOUT) {
    Serial.printf("Receive error, code %d\n", state);
  }
}
