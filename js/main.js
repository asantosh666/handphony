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

// ---- song mode: the purpose layer ------------------------------------
// Zones 0-10 = C4 D4 E4 G4 A4 C5 D5 E5 G5 A5 C6. hold=true: the target
// stays until the user HOLDS the matching pitch 350ms (vs 120ms normal),
// giving phrase endings weight. chord: the orchestra auto-follows with
// that pad chord when the note becomes the target (the left hand keeps
// swell/fist control; its chord zones rest during songs).
const N = (z, o = {}) => ({ z, hold: !!o.hold, chord: o.chord || null });
const SONGS = [
  {
    // Pentatonic adaptation: the original's F ("up a-bove the world so
    // high") isn't in the C pentatonic set, so the second phrase lands on
    // E5 instead — still instantly recognizable, never a wrong note.
    title: 'Twinkle Twinkle',
    notes: [
      N(5, { chord: 'I' }), N(5), N(8), N(8), N(9), N(9), N(8, { hold: true }),
      N(7, { chord: 'IV' }), N(7), N(6), N(6), N(5, { hold: true }),
    ],
  },
  {
    title: 'Mary Had a Little Lamb',
    notes: [
      N(2, { chord: 'I' }), N(1), N(0), N(1), N(2), N(2), N(2, { hold: true }),
      N(1), N(1), N(1, { hold: true }),
      N(2, { chord: 'V' }), N(3), N(3, { hold: true }),
      N(2, { chord: 'I' }), N(1), N(0), N(1), N(2), N(2), N(2), N(2),
      N(1), N(1), N(2), N(1), N(0, { hold: true }),
    ],
  },
  {
    title: 'Merrily We Roll Along',
    notes: [
      N(2, { chord: 'I' }), N(1), N(0), N(1), N(2), N(2), N(2, { hold: true }),
      N(1, { chord: 'V' }), N(1), N(1, { hold: true }),
      N(2, { chord: 'I' }), N(3), N(3, { hold: true }),
      N(2), N(1), N(0, { hold: true }),
    ],
  },
  {
    // VERIFY-CAREFULLY: G4 C5 C5 C5 E5 D5 | C5 D5 E5 C5 C5 D5 |
    // C5 A4 G4 A4 C5(hold) = "Should auld acquaintance be forgot / and
    // never brought to mind / should auld acquaintance be forgot" in C
    // major. Every note falls in the C pentatonic set (no F/B). Chords I/V/I.
    title: 'Auld Lang Syne',
    notes: [
      N(3, { chord: 'I' }), N(5), N(5), N(5), N(7), N(6),
      N(5, { chord: 'V' }), N(6), N(7), N(5), N(5), N(6),
      N(5, { chord: 'I' }), N(4), N(3), N(4), N(5, { hold: true }),
    ],
  },
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
const tmpV = new THREE.Vector3();

// ---- song mode state ---------------------------------------------------
// onboarding -> select -> song -> complete -> (select | song | free).
// Free play is the original conduct-anything mode; songs are the goal.
let mode = 'onboarding';
let songState = null;       // {songIdx, noteIdx, targetSince} while playing
let curSongIdx = -1;
let aimedOrb = -1;          // song-select orb under the right hand
let lastNoteChangeT = -1e9; // FX throttle clock (audio time)
const GOLD = new THREE.Color(0xffd76a);
const PILLAR_COLS = [0x7fb2ff, 0x9fe8d0, 0xffd27f, 0xb79fff];

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
    // Onboarding complete: into the songbook, not empty free play.
    ob = null;
    obDone = true;
    enterSelect();
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
  enterFree(); // the skip gesture means "I know this, just let me play"
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
}

// ---- song mode flow ----------------------------------------------------
// After onboarding, the app asks "Choose a song" instead of dropping the
// user into empty free play — the songbook is the purpose.
function enterSelect() {
  mode = 'select';
  songState = null;
  aimedOrb = -1;
  visuals.setSongTarget(-1);
  visuals.hideHud();
  visuals.showSongSelect();
  visuals.setPromptBig();
  visuals.setPromptPos(0, 0.48, -1.4);
  visuals.showPrompt();
  visuals.setPromptText('Choose a song');
}

function enterFree() {
  mode = 'free';
  songState = null;
  aimedOrb = -1;
  visuals.hideSongSelect();
  visuals.hideHud();
  visuals.setSongTarget(-1);
  visuals.setPromptPos(0, 0.18, -1.4);
  visuals.hidePrompt();
}

function startSong(i) {
  const S = SONGS[i];
  curSongIdx = i;
  mode = 'song';
  songState = { songIdx: i, noteIdx: 0, targetSince: 0 };
  aimedOrb = -1;
  visuals.hideSongSelect();
  visuals.hidePrompt();
  visuals.setSongTarget(S.notes[0].z);
  visuals.setHudText(`${S.title} — 1/${S.notes.length}`);
  visuals.showHud();
  if (S.notes[0].chord) audio.setAutoChord(S.notes[0].chord);
}

function advanceSong() {
  const S = SONGS[songState.songIdx];
  const done = S.notes[songState.noteIdx];
  // Match reward: sparkle at the rung + soft high shimmer.
  visuals.getRungWorldPos(done.z, tmpV);
  visuals.spawnBurst(tmpV, GOLD, 16);
  audio.playShimmer();
  songState.noteIdx++;
  songState.targetSince = 0;
  if (songState.noteIdx >= S.notes.length) { completeSong(); return; }
  const next = S.notes[songState.noteIdx];
  visuals.setSongTarget(next.z);
  visuals.setHudText(`${S.title} — ${songState.noteIdx + 1}/${S.notes.length}`);
  if (next.chord) audio.setAutoChord(next.chord);
}

function completeSong() {
  mode = 'complete';
  songState = null;
  visuals.setSongTarget(-1);
  visuals.hideHud();
  visuals.setPromptBig();
  visuals.showPrompt();
  visuals.setPromptText('Beautiful.');
  // Celebration: 3 firework volleys across the pillars (burst pool reuse).
  for (let v = 0; v < 3; v++) {
    setTimeout(() => {
      for (let i = 0; i < 4; i++) {
        const p = visuals.pillars[i].position;
        tmpV.set(p.x + (Math.random() - 0.5) * 0.8, 1.1 + Math.random() * 1.3, p.z + (Math.random() - 0.5) * 0.8);
        tmpColor.set(PILLAR_COLS[i]);
        visuals.spawnBurst(tmpV, tmpColor, 14);
      }
    }, v * 380);
  }
  setTimeout(() => {
    if (mode === 'complete') visuals.setPromptText('Pinch: replay • Hold pinch: next song');
  }, 2600);
}

function nextSong() {
  if (curSongIdx < SONGS.length - 1) startSong(curSongIdx + 1);
  else enterSelect(); // past the last song, the "next" is the songbook
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
    // Song state resets; re-entry returns to the songbook hub (or to
    // onboarding if it never completed).
    songState = null;
    aimedOrb = -1;
    visuals.hideSongSelect();
    visuals.hideHud();
    visuals.setSongTarget(-1);
    if (obDone) enterSelect();
    else mode = 'onboarding';
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
    // FX throttle (playtest-3 fix): during fast sweeps every quantization
    // boundary fired full bursts+ripples and the screen flooded — and
    // overlapping ripples at the hand read as a stray "∞" glyph. FX fire
    // only when the previous quantized note was actually held >= 120ms.
    // The ladder still tracks every change: immediate readout, no spam.
    if (now - lastNoteChangeT >= 0.12) {
      visuals.spawnBurst(tr.pos, color);
      visuals.spawnRipple(tr.pos, color);
      visuals.flashPitchCursor();
    }
    lastNoteChangeT = now;
    // Onboarding step 0: two quantized changes prove they hear the mapping.
    if (ob && ob.phase === 'instr' && ob.step === 0) {
      ob.count++;
      if (ob.count >= 2) obAdvance(nowS);
    }
  }

  // Song mode: match the target pitch. Free tempo — no rhythm gating
  // (accessibility); hold-notes need a 350ms dwell so endings carry weight.
  if (mode === 'song' && songState) {
    const target = SONGS[songState.songIdx].notes[songState.noteIdx];
    if (ev.noteIdx === target.z) {
      const dwell = target.hold ? 0.35 : 0.12;
      if (!songState.targetSince) songState.targetSince = nowS;
      else if (nowS - songState.targetSince >= dwell) advanceSong();
    } else {
      songState.targetSince = 0;
    }
  }

  // Song select: aim by reaching toward an orb (nearest within 0.6m).
  if (mode === 'select' && ev.tracked) {
    let best = -1, bestD = 0.6;
    const orbs = visuals.songOrbs;
    for (let i = 0; i < orbs.length; i++) {
      const d = tr.pos.distanceTo(orbs[i].pos);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best !== aimedOrb) {
      aimedOrb = best;
      visuals.setOrbAim(best);
    }
  }

  // Pinch-and-hold 1.5s: onboarding skip | select->free | complete->next.
  if (ev.pinchHeld) {
    if (ob) obSkip();
    else if (mode === 'select') enterFree();
    else if (mode === 'complete') nextSong();
  }

  if (ev.pinched) {
    if (tr.pinchPosValid) visuals.pinchFlash(tr.pinchPos);
    // In select/complete the tap action fires on RELEASE (below), so an
    // engage here must not act — otherwise a hold would double-fire.
    if (mode === 'select' || mode === 'complete') { /* release handles it */ }
    else if (audio.looping) {
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

  // Tap actions in select/complete fire on pinch RELEASE: a 1.5s hold means
  // something else there, and release disambiguates tap from hold. (A hold
  // already changed the mode by release time, so it can't double-fire.)
  if (ev.pinchReleased) {
    if (mode === 'select' && aimedOrb >= 0) {
      if (aimedOrb >= SONGS.length) enterFree(); // the "Free play" orb
      else startSong(aimedOrb);
    } else if (mode === 'complete') {
      startSong(curSongIdx); // replay
    }
  }
}

function handleLeft(tr, ev, nowS) {
  // In song mode the orchestra auto-follows the song's chords, so the
  // left-hand chord zones rest — but palm swell and fist dampen stay live.
  if (mode !== 'song') {
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
