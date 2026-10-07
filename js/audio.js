// Handphony — audio engine. All synthesized, no samples.
// Chain: voices -> master gain -> DynamicsCompressor (gentle limiter)
//        -> dry to destination, plus parallel convolver reverb (wet ~0.33).
// Musical safety: pentatonic melody, consonant triad pads, sine sub-bass.
// Nothing dissonant is reachable by design.

export const PENT_MIDIS = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84]; // C4..C6

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.melPulse = 0;   // set to 1 on melody onset; main loop consumes
    this.loopPulse = 0;  // set to 1 on loop-note onset
    this.bassPulse = 0;  // set to 1 on chord change
    this.loop = null;    // {notes:[{midi,dt}], idx, t0, total}
    this.pad = null;     // {bus, oscs}
  }

  mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  async init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const c = this.ctx;

    this.master = c.createGain();
    this.master.gain.value = 0.85;

    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.24;

    this.verb = c.createConvolver();
    this.verb.buffer = this.makeIR(2.5); // 2.5s exponentially-decaying noise
    this.wet = c.createGain();
    this.wet.gain.value = 0.33;

    this.master.connect(this.comp);
    this.comp.connect(c.destination);          // dry path
    this.comp.connect(this.verb);              // parallel wet path
    this.verb.connect(this.wet);
    this.wet.connect(c.destination);

    // Melody bus: triangle lead through a fixed gentle lowpass.
    this.melFilter = c.createBiquadFilter();
    this.melFilter.type = 'lowpass';
    this.melFilter.frequency.value = 2600;
    this.melFilter.Q.value = 0.4;
    this.melodyBus = c.createGain();
    this.melFilter.connect(this.melodyBus);
    this.melodyBus.connect(this.master);

    // Pad bus: shared lowpass (cutoff driven by palm swell) -> swell gain.
    this.padFilter = c.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 900;
    this.padFilter.Q.value = 0.6;
    this.swellGain = c.createGain();
    this.swellGain.gain.value = 0.25;
    this.padFilter.connect(this.swellGain);
    this.swellGain.connect(this.master);

    // Bass: one continuous sine, frequency ramps on chord change, soft.
    this.bassOsc = c.createOscillator();
    this.bassOsc.type = 'sine';
    this.bassOsc.frequency.value = this.mtof(48); // C3
    this.bassGain = c.createGain();
    this.bassGain.gain.value = 0.20;
    this.bassOsc.connect(this.bassGain);
    this.bassGain.connect(this.swellGain); // fist dampens pad+bass together
    this.bassOsc.start();

    // Loop voice filter (soft arpeggio sits under the lead).
    this.loopFilter = c.createBiquadFilter();
    this.loopFilter.type = 'lowpass';
    this.loopFilter.frequency.value = 1800;
    this.loopFilter.connect(this.melodyBus);

    this.ready = true;
  }

  makeIR(dur) {
    const c = this.ctx, rate = c.sampleRate, len = Math.floor(rate * dur);
    const buf = c.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
    }
    return buf;
  }

  // Lead voice: two detuned triangles, fast attack, ~1.35s release.
  playMelody(midi, vel = 1) {
    if (!this.ready) return;
    const c = this.ctx, t = c.currentTime, f = this.mtof(midi);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.42 * vel, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.35);
    g.connect(this.melFilter);
    for (const det of [-5, 5]) {
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.detune.value = det; // slight shimmer
      o.connect(g);
      o.start(t);
      o.stop(t + 1.55);
    }
    this.melPulse = 1;
  }

  // Pad: 2 detuned saws per chord tone, slow attack, crossfaded on change.
  // Bass root ramps to the new root an octave below the chord.
  setChord(midis, rootMidi) {
    if (!this.ready) return;
    const c = this.ctx, t = c.currentTime;
    if (this.pad) {
      const old = this.pad;
      old.bus.gain.cancelScheduledValues(t);
      old.bus.gain.setTargetAtTime(0.0001, t, 0.35);
      for (const o of old.oscs) { try { o.stop(t + 1.8); } catch (e) { /* already stopped */ } }
    }
    this.bassOsc.frequency.cancelScheduledValues(t);
    this.bassOsc.frequency.setTargetAtTime(this.mtof(rootMidi), t, 0.4);
    this.bassPulse = 1;

    const bus = c.createGain();
    bus.gain.value = 0.0001;
    bus.connect(this.padFilter);
    const oscs = [];
    for (const m of midis) {
      const f = this.mtof(m);
      for (const det of [-7, 7]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        const og = c.createGain();
        og.gain.value = 0.11;
        o.connect(og);
        og.connect(bus);
        o.start(t);
        oscs.push(o);
      }
    }
    bus.gain.setTargetAtTime(0.5, t, 0.7); // slow bloom
    this.pad = { bus, oscs };
  }

  // Palm openness 0..1 -> pad lowpass cutoff + pad/bass level. Smoothed.
  setSwell(o) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.padFilter.frequency.setTargetAtTime(380 + o * 3600, t, 0.12);
    this.swellGain.gain.setTargetAtTime(0.03 + o * 0.55, t, 0.12);
  }

  startLoop(notes) { // notes: [{midi, dt}] dt = seconds since phrase start
    if (!this.ready || !notes.length) return;
    this.loop = {
      notes,
      idx: 0,
      t0: this.ctx.currentTime + 0.15,
      total: notes[notes.length - 1].dt + 0.7,
    };
  }

  stopLoop() { this.loop = null; }
  get looping() { return !!this.loop; }

  playLoopNote(midi, when) {
    const c = this.ctx, f = this.mtof(midi);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.15, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.55);
    g.connect(this.loopFilter);
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    o.connect(g);
    o.start(when);
    o.stop(when + 0.7);
    this.loopPulse = 1;
  }

  // Call every frame: lookahead scheduler replays the captured phrase
  // with its original rhythm, looping.
  update() {
    if (!this.loop || !this.ready) return;
    const t = this.ctx.currentTime, L = this.loop;
    let guard = 0;
    while (L.idx < L.notes.length && L.t0 + L.notes[L.idx].dt <= t + 0.06 && guard++ < 32) {
      const when = Math.max(L.t0 + L.notes[L.idx].dt, t + 0.01);
      this.playLoopNote(L.notes[L.idx].midi, when);
      L.idx++;
    }
    if (L.idx >= L.notes.length) { L.idx = 0; L.t0 += L.total; }
  }
}
