/**
 * ota-ble.js
 * BLE OTA firmware updater — JavaScript port of ota_update.py.
 *
 * Protocol (must match ble_ota.cpp):
 *   1. Connect to the OTA GATT service.
 *   2. Subscribe to OTA_STATUS notifications.
 *   3. Write CMD_START (0x01) + uint32-LE firmware size to OTA_CTRL.
 *   4. Stream firmware chunks to OTA_DATA (write-without-response).
 *   5. Write CMD_END (0x02) to OTA_CTRL.
 *   6. Wait for the device to reboot (STATUS: "OTA_OK" or similar).
 *
 * Firmware source:
 *   https://raw.githubusercontent.com/jrklab/shotcounter_beta/main/fw/firmware.bin
 *   Version string read from fw/version.txt in the same branch.
 *
 * Usage (ES module):
 *   import { OtaUpdater } from './ota-ble.js';
 *   const ota = new OtaUpdater(onProgress);
 *   const { version, size } = await ota.fetchLatestRelease();   // check for update
 *   await ota.connect();         // BLE pair
 *   await ota.flash();           // stream firmware, fires onProgress(pct, msg)
 */

'use strict';

const DEVICE_NAME       = 'ESP32-Basketball';
const OTA_SERVICE_UUID  = 'c3f9a2b0-4a5e-11ee-be56-0242ac120002';
const OTA_CTRL_UUID     = 'c3f9a2b1-4a5e-11ee-be56-0242ac120002';
const OTA_DATA_UUID     = 'c3f9a2b2-4a5e-11ee-be56-0242ac120002';
const OTA_STATUS_UUID   = 'c3f9a2b3-4a5e-11ee-be56-0242ac120002';

const CMD_START         = 0x01;
const CMD_END           = 0x02;

const CHUNK_SIZE        = 496;  // MTU(512) - 3 ATT header - 13 padding, same as Python script
// I will copy this to a public repo at shotcounter/. I will change the URL manually to reflect that. Don't change it back
const FIRMWARE_URL      = 'https://raw.githubusercontent.com/jrklab/shotcounter_beta/main/fw/firmware.bin';
const VERSION_URL       = 'https://raw.githubusercontent.com/jrklab/shotcounter_beta/main/fw/version.txt';

// ── Sensor data service (also needed in optional services list for OTA flow) ──
const SENSOR_SERVICE_UUID = 'e3a00001-1d1e-4c0c-b23a-9d9a4c5f7ad1';

export class OtaUpdater {
  /**
   * @param {(percent: number, message: string) => void} onProgress
   * @param {(message: string) => void} onStatus
   */
  constructor(onProgress = () => {}, onStatus = () => {}) {
    this._onProgress = onProgress;
    this._onStatus   = onStatus;
    this._device     = null;
    this._server     = null;
    this._firmware   = null;       // ArrayBuffer
    this._releaseInfo = null;      // { version, size, downloadUrl, tagName }
    this._aborted    = false;
    this._endSent    = false;      // true once CMD_END is dispatched; GATT drop after = success
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Query GitHub Releases API for the latest firmware asset.
   * @returns {{ version: string, size: number, tagName: string, downloadUrl: string }}
   */
  async fetchLatestRelease() {
    this._onStatus('Checking for latest firmware…');

    // Read version string from fw/version.txt in the repo
    let version = 'unknown';
    try {
      const vResp = await fetch(VERSION_URL);
      if (vResp.ok) version = (await vResp.text()).trim();
    } catch (_) { /* version stays 'unknown' */ }

    // HEAD request to determine file size without downloading the binary
    // NOTE: This will return 404 if shotcounter_beta is a private repo — raw.githubusercontent.com
    // does not serve private files to unauthenticated browser requests. Make the repo public or
    // move fw/ files to a public repo/CDN.
    const headResp = await fetch(FIRMWARE_URL, { method: 'HEAD' });
    if (!headResp.ok) {
      if (headResp.status === 404) {
        throw new Error(
          `fw/firmware.bin not found (HTTP 404). Ensure the file is committed to a public repo at ${FIRMWARE_URL}`);
      }
      throw new Error(`Firmware check failed (HTTP ${headResp.status})`);
    }
    const cl   = headResp.headers.get('content-length');
    const size = cl ? parseInt(cl, 10) : 0;

    this._releaseInfo = { version, size, downloadUrl: FIRMWARE_URL };
    return { ...this._releaseInfo };
  }

  /**
   * Download the firmware binary. Call after fetchLatestRelease().
   * Fires onProgress with download percentage.
   */
  async downloadFirmware() {
    if (!this._releaseInfo) throw new Error('Call fetchLatestRelease() first.');
    this._onStatus('Downloading firmware…');
    const resp = await fetch(this._releaseInfo.downloadUrl);
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);

    const total = this._releaseInfo.size || parseInt(resp.headers.get('content-length') || '0');
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) this._onProgress(Math.round(received / total * 30), `Downloading: ${Math.round(received / total * 100)}%`);
    }

    const blob = new Blob(chunks);
    this._firmware = await blob.arrayBuffer();
    this._onStatus(`Downloaded ${(this._firmware.byteLength / 1024).toFixed(0)} KB`);
  }

  /**
   * Open the Web Bluetooth device picker and pair with the ESP32.
   * Must be called from a user gesture.
   */
  async connect() {
    this._onStatus('Opening BLE device picker…');
    try {
      this._device = await navigator.bluetooth.requestDevice({
        filters:          [{ name: DEVICE_NAME }],
        optionalServices: [OTA_SERVICE_UUID, SENSOR_SERVICE_UUID],
      });
    } catch (err) {
      this._onStatus(`Pairing cancelled: ${err.message}`);
      throw err;
    }
    this._onStatus(`Connecting to ${this._device.name}…`);
    this._server = await this._device.gatt.connect();
    this._onStatus('Connected');
  }

  disconnect() {
    if (this._device?.gatt?.connected) {
      this._device.gatt.disconnect();
    }
    this._device = null;
    this._server = null;
  }

  abort() {
    this._aborted = true;
  }

  /**
   * Stream the downloaded firmware to the device.
   * Call connect() and downloadFirmware() first.
   */
  async flash() {
    if (!this._server?.connected) throw new Error('Not connected — call connect() first.');
    if (!this._firmware)          throw new Error('No firmware — call downloadFirmware() first.');
    this._aborted  = false;
    this._endSent  = false;   // becomes true the moment CMD_END is dispatched

    const service    = await this._server.getPrimaryService(OTA_SERVICE_UUID);
    const ctrlChar   = await service.getCharacteristic(OTA_CTRL_UUID);
    const dataChar   = await service.getCharacteristic(OTA_DATA_UUID);
    const statusChar = await service.getCharacteristic(OTA_STATUS_UUID);

    // Subscribe to status notifications
    const statusMessages = [];
    statusChar.addEventListener('characteristicvaluechanged', (evt) => {
      const msg = new TextDecoder().decode(evt.target.value);
      statusMessages.push(msg);
      this._onStatus(`Device: ${msg}`);
    });
    await statusChar.startNotifications();

    // Send START command: 0x01 + uint32-LE firmware size
    const size      = this._firmware.byteLength;
    const startCmd  = new Uint8Array(5);
    startCmd[0]     = CMD_START;
    new DataView(startCmd.buffer).setUint32(1, size, true);  // little-endian
    this._onStatus(`Sending START (${(size / 1024).toFixed(0)} KB)…`);
    await ctrlChar.writeValueWithResponse(startCmd);

    // Small delay for the device to prepare the OTA partition
    await new Promise(r => setTimeout(r, 500));

    if (statusMessages.some(m => m.includes('ERR'))) {
      throw new Error(`Device rejected OTA START: ${statusMessages.at(-1)}`);
    }

    // Stream firmware chunks
    const data     = new Uint8Array(this._firmware);
    let   offset   = 0;
    let   chunkNum = 0;

    this._onStatus('Uploading firmware…');
    while (offset < size) {
      if (this._aborted) throw new Error('OTA aborted by user');

      const end   = Math.min(offset + CHUNK_SIZE, size);
      const chunk = data.subarray(offset, end);

      // write-without-response is faster (mirrors Python's write GATT char)
      await dataChar.writeValueWithoutResponse(chunk);

      offset   += chunk.length;
      chunkNum += 1;

      // Throttle: every 10 chunks yield to keep the browser responsive
      if (chunkNum % 10 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }

      // Progress: 30-95% is upload (first 30% was download)
      const uploadPct = offset / size;
      this._onProgress(30 + Math.round(uploadPct * 65), `Uploading: ${Math.round(uploadPct * 100)}%`);
    }

    // Send END
    this._onStatus('Sending END — device is verifying…');
    this._endSent = true;   // any GATT error from here on = device rebooted = success
    try {
      await ctrlChar.writeValueWithResponse(new Uint8Array([CMD_END]));
    } catch (endErr) {
      // Device can reboot before it ACKs CMD_END — treat GATT disconnect as success
      if (/gatt|network error|disconnect/i.test(endErr.message ?? '')) {
        this._onProgress(100, 'Device rebooted — OTA successful!');
        this._onStatus('✅ OTA success — device rebooted during END ack');
        return true;
      }
      throw endErr;
    }
    this._onProgress(98, 'Verifying…');

    // Wait up to 15 seconds for success or error status.
    // If the BLE link drops (device reboots) the poll just times-out — that is still a pass.
    const success = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 15_000);  // null = timed out
      const check = setInterval(() => {
        if (statusMessages.some(m => m.includes('OTA_OK') || m.includes('OK') || m.includes('reboot'))) {
          clearTimeout(timer); clearInterval(check); resolve(true);
        }
        if (statusMessages.some(m => m.includes('ERR') || m.includes('FAIL'))) {
          clearTimeout(timer); clearInterval(check); resolve(false);
        }
      }, 300);
    });

    // null = timed out with no explicit error — END was sent, treat as likely pass
    const didSucceed = success !== false;
    this._onProgress(100, didSucceed ? 'Update complete! Device rebooting…' : 'Warning: device reported an error');
    this._onStatus(didSucceed ? '✅ OTA success — device rebooting' : '⚠️ OTA END sent but device reported FAIL');

    // Device will disconnect when it reboots; clean up gracefully
    try { await statusChar.stopNotifications(); } catch (_) {}
    return didSucceed;
  }

  get hasRelease()  { return this._releaseInfo !== null; }
  get hasFirmware() { return this._firmware !== null; }
  get connected()   { return this._device?.gatt?.connected ?? false; }
  get releaseInfo() { return this._releaseInfo; }
}
