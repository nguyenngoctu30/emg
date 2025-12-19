#include "Arduino.h"
#include "EMGFilters.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <WiFiClientSecure.h>

// ===== PIN CONFIGURATION =====
#define SensorInputPin1 0  // GPIO 0
#define SensorInputPin2 1  // GPIO 1

// ===== WIFI CONFIGURATION =====
const char* ssid = "677 5G";
const char* password = "10101010";
const char* serverAddress = "https://dimension-remarks-promising-notebooks.trycloudflare.com";  
const char* endpoint = "/api/emg";

// ===== SAMPLING CONFIGURATION =====
const unsigned long SAMPLING_INTERVAL_US = 1000;  // 1ms = 1000Hz
const int SAMPLES_PER_FRAME = 10;  // Gửi 10 samples mỗi frame (100Hz frame rate)
const unsigned long FRAME_INTERVAL_MS = 10;  // Gửi frame mỗi 10ms

// ===== FRAME BUFFER =====
struct EMGSample {
    unsigned long timestamp;  // microseconds
    int raw1;
    int ema1;
    int raw2;
    int ema2;
};

EMGSample frameBuffer[SAMPLES_PER_FRAME];
int bufferIndex = 0;
unsigned long frameSequence = 0;
unsigned long lastSampleTime = 0;
unsigned long lastFrameSendTime = 0;

// ===== EMG & FILTER OBJECTS =====
EMGFilters myFilter1;
EMGFilters myFilter2;

// ===== FILTER CONFIGURATION =====
SAMPLE_FREQUENCY sampleRate = SAMPLE_FREQ_1000HZ;
NOTCH_FREQUENCY humFreq = NOTCH_FREQ_50HZ;

// ===== BASELINE CALIBRATION =====
int baseline1 = 0;
int baseline2 = 0;
bool baselineCalibrated = false;
const int CALIBRATION_SAMPLES = 100;
int calibrationCount = 0;
long calibrationSum1 = 0;
long calibrationSum2 = 0;

// ===== EMA FILTER =====
#define ARRAY_SIZE 15
int dataArray1[ARRAY_SIZE];
int dataArray2[ARRAY_SIZE];
int arrayIndex1 = 0;
int arrayIndex2 = 0;
bool arrayFull1 = false;
bool arrayFull2 = false;
float emaValue1 = 0.0;
float emaValue2 = 0.0;
const float alpha = 0.35;

// ===== WIFI STATUS =====
bool wifiConnected = false;
WiFiClientSecure client;

// ===== TIMING STATS =====
unsigned long samplesCollected = 0;
unsigned long framesSent = 0;
unsigned long lastStatsTime = 0;

// ===== FUNCTION DECLARATIONS =====
void setupWiFi();
void sendFrameToServer();
void collectSample();

void setup() {
    Serial.begin(115200);
    delay(1000);
    
    Serial.println("=== ESP32-C6 Dual EMG Buffered Stream ===");
    Serial.println("Configuration:");
    Serial.printf("- Sampling Rate: %d Hz\n", 1000000 / SAMPLING_INTERVAL_US);
    Serial.printf("- Samples per Frame: %d\n", SAMPLES_PER_FRAME);
    Serial.printf("- Frame Rate: %d Hz\n", 1000 / FRAME_INTERVAL_MS);
    Serial.println("---");
    
    // ADC Configuration
    analogReadResolution(12);
    analogSetAttenuation(ADC_11db);
    
    // Initialize filters
    myFilter1.init(sampleRate, humFreq, true, true, true); 
    myFilter2.init(sampleRate, humFreq, true, true, true);

    // Initialize arrays
    for (int i = 0; i < ARRAY_SIZE; i++) {
        dataArray1[i] = 0;
        dataArray2[i] = 0;
    }
    
    // Setup WiFi
    setupWiFi();
    
    Serial.println(">>> CALIBRATING: Keep muscles relaxed for 3 seconds...");
    Serial.println("---");
}

void loop() {
    unsigned long currentTime = micros();
    
    // ===== PRECISE SAMPLING =====
    if (currentTime - lastSampleTime >= SAMPLING_INTERVAL_US) {
        lastSampleTime = currentTime;
        
        if (!baselineCalibrated) {
            // ===== CALIBRATION PHASE =====
            int raw1 = analogRead(SensorInputPin1);
            int raw2 = analogRead(SensorInputPin2);
            
            if (calibrationCount < CALIBRATION_SAMPLES) {
                calibrationSum1 += raw1;
                calibrationSum2 += raw2;
                calibrationCount++;
                
                if (calibrationCount % 20 == 0) {
                    Serial.printf("Calibrating... %d/%d\n", calibrationCount, CALIBRATION_SAMPLES);
                }
            } else {
                baseline1 = calibrationSum1 / CALIBRATION_SAMPLES;
                baseline2 = calibrationSum2 / CALIBRATION_SAMPLES;
                baselineCalibrated = true;
                
                Serial.println("✓ CALIBRATION COMPLETE!");
                Serial.printf("Baseline1: %d | Baseline2: %d\n", baseline1, baseline2);
                Serial.println("---");
                Serial.println("STREAMING STARTED");
                Serial.println("---");
                
                lastSampleTime = micros();
                lastFrameSendTime = millis();
            }
        } else {
            // ===== NORMAL SAMPLING =====
            collectSample();
        }
    }
    
    // ===== SEND FRAME WHEN BUFFER IS FULL =====
    if (baselineCalibrated && wifiConnected && bufferIndex >= SAMPLES_PER_FRAME) {
        sendFrameToServer();
        bufferIndex = 0;
        lastFrameSendTime = millis();
    }
    
    // ===== STATS REPORTING =====
    if (baselineCalibrated && millis() - lastStatsTime >= 5000) {
        lastStatsTime = millis();
        Serial.println("--- STATS ---");
        Serial.printf("Samples collected: %lu\n", samplesCollected);
        Serial.printf("Frames sent: %lu\n", framesSent);
        Serial.printf("Avg samples/sec: %lu\n", samplesCollected / 5);
        Serial.printf("WiFi: %s (RSSI: %d dBm)\n", 
                     wifiConnected ? "Connected" : "Disconnected", WiFi.RSSI());
        Serial.println("---");
        samplesCollected = 0;
        framesSent = 0;
    }
}

// ===== COLLECT SINGLE SAMPLE =====
void collectSample() {
    // Read RAW values
    int raw1 = analogRead(SensorInputPin1);
    int raw2 = analogRead(SensorInputPin2);
    
    // Normalize (remove DC offset)
    int normalized1 = raw1 - baseline1;
    int normalized2 = raw2 - baseline2;
    if (normalized1 < 0) normalized1 = 0;
    if (normalized2 < 0) normalized2 = 0;
    
    // Apply EMG filters
    int filtered1 = myFilter1.update(normalized1);
    int filtered2 = myFilter2.update(normalized2);
    if (filtered1 < 0) filtered1 = 0;
    if (filtered2 < 0) filtered2 = 0;

    // Moving Average for sensor 1
    dataArray1[arrayIndex1] = filtered1;
    arrayIndex1++;
    if (arrayIndex1 >= ARRAY_SIZE) {
        arrayIndex1 = 0;
        arrayFull1 = true;
    }

    // Moving Average for sensor 2
    dataArray2[arrayIndex2] = filtered2;
    arrayIndex2++;
    if (arrayIndex2 >= ARRAY_SIZE) {
        arrayIndex2 = 0;
        arrayFull2 = true;
    }

    // Calculate EMA for sensor 1
    int stableValue1 = 0;
    if (arrayFull1) {
        long sum1 = 0;
        for (int i = 0; i < ARRAY_SIZE; i++) sum1 += dataArray1[i];
        int average1 = sum1 / ARRAY_SIZE;
        emaValue1 = alpha * average1 + (1 - alpha) * emaValue1;
        stableValue1 = (int)emaValue1;
    }

    // Calculate EMA for sensor 2
    int stableValue2 = 0;
    if (arrayFull2) {
        long sum2 = 0;
        for (int i = 0; i < ARRAY_SIZE; i++) sum2 += dataArray2[i];
        int average2 = sum2 / ARRAY_SIZE;
        emaValue2 = alpha * average2 + (1 - alpha) * emaValue2;
        stableValue2 = (int)emaValue2;
    }
    
    // Store in buffer
    if (bufferIndex < SAMPLES_PER_FRAME) {
        frameBuffer[bufferIndex].timestamp = micros();
        frameBuffer[bufferIndex].raw1 = normalized1;
        frameBuffer[bufferIndex].ema1 = stableValue1;
        frameBuffer[bufferIndex].raw2 = normalized2;
        frameBuffer[bufferIndex].ema2 = stableValue2;
        bufferIndex++;
    }
    
    samplesCollected++;
}

// ===== SEND FRAME TO SERVER =====
void sendFrameToServer() {
    if (WiFi.status() != WL_CONNECTED) {
        if (wifiConnected) {
            Serial.println("✗ WiFi disconnected! Reconnecting...");
            wifiConnected = false;
            setupWiFi();
        }
        return;
    }

    HTTPClient http;
    client.setInsecure();

    String url = String(serverAddress) + endpoint;
    http.begin(client, url);
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(5000);  // 5 second timeout

    // Create JSON payload with frame data
    DynamicJsonDocument doc(2048);
    doc["deviceId"] = "ESP32_C6_001";
    doc["frameSequence"] = frameSequence++;
    doc["samplingRate"] = 1000000 / SAMPLING_INTERVAL_US;
    doc["samplesInFrame"] = bufferIndex;
    doc["frameTimestamp"] = millis();
    
    // Add samples array
    JsonArray samples = doc.createNestedArray("samples");
    for (int i = 0; i < bufferIndex; i++) {
        JsonObject sample = samples.createNestedObject();
        sample["t"] = frameBuffer[i].timestamp;
        
        JsonObject ch0 = sample.createNestedObject("ch0");
        ch0["raw"] = frameBuffer[i].raw1;
        ch0["ema"] = frameBuffer[i].ema1;
        
        JsonObject ch1 = sample.createNestedObject("ch1");
        ch1["raw"] = frameBuffer[i].raw2;
        ch1["ema"] = frameBuffer[i].ema2;
    }

    String body;
    serializeJson(doc, body);

    // Send HTTP POST
    int httpCode = http.POST(body);

    if (httpCode > 0) {
        if (httpCode == 200) {
            framesSent++;
            Serial.printf("✓ Frame #%lu sent (%d samples) - HTTP %d\n", 
                         frameSequence - 1, bufferIndex, httpCode);
        } else {
            Serial.printf("⚠ HTTP %d: %s\n", httpCode, http.getString().c_str());
        }
    } else {
        Serial.printf("✗ Send failed: %s\n", http.errorToString(httpCode).c_str());
    }

    http.end();
}

// ===== WIFI SETUP =====
void setupWiFi() {
    Serial.println("Connecting to WiFi...");
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, password);
    
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 20) {
        delay(500);
        Serial.print(".");
        attempts++;
    }
    
    if (WiFi.status() == WL_CONNECTED) {
        wifiConnected = true;
        Serial.println("\n✓ WiFi Connected!");
        Serial.printf("IP: %s | RSSI: %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    } else {
        wifiConnected = false;
        Serial.println("\n✗ WiFi Connection Failed!");
    }
    Serial.println("---");
}