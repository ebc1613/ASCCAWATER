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

// Sensor is 5 PSI full scale; anything well outside that range is a wiring
// fault or corrupt frame, not real water. Dropping it here keeps a bogus
// reading from ever reaching the pump auto-control on the Pi. Note this only
// rejects out-of-range values - it cannot detect a sensor stuck reading a
// plausible-but-wrong level, which is why the Pi still enforces max-runtime
// and a physical float switch is the real overflow backstop (see README).
const float MIN_VALID_PSI = -0.2f;
const float MAX_VALID_PSI = 6.0f;

void loop() {
  TankPacket packet;

  // Blocks until a packet arrives (no timeout set), which is fine since this
  // node has nothing else to do but listen.
  int state = radio.receive((uint8_t *)&packet, sizeof(packet));

  if (state == RADIOLIB_ERR_RX_TIMEOUT) {
    return;
  }
  if (state != RADIOLIB_ERR_NONE) {
    Serial.printf("Receive error, code %d\n", state);
    return;
  }

  // receive() does not update the length when given a fixed-size buffer, so
  // check the radio's own record of the last packet to reject anything that
  // is not exactly our struct (stray traffic, truncated frame).
  if (radio.getPacketLength() != sizeof(packet)) {
    Serial.printf("Dropped packet: unexpected length %u\n",
                  (unsigned)radio.getPacketLength());
    return;
  }

  if (!isfinite(packet.psi) || packet.psi < MIN_VALID_PSI || packet.psi > MAX_VALID_PSI) {
    Serial.printf("Dropped packet: psi out of range (%.2f)\n", packet.psi);
    return;
  }

  float rssi = radio.getRSSI();
  float snr = radio.getSNR();
  float feet = packet.psi * FEET_PER_PSI;

  Serial.printf(
    "{\"tower\":\"%s\",\"feet\":%.2f,\"psi\":%.2f,\"battery\":%.2f,\"rssi\":%.1f,\"snr\":%.1f,\"seq\":%lu}\n",
    TOWER_NAME, feet, packet.psi, packet.batteryVolts, rssi, snr, (unsigned long)packet.seq
  );
}
