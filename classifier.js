/**
 * classifier.js
 * Basketball shot classifier — JavaScript port of shot_classifier.py.
 *
 * Matches the Python implementation exactly:
 *   - BaselineCalibrator: MAD-filtered per-axis baselines, 3-second window
 *   - ShotClassifier: same state machine (IDLE → IMPACT_DETECTED → BLACKOUT)
 */

'use strict';

// ---------------------------------------------------------------------------
// BaselineCalibrator
// ---------------------------------------------------------------------------

class BaselineCalibrator {
  static CALIBRATION_DURATION = 3.0;  // seconds
  static MAD_K                = 2.5;
  static MIN_SAMPLES          = 10;

  constructor() {
    this._ax = []; this._ay = []; this._az = [];
    this._gx = []; this._gy = []; this._gz = [];
    this._sr = [];
    this._startTime     = null;   // packet-timestamp base (for finalize check)
    this._wallStartTime = null;   // performance.now() base (for progress display)
    this._complete  = false;

    // Public baselines — null until complete
    this.accelX    = null; this.accelY    = null; this.accelZ    = null;
    this.gyroX     = null; this.gyroY     = null; this.gyroZ     = null;
    this.signalRate = null;
  }

  get isComplete() { return this._complete; }

  get progress() {
    if (this._wallStartTime === null) return 0;
    if (this._complete) return 1;
    return Math.min(
      (performance.now() / 1000 - this._wallStartTime) / BaselineCalibrator.CALIBRATION_DURATION,
      1
    );
  }

  /** @returns {boolean} true the moment calibration finishes */
  addSample(accel, gyro, distance, signalRate, timestampSec) {
    if (this._complete) return false;

    const t = timestampSec ?? (performance.now() / 1000);
    if (this._startTime === null) {
      this._startTime     = t;
      this._wallStartTime = performance.now() / 1000;
    }

    if (t - this._startTime >= BaselineCalibrator.CALIBRATION_DURATION)
      return this._finalize();

    this._ax.push(accel[0]); this._ay.push(accel[1]); this._az.push(accel[2]);
    this._gx.push(gyro[0]);  this._gy.push(gyro[1]);  this._gz.push(gyro[2]);
    if (distance !== 0xFFFE && distance !== 65534)
      this._sr.push(signalRate);
    return false;
  }

  // ── internal ──────────────────────────────────────────────────────────────

  static _median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  static _madMean(samples) {
    if (!samples.length) return null;
    if (samples.length < 4) return samples.reduce((a, b) => a + b, 0) / samples.length;
    const med  = BaselineCalibrator._median(samples);
    const devs = samples.map(x => Math.abs(x - med));
    const mad  = BaselineCalibrator._median(devs);
    if (mad === 0) return med;
    const inliers = samples.filter(x => Math.abs(x - med) <= BaselineCalibrator.MAD_K * mad);
    return inliers.length ? inliers.reduce((a, b) => a + b, 0) / inliers.length : med;
  }

  _finalize() {
    const n = this._ax.length;
    if (n < BaselineCalibrator.MIN_SAMPLES) {
      console.warn(`Baseline skipped: only ${n} samples`);
      this._complete = true;
      return true;
    }
    this.accelX    = BaselineCalibrator._madMean(this._ax);
    this.accelY    = BaselineCalibrator._madMean(this._ay);
    this.accelZ    = BaselineCalibrator._madMean(this._az);
    this.gyroX     = BaselineCalibrator._madMean(this._gx);
    this.gyroY     = BaselineCalibrator._madMean(this._gy);
    this.gyroZ     = BaselineCalibrator._madMean(this._gz);
    this.signalRate = this._sr.length ? BaselineCalibrator._madMean(this._sr) : null;
    this._complete  = true;
    console.log(
      `✅ Baseline | ` +
      `AcX=${this.accelX.toFixed(3)} AcY=${this.accelY.toFixed(3)} AcZ=${this.accelZ.toFixed(3)} g | ` +
      `SR=${this.signalRate?.toFixed(1) ?? 'n/a'}`
    );
    return true;
  }
}

// ---------------------------------------------------------------------------
// ThresholdConfig
// ---------------------------------------------------------------------------

class ThresholdConfig {
  constructor() {
    this.IMPACT_ACCEL_THRESHOLD         = 1;    // g above baseline
    this.TOF_DISTANCE_THRESHOLD_HIGH    = 400;  // mm
    this.TOF_DISTANCE_THRESHOLD_LOW     = 80;   // mm
    this.TOF_SIGNAL_RATE_THRESHOLD      = 800;
    this.MAX_TIME_AFTER_IMPACT          = 1.5;  // s
    this.BLACKOUT_WINDOW                = 1.0;  // s
  }
}

// ---------------------------------------------------------------------------
// ShotClassifier
// ---------------------------------------------------------------------------

const STATE = Object.freeze({
  IDLE:             'IDLE',
  IMPACT_DETECTED:  'IMPACT_DETECTED',
  BASKET_DETECTED:  'BASKET_DETECTED',
  BLACKOUT:         'BLACKOUT',
});

class ShotClassifier {
  constructor(config) {
    this.config     = config ?? new ThresholdConfig();
    this.calibrator = new BaselineCalibrator();
    this._mpuQueue  = [];   // {ts, magnitude}
    this._tofQueue  = [];   // {ts, distance, signalRate}
    this.completedShots = [];

    this.state          = STATE.IDLE;
    this.stateStartTime = null;
    this.impactTime     = null;
  }

  reset() {
    this._mpuQueue  = [];
    this._tofQueue  = [];
    this.completedShots = [];
    this.state          = STATE.IDLE;
    this.stateStartTime = null;
    this.impactTime     = null;
    this.calibrator     = new BaselineCalibrator();
  }

  /**
   * Process one batch of sensor samples.
   * @param {Array} batch  Each element: {accel, gyro, distance, mpu_ts, tof_ts, signal_rate}
   * @returns {Array} newly completed shots
   */
  processBatch(batch) {
    const INVALID = new Set([0xFFFE, 65534, 0xFFFF, 65535, -1]);

    for (const s of batch) {
      const accel      = s.accel;
      const gyro       = s.gyro;
      const distance   = s.distance;
      const signalRate = s.signal_rate;
      const mpuTs      = s.mpu_ts / 1000.0;
      const tofTs      = s.tof_ts / 1000.0;

      // Always feed calibrator until window closes
      if (!this.calibrator.isComplete)
        this.calibrator.addSample(accel, gyro, distance, signalRate, mpuTs);

      // Hard gate: no queue insertion before baseline is ready
      if (!this.calibrator.isComplete) continue;

      const dx = accel[0] - this.calibrator.accelX;
      const dy = accel[1] - this.calibrator.accelY;
      const dz = accel[2] - this.calibrator.accelZ;
      this._mpuQueue.push({ ts: mpuTs, magnitude: Math.sqrt(dx*dx + dy*dy + dz*dz) });

      if (!INVALID.has(distance))
        this._tofQueue.push({ ts: tofTs, distance, signalRate });
    }

    const completed = [];
    while (this._mpuQueue.length || this._tofQueue.length) {
      const mpu = this._mpuQueue[0] ?? null;
      const tof = this._tofQueue[0] ?? null;
      if (!mpu && !tof) break;

      let shot;
      if (mpu && tof) {
        if (mpu.ts < tof.ts) {
          this._mpuQueue.shift();
          shot = this._processSample('mpu', mpu.ts, mpu.magnitude, null, null);
        } else {
          this._tofQueue.shift();
          shot = this._processSample('tof', tof.ts, null, tof.distance, tof.signalRate);
        }
      } else if (mpu) {
        this._mpuQueue.shift();
        shot = this._processSample('mpu', mpu.ts, mpu.magnitude, null, null);
      } else {
        this._tofQueue.shift();
        shot = this._processSample('tof', tof.ts, null, tof.distance, tof.signalRate);
      }
      if (shot) completed.push(shot);
    }

    this.completedShots.push(...completed);
    return completed;
  }

  _processSample(type, ts, magnitude, distance, signalRate) {
    // Exit blackout if expired
    if (this.state === STATE.BLACKOUT &&
        ts >= this.stateStartTime + this.config.BLACKOUT_WINDOW) {
      this.state          = STATE.IDLE;
      this.stateStartTime = null;
    }

    let shot = null;
    const cfg = this.config;

    if (this.state === STATE.IDLE) {
      if (type === 'mpu' && magnitude > cfg.IMPACT_ACCEL_THRESHOLD) {
        this.state          = STATE.IMPACT_DETECTED;
        this.stateStartTime = ts;
        this.impactTime     = ts;
      } else if (type === 'tof' && this._isBasketEvent(distance, signalRate)) {
        shot = { impact_time: null, basket_time: ts,
                 classification: 'MAKE', basket_type: 'SWISH', confidence: 0.85 };
        this.state          = STATE.BLACKOUT;
        this.stateStartTime = ts;
      }

    } else if (this.state === STATE.IMPACT_DETECTED) {
      const elapsed = ts - this.impactTime;
      if (elapsed > cfg.MAX_TIME_AFTER_IMPACT) {
        shot = { impact_time: this.impactTime, basket_time: null,
                 classification: 'MISS', basket_type: null, confidence: 0.85 };
        this.state          = STATE.IDLE;
        this.stateStartTime = ts;
      } else if (type === 'tof' && this._isBasketEvent(distance, signalRate)) {
        shot = { impact_time: this.impactTime, basket_time: ts,
                 classification: 'MAKE', basket_type: 'BANK', confidence: 0.95 };
        this.state          = STATE.BLACKOUT;
        this.stateStartTime = ts;
      }
    }

    return shot;
  }

  _isBasketEvent(distance, signalRate) {
    const cfg = this.config;
    return distance < cfg.TOF_DISTANCE_THRESHOLD_HIGH &&
           distance > cfg.TOF_DISTANCE_THRESHOLD_LOW  &&
           signalRate > cfg.TOF_SIGNAL_RATE_THRESHOLD;
  }
}

export { BaselineCalibrator, ThresholdConfig, ShotClassifier };
