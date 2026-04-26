/**
 * BuzzGuard ESP32 — Minimal Provisioning Only
 * ─────────────────────────────────────────────
 * 1. Check NVS for saved credentials → skip BLE if found
 * 2. Otherwise: BLE GATT server, wait for app to write creds
 * 3. On credential write:
 *      a. Connect WiFi
 *      b. Verify hardware_code in hardware_inventory
 *      c. Set is_active = true in buzz_monitors
 * 4. Done. No MQTT, no sensors, no telemetry loop.
 * ─────────────────────────────────────────────
 */

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "env.h"

// ── NVS ──────────────────────────────────────────────────────────
#define NVS_NAMESPACE  "buzzguard"
#define NVS_KEY_SSID   "ssid"
#define NVS_KEY_PASS   "pass"
#define NVS_KEY_HWCODE "hwcode"

// ── BLE UUIDs ─────────────────────────────────────────────────────
#define BLE_SERVICE_UUID   "12345678-1234-1234-1234-123456789abc"
#define BLE_CRED_CHAR_UUID "12345678-1234-1234-1234-123456789001"

// ── Globals ───────────────────────────────────────────────────────
Preferences prefs;
BLEServer*  pBleServer = nullptr;

char g_ssid[64]   = {0};
char g_pass[64]   = {0};
char g_hwCode[32] = {0};

volatile bool startProvisioningFlag = false;
bool          provisioningDone      = false;

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
static bool jsonExtract(const String& json, const char* key, char* out, size_t maxLen) {
    String search = String("\"") + key + "\":\"";
    int s = json.indexOf(search);
    if (s < 0) return false;
    s += search.length();
    int e = json.indexOf("\"", s);
    if (e < 0) return false;
    json.substring(s, e).toCharArray(out, maxLen);
    return true;
}

static void clearNVSAndRestart() {
    Serial.println("[NVS] Clearing — restarting…");
    prefs.begin(NVS_NAMESPACE, false);
    prefs.clear();
    prefs.end();
    delay(2000);
    ESP.restart();
}

// ─────────────────────────────────────────────────────────────────
// WiFi
// ─────────────────────────────────────────────────────────────────
static bool connectWiFi(const char* ssid, const char* pass) {
    Serial.printf("[WiFi] Connecting to \"%s\"…\n", ssid);
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, pass);
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED) {
        if (millis() - start >= 40000UL) {
            Serial.println("[WiFi] ✗ Timeout");
            WiFi.disconnect(true);
            clearNVSAndRestart();
            return false;
        }
        delay(500);
        Serial.print(".");
    }
    Serial.printf("\n[WiFi] ✓ IP: %s\n", WiFi.localIP().toString().c_str());
    return true;
}

// ─────────────────────────────────────────────────────────────────
// Supabase: verify hardware_code exists in inventory
// ─────────────────────────────────────────────────────────────────
static bool checkHardwareInventory(const char* hwCode) {
    WiFiClientSecure client;
    client.setInsecure();
    HTTPClient http;
    String url = String(SUPABASE_URL)
        + "/rest/v1/hardware_inventory?hardware_code=eq."
        + hwCode + "&select=hardware_code&limit=1";
    http.begin(client, url);
    http.addHeader("apikey", SUPABASE_ANON_KEY);
    http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
    int    code = http.GET();
    String body = http.getString();
    http.end();
    Serial.printf("[HW] %d → %s\n", code, body.c_str());
    return (code == 200 && body.length() > 2 && body.indexOf("\"hardware_code\"") >= 0);
}

// ─────────────────────────────────────────────────────────────────
// Supabase: set is_active = true (patch if exists, insert if not)
// ─────────────────────────────────────────────────────────────────
static void activateMonitor(const char* hwCode) {
    // Check if row exists
    WiFiClientSecure client1;
    client1.setInsecure();
    HTTPClient http1;
    String checkUrl = String(SUPABASE_URL)
        + "/rest/v1/buzz_monitors?hardware_code=eq."
        + hwCode + "&select=id&limit=1";
    http1.begin(client1, checkUrl);
    http1.addHeader("apikey", SUPABASE_ANON_KEY);
    http1.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
    int    code = http1.GET();
    String body = http1.getString();
    http1.end();

    WiFiClientSecure client2;
    client2.setInsecure();
    HTTPClient http2;

    if (code == 200 && body.indexOf("\"id\"") >= 0) {
        // Row exists — PATCH is_active = true
        String patchUrl = String(SUPABASE_URL)
            + "/rest/v1/buzz_monitors?hardware_code=eq." + hwCode;
        http2.begin(client2, patchUrl);
        http2.addHeader("apikey", SUPABASE_ANON_KEY);
        http2.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
        http2.addHeader("Content-Type", "application/json");
        http2.addHeader("Prefer", "return=minimal");
        int r = http2.PATCH("{\"is_active\":true}");
        http2.end();
        Serial.printf("[Monitor] PATCH is_active=true → HTTP %d\n", r);
    } else {
        // No row — INSERT new one
        String postUrl = String(SUPABASE_URL) + "/rest/v1/buzz_monitors";
        http2.begin(client2, postUrl);
        http2.addHeader("apikey", SUPABASE_ANON_KEY);
        http2.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
        http2.addHeader("Content-Type", "application/json");
        http2.addHeader("Prefer", "return=minimal");
        String payload = String("{")
            + "\"hardware_code\":\"" + hwCode + "\","
            + "\"is_active\":true,"
            + "\"box_status\":\"\""
            + "}";
        int r = http2.POST(payload);
        http2.end();
        Serial.printf("[Monitor] POST new row → HTTP %d\n", r);
    }
}

// ─────────────────────────────────────────────────────────────────
// Provisioning task (spawned after BLE credential write)
// ─────────────────────────────────────────────────────────────────
void provisioningTask(void* param) {
    vTaskDelay(pdMS_TO_TICKS(1000));

    if (!connectWiFi(g_ssid, g_pass)) {
        vTaskDelete(NULL);
        return;
    }

    if (!checkHardwareInventory(g_hwCode)) {
        Serial.println("[Task] ✗ Hardware code not in inventory — clearing NVS");
        clearNVSAndRestart();
        vTaskDelete(NULL);
        return;
    }
    Serial.println("[Task] ✓ Hardware code valid");

    activateMonitor(g_hwCode);

    provisioningDone = true;
    Serial.println("[Task] ✓ Done — is_active = true, app should unblock");
    vTaskDelete(NULL);
}

// ─────────────────────────────────────────────────────────────────
// BLE callbacks
// ─────────────────────────────────────────────────────────────────
class ServerCB : public BLEServerCallbacks {
    void onConnect(BLEServer*)    override { Serial.println("[BLE] Client connected"); }
    void onDisconnect(BLEServer*) override {
        Serial.println("[BLE] Client disconnected");
        if (!provisioningDone && !startProvisioningFlag)
            BLEDevice::startAdvertising();
    }
};

class CredCB : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic* pChar) override {
        String json = pChar->getValue();
        if (json.isEmpty()) return;
        Serial.printf("[BLE] Received: %s\n", json.c_str());

        char ssid[64]={0}, pass[64]={0}, hwCode[32]={0};
        if (!jsonExtract(json, "ssid",          ssid,   sizeof(ssid))   ||
            !jsonExtract(json, "password",      pass,   sizeof(pass))   ||
            !jsonExtract(json, "hardware_code", hwCode, sizeof(hwCode))) {
            Serial.println("[BLE] ✗ Missing fields");
            return;
        }

        strlcpy(g_ssid,   ssid,   sizeof(g_ssid));
        strlcpy(g_pass,   pass,   sizeof(g_pass));
        strlcpy(g_hwCode, hwCode, sizeof(g_hwCode));

        prefs.begin(NVS_NAMESPACE, false);
        prefs.putString(NVS_KEY_SSID,   ssid);
        prefs.putString(NVS_KEY_PASS,   pass);
        prefs.putString(NVS_KEY_HWCODE, hwCode);
        prefs.end();

        startProvisioningFlag = true;
        Serial.println("[BLE] Credentials saved ✓");
    }
};

// ─────────────────────────────────────────────────────────────────
// Start BLE GATT server
// ─────────────────────────────────────────────────────────────────
static void startBLE() {
    String name = "BuzzGuard-" + String((uint32_t)ESP.getEfuseMac(), HEX).substring(0, 4);
    BLEDevice::init(name.c_str());
    BLEDevice::setMTU(512);

    pBleServer = BLEDevice::createServer();
    pBleServer->setCallbacks(new ServerCB());

    BLEService* svc = pBleServer->createService(BLE_SERVICE_UUID);
    BLECharacteristic* pChar = svc->createCharacteristic(
        BLE_CRED_CHAR_UUID, BLECharacteristic::PROPERTY_WRITE);
    pChar->setCallbacks(new CredCB());
    svc->start();

    BLEAdvertising* adv = BLEDevice::getAdvertising();
    adv->addServiceUUID(BLE_SERVICE_UUID);
    adv->setScanResponse(true);
    adv->setMinPreferred(0x06);
    BLEDevice::startAdvertising();

    Serial.printf("[BLE] Advertising as \"%s\"\n", name.c_str());
}

// ─────────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(200);
    Serial.println("\n══════════════════════════════");
    Serial.println("  BuzzGuard — Provision Only");
    Serial.println("══════════════════════════════");

    prefs.begin(NVS_NAMESPACE, true);
    String savedSSID   = prefs.getString(NVS_KEY_SSID,   "");
    String savedPass   = prefs.getString(NVS_KEY_PASS,   "");
    String savedHWCode = prefs.getString(NVS_KEY_HWCODE, "");
    prefs.end();

    if (savedSSID.length() > 0 && savedHWCode.length() > 0) {
        Serial.println("[NVS] Found saved credentials — direct connect");
        savedSSID.toCharArray(g_ssid,     sizeof(g_ssid));
        savedPass.toCharArray(g_pass,     sizeof(g_pass));
        savedHWCode.toCharArray(g_hwCode, sizeof(g_hwCode));

        if (connectWiFi(g_ssid, g_pass)) {
            if (!checkHardwareInventory(g_hwCode)) {
                clearNVSAndRestart();
                return;
            }
            activateMonitor(g_hwCode);
            provisioningDone = true;
            Serial.println("[NVS] ✓ Done — is_active = true");
        } else {
            startBLE();
        }
    } else {
        Serial.println("[NVS] No saved creds — starting BLE");
        startBLE();
    }
}

// ─────────────────────────────────────────────────────────────────
// LOOP
// ─────────────────────────────────────────────────────────────────
void loop() {
    if (startProvisioningFlag) {
        startProvisioningFlag = false;
        xTaskCreatePinnedToCore(
            provisioningTask, "prov_task",
            16384, NULL, 1, NULL, 1);
    }
    delay(100);
}