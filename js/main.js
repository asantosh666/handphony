// Handphony — hands-first WebXR conducting (core mechanic redesigned
// after playtest 2: zone triggers felt like tiring whole-arm button
// presses, so the instrument is now a theremin).
// Right hand height -> CONTINUOUS quantized pitch: a 0.40m window
//   auto-centers once on the relaxed hand; height maps continuously to
//   11 pentatonic notes (C4..C6) with a ~70ms portamento glide. The voice
//   sustains while the hand is tracked; note EVENTS fire only when the
//   quantized note changes (particles, ladder, loop capture).
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
let rightLastSeen = -1e9;   // nowS of the last tracked right-hand frame
let melodyLive = false;     // sustained voice has started this session
const tmpColor = new THREE.Color();

// ---- guided onboarding (rewritten for the theremin mechanic) -----------
// One large floating instruction at a time (reuses the prompt sprite at
// 1.6x). Starts on the first frame with a tracked hand — never at an
// empty room. The first two steps teach the continuous-pitch feel:
// move and HEAR the mapping, then explore tiny movements. Skip:
// pinch-and-HOLD 1.5s at any point -> free play.
let ob = null;    // {step, phase, until, count, noteUntil}
let obDone = false;
const OB_STEPS = [
  { instr: 'Move your hand slowly up and down', conf: 'You are the pitch' },
  { instr: 'Tiny movements — your hand is the pitch', conf: null }, // 4s free explore, auto-advance
  { instr: 'Open your left palm', conf: 'Your palm swells the strings' },
  { instr: 'Make a fist', conf: 'A fist hushes them' },
  { instr: 'Pinch thumb and finger', conf: 'You captured a loop' },
];

function obStart() {
  ob = { step: 0, phase: 'instr', until: 0, count: 0, noteUntil: 0 };
  visuals.setPromptBig();
  visuals.showPrompt();
  visuals.setPromptText(OB_STEPS[0].instr);
}

function obAdvance(nowS) {
  ob.phase = 'confirm';
  ob.until = nowS + 2.0;
  visuals.setPromptText(OB_STEPS[ob.step].conf);
}

function obNext(nowS) {
  ob.step++;
  if (ob.step >= OB_STEPS.length) {
    ob.phase = 'conduct';
    ob.until = nowS + 3.0;
    visuals.setPromptText('Conduct.');
  } else {
    ob.phase = 'instr';
    visuals.setPromptText(OB_STEPS[ob.step].instr);
    if (ob.step === 1) ob.until = nowS + 4.0; // timed free explore
    // Already looping from an early pinch -> treat the pinch step as done.
    if (ob.step === 4 && audio.looping) obAdvance(nowS);
  }
}

function obSkip() {
  ob = null;
  obDone = true;
  visuals.hidePrompt();
}

function obTick(nowS) {
  if (!ob) return;
  if (ob.noteUntil && nowS >= ob.noteUntil) {
    ob.noteUntil = 0;
    if (ob.phase === 'instr') visuals.setPromptText(OB_STEPS[ob.step].instr);
  }
  // Step 1 (tiny movements): 4s of free explore, then auto-advance.
  if (ob.phase === 'instr' && ob.step === 1 && nowS >= ob.until) { obNext(nowS); return; }
  if (ob.phase === 'confirm' && nowS >= ob.until) obNext(nowS);
  else if (ob.phase === 'conduct' && nowS >= ob.until) {
    ob = null;
    obDone = true;
    visuals.hidePrompt();
  }
}

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
    visuals.hideHandViz('left');
    visuals.hideHandViz('right');
    audio.setMelodyLevel(0);
    // Fresh auto-center + silent voice start on the next session.
    for (const tr of trackers.values()) {
      tr.centered = false;
      tr.noteIdx = -1;
      tr.ySm = 0;
    }
    rightLastSeen = -1e9;
    melodyLive = false;
    renderer.setAnimationLoop(null);
  });
  lastT = performance.now();
  renderer.setAnimationLoop(tick);
}

function getTracker(h) {
  if (!trackers.has(h)) {
    // Right hand: continuous theremin mode — the 0.40m window auto-centers
    // on the first tracked frame, so lo/hi are unused (zeros).
    // Left hand: 3 chord zones with expand-only bounds ('local' space,
    // origin ~ headset; seated hand range roughly [-0.45, +0.55]).
    const tr = h === 'right'
      ? new HandTracker(h, 11, 0, 0, 0, 0, true)
      : new HandTracker(h, 3, -0.45, 0.55, -0.7, 0.9);
    trackers.set(h, tr);
    if (h === 'right') visuals.setLadderRange(-0.2, 0.2); // placeholder until auto-center
  }
  return trackers.get(h);
}

function handleRight(tr, ev, nowS) {
  // Continuous quantized pitch (theremin principle): the voice sustains
  // while the hand is tracked and glides between quantized notes.
  // Note EVENTS fire only when the quantized note changes — these drive
  // particles, the ladder, and the 8s loop capture. No zone triggers,
  // no dwell: the hand IS the pitch.
  const color = pitchColor(ev.noteIdx, 11, tmpColor);
  visuals.setLadderRange(tr.winLo, tr.winHi);
  visuals.setLadderActive(ev.noteIdx, color);

  audio.setMelodyNote(PENT_MIDIS[ev.noteIdx], !melodyLive);
  melodyLive = true;
  audio.setMelodyLevel(1);
  rightLastSeen = nowS;

  if (ev.noteChanged) {
    const midi = PENT_MIDIS[ev.noteIdx];
    const now = audio.ctx.currentTime;
    noteHistory.push({ midi, t: now });
    noteHistory = noteHistory.filter(n => now - n.t < 8);
    if (noteHistory.length > 40) noteHistory.splice(0, noteHistory.length - 40);
    visuals.spawnBurst(tr.pos, color);
    visuals.spawnRipple(tr.pos, color);
    visuals.flashPitchCursor();
    // Onboarding step 0: two quantized changes prove they hear the mapping.
    if (ob && ob.phase === 'instr' && ob.step === 0) {
      ob.count++;
      if (ob.count >= 2) obAdvance(nowS);
    }
  }

  // Onboarding skip: pinch-and-hold 1.5s jumps straight to free play.
  if (ob && ev.pinchHeld) obSkip();

  if (ev.pinched) {
    if (tr.pinchPosValid) visuals.pinchFlash(tr.pinchPos);
    if (audio.looping) {
      audio.stopLoop();
      visuals.setLoop(false);
      visuals.showLoopLabel('loop cleared', 1.8);
    } else {
      const now = audio.ctx.currentTime;
      const recent = noteHistory.filter(n => now - n.t < 8).slice(-24);
      if (recent.length >= 2) {
        const t0 = recent[0].t;
        audio.startLoop(recent.map(n => ({ midi: n.midi, dt: n.t - t0 })));
        visuals.setLoop(true);
        visuals.showLoopLabel('looping', 3);
        if (ob && ob.phase === 'instr' && ob.step === 4) obAdvance(nowS);
      } else if (ob && ob.phase === 'instr' && ob.step === 4) {
        ob.noteUntil = nowS + 2.5;
        visuals.setPromptText('Play a few notes first, then pinch');
      }
    }
  }
}

function handleLeft(tr, ev, nowS) {
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

  // Onboarding: palm / fist steps key off left-hand openness.
  if (ob && ob.phase === 'instr') {
    if (ob.step === 2 && ev.openness > 0.75) obAdvance(nowS);
    else if (ob.step === 3 && ev.openness < 0.25) obAdvance(nowS);
  }
}

function tick(time, frame) {
  const nowS = time / 1000;
  dtG = Math.min(0.05, Math.max(0.001, (time - lastT) / 1000));
  lastT = time;
  const dt = dtG;

  const session = renderer.xr.getSession();
  const refSpace = renderer.xr.getReferenceSpace();
  if (frame && session && refSpace) {
    const seen = { left: false, right: false };
    for (const src of session.inputSources) {
      if (!src.hand) continue;
      const h = src.handedness;
      if (h !== 'left' && h !== 'right') continue;
      const tr = getTracker(h);
      const ev = tr.update(src, frame, refSpace, nowS, dt);
      if (!ev.tracked) continue;
      handsEverSeen = true;
      seen[h] = true;
      visuals.setHandViz(h, tr.jointPos, tr.jointValid, tr.pos);
      if (h === 'right') {
        visuals.setPitchCursor(tr.pos.y);
        handleRight(tr, ev, nowS);
      } else handleLeft(tr, ev, nowS);
    }
    for (const h of ['left', 'right']) if (!seen[h]) visuals.hideHandViz(h);
    // Sustained melody fades out when the right hand is lost (>0.4s untracked).
    if (nowS - rightLastSeen > 0.4) audio.setMelodyLevel(0);
    // Onboarding starts on the first frame with a tracked hand.
    if (!ob && !obDone && handsEverSeen) obStart();
    if (ob) obTick(nowS);
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
