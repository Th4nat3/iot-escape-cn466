/*
  IoT ESCAPE / CN466 - ESP32-S2 USB Serial PING/ACK + Wi-Fi Hotspot + HTTP GET /status
  Tested in browser mock only: must compile/upload on the user's actual board.

  Dependencies: Espressif Arduino-ESP32 board package, built-in WiFi + WebServer.
  No sensors connected, no GPIO writes, no fabricated readings, no MQTT broker.
  Serial commands (JSON line, 115200):
    {"id":"p123","cmd":"PING"}
    {"id":"w123","cmd":"WIFI_CONNECT","ssid":"PhoneName","password":"secret"}
    {"id":"w124","cmd":"WIFI_STATUS"}
    {"id":"w125","cmd":"WIFI_DISCONNECT"}
  Credentials are NEVER printed, stored in source, or saved intentionally to flash.
  Flashing replaces previous firmware. Save the original sketch first if needed.
*/
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>

constexpr uint32_t SERIAL_SPEED = 115200;
constexpr uint32_t TELEMETRY_INTERVAL_MS = 2000;
constexpr uint32_t WIFI_STATUS_INTERVAL_MS = 5000;
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 25000;
constexpr size_t MAX_SERIAL_LINE = 512;
WebServer httpServer(80);
String serialLine;
bool dropOversizedLine = false;
bool wifiConnecting = false;
bool httpStarted = false;
uint32_t connectionStarted = 0;
uint32_t lastTelemetry = 0;
uint32_t lastWifiStatus = 0;
String wifiState = "DISCONNECTED";

String jsonEscape(const String& input) {
  String result;
  result.reserve(input.length() + 8);
  for (size_t i = 0; i < input.length(); i++) {
    char c = input[i];
    if (c == '"' || c == '\\') { result += '\\'; result += c; }
    else if (c == '\n') result += "\\n";
    else if (c == '\r') result += "\\r";
    else if (c == '\t') result += "\\t";
    else if (static_cast<uint8_t>(c) < 32) result += '?';
    else result += c;
  }
  return result;
}

// Small, strictly bounded string-key parser for the four commands above.
// Unsupported escape forms are rejected rather than silently mangling passwords.
bool jsonStringField(const String& json, const char* key, String& result) {
  const String marker = String('"') + key + '"';
  int pos = json.indexOf(marker);
  if (pos < 0) return false;
  pos += marker.length();
  while (pos < static_cast<int>(json.length()) && isspace(static_cast<unsigned char>(json[pos]))) pos++;
  if (pos >= static_cast<int>(json.length()) || json[pos++] != ':') return false;
  while (pos < static_cast<int>(json.length()) && isspace(static_cast<unsigned char>(json[pos]))) pos++;
  if (pos >= static_cast<int>(json.length()) || json[pos++] != '"') return false;
  result = "";
  for (; pos < static_cast<int>(json.length()); pos++) {
    const char c = json[pos];
    if (c == '"') return true;
    if (static_cast<uint8_t>(c) < 32) return false;
    if (c != '\\') { result += c; continue; }
    if (++pos >= static_cast<int>(json.length())) return false;
    switch (json[pos]) {
      case '"': result += '"'; break;
      case '\\': result += '\\'; break;
      case '/': result += '/'; break;
      case 'n': result += '\n'; break;
      case 'r': result += '\r'; break;
      case 't': result += '\t'; break;
      default: return false; // Reject Unicode escapes and unsupported sequences.
    }
  }
  return false;
}

bool validId(const String& id) {
  if (id.length() == 0 || id.length() > 64) return false;
  for (size_t i = 0; i < id.length(); i++) {
    char c = id[i];
    if (!isalnum(static_cast<unsigned char>(c)) && c != '-' && c != '_') return false;
  }
  return true;
}

void sendAck(const String& id, const String& cmd, bool ok, const char* reason = nullptr) {
  String line = "{\"type\":\"ACK\",\"id\":\"" + jsonEscape(id) +
    "\",\"cmd\":\"" + jsonEscape(cmd) + "\",\"ok\":" + (ok ? "true" : "false") +
    ",\"data\":{\"board\":\"ESP32-S2\",\"transport\":\"USB_SERIAL\",\"gpio_tested\":false}";
  if (reason) line += ",\"error\":\"" + jsonEscape(reason) + "\"";
  Serial.println(line + "}");
}

bool wifiConnected() { return WiFi.status() == WL_CONNECTED; }

void publishWifiStatus() {
  const bool connected = wifiConnected();
  String line = "{\"type\":\"WIFI_STATUS\",\"connected\":" + String(connected ? "true" : "false") +
    ",\"state\":\"" + jsonEscape(wifiState) + "\"";
  if (connected) {
    line += ",\"ssid\":\"" + jsonEscape(WiFi.SSID()) + "\",\"ip\":\"" + WiFi.localIP().toString() +
      "\",\"rssi_dbm\":" + String(WiFi.RSSI()) + ",\"http_port\":80";
  } else {
    line += ",\"ssid\":null,\"ip\":null,\"rssi_dbm\":null,\"http_port\":null";
  }
  Serial.println(line + ",\"mqtt_connected\":false}");
  lastWifiStatus = millis();
}

String statusJson() {
  return "{\"device\":\"cucumber-r\",\"board\":\"ESP32-S2\",\"transport\":\"HTTP_LAN\","
    "\"wifi_connected\":true,\"uptime_s\":" + String(millis() / 1000U) +
    ",\"rssi_dbm\":" + String(WiFi.RSSI()) +
    ",\"ip\":\"" + WiFi.localIP().toString() + "\","
    "\"temperature\":null,\"humidity\":null,\"soil_moisture\":null,"
    "\"data_origin\":\"NO_SENSOR\",\"gpio_tested\":false,\"mqtt_connected\":false}";
}

void addCorsHeaders() {
  const String origin = httpServer.header("Origin");
  if (origin == "http://localhost:5173" || origin == "http://127.0.0.1:5173") {
    httpServer.sendHeader("Access-Control-Allow-Origin", origin);
    httpServer.sendHeader("Vary", "Origin");
  }
  httpServer.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  httpServer.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  httpServer.sendHeader("Access-Control-Allow-Private-Network", "true");
  httpServer.sendHeader("Cache-Control", "no-store");
}

void setupHttp() {
  const char* requestHeaders[] = {"Origin", "Access-Control-Request-Private-Network"};
  httpServer.collectHeaders(requestHeaders, 2);
  httpServer.on("/status", HTTP_GET, []() {
    addCorsHeaders();
    if (!wifiConnected()) { httpServer.send(503, "application/json", "{\"error\":\"wifi_down\"}"); return; }
    httpServer.send(200, "application/json; charset=utf-8", statusJson());
  });
  httpServer.on("/status", HTTP_OPTIONS, []() { addCorsHeaders(); httpServer.send(204); });
  httpServer.onNotFound([]() { addCorsHeaders(); httpServer.send(404, "application/json", "{\"error\":\"not_found\"}"); });
}

void stopWiFi() {
  wifiConnecting = false;
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(true, true); // wifioff + erase saved AP settings
  wifiState = "DISCONNECTED";
  publishWifiStatus();
}

void handleCommand(const String& commandLine) {
  String id, cmd;
  if (!jsonStringField(commandLine, "id", id) || !validId(id) || !jsonStringField(commandLine, "cmd", cmd)) return;
  if (cmd == "PING") {
    sendAck(id, cmd, true);
    return;
  }
  if (cmd == "WIFI_STATUS") {
    sendAck(id, cmd, true);
    publishWifiStatus();
    return;
  }
  if (cmd == "WIFI_DISCONNECT") {
    stopWiFi();
    sendAck(id, cmd, true);
    return;
  }
  if (cmd == "WIFI_CONNECT") {
    String ssid, password;
    if (!jsonStringField(commandLine, "ssid", ssid) || !jsonStringField(commandLine, "password", password) ||
        ssid.length() == 0 || ssid.length() > 32 || password.length() < 8 || password.length() > 63) {
      sendAck(id, cmd, false, "INVALID_WIFI_CREDENTIAL_FORMAT");
      return;
    }
    wifiConnecting = true;
    wifiState = "CONNECTING";
    connectionStarted = millis();
    WiFi.setAutoReconnect(false);
    WiFi.disconnect(false, true);
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid.c_str(), password.c_str());
    // An accepted request is NOT proof that the Hotspot connection succeeded.
    sendAck(id, cmd, true);
    publishWifiStatus();
    // Keep credentials off Serial logs and out of the HTML's BroadcastChannel.
    password = "";
    return;
  }
  sendAck(id, cmd, false, "UNSUPPORTED_COMMAND");
}

void publishTelemetry() {
  // No physical sensors verified on this board: null MUST NOT become a fabricated value.
  Serial.println("Publish payload: {\"temperature\":null,\"humidity\":null,\"soil_moisture\":null,"
                 "\"plant_name\":\"BOARD ONLY - NO SENSOR\",\"data_origin\":\"NO_SENSOR\"}");
}

void setup() {
  Serial.begin(SERIAL_SPEED);
  delay(800);
  serialLine.reserve(MAX_SERIAL_LINE);
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, true);
  setupHttp();
  Serial.println("=== IoT ESCAPE CN466 ESP32-S2 / USB PING + HOTSPOT HTTP ===");
  Serial.println("INFO: SENSORS NOT ATTACHED. NO_GPIO_OUTPUT. MQTT_DISABLED.");
  publishTelemetry();
  publishWifiStatus();
  lastTelemetry = millis();
}

void loop() {
  while (Serial.available() > 0) {
    char c = static_cast<char>(Serial.read());
    if (c == '\r') continue;
    if (c == '\n') {
      if (!dropOversizedLine && !serialLine.isEmpty()) handleCommand(serialLine);
      serialLine = "";
      dropOversizedLine = false;
    } else if (!dropOversizedLine) {
      if (serialLine.length() < MAX_SERIAL_LINE) serialLine += c;
      else { serialLine = ""; dropOversizedLine = true; }
    }
  }
  if (wifiConnecting && wifiConnected()) {
    wifiConnecting = false;
    wifiState = "CONNECTED";
    if (!httpStarted) { httpServer.begin(); httpStarted = true; }
    publishWifiStatus();
  }
  if (wifiConnecting && millis() - connectionStarted > WIFI_CONNECT_TIMEOUT_MS) {
    wifiConnecting = false;
    wifiState = "TIMEOUT";
    WiFi.disconnect(false, true);
    publishWifiStatus();
  }
  if (!wifiConnecting && wifiState == "CONNECTED" && !wifiConnected()) {
    wifiState = "LOST_CONNECTION";
    publishWifiStatus();
  }
  if (wifiConnected()) httpServer.handleClient();
  if (millis() - lastTelemetry >= TELEMETRY_INTERVAL_MS) {
    lastTelemetry = millis();
    publishTelemetry();
  }
  if (millis() - lastWifiStatus >= WIFI_STATUS_INTERVAL_MS) publishWifiStatus();
  delay(2);
}
