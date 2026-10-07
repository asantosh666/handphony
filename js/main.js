// Handphony — week-1 spike. Hands-first WebXR conducting.
// Right hand height -> pentatonic melody (C4..C6, 11 zones).
// Right pinch      -> capture last phrase as a looping arpeggio / clear it.
// Left hand height -> pad chords: low = I (C), mid = vi (Am),
//                     high = IV (F) / V (G), alternating on each fresh entry.
// Left palm open   -> swell (pad lowpass + level); fist -> dampen.

import * as THREE from 'three';
import { AudioEngine, PENT_MIDIS } from './audio.js';
import { HandTracker } from './hands.js';
import { Visuals, pitchColor } from './visuals.js';

const CHORDS = [
  { name: 'C',  midis: [60, 64, 67], root: 48 }, // I
  { name: 'Am', midis: [57, 60, 64], root: 45 }, // vi
  { name: 'F',  midis: [53, 57, 60], root: 41 }, // IV
  { name: 'G',  midis: [55, 59, 62], root: 43 }, // V
];

const overlay = document.getElementById('enter');
const statusEl = document.getElementById('status');

let renderer = null;
let xrCamera = null;
let audio = null;
let visuals = null;
const trackers = new Map(); // handedness -> HandTracker

let noteHistory = [];       // {midi, t} of recent melody notes (audio clock)
let chordIdx = 0;
let highToggle = 0;         // high zone alternates F / G on each fresh entry
let lastLeftZone = -1;
let swellSm = 0.5;
let melAmp = 0, loopAmp = 0, bassAmp = 0;
let lastT = 0;
let dtG = 0.016;
let sessionT0 = 0;
let htNagShown = false;
let handsEverSeen = false;
const tmpColor = new THREE.Color();

function setStatus(t) { statusEl.textContent = t; }

init();

async function init() {
  if (!('xr' in navigator)) { setStatus('WebXR is not available in this browser.'); return; }
  let ok = false;
  try { ok = await navigator.xr.isSessionSupported('immersive-vr'); } catch (e) { ok = false; }
  if (!ok) { setStatus('Immersive VR is not supported on this device/browser.'); return; }

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  document.getElementById('app').appendChild(renderer.domElement);

  xrCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 60);

  visuals = new Visuals();
  audio = new AudioEngine();

  overlay.addEventListener('click', enter);
  window.addEventListener('resize', () => {
    if (!renderer) return;
    xrCamera.aspect = window.innerWidth / window.innerHeight;
    xrCamera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

async function enter() {
  overlay.classList.add('hidden');
  try {
    if (!audio.ready) await audio.init();
  } catch (e) {
    setStatus('Audio could not start: ' + e.message);
    overlay.classList.remove('hidden');
    return;
  }
  audio.setChord(CHORDS[0].midis, CHORDS[0].root);

  let session;
  try {
    session = await navigator.xr.requestSession('immersive-vr', {
      requiredFeatures: ['local'],
      optionalFeatures: ['hand-tracking'],
    });
  } catch (e) {
    setStatus('Could not start the VR session.');
    overlay.classList.remove('hidden');
    return;
  }
  await renderer.xr.setSession(session);
  sessionT0 = performance.now() / 1000;
  session.addEventListener('end', () => {
    overlay.classList.remove('hidden');
    setStatus('Tap to re-enter');
    renderer.setAnimationLoop(null);
  });
  lastT = performance.now();
  renderer.setAnimationLoop(tick);
}

function getTracker(h) {
  if (!trackers.has(h)) {
    // 'local' space: origin ~ headset. Seated hand range roughly [-0.45, +0.55].
    // Bounds expand outward only as the user moves (per-hand calibration).
    const tr = h === 'right'
      ? new HandTracker(h, 11, -0.45, 0.55, -0.7, 0.9)
      : new HandTracker(h, 3, -0.45, 0.55, -0.7, 0.9);
    trackers.set(h, tr);
    if (h === 'right') visuals.setLadderRange(tr.lo, tr.hi);
  }
  return trackers.get(h);
}

function handleRight(tr, ev) {
  const color = pitchColor(ev.zone, 11, tmpColor);
  visuals.followLadder(tr.pos.x, tr.pos.z, dtG);
  visuals.setLadderRange(tr.lo, tr.hi);
  visuals.setLadderActive(ev.zone, color);

  if (ev.zoneChanged) {
    const midi = PENT_MIDIS[ev.zone];
    audio.playMelody(midi);
    const now = audio.ctx.currentTime;
    noteHistory.push({ midi, t: now });
    noteHistory = noteHistory.filter(n => now - n.t < 8);
    if (noteHistory.length > 40) noteHistory.splice(0, noteHistory.length - 40);
    visuals.spawnBurst(tr.pos, color);
    visuals.spawnRipple(tr.pos, color);
    melAmp = 1;
    visuals.hidePrompt();
  }

  if (ev.pinched) {
    if (audio.looping) {
      audio.stopLoop();
      visuals.setLoop(false);
    } else {
      const now = audio.ctx.currentTime;
      const recent = noteHistory.filter(n => now - n.t < 8).slice(-24);
      if (recent.length >= 2) {
        const t0 = recent[0].t;
        audio.startLoop(recent.map(n => ({ midi: n.midi, dt: n.t - t0 })));
        visuals.setLoop(true);
      }
    }
  }
}

function handleLeft(tr, ev) {
  // Chord zones: low = I, mid = vi, high = IV/V alternating per fresh entry.
  const z = ev.zone;
  let ci = chordIdx;
  if (z === 0) ci = 0;
  else if (z === 1) ci = 1;
  else if (z === 2) {
    if (z !== lastLeftZone) {
      ci = highToggle ? 3 : 2;
      highToggle = 1 - highToggle;
    } else {
      ci = chordIdx;
    }
  }
  lastLeftZone = z;
  if (ci !== chordIdx) {
    chordIdx = ci;
    audio.setChord(CHORDS[ci].midis, CHORDS[ci].root);
  }
  // Palm swell, ~120ms smoothing.
  const k = 1 - Math.exp(-dtG / 0.12);
  swellSm += (ev.openness - swellSm) * k;
  audio.setSwell(swellSm);
}

function tick(time, frame) {
  const nowS = time / 1000;
  dtG = Math.min(0.05, Math.max(0.001, (time - lastT) / 1000));
  lastT = time;
  const dt = dtG;

  const session = renderer.xr.getSession();
  const refSpace = renderer.xr.getReferenceSpace();
  if (frame && session && refSpace) {
    for (const src of session.inputSources) {
      if (!src.hand) continue;
      const h = src.handedness;
      if (h !== 'left' && h !== 'right') continue;
      const tr = getTracker(h);
      const ev = tr.update(src, frame, refSpace, nowS, dt);
      if (!ev.tracked) continue;
      handsEverSeen = true;
      if (h === 'right') handleRight(tr, ev);
      else handleLeft(tr, ev);
    }
    if (!htNagShown && !handsEverSeen && nowS - sessionT0 > 8) {
      htNagShown = true;
      visuals.setPromptText('enable hand tracking');
    }
  }

  // Audio loop scheduler + amplitude followers for the pillars.
  audio.update();
  if (audio.melPulse) { melAmp = 1; audio.melPulse = 0; }
  if (audio.loopPulse) { loopAmp = 1; audio.loopPulse = 0; }
  if (audio.bassPulse) { bassAmp = 1; audio.bassPulse = 0; }
  melAmp *= Math.exp(-dt * 3.2);
  loopAmp *= Math.exp(-dt * 3.2);
  bassAmp *= Math.exp(-dt * 2.6);

  visuals.setPillar(0, melAmp);
  visuals.setPillar(1, 0.15 + 0.75 * swellSm);
  visuals.setPillar(2, loopAmp);
  visuals.setPillar(3, bassAmp);
  visuals.update(dt);

  renderer.render(visuals.scene, xrCamera);
}
