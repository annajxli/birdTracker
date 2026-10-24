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

// Pico only: a watchdog reboots the board if it hangs (so it can still take uploads without
// BOOTSEL); long loops call feed(). setup() reports a watchdog reboot.
inline void feed() {
#if defined(ARDUINO_ARCH_RP2040)
  rp2040.wdt_reset();
#endif
}

bool micStalled = false;  // set when samples stop arriving; see record()

// Fill `out` with n raw 32-bit left-channel samples. Blocks until they arrive (on the Pico,
// gives up after half a second and sets micStalled, rather than hanging the board).
void micRead(int32_t *out, size_t n) {
#if defined(ARDUINO_ARCH_ESP32)
  size_t got = 0;
  while (got < n) got += i2s.readBytes((char *)(out + got), (n - got) * sizeof(int32_t)) / sizeof(int32_t);
#else
  for (size_t k = 0; k < n; k++) {
    uint32_t waited = millis();
    while (i2s.available() < 8) {  // one stereo frame of two 32-bit words
      if (millis() - waited > 500) { micStalled = true; memset(out + k, 0, (n - k) * sizeof(int32_t)); return; }
    }
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
    feed();
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

void printRecorded(uint32_t done, float secs, uint32_t seconds, uint32_t peak, double sumSq) {
  float rmsDb = 20 * log10(sqrt(sumSq / max<uint32_t>(done, 1)) / 32768.0 + 1e-9);
  float peakDb = 20 * log10(peak / 32768.0 + 1e-9);
  Serial.printf("recorded %s: %lu samples in %.2f s (expect %lu s), peak %.1f dBFS, rms %.1f dBFS%s\n",
                lastName, (unsigned long)done, secs, (unsigned long)seconds, peakDb, rmsDb,
                peak >= 32767 ? "  CLIPPED: raise SAMPLE_SHIFT" : "");
}

#if defined(ARDUINO_ARCH_RP2040)
// On the Pico, a flash write while I2S is streaming freezes the board (bench test 1: fine with
// the mic stopped, hangs with it running). So record into RAM, stop the mic, then save.
// 5 s at 32 kHz is 320 KB of the Pico 2's 520 KB, leaving room for wifi and HTTP buffers.
const uint32_t PICO_SECONDS = 5;
static int16_t ramPcm[SAMPLE_RATE * PICO_SECONDS];

bool recordToRam() {
  const uint32_t total = SAMPLE_RATE * PICO_SECONDS;
  static int32_t raw[512];
  micDiscard(SETTLE_SAMPLES);
  utcName(lastName, sizeof lastName);
  digitalWrite(PIN_MARK_REC, HIGH);
  micStalled = false;
  uint32_t started = millis(), done = 0, peak = 0;
  double sumSq = 0;
  while (done < total && !micStalled) {
    size_t n = total - done < 512 ? total - done : 512;
    micRead(raw, n);
    feed();
    for (size_t k = 0; k < n; k++) {
      int16_t v = ramPcm[done + k] = toPcm16(raw[k]);
      peak = max<uint32_t>(peak, abs((int32_t)v));
      sumSq += (double)v * v;
    }
    done += n;
  }
  float secs = (millis() - started) / 1000.0;
  digitalWrite(PIN_MARK_REC, LOW);
  i2s.end();  // no streaming during the flash write
  File f = LittleFS.open(RECORDING, "w");
  bool ok = f;
  if (ok) {
    writeWavHeader(f, done * 2);
    for (uint32_t k = 0; k < done && ok; k += 4096) {
      uint32_t n = done - k < 4096 ? done - k : 4096;
      ok = f.write((uint8_t *)(ramPcm + k), n * 2) == n * 2;
      feed();
    }
    f.close();
  }
  micBegin();
  if (!ok) { Serial.println("! couldn't save the recording to flash"); return false; }
  printRecorded(done, secs, PICO_SECONDS, peak, sumSq);
  return done == total;
}
#endif

bool record() {
#if defined(ARDUINO_ARCH_RP2040)
  return recordToRam();
#endif
  const uint32_t total = SAMPLE_RATE * RECORD_SECONDS;
  static int32_t raw[512];
  static int16_t pcm[512];

  // Progress marks, flushed, so a hang shows which step it stopped at.
  auto mark = [](const char *what) { Serial.printf("  %s\n", what); Serial.flush(); };
  mark("record: settling mic");
  micDiscard(SETTLE_SAMPLES);
  utcName(lastName, sizeof lastName);
  mark("record: opening flash file");
  File f = LittleFS.open(RECORDING, "w");
  if (!f) { Serial.println("! can't open flash file (is LittleFS set up?)"); return false; }
  writeWavHeader(f, total * 2);
  mark("record: recording");

  digitalWrite(PIN_MARK_REC, HIGH);
  micStalled = false;
  uint32_t started = millis(), done = 0, peak = 0;
  double sumSq = 0;
  while (done < total) {
    size_t n = total - done < 512 ? total - done : 512;
    micRead(raw, n);
    feed();
    if (micStalled) {
      Serial.printf("! mic stopped delivering after %lu samples (%.2f s); a flash write blocked I2S?\n",
                    (unsigned long)done, (millis() - started) / 1000.0);
      break;
    }
    for (size_t k = 0; k < n; k++) {
      pcm[k] = toPcm16(raw[k]);
      uint32_t a = abs((int32_t)pcm[k]);
      if (a > peak) peak = a;
      sumSq += (double)pcm[k] * pcm[k];
    }
    if (f.write((uint8_t *)pcm, n * 2) != n * 2) { Serial.println("! flash full"); break; }
    if (done / SAMPLE_RATE != (done + n) / SAMPLE_RATE) Serial.printf("  %lu s\n", (unsigned long)((done + n) / SAMPLE_RATE));
    done += n;
  }
  digitalWrite(PIN_MARK_REC, LOW);
  f.close();

  printRecorded(done, (millis() - started) / 1000.0, RECORD_SECONDS, peak, sumSq);
  return done == total;
}

// ---- network --------------------------------------------------------------

bool wifiUp() {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 20000) { delay(200); feed(); }
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
  while (time(nullptr) < 1700000000 && millis() - started < 15000) { delay(200); feed(); }
  Serial.println(time(nullptr) < 1700000000 ? "! clock not set (NTP)" : "clock set from NTP");
}

#if defined(ARDUINO_ARCH_RP2040)
// arduino-pico's HTTPClient gave up a few KB into the file (HTTP -3) whenever the TCP send
// buffer filled, so on the Pico write the request by hand and wait out short writes.
int postFile(File &f, size_t bytes) {
  String hostPort = String(RECEIVER_URL).substring(7);  // after "http://"
  int colon = hostPort.indexOf(':');
  String host = hostPort.substring(0, colon);
  WiFiClient c;
  if (!c.connect(host.c_str(), hostPort.substring(colon + 1).toInt())) return -1;
  c.printf("POST /upload?name=%s HTTP/1.1\r\nHost: %s\r\nX-Token: %s\r\n"
           "Content-Type: application/octet-stream\r\nContent-Length: %u\r\nConnection: close\r\n\r\n",
           lastName, hostPort.c_str(), RECEIVER_TOKEN, (unsigned)bytes);
  static uint8_t buf[2048];
  for (size_t sent = 0; sent < bytes;) {
    size_t n = f.read(buf, min(sizeof buf, bytes - sent));
    if (!n) return -5;  // file shorter than it said
    uint32_t lastProgress = millis();
    for (size_t off = 0; off < n;) {
      size_t w = c.write(buf + off, n - off);
      if (w) { off += w; lastProgress = millis(); }
      else if (!c.connected() || millis() - lastProgress > 10000) return -3;
      else delay(2);
      feed();
    }
    sent += n;
  }
  uint32_t waited = millis();
  while (!c.available() && c.connected() && millis() - waited < 10000) { delay(5); feed(); }
  String status = c.readStringUntil('\n');  // "HTTP/1.0 201 Created"
  c.stop();
  return status.startsWith("HTTP/") ? status.substring(9, 12).toInt() : -4;
}
#endif

bool upload() {
  if (!lastName[0]) { Serial.println("! nothing recorded yet"); return false; }
  if (!wifiUp()) return false;
  File f = LittleFS.open(RECORDING, "r");
  if (!f) { Serial.println("! no recording in flash"); return false; }

  digitalWrite(PIN_MARK_UP, HIGH);
  uint32_t started = millis();
  size_t bytes = f.size();
#if defined(ARDUINO_ARCH_RP2040)
  int code = postFile(f, bytes);
#else
  HTTPClient http;
  http.begin(String(RECEIVER_URL) + "/upload?name=" + lastName);
  http.addHeader("X-Token", RECEIVER_TOKEN);
  http.addHeader("Content-Type", "application/octet-stream");
  http.setTimeout(30000);
  int code = http.sendRequest("POST", &f, bytes);
  http.end();
#endif
  uint32_t ms = millis() - started;
  digitalWrite(PIN_MARK_UP, LOW);
  f.close();

  Serial.printf("upload %s: HTTP %d, %u bytes in %lu ms (%.0f kbit/s)\n", lastName, code, (unsigned)bytes,
                (unsigned long)ms, bytes * 8.0 / max<uint32_t>(ms, 1));
  return code == 201;
}

// ---- commands -------------------------------------------------------------

void levelMeter() {
  static int32_t raw[800];  // 25 ms at 32 kHz
  micDiscard(SETTLE_SAMPLES);
  Serial.println("level meter for 10 s (clap or whistle near the mic)");
  for (int block = 0; block < 400; block++) {
    micRead(raw, 800);
    feed();
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
  Serial.println("commands: l = level meter, r = record + upload, u = upload again, i = info, f = format flash,");
  Serial.println("          s = stop mic, m = start mic, w = wifi off (to test what a flash write conflicts with)");
#if defined(ARDUINO_ARCH_RP2040)
  if (rp2040.getResetReason() == RP2040::WDT_RESET) Serial.println("! rebooted by the watchdog: the last command hung");
  rp2040.wdt_begin(15000);
#endif
}

void loop() {
  feed();
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
    case 'f':  // erase the filesystem, so the next recording writes to pre-erased flash
      Serial.println("formatting flash fs..."); Serial.flush();
      Serial.println(LittleFS.format() && LittleFS.begin() ? "flash fs formatted" : "! format failed");
      break;
    case 's':
#if defined(ARDUINO_ARCH_RP2040)
      i2s.end();
#endif
      Serial.println("mic stopped");
      break;
    case 'm': Serial.println(micBegin() ? "mic started" : "! mic failed to start"); break;
    case 'w': WiFi.disconnect(true); WiFi.mode(WIFI_OFF); Serial.println("wifi off"); break;
  }
}
