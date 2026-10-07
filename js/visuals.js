// Handphony — visuals. Dark cinematic concert void, additive light only,
// no postprocessing (72fps budget). All geometry is emissive-style
// MeshBasicMaterial; depth comes from fog + additive layering.

import * as THREE from 'three';
import { NOTE_NAMES } from './audio.js';
import { HAND_BONES } from './hands.js';

function canvasTexture(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  return new THREE.CanvasTexture(cv);
}

// Soft round dot: white core fading to transparent edge. Shared by the
// note bursts, hand-joint points, palm orbs and pinch flashes so nothing
// ever renders as a hard square.
function makeDotTexture() {
  return canvasTexture(64, 64, (x, w, h) => {
    const g = x.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
  });
}

// Pitch -> color: deep blue (low) to gold (high).
export function pitchColor(zone, zones, out) {
  const t = zones <= 1 ? 0 : zone / (zones - 1);
  return out.setHSL(0.62 - 0.52 * t, 0.85, 0.62);
}

export class Visuals {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x020204);
    this.scene.fog = new THREE.FogExp2(0x030308, 0.055);
    this.time = 0;
    this.pillarAmp = [0, 0, 0, 0];
    this.pillarTarget = [0, 0, 0, 0];
    this.promptOp = 1;
    this.promptTarget = 1;
    this.loopOn = false;
    this.loopAng = 0;
    this._c = new THREE.Color();
    this._v = new THREE.Vector3();
    this.dotTex = makeDotTexture();
    this.ladderLo = -0.2;
    this.ladderHi = 0.2;

    this.buildDust();
    this.buildStage();
    this.buildPillars();
    this.buildBursts();
    this.buildRipples();
    this.buildLadder();
    this.buildLoopRing();
    this.buildPrompt();
    this.buildHandViz();
    this.buildPitchCursor();
    this.buildPinchFlashes();
    this.buildLoopLabel();
    this.buildSongSelect();
    this.buildHud();
    this.songTarget = -1; // ladder rung the song driver wants (gold pulse)
    this.aimedOrb = -1;
  }

  // ---- ambient dust -------------------------------------------------
  buildDust() {
    const N = 260;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 9;
      pos[i * 3 + 1] = Math.random() * 3.4 - 1.2;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 9;
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        attribute float aSeed;
        uniform float uTime;
        varying float vA;
        void main() {
          vec3 p = position;
          p.x += sin(uTime * 0.12 + aSeed * 6.2831) * 0.45;
          p.y += sin(uTime * 0.09 + aSeed * 12.566) * 0.30;
          p.z += cos(uTime * 0.10 + aSeed * 9.425) * 0.45;
          vA = 0.25 + 0.55 * aSeed;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          // world-size-proportional points: ~1-3cm motes
          gl_PointSize = (0.012 + 0.022 * aSeed) * (700.0 / -mv.z);
        }`,
      fragmentShader: `
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.05, d) * vA * 0.45;
          gl_FragColor = vec4(0.55, 0.65, 1.0, a);
        }`,
    });
    this.dust = new THREE.Points(g, m);
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
  }

  // ---- glowing stage disc under the (seated) user --------------------
  buildStage() {
    const tex = canvasTexture(256, 256, (x, w, h) => {
      const g = x.createRadialGradient(w / 2, h / 2, 8, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(90,130,255,0.55)');
      g.addColorStop(0.55, 'rgba(70,100,230,0.18)');
      g.addColorStop(1, 'rgba(60,90,220,0)');
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
    });
    const m = new THREE.Mesh(
      new THREE.CircleGeometry(1.7, 48),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.y = -1.15; // estimated floor for a seated user in 'local' space
    this.scene.add(m);
  }

  // ---- four light pillars (strings/winds/brass/low), arc ahead ------
  buildPillars() {
    const tex = canvasTexture(64, 256, (x, w, h) => {
      const g = x.createLinearGradient(0, h, 0, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.28, 'rgba(255,255,255,0.75)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
    });
    this.pillars = [];
    const cols = [0x7fb2ff, 0x9fe8d0, 0xffd27f, 0xb79fff];
    const angs = [-0.52, -0.175, 0.175, 0.52];
    const R = 3.4, H = 3.4, base = -1.15;
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex, color: cols[i], transparent: true, opacity: 0.25,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.30, H, 14, 1, true), mat);
      mesh.position.set(Math.sin(angs[i]) * R, base + H / 2, -Math.cos(angs[i]) * R);
      this.scene.add(mesh);
      this.pillars.push(mesh);
    }
  }

  setPillar(i, v) { this.pillarTarget[i] = Math.max(0, Math.min(1, v)); }

  // ---- note-onset particle bursts (pooled) ---------------------------
  buildBursts() {
    const N = 288;
    this.bN = N;
    this.bPos = new Float32Array(N * 3);
    this.bCol = new Float32Array(N * 3);
    this.bVel = new Float32Array(N * 3);
    this.bLife = new Float32Array(N);
    for (let i = 0; i < N; i++) this.bPos[i * 3 + 1] = -999;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.bPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.bCol, 3));
    const m = new THREE.PointsMaterial({
      size: 0.035, vertexColors: true, map: this.dotTex, alphaTest: 0.01,
      transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.burstPts = new THREE.Points(g, m);
    this.burstPts.frustumCulled = false;
    this.scene.add(this.burstPts);
    this.bCursor = 0;
  }

  spawnBurst(p, color, count = 22) {
    for (let k = 0; k < count; k++) {
      const i = this.bCursor;
      this.bCursor = (this.bCursor + 1) % this.bN;
      this.bPos[i * 3] = p.x; this.bPos[i * 3 + 1] = p.y; this.bPos[i * 3 + 2] = p.z;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const sp = 0.5 + Math.random() * 1.3;
      this.bVel[i * 3] = Math.sin(ph) * Math.cos(th) * sp;
      this.bVel[i * 3 + 1] = Math.abs(Math.cos(ph)) * sp * 0.9 + 0.25;
      this.bVel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp;
      this.bCol[i * 3] = color.r; this.bCol[i * 3 + 1] = color.g; this.bCol[i * 3 + 2] = color.b;
      this.bLife[i] = 0.55 + Math.random() * 0.35;
    }
  }

  updateBursts(dt) {
    for (let i = 0; i < this.bN; i++) {
      if (this.bLife[i] <= 0) continue;
      this.bLife[i] -= dt;
      if (this.bLife[i] <= 0) { this.bPos[i * 3 + 1] = -999; continue; }
      const dr = Math.exp(-dt * 2.2);
      this.bVel[i * 3] *= dr; this.bVel[i * 3 + 1] *= dr; this.bVel[i * 3 + 2] *= dr;
      this.bPos[i * 3] += this.bVel[i * 3] * dt;
      this.bPos[i * 3 + 1] += this.bVel[i * 3 + 1] * dt;
      this.bPos[i * 3 + 2] += this.bVel[i * 3 + 2] * dt;
    }
    this.burstPts.geometry.attributes.position.needsUpdate = true;
    this.burstPts.geometry.attributes.color.needsUpdate = true;
  }

  // ---- expanding ripple rings at note onsets (pooled) ----------------
  buildRipples() {
    this.ripples = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.06, 0.075, 40),
        new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        })
      );
      m.visible = false;
      this.scene.add(m);
      this.ripples.push({ m, t: 1 });
    }
    this.rCursor = 0;
  }

  spawnRipple(p, color) {
    const r = this.ripples[this.rCursor];
    this.rCursor = (this.rCursor + 1) % this.ripples.length;
    r.m.position.copy(p);
    r.m.material.color.copy(color);
    r.t = 0;
    r.m.visible = true;
  }

  updateRipples(dt) {
    for (const r of this.ripples) {
      if (r.t >= 1) { r.m.visible = false; continue; }
      r.t = Math.min(1, r.t + dt / 0.65);
      const s = 1 + r.t * 5.5;
      r.m.scale.set(s, s, s);
      r.m.material.opacity = 0.85 * (1 - r.t);
    }
  }

  // ---- pitch ladder: a small reference panel, not a wall --------------
  // Fixed at (0.35, 0.02, -1.25), scaled 0.55: beam + 11 rungs + note name
  // + the cursor ring riding at the right hand's height.
  buildLadder() {
    this.ladder = new THREE.Group();
    this.ladder.position.set(0.35, 0.02, -1.25);
    this.ladder.scale.set(0.55, 0.55, 0.55);
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0x8fa8ff, transparent: true, opacity: 0.45,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1, 8), beamMat);
    this.ladder.add(this.beam);
    this.rungs = [];
    for (let i = 0; i < 11; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, 0.035), mat);
      this.ladder.add(r);
      this.rungs.push(r);
    }
    // Note-name sprite floating above the active rung (e.g. "E5").
    this.noteCanvas = document.createElement('canvas');
    this.noteCanvas.width = 256; this.noteCanvas.height = 128;
    this.noteTex = new THREE.CanvasTexture(this.noteCanvas);
    this.noteMat = new THREE.SpriteMaterial({ map: this.noteTex, transparent: true, depthWrite: false });
    this.noteSprite = new THREE.Sprite(this.noteMat);
    this.noteSprite.scale.set(0.20, 0.10, 1);
    this.noteSprite.visible = false;
    this.ladder.add(this.noteSprite);
    this.scene.add(this.ladder);
    this.ladderActive = -1;
  }

  setLadderRange(lo, hi) {
    this.ladderLo = lo;
    this.ladderHi = hi;
    this.beam.scale.y = Math.max(0.05, hi - lo);
    this.beam.position.y = (lo + hi) / 2;
    for (let i = 0; i < 11; i++) this.rungs[i].position.y = lo + ((i + 0.5) * (hi - lo)) / 11;
  }

  setNoteName(zone) {
    const x = this.noteCanvas.getContext('2d');
    x.clearRect(0, 0, 256, 128);
    x.font = '600 64px system-ui, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillStyle = 'rgba(255,244,220,0.95)';
    x.fillText(NOTE_NAMES[zone], 128, 66);
    this.noteTex.needsUpdate = true;
    this.noteSprite.position.set(0, this.rungs[zone].position.y + 0.085, 0);
  }

  setLadderActive(zone, color) {
    if (zone === this.ladderActive && zone >= 0) {
      this.rungs[zone].material.color.copy(color);
      return;
    }
    if (this.ladderActive >= 0) {
      const m = this.rungs[this.ladderActive].material;
      m.color.set(0xffffff);
      m.opacity = 0.22;
    }
    this.ladderActive = zone;
    if (zone >= 0) {
      const m = this.rungs[zone].material;
      m.color.copy(color);
      m.opacity = 1;
      this.setNoteName(zone);
      this.noteSprite.visible = true;
    } else {
      this.noteSprite.visible = false;
    }
  }

  // ---- pitch cursor: bright ring ON the ladder at the right hand's ----
  // ---- height — connects hand -> ladder -> note. Flashes on note fire.
  buildPitchCursor() {
    this.cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.038, 0.052, 32),
      new THREE.MeshBasicMaterial({
        color: 0xfff2cf, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    this.cursorFlash = 0;
    this.ladder.add(this.cursor);
  }

  setPitchCursor(y) {
    const c = Math.max(this.ladderLo, Math.min(this.ladderHi, y));
    this.cursor.position.set(0, c, 0);
  }

  flashPitchCursor() { this.cursorFlash = 1; }

  // ---- loop ring: luminous torus orbiting the user while looping -----
  buildLoopRing() {
    const m = new THREE.Mesh(
      new THREE.TorusGeometry(0.30, 0.022, 12, 56),
      new THREE.MeshBasicMaterial({
        color: 0xffd27f, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    m.visible = false;
    this.scene.add(m);
    this.loopRing = m;
  }

  setLoop(on) {
    this.loopOn = on;
    this.loopRing.visible = on;
  }

  // ---- opening prompt sprite -----------------------------------------
  buildPrompt() {
    this.promptCanvas = document.createElement('canvas');
    this.promptCanvas.width = 512; this.promptCanvas.height = 128;
    this.promptTex = new THREE.CanvasTexture(this.promptCanvas);
    this.promptMat = new THREE.SpriteMaterial({ map: this.promptTex, transparent: true, depthWrite: false });
    const spr = new THREE.Sprite(this.promptMat);
    spr.scale.set(0.95, 0.24, 1);
    spr.position.set(0, 0.18, -1.4);
    this.scene.add(spr);
    this.promptSprite = spr;
    this.setPromptText('raise your hand');
  }

  setPromptBig() { this.promptSprite.scale.set(0.95 * 1.6, 0.24 * 1.6, 1); }

  // The song-select screen lifts the prompt above the orb arc so the big
  // "Choose a song" text doesn't sit on top of the middle orb.
  setPromptPos(x, y, z) { this.promptSprite.position.set(x, y, z); }

  showPrompt() { this.promptTarget = 1; }

  setPromptText(t) {
    const x = this.promptCanvas.getContext('2d');
    x.clearRect(0, 0, 512, 128);
    x.font = '44px system-ui, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillStyle = 'rgba(232,236,255,0.92)';
    x.fillText(t, 256, 64);
    this.promptTex.needsUpdate = true;
  }

  hidePrompt() { this.promptTarget = 0; }

  // ---- hand visualization --------------------------------------------
  // WebXR never renders hands automatically — the app must. Each tracked
  // hand gets its 25 XRHand joints as glowing points PLUS bone skeletons
  // (THREE.LineSegments over the standard hand topology) so it reads
  // INSTANTLY as a hand, not a bead swarm — plus a soft palm orb for
  // presence. Gold = right/melody, teal = left/harmony, which also teaches
  // the mapping. Hidden when the hand isn't tracked.
  buildHandViz() {
    this.handPts = {};
    this.handBones = {};
    this.palmOrbs = {};
    const cols = { right: 0xffd27f, left: 0x9fe8d0 };
    for (const h of ['right', 'left']) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(25 * 3), 3));
      const m = new THREE.PointsMaterial({
        size: 0.02, map: this.dotTex, alphaTest: 0.01, transparent: true, opacity: 0.95,
        color: cols[h], blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const pts = new THREE.Points(g, m);
      pts.frustumCulled = false;
      pts.visible = false;
      this.scene.add(pts);
      this.handPts[h] = pts;
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(HAND_BONES.length * 6), 3));
      const lm = new THREE.LineBasicMaterial({
        color: cols[h], transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const bones = new THREE.LineSegments(lg, lm);
      bones.frustumCulled = false;
      bones.visible = false;
      this.scene.add(bones);
      this.handBones[h] = bones;
      const orb = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.dotTex, color: cols[h], transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      orb.scale.set(0.06, 0.06, 1);
      orb.visible = false;
      this.scene.add(orb);
      this.palmOrbs[h] = orb;
    }
  }

  // jointPos: fixed-index joint positions (25*3); jointValid: per-joint mask.
  setHandViz(h, jointPos, jointValid, palmPos) {
    const pts = this.handPts[h], bones = this.handBones[h];
    let n = 0;
    for (let i = 0; i < 25; i++) if (jointValid[i]) n++;
    if (n < 8) {
      pts.visible = false; bones.visible = false; this.palmOrbs[h].visible = false;
      return;
    }
    // Compact the valid joints into the point buffer.
    const attr = pts.geometry.attributes.position;
    let c = 0;
    for (let i = 0; i < 25; i++) {
      if (!jointValid[i]) continue;
      attr.array[c * 3] = jointPos[i * 3];
      attr.array[c * 3 + 1] = jointPos[i * 3 + 1];
      attr.array[c * 3 + 2] = jointPos[i * 3 + 2];
      c++;
    }
    attr.needsUpdate = true;
    pts.geometry.setDrawRange(0, c);
    pts.visible = true;
    // Bone segments, skipping any pair with a missing joint.
    const lattr = bones.geometry.attributes.position;
    let s = 0;
    for (const [a, b] of HAND_BONES) {
      if (!jointValid[a] || !jointValid[b]) continue;
      lattr.array[s * 3] = jointPos[a * 3];
      lattr.array[s * 3 + 1] = jointPos[a * 3 + 1];
      lattr.array[s * 3 + 2] = jointPos[a * 3 + 2];
      lattr.array[s * 3 + 3] = jointPos[b * 3];
      lattr.array[s * 3 + 4] = jointPos[b * 3 + 1];
      lattr.array[s * 3 + 5] = jointPos[b * 3 + 2];
      s += 2;
    }
    lattr.needsUpdate = true;
    bones.geometry.setDrawRange(0, s);
    bones.visible = s > 0;
    this.palmOrbs[h].position.copy(palmPos);
    this.palmOrbs[h].visible = true;
  }

  hideHandViz(h) {
    this.handPts[h].visible = false;
    this.handBones[h].visible = false;
    this.palmOrbs[h].visible = false;
  }

  // ---- pinch flash: bright pulse at the pinch point when a pinch ------
  // ---- registers, distinct from the loop ring. Pooled x3.
  buildPinchFlashes() {
    this.pfPool = [];
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.dotTex, color: 0xfff6da, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      s.visible = false;
      s.scale.set(0.1, 0.1, 1);
      this.scene.add(s);
      this.pfPool.push({ s, t: 1 });
    }
    this.pfCursor = 0;
  }

  pinchFlash(p) {
    const f = this.pfPool[this.pfCursor];
    this.pfCursor = (this.pfCursor + 1) % this.pfPool.length;
    f.s.position.copy(p);
    f.t = 0;
    f.s.visible = true;
  }

  // ---- loop label: small "looping" / "loop cleared" text near the ring
  buildLoopLabel() {
    this.llCanvas = document.createElement('canvas');
    this.llCanvas.width = 512; this.llCanvas.height = 128;
    this.llTex = new THREE.CanvasTexture(this.llCanvas);
    this.llMat = new THREE.SpriteMaterial({ map: this.llTex, transparent: true, depthWrite: false, opacity: 0 });
    this.llSprite = new THREE.Sprite(this.llMat);
    this.llSprite.scale.set(0.55, 0.14, 1);
    this.llSprite.visible = false;
    this.scene.add(this.llSprite);
    this.llT = 1e9;
    this.llDur = 3;
  }

  showLoopLabel(text, dur = 3) {
    const x = this.llCanvas.getContext('2d');
    x.clearRect(0, 0, 512, 128);
    x.font = '44px system-ui, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillStyle = 'rgba(255,226,160,0.95)';
    x.fillText(text, 256, 64);
    this.llTex.needsUpdate = true;
    this.llT = 0;
    this.llDur = dur;
    this.llSprite.visible = true;
    this.llMat.opacity = 1;
  }

  // ---- floating text label sprite (song orbs, HUD) --------------------
  makeLabel(text, wPx, fontPx, scaleW, scaleH, color) {
    const cv = document.createElement('canvas');
    cv.width = wPx; cv.height = 128;
    const tex = new THREE.CanvasTexture(cv);
    const x = cv.getContext('2d');
    x.font = `${fontPx}px system-ui, sans-serif`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillStyle = color;
    x.fillText(text, wPx / 2, 66);
    tex.needsUpdate = true;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    spr.scale.set(scaleW, scaleH, 1);
    return spr;
  }

  // ---- song select: 4 song orbs + a free-play orb in a gentle arc -----
  // The user reaches toward an orb (nearest within 0.6m = aimed) and
  // pinches on RELEASE to choose — release (not engage) so a 1.5s hold
  // can mean free-play instead of double-firing a selection.
  buildSongSelect() {
    this.songSelect = new THREE.Group();
    this.songOrbs = [];
    const defs = [
      { title: 'Twinkle Twinkle', color: 0xffd27f },
      { title: 'Mary Had a Little Lamb', color: 0x9fe8d0 },
      { title: 'Merrily We Roll Along', color: 0x7fb2ff },
      { title: 'Auld Lang Syne', color: 0xb79fff },
      { title: 'Free play', color: 0x8a93a8 },
    ];
    const xs = [-0.55, -0.275, 0, 0.275, 0.55];
    defs.forEach((d, i) => {
      const pos = new THREE.Vector3(xs[i], 0.10, -1.15 + 0.06 * (Math.abs(xs[i]) / 0.55));
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.dotTex, color: d.color, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      spr.position.copy(pos);
      spr.scale.set(0.16, 0.16, 1);
      this.songSelect.add(spr);
      const label = this.makeLabel(d.title, 640, 40, 0.42, 0.084, 'rgba(232,236,255,0.92)');
      label.position.set(pos.x, pos.y + 0.17, pos.z);
      this.songSelect.add(label);
      this.songOrbs.push({ idx: i, pos, sprite: spr, base: 0.16, phase: i * 1.3 });
    });
    this.songSelect.visible = false;
    this.scene.add(this.songSelect);
  }

  showSongSelect() { this.songSelect.visible = true; }
  hideSongSelect() { this.songSelect.visible = false; this.setOrbAim(-1); }

  setOrbAim(i) { this.aimedOrb = i; }

  // ---- song HUD: small floating progress text, top-center ---------------
  buildHud() {
    this.hud = this.makeLabel('', 640, 44, 0.5, 0.1, 'rgba(255,244,220,0.95)');
    this.hud.position.set(0, 0.62, -1.6);
    this.hud.visible = false;
    this.scene.add(this.hud);
  }

  setHudText(t) {
    const m = this.hud.material, cv = m.map.image;
    const x = cv.getContext('2d');
    x.clearRect(0, 0, cv.width, cv.height);
    x.font = '44px system-ui, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillStyle = 'rgba(255,244,220,0.95)';
    x.fillText(t, cv.width / 2, 66);
    m.map.needsUpdate = true;
  }

  showHud() { this.hud.visible = true; }
  hideHud() { this.hud.visible = false; }

  // ---- song target: the ladder rung the song wants, pulsing gold -------
  setSongTarget(zone) { this.songTarget = zone; }

  getRungWorldPos(zone, out) { return this.rungs[zone].getWorldPosition(out); }

  // ---- per-frame ------------------------------------------------------
  update(dt) {
    this.time += dt;
    this.dust.material.uniforms.uTime.value = this.time;
    for (let i = 0; i < 4; i++) {
      const k = 1 - Math.exp(-dt * 6);
      this.pillarAmp[i] += (this.pillarTarget[i] - this.pillarAmp[i]) * k;
      this.pillars[i].material.opacity = 0.20 + 0.62 * this.pillarAmp[i];
    }
    this.updateBursts(dt);
    this.updateRipples(dt);
    if (this.loopOn) {
      this.loopAng += dt * 0.7;
      this.loopRing.position.set(Math.cos(this.loopAng) * 2.0, 0.25, Math.sin(this.loopAng) * 2.0);
      this.loopRing.rotation.y += dt * 1.2;
    }
    // Active rung pulses (keeps its pitch coloring).
    if (this.ladderActive >= 0) {
      this.rungs[this.ladderActive].material.opacity = 0.72 + 0.28 * Math.sin(this.time * 7);
    }
    // Song target rung pulses gold, stronger than the normal active pulse.
    // Applied after, so gold wins when target == the user's active rung.
    if (this.songTarget >= 0 && this.songTarget < this.rungs.length) {
      const m = this.rungs[this.songTarget].material;
      m.color.set(0xffd76a);
      m.opacity = 0.78 + 0.22 * Math.sin(this.time * 9);
    }
    // Song-select orbs breathe gently; the aimed orb glows bigger.
    if (this.songSelect.visible) {
      for (const o of this.songOrbs) {
        const bump = 1 + 0.08 * Math.sin(this.time * 2.4 + o.phase);
        const aim = (o.idx === this.aimedOrb) ? 1.45 : 1.0;
        const s = o.base * bump * aim;
        o.sprite.scale.set(s, s, 1);
        o.sprite.material.opacity = (o.idx === this.aimedOrb) ? 1.0 : 0.85;
      }
    }
    // Pitch-cursor flash decay.
    this.cursorFlash = Math.max(0, this.cursorFlash - dt * 3);
    const cs = 1 + this.cursorFlash * 1.6;
    this.cursor.scale.set(cs, cs, cs);
    this.cursor.material.opacity = 0.55 + 0.45 * this.cursorFlash;
    // Pinch flashes.
    for (const f of this.pfPool) {
      if (f.t >= 1) { f.s.visible = false; continue; }
      f.t = Math.min(1, f.t + dt / 0.45);
      f.s.material.opacity = 1 - f.t;
      const sc = 0.08 + f.t * 0.14;
      f.s.scale.set(sc, sc, 1);
    }
    // Loop label follows the ring, then fades.
    if (this.llSprite.visible) {
      this.llT += dt;
      this.llSprite.position.copy(this.loopRing.position);
      this.llSprite.position.y += 0.42;
      if (this.llT > this.llDur) {
        const fo = 1 - (this.llT - this.llDur) / 0.6;
        this.llMat.opacity = Math.max(0, fo);
        if (fo <= 0) this.llSprite.visible = false;
      }
    }
    const k = 1 - Math.exp(-dt * 3);
    this.promptOp += (this.promptTarget - this.promptOp) * k;
    this.promptMat.opacity = this.promptOp;
  }
}
