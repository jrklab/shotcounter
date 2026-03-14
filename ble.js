/**
 * ble.js
 * Web Bluetooth layer — mirrors data_receiver.py / show_score_qt.py BLE logic.
 *
 * Auto-reconnect: on connect(), the browser's remembered-device list is
 * checked first (getDevices API).  If the device has been paired before the
 * connection happens without the OS picker.  First-time use still requires the
 * picker; every subsequent session is automatic.
 *
 * Usage:
 *   const ble = new BLEReceiver(onPacket, onStatus);
 *   await ble.connect();
 *   ble.disconnect();
 */

'use strict';

const DEVICE_NAME  = 'ESP32-Basketball';
const SERVICE_UUID = 'e3a00001-1d1e-4c0c-b23a-9d9a4c5f7ad1';
const CHAR_UUID    = 'e3a00002-1d1e-4c0c-b23a-9d9a4c5f7ad1';

// ── Device Information Service reader ─────────────────────────────────────────
/**
 * Read all Device Information Service (UUID 0x180A) characteristics from the
 * connected GATT server.  Returns an object stored as window.deviceMeta so
 * every screen can access it without re-reading BLE.
 *
 * @param {BluetoothRemoteGATTServer} server
 * @returns {Promise<{manufacturer, model, hwRevision, fwRevision, systemId}|null>}
 */
async function readDeviceMetadata(server) {
  // Mobile Web Bluetooth (Chrome Android, Safari iOS) allows only ONE ATT
  // operation in-flight at a time.  Promise.all() causes requests 2-5 to
  // fail immediately with "GATT operation already in progress".  Read each
  // characteristic sequentially to work on all platforms.
  const read = async (dis, uuid) => {
    try {
      const chr = await dis.getCharacteristic(uuid);
      const val = await chr.readValue();
      return new TextDecoder().decode(val);
    } catch (_) { return ''; }
  };

  try {
    const dis = await server.getPrimaryService('device_information');
    const mfr   = await read(dis, 0x2A29);
    const model  = await read(dis, 0x2A24);
    const hwRev  = await read(dis, 0x2A27);
    const fwRev  = await read(dis, 0x2A26);
    const sysId  = await read(dis, 0x2A23);
    const meta = { manufacturer: mfr, model, hwRevision: hwRev, fwRevision: fwRev, systemId: sysId };
    console.log('[BLE] DIS device info:', meta);
    return meta;
  } catch (e) {
    console.warn('[BLE] DIS read failed:', e.message);
    return null;
  }
}

export class BLEReceiver {
  /**
   * @param {(data: DataView) => void} onPacket  raw BLE notification payload
   * @param {(state: string, detail?: string) => void} onStatus  status updates
   */
  constructor(onPacket, onStatus) {
    this._onPacket  = onPacket;
    this._onStatus  = onStatus;
    this._device    = null;
    this._server    = null;
    this._char      = null;
    this._watchAbort = null;   // AbortController for watchAdvertisements
    this._latestRssi = null;  // last known RSSI (dBm), latched across (dis)connects
  }

  get connected() {
    return this._device?.gatt?.connected ?? false;
  }

  get deviceName() {
    return this._device?.name ?? null;
  }

  /**
   * Connect to the sensor device.
   *
   * Strategy:
   *   1. If navigator.bluetooth.getDevices() is available (Chrome 85+), look
   *      for a previously-approved device named DEVICE_NAME and connect
   *      directly — no picker shown.
   *   2. Otherwise fall back to the standard requestDevice() picker.
   *
   * Resolves when the notify subscription is active.
   * Rejects if the user cancels or the connection fails.
   */
  async connect() {
    // ── 1. Try to auto-connect to a previously paired device ─────────────
    if (typeof navigator.bluetooth.getDevices === 'function') {
      try {
        const knownDevices = await navigator.bluetooth.getDevices();
        const known = knownDevices.find(d => d.name === DEVICE_NAME);
        if (known) {
          this._onStatus('connecting', `Auto-connecting to ${known.name}…`);
          this._device = known;
          this._attachDisconnectListener();
          await this._scanRssi();
          return await this._subscribeAndNotify();
        }
      } catch (_) {
        // getDevices() can fail in some environments; fall through to picker
      }
    }

    // ── 2. First time: show the OS device picker ──────────────────────────
    this._onStatus('scanning', 'Opening BLE device picker…');
    try {
      this._device = await navigator.bluetooth.requestDevice({
        filters:          [{ name: DEVICE_NAME }],
        optionalServices: [SERVICE_UUID, 'device_information'],
      });
    } catch (err) {
      this._onStatus('cancelled', err.message);
      throw err;
    }

    this._attachDisconnectListener();
    this._onStatus('connecting', `Connecting to ${this._device.name}…`);
    await this._scanRssi();  // wait briefly for one advertisement to capture RSSI
    return await this._subscribeAndNotify();
  }

  disconnect() {
    if (this._watchAbort) {
      this._watchAbort.abort();
      this._watchAbort = null;
    }
    if (this._char) {
      this._char.stopNotifications().catch(() => {});
      this._char = null;
    }
    if (this._device?.gatt?.connected) {
      this._device.gatt.disconnect();
    }
    this._server = null;
    this._onStatus('disconnected', 'Disconnected by user');
  }

  // ── Private helpers ────────────────────────────────────────────────────

  _attachDisconnectListener() {
    this._device.addEventListener('gattserverdisconnected', () => {
      this._onStatus('disconnected', 'GATT server disconnected');
    });
  }

  async _subscribeAndNotify() {
    try {
      this._server   = await this._device.gatt.connect();

      // ── Read Device Information Service (DIS 0x180A) ────────────────────
      // Stores Manufacturer, Model, HW/FW Revision and MAC into window.deviceMeta
      // so the setup screen and active bar can display them.
      window.deviceMeta = await readDeviceMetadata(this._server);

      const service  = await this._server.getPrimaryService(SERVICE_UUID);
      this._char     = await service.getCharacteristic(CHAR_UUID);
      this._char.addEventListener('characteristicvaluechanged', (evt) => {
        this._onPacket(evt.target.value);
      });
      await this._char.startNotifications();
      this._onStatus('connected', 'Connected — MTU negotiated by browser');
      // Re-emit the latched RSSI immediately so the UI shows it right away
      if (this._latestRssi != null) this._onStatus('rssi', this._latestRssi);
    } catch (err) {
      this._onStatus('error', err.message);
      throw err;
    }
  }

  /**
   * Watch advertisements briefly to capture RSSI, then stop.
   * Waits up to RSSI_SCAN_MS for one advertisementreceived event.
   * Silently skips if watchAdvertisements is not supported.
   */
  async _scanRssi(timeoutMs = 1500) {
    if (typeof this._device.watchAdvertisements !== 'function') return;
    if (this._watchAbort) { this._watchAbort.abort(); }
    this._watchAbort = new AbortController();

    await new Promise((resolve) => {
      const onAdv = (evt) => {
        if (evt.rssi != null) {
          this._latestRssi = evt.rssi;
          this._onStatus('rssi', evt.rssi);
        }
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
      const cleanup = () => {
        this._device.removeEventListener('advertisementreceived', onAdv);
        clearTimeout(timer);
        if (this._watchAbort) { this._watchAbort.abort(); this._watchAbort = null; }
      };
      this._device.addEventListener('advertisementreceived', onAdv);
      this._device.watchAdvertisements({ signal: this._watchAbort.signal })
        .catch(() => { cleanup(); resolve(); });
    });
  }
}
