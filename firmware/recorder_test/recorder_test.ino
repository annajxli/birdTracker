// Bench test 1: record from an INMP441 / ICS-43434 I2S mic into flash, then
// upload the WAV to pipeline/receiver.py over wifi. One sketch for both bench
// boards: FireBeetle 2 ESP32-E (Arduino-ESP32 core 3.x) and Raspberry Pi Pico 2 W
// (arduino-pico core). Test plan and wiring: docs/bench-test-1.md.
//
// Serial commands (115200 baud):
//   l  level meter: peak and RMS for 10 s (is the mic alive? how loud?)
//   r  record RECORD_SECONDS and upload
//   u  upload the last recording again
//   i  info: wifi, time, free flash
//
// Two "marker" pins go high while recording / uploading, for the scope now and
// the PPK2's logic inputs later.

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <time.h>
#include "secrets.h"  // copy secrets.example.h to secrets.h and fill it in

// ---- settings -------------------------------------------------------------
const uint32_t SAMPLE_RATE = 32000;    // covers BirdNET's 0-15 kHz
const uint32_t RECORD_SECONDS = 10;    // ~640 KB of WAV; flash holds one at a time
const uint32_t REPEAT_SECONDS = 0;     // >0: record + upload automatically this often
const int SAMPLE_SHIFT = 14;           // 24-bit mic sample -> 16-bit; 16 = no gain, 14 = +12 dB
const uint32_t SETTLE_SAMPLES = 8192;  // discard the mic's first ~0.25 s after start-up
const char *RECORDING = "/rec.wav";

// ---- pins (GPIO numbers; change to match your wiring) ---------------------
#if defined(ARDUINO_ARCH_ESP32)  // FireBeetle 2 ESP32-E
const int PIN_BCLK = 26;   // mic SCK
const int PIN_WS = 25;     // mic WS
const int PIN_DIN = 34;    // mic SD (input-only pin is fine)
const int PIN_MARK_REC = 14;
const int PIN_MARK_UP = 13;
#include <ESP_I2S.h>
I2SClass i2s;
#elif defined(ARDUINO_ARCH_RP2040)  // Pico 2 W
const int PIN_BCLK = 16;   // mic SCK; WS must be the next pin (GP17)
const int PIN_DIN = 18;    // mic SD
const int PIN_MARK_REC = 14;
const int PIN_MARK_UP = 15;
#include <I2S.h>
I2S i2s(INPUT);
#else
#error "Built for ESP32 (FireBeetle) or RP2040/RP2350 (Pico 2 W)"
#endif

char lastName[32] = "";

// ---- mic ------------------------------------------------------------------

bool micBegin() {
#if defined(ARDUINO_ARCH_ESP32)
  i2s.setPins(PIN_BCLK, PIN_WS, -1, PIN_DIN);
  // INMP441 with L/R tied to ground sends 24-bit samples in the left half of 32-bit slots.
  return i2s.begin(I2S_MODE_STD, SAMPLE_RATE, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO, I2S_STD_SLOT_LEFT);
#else
  i2s.setBCLK(PIN_BCLK);  // LRCLK/WS is always BCLK + 1 on arduino-pico
  i2s.setDATA(PIN_DIN);
  i2s.setBitsPerSample(32);
  i2s.setFrequency(SAMPLE_RATE);
  return i2s.begin();
#endif
}

// Fill `out` with n raw 32-bit left-channel samples. Blocks until they arrive.
void micRead(int32_t *out, size_t n) {
#if defined(ARDUINO_ARCH_ESP32)
  size_t got = 0;
  while (got < n) got += i2s.readBytes((char *)(out + got), (n - got) * sizeof(int32_t)) / sizeof(int32_t);
#else
  for (size_t k = 0; k < n; k++) {
    int32_t left, right;
    i2s.read32(&left, &right);
    out[k] = left;
  }
#endif
}

inline int16_t toPcm16(int32_t raw) {
  int32_t v = raw >> SAMPLE_SHIFT;
  return v > 32767 ? 32767 : v < -32768 ? -32768 : (int16_t)v;
}

void micDiscard(uint32_t samples) {
  static int32_t scratch[256];
  while (samples) {
    size_t n = samples < 256 ? samples : 256;
    micRead(scratch, n);
    samples -= n;
  }
}

// ---- recording ------------------------------------------------------------

void writeWavHeader(File &f, uint32_t dataBytes) {
  auto u32 = [&](uint32_t v) { f.write((uint8_t *)&v, 4); };  // both chips are little-endian
  auto u16 = [&](uint16_t v) { f.write((uint8_t *)&v, 2); };
  f.write((const uint8_t *)"RIFF", 4); u32(36 + dataBytes);
  f.write((const uint8_t *)"WAVEfmt ", 8); u32(16);
  u16(1); u16(1); u32(SAMPLE_RATE); u32(SAMPLE_RATE * 2); u16(2); u16(16);  // PCM, mono, 16-bit
  f.write((const uint8_t *)"data", 4); u32(dataBytes);
}

// UTC start time as the file name analyzer.py expects, e.g. 20261024T151200Z.wav
void utcName(char *out, size_t len) {
  time_t now = time(nullptr);
  struct tm t;
  gmtime_r(&now, &t);
  strftime(out, len, "%Y%m%dT%H%M%SZ.wav", &t);
}

bool record() {
  const uint32_t total = SAMPLE_RATE * RECORD_SECONDS;
  static int32_t raw[512];
  static int16_t pcm[512];

  micDiscard(SETTLE_SAMPLES);
  utcName(lastName, sizeof lastName);
  File f = LittleFS.open(RECORDING, "w");
  if (!f) { Serial.println("! can't open flash file (is LittleFS set up?)"); return false; }
  writeWavHeader(f, total * 2);

  digitalWrite(PIN_MARK_REC, HIGH);
  uint32_t started = millis(), done = 0, peak = 0;
  double sumSq = 0;
  while (done < total) {
    size_t n = total - done < 512 ? total - done : 512;
    micRead(raw, n);
    for (size_t k = 0; k < n; k++) {
      pcm[k] = toPcm16(raw[k]);
      uint32_t a = abs((int32_t)pcm[k]);
      if (a > peak) peak = a;
      sumSq += (double)pcm[k] * pcm[k];
    }
    if (f.write((uint8_t *)pcm, n * 2) != n * 2) { Serial.println("! flash full"); break; }
    done += n;
  }
  digitalWrite(PIN_MARK_REC, LOW);
  f.close();

  float secs = (millis() - started) / 1000.0;
  float rmsDb = 20 * log10(sqrt(sumSq / max<uint32_t>(done, 1)) / 32768.0 + 1e-9);
  float peakDb = 20 * log10(peak / 32768.0 + 1e-9);
  Serial.printf("recorded %s: %lu samples in %.2f s (expect %lu s), peak %.1f dBFS, rms %.1f dBFS%s\n",
                lastName, (unsigned long)done, secs, (unsigned long)RECORD_SECONDS, peakDb, rmsDb,
                peak >= 32767 ? "  CLIPPED: raise SAMPLE_SHIFT" : "");
  return done == total;
}

// ---- network --------------------------------------------------------------

bool wifiUp() {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 20000) delay(200);
  if (WiFi.status() != WL_CONNECTED) { Serial.println("! wifi didn't connect"); return false; }
  Serial.printf("wifi up in %lu ms, %s, RSSI %d dBm\n", (unsigned long)(millis() - started),
                WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
  return true;
}

void syncClock() {
#if defined(ARDUINO_ARCH_ESP32)
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
#else
  NTP.begin("pool.ntp.org", "time.nist.gov");
#endif
  uint32_t started = millis();
  while (time(nullptr) < 1700000000 && millis() - started < 15000) delay(200);
  Serial.println(time(nullptr) < 1700000000 ? "! clock not set (NTP)" : "clock set from NTP");
}

bool upload() {
  if (!lastName[0]) { Serial.println("! nothing recorded yet"); return false; }
  if (!wifiUp()) return false;
  File f = LittleFS.open(RECORDING, "r");
  if (!f) { Serial.println("! no recording in flash"); return false; }

  String url = String(RECEIVER_URL) + "/upload?name=" + lastName;
  HTTPClient http;
  http.begin(url);
  http.addHeader("X-Token", RECEIVER_TOKEN);
  http.addHeader("Content-Type", "application/octet-stream");
  http.setTimeout(30000);

  digitalWrite(PIN_MARK_UP, HIGH);
  uint32_t started = millis();
  size_t bytes = f.size();
  int code = http.sendRequest("POST", &f, bytes);
  uint32_t ms = millis() - started;
  digitalWrite(PIN_MARK_UP, LOW);

  Serial.printf("upload %s: HTTP %d, %u bytes in %lu ms (%.0f kbit/s) %s\n", lastName, code, (unsigned)bytes,
                (unsigned long)ms, bytes * 8.0 / max<uint32_t>(ms, 1), code > 0 ? http.getString().c_str() : "");
  http.end();
  f.close();
  return code == 201;
}

// ---- commands -------------------------------------------------------------

void levelMeter() {
  static int32_t raw[800];  // 25 ms at 32 kHz
  micDiscard(SETTLE_SAMPLES);
  Serial.println("level meter for 10 s (clap or whistle near the mic)");
  for (int block = 0; block < 400; block++) {
    micRead(raw, 800);
    uint32_t peak = 0;
    double sumSq = 0;
    for (int k = 0; k < 800; k++) {
      int16_t s = toPcm16(raw[k]);
      peak = max<uint32_t>(peak, abs((int32_t)s));
      sumSq += (double)s * s;
    }
    if (block % 10 == 0) {  // print every 0.25 s
      float rms = 20 * log10(sqrt(sumSq / 800) / 32768.0 + 1e-9);
      int bars = constrain((int)((rms + 90) / 2), 0, 45);
      Serial.printf("rms %6.1f dBFS  peak %5lu  |%.*s\n", rms, (unsigned long)peak, bars,
                    "#############################################");
    }
  }
}

void info() {
  time_t now = time(nullptr);
  Serial.printf("wifi %s, RSSI %d dBm, time %s", WiFi.status() == WL_CONNECTED ? "up" : "down",
                (int)WiFi.RSSI(), ctime(&now));
#if defined(ARDUINO_ARCH_ESP32)
  Serial.printf("flash fs: %u of %u bytes used\n", (unsigned)LittleFS.usedBytes(), (unsigned)LittleFS.totalBytes());
#else
  FSInfo fs;
  LittleFS.info(fs);
  Serial.printf("flash fs: %u of %u bytes used\n", (unsigned)fs.usedBytes, (unsigned)fs.totalBytes);
#endif
}

void setup() {
  Serial.begin(115200);
  uint32_t started = millis();
  while (!Serial && millis() - started < 3000) delay(10);  // wait briefly for a USB serial monitor
  pinMode(PIN_MARK_REC, OUTPUT);
  pinMode(PIN_MARK_UP, OUTPUT);
  Serial.println("\nbirdTracker bench test 1");

#if defined(ARDUINO_ARCH_ESP32)
  bool fsOk = LittleFS.begin(true);  // formats on first use
#else
  bool fsOk = LittleFS.begin() || (LittleFS.format() && LittleFS.begin());
#endif
  if (!fsOk) Serial.println("! LittleFS failed (Pico: pick a Flash Size with a filesystem, e.g. 2MB FS)");
  if (!micBegin()) Serial.println("! mic (I2S) failed to start");
  if (wifiUp()) syncClock();
  Serial.println("commands: l = level meter, r = record + upload, u = upload again, i = info");
}

void loop() {
  static uint32_t lastAuto = 0;
  if (REPEAT_SECONDS && millis() - lastAuto >= REPEAT_SECONDS * 1000UL) {
    lastAuto = millis();
    if (record()) upload();
  }
  if (!Serial.available()) { delay(20); return; }
  switch (Serial.read()) {
    case 'l': levelMeter(); break;
    case 'r': if (record()) upload(); break;
    case 'u': upload(); break;
    case 'i': info(); break;
  }
}
