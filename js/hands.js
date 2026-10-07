// Handphony — hand tracking via the WebXR Hand Input API.
// Right hand: CONTINUOUS pitch control (theremin principle). A 0.40m
// vertical window auto-centers once per session on the relaxed hand height;
// hand height maps continuously to the 11-note pentatonic set (quantized,
// ~60ms smoothing kills boundary flutter from micro-tremor). Expand-only:
// pushing past an edge grows that edge by 0.05m per frame, capped at
// +0.10m per edge so the window can't bloat into fatigue.
// Left hand: discrete chord zones (3cm hysteresis + 80ms dwell, unchanged).
// Both: thumb-index pinch state machine (25mm engage / 35mm release,
// 90ms debounce, 150ms double-fire guard), palm openness from
// fingertip-to-wrist distances (expand-only calibration, ~120ms smoothing).

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

// Bone topology as index pairs into JOINT_NAMES: wrist -> each finger's
// metacarpal, then the joint chains, plus a palm fan across metacarpals.
export const HAND_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],          // thumb
  [0, 5], [5, 6], [6, 7], [7, 8], [8, 9],  // index
  [0, 10], [10, 11], [11, 12], [12, 13], [13, 14], // middle
  [0, 15], [15, 16], [16, 17], [17, 18], [18, 19], // ring
  [0, 20], [20, 21], [21, 22], [22, 23], [23, 24], // pinky
  [5, 10], [10, 15], [15, 20],             // palm fan
];

export class HandTracker {
  // zones: number of discrete height zones (left hand chords).
  // lo/hi + loClamp/hiClamp: expand-only Y bounds, left hand only.
  // continuous: right-hand theremin mode (0.40m auto-centering window).
  constructor(handedness, zones, lo, hi, loClamp, hiClamp, continuous = false) {
    this.handedness = handedness;
    this.zones = zones;
    this.lo = lo; this.hi = hi;
    this.loClamp = loClamp; this.hiClamp = hiClamp;
    this.continuous = continuous;
    this.zone = -1;
    // Continuous pitch window (right hand): auto-centered once on the
    // relaxed hand; edges expand-only, capped at +0.10m per edge.
    this.centered = false;
    this.winLo = 0; this.winHi = 0;
    this.winLo0 = 0; this.winHi0 = 0;
    this.ySm = 0;
    this.noteIdx = -1;
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
    // Joint data for hand visualization: FIXED indices into JOINT_NAMES
    // (never compacted, so bone topology stays valid) + a validity mask.
    this.jointPos = new Float32Array(25 * 3);
    this.jointValid = new Uint8Array(25);
    this.jointCount = 0;
  }

  update(src, frame, refSpace, now, dt) {
    const ev = { zoneChanged: false, zone: -1, noteChanged: false, noteIdx: -1, pinched: false, pinchHeld: false, pinchReleased: false, openness: this.openness, tracked: false };
    if (!src.hand) return ev;

    const wrist = jointPos(src.hand, frame, refSpace, 'wrist', this._a);
    if (!wrist) { this.tracked = false; return ev; }
    this.tracked = true;
    ev.tracked = true;

    const palm = jointPos(src.hand, frame, refSpace, 'middle-finger-metacarpal', this._b);
    this.pos.copy(palm || wrist);
    const y = this.pos.y;

    // Adaptive height bounds (left hand only): expand outward only,
    // never shrink (stable chord zones).
    if (!this.continuous) {
      if (y < this.lo) this.lo = Math.max(y, this.loClamp);
      if (y > this.hi) this.hi = Math.min(y, this.hiClamp);
    }

    // Joint data at FIXED indices (bone topology stays valid) + validity.
    let jc = 0;
    for (let i = 0; i < JOINT_NAMES.length; i++) {
      const j = src.hand.get(JOINT_NAMES[i]);
      const p = j ? frame.getJointPose(j, refSpace) : null;
      if (p) {
        const v = p.transform.position;
        this.jointPos[i * 3] = v.x;
        this.jointPos[i * 3 + 1] = v.y;
        this.jointPos[i * 3 + 2] = v.z;
        this.jointValid[i] = 1;
        jc++;
      } else {
        this.jointValid[i] = 0;
      }
    }
    this.jointCount = jc;

    if (this.continuous) {
      // Continuous pitch window: auto-center ONCE on the relaxed hand
      // height, then map height continuously to the note set (quantized).
      // Edges expand-only (+0.05m/frame toward the hand, capped at +0.10m
      // per edge) so the mapping can't drift into fatigue.
      if (!this.centered) {
        this.winLo = this.winLo0 = y - 0.20;
        this.winHi = this.winHi0 = y + 0.20;
        this.centered = true;
        this.ySm = y;
      } else {
        if (y < this.winLo) this.winLo = Math.max(y, this.winLo - 0.05, this.winLo0 - 0.10);
        if (y > this.winHi) this.winHi = Math.min(y, this.winHi + 0.05, this.winHi0 + 0.10);
      }
      // ~60ms smoothing: micro-tremor can't flutter the quantization
      // boundary; the audio portamento glide covers the lag.
      const k = 1 - Math.exp(-dt / 0.06);
      this.ySm += (y - this.ySm) * k;
      const span = Math.max(1e-4, this.winHi - this.winLo);
      const t = Math.max(0, Math.min(1, (this.ySm - this.winLo) / span));
      const idx = Math.round(t * (this.zones - 1));
      if (this.noteIdx < 0) {
        this.noteIdx = idx; // first frame: adopt silently, no event
      } else if (idx !== this.noteIdx) {
        this.noteIdx = idx;
        ev.noteChanged = true;
      }
      ev.noteIdx = this.noteIdx;
    } else {
      // Zone with 3cm hysteresis on the boundary + 80ms dwell: a new zone
      // only commits once the hand has stayed past the boundary for 80ms,
      // which kills machine-gun chord changes from hand waver.
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
    }

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
          // Release edge: true only if this engagement registered a pinch.
          // Song select / song-complete use RELEASE for tap actions so a
          // 1.5s hold can mean something else without double-firing.
          ev.pinchReleased = this.fired;
          this.pinch = 'open';
          this.fired = false;
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
