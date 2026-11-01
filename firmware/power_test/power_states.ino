// The power states, run automatically from power-up after the p command. The attached parts choose
// the group: a card means group 3, a microphone without a card group 2, and neither group 1. Plan:
// docs/plans/bench-test-2.md. Not yet here: S8F, which needs a FLAC encoder.
//
// The three marker pins show a code while a state runs, and 0 for at least MARK_GAP_MS between
// states. A code restarts per group, because each group is its own capture:
//   Group 1: 1 S1
//   Group 2: 1 S3, 2 S9
//   Group 3: 1 S4, 2 S5, 3 S6, 4 S7, 5 S8 with N = 1, 6 S8 with N = 5, 7 S2
// Pins can't hold a code through deep sleep, so a sleep state shows its code for MARK_GAP_MS on each
// side, and the sleep is the low stretch between the two. firmware/power_test/analyze_ppk2.py
// splits the capture on these codes.

const uint32_t MARK_GAP_MS = 2000;
const uint32_t S1_S2_SECONDS = 300, RECORD_SECONDS = 600, RADIO_IDLE_SECONDS = 600, CYCLE_SECONDS = 900;
const int S6_CONNECTS = 10, S7_SENDS = 5, S8_RUNS = 3;
const uint32_t WAV_SECONDS = 60;
const uint32_t WAV_DATA_BYTES = WAV_SECONDS * SAMPLE_RATE * 2;  // S7's 3.84 MB file is one of these

RTC_DATA_ATTR int sleepPhase = 0;  // survives deep sleep: which sleep state is under way
RTC_DATA_ATTR int sleepGroup = 0;

File logFile;
#if defined(BOARD_XIAO_ESP32S3)
#define LOG_PORT Serial1  // Serial is the USB port here
#else
#define LOG_PORT Serial
#endif

void statesChoose(bool run) {
  Preferences prefs;
  prefs.begin("power_test", false);
  prefs.putBool("states", run);
  prefs.end();
  Serial.println(run ? "power states run from the next power-up; r cancels" : "recording from the next power-up");
}

void logf(const char *format, ...) {
  char line[160];
  va_list args;
  va_start(args, format);
  vsnprintf(line, sizeof line, format, args);
  va_end(args);
  LOG_PORT.printf("%lu %s\n", (unsigned long)millis(), line);
  if (logFile) {
    logFile.printf("%lu %s\n", (unsigned long)millis(), line);
    logFile.flush();
  }
}

void setCode(int code) {
  digitalWrite(PIN_MARK_REC, code & 1);
  digitalWrite(PIN_MARK_UP, (code >> 1) & 1);
  digitalWrite(PIN_MARK_3, (code >> 2) & 1);
}

void radioOff() {
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
}

// A missing microphone leaves the data pin at one level, or nearly so.
bool micAttached() {
  static int32_t raw[256];
  micDiscard(SETTLE_SAMPLES);
  micRead(raw, 256);
  int changes = 0;
  for (int k = 1; k < 256; k++) changes += raw[k] != raw[k - 1];
  return changes > 128;
}

void startSleep(int group, int code, int phase, uint32_t seconds) {
  setCode(code);
  delay(MARK_GAP_MS);
  setCode(0);
  sleepPhase = phase;
  sleepGroup = group;
  if (logFile) logFile.close();
  esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000);
  esp_deep_sleep_start();
}

[[noreturn]] void statesFinished() {
  logf("states finished");
  if (logFile) logFile.close();
  setCode(0);
  sleepPhase = 0;
  esp_deep_sleep_start();  // no wake source: power-cycle to run again
  while (true) {}
}

// ---- recording ---------------------------------------------------------------

void recordBegin() {
  if (!streamBuf) {
    streamBuf = xRingbufferCreate(128 * 1024, RINGBUF_TYPE_NOSPLIT);
    streamBufBytes = 128 * 1024;
  }
  micDiscard(SETTLE_SAMPLES);
  framesDropped = framesSent = 0;
  streaming = true;
  xTaskCreatePinnedToCore(micTaskLoop, "mic", 4096, nullptr, 5, &micTask, 1);
}

void recordEnd() {
  streaming = false;
  while (micTask) delay(10);
  size_t size;
  while (void *item = xRingbufferReceive(streamBuf, &size, 0)) vRingbufferReturnItem(streamBuf, item);
}

// S3: read and filter, keep nothing.
void recordDiscard(uint32_t seconds) {
  recordBegin();
  for (uint32_t started = millis(); millis() - started < seconds * 1000UL;) {
    size_t size;
    void *item = xRingbufferReceive(streamBuf, &size, pdMS_TO_TICKS(50));
    if (item) { vRingbufferReturnItem(streamBuf, item); framesSent++; }
  }
  recordEnd();
}

void wavHeader(File &f, uint32_t dataBytes) {
  uint32_t byteRate = SAMPLE_RATE * 2, chunk = 36 + dataBytes, fmtSize = 16, rate = SAMPLE_RATE;
  uint16_t pcm = 1, mono = 1, align = 2, bits = 16;
  f.write((const uint8_t *)"RIFF", 4); f.write((uint8_t *)&chunk, 4); f.write((const uint8_t *)"WAVEfmt ", 8);
  f.write((uint8_t *)&fmtSize, 4); f.write((uint8_t *)&pcm, 2); f.write((uint8_t *)&mono, 2); f.write((uint8_t *)&rate, 4);
  f.write((uint8_t *)&byteRate, 4); f.write((uint8_t *)&align, 2); f.write((uint8_t *)&bits, 2);
  f.write((const uint8_t *)"data", 4); f.write((uint8_t *)&dataBytes, 4);
}

String wavName() {
  time_t now = time(nullptr);
  struct tm t;
  gmtime_r(&now, &t);
  char name[32];
  strftime(name, sizeof name, "/%Y%m%dT%H%M%SZ.wav", &t);
  return name;
}

// ---- sending -----------------------------------------------------------------

// POST one file from the card to the receiver's /upload. Returns the bytes sent, or 0.
size_t sendFile(const String &path) {
  File f = SD.open(path, FILE_READ);
  if (!f) return 0;
  String host, hostPort;
  uint16_t port;
  receiverHost(host, port, hostPort);
  WiFiClient client;
  size_t sent = 0, size = f.size();
  uint32_t started = millis();
  if (resolveReceiver(host, false) && client.connect(receiverIp, port, 3000)) {
    client.printf("POST /upload?name=%s HTTP/1.1\r\nHost: %s\r\nX-Token: %s\r\nContent-Length: %u\r\nConnection: close\r\n\r\n",
                  path.c_str() + 1, hostPort.c_str(), RECEIVER_TOKEN, (unsigned)size);
    static uint8_t chunk[4096];
    while (sent < size) {
      int n = f.read(chunk, sizeof chunk);
      if (n <= 0 || client.write(chunk, n) != (size_t)n) break;
      sent += n;
    }
    for (uint32_t t = millis(); client.connected() && !client.available() && millis() - t < 5000;) delay(5);
    String status = client.readStringUntil('\n');
    if (status.indexOf(" 20") < 0) { logf("! upload of %s: %s", path.c_str(), status.c_str()); sent = 0; }
  }
  client.stop();
  f.close();
  uint32_t ms = millis() - started;
  logf("sent %s: %u bytes, %lu ms, %.0f kbit/s, RSSI %d", path.c_str(), (unsigned)sent, (unsigned long)ms,
       ms ? sent * 8.0 / ms : 0.0, (int)WiFi.RSSI());
  return sent;
}

// The files waiting to be sent, while the main task records.
QueueHandle_t sendQueue = nullptr;
std::atomic<bool> senderBusy{false};
std::atomic<int> sendFailures{0};

void senderTask(void *) {
  char name[32];
  std::vector<String> names;
  while (xQueueReceive(sendQueue, name, 0) == pdTRUE) names.push_back(name);
  if (!names.empty() && wifiUp()) {
    WiFi.setSleep(true);
    for (const String &n : names) if (!sendFile(n)) sendFailures++;
  } else if (!names.empty()) {
    sendFailures += names.size();
  }
  radioOff();
  senderBusy = false;
  vTaskDelete(nullptr);
}

// S4 and S8: write 1-minute WAVs to the card. With sendEverySeconds, send finished files that often,
// with the radio off between sends.
void recordToCard(uint32_t seconds, uint32_t sendEverySeconds) {
  if (!sendQueue) sendQueue = xQueueCreate(32, 32);
  xQueueReset(sendQueue);
  sendFailures = 0;
  recordBegin();
  File wav;
  String wavPath;
  uint32_t written = 0, lastSend = millis(), maxWriteMs = 0;
  for (uint32_t started = millis(); millis() - started < seconds * 1000UL;) {
    size_t size;
    Frame *fr = (Frame *)xRingbufferReceive(streamBuf, &size, pdMS_TO_TICKS(50));
    if (fr) {
      if (!wav) {
        wavPath = wavName();
        wav = SD.open(wavPath, FILE_WRITE);
        if (!wav) logf("! can't create %s", wavPath.c_str());
        wavHeader(wav, WAV_DATA_BYTES);
        written = 0;
      }
      uint32_t t = millis();
      wav.write((const uint8_t *)fr->pcm, fr->count * 2);
      maxWriteMs = max(maxWriteMs, millis() - t);
      written += fr->count * 2;
      framesSent++;
      vRingbufferReturnItem(streamBuf, fr);
      if (written >= WAV_DATA_BYTES) {
        wav.close();
        char name[32] = {};
        wavPath.toCharArray(name, sizeof name);
        xQueueSend(sendQueue, name, 0);
      }
    }
    if (sendEverySeconds && !senderBusy && millis() - lastSend >= sendEverySeconds * 1000UL) {
      lastSend = millis();
      senderBusy = true;
      xTaskCreatePinnedToCore(senderTask, "sender", 8192, nullptr, 1, nullptr, 0);
    }
  }
  recordEnd();
  if (wav) wav.close();
  while (senderBusy) delay(50);
  radioOff();
  logf("recorded %lu frames, dropped %lu, slowest card write %lu ms, send failures %d", (unsigned long)framesSent,
       (unsigned long)framesDropped, (unsigned long)maxWriteMs, sendFailures.load());
}

// ---- the groups -----------------------------------------------------------------

void beginState(int code, const char *name) {
  logf("%s begins", name);
  setCode(code);
}

void endState(const char *name) {
  setCode(0);
  logf("%s ends", name);
  delay(MARK_GAP_MS);
}

void group2() {
  beginState(1, "S3");
  recordDiscard(RECORD_SECONDS);
  logf("S3: %lu frames, %lu dropped", (unsigned long)framesSent, (unsigned long)framesDropped);
  endState("S3");

  setCpuFrequencyMhz(240);  // S9 is as deployed
  if (wifiUp()) syncClock();
  beginState(2, "S9");
  streamStart();
  for (uint32_t started = millis(); millis() - started < RECORD_SECONDS * 1000UL;) streamPump();
  streamStop();
  logf("S9: %lu frames, %lu dropped, %lu connects, RSSI %d", (unsigned long)framesSent, (unsigned long)framesDropped,
       (unsigned long)streamConnects, (int)WiFi.RSSI());
  endState("S9");
  statesFinished();
}

void group3() {
  beginState(1, "S4");
  recordToCard(RECORD_SECONDS, 0);
  endState("S4");

  beginState(2, "S5");
  if (wifiUp()) {
    WiFi.setSleep(true);
    delay(RADIO_IDLE_SECONDS * 1000UL);
    logf("S5: RSSI %d", (int)WiFi.RSSI());
  }
  radioOff();
  endState("S5");

  String host, hostPort;
  uint16_t port;
  receiverHost(host, port, hostPort);
  beginState(3, "S6");
  for (int k = 0; k < S6_CONNECTS; k++) {
    delay(5000);  // radio off between connects
    uint32_t started = millis();
    WiFiClient client;
    bool ok = wifiUp() && resolveReceiver(host, false) && client.connect(receiverIp, port, 3000) && client.write((uint8_t)'\n') == 1;
    logf("S6 connect %d: %s, %lu ms", k, ok ? "ok" : "failed", (unsigned long)(millis() - started));
    client.stop();
    radioOff();
  }
  endState("S6");

  // S7's file: one minute of audio, as S8 writes.
  recordToCard(WAV_SECONDS + 2, 0);
  String sample;
  File root = SD.open("/");
  for (File f = root.openNextFile(); f; f = root.openNextFile()) {
    if (String(f.name()).endsWith(".wav") && f.size() == WAV_DATA_BYTES + 44) sample = String("/") + f.name();
    f.close();
  }
  root.close();
  i2s.end();  // S7 runs with the microphone off
  if (wifiUp()) {
    WiFi.setSleep(true);
    beginState(4, "S7");
    for (int k = 0; k < S7_SENDS; k++) sendFile(sample);
    endState("S7");
  }
  radioOff();
  micBegin();

  uint32_t everyMinutes[] = {1, 5};
  for (int n = 0; n < 2; n++) {
    for (int run = 0; run < S8_RUNS; run++) {
      logf("S8 N=%lu run %d", (unsigned long)everyMinutes[n], run);
      beginState(5 + n, "S8");
      recordToCard(CYCLE_SECONDS, everyMinutes[n] * 60);
      endState("S8");
    }
  }

  beginState(7, "S2");
  logf("S2 sleep starts");
  i2s.end();
  startSleep(3, 7, 2, S1_S2_SECONDS);
}

void statesRun() {
  statesRunning = true;
  pinMode(PIN_MARK_3, OUTPUT);
  setCode(0);
#if defined(BOARD_XIAO_ESP32S3)
  LOG_PORT.begin(115200, SERIAL_8N1, -1, PIN_LOG_TX);
#endif
  if (esp_reset_reason() == ESP_RST_DEEPSLEEP && sleepPhase) {  // the end of S1 or S2
    int code = sleepPhase == 1 ? 1 : 7;
    setCode(code);
    delay(MARK_GAP_MS);
    setCode(0);
    statesFinished();
  }
  sleepPhase = 0;
  setCpuFrequencyMhz(80);
  radioOff();
  SPI.begin(PIN_SD_SCK, PIN_SD_MISO, PIN_SD_MOSI, PIN_SD_CS);
  bool card = SD.begin(PIN_SD_CS);
  bool mic = micBegin() && micAttached();
  logf("power states: card %d, microphone %d", card, mic);
  if (card) {
    logFile = SD.open("/log.txt", FILE_APPEND);
    if (!wifiUp()) logf("! wifi didn't connect");
    else syncClock();  // the file names need the time
    radioOff();
    group3();
  } else if (mic) {
    group2();
  } else {
    i2s.end();
    logf("S1 sleep starts");
    startSleep(1, 1, 1, S1_S2_SECONDS);
  }
}
