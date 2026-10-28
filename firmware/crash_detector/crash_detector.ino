#include <Arduino_BMI270_BMM150.h>
#include <ArduinoBLE.h>
#include <Wire.h>
#include <math.h>
#include "model_data.h"

const bool LOG_WINDOWS = false;        // true: also print each event window, for recording
const bool WAIT_FOR_SERIAL = true;     // false: run without a computer attached

const int FS = 100;
const int WINDOW = 200;
const int HALF = 100;
const unsigned long INTERVAL_MS = 10;
const float ACC_SCALE = 4.0f;          // set so a flat board reads 1.0 g
const float TRIGGER_JERK = 40.0f;      // g/s, below the 1st percentile of crashes
const int COOLDOWN_SAMPLES = 500;      // 5 s

BLEService crashService("19B10000-E8F2-537E-4F6C-D104768A1214");
BLECharacteristic alertChar("19B10001-E8F2-537E-4F6C-D104768A1214", BLERead | BLENotify, 2);

float accBuf[WINDOW];
float gyroBuf[WINDOW];
int head = 0;
float prevAccMag = 1.0f;
float lastAx = 0, lastAy = 0, lastAz = 1, lastGx = 0, lastGy = 0, lastGz = 0;
int samplesLeft = 0;
int cooldown = 0;
unsigned long lastTime = 0;
unsigned long lastHello = 0;
unsigned long ledOffAt = 0;
uint8_t alertCount = 0;


float meanOf(const float* x, int n) {
  float sum = 0;
  for (int i = 0; i < n; i++) sum += x[i];
  return sum / n;
}

float stdOf(const float* x, int n) {
  float m = meanOf(x, n);
  float sum = 0;
  for (int i = 0; i < n; i++) sum += (x[i] - m) * (x[i] - m);
  return sqrtf(sum / n);
}

void computeFeatures(const float* a, const float* w, float* f) {
  float aMax = a[0], aMin = a[0], wMax = w[0], jerkMax = 0, rms = 0;
  for (int i = 0; i < WINDOW; i++) {
    aMax = fmaxf(aMax, a[i]);
    aMin = fminf(aMin, a[i]);
    wMax = fmaxf(wMax, w[i]);
    rms += (a[i] - 1.0f) * (a[i] - 1.0f);
    if (i > 0) jerkMax = fmaxf(jerkMax, fabsf(a[i] - a[i - 1]) * FS);
  }
  f[0] = aMax;
  f[1] = aMin;
  f[2] = meanOf(a, WINDOW);
  f[3] = stdOf(a, WINDOW);
  f[4] = sqrtf(rms / WINDOW);
  f[5] = jerkMax;
  f[6] = wMax;
  f[7] = meanOf(w, WINDOW);
  f[8] = stdOf(w, WINDOW);
  f[9] = stdOf(a + WINDOW - 50, 50);
  f[10] = meanOf(w + WINDOW - 50, 50);
}

void dense(const float* in, int nIn, const float* W, const float* b, float* out, int nOut, bool relu) {
  for (int j = 0; j < nOut; j++) {
    float sum = b[j];
    for (int i = 0; i < nIn; i++) sum += in[i] * W[i * nOut + j];
    out[j] = relu ? fmaxf(sum, 0.0f) : sum;
  }
}

float predict(const float* features) {
  float x[N_FEATURES], h1[16], h2[8], out[1];
  for (int i = 0; i < N_FEATURES; i++) x[i] = (features[i] - MEAN[i]) / STD[i];
  dense(x, N_FEATURES, W1, BIAS1, h1, 16, true);
  dense(h1, 16, W2, BIAS2, h2, 8, true);
  dense(h2, 8, W3, BIAS3, out, 1, false);
  return 1.0f / (1.0f + expf(-out[0]));
}

void selfTest() {
  for (int k = 0; k < 2; k++) {
    float a[WINDOW], w[WINDOW], f[N_FEATURES];
    for (int i = 0; i < WINDOW; i++) {
      a[i] = TEST_WINDOWS[k * WINDOW * 2 + 2 * i];
      w[i] = TEST_WINDOWS[k * WINDOW * 2 + 2 * i + 1];
    }
    computeFeatures(a, w, f);
    float maxDiff = 0;
    for (int i = 0; i < N_FEATURES; i++) {
      maxDiff = fmaxf(maxDiff, fabsf(f[i] - TEST_FEATURES[k * N_FEATURES + i]));
    }
    Serial.print("selftest ");
    Serial.print(k);
    Serial.print(": prob C++ ");
    Serial.print(predict(f), 4);
    Serial.print(" | python ");
    Serial.print(TEST_PROB[k], 4);
    Serial.print(" | max feature diff ");
    Serial.println(maxDiff, 5);
  }
}

void sendAlert(float p) {
  uint8_t payload[2] = {++alertCount, (uint8_t)(p * 100.0f)};  // [alert number, probability in %]
  alertChar.writeValue(payload, 2);
}

void classifyLastWindow() {
  float a[WINDOW], w[WINDOW], f[N_FEATURES];
  for (int i = 0; i < WINDOW; i++) {
    int idx = (head + i) % WINDOW;  // head is the oldest sample
    a[i] = accBuf[idx];
    w[i] = gyroBuf[idx];
  }
  computeFeatures(a, w, f);
  float p = predict(f);
  Serial.print("event p=");
  Serial.print(p, 3);
  Serial.print(" peak_acc=");
  Serial.print(f[0], 2);
  Serial.println(p >= CRASH_THRESHOLD ? "  >>> CRASH" : "  no crash");
  if (LOG_WINDOWS) {
    Serial.print("EVENT");
    for (int i = 0; i < WINDOW; i++) {
      Serial.print(',');
      Serial.print(a[i], 3);
      Serial.print(',');
      Serial.print(w[i], 2);
    }
    Serial.println();
  }
  if (p >= CRASH_THRESHOLD) {
    digitalWrite(LED_BUILTIN, HIGH);
    ledOffAt = millis() + 3000;
    sendAlert(p);
  }
}

void setup() {
  Serial.begin(115200);
  if (WAIT_FOR_SERIAL) {
    while (!Serial);  // wait until the Serial Monitor is open
  } else {
    while (!Serial && millis() < 3000);
  }
  Serial.println("boot");
  pinMode(LED_BUILTIN, OUTPUT);
  if (!IMU.begin()) {
    Serial.println("IMU failed");
    while (1);
  }
  // BMI270 ACC_RANGE register: +-16 g (library default is +-4 g)
  Wire1.beginTransmission(0x68);
  Wire1.write(0x41);
  Wire1.write(0x03);
  Wire1.endTransmission();

  if (!BLE.begin()) {
    Serial.println("BLE failed");
    while (1);
  }
  BLE.setLocalName("CrashDetector");
  BLE.setAdvertisedService(crashService);
  crashService.addCharacteristic(alertChar);
  BLE.addService(crashService);
  BLE.advertise();

  selfTest();
}

void loop() {
  BLE.poll();
  unsigned long now = millis();

  if (now - lastHello > 2000) {
    lastHello = now;
    Serial.println("alive");
  }

  if (ledOffAt && now > ledOffAt) {
    digitalWrite(LED_BUILTIN, LOW);
    ledOffAt = 0;
  }

  if (now - lastTime < INTERVAL_MS) return;
  lastTime = now;

  float ax, ay, az, gx, gy, gz;
  if (IMU.accelerationAvailable()) {
    IMU.readAcceleration(ax, ay, az);
    lastAx = ax * ACC_SCALE;
    lastAy = ay * ACC_SCALE;
    lastAz = az * ACC_SCALE;
  }
  if (IMU.gyroscopeAvailable()) {
    IMU.readGyroscope(gx, gy, gz);
    lastGx = roundf(gx);  // same rounding as in training
    lastGy = roundf(gy);
    lastGz = roundf(gz);
  }

  float accMag = sqrtf(lastAx * lastAx + lastAy * lastAy + lastAz * lastAz);
  float gyroMag = sqrtf(lastGx * lastGx + lastGy * lastGy + lastGz * lastGz);
  accBuf[head] = accMag;
  gyroBuf[head] = gyroMag;
  head = (head + 1) % WINDOW;

  float jerk = fabsf(accMag - prevAccMag) * FS;
  prevAccMag = accMag;

  if (cooldown > 0) {
    cooldown--;
    return;
  }
  if (samplesLeft == 0 && jerk > TRIGGER_JERK) samplesLeft = HALF;
  if (samplesLeft > 0 && --samplesLeft == 0) {
    classifyLastWindow();
    cooldown = COOLDOWN_SAMPLES;
  }
}
