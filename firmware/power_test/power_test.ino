// Bench test 2: the XIAO ESP32S3 and FireBeetle 2 ESP32-E. This first version is the recording
// check: it streams an INMP441 to pipeline/receiver.py with the same protocol, filter, and gain as
// firmware/recorder_test/, so either board can stand in as the recorder.
// Plan and wiring: docs/plans/bench-test-2.md.
//
// Serial commands (115200 baud):
//   l  level meter: peak and RMS for 10 s (stop streaming first)
//   c  start or stop streaming
//   i  info: wifi and time
//
// The board streams as soon as it has wifi and the time. A mic task fills a RAM ring buffer, to
// ride out wifi hiccups, and loop() sends it to the receiver, which cuts it into 1-minute WAVs.
// A marker pin goes high while recording, and another while connected to the receiver.

#include <Arduino.h>
#include <ESPmDNS.h>
#include <ESP_I2S.h>
#include <WiFi.h>
#include <esp_timer.h>
#include <freertos/ringbuf.h>
#include <sys/time.h>
#include <time.h>
#include <atomic>
#include "secrets.h"  // copy secrets.example.h to secrets.h and fill it in

// ---- settings -------------------------------------------------------------
const uint32_t SAMPLE_RATE = 32000;    // covers BirdNET's 0-15 kHz
const int SAMPLE_SHIFT = 14;           // 24-bit mic sample -> 16-bit; 16 = no gain, 14 = +12 dB
const float HIGHPASS_HZ = 200;         // cut wind and traffic rumble (and the mic's DC offset) below birdsong
const uint32_t SETTLE_SAMPLES = 8192;  // discard the mic's first ~0.25 s after start-up
const uint32_t STREAM_RECONNECT_SECONDS = 3600;  // reconnect hourly to re-anchor the sample clock to NTP

// ---- pins (GPIO numbers) --------------------------------------------------
#if defined(BOARD_XIAO_ESP32S3)
const int PIN_BCLK = 1;       // D0, mic SCK
const int PIN_WS = 2;         // D1, mic WS
const int PIN_DIN = 3;        // D2, mic SD
const int PIN_MARK_REC = 5;   // D4
const int PIN_MARK_UP = 6;    // D5
#elif defined(BOARD_FIREBEETLE)
const int PIN_BCLK = 26;      // D3, mic SCK
const int PIN_WS = 25;        // D2, mic WS
const int PIN_DIN = 34;       // A2, mic SD (input-only pin is fine)
const int PIN_MARK_REC = 14;  // D6
const int PIN_MARK_UP = 13;   // D7
#else
#error "Build with -DBOARD_XIAO_ESP32S3 or -DBOARD_FIREBEETLE (see platformio.ini)"
#endif

I2SClass i2s;

// ---- mic ------------------------------------------------------------------

bool micBegin() {
  i2s.setPins(PIN_BCLK, PIN_WS, -1, PIN_DIN);
  // INMP441 with L/R tied to ground sends 24-bit samples in the left half of 32-bit slots.
  return i2s.begin(I2S_MODE_STD, SAMPLE_RATE, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO, I2S_STD_SLOT_LEFT);
}

// Fill `out` with n raw 32-bit left-channel samples. Blocks until they arrive.
void micRead(int32_t *out, size_t n) {
  size_t got = 0;
  while (got < n) got += i2s.readBytes((char *)(out + got), (n - got) * sizeof(int32_t)) / sizeof(int32_t);
}

// A 2nd-order Butterworth high-pass (RBJ biquad, transposed direct form II) at HIGHPASS_HZ.
// One filter for the mic: only one of streaming and the level meter runs at a time.
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
    samples -= n;
  }
}

// ---- network --------------------------------------------------------------

bool wifiUp() {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.mode(WIFI_STA);
  // With more than one access point on the network, join the strongest, not the first one found.
  WiFi.setScanMethod(WIFI_ALL_CHANNEL_SCAN);
  WiFi.setSortMethod(WIFI_CONNECT_AP_BY_SIGNAL);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 20000) delay(200);
  if (WiFi.status() != WL_CONNECTED) { Serial.println("! wifi didn't connect"); return false; }
  Serial.printf("wifi up in %lu ms, %s, RSSI %d dBm\n", (unsigned long)(millis() - started),
                WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
  return true;
}

void syncClock() {
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  uint32_t started = millis();
  while (time(nullptr) < 1700000000 && millis() - started < 15000) delay(200);
  Serial.println(time(nullptr) < 1700000000 ? "! clock not set (NTP)" : "clock set from NTP");
}

// RECEIVER_URL is "http://host:port"
void receiverHost(String &host, uint16_t &port, String &hostPort) {
  hostPort = String(RECEIVER_URL).substring(7);  // after "http://"
  int colon = hostPort.indexOf(':');
  host = hostPort.substring(0, colon);
  port = hostPort.substring(colon + 1).toInt();
}

// ---- streaming ------------------------------------------------------------

// One ring-buffer item; the first 12 bytes plus the samples are sent as-is (little-endian):
// the receiver reads a uint64 index, a uint32 count, then the samples.
const size_t FRAME_SAMPLES = 512;  // 16 ms at 32 kHz
struct Frame {
  uint64_t index;  // samples since streaming started, dropped ones included
  uint32_t count;
  int16_t pcm[FRAME_SAMPLES];
};
const size_t FRAME_HEADER_BYTES = 12;

bool streaming = false;
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
  digitalWrite(PIN_MARK_REC, HIGH);
  while (streaming) {
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
  digitalWrite(PIN_MARK_REC, LOW);
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
  xTaskCreatePinnedToCore(micTaskLoop, "mic", 4096, nullptr, 5, &micTask, 1);
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
  if (!wifiUp()) return false;
  if (time(nullptr) < 1700000000) { syncClock(); return false; }  // file names need the time
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
  streamClient.write(head, sizeof head);
  streamClient.write((const uint8_t *)text, n);
  lastHealth = millis();
  healthDue = false;
}

// Called from loop(): keep the connection up and move buffered frames onto it.
void streamPump() {
  if (streamClient.connected() && millis() - streamConnectedAt > STREAM_RECONNECT_SECONDS * 1000UL) {
    streamClient.stop();  // the buffer holds the audio while we reconnect
  }
  if (!streamClient.connected()) {
    digitalWrite(PIN_MARK_UP, LOW);
    if (!streamConnect()) { delay(20); return; }
  }
  // Send whatever is buffered, up to 8 frames per write: one small packet per frame couldn't
  // drain the buffer after a hiccup (it sat 80-90% full and dropped audio).
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
  uint32_t lastProgress = millis();
  for (size_t off = 0; off < used;) {
    size_t w = streamClient.write(batch + off, used - off);
    if (w) { off += w; lastProgress = millis(); }
    else if (!streamClient.connected() || millis() - lastProgress > 5000) {
      Serial.println("! stream write failed; reconnecting");
      streamClient.stop();
      break;
    } else delay(2);
  }
  framesSent += frames;
  if (streamClient.connected() && (healthDue || millis() - lastHealth > 60000)) streamHealth();
  if (millis() - lastStatus > 60000) {
    lastStatus = millis();
    Serial.printf("stream: %lu frames sent, %lu dropped, buffer %u%% full, RSSI %d dBm\n",
                  (unsigned long)framesSent, (unsigned long)framesDropped,
                  (unsigned)(100 - 100 * xRingbufferGetCurFreeSize(streamBuf) / streamBufBytes), (int)WiFi.RSSI());
  }
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
      Serial.printf("rms %6.1f dBFS  peak %5lu%s  |%.*s\n", rms, (unsigned long)peak, peak >= 32767 ? " CLIPPED" : "", bars,
                    "#############################################");
    }
  }
}

void info() {
  time_t now = time(nullptr);
  Serial.printf("wifi %s, RSSI %d dBm, time %s", WiFi.status() == WL_CONNECTED ? "up" : "down",
                (int)WiFi.RSSI(), ctime(&now));
}

void setup() {
  Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(0);  // don't wait for a USB host when the board runs without a computer
#endif
  uint32_t started = millis();
  while (!Serial && millis() - started < 3000) delay(10);  // wait briefly for a USB serial monitor
  pinMode(PIN_MARK_REC, OUTPUT);
  pinMode(PIN_MARK_UP, OUTPUT);
  Serial.println("\nbirdTracker bench test 2");
  if (!micBegin()) Serial.println("! mic (I2S) failed to start");
  if (wifiUp()) syncClock();
  Serial.println("commands: l = level meter (when stopped), c = start or stop streaming, i = info");
  streamStart();
}

void loop() {
  if (streaming) {
    streamPump();
    if (!Serial.available()) return;
    char ch = Serial.read();
    if (ch == 'c') streamStop();
    else if (ch == 'i') info();
    else if (ch > ' ') Serial.println("streaming: only c (stop) and i work until it stops");
    return;
  }
  if (!Serial.available()) { delay(20); return; }
  switch (Serial.read()) {
    case 'l': levelMeter(); break;
    case 'c': streamStart(); break;
    case 'i': info(); break;
  }
}
