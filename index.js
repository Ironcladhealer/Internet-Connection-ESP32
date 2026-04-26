require("dotenv").config();
const express = require("express");
const mqtt = require("mqtt");

const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────
const MQTT_HOST     = process.env.MQTT_HOST;
const MQTT_PORT     = parseInt(process.env.MQTT_PORT || "8883");
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const HARDWARE_CODE = process.env.HARDWARE_CODE;
const PORT          = parseInt(process.env.PORT || "3000");

const TOPIC         = `devices/${HARDWARE_CODE}/telemetry`;
const INTERVAL_MS   = 10 * 60 * 1000; // 10 minutes

// ── Ranges ────────────────────────────────────────────────────────
const RANGES = {
  frequency:   { min: 150,  max: 350  },
  temperature: { min: 30,   max: 42   },
  humidity:    { min: 33,   max: 60   },
};

// ── State ─────────────────────────────────────────────────────────
let mqttClient    = null;
let isConnected   = false;
let msgCounter    = 0;
let simulatorTimer = null;
let lastPayload   = null;
let lastPublishedAt = null;

// ── Helpers ───────────────────────────────────────────────────────
function randomInRange(min, max) {
  return parseFloat((Math.random() * (max - min) + min).toFixed(2));
}

function buildPayload() {
  msgCounter++;
  return {
    message_id:    `${HARDWARE_CODE}_${msgCounter}`,
    hardware_code: HARDWARE_CODE,
    temperature:   randomInRange(RANGES.temperature.min, RANGES.temperature.max),
    humidity:      randomInRange(RANGES.humidity.min,    RANGES.humidity.max),
    frequency:     randomInRange(RANGES.frequency.min,   RANGES.frequency.max),
  };
}

function publishTelemetry() {
  if (!isConnected) {
    console.warn("[MQTT] Not connected — skipping publish");
    return;
  }

  const payload = buildPayload();
  lastPayload = payload;
  lastPublishedAt = new Date().toISOString();

  mqttClient.publish(TOPIC, JSON.stringify(payload), { qos: 1 }, (err) => {
    if (err) {
      console.error("[MQTT] Publish failed:", err.message);
    } else {
      console.log(`[MQTT] ✓ Published to ${TOPIC}`);
      console.log("       ", JSON.stringify(payload));
    }
  });
}

// ── MQTT Connection ───────────────────────────────────────────────
function connectMQTT() {
  const brokerUrl = `mqtts://${MQTT_HOST}:${MQTT_PORT}`;

  console.log(`[MQTT] Connecting to ${brokerUrl} …`);

  mqttClient = mqtt.connect(brokerUrl, {
    username:           MQTT_USERNAME,
    password:           MQTT_PASSWORD,
    clientId:        `ESP32-${HARDWARE_CODE}`,
    reconnectPeriod:    5000,    // auto-reconnect every 5s on drop
    keepalive:          60,
  });

  mqttClient.on("connect", () => {
    isConnected = true;
    console.log("[MQTT] ✓ Connected");

    // Publish immediately on connect, then every 10 mins
    publishTelemetry();
    simulatorTimer = setInterval(publishTelemetry, INTERVAL_MS);
  });

  mqttClient.on("reconnect", () => {
    console.log("[MQTT] Reconnecting …");
  });

  mqttClient.on("offline", () => {
    isConnected = false;
    console.warn("[MQTT] Offline");
    if (simulatorTimer) {
      clearInterval(simulatorTimer);
      simulatorTimer = null;
    }
  });

  mqttClient.on("error", (err) => {
    isConnected = false;
    console.error("[MQTT] Error:", err.message);
  });
}

// ── Express Routes ────────────────────────────────────────────────

// Health / status
app.get("/status", (req, res) => {
  res.json({
    mqtt_connected:   isConnected,
    hardware_code:    HARDWARE_CODE,
    topic:            TOPIC,
    interval_minutes: 10,
    messages_sent:    msgCounter,
    last_published_at: lastPublishedAt,
    last_payload:     lastPayload,
    ranges:           RANGES,
  });
});

// Manually trigger a publish right now (useful for testing)
app.post("/publish-now", (req, res) => {
  if (!isConnected) {
    return res.status(503).json({ error: "MQTT not connected" });
  }
  publishTelemetry();
  res.json({ success: true, payload: lastPayload });
});

// 404
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// ── Boot ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("═══════════════════════════════════════");
  console.log("  BuzzGuard Telemetry Simulator");
  console.log("═══════════════════════════════════════");
  console.log(`  Hardware Code : ${HARDWARE_CODE}`);
  console.log(`  MQTT Broker   : ${MQTT_HOST}:${MQTT_PORT}`);
  console.log(`  Topic         : ${TOPIC}`);
  console.log(`  Interval      : 10 minutes`);
  console.log(`  Express       : http://localhost:${PORT}`);
  console.log("═══════════════════════════════════════\n");

  connectMQTT();
});