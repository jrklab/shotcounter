# Architecture & Flow: Smart Hoop Data Engine

## Project Overview
A serverless web application and data collection engine for an ESP32-C3 based basketball shot tracker. The app connects to the edge device via Web Bluetooth (BLE), runs real-time ML inference (1D-CNN) using incoming sensor data (200Hz MPU6050 + 40Hz VL53L1X ToF), and pushes user-verified training data to Google Firebase.

## Technology Stack
* **Frontend Environment:** Vanilla HTML/JS/CSS, hosted on GitHub Pages.
* **Edge Connectivity:** Web Bluetooth API (`navigator.bluetooth`).
* **Media Capture:** WebRTC / MediaRecorder API.
* **Machine Learning:** JavaScript Web Worker (runs the pre-trained classifier without blocking the UI thread).
* **Backend / Database:** Firebase Authentication, Cloud Firestore (NoSQL), Firebase Cloud Storage.

---

## UI / UX Navigation Flows

### 1. The Dashboard (Home Screen)
The landing page must be high-contrast and optimized for outdoor mobile use.
* **Header:** Displays logged-in user profile with an account-switcher dropdown.
* **Main Body:** Three primary, large touch-target buttons:
    * `[ 🏀 Practice Now ]`
    * `[ 📊 Review Practice History ]`
    * `[ ⚙️ Firmware Update ]`

---

### 2. Flow: "Practice Now" (Active Data Engine)

#### Step A: Setup & Sync
* **Action:** User taps `[ Connect Sensor ]`. Web Bluetooth pairs with the ESP32-C3. App requests camera permissions.
* **Gate:** The `[ Start Practice ]` button remains disabled until BLE and Camera are both active. Clicking "Start" acts as the user gesture to unlock the Web Audio API.

#### Step B: Active Session (Live Tracker)
* **UI:** Full-screen camera feed with a high-contrast scoreboard overlay showing `Makes / Total`, `Percentage`, and `Last Shot Result`.
* **Background Logic:** 1. Browser receives continuous BLE streams (MPU at 200Hz, ToF at 40Hz).
    2. A Web Worker scans for acceleration spikes (e.g., Z-axis > 1.5G) to identify a 2-second "Event Window".
    3. The Web Worker passes the 2-second array to the live classifier.
* **Feedback:** The app uses Web Audio API (or `speechSynthesis`) to announce the classification result immediately (e.g., "Swish", "Miss").
* **Gate:** User taps a large `[ 🛑 Stop Practice ]` button to end the session.

#### Step C: Review & Label (Active Learning)
* **UI:** A carousel interface displaying the 2-second video clips for each detected event.
* **Action:** The UI prominently displays the classifier's automated prediction.
    * *Example:* **"AI Prediction: 🟢 CLEAN SWISH"**
* **User Input:** * If correct: User taps `[ 👍 Confirm ]`.
    * If incorrect: User taps `[ ✏️ Correct It ]` and selects from: `Swish`, `Rim-In`, `Miss`, or `False Alarm`.
* **Gate:** User must review and confirm/correct all events before uploading.

#### Step D: Upload & Reward
* **Action:** The app uploads the `.webm` video chunks to Firebase Storage. It uploads the verified JSON data (Timestamps, Sensor Arrays, AI_Prediction, User_Verified_Label, Video_URL) to Cloud Firestore.
* **UI:** Shows a "Session Complete" summary and routes back to the Dashboard.

---

### 3. Flow: "Review Practice History" (Analytics)
* **UI:** A scrollable dashboard querying Cloud Firestore for the active `User_ID`.
* **Lifetime Stats:** Total shots, overall accuracy.
* **Trend Chart:** A line graph (e.g., using Chart.js) showing shooting percentage over the last 10 sessions.
* **Session Log:** A chronological list of past practices. Expanding a session shows the breakdown (Swishes vs. Rim-Ins vs. Misses).

---

### 4. Flow: "Firmware Update" (OTA Provisioning)
* **UI:** A configuration screen comparing the `Current Device Version` (read via BLE characteristic) with the `Latest Available Version` (queried from a metadata document in Firestore or GitHub Releases).
* **Action:** User taps `[ Update Firmware ]`.
* **Background Logic:** 1. The app fetches the latest `firmware.bin` file.
    2. The JS logic chunks the binary file into MTU-sized packets (e.g., 512 bytes).
    3. Packets are written sequentially to a dedicated "OTA Write" BLE characteristic on the ESP32-C3.
* **Feedback:** A live progress bar tracks the byte transfer.
* **Completion:** The ESP32-C3 verifies the MD5 hash, flashes the partition, and automatically reboots. The app alerts the user of a successful update and returns to the Dashboard.



---

## Database Schema Reference (Firestore)

**Collection:** `shots`
* `Document_ID`: (Auto-generated)
* `User_ID`: String (Matches Firebase Auth UID)
* `Timestamp`: Unix Epoch
* `AI_Prediction`: String
* `User_Verified_Label`: String
* `Comments`: String (Optional)
* `Sensor_Data_MPU`: Array of Floats (200Hz window)
* `Sensor_Data_ToF`: Array of Integers (40Hz window)
* `Video_URL`: String (Firebase Storage download link)


I have get firebase set up already, and here is the firebase API

// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAB5-_z8v1P8p79bPc2WvH3k3m86Ds-zuI",
  authDomain: "basketball-tracker-data.firebaseapp.com",
  projectId: "basketball-tracker-data",
  storageBucket: "basketball-tracker-data.firebasestorage.app",
  messagingSenderId: "433195026716",
  appId: "1:433195026716:web:7072995f00768232e812d9",
  measurementId: "G-PB1ZGDNLJE"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);