/**
 * ble.js
 * Web Bluetooth layer — mirrors data_receiver.py / show_score_qt.py BLE logic.
 *
 * Usage:
 *   const ble = new BLEReceiver(onPacket, onStatus);
 *   await ble.connect();
 *   ble.disconnect();
 */

'use strict';

const SERVICE_UUID = 'e3a00001-1d1e-4c0c-b23a-9d9a4c5f7ad1';
const CHAR_UUID    = 'e3a00002-1d1e-4c0c-b23a-9d9a4c5f7ad1';

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
  }

  get connected() {
    return this._device?.gatt?.connected ?? false;
  }

  get deviceName() {
    return this._device?.name ?? null;
  }

  /**
   * Open the browser BLE picker, connect, and subscribe to notifications.
   * Resolves when the notify subscription is active.
   * Rejects if the user cancels or the connection fails.
   */
  async connect() {
    this._onStatus('scanning', 'Opening BLE device picker…');
    try {
      this._device = await navigator.bluetooth.requestDevice({
        filters:          [{ name: 'ESP32-Basketball' }],
        optionalServices: [SERVICE_UUID],
      });
    } catch (err) {
      this._onStatus('cancelled', err.message);
      throw err;
    }

    this._device.addEventListener('gattserverdisconnected', () => {
      this._onStatus('disconnected', 'GATT server disconnected');
    });

    this._onStatus('connecting', `Connecting to ${this._device.name}…`);
    try {
      this._server = await this._device.gatt.connect();
      const service  = await this._server.getPrimaryService(SERVICE_UUID);
      this._char     = await service.getCharacteristic(CHAR_UUID);
      this._char.addEventListener('characteristicvaluechanged', (evt) => {
        this._onPacket(evt.target.value);
      });
      await this._char.startNotifications();
      this._onStatus('connected', `Connected — MTU negotiated by browser`);
    } catch (err) {
      this._onStatus('error', err.message);
      throw err;
    }
  }

  disconnect() {
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
}
