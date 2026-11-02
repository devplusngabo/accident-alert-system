// CrashAllert Phase A firmware: threshold detector + BLE protocol (see build spec section 3)
#include <ArduinoBLE.h>
#define IMU_REV 1   // 1 = LSM9DS1 (Nano 33 BLE Rev1), 2 = BMI270 (Rev2). Set this to match your board.
#if IMU_REV == 1
  #include <Arduino_LSM9DS1.h>
  #include <Wire.h>
#else
  #include <Arduino_BMI270_BMM150.h>
#endif

// ---- Config: tune with real recordings ----
const float CRASH_G = 3.5, BUMP_G = 1.8, SEV2_G = 4.0, SEV3_G = 8.0;
const unsigned long BLOCK_MS = 200, CRASH_COOLDOWN_MS = 10000, MINOR_COOLDOWN_MS = 1000, LED_MS = 1000, HB_MS = 1000;
const uint8_t FLAG_SAT = 1, FLAG_TEST = 2;

const char* SVC = "19b10010-e8f2-537e-4f6c-d104768a1214";
BLEService svc(SVC);
BLECharacteristic evtChar("19b10011-e8f2-537e-4f6c-d104768a1214", BLERead | BLENotify, 14);
BLEUnsignedLongCharacteristic hbChar("19b10012-e8f2-537e-4f6c-d104768a1214", BLERead | BLENotify);
BLEByteCharacteristic cmdChar("19b10013-e8f2-537e-4f6c-d104768a1214", BLEWrite);

float accScale = 1.0, fullScaleG = 4.0;   // library default is +-4 g
float peak = 0; bool sat = false;
unsigned long blockStart = 0, lastCrash = 0, lastMinor = 0, ledOff = 0, lastHb = 0;
bool haveCrash = false;
uint16_t seq = 0;

void onDisconnect(BLEDevice) { BLE.advertise(); }

void sendEvent(uint8_t cls, uint8_t sev, float peakG, float conf, uint8_t flags) {
  uint8_t b[14]; uint16_t p = (uint16_t)constrain(peakG * 100.0, 0, 65535), c = (uint16_t)constrain(conf * 1000.0, 0, 1000);
  uint32_t ms = millis();
  b[0] = 1; b[1] = cls; b[2] = sev; b[3] = flags;
  b[4] = p & 0xFF; b[5] = p >> 8; b[6] = c & 0xFF; b[7] = c >> 8;
  b[8] = ms & 0xFF; b[9] = (ms >> 8) & 0xFF; b[10] = (ms >> 16) & 0xFF; b[11] = (ms >> 24) & 0xFF;
  b[12] = seq & 0xFF; b[13] = seq >> 8; seq++;
  evtChar.writeValue(b, 14);
  if (cls == 3) { digitalWrite(LED_BUILTIN, HIGH); ledOff = millis() + LED_MS; }
}

uint8_t severityFor(float g, bool saturated) { return (saturated || g >= SEV3_G) ? 3 : (g >= SEV2_G ? 2 : 1); }

void setup() {
  Serial.begin(115200);                       // no while(!Serial): must run without a computer
  pinMode(LED_BUILTIN, OUTPUT);
  if (!IMU.begin() || !BLE.begin()) { while (1) { digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN)); delay(100); } }
#if IMU_REV == 1
  // Rev1: raise accelerometer range from +-4 g to +-16 g (CTRL_REG6_XL = 0x68, 119 Hz).
  // The library still scales for 4 g, so multiply readings by 4. VERIFY against the datasheet and Serial output.
  Wire1.beginTransmission(0x6B); Wire1.write(0x20); Wire1.write(0x68);
  if (Wire1.endTransmission() == 0) { accScale = 4.0; fullScaleG = 16.0; }
#endif
  Serial.print("Accel range +-"); Serial.print(fullScaleG); Serial.println(" g");
  BLE.setLocalName("CrashAllert"); BLE.setAdvertisedService(svc);
  svc.addCharacteristic(evtChar); svc.addCharacteristic(hbChar); svc.addCharacteristic(cmdChar);
  BLE.addService(svc); BLE.setEventHandler(BLEDisconnected, onDisconnect);
  hbChar.writeValue((uint32_t)0); BLE.advertise();
  blockStart = millis();
}

void loop() {
  BLE.poll();
  unsigned long now = millis();
  if (IMU.accelerationAvailable()) {
    float x, y, z; IMU.readAcceleration(x, y, z);
    x *= accScale; y *= accScale; z *= accScale;
    float m = sqrt(x * x + y * y + z * z);
    if (m > peak) peak = m;
    if (fabs(x) >= 0.98 * fullScaleG || fabs(y) >= 0.98 * fullScaleG || fabs(z) >= 0.98 * fullScaleG) sat = true;
  }
  if (now - blockStart >= BLOCK_MS) {         // evaluate every 200 ms block
    uint8_t fl = sat ? FLAG_SAT : 0;
    if (peak >= CRASH_G) {
      if (!haveCrash || now - lastCrash >= CRASH_COOLDOWN_MS) { sendEvent(3, severityFor(peak, sat), peak, 0.9, fl); lastCrash = now; haveCrash = true; }
    } else if (peak >= BUMP_G && now - lastMinor >= MINOR_COOLDOWN_MS) {
      sendEvent(1, 1, peak, 0.9, fl); lastMinor = now;
    }
    peak = 0; sat = false; blockStart = now;
  }
  if (cmdChar.written()) {                    // test commands bypass cooldowns
    if (cmdChar.value() == 1) sendEvent(3, 2, 9.4, 1.0, FLAG_TEST);
    else if (cmdChar.value() == 2) sendEvent(1, 1, 2.5, 1.0, FLAG_TEST);
  }
  if (now - lastHb >= HB_MS) { hbChar.writeValue((uint32_t)now); lastHb = now; }
  if (digitalRead(LED_BUILTIN) && now > ledOff) digitalWrite(LED_BUILTIN, LOW);
}
