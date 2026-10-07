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
// onboarding -> Twinkle auto-start -> complete -> songbook hub.
// Free play is the conduct-anything mode; the songbook is the hub every
// path returns to. The orb-selection step was REMOVED from the critical
// path (playtest 5: "pinch the golden orb but there's no golden orb") —
// nobody aims before their first song.
let mode = 'onboarding';
let songState = null;       // {songIdx, noteIdx, targetSince} while playing
let curSongIdx = -1;
let aimedOrb = -1;          // song-select orb under the right hand
let lastNoteChangeT = -1e9; // FX throttle clock (audio time)
let selectPromptText = 'Choose a song'; // current songbook prompt
let songIntroUntil = 0;     // nowS deadline for "Follow the golden light"
let freeIntroShown = false; // one-time loop intro per session
let freeIntroUntil = 0;     // nowS deadline for the free-play intro
// Pinch disambiguation: a 1.5s hold means something different from a tap
// in select/song/complete, so the release must know which one happened.
let pinchHoldConsumed = false;
let pendingSongPinch = false; // quick-pinch loop toggle, deferred to release
const pendingPinchPos = new THREE.Vector3();
let pendingPinchValid = false;
const GOLD = new THREE.Color(0xffd76a);
const PILLAR_COLS = [0x7fb2ff, 0x9fe8d0, 0xffd27f, 0xb79fff];

// ---- guided onboarding (rewritten for the theremin mechanic) -----------
// One large floating instruction at a time (reuses the prompt sprite at
// 1.6x). Starts on the first frame with a tracked hand — never at an
// empty room. The first two steps teach the continuous-pitch feel:
// move and HEAR the mapping, then explore tiny movements. The loop is
// NOT taught here: onboarding ends with Twinkle Twinkle auto-starting
// (the purpose), and the loop gets a one-time intro inside free play
// instead. Skip: pinch-and-HOLD 1.5s -> Twinkle Twinkle auto-starts too.
let ob = null;    // {step, phase, until, count, noteUntil}
let obDone = false;
const OB_STEPS = [
  { instr: 'Move your hand slowly up and down', conf: 'You are the pitch' },
  { instr: 'Tiny movements:\nyour hand is the pitch', conf: null }, // 4s free explore, auto-advance
  { instr: 'Open your left palm', conf: 'Your palm swells\nthe strings' },
  { instr: 'Make a fist', conf: 'A fist hushes them' },
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
    // Onboarding complete: Twinkle Twinkle auto-starts — zero decisions,
    // zero aiming. The first thing a new user does is play a song.
    autoStartFirstSong(nowS);
  } else {
    ob.phase = 'instr';
    visuals.setPromptText(OB_STEPS[ob.step].instr);
    if (ob.step === 1) ob.until = nowS + 4.0; // timed free explore
  }
}

function obSkip(nowS) {
  // Skipping the tutorial still lands in the song, not the songbook.
  autoStartFirstSong(nowS);
}

// Twinkle Twinkle auto-starts after onboarding: "Follow the golden
// light" (3s, then fade), HUD "Twinkle Twinkle — 1/12", target rung
// pulsing gold. No orb selection on the critical path.
function autoStartFirstSong(nowS) {
  ob = null;
  obDone = true;
  startSong(0);
  visuals.setPromptBig();
  visuals.setPromptPos(0, 0.48, -1.4);
  visuals.showPrompt();
  visuals.setPromptText('Follow the golden light');
  songIntroUntil = nowS + 3.0;
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
// The songbook is the hub: reached after song 1 (via next-song past the
// last song, or pinch-hold mid-song), from free play, or on session
// re-entry. First-time visitors get a one-time "Pinch an orb to choose"
// prompt; the Twinkle orb keeps its gold pulse whenever the songbook
// shows, so the flagship song stays findable.
let songbookSeen = false;
function enterSelect() {
  mode = 'select';
  songState = null;
  aimedOrb = -1;
  pendingSongPinch = false;
  pinchHoldConsumed = false;
  songIntroUntil = 0;
  freeIntroUntil = 0;
  visuals.setSongTarget(-1);
  visuals.hideHud();
  visuals.hidePrompt();
  visuals.showSongSelect();
  visuals.setOrbPulse(0);
  selectPromptText = songbookSeen ? 'Choose a song' : 'Pinch an orb\nto choose';
  songbookSeen = true;
  visuals.setPromptBig();
  visuals.setPromptPos(0, 0.48, -1.4);
  visuals.showPrompt();
  visuals.setPromptText(selectPromptText);
}

function enterFree(nowS) {
  mode = 'free';
  songState = null;
  aimedOrb = -1;
  pendingSongPinch = false;
  pinchHoldConsumed = false;
  visuals.hideSongSelect();
  visuals.hideHud();
  visuals.setSongTarget(-1);
  visuals.setPromptPos(0, 0.18, -1.4);
  // One-time loop intro, in context: the loop was deliberately NOT taught
  // during onboarding, so free play teaches it here, once per session.
  if (!freeIntroShown) {
    freeIntroShown = true;
    visuals.setPromptBig();
    visuals.showPrompt();
    visuals.setPromptText('Pinch to capture a loop\nHold pinch: songbook');
    freeIntroUntil = nowS + 5.0;
  } else {
    visuals.hidePrompt();
  }
}

function startSong(i) {
  const S = SONGS[i];
  curSongIdx = i;
  mode = 'song';
  songState = { songIdx: i, noteIdx: 0, targetSince: 0 };
  aimedOrb = -1;
  pendingSongPinch = false;
  pinchHoldConsumed = false;
  freeIntroUntil = 0;
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
  pendingSongPinch = false;
  pinchHoldConsumed = false;
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
    if (mode === 'complete') visuals.setPromptText('Pinch: replay\nHold pinch: next song');
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
    pendingSongPinch = false;
    pinchHoldConsumed = false;
    freeIntroUntil = 0;
    freeIntroShown = false; // the loop intro shows again next session
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

  // Song select: aim by reaching toward an orb (nearest within 0.8m).
  if (mode === 'select' && ev.tracked) {
    let best = -1, bestD = 0.8;
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

  // Pinch-and-hold 1.5s map:
  //   onboarding -> skip straight to Twinkle Twinkle (auto-start)
  //   select     -> free play, but ONLY if no orb was aimed at engage
  //                 (an aimed engage already selected and consumed it)
  //   song       -> quit mid-song back to the songbook
  //   free       -> back to the songbook (matches the free-play intro)
  //   complete   -> next song (existing)
  if (ev.pinchHeld) {
    if (pinchHoldConsumed) {
      // This engagement already acted (e.g. songbook engage-select):
      // the hold that follows it is inert.
    } else {
      pinchHoldConsumed = true; // the release after a hold must not tap
      pendingSongPinch = false; // a hold is not a tap: discard the deferred toggle
      if (ob) obSkip(nowS);
      else if (mode === 'select') enterFree(nowS); // hold, no orb aimed = free play
      else if (mode === 'complete') nextSong();
      else if (mode === 'song' || mode === 'free') enterSelect();
    }
  }

  if (ev.pinched) {
    if (mode === 'select') {
      // Engage selects IMMEDIATELY (instant feedback — no aim+release
      // two-step). A continued hold is consumed so it can't double-fire
      // or trigger anything else. With no orb aimed, the gesture stays
      // unconsumed: a continued hold falls through to free play above.
      if (aimedOrb >= 0) {
        if (tr.pinchPosValid) visuals.pinchFlash(tr.pinchPos);
        if (aimedOrb >= SONGS.length) enterFree(nowS); // the "Free play" orb
        else startSong(aimedOrb);
        pinchHoldConsumed = true; // suppress the hold/release after this
      }
    } else if (mode === 'song') {
      // Loop toggle DEFERRED to release: a quick pinch captures/clears,
      // a hold quits to the songbook — acting at engage would do both.
      pendingSongPinch = true;
      pendingPinchValid = tr.pinchPosValid;
      if (tr.pinchPosValid) pendingPinchPos.copy(tr.pinchPos);
    } else {
      if (tr.pinchPosValid) visuals.pinchFlash(tr.pinchPos);
      // In complete the tap action fires on RELEASE (below), so an
      // engage here must not act — otherwise a hold would double-fire.
      if (mode === 'complete') { /* release handles replay */ }
      else doLoopToggle();
    }
  }

  // Tap actions fire on pinch RELEASE (complete = replay; song = deferred
  // loop toggle). Select mode acts at ENGAGE, never at release. A hold
  // sets pinchHoldConsumed, so the release after it can never double-fire.
  if (ev.pinchReleased) {
    if (pinchHoldConsumed) {
      pinchHoldConsumed = false;
    } else if (mode === 'complete') {
      startSong(curSongIdx); // replay
    } else if (mode === 'song' && pendingSongPinch) {
      pendingSongPinch = false;
      if (pendingPinchValid) visuals.pinchFlash(pendingPinchPos);
      doLoopToggle();
    }
  }
}

// Loop capture/clear, shared by free play and song mode (quick pinch).
// Captures the last 8s of quantized note events as a looping arpeggio
// with the orbiting gold torus; a second pinch clears it.
function doLoopToggle() {
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
    }
    // Fewer than 2 recent notes: silent no-op (nothing to loop yet).
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
    // "Follow the golden light" intro after auto-start: 3s, then fade.
    // Guarded on mode so a mid-intro quit can't hide a songbook prompt.
    if (songIntroUntil && nowS >= songIntroUntil) {
      songIntroUntil = 0;
      if (mode === 'song') visuals.hidePrompt();
    }
    // Free-play loop intro: show once, then get out of the way.
    if (mode === 'free' && freeIntroUntil && nowS >= freeIntroUntil) {
      freeIntroUntil = 0;
      visuals.hidePrompt();
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
