/**
 * parser.js
 * Packet parser — exact JavaScript port of _parse_and_classify() from show_score_qt.py.
 *
 * Packet layout (little-endian fields use big-endian "!" in Python struct — network byte order):
 *   [0:4]   pkt_ts      uint32  ESP32 ms timestamp
 *   [4:6]   seq_id      uint16
 *   [6:7]   num_mpu     uint8
 *   [7 + i*14] for i in range(num_mpu):
 *       ts_delta  uint16
 *       ax ay az  int16 ×3
 *       gx gy gz  int16 ×3
 *   [7 + num_mpu*14]         num_tof  uint8
 *   [7 + num_mpu*14 + 1 + i*6] for i in range(8):   (always 8 slots)
 *       ts_delta  uint16
 *       distance  uint16
 *       sr        uint16
 */

'use strict';

const ACCEL_SENSITIVITY = 2048.0;   // LSB/g  for ±16g
const GYRO_SENSITIVITY  = 16.384;   // LSB/°/s for ±2000°/s
const SAMPLES_PER_PACKET = 20;

export class PacketParser {
  constructor() {
    this._lastSeq = -1;
    this._pending = [];     // {accel, gyro, distance, mpu_ts, tof_ts, signal_rate}
  }

  reset() {
    this._lastSeq = -1;
    this._pending = [];
  }

  /**
   * Parse one BLE notification DataView.
   * @returns {{ batch: Array|null, lostPackets: number }}
   *   batch is null if the packet was stale/duplicate.
   */
  parse(view) {
    if (view.byteLength < 7) return { batch: null, lostPackets: 0 };

    const pktTs  = view.getUint32(0, false);   // big-endian (network order)
    const seqId  = view.getUint16(4, false);
    const numMpu = view.getUint8(6);

    // ── sequence check ────────────────────────────────────────────────
    let lostPackets = 0;
    if (this._lastSeq >= 0) {
      const gap = (seqId - this._lastSeq) & 0xFFFF;
      if (gap === 0 || (seqId < this._lastSeq &&
                        !(this._lastSeq > 60000 && seqId < 5000))) {
        return { batch: null, lostPackets: 0 };   // stale / duplicate
      }
      if (gap > 1) lostPackets = gap - 1;
    }
    this._lastSeq = seqId;

    // ── MPU samples ───────────────────────────────────────────────────
    const mpuSamples = [];
    for (let i = 0; i < numMpu; i++) {
      const off     = 7 + i * 14;
      const tsDelta = view.getUint16(off, false);
      const ax = view.getInt16(off + 2,  false) / ACCEL_SENSITIVITY;
      const ay = view.getInt16(off + 4,  false) / ACCEL_SENSITIVITY;
      const az = view.getInt16(off + 6,  false) / ACCEL_SENSITIVITY;
      const gx = view.getInt16(off + 8,  false) / GYRO_SENSITIVITY;
      const gy = view.getInt16(off + 10, false) / GYRO_SENSITIVITY;
      const gz = view.getInt16(off + 12, false) / GYRO_SENSITIVITY;
      mpuSamples.push({ accel: [ax, ay, az], gyro: [gx, gy, gz], ts: pktTs - tsDelta });
    }

    // ── TOF samples ───────────────────────────────────────────────────
    const tofOff  = 7 + numMpu * 14;
    const numTof  = view.getUint8(tofOff);
    const tofSamples = [];
    for (let i = 0; i < 8; i++) {
      const off      = tofOff + 1 + i * 6;
      const tsDelta  = view.getUint16(off,     false);
      const distance = view.getUint16(off + 2, false);
      const sr       = view.getUint16(off + 4, false);
      if (i < numTof)
        tofSamples.push({ distance, ts: pktTs - tsDelta, sr });
    }

    // ── pair MPU + TOF ────────────────────────────────────────────────
    for (let i = 0; i < mpuSamples.length; i++) {
      const { accel, gyro, ts: mpuTs } = mpuSamples[i];
      let distance = 0xFFFE, tofTs = mpuTs, sr = 0;
      if (i < tofSamples.length) {
        ({ distance, ts: tofTs, sr } = tofSamples[i]);
      }
      this._pending.push({ accel, gyro, distance, mpu_ts: mpuTs, tof_ts: tofTs, signal_rate: sr });
    }

    // ── return a batch when we have a full packet's worth ─────────────
    if (this._pending.length >= SAMPLES_PER_PACKET) {
      const batch    = this._pending;
      this._pending  = [];
      return { batch, lostPackets };
    }
    return { batch: null, lostPackets };
  }
}
