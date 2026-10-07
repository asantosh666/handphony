// Handphony — visuals. Dark cinematic concert void, additive light only,
// no postprocessing (72fps budget). All geometry is emissive-style
// MeshBasicMaterial; depth comes from fog + additive layering.

import * as THREE from 'three';

function canvasTexture(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  return new THREE.CanvasTexture(cv);
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

    this.buildDust();
    this.buildStage();
    this.buildPillars();
    this.buildBursts();
    this.buildRipples();
    this.buildLadder();
    this.buildLoopRing();
    this.buildPrompt();
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
      size: 0.035, vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.burstPts = new THREE.Points(g, m);
    this.burstPts.frustumCulled = false;
    this.scene.add(this.burstPts);
    this.bCursor = 0;
  }

  spawnBurst(p, color) {
    for (let k = 0; k < 22; k++) {
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

  // ---- pitch ladder: faint beam + 11 rungs beside the right hand -----
  buildLadder() {
    this.ladder = new THREE.Group();
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0x8fa8ff, transparent: true, opacity: 0.28,
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
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.014, 0.03), mat);
      this.ladder.add(r);
      this.rungs.push(r);
    }
    this.scene.add(this.ladder);
    this.ladderActive = -1;
  }

  setLadderRange(lo, hi) {
    this.beam.scale.y = Math.max(0.05, hi - lo);
    this.beam.position.y = (lo + hi) / 2;
    for (let i = 0; i < 11; i++) this.rungs[i].position.y = lo + ((i + 0.5) * (hi - lo)) / 11;
  }

  followLadder(x, z, dt) {
    const k = 1 - Math.exp(-dt / 0.15);
    this.ladder.position.x += (x + 0.24 - this.ladder.position.x) * k;
    this.ladder.position.z += (z - this.ladder.position.z) * k;
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
    }
  }

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
    this.setPromptText('raise your hand');
  }

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
    const k = 1 - Math.exp(-dt * 3);
    this.promptOp += (this.promptTarget - this.promptOp) * k;
    this.promptMat.opacity = this.promptOp;
  }
}
