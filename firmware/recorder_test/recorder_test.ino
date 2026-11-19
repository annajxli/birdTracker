// Bench test 1: record from an INMP441 / ICS-43434 I2S mic into flash, then
// upload the WAV to pipeline/receiver.py over wifi. One sketch for both bench
// boards: FireBeetle 2 ESP32-E (Arduino-ESP32 core 3.x) and Raspberry Pi Pico 2 W
// (arduino-pico core). Wiring and setup: docs/hardware.md ("Build the bench recorder").
// Bench test 1 plan and results: docs/bench-test-1.md.
//
// Serial commands (115200 baud):
//   l  level meter: peak and RMS for 10 s (is the mic alive? how loud?)
//   r  record RECORD_SECONDS and upload
//   u  upload the last recording again
//   i  info: wifi, time, free flash
//   c  stream continuously to the receiver (FireBeetle only); c again stops
//
// The FireBeetle updates itself from the receiver over wifi: see "over-the-air updates" below.
//
// With STREAM_ON_BOOT the FireBeetle streams unattended once it has Wi-Fi and the time: a mic
// task fills a RAM ring buffer (to ride out Wi-Fi hiccups) and loop() sends it to the receiver.
//
// Two "marker" pins go high while recording / uploading, for a scope or the PPK2's logic inputs.

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
const float HIGHPASS_HZ = 200;         // cut wind and traffic rumble (and the mic's DC offset) below birdsong
const uint32_t SETTLE_SAMPLES = 8192;  // discard the mic's first ~0.25 s after start-up
const char *RECORDING = "/rec.wav";
const bool STREAM_ON_BOOT = true;            // FireBeetle: start streaming without a serial command
const uint32_t STREAM_RECONNECT_SECONDS = 3600;  // reconnect hourly to re-anchor the sample clock to NTP
const uint32_t MIC_STALL_SECONDS = 5;        // FireBeetle: reboot if the mic delivers nothing for this long
const uint32_t WATCHDOG_SECONDS = 30;        // FireBeetle: longer than any blocking step between feed() calls

// ---- pins (GPIO numbers; change to match your wiring) ---------------------
#if defined(ARDUINO_ARCH_ESP32)  // FireBeetle 2 ESP32-E
const int PIN_BCLK = 26;   // mic SCK
const int PIN_WS = 25;     // mic WS
const int PIN_DIN = 34;    // mic SD (input-only pin is fine)
const int PIN_MARK_REC = 14;
const int PIN_MARK_UP = 13;
#include <ESP_I2S.h>
#include <esp_task_wdt.h>
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

// A watchdog reboots the board if it hangs (on the Pico, so it can still take uploads without
// BOOTSEL; on the FireBeetle, so it recovers unattended); long loops call feed(). On the FireBeetle
// it watches the loop task and the mic task, and only the loop task calls feed().
inline void feed() {
#if defined(ARDUINO_ARCH_RP2040)
  rp2040.wdt_reset();
#else
  esp_task_wdt_reset();
#endif
}

bool micStalled = false;
bool streaming = false;  // set when samples stop arriving; see record()

// Fill `out` with n raw 32-bit left-channel samples. Blocks until they arrive (on the Pico,
// gives up after half a second and sets micStalled, rather than hanging the board).
void micRead(int32_t *out, size_t n) {
#if defined(ARDUINO_ARCH_ESP32)
  size_t got = 0;
  uint32_t waited = millis();
  while (got < n) {
    size_t r = i2s.readBytes((char *)(out + got), (n - got) * sizeof(int32_t)) / sizeof(int32_t);
    if (r) { got += r; waited = millis(); continue; }
    if (millis() - waited > MIC_STALL_SECONDS * 1000UL) {
      Serial.println("! mic stopped delivering; rebooting");
      Serial.flush();
      ESP.restart();
    }
    delay(1);
  }
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

// A 2nd-order Butterworth high-pass (RBJ biquad, transposed direct form II) at HIGHPASS_HZ.
// One filter for the mic: only one of streaming, recording and the level meter runs at a time.
struct Highpass {
  float b0, b1, b2, a1, a2, z1 = 0, z2 = 0;
  Highpass(float hz, float rate) {
    float w = 2 * PI * hz / rate, c = cosf(w), alpha = sinf(w) / (2 * 0.70710678f), a0 = 1 + alpha;
    b0 = (1 + c) / 2 / a0; b1 = -(1 + c) / a0; b2 = b0; a1 = -2 * c / a0; a2 = (1 - alpha) / a0;
  }
  float step(float x) {
    float y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  }
};
Highpass highpass(HIGHPASS_HZ, SAMPLE_RATE);

// Raw 32-bit mic sample -> high-passed 16-bit PCM, with SAMPLE_SHIFT's gain.
inline int16_t toPcm16(int32_t raw) {
  float v = highpass.step((float)raw / (1 << SAMPLE_SHIFT));
  return v > 32767 ? 32767 : v < -32768 ? -32768 : (int16_t)lrintf(v);
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
// On the Pico, a flash write while I2S is streaming freezes the board (bench test 1), so record
// into RAM, stop the mic, then save.
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
#if defined(ARDUINO_ARCH_ESP32)
  // With more than one access point on the network, join the strongest, not the first one found.
  WiFi.setScanMethod(WIFI_ALL_CHANNEL_SCAN);
  WiFi.setSortMethod(WIFI_CONNECT_AP_BY_SIGNAL);
#endif
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
  if (time(nullptr) >= 1700000000) { Serial.println("clock set from NTP"); return; }
#if defined(ARDUINO_ARCH_ESP32)
  if (clockFromReceiver()) return;  // NTP keeps trying, and corrects the clock when it answers
#endif
  Serial.println("! clock not set (NTP)");
}

// RECEIVER_URL is "http://host:port"
void receiverHost(String &host, uint16_t &port, String &hostPort) {
  hostPort = String(RECEIVER_URL).substring(7);  // after "http://"
  int colon = hostPort.indexOf(':');
  host = hostPort.substring(0, colon);
  port = hostPort.substring(colon + 1).toInt();
}

#if defined(ARDUINO_ARCH_RP2040)
// arduino-pico's HTTPClient fails (HTTP -3) when the TCP send buffer fills, so on the Pico
// write the request by hand and wait out short writes.
int postFile(File &f, size_t bytes) {
  String host, hostPort;
  uint16_t port;
  receiverHost(host, port, hostPort);
  WiFiClient c;
  if (!c.connect(host.c_str(), port)) return -1;
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

// ---- streaming (FireBeetle) -----------------------------------------------

#if defined(ARDUINO_ARCH_ESP32)
#include <ESPmDNS.h>
#include <esp_timer.h>
#include <freertos/ringbuf.h>
#include <sys/time.h>
#include <atomic>

// One ring-buffer item; the first 12 bytes plus the samples are sent as-is (little-endian):
// the receiver reads a uint64 index, a uint32 count, then the samples.
const size_t FRAME_SAMPLES = 512;  // 16 ms at 32 kHz
struct Frame {
  uint64_t index;  // samples since streaming started, dropped ones included
  uint32_t count;
  int16_t pcm[FRAME_SAMPLES];
};
const size_t FRAME_HEADER_BYTES = 12;

RingbufHandle_t streamBuf = nullptr;
size_t streamBufBytes = 0;
TaskHandle_t micTask = nullptr;
std::atomic<bool> stampWanted{false}, stampReady{false};
uint64_t stampIndex = 0, stampMs = 0;  // a sample index and the UTC ms it was recorded
uint32_t framesDropped = 0, framesSent = 0, streamConnects = 0;
WiFiClient streamClient;
uint32_t streamConnectedAt = 0, lastStatus = 0, lastConnectTry = 0, lastHealth = 0;
bool healthDue = false;

uint64_t epochMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (uint64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

// Runs at a higher priority than loop(), so the mic keeps being read while loop() waits on wifi.
// When the buffer is full, frames are dropped (their indexes still count, so the receiver sees the gap).
void micTaskLoop(void *) {
  static int32_t raw[FRAME_SAMPLES];
  static Frame fr;
  uint64_t index = 0;
  esp_task_wdt_add(nullptr);
  while (streaming) {
    esp_task_wdt_reset();
    micRead(raw, FRAME_SAMPLES);
    for (size_t k = 0; k < FRAME_SAMPLES; k++) fr.pcm[k] = toPcm16(raw[k]);
    fr.index = index;
    fr.count = FRAME_SAMPLES;
    index += FRAME_SAMPLES;
    if (stampWanted) {  // the frame just finished, so the next sample is being recorded now
      stampIndex = index;
      stampMs = epochMs();
      stampWanted = false;
      stampReady = true;
    }
    if (xRingbufferSend(streamBuf, &fr, FRAME_HEADER_BYTES + FRAME_SAMPLES * 2, 0) != pdTRUE) framesDropped++;
  }
  esp_task_wdt_delete(nullptr);
  micTask = nullptr;
  vTaskDelete(nullptr);
}

bool streamStart() {
  if (!streamBuf) {  // the biggest contiguous block that's free; ~2 s at 128 KB
    for (size_t kb : {128, 96, 64, 32}) {
      if ((streamBuf = xRingbufferCreate(kb * 1024, RINGBUF_TYPE_NOSPLIT))) { streamBufBytes = kb * 1024; break; }
    }
    if (!streamBuf) { Serial.println("! no memory for the stream buffer"); return false; }
  }
  micDiscard(SETTLE_SAMPLES);
  WiFi.setSleep(false);  // modem sleep delays sends until the next beacon; streaming can't afford it
  framesDropped = framesSent = streamConnects = 0;
  streaming = true;
  if (xTaskCreatePinnedToCore(micTaskLoop, "mic", 4096, nullptr, 5, &micTask, 1) != pdPASS) {
    streaming = false;
    Serial.println("! no memory for the mic task");
    return false;
  }
  Serial.printf("streaming to %s (%u KB buffer, %.1f s); c stops\n", RECEIVER_URL, (unsigned)(streamBufBytes / 1024),
                streamBufBytes / (SAMPLE_RATE * 2.0));
  return true;
}

void streamStop() {
  streaming = false;
  while (micTask) delay(10);
  streamClient.stop();
  digitalWrite(PIN_MARK_UP, LOW);
  size_t size;  // empty the buffer
  while (void *item = xRingbufferReceive(streamBuf, &size, 0)) vRingbufferReturnItem(streamBuf, item);
  Serial.printf("streaming stopped: %lu frames sent, %lu dropped\n", (unsigned long)framesSent, (unsigned long)framesDropped);
}

// The receiver's address. A RECEIVER_URL host ending in .local (e.g. the Pi, pio.local) is found
// with mDNS, so the router needs no reservation; the last address found is tried first, and looked
// up again only when it stops answering.
IPAddress receiverIp;
bool resolveReceiver(const String &host, bool fresh) {
  if (receiverIp != IPAddress() && !fresh) return true;
  if (!host.endsWith(".local")) return receiverIp.fromString(host) || WiFi.hostByName(host.c_str(), receiverIp);
  static bool mdnsUp = false;
  if (!mdnsUp) mdnsUp = MDNS.begin("birdtracker-recorder");
  IPAddress ip = MDNS.queryHost(host.substring(0, host.length() - 6), 2000);
  if (ip == IPAddress()) { Serial.printf("! %s not found (mDNS)\n", host.c_str()); return false; }
  if (ip != receiverIp) Serial.printf("%s is %s\n", host.c_str(), ip.toString().c_str());
  receiverIp = ip;
  return true;
}

bool streamConnect() {
  if (millis() - lastConnectTry < 2000) return false;  // don't hammer a receiver that's down
  lastConnectTry = millis();
  if (time(nullptr) < 1700000000) { syncClock(); return false; }  // file names need the time
  if (!wifiUp()) return false;
  String host, hostPort;
  uint16_t port;
  receiverHost(host, port, hostPort);
  if (!resolveReceiver(host, false)) return false;
  if (!streamClient.connect(receiverIp, port, 3000)) {
    if (!resolveReceiver(host, true) || !streamClient.connect(receiverIp, port, 3000)) {  // moved? look it up again
      Serial.println("! receiver not reachable");
      return false;
    }
  }
  streamClient.setNoDelay(true);  // send each 16 ms frame now: the live view wants low latency
  stampReady = false;
  stampWanted = true;
  for (uint32_t t = millis(); !stampReady && millis() - t < 500;) delay(2);
  if (!stampReady) { streamClient.stop(); return false; }
  streamClient.printf("POST /stream HTTP/1.1\r\nHost: %s\r\nX-Token: %s\r\nX-Sample-Rate: %lu\r\n"
                      "X-Index: %llu\r\nX-Epoch-Ms: %llu\r\nX-RSSI: %d\r\nX-AP: %s\r\nContent-Type: application/octet-stream\r\n"
                      "Connection: close\r\n\r\n",
                      hostPort.c_str(), RECEIVER_TOKEN, (unsigned long)SAMPLE_RATE,
                      (unsigned long long)stampIndex, (unsigned long long)stampMs, (int)WiFi.RSSI(), WiFi.BSSIDstr().c_str());
  streamConnectedAt = millis();
  streamConnects++;
  healthDue = true;
  digitalWrite(PIN_MARK_UP, HIGH);
  Serial.printf("stream connected (#%lu), RSSI %d dBm\n", (unsigned long)streamConnects, (int)WiFi.RSSI());
  return true;
}

// No NTP, in an internet outage: take the time from the receiver, which refuses if its own clock
// hasn't synced since it started. Half the round trip stands in for the reply's time on the way.
bool clockFromReceiver() {
  String host, hostPort;
  uint16_t port;
  receiverHost(host, port, hostPort);
  if (!resolveReceiver(host, false)) return false;
  HTTPClient http;
  http.begin("http://" + receiverIp.toString() + ":" + port + "/time");
  http.addHeader("X-Token", RECEIVER_TOKEN);
  http.setTimeout(3000);
  uint32_t asked = millis();
  int code = http.GET();
  uint32_t trip = millis() - asked;
  uint64_t ms = code == 200 ? strtoull(http.getString().c_str(), nullptr, 10) : 0;
  http.end();
  if (ms < 1700000000000ULL || trip > 2000) {
    Serial.printf("! no time from the receiver: HTTP %d, %lu ms\n", code, (unsigned long)trip);
    return false;
  }
  ms += trip / 2;
  struct timeval tv = {(time_t)(ms / 1000), (suseconds_t)(ms % 1000 * 1000)};
  settimeofday(&tv, nullptr);
  Serial.printf("clock set from the receiver, %lu ms round trip\n", (unsigned long)trip);
  return true;
}

// Write it all to the stream, or drop the connection: a partial frame would desync the receiver.
bool streamWrite(const uint8_t *data, size_t len) {
  uint32_t lastProgress = millis();
  for (size_t off = 0; off < len;) {
    size_t w = streamClient.write(data + off, len - off);
    if (w) { off += w; lastProgress = millis(); }
    else if (!streamClient.connected() || millis() - lastProgress > 5000) {
      Serial.println("! stream write failed; reconnecting");
      streamClient.stop();
      return false;
    } else delay(2);
  }
  return true;
}

// The board's own health, sent in the stream as a frame with index UINT64_MAX: its count is the
// length of a text payload in 16-bit words ("temp_c=41.2 uptime_s=5321 rssi_dbm=-61
// frames_sent=... frames_dropped=...", padded with a space to an even length; the frame counts
// run since streaming started). Sent after connecting and then once a minute.
void streamHealth() {
  char text[128];
  int n = snprintf(text, sizeof text - 1, "temp_c=%.1f uptime_s=%llu rssi_dbm=%d frames_sent=%lu frames_dropped=%lu",
                   temperatureRead(), (unsigned long long)(esp_timer_get_time() / 1000000), (int)WiFi.RSSI(),
                   (unsigned long)framesSent, (unsigned long)framesDropped);
  if (n > (int)sizeof text - 2) n = sizeof text - 2;  // snprintf reports what it would have written
  if (n & 1) text[n++] = ' ';
  uint8_t head[FRAME_HEADER_BYTES];
  uint64_t index = UINT64_MAX;
  uint32_t count = n / 2;
  memcpy(head, &index, 8);
  memcpy(head + 8, &count, 4);
  if (!streamWrite(head, sizeof head) || !streamWrite((const uint8_t *)text, n)) return;
  lastHealth = millis();
  healthDue = false;
}

// Called from loop(): keep the connection up and move buffered frames onto it.
void streamPump() {
  if (streamClient.available()) {  // the receiver answers a stream only to refuse it, a bad token say
    Serial.printf("! receiver answered: %s\n", streamClient.readStringUntil('\n').c_str());
    streamClient.stop();
  }
  if (streamClient.connected() && millis() - streamConnectedAt > STREAM_RECONNECT_SECONDS * 1000UL) {
    streamClient.stop();  // the buffer holds the audio while we reconnect
  }
  if (!streamClient.connected()) {
    digitalWrite(PIN_MARK_UP, LOW);
    if (!streamConnect()) { delay(20); return; }
  }
  // Send up to 8 frames per write: one packet per frame can't drain the buffer after a hiccup.
  static uint8_t batch[8 * (FRAME_HEADER_BYTES + FRAME_SAMPLES * 2)];
  size_t used = 0, size;
  int frames = 0;
  while (frames < 8) {
    void *fr = xRingbufferReceive(streamBuf, &size, frames ? 0 : pdMS_TO_TICKS(50));
    if (!fr) break;
    memcpy(batch + used, fr, size);
    vRingbufferReturnItem(streamBuf, fr);
    used += size;
    frames++;
  }
  if (streamWrite(batch, used)) framesSent += frames;
  else framesDropped += frames;
  if (streamClient.connected() && (healthDue || millis() - lastHealth > 60000)) streamHealth();
  if (millis() - lastStatus > 60000) {
    lastStatus = millis();
    Serial.printf("stream: %lu frames sent, %lu dropped, buffer %u%% full, RSSI %d dBm\n",
                  (unsigned long)framesSent, (unsigned long)framesDropped,
                  (unsigned)(100 - 100 * xRingbufferGetCurFreeSize(streamBuf) / streamBufBytes), (int)WiFi.RSSI());
  }
}

// ---- over-the-air updates (FireBeetle) ------------------------------------
// At boot and every OTA_CHECK_SECONDS, ask the receiver for the SHA-256 of its image for this
// board (pipeline/receiver.py, GET /ota/firebeetle.sha256). When it differs from the running
// image's, download the image into the other OTA slot, check its hash, and reboot into it. The new
// image is on trial: it marks itself valid once it has streamed for OTA_CONFIRM_FRAMES and heard
// from the receiver's update check; if it crashes first, or hasn't by OTA_TRIAL_SECONDS, the
// bootloader goes back to the previous image, and that image doesn't fetch the rejected one again.
#include <Update.h>
#include <esp_ota_ops.h>
#include <esp_image_format.h>
#include <mbedtls/sha256.h>

const char *OTA_BOARD = "firebeetle";
const uint32_t OTA_CHECK_SECONDS = 900;
const uint32_t OTA_TRIAL_SECONDS = 600;
const uint32_t OTA_CONFIRM_FRAMES = 60 * SAMPLE_RATE / FRAME_SAMPLES;  // a minute of audio

char runningSha[65] = "", rejectedSha[65] = "";
bool otaTrial = false;    // this image is new and not yet marked valid
bool otaAnswered = false; // the receiver answered an update check since boot
uint32_t lastOtaCheck = 0;

// Arduino-ESP32 marks a new image valid at startup unless this returns true; otaLoop() does it instead.
extern "C" bool verifyRollbackLater() { return true; }

void shaHex(const uint8_t *d, char *hex) {
  for (int i = 0; i < 32; i++) sprintf(hex + 2 * i, "%02x", d[i]);
}

// The SHA-256 of the app image in a partition: the same as its firmware.bin file's. `part` is an
// esp_partition_t; void, because the .ino's generated prototypes come before the ESP32 headers.
bool imageSha(const void *part, char *hex) {
  const esp_partition_t *p = (const esp_partition_t *)part;
  if (!p) return false;
  esp_partition_pos_t pos = {p->address, p->size};
  esp_image_metadata_t meta;
  if (esp_image_get_metadata(&pos, &meta) != ESP_OK) return false;
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);
  static uint8_t buf[4096];
  bool ok = true;
  for (uint32_t off = 0; off < meta.image_len && ok;) {
    uint32_t n = min<uint32_t>(sizeof buf, meta.image_len - off);
    feed();
    ok = esp_partition_read(p, off, buf, n) == ESP_OK;
    mbedtls_sha256_update(&ctx, buf, n);
    off += n;
  }
  uint8_t d[32];
  mbedtls_sha256_finish(&ctx, d);
  mbedtls_sha256_free(&ctx);
  if (ok) shaHex(d, hex);
  return ok;
}

void otaSetup() {
  const esp_partition_t *running = esp_ota_get_running_partition();
  esp_ota_img_states_t state;
  otaTrial = esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY;
  imageSha(running, runningSha);
  Serial.printf("firmware %.12s in %s%s\n", runningSha, running->label, otaTrial ? ", on trial" : "");
  if (imageSha(esp_ota_get_last_invalid_partition(), rejectedSha))
    Serial.printf("! firmware %.12s was rolled back; not installing it again\n", rejectedSha);
}

// Download the image into the other slot, checking its SHA-256 against `want` as it arrives.
bool otaInstall(const String &url, const String &want) {
  HTTPClient http;
  http.begin(url);
  http.addHeader("X-Token", RECEIVER_TOKEN);
  http.setTimeout(15000);
  int code = http.GET(), size = http.getSize();
  if (code != 200 || size <= 0 || !Update.begin(size)) {
    Serial.printf("! firmware download: HTTP %d, %d bytes%s%s\n", code, size, Update.hasError() ? ", " : "",
                  Update.hasError() ? Update.errorString() : "");
    http.end();
    return false;
  }
  digitalWrite(PIN_MARK_UP, HIGH);
  WiFiClient *s = http.getStreamPtr();
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);
  static uint8_t buf[4096];
  int got = 0;
  uint32_t started = millis(), lastProgress = millis();
  while (got < size && millis() - lastProgress < 15000) {
    feed();
    int n = s->read(buf, min<int>(sizeof buf, size - got));
    if (n <= 0) { delay(2); continue; }
    mbedtls_sha256_update(&ctx, buf, n);
    if (Update.write(buf, n) != (size_t)n) break;
    got += n;
    lastProgress = millis();
  }
  http.end();
  digitalWrite(PIN_MARK_UP, LOW);
  uint8_t d[32];
  char hex[65];
  mbedtls_sha256_finish(&ctx, d);
  mbedtls_sha256_free(&ctx);
  shaHex(d, hex);
  if (got < size || want != hex) {
    Serial.printf("! firmware download: %d of %d bytes, SHA-256 %.12s%s\n", got, size, hex,
                  Update.hasError() ? Update.errorString() : got < size ? "" : " (expected another)");
    Update.abort();
    return false;
  }
  if (!Update.end()) { Serial.printf("! firmware install: %s\n", Update.errorString()); return false; }
  Serial.printf("firmware %.12s installed: %d bytes in %lu ms\n", hex, size, (unsigned long)(millis() - started));
  return true;
}

void otaCheck() {
  lastOtaCheck = millis();
  String host, hostPort;
  uint16_t port;
  receiverHost(host, port, hostPort);
  if (!wifiUp() || !resolveReceiver(host, false)) return;
  String base = "http://" + receiverIp.toString() + ":" + port + "/ota/" + OTA_BOARD;
  HTTPClient http;
  http.begin(base + ".sha256");
  http.addHeader("X-Token", RECEIVER_TOKEN);
  http.setTimeout(5000);
  int code = http.GET();
  String want = code == 200 ? http.getString() : "";
  http.end();
  want.trim();
  if (code == 200 || code == 404) otaAnswered = true;  // 404: the receiver has no image
  else Serial.printf("! firmware check: HTTP %d\n", code);
  // On trial, the other slot holds the image to go back to: don't overwrite it.
  if (want.length() != 64 || want == runningSha || want == rejectedSha || otaTrial) return;
  Serial.printf("firmware %.12s available; updating\n", want.c_str());
  bool wasStreaming = streaming;
  if (wasStreaming) streamStop();
  if (otaInstall(base + ".bin", want)) {
    Serial.println("rebooting into the new firmware");
    Serial.flush();
    ESP.restart();
  }
  if (wasStreaming && !streamStart()) ESP.restart();  // try the update again at the next check
}

// Called from loop() while streaming: the periodic check, and the new image's trial.
void otaLoop() {
  if (millis() - lastOtaCheck > OTA_CHECK_SECONDS * 1000UL) otaCheck();
  if (!otaTrial) return;
  if (otaAnswered && framesSent >= OTA_CONFIRM_FRAMES) {
    esp_ota_mark_app_valid_cancel_rollback();
    otaTrial = false;
    Serial.println("firmware marked valid: it streams and checks for updates");
  } else if (millis() > OTA_TRIAL_SECONDS * 1000UL) {
    Serial.println("! new firmware didn't stream in time; rolling back");
    Serial.flush();
    esp_ota_mark_app_invalid_rollback_and_reboot();
  }
}
#endif

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
  Serial.printf("firmware %.12s%s\n", runningSha, otaTrial ? ", on trial" : "");
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
#if defined(ARDUINO_ARCH_ESP32)
  esp_task_wdt_config_t watchdog = {WATCHDOG_SECONDS * 1000, 0, true};  // reboots; doesn't watch the idle tasks
  if (esp_task_wdt_reconfigure(&watchdog) != ESP_OK) esp_task_wdt_init(&watchdog);
  esp_task_wdt_add(nullptr);
#endif
  if (!micBegin()) Serial.println("! mic (I2S) failed to start");
  if (wifiUp()) syncClock();
  Serial.println("commands: l = level meter, r = record + upload, u = upload again, i = info, f = format flash,");
  Serial.println("          c = stream continuously (FireBeetle),");
  Serial.println("          s = stop mic, m = start mic, w = wifi off (to test what a flash write conflicts with)");
#if defined(ARDUINO_ARCH_RP2040)
  if (rp2040.getResetReason() == RP2040::WDT_RESET) Serial.println("! rebooted by the watchdog: the last command hung");
  rp2040.wdt_begin(15000);
#endif
#if defined(ARDUINO_ARCH_ESP32)
  otaSetup();
  if (WiFi.status() == WL_CONNECTED) otaCheck();  // may install an update and reboot
  if (STREAM_ON_BOOT && !streamStart()) {  // the update check above still runs on every attempt
    delay(10000);
    ESP.restart();
  }
#endif
}

void loop() {
  feed();
  static uint32_t lastAuto = 0;
  if (REPEAT_SECONDS && millis() - lastAuto >= REPEAT_SECONDS * 1000UL) {
    lastAuto = millis();
    if (record()) upload();
  }
#if defined(ARDUINO_ARCH_ESP32)
  if (streaming) {
    streamPump();
    otaLoop();
    if (!Serial.available()) return;
    char ch = Serial.read();
    if (ch == 'c') streamStop();
    else if (ch == 'i') info();
    else if (ch > ' ') Serial.println("streaming: only c (stop) and i work until it stops");
    return;
  }
#endif
  if (!Serial.available()) { delay(20); return; }
  switch (Serial.read()) {
    case 'l': levelMeter(); break;
    case 'r': if (record()) upload(); break;
    case 'u': upload(); break;
    case 'i': info(); break;
#if defined(ARDUINO_ARCH_ESP32)
    case 'c': streamStart(); break;
#endif
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
