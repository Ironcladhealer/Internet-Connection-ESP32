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

// ── Hard Ranges (absolute limits values never exceed) ─────────────
const HARD_LIMITS = {
  frequency:   { min: 180,  max: 220  },
  humidity:    { min: 40,   max: 44   },
  // Temperature limits are time-based — see getTemperatureRange()
};

// ── State ─────────────────────────────────────────────────────────
let mqttClient      = null;
let isConnected     = false;
let msgCounter      = 0;
let simulatorTimer  = null;
let lastPayload     = null;
let lastPublishedAt = null;

// Sensor state — tracks current values so each tick drifts from the last
let sensorState = {
  frequency:   null,   // initialised on first publish
  temperature: null,
  humidity:    null,
};

// ── Time-aware temperature range ──────────────────────────────────
/**
 * Returns the target { min, max } for temperature based on the current hour.
 *   05:00 – 17:59  →  daytime   35–37 °C
 *   18:00 – 04:59  →  nighttime 25–29 °C
 */
function getTemperatureRange() {
  const hour = new Date().getHours(); // local server time
  if (hour >= 5 && hour < 18) {
    return { min: 28, max: 31 };
  }
  return { min: 20, max: 27 };
}

// ── Drift helper ──────────────────────────────────────────────────
/**
 * Nudges `current` by a small random step, then clamps to [min, max].
 *
 * @param {number} current      - previous sensor value
 * @param {number} maxStep      - largest single-tick change allowed
 * @param {number} min          - hard lower bound
 * @param {number} max          - hard upper bound
 * @param {number} [decimals=2] - rounding precision
 */
function drift(current, maxStep, min, max, decimals = 2) {
  // Random step in (-maxStep, +maxStep) — biased slightly toward centre
  // to prevent the value from hugging the rails for long periods.
  const centre    = (min + max) / 2;
  const pull      = (centre - current) * 0.05;        // gentle mean-reversion
  const noise     = (Math.random() * 2 - 1) * maxStep; // uniform noise
  const newValue  = current + noise + pull;

  const clamped = Math.min(max, Math.max(min, newValue));
  return parseFloat(clamped.toFixed(decimals));
}

/**
 * Occasionally returns a larger step (10 Hz) instead of the normal 5 Hz.
 * Probability of a big jump: ~15% of ticks.
 */
function frequencyStep() {
  return Math.random() < 0.15 ? 10 : 5;
}

// ── Seed initial values if not yet set ───────────────────────────
function ensureInitialised() {
  if (sensorState.frequency === null) {
    sensorState.frequency = parseFloat(
      (Math.random() * (230 - 180) + 180).toFixed(2)
    );
  }
  if (sensorState.humidity === null) {
    sensorState.humidity = parseFloat(
      (Math.random() * (49 - 40) + 40).toFixed(2)
    );
  }
  if (sensorState.temperature === null) {
    const { min, max } = getTemperatureRange();
    sensorState.temperature = parseFloat(
      (Math.random() * (max - min) + min).toFixed(2)
    );
  }
}

// ── Build next payload (drift from previous state) ────────────────
function buildPayload() {
  msgCounter++;
  ensureInitialised();

  const tempRange = getTemperatureRange();

  // Frequency: max step is 5 Hz normally, 10 Hz occasionally
  sensorState.frequency = drift(
    sensorState.frequency,
    frequencyStep(),
    HARD_LIMITS.frequency.min,
    HARD_LIMITS.frequency.max,
    2
  );

  // Temperature: drifts slowly (±0.3 °C per tick), stays in time-based range
  sensorState.temperature = drift(
    sensorState.temperature,
    0.3,
    tempRange.min,
    tempRange.max,
    2
  );

  // Humidity: drifts very slowly (±0.5 % per tick)
  sensorState.humidity = drift(
    sensorState.humidity,
    0.5,
    HARD_LIMITS.humidity.min,
    HARD_LIMITS.humidity.max,
    2
  );

  return {
    message_id:    `${HARDWARE_CODE}_${msgCounter}`,
    hardware_code: HARDWARE_CODE,
    temperature:   sensorState.temperature,
    humidity:      sensorState.humidity,
    frequency:     sensorState.frequency,
  };
}

// ── Publish ───────────────────────────────────────────────────────
function publishTelemetry() {
  if (!isConnected) {
    console.warn("[MQTT] Not connected — skipping publish");
    return;
  }

  const payload = buildPayload();
  lastPayload     = payload;
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
    username:        MQTT_USERNAME,
    password:        MQTT_PASSWORD,
    clientId:        `ESP32-${HARDWARE_CODE}`,
    reconnectPeriod: 5000,
    keepalive:       60,
  });

  mqttClient.on("connect", () => {
    isConnected = true;
    console.log("[MQTT] ✓ Connected");

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
app.get("/status", (req, res) => {
  const tempRange = getTemperatureRange();
  const hour = new Date().getHours();
  const period = (hour >= 5 && hour < 18) ? "daytime (5am–6pm)" : "nighttime (6pm–5am)";

  res.json({
    mqtt_connected:    isConnected,
    hardware_code:     HARDWARE_CODE,
    topic:             TOPIC,
    interval_minutes:  10,
    messages_sent:     msgCounter,
    last_published_at: lastPublishedAt,
    last_payload:      lastPayload,
    current_sensor_state: sensorState,
    active_ranges: {
      frequency:   HARD_LIMITS.frequency,
      temperature: { ...tempRange, period },
      humidity:    HARD_LIMITS.humidity,
    },
  });
});

app.post("/publish-now", (req, res) => {
  if (!isConnected) {
    return res.status(503).json({ error: "MQTT not connected" });
  }
  publishTelemetry();
  res.json({ success: true, payload: lastPayload });
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));

//── Boot ──────────────────────────────────────────────────────────
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