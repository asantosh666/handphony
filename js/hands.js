// Handphony — hand tracking via the WebXR Hand Input API.
// Per-hand state: adaptive height bounds (expand-only), scale-degree zones
// with 3cm boundary hysteresis, thumb-index pinch state machine
// (25mm engage / 35mm release, 90ms debounce, 150ms double-fire guard),
// and palm openness from fingertip-to-wrist distances (expand-only
// calibration, ~120ms smoothing).

import * as THREE from 'three';

function jointPos(hand, frame, refSpace, name, out) {
  const j = hand.get(name);
  if (!j) return null;
  const p = frame.getJointPose(j, refSpace);
  if (!p) return null;
  const v = p.transform.position;
  return out.set(v.x, v.y, v.z);
}

const TIP_NAMES = [
  'index-finger-tip',
  'middle-finger-tip',
  'ring-finger-tip',
  'pinky-finger-tip',
];

// All 25 XRHand joints, for the hand-visualization constellation.
const JOINT_NAMES = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
];

export class HandTracker {
  // zones: number of discrete height zones; lo/hi: initial Y bounds (meters,
  // 'local' reference space, origin ~ headset); loClamp/hiClamp: hard limits.
  constructor(handedness, zones, lo, hi, loClamp, hiClamp) {
    this.handedness = handedness;
    this.zones = zones;
    this.lo = lo; this.hi = hi;
    this.loClamp = loClamp; this.hiClamp = hiClamp;
    this.zone = -1;
    this.tracked = false;
    this.pos = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._c = new THREE.Vector3();
    // Pinch state machine.
    this.pinch = 'open';
    this.engageT = 0;
    this.fired = false;
    this.lastFire = -1e9;
    // Palm openness calibration.
    this.oMin = 0.085;
    this.oMax = 0.185;
    this.openness = 0.55;
    // 80ms zone dwell (anti-waver): candidate zone + entry time.
    this.pendingZone = -1;
    this.pendingT = 0;
    // Pinch-hold edge (onboarding skip) + pinch point for flash feedback.
    this.pinchHeld = false;
    this.pinchPos = new THREE.Vector3();
    this.pinchPosValid = false;
    // Joint constellation for hand visualization (25 XRHand joints).
    this.jointPos = new Float32Array(25 * 3);
    this.jointCount = 0;
  }

  update(src, frame, refSpace, now, dt) {
    const ev = { zoneChanged: false, zone: -1, pinched: false, pinchHeld: false, openness: this.openness, tracked: false };
    if (!src.hand) return ev;

    const wrist = jointPos(src.hand, frame, refSpace, 'wrist', this._a);
    if (!wrist) { this.tracked = false; return ev; }
    this.tracked = true;
    ev.tracked = true;

    const palm = jointPos(src.hand, frame, refSpace, 'middle-finger-metacarpal', this._b);
    this.pos.copy(palm || wrist);
    const y = this.pos.y;

    // Adaptive height bounds: expand outward only, never shrink (stable zones).
    if (y < this.lo) this.lo = Math.max(y, this.loClamp);
    if (y > this.hi) this.hi = Math.min(y, this.hiClamp);

    // Joint constellation for the hand-visualization points (compact prefix).
    let jc = 0;
    for (let i = 0; i < JOINT_NAMES.length; i++) {
      const j = src.hand.get(JOINT_NAMES[i]);
      const p = j ? frame.getJointPose(j, refSpace) : null;
      if (p) {
        const v = p.transform.position;
        this.jointPos[jc * 3] = v.x;
        this.jointPos[jc * 3 + 1] = v.y;
        this.jointPos[jc * 3 + 2] = v.z;
        jc++;
      }
    }
    this.jointCount = jc;

    // Zone with 3cm hysteresis on the boundary + 80ms dwell: a new zone
    // only commits once the hand has stayed past the boundary for 80ms,
    // which kills machine-gun notes from hand waver.
    const span = this.hi - this.lo;
    let raw = Math.floor(((y - this.lo) / span) * this.zones);
    raw = Math.max(0, Math.min(this.zones - 1, raw));
    if (this.zone < 0) {
      this.zone = raw;
      this.pendingZone = -1;
    } else if (raw !== this.zone) {
      const boundary = this.lo + (Math.max(raw, this.zone) * span) / this.zones;
      if (Math.abs(y - boundary) >= 0.03) {
        if (this.pendingZone !== raw) {
          this.pendingZone = raw;
          this.pendingT = now;
        } else if (now - this.pendingT >= 0.08) {
          this.zone = raw;
          this.pendingZone = -1;
          ev.zoneChanged = true;
        }
      } else {
        this.pendingZone = -1;
      }
    } else {
      this.pendingZone = -1;
    }
    ev.zone = this.zone;

    // Pinch: thumb-tip to index-tip distance.
    const th = jointPos(src.hand, frame, refSpace, 'thumb-tip', this._b);
    const ix = jointPos(src.hand, frame, refSpace, 'index-finger-tip', this._c);
    if (th && ix) {
      this.pinchPos.copy(th).add(ix).multiplyScalar(0.5);
      this.pinchPosValid = true;
      const d = th.distanceTo(ix);
      if (this.pinch === 'open' && d < 0.025) {
        this.pinch = 'engaged';
        this.engageT = now;
        this.fired = false;
      } else if (this.pinch === 'engaged') {
        if (d > 0.035) {
          this.pinch = 'open';
        } else if (!this.fired && now - this.engageT > 0.09) {
          if (now - this.lastFire > 0.15) { ev.pinched = true; this.lastFire = now; }
          this.fired = true;
        }
      }
    } else {
      this.pinchPosValid = false;
    }
    // Pinch-hold edge: engaged continuously for 1.5s (onboarding skip).
    const heldNow = this.pinch === 'engaged' && (now - this.engageT) > 1.5;
    ev.pinchHeld = heldNow && !this.pinchHeld;
    this.pinchHeld = heldNow;

    // Palm openness: mean fingertip-to-wrist distance, calibrated expand-only.
    let sum = 0, n = 0;
    for (const nm of TIP_NAMES) {
      const p = jointPos(src.hand, frame, refSpace, nm, this._c);
      if (p) { sum += p.distanceTo(wrist); n++; }
    }
    if (n > 0) {
      const d = sum / n;
      if (d < this.oMin) this.oMin = Math.max(d, 0.05);
      if (d > this.oMax) this.oMax = Math.min(d, 0.26);
      const rawO = Math.max(0, Math.min(1, (d - this.oMin) / Math.max(1e-4, this.oMax - this.oMin)));
      const k = 1 - Math.exp(-dt / 0.12); // ~120ms smoothing
      this.openness += (rawO - this.openness) * k;
    }
    ev.openness = this.openness;
    return ev;
  }
}
